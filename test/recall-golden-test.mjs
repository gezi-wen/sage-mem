#!/usr/bin/env node
/**
 * 注入链 golden：11 个场景的注入文本必须逐字节等于 v1.1.0 的产出。
 *
 * 它盯的是 1.2.0「纯搬移」这句承诺 —— 把 `lib/index.js` 的监听器搬进 `lib/recall/`
 * 之后，任何一个字节变了都算行为变更，必须解释清楚而不是「测试太紧」。
 *
 * 用法：node test/recall-golden-test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { runScenarios } from './_recall-scenarios.mjs'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}

const dir = fileURLToPath(new URL('./fixtures/recall-golden/', import.meta.url))
const results = await runScenarios()

for (const [name, actual] of results) {
  let expected
  try { expected = readFileSync(join(dir, `${name}.txt`), 'utf8') } catch {
    ok(false, `${name}: 夹具存在`)
    continue
  }
  const same = expected === actual
  let detail = ''
  if (!same) {
    const at = [...expected].findIndex((ch, i) => ch !== actual[i])
    detail = `首个差异 @${at >= 0 ? at : Math.min(expected.length, actual.length)}；expected ${expected.length} chars / actual ${actual.length} chars`
  }
  ok(same, `${name}: 注入文本逐字节一致（${actual === '<none>' ? '未注入' : actual.length + ' chars'}）`, detail)
}

ok(results.size === 11, `场景数量是 11（实际 ${results.size}）`)
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
