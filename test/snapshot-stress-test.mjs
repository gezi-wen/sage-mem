#!/usr/bin/env node
/**
 * snapshot-stress-test.mjs — 快照在「多文件 + 大文件」下的正确性与内存峰值（1.6.3 新增）
 *
 * 外部审查报告（2026-10-23）的 PERF-01：`snapshot()` 对每个顶层 Markdown 全量 `readFile()`，
 * 理论上大文件 / 多文件会推高内存峰值。核验测量显示真实规模（110 文件 / 1.6 MB）峰值 45 MB、
 * 167 ms；本套件把「不会随总量线性爆掉」固化成一个会红的回归：
 *
 *   - 8 × 20 MB（共 160 MB）顶层 `.md`：快照完成、`failed=0`、count/expected 对；
 *   - MANIFEST 里每个文件的 sha256 都与源文件一致（大文件不是「字节数对上就算」）；
 *   - 快照目录里确实有 8 份正文；
 *   - 本进程 `maxRSS < 256 MB` —— 如果实现退化成「并发读所有文件」或「全量常驻」，
 *     160 MB 数据会把它顶破。
 *
 * 为什么阈值是 256 MB：真实规模只需要 ~45 MB；串行实现峰值 ≈ Node 基线 + GC 滞后 + 最大单文件，
 * 160 MB 场景实测远低于该线。阈值给足余量（CI runner 内存抖动），只拦数量级退化。
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'sage-mem-snapshot-stress-'))
const memoryDir = join(root, 'memory')
const sessionsRoot = join(root, 'sessions')
await mkdir(memoryDir, { recursive: true })

const makeCtx = () => ({ get: () => undefined, logger: { warn: () => {}, error: () => {} } })
const { AutodreamEngine } = await import(new URL('../lib/autodream.js', import.meta.url).href)
const engine = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot })
await engine.load()

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}

try {
  const BIG = 20 * 1024 * 1024
  const buf = Buffer.alloc(BIG, 0x61)
  const names = []
  for (let i = 0; i < 8; i++) {
    const name = `project_stress_${i}.md`
    names.push(name)
    await writeFile(join(memoryDir, name), buf)
  }

  const snap = await engine.snapshot('20261023-stress-run', 'run')
  ok(snap.failed.length === 0, `8 × 20 MB：没有失败文件（failed=${snap.failed.length}）`, snap.failed.join(', '))
  ok(snap.count === names.length && snap.expected === names.length,
    `count = expected = ${names.length}（实际 ${snap.count} / ${snap.expected}）`)

  const manifest = JSON.parse(await readFile(join(snap.dir, 'MANIFEST.json'), 'utf8'))
  ok(manifest.files.length === names.length, `MANIFEST 记录了 ${names.length} 个文件（实际 ${manifest.files.length}）`)
  const want = createHash('sha256').update(buf).digest('hex')
  const badHash = manifest.files.filter((f) => f.sha256 !== want || f.bytes !== BIG)
  ok(badHash.length === 0, '每个文件的 sha256 / 字节数都与源文件一致', badHash.map((f) => f.name).join(', '))

  const copied = (await readdir(snap.dir)).filter((n) => n.endsWith('.md'))
  ok(copied.length === names.length, `快照目录里确实有 ${names.length} 份正文（实际 ${copied.length}）`)

  const maxRssMb = process.resourceUsage().maxRSS / 1024
  ok(maxRssMb < 256, `峰值 RSS < 256 MB（实际 ${maxRssMb.toFixed(1)} MB）`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
