#!/usr/bin/env node
/**
 * safe-read-test.mjs — SEC-01：检查与读取之间被换文件，必须能检出（1.6.3 新增）
 *
 * 外部审查报告（2026-10-23）指出：`inspectMemoryEntry()` 用 `lstat(路径)` 检查，
 * 调用方随后用 `readFile(路径)` 读 —— 两次按路径操作之间的窗口已被确定性复现：
 * 闸门看到 57 B 的正常文件，换入 5 MB 文件后实际读进 5,242,896 B，**512 KB 上限被绕过**。
 *
 * 修法是 `readVerified()`：先 `open(路径)` 拿句柄，对**同一个句柄** `fstat` 比对
 * `dev:ino` 身份与大小，再从该句柄读。本套件用**确定性替换**（不靠赛跑）证明：
 *
 *   - 正常文件：内容与 Buffer 两种读法都原样返回；
 *   - 闸门后被换成更大的文件：拒绝，`code = changed`；
 *   - 闸门后被换成同样大小的另一个文件：靠身份（inode）拒绝；
 *   - 闸门后被删：`ENOENT`（不是静默空内容）；
 *   - 拿不到 inode 的平台：退化为大小比对，仍能拒绝；
 *   - 星图面板读与注入链/工具读同闸门：>512 KB 的普通记忆现在会被拒绝。
 *
 * 注意：这里测的是「检出并拒绝」，不是「阻止攻击者」—— 能替换文件的人必须已经能写
 * 记忆目录；威胁模型见 `docs/review-2026-10-23-response.md`。
 */
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = await mkdtemp(join(tmpdir(), 'sage-mem-saferead-'))
const memDir = join(sandbox, 'memory')
await mkdir(memDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')
await mkdir(process.env.DSH_HOME, { recursive: true })

const LIB = new URL('../lib/', import.meta.url)
const scan = await import(new URL('memory/scan.js', LIB).href)
const index = await import(new URL('index.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const write = (name, content) => writeFile(join(memDir, name), content)
const pathOf = (name) => join(memDir, name)
const gateOf = async (name, opts) => {
  const gate = await scan.inspectMemoryEntry(pathOf(name), opts)
  if (!gate.ok) throw new Error(`fixture gate failed: ${gate.code} ${gate.error}`)
  return gate
}
const codeOf = async (p) => {
  try { await p; return 'no-error' } catch (err) { return err?.code ?? 'no-code' }
}

/** 假 ctx（与 panel-api-test 相同）：cordis Service 构造只需要一个宽底对象。 */
function makeCtx() {
  const base = { on: () => {}, get: () => undefined, logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }, effect: () => {} }
  let stub
  stub = new Proxy(function () {}, { get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined), apply: () => undefined })
  return new Proxy(base, { get(t, p) { return p in t ? t[p] : stub } })
}

group('1. readVerified：检查过的文件，读到的就是同一份')
{
  await write('hello.md', 'hello 记忆\n')
  const gate = await gateOf('hello.md')
  ok((await scan.readVerified(pathOf('hello.md'), gate, 'utf8')) === 'hello 记忆\n',
    '正常文件按 utf8 读到原内容')
  const buf = await scan.readVerified(pathOf('hello.md'), gate, false)
  ok(Buffer.isBuffer(buf) && buf.equals(await readFile(pathOf('hello.md'))),
    'encoding=false 返回与盘上逐字节相同的 Buffer')
  ok(gate.id === null || typeof gate.id === 'string', '闸门给出文件身份（或平台不支持时为 null）')
}

group('2. 确定性替换：闸门之后换文件，必须拒绝（不靠赛跑）')
{
  // 2a. 换成更大的文件：旧写法会读进 1 MB，绕过 512 KB 上限。
  await write('small.md', 'x'.repeat(57))
  const g1 = await gateOf('small.md')
  await write('swap.md', Buffer.alloc(1024 * 1024, 0x42))
  await rm(pathOf('small.md'), { force: true })
  await rename(pathOf('swap.md'), pathOf('small.md'))
  ok((await codeOf(scan.readVerified(pathOf('small.md'), g1, 'utf8'))) === 'changed',
    '闸门后换入更大的文件 → code=changed（不会读到替换内容）')

  // 2b. 换成同样大小、但身份不同的文件：只比大小的实现会放过，身份比对不会。
  await write('same-a.md', 'AAAA')
  await write('same-b.md', 'BBBB')
  const g2 = await gateOf('same-a.md')
  await rm(pathOf('same-a.md'), { force: true })
  await rename(pathOf('same-b.md'), pathOf('same-a.md'))
  ok((await codeOf(scan.readVerified(pathOf('same-a.md'), g2, 'utf8'))) === 'changed',
    '闸门后换成同尺寸的另一个文件 → 靠 dev:ino 拒绝')

  // 2c. 平台拿不到 inode 时退化为大小比对（构造一个 id:null 的闸门值）。
  await write('fallback.md', '0123456789')
  ok((await codeOf(scan.readVerified(pathOf('fallback.md'), { id: null, size: 3 }, 'utf8'))) === 'changed',
    'gate.id=null 时退化为大小比对，大小不符仍拒绝')
  ok((await scan.readVerified(pathOf('fallback.md'), { id: null, size: 10 }, 'utf8')) === '0123456789',
    'gate.id=null 且大小相符时正常读取')

  // 2d. 闸门之后被删：ENOENT 要原样抛出，由调用方区分「不存在」与「读失败」。
  await write('gone.md', 'gone')
  const g3 = await gateOf('gone.md')
  await rm(pathOf('gone.md'))
  ok((await codeOf(scan.readVerified(pathOf('gone.md'), g3, 'utf8'))) === 'ENOENT',
    '闸门后文件被删 → ENOENT（不是空内容/静默成功）')
}

group('3. 星图面板读与另两条读路径同闸门（R19）')
{
  const gw = new index.StarmapGateway(makeCtx())
  await write('star.md', '---\nname: star\ntype: project\n---\n\n# 星\n')
  ok((await gw.readFile('star.md')).content.includes('# 星'), '普通记忆照常可读')

  await write('big.md', 'x'.repeat(600 * 1024))
  let message = ''
  try { await gw.readFile('big.md') } catch (err) { message = err?.message ?? String(err) }
  ok(/超过单文件上限/.test(message), '超过 512 KB 的记忆被同一个体积闸门拒绝', message)

  let badName = ''
  try { await gw.readFile('../secret.md') } catch (err) { badName = err?.message ?? String(err) }
  ok(/invalid file name/.test(badName), '非法文件名仍在 safeName 处拒绝', badName)
}

await rm(sandbox, { recursive: true, force: true }).catch(() => {})

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
