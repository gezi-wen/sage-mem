#!/usr/bin/env node
/**
 * suite-registry-test.mjs — 守卫「`npm test` 全绿」这句话本身成不成立（2026-10-15 建）
 *
 * 为什么需要它：**这个项目已经被同一件事咬过两次。**
 * 0.9.17 与 0.9.18 的 CHANGELOG 都在测试表格里列了 `deliver-test.mjs`（75 条）与
 * `status-card-test.mjs`（51 条）—— 而它们**从来没有登记进 `test/run.mjs`**，
 * `npm test` 一次都没跑过。两个版本、126 条断言、两版 CHANGELOG 都写着「全绿」。
 *
 * 病根不在遗漏本身，在**「`npm test` 全绿」这句话没有说自己覆盖了谁**。
 * 一个套件只要没被登记，它就同时是「不存在」和「全绿」—— 而这两件事在输出里长得一模一样。
 *
 * 所以这条守卫不测功能，它测**测试本身的完整性**：
 *   - `test/` 下的每个套件文件都必须在 `run.mjs` 的 SUITES 里；
 *   - SUITES 里的每一项都必须真的有对应文件（否则它是个静默的空跑）。
 *
 * 约定：`run.mjs`（运行器自己）与 `_` 开头的文件（共享辅助，如 `_platform.mjs`）不登记。
 *
 * 用法: node suite-registry-test.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const HERE = fileURLToPath(new URL('.', import.meta.url))
const RUNNER = 'run.mjs'

/** 共享辅助（不登记）：以 `_` 开头，或就是运行器自己。 */
const isHelper = (name) => name === RUNNER || name.startsWith('_')

// ── 从 run.mjs 里读 SUITES（读源码而不是 import：import 会真的跑一遍测试）──
const src = readFileSync(join(HERE, RUNNER), 'utf8')
const arrStart = src.indexOf('const SUITES')
const arrEnd = arrStart >= 0 ? src.indexOf(']', arrStart) : -1
const arrText = arrStart >= 0 && arrEnd > arrStart ? src.slice(arrStart, arrEnd) : ''
const registered = [...arrText.matchAll(/'([^']+\.mjs)'/g)].map((m) => m[1])

const onDisk = readdirSync(HERE).filter((n) => n.endsWith('.mjs'))

group('0. 前置：能读出东西来')
{
  // 没有这一组，后面任何「全绿」都可能是「读不到所以没得比」
  ok(arrStart >= 0 && arrEnd > arrStart, '在 run.mjs 里定位到 SUITES 数组')
  ok(registered.length > 20, `从 SUITES 里读出足够多的条目（实际 ${registered.length}）`)
  ok(onDisk.length > 20, `test/ 下扫到足够多的套件文件（实际 ${onDisk.length}）`)
  ok(new Set(registered).size === registered.length, 'SUITES 里没有重复条目')
}

group('1. 磁盘上的每个套件都登记了')
{
  const missing = onDisk.filter((n) => !isHelper(n) && !registered.includes(n))
  ok(missing.length === 0,
    `没有「写了但从不跑」的套件（漏登记 ${missing.length} 个）`,
    missing.join(', '))
  // 正向对照：凭空多一个套件文件必须能被抓到 —— 否则上面那条可能是因为判据写反了。
  // ⚠️ 判据要**相对真实漏登记数**，不能写死成 1：写死的话真实漏登记时这条会跟着红，
  // 那就不是「反向对照」，而是同一个错误被报了两遍（这是初版犯的错，变异验证时露出来的）。
  const fakeOnDisk = [...onDisk, 'ghost-suite-test.mjs']
  const fakeMissing = fakeOnDisk.filter((n) => !isHelper(n) && !registered.includes(n))
  ok(fakeMissing.length === missing.length + 1 && fakeMissing.includes('ghost-suite-test.mjs'),
    '【反向对照】凭空多一个套件文件时，判据确实会多报一个出来',
    `${missing.length} → ${fakeMissing.length}`)
  ok(fakeMissing.length > missing.length, '【反向对照】多出来的那个就是被凭空加进去的，不是别的原因')
}

group('2. SUITES 里的每一项都真的有文件')
{
  const ghosts = registered.filter((n) => !onDisk.includes(n))
  ok(ghosts.length === 0,
    '没有「登记了但文件不在」的空跑（那会静默跳过而不报错）',
    ghosts.join(', '))
}

group('3. 约定本身被钉住')
{
  ok(isHelper(RUNNER) && isHelper('_platform.mjs'), '运行器与 `_` 开头的文件按辅助排除')
  ok(!isHelper('inject-test.mjs') && !isHelper('ad-smoke.mjs'), '普通套件不被误判成辅助')
  // 这一条防的是「把守卫自己排除掉」这类自利写法
  ok(!isHelper('suite-registry-test.mjs'), '本守卫自己也要登记（不能给自己开后门）')
  ok(registered.includes('suite-registry-test.mjs'), '本守卫确实在 SUITES 里')
}

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
