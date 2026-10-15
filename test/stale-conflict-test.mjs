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

const { createToolRunner } = await import(new URL('../lib/autodream-tools.js', import.meta.url).href)

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
function makeCtx(mode) {
  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    effect: () => {},
    on: () => {},
  }
  if (mode === null) return ctx
  ctx.get = (name) => {
    if (name !== 'fs') return undefined
    return {
      resolve: async (p) => ({ targetKey: 'k:' + p, displayPath: p }),
      stat: async () => ({ version: 'fsv:current', type: 'file' }),
      readText: async () => '盘上这一版\n',
      writeText: async () => {
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

/** 跑一次写入；返回 `{result, threw}` —— 两种失败表达都要能观察。 */
async function attempt(mode) {
  seed()
  const runner = createToolRunner({ memoryDir: memDir, sessionsRoot: '', apply: true, withSessions: false, ctx: makeCtx(mode) })
  try {
    return { result: await runner.run('write_memory', { file: 'project_alpha.md', content: body, reason: '合并重复段落' }), threw: null }
  } catch (err) {
    return { result: null, threw: err }
  }
}

// ═══ 1. 版本过期 → 落一条冲突，且不谎报成功 ═══
group('1. FS_STALE_VERSION → 一条待判定的冲突记录')
{
  const before = readConflicts().length
  const { result, threw } = await attempt('stale')
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
  const { result, threw } = await attempt('boom')
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
  const { result, threw } = await attempt('ok')
  ok(!threw && typeof result === 'string' && result.startsWith('已写入'), '走宿主写入成功', JSON.stringify(result))
  ok(readConflicts().length === before, '成功时不落冲突记录')
}

// ═══ 4. 没有 fs 服务时走回落，行为与从前一致 ═══
group('4. 宿主没有 fs → 回落本地原子写（既不落冲突也不报错）')
{
  const before = readConflicts().length
  const { result, threw } = await attempt(null)
  ok(!threw && typeof result === 'string' && result.startsWith('已写入'), '回落路径写入成功', JSON.stringify(result))
  ok(readConflicts().length === before, '回落路径不落冲突记录')
  ok(readFileSync(MEM, 'utf8').includes('自动做梦想写的新内容'), '内容真的落盘了')
}

rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
