/**
 * v0.9.3 三条修复的反面断言。
 *
 * 编号是**本文件内部的分组标签**（每条都先能复现旧行为，再靠修复转绿）：
 *   Q02  原子写的临时文件名固定 → 同进程并发写同一目标时互相抢临时文件
 *   Q04  回滚**不校验快照内容** → 快照被外部改过 / 备份还原错版本，照样往记忆目录里写
 *   Q06  文件级回滚按 `changes` 的**条目顺序**逐条执行 → 同一趟「先新建、后归档」的文件
 *        被 create 那段 park 进 archive/、又被 archive 那段搬回顶层，回滚反而**激活**了
 *        一条运行前不存在的记忆
 *
 * 写法说明：
 *   - Q02 的两条：行为断言直接并发打 20 次；`write_memory` 走没走原子写用**源码结构守卫**
 *     守着（ESM 的命名导入是只读绑定，没法在测试里替换掉再计数）——谁改回裸 `writeFile` 就红。
 *   - Q04 的四条：篡改 / 缺文件 / 多文件三种坏形状都必须**拒绝整趟回滚**，另外留一条
 *     「没动过的快照照样能滚」防「一律拒绝」式的假修。
 *   - Q06 的两条：归档用**真实** `archiveMemory()`，运行记录按 engine 落盘的真实形状手写。
 */
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fsIsCaseInsensitive } from './_platform.mjs'

const LIB = new URL('../lib/', import.meta.url)
const { AutodreamEngine } = await import(new URL('autodream.js', LIB).href)
const { archiveMemory } = await import(new URL('memory/archive.js', LIB).href)
const { writeFileAtomic } = await import(new URL('memory/util.js', LIB).href)

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
const exists = async (p) => (await stat(p).catch(() => null)) !== null

async function world() {
  const root = await mkdtemp(join(tmpdir(), 'q093-'))
  const memoryDir = join(root, 'memory')
  const sessionsRoot = join(root, 'sessions')
  await mkdir(memoryDir, { recursive: true })
  await writeFile(join(memoryDir, 'MEMORY.md'), '# 索引\n', 'utf8')
  await writeFile(join(memoryDir, 'a.md'), '---\nname: a\ntype: project\n---\n\n# A\n\n原文\n', 'utf8')
  const engine = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot })
  await engine.load()
  return { root, memoryDir, engine }
}

// ────────────────────────── Q02 ──────────────────────────

console.log('== Q02a：同一目标并发 20 次原子写，必须全部成功且不留 .tmp ==')
{
  const dir = await mkdtemp(join(tmpdir(), 'q02-'))
  const target = join(dir, 'MEMORY.md')
  const N = 20
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => writeFileAtomic(target, `# 版本 ${i}\n`)),
  )
  const rejected = results.filter((r) => r.status === 'rejected')
  ok(
    rejected.length === 0,
    `${N} 次并发写全部成功（失败 ${rejected.length} 次）`,
    rejected.map((r) => String(r.reason?.code ?? r.reason?.message)).slice(0, 4).join(' / '),
  )

  const final = await readFile(target, 'utf8').catch(() => null)
  const expected = Array.from({ length: N }, (_, i) => `# 版本 ${i}\n`)
  ok(expected.includes(final), '目标是某一个 writer 的完整内容（不是半截、也不是空）', JSON.stringify(final))

  const leftovers = (await readdir(dir)).filter((n) => n.endsWith('.tmp'))
  ok(leftovers.length === 0, '临时文件一个不留', JSON.stringify(leftovers))
}

console.log('== Q02b：write_memory 必须走原子写（源码结构守卫）==')
{
  const src = await readFile(new URL('../lib/autodream-tools.js', import.meta.url), 'utf8')
  const from = src.indexOf("case 'write_memory'")
  const to = src.indexOf("case 'archive_memory'")
  const seg = from >= 0 && to > from ? src.slice(from, to) : ''
  ok(seg.length > 0, '定位到 write_memory 的实现段')
  ok(/writeFileAtomic\(/.test(seg), 'write_memory 用 writeFileAtomic 落盘')
  ok(!/(^|[^c])\bwriteFile\(/.test(seg), 'write_memory 里没有裸 writeFile 直写（直写会留半截 frontmatter）')
}

// ────────────────────────── Q04 ──────────────────────────

console.log('== Q04a：快照内容被篡改 → 拒绝回滚，记忆目录一个字没动 ==')
{
  const { memoryDir, engine } = await world()
  const snap = await engine.snapshot('20261009-210000-run1', 'run')
  const CURRENT = '---\nname: a\ntype: project\n---\n\n# A\n\n当前版本\n'
  await writeFile(join(memoryDir, 'a.md'), CURRENT, 'utf8')
  // 篡改快照里的正文（sha256 不再对得上）
  await writeFile(join(snap.dir, 'a.md'), '---\nname: a\ntype: project\n---\n\n# A\n\n被换掉的内容\n', 'utf8')

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
  ok(rb.ok === false, '篡改过的快照被拒绝（旧实现照滚）', JSON.stringify(rb))
  ok(/校验|不一致|篡改|sha256/i.test(String(rb.error ?? '')), '错误说清是校验没过', String(rb.error ?? ''))
  ok((await readFile(join(memoryDir, 'a.md'), 'utf8')) === CURRENT, '当前版本没被覆盖成被篡改的快照内容')
}

console.log('== Q04b：快照里缺了 MANIFEST 记过的文件 → 拒绝 ==')
{
  const { memoryDir, engine } = await world()
  const snap = await engine.snapshot('20261009-210100-run2', 'run')
  await rm(join(snap.dir, 'a.md'))
  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
  ok(rb.ok === false, '缺文件的快照被拒绝', JSON.stringify(rb))
  ok(await exists(join(memoryDir, 'a.md')), '记忆目录里原文件还在（没被当成「快照里没有」搬进 archive/）')
}

console.log('== Q04c：快照目录里多出未记录的文件 → 拒绝（整目录回滚会把它复制进来）==')
{
  const { memoryDir, engine } = await world()
  const snap = await engine.snapshot('20261009-210200-run3', 'run')
  await writeFile(join(snap.dir, 'rogue.md'), '---\nname: rogue\ntype: project\n---\n\n# 外来的\n', 'utf8')
  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
  ok(rb.ok === false, '多出文件的快照被拒绝', JSON.stringify(rb))
  ok(!(await exists(join(memoryDir, 'rogue.md'))), '外来的文件没有被复制进记忆目录')
}

console.log('== Q04d：没动过的快照照样能滚（防「一律拒绝」的假修）==')
{
  const { memoryDir, engine } = await world()
  const snap = await engine.snapshot('20261009-210300-run4', 'run')
  await writeFile(join(memoryDir, 'a.md'), '---\nname: a\ntype: project\n---\n\n# A\n\n后来改的\n', 'utf8')
  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
  ok(rb.ok === true, '干净快照回滚成功', JSON.stringify(rb))
  ok(
    (await readFile(join(memoryDir, 'a.md'), 'utf8')).includes('原文'),
    '内容真的退回了快照那一版',
    String(await readFile(join(memoryDir, 'a.md'), 'utf8')).slice(0, 80),
  )
}

// ────────────────────────── Q06 ──────────────────────────

console.log('== Q06a：同一趟「先新建、后归档」的文件，文件级回滚不许激活它 ==')
{
  const { memoryDir, engine } = await world()
  const snap = await engine.snapshot('20261009-210400-run5', 'run')
  // 模拟模型这一趟新建 + 归档同一条（changes 有两条，档案账上也有它）
  await writeFile(join(memoryDir, 'project_new.md'), '---\nname: new\ntype: project\n---\n\n# 新的\n', 'utf8')
  const ar = await archiveMemory(memoryDir, 'project_new.md', '这趟刚建完又被取代，归档')
  ok(ar.ok === true, '归档成功（真实实现）', JSON.stringify(ar))

  const runDir = join(engine.runsRoot, snap.id)
  await mkdir(runDir, { recursive: true })
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify(
      {
        runId: snap.id,
        changes: [
          { seq: 1, file: 'project_new.md', op: 'create', before: { exist: false } },
          { seq: 2, file: 'project_new.md', op: 'archive', before: { exist: true } },
        ],
        archive: { mode: 'auto', archived: [{ file: 'project_new.md', ok: true }] },
      },
      null,
      2,
    ),
    'utf8',
  )

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'files' })
  ok(rb.ok === true, '回滚本身成功', JSON.stringify(rb))
  ok(
    !(await exists(join(memoryDir, 'project_new.md'))),
    '运行前不存在的文件没有被回滚激活到顶层（旧实现把它搬回来了）',
  )
  ok(await exists(join(memoryDir, 'archive', 'project_new.md')), 'archive/ 里那份仍在（不删）')
}

console.log('== Q06b：运行前就存在的文件被归档，回滚退回顶层且不带留痕 ==')
{
  const { memoryDir, engine } = await world()
  const ORIGINAL = await readFile(join(memoryDir, 'a.md'), 'utf8')
  const snap = await engine.snapshot('20261009-210500-run6', 'run')
  const ar = await archiveMemory(memoryDir, 'a.md', '这一趟被归档')
  ok(ar.ok === true, '归档成功（真实实现）', JSON.stringify(ar))

  const runDir = join(engine.runsRoot, snap.id)
  await mkdir(runDir, { recursive: true })
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify(
      { runId: snap.id, changes: [{ seq: 1, file: 'a.md', op: 'archive', before: { exist: true } }] },
      null,
      2,
    ),
    'utf8',
  )

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'files' })
  ok(rb.ok === true && rb.restored === 1, `归档的条目被退回顶层（restored=${rb.restored}）`, JSON.stringify(rb))
  const back = await readFile(join(memoryDir, 'a.md'), 'utf8').catch(() => null)
  ok(back !== null, '文件真的回到顶层')
  ok(back === ORIGINAL, '内容等于运行前那一版', String(back).slice(0, 100))
  ok(!String(back).includes('archived_at') && !String(back).includes('archived_reason'), '不带归档留痕')
}

console.log('== Q04e：新版回滚点的 MANIFEST.json 读不到 / 坏掉 → 拒绝（删一个文件不能绕过校验）==')
{
  const { memoryDir, engine } = await world()
  const snap = await engine.snapshot('20261009-210600-run7', 'run')
  const TAMPERED = '---\nname: a\ntype: project\n---\n\n# A\n\n被换掉的当前版本\n'
  await writeFile(join(memoryDir, 'a.md'), TAMPERED, 'utf8')
  await rm(join(snap.dir, 'MANIFEST.json'))

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
  ok(rb.ok === false, '缺 MANIFEST.json 的回滚点被拒绝（旧实现当成「旧版快照」放行）', JSON.stringify(rb))
  ok((await readFile(join(memoryDir, 'a.md'), 'utf8')) === TAMPERED, '记忆目录一个字没动')
}
{
  const { memoryDir, engine } = await world()
  const snap = await engine.snapshot('20261009-210700-run8', 'run')
  const TAMPERED = '---\nname: a\ntype: project\n---\n\n# A\n\n被换掉的当前版本\n'
  await writeFile(join(memoryDir, 'a.md'), TAMPERED, 'utf8')
  await writeFile(join(snap.dir, 'MANIFEST.json'), '{"schema":1,"files":[', 'utf8') // 半截 JSON

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
  ok(rb.ok === false, 'MANIFEST.json 解析失败的回滚点被拒绝', JSON.stringify(rb))
  ok((await readFile(join(memoryDir, 'a.md'), 'utf8')) === TAMPERED, '记忆目录一个字没动（半截 JSON 也不行）')
}

console.log('== Q04f：旧版目录里的无 MANIFEST 快照仍要放行（收紧不能废掉历史回滚点）==')
{
  const { memoryDir, engine } = await world()
  const legacyDir = join(engine.legacySnapshotRoot, 'legacy-1')
  await mkdir(legacyDir, { recursive: true })
  await writeFile(join(legacyDir, 'a.md'), '---\nname: a\ntype: project\n---\n\n# A\n\n旧版快照里的原文\n', 'utf8')
  await writeFile(join(memoryDir, 'a.md'), '---\nname: a\ntype: project\n---\n\n# A\n\n后来改的\n', 'utf8')

  const rb = await engine.rollback({ snapshotId: 'legacy-1', scope: 'all' })
  ok(rb.ok === true, '旧版快照（无 MANIFEST / 无哈希）仍然能整目录回滚', JSON.stringify(rb))
  ok(
    (await readFile(join(memoryDir, 'a.md'), 'utf8')).includes('旧版快照里的原文'),
    '内容真的退回了旧版那一份',
  )
}

console.log('== Q04g：合法文件名（中文 / 中间带点）不许被误判成「非法名字」==')
{
  const { memoryDir, engine } = await world()
  await writeFile(join(memoryDir, '笔记.md'), '---\nname: 笔记\ntype: project\n---\n\n# 中文名\n\n正文\n', 'utf8')
  await writeFile(join(memoryDir, 'a..b.md'), '---\nname: ab\ntype: project\n---\n\n# 双点\n\n正文\n', 'utf8')
  const snap = await engine.snapshot('20261009-210800-run9', 'run')
  await writeFile(join(memoryDir, '笔记.md'), '---\nname: 笔记\ntype: project\n---\n\n# 中文名\n\n改过了\n', 'utf8')

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
  ok(rb.ok === true, '中文名与带双点的合法文件名不会否掉整份快照', JSON.stringify(rb))
  ok(
    (await readFile(join(memoryDir, '笔记.md'), 'utf8')).includes('正文'),
    '内容退回了快照那一版',
  )
}

console.log('== Q04h：清单里带路径成分的名字仍然要判非法（收紧不能松掉穿越防护）==')
{
  const { memoryDir, engine } = await world()
  const snap = await engine.snapshot('20261009-210900-run10', 'run')
  const before = await readFile(join(memoryDir, 'a.md'), 'utf8')
  // 手工把清单改成带穿越的名字，并把诱饵放在快照目录之外
  const decoy = join(engine.snapshotRoot, '..', 'decoy.md')
  await writeFile(decoy, '---\nname: decoy\n---\n\n# 诱饵\n', 'utf8')
  const manifest = JSON.parse(await readFile(join(snap.dir, 'MANIFEST.json'), 'utf8'))
  manifest.files = [{ name: '..\\decoy.md', bytes: 10, sha256: 'deadbeef' }]
  await writeFile(join(snap.dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8')

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
  ok(rb.ok === false, '带路径成分的清单条目一律拒绝', JSON.stringify(rb))
  ok((await readFile(join(memoryDir, 'a.md'), 'utf8')) === before, '记忆目录没动')
  ok(!(await exists(join(memoryDir, 'decoy.md'))), '快照目录之外的诱饵没有被搬进来')
}

console.log('== Q06c：archive/ 里是**另一个版本**时，退回的必须是快照那一版 ==')
{
  const { memoryDir, engine } = await world()
  const RUN_BEFORE = '---\nname: a\ntype: project\n---\n\n# A\n\n运行前版本\n'
  await writeFile(join(memoryDir, 'a.md'), RUN_BEFORE, 'utf8')
  const snap = await engine.snapshot('20261009-211000-run11', 'run')
  // 人工脏状态：顶层没了、archive/ 里躺着一份**更早的**另一版
  await rm(join(memoryDir, 'a.md'))
  await mkdir(join(memoryDir, 'archive'), { recursive: true })
  await writeFile(
    join(memoryDir, 'archive', 'a.md'),
    '---\nname: a\ntype: project\narchived_at: 2026-01-01 00:00\narchived_reason: 很久以前\n---\n\n# A\n\nARCHIVE-OLDER\n',
    'utf8',
  )
  const runDir = join(engine.runsRoot, snap.id)
  await mkdir(runDir, { recursive: true })
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify({ runId: snap.id, changes: [{ seq: 1, file: 'a.md', op: 'archive', before: { exist: true } }] }, null, 2),
    'utf8',
  )

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'files' })
  ok(rb.ok === true && rb.restored === 1, '回滚报成功', JSON.stringify(rb))
  ok(rb.skipped === 0, '「改用快照版本写回」不算跳过（面板不该说「跳过 1 个」）', JSON.stringify(rb))
  ok(
    (await readFile(join(memoryDir, 'autodream', rb.report), 'utf8').catch(() => '')).includes('## 说明'),
    '回滚报告里为它单列一节「说明」',
  )
  ok(
    (await readFile(join(memoryDir, 'a.md'), 'utf8')) === RUN_BEFORE,
    '顶层内容 = 运行前快照那一版（旧实现会把 archive/ 里那份另一版搬回来还报成功）',
    String(await readFile(join(memoryDir, 'a.md'), 'utf8')).slice(0, 120),
  )
  ok(await exists(join(memoryDir, 'archive', 'a.md')), 'archive/ 里那份另一版没被吃掉（不删）')
  ok(
    (await readFile(join(memoryDir, 'archive', 'a.md'), 'utf8').catch(() => '')).includes('ARCHIVE-OLDER'),
    'archive/ 那份内容原样',
  )
}

console.log('== Q06d：create → archive → create，回滚后顶层仍然不许留着它 ==')
{
  const { memoryDir, engine } = await world()
  const snap = await engine.snapshot('20261009-211100-run12', 'run')
  const archiveDir = join(memoryDir, 'archive')
  await writeFile(join(memoryDir, 'xray.md'), '---\nname: xray\ntype: project\n---\n\n# v1\n', 'utf8')
  const ar = await archiveMemory(memoryDir, 'xray.md', '这一趟归档 v1')
  ok(ar.ok === true, 'v1 归档成功', JSON.stringify(ar))
  await writeFile(join(memoryDir, 'xray.md'), '---\nname: xray\ntype: project\n---\n\n# v2\n', 'utf8')

  const runDir = join(engine.runsRoot, snap.id)
  await mkdir(runDir, { recursive: true })
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify(
      {
        runId: snap.id,
        changes: [
          { seq: 1, file: 'xray.md', op: 'create', before: { exist: false } },
          { seq: 2, file: 'xray.md', op: 'archive', before: { exist: true } },
          { seq: 3, file: 'xray.md', op: 'create', before: { exist: false } },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )

  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'files' })
  ok(rb.ok === true, '回滚本身成功', JSON.stringify(rb))
  ok(
    !(await exists(join(memoryDir, 'xray.md'))),
    '运行前不存在的文件没有留在顶层（archive/ 同名冲突时旧实现直接放弃 park）',
  )
  ok(
    (await readdir(archiveDir)).some((n) => n.startsWith('xray')),
    '它仍在 archive/ 里（换了退役名也要落进去，不能删）',
    JSON.stringify(await readdir(archiveDir)),
  )
}

console.log('== Q02c：第二份原子写实现（autodream 配置落盘）并发 20 次必须全成功 ==')
{
  const { engine } = await world()
  const N = 20
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => {
      engine.state.lastRunAt = i + 1
      return engine.persist()
    }),
  )
  const rejected = results.filter((r) => r.status === 'rejected')
  ok(
    rejected.length === 0,
    `${N} 次并发配置落盘全部成功（失败 ${rejected.length} 次）`,
    rejected.map((r) => String(r.reason?.code ?? r.reason?.message)).slice(0, 3).join(' / '),
  )
  const parsed = JSON.parse(await readFile(engine.configPath, 'utf8'))
  ok(typeof parsed.lastRunAt === 'number', '落盘的是完整可解析的 JSON（不是半截）')
  const leftovers = (await readdir(engine.stateRoot)).filter((n) => n.endsWith('.tmp'))
  ok(leftovers.length === 0, '临时文件一个不留', JSON.stringify(leftovers))
}

console.log('== Q06e：快照后只改了大小写的文件，整目录回滚不许「写回又移走」==')
{
  const { memoryDir, engine } = await world()
  await writeFile(join(memoryDir, 'casey.md'), '---\nname: casey\ntype: project\n---\n\n# 运行前\n', 'utf8')
  const snap = await engine.snapshot('20261009-211200-run13', 'run')
  await rename(join(memoryDir, 'casey.md'), join(memoryDir, 'Casey.md'))
  const onDisk = (await readdir(memoryDir)).find((n) => n.toLowerCase() === 'casey.md')
  if (onDisk !== 'Casey.md') {
    skip('大小写改名', `本机 rename 没能改出 'Casey.md'（实际 ${onDisk}）`)
  } else {
    const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
    ok(rb.ok === true, '回滚成功', JSON.stringify(rb))
    const hits = (await readdir(memoryDir)).filter((n) => n.toLowerCase() === 'casey.md')
    /**
     * 期望几个文件，取决于**这个目录所在的文件系统**（运行时探测，别猜平台）：
     *   - 不区分大小写（NTFS 默认）：`casey.md` 与 `Casey.md` 是同一个文件 → 恰好 1 个
     *   - 区分大小写（ext4 等）：它们是两个文件。回滚会按快照名 `casey.md` 写回一份，
     *     而运行期改出来的 `Casey.md` 因为快照里「有同名」（按大小写归一判定）不会被 park
     *     —— 于是留下 2 个同内容文件。这是「不敏感归一」在那边**有意选择的代价**：
     *     宁可多留一个可清理的副本，也不冒「把文件判成不存在而移走」的险。
     */
    const caseInsensitive = await fsIsCaseInsensitive(memoryDir)
    ok(
      caseInsensitive ? hits.length === 1 : hits.length >= 1,
      caseInsensitive
        ? '顶层恰好一个（旧实现按大小写敏感的 Set 判定 → 先写回、再 park 进 archive/ → 静默消失）'
        : '顶层至少一个（区分大小写的卷上多留一份副本是取舍，不是丢文件）',
      JSON.stringify(await readdir(memoryDir)),
    )
    ok(
      hits.length > 0 && (await readFile(join(memoryDir, hits[0]), 'utf8')).includes('运行前'),
      '留下的那份内容就是运行前那一版（不论留下几个，内容必须对）',
      JSON.stringify(hits),
    )
    const arch = await readdir(join(memoryDir, 'archive')).catch(() => [])
    ok(
      !arch.some((n) => n.toLowerCase() === 'casey.md'),
      'archive/ 里没有多出它（它本来就该留在顶层）',
      JSON.stringify(arch),
    )
  }
}

console.log('== Q04i：snapshotId 传 "." 必须挡在名字闸门上（不是靠下游碰巧拦住）==')
{
  const { memoryDir, engine } = await world()
  const before = (await readdir(memoryDir)).sort()
  const rb = await engine.rollback({ snapshotId: '.', scope: 'all' })
  // 说明（实测）：旧 `safeName` 放行 `.`，但下游 `resolveSnapshotDir` 当时恰好返回 null，
  // 于是回的是「找不到回滚点：.」——**没有造成损害，只是挡在了错的地方**。这条断言要的是
  // 名字闸门自己挡住：`safeName` 的其它调用点（报告名、运行 id）不该依赖某个下游的巧合。
  ok(rb.ok === false && /不合法/.test(String(rb.error)), 'snapshotId "." 被名字闸门挡下', JSON.stringify(rb))
  ok(
    JSON.stringify((await readdir(memoryDir)).sort()) === JSON.stringify(before),
    '记忆目录原封不动（没有文件被搬进 archive/）',
    JSON.stringify(await readdir(memoryDir)),
  )
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
