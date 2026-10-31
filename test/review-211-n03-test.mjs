#!/usr/bin/env node
/**
 * review-211-n03-test.mjs — 自动整理的 read_memory 也必须走「读已验证」的句柄入口（N03，2.1.4）
 *
 * 外部审查（2026-10-31）指出：`lib/autodream/tools.js` 的 read_memory 仍是
 * `inspectMemoryEntry(path) → readFile(path)`，而注入链 / 面板早已改成 `readVerified`
 * （open 句柄 + fstat 比 dev:ino / 大小，只从那个句柄读）。提前按路径检查**约束不了随后
 * 按路径打开的那个对象**：检查完把普通文件换成符号链接，`readFile` 照样跟随链接读出目录外内容。
 *
 * 审查的原始复现用真符号链接；Windows 无 symlink 权限（EPERM），所以这里用**运行时探测**：
 *   - 主矩阵用 Windows / POSIX 都支持的等价手法 —— 检查之后用 `rename` 把路径换成
 *     另一份普通文件（同尺寸 / 更大 / 换成真符号链接 / 删掉），断言返回值绝不含目录外哨兵；
 *   - 真符号链接分支在探测到「本平台能建 symlink」时才跑，建不了就**跳过并计数**，
 *     不让 Windows 变红（Linux CI 上这一支会真的执行）。
 *
 * 覆盖所有**模型可调用的读取分支**：read_memory、list_memory、report_contradiction
 * （矛盾记录里存的两份正文同样会被模型/人看到）。每条分支都配一条合法读取的反向对照。
 */
import { syncBuiltinESMExports } from 'node:module'
import fsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = await mkdtemp(join(tmpdir(), 'sage-mem-n03-'))
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
const outsideDir = join(sandbox, 'outside')
await mkdir(memDir, { recursive: true })
await mkdir(stateDir, { recursive: true })
await mkdir(outsideDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')
await mkdir(process.env.DSH_HOME, { recursive: true })

const LIB = new URL('../lib/', import.meta.url)
const { createToolRunner } = await import(new URL('autodream/tools.js', LIB).href)

let pass = 0
let fail = 0
let skipped = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`) }
}
const skip = (name, why) => { skipped++; console.log(`  SKIP ${name}（${why}）`) }
const group = (t) => console.log(`== ${t} ==`)

const body = (s) => `---\nname: audit\ntype: project\n---\n${s}\n`
const makeRunner = (apply = false) =>
  createToolRunner({ memoryDir: memDir, sessionsRoot: join(sandbox, 'sessions'), apply, ctx: { get: () => undefined } })
const diskOf = (name) => readFile(join(memDir, name), 'utf8')

/**
 * 在「检查已经完成、马上要按路径读」的那一刻换掉目标文件。
 *
 * 两条钩子都装：修好的代码走 `open`（readVerified），base 走 `readFile` —— 这样同一条
 * 反例在两边都会真的触发替换，红/绿是同一个测试矩阵，不是两套。
 * `action` 只能做「换路径指向」：内容里带哨兵，返回值里出现哨兵就是越界读取成功。
 */
async function withSwap(target, action, fn) {
  const origRead = fsPromises.readFile
  const origOpen = fsPromises.open
  const normalized = join(memDir, target)
  let fired = false
  const maybe = async (p) => {
    if (fired || String(p) !== normalized) return
    fired = true
    await action()
  }
  fsPromises.readFile = async (p, ...a) => { await maybe(p); return origRead(p, ...a) }
  fsPromises.open = async (p, ...a) => { await maybe(p); return origOpen(p, ...a) }
  syncBuiltinESMExports()
  try {
    const result = await fn()
    return { result, fired }
  } finally {
    fsPromises.readFile = origRead
    fsPromises.open = origOpen
    syncBuiltinESMExports()
  }
}

/** 换入另一份普通文件（先写临时名再 rename：Windows 上 rename 覆盖是原子的）。 */
async function replaceWith(name, content) {
  const tmp = join(memDir, `.swap-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  await writeFile(tmp, content)
  await unlink(join(memDir, name)).catch(() => {})
  await rename(tmp, join(memDir, name))
}

group('1. 反向对照：合法读取不误伤（三个模型可调用分支）')
{
  await writeFile(join(memDir, 'legit.md'), body('LEGIT_BODY_ALPHA'))
  await writeFile(join(memDir, 'pair-a.md'), body('PAIR_BODY_ALPHA'))
  await writeFile(join(memDir, 'pair-b.md'), body('PAIR_BODY_BETA'))
  const runner = makeRunner(true)
  const read = await runner.run('read_memory', { file: 'legit.md' })
  ok(read.includes('LEGIT_BODY_ALPHA'), 'read_memory 正常记忆照常读出正文', read)

  const list = await makeRunner(true).run('list_memory', {})
  ok(list.includes('legit.md'), 'list_memory 正常记忆出现在清单里', list)

  const pair = await makeRunner(true).run('report_contradiction', {
    old: 'pair-a.md', new: 'pair-b.md', note: '两条正文互相矛盾，需要人来判定保留哪一边',
  })
  ok(pair.includes('已记录矛盾'), 'report_contradiction 正常记录一对矛盾', pair)
  const files = await readdir(join(stateDir, 'conflicts')).catch(() => [])
  const raw = files.length ? await readFile(join(stateDir, 'conflicts', files[0]), 'utf8') : ''
  ok(raw.includes('PAIR_BODY_ALPHA') && raw.includes('PAIR_BODY_BETA'),
    '矛盾记录里两份正文都存住了（反向对照：合法读取的内容进得了记录）', raw.slice(0, 120))
}

group('2. read_memory：检查后换入「同尺寸」另一份普通文件（Windows 等价手法）')
{
  const name = 'same-size.md'
  const legit = 'ORIGINAL_CONTENT_ABC' // 20 字符，纯 ASCII
  const original = body(legit)
  const sentinelBody = `OUTSIDE_${'x'.repeat(legit.length - 'OUTSIDE_'.length)}` // 与 legit 等长
  const sentinel = body(sentinelBody)
  ok(Buffer.byteLength(sentinel, 'utf8') === Buffer.byteLength(original, 'utf8'),
    '反例构造成立：换入文件与原件同尺寸（不靠大小判据也能验身份判据）')
  await writeFile(join(memDir, name), original)
  const { result, fired } = await withSwap(name, () => replaceWith(name, sentinel), () =>
    makeRunner().run('read_memory', { file: name }))
  ok(fired, '替换真的发生在「检查之后、读取之前」（否则这条反例没被触发，不算数）')
  ok(!result.includes('OUTSIDE_'), '【要点】返回值绝不含目录外哨兵（同尺寸替换被身份判据挡住）', result.slice(0, 160))
  ok(/拒绝|被替换|不一致|工具执行失败/.test(result), '工具明确报告读失败，而不是回一段来路不明的内容', result.slice(0, 160))
  ok((await diskOf(name)) === sentinel, '换入的确实是另一份文件（反例构造成立）')
}

group('3. read_memory：检查后换入更大的文件（体积上限 / 身份双保险）')
{
  const name = 'bigger.md'
  await writeFile(join(memDir, name), body('SMALL_ENOUGH'))
  const big = body('OUTSIDE_BIG_SENTINEL') + 'B'.repeat(1024 * 1024)
  const { result, fired } = await withSwap(name, () => replaceWith(name, big), () =>
    makeRunner().run('read_memory', { file: name }))
  ok(fired, '替换真的发生在读取之前')
  ok(!result.includes('OUTSIDE_BIG_SENTINEL'), '【要点】更大的外部文件一个字节都没返回', result.slice(0, 160))
  ok(result.length < 4096, '返回值体积没有跟着大文件膨胀（没有先整份读进来）', String(result.length))
}

group('4. read_memory：检查后删除（ENOENT 不是「空内容成功」）')
{
  const name = 'gone.md'
  await writeFile(join(memDir, name), body('SOON_GONE'))
  const { result, fired } = await withSwap(name, async () => { await unlink(join(memDir, name)) }, () =>
    makeRunner().run('read_memory', { file: name }))
  ok(fired, '删除真的发生在读取之前')
  ok(/没有这个文件|ENOENT|工具执行失败/.test(result), '读失败如实上报（不是静默空字符串）', result.slice(0, 160))
  ok(!result.includes('SOON_GONE'), '文件已被删，不会返回旧内容', result.slice(0, 160))
}

group('5. read_memory：检查后换成真符号链接（运行时探测；Windows 跳过并计数）')
{
  const name = 'symlinked.md'
  await writeFile(join(memDir, name), body('SYMLINK_ORIGINAL'))
  const outside = join(outsideDir, 'secret-synthetic.txt')
  await writeFile(outside, 'OUTSIDE_SYMLINK_SENTINEL')
  // 探测本平台能不能建文件符号链接：Windows 无特权时 EPERM，那就跳过（不让它变红）。
  const probe = join(sandbox, 'symlink-probe.txt')
  let canSymlink = true
  try {
    await fsPromises.symlink(outside, probe)
  } catch { canSymlink = false }
  await rm(probe, { force: true }).catch(() => {})
  if (!canSymlink) {
    skip('符号链接分支（普通文件 → 外链）', '运行时探测：本平台不允许创建文件符号链接（EPERM），Windows 用 rename 等价手法已覆盖')
  } else {
    const { result, fired } = await withSwap(name, async () => {
      await unlink(join(memDir, name)).catch(() => {})
      await fsPromises.symlink(outside, join(memDir, name))
    }, () => makeRunner().run('read_memory', { file: name }))
    ok(fired, '换成符号链接真的发生在检查之后、读取之前')
    ok(!result.includes('OUTSIDE_SYMLINK_SENTINEL'), '【要点】真符号链接指向的目录外内容没有被返回', result.slice(0, 160))
    ok(/拒绝|被替换|不一致|工具执行失败/.test(result), '工具明确拒绝，而不是跟随链接读下去', result.slice(0, 160))
  }
}

group('6. list_memory：检查后换文件，清单里不许出现外部标题')
{
  const name = 'swap-list.md'
  await writeFile(join(memDir, name), '---\nname: swap-list\ntype: project\n---\n# LEGIT_LIST_TITLE\n')
  const sentinelContent = '---\nname: evil\ntype: project\n---\n# OUTSIDE_LIST_TITLE\n'
  const { result, fired } = await withSwap(name, () => replaceWith(name, sentinelContent), () =>
    makeRunner().run('list_memory', {}))
  ok(fired, '替换真的发生在清单读取之前')
  ok(!result.includes('OUTSIDE_LIST_TITLE'), '【要点】清单里没有外部文件的标题（list_memory 也走读入闸门）', result.slice(0, 200))
  ok(result.includes('swap-list.md'), '被换掉的那条仍在清单里，但读失败要标出来', result.slice(0, 300))
}

group('7. report_contradiction：检查后换文件，记录里的正文不许来自目录外')
{
  const oldName = 'c-old.md'
  const newName = 'c-new.md'
  await writeFile(join(memDir, oldName), body('CONTRADICTION_OLD_LEGIT'))
  await writeFile(join(memDir, newName), body('CONTRADICTION_NEW_LEGIT'))
  const { result, fired } = await withSwap(newName, () => replaceWith(newName, body('OUTSIDE_REPORT_SENTINEL')), () =>
    makeRunner(true).run('report_contradiction', {
      old: oldName, new: newName, note: '两条正文互相矛盾，需要人来判定保留哪一边',
    }))
  ok(fired, '替换真的发生在记录读取之前')
  const files = await readdir(join(stateDir, 'conflicts')).catch(() => [])
  let all = ''
  for (const f of files) all += await readFile(join(stateDir, 'conflicts', f), 'utf8')
  ok(!all.includes('OUTSIDE_REPORT_SENTINEL'), '【要点】矛盾记录里没有目录外哨兵', all.slice(0, 200))
  ok(!result.includes('OUTSIDE_REPORT_SENTINEL'), '工具返回值里也没有哨兵', result.slice(0, 200))
  ok(/读不到|失败|没有这个文件/.test(result), '读失败时明确拒绝记录，而不是存进一份来路不明的正文', result.slice(0, 200))

  // 反向对照：不换文件时同一对矛盾能正常记录（证明上面不是「这个分支永远拒绝」）。
  await writeFile(join(memDir, newName), body('CONTRADICTION_NEW_LEGIT'))
  const good = await makeRunner(true).run('report_contradiction', {
    old: oldName, new: newName, note: '同一对矛盾再报一次，用来做反向对照',
  })
  ok(/已记录矛盾|已记录/.test(good), '【反向对照】不换文件时这一对能正常记录', good)
}

group('8. 前置核对：本平台的文件身份判据真的可用')
{
  const { inspectMemoryEntry, readVerified } = await import(new URL('memory/scan.js', LIB).href)
  await writeFile(join(memDir, 'id.md'), 'AAAA')
  const gate = await inspectMemoryEntry(join(memDir, 'id.md'))
  ok(gate.ok, '闸门能检查普通文件')
  ok(gate.id !== null, '闸门给出 dev:ino 身份（同尺寸替换能被身份判据挡住；为 null 时只剩大小判据）', String(gate.id))
  let code = 'no-error'
  try { await readVerified(join(memDir, 'id.md'), { ...gate, id: 'other:inode' }, 'utf8') } catch (err) { code = err?.code }
  ok(code === 'changed', 'readVerified 对身份不一致抛 changed', code)
}

await rm(sandbox, { recursive: true, force: true }).catch(() => {})

console.log('')
if (skipped) console.log(`跳过：${skipped} 项（运行时探测不支持的能力，不计失败）`)
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
