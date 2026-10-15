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
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { tokenize } from '../lib/memory/bm25.js'
import { parseBaseline, parseFrontmatter } from '../lib/memory/frontmatter.js'
import { DEFAULT_LIMIT, MAX_LIMIT, PER_FILE_CHUNKS, retrieve } from '../lib/memory/search.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DEFAULT_CORPUS = join(ROOT, 'test', 'eval', 'corpus')
const DEFAULT_QUESTIONS = join(ROOT, 'test', 'eval', 'questions.jsonl')

/** `note` 里带这个记号 = 已知的词法失败边界：语义上有答案，但 query 与原文没有词面重合。 */
const LEXFAIL = '[lexfail]'

const USAGE = `sage-mem 检索评测（离线：不联网、不调模型）

  node scripts/eval-retrieval.mjs [选项]

选项：
  --mode <summary|body|all|mixed>  检索面（默认 all；mixed = 每题按自己的 scope 跑）
  --limit <N>                      每次返回条数，收敛到 [1,${MAX_LIMIT}]（默认 ${DEFAULT_LIMIT}）
  --per-file <N>                   每文件最多贡献几条（默认 ${PER_FILE_CHUNKS}）
  --json <path>                    把完整结果（含逐题明细）写成 JSON
  --baseline <path>                与一份旧的 --json 产物对比，出现退化时退出码 1
  --allow-baseline-skip            允许「显式给了 --baseline 但比较没完成」时放行（默认不允许）
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
    baseline: '',
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
    else if (key === '--baseline') opts.baseline = take()
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
  const sharedTokenPairs = new Set()
  const sharedTokenSamples = []

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
    sharedTokenPairs,
    sharedTokenSamples,
    blacklistChecks,
    noSharedTokenChecks,
    noSharedTokenQuestions,
  }
}

// ─────────────────────────── 逐题求值 ───────────────────────────

function evaluateQuestion(q, scope, corpus, limit, perFile, sharedTokenPairs) {
  const started = performance.now()
  let result = null
  let error = ''
  try {
    result = retrieve({ query: q.query, files: corpus, scope, limit, perFile })
  } catch (err) {
    error = err?.message ?? String(err)
  }
  const ms = performance.now() - started

  const hits = result && Array.isArray(result.hits) ? result.hits.map(h => ({
    file: String(h.file),
    lines: Array.isArray(h.lines) ? h.lines : null,
    score: Number(h.score),
    matchedBy: Array.isArray(h.matchedBy) ? h.matchedBy : [],
    excerptBytes: String(h.excerpt ?? '').length,
  })) : []
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

  const blacklistHit = q.mustNotInject.filter(f => firstAt.has(f))
  // 共享词元只说明「这条命中不需要任何语义解释」，**不说明标注错了**：
  // 通用词碎片（时间 / 一次 / 器的）与跨词假词元都会命中，而真正的难负例
  // （同名不同项目、同实体不同时间、已失效内容）同样常常共享词元。
  // 所以这组计数只当诊断切片，主指标仍是全部检查项上的误注入。
  const blacklistSharedTokenEntries = q.mustNotInject.filter(f => sharedTokenPairs.has(`${q.id}\u0000${f}`))
  const blacklistHitSharedToken = blacklistHit.filter(f => sharedTokenPairs.has(`${q.id}\u0000${f}`))
  const whitelistHit = q.allowFiles.length ? hits.map(h => h.file).filter(f => !q.allowFiles.includes(f)) : []

  // 同一文件在同一次结果里重复出现 = 候选位被同一份证据重复占用。
  const seen = new Set()
  let dupExtra = 0
  let dupExtraBytes = 0
  for (const h of hits) {
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
    needed,
    foundCount,
    allFound,
    bestRank,
    blacklistHit,
    blacklistHitSharedToken,
    blacklistNoSharedTokenCount: q.mustNotInject.length - blacklistSharedTokenEntries.length,
    blacklistNoSharedTokenViolations: blacklistHit.filter(f => !sharedTokenPairs.has(`${q.id}\u0000${f}`)).length,
    whitelistHit,
    dupExtra,
    dupExtraBytes,
    coverage,
    nextCursor: result?.nextCursor ?? null,
  }
}

/** 同一题集跑一遍某个 scope —— 用于「all 是否真的比 summary 好」这条对照。 */
function runAll(questions, corpus, scope, limit, perFile, sharedTokenPairs) {
  return questions.map(q => evaluateQuestion(q, scope, corpus, limit, perFile, sharedTokenPairs))
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
    incompleteCoverageQuestions: 0,
    skippedFiles: 0,
    candidatesSum: 0,
    latencies: [],
  }
  for (const row of rows) {
    const q = row.question
    m.latencies.push(row.ms)
    m.candidatesSum += row.coverage.candidates
    m.skippedFiles += row.coverage.skipped
    if (!row.coverage.complete) m.incompleteCoverageQuestions++
    if (row.error) m.retrieveErrors++
    if (row.dupExtra > 0) {
      m.dupQuestions++
      m.dupExtra += row.dupExtra
      m.dupExtraBytes += row.dupExtraBytes
    }
    if (q.unresolved && !q.shouldInject) {
      m.unresolvedQuestions++
      if (row.hits.length) m.overInjectQuestions++
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

function rates(m) {
  const div = (n, d) => (d > 0 ? n / d : 0)
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
  line('重复文件（题数／多余条）', `${m.dupQuestions} / ${m.dupExtra}   [重复字节 ${m.dupExtraBytes}]`)
  line('无答案题仍注入', `${frac(m.overInjectQuestions, m.unresolvedQuestions)}   [只说「继续」这类题]`)
  line('平均候选数 candidates', r.candidatesAvg.toFixed(2))
  line('切分不全的题数', `${m.incompleteCoverageQuestions}   [skipped 文件合计 ${m.skippedFiles}]`)
  line('retrieve 抛错题数', String(m.retrieveErrors))
  line(`延迟 p50 / p95`, `${r.latencyP50.toFixed(3)} ms / ${r.latencyP95.toFixed(3)} ms   [最近秩法]`)
  void rows
}

// ─────────────────────────── 主流程 ───────────────────────────

function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    console.log(USAGE)
    return 0
  }
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
  line('黑名单检查项', `${audit.blacklistChecks} 项，其中无共享词元 ${audit.noSharedTokenChecks} 项，涉及题数 ${audit.noSharedTokenQuestions}`)
  line('切片排除的检查项', `${audit.blacklistChecks - audit.noSharedTokenChecks} 项（query 词元与文件重合 —— 难负例候选）`)
  for (const s of audit.sharedTokenSamples) console.log(`      ${s}`)

  const rows = questions.map(q =>
    evaluateQuestion(q, opts.mode === 'mixed' ? q.scope : opts.mode, corpus, limit, perFile, audit.sharedTokenPairs))

  console.log('\n== 逐题明细 ==')
  for (const row of rows) for (const l of detailLines(row)) console.log(l)

  const m = summarize(rows)
  const r = rates(m)
  printMetrics(`指标（mode=${opts.mode}, limit=${limit}, per-file=${perFile}）`, rows, m, r)

  // 对照：同一批题目在 summary 面下再跑一遍。这是脚本自带的「改动有没有真的扩到正文」的证据，
  // 不依赖任何历史基线，所以第一次跑就能看出问题。
  let reference = null
  if (opts.mode !== 'summary') {
    const refRows = runAll(questions, corpus, 'summary', limit, perFile, audit.sharedTokenPairs)
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

  // ── 判定 ──
  const problems = [
    ...audit.missingNeeded.map(x => `needed 文件不存在：${x}`),
    ...audit.badSpans.map(x => `span 越界：${x}`),
    ...audit.missingBlacklist.map(x => `黑名单文件不存在：${x}`),
    ...audit.missingWhitelist.map(x => `白名单文件不存在：${x}`),
    ...audit.whitelistMissingNeeded.map(x => `白名单标注不全：${x}`),
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
        blacklistChecks: audit.blacklistChecks,
        noSharedTokenChecks: audit.noSharedTokenChecks,
        noSharedTokenQuestions: audit.noSharedTokenQuestions,
        sharedTokenSamples: audit.sharedTokenSamples,
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
      },
      metrics: { raw: m, rates: r },
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
        hits: row.hits.map(h => ({ file: h.file, lines: h.lines, score: h.score, matchedBy: h.matchedBy })),
        needed: row.needed,
        blacklistHit: row.blacklistHit,
        whitelistHit: row.whitelistHit,
        dupExtra: row.dupExtra,
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

// ─────────────────────────── 入口 ───────────────────────────

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  console.error(`\n评测无法开始：${err?.message ?? err}`)
  process.exitCode = 1
}
