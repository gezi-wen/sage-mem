#!/usr/bin/env node
/**
 * recall-context-literal-test.mjs — 记忆正文不是「提示词模板」，注入时必须原样呈现（2026-11-07 建）
 *
 * 真实事故（0.2.1-rc 宿主，sage-mem 2.3.1）：一条记忆正文里写了双大括号中间留空的
 * 占位符写法（形如 `{{ }}`，当时是给「风格 md 有占位符」这句结论做例子）。下一轮
 * 会话召回到这条记忆，宿主在组装 system prompt 时把注入段当模板渲染，`{{ }}` 被当成
 * 变量引用解析，变量名是空格 → 不匹配 `/^[a-z][a-z0-9_]*$/`，**整轮对话在模型开跑
 * 之前就抛错**：`malformed prompt variable reference "{{ }}" in context "sage-mem:recall"`。
 *
 * 这不是「某条记忆写错了」——用户没有任何理由知道自己写的 Markdown 会被当成模板。
 * 插件把**用户数据**塞进 `contexts`，就必须显式声明这段文本不参与变量解析：宿主为此
 * 留了 `interpolate: false`（见 `@deepseek-ai/dsh-system-prompt` 的 `renderContextSections`：
 * `context.interpolate === false ? context.text : interpolate(...)`）。
 *
 * 三种会炸的形态都要钉住（空名 / 合法但未注册 / 带符号）：
 *   - `{{ }}`      → malformed（变量名不合法）
 *   - `{{foo_bar}}`→ unknown prompt variable（名字合法但宿主没注册）
 *   - `{{#if x}}`  → malformed（`#` 不在变量名字符集里）
 *
 * 用法: node recall-context-literal-test.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

// ── 沙箱：环境变量必须在动态 import 之前设置（模块顶层读）──────────────
const sandbox = join(tmpdir(), 'sage-mem-recall-literal-' + process.pid)
const memDir = join(sandbox, 'memory')
mkdirSync(memDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')
delete process.env.SAGE_MEM_TASK_ID
delete process.env.SAGE_MEM_DEBUG

const MOD = new URL('../lib/index.js', import.meta.url).href
const MemoryGateway = (await import(MOD)).default

function mem(name, { desc = '无描述', body = '正文。' } = {}) {
  const lines = [
    '---',
    `name: ${name.replace(/\.md$/, '')}`,
    `description: ${desc}`,
    'metadata:',
    '  node_type: memory',
    '  type: reference',
    '---',
    '',
    body,
  ]
  writeFileSync(join(memDir, name), lines.join('\n'), 'utf8')
}

function resetDir() {
  rmSync(memDir, { recursive: true, force: true })
  mkdirSync(memDir, { recursive: true })
}

// ── 万能 ctx（与 inject-test 同一个理由：TypertRemoteService 构造要能取属性）──
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
  stub = new Proxy(function () {}, {
    get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined),
    apply: () => undefined,
  })
  return new Proxy(base, { get(t, p) { return p in t ? t[p] : stub } })
}

function newGateway() {
  const ctx = makeCtx()
  const gw = new MemoryGateway(ctx)
  const hs = ctx.handlers.get('system-prompt/assemble') || []
  if (!hs.length) throw new Error('没有注册 system-prompt/assemble 监听器')
  return { gw, ctx, handler: hs[hs.length - 1] }
}

/** 跑一步 assemble，返回整份 contexts（不是只取文本：要的就是那个标记）。 */
async function step(handler, sessionId, question) {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: question }] },
  ]
  const assembled = {}
  const session = { id: sessionId, deriveMessages: () => messages }
  const out = await handler(assembled, { agent: { session } }, async () => assembled)
  return [...(out?.contexts ?? [])]
}

// ── 宿主同规则的微型复刻（只为「反向对照」，规则抄自 dsh-system-prompt）──
// 出处：`@deepseek-ai/dsh-system-prompt/lib/index.js` 0.2.1-rc 系列
//   VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
//   GROUP_AT      = /^\{\{([^{}]*)\}\}/
//   interpolate(): 命中即解析变量（未注册 → unknown）；`}}` 存在但组不匹配 → malformed。
// 行为差异只在报错文案，判定口径逐字照抄。
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
const GROUP_AT = /^\{\{([^{}]*)\}\}/
function hostInterpolate(text, variables = {}) {
  let out = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) throw new Error('malformed prompt variable reference')
      out += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) throw new Error(`malformed prompt variable reference "{{${name}}}"`)
    if (!Object.hasOwn(variables, name)) throw new Error(`unknown prompt variable "{{${name}}}"`)
    out += text.slice(last, open) + variables[name]
    last = open + group[0].length
  }
  return out + text.slice(last)
}

// ═══ 0. 量具自检：这个复刻真的会按宿主规则抛错 ═══
group('0. 量具自检（复刻的插值器确实会红）')
{
  const thrown = (text) => {
    try { hostInterpolate(text); return null } catch (err) { return err.message }
  }
  ok(!!thrown('前 {{ }} 后'), '空名双大括号会抛 malformed（规则没写反）', String(thrown('前 {{ }} 后')))
  ok(!!thrown('前 {{foo_bar}} 后'), '合法但未注册的名字会抛 unknown', String(thrown('前 {{foo_bar}} 后')))
  ok(thrown('没有双括号的普通正文') === null, '普通正文不抛（复刻不是「一律抛」）')
}

// ═══ 1. 注入的 context 必须声明「这段文本不参与变量解析」═══
group('1. contexts 的 interpolate 标记')
{
  resetDir()
  // 三个形态各一条记忆，正文都是用户随手写的 Markdown。
  mem('literal-empty.md', { desc: 'literalbound 空名', body: '占位符写作 `{{ }}`，中间留空格。' })
  mem('literal-unknown.md', { desc: 'literalbound 未注册', body: '模板变量写法 `{{foo_bar}}`，宿主没注册它。' })
  mem('literal-symbol.md', { desc: 'literalbound 符号', body: '条件写法 `{{#if x}}`，井号不是变量名字符。' })

  const { handler } = newGateway()
  const contexts = await step(handler, 'literal-1', 'literalbound')
  const hit = contexts.find((c) => c?.name === 'sage-mem:recall')

  ok(!!hit, '这一轮确实注入了 sage-mem:recall（没注入的话下面全是空断言）')
  ok(hit?.interpolate === false,
    '注入段显式声明 interpolate: false',
    hit ? JSON.stringify(hit.interpolate) : '没有这个 context')
  ok(hit?.order === 1000, '顺序契约不变（order 仍是 1000）', String(hit?.order))

  const mine = contexts.filter((c) => typeof c?.name === 'string' && c.name.startsWith('sage-mem'))
  ok(mine.length > 0 && mine.every((c) => c.interpolate === false),
    'sage-mem 产出的每个 context 都带了这个标记（以后新增段别忘）',
    JSON.stringify(mine.map((c) => ({ name: c.name, interpolate: c.interpolate }))))

  const text = hit?.text ?? ''
  ok(text.includes('`{{ }}`'), '空名那双大括号原样留在注入文本里', '文本里没有 `{{ }}`')
  ok(text.includes('`{{foo_bar}}`'), '未注册的名字也原样保留')
  ok(text.includes('`{{#if x}}`'), '带符号的写法也原样保留')

  // 再走一步（换问法，避开同签名去重），确认标记是稳定的、不是只第一轮有。
  const contexts2 = await step(handler, 'literal-1', 'literalbound 换个问法')
  const hit2 = contexts2.find((c) => c?.name === 'sage-mem:recall')
  ok(hit2?.interpolate === false, '第二轮注入同样带标记（不是首轮特例）',
    hit2 ? JSON.stringify(hit2.interpolate) : '第二轮没注入')
}

// ═══ 2. 反向对照：同一段正文，默认插值下必炸 ═══
group('2. 反向对照（标记不是装饰）')
{
  resetDir()
  mem('literal-empty.md', { desc: 'literalbound 空名', body: '占位符写作 `{{ }}`，中间留空格。' })
  const { handler } = newGateway()
  const contexts = await step(handler, 'literal-2', 'literalbound')
  const hit = contexts.find((c) => c?.name === 'sage-mem:recall')
  const text = hit?.text ?? ''

  let defaultErr = null
  try { hostInterpolate(text) } catch (err) { defaultErr = err.message }
  ok(!!defaultErr,
    '同样的正文走宿主默认插值会抛错 —— 所以 interpolate: false 是唯一挡住它的东西',
    defaultErr ?? '没有抛（那说明这段正文其实不含危险形态，前面的断言是空绿）')

  // 带标记时宿主走的就是「原样返回」这条分支，不该再经过任何解析。
  ok(hit?.interpolate === false && text.includes('`{{ }}`'),
    '带标记时正文逐字呈现（这一条在标记缺失时一起红，不是两条独立结论）',
    hit ? JSON.stringify(hit.interpolate) : '没有这个 context')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
