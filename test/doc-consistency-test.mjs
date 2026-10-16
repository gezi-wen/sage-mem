#!/usr/bin/env node
/**
 * doc-consistency-test.mjs — 守卫「**同一个能力，两份文档说法不一样**」（2026-10-16 建）
 *
 * 为什么需要它：外部复审抓到一处自相矛盾 —— 边界表把「`fs/write-intent` 的注册窗口」
 * 标成 best effort，契约正文别处又写成保证。**根因不是谁写错了，是两份文档各自维护
 * 同一件事**：契约（`1.0.0-contract.md`）说「升级后你能依赖什么」，边界表
 * （`1.0.0-boundaries.md`）说「这东西到底靠不靠得住」—— 同一批能力被写了两遍，
 * 靠人眼维持一致。人眼会累，机器不会。
 *
 * 所以边界表多了两列：
 *   - `契约` 列：这一行对应契约的哪一行（编号），没有对应就写 `—`；
 *   - 守卫按这张对照表**逐行核对定性必须相同** —— 改一边忘另一边就会红。
 *
 * 同一份材料里还有第三处承诺需要被看着：`docs/review-findings.md`
 * （外部复审发现的永久账）。每条发现都必须写清**由哪条断言看着**；写 `—` 的行
 * 必须写明「谁看着」（守不住的用发布清单/人工，但必须写出来，不许留空）。
 * 复审者那句「建议暂缓把本材料中的相关能力标为 1.0.0 保证」指的就是这类留空。
 *
 * ⚠️ 与 `contract-binding-test.mjs` 一样：消费 `run.mjs` 落的断言台账，
 * 所以必须排在 `SUITES` 后段。
 *
 * 用法: node test/doc-consistency-test.mjs
 */
import { loadPassLog, parseBinding, registeredSuites } from './_passlog.mjs'
import { LABELS, loadBoundaries, loadContract, loadReviewFindings } from './_docs.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const HERE = fileURLToPath(new URL('.', import.meta.url))

const contract = loadContract()
const boundaries = loadBoundaries()
const findings = loadReviewFindings()
const registered = registeredSuites()
const contractById = new Map(contract.rows.map((r) => [r.id, r]))

/** 逐行核对「边界表的定性 == 它引用的契约行的定性」。抽成函数是为了能做反向对照。 */
function labelMismatches(bRows, byId) {
  const out = []
  for (const b of bRows) {
    for (const ref of b.contract) {
      const c = byId.get(ref)
      if (!c) { out.push(`${b.id}→${ref}：契约里没有这一行`); continue }
      if (c.label !== b.label) out.push(`${b.id}→${ref}：边界表写「${b.label}」，契约写「${c.label}」`)
    }
  }
  return out
}

group('0. 前置：三份文档都读进来了')
{
  ok(boundaries.rows.length >= 30, `边界表解析到足够多的行（实际 ${boundaries.rows.length}）`)
  ok(contract.rows.length >= 40, `契约解析到足够多的行（实际 ${contract.rows.length}）`)
  ok(findings.rows.length >= 9, `发现永久账解析到足够多的行（实际 ${findings.rows.length}）`)
  ok(boundaries.tables.some((t) => t.header.includes('契约')), '边界表已经有「契约」对照列')
  ok(findings.tables.some((t) => t.header.includes('谁看着')), '发现永久账已经有「谁看着」列')
}

group('1. 定性词汇唯一（两份文档用同一套四档）')
{
  ok(contract.vocab.length === LABELS.length && LABELS.every((l) => contract.vocab.includes(l)),
    '契约的定义表给出恰好四档', contract.vocab.join(' / '))

  // 边界表自己那张「四档定性」表：以它第一列为准取词汇。
  const defTable = boundaries.tables.find((t) => t.header.includes('判据'))
  const bVocab = defTable ? defTable.rows.map((c) => c[0].replace(/\*\*/g, '').trim()) : []
  ok(bVocab.length === LABELS.length && LABELS.every((l) => bVocab.includes(l)),
    '边界表的定义表给出同一套四档（措辞不许各写各的）', bVocab.join(' / '))

  const unknown = [...new Set(boundaries.rows.map((r) => r.label))].filter((l) => !LABELS.includes(l))
  ok(unknown.length === 0, '边界表没有出现四档之外的定性写法', unknown.join(' / '))
}

group('2. 逐行一致：边界表引用的契约行，定性必须相同')
{
  const noColumn = boundaries.rows.filter((r) => !r.hasContractColumn)
  ok(noColumn.length === 0, '每一行都能读到「契约」列', noColumn.map((r) => r.id).join(', '))

  const silent = boundaries.rows.filter((r) => r.hasContractColumn && !r.contractRaw)
  ok(silent.length === 0,
    '每一行都明确表态了（要么写契约行编号，要么写 `—`）——留空等于没说',
    silent.map((r) => r.id).join(', '))

  const mism = labelMismatches(boundaries.rows, contractById)
  ok(mism.length === 0,
    `边界表与契约逐行对得上（不一致 ${mism.length} 处）`, mism.slice(0, 5).join('；'))

  const referenced = new Set(boundaries.rows.flatMap((r) => r.contract))
  ok(referenced.size >= 15, `对照覆盖了足够多的契约行（实际 ${referenced.size} 行）`)

  // 【反向对照】真映射改一个字、删一个引用，判据必须都报出来。
  const sample = boundaries.rows.find((r) => r.contract.length > 0)
  if (sample) {
    const flipped = [{ ...sample, label: sample.label === '保证' ? '尽力' : '保证' }]
    const m1 = labelMismatches(flipped, contractById)
    ok(m1.length === sample.contract.length && m1.every((x) => x.includes(sample.id)),
      '【反向对照】把定性改一个字，判据确实会报出来', `${m1.length} 处`)

    const ghost = [{ ...sample, contract: ['99.99'] }]
    ok(labelMismatches(ghost, contractById).length === 1,
      '【反向对照】引用一个不存在的契约行，判据确实会报出来')
  }
}

group('3. 边界表自报的统计与逐行实际一致')
{
  const tally = {}
  for (const r of boundaries.rows) tally[r.label] = (tally[r.label] ?? 0) + 1
  // §四 那张统计表的表头是 `定性 | 条数 | 行号`。
  const statTable = boundaries.tables.find((t) => t.header.includes('条数'))
  ok(!!statTable, '边界表有「定性统计」表（可复算）')
  if (statTable) {
    const bad = []
    let sum = 0
    for (const cells of statTable.rows) {
      const label = cells[0].replace(/\*\*/g, '').trim()
      const n = Number(cells[1].replace(/\*\*/g, '').trim())
      if (!LABELS.includes(label)) continue
      sum += n
      if (tally[label] !== n) bad.push(`${label}: 表里写 ${n}，逐行数是 ${tally[label] ?? 0}`)
    }
    const stated = sum
    ok(bad.length === 0, '统计表每一档的条数都等于逐行数出来的条数', bad.join('；'))
    ok(stated === boundaries.rows.length,
      `统计表合计等于边界表实际行数（${stated} vs ${boundaries.rows.length}）`)
  }
}

group('4. 外部发现的永久账：每条都有东西看着')
{
  const ids = new Set(findings.rows.map((r) => r.id))
  ok(ids.size === findings.rows.length, '发现编号没有重复')
  ok([...ids].every((x) => /^R\d+$/.test(x)), '发现编号都是 R 开头')

  const noStatus = findings.rows.filter((r) => !r.status)
  ok(noStatus.length === 0, '每条发现都写了处置', noStatus.map((r) => r.id).join(', '))

  // 没绑断言的发现，必须写明「谁看着」（守不住的可以是发布清单/人工，但不许留空）
  const unguarded = findings.rows.filter((r) => r.bindings.length === 0)
  const blankWho = unguarded.filter((r) => !r.who)
  ok(blankWho.length === 0,
    `没绑断言的那几条都写明了「谁看着」（留空 ${blankWho.length} 条）`,
    blankWho.map((r) => r.id).join(', '))
  console.log(`       （${findings.rows.length} 条发现：有断言 ${findings.rows.length - unguarded.length} 条 · 无断言 ${unguarded.length} 条）`)

  const bound = []
  for (const r of findings.rows) for (const b of r.bindings) bound.push({ id: r.id, raw: b, ...parseBinding(b) })

  const { source, log } = loadPassLog(bound.map((b) => b.suite))
  console.log(`       （台账来源：${source === 'run' ? '本次 npm test 的实况' : '本守卫自己补跑'}）`)
  // 与 contract-binding-test 同一口径：npm test 里必须吃 run.mjs 落的账；
  // 单独跑时没有账可读，退回补跑是正常的。
  if (process.env.SAGE_MEM_PASSLOG) {
    ok(source === 'run', '在 npm test 里用的是本次运行的实况台账',
      source === 'self' ? '守卫排在了被绑定套件的前面，读到的是残缺的账' : '')
  } else {
    ok(source === 'self', '【单独跑】没有 run.mjs 的台账，已退回本守卫自己补跑')
  }

  const badFormat = bound.filter((b) => !b.suite)
  ok(badFormat.length === 0, '发现账里的标识都是 `套件.mjs::断言名子串` 格式',
    badFormat.map((b) => `${b.id}:${b.raw}`).slice(0, 3).join('；'))

  const unregistered = bound.filter((b) => b.suite && !registered.includes(b.suite))
  ok(unregistered.length === 0, '发现账绑定的套件都已登记',
    unregistered.map((b) => `${b.id}:${b.raw}`).slice(0, 3).join('；'))

  const missing = []
  let total = 0
  for (const b of bound) {
    if (!b.suite) continue
    const hit = (log.get(b.suite) ?? []).filter((n) => n.includes(b.needle))
    total += hit.length
    if (hit.length === 0) missing.push(`${b.id}→${b.raw}`)
  }
  ok(bound.length > 0, '发现账里确实绑了断言（否则这一组全是空转）')
  ok(missing.length === 0,
    `发现账里绑定的断言都真的打出了 PASS（落空 ${missing.length} 条）`,
    missing.slice(0, 5).join('；'))
  console.log(`       （${bound.length} 条绑定命中 ${total} 条断言）`)

  // 【反向对照】不存在的断言子串必须一条都命不中 —— 否则「命中」可能只是判据恒真。
  if (bound.length && bound[0].suite) {
    const ghost = (log.get(bound[0].suite) ?? []).filter((n) => n.includes('zzz-不可能存在的断言-zzz'))
    ok(ghost.length === 0, '【反向对照】不存在的断言子串一条都命不中')
  }
}

group('5. 约定本身被钉住')
{
  const idx = registered.indexOf('doc-consistency-test.mjs')
  ok(idx >= 0, '本守卫自己已登记')
  ok(!registered.includes('_docs.mjs') && !registered.includes('_passlog.mjs'),
    '`_` 开头的共享辅助不被登记为套件')
  const boundSuites = new Set(findings.rows.flatMap((r) => r.bindings.map((b) => parseBinding(b)?.suite)))
  boundSuites.delete(undefined)
  const tooEarly = [...boundSuites].filter((s) => registered.indexOf(s) > idx)
  ok(tooEarly.length === 0, '守卫排在所有被绑定套件之后（否则读到的账是残缺的）', tooEarly.join(', '))

  // 这份材料的入口（复审指南）必须点到守卫，否则复审者看不到机制。
  const guide = readFileSync(join(HERE, '..', 'docs', '1.0.0-review-guide.md'), 'utf8')
  ok(guide.includes('contract-binding-test') || guide.includes('契约绑定'),
    '复审指南提到了「保证 ↔ 断言」这条守卫（否则机制对复审者不可见）')
  ok(guide.includes('review-findings'), '复审指南提到了外部发现的永久账')
}

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
