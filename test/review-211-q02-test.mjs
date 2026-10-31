/**
 * 2.1.2 / 外部审查 Q02：面板保存没有 revision，静默覆盖较新的正文。
 *
 * 这组断言盯的是**写协议**本身（不是某个界面按钮）：
 *   ① 读快照（活动 / 归档 / 保留名）必须带回 `revision`（正文字节 sha256）；
 *   ② 写带 `expectedRevision` 时，盘上版本变了必须返回固定冲突码 `stale_revision`，
 *      **当前内容逐字节不变**（拒绝不是「写了一半」）；
 *   ③ 新建走 createIfAbsent：撞名返回 `already_exists`，**绝不**覆盖已有正文；
 *   ④ additive 契约的反向对照：不传 `expectedRevision` 的旧调用方照旧成功（打一条 warn），
 *      没有并发时正常保存照常成功。
 *
 * 修前红证据（2.1.1）：
 *   readFile 没有 revision；{result:{ok:true,file:"a.md"}} 且 humanB 内容被覆盖
 *   （humanBPreserved=false，见审查报告 Q02 的复现）。所以在 base 上本文件必然有成片 FAIL。
 *
 * 全部只碰临时目录：SAGE_MEM_DIR / SAGE_MEM_STATE_DIR 必须在 import lib 之前设好。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = join(tmpdir(), `sage-mem-q02-test-${process.pid}`)
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
mkdirSync(memDir, { recursive: true })
mkdirSync(join(memDir, 'archive'), { recursive: true })
mkdirSync(stateDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const LIB = new URL('../lib/', import.meta.url)
const { MemoryGateway } = await import(new URL('index.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

/** 假 ctx（cordis Service 构造要 ctx.reflect.*，未知成员给可调用的桩）；warn 落进数组。 */
const warns = []
function makeCtx() {
  const base = {
    on: () => {}, get: () => undefined, effect: () => {},
    logger: { warn: (m) => warns.push(String(m)), error: () => {}, info: () => {}, debug: () => {} },
  }
  let stub
  stub = new Proxy(function () {}, { get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined), apply: () => undefined })
  return new Proxy(base, { get(t, p) { return p in t ? t[p] : stub } })
}
const gw = new MemoryGateway(makeCtx())

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const bytes = (p) => readFileSync(p)
const body = (s) => `---\nname: q02\ntype: project\ndescription: Q02 夹具\n---\n\n${s}\n`
const reset = () => {
  for (const f of ['a.md', 'new.md', 'MEMORY.md', 'session-log.md', 'archive/a.md']) {
    const p = join(memDir, f)
    if (existsSync(p)) unlinkSync(p)
  }
}

// ── 1. 读快照一定带 revision（三组读路径）──────────────────────────
group('1. 读快照带 revision：活动 / 归档 / 保留名')
reset()
writeFileSync(join(memDir, 'a.md'), body('A0'), 'utf8')
writeFileSync(join(memDir, 'archive', 'a.md'), body('ARCH0'), 'utf8')
writeFileSync(join(memDir, 'MEMORY.md'), '# 索引\n\n- [a](a.md)\n', 'utf8')
{
  const snap = await gw.readFile('a.md')
  ok(snap && snap.content && snap.content.includes('A0'), 'readFile 正文照旧')
  ok(snap && snap.revision === sha256(join(memDir, 'a.md')), 'readFile 带回正文字节的 sha256', `got=${snap && snap.revision}`)
  const arch = await gw.readArchived('a.md')
  ok(arch && arch.revision === sha256(join(memDir, 'archive', 'a.md')), 'readArchived 带回 revision', `got=${arch && arch.revision}`)
  const raw = await gw.readRaw('MEMORY.md')
  ok(raw && raw.revision === sha256(join(memDir, 'MEMORY.md')), 'readRaw 带回 revision', `got=${raw && raw.revision}`)
}

// ── 2. 活动记忆：旧读后新写被拒，内容逐字节不变 ─────────────────────
group('2. 活动记忆 stale save（Q02 的反例本体）')
reset()
writeFileSync(join(memDir, 'a.md'), body('A old'), 'utf8')
{
  const snap = await gw.readFile('a.md')
  // 用户在另一个编辑器 / 另一标签页 / autodream 里存了 B
  writeFileSync(join(memDir, 'a.md'), body('B human addition'), 'utf8')
  const bBytes = bytes(join(memDir, 'a.md'))
  const r = await gw.writeFile('a.md', body('C based on A'), { expectedRevision: snap.revision })
  ok(r && r.ok === false, '基于旧快照的保存被拒绝（不是 ok:true）', JSON.stringify(r))
  ok(r && r.code === 'stale_revision', '冲突码是固定常量 stale_revision（面板只认这个码）', JSON.stringify(r))
  ok(bytes(join(memDir, 'a.md')).equals(bBytes), '拒绝时当前内容逐字节不变（B 没有被覆盖）')
}
{
  // 反向对照：没有并发时，带对的 revision 正常保存，并回新的 revision
  const snap = await gw.readFile('a.md')
  const r = await gw.writeFile('a.md', body('C based on B'), { expectedRevision: snap.revision })
  ok(r && r.ok === true, '无并发：带正确 revision 的保存照常成功', JSON.stringify(r))
  ok(r && r.revision === sha256(join(memDir, 'a.md')), '成功回执带落盘后的新 revision', `got=${r && r.revision}`)
  ok(readFileSync(join(memDir, 'a.md'), 'utf8').includes('C based on B'), '无并发：新正文确实落盘')
}
{
  // 读后被删除：同样是「版本已变」，不能悄悄当新建写回去
  const snap = await gw.readFile('a.md')
  unlinkSync(join(memDir, 'a.md'))
  const r = await gw.writeFile('a.md', body('resurrect'), { expectedRevision: snap.revision })
  ok(r && r.ok === false && r.code === 'stale_revision', '读后被删除 → 同样报 stale_revision（不复活、不当新建）', JSON.stringify(r))
  ok(!existsSync(join(memDir, 'a.md')), '读后被删除 → 拒绝时没有把文件重新建出来')
}

// ── 3. 旧调用方（不传 opts）仍然工作，但要留 warn ───────────────────
group('3. additive 契约：旧调用方（不传 expectedRevision）行为不变 + warn')
reset()
writeFileSync(join(memDir, 'a.md'), body('legacy A'), 'utf8')
{
  const before = warns.length
  const r = await gw.writeFile('a.md', body('legacy overwrite'))
  ok(r && r.ok === true, '不传 opts 的旧调用方照旧成功（additive：不把旧调用方打死）', JSON.stringify(r))
  ok(readFileSync(join(memDir, 'a.md'), 'utf8').includes('legacy overwrite'), '旧调用方确实写入了（兼容语义原样）')
  ok(warns.length > before && /expectedRevision/.test(warns[warns.length - 1]), '旧调用方留一条 warn（静默无守卫覆盖不再允许）', warns.slice(before).join(' | '))
}

// ── 4. 归档件的 stale save ───────────────────────────────────────
group('4. 归档件同一套守卫')
reset()
writeFileSync(join(memDir, 'archive', 'a.md'), body('ARCH old'), 'utf8')
{
  const snap = await gw.readArchived('a.md')
  writeFileSync(join(memDir, 'archive', 'a.md'), body('ARCH newer'), 'utf8')
  const newerBytes = bytes(join(memDir, 'archive', 'a.md'))
  const r = await gw.writeArchived('a.md', body('ARCH stale save'), { expectedRevision: snap.revision })
  ok(r && r.ok === false && r.code === 'stale_revision', '归档件旧读后新写 → stale_revision', JSON.stringify(r))
  ok(bytes(join(memDir, 'archive', 'a.md')).equals(newerBytes), '归档件拒绝时逐字节不变')
  // 反向对照：拿新 revision 重新保存成功
  const fresh = await gw.readArchived('a.md')
  const r2 = await gw.writeArchived('a.md', body('ARCH based on newer'), { expectedRevision: fresh.revision })
  ok(r2 && r2.ok === true && r2.revision === sha256(join(memDir, 'archive', 'a.md')), '归档件重读后带新 revision 保存成功并回新 revision', JSON.stringify(r2))
}

// ── 5. 保留名（MEMORY.md）的 stale save / createIfAbsent ──────────
group('5. 保留名：守卫 + 建立索引骨架的 createIfAbsent')
reset()
writeFileSync(join(memDir, 'MEMORY.md'), '# 索引\n\n- [a](a.md)\n', 'utf8')
{
  const snap = await gw.readRaw('MEMORY.md')
  writeFileSync(join(memDir, 'MEMORY.md'), '# 索引（别处改过）\n', 'utf8')
  const newer = bytes(join(memDir, 'MEMORY.md'))
  const r = await gw.writeRaw('MEMORY.md', '# 索引（旧面板提交）\n', { expectedRevision: snap.revision })
  ok(r && r.ok === false && r.code === 'stale_revision', 'MEMORY.md 旧读后新写 → stale_revision', JSON.stringify(r))
  ok(bytes(join(memDir, 'MEMORY.md')).equals(newer), 'MEMORY.md 拒绝时逐字节不变（索引没有被顶掉）')
  // createIfAbsent：已有索引时新建语义必须明确报已存在
  const created = await gw.writeRaw('MEMORY.md', '# 新骨架\n', { create: true })
  ok(created && created.ok === false && created.code === 'already_exists', '已有索引 + create:true → already_exists（不走覆盖入口）', JSON.stringify(created))
  ok(bytes(join(memDir, 'MEMORY.md')).equals(newer), 'already_exists 时索引逐字节不变')
}
{
  // 反向对照：文件不存在时 createIfAbsent 成功；第二次撞名明确失败
  reset()
  const first = await gw.writeRaw('session-log.md', '# 流水\n', { create: true })
  ok(first && first.ok === true && first.created === true, '缺文件时 createIfAbsent 成功建立（不是覆盖）', JSON.stringify(first))
  ok(readFileSync(join(memDir, 'session-log.md'), 'utf8') === '# 流水\n', 'createIfAbsent 写入的正是交回的内容')
  const again = await gw.writeRaw('session-log.md', '# 另一份\n', { create: true })
  ok(again && again.ok === false && again.code === 'already_exists', '第二次 createIfAbsent → already_exists', JSON.stringify(again))
  ok(readFileSync(join(memDir, 'session-log.md'), 'utf8') === '# 流水\n', '第二次 createIfAbsent 没有覆盖第一次的内容')
}

// ── 6. 新建同名（活动记忆）绝不复用覆盖入口 ───────────────────────
group('6. 新建同名：writeFile({create:true}) 明确报已存在')
reset()
{
  const first = await gw.writeFile('new.md', body('NEW first'), { create: true })
  ok(first && first.ok === true, '新建不存在的记忆成功', JSON.stringify(first))
  const before = bytes(join(memDir, 'new.md'))
  const again = await gw.writeFile('new.md', body('NEW second (should not overwrite)'), { create: true })
  ok(again && again.ok === false && again.code === 'already_exists', '新建撞上同名文件 → already_exists', JSON.stringify(again))
  ok(bytes(join(memDir, 'new.md')).equals(before), '新建撞名时已有正文逐字节不变')
}

// ── 7. 前端分片确实接上了这条协议（静态守卫，防止「宿主改了、面板没改」）──
group('7. 面板分片把 revision 带回去（静态守卫）')
{
  const panel = readFileSync(new URL('../client/70-memory-panel.js', import.meta.url), 'utf8')
  ok(/setFormRevision\(typeof data\.revision === "string"/.test(panel), '活动记忆表单：读时记住 revision')
  ok(/expectedRevision: formRevision/.test(panel), '活动记忆表单：保存时带回 expectedRevision')
  ok(/const writeOpts = editingFile\s*\?/.test(panel) && /: \{ create: true \}/.test(panel), '活动记忆表单：新建走 createIfAbsent，不复用覆盖入口')
  ok(/setArchRevision\(d && typeof d\.revision === "string"/.test(panel), '归档编辑器：读时记住 revision')
  ok(/expectedRevision: archRevision/.test(panel), '归档编辑器：保存时带回 expectedRevision')
  ok(/setRawRevision\(d && typeof d\.revision === "string"/.test(panel), '保留名编辑器：读时记住 revision')
  ok(/expectedRevision: rawRevision/.test(panel) && /rawIsNew[\s\S]{0,80}\{ create: true \}/.test(panel), '保留名编辑器：新建 create / 编辑 expectedRevision')
  // 冲突时保留草稿：两处都只在 r.ok === false 时 setError，**没有**自动重试覆盖的分支
  ok(!/stale_revision[\s\S]{0,200}writeFile\(/.test(panel), '面板没有「收到 stale_revision 就自动重试写」的分支（绝不自动覆盖）')
  const desc = readFileSync(new URL('../client/30-descriptors.js', import.meta.url), 'utf8')
  ok((desc.match(/#WriteOpts/g) || []).length === 3, '客户端描述符给三个写方法都声明了 WriteOpts 入参', `count=${(desc.match(/#WriteOpts/g) || []).length}`)
  const host = readFileSync(new URL('../lib/typert.host.js', import.meta.url), 'utf8')
  ok((host.match(/#WriteOpts/g) || []).length === 3, '宿主 manifest 同样声明三处 WriteOpts（strict 入参不声明 = revision 被整个拒掉）', `count=${(host.match(/#WriteOpts/g) || []).length}`)
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
