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

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { homedir } from 'node:os'
import { readFile, readdir, writeFile, rename, unlink, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { AutodreamEngine } from './autodream.js'

const MEMORY_DIR = process.env.SAGE_MEM_DIR || join(homedir(), '.sage-mem', 'memory')
/**
 * DSH 会话记录根目录。autodream 的门控靠它数「上次整理之后有几个会话更新」，
 * `memory+sessions` 输入源下也会在里面做定向搜索。取不到就是空串，
 * 门控会退化成「会话数 0 → 不触发」，而不是报错。
 */
const SESSIONS_ROOT = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : ''

/** 读一个整数型环境变量并在范围内收敛；取不到或非法就用默认值。 */
function envInt(name, dflt, lo, hi) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return dflt
  const n = Number(raw)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/**
 * 一次注入最多带几条记忆。
 *
 * 5 → 10（2026-10-01）：记忆目录 80 条、名额 5，等于命中率上限 6%——「捞不出来」
 * 的根因就在这个比值上。名额翻倍是提升召回最直接的一手，代价是每轮多约 7.5K
 * 字符的上下文。**这个数字该由实测决定**，所以留了 SAGE_MEM_MAX_RESULTS 覆写口
 * （比较两档的命中率与 token 账单，别拍脑袋）。
 */
const MAX_RESULTS = envInt('SAGE_MEM_MAX_RESULTS', 10, 1, 30)

/** 单条记忆注入的字符上限。 */
const MAX_CHARS_PER_FILE = envInt('SAGE_MEM_MAX_CHARS', 1500, 200, 20000)

/**
 * baseline 名额。
 *
 * 标了 baseline 的本来就只有个位数，卡在 5 只会让「第 6 条起永不出现」——
 * 而 baseline 恰恰是短问题、恢复会话时唯一的兜底。现在放到 8（够覆盖现状），
 * 排序见下面「按显式优先级排，不按文件名」那段。
 */
const MAX_BASELINE = envInt('SAGE_MEM_MAX_BASELINE', 8, 1, 50)

/**
 * 保留名：设置页的写/删方法一律不得触碰。
 *
 * 列进来的两类文件：
 *   1. MEMORY.md / session-log.md —— 不是记忆条目：不进检索、不进星图、不出现在
 *      设置页列表里，它们是索引与追加型流水（session-log.md 已 130+ KB）。
 *      「+ 添加记忆」表单里手打这两个名字就能整份覆盖，而这个表单是照
 *      buildFrontmatter() 重建 frontmatter 的，原有内容一个字都留不下。
 *   2. project_heartscape.md / project_self-cognition.md —— 人格连续性的手写载体
 *      （AGENTS.md 指定的落盘目标），单副本、纯人工维护；表单写还会把
 *      frontmatter 里的 originSessionId / birthday 等字段一并抹掉。
 *
 * 判定依据是「丢了能不能从别处重建」：memory 目录**不在任何版本控制下**
 * （该目录里没有 .git，`git rev-parse` 直接报 not a git repository），
 * deleteFile 是 unlink、没有回收站，所以宁严勿松。
 * 这几个文件要改，用文件工具直接编辑。
 *
 * ⚠️ 全部小写存放，比较一律走 nameKey()（NTFS 不区分大小写，集合里放 'MEMORY.md'
 * 而拿 'memory.md' 去 has() 是查不到的 —— 曾经就是这个漏洞：表单里填 memory.md
 * 就能整份覆盖 19 KB 的索引，deleteFile 还能不可逆删掉它）。
 */
const RESERVED_FILES = new Set([
  'memory.md',
  'session-log.md',
  'project_heartscape.md',
  'project_self-cognition.md',
])

/**
 * 非记忆条目：不参与检索 / 不进星图 / 不出现在设置页列表里，读写也一律不通。
 *
 * 是 RESERVED_FILES 的子集，区别在「列不列出来」：MEMORY.md 是索引、
 * session-log.md 是追加型流水（已 390+ KB），两者都不是一条记忆；
 * 而 project_heartscape.md / project_self-cognition.md 是正常记忆条目
 * （要出现在列表与星图里、要能读），只是不许从表单写/删。
 */
const NON_ENTRY_FILES = new Set([
  'memory.md',
  'session-log.md',
])

/**
 * 单文件体积上限（字节）。定 512 KB 的理由：
 *   - 当前 memory 目录最大的一条正文 19 KB（project_guikit.md），索引与流水都排除在外，
 *     512 KB 是它的 26 倍，任何正常记忆都够用；
 *   - 记忆是要塞进 system prompt 的，一条 512 KB 的记忆本身就等于把上下文撑爆——
 *     到这个量级基本可以判定是写错了目标（比如把日志、代码贴进来）。
 * 与 lib/typert.host.js 的 fileContentSchema.max(512 * 1024) 保持一致。
 */
const MAX_FILE_BYTES = 512 * 1024

/**
 * 统一告警出口。所有非 ENOENT 的失败都必须落到日志，绝不静默
 * （历史坑见 assemble 监听器里那段注释：表现是「插件在、记忆不再注入」，日志一字没有）。
 * @param ctx — 插件上下文，取 ctx.logger.warn
 * @param msg — 消息正文，调用方负责带上文件名 / 目录名
 * @param sessionId — 可选 session id，有就带
 */
function warnLog(ctx, msg, sessionId) {
  const line = `sage-mem: ${msg}${sessionId ? ` (session ${sessionId})` : ''}`
  if (ctx?.logger?.warn) ctx.logger.warn(line)
  else console.warn(line)
}

/** 提取消息文本，兼容 content 为字符串或 text-block 数组两种形态。 */
function extractText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

/** 提取双字（2-gram）集合，中英文数字通用。 */
function bigrams(s) {
  const clean = String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

/** query 的双字在 text 中的覆盖率（0~1），作为相关性得分。 */
function score(query, text) {
  const q = bigrams(query)
  if (q.size === 0) return 0
  const t = bigrams(text)
  let hit = 0
  for (const g of q) if (t.has(g)) hit++
  return hit / q.size
}

/** 扫 memory 目录，读回全部记忆文件（跳过索引与子目录），并解析 frontmatter 摘要。 */
async function scanMemoryFiles(ctx, sessionId) {
  try {
    const entries = await readdir(MEMORY_DIR, { withFileTypes: true })
    const names = entries
      .filter(e => e.isFile() && isMemoryEntry(e.name))
      .map(e => e.name)
    const loaded = await Promise.all(names.map(async (name) => {
      try {
        const content = await readFile(join(MEMORY_DIR, name), 'utf8')
        const meta = parseFrontmatter(content)
        return {
          file: name,
          content,
          description: meta.description || '',
          aliases: meta.aliases || [],
          baseline: parseBaseline(content),
          baselinePriority: meta.baselinePriority || 0,
        }
      } catch (err) {
        // 只有 ENOENT 是正常状态（扫到读之间被删）。其余——权限错、编码坏、盘掉线——
        // 一律出声：这里的静默化就是把「记忆不再注入」变成无声事故的那一手。
        if (err?.code !== 'ENOENT') warnLog(ctx, `cannot read ${name}: ${err?.message ?? err}`, sessionId)
        return null
      }
    }))
    return loaded.filter(Boolean)
  } catch (err) {
    if (err?.code !== 'ENOENT') warnLog(ctx, `cannot scan ${MEMORY_DIR}: ${err?.message ?? err}`, sessionId)
    return []
  }
}

/**
 * 相关性打分只用 frontmatter 的 description + 文件名，不扫全文。
 *
 * 旧版拿 query 的双字去全文里找，得分是「覆盖率」，分母是 query，不惩罚
 * 文件长度 —— 越长的记忆越容易蒙中。实测 8 个典型问题：project_heartscape
 * (5.9KB) 与 project_self-cognition (6.8KB) 命中 7 个，连「今天天气不错」都
 * 注入 2300 token；而「论文写得怎么样了」该命中的 project_position-paper
 * 反被挤掉。description 是「一句话说清这条是什么」的精准摘要，用它当检索
 * 信号，噪音大幅下降。
 */
function selectRelevant(query, files) {
  return files
    .map(f => {
      // aliases 一并进检索面：它是专门为「换个说法也能命中」准备的字段。
      const aliasText = Array.isArray(f.aliases) && f.aliases.length ? ' ' + f.aliases.join(' ') : ''
      const hay = f.description + aliasText + ' ' + f.file.replace(/\.md$/, '').replace(/[_-]/g, ' ')
      return { ...f, score: score(query, hay) }
    })
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
}

/**
 * 选 baseline 条目：按显式 `baselinePriority` 排，不按文件名。
 *
 * 文件名排序等于让 `feedback_*` 无条件压过 `user_*`，与「哪条更该出现在每场
 * 会话开头」毫无关系。没写这个字段的老条目一律算 0，行为与从前一致。
 */
function selectBaseline(files) {
  return files
    .filter(f => f.baseline)
    .sort((a, b) => (b.baselinePriority || 0) - (a.baselinePriority || 0) || a.file.localeCompare(b.file))
    .slice(0, MAX_BASELINE)
}

/**
 * 解析 frontmatter 的 `tags`（自定义标签，用于列表页筛选）。
 *
 * 三种写法都收 —— 手写记忆时这三种都会自然出现，只认一种就等于「标签时灵时不灵」：
 *   tags: [a, b]           （YAML flow）
 *   tags:\n  - a\n  - b    （YAML block）
 *   tags: a, b             （松散的逗号串）
 *
 * 上限 20 个、每个 40 字符：标签是给人点着筛的，超过这个量级已经不是标签，
 * 而是一句话被塞进了 tags 字段。
 */
function parseTags(body) {
  const clean = (arr) =>
    arr
      .map((s) => String(s).trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((s) => s.slice(0, 40))
  const flow = body.match(/^tags:[ \t]*\[([^\]]*)\]/m)
  if (flow) return clean(flow[1].split(','))
  const block = body.match(/^tags:[ \t]*\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)+)/m)
  if (block) return clean(block[1].split(/\r?\n/).map((l) => l.replace(/^[ \t]*-[ \t]*/, '')))
  const inline = body.match(/^tags:[ \t]*(.+?)[ \t\r]*$/m)
  if (inline && inline[1].trim()) return clean(inline[1].split(','))
  return []
}

/** 解析 frontmatter 的 name/description/type（兼容顶层与 metadata 嵌套两种 type）。 */
function parseFrontmatter(content) {
  // 换行必须容忍 CRLF：任何用 Windows 编辑器碰过一次的文件都会被换成 \r\n，
  // 而旧版这里写的是 /^---\n/ —— 匹配失败 → description/type 全空 →
  // 「baseline 走 parseBaseline 那条带 \r?\n 的正则照旧命中，但这条记忆永远检索不到」，
  // 症状极具欺骗性。:123 的 parseBaseline 与 :277 的 extractTitle 早已是 \r?\n。
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { name: '', description: '', type: '', tags: [], aliases: [], baselinePriority: 0 }
  const body = m[1]
  const grab = (key) => {
    // [ \t] / [ \t\r] 而不是 \s：\s 会连 CRLF 的 \r 一起吃进捕获组，值尾留一个 \r
    // 会让下面的引号剥离（["']$）失配，description 尾巴上挂一个残引号。
    const hit = body.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t\\r]*$`, 'm'))
    if (!hit) return ''
    return hit[1].replace(/^["']|["']$/g, '').trim()
  }
  let type = grab('type')
  if (!type) {
    const nested = body.match(/^metadata:\s*\r?\n(?:\s+[^\r\n]+\r?\n)*?\s+type:\s*(\S+)/m)
    if (nested) type = nested[1]
  }
  return {
    name: grab('name'),
    description: grab('description'),
    type,
    tags: parseTags(body),
    aliases: parseAliases(body),
    baselinePriority: parseBaselinePriority(body),
  }
}

/**
 * 解析 frontmatter 的 `aliases`（别称 / 同义词 / 我可能用的另一种叫法）。
 *
 * 为什么要有它：检索是**词面重合**的，不是语义的——问「我有什么待办」而文件里
 * 写的是「代办清单」，差一个字就完全不命中。`description` 回答「我会怎么问它」，
 * `aliases` 补上「我还可能怎么问」。写法与 tags 完全一致（flow / block / 逗号串三种都收），
 * 免得手写时「时灵时不灵」。
 */
function parseAliases(body) {
  const clean = (arr) =>
    arr
      .map((s) => String(s).trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .slice(0, 24)
      .map((s) => s.slice(0, 60))
  const flow = body.match(/^aliases:[ \t]*\[([^\]]*)\]/m)
  if (flow) return clean(flow[1].split(','))
  const block = body.match(/^aliases:[ \t]*\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)+)/m)
  if (block) return clean(block[1].split(/\r?\n/).map((l) => l.replace(/^[ \t]*-[ \t]*/, '')))
  const inline = body.match(/^aliases:[ \t]*(.+?)[ \t\r]*$/m)
  if (inline && inline[1].trim()) return clean(inline[1].split(','))
  return []
}

/**
 * 解析 frontmatter 的 `baselinePriority`（数字，越大越先注入）。
 *
 * 旧版 baseline 是 `MAX_BASELINE = 5` + **按文件名排序**——`feedback_*` 永远排在
 * `user_*` 前面，与「哪条真的更该在每场会话开头出现」毫无关系。缺失当 0，
 * 于是没写这个字段的老条目行为不变。
 */
function parseBaselinePriority(body) {
  const hit = body.match(/^baselinePriority:[ \t]*(.+?)[ \t\r]*$/m)
  if (!hit) return 0
  const n = Number(hit[1].replace(/^["']|["']$/g, '').trim())
  return Number.isFinite(n) ? n : 0
}

/** 解析 frontmatter 的 `baseline` 标记：会话第一回合无条件注入。 */
function parseBaseline(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return false
  const hit = m[1].match(/^baseline:\s*(.+)$/m)
  if (!hit) return false
  return /^(true|yes|1)$/i.test(hit[1].replace(/^["']|["']$/g, '').trim())
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 直写的风险是崩在中途（断电、进程被杀、磁盘满）留下半截文件 —— frontmatter
 * 缺半边，这条记忆从此解析不出来、检索不到，而文件看上去还在。
 * 同卷 rename 是原子的：读方要么看到旧全文、要么看到新全文，不存在中间态。
 * 任何一步失败都不碰目标文件，临时文件收尾清掉。
 */
async function writeFileAtomic(target, content) {
  const tmp = `${target}.${process.pid}.tmp`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, target)
  } finally {
    // rename 成功后 tmp 已不存在（ENOENT），失败时把它清掉不留垃圾。
    await unlink(tmp).catch(() => {})
  }
}

/**
 * 文件名归一：只取单段文件名再小写。
 *
 * 这是**唯一**的名字比较基准（保留名、非条目名、扫描过滤全走它）。
 * 不能直接用原始字符串比：NTFS 不区分大小写，`memory.md` 与 `MEMORY.md`
 * 是同一个文件；`basename` 还顺手挡掉 `..\..\MEMORY.md` 这类带目录成分的输入。
 */
function nameKey(raw) {
  return basename(String(raw ?? '')).toLowerCase()
}

/** 是否是保留名（写/删一律拒绝）。大小写不敏感。 */
function isReserved(raw) {
  return RESERVED_FILES.has(nameKey(raw))
}

/** 是否是非记忆条目（索引与流水）：列出/检索/星图/读写全部排除。大小写不敏感。 */
function isNonEntry(raw) {
  return NON_ENTRY_FILES.has(nameKey(raw))
}

/** 目录扫描过滤：这个名字算不算一条记忆条目。 */
function isMemoryEntry(name) {
  return /\.md$/i.test(String(name ?? '')) && !isNonEntry(name)
}

/**
 * 唯一的路径校验函数（防穿越 + 扩展名 + 排除非记忆条目）。
 *
 * MemoryGateway.readFile / StarmapGateway.readFile 都走这里，不再各写一套
 * —— 旧版 starmap 那套内联校验只排除了 'MEMORY.md'（大小写敏感）且**完全不排除
 * session-log.md**，于是 `starmap.readFile('session-log.md')` 能把 390+ KB 的流水
 * 整个拉进浏览器。
 *
 * 不复用 nameKey 的原因：这里要保留磁盘上的原始大小写（返回值直接 join 进路径）。
 * @param raw — 调用方传来的文件名（任意值）
 * @returns 通过校验的原始文件名；非法返回 null
 */
function safeName(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  // basename 与原文不一致＝含目录成分。旧版是「悄悄取 basename 继续」，
  // 与 starmap 那套（要求 safe === raw）行为不一致；现在统一为拒绝。
  if (basename(raw) !== raw) return null
  if (!/\.md$/i.test(raw)) return null
  if (isNonEntry(raw)) return null
  return raw
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
      const engine = new AutodreamEngine(ctx, { memoryDir: MEMORY_DIR, sessionsRoot: SESSIONS_ROOT })
      new AutodreamGateway(ctx, engine)
      engine.start()
      // 卸载时把定时器与锁收干净。effect 拿不到就交给 unref 兜底（不阻止进程退出）。
      if (typeof ctx.effect === 'function') ctx.effect(() => () => engine.dispose())
    } catch (err) {
      warnLog(ctx, `autodream 初始化失败（记忆本体不受影响）：${err?.message ?? err}`)
      // 异常路径额外打一行到 stderr：warnLog 走 ctx.logger，某些启动阶段它还没接上，
      // 而「autodream 静默不工作」正是最难查的那种故障（2026-09-27 为此绕了一大圈）。
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
        // 触发时当前这条用户消息还没写进 session。已在 DSH 检出里核实为真 ——
        //   dsh-agent-loop/lib/index.js:906  const claimed = this.inbox.claim(...)   // 只从 pending 队列取走
        //   dsh-agent-loop/lib/index.js:907  await this.loopCtx.systemPrompt.assemble(...)  // ← 本监听器在这里跑
        //   dsh-agent-loop/lib/index.js:1046 this.session.append("user/message", ...)  // 落 session 在 preStep 之后
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

        if (picked.length === 0) return assembled

        const parts = picked.map(f => {
          const body = f.content.length > MAX_CHARS_PER_FILE
            ? f.content.slice(0, MAX_CHARS_PER_FILE) + '\n…（截断）'
            : f.content
          return `### ${f.file}\n${body}`
        })

        return {
          ...assembled,
          contexts: [...(assembled.contexts ?? []), {
            name: 'sage-mem:recall',
            order: 1000,
            text: `以下是与你当前问题相关的历史记忆（文件式，来自 ${MEMORY_DIR}）：\n\n${parts.join('\n\n')}`,
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
}

markRemote(MemoryGateway, 'listFiles', 'listFiles')
markRemote(MemoryGateway, 'readFile', 'readFile')
markRemote(MemoryGateway, 'writeFile', 'writeFile')
markRemote(MemoryGateway, 'deleteFile', 'deleteFile')

/** 提取正文第一个 `# ` 标题作为展示标题。 */
function extractTitle(content) {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---/)
  const body = m ? content.slice(m[0].length) : content
  const h1 = body.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : ''
}

/** 扫记忆目录，读全部 .md（跳过索引与 session-log），带体积与修改时间。 */
async function scanStars(ctx) {
  let entries
  try {
    entries = await readdir(MEMORY_DIR, { withFileTypes: true })
  } catch (err) {
    if (err?.code !== 'ENOENT') warnLog(ctx, `cannot scan ${MEMORY_DIR}: ${err?.message ?? err}`)
    return []
  }
  const names = entries
    .filter(e => e.isFile() && isMemoryEntry(e.name))
    .map(e => e.name)
  const loaded = await Promise.all(names.map(async (name) => {
    try {
      const full = join(MEMORY_DIR, name)
      const [content, info] = await Promise.all([readFile(full, 'utf8'), stat(full)])
      return { name, content, bytes: info.size, mtimeMs: info.mtimeMs }
    } catch (err) {
      if (err?.code !== 'ENOENT') warnLog(ctx, `cannot read ${name}: ${err?.message ?? err}`)
      return null
    }
  }))
  return loaded.filter(Boolean)
}

/**
 * 记忆星图（host 半）—— 只读扫描记忆目录，把每条记忆解析成一颗「星」。
 * 通过 TypertRemoteService 暴露两个 remote 方法给浏览器半：
 *   - starmap.listStars()  全部星（元数据，不含正文）
 *   - starmap.readFile(n)  单条记忆全文（文件名白名单校验）
 */
export class StarmapGateway extends TypertRemoteService {
  constructor(ctx) { super(ctx, 'starmap') }

  async listStars() {
    const files = await scanStars(this.ctx)
    const stars = files.map(f => {
      const meta = parseFrontmatter(f.content)
      const title = extractTitle(f.content)
      return {
        file: f.name,
        kind: meta.type || 'special',
        title: title || meta.name || (meta.description ? meta.description.slice(0, 24) : f.name.replace(/\.md$/, '')),
        desc: meta.description || '',
        bytes: f.bytes,
        mtimeMs: f.mtimeMs,
      }
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
  selectRelevant,
  selectBaseline,
  limits: { MAX_RESULTS, MAX_CHARS_PER_FILE, MAX_BASELINE },
}
