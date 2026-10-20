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
import { CONTENT_BUDGET, MAX_BASELINE, MAX_CHARS_PER_FILE, MAX_FILE_BYTES, MAX_RESULTS, MAX_SESSION_BYTES, MEMORY_DIR, RECALL_DISCIPLINE, RESERVED_FILES, SESSIONS_ROOT, STALE_DAYS, STATE_ROOT, STATUS_RESERVE } from './memory/config.js'
import { parseAliases, parseBaseline, parseBaselinePriority, parseFrontmatter, parseTags } from './memory/frontmatter.js'
import { isReserved, nameKey, safeName } from './memory/naming.js'
import { ageDays, bigrams, extractText, score, selectBaseline, selectRelevant } from './memory/retrieval.js'
import { MEMORY_ARCHIVE_DIR, addArchiveMeta, extractTitle, inspectDir, inspectMemoryEntry, readArchivedMeta, scanArchived, scanMemoryFiles, scanStars, shadowsReserved } from './memory/scan.js'
import { rankChunks } from './memory/search.js'
import { renderStatusCard } from './memory/status.js'
import { detectIntent } from './memory/intent.js'
import { decideDelivery } from './memory/deliver.js'
import { classifyToolExecution, accessEventKey, createDeduper } from './memory/observe.js'
import { readCheckpoint } from './memory/checkpoint.js'
import { memoryPathOf } from './memory/paths.js'
import { decideWriteIntent, decideEditGuard } from './memory/write-gate.js'
import { createMemoryTools } from './tools/memory-tools.js'
import { archiveMemory, deleteArchivedMemory, restoreMemory } from './memory/archive.js'
import { flushAccess, pickArchiveCandidates, readAccessLedger, recordAccess, recordRead } from './memory/access.js'
import { warnLog, writeFileAtomic } from './memory/util.js'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { checkUpdate as checkUpdateImpl } from './update.js'
import { readLockSet, setLocked as setLockedImpl } from './memory/lock.js'

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
 * 按文件去重，保留每个文件**首次**（也就是得分最高）出现的那条正文命中。
 *
 * 正文检索是段落粒度的，同一份文件可能返回多个段落。注入链要的是「这份文件要不要端上来」，
 * 所以在这里收成文件粒度 —— 而**不是**把同一文件的多个段落一起端上去：那正是
 * `retrieval.js` 当初从「全文匹配」退回「只比摘要」要躲开的病（长文靠段数多占满候选位）。
 */
function dedupeByFile(hits) {
  const seen = new Set()
  const out = []
  for (const h of hits) {
    if (seen.has(h.file)) continue
    seen.add(h.file)
    out.push(h)
  }
  return out
}

/**
 * 会话级注入状态：**一处持有、一处提交**。
 *
 * 为什么必须集中：原先这是三个散落的容器（检索签名 `recallCache`、baseline 标记
 * `baselineInjected`、注入账本 `injectLedger`），而代次变化本该让它们**同时**归零 ——
 * 旧代码把重置写在去重**之后**，于是同一问题在压缩后仍被上一代的检索签名挡住，
 * 记忆再也回不来（外部复审 R03）。集中之后，顺序是能被读出来的：
 *
 *     begin() 处理代次变化 → 调用方算正文与控制提示 → commit() 一次写回
 *
 * 为什么提交放最后：中途抛错时状态不该前进 —— 没注进去的东西不能记成「已注过」，
 * 否则一次失败会把这条记忆永久挡在门外。唯一的例外是代次变化：那是**已经发生的事实**
 * （上下文真的被压缩了），必须在算任何东西之前生效，否则这一步会拿着上一代的账做判断。
 *
 * ⚠️ 诚实边界：压缩信号是「消息条数下降」这条启发式，它**覆盖不了条数不降的压缩**
 * （宿主原地改写历史，或截断后又在同一步补足条数）。那种情况下这里看不出代次变化，
 * 记忆仍会被去重挡住。要真正解决得等宿主给出可比的上下文代次标识（目前没有）。
 */
function createSessionInjectState(maxSessions = 64) {
  const sessions = new Map()
  const fresh = () => ({
    signature: null,      // 已注入过的检索签名（问题 + 命中文件集）
    contentBytes: 0,      // 本代正文累计字节
    cardBytes: 0,         // 本代状态卡累计字节（与正文分账，见 config.js）
    cardSig: '',          // 本代已发过的那张卡（含检查点句柄的合成文本）
    gapCard: '',          // 本代渲染过的缺口卡正文（签名没变时沿用，避免换个数字重发）
    messageCount: -1,     // 上一次见效时的消息条数（压缩判据）
    baselineDone: false,  // 本代是否已经给过 baseline
  })
  return {
    /**
     * 处理代次变化，取回本会话这一代的起点。**必须在算正文与控制提示之前调用。**
     * 返回值是一份快照 —— 调用方只读，写回统一走 `commit()`。
     */
    begin(key, messageCount) {
      const prev = sessions.get(key)
      const generationChanged = !!prev && messageCount < prev.messageCount
      // 条数下降 → 四样东西一起归零。少清任何一样都会留下一个「上一代的真相」：
      // 字节账残留 → 新内容注不进来；baseline 残留 → 它再也不出现；
      // 卡签名残留 → 恢复入口永久失效。
      if (generationChanged) sessions.set(key, { ...fresh(), messageCount })
      const cur = sessions.get(key) ?? fresh()
      return { ...cur, generationChanged }
    },
    /** 一次写回。只防长驻进程无限增长：被挤掉的老会话下次醒来至多把同一批记忆再注一次。 */
    commit(key, next) {
      sessions.set(key, { ...next })
      // FIFO 而不是 LRU：Map 重写已存在的键不会挪动位置，与旧行为一致。
      if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value)
    },
  }
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
  // `:` 是 NTFS 交替数据流的分隔符：`MEMORY.md:evil.md` 能过扩展名判据，落盘却是写到
  // 索引的隐藏流上（`readdir` 看不见）。与 `safeName` 同一条理由，这里也要拒。
  if (s.includes(':')) return null
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

    // ── 检索工具：`search_memory` / `read_memory` ──
    //
    // 工具是否注册成功。拿不到宿主的 `tools` 服务时为 false —— 状态卡据此换文案：
    // 有工具就教它「用 search_memory 搜」，没有就退回「直接读记忆目录」。
    //
    // 为什么是个可变量：注册是**异步就绪**的（`ctx.inject` 要等依赖服务上线），而注入链
    // 每步都跑 —— 前几步可能还没就绪、后几步才就绪，这是正常的。声明必须在这一块之前。
    let toolsReady = false
    //
    // ⚠️ **用 `ctx.inject` 挂子 fiber，绝不给本类加 `static inject = ['tools']`。**
    // 理由（`docs/decisions.md` D5，有官方依据）：`inject` 是**硬依赖** —— 声明了它的插件
    // 要等依赖就绪才会被加载。宿主没有 `tools` 服务时，整个 sage-mem 会一直待机，
    // **记忆注入跟着一起消失**。而工具只是锦上添花，不值得拿核心功能去换。
    // `ctx.inject` 只让这个子回调等依赖就绪，主插件照常工作；依赖永远不来就只有它不生效。
    //
    // 另一条实测事实（`docs/host-facts.md`）：不声明 inject 时 `ctx.get('tools')` 只给
    // `undefined`（那一刻服务还没被提供，而插件不会重跑），所以「先探测再注册」在这里
    // 是行不通的 —— 必须走 `ctx.inject`。
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['tools'], (inner) => {
          try {
            const { searchMemory, readMemory } = createMemoryTools(ctx)
            inner.tools.register(searchMemory)
            inner.tools.register(readMemory)
            toolsReady = true
          } catch (err) {
            // 注册失败 ≠ 注入失败。出声一次，然后什么也不做。
            warnLog(ctx, `检索工具注册失败（记忆注入不受影响）：${err?.message ?? err}`)
          }
        })
      }
    } catch (err) {
      warnLog(ctx, `检索工具挂载失败（记忆注入不受影响）：${err?.message ?? err}`)
    }

    // ── 观测：模型自己翻了记忆目录 ──
    //
    // 宿主的 `tools/result` 把**每一次**工具调用的 `exec`（含 name / arguments）交给我们，
    // 于是「模型用内置 read/grep 读了哪份记忆」第一次变得可观测 —— 此前台账只记得下
    // 「插件注入了什么」，记不下「模型主动翻了什么」。
    //
    // 三条纪律：
    //   1. **只记能可靠判定的**（`observe.js` 认 read/grep/glob 的路径参数；`pwsh` 一律不认，
    //      那是**已知观测盲区** —— 不许把「看不到」说成「没读」）。
    //   2. **按 session × 文件去重**：翻页（read 的 offset 不同）不刷计数，那是同一个动作。
    //   3. **失败绝不影响任何东西**：观测是副产品，它的问题不许冒泡到工具调用链上。
    const observedReads = createDeduper()
    try {
      ctx.on('tools/result', (exec) => {
        try {
          const cls = classifyToolExecution(exec?.name, exec?.arguments, MEMORY_DIR)
          if (cls.kind !== 'active_read' || !cls.file) return
          const key = accessEventKey({
            sessionId: exec?.agent?.id ?? '',
            file: cls.file,
            // revision 要读盘才算得出，这里拿不到 —— 所以去重粒度是「session × 文件」。
            // 写明这条口径，免得以后有人以为它按内容去重。
            revision: '',
            kind: cls.kind,
          })
          if (!key || !observedReads.shouldCount(key)) return
          recordRead(cls.file, '')
        } catch { /* 观测失败静默：它不该有任何存在感 */ }
      })
    } catch { /* 老宿主没有这个事件：不影响注入 */ }

    // ── 写入门：给记忆目录的写入补上版本守卫 ──
    //
    // 实测（`scripts/events-probe.mjs`，本机 headless，2026-10-15）：这两个事件**只对
    // 「工具发起」的写入**触发 —— 模型调内置 `write` / `edit` 打到记忆文件时会走这里；
    // 而**插件自己**调 `ctx.fs.writeText` 时一次都不发（实测 0 次），那条路由调用方自己传
    // `expected`（见 `lib/autodream-tools.js` 的 `writeMemoryText`）。
    // 监听器**不需要声明 inject** 也能收到，所以这里不挂子 fiber。
    //
    // 它买到的东西：**模型的 `write` 没法在一个记忆文件被改过之后静默覆盖它** ——
    // 守卫过不了，宿主会以 `FS_STALE_VERSION` 明确拒绝（实测确实会被拒）。
    // 这属于「把静默的坏结果变成显式的失败」，不是「阻止写入」：这个事件**没有拒绝动作**，
    // 我们也不发明一个（见 write-gate.js 的头注释）。
    //
    // 单槽纪律：返回 `undefined` 才是「不管」。目录外**必须**返回 undefined，否则会占掉槽位、
    // 影响整块盘的写入（write-gate.js 的 `outside_memory` 判在 `caller_wins` 之前正是为此）。
    /**
     * 探目标的当前版本。**区分「不存在」与「不知道」**。
     *
     * 这个区分不是洁癖：`!!info` 会把「拿不到 fs 服务」也写成 `exists:false`，判定表据此给
     * `createIfAbsent` —— 而目标**其实是存在的**记忆文件时，那是一次**误拦**（写入必然失败，
     * 模型收到一句看不懂的错误）。拿不准就不干涉，比猜一个安全。
     */
    // ⚠️⚠️ **这段注册必须在 `apply()` 里直接做，绝不能挪进 `ctx.inject(['fs'], …)`，也不能给
    // 插件加 `static inject = ['fs']`。** 这不是风格偏好，是实测出来的硬约束：
    // 这两个事件有一个**注册窗口**，窗口在 fs 服务就绪**之前**就关了。
    //   不 inject、apply 里直接挂     → 收到 1 次 ✅
    //   顶层 `inject:['fs']`           → **0 次**
    //   顶层 `inject:['tokenMeter']`   → **0 次**（与 fs 无关，是时机问题）
    //   `ctx.inject(['fs'], sub)` 子 fiber → **0 次**
    //   不 inject、但 apply 之后 2.5 秒再挂 → **0 次**（晚挂收不到）
    // 证据：`scripts/host-facts-probe.mjs` 的七组对照 + `docs/host-facts.md` 3.3 节。
    // 之所以特别标注：**按 D5 的规范直觉（可选服务要用 ctx.inject 挂子 fiber）改这里，
    // 会让写门静默失效** —— 编译得过、测试可能也过，只是永远不触发。
    // 而我们**不需要** inject：实测不声明 inject 时，处理器**内部** `ctx.get('fs')` 照样拿得到服务
    // （`{hasFs:true, hasStat:true}`），取版本就靠它。
    const probeTarget = async (target) => {
      try {
        const fs = typeof ctx.get === 'function' ? ctx.get('fs') : undefined
        if (!fs || typeof fs.stat !== 'function' || !target) return { known: false }
        const info = await fs.stat(target)
        return { known: true, exists: !!info, version: info?.version ?? null }
      } catch {
        return { known: false }
      }
    }
    try {
      if (typeof ctx.on === 'function') {
        // 公共骨架：**先判位置、再决定要不要碰链子**。
        //
        // ⚠️ 三条纪律（都是踩出来的）：
        //   1. **目录外连 `next()` 都不调**。宿主对**任何**工具写入都发这个事件（实测：写一个
        //      临时文件也发），无条件调 next() + stat 等于给整个系统的每次写文件都加一次系统调用，
        //      而我们本来就什么都不该做。直接 `return next()` 把决策权原样交出去。
        //   2. **一旦调了 `next()`，就必须把它给的东西交回去**。`next()` 返回的是下游（或调用方
        //      自己）已经做出的决定；此时再 `return undefined` 会把这个决定**丢掉** ——
        //      我们本想「不干涉」，实际却比干涉还糟。
        //   3. **探不到版本就不碰**（见 probeTarget）：把「不知道」当「不存在」会误拦真实存在的文件。
        const gateEvent = (decide) => async (target, actor, next) => {
          try {
            const memoryPath = memoryPathOf(target?.displayPath, MEMORY_DIR)
            if (!memoryPath.ok) return typeof next === 'function' ? next() : undefined
            const caller = typeof next === 'function' ? await next() : undefined
            const probed = await probeTarget(target)
            if (!probed.known) return caller
            const chosen = decide({
              memoryPath,
              exists: probed.exists,
              version: probed.version,
              caller,
            })
            // 我们给出决定就用我们的；决定不了（undefined）就把 `caller` 原样交回去，不吞。
            return chosen === undefined ? caller : chosen
          } catch {
            return undefined /* 写门在宿主的写入链路上：抛出去会把一次正常写入炸掉 */
          }
        }
        ctx.on('fs/write-intent', gateEvent((facts) => decideWriteIntent(facts).intent))
        ctx.on('fs/edit-intent', gateEvent((facts) => decideEditGuard(facts).guard))
      }
    } catch { /* 老宿主没有这两个事件：写入按宿主默认语义走 */ }

    // 会话级注入状态（检索签名 / baseline 标记 / 两本账 / 卡签名）——
    // 一处持有、一处提交，理由与顺序见 `createSessionInjectState` 的注释。
    //
    // 为什么不扫会话记录去算「已经注掉多少字节」：同一轮 assemble 出来的内容会被宿主
    // 合进**同一条** user/message（运行时上下文、工作区指令、插件注入共用一条），
    // 按消息字节统计会把别人的内容算进本插件的账；按文本找标记又太脆。自己记账确定性最高。
    //
    // baseline 为什么按会话记而不是按消息条数：恢复会话的历史消息早就在 session 里，
    // 条数永不为 0。会话 id 在整场会话里稳定，与 assemble 时当前用户消息有没有落盘无关，
    // 所以新会话、恢复会话两种时序都成立。
    const injectState = createSessionInjectState()

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

        // ── 代次：**先处理状态转换，再算正文与控制提示** ──
        // 压缩 / 清空（消息条数下降）在这一行里就让签名、两本账、卡签名、baseline 标记
        // 一起归零。放到后面（比如去重之后再算）就等于「拿上一代的账本判这一代」——
        // 复审 R03 的「同题压缩后仍被挡住」正是这么来的。
        const ledgerKey = session.id || 'no-session-id'
        const st = injectState.begin(ledgerKey, messages.length)

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
        if (!st.baselineDone) {
          selectBaseline(files)
            .forEach(f => {
              const before = picked.length
              take(f)
              if (picked.length > before) baselineTaken++
            })
          // 只有真取到才算「给过」：首步若正好撞上目录读不到（scanMemoryFiles 降级返回 []），
          // 整场会话就再也没机会补 baseline 了。宁可下一步重算一次。
          // 标记本身随这一步一起在 commit() 落 —— 与「提交放最后」同一条理由：
          // 没真注进去的东西不能记成「已经给过」。
        }

        // 检索签名只覆盖「检索出来的那批」，baseline 不再掺进这个签名。
        // 旧版两者共用 signature，首步签名一旦与后续某步相同，baseline 会连坐被吞；
        // 反过来，旧版把 baseline 文件名也算进签名，会让同一步的检索结果在下一步
        // 因签名变化而被重复注入。现在 baseline 由会话级标记保证只来一次，
        // 检索由这份签名保证同一问题不重复追加，两条线互不干扰。
        const relevant = text && text.length >= 2 ? selectRelevant(text, files) : []

        // ── 意图：先判，因为它要影响下面正文检索的**门槛松紧** ──
        // 用户是不是在问自己的历史（上次 / 之前 / 更正 / 问依据 / 继续）。
        // 判不出来就是 `none`，不猜 —— 误判的代价是把不该抑制的正文抑制掉。
        const intentInfo = text ? detectIntent(text) : { intent: 'none', historyDependent: false, suppressible: true }

        // ── 正文检索 ──
        // 摘要（description + aliases + 文件名）是最省的检索面，代价是**正文里的东西天生检索不到**。
        // 这里用它做两件事：
        //   1. 给候选文件定位「最相关的那一段」，注入时替代「文件开头 1500 字」——
        //      旧写法对任何问题都端同一段开头，等于把「命中在哪」这件事扔掉了；
        //   2. 摘要一条都没命中时，用正文兜一次底。此前这种情况直接等于「没有记忆可用」。
        //
        // query 短于 4 个字符不做正文匹配：`继续` 这种两个字的问题拿去匹配正文，
        // 命中的全是「继续」这个词本身，与用户问什么毫无关系。
        //
        // **门槛按意图放宽**：默认要求「连续命中 ≥ 2 个词元」（那条防的是跨词边界的假词元，
        // 见 search.js）。代价是整句只对上一个两字专名时会被拦下 —— 那是 0.9.16 有意付的。
        // 但用户**明确在问自己的历史**时，宁可多给一条也不该让他拿不到依据：这类问题的
        // 代价不对称（少给 = 答错，多给 = 多花一点上下文）。所以这时把 `minRun` 放到 1。
        const bodyRanked = typeof text === 'string' && text.length >= 4
          ? rankChunks(text, files, {
              limit: MAX_RESULTS,
              perFile: 1,
              ...(intentInfo.historyDependent ? { minEvidence: { minRun: 1 } } : {}),
            })
          : []
        const bestChunk = new Map()
        for (const h of bodyRanked) if (!bestChunk.has(h.file)) bestChunk.set(h.file, h.chunk)

        // 「摘要命中就按摘要排；一条都没有才让正文接手」这个**保守写法是错的**，
        // 由评测数据推翻（scripts/eval-retrieval.mjs 的对照 + 注入链实测）：
        // 摘要只要命中**任何一条**（哪怕很弱、甚至命中错的文件），正文里那份真正相关的
        // 就再也没有机会——应注入的文件级召回从 87.0% 掉到 60.9%。而噪音并没有因此更低
        // （正文命中本来就要过相关性门槛，实测误召回 1/10，与保守写法持平）。
        //
        // 所以改成**并集**：摘要命中的在前（它经过人工写的 description，精确度高），
        // 正文独有的在后（按 BM25 + 证据强度排序）。`take` 按文件去重，
        // 同一份文件不会因为两条检索线都命中而占两个名额。
        const byFile = new Map(files.map(f => [f.file, f]))
        const selected = relevant.slice()
        const taken = new Set(selected.map(f => f.file))
        for (const h of dedupeByFile(bodyRanked)) {
          if (taken.has(h.file)) continue
          taken.add(h.file)
          const f = byFile.get(h.file)
          if (f) selected.push(f)
        }

        const signature = text + '\u0000' + selected.map(f => f.file).join(',')
        // 检索签名没变 = 这一代里这条问题已经处理过 → 不再重复追加同一份记忆。
        // ⚠️ 这个判断必须排在代次处理**之后**：压缩后的同题恢复，靠的就是上面 `begin()`
        // 把签名一起清掉（复审 R03）。
        const deduped = st.signature === signature
        if (!deduped) selected.forEach(take)

        // ⚠️ 这里**不能**再写「picked 为空就返回」：检查点句柄与未命中提示都不依赖候选，
        // 提前返回会让它们在「目录为空」或「零命中」时永远不可达（复审 R02）。
        // 统一的出口在下面 —— 只有**正文与控制提示都为空**才返回。

        // ── 单会话累计预算：**拆成两本账** ──
        //   正文池 = CONTENT_BUDGET（总上限 − 状态卡预留）／卡池 = STATUS_RESERVE
        // 拆的理由见 config.js：到顶之后旧行为是一个字都不注、连「为什么没注、还能怎么查」
        // 都没有；而那个上限是**本插件自己定的**，完全可以给状态卡留一份固定额度。
        // 账记在 session id 上；picked 里 baseline 永远排在检索结果之前，所以预算不够时
        // 先被挤掉的是「更晚才想起来的」那些 —— baseline 有优先权。
        // 起点来自 `begin()`：它可能刚因压缩把两本账连同卡签名一起归零过。
        let contentBytes = st.contentBytes
        let cardBytes = st.cardBytes
        let cardSig = st.cardSig
        const nowMs = Date.now()

        // ── 渲染候选，然后交给展示层决定「给正文 / 给指针 / 不给」──
        // 两件事分开做：这一段只负责「每条候选长什么样」，`decideDelivery` 负责
        // 「在预算内该给哪几条、为什么」。混在一起写就是上一版的样子 —— 预算、渲染、
        // 去重三件事挤在一个循环里，谁也说不清某条为什么没进去。
        const candidates = []
        for (const f of picked) {
          // **baseline 不吃段落替换**：它的语义是「这条记忆每场会话都该完整在场」
          // （你是谁、待办清单）。一旦用户的问句碰巧命中它，替换成单个段落就等于
          // 把「完整在场」偷偷降级成「命中在场」—— 那正是 baseline 要防的事。
          const chunk = f.baseline ? null : bestChunk.get(f.file)
          // 命中段落优先；没有命中（baseline、或 query 太短没做正文检索）才回到「文件开头」。
          // 旧写法对**任何**问题都端同一段开头，等于把「命中在哪」这个信息扔掉了。
          const raw = chunk ? chunk.text : f.content
          const body = raw.length > MAX_CHARS_PER_FILE
            ? raw.slice(0, MAX_CHARS_PER_FILE) + '\n…（截断）'
            : raw
          const days = ageDays(f, nowMs)
          const stamp = days !== null && days >= STALE_DAYS ? `（保存于 ${days} 天前）` : ''
          // 段落命中时补两样东西：
          //   - 行号：模型据此能直接用文件工具跳过去核对来源，「引用可核对」靠它成立；
          //   - 摘要：段落本身不含 frontmatter，补回「这一段是从哪条记忆里切出来的」。
          const loc = chunk ? `:${chunk.startLine}-${chunk.endLine}` : ''
          const brief = chunk && f.description ? ` · ${f.description.slice(0, 80)}` : ''
          candidates.push({
            file: f.file,
            id: chunk?.id ?? `${f.file}#head`,
            revision: chunk?.revision ?? '',
            score: f.score ?? 0,
            baseline: f.baseline === true,
            lines: chunk ? [chunk.startLine, chunk.endLine] : null,
            title: f.description || '',
            text: `### ${f.file}${loc}${stamp}${brief}\n${body}`,
          })
        }

        const delivery = decideDelivery(candidates, {
          intent: intentInfo.intent,
          // ⚠️ 这里**故意传空集**：按 revision 抑制重复对「同一份文件的不同段落」太粗 ——
          // 换一个问题往往会命中同一份文件的**另一段**，按文件级 revision 抑制会把新相关
          // 的那段一起挡掉。要启用它得先用「段落身份」而不是「文件 revision」做键，
          // 并且单独评测一次。这条记在 docs/decisions.md 的 D15，不是遗漏。
          visibleRevisions: new Set(),
          scopeDenied: new Set(),
          conflicts: new Set(),
          expired: new Set(),
          needle: text ? text.slice(0, 40) : '',
        }, { bytes: Math.max(0, CONTENT_BUDGET - contentBytes) })

        const parts = []
        const injectedFiles = []
        let skippedForBudget = 0
        for (const item of delivery.items) {
          if (item.kind === 'snippet') {
            parts.push(item.text)
            injectedFiles.push(item.file)
          } else {
            // pointer / suppress / unresolved 都**不进正文**。
            // 「被省略几条」这件事由下面的状态卡统一说，正文里再逐条列一行
            // `### 某某.md（未展开）` 是重复的信息，还白占上下文 —— 卡片本来就带着
            // 「最佳线索 + 一个可做的动作」。
            skippedForBudget++
          }
        }
        // 按**实际进正文的字节**记账，而不是 delivery.totals —— 后者含指针的额度，
        // 而指针没有真的进上下文。两本账要对得上，就不能把没花出去的钱记进去。
        contentBytes += parts.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0)

        // 进上下文的这些才算「被用过」—— 台账是自动归档阈值的唯一数据源，记错一步阈值就偏。
        // recordAccess 同步、绝不抛：台账的问题不许升级成注入失败。
        recordAccess(injectedFiles, nowMs)

        // ── 缺口状态卡 ──
        // 它**替换**原来那行状态文字，不是额外追加：同一件事不说两遍。
        // 卡池与正文池互不借用 —— 正文满了照样发得出卡，这正是预留的意义（见 config.js）。
        const bodySearched = typeof text === 'string' && text.length >= 4
        const bodyOnly = bodySearched ? dedupeByFile(bodyRanked) : []
        const unread = Math.max(0, selected.length - injectedFiles.length)
        // 最佳线索取「正文命中里第一条没被注进去的」——那正是模型下一步最该去读的东西。
        const beacon = bodyOnly.find(h => !injectedFiles.includes(h.file)) ?? bodyOnly[0] ?? null
        // 什么时候该说话：
        //   - **有真缺口**（有候选没读、或有候选被预算省略）→ 说；
        //   - **没有缺口也没有命中** → 只在「用户这句话在问自己的历史」时说。
        // 后者是计划里点名的一条：没有历史依赖时不要插「你可能遗漏记忆」，否则提示
        // 每轮都出现，等真有缺口时它已经被当噪音忽略了。
        const gapExists = unread > 0 || skippedForBudget > 0

        // ── 任务检查点：压缩后的恢复入口 ──
        // 宿主**什么时候**压缩上下文，插件控制不了 —— 所以这里**不承诺「压缩前保存」**，
        // 只保证「存在检查点就给一条短句柄」。压缩后两本账与卡的签名会一起归零，
        // 句柄因此会重新出现，这就是恢复路径（而不是靠某个压缩前钩子）。
        //
        // 任务 id：`SAGE_MEM_TASK_ID` 优先（给「跨会话的同一条任务」用），否则用 session id。
        // **绝不用查询文本自定作用域** —— 那句话是模型或用户写的，不该决定去读哪个目录。
        const taskId = process.env.SAGE_MEM_TASK_ID || session.id || ''
        let checkpointLine = ''
        try {
          const cp = taskId ? await readCheckpoint(taskId, { stateRoot: STATE_ROOT }) : null
          if (cp?.ok && cp.handle) checkpointLine = cp.handle
        } catch { /* 读不到检查点就当没有：它是可选的接力棒，不是必需件 */ }

        const wantCard = gapExists || intentInfo.historyDependent || !!checkpointLine
        // 签名没变时沿用上一步渲染好的那份缺口卡，而不是重渲染一张。
        // 两条理由：其一，那一步与这一步的检索面**逐字相同**，缺口也相同，重渲染只会把
        // 同一件事换个数字再说一遍 —— 而局部变量算出来的数字还是错的（上一步注了 N 条，
        // 这一步按本轮 parts 算是 0 条）；其二，文本一变 `cardSig` 去重就失效，同一张语义
        // 的卡会被反复追加进会话。
        // 检查点句柄不在此列：它是可能刚刚才出现的接力棒，所以始终参与合成。
        const cardBody = !wantCard
          ? ''
          : deduped
            ? st.gapCard
            : renderStatusCard({
                scope: bodySearched ? 'all' : 'summary',
                scanned: files.length,
                injected: parts.length,
                omitted: skippedForBudget,
                unread,
                best: beacon ? { file: beacon.file, title: beacon.chunk?.title || beacon.chunk?.headingPath || '' } : null,
                needle: text ? text.slice(0, 40) : null,
                toolsAvailable: toolsReady,
                memoryDir: MEMORY_DIR,
              })
        // 句柄与卡**共用卡池**：它是同一个通道里的另一句提示，不该另开一份额度。
        const cardText = [cardBody, checkpointLine].filter(Boolean).join('\n')
        let cardPart = ''
        // 卡按**内容签名**去重：签名没变就不重复发。否则每一步都追加一张一模一样的卡，
        // 而每张卡都是落到会话里的持久消息 —— 那不叫提示，那叫刷屏。
        if (cardText && cardText !== cardSig) {
          const cardSize = Buffer.byteLength(cardText, 'utf8')
          if (cardBytes + cardSize <= STATUS_RESERVE) {
            cardBytes += cardSize
            cardPart = cardText
            cardSig = cardText
          }
        }

        // 正文与卡都没有 → 一个字都不注。注意这与旧行为不同：旧行为「正文池满」就到此为止，
        // 现在只要卡池还有额度就会发出卡（说清范围、缺口与下一步动作）。
        if (parts.length === 0 && !cardPart) {
          if (DEBUG_RECALL) {
            debugRecall({
              scanned: files.length, hits: relevant.length,
              scores: relevant.map(f => [f.file, Number(f.score.toFixed(4))]),
              picked: picked.map(f => f.file), injected: [], chars: contentBytes, skippedByBudget: skippedForBudget,
            })
          }
          return assembled
        }

        // 状态一次写回：签名、两本账、卡签名、缺口卡、条数、baseline 标记。
        // 放在这里（而不是更早）是刻意的 —— 上面每一步都可能没真注进去东西，
        // 那就不该让状态前进；一次失败把一条记忆永久挡在门外是最难查的一种。
        injectState.commit(ledgerKey, {
          signature,
          contentBytes,
          cardBytes,
          cardSig,
          gapCard: cardBody,
          messageCount: messages.length,
          baselineDone: st.baselineDone || baselineTaken > 0,
        })

        if (DEBUG_RECALL) {
          debugRecall({
            scanned: files.length,
            hits: relevant.length,
            scores: relevant.map(f => [f.file, Number(f.score.toFixed(4))]),
            picked: picked.map(f => f.file),
            injected: injectedFiles,
            chars: contentBytes,
            skippedByBudget: skippedForBudget,
            card: cardPart ? 'sent' : (cardText ? 'deduped-or-over-budget' : 'none'),
          })
        }

        // 只有正文时：头部 + 引用纪律 + 正文 [+ 卡]
        // 只有卡时：**就只发卡** —— 头部那句「以下是与你当前问题相关的历史记忆」在没有正文
        // 的情况下是假陈述，而引用纪律管的是「别把记过的东西当当前事实」，没有正文就没有
        // 需要约束的对象。
        const recallText = parts.length
          ? `以下是与你当前问题相关的历史记忆（文件式，来自 ${MEMORY_DIR}）：\n\n` +
            `${RECALL_DISCIPLINE}\n\n${parts.join('\n\n')}` +
            (cardPart ? `\n\n${cardPart}` : '')
          : cardPart

        return {
          ...assembled,
          contexts: [...(assembled.contexts ?? []), {
            name: 'sage-mem:recall',
            order: 1000,
            text: recallText,
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

  /**
   * 查有没有新版本（面板进入时静默调一次）。
   *
   * 实现全在 `lib/update.js`：**当前版本运行时读自己的 `package.json`**（不内联常量 ——
   * 内联会在「构建早于 bump」时停留在旧版本，插件于是永远对自己报「有新版本」）；
   * 查不到一律降级为「不提示」，绝不在界面上冒红条。
   */
  async checkUpdate() {
    return await checkUpdateImpl()
  }

  /** 列出 memory 目录全部记忆文件（文件名 + 类型 + 描述 + 大小 + 自定义标签 + 是否锁定）。 */
  async listFiles() {
    const [files, locked] = await Promise.all([scanMemoryFiles(this.ctx, ''), readLockSet(MEMORY_DIR)])
    return files.map(f => {
      const meta = parseFrontmatter(f.content)
      return {
        file: f.file,
        type: meta.type || 'reference',
        description: meta.description || '',
        size: f.content.length,
        tags: meta.tags,
        // 锁定状态跟着每条一起给：卡片上的「锁定 / 已锁定」按钮要据此渲染
        locked: locked.has(nameKey(f.file)),
      }
    })
  }

  /**
   * 读单个记忆文件全文。
   *
   * 过闸门再读：名字在记忆目录里**不等于**内容住在记忆目录里 —— 符号链接 / 目录联接 /
   * 硬链接都能让一次「读自己的记忆」变成读别人的文件，而读到的内容会被注入模型上下文。
   */
  async readFile(name) {
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    const full = join(MEMORY_DIR, safe)
    // 名字不是保留名 ≠ 文件不是保留名：8.3 短名（`MEMORY~1.MD`）文本上与索引毫无关系，
    // 却是同一个文件。别把索引当普通记忆交出去。
    if (await shadowsReserved(full)) {
      throw new Error(`sage-mem: refusing to read ${safe}: 这是某个保留名（索引 / 流水）的另一个名字`)
    }
    const gate = await inspectMemoryEntry(full)
    if (!gate.ok) throw new Error(`sage-mem: refusing to read ${safe}: ${gate.error}`)
    const content = await readFile(full, 'utf8')
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
    // 名字文本不是保留名 **不等于** 文件不是保留名：NTFS 的 8.3 短名（`MEMORY~1.MD`）
    // 在文本上跟索引毫无关系，inode 却是同一个 —— 实测它能改写索引。
    // 保留名保护必须落在**文件身份**上，否则「保留名不可写」这句承诺是假的。
    if (await shadowsReserved(join(MEMORY_DIR, safe))) {
      return { ok: false, file: safe, error: `sage-mem: reserved file (它的另一个名字是 ${safe})，请用文件工具改` }
    }
    // 不加这一层，传个对象进来会被 String() 写成 "[object Object]" 还回 { ok: true }，
    // 原文件就此被一行垃圾顶掉，且没有任何错误信号。
    if (typeof content !== 'string') {
      return { ok: false, file: safe, error: `sage-mem: content must be a string, got ${typeof content}` }
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_FILE_BYTES) {
      return { ok: false, file: safe, error: `sage-mem: content too large (${bytes} bytes > ${MAX_FILE_BYTES})` }
    }
    /**
     * 目标已存在时也要过闸门：链接 / 硬链接一律拒绝。
     *
     * 原子写本身不会写穿链接（rename 换掉的是链接本身），但那样「改这条记忆」就变成了
     * 「把这个名字指向别处」—— 用户以为改的是记忆，实际磁盘上多了一个指向外部的名字。
     * `limitBytes = 0` 表示不在这里判体积（上面刚按字符数查过）。
     */
    const target = join(MEMORY_DIR, safe)
    const existing = await inspectMemoryEntry(target, { limitBytes: null })
    if (!existing.ok && existing.code !== 'missing') {
      return { ok: false, file: safe, error: `sage-mem: refusing to write ${safe}: ${existing.error}` }
    }
    await writeFileAtomic(target, content)
    return { ok: true, file: safe }
  }

  /** 删除单个记忆文件：保留名一律拒绝（unlink 不可逆）。判定同 writeFile。 */
  async deleteFile(name) {
    if (isReserved(name)) {
      return { ok: false, error: `sage-mem: reserved file, refusing to delete: ${nameKey(name)}` }
    }
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    // 同 writeFile：8.3 短名能绕过名字文本判据，删除保护也必须看文件身份。
    if (await shadowsReserved(join(MEMORY_DIR, safe))) {
      return { ok: false, error: `sage-mem: reserved file (它的另一个名字是 ${safe})，拒绝删除` }
    }
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
    if (!res.ok) return { ok: false, error: res.error }
    /**
     * ⚠️ `unindexed` / `indexError` 必须**原样透出去**（2026-10-12 复审 R11 的配套）：
     * 归档本身成功、索引却没摘掉时，这正是用户该被告知的那件事 —— 底下那句
     * 「索引没摘」在面板上要看得见，不能只活在 host 的返回值里被 strict 剥掉。
     */
    return {
      ok: true,
      file: res.file,
      archivedReason: res.archivedReason,
      unindexed: res.unindexed,
      ...(res.indexError ? { indexError: res.indexError } : {}),
    }
  }

  /**
   * 从归档区恢复一条记忆：移回根目录，并去掉 `archived_at` / `archived_reason` 两行。
   * 同样委托给 `memory/archive.js`（判断与拒绝矩阵只有一份）。
   */
  async restore(name) {
    const res = await restoreMemory(MEMORY_DIR, name)
    if (!res.ok) return { ok: false, error: res.error }
    // 与 `archive` 对称：文件回来了但索引没补上时，如实告诉界面（见那边的说明）。
    return {
      ok: true,
      file: res.file,
      indexed: res.indexed,
      ...(res.indexError ? { indexError: res.indexError } : {}),
    }
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
   * 归档不是删除，正文就该和活跃记忆一样能看能改（使用者的要求）。名字仍然只走
   * `safeName`：调用方永远不许自己拼路径，归档区也只认 `memory/archive/` 这一层。
   */
  async readArchived(name) {
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    // 归档区本身先过目录闸门：它若是指向别处的联接，读归档就等于读外部的文件。
    const dirGate = await inspectDir(MEMORY_ARCHIVE_DIR)
    if (!dirGate.ok) throw new Error(`sage-mem: archive dir unavailable: ${dirGate.error}`)
    const full = join(MEMORY_ARCHIVE_DIR, safe)
    const gate = await inspectMemoryEntry(full)
    // 找不到就抛：与 readFile 一致。静默返回空串会让面板显示一个「空的记忆」，
    // 而用户改完一存 —— 就把一条真实内容顶掉了。
    if (!gate.ok) {
      // ⚠️「形状不对」与「不存在」是两回事：把联接 / 超限都报成「文件不存在」，
      // 会让用户去找一个明明躺在盘上的文件。
      if (gate.code === 'missing') throw new Error(`sage-mem: archived file not found: ${safe}`)
      throw new Error(`sage-mem: refusing to read archived ${safe}: ${gate.error}`)
    }
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
    const dirGate = await inspectDir(MEMORY_ARCHIVE_DIR)
    if (!dirGate.ok) return { ok: false, file: safe, error: `sage-mem: archive dir unavailable: ${dirGate.error}` }
    const full = join(MEMORY_ARCHIVE_DIR, safe)
    const gate = await inspectMemoryEntry(full, { limitBytes: null })
    // 只改归档区里**已经存在**的文件：这条 remote 不是「把任意文件写进归档区」的后门。
    if (!gate.ok) {
      return {
        ok: false,
        file: safe,
        error:
          gate.code === 'missing'
            ? `sage-mem: archived file not found: ${safe}`
            : `sage-mem: refusing to write archived ${safe}: ${gate.error}`,
      }
    }
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
   * **彻底删除**一条已归档记忆（不可恢复）。
   *
   * 与 `deleteFile` 的区别要在代码里就分开：那个删的是活动记忆，这个删的是档案馆里的退役件；
   * 归档「只移不删」的承诺不变 —— 走进档案馆之后，删不删由人单独决定。
   *
   * `archivedAt` 是**身份判据**（见 `memory/archive.js` 的头注）：调用方交回它当时看见的
   * 归档时间，盘上那份对不上就拒绝。不传 / 传空串只对「本来就没有留痕的老归档件」成立。
   */
  async deleteArchived(name, archivedAt) {
    const res = await deleteArchivedMemory(MEMORY_DIR, name, archivedAt)
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true, file: res.file }
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
  /**
   * 上锁 / 解锁一条记忆。锁上的记忆**拒绝归档**（自动与手动都不行）。
   *
   * 落点是**状态目录**（`.sage-mem/locked.json`），不写进记忆自己的 frontmatter ——
   * 理由见 `lib/memory/lock.js` 的头注：frontmatter 会被「自动做梦」重写，锁写在里面
   * 可能被整理过程擦掉，而锁一丢那条记忆就重新进了自动归档候选（正是这功能要防的事）。
   */
  async setLocked(name, locked) {
    return await setLockedImpl(MEMORY_DIR, name, locked === true)
  }

  async archiveCandidates() {
    await flushAccess(MEMORY_DIR)
    const [ledger, files, locked] = await Promise.all([
      readAccessLedger(),
      scanMemoryFiles(this.ctx, ''),
      readLockSet(MEMORY_DIR),
    ])
    const cfg = await autodreamConfigSnapshot()
    const thresholds = {
      project: cfg.archiveAfterDaysProject,
      reference: cfg.archiveAfterDaysReference,
      user: cfg.archiveAfterDaysUser,
    }
    // 锁表交给候选计算：锁上的记忆一个都不选（用户对**单条**记忆说的话优先于阈值）。
    const candidates = pickArchiveCandidates(files, ledger, { thresholds, locked })
    return {
      count: candidates.length,
      candidates,
      autoArchive: cfg.autoArchive,
      thresholds,
      // 面板要显示「哪些锁着」，所以把锁表也带回去（已按 nameKey 归一）
      locked: [...locked],
    }
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
    // 保留名同样过闸门：链接 / 硬链接一样能把「读索引 / 读流水」变成读外部文件。
    // ⚠️ 体积**不**在这里判（`limitBytes = 0`）：流水天然比单条记忆大得多，
    // 它有自己的上限（`MAX_RAW_BYTES`，见上面的注释）。
    const full = join(MEMORY_DIR, safe)
    const gate = await inspectMemoryEntry(full, { limitBytes: null })
    if (!gate.ok) throw new Error(`sage-mem: refusing to read ${safe}: ${gate.error}`)
    // 读不到就抛（与 readFile 一致）：静默返回空串会让面板显示一份「空的索引」，
    // 用户一存就把真索引顶掉。
    const content = await readFile(full, 'utf8')
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
    const target = join(MEMORY_DIR, safe)
    // 与 `writeFile` 同一条理由：目标已存在时若是链接 / 硬链接，一律拒绝 ——
    // 「改这份索引」不该变成「把这个名字指向别处」。体积由上面那道 `MAX_RAW_BYTES` 管。
    const existing = await inspectMemoryEntry(target, { limitBytes: null })
    if (!existing.ok && existing.code !== 'missing') {
      return { ok: false, file: safe, error: `sage-mem: refusing to write ${safe}: ${existing.error}` }
    }
    await writeFileAtomic(target, content)
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
markRemote(MemoryGateway, 'deleteArchived', 'deleteArchived')
markRemote(MemoryGateway, 'audit', 'audit')
markRemote(MemoryGateway, 'checkUpdate', 'checkUpdate')
markRemote(MemoryGateway, 'setLocked', 'setLocked')
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

