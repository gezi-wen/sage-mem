#!/usr/bin/env node
/**
 * access-v2-test.mjs — 访问台账 v2 的迁移与字段合并（2026-10-15 建）
 *
 * 为什么单开一个套件：`access-test.mjs` 覆盖的是**台账这个功能**（节流、回收、ENOENT 分类、
 * 与 autodream 的联动），而 v2 引入的是**数据格式与合并语义**——两代格式共存、四个字段
 * 各有各的合并规则、写失败要逐字段放回。混在一起会让「格式出了问题」和「功能出了问题」
 * 长得一样，而它们的排查路径完全不同。
 *
 * 必须知道的坑（与其它套件同源）：
 *   `SAGE_MEM_DIR` / `SAGE_MEM_STATE_DIR` 是**模块顶层**读的环境变量 —— 必须在动态
 *   import **之前**设好（静态 import 会被提升到赋值之前）。
 *
 * 用法: node access-v2-test.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

// ── 沙箱 ────────────────────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-access-v2-'))
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
mkdirSync(memDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const access = await import(new URL('../lib/memory/access.js', import.meta.url).href)
const LEDGER = access.ACCESS_LEDGER_FILE

const seedMem = (name) => writeFileSync(join(memDir, name), `---\nname: ${name.replace(/\.md$/, '')}\n---\n\n正文\n`, 'utf8')
const readRaw = () => JSON.parse(readFileSync(LEDGER, 'utf8'))

// ═══ 1. 读端兼容 v1 ═══
group('1. 读端兼容 v1（老台账不许被当成损坏数据）')
{
  access.__resetAccessPendingForTest()
  const T = 1_700_000_000_000
  writeFileSync(LEDGER, JSON.stringify({ 'old-a.md': T, 'old-b.md': T + 5 }), 'utf8')
  const ledger = await access.readAccessLedger()
  ok(!('v' in ledger) && !('files' in ledger), 'v1 的顶层键不会被误当成条目', JSON.stringify(Object.keys(ledger)))
  ok(access.injectedAt(ledger['old-a.md']) === T, 'v1 的裸数字升成 injected', String(access.injectedAt(ledger['old-a.md'])))
  ok(access.ledgerEntry(ledger['old-b.md']).read === 0 && access.ledgerEntry(ledger['old-b.md']).use === 0,
    'v1 条目补齐 v2 字段为 0（不是 undefined）')
  ok(access.idleDays({ file: 'old-a.md', mtimeMs: 0 }, ledger, T + 86400000) === 1, 'v1 台账在 idleDays 里照旧可用')
}

// ═══ 2. 脏值不许拖垮整份台账 ═══
group('2. 脏值只丢那一键，不丢整份')
{
  access.__resetAccessPendingForTest()
  writeFileSync(LEDGER, JSON.stringify({
    v: 2,
    files: {
      'ok.md': { injected: 1_700_000_000_000, read: 0, use: 0, readRev: '' },
      'bad-string.md': 'not-an-object',
      'bad-null.md': null,
      'bad-array.md': [1, 2, 3],
      'partial.md': { read: 1_700_000_000_500 },
    },
  }), 'utf8')
  const ledger = await access.readAccessLedger()
  ok(access.injectedAt(ledger['ok.md']) === 1_700_000_000_000, '正常条目照读')
  ok(!('bad-string.md' in ledger) && !('bad-null.md' in ledger) && !('bad-array.md' in ledger),
    '三种脏值被跳过，不是整份返回空', JSON.stringify(Object.keys(ledger)))
  ok(access.injectedAt(ledger['partial.md']) === null && access.ledgerEntry(ledger['partial.md']).read === 1_700_000_000_500,
    '缺字段的条目补 0，已有的字段保留')
}

// ═══ 3. 落盘一律 v2 ═══
group('3. 写端只写 v2（读端兼容、写端不扩散）')
{
  access.__resetAccessPendingForTest()
  const T = 1_800_000_000_000
  writeFileSync(LEDGER, JSON.stringify({ 'legacy.md': T - 100_000 }), 'utf8')   // 盘上是 v1
  seedMem('legacy.md')
  access.recordAccess(['legacy.md'], T)
  const r = await access.flushAccess(memDir)
  ok(r.ok === true, 'flush 成功', JSON.stringify(r))
  const parsed = readRaw()
  ok(parsed.v === access.ACCESS_SCHEMA_VERSION && parsed.files && typeof parsed.files === 'object',
    '落盘是 {v:2, files}', JSON.stringify(Object.keys(parsed)))
  ok(access.injectedAt(parsed.files['legacy.md']) === T, 'v1 条目被升格并写回')
  ok(access.ledgerEntry(parsed.files['legacy.md']).read === 0, '升格时补齐字段')
}

// ═══ 4. 字段级合并（同一批） ═══
group('4. 同一批里多个字段互不覆盖')
{
  access.__resetAccessPendingForTest()
  rmSync(LEDGER, { force: true })
  seedMem('mix.md')
  const T1 = 1_900_000_000_000
  const T2 = T1 + 5000
  access.recordAccess(['mix.md'], T1)
  access.recordRead('mix.md', 'sha256:abc123', T2)
  access.recordUse('mix.md')
  const r = await access.flushAccess(memDir)
  ok(r.ok === true, 'flush 成功')
  const e = access.ledgerEntry(readRaw().files['mix.md'])
  ok(e.injected === T1, 'injected 是注入那次的时间', String(e.injected))
  ok(e.read === T2, 'read 是读取那次的时间', String(e.read))
  ok(e.readRev === 'sha256:abc123', 'readRev 跟着 read 走', e.readRev)
  ok(e.use === 1, 'use 记了一次', String(e.use))
}

// ═══ 5. use 是累加、时间戳取较晚 ═══
group('5. 合并语义：use 累加、时间戳取较晚、readRev 归属读得晚的那次')
{
  access.__resetAccessPendingForTest()
  rmSync(LEDGER, { force: true })
  seedMem('acc.md')
  access.recordUse('acc.md')
  access.recordUse('acc.md')
  access.recordUse('acc.md')
  access.recordAccess(['acc.md'], 2_000_000_000_000)
  access.recordAccess(['acc.md'], 2_000_000_000_000 - 999)   // 更早 → 不许把晚的冲掉
  const r = await access.flushAccess(memDir)
  ok(r.ok === true, 'flush 成功')
  const e = access.ledgerEntry(readRaw().files['acc.md'])
  ok(e.use === 3, 'use 累加到 3（不是被覆盖成 1）', String(e.use))
  ok(e.injected === 2_000_000_000_000, 'injected 取较晚的那个（不是最后写入的那个）', String(e.injected))

  // 跨批：先落 injected，再落 read —— 两者都要在
  access.__resetAccessPendingForTest()
  access.recordRead('acc.md', 'sha256:later', 2_000_000_000_500)
  await access.flushAccess(memDir)
  const e2 = access.ledgerEntry(readRaw().files['acc.md'])
  ok(e2.injected === 2_000_000_000_000 && e2.read === 2_000_000_000_500, '跨两次 flush 的字段都保留',
    JSON.stringify(e2))
  ok(e2.use === 3, '跨批的 use 不被清零', String(e2.use))
  ok(e2.readRev === 'sha256:later', 'readRev 归属读得晚的那次', e2.readRev)
}

// ═══ 6. 写失败：逐字段放回，不整条覆盖 ═══
group('6. 写盘失败后逐字段放回（不是整条覆盖）')
{
  access.__resetAccessPendingForTest()
  // 「记忆目录」的上一层是个**文件** → mkdir 必失败 → 走 catch 分支
  const blocker = join(sandbox, 'blocker')
  writeFileSync(blocker, 'not a directory\n', 'utf8')
  const badMemoryDir = join(blocker, 'memory')
  const T1 = 2_100_000_000_000
  const T2 = T1 + 77
  seedMem('rescue.md')
  access.recordAccess(['rescue.md'], T1)
  access.recordRead('rescue.md', 'sha256:rescue', T2)
  access.recordUse('rescue.md')
  const bad = await access.flushAccess(badMemoryDir)
  ok(bad.ok === false, '写不进去时如实返回 ok:false（不假装成功）', JSON.stringify(bad))
  // 放回之后换一个能写的目录落盘，四个字段**都要在** ——
  // 若放回时是「整条覆盖」，其中若干字段会在这一步消失。
  const good = await access.flushAccess(memDir)
  ok(good.ok === true, '换能写的目录后 flush 成功', JSON.stringify(good))
  const e = access.ledgerEntry(readRaw().files['rescue.md'])
  ok(e.injected === T1 && e.read === T2 && e.readRev === 'sha256:rescue' && e.use === 1,
    '四个字段一个都没丢（逐字段放回生效）', JSON.stringify(e))
}

// ═══ 7. 路径归属：台账跟着传入的记忆目录走 ═══
group('7. 台账路径与记忆目录配套（不再「扫 A 写进 B」）')
{
  const other = join(sandbox, 'other')
  mkdirSync(join(other, 'memory'), { recursive: true })
  ok(dirname(access.ledgerFileFor(join(other, 'memory'))) === join(other, '.sage-mem'),
    '传别的记忆目录 → 台账落在它的上一层 .sage-mem 里', access.ledgerFileFor(join(other, 'memory')))
  ok(access.ledgerFileFor(memDir) === LEDGER, '传默认目录 → 仍走模块常量（尊重 SAGE_MEM_STATE_DIR 覆写）')
  ok(access.ledgerFileFor() === LEDGER, '不传参 → 默认目录')
}

// ── 收尾 ────────────────────────────────────────────────────
rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
