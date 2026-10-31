#!/usr/bin/env node
/**
 * review-211-q05-test.mjs — Q05（外部审查 2.1.1）：锁表丢更新 + 损坏时当作全解锁。
 *
 * 两个独立缺陷：
 *   1. 锁表是无队列的整文件 read-modify-write。原子 rename 保证「不写半截」，
 *      但两个并发 RMW 各自读到旧表、后写的把先写的成果盖掉 —— 两边都报成功。
 *   2. 读取任何异常（坏 JSON / 权限 / 是目录……）都返回空 Set，于是「保护状态未知」
 *      与「确实一条都没锁」长得一模一样；自动归档会继续删受保护的记忆。
 *
 * 判据落在**实质证据**上：锁表里的条目数、坏表前后的文件字节、受保护文件是否还在原位。
 *
 * 用法: node test/review-211-q05-test.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const HERE = fileURLToPath(new URL('.', import.meta.url))
const LIB = join(HERE, '..', 'lib')
const mod = (p) => import(pathToFileURL(join(LIB, p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-q05-'))
let seq = 0
/** 每个用例一套独立记忆目录（锁表在它上一层的 .sage-mem/ 里）。 */
function world() {
  const root = join(sandbox, `w${++seq}`)
  const memoryDir = join(root, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  return { root, memoryDir, lockFile: join(root, '.sage-mem', 'locked.json') }
}
const readLockFile = (w) => readFileSync(w.lockFile, 'utf8')
const writeLockFile = (w, text) => {
  mkdirSync(join(w.root, '.sage-mem'), { recursive: true })
  writeFileSync(w.lockFile, text, 'utf8')
}
const body = (s) => `---\nname: audit\ndescription: quartz nebula\ntype: project\n---\n${s}\n`

const lockMod = await mod('memory/lock.js')
const { setLocked, readLockSet, readLockState } = lockMod
const { archiveMemory } = await mod('memory/archive.js')

// ═══ 1. 并发上锁：N 个不同文件 → 必须有 N 条（旧实现只剩 1 条） ═══
group('1. 12 次并发 setLocked（不同文件）→ 锁表必须有 12 条')
{
  const w = world()
  const names = Array.from({ length: 12 }, (_, i) => `file${i}.md`)
  const results = await Promise.all(names.map((n) => setLocked(w.memoryDir, n, true)))
  ok(results.every((r) => r.ok === true), '12 次调用都返回成功（旧实现也全都「成功」——所以只看返回值不算证据）',
    JSON.stringify(results.filter((r) => !r.ok)))
  const state = await readLockState(w.memoryDir)
  ok(state.status === 'ok', '锁表读得出来且状态正常', JSON.stringify(state.status))
  ok(state.locked.size === 12, `锁表里真的有 12 条（修前实测 ${'(只有 1 条)'}）`, `实际 ${state.locked.size}：${JSON.stringify([...state.locked])}`)
  ok(names.every((n) => state.locked.has(n)), '12 个文件名一个不少', JSON.stringify(names.filter((n) => !state.locked.has(n))))
  // 盘上的条目数也要对：内存集合对而盘上少也算丢
  const disk = JSON.parse(readLockFile(w))
  ok(Object.values(disk).filter((v) => v === true).length === 12, '盘上 locked.json 也是 12 条', JSON.stringify(disk).slice(0, 200))
}

// ═══ 2. 并发的加锁与解锁互不覆盖（同一份表的相反操作） ═══
group('2. 并发「上锁 6 条 + 解锁另外 6 条」→ 两边都生效')
{
  const w = world()
  for (const n of ['keep1.md', 'keep2.md', 'keep3.md', 'keep4.md', 'keep5.md', 'keep6.md']) await setLocked(w.memoryDir, n, true)
  const drops = ['drop1.md', 'drop2.md', 'drop3.md', 'drop4.md', 'drop5.md', 'drop6.md']
  for (const n of drops) await setLocked(w.memoryDir, n, true)
  await Promise.all([
    ...drops.map((n) => setLocked(w.memoryDir, n, false)),
    ...['new1.md', 'new2.md', 'new3.md', 'new4.md'].map((n) => setLocked(w.memoryDir, n, true)),
  ])
  const state = await readLockState(w.memoryDir)
  ok(['keep1.md', 'keep2.md', 'keep3.md', 'keep4.md', 'keep5.md', 'keep6.md'].every((n) => state.locked.has(n)), '原有的 6 条锁没被冲掉', JSON.stringify([...state.locked]))
  ok(drops.every((n) => !state.locked.has(n)), '并发的 6 次解锁全部生效（没有一个被后写覆盖回来）')
  ok(['new1.md', 'new2.md', 'new3.md', 'new4.md'].every((n) => state.locked.has(n)), '并发的 4 次新上锁全部生效')
  ok(state.locked.size === 10, `最终恰好 10 条（6 保留 + 4 新增）`, `实际 ${state.locked.size}`)
}

// ═══ 3. 坏表 = unknown，绝不当空表 ═══
group('3. 坏锁表：状态必须是 unknown，而不是「空表」')
{
  const w = world()
  writeLockFile(w, '{broken')
  const state = await readLockState(w.memoryDir)
  ok(state.status === 'unknown', '坏 JSON → status=unknown', JSON.stringify(state.status))
  ok(typeof state.reason === 'string' && state.reason.length > 0, 'unknown 带得出原因（排错要有话说）', JSON.stringify(state.reason))
  let threw = null
  try { await readLockSet(w.memoryDir) } catch (e) { threw = e }
  ok(threw && threw.code === 'LOCK_TABLE_UNKNOWN', '兼容出口 readLockSet 对 unknown 抛 LOCK_TABLE_UNKNOWN（不返回空 Set）',
    String(threw && (threw.code || threw.message)))

  // 「确实没有锁」与「保护状态未知」必须区分开：缺文件是 missing，不是 unknown。
  const empty = world()
  const missing = await readLockState(empty.memoryDir)
  ok(missing.status === 'missing' && missing.locked.size === 0, '锁表文件不存在 → status=missing（确实没有锁）', JSON.stringify(missing.status))
}

// ═══ 4. 坏表上 setLocked：拒绝，且不静默把全表重置成一条 ═══
group('4. 坏表上的下一次 setLocked：拒绝写入，坏表逐字节不变')
{
  const w = world()
  writeLockFile(w, '{broken')
  const before = readLockFile(w)
  const res = await setLocked(w.memoryDir, 'x.md', true)
  ok(res.ok === false && res.code === 'lock-table-unknown',
    '坏表上写入被明确拒绝（不是「重写成空表 + 新锁」）', JSON.stringify(res))
  ok(readLockFile(w) === before, '坏表一个字节都没被改（用户的保护状态还在盘上，可人工恢复）', readLockFile(w))
  ok(existsSync(w.lockFile), '文件没被删掉')

  // 反向对照：修好表之后写入照常，并且保留原有条目
  writeLockFile(w, JSON.stringify({ 'keep.md': true }, null, 2))
  const healed = await setLocked(w.memoryDir, 'added.md', true)
  const after = JSON.parse(readLockFile(w))
  ok(healed.ok === true && after['keep.md'] === true && after['added.md'] === true,
    '【反向对照】表修好后能正常加锁，且原有条目被保留', JSON.stringify(after))

  // 另一类非 ENOENT 读失败（这里是「锁定文件其实是个目录」）同样必须 unknown：
  // 权限错误走的是同一个 catch 分支，不依赖平台。
  const dirWorld = world()
  mkdirSync(dirWorld.lockFile, { recursive: true })
  const dirState = await readLockState(dirWorld.memoryDir)
  ok(dirState.status === 'unknown', '非 ENOENT 的读失败（目录冒充锁表）→ unknown', JSON.stringify(dirState.status))
}

// ═══ 5. 坏表不能触发受保护文件的自动归档；正常路径不退化 ═══
group('5. 锁状态未知时，归档必须暂停（受保护的文件不能被移走）')
{
  const w = world()
  writeFileSync(join(w.memoryDir, 'a.md'), body('PROTECTED'), 'utf8')
  writeLockFile(w, '{broken')
  const res = await archiveMemory(w.memoryDir, 'a.md', '自动归档：project 类，超过 30 天未被注入')
  ok(res.ok === false && res.code === 'lock-unknown',
    '锁表损坏时归档被拒绝（code=lock-unknown），而不是当成「没锁」继续删', JSON.stringify(res))
  ok(existsSync(join(w.memoryDir, 'a.md')), '受保护文件仍在原位', existsSync(join(w.memoryDir, 'a.md')))
  ok(!existsSync(join(w.memoryDir, 'archive', 'a.md')), '归档区没有多出副本（确实没动）')

  // 表修好并明确写着 a.md 锁着 → 仍然拒绝（这条是原有的保护，不能被 Q05 改丢）
  writeLockFile(w, JSON.stringify({ 'a.md': true }))
  const locked = await archiveMemory(w.memoryDir, 'a.md', '手动归档')
  ok(locked.ok === false && locked.code === 'locked', '表正常且 a.md 锁着 → code=locked（原有保护仍在）', JSON.stringify(locked))
  ok(existsSync(join(w.memoryDir, 'a.md')), '锁着的文件没被移走')

  // 反向对照：表正常且为空 → 归档照常成功（修法不能把正常路径一起关死）
  writeLockFile(w, '{}')
  const okay = await archiveMemory(w.memoryDir, 'a.md', '手动归档')
  ok(okay.ok === true, '【反向对照】表正常且未锁定 → 归档成功', JSON.stringify(okay))
  ok(existsSync(join(w.memoryDir, 'archive', 'a.md')) && !existsSync(join(w.memoryDir, 'a.md')),
    '文件确实从根目录移进了 archive/（证明上面那条成功不是空话）')
}

// ═══ 6. 反向对照：并发判据确实会因为真丢更新而变红 ═══
group('6. 【反向对照】串行写入 12 条一定全在（排除「12 条」这种判据本身写错）')
{
  const w = world()
  for (let i = 0; i < 12; i++) await setLocked(w.memoryDir, `s${i}.md`, true)
  const state = await readLockState(w.memoryDir)
  ok(state.locked.size === 12, '串行路径 12/12（与组 1 的并发 12/12 对照）', `实际 ${state.locked.size}`)
  // 大小写归一仍然生效（NTFS 语义，Q05 不该弄丢这条）
  await setLocked(w.memoryDir, 'User_Persona.MD', true)
  ok((await readLockState(w.memoryDir)).locked.has('user_persona.md'), '锁表仍按 nameKey 归一（大小写不敏感）')
}

rmSync(sandbox, { recursive: true, force: true })

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
