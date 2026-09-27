/**
 * sage-mem dream —— 「夜间」记忆整理（移植 Claude Code 的 autoDream）。
 *
 * 对应物在档案馆 `claude-leak-sourcemap/restored-src/src/services/autoDream/`。
 * 骨架照搬，通道换掉，并补了两道 CC 没有的安全网：
 *
 *   1. **门控三级，最便宜的先查**（CC 的原话是 "Gate order (cheapest first)"）：
 *      时间门（一次读写状态）→ 会话门（一次目录扫描，且带 10 分钟节流）→ 锁。
 *      任何一级不过，后面的都不做。
 *   2. **执行不走 forked agent**。CC 用 `runForkedAgent` 复用宿主会话的 prompt
 *      cache；sage-mem 这边直接 `ctx.llm.stream()` 手写一个极简 agent 循环。
 *      换来的是：工具集由我们给（安全边界在 dream-tools.js），步数有上限，
 *      不需要 agent 生命周期与 provider 注册，也不会把 dream 写进用户的会话记录。
 *   3. **运行前快照 + 运行后审计**（CC 没有）。memory 目录不在任何版本控制下、
 *      删除没有回收站，所以「可回滚」必须自己造；审计则让每趟 dream 自证没改坏。
 *
 * 配置与状态同一个 JSON 文件（`<memoryDir>/../.sage-mem/dream.json`），
 * 手改也方便——它是纯文本，且和人读的东西放在一起。
 */

import { readFile, writeFile, readdir, mkdir, copyFile, rm, stat, open, rename } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { auditMemoryDir, formatAudit } from './dream-audit.js'
import { dreamToolSchemas, createToolRunner } from './dream-tools.js'
import { buildDreamSystemPrompt, buildDreamUserPrompt } from './dream-prompt.js'

/** 配置结构版本：将来加字段时用来做迁移。 */
const CONFIG_VERSION = 1

/** 默认配置。每一项都能从设置面板改；空 provider/model 表示跟聊天页当前默认模型。 */
const DEFAULT_CONFIG = {
  enabled: false,
  trigger: 'manual',
  apply: false,
  source: 'memory',
  minHours: 24,
  minSessions: 5,
  provider: '',
  model: '',
  maxSteps: 24,
  maxSnapshotKeep: 5,
}

/**
 * 会话门的扫描节流（CC 的 SESSION_SCAN_INTERVAL_MS 同值）。
 *
 * 为什么需要它：时间门过了、会话门没过时，状态里的 lastRunAt 不会前进，
 * 于是每一次触发都会重新扫一遍 sessions 目录（本机 441 个会话目录）。
 * 节流把「看着像没过」和「真的没过」区分开——这中间的成本差异全是白烧的盘 IO。
 */
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000

/** 自动模式的检查间隔。门控本身很便宜（有节流），所以这个频率是安全的。 */
const SCHEDULE_INTERVAL_MS = 30 * 60 * 1000

/** 启动后第一次自动检查的延迟——避开 DSH 启动时的那阵忙碌。 */
const STARTUP_CHECK_DELAY_MS = 90 * 1000

/** 锁的失效时间：超过这个时长还挂着的锁，认定是上次进程崩了留下的。 */
const LOCK_STALE_MS = 2 * 60 * 60 * 1000

/** 失败后的退避：别让一个每次都失败的任务把门控刷成高频重试。 */
const FAILURE_BACKOFF_MS = 60 * 60 * 1000

/** 报告目录名（相对 memory 根）。放在子目录里，所以不会被 sage-mem 自己扫成记忆。 */
const REPORT_DIR = 'dream'

/** 状态根目录名（相对 memory 根的上一层）。 */
const STATE_DIR = '.sage-mem'

/** 一次 dream 允许累计的输入 token 上限（软保护，超了就停）。 */
const DEFAULT_TOKEN_BUDGET = 600000

const clampNum = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt)

/** 本地时间戳，给文件名用。 */
function stampCompact(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 本地时间戳，给人看。 */
function stampHuman(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 精简版 chunk 组装器。
 *
 * 算法与 `@deepseek-ai/dsh-llm` 的 `BlockAssembler` 一致（读源码得来），
 * 只保留 dream 用得上的两种块，并**自己实现而不是 import** —— 树外插件
 * 依赖宿主内部包要过依赖桥，版本漂移时挂的是「整个插件加载不了」这种级别的
 * 故障，而这里需要的逻辑只有三十行。
 *
 * 两个必须照抄的行为：
 *   - delta-only 协议（没有 block-start/block-end）也要能组装
 *   - `finish.kind === 'max-tokens'` 时**丢掉 tool-call 块**：被截断的调用参数
 *     是不完整的 JSON，拿去执行等于凭半句话动手
 */
class BlockAssembler {
  constructor() {
    this.partials = new Map()
    this.order = []
    this._usage = null
    this._finish = null
  }

  push(chunk) {
    switch (chunk?.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, { blockType: chunk.blockType, text: '', args: '' })
        }
        return
      }
      case 'text-delta': {
        const p = this.ensure(chunk.index, 'text')
        if (p.block) return
        p.text += chunk.text
        return
      }
      case 'reasoning-delta':
        return
      case 'tool-call-delta': {
        const p = this.ensure(chunk.index, 'tool-call')
        if (p.block) return
        p.callId = chunk.id
        if (chunk.name) p.callName = chunk.name
        p.args += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const p = this.ensure(chunk.index, chunk.block?.type ?? 'text')
        if (p.block) return
        p.block = chunk.block
        return
      }
      case 'usage':
        this._usage = chunk.usage
        return
      case 'finish':
        this._finish = chunk.reason
        return
      default:
        return
    }
  }

  ensure(index, blockType) {
    let p = this.partials.get(index)
    if (!p) {
      p = { blockType, text: '', args: '' }
      this.partials.set(index, p)
      this.order.push(index)
    }
    return p
  }

  assemble(p, index) {
    if (p.block) return p.block
    switch (p.blockType) {
      case 'text':
        return { type: 'text', text: p.text }
      case 'reasoning':
        return { type: 'reasoning', text: p.text }
      case 'tool-call':
        return { type: 'tool-call', id: p.callId ?? `call-${index}`, name: p.callName ?? '', arguments: p.args }
      default:
        return null
    }
  }

  blocks() {
    const all = this.order.map((i) => this.assemble(this.partials.get(i), i)).filter(Boolean)
    if (this.finish.kind === 'max-tokens') return all.filter((b) => b.type !== 'tool-call')
    return all
  }

  get usage() {
    return this._usage
  }

  get finish() {
    return this._finish ?? { kind: 'stop' }
  }
}

/** 造一条 user 消息（字段形状照 dsh-llm 的 createUserMessage，只是不引那个包）。 */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'sage-mem-dream' }, id: randomUUID() }
}

/** 造一条 assistant 消息，把模型这一轮的块原样回灌进历史。 */
function assistantMessage(blocks, provider, model) {
  return {
    role: 'assistant',
    content: blocks,
    source: { kind: 'model', provider, model },
    id: randomUUID(),
  }
}

/** 造一条工具结果消息。callId 是把结果接回那次调用的唯一凭据。 */
function toolMessage(callId, text, isError) {
  const msg = {
    role: 'tool',
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId },
    toolCallId: callId,
    id: randomUUID(),
  }
  if (isError) msg.isError = true
  return msg
}

/** 数一下 `$DSH_HOME/sessions` 下 mtime 晚于 sinceMs 的会话（只看文件时间，不解压）。 */
async function countSessionsSince(root, sinceMs) {
  if (!root) return 0
  let n = 0
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const projPath = join(root, p.name)
    let sessions
    try {
      sessions = await readdir(projPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const file = join(projPath, s.name, 'session.v4.jsonl.zstd')
      try {
        const info = await stat(file)
        if (info.mtimeMs >= sinceMs) n++
      } catch {
        // 目录里没有这个文件：不是每一代格式都叫这个名字，跳过即可。
      }
    }
  }
  return n
}

export class DreamEngine {
  /**
   * @param {object} ctx — 插件上下文（Cordis）
   * @param {{memoryDir:string, sessionsRoot:string, version:string}} opts
   */
  constructor(ctx, opts) {
    this.ctx = ctx
    this.memoryDir = opts.memoryDir
    this.sessionsRoot = opts.sessionsRoot
    this.version = opts.version
    this.stateRoot = join(dirname(this.memoryDir), STATE_DIR)
    this.configPath = join(this.stateRoot, 'dream.json')
    this.lockPath = join(this.stateRoot, 'dream.lock')

    this.running = false
    this.phase = ''
    this.startedAt = 0
    this.stepLog = []
    this.lastScanAt = 0
    this.state = { config: { ...DEFAULT_CONFIG }, version: CONFIG_VERSION, lastRunAt: 0, lastResult: null, retryAfter: 0 }
    this.disposers = []
    this._configLoaded = false
  }

  /** 服务解析：优先 ctx.get()，回落直接属性（不同 Cordis 版本两种都在用）。 */
  svc(name) {
    const viaGet = typeof this.ctx?.get === 'function' ? this.ctx.get(name) : undefined
    return viaGet ?? this.ctx?.[name]
  }

  log(level, msg) {
    const line = `sage-mem dream: ${msg}`
    const logger = this.ctx?.logger
    if (level === 'error' && logger?.error) logger.error(line)
    else if (logger?.warn) logger.warn(line)
    else console.warn(line)
  }

  // ────────────────────────────── 配置与状态 ──────────────────────────────

  /** 读配置 + 状态（同一个文件）。缺失或损坏都回落到默认值，绝不让它拖死插件加载。 */
  async load() {
    if (this._configLoaded) return this.state
    try {
      const raw = await readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw)
      this.state = {
        version: CONFIG_VERSION,
        config: { ...DEFAULT_CONFIG, ...(parsed?.config ?? {}) },
        lastRunAt: Number(parsed?.lastRunAt) || 0,
        lastResult: parsed?.lastResult ?? null,
        retryAfter: Number(parsed?.retryAfter) || 0,
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.log('warn', `配置文件读取失败，改用默认值（${this.configPath}）：${err?.message ?? err}`)
      }
      this.state = { version: CONFIG_VERSION, config: { ...DEFAULT_CONFIG }, lastRunAt: 0, lastResult: null, retryAfter: 0 }
    }
    this._configLoaded = true
    return this.state
  }

  /** 落盘。写入是原子的（临时文件 + rename），半截文件不会留在盘上。 */
  async persist() {
    await mkdir(this.stateRoot, { recursive: true })
    const tmp = `${this.configPath}.${process.pid}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      await rename(tmp, this.configPath)
    } finally {
      // rename 成功后 tmp 已不存在（ENOENT），失败时清掉不留垃圾。
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  /** 给 UI 的完整配置（含有效模型路线与门控快照）。 */
  async getConfig() {
    await this.load()
    const route = this.resolveRouteSafe(this.state.config)
    return {
      config: { ...this.state.config },
      route,
      lastRunAt: this.state.lastRunAt,
      lastResult: this.state.lastResult,
      paths: { memoryDir: this.memoryDir, configPath: this.configPath, stateRoot: this.stateRoot },
      defaults: { ...DEFAULT_CONFIG },
    }
  }

  /** 改配置。逐项做类型与范围收敛——UI 传什么进来都不该写出一份坏配置。 */
  async setConfig(patch) {
    await this.load()
    const p = patch && typeof patch === 'object' ? patch : {}
    const c = { ...this.state.config }
    if (typeof p.enabled === 'boolean') c.enabled = p.enabled
    if (p.trigger === 'auto' || p.trigger === 'manual') c.trigger = p.trigger
    if (typeof p.apply === 'boolean') c.apply = p.apply
    if (p.source === 'memory' || p.source === 'memory+sessions') c.source = p.source
    if (p.minHours !== undefined) c.minHours = clampNum(Number(p.minHours), 1, 720, DEFAULT_CONFIG.minHours)
    if (p.minSessions !== undefined) c.minSessions = Math.round(clampNum(Number(p.minSessions), 1, 200, DEFAULT_CONFIG.minSessions))
    if (p.maxSteps !== undefined) c.maxSteps = Math.round(clampNum(Number(p.maxSteps), 1, 80, DEFAULT_CONFIG.maxSteps))
    if (p.maxSnapshotKeep !== undefined)
      c.maxSnapshotKeep = Math.round(clampNum(Number(p.maxSnapshotKeep), 1, 50, DEFAULT_CONFIG.maxSnapshotKeep))
    if (typeof p.provider === 'string') c.provider = p.provider.trim().slice(0, 120)
    if (typeof p.model === 'string') c.model = p.model.trim().slice(0, 160)
    this.state.config = c
    await this.persist()
    return await this.getConfig()
  }

  /** 解析这一趟该用哪条模型路线；解不出来就返回 null 而不是抛。 */
  resolveRouteSafe(config) {
    try {
      const sel = this.svc('agentDefaultModel')?.currentSelection?.()
      const provider = (config?.provider || sel?.provider || '').trim()
      const model = (config?.model || sel?.model || '').trim()
      if (!provider || !model) return null
      return { provider, model, fromDefault: !config?.provider && !config?.model }
    } catch {
      return null
    }
  }

  /** 当前状态快照，供设置面板轮询。 */
  async status() {
    await this.load()
    const cfg = this.state.config
    const lastAt = this.state.lastRunAt
    const hoursSince = lastAt ? (Date.now() - lastAt) / 3600000 : null
    return {
      running: this.running,
      phase: this.phase,
      startedAt: this.startedAt,
      steps: this.stepLog,
      config: { ...cfg },
      route: this.resolveRouteSafe(cfg),
      lastRunAt: lastAt,
      hoursSince,
      lastResult: this.state.lastResult,
      retryAfter: this.state.retryAfter,
      gate: cfg.enabled && cfg.trigger === 'auto' ? { minHours: cfg.minHours, minSessions: cfg.minSessions } : null,
      paths: { memoryDir: this.memoryDir, configPath: this.configPath, stateRoot: this.stateRoot },
    }
  }

  // ────────────────────────────── 门控 ──────────────────────────────

  /**
   * 三级门控（顺序即成本顺序）。
   * @returns {Promise<{ok:boolean, reason?:string, hoursSince?:number, sessionCount?:number}>}
   */
  async gate() {
    await this.load()
    const cfg = this.state.config
    if (!cfg.enabled) return { ok: false, reason: '未启用' }
    if (cfg.trigger !== 'auto') return { ok: false, reason: '手动模式（不会自动触发）' }

    const now = Date.now()
    if (this.state.retryAfter && now < this.state.retryAfter) {
      return { ok: false, reason: `上次失败后的退避中（还有 ${Math.ceil((this.state.retryAfter - now) / 60000)} 分钟）` }
    }

    // ① 时间门
    const lastAt = this.state.lastRunAt
    const hoursSince = lastAt ? (now - lastAt) / 3600000 : Number.POSITIVE_INFINITY
    if (hoursSince < cfg.minHours) {
      return { ok: false, reason: `距上次整理 ${hoursSince.toFixed(1)}h < ${cfg.minHours}h` }
    }

    // ② 扫描节流（在真正扫盘之前）
    if (now - this.lastScanAt < SESSION_SCAN_INTERVAL_MS) {
      return { ok: false, reason: `扫描节流中（${Math.round((now - this.lastScanAt) / 1000)}s 前刚扫过）` }
    }
    this.lastScanAt = now

    // ③ 会话门
    const sessionCount = await countSessionsSince(this.sessionsRoot, lastAt || 0)
    if (sessionCount < cfg.minSessions) {
      return { ok: false, reason: `期间只有 ${sessionCount} 个会话更新 < ${cfg.minSessions}` }
    }
    return { ok: true, hoursSince, sessionCount }
  }

  // ────────────────────────────── 锁 ──────────────────────────────

  async acquireLock() {
    await mkdir(this.stateRoot, { recursive: true })
    try {
      const fh = await open(this.lockPath, 'wx')
      await fh.write(JSON.stringify({ pid: process.pid, at: Date.now() }))
      await fh.close()
      return true
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      const info = await stat(this.lockPath).catch(() => null)
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        // 上次进程崩了留下的锁：清掉重来（不然 dream 永远回不来）。
        await rm(this.lockPath, { force: true })
        return this.acquireLock()
      }
      return false
    }
  }

  async releaseLock() {
    await rm(this.lockPath, { force: true }).catch(() => {})
  }

  // ────────────────────────────── 快照 ──────────────────────────────

  /**
   * 把 memory 目录顶层的 markdown 整体快照一份。
   *
   * 只快照顶层 `.md`：`archive/` 子目录是退役区（不需要每次跟着复制），
   * `dream/` 是报告区（自己就是产物）。
   * @returns {Promise<{dir:string, count:number}>}
   */
  async snapshot() {
    const dir = join(this.stateRoot, 'snapshots', stampCompact(Date.now()))
    await mkdir(dir, { recursive: true })
    const entries = await readdir(this.memoryDir, { withFileTypes: true }).catch(() => [])
    const files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    let count = 0
    for (const f of files) {
      try {
        await copyFile(join(this.memoryDir, f.name), join(dir, f.name))
        count++
      } catch (err) {
        this.log('warn', `快照 ${f.name} 失败：${err?.message ?? err}`)
      }
    }
    await writeFile(
      join(dir, 'MANIFEST.json'),
      JSON.stringify({ createdAt: Date.now(), createdAtHuman: stampHuman(Date.now()), files: count }, null, 2),
      'utf8',
    )
    await this.pruneSnapshots()
    return { dir, count }
  }

  /** 只保留最近 N 份快照（N = 配置里的 maxSnapshotKeep）。 */
  async pruneSnapshots() {
    const keep = Math.max(1, this.state.config.maxSnapshotKeep || DEFAULT_CONFIG.maxSnapshotKeep)
    const root = join(this.stateRoot, 'snapshots')
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
      await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
    }
  }

  /** 列出已有快照（设置面板会显示「可回退到哪一份」）。 */
  async listSnapshots() {
    const root = join(this.stateRoot, 'snapshots')
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const out = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const manifest = await readFile(join(root, e.name, 'MANIFEST.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null)
      out.push({
        name: e.name,
        at: manifest?.createdAt ?? 0,
        atHuman: manifest?.createdAtHuman ?? e.name,
        files: manifest?.files ?? 0,
        path: join(root, e.name),
      })
    }
    out.sort((a, b) => b.name.localeCompare(a.name))
    return out
  }

  // ────────────────────────────── LLM 循环 ──────────────────────────────

  /**
   * 跑一次模型调用，返回组装好的块。
   * @returns {Promise<BlockAssembler>}
   */
  async streamOnce(llm, req) {
    const asm = new BlockAssembler()
    const options = {
      provider: req.provider,
      model: req.model,
      system: req.system,
      messages: req.messages,
      maxTokens: req.maxTokens,
      signal: req.signal,
      purpose: 'session-title', // 复用「非交互式调用」的语义槽，避免被当成主对话轮次记账
    }
    if (req.tools && req.tools.length) options.tools = req.tools
    for await (const chunk of llm.stream(options)) {
      asm.push(chunk)
    }
    return asm
  }

  /**
   * 极简 agent 循环：模型 → 工具 → 结果回灌 → 再问，直到模型不再要工具或触顶。
   *
   * 每一步都把「这一轮要了什么工具」记进 stepLog，设置面板显示的就是这个。
   */
  async agentLoop(cfg, runOpts) {
    const { provider, model, toolSchemas, runner, maxSteps, tokenBudget, signal } = runOpts
    const llm = this.svc('llm')
    if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用，dream 无法运行')

    const system = buildDreamSystemPrompt({ apply: cfg.apply, withSessions: cfg.source === 'memory+sessions' })
    const userText = buildDreamUserPrompt({
      memoryDir: this.memoryDir,
      apply: cfg.apply,
      hoursSince: runOpts.hoursSince ?? 0,
      sessionCount: runOpts.sessionCount ?? 0,
      now: Date.now(),
    })
    const messages = [userMessage(userText)]

    const transcript = []
    let tokensIn = 0
    let tokensOut = 0
    let finalText = ''
    const allToolsUsed = []

    for (let step = 1; step <= maxSteps; step++) {
      if (signal?.aborted) throw new Error('dream 被取消')
      this.phase = `第 ${step} 轮：等待模型`
      const asm = await this.streamOnce(llm, {
        provider,
        model,
        system,
        messages,
        tools: toolSchemas,
        maxTokens: 4096,
        signal,
      })
      const usage = asm.usage
      if (usage) {
        tokensIn += usage.inputTokens ?? 0
        tokensOut += usage.outputTokens ?? 0
      }
      const blocks = asm.blocks()
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
      const calls = blocks.filter((b) => b.type === 'tool-call')
      if (text) finalText = text
      transcript.push({ step, text, tools: calls.map((c) => c.name) })
      this.stepLog.push({ step, tools: calls.map((c) => c.name), chars: text.length, at: Date.now() })

      if (asm.finish.kind === 'error') {
        throw new Error(`模型返回错误：${asm.finish.failure?.message ?? '未知'}`)
      }
      if (!calls.length) break

      messages.push(assistantMessage(blocks, provider, model))
      for (const call of calls) {
        let args = {}
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {}
        } catch {
          args = {}
        }
        this.phase = `第 ${step} 轮：${call.name}`
        const out = await runner.run(call.name, args)
        allToolsUsed.push(call.name)
        messages.push(toolMessage(call.id, out, /^(错误|工具执行失败)/.test(out)))
      }

      if (tokensIn + tokensOut > tokenBudget) {
        transcript.push({ step: step + 1, text: `（已达 token 预算 ${tokenBudget}，提前收工）`, tools: [] })
        break
      }
    }

    return { transcript, finalText, tokensIn, tokensOut, toolsUsed: allToolsUsed, touched: runner.touchedFiles() }
  }

  // ────────────────────────────── 报告 ──────────────────────────────

  /** 写一份报告到 `memory/dream/YYYYMMDD-HHmmss.md`。 */
  async writeReport(payload) {
    const dir = join(this.memoryDir, REPORT_DIR)
    await mkdir(dir, { recursive: true })
    // 直接整串用 —— stampCompact 返回的就是 `20260927-134209` 这种。
    // 曾经在这里按位置切片想拼成 `YYYY-MM-DD-HHmmss`，结果 slice(0,10) 从时间戳里
    // 借走了两位，写出 `20260927-1-4209.md` 这种看着像坏了的名字（2026-09-27 实测）。
    const name = `${stampCompact(payload.startedAt)}.md`
    const file = join(dir, name)

    const lines = [
      `# Dream 报告 · ${stampHuman(payload.startedAt)}`,
      '',
      `- 触发：${payload.reason}`,
      `- 模式：${payload.apply ? '改写记忆（已快照）' : '只出报告'}`,
      `- 输入源：${payload.source === 'memory+sessions' ? '记忆目录 + 会话记录' : '仅记忆目录'}`,
      `- 模型：\`${payload.provider}/${payload.model}\``,
      `- 门控：距上次 ${payload.hoursSince === null ? '（首次）' : payload.hoursSince.toFixed(1) + 'h'} · 期间 ${payload.sessionCount} 个会话更新`,
      `- 耗时：${((payload.endedAt - payload.startedAt) / 1000).toFixed(1)}s · token ${payload.tokensIn} in / ${payload.tokensOut} out`,
      payload.snapshot ? `- 运行前快照：\`${payload.snapshot.dir}\`（${payload.snapshot.count} 个文件）` : '- 运行前快照：未做（只读模式）',
      '',
      '## 改动的文件',
      '',
      payload.touched.length ? payload.touched.map((f) => `- ${f}`).join('\n') : '- （没有改动任何文件）',
      '',
      '## 审计（运行前 → 运行后）',
      '',
      '```',
      `运行前：${payload.auditBefore.problems} 个问题`,
      `运行后：${payload.auditAfter.problems} 个问题`,
      '```',
      '',
      '### 运行后明细',
      '',
      '```',
      formatAudit(payload.auditAfter, 20),
      '```',
      '',
      '## 模型的整理说明',
      '',
      payload.finalText || '（模型没有给出文字说明）',
      '',
      '## 过程',
      '',
      ...payload.transcript.map(
        (t) => `- 第 ${t.step} 轮${t.tools.length ? `：调用 ${t.tools.join('、')}` : '：结束'}${t.text ? ` — ${t.text.slice(0, 120)}` : ''}`,
      ),
      '',
    ]
    await writeFile(file, lines.join('\n'), 'utf8')
    return { file, name }
  }

  /** 列已有报告（设置面板的历史列表）。 */
  async listReports(limit = 30) {
    const dir = join(this.memoryDir, REPORT_DIR)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const out = []
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const info = await stat(join(dir, e.name)).catch(() => null)
      out.push({ name: e.name, bytes: info?.size ?? 0, at: info?.mtimeMs ?? 0, atHuman: stampHuman(info?.mtimeMs ?? 0) })
    }
    out.sort((a, b) => b.name.localeCompare(a.name))
    return out.slice(0, limit)
  }

  /** 读一份报告全文（白名单校验：只能是 dream 报告目录里的 .md）。 */
  async readReport(name) {
    const base = basename(String(name || ''))
    if (!/^[\w.-]+\.md$/.test(base)) throw new Error('sage-mem dream: 报告名不合法')
    const file = join(this.memoryDir, REPORT_DIR, base)
    const content = await readFile(file, 'utf8')
    return { name: base, content }
  }

  // ────────────────────────────── 主流程 ──────────────────────────────

  /**
   * 跑一次 dream。
   * @param {{reason?:string, force?:boolean}} opts — force 跳过门控（手动触发时用）
   */
  async run(opts = {}) {
    const reason = opts.reason ?? '手动触发'
    if (this.running) return { ok: false, error: '已有一趟 dream 在跑' }

    await this.load()
    const cfg = this.state.config
    const startedAt = Date.now()

    let hoursSince = null
    let sessionCount = 0
    if (!opts.force) {
      const g = await this.gate()
      if (!g.ok) return { ok: false, error: `门控未通过：${g.reason}` }
      hoursSince = Number.isFinite(g.hoursSince) ? g.hoursSince : null
      sessionCount = g.sessionCount ?? 0
    } else {
      sessionCount = await countSessionsSince(this.sessionsRoot, this.state.lastRunAt || 0)
      hoursSince = this.state.lastRunAt ? (startedAt - this.state.lastRunAt) / 3600000 : null
    }

    if (!(await this.acquireLock())) return { ok: false, error: '拿不到锁（另一趟 dream 正在跑？）' }

    this.running = true
    this.startedAt = startedAt
    this.stepLog = []
    this.phase = '准备中'

    const route = this.resolveRouteSafe(cfg)
    let snapshot = null
    let auditBefore = null
    try {
      if (!route) throw new Error('解析不出模型路线：配置里没写 provider/model，也拿不到默认模型')

      if (cfg.apply) {
        this.phase = '运行前快照'
        snapshot = await this.snapshot()
      }

      this.phase = '运行前审计'
      auditBefore = await auditMemoryDir(this.memoryDir)

      const withSessions = cfg.source === 'memory+sessions'
      const runner = createToolRunner({
        memoryDir: this.memoryDir,
        sessionsRoot: this.sessionsRoot,
        apply: !!cfg.apply,
        withSessions,
      })
      const toolSchemas = dreamToolSchemas({ apply: !!cfg.apply, withSessions })

      const result = await this.agentLoop(cfg, {
        provider: route.provider,
        model: route.model,
        toolSchemas,
        runner,
        maxSteps: cfg.maxSteps,
        tokenBudget: DEFAULT_TOKEN_BUDGET,
        hoursSince: hoursSince ?? 0,
        sessionCount,
      })

      this.phase = '运行后审计'
      const auditAfter = await auditMemoryDir(this.memoryDir)

      const report = await this.writeReport({
        startedAt,
        endedAt: Date.now(),
        reason,
        apply: !!cfg.apply,
        source: cfg.source,
        provider: route.provider,
        model: route.model,
        hoursSince,
        sessionCount,
        snapshot,
        touched: result.touched,
        auditBefore,
        auditAfter,
        finalText: result.finalText,
        transcript: result.transcript,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      })

      this.state.lastRunAt = Date.now()
      this.state.retryAfter = 0
      this.state.lastResult = {
        at: this.state.lastRunAt,
        atHuman: stampHuman(this.state.lastRunAt),
        ok: true,
        apply: !!cfg.apply,
        touched: result.touched,
        problemsBefore: auditBefore.problems,
        problemsAfter: auditAfter.problems,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        report: report.name,
      }
      await this.persist()
      this.phase = ''
      return { ok: true, report: report.name, touched: result.touched, auditBefore, auditAfter }
    } catch (err) {
      const message = err?.message ?? String(err)
      this.log('warn', `运行失败：${message}`)
      this.state.retryAfter = Date.now() + FAILURE_BACKOFF_MS
      this.state.lastResult = {
        at: Date.now(),
        atHuman: stampHuman(Date.now()),
        ok: false,
        apply: !!cfg.apply,
        error: message,
        tokensIn: 0,
        tokensOut: 0,
      }
      await this.persist().catch(() => {})
      this.phase = ''
      return { ok: false, error: message }
    } finally {
      this.running = false
      await this.releaseLock()
    }
  }

  // ────────────────────────────── 调度 ──────────────────────────────

  /**
   * 挂上自动触发的定时器。
   *
   * 用 `ctx.timer`（Cordis 混合进 context 的定时器助手）而不是裸 setInterval：
   * 它的 dispose 会跟着插件生命周期走，插件卸载时定时器一起消失。
   * timer 服务拿不到时退回全局 setInterval，并在日志里说清楚。
   */
  start() {
    const timer = this.svc('timer')
    const tick = () => {
      this.gate()
        .then((g) => {
          if (!g.ok) return
          this.log('warn', `门控通过，自动开始整理（${g.reason ?? ''} ${g.hoursSince?.toFixed?.(1) ?? '?'}h / ${g.sessionCount} 会话）`)
          return this.run({ reason: '自动（门控通过）' })
        })
        .catch((err) => this.log('warn', `自动触发失败：${err?.message ?? err}`))
    }

    if (timer?.interval) {
      this.disposers.push(timer.interval(tick, SCHEDULE_INTERVAL_MS))
    } else {
      const id = setInterval(tick, SCHEDULE_INTERVAL_MS)
      if (typeof id.unref === 'function') id.unref()
      this.disposers.push(() => clearInterval(id))
    }

    if (timer?.timeout) {
      this.disposers.push(timer.timeout(tick, STARTUP_CHECK_DELAY_MS))
    } else {
      const id = setTimeout(tick, STARTUP_CHECK_DELAY_MS)
      if (typeof id.unref === 'function') id.unref()
      this.disposers.push(() => clearTimeout(id))
    }
  }

  /** 插件卸载：停掉所有定时器与锁。 */
  dispose() {
    for (const d of this.disposers) {
      try {
        d()
      } catch {
        /* 忽略：卸载路径上的异常不该再冒出来 */
      }
    }
    this.disposers = []
    this.releaseLock().catch(() => {})
  }
}
