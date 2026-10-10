/**
 * v0.9.5 两条修复的反面断言。
 *
 * 编号是**本文件内部的分组标签**（每条都先能复现旧行为，再靠修复转绿）：
 *   Q07  `search_sessions` 把会话记录当**单帧** zstd 解 —— 真实文件是「逐行一个帧」，
 *        只解第一帧等于只看得见会话头，后面的正文全部搜不到（关键词在第二帧之后必然漏）
 *   Q08  锁的所有权没人校验：`releaseLock()` 无条件删锁文件，抢过期锁用 `rm` 有竞态 ——
 *        慢的那一方会把**别人刚拿到的锁**删掉（互删）
 */
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { spawn } from 'node:child_process'

const LIB = new URL('../lib/', import.meta.url)
const { AutodreamEngine } = await import(new URL('autodream.js', LIB).href)
const { createToolRunner } = await import(new URL('autodream-tools.js', LIB).href)

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
const exists = async (p) => (await stat(p).catch(() => null)) !== null
/**
 * ⚠️ 只能用它判断「命中了」——**不能**用 `out.includes(query)`：
 * 「没找到」的提示会把查询词原样回显（`（…没找到含「X」的内容）`），于是那条断言恒真。
 * 这个假绿我自己踩过一次，写在断言里当路标。
 */
const isHit = (out) => /命中 \d+ 段/.test(String(out))

/** cordis Service 构造会取 ctx.reflect.*，未知成员得给可调用且能继续取属性的桩。 */
function makeCtx() {
  const logger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }
  const base = { on: () => {}, get: () => undefined, logger, effect: () => {} }
  let stub
  stub = new Proxy(function () {}, { get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined), apply: () => undefined })
  return new Proxy(base, { get: (t, p) => (p in t ? t[p] : stub) })
}

async function world(tag) {
  const root = await mkdtemp(join(tmpdir(), `q095-${tag}-`))
  const memoryDir = join(root, 'memory')
  const sessionsRoot = join(root, 'sessions')
  await mkdir(memoryDir, { recursive: true })
  await mkdir(sessionsRoot, { recursive: true })
  return { root, memoryDir, sessionsRoot }
}

/** 把若干行压成「一行一个 zstd 帧」再拼起来 —— 真实会话文件就是这个形状。 */
const multiFrame = (lines) => Buffer.concat(lines.map((l) => zstdCompressSync(Buffer.from(`${l}\n`, 'utf8'))))

// ────────────────────────── Q07 · zstd 多帧 ──────────────────────────

console.log('== Q07a：会话记录是逐行一个帧，关键词出现在**第二帧之后**也要命中 ==')
{
  const { memoryDir, sessionsRoot } = await world('zstd')
  const sessDir = join(sessionsRoot, 'proj-a', 'sess-1')
  await mkdir(sessDir, { recursive: true })
  await writeFile(
    join(sessDir, 'session.v4.jsonl.zstd'),
    multiFrame([
      '{"type":"head","text":"会话头，这一帧里没有关键词"}', // 第一帧（旧实现只能解到这一帧）
      '{"type":"msg","role":"user","text":"这里有关键词 NEEDLE-IN-SECOND-FRAME"}', // 第二帧
      '{"type":"msg","role":"assistant","text":"第三帧也有 NEEDLE-IN-THIRD-FRAME"}', // 第三帧
    ]),
  )
  const runner = createToolRunner({ memoryDir, sessionsRoot, apply: false, withSessions: true, ctx: makeCtx() })

  const hit2 = await runner.run('search_sessions', { query: 'NEEDLE-IN-SECOND-FRAME' })
  ok(isHit(hit2), '第二帧里的关键词命中（旧实现整条搜索都解不出来）', String(hit2).slice(0, 200))

  const hit3 = await runner.run('search_sessions', { query: 'NEEDLE-IN-THIRD-FRAME' })
  ok(isHit(hit3), '第三帧里的关键词也命中', String(hit3).slice(0, 200))

  const hit1 = await runner.run('search_sessions', { query: '会话头' })
  ok(isHit(hit1), '第一帧照常命中（多帧支持不是把前面的丢了）', String(hit1).slice(0, 200))

  const miss = await runner.run('search_sessions', { query: 'NO-SUCH-KEYWORD-ANYWHERE' })
  ok(/没找到/.test(miss), '搜不到时如实说明（不是假报命中）', String(miss).slice(0, 140))
}

console.log('== Q07b：单帧样本、坏帧邻居都要照常 ==')
{
  const { memoryDir, sessionsRoot } = await world('zstd2')
  const single = join(sessionsRoot, 'proj-b', 'sess-single')
  await mkdir(single, { recursive: true })
  await writeFile(join(single, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from('单帧正文里有 SINGLE-FRAME-NEEDLE\n', 'utf8')))
  const runner = createToolRunner({ memoryDir, sessionsRoot, apply: false, withSessions: true, ctx: makeCtx() })
  const one = await runner.run('search_sessions', { query: 'SINGLE-FRAME-NEEDLE' })
  ok(isHit(one), '单帧样本照常命中（不回归）', String(one).slice(0, 200))

  // 一个坏文件 + 一个好文件：坏的不许把整场搜索带下水
  const broken = join(sessionsRoot, 'proj-c', 'sess-broken')
  const good = join(sessionsRoot, 'proj-c', 'sess-good')
  await mkdir(broken, { recursive: true })
  await mkdir(good, { recursive: true })
  const whole = multiFrame(['{"text":"BROKEN-FILE-NEEDLE 这一帧是完整的"}', '{"text":"第二帧"}'])
  await writeFile(join(broken, 'session.v4.jsonl.zstd'), whole.subarray(0, whole.length - 6))
  await writeFile(join(good, 'session.v4.jsonl.zstd'), multiFrame(['{"text":"好文件里有 GOOD-FILE-NEEDLE"}']))
  const messy = await runner
    .run('search_sessions', { query: 'GOOD-FILE-NEEDLE' })
    .catch((err) => `THREW: ${err?.message ?? err}`)
  ok(!String(messy).startsWith('THREW'), '坏帧不让整场搜索抛错', String(messy).slice(0, 140))
  ok(isHit(messy), '坏文件的邻居照常被搜到（一个坏文件不该让整场搜索哑掉）', String(messy).slice(0, 200))

  /**
   * ⚠️ 同一份文件里「坏帧之后还有好帧」才是真考验：解析不出长度时若直接停下，
   * 后面的好帧会被**静默丢弃**（那些帧本来完全正常）。
   */
  const messyDir = join(sessionsRoot, 'proj-d', 'sess-junk-inside')
  await mkdir(messyDir, { recursive: true })
  const f1 = zstdCompressSync(Buffer.from('{"text":"第一帧好着呢"}\n', 'utf8'))
  const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]) // 认不出帧头的垃圾
  const f3 = zstdCompressSync(Buffer.from('{"text":"垃圾之后的好帧里有 AFTER-JUNK-NEEDLE"}\n', 'utf8'))
  await writeFile(join(messyDir, 'session.v4.jsonl.zstd'), Buffer.concat([f1, junk, f3]))
  const afterJunk = await runner.run('search_sessions', { query: 'AFTER-JUNK-NEEDLE' })
  ok(isHit(afterJunk), '帧之间的垃圾不该让后面的好帧消失（旧实现直接停在那里）', String(afterJunk).slice(0, 200))
}

console.log('== Q07c：limit 是「最多这么多段」，不是「超过才停」==')
{
  const { memoryDir, sessionsRoot } = await world('zstd3')
  const dir = join(sessionsRoot, 'proj-e', 'sess-limit')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'session.v4.jsonl.zstd'),
    multiFrame(['{"text":"LIMIT-NEEDLE 第一段"}', '{"text":"LIMIT-NEEDLE 第二段"}', '{"text":"LIMIT-NEEDLE 第三段"}']),
  )
  const runner = createToolRunner({ memoryDir, sessionsRoot, apply: false, withSessions: true, ctx: makeCtx() })
  const one = await runner.run('search_sessions', { query: 'LIMIT-NEEDLE', limit: 1 })
  const lines = String(one).split('\n').filter((l) => l.startsWith('['))
  ok(lines.length === 1, `limit=1 恰好返回 1 段（旧实现返回 2 段，实际 ${lines.length}）`, String(one).slice(0, 200))
}

// ────────────────────────── Q08 · 锁所有权 ──────────────────────────

console.log('== Q08a：锁要记住持有者，释放时只删自己的那一把 ==')
{
  const { memoryDir, sessionsRoot } = await world('lock')
  const engineA = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot })
  await engineA.load()
  const lockPath = engineA.lockPath

  ok((await engineA.acquireLock()) === true, '第一次拿锁成功')
  const mine = JSON.parse(await readFile(lockPath, 'utf8'))
  ok(typeof mine.token === 'string' && mine.token.length > 0, '锁里记了持有者的 token（旧版只有 pid/at/runId）', JSON.stringify(mine))

  // 模拟「另一个实例把锁换成自己的」（旧持有者慢了一步）
  await writeFile(lockPath, JSON.stringify({ pid: 999999, at: Date.now(), runId: 'other-run', token: 'other-token' }), 'utf8')
  await engineA.releaseLock()
  ok(await exists(lockPath), '旧持有者释放时**没有**删掉新持有者的锁（旧实现无条件 rm）')
  ok(
    JSON.parse(await readFile(lockPath, 'utf8').catch(() => '{}')).token === 'other-token',
    '锁文件内容也没被动过',
  )

  const engineB = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot })
  await engineB.load()
  ok((await engineB.acquireLock()) === false, '锁还被别人持有时，第二个实例拿不到')

  await rm(lockPath, { force: true })
  ok((await engineB.acquireLock()) === true, '锁被清掉后 B 能拿到')
  await engineB.releaseLock()
  ok(!(await exists(lockPath)), 'B 释放自己的锁：照常删掉（不是一律不删）')
}

console.log('== Q08b：过期锁可以抢；并发抢锁只有一个成功 ==')
{
  const { memoryDir, sessionsRoot } = await world('lock2')
  const engineA = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot })
  await engineA.load()
  const lockPath = engineA.lockPath

  // 造一把三小时前的锁（LOCK_STALE_MS = 2 小时）
  await mkdir(engineA.home, { recursive: true })
  await writeFile(lockPath, JSON.stringify({ pid: 1, at: Date.now() - 3 * 3600e3, runId: 'stale', token: 'stale-token' }), 'utf8')
  const old = new Date(Date.now() - 3 * 3600 * 1000)
  await utimes(lockPath, old, old)
  ok((await engineA.acquireLock()) === true, '崩掉留下的过期锁可以被抢回来（不然永远回不来）')
  ok(
    JSON.parse(await readFile(lockPath, 'utf8')).token !== 'stale-token',
    '抢到之后锁的持有者换成了自己',
  )

  await rm(lockPath, { force: true })
  const engines = [
    new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot }),
    new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot }),
    new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot }),
  ]
  for (const e of engines) await e.load()
  const winners = (await Promise.all(engines.map((e) => e.acquireLock()))).filter(Boolean)
  ok(winners.length === 1, `三个实例并发抢锁：恰好一个成功（实际 ${winners.length}）`)
}

console.log('== Q08c：多**进程**同时抢一把过期锁，恰好一个赢家 ==')
{
  /**
   * 为什么非要多进程：抢占窗口（`stat` 判过期 与 读 token 之间）在单进程的 await 调度下
   * 极难命中；把它交给真并发才有意义。判据是「每轮恰好一个 WON」——
   * 两个赢家意味着两个整理进程同时往记忆目录里写。
   */
  const { memoryDir, sessionsRoot, root } = await world('lock3')
  const probe = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot })
  await probe.load()
  const lockPath = probe.lockPath
  await mkdir(probe.home, { recursive: true })

  const child = join(root, 'child.mjs')
  await writeFile(
    child,
    `const { AutodreamEngine } = await import(${JSON.stringify(new URL('autodream.js', LIB).href)})
let stub
stub = new Proxy(function () {}, { get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined), apply: () => undefined })
const ctx = new Proxy({ on: () => {}, get: () => undefined, logger: { warn: () => {}, error: () => {} }, effect: () => {} }, { get: (t, p) => (p in t ? t[p] : stub) })
const e = new AutodreamEngine(ctx, { memoryDir: process.env.Q_MEM, sessionsRoot: process.env.Q_SESS })
await e.load()
const won = await e.acquireLock()
process.stdout.write(won ? 'WON' : 'LOST')
process.exit(0)
`,
    'utf8',
  )

  let maxWinners = 0
  const rounds = 3
  for (let round = 0; round < rounds; round++) {
    await rm(lockPath, { force: true })
    await writeFile(lockPath, JSON.stringify({ pid: 1, at: Date.now() - 3 * 3600e3, runId: 'stale', token: 'stale' }), 'utf8')
    const old = new Date(Date.now() - 3 * 3600 * 1000)
    await utimes(lockPath, old, old)
    const kids = Array.from({ length: 6 }, () =>
      spawn(process.execPath, [child], { env: { ...process.env, Q_MEM: memoryDir, Q_SESS: sessionsRoot } }),
    )
    const outs = await Promise.all(
      kids.map(
        (k) =>
          new Promise((res) => {
            let s = ''
            k.stdout.on('data', (d) => (s += d))
            k.on('exit', () => res(s))
          }),
      ),
    )
    maxWinners = Math.max(maxWinners, outs.filter((o) => o.includes('WON')).length)
  }
  ok(maxWinners === 1, `${rounds} 轮 × 6 进程抢过期锁：每轮恰好一个赢家（最多 ${maxWinners} 个）`)
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
