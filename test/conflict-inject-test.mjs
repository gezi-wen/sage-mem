#!/usr/bin/env node
/**
 * conflict-inject-test.mjs — 2.0.0 注入侧的端到端断言（2026-10-27 建）
 *
 * 它守的是这一版**唯一会改变用户看到什么**的那条链：
 *   失效（`invalid_at` 到点）与未裁决矛盾（`contradiction`）→ 不进正文；
 *   写失败型冲突（`stale_version` 等）→ **照常注入**（反向对照，D27 的教训）；
 *   被抑制时状态卡必须说得出「另有 N 条矛盾待裁决」；
 *   `SAGE_MEM_VALIDITY=0` 立刻回到 1.9.2 的行为。
 *
 * 为什么单开一个套件：`recall-golden-test` 的 11 个场景守的是「普通路径逐字节不变」，
 * 它里面没有失效件、也没有冲突记录 —— 新规则第一次真正影响注入就是在这些输入上。
 * 那个套件全绿 + 这个套件全绿，才算「普通路径没变、新路径按承诺生效」。
 *
 * 三个坑与 `inject-test.mjs` 相同：环境变量必须在动态 import 之前设；本文件只在
 * 系统临时目录里造记忆；每个场景用不同 sessionId（注入账本按会话记）。
 *
 * 用法: node conflict-inject-test.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

// ── 沙箱：环境变量必须在 import 之前设好 ──────────────────────
const sandbox = join(tmpdir(), 'sage-mem-conflict-inject-' + process.pid)
const memDir = join(sandbox, 'memory')
const stateRoot = join(sandbox, '.sage-mem')
mkdirSync(memDir, { recursive: true })
mkdirSync(stateRoot, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateRoot
process.env.DSH_HOME = join(sandbox, 'dsh-home')
delete process.env.SAGE_MEM_VALIDITY

const MOD = new URL('../lib/index.js', import.meta.url).href
const mod = await import(MOD)
const MemoryGateway = mod.default
const { buildConflict, writeConflict, listConflicts, removeConflict, listConflictIndex } = await import(
  new URL('../lib/memory/conflicts.js', import.meta.url).href
)
const { decideDelivery } = await import(new URL('../lib/memory/deliver.js', import.meta.url).href)
const { composeDelivery, composeStatus } = await import(new URL('../lib/recall/compose.js', import.meta.url).href)
const { renderStatusCard } = await import(new URL('../lib/memory/status.js', import.meta.url).href)

// ── 造记忆 ───────────────────────────────────────────────────
function resetDir() {
  rmSync(memDir, { recursive: true, force: true })
  mkdirSync(memDir, { recursive: true })
  // 冲突队列也要清：各场景共用同一个状态根，不清就会把上一组记录的「待裁决条数」
  // 带进下一组的状态卡（第一版测试就在这儿红过一次，不是实现的问题）。
  rmSync(join(stateRoot, 'conflicts'), { recursive: true, force: true })
}

/**
 * 写一条记忆。`invalid_at` 只在传了的时候出现 —— 这一字段的有无就是「老库」与「新库」的分界。
 */
function mem(name, opts = {}) {
  const { invalidAt, body, desc = 'sagebound' } = opts
  const lines = [
    '---',
    `name: ${name.replace(/\.md$/, '')}`,
    `description: ${desc}`,
    'metadata:',
    '  node_type: memory',
    '  type: project',
  ]
  if (invalidAt) lines.push(`invalid_at: ${invalidAt}`)
  lines.push('---', '', body ?? 'sagebound 正文')
  writeFileSync(join(memDir, name), lines.join('\n'), 'utf8')
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()
const DAY = 86400000

// ── 假运行环境（照 inject-test.mjs 的写法）───────────────────
function makeCtx() {
  const handlers = new Map()
  const warns = []
  const base = {
    on: (ev, h) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(h) },
    get: () => undefined,
    logger: { warn: (m) => warns.push(String(m)), error: () => {}, info: () => {}, debug: () => {} },
    effect: () => {},
    handlers,
    warns,
  }
  let stub
  stub = new Proxy(function () {}, {
    get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined),
    apply: () => undefined,
  })
  return new Proxy(base, {
    get(t, p) { return p in t ? t[p] : stub },
  })
}

function newGateway() {
  const ctx = makeCtx()
  const gw = new MemoryGateway(ctx)
  const hs = ctx.handlers.get('system-prompt/assemble') || []
  if (!hs.length) throw new Error('没有注册 system-prompt/assemble 监听器')
  return { gw, ctx, handler: hs[hs.length - 1] }
}

async function step(handler, sessionId, question) {
  const msgs = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: question }] },
  ]
  const session = { id: sessionId, deriveMessages: () => msgs }
  const assembled = {}
  const out = await handler(assembled, { agent: { session } }, async () => assembled)
  return (out?.contexts ?? []).find((c) => c?.name === 'sage-mem:recall')?.text ?? null
}

/** 注入文本里是否真的有一条正文（`### <file>` 标题是正文段落的唯一入口）。 */
const injectedBody = (text, file) => typeof text === 'string' && text.includes(`### ${file}`)
const hasConflictNotice = (text) => typeof text === 'string' && /另有 \d+ 条矛盾待裁决/.test(text)

// ═══ 1. 未裁决矛盾：两方都不进正文，且状态卡说得出条数 ═══
group('1. 未裁决矛盾 → 两方不进正文 + 状态卡可见')
{
  resetDir()
  mem('project_old.md', { body: 'sagebound 旧说法：部署在 A' })
  mem('project_new.md', { body: 'sagebound 新说法：部署在 B' })
  const rec = buildConflict({
    kind: 'contradiction',
    file: 'project_old.md',
    otherFile: 'project_new.md',
    incoming: 'sagebound 新说法：部署在 B',
    onDisk: 'sagebound 旧说法：部署在 A',
    note: '部署位置两种说法',
    at: iso(),
  })
  const written = await writeConflict(rec, { stateRoot })
  ok(written.ok === true, '夹具：矛盾记录已落盘', JSON.stringify(written))
  mem('project_live.md', { body: 'sagebound 与冲突无关的一条' })

  const { handler } = newGateway()
  const text = await step(handler, 's-contradiction', 'sagebound 部署在哪')

  ok(typeof text === 'string', '这一步仍然有注入（状态卡而不是完全静默）')
  ok(!injectedBody(text, 'project_old.md'), '旧说法（record.file）不进正文')
  ok(!injectedBody(text, 'project_new.md'), '新说法（record.otherFile）也不进正文')
  ok(injectedBody(text, 'project_live.md'), '同一问题下的无关记忆照常注入（不是整轮停摆）')
  ok(hasConflictNotice(text), '状态卡写明「另有 N 条矛盾待裁决」', text)

  const listed = await listConflicts({ stateRoot })
  ok(listed.ok && listed.items.some((i) => i.kind === 'contradiction'), '记录仍是 open（注入侧只读不改）')
}

// ═══ 2. 反向对照：写失败型冲突**不**抑制 ═══
group('2. 反向对照：stale_version 记录存在时照常注入')
{
  resetDir()
  mem('project_normal.md', { body: 'sagebound 盘上那份才是现行版本' })
  const rec = buildConflict({
    kind: 'stale_version',
    file: 'project_normal.md',
    expectedVersion: 'v-old',
    actualVersion: 'FS_STALE_VERSION',
    incoming: 'sagebound 想写进去的版本',
    onDisk: 'sagebound 盘上那份才是现行版本',
    note: '写失败型：盘上那份没变',
    at: iso(),
  })
  await writeConflict(rec, { stateRoot })

  const { handler } = newGateway()
  const text = await step(handler, 's-stale', 'sagebound 现在用哪版')
  ok(injectedBody(text, 'project_normal.md'), '写失败型记录不会让盘上那份退出注入（D27 的教训）')
  ok(!hasConflictNotice(text), '写失败型记录也不该触发「矛盾待裁决」那句话')
}

// ═══ 3. 失效：invalid_at 到点不进正文；未来时间暂不失效 ═══
group('3. invalid_at 到点不进正文，未来时间暂不失效')
{
  resetDir()
  mem('project_expired.md', { body: 'sagebound 旧口径已经作废', invalidAt: iso(-2 * DAY) })
  mem('project_future.md', { body: 'sagebound 未来才作废', invalidAt: iso(2 * DAY) })
  const { handler } = newGateway()
  const text = await step(handler, 's-expired', 'sagebound 口径是什么')
  ok(!injectedBody(text, 'project_expired.md'), 'invalid_at 已到点 → 不进正文')
  ok(injectedBody(text, 'project_future.md'), 'invalid_at 在未来 → 本轮仍生效（暂不失效）')
}

// ═══ 4. 规则顺序：既过期又有冲突 → expired 优先（deliver 既有顺序） ═══
group('4. 规则顺序：过期优先于冲突（deliver.js 一行不改的证据）')
{
  const base = { id: 'x', revision: '', score: 1, baseline: false, lines: null, title: '', text: '### a.md\n正文' }
  const d = decideDelivery(
    [{ ...base, file: 'a.md' }],
    { intent: 'normal', visibleRevisions: new Set(), scopeDenied: new Set(), conflicts: new Set(['a.md']), expired: new Set(['a.md']), needle: '' },
    { bytes: 1024 * 1024 },
  )
  const item = d.items[0]
  ok(item && item.kind === 'unresolved', '被两个集合同时命中时判为 unresolved', JSON.stringify(item))
  ok(item && item.reason === 'expired_source', '理由是 expired_source（规则 3 先于规则 4）', String(item?.reason))
  const d2 = decideDelivery(
    [{ ...base, file: 'a.md' }],
    { intent: 'normal', visibleRevisions: new Set(), scopeDenied: new Set(), conflicts: new Set(['a.md']), expired: new Set(), needle: '' },
    { bytes: 1024 * 1024 },
  )
  ok(d2.items[0]?.reason === 'conflict_pending', '只有冲突时理由是 conflict_pending', String(d2.items[0]?.reason))
}

// ═══ 5. 状态卡：条数进签名、512 字节上限、没冲突时一个字不多加 ═══
group('5. 状态卡：条数与预算')
{
  const none = renderStatusCard({ scanned: 3, injected: 1, unread: 0, omitted: 0 })
  ok(none === '', '没有缺口也没有冲突 → 不发卡（老行为逐字不变）', none)

  const only = renderStatusCard({ scanned: 3, injected: 1, unread: 0, omitted: 0, pendingConflicts: 2 })
  ok(/另有 2 条矛盾待裁决/.test(only), '只有冲突（没有缺口）也要发卡，且条数正确', only)
  ok(Buffer.byteLength(only, 'utf8') <= 512, '卡不超过 512 字节', String(Buffer.byteLength(only, 'utf8')))

  const both = renderStatusCard({
    scanned: 9, injected: 0, unread: 4, omitted: 2, pendingConflicts: 3,
    best: { file: 'project_x.md', title: '一条线索' }, needle: '的问题', toolsAvailable: true, memoryDir: 'D:\\记忆',
  })
  ok(/另有 3 条矛盾待裁决/.test(both) && /尚未读|还没读|候选/.test(both), '有缺口时两件事都在卡里', both)
  ok(Buffer.byteLength(both, 'utf8') <= 512, '两张话合起来仍不超过 512 字节', String(Buffer.byteLength(both, 'utf8')))

  const changed = renderStatusCard({ scanned: 3, injected: 1, unread: 0, omitted: 0, pendingConflicts: 3 })
  ok(changed !== only, '条数变了 → 文本变（签名去重才发得出第二封）')

  const noBody = composeStatus({
    files: [], selected: [], bodyRanked: [], bodySearched: false, text: 'x', parts: [], injectedFiles: [],
    skippedForBudget: 0, deduped: false, st: { cardSig: '', cardBytes: 0 }, toolsReady: true,
    checkpointLine: '', memoryDir: 'D:\\记忆', intentHistoryDependent: false, pendingConflicts: 1,
  })
  ok(noBody.cardPart && /矛盾待裁决/.test(noBody.cardPart), '正文为空也要发卡（injector 的出口条件因此可走到）', noBody.cardPart)
}

// ═══ 6. 总开关 SAGE_MEM_VALIDITY=0 回到 1.9.2 的行为 ═══
group('6. 总开关：SAGE_MEM_VALIDITY=0 关闭失效过滤与矛盾抑制')
{
  resetDir()
  mem('project_off_old.md', { body: 'sagebound 关闭开关时仍注入', invalidAt: iso(-2 * DAY) })
  const rec = buildConflict({
    kind: 'contradiction',
    file: 'project_off_old.md',
    otherFile: 'project_off_new.md',
    incoming: 'sagebound 新', onDisk: 'sagebound 旧', note: '开关测试', at: iso(),
  })
  await writeConflict(rec, { stateRoot })
  mem('project_off_new.md', { body: 'sagebound 新' })

  process.env.SAGE_MEM_VALIDITY = '0'
  const { handler } = newGateway()
  const off = await step(handler, 's-switch-off', 'sagebound 关闭开关')
  delete process.env.SAGE_MEM_VALIDITY
  ok(injectedBody(off, 'project_off_old.md'), '关闭后：带 invalid_at 的记忆照常注入')
  ok(injectedBody(off, 'project_off_new.md'), '关闭后：矛盾两方照常注入')
  ok(!hasConflictNotice(off), '关闭后：状态卡不再提矛盾')

  // 打开（未设）：同一个目录、同一条记录 —— 行为必须反过来。
  const { handler: h2 } = newGateway()
  const on = await step(h2, 's-switch-on', 'sagebound 关闭开关')
  ok(!injectedBody(on, 'project_off_old.md') && !injectedBody(on, 'project_off_new.md'), '打开后：矛盾两方都不进正文')
}

// ═══ 7. 清理：记录删除后恢复注入（撤销路径的下游证据） ═══
group('7. 删除记录后恢复注入')
{
  const listed = await listConflicts({ stateRoot })
  for (const item of listed.items ?? []) await removeConflict(item.id, { stateRoot })
  const { handler } = newGateway()
  const text = await step(handler, 's-after-remove', 'sagebound 关闭开关')
  // 只断言「矛盾抑制解除」：`project_off_old.md` 的 `invalid_at` 还在，仍然由**失效**这条
  // 规则挡着 —— 两套机制独立，删记录不该顺带复活一条已标失效的记忆。
  ok(injectedBody(text, 'project_off_new.md'), '记录删掉后：矛盾一方重新参与注入')
  ok(!injectedBody(text, 'project_off_old.md'), '已标 invalid_at 的那条仍被失效规则挡住（两套机制独立）')
  ok(!hasConflictNotice(text), '没有 open 矛盾 → 不再发那句提示')
}

// ═══ 8. 工具面：失效记忆仍可搜到 / 读到，但结果必须带失效标记 ═══
group('8. search_memory / read_memory 带出失效标记（D29 Q3）')
{
  resetDir()
  mem('project_tool_old.md', { body: 'sagebound 工具面旧口径', invalidAt: iso(-DAY), desc: 'sagebound 工具面' })
  mem('project_tool_now.md', { body: 'sagebound 工具面现行口径', desc: 'sagebound 工具面' })
  const { createMemoryTools } = await import(new URL('../lib/tools/memory-tools.js', import.meta.url).href)
  const tools = createMemoryTools(makeCtx())
  const searched = await tools.searchMemory.execute({ query: 'sagebound 工具面' }, { agent: { id: 's-tool' } })
  const searchText = (tools.searchMemory.output.render({}, searched) ?? []).map((b) => b.text).join('\n')
  ok(/project_tool_old\.md/.test(searchText), '失效记忆**仍然**能被搜到（问历史时旧口径是证据）', searchText)
  ok(/已失效/.test(searchText), '搜索结果里把失效标出来（不让模型把旧口径当现状）', searchText)

  const read = await tools.readMemory.execute({ name: 'project_tool_old.md' })
  const readText = (tools.readMemory.output.render({}, read) ?? []).map((b) => b.text).join('\n')
  ok(read.ok !== false, '失效记忆仍然读得到', JSON.stringify(read && { ok: read.ok, code: read.code }))
  ok(/已失效/.test(readText), '读取页头写明已失效', readText)
  ok(read.expired === true, '读结果里带 expired=true（机读字段，不只靠文案）')
}

// ═══ 9. 注入侧的摘要索引：不带正文、自己写完立刻失效 ═══
group('9. listConflictIndex：轻量摘要 + 写入后立即失效')
{
  resetDir()
  const empty = await listConflictIndex({ stateRoot })
  ok(empty.ok === true && empty.items.length === 0, '清空后索引为空')

  const rec = buildConflict({
    kind: 'contradiction', file: 'i_old.md', otherFile: 'i_new.md',
    incoming: 'x'.repeat(2000), onDisk: 'y'.repeat(2000), note: '索引测试', at: iso(),
  })
  await writeConflict(rec, { stateRoot })
  const one = await listConflictIndex({ stateRoot })
  ok(one.ok === true && one.items.length === 1, '写入后索引立刻看到它（缓存被自己清掉，不是等 1 秒）', JSON.stringify(one.items?.[0]?.id))
  ok(one.items[0] && !('incoming' in one.items[0]) && !('onDisk' in one.items[0]), '摘要里不带两份正文（注入侧只需要元数据）')
  ok(one.items[0]?.kind === 'contradiction' && one.items[0]?.file === 'i_old.md' && one.items[0]?.otherFile === 'i_new.md', '注入侧要的三个字段都在')

  await removeConflict(rec.id, { stateRoot })
  const gone = await listConflictIndex({ stateRoot })
  ok(gone.ok === true && gone.items.length === 0, '删除后索引立刻为空（同一份缓存键）')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
