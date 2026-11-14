#!/usr/bin/env node
/**
 * MMR 去重的离线对照 —— 同一批语料与问题，跑若干 λ 并排比较。
 *
 * 为什么单独一个脚本而不是改 `eval-retrieval.mjs`：
 * 那个脚本判的是**检索**（`retrieve()`：摘要 + 正文 + 门槛 + 失效），它必须保持原样，
 * 否则「历史基线」与「今天的结果」就不再可比。这里判的是**选材**（注入前那一步：
 * 从已命中的候选里挑哪几条），只回答一个问题：**开启 MMR 之后，名额里装的东西变好了还是变差了。**
 *
 * 三条与 `eval-retrieval.mjs` 相同的纪律：
 *   1. **只打印百分比是不合格的** —— 每个比率都带原始分子/分母。
 *   2. **不改语料、不改问题集** —— 它们是金标，这里是量具。
 *   3. **不依赖模型与网络** —— 纯词面，随时可复现。
 *
 * 三个指标（都只看注入名额内那几条）：
 *   - `needed`：问题标注的目标文件有没有进名额（召回）。
 *   - `mustNot`：明知不该出现的文件有没有出现（误注入）。
 *   - `dup`：名额内两两摘要的 Jaccard 均值（重复度，越低越铺得开）。
 *
 * 用法：
 *   node scripts/eval-mmr.mjs                      # 默认 λ = 0/0.5/0.6/0.7/0.8/0.9
 *   node scripts/eval-mmr.mjs --lambdas 0,0.6,0.8  # 自选
 *   node scripts/eval-mmr.mjs --k 8 --json out.json
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter, parseBaseline } from '../lib/memory/frontmatter.js'
import { buildExpirySet } from '../lib/memory/validity.js'
import { bigrams } from '../lib/memory/ngram.js'
import { jaccard } from '../lib/memory/ngram.js'
import { rankSummaries, selectRelevant, summaryHay } from '../lib/memory/retrieval.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 固定评测时钟：失效判定与注入侧复用同一个纯函数，不在这里另写一套「什么时候算过期」。 */
const EVAL_NOW_MS = Date.parse('2026-11-01T00:00:00+08:00')

const DEFAULTS = {
  corpus: join(ROOT, 'test', 'eval', 'corpus'),
  questions: join(ROOT, 'test', 'eval', 'questions.jsonl'),
  k: 10,
  gate: true,
  lambdas: [0, 0.5, 0.6, 0.7, 0.8, 0.9],
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const take = () => argv[++i]
    if (key === '--corpus') opts.corpus = resolve(process.cwd(), take())
    else if (key === '--questions') opts.questions = resolve(process.cwd(), take())
    else if (key === '--k') opts.k = Number(take())
    else if (key === '--json') opts.json = resolve(process.cwd(), take())
    else if (key === '--no-gate') opts.gate = false
    else if (key === '--lambdas') opts.lambdas = String(take()).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
    else if (key === '--help' || key === '-h') {
      console.log('用法：node scripts/eval-mmr.mjs [--lambdas 0,0.7] [--k 10] [--corpus dir] [--questions path] [--json out]')
      process.exit(0)
    } else {
      throw new Error(`未知参数 ${key}（--help 看用法）`)
    }
  }
  return opts
}

/** 语料字段口径与 `eval-retrieval.mjs` 逐字一致（少了它两个脚本的判定就不可比）。 */
function loadCorpus(dir) {
  let names
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'))
  } catch (err) {
    throw new Error(`读不到语料目录 ${dir}：${err?.message ?? err}`)
  }
  names.sort()
  return names.map((name) => {
    const content = readFileSync(join(dir, name), 'utf8')
    const meta = parseFrontmatter(content)
    return {
      file: name,
      description: meta.description || '',
      aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
      baseline: parseBaseline(content),
      baselinePriority: meta.baselinePriority || 0,
      updated: meta.updated || '',
      validAt: meta.validAt || '',
      invalidAt: meta.invalidAt || '',
      supersededBy: meta.supersededBy || '',
      mtimeMs: 0,
    }
  })
}

function loadQuestions(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim()
    if (!raw || raw.startsWith('#')) continue
    try {
      out.push(JSON.parse(raw))
    } catch (err) {
      throw new Error(`questions.jsonl 第 ${i + 1} 行不是合法 JSON：${err?.message ?? err}`)
    }
  }
  return out
}

/** 名额内两两摘要的 Jaccard 均值；不足两条返回 null（没有「两两」可言）。 */
function meanPairwise(files) {
  if (files.length < 2) return null
  const sets = files.map((f) => bigrams(summaryHay(f)))
  let sum = 0
  let pairs = 0
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      sum += jaccard(sets[i], sets[j])
      pairs += 1
    }
  }
  return pairs === 0 ? null : sum / pairs
}

function run(opts) {
  const corpus = loadCorpus(opts.corpus)
  const questions = loadQuestions(opts.questions)
  const expiry = buildExpirySet(corpus, EVAL_NOW_MS)
  // 失效条目在生产里本来就不会进候选（`scanMemoryFiles` 之后还过 validity），
  // 这里显式剔掉，否则 MMR 会为一堆「已经不该出现」的条目算相似度。
  const files = corpus.filter((f) => !expiry.has(f.file))

  const rows = []
  for (const lambda of opts.lambdas) {
    let neededHit = 0
    let neededTotal = 0
    let violations = 0
    let dupSum = 0
    let dupCount = 0
    let candOver = 0
    const pickedByQuestion = new Map()
    for (const q of questions) {
      const picked = selectRelevant(q.query, files, { maxResults: opts.k, mmr: lambda, gate: opts.gate })
      if (lambda === 0) {
        // 候选数分布：护栏 2 只有「候选 > 名额」时才让 MMR 动手 —— 先看它到底有多少机会
        const cand = rankSummaries(q.query, files, { gate: opts.gate }).length
        if (cand > opts.k) candOver += 1
      }
      pickedByQuestion.set(q.id, picked.map((f) => f.file))
      const names = new Set(picked.map((f) => f.file))
      for (const need of Array.isArray(q.needed) ? q.needed : []) {
        neededTotal += 1
        if (names.has(need.file)) neededHit += 1
      }
      for (const bad of Array.isArray(q.mustNotInject) ? q.mustNotInject : []) {
        if (names.has(bad)) violations += 1
      }
      const dup = meanPairwise(picked)
      if (dup !== null) {
        dupSum += dup
        dupCount += 1
      }
    }
    rows.push({ lambda, neededHit, neededTotal, violations, dupMean: dupCount ? dupSum / dupCount : null, dupCount, candOver, pickedByQuestion })
  }

  // 「相对 λ=0 换掉了哪几条」——决定要不要开，看的其实是这一栏。
  const base = rows.find((r) => r.lambda === 0) || rows[0]
  for (const r of rows) {
    let changed = 0
    let entered = 0
    let left = 0
    for (const [id, filesNow] of r.pickedByQuestion) {
      const before = new Set(base.pickedByQuestion.get(id) || [])
      const after = new Set(filesNow)
      const inNow = filesNow.filter((f) => !before.has(f)).length
      const outNow = [...before].filter((f) => !after.has(f)).length
      if (inNow || outNow) changed += 1
      entered += inNow
      left += outNow
    }
    r.changedQuestions = changed
    r.entered = entered
    r.left = left
  }
  return { opts, questions: questions.length, files: files.length, rows }
}

function report(result) {
  const { opts, rows, questions, files } = result
  console.log(`MMR 选材对照 · 语料 ${files} 份（已剔失效） · 问题 ${questions} 道 · 名额 ${opts.k}`)
  console.log('（每项都是原始分子/分母；dup 是名额内两两摘要 Jaccard 均值，越低越铺得开）')
  const base0 = rows[0]
  console.log(`候选多于名额（MMR 真正有机会动手）的问题：${base0.candOver}/${questions} 道；证据门 ${opts.gate ? '开' : '关'}`)
  console.log('')
  const pad = (s, n) => String(s).padEnd(n)
  console.log(`${pad('λ', 6)}${pad('needed', 14)}${pad('mustNot', 12)}${pad('dup', 8)}${pad('换掉的问题', 12)}${pad('进/出', 10)}`)
  for (const r of rows) {
    const needed = `${r.neededHit}/${r.neededTotal}`
    const dup = r.dupMean === null ? '-' : r.dupMean.toFixed(3)
    const churn = `${r.changedQuestions}`
    const flow = `+${r.entered}/-${r.left}`
    console.log(`${pad(r.lambda, 6)}${pad(needed, 14)}${pad(r.violations, 12)}${pad(dup, 8)}${pad(churn, 12)}${pad(flow, 10)}`)
  }
  console.log('\n判读提示：λ=0 是基线（= 2.8.0 行为）。needed 掉了就不能接受；')
  console.log('dup 明显下降而 needed 不变，是「同样命中、额度铺得更开」——那才是开它的理由。')
}

const opts = parseArgs(process.argv.slice(2))
const result = run(opts)
report(result)
if (opts.json) {
  const slim = {
    opts: { k: opts.k, lambdas: opts.lambdas, corpus: opts.corpus, questions: opts.questions },
    files: result.files,
    rows: result.rows.map((r) => ({
      lambda: r.lambda,
      neededHit: r.neededHit,
      neededTotal: r.neededTotal,
      violations: r.violations,
      dupMean: r.dupMean,
      dupCount: r.dupCount,
      changedQuestions: r.changedQuestions,
      entered: r.entered,
      left: r.left,
    })),
  }
  writeFileSync(opts.json, JSON.stringify(slim, null, 2))
  console.log(`\nJSON → ${opts.json}`)
}
