#!/usr/bin/env node
/**
 * Q16 回归（2.1.21）：文件列表「展开 / 收起」按钮引用未定义 setExpanded。
 *
 * 修前红（外部审查 2026-10-31 报告 Q16）：
 *   FilesView 从 Section 里拆出后只解构了 `expanded`，父组件也没传 setter；
 *   `onToggle` 仍引用旧 Section 闭包里的 `setExpanded` —— 拆件后它不在本作用域，
 *   点一下卡片就是 `ReferenceError: setExpanded is not defined`（即使补一个同名 prop 也救不了，
 *   因为没解构）。
 *
 * 本套件验四件事：
 *   1. `mergeExpanded`（父组件实际用的合并逻辑）翻转目标文件、保留其余条目；
 *   2. 用真实源组件（FilesView + Card）直接调 `Card.props.onToggle('a.md')` 不再抛错，
 *      且状态真的翻转（再点一次收起 = 反向对照）；
 *   3. 真渲染出卡片后**点正文**，正文的 `data-clamp` 从 1 变 0、再点回 1（不是只断言按钮存在）；
 *   4. 静态接线守卫：分片里不再出现 setExpanded、父组件传了业务回调且用函数式 setState。
 *
 * 做法：把真实分片（05 / 55 / 50 / 72）拼进 vm 跑，用迷你 react + 假 DOM 渲染。
 * FilesView 没有 hooks，所以「直接调组件函数拿 Card 元素」和「真渲染后点正文」两条路都能走。
 *
 * 用法: node test/review-211-q16-test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'
import { makeMiniReact, makeFakeDocument, byClass, findAll, textOf } from './_client-vm-harness.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PARTS = [
  'client/05-shared.js', // TYPE_META / fmtSize 等共享基元
  'client/55-i18n-memory.js', // t / typeLabel（Card 要用）
  'client/50-shared-ui.js', // mergeExpanded / Card / ArchivedCard
  'client/72-files-view.js', // 被测组件 FilesView
]
const SOURCE = new Map(PARTS.map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')]))
const PANEL_SOLID = readFileSync(join(ROOT, 'client/70-memory-panel.js'), 'utf8')

/** 剥注释再判：解释性注释里提到旧名字是**正确**的，只有代码里再写一份才算违规。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')) }
}
const group = (t) => console.log('\n── ' + t + ' ──')

/** 把一个「必须来自 props 解构」的闭包调用扫出来（这正是修前 setExpanded 的形态）。 */
function closureCallViolations(src) {
  const m = src.match(/const \{([\s\S]*?)\} = props;/)
  const destructured = new Set(m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [])
  const out = []
  for (const mm of src.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = mm[1]
    // 只盯「父组件传进来的动作回调」这类名字；本地函数 / 全局 helper 不在判据内
    if (!/^(set|open|confirm|toggle|cancel|save|restore|delete|create)[A-Z]/.test(name)) continue
    if (!destructured.has(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** 拼真实分片 → vm 里跑 → 取回组件与合并函数。 */
function loadFilesView() {
  const rt = makeMiniReact()
  const sandbox = {
    __testReact: rt.api,
    document: makeFakeDocument(),
    console: { log() {}, warn() {}, error() {} },
  }
  vm.createContext(sandbox)
  const code = PARTS.map((rel) => SOURCE.get(rel)).join('\n') +
    // mergeExpanded 是本次修复才引入的；旧树上它是未定义的，用 typeof 取，别让 harness 先炸。
    '\n;globalThis.__q16 = { FilesView: FilesView, Card: Card, mergeExpanded: typeof mergeExpanded === "function" ? mergeExpanded : undefined };\n'
  vm.runInContext('const react = __testReact;\nconst h = react.createElement;\n' + code, sandbox, { filename: 'client/05+55+50+72 (Q16)' })
  return { rt, api: sandbox.__q16 }
}

const ITEMS = [
  { file: 'a.md', type: 'project', description: '第一条活动记忆的正文，用来验证展开与收起。', size: 1024, tags: [] },
  { file: 'b.md', type: 'feedback', description: '第二条活动记忆的正文。', size: 2048, tags: [] },
]

/** 造一份完整的 FilesView props（Section 真传的那一整套）。 */
function makeProps(state, api, overrides = {}) {
  return Object.assign({
    loading: false, totalCount: ITEMS.length,
    openAdd() {}, createIndexSkeleton() {},
    statusFilter: 'active', setStatusFilter() {},
    items: ITEMS, archiveItems: [], filtered: ITEMS,
    setTypeFilter() {}, setTagFilter() {}, setQuery() {},
    busy: false, restoring: null,
    archDelete: null, archEdit: null, archLoad: false, archSaving: false,
    archText: '', setArchText() {}, openArchEdit() {}, saveArchEdit() {}, cancelArchEdit() {},
    restoreFile() {}, setArchDelete() {}, setArchEdit() {}, deleteArchivedFile() {},
    expanded: state.expanded,
    // 父组件 Section 的做法：函数式 setState + mergeExpanded（源里的同一份实现）
    onToggleExpanded(file) { state.expanded = api.mergeExpanded(state.expanded, file) },
    deleting: null, archiving: null, archiveReason: '',
    setArchiveReason() {}, setArchiving() {}, setDeleting() {},
    confirmArchive() {}, toggleLock() {}, openEdit() {}, confirmDelete() {},
  }, overrides)
}

/** 从渲染树里取某张卡片的正文节点（Card 用 data-clamp 表示展开态）。 */
const narrativeOf = (card) => findAll(card, (n) => n.props && n.props['data-clamp'] !== undefined)[0]

async function main() {
  const { rt, api } = loadFilesView()
  ok(typeof api.FilesView === 'function', '从真实分片里取到 FilesView')
  ok(typeof api.Card === 'function', '从真实分片里取到 Card')
  ok(typeof api.mergeExpanded === 'function', '从真实分片里取到父组件用的 mergeExpanded')

  // ── 1. 合并语义：翻转目标、保留其余（函数式合并存在的意义）──
  group('1. mergeExpanded：只翻转目标文件，其余条目原样保留')
  {
    const merge = api.mergeExpanded
    ok(typeof merge === 'function', '父组件用的 mergeExpanded 存在（修前：没有这个合并函数）')
    if (typeof merge === 'function') {
      let s = {}
      s = merge(s, 'a.md')
      ok(s['a.md'] === true, '空表 + a.md → a.md 展开')
      s = merge(s, 'a.md')
      ok(s['a.md'] === false, '再合并一次 a.md → 收起（幂等的翻转）')
      s = {}
      s = merge(s, 'a.md')
      s = merge(s, 'b.md')
      ok(s['a.md'] === true && s['b.md'] === true, '先 a 后 b：两张都展开，a 没被后一笔覆盖')
    }

    // 【反向对照】旧写法用「上一帧快照」拼新对象：同一帧连点两次会丢第一笔
    const stale = {}
    void Object.assign({}, stale, { 'a.md': true }) // 第一次点击的结果被写进 state
    const naiveSecond = Object.assign({}, stale, { 'b.md': true }) // 第二次仍用同一份快照
    ok(naiveSecond['a.md'] !== true, '【反向对照】快照式合并确实会丢掉第一笔（判据不是空转）')
  }

  // ── 2. 直接调 Card.props.onToggle：不再 ReferenceError，状态真的翻转 ──
  group('2. 直接调 Card.props.onToggle：ReferenceError 消失 + 状态翻转 + 反向对照')
  {
    const state = { expanded: {} }
    // FilesView 没有 hooks，直接当纯函数调就能拿到「Card 元素」这一层（审查复现同款手法）
    const raw = api.FilesView(makeProps(state, api))
    const cardEl = [].concat(...raw.children)[0]
    ok(!!cardEl && cardEl.type === api.Card, '文件列表里第一张卡片是真实的 Card 组件')
    ok(cardEl && typeof cardEl.props.onToggle === 'function', '卡片带 onToggle（点击路径的入口）')
    const callToggle = (file) => { let e = null; try { cardEl.props.onToggle(file) } catch (err) { e = err } return e }
    let err = callToggle('a.md')
    ok(err === null, '调用 onToggle("a.md") 不再抛异常（修前：ReferenceError: setExpanded is not defined）',
      err ? String(err && err.message) : '')
    ok(state.expanded['a.md'] === true, '点一次 → a.md 的展开态变成 true（状态确实翻转）')
    err = callToggle('a.md')
    ok(err === null, '再点一次也不抛异常', err ? String(err && err.message) : '')
    ok(state.expanded['a.md'] === false, '再点一次 → 收起（反向对照）')
  }

  // ── 3. 真渲染 + 点正文：展开 / 收起看得见 ──
  group('3. 真渲染活动卡片后点正文：data-clamp 跟着展开态变')
  {
    const state = { expanded: {} }
    /** 点击包一层：修前这里会抛 ReferenceError，要让它成为一条 FAIL 而不是 harness 崩掉。 */
    const clickBody = (node) => { let e = null; try { node.props.onClick() } catch (err) { e = err } return e }
    let tree = await rt.settle(api.FilesView, makeProps(state, api))
    const cards = byClass(tree, 'smem-card')
    ok(cards.length === 2, `两张活动卡都渲染出来（实际 ${cards.length} 张）`)
    const bodyA = narrativeOf(cards[0])
    ok(!!bodyA && bodyA.props['data-clamp'] === '1', '初始是收起态（data-clamp=1）')
    ok(!!bodyA && textOf(bodyA).indexOf('第一条活动记忆的正文') >= 0, '正文就是 item.description（点得中它才有意义）')

    // 点 A 的正文 → FilesView 上报 → 父组件函数式合并 → 重新渲染
    const errClick = clickBody(bodyA)
    ok(errClick === null, '点正文不抛异常（修前：ReferenceError: setExpanded is not defined）',
      errClick ? String(errClick && errClick.message) : '')
    tree = await rt.settle(api.FilesView, makeProps(state, api))
    const cardsA1 = byClass(tree, 'smem-card')
    ok(narrativeOf(cardsA1[0]).props['data-clamp'] === '0', '点正文后 A 展开（data-clamp=0）')
    ok(narrativeOf(cardsA1[1]).props['data-clamp'] === '1', 'B 不受影响（合并只翻转目标文件）')

    // 反向对照：再点一次收起
    const errAgain = clickBody(narrativeOf(cardsA1[0]))
    ok(errAgain === null, '第二次点正文也不抛异常', errAgain ? String(errAgain && errAgain.message) : '')
    tree = await rt.settle(api.FilesView, makeProps(state, api))
    ok(narrativeOf(byClass(tree, 'smem-card')[0]).props['data-clamp'] === '1', '再点一次 A 收起（反向对照）')

    // 点 B，A 仍收起：不会因为「旧闭包快照」把另一张卡带开
    clickBody(narrativeOf(byClass(tree, 'smem-card')[1]))
    tree = await rt.settle(api.FilesView, makeProps(state, api))
    const cardsB = byClass(tree, 'smem-card')
    ok(narrativeOf(cardsB[1]).props['data-clamp'] === '0' && narrativeOf(cardsB[0]).props['data-clamp'] === '1',
      '点 B 只展开 B，A 保持收起')
  }

  // ── 4. 静态接线守卫：分片不再引用旧闭包名；父组件传业务回调且函数式合并 ──
  group('4. 静态接线守卫（no-undef 的定点版）')
  {
    const filesViewSrc = strip(SOURCE.get('client/72-files-view.js'))
    const panelSrc = strip(PANEL_SOLID)

    ok(!/\bsetExpanded\b/.test(filesViewSrc), '72-files-view.js 里不再出现 setExpanded（修前就是这一句）')
    ok(/\bonToggleExpanded\b/.test(filesViewSrc), '72-files-view.js 解构了 onToggleExpanded 业务回调')
    ok(/\bonToggle:\s*onToggleExpanded\b/.test(filesViewSrc), 'Card 的 onToggle 直接接业务回调')

    ok(/onToggleExpanded:\s*onToggleExpanded\b/.test(panelSrc), 'Section 把 onToggleExpanded 传给了 FilesView')
    const setExpandedCalls = (panelSrc.match(/setExpanded\s*\(/g) || []).length
    ok(setExpandedCalls === 1 && /setExpanded\(function \(prev\)/.test(panelSrc),
      `Section 只用函数式 setState 合并展开态（setExpanded 调用 ${setExpandedCalls} 次）`)

    // 定点 no-undef：FilesView 里调用的动作回调必须来自 props 解构，不能靠别的函数的闭包
    const bad = closureCallViolations(filesViewSrc)
    ok(bad.length === 0, 'FilesView 调用的每个动作回调都来自 props 解构', bad.join(','))
    // 【反向对照】把修前的写法喂给同一判据，必须报 setExpanded
    const ghost = 'const { expanded } = props;\nfunction FilesView() { return setExpanded(Object.assign({}, expanded)); }'
    const ghostBad = closureCallViolations(ghost)
    ok(ghostBad.includes('setExpanded'), '【反向对照】旧写法喂给同一判据会被抓出来', ghostBad.join(','))
  }

  console.log(`\n结果：${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('harness error:', (e && e.stack) || e)
  process.exit(2)
})
