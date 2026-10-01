/**
 * sage-mem autodream —— 「自动做梦」：让记忆自己整理一遍。
 *
 * 一趟 autodream 做四件事：定位（看清已有什么）→ 收集（找新信号）→ 整合（合并、修正）
 * → 修剪（索引与断链）。下面是几个非显然的设计决定：
 *
 *   1. **门控三级，最便宜的先查**：
 *      时间门（一次读写状态）→ 会话门（一次目录扫描，且带 10 分钟节流）→ 锁。
 *      任何一级不过，后面的都不做 —— 顺序就是成本顺序。
 *   2. **执行不走真正的子代理**，直接 `ctx.llm.stream()` 手写一个极简 agent 循环。
 *      换来的是：工具集由我们给（安全边界在 autodream-tools.js）、步数有上限、
 *      不需要 agent 生命周期与 provider 注册，**也不会把 autodream 写进用户的会话记录**。
 *   3. **每一趟可回滚、可交代**。memory 目录不在任何版本控制下、删除没有回收站，
 *      所以「可回滚」必须自己造：运行前全量快照 + 运行后逐文件变更清单（含缘由），
 *      二者用同一个 runId 绑在一起，于是「2026-10-01 22:30 那次整理」既能被读懂，
 *      也能被退回去。审计则让每趟 autodream 自证没改坏。
 *   4. **模型路线可单独指定**。整理是后台批量任务，跟聊天用的模型不必是同一个；
 *      空配置 = 跟随当前默认模型，非空 = 用户显式指定，**指定了就绝不静默回落**。
 *
 * 目录约定（都在 memoryDir 的上一级 `.sage-mem/` 下）：
 *   - 配置与状态：`.sage-mem/autodream.json`（旧版 `.sage-mem/dream.json` 只读迁移）
 *   - 运行记录与声明：`.sage-mem/autodream/runs/<runId>/{manifest.json,declaration.md}`
 *   - 回滚点：`.sage-mem/autodream/snapshots/<id>/`（旧版 `.sage-mem/snapshots/` 只读兼容）
 *   - 回滚留痕：`.sage-mem/autodream/rollbacks.json`
 *   - 人读报告：`memory/autodream/<runId>.md`（旧版 `memory/dream/` 只读兼容）
 *
 * 手改配置文件也方便——它是纯文本，且和人读的东西放在一起。
 */

import { readFile, writeFile, readdir, mkdir, copyFile, rm, stat, open, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { auditMemoryDir, formatAudit } from './autodream-audit.js'
import { autodreamToolSchemas, createToolRunner } from './autodream-tools.js'
import { buildAutodreamSystemPrompt, buildAutodreamUserPrompt } from './autodream-prompt.js'

/** 配置结构版本：将来加字段时用来做迁移。v2 = 改名 autodream + 回滚点 + 声明。 */
const CONFIG_VERSION = 2

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
  /** 回滚按钮的默认范围：files = 只恢复该次运行动过的文件；all = 整目录恢复到该时点。 */
  rollbackScope: 'files',
}

/**
 * 会话门的扫描节流（10 分钟）。
 *
 * 为什么需要它：时间门过了、会话门没过时，状态里的 lastRunAt 不会前进，
 * 于是每一次触发都会重新扫一遍整个 sessions 目录。
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
const REPORT_DIR = 'autodream'

/** 改名前的报告目录。只读兼容：老报告还能在面板里翻到，但不再往里写。 */
const LEGACY_REPORT_DIR = 'dream'

/** 状态根目录名（相对 memory 根的上一层）。 */
const STATE_DIR = '.sage-mem'

/** 本功能在状态根下的私有目录（运行记录、回滚点、锁、留痕）。 */
const FEATURE_DIR = 'autodream'

/** 改名前的状态文件名（`<stateRoot>/dream.json`），只在迁移时读一次。 */
const LEGACY_STATE_FILE = 'dream.json'

/** 改名前的快照根（`<stateRoot>/snapshots/`），只读兼容。 */
const LEGACY_SNAPSHOT_DIR = 'snapshots'

/** 「回滚前保护快照」单独保留的份数——它不该被普通运行的快照轮转挤掉。 */
const PRE_ROLLBACK_KEEP = 3

/** 一次 autodream 允许累计的输入 token 上限（软保护，超了就停）。 */
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
 * 运行 id：`YYYYMMDD-HHmmss-<4 位>`。
 *
 * 加后缀是因为**同一秒里跑第二趟**在手动连点时真会发生，而 runId 同时是
 * 快照目录名、运行记录目录名和报告文件名——撞一次就是三个地方互相覆盖。
 */
function newRunId(ms) {
  return `${stampCompact(ms)}-${randomUUID().replace(/-/g, '').slice(0, 4)}`
}

/** 文件名/目录名的白名单校验（快照 id、运行 id、报告名都走这里，别让路径穿越进来）。 */
function safeName(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..')) return null
  if (!/^[\w.-]+$/.test(s)) return null
  return s
}

/** 读一个 JSON，读不到/解析失败都返回 null（配置与清单文件损坏不该拖死流程）。 */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** 快照里实际躺着哪些 .md（清单不可信时以目录为准）。 */
async function snapshotEntries(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')).map((e) => e.name)
}

/**
 * 精简版 chunk 组装器。
 *
 * 算法与宿主的 `BlockAssembler` 语义一致，
 * 只保留 autodream 用得上的两种块，并**自己实现而不是 import** —— 树外插件
 * 依赖宿主内部包要过依赖桥，版本漂移时挂的是「整个插件加载不了」这种级别的
 * 故障，而这里需要的逻辑只有三十行。
 *
 * 两个必须对齐的行为：
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
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'sage-mem-autodream' }, id: randomUUID() }
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

/** 人读的字节差：`12.0KB → 10.0KB（-2.0KB）`。 */
function formatDelta(before, after) {
  const kb = (n) => `${(n / 1024).toFixed(1)}KB`
  const d = after.bytes - before.bytes
  const sign = d > 0 ? '+' : ''
  return `${kb(before.bytes)} → ${kb(after.bytes)}（${sign}${(d / 1024).toFixed(1)}KB）`
}

/** 操作类型的中文名（声明表格里给人看）。 */
const OP_LABEL = { create: '新建', update: '改写', archive: '归档' }

export class AutodreamEngine {
  /**
   * @param {object} ctx — 插件上下文（Cordis）
   * @param {{memoryDir:string, sessionsRoot:string, version?:string}} opts
   */
  constructor(ctx, opts) {
    this.ctx = ctx
    this.memoryDir = opts.memoryDir
    this.sessionsRoot = opts.sessionsRoot
    this.version = opts.version
    /** 使用者自己声明的受保护文件名（`<状态根>/reserved.json`）——注入 prompt，绝不写死。 */
    this.reservedFiles = Array.isArray(opts.reservedFiles) ? opts.reservedFiles : []
    this.stateRoot = join(dirname(this.memoryDir), STATE_DIR)
    this.home = join(this.stateRoot, FEATURE_DIR)
    this.configPath = join(this.stateRoot, 'autodream.json')
    this.legacyConfigPath = join(this.stateRoot, LEGACY_STATE_FILE)
    this.lockPath = join(this.home, 'autodream.lock')
    /** 改名过渡期：旧版进程可能还攥着这把锁。两把互不相识的锁 = 两个进程同时改 memory。 */
    this.legacyLockPath = join(this.stateRoot, 'dream.lock')
    this.snapshotRoot = join(this.home, 'snapshots')
    this.legacySnapshotRoot = join(this.stateRoot, LEGACY_SNAPSHOT_DIR)
    this.runsRoot = join(this.home, 'runs')
    this.rollbacksPath = join(this.home, 'rollbacks.json')

    this.running = false
    this.phase = ''
    this.startedAt = 0
    this.runId = ''
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
    const line = `sage-mem autodream: ${msg}`
    const logger = this.ctx?.logger
    if (level === 'error' && logger?.error) logger.error(line)
    else if (logger?.warn) logger.warn(line)
    else console.warn(line)
  }

  // ────────────────────────────── 配置与状态 ──────────────────────────────

  /**
   * 读配置 + 状态（同一个文件）。缺失或损坏都回落到默认值，绝不让它拖死插件加载。
   *
   * **改名迁移**：新文件 `<stateRoot>/autodream.json` 不存在而旧文件 `<stateRoot>/dream.json`
   * 存在时，读旧文件、把配置搬到新文件，**旧文件原样留着不删**（用户手改过的东西，
   * 我们没有替他清理的资格；留着也让人能对照）。迁移只发生一次。
   */
  async load() {
    if (this._configLoaded) return this.state
    let parsed = await readJson(this.configPath)
    let migratedFrom = ''
    if (!parsed) {
      const legacy = await readJson(this.legacyConfigPath)
      if (legacy && typeof legacy === 'object') {
        parsed = legacy
        migratedFrom = LEGACY_STATE_FILE
      }
    }
    if (parsed && typeof parsed === 'object') {
      this.state = {
        version: CONFIG_VERSION,
        config: { ...DEFAULT_CONFIG, ...(parsed.config ?? {}) },
        lastRunAt: Number(parsed.lastRunAt) || 0,
        lastResult: parsed.lastResult ?? null,
        retryAfter: Number(parsed.retryAfter) || 0,
      }
    } else {
      this.state = { version: CONFIG_VERSION, config: { ...DEFAULT_CONFIG }, lastRunAt: 0, lastResult: null, retryAfter: 0 }
    }
    this._configLoaded = true
    if (migratedFrom) {
      this.log('warn', `读到旧版配置 ${this.legacyConfigPath}，已迁移到 ${this.configPath}（旧文件保留不动）`)
      await this.persist().catch((err) => this.log('warn', `迁移落盘失败（本次仍按内存里的配置跑）：${err?.message ?? err}`))
    }
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
    const route = this.resolveRoute(this.state.config)
    return {
      config: { ...this.state.config },
      route,
      lastRunAt: this.state.lastRunAt,
      lastResult: this.state.lastResult,
      paths: { memoryDir: this.memoryDir, configPath: this.configPath, stateRoot: this.stateRoot, home: this.home },
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
    if (p.rollbackScope === 'files' || p.rollbackScope === 'all') c.rollbackScope = p.rollbackScope
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

  /** 当前会话默认模型路线（取不到就是 null）。 */
  defaultSelection() {
    try {
      const sel = this.svc('agentDefaultModel')?.currentSelection?.()
      const provider = String(sel?.provider ?? '').trim()
      const model = String(sel?.model ?? '').trim()
      if (!provider || !model) return null
      return { provider, model }
    } catch {
      return null
    }
  }

  /**
   * 解析这一趟该用哪条模型路线。
   *
   * 三条语义必须分得清（否则「我明明选了模型它怎么还用别的」这类问题查不出来）：
   *   - `source:'config'`  用户显式指定 → **指定了就只认它**，解析不出来宁可报错也不回落
   *   - `source:'default'` 配置留空 → 用当前会话默认模型
   *   - `source:'none'`    两条都拿不到 → `error` 里写清原因
   * 永远返回对象，不抛异常；UI 两种形状都要能读（见 contract）。
   */
  resolveRoute(config) {
    const p = String(config?.provider ?? '').trim()
    const m = String(config?.model ?? '').trim()
    const explicit = !!(p && m)
    // 只填了一半：这是配置错误，不是「跟随默认」。说清楚，别猜。
    if (!explicit && (p || m)) {
      return {
        provider: p,
        model: m,
        fromDefault: false,
        source: 'none',
        error: `配置里只填了 ${p ? 'provider' : 'model'}，必须成对填；两项都清空则跟随当前会话默认模型`,
      }
    }
    if (explicit) return { provider: p, model: m, fromDefault: false, source: 'config', error: null }
    const def = this.defaultSelection()
    if (def) return { provider: def.provider, model: def.model, fromDefault: true, source: 'default', error: null }
    return {
      provider: '',
      model: '',
      fromDefault: false,
      source: 'none',
      error: '配置里没写 provider/model，也拿不到当前会话默认模型',
    }
  }

  /**
   * 可选的模型路线清单。
   *
   * 数据源是宿主的 **`llm` 服务**（`listProviders()` + 逐 provider 的 `listModels()`），
   * 三个「看起来更顺手但会出错」的替代都被排除了：
   *   - `agentDefaultModel` 只有当前那一条，不是目录；
   *   - 面向子代理的模型选择策略会**按白名单过滤 provider**，拿它当全量目录会漏；
   *   - `sessionController.modelCatalog()` 依赖会话控制器挂载，而整理是后台任务。
   *
   * 单个 provider 取模型失败**不拖垮整表**（宿主自己的目录也是这么处理的）——
   * 一条渠道的 key 过期不该让整个下拉框变空。
   */
  async listModels() {
    const routes = []
    let catalogAvailable = false
    let note = ''
    const llm = this.svc('llm')
    if (!llm || typeof llm.listProviders !== 'function') {
      note = 'llm 服务不可用，取不到模型目录，请手填 provider 与 model'
    } else {
      let providers = []
      try {
        providers = llm.listProviders() ?? []
      } catch (err) {
        note = `读取 provider 列表失败：${err?.message ?? err}`
      }
      for (const p of providers) {
        const pid = String(p?.id ?? '').trim()
        if (!pid) continue
        const pName = String(p?.name ?? pid).trim()
        let models = []
        try {
          // 同步返回数组或 Promise 都收（不同宿主版本两种都有）。
          models = (await llm.listModels(pid)) ?? []
        } catch {
          // 单个 provider 挂了不记 note：那是常态，不是整表故障。
          models = []
        }
        for (const m of models) {
          const mid = String(m?.id ?? '').trim()
          if (!mid) continue
          const mName = String(m?.name ?? mid).trim()
          routes.push({ provider: pid, model: mid, label: `${pName} / ${mName}`, isDefault: false })
        }
      }
      catalogAvailable = routes.length > 0
    }
    const def = this.defaultSelection()
    if (def) {
      const hit = routes.find((r) => r.provider === def.provider && r.model === def.model)
      if (hit) hit.isDefault = true
      else {
        // 当前默认模型可能来自一个 listModels 拿不到东西的 provider（见下面「空目录放行」）。
        // 把它补进来，否则下拉框会显示「跟随默认」但目录里找不到它。
        routes.unshift({
          provider: def.provider,
          model: def.model,
          label: `${def.provider} / ${def.model}`,
          isDefault: true,
        })
        catalogAvailable = true
      }
    }
    if (!catalogAvailable && !note) note = '宿主没有可枚举的模型目录，请手填 provider 与 model'
    routes.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))
    return { routes, defaultRoute: def, catalogAvailable, note }
  }

  /**
   * 运行前判「这条路线在宿主里存在吗」。
   *
   * 复刻宿主发消息前那道 `modelAvailable` 闸门（它没被导出，只能自己写一遍那三行）。
   * **纯本地目录比较，不发任何模型请求** —— 这正是「运行前就报错，别跑到一半才失败」要的东西。
   *
   * 两个已知陷阱，都刻意避开：
   *   - **空目录放行**：某些适配器的 `listModels` 恒返回 `[]`（没接 discoverModels）。
   *     若把「目录为空」当「模型不存在」，会把明明能用的路线毙掉 → 返回 `ok:true, checked:false`。
   *   - **不信 `resolveModelInfo` 当存在性判据**：deepseek 那条对未知模型不报错，
   *     而是合成一份假元数据（`name === id`），拿它校验等于永远通过。
   *
   * @returns {Promise<{ok:boolean, checked:boolean, reason:string}>}
   */
  async checkRouteAvailable(provider, model) {
    const llm = this.svc('llm')
    if (!llm || typeof llm.listProviders !== 'function') {
      return { ok: true, checked: false, reason: 'llm 服务不可用，跳过存在性校验' }
    }
    let providers = []
    try {
      providers = llm.listProviders() ?? []
    } catch (err) {
      return { ok: true, checked: false, reason: `读取 provider 列表失败（${err?.message ?? err}），跳过校验` }
    }
    const ids = providers.map((p) => String(p?.id ?? '')).filter(Boolean)
    if (!ids.includes(provider)) {
      return { ok: false, checked: true, reason: `宿主没有名为 ${provider} 的 provider（已注册：${ids.join('、') || '（无）'}）` }
    }
    let models = []
    try {
      models = (await llm.listModels(provider)) ?? []
    } catch (err) {
      return { ok: false, checked: true, reason: `读取 ${provider} 的模型目录失败：${err?.message ?? err}` }
    }
    if (!models.length) {
      return { ok: true, checked: false, reason: `${provider} 的模型目录为空，无法判断该模型是否存在（放行）` }
    }
    if (!models.some((m) => String(m?.id ?? '') === model)) {
      const names = models.map((m) => String(m?.id ?? '')).filter(Boolean)
      return {
        ok: false,
        checked: true,
        reason: `${provider} 的目录里没有模型 ${model}（可选：${names.slice(0, 8).join('、')}${names.length > 8 ? '…' : ''}）`,
      }
    }
    return { ok: true, checked: true, reason: '' }
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
      runId: this.runId,
      steps: this.stepLog,
      config: { ...cfg },
      route: this.resolveRoute(cfg),
      lastRunAt: lastAt,
      hoursSince,
      lastResult: this.state.lastResult,
      retryAfter: this.state.retryAfter,
      gate: cfg.enabled && cfg.trigger === 'auto' ? { minHours: cfg.minHours, minSessions: cfg.minSessions } : null,
      paths: { memoryDir: this.memoryDir, configPath: this.configPath, stateRoot: this.stateRoot, home: this.home },
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
    await mkdir(this.home, { recursive: true })
    // 改名过渡期：旧版进程的 `dream.lock` 我们看不见，但它一样在改 memory。
    // 新鲜（未过期）就先拒绝——正常升级流程会重启进程，这条只兜「新旧并行」那一小段窗口。
    const legacy = await stat(this.legacyLockPath).catch(() => null)
    if (legacy && Date.now() - legacy.mtimeMs <= LOCK_STALE_MS) return false
    try {
      const fh = await open(this.lockPath, 'wx')
      await fh.write(JSON.stringify({ pid: process.pid, at: Date.now(), runId: this.runId }))
      await fh.close()
      return true
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      const info = await stat(this.lockPath).catch(() => null)
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        // 上次进程崩了留下的锁：清掉重来（不然 autodream 永远回不来）。
        await rm(this.lockPath, { force: true })
        return this.acquireLock()
      }
      return false
    }
  }

  async releaseLock() {
    await rm(this.lockPath, { force: true }).catch(() => {})
  }

  // ────────────────────────────── 回滚点（快照） ──────────────────────────────

  /**
   * 把 memory 目录顶层的 markdown 整体快照一份，作为**回滚点**。
   *
   * 只快照顶层 `.md`：`archive/` 子目录是退役区（不需要每次跟着复制），
   * `autodream/` 是报告区（自己就是产物）。
   *
   * 每条都记 sha256：回滚后「是不是真的回到了那一版」靠它判等——只看体积在 markdown 里太容易骗人。
   *
   * @param {string} id — 快照 id（apply 运行就是 runId；保护快照用 `pre-rollback-<时间戳>`）
   * @param {'run'|'pre-rollback'} kind
   * @returns {Promise<{id:string, dir:string, count:number, expected:number, failed:string[], files:Array<{name:string,bytes:number,sha256:string}>}>}
   */
  async snapshot(id, kind = 'run') {
    const dir = join(this.snapshotRoot, id)
    await mkdir(this.snapshotRoot, { recursive: true })
    // **故意不用 recursive**：快照 id 撞车必须是硬错误，不能静默覆盖一份已有的回滚点。
    // 2026-10-01 实测踩到 —— 同一秒里连着两次回滚，`pre-rollback-<秒级时间戳>` 撞车，
    // 第二次的保护快照把第一次的覆盖成「回滚后」的状态，于是「退回到保护点」等于什么都没退。
    try {
      await mkdir(dir)
    } catch (err) {
      if (err?.code === 'EEXIST') throw new Error(`回滚点 id 撞车：${id} 已存在，拒绝覆盖已有的回滚点`)
      throw err
    }
    const entries = await readdir(this.memoryDir, { withFileTypes: true }).catch(() => [])
    const files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    const recorded = []
    /** 没存下来的文件。**不是「警告一下就继续」**：调用方要拿它决定是否中止。 */
    const failed = []
    for (const f of files) {
      try {
        const buf = await readFile(join(this.memoryDir, f.name))
        await writeFile(join(dir, f.name), buf)
        recorded.push({ name: f.name, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') })
      } catch (err) {
        failed.push(f.name)
        this.log('warn', `快照 ${f.name} 失败：${err?.message ?? err}`)
      }
    }
    const manifest = {
      schema: 1,
      id,
      kind,
      runId: kind === 'run' ? id : null,
      createdAt: Date.now(),
      createdAtHuman: stampHuman(Date.now()),
      files: recorded,
      fileCount: recorded.length,
      failed,
    }
    await writeFile(join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8')
    await this.pruneSnapshots()
    return { id, dir, count: recorded.length, expected: files.length, failed, files: recorded }
  }

  /**
   * 淘汰旧回滚点。
   *
   * **两类分开数**：普通运行的快照按 `maxSnapshotKeep`；「回滚前保护快照」
   * 另给一个额度（`PRE_ROLLBACK_KEEP`）—— 保护快照的唯一用途就是「刚回滚完发现滚错了」，
   * 被普通运行的快照轮转挤掉等于没有。旧版目录（`<stateRoot>/snapshots/`）只读，不参与淘汰。
   */
  async pruneSnapshots() {
    const keep = Math.max(1, this.state.config.maxSnapshotKeep || DEFAULT_CONFIG.maxSnapshotKeep)
    const entries = await readdir(this.snapshotRoot, { withFileTypes: true }).catch(() => [])
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    const preRollback = dirs.filter((n) => n.startsWith('pre-rollback-'))
    const runs = dirs.filter((n) => !n.startsWith('pre-rollback-'))
    for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
      await rm(join(this.snapshotRoot, name), { recursive: true, force: true }).catch(() => {})
    }
    for (const name of preRollback.slice(0, Math.max(0, preRollback.length - PRE_ROLLBACK_KEEP))) {
      await rm(join(this.snapshotRoot, name), { recursive: true, force: true }).catch(() => {})
    }
  }

  /** 快照目录的真实位置：先找新版，再找旧版；都没有返回 null。 */
  async resolveSnapshotDir(id) {
    const name = safeName(id)
    if (!name) return null
    for (const root of [this.snapshotRoot, this.legacySnapshotRoot]) {
      const dir = join(root, name)
      const info = await stat(dir).catch(() => null)
      if (info?.isDirectory()) return dir
    }
    return null
  }

  /**
   * 列出所有回滚点（新版 + 旧版目录都列）。
   *
   * 「可回退到哪一份」是给人看的，所以：旧版快照标 `legacy:true`、保护快照标 `kind`，
   * 让界面能说清「这一份是哪来的」。
   */
  async listSnapshots() {
    const out = []
    for (const [root, legacy] of [
      [this.snapshotRoot, false],
      [this.legacySnapshotRoot, true],
    ]) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const dir = join(root, e.name)
        const manifest = await readJson(join(dir, 'MANIFEST.json'))
        const names = await snapshotEntries(dir)
        out.push({
          name: e.name,
          at: manifest?.createdAt ?? 0,
          atHuman: manifest?.createdAtHuman ?? e.name,
          files: Array.isArray(manifest?.files)
            ? manifest.files.length
            : typeof manifest?.files === 'number'
              ? manifest.files
              : names.length,
          path: dir,
          runId: manifest?.runId ?? (manifest?.kind === 'run' ? e.name : null),
          kind: manifest?.kind ?? (legacy ? 'legacy' : 'run'),
          legacy,
        })
      }
    }
    // 新的在前（名字里带时间戳，字典序即时间序）。
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
    if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用，autodream 无法运行')

    const system = buildAutodreamSystemPrompt({
      apply: cfg.apply,
      withSessions: cfg.source === 'memory+sessions',
      reservedFiles: this.reservedFiles,
    })
    const userText = buildAutodreamUserPrompt({
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
      if (signal?.aborted) throw new Error('autodream 被取消')
      // 让工具执行器知道现在是第几轮：模型没自述缘由时，声明要靠这个追溯「哪一步干的」。
      if (typeof runner.setStep === 'function') runner.setStep(step)
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

    return {
      transcript,
      finalText,
      tokensIn,
      tokensOut,
      toolsUsed: allToolsUsed,
      touched: runner.touchedFiles(),
      changes: runner.changes(),
      // warnings = 改动**没发生**（被拒）；notes = 改动**发生了**但有话要说。两者不可混。
      warnings: runner.warnings(),
      notes: typeof runner.notes === 'function' ? runner.notes() : [],
    }
  }

  // ────────────────────────────── 声明（整理交代） ──────────────────────────────

  /**
   * 把「改了什么、为什么」写成两种形态，落在 `<home>/runs/<runId>/` 下：
   *   - `manifest.json` 机读（回滚也从它读「这次动过哪几个文件」）
   *   - `declaration.md` 人读（报告里内嵌同一份）
   *
   * 没有改动时也照样写：**「这趟什么都没改」本身就是要交代的信息**。
   */
  async writeDeclaration(payload) {
    const dir = join(this.runsRoot, payload.runId)
    await mkdir(dir, { recursive: true })
    const manifest = {
      schema: 1,
      runId: payload.runId,
      startedAt: payload.startedAt,
      startedAtHuman: stampHuman(payload.startedAt),
      endedAt: payload.endedAt,
      durationMs: payload.endedAt - payload.startedAt,
      reason: payload.reason,
      mode: payload.apply ? 'apply' : 'report',
      source: payload.source,
      route: { provider: payload.provider, model: payload.model, fromDefault: !!payload.fromDefault },
      gate: { hoursSince: payload.hoursSince, sessionCount: payload.sessionCount },
      tokens: { in: payload.tokensIn, out: payload.tokensOut },
      snapshot: payload.snapshot ? { id: payload.snapshot.id, dir: payload.snapshot.dir, files: payload.snapshot.count } : null,
      audit: {
        before: { problems: payload.auditBefore?.problems ?? 0 },
        after: { problems: payload.auditAfter?.problems ?? 0 },
      },
      changes: payload.changes,
      warnings: payload.warnings,
      notes: payload.notes ?? [],
      report: payload.report ?? null,
      finalText: payload.finalText ?? '',
      rolledBackAt: 0,
      rolledBackAtHuman: '',
    }
    const markdown = this.renderDeclaration(manifest)
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    await writeFile(join(dir, 'declaration.md'), markdown, 'utf8')
    return { dir, manifest, markdown }
  }

  /** 渲染人读声明（报告里内嵌，所以标题层级可以从外面压）。 */
  renderDeclaration(m, headingLevel = 1) {
    const H = '#'.repeat(Math.max(1, Math.min(6, headingLevel)))
    const lines = [
      `${H} 整理声明 · ${m.startedAtHuman}`,
      '',
      `- 运行：\`${m.runId}\` · 模式：${m.mode === 'apply' ? '直接改写' : '只出报告'} · 模型：\`${m.route.provider}/${m.route.model}\``,
      m.snapshot
        ? `- 回滚点：\`${m.snapshot.id}\`（${m.snapshot.files} 个文件）`
        : '- 回滚点：未做（只出报告模式不写盘，无需回滚）',
      `- 审计：结构问题 ${m.audit.before.problems} → ${m.audit.after.problems}`,
      '',
      `${H}# 改了什么、为什么`,
      '',
    ]
    if (!m.changes.length) {
      lines.push(m.mode === 'apply' ? '（本次没有改动任何文件）' : '（只出报告模式，未改动文件）', '')
    } else {
      lines.push('| # | 文件 | 操作 | 缘由 | 变化 |', '|---|---|---|---|---|')
      let autoCount = 0
      for (const c of m.changes) {
        const op = OP_LABEL[c.op] ?? c.op
        const delta =
          c.op === 'archive' ? `${(c.before.bytes / 1024).toFixed(1)}KB → archive/` : formatDelta(c.before, c.after)
        let reason
        if (c.reasonSource === 'auto' || !String(c.reason ?? '').trim()) {
          // 模型没自述缘由 → 用宿主追溯得到的信息顶替，并**显式标出来**。
          // 这条路径存在的理由：硬拒会丢掉一次本来正确的修正，那比缺一句解释更糟。
          autoCount += 1
          reason = `⚠（未自述）${c.step ? `第 ${c.step} 轮` : '轮次未知'} · ${op} · ${delta}`
        } else {
          // 缘由里的竖线会撕坏表格；换行也会——一并压平。
          reason = String(c.reason)
            .replace(/\|/g, '/')
            .replace(/\s*\n\s*/g, ' ')
        }
        lines.push(`| ${c.seq} | \`${c.file}\` | ${op} | ${reason} | ${delta} |`)
      }
      lines.push('')
      if (autoCount) {
        lines.push(
          `> 其中 ${autoCount} 条的缘由是**宿主追溯**的（模型没有自述）。改动已经生效，` +
            '但动机未经模型确认 —— 值得人工看一眼这几条。',
          '',
        )
      }
    }
    if (m.warnings?.length) {
      lines.push(`${H}# 未能落地的改动（这些改动没有发生）`, '')
      for (const w of m.warnings) lines.push(`- ${w}`)
      lines.push('')
    }
    if (m.notes?.length) {
      // 与上一节**必须分开**：上一节说「没发生」，这一节说「已经生效，只是有话要说」。
      // 混在一节里会出现「标题写着未能落地、正文告诉你已生效」这种自相矛盾
      // （2026-10-01 由外包最严格一轮逮到）。
      lines.push(`${H}# 提示（改动已生效，只是有话要说）`, '')
      for (const n of m.notes) lines.push(`- ${n}`)
      lines.push('')
    }
    lines.push(`${H}# 模型的收尾说明`, '', m.finalText ? m.finalText : '（模型没有给出文字说明）', '')
    return lines.join('\n')
  }

  /** 列运行记录（面板的「整理声明」区）。 */
  async listRuns(limit = 20) {
    const entries = await readdir(this.runsRoot, { withFileTypes: true }).catch(() => [])
    const out = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const m = await readJson(join(this.runsRoot, e.name, 'manifest.json'))
      if (!m) continue
      const snapId = m.snapshot?.id ?? null
      out.push({
        runId: m.runId ?? e.name,
        at: m.startedAt ?? 0,
        atHuman: m.startedAtHuman ?? e.name,
        mode: m.mode ?? 'apply',
        reason: m.reason ?? '',
        // 只出报告模式下 changes 必为空；面板要能区分「没改」和「还没跑」。
        changeCount: Array.isArray(m.changes) ? m.changes.length : 0,
        report: m.report ?? null,
        snapshotId: snapId,
        // 回滚点会被 maxSnapshotKeep 轮转淘汰，**运行记录不会**。所以「这一趟还能不能退」
        // 必须现查一次——否则界面上会给出「可回滚」的错觉，点下去才发现没得退。
        snapshotAvailable: snapId ? (await this.resolveSnapshotDir(snapId)) !== null : false,
        rolledBackAt: Number(m.rolledBackAt) || 0,
        rolledBackAtHuman: m.rolledBackAtHuman ?? '',
      })
    }
    out.sort((a, b) => b.runId.localeCompare(a.runId))
    const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(200, Math.round(Number(limit))) : 20
    return out.slice(0, n)
  }

  /** 读一份运行记录的完整声明（机读 + 人读）。 */
  async readDeclaration(runId) {
    const id = safeName(runId)
    if (!id) throw new Error('sage-mem autodream: 运行 id 不合法')
    const dir = join(this.runsRoot, id)
    const manifest = await readJson(join(dir, 'manifest.json'))
    if (!manifest) throw new Error(`sage-mem autodream: 没有这份运行记录：${id}`)
    const markdown = await readFile(join(dir, 'declaration.md'), 'utf8').catch(() => this.renderDeclaration(manifest))
    return { runId: id, markdown, manifest }
  }

  // ────────────────────────────── 报告 ──────────────────────────────

  /** 写一份报告到 `memory/autodream/<runId>.md`。 */
  async writeReport(payload) {
    const dir = join(this.memoryDir, REPORT_DIR)
    await mkdir(dir, { recursive: true })
    // 报告名直接用 runId —— 它已经带时间戳，且与运行记录目录同名，两边对得上。
    const name = `${payload.runId}.md`
    const file = join(dir, name)

    const lines = [
      `# Autodream 报告 · ${stampHuman(payload.startedAt)}`,
      '',
      `- 运行：\`${payload.runId}\``,
      `- 触发：${payload.reason}`,
      `- 模式：${payload.apply ? '改写记忆（已建回滚点）' : '只出报告'}`,
      `- 输入源：${payload.source === 'memory+sessions' ? '记忆目录 + 会话记录' : '仅记忆目录'}`,
      `- 模型：\`${payload.provider}/${payload.model}\`${payload.fromDefault ? '（跟随当前会话默认模型）' : '（配置里指定）'}`,
      `- 门控：距上次 ${payload.hoursSince === null ? '（首次）' : payload.hoursSince.toFixed(1) + 'h'} · 期间 ${payload.sessionCount} 个会话更新`,
      `- 耗时：${((payload.endedAt - payload.startedAt) / 1000).toFixed(1)}s · token ${payload.tokensIn} in / ${payload.tokensOut} out`,
      payload.snapshot
        ? `- 回滚点：\`${payload.snapshot.id}\` · ${payload.snapshot.dir}（${payload.snapshot.count} 个文件）`
        : '- 回滚点：未做（只读模式不写盘）',
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
      // 声明内嵌进报告：一个文件就能回答「这趟干了什么、为什么」，不用两头翻。
      payload.declarationMarkdown,
      '## 过程',
      '',
      ...payload.transcript.map(
        (t) =>
          `- 第 ${t.step} 轮${t.tools.length ? `：调用 ${t.tools.join('、')}` : '：结束'}${t.text ? ` — ${t.text.slice(0, 120)}` : ''}`,
      ),
      '',
    ]
    await writeFile(file, lines.join('\n'), 'utf8')
    return { file, name }
  }

  /** 列已有报告（设置面板的历史列表）。新版目录 + 旧版目录都列，旧版标出来。 */
  async listReports(limit = 30) {
    const out = []
    for (const [dirName, legacy] of [
      [REPORT_DIR, false],
      [LEGACY_REPORT_DIR, true],
    ]) {
      const dir = join(this.memoryDir, dirName)
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue
        const info = await stat(join(dir, e.name)).catch(() => null)
        out.push({
          name: legacy ? `${dirName}/${e.name}` : e.name,
          bytes: info?.size ?? 0,
          at: info?.mtimeMs ?? 0,
          atHuman: stampHuman(info?.mtimeMs ?? 0),
          legacy,
        })
      }
    }
    out.sort((a, b) => b.name.localeCompare(a.name))
    return out.slice(0, limit)
  }

  /** 读一份报告全文（白名单校验：只能是报告目录里的 .md，允许旧版目录前缀）。 */
  async readReport(name) {
    let dirName = REPORT_DIR
    let base = String(name || '')
    if (base.startsWith(`${LEGACY_REPORT_DIR}/`)) {
      dirName = LEGACY_REPORT_DIR
      base = base.slice(LEGACY_REPORT_DIR.length + 1)
    }
    const safe = safeName(base)
    if (!safe || !/\.md$/i.test(safe)) throw new Error('sage-mem autodream: 报告名不合法')
    const content = await readFile(join(this.memoryDir, dirName, safe), 'utf8')
    return { name: dirName === REPORT_DIR ? safe : `${dirName}/${safe}`, content }
  }

  // ────────────────────────────── 回滚 ──────────────────────────────

  /** 读回滚留痕（面板也许要显示「最近谁退回过」）。 */
  async listRollbacks(limit = 20) {
    const all = await readJson(this.rollbacksPath)
    const list = Array.isArray(all) ? all : []
    return list.slice(-limit).reverse()
  }

  /** 追加一条回滚留痕。 */
  async appendRollback(entry) {
    const all = await readJson(this.rollbacksPath)
    const list = Array.isArray(all) ? all : []
    list.push(entry)
    await mkdir(this.home, { recursive: true })
    await writeFile(this.rollbacksPath, JSON.stringify(list.slice(-200), null, 2), 'utf8')
  }

  /** 把运行记录标成「已被回滚」。 */
  async markRunRolledBack(runId, at) {
    const id = safeName(runId)
    if (!id) return
    const file = join(this.runsRoot, id, 'manifest.json')
    const m = await readJson(file)
    if (!m) return
    m.rolledBackAt = at
    m.rolledBackAtHuman = stampHuman(at)
    await writeFile(file, JSON.stringify(m, null, 2), 'utf8')
  }

  /**
   * 把记忆目录退回到某个回滚点。
   *
   * 四步顺序不可变（见 contract §5）：
   *   ① 保护快照 —— 回滚本身也可能滚错，所以回滚前先把「现在」存下来
   *   ② 恢复 —— `all` 整目录；`files` 只动该次运行动过的文件
   *   ③ 留痕 —— 报告 + `rollbacks.json`
   *   ④ 回写运行记录
   *
   * **全程不删文件**：回滚中「不该存在」的文件一律移进 `archive/`（人工可捞回）。
   * memory 目录没有版本控制也没有回收站，`unlink` 不该出现在这条路径上。
   *
   * @param {{snapshotId:string, scope?:'files'|'all'}} opts
   */
  async rollback(opts = {}) {
    const snapshotId = safeName(opts?.snapshotId)
    const scope = opts?.scope === 'all' ? 'all' : 'files'
    if (!snapshotId) return { ok: false, error: '快照 id 不合法' }
    if (this.running) return { ok: false, error: '正在整理中，等它跑完再回滚' }

    const snapDir = await this.resolveSnapshotDir(snapshotId)
    if (!snapDir) return { ok: false, error: `找不到回滚点：${snapshotId}` }

    await this.load()
    if (!(await this.acquireLock())) return { ok: false, error: '拿不到锁（另一趟整理正在跑？）' }
    const startedAt = Date.now()
    const stamp = stampCompact(startedAt)
    try {
      const manifest = await readJson(join(snapDir, 'MANIFEST.json'))
      const runId = manifest?.runId ?? null

      // 文件级回滚要知道「这次动过哪几个文件」——那信息在运行记录里，不在快照里。
      let runManifest = null
      if (scope === 'files') {
        if (!runId) return { ok: false, error: '这份回滚点没有绑定运行记录（旧版快照），只能选「整目录恢复」' }
        runManifest = await readJson(join(this.runsRoot, runId, 'manifest.json'))
        if (!runManifest) return { ok: false, error: `找不到回滚点 ${snapshotId} 对应的运行记录，只能选「整目录恢复」` }
      }

      // ① 保护快照
      this.phase = '回滚前保护快照'
      // 带随机后缀：秒级时间戳会撞（同一秒内连点两次回滚是真实用法），
      // 而撞车的后果是**覆盖掉上一次的保护快照**——那等于把「回滚也能退」这条承诺吃掉。
      const protectionId = `pre-rollback-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 4)}`
      const protection = await this.snapshot(protectionId, 'pre-rollback')

      // ② 恢复
      this.phase = '恢复文件'
      const snapNames = await snapshotEntries(snapDir)
      const snapSet = new Set(snapNames)
      const current = (await readdir(this.memoryDir, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
        .map((e) => e.name)

      const restored = []
      const parked = []
      const skipped = []
      const archiveDir = join(this.memoryDir, 'archive')
      await mkdir(archiveDir, { recursive: true })

      /** 移进 archive/（不删）。同名冲突就跳过并记账，绝不覆盖。 */
      const park = async (name, why) => {
        const target = join(archiveDir, name)
        const clash = await stat(target).catch(() => null)
        if (clash) {
          skipped.push(`${name}（本想${why}，但 archive/ 里已有同名文件）`)
          return false
        }
        await rename(join(this.memoryDir, name), target)
        parked.push(`${name}（${why}）`)
        return true
      }

      if (scope === 'all') {
        for (const name of snapNames) {
          try {
            await copyFile(join(snapDir, name), join(this.memoryDir, name))
            restored.push(name)
          } catch (err) {
            skipped.push(`${name}（写回失败：${err?.message ?? err}）`)
          }
        }
        // 快照之后新建的文件：整目录回滚要让它退场，但不能删——移进 archive/。
        for (const name of current) {
          if (!snapSet.has(name)) await park(name, '快照里没有，整目录回滚需退场')
        }
      } else {
        for (const c of runManifest.changes ?? []) {
          const name = c.file
          if (c.op === 'update') {
            if (snapSet.has(name)) {
              try {
                await copyFile(join(snapDir, name), join(this.memoryDir, name))
                restored.push(name)
              } catch (err) {
                skipped.push(`${name}（写回失败：${err?.message ?? err}）`)
              }
            } else {
              skipped.push(`${name}（回滚点里没有这一版，可能已被别的整理改过）`)
            }
          } else if (c.op === 'create') {
            if (current.includes(name)) await park(name, '本次整理新建，回滚即退场')
          } else if (c.op === 'archive') {
            // 归档 = 从顶层移进 archive/；回滚就是把它移回来。
            const src = join(archiveDir, name)
            const exists = await stat(src).catch(() => null)
            const atTop = await stat(join(this.memoryDir, name)).catch(() => null)
            if (!exists) skipped.push(`${name}（archive/ 里找不到，可能已人工处理过）`)
            else if (atTop) skipped.push(`${name}（顶层已有同名文件，不覆盖）`)
            else {
              await rename(src, join(this.memoryDir, name))
              restored.push(name)
            }
          }
        }
      }

      // ③ 留痕
      this.phase = '写回滚报告'
      const reportName = `${stamp}-rollback.md`
      const lines = [
        `# Autodream 回滚报告 · ${stampHuman(startedAt)}`,
        '',
        `- 回滚目标：\`${snapshotId}\`${runId ? `（运行 \`${runId}\`）` : '（旧版快照）'}`,
        `- 范围：${scope === 'all' ? '整目录恢复到该时点' : '只恢复该次运行动过的文件'}`,
        `- 回滚前保护快照：\`${protection.id}\`（${protection.count} 个文件）—— 滚错了还能再退回来`,
        '',
        '## 写回的文件',
        '',
        restored.length ? restored.map((f) => `- \`${f}\``).join('\n') : '- （没有文件被写回）',
        '',
        '## 移进 archive/ 的文件（没有删除）',
        '',
        parked.length ? parked.map((f) => `- ${f}`).join('\n') : '- （没有）',
        '',
      ]
      if (skipped.length) {
        lines.push('## 跳过', '', ...skipped.map((f) => `- ${f}`), '')
      }
      const reportDir = join(this.memoryDir, REPORT_DIR)
      await mkdir(reportDir, { recursive: true })
      await writeFile(join(reportDir, reportName), lines.join('\n'), 'utf8')

      const entry = {
        at: startedAt,
        atHuman: stampHuman(startedAt),
        snapshotId,
        scope,
        runId,
        restored: restored.length,
        parked: parked.length,
        skipped: skipped.length,
        protection: protection.id,
        report: reportName,
      }
      await this.appendRollback(entry)
      // ④ 回写运行记录
      if (runId) await this.markRunRolledBack(runId, startedAt)

      this.phase = ''
      return {
        ok: true,
        restored: restored.length,
        parked: parked.length,
        skipped: skipped.length,
        protection: protection.id,
        report: reportName,
      }
    } catch (err) {
      const message = err?.message ?? String(err)
      this.log('warn', `回滚失败：${message}`)
      this.phase = ''
      return { ok: false, error: message }
    } finally {
      await this.releaseLock()
    }
  }

  // ────────────────────────────── 主流程 ──────────────────────────────

  /**
   * 跑一次 autodream。
   * @param {{reason?:string, force?:boolean}} opts — force 跳过门控（手动触发时用）
   */
  async run(opts = {}) {
    const reason = opts.reason ?? '手动触发'
    if (this.running) return { ok: false, error: '已有一趟 autodream 在跑' }

    await this.load()
    const cfg = this.state.config
    const startedAt = Date.now()
    const runId = newRunId(startedAt)

    let hoursSince = null
    let sessionCount = 0
    if (opts.gateResult) {
      // 自动触发路径：门控在 tick 里**已经跑过一遍**，这里绝不能再跑第二遍 ——
      // `gate()` 内部有 10 分钟扫描节流，第二次调用必然被刚设下的节流挡回来
      // （「扫描节流中（0s 前刚扫过）」），于是自动整理一次都跑不成；而 tick 若不查
      // run 的返回值，连一行错误日志都没有。2026-10-01 由外包评审从代码推理逮到。
      hoursSince = Number.isFinite(opts.gateResult.hoursSince) ? opts.gateResult.hoursSince : null
      sessionCount = opts.gateResult.sessionCount ?? 0
    } else if (!opts.force) {
      const g = await this.gate()
      if (!g.ok) return { ok: false, error: `门控未通过：${g.reason}` }
      hoursSince = Number.isFinite(g.hoursSince) ? g.hoursSince : null
      sessionCount = g.sessionCount ?? 0
    } else {
      sessionCount = await countSessionsSince(this.sessionsRoot, this.state.lastRunAt || 0)
      hoursSince = this.state.lastRunAt ? (startedAt - this.state.lastRunAt) / 3600000 : null
    }

    if (!(await this.acquireLock())) return { ok: false, error: '拿不到锁（另一趟 autodream 正在跑？）' }

    this.running = true
    this.startedAt = startedAt
    this.runId = runId
    this.stepLog = []
    this.phase = '准备中'

    const route = this.resolveRoute(cfg)
    let snapshot = null
    let auditBefore = null
    /** 提到 try 外面：失败路径要拿它问「已经写进去哪几条」。 */
    let runner = null
    /**
     * 还没开始任何模型调用 / 写入 —— 也就是「开工前的确定性失败」（路线不存在、配置半填、
     * 快照不完整、审计跑不动）。
     *
     * 这类失败**不该吃失败退避**：退避是为了别让偶发故障把门控刷成高频重试，而配置错误
     * 是人去改配置才能好的——用户改完却还要等一小时才生效，是最没道理的一种等待。
     */
    let preflight = true
    try {
      // 路线在开工前就判死：跑到一半才发现模型不存在，等于白烧一整轮上下文。
      if (route.source === 'none') throw new Error(`模型路线不可用：${route.error}`)
      if (route.source === 'config') {
        const chk = await this.checkRouteAvailable(route.provider, route.model)
        if (!chk.ok) {
          throw new Error(
            `配置里指定的模型路线不可用：${chk.reason}。` +
              '请到「自动做梦 → 高级设置 → 模型」重新选一条，或清空两项改为跟随默认模型。',
          )
        }
        if (!chk.checked) this.log('warn', `模型路线存在性未完全校验：${chk.reason}`)
      }

      if (cfg.apply) {
        this.phase = '运行前快照（回滚点）'
        snapshot = await this.snapshot(runId, 'run')
        // 快照不完整就不许开工。残缺的回滚点比没有回滚点**更危险**——它让人以为
        // 「退得回去」。在任何写操作之前中止，是这条路径上唯一诚实的做法。
        if (snapshot.failed.length) {
          const shown = snapshot.failed.slice(0, 3).join('、')
          throw new Error(
            `运行前快照有 ${snapshot.failed.length} 个文件没存下来（${shown}${snapshot.failed.length > 3 ? '…' : ''}），` +
              '回滚点不完整，本次整理已中止（未改动任何文件）。请检查磁盘空间与文件占用后重试。',
          )
        }
      }

      this.phase = '运行前审计'
      auditBefore = await auditMemoryDir(this.memoryDir)

      const withSessions = cfg.source === 'memory+sessions'
      runner = createToolRunner({
        memoryDir: this.memoryDir,
        sessionsRoot: this.sessionsRoot,
        apply: !!cfg.apply,
        withSessions,
      })
      const toolSchemas = autodreamToolSchemas({ apply: !!cfg.apply, withSessions })

      // 从这里往下就会真的动模型和磁盘了 —— 之后的失败按「运行期故障」处理（吃退避）。
      preflight = false
      this.phase = '运行中'
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

      const endedAt = Date.now()
      this.phase = '整理声明'
      const declaration = await this.writeDeclaration({
        runId,
        startedAt,
        endedAt,
        reason,
        apply: !!cfg.apply,
        source: cfg.source,
        provider: route.provider,
        model: route.model,
        fromDefault: route.fromDefault,
        hoursSince,
        sessionCount,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        snapshot,
        changes: result.changes,
        warnings: result.warnings,
        notes: result.notes,
        auditBefore,
        auditAfter,
        finalText: result.finalText,
      })

      const report = await this.writeReport({
        runId,
        startedAt,
        endedAt,
        reason,
        apply: !!cfg.apply,
        source: cfg.source,
        provider: route.provider,
        model: route.model,
        fromDefault: route.fromDefault,
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
        declarationMarkdown: declaration.markdown,
      })

      this.state.lastRunAt = Date.now()
      this.state.retryAfter = 0
      this.state.lastResult = {
        at: this.state.lastRunAt,
        atHuman: stampHuman(this.state.lastRunAt),
        ok: true,
        runId,
        apply: !!cfg.apply,
        touched: result.touched,
        changeCount: result.changes.length,
        problemsBefore: auditBefore.problems,
        problemsAfter: auditAfter.problems,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        report: report.name,
        snapshotId: snapshot?.id ?? null,
      }
      await this.persist()
      this.phase = ''
      return {
        ok: true,
        runId,
        report: report.name,
        touched: result.touched,
        changeCount: result.changes.length,
        snapshotId: snapshot?.id ?? null,
        auditBefore,
        auditAfter,
      }
    } catch (err) {
      const message = err?.message ?? String(err)
      this.log('warn', `运行失败：${message}`)

      // **中途失败也要交代。** 已经落盘的改动不会自己消失，而「有改动、无声明」是最坏的
      // 一种状态：人既不知道发生了什么，也不知道该不该回滚。回滚点此时仍然有效
      // （它在任何写操作之前就建好了），声明把「中断前已经改了什么」钉住。
      const partial = runner ? runner.changes() : []
      if (partial.length) {
        try {
          await this.writeDeclaration({
            runId,
            startedAt,
            endedAt: Date.now(),
            reason: `${reason}（运行中断）`,
            apply: !!cfg.apply,
            source: cfg.source,
            provider: route.provider,
            model: route.model,
            fromDefault: route.fromDefault,
            hoursSince,
            sessionCount,
            tokensIn: 0,
            tokensOut: 0,
            snapshot,
            changes: partial,
            warnings: [...(runner?.warnings() ?? []), `运行在写完 ${partial.length} 条改动之后中断：${message}`],
            notes: runner?.notes?.() ?? [],
            auditBefore,
            auditAfter: null,
            finalText: `本次运行中断。以上是中断前**已经落盘**的改动；中断原因：${message}`,
          })
        } catch (e2) {
          // 失败路径上的再失败不能盖住原始错误——只记一行，然后照原样把原始错误报出去。
          this.log('warn', `中断声明写入失败：${e2?.message ?? e2}`)
        }
      }

      this.state.retryAfter = preflight ? 0 : Date.now() + FAILURE_BACKOFF_MS
      this.state.lastResult = {
        at: Date.now(),
        atHuman: stampHuman(Date.now()),
        ok: false,
        runId,
        apply: !!cfg.apply,
        error: message,
        // preflight 失败会明确标出来：它和「模型跑到一半挂了」是两种病，退避策略也不同。
        preflight,
        changeCount: partial.length,
        snapshotId: snapshot?.id ?? null,
        tokensIn: 0,
        tokensOut: 0,
      }
      await this.persist().catch(() => {})
      this.phase = ''
      return { ok: false, error: message }
    } finally {
      this.running = false
      this.runId = ''
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
          if (!g.ok) return undefined
          this.log('warn', `门控通过，自动开始整理（${g.reason ?? ''} ${g.hoursSince?.toFixed?.(1) ?? '?'}h / ${g.sessionCount} 会话）`)
          // 门控结果**带进去**，别让 run() 再跑一遍 gate()——gate() 有 10 分钟扫描节流，
          // 第二遍必然被刚设下的节流挡回（详见 run() 里那段注释）。
          return this.run({ reason: '自动（门控通过）', gateResult: g })
        })
        .then((r) => {
          // run() 失败是**返回** `{ok:false}` 而不是抛；不看返回值就等于静默失败，
          // 而「自动整理悄悄不工作」正是这个功能最难查的故障形态。
          if (r && r.ok === false) this.log('warn', `自动整理没有跑成：${r.error ?? '未知原因'}`)
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
