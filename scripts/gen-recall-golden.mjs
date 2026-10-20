#!/usr/bin/env node
/**
 * 生成注入链 golden 夹具（**只在建 golden 时跑一次**，不挂进 npm test）。
 *
 * 用法：node scripts/gen-recall-golden.mjs
 * 产物：test/fixtures/recall-golden/<场景名>.txt
 *
 * ⚠️ 生成前请确认工作树在「行为正确」的版本上（1.2.0 是 v1.1.0）。
 * 夹具一旦入库，`test/recall-golden-test.mjs` 就会逐字节盯着注入文本。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { runScenarios } from '../test/_recall-scenarios.mjs'

const dir = fileURLToPath(new URL('../test/fixtures/recall-golden/', import.meta.url))
mkdirSync(dir, { recursive: true })

const results = await runScenarios()
for (const [name, text] of results) {
  writeFileSync(join(dir, `${name}.txt`), text, 'utf8')
  console.log(`${name.padEnd(20)} ${text === '<none>' ? '<none>' : text.length + ' chars'}`)
}
console.log(`\n写出 ${results.size} 份夹具 → ${dir}`)
