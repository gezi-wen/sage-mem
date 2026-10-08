/**
 * sage-mem 记忆层 —— 目录位置、各项上限与引用纪律。
 *
 * 记忆目录 / 状态根怎么定、注入条数与体积上限是多少、`reserved.json` 保护名单怎么读，
 * 全在这儿。常量值与拆分前逐字一致。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const MEMORY_DIR = process.env.SAGE_MEM_DIR || join(homedir(), '.sage-mem', 'memory')
/**
 * DSH 会话记录根目录。autodream 的门控靠它数「上次整理之后有几个会话更新」，
 * `memory+sessions` 输入源下也会在里面做定向搜索。取不到就是空串，
 * 门控会退化成「会话数 0 → 不触发」，而不是报错。
 */
export const SESSIONS_ROOT = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : ''

/** 读一个整数型环境变量并在范围内收敛；取不到或非法就用默认值。 */
export function envInt(name, dflt, lo, hi) {
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
export const MAX_RESULTS = envInt('SAGE_MEM_MAX_RESULTS', 10, 1, 30)

/** 单条记忆注入的字符上限。 */
export const MAX_CHARS_PER_FILE = envInt('SAGE_MEM_MAX_CHARS', 1500, 200, 20000)

/**
 * baseline 名额。
 *
 * baseline 条目通常不多，卡在 5 只会让靠后的条目永不出现——
 * 而 baseline 恰恰是短问题、恢复会话时唯一的兜底。现在放到 8，
 * 排序见下面「按显式优先级排，不按文件名」那段。
 */
export const MAX_BASELINE = envInt('SAGE_MEM_MAX_BASELINE', 8, 1, 50)

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
export const MAX_SESSION_BYTES = envInt('SAGE_MEM_MAX_SESSION_BYTES', 60 * 1024, 4096, 512 * 1024)

/**
 * 注入文本里标「保存于 N 天前」的门槛（天）。超了才标；0 = 每条都标。
 *
 * 为什么用「N 天前」而不是日期：模型不擅长日期算术，绝对时间戳几乎不触发陈旧
 * 推理，相对天数才会。为什么需要它：陈旧记忆被当事实引用时，「引用」这个动作
 * 本身会让它显得更权威、而不是更可疑。
 */
export const STALE_DAYS = envInt('SAGE_MEM_STALE_DAYS', 1, 0, 365)

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
      .filter((s) => s.endsWith('.md') && !s.includes('/') && !s.includes('\\') && !s.startsWith('..'))
  } catch {
    return []
  }
}

export const RESERVED_FILES = new Set(['memory.md', 'session-log.md', ...readExtraReserved()])

/**
 * 非记忆条目：不参与检索 / 不进星图 / 不出现在设置页列表里，读写也一律不通。
 *
 * 是 RESERVED_FILES 的子集，区别在「列不列出来」：MEMORY.md 是索引、
 * session-log.md 是追加型流水，两者都不是一条记忆；
 * 而使用者手写维护的重要记忆是正常记忆条目（它们该被检索到）。
 * （要出现在列表与星图里、要能读），只是不许从表单写/删。
 */
export const NON_ENTRY_FILES = new Set([
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
export const MAX_FILE_BYTES = 512 * 1024
