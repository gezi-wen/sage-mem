/**
 * 注入链 golden 场景（1.2.0 重构的「行为不变」证据来源）。
 *
 * 为什么要有它：1.2.0 把 `lib/index.js` 里 348 行监听器搬进 `lib/recall/`，
 * 这是纯搬移 —— 而**「纯搬移」这句话必须能被机器推翻**。这里用 11 个固定场景
 * 把当前版本的注入文本逐字节钉住；搬完之后任何一个字节变了都红。
 *
 * 两个让文本**可逐字节比较**的处理：
 *   1. 记忆目录路径会被写进注入头部 → 统一替换成 `<MEMORY_DIR>`（沙箱路径每次都不同）；
 *   2. 夹具里不写 `updated`，于是不会出现「保存于 N 天前」这种随日期漂移的戳。
 *
 * 场景命名对应方案文档 §4.1；`test/recall-golden-test.mjs` 与
 * `scripts/gen-recall-golden.mjs` 共用本文件（只有一份场景定义）。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = join(tmpdir(), 'sage-mem-recall-golden-' + process.pid)
const memDir = join(sandbox, 'memory')
mkdirSync(memDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')
// 与 inject-test 同一个理由：5120 → 预留 1024 → 正文池正好 4096。
process.env.SAGE_MEM_MAX_SESSION_BYTES = '5120'
delete process.env.SAGE_MEM_TASK_ID
delete process.env.SAGE_MEM_DEBUG

const MOD = await import(new URL('../lib/index.js', import.meta.url).href)
const MemoryGateway = MOD.default
const { writeCheckpoint } = await import(new URL('../lib/memory/checkpoint.js', import.meta.url).href)

function resetDir() {
  rmSync(memDir, { recursive: true, force: true })
  mkdirSync(memDir, { recursive: true })
}

/** 写一条记忆：只写确定性的字段（不写 updated，避免时间戳漂移）。 */
function mem(name, { desc = '无描述', body = '正文。', baseline = false, priority } = {}) {
  const lines = ['---', `name: ${name.replace(/\.md$/, '')}`, `description: ${desc}`, 'metadata:', '  node_type: memory', '  type: reference']
  if (baseline) lines.push('baseline: true')
  if (priority !== undefined) lines.push(`baselinePriority: ${priority}`)
  lines.push('---', '', body)
  writeFileSync(join(memDir, name), lines.join('\n'), 'utf8')
}

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
  return { gw, ctx, handler: hs[hs.length - 1] }
}

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

/** 归一：沙箱路径每次不同，替换成固定占位符；两种斜杠都换。 */
function normalize(text) {
  if (text === null) return '<none>'
  const variants = new Set([memDir, memDir.replace(/\\/g, '/'), memDir.replace(/\//g, '\\')])
  let out = text
  for (const v of variants) out = out.split(v).join('<MEMORY_DIR>')
  /**
   * 状态卡会把记忆目录**截断**到固定字符数（`直接打开记忆目录 C:\…\sage-mem-reca…`），
   * 所以上面那次整串替换抓不到它。这里按形状再归一一次：绝对路径一律变 `<PATH>`
   * —— 既让夹具跨机器可比，也避免把本机用户名写进仓库。
   */
  out = out.replace(/[A-Za-z]:\\[^\s，。；、）】"'`]+/g, '<PATH>')
  out = out.replace(/(?<=^|[\s（(])\/(?:[^\s，。；、）】"'`]+\/)*[^\s，。；、）】"'`]+/gm, '<PATH>')
  return out
}

const LONG = '甲'.repeat(1200) // 中文 3 字节/字 → 单条注入约 3.6 KB

/**
 * 11 个场景。每个场景自己 reset 目录、造夹具、跑若干步；返回归一后的文本。
 * 顺序固定，fixture 文件名就是键名。
 */
export const SCENARIOS = [
  ['baseline-only', async () => {
    resetDir()
    mem('user_base.md', { desc: '身份锚点', body: '我是甲，一个测试用的人设。', baseline: true })
    const { handler } = newGateway()
    return step(handler, 'golden-baseline', '今天天气如何')
  }],
  ['summary-hit', async () => {
    resetDir()
    mem('project_alpha.md', { desc: '阿尔法项目进度', body: '进度表在别处。' })
    const { handler } = newGateway()
    return step(handler, 'golden-summary', '阿尔法项目')
  }],
  ['body-hit', async () => {
    resetDir()
    mem('reference_beta.md', { desc: '贝塔资料', body: '正文里提到伽马射线与它的来源。' })
    const { handler } = newGateway()
    return step(handler, 'golden-body', '伽马射线是什么')
  }],
  ['summary+body-union', async () => {
    resetDir()
    mem('project_alpha.md', { desc: '阿尔法项目进度', body: '进度表在别处。' })
    mem('reference_beta.md', { desc: '贝塔资料', body: '正文里提到伽马射线与它的来源。' })
    const { handler } = newGateway()
    return step(handler, 'golden-union', '阿尔法和伽马射线')
  }],
  ['budget-exhausted', async () => {
    resetDir()
    mem('project_long_a.md', { desc: '长文甲 第一份', body: LONG })
    mem('project_long_b.md', { desc: '长文甲 第二份', body: LONG })
    const { handler } = newGateway()
    return step(handler, 'golden-budget', '长文甲')
  }],
  ['card-over-budget', async () => {
    resetDir()
    // MAX_CHARS_PER_FILE 默认 1500 字符（4.5 KB）> 正文池 4096 字节 → 单条也塞不下，
    // 只剩状态卡。这正是「正文池满但卡池还有额度」那条分支。
    mem('project_huge.md', { desc: '长文乙 唯一一份', body: '乙'.repeat(3000) })
    const { handler } = newGateway()
    return step(handler, 'golden-card', '长文乙')
  }],
  ['checkpoint-handle', async () => {
    resetDir()
    mem('user_base.md', { desc: '身份锚点', body: '我是甲。', baseline: true })
    const taskId = 'golden-task'
    await writeCheckpoint(taskId, [
      '# 任务检查点',
      '',
      `- 任务：${taskId}`,
      '- revision: 3',
      '',
      '## 已完成',
      '- 做了 A（证据：日志）',
      '',
      '## 下一步',
      '- 做 B',
      '',
    ].join('\n'), { stateRoot: process.env.SAGE_MEM_STATE_DIR })
    process.env.SAGE_MEM_TASK_ID = taskId
    try {
      const { handler } = newGateway()
      return await step(handler, 'golden-checkpoint', '今天天气如何')
    } finally {
      delete process.env.SAGE_MEM_TASK_ID
    }
  }],
  ['compaction-reset', async () => {
    resetDir()
    mem('user_base.md', { desc: '身份锚点', body: '我是甲。', baseline: true })
    const { handler } = newGateway()
    const first = await step(handler, 'golden-compaction', '同一句问题', 3)
    // 消息条数下降 = 压缩 / 清空：签名、两本账、卡签名、baseline 标记一起归零。
    const second = await step(handler, 'golden-compaction', '同一句问题', 1)
    return `--- first ---\n${first ?? '<none>'}\n--- second ---\n${second ?? '<none>'}`
  }],
  ['intent-relaxed', async () => {
    resetDir()
    mem('reference_zeta.md', { desc: '泽塔资料', body: '泽塔的正文里写着它的来历。' })
    const { handler } = newGateway()
    return step(handler, 'golden-intent', '上次说的泽塔是什么')
  }],
  ['tools-unavailable', async () => {
    resetDir()
    mem('project_long_a.md', { desc: '长文甲 第一份', body: LONG })
    mem('project_long_b.md', { desc: '长文甲 第二份', body: LONG })
    const { handler } = newGateway() // 假 ctx 的 get('tools') 永远是 undefined
    return step(handler, 'golden-tools', '长文甲')
  }],
  ['empty-dir', async () => {
    resetDir()
    const { handler } = newGateway()
    return step(handler, 'golden-empty', '有什么记忆')
  }],
]

/** 跑全部场景，返回 { 名称: 归一文本 } 的有序 Map。 */
export async function runScenarios() {
  const out = new Map()
  for (const [name, fn] of SCENARIOS) out.set(name, normalize(await fn()))
  return out
}

export const FIXTURE_DIR = new URL('./fixtures/recall-golden/', import.meta.url)
