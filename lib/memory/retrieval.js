/**
 * sage-mem 记忆层 —— 检索：双字打分、名额裁剪、baseline 排序、新鲜度换算。
 */

import { MAX_BASELINE, MAX_RESULTS } from './config.js'
import { buildStats, evidence, idfOf, queryTermsOf, termFreq, tokenize } from './bm25.js'

/** 提取消息文本，兼容 content 为字符串或 text-block 数组两种形态。 */
export function extractText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

/** 提取双字（2-gram）集合，中英文数字通用。 */
export function bigrams(s) {
  const clean = String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

/** query 的双字在 text 中的覆盖率（0~1），作为相关性得分。 */
export function score(query, text) {
  const q = bigrams(query)
  if (q.size === 0) return 0
  const t = bigrams(text)
  let hit = 0
  for (const g of q) if (t.has(g)) hit++
  return hit / q.size
}

/**
 * 摘要命中的相关性门槛：**命中的词元得带够信息量**，按语料自身的 IDF 尺度归一。
 *
 * 为什么单靠「覆盖率 > 0」不够（在真实记忆目录上实测）：中文里「怎么」「什么」这类词元
 * 在大量 `description` 里都有，于是一句完全无关的「今天天气怎么样」能靠一个「怎么」
 * 命中 **14 份**记忆、一次注入近 30 KB —— 而它们全都卡在同一条分数线上
 * （实测中位数 = 最高值 0.167），排序完全分不出来。
 *
 * ⚠️ **判据是按语料尺度归一的比值，不是一个绝对量。** 这是同一个坑的第三次：
 * `idf` 随语料规模**对数增长**，绝对阈值换一个语料量级就失效。
 *   - 绝对 `sum >= 1.5` 在百份量级的目录里等于「命中一个出现在约四分之一文件里的词元就放行」——
 *     实测一个高频虚词单靠自己 sum 就有 2.01，一整批候选全部通过，门槛形同虚设；
 *   - 同一批真命中在 2 份的小目录里又全被杀（`idf(df=1)` 只有 0.69）。
 * 分母取 `idfOf(1, N)` = 这套语料里**单个词元的证据上限**（全库独一份的权重）——
 * 归一之后同一套阈值在两个量级上都成立。
 *
 * 效果实测（归一阈值 0.6）：
 *   - 真实目录：无关问题的候选数 **46 → 7**（-85%），相关题每问仍留 3–10 条
 *   - 离线评测集（端到端「摘要 ∪ 正文」）：**不只是没退化，而是更好了** ——
 *     Recall@5 58/69 → 60/69、段落严格命中 29/47 → 30/47、误注入 10/71 → 4/71。
 *     原因：被门槛清掉的弱摘要候选原先在**挤占前 5 名的名额**，把更好的正文命中挡在外面。
 *     ⚠️ 只量摘要一侧会得出「掉 8 个点」的错误结论 —— 务必量端到端。
 *
 * 要放宽就在调用处传 `{ minRatio: 0 }`，别改这个常量。
 */
export const MIN_SUMMARY_EVIDENCE_RATIO = 0.6

/**
 * 门槛生效所需的最小语料规模。
 *
 * IDF 要**够多的文档**才有分辨率。八份以下的目录里，「到处都有」与「只此一份」在数值上
 * 几乎不可分：实测两份记忆时 `idf(df=1)` 只有 0.69，而一份语料里 4 份记忆的描述都相同
 * （df = N = 4）时更是趋近 0 —— 门槛会把**全部真命中**一起杀掉，用户看到的是「记忆不再
 * 注入」。小目录本来就没有多少噪音可防，所以这里直接不设门槛。
 */
export const MIN_GATE_CORPUS = 8

/** 摘要面的检索文本：`description` + `aliases` + 文件名。**打分与语料统计必须用同一份**。 */
export function summaryHay(f) {
  const aliasText = Array.isArray(f.aliases) && f.aliases.length ? ' ' + f.aliases.join(' ') : ''
  return f.description + aliasText + ' ' + f.file.replace(/\.md$/, '').replace(/[_-]/g, ' ')
}

/**
 * 相关性打分只用 frontmatter 的 description + 文件名，不扫全文。
 *
 * 旧版拿 query 的双字去全文里找，得分是「覆盖率」，分母是 query，不惩罚
 * 文件长度 —— 越长的记忆越容易蒙中。实测：长记忆在全文匹配下对任何问题都能
 * 蒙中足量双字组，连寒暄问句都能注入上千 token；而真正该命中的那条反被
 * 挤掉。description 是「一句话说清这条是什么」的精准摘要，用它当检索
 * 信号，噪音大幅下降。
 *
 * @param {string} query
 * @param {Array} files
 * @param {{gate?: boolean, minRatio?: number}} [opts] — `gate:false` 关掉证据门槛
 *   （测试「名额上限」这类与相关性无关的用例要它）
 */
export function selectRelevant(query, files, opts = {}) {
  const list = Array.isArray(files) ? files : []
  const hay = list.map(summaryHay)
  const entries = list.map((f, i) => ({ f, i, score: score(query, hay[i]) }))
  const hit = entries.filter(e => e.score > 0).sort((a, b) => b.score - a.score)
  const keep = (arr) => arr.slice(0, MAX_RESULTS).map(e => ({ ...e.f, score: e.score }))
  if (opts.gate === false || hit.length === 0) return keep(hit)
  // 语料太小就别用 IDF 判（见 MIN_GATE_CORPUS）。
  if (list.length < MIN_GATE_CORPUS) return keep(hit)

  const terms = queryTermsOf(query)
  if (!terms.length) return keep(hit)
  // 语料统计建在**全部文件**的摘要面上，不是只建在命中的那些上：IDF 的分母是
  // 「多少份记忆的摘要里有这个词元」，只拿命中集去算会把稀有词元算成随处可见。
  const tokens = hay.map(tokenize)
  const stats = buildStats(tokens.map(t => ({ tokens: t })))
  const tf = tokens.map(termFreq)
  const minRatio = Number.isFinite(opts.minRatio) ? opts.minRatio : MIN_SUMMARY_EVIDENCE_RATIO
  // **按语料自身的 IDF 尺度归一**，而不是用一个绝对量。
  //
  // 绝对量的教训（三次踩同一个坑，记下来免得第四次）：`idf` 随语料规模对数增长，
  // 所以「sum >= 1.5」在百份量级的目录里等于「命中一个约四分之一文件都有的词元就放行」——
  // 实测一个 `怎么`（df=14，idf=1.93）单靠自己就有 sum=2.01，整批 14 份候选全部通过，
  // 门槛退化成没有。而在 2 份的小目录里 `idf(df=1)` 只有 0.69，同一批真命中又全被杀。
  // 归一之后同一套阈值在两个量级上都成立。
  //
  // 分母取 `idfOf(1, N)` = 「全库独一份的词元能提供的最大权重」，也就是这套语料里
  // 单个词元的证据上限。
  const maxIdf = idfOf(1, list.length) || 1
  return keep(hit.filter(e => evidence(terms, tf[e.i], stats).sum >= minRatio * maxIdf))
}

/**
 * 选 baseline 条目：按显式 `baselinePriority` 排，不按文件名。
 *
 * 文件名排序等于让 `feedback_*` 无条件压过 `user_*`，与「哪条更该出现在每场
 * 会话开头」毫无关系。没写这个字段的老条目一律算 0，行为与从前一致。
 */
export function selectBaseline(files) {
  return files
    .filter(f => f.baseline)
    .sort((a, b) => (b.baselinePriority || 0) - (a.baselinePriority || 0) || a.file.localeCompare(b.file))
    .slice(0, MAX_BASELINE)
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
export function ageDays(f, nowMs) {
  const fromMeta = Date.parse(f?.updated || '')
  const base = Number.isFinite(fromMeta) ? fromMeta : (Number.isFinite(f?.mtimeMs) ? f.mtimeMs : NaN)
  if (!Number.isFinite(base)) return null
  const days = Math.floor((nowMs - base) / 86400000)
  return days > 0 ? days : 0
}
