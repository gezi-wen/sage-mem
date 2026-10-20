#!/usr/bin/env node
/**
 * 结构度量表（给 CHANGELOG / 复审看证据，不挂进 npm test）。
 *
 * 用法：node scripts/structure-report.mjs
 * 输出：每个 lib 文件的行数、组合根与最长函数跨度、本地 import 条数、typert 契约位置。
 *
 * 它只**报告**，不判定；判定在 `test/structure-test.mjs`（阈值写在那里，红就是红）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))
const rows = []
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.js')) {
      const src = readFileSync(p, 'utf8')
      rows.push({ rel: relative(LIB, p).replace(/\\/g, '/'), lines: src.split('\n').length, src })
    }
  }
}
walk(LIB)
rows.sort((a, b) => b.lines - a.lines)

const index = rows.find((r) => r.rel === 'index.js')
const start = index.src.indexOf('  constructor(ctx) {')
const end = index.src.indexOf('\n  }\n', start)
const ctorLines = start >= 0 && end > start ? index.src.slice(start, end).split('\n').length : -1
const localImports = (index.src.match(/^import[^\n]*from\s+'\.{1,2}\//gm) || []).length
const { TYPERT } = await import(new URL('../lib/typert.host.js', import.meta.url).href)

console.log('lib/ 文件行数（client.js 是构建产物，单列）')
for (const r of rows) {
  if (r.rel === 'client.js') continue
  console.log(`  ${String(r.lines).padStart(5)}  ${r.rel}`)
}
console.log(`\n组合根：lib/index.js ${index.lines} 行 · 构造函数 ${ctorLines} 行 · 本地 import ${localImports} 条`)
console.log(`typert：${TYPERT.invocations.length} 条 invocation，sourceLocation 全部 lib/index.js:1:1 = ${
  TYPERT.invocations.every((i) => i.sourceLocation?.file === 'lib/index.js' && i.sourceLocation?.line === 1 && i.sourceLocation?.column === 1)
}`)
