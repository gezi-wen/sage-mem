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
group('1. 组合根体积（1.2.0 验收线）')
{
  const n = linesOf('index.js')
  ok(n <= 800, `lib/index.js ≤ 800 行（实际 ${n}；1.1.0 是 1431）`)
  const src = read('index.js')
  const start = src.indexOf('  constructor(ctx) {')
  const end = src.indexOf('\n  }\n', start)
  const ctorLines = start >= 0 && end > start ? src.slice(start, end).split('\n').length : Infinity
  ok(ctorLines <= 60, `MemoryGateway 构造函数 ≤ 60 行（实际 ${ctorLines}；1.1.0 是 540）`, `start=${start} end=${end}`)
  const maxFile = all.filter((f) => f.rel !== 'client.js').reduce((a, b) => (a.lines >= b.lines ? a : b))
  // 1.7.0 把这条从 900 抬到 950：`memory/recallDebug` 的 strict schema 是**传输契约**，
  // 必须与它镜像的 payload 放在同一个 manifest 文件里；861 → 909 是一次性增长
  // （一条只读 remote 的字段声明），不是逻辑膨胀。别的阈值（组合根 ≤800 / 构造 ≤60）
  // 一个都没动 —— 这条护栏防的是「往 lib 里塞逻辑」，不是防 schema 行数。
  ok(maxFile.lines <= 950, `lib/ 下单文件 ≤ 950 行（最大 ${maxFile.rel} ${maxFile.lines} 行；client.js 是构建产物不计）`)
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
  ok(localImps.length <= 18, `组合根的本地 import 条数 ≤ 18（实际 ${localImps.length}）`, localImps.join(','))
  ok(/ctx\.on\('system-prompt\/assemble', createRecallInjector\(/.test(src), '注入监听器由 createRecallInjector 注册')
  ok(!/ctx\.inject\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
    '组合根里没有 ctx.inject（写门的注册窗口约束）')
}

// ── 4. typert 契约位置没动 ──────────────────────────────────────
group('4. typert 契约：33 条 invocation 仍指 lib/index.js')
{
  const { TYPERT } = await import(new URL('../lib/typert.host.js', import.meta.url).href)
  // 33 = 1.6.5 的 32 + 1.7.0 的 memory/recallDebug。数字变了要**同时**改
  // client-exec-test 里的对表计数 —— 两处一起红才是「漏了一边」的正确定位信号。
  ok(TYPERT.invocations.length === 33, `33 条 invocation（实际 ${TYPERT.invocations.length}）`)
  const bad = TYPERT.invocations.filter((i) => !(i.sourceLocation?.file === 'lib/index.js' && i.sourceLocation?.line === 1 && i.sourceLocation?.column === 1))
  ok(bad.length === 0, '每条 sourceLocation 仍是 lib/index.js:1:1（搬 Gateway 类就必须同步改这里）', bad.slice(0, 3).map((i) => i.id).join(','))
  const src = read('index.js')
  for (const cls of ['MemoryGateway', 'StarmapGateway', 'AutodreamGateway']) {
    ok(new RegExp(`export class ${cls} extends TypertRemoteService`).test(src), `${cls} 仍定义在 lib/index.js（契约位置）`)
  }
  ok((src.match(/^markRemote\(/gm) || []).length === 33, '33 条 markRemote 仍在组合根里')
  // 1.7.0：调试账必须是**只读**（无入参）—— 面板只许看，不许改账。
  const dbg = TYPERT.invocations.find((i) => i.id === 'sage-mem#memory/recallDebug')
  ok(!!dbg && dbg.parameters.length === 0, 'memory/recallDebug 存在且无入参（只读）')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
