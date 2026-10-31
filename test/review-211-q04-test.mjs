#!/usr/bin/env node
/**
 * review-211-q04-test.mjs — Q04（外部审查 2.1.1）：面板上限设置写入后，重启仍不生效。
 *
 * 根因：五项上限的常量只从 `envInt()` 生成，**不读 `<状态根>/settings.json`**；
 * 而面板的 `pendingLimits` 读它 —— 于是 UI 永远显示「待重启」，重启也永远不会加载，
 * 与 README「设置页 > 环境变量 > 默认值」的优先序相反。
 *
 * 判据全部落在**真实子进程**上：一个进程保存、进程退出、另一个进程读回来。
 * 只断言返回值不算证据 —— 这条 bug 恰恰是「写盘成功但下一次启动没读」。
 *
 * 覆盖（报告 §Q04「怎么验」）：五个字段逐一「保存 → 结束进程 → 新进程读取」；
 * 无设置文件 / 非法 JSON / 环境变量与持久值同时存在时的优先级；修前红 / 修后绿。
 *
 * 用法: node test/review-211-q04-test.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')
const INDEX = pathToFileURL(join(ROOT, 'lib', 'index.js')).href

const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-q04-'))
let stateSeq = 0
/** 每个字段一套独立状态根：五条「保存 → 重启」互不串味。 */
function freshState(tag) {
  const dir = join(sandbox, `state-${tag}-${++stateSeq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 干净环境：清掉开发机上的全部 SAGE_MEM_*（含 run.mjs 沙箱注入的那几个），
 * 再显式指向本套件的临时目录。**不删 MAX_* 就不能证明「默认值」是默认值**。
 */
function cleanEnv(stateDir) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('SAGE_MEM_')) delete env[k]
  delete env.DSH_HOME
  env.SAGE_MEM_DIR = join(sandbox, 'memory')
  env.SAGE_MEM_STATE_DIR = stateDir
  env.DSH_HOME = join(sandbox, 'dsh-home')
  return env
}

function runNode(code, env) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env, cwd: ROOT })
  return { status: r.status === null ? 1 : r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}
function parseChild(r) {
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'))
  if (!line) throw new Error(`子进程没打出结果：status=${r.status} stderr=${r.stderr.slice(0, 500)}`)
  return JSON.parse(line.slice(2))
}

/** 保存（真实 API，真实落盘）。 */
const SAVE = (patch) => `
  const { MemoryGateway } = await import(${JSON.stringify(INDEX)})
  const gw = Object.create(MemoryGateway.prototype)
  console.log('@@' + JSON.stringify(await gw.setSettings(${JSON.stringify(patch)})))
`
/** 新进程读：生效值 / 待生效值 / 是否喊重启 / 诊断。 */
const READ = `
  const { MemoryGateway } = await import(${JSON.stringify(INDEX)})
  const s = await Object.create(MemoryGateway.prototype).getSettings()
  console.log('@@' + JSON.stringify({
    limits: s.limits, pendingLimits: s.pendingLimits,
    restartRequired: s.restartRequired, diagnostics: s.limitDiagnostics,
  }))
`
const DEFAULTS = { maxResults: 10, maxChars: 1500, maxBaseline: 8, maxSessionBytes: 60 * 1024, staleDays: 1 }
const FIELDS = [
  ['maxResults', 3],
  ['maxChars', 900],
  ['maxBaseline', 4],
  ['maxSessionBytes', 81920],
  ['staleDays', 7],
]

// ═══ 1. 五个字段逐个「保存 → 结束进程 → 新进程读取」 ═══
group('1. Q04 主判据：五个上限保存后，新进程读到的**生效值**就是保存值')
{
  for (const [key, value] of FIELDS) {
    const dir = freshState(`field-${key}`)
    const env = cleanEnv(dir)
    const saved = parseChild(runNode(SAVE({ limits: { [key]: value } }), env))
    ok(saved.ok === true, `[${key}] setSettings 保存成功（退出码之外还要看返回值）`, JSON.stringify(saved))
    // ⚠️ 上面那个子进程已经退出 —— 这才是「结束进程」；下面在新进程里读。
    const read = parseChild(runNode(READ, env))
    ok(read.limits[key] === value,
      `[${key}] 新进程的生效值 = 保存值 ${value}（修前这里是内置默认 ${DEFAULTS[key]}）`,
      `实际 ${read.limits[key]}`)
    ok(read.pendingLimits[key] === value && read.restartRequired === false,
      `[${key}] 新进程不再喊「待重启」（pending 与生效值一致）`,
      JSON.stringify({ pending: read.pendingLimits[key], restartRequired: read.restartRequired }))
    let disk = null
    try { disk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) } catch { /* 下面断言会红 */ }
    ok(disk?.limits?.[key] === value, `[${key}] 盘上 settings.json 里确实有这个值（排除「只在内存里」）`, JSON.stringify(disk?.limits))
  }
}

// ═══ 2. 无设置文件：内置默认，且不误报重启、不产生噪音诊断 ═══
group('2. 没有 settings.json：五项都是内置默认')
{
  const read = parseChild(runNode(READ, cleanEnv(freshState('no-file'))))
  ok(JSON.stringify(read.limits) === JSON.stringify(DEFAULTS), '五项生效值都是内置默认', JSON.stringify(read.limits))
  ok(JSON.stringify(read.pendingLimits) === JSON.stringify(DEFAULTS), 'pendingLimits 同样是内置默认')
  ok(read.restartRequired === false, '没有覆盖时不喊重启')
  ok(Array.isArray(read.diagnostics) && read.diagnostics.length === 0,
    '「文件不存在」是正常状态，不产生诊断', JSON.stringify(read.diagnostics))
}

// ═══ 3. 优先级：持久设置 > 环境变量 > 默认（启动解析与面板 pending 同一口径） ═══
group('3. 环境变量与持久值同时存在 → 持久值赢；另一边必须证明环境变量本身有效')
{
  const dir = freshState('priority')
  const env = cleanEnv(dir)
  env.SAGE_MEM_MAX_RESULTS = '9'
  env.SAGE_MEM_MAX_CHARS = '800'
  parseChild(runNode(SAVE({ limits: { maxResults: 4 } }), env))
  const read = parseChild(runNode(READ, env))
  ok(read.limits.maxResults === 4,
    '启动生效值取持久设置 4，而不是环境变量 9（README 的优先序）', `实际 ${read.limits.maxResults}`)
  ok(read.pendingLimits.maxResults === 4, '面板 pending 与启动解析同一口径（都取 4，不是 9）',
    `pending ${read.pendingLimits.maxResults}`)
  ok(read.limits.maxChars === 800,
    '同一份环境里另一项仍按环境变量生效（证明环境变量没被整体忽略）', `实际 ${read.limits.maxChars}`)
  ok(read.restartRequired === false, '两者的生效值完全一致，不喊重启')

  // 反向对照：删掉持久设置后，同一个环境变量必须重新生效
  rmSync(join(dir, 'settings.json'))
  const again = parseChild(runNode(READ, env))
  ok(again.limits.maxResults === 9 && again.pendingLimits.maxResults === 9,
    '【反向对照】删除 settings.json 后环境变量 9 重新生效', JSON.stringify(again.limits))
}

// ═══ 4. 非法 JSON：不崩、不静默 —— 明确诊断 + 拒绝覆盖坏文件 ═══
group('4. settings.json 是坏 JSON：按环境变量/默认值生效，但必须留下明确诊断')
{
  const dir = freshState('corrupt')
  const env = cleanEnv(dir)
  writeFileSync(join(dir, 'settings.json'), '{broken', 'utf8')
  const r = runNode(READ, env)
  const read = parseChild(r)
  ok(JSON.stringify(read.limits) === JSON.stringify(DEFAULTS), '坏文件不拖垮启动：按内置默认生效', JSON.stringify(read.limits))
  ok(Array.isArray(read.diagnostics) && read.diagnostics.some((d) => d.includes('settings.json')),
    '返回明确诊断（不是静默回默认）', JSON.stringify(read.diagnostics))
  ok(r.stderr.includes('settings.json'), 'stderr 也留了一行（启动阶段面板还没打开，不能只藏在返回值里）',
    r.stderr.trim().slice(0, 200))

  const before = readFileSync(join(dir, 'settings.json'), 'utf8')
  const saved = parseChild(runNode(SAVE({ limits: { maxResults: 5 } }), env))
  ok(saved.ok === false && /settings\.json/.test(String(saved.error ?? '')),
    '坏文件上 setSettings 明确拒绝，不把用户手改的文件静默重写成半份', JSON.stringify(saved))
  ok(readFileSync(join(dir, 'settings.json'), 'utf8') === before, '被拒后 settings.json 逐字节未变')
}

// ═══ 5. 文件里的非法值：逐项诊断 + 回落环境变量（不静默） ═══
group('5. settings.json 的单项值非法：回落环境变量并逐项诊断')
{
  const dir = freshState('bad-values')
  const env = cleanEnv(dir)
  env.SAGE_MEM_MAX_RESULTS = '6'
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ limits: { maxResults: 'abc', staleDays: 999 } }), 'utf8')
  const read = parseChild(runNode(READ, env))
  ok(read.limits.maxResults === 6 && read.pendingLimits.maxResults === 6,
    '非数字的持久值 → 回落环境变量 6（不是硬回落默认）', JSON.stringify(read.limits))
  ok(read.limits.staleDays === 365 && read.pendingLimits.staleDays === 365,
    '越界的持久值 → 收敛到边界 365（与 envInt / 面板同一套夹逼）', `实际 ${read.limits.staleDays}`)
  ok(Array.isArray(read.diagnostics) && read.diagnostics.length === 2,
    '两个坏值各给一条诊断', JSON.stringify(read.diagnostics))
  ok((read.diagnostics ?? []).some((d) => d.includes('maxResults')) && (read.diagnostics ?? []).some((d) => d.includes('staleDays')),
    '诊断里点名是哪一项，而不是笼统一句「配置有问题」', JSON.stringify(read.diagnostics))
}

// ═══ 6. 反向对照：值确实跟着盘上的文件变（不是读死常量或读死子进程默认） ═══
group('6. 【反向对照】改盘上的值，新进程读到的生效值跟着变')
{
  const dir = freshState('reverse')
  const env = cleanEnv(dir)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ limits: { maxBaseline: 2 } }), 'utf8')
  const a = parseChild(runNode(READ, env))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ limits: { maxBaseline: 12 } }), 'utf8')
  const b = parseChild(runNode(READ, env))
  ok(a.limits.maxBaseline === 2 && b.limits.maxBaseline === 12,
    '2 → 12 两次读回都是盘上当时的值', `${a.limits.maxBaseline} / ${b.limits.maxBaseline}`)
  const c = parseChild(runNode(READ, cleanEnv(freshState('reverse-empty'))))
  ok(c.limits.maxBaseline === DEFAULTS.maxBaseline,
    '空状态根读回默认 8（证明上一条不是恒定值蒙对）', `实际 ${c.limits.maxBaseline}`)
}

rmSync(sandbox, { recursive: true, force: true })

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
