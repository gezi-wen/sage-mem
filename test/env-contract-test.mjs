#!/usr/bin/env node
/**
 * env-contract-test.mjs — 守卫契约 §5（**环境变量那 8 行**）（2026-10-16 建，1.0.0）
 *
 * 为什么需要它：契约 §5 逐行写着「这个变量默认是 X、夹在 lo–hi」。做完「保证 ↔ 断言」
 * 绑定才发现，台账里关于这些变量的断言**只覆盖了一半**：
 *   - 「默认值」那半边，有几条（`MAX_RESULTS 默认 10`、`不设环境变量时默认 60 KB`）；
 *   - 「**范围 / 越界夹取**」那半边 —— **一条都没有**。
 *     `config.js` 的 `envInt()` 收敛在 `test/` 里零次被直接调用；
 *     `client-render-test.mjs` 那两条「范围是 1–30 / 0–365」测的是**设置页控件的属性**，
 *     不是 host 侧的收敛 —— 契约说是「照抄 host clamp」，断言抄的其实是界面文案。
 *   - `SAGE_MEM_DIR` 的**字面默认值**（`~/.sage-mem/memory`）也没人看着：所有套件里
 *     这个常量都被 `SAGE_MEM_DIR` 指到了临时目录，等于**拿被覆写过的值自证**。
 *
 * 一条没被断言碰过的承诺，和没有这条承诺是一样的 —— 所以这里把它补上，而不是降级。
 *
 * ⚠️ **所有取值都在干净子进程里读**。本套件自己就跑在 `run.mjs` 的沙箱环境里
 * （`SAGE_MEM_DIR` 等一概被设过），**直接继承环境会把「默认值」测成「沙箱值」** ——
 * 那正是这个项目栽过的那种「测了一个长得像它的东西」。所以每个断言前先清空
 * 全部 `SAGE_MEM_*`，再按需注入。
 *
 * 用法: node test/env-contract-test.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CONFIG_PATH = join(HERE, '..', 'lib', 'memory', 'config.js')
const CONFIG = pathToFileURL(CONFIG_PATH).href
const INDEX = join(HERE, '..', 'lib', 'index.js')

/** 契约 §5 的原始数字（两边都要对得上：改一边忘另一边就红）。 */
const SPEC = {
  MAX_RESULTS: { env: 'SAGE_MEM_MAX_RESULTS', dflt: 10, lo: 1, hi: 30 },
  MAX_CHARS_PER_FILE: { env: 'SAGE_MEM_MAX_CHARS', dflt: 1500, lo: 200, hi: 20000 },
  MAX_BASELINE: { env: 'SAGE_MEM_MAX_BASELINE', dflt: 8, lo: 1, hi: 50 },
  MAX_SESSION_BYTES: { env: 'SAGE_MEM_MAX_SESSION_BYTES', dflt: 60 * 1024, lo: 4096, hi: 512 * 1024 },
  STALE_DAYS: { env: 'SAGE_MEM_STALE_DAYS', dflt: 1, lo: 0, hi: 365 },
}

/**
 * 起一个**干净**子进程加载 `config.js`，把常量原样打回来。
 * `overrides` 里给的值会在清空之后注入（所以 `{ SAGE_MEM_MAX_RESULTS: '' }` 是合法的空值场景）。
 */
function readConfig(overrides = {}, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  for (const k of Object.keys(env)) if (k.startsWith('SAGE_MEM_')) delete env[k]
  // 沙箱残留的两个也可能影响派生值，一并清掉再由 overrides 决定
  delete env.DSH_HOME
  Object.assign(env, overrides)
  if (extraEnv.DSH_HOME) env.DSH_HOME = extraEnv.DSH_HOME

  const code = `
    const c = await import(${JSON.stringify(CONFIG)})
    const out = {}
    for (const k of ['MEMORY_DIR','STATE_ROOT','SESSIONS_ROOT','MAX_RESULTS','MAX_CHARS_PER_FILE',
                     'MAX_BASELINE','MAX_SESSION_BYTES','STALE_DAYS','STATUS_RESERVE','CONTENT_BUDGET']) {
      out[k] = c[k]
    }
    console.log('@@' + JSON.stringify(out))
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env })
  const line = `${r.stdout ?? ''}`.split('\n').find((l) => l.startsWith('@@'))
  if (!line) throw new Error(`子进程没打出配置：${r.stderr || r.stdout || '(空)'}`)
  return JSON.parse(line.slice(2))
}

const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-env-'))
const fakeHome = join(sandbox, 'home')

group('0. 前置：能在一个干净子进程里读到配置')
{
  let base = null
  try { base = readConfig() } catch (e) { ok(false, '子进程能加载 lib/memory/config.js 并打印常量', e.message) }
  if (base) {
    ok(true, '子进程能加载 lib/memory/config.js 并打印常量')
    ok(base.MAX_SESSION_BYTES > 0 && base.MEMORY_DIR.length > 0,
      '打回来的是一份像样的配置（不是空对象）')
    // 反向对照：本进程明明带着沙箱的 SAGE_MEM_DIR，但子进程读到的不该是它。
    ok(base.MEMORY_DIR !== process.env.SAGE_MEM_DIR,
      '【反向对照】默认值确实来自「清空环境」的子进程，不是继承本套件的沙箱值',
      `沙箱 ${process.env.SAGE_MEM_DIR} / 子进程 ${base.MEMORY_DIR}`)
  }
}

group('1. 五个上限的默认值与契约 §5 逐项相等')
{
  const base = readConfig()
  for (const [key, spec] of Object.entries(SPEC)) {
    ok(base[key] === spec.dflt, `${spec.env} 默认 ${spec.dflt}（实际 ${base[key]}）`)
  }
}

group('2. 越界夹取 —— 契约说「夹在 lo–hi」，两个方向都要验')
{
  for (const [key, spec] of Object.entries(SPEC)) {
    const low = readConfig({ [spec.env]: String(spec.lo - 1) })[key]
    const high = readConfig({ [spec.env]: String(spec.hi + 1) })[key]
    ok(low === spec.lo, `${spec.env} 低于下限 → 夹到 ${spec.lo}（实际 ${low}）`)
    ok(high === spec.hi, `${spec.env} 高于上限 → 夹到 ${spec.hi}（实际 ${high}）`)
  }
  // 区间内部的值必须原样穿过（否则上面两条可以靠「永远返回边界」蒙过去）
  const inside = readConfig({ SAGE_MEM_MAX_RESULTS: '17' }).MAX_RESULTS
  ok(inside === 17, '【反向对照】区间内的值原样穿过（17 → 17）')
  // 小数点四舍五入，与 lib/index.js 的 clampInt 同一套语义
  const rounded = readConfig({ SAGE_MEM_MAX_RESULTS: '7.6' }).MAX_RESULTS
  ok(rounded === 8, '小数按四舍五入收敛（7.6 → 8）', `实际 ${rounded}`)
}

group('3. 非法值回落默认，不报错')
{
  const base = readConfig()
  // 这条是纯空格的根因：`Number('   ')` 是 0 而不是 NaN，所以不 trim 的话
  // 『非法』会被当成『用户填了 0』→ 夹到下限。2026-10-16 修（config.js 的 envInt）。
  ok(Number('   ') === 0, '前置：`Number("   ")` 确实是 0（纯空格曾被静默夹到下限的根因）')
  for (const bad of ['abc', '', '   ']) {
    const v = readConfig({ SAGE_MEM_MAX_RESULTS: bad }).MAX_RESULTS
    ok(v === SPEC.MAX_RESULTS.dflt,
      `\`SAGE_MEM_MAX_RESULTS=${JSON.stringify(bad)}\` → 回落 ${SPEC.MAX_RESULTS.dflt}（实际 ${v}）`)
  }
  ok(readConfig({ SAGE_MEM_MAX_SESSION_BYTES: 'NaN' }).MAX_SESSION_BYTES === base.MAX_SESSION_BYTES,
    '非数字不炸、回落默认（NaN）')
}

group('4. 目录的默认值与派生规则')
{
  const clean = readConfig({}, { HOME: fakeHome, USERPROFILE: fakeHome })
  // Windows 的 homedir() 走 USERPROFILE，POSIX 走 HOME —— 两个都指到同一个临时 home。
  ok(clean.MEMORY_DIR.replaceAll('\\', '/').endsWith('/.sage-mem/memory'),
    'SAGE_MEM_DIR 缺省时是 <home>/.sage-mem/memory',
    clean.MEMORY_DIR)
  ok(clean.MEMORY_DIR.replaceAll('\\', '/').startsWith(fakeHome.replaceAll('\\', '/')),
    '而且确实挂在 home 下（不是硬编码的某个绝对路径）', clean.MEMORY_DIR)
  ok(clean.STATE_ROOT.replaceAll('\\', '/').endsWith('/.sage-mem'),
    'SAGE_MEM_STATE_DIR 缺省时是「记忆目录的上一层」+ /.sage-mem', clean.STATE_ROOT)

  const custom = readConfig({ SAGE_MEM_DIR: join(sandbox, 'my-memory') })
  ok(custom.MEMORY_DIR === join(sandbox, 'my-memory'), 'SAGE_MEM_DIR 覆写生效')
  ok(custom.STATE_ROOT === join(sandbox, '.sage-mem'),
    '状态根跟着记忆目录走（覆写记忆目录后派生到它的上一层）', custom.STATE_ROOT)

  const explicit = readConfig({ SAGE_MEM_DIR: join(sandbox, 'm2'), SAGE_MEM_STATE_DIR: join(sandbox, 's2') })
  ok(explicit.STATE_ROOT === join(sandbox, 's2'), '显式 SAGE_MEM_STATE_DIR 压过派生值')
}

group('5. 60 KiB 怎么拆成两本账（总预算 = 正文池 + 状态卡预留）')
{
  const base = readConfig()
  ok(base.STATUS_RESERVE === 3072,
    '默认 61440 的 5% = 3072，落在 [1 KiB, 4 KiB] 内（实际 ' + base.STATUS_RESERVE + '）')
  ok(base.CONTENT_BUDGET === base.MAX_SESSION_BYTES - base.STATUS_RESERVE,
    '正文池 = 总预算 − 状态卡预留（两本账相加不超总上限）')
  // 下限方向：小总预算时 5% 不够 1 KiB，被抬到 1024
  const small = readConfig({ SAGE_MEM_MAX_SESSION_BYTES: '5120' })
  ok(small.STATUS_RESERVE === 1024 && small.CONTENT_BUDGET === 4096,
    '总预算 5120 → 预留被抬到下限 1024、正文池 4096（与 inject-test 的 4 KB 夹具同源）',
    `预留 ${small.STATUS_RESERVE} / 正文池 ${small.CONTENT_BUDGET}`)
  // 上限方向：大总预算时 5% 超过 4 KiB，被压到 4096
  const big = readConfig({ SAGE_MEM_MAX_SESSION_BYTES: String(512 * 1024) })
  ok(big.STATUS_RESERVE === 4096 && big.CONTENT_BUDGET === 512 * 1024 - 4096,
    '总预算 512 KB → 预留被压到上限 4096',
    `预留 ${big.STATUS_RESERVE} / 正文池 ${big.CONTENT_BUDGET}`)
}

group('6. SAGE_MEM_TASK_ID（环境变量优先，否则回落会话 id）')
{
  // 这条分支写在 `lib/recall/injector.js` 里、没有导出，所以用**源码级**断言钉住写法 ——
  // 与 observe-test 的源码级断言、write-gate-wiring 组 7 是同一手法。
  // ⚠️ 1.2.0 把注入链从 `lib/index.js` 搬进 `lib/recall/`：守卫的**目标文件跟着搬**，
  // 判据本身没被删 —— 删守卫等于把真保护一起删掉。
  const INJECTOR = new URL('../lib/recall/injector.js', import.meta.url)
  const src = readFileSync(INJECTOR, 'utf8')
  ok(/process\.env\.SAGE_MEM_TASK_ID\s*\|\|\s*session\?\.id\s*\|\|\s*''/.test(src),
    '任务 id 的取值是「环境变量 → 会话 id → 空串」这条链',
    '没匹配到 process.env.SAGE_MEM_TASK_ID || session?.id || \'\'')
  ok(!/SAGE_MEM_TASK_ID/.test(readFileSync(CONFIG_PATH, 'utf8')),
    'config.js 不管任务 id（它的作用域是每次 step，不是模块常量）')
  // 只在**取值那一行**里判：注释里可以解释「为什么不许用查询文本」，那是说明不是实现。
  const exprLine = src.split('\n').find((l) => l.includes('process.env.SAGE_MEM_TASK_ID')) || ''
  ok(!/query|question|prompt/i.test(exprLine),
    '【不变量】作用域不许由查询文本决定（那句话是模型或用户写的，不该决定去读哪个目录）', exprLine.trim())
}

group('7. 反向对照：判据确实会因为真变化而变红')
{
  const a = readConfig()
  const b = readConfig({ SAGE_MEM_MAX_RESULTS: '3', SAGE_MEM_STALE_DAYS: '0' })
  ok(a.MAX_RESULTS !== b.MAX_RESULTS && a.STALE_DAYS !== b.STALE_DAYS,
    '【反向对照】改了环境变量，读回来的值确实跟着变',
    `${a.MAX_RESULTS}→${b.MAX_RESULTS} / ${a.STALE_DAYS}→${b.STALE_DAYS}`)
  const ghost = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify(CONFIG)}).then((c) => console.log('@@' + c.THIS_EXPORT_DOES_NOT_EXIST))`],
  { encoding: 'utf8', env: { ...process.env } })
  ok(`${ghost.stdout ?? ''}`.includes('@@undefined'),
    '【反向对照】不存在的导出读到 undefined（证明读的是真模块，不是被桩住的）')
}

rmSync(sandbox, { recursive: true, force: true })

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
