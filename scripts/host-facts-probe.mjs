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
 *     $probe = (Resolve-Path '<本仓库>\scripts\host-facts-probe.mjs').Path -replace '\\','/'
 *     $yml   = Join-Path $env:TEMP 'sage-mem-host-facts-probe.yml'
 *     "- insert:`n    - id: sage-mem-host-facts-probe`n      name: '$probe'" | Set-Content -Encoding ascii $yml
 *
 *   step 2  用 overlay 启一个**一次性**宿主。已经在跑的桌面版 / 网页版完全不受影响：
 *
 *     # 模式 A：不声明 inject（sage-mem 主插件的处境）
 *     dsh --profile headless --patch $yml "先用 write 工具写一个临时文件，再用 read 工具读回来"
 *
 *     # 模式 B：声明 inject —— 服务真拿得到，外加复现「插件自己写不发写入门事件」
 *     $env:SAGE_MEM_PROBE_INJECT = 'fs'
 *     dsh --profile headless --patch $yml "先用 write 工具写一个临时文件，再用 read 工具读回来"
 *     Remove-Item Env:\SAGE_MEM_PROBE_INJECT
 *
 *   ⚠️ 提示词必须**真的让模型调一次工具**：事件计数在那一轮没工具调用时全是 0，
 *   而 0 是「没触发」不是「事件不存在」—— 探针的检查会把这种情况判成 inconclusive。
 *   ⚠️ 顺带一句：让模型写文件的那一轮，**模型写的是宿主的 cwd**（通常就是本仓库目录）。
 *   实测跑几轮就在仓库根留下好几个 `tmp-*.txt` / `test-temp-file.txt` 之类的临时文件，
 *   其中一个还带上了内部称呼 —— 公开仓库里这是要清掉的垃圾。
 *   跑完记得 `git status --short` 看一眼；或者把提示词改成「写到系统临时目录」。
 *
 *   step 3  读产物（两处，取哪处看宿主形态）：
 *     · stdout 里的 `[sage-mem-probe] {...}` —— headless 能看见
 *     · 文件（桌面版没有可见 stdout，文件才可靠）：
 *         %TEMP%\sage-mem-host-facts-probe.load.json      ← 服务可达性 / 事件订阅的**主证据**
 *         %TEMP%\sage-mem-host-facts-probe.dispose.json   ← 收尾阶段（事件计数在这里最全）
 *         %TEMP%\sage-mem-host-facts-probe.json           ← 最后一次写入（= 最新阶段）
 *
 *   注：`dsh --profile headless --dump-config --patch $yml` 只验 patch 组合、**不加载模块**
 *   （实测：探针一句都不会打印），所以它不能替代 step 2。
 *
 * ── 这个探针负责复现的四件事（每条都在报告的 `checks` 里有对应检查）──
 *   1. **到达性**：事件能不能到一个**没声明 inject** 的插件手里（`tools/result` / `fs/*`）；
 *   2. **签名**：`tools/result` 的 `exec` 键名到底是什么（到达 ≠ 签名，必须分开验）；
 *   3. **交叉验证**：「数到的是真的」—— `tools/result` 记到的工具名必须在
 *      `tools/pre-execute` / `tools/execute` / `tools/post-execute` 里同样出现；
 *   4. **写入门只认工具发起**：插件自己调 `ctx.fs.writeText` 时 `fs/write-intent` 应当**一次都不发**。
 *      这条要求「写成功」也记下来 —— 写都没写成时的 0 是零信息量，检查会判 inconclusive。
 *
 * ── 写这类探针必踩的两个坑（都实测过，别重蹈）──
 *   · **`apply` 不许 `return` 一个函数**：宿主会拿它当别的东西用，随后崩在
 *     `Cannot read properties of undefined (reading 'contexts')`，整轮对话直接失败。
 *     要清理就登记成 `ctx.effect`。
 *   · **只为计数而 `ctx.on(waterfallEvent, () => count++)` 会掐断事件链**：宿主拿到
 *     `undefined` 后去读它的 `.contexts`，同样崩在上面那句。waterfall 类必须**原样放行**。
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
 *
 * ── 实测出来的三条硬事实（2026-10-15，headless）——不写 `inject` 时 ──
 *   1. `ctx.get('tools')`  → undefined（非严格读，不抛）
 *   2. `ctx.tools`         → **抛** `cannot get property "tools" without inject`
 *   3. `ctx.reflect.props` → 声明表里 `tools` / `systemPrompt` / `fs` / `tokenMeter` /
 *      `compaction` 都是 `service`（**宿主确实声明了它们**），但实现拿不到
 *   ⚠️ `ctx.reflect.store` 这条路**受加载时机影响**，不能单独用它判「宿主有没有」：
 *   模式 A 的 load 阶段只有 8 个符号键、翻不到目标服务；声明了 inject 的那次有 58 个、
 *   五个全翻得到；dispose 阶段是 0。判「宿主有没有」以声明表 `ctx.reflect.props` 为准。
 *   这正是 sage-mem 的 `svc()`（`ctx.get(name) ?? ctx[name]`）会抛的原因：
 *   前半句返回 undefined，后半句在没 inject 时直接抛 —— 降级契约必须把后半句包起来。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export const name = 'sage-mem-host-facts-probe'

/**
 * `inject` 由环境变量开关，好让**同一个探针文件**跑出两种事实：
 *
 *   （不设）                        → 无 inject：服务一律拿不到，只能看「宿主声明了什么」
 *   SAGE_MEM_PROBE_INJECT=tools,fs  → 声明 inject：服务真的拿得到，能读出方法签名
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
 * 要旁观的事件，以及**该怎么放行**。
 *
 * `kind` 决定顺手记什么形状：
 *   tool    → 记 `exec.name`（工具名）与首次 `exec` 的键名
 *   fs      → 记首次的 `target` 形状（只记键名与有没有 targetKey，**不记路径**）
 *   prompt  → 只计数
 *
 * ⚠️ `mode` 是踩过两次坑换来的：**waterfall 类必须原样放行**（`return next()`），
 * 只 `count++` 会让宿主拿到 `undefined`，整轮对话崩掉。emit 类不参与分发，只数即可。
 */
const EVENTS = [
  { name: 'tools/pre-execute', mode: 'waterfall', kind: 'tool' },
  { name: 'tools/execute', mode: 'waterfall', kind: 'tool' },
  { name: 'tools/post-execute', mode: 'waterfall', kind: 'tool' },
  { name: 'tools/result', mode: 'emit', kind: 'tool' },
  { name: 'fs/observed', mode: 'emit', kind: 'fs' },
  { name: 'fs/write-intent', mode: 'waterfall', kind: 'fs' },
  { name: 'fs/edit-intent', mode: 'waterfall', kind: 'fs' },
  { name: 'system-prompt/assemble', mode: 'waterfall', kind: 'prompt' },
]

/**
 * `tools/result` 的 `exec` 上，本探针**实测**见过、且 sage-mem 真要用的键。
 *
 * 为什么单列一张表：这是「声明」与「实测」的分界 —— 事件到达了不等于 `exec` 长这样，
 * 检查会拿这张表逐条对（缺任何一个 → fail，而不是含糊的「看起来差不多」）。
 */
const EXEC_KEY_BASELINE = ['token', 'callId', 'rootCallId', 'name', 'signal', 'agent', 'deferContext', 'concludeTurn', 'arguments']

/** 其中少一个就算检查不过的键（别的键宿主可以自由增删，这几个不行）。 */
const EXEC_REQUIRED_KEYS = ['name', 'arguments', 'callId', 'agent']

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * 把「观测到的事实」判成 7 条检查。**纯函数，不碰 ctx、不读盘**。
 *
 * 为什么要抽出来：探针**自己坏了**（计数没接上、写实验没跑成、事件被别的插件吃掉）
 * 也必须能被抓住 —— `test/host-facts-test.mjs` 就是拿合成观测来打这个函数的。
 * 只有一个在合成输入上会红的检查器，才配在真实宿主里报绿。
 *
 * 三态：`pass` / `fail` / `inconclusive`。**inconclusive 绝不读成 pass** ——
 * 「没触发」与「不成立」是两件事，混起来就是自欺。
 */
export function evaluateChecks(obs = {}) {
  const checks = []
  const resultCount = num(obs?.toolResult?.count)
  const names = Array.isArray(obs?.toolResult?.names) ? obs.toolResult.names : []
  const execKeys = Array.isArray(obs?.toolResult?.firstExecKeys) ? obs.toolResult.firstExecKeys : []
  const crossNames = [...new Set(Array.isArray(obs?.crossNames) ? obs.crossNames : [])]
  const preCount = num(obs?.preExecuteCount)

  // ① 到达性 —— 「事件能不能到一个没声明 inject 的插件手里」
  checks.push({
    id: 'tools_result_arrived',
    status: resultCount > 0 ? 'pass' : 'inconclusive',
    evidence: `tools/result=${resultCount}`,
    note: resultCount > 0
      ? '工具结果事件到达了本插件的 ctx'
      : '本轮没有工具调用 —— 0 是「没触发」，不是「事件不存在」',
  })

  // ② 签名 —— 到达 ≠ 签名，键名逐条对（这是「必须分开验」的落点）
  const missing = EXEC_REQUIRED_KEYS.filter((k) => !execKeys.includes(k))
  const unknownKeys = execKeys.filter((k) => !EXEC_KEY_BASELINE.includes(k))
  checks.push({
    id: 'exec_shape_matches_baseline',
    status: resultCount === 0 ? 'inconclusive' : (missing.length ? 'fail' : 'pass'),
    evidence: `keys=${JSON.stringify(execKeys)}${missing.length ? ` missing=${JSON.stringify(missing)}` : ''}${unknownKeys.length ? ` extra=${JSON.stringify(unknownKeys)}` : ''}`,
    note: '基准键：' + EXEC_KEY_BASELINE.join('/') + '（宿主多出来的键只记 extra，不算失败）',
  })

  // ③ 事件链一致性：出了结果的工具调用必然先经过 pre-execute。对不上 = 我们漏接了
  checks.push({
    id: 'tool_event_chain_consistent',
    status: resultCount === 0 ? 'inconclusive' : (preCount > 0 ? 'pass' : 'fail'),
    evidence: `tools/result=${resultCount} tools/pre-execute=${preCount}`,
    note: 'result 有数而 pre-execute 没数，说明计数链自己有问题（探针坏了，不是宿主没有）',
  })

  // ④ 名字是真的 —— 跨来源交叉验证。这一条就是「证明数到的是真的」那条要求
  let nameStatus = 'inconclusive'
  let nameNote = '本轮没有工具调用，没有名字可核'
  if (resultCount > 0) {
    const bad = names.filter((n) => typeof n !== 'string' || !n.trim())
    if (!names.length || bad.length) {
      nameStatus = 'fail'
      nameNote = '`exec.name` 不是可读的工具名 —— 计数可能根本不在 exec 上'
    } else if (!crossNames.length) {
      nameStatus = 'inconclusive'
      nameNote = '没有第二来源可交叉验证（pre/execute/post-execute 一个都没到达）'
    } else {
      const strays = names.filter((n) => !crossNames.includes(n))
      if (strays.length) {
        nameStatus = 'fail'
        nameNote = `这些名字只在 tools/result 出现、别的工具事件里没有：${JSON.stringify(strays)}`
      } else {
        nameStatus = 'pass'
        nameNote = 'tools/result 记到的工具名，在 pre-execute / execute / post-execute 里同样出现'
      }
    }
  }
  checks.push({
    id: 'exec_name_cross_checked',
    status: nameStatus,
    evidence: `names=${JSON.stringify(names)} cross=${JSON.stringify(crossNames)}`,
    note: nameNote,
  })

  // ⑤ 事实 2：插件**自己**写不发写入门事件。
  //    前提是「写真的成功了」—— 没写成时的 0 是零信息量，判 inconclusive 而不是 pass。
  const pw = obs?.pluginWrite ?? null
  const pwStatus = pw?.status ?? 'skipped'
  let writeStatus = 'inconclusive'
  let writeNote = '没做写实验：拿不到 fs 服务（本次探针没声明 inject=fs）'
  if (pwStatus === 'ok') {
    const delta = num(pw.intentsAfter) - num(pw.intentsBefore)
    writeStatus = delta === 0 ? 'pass' : 'fail'
    writeNote = delta === 0
      ? '插件自己写成功、写入门事件一次都没发 —— 门只对工具发起的写入生效'
      : `插件自己写也发了 ${delta} 次写入门事件 —— 事实 2 在这个宿主上不成立`
  } else if (pwStatus === 'failed') {
    writeNote = `写实验没写成（${pw?.error ?? '未知原因'}）—— 「不发事件」无从证明，不当成 pass`
  } else if (pwStatus === 'pending') {
    writeNote = '写实验还没跑完'
  }
  checks.push({
    id: 'plugin_write_emits_no_intent',
    status: writeStatus,
    evidence: `pluginWrite=${JSON.stringify(pw)}`,
    note: writeNote,
  })

  // ⑥ 写入门事件到底有没有到我们手里（这是写入门能不能成立的**唯一**前提）。
  //    ⚠️ 实测（2026-10-15，headless，7 组配置）：`fs/write-intent` 只送给**注册得足够早**的
  //    监听器 —— 同一个 ctx 上晚 2.5 秒注册的监听器收不到（而早监听器在它注册之后 0.5 秒
  //    确实收到了那次事件）；声明 inject / 用 ctx.inject 挂子 fiber 都会把注册推后到窗口之外。
  //    所以「工具写了却没到」是**真问题**，不能当成「本轮没写」含糊过去。
  const editTools = ['write', 'edit']
  const wroteByTool = (obs?.toolResult?.names ?? []).some((n) => editTools.includes(n))
  const writeIntentCount = num(obs?.counts?.['fs/write-intent'])
  checks.push({
    id: 'fs_intent_reaches_listener',
    status: writeIntentCount > 0 ? 'pass' : (wroteByTool ? 'fail' : 'inconclusive'),
    evidence: `fs/write-intent=${writeIntentCount} wroteByTool=${wroteByTool} tools=${JSON.stringify(obs?.toolResult?.names ?? [])}`,
    note: writeIntentCount > 0
      ? '写入门事件到达了本监听器'
      : wroteByTool
        ? '模型确实写了（工具名里有 write/edit），但写入门事件一次都没到 —— 注册窗口错过了'
        : '本轮没有写类工具调用，无法判断（inconclusive ≠ 事件不存在）',
  })

  // ⑦ 写入门事件的**可订阅性**：订阅上了不等于宿主会派发（Cordis 不校验事件名），
  //    所以这一条只回答「我们挂上去了吗」，把「会不会来」留给 observed 计数
  for (const ev of ['fs/write-intent', 'fs/edit-intent']) {
    const sub = obs?.subscriptions?.[ev]
    checks.push({
      id: `subscribed:${ev}`,
      status: sub === true ? 'pass' : (sub === false ? 'fail' : 'inconclusive'),
      evidence: `subscribable=${JSON.stringify(sub)}`,
      note: sub === true
        ? '监听器挂上了（挂上 ≠ 会派发，派发看该事件的 observed 计数）'
        : '监听器没挂上 —— 这条必须红，否则下面所有 0 都没有意义',
    })
  }

  return checks
}

/** 三态计数（给输出与断言用）。 */
export function summarizeChecks(checks = []) {
  return {
    pass: checks.filter((c) => c?.status === 'pass').length,
    fail: checks.filter((c) => c?.status === 'fail').length,
    inconclusive: checks.filter((c) => c?.status === 'inconclusive').length,
  }
}

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
 * 所以「翻不到」只说明**那一刻**还没挂上，不等于宿主没有。两处 store 都试：
 * `ctx.reflect` 与 `ctx.root.reflect` 实测不是同一个实例。
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
  const t0 = Date.now()
  const subscriptions = {}
  const observed = Object.create(null)
  const toolNames = Object.create(null)
  const firstExecKeys = Object.create(null)
  const firstTargets = Object.create(null)
  /** 每次 `fs/write-intent` 到达的相对时刻（毫秒）。用来判断「晚注册的监听器收不到」是不是时间问题。 */
  const writeIntentTimeline = []
  /**
   * 晚注册对照（`SAGE_MEM_PROBE_LATE_ON=1`）：apply 之后 2.5 秒再往**同一个** ctx 上挂一个
   * `fs/write-intent` 监听器。
   *
   * 为什么需要它：实测「fiber 里 inject 了 fs 就收不到 write-intent」。但另一种解释是
   * 「fs 提供方在某时刻就把监听器名单定了，之后注册的一律不算」。两者对写入门的设计含义
   * 完全不同（一个要换 fiber，一个要抢早注册），所以必须分辨：只要有一次到达的时刻
   * **晚于**晚注册时刻，晚监听器却仍然没收到，时间假说就被排除。
   */
  const lateWatch = { enabled: false, registeredAt: null, count: 0, arrivalsAfterRegister: 0 }
  /** 插件自己写那一次实验的状态机：skipped / pending / ok / failed。 */
  const pluginWrite = { status: 'skipped' }

  for (const ev of EVENTS) {
    observed[ev.name] = 0
    try {
      const disposer = ctx.on(ev.name, (...args) => {
        observed[ev.name]++
        if (ev.name === 'fs/write-intent' && writeIntentTimeline.length < 20) {
          writeIntentTimeline.push(Date.now() - t0)
        }
        // 顺手记形状：只记**键名与类型**，不记任何路径 —— 产物可能被贴进公开仓库
        if (ev.kind === 'tool') {
          const exec = args[0]
          const toolName = typeof exec?.name === 'string' ? exec.name : null
          const list = toolNames[ev.name] ?? (toolNames[ev.name] = [])
          if (toolName && !list.includes(toolName)) list.push(toolName)
          if (!firstExecKeys[ev.name] && exec && typeof exec === 'object') {
            firstExecKeys[ev.name] = Object.keys(exec)
          }
        } else if (ev.kind === 'fs' && !firstTargets[ev.name]) {
          const target = args[0]
          firstTargets[ev.name] = target && typeof target === 'object'
            ? { keys: Object.keys(target).slice(0, 8), hasTargetKey: !!target.targetKey }
            : { type: typeof target }
        }
        // ⚠️ waterfall 必须**原样放行**：只计数不调 next() 会把事件链掐断，
        // 宿主随后去读 `undefined.contexts`，整轮对话崩掉（实测踩过，见文件头）。
        if (ev.mode !== 'waterfall') return undefined
        const next = args[args.length - 1]
        return typeof next === 'function' ? next() : undefined
      })
      subscriptions[ev.name] = typeof disposer === 'function'
    } catch (err) {
      subscriptions[ev.name] = `subscribe-failed: ${err?.message ?? err}`
    }
  }

  /**
   * 同一批 `fs/*` 事件在 `ctx.root` 上**再挂一份**，只为回答一个问题：
   * 「同一个事件没收到，是监听器挂错了作用域，还是宿主真的没发？」
   *
   * 为什么非要有这一份（2026-10-15 实测，三轮一致）：
   *   · 不声明 inject → `fs/write-intent` 在 `ctx` 上收到 **1** 次（模型那次 write 工具）；
   *   · 声明 `inject: ['fs']` → 同一个提示词、同一个宿主，`ctx` 上收到 **0** 次，
   *     而 `tools/*` 与 `fs/observed` 的计数一模一样。
   * 也就是说「声明了 inject 就等于拿到了服务」是**错的**：服务拿到了，事件反而可能不来了。
   * 服务是对的、事件没了 —— 这种事只能靠两份计数并排看才分辨得出来。
   */
  const observedOnRoot = Object.create(null)
  try {
    if (ctx.root && ctx.root !== ctx && typeof ctx.root.on === 'function') {
      for (const ev of EVENTS) {
        if (ev.kind !== 'fs') continue
        observedOnRoot[ev.name] = 0
        ctx.root.on(ev.name, (...args) => {
          observedOnRoot[ev.name]++
          if (ev.mode !== 'waterfall') return undefined
          const next = args[args.length - 1]
          return typeof next === 'function' ? next() : undefined
        })
      }
    }
  } catch {
    // 挂不上就算了 —— 这一份是诊断，不是探针的主证据
  }

  /** 晚注册对照：2.5 秒后再往同一个 ctx 上挂一个 write-intent 监听器（见上面的说明）。 */
  if (process.env.SAGE_MEM_PROBE_LATE_ON === '1') {
    lateWatch.enabled = true
    const lateTimer = setTimeout(() => {
      lateWatch.registeredAt = Date.now() - t0
      try {
        ctx.on('fs/write-intent', (...args) => {
          lateWatch.count++
          const next = args[args.length - 1]
          return typeof next === 'function' ? next() : undefined
        })
      } catch (err) {
        lateWatch.error = String(err?.message ?? err).slice(0, 200)
      }
    }, 2500)
    if (typeof lateTimer?.unref === 'function') lateTimer.unref()
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearTimeout(lateTimer))
  }

  /**
   * 附加实验（`SAGE_MEM_PROBE_SUBFIBER=1` 才开）：把 `fs/*` 监听器挂在 `ctx.inject`
   * 的**子 fiber** 里，而不是顶层 `export const inject`。
   *
   * 为什么要这一档：实测「顶层声明 inject（tools / tokenMeter / fs 都一样）之后
   * `fs/write-intent` 就到不了」，而 sage-mem 主插件走的正是 `ctx.inject` 挂子 fiber
   * 这条路（见 docs/decisions.md D5）。写入门能不能成立，取决于这两种挂法的到达性
   * **是不是一样** —— 这是给写入门定方案前必须知道的一件事。
   */
  const subFiber = { used: false, mounted: false, error: '', writeIntent: 0, observed: 0 }
  if (process.env.SAGE_MEM_PROBE_SUBFIBER === '1' && typeof ctx.inject === 'function') {
    subFiber.used = true
    try {
      ctx.inject(['fs'], (sub) => {
        subFiber.mounted = true
        for (const ev of EVENTS) {
          if (ev.kind !== 'fs') continue
          sub.on(ev.name, (...args) => {
            if (ev.name === 'fs/write-intent') subFiber.writeIntent++
            if (ev.name === 'fs/observed') subFiber.observed++
            if (ev.mode !== 'waterfall') return undefined
            const next = args[args.length - 1]
            return typeof next === 'function' ? next() : undefined
          })
        }
      })
    } catch (err) {
      subFiber.error = String(err?.message ?? err).slice(0, 200)
    }
  }

  /**
   * 事实 2 的复现：**插件自己**调一次 `ctx.fs.writeText`，看 `fs/write-intent` 会不会动。
   *
   * 为什么必须把「写成功没」也记下来：写都没写成时 delta=0 是零信息量（零除以零），
   * 那种情况检查必须判 inconclusive 而不是 pass —— 这是「证明数到的是真的」那一条的落点。
   * 写的是**合成内容**、落在系统临时目录，跑完就删；产物里不留路径。
   */
  const runPluginWrite = async () => {
    // 关掉写实验的开关。存在的理由：要分辨「声明 inject=fs 本身」与「插件自己写了一笔」
    // 各自对 `fs/write-intent` 到达性的影响 —— 少了这一档就只能猜，而这是给写入门定方案的关键。
    if (process.env.SAGE_MEM_PROBE_NO_WRITE === '1') {
      pluginWrite.status = 'skipped'
      pluginWrite.skippedReason = 'SAGE_MEM_PROBE_NO_WRITE=1'
      return
    }
    let fsSvc
    try { fsSvc = typeof ctx.get === 'function' ? ctx.get('fs', false) : undefined } catch { fsSvc = undefined }
    if (!fsSvc) {
      try { fsSvc = ctx.fs } catch { fsSvc = undefined }
    }
    if (!fsSvc || typeof fsSvc.resolve !== 'function' || typeof fsSvc.writeText !== 'function') {
      pluginWrite.status = 'skipped'
      return
    }
    pluginWrite.status = 'pending'
    let dir = ''
    try {
      dir = mkdtempSync(join(tmpdir(), 'sage-mem-probe-'))
      pluginWrite.intentsBefore = num(observed['fs/write-intent'])
      const target = await fsSvc.resolve(join(dir, 'synthetic-probe.md'))
      const out = await fsSvc.writeText(target, '# 合成探针文件\n\n这段内容只用于观测写入门事件，与任何真实内容无关。\n')
      pluginWrite.intentsAfter = num(observed['fs/write-intent'])
      pluginWrite.wrote = true
      pluginWrite.afterBytes = typeof out?.after === 'string' ? Buffer.byteLength(out.after, 'utf8') : null
      pluginWrite.operation = out?.operation ?? null
      pluginWrite.status = 'ok'
    } catch (err) {
      pluginWrite.status = 'failed'
      pluginWrite.error = String(err?.message ?? err).slice(0, 200)
    } finally {
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
      }
    }
  }
  // 故意不 await：apply 必须是同步的，宿主不接受一个挂起的初始化
  runPluginWrite().catch((err) => {
    pluginWrite.status = 'failed'
    pluginWrite.error = String(err?.message ?? err).slice(0, 200)
  })

  const outPath = process.env.SAGE_MEM_PROBE_OUT || join(tmpdir(), 'sage-mem-host-facts-probe.json')

  /** 把当前计数与样本收成一个「观测」—— 判定逻辑在 evaluateChecks 里，探针只负责数。 */
  const observation = () => ({
    subscriptions: { ...subscriptions },
    counts: { ...observed },
    toolResult: {
      count: num(observed['tools/result']),
      names: toolNames['tools/result'] ?? [],
      firstExecKeys: firstExecKeys['tools/result'] ?? [],
    },
    crossNames: [
      ...(toolNames['tools/pre-execute'] ?? []),
      ...(toolNames['tools/execute'] ?? []),
      ...(toolNames['tools/post-execute'] ?? []),
    ],
    preExecuteCount: num(observed['tools/pre-execute']),
    pluginWrite: { ...pluginWrite },
  })

  const snapshot = (phase) => {
    const services = {}
    for (const [key, methods] of Object.entries(SERVICES)) {
      services[key] = describeService(ctx, key, methods)
    }
    const events = {}
    for (const ev of EVENTS) {
      events[ev.name] = {
        mode: ev.mode,
        kind: ev.kind,
        subscribable: subscriptions[ev.name] === true,
        subscribeResult: subscriptions[ev.name],
        // 事件名上有没有订阅者。Cordis **不校验事件名**（任何字符串都能订阅），所以
        // `subscribable:true` 什么也证明不了；这一项至少说明「有人在这个名字上挂了监听」。
        hasListeners: hasListener(ctx, ev.name),
        observed: observed[ev.name],
      }
      if (ev.kind === 'tool') {
        events[ev.name].toolNames = toolNames[ev.name] ?? []
        events[ev.name].firstExecKeys = firstExecKeys[ev.name] ?? null
      }
      if (ev.kind === 'fs') {
        events[ev.name].firstTarget = firstTargets[ev.name] ?? null
        // 与 observed 并排看：两者不一致 = 监听器作用域问题，而不是宿主没发
        events[ev.name].observedOnRoot = observedOnRoot[ev.name] ?? null
      }
    }
    const checks = evaluateChecks(observation())
    return {
      phase,
      at: new Date().toISOString(),
      runtime: {
        node: process.version,
        electron: process.versions?.electron ?? null,
        platform: process.platform,
        // 只留 flag、不留可执行文件路径：产物可能被贴进公开仓库，绝对路径是环境信息
        argvFlags: process.argv.filter((a) => a.startsWith('--')).slice(0, 8),
      },
      ctxGet: { present: typeof ctx?.get === 'function' },
      injectDeclared: inject,
      services,
      declaredServices: declaredServices(ctx),
      cordisDiagnostics: cordisDiagnostics(ctx),
      events,
      pluginWrite: { ...pluginWrite },
      subFiber: { ...subFiber },
      lateWatch: {
        ...lateWatch,
        // 早监听器上**晚于**晚注册时刻到达的次数：>0 而 lateWatch.count === 0
        // ⇒ 「收不到」与注册时间无关（时间假说被排除）。
        earlyArrivalsAfterLateRegister: lateWatch.registeredAt === null
          ? null
          : writeIntentTimeline.filter((t) => t > lateWatch.registeredAt).length,
      },
      writeIntentTimeline,
      checks,
      checksSummary: summarizeChecks(checks),
      evidenceNote:
        'services.*.declaredInProps 来自 cordis 声明表（props），只说「宿主声明了这个服务」，' +
        '不等于本插件拿得到 —— 拿得到看 resolvedBy。' +
        'services 的声明表在 **load 阶段还没长齐**（实测 props 24 → 80 条），要读全表看 dispose 那份。' +
        'events.*.hasListeners 只说明事件名上有订阅者；observed 才是宿主真的派发过，' +
        '要等宿主跑过一轮 prompt 装配 / 工具调用才有值。' +
        'checks 的三态里 inconclusive **不等于** pass：没触发与不成立是两件事。',
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
        written.push(basename(target))
      } catch (err) {
        written.push(`write-failed(${basename(target)}): ${err?.message ?? err}`)
      }
    }
    // 一份给人看、一份给机器读：headless 有 stdout，桌面版只有文件。
    console.log(`[sage-mem-probe] ${JSON.stringify({ ...data, written })}`)
    // 默认只记录、不改宿主的成败；显式要求时才让 fail 变成非零退出码（一次性宿主里当 CI 用）。
    if (process.env.SAGE_MEM_PROBE_STRICT === '1' && data.checksSummary.fail > 0) {
      process.exitCode = 1
    }
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
