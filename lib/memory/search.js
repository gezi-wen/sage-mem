/**
 * sage-mem 记忆层 —— 正文检索：把「段落打分」收口成一个可复用、可评测的检索面。
 *
 * 两层分工（这是本模块最要紧的一条设计）：
 *   - `rankChunks()` 返回**富对象**（段落 + 逐项分数 + 命中原因），给注入链和评测脚本用；
 *   - `retrieve()` 返回**线上形状**（wire shape），给 0.9.16 的 search_memory 工具用。
 *
 * 两者共用同一套排序，只是出口形状不同。**不要反过来让注入链去吃 wire shape** ——
 * 那会把「响应契约」和「内部评分」焊在一起，以后改一个字段名就动到注入行为。
 *
 * 缓存：段落切分与词元化都很贵（中文双字词元在 900 KB 语料上是十万量级），
 * 所以按**文件 revision 缓存**。文件没变就直接复用已切好的段落与词频表；
 * 目录里任何一份文件变了，语料统计（df / avgdl）会跟着重算 —— 语料统计是全局量，
 * 一篇文档的改动会影响所有词的 IDF。
 */

import { chunkFile, revisionOf } from './chunks.js'
import { buildStats, coverageOf, evidence, maxMatchedRun, queryTermsOf, scoreDoc, termFreq, tokenize, COVERAGE_WEIGHT } from './bm25.js'
import { score as summaryScore, selectRelevant } from './retrieval.js'
import { extractTitle } from './scan.js'

/** 工具响应的默认条数与上限（稿子 §5.2 的起始值）。 */
export const DEFAULT_LIMIT = 5
export const MAX_LIMIT = 10

/** 每个文件最多贡献几个段落 —— 不累加同一文件的所有段落得分，这是「长文不垄断」的关键。 */
export const PER_FILE_CHUNKS = 2

/** 单条片段的字符上限（稿子 §5.2 的起始值）。 */
export const EXCERPT_CHARS = 200

/**
 * 相关性门槛 —— **BM25 分数不是可用的判据**。
 *
 * 原因很实在：BM25 对任何问题都能给出非零分，只要有一个常用双字重合。中文语料里
 * 「怎么」「什么」「一个」这类词元的文档频率极高，任何问句都能撞上几个 ——
 * 于是「分数 > 0」等于「几乎总是有结果」，无关问题会从「什么都不注」变成「注一堆噪音」。
 *
 * 三个条件必须同时满足：
 *   - `ratio` ≥ 0.35：在「语料里存在过的 query 词元」里，这份文档覆盖了足够大的权重份额；
 *   - `sum`   ≥ 1.5 ：命中的词元绝对信息量够，不是「全是到处都有的词」凑出来的比值；
 *   - `rarestDfRatio` ≤ 0.10：至少有一个命中词元是**冷门**的。这条专治一种漏网：
 *     问句里一半的词在语料里压根不存在（df=0，被剔出分母），剩下的通用词恰好都命中，
 *     于是 ratio=1.0、sum 靠数量堆高，看起来证据很强 —— 实际命中的全是虚词。
 *   - **连续命中 ≥ 2 个词元**（= query 里至少 3 个字连着出现在文档里）。这条治的是
 *     中文双字词元的**跨词边界假词元**：「明天会不会下雨」里 `天会` 来自
 *     「那一天**会**缩短」，df=1、IDF 最大，单看「有个冷门词元命中」它反而最"强"。
 *     巧合通常孤立，真实内容词通常连成片段。
 *
 * ⚠️ **这三个数是起始参数，不是实测结论**，由 `scripts/eval-retrieval.mjs` 的对照
 * 结果来定（计划里阶段一的用途就是这个）。要放宽就用 `rankChunks(..., { minEvidence: false })`
 * 拿掉门槛，别去改这里的常量。
 *
 * 0.10 这个值来自一次对抗性扫参（16 份合成语料，其中 4 份**故意塞满通用词**，
 * 让无关问句一定能找到词面重合）：
 *
 * | 门槛 | 相关题留住 | 无关题误召回 |
 * |---|---|---|
 * | 无门槛 | 12/12 | 4/12 |
 * | 只 ratio | 12/12 | 4/12 |
 * | ratio+sum | 12/12 | 1/12（`红烧肉怎么做才好吃`）|
 * | +rarest ≤ 0.15 | 12/12 | 1/12 |
 * | **+rarest ≤ 0.10** | **12/12** | **0/12** |
 * | +rarest ≤ 0.05 | 0/12 | 0/12 |
 *
 * 相关题命中的最冷门词元都是 0.0625，硬负例是 0.125 —— 0.10 落在分离带里。
 * ⚠️ 该值在**小语料**上定出；真实语料的 df/N 量级不同（段落数越多，同一个词元的 df/N 越小），
 * 阶段一的评测脚本要在真实量级上复核一次再定稿。
 */
export const MIN_EVIDENCE_RATIO = 0.35
export const MIN_EVIDENCE_SUM = 1.5
export const MAX_EVIDENCE_DF_RATIO = 0.1

/**
 * 最少要**连续命中**几个词元（默认 2 = query 里至少 3 个字连着出现在文档里）。
 *
 * 设为 1 就等于关掉这条判据。代价与理由见 `bm25.maxMatchedRun` 的注释。
 */
export const MIN_MATCHED_RUN = 2

/** 缓存文件数上限。语料只有 109 份时永不触发；它防的是目录被塞进成千上万份文件。 */
const MAX_CACHE_FILES = 1024

/** file → {revision, title, chunks:[{...,tokens,tf,dl}]} */
const chunkCache = new Map()

/** 语料统计缓存：`{sig, stats}`。sig 由参与的文件 revision 拼成，变了就重算。 */
let statsCache = { sig: '', stats: { N: 0, avgdl: 1, df: new Map() } }

/** 只给测试用：清掉进程内缓存，让「改了文件」的场景能从头验。 */
export function __resetSearchCacheForTest() {
  chunkCache.clear()
  statsCache = { sig: '', stats: { N: 0, avgdl: 1, df: new Map() } }
}

/**
 * 取得全部段落与语料统计（带缓存）。
 *
 * @param {Array<{file:string,content:string,mtimeMs?:number}>} files
 * @returns {{chunks:Array, stats:object, skipped:number, complete:boolean}}
 */
export function chunksOf(files) {
  const list = Array.isArray(files) ? files : []
  const chunks = []
  const revisions = []
  let skipped = 0
  for (const f of list) {
    const file = String(f?.file ?? '')
    const content = String(f?.content ?? '')
    if (!file) continue
    const revision = revisionOf(content)
    revisions.push(`${file}:${revision}`)
    const hit = chunkCache.get(file)
    if (hit && hit.revision === revision) {
      for (const c of hit.chunks) chunks.push(c)
      continue
    }
    try {
      const title = extractTitle(content)
      const built = chunkFile({ file, content }, revision).map(c => {
        const tokens = tokenize(`${c.headingPath}\n${c.text}`)
        return { ...c, title, tokens, tf: termFreq(tokens), dl: tokens.length }
      })
      chunkCache.set(file, { revision, title, chunks: built })
      for (const c of built) chunks.push(c)
    } catch {
      // 切分失败的文件计入 skipped 并把 complete 置否 —— 检索结果必须能自报「我没查全」，
      // 不能让一个坏文件静默地变成「这篇没命中」。
      skipped++
    }
  }
  // LRU 也不做，只做整体清理：超限说明目录形态异常，重算比留着更安全。
  if (chunkCache.size > MAX_CACHE_FILES) {
    for (const key of [...chunkCache.keys()].slice(0, chunkCache.size - MAX_CACHE_FILES)) chunkCache.delete(key)
  }
  const sig = revisions.join('|')
  if (statsCache.sig !== sig) {
    statsCache = { sig, stats: buildStats(chunks) }
  }
  return { chunks, stats: statsCache.stats, skipped, complete: skipped === 0 }
}

/**
 * 正文排序：段落打分 → 每文件限量 → 全局裁剪。
 *
 * @param {string} query
 * @param {Array} files — `scanMemoryFiles` 的结果
 * @param {{perFile?:number, limit?:number}} [opts]
 * @returns {Array<{chunk:object, file:string, revision:string, bm25:number, coverage:number, score:number, matchedBy:string[]}>}
 */
export function rankChunks(query, files, opts = {}) {
  return rankChunksInternal(query, files, opts).hits
}

/**
 * 与 `rankChunks` 同一套排序，但额外报告「被相关性门槛滤掉多少条」——
 * `retrieve` 的 coverage 要如实说明「有候选但不够格」，而不是把它伪装成「没有候选」。
 *
 * `opts.minEvidence === false` 关掉门槛（评测脚本对照两组时要它）。
 * `opts.limit` 只兜底、**不封顶**（`MAX_LIMIT` 是 `retrieve` 那一层的收敛口径）：
 * 内部调用要用 `Infinity` 拿完整排名。两个入口语义不同是有意的，别记混。
 */
export function rankChunksInternal(query, files, opts = {}) {
  const perFile = Number.isFinite(opts.perFile) ? Math.max(1, opts.perFile) : PER_FILE_CHUNKS
  // `Infinity` = 不切片，要完整排名（`retrieve` 用它算 `candidates` 与翻页）。
  // 不能写成 `Number.isFinite(Infinity)` 那条分支：Infinity 不是有限数，会被当成「没传」回落默认值。
  const limit = opts.limit === Infinity
    ? Infinity
    : (Number.isFinite(opts.limit) ? Math.max(1, opts.limit) : DEFAULT_LIMIT)
  const terms = queryTermsOf(query)
  if (!terms.length) return { hits: [], filtered: 0, chunks: 0 }
  // 有序词元（含重复）——「连续命中」判据要顺序，去重后的集合没有位置信息。
  const queryTokens = tokenize(query)
  const { chunks, stats } = chunksOf(files)
  if (!chunks.length) return { hits: [], filtered: 0, chunks: 0 }
  // `minEvidence` 三态：省略 → 用默认门槛；`false` → 完全不设门槛；
  // 传对象 → 用自定义门槛（评测脚本扫参要用，免得为了换一个数字去改常量）。
  const gate = opts.minEvidence === false
    ? null
    : {
        ratio: opts.minEvidence?.ratio ?? MIN_EVIDENCE_RATIO,
        sum: opts.minEvidence?.sum ?? MIN_EVIDENCE_SUM,
        maxDfRatio: opts.minEvidence?.maxDfRatio ?? MAX_EVIDENCE_DF_RATIO,
        minRun: opts.minEvidence?.minRun ?? MIN_MATCHED_RUN,
      }

  let filtered = 0
  const scored = []
  for (const c of chunks) {
    const bm25 = scoreDoc(terms, c.tf, c.dl, stats)
    if (bm25 <= 0) continue
    const ev = evidence(terms, c.tf, stats)
    // 冷门判据是**析取**：`df ≤ 1`（全库独一份）或 `df/N ≤ 门槛`。
    // 只用比值会在小语料上把真命中全滤掉（5 份记忆的目录里，独一份的词元比值也是 0.2）。
    const rare = ev.rarestDf <= 1 || ev.rarestDfRatio <= gate?.maxDfRatio
    const run = maxMatchedRun(queryTokens, c.tf)
    // `sum` 用的是 IDF，而 IDF **随语料规模对数增长** —— 绝对阈值同样不可迁移：
    // 单段语料（N=1）里 df=1 的词元 idf 只有 0.288，一个原样命中的 `FS_STALE_VERSION`
    // 四个词元加起来才 1.15，会被 `sum ≥ 1.5` 整条滤掉。
    // 所以给 `sum` 一个**逃生口**：命中的是「全库独一份」的词元**且**连成片段（run 达标）时，
    // 它就是强证据，不再看绝对量。这与 `rare` 的析取是同一个理由，只是换了个量。
    const uniqueAndContiguous = ev.rarestDf <= 1 && run >= (gate?.minRun ?? 1)
    if (gate && (ev.ratio < gate.ratio || (!uniqueAndContiguous && ev.sum < gate.sum) || !rare || run < gate.minRun)) {
      filtered++
      continue
    }
    const coverage = coverageOf(terms, c.tf)
    scored.push({
      chunk: c,
      file: c.file,
      revision: c.revision,
      bm25,
      coverage,
      evidence: Number(ev.ratio.toFixed(4)),
      evidenceSum: Number(ev.sum.toFixed(4)),
      evidenceRarest: Number(ev.rarestDfRatio.toFixed(4)),
      evidenceRarestDf: Number.isFinite(ev.rarestDf) ? ev.rarestDf : null,
      evidenceRun: run,
      score: bm25 + COVERAGE_WEIGHT * coverage,
      matchedBy: exactTermHit(String(query), c.text) ? ['body', 'exact-term'] : ['body'],
    })
  }
  scored.sort((a, b) => b.score - a.score)

  // 每文件限量：同一份长文件用五个段落占满候选位，是「长文垄断」的另一种形态。
  const perFileCount = new Map()
  const kept = []
  for (const hit of scored) {
    const n = perFileCount.get(hit.file) ?? 0
    if (n >= perFile) continue
    perFileCount.set(hit.file, n + 1)
    kept.push(hit)
    if (kept.length >= limit) break
  }
  return { hits: kept, filtered, chunks: chunks.length }
}

/**
 * 摘要命中（复用 retrieval.js 的 `selectRelevant`，不另写一套打分）。
 *
 * 只额外做一件事：**说清是哪一栏命中的**。摘要命中与正文命中在展示层的处理不同
 * （前者给指针就够，后者才值得端正文），所以这个理由是行为契约的一部分。
 */
export function summaryHits(query, files, limit = DEFAULT_LIMIT) {
  if (!String(query ?? '').trim()) return []
  return selectRelevant(query, files).slice(0, limit).map(f => {
    const fileBase = f.file.replace(/\.md$/, '').replace(/[_-]/g, ' ')
    const matchedBy = []
    if (f.description && summaryScore(query, f.description) > 0) matchedBy.push('description')
    if (Array.isArray(f.aliases) && f.aliases.length && summaryScore(query, f.aliases.join(' ')) > 0) matchedBy.push('alias')
    if (summaryScore(query, fileBase) > 0) matchedBy.push('filename')
    return {
      file: f.file,
      revision: revisionOf(String(f.content ?? '')),
      score: f.score,
      // 回落标签是 `summary` 而不是 `description`：`retrieval.js` 的打分是**三个字段去标点
      // 拼成一串**之后再算双字，所以跨字段边界也能产生命中（`description: '收尾待'` +
      // `aliases: ['办清单']` 会被 query「待办」选中）。逐字段复算时三个字段各自为 0，
      // 回落成 `description` 就是在**谎报命中原因** —— 展示层会据此给出错的解释。
      matchedBy: matchedBy.length ? matchedBy : ['summary'],
    }
  })
}

/**
 * 检索。返回线上形状（稿子 §5.2）。
 *
 * scope 语义：
 *   - `summary` 只比摘要 —— 普通问题先走这条，最省；
 *   - `body` 只扫正文段落；
 *   - `all`    两者合并，**摘要优先、同文件不重复占位**。
 *
 * 「摘要优先」不是偏好，是成本：摘要命中的那条本来就要被注入，正文再给它一个位置等于
 * 同一份证据占两个候选位。合并时同文件只保留一条，带上它最好的段落。
 */
export function retrieve(input = {}) {
  const query = String(input.query ?? '')
  const files = Array.isArray(input.files) ? input.files : []
  const scope = normalizeScope(input.scope)
  const limit = clampLimit(input.limit)
  const perFile = Number.isFinite(input.perFile) ? Math.max(1, input.perFile) : PER_FILE_CHUNKS
  const excerptChars = Number.isFinite(input.excerptChars) ? Math.max(40, input.excerptChars) : EXCERPT_CHARS
  const cursor = Number.isFinite(input.cursor) && input.cursor > 0 ? Math.floor(input.cursor) : 0

  const corpus = chunksOf(files)
  const { skipped, complete } = corpus
  const terms = queryTermsOf(query)

  // ⚠️ 两路的候选池都必须**比本页窗口宽**，否则 `candidates` 是本页条数、`nextCursor` 永远是 null
  // （summary 一路曾经就是这样：池宽 = `limit + cursor`，于是翻页根本翻不动）。
  // 取满再切窗口，是本模块唯一正确的做法。
  const bodyRanked = scope === 'summary'
    ? { hits: [], filtered: 0, chunks: 0 }
    : rankChunksInternal(query, files, { perFile, limit: Infinity })
  const body = bodyRanked.hits
  const byFile = new Map()
  for (const hit of body) if (!byFile.has(hit.file)) byFile.set(hit.file, hit)

  // `Infinity` = 取满 `selectRelevant` 给的候选（它自己按 MAX_RESULTS 封顶）。
  // 曾经这里写的是 `limit + cursor` —— 池宽恰好等于本页窗口，于是 total 恒等于 cursor+limit、
  // `nextCursor` 恒为 null，翻页**根本翻不动**（只有第一页）。池宽必须大于窗口。
  const summary = scope === 'body' ? [] : summaryHits(query, files, Infinity)
  const summaryByFile = new Map()
  for (const s of summary) if (!summaryByFile.has(s.file)) summaryByFile.set(s.file, s)

  const ordered = []
  for (const s of summaryByFile.values()) ordered.push(toHit(s.file, s, byFile.get(s.file), terms, excerptChars))
  for (const [file, b] of byFile) {
    if (summaryByFile.has(file)) continue
    ordered.push(toHit(file, null, b, terms, excerptChars))
  }
  // 两类都命中 → 排前面（同一份证据被两条独立信号指向）；其余按分数排。
  ordered.sort((a, b) => Number(b.matchedBy.length > 1) - Number(a.matchedBy.length > 1) || b.score - a.score)

  const total = ordered.length
  const hits = ordered.slice(cursor, cursor + limit)
  return {
    ok: true,
    scope,
    cursor,
    coverage: {
      searched: files.length,
      skipped,
      complete,
      chunks: corpus.chunks.length,
      // 被相关性门槛滤掉的条数：必须如实报出来，否则「不够格」会被读成「没有候选」——
      // 这两件事对模型下一步该干什么的指示完全不同。
      filteredBelowFloor: bodyRanked.filtered,
      candidates: total,
    },
    hits,
    nextCursor: cursor + limit < total ? cursor + limit : null,
  }
}

function toHit(file, summary, body, terms, excerptChars) {
  const score = (summary?.score ?? 0) + (body?.score ?? 0)
  const matchedBy = [...(summary?.matchedBy ?? []), ...(body?.matchedBy ?? [])]
  const text = body?.chunk?.text ?? ''
  return {
    id: body?.chunk?.id ?? `${file}#summary`,
    file,
    revision: body?.revision ?? summary?.revision ?? '',
    title: body?.chunk?.title ?? '',
    headingPath: body?.chunk?.headingPath ?? '',
    lines: body?.chunk ? [body.chunk.startLine, body.chunk.endLine] : null,
    excerpt: text ? excerptAround(text, terms, excerptChars) : '',
    // 证据强度：调用方要能判别「这条凭什么算相关」，而不只看到一个分数。
    evidence: body?.evidence ?? null,
    evidenceSum: body?.evidenceSum ?? null,
    evidenceRarest: body?.evidenceRarest ?? null,
    evidenceRarestDf: body?.evidenceRarestDf ?? null,
    evidenceRun: body?.evidenceRun ?? null,
    score: Number(score.toFixed(4)),
    matchedBy: matchedBy.length ? matchedBy : ['body'],
  }
}

/** scope 归一：只认三个值，其余一律当 `all`（**不悄悄降级成 summary**，见稿子 §5.2）。 */
export function normalizeScope(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  return s === 'summary' || s === 'body' ? s : 'all'
}

function clampLimit(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(n)))
}

/**
 * 片段：以**第一个命中位置**为中心截取，而不是永远取开头。
 *
 * 取开头是错的：一份 900 字的段落里第 600 字才提到那个错误码，给的片段里没有它 ——
 * 模型看不到命中在哪，只能把整段读回来，正好抵消掉「先给片段」省下的钱。
 */
export function excerptAround(text, terms, maxChars) {
  const s = String(text ?? '')
  if (s.length <= maxChars) return s
  // 小写化**可能改变字符串长度**（`İ` → `i̇` 这类少数语言环境相关字符）。长度一变，
  // 在 lowercase 串上找到的偏移映射回原串就是错位的。宁可退回「取开头」，
  // 也不要给出一个从错误位置切出来的片段——片段的价值全在「命中词在不在里面」。
  const lower = s.toLowerCase()
  const hay = lower.length === s.length ? lower : s
  let at = -1
  for (const t of terms ?? []) {
    const i = hay.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return s.slice(0, maxChars) + '…'
  const lead = Math.floor(maxChars / 3)
  const from = Math.max(0, at - lead)
  return (from > 0 ? '…' : '') + s.slice(from, from + maxChars) + (from + maxChars < s.length ? '…' : '')
}

/** 整段 query 原样出现（去掉首尾空白、大小写归一）—— 错误码 / 路径 / 版本号的强信号。 */
function exactTermHit(query, text) {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (q.length < 2) return false
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').includes(q)
}
