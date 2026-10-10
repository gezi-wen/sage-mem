/**
 * v0.9.4 两条修复的反面断言。
 *
 * 编号是**本文件内部的分组标签**：
 *   Q01  链接绕过记忆目录边界。三条真实的绕过路径（**不是推演，是实测能建出来的**）：
 *          - 文件**硬链接**（`nlink === 2`）：`memory/x.md` 与外部文件同 inode → 读它就是读外部内容
 *          - 目录**联接**（junction）：`memory/archive/` 指向外部目录 → 归档把记忆搬出记忆目录
 *          - 文件**符号链接**：本机建不出（无 SeCreateSymbolicLinkPrivilege，实测 EPERM）→ 打印 SKIP
 *   Q09  扫描不看体积上限：512 KB 的上限只写在**写路径**上，读路径谁来都全量读进内存
 *        （库里最大 43 KB，今天零影响；但一条被粘进来的日志就能把整轮注入吃光）。
 *
 * 说明两处测法：
 *   - `scanMemoryFiles` 用的是**模块级 `MEMORY_DIR`**（`lib/memory/config.js` 在 import 时求值），
 *     所以 `SAGE_MEM_DIR` 必须在 import 之前设好 —— 本脚本自己就是那个子进程（`run.mjs` 一脚本一进程）。
 *   - 归档区的「普通目录」与「联接」两种状态要在同一个世界里有先有后：先验普通目录照常能用，
 *     再把它换成联接，验拒绝。否则「一律拒绝」式的假修也能全绿。
 */
import { lstat, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
const skip = (name, why) => console.log(`  SKIP ${name}（${why}）`)

const MAX = 512 * 1024

// ── 世界：scan 层用模块级 MEMORY_DIR，必须在 import lib 之前定 ──
const world = await mkdtemp(join(tmpdir(), 'q094-'))
const memDir = join(world, 'memory')
const outside = join(world, 'outside')
await mkdir(memDir, { recursive: true })
await mkdir(outside, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(world, '.sage-mem')
process.env.DSH_HOME = join(world, 'dsh-home')

const LIB = new URL('../lib/', import.meta.url)
const { scanMemoryFiles, scanStars } = await import(new URL('memory/scan.js', LIB).href)
const { archiveMemory, restoreMemory, archiveDirOf } = await import(new URL('memory/archive.js', LIB).href)

const warns = []
const logger = { warn: (m) => warns.push(String(m)), error: (m) => warns.push(String(m)), info: () => {}, debug: () => {} }
/**
 * 假 ctx：cordis 的 Service 构造会取 `ctx.reflect.*`，未知成员必须给
 * 「可调用且能继续取属性」的桩，否则构造函数当场就炸（与 archive-test 同一套最小面）。
 */
const baseCtx = { on: () => {}, get: () => undefined, logger, effect: () => {} }
let stubCtx
stubCtx = new Proxy(function () {}, {
  get: (t, p) => (typeof p === 'string' && p !== 'then' ? stubCtx : undefined),
  apply: () => undefined,
})
const ctx = new Proxy(baseCtx, { get: (t, p) => (p in t ? t[p] : stubCtx) })
const exists = async (p) => (await stat(p).catch(() => null)) !== null
const namesOf = (rows) => rows.map((r) => r.file ?? r.name).sort()

// 根目录里放：一条正常记忆、一条超大、一条外部硬链接、一条正好踩线的
await writeFile(join(memDir, 'ok.md'), '---\nname: ok\ntype: project\n---\n\n# 正常条目\n\n正文\n', 'utf8')
await writeFile(join(memDir, 'big.md'), `---\nname: big\ntype: project\n---\n\n${'x'.repeat(MAX + 1024)}\n`, 'utf8')
await writeFile(join(memDir, 'exact.md'), `---\nname: exact\ntype: project\n---\n\n${'y'.repeat(MAX - 64)}\n`, 'utf8')
await writeFile(join(outside, 'secret.md'), '---\nname: secret\ntype: project\n---\n\n# 外部机密\n\n不该被读到\n', 'utf8')
let hardLinkOk = true
try {
  await link(join(outside, 'secret.md'), join(memDir, 'hard.md'))
} catch (err) {
  hardLinkOk = false
  skip('硬链接世界', `本机建不出硬链接：${err?.code}`)
}
console.log(`  世界：${memDir}（exact.md 实测 ${(await stat(join(memDir, 'exact.md'))).size} 字节 / 上限 ${MAX}）`)

// ────────────────────────── Q09 ──────────────────────────

console.log('== Q09a：>512 KB 的记忆在**全量读之前**被跳过并记录原因 ==')
{
  const rows = await scanMemoryFiles(ctx)
  const names = namesOf(rows)
  ok(!names.includes('big.md'), `>512KB 的条目没有被读进来（实际 ${JSON.stringify(names)}）`)
  ok(names.includes('ok.md'), '正常条目照常扫到（不是把整条链拒掉）')
  ok(
    rows.every((r) => Buffer.byteLength(r.content ?? '', 'utf8') <= MAX),
    '扫回来的每一条都在上限之内',
  )
  ok(
    warns.some((w) => w.includes('big.md') && /\d/.test(w)),
    '跳过有日志、且带上名字与体积（不许静默失效）',
    JSON.stringify(warns.slice(-3)),
  )
  ok(names.includes('exact.md'), '正好在上限内的条目不被误伤')
}

console.log('== Q09b：星图扫描同一条上限（scanStars / 归档区）==')
{
  const rows = await scanStars(ctx, false)
  const names = namesOf(rows)
  ok(!names.includes('big.md'), `scanStars 也跳过超大条目（实际 ${JSON.stringify(names)}）`)
  ok(names.includes('exact.md'), '上限内的条目照旧出现在星图里')
}

// ────────────────────────── Q01 · 硬链接 ──────────────────────────

if (hardLinkOk) {
  console.log('== Q01a：硬链接**不误伤**（备份工具会造），但必须出声提示 ==')
  const info = await lstat(join(memDir, 'hard.md'))
  ok(info.nlink === 2, `测试前提成立：hard.md 的 nlink=${info.nlink}`)
  const rows = await scanMemoryFiles(ctx)
  // 取舍：硬链接不提供「指向任意路径」的能力（不能跨卷），它带来的是「内容可能被
  // 记忆目录之外改到」。而拦它的代价是 cp -al / rsync --link-dest 这类快照备份会让
  // 用户的记忆整条静默消失 —— 宁可提示、不可丢记忆。
  ok(
    namesOf(rows).includes('hard.md'),
    '硬链接条目照常被扫到（拦它会让备份过的记忆整条消失）',
    JSON.stringify(namesOf(rows)),
  )
  ok(
    (rows.find((r) => r.file === 'hard.md')?.content ?? '').includes('外部机密'),
    '内容按原样读得到（同一 inode，就是那个文件）',
  )
  ok(
    warns.some((w) => w.includes('hard.md') && /硬链接/.test(w)),
    '同时有一条提示说明它可能有别的名字（不静默）',
    JSON.stringify(warns.slice(-4)),
  )
  const stars = await scanStars(ctx, false)
  ok(namesOf(stars).includes('hard.md'), '星图也照常列出')
  // 外部文件必须一个字都没变（读路径不写，这条是防「顺手修一下」的反面）
  ok((await readFile(join(outside, 'secret.md'), 'utf8')).includes('外部机密'), '外部那份没被动过')
}

// ────────────────────────── Q01 · 面板侧的读全文 ──────────────────────────

if (hardLinkOk) {
  console.log('== Q01a2：面板侧读一条记忆全文，同样不因硬链接而拒绝 ==')
  const mod = await import(new URL('index.js', LIB).href)
  const gw = new mod.default(ctx)
  const got = await gw.readFile('hard.md').catch((err) => ({ error: String(err?.message ?? err) }))
  ok(
    typeof got?.content === 'string' && got.content.includes('外部机密'),
    'readFile 照常读得到（不误伤备份过的记忆）',
    JSON.stringify(got).slice(0, 120),
  )
  const good = await gw.readFile('ok.md')
  ok(good && String(good.content).includes('正常条目'), '正常条目照常读得到')
}

// ────────────────────────── 列表 / 审计 / 模型工具三条腿的一致性 ──────────────────────────

console.log('== Q09d：列表与体检对同一个目录必须给出一致的条数 ==')
{
  const mod = await import(new URL('index.js', LIB).href)
  const gw = new mod.default(ctx)
  const list = await gw.listFiles()
  const audit = await gw.audit()
  // 审计原先自己扫目录、不过闸门 → 同一个目录「列表 1 条、体检 3 条」，用户不知道信哪个。
  ok(
    list.length === audit.fileCount,
    `列表 ${list.length} 条 vs 体检 ${audit.fileCount} 条（必须相等）`,
    JSON.stringify({ list: list.map((f) => f.file), auditCount: audit.fileCount }),
  )
  ok(!list.some((f) => f.file === 'big.md'), '超大的条目不进列表')
  ok(list.some((f) => f.file === 'hard.md'), '硬链接条目进列表（不误伤）')
}

console.log('== Q01g：模型工具（autodream）这条腿也要过闸门 ==')
{
  const { createToolRunner } = await import(new URL('autodream-tools.js', LIB).href)
  const runner = createToolRunner({ memoryDir: memDir, sessionsRoot: join(world, 'sessions'), apply: false, withSessions: false })
  // 用一个**目录联接**冒名 `.md`：注入与面板两条腿挡住了，这条腿以前是漏的
  const jdir = join(world, 'outside-head')
  await mkdir(jdir, { recursive: true })
  await writeFile(join(jdir, 'inside.md'), '# 外面的东西\n', 'utf8')
  await symlink(jdir, join(memDir, 'linkdir.md'), 'junction')

  const out = await runner.run('read_memory', { file: 'linkdir.md' })
  ok(/拒绝读取/.test(out), 'read_memory 拒绝读一个指向别处的名字', String(out).slice(0, 140))
  const listing = await runner.run('list_memory', {})
  ok(!String(listing).includes('linkdir.md'), 'list_memory 也不把它列成一条记忆')
  ok(String(listing).includes('ok.md'), '正常条目照常在清单里')
}

console.log('== Q01h：NTFS 交替数据流（`x.md:stream`）不许当文件名 ==')
{
  const mod = await import(new URL('index.js', LIB).href)
  const gw = new mod.default(ctx)
  const w = await gw.writeFile('MEMORY.md:evil.md', '# 写进隐藏流\n').catch((err) => ({ ok: false, thrown: String(err?.message ?? err) }))
  ok(w.ok === false, 'writeFile 拒绝含 `:` 的名字（旧实现在 rename 处抛未捕获 EINVAL）', JSON.stringify(w))
  ok(!/EINVAL/.test(JSON.stringify(w)), '拒绝理由是我们自己的名字校验，不是系统级 EINVAL')
  const r = await gw.readFile('ok.md:secret.md').catch((err) => ({ error: String(err?.message ?? err) }))
  ok(r?.content === undefined, 'readFile 同样拒绝', JSON.stringify(r).slice(0, 140))
}

// ────────────────────────── Q01 · 文件符号链接（本机多半 SKIP）──────────────────────────

console.log('== Q01b：文件符号链接（本机 EPERM 则 SKIP）==')
{
  let made = false
  try {
    await symlink(join(outside, 'secret.md'), join(memDir, 'sym.md'))
    made = true
  } catch (err) {
    skip('文件符号链接', `本机无 SeCreateSymbolicLinkPrivilege：${err?.code}`)
  }
  if (made) {
    const info = await lstat(join(memDir, 'sym.md'))
    ok(info.isSymbolicLink() === true, '测试前提成立：sym.md 是符号链接')
    const rows = await scanMemoryFiles(ctx)
    ok(!namesOf(rows).includes('sym.md'), '符号链接条目没有被扫进来')
    ok(warns.some((w) => w.includes('sym.md')), '拒绝有日志')
  }
}

// ────────────────────────── Q01 · 归档区变成目录联接 ──────────────────────────

console.log('== Q01c：普通状态先验一遍 —— 归档 / 恢复本来就该能用 ==')
{
  const ar = await archiveMemory(memDir, 'ok.md', '证伪用：普通目录该能归档')
  ok(ar.ok === true, '普通 archive/ 目录下归档成功（不是把归档整体拒掉）', JSON.stringify(ar))
  const back = await restoreMemory(memDir, 'ok.md')
  ok(back.ok === true, '普通 archive/ 目录下恢复成功', JSON.stringify(back))
  ok(await exists(join(memDir, 'ok.md')), '文件回到顶层了')
}

console.log('== Q01d：archive/ 被换成指向外部的目录联接 → 归档与恢复都必须拒绝 ==')
{
  // 把 archive/ 换成一个 junction（本机实测可建；symlink 文件/目录默认要特权，EPERM）
  await rm(archiveDirOf(memDir), { recursive: true, force: true })
  const outsideArchive = join(outside, 'archive-target')
  await mkdir(outsideArchive, { recursive: true })
  let junction = false
  try {
    await symlink(outsideArchive, archiveDirOf(memDir), 'junction')
    junction = true
  } catch (err) {
    skip('目录联接', `本机建不出 junction：${err?.code}`)
  }
  if (junction) {
    const info = await lstat(archiveDirOf(memDir))
    ok(info.isSymbolicLink() === true, '测试前提成立：archive/ 现在是一个联接')

    // ⚠️ 外部归档区**先空着**：否则「归档被拒」会由「归档区已有同名」这条旧规则**巧合**满足，
    // 断言就测不到闸门（第一版就是这么假绿的）。
    const ar = await archiveMemory(memDir, 'ok.md', '不该写出去')
    ok(ar.ok === false, '归档区是联接时，归档被拒绝（旧实现会把记忆写出记忆目录）', JSON.stringify(ar))
    ok(!(await exists(join(outsideArchive, 'ok.md'))), '外部目录里没有多出归档副本')
    ok(await exists(join(memDir, 'ok.md')), '顶层那份没被移走（unlink 不该发生）')

    // 外部归档区放一条**顶层没有的**记忆：恢复必须拒绝，且不能把它搬进来
    await writeFile(join(outsideArchive, 'outside.md'), '---\nname: outside\ntype: project\n---\n\n# 外部的\n', 'utf8')
    const back = await restoreMemory(memDir, 'outside.md')
    ok(back.ok === false, '归档区是联接时，恢复被拒绝（旧实现会把外部文件搬进记忆目录）', JSON.stringify(back))
    ok(!(await exists(join(memDir, 'outside.md'))), '外部那份没有被搬进顶层')
    ok(
      (await readFile(join(outsideArchive, 'outside.md'), 'utf8').catch(() => '')).includes('外部的'),
      '外部那份也没被删/改写',
    )

    const stars = await scanStars(ctx, true)
    ok(
      !namesOf(stars).includes('outside.md'),
      '星图不把外部归档区里的条目当成自家归档条目列出来',
      JSON.stringify(namesOf(stars)),
    )
    ok(await exists(join(memDir, 'ok.md')), '顶层那份仍然是自己的内容（没被外部那份顶掉）')
  }
}

// ────────────────────────── 保留名路径的边界 ──────────────────────────

console.log('== Q01f：保留名的**第二个名字**（8.3 短名 / 硬链接）不许绕过保护 ==')
{
  if (!hardLinkOk) {
    skip('保留名的第二个名字', '本机建不出硬链接')
  } else {
    const mod = await import(new URL('index.js', LIB).href)
    const gw = new mod.default(ctx)
    /**
     * 用硬链接模拟 NTFS 的 8.3 短名：**同一个 inode、两个名字文本**。
     * 真实短名（`MEMORY~1.MD`）在能建短名的卷上同样会被 `readdir` 列出来，判据完全一样。
     * 旧实现只比名字文本 → `MEMORY~1.MD` 一路放行，实测能改写 / 删掉索引。
     */
    await writeFile(join(memDir, 'MEMORY.md'), '# 索引\n\n- 一条真记忆\n', 'utf8')
    const alias = 'MEMORY~1.MD'
    await link(join(memDir, 'MEMORY.md'), join(memDir, alias))
    const same = await lstat(join(memDir, alias))
    ok(same.nlink === 2, `测试前提成立：${alias} 与 MEMORY.md 同 inode（nlink=${same.nlink}）`)

    const w = await gw.writeFile(alias, '# 被第二个名字改写\n')
    ok(w.ok === false, 'writeFile 拒绝经第二个名字改写索引（旧实现照写）', JSON.stringify(w))
    ok((await readFile(join(memDir, 'MEMORY.md'), 'utf8')).includes('一条真记忆'), '索引内容没被改掉')

    const d = await gw.deleteFile(alias)
    ok(d.ok === false, 'deleteFile 拒绝经第二个名字删除索引（旧实现照删）', JSON.stringify(d))
    ok(await exists(join(memDir, 'MEMORY.md')), '索引还在')

    const r = await gw.readFile(alias).catch((err) => ({ error: String(err?.message ?? err) }))
    ok(r?.content === undefined, 'readFile 不把索引当普通记忆交出去', JSON.stringify(r).slice(0, 140))
    ok(
      !namesOf(await scanMemoryFiles(ctx)).includes(alias),
      '扫描不把索引的第二个名字当成一条记忆',
      JSON.stringify(namesOf(await scanMemoryFiles(ctx))),
    )
  }
}

console.log('== Q09c：保留名不受 512 KB 闸门约束（它有自己的 4 MB 上限）==')
{
  const mod = await import(new URL('index.js', LIB).href)
  const gw = new mod.default(ctx)
  // 真实场景：流水账天然会长过 512 KB（实测真实记忆目录里就有一条 596 KB 的流水）
  const big = `# 流水\n\n${'x'.repeat(600 * 1024)}\n`
  await writeFile(join(memDir, 'session-log.md'), big, 'utf8')
  const raw = await gw.readRaw('session-log.md').catch((err) => ({ error: String(err?.message ?? err) }))
  ok(
    raw && typeof raw.content === 'string' && raw.content.length > 512 * 1024,
    '600 KB 的流水照常读得到（512 KB 闸门没有越界到保留名路径）',
    JSON.stringify(raw).slice(0, 160),
  )
  ok(!namesOf(await scanMemoryFiles(ctx)).includes('session-log.md'), '它仍然不是「记忆条目」（不参与注入与星图）')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
