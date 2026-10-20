/**
 * sage-mem 记忆层 —— 目录位置、各项上限与引用纪律。
 *
 * 记忆目录 / 状态根怎么定、注入条数与体积上限是多少、`reserved.json` 保护名单怎么读，
 * 全在这儿。常量值与拆分前逐字一致。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { INDEX_FILE_KEY, SESSION_LOG_KEY, isPlainMdName } from '../shared/md-name.js'

export const MEMORY_DIR = process.env.SAGE_MEM_DIR || join(homedir(), '.sage-mem', 'memory')
/**
 * DSH 会话记录根目录。autodream 的门控靠它数「上次整理之后有几个会话更新」，
 * `memory+sessions` 输入源下也会在里面做定向搜索。取不到就是空串，
 * 门控会退化成「会话数 0 → 不触发」，而不是报错。
 */
export const SESSIONS_ROOT = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : ''

/** 读一个整数型环境变量并在范围内收敛；取不到或非法就用默认值。 */
export function envInt(name, dflt, lo, hi) {
  // ⚠️ 必须先 trim：`Number('   ')` 是 **0** 而不是 NaN，于是纯空格的值会被
  // 当成「用户填了 0」——低于下限、被夹到 lo，静默变成「最小而不是默认」。
  // 实测过：`SAGE_MEM_MAX_RESULTS="   "` → 1。那与这行注释承诺的「非法就用默认值」相反。
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return dflt
  const n = Number(raw)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/**
 * 面板可改的 5 项注入上限 —— **唯一定义**（值 + 边界）。
 * 面板（\u0060lib/settings.js\u0060）、组合根、环境变量三处都从这里取，不再各写一份。
 */
export const LIMIT_SPECS = {
  maxResults: { env: 'SAGE_MEM_MAX_RESULTS', dflt: 10, lo: 1, hi: 30 },
  maxChars: { env: 'SAGE_MEM_MAX_CHARS', dflt: 1500, lo: 200, hi: 20000 },
  maxBaseline: { env: 'SAGE_MEM_MAX_BASELINE', dflt: 8, lo: 1, hi: 50 },
  maxSessionBytes: { env: 'SAGE_MEM_MAX_SESSION_BYTES', dflt: 60 * 1024, lo: 4096, hi: 512 * 1024 },
  staleDays: { env: 'SAGE_MEM_STALE_DAYS', dflt: 1, lo: 0, hi: 365 },
}
const fromSpec = (spec) => envInt(spec.env, spec.dflt, spec.lo, spec.hi)

/**
 * 一次注入最多带几条记忆。
 *
 * 5 → 10：**记忆条数 ÷ 注入名额 ≈ 命中率上限**，名额 5 时那个上限低到
 * 的根因就在这个比值上。名额翻倍是提升召回最直接的一手，代价是每轮多约 7.5K
 * 字符的上下文。**这个数字该由实测决定**，所以留了 SAGE_MEM_MAX_RESULTS 覆写口
 * （比较两档的命中率与 token 账单，别拍脑袋）。
 */
export const MAX_RESULTS = fromSpec(LIMIT_SPECS.maxResults)

/** 单条记忆注入的字符上限。 */
export const MAX_CHARS_PER_FILE = fromSpec(LIMIT_SPECS.maxChars)

/**
 * baseline 名额。
 *
 * baseline 条目通常不多，卡在 5 只会让靠后的条目永不出现——
 * 而 baseline 恰恰是短问题、恢复会话时唯一的兜底。现在放到 8，
 * 排序见下面「按显式优先级排，不按文件名」那段。
 */
export const MAX_BASELINE = fromSpec(LIMIT_SPECS.maxBaseline)

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
export const MAX_SESSION_BYTES = fromSpec(LIMIT_SPECS.maxSessionBytes)

/**
 * 状态卡预留占总预算的比例，以及它的上下夹逼区间。
 *
 * **为什么要把 60 KB 拆成两本账**：到顶之后旧行为是 `parts.length === 0` → 一个字都不注，
 * 连「为什么没注、还能怎么查」都没有。而那个上限是本插件**自己定的**（不是宿主约束），
 * 所以完全可以给它留一份固定额度。
 *
 * 5% 与 [1 KB, 4 KB] 的取值：状态卡单张上限 512 字节，4 KB 够发 8 张；而 4 KB 在
 * 60 KB 里占 6.7%，不至于挤掉正文。**总上限数字保持不变** —— 面板滑杆、既有文档、
 * 用户对「60 KB」的直觉都不用改。
 */
export const STATUS_RESERVE_RATIO = 0.05
export const STATUS_RESERVE = Math.max(1024, Math.min(4096, Math.round(MAX_SESSION_BYTES * STATUS_RESERVE_RATIO)))

/**
 * 正文可用额度 = 总上限 − 状态卡预留。
 *
 * 两本账**互不借用**：正文池满了仍然发得出卡（卡的额度本来就留着，这正是预留的意义），
 * 而卡池满了不会再从正文池借 —— 借了等于把「预留」这件事作废。
 */
export const CONTENT_BUDGET = MAX_SESSION_BYTES - STATUS_RESERVE

/**
 * 注入文本里标「保存于 N 天前」的门槛（天）。超了才标；0 = 每条都标。
 *
 * 为什么用「N 天前」而不是日期：模型不擅长日期算术，绝对时间戳几乎不触发陈旧
 * 推理，相对天数才会。为什么需要它：陈旧记忆被当事实引用时，「引用」这个动作
 * 本身会让它显得更权威、而不是更可疑。
 */
export const STALE_DAYS = fromSpec(LIMIT_SPECS.staleDays)

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
export const RECALL_DISCIPLINE = [
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
export const STATE_ROOT = process.env.SAGE_MEM_STATE_DIR || join(dirname(MEMORY_DIR), '.sage-mem')

/**
 * 读使用者自己声明的额外保护名单：`<状态根>/reserved.json`，形如 `["a.md","b.md"]`。
 *
 * 读不到、JSON 坏、不是数组 —— 一律当空数组返回。**一份可选的保护名单，
 * 绝不该有能力让插件加载失败。**
 */
export function readExtraReserved() {
  try {
    const arr = JSON.parse(readFileSync(join(STATE_ROOT, 'reserved.json'), 'utf8'))
    if (!Array.isArray(arr)) return []
    return arr
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => isPlainMdName(s) && !s.startsWith('..'))
  } catch {
    return []
  }
}

export const RESERVED_FILES = new Set([INDEX_FILE_KEY, SESSION_LOG_KEY, ...readExtraReserved()])

/**
 * 非记忆条目：不参与检索 / 不进星图 / 不出现在设置页列表里，读写也一律不通。
 *
 * 是 RESERVED_FILES 的子集，区别在「列不列出来」：MEMORY.md 是索引、
 * session-log.md 是追加型流水，两者都不是一条记忆；
 * 而使用者手写维护的重要记忆是正常记忆条目（它们该被检索到）。
 * （要出现在列表与星图里、要能读），只是不许从表单写/删。
 */
export const NON_ENTRY_FILES = new Set([
  INDEX_FILE_KEY,
  SESSION_LOG_KEY,
])

/**
 * 单文件体积上限（字节）。定 512 KB 的理由：
 *   - 单条正文通常在几十 KB 以内，索引与流水都排除在外，
 *     512 KB 是它的 26 倍，任何正常记忆都够用；
 *   - 记忆是要塞进 system prompt 的，一条 512 KB 的记忆本身就等于把上下文撑爆——
 *     到这个量级基本可以判定是写错了目标（比如把日志、代码贴进来）。
 * 与 lib/typert.host.js 的 fileContentSchema.max(512 * 1024) 保持一致。
 */
export { MAX_FILE_BYTES } from '../shared/limits.js'
