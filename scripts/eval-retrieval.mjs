#!/usr/bin/env node
/**
 * sage-mem 检索评测基座 —— 离线、可重跑、每次都留下原始分子分母。
 *
 * 为什么要有它：检索面正从「只比 frontmatter 摘要」扩到「能扫正文段落」，
 * 而「有没有变好」不能靠感觉。这个脚本是唯一裁判：它读固定的合成语料与问题集，
 * 逐题调 `retrieve()`，把每个指标的分子、分母、以及每一道题的判决都打出来。
 *
 * 三条设计原则，都不是风格问题：
 *   1. **只打印百分比是不合格的**。同一句「Recall@5 = 86.7%」，52/60 与 26/30
 *      是完全不同的证据强度。所以每个比率都必须带原始分式。
 *   2. **不许为了让数字好看而改语料**。语料与问题集是金标，脚本是量具。
 *      出现「all 的召回低于 summary」这类结果时，如实报告——那正是要知道的信息。
 *   3. **不依赖模型与网络**。词法检索的结构性边界必须能离线复现，
 *      否则「退化」与「换了个说法」分不开。
 *
 * 缓存注意：每道题都会调一次 `retrieve()`，但 `search.js` 内部按文件 revision 缓存
 * 段落与词频表，所以 60+ 道题的实际重算只有第一道。这也是它能当回归门用的前提。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { queryTermsOf, scoreDocBreakdown, tokenize } from '../lib/memory/bm25.js'
import { parseBaseline, parseFrontmatter } from '../lib/memory/frontmatter.js'
import {
  DEFAULT_LIMIT,
  MAX_EVIDENCE_DF_RATIO,
  MAX_LIMIT,
  MIN_EVIDENCE_RATIO,
  MIN_EVIDENCE_SUM,
  MIN_MATCHED_RUN,
  PER_FILE_CHUNKS,
  chunksOf,
  retrieve,
} from '../lib/memory/search.js'
// 2.0.0：注入侧会按 `invalid_at` 抑制失效记忆。评测要量的是**注入结果**，
// 所以判据必须复用生产代码那一份（`buildExpirySet`），不在这里另写一套「什么时候算失效」。
import { buildExpirySet, parseValidityTime } from '../lib/memory/validity.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DEFAULT_CORPUS = join(ROOT, 'test', 'eval', 'corpus')
const DEFAULT_QUESTIONS = join(ROOT, 'test', 'eval', 'questions.jsonl')

/**
 * 评测时钟（固定值，不读 `Date.now()`）。
 *
 * 理由与语料 `mtimeMs = 0` 同一条：**基线要可重放**。失效判定的边界依赖「现在」，
 * 读一次真实时钟就等于让同一份语料在不同日子产出不同结论（`invalid_at` 写的是哪天，
 * 跑评测那天是不是已经过了它）。固定成这个值之后：
 *   - 语料里所有带 `invalid_at` 的旧条目（2026-09）必然「已到点」；
 *   - 未来时间语料的语义也有确定解释（相对这个时钟是未来，就永远不失效）。
 * 要加「未来才失效」的语料时，先改这个常量并在语料里注明，不要让它跟着跑的那天漂。
 */
const EVAL_NOW_MS = Date.parse('2026-11-01T00:00:00+08:00')

/** `note` 里带这个记号 = 已知的词法失败边界：语义上有答案，但 query 与原文没有词面重合。 */
const LEXFAIL = '[lexfail]'

/**
 * 难负例的四种「为什么难」。每种单独给分母 —— 不能拿「有没有共享词元」当筛子：
 * 恰恰是共享词元的那批里装着词法检索真正的失误（见 README「误注入的两个口径」）。
 *
 * 顺序即报告顺序；`dir` 是该类主指标的方向（看板上用）。
 */
const HARD_NEGATIVE_KINDS = [
  ['shared-common-word', '共享常用词', 'down'],
  ['same-name-different-project', '同名不同项目', 'down'],
  ['same-entity-different-time', '相同实体不同时间', 'up'],
  ['stale-content', '已失效内容', 'down'],
]
const HARD_NEGATIVE_SET = new Set(HARD_NEGATIVE_KINDS.map(([kind]) => kind))

/** 当前包版本：写进基线，让「这份基线是哪一版量的」不用去猜 generatedAt。 */
const CURRENT_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || ''
  } catch {
    return ''
  }
})()

const USAGE = `sage-mem 检索评测（离线：不联网、不调模型）

  node scripts/eval-retrieval.mjs [选项]

选项：
  --mode <summary|body|all|mixed>  检索面（默认 all；mixed = 每题按自己的 scope 跑）
  --limit <N>                      每次返回条数，收敛到 [1,${MAX_LIMIT}]（默认 ${DEFAULT_LIMIT}）
  --per-file <N>                   每文件最多贡献几条（默认 ${PER_FILE_CHUNKS}）
  --json <path>                    把完整结果（含逐题明细）写成 JSON
  --report <path>                  写一份可读的逐案例诊断报告（Markdown）：误注入 / 白名单外 /
                                   MISS / 词法边界 / 无答案注入，含 evidence 门槛值与逐词元贡献
  --baseline <path>                与一份旧的 --json 产物对比，出现退化时退出码 1
  --allow-baseline-skip            允许「显式给了 --baseline 但比较没完成」时放行（默认不允许）
  --diff <a.json> <b.json>         只比较两份历史基线（不跑检索）。与 --baseline 不同：
                                   口径不同（mode/limit/问题集/语料指纹）也能比，但只给方向
                                   与量级、并显式标出「口径不同·不可当回归判定」；退出码不判退化
  --strict                         任何黑/白名单误注入都算失败（默认只如实报告）
  --corpus <dir>                   语料目录（默认 test/eval/corpus）
  --questions <path>               问题集（默认 test/eval/questions.jsonl）
  --help                           打印本说明

退出码 1 的五种情形：结构性错误（标注越界 / 语料缺失 / retrieve 抛错 / 同一次结果里
同一文件重复 / 切分不全）、对照退化（all 的召回低于 summary）、--strict 下出现误注入、
--baseline 判定指标退化、以及**显式给了 --baseline 但比较没完成**。

最后一条是**失败关闭**（fail closed）：基线读不到 / JSON 坏了 / 指标缺项 / mode 或指纹对不上，
一律算失败而不是「跳过」，否则 CI 会把「没比较」当成「比较通过」。
那是探索场景时用 --allow-baseline-skip 显式放行，结构化输出里会留 status: inconclusive。`

// ─────────────────────────── 命令行 ───────────────────────────

function parseArgs(argv) {
  const opts = {
    mode: 'all',
    limit: DEFAULT_LIMIT,
    perFile: PER_FILE_CHUNKS,
    json: '',
    report: '',
    baseline: '',
    diff: null,
    allowBaselineSkip: false,
    strict: false,
    corpus: DEFAULT_CORPUS,
    questions: DEFAULT_QUESTIONS,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    const eq = arg.indexOf('=')
    const key = eq >= 0 ? arg.slice(0, eq) : arg
    const inline = eq >= 0 ? arg.slice(eq + 1) : null
    const take = () => {
      if (inline !== null) return inline
      const v = argv[++i]
      if (v === undefined) throw new Error(`${key} 缺一个取值`)
      return v
    }
    if (key === '--mode') opts.mode = take()
    else if (key === '--limit') opts.limit = Number(take())
    else if (key === '--per-file') opts.perFile = Number(take())
    else if (key === '--json') opts.json = take()
    else if (key === '--report') opts.report = resolve(process.cwd(), take())
    else if (key === '--baseline') opts.baseline = take()
    else if (key === '--diff') {
      const a = take()
      const b = take()
      opts.diff = [a, b]
    }
    else if (key === '--allow-baseline-skip') opts.allowBaselineSkip = true
    else if (key === '--corpus') opts.corpus = resolve(process.cwd(), take())
    else if (key === '--questions') opts.questions = resolve(process.cwd(), take())
    else if (key === '--strict') opts.strict = true
    else if (key === '--help' || key === '-h') opts.help = true
    else throw new Error(`未知选项 ${arg}`)
  }
  return opts
}

// ─────────────────────────── 语料与题目集 ───────────────────────────

/**
 * 读语料并组装成 `scanMemoryFiles` 的形状。
 *
 * `mtimeMs` 写死 0 是有意的：检索这条链只吃 file / content / description / aliases，
 * 新鲜度不是检索输入。写死之后，评测结果与文件系统时间、与文件被复制过没有，
 * 都彻底无关——量具不能有自己的漂移。
 */
function loadCorpus(dir) {
  let names
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.md'))
  } catch (err) {
    throw new Error(`读不到语料目录 ${dir}：${err?.message ?? err}`)
  }
  names.sort()
  return names.map(name => {
    const content = readFileSync(join(dir, name), 'utf8')
    const meta = parseFrontmatter(content)
    return {
      file: name,
      content,
      description: meta.description || '',
      aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
      baseline: parseBaseline(content),
      baselinePriority: meta.baselinePriority || 0,
      updated: meta.updated || '',
      // 2.0.0：有效性三字段原样带出来（解析口径复用 frontmatter.js，判定复用 validity.js）。
      // 坏格式也照样带出——判它是「未标注」是 validity.js 的事（R2：认不出就不猜）。
      validAt: meta.validAt || '',
      invalidAt: meta.invalidAt || '',
      supersededBy: meta.supersededBy || '',
      mtimeMs: 0,
    }
  })
}

/** 问题集按 JSONL 读：一行一题，空行与 `#` 开头的行跳过（便于插注释分段）。 */
function loadQuestions(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw || raw.startsWith('#')) continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`questions.jsonl 第 ${i + 1} 行不是合法 JSON：${err?.message ?? err}`)
    }
    out.push({
      id: String(parsed.id ?? `line${i + 1}`),
      query: String(parsed.query ?? ''),
      scope: parsed.scope === 'summary' || parsed.scope === 'body' ? parsed.scope : 'all',
      allowFiles: Array.isArray(parsed.allowFiles) ? parsed.allowFiles.map(String) : [],
      needed: Array.isArray(parsed.needed)
        ? parsed.needed.map(n => ({
            file: String(n?.file ?? ''),
            span: Array.isArray(n?.span) && n.span.length === 2 ? [Number(n.span[0]), Number(n.span[1])] : null,
          }))
        : [],
      shouldInject: parsed.shouldInject !== false,
      shouldReturn: parsed.shouldReturn === 'body' ? 'body' : 'summary',
      mustNotInject: Array.isArray(parsed.mustNotInject) ? parsed.mustNotInject.map(String) : [],
      unresolved: parsed.unresolved === true,
      // 难负例标注：透传 + 原样保留未识别值（合法性由 auditAnnotations 判，不在这里悄悄吞掉）。
      // 只在 loadQuestions 里丢字段，会让 audit 变成空转 —— 所有分类都变成 0 题却「自检全 0」。
      hardNegative: parsed.hardNegative === undefined ? undefined : String(parsed.hardNegative),
      preferNewer:
        parsed.preferNewer && typeof parsed.preferNewer === 'object'
          ? { newer: String(parsed.preferNewer.newer ?? ''), older: String(parsed.preferNewer.older ?? '') }
          : undefined,
      note: String(parsed.note ?? ''),
      line: i + 1,
    })
  }
  return out
}

/**
 * 标注自检：在跑指标之前先把「标注本身站不站得住」查一遍（文件在不在、span 越不越界）。
 *
 * ⚠️ 这里还额外算出「query 与黑名单文件共享词元」的检查项集合，但它**只是诊断切片**，
 * 不是「真实的误注入子集」。曾经的写法把共享词元等同于「标注不牢靠」，再拿剩下的项
 * 算一个「安全子集」——那是错的：共享的往往是「时间」「一次」或中文双字切出来的
 * 「器的」「别是」这类通用碎片，**从它推不出「这份文件与这个问题语义无关」**。
 * 更糟的是，这么过滤会**系统性地把词法检索最容易犯错的难负例筛掉**：
 * 「同名不同项目」「相同实体不同时间」「已失效内容」这三类难负例，
 * 恰恰是靠共享词元才暴露出来的。切片读数归零，什么都证明不了。
 *
 * 所以：完整误注入率（全部检查项）是主指标；切片只能用来回答
 * 「这些命中里有多少连一个共享词元都没有」——那是最不需要解释、也最不费劲的那一半。
 */
function auditAnnotations(questions, corpus) {
  const byFile = new Map(corpus.map(f => [f.file, f]))
  const missingNeeded = []
  const badSpans = []
  const missingBlacklist = []
  const missingWhitelist = []
  const whitelistMissingNeeded = []
  const badHardNegative = []
  const missingPreferNewer = []
  const preferNotInNeeded = []
  const sharedTokenPairs = new Set()
  const sharedTokenSamples = []
  // 2.0.0：有效性标注自检。**坏标注会让分母悄悄变小**（比如「已失效」题的黑名单其实
  // 没有任何失效标记，于是它永远是 0/6），所以坏标注必须非零退出，不能只当提示。
  const badValidity = []
  const badSupersededBy = []
  const staleNotMarked = []
  const neededSuppressed = []
  const preferOlderNotExpired = []
  // 评测时钟固定（见 EVAL_NOW_MS）：失效判定与注入侧复用同一个纯函数。
  const expirySet = buildExpirySet(corpus, EVAL_NOW_MS)
  for (const f of corpus) {
    for (const field of ['valid_at', 'invalid_at']) {
      const value = field === 'valid_at' ? f.validAt : f.invalidAt
      if (value && !parseValidityTime(value).ok) badValidity.push(`${f.file} ${field}=${JSON.stringify(value)}（认不出）`)
    }
    if (f.supersededBy && !byFile.has(f.supersededBy)) {
      badSupersededBy.push(`${f.file} → ${f.supersededBy}（目标不存在）`)
    }
  }

  for (const q of questions) {
    const qTerms = new Set(tokenize(q.query))
    const fileTerms = (file) => {
      const f = byFile.get(file)
      if (!f) return null
      return new Set(tokenize(`${f.description} ${f.aliases.join(' ')} ${f.content}`))
    }
    for (const need of q.needed) {
      const target = byFile.get(need.file)
      if (!target) {
        missingNeeded.push(`${q.id} → ${need.file}`)
        continue
      }
      if (need.span) {
        const total = target.content.split(/\r?\n/).length
        const [a, b] = need.span
        if (!(Number.isFinite(a) && Number.isFinite(b) && a >= 1 && b <= total && a <= b)) {
          badSpans.push(`${q.id} → ${need.file} span=${a}-${b}（该文件共 ${total} 行）`)
        }
      }
      // 2.0.0：needed 自己带已到点的 invalid_at = 标注自相矛盾（注入侧会把它挡掉，召回必然掉）。
      if (expirySet.has(need.file)) {
        neededSuppressed.push(`${q.id} → ${need.file}（这份是 needed，却被标了已到点的 invalid_at）`)
      }
    }
    for (const file of q.mustNotInject) {
      if (!byFile.has(file)) {
        missingBlacklist.push(`${q.id} → ${file}`)
        continue
      }
      const terms = fileTerms(file)
      const shared = [...qTerms].filter(t => terms.has(t))
      if (shared.length) {
        sharedTokenPairs.add(`${q.id}\u0000${file}`)
        if (sharedTokenSamples.length < 8) sharedTokenSamples.push(`${q.id} × ${file} ← ${shared.slice(0, 4).join('/')}`)
      }
    }
    for (const file of q.allowFiles) {
      if (!byFile.has(file)) missingWhitelist.push(`${q.id} → ${file}`)
    }
    if (q.allowFiles.length) {
      for (const need of q.needed) {
        if (!q.allowFiles.includes(need.file)) whitelistMissingNeeded.push(`${q.id} → ${need.file} 不在 allowFiles 里`)
      }
    }

    // ── 难负例标注的合法性 ──
    // 这些字段是给「按为什么难分组」用的量具标注，写错了会让分母悄悄变空，
    // 所以和 needed/黑名单一样进「标注自检」、非零即退出码 1。
    if (q.hardNegative === 'stale-content') {
      // 「已失效内容」这一类的黑名单**必须真的被失效标记覆盖**。否则这一类的
      // 误注入率永远测的是「检索会不会命中它」，而不是「注入侧有没有挡住它」。
      for (const file of q.mustNotInject) {
        if (byFile.has(file) && !expirySet.has(file)) {
          staleNotMarked.push(`${q.id} → ${file}（stale-content 的黑名单文件没有已到点的 invalid_at，不会被抑制）`)
        }
      }
    }
    if (q.hardNegative !== undefined) {
      if (!HARD_NEGATIVE_SET.has(q.hardNegative)) {
        badHardNegative.push(`${q.id} → 未知取值 ${JSON.stringify(q.hardNegative)}`)
      }
      if (q.hardNegative === 'same-entity-different-time') {
        const prefer = q.preferNewer
        if (!prefer || typeof prefer !== 'object' || !prefer.newer || !prefer.older) {
          missingPreferNewer.push(`${q.id} → same-entity-different-time 必须带 preferNewer:{newer,older}`)
        } else {
          for (const side of ['newer', 'older']) {
            if (!byFile.has(prefer[side])) missingPreferNewer.push(`${q.id} → preferNewer.${side} 文件不存在：${prefer[side]}`)
          }
          if (!q.needed.some(n => n.file === prefer.newer)) {
            preferNotInNeeded.push(`${q.id} → preferNewer.newer（${prefer.newer}）不在 needed 里，排序断言没有落点`)
          }
          // 2.0.0：旧版必须带**已到点**的 invalid_at，否则「旧版压新版」的归零没有原因。
          if (byFile.has(prefer.older) && !expirySet.has(prefer.older)) {
            preferOlderNotExpired.push(`${q.id} → preferNewer.older（${prefer.older}）没有已到点的 invalid_at，不会被抑制`)
          }
        }
      } else if (q.preferNewer !== undefined) {
        badHardNegative.push(`${q.id} → 只有 same-entity-different-time 才该带 preferNewer`)
      }
    } else if (q.preferNewer !== undefined) {
      badHardNegative.push(`${q.id} → 带 preferNewer 却缺 hardNegative 分类`)
    }
  }

  const blacklistChecks = questions.reduce((n, q) => n + q.mustNotInject.length, 0)
  const noSharedTokenChecks = questions.reduce(
    (n, q) => n + q.mustNotInject.filter(f => !sharedTokenPairs.has(`${q.id}\u0000${f}`)).length,
    0,
  )
  const noSharedTokenQuestions = questions.filter(
    q => q.mustNotInject.filter(f => !sharedTokenPairs.has(`${q.id}\u0000${f}`)).length > 0,
  ).length

  return {
    missingNeeded,
    badSpans,
    missingBlacklist,
    missingWhitelist,
    whitelistMissingNeeded,
    badHardNegative,
    missingPreferNewer,
    preferNotInNeeded,
    badValidity,
    badSupersededBy,
    staleNotMarked,
    neededSuppressed,
    preferOlderNotExpired,
    expirySet,
    expiredFiles: [...expirySet].sort(),
    sharedTokenPairs,
    sharedTokenSamples,
    blacklistChecks,
    noSharedTokenChecks,
    noSharedTokenQuestions,
  }
}

// ─────────────────────────── 逐题求值 ───────────────────────────

function evaluateQuestion(q, scope, corpus, limit, perFile, sharedTokenPairs, expirySet) {
  const started = performance.now()
  let result = null
  let error = ''
  try {
    result = retrieve({ query: q.query, files: corpus, scope, limit, perFile })
  } catch (err) {
    error = err?.message ?? String(err)
  }
  const ms = performance.now() - started

  const allHits = result && Array.isArray(result.hits) ? result.hits.map(h => ({
    id: String(h.id ?? ''),
    file: String(h.file),
    title: String(h.title ?? ''),
    headingPath: String(h.headingPath ?? ''),
    lines: Array.isArray(h.lines) ? h.lines : null,
    score: Number(h.score),
    matchedBy: Array.isArray(h.matchedBy) ? h.matchedBy : [],
    excerptBytes: String(h.excerpt ?? '').length,
    // 正文证据门槛的**现场数值**（摘要层没有门槛，这几个字段是 null）。
    // 诊断报告要回答「这条凭什么被放进来」，只给总分不够。
    evidence: Number.isFinite(h.evidence) ? h.evidence : null,
    evidenceSum: Number.isFinite(h.evidenceSum) ? h.evidenceSum : null,
    evidenceRarest: Number.isFinite(h.evidenceRarest) ? h.evidenceRarest : null,
    evidenceRarestDf: Number.isFinite(h.evidenceRarestDf) ? h.evidenceRarestDf : null,
    evidenceRun: Number.isFinite(h.evidenceRun) ? h.evidenceRun : null,
  })) : []
  // 2.0.0 的注入语义：先检索、再在**投递层**判失效（`composeDelivery` 的 `expired` 集合）。
  // 被抑制的命中**仍然占据检索候选位**（真实链路里它到显示层才判 `unresolved`），所以这里
  // 是「从同一批 top-k 里划掉」，而不是「先过滤语料再检索」—— 后者会凭空多出候选位、
  // 把别的文件抬进 top-k，量的就不是同一个东西了。
  const suppressedHits = expirySet ? allHits.filter(h => expirySet.has(h.file)) : []
  const hits = expirySet ? allHits.filter(h => !expirySet.has(h.file)) : allHits
  const suppressed = suppressedHits.map(h => ({ file: h.file, reason: 'expired_source', excerptBytes: h.excerptBytes }))
  const firstAt = new Map()
  hits.forEach((h, i) => {
    if (!firstAt.has(h.file)) firstAt.set(h.file, i)
  })

  const needed = q.needed.map(n => {
    const rank = firstAt.has(n.file) ? firstAt.get(n.file) + 1 : 0
    const hit = rank ? hits[rank - 1] : null
    const lines = hit?.lines ?? null
    return {
      file: n.file,
      span: n.span,
      rank,
      found: rank > 0,
      lines,
      spanOk: Boolean(n.span && lines && lines[0] <= n.span[0] && lines[1] >= n.span[1]),
      overlapOk: Boolean(n.span && lines && lines[0] <= n.span[1] && lines[1] >= n.span[0]),
    }
  })

  const foundCount = needed.filter(n => n.found).length
  const allFound = needed.length > 0 && foundCount === needed.length
  const ranks = needed.filter(n => n.found).map(n => n.rank)
  const bestRank = ranks.length ? Math.min(...ranks) : 0

  // 相同实体不同时间：不给「旧版必须消失」这种过严断言（README 允许两条都给），
  // 只记录事实——新版召回了吗、旧版有没有压过新版。排序看板因此不撒谎。
  const prefer = q.preferNewer
    ? (() => {
        const rankOf = file => (firstAt.has(file) ? firstAt.get(file) + 1 : 0)
        const newerRank = rankOf(q.preferNewer.newer)
        const olderRank = rankOf(q.preferNewer.older)
        return {
          newer: q.preferNewer.newer,
          older: q.preferNewer.older,
          newerRank,
          olderRank,
          newerRecalled: newerRank > 0,
          olderRecalled: olderRank > 0,
          // 旧版是不是被「失效」这一层挡掉了 —— 这是 2.0.0 后 `olderOverNewer` 归零的
          // **原因字段**。不单列出来，看板会显示「旧版不压新版了」，却看不出是因为被抑制
          // 还是因为排序真的变了。
          olderSuppressed: Boolean(expirySet && expirySet.has(q.preferNewer.older)),
          olderOverNewer: olderRank > 0 && (newerRank === 0 || olderRank < newerRank),
        }
      })()
    : null

  const blacklistHit = q.mustNotInject.filter(f => firstAt.has(f))  // 共享词元只说明「这条命中不需要任何语义解释」，**不说明标注错了**：
  // 通用词碎片（时间 / 一次 / 器的）与跨词假词元都会命中，而真正的难负例
  // （同名不同项目、同实体不同时间、已失效内容）同样常常共享词元。
  // 所以这组计数只当诊断切片，主指标仍是全部检查项上的误注入。
  const blacklistSharedTokenEntries = q.mustNotInject.filter(f => sharedTokenPairs.has(`${q.id}\u0000${f}`))
  const blacklistHitSharedToken = blacklistHit.filter(f => sharedTokenPairs.has(`${q.id}\u0000${f}`))
  const whitelistHit = q.allowFiles.length ? hits.map(h => h.file).filter(f => !q.allowFiles.includes(f)) : []

  // Precision@k 的「相关集」= 标注的 needed ∪ allowFiles。**是下界不是真值**：
  // 合成语料里可能还有未标注但确实相关的文件，这个数只能往低处偏，不能拿来宣称真实精度。
  const relevantSet = new Set([...q.needed.map(n => n.file), ...(q.allowFiles ?? [])])
  const relevantHitCount = hits.filter(h => relevantSet.has(h.file)).length
  const precisionAtK = relevantSet.size && hits.length ? relevantHitCount / hits.length : null
  // 注入字节用「候选片段字节」代理（真实注入还要受 60 KB 会话预算裁切，见契约 2.5）。
  const injectedBytes = hits.reduce((s, h) => s + h.excerptBytes, 0)

  // 同一文件在同一次结果里重复出现 = 候选位被同一份证据重复占用。
  // 这里看**检索输出**（含被抑制的），因为它量的是检索层结构，不是投递层结果。
  const seen = new Set()
  let dupExtra = 0
  let dupExtraBytes = 0
  for (const h of allHits) {
    if (seen.has(h.file)) {
      dupExtra++
      dupExtraBytes += h.excerptBytes
    }
    seen.add(h.file)
  }

  let verdict = 'MISS'
  if (error) verdict = 'ERROR'
  else if (!needed.length) verdict = hits.length ? 'INJ' : 'EMPTY'
  else if (allFound) verdict = 'ALL'
  else if (foundCount > 0) verdict = 'HIT'

  const coverage = result?.coverage ?? { searched: 0, skipped: 0, complete: true, chunks: 0, candidates: 0 }
  return {
    question: q,
    scope,
    verdict,
    error,
    ok: result?.ok === true,
    ms,
    hits,
    // 2.0.0：被失效标记抑制的命中（仍在 allHits 里、只是不进正文）。
    // 单列出来是为了让「误注入归零」有可核对的原因，而不是一个变好的数字。
    suppressed,
    suppressedFiles: suppressed.map(s => s.file),
    allCandidates: allHits.length,
    needed,
    foundCount,
    allFound,
    bestRank,
    blacklistHit,
    blacklistHitSharedToken,
    prefer,
    blacklistNoSharedTokenCount: q.mustNotInject.length - blacklistSharedTokenEntries.length,
    blacklistNoSharedTokenViolations: blacklistHit.filter(f => !sharedTokenPairs.has(`${q.id}\u0000${f}`)).length,
    whitelistHit,
    relevantHitCount,
    precisionAtK,
    injectedBytes,
    dupExtra,
    dupExtraBytes,
    coverage,
    nextCursor: result?.nextCursor ?? null,
  }
}

/** 同一题集跑一遍某个 scope —— 用于「all 是否真的比 summary 好」这条对照。 */
function runAll(questions, corpus, scope, limit, perFile, sharedTokenPairs, expirySet) {
  return questions.map(q => evaluateQuestion(q, scope, corpus, limit, perFile, sharedTokenPairs, expirySet))
}

// ─────────────────────────── 指标 ───────────────────────────

function summarize(rows) {
  const m = {
    questions: rows.length,
    neededQuestions: 0,
    anyHit: 0,
    allHit: 0,
    neededItems: 0,
    foundItems: 0,
    spanItems: 0,
    spanStrict: 0,
    spanOverlap: 0,
    mrrSum: 0,
    retrieveErrors: 0,
    zeroHitQuestions: 0,
    dupQuestions: 0,
    dupExtra: 0,
    dupExtraBytes: 0,
    blacklistQuestions: 0,
    blacklistChecks: 0,
    blacklistViolationQuestions: 0,
    blacklistViolations: 0,
    blacklistNoSharedTokenChecks: 0,
    blacklistNoSharedTokenQuestions: 0,
    blacklistNoSharedTokenViolationQuestions: 0,
    blacklistSharedTokenViolations: 0,
    whitelistQuestions: 0,
    whitelistViolationQuestions: 0,
    whitelistViolations: 0,
    unresolvedQuestions: 0,
    overInjectQuestions: 0,
    noAnswerRefused: 0,
    precisionQuestions: 0,
    precisionHits: 0,
    precisionDen: 0,
    injectedBytes: 0,
    injectionQuestions: 0,
    incompleteCoverageQuestions: 0,
    skippedFiles: 0,
    candidatesSum: 0,
    // 2.0.0：失效抑制的原始计数（被抑制的命中条数、涉及题数、被抑制的候选片段字节）。
    suppressedHits: 0,
    suppressionQuestions: 0,
    suppressedBytes: 0,
    latencies: [],
  }
  for (const row of rows) {
    const q = row.question
    m.latencies.push(row.ms)
    m.candidatesSum += row.coverage.candidates
    m.skippedFiles += row.coverage.skipped
    if (!row.coverage.complete) m.incompleteCoverageQuestions++
    if (row.error) m.retrieveErrors++
    if (row.suppressed.length) {
      m.suppressionQuestions++
      m.suppressedHits += row.suppressed.length
      m.suppressedBytes += row.suppressed.reduce((s, x) => s + x.excerptBytes, 0)
    }
    if (row.dupExtra > 0) {
      m.dupQuestions++
      m.dupExtra += row.dupExtra
      m.dupExtraBytes += row.dupExtraBytes
    }
    if (q.unresolved && !q.shouldInject) {
      m.unresolvedQuestions++
      if (row.hits.length) m.overInjectQuestions++
      else m.noAnswerRefused++
    }
    if (row.hits.length) {
      m.injectionQuestions++
      m.injectedBytes += row.injectedBytes
    }
    if (row.precisionAtK !== null) {
      m.precisionQuestions++
      m.precisionHits += row.relevantHitCount
      m.precisionDen += row.hits.length
    }
    if (q.needed.length) {
      m.neededQuestions++
      if (row.foundCount > 0) m.anyHit++
      if (row.allFound) m.allHit++
      if (row.bestRank > 0) m.mrrSum += 1 / row.bestRank
    } else if (!row.hits.length) {
      m.zeroHitQuestions++
    }
    for (const need of row.needed) {
      m.neededItems++
      if (need.found) m.foundItems++
      if (need.span) {
        m.spanItems++
        if (need.spanOk) m.spanStrict++
        if (need.overlapOk) m.spanOverlap++
      }
    }
    if (q.mustNotInject.length) {
      m.blacklistQuestions++
      m.blacklistChecks += q.mustNotInject.length
      m.blacklistSharedTokenViolations += row.blacklistHitSharedToken.length
      if (row.blacklistHit.length) m.blacklistViolationQuestions++
      m.blacklistViolations += row.blacklistHit.length
    }
    const noSharedTokenChecks = row.blacklistNoSharedTokenCount
    if (noSharedTokenChecks > 0) {
      m.blacklistNoSharedTokenQuestions++
      m.blacklistNoSharedTokenChecks += noSharedTokenChecks
      if (row.blacklistNoSharedTokenViolations > 0) m.blacklistNoSharedTokenViolationQuestions++
    }
    if (q.allowFiles.length) {
      m.whitelistQuestions++
      if (row.whitelistHit.length) {
        m.whitelistViolationQuestions++
        m.whitelistViolations += row.whitelistHit.length
      }
    }
  }
  return m
}

/**
 * 难负例按「为什么难」分组统计。每类单独一个分母 —— 这是 README 里那条提案的落地：
 * 不用「有没有共享词元」当筛子，而是四类各自数各自的，避免把最难的失败先扔掉再宣布没问题。
 */
function summarizeHard(rows) {
  const out = {}
  for (const [kind, label, dir] of HARD_NEGATIVE_KINDS) {
    const groupRows = rows.filter(row => row.question.hardNegative === kind)
    const preferRows = groupRows.filter(row => row.prefer)
    out[kind] = {
      label,
      dir,
      questions: groupRows.length,
      neededQuestions: groupRows.filter(row => row.question.needed.length).length,
      anyHit: groupRows.filter(row => row.foundCount > 0).length,
      blacklistQuestions: groupRows.filter(row => row.question.mustNotInject.length).length,
      blacklistChecks: groupRows.reduce((n, row) => n + row.question.mustNotInject.length, 0),
      violationQuestions: groupRows.filter(row => row.blacklistHit.length).length,
      violations: groupRows.reduce((n, row) => n + row.blacklistHit.length, 0),
      preferQuestions: preferRows.length,
      newerRecalled: preferRows.filter(row => row.prefer.newerRecalled).length,
      olderOverNewer: preferRows.filter(row => row.prefer.olderOverNewer).length,
      // 2.0.0：这两项是把「旧版压新版」归零**归因**到失效抑制的原始计数。
      // 没有它们，`olderOverNewer = 0/4` 与「排序真的修好了」看起来一模一样。
      olderSuppressed: preferRows.filter(row => row.prefer.olderSuppressed).length,
      suppressedBlacklistChecks: groupRows.reduce(
        (n, row) => n + row.suppressedFiles.filter(f => row.question.mustNotInject.includes(f)).length,
        0,
      ),
    }
  }
  return out
}

/** 把难负例分组转成能进 `metrics.rates` 的比率，基线对比因此能盯住它们。 */
function hardRates(hard) {
  const div = (n, d) => (d > 0 ? n / d : 0)
  const k = kind => hard[kind] ?? {
    violationQuestions: 0, blacklistQuestions: 0, preferQuestions: 0,
    newerRecalled: 0, olderOverNewer: 0, olderSuppressed: 0, suppressedBlacklistChecks: 0,
  }
  return {
    hardSharedWordInjectRate: div(k('shared-common-word').violationQuestions, k('shared-common-word').blacklistQuestions),
    hardSameNameInjectRate: div(k('same-name-different-project').violationQuestions, k('same-name-different-project').blacklistQuestions),
    hardNewerRecallRate: div(k('same-entity-different-time').newerRecalled, k('same-entity-different-time').preferQuestions),
    hardOlderOverNewerRate: div(k('same-entity-different-time').olderOverNewer, k('same-entity-different-time').preferQuestions),
    hardOlderSuppressedRate: div(k('same-entity-different-time').olderSuppressed, k('same-entity-different-time').preferQuestions),
    hardStaleInjectRate: div(k('stale-content').violationQuestions, k('stale-content').blacklistQuestions),
    hardStaleSuppressedRate: div(k('stale-content').suppressedBlacklistChecks, k('stale-content').blacklistChecks),
  }
}

function rates(m) {  const div = (n, d) => (d > 0 ? n / d : 0)
  return {
    recallAny: div(m.anyHit, m.neededQuestions),
    recallAll: div(m.allHit, m.neededQuestions),
    itemRecall: div(m.foundItems, m.neededItems),
    spanStrictRate: div(m.spanStrict, m.spanItems),
    spanOverlapRate: div(m.spanOverlap, m.spanItems),
    mrr: div(m.mrrSum, m.neededQuestions),
    falseInjectRate: div(m.blacklistViolationQuestions, m.blacklistQuestions),
    noSharedTokenSubsetRate: div(m.blacklistNoSharedTokenViolationQuestions, m.blacklistNoSharedTokenQuestions),
    whitelistViolationRate: div(m.whitelistViolationQuestions, m.whitelistQuestions),
    dupQuestionRate: div(m.dupQuestions, m.questions),
    overInjectRate: div(m.overInjectQuestions, m.unresolvedQuestions),
    // 拒绝率 = 无答案题里「一条都不注入」的比例。与 overInjectRate 互为补数，
    // 单独给出来是因为「越低越好的误注入」和「越高越好的拒绝率」在看板上方向相反。
    noAnswerRefusalRate: m.unresolvedQuestions ? div(m.noAnswerRefused, m.unresolvedQuestions) : 1,
    // Precision@k：top-k 里落在「标注相关集（needed ∪ allowFiles）」的比例。
    // **是下界**：合成语料里可能还有未标注但相关的文件，不能拿它宣称真实精度。
    precisionAtK: div(m.precisionHits, m.precisionDen),
    injectedBytesAvg: div(m.injectedBytes, m.questions),
    errorRate: div(m.retrieveErrors, m.questions),
    incompleteRate: div(m.incompleteCoverageQuestions, m.questions),
    candidatesAvg: div(m.candidatesSum, m.questions),
    latencyP50: percentile(m.latencies, 0.5),
    latencyP95: percentile(m.latencies, 0.95),
  }
}

/** 最近秩法：p=0.95、20 个样本时取第 19 个，而不是插值出一个不存在的观测值。 */
function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

// ─────────────────────────── 打印 ───────────────────────────

const NA = 'n/a'

function frac(num, den) {
  return `${num}/${den} = ${den > 0 ? `${((num / den) * 100).toFixed(1)}%` : NA}`
}

function line(label, value) {
  console.log(`  ${label.padEnd(26)}${value}`)
}

function clip(text, n) {
  const s = String(text ?? '')
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function detailLines(row) {
  const top = row.hits.length
    ? row.hits.slice(0, 3).map(h => `${h.file}${h.lines ? `#${h.lines[0]}-${h.lines[1]}` : ''}(${h.score})`).join(' ')
    : '—'
  const needs = row.needed.length
    ? row.needed.map(n => {
        if (!n.found) return `${n.file}✗`
        if (!n.span) return `${n.file}✓@${n.rank}`
        return `${n.file}✓@${n.rank}${n.spanOk ? '⊂span' : n.overlapOk ? '△span' : '✗span'}`
      }).join(' ')
    : '—'
  const flags = []
  if (row.error) flags.push(`抛错：${row.error}`)
  if (row.dupExtra > 0) flags.push(`重复文件×${row.dupExtra}（${row.dupExtraBytes} 字节）`)
  if (row.suppressed.length) flags.push(`已抑制[${row.suppressed.map(s => s.file).join(', ')}]（expired_source）`)
  if (row.blacklistHit.length) flags.push(`命中黑名单[${row.blacklistHit.join(', ')}]`)
  if (row.whitelistHit.length) flags.push(`白名单外[${row.whitelistHit.join(', ')}]`)
  if (!row.coverage.complete) flags.push('切分不全')
  if (row.question.note) flags.push(row.question.note)
  return [
    `${row.question.id.padEnd(6)} ${row.verdict.padEnd(5)} [${row.scope}] 「${clip(row.question.query, 28)}」`,
    `       need ${needs} | top ${top}${flags.length ? ` | ${flags.join(' | ')}` : ''}`,
  ]
}

function printMetrics(title, rows, m, r) {
  console.log(`\n== ${title} ==`)
  line('题目数', String(m.questions))
  line('Recall@L（任一命中）', `${frac(m.anyHit, m.neededQuestions)}   [有 needed 的题 ${m.neededQuestions}]`)
  line('全中率（全部 needed）', frac(m.allHit, m.neededQuestions))
  line('条目级召回', `${frac(m.foundItems, m.neededItems)}   [needed 条目 ${m.neededItems}]`)
  line('段落命中（严格包含）', `${frac(m.spanStrict, m.spanItems)}   [带 span 条目 ${m.spanItems}]`)
  line('段落命中（区间相交）', frac(m.spanOverlap, m.spanItems))
  line('MRR', `${r.mrr.toFixed(4)}   [Σ1/rank = ${m.mrrSum.toFixed(4)} / ${m.neededQuestions}]`)
  line('误注入率（全部检查项·主指标）', `${frac(m.blacklistViolationQuestions, m.blacklistQuestions)}   [检查项 ${m.blacklistChecks}，命中 ${m.blacklistViolations}]`)
  line('误注入率（无共享词元子集·切片）', `${frac(m.blacklistNoSharedTokenViolationQuestions, m.blacklistNoSharedTokenQuestions)}   [切片检查项 ${m.blacklistNoSharedTokenChecks}]`)
  line('切片排除的检查项（难负例所在）', `${m.blacklistChecks - m.blacklistNoSharedTokenChecks} 项，其中命中 ${m.blacklistSharedTokenViolations} 次`)
  console.log('      ⚠️ 切片只是诊断：共享词元 ≠ 语义无关，切片排掉的恰恰是词法检索最容易犯错的难负例；')
  console.log('         不能由「无共享词元子集 = 0」推出「真实误注入为零」。')
  line('白名单外误注入', frac(m.whitelistViolationQuestions, m.whitelistQuestions))
  line('被失效抑制的命中', `${m.suppressedHits} 条 / ${m.suppressionQuestions} 题，${m.suppressedBytes} 字节未进正文`)
  console.log('      ↑ 这些命中仍在检索候选里（占据位次），只是投递层判了 expired_source；不是「检索没命中」。')
  line('重复文件（题数／多余条）', `${m.dupQuestions} / ${m.dupExtra}   [重复字节 ${m.dupExtraBytes}]`)
  line('无答案题仍注入', `${frac(m.overInjectQuestions, m.unresolvedQuestions)}   [只说「继续」这类题]`)
  line('无答案题拒绝率', frac(m.noAnswerRefused, m.unresolvedQuestions))
  line('Precision@k（标注相关集·下界）', `${frac(m.precisionHits, m.precisionDen)}   [可评题 ${m.precisionQuestions}]`)
  line('注入字节（候选片段代理）', `${m.injectedBytes} 总 / ${r.injectedBytesAvg.toFixed(1)} 平均每题`)
  line('平均候选数 candidates', r.candidatesAvg.toFixed(2))
  line('切分不全的题数', `${m.incompleteCoverageQuestions}   [skipped 文件合计 ${m.skippedFiles}]`)
  line('retrieve 抛错题数', String(m.retrieveErrors))
  line(`延迟 p50 / p95`, `${r.latencyP50.toFixed(3)} ms / ${r.latencyP95.toFixed(3)} ms   [最近秩法]`)
  void rows
}

/**
 * 难负例看板：四类各自一个分母。这是「误注入的两个口径」那节的正面修法 ——
 * 不靠共享词元筛切片，而是按「为什么难」单列，谁失败一目了然。
 */
function printHardNegatives(hard) {
  console.log('\n== 难负例（按为什么难单列）==')
  for (const [kind, label] of HARD_NEGATIVE_KINDS) {
    const h = hard[kind]
    if (!h.questions) {
      line(label, '0 题（本版题集未覆盖）')
      continue
    }
    if (kind === 'same-entity-different-time') {
      line(label, `新版召回 ${frac(h.newerRecalled, h.preferQuestions)} | 旧版压新版 ${frac(h.olderOverNewer, h.preferQuestions)} | 旧版被抑制 ${frac(h.olderSuppressed, h.preferQuestions)} | 题数 ${h.questions}`)
    } else if (kind === 'stale-content') {
      line(label, `误注入 ${frac(h.violationQuestions, h.blacklistQuestions)} | 检查项 ${h.blacklistChecks}（命中 ${h.violations}）| 被抑制 ${frac(h.suppressedBlacklistChecks, h.blacklistChecks)} | 题数 ${h.questions}`)
    } else {
      line(label, `误注入 ${frac(h.violationQuestions, h.blacklistQuestions)} | 检查项 ${h.blacklistChecks}（命中 ${h.violations}）| 题数 ${h.questions}`)
    }
  }
  console.log('      四类各自独立分母；不要拿「无共享词元子集」代替它们 —— 那个切片刻意排除了这四类。')
  console.log('      「被抑制」是归因字段：误注入归零若来自失效抑制，这里会如实显示，不会冒充排序修好了。')
}

// ─────────────────────────── 诊断报告 ───────────────────────────
function pctOf(num, den) {
  return den > 0 ? `${((num / den) * 100).toFixed(1)}%` : NA
}

/**
 * 可读的逐案例诊断报告。目标不是再印一遍指标，而是回答：
 * 「这条命中凭什么被放进来 / 这条 needed 为什么没命中 / 这个误注入走的是哪条路」。
 */
function renderDiagnostics({ opts, corpus, rows, m, r, audit, corpusHash, questionHash, baselineReport, hard }) {
  const { chunks, stats } = chunksOf(corpus)
  const chunkById = new Map(chunks.map((c) => [c.id, c]))
  const flagged = rows.filter((row) =>
    row.blacklistHit.length > 0 ||
    row.whitelistHit.length > 0 ||
    row.verdict === 'MISS' ||
    row.verdict === 'ERROR' ||
    (row.question.unresolved && row.hits.length > 0) ||
    row.question.note.includes(LEXFAIL) ||
    row.prefer?.olderOverNewer === true,
  )
  const out = []
  const push = (...xs) => out.push(...xs)

  push('# 检索诊断报告', '')
  push('> 由 `scripts/eval-retrieval.mjs --report` 生成，**不要手改**。')
  push(`> 生成时间：${new Date().toISOString()}；mode=${opts.mode}，limit=${opts.limit}，per-file=${opts.perFile}。`, '')
  push('## 运行信息', '')
  push(`- 语料：${corpus.length} 份；问题集：${rows.length} 题；语料指纹 \`${corpusHash}\`，题号指纹 \`${questionHash}\`。`)
  push(`- 误注入（主指标）：${m.blacklistViolationQuestions}/${m.blacklistQuestions} 道有黑名单检查的题；检查项共 ${m.blacklistChecks} 个。`)
  push(`- 白名单外：${m.whitelistViolationQuestions}/${m.whitelistQuestions} 道有白名单检查的题。`)
  push(`- 无答案题：仍注入 ${m.overInjectQuestions}/${m.unresolvedQuestions}，拒绝率 ${pctOf(m.noAnswerRefused, m.unresolvedQuestions)}。`)
  if (baselineReport) {
    push(`- 基线比较：${baselineReport.status}${baselineReport.regressions?.length ? `（退化：${baselineReport.regressions.join(', ')}）` : ''}`)
  }
  push('')
  push('## 指标（含诊断口径）', '', '| 指标 | 值 |', '|---|---|')
  push(`| Recall@k（任一命中） | ${m.anyHit}/${m.neededQuestions} = ${pctOf(m.anyHit, m.neededQuestions)} |`)
  push(`| 全中率（全部 needed） | ${m.allHit}/${m.neededQuestions} = ${pctOf(m.allHit, m.neededQuestions)} |`)
  push(`| 条目级召回 | ${m.foundItems}/${m.neededItems} = ${pctOf(m.foundItems, m.neededItems)} |`)
  push(`| 段落命中（严格） | ${m.spanStrict}/${m.spanItems} = ${pctOf(m.spanStrict, m.spanItems)} |`)
  push(`| MRR | ${r.mrr.toFixed(4)}（Σ1/rank = ${m.mrrSum.toFixed(4)} / ${m.neededQuestions}） |`)
  push(`| 误注入率（主指标） | ${m.blacklistViolationQuestions}/${m.blacklistQuestions} = ${pctOf(m.blacklistViolationQuestions, m.blacklistQuestions)} |`)
  push(`| 白名单外误注入 | ${m.whitelistViolationQuestions}/${m.whitelistQuestions} = ${pctOf(m.whitelistViolationQuestions, m.whitelistQuestions)} |`)
  push(`| 被失效抑制的命中 | ${m.suppressedHits} 条 / ${m.suppressionQuestions} 题（${m.suppressedBytes} 字节未进正文） |`)
  push(`| 无答案题拒绝率 | ${m.noAnswerRefused}/${m.unresolvedQuestions} = ${pctOf(m.noAnswerRefused, m.unresolvedQuestions)} |`)
  push(`| Precision@k（标注相关集·下界） | ${m.precisionHits}/${m.precisionDen} = ${pctOf(m.precisionHits, m.precisionDen)}（可评题 ${m.precisionQuestions}） |`)
  push(`| 注入字节（候选片段代理） | ${m.injectedBytes} 总 / ${r.injectedBytesAvg.toFixed(1)} 平均每题 |`)
  push(`| 延迟 p50 / p95 | ${r.latencyP50.toFixed(3)} ms / ${r.latencyP95.toFixed(3)} ms |`)
  push('')
  if (hard && Object.values(hard).some(h => h.questions)) {
    push('## 难负例（按为什么难单列）', '')
    push('| 类别 | 题数 | 主要读数 |', '|---|---|---|')
    for (const [kind, label] of HARD_NEGATIVE_KINDS) {
      const h = hard[kind]
      if (!h.questions) continue
      const reading =
        kind === 'same-entity-different-time'
          ? `新版召回 ${h.newerRecalled}/${h.preferQuestions}；旧版压新版 ${h.olderOverNewer}/${h.preferQuestions}；旧版被抑制 ${h.olderSuppressed}/${h.preferQuestions}`
          : `误注入 ${h.violationQuestions}/${h.blacklistQuestions}（检查项 ${h.blacklistChecks}，命中 ${h.violations}）` +
            (kind === 'stale-content' ? `；被抑制 ${h.suppressedBlacklistChecks}/${h.blacklistChecks}` : '')
      push(`| ${label} | ${h.questions} | ${reading} |`)
    }
    push('')
    push('这四类各自独立分母；**不要**拿「无共享词元子集」代替它们（那个切片会把这四类排除掉）。', '')
  }
  push('## 逐案例', '')
  push(`触发诊断的题：${flagged.length} 道（误注入 / 白名单外 / 无答案注入 / 词法边界 / MISS）。`, '')
  if (!flagged.length) push('（没有触发诊断条件的题）', '')
  for (const row of flagged) {
    const q = row.question
    push(`### ${q.id} · ${row.verdict} · scope=${row.scope}`, '')
    push(`- 问题：「${q.query}」`)
    push(`- 备注：${q.note || '—'}`)
    push(`- needed：${row.needed.length ? row.needed.map((n) => `${n.file}${n.span ? ` [${n.span[0]}-${n.span[1]}]` : ''} ${n.found ? `✓@${n.rank}` : '✗'}`).join('；') : '—'}`)
    const flags = []
    if (row.suppressed.length) flags.push(`已抑制（expired_source）：${row.suppressed.map((s) => s.file).join(', ')}`)
    if (row.blacklistHit.length) flags.push(`黑名单命中：${row.blacklistHit.join(', ')}`)
    if (row.whitelistHit.length) flags.push(`白名单外：${row.whitelistHit.join(', ')}`)
    if (q.unresolved && row.hits.length) flags.push('无答案题仍注入')
    if (q.note.includes(LEXFAIL)) flags.push('已知词法边界（query 与原文没有词面重合）')
    if (row.prefer?.olderOverNewer) flags.push(`旧版压新版（${row.prefer.older} @${row.prefer.olderRank || '未中'} 压过 ${row.prefer.newer} @${row.prefer.newerRank || '未中'}）`)
    if (!row.coverage.complete) flags.push(`切分不全（skipped ${row.coverage.skipped}）`)
    if (row.dupExtra > 0) flags.push(`同文件重复 ${row.dupExtra} 条`)
    if (flags.length) push(`- 标记：${flags.join('；')}`)
    push('')
    if (row.hits.length) {
      push('| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |', '|---|---|---|---|---|---|')
      for (const [i, h] of row.hits.entries()) {
        const ev = h.evidence === null ? '—（摘要层无门槛）' : `${h.evidence} / ${h.evidenceSum} / ${h.evidenceRarestDf} / ${h.evidenceRun}`
        push(`| ${i + 1} | ${h.file} | ${h.lines ? `${h.lines[0]}-${h.lines[1]}` : '—'} | ${h.score} | ${h.matchedBy.join('+')} | ${ev} |`)
      }
      push('')
    } else {
      push('（没有命中）', '')
    }
    push('**诊断**：', '')
    if (row.blacklistHit.length) {
      const summaryLayer = row.hits.filter((h) =>
        row.blacklistHit.includes(h.file) &&
        h.matchedBy.some((x) => ['description', 'alias', 'filename', 'summary'].includes(x)),
      )
      if (summaryLayer.length) {
        push('- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。')
      } else {
        push('- 误注入来自**正文路径**：下面是它通过证据门槛的现场数值。')
      }
    }
    for (const h of row.hits) {
      if (h.evidence === null) continue
      const rareOk = h.evidenceRarestDf <= 1 || h.evidenceRarest <= MAX_EVIDENCE_DF_RATIO
      const checks = [
        [`ratio ${h.evidence} ${h.evidence >= MIN_EVIDENCE_RATIO ? '≥' : '<'} ${MIN_EVIDENCE_RATIO}`, h.evidence >= MIN_EVIDENCE_RATIO],
        [`sum ${h.evidenceSum} ${h.evidenceSum >= MIN_EVIDENCE_SUM ? '≥' : '<'} ${MIN_EVIDENCE_SUM}`, h.evidenceSum >= MIN_EVIDENCE_SUM],
        [`rarestDf ${h.evidenceRarestDf} / ${h.evidenceRarest} ${rareOk ? '满足' : '不满足'}冷门判据`, rareOk],
        [`run ${h.evidenceRun} ${h.evidenceRun >= MIN_MATCHED_RUN ? '≥' : '<'} ${MIN_MATCHED_RUN}`, h.evidenceRun >= MIN_MATCHED_RUN],
      ]
      const failed = checks.filter(([, ok]) => !ok).map(([label]) => label)
      push(`- \`${h.file}\` 正文门槛：${checks.map(([label, ok]) => `${ok ? '✓' : '✗'} ${label}`).join('；')}${failed.length ? `（**未过** ${failed.length} 项；命中若仍存在，说明它经由摘要层进入）` : '（通过）'}`)
      const chunk = chunkById.get(h.id)
      if (chunk) {
        const bd = scoreDocBreakdown(queryTermsOf(q.query), chunk.tf, chunk.dl, stats)
        if (bd.length) {
          const top = bd.slice().sort((a, b) => b.score - a.score).slice(0, 6)
          push(`  - 词元贡献（前 ${top.length}）：${top.map((x) => `\`${x.term}\` idf=${x.idf.toFixed(2)} tf=${x.tf} → ${x.score.toFixed(2)}`).join('；')}`)
        }
      }
    }
    if (row.verdict === 'MISS') {
      push(`- 未命中线索：needed 不在 top-${opts.limit}；本次候选 ${row.coverage.candidates} 条，正文门槛滤掉 ${row.coverage.filteredBelowFloor ?? 0} 条。`)
    }
    push('')
  }
  push('## 口径说明', '')
  push('- **Precision@k 是下界**：相关集取「标注 needed ∪ allowFiles」；合成语料里未标注但相关的文件不会计入分子。')
  push('- **注入字节**用候选片段字节代理；真实注入还受单场会话预算裁切（契约 2.5，软上限）。')
  push(`- **失效抑制**：注入前先按 \`invalid_at\`（评测时钟固定为 ${new Date(EVAL_NOW_MS).toISOString()}）判 \`expired_source\`；被抑制的命中仍占检索候选位次，但不计入注入、也不计入误注入。误注入归零时请对照难负例表里的「被抑制 / 旧版被抑制」列，别把抑制当成检索变好了。`)
  push(`- **黑名单主指标**按「有黑名单检查的题」计，不按检查项计；本版是 ${m.blacklistViolationQuestions}/${m.blacklistQuestions} 题、检查项 ${m.blacklistChecks} 个。`)
  push('- **摘要层没有 evidence 门槛**是有意设计（摘要只有一句话，词面重合已经是较强信号）；代价是共享常用词的记忆会被误注入，这正是 1.7.2 难负例扩容要压的。')
  push('')
  push('## 复现', '')
  push('```powershell')
  push(`node scripts/eval-retrieval.mjs --mode ${opts.mode} --limit ${opts.limit} --per-file ${opts.perFile} --baseline test/eval/baseline.json --report docs/retrieval-diagnostics.md`)
  push('```')
  return out.join('\n') + '\n'
}

// ─────────────────────────── 主流程 ───────────────────────────

function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    console.log(USAGE)
    return 0
  }
  if (opts.diff) return diffBaselines(opts.diff[0], opts.diff[1])
  if (!['summary', 'body', 'all', 'mixed'].includes(opts.mode)) {
    throw new Error(`--mode 只能是 summary|body|all|mixed，收到 ${opts.mode}`)
  }
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(MAX_LIMIT, Math.round(opts.limit))) : DEFAULT_LIMIT
  const perFile = Number.isFinite(opts.perFile) && opts.perFile >= 1 ? Math.max(1, Math.floor(opts.perFile)) : PER_FILE_CHUNKS

  const corpus = loadCorpus(opts.corpus)
  const questions = loadQuestions(opts.questions)
  if (!corpus.length) throw new Error(`语料是空的：${opts.corpus}`)
  if (!questions.length) throw new Error(`问题集是空的：${opts.questions}`)

  const corpusHash = createHash('sha256').update(corpus.map(f => `${f.file}\u0000${f.content}`).join('\u0001')).digest('hex').slice(0, 12)
  // 指纹取问题集文件的**原始字节**而不是题号列表：改了 span / 黑名单 / note 都会换指纹，
  // 这样 --baseline 就不会拿一份标注已经变了的旧结果来做对比。
  const questionHash = createHash('sha256').update(readFileSync(opts.questions)).digest('hex').slice(0, 12)
  const audit = auditAnnotations(questions, corpus)

  console.log('sage-mem 检索评测')
  line('语料目录', `${opts.corpus}（${corpus.length} 份，内容指纹 ${corpusHash}）`)
  line('问题集', `${opts.questions}（${questions.length} 题，题号指纹 ${questionHash}）`)
  line('mode / limit / per-file', `${opts.mode} / ${limit} / ${perFile}`)
  const bodyLens = corpus.map(f => {
    const m = f.content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)
    return m ? f.content.slice(m[0].length).length : f.content.length
  })
  line('语料正文长度', `最短 ${Math.min(...bodyLens)} / 最长 ${Math.max(...bodyLens)} 字符`)
  line('frontmatter 摘要', `description 非空 ${corpus.filter(f => f.description).length}/${corpus.length}，aliases 非空 ${corpus.filter(f => f.aliases.length).length}/${corpus.length}`)

  console.log('\n== 标注自检 ==')
  line('needed 文件缺失', String(audit.missingNeeded.length))
  line('span 越界或倒序', String(audit.badSpans.length))
  line('黑名单文件缺失', String(audit.missingBlacklist.length))
  line('白名单文件缺失', String(audit.missingWhitelist.length))
  line('白名单缺 needed', String(audit.whitelistMissingNeeded.length))
  line('难负例分类非法', String(audit.badHardNegative.length))
  line('preferNewer 标注不全', String(audit.missingPreferNewer.length + audit.preferNotInNeeded.length))
  line('黑名单检查项', `${audit.blacklistChecks} 项，其中无共享词元 ${audit.noSharedTokenChecks} 项，涉及题数 ${audit.noSharedTokenQuestions}`)
  line('切片排除的检查项', `${audit.blacklistChecks - audit.noSharedTokenChecks} 项（query 词元与文件重合 —— 难负例候选）`)
  for (const s of audit.sharedTokenSamples) console.log(`      ${s}`)
  // 2.0.0：有效性标注自检（每条都要能红；坏标注会让「已失效内容」的分母悄悄变小）
  line('有效性标注坏格式', String(audit.badValidity.length))
  line('superseded_by 悬空', String(audit.badSupersededBy.length))
  line('stale-content 未标失效', String(audit.staleNotMarked.length))
  line('needed 被标记失效', String(audit.neededSuppressed.length))
  line('preferNewer 旧版未标失效', String(audit.preferOlderNotExpired.length))
  line('评测时钟 / 已失效语料', `${new Date(EVAL_NOW_MS).toISOString()} · ${audit.expiredFiles.length} 份：${audit.expiredFiles.join(', ') || '—'}`)

  // 注入侧语义：命中先过一遍失效集合（与 `composeDelivery` 的 `expired` 集合同一个判据）。
  const expirySet = audit.expirySet
  const rows = questions.map(q =>
    evaluateQuestion(q, opts.mode === 'mixed' ? q.scope : opts.mode, corpus, limit, perFile, audit.sharedTokenPairs, expirySet))

  console.log('\n== 逐题明细 ==')
  for (const row of rows) for (const l of detailLines(row)) console.log(l)

  const m = summarize(rows)
  const r = rates(m)
  const hard = summarizeHard(rows)
  // 难负例比率并进 rates：这样它们能进 --baseline 对比，也能被 --json 消费方看到。
  Object.assign(r, hardRates(hard))
  printMetrics(`指标（mode=${opts.mode}, limit=${limit}, per-file=${perFile}）`, rows, m, r)

  // 对照：同一批题目在 summary 面下再跑一遍。这是脚本自带的「改动有没有真的扩到正文」的证据，
  // 不依赖任何历史基线，所以第一次跑就能看出问题。
  let reference = null
  if (opts.mode !== 'summary') {
    const refRows = runAll(questions, corpus, 'summary', limit, perFile, audit.sharedTokenPairs, expirySet)
    const refM = summarize(refRows)
    const refR = rates(refM)
    reference = { mode: 'summary', raw: refM, rates: refR }
    console.log('\n== 对照：summary 面 vs 本模式（同一批题目、同一 limit）==')
    line('summary Recall@L', frac(refM.anyHit, refM.neededQuestions))
    line('本模式 Recall@L', frac(m.anyHit, m.neededQuestions))
    line('summary 段落命中（严格）', frac(refM.spanStrict, refM.spanItems))
    line('本模式 段落命中（严格）', frac(m.spanStrict, m.spanItems))
  }

  console.log('\n== 分组 ==')
  const groups = [
    ['摘要题（shouldReturn=summary）', rows.filter(x => x.question.shouldReturn === 'summary')],
    ['正文题（shouldReturn=body）', rows.filter(x => x.question.shouldReturn === 'body')],
    ['已知词法边界 ' + LEXFAIL, rows.filter(x => x.question.note.includes(LEXFAIL))],
    ['无答案题（unresolved 且不该注入）', rows.filter(x => x.question.unresolved && !x.question.shouldInject)],
    // 把「原有题」与「难负例题」分开看：加难负例不该把原有题的召回数字拉下来，
    // 这两个分组是把这句验收判据变成可读证据的地方。
    ['原有题（无 hardNegative 标注）', rows.filter(x => !x.question.hardNegative)],
    ['难负例题（有 hardNegative 标注）', rows.filter(x => Boolean(x.question.hardNegative))],
  ]
  for (const [name, groupRows] of groups) {
    if (!groupRows.length) continue
    const gm = summarize(groupRows)
    const gr = rates(gm)
    console.log(
      `  ${name}\n` +
        `      Recall@L ${frac(gm.anyHit, gm.neededQuestions)} | 全中 ${frac(gm.allHit, gm.neededQuestions)} | ` +
        `段落严格 ${frac(gm.spanStrict, gm.spanItems)} | MRR ${gr.mrr.toFixed(4)}（Σ ${gm.mrrSum.toFixed(4)}/${gm.neededQuestions}）| ` +
        `误注入（全部检查项）${frac(gm.blacklistViolationQuestions, gm.blacklistQuestions)} | ` +
        `误注入切片 ${frac(gm.blacklistNoSharedTokenViolationQuestions, gm.blacklistNoSharedTokenQuestions)} | ` +
        `仍注入 ${frac(gm.overInjectQuestions, gm.unresolvedQuestions)}`,
    )
  }

  printHardNegatives(hard)

  // ── 判定 ──
  const problems = [
    ...audit.missingNeeded.map(x => `needed 文件不存在：${x}`),
    ...audit.badSpans.map(x => `span 越界：${x}`),
    ...audit.missingBlacklist.map(x => `黑名单文件不存在：${x}`),
    ...audit.missingWhitelist.map(x => `白名单文件不存在：${x}`),
    ...audit.whitelistMissingNeeded.map(x => `白名单标注不全：${x}`),
    ...audit.badHardNegative.map(x => `难负例分类非法：${x}`),
    ...audit.missingPreferNewer.map(x => `preferNewer 标注不全：${x}`),
    ...audit.preferNotInNeeded.map(x => `preferNewer 与 needed 不一致：${x}`),
    ...audit.badValidity.map(x => `有效性标注坏格式：${x}`),
    ...audit.badSupersededBy.map(x => `superseded_by 悬空：${x}`),
    ...audit.staleNotMarked.map(x => `stale-content 未标失效：${x}`),
    ...audit.neededSuppressed.map(x => `needed 被标记失效：${x}`),
    ...audit.preferOlderNotExpired.map(x => `preferNewer 旧版未标失效：${x}`),
  ]
  const structural = []
  for (const row of rows) {
    if (row.error) structural.push(`${row.question.id} retrieve 抛错：${row.error}`)
    if (!row.error && !row.ok) structural.push(`${row.question.id} retrieve 返回 ok=false`)
    if (row.dupExtra > 0) structural.push(`${row.question.id} 同一文件重复出现 ${row.dupExtra} 次`)
    if (!row.coverage.complete) structural.push(`${row.question.id} 切分不全（skipped ${row.coverage.skipped}）`)
  }
  const strictViolations = opts.strict
    ? rows.filter(x => x.blacklistHit.length || x.whitelistHit.length).map(x => x.question.id)
    : []
  const comparisonRegression =
    reference && opts.mode === 'all' && m.anyHit / Math.max(1, m.neededQuestions) < reference.rates.recallAny

  // ── 与旧产物对比 ──
  let baselineReport = null
  if (opts.baseline) {
    baselineReport = compareBaseline(opts.baseline, { mode: opts.mode, limit, profile: { corpusHash, questionHash } }, m, r)
    console.log('\n== 与基线对比 ==')
    line('基线', opts.baseline)
    line('状态', baselineReport.status)
    if (baselineReport.status === 'inconclusive') {
      line('原因', baselineReport.reason)
      if (opts.allowBaselineSkip) {
        line('处理', '已按 --allow-baseline-skip 放行（此项不影响退出码）')
      } else {
        line('处理', '显式要求了比较却没有比成 → 按失败关闭处理（退出码 1）')
        console.log('      探索场景确实要跳过时再加 --allow-baseline-skip。')
      }
    } else {
      for (const row of baselineReport.rows) {
        line(`${row.key}（${row.dir === 'up' ? '越高越好' : '越低越好'}）`, `${row.before} → ${row.after} ${row.verdict}`)
      }
      line('判定', baselineReport.regressions.length ? `退化 ${baselineReport.regressions.length} 项：${baselineReport.regressions.join(', ')}` : '无退化')
    }
  }

  console.log('\n== 结论 ==')
  line('标注问题', String(problems.length))
  line('结构性错误', String(structural.length))
  line('strict 误注入题', strictViolations.length ? strictViolations.join(', ') : '0')
  line('all vs summary 对照', reference ? (comparisonRegression ? '退化（all 低于 summary）' : '未退化') : '未跑（当前就是 summary）')
  line('基线比较', baselineReport ? baselineReport.status : '未要求')
  for (const p of [...problems, ...structural]) console.log(`      ! ${p}`)
  if (baselineReport?.status === 'inconclusive' && !opts.allowBaselineSkip) {
    console.log(`      ! 显式给了 --baseline 但比较没完成（${baselineReport.reason}）`)
  }

  const baselineRegressed = Boolean(baselineReport && baselineReport.status === 'compared' && baselineReport.regressions.length)
  const baselineUnresolved = Boolean(baselineReport && baselineReport.status === 'inconclusive' && !opts.allowBaselineSkip)
  const failed =
    problems.length > 0 ||
    structural.length > 0 ||
    strictViolations.length > 0 ||
    comparisonRegression ||
    baselineRegressed ||
    baselineUnresolved

  if (opts.json) {
    const payload = {
      tool: 'sage-mem eval-retrieval',
      // 基线自述身份：哪一版、什么时候、什么口径量的。--diff 直接读这两个字段。
      version: CURRENT_VERSION,
      generatedAt: new Date().toISOString(),
      mode: opts.mode,
      limit,
      perFile,
      corpus: { dir: opts.corpus, files: corpus.length, hash: corpusHash },
      questions: { path: opts.questions, count: questions.length, hash: questionHash },
      audit: {
        missingNeeded: audit.missingNeeded,
        badSpans: audit.badSpans,
        missingBlacklist: audit.missingBlacklist,
        missingWhitelist: audit.missingWhitelist,
        whitelistMissingNeeded: audit.whitelistMissingNeeded,
        badHardNegative: audit.badHardNegative,
        missingPreferNewer: audit.missingPreferNewer,
        preferNotInNeeded: audit.preferNotInNeeded,
        badValidity: audit.badValidity,
        badSupersededBy: audit.badSupersededBy,
        staleNotMarked: audit.staleNotMarked,
        neededSuppressed: audit.neededSuppressed,
        preferOlderNotExpired: audit.preferOlderNotExpired,
        blacklistChecks: audit.blacklistChecks,
        noSharedTokenChecks: audit.noSharedTokenChecks,
        noSharedTokenQuestions: audit.noSharedTokenQuestions,
        sharedTokenSamples: audit.sharedTokenSamples,
      },
      // 2.0.0：评测所依据的「现在」与失效语料名单。写进产物是为了让「为什么这 6 份
      // 被抑制」在离开这次运行之后仍然可核对（固定时钟，不读 Date.now()）。
      validity: {
        clockMs: EVAL_NOW_MS,
        clockISO: new Date(EVAL_NOW_MS).toISOString(),
        expiredFiles: audit.expiredFiles,
        suppressedHits: m.suppressedHits,
        suppressionQuestions: m.suppressionQuestions,
        suppressedBytes: m.suppressedBytes,
        semantics: '命中先检索、后在投递层按 invalid_at 判 expired_source；被抑制的命中仍占候选位次。',
      },
      // 指标口径写给结构化消费方：主指标是哪一个、切片叫什么、切片为什么不能当结论。
      // 放在 JSON 里而不是只写在输出里，是因为 CI/看板往往只读这个文件。
      metricsSemantics: {
        primaryFalseInjection: 'falseInjectRate',
        diagnosticSlice: 'noSharedTokenSubsetRate',
        sliceCaveat:
          '共享词元 ≠ 语义无关。切片只保留「query 与文件一个词元都不共享」的检查项，' +
          '因而系统性排除了词法检索最容易犯错的难负例（共享常用词、同名不同项目、同实体不同时间、已失效内容）；' +
          '不能由切片为 0 推出真实误注入为零。',
        suppression:
          '2.0.0 起命中先过投递层的失效集合（`invalid_at` 已到点 → expired_source）；' +
          '被抑制的命中仍占检索候选位次，不计入「注入」也不计入「误注入」。' +
          '难负例看板的「旧版被抑制 / 被抑制」两项是归因字段，用来区分「排序修好了」与「被失效挡掉了」。',
      },
      metrics: { raw: m, rates: r },
      // 难负例四类的原始计数（题数/检查项/命中），比 rates 更能看出分母。
      hardNegatives: hard,
      groups: Object.fromEntries(
        groups.filter(([, g]) => g.length).map(([name, g]) => {
          const gm = summarize(g)
          return [name, { raw: gm, rates: rates(gm) }]
        }),
      ),
      reference,
      detail: rows.map(row => ({
        id: row.question.id,
        query: row.question.query,
        scope: row.scope,
        verdict: row.verdict,
        note: row.question.note,
        hits: row.hits.map(h => ({
          id: h.id,
          file: h.file,
          title: h.title,
          headingPath: h.headingPath,
          lines: h.lines,
          score: h.score,
          matchedBy: h.matchedBy,
          evidence: h.evidence,
          evidenceSum: h.evidenceSum,
          evidenceRarest: h.evidenceRarest,
          evidenceRarestDf: h.evidenceRarestDf,
          evidenceRun: h.evidenceRun,
        })),
        needed: row.needed,
        suppressed: row.suppressed,
        allCandidates: row.allCandidates,
        blacklistHit: row.blacklistHit,
        whitelistHit: row.whitelistHit,
        dupExtra: row.dupExtra,
        precisionAtK: row.precisionAtK,
        injectedBytes: row.injectedBytes,
        ms: Number(row.ms.toFixed(4)),
        coverage: row.coverage,
      })),
      problems,
      structural,
      baseline: baselineReport,
      failed,
    }
    writeFileSync(opts.json, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(`\nJSON 已写入 ${opts.json}`)
  }

  if (opts.report) {
    const md = renderDiagnostics({ opts, corpus, rows, m, r, audit, corpusHash, questionHash, baselineReport, hard })
    mkdirSync(dirname(opts.report), { recursive: true })
    writeFileSync(opts.report, md, 'utf8')
    console.log(`\n诊断报告已写入 ${opts.report}`)
  }

  console.log(`\n退出码：${failed ? 1 : 0}`)
  return failed ? 1 : 0
}

// ─────────────────────────── 基线对比 ───────────────────────────

/** 只比「方向明确」的比率。延迟不进对比：它随机器与当时负载变，比它只会天天报警。 */
const COMPARED = [
  ['recallAny', 'up'],
  ['recallAll', 'up'],
  ['itemRecall', 'up'],
  ['spanStrictRate', 'up'],
  ['spanOverlapRate', 'up'],
  ['mrr', 'up'],
  ['falseInjectRate', 'down'],
  ['noSharedTokenSubsetRate', 'down'],
  ['whitelistViolationRate', 'down'],
  ['dupQuestionRate', 'down'],
  ['overInjectRate', 'down'],
  // 难负例四类（1.7.2 起）：各自独立分母。方向按「该不该被压住」定，
  // 别把它们和「无共享词元切片」混为一谈 —— 那个切片刻意排除了这四类。
  ['hardSharedWordInjectRate', 'down'],
  ['hardSameNameInjectRate', 'down'],
  ['hardNewerRecallRate', 'up'],
  ['hardOlderOverNewerRate', 'down'],
  ['hardOlderSuppressedRate', 'up'],
  ['hardStaleInjectRate', 'down'],
  // 2.0.0：把「归零」归因到失效抑制（越高越好 = 该被挡的都被挡了）。
  // ⚠️ 这一项高不代表检索变好；它只说明「误注入归零」不是幻觉。
  ['hardStaleSuppressedRate', 'up'],
]

/**
 * 旧产物里的别名。`noSharedTokenSubsetRate` 的前身叫 `falseInjectSafeRate`——
 * 名字在 R08 里被改掉了（旧名暗示「这才是真实的误注入」），但**数字的含义没变**，
 * 所以老基线仍然可比：读的时候认两个键，写的时候只写新键。
 */
const RATE_ALIASES = { noSharedTokenSubsetRate: ['falseInjectSafeRate'] }

/**
 * 基线 schema 校验：**缺项也算比较没完成**，不许拿 0 顶上。
 *
 * 为什么不能默认填 0：方向是「越高越好」的指标缺项会被填成 0，一比就成了「改善」；
 * 方向是「越低越好」的会被填成 0，一比也成了「改善」。两种都是**假的通过**。
 * 于是「基线文件写坏了」会被读成「这次跑得更好」，比读不到基线还危险。
 */
function validateBaseline(old) {
  if (!old || typeof old !== 'object' || Array.isArray(old)) return { ok: false, why: '基线不是 JSON 对象' }
  const rates = old.metrics?.rates
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) return { ok: false, why: '基线缺 metrics.rates（不是一次 --json 产物？）' }
  const missing = []
  for (const [key] of COMPARED) {
    const candidates = [key, ...(RATE_ALIASES[key] ?? [])]
    const found = candidates.find(k => Number.isFinite(rates[k]))
    if (found === undefined) missing.push(key)
  }
  if (missing.length) return { ok: false, why: `基线缺这些指标（或被填成非数字）：${missing.join(', ')}` }
  if (!Number.isFinite(old.metrics?.raw?.questions) || old.metrics.raw.questions <= 0) {
    return { ok: false, why: '基线缺 metrics.raw.questions（或不是正数）—— 指标记录不完整' }
  }
  if (typeof old.mode !== 'string' || !Number.isFinite(Number(old.limit))) return { ok: false, why: '基线缺 mode / limit' }
  if (typeof old.corpus?.hash !== 'string' || !old.corpus.hash) return { ok: false, why: '基线缺 corpus.hash' }
  if (typeof old.questions?.hash !== 'string' || !old.questions.hash) return { ok: false, why: '基线缺 questions.hash' }
  return { ok: true, why: '' }
}

/**
 * 与旧产物对比。
 *
 * 返回 `status`：`compared`（真的比了）或 `inconclusive`（没比成）。
 * **没比成不是「没问题」**——调用方必须按失败关闭处理，除非显式给了 --allow-baseline-skip。
 */
function compareBaseline(path, current, m, r) {
  const inconclusive = (reason) => ({ status: 'inconclusive', reason, rows: [], regressions: [], previousGeneratedAt: '' })
  let old
  try {
    old = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return inconclusive(`读不到或读不坏基线 ${path}：${err?.message ?? err}`)
  }
  const schema = validateBaseline(old)
  if (!schema.ok) return inconclusive(`基线 schema 不合格：${schema.why}`)
  if (old.mode !== current.mode || Number(old.limit) !== current.limit) {
    return inconclusive(`基线是 mode=${old.mode} limit=${old.limit}，当前是 mode=${current.mode} limit=${current.limit}，不可比`)
  }
  if (old.questions.hash !== current.profile.questionHash || old.corpus.hash !== current.profile.corpusHash) {
    return inconclusive('基线来自不同的问题集或语料，指标不可比（先重新生成基线）')
  }
  const eps = 1e-9
  const rows = []
  const regressions = []
  for (const [key, dir] of COMPARED) {
    const candidates = [key, ...(RATE_ALIASES[key] ?? [])]
    const source = candidates.find(k => Number.isFinite(old.metrics.rates[k]))
    const before = old.metrics.rates[source]
    const after = Number(r[key])
    const worse = dir === 'up' ? after < before - eps : after > before + eps
    const better = dir === 'up' ? after > before + eps : after < before - eps
    const verdict = worse ? '✗ 退化' : better ? '✓ 改善' : '＝ 持平'
    rows.push({ key, dir, before: before.toFixed(4), after: after.toFixed(4), verdict })
    if (worse) regressions.push(key)
  }
  void m
  return { status: 'compared', reason: '', rows, regressions, previousGeneratedAt: old.generatedAt ?? '' }
}

// ─────────────────────────── 任意两份基线对比（--diff） ───────────────────────────

function loadBaselineFile(path) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (err) {
    return { ok: false, why: `读不到或读不坏 ${path}：${err?.message ?? err}` }
  }
}

/** 从一份历史产物里抽出可比对的自述与口径。缺字段写 `(未记录)`，不猜。 */
function baselineFacts(path, data) {
  return {
    path,
    version: typeof data.version === 'string' && data.version ? data.version : '(未记录)',
    generatedAt: typeof data.generatedAt === 'string' && data.generatedAt ? data.generatedAt : '(未记录)',
    mode: data.mode ?? '(未记录)',
    limit: data.limit ?? '(未记录)',
    perFile: data.perFile ?? '(未记录)',
    questions: data.questions?.count ?? '(未记录)',
    questionHash: data.questions?.hash ?? '(未记录)',
    corpusFiles: data.corpus?.files ?? '(未记录)',
    corpusHash: data.corpus?.hash ?? '(未记录)',
    rates: data.metrics?.rates && typeof data.metrics.rates === 'object' ? data.metrics.rates : {},
    hardNegatives: data.hardNegatives ?? null,
  }
}

/**
 * `--diff a b`：比较**任意两份**历史产物，不跑检索。
 *
 * 与 `--baseline` 的分工：
 *   - `--baseline` 是**门禁**：口径（mode/limit/题集/语料指纹）必须一致，退化即退出码 1；
 *   - `--diff` 是**考古**：口径不同也能比，但只给方向与量级，并显式说明「不可当回归判定」。
 *
 * 为什么需要后者：题集会随版本扩容（1.7.2 就在扩容），历史基线必然与当前不同口径；
 * 若只有严格门禁，跨版本的趋势就永远读不出来了。所以这里放宽口径，但把话说清楚。
 */
function diffBaselines(aPath, bPath) {
  console.log('sage-mem 基线对比（--diff：两份历史产物，不跑检索）')
  const a = loadBaselineFile(aPath)
  if (!a.ok) {
    console.log(`  ! A 侧 ${a.why}`)
    return 1
  }
  const b = loadBaselineFile(bPath)
  if (!b.ok) {
    console.log(`  ! B 侧 ${b.why}`)
    return 1
  }
  const A = baselineFacts(aPath, a.data)
  const B = baselineFacts(bPath, b.data)
  const side = (label, facts) => {
    line(label, facts.path)
    line('  版本 / 生成时间', `${facts.version} · ${facts.generatedAt}`)
    line('  口径', `mode=${facts.mode} limit=${facts.limit} per-file=${facts.perFile} · 题数 ${facts.questions} · 语料 ${facts.corpusFiles} 份`)
    line('  指纹', `题集 ${facts.questionHash} · 语料 ${facts.corpusHash}`)
  }
  side('A（旧）', A)
  side('B（新）', B)

  const sameProfile =
    String(A.mode) === String(B.mode) &&
    String(A.limit) === String(B.limit) &&
    String(A.questionHash) === String(B.questionHash) &&
    String(A.corpusHash) === String(B.corpusHash)
  console.log('')
  line('口径判定', sameProfile ? '一致（可当回归判定）' : '不同（只可看方向与量级，不可当回归判定）')
  if (!sameProfile) {
    const why = []
    if (String(A.mode) !== String(B.mode)) why.push(`mode ${A.mode} → ${B.mode}`)
    if (String(A.limit) !== String(B.limit)) why.push(`limit ${A.limit} → ${B.limit}`)
    if (String(A.questionHash) !== String(B.questionHash)) why.push(`题集指纹 ${A.questionHash} → ${B.questionHash}`)
    if (String(A.corpusHash) !== String(B.corpusHash)) why.push(`语料指纹 ${A.corpusHash} → ${B.corpusHash}`)
    console.log(`      ${why.join('；')}`)
    console.log('      题集/语料变了，比率的分子分母含义也不同：看方向可以，别拿它告警。')
  }

  const eps = 1e-9
  console.log('\n== 指标（A → B）==')
  let improved = 0
  let regressed = 0
  let omitted = 0
  for (const [key, dir] of COMPARED) {
    const pick = rates => {
      const candidates = [key, ...(RATE_ALIASES[key] ?? [])]
      const found = candidates.find(k => Number.isFinite(rates[k]))
      return found === undefined ? null : Number(rates[found])
    }
    const before = pick(A.rates)
    const after = pick(B.rates)
    if (before === null || after === null) {
      omitted++
      line(key, `${before === null ? '⊘ A 无此项' : before.toFixed(4)} → ${after === null ? '⊘ B 无此项' : after.toFixed(4)}   ？不可比（该项在某一侧未记录）`)
      continue
    }
    const worse = dir === 'up' ? after < before - eps : after > before + eps
    const better = dir === 'up' ? after > before + eps : after < before - eps
    if (worse) regressed++
    if (better) improved++
    const verdict = worse ? '✗ 变差' : better ? '✓ 变好' : '＝ 持平'
    // 口径不同时不给「退化」字眼，只给方向描述。
    const label = sameProfile ? verdict : verdict.replace('✗ 变差', '✗ 方向变差').replace('✓ 变好', '✓ 方向变好')
    line(`${key}（${dir === 'up' ? '越高越好' : '越低越好'}）`, `${before.toFixed(4)} → ${after.toFixed(4)} ${label}`)
  }
  console.log('')
  line('汇总', `变好 ${improved} 项 / 变差 ${regressed} 项 / 两侧缺项 ${omitted} 项`)
  console.log('      退出码不因「变差」而失败：--diff 是考古工具，门禁请用 --baseline。')
  return 0
}

// ─────────────────────────── 入口 ───────────────────────────

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  console.error(`\n评测无法开始：${err?.message ?? err}`)
  process.exitCode = 1
}
