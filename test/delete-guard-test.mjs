#!/usr/bin/env node
/**
 * 2.21.0 删除身份守卫。
 *
 * 名字不是身份：用户在卡片上确认的是「这一版」，不是「这个文件名」。
 * 删除必须带 expectedRevision；宿主对**接管到手的实物**重新算内容版本，对不上就还回、不删。
 *
 * 汇总行必须写成 `结果：N passed, M failed`（run.mjs 按这个正则收数）。
 */
import { mkdtemp, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
function ok(cond, label, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  PASS ${label}${extra ? `（${extra}）` : ''}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ''}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'sage-mem-delete-'))
const memoryDir = join(root, 'memory')
await mkdir(memoryDir, { recursive: true })
process.env.SAGE_MEM_DIR = memoryDir
process.env.SAGE_MEM_STATE_DIR = join(root, '.sage-mem')
process.env.DSH_HOME = join(root, 'dsh-home')

const logger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }
const baseCtx = { on: () => {}, get: () => undefined, logger, effect: () => {} }
let stubCtx
stubCtx = new Proxy(function () {}, {
  get: (t, p) => (typeof p === 'string' && p !== 'then' ? stubCtx : undefined),
  apply: () => undefined,
})
const ctx = new Proxy(baseCtx, { get: (t, p) => (p in t ? t[p] : stubCtx) })
const { default: MemoryGateway } = await import(new URL('../lib/index.js', import.meta.url).href)
const gw = new MemoryGateway(ctx)

const name = 'project_delete-guard.md'
const v1 = '---\nname: delete-guard\ntype: project\ndescription: 第一版\n---\n\n# 第一版\n'
const v2 = '---\nname: delete-guard\ntype: project\ndescription: 第二版\n---\n\n# 第二版\n'
const exists = async (p) => (await readFile(p).catch(() => null)) !== null
const revisionOfListed = async (file) => {
  const rows = await gw.listFiles()
  return rows.find((r) => r.file === file)?.revision ?? ''
}

console.log('\n── 1. 列表带内容身份，且与读快照同一算法 ──')
{
  await writeFile(join(memoryDir, name), v1, 'utf8')
  const listed = await revisionOfListed(name)
  const read = await gw.readFile(name)
  ok(/^[0-9a-f]{64}$/.test(listed), 'listFiles 返回 64 位 sha256 revision', listed)
  ok(listed === read.revision, '列表 revision 与 readFile revision 相同')
}

console.log('\n── 2. 确认之后文件被改写：拒绝删除，新版本原样保留 ──')
{
  const oldRevision = await revisionOfListed(name)
  await writeFile(join(memoryDir, name), v2, 'utf8')
  const r = await gw.deleteFile(name, { expectedRevision: oldRevision })
  ok(r.ok === false && r.code === 'stale_revision', '旧 revision 被拒绝', JSON.stringify(r))
  ok((await readFile(join(memoryDir, name), 'utf8')) === v2, '盘上是新版本，一个字没少')
  ok(!(await readdir(memoryDir)).some((n) => n.includes('.deleting-')), '没有留下 .deleting- 私有残留')
}

console.log('\n── 3. 当前版本确认后才真的删除 ──')
{
  const current = await revisionOfListed(name)
  const r = await gw.deleteFile(name, { expectedRevision: current })
  ok(r.ok === true, '同版本删除成功', JSON.stringify(r))
  ok(!(await exists(join(memoryDir, name))), '文件已经移除')
  ok(!(await readdir(memoryDir)).some((n) => n.includes('.deleting-')), '成功后也没有私有残留')
}

console.log('\n── 4. 内容没变、只改了 mtime：身份不变，仍可删 ──')
{
  const n = 'project_mtime.md'
  await writeFile(join(memoryDir, n), v1, 'utf8')
  const rev = await revisionOfListed(n)
  const old = new Date(Date.now() - 60_000)
  await utimes(join(memoryDir, n), old, old)
  const r = await gw.deleteFile(n, { expectedRevision: rev })
  ok(r.ok === true, 'mtime 变化不影响内容身份')
}

console.log('\n── 5. 文件已不存在：结构化 missing，不抛 ──')
{
  const r = await gw.deleteFile('project_gone.md', { expectedRevision: '0'.repeat(64) })
  ok(r.ok === false && r.code === 'missing', '返回 missing', JSON.stringify(r))
}

console.log('\n── 6. 旧协议兼容：没有 expectedRevision 仍能删，但不是受守卫路径 ──')
{
  const n = 'project_legacy-delete.md'
  await writeFile(join(memoryDir, n), v1, 'utf8')
  const r = await gw.deleteFile(n)
  ok(r.ok === true && !(await exists(join(memoryDir, n))), '旧调用不传 opts 仍可删除')
}

console.log('\n── 7. 崩溃残留：.deleting- 私有名必须被体检报出来 ──')
{
  const leftover = 'project_somewhere.md.deleting-deadbeef'
  await writeFile(join(memoryDir, leftover), v1, 'utf8')
  const { auditMemoryDir } = await import(new URL('../lib/autodream.js', import.meta.url).href)
  const audit = await auditMemoryDir(memoryDir)
  ok(Array.isArray(audit.strays) && audit.strays.length >= 1, '体检把 .deleting- 残留列为 strays', JSON.stringify(audit.strays))
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
