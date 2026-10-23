#!/usr/bin/env node
/**
 * recall-debug-test.mjs — 1.7.0「注入调试账」的宿主侧断言。
 *
 * 它守的是三件事：
 *   1. **开关语义**：关着时零记录、零日志；开着时每次尝试恰好一条、字段齐；
 *   2. **数据结构**：环形缓冲上限 8、最新在前、返回的是副本（调用方改不动账）；
 *   3. **不落盘**：账只在内存 —— 跑完注入后记忆目录逐字节不变，状态目录里
 *      也不会多出任何带「问题原文」的文件（调试信息不是记忆）。
 *
 * 注入链本身的行为由 recall-golden-test（11 场景逐字节）与 access-test 守着，
 * 这里**不重复**断言注入文本，只验账。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-debug-'))
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
mkdirSync(memDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
mkdirSync(join(sandbox, 'dsh-home'), { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')
delete process.env.SAGE_MEM_DEBUG
delete process.env.SAGE_MEM_TASK_ID

const LIB = new URL('../lib/', import.meta.url)
const mod = await import(new URL('index.js', LIB).href)
const debugMod = await import(new URL('recall/debug.js', LIB).href)
const { TYPERT } = await import(new URL('typert.host.js', LIB).href)
const MemoryGateway = mod.default

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

function mem(name, { desc = '无描述', body = '正文。' } = {}) {
  const lines = ['---', `name: ${name.replace(/\.md$/, '')}`, `description: ${desc}`, 'metadata:', '  node_type: memory', '  type: reference', '---', '', body]
  writeFileSync(join(memDir, name), lines.join('\n'), 'utf8')
}

/** 假 ctx：cordis Service 构造要 ctx.reflect.*，未知成员给可调用的桩（与 _recall-scenarios 同形）。 */
function makeCtx() {
  const handlers = new Map()
  const base = {
    on: (ev, h) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(h) },
    get: () => undefined,
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    effect: () => {},
    handlers,
  }
  let stub
  stub = new Proxy(function () {}, { get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined), apply: () => undefined })
  return new Proxy(base, { get(t, p) { return p in t ? t[p] : stub } })
}

/** 建一个新网关并把 assemble 监听器取出来。 */
function newGateway() {
  const ctx = makeCtx()
  const gw = new MemoryGateway(ctx)
  const hs = ctx.handlers.get('system-prompt/assemble') || []
  if (!hs.length) throw new Error('没有注册 system-prompt/assemble 监听器')
  return { gw, handler: hs[hs.length - 1] }
}

/** 走一步注入（消息条数默认 1，含本条问题）。 */
async function step(handler, sessionId, question, messageCount = 1) {
  const msgs = []
  for (let i = 0; i < messageCount; i++) msgs.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })
  msgs.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: question }] })
  const session = { id: sessionId, deriveMessages: () => msgs }
  const assembled = {}
  return await handler(assembled, { agent: { session } }, async () => assembled)
}

/** 跑一次并把 console.log 截下来（调试日志会打一行 JSON）。 */
async function runCapturing(handler, sessionId, question, messageCount) {
  const lines = []
  const orig = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    await step(handler, sessionId, question, messageCount)
  } finally {
    console.log = orig
  }
  return lines
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const dirSnapshot = (dir) => Object.fromEntries(
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => [e.name, sha(join(dir, e.name))])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
)

const { gw, handler } = newGateway()
const dbgInvocation = TYPERT.invocations.find((i) => i.id === 'sage-mem#memory/recallDebug')

// ── 1. 开关关着：零记录、零日志 ────────────────────────────────
group('1. SAGE_MEM_DEBUG 关着：零记录、零日志、remote 报 enabled=false')
{
  debugMod.resetRecallDebug()
  mem('project_alpha.md', { desc: '阿尔法项目进度', body: '进度表在别处。' })
  const lines = await runCapturing(handler, 'dbg-off', '阿尔法项目')
  ok(lines.filter((l) => l.includes('[sage-mem] recall')).length === 0, '不开 DEBUG：没有 recall 日志')
  const off = debugMod.readRecallDebug()
  ok(off.enabled === false, 'readRecallDebug().enabled === false')
  ok(off.records.length === 0, '关着时一条记录都不存（缓冲为空）')
  const viaRemote = await gw.recallDebug()
  ok(viaRemote.enabled === false && viaRemote.records.length === 0, 'remote recallDebug() 同样报关且空')
}

// ── 2. 开关打开：一次注入恰好一条完整账 ─────────────────────────
group('2. SAGE_MEM_DEBUG=1：一次注入 → 一条完整账')
let firstRecord = null
{
  process.env.SAGE_MEM_DEBUG = '1'
  debugMod.resetRecallDebug()
  const lines = await runCapturing(handler, 'dbg-on', '阿尔法项目')
  const recallLines = lines.filter((l) => l.includes('[sage-mem] recall'))
  ok(recallLines.length === 1, `开着 DEBUG：恰好一行日志（实际 ${recallLines.length}）`)
  const res = await gw.recallDebug()
  ok(res.enabled === true && res.records.length === 1, `remote 返回 enabled + 1 条记录（实际 ${res.records.length}）`)
  firstRecord = res.records[0]
  const r = firstRecord
  ok(r.sessionId === 'dbg-on', '记录带 sessionId')
  ok(r.query === '阿尔法项目', `记录带问题原文（实际 ${JSON.stringify(r.query)}）`)
  ok(r.outcome === 'injected', 'outcome=injected（这一步真的注进去了）')
  ok(Array.isArray(r.injected) && r.injected.indexOf('project_alpha.md') >= 0, `injected 里有 project_alpha.md（${JSON.stringify(r.injected)}）`)
  ok(r.chars > 0 && r.sessionChars >= r.chars, `正文字节 > 0 且累计 ≥ 单步（${r.chars} / ${r.sessionChars}）`)
  ok(r.scanned >= 1 && r.hits >= 1, `扫到 ${r.scanned} 条、摘要命中 ${r.hits} 条`)
  ok(Array.isArray(r.scores) && r.scores.length >= 1 && r.scores[0].file === 'project_alpha.md' && typeof r.scores[0].score === 'number',
    '摘要得分是 {file, score} 对象数组')
  ok(Array.isArray(r.body) && Array.isArray(r.picked), '正文命中与入选都是数组')
  ok(['sent', 'none', 'deduped-or-over-budget'].indexOf(r.card) >= 0, `card 取值在约定集合内（${r.card}）`)
  ok(typeof r.at === 'number' && typeof r.skippedByBudget === 'number' && typeof r.baseline === 'number',
    'at / skippedByBudget / baseline 都是数字')
  ok(JSON.parse(recallLines[0].slice(recallLines[0].indexOf('{'))) &&
    JSON.parse(recallLines[0].slice(recallLines[0].indexOf('{')))['query'] === '阿尔法项目',
    '控制台的 JSON 行与面板读到的是同一份 payload')
}

// ── 3. 环形缓冲：上限 8、最新在前 ──────────────────────────────
group('3. 环形缓冲上限 8 条，最新在前')
{
  debugMod.resetRecallDebug()
  const questions = ['阿尔法项目', '阿尔法项目二', '阿尔法项目三', '阿尔法项目四', '阿尔法项目五', '阿尔法项目六', '阿尔法项目七', '阿尔法项目八', '阿尔法项目九']
  for (let i = 0; i < questions.length; i++) {
    await runCapturing(handler, 'dbg-ring-' + i, questions[i])
  }
  const res = await gw.recallDebug()
  ok(res.records.length === debugMod.MAX_DEBUG_RECORDS && res.records.length === 8, `最多留 8 条（实际 ${res.records.length}）`)
  ok(res.records[0].query === questions[questions.length - 1], '第一条记录 = 最近一次（最新在前）')
  ok(res.records[1].query === questions[questions.length - 2], '第二条 = 倒数第二次（顺序是倒序）')
  ok(!res.records.some((r) => r.sessionId === 'dbg-ring-0'), '最早那次已被挤出缓冲')
}

// ── 4. 同题第二步：deduped 标记解释「为什么没注入」 ─────────────
group('4. 同题第二步标 deduped（面板据此解释「空」不是坏了）')
{
  debugMod.resetRecallDebug()
  mem('project_beta.md', { desc: '贝塔项目进度', body: '细节。' })
  await runCapturing(handler, 'dbg-dup', '贝塔项目', 1)
  await runCapturing(handler, 'dbg-dup', '贝塔项目', 2)
  const res = await gw.recallDebug()
  ok(res.records.length === 2, `两步两条记录（实际 ${res.records.length}）`)
  const second = res.records[0]
  ok(second.deduped === true, '第二步 deduped=true')
  ok(second.outcome === 'empty' || second.outcome === 'card-only', `第二步 outcome 是 empty/card-only（实际 ${second.outcome}）`)
  ok(second.deduped === true && res.records[1].deduped === false, '第一步没被标 deduped（对照）')
}

// ── 5. 不落盘：记忆目录逐字节不变，状态目录不出现问题原文 ──────
group('5. 账只在内存：不写记忆目录、不带问题原文进状态目录')
{
  const memBefore = dirSnapshot(memDir)
  const stateBefore = dirSnapshot(stateDir)
  await runCapturing(handler, 'dbg-disk', '贝塔项目')
  const memAfter = dirSnapshot(memDir)
  ok(JSON.stringify(memBefore) === JSON.stringify(memAfter), '注入 + 记账后记忆目录逐字节不变')
  const stateAfter = dirSnapshot(stateDir)
  const newFiles = Object.keys(stateAfter).filter((f) => !(f in stateBefore))
  ok(newFiles.every((f) => !/debug|recall/i.test(f)), `状态目录没有新增调试账文件（新增：${newFiles.join(',') || '无'}）`)
  const polluted = Object.keys(stateAfter).filter((f) => {
    try { return readFileSync(join(stateDir, f), 'utf8').indexOf('贝塔项目') >= 0 } catch { return false }
  })
  ok(polluted.length === 0, `状态目录里没有任何文件带问题原文（命中：${polluted.join(',') || '无'}）`)
}

// ── 6. 返回的是副本；关掉开关不清账、也不再增长 ─────────────────
group('6. 返回副本；关掉开关保留历史但不再新增')
{
  const a = await gw.recallDebug()
  const before = a.records[0].query
  a.records[0].query = '篡改'
  a.records.push({ at: 0 })
  const b = await gw.recallDebug()
  ok(b.records[0].query === before, '改返回值不影响内部账（返回的是副本）')
  ok(b.records.length <= debugMod.MAX_DEBUG_RECORDS, '篡改 push 也不会撑大内部缓冲')

  const countBefore = b.records.length
  delete process.env.SAGE_MEM_DEBUG
  await runCapturing(handler, 'dbg-afterswitch', '贝塔项目')
  const c = await gw.recallDebug()
  ok(c.enabled === false, '关掉后 remote 报 enabled=false（面板入口消失）')
  ok(c.records.length === countBefore, `关掉后不再新增记录（${countBefore} → ${c.records.length}）`)
  ok(c.records[0].query === before, '已有历史保留（只是不再记新的）')
}

// ── 7. typert schema 对拍 ──────────────────────────────────────
group('7. typert：manifest 有这条只读 remote，且真实返回值过 strict 校验')
{
  ok(!!dbgInvocation, 'manifest 里有 sage-mem#memory/recallDebug')
  ok(dbgInvocation && dbgInvocation.parameters.length === 0, '无入参（只读）')
  if (dbgInvocation) {
    const off = await gw.recallDebug()
    const r1 = dbgInvocation.result.schema.safeParse(off)
    ok(r1.success, '关着时的返回值过 strict schema', r1.success ? '' : JSON.stringify(r1.error.issues.slice(0, 4)))
    process.env.SAGE_MEM_DEBUG = '1'
    debugMod.resetRecallDebug()
    await runCapturing(handler, 'dbg-schema', '阿尔法项目')
    const on = await gw.recallDebug()
    const r2 = dbgInvocation.result.schema.safeParse(on)
    ok(r2.success, '开着且有记录时的返回值过 strict schema', r2.success ? '' : JSON.stringify(r2.error.issues.slice(0, 4)))
    delete process.env.SAGE_MEM_DEBUG
  }
}

// ── 8. 空目录：也能看（不是「没记忆就没账」）──────────────────
group('8. 零命中同样记一条账（空账本身也是信息）')
{
  process.env.SAGE_MEM_DEBUG = '1'
  debugMod.resetRecallDebug()
  await runCapturing(handler, 'dbg-zero', 'zzz 完全不相干的问句 qqq')
  const res = await gw.recallDebug()
  ok(res.records.length === 1, '零命中也有一条记录（否则面板会看着像没工作）')
  const r = res.records[0]
  ok(r.outcome === 'empty' && r.injected.length === 0, 'outcome=empty 且 injected 为空')
  ok(r.hits === 0, '摘要命中 0 条如实记录')
  delete process.env.SAGE_MEM_DEBUG
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
