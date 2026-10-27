#!/usr/bin/env node
/**
 * 结构守卫（1.2.0 新增）：把「组合根应该长什么样」变成会红的断言。
 *
 * 为什么需要它：1.2.0 的目标不是「这次搬干净了」，而是「下次它不会长回去」。
 * 光靠 golden 只能证明行为没变，证明不了结构 —— 有人把注入链再写回构造函数，
 * golden 照样全绿。这 14 条盯的就是结构本身（体积 / 依赖方向 / 契约位置）。
 *
 * 阈值不是审美：`lib/index.js` ≤ 800 行是 1.2.0 的验收线（搬之前 1431）；
 * 构造函数 ≤ 60 行对应「只剩四块挂载 + 两行接线」。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))
const read = (rel) => readFileSync(join(LIB, rel), 'utf8')
const linesOf = (rel) => read(rel).split('\n').length

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

const all = walk(LIB).map((p) => ({ rel: relative(LIB, p).replace(/\\/g, '/'), src: readFileSync(p, 'utf8'), lines: readFileSync(p, 'utf8').split('\n').length }))
const importsOf = (src) => [...src.matchAll(/^import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])

// ── 1. 组合根体积 ───────────────────────────────────────────────
group('1. 组合根体积（1.2.0 验收线；2.0.0 按 D21 的契约位置调整）')
{
  const n = linesOf('index.js')
  // 800 → 1000（2.0.0）：第四块 Gateway（ConflictGateway）按 D21 **必须**定义在组合根里
  // （typert 的 `sourceLocation` 全表硬编码 lib/index.js:1:1，搬走就是契约漂移）。
  // 它带来的是「一个类 + 6 个 remote 的薄方法」，不是注入链逻辑 —— 下面构造函数 ≤60 行、
  // 「注入状态不在组合根」两条仍在，防的是后者。组合根真正的逻辑增长仍会让别的套件变红。
  ok(n <= 1000, `lib/index.js ≤ 1000 行（实际 ${n}；1.1.0 是 1431）`)
  const src = read('index.js')
  const start = src.indexOf('  constructor(ctx) {')
  const end = src.indexOf('\n  }\n', start)
  const ctorLines = start >= 0 && end > start ? src.slice(start, end).split('\n').length : Infinity
  ok(ctorLines <= 60, `MemoryGateway 构造函数 ≤ 60 行（实际 ${ctorLines}；1.1.0 是 540）`, `start=${start} end=${end}`)
  const maxFile = all.filter((f) => f.rel !== 'client.js').reduce((a, b) => (a.lines >= b.lines ? a : b))
  // 900 → 950（1.7.0）→ 1100（2.0.0）：`memory/recallDebug` 与 6 条 `conflict.*` 的 strict
  // schema 都是**传输契约**，必须与它镜像的 payload 放在同一个 manifest 文件里。
  // 这条护栏防的是「往 lib 里塞逻辑」，不是防 schema 行数（39 条 invocation 的字段声明本来就会长）。
  ok(maxFile.lines <= 1100, `lib/ 下单文件 ≤ 1100 行（最大 ${maxFile.rel} ${maxFile.lines} 行；client.js 是构建产物不计）`)
  ok(!/function createSessionInjectState\s*\(/.test(src), '注入状态不再定义在组合根里（已搬到 recall/state.js）')
}

// ── 2. 依赖方向 ─────────────────────────────────────────────────
group('2. 依赖方向：memory 不认识 autodream，recall 不认识组合根')
{
  const bad = []
  for (const f of all.filter((x) => x.rel.startsWith('memory/'))) {
    for (const i of importsOf(f.src)) {
      if (i.includes('autodream') || i.includes('recall/') || i.includes('assembly/') || i.startsWith('./index.js')) bad.push(`${f.rel} → ${i}`)
    }
  }
  ok(bad.length === 0, 'lib/memory/** 不 import autodream / recall / assembly / 组合根', bad.slice(0, 3).join('；'))

  const recallBad = []
  for (const f of all.filter((x) => x.rel.startsWith('recall/'))) {
    for (const i of importsOf(f.src)) {
      const okTarget = i.startsWith('./') || i.startsWith('../memory/')
      if (!okTarget) recallBad.push(`${f.rel} → ${i}`)
    }
  }
  ok(recallBad.length === 0, 'lib/recall/** 只依赖 recall 内部与 ../memory/**（不碰组合根 / autodream）', recallBad.slice(0, 3).join('；'))

  const asmBad = []
  for (const f of all.filter((x) => x.rel.startsWith('assembly/'))) {
    for (const i of importsOf(f.src)) {
      if (i.startsWith('../index.js') || i.includes('/index.js')) asmBad.push(`${f.rel} → ${i}`)
    }
  }
  ok(asmBad.length === 0, 'lib/assembly/** 不反向 import 组合根（无循环依赖）', asmBad.slice(0, 3).join('；'))

  const settingsImports = importsOf(read('settings.js'))
  ok(!settingsImports.some((i) => i.includes('index.js')), 'lib/settings.js 不依赖组合根')
}

// ── 3. 组合根只通过 barrel 认识新模块 ────────────────────────────
group('3. 组合根接线：barrel + 直调 mountWriteGate')
{
  const src = read('index.js')
  const imps = importsOf(src)
  ok(imps.includes('./recall/index.js'), '组合根经 lib/recall/index.js 认识注入链')
  ok(imps.includes('./assembly/index.js'), '组合根经 lib/assembly/index.js 认识四块挂载')
  const localImps = imps.filter((i) => i.startsWith('./') || i.startsWith('../'))
  // 18 → 20（2.0.0）：冲突裁决这一域新增两个真实依赖（memory/conflicts.js 的记录层与
  // memory/arbitrate.js 的写路径）。条数护栏防的是「随手 import、依赖面发散」，
  // 这里两条都是新能力的直接落点，不是给组合根找捷径。
  ok(localImps.length <= 20, `组合根的本地 import 条数 ≤ 20（实际 ${localImps.length}）`, localImps.join(','))
  ok(/ctx\.on\('system-prompt\/assemble', createRecallInjector\(/.test(src), '注入监听器由 createRecallInjector 注册')
  ok(!/ctx\.inject\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
    '组合根里没有 ctx.inject（写门的注册窗口约束）')
}

// ── 4. typert 契约位置没动 ──────────────────────────────────────
group('4. typert 契约：39 条 invocation 仍指 lib/index.js')
{
  const { TYPERT } = await import(new URL('../lib/typert.host.js', import.meta.url).href)
  // 39 = 1.9.2 的 33 + 2.0.0 的 6 条 conflict.*（list/read/invalidate/dismiss/undo/remove）。
  // 数字变了要**同时**改 client-exec-test 里的对表计数 —— 两处一起红才是「漏了一边」的正确定位信号。
  ok(TYPERT.invocations.length === 39, `39 条 invocation（实际 ${TYPERT.invocations.length}）`)
  const bad = TYPERT.invocations.filter((i) => !(i.sourceLocation?.file === 'lib/index.js' && i.sourceLocation?.line === 1 && i.sourceLocation?.column === 1))
  ok(bad.length === 0, '每条 sourceLocation 仍是 lib/index.js:1:1（搬 Gateway 类就必须同步改这里）', bad.slice(0, 3).map((i) => i.id).join(','))
  const src = read('index.js')
  for (const cls of ['MemoryGateway', 'StarmapGateway', 'AutodreamGateway', 'ConflictGateway']) {
    ok(new RegExp(`export class ${cls} extends TypertRemoteService`).test(src), `${cls} 仍定义在 lib/index.js（契约位置）`)
  }
  ok((src.match(/^markRemote\(/gm) || []).length === 39, '39 条 markRemote 仍在组合根里')
  // 1.7.0：调试账必须是**只读**（无入参）—— 面板只许看，不许改账。
  const dbg = TYPERT.invocations.find((i) => i.id === 'sage-mem#memory/recallDebug')
  ok(!!dbg && dbg.parameters.length === 0, 'memory/recallDebug 存在且无入参（只读）')
  // 2.0.0：冲突面 6 条，全部挂在 conflict namespace 下，且都指向组合根。
  const conflictInvs = TYPERT.invocations.filter((i) => i.service === 'conflict')
  ok(conflictInvs.length === 6, `conflict.* 6 条（实际 ${conflictInvs.length}）`)
  ok(conflictInvs.every((i) => i.namespace === 'conflict'), 'conflict.* 的 namespace 都是 conflict')

  // ⚠️ 0.2.x 宿主的客户端 RemoteNamespaceService（继承 Cordis Service）原型上已占用的方法名。
  // 客户端声明同名方法 → `ctx.remote.$mount` 的 `assertMethodAvailable` 抛错 →
  // **整个 client 插件 activate 失败**（不是单个按钮失效）。2026-10-27 真机踩过
  // `conflict/remove`（`client api: method "conflict/remove" conflicts with its namespace service`）。
  // 这份名单只列**已确认**的（来源是宿主异常原文）；以后新加 remote 再撞同类错时补进来。
  const CLIENT_RESERVED_METHODS = new Set(['remove'])
  const clash = TYPERT.invocations.filter((i) => CLIENT_RESERVED_METHODS.has(i.method)).map((i) => i.id)
  ok(clash.length === 0, '没有任何 remote 方法名撞上宿主客户端命名空间的保留名', clash.join(','))
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
