/**
 * 漂移守卫：`lib/client.js` 必须**逐字节**等于 `client/*` 的拼接结果。
 *
 * 为什么必须有它：`lib/client.js` 是提交进仓库的产物（宿主读的是它），而以后的代码写在
 * `client/*.js` 里。少了这道守卫，任何人都能只改源不重建 —— 界面照旧跑旧代码，而且
 * 没有任何征兆。跑法就是 `npm test`，与其它守卫一样报「结果：N passed, M failed」。
 *
 * 顺序表从 `scripts/build-client.mjs` import：那是**唯一**的顺序来源，这里不再抄一份。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { CLIENT_OUT, CLIENT_PARTS, concatClient } from '../scripts/build-client.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`)
  }
}

const built = concatClient()
const committed = readFileSync(join(ROOT, CLIENT_OUT))

let detail = ''
if (!built.equals(committed)) {
  let i = 0
  while (i < Math.min(built.length, committed.length) && built[i] === committed[i]) i++
  detail =
    `产物 ${committed.length} 字节 / 拼接 ${built.length} 字节，首个不同字节 @${i}` +
    `（产物 ${committed[i]} vs 拼接 ${built[i]}）—— 改过 client/* 没重建？跑 npm run build:client`
}
ok(built.equals(committed), `${CLIENT_OUT} 与 client/* 的拼接逐字节相同`, detail)

// 顺序表与磁盘上的分片互相覆盖：漏登记/登记了不存在的都要现形
const onDisk = readdirSync(join(ROOT, 'client'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `client/${f}`)
  .sort()
const listed = [...CLIENT_PARTS].sort()
ok(
  JSON.stringify(onDisk) === JSON.stringify(listed),
  `client/ 下的 ${onDisk.length} 个分片与顺序表一一对应（没有漏登记、也没有指向不存在的文件）`,
  `磁盘=[${onDisk}] 顺序表=[${listed}]`,
)

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
