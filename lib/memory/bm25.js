/**
 * sage-mem 记忆层 —— 词元化与 BM25 打分（纯函数，无 I/O）。
 *
 * 为什么不是「双字覆盖率」：`retrieval.js` 那套是**覆盖率**——分母是 query，不惩罚文档长度。
 * 它在摘要（一句话）上工作良好，正是因为它没机会被长文本稀释；一旦拿它扫正文，
 * 长文件什么都能蒙中。BM25 换掉了那个分母：词频饱和（同一词出现 20 次不等于 20 倍相关）
 * 加上长度归一（长文件不加权），再配 IDF 让「到处都有的词」自动失效。
 *
 * 中文没有分词器可用（本插件零外部依赖），所以沿用双字词元。这是有代价的：
 * 「部署超时」会切出「部署」「署超」「超时」，「署超」是跨词边界的假词元。
 * 它极少在文档里命中，所以贡献接近 0 —— 这也是为什么下面额外给了一个**覆盖率小项**：
 * 命中越多的 query 词元越可能是真的要找的那份，用来打破近分平局。
 */

/** BM25 词频饱和系数。1.2 是文献里的常用起点。 */
export const BM25_K1 = 1.2

/** BM25 长度归一系数。0.75 同上。两个值都是起始参数，不是实测结论。 */
export const BM25_B = 0.75

/** 覆盖率在最终得分里的权重。刻意很小：它只该打破近分平局，不该压过 IDF。 */
export const COVERAGE_WEIGHT = 0.2

/** 汉字 / 假名 / 谚文的连续段。 */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/u

/** 一段连续的「标识符式」字符：`lib/index.js`、`SAGE_MEM_DEBUG`、`0.9.14`、`FS_STALE_VERSION`。 */
const ASCII_RUN = /[A-Za-z0-9][A-Za-z0-9_.\-/:\\]*/g

/** 标识符内部的分隔符 —— 切开后作为补充词元（`lib/index.js` 也要能被 `index` 搜到）。 */
const ASCII_SEP = /[_.\-/:\\]+/

/**
 * 把文本切成词元数组（**保留重复**，BM25 要的是真实词频）。
 *
 * 两类文本走两条路：
 *   - CJK 连续段 → 双字词元；单字段落退化成那一个字。**按段切，不跨标点**，
 *     否则「。我」这种跨句假词元也会进索引。
 *   - ASCII 串 → 整个原形 + 按分隔符切出的长度 ≥ 2 的片段。
 *     原形保留是为了精确匹配错误码 / 路径 / 版本号；片段是为了「记得大概是哪个文件」也能搜到。
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  if (!s) return []
  const out = []
  // CJK 段优先吃：ASCII 正则会绕过汉字，两者互不重叠。
  const runs = s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[A-Za-z0-9][A-Za-z0-9_.\-/:\\]*/gu) ?? []
  for (const run of runs) {
    if (CJK_RUN.test(run)) {
      if (run.length === 1) out.push(run)
      else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
      continue
    }
    out.push(run)
    for (const part of run.split(ASCII_SEP)) {
      // 长度 1 的片段是噪音（`1.0.0` 会切出三个 `0`），它们 df 极高、IDF 近 0，纯属白占内存。
      if (part.length >= 2 && part !== run) out.push(part)
    }
  }
  return out
}

/** 词元数组 → 词频表。 */
export function termFreq(tokens) {
  const tf = new Map()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

/**
 * 语料统计：文档数 N、平均长度 avgdl、逐词元的文档频率 df。
 *
 * @param {Array<{tokens:string[]}>} docs
 */
export function buildStats(docs) {
  const df = new Map()
  let total = 0
  for (const d of docs) {
    total += d.tokens.length
    // 同一文档里出现多次只算一次 —— df 的定义就是「多少篇文档含这个词元」。
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const N = docs.length
  return { N, avgdl: N > 0 ? total / N : 1, df }
}

/** 单篇文档的 BM25 得分。queryTerms 应先去重。 */
export function scoreDoc(queryTerms, tf, dl, stats) {
  if (!stats || stats.N === 0) return 0
  let score = 0
  for (const t of queryTerms) {
    const f = tf.get(t)
    if (!f) continue
    const idf = idfOf(stats.df.get(t) ?? 0, stats.N)
    score += (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / stats.avgdl))
  }
  return score
}

/**
 * 与 `scoreDoc` 同一口径的**逐词元贡献**。用于诊断报告：
 * 「这条命中凭什么得分」不能只给一个总分，要能看到是哪个词元贡献了多少。
 *
 * 返回数组（按 queryTerms 顺序，只含真的命中的词元）；各项 `score` 之和**严格等于**
 * `scoreDoc` —— 两边共用同一个公式，`scoreDoc` 就是它的求和，不存在第二份实现。
 *
 * @returns {Array<{term:string, tf:number, idf:number, score:number}>}
 */
export function scoreDocBreakdown(queryTerms, tf, dl, stats) {
  if (!stats || stats.N === 0) return []
  const out = []
  for (const t of queryTerms) {
    const f = tf.get(t)
    if (!f) continue
    const idf = idfOf(stats.df.get(t) ?? 0, stats.N)
    const score = (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / stats.avgdl))
    out.push({ term: t, tf: f, idf, score })
  }
  return out
}

/**
 * 词元的逆文档频率。加 1 的对数形式：df 等于 N 时（到处都是的词元）趋近 0 而不为负。
 *
 * 单独抽出来是因为「证据强度」判据（`evidence`）要用同一个口径 —— 两处各写一遍
 * 迟早会漂。
 */
export function idfOf(df, N) {
  if (!N) return 0
  return Math.log(1 + (N - df + 0.5) / (df + 0.5))
}

/**
 * 证据强度：这份文档到底**凭什么**被认为相关。返回两个数，缺一不可。
 *
 * 为什么需要它：BM25 对**任何**问题都能给出非零分——只要有一个常用双字重合。
 * 「今天天气怎么样」在 900 KB 的中文语料上必然能找到含「怎么」的段落。所以
 * 「分数 > 0」不是可用的相关性判据，必须有下面这条独立门槛。
 *
 * `ratio` = 命中的词元权重 ÷ **在语料里存在过的** query 词元总权重。
 *   ⚠️ 分母**必须剔除 df=0 的词元**：语料里根本没有的词（错别字、没记过的术语）
 *   带着最大 IDF 进分母，会把真正相关的题也压到 0.07 这种地板分上。
 * `sum` = 命中词元的权重绝对和。比值高但绝对量小，等于「匹配上的全是到处都有的词」，
 *   仍然不算证据 —— 两个条件同时满足才算过门槛。
 */
export function evidence(queryTerms, tf, stats) {
  let have = 0
  let total = 0
  let rarestRatio = 1
  let rarestDf = Number.POSITIVE_INFINITY
  let matched = 0
  for (const t of queryTerms) {
    const df = stats?.df?.get(t) ?? 0
    if (df === 0) continue          // 语料里不存在 → 不进分母，也不进分子
    const w = idfOf(df, stats.N)
    total += w
    if (tf.has(t)) {
      have += w
      matched++
      rarestRatio = Math.min(rarestRatio, df / stats.N)
      rarestDf = Math.min(rarestDf, df)
    }
  }
  return {
    ratio: total > 0 ? have / total : 0,
    sum: have,
    /**
     * 命中词元里**最冷门**那个的两个口径：文档频率占比，与绝对文档频率。
     *
     * 为什么两个都要：`df/N` 在小语料上会失真 —— 一个只有 5 份记忆的目录里，
     * 「全库独一份」的词元算出来也是 0.2，于是真命中会被误判成「不够冷门」而整条被滤掉，
     * 小目录的记忆检索直接失效。绝对 df 则在大语料上失真（同一个数字在 100 份与
     * 2000 份语料里含义完全不同）。所以判据是**析取**：
     * `df ≤ 1`（全库独一份，一定是有内容的）**或** `df/N ≤ 门槛`。
     * 两个口径都由调用方拿到，怎么组合是策略层的事。
     *
     * 为什么单有 ratio/sum 不够：`红烧肉怎么做才好吃` 在中文语料上会命中 `怎么`/`么做`
     * 这类到处都有的词元 —— 它们数量够多，`sum` 能堆到 4.8，而 `ratio` 会因为
     * 「红烧/烧肉/好吃」在语料里压根不存在（df=0，被剔出分母）而等于 1.0。
     * 两个数字都像是强证据，实际命中的**全是虚词**。内容词（连接池、温漂、
     * FS_STALE_VERSION）天然冷门，虚词天然热门，区分度就在这里。
     */
    rarestDfRatio: matched > 0 ? rarestRatio : 1,
    rarestDf: matched > 0 ? rarestDf : Number.POSITIVE_INFINITY,
    matched,
  }
}

/** query 的独特词元里有多少比例出现在这篇文档里（0~1）。只用来打破近分平局。 */
export function coverageOf(queryTerms, tf) {
  if (!queryTerms.length) return 0
  let hit = 0
  for (const t of queryTerms) if (tf.has(t)) hit++
  return hit / queryTerms.length
}

/** query → 去重后的词元数组。 */
export function queryTermsOf(query) {
  return [...new Set(tokenize(query))]
}

/**
 * 最长「连续命中」的**词元个数**（0 = 一个都没命中）。
 *
 * 为什么必须单独看连续性：中文双字词元会把跨词边界的假词元也造出来。
 * 「明天会不会下雨」里就有两个——
 *   - `不会`：真实虚词，df 高；
 *   - `天会`：来自「那一天**会**缩短」的跨词边界巧合，df=1，于是**IDF 最大**。
 * 单独看「有没有命中一个冷门词元」，`天会` 这种巧合恰好满足，于是一句完全无关的
 * 天气问题能把潮汐笔记拉进结果。
 *
 * 连续性治的就是它：连续命中 k 个词元 = query 里**至少 k+1 个字连着**出现在文档里。
 * 巧合通常孤立（k=1），真实内容词通常连成片段（`连接池` k=2、`压测时连接池` k=4）。
 *
 * ⚠️ 它也有代价：整句只对上一个两字专名时 k 只有 1，会被判成不连续。
 * 所以门槛里它是**析取**的一部分，不是唯一判据。
 */
export function maxMatchedRun(queryTokens, tf) {
  let best = 0
  let cur = 0
  for (const t of queryTokens) {
    if (tf.has(t)) {
      cur++
      if (cur > best) best = cur
    } else {
      cur = 0
    }
  }
  return best
}
