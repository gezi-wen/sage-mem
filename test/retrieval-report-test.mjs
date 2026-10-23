#!/usr/bin/env node
/**
 * retrieval-report-test.mjs — 检索诊断报告的可回归守卫（1.6.4 新增）
 *
 * 为什么要有它：外部审查 RET-01 / OBS-01 的修复不是「再改一次算法」，而是
 * **把误注入变成可读、可复现、可回归的诊断**。诊断报告如果哪天悄悄不生成、
 * 或不再包含已知案例，光看 `npm test` 全绿是发现不了的 —— 这个套件把
 * 「报告存在 + 关键内容在场 + 评测本身通过」变成断言。
 *
 * 它跑的是 `scripts/eval-retrieval.mjs`（评测脚本有意不登记为套件，见 D4），
 * 这里只做一次快速烟雾：生成到临时目录、检查内容、清理。评测指标的正确性仍由
 * 发布清单第 3 条人工核对 baseline。
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../scripts/eval-retrieval.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}

const dir = await mkdtemp(join(tmpdir(), 'sage-mem-eval-report-'))
const reportPath = join(dir, 'report.md')
try {
  const r = spawnSync(process.execPath, [
    SCRIPT,
    '--mode', 'all',
    '--baseline', 'test/eval/baseline.json',
    '--report', reportPath,
  ], { cwd: ROOT, encoding: 'utf8' })
  const stdout = String(r.stdout ?? '')
  const stderr = String(r.stderr ?? '')
  ok(r.status === 0, '评测 + 报告生成退出 0', `status=${r.status} ${stderr.split('\n').filter(Boolean).slice(0, 2).join(' / ')}`)
  ok(stdout.includes('基线比较') && stdout.includes('compared'), '本次运行仍走了 baseline 比较（不是只看报告）')

  let report = ''
  try { report = await readFile(reportPath, 'utf8') } catch { /* 下面会报 */ }
  ok(report.length > 4000, `报告已生成且足够长（${report.length} 字符）`)
  ok(report.includes('# 检索诊断报告') && report.includes('## 逐案例'), '报告有标题与逐案例章节')
  for (const id of ['a08', 'b12', 'b14', 'b15']) {
    ok(report.includes(`### ${id} `), `报告包含已知误注入案例 ${id}`)
  }
  ok(report.includes('摘要层') && report.includes('没有 evidence 门槛'), '报告解释了摘要层误注入的机制')
  ok(report.includes('词元贡献'), '正文命中附带逐词元贡献')
  ok(report.includes('Precision@k') && report.includes('无答案题拒绝率') && report.includes('注入字节'),
    '报告包含新增的 Precision@k / 拒绝率 / 注入字节三项诊断指标')
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
