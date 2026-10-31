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
// 预算压到很低，让「撞顶」在一两条记忆内发生。
// ⚠️ 5120 不是随手写的：单会话总预算现在**拆成两本账**（正文池 + 状态卡预留），
// 预留 = clamp(总预算 × 5%, 1024, 4096)。5120 → 预留 1024 → **正文池正好 4096**，
// 下面那些「4 KB 只装得下一条 3.6 KB 的记忆」的断言才是它们原本的意思。
process.env.SAGE_MEM_MAX_SESSION_BYTES = '5120'

const MOD = new URL('../lib/index.js', import.meta.url).href
const mod = await import(MOD)
const MemoryGateway = mod.default
const T = mod.__testables
// 检查点与注入链共用同一个状态根（config.js 的 STATE_ROOT = SAGE_MEM_STATE_DIR）。
const { writeCheckpoint } = await import(new URL('../lib/memory/checkpoint.js', import.meta.url).href)

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
  // 状态行已被**缺口状态卡**取代（同一位置，不再说两遍）。这一组没有任何缺口
  // （全注进去了、没有省略），所以卡**不该出现** —— 没有缺口就不要说话。
  ok(!!text && !/sage-mem：/.test(text),
    '无缺口时不发状态卡（提示不刷屏）', text && text.slice(-160))
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
    '正文池 4 KB 只装得下一条 3.6 KB 的记忆（其余省略）', String(first && countEntries(first)))
  ok(!!first && /另有 2 条因预算省略/.test(first),
    '状态卡说明因预算省略了 2 条', String(first && first.slice(-200)))
  ok(!!first && !/### big-2\.md/.test(first), '被省略的那条确实没进文本')

  // 同一问题再来一步：检索签名没变 → 不重复注入，也不补注被省略的
  const again = await step(handler, 's-budget', 'sagebound')
  ok(again === null, '同一问题重复调用不再注入（去重优先于补注）', String(again))

  // 换一个问题（签名变了）但正文池已满 —— **这一条是本次行为变更的核心**：
  // 旧行为到这里返回 null（一个字都不注、连为什么都没有）；现在会发出**状态卡**，
  // 说清「有候选、被预算省略了、下一步该干什么」。
  const second = await step(handler, 's-budget', 'sagebound again')
  ok(second !== null, '正文池用满后换问题也注不进正文（账本跨步延续）', String(second))
  ok(!!second && countEntries(second) === 0, '但确实一条正文都没注', String(second && countEntries(second)))
  ok(!!second && /sage-mem：/.test(second) && /省略/.test(second),
    '改为发出状态卡：说清缺口与下一步（不再是静默的 null）', String(second && second.slice(-200)))
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

// ═══ 6b. 注入的是「命中段落」，不是文件开头 ═══
group('6b. 命中段落替换文件开头')
{
  resetDir()
  // 摘要（description）与问句毫无词面重合，答案只在正文中段 ——
  // 这正是旧版（只比摘要 + 永远端文件开头 1500 字）必然漏掉的那类。
  const BODY = [
    '# 上线流程',
    '',
    '这一节讲的是发布前的检查清单，包含打标签、跑 CI、通知值班同学三件事。',
    '',
    '## 历史故障',
    '',
    // 这一段必须**自己够长**（> CHUNK_MIN_CHARS=60），否则会被当成「短段」并进上一段，
    // 整份文件就只剩一个段落 —— 那样「命中段落替换文件开头」这条断言根本无从区分。
    '去年压测时连接池等待时间设成了 30 秒，导致大量请求排队超时；最后的处置是把等待时间调到 5 秒，并在网关侧加了重试上限。',
  ].join('\n')
  mem('deploy.md', { desc: '上线流程与回滚预案', body: BODY })
  const { handler } = newGateway()

  const text = await step(handler, 's-chunk', '去年压测连接池超时最后是怎么处置的')
  ok(!!text && /### deploy\.md:\d+-\d+/.test(text), '摘要没命中时由正文兜底，且带行号', String(text && text.slice(0, 160)))
  ok(!!text && text.includes('连接池等待时间'), '注入的是命中那一段')
  ok(!!text && !text.includes('# 上线流程'), '不再无条件端文件开头')
  ok(!!text && text.includes('上线流程与回滚预案'), '段落前补了该记忆的 description，补回上下文')
}

// ═══ 6c. baseline 不吃段落替换 ═══
group('6c. baseline 仍注入开头')
{
  resetDir()
  // baseline 的语义是「每场会话都该完整在场」。若它被问句命中就换成单个段落，
  // 等于把「完整在场」偷偷降级成「命中在场」—— 那正是 baseline 要防的事。
  mem('base-hit.md', { baseline: true, body: '第一段在这里。\n\n## 后段\nsagebound 的内容在后段。' })
  const { handler } = newGateway()

  const text = await step(handler, 's-base-hit', 'sagebound')
  ok(!!text && text.includes('### base-hit.md'), 'baseline 被命中时照样进文本')
  ok(!!text && !/### base-hit\.md:\d/.test(text), 'baseline 不被替换成单个段落（仍注入开头）', String(text && text.slice(0, 160)))
}

// ═══ 6d. 门槛按意图放宽（0.9.16 欠的账） ═══
group('6d. 历史意图放宽正文门槛')
{
  // 背景：0.9.16 为「无关问题零误召」加了「连续命中 ≥ 2 个词元」这条门槛，
  // 代价是**整句只对上一个两字专名时会被拦下**。当时写明「等意图识别上线后放宽」。
  // 这一组就是钉那条：同一个孤立命中，普通问题拿不到、历史问题拿得到。
  resetDir()
  for (let i = 0; i < 8; i++) {
    mem(`reference_item${i}.md`, { desc: `第 ${i} 号参考条目`, body: `# 条目 ${i}\n\n这一段只讲通用流程：先申请、再审批、最后归档。` })
  }
  // 那个两字专名**只出现在正文里**（摘要里没有），所以摘要检索必然漏
  mem('reference_itemX.md', { desc: '设备清单', body: '# 设备清单\n\n其中霁川这台机器负责夜间批处理，日志留在本地。' })
  const { handler } = newGateway()

  const plain = await step(handler, 's-gate-plain', '霁川是什么东西')
  ok(!plain || !/### reference_itemX\.md/.test(plain),
    '普通问题不因「孤立两字命中」就注入（误召仍然是零）', String(plain && plain.slice(-160)))

  const hist = await step(handler, 's-gate-hist', '上次提到的霁川是什么')
  ok(!!hist && /### reference_itemX\.md/.test(hist),
    '历史意图下放宽门槛 → 那份记忆拿得到了', String(hist && hist.slice(-160)))
}

// ═══ 7. 全被挡掉 → 一条都不注 ═══
group('7. 预算挡掉全部条目')
{
  resetDir()
  mem('huge.md', { body: '甲'.repeat(1500) })   // 单条就超 4 KB
  const { handler } = newGateway()

  const out = await step(handler, 's-blocked', 'sagebound')
  // 行为变更：旧行为「正文一条都装不下」= 返回 null（连为什么都没有）。
  // 现在只要正文池之外还有卡池额度，就会发一张卡说清缺口 —— 这正是把 60 KB
  // 拆成两本账的目的。所以这里断言「没有正文，但有卡」。
  ok(out !== null && countEntries(out) === 0,
    '正文一条都装不下时不注正文（但状态卡仍会发）', String(out))
  ok(!!out && /sage-mem：/.test(out) && /省略/.test(out),
    '确实发了状态卡说清缺口', String(out && out.slice(-200)))

  const gw2 = newGateway()
  const snap = await gw2.handler({ keep: 1 }, {
    agent: { session: { id: 's-blocked2', deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'sagebound' }] }] } },
  }, async () => ({ keep: 1 }))
  ok(snap.keep === 1, '宿主原有的字段原样保留（不破坏已组装好的内容）')
  ok((snap.contexts ?? []).length === 1 && snap.contexts[0].name === 'sage-mem:recall',
    'contexts 是「原有的 + 新增的一条」而不是整体替换',
    JSON.stringify(snap.contexts?.map((c) => c?.name)))
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
  ok(T.limits.MAX_SESSION_BYTES === 5120, '环境变量覆写口生效（本进程是 5120）')
  ok(T.limits.STALE_DAYS === 1, '新鲜度门槛默认 1 天')
  ok(String(T.recallDiscipline).includes('引用纪律'), '__testables 暴露了引用纪律文本')
}

// ═══ 9. R02：控制提示独立于候选（外部复审 F02 / F03） ═══
// 根因：旧代码在 `picked.length === 0` 时提前返回，而检查点句柄与未命中提示都在那之后
// 才计算 —— 于是「目录为空」与「零命中」这两种最需要说话的场合，插件一个字都不说。
group('9. R02：控制提示不依赖候选')
{
  // 9a. 空目录 + 有效检查点 → 句柄必须出现
  resetDir()
  const CP_TEXT = [
    '# 任务检查点 task-cp-a',
    '- 任务：task-cp-a',
    '- 项目：sample-project',
    '- revision：1',
    '',
    '## 目标与约束',
    '',
    '目标：把合成样例的交接材料读回来。',
    '',
    '约束：',
    '- 只用合成夹具',
    '',
    '## 已完成与证据',
    '',
    '- `sample/a.md` 已建立',
    '',
    '## 未完成',
    '',
    '- 复核结果',
    '',
    '## 关键决定',
    '',
    '- 保持模板结构不变',
    '',
    '## 记忆引用',
    '',
    '- sample/a.md',
    '',
    '## 待核实',
    '',
    '- 句柄是否出现在注入文本里',
    '',
  ].join('\n')
  const wrote = await writeCheckpoint('task-cp-a', CP_TEXT, { stateRoot: process.env.SAGE_MEM_STATE_DIR })
  ok(wrote.ok, '夹具自检：合成检查点写得进去', JSON.stringify(wrote))

  const { handler: h1 } = newGateway()
  const cpOut = await step(h1, 'task-cp-a', '继续上次任务')
  ok(!!cpOut && cpOut.includes('tasks/task-cp-a/WORKING.md'),
    '空目录 + 有效检查点 → 发出检查点句柄（旧行为在这里一条都不注）', String(cpOut))
  // 2.1.15（Q12）：句柄说法改成「revision 在前、完整路径只说一次、基准是状态根」——
  // 旧写法把 id 写了两遍，长 id 时会被截成不存在的 `tasks/WORKING.md`。断言名保持不变
  // （4.3 / 5.8 两条契约绑定指向它），只更新成新说法。
  ok(!!cpOut && /检查点 revision 1：状态根下 tasks\/task-cp-a\/WORKING\.md/.test(cpOut), '句柄带任务 id 与 revision')
  ok(!!cpOut && countEntries(cpOut) === 0, '这条路上没有任何正文（目录本来就是空的）')

  // 9b. 非空目录、零命中、历史依赖问题 → 未命中提示
  resetDir()
  mem('unrelated.md', { desc: '合成样例：与下面那句问题毫无关系', body: SHORT })
  const { handler: h2 } = newGateway()
  const miss = await step(h2, 's-r02-miss', '上次的火箭燃料约定是什么')
  ok(!!miss && /sage-mem：/.test(miss), '零命中 + 历史问题 → 有未命中提示', String(miss))
  ok(!!miss && /没有命中/.test(miss), '提示说清「摘要里没有命中」，而不是静默')
  ok(!!miss && countEntries(miss) === 0, '零命中确实没有正文可注')

  // 9c. 反向对照：同样是零命中，但问题不依赖历史 → 一个字都不说
  resetDir()
  mem('unrelated.md', { desc: '合成样例：与下面那句问题毫无关系', body: SHORT })
  const { handler: h3 } = newGateway()
  const quiet = await step(h3, 's-r02-plain', '现在窗外的天气怎么样')
  ok(quiet === null,
    '【反向对照】普通问题零命中时不插「你可能遗漏记忆」（否则提示会变成噪音）', String(quiet))
}

// ═══ 10. R03：生命周期先于去重（外部复审 F04） ═══
// 根因：压缩的账本重置写在去重**之后**，于是同题在压缩后仍被上一代的检索签名挡住；
// 而且 R02 的提前返回让那段重置根本不可达。下面每条都配一个相邻对照，
// 证明「恢复」来自代次处理，不是把去重整个关掉了。
group('10. R03：生命周期先于去重')
{
  // 10a. 同题压缩恢复
  resetDir()
  mem('base-q.md', { desc: 'quartz nebula', body: 'quartz nebula evidence', baseline: true })
  const { handler: h1 } = newGateway()
  const before = await step(h1, 's-life-same', 'quartz nebula', 10)
  ok(!!before && before.includes('### base-q.md'), '压缩前：同题注得进去')
  const after = await step(h1, 's-life-same', 'quartz nebula', 1)
  ok(!!after && after.includes('### base-q.md'),
    '压缩后**同题**重新开放注入（复审 F04 的反例）', String(after))

  // 10b. 换题 + 压缩
  resetDir()
  mem('topic-a.md', { desc: 'quartz nebula', body: SHORT })
  mem('topic-b.md', { desc: 'cobalt prism', body: SHORT })
  const { handler: h2 } = newGateway()
  const ta = await step(h2, 's-life-swap', 'quartz nebula', 20)
  ok(!!ta && ta.includes('### topic-a.md'), '压缩前注的是 A 题')
  const tb = await step(h2, 's-life-swap', 'cobalt prism', 1)
  ok(!!tb && tb.includes('### topic-b.md') && !tb.includes('### topic-a.md'),
    '换题 + 压缩：新题注得进去，旧题不连坐', String(tb))

  // 10c. 卡已发送后恢复（卡签名随代次一起归零）
  // 顺带把「正文预算耗尽 → 卡仍发出」这条既有行为钉在这里：单条记忆就超过正文池，
  // 一条正文都进不去，但卡池照发。
  resetDir()
  mem('huge-x.md', { body: '甲'.repeat(1500) })
  const { handler: h3 } = newGateway()
  const card1 = await step(h3, 's-life-card', 'sagebound', 20)
  ok(!!card1 && /sage-mem：/.test(card1) && countEntries(card1) === 0,
    '正文预算耗尽 → 没有正文，但卡仍发出（既有行为不退）', String(card1))
  const card2 = await step(h3, 's-life-card', 'sagebound', 1)
  ok(!!card2 && /sage-mem：/.test(card2),
    '压缩后同一张卡能再发一次（卡签名随代次归零，否则恢复入口永久失效）', String(card2))

  // 10d. 反向对照：条数没降 → 相邻重复仍然去重
  resetDir()
  mem('note-q.md', { desc: 'quartz nebula', body: SHORT })
  const { handler: h4 } = newGateway()
  const first = await step(h4, 's-life-dup', 'quartz nebula', 1)
  ok(!!first && first.includes('### note-q.md'), '首次注入')
  const again = await step(h4, 's-life-dup', 'quartz nebula', 3)
  ok(again === null,
    '【反向对照】条数不降 → 同题相邻重复仍然不重复注入（去重没被关掉）', String(again))

  // 10e. 不同会话隔离
  resetDir()
  mem('iso.md', { desc: 'quartz nebula', body: SHORT, baseline: true })
  const { handler: h5 } = newGateway()
  const s1 = await step(h5, 's-iso-1', 'quartz nebula', 1)
  const s2 = await step(h5, 's-iso-2', 'quartz nebula', 1)
  ok(!!s1 && !!s2, '两个会话各自都拿得到 baseline（会话级标记不互相顶掉）')
  const s1again = await step(h5, 's-iso-1', 'quartz nebula', 2)
  ok(s1again === null, 'A 会话的同题重复仍被自己那条签名挡住（状态按会话分账）')
}

// ── 收尾 ────────────────────────────────────────────────────
rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
