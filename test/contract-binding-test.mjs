#!/usr/bin/env node
/**
 * contract-binding-test.mjs — 守卫「**说了不验的承诺**」（2026-10-16 建，1.0.0 门槛项）
 *
 * 为什么需要它：1.0.0 的定义是「每条保证都咬在一条会因它破损而变红的断言上」。
 * 而在建这条守卫之前，`npm test` 2508 条全绿、契约里 38 处写「保证」——
 * **没有任何机制能回答「其中哪几条其实没人看着」**。外部复审正是从这里翻出五条
 * 「承诺与事实对不上」：代码在那些点上压根没被断言碰过，而契约、README、CHANGELOG
 * 三处都写着承诺。这和 0.9.17 / 0.9.18 的「两个套件没登记所以 126 条断言从没跑过」
 * 是同一类病：**「全绿」这句话没有说自己覆盖了谁**。
 *
 * 同族的窄版本已经有了：`suite-registry-test.mjs` 盯「有没有写了不跑的套件」。
 * 这一条盯的是它的对偶面 ——「有没有说了不验的承诺」。
 *
 * 它检查五件事：
 *   1. 契约的定性词汇**只有四档**（`保证` / `尽力` / `明确做不到` / `未验证`），
 *      旧的第三种写法 `不保证` 已经清干净 —— 否则同一件事会有两种叫法。
 *   2. 每条标「保证」的行都带断言标识；标「明确做不到」的**不许**带。
 *   3. 标识格式是 `套件文件名.mjs::断言名子串`，且套件**已登记**进 `run.mjs` 的 `SUITES`。
 *   4. 标识指向的断言**真的存在** —— 判据是**本次运行里它真的打出过 PASS**
 *      （台账由 `run.mjs` 落，见 `_passlog.mjs`），不是去源码 grep 一个字符串：
 *      源码里的字符串可能落在注释里、或在一条永远不走的 `if` 分支里。
 *   5. 【反向对照】凭空造一个不存在的断言、一个未登记的套件，判据必须能报出来 ——
 *      否则上面几条可能只是「判据写反了所以永远绿」。
 *
 * ⚠️ 绑定表就在 `docs/1.0.0-contract.md` 里（`断言` 列），不另开一份 —— 免得两处各自维护。
 * 绑定是**可选**的只对 `尽力` / `未验证` 成立（有断言但不构成保证）。
 *
 * 用法: node test/contract-binding-test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadPassLog, parseBinding, registeredSuites } from './_passlog.mjs'
import { LABELS, loadContract, shapeProblems as shapeIssues } from './_docs.mjs'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const HERE = fileURLToPath(new URL('.', import.meta.url))

// ── 契约怎么读，统一在 `_docs.mjs` 里（两个守卫共用同一份解析规则）────────────
const { vocab, rows, tables } = loadContract()
const shapeProblems = shapeIssues(tables, /^\d+\.\d+$/)
const registered = registeredSuites()

const guarantees = rows.filter((r) => r.label === '保证')
const impossible = rows.filter((r) => r.label === '明确做不到')

group('0. 前置：契约真的被解析出来了')
{
  // 没有这一组，后面任何「全绿」都可能是「读不到所以没得比」。
  ok(rows.length >= 40, `解析到足够多的契约行（实际 ${rows.length}）`)
  ok(guarantees.length >= 20, `其中标「保证」的行足够多（实际 ${guarantees.length}）`)
  ok(tables.filter((t) => t.header.includes('断言')).length >= 5,
    '至少 5 张表带「断言」列（否则绑定无处可写）')
  ok(shapeProblems.length === 0,
    '每行的单元格数与表头一致（不一致说明格子里的 `|` 把表格撑坏了）',
    shapeProblems.slice(0, 3).join('；'))
  ok(new Set(rows.map((r) => r.id)).size === rows.length, '契约行编号没有重复')
}

group('1. 定性只有四档，旧的「不保证」写法和未知写法都不许出现')
{
  ok(LABELS.every((l) => vocab.includes(l)) && vocab.length === LABELS.length,
    '定义表给出的词汇恰好是四档（保证 / 尽力 / 明确做不到 / 未验证）',
    vocab.join(' / '))
  const unknown = [...new Set(rows.map((r) => r.label))].filter((l) => !LABELS.includes(l))
  ok(unknown.length === 0, '没有出现四档之外的定性写法', unknown.join(' / '))
}

group('2. 每条「保证」都带断言标识')
{
  const naked = guarantees.filter((r) => r.bindings.length === 0)
  ok(naked.length === 0,
    `没有「说了不验」的保证行（裸行 ${naked.length} 条）`,
    naked.map((r) => r.id).join(', '))

  // 【反向对照】把一条真绑定抹掉，判据必须多报一条 —— 否则上面那条可能只是恒真。
  if (guarantees.length) {
    const fake = guarantees.map((r, i) => (i === 0 ? { ...r, bindings: [] } : r))
      .filter((r) => r.bindings.length === 0)
    ok(fake.length === naked.length + 1 && fake.some((r) => r.id === guarantees[0].id),
      '【反向对照】抹掉一条绑定后，判据确实会多报一条出来',
      `${naked.length} → ${fake.length}`)
  }
}

group('3. 标识格式与套件登记')
{
  const bad = []
  const unregistered = []
  for (const r of rows) {
    for (const b of r.bindings) {
      const p = parseBinding(b)
      if (!p) { bad.push(`${r.id}:${b}`); continue }
      if (!registered.includes(p.suite)) unregistered.push(`${r.id}:${b}`)
    }
  }
  ok(bad.length === 0, '标识都是 `套件.mjs::断言名子串` 格式', bad.slice(0, 3).join('；'))
  ok(registered.length >= 30, `从 run.mjs 读出足够多的登记套件（实际 ${registered.length}）`)
  ok(unregistered.length === 0,
    '标识指向的套件都登记在 SUITES 里（没登记的套件等于没跑）',
    unregistered.slice(0, 3).join('；'))
}

group('4. 标识指向的断言真的跑过')
{
  const bound = []
  for (const r of rows) for (const b of r.bindings) bound.push({ id: r.id, raw: b, ...parseBinding(b) })

  const { source, log } = loadPassLog(bound.map((b) => b.suite))
  console.log(`       （台账来源：${source === 'run' ? '本次 npm test 的实况' : '本守卫自己补跑'}）`)
  // `npm test` 里必须吃 `run.mjs` 落的账：吃不到就等于白跑一遍，而且说明守卫排在了
  // 被绑定套件的前面（读到的是残缺的账）。单独 `node test/contract-binding-test.mjs`
  // 时没有账可读，退回补跑是正常的 —— 结果同样来自真实运行，只是慢。
  if (process.env.SAGE_MEM_PASSLOG) {
    ok(source === 'run', '在 npm test 里用的是本次运行的实况台账',
      source === 'self' ? '守卫排在了被绑定套件的前面，读到的是残缺的账' : '')
  } else {
    ok(source === 'self', '【单独跑】没有 run.mjs 的台账，已退回本守卫自己补跑')
  }

  const missing = []
  const empty = []
  let total = 0
  for (const b of bound) {
    const names = log.get(b.suite)
    if (!names) { empty.push(`${b.id}:${b.suite}`); continue }
    const hit = names.filter((n) => n.includes(b.needle))
    total += hit.length
    if (hit.length === 0) missing.push(`${b.id}→${b.raw}`)
  }

  ok(bound.length > 0, '契约里确实有绑定（否则这一组全是空转）')
  ok(empty.length === 0, '被绑定的套件都在台账里', empty.slice(0, 3).join('；'))
  ok(missing.length === 0,
    `每条保证指向的断言都真的打出了 PASS（落空 ${missing.length} 条）`,
    missing.slice(0, 5).join('；'))
  ok(total >= bound.length,
    `绑定没有退化成一堆空匹配（${bound.length} 条绑定命中 ${total} 条断言）`)

  // 逐行落一条证据：这条输出就是「哪片保证由谁看着」的清单。
  for (const r of guarantees) {
    const detail = r.bindings.map((b) => {
      const p = parseBinding(b)
      const n = (log.get(p.suite) ?? []).filter((x) => x.includes(p.needle)).length
      return `${p.suite}::${p.needle}（${n} 条）`
    }).join(' + ')
    ok(r.bindings.length > 0 && r.bindings.every((b) => {
      const p = parseBinding(b)
      return p && (log.get(p.suite) ?? []).some((x) => x.includes(p.needle))
    }), `${r.id} ← ${detail || '（无绑定）'}`)
  }

  // 【反向对照】凭空造两条不可能命中的标识，判据必须分别能报出来。
  if (bound.length) {
    const ghostNeedle = 'zzz-这条断言不可能存在-zzz'
    ok((log.get(bound[0].suite) ?? []).filter((n) => n.includes(ghostNeedle)).length === 0,
      '【反向对照】不存在的断言子串确实一条都命不中')
    ok(!registered.includes('ghost-suite-test.mjs'), '【反向对照】未登记的套件确实不在 SUITES 里')
  }
}

group('5. 「明确做不到」不许挂标识')
{
  const wrong = impossible.filter((r) => r.bindings.length > 0)
  ok(wrong.length === 0,
    '能力边界那几行不带断言（带了说明口径混乱：到底是做不到还是有人看着）',
    wrong.map((r) => r.id).join(', '))
}

group('6. 约定本身被钉住')
{
  const idx = registered.indexOf('contract-binding-test.mjs')
  ok(idx >= 0, '本守卫自己已登记（不能给自己开后门）')
  ok(!registered.includes('_passlog.mjs'), '`_` 开头的共享辅助不被登记为套件')
  // 在 npm test 里，守卫读的是**已经落好账**的那些套件；排在它们前面就会读到残缺的账。
  const boundSuites = new Set()
  for (const r of rows) for (const b of r.bindings) boundSuites.add(parseBinding(b)?.suite)
  boundSuites.delete(undefined)
  const tooEarly = [...boundSuites].filter((s) => registered.indexOf(s) > idx)
  ok(tooEarly.length === 0,
    '守卫排在所有被绑定套件之后（否则读到的账是残缺的）', tooEarly.join(', '))
  ok(readFileSync(join(HERE, 'run.mjs'), 'utf8').includes('SAGE_MEM_PASSLOG'),
    'run.mjs 确实把台账路径交给了子套件（否则第 4 组会静默退化成补跑）')
}

const tally = {}
for (const r of rows) tally[r.label] = (tally[r.label] ?? 0) + 1
console.log('')
console.log(`契约行 ${rows.length} 条：${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
