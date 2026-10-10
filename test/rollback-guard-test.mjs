/**
 * 回滚安全带的两条回归。
 *
 *   G-1  保护快照不完整时仍然回滚 → 用一份假的保险覆盖当前版本
 *   G-2  文件级回滚漏掉策略自动归档 → 面板报「已回滚」，文件还在 archive/
 *
 * 两条都是**回滚这条路上的「报告与事实不符」**，所以断言的重点不是「函数返回了什么」，
 * 而是**盘上到底变成了什么样**：记忆目录一字未动、文件真的回到顶层、内容不带归档留痕。
 *
 * 说明两处测法：
 *   - G-1 的「枚举失败」用**真实** ENOTDIR（把记忆路径做成一个文件）验证；
 *     「保护快照残缺」在 `snapshot()` 边界做**故障注入**（评审的复现手法也是注入），
 *     因为要让单个文件的读取真的失败得靠 icacls 拒权，那在 CI 里不稳定。
 *   - G-2 用**真实的** `archiveMemory()` 把文件移走（连 `archived_at` 留痕一起产生），
 *     再按运行记录的真实形状造 manifest —— 归档这一步不是模拟的。
 */
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const LIB = new URL('../lib/', import.meta.url)
const { AutodreamEngine } = await import(new URL('autodream.js', LIB).href)
const { archiveMemory } = await import(new URL('memory/archive.js', LIB).href)

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

const makeCtx = () => ({ get: () => undefined, logger: { warn: () => {}, error: () => {} } })

/** 一个只跑回滚、不跑模型的临时世界。 */
async function world() {
  const root = await mkdtemp(join(tmpdir(), 'rb-guard-'))
  const memoryDir = join(root, 'memory')
  const sessionsRoot = join(root, 'sessions')
  await mkdir(memoryDir, { recursive: true })
  await writeFile(join(memoryDir, 'MEMORY.md'), '# 索引\n', 'utf8')
  await writeFile(join(memoryDir, 'a.md'), '---\nname: a\ntype: project\n---\n\n# A\n\n原文\n', 'utf8')
  const engine = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot })
  await engine.load()
  return { root, memoryDir, engine }
}

const exists = async (p) => (await stat(p).catch(() => null)) !== null

console.log('== G-1a：记忆目录读不动时，快照必须出声（不能静默返回空快照）==')
{
  const root = await mkdtemp(join(tmpdir(), 'rb-guard-'))
  // 把「记忆目录」做成一个普通文件：readdir 会 ENOTDIR。
  // 旧写法 `.catch(() => [])` 会把它当成「空目录」，交出一份 count=0/expected=0/failed=[] 的快照。
  const notADir = join(root, 'this-is-a-file.md')
  await writeFile(notADir, 'x', 'utf8')
  const engine = new AutodreamEngine(makeCtx(), { memoryDir: notADir, sessionsRoot: join(root, 'sessions') })
  await engine.load()
  let threw = null
  try {
    await engine.snapshot('20261009-200000-enum', 'run')
  } catch (e) {
    threw = e
  }
  ok(threw !== null, '快照不返回空结果，而是抛错')
  ok(String(threw?.message ?? '').includes('读不了记忆目录'), '错误信息说清是「读不了目录」', String(threw?.message ?? ''))
}

console.log('== G-1b：保护快照残缺 → 回滚中止，记忆目录一个字没动 ==')
{
  const { memoryDir, engine } = await world()
  const snap = await engine.snapshot('20261009-200100-run1', 'run')
  const CURRENT = '---\nname: a\ntype: project\n---\n\n# A\n\n这是当前版本，绝不能被覆盖\n'
  await writeFile(join(memoryDir, 'a.md'), CURRENT, 'utf8')

  // 故障注入：让「回滚前保护快照」缺一个文件（评审的复现同法）
  const orig = engine.snapshot.bind(engine)
  engine.snapshot = async (id, kind) => {
    const r = await orig(id, kind)
    return kind === 'pre-rollback' ? { ...r, failed: ['a.md'], count: Math.max(0, r.count - 1) } : r
  }

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
  ok(rb.ok === false, '保护快照残缺时回滚必须失败（旧实现返回 ok:true 并覆盖）', JSON.stringify(rb))
  ok(String(rb.error ?? '').includes('保护快照'), '错误说清问题出在保护快照', String(rb.error ?? ''))
  ok((await readFile(join(memoryDir, 'a.md'), 'utf8')) === CURRENT, '当前版本一个字没动')

  const snaps = await engine.listSnapshots()
  ok(
    !snaps.some((s) => s.kind === 'pre-rollback'),
    '残缺的保护快照已从 snapshots/ 删掉（留着就会被当成一份可选的回滚点）',
    JSON.stringify(snaps.map((s) => `${s.kind}:${s.name}`)),
  )
}

console.log('== G-2a：只有策略归档的运行，files 回滚要把文件退回来 ==')
{
  const { memoryDir, engine } = await world()
  const ORIGINAL = '---\nname: old\ntype: project\ndescription: 老条目\n---\n\n# 老条目\n\n正文原文\n'
  await writeFile(join(memoryDir, 'project_old.md'), ORIGINAL, 'utf8')
  const snap = await engine.snapshot('20261009-200200-run2', 'run')

  // 用**真实**归档实现把它移走（会往 frontmatter 里写 archived_at / archived_reason）
  const ar = await archiveMemory(memoryDir, 'project_old.md', '自动归档：project 类，超过 90 天未被注入')
  ok(ar.ok === true, '归档成功（真实实现，带留痕）', JSON.stringify(ar))
  ok(!(await exists(join(memoryDir, 'project_old.md'))), '归档后顶层确实没有它了')

  // 运行记录的真实形状：模型没改任何文件（changes 为空），策略归档单独一本账
  const runDir = join(engine.runsRoot, snap.id)
  await mkdir(runDir, { recursive: true })
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify({ runId: snap.id, changes: [], archive: { mode: 'auto', archived: [{ file: 'project_old.md', ok: true }] } }, null, 2),
    'utf8',
  )

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'files' })
  ok(rb.ok === true && rb.restored === 1, `策略归档的文件被退回顶层（restored=${rb.restored}, skipped=${rb.skipped}）`, JSON.stringify(rb))
  const back = await readFile(join(memoryDir, 'project_old.md'), 'utf8').catch(() => null)
  ok(back !== null, '文件真的回到顶层了')
  ok(back === ORIGINAL, '内容等于运行前那一版（不带 archived_at / archived_reason 留痕）', String(back).slice(0, 120))
  ok(!(await exists(join(memoryDir, 'archive', 'project_old.md'))), '归档区那份是「移回」而不是「复制一份」')
}

console.log('== G-2b：运行前不存在的文件，不会被回滚激活 ==')
{
  const { memoryDir, engine } = await world()
  const snap = await engine.snapshot('20261009-200300-run3', 'run')
  // 快照之后才出现、随后被策略归档的文件 —— 回滚该让它保持「不存在」
  await writeFile(join(memoryDir, 'project_new.md'), '---\nname: new\ntype: project\n---\n\n# 新的\n', 'utf8')
  await archiveMemory(memoryDir, 'project_new.md', '自动归档：project 类')
  const runDir = join(engine.runsRoot, snap.id)
  await mkdir(runDir, { recursive: true })
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify({ runId: snap.id, changes: [], archive: { mode: 'auto', archived: [{ file: 'project_new.md', ok: true }] } }, null, 2),
    'utf8',
  )

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'files' })
  ok(rb.ok === true && rb.restored === 0, '不去动它（restored=0）', JSON.stringify(rb))
  ok(!(await exists(join(memoryDir, 'project_new.md'))), '运行前不存在的文件没有被激活到顶层')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
