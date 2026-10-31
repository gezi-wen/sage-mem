/**
 * 2.1.9 / 外部审查 N01：撤销没有绑定原裁决标记，能清掉后来人的判断。
 *
 * 问题（修前）：记录保存了 `appliedVersion`，但 undo 没用它，也没比对原来的标记值；
 * `readForWrite` 只保证「本次读写窗口内版本不变」，随后 `removeValidityLines` 删掉当前
 * 文件**全部**顶层失效标记。先标 a.md 失效，再由用户/另一条裁决把 invalid_at /
 * superseded_by 改成别的值，然后点撤销：后来人的判断被一起删掉。
 *
 * 这组断言盯的：
 *   ① 原标记没变 → 可以撤销（反向对照，正常路径不退化）；
 *   ② 只有正文变化 → 撤销照样成功，正文改动一个字都不丢（标记级守卫，不是整份文件守卫）；
 *   ③ 标记被重写（invalid_at 或 superseded_by 任一变了）→ `stale_decision`，**一个字节不删**，
 *      记录也不动 —— 交给用户比较；
 *   ④ 两条冲突涉及同一文件时，各自只能撤销自己那次标记（所有权）；
 *   ⑤ 标记已经不在（撤销过 / 被清掉）→ 幂等成功 cleared:false；旧记录没有 decidedAt → 兼容旧行为。
 *
 * 修前红证据（审查报告复现）：{firstOk:true, undoOk:true, laterMarkerPreserved:false}
 * —— 后来写入的 superseded_by: c.md 被删掉了。
 *
 * 只碰临时目录：SAGE_MEM_DIR / SAGE_MEM_STATE_DIR 必须在 import lib 之前设好。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = join(tmpdir(), `sage-mem-n01-test-${process.pid}`)
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
mkdirSync(memDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const LIB = new URL('../lib/', import.meta.url)
const { ConflictGateway } = await import(new URL('index.js', LIB).href)
const { buildConflict, readConflict, writeConflict } = await import(new URL('memory/conflicts.js', LIB).href)
const arbitrate = await import(new URL('memory/arbitrate.js', LIB).href)
const { readValidityMarker, removeValidityLines, upsertValidityLines } = arbitrate
// 修前基线没有这个常量（拿到 undefined 会让断言直接崩，掩盖红证据），给一个字面量兜底：
// 修后宿主导出常量，测试断言的就是它；两者的值必须相同，否则断言会红。
const ERR_STALE_DECISION = arbitrate.ERR_STALE_DECISION ?? 'stale_decision'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const hash = (buf) => createHash('sha256').update(buf).digest('hex')
const body = (n) => `---\nname: ${n}\ntype: project\ndescription: N01 夹具\n---\n\n${n} body\n`
const host = {
  resolve: async (p) => p,
  stat: async (p) => ({ version: hash(await readFile(p)) }),
  writeText: async (p, text, guard) => {
    const before = hash(await readFile(p))
    if (guard && guard.kind === 'replaceIfVersion' && guard.version !== before) {
      throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
    }
    await writeFile(p, text)
    return { version: hash(Buffer.from(text, 'utf8')) }
  },
}
const ctx = { get: (n) => (n === 'fs' ? host : undefined), logger: { warn: () => {}, error: () => {} } }
const api = Object.create(ConflictGateway.prototype)
api.ctx = ctx

const memPath = (f) => join(memDir, f)
const readMem = (f) => readFileSync(memPath(f), 'utf8')
const writeMem = (f, text) => writeFileSync(memPath(f), text, 'utf8')
const countMarker = (text, key) => (text.match(new RegExp(`^${key}:`, 'gm')) || []).length
const seedRecord = async (id, file, otherFile) => {
  await writeConflict(buildConflict({ id, kind: 'contradiction', file, otherFile }), { stateRoot: stateDir })
}
const recordOf = async (id) => {
  const r = await readConflict(id, { stateRoot: stateDir })
  return r.ok ? r.record : r
}

// ── 1. 原标记未变 → 可以撤销（反向对照）────────────────────────────
group('1. 原标记未变：撤销成功，只删两行、正文不动')
{
  writeMem('keep_a.md', body('keep A'))
  await seedRecord('n01-keep', 'keep_a.md', 'keep_b.md')
  const inv = await api.invalidate({ id: 'n01-keep', file: 'keep_a.md' })
  ok(inv && inv.ok === true, '前置：裁决成功（标记已写入）', JSON.stringify(inv))
  const before = readMem('keep_a.md')
  ok(countMarker(before, 'invalid_at') === 1, '前置：盘上确实有失效标记')
  const und = await api.undo({ id: 'n01-keep' })
  const after = readMem('keep_a.md')
  ok(und && und.ok === true, '原标记未变 → 撤销成功', JSON.stringify(und))
  ok(countMarker(after, 'invalid_at') === 0 && countMarker(after, 'superseded_by') === 0, '撤销删掉了两行标记')
  ok(after.includes('keep A body'), '撤销没有丢正文')
  const rec = await recordOf('n01-keep')
  ok(rec.status === 'dismissed' && rec.decision === '', '记录回到 dismissed / 无裁决', JSON.stringify({ status: rec.status, decision: rec.decision }))
  const again = await api.undo({ id: 'n01-keep' })
  ok(again && again.ok === false && again.code === 'invalid_transition', '撤销过的记录再撤销 → invalid_transition（不重复删）', JSON.stringify(again))
}

// ── 2. 只有正文变化 → 撤销照样成功，正文一个字不丢 ──────────────────
group('2. 仅正文变化：标记级守卫，不拿整份文件版本挡路')
{
  writeMem('body_a.md', body('body A'))
  await seedRecord('n01-body', 'body_a.md', 'body_b.md')
  await api.invalidate({ id: 'n01-body', file: 'body_a.md' })
  // 用户在裁决之后改了正文（标记两行原样保留）
  const edited = readMem('body_a.md').replace('body A body', 'body A body\n\n后来补的一段正文')
  writeMem('body_a.md', edited)
  const und = await api.undo({ id: 'n01-body' })
  const after = readMem('body_a.md')
  ok(und && und.ok === true, '仅正文变化 → 撤销成功（不因正文版本不同而误拒）', JSON.stringify(und))
  ok(after.includes('后来补的一段正文'), '撤销没有丢掉后来补的正文')
  ok(countMarker(after, 'invalid_at') === 0, '标记已删、正文保留')
}

// ── 3. 标记被重写 → stale_decision，一个字节不删 ──────────────────
group('3. 标记被重写：拒绝撤销别人的判断')
{
  writeMem('stale_a.md', body('stale A'))
  await seedRecord('n01-stale', 'stale_a.md', 'stale_b.md')
  const inv = await api.invalidate({ id: 'n01-stale', file: 'stale_a.md' })
  const recBefore = await recordOf('n01-stale')
  // 后来人把标记整对换成自己的判断（审查报告的复现动作）
  const later = upsertValidityLines(readMem('stale_a.md'), { invalidAt: '2026-10-30T00:00:00Z', supersededBy: 'c.md' })
  writeMem('stale_a.md', later.content)
  const laterBytes = readFileSync(memPath('stale_a.md'))
  const und = await api.undo({ id: 'n01-stale' })
  ok(und && und.ok === false, '标记被重写 → 撤销被拒绝（不是 ok:true）', JSON.stringify(und))
  ok(und && und.code === ERR_STALE_DECISION, `冲突码是常量 ${ERR_STALE_DECISION}`, JSON.stringify(und))
  ok(/invalid_at/.test(String(und && und.error)) && /superseded_by/.test(String(und && und.error)), '错误文案给出「记录 vs 盘上」的标记对比（交给用户比较）', String(und && und.error))
  ok(readFileSync(memPath('stale_a.md')).equals(laterBytes), '拒绝时文件逐字节不变（后来人的标记还在）')
  const recAfter = await recordOf('n01-stale')
  ok(recAfter.status === 'resolved' && recAfter.decision === 'invalidate' && recAfter.appliedVersion === recBefore.appliedVersion, '记录也没有被改动（裁决收据仍在）', JSON.stringify({ status: recAfter.status, appliedVersion: recAfter.appliedVersion }))
  // 反向对照：用户确认「这条已经不是我那次判断」之后，不能自动重试；只能由人重新裁决。
  const retry = await api.undo({ id: 'n01-stale' })
  ok(retry && retry.ok === false && retry.code === ERR_STALE_DECISION, '再点一次仍是 stale_decision（不自动覆盖）', JSON.stringify(retry))
  ok(readFileSync(memPath('stale_a.md')).equals(laterBytes), '重复拒绝期间文件仍然逐字节不变')
}

// ── 4. 只改其中一行也拒绝（marker 级判据，不是只看 invalid_at）──────
group('4. 只改 superseded_by / 只改 invalid_at 都算「不是我的标记」')
{
  writeMem('half_a.md', body('half A'))
  await seedRecord('n01-half', 'half_a.md', 'half_b.md')
  await api.invalidate({ id: 'n01-half', file: 'half_a.md' })
  // 只改 superseded_by（invalid_at 不变）
  const p1 = readMem('half_a.md').replace(/^superseded_by: .*$/m, 'superseded_by: someone-else.md')
  writeMem('half_a.md', p1)
  const u1 = await api.undo({ id: 'n01-half' })
  ok(u1 && u1.ok === false && u1.code === ERR_STALE_DECISION, '只改 superseded_by → stale_decision', JSON.stringify(u1))
  ok(readMem('half_a.md').includes('superseded_by: someone-else.md'), '只改 superseded_by → 标记原样保留')
}
{
  writeMem('half_c.md', body('half C'))
  await seedRecord('n01-half2', 'half_c.md', 'half_d.md')
  await api.invalidate({ id: 'n01-half2', file: 'half_c.md' })
  // 只改 invalid_at（时间戳变成别人的）
  const p2 = readMem('half_c.md').replace(/^invalid_at: .*$/m, 'invalid_at: 2026-10-30T00:00:00Z')
  writeMem('half_c.md', p2)
  const u2 = await api.undo({ id: 'n01-half2' })
  ok(u2 && u2.ok === false && u2.code === ERR_STALE_DECISION, '只改 invalid_at → stale_decision', JSON.stringify(u2))
  ok(readMem('half_c.md').includes('invalid_at: 2026-10-30T00:00:00Z'), '只改 invalid_at → 标记原样保留')
}

// ── 5. 同一文件的两条冲突：各自只能撤销自己的标记 ─────────────────
group('5. 两条冲突涉及同一文件：撤销所有权')
{
  writeMem('own_a.md', body('own A'))
  await seedRecord('n01-own-1', 'own_a.md', 'own_x.md')
  await seedRecord('n01-own-2', 'own_a.md', 'own_y.md')
  const inv1 = await api.invalidate({ id: 'n01-own-1', file: 'own_a.md' })
  const inv2 = await api.invalidate({ id: 'n01-own-2', file: 'own_a.md' })
  ok(inv1 && inv1.ok === true && inv2 && inv2.ok === true, '两条不同冲突对同一文件的裁决都成功（文件级串行）', JSON.stringify([inv1 && inv1.ok, inv2 && inv2.ok]))
  ok(readMem('own_a.md').includes('superseded_by: own_y.md'), '盘上留下的是后一次裁决的标记（后写者可见）')
  const u1 = await api.undo({ id: 'n01-own-1' })
  ok(u1 && u1.ok === false && u1.code === ERR_STALE_DECISION, '撤销第一条记录 → stale_decision（盘上是第二条的标记）', JSON.stringify(u1))
  ok(readMem('own_a.md').includes('superseded_by: own_y.md'), '第一条记录的撤销没有删掉第二条的标记')
  const u2 = await api.undo({ id: 'n01-own-2' })
  ok(u2 && u2.ok === true, '撤销第二条记录（标记的主人）→ 成功', JSON.stringify(u2))
  ok(countMarker(readMem('own_a.md'), 'invalid_at') === 0, '第二条撤销后标记清掉，正文仍在')
}

// ── 6. 标记已不在 / 旧记录没有 decidedAt：幂等与兼容 ────────────────
group('6. 幂等与旧记录兼容')
{
  writeMem('gone_a.md', body('gone A'))
  await seedRecord('n01-gone', 'gone_a.md', 'gone_b.md')
  await api.invalidate({ id: 'n01-gone', file: 'gone_a.md' })
  // 模拟「已经有人手工撤销 / 另一个写入清掉了标记」
  const cleared = removeValidityLines(readMem('gone_a.md'))
  writeMem('gone_a.md', cleared.content)
  const beforeBytes = readFileSync(memPath('gone_a.md'))
  const u = await api.undo({ id: 'n01-gone' })
  ok(u && u.ok === true && u.cleared && u.cleared.file === 'gone_a.md', '标记已经不在 → 幂等成功（cleared 收据仍在）', JSON.stringify(u))
  ok(readFileSync(memPath('gone_a.md')).equals(beforeBytes), '幂等撤销没有改动文件（无标记可删）')
  ok((await recordOf('n01-gone')).status === 'dismissed', '记录仍然被退回 dismissed（状态机照旧）')
}
{
  // 旧记录：decidedAt / appliedVersion 为空（1.x / 2.0.0 早期），没有操作身份可比 → 兼容旧行为。
  writeMem('legacy_a.md', body('legacy A'))
  const legacy = { ...buildConflict({ id: 'n01-legacy', kind: 'contradiction', file: 'legacy_a.md', otherFile: 'legacy_b.md' }), status: 'resolved', decision: 'invalidate', invalidatedFile: 'legacy_a.md', decidedAt: '', appliedVersion: '' }
  await writeConflict(legacy, { stateRoot: stateDir })
  const marked = upsertValidityLines(readMem('legacy_a.md'), { invalidAt: '2026-10-01T00:00:00Z', supersededBy: 'legacy_b.md' })
  writeMem('legacy_a.md', marked.content)
  const u = await api.undo({ id: 'n01-legacy' })
  ok(u && u.ok === true, '旧记录（没有 decidedAt）→ 按兼容路径撤销成功', JSON.stringify(u))
  ok(countMarker(readMem('legacy_a.md'), 'invalid_at') === 0, '兼容路径确实删掉了标记（additive：不把旧数据变成不可撤销）')
}

// ── 7. 纯函数：标记解析（引号 / 嵌套 / CRLF / 半份）────────────────
group('7. readValidityMarker 纯函数')
if (typeof readValidityMarker === 'function') {
  ok(readValidityMarker('no frontmatter') === null, '没有 frontmatter → null')
  ok(readValidityMarker('---\nname: a\n---\n正文\n') === null, 'frontmatter 里没有 invalid_at → null')
  ok(readValidityMarker('---\nsuperseded_by: x.md\n---\n正文') === null, '只有 superseded_by 没有 invalid_at → null（不算失效）')
  const quoted = readValidityMarker("---\ninvalid_at: '2026-10-30T00:00:00Z'\nsuperseded_by: 'x.md'\n---\n正文")
  ok(quoted && quoted.invalidAt === '2026-10-30T00:00:00Z' && quoted.supersededBy === 'x.md', '带引号的 yamlScalar 值能正确还原', JSON.stringify(quoted))
  const nested = readValidityMarker('---\nmetadata:\n  invalid_at: should-not-count\ninvalid_at: real\n---\n正文')
  ok(nested && nested.invalidAt === 'real', '嵌套块里的同名键不算（只认顶层两行）', JSON.stringify(nested))
  const crlf = readValidityMarker('---\r\ninvalid_at: 2026-10-30T00:00:00Z\r\nsuperseded_by: y.md\r\n---\r\n正文')
  ok(crlf && crlf.invalidAt === '2026-10-30T00:00:00Z' && crlf.supersededBy === 'y.md', 'CRLF 文件同样能读出标记', JSON.stringify(crlf))
} else {
  // 修前基线：没有这个纯函数（标记级判据无从谈起）—— 这里显式记一笔，而不是让测试崩掉。
  ok(false, 'readValidityMarker 导出存在（修前缺失）')
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
