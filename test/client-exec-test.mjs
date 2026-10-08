/**
 * 客户端 half 的「真执行」验证（主殿自用）。
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
const ctx = {
  remote: { $mount: (m) => mounts.push(m) },
  slots: {
    inject: (name, cb) => { slots.push(['inject', name]); if (typeof cb === 'function') cb() },
    register: (spec, comp) => { slots.push(['register', spec && spec.id]); return () => {} },
  },
  get: () => undefined,
}
let applyErr = null
try {
  await mod.apply(ctx)
} catch (e) {
  applyErr = e
}
ok(!applyErr, 'apply(ctx) 跑通', applyErr ? (applyErr.stack || '').split('\n').slice(0, 4).join(' | ') : '')
ok(mounts.length >= 1, `调了 remote.$mount（${mounts.length} 次）`)
ok(slots.some((s) => s[0] === 'register' && s[1] === 'sage-mem'), '注册了设置页 section「sage-mem」')

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
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
