/**
 * 2.1.6 / Q07 回归：归档删除用分钟时间戳当版本，旧确认可删新内容。
 *
 * 审查原文（2026-10-31 外部审查 Q07，P1）：
 *   用户看到归档 A 后打开删除确认；A 被改成 B 但 `archived_at` 不变（panel 的
 *   `writeArchived` 刻意保留留痕，外部编辑器也会保留），随后提交旧确认 ——
 *   旧实现只比对 `archived_at`（`YYYY-MM-DD HH:mm`，分钟精度），于是 B 被删。
 *   同一分钟内「恢复 → 再归档」也会复用同一个时间戳。
 *
 * 修法验收（断言的是**最后留下了哪些字节**，不是返回值好不好看）：
 *   ① 同时间戳不同正文必须拒绝；
 *   ② 同分钟重新归档必须拒绝旧确认；
 *   ③ 校验之后被替换也要保住新版本（接管实物后再比一次身份）；
 *   ④ 只有当前未变化的版本才删除；
 *   ⑤ 没带内容身份的老确认一律拒绝（退回按名字删就等于没修）；
 *   ⑥ 老数据（没有 archived_rev）仍可按内容身份删除；
 *   ⑦ 面板编辑正文（writeArchived）之后旧确认立刻失效。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-q07-'))
const memDir = join(sandbox, 'memory')
mkdirSync(join(memDir, 'archive'), { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const LIB = new URL('../lib/', import.meta.url)
const mod = await import(new URL('index.js', LIB).href)
const { archiveMemory, restoreMemory } = await import(new URL('memory/archive.js', LIB).href)
const { TYPERT } = await import(new URL('typert.host.js', LIB).href)
// 只借原型：这些方法不依赖构造函数里的东西（ctx 只用于日志）。
const gw = Object.create(mod.default.prototype)

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
const group = (t) => console.log(`== ${t} ==`)

const ACTIVE = '---\nname: a\ntype: project\ndescription: 审查 Q07\n---\n\n# a\n\nA old body\n'
const ARCHIVE_PATH = join(memDir, 'archive', 'a.md')
const ACTIVE_PATH = join(memDir, 'a.md')
const TEMPLATE_AT = '2026-10-23 12:34'

/** 重置沙箱：记忆目录清空、归档区重建。 */
function reset() {
  rmSync(memDir, { recursive: true, force: true })
  mkdirSync(join(memDir, 'archive'), { recursive: true })
}
/** 归档一条活动记忆（显式 at 让「同一分钟」可确定性复现）。 */
async function seedArchived(at = TEMPLATE_AT) {
  writeFileSync(ACTIVE_PATH, ACTIVE, 'utf8')
  const res = await archiveMemory(memDir, 'a.md', '审查样本', at)
  if (!res.ok) throw new Error(`种子归档失败：${JSON.stringify(res)}`)
}
const listed = async () => (await gw.listArchived()).files.find((f) => f.file === 'a.md')
const archiveText = () => {
  try {
    return readFileSync(ARCHIVE_PATH, 'utf8')
  } catch {
    // 修复前的代码在这里会把文件删掉 —— 读不到就回 null，让断言判 FAIL 而不是把套件炸掉。
    return null
  }
}

// ─────────────────── ① 同时间戳、不同正文 ───────────────────
group('1. 同 archived_at、正文换成 B：旧确认必须拒绝，B 逐字节保住')
{
  reset()
  await seedArchived()
  const item = await listed()
  ok(!!item, '（前提）归档件出现在 listArchived 里')
  ok(typeof item?.revision === 'string' && /@sha256:[0-9a-f]{12}$/.test(item.revision),
    'listArchived 给出内容身份 revision（归档代次@正文 hash）', JSON.stringify(item?.revision))
  const stamp = item.archivedAt
  const rev = item.revision
  // 模拟「同 archived_at 的另一版」：正文换成 B，时间戳一个字不改（外部编辑器 / 复原工具）。
  const B = `---\narchived_at: ${stamp}\narchived_reason: 外部改写\n---\n\nB newly edited body\n`
  writeFileSync(ARCHIVE_PATH, B, 'utf8')

  const r = await gw.deleteArchived('a.md', stamp, rev)
  ok(r.ok === false, '同时间戳不同正文 → 拒绝删除', JSON.stringify(r))
  ok(/另一版|revision|代次/.test(String(r.error)), '错误说明是「被换成了另一版」', String(r.error).slice(0, 160))
  ok(archiveText() === B, 'B 仍逐字节躺在 archive/a.md（旧实现这里删的就是它）')
  ok(existsSync(ACTIVE_PATH) === false, '没有误碰活动区（本来就没有 a.md）')
  // 反向对照：同一份文件的**当前** revision 仍然删得掉 —— 拒绝的是过期确认，不是整个功能。
  const nowItem = await listed()
  ok(!!nowItem && nowItem.revision !== rev, '改了正文之后列表给出的 revision 变了',
    JSON.stringify(nowItem?.revision))
  const r2 = await gw.deleteArchived('a.md', nowItem?.archivedAt ?? '', nowItem?.revision ?? '')
  ok(r2.ok === true, '按**当前**那份的身份可以删（功能没有变成不可用）', JSON.stringify(r2))
  ok(!existsSync(ARCHIVE_PATH), 'archive/ 里那份确实删掉了')
}

// ─────────────────── ② 同一分钟内重新归档 ───────────────────
group('2. 同一分钟「恢复 → 再归档」：旧确认不能删新归档件')
{
  reset()
  await seedArchived()
  const first = await listed()
  const restored = await restoreMemory(memDir, 'a.md')
  ok(restored.ok === true, '（前提）先恢复回顶层', JSON.stringify(restored))
  // 同一分钟再归档：时间戳一模一样，只有代次不同。
  const again = await archiveMemory(memDir, 'a.md', '同分钟再归档', TEMPLATE_AT)
  ok(again.ok === true, '（前提）再次归档成功', JSON.stringify(again))
  const second = await listed()
  ok(first.archivedAt === second.archivedAt, '（前提）两份的 archived_at 完全相同（这就是原 bug 的触发条件）',
    `${first.archivedAt} vs ${second.archivedAt}`)
  ok(second.revision !== first.revision, '同分钟重新归档 → 内容身份不同（代次不可复用）')

  const r = await gw.deleteArchived('a.md', first.archivedAt, first.revision)
  ok(r.ok === false, '旧确认 → 拒绝', JSON.stringify(r))
  ok(existsSync(ARCHIVE_PATH), '新归档件一个字节没动')
  const bytes = archiveText()
  const r2 = await gw.deleteArchived('a.md', second.archivedAt, second.revision)
  ok(r2.ok === true, '当前那份的确认才删得掉', JSON.stringify(r2))
  ok(!existsSync(ARCHIVE_PATH), '删掉的正是刚才确认的那一份（不是更早那份）')
  ok(String(bytes).includes('同分钟再归档'), '（证据）被删掉的是第二次归档的内容', String(bytes).slice(0, 120))
}

// ─────────────────── ③ 校验之后、接管之前被替换 ───────────────────
group('3. 校验通过之后被换成 B（check-then-delete 窗口）：新版本必须保住')
{
  reset()
  await seedArchived()
  const item = await listed()
  const B = `---\narchived_at: ${item.archivedAt}\narchived_reason: 窗口内改写\n---\n\nB inside the window\n`
  let injected = false
  const origRename = fsPromises.rename
  fsPromises.rename = async (from, to, ...a) => {
    // 旧实现：比对之后 rename(full → .deleting-)。就在这一刻把盘上换成 B。
    if (!injected && from === ARCHIVE_PATH) {
      injected = true
      writeFileSync(ARCHIVE_PATH, B, 'utf8')
    }
    return origRename(from, to, ...a)
  }
  syncBuiltinESMExports()
  let r
  try {
    r = await gw.deleteArchived('a.md', item.archivedAt, item.revision)
  } finally {
    fsPromises.rename = origRename
    syncBuiltinESMExports()
  }
  ok(injected === true, '（前提）注入生效：比对之后、接管之前盘上被换成 B')
  ok(r?.ok === false, '拒绝删除（不能把没核对过的 B 当 A 删掉）', JSON.stringify(r))
  ok(archiveText() === B, 'B 留在 archive/a.md（旧实现 rename 走的就是它，随后 rm）')
  const residue = (await readdir(join(memDir, 'archive'))).filter((f) => /\.deleting-/.test(f))
  ok(residue.length === 0, '没有留下 .deleting- 私有残留', JSON.stringify(residue))
}

// ─────────────────── ④ 只有当前未变化的版本才删除 ───────────────────
group('4. 正常路径：身份对得上才删，且只删归档区那一份')
{
  reset()
  await seedArchived()
  const item = await listed()
  const activeBefore = '---\nname: a\ntype: project\ndescription: 活记忆\n---\n\nLIVE same name\n'
  writeFileSync(ACTIVE_PATH, activeBefore, 'utf8')
  const r = await gw.deleteArchived('a.md', item.archivedAt, item.revision)
  ok(r.ok === true && r.file === 'a.md', '身份对得上 → 删除成功', JSON.stringify(r))
  ok(!existsSync(ARCHIVE_PATH), 'archive/ 里那份没了')
  ok(readFileSync(ACTIVE_PATH, 'utf8') === activeBefore, '根目录同名活记忆一个字节没动')
  ok(!(await gw.listArchived()).files.some((f) => f.file === 'a.md'), 'listArchived 不再列它')
  const again = await gw.deleteArchived('a.md', item.archivedAt, item.revision)
  ok(again.ok === false, '重复删除 → 明确拒绝（不是静默成功）', JSON.stringify(again))
}

// ─────────────────── ⑤ 没带内容身份的旧确认 ───────────────────
group('5. 老界面只交回 archived_at：一律拒绝（不能退回按名字删）')
{
  reset()
  await seedArchived()
  const item = await listed()
  const r = await gw.deleteArchived('a.md', item.archivedAt)
  ok(r.ok === false, '旧确认（无 revision）→ 拒绝', JSON.stringify(r))
  ok(/revision|代次/.test(String(r.error)), '错误说明缺的是内容代次', String(r.error).slice(0, 160))
  ok(existsSync(ARCHIVE_PATH), '文件仍在归档区、一个字节没动')
}

// ─────────────────── ⑥ 老数据（没有 archived_rev） ───────────────────
group('6. 老数据没有 archived_rev：仍钉在内容上、仍可删')
{
  reset()
  const old = '---\narchived_at: 2026-01-01 00:00\narchived_reason: 老归档件\n---\n\nOld body\n'
  writeFileSync(ARCHIVE_PATH, old, 'utf8')
  const item = (await gw.listArchived()).files.find((f) => f.file === 'a.md')
  ok(!!item && typeof item.revision === 'string' && item.revision.startsWith('@sha256:'),
    '没有代次时 revision 仍以 @sha256 开头（按正文算）', JSON.stringify(item?.revision))
  const bad = await gw.deleteArchived('a.md', item?.archivedAt ?? '', String(item?.revision ?? '') + 'x')
  ok(bad.ok === false && archiveText() === old, '错的 revision → 拒绝且原文不动', JSON.stringify(bad))
  const good = await gw.deleteArchived('a.md', item?.archivedAt ?? '', item?.revision ?? '')
  ok(good.ok === true && !existsSync(ARCHIVE_PATH), '对的 revision → 删除成功', JSON.stringify(good))
}

// ─────────────────── ⑦ 面板编辑归档正文之后 ───────────────────
group('7. 面板 writeArchived 改正文（留痕保留）：旧确认立刻失效')
{
  reset()
  await seedArchived()
  const before = await listed()
  // 面板编辑器的真实形状：交回一份「重建过 frontmatter、没有留痕行」的正文。
  const edited = '---\nname: a\ntype: project\ndescription: 面板改过\n---\n\n# a\n\nB from panel\n'
  const w = await gw.writeArchived('a.md', edited)
  ok(w.ok === true, '（前提）归档正文改成功', JSON.stringify(w))
  const after = await listed()
  ok(after.archivedAt === before.archivedAt, '（前提）archived_at 没变（writeArchived 刻意保留留痕）')
  ok(after.revision !== before.revision, '但内容身份变了（正文 revision 变了）')

  const stale = await gw.deleteArchived('a.md', before.archivedAt, before.revision)
  ok(stale.ok === false, '旧确认 → 拒绝（原 bug：这里会删掉面板刚写的那一版）', JSON.stringify(stale))
  ok(String(archiveText()).includes('B from panel'), '面板写的那版仍在')
  const fresh = await gw.deleteArchived('a.md', after.archivedAt, after.revision)
  ok(fresh.ok === true, '新确认（当前身份）→ 删得掉', JSON.stringify(fresh))
}

// ─────────────────── ⑧ wire 契约 ───────────────────
group('8. wire 契约：listArchived 带 revision、deleteArchived 收三个参数')
{
  reset()
  await seedArchived()
  const listInv = TYPERT.invocations.find((i) => i.id === 'sage-mem#memory/listArchived')
  const shaped = listInv.result.schema.safeParse(await gw.listArchived())
  ok(shaped.success === true, 'listArchived 的真实输出过得了 strict schema（revision 没被剥掉）',
    JSON.stringify((shaped.error?.issues ?? []).slice(0, 3)))
  ok(shaped.success && typeof shaped.data.files[0]?.revision === 'string' && shaped.data.files[0].revision.length > 0,
    'schema 里真的带着 revision')

  const delInv = TYPERT.invocations.find((i) => i.id === 'sage-mem#memory/deleteArchived')
  ok(delInv.parameters.length === 3 && delInv.parameters[2]?.name === 'revision',
    'deleteArchived 的入参是 (name, archivedAt, revision)', JSON.stringify(delInv.parameters.map((p) => p.name)))
  const revSchema = delInv.parameters[2]?.codec?.schema ?? { safeParse: () => ({ success: false }) }
  ok(revSchema.safeParse('abcd1234@sha256:0123456789ab').success === true, 'revision 收字符串')
  ok(revSchema.safeParse('').success === false, 'revision 拒绝空串（必须有内容身份）')
  ok(revSchema.safeParse(123).success === false, 'revision 拒绝非字符串')
  const archiveInv = TYPERT.invocations.find((i) => i.id === 'sage-mem#memory/archive')
  ok(archiveInv.result.schema.safeParse({ ok: true, file: 'a.md', archivedReason: 'x', unindexed: false }).success === true,
    'archive 的既有响应形状没有被这次改动碰坏')
}

// 收尾（沙箱用完就删；失败时也删，不留给下一次）
rmSync(sandbox, { recursive: true, force: true })

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)


