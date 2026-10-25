/**
 * 客户端侧的「真执行」验证。
 *
 * 为什么必须做：client.js 是手写的 ModuleLoader bundle（非 ESM），`node --check` 只能证明
 * 它语法合法，证明不了「apply 跑得起来」和「它挂上去的 remote 描述符与宿主 manifest 对得上」。
 * 历史上踩过两次：`ctx.get("remote.<ns>")` 不会自动出现；一个坏的 typert manifest 拖垮整层。
 *
 * 做法：给它一个假的 window.__ModuleLoader__ 与假 react，把文件跑一遍，
 * 抓 factory → apply(fakeCtx) → 比较 $mount 收到的描述符与 typert.host.js 的 invocations。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const LIB = new URL('../lib/', import.meta.url)
const CLIENT = fileURLToPath(new URL('client.js', LIB))
const HOST = new URL('typert.host.js', LIB).href

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

// ── 1. 把 client.js 跑进一个受控环境 ──────────────────────────────────────────
const code = await readFile(CLIENT, 'utf8')
let loaded = null
const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { loaded = def } } },
  document: undefined,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Symbol,
  Object,
  Array,
  JSON,
  Math,
  Date,
  Map,
  Set,
  Promise,
  Error,
  String,
  Number,
  Boolean,
  RegExp,
  isNaN,
  parseInt,
  parseFloat,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

console.log('== 1. ModuleLoader 入口 ==')
let execErr = null
try {
  vm.runInContext(code, sandbox, { filename: 'client.js' })
} catch (e) {
  execErr = e
}
ok(!execErr, 'client.js 能在 ModuleLoader 环境下执行到 load()', execErr ? execErr.message : '')
ok(loaded !== null, 'window.__ModuleLoader__.load 被调用')
ok(loaded && loaded.id === 'sage-mem', `模块 id 是 sage-mem（实际 ${loaded && loaded.id}）`)

// ── 2. 跑 factory：假 react ──────────────────────────────────────────────────
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  Fragment: 'Fragment',
}
const requireFn = (name) => {
  if (name === 'react') return fakeReact
  // 其它依赖给一个「什么都答得上来」的代理，别让 factory 因为某个边缘 require 直接炸
  return new Proxy({}, { get: () => () => ({}) })
}

console.log('== 2. factory 与 apply ==')
let mod = null
let factoryErr = null
try {
  mod = loaded.factory(requireFn)
} catch (e) {
  factoryErr = e
}
ok(!factoryErr, 'factory(require) 跑通', factoryErr ? (factoryErr.stack || '').split('\n').slice(0, 3).join(' | ') : '')
ok(mod && typeof mod.apply === 'function', '导出标准 Cordis 插件（apply）')
ok(mod && Array.isArray(mod.inject), `inject 是数组（${mod && JSON.stringify(mod.inject)}）`)

const mounts = []
const slots = []
/** 当前真正挂着的槽位条目（register 的返回值会把它摘掉）—— 用来验「注销后不残留」。 */
const live = []
let panelCleared = false
/**
 * 假 locale 服务：只做一件真宿主会做的事 —— 把插件 register(ns, {zh, en}) 的字典收下来。
 * bind(ns) 返回的 t 在调用时才读 registered，所以注册与 bind 的先后顺序不影响结果。
 */
let registered = null
const locale = {
  register: (ns, dicts) => { registered = { ns, ...dicts }; return () => {} },
  bind: (ns) => (key, params) => {
    const dicts = registered && registered.ns === ns ? registered : null
    const tpl = dicts && (dicts.zh[key] ?? dicts.en[key])
    const text = tpl === undefined ? key : String(tpl)
    return params
      ? text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
      : text
  },
}
const ctx = {
  remote: { $mount: (m) => mounts.push(m) },
  slots: {
    inject: (name, cb) => {
      slots.push(['inject', name])
      let disposeEntry = null
      if (typeof cb === 'function') disposeEntry = cb()
      return () => { if (typeof disposeEntry === 'function') disposeEntry() }
    },
    register: (spec, comp) => {
      const rec = { spec, comp }
      slots.push(['register', spec && spec.name, spec && (spec.id || spec.key)])
      live.push(rec)
      return () => {
        const i = live.indexOf(rec)
        if (i >= 0) live.splice(i, 1)
      }
    },
  },
  // 返回会话走 layout.selectPanel(null)：给一个能记账的假服务。
  effect: (fn) => { fn() },
  get: (name) => (name === 'layout'
    ? { selectPanel: (panel) => { if (panel === null) panelCleared = true } }
    : name === 'locale' ? locale : undefined),
}
let applyErr = null
try {
  await mod.apply(ctx)
} catch (e) {
  applyErr = e
}
ok(!applyErr, 'apply(ctx) 跑通', applyErr ? (applyErr.stack || '').split('\n').slice(0, 4).join(' | ') : '')

// ── 2a. i18n 字典：注册到 settings.memory，zh/en 键集一致、en 无中日韩字符、没有死键 ──────
ok(!!registered && registered.ns === 'settings.memory', '注册了 locale 命名空间 settings.memory')
ok(!!registered && !!registered.zh && !!registered.en, 'zh / en 两本字典都注册了')
const zhKeys = registered ? Object.keys(registered.zh).sort() : []
const enKeys = registered ? Object.keys(registered.en).sort() : []
ok(zhKeys.length === enKeys.length && zhKeys.every((k, i) => k === enKeys[i]),
  'zh / en 字典键集完全一致', `zh=${zhKeys.length} en=${enKeys.length}`)
ok(enKeys.every((k) => !/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(registered.en[k])),
  'en 字典没有中日韩字符（含全角标点）',
  enKeys.filter((k) => /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(registered.en[k])).join(', '))
const unused = zhKeys.filter((k) => !code.includes('"' + k + '"'))
ok(unused.length === 0, '没有未被 t() 使用的死键（字典键都出现在 client 构建产物里）', unused.join(', '))
const usedKeys = [...new Set([...code.matchAll(/\bt\(\s*"([^"]+)"/g)].map((m) => m[1]))]
const missingKeys = usedKeys.filter((k) => !registered || !Object.prototype.hasOwnProperty.call(registered.zh, k))
ok(missingKeys.length === 0, '没有 t() 用了但字典里没有的键', missingKeys.join(', '))
ok(mounts.length >= 1, `调了 remote.$mount（${mounts.length} 次）`)
ok(slots.some((s) => s[0] === 'register' && s[1] === 'settings.section' && s[2] === 'sage-mem'), '注册了设置页 section「sage-mem」')

// ── 2b. 1.8.0 侧栏入口：两个槽位 + 图标 + 主区页面 + 返回会话 ──────────────────
const panRec = live.find((r) => r.spec && r.spec.name === 'sidebar.panellist' && r.spec.id === 'sage-mem')
const mainRec = live.find((r) => r.spec && r.spec.name === 'main' && r.spec.key === 'sage-mem')
ok(!!panRec, '注册了侧栏 list 槽 sidebar.panellist（id=sage-mem）')
ok(!!mainRec, '注册了中央主区 keyed 槽 main（key=sage-mem，与侧栏 id 相同）')
ok(!!panRec && panRec.spec.order === 20 && typeof panRec.spec.label === 'function'
  && panRec.spec.label() === '记忆管理',
  '侧栏条目的 order / label 正确（label 是每次投影都重读的 thunk）',
  JSON.stringify(panRec && { ...panRec.spec, label: typeof panRec.spec.label }))
ok(mod.inject.includes('slots') && mod.inject.includes('remote'), `inject 声明了 slots / remote：${JSON.stringify(mod.inject)}`)
// layout 是**可选**依赖：返回会话优先用宿主注入的 props.backToConversation，layout 只是兜底。
// 一旦写进 inject，旧外壳缺该服务时整个 client 插件都不会 apply（连设置页一起丢）。
ok(!mod.inject.includes('layout'), `inject 不把可选服务 layout 写成硬依赖：${JSON.stringify(mod.inject)}`)

/** 假 react 元素树的遍历 / 取文本（组件不执行，只看它返回了什么）。 */
const walkFake = (el, fn) => {
  if (!el || typeof el !== 'object') return
  if (Array.isArray(el)) { el.forEach((x) => walkFake(x, fn)); return }
  fn(el)
  ;(el.children || []).forEach((x) => walkFake(x, fn))
}
const textOf = (el) => {
  if (typeof el === 'string') return el
  if (!el || typeof el !== 'object') return ''
  if (Array.isArray(el)) return el.map(textOf).join('')
  return (el.children || []).map(textOf).join('')
}

// 图标：内联 SVG、currentColor（不引外部图片/字体）、尺寸跟 props.size 走
const icon = panRec ? panRec.comp({ size: 16 }) : null
ok(!!icon && icon.type === 'svg' && icon.props.viewBox === '0 0 16 16', '侧栏图标是一个内联 svg（viewBox 16）')
const iconStroked = []
walkFake(icon, (n) => { if (n.props && typeof n.props.stroke === 'string') iconStroked.push(n.props.stroke) })
ok(iconStroked.length >= 3 && iconStroked.every((s) => s === 'currentColor'),
  '图标全部用 currentColor 描边（跟随宿主主题）', JSON.stringify(iconStroked))
ok(panRec && panRec.comp({ size: 24 }).props.width === 24, '图标尺寸跟随宿主传入的 props.size')
// 1.8.2：字形与仓库根 icon.png 同源 —— 两张错开的记忆卡片（后一张低透明只描边）。
const iconRects = []
walkFake(icon, (n) => { if (n.type === 'rect') iconRects.push(n) })
ok(iconRects.length === 2 && iconRects.some((r) => r.props && r.props.opacity !== undefined),
  '图标字形是「叠层记忆卡片」：两张圆角卡，后一张只描边 / 低透明', JSON.stringify(iconRects.map((r) => r.props)))

// 主区页面：用 inject 面拿到的 backToConversation，点「返回会话」真的调 layout.selectPanel(null)
const face = mainRec && typeof mainRec.spec.inject === 'function' ? mainRec.spec.inject() : null
ok(!!face && typeof face.backToConversation === 'function', 'main 槽的 inject 面提供 backToConversation')
const page = mainRec ? mainRec.comp({ backToConversation: face.backToConversation }) : null
let backBtn = null
walkFake(page, (n) => { if (!backBtn && n.type === 'button' && textOf(n) === '返回会话') backBtn = n })
ok(!!page && page.props.className === 'smem-page', '主区页面是一个 smem-page 容器')
ok(!!backBtn, '页顶有「返回会话」按钮')
panelCleared = false
if (backBtn) backBtn.props.onClick()
ok(panelCleared === true, '点「返回会话」调了 layout.selectPanel(null)（主区还给会话）')

// ── 2c. 1.8.2 插件详情页的「侧栏入口」卡片（plugins.bundle.config）──────────
// 假 react 不执行组件，所以注册进来的 `(props) => h(Card, …)` 要自己再走一层。
const renderFake = (el) => (el && typeof el === 'object' && typeof el.type === 'function'
  ? renderFake(el.type(el.props || {}))
  : el)
const bundleCard = live.find((r) => r.spec && r.spec.name === 'plugins.bundle.config' && r.spec.key === 'sage-mem')
ok(!!bundleCard, '注册了插件页 bundle 配置槽 plugins.bundle.config（key=sage-mem，= 包名）')
ok(renderFake(bundleCard ? bundleCard.comp({ view: 'summary' }) : null) === null,
  '插件页的 summary 视图返回 null（不在摘要位重复渲染卡片）')
const pageCard = renderFake(bundleCard ? bundleCard.comp({ view: 'page' }) : null)
ok(!!pageCard && pageCard.props && pageCard.props.className === 'smem-plugin-card',
  '插件页的 page 视图渲染出 smem-plugin-card 卡片')
ok(textOf(pageCard).indexOf('侧栏入口') >= 0 && textOf(pageCard).indexOf('在侧栏显示「记忆管理」入口') >= 0,
  '卡片里有标题「侧栏入口」与开关文案')
ok(textOf(pageCard).indexOf('默认开启') >= 0 && textOf(pageCard).indexOf('设置 → 记忆管理') >= 0,
  '卡片说明写明默认开启、设置页入口保留')

// 旧宿主：该槽 0.1.7+ 才有，inject 直接抛错 —— apply 必须照常完成，设置页 / 侧栏入口一个都不能丢。
{
  const oldLive = []
  const oldCtx = {
    remote: { $mount() {} },
    slots: {
      inject(name, cb) {
        if (name === 'plugins.bundle.config') throw new Error('unknown slot: plugins.bundle.config')
        const disposeEntry = typeof cb === 'function' ? cb() : null
        return () => { if (typeof disposeEntry === 'function') disposeEntry() }
      },
      register(spec, comp) {
        const rec = { spec, comp }
        oldLive.push(rec)
        return () => {
          const i = oldLive.indexOf(rec)
          if (i >= 0) oldLive.splice(i, 1)
        }
      },
    },
    get: () => undefined,
  }
  const oldMod = loaded.factory(requireFn)
  let oldApplyErr = null
  try {
    await oldMod.apply(oldCtx)
  } catch (e) {
    oldApplyErr = e
  }
  ok(!oldApplyErr, '旧宿主没有 plugins.bundle.config 槽（inject 抛错）时 apply 不抛错',
    oldApplyErr ? (oldApplyErr.stack || '').split('\n').slice(0, 3).join(' | ') : '')
  ok(!!oldLive.find((r) => r.spec && r.spec.name === 'settings.section' && r.spec.id === 'sage-mem'),
    '旧宿主：设置页 section 照常注册（不被插件页卡片拖垮）')
  ok(!!oldLive.find((r) => r.spec && r.spec.name === 'sidebar.panellist' && r.spec.id === 'sage-mem'),
    '旧宿主：侧栏入口照常注册')
  ok(!oldLive.some((r) => r.spec && r.spec.name === 'plugins.bundle.config'),
    '旧宿主：没有 plugins.bundle.config 条目（静默跳过）')
}

// ── 3. 描述符对表：客户端挂的 vs 宿主 manifest ────────────────────────────────
console.log('== 3. 描述符对表 ==')
const { TYPERT } = await import(HOST)

/**
 * 从挂载物里找出描述符数组。
 * 客户端侧用的键名是 `descriptors`，宿主 manifest 用 `invocations` —— 形状一样、键名不同。
 */
function findInvocations(m) {
  if (!m || typeof m !== 'object') return null
  if (Array.isArray(m.invocations)) return m.invocations
  if (Array.isArray(m.descriptors)) return m.descriptors
  for (const v of Object.values(m)) {
    const hit = findInvocations(v)
    if (hit) return hit
  }
  return null
}

const clientInv = mounts.map(findInvocations).find((x) => Array.isArray(x) && x.length)
if (!clientInv) {
  const shape = (o, d = 0) => {
    if (d > 2 || !o || typeof o !== 'object') return typeof o
    if (Array.isArray(o)) return `[${o.length} × ${o.length ? shape(o[0], d + 1) : '?'}]`
    return `{${Object.keys(o).slice(0, 12).join(', ')}}`
  }
  console.log('       DEBUG $mount 参数形状:', shape(mounts[0]))
  if (mounts[0] && typeof mounts[0] === 'object') {
    for (const k of Object.keys(mounts[0]).slice(0, 12)) {
      console.log(`         .${k} = ${shape(mounts[0][k], 1)}`)
    }
  }
}
ok(!!clientInv, '在 $mount 的参数里找到 invocations 数组')
if (clientInv) {
  const hostInv = TYPERT.invocations
  const key = (i) => `${i.service || ''}|${i.method}`
  const clientMap = new Map(clientInv.map((i) => [key(i), i]))
  const hostMap = new Map(hostInv.map((i) => [key(i), i]))

  const clientAuto = clientInv.filter((i) => (i.service || i.namespace) === 'autodream')
  ok(clientAuto.length === 11, `客户端声明了 11 条 autodream 描述符（实际 ${clientAuto.length}）`)

  // 契约总数：memory 20（原 9 + audit / archiveCandidates / checkUpdate / getSettings /
  // setLocked / setSettings / readRaw / writeRaw + deleteArchived + openMemoryDir
  // + 1.7.0 的 recallDebug）+ starmap 2 + autodream 11 = 33。
  // v1.1.0 加 deleteArchived 之前是 30；下面每一条比对仍然是逐条严格比对。
  ok(clientInv.length === 33, `客户端声明了 33 条描述符（实际 ${clientInv.length}）`)
  ok(hostInv.length === 33, `宿主 manifest 也是 33 条 invocation（实际 ${hostInv.length}）`)

  const missing = [...hostMap.keys()].filter((k) => !clientMap.has(k))
  const extra = [...clientMap.keys()].filter((k) => !hostMap.has(k))
  ok(missing.length === 0, '宿主有的方法客户端都声明了', `缺：${missing.join(', ')}`)
  ok(extra.length === 0, '客户端没有多声明宿主不存在的方法', `多：${extra.join(', ')}`)

  // 参数：名字 / wire / 参数个数
  let paramMismatch = []
  for (const [k, h] of hostMap) {
    const c = clientMap.get(k)
    if (!c) continue
    const hp = (h.parameters || []).map((p) => `${p.name}:${p.wire}`)
    const cp = (c.parameters || []).map((p) => `${p.name}:${p.wire}`)
    if (JSON.stringify(hp) !== JSON.stringify(cp)) paramMismatch.push(`${k} 宿主[${hp}] vs 客户端[${cp}]`)
  }
  ok(paramMismatch.length === 0, '每条方法的参数名与 wire 一致', paramMismatch.join('\n       '))

  // typeSymbol 一致性（宿主与客户端必须同名，否则 strict 类型解析会错位）
  let typeMismatch = []
  for (const [k, h] of hostMap) {
    const c = clientMap.get(k)
    if (!c) continue
    const hs = h.result && h.result.typeSymbol
    const cs = c.result && c.result.typeSymbol
    if (hs !== cs) typeMismatch.push(`${k}：宿主 ${hs} vs 客户端 ${cs}`)
    const hp = (h.parameters || []).map((p) => p.codec && p.codec.typeSymbol)
    const cp = (c.parameters || []).map((p) => p.codec && p.codec.typeSymbol)
    if (JSON.stringify(hp) !== JSON.stringify(cp)) typeMismatch.push(`${k} 入参 typeSymbol：宿主 ${hp} vs 客户端 ${cp}`)
  }
  ok(typeMismatch.length === 0, 'result/parameter 的 typeSymbol 逐条一致', typeMismatch.join('\n       '))

  // mode 也必须逐条对齐：任何一侧悄悄把 strict 退化成宽松模式，都要在这里现形。
  let modeMismatch = []
  for (const [k, h] of hostMap) {
    const c = clientMap.get(k)
    if (!c) continue
    const hm = h.result && h.result.mode
    const cm = c.result && c.result.mode
    if (hm !== 'strict' || cm !== 'strict') modeMismatch.push(`${k}：宿主 ${hm} vs 客户端 ${cm}`)
    const hp = (h.parameters || []).map((p) => p.codec && p.codec.mode)
    const cp = (c.parameters || []).map((p) => p.codec && p.codec.mode)
    if (JSON.stringify(hp) !== JSON.stringify(cp)) modeMismatch.push(`${k} 入参 mode：宿主 ${hp} vs 客户端 ${cp}`)
  }
  ok(modeMismatch.length === 0, 'result/parameter 的 mode 逐条 strict 且两侧一致', modeMismatch.join('\n       '))
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
