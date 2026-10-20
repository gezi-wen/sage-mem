#!/usr/bin/env node
/**
 * stale-conflict-test.mjs — 验「写入撞上版本过期」会落成一条**待人工判定**的冲突记录（2026-10-15 建）
 *
 * 这条链路的每一边都已有各自的套件：`write-gate-test`（判定表）、`write-gate-wiring-test`（接线）、
 * `conflicts-test`（队列本身）。缺的是**它们之间的那一跳** —— 宿主抛 `FS_STALE_VERSION` 时，
 * 我们到底有没有把这次失败落成记录、有没有把它咽掉反而让模型以为写成功了。
 *
 * 宿主的真实行为已在 `scripts/fs-probe.mjs` 里实测（过期版本守卫确实会被拒），
 * 所以这里用假 ctx 精确构造那一个错误，不必再去跑真宿主。
 *
 * 用法: node stale-conflict-test.mjs
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-stale-'))
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
mkdirSync(memDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const { createToolRunner } = await import(new URL('../lib/autodream/tools.js', import.meta.url).href)

const CONFLICTS_DIR = join(stateDir, 'conflicts')
const readConflicts = () => {
  try {
    return readdirSync(CONFLICTS_DIR)
      .filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(join(CONFLICTS_DIR, n), 'utf8')))
  } catch {
    return []
  }
}

const MEM = join(memDir, 'project_alpha.md')
const seed = () => {
  writeFileSync(MEM, '---\nname: project_alpha\ntype: project\n---\n\n盘上这一版\n', 'utf8')
}

/**
 * 假 ctx：`fs` 的 writeText 按 `mode` 决定行为。
 *   'stale' → 抛 FS_STALE_VERSION（要验的就是这条）
 *   'boom'  → 抛别的错（不该落冲突）
 *   'ok'    → 正常返回 FsWriteOutcome
 * 没有 `get`（`fs: null`）时走回落路径。
 */
function makeCtx(mode, opts = {}) {
  const seen = { expected: 'NOT_CALLED', statCalls: 0 }
  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    effect: () => {},
    on: () => {},
    seen,
  }
  if (mode === null) return ctx
  ctx.get = (name) => {
    if (name !== 'fs') return undefined
    return {
      resolve: async (p) => ({ targetKey: 'k:' + p, displayPath: p }),
      stat: async () => {
        seen.statCalls++
        if (opts.statThrows) throw new Error('stat 炸了')
        return opts.fileAbsent ? undefined : { version: 'fsv:current', type: 'file' }
      },
      readText: async () => '盘上这一版\n',
      writeText: async (_t, _c, expected) => {
        seen.expected = expected === undefined ? undefined : expected
        if (mode === 'stale') {
          const e = new Error('file changed since it was read')
          e.code = 'FS_STALE_VERSION'
          throw e
        }
        if (mode === 'boom') {
          const e = new Error('磁盘满了')
          e.code = 'ENOSPC'
          throw e
        }
        return { operation: 'update', version: 'fsv:next', before: '盘上这一版\n', after: '新的一版\n' }
      },
    }
  }
  return ctx
}

const body = '---\nname: project_alpha\ntype: project\n---\n\n自动做梦想写的新内容\n'

/** 跑一次写入；返回 `{result, threw, seen}` —— 三种观察都要有，缺一种就会漏掉一整类缺陷。 */
async function attempt(mode, opts = {}) {
  seed()
  const ctx = makeCtx(mode, opts)
  const runner = createToolRunner({ memoryDir: memDir, sessionsRoot: '', apply: true, withSessions: false, ctx })
  try {
    // `readFirst`：先真的读一次，让「读时版本」被记下来 —— 这才是守卫该有的来源（R01）。
    if (opts.readFirst) await runner.run('read_memory', { file: 'project_alpha.md' })
    return { result: await runner.run('write_memory', { file: 'project_alpha.md', content: body, reason: '合并重复段落' }), threw: null, seen: ctx.seen }
  } catch (err) {
    return { result: null, threw: err, seen: ctx.seen }
  }
}

// ═══ 1. 版本过期 → 落一条冲突，且不谎报成功 ═══
group('1. FS_STALE_VERSION → 一条待判定的冲突记录')
{
  const before = readConflicts().length
  const { result, threw } = await attempt('stale', { readFirst: true })
  const after = readConflicts()

  // 写失败必须**看得见**：要么抛出，要么回一句带错误的结果 —— 不能是「已写入」
  const surfaced = !!threw || (typeof result === 'string' && !result.startsWith('已写入'))
  ok(surfaced, '写失败如实浮出来（没有谎报「已写入」）', JSON.stringify({ threw: threw?.code, result }))
  ok(after.length === before + 1, `冲突记录多了一条（${before} → ${after.length}）`)

  const rec = after[after.length - 1]
  ok(rec && rec.kind === 'stale_version', 'kind 是 stale_version（不是笼统的 write_failed）', rec?.kind)
  ok(rec && rec.file === 'project_alpha.md', '记录里带文件名', rec?.file)
  ok(rec && rec.status === 'open', '新记录是 open（等着人判，不是自动消化）', rec?.status)
  ok(rec && typeof rec.incoming === 'string' && rec.incoming.includes('自动做梦想写的新内容'),
    '留下了**我们想写的那一版**（判冲突要看两边）')
  ok(rec && typeof rec.onDisk === 'string' && rec.onDisk.includes('盘上这一版'),
    '也留下了**盘上那一版**（只有一边等于没得判）')
  ok(rec && rec.tool === 'write_memory', '记下是谁在写', rec?.tool)
  ok(rec && typeof rec.id === 'string' && rec.id.length > 0, '有 id')
}

// ═══ 2. 别的写失败不该冒充冲突 ═══
group('2. 非版本过期的失败不落冲突')
{
  const before = readConflicts().length
  const { result, threw } = await attempt('boom', { readFirst: true })
  // 工具运行器会把异常转成给模型看的错误字符串（这是对的：模型要看到原因，不是整轮崩掉），
  // 所以判「浮出来了」而不是判「抛出来了」。
  const surfaced = !!threw || (typeof result === 'string' && !result.startsWith('已写入'))
  ok(surfaced, '磁盘满如实浮出来（被冲突记录吞掉才是最糟的）', JSON.stringify({ threw: threw?.code, result }))
  ok(readConflicts().length === before, '磁盘满**不**记成冲突（那是环境问题，不是两个人抢同一份记忆）')
}

// ═══ 3. 成功路径一个字都不该多 ═══
group('3. 成功路径不产生副作用')
{
  const before = readConflicts().length
  const { result, threw } = await attempt('ok', { readFirst: true })
  ok(!threw && typeof result === 'string' && result.startsWith('已写入'), '走宿主写入成功', JSON.stringify(result))
  ok(readConflicts().length === before, '成功时不落冲突记录')
}

// ═══ 4. 没有 fs 服务时走回落，行为与从前一致 ═══group('4. 宿主没有 fs → 回落本地原子写（既不落冲突也不报错）')
{
  const before = readConflicts().length
  const { result, threw } = await attempt(null)
  ok(!threw && typeof result === 'string' && result.startsWith('已写入'), '回落路径写入成功', JSON.stringify(result))
  ok(readConflicts().length === before, '回落路径不落冲突记录')
  ok(readFileSync(MEM, 'utf8').includes('自动做梦想写的新内容'), '内容真的落盘了')
}

// ═══ 5. 守卫**真的传出去了**（这一组是补一个真实盲点） ═══
group('5. 写入时必须自己带上版本守卫')
{
  // 为什么单独一组：初版实现调的是 `writeText(target, content)` —— **没传 expected**。
  // 而 `fs/write-intent` 只为「工具发起」的写入派发，插件自己写时一次都不发，
  // 所以那条路**完全不设防**，冲突记录在生产里根本不可达。
  // 更糟的是当时的假 writeText 无条件抛错，**没验证 expected 传没传**，套件全绿却漏掉了它。
  // 现在假 fs 记录 `expected`，这组断言钉死它。
  // ⚠️ 这一组是**替换**掉旧的「文件存在 → 传当前版本」断言 —— 旧断言编码的正是复审者 R01
  // 指出的缺陷（拿写时的版本当守卫）。现在契约是「没读过就不许覆盖」。
  const { result, seen } = await attempt('ok')
  ok(seen.expected === 'NOT_CALLED', '**没有**发起写入（没读过就不盲写）', JSON.stringify(seen.expected))
  ok(typeof result === 'string' && !result.startsWith('已写入'), '如实拒绝，不谎报成功', String(result).slice(0, 70))
}
{
  const { seen } = await attempt('ok', { fileAbsent: true })
  ok(seen.expected && seen.expected.kind === 'createIfAbsent',
    '文件不存在 → createIfAbsent（新建不受影响）', JSON.stringify(seen.expected))
}
{
  // stat 抛错 = **不知道盘上是什么**。不知道就不写，而不是「不传守卫让宿主随便写」。
  const { seen } = await attempt('ok', { statThrows: true })
  ok(seen.expected === 'NOT_CALLED', 'stat 抛错 → 不写（拿不准就不碰）', JSON.stringify(seen.expected))
}

// ═══ 6. 读时版本绑定（外部复审 R01，P1 数据丢失） ═══
group('6. 守卫必须是「读到内容那一刻」的版本，不是「现在」的版本')
{
  // 复审者的反例：读 A → 人工改成 B → 自动整理基于 A 生成 C → 写时 stat 拿到 B 的版本
  // → 守卫通过 → **B 被覆盖**。危险窗口是 `读 → 生成 → 写`，不是 `stat → writeText`。
  // 下面这个假宿主**真的按内容哈希比较 CAS**，不是一个无条件成功或无条件报错的桩。
  const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
  // ⚠️ 契约里 stat / readText 收的是 **FsTarget 对象**（不是路径字符串）。这里统一解一层，
  // 免得类型不匹配抛出来的错被误当成「守卫生效」——初版就这么假通过过一次。
  const pathOf = (p) => (p && typeof p === 'object' ? p.displayPath : p)
  function liveHost(state) {
    return {
      resolve: async (p) => ({ targetKey: 'k:' + p, displayPath: p }),
      stat: async (p) => {
        const s = await readFile(pathOf(p), 'utf8').catch(() => null)
        return s === null ? undefined : { version: hash(s), type: 'file' }
      },
      readText: (p) => readFile(pathOf(p), 'utf8'),
      writeText: async (p, content, expected) => {
        const file = pathOf(p)
        const old = await readFile(file, 'utf8').catch(() => null)
        state.seen.push(expected)
        if (expected?.kind === 'replaceIfVersion' && expected.version !== hash(old ?? '')) {
          const e = new Error('file changed since it was read')
          e.code = 'FS_STALE_VERSION'
          throw e
        }
        if (expected?.kind === 'createIfAbsent' && old !== null) {
          const e = new Error('already exists')
          e.code = 'FS_EXISTS'
          throw e
        }
        await writeFile(file, content, 'utf8')
        return { operation: old === null ? 'create' : 'update', version: hash(content), before: old, after: content }
      },
    }
  }
  const liveCtx = (state) => ({ get: (n) => (n === 'fs' ? liveHost(state) : undefined), logger: { warn: () => {} } })
  const runnerWith = (state) => createToolRunner({ memoryDir: memDir, sessionsRoot: '', apply: true, withSessions: false, ctx: liveCtx(state) })

  // ① 读过之后别人改了 → 必须拒绝，人工内容保住
  {
    rmSync(CONFLICTS_DIR, { recursive: true, force: true })
    seed()
    const state = { seen: [] }
    const runner = runnerWith(state)
    const read = await runner.run('read_memory', { file: 'project_alpha.md' })
    ok(typeof read === 'string' && read.includes('盘上这一版'), '先真的读到了 A 版', String(read).slice(0, 40))
    writeFileSync(MEM, '---\nname: project_alpha\ntype: project\n---\n\n人工新增的重要内容\n', 'utf8')
    const res = await runner.run('write_memory', { file: 'project_alpha.md', content: body, reason: '基于读到的那版改写' })
    const onDisk = readFileSync(MEM, 'utf8')
    ok(onDisk.includes('人工新增的重要内容'), '**人工新增的内容没有被覆盖**（这是 R01 的要害）', onDisk.slice(-30))
    ok(typeof res === 'string' && !res.startsWith('已写入'), '写入被拒绝而不是谎报成功', String(res).slice(0, 60))
    ok(state.seen[0]?.kind === 'replaceIfVersion', '传出去的是 replaceIfVersion 守卫', JSON.stringify(state.seen[0]?.kind))
    const conflicts = readConflicts()
    ok(conflicts.some((c) => c.kind === 'stale_version' && c.status === 'open'),
      '落成了一条待人工处理的冲突记录', JSON.stringify(conflicts.map((c) => c.kind)))
  }

  // ② 没读过的既有文件 → 不许盲写（以前会拿当前版本当守卫，等于替调用方担保）
  {
    rmSync(CONFLICTS_DIR, { recursive: true, force: true })
    seed()
    const state = { seen: [] }
    const res = await runnerWith(state).run('write_memory', { file: 'project_alpha.md', content: body, reason: '没读就改' })
    ok(!readFileSync(MEM, 'utf8').includes('自动做梦想写的新内容'), '没读过就不许覆盖（内容没变）')
    ok(typeof res === 'string' && !res.startsWith('已写入'), '如实拒绝', String(res).slice(0, 70))
    ok(readConflicts().length >= 1, '这次拒绝也留了一条记录（人能看到它想写什么）')
  }

  // ③ 反向对照：读过且没人改 → 正常更新必须成功（别把门做成永远关着）
  {
    const state = { seen: [] }
    const runner = runnerWith(state)
    await runner.run('read_memory', { file: 'project_alpha.md' })
    const res = await runner.run('write_memory', { file: 'project_alpha.md', content: body, reason: '正常更新' })
    ok(typeof res === 'string' && res.startsWith('已写入'), '读过且版本没变 → 正常写入成功', String(res).slice(0, 50))
    ok(readFileSync(MEM, 'utf8').includes('自动做梦想写的新内容'), '内容真的落盘了')
  }

  // ④ 反向对照：新建（文件本来不存在）必须成功
  {
    const state = { seen: [] }
    const res = await runnerWith(state).run('write_memory', { file: 'brand_new.md', content: body, reason: '新建' })
    ok(typeof res === 'string' && res.startsWith('已写入'), '新建不受影响', String(res).slice(0, 50))
    ok(state.seen[0]?.kind === 'createIfAbsent', '新建走 createIfAbsent', JSON.stringify(state.seen[0]?.kind))
  }
}

rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
