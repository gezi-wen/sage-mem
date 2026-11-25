#!/usr/bin/env node
/**
 * session-search-test.mjs — 2.19.0「搜索覆盖度」的断言（`lib/autodream/session-search{,-policy}.js`）。
 *
 * 组织原则同 `q-fixes-095.mjs` / `autodream-reconcile-test.mjs`：钉**护栏**，不钉文案好不好看。
 *
 * 这个功能的失效形态全是**静默**的 —— 它从来不会抛错，只会悄悄少看几份、少给几段，
 * 然后用一句「没找到」把「没看见」说成「没有」。所以每一组都配一条**反向对照**：
 * 证明断言不是恒真（完整时 `complete:true`、超限时真的超限、干净文件真的算 searched）。
 *
 * 分组：
 *   1. 纯策略 · 文件桶不变量 I1（随机 + 边界）
 *   2. 纯策略 · complete 派生（两条轴：complete 与 truncated 不许混算）
 *   3. 纯策略 · 目录上限的选择与计数（40 不再是静默的）
 *   4. 纯策略 · 命中窗口与字符预算（含 498 / 499 字关键词的省略号边界）
 *   5. 纯策略 · 文件名分类（v4 认得 / v3 与无版本只报告 / .bak 与临时件不算）
 *   6. 渲染 · 零命中的两种说法 + 根不可用时不许听起来像「没有」
 *   7. 纯策略 · 枚举失败与 zstd 缺失的账
 *  7b. 枚举边界 · 重复 v4 / 符号链接 / 链接目标非普通文件（fake IO，不依赖平台权限）
 *   8. 真 IO（**需要 Node 22.15+**，否则整段 SKIP）：部分解码 / 坏邻居（8）/ 目录上限（8b）/
 *      输出上限与「完整但被裁」（8c）/ 根状态与旧格式（8d）/ 混装与 zstd 缺失（8e）
 *   9. 工具面接线（withSessions 开关、字符串契约、旧 token 兼容）
 *  10. prompt · 覆盖不完整的零命中不能当反证
 *
 * ⚠️ 第 8 组整段依赖 `zlib.zstdCompressSync`（Node 22.15+）造夹具，所以在 Node 18 / 20 上 SKIP。
 * **公开保证（契约 3.11 / 发现账 R20）绑的断言一律来自第 1–7b、9、10 组**，
 * 那些在任何受支持的 Node 上都会跑 —— 否则 CI 的 18.x / 20.x 矩阵上守卫会红。
 *
 * ⚠️ `zlib.zstdCompressSync` 是 Node 22.15+ 才有的 API；`engines.node` 声明 `>=18`，
 * 所以**依赖它造夹具的第 8、9 组**在 Node < 22.15 上 SKIP，而纯策略与接线各照跑
 * （运行时在那种 Node 上会明确说「读不了」，见第 7 组）。
 */
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

import {
  CHAR_BUDGET,
  DEFAULT_HIT_LIMIT,
  HIT_CHARS,
  SEARCH_DIR_CAP,
  centeredExcerpt,
  classifyCoverage,
  classifySessionFileName,
  formatCoverageLine,
  formatMissLine,
  matchLines,
  pickSessionsByMtime,
  renderSearchReport,
} from '../lib/autodream/session-search-policy.js'
import {
  SESSION_SEARCH_CAPS,
  enumerateSessions,
  runSessionSearch,
  searchSessions,
} from '../lib/autodream/session-search.js'
import { autodreamToolSchemas, createToolRunner } from '../lib/autodream/tools.js'
import { buildAutodreamUserPrompt } from '../lib/autodream/prompt.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`)
  }
}
const skip = (name, why) => console.log(`  SKIP ${name}（${why}）`)
const group = (t) => console.log(`== ${t} ==`)

/** cordis Service 构造会取 ctx.reflect.*，未知成员得给可调用且能继续取属性的桩。 */
function makeCtx() {
  const logger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }
  const base = { on: () => {}, get: () => undefined, logger, effect: () => {} }
  let stub
  stub = new Proxy(function () {}, {
    get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined),
    apply: () => undefined,
  })
  return new Proxy(base, { get: (t, p) => (p in t ? t[p] : stub) })
}

const zstdCompressSync = zlib.zstdCompressSync
const multiFrame = (lines) => Buffer.concat(lines.map((l) => zstdCompressSync(Buffer.from(`${l}\n`, 'utf8'))))

async function world(tag) {
  const root = await mkdtemp(join(tmpdir(), `smem-ss-${tag}-`))
  const memoryDir = join(root, 'memory')
  const sessionsRoot = join(root, 'sessions')
  await mkdir(memoryDir, { recursive: true })
  await mkdir(sessionsRoot, { recursive: true })
  return { root, memoryDir, sessionsRoot }
}

/** 造一个会话目录 + 一份「逐行一个帧」的正文。 */
async function makeSession(sessionsRoot, project, name, lines, mtimeSec) {
  const dir = join(sessionsRoot, project, name)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(file, multiFrame(lines))
  if (Number.isFinite(mtimeSec)) {
    const at = new Date(mtimeSec * 1000)
    await utimes(file, at, at)
  }
  return file
}

// ────────────────────────── 1. 文件桶不变量 ──────────────────────────
group('1. I1：searched + partial + failed + skippedByCap + skippedByOutput === available')
{
  // 边界组合（手写，覆盖四种桶各自为 0 / 非 0 的角落）
  const cases = [
    { available: 0, outcomes: [] },
    { available: 1, outcomes: ['searched'] },
    { available: 1, outcomes: ['failed'] },
    { available: 1, outcomes: ['partial'] },
    { available: 3, outcomes: ['searched', 'partial', 'failed'] },
    { available: 5, outcomes: ['searched', 'searched'], skippedByOutput: 2 }, // 3 进队 2 没开始 → 2 因上限没看
    { available: 2, outcomes: ['failed'], skippedByOutput: 1 },
    { available: 0, outcomes: [], skippedByOutput: 0 },
  ]
  let bad = ''
  for (const c of cases) {
    const cov = classifyCoverage(c)
    const sum = cov.searched + cov.partial + cov.failed + cov.skippedByCap + cov.skippedByOutput
    if (sum !== cov.available) {
      bad = `${JSON.stringify(c)} → 和 ${sum} ≠ available ${cov.available}`
      break
    }
  }
  ok(bad === '', '8 组边界组合：五个桶之和恒等于 available', bad)

  // 随机组合：桶不许重叠、不许漏
  let randomBad = ''
  for (let i = 0; i < 200; i++) {
    const searched = Math.floor(Math.random() * 5)
    const partial = Math.floor(Math.random() * 4)
    const failed = Math.floor(Math.random() * 3)
    const skippedByOutput = Math.floor(Math.random() * 3)
    const outcomes = [
      ...Array(searched).fill('searched'),
      ...Array(partial).fill('partial'),
      ...Array(failed).fill('failed'),
    ]
    const available = searched + partial + failed + skippedByOutput + Math.floor(Math.random() * 10)
    const cov = classifyCoverage({ available, outcomes, skippedByOutput })
    const sum = cov.searched + cov.partial + cov.failed + cov.skippedByCap + cov.skippedByOutput
    if (sum !== available || cov.searched !== searched || cov.partial !== partial || cov.failed !== failed) {
      randomBad = `available=${available} outcomes=${outcomes.length} sum=${sum} cov=${JSON.stringify(cov)}`
      break
    }
  }
  ok(randomBad === '', '200 组随机：桶互斥、不重复计数、和等于 available', randomBad)

  // partial 不许同时被算进 searched（旧实现里「解了一半」就等于「完整」，这是账算不清的根）
  const mixed = classifyCoverage({ available: 2, outcomes: ['partial', 'searched'] })
  ok(mixed.partial === 1 && mixed.searched === 1, 'partial 与 searched 各自独立计数（不叠算）', JSON.stringify(mixed))
}

// ────────────────────────── 2. complete 派生：两条轴不混算 ──────────────────────────
group('2. complete 只表达「输入覆盖完整」，truncated 只表达「输出被截」')
{
  const base = { root: 'ok' }
  const clean = classifyCoverage({ ...base, available: 3, outcomes: ['searched', 'searched', 'searched'] })
  ok(clean.complete === true, '【反向对照】全部完整解码 → complete=true（不是恒 false）', JSON.stringify(clean))
  ok(clean.truncated === false, '什么都没截 → truncated=false', JSON.stringify(clean))

  // 契约：两条轴可以同时为真 —— 全部会话都读了，但片段被窗口裁短
  const allReadButClipped = classifyCoverage({
    ...base,
    available: 1,
    outcomes: ['searched'],
    clipped: true,
  })
  ok(allReadButClipped.complete === true && allReadButClipped.truncated === true,
    'complete=true 且 truncated=true 合法（看全了输入，但输出被裁）',
    JSON.stringify(allReadButClipped))

  const noneReadButNotTruncated = classifyCoverage({ ...base, available: 100, outcomes: [] })
  ok(noneReadButNotTruncated.complete === false && noneReadButNotTruncated.truncated === false,
    '**complete=false 且 truncated=false 合法**（只看了 0 个，但一条没命中所以没东西可截）',
    JSON.stringify(noneReadButNotTruncated))

  // 五个分量各自独立地能把 complete 打成 false
  const knock = [
    ['skippedByCap', { ...base, available: 100, outcomes: [] }],
    ['skippedByOutput', { ...base, available: 2, outcomes: ['searched'], skippedByOutput: 1 }],
    ['failed', { ...base, available: 1, outcomes: ['failed'] }],
    ['partial', { ...base, available: 1, outcomes: ['partial'] }],
    ['unrecognized', { ...base, available: 0, outcomes: [], unrecognized: 3 }],
    ['enumerationFailed', { ...base, available: 1, outcomes: ['searched'], enumerationFailed: 1 }],
    ['zstdUnsupported', { ...base, available: 0, outcomes: [], zstdUnsupported: true }],
    ['root missing', { root: 'missing', available: 0, outcomes: [] }],
    ['root unset', { root: 'unset', available: 0, outcomes: [] }],
    ['root notdir', { root: 'notdir', available: 0, outcomes: [] }],
  ]
  let bad = ''
  for (const [label, input] of knock) {
    const cov = classifyCoverage(input)
    if (cov.complete !== false) {
      bad = `${label} → complete=${cov.complete}`
      break
    }
  }
  ok(bad === '', '10 种「某个分量非零」各自都能把 complete 打成 false', bad)

  // 空但可读的目录 = 合法空库，complete 仍为 true
  const empty = classifyCoverage({ ...base, available: 0, outcomes: [] })
  ok(empty.complete === true, '空目录也可 complete=true（「什么都没扫到」不等于「扫不上」）', JSON.stringify(empty))
}

// ────────────────────────── 3. 目录上限：40 不再静默 ──────────────────────────
group('3. 目录上限的选择与计数')
{
  const mk = (n, step = 1000) =>
    Array.from({ length: n }, (_, i) => ({ file: `s${i}.zst`, mtimeMs: step * i }))

  const hundred = pickSessionsByMtime(mk(100))
  ok(hundred.considered.length === SEARCH_DIR_CAP && hundred.skippedByCap === 100 - SEARCH_DIR_CAP,
    `100 个 → 进队 ${SEARCH_DIR_CAP}、因上限没看 ${100 - SEARCH_DIR_CAP}`,
    JSON.stringify({ c: hundred.considered.length, s: hundred.skippedByCap }))
  ok(hundred.considered[0].file === 's99.zst', '进队的是**最新**的那些（mtime 由新到旧）', hundred.considered[0].file)

  const few = pickSessionsByMtime(mk(3))
  ok(few.considered.length === 3 && few.skippedByCap === 0, '3 个 → 全进队、一份没漏', JSON.stringify(few.skippedByCap))

  const none = pickSessionsByMtime([])
  ok(none.considered.length === 0 && none.skippedByCap === 0 && none.available === 0, '空名单 → 0/0/0')

  const filtered = pickSessionsByMtime(mk(5), { sinceMs: 2000 })
  ok(filtered.available === 3 && filtered.considered.length === 3,
    'sinceMs 过滤之后 available 跟着变小（分母与「因上限没看」同源，不会把时间滤掉的算成上限漏看）',
    JSON.stringify(filtered))

  ok(SEARCH_DIR_CAP === 40, '上限仍是 40（本版刻意不扩大：要扩先做逐帧早停）', String(SEARCH_DIR_CAP))
  ok(SESSION_SEARCH_CAPS.dirCap === 40 && SESSION_SEARCH_CAPS.charBudget === 8000,
    '运行时与策略层共用同一组常量（没有第二份 40 / 8000）',
    JSON.stringify(SESSION_SEARCH_CAPS))
}

// ────────────────────────── 4. 命中窗口与字符预算 ──────────────────────────
group('4. 片段以关键词为中心；预算按实际吐出的字算')
{
  // 旧实现从行首硬切 500 字：关键词在 501 字之后就等于「返回了一段看不见关键词的片段」
  const far = 'a'.repeat(600) + ' NEEDLE ' + 'b'.repeat(600)
  const one = matchLines(far, 'NEEDLE', { limit: 5, charBudget: CHAR_BUDGET })
  ok(one.hits.length === 1, '关键词在 600 字之后仍然命中', JSON.stringify(one.hits.length))
  ok(one.hits.length === 1 && one.hits[0].hasMatch === true,
    '【核心】片段里**真的看得到**关键词（旧实现此处 hasMatch 为 false）',
    one.hits.length ? JSON.stringify(one.hits[0].excerpt.slice(0, 80)) : 'no hit')
  ok(one.hits.length === 1 && one.hits[0].excerpt.includes('NEEDLE'), '片段文本包含关键词本身')
  ok(one.hits.length === 1 && one.hits[0].chars <= HIT_CHARS, `片段不超过 ${HIT_CHARS} 字`, String(one.hits[0]?.chars))

  const cut = centeredExcerpt(far, far.indexOf('NEEDLE'), 6, HIT_CHARS)
  ok(cut.text.length <= HIT_CHARS && cut.clipped === true, `窗口硬上限 ${HIT_CHARS}（含省略号也不超）`, String(cut.text.length))
  ok(cut.text.startsWith('…') && cut.text.endsWith('…'), '两侧都被裁时两头都有省略号', cut.text.slice(0, 3))

  // 一行 20 KB、三条命中行：旧实现按「整行长度」记账，第一条就把 8000 花光、只吐 500 字
  const big = 'x'.repeat(10000) + ' NEEDLE ' + 'y'.repeat(9000)
  const threeBig = [big, big, big].join('\n')
  const bigScan = matchLines(threeBig, 'NEEDLE', { limit: DEFAULT_HIT_LIMIT, charBudget: CHAR_BUDGET })
  ok(bigScan.hits.length === 3,
    '【核心】三条 20 KB 命中行 → 3 段（旧实现第一条就耗尽预算、只回 1 段）',
    JSON.stringify({ hits: bigScan.hits.length, stopped: bigScan.stoppedBy }))
  ok(bigScan.hitChars <= CHAR_BUDGET, `hitChars ≤ ${CHAR_BUDGET}`, String(bigScan.hitChars))
  ok(bigScan.hitChars === bigScan.hits.reduce((a, h) => a + h.chars, 0), 'hitChars 等于各段实际字数之和')

  // 预算真的会停：200 字一段 + 600 预算 → 恰好 3 段（第 4 段 800 > 600，先判后加）
  const budgetLines = Array.from({ length: 5 }, (_, i) => `${i} `.padEnd(195, 'z') + ' NEEDLE')
  const bounded = matchLines(budgetLines.join('\n'), 'NEEDLE', { limit: 20, charBudget: 600 })
  ok(bounded.stoppedBy === 'chars' && bounded.hitChars <= 600,
    '预算 600 → 停在字符预算上，且 hitChars 不越界',
    JSON.stringify({ stopped: bounded.stoppedBy, chars: bounded.hitChars, hits: bounded.hits.length }))
  ok(bounded.hits.every((h) => h.chars <= 600), '每一段都在预算之内（预算按段累计，不是按整行）')

  // limit 判据是「到顶就停」，不是「超了才停」（q-fixes-095 的老断言从这里来）
  const limited = matchLines(Array.from({ length: 4 }, () => 'NEEDLE-LINE').join('\n'), 'NEEDLE', { limit: 1 })
  ok(limited.hits.length === 1 && limited.stoppedBy === 'limit', 'limit=1 → 恰好 1 段、stoppedBy=limit',
    JSON.stringify({ hits: limited.hits.length, stopped: limited.stoppedBy }))
  ok(limited.stoppedEarly === true, '停在文件中间 → stoppedEarly=true（这一份要记 partial，不能算 searched）')

  // 停在**最后一行**不算没读完（否则每个文件都会假报 partial，complete 永远 false）
  const atEnd = matchLines('NEEDLE-LINE\nNEEDLE-LINE', 'NEEDLE', { limit: 2 })
  ok(atEnd.hits.length === 2 && atEnd.stoppedBy === 'limit' && atEnd.stoppedEarly === false,
    'limit 恰好停在末行 → stoppedEarly=false（读完了，complete 可以仍为 true）',
    JSON.stringify({ stoppedEarly: atEnd.stoppedEarly, hits: atEnd.hits.length }))

  // 大小写：原样命中优先，退回小写匹配
  const ci = matchLines('这里写着 SESSION_ID 之类的词', 'session_id')
  ok(ci.hits.length === 1 && ci.hits[0].hasMatch === true, '大小写不同也能命中且片段看得见关键词', JSON.stringify(ci.hits[0]?.hasMatch))

  // 太短的行跳过（旧行为，别回归）
  const shortLine = matchLines('NEEDLE-LONG-ENOUGH\nok', 'NEEDLE')
  ok(shortLine.hits.length === 1, '短行（< 8 字）不参与匹配，够长的照常命中', JSON.stringify(shortLine.hits.length))

  // 关键词几乎顶满窗口：省略号不许吃掉关键词的第一个字（498 / 499 两个边界）
  for (const n of [498, 499]) {
    const longNeedle = 'Q'.repeat(n)
    const line = `${'z'.repeat(200)}${longNeedle}${'y'.repeat(200)}`
    const got = matchLines(line, longNeedle, { limit: 5, charBudget: CHAR_BUDGET })
    const hit = got.hits[0]
    ok(hit && hit.hasMatch === true && hit.excerpt.includes(longNeedle) && hit.chars <= HIT_CHARS,
      `关键词 ${n} 字、窗口 500：片段里仍完整包含它（左侧省略号不许切到关键词）`,
      hit ? JSON.stringify({ chars: hit.chars, has: hit.hasMatch, head: hit.excerpt.slice(0, 3) }) : 'no hit')
  }
}

// ────────────────────────── 5. 文件名分类 ──────────────────────────
group('5. 只认 v4；v3 / 无版本只报告；.bak 与临时件不算')
{
  ok(classifySessionFileName('session.v4.jsonl.zstd') === 'v4', 'v4 认得')
  ok(classifySessionFileName('session.v3.jsonl.zstd') === 'unrecognized', 'v3 → unrecognized（只报告不读）')
  ok(classifySessionFileName('session.jsonl.zstd') === 'unrecognized', '无版本 → unrecognized')
  ok(classifySessionFileName('session.v5.jsonl.zstd') === 'unrecognized', '将来别的代际 → unrecognized（不会静默当成 v4）')
  ok(classifySessionFileName('session.jsonl.zstd.bak-20260822') === 'ignore', '.bak 备份件不算（既不认得也不叫旧格式）')
  ok(classifySessionFileName('session.v4.jsonl.zstd.bak') === 'ignore', 'v4 的 .bak 也不算')
  ok(classifySessionFileName('session.v4.jsonl.zstd.tmp') === 'ignore', '临时件不算')
  ok(classifySessionFileName('session.v4.jsonl.zstd~') === 'ignore', '编辑器备份（尾 ~）不算')
  ok(classifySessionFileName('.hidden') === 'ignore' && classifySessionFileName('notes.md') === 'ignore',
    '点文件与无关文件都不算')
}

// ────────────────────────── 6. 渲染：零命中的两种说法 ──────────────────────────
group('6. 零命中必须分清「看完了没有」；根不可用时不许像「没有」')
{
  const complete = classifyCoverage({ root: 'ok', available: 7, outcomes: Array(7).fill('searched') })
  const partial = classifyCoverage({ root: 'ok', available: 10, outcomes: ['searched'], unrecognized: 3 })
  const missComplete = formatMissLine('NEEDLE', complete)
  const missPartial = formatMissLine('NEEDLE', partial)
  ok(missComplete !== missPartial, '完整零命中与不完整零命中**不是同一句话**', `${missComplete} / ${missPartial}`)
  ok(missComplete.includes('没找到') && missComplete.includes('完整'), '完整零命中：说「完整搜索了全部 N 个」', missComplete)
  ok(!missPartial.includes('完整搜索了全部'), '不完整零命中：不许说「完整搜索了全部」', missPartial)
  ok(missPartial.includes('这不等于会话里没有'), '不完整零命中：明确限定范围', missPartial)
  ok(missPartial.includes('旧格式'), '不完整零命中：把「旧格式没读」也说出来', missPartial)

  // 范围的分母：只算真正读到内容的（searched + partial），
  // 不许把「因预算没开始」与「读不动」算成「看得到」
  const withGaps = classifyCoverage({
    root: 'ok',
    available: 10,
    outcomes: ['searched', 'searched', 'partial', 'failed'],
    skippedByOutput: 4,
  })
  const gapsText = formatMissLine('NEEDLE', withGaps)
  ok(gapsText.includes('真正读到的 3 个'),
    '零命中的分母是 searched+partial（3），不是 considered（8）', gapsText)
  ok(gapsText.includes('4 个因输出预算没开始') && gapsText.includes('1 个读不动'),
    '没开始 / 读不动的单列成「另有…」，不混进「看得到」', gapsText)

  // 覆盖行的措辞：这是**搜索覆盖**的账，不是解压状态的账
  const covLine = formatCoverageLine(complete)
  ok(covLine.includes('完整搜索 7') && !covLine.includes('完整解码'),
    '覆盖行说「完整搜索」，不说「完整解码」', covLine)

  // 根不可用：一句话都不许听起来像「搜过了但没命中」
  const roots = [
    ['unset', classifyCoverage({ root: 'unset' })],
    ['missing', classifyCoverage({ root: 'missing' })],
    ['notdir', classifyCoverage({ root: 'notdir' })],
    ['denied', classifyCoverage({ root: 'denied' })],
    ['error', classifyCoverage({ root: 'error', rootMessage: 'boom' })],
    ['zstd', classifyCoverage({ root: 'ok', zstdUnsupported: true })],
  ]
  let bad = ''
  for (const [label, cov] of roots) {
    const text = renderSearchReport({ rawQuery: 'NEEDLE', hits: [], coverage: cov })
    if (!text.includes('无法搜索')) {
      bad = `${label} → ${text.slice(0, 60)}`
      break
    }
    if (text.includes('没找到')) {
      bad = `${label} 竟说了「没找到」→ ${text.slice(0, 60)}`
      break
    }
  }
  ok(bad === '', '6 种「根/解压不可用」都只说「无法搜索」，一句「没找到」都没有', bad)
  const zstdCov = classifyCoverage({ root: 'ok', zstdUnsupported: true })
  ok(renderSearchReport({ coverage: zstdCov }).includes('不代表'),
    'zstd 缺失时明说「不代表会话里有没有相关内容」')

  // 首行必须是覆盖：命中埋到覆盖率上面就等于没报
  const covOk = classifyCoverage({ root: 'ok', available: 2, outcomes: ['searched', 'searched'], hitCount: 1, hitChars: 120 })
  const text = renderSearchReport({
    rawQuery: 'NEEDLE',
    hits: [{ stamp: '2026-11-25 12:00', excerpt: '…NEEDLE…' }],
    coverage: covOk,
  })
  const lines = text.split('\n')
  ok(lines[0].startsWith('覆盖完整') || lines[0].startsWith('覆盖不完整'), '首行是覆盖率', lines[0])
  ok(text.indexOf('覆盖完整') < text.indexOf('命中 1 段'), '覆盖率在命中之前（不是文末附注）')
  ok(/命中 1 段/.test(text), '保留旧 token「命中 N 段」（q-fixes-095 的 isHit 依赖它）', text.slice(0, 80))
  ok(lines.some((l) => l.startsWith('[')), '命中行仍以 [时间戳] 开头（旧套件按这个数段数）')

  // 不完整的命中也要挂一句范围说明
  const covPartial = classifyCoverage({ root: 'ok', available: 100, outcomes: ['searched'], hitCount: 1, hitChars: 120 })
  const ptext = renderSearchReport({ rawQuery: 'NEEDLE', hits: [{ stamp: 's', excerpt: 'e' }], coverage: covPartial })
  ok(ptext.includes('不代表全部会话'), '不完整但**有命中**时也要说明「只代表看得到的这些」')
  ok(renderSearchReport({ rawQuery: 'q', hits: [{ stamp: 's', excerpt: 'e' }], coverage: covOk }).includes('不代表全部会话') === false,
    '【反向对照】完整时不加那句（不是无条件贴标签）')
}

// ────────────────────────── 7. 枚举失败与 zstd 缺失的账 ──────────────────────────
group('7. 枚举失败 / zstd 缺失在账上各有位置')
{
  const en = classifyCoverage({ root: 'ok', available: 0, outcomes: [], enumerationFailed: 2 })
  ok(en.enumerationFailed === 2 && en.complete === false, '枚举失败 2 次 → 记账且 complete=false', JSON.stringify(en))
  const line = renderSearchReport({ coverage: classifyCoverage({ root: 'ok', available: 1, outcomes: ['searched'], enumerationFailed: 1 }) })
  ok(line.includes('枚举失败'), '覆盖行里点名「枚举失败」', line.split('\n')[0])

  const zs = classifyCoverage({ root: 'ok', zstdUnsupported: true })
  ok(zs.zstdUnsupported === true && zs.complete === false,
    'zstd 不可用 → complete=false（单看这一条判据：解压缺失就够了）', JSON.stringify(zs))

  /**
   * 真代码路径上的「解压不可用」也要在**任何 Node** 上能验（夹具不用压缩，所以不依赖
   * `zstdCompressSync`）：注入 `zlib: null` + fake IO，账要真实、话不许像「没有」。
   */
  const io = {
    readdir: (p) => {
      const s = String(p)
      if (s === '/sessions') return Promise.resolve([{ name: 'proj', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }])
      if (s.endsWith('proj')) return Promise.resolve([{ name: 'sess', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }])
      return Promise.resolve([{ name: 'session.v4.jsonl.zstd', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }])
    },
    stat: async () => ({ isFile: () => true, isDirectory: () => false, mtimeMs: 1 }),
    readFile: async () => Buffer.alloc(0),
  }
  const noZstd = await runSessionSearch('/sessions', 'NEEDLE', { zlib: null, io })
  ok(noZstd.coverage.zstdUnsupported === true && noZstd.coverage.available === 1 && noZstd.coverage.failed === 1,
    '注入 zlib=null：available=1、进队那份记 failed（不抹成 0、也不记 skippedByOutput）',
    JSON.stringify({ a: noZstd.coverage.available, f: noZstd.coverage.failed, s: noZstd.coverage.skippedByOutput }))
  ok(noZstd.text.includes('无法搜索') && !noZstd.text.includes('没找到'),
    '解压不可用时只说「无法搜索」，一句「没找到」都没有', noZstd.text)
}

// ────────────────────────── 7b. 枚举边界（fake IO） ──────────────────────────
group('7b. 枚举边界：重复 v4 / 符号链接 / 链接目标不是普通文件（fake IO，不依赖平台权限）')
{
  const dirent = (name, kind) => ({
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'link',
  })
  const statOf = (mtimeMs = 1000) => async () => ({ isFile: () => true, isDirectory: () => false, mtimeMs })
  /** root → 一个 project → 一个 session 目录；最后一层回放给定的文件项。 */
  const tree = (files) => (p) => {
    const s = String(p)
    if (s === '/sessions') return Promise.resolve([dirent('proj', 'dir')])
    if (s.endsWith('proj')) return Promise.resolve([dirent('sess', 'dir')])
    return Promise.resolve(files)
  }

  // (a) 同一目录两份 v4（大小写不同，只有大小写敏感的文件系统上会出现）：只取一份，另一份记账
  const dup = await enumerateSessions('/sessions', {
    readdir: tree([dirent('session.v4.jsonl.zstd', 'file'), dirent('SESSION.V4.JSONL.ZSTD', 'file')]),
    stat: statOf(),
  })
  ok(dup.files.length === 1, '同目录两份 v4：只取第一份', JSON.stringify(dup.files.length))
  ok(dup.enumerationFailed === 1, '第二份 v4 记成 enumerationFailed（不是静默挑一个就算了）',
    JSON.stringify(dup.enumerationFailed))

  // (b) 符号链接：`isFile()` 为假，但 stat 指向普通文件 —— 必须照常收进来
  const link = await enumerateSessions('/sessions', {
    readdir: tree([dirent('session.v4.jsonl.zstd', 'link')]),
    stat: statOf(2000),
  })
  ok(link.files.length === 1 && link.files[0].mtimeMs === 2000,
    '符号链接：由 stat 确认目标是普通文件后照常收进名单（旧实现按 isFile 直接跳过）',
    JSON.stringify(link.files))

  // (c) 链接指向目录 / 设备：读不了就记账，别变成「零命中」
  const badTarget = await enumerateSessions('/sessions', {
    readdir: tree([dirent('session.v4.jsonl.zstd', 'link')]),
    stat: async () => ({ isFile: () => false, isDirectory: () => true, mtimeMs: 1 }),
  })
  ok(badTarget.files.length === 0 && badTarget.enumerationFailed === 1,
    '链接目标不是普通文件 → enumerationFailed=1（不是静默当成没有）', JSON.stringify(badTarget))

  // (d) stat 抛错（目标在枚举与读取之间消失）：同样记账
  const gone = await enumerateSessions('/sessions', {
    readdir: tree([dirent('session.v4.jsonl.zstd', 'file')]),
    stat: async () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    },
  })
  ok(gone.files.length === 0 && gone.enumerationFailed === 1, 'stat 失败（目标消失）→ enumerationFailed=1',
    JSON.stringify(gone.enumerationFailed))
}

// ────────────────────────── 8. 真 IO：部分解码 / 坏邻居 / 上限 ──────────────────────────
if (typeof zstdCompressSync !== 'function') {
  skip('第 8、9 组（真会话夹具）', `当前 Node ${process.version} 没有 zlib.zstdCompressSync（Node < 22.15）`)
} else {
  group('8. 真会话：部分解码被记成 partial 而不是 searched')
  {
    const { sessionsRoot } = await world('partial')

    // 好帧 + 被截断的第二帧：旧解码器只会说「文本不为空」→ 被当成「整份读过了」
    const dir = join(sessionsRoot, 'proj-a', 'sess-truncated')
    await mkdir(dir, { recursive: true })
    const whole = multiFrame(['{"text":"第一帧好着呢 NEEDLE-IN-FIRST"}', '{"text":"第二帧被截断"}'])
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), whole.subarray(0, whole.length - 6))

    const r = await runSessionSearch(sessionsRoot, 'NEEDLE-IN-FIRST')
    ok(r.coverage.partial === 1 && r.coverage.searched === 0 && r.coverage.failed === 0,
      '帧被截断 → partial=1（不是 searched=1）', JSON.stringify(r.coverage))
    ok(r.coverage.complete === false, '部分解码 → complete=false（覆盖不完整）')
    ok(r.hits.length === 1, '好帧里的关键词照常命中（部分解码不等于整份作废）', JSON.stringify(r.hits.length))

    // 帧之间夹垃圾：重同步救回后面的帧，但这一份仍是「只读到一部分」
    const dir2 = join(sessionsRoot, 'proj-a', 'sess-junk')
    await mkdir(dir2, { recursive: true })
    const f1 = zstdCompressSync(Buffer.from('{"text":"第一帧"}\n', 'utf8'))
    const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
    const f3 = zstdCompressSync(Buffer.from('{"text":"垃圾之后有 AFTER-JUNK-NEEDLE"}\n', 'utf8'))
    await writeFile(join(dir2, 'session.v4.jsonl.zstd'), Buffer.concat([f1, junk, f3]))
    const r2 = await runSessionSearch(sessionsRoot, 'AFTER-JUNK-NEEDLE')
    ok(r2.hits.length === 1, '帧间垃圾之后的好帧仍被搜到（旧实现直接停在那里）', JSON.stringify(r2.hits.length))
    ok(r2.coverage.partial === 2, '两份 partial 都记上了（截断那份 + 重同步那份）', JSON.stringify(r2.coverage.partial))

    // 一个字节都解不出来 → failed，而且不许拖死邻居
    const dir3 = join(sessionsRoot, 'proj-b', 'sess-broken')
    await mkdir(dir3, { recursive: true })
    await writeFile(join(dir3, 'session.v4.jsonl.zstd'), Buffer.from('这不是 zstd 帧，一个魔数都没有'))
    await makeSession(sessionsRoot, 'proj-b', 'sess-good', ['{"text":"好文件里有 GOOD-NEEDLE"}'])
    const r3 = await runSessionSearch(sessionsRoot, 'GOOD-NEEDLE')
    ok(r3.hits.length === 1, '坏文件不拖死邻居', JSON.stringify(r3.hits.length))
    ok(r3.coverage.failed === 1, '坏文件记 failed=1（不是静默跳过）', JSON.stringify(r3.coverage.failed))
    ok(r3.coverage.complete === false, '有 failed → complete=false')
  }

  group('8b. 目录上限：漏看的份数必须进账，且零命中要说清范围')
  {
    const { sessionsRoot } = await world('cap')
    const baseSec = Math.floor(Date.now() / 1000) - 100000
    // 45 个会话：needle 只放在**最旧的 5 个**里（它们会被 40 的上限切掉）
    for (let i = 0; i < 45; i++) {
      const hasNeedle = i < 5
      await makeSession(
        sessionsRoot,
        'proj-cap',
        `s${String(i).padStart(2, '0')}`,
        [hasNeedle ? '{"text":"CAP-ONLY-IN-OLDEST NEEDLE"}' : `{"text":"第 ${i} 份，没什么特别的"}`],
        baseSec + i,
      )
    }
    const missed = await runSessionSearch(sessionsRoot, 'CAP-ONLY-IN-OLDEST')
    ok(missed.coverage.available === 45, '可用 45 份', JSON.stringify(missed.coverage.available))
    ok(missed.coverage.considered === 40 && missed.coverage.skippedByCap === 5,
      '进队 40、因上限没看 5（以前这个 5 是无形的）', JSON.stringify(missed.coverage))
    ok(missed.hits.length === 0, '被切掉的 5 份里的关键词确实搜不到（如实承认，不是假装搜过）')
    ok(missed.coverage.complete === false, '漏看 → complete=false')
    ok(missed.text.includes('因上限没看') && missed.text.includes('这不等于会话里没有'),
      '零命中带「因上限没看」并限定范围', missed.text.split('\n').slice(0, 3).join(' | '))
    ok(!missed.text.includes('完整搜索了全部'), '不完整零命中**不许**说「完整搜索了全部」')

    // 【反向对照】把 needle 挪进最新那批 → 同样的输入必须命中且 complete=true
    const okr = await world('cap-ok')
    const nowSec = Math.floor(Date.now() / 1000) - 1000
    for (let i = 0; i < 5; i++) {
      await makeSession(okr.sessionsRoot, 'proj-cap', `s${i}`, ['{"text":"CAP-IN-RECENT NEEDLE"}'], nowSec + i)
    }
    const hit = await runSessionSearch(okr.sessionsRoot, 'CAP-IN-RECENT')
    ok(hit.hits.length === 5 && hit.coverage.skippedByCap === 0 && hit.coverage.complete === true,
      '【反向对照】5 份全看、全命中 → complete=true（判据不是恒 false）',
      JSON.stringify({ hits: hit.hits.length, cov: hit.coverage }))
  }

  group('8c. 输出上限：stoppedBy / skippedByOutput / hitChars 三条账')
  {
    const { sessionsRoot } = await world('out')
    // 三份会话，每份都有 6 条命中行：limit=2 时第一份停在中途，后面两份一份都不许开始读
    const lines = Array.from({ length: 6 }, (_, i) => `{"n":${i},"text":"OUT-LIMIT-NEEDLE 第 ${i} 段"}`)
    for (const name of ['a', 'b', 'c']) await makeSession(sessionsRoot, 'proj-o', name, lines)

    const limited = await runSessionSearch(sessionsRoot, 'OUT-LIMIT-NEEDLE', { limit: 2 })
    ok(limited.hits.length === 2 && limited.coverage.stoppedBy === 'limit',
      'limit=2 → 2 段、stoppedBy=limit', JSON.stringify({ h: limited.hits.length, s: limited.coverage.stoppedBy }))
    ok(limited.coverage.truncated === true, '输出被截 → truncated=true')
    ok(limited.coverage.searched === 0 && limited.coverage.partial === 1,
      '停在第一份中间 → 那份记 partial（不是 searched）', JSON.stringify(limited.coverage))
    ok(limited.coverage.skippedByOutput === 2, '后面两份**没开始** → skippedByOutput=2（不是悄悄不算）',
      JSON.stringify(limited.coverage.skippedByOutput))
    ok(limited.coverage.complete === false, '有 partial / skippedByOutput → complete=false')
    ok(limited.coverage.hitChars <= CHAR_BUDGET && limited.coverage.hitChars === limited.hits.reduce((a, h) => a + h.chars, 0),
      'hitChars 是实际吐出量且不越预算', JSON.stringify(limited.coverage.hitChars))
    const sum = limited.coverage.searched + limited.coverage.partial + limited.coverage.failed +
      limited.coverage.skippedByCap + limited.coverage.skippedByOutput
    ok(sum === limited.coverage.available, '真 IO 也满足 I1（五桶和 = available）', `${sum} vs ${limited.coverage.available}`)

    // 完整但截断：全部读完，只是片段被窗口裁短 → 两条轴一真一真
    const w2 = await world('out2')
    const longLine = `{"text":"${'x'.repeat(1500)} CLIPPED-NEEDLE ${'y'.repeat(1500)}"}`
    await makeSession(w2.sessionsRoot, 'proj-c', 'sess-long', [longLine])
    const clipped = await runSessionSearch(w2.sessionsRoot, 'CLIPPED-NEEDLE')
    ok(clipped.hits.length === 1 && clipped.hits[0].hasMatch === true && clipped.hits[0].chars <= HIT_CHARS,
      '长行命中：片段被裁但仍看得见关键词，长度 ≤ 500',
      JSON.stringify(clipped.hits[0] ? { chars: clipped.hits[0].chars, has: clipped.hits[0].hasMatch } : 'no hit'))
    ok(clipped.coverage.complete === true && clipped.coverage.truncated === true,
      '**两条轴同时在真：complete=true 且 truncated=true**（读完了，片段被裁）',
      JSON.stringify(clipped.coverage))
    ok(clipped.coverage.stoppedBy === null, '这一例不是被预算停下的（stoppedBy=null，截断来自窗口）')
  }

  group('8d. 根状态与旧格式（真目录）')
  {
    const w = await world('roots')
    const missing = await runSessionSearch(join(w.root, 'nope'), 'NEEDLE')
    ok(missing.coverage.root === 'missing' && missing.coverage.complete === false,
      '目录不存在 → root=missing', JSON.stringify(missing.coverage))
    ok(!missing.text.includes('没找到') && missing.text.includes('无法搜索'), '「目录不存在」不许说成「没找到」', missing.text)

    const notdirPath = join(w.root, 'plain-file')
    await writeFile(notdirPath, 'x')
    const notdir = await runSessionSearch(notdirPath, 'NEEDLE')
    ok(notdir.coverage.root === 'notdir', '路径是普通文件（ENOTDIR）→ root=notdir', JSON.stringify(notdir.coverage))
    ok(notdir.hits.length === 0 && notdir.text.includes('无法搜索') && !notdir.text.includes('没找到'),
      'ENOTDIR 不再被渲染成「没有命中」', notdir.text)

    // 旧格式只报告不读
    const w2 = await world('old')
    const d1 = join(w2.sessionsRoot, 'proj-x', 's-old-v3')
    await mkdir(d1, { recursive: true })
    await writeFile(join(d1, 'session.v3.jsonl.zstd'), multiFrame(['{"text":"OLD-FORMAT-NEEDLE"}']))
    const d2 = join(w2.sessionsRoot, 'proj-x', 's-old-nover')
    await mkdir(d2, { recursive: true })
    await writeFile(join(d2, 'session.jsonl.zstd'), multiFrame(['{"text":"OLD-FORMAT-NEEDLE"}']))
    const d3 = join(w2.sessionsRoot, 'proj-x', 's-bak')
    await mkdir(d3, { recursive: true })
    await writeFile(join(d3, 'session.v4.jsonl.zstd.bak-20260101'), multiFrame(['{"text":"BAK-NEEDLE"}']))

    const old = await runSessionSearch(w2.sessionsRoot, 'OLD-FORMAT-NEEDLE')
    ok(old.coverage.unrecognized === 2, 'v3 + 无版本 各记 1 份 unrecognized（.bak 不算）', JSON.stringify(old.coverage.unrecognized))
    ok(old.coverage.available === 0 && old.hits.length === 0, '旧格式**不被读**：available=0、零命中', JSON.stringify(old.coverage.available))
    ok(old.coverage.complete === false, '有认不得的格式 → complete=false')
    ok(old.text.includes('旧格式'), '覆盖行点名「旧格式 / 不认得」', old.text.split('\n')[0])

    // 注入 io：一个 project 读不动 → enumerationFailed，邻居照常搜到
    const w3 = await world('enum')
    await makeSession(w3.sessionsRoot, 'proj-good', 'sess-1', ['{"text":"ENUM-GOOD-NEEDLE"}'])
    await mkdir(join(w3.sessionsRoot, 'proj-bad'), { recursive: true })
    const flakyIo = {
      readdir: (p, o) => (String(p).endsWith('proj-bad')
        ? Promise.reject(Object.assign(new Error('boom'), { code: 'EACCES' }))
        : readdir(p, o)),
      stat,
      readFile,
    }
    const partialEnum = await runSessionSearch(w3.sessionsRoot, 'ENUM-GOOD-NEEDLE', { io: flakyIo })
    ok(partialEnum.coverage.enumerationFailed === 1, 'project 的 readdir 失败 → enumerationFailed=1（不再 catch 成空数组）',
      JSON.stringify(partialEnum.coverage.enumerationFailed))
    ok(partialEnum.coverage.complete === false, '枚举不全 → complete=false')
    ok(partialEnum.hits.length === 1, '枚举失败不给邻居背锅：另一份照常命中', JSON.stringify(partialEnum.hits.length))
  }

  group('8e. 同目录 v4 与旧格式并存；zstd 缺失时的账也不许失真')
  {
    // v3 排在 v4 之前：先挑到 v4 就 break 的写法会漏掉它
    const w = await world('mixed')
    const both = join(w.sessionsRoot, 'proj-m', 'sess-both')
    await mkdir(both, { recursive: true })
    await writeFile(join(both, 'session.v3.jsonl.zstd'), multiFrame(['{"text":"MIXED-OLD"}']))
    await writeFile(join(both, 'session.v4.jsonl.zstd'), multiFrame(['{"text":"MIXED-NEW NEEDLE"}']))
    const mixed = await runSessionSearch(w.sessionsRoot, 'MIXED-NEW')
    ok(mixed.coverage.available === 1 && mixed.hits.length === 1, '同目录的 v4 照常被读',
      JSON.stringify({ available: mixed.coverage.available, hits: mixed.hits.length }))
    ok(mixed.coverage.unrecognized === 1,
      '同目录里排在 v4 **之前**的 v3 也被数进 unrecognized（不因先挑后 break 漏计）',
      JSON.stringify(mixed.coverage.unrecognized))

    // zstd 缺失：账要真实 —— 枚举数、上限截掉数、旧格式数照记，进队的记 failed
    const w2 = await world('nozstd')
    await makeSession(w2.sessionsRoot, 'proj-z', 'a', ['{"text":"Z1"}'])
    await makeSession(w2.sessionsRoot, 'proj-z', 'b', ['{"text":"Z2"}'])
    const noZstd = await runSessionSearch(w2.sessionsRoot, 'NEEDLE', { zlib: null })
    ok(noZstd.coverage.zstdUnsupported === true, 'zlib 缺失 → zstdUnsupported=true')
    ok(noZstd.coverage.available === 2, '**available 不被抹成 0**（有 2 份会话就是 2 份）',
      JSON.stringify(noZstd.coverage.available))
    ok(noZstd.coverage.failed === 2 && noZstd.coverage.skippedByOutput === 0,
      '进队的 2 份记 failed（不是 skippedByOutput —— 它们不是被输出预算停下的）',
      JSON.stringify({ failed: noZstd.coverage.failed, skip: noZstd.coverage.skippedByOutput }))
    const sumZ = noZstd.coverage.searched + noZstd.coverage.partial + noZstd.coverage.failed +
      noZstd.coverage.skippedByCap + noZstd.coverage.skippedByOutput
    ok(sumZ === noZstd.coverage.available, 'zstd 缺失时 I1 仍成立', `${sumZ} vs ${noZstd.coverage.available}`)
    ok(noZstd.text.includes('无法搜索') && !noZstd.text.includes('没找到'),
      'zstd 缺失：只说无法搜索，一句「没找到」都没有', noZstd.text)

    const capped = await runSessionSearch(w2.sessionsRoot, 'NEEDLE', { zlib: null, cap: 1 })
    ok(capped.coverage.available === 2 && capped.coverage.considered === 1 && capped.coverage.skippedByCap === 1,
      'zstd 缺失 + 上限 1：进队 1、因上限没看 1、可用仍是 2',
      JSON.stringify({ a: capped.coverage.available, c: capped.coverage.considered, s: capped.coverage.skippedByCap }))
    const sumC = capped.coverage.searched + capped.coverage.partial + capped.coverage.failed +
      capped.coverage.skippedByCap + capped.coverage.skippedByOutput
    ok(sumC === capped.coverage.available && capped.coverage.complete === false,
      'zstd 缺失 + 上限时 I1 仍成立、complete=false',
      JSON.stringify({ sum: sumC, available: capped.coverage.available, complete: capped.coverage.complete }))
  }
}

// ────────────────────────── 9. 工具面接线 + prompt ──────────────────────────
group('9. 工具面：withSessions 开关、字符串契约、旧 token 兼容')
{
  const { memoryDir, sessionsRoot } = await world('wire')

  const off = createToolRunner({ memoryDir, sessionsRoot, apply: false, withSessions: false, ctx: makeCtx() })
  const offOut = await off.run('search_sessions', { query: 'NEEDLE' })
  ok(typeof offOut === 'string' && offOut.startsWith('错误'), 'withSessions=false：工具回错误串（不是抛异常）', offOut)
  ok(!autodreamToolSchemas({ apply: false, withSessions: false }).some((t) => t.name === 'search_sessions'),
    'withSessions=false：schema 里根本不注册 search_sessions（没有手，不是被劝阻）')
  ok(autodreamToolSchemas({ apply: false, withSessions: true }).some((t) => t.name === 'search_sessions'),
    '【反向对照】withSessions=true：注册了')

  const on = createToolRunner({ memoryDir, sessionsRoot, apply: false, withSessions: true, ctx: makeCtx() })
  const emptyOut = await on.run('search_sessions', { query: 'NEEDLE' })
  ok(typeof emptyOut === 'string', '工具面永远返回字符串（llm-loop 只吃字符串）', typeof emptyOut)
  /**
   * 空目录在**任何受支持的 Node** 上都必须说人话，但说法取决于能不能解 zstd：
   * Node 22.15+ 是「覆盖完整 + 没找到」，Node 18 / 20 是「无法搜索」。
   * 两种情况共用的底线是**不许把「读不了」说成「没有」** —— 这条断言因此不夹带版本条件。
   */
  const emptyOk = typeof zstdCompressSync === 'function'
    ? emptyOut.includes('覆盖完整') && emptyOut.includes('没找到')
    : emptyOut.includes('无法搜索') && !emptyOut.includes('没找到')
  ok(emptyOk,
    '空目录：能解压时说「覆盖完整 + 没找到」，解不了时只说「无法搜索」（两种都不许把读不了说成没有）',
    emptyOut)

  const short = await on.run('search_sessions', { query: 'x' })
  ok(short.includes('关键词太短'), '一个字符 → 明确说太短', short)

  const schema = autodreamToolSchemas({ apply: false, withSessions: true }).find((t) => t.name === 'search_sessions')
  ok(schema.description.includes('覆盖率'), '工具描述告诉模型「首行是覆盖率」')
  ok(schema.description.includes('不等于会话里没有'), '工具描述写明「覆盖不完整时没搜到 ≠ 没有」')
  ok(/段数/.test(schema.parameters.properties.limit.description), 'limit 描述说清它只管段数', schema.parameters.properties.limit.description)
}

group('10. prompt：覆盖不完整的零命中不能当反证')
{
  const basePrompt = { memoryDir: '/mem', apply: true, hoursSince: 6, sessionCount: 4, now: Date.now() }
  const withList = buildAutodreamUserPrompt({
    ...basePrompt,
    reconcileList: '- `project_old.md` —— 最近 2 天内还在被注入，但内容已经 30 天没动过',
  })
  ok(withList.includes('不能当成'), '阶段 2.5 写明：不完整零命中不能当成「过时 / 该归档」的反证')
  ok(withList.includes('没有看见'), '阶段 2.5 写明：零命中 = 没有看见，不是没有')
  ok(withList.includes('明确相反的证据'), '阶段 2.5 同时留了出口：有正向证据照常改（不是「complete=false 就一律不许动」）')
  ok(withList.includes('可能只覆盖得到'), '措辞是「可能」——覆盖完整时不许说反话')
  ok(!withList.includes('每次只覆盖得到'), '没有「每次都只覆盖一部分」这种绝对化说法')
  ok(withList.includes('全部核对通过、一个字都不改'), '原有退路措辞仍在（没有它模型会为了有产出瞎改）')

  const noList = buildAutodreamUserPrompt({ ...basePrompt, reconcileList: '' })
  ok(noList.includes('只是没看见'), '阶段 2 的 search_sessions 那条也点明「没搜到只是没看见」')
  ok(!noList.includes('阶段 2.5'), '无候选名单时阶段 2.5 整段不出现（老行为没变）')
  ok(noList.includes('不要通读会话记录。\n\n## 阶段 3 — 整合'), '阶段 2 与阶段 3 之间仍是原样空行（旧断言没被挤掉）')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
