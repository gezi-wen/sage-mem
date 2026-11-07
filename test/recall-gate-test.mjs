#!/usr/bin/env node
/**
 * recall-gate-test.mjs — 2.4.3「短路闸门」的断言。
 *
 * 守的是什么：**同样的输入不该被算第二遍**。
 *
 * `system-prompt/assemble` 是**每个 step** 派发的（一个带 10 次工具调用的回合派发 11 次），
 * 而一次注入只在**问题变化**时才有产出。旧实现在每一步都把「扫描 → 摘要打分 → 正文 BM25
 * → 算签名」整条跑完，最后拿签名跟上一比，判重就丢掉结果 —— 第 2 步起那几遍全是空算。
 *
 * 闸门把判据提前：问题文本 + 目录名集合 + baseline 标记 + 冲突队列指纹，四样都在打分**之前**
 * 就拿得到。四条都相同 → 直接返回，不扫内容、不切段、不打分。
 *
 * 但这个优化有三个必须成立的前提，它们才是这个文件真正的断言对象：
 *   1. **不许吞掉该来的注入** —— 换问题、目录变了、压缩归零之后，必须重新注入；
 *   2. **不许跨会话串味** —— 闸门是会话级的；
 *   3. **不许把「没投递」记成「投递过」** —— 与签名同一条纪律（空手而归不 commit）。
 *
 * 用法: node recall-gate-test.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-gate-'))
const memDir = join(sandbox, 'memory')
mkdirSync(memDir, { recursive: true })
mkdirSync(join(sandbox, '.sage-mem'), { recursive: true })
mkdirSync(join(sandbox, 'dsh-home'), { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')
delete process.env.SAGE_MEM_DEBUG
delete process.env.SAGE_MEM_TASK_ID
delete process.env.SAGE_MEM_MAX_SESSION_BYTES

const LIB = new URL('../lib/', import.meta.url)
const mod = await import(new URL('index.js', LIB).href)
const debugMod = await import(new URL('recall/debug.js', LIB).href)
const MemoryGateway = mod.default

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

function mem(name, { desc = '无描述', body = '正文。', baseline = false } = {}) {
  const lines = ['---', `name: ${name.replace(/\.md$/, '')}`, `description: ${desc}`, 'metadata:', '  node_type: memory', '  type: reference']
  if (baseline) lines.push('baseline: true')
  lines.push('---', '', body)
  writeFileSync(join(memDir, name), lines.join('\n'), 'utf8')
}

/** 假 ctx：cordis Service 构造要 ctx.reflect.*，未知成员给可调用的桩（与 recall-debug-test 同形）。 */
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

function newGateway() {
  const ctx = makeCtx()
  const gw = new MemoryGateway(ctx)
  const hs = ctx.handlers.get('system-prompt/assemble') || []
  if (!hs.length) throw new Error('没有注册 system-prompt/assemble 监听器')
  return { gw, handler: hs[hs.length - 1] }
}

/** 走一步注入，返回注入文本（`sage-mem:recall` 那段），没有就是 null。 */
async function step(handler, sessionId, question, messageCount = 1) {
  const msgs = []
  for (let i = 0; i < messageCount; i++) msgs.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })
  msgs.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: question }] })
  const session = { id: sessionId, deriveMessages: () => msgs }
  const assembled = {}
  const out = await handler(assembled, { agent: { session } }, async () => assembled)
  const hit = (out?.contexts ?? []).find((c) => c?.name === 'sage-mem:recall')
  return hit ? hit.text : null
}

mem('project_alpha.md', { desc: '阿尔法项目进度', body: '进度表在别处。' })
mem('project_gamma.md', { desc: '伽马项目进度', body: '伽马的排期见文档。' })
mem('project_delta.md', { desc: '德尔塔项目进度', body: '德尔塔的负责人待定。' })

const { handler } = newGateway()

// ── 1. 同一问题连续三步：只有第一步有产出 ────────────────────────
group('1. 同题连跑三步：第 1 步注入，第 2 / 3 步不注入')
{
  const first = await step(handler, 'gate-same', '阿尔法项目')
  const second = await step(handler, 'gate-same', '阿尔法项目')
  const third = await step(handler, 'gate-same', '阿尔法项目')
  ok(typeof first === 'string' && first.includes('### project_alpha.md'), '第 1 步注入了阿尔法')
  ok(second === null, `第 2 步没有注入（实际 ${second === null ? 'null' : '有文本'}）`)
  ok(third === null, `第 3 步没有注入（实际 ${third === null ? 'null' : '有文本'}）`)
}

// ── 2. 闸门命中时，调试账要能说出「这一步没算」而不是「算了没命中」 ──
group('2. 调试账：第 2 步标 gated，与「算过但没命中」分开')
{
  process.env.SAGE_MEM_DEBUG = '1'
  debugMod.resetRecallDebug()
  await step(handler, 'gate-debug', '伽马项目')
  await step(handler, 'gate-debug', '伽马项目')
  const res = await debugMod.readRecallDebug()
  ok(res.records.length === 2, `两步两条记录（实际 ${res.records.length}）`)
  const first = res.records[1]
  const second = res.records[0]
  ok(first.gated === undefined, '第一步不是 gated（真的算过）')
  ok(first.outcome === 'injected', `第一步 outcome=injected（实际 ${first.outcome}）`)
  ok(second.gated === true, '第二步 gated=true')
  ok(second.deduped === true, '第二步 deduped=true（与旧行为一致）')
  ok(second.outcome === 'empty', `第二步 outcome=empty（实际 ${second.outcome}）`)
  ok(second.scanned === 3, `第二步仍然报出目录份数（实际 ${second.scanned}）`)
  delete process.env.SAGE_MEM_DEBUG
}

// ── 3. 换问题必须重新注入（闸门不许把新问题挡住） ────────────────
group('3. 换问题：闸门失效，重新注入')
{
  const a = await step(handler, 'gate-switch', '阿尔法项目')
  const b = await step(handler, 'gate-switch', '德尔塔项目')
  ok(a !== null && a.includes('### project_alpha.md'), '问题 A 注入阿尔法')
  ok(b !== null && b.includes('### project_delta.md'), '换成问题 B 后注入德尔塔')
  ok(b !== a, '两段文本不同')
}

// ── 4. 目录变了（新增一条相关记忆）必须重新注入 ──────────────────
group('4. 目录名集合变了：指纹失效，同题重新注入')
{
  const before = await step(handler, 'gate-corpus', '艾普西龙项目')
  ok(before === null || !before.includes('### project_epsilon.md'), '此前不存在关于艾普西龙的记忆')
  mem('project_epsilon.md', { desc: '艾普西龙项目进度', body: '艾普西龙在用新流程。' })
  const after = await step(handler, 'gate-corpus', '艾普西龙项目')
  ok(after !== null && after.includes('### project_epsilon.md'), '新增记忆后同题立刻注入了它')
}

// ── 5. 压缩（消息条数下降）必须重新注入 ──────────────────────────
group('5. 压缩归零：条数下降时闸门强制失效')
{
  const s = 'gate-compact'
  const first = await step(handler, s, '阿尔法项目', 5)
  const again = await step(handler, s, '阿尔法项目', 6)
  const compacted = await step(handler, s, '阿尔法项目', 2)
  ok(first !== null, '压缩前第一次注入')
  ok(again === null, '条数继续增长时不重复注入')
  ok(compacted !== null && compacted.includes('### project_alpha.md'), '条数下降后同题重新注入（代次归零）')
}

// ── 6. 闸门是会话级的：A 会话的短路不许影响 B 会话 ───────────────
group('6. 跨会话隔离')
{
  const a1 = await step(handler, 'gate-sess-a', '德尔塔项目')
  const a2 = await step(handler, 'gate-sess-a', '德尔塔项目')
  const b1 = await step(handler, 'gate-sess-b', '德尔塔项目')
  ok(a1 !== null && a2 === null, 'A 会话：第一步注入、第二步被挡住')
  ok(b1 !== null && b1.includes('### project_delta.md'), 'B 会话同样的问题照常注入（闸门没有跨会话串味）')
}

// ── 7. baseline：空手而归的轮次不许把闸门关上 ────────────────────
group('7. baseline 与「没投递就不 commit」')
{
  const s = 'gate-baseline'
  const withBaseline = await step(handler, s, '没有任何关键词的问题')
  ok(withBaseline === null, '没有 baseline、没有命中 → 这一步空手而归')
  mem('user_base.md', { desc: '我是谁', body: '我叫某某。', baseline: true })
  // 上一轮空手而归，闸门**不该**前进 —— 加了 baseline 之后必须能立刻进来。
  const after = await step(handler, s, '没有任何关键词的问题')
  ok(after !== null && after.includes('### user_base.md'), '上一轮没投递 → 闸门没关 → 新增的 baseline 立刻注入')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
