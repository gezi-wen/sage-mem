#!/usr/bin/env node
/**
 * Q15 回归（2.1.20）：星图按需绘制的「入场 / 回放 / 隐藏」调度。
 *
 * 修前红（外部审查 2026-10-31 报告 Q15）：
 *   - `t0` 用 `Date.now()`，而 rAF 回调的 `ts` 与 `performance.now()` 同一原点 —— 相位成大负数；
 *   - tick 画完不继续 `schedule()`，入场只画一帧就停；
 *   - 诞生回放只 `setReveal`（改渲染器变量），不标脏 / 不唤醒绘制循环 —— 回放期间 0 次绘制；
 *   - `document.hidden` 时直接 return，从后台标签页回来再也画不出帧。
 *
 * 做法：把真实分片（05 / 10 / 11 / 12 / 13）拼进 vm，用假 WebGL 直接读每次 `render(phase)`
 * 写进去的 `uTime`（相位）与 `uRevealT`（回放时刻）—— 不猜像素、不引入浏览器专有 API。
 * rAF 队列与时钟全部由测试驱动，于是「入场推进 / 静止后不空转 / 回放逐帧 / 隐藏恢复」
 * 能逐条断言，且正常路径（hover 唤醒、静止后不画）也有反向对照。
 *
 * 用法: node test/review-211-q15-test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'
import {
  makeMiniReact, makeFakeDocument, makeGlNode, makeFakeFrames, uniformSeries,
  findAll, findButton,
} from './_client-vm-harness.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PARTS = [
  'client/05-shared.js',
  'client/10-starmap-head.js',
  'client/11-starmap-styles.js',
  'client/12-starmap-render.js',
  'client/13-starmap-panel.js',
]

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')) }
}
const group = (t) => console.log('\n── ' + t + ' ──')

/** 假时钟：performance.now 从 1000 起（单调）；Date.now 故意给 epoch —— 修前混用立刻露馅。 */
const CLOCK_START = 1000
const EPOCH_NOW = 1700000000000
const FULL_BRIGHT = 8.7e15
const BG_PROG = 1 // makeWebGLRenderer 里第一个创建的程序就是背景

const STARS = [
  { file: 'project_old.md', kind: 'project', title: '旧项目', desc: '很久以前', bytes: 4096, mtimeMs: EPOCH_NOW - 200 * 86400000 },
  { file: 'feedback_mid.md', kind: 'feedback', title: '反馈', desc: '中间', bytes: 2048, mtimeMs: EPOCH_NOW - 30 * 86400000 },
  { file: 'user_new.md', kind: 'user', title: '用户', desc: '最近', bytes: 1024, mtimeMs: EPOCH_NOW - 2 * 86400000 },
]

/** 拼分片 → vm 里跑 → 取回 StarMap（真实源组件）。 */
function loadStarMap(sandbox) {
  const code = PARTS.map((rel) => readFileSync(join(ROOT, rel), 'utf8')).join('\n') +
    '\n;globalThis.__q15 = { StarMap: StarmapRuntime.StarMap };\n'
  vm.createContext(sandbox)
  // prelude：分片 13 末尾是 `(function(require, react){...})(require, react)`，这两个名字得先有
  vm.runInContext('const require = function () { return new Proxy({}, { get: () => () => ({}) }); };\nconst react = __testReact;\n' + code, sandbox, { filename: 'client/05+10+11+12+13 (Q15)' })
  return sandbox.__q15
}

async function main() {
  const clock = { now: CLOCK_START }
  const frames = makeFakeFrames()
  const doc = makeFakeDocument()
  let perfCalls = 0

  class FakeMutationObserver { observe() {} disconnect() {} }
  class FakeDate extends Date { static now() { return EPOCH_NOW } }

  const starmapRemote = {
    listStars: () => Promise.resolve({ ok: true, value: { count: STARS.length, stars: STARS.map((s) => ({ ...s })) } }),
    readFile: (f) => Promise.resolve({ ok: true, value: { name: f, content: '# 正文' } }),
    restore: (f) => Promise.resolve({ ok: true, file: f }),
  }
  const memoryRemote = { restore: (f) => Promise.resolve({ ok: true, file: f }) }
  const ctx = {
    get: (name) => (name === 'remote.starmap' ? starmapRemote : name === 'remote.memory' ? memoryRemote : undefined),
  }

  const rt = makeMiniReact(makeGlNode)
  const sandbox = {
    __testReact: rt.api,
    console: { log() {}, warn() {}, error() {} },
    document: doc,
    window: frames,
    performance: { now: () => { perfCalls++; return clock.now } },
    MutationObserver: FakeMutationObserver,
    Date: FakeDate,
    setTimeout,
    clearTimeout,
  }
  const { StarMap } = loadStarMap(sandbox)
  ok(typeof StarMap === 'function', '从真实分片里取到 StarMap 组件')

  /** 推进 n 帧（每帧 16.7ms，默认 60fps 的 rAF 节奏）。 */
  const advance = (n, stepMs = 16.7) => {
    for (let i = 0; i < n; i++) { clock.now += stepMs; frames.frame(clock.now) }
  }
  const bgPhases = () => uniformSeries(node().gl, 'uTime', BG_PROG)
  const starReveals = () => {
    const gl = node().gl
    // 星点程序是第二个创建的程序（背景=1，星点=2，星座线=3）
    const starProg = gl._uniforms.find((u) => u.name === 'uRevealT') ? gl._uniforms.find((u) => u.name === 'uRevealT').prog : 2
    return uniformSeries(gl, 'uRevealT', starProg)
  }
  const node = () => [...rt.nodeCache.values()].find((nd) => nd.gl)

  let tree = await rt.settle(StarMap, { ctx })

  // ── 1. 入场动画：伪时钟下逐帧推进（修前红：只画一帧、相位是 epoch 级负数）──
  group('1. 入场动画：单调时钟 + 逐帧推进 + 到点收尾')
  {
    ok(!!node() && node().gl._draws > 0, '走的是 WebGL 主路径（能看到真 shader / uniform）')
    ok(perfCalls > 0, '动画时钟用 performance.now（修前一次都不碰，全用 Date.now）')
    const phases0 = bgPhases()
    ok(phases0.length === 1 && phases0[0] === 0, `挂载时先画一帧相位 0（实际 ${JSON.stringify(phases0)}）`)

    advance(90) // ≈1.5s，覆盖 1.3s 的入场窗口
    const phases = bgPhases()
    const last = phases[phases.length - 1]
    ok(phases.length >= 20, `入场期间真的逐帧重画（${phases.length} 帧；修前只有 1–2 帧）`)
    ok(phases.every((p) => p >= 0), `相位没有负数（修前推进帧是 -1.7e9 这种 epoch 差值）`, `最小 ${Math.min(...phases)}`)
    ok(phases.every((p, i) => i === 0 || p > phases[i - 1]), '相位单调递增（确实在推进，不是同一帧反复画）')
    ok(last >= 1.2 && last < 1.5, `入场在 ~1.3s 处收尾（末帧相位 ${last.toFixed(3)}）`)

    // 反向对照：入场结束后必须停 —— 静止的星空不许常驻空转
    const beforeIdle = bgPhases().length
    advance(40)
    ok(bgPhases().length === beforeIdle, '入场结束后 40 帧一帧都不画（静止即停）')
    ok(frames.pending() === 0, '静止后 rAF 队列为空（没有常驻空转）')
  }

  // ── 2. 诞生回放：reveal 每次变化都要落到画面上（修前红：0 次绘制）──
  group('2. 诞生回放：setReveal 之后必须有帧、时刻要推进')
  {
    const replayBtn = findButton(tree, '回放')
    ok(!!replayBtn, '头部有「回放」按钮（前置）')
    const beforeClick = starReveals().length
    replayBtn.props.onClick()
    tree = await rt.settle(StarMap, { ctx })
    ok(!!findButton(tree, '停止'), '回放开始后按钮变成「停止」（状态确实进了回放）')

    advance(50)
    const series = starReveals().slice(beforeClick)
    const real = series.filter((v) => v < FULL_BRIGHT)
    ok(series.length >= 10, `回放期间逐帧重画（${series.length} 帧；修前 0 帧）`)
    ok(real.length >= 10, `画的是回放时刻而不是全亮（${real.length} 帧带 reveal 值）`)
    ok(real.length >= 3 && real[real.length - 1] > real[0], `reveal 时刻在推进（${real[0]} → ${real[real.length - 1]}）`)

    // 反向对照：回放中「状态标签」每 250ms 更新一次，但渲染器不能因此被重建
    ok(node().gl._programs === 3, `整个回放只建过 1 个渲染器（3 个 program，实际 ${node().gl._programs}）`)
  }

  // ── 3. 停止回放：补一帧全亮，然后彻底安静 ──
  group('3. 停止回放：补画全亮一帧，之后不空转')
  {
    const stopBtn = findButton(tree, '停止')
    const beforeStop = starReveals().length
    stopBtn.props.onClick()
    tree = await rt.settle(StarMap, { ctx })
    ok(!!findButton(tree, '回放'), '停止后按钮回到「回放」')
    advance(5)
    const afterStop = starReveals().slice(beforeStop)
    ok(afterStop.length >= 1, `停止后补画了帧（${afterStop.length} 帧）`)
    ok(afterStop[afterStop.length - 1] === FULL_BRIGHT, '补画的是「全亮」（reveal 复位 null），不是停在回放中途')
    ok(frames.pending() === 0, '停止后 rAF 队列清空')

    const afterIdle = starReveals().length
    advance(30)
    ok(starReveals().length === afterIdle, '停止后再 30 帧一帧都不画')
  }

  // ── 4. 反向对照：静止后被 hover 唤醒一帧 ──
  group('4. 反向对照：markDirty 仍能单独唤醒一帧（不能把按需重绘改死）')
  {
    const canvas = findAll(tree, (n) => n.type === 'canvas')[0]
    const before = bgPhases().length
    canvas.props.onMouseLeave()
    advance(2)
    ok(bgPhases().length === before + 1, `onMouseLeave（markDirty）画了 1 帧（${before} → ${bgPhases().length}）`)
    const idleBefore = bgPhases().length
    advance(20)
    ok(bgPhases().length === idleBefore, '唤醒画完一帧后重新静止')
  }

  // ── 5. 页面隐藏：暂停帧、回来补一帧（修前红：没有 visibilitychange 监听）──
  group('5. 页面隐藏 / 恢复：不空转，回来补一帧')
  {
    ok(doc.listenerCount('visibilitychange') >= 1, '星图挂了 visibilitychange 监听（修前 0）')
    const before = bgPhases().length
    doc.hidden = true
    doc.fire('visibilitychange')
    advance(10)
    ok(bgPhases().length === before, '隐藏期间一帧都不画')
    ok(frames.pending() === 0, '隐藏期间不排 rAF（不后台空转）')

    doc.hidden = false
    doc.fire('visibilitychange')
    advance(2)
    ok(bgPhases().length === before + 1, `回到可见后补画 1 帧（${before} → ${bgPhases().length}）`)
    advance(20)
    ok(frames.pending() === 0, '恢复补帧后重新静止，没有常驻空转')
  }

  console.log(`\n结果：${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('harness error:', (e && e.stack) || e)
  process.exit(2)
})
