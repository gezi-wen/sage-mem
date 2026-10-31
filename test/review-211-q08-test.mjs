#!/usr/bin/env node
/**
 * review-211-q08-test.mjs — Q08（外部审查 2.1.1）：被去重的轮次不更新观测计数。
 *
 * 症状：`messageCount` 记的是「上一次**见效**时」的条数，只在有内容提交时更新。
 * 2 条时注入过 → 涨到 20 条但同题被去重（不提交）→ 压缩到 10 条再问：压缩判定比较的
 * 是 10 与 2 而不是 10 与刚观测到的 20，于是判定「没压缩」，签名没清、继续去重、不注入。
 *
 * 修法把两本账拆开：`lastObservedMessageCount` 每次 assemble **先**推进（观测是既成事实），
 * `messageCount`（delivered）只在真的投递后前进；压缩判定对着观测账比。
 *
 * 边界（作者已声明，本版不越界）：**条数不降的压缩仍不可识别**，需要宿主给出上下文代次。
 *
 * 用法: node test/review-211-q08-test.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const HERE = fileURLToPath(new URL('.', import.meta.url))
const LIB = join(HERE, '..', 'lib')
const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-q08-'))
const mem = join(sandbox, 'memory')
mkdirSync(mem, { recursive: true })
process.env.SAGE_MEM_DIR = mem
process.env.DSH_HOME = join(sandbox, 'dsh')
delete process.env.SAGE_MEM_DEBUG

const { createRecallInjector, createSessionInjectState } = await import(pathToFileURL(join(LIB, 'recall', 'index.js')).href)

writeFileSync(join(mem, 'a.md'),
  '---\nname: audit\ndescription: quartz nebula\ntype: project\n---\nquartz nebula 的正文\n', 'utf8')

/**
 * 最小 harness：第 n 个「消息总数」的一步，问同一句话（或给定问题）。
 * 返回这一步是否真的注入了上下文。**不调 next 之外的东西**，与 repro 同构。
 */
function makeHarness(sessionId) {
  const state = createSessionInjectState()
  const injector = createRecallInjector({
    ctx: { logger: { warn() {} } },
    state,
    tools: { ready: () => false },
  })
  const step = async (n, question = 'quartz nebula') => {
    const msgs = Array.from({ length: n }, () => ({
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: question }],
    }))
    const out = await injector({}, { agent: { session: { id: sessionId, deriveMessages: () => msgs } } }, async () => ({}))
    return Array.isArray(out.contexts) && out.contexts.length > 0
  }
  return { state, step }
}

// ═══ 1. 主判据：2 → 20（去重，不提交）→ 10 ═══
group('1. 2 条注入后涨到 20 条被去重，压缩到 10 条再问 → 必须重新注入')
{
  const h = makeHarness('compaction')
  const first = await h.step(2)
  ok(first === true, '2 条时成功注入（前置）')
  const at20 = await h.step(20)
  ok(at20 === false, '20 条时同题被去重、不重复注入（去重仍然生效，不是把去重关掉）')
  const at10 = await h.step(10)
  ok(at10 === true,
    '压缩到 10 条后同题**重新注入**（修前 false：压缩判定拿 10 比 2，不是比 20）')
}

// ═══ 2. 观测账与投递账拆开：没有投递的轮次也必须推进观测 ═══
group('2. 状态机：零命中 / 预算拒绝这类「不提交」的轮次，观测条数照样前进')
{
  const st = createSessionInjectState()
  st.begin('s', 2)
  st.commit('s', { signature: 'sig', contentBytes: 100, cardBytes: 50, cardSig: 'card', gapCard: 'gap', messageCount: 2, baselineDone: true })
  // 18 条这一轮：假设零命中 / 预算拒绝 → **不调 commit**（真实注入链在这些出口直接 return）
  const observed = st.begin('s', 18)
  ok(observed.signature === 'sig', '不提交的轮次不会清掉已投递的签名（去重状态还在）')
  const shrunk = st.begin('s', 7)
  ok(shrunk.generationChanged === true,
    '7 条 < **上一次观测到的** 18 条 → 判定压缩（修前比的是 2 条投递账，判不出来）')
  ok(shrunk.signature === null && shrunk.contentBytes === 0 && shrunk.cardBytes === 0 &&
    shrunk.cardSig === '' && shrunk.baselineDone === false && shrunk.messageCount === -1,
    '压缩后签名 / 正文账 / 卡账 / 卡签名 / baseline / 投递账一起归零（少清一样都会留下上一代的真相）',
    JSON.stringify(shrunk))

  // 反向对照 1：条数不降（18 → 19）不算压缩
  const st2 = createSessionInjectState()
  st2.begin('x', 2)
  st2.commit('x', { signature: 'sig2', messageCount: 2 })
  st2.begin('x', 18)
  ok(st2.begin('x', 19).generationChanged === false, '【反向对照】18 → 19 条数未降，不判压缩')
  ok(st2.begin('x', 19).signature === 'sig2', '未降时签名保留（去重不会被误清）')

  // 反向对照 2：**连续两次**不提交的观测也不能漏掉（每次都推进）
  const st3 = createSessionInjectState()
  st3.begin('y', 2)
  st3.commit('y', { signature: 'sig3', messageCount: 2 })
  st3.begin('y', 12)   // 第一次零命中（不提交）
  st3.begin('y', 40)   // 第二次预算拒绝（不提交）
  ok(st3.begin('y', 15).generationChanged === true,
    '【反向对照】观测基数必须取**最近一次**（40），而不是第一次（12）：15 < 40 才算压缩')
}

// ═══ 3. 真正的零命中轮次（端到端）：缩短仍要被识别 ═══
group('3. 端到端：中间夹一轮零命中（不提交），之后的缩短照样重新注入')
{
  const h = makeHarness('zero-hit')
  ok((await h.step(2)) === true, '2 条时注入（前置）')
  const zero = await h.step(18, 'zzzz yyyy wwww')
  ok(zero === false, '18 条时问一个零命中的问题 → 一个字都不注（这一步不会 commit）')
  const after = await h.step(9)
  ok(after === true, '缩短到 9 条后问原题 → 重新注入（观测账在零命中那轮已经推进到 18）')
}

// ═══ 4. 未缩短时同题仍被抑制；不同会话互不串账 ═══
group('4. 未缩短 → 同题仍抑制；A 的压缩不影响 B（不串会话）')
{
  const a = makeHarness('session-A')
  const b = makeHarness('session-B')
  ok((await a.step(2)) === true, 'A：2 条时注入（前置）')
  ok((await a.step(20)) === false, 'A：20 条同题仍被去重（未压缩）')
  ok((await a.step(21)) === false, 'A：21 条同题仍被去重（条数只增不减）')
  ok((await b.step(5)) === true, 'B：另一个会话第一次问同一题 → 照常注入（会话账各记各的）')
  ok((await b.step(30)) === false, 'B：30 条同题被去重')
  ok((await b.step(8)) === true, 'B：压缩到 8 条 → B 重新注入')
  ok((await a.step(22)) === false,
    'A：B 的压缩不影响 A 的签名（串会话就会让 A 在没有压缩的情况下重复注入）')
}

rmSync(sandbox, { recursive: true, force: true })

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
