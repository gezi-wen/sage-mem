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
import { readFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
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
 * 5 → 10：**记忆条数 ÷ 注入名额 ≈ 命中率上限**，名额 5 时那个上限低到
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
 * baseline 条目通常不多，卡在 5 只会让靠后的条目永不出现——
 * 而 baseline 恰恰是短问题、恢复会话时唯一的兜底。现在放到 8，
 * 排序见下面「按显式优先级排，不按文件名」那段。
 */
const MAX_BASELINE = envInt('SAGE_MEM_MAX_BASELINE', 8, 1, 50)

/**
 * 单会话累计注入字节上限 —— 到顶以后这个会话就不再注入新的记忆。
 *
 * 为什么要有：条数上限（MAX_RESULTS）管的是「一次」注入多少，管不了「一场会话注
 * 多少次」。长会话里问题一直在换、检索签名一直在变，于是走一步注一批，累积没有
 * 上限 —— 实测某个高重合的短问题一次就注 7,700 字符，八次就到 60 KB。
 * Claude Code 有同一层闸门（`MAX_SESSION_BYTES = 60 * 1024`，到顶**彻底停止**预取），
 * 本插件此前只有单条上限、没有会话上限。
 *
 * 60 KB 是与 CC 对齐的起点、不是实测出来的数字 —— 留了 SAGE_MEM_MAX_SESSION_BYTES
 * 覆写口，量过再定。
 */
const MAX_SESSION_BYTES = envInt('SAGE_MEM_MAX_SESSION_BYTES', 60 * 1024, 4096, 512 * 1024)

/**
 * 注入文本里标「保存于 N 天前」的门槛（天）。超了才标；0 = 每条都标。
 *
 * 为什么用「N 天前」而不是日期：模型不擅长日期算术，绝对时间戳几乎不触发陈旧
 * 推理，相对天数才会。为什么需要它：陈旧记忆被当事实引用时，「引用」这个动作
 * 本身会让它显得更权威、而不是更可疑。
 */
const STALE_DAYS = envInt('SAGE_MEM_STALE_DAYS', 1, 0, 365)

/**
 * 注入文本开头的引用纪律 —— **必须独立成节，不能压成一条 bullet**。
 *
 * Claude Code 对这条做过 A/B：同一句内容埋成 bullet 命中 0/3，独立成节 3/3，
 * 连标题措辞都验过。原因很实在：陈旧记忆被当事实引用时，「引用」这个动作本身
 * 会让它显得更权威而不是更可疑 —— 规矩得在**读这批内容之前**先立。
 *
 * 每次注入都带（约 150 字符），不按会话只带一次：它约束的是「这一批」怎么用，
 * 与批次绑定比与会话绑定更不容易失效。
 */
const RECALL_DISCIPLINE = [
  '> **引用纪律**：以下是过去某一刻写下的记录，不是当前事实。',
  '> 提到文件路径先确认存在，提到函数 / 配置项先 grep，要据此动手前先核实当前代码。',
  '> 标了「保存于 N 天前」的尤其注意：其中的 `文件:行号` 很可能已经过期。',
  '> 「记忆里写着 X 存在」不等于「X 现在存在」。',
].join('\n')

/**
 * 结构性保留名：设置页的写/删方法一律不得触碰。
 *
 * 只列**结构决定必须保护**的两个：
 *   1. `MEMORY.md` —— 索引。它被整份覆盖就等于索引没了（「+ 添加记忆」表单是照
 *      buildFrontmatter() 重建 frontmatter 的，原有内容一个字都留不下）。
 *   2. `session-log.md` —— 追加型流水，体量最大，同样经不起一份重建。
 *
 * ⚠️ **除了这两个，别把任何具体记忆的文件名写死在这里。**
 * 「哪几条记忆特别要紧」是**使用者的私事**——把它编进随包发布的代码，等于把作者的
 * 记忆主题发给每一个装这个插件的人。
 * 用户自己的保护名单放在 `<状态根>/reserved.json`（JSON 字符串数组），见下。
 *
 * ⚠️ 全部小写存放，比较一律走 nameKey()（NTFS 不区分大小写，集合里放 'MEMORY.md'
 * 而拿 'memory.md' 去 has() 是查不到的 —— 曾经就是这个漏洞：表单里填 memory.md
 * 就能整份覆盖索引，deleteFile 还能不可逆删掉它）。
 */
const STATE_ROOT = process.env.SAGE_MEM_STATE_DIR || join(dirname(MEMORY_DIR), '.sage-mem')

/**
 * 读使用者自己声明的额外保护名单：`<状态根>/reserved.json`，形如 `["a.md","b.md"]`。
 *
 * 读不到、JSON 坏、不是数组 —— 一律当空数组返回。**一份可选的保护名单，
 * 绝不该有能力让插件加载失败。**
 */
function readExtraReserved() {
  try {
    const arr = JSON.parse(readFileSync(join(STATE_ROOT, 'reserved.json'), 'utf8'))
    if (!Array.isArray(arr)) return []
    return arr
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => s.endsWith('.md') && !s.includes('/') && !s.includes('\\') && !s.startsWith('..'))
  } catch {
    return []
  }
}

const RESERVED_FILES = new Set(['memory.md', 'session-log.md', ...readExtraReserved()])

/**
 * 非记忆条目：不参与检索 / 不进星图 / 不出现在设置页列表里，读写也一律不通。
 *
 * 是 RESERVED_FILES 的子集，区别在「列不列出来」：MEMORY.md 是索引、
 * session-log.md 是追加型流水，两者都不是一条记忆；
 * 而使用者手写维护的重要记忆是正常记忆条目（它们该被检索到）。
 * （要出现在列表与星图里、要能读），只是不许从表单写/删。
 */
const NON_ENTRY_FILES = new Set([
  'memory.md',
  'session-log.md',
])

/**
 * 单文件体积上限（字节）。定 512 KB 的理由：
 *   - 单条正文通常在几十 KB 以内，索引与流水都排除在外，
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
        const full = join(MEMORY_DIR, name)
        // stat 与 readFile 并行 —— 多要一个 mtime 不该变成串行两跳。
        const [content, info] = await Promise.all([readFile(full, 'utf8'), stat(full)])
        const meta = parseFrontmatter(content)
        return {
          file: name,
          content,
          description: meta.description || '',
          aliases: meta.aliases || [],
          baseline: parseBaseline(content),
          baselinePriority: meta.baselinePriority || 0,
          // 新鲜度的两个来源：frontmatter 的 updated（权威）与文件 mtime（退路）。
          updated: meta.updated || '',
          mtimeMs: info.mtimeMs,
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
 * 文件长度 —— 越长的记忆越容易蒙中。实测：长记忆在全文匹配下对任何问题都能
 * 蒙中足量双字组，连寒暄问句都能注入上千 token；而真正该命中的那条反被
 * 挤掉。description 是「一句话说清这条是什么」的精准摘要，用它当检索
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
  // 症状极具欺骗性。下文定义的 parseBaseline 与 extractTitle 早已是 \r?\n。
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { name: '', description: '', type: '', tags: [], aliases: [], updated: '', baselinePriority: 0 }
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
  // `updated` 踩的是与 `type` 同一个坑：它通常写在 `metadata:` 嵌套块里（缩进两格），
  // 顶层 `^updated:` 抓不到 —— 于是「明明写了日期却永远显示不出来」。
  // 抓不到就回落文件 mtime（见 ageDays）：手写时间戳是权威的，文件系统时间只是退路。
  let updated = grab('updated')
  if (!updated) {
    const nestedUpdated = body.match(/^metadata:\s*\r?\n(?:\s+[^\r\n]+\r?\n)*?\s+updated:\s*(\S+)/m)
    if (nestedUpdated) updated = nestedUpdated[1]
  }
  return {
    name: grab('name'),
    description: grab('description'),
    type,
    tags: parseTags(body),
    aliases: parseAliases(body),
    updated,
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
 * 一条记忆「多久以前写下的」（整数天；null = 无从判断）。
 *
 * **优先 frontmatter 的 `updated`，缺失才回落文件 mtime —— 顺序不能反。**
 * 文件系统时间会被复制、checkout、备份还原整批改掉，它表示的是「这个文件什么时候
 * 被动过」，不是「这条记忆什么时候写的」。手写的时间戳才是权威。
 *
 * 未来日期（时钟偏差 / 手写错）一律当 0：宁可标「今天」也不要标负数。
 */
function ageDays(f, nowMs) {
  const fromMeta = Date.parse(f?.updated || '')
  const base = Number.isFinite(fromMeta) ? fromMeta : (Number.isFinite(f?.mtimeMs) ? f.mtimeMs : NaN)
  if (!Number.isFinite(base)) return null
  const days = Math.floor((nowMs - base) / 86400000)
  return days > 0 ? days : 0
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
 * session-log.md**，于是 `starmap.readFile('session-log.md')` 能把整份流水
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

        if (picked.length === 0) return assembled

        // ── 单会话累计预算 ──
        // 账记在 session id 上；消息条数变小 = 压缩/清空发生过 → 账本归零（见上面
        // injectLedger 的注释）。picked 里 baseline 永远排在检索结果之前，所以预算
        // 不够时先被挤掉的是「更晚才想起来的」那些 —— baseline 有优先权。
        const ledgerKey = session.id || 'no-session-id'
        const prevLedger = injectLedger.get(ledgerKey)
        let usedBytes = prevLedger && messages.length >= prevLedger.messageCount ? prevLedger.bytes : 0
        const nowMs = Date.now()

        const parts = []
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
        }

        // 被预算挡掉了全部条目 —— 一个字都不注。本会话已经注进去的那批还在上下文里，
        // 每步再塞一条「预算已满」只是白花 token；真压缩过之后账本会自己归零。
        if (parts.length === 0) return assembled

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
 * 记忆星图（宿主侧）—— 只读扫描记忆目录，把每条记忆解析成一颗「星」。
 * 通过 TypertRemoteService 暴露两个 remote 方法给界面侧：
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
  ageDays,
  selectRelevant,
  selectBaseline,
  limits: { MAX_RESULTS, MAX_CHARS_PER_FILE, MAX_BASELINE, MAX_SESSION_BYTES, STALE_DAYS },
  recallDiscipline: RECALL_DISCIPLINE,
}
