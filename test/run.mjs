#!/usr/bin/env node
/**
 * sage-mem 测试总入口（仓库内，随 npm test 一起跑）。
 *
 * 逐个跑本目录下的断言脚本，汇总每个脚本自报的断言数；任一脚本非零退出、
 * 有失败断言、或压根没打出汇总行（多半是 import 就炸了），整体即 exit 1。
 *
 * 为什么用子进程而不是 import 进同一个进程：inject-test 会在**模块顶层**读环境变量
 * （SAGE_MEM_DIR / SAGE_MEM_MAX_SESSION_BYTES …），而且它自己还要另起子进程验默认值；
 * 同进程复用会让这些顶层状态互相污染。一脚本一进程最省心，也最接近各自单跑的结果。
 *
 * 只依赖 node: 内置模块 —— 不引入任何测试框架，与各脚本手写 ok() 的风格保持一致。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 固定顺序：先纯函数与引擎层，再产物对表，最后客户端真执行。 */
const SUITES = [
  'ad-smoke.mjs',
  'ad-fixes.mjs',
  'ad-matrix.mjs',
  'retrieval-test.mjs',
  'typert-test.mjs',
  'inject-test.mjs',
  'archive-test.mjs',
  'access-test.mjs',
  'panel-api-test.mjs',
  'build-fresh.mjs',
  'client-exec-test.mjs',
]

/** 各脚本收尾那行：`结果：53 passed, 0 failed`。 */
const SUMMARY = /结果：(\d+)\s*passed,\s*(\d+)\s*failed/

const HERE = fileURLToPath(new URL('.', import.meta.url))
const rows = []
let passed = 0
let failed = 0
const broken = []

for (const name of SUITES) {
  const r = spawnSync(process.execPath, [join(HERE, name)], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = out.match(SUMMARY)
  const p = m ? Number(m[1]) : 0
  const f = m ? Number(m[2]) : 0
  const code = r.status === null ? 1 : r.status
  passed += p
  failed += f
  if (!m || f > 0 || code !== 0) broken.push(name)

  console.log(`\n──── ${name} ────`)
  process.stdout.write(out.endsWith('\n') || !out ? out : `${out}\n`)
  if (!m) console.log('  （没有读到汇总行，按失败计）')

  rows.push({ name, p, f, code, bad: !m || f > 0 || code !== 0 })
}

console.log('\n════ 汇总 ════')
for (const r of rows) {
  console.log(`  ${r.bad ? 'FAIL' : 'ok  '}  ${r.name.padEnd(20)} ${r.p} passed, ${r.f} failed  (exit ${r.code})`)
}
console.log(`  合计：${passed} passed, ${failed} failed`)
if (broken.length) console.log(`  未通过：${broken.join(', ')}`)

process.exit(failed > 0 || broken.length ? 1 : 0)
