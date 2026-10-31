#!/usr/bin/env node
/**
 * review-211-q14-test.mjs — 扫描失败不能被说成「完整搜索且没有命中」（Q14，2.1.17）
 *
 * 外部审查（2026-10-31）的复现：把记忆路径换成一个普通文件，`readdir` 返回 ENOTDIR；
 * `scanMemoryDir` 捕获后返回 `[]`，`search_memory` 照样回
 * `ok:true, searched:0, skipped:0, complete:true, hits:[]` —— 一次「读不了」被渲染成
 * 「记忆里没有」，模型据此会判断「没有相关记忆」，而事实是检索根本没跑成。
 *
 * 契约（本套件逐条钉住）：
 *   - 空目录 = **成功零命中**（ok:true / complete:true / hits:[]）；
 *   - 目录不存在 = 合法空库（complete:true + missingDir:true），要说「还没有记忆」；
 *   - ENOTDIR / EACCES = **目录级失败**：scan 返回 `{complete:false, errors:[{code,message}]}`，
 *     工具回 `ok:false` + 明确 error，渲染文案里**不许**出现「没有命中」；
 *   - 单条目被策略跳过（超限 / 链接 / 读失败）与目录级失败**分开统计**：`skippedFiles`
 *     计数、complete 仍为 true；
 *   - 一次失败**不落缓存**：目录恢复后下一次扫描必须看到真实文件。
 */
import { syncBuiltinESMExports } from 'node:module'
import fsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = await mkdtemp(join(tmpdir(), 'sage-mem-q14-'))
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
await mkdir(memDir, { recursive: true })
await mkdir(stateDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')
await mkdir(process.env.DSH_HOME, { recursive: true })

const LIB = new URL('../lib/', import.meta.url)
const scan = await import(new URL('memory/scan.js', LIB).href)
const { createMemoryTools } = await import(new URL('tools/memory-tools.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const body = (s) => `---\nname: audit\ntype: project\ndescription: quartz nebula\n---\n${s}\n`
const ctx = { logger: { warn() {}, error() {}, info() {}, debug() {} }, get: () => undefined }
const tools = createMemoryTools(ctx)
const search = (args = { query: 'quartz nebula' }) => tools.searchMemory.execute(args)
const render = (value) => tools.searchMemory.output.render({}, value)[0].text

async function emptyDir() {
  await rm(memDir, { recursive: true, force: true })
  await mkdir(memDir, { recursive: true })
}

group('0. 前置：Detailed 入口存在，旧签名仍是数组（不把调用点一次性改爆）')
{
  await emptyDir()
  ok(typeof scan.scanMemoryFilesDetailed === 'function', 'scanMemoryFilesDetailed 已导出')
  ok(typeof scan.scanMemoryDirDetailed === 'function', 'scanMemoryDirDetailed 已导出')
  ok(Array.isArray(await scan.scanMemoryFiles(ctx, '')), '旧签名 scanMemoryFiles 仍返回数组')
  const d = await scan.scanMemoryDirDetailed(ctx, '', memDir)
  ok(Array.isArray(d.files), 'Detailed 入口返回 files 数组')
  ok(d.complete === true && d.missing === false, '空目录：complete=true、missing=false', JSON.stringify(d))
}

group('1. 空目录 = 成功零命中（反向对照，不能把成功说成失败）')
{
  await emptyDir()
  const value = await search()
  ok(value.ok === true, '空目录检索返回 ok:true（这是成功，不是故障）', JSON.stringify(value))
  ok(Array.isArray(value.hits) && value.hits.length === 0, 'hits 为空')
  ok(value.coverage?.complete === true && value.coverage?.searched === 0, 'coverage.complete=true、searched=0', JSON.stringify(value.coverage))
  ok(render(value).includes('没有命中'), '渲染成「没有命中」是允许的 —— 因为这次确实完整地扫过了', render(value))
}

group('2. 目录不存在 = 合法空库：说「还没有记忆」，不是「检索失败」')
{
  const aside = join(sandbox, 'memory-aside')
  await rm(aside, { recursive: true, force: true })
  await rename(memDir, aside)
  try {
    const d = await scan.scanMemoryDirDetailed(ctx, '', memDir)
    ok(d.complete === true && d.missing === true, 'scan：complete=true、missing=true（目录不存在不是目录级故障）', JSON.stringify(d))
    const value = await search()
    ok(value.ok === true, '工具仍回 ok:true（空库不是失败）', JSON.stringify(value))
    ok(value.coverage?.missingDir === true, 'coverage.missingDir 标记带出去了', JSON.stringify(value.coverage))
    ok(render(value).includes('记忆目录还不存在'), '渲染说明「目录还不存在」', render(value))
    ok(!render(value).includes('检索失败'), '不渲染成「检索失败」（目录没建过 ≠ 读不了）', render(value))
  } finally {
    await rename(aside, memDir)
  }
}

group('3. ENOTDIR = 目录级失败：ok:false + 明确 error，绝不渲染成「没有命中」')
{
  await rm(memDir, { recursive: true, force: true })
  await writeFile(memDir, 'not a directory')
  try {
    const d = await scan.scanMemoryDirDetailed(ctx, '', memDir)
    ok(d.complete === false, 'scan：complete=false', JSON.stringify(d))
    ok(d.files.length === 0, 'scan：files 为空，但 complete 明确为 false')
    ok(d.errors?.[0]?.code === 'ENOTDIR', 'scan：errors 带 ENOTDIR', JSON.stringify(d.errors))
    const value = await search()
    ok(value.ok === false, '工具：ok:false（不是「完整搜索且没有命中」）', JSON.stringify(value))
    ok(value.code === 'memory_unavailable', '工具：code=memory_unavailable', String(value.code))
    const text = render(value)
    ok(/ENOTDIR|读不了/.test(text), '渲染文案里有具体错误码 / 原因', text)
    ok(!text.includes('没有命中'), '【要点】失败没有被渲染成「没有命中」', text)
    ok(value.coverage?.complete === false, 'coverage.complete=false 也带出去了', JSON.stringify(value.coverage))
  } finally {
    await rm(memDir, { force: true })
    await mkdir(memDir, { recursive: true })
  }
}

group('4. EACCES = 目录级失败（确定性注入），且失败不落缓存')
{
  await emptyDir()
  await writeFile(join(memDir, 'after.md'), body('AFTER_RECOVERY_BODY'))
  const origReaddir = fsPromises.readdir
  fsPromises.readdir = async (p, ...a) => {
    if (String(p) === memDir) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    return origReaddir(p, ...a)
  }
  syncBuiltinESMExports()
  let d
  let value
  try {
    d = await scan.scanMemoryDirDetailed(ctx, '', memDir)
    value = await search()
  } finally {
    fsPromises.readdir = origReaddir
    syncBuiltinESMExports()
  }
  ok(d.complete === false && d.errors?.[0]?.code === 'EACCES', 'scan：EACCES 记为目录级失败', JSON.stringify(d))
  ok(value.ok === false && value.code === 'memory_unavailable', '工具：ok:false + memory_unavailable', JSON.stringify(value))
  const text = render(value)
  ok(/EACCES|读不了/.test(text), '渲染文案里有 EACCES', text)
  ok(!text.includes('没有命中'), '【要点】EACCES 没有被渲染成「没有命中」', text)

  // 恢复后必须能真的扫到文件：失败**不许**被缓存成「空目录」。
  const after = await scan.scanMemoryDirDetailed(ctx, '', memDir)
  ok(after.complete === true, '恢复后一次扫描 complete=true（失败没被缓存）', JSON.stringify(after))
  ok(after.files.some((f) => f.file === 'after.md'), '恢复后真的读到了文件', JSON.stringify(after.files.map((f) => f.file)))
  const good = await search({ query: 'AFTER_RECOVERY_BODY' })
  ok(good.ok === true && good.hits.length > 0, '恢复后检索能命中（反向对照）', JSON.stringify(good.hits?.[0]?.file))
}

group('5. 单条目被策略跳过 vs 目录级失败：分开统计')
{
  await emptyDir()
  await writeFile(join(memDir, 'small_a.md'), body('SMALL_A_BODY'))
  await writeFile(join(memDir, 'small_b.md'), body('SMALL_B_BODY'))
  // 超过 512 KiB 单文件上限：闸门在扫描时跳过这一条（不是目录级失败）。
  await writeFile(join(memDir, 'huge.md'), body('HUGE') + 'x'.repeat(600 * 1024))
  const d = await scan.scanMemoryDirDetailed(ctx, '', memDir)
  ok(d.complete === true, '有文件被跳过时 complete 仍为 true（目录是读得了的）', JSON.stringify(d))
  ok(d.skipped === 1, '跳过份数单独统计（skipped=1）', String(d.skipped))
  ok(d.files.length === 2, '可读的两份仍被读出', JSON.stringify(d.files.map((f) => f.file)))

  const value = await search({ query: '绝对不会命中的检索词' })
  ok(value.ok === true, '工具回 ok:true（目录没问题）', JSON.stringify(value))
  ok(value.coverage?.skippedFiles === 1, 'coverage.skippedFiles=1（与 complete 分开）', JSON.stringify(value.coverage))
  const text = render(value)
  ok(text.includes('被读取闸门跳过'), '渲染里说明了「有 N 份被跳过」', text)
  ok(text.includes('没有命中'), '仍然可以说「没有命中」—— 但前面已经交代有 1 份没读成', text)
}

group('6. 旧调用点仍按数组消费（scanMemoryFiles 兼容）')
{
  await emptyDir()
  await writeFile(join(memDir, 'compat.md'), body('COMPAT_BODY'))
  const files = await scan.scanMemoryFiles(ctx, '')
  ok(Array.isArray(files) && files.length === 1 && files[0].file === 'compat.md', 'scanMemoryFiles 返回文件数组（行为未变）', JSON.stringify(files))
  ok(typeof files[0].content === 'string' && files[0].content.includes('COMPAT_BODY'), '数组元素仍是带正文的记录')
}

await rm(sandbox, { recursive: true, force: true }).catch(() => {})

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
