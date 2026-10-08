/**
 * sage-mem 客户端 UI 的**真执行渲染**测试（仓库内，随 npm test 一起跑）。
 *
 * 为什么要有它：client-exec-test 只证明「apply 跑得起来、描述符对得上」，
 * 证明不了「界面真的渲染出该有的东西、点了真的有反应」。这个脚本把组件树真的跑起来：
 *   - 副作用真的执行（Section 的 load() 会去打假 remote，promise 回来后 setState 再渲染）
 *   - 点击真的走 onClick（视图切换 / 归档 / 恢复 / 星图开关 / 工具抽屉 / 二级分组 / 画布命中）
 *   - canvas2d 兜底渲染器真的跑（假 2d context 记录每次 arc 的圆心/半径/alpha），
 *     用来断言「归档星只画一个暗点、没有辉光」以及「点得中」
 *
 * 做法：vm 里跑 lib/client.js（假 window.__ModuleLoader__ / 假 react / 假 document），
 * apply(ctx) 拿到注册的 Section 组件，再用一套带 state 与 effect 的迷你 react 渲染。
 *
 * 用法：node test/client-render-test.mjs
 *       node test/client-render-test.mjs --preview   # 额外把静态预览写进
 *                                                    # $SAGE_MEM_PREVIEW_DIR（默认系统临时目录）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')) }
}
const group = (t) => console.log('\n── ' + t + ' ──')

// ════════════════════════════════════════════════════════════════════════════
// 迷你 react：hooks 按调用序存，effect 带依赖比对；setState 让调和循环再跑一轮。
// ════════════════════════════════════════════════════════════════════════════
function makeReact(nodeFactory = makeFakeNode) {
  const stateStore = new Map()
  const effectStore = new Map()
  const refStore = new Map()
  const nodeCache = new Map() // 宿主节点（canvas 之类）按渲染路径复用，避免 ref 反复换对象
  let n = 0
  let dirty = false
  let pending = []

  const api = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(init) {
      const i = n++
      if (!stateStore.has(i)) stateStore.set(i, typeof init === 'function' ? init() : init)
      const set = (v) => {
        const cur = stateStore.get(i)
        const nv = typeof v === 'function' ? v(cur) : v
        if (nv !== cur) { stateStore.set(i, nv); dirty = true }
      }
      return [stateStore.get(i), set]
    },
    useEffect(fn, deps) { pending.push({ i: n++, fn, deps }) },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    // ref 必须跨渲染保持同一个对象（真实 react 语义）：星图的 visBox/drawBox 靠它传状态
    useRef(init) {
      const i = n++
      if (!refStore.has(i)) refStore.set(i, { current: init })
      return refStore.get(i)
    },
    Fragment: 'Fragment',
  }

  function flattenKids(arr) {
    const out = []
    for (const x of arr) {
      if (Array.isArray(x)) out.push(...flattenKids(x))
      else out.push(x)
    }
    return out
  }

  function expand(el, path) {
    if (el === null || el === undefined || el === false || el === true) return el
    if (typeof el !== 'object') return el
    if (Array.isArray(el)) return el.map((x, i) => expand(x, path + '.' + i))
    if (typeof el.type === 'function') return expand(el.type(el.props || {}), path)
    const props = el.props || {}
    // 宿主元素：有 ref 就给一个稳定的假节点（canvas 需要 getContext / getBoundingClientRect）
    if (typeof props.ref === 'function') {
      if (!nodeCache.has(path)) nodeCache.set(path, nodeFactory())
      props.ref(nodeCache.get(path))
    }
    const kids = flattenKids(el.children || []).filter((k) => k !== null && k !== undefined && k !== false && k !== true)
    return { type: el.type, props, children: kids.map((k, i) => expand(k, path + '.' + i)) }
  }

  function runEffects() {
    const list = pending
    pending = []
    for (const e of list) {
      const prev = effectStore.get(e.i)
      const changed = !prev || !e.deps || !prev.deps || e.deps.length !== prev.deps.length ||
        e.deps.some((d, k) => d !== prev.deps[k])
      if (!changed) continue
      if (prev && typeof prev.cleanup === 'function') prev.cleanup()
      const cleanup = e.fn()
      effectStore.set(e.i, { deps: e.deps, cleanup })
    }
  }

  const rafQueue = []
  const flushRaf = () => {
    const q = rafQueue.splice(0, rafQueue.length)
    for (const fn of q) fn(Date.now())
  }

  /** 反复「渲染 → 跑 effect → 让 promise 落地」，直到没有新的 setState。 */
  async function settle(comp, props, maxPasses = 40) {
    let tree = null
    for (let k = 0; k < maxPasses; k++) {
      dirty = false
      n = 0
      pending = []
      tree = expand(comp(props), 'root')
      runEffects()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      if (!dirty) return tree
    }
    throw new Error('settle 未收敛（组件一直在 setState）')
  }

  return {
    api, settle, flushRaf, nodeCache, stateStore,
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length },
    cancelAnimationFrame: () => {},
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 假 DOM / 假 remote
// ════════════════════════════════════════════════════════════════════════════
function make2dCtx() {
  const ctx = {
    arcs: [], renders: 0, rects: 0,
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() { ctx.renders++ }, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, fillRect() { ctx.rects++ }, clearRect() {},
    createLinearGradient() { return { addColorStop() {} } },
    createRadialGradient() { return { addColorStop() {} } },
    arc(x, y, r) { ctx.arcs.push({ x, y, r, render: ctx.renders, alpha: ctx.globalAlpha, fill: String(ctx.fillStyle), stroke: String(ctx.strokeStyle) }) },
  }
  return ctx
}

function makeFakeNode() {
  const node = {
    width: 0, height: 0, ctx2d: null,
    // webgl 返回 null → 走 canvas2d 兜底，这样每一次 arc 都能被记录
    getContext(kind) {
      if (kind === 'webgl') return null
      if (!node.ctx2d) node.ctx2d = make2dCtx()
      return node.ctx2d
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 940, height: 520, right: 940, bottom: 520 }),
    addEventListener() {}, removeEventListener() {},
  }
  return node
}

/** 假 WebGL：让主路径（不是兜底）也被真跑一遍，并记录 shader 源码与顶点数据。 */
function makeFakeGl() {
  const gl = {
    _shaders: [], _bufferData: [], _draws: 0,
    createShader: (t) => ({ type: t, src: '' }),
    shaderSource: (s, src) => { s.src = src; gl._shaders.push(s) },
    compileShader() {}, getShaderParameter: () => true, getShaderInfoLog: () => '',
    createProgram: () => ({}), attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => '',
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    createBuffer: () => ({}), bindBuffer() {},
    bufferData: (target, data) => { gl._bufferData.push(data ? Array.from(data) : []) },
    enableVertexAttribArray() {}, vertexAttribPointer() {}, drawArrays() { gl._draws++ },
    disable() {}, enable() {}, blendFunc() {}, useProgram() {},
    uniform1f() {}, uniform2f() {}, viewport() {},
    deleteBuffer() {}, deleteProgram() {}, getExtension: () => null,
    ARRAY_BUFFER: 34962, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048, FLOAT: 5126,
    TRIANGLES: 4, LINES: 1, SRC_ALPHA: 770, ONE: 1, BLEND: 3042,
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713, LINK_STATUS: 35714,
  }
  return gl
}

function makeGlNode() {
  const gl = makeFakeGl()
  return {
    gl,
    width: 0, height: 0,
    getContext: (kind) => (kind === 'webgl' ? gl : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 940, height: 520, right: 940, bottom: 520 }),
    addEventListener() {}, removeEventListener() {},
  }
}

/** 把 uploadStars 写进 GPU 的顶点摊平：每个顶点 13 个 float。 */
function parseVerts(gl) {
  const out = []
  for (const arr of gl._bufferData) {
    if (!arr.length || arr.length % 13 !== 0) continue
    for (let i = 0; i < arr.length; i += 13) {
      out.push({
        cx: arr[i + 2], cy: arr[i + 3], r: arr[i + 4], a: arr[i + 8],
        fresh: arr[i + 10], idx: arr[i + 11], birth: arr[i + 12],
      })
    }
  }
  return out
}

function makeMemoryRemote(active, archived, raw) {
  const st = {
    active: active.map((x) => ({ ...x })), archived: archived.map((x) => ({ ...x })),
    calls: [], raw: { ...(raw || {}) },
    audit: null, cand: null, settings: null,
  }
  return {
    st,
    listFiles() { st.calls.push(['listFiles']); return Promise.resolve(st.active) },
    listArchived() {
      st.calls.push(['listArchived'])
      return Promise.resolve({ count: st.archived.length, files: st.archived })
    },
    audit() {
      st.calls.push(['audit'])
      return Promise.resolve(st.audit || {
        dir: '/tmp/memory', fileCount: 0, skipped: [], archivedCount: 0, indexEntries: 0, problems: 0,
        dangling: [], unlisted: [], typeMismatch: [], crlf: [], brokenLinks: [], archivedLinks: [],
        hashHazards: [], noFrontmatter: [], unreadable: [],
      })
    },
    archiveCandidates() {
      st.calls.push(['archiveCandidates'])
      return Promise.resolve(st.cand || { count: 0, candidates: [], autoArchive: 'report', thresholds: { project: 90, reference: 180, user: 365 } })
    },
    getSettings() {
      st.calls.push(['getSettings'])
      return Promise.resolve(st.settings || { limits: {}, pendingLimits: {}, restartRequired: false, reserved: ['memory.md', 'session-log.md'], reservedExtra: [] })
    },
    setSettings(patch) {
      st.calls.push(['setSettings', patch])
      const cur = st.settings || { limits: {}, pendingLimits: {}, restartRequired: false, reserved: ['memory.md', 'session-log.md'], reservedExtra: [] }
      const next = JSON.parse(JSON.stringify(cur))
      if (patch && patch.limits) {
        next.pendingLimits = Object.assign({}, next.pendingLimits, patch.limits)
        next.restartRequired = true
      }
      if (patch && Array.isArray(patch.reserved)) {
        next.reservedExtra = patch.reserved.slice()
        next.reserved = ['memory.md', 'session-log.md'].concat(patch.reserved.map((x) => String(x).toLowerCase()))
        next.restartRequired = true
      }
      st.settings = next
      return Promise.resolve({ ok: true, settings: next, restartRequired: true })
    },
    readRaw(name) {
      st.calls.push(['readRaw', name])
      if (!(name in st.raw)) return Promise.reject(new Error('ENOENT: no such file or directory: ' + name))
      return Promise.resolve({ name, content: st.raw[name] })
    },
    writeRaw(name, content) {
      // 原样记录交回来的内容：测试要比对「逐字节一致」
      st.calls.push(['writeRaw', name, content])
      st.raw[name] = content
      return Promise.resolve({ ok: true, file: name })
    },
    readArchived(name) {
      st.calls.push(['readArchived', name])
      if (!(name in st.raw)) return Promise.reject(new Error('sage-mem: archived file not found: ' + name))
      return Promise.resolve({ name, content: st.raw[name] })
    },
    writeArchived(name, content) {
      // 原样记录交回来的内容：测试要比对「一字不差」
      st.calls.push(['writeArchived', name, content])
      st.raw[name] = content
      return Promise.resolve({ ok: true, file: name })
    },
    archive(name, reason) {
      st.calls.push(['archive', name, reason])
      const i = st.active.findIndex((x) => x.file === name)
      if (i < 0) return Promise.resolve({ ok: false, error: 'sage-mem: file not found: ' + name })
      const [it] = st.active.splice(i, 1)
      st.archived.unshift({ ...it, archivedAt: '2026-10-08 21:00', archivedReason: reason || '手动归档' })
      return Promise.resolve({ ok: true, file: name })
    },
    restore(name) {
      st.calls.push(['restore', name])
      const i = st.archived.findIndex((x) => x.file === name)
      if (i < 0) return Promise.resolve({ ok: false, error: 'sage-mem: not archived: ' + name })
      const [it] = st.archived.splice(i, 1)
      const rest = { ...it }
      delete rest.archivedAt
      delete rest.archivedReason
      st.active.unshift(rest)
      return Promise.resolve({ ok: true, file: name })
    },
    readFile() { return Promise.resolve({ content: '# x' }) },
  }
}

function makeAutodreamRemote() {
  const st = {
    calls: [],
    // 'ignoreAutoArchive' = 模拟「setConfig 静默忽略了这次改动、值没变」那条路
    ignoreAutoArchive: false,
    config: {
      enabled: true, trigger: 'manual', apply: false, source: 'memory',
      autoArchive: 'report', provider: '', model: '',
    },
  }
  return {
    st,
    status() {
      st.calls.push(['status'])
      return Promise.resolve({ running: false, phase: '', config: { ...st.config }, route: null })
    },
    getConfig() {
      st.calls.push(['getConfig'])
      return Promise.resolve({ config: { ...st.config }, route: null })
    },
    setConfig(p) {
      st.calls.push(['setConfig', p])
      if (!st.ignoreAutoArchive) Object.assign(st.config, p)
      return Promise.resolve({ config: { ...st.config } })
    },
    listReports() { return Promise.resolve([]) },
    listSnapshots() { return Promise.resolve([]) },
    listRuns() { return Promise.resolve([]) },
    listModels() { return Promise.resolve({ catalogAvailable: false, routes: [], note: '' }) },
    runNow() { return Promise.resolve({ ok: true }) },
    readReport() { return Promise.resolve({ content: '' }) },
    readDeclaration() { return Promise.resolve({ markdown: '' }) },
    rollback() { return Promise.resolve({ ok: true }) },
  }
}

function makeStarmapRemote(mem, meta) {
  const st = { calls: [], reads: [] }
  const starOf = (f, archived) => {
    const m = meta[f.file] || {}
    const s = {
      file: f.file,
      kind: m.kind || 'special',
      title: m.title || f.file,
      desc: m.desc || '',
      bytes: f.size || 0,
      mtimeMs: m.mtimeMs || Date.now(),
      archived: archived === true,
    }
    // 归档留痕只对归档星出现 —— 与宿主 listStars 的形状一致
    if (s.archived) { s.archivedAt = f.archivedAt; s.archivedReason = f.archivedReason }
    return s
  }
  return {
    st,
    // 星表直接从记忆 remote 的当前状态推导：归档/恢复之后星图跟着变，跟宿主一致
    listStars(includeArchived) {
      st.calls.push(includeArchived)
      const stars = mem.st.active.map((f) => starOf(f, false))
      if (includeArchived === true) stars.push(...mem.st.archived.map((f) => starOf(f, true)))
      return Promise.resolve({ count: stars.length, stars })
    },
    readFile(name) {
      st.reads.push(name)
      return Promise.resolve({ name, content: '# ' + name })
    },
  }
}

const fakeDoc = {
  hidden: false,
  _created: [],
  // 文档级监听按类型记账：抽屉的「点外部 / Esc 关闭」只有真的挂上监听才可能被断言到，
  // 也才能断言「关着时一个监听都不挂」（否则点外部关闭就会变成点哪儿都没反应）。
  _listeners: {},
  addEventListener(type, fn) {
    const k = String(type)
    fakeDoc._listeners[k] = fakeDoc._listeners[k] || []
    fakeDoc._listeners[k].push(fn)
  },
  removeEventListener(type, fn) {
    const a = fakeDoc._listeners[String(type)] || []
    const i = a.indexOf(fn)
    if (i >= 0) a.splice(i, 1)
  },
  /** 测试用：模拟一次文档级事件（点外部 / 按 Esc）。 */
  fire(type, ev) {
    const a = (fakeDoc._listeners[String(type)] || []).slice()
    a.forEach((fn) => fn(ev || {}))
    return a.length
  },
  listenerCount(type) { return (fakeDoc._listeners[String(type)] || []).length },
  querySelector() { return null },
  createElement() { const el = { dataset: {}, style: {}, textContent: '' }; fakeDoc._created.push(el); return el },
  head: { appendChild() {} },
}
const capturedCss = []

async function loadClient(rt, remotes) {
  const code = readFileSync(CLIENT, 'utf8')
  let loaded = null
  // 每个运行时都从一份干净的 document 记录开始：监听表与注入记录不许跨运行时串。
  // （--preview 会先跑好几遍渲染，若不清，section 14 那句「关着时不挂监听」就会拿到
  //   上一轮残留的监听 —— 那是量具的脏，不是产品的错。）
  fakeDoc._listeners = {}
  fakeDoc._created = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (def) => { loaded = def } },
      requestAnimationFrame: rt.requestAnimationFrame,
      cancelAnimationFrame: rt.cancelAnimationFrame,
    },
    document: fakeDoc,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Symbol, Object, Array, JSON, Math, Date, Map, Set, Promise, Error,
    String, Number, Boolean, RegExp, isNaN, parseInt, parseFloat,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: CLIENT })
  const requireFn = (name) => (name === 'react' ? rt.api : new Proxy({}, { get: () => () => ({}) }))
  const mod = loaded.factory(requireFn)
  const mounts = []
  const regs = []
  const ctx = {
    remote: { $mount: (m) => mounts.push(m) },
    slots: {
      inject: (name, cb) => { if (typeof cb === 'function') cb() },
      register: (spec, comp) => { regs.push({ spec, comp }); return () => {} },
    },
    // 注册组件是 `(props) => react.createElement(Section, { ...props, ctx })`：
    // ctx 在 apply 时就闭包进去了，所以 remote 只能从这里给。
    get: (name) => (remotes ? remotes[String(name).replace(/^remote\./, '')] : undefined),
  }
  await mod.apply(ctx)
  // 面板与星图的 CSS 都是模块里 injectCss / apply 注入的：这里顺手留一份给静态预览
  for (const el of fakeDoc._created) {
    if (el.textContent && capturedCss.indexOf(el.textContent) < 0) capturedCss.push(el.textContent)
  }
  const comp = regs.find((r) => r.spec && r.spec.id === 'sage-mem').comp
  return { comp, mounts, regs }
}

// ════════════════════════════════════════════════════════════════════════════
// 静态预览用：把渲染出来的元素树写成 HTML（只给「归档视图 + 星图暗星」两块走查）
// ════════════════════════════════════════════════════════════════════════════
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function serHtml(el) {
  if (el === null || el === undefined || el === false || el === true) return ''
  if (typeof el === 'string' || typeof el === 'number') return esc(el)
  if (Array.isArray(el)) return el.map(serHtml).join('')
  const p = el.props || {}
  const tag = el.type
  const attrs = []
  if (p.className) attrs.push('class="' + esc(p.className) + '"')
  if (p.placeholder) attrs.push('placeholder="' + esc(p.placeholder) + '"')
  if (p.value !== undefined && p.value !== null && p.value !== '') attrs.push('value="' + esc(p.value) + '"')
  if (p.title) attrs.push('title="' + esc(p.title) + '"')
  if (p['aria-pressed'] !== undefined) attrs.push('aria-pressed="' + esc(p['aria-pressed']) + '"')
  if (p['data-on'] !== undefined) attrs.push('data-on="' + esc(p['data-on']) + '"')
  if (p.open === true) attrs.push('open')
  if (p.type) attrs.push('type="' + esc(p.type) + '"')
  else if (tag === 'button') attrs.push('type="button"')
  if (p.checked) attrs.push('checked')
  if (p.disabled) attrs.push('disabled')
  if (tag === 'canvas') return '<canvas ' + attrs.join(' ') + ' width="940" height="520"></canvas>'
  if (tag === 'input') return '<input ' + attrs.join(' ') + '>'
  if (tag === 'textarea') return '<textarea ' + attrs.join(' ') + '>' + esc(p.value || '') + '</textarea>'
  return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + (el.children || []).map(serHtml).join('') + '</' + tag + '>'
}

// ════════════════════════════════════════════════════════════════════════════
// 树查询工具
// ════════════════════════════════════════════════════════════════════════════
function walk(el, fn) {
  if (el === null || el === undefined || typeof el !== 'object') return
  if (Array.isArray(el)) { el.forEach((x) => walk(x, fn)); return }
  fn(el)
  ;(el.children || []).forEach((x) => walk(x, fn))
}
function textOf(el) {
  if (el === null || el === undefined || typeof el !== 'object') return typeof el === 'string' ? el : ''
  if (Array.isArray(el)) return el.map(textOf).join('')
  return (el.children || []).map(textOf).join('')
}
function all(root, pred) {
  const out = []
  walk(root, (n) => { if (n.type && pred(n)) out.push(n) })
  return out
}
const byClass = (cls) => (n) => String((n.props && (n.props.className || n.props.class)) || '').split(/\s+/).indexOf(cls) >= 0
/** 按钮：文案**完全相等**（「归档」不能匹配到「已归档」chip）。 */
const btn = (root, text) => all(root, (n) => n.type === 'button' && textOf(n) === text)
/** 按钮：文案包含。 */
const btnHas = (root, text) => all(root, (n) => n.type === 'button' && textOf(n).indexOf(text) >= 0)
const findText = (root, text) => {
  let hit = null
  walk(root, (n) => { if (!hit && n.type && typeof n.type === 'string' && textOf(n).indexOf(text) >= 0) hit = n })
  return hit
}
const treeText = (root) => textOf(root)
/** 按 key 找一张卡（自动做梦 / 事实上的稳定锚点）。 */
const cardByKeyOf = (t, k) => all(t, (n) => n.props && n.props.key === k)[0]
/**
 * B3 之后三个工具入口都收进了「工具 ▾」抽屉：
 * 关着时零占位（入口不在 DOM 里），点开才出现。这两个小工具函数把这一步收在一处。
 */
const drawerItem = (tree, label) => all(tree, (n) => n.type === 'button' && byClass('smem-drawer-item')(n) && textOf(n).indexOf(label) === 0)[0]
async function openDrawer(rt, C, tree) {
  click(btnHas(tree, '工具')[0])
  return rt.settle(C, {})
}
/** 抽屉里点开某个工具（内含「打开抽屉 → 点条目」两步）。 */
async function openTool(rt, C, tree, label) {
  let t = await openDrawer(rt, C, tree)
  click(drawerItem(t, label))
  return rt.settle(C, {})
}
/** 自动做梦的二级分段。 */
const segTab = (tree, label) => all(tree, (n) => n.type === 'button' && byClass('smem-subtab')(n) && textOf(n).indexOf(label) === 0)[0]
async function gotoSeg(rt, C, tree, label) {
  click(segTab(tree, label))
  return rt.settle(C, {})
}

function click(el) {
  if (!el) throw new Error('click: 元素不存在')
  if (typeof el.props.onClick !== 'function') throw new Error('click: 元素没有 onClick（' + el.type + '）')
  return el.props.onClick({ target: el, currentTarget: el, stopPropagation() {}, preventDefault() {} })
}
function typeInto(el, value) {
  if (!el) throw new Error('typeInto: 元素不存在')
  el.props.onChange({ target: { value } })
}

// ════════════════════════════════════════════════════════════════════════════
// 假数据
// ════════════════════════════════════════════════════════════════════════════
const ACTIVE = [
  { file: 'user_alpha.md', type: 'user', description: '甲：用户偏好', size: 1200, tags: ['用户'] },
  { file: 'project_beta.md', type: 'project', description: '乙：进行中的项目', size: 3400, tags: ['项目', 'dsh'] },
  { file: 'reference_gamma.md', type: 'reference', description: '丙：外部资料指针', size: 800, tags: ['参考'] },
]
const ARCHIVED = [
  { file: 'feedback_old.md', type: 'feedback', description: '丁：已被推翻的反馈', size: 640, tags: ['归档'], archivedAt: '2026-10-01 09:30', archivedReason: '结论已被 project_beta 取代' },
  { file: 'project_dead.md', type: 'project', description: '戊：停掉的项目', size: 900, tags: ['项目'], archivedAt: '2026-09-20 18:05', archivedReason: '手动归档' },
]
// 归档文件的**原始全文**：带自定义字段（重建式编辑器会吞掉它）与两行归档留痕。
// 一字不改地喂进去 / 一字不改地比出来，就是 R4 的验收判据。
const RAW_ARCHIVED = {
  'feedback_old.md': '---\nname: "feedback_old"\ndescription: "丁：已被推翻的反馈"\nmetadata:\n  node_type: memory\n  type: feedback\n  custom_field: keep-me\narchived_at: 2026-10-01 09:30\narchived_reason: \'结论已被 project_beta 取代\'\n---\n\n# 丁\n\n正文最后一行。\n',
}

// 保留名的**原始全文**：带 frontmatter 注释、baseline 与 archived_at 这类
// 「重建式编辑器一定会吞掉」的东西。逐字节比进出，就是原样编辑的判据。
const RAW_RESERVED = {
  'memory.md': '// 这份索引是手写的，注释也要留住\n---\nname: "MEMORY"\nbaseline: true\ncustom_field: keep-me\narchived_at: 2026-01-02 03:04\n---\n\n# 记忆索引\n\n- [[user_alpha]]\n- [[project_beta]]\n',
}

const AUDIT_WITH_PROBLEMS = {
  dir: '/tmp/memory', fileCount: 12, skipped: ['session-log.md'], archivedCount: 2, indexEntries: 9, problems: 4,
  dangling: [{ file: 'dangling_one.md' }, { file: 'dangling_two.md' }],
  unlisted: [{ file: 'unlisted_one.md' }],
  typeMismatch: [],
  crlf: [],
  brokenLinks: [{ file: 'project_beta.md', target: 'not_there' }],
  // 指向归档 = 提示，不计入 problems
  archivedLinks: [{ file: 'reference_gamma.md', target: 'feedback_old' }],
  hashHazards: [],
  noFrontmatter: [],
  unreadable: [],
}

const AUDIT_CLEAN = {
  dir: '/tmp/memory', fileCount: 12, skipped: [], archivedCount: 2, indexEntries: 12, problems: 0,
  dangling: [], unlisted: [], typeMismatch: [], crlf: [], brokenLinks: [], archivedLinks: [],
  hashHazards: [], noFrontmatter: [], unreadable: [],
}

const CANDIDATES = {
  count: 2,
  autoArchive: 'report',
  thresholds: { project: 90, reference: 180, user: 365 },
  // 候选指向**活动**里的文件：执行归档才会真的把它们移进档案馆
  candidates: [
    { file: 'project_beta.md', type: 'project', days: 212, limit: 90, reason: '已 212 天未被注入（project 阈值 90 天）' },
    { file: 'reference_gamma.md', type: 'reference', days: 190, limit: 180, reason: '已 190 天未被注入（reference 阈值 180 天）' },
  ],
}

// 注入设置的假数据：当前生效 10、重启后 12（故意留一处差别），并有待生效标记
const LIMITS_FIXTURE = {
  limits: { maxResults: 10, maxChars: 1500, maxBaseline: 8, maxSessionBytes: 61440, staleDays: 1 },
  pendingLimits: { maxResults: 12, maxChars: 1500, maxBaseline: 8, maxSessionBytes: 61440, staleDays: 2 },
  restartRequired: true,
  reserved: ['memory.md', 'session-log.md', 'project_notes.md'],
  reservedExtra: ['project_notes.md'],
}

const STAR_META = {  'user_alpha.md': { kind: 'user', title: '甲', desc: '用户偏好', mtimeMs: Date.now() - 86400000 },
  'project_beta.md': { kind: 'project', title: '乙', desc: '项目', mtimeMs: Date.now() - 3 * 86400000 },
  'reference_gamma.md': { kind: 'reference', title: '丙', desc: '资料', mtimeMs: Date.now() - 5 * 86400000 },
  'feedback_old.md': { kind: 'feedback', title: '丁', desc: '旧反馈', mtimeMs: Date.now() - 30 * 86400000 },
  'project_dead.md': { kind: 'project', title: '戊', desc: '停掉的项目', mtimeMs: Date.now() - 40 * 86400000 },
}

/**
 * 星图 demo 用的假数据（**只有静态稿用它**，不参与任何断言）。
 *
 * 为什么单独一份：星位是渲染器按数据算的，星星太少时右侧详情面板会把它们全遮住 ——
 * 9 活 + 4 归档时左侧可见区有 3 颗亮星（亮像素约 115），星野才撑得起来。
 * 位置一个都没手挑，全是渲染器的输出。
 */
const STAR_DEMO = (() => {
  const KINDS = ['user', 'project', 'reference', 'feedback']
  const BYTES = [2600, 3400, 1800, 6200, 4200, 3000, 5100, 2400, 4600, 2900, 5800, 3300, 4400]
  const active = []
  const archived = []
  const meta = {}
  let i = 0
  const mk = (kind, k, isArch) => {
    const file = 'demo_' + kind + '_' + String(k).padStart(2, '0') + '.md'
    const it = { file, size: BYTES[i % BYTES.length], mtimeMs: Date.now() - i * 86400000 }
    if (isArch) { it.archivedAt = '2026-10-01 09:30'; it.archivedReason = '演示：结论已被新条目取代' }
    i++
    meta[file] = { kind, title: '演示 ' + k, desc: '演示条目', mtimeMs: it.mtimeMs }
    return it
  }
  for (let k = 0; k < 9; k++) active.push(mk(KINDS[k % KINDS.length], k, false))
  for (let k = 0; k < 4; k++) archived.push(mk(KINDS[(k + 1) % KINDS.length], k, true))
  return { active, archived, meta }
})()

/**
 * 把**真渲染器**最后一帧画过的星抓出来（同心的多条 arc 取最小半径那条为核心），
 * 交给预览页回放 —— 星位/半径/颜色都是产品算的，不是手挑的。
 */
function starReplay(rt) {
  rt.flushRaf()
  const node = [...rt.nodeCache.values()].find((nd) => nd.ctx2d)
  const arcs = node ? node.ctx2d.arcs : []
  const last = arcs.reduce((m, a) => Math.max(m, a.render), 0)
  const byCenter = new Map()
  for (const a of arcs) {
    if (a.render !== last || !/^#|^rgb\(/.test(String(a.fill)) || !(a.r >= 1)) continue
    const k = Math.round(a.x) + ',' + Math.round(a.y)
    if (!byCenter.has(k) || a.r < byCenter.get(k).r) byCenter.set(k, a)
  }
  return [...byCenter.values()].map((a) => ({
    x: Math.round(a.x), y: Math.round(a.y), r: Number(a.r.toFixed(2)),
    f: String(a.fill), a: Number(Number(a.alpha).toFixed(2)),
  }))
}

/** 把回放数据塞进那一屏的 HTML（只有星图两屏有）。 */
function replayTag(replay) {
  return '<script>window.__SMAP_REPLAY__ = ' + JSON.stringify(replay) + ';</script>'
}

/**
 * 图**里面**那行短说明（README 里图下的长说明另有一份，在 manifest 的 caption 里）。
 * 图上放短句、README 放解释，两边不重复；这也让「重出」与已提交的图逐像素对得上。
 */
const README_HEADLINE = {
  'files-list': '文件列表：每条记忆是一个 Markdown 文件；灰底的那几条是已归档',
  'tools-drawer': '工具抽屉：体检 / 归档候选 / 保留名编辑 —— 关着时零占位，开了各带状态',
  audit: '体检：硬问题按类报红分节；「指向已归档」只作提示，不计入问题',
  'archive-candidates': '归档候选：每条都写清「为什么建议归档」，确认后才动文件',
  'starmap-archive': '记忆星图：暗星是已归档的记忆，点开看归档时间、理由与恢复入口',
  'autodream-settings': '自动做梦 · 设置：运行 / 设置 / 记录 二级分组，参数两列并写清「当前 → 重启后」',
}

// ════════════════════════════════════════════════════════════════════════════
// 静态预览（--preview）：把真渲染出来的树写成 HTML，配上面板与星图自己的 CSS
// ════════════════════════════════════════════════════════════════════════════
async function emitPreview() {
  const outDir = process.env.SAGE_MEM_PREVIEW_DIR || join(tmpdir(), 'sage-mem-preview')
  mkdirSync(outDir, { recursive: true })
  // ── 屏定义（**唯一一份**）────────────────────────────────────────────────
  // --preview 与 scripts/make-readme-images.mjs 共用这一份：出图脚本只认 manifest 里的
  // id，不按下标取图 —— 「插一屏导致 4 张静默换内容」那个坑就死在这一点上。
  //   out     = 发布到仓库的路径（README / 市场用的那 7 张）；null = 只出现在开发预览里
  //   caption = README 图下那一行说明
  const secs = []
  const S = (id, out, caption, title, body) => secs.push({ id, out: out || null, caption: caption || '', title, body })

  // ① 文件列表 · 常态（抽屉关着）：看头部带徽标够不够显眼 + 列表起点
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.audit = AUDIT_WITH_PROBLEMS
    mem.st.settings = LIMITS_FIXTURE
    const { comp: C } = await loadClient(rt, { memory: mem, autodream: makeAutodreamRemote() })
    const tree = await rt.settle(C, {})
    S('files-list', 'docs/images/files-list.png', '文件列表 —— 头部带常显「体检 N 个问题」与「待重启生效」，不用点开就知道该不该处理；灰底条目是已归档，随时可以恢复。', '① 文件列表 · 常态（工具抽屉关着，头部带常显「体检 4 个问题」）', serHtml(tree))
  }
  // ② 文件列表 · 抽屉打开（三项各带状态）+ 体检面板（定高）
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.audit = AUDIT_WITH_PROBLEMS
    mem.st.settings = LIMITS_FIXTURE
    const { comp: C } = await loadClient(rt, { memory: mem, autodream: makeAutodreamRemote() })
    let tree = await rt.settle(C, {})
    tree = await openDrawer(rt, C, tree)
    S('tools-drawer', 'docs/images/tools-drawer.png', '工具抽屉 —— 关着时只占一个按钮，展开后三项各带状态：体检 4 个问题 / 归档候选 2 条 / 保留名 3 个。', '② 文件列表 · 工具抽屉打开（每项带状态；关着时零占位）', serHtml(tree))
  }
  // ③ 文件列表 · 抽屉里开体检（面板定高 + 内部滚动，列表还在首屏）
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.audit = AUDIT_WITH_PROBLEMS
    mem.st.settings = LIMITS_FIXTURE
    const { comp: C } = await loadClient(rt, { memory: mem, autodream: makeAutodreamRemote() })
    let tree = await rt.settle(C, {})
    tree = await openTool(rt, C, tree, '体检')
    S('audit', 'docs/images/audit.png', '体检 —— 索引悬空、漏索引、断链这类硬问题按类报红；「指向已归档」只作提示、不计入问题，也不提供一键修补按钮（改哪条由你决定）。', '③ 文件列表 · 体检面板（定高 320px、内部滚动；硬问题红、提示灰）', serHtml(tree))
  }
  // ③b 文件列表 · 归档候选（勾一条 → 执行归档；每条带「为什么建议归档」）
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.audit = AUDIT_WITH_PROBLEMS
    mem.st.settings = LIMITS_FIXTURE
    mem.st.cand = CANDIDATES
    const { comp: C } = await loadClient(rt, { memory: mem, autodream: makeAutodreamRemote() })
    let tree = await rt.settle(C, {})
    tree = await openTool(rt, C, tree, '归档候选')
    const boxes = all(tree, (n) => n.type === 'input' && n.props.type === 'checkbox')
    if (boxes[0]) boxes[0].props.onChange()
    tree = await rt.settle(C, {})
    S('archive-candidates', 'docs/images/archive-candidates.png', '归档候选 —— 每条都写清「为什么建议归档」（闲置天数 vs 该类型阈值），逐条或全选后确认才动文件；归档是把文件移进 archive/，不删除。', '③b 文件列表 · 归档候选（每条写清为什么建议归档）', serHtml(tree))
  }
  // ④ 自动做梦 · 运行段
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.settings = LIMITS_FIXTURE
    const ad = makeAutodreamRemote()
    const { comp: C } = await loadClient(rt, { memory: mem, autodream: ad })
    let tree = await rt.settle(C, {})
    click(btn(tree, '自动做梦')[0])
    tree = await rt.settle(C, {})
    S('ad-run', null, '', '④ 自动做梦 · 运行（启用 / 触发 / 改动方式 / 输入源 / 模型 / 立即整理）', serHtml(all(tree, byClass('smem-autodream'))[0]))
  }
  // ⑤ 自动做梦 · 设置段（自动归档 + 两列注入参数 + 保留名名单）
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.settings = LIMITS_FIXTURE
    const ad = makeAutodreamRemote()
    ad.st.config.autoArchive = 'auto'
    const { comp: C } = await loadClient(rt, { memory: mem, autodream: ad })
    let tree = await rt.settle(C, {})
    click(btn(tree, '自动做梦')[0])
    tree = await rt.settle(C, {})
    tree = await gotoSeg(rt, C, tree, '设置')
    S('autodream-settings', 'docs/images/autodream-settings.png', '自动做梦 · 设置 —— 运行 / 设置 / 记录 二级分组；五个注入参数两列排开，并写清「当前生效」与「重启后」，不会让人误以为改完立刻生效。', '⑤ 自动做梦 · 设置（自动归档三档 + 两列参数「当前 → 重启后」+ 保留名名单）', serHtml(all(tree, byClass('smem-autodream'))[0]))
  }
  // ⑥ 自动做梦 · 记录段
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.settings = LIMITS_FIXTURE
    const { comp: C } = await loadClient(rt, { memory: mem, autodream: makeAutodreamRemote() })
    let tree = await rt.settle(C, {})
    click(btn(tree, '自动做梦')[0])
    tree = await rt.settle(C, {})
    tree = await gotoSeg(rt, C, tree, '记录')
    S('ad-records', null, '', '⑥ 自动做梦 · 记录（回滚点 / 整理记录 / 历史报告）', serHtml(all(tree, byClass('smem-autodream'))[0]))
  }
  // ⑦ / ⑨ 记忆星图：星空版（docs/starmap.png）与「点中暗星看详情」版（README 展示图）。
  //    画布不手挑坐标 —— 把**真渲染器**最后一帧画过的星核抓出来回放（见 starReplay）。
  for (const [id, out, caption, clickDim] of [
    ['starmap-sky', 'docs/starmap.png', '', false],
    ['starmap-archive', 'docs/images/starmap-archive.png', '记忆星图 —— 暗星是已归档的记忆；点开看归档时间、理由与「恢复到活动记忆」。', true],
  ]) {
    const rt = makeReact()
    const mem = makeMemoryRemote(STAR_DEMO.active, STAR_DEMO.archived)
    const smap = makeStarmapRemote(mem, STAR_DEMO.meta)
    const { comp: C } = await loadClient(rt, { memory: mem, starmap: smap })
    let tree = await rt.settle(C, {})
    click(btn(tree, '记忆星图')[0])
    tree = await rt.settle(C, {})
    const replay = starReplay(rt)
    if (clickDim) {
      // 点圆心外 14px：走的是放大热区那条路径（暗星画出来只有 ~2px）
      const dim = replay.find((a) => a.f[0] !== '#')
      const cv = all(tree, byClass('smap-canvas'))[0]
      if (!dim || !cv || typeof cv.props.onClick !== 'function') throw new Error('星图：取不到暗星或画布 onClick')
      cv.props.onClick({
        currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 940, height: 520 }) },
        clientX: dim.x + 14, clientY: dim.y,
      })
      tree = await rt.settle(C, {})
    }
    S(id, out, caption, (id === 'starmap-sky' ? '⑦ 记忆星图（星空 + 显示档案馆开）' : '⑨ 记忆星图（点中暗星看详情）'), serHtml(tree) + replayTag(replay))
  }
  // ⑧ 保留名「将新建」（走抽屉的回归）
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_RESERVED) // session-log.md 不存在
    mem.st.settings = { limits: {}, pendingLimits: {}, restartRequired: false, reserved: ['memory.md', 'session-log.md'], reservedExtra: [] }
    const { comp: C } = await loadClient(rt, { memory: mem })
    let tree = await rt.settle(C, {})
    tree = await openTool(rt, C, tree, '保留名编辑')
    click(btn(tree, 'session-log.md')[0])
    tree = await rt.settle(C, {})
    S('raw-new', null, '', '⑧ 保留名还不存在时：明确标注「保存会新建它」（原样编辑器不变）', serHtml(tree))
  }

  const head = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>sage-mem 档案馆界面 · 静态预览（假数据）</title>
<style>
/* 只为脱离宿主也能看：宿主主题变量的近似值（浅色档）。形状/间距/层级全部来自插件自己的 CSS。 */
:root{--dsw-alias-border-l1:#e3e6ec;--dsw-alias-border-l2:#cfd4de;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fafbfc;--dsw-alias-bg-layer-2:#f4f6f9;--dsw-alias-bg-layer-3:#eef1f5;--dsw-alias-label-primary:#1f2430;--dsw-alias-label-secondary:#6b7280;--dsw-alias-brand-primary:#4d76e6;--dsw-alias-state-error-primary:#dc2626;--dsw-alias-state-success-primary:#16a34a;--dsw-alias-state-warning-primary:#d97706;}
body{margin:0;padding:24px 28px;background:#f7f8fa;color:#1f2430;font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;}
h1{font-size:17px;margin:0 0 4px;}
.note{font-size:12px;color:#6b7280;margin-bottom:10px;}
h2{font-size:13.5px;margin:26px 0 8px;color:#374151;}
.frame{border:1px solid #e3e6ec;border-radius:12px;background:#fff;padding:16px 18px;}
/* README 展示图用：一句说明 + 「界面预览 · 演示数据」标注，随图一起被截进去。 */
.caption{font-size:15px;font-weight:600;color:#1f2430;margin:0 0 4px;}
.watermark{font-size:11.5px;color:#9aa3af;margin:0 0 10px;}
</style>
<style>${capturedCss.join('\n')}</style>
</head><body>`

  const mock = `<script>
// 星图 canvas：把**真渲染器**画过的星核原样回放（位置/半径/颜色都来自渲染器），
// 底色与星尘只是近似 —— 这样静态稿上的星野就是产品算出来的那一张。
function hx(h, a){ var n = parseInt(h.slice(1), 16); return 'rgba(' + ((n>>16)&255) + ',' + ((n>>8)&255) + ',' + (n&255) + ',' + a + ')'; }
var REPLAY = (window.__SMAP_REPLAY__ || []);
document.querySelectorAll('canvas.smap-canvas').forEach(function(cv){
  var c = cv.getContext('2d'); if (!c) return;
  var W = 940, H = 520; cv.width = W*2; cv.height = H*2; c.setTransform(2,0,0,2,0,0);
  var bg = c.createLinearGradient(0,0,0,H); bg.addColorStop(0,'#0b1026'); bg.addColorStop(1,'#101731');
  c.fillStyle = bg; c.fillRect(0,0,W,H);
  for (var i = 0; i < 150; i++){ c.globalAlpha = 0.08 + 0.22*((i*37 % 100)/100); c.fillStyle = '#9fb3dd'; c.fillRect((i*97)%W, (i*53)%H, 1, 1); }
  c.globalAlpha = 1;
  REPLAY.forEach(function(p){
    var g = c.createRadialGradient(p.x,p.y,0,p.x,p.y,p.r*4.2);
    g.addColorStop(0, hx(p.f, 0.45)); g.addColorStop(1, hx(p.f, 0));
    c.fillStyle = g; c.beginPath(); c.arc(p.x,p.y,p.r*4.2,0,6.283); c.fill();
    c.globalAlpha = p.a; c.fillStyle = p.f; c.beginPath(); c.arc(p.x,p.y,p.r,0,6.283); c.fill(); c.globalAlpha = 1;
  });
});
</script>`

  // 一份屏定义 → 三种产物：开发预览（合并页 + 一屏一个文件）、README 图用 HTML、manifest。
  const manifest = []
  for (const s of secs) {
    const devFile = join(outDir, 'client-preview-' + s.id + '.html')
    writeFileSync(devFile, head + `
<h1>${esc(s.title)}</h1>
<div class="note">假数据 · 静态预览，只这一屏。</div>
<div class="frame">${s.body}</div>
` + mock + `
</body></html>`, 'utf8')
    const rec = { id: s.id, title: s.title, caption: s.caption, out: s.out, file: devFile }
    if (s.out) {
      rec.readmeFile = join(outDir, 'client-readme-' + s.id + '.html')
      writeFileSync(rec.readmeFile, head + `
<div class="caption">${esc(README_HEADLINE[s.id] || '')}</div>
<div class="watermark">界面预览 · 演示数据（假数据，非真实记忆目录）</div>
<div class="frame">${s.body}</div>
` + mock + `
</body></html>`, 'utf8')
    }
    manifest.push(rec)
  }
  const allFile = join(outDir, 'client-preview.html')
  writeFileSync(allFile, head + `
<h1>sage-mem 界面 · 静态预览</h1>
<div class="note">假数据。看的是「按钮找不找得到、信息层级清不清楚」。</div>
${secs.map((s) => '<h2>' + esc(s.title) + '</h2><div class="frame">' + s.body + '</div>').join('\n')}
` + mock + `
</body></html>`, 'utf8')
  const mf = join(outDir, 'client-preview-manifest.json')
  writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log('preview written: ' + allFile)
  console.log('manifest written: ' + mf + '（' + manifest.length + ' 屏，其中发布 ' + manifest.filter((m) => m.out).length + ' 张）')
}

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  if (process.argv.includes('--preview')) await emitPreview()

  // ── 1. 归档是筛选维度：状态 / 类型 / 标签 组内 OR、组间 AND ────────────────
  group('1. 状态筛选（全部 / 活动中 / 已归档）+ 混合列表')
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    const { comp: C } = await loadClient(rt, { memory: mem })
    const props = {}
    let tree = await rt.settle(C, props)

    const filters = all(tree, byClass('smem-filters'))[0]
    ok(!!filters, '文件列表有筛选条')
    const chips = all(filters, (n) => n.type === 'button' && String(n.props.className).indexOf('smem-chip') >= 0)
    ok(textOf(chips[0]) === '全部5' && textOf(chips[1]) === '活动中3' && textOf(chips[2]) === '已归档2',
      `状态组三项齐全：全部5 / 活动中3 / 已归档2（实际 ${chips.slice(0, 3).map(textOf).join(' / ')}）`)
    ok(chips[0].props['data-on'] === '1', '状态默认「全部」')
    ok(all(tree, byClass('smem-filters-label')).map(textOf).join(',').indexOf('状态') >= 0, '筛选条第一组标着「状态」')

    const toolbar = all(tree, byClass('smem-toolbar'))[0]
    ok(!!toolbar && all(toolbar, byClass('smem-chip')).length === 0,
      'R2：工具栏里不再有页签式视图切换（归档已变成筛选 chips）')

    ok(all(tree, byClass('smem-card')).length === 5, `默认「全部」时活动与归档同屏（${all(tree, byClass('smem-card')).length} 张卡）`)
    ok(all(tree, byClass('smem-card--archived')).length === 2, '其中 2 张是归档卡（灰系）')
    ok(btn(tree, '归档').length === 3, '每张活动卡一个「归档」按钮')
    const archCards0 = all(tree, byClass('smem-card--archived'))
    ok(archCards0.length === 2 && archCards0.every((c) => btn(c, '编辑').length === 1 && btn(c, '恢复').length === 1),
      '两张归档卡各带「编辑」「恢复」')
    const badge = all(tree, byClass('smem-badge'))[0]
    ok(textOf(badge).indexOf('活动中 3') >= 0 && textOf(badge).indexOf('已归档 2') >= 0, `头部两边计数都在（${textOf(badge)}）`)

    const chipIn = (t, text) => all(all(t, byClass('smem-filters'))[0], (n) => n.type === 'button' && String(n.props.className).indexOf('smem-chip') >= 0 && textOf(n) === text)[0]

    click(chipIn(tree, '已归档2'))
    tree = await rt.settle(C, props)
    ok(all(tree, byClass('smem-card')).length === 2 && all(tree, byClass('smem-card--archived')).length === 2,
      '状态=已归档：只剩 2 张归档卡')
    ok(treeText(tree).indexOf('档案馆里的记忆不参与检索与星图') >= 0, '专看归档时有一句「这是什么」的说明')
    ok(btn(tree, '归档').length === 0, '状态=已归档时不出现活动卡的「归档」按钮')

    click(chipIn(tree, '项目1'))
    tree = await rt.settle(C, props)
    ok(all(tree, byClass('smem-card--archived')).length === 1, '组间 AND：已归档 × 项目 = 1 条')
    ok(textOf(all(tree, byClass('smem-badge'))[0]).indexOf('筛出 1 / 2') >= 0, '筛选后头部给出「筛出 x / y」')

    typeInto(all(tree, byClass('smem-search'))[0], '停掉')
    tree = await rt.settle(C, props)
    ok(all(tree, byClass('smem-card--archived')).length === 1, '再与搜索框 AND（仍 1 条）')
    typeInto(all(tree, byClass('smem-search'))[0], '不存在的词')
    tree = await rt.settle(C, props)
    ok(all(tree, byClass('smem-card')).length === 0 && treeText(tree).indexOf('没有符合搜索或筛选条件的文件') >= 0, '搜不到时给的是筛选空态')

    click(btn(tree, '清除筛选')[0])
    tree = await rt.settle(C, props)
    ok(all(tree, byClass('smem-card')).length === 5, '「清除筛选」把状态也一起复位（回到全部 5 张卡）')
  }

  // ── 2. 归档条目灰系 + 两个按钮绝不跟着灰 ─────────────────────────────────
  group('2. 归档条目：灰的是内容，不是按钮')
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    const { comp: C } = await loadClient(rt, { memory: mem })
    let tree = await rt.settle(C, {})
    const card = all(tree, byClass('smem-card--archived'))[0]
    ok(!!card && String(card.props.className).indexOf('smem-card--archived') >= 0, '归档卡带灰系 class')
    const editBtn = btn(card, '编辑')[0]
    const restBtn = btn(card, '恢复')[0]
    ok(!!editBtn && !!restBtn, '归档卡同时有「编辑」与「恢复」')
    ok(editBtn && editBtn.props.disabled !== true && restBtn && restBtn.props.disabled !== true, '两个按钮都不是禁用态')
    ok(btn(card, '删除').length === 0, '归档卡没有「删除」（归档 = 不删）')

    const css = capturedCss.join('\n')
    const rule = (css.match(/\.smem-card--archived\{([^}]*)\}/) || [])[1] || ''
    ok(!!rule && !/opacity|filter|grayscale/.test(rule), `灰系不给整张卡加 opacity/filter（实际：${rule}）`)
    ok(!/\.smem-card--archived[^{]*\.smem-btn/.test(css), '灰系规则一条都不点按钮类')
    ok(/\.smem-card--archived .smem-card-title/.test(css), '灰系只点内容（标题/类型章/标签/正文）')
    void tree
  }

  // ── 3. R4：归档编辑 = 原样文本进、原样文本出 ─────────────────────────────
  group('3. 归档编辑：原样文本（绝不重建 frontmatter）')
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    const { comp: C } = await loadClient(rt, { memory: mem })
    let tree = await rt.settle(C, {})
    const chipIn = (t, text) => all(all(t, byClass('smem-filters'))[0], (n) => n.type === 'button' && String(n.props.className).indexOf('smem-chip') >= 0 && textOf(n) === text)[0]
    click(chipIn(tree, '已归档2'))
    tree = await rt.settle(C, {})

    const card = all(tree, byClass('smem-card--archived')).find((c) => textOf(c).indexOf('feedback_old.md') >= 0)
    click(btn(card, '编辑')[0])
    tree = await rt.settle(C, {})
    const readCall = mem.st.calls.find((c) => c[0] === 'readArchived')
    ok(!!readCall && readCall[1] === 'feedback_old.md', `点「编辑」调了 readArchived（${JSON.stringify(readCall)}）`)
    const ta = all(tree, byClass('smem-ar-editor'))[0]
    ok(!!ta, '归档卡里出现原样文本编辑框（等宽 textarea）')
    ok(ta && ta.props.value === RAW_ARCHIVED['feedback_old.md'], '读到的全文与编辑框内容一字不差')
    ok(ta && ta.props.value.indexOf('custom_field: keep-me') >= 0 && ta.props.value.indexOf('archived_at:') >= 0,
      '（喂进去的正文带着自定义字段与归档留痕）')
    ok(!!findText(tree, '原样文本编辑'), '编辑框旁写明「原样文本编辑，不会被重新生成」')

    const SAVED = RAW_ARCHIVED['feedback_old.md'] + '\n改了一行：这条结论已经作废。\n'
    typeInto(ta, SAVED)
    tree = await rt.settle(C, {})
    const ta2 = all(tree, byClass('smem-ar-editor'))[0]
    ok(ta2 && ta2.props.value === SAVED, '编辑框内容是受控的（改完立刻生效）')
    click(btn(all(tree, byClass('smem-ar-edit'))[0], '保存')[0])
    tree = await rt.settle(C, {})
    const w = mem.st.calls.find((c) => c[0] === 'writeArchived')
    ok(!!w && w[1] === 'feedback_old.md', `保存调了 writeArchived（${w && w[1]}）`)
    ok(w && w[2] === SAVED, '交回的内容与编辑框里的一字不差（没有被重建）')
    ok(w && w[2].indexOf('custom_field: keep-me') >= 0 && w[2].indexOf("archived_reason: '结论已被 project_beta 取代'") >= 0,
      '自定义字段与 archived_reason 原样保留')
    ok(treeText(tree).indexOf('已保存 feedback_old.md') >= 0, '保存后有明确反馈')
    ok(all(tree, byClass('smem-ar-editor')).length === 0, '保存后编辑框收起')
  }

  // ── 4. 零归档项：状态 chip 仍在，编辑/恢复不出现 ─────────────────────────
  group('4. 空态：一个归档项都没有')
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, [])
    const { comp: C } = await loadClient(rt, { memory: mem })
    let tree = await rt.settle(C, {})
    const chipIn = (t, text) => all(all(t, byClass('smem-filters'))[0], (n) => n.type === 'button' && String(n.props.className).indexOf('smem-chip') >= 0 && textOf(n) === text)[0]
    ok(!!chipIn(tree, '已归档0'), '没有归档项时状态 chip 仍显示「已归档 0」')
    click(chipIn(tree, '已归档0'))
    tree = await rt.settle(C, {})
    ok(treeText(tree).indexOf('档案馆是空的') >= 0, '给的是「怎么放进来」的指引，不是空白')
    ok(all(tree, byClass('smem-card')).length === 0, '空态下没有卡片')
    ok(btn(tree, '编辑').length === 0 && btn(tree, '恢复').length === 0, '空态下没有「编辑 / 恢复」')
    click(chipIn(tree, '活动中3'))
    tree = await rt.settle(C, {})
    ok(all(tree, byClass('smem-card')).length === 3 && all(tree, byClass('smem-card--archived')).length === 0,
      '切到「活动中」：只有活动卡、没有灰卡')
  }

  // ── 4. 星图：暗星开关 + 本地过滤 + 点击恢复 ──────────────────────────────
  group('5. 星图：显示档案馆开关 / 本地过滤 / 暗星与恢复')
  {
    const rt = makeReact()
    // 星图这一屏只放 2 活 + 1 归档：断言能落到具体某一颗星上
    const mem = makeMemoryRemote([ACTIVE[0], ACTIVE[1]], [ARCHIVED[0]])
    const smap = makeStarmapRemote(mem, STAR_META)
    const { comp: C } = await loadClient(rt, { memory: mem, starmap: smap })
    const props = {}
    let tree = await rt.settle(C, props)
    click(btn(tree, '记忆星图')[0])
    tree = await rt.settle(C, props)

    ok(smap.st.calls.length >= 1 && smap.st.calls.every((c) => c === true),
      `星图用 listStars(true) 取数（实际 ${JSON.stringify(smap.st.calls)}）`)

    const toggle = btnHas(tree, '显示档案馆')[0]
    ok(!!toggle, '星图头部有「显示档案馆」开关')
    ok(toggle && toggle.props['aria-pressed'] === 'true', '开关默认开')
    ok(toggle && textOf(toggle) === '显示档案馆', `R1：开关只留文字、不挂数字（实际「${toggle && textOf(toggle)}」）`)
    ok(toggle && String(toggle.props.className).indexOf('smap-ar-toggle') >= 0 && String(toggle.props.className).indexOf('on') >= 0,
      'R5：开态带 on 类（状态感）')
    ok(treeText(tree).indexOf('档案馆 1 颗暗星') >= 0, '图例说明里点出暗星数量')
    ok(treeText(tree).indexOf('3 条') >= 0, '开着时计数 = 活星 + 归档星')

    const callsBefore = smap.st.calls.length
    click(btnHas(tree, '显示档案馆')[0])
    tree = await rt.settle(C, props)
    const off = btnHas(tree, '显示档案馆')[0]
    ok(off && off.props['aria-pressed'] === 'false' && String(off.props.className).indexOf('on') < 0,
      'R5：再点一次关掉（aria-pressed=false 且不带 on 类）')
    ok(treeText(tree).indexOf('2 条') >= 0, '关掉后计数只算活星')
    ok(treeText(tree).indexOf('颗暗星') < 0, '关掉后图例不再提暗星')
    ok(smap.st.calls.length === callsBefore, `关掉开关没有重新取数（调用次数 ${callsBefore} → ${smap.st.calls.length}）`)

    click(btnHas(tree, '显示档案馆')[0])
    tree = await rt.settle(C, props)
    ok(treeText(tree).indexOf('3 条') >= 0, '再打开，暗星回来')

    // 通过 canvas2d 兜底渲染器观察几何：归档星只画一个暗点
    rt.flushRaf()
    const node = [...rt.nodeCache.values()].find((nd) => nd.ctx2d)
    const allArcs = node ? node.ctx2d.arcs : []
    ok(allArcs.length > 0, 'canvas2d 渲染器真的跑过（记录到 arc 调用）')
    // 只看最后一帧：之前的帧可能还没有可见性标记
    const lastRender = allArcs.reduce((m, a) => Math.max(m, a.render), 0)
    const arcs = allArcs.filter((a) => a.render === lastRender)
    const byCenter = new Map()
    for (const a of arcs) {
      const key = Math.round(a.x) + ',' + Math.round(a.y)
      if (!byCenter.has(key)) byCenter.set(key, [])
      byCenter.get(key).push(a)
    }
    // 暗星的判据看**用色**：核心用 dimCss 出的 rgb(...)，活星核心用类型原色（#hex）。
    // 底盘的填充是径向渐变（对象），两边都有，不作为判据。
    const dimCenters = [...byCenter.entries()].filter(([, l]) => l.some((a) => /^rgb\(/.test(a.fill)) && !l.some((a) => /^#/.test(a.fill)))
    const dimArcs = dimCenters.length ? dimCenters[0][1] : []
    const liveCenters = [...byCenter.values()].filter((l) => l.some((a) => /^#/.test(a.fill)))
    ok(dimCenters.length === 1, `恰好一颗星走「暗星」分支（实际 ${dimCenters.length} 颗）`)
    ok(liveCenters.length >= 2, `活星仍是原色核心（实际 ${liveCenters.length} 颗）`)
    const num = (v) => (isFinite(v) ? v.toFixed(1) : 'n/a')
    const dimCore = dimArcs.filter((a) => /^rgb\(/.test(a.fill)).reduce((m, a) => Math.min(m, a.r), Infinity)
    const dimPad = dimArcs.reduce((m, a) => Math.max(m, a.r), 0)
    const dimCoreAlpha = dimArcs.filter((a) => /^rgb\(/.test(a.fill)).reduce((m, a) => Math.max(m, a.alpha), 0)
    const liveCore = liveCenters.length ? liveCenters[0].filter((a) => /^#/.test(a.fill)).reduce((m, a) => Math.min(m, a.r), Infinity) : 0
    ok(dimCore <= liveCore, `暗星核心不比活星大（暗星 ${num(dimCore)} ≤ 活星 ${num(liveCore)}）`)
    ok(dimPad >= liveCore * 2.5, `暗星底下垫了一层铺得开的淡底盘（最外圈 ${num(dimPad)} ≥ 2.5×${num(liveCore)}）`)
    ok(dimCoreAlpha >= 0.4 && dimCoreAlpha < 0.9, `暗星核心亮度在「看得见但不刺眼」区间（alpha=${dimCoreAlpha.toFixed(2)}）`)

    const dimArc = dimArcs[0]
    const canvasEl = all(tree, byClass('smap-canvas'))[0]
    ok(!!canvasEl && typeof canvasEl.props.onClick === 'function', '画布挂上了 onClick（命中检测入口在）')
    const ev = (x, y) => ({
      currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 940, height: 520 }) },
      clientX: x, clientY: y,
    })

    // 悬停：暗星要「临时点亮 + 提示里带文件名」，这是它能不能被发现的关键
    if (dimArc && canvasEl && typeof canvasEl.props.onMouseMove === 'function') {
      canvasEl.props.onMouseMove(ev(dimArc.x, dimArc.y))
      tree = await rt.settle(C, props)
      const tip = all(tree, byClass('smap-tip'))[0]
      ok(!!tip && textOf(tip).indexOf('feedback_old.md') >= 0, '悬停暗星 → 提示里带文件名')
      ok(!!tip && textOf(tip).indexOf('已归档') >= 0, '悬停暗星 → 提示里标明「已归档」')
      // 渲染器有 30fps 封顶：等过一帧再让它画，否则 tick 会被帧率门挡回去
      await new Promise((r) => setTimeout(r, 60))
      rt.flushRaf()
      const cur = node.ctx2d.renders
      const atDim = node.ctx2d.arcs.filter((a) => a.render === cur &&
        Math.round(a.x) === Math.round(dimArc.x) && Math.round(a.y) === Math.round(dimArc.y))
      ok(atDim.length >= 2 && atDim.some((a) => a.alpha >= 0.9),
        `悬停把暗星点亮（该点 ${atDim.length} 道 arc，最亮 alpha=${atDim.length ? Math.max(...atDim.map((a) => a.alpha)).toFixed(2) : 'n/a'}）`)
      canvasEl.props.onMouseLeave(ev(0, 0))
      tree = await rt.settle(C, props)
    } else {
      ok(false, '画布没有 onMouseMove（无法验证悬停点亮）')
    }

    // 点中暗星：故意从圆心偏 14px —— 暗星画出来只有 ~2px 半径，靠的是放大后的热区
    if (dimArc && canvasEl) {
      canvasEl.props.onClick(ev(dimArc.x + 14, dimArc.y))
      tree = await rt.settle(C, props)
      const panel = all(tree, byClass('smap-panel'))[0]
      ok(!!panel, '点在暗星圆心外 14px 也能打开详情（热区 ≥12px，不是只认那个小点）')
      ok(panel && textOf(panel).indexOf('已归档于 2026-10-01 09:30') >= 0, '面板显示「已归档于 X」')
      ok(panel && textOf(panel).indexOf('理由：结论已被 project_beta 取代') >= 0, '面板显示「理由 Y」')
      ok(panel && btnHas(panel, '恢复').length >= 1, '面板上有「恢复」按钮')
      ok(smap.st.reads.length === 0, '归档星不去打 readFile（不假装读得到 archive/ 正文）')
    } else {
      ok(false, '没能定位暗星圆心（无法验证点击）')
    }
    const panelNow = all(tree, byClass('smap-panel'))[0]
    if (panelNow) {
      const restoreBtn = btn(panelNow, '恢复到活动记忆')[0] || btn(panelNow, '恢复')[0]
      click(restoreBtn)
      tree = await rt.settle(C, props)
      const starRestore = mem.st.calls.find((c) => c[0] === 'restore')
      ok(!!starRestore && starRestore[1] === 'feedback_old.md', `星图上的恢复调了 remote.restore（${JSON.stringify(starRestore)}）`)
      ok(smap.st.calls.length > callsBefore && smap.st.calls.every((c) => c === true),
        `恢复后重新取数（listStars 调用 ${smap.st.calls.length} 次，全部 true）`)
      ok(treeText(tree).indexOf('显示档案馆') >= 0 && treeText(tree).indexOf('颗暗星') < 0, '恢复后归档星数归零')
    } else {
      ok(false, '详情面板没打开，星图上的恢复流程没跑')
    }
  }

  // ── 5. 时间线视图也认归档 ────────────────────────────────────────────────
  group('6. 时间线视图：归档星带「已归档」标记')
  {
    const rt = makeReact()
    const mem = makeMemoryRemote([ACTIVE[0], ACTIVE[1]], [ARCHIVED[0]])
    const smap = makeStarmapRemote(mem, STAR_META)
    const { comp: C } = await loadClient(rt, { memory: mem, starmap: smap })
    const props = {}
    let tree = await rt.settle(C, props)
    click(btn(tree, '记忆星图')[0])
    tree = await rt.settle(C, props)
    click(btn(tree, '时间线')[0])
    tree = await rt.settle(C, props)
    ok(all(tree, byClass('smap-tl-item--arch')).length === 1, '时间线里归档条带 --arch 类（视觉上更轻）')
    ok(findText(tree, '已归档') !== null, '时间线里归档条打「已归档」标记')
  }

  // ── 6. WebGL 主路径（真执行）：shader 里的归档档 + 两层几何 ────────────────
  group('7. 星图 WebGL 主路径：归档档进 shader + 暗星两层几何')
  {
    const rt = makeReact(makeGlNode)
    const mem = makeMemoryRemote([ACTIVE[0], ACTIVE[1]], [ARCHIVED[0]])
    const smap = makeStarmapRemote(mem, STAR_META)
    const { comp: C } = await loadClient(rt, { memory: mem, starmap: smap })
    let tree = await rt.settle(C, {})
    click(btn(tree, '记忆星图')[0])
    tree = await rt.settle(C, {})
    await new Promise((r) => setTimeout(r, 60))
    rt.flushRaf()
    const node = [...rt.nodeCache.values()].find((nd) => nd.gl)
    const gl = node && node.gl
    ok(!!gl, '拿到了假 WebGL 上下文（说明走的是主路径，不是 canvas2d 兜底）')
    ok(gl && gl._draws > 0, `WebGL 真的画了（drawArrays ${gl ? gl._draws : 0} 次）`)
    ok(gl && gl._shaders.some((s) => /vMeta1\.y < -0\.5/.test(s.src)),
      '星点 fragment shader 里编译进了「归档档」（vMeta1.y < -0.5）')
    ok(gl && gl._shaders.some((s) => /aFresh = 1\.0/.test(s.src)),
      'shader 里编译进了「悬停把暗星点亮」（aFresh = 1.0）')
    const verts = gl ? parseVerts(gl) : []
    const drawn = verts.filter((v) => v.birth > 0) // birth<0 是远景尘星，不参与
    const core = drawn.filter((v) => v.a === 1 && v.idx >= 0)
    // Float32Array 里的 0.26 不是精确的 0.26，比较得给容差
    const pad = drawn.filter((v) => Math.abs(v.a - 0.26) < 0.001 && v.idx === -1)
    const archCore = core.filter((v) => v.fresh === -1)
    const liveCore = core.filter((v) => v.fresh !== -1)
    ok(archCore.length === 6, `归档星的核心是一整块 quad（6 顶点，实际 ${archCore.length}）`)
    ok(pad.length === 6, `归档星底下垫了一层淡底盘（6 顶点，实际 ${pad.length}）`)
    ok(liveCore.length === 12, `两颗活星各一块核心 quad（12 顶点，实际 ${liveCore.length}）`)
    const ar = archCore[0] && archCore[0].r
    const pr = pad[0] && pad[0].r
    const lr = liveCore[0] && liveCore[0].r
    ok(ar != null && pr != null && lr != null && ar < lr, `暗星核心半径小于活星（${ar} < ${lr}）`)
    ok(pr != null && ar != null && pr > ar, `底盘比核心铺得开（${pr} > ${ar}）`)
    ok(pad.length && Math.abs(pad[0].a - 0.26) < 0.001 && archCore.length && archCore[0].a === 1,
      '底盘用 0.26 的淡 alpha、核心用满 alpha 走普通分支（hover 才点亮得起来）')
  }

  // ── 8. 体检：只读、硬问题与提示分开 ──────────────────────────────────────
  group('8. 体检：入口 + 硬问题 / 提示分区 + 只读')
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.audit = AUDIT_WITH_PROBLEMS
    const { comp: C } = await loadClient(rt, { memory: mem })
    let tree = await rt.settle(C, {})
    // 头部带的体检徽标：抽屉关着也看得见（这是抽屉方案能成立的前提）
    const badge = all(tree, (n) => n.type === 'button' && byClass('smem-tool-badge')(n) && textOf(n).indexOf('体检') === 0)[0]
    ok(!!badge && textOf(badge).indexOf('4 个问题') >= 0,
      `抽屉关着时头部就有「体检 4 个问题」徽标（实际：${badge ? textOf(badge) : '没有'}）`)
    tree = await openTool(rt, C, tree, '体检')
    ok(mem.st.calls.some((c) => c[0] === 'audit'), '点了就调 memory.audit()')

    const panel = all(tree, byClass('smem-tool-panel'))[0]
    ok(!!panel, '体检结果区出现')
    ok(panel && textOf(panel).indexOf('问题 4') >= 0, `头部给出问题总数（${panel ? textOf(panel).slice(0, 60) : ''}…）`)
    ok(panel && textOf(panel).indexOf('索引悬空') >= 0 && textOf(panel).indexOf('双链断链') >= 0, '硬问题按类分节')
    ok(panel && textOf(panel).indexOf('dangling_one.md') >= 0 && textOf(panel).indexOf('project_beta.md → [[not_there]]') >= 0,
      '每条给出文件名 + 一句话')

    const hardH = all(panel, byClass('smem-audit-h--hard')).map(textOf)
    ok(hardH.length >= 2 && !hardH.some((t) => t.indexOf('指向已归档') >= 0),
      `「指向已归档」不在硬问题（红）标题里（硬标题：${hardH.join(' | ')}）`)
    const hint = all(panel, byClass('smem-audit-hint'))[0]
    ok(!!hint && textOf(hint).indexOf('指向已归档') >= 0 && textOf(hint).indexOf('不计入问题') >= 0,
      '提示单独成块、并写明「不计入问题」')
    ok(!!hint && textOf(hint).indexOf('reference_gamma.md') >= 0 && textOf(hint).indexOf('不用改') >= 0,
      '提示里列出条目并说明「不用改」')

    const panelBtns = all(panel, (n) => n.type === 'button').map(textOf)
    ok(panelBtns.length === 2 && panelBtns[0] === '重新体检' && panelBtns[1] === '收起',
      `只读：面板里只有「重新体检」与「收起」两个按钮、没有任何修补入口（实际：${panelBtns.join(' / ')}）`)
  }

  // ── 9. 归档候选：每条都说清为什么 + 确认后执行 ───────────────────────────
  group('9. 归档候选：理由 + 逐条 / 批量执行')
  {
    // 9a 逐条
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.cand = CANDIDATES
    const { comp: C } = await loadClient(rt, { memory: mem })
    let tree = await rt.settle(C, {})
    tree = await openTool(rt, C, tree, '归档候选')
    ok(mem.st.calls.some((c) => c[0] === 'archiveCandidates'), '点了就调 memory.archiveCandidates()')

    let panel = all(tree, byClass('smem-tool-panel'))[0]
    ok(!!panel && textOf(panel).indexOf('候选 2') >= 0, '候选区给出总数')
    const reasons = all(panel, byClass('smem-cand-reason')).map(textOf)
    ok(reasons.length === 2 && reasons.every((t) => t.indexOf('为什么建议归档：') >= 0),
      `每条候选都带「为什么建议归档」(${reasons.length} 条)`)
    ok(reasons.some((t) => t.indexOf('已 212 天未被注入（project 阈值 90 天）') >= 0), '理由用的是候选算出来的 reason 原文')
    ok(textOf(panel).indexOf('闲置 212 天 / 阈值 90 天') >= 0, '每条给出闲置天数与该类型阈值')
    ok(textOf(panel).indexOf('自动归档：只出报告') >= 0, '写明当前自动归档策略（默认只出报告）')

    const row = all(panel, byClass('smem-cand')).find((c) => textOf(c).indexOf('project_beta.md') >= 0)
    click(btn(row, '归档这一条')[0])
    tree = await rt.settle(C, {})
    panel = all(tree, byClass('smem-tool-panel'))[0]
    ok(textOf(panel).indexOf('确认把「project_beta.md」移进档案馆') >= 0, '逐条执行前要确认')
    click(btn(all(panel, byClass('smem-cand-confirm'))[0], '确认归档')[0])
    tree = await rt.settle(C, {})
    const oneCall = mem.st.calls.find((c) => c[0] === 'archive')
    ok(!!oneCall && oneCall[1] === 'project_beta.md' && oneCall[2] === '已 212 天未被注入（project 阈值 90 天）',
      `逐条归档把候选的 reason 一起交回去（${JSON.stringify(oneCall)}）`)
    ok(treeText(tree).indexOf('已归档 1 条') >= 0, '逐条执行后有明确反馈')
    ok(all(tree, byClass('smem-card--archived')).length === 3, '归档后那张卡确实进了归档（灰卡 3 张）')

    // 9b 批量（新运行时，两条候选都在活动里）
    const rt2 = makeReact()
    const mem2 = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem2.st.cand = CANDIDATES
    const r2 = await loadClient(rt2, { memory: mem2 })
    let t2 = await rt2.settle(r2.comp, {})
    t2 = await openTool(rt2, r2.comp, t2, '归档候选')
    const p2 = all(t2, byClass('smem-tool-panel'))[0]
    const boxes = all(p2, (n) => n.type === 'input' && n.props.type === 'checkbox')
    ok(boxes.length === 2, `每条候选一个勾选框（${boxes.length} 个）`)
    const goOf = (t) => all(t, (n) => n.type === 'button' && textOf(n).indexOf('执行归档') === 0)[0]
    ok(!!goOf(t2) && goOf(t2).props.disabled === true, '一条没选时「执行归档」是禁用的')
    boxes[0].props.onChange()
    t2 = await rt2.settle(r2.comp, {})
    const go2 = goOf(t2)
    ok(!!go2 && go2.props.disabled !== true && textOf(go2) === '执行归档（选中 1 条）', `选中 1 条后按钮可用（${go2 && textOf(go2)}）`)

    // 全选 → 再点执行 → 确认
    click(btn(t2, '全选')[0])
    t2 = await rt2.settle(r2.comp, {})
    ok(textOf(goOf(t2)) === '执行归档（选中 2 条）', '「全选」把两条都勾上')
    click(goOf(t2))
    t2 = await rt2.settle(r2.comp, {})
    ok(treeText(t2).indexOf('确认把选中的 2 条一起移进档案馆') >= 0, '批量执行前要确认')
    click(btnHas(t2, '确认归档')[0])
    t2 = await rt2.settle(r2.comp, {})
    const batch = mem2.st.calls.filter((c) => c[0] === 'archive')
    ok(batch.length === 2 && batch.every((c) => c[2].indexOf('未被注入') >= 0),
      `批量执行是逐条调 archive、每条都带候选理由（${batch.length} 次）`)
    ok(treeText(t2).indexOf('已归档 2 条') >= 0, '批量执行后有明确反馈')
    ok(all(t2, byClass('smem-card--archived')).length === 4, '两条都进了档案馆（灰卡 4 张）')

    // 9c 零候选
    const rt0 = makeReact()
    const mem0 = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem0.st.cand = { count: 0, candidates: [], autoArchive: 'off', thresholds: CANDIDATES.thresholds }
    const r0 = await loadClient(rt0, { memory: mem0 })
    let t0 = await rt0.settle(r0.comp, {})
    t0 = await openTool(rt0, r0.comp, t0, '归档候选')
    ok(treeText(t0).indexOf('按当前阈值没有可归档的') >= 0, '零候选给的是「按当前阈值没有可归档的」')
    ok(all(t0, byClass('smem-cand')).length === 0, '零候选时没有候选行')
    ok(treeText(t0).indexOf('自动归档：关') >= 0, 'autoArchive=off 时写明「关」')
  }

  // ── 10. 保留名原样编辑：读到的全文 = 交回的全文 ──────────────────────────
  group('10. 保留名：原样文本编辑（绝不重建 frontmatter）')
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_RESERVED)
    mem.st.settings = { limits: {}, pendingLimits: {}, restartRequired: false, reserved: ['memory.md', 'session-log.md'], reservedExtra: [] }
    const { comp: C } = await loadClient(rt, { memory: mem })
    let tree = await rt.settle(C, {})
    tree = await openTool(rt, C, tree, '保留名编辑')
    ok(mem.st.calls.some((c) => c[0] === 'getSettings'), '打开时调 memory.getSettings() 取保留名清单')
    ok(!!btn(tree, 'memory.md')[0] && !!btn(tree, 'session-log.md')[0], '保留名都以 chip 列出')

    click(btn(tree, 'memory.md')[0])
    tree = await rt.settle(C, {})
    const readCall = mem.st.calls.find((c) => c[0] === 'readRaw')
    ok(!!readCall && readCall[1] === 'memory.md', `点名字调 readRaw（${JSON.stringify(readCall)}）`)
    const ta = all(tree, byClass('smem-ar-editor'))[0]
    ok(!!ta, '出现原样文本编辑框')
    ok(ta && ta.props.value === RAW_RESERVED['memory.md'], '读到的全文（含 frontmatter 注释与 archived_at）与编辑框一字不差')
    ok(treeText(tree).indexOf('不解析、也不重建 frontmatter') >= 0, '界面上说明了这是原样文本、与记忆表单的区别')

    const EDITED = RAW_RESERVED['memory.md'].replace('- [[project_beta]]', '- [[project_beta]]\n- [[new_entry]]')
    typeInto(ta, EDITED)
    tree = await rt.settle(C, {})
    click(btn(all(tree, byClass('smem-ar-edit'))[0], '保存')[0])
    tree = await rt.settle(C, {})
    const w = mem.st.calls.find((c) => c[0] === 'writeRaw')
    ok(!!w && w[1] === 'memory.md', `保存调了 writeRaw（${w && w[1]}）`)
    ok(w && w[2] === EDITED, '交回的内容与编辑框逐字节一致（注释、baseline、custom_field、archived_at 都在）')
    ok(treeText(tree).indexOf('已保存 memory.md') >= 0, '保存后有明确反馈')
  }

  // ── 11. 自动做梦设置：三档（含回读校验）+ 五个参数 + 保留名名单 ──────────
  group('11. 自动做梦 tab：自动归档三档 / 注入参数 / 保留名名单')
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.settings = {
      limits: { maxResults: 10, maxChars: 1500, maxBaseline: 8, maxSessionBytes: 61440, staleDays: 1 },
      pendingLimits: { maxResults: 12, maxChars: 1500, maxBaseline: 8, maxSessionBytes: 61440, staleDays: 1 },
      restartRequired: true,
      reserved: ['memory.md', 'session-log.md', 'project_notes.md'],
      reservedExtra: ['project_notes.md'],
    }
    const ad = makeAutodreamRemote()
    const { comp: C } = await loadClient(rt, { memory: mem, autodream: ad })
    let tree = await rt.settle(C, {})
    click(btn(tree, '自动做梦')[0])
    tree = await rt.settle(C, {})
    const cardByKey = (t, k) => all(t, (n) => n.props && n.props.key === k)[0]
    const chipIn = (t, k, label) => {
      const card = cardByKey(t, k)
      return card && all(card, (n) => n.type === 'button' && String(n.props.className).indexOf('smem-chip') >= 0 && textOf(n) === label)[0]
    }

    // 11.0 B3：二级分组三段都在，默认停在「运行」
    ok(!!segTab(tree, '运行') && !!segTab(tree, '设置') && !!segTab(tree, '记录'),
      '自动做梦有「运行 / 设置 / 记录」三段')
    ok(segTab(tree, '运行').props.className.indexOf('smem-subtab--on') >= 0, '默认停在「运行」')
    ok(!cardByKey(tree, 'limits') && !cardByKey(tree, 'reserved'), '「运行」段里不渲染设置那几张卡（分段是真的分段）')
    tree = await gotoSeg(rt, C, tree, '设置')
    ok(segTab(tree, '设置').props.className.indexOf('smem-subtab--on') >= 0, '点「设置」就切过去')
    ok(!!cardByKey(tree, 'limits') && !!cardByKey(tree, 'reserved'), '「设置」段里有注入参数与保留名名单')

    // 11a 三档 + 代价说明（注意：「满足条件自动跑」这个词在「触发」那一行也有，
    //      所以必须限定在 autoarchive 这张卡里找）
    ok(!!chipIn(tree, 'autoarchive', '关闭') && !!chipIn(tree, 'autoarchive', '只出报告') && !!chipIn(tree, 'autoarchive', '满足条件自动跑'),
      '三档开关都在（关闭 / 只出报告 / 满足条件自动跑）')
    ok(chipIn(tree, 'autoarchive', '只出报告') && chipIn(tree, 'autoarchive', '只出报告').props['data-on'] === '1', '默认档是「只出报告」（data-on）')
    ok(treeText(tree).indexOf('只出报告：候选写进整理报告，一个文件都不动') >= 0, '当前档的代价说明就在开关下面')
    click(chipIn(tree, 'autoarchive', '满足条件自动跑'))
    tree = await rt.settle(C, {})
    ok(treeText(tree).indexOf('会真的把候选移进 archive/（只移不删，随时可恢复）') >= 0,
      'auto 档说清了「真的移动文件、只移不删」')
    ok(treeText(tree).indexOf('这一档会自动降级成只出报告') >= 0, 'auto 档说清了只读模式下的降级')
    ok(ad.st.config.autoArchive === 'auto', 'setConfig 真的把值改成了 auto')
    ok(treeText(tree).indexOf('自动归档已设为「满足条件自动跑」') >= 0, '保存成功有明确反馈')

    // 11b 回读校验：模拟「setConfig 静默忽略」，界面必须报错而不是说已保存
    ad.st.ignoreAutoArchive = true
    click(chipIn(tree, 'autoarchive', '关闭'))
    tree = await rt.settle(C, {})
    ok(ad.st.calls.some((c) => c[0] === 'getConfig'), '保存后会再 getConfig() 回读一次')
    ok(treeText(tree).indexOf('保存没生效') >= 0, '回读发现值没变 → 界面报错')
    ok(treeText(tree).indexOf('自动归档已设为「关闭」') < 0, '值没变时绝不谎报「已保存」')
    ok(chipIn(tree, 'autoarchive', '满足条件自动跑') && chipIn(tree, 'autoarchive', '满足条件自动跑').props['data-on'] === '1',
      '没生效时界面仍显示真实值（auto）')

    // 11c 文件列表的候选区用同一套词（候选区的 autoArchive 来自 archiveCandidates，
    //     与 autodream 配置同源；这里把它设成与上面刚保存的同一个值来对照措辞）
    mem.st.cand = Object.assign({}, CANDIDATES, { autoArchive: 'auto' })
    click(btn(tree, '文件列表')[0])
    tree = await rt.settle(C, {})
    tree = await openTool(rt, C, tree, '归档候选')
    ok(treeText(tree).indexOf('自动归档：满足条件自动跑') >= 0,
      '候选区与这里用同一套档位措辞（自动归档：满足条件自动跑）')
    click(btn(tree, '自动做梦')[0])
    tree = await rt.settle(C, {})
    tree = await gotoSeg(rt, C, tree, '设置')

    // 11d 五个注入参数 + 「当前 vs 重启后」（限定在 limits 那张卡里：高级设置里也有 .smem-num）
    const limCard = cardByKey(tree, 'limits')
    const nums = all(limCard, (n) => n.type === 'input' && String(n.props.className).indexOf('smem-num') >= 0)
    ok(nums.length === 5, `五个注入参数输入都在（实际 ${nums.length}）`)
    ok(nums.every((n) => n.props.min != null && n.props.max != null), '每个参数都带 min/max 范围')
    ok(nums[0].props.min === '1' && nums[0].props.max === '30', '一次注入条数的范围是 1–30（照抄 host clamp）')
    ok(nums[4].props.min === '0' && nums[4].props.max === '365', '新鲜度门槛的范围是 0–365')
    ok(treeText(tree).indexOf('有改动待生效') >= 0, 'restartRequired 时给出「有改动待生效」')
    ok(treeText(tree).indexOf('要重启 DSH 才生效') >= 0, '写明了「需重启 DSH 才生效」')
    ok(treeText(tree).indexOf('当前 10 → 重启后 12') >= 0, '当前生效与重启后的差别直接写在那一行上')
    ok(treeText(tree).indexOf('当前生效 1500') >= 0, '没差别的参数写「当前生效 X」')

    typeInto(nums[0], '12')
    tree = await rt.settle(C, {})
    click(btnHas(tree, '保存注入参数')[0])
    tree = await rt.settle(C, {})
    const setCall = mem.st.calls.filter((c) => c[0] === 'setSettings').pop()
    ok(!!setCall && setCall[1] && setCall[1].limits && setCall[1].limits.maxResults === 12,
      `保存走的是嵌套 patch {limits:{...}}（${JSON.stringify(setCall && setCall[1])}）`)
    ok(treeText(tree).indexOf('已保存 —— 需重启 DSH 才生效') >= 0, '保存后明说「需重启 DSH 才生效」')
    ok(all(cardByKey(tree, 'limits'), (n) => n.type === 'input' && String(n.props.className).indexOf('smem-num') >= 0)[0].props.value === '12',
      '保存后草稿跟着刷新')

    // 11e 保留名名单：内置固定不可删、用户的可删可加
    const resCard = cardByKey(tree, 'reserved')
    const fixed = all(resCard, byClass('smem-chip--fixed'))
    ok(fixed.length === 2 && fixed.map(textOf).join(' ').indexOf('memory.md') >= 0 &&
      fixed.map(textOf).join(' ').indexOf('session-log.md') >= 0,
      `两个内置名单独标成「固定」（${fixed.map(textOf).join(' / ')}）`)
    ok(fixed.every((c) => all(c, (n) => n.type === 'button').length === 0), '内置名没有删除按钮（删不掉）')
    const extraChip = all(resCard, byClass('smem-chip')).find((c) => textOf(c).indexOf('project_notes.md') >= 0)
    const xBtn = extraChip && all(extraChip, (n) => n.type === 'button')[0]
    ok(!!xBtn, '用户自己加的保留名带 ✕ 删除按钮')

    const addInput = all(resCard, (n) => n.type === 'input' && String(n.props.className).indexOf('smem-input') >= 0)[0]
    ok(!!addInput, '有「加入名单」的输入框')
    typeInto(addInput, 'notes_two.md')
    tree = await rt.settle(C, {})
    click(btnHas(cardByKey(tree, 'reserved'), '加入名单')[0])
    tree = await rt.settle(C, {})
    const addCall = mem.st.calls.filter((c) => c[0] === 'setSettings').pop()
    ok(addCall && addCall[1] && JSON.stringify(addCall[1].reserved) === JSON.stringify(['project_notes.md', 'notes_two.md']),
      `加入走 setSettings({reserved:[...]})（${JSON.stringify(addCall && addCall[1].reserved)}）`)

    const chip2 = all(cardByKey(tree, 'reserved'), byClass('smem-chip')).find((c) => textOf(c).indexOf('project_notes.md') >= 0)
    click(all(chip2, (n) => n.type === 'button')[0])
    tree = await rt.settle(C, {})
    const delCall = mem.st.calls.filter((c) => c[0] === 'setSettings').pop()
    ok(delCall && delCall[1] && JSON.stringify(delCall[1].reserved) === JSON.stringify(['notes_two.md']),
      `删除只删用户自己那条（${JSON.stringify(delCall && delCall[1].reserved)}）`)
    ok(all(cardByKey(tree, 'reserved'), byClass('smem-chip--fixed')).length === 2, '删完内置两个仍在（removed 只作用于 reservedExtra）')
  }

  // ── 12. 保留名文件不存在 → 显式「新建」 ──────────────────────────────────
  group('12. 保留名不存在：显式标注「将新建」')
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_RESERVED) // session-log.md 没喂 → readRaw 报 ENOENT
    mem.st.settings = { limits: {}, pendingLimits: {}, restartRequired: false, reserved: ['memory.md', 'session-log.md'], reservedExtra: [] }
    const { comp: C } = await loadClient(rt, { memory: mem })
    let tree = await rt.settle(C, {})
    tree = await openTool(rt, C, tree, '保留名编辑')
    click(btn(tree, 'session-log.md')[0])
    tree = await rt.settle(C, {})
    ok(treeText(tree).indexOf('这个文件还不存在 —— 保存会新建它') >= 0, '不存在时明确标注「保存会新建它」')
    ok(!!btnHas(tree, '新建并保存')[0], '保存按钮改成「新建并保存」')
    const ta = all(tree, byClass('smem-ar-editor'))[0]
    ok(!!ta && ta.props.value === '', '编辑框是空的（不是把旧内容盖掉）')
    typeInto(ta, '# 新的会话流水\n')
    tree = await rt.settle(C, {})
    click(btnHas(tree, '新建并保存')[0])
    tree = await rt.settle(C, {})
    const w = mem.st.calls.find((c) => c[0] === 'writeRaw')
    ok(!!w && w[1] === 'session-log.md' && w[2] === '# 新的会话流水\n', '新建写的是编辑框里的内容')
    ok(treeText(tree).indexOf('已新建 session-log.md') >= 0, '反馈说「已新建」而不是「已保存」')
  }

  // ── 13. B3：工具抽屉（关着一律零占位）+ 共用头部带 + 两列参数 + 星图去重复标题 ──
  group('13. B3 信息架构：抽屉 / 头部带 / 二级分组 / 星图标题')
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.audit = AUDIT_WITH_PROBLEMS
    mem.st.settings = LIMITS_FIXTURE
    const ad = makeAutodreamRemote()
    const { comp: C } = await loadClient(rt, { memory: mem, autodream: ad, starmap: makeStarmapRemote(makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED), STAR_META) })
    let tree = await rt.settle(C, {})

    // 13a 抽屉关着：三个入口一个都不在 DOM 里（真的零占位，不是「藏起来但还在」）
    ok(!drawerItem(tree, '体检') && !drawerItem(tree, '归档候选') && !drawerItem(tree, '保留名编辑'),
      '抽屉关着时三个工具入口都不在 DOM 里')
    ok(all(tree, byClass('smem-tools')).length === 0, '也不再有那一行「工具 体检 归档候选 保留名编辑」')

    // 13b 可发现性：头部带的徽标在抽屉关着时就是可见的
    const audBadge = all(tree, (n) => n.type === 'button' && byClass('smem-tool-badge')(n) && textOf(n).indexOf('体检') === 0)[0]
    ok(!!audBadge && textOf(audBadge).indexOf('4 个问题') >= 0, `头部常显「体检 4 个问题」徽标（${audBadge && textOf(audBadge)}）`)
    ok(audBadge.props.className.indexOf('smem-tool-badge--bad') >= 0, '有问题时徽标是红的（不是中性灰）')
    const rsBadge = all(tree, (n) => n.type === 'button' && textOf(n).indexOf('待重启生效') >= 0)[0]
    ok(!!rsBadge && rsBadge.props.className.indexOf('smem-ad-badge--warn') >= 0, `头部也常显「待重启生效」徽标（${rsBadge && textOf(rsBadge)}）`)
    ok(!!btnHas(tree, '工具')[0], '工具栏里只有一个「工具 ▾」按钮')

    // 13c 点开抽屉：三项都在，且各自带状态
    tree = await openDrawer(rt, C, tree)
    const items = all(tree, byClass('smem-drawer-item'))
    ok(items.length === 3, `抽屉里有三项（${items.map(textOf).join(' / ')}）`)
    const itemText = items.map(textOf).join(' | ')
    ok(itemText.indexOf('体检') >= 0 && itemText.indexOf('4 个问题') >= 0, '体检项带「4 个问题」')
    ok(itemText.indexOf('归档候选') >= 0, '归档候选项在（未取数时显示「未取」）')
    ok(itemText.indexOf('保留名编辑') >= 0 && itemText.indexOf('3 个') >= 0, '保留名编辑项带数量（memory.md / session-log.md / project_notes.md）')
    ok(drawerItem(tree, '归档候选') && textOf(drawerItem(tree, '归档候选')).indexOf('未取') >= 0,
      '候选还没取过数 → 项上写「未取」（不假装 0 条）')

    // 13d 抽屉里开了工具（面板出现），再点一次收起 → 面板消失（此刻抽屉还开着，直接点条目）
    click(drawerItem(tree, '归档候选'))
    tree = await rt.settle(C, {})
    ok(all(tree, byClass('smem-tool-panel')).length === 1, '抽屉里选一项就开出对应面板')
    ok(all(tree, byClass('smem-tool-panel'))[0].props.className.indexOf('smem-tool-panel--cap') >= 0,
      '体检 / 候选面板带定高（列表不被顶出首屏）')
    tree = await openTool(rt, C, tree, '归档候选')
    ok(all(tree, byClass('smem-tool-panel')).length === 0, '再选一次同一个工具 → 面板收起')

    // 13e 三个 tab 共用一条头部带：切到星图 / 自动做梦，头部带都在
    click(btn(tree, '记忆星图')[0])
    tree = await rt.settle(C, {})
    ok(treeText(tree).indexOf('记忆管理') >= 0 && treeText(tree).indexOf('目录可读') >= 0, '星图页也有同一条头部带')
    ok(all(tree, (n) => n.type === 'button' && textOf(n).indexOf('体检 4 个问题') >= 0).length === 1, '星图页头部带里同样有体检徽标')
    // 13f 星图卡片里那行重复标题已经去掉
    ok(all(tree, byClass('smap-title')).length === 0 && treeText(tree).indexOf('sage-mem memory · 每颗星是一条记忆') < 0,
      '星图卡片不再重复「记忆星图 / sage-mem memory」标题')
    ok(!!all(tree, byClass('smap-viewtoggle'))[0] && all(tree, (n) => n.type === 'button' && textOf(n) === '显示档案馆').length === 1,
      '星图的控件（星空/时间线、显示档案馆）都还在')

    // 13g 自动做梦：三段 + 两列参数网格（用**新的**运行时：这个 harness 的 hooks 是按
    //     整棵树的调用序扁平记账的，跨 tab 换树会让后面组件的槽位错位 —— 那是量具的限制，
    //     不是产品问题，所以换一段就换一个 runtime）
    const rt2 = makeReact()
    const mem2 = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem2.st.settings = LIMITS_FIXTURE
    const r2 = await loadClient(rt2, { memory: mem2, autodream: makeAutodreamRemote() })
    let t2 = await rt2.settle(r2.comp, {})
    click(btn(t2, '自动做梦')[0])
    t2 = await rt2.settle(r2.comp, {})
    ok(all(t2, byClass('smem-subtab')).length === 3, '三个分段按钮都在')
    ok(treeText(t2).indexOf('立即整理') >= 0, '「运行」段里有立即整理')
    t2 = await gotoSeg(rt2, r2.comp, t2, '设置')
    const grid = all(t2, byClass('smem-ad-grid2'))[0]
    ok(!!grid, '注入参数排成两列网格（吸收方案 A）')
    ok(all(grid, (n) => n.type === 'input' && byClass('smem-num')(n)).length === 5, '两列里正好是那五个参数')
    t2 = await gotoSeg(rt2, r2.comp, t2, '记录')
    ok(treeText(t2).indexOf('回滚点') >= 0 && treeText(t2).indexOf('整理记录') >= 0 && treeText(t2).indexOf('历史报告') >= 0,
      '「记录」段里有回滚点 / 整理记录 / 历史报告')
    ok(cardByKeyOf(t2, 'limits') === undefined, '切到「记录」后设置段不再渲染')
  }

  // ── 14. 工具抽屉：点条目 / 点外部 / Esc 三条关闭路径 ─────────────────────
  group('14. 工具抽屉关闭：点条目 / 点外部 / Esc（关着不吃点击）')
  {
    const rt = makeReact()
    const mem = makeMemoryRemote(ACTIVE, ARCHIVED, RAW_ARCHIVED)
    mem.st.audit = AUDIT_WITH_PROBLEMS
    mem.st.settings = LIMITS_FIXTURE
    const { comp: C } = await loadClient(rt, { memory: mem, autodream: makeAutodreamRemote() })
    let tree = await rt.settle(C, {})

    // 14a 关着时：一个文档监听都不挂，且点击照常生效（不被吞）
    ok(fakeDoc.listenerCount('click') === 0 && fakeDoc.listenerCount('keydown') === 0,
      '抽屉关着时不挂任何 document 监听（不可能吃掉点击）')
    const chip = all(tree, (n) => n.type === 'button' && byClass('smem-chip')(n) && textOf(n).indexOf('活动中') === 0)[0]
    ok(!!chip, '关着时能找到「活动中」筛选 chip')
    click(chip)
    tree = await rt.settle(C, {})
    ok(all(tree, byClass('smem-card')).length === 3, `关着时点击照常生效：筛出 3 张活动卡（${all(tree, byClass('smem-card')).length}）`)

    // 14b 抽屉展开就挂监听；点条目关闭（原有路径），监听成对摘掉
    tree = await openDrawer(rt, C, tree)
    ok(fakeDoc.listenerCount('click') === 1 && fakeDoc.listenerCount('keydown') === 1,
      `展开后挂上一个 click + 一个 keydown 监听（click ${fakeDoc.listenerCount('click')} / keydown ${fakeDoc.listenerCount('keydown')}）`)
    click(drawerItem(tree, '体检'))
    tree = await rt.settle(C, {})
    ok(drawerItem(tree, '体检') === undefined, '点条目 → 抽屉收起')
    ok(all(tree, byClass('smem-tool-panel')).length === 1, '点条目同时把对应面板打开')
    ok(fakeDoc.listenerCount('click') === 0 && fakeDoc.listenerCount('keydown') === 0, '点条目关掉后监听也摘掉')

    // 14c 点外部关闭
    tree = await openDrawer(rt, C, tree)
    ok(!!drawerItem(tree, '体检'), '重新展开：条目在')
    fakeDoc.fire('click', {})
    tree = await rt.settle(C, {})
    ok(drawerItem(tree, '体检') === undefined, '点外部 → 抽屉关闭')
    ok(fakeDoc.listenerCount('click') === 0 && fakeDoc.listenerCount('keydown') === 0, '关闭后监听成对摘掉，不留悬挂')
    ok(all(tree, (n) => n.type === 'button' && byClass('smem-tool-badge')(n) && textOf(n).indexOf('体检 4 个问题') >= 0).length === 1,
      '点外部关掉后头部徽标照样在（可发现性不随抽屉丢）')
    ok(all(tree, byClass('smem-tool-panel')).length === 1, '点外部只关抽屉，已经开着的面板不收')

    // 14d Esc 关闭
    tree = await openDrawer(rt, C, tree)
    ok(!!drawerItem(tree, '体检'), '再次展开：条目在')
    fakeDoc.fire('keydown', { key: 'Escape' })
    tree = await rt.settle(C, {})
    ok(drawerItem(tree, '体检') === undefined, 'Esc → 抽屉关闭')
    ok(fakeDoc.listenerCount('keydown') === 0, 'Esc 关闭后 keydown 监听也摘掉')

    // 14e 别的按键不该关；抽屉里换一个工具；面板里的「收起」能关面板
    tree = await openDrawer(rt, C, tree)
    fakeDoc.fire('keydown', { key: 'a' })
    tree = await rt.settle(C, {})
    ok(!!drawerItem(tree, '体检'), '按别的键（a）不关抽屉')
    click(drawerItem(tree, '归档候选'))
    tree = await rt.settle(C, {})
    ok(treeText(all(tree, byClass('smem-tool-panel'))[0] || {}).indexOf('归档候选') >= 0, '抽屉里换成「归档候选」→ 面板跟着换')
    click(btnHas(all(tree, byClass('smem-tool-panel'))[0], '收起')[0])
    tree = await rt.settle(C, {})
    ok(all(tree, byClass('smem-tool-panel')).length === 0, '面板里的「收起」把面板关掉')
  }

  console.log(`\n结果：${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('harness error:', (e && e.stack) || e)
  process.exit(2)
})
