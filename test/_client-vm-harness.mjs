/**
 * 客户端**分片级** VM 渲染骨架（2.1.20 Q15 引入）。
 *
 * 为什么不用 `lib/client.js`：那是 `npm run build:client` 的生成物，而提交树里
 * 生成物由集成时统一重建（分支持有不重建，避免多分支冲突）。回归测试要盯的是
 * **源分片**，所以这里直接从 `client/*.js` 读源码拼一个有意义的片段来跑 ——
 * 不受生成物新旧影响，也不会因为「产物是旧的」而给出假结果。
 *
 * 与 `client-render-test.mjs` 的分工：那边跑整个产物、覆盖全部界面；这边只给
 * 单点回归用的最小骨架（假 react / 假 DOM / 假 WebGL / 可驱动时钟的 rAF 队列）。
 * 刻意不共享代码 —— 那边的量具是「整机渲染」，这边要能单独调时钟。
 *
 * 只依赖 node: 内置模块。
 */
import vm from 'node:vm'

// ── 迷你 react：hooks 按调用序存，effect 带依赖比对；setState 让调和循环再跑一轮 ──

/** 纯 JS 节点（不需要 canvas 之类宿主对象时用）。 */
export function makePlainNode() {
  return { width: 0, height: 0, getContext: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 940, height: 520 }) }
}

export function makeMiniReact(nodeFactory = makePlainNode) {
  const stateStore = new Map()
  const effectStore = new Map()
  const refStore = new Map()
  const nodeCache = new Map()
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

  /** 反复「渲染 → 跑 effect → 让 promise 落地」，直到没有新的 setState。 */
  async function settle(comp, props, maxPasses = 80) {
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

  return { api, settle, nodeCache }
}

// ── 假 DOM（theme 属性 + 文档级监听 + visibilitychange）────────────────────

export function makeFakeDocument() {
  const listeners = {}
  const doc = {
    hidden: false,
    _created: [],
    body: {
      _attrs: {},
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, String(k)) },
      setAttribute(k) { this._attrs[String(k)] = '' },
      removeAttribute(k) { delete this._attrs[String(k)] },
    },
    addEventListener(type, fn) {
      const k = String(type)
      listeners[k] = listeners[k] || []
      listeners[k].push(fn)
    },
    removeEventListener(type, fn) {
      const a = listeners[String(type)] || []
      const i = a.indexOf(fn)
      if (i >= 0) a.splice(i, 1)
    },
    /** 测试用：模拟一次文档级事件（先 fire 再断言行为，不靠「我挂了监听」自证）。 */
    fire(type, ev) {
      const a = (listeners[String(type)] || []).slice()
      a.forEach((fn) => fn(ev || {}))
      return a.length
    },
    listenerCount(type) { return (listeners[String(type)] || []).length },
    querySelector() { return null },
    createElement() { const el = { dataset: {}, style: {}, textContent: '' }; doc._created.push(el); return el },
    head: { appendChild() {} },
  }
  return doc
}

// ── 假 WebGL：把 render(phase) 画出来的东西记下来（uniform 值可直接断言）────

/**
 * 记录每一次 `uniform1f/uniform2f` 的 (program id, uniform 名, 值)。
 *
 * 关键用途：`render(phase)` 会写 `uTime`（相位）与 `uRevealT`（诞生回放时刻），
 * 于是「这一帧画没画、相位是不是负数、回放时刻有没有推进」都能直接被读到 ——
 * 不用去猜画布像素，也不依赖浏览器专有 API。
 */
export function makeFakeGl() {
  const gl = {
    _shaders: [], _uniforms: [], _bufferData: [], _draws: 0, _programs: 0,
    createShader: (t) => ({ type: t, src: '' }),
    shaderSource: (s, src) => { s.src = src; gl._shaders.push(s) },
    compileShader() {}, getShaderParameter: () => true, getShaderInfoLog: () => '',
    createProgram: () => ({ id: ++gl._programs }),
    attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => '',
    getAttribLocation: () => 0,
    getUniformLocation: (prog, name) => ({ prog, name }),
    createBuffer: () => ({}), bindBuffer() {},
    bufferData: (target, data) => { gl._bufferData.push(data ? Array.from(data) : []) },
    enableVertexAttribArray() {}, vertexAttribPointer() {}, drawArrays() { gl._draws++ },
    disable() {}, enable() {}, blendFunc() {}, useProgram() {},
    uniform1f(loc, v) { gl._uniforms.push({ prog: loc.prog.id, name: loc.name, value: v }) },
    uniform2f(loc, a, b) { gl._uniforms.push({ prog: loc.prog.id, name: loc.name, value: [a, b] }) },
    viewport() {},
    deleteBuffer() {}, deleteProgram() {}, getExtension: () => null,
    ARRAY_BUFFER: 34962, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048, FLOAT: 5126,
    TRIANGLES: 4, LINES: 1, SRC_ALPHA: 770, ONE: 1, BLEND: 3042,
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713, LINK_STATUS: 35714,
  }
  return gl
}

/** 带假 WebGL 的 canvas 节点（星图走主路径，才能从 uniform 读到相位/回放时刻）。 */
export function makeGlNode() {
  const gl = makeFakeGl()
  return {
    gl,
    width: 0, height: 0,
    getContext: (kind) => (kind === 'webgl' ? gl : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 940, height: 520, right: 940, bottom: 520 }),
  }
}

/** 取某个 program 上某个 uniform 的取值序列（每次 render 各写一次）。 */
export function uniformSeries(gl, name, progId) {
  return gl._uniforms.filter((u) => u.name === name && u.prog === progId).map((u) => u.value)
}

// ── 可驱动的 rAF 队列（伪时钟）─────────────────────────────────────────────

/**
 * rAF 队列：注册顺序执行、帧内新注册的回调留到下一帧（与浏览器一致）。
 * 时间戳由调用方给 —— 测试自己推进时钟，就能精确验「入场/回放/静止」三态。
 */
export function makeFakeFrames() {
  const queue = new Map()
  let seq = 1
  return {
    requestAnimationFrame(fn) { const id = seq++; queue.set(id, fn); return id },
    cancelAnimationFrame(id) { queue.delete(id) },
    pending() { return queue.size },
    /** 跑一帧：把当前排队的回调按注册序执行一遍，返回执行了几个。 */
    frame(ts) {
      const list = [...queue.entries()]
      queue.clear()
      for (const [, fn] of list) fn(ts)
      return list.length
    },
    /** 连续跑 n 帧，每帧推进 stepMs（返回每帧时间戳）。 */
    frames(n, startTs, stepMs = 16.7) {
      const ts = []
      for (let i = 0; i < n; i++) { const t = startTs + i * stepMs; this.frame(t); ts.push(t) }
      return ts
    },
  }
}

// ── 树查询小工具 ──────────────────────────────────────────────────────────

export function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

export function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const x of node) walk(x, out); return out }
  out.push(node)
  for (const k of node.children || []) walk(k, out)
  return out
}

/** 按节点类型（host 标签名或组件名）找。 */
export function findAll(root, pred) {
  return walk(root).filter((n) => pred(n))
}

/** 按按钮文案精确找按钮（连点两次的反向对照靠它）。 */
export function findButton(root, label) {
  return walk(root).find((n) => n.type === 'button' && textOf(n) === label)
}

/** 按 class 找（className 是空格分隔的字符串）。 */
export function byClass(root, cls) {
  return walk(root).filter((n) => {
    const c = n.props && n.props.className
    return typeof c === 'string' && (' ' + c + ' ').indexOf(' ' + cls + ' ') >= 0
  })
}

/** 在 vm 里跑「若干分片的拼接」并取回一个测试句柄。 */
export function runFragments(files, sources, sandbox, trailer) {
  vm.createContext(sandbox)
  const code = sources.join('\n') + '\n' + trailer
  vm.runInContext(code, sandbox, { filename: files.join('+') })
  return sandbox
}
