#!/usr/bin/env node
/**
 * 「压缩前记忆提醒」卡的**渲染层**验证（2.17.0）。
 *
 * 为什么另开一份：`precompact-test.mjs` 测得到「算得对、判得对」，测不到
 * 「开关在不在、点了写没写对设置、越界有没有先拦住」。2026-09-15 那次返工的
 * 结论是 DOM 断言全绿 ⇏ 能用 —— 所以这里直接把真实分片拼进 vm，按「人点得下去」
 * 的标准读渲染树。
 *
 * 用法: node test/precompact-render-test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { makeMiniReact, byClass, textOf, runFragments } from './_client-vm-harness.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PARTS = [
  'client/05-shared.js',
  'client/20-codecs.js',
  'client/40-styles.js',
  'client/50-shared-ui.js',
  'client/55-i18n-memory.js',
  'client/64-lab-settings.js',
]

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')) }
}

/** 记录每一次 setSettings 的入参 —— 「点一下到底写了什么」是这张卡最要紧的断言。 */
const saves = []
/** 宿主当前设置（可变：模拟保存后读回）。 */
let settings = { mmr: 0, todoBoard: 0, preCompact: 0, preCompactLead: 8 }

const limits = {}
const envelope = (extra) => ({
  ok: true,
  value: {
    limits, pendingLimits: limits, restartRequired: false, ui: {}, reserved: [], reservedExtra: [],
    experimental: { ...settings },
    pendingExperimental: { ...settings },
    limitDiagnostics: [],
    ...extra,
  },
})

const remote = {
  getSettings: () => Promise.resolve(envelope()),
  setSettings: (patch) => {
    saves.push(patch)
    if (patch && patch.experimental) Object.assign(settings, patch.experimental)
    return Promise.resolve({
      ok: true,
      restartRequired: false,
      settings: {
        limits, pendingLimits: limits, restartRequired: false, ui: {}, reserved: [], reservedExtra: [],
        experimental: { ...settings },
        pendingExperimental: { ...settings },
        limitDiagnostics: [],
      },
    })
  },
}

const ctx = { get: (name) => (name === 'remote.memory' ? remote : null) }

/**
 * 起一个新实例（新的迷你 react + 新沙箱）。
 *
 * 为什么要「新实例」而不是接着 settle：这张卡的草稿值只在初次挂载时从宿主读一次
 * （错误时保留用户输入，不静默改回去）。所以要验「宿主里已经是开的」必须重新挂载
 * —— 复用同一个实例只会读到上一次的草稿。
 */
function boot() {
  const mini = makeMiniReact()
  const sandbox = {
    window: { __ModuleLoader__: { load: () => {} } },
    document: { createElement: () => ({ dataset: {}, style: {} }), addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    exports: {},
    Symbol, Object, Array, JSON, Math, Date, Map, Set, Promise, Error, Number, String, Boolean, RegExp,
    isNaN, parseInt, parseFloat, Intl,
    __testReact: mini.api,
  }
  const sources = PARTS.map((rel) => readFileSync(join(ROOT, rel), 'utf8'))
  runFragments(PARTS, sources, sandbox, [
    'const require = function () { return new Proxy({}, { get: () => () => ({}) }); };',
    'const react = __testReact;',
    'const h = react.createElement;',
    'globalThis.__pc = { Card: PreCompactLabCard };',
  ].join('\n'))
  return { mini, Card: sandbox.__pc.Card }
}

const props = { ctx }

async function main() {
  const first = boot()
  ok(typeof first.Card === 'function', '取到了真实分片里的卡片组件（不是复制品）')

  const tree = await first.mini.settle(first.Card, props)

  // ── 1. 出厂态：关着（顺带验「读回宿主值」）───────────────────────
  console.log('\n── 1. 出厂态 ──')
  ok(textOf(tree).indexOf('压缩前记忆提醒') >= 0, '标题在（用户能一眼找到这是哪个开关）')
  ok(byClass(tree, 'smem-modcard-head').length === 1, '卡头在')
  const status = byClass(tree, 'smem-modcard-status')[0]
  ok(!!status && /关闭/.test(textOf(status)), `默认显示「关闭」（实际「${textOf(status || {})}」）`)
  const notes = byClass(tree, 'smem-autodream-note').map(textOf).join('\n')
  ok(/只提醒/.test(notes), '说明里写清「只提醒、不代写」')
  ok(/立刻生效/.test(notes), '说明里写清「改完立刻生效」')
  ok(/69\.3/.test(notes), '说明里给出与面板对上读数的例子（69.3% → 提前 8 点）')

  const swBtn = byClass(tree, 'smem-switch')[0]
  ok(!!swBtn, '有开关按钮')
  ok(swBtn && swBtn.props['aria-label'] === '启用压缩前记忆提醒',
    `开关的可访问性标签就是那句文案（实际「${swBtn && swBtn.props['aria-label']}」）`)
  ok(swBtn && swBtn.props['aria-checked'] === 'false', '出厂态开关是关的（aria-checked=false）')
  const leadInput = byClass(tree, 'smem-input')[0]
  ok(!!leadInput && String(leadInput.props.value) === '8', `提前量默认 8（实际 ${leadInput && leadInput.props.value}）`)
  ok(leadInput && leadInput.props.min === 3 && leadInput.props.max === 20, '输入框标了 3–20 的边界')

  // ── 2. 点开关：写入 1 ─────────────────────────────────────────────
  console.log('\n── 2. 开关 ──')
  swBtn.props.onClick()
  await first.mini.settle(first.Card, props)
  ok(saves.length === 1 && saves[0].experimental && saves[0].experimental.preCompact === 1,
    '点开关写入 {experimental:{preCompact:1}}', JSON.stringify(saves[0]))
  const treeOn = await first.mini.settle(first.Card, props)
  const statusOn = byClass(treeOn, 'smem-modcard-status')[0]
  ok(/已开启/.test(textOf(statusOn)), `状态变「已开启」（实际「${textOf(statusOn || {})}」）`)

  // ── 3. 改提前量：写入 12 ───────────────────────────────────────────
  console.log('\n── 3. 提前量 ──')
  byClass(treeOn, 'smem-input')[0].props.onChange({ target: { value: '12' } })
  const treeEdit = await first.mini.settle(first.Card, props)
  const saveBtn = byClass(treeEdit, 'smem-btn-primary')[0]
  ok(!!saveBtn, '有保存按钮')
  saveBtn.props.onClick()
  await first.mini.settle(first.Card, props)
  ok(saves.length === 2 && saves[1].experimental && saves[1].experimental.preCompactLead === 12,
    '保存写入 {experimental:{preCompactLead:12}}', JSON.stringify(saves[1]))
  ok(saves[1].experimental.preCompact === undefined, '保存提前量不会顺手改开关（只写你改动的那一项）')

  // ── 4. 越界：本地先拦，不打一趟网络 ───────────────────────────────
  console.log('\n── 4. 越界 ──')
  const before = saves.length
  byClass(await first.mini.settle(first.Card, props), 'smem-input')[0].props.onChange({ target: { value: '25' } })
  const treeBad = await first.mini.settle(first.Card, props)
  byClass(treeBad, 'smem-btn-primary')[0].props.onClick()
  const treeErr = await first.mini.settle(first.Card, props)
  ok(saves.length === before, '越界值没发出去（本地拦住了）')
  ok(/⚠/.test(textOf(treeErr)), `给了错误提示（实际「${(textOf(treeErr).match(/⚠[^\u2713]*/) || ['?'])[0].slice(0, 40)}」）`)
  ok(String(byClass(treeErr, 'smem-input')[0].props.value) === '25', '越界时保留用户输入（不静默改回，免得以为存上了）')

  // ── 5. 重挂载：宿主里已经是开的 ────────────────────────────────────
  console.log('\n── 5. 重挂载读回宿主值 ──')
  settings = { mmr: 0, todoBoard: 0, preCompact: 1, preCompactLead: 5 }
  const second = boot()
  const treeLoaded = await second.mini.settle(second.Card, props)
  const statusLoaded = byClass(treeLoaded, 'smem-modcard-status')[0]
  ok(/已开启/.test(textOf(statusLoaded)) && /5/.test(textOf(statusLoaded)),
    `重新挂载后显示「已开启 · 提前 5 点」（实际「${textOf(statusLoaded || {})}」）`)
  ok(String(byClass(treeLoaded, 'smem-input')[0].props.value) === '5', '输入框跟着宿主值走')
  ok(byClass(treeLoaded, 'smem-switch')[0].props['aria-checked'] === 'true', '开关处于开态')

  console.log(`\n结果：${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
