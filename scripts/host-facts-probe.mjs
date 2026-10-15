/**
 * host-facts-probe.mjs — 真实宿主探针：把「宿主管家给了什么」问成记录，而不是假设。
 *
 * ⚠️ **这不是一条 `node scripts/host-facts-probe.mjs` 能跑的脚本。**
 * 本文件导出的是 **DSH 插件**（`apply(ctx)`），只有在真实宿主的 cordis 上下文里才有意义。
 * 裸 node 里没有 ctx —— 探针只会打印「什么都没有」，那是假信息，比不打印更糟。
 *
 * ── 怎么在真实宿主里跑（2026-10-15 在本机 `headless` profile 上实测跑通）──
 *
 *   step 1  生成 overlay。写 %TEMP%，**不要**写进仓库（这一条是给操作者看的，
 *           脚本自己不改任何 profile / 配置文件）：
 *
 *     $probe = (Resolve-Path '<仓库目录>\scripts\host-facts-probe.mjs').Path -replace '\\','/'
 *     $yml   = Join-Path $env:TEMP 'sage-mem-host-facts-probe.yml'
 *     "- insert:`n    - id: sage-mem-host-facts-probe`n      name: '$probe'" | Set-Content -Encoding ascii $yml
 *
 *   step 2  用 overlay 启一个**一次性**宿主。已经在跑的桌面版 / 网页版完全不受影响：
 *
 *     dsh --profile headless --patch $yml "只回复 ok，不要调用任何工具"
 *
 *   step 3  读产物（两处，取哪处看宿主形态）：
 *     · stdout 里的 `[sage-mem-probe] {...}` —— headless 能看见
 *     · 文件（桌面版没有可见 stdout，文件才可靠）：
 *         %TEMP%\sage-mem-host-facts-probe.load.json      ← 服务可达性的**主证据**（load 阶段）
 *         %TEMP%\sage-mem-host-facts-probe.dispose.json   ← 收尾阶段（strict get 已失效）
 *         %TEMP%\sage-mem-host-facts-probe.json           ← 最后一次写入（= 最新阶段）
 *
 *   想看「声明 inject 之后能不能真拿到服务」，再跑一遍并加环境变量：
 *     $env:SAGE_MEM_PROBE_INJECT = 'tools,systemPrompt,fs,tokenMeter,compaction'
 *     dsh --profile headless --patch $yml "只回复 ok"
 *     Remove-Item Env:\SAGE_MEM_PROBE_INJECT
 *   （两种模式的实测差异见 docs/host-facts.md，那是本探针最值钱的一条产出。）
 *
 *   注：`dsh --profile headless --dump-config --patch $yml` 只验 patch 组合、**不加载模块**
 *   （实测：探针一句都不会打印），所以它不能替代 step 2。
 *
 * ── 我**没有**验证的部分，别当成保证 ──
 *   · `desktop` profile：CLI 不能给它加 `--patch`（桌面版被 Electron 独占），这份探针
 *     **没在 desktop 上跑过**。desktop 的契约事实来自 `cordis_inspect` 的 Host 查询
 *     （Service / Event 两个 provider），见 `docs/host-facts.md`。
 *   · `web` profile：同理没跑过（`dsh --profile web --patch $yml` 会长期监听，不是一次性）。
 *   · 事件那一节是**两级证据**，别读混：`hasListeners` 只说明该事件名上挂着订阅者（Cordis
 *     不校验事件名，任何字符串都能订阅），`observed` 才是「宿主真的派发过」。
 *     零订阅者的事件不会出现在 `ctx.events._hooks` 里 —— 那是 cordis 内部结构，
 *     变了只会让 `hasListeners` 变 `null`，不代表事件不存在。
 *   · **阶段差异**：load 与 dispose 两份快照结论不同，不是抖动。
 *     实测 headless：`props` 从 24 条长到 80 条（服务是一个个挂上去的）、
 *     strict `ctx.get` 在 dispose 时拿不到东西（提供方 fiber 已离开 ACTIVE）。
 *     要判「插件启动时能不能拿到服务」看 load；要判「宿主声明了哪些服务」看 dispose。
 *
 * 设计上不写死 `inject`，而是由环境变量开关：探针要能在「什么服务都没接上」的宿主里跑完、
 * 并如实报告缺哪几个；而「声明 inject 之后到底能不能拿到」只有真声明一遍才知道。
 * 两种模式各跑一次，才有下面这条实测链。
 *
 * ── 实测出来的三条硬事实（2026-10-15，headless）——不写 `inject` 时 ──
 *   1. `ctx.get('tools')`  → undefined（非严格读，不抛）
 *   2. `ctx.tools`         → **抛** `cannot get property "tools" without inject`
 *   3. `ctx.reflect.props` → 声明表里 `tools` / `systemPrompt` / `fs` / `tokenMeter` /
 *      `compaction` 都是 `service`（**宿主确实声明了它们**），但实现拿不到
 *   ⚠️ `ctx.reflect.store` 这条路**受加载时机影响**，不能单独用它判「宿主有没有」：
 *   模式 A 的 load 阶段只有 8 个符号键、翻不到目标服务；模式 B 的 load 阶段有 58 个、
 *   五个全翻得到；dispose 阶段是 0。判「宿主有没有」以声明表 `ctx.reflect.props` 为准。
 *   写上 inject 之后（模式 B）五个服务全部可达，且由严格 `ctx.get` 拿到实现。
 *   这正是 sage-mem 的 `svc()`（`ctx.get(name) ?? ctx[name]`）会抛的原因：
 *   前半句返回 undefined，后半句在没 inject 时直接抛 —— 降级契约必须把后半句包起来。
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'sage-mem-host-facts-probe'

/**
 * `inject` 由环境变量开关，好让**同一个探针文件**跑出两种事实：
 *
 *   （不设）                         → 无 inject：服务一律拿不到，只能看「宿主声明了什么」
 *   SAGE_MEM_PROBE_INJECT=tools,fs   → 声明 inject：服务真的拿得到，能读出方法签名
 *
 * 为什么这组对照才是关键：sage-mem 0.9.15 不声明 inject，`svc()` 那种
 * `ctx.get(name) ?? ctx[name]` 的写法在后半句会**抛**（见文件头）。两种模式各跑一遍，
 * 「要拿服务就必须 inject」这条就有了实测证据，而不是从文档推的。
 * 空数组 = 不声明 —— 别写成 undefined（有的加载器会当场报错）。
 */
export const inject = (process.env.SAGE_MEM_PROBE_INJECT || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** 探针关心的服务，以及每个服务上 sage-mem 真要用的那几个方法。 */
const SERVICES = {
  tools: ['register', 'get', 'schemas', 'execute', 'restrict', 'guard', 'executionMode'],
  systemPrompt: ['tools', 'context', 'section', 'variable', 'assemble'],
  fs: ['writeText', 'editText', 'readText', 'resolve', 'stat'],
  tokenMeter: ['measure', 'estimateMessage'],
  compaction: ['compactNow', 'compactIfNeeded', 'compactRegion'],
}

/**
 * 事件分两档登记，差别在**破坏性**：
 *   emit      —— 纯观察，不参与分发，随便加；
 *   waterfall —— 监听器不调 `next()` 会把后链（含宿主自己的行为）整个掐断。
 *                所以这里登记的是**通用放行**（把最后一个参数当 next 调）。
 *                这份探针因此只许用在一次性宿主里，别挂到正在干活的实例上。
 */
const EVENTS = [
  { name: 'tools/pre-execute', mode: 'waterfall' },
  { name: 'tools/execute', mode: 'waterfall' },
  { name: 'tools/post-execute', mode: 'waterfall' },
  { name: 'tools/result', mode: 'emit' },
  { name: 'system-prompt/assemble', mode: 'waterfall' },
]

/**
 * 一个服务键：四条解析路子各记各的，谁生效要看得见。
 *
 *   · `ctx.get(key)`        —— 严格读：**提供方 fiber 必须 ACTIVE**，否则 undefined；
 *   · `ctx.get(key, false)` —— 非严格读：绕开上面那条，收尾阶段还能拿到；
 *   · `ctx[key]`            —— 声明了 inject 才给，否则**抛**
 *                              `cannot get property "X" without inject`；
 *   · store 里按名字翻       —— 不要求 inject，但**受加载时机影响**（见 storeValues 的注释）。
 *
 * 为什么四条都要：sage-mem 的 `svc()`（`ctx.get(name) ?? ctx[name]`）走的正是
 * 「先严格 get、再取直接属性」这一对，而这两条在不同阶段 / 不同 inject 状态下答案不一样。
 */
function describeService(ctx, key, methods) {
  let viaGet
  let getError = ''
  if (typeof ctx?.get === 'function') {
    try { viaGet = ctx.get(key) } catch (err) { getError = err?.message ?? String(err) }
  }
  // 非严格读：`ctx.get(name, false)` 跳过「提供方 fiber 必须 ACTIVE」这一条。
  // 只在严格读拿不到时才有意义 —— 它把「服务根本没 provide」和「provide 了但当时没激活」分开。
  let viaLoose
  let looseError = ''
  if (!viaGet && typeof ctx?.get === 'function') {
    try { viaLoose = ctx.get(key, false) } catch (err) { looseError = err?.message ?? String(err) }
  }
  let viaProp
  let propError = ''
  try { viaProp = ctx?.[key] } catch (err) { propError = err?.message ?? String(err) }
  const fromStore = storeImpl(ctx, key)
  const impl = fromStore?.impl
  const svc = viaGet ?? viaLoose ?? viaProp ?? impl?.value
  const out = {
    present: !!svc,
    resolvedBy: viaGet ? 'ctx.get' : (viaLoose ? 'ctx.get(name,false)' : (viaProp ? 'ctx.<key>' : (fromStore ? fromStore.source : null))),
    // provided 才是「**宿主提供过**这个服务」（与「本插件能不能拿到」是两件事）
    provided: !!impl || !!viaGet || !!viaLoose,
    // 声明表里的类型（`service` / `accessor` / null）。⚠️ 名字与 events.hasListeners 不同：
    // 这边说的是「宿主声明了这个服务」，那边说的是「这个事件名上挂着订阅者」。
    declaredInProps: declaredOf(ctx, key),
    providerFiber: impl?.fiber?.name ?? null,
    getError,
    looseError,
    propError,
    methods: {},
  }
  if (svc) {
    for (const m of methods) {
      let value
      try { value = svc[m] } catch { value = undefined }
      if (typeof value === 'function') {
        // `.length` 是**形参个数**，不是「必填个数」——只当「方法还在不在 + 大致形状」用
        out.methods[m] = { kind: 'function', name: value.name || '(anonymous)', arity: value.length }
      } else {
        out.methods[m] = { kind: value === undefined ? 'missing' : typeof value }
      }
    }
  }
  return out
}

/**
 * cordis 的服务表是 **symbol 键**的（`Dict<Impl, symbol>`）——
 * `Object.values(store)` 拿到的是空数组，必须走 `getOwnPropertySymbols`。
 * 第一版就在这里踩过：探针报「宿主一个服务都没有」，其实只是查错了键。
 *
 * ⚠️ 这张表**随加载时机长大**，同一个探针两次跑出的数字完全不同（2026-10-15 实测）：
 *   · 模式 A（不 inject）load：符号键 8 个，五个目标服务一个都翻不到；
 *   · 模式 B（声明 inject）load：符号键 58 个，五个全部翻得到；
 *   · dispose：0 个（服务已经拆了）。
 * 原因不难懂：**不 inject 的插件在树还很浅的时候就 apply 了**，而声明 inject 的插件
 * 要等依赖就绪才被调用。所以「翻不到」只说明**那一刻**还没挂上，不等于宿主没有 ——
 * 判断「宿主有没有」请看声明表（props）。两处 store 都试：`ctx.reflect` 与
 * `ctx.root.reflect` 实测不是同一个实例。
 */
function storeValues(ctx) {
  const found = []
  for (const [label, store] of [
    ['ctx.reflect.store', safeStore(ctx, (c) => c?.reflect?.store)],
    ['ctx.root.reflect.store', safeStore(ctx, (c) => c?.root?.reflect?.store)],
  ]) {
    if (!store) continue
    const values = []
    for (const key of Object.keys(store)) values.push(store[key])
    for (const sym of Object.getOwnPropertySymbols(store)) values.push(store[sym])
    found.push({ label, values })
  }
  return found
}

function safeStore(ctx, pick) {
  try {
    const store = pick(ctx)
    return store && typeof store === 'object' ? store : null
  } catch {
    return null
  }
}

/** 在服务表里按名字翻一个实现（不要求 inject）。返回 `{impl, source}` 或 null。 */
function storeImpl(ctx, key) {
  for (const { label, values } of storeValues(ctx)) {
    for (const impl of values) {
      if (impl?.name === key) return { impl, source: label }
    }
  }
  return null
}

/** 「宿主声明了哪些服务」——来自 `ctx.reflect.props`（声明表，与实现无关）。查不到返回 null。 */
function declaredServices(ctx) {
  try {
    const props = ctx?.reflect?.props
    if (!props || typeof props !== 'object') return null
    const names = Object.keys(props).filter((n) => props[n]?.type === 'service')
    return { count: names.length, names: names.sort().slice(0, 300) }
  } catch {
    return null
  }
}

/** 单个名字在声明表里是什么类型（`service` / `accessor` / null=没声明）。 */
function declaredOf(ctx, key) {
  try {
    return ctx?.reflect?.props?.[key]?.type ?? null
  } catch {
    return null
  }
}

/** 事件名上有没有订阅者。返回 null = 查不了（内部结构变了），**不是**「没有」。 */
function hasListener(ctx, eventName) {
  try {
    const hooks = ctx?.events?._hooks
    if (!hooks || typeof hooks !== 'object') return null
    return Array.isArray(hooks[eventName]) && hooks[eventName].length > 0
  } catch {
    return null
  }
}

/** 查表用的诊断块：数字对不上时（比如「宿主一个服务都没有」）先看这里。 */
function cordisDiagnostics(ctx) {
  const out = {}
  try {
    const store = ctx?.reflect?.store
    out.reflectType = typeof ctx?.reflect
    out.storeType = typeof store
    out.storeStringKeys = store && typeof store === 'object' ? Object.keys(store).length : null
    out.storeSymbolKeys = store && typeof store === 'object' ? Object.getOwnPropertySymbols(store).length : null
    const props = ctx?.reflect?.props
    out.propsCount = props && typeof props === 'object' ? Object.keys(props).length : null
    out.propsSample = props && typeof props === 'object' ? Object.keys(props).slice(0, 24) : null
    // 我们关心的这几个名字在「声明表」里是什么类型：service / accessor / 没有
    if (props && typeof props === 'object') {
      const want = {}
      for (const key of Object.keys(SERVICES)) want[key] = props[key]?.type ?? null
      out.propsOfInterest = want
    }
  } catch (err) {
    out.error = err?.message ?? String(err)
  }
  try {
    out.fiberName = ctx?.fiber?.name ?? null
    out.rootIsSelf = ctx?.root === ctx
    out.rootSameReflect = ctx?.root?.reflect === ctx?.reflect
    out.getType = typeof ctx?.get
    out.contextOwnKeys = Object.keys(ctx).slice(0, 24)
  } catch (err) {
    out.fiberError = err?.message ?? String(err)
  }
  return out
}

export function apply(ctx) {
  const subscriptions = {}
  const observed = Object.create(null)

  for (const ev of EVENTS) {
    observed[ev.name] = 0
    try {
      const disposer = ctx.on(ev.name, (...args) => {
        observed[ev.name]++
        if (ev.mode !== 'waterfall') return undefined
        const next = args[args.length - 1]
        return typeof next === 'function' ? next() : undefined
      })
      subscriptions[ev.name] = typeof disposer === 'function'
    } catch (err) {
      subscriptions[ev.name] = `subscribe-failed: ${err?.message ?? err}`
    }
  }

  const outPath = process.env.SAGE_MEM_PROBE_OUT || join(tmpdir(), 'sage-mem-host-facts-probe.json')

  const snapshot = (phase) => {
    const services = {}
    for (const [key, methods] of Object.entries(SERVICES)) {
      services[key] = describeService(ctx, key, methods)
    }
    const events = {}
    for (const ev of EVENTS) {
      events[ev.name] = {
        mode: ev.mode,
        subscribable: subscriptions[ev.name] === true,
        subscribeResult: subscriptions[ev.name],
        // 事件名上有没有订阅者。Cordis **不校验事件名**（任何字符串都能订阅），所以
        // `subscribable:true` 什么也证明不了；这一项至少说明「有人在这个名字上挂了监听」。
        hasListeners: hasListener(ctx, ev.name),
        observed: observed[ev.name],
      }
    }
    return {
      phase,
      at: new Date().toISOString(),
      runtime: {
        node: process.version,
        electron: process.versions?.electron ?? null,
        platform: process.platform,
        argv: process.argv.slice(0, 3),
      },
      ctxGet: { present: typeof ctx?.get === 'function' },
      injectDeclared: inject,
      services,
      declaredServices: declaredServices(ctx),
      cordisDiagnostics: cordisDiagnostics(ctx),
      events,
      evidenceNote:
        'services.*.declaredInProps 来自 cordis 声明表（props），只说「宿主声明了这个服务」，' +
        '不等于本插件拿得到 —— 拿得到看 resolvedBy。' +
        'services 的声明表在 **load 阶段还没长齐**（实测 props 24 → 80 条），要读全表看 dispose 那份。' +
        'events.*.hasListeners 只说明事件名上有订阅者；observed 才是宿主真的派发过，' +
        '要等宿主跑过一轮 prompt 装配 / 工具调用才有值。',
    }
  }

  const emit = (phase) => {
    const data = snapshot(phase)
    const written = []
    // 每个阶段各留一份：**load 与 dispose 的结论会不一样**（实测 strict `ctx.get` 在收尾时
    // 拿不到东西 —— 提供方 fiber 已经离开 ACTIVE），只留最后一份等于把最有用的那份冲掉了。
    for (const target of [outPath, outPath.replace(/\.json$/i, '') + `.${phase}.json`]) {
      try {
        writeFileSync(target, JSON.stringify(data, null, 2), 'utf8')
        written.push(target)
      } catch (err) {
        written.push(`write-failed(${target}): ${err?.message ?? err}`)
      }
    }
    // 一份给人看、一份给机器读：headless 有 stdout，桌面版只有文件。
    console.log(`[sage-mem-probe] ${JSON.stringify({ ...data, written })}`)
  }

  emit('load')

  // 20s 后补一份快照：observed 要等宿主自己跑到那一步才有值。
  // unref —— 探针不该拖住宿主退出。
  const timer = setTimeout(() => emit('after-20s'), 20000)
  if (typeof timer?.unref === 'function') timer.unref()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      clearTimeout(timer)
      emit('dispose')
    })
  }
}
