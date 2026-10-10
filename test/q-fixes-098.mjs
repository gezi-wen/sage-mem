/**
 * v0.9.8 两条修复的反面断言。
 *
 *   R1  **恢复归档记忆时没把它注册回索引**（`MEMORY.md`）。
 *       文件被搬回顶层了，索引里却没有它 → 体检报「漏索引」。
 *       真实事故（2026-10-11 在文歌子的库里确认）：`user_persona.md` 与
 *       `feedback_language_preference.md` 恢复后一直漏在索引外，两个都在顶层、索引里都没有。
 *       归档那一侧是**摘掉**的（所以归档后不报「索引悬空」）—— 摘了没加回。
 *
 *   R2  **没有任何办法让一条记忆拒绝归档**。自动归档只看闲置天数，
 *       重要记忆（人设 / 偏好这类）会被静默搬进 `archive/`。
 *       要的是「锁定」：锁上的记忆，自动与手动归档都拒绝。
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const LIB = new URL('../lib/', import.meta.url)
const { archiveMemory, restoreMemory } = await import(new URL('memory/archive.js', LIB).href)
const { pickArchiveCandidates } = await import(new URL('memory/access.js', LIB).href)
// 锁定模块是本版新增；先动态 import，这样「模块还不存在」是一条干净的 FAIL，不是整脚本崩。
const lockMod = await import(new URL('memory/lock.js', LIB).href).catch(() => null)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`)
  }
}

/** 搭一个记忆目录：根 + 索引 + 归档区。 */
async function makeDir({ index = true, archived = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sage-mem-098-'))
  const memoryDir = join(root, 'memory')
  await mkdir(join(memoryDir, 'archive'), { recursive: true })
  if (index) {
    await writeFile(
      join(memoryDir, 'MEMORY.md'),
      ['# 记忆索引', '', '> 索引里每条的描述必须与文件实际内容一致；改动记忆时同步改这里。', '', '- [既有一条](existing_one.md) — 原来就在索引里的', ''].join('\n'),
      'utf8',
    )
  }
  for (const f of archived) {
    await writeFile(join(memoryDir, 'archive', f.name), f.text, 'utf8')
  }
  return { root, memoryDir }
}

const FS = '\ufeff'
/** 一条普通记忆（带 frontmatter），恢复后应当能拿 name / description 生成索引条目。 */
const NOTE = (desc) => `---\nname: user-persona\ndescription: ${desc}\nmetadata:\n  node_type: memory\n  type: user\n---\n\n正文。\n`
/** 归档副本：正文外加两行留痕（归档时间 / 理由）。 */
const ARCHIVED = (desc, reason = '闲置 200 天') =>
  `---\nname: user-persona\ndescription: ${desc}\nmetadata:\n  node_type: memory\n  type: user\n---\n\narchived_at: 2026-10-01 09:30\narchived_reason: ${reason}\n\n正文。\n`

const cleanup = []
const tmpDirs = []

console.log('== 1. 恢复归档记忆 → 注册回索引（R1）==')
{
  const { root, memoryDir } = await makeDir({ archived: [{ name: 'user_persona.md', text: ARCHIVED('用户指定的人设，温和耐心') }] })
  tmpDirs.push(root)
  const before = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')

  const r = await restoreMemory(memoryDir, 'user_persona.md')
  ok(r.ok === true, '恢复本身成功', JSON.stringify(r))

  const idx = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
  ok(idx.includes('user_persona.md'), '恢复后索引里出现了这条记忆（当前实现只搬文件、不补索引）', JSON.stringify(idx.split('\n').slice(-3)))
  const line = idx.split('\n').find((l) => l.includes('user_persona.md')) ?? ''
  ok(/^\s*-\s*\[/.test(line), `索引条目是「- [标题](文件.md) — 描述」的形状（实际：${JSON.stringify(line)}）`)
  ok(line.includes('用户指定的人设'), '条目里带着描述（从恢复后文件的 frontmatter 取）')

  // 索引是用户手写的，追加条目不许动到原有内容
  ok(idx.startsWith('# 记忆索引'), '索引第一行原样保留')
  ok(idx.includes('- [既有一条](existing_one.md) — 原来就在索引里的'), '原有条目一条不少')
  ok(idx.includes('索引里每条的描述必须与文件实际内容一致'), '索引里的说明段原样保留')
  ok(idx.length > before.length, '是「追加」而不是「重写」')
}

console.log('== 2. 索引里已经有它 → 不重复添加 ==')
{
  const { root, memoryDir } = await makeDir({ archived: [{ name: 'user_persona.md', text: ARCHIVED('用户指定的人设') }] })
  tmpDirs.push(root)
  // 先在索引里手写一条指向它的（模拟「用户自己维护过了」）
  const idxPath = join(memoryDir, 'MEMORY.md')
  await writeFile(idxPath, (await readFile(idxPath, 'utf8')) + '- [我自己写的](user_persona.md) — 手写描述\n', 'utf8')
  await restoreMemory(memoryDir, 'user_persona.md')
  const idx = await readFile(idxPath, 'utf8')
  const hits = idx.split('\n').filter((l) => l.includes('user_persona.md'))
  ok(hits.length === 1, `索引里仍只有一条（不重复追加；实际 ${hits.length} 条）`, JSON.stringify(hits))
  ok(hits[0].includes('我自己写的'), '保留用户手写的那条，不覆盖')
}

console.log('== 3. 恢复失败时索引一个字节都不动 ==')
{
  const { root, memoryDir } = await makeDir({ archived: [{ name: 'user_persona.md', text: ARCHIVED('人设') }] })
  tmpDirs.push(root)
  // 顶层已有同名 → 恢复必须拒绝
  await writeFile(join(memoryDir, 'user_persona.md'), NOTE('活的那条'), 'utf8')
  const before = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
  const r = await restoreMemory(memoryDir, 'user_persona.md')
  ok(r.ok === false && r.code === 'target-exists', '顶层同名 → 恢复被拒（原有行为）', JSON.stringify(r))
  const after = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
  ok(after === before, '拒绝时索引未被改动')
}

console.log('== 4. 索引不存在时不崩 ==')
{
  const { root, memoryDir } = await makeDir({ index: false, archived: [{ name: 'user_persona.md', text: ARCHIVED('人设') }] })
  tmpDirs.push(root)
  const r = await restoreMemory(memoryDir, 'user_persona.md')
  ok(r.ok === true, '没有索引也照常恢复（索引是可选件）', JSON.stringify(r))
  ok((await stat(join(memoryDir, 'user_persona.md')).catch(() => null)) !== null, '文件确实回到顶层')
}

console.log('== 5. 锁定：让一条记忆拒绝归档（R2）==')
{
  ok(!!lockMod, 'lib/memory/lock.js 存在（锁定能力的落点）')
  if (!lockMod) {
    console.log('  （锁定模块还不存在，后面的断言先记 FAIL）')
    for (const n of ['setLocked 能写锁', ' archiveMemory 拒绝已锁定的记忆', '归档被拒后文件内容与位置都不变', '锁定的记忆不进归档候选', '解锁后恢复可归档', '锁表按大小写归一（NTFS 语义）']) ok(false, n)
  } else {
    const { setLocked, isLocked, readLockSet } = lockMod
    const { root, memoryDir } = await makeDir({ archived: [] })
    tmpDirs.push(root)
    const target = 'user_persona.md'
    const body = NOTE('要紧的人设，不许被自动归档')
    await writeFile(join(memoryDir, target), body, 'utf8')

    const set = await setLocked(memoryDir, target, true)
    ok(set.ok === true && (await isLocked(memoryDir, target)) === true, 'setLocked 能写锁', JSON.stringify(set))
    ok(await isLocked(memoryDir, 'user_persona.md'), 'isLocked 认得出来')

    const locked = await archiveMemory(memoryDir, target, '测试')
    ok(locked.ok === false && locked.code === 'locked', 'archiveMemory 拒绝已锁定的记忆（手动也不行）', JSON.stringify(locked))
    ok((await readFile(join(memoryDir, target), 'utf8')) === body, '归档被拒后文件内容一个字节没变')
    ok((await stat(join(memoryDir, 'archive', target)).catch(() => null)) === null, '归档区里没有它')

    // 自动归档候选：锁定的不进候选
    const files = [{ file: target, type: 'user', mtimeMs: Date.now() - 400 * 86400000 }]
    const lockedSet = await readLockSet(memoryDir)
    const picked = pickArchiveCandidates(files, {}, { thresholds: { user: 90 }, locked: lockedSet }, Date.now())
    ok(picked.length === 0, '锁定的记忆不进归档候选（阈值早过了也不选）', JSON.stringify(picked))
    const pickedUnlocked = pickArchiveCandidates(files, {}, { thresholds: { user: 90 } }, Date.now())
    ok(pickedUnlocked.length === 1, '同一份输入、不传锁表时它本来是会入选的（证明上面那条是锁起的作用）', JSON.stringify(pickedUnlocked))

    await setLocked(memoryDir, target, false)
    ok((await isLocked(memoryDir, target)) === false, '解锁后 isLocked 变 false')
    const after = await archiveMemory(memoryDir, target, '测试')
    ok(after.ok === true, '解锁后可以归档', JSON.stringify(after))

    // 锁表按 NTFS 语义归一：大小写不同是同一个文件
    await setLocked(memoryDir, 'User_Persona.MD', true)
    ok((await isLocked(memoryDir, 'user_persona.md')) === true, '锁表按大小写归一（NTFS 语义）')
  }
}

console.log('== 6. 锁定不碰记忆文件本身 ==')
{
  if (lockMod) {
    const { setLocked } = lockMod
    const { root, memoryDir } = await makeDir({ archived: [] })
    tmpDirs.push(root)
    const target = 'user_persona.md'
    const body = NOTE('正文')
    await writeFile(join(memoryDir, target), body, 'utf8')
    await setLocked(memoryDir, target, true)
    ok((await readFile(join(memoryDir, target), 'utf8')) === body, '上锁不改记忆文件的正文（锁存在状态目录，不写 frontmatter）')
    ok((await stat(join(root, '.sage-mem', 'locked.json')).catch(() => null)) !== null, '锁落在状态根 .sage-mem/locked.json')
  } else {
    ok(false, '上锁不改记忆文件的正文（锁存在状态目录，不写 frontmatter）')
    ok(false, '锁落在状态根 .sage-mem/locked.json')
  }
}

for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => {})
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
