/**
 * 2.1.8 / 外部审查 N02：相反裁决没有串行化，单文件 CAS 保护不了整项操作。
 *
 * 问题（修前）：两次 `invalidate` 都读到 open；之后分别改**不同**记忆文件，文件级
 * `replaceIfVersion` 都能合法成功；最后无条件更新同一条冲突记录，只有最后一份收据留下 ——
 * 两份记忆都失效了，而记录只记得其中一份。模块注释要求「同 id 由调用方串行」，Gateway 没做。
 *
 * 这组断言盯的：
 *   ① 相反并发裁决只能有一方真正提交，另一方收到**结构化拒绝**（invalid_transition），
 *      并且检查**两份正文 + 记录**，不只检查返回值；
 *   ② 队列内重新读状态：后到的那一方看到已裁决，不会把记号再写一遍（记忆写入次数 = 1）；
 *   ③ 不同冲突改同一文件时按文件串行（两次提交都合法，但写盘不重叠）；
 *   ④ undo / dismiss / removeRecord 与 invalidate 交错的终态一致性；
 *   ⑤ 写记忆成功、写记录失败后的**幂等重试**（不会重复写正文）。
 *
 * 修前红证据（2.1.1 基线，report 里那段复现）：{successes:2, aInvalid:true, bInvalid:true,
 * receipt:"b.md"} —— 两边都成功、两份记忆都失效、记录只剩一份收据。
 *
 * 只碰临时目录：SAGE_MEM_DIR / SAGE_MEM_STATE_DIR 必须在 import lib 之前设好。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { rm, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = join(tmpdir(), `sage-mem-n02-test-${process.pid}`)
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

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const hash = (buf) => createHash('sha256').update(buf).digest('hex')
const body = (n) => `---\nname: ${n}\ntype: project\ndescription: N02 夹具\n---\n\n${n} body\n`

/**
 * 假宿主 fs（与审查复现同构）：版本 = 实际内容 sha256，写用 replaceIfVersion。
 * 额外统计「记忆写入次数 / 同时在写的最大并发」——串行化的实质证据，不只看看返回值。
 */
const stats = { writes: 0, active: 0, maxActive: 0, delayMs: 0, afterWrite: null }
const host = {
  resolve: async (p) => p,
  stat: async (p) => ({ version: hash(await readFile(p)) }),
  writeText: async (p, text, guard) => {
    stats.active += 1
    stats.maxActive = Math.max(stats.maxActive, stats.active)
    try {
      if (stats.delayMs > 0) await new Promise((r) => setTimeout(r, stats.delayMs))
      const before = hash(await readFile(p))
      if (guard && guard.kind === 'replaceIfVersion' && guard.version !== before) {
        throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
      }
      await writeFile(p, text)
      stats.writes += 1
      if (stats.afterWrite) await stats.afterWrite(p, text)
      return { version: hash(Buffer.from(text, 'utf8')) }
    } finally {
      stats.active -= 1
    }
  },
}
const ctx = { get: (n) => (n === 'fs' ? host : undefined), logger: { warn: () => {}, error: () => {} } }
const api = Object.create(ConflictGateway.prototype)
api.ctx = ctx

const resetStats = () => { stats.writes = 0; stats.active = 0; stats.maxActive = 0; stats.delayMs = 0; stats.afterWrite = null }
const memPath = (f) => join(memDir, f)
const readMem = (f) => readFileSync(memPath(f), 'utf8')
const writeMem = (f, text) => writeFileSync(memPath(f), text, 'utf8')
const countMarker = (text, key) => (text.match(new RegExp(`^${key}:`, 'gm')) || []).length
const recPath = (id) => join(stateDir, 'conflicts', `${id}.json`)
const seedRecord = async (id, file, otherFile) => {
  await writeConflict(buildConflict({ id, kind: 'contradiction', file, otherFile }), { stateRoot: stateDir })
}
const recordOf = async (id) => {
  const r = await readConflict(id, { stateRoot: stateDir })
  return r.ok ? r.record : r
}

// ── 1. 相反并发裁决：只有一方真正提交，另一方明确拒绝 ─────────────
group('1. 相反并发裁决（a.md vs b.md）')
{
  writeMem('opp_a.md', body('opp A'))
  writeMem('opp_b.md', body('opp B'))
  await seedRecord('n02-opposite', 'opp_a.md', 'opp_b.md')
  resetStats()
  const pair = await Promise.all([
    api.invalidate({ id: 'n02-opposite', file: 'opp_a.md' }),
    api.invalidate({ id: 'n02-opposite', file: 'opp_b.md' }),
  ])
  const okCount = pair.filter((x) => x && x.ok === true).length
  const loser = pair.find((x) => x && x.ok !== true) || {}
  ok(okCount === 1, '只有一个请求成功（不是两边都成功）', JSON.stringify(pair.map((x) => ({ ok: x && x.ok, code: x && x.code }))))
  ok(loser.code === 'invalid_transition', '失败方收到结构化码 invalid_transition（不是异常文本）', JSON.stringify(loser))
  ok(!!loser.error, '失败方带可诊断的 error 文案', String(loser.error || ''))
  const aText = readMem('opp_a.md')
  const bText = readMem('opp_b.md')
  ok(countMarker(aText, 'invalid_at') === 1, '胜出方记忆真的被标失效（检查正文，不只看返回值）')
  ok(countMarker(bText, 'invalid_at') === 0, '败方记忆没有被标失效（B 保持有效）')
  ok(bText === body('opp B'), '败方记忆逐字节未变（正文没被动）')
  const rec = await recordOf('n02-opposite')
  ok(rec.status === 'resolved' && rec.decision === 'invalidate', '记录状态是 resolved / invalidate', JSON.stringify({ status: rec.status, decision: rec.decision }))
  ok(rec.invalidatedFile === 'opp_a.md', '记录记得的是真正提交的那一方（不是最后覆盖的那一方）', String(rec.invalidatedFile))
  ok(typeof rec.appliedVersion === 'string' && rec.appliedVersion !== '', '记录带写后版本收据', String(rec.appliedVersion))
  ok(stats.writes === 1, '只发生一次记忆写入（队列内重新读了状态，败方没有重写）', `writes=${stats.writes}`)
  ok(stats.maxActive === 1, '记忆写入没有并发（MaxActive === 1）', `maxActive=${stats.maxActive}`)
}

// ── 2. 顺序再裁决同样被明确拒绝（不是并发独有的运气）────────────────
group('2. 顺序再裁决也被拒绝 + 同方重复点幂等（反向对照）')
{
  const before = readMem('opp_b.md')
  const again = await api.invalidate({ id: 'n02-opposite', file: 'opp_b.md' })
  ok(again && again.ok === false && again.code === 'invalid_transition', '记录已裁决后再标另一方 → invalid_transition', JSON.stringify(again))
  ok(readMem('opp_b.md') === before, '拒绝时 b.md 逐字节不变')

  const aBefore = readMem('opp_a.md')
  const same = await api.invalidate({ id: 'n02-opposite', file: 'opp_a.md' })
  ok(same && same.ok === true, '同一方重复点仍然幂等成功（反向对照：不把正常路径也拒绝）', JSON.stringify(same))
  ok(same.wrote && same.wrote.version === (await recordOf('n02-opposite')).appliedVersion, '幂等回执回放原收据版本', JSON.stringify(same.wrote))
  ok(readMem('opp_a.md') === aBefore, '幂等重复点没有重写记忆文件（逐字节不变）')
}

// ── 3. 不同冲突标同一文件：文件级串行 ──────────────────────────────
group('3. 同一文件的文件级协调（两个不同冲突并发标 a.md）')
{
  writeMem('shared.md', body('shared A'))
  await seedRecord('n02-file-1', 'shared.md', 'x1.md')
  await seedRecord('n02-file-2', 'shared.md', 'x2.md')
  resetStats()
  stats.delayMs = 25 // 让「并发写」在统计上可见
  const pair = await Promise.all([
    api.invalidate({ id: 'n02-file-1', file: 'shared.md' }),
    api.invalidate({ id: 'n02-file-2', file: 'shared.md' }),
  ])
  ok(pair.every((x) => x && x.ok === true), '两个冲突的裁决都合法提交（文件级串行 → 不因 CAS 互相拒）', JSON.stringify(pair.map((x) => ({ ok: x && x.ok, code: x && x.code }))))
  ok(stats.maxActive === 1, '两次记忆写入没有重叠（文件级队列生效）', `maxActive=${stats.maxActive}`)
  ok(stats.writes === 2, '两次裁决各写了一次（都被记录为已提交）', `writes=${stats.writes}`)
  const text = readMem('shared.md')
  ok(countMarker(text, 'invalid_at') === 1, '文件里只有一份失效标记（不会出现两个 invalid_at）')
  ok(countMarker(text, 'superseded_by') === 1, '文件里只有一份 superseded_by')
  ok(text.includes('shared A body'), '正文没有被标记改写抹掉')
  const r1 = await recordOf('n02-file-1')
  const r2 = await recordOf('n02-file-2')
  ok(r1.status === 'resolved' && r2.status === 'resolved', '两份记录都落在 resolved')
}

// ── 4. undo 与 invalidate 交错 ────────────────────────────────────
group('4. undo / invalidate 交错')
{
  writeMem('undo_a.md', body('undo A'))
  await seedRecord('n02-undo-1', 'undo_a.md', 'undo_b.md')
  const [inv, und] = await Promise.all([api.invalidate({ id: 'n02-undo-1', file: 'undo_a.md' }), api.undo({ id: 'n02-undo-1' })])
  const text = readMem('undo_a.md')
  const rec = await recordOf('n02-undo-1')
  // 队列顺序 = 调用顺序：invalidate 先提交，随后 undo 撤掉它 → 终态 dismissed 且标记清掉。
  ok(inv && inv.ok === true, '先入队的 invalidate 成功', JSON.stringify(inv))
  ok(und && und.ok === true, '后入队的 undo 成功（看到的是已裁决状态）', JSON.stringify(und))
  ok(countMarker(text, 'invalid_at') === 0 && countMarker(text, 'superseded_by') === 0, '终态：失效标记已被撤销')
  ok(text.includes('undo A body'), '终态：撤销没有丢正文')
  ok(rec.status === 'dismissed' && rec.decision === '', '终态：记录与文件一致（dismissed / 无标记）', JSON.stringify({ status: rec.status, decision: rec.decision }))
  ok(rec.invalidatedFile === '', '撤销后记录也清掉了 invalidatedFile 收据')
}
{
  writeMem('undo_b.md', body('undo B'))
  await seedRecord('n02-undo-2', 'undo_b.md', 'undo_c.md')
  const [und, inv] = await Promise.all([api.undo({ id: 'n02-undo-2' }), api.invalidate({ id: 'n02-undo-2', file: 'undo_b.md' })])
  const text = readMem('undo_b.md')
  const rec = await recordOf('n02-undo-2')
  ok(und && und.ok === false && und.code === 'invalid_transition', '先入队的 undo 在还没裁决时被明确拒绝（不是静默成功）', JSON.stringify(und))
  ok(inv && inv.ok === true, '后入队的 invalidate 照常提交', JSON.stringify(inv))
  ok(countMarker(text, 'invalid_at') === 1 && rec.status === 'resolved', '终态一致：标记与记录都在（没有 torn state）', JSON.stringify({ marker: countMarker(text, 'invalid_at'), status: rec.status }))
  ok(und.ok !== true || countMarker(text, 'invalid_at') === 0, '不存在「undo 报成功但标记还在」的矛盾终态')
}

// ── 5. dismiss / removeRecord 与 invalidate 交错 ──────────────────
group('5. dismiss / removeRecord 与 invalidate 交错')
{
  writeMem('dis_a.md', body('dismiss A'))
  await seedRecord('n02-dismiss-1', 'dis_a.md', 'dis_b.md')
  const [inv, dis] = await Promise.all([api.invalidate({ id: 'n02-dismiss-1', file: 'dis_a.md' }), api.dismiss({ id: 'n02-dismiss-1' })])
  const rec = await recordOf('n02-dismiss-1')
  ok(inv && inv.ok === true, 'invalidate 先提交成功', JSON.stringify(inv))
  ok(dis && dis.ok === false && dis.code === 'invalid_transition', '已标失效的记录不能被直接驳回（否则留下没有撤销入口的孤儿标记）', JSON.stringify(dis))
  ok(rec.status === 'resolved' && rec.decision === 'invalidate', '终态：记录仍是失效裁决（没有被驳回覆盖）', JSON.stringify({ status: rec.status, decision: rec.decision }))
  ok(countMarker(readMem('dis_a.md'), 'invalid_at') === 1, '终态：标记仍在，且与记录一致')
}
{
  writeMem('dis_c.md', body('dismiss C'))
  await seedRecord('n02-dismiss-2', 'dis_c.md', 'dis_d.md')
  const [dis, inv] = await Promise.all([api.dismiss({ id: 'n02-dismiss-2' }), api.invalidate({ id: 'n02-dismiss-2', file: 'dis_c.md' })])
  const rec = await recordOf('n02-dismiss-2')
  ok(dis && dis.ok === true, 'dismiss 先提交成功（open → dismissed）', JSON.stringify(dis))
  ok(inv && inv.ok === false && inv.code === 'invalid_transition', '随后 invalidate 明确拒绝（记录已不是 open）', JSON.stringify(inv))
  ok(rec.status === 'dismissed' && countMarker(readMem('dis_c.md'), 'invalid_at') === 0, '终态一致：dismissed 且没有标记（没有 torn state）')
}
{
  writeMem('rem_a.md', body('remove A'))
  await seedRecord('n02-remove-1', 'rem_a.md', 'rem_b.md')
  const [inv, rem] = await Promise.all([api.invalidate({ id: 'n02-remove-1', file: 'rem_a.md' }), api.removeRecord({ id: 'n02-remove-1' })])
  ok(inv && inv.ok === true, 'invalidate 先提交成功', JSON.stringify(inv))
  ok(rem && rem.ok === false && rem.code === 'invalid_transition', '记忆仍标失效时不允许删记录（删掉就失去撤销入口）', JSON.stringify(rem))
  ok((await recordOf('n02-remove-1')).status === 'resolved', '记录仍在、仍是 resolved')
  ok(countMarker(readMem('rem_a.md'), 'invalid_at') === 1, '标记仍在，且还有记录可以撤销')
}
{
  writeMem('rem_c.md', body('remove C'))
  await seedRecord('n02-remove-2', 'rem_c.md', 'rem_d.md')
  const [rem, inv] = await Promise.all([api.removeRecord({ id: 'n02-remove-2' }), api.invalidate({ id: 'n02-remove-2', file: 'rem_c.md' })])
  const rec = await recordOf('n02-remove-2')
  ok(rem && rem.ok === true, 'removeRecord 先提交成功（open 记录允许清理）', JSON.stringify(rem))
  ok(inv && inv.ok === false && inv.code === 'missing', '随后 invalidate 明确报 missing（记录已经不在了）', JSON.stringify(inv))
  ok(countMarker(readMem('rem_c.md'), 'invalid_at') === 0, '终态：没有「记录已删、标记却写进正文」的孤儿标记')
  ok(rec.ok !== true || rec.status !== 'resolved', '终态：不存在没有记录的 resolved 状态')
}

// ── 6. 写记忆成功、写记录失败 → 幂等重试一致性 ───────────────────
group('6. 写记忆成功 + 写记录失败：重试收据一致')
{
  writeMem('retry_a.md', body('retry A'))
  await seedRecord('n02-retry', 'retry_a.md', 'retry_b.md')
  const saved = readFileSync(recPath('n02-retry'))
  resetStats()
  // 记忆写成功之后把记录路径换成同名目录 → patchConflict 的 readFile 拿到 EISDIR → io_error。
  stats.afterWrite = async () => {
    stats.afterWrite = null
    await rm(recPath('n02-retry'), { recursive: true, force: true })
    mkdirSync(recPath('n02-retry'))
  }
  const first = await api.invalidate({ id: 'n02-retry', file: 'retry_a.md' })
  ok(first && first.ok === false, '第一次调用如实报失败（半态不冒充成功）', JSON.stringify(first))
  ok(first && first.code === 'io_error', '失败码是记录写入失败（io_error）', JSON.stringify(first))
  ok(countMarker(readMem('retry_a.md'), 'invalid_at') === 1, '半态：记忆已经标失效（下一步重试就能补记录）')
  // 恢复记录文件（用户什么都没做，只是故障过去了），再点一次
  await rm(recPath('n02-retry'), { recursive: true, force: true })
  writeFileSync(recPath('n02-retry'), saved)
  const writesBefore = stats.writes
  const retry = await api.invalidate({ id: 'n02-retry', file: 'retry_a.md' })
  const rec = await recordOf('n02-retry')
  ok(retry && retry.ok === true, '重试成功（写入是幂等的）', JSON.stringify(retry))
  ok(rec.status === 'resolved' && rec.decision === 'invalidate' && rec.invalidatedFile === 'retry_a.md', '重试补上了记录收据（状态与收据齐全）', JSON.stringify({ status: rec.status, invalidatedFile: rec.invalidatedFile }))
  ok(countMarker(readMem('retry_a.md'), 'invalid_at') === 1, '重试没有写出第二个 invalid_at（正文幂等）')
  // 重试会把同一对标记行重写一遍（invalid_at 取这次的时间戳），所以允许至多一次写入；
  // 真正要守住的是「不重复标记、不丢正文、记录收据与盘上内容版本一致」。
  ok(stats.writes - writesBefore <= 1, '重试最多只写一次正文（不会每重试一次叠一层）', `writes=${stats.writes - writesBefore}`)
  const retryText = readMem('retry_a.md')
  const markerAt = (retryText.match(/^invalid_at: (.+)$/m) || [])[1] || ''
  ok(markerAt === rec.decidedAt, '盘上的 invalid_at 与记录 decidedAt 一致（收据对得上正文）', JSON.stringify({ markerAt, decidedAt: rec.decidedAt }))
  ok(retryText.includes('retry A body'), '重试没有丢正文')
  // 收尾：撤销可用
  const und = await api.undo({ id: 'n02-retry' })
  ok(und && und.ok === true && countMarker(readMem('retry_a.md'), 'invalid_at') === 0, '重试后的记录可以正常撤销（收据可用）', JSON.stringify(und))
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
