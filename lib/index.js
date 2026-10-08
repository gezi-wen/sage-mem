/**
 * sage-mem — 文件式记忆插件。
 *
 * 记忆存在本地 markdown 文件目录（frontmatter + 正文，4 类），不是数据库。
 * host 侧三件事：
 *   1. 按问题检索注入：system-prompt/assemble 时扫 memory 目录，按双字匹配
 *      选相关文件，读全文注入 system prompt，让 agent 第一轮就「想起」
 *   2. TypertRemoteService：给设置页「记忆管理」提供文件列表/读/写/删
 *   3. autodream（自动做梦）：可选的记忆整理，见 lib/autodream.js
 *
 * 写入靠 AGENTS.md 的「记忆使用」规则引导 agent 自己判断 + 用文件工具写
 * memory 目录——透明、可检查、防膨胀。无 worker、无 SQLite、无端口。
 *
 * 旧 worker 版见 git 分支 `sqlite-worker`。
 */

import { AutodreamEngine } from './autodream.js'
import { auditMemoryDir } from './autodream-audit.js'
import { DEFAULT_CONFIG } from './autodream/config.js'
import { readJson } from './autodream/util.js'
import { MAX_BASELINE, MAX_CHARS_PER_FILE, MAX_FILE_BYTES, MAX_RESULTS, MAX_SESSION_BYTES, MEMORY_DIR, RECALL_DISCIPLINE, RESERVED_FILES, SESSIONS_ROOT, STALE_DAYS, STATE_ROOT } from './memory/config.js'
import { parseAliases, parseBaseline, parseBaselinePriority, parseFrontmatter, parseTags } from './memory/frontmatter.js'
import { isReserved, nameKey, safeName } from './memory/naming.js'
import { ageDays, bigrams, extractText, score, selectBaseline, selectRelevant } from './memory/retrieval.js'
import { MEMORY_ARCHIVE_DIR, addArchiveMeta, extractTitle, readArchivedMeta, scanArchived, scanMemoryFiles, scanStars } from './memory/scan.js'
import { archiveMemory, restoreMemory } from './memory/archive.js'
import { flushAccess, pickArchiveCandidates, readAccessLedger, recordAccess } from './memory/access.js'
import { warnLog, writeFileAtomic } from './memory/util.js'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * `SAGE_MEM_DEBUG=1` 才出声的注入链调试出口。
 *
 * 一行结构化 JSON：候选数 / 命中数 / 逐条得分 / 入选与真注入的文件名 / 注入字符数 /
 * 被会话预算挡掉几条。它回答的是「这条记忆为什么没被召回」——一个光看上下文永远查不出的问题。
 *
 * ⚠️ **不开时零输出、零额外开销**：常量的读取只在模块加载时发生一次；调用点整个包在
 * `if (DEBUG_RECALL)` 里，连 payload 对象都不会被构造出来。
 */
const DEBUG_RECALL = process.env.SAGE_MEM_DEBUG === '1'

function debugRecall(payload) {
  if (!DEBUG_RECALL) return
  console.log(`[sage-mem] recall ${JSON.stringify(payload)}`)
}

/**
 * 面板可改的 5 项注入上限 —— 与 `memory/config.js` 里的 `SAGE_MEM_*` 一一对应。
 * 边界值照抄那边的 envInt 调用（lo/hi 不许在这里另立一套）。
 */
const LIMIT_SPECS = {
  maxResults: { env: 'SAGE_MEM_MAX_RESULTS', dflt: 10, lo: 1, hi: 30 },
  maxChars: { env: 'SAGE_MEM_MAX_CHARS', dflt: 1500, lo: 200, hi: 20000 },
  maxBaseline: { env: 'SAGE_MEM_MAX_BASELINE', dflt: 8, lo: 1, hi: 50 },
  maxSessionBytes: { env: 'SAGE_MEM_MAX_SESSION_BYTES', dflt: 60 * 1024, lo: 4096, hi: 512 * 1024 },
  staleDays: { env: 'SAGE_MEM_STALE_DAYS', dflt: 1, lo: 0, hi: 365 },
}

/** 面板设置的落点：状态根下（与 autodream 的配置、台账同级）。 */
const SETTINGS_FILE = join(STATE_ROOT, 'settings.json')
const RESERVED_FILE = join(STATE_ROOT, 'reserved.json')

/**
 * `writeRaw` 的体积上限（4 MB）。
 *
 * ⚠️ **故意不复用 `MAX_FILE_BYTES`（512 KB）**：保留名里就有 `session-log.md` 这种追加型
 * 流水，它天然长得比单条记忆大得多（实测已 > 512 KB）。沿用小上限 = 用户永远存不回去。
 */
const MAX_RAW_BYTES = 4 * 1024 * 1024

/** 整数收敛（与 config.js 的 envInt 同一套语义）：非有限数回落默认，越界夹到边界。 */
const clampInt = (v, spec) => (Number.isFinite(v) ? Math.max(spec.lo, Math.min(spec.hi, Math.round(v))) : spec.dflt)

/** 读 `<状态根>/settings.json`；缺失、坏 JSON、不是对象都当「没设置」。 */
async function readSettingsFile() {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 待生效的 5 项上限：`settings.json` > 环境变量 > 内置默认。 */
function pendingLimits(fileObj) {
  const out = {}
  const saved = fileObj?.limits && typeof fileObj.limits === 'object' ? fileObj.limits : {}
  for (const [key, spec] of Object.entries(LIMIT_SPECS)) {
    const fromFile = Number(saved[key])
    if (Number.isFinite(fromFile)) {
      out[key] = clampInt(fromFile, spec)
      continue
    }
    const raw = process.env[spec.env]
    out[key] = clampInt(raw === undefined || raw === '' ? NaN : Number(raw), spec)
  }
  return out
}

/** 读 `<状态根>/reserved.json`（用户声明的保护名单）。**保留原始大小写**，好让 get 读回一致。 */
async function readReservedFile() {
  try {
    const arr = JSON.parse(await readFile(RESERVED_FILE, 'utf8'))
    if (!Array.isArray(arr)) return []
    return arr
      .map((s) => String(s).trim())
      .filter((s) => s.endsWith('.md') && !s.includes('/') && !s.includes('\\') && !s.startsWith('..'))
  } catch {
    return []
  }
}

/**
 * 原样读写用的名字校验：只要求「单段、`.md`」。
 *
 * ⚠️ **故意不走 `safeName`**：那个函数把 `MEMORY.md` / `session-log.md` 当非记忆条目排除，
 * 而它们恰恰是 `readRaw` / `writeRaw` 的目标。这里只防路径成分与扩展名。
 */
function rawName(raw) {
  const s = typeof raw === 'string' ? raw : ''
  if (!s || basename(s) !== s) return null
  return /\.md$/i.test(s) ? s : null
}

/** autodream 的实际配置（缺文件/坏文件回落默认值）—— 面板要显示真实策略，不能显示想象。 */
async function autodreamConfigSnapshot() {
  const parsed = await readJson(join(STATE_ROOT, 'autodream.json'))
  return { ...DEFAULT_CONFIG, ...(parsed?.config ?? {}) }
}

/**
 * 手动 @Remote marker 注册（Node 24 不解析装饰器语法，手写 decorator context）。
 */
function markRemote(cls, method, exportName) {
  const instance = Object.create(cls.prototype)
  Remote(exportName)(undefined, {
    kind: 'method',
    name: method,
    private: false,
    static: false,
    addInitializer(fn) {
      fn.call(instance)
    },
  })
}

export class MemoryGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'memory')
    // 一并挂载星图 remote（同一记忆目录，纯只读）—— starmap.* 服务
    new StarmapGateway(ctx)

    // autodream（夜间记忆整理）：引擎 + remote 面 + 自动触发的定时器。
    //
    // 整个包在 try 里：autodream 起不来（比如 timer 服务缺失、状态目录没权限）
    // 不该把 sage-mem 最核心的那件事——「记忆按问题注入」——一起拖死。
    // 这是本插件唯一一处「降级而不是失败」的设计，理由就在这里。
    try {
      const engine = new AutodreamEngine(ctx, {
        memoryDir: MEMORY_DIR,
        sessionsRoot: SESSIONS_ROOT,
        reservedFiles: [...RESERVED_FILES],
      })
      new AutodreamGateway(ctx, engine)
      engine.start()
      // 卸载时把定时器与锁收干净。effect 拿不到就交给 unref 兜底（不阻止进程退出）。
      if (typeof ctx.effect === 'function') ctx.effect(() => () => engine.dispose())
    } catch (err) {
      warnLog(ctx, `autodream 初始化失败（记忆本体不受影响）：${err?.message ?? err}`)
      // 异常路径额外打一行到 stderr：warnLog 走 ctx.logger，某些启动阶段它还没接上，
      // 而「autodream 静默不工作」正是最难查的那种故障（曾为此排查很久）。
      console.error('[sage-mem] autodream init failed:', err && err.stack ? err.stack : err)
    }

    // 同一轮对话里问题不变、注入内容也不变，但 DSH 每一步都会往 session 追加
    // 一条 context 消息——不去重的话同一份记忆会被反复追加，撑爆上下文。
    const recallCache = new Map()

    // 「本会话是否已注入过 baseline」——会话级状态，按 session id 记。
    //
    // 为什么不是消息条数：见下面 baseline 那段注释（恢复会话的历史消息早就在
    // session 里，条数永不为 0）。会话 id 在整场会话里稳定，与 assemble 时
    // 当前用户消息有没有落盘完全无关，所以新会话、恢复会话两种时序都成立。
    // 容量 64 与 recallCache 同理，只防长驻进程无限增长：要挤掉一个 id 得先有
    // 63 场别的会话开起来，那场老会话再被唤醒时最多是把同样的 baseline 再注入一次。
    const BASELINE_CACHE_MAX = 64
    const baselineInjected = new Set()

    // 「本会话已经注入掉多少字节」—— 会话级账本，按 session id 记。
    //
    // 为什么不扫会话记录去算：同一轮 assemble 出来的内容会被宿主合进**同一条**
    // user/message（运行时上下文、工作区指令、插件注入共用一条），按消息字节统计
    // 会把别人的内容算进本插件的账；按文本找标记又太脆。自己记账是确定性最高的。
    //
    // 为什么要连 messageCount 一起记：压缩 / 清空之后上下文里的记忆已经没了，而
    // session id 不变 —— 只按 id 记账会让「预算用满」变成永久状态，压缩之后再也
    // 注不进来。消息条数变小是压缩发生过的最直接信号，用它把账本归零。
    const INJECT_LEDGER_MAX = 64
    const injectLedger = new Map()

    // 按问题检索注入：system-prompt/assemble 是异步 waterfall，监听器可 await。
    // 从 agent.session 拿当前 user message，扫 memory 目录按摘要匹配选相关
    // 文件，读全文作为动态 context 段注入——让 agent 第一轮就「想起」。
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next()
      // session id 在 try 外先取好：catch 里也要能带上它（拿到什么带什么）。
      const sessionId = context?.agent?.session?.id ?? ''
      try {
        const agent = context?.agent
        const session = agent?.session
        if (!session) return assembled
        // DSH 0.1.7 起 Session 的历史读取接口在陆续调整（snapshotEvents / eventAt /
        // ownEvents 已弃用）。deriveMessages 在 0.1.7-rc.1 实测仍在且仍同步，但这三行
        // 不是白写的：方法一旦被改名或改成异步，老写法要么静默不注入、要么把 Promise
        // 当数组展开成空。宁可日志里响一声，也不要"记忆不注入但日志一字没有"。
        if (typeof session.deriveMessages !== 'function') {
          warnLog(ctx, 'session.deriveMessages() 不可用 —— 记忆召回已跳过（DSH session API 变了？）', sessionId)
          return assembled
        }
        const derived = session.deriveMessages()
        const messages = [...(derived && typeof derived.then === 'function' ? await derived : derived)]

        // 关键：DSH 0.1.5 把工具结果（source.kind === 'tool'）和注入内容
        // （source.kind === 'plugin'）也存成 role: 'user' 的消息。只按 role 取
        // 「最后一条」会取到 tool-result，extractText 得到空串，下面的长度检查
        // 直接返回——表现就是全程静默不注入。只有 source.kind === 'user' 是真人输入。
        const userMessages = messages.filter(m => m?.role === 'user' && m?.source?.kind === 'user')
        const text = extractText(userMessages[userMessages.length - 1]?.content)

        const files = await scanMemoryFiles(ctx, sessionId)
        const picked = []
        const seen = new Set()
        const take = (f) => {
          if (seen.has(f.file)) return
          seen.add(f.file)
          picked.push(f)
        }

        // baseline：每个会话注入一次，**不看消息条数**。
        //
        // 旧写法 `if (userMessages.length === 0)` 依赖一个真实存在的时序：assemble
        // 触发时当前这条用户消息还没写进 session。已在 DSH 0.1.7-rc.1 上核实为真 ——
        //   宿主从 pending 队列取走本轮输入
        //   组装 system prompt（本监听器在这里跑）
        //   之后才把这条 user 消息落进 session
        // 所以全新会话首步 pick 到 0 条 user message，分支命中。
        //
        // 但**恢复 / 续聊会话**的历史消息早就在 session 里，条数永远 ≥ 1 → 分支永不
        // 命中 → 永不注入。而「继续吧」这类短问题在 description 里找不到匹配、检索
        // 返回 0 条，baseline 恰恰是那时唯一的兜底。这是本会话级状态要修的东西。
        let baselineTaken = 0
        const baselineKey = session.id ? session.id : session
        if (!baselineInjected.has(baselineKey)) {
          selectBaseline(files)
            .forEach(f => {
              const before = picked.length
              take(f)
              if (picked.length > before) baselineTaken++
            })
          // 只有真取到才落标记：首步若正好撞上目录读不到（scanMemoryFiles 降级返回 []），
          // 整场会话就再也没机会补 baseline 了。宁可下一步重算一次。
          if (baselineTaken > 0) {
            baselineInjected.add(baselineKey)
            if (baselineInjected.size > BASELINE_CACHE_MAX) {
              baselineInjected.delete(baselineInjected.values().next().value)
            }
          }
        }

        // 检索签名只覆盖「检索出来的那批」，baseline 不再掺进这个签名。
        // 旧版两者共用 signature，首步签名一旦与后续某步相同，baseline 会连坐被吞；
        // 反过来，旧版把 baseline 文件名也算进签名，会让同一步的检索结果在下一步
        // 因签名变化而被重复注入。现在 baseline 由会话级标记保证只来一次，
        // 检索由这份签名保证同一问题不重复追加，两条线互不干扰。
        const relevant = text && text.length >= 2 ? selectRelevant(text, files) : []
        const signature = text + '\u0000' + relevant.map(f => f.file).join(',')
        if (recallCache.get(session.id) !== signature) {
          recallCache.set(session.id, signature)
          if (recallCache.size > 8) recallCache.delete(recallCache.keys().next().value)
          relevant.forEach(take)
        }

        if (picked.length === 0) {
          if (DEBUG_RECALL) debugRecall({ scanned: files.length, hits: relevant.length, scores: [], picked: [], injected: [], chars: 0, skippedByBudget: 0 })
          return assembled
        }

        // ── 单会话累计预算 ──
        // 账记在 session id 上；消息条数变小 = 压缩/清空发生过 → 账本归零（见上面
        // injectLedger 的注释）。picked 里 baseline 永远排在检索结果之前，所以预算
        // 不够时先被挤掉的是「更晚才想起来的」那些 —— baseline 有优先权。
        const ledgerKey = session.id || 'no-session-id'
        const prevLedger = injectLedger.get(ledgerKey)
        let usedBytes = prevLedger && messages.length >= prevLedger.messageCount ? prevLedger.bytes : 0
        const nowMs = Date.now()

        const parts = []
        const injectedFiles = []
        let skippedForBudget = 0
        for (const f of picked) {
          const body = f.content.length > MAX_CHARS_PER_FILE
            ? f.content.slice(0, MAX_CHARS_PER_FILE) + '\n…（截断）'
            : f.content
          const days = ageDays(f, nowMs)
          const stamp = days !== null && days >= STALE_DAYS ? `（保存于 ${days} 天前）` : ''
          const part = `### ${f.file}${stamp}\n${body}`
          const size = Buffer.byteLength(part, 'utf8')
          if (usedBytes + size > MAX_SESSION_BYTES) { skippedForBudget++; continue }
          usedBytes += size
          parts.push(part)
          injectedFiles.push(f.file)
        }

        // 进上下文的这些才算「被用过」—— 台账是自动归档阈值的唯一数据源，记错一步阈值就偏。
        // recordAccess 同步、绝不抛：台账的问题不许升级成注入失败。
        recordAccess(injectedFiles, nowMs)

        // 被预算挡掉了全部条目 —— 一个字都不注。本会话已经注进去的那批还在上下文里，
        // 每步再塞一条「预算已满」只是白花 token；真压缩过之后账本会自己归零。
        // 这条早退也要出声：一条都没注进去，正是最需要解释的那种情况。
        if (parts.length === 0) {
          if (DEBUG_RECALL) {
            debugRecall({
              scanned: files.length, hits: relevant.length,
              scores: relevant.map(f => [f.file, Number(f.score.toFixed(4))]),
              picked: picked.map(f => f.file), injected: [], chars: usedBytes, skippedByBudget: skippedForBudget,
            })
          }
          return assembled
        }

        injectLedger.set(ledgerKey, { bytes: usedBytes, messageCount: messages.length })
        if (injectLedger.size > INJECT_LEDGER_MAX) {
          injectLedger.delete(injectLedger.keys().next().value)
        }

        // 状态行：让「注了几条、花了多少、被挡掉几条」在上下文里可见 ——
        // 「某条记忆没被注入」是最难查的一类故障，这里留一个可读的出口。
        const status = `（本次注入 ${parts.length} 条；本会话累计 ${Math.round(usedBytes / 1024)} KB` +
          ` / 上限 ${Math.round(MAX_SESSION_BYTES / 1024)} KB` +
          (skippedForBudget > 0 ? `；因预算省略 ${skippedForBudget} 条，需要时直接用文件工具读 ${MEMORY_DIR}` : '') +
          '）'

        if (DEBUG_RECALL) {
          debugRecall({
            scanned: files.length,
            hits: relevant.length,
            scores: relevant.map(f => [f.file, Number(f.score.toFixed(4))]),
            picked: picked.map(f => f.file),
            injected: injectedFiles,
            chars: usedBytes,
            skippedByBudget: skippedForBudget,
          })
        }

        return {
          ...assembled,
          contexts: [...(assembled.contexts ?? []), {
            name: 'sage-mem:recall',
            order: 1000,
            text: `以下是与你当前问题相关的历史记忆（文件式，来自 ${MEMORY_DIR}）：\n\n` +
              `${RECALL_DISCIPLINE}\n\n${parts.join('\n\n')}\n\n${status}`,
          }],
        }
      } catch (err) {
        // 这是整条注入链的外壳。裸吞的代价就是 :174-193 记的那个坑：权限错、编码坏、
        // frontmatter 正则哪天不匹配，表现都是「插件在、但记忆不再注入」，日志一字没有。
        // 现在只降级（返回未注入的 assembly），但一定留痕。
        warnLog(ctx, `recall injection failed: ${err?.message ?? err}`, sessionId)
        return assembled
      }
    })
  }

  /** 列出 memory 目录全部记忆文件（文件名 + 类型 + 描述 + 大小 + 自定义标签）。 */
  async listFiles() {
    const files = await scanMemoryFiles(this.ctx, '')
    return files.map(f => {
      const meta = parseFrontmatter(f.content)
      return {
        file: f.file,
        type: meta.type || 'reference',
        description: meta.description || '',
        size: f.content.length,
        tags: meta.tags,
      }
    })
  }

  /** 读单个记忆文件全文。 */
  async readFile(name) {
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    const content = await readFile(join(MEMORY_DIR, safe), 'utf8')
    return { name: safe, content }
  }

  /**
   * 写（新增或覆盖）单个记忆文件。
   *
   * 三道闸：保留名不可写、内容必须是字符串、体积有上限；落盘走原子写。
   * 拒绝一律返回 { ok: false, error }（不是抛异常）——设置页的调用方按 ok 判定。
   */
  async writeFile(name, content) {
    // 保留名判定放在最前面、且以 nameKey 归一：'memory.md' / 'MEMORY.MD' /
    // 'Session-Log.md' 在 NTFS 上都是同一个文件，必须一律走 { ok: false } 这条路
    // （设置页按 ok 判定，见 client.js 的 submit()）。
    if (isReserved(name)) {
      return { ok: false, file: nameKey(name), error: `sage-mem: reserved file, edit it with the file tools: ${nameKey(name)}` }
    }
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    // 不加这一层，传个对象进来会被 String() 写成 "[object Object]" 还回 { ok: true }，
    // 原文件就此被一行垃圾顶掉，且没有任何错误信号。
    if (typeof content !== 'string') {
      return { ok: false, file: safe, error: `sage-mem: content must be a string, got ${typeof content}` }
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_FILE_BYTES) {
      return { ok: false, file: safe, error: `sage-mem: content too large (${bytes} bytes > ${MAX_FILE_BYTES})` }
    }
    await writeFileAtomic(join(MEMORY_DIR, safe), content)
    return { ok: true, file: safe }
  }

  /** 删除单个记忆文件：保留名一律拒绝（unlink 不可逆）。判定同 writeFile。 */
  async deleteFile(name) {
    if (isReserved(name)) {
      return { ok: false, error: `sage-mem: reserved file, refusing to delete: ${nameKey(name)}` }
    }
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    await unlink(join(MEMORY_DIR, safe))
    return { ok: true }
  }

  /**
   * 归档一条记忆：把文件移进 `memory/archive/`（**不删**），并在 frontmatter 里留下
   * `archived_at` / `archived_reason`。
   *
   * 语义是「静默失效且可回退」：归档区不参与检索（见 memory/scan.js 的 scanMemoryFiles），
   * 但列表与星图都看得见它，也能一键恢复 —— 所以这里只是移动 + 打标，绝不 unlink。
   *
   * 真正的实现在 `memory/archive.js`：autodream 的 `archive_memory` 工具与自动归档策略
   * 走的是同一份 —— 三条入口只许有一种行为。
   *
   * 拒绝一律返回 `{ ok: false, error }`（不是抛）：面板按 ok 判定，抛出去只会变成
   * 一句没有上下文的报错。
   */
  async archive(name, reason) {
    const res = await archiveMemory(MEMORY_DIR, name, reason)
    return res.ok ? { ok: true, file: res.file } : { ok: false, error: res.error }
  }

  /**
   * 从归档区恢复一条记忆：移回根目录，并去掉 `archived_at` / `archived_reason` 两行。
   * 同样委托给 `memory/archive.js`（判断与拒绝矩阵只有一份）。
   */
  async restore(name) {
    const res = await restoreMemory(MEMORY_DIR, name)
    return res.ok ? { ok: true, file: res.file } : { ok: false, error: res.error }
  }

  /**
   * 列出归档区的全部记忆（面板的「已归档」区）。
   *
   * 与 `listFiles()` 分开、形状也不同：`listFiles` 只列活动记忆、多一个字段都会破坏
   * 界面与断言依赖的形状；归档条目额外带 `archivedAt` / `archivedReason`。
   * 旧版 autodream 工具直接移文件、不写留痕，所以这两个字段可能是空串。
   */
  async listArchived() {
    const files = await scanArchived(this.ctx)
    const out = files.map(f => {
      const meta = parseFrontmatter(f.content)
      const archived = readArchivedMeta(f.content)
      return {
        file: f.name,
        type: meta.type || 'reference',
        description: meta.description || '',
        size: f.content.length,
        tags: meta.tags,
        archivedAt: archived.archivedAt,
        archivedReason: archived.archivedReason,
      }
    })
    return { count: out.length, files: out }
  }

  /**
   * 读一份**已归档**记忆的全文。
   *
   * 归档不是删除，正文就该和活跃记忆一样能看能改（文歌子的要求）。名字仍然只走
   * `safeName`：调用方永远不许自己拼路径，归档区也只认 `memory/archive/` 这一层。
   */
  async readArchived(name) {
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    const full = join(MEMORY_ARCHIVE_DIR, safe)
    const info = await stat(full).catch(() => null)
    // 找不到就抛：与 readFile 一致。静默返回空串会让面板显示一个「空的记忆」，
    // 而用户改完一存 —— 就把一条真实内容顶掉了。
    if (!info?.isFile()) throw new Error(`sage-mem: archived file not found: ${safe}`)
    const content = await readFile(full, 'utf8')
    return { name: safe, content }
  }

  /**
   * 写一份**已归档**记忆的正文（覆盖整份文件，形状与 `writeFile` 一致）。
   *
   * 三道闸照抄 writeFile：名字先过 safeName、内容必须是字符串、体积上限，最后原子写。
   * 额外一条：**盘上那份的归档留痕（`archived_at` / `archived_reason`）不许因为改正文而丢**。
   * 调用方若交回一份连留痕都没有的内容（「重建 frontmatter」式编辑器就是这样），
   * 这里按盘上原来的值补回去 —— 归档凭据不该依赖调用方是否体贴。
   */
  async writeArchived(name, content) {
    if (isReserved(name)) {
      return { ok: false, file: nameKey(name), error: `sage-mem: reserved file, edit it with the file tools: ${nameKey(name)}` }
    }
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    const full = join(MEMORY_ARCHIVE_DIR, safe)
    const info = await stat(full).catch(() => null)
    // 只改归档区里**已经存在**的文件：这条 remote 不是「把任意文件写进归档区」的后门。
    if (!info?.isFile()) return { ok: false, file: safe, error: `sage-mem: archived file not found: ${safe}` }
    if (typeof content !== 'string') {
      return { ok: false, file: safe, error: `sage-mem: content must be a string, got ${typeof content}` }
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_FILE_BYTES) {
      return { ok: false, file: safe, error: `sage-mem: content too large (${bytes} bytes > ${MAX_FILE_BYTES})` }
    }
    const given = readArchivedMeta(content)
    let toWrite = content
    if (!given.archivedAt && !given.archivedReason) {
      const onDisk = readArchivedMeta(await readFile(full, 'utf8'))
      if (onDisk.archivedAt || onDisk.archivedReason) {
        toWrite = addArchiveMeta(content, onDisk.archivedReason, onDisk.archivedAt)
      }
    }
    await writeFileAtomic(full, toWrite)
    return { ok: true, file: safe }
  }

  /**
   * 记忆目录体检：结构化审计结果。
   *
   * **直接透出 `auditMemoryDir` 的返回**，不另写一套检查 —— 面板上的「问题」与 autodream
   * 报告里的必须是同一份判断，否则用户与模型看到的健康状况会互相打架。只读。
   */
  async audit() {
    return auditMemoryDir(MEMORY_DIR)
  }

  /**
   * 自动归档候选 + 当前策略与阈值（面板「执行归档」前先看清单）。
   *
   * 复用 `memory/access.js` 的台账与候选计算，与 autodream 引擎跑的是同一份逻辑。
   * 先强制 flush 台账：面板看到的候选不能比引擎少（内存里还压着的那批注入必须算进去）。
   */
  async archiveCandidates() {
    await flushAccess(MEMORY_DIR)
    const [ledger, files] = await Promise.all([readAccessLedger(), scanMemoryFiles(this.ctx, '')])
    const cfg = await autodreamConfigSnapshot()
    const thresholds = {
      project: cfg.archiveAfterDaysProject,
      reference: cfg.archiveAfterDaysReference,
      user: cfg.archiveAfterDaysUser,
    }
    const candidates = pickArchiveCandidates(files, ledger, { thresholds })
    return { count: candidates.length, candidates, autoArchive: cfg.autoArchive, thresholds }
  }

  /**
   * 面板上的注入设置（5 项上限 + 保留名保护名单）。
   *
   * ⚠️ **这 5 个常量是模块加载时读的**：面板改完要**重启 DSH** 才生效。所以这里同时给出
   * 「当前生效值」`limits` 与「待生效值」`pendingLimits`，外加 `restartRequired` ——
   * 界面才能诚实地说「改好了，重启后生效」，而不是让用户以为立刻生效又看不到变化。
   */
  async getSettings() {
    const file = await readSettingsFile()
    const limits = {
      maxResults: MAX_RESULTS,
      maxChars: MAX_CHARS_PER_FILE,
      maxBaseline: MAX_BASELINE,
      maxSessionBytes: MAX_SESSION_BYTES,
      staleDays: STALE_DAYS,
    }
    const pending = pendingLimits(file)
    const reservedExtra = await readReservedFile()
    // 模块加载时那份「用户声明的保护名」（RESERVED_FILES 里抠掉两个内置名）
    const activeExtra = [...RESERVED_FILES].filter((n) => n !== 'memory.md' && n !== 'session-log.md')
    const norm = (list) => JSON.stringify([...list].map((s) => String(s).toLowerCase()).sort())
    const restartRequired =
      JSON.stringify(limits) !== JSON.stringify(pending) || norm(activeExtra) !== norm(reservedExtra)
    return {
      limits,
      pendingLimits: pending,
      restartRequired,
      // 生效的保护名单（含两个内置名）+ 用户声明的那部分原文（面板编辑的是后者）
      reserved: [...new Set(['memory.md', 'session-log.md', ...reservedExtra.map((s) => s.toLowerCase())])],
      reservedExtra,
    }
  }

  /**
   * 改设置：5 项上限落 `<状态根>/settings.json`，保护名单落 `<状态根>/reserved.json`。
   *
   * 校验**先全部过一遍再写盘**：任何一个值非法就整体 `{ ok:false }`，绝不写半份。
   * 越界不是「夹到边界」（那是环境变量的宽容语义）—— 面板上手输的数字越界是笔误，
   * 静默改成别的值比报错更让人困惑。
   */
  async setSettings(patch) {
    const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
    const limitsPatch = p.limits && typeof p.limits === 'object' && !Array.isArray(p.limits) ? p.limits : null
    const nextLimits = {}
    if (limitsPatch) {
      for (const [key, value] of Object.entries(limitsPatch)) {
        const spec = LIMIT_SPECS[key]
        if (!spec) return { ok: false, error: `sage-mem: unknown setting: ${key}` }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return { ok: false, error: `sage-mem: ${key} must be a number, got ${typeof value}` }
        }
        const rounded = Math.round(value)
        if (rounded < spec.lo || rounded > spec.hi) {
          return { ok: false, error: `sage-mem: ${key} must be an integer in [${spec.lo}, ${spec.hi}], got ${value}` }
        }
        nextLimits[key] = rounded
      }
    }
    let nextReserved = null
    if (p.reserved !== undefined) {
      if (!Array.isArray(p.reserved)) return { ok: false, error: 'sage-mem: reserved must be an array of file names' }
      const cleaned = []
      for (const item of p.reserved) {
        const s = String(item ?? '').trim()
        if (!s || !s.endsWith('.md') || s.includes('/') || s.includes('\\') || s.startsWith('..')) {
          return { ok: false, error: `sage-mem: invalid reserved file name: ${String(item)}` }
        }
        if (!cleaned.includes(s)) cleaned.push(s)
      }
      nextReserved = cleaned
    }
    if (!limitsPatch && nextReserved === null) return { ok: false, error: 'sage-mem: empty patch' }

    await mkdir(STATE_ROOT, { recursive: true })
    if (limitsPatch) {
      const current = await readSettingsFile()
      const merged = { ...(current?.limits ?? {}), ...nextLimits }
      await writeFileAtomic(SETTINGS_FILE, JSON.stringify({ limits: merged, updatedAt: Date.now() }, null, 2))
    }
    if (nextReserved !== null) {
      await writeFileAtomic(RESERVED_FILE, `${JSON.stringify(nextReserved, null, 2)}\n`)
    }
    // 写盘即提示重启：这些值在模块加载时就固化了，不重启它一定还没生效。
    return { ok: true, settings: await this.getSettings(), restartRequired: true }
  }

  /**
   * 原样读保留名文件（`MEMORY.md` / `session-log.md` / 用户声明的保护名）。
   *
   * **不解析、不重建**：索引与流水是纯文本，面板拿到什么就显示什么。
   */
  async readRaw(name) {
    if (!isReserved(name)) {
      return { ok: false, error: `sage-mem: ${String(name)} is not a reserved file; normal memories use the memory form or readFile` }
    }
    const safe = rawName(name)
    if (!safe) return { ok: false, error: `sage-mem: invalid file name: ${String(name)}` }
    // 读不到就抛（与 readFile 一致）：静默返回空串会让面板显示一份「空的索引」，
    // 用户一存就把真索引顶掉。
    const content = await readFile(join(MEMORY_DIR, safe), 'utf8')
    return { name: safe, content }
  }

  /**
   * 原样写保留名文件：**逐字节照写，绝不重建 frontmatter**。
   *
   * 这就是 2026-09-25 那次 P0 数据丢失事故（表单重建 frontmatter 把 baseline /
   * node_type / originSessionId 全抹掉）的解药：索引与流水只许原样进出。
   */
  async writeRaw(name, content) {
    if (!isReserved(name)) {
      return { ok: false, error: `sage-mem: ${String(name)} is not a reserved file; normal memories use the memory form or writeFile` }
    }
    const safe = rawName(name)
    if (!safe) return { ok: false, error: `sage-mem: invalid file name: ${String(name)}` }
    if (typeof content !== 'string') {
      return { ok: false, file: safe, error: `sage-mem: content must be a string, got ${typeof content}` }
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    // ⚠️ 与 writeFile 的 512 KB 上限**不是同一个数**：流水天然更大（见 MAX_RAW_BYTES 的注释）。
    if (bytes > MAX_RAW_BYTES) {
      return {
        ok: false,
        file: safe,
        error: `sage-mem: content too large (${bytes} bytes > ${MAX_RAW_BYTES / (1024 * 1024)} MB raw limit)`,
      }
    }
    await writeFileAtomic(join(MEMORY_DIR, safe), content)
    return { ok: true, file: safe }
  }
}

markRemote(MemoryGateway, 'listFiles', 'listFiles')
markRemote(MemoryGateway, 'readFile', 'readFile')
markRemote(MemoryGateway, 'writeFile', 'writeFile')
markRemote(MemoryGateway, 'deleteFile', 'deleteFile')
markRemote(MemoryGateway, 'archive', 'archive')
markRemote(MemoryGateway, 'restore', 'restore')
markRemote(MemoryGateway, 'listArchived', 'listArchived')
markRemote(MemoryGateway, 'readArchived', 'readArchived')
markRemote(MemoryGateway, 'writeArchived', 'writeArchived')
markRemote(MemoryGateway, 'audit', 'audit')
markRemote(MemoryGateway, 'archiveCandidates', 'archiveCandidates')
markRemote(MemoryGateway, 'getSettings', 'getSettings')
markRemote(MemoryGateway, 'setSettings', 'setSettings')
markRemote(MemoryGateway, 'readRaw', 'readRaw')
markRemote(MemoryGateway, 'writeRaw', 'writeRaw')

/**
 * 记忆星图（宿主侧）—— 只读扫描记忆目录，把每条记忆解析成一颗「星」。
 * 通过 TypertRemoteService 暴露两个 remote 方法给界面侧：
 *   - starmap.listStars(includeArchived)  全部星（元数据，不含正文）
 *   - starmap.readFile(n)                 单条记忆全文（文件名白名单校验）
 */
export class StarmapGateway extends TypertRemoteService {
  constructor(ctx) { super(ctx, 'starmap') }

  /**
   * @param {boolean} [includeArchived] — 连归档区一起给（默认 false：与从前一样只看活着的星）
   */
  async listStars(includeArchived) {
    const files = await scanStars(this.ctx, includeArchived === true)
    const stars = files.map(f => {
      const meta = parseFrontmatter(f.content)
      const title = extractTitle(f.content)
      const star = {
        file: f.name,
        kind: meta.type || 'special',
        title: title || meta.name || (meta.description ? meta.description.slice(0, 24) : f.name.replace(/\.md$/, '')),
        desc: meta.description || '',
        bytes: f.bytes,
        mtimeMs: f.mtimeMs,
        archived: f.archived === true,
      }
      // 归档留痕只对归档星有意义；活动星连键都不出现（保持与旧形状逐字段相同）。
      if (star.archived) {
        const a = readArchivedMeta(f.content)
        star.archivedAt = a.archivedAt
        star.archivedReason = a.archivedReason
      }
      return star
    })
    return { count: stars.length, stars }
  }

  async readFile(name) {
    // 与 MemoryGateway.readFile 收敛到同一个 safeName：它现在同时排除
    // MEMORY.md 与 session-log.md，且大小写不敏感。
    const safe = safeName(name)
    if (!safe) throw new Error('sage-starmap: invalid file name')
    const content = await readFile(join(MEMORY_DIR, safe), 'utf8')
    return { name: safe, content }
  }
}

markRemote(StarmapGateway, 'listStars', 'listStars')
markRemote(StarmapGateway, 'readFile', 'readFile')

/**
 * autodream 的 remote 面：设置页「自动做梦」标签页唯一的数据通道。
 *
 * 这一层刻意很薄——全部判断（门控、模式、白名单）都在 AutodreamEngine 里，
 * 这里只负责把 ctx 里的引擎接到 typert 的调用表上。想看行为就读 autodream.js。
 */
export class AutodreamGateway extends TypertRemoteService {
  constructor(ctx, engine) {
    super(ctx, 'autodream')
    this.engine = engine
  }

  /** 配置 + 状态 + 路径 + 默认值（设置面板一次拿全）。 */
  async getConfig() {
    return this.engine.getConfig()
  }

  /** 改配置（补丁式）。 */
  async setConfig(patch) {
    return this.engine.setConfig(patch)
  }

  /** 轮询用：是否在跑、跑到哪一步、上次结果。 */
  async status() {
    return this.engine.status()
  }

  /**
   * 手动跑一趟。设置页的「立即整理」走这里。
   *
   * force 默认为 true —— 人点了按钮，就不该再被「还没到 24 小时」挡回来。
   *
   * **故意不 await**：一趟 autodream 可能跑几分钟（多轮模型调用 + 工具），
   * remote 调用挂在那儿等会直接撞上前端超时，界面上表现为「点了没反应」。
   * 所以这里只负责点火，进度与结果都从 status() 轮询 —— run() 自己会把
   * lastResult 落盘，界面刷新几次就能看到。
   */
  async runNow(opts) {
    if (this.engine.running) return { ok: false, error: '已有一趟 autodream 在跑' }
    const reason = typeof opts?.reason === 'string' && opts.reason.trim() ? opts.reason.trim().slice(0, 120) : '设置页手动触发'
    this.engine.run({ reason, force: true }).catch(() => {})
    return { ok: true }
  }

  /** 历史报告列表。 */
  async listReports() {
    return this.engine.listReports()
  }

  /** 读一份报告全文。 */
  async readReport(name) {
    return this.engine.readReport(name)
  }

  /** 已有快照（面板显示「可回退到哪一份」）。 */
  async listSnapshots() {
    return this.engine.listSnapshots()
  }

  /** 运行记录列表（面板的「整理声明」区）。 */
  async listRuns(opts) {
    return this.engine.listRuns(opts?.limit)
  }

  /** 读某次运行的完整整理声明（人读 markdown + 机读 manifest）。 */
  async readDeclaration(opts) {
    return this.engine.readDeclaration(opts?.runId)
  }

  /**
   * 回滚到某个回滚点。
   *
   * 与 runNow 相反，这里**必须 await**：回滚是几十毫秒级的文件操作，
   * 而「点完按钮不知道到底滚没滚」正是回滚这种动作最不能接受的体验。
   */
  async rollback(opts) {
    return this.engine.rollback({ snapshotId: opts?.snapshotId, scope: opts?.scope })
  }

  /** 可选的整理模型路线（设置面板的模型下拉）。 */
  async listModels() {
    return this.engine.listModels()
  }
}

markRemote(AutodreamGateway, 'getConfig', 'getConfig')
markRemote(AutodreamGateway, 'setConfig', 'setConfig')
markRemote(AutodreamGateway, 'status', 'status')
markRemote(AutodreamGateway, 'runNow', 'runNow')
markRemote(AutodreamGateway, 'listReports', 'listReports')
markRemote(AutodreamGateway, 'readReport', 'readReport')
markRemote(AutodreamGateway, 'listSnapshots', 'listSnapshots')
markRemote(AutodreamGateway, 'listRuns', 'listRuns')
markRemote(AutodreamGateway, 'readDeclaration', 'readDeclaration')
markRemote(AutodreamGateway, 'rollback', 'rollback')
markRemote(AutodreamGateway, 'listModels', 'listModels')

export default MemoryGateway

/**
 * **仅供测试**的只读出口。
 *
 * 检索这条链（frontmatter 解析 → 双字打分 → 名额裁剪）没有任何对外可见的调用面：
 * 想验证「写了 aliases 之后换个说法能不能命中」，否则只能起一个真的 DSH 端到端跑一遍。
 * 把这些纯函数露出来是为了能写断言，**不是给外部用的 API**，别依赖。
 */
export const __testables = {
  bigrams,
  score,
  parseFrontmatter,
  parseAliases,
  parseBaselinePriority,
  parseBaseline,
  parseTags,
  ageDays,
  selectRelevant,
  selectBaseline,
  limits: { MAX_RESULTS, MAX_CHARS_PER_FILE, MAX_BASELINE, MAX_SESSION_BYTES, STALE_DAYS },
  recallDiscipline: RECALL_DISCIPLINE,
}

