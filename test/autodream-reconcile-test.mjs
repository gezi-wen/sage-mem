#!/usr/bin/env node
/**
 * 2.18.0「做梦会对账」的断言（`lib/autodream/reconcile.js` + `prompt.js` 的阶段 2.5）。
 *
 * 组织原则同 `precompact-test.mjs`：重点不是「提示词写得好不好」，而是**护栏**。
 * 这个功能的失败形态有三种，全都不会报错：
 *
 *   1. **该挑的不挑** —— 判据写反了（比如把「最近注入过」写成「从没注入过」），
 *      表现是名单永远空，而空名单是合法结果，所以谁也看不出来；
 *   2. **在不该出现的时候出现** —— 「仅记忆目录」模式下凭空多出一段「用会话核对」，
 *      模型会去搜不存在的会话；
 *   3. **把整趟做梦拖垮** —— 读台账 / 扫目录出错时抛上去，这一趟整理直接失败。
 *
 * 所以分五块：判据 / 排序 / 边界 / prompt 接线 / 引擎那层的开关与降级。
 * 全部纯函数与假 IO，不碰磁盘、不启动宿主。
 */
import {
  DEFAULT_FRESH_DAYS,
  DEFAULT_RECONCILE_LIMIT,
  DEFAULT_STALE_DAYS,
  buildReconcileList,
  pickReconcileCandidates,
  renderReconcileList,
} from '../lib/autodream/reconcile.js'
import { buildAutodreamUserPrompt } from '../lib/autodream/prompt.js'
import { AutodreamEngine } from '../lib/autodream.js'
import { ledgerFileFor } from '../lib/memory/access.js'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const DAY = 86400000
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0)
const daysAgo = (n) => NOW - n * DAY

// ── 1. 判据：两个条件同时成立才算候选 ─────────────────────────────────────
console.log('\n[1] 判据（还在被注入 + 很久没改）')

// 注入 2 天前、mtime 30 天前 —— 正中靶心
const hit = pickReconcileCandidates({
  entries: [{ file: 'a.md', mtime: daysAgo(30) }],
  ledger: { 'a.md': { injected: daysAgo(2) } },
  now: NOW,
})
ok(hit.length === 1 && hit[0].file === 'a.md', '注入近 + mtime 旧 → 命中', JSON.stringify(hit))

// 注入 30 天前 —— 早就不在服役了，不是「过时」而是「没用了」
ok(
  pickReconcileCandidates({
    entries: [{ file: 'a.md', mtime: daysAgo(30) }],
    ledger: { 'a.md': { injected: daysAgo(30) } },
    now: NOW,
  }).length === 0,
  '注入太久（超过 fresh 窗口）→ 不命中',
)

// 刚改过 —— 内容是新的，没什么可对账
ok(
  pickReconcileCandidates({
    entries: [{ file: 'a.md', mtime: daysAgo(3) }],
    ledger: { 'a.md': { injected: daysAgo(1) } },
    now: NOW,
  }).length === 0,
  'mtime 新（不到 stale 门槛）→ 不命中',
)

// injected = 0：从没被注入过。那种文件叫「没用上」，不叫「过时」，不该占名额
ok(
  pickReconcileCandidates({
    entries: [{ file: 'a.md', mtime: daysAgo(60) }],
    ledger: { 'a.md': { injected: 0 } },
    now: NOW,
  }).length === 0,
  'injected = 0（从没注入过）→ 不命中',
)

// 台账里压根没有这条 —— 与 injected=0 同义
ok(
  pickReconcileCandidates({ entries: [{ file: 'a.md', mtime: daysAgo(60) }], ledger: {}, now: NOW }).length === 0,
  '台账缺条目 → 不命中',
)

// 边界：正好压线（14 天整）算候选，别因为一个 < / <= 把整批候选丢掉
ok(
  pickReconcileCandidates({
    entries: [{ file: 'a.md', mtime: daysAgo(DEFAULT_STALE_DAYS) }],
    ledger: { 'a.md': { injected: daysAgo(1) } },
    now: NOW,
  }).length === 1,
  'mtime 正好等于 stale 门槛 → 命中（边界含）',
)

// ── 2. 排序：服役越强、内容越旧，越该先对账 ───────────────────────────────
console.log('\n[2] 排序')

const sorted = pickReconcileCandidates({
  entries: [
    { file: 'late.md', mtime: daysAgo(20) }, // 注入 6 天前
    { file: 'early.md', mtime: daysAgo(20) }, // 注入 1 天前
  ],
  ledger: { 'late.md': { injected: daysAgo(6) }, 'early.md': { injected: daysAgo(1) } },
  now: NOW,
})
ok(sorted.length === 2 && sorted[0].file === 'early.md', '注入越近越靠前', JSON.stringify(sorted.map((r) => r.file)))

const tie = pickReconcileCandidates({
  entries: [
    { file: 'freshish.md', mtime: daysAgo(15) },
    { file: 'ancient.md', mtime: daysAgo(90) },
  ],
  ledger: { 'freshish.md': { injected: daysAgo(2) }, 'ancient.md': { injected: daysAgo(2) } },
  now: NOW,
})
ok(tie.length === 2 && tie[0].file === 'ancient.md', '同注入天龄时，内容越旧越靠前', JSON.stringify(tie.map((r) => r.file)))

// ── 3. 边界：名额、空输入、坏条目 ────────────────────────────────────────
console.log('\n[3] 边界')

ok(DEFAULT_RECONCILE_LIMIT === 5 && DEFAULT_FRESH_DAYS === 7 && DEFAULT_STALE_DAYS === 14, '三个默认值被钉住（5 / 7 / 14）')

const many = Array.from({ length: 12 }, (_, i) => ({ file: `m${i}.md`, mtime: daysAgo(30) }))
const manyLedger = Object.fromEntries(many.map((m) => [m.file, { injected: daysAgo(2) }]))
ok(
  pickReconcileCandidates({ entries: many, ledger: manyLedger, now: NOW }).length === DEFAULT_RECONCILE_LIMIT,
  '默认截断到 5 条',
)
ok(pickReconcileCandidates({ entries: many, ledger: manyLedger, now: NOW, limit: 3 }).length === 3, 'limit 生效')
ok(pickReconcileCandidates({ entries: many, ledger: manyLedger, now: NOW, limit: 0 }).length === 0, 'limit = 0 → 空')

ok(pickReconcileCandidates({ entries: [], ledger: {}, now: NOW }).length === 0, '空 entries → 空数组')
ok(pickReconcileCandidates({ entries: many, ledger: {}, now: NOW }).length === 0, '空台账 → 空数组')
ok(pickReconcileCandidates({ entries: null, ledger: null, now: NOW }).length === 0, 'null 输入不炸')
// mtime 拿不到（字段缺失）时宁可跳过：拿 0 去减 now 会算成「1970 年改过的」，那会挤掉真候选
ok(
  pickReconcileCandidates({
    entries: [{ file: 'nomtime.md' }, { file: 'bad.md', mtime: 'x' }],
    ledger: { 'nomtime.md': { injected: daysAgo(1) }, 'bad.md': { injected: daysAgo(1) } },
    now: NOW,
  }).length === 0,
  'mtime 缺失或非数字 → 跳过',
)
ok(
  pickReconcileCandidates({
    entries: [{ file: 42, mtime: daysAgo(30) }, null, { mtime: daysAgo(30) }],
    ledger: { 42: { injected: daysAgo(1) } },
    now: NOW,
  }).length === 0,
  '坏条目（file 非字符串 / null）→ 跳过',
)

// ── 4. 渲染 + prompt 接线 ────────────────────────────────────────────────
console.log('\n[4] 渲染与 prompt 接线')

ok(renderReconcileList([]) === '', '空名单渲染成空串（调用方据此整段不出现）')
ok(renderReconcileList(null) === '', 'null 名单渲染成空串')
const rendered = renderReconcileList([{ file: 'old.md', idleDays: 30, injectedDays: 2 }])
ok(rendered.includes('old.md') && rendered.includes('30') && rendered.includes('2'), '名单行带文件名与两个天数')

const basePrompt = {
  // 占位路径，不写任何本机真实目录（仓库是公开的）
  memoryDir: '/mem',
  apply: true,
  hoursSince: 6,
  sessionCount: 4,
  now: NOW,
}
const promptNo = buildAutodreamUserPrompt({ ...basePrompt, reconcileList: '' })
const promptYes = buildAutodreamUserPrompt({ ...basePrompt, reconcileList: rendered })

ok(!promptNo.includes('阶段 2.5'), '名单为空时 prompt 不含「阶段 2.5」')
ok(!promptNo.includes('对账'), '名单为空时 prompt 连「对账」二字都没有')
ok(promptNo.includes('不要通读会话记录。\n\n## 阶段 3 — 整合'), '名单为空时阶段 2 与阶段 3 之间仍是原样空行')
ok(promptYes.includes('## 阶段 2.5 — 对账'), '名单非空时出现阶段 2.5')
ok(promptYes.includes('old.md'), '阶段 2.5 里带着候选文件名')
ok(promptYes.includes('全部核对通过、一个字都不改'), '退路措辞在（没有它模型会为了有产出瞎改）')
// 两版的唯一差别必须只有阶段 2.5 那一段：别顺手改了别的措辞
ok(
  promptYes.replace(/\n## 阶段 2\.5[\s\S]*?正常结果。\n(?=\n## 阶段 3)/, '') === promptNo,
  '非空版去掉阶段 2.5 后与空版逐字相同（没有别的连带改动）',
)
// 阶段 2.5 必须在阶段 3 之前 —— 顺序错了，模型会先整合完再回头核对，白做
ok(promptYes.indexOf('阶段 2.5') < promptYes.indexOf('## 阶段 3'), '阶段 2.5 排在阶段 3 之前')

// ── 5. 引擎那层：开关与降级 ──────────────────────────────────────────────
console.log('\n[5] 开关与降级（buildReconcileList）')

const okEntries = () => Promise.resolve([{ file: 'old.md', mtime: daysAgo(30) }])
const okLedger = () => Promise.resolve({ 'old.md': { injected: daysAgo(2) } })

let calls = 0
const countedEntries = () => {
  calls++
  return okEntries()
}

const onlyMemory = await buildReconcileList({
  source: 'memory',
  listEntries: countedEntries,
  readLedger: okLedger,
  ledgerFile: 'x.json',
  now: NOW,
})
ok(onlyMemory === '', '「仅记忆目录」→ 空串')
ok(calls === 0, '「仅记忆目录」→ 一次目录都不扫（不是扫了再丢）')

const withSessions = await buildReconcileList({
  source: 'memory+sessions',
  listEntries: okEntries,
  readLedger: okLedger,
  ledgerFile: 'x.json',
  now: NOW,
})
ok(withSessions.includes('old.md'), '「记忆 + 会话」→ 出名单')

// 降级：三个都取决于「对账挂了不许拖垮整趟做梦」
ok(
  (await buildReconcileList({
    source: 'memory+sessions',
    listEntries: () => Promise.reject(new Error('EACCES')),
    readLedger: okLedger,
    ledgerFile: 'x.json',
    now: NOW,
  })) === '',
  '扫目录抛错 → 降级成空串',
)
ok(
  (await buildReconcileList({
    source: 'memory+sessions',
    listEntries: okEntries,
    readLedger: () => Promise.reject(new Error('bad json')),
    ledgerFile: 'x.json',
    now: NOW,
  })) === '',
  '读台账抛错 → 降级成空串',
)
ok(
  (await buildReconcileList({
    source: 'memory+sessions',
    listEntries: () => {
      throw new Error('sync boom')
    },
    readLedger: okLedger,
    ledgerFile: 'x.json',
    now: NOW,
  })) === '',
  '同步抛错（不是 reject）→ 同样降级',
)
ok(
  (await buildReconcileList({
    source: 'memory+sessions',
    listEntries: () => Promise.resolve([]),
    readLedger: () => Promise.resolve({}),
    ledgerFile: 'x.json',
    now: NOW,
  })) === '',
  '没有候选 → 空串',
)

// ── 6. 真引擎接线：不是读源码，是让 AutodreamEngine 真的跑一趟 ─────────────
// 上面第 5 节测的是纯逻辑；这一节证明**引擎真的会把名单传进 prompt**（DI 没断、`this.ctx` 与
// `this.memoryDir` 都对得上）。两条断言互为反向对照：会话源出现、仅记忆目录不出现。
console.log('\n[6] 真引擎接线（假 llm 捕获实际发出的 prompt）')

const DAY_MS = 86400000

function makeCapturingLlm() {
  const seen = []
  return {
    seen,
    llm: {
      async *stream(options) {
        seen.push(options)
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

const firstPrompt = (seen) => seen[0]?.messages?.[0]?.content?.[0]?.text ?? ''

async function engineWorld(source) {
  const root = await mkdtemp(join(tmpdir(), 'ad-reconcile-'))
  const memoryDir = join(root, 'memory')
  const sessionsRoot = join(root, 'sessions')
  await mkdir(memoryDir, { recursive: true })
  const sess = join(sessionsRoot, 'proj', 'sess1')
  await mkdir(sess, { recursive: true })
  await writeFile(join(sess, 'session.v4.jsonl.zstd'), 'x', 'utf8')
  // 正中靶心的候选：内容 30 天没动，但台账说 2 天前还在被注入
  const oldFile = join(memoryDir, 'old.md')
  await writeFile(oldFile, '---\nname: old\ntype: project\n---\n\n# Old\n\n旧说法\n', 'utf8')
  const stale = new Date(Date.now() - 30 * DAY_MS)
  await utimes(oldFile, stale, stale)
  await mkdir(join(root, '.sage-mem'), { recursive: true })
  await writeFile(
    ledgerFileFor(memoryDir),
    JSON.stringify({ v: 2, files: { 'old.md': { injected: Date.now() - 2 * DAY_MS } } }),
    'utf8',
  )
  const { llm, seen } = makeCapturingLlm()
  const ctx = {
    get: (n) =>
      n === 'llm' ? llm : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined,
    logger: { warn: () => {}, error: () => {} },
  }
  const engine = new AutodreamEngine(ctx, { memoryDir, sessionsRoot })
  await engine.load()
  await engine.setConfig({ enabled: true, trigger: 'auto', minHours: 1, minSessions: 1, apply: false, source })
  engine.state.lastRunAt = 0
  await engine.persist()
  return { engine, seen, root }
}

{
  const withSess = await engineWorld('memory+sessions')
  const r1 = await withSess.engine.run({ reason: '对账接线测试', force: true })
  const p1 = firstPrompt(withSess.seen)
  ok(r1.ok === true, '（前提）真引擎这趟跑成功', JSON.stringify(r1).slice(0, 300))
  ok(p1.includes('## 阶段 2.5 — 对账'), '真引擎：会话源 → prompt 里真的带阶段 2.5')
  ok(p1.includes('old.md'), '真引擎：名单里点名了那条「还在注入但 30 天没改」的记忆')

  const onlyMem = await engineWorld('memory')
  const r2 = await onlyMem.engine.run({ reason: '对账接线测试', force: true })
  const p2 = firstPrompt(onlyMem.seen)
  ok(r2.ok === true, '（前提）仅记忆目录这趟也跑成功', JSON.stringify(r2).slice(0, 300))
  ok(!p2.includes('阶段 2.5'), '真引擎：仅记忆目录 → prompt 里没有阶段 2.5')

  await rm(withSess.root, { recursive: true, force: true }).catch(() => {})
  await rm(onlyMem.root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
