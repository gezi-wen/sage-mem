#!/usr/bin/env node
/**
 * review-211-q01-test.mjs — 自动整理的「读时版本」必须绑在**读到的那份正文**上（Q01，2.1.3）
 *
 * 外部审查（2026-10-31）的原话：真实代码是 `readFile → rememberReadVersion → stat → stat`，
 * 注释写的却是 `stat → read → stat`。于是读 A 完成、第一次 stat 之前文件被改成 B 时，
 * **两次 stat 都读到 B**，A 的正文被绑到 B 的版本上；宿主 CAS 再对也救不了这个错配
 * （复现：`readA=true, guardEqualsB=true, humanBPreserved=false`，最后回「已写入」）。
 *
 * 本套件用**受控宿主 fs**（版本 = 正文 SHA-256，条件写按 `replaceIfVersion` 校验真实内容）
 * 逐个控制三个窗口，不靠赛跑：
 *   - ① `before-stat → read`：第一次 stat 返回后、实际读取前盘上变 B；
 *   - ② `read → after-stat`：正文读成 A 之后、第二次 stat 之前盘上变 B；
 *   - ③ `after-stat → write`：版本记好之后、写回之前盘上变 B。
 * 判据不是「返回值写着失败」，而是**盘上留下的是哪一份字节**：发生修改时 B 必须保留。
 * 反向对照：全程没人改盘时必须能正常写入，且守卫用的是**读到时**的版本。
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = await mkdtemp(join(tmpdir(), 'sage-mem-q01-'))
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
await mkdir(memDir, { recursive: true })
await mkdir(stateDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')
await mkdir(process.env.DSH_HOME, { recursive: true })

const LIB = new URL('../lib/', import.meta.url)
const { createToolRunner } = await import(new URL('autodream/tools.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const body = (s) => `---\nname: audit\ntype: project\n---\n${s}\n`
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const versionOf = async (p) => sha(await readFile(p))

/**
 * 受控宿主 fs。`version` 用正文 SHA-256 —— 与真实宿主「内容变则版本变」的契约同形，
 * 但让我们能断言「这次写回带的守卫到底是哪个版本」。
 *
 * @param {(path:string, n:number)=>Promise<{version:string}>} [statHook]
 *   第 n 次 stat 时自定义返回值；不传就是「老实返回当前版本」。
 */
function makeHost(statHook) {
  const host = {
    calls: { stat: 0, write: 0, writeText: 0 },
    writeIntents: [],
    async resolve(p) { return p },
    async stat(p) {
      host.calls.stat += 1
      return statHook ? statHook(p, host.calls.stat) : { version: await versionOf(p), type: 'file' }
    },
    async readText(p) { return readFile(p, 'utf8') },
    async writeText(p, content, expected) {
      host.calls.write += 1
      host.writeIntents.push(expected)
      const current = await versionOf(p)
      if (expected?.kind === 'replaceIfVersion' && expected.version !== current) {
        throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
      }
      await writeFile(p, content)
      return { operation: 'update', version: sha(Buffer.from(content, 'utf8')) }
    },
  }
  return host
}

const makeRunner = (host) =>
  createToolRunner({
    memoryDir: memDir,
    sessionsRoot: join(sandbox, 'sessions'),
    apply: true,
    ctx: { get: (n) => (n === 'fs' ? host : undefined) },
  })

/** 一次「读 → 写」；返回所有值得断言的东西。 */
async function readThenWrite(host, name, nextText) {
  const runner = makeRunner(host)
  const read = await runner.run('read_memory', { file: name })
  const write = await runner.run('write_memory', { file: name, content: nextText, reason: '审查反例：窗口内有人改过盘' })
  const disk = await readFile(join(memDir, name), 'utf8')
  return { read, write, disk }
}

group('0. 前置：受控宿主的条件写真的会拒绝过期版本')
{
  const p = join(memDir, 'sanity.md')
  await writeFile(p, body('A'))
  const host = makeHost()
  let code = 'no-error'
  try {
    await host.writeText(p, body('C'), { kind: 'replaceIfVersion', version: 'not-the-current-version' })
  } catch (err) { code = err?.code }
  ok(code === 'FS_STALE_VERSION', '宿主 CAS 对过期版本抛 FS_STALE_VERSION（否则下面所有「B 被保留」都不作数）', code)
  ok((await readFile(p, 'utf8')) === body('A'), '被 CAS 拒绝时盘上原样未动')
}

group('1. 窗口① before-stat → read：第一次 stat 之后、读取之前被改')
{
  const name = 'w1.md'
  const p = join(memDir, name)
  await writeFile(p, body('A old'))
  const host = makeHost(async (path, n) => {
    const version = await versionOf(path) // 先捕获 A 的版本……
    if (n === 1) await writeFile(path, body('B human addition')) // ……stat 返回前把盘改成 B
    return { version, type: 'file' }
  })
  const { read, write, disk } = await readThenWrite(host, name, body('C based on A'))
  ok(disk.includes('B human addition'), '【要点】版本取样与正文不一致时，B 必须原样保留', disk)
  ok(!write.startsWith('已写入'), '写回被拒绝（没有把 A 的内容写成 C 覆盖 B）', write)
  ok(host.calls.write === 0, '被拒绝的写根本没落到宿主写入（writeText 一次都没调）', JSON.stringify(host.calls))
  // 读本身允许成功：读到的是窗口里那份正文，但**不允许**把它当作可覆盖的依据。
  ok(read.includes('B human addition') || read.includes('A old'), '读取不崩，返回内容来自窗口内的真实文件', read)
}

group('2. 窗口② read → after-stat：正文读成 A 之后、第二次 stat 之前被改')
{
  const name = 'w2.md'
  const p = join(memDir, name)
  await writeFile(p, body('A old'))
  const host = makeHost(async (path, n) => {
    const version = await versionOf(path) // 读之前/之后各取一次，期间可能有人改盘
    if (n === 2) await writeFile(path, body('B human addition')) // 第二次 stat 已在 read 之后：此刻改盘
    return { version: n === 2 ? await versionOf(path) : version, type: 'file' }
  })
  const { read, write, disk } = await readThenWrite(host, name, body('C based on A'))
  ok(read.includes('A old'), '读取拿到的是 read 时刻的 A（窗口内没读坏）', read)
  ok(disk.includes('B human addition'), '【要点】读后盘上变 B：B 必须保留', disk)
  ok(!write.startsWith('已写入'), '写回被拒绝（两次 stat 版本不同 → 不建立写入依据）', write)
  ok(host.calls.write === 0, '被拒绝的写根本没落到宿主写入', JSON.stringify(host.calls))
}

group('3. 窗口③ after-stat → write：版本记好之后、写回之前被改（宿主 CAS 兜底）')
{
  const name = 'w3.md'
  const p = join(memDir, name)
  await writeFile(p, body('A old'))
  const host = makeHost() // 没人扰动：stat 老实返回当前版本
  const runner = makeRunner(host)
  const read = await runner.run('read_memory', { file: name })
  ok(read.includes('A old'), '正常读到 A（反向对照的一半）', read)
  await writeFile(p, body('B human addition')) // 读完之后、写回之前人工改盘
  const write = await runner.run('write_memory', { file: name, content: body('C based on A'), reason: '审查反例：写前被改盘' })
  const disk = await readFile(p, 'utf8')
  ok(disk.includes('B human addition'), '【要点】after-stat→write 窗口：宿主 CAS 拒绝，B 保留', disk)
  ok(!write.startsWith('已写入'), '写回被拒绝（守卫是 A 的版本，不是当前版）', write)
  const intent = host.writeIntents.at(-1)
  ok(intent?.kind === 'replaceIfVersion' && intent.version === sha(Buffer.from(body('A old'), 'utf8')),
    '守卫带的是读到 A 时的版本（不是「写的那一刻」的版本）', JSON.stringify(intent))
}

group('4. Q01 原始复现形态：读完 A、第一次 stat 之前盘上变 B')
{
  const name = 'repro.md'
  const p = join(memDir, name)
  await writeFile(p, body('A old'))
  // 旧代码 readFile → stat → stat：read 先拿到 A，随后第一次 stat 时改成 B，两次 stat 都是 B。
  // 新代码 stat → read → stat：第一次 stat 时改盘，随后读到的是 B，内容与版本同源。
  const host = makeHost(async (path, n) => {
    if (n === 1) await writeFile(path, body('B human addition'))
    return { version: await versionOf(path), type: 'file' }
  })
  const { read, write, disk } = await readThenWrite(host, name, body('C based on A'))
  const leaked = read.includes('A old') && write.startsWith('已写入')
  ok(!leaked, '【Q01 核心】绝不出现「读到 A、却拿 B 的版本写回成功」', `read=${read.slice(0, 40)} write=${write}`)
  ok(read.includes('B human addition') || !write.startsWith('已写入'),
    '内容与版本同源（读到 B）或拒绝覆盖，二者必居其一', `read=${read.slice(0, 40)} write=${write}`)
  if (write.startsWith('已写入')) {
    ok(disk === body('C based on A'), '若允许写入，说明模型读到并改的就是当时那份正文（不丢别人的修改）', disk)
  } else {
    ok(disk.includes('B human addition'), '若拒绝写入，B 原样保留', disk)
  }
}

group('5. 反向对照：全程没人改盘 → 正常写入，守卫等于读到的版本')
{
  const name = 'ok.md'
  const p = join(memDir, name)
  await writeFile(p, body('A old'))
  const host = makeHost()
  const { read, write, disk } = await readThenWrite(host, name, body('C updated'))
  ok(read.includes('A old'), '正常读回原文')
  ok(write.startsWith('已写入'), '未变化时可正常写入（守卫不误伤）', write)
  ok(disk === body('C updated'), '写入内容落盘', JSON.stringify(disk))
  ok(host.writeIntents.length === 1 && host.writeIntents[0]?.version === sha(Buffer.from(body('A old'), 'utf8')),
    '守卫版本 = 读到的那份内容的版本', JSON.stringify(host.writeIntents))
}

group('6. 版本取不到时按未知处理：不拿当前版本补票')
{
  const name = 'nover.md'
  const p = join(memDir, name)
  await writeFile(p, body('A old'))
  // 宿主的 stat 可用、但**不返回版本字段**（版本缺失）：读取前后都拿不到版本。
  const host = {
    calls: { stat: 0, write: 0 },
    writeIntents: [],
    async resolve(x) { return x },
    async stat() { host.calls.stat += 1; return { type: 'file' } }, // 没有 version
    async readText(x) { return readFile(x, 'utf8') },
    async writeText(x, content, expected) {
      host.calls.write += 1
      host.writeIntents.push(expected)
      await writeFile(x, content)
      return { operation: 'update', version: null }
    },
  }
  const runner = makeRunner(host)
  const read = await runner.run('read_memory', { file: name })
  const write = await runner.run('write_memory', { file: name, content: body('C'), reason: '审查反例：无版本' })
  const disk = await readFile(p, 'utf8')
  ok(read.includes('A old'), '读取本身不受影响')
  ok(disk === body('A old'), '【要点】版本缺失时拒绝覆盖（宁可不动，不拿当前版本补票）', disk)
  ok(!write.startsWith('已写入'), '写回被拒绝', write)
  ok(host.calls.write === 0, '没有落到宿主写入', JSON.stringify(host.calls))
}

await rm(sandbox, { recursive: true, force: true }).catch(() => {})

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
