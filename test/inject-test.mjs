#!/usr/bin/env node
/**
 * inject-test.mjs — sage-mem 注入链的断言（2026-10-06 建）
 *
 * 为什么单开一个文件：现有六个 _scratch 脚本里**没有一个** mock 过
 * `session.deriveMessages()` 或 `assembled.contexts`（`ctx.on('system-prompt/assemble', …)`
 * 的回调从来没被捕获过），而本文件要测的「注入新鲜度」与「单会话累计预算」都是
 * **跨多步的会话级状态**，得连续多轮调用同一个 handler。并进 retrieval-test 会把
 * 它「纯函数检索」的定位搞浑。
 *
 * 三个必须知道的坑：
 *   1. MEMORY_DIR / STATE_ROOT / MAX_SESSION_BYTES 都是**模块顶层**读的环境变量 ——
 *      必须在动态 import **之前**设好。静态 import 会被提升到赋值之前，用不得。
 *   2. 本文件会真在系统临时目录里造记忆文件、并**清空重建**目录来切换场景；
 *      全程不碰任何真实的记忆目录（SAGE_MEM_DIR 一律指向临时目录）。
 *   3. 各组用**不同 sessionId** 隔离 —— baseline 标记、注入账本、检索签名三者
 *      都按 session 记，换 id 就等于新会话。
 *
 * 用法: node inject-test.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

// ── 沙箱：环境变量必须在 import 之前 ─────────────────────────
const sandbox = join(tmpdir(), 'sage-mem-inject-test-' + process.pid)
const memDir = join(sandbox, 'memory')
mkdirSync(memDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')
// 预算压到下限（envInt 的 min 就是 4096），让「撞顶」在一两条记忆内发生
process.env.SAGE_MEM_MAX_SESSION_BYTES = '4096'

const MOD = new URL('../lib/index.js', import.meta.url).href
const mod = await import(MOD)
const MemoryGateway = mod.default
const T = mod.__testables

// ── 造记忆 ──────────────────────────────────────────────────
const LONG = '甲'.repeat(1200)   // 中文 3 字节/字 → 注入 part 约 3.6 KB
const SHORT = '乙'.repeat(30)

function resetDir() {
  rmSync(memDir, { recursive: true, force: true })
  mkdirSync(memDir, { recursive: true })
}

/** 写一条记忆。`updated` 故意放在 metadata 嵌套块里（与真实记忆一致）。 */
function mem(name, opts = {}) {
  const { updated, desc, body, baseline, priority } = opts
  const lines = [
    '---',
    `name: ${name.replace(/\.md$/, '')}`,
    `description: ${desc ?? 'sagebound'}`,
    'metadata:',
    '  node_type: memory',
    '  type: reference',
  ]
  if (updated) lines.push(`  updated: ${updated}`)
  if (baseline) lines.push('baseline: true')        // 顶层：parseBaseline 锚行首
  if (priority !== undefined) lines.push(`baselinePriority: ${priority}`)
  lines.push('---', '', body ?? LONG)
  writeFileSync(join(memDir, name), lines.join('\n'), 'utf8')
}

const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── 假运行环境 ──────────────────────────────────────────────
// 万能 ctx：未知成员既当函数调（返回 undefined）又能取属性（undefined）。
// TypertRemoteService 的构造要求没人文档化过，靠这层兜住。
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
  // 未知成员一律给一个**可调用、且可继续取属性**的桩：cordis 的 Service 构造会调
  // `ctx.reflect.provide(name, self, check)`，只返回一次 undefined 会在那儿炸。
  // `then` 必须给 undefined，否则 await 会把桩当 thenable。
  let stub
  stub = new Proxy(function () {}, {
    get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined),
    apply: () => undefined,
  })
  return new Proxy(base, {
    get(t, p) { return p in t ? t[p] : stub },
  })
}

/** 造一条插件实例并拿回 assemble handler。 */
function newGateway() {
  const ctx = makeCtx()
  const gw = new MemoryGateway(ctx)
  const hs = ctx.handlers.get('system-prompt/assemble') || []
  if (!hs.length) throw new Error('没有注册 system-prompt/assemble 监听器')
  return { gw, ctx, handler: hs[hs.length - 1] }
}

/** 跑一步 assemble，返回插件注入的 recall 文本（没注入则 null）。 */
async function step(handler, sessionId, question, messageCount = 1) {
  const msgs = []
  for (let i = 0; i < messageCount; i++) {
    msgs.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })
  }
  msgs.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: question }] })
  const session = { id: sessionId, deriveMessages: () => msgs }
  const assembled = {}
  const out = await handler(assembled, { agent: { session } }, async () => assembled)
  const hit = (out?.contexts ?? []).find((c) => c?.name === 'sage-mem:recall')
  return hit ? hit.text : null
}

const countEntries = (text) => (text.match(/^### /gm) || []).length

// ═══ 1. frontmatter 的 updated 解析（这是 P1-1 的地基） ═══
group('1. frontmatter updated 解析')
{
  const nested = '---\nname: a\ndescription: d\nmetadata:\n  node_type: memory\n  type: project\n  updated: 2026-09-30\n---\n\nbody'
  ok(T.parseFrontmatter(nested).updated === '2026-09-30',
    '嵌套在 metadata 下的 updated 抓得到（grab 抓不到的那一层）', JSON.stringify(T.parseFrontmatter(nested).updated))

  const top = '---\nname: a\nupdated: 2026-08-01\ntype: project\n---\n\nbody'
  ok(T.parseFrontmatter(top).updated === '2026-08-01', '顶层 updated 也抓得到')

  const none = '---\nname: a\ndescription: d\nmetadata:\n  type: project\n---\n\nbody'
  ok(T.parseFrontmatter(none).updated === '', '没有 updated 时是空串')

  ok(T.parseFrontmatter('没有 frontmatter 的纯正文').updated === '', '完全没有 frontmatter 时也是空串')
}

// ═══ 2. ageDays：updated 优先、mtime 退路 ═══
group('2. ageDays 的口径')
{
  const now = Date.now()
  const fiveDaysAgo = now - 5 * 86400000
  const iso5 = new Date(fiveDaysAgo).toISOString().slice(0, 10)

  ok(T.ageDays({ updated: iso5, mtimeMs: now }, now) === 5,
    'updated 与 mtime 冲突时以 updated 为准（mtime 是刚刚，结果应是 5）',
    String(T.ageDays({ updated: iso5, mtimeMs: now }, now)))

  ok(T.ageDays({ updated: '', mtimeMs: fiveDaysAgo }, now) === 5,
    '没有 updated 时回落 mtime', String(T.ageDays({ updated: '', mtimeMs: fiveDaysAgo }, now)))

  ok(T.ageDays({ updated: '2999-01-01', mtimeMs: now }, now) === 0,
    '未来日期当 0，不出现负数', String(T.ageDays({ updated: '2999-01-01', mtimeMs: now }, now)))

  ok(T.ageDays({ updated: '不是日期', mtimeMs: NaN }, now) === null,
    '两个来源都没有 → null（不标天数）', String(T.ageDays({ updated: '不是日期', mtimeMs: NaN }, now)))
}

// ═══ 3. 注入文本：引用纪律 + 新鲜度 ═══
group('3. 注入文本的内容')
{
  resetDir()
  // 正文必须短：预算已被压到 4 KB，用默认的 LONG 就只注得下一条了
  mem('old-a.md', { updated: daysAgo(5), body: SHORT })
  mem('old-b.md', { updated: daysAgo(30), body: SHORT })
  mem('today-c.md', { updated: daysAgo(0), body: SHORT })
  mem('nodate-d.md', { body: SHORT })          // 无 updated → 回落 mtime（刚刚）
  const { handler } = newGateway()

  const text = await step(handler, 's-new', 'sagebound')
  ok(!!text, '四条短记忆全部命中并注入')

  ok(!!text && text.includes('> **引用纪律**'),
    '注入文本里有一节引用纪律（独立成节，不是 bullet）')
  ok(!!text && /### old-a\.md（保存于 [4-6] 天前）/.test(text),
    '5 天前的记忆标了「保存于 N 天前」', text && (text.match(/### old-a\.md[^\n]*/) || [''])[0])
  ok(!!text && /### old-b\.md（保存于 (29|30|31) 天前）/.test(text),
    '30 天前的记忆同样标了')
  ok(!!text && !/### today-c\.md（保存于/.test(text),
    '今天的记忆不标天数（噪声过滤）')
  ok(!!text && !/### nodate-d\.md（保存于/.test(text),
    '无 updated 的按 mtime 算 = 今天，也不标')
  ok(!!text && /（本次注入 \d+ 条；本会话累计 \d+ KB \/ 上限 4 KB/.test(text),
    '尾部有状态行，且上限是本次覆写的 4 KB', text && text.slice(-160))
  ok(!!text && countEntries(text) === 4, '四条都注进去了', String(text && countEntries(text)))
}

// ═══ 4. 单会话累计预算 ═══
group('4. 单会话累计预算')
{
  resetDir()
  mem('big-1.md', {})
  mem('big-2.md', {})
  mem('big-3.md', {})
  const { handler } = newGateway()

  const first = await step(handler, 's-budget', 'sagebound')
  ok(!!first && countEntries(first) === 1,
    '预算 4 KB 只装得下一条 3.6 KB 的记忆（其余省略）', String(first && countEntries(first)))
  ok(!!first && /因预算省略 2 条/.test(first),
    '状态行说明因预算省略了 2 条')
  ok(!!first && !/### big-2\.md/.test(first), '被省略的那条确实没进文本')

  // 同一问题再来一步：检索签名没变 → 不重复注入，也不补注被省略的
  const again = await step(handler, 's-budget', 'sagebound')
  ok(again === null, '同一问题重复调用不再注入（去重优先于补注）', String(again))

  // 换一个问题（签名变了）但预算已满 → 仍然一条都注不进
  const second = await step(handler, 's-budget', 'sagebound again')
  ok(second === null, '预算用满后换问题也注不进（账本跨步延续）', String(second))
}

// ═══ 5. 压缩后账本归零 ═══
group('5. 压缩 / 清空后账本归零')
{
  resetDir()
  mem('big-1.md', {})
  mem('big-2.md', {})
  const { handler } = newGateway()

  const a = await step(handler, 's-compact', 'sagebound', 40)
  ok(!!a && countEntries(a) === 1, '压缩前：注得下一条', String(a && countEntries(a)))

  // 消息条数从 40 掉到 1 → 压缩发生了 → 账本该归零
  const b = await step(handler, 's-compact', 'sagebound second', 1)
  ok(!!b && countEntries(b) === 1,
    '压缩（消息条数变小）后账本归零，重新注得进一条', String(b && countEntries(b)))
}

// ═══ 6. baseline 在预算里优先 ═══
group('6. baseline 的预算优先权')
{
  resetDir()
  mem('base.md', { baseline: true, priority: 9, body: SHORT })
  mem('big-1.md', {})
  mem('big-2.md', {})
  const { handler } = newGateway()

  const text = await step(handler, 's-base', 'sagebound')
  ok(!!text && text.includes('### base.md'), 'baseline 进了文本')
  ok(!!text && text.includes('### big-1.md'), '预算够的时候检索结果也进得来')
  ok(!!text && !text.includes('### big-2.md'), '预算不够时先挤掉的是检索结果，不是 baseline')
}

// ═══ 7. 全被挡掉 → 一条都不注 ═══
group('7. 预算挡掉全部条目')
{
  resetDir()
  mem('huge.md', { body: '甲'.repeat(1500) })   // 单条就超 4 KB
  const { handler } = newGateway()

  const out = await step(handler, 's-blocked', 'sagebound')
  ok(out === null, '一条都装不下时，不加 contexts（不塞「预算已满」噪声）', String(out))

  const gw2 = newGateway()
  const snap = await gw2.handler({ keep: 1 }, {
    agent: { session: { id: 's-blocked2', deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'sagebound' }] }] } },
  }, async () => ({ keep: 1 }))
  ok(snap.keep === 1 && (snap.contexts ?? []).length === 0,
    '原 assembly 原样返回（不破坏宿主已组装好的内容）')
}

// ═══ 8. 默认预算仍是 60 KB（子进程：模块顶层常量一个进程只能有一个值） ═══
group('8. 默认值与覆写口')
{
  const child = spawnSync(process.execPath, ['-e', [
    'delete process.env.SAGE_MEM_MAX_SESSION_BYTES;',
    `import(${JSON.stringify(MOD)}).then(m => console.log(m.__testables.limits.MAX_SESSION_BYTES))`,
  ].join('\n')], { encoding: 'utf8' })
  const v = Number(String(child.stdout || '').trim())
  ok(v === 60 * 1024, '不设环境变量时默认 60 KB（与 CC 的 MAX_SESSION_BYTES 对齐）', String(child.stdout || child.stderr).slice(0, 200))
  ok(T.limits.MAX_SESSION_BYTES === 4096, '环境变量覆写口生效（本进程是 4096）')
  ok(T.limits.STALE_DAYS === 1, '新鲜度门槛默认 1 天')
  ok(String(T.recallDiscipline).includes('引用纪律'), '__testables 暴露了引用纪律文本')
}

// ── 收尾 ────────────────────────────────────────────────────
rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
