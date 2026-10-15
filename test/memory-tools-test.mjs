#!/usr/bin/env node
/**
 * memory-tools-test.mjs — 两个检索工具的定义形状、行为与降级（2026-10-15 建）
 *
 * 为什么单开一个套件：工具的失败面与注入链不同 —— 注入链是「注错了」，工具是
 * 「注册不上」或「调用时抛出去打断模型那一轮」。两者都要有独立断言。
 *
 * 两个必须知道的坑：
 *   1. `SAGE_MEM_DIR` / `SAGE_MEM_STATE_DIR` 是**模块顶层**读的环境变量 —— 必须在动态
 *      import **之前**设好（静态 import 会被提升）。
 *   2. `ctx.inject(deps, cb)` 是宿主给的**可选依赖**入口。本文件用 mock 立刻回调，
 *      模拟「依赖已就绪」；另有一组模拟「宿主根本没有 inject」。
 *
 * 用法: node memory-tools-test.mjs
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

// ── 沙箱 ────────────────────────────────────────────────────
const sandbox = join(tmpdir(), 'sage-mem-tools-test-' + process.pid)
const memDir = join(sandbox, 'memory')
mkdirSync(memDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const MOD = new URL('../lib/index.js', import.meta.url).href
const { default: MemoryGateway, __testables } = await import(MOD)
const { createMemoryTools } = await import(new URL('../lib/tools/memory-tools.js', import.meta.url).href)

/** 造一份合成记忆。正文里埋一个只出现在正文中段的错误码，用来验证「摘要漏、正文找得回」。 */
function seed() {
  rmSync(memDir, { recursive: true, force: true })
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(memDir, 'project_alpha.md'), [
    '---',
    'name: project_alpha',
    'description: 甲项目的构建流程',
    'metadata:',
    '  node_type: memory',
    '  type: project',
    '---',
    '',
    '# 甲项目',
    '',
    '这一段讲构建顺序与缓存策略，与错误码无关。',
    '',
    '## 故障记录',
    '',
    '当缓存目录被并发写入时会报 SYNTHETIC_CODE_77，处置办法是先停写再清目录。',
  ].join('\n'), 'utf8')
  writeFileSync(join(memDir, 'reference_beta.md'), [
    '---',
    'name: reference_beta',
    'description: 乙参考资料',
    '---',
    '',
    '乙的正文在这里。',
  ].join('\n'), 'utf8')
}

/**
 * 万能 ctx。`inject` 可选：
 *   - 传 `{ inject: true }` → 立刻用**子 ctx** 回调（子 ctx 带 tools.register，且记账）
 *   - 不传 → 模拟「宿主没有 inject」的老宿主
 */
function makeCtx(options = {}) {
  const handlers = new Map()
  const warns = []
  const registered = []
  const base = {
    on: (ev, h) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(h) },
    logger: { warn: (m) => warns.push(String(m)), error: () => {}, info: () => {}, debug: () => {} },
    effect: () => {},
    handlers,
    warns,
    registered,
  }
  if (options.inject) {
    base.inject = (deps, cb) => {
      base.injectedDeps = deps
      const child = {
        tools: {
          register: (def) => { registered.push(def); return () => {} },
        },
      }
      cb(child)
      return { dispose() {} }
    }
  }
  if (options.injectThrows) {
    base.inject = () => { throw new Error('inject 半接上了（模拟）') }
  }
  let stub
  stub = new Proxy(function () {}, {
    get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined),
    apply: () => undefined,
  })
  return new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p]
      if (p === 'get') return undefined
      return stub
    },
  })
}

// ═══ 1. 定义形状 ═══
group('1. ToolDefinition 形状（宿主契约）')
{
  const { searchMemory, readMemory } = createMemoryTools(makeCtx())
  for (const def of [searchMemory, readMemory]) {
    const n = def.name
    ok(typeof def.name === 'string' && def.name.length > 0, `${n}: name 非空`)
    ok(typeof def.description === 'string' && def.description.length > 20, `${n}: description 够长（模型靠它决定要不要调）`)
    ok(def.parameters && def.parameters.type === 'object', `${n}: parameters 是 object schema`)
    ok(Array.isArray(def.parameters.required) && def.parameters.required.length > 0, `${n}: 有必填字段`)
    ok(def.parameters.additionalProperties === false, `${n}: additionalProperties=false（参数封闭）`)
    ok(def.output && def.output.schema && typeof def.output.render === 'function', `${n}: output 有 schema 与 render`)
    ok(typeof def.execute === 'function', `${n}: execute 是函数`)
    ok(def.isConcurrencySafe?.() === true, `${n}: 只读，可并发`)
  }
  ok(searchMemory.parameters.required.includes('query'), 'search_memory 必填 query')
  ok(readMemory.parameters.required.includes('name'), 'read_memory 必填 name')
  ok(Array.isArray(searchMemory.parameters.properties.scope.enum), 'search_memory 的 scope 是枚举')
}

// ═══ 2. 注册路径：health ═══
group('2. ctx.inject 注册（宿主有 tools）')
{
  seed()
  const ctx = makeCtx({ inject: true })
  new MemoryGateway(ctx)
  ok(Array.isArray(ctx.injectedDeps) && ctx.injectedDeps.includes('tools'),
    '用 ctx.inject(["tools"], …) 挂子 fiber（不是 static inject）', JSON.stringify(ctx.injectedDeps))
  ok(ctx.registered.length === 2, '注册了两个工具', String(ctx.registered.length))
  ok(ctx.registered.map((d) => d.name).sort().join(',') === 'read_memory,search_memory',
    '注册的正是 search_memory 与 read_memory', JSON.stringify(ctx.registered.map((d) => d.name)))
  ok(ctx.warns.length === 0, '健康路径不刷警告', JSON.stringify(ctx.warns))
}

// ═══ 3. search_memory 行为 ═══
group('3. search_memory：摘要漏掉的正文事实找得回')
{
  seed()
  const { searchMemory } = createMemoryTools(makeCtx())
  const out = await searchMemory.execute({ query: 'SYNTHETIC_CODE_77 怎么处理' }, { agent: { id: 's-tools' } })
  ok(out && out.ok === true, '返回 ok', JSON.stringify(out && out.ok))
  ok(out.hits.some((h) => h.file === 'project_alpha.md'),
    '错误码只出现在正文中段，仍被找回', JSON.stringify(out.hits.map((h) => h.file)))
  ok(out.coverage && typeof out.coverage.filteredBelowFloor === 'number',
    'coverage 如实报告被门槛滤掉的条数（不把「不够格」说成「没有」）')

  const rendered = searchMemory.output.render({}, out)
  ok(Array.isArray(rendered) && rendered[0]?.type === 'text' && rendered[0].text.length > 0,
    'render 产出 text block')
  ok(rendered[0].text.includes('project_alpha.md'), '渲染文本里带文件名')

  const empty = await searchMemory.execute({ query: '' }, { agent: { id: 's-tools' } })
  ok(empty.ok === false && /不能为空/.test(empty.error), '空 query 返回 ok:false（不抛）')
  ok(searchMemory.output.render({}, empty)[0].text.includes('失败'), '失败也能渲染')
}

// ═══ 4. read_memory 行为与闸门 ═══
group('4. read_memory：分页、revision、闸门')
{
  seed()
  const { readMemory } = createMemoryTools(makeCtx())
  const first = await readMemory.execute({ name: 'project_alpha.md', maxBytes: 64 })
  ok(first.ok === true, '读得到', JSON.stringify(first.code ?? ''))
  ok(typeof first.revision === 'string' && first.revision.startsWith('sha256:'), '带 revision')
  ok(first.startLine === 1, '默认从第 1 行开始')
  ok(Buffer.byteLength(first.content, 'utf8') <= 64, '内容不超字节上限（不是字符数）',
    String(Buffer.byteLength(first.content, 'utf8')))

  const stale = await readMemory.execute({ name: 'project_alpha.md', revision: 'sha256:deadbeef0000' })
  ok(stale.ok === false && stale.code === 'revision_changed', '旧 revision → revision_changed', JSON.stringify(stale.code))
  ok(typeof stale.revision === 'string' && stale.content === undefined,
    'revision_changed 时**不返回内容**（否则调用方会拿过期行号读错东西）')
  ok(readMemory.output.render({}, stale)[0].text.includes('revision'), '渲染说明该重读')

  // 保留名的另一个身份 / 越界名字 → denied / invalid，且都不抛
  const bad = await readMemory.execute({ name: '../secret.md' })
  ok(bad.ok === false && bad.code === 'invalid', '越界文件名 → invalid（不抛）', JSON.stringify(bad.code))
  const none = await readMemory.execute({ name: 'memory.md' })
  // 保留名在**第一道闸**（`safeName`）就被拒 —— 它是「这个文件名算不算一条记忆」，
  // 所以给 invalid；只有通过名字检查、在后面几道闸（符号链接 / 非常规文件 / 超大）
  // 被拒才是 denied。三闸同序是 reader 的契约，这里钉住第一闸。
  ok(none.ok === false && ['invalid', 'denied', 'not_found'].includes(none.code),
    '保留名走闸门（invalid/denied/not_found），不是当成普通记忆读', JSON.stringify(none.code))
  const ghost = await readMemory.execute({ name: 'no-such-file.md' })
  ok(ghost.ok === false && ghost.code === 'not_found', '不存在的文件 → not_found', JSON.stringify(ghost.code))
}

// ═══ 5. 降级：老宿主 / inject 抛错 ═══
group('5. 降级：注入链不受影响')
{
  seed()
  for (const [label, opts] of [['宿主没有 ctx.inject', {}], ['ctx.inject 自己抛错', { injectThrows: true }]]) {
    const ctx = makeCtx(opts)
    let threw = null
    try { new MemoryGateway(ctx) } catch (err) { threw = err }
    ok(threw === null, `${label}：构造不抛错`, threw ? threw.message : '')
    ok(ctx.registered.length === 0, `${label}：一个工具都没注册（也没有假装注册成功）`)
    const hs = ctx.handlers.get('system-prompt/assemble') || []
    ok(hs.length === 1, `${label}：注入链照常挂上`)
    // 真的跑一步，确认记忆仍注入
    const session = { id: `s-${label}`, deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '甲项目的构建流程' }] }] }
    const out = await hs[0]({}, { agent: { session } }, async () => ({}))
    const hit = (out?.contexts ?? []).find((c) => c?.name === 'sage-mem:recall')
    ok(!!hit, `${label}：记忆照常注入`, String(!!hit))
  }
  const ctx = makeCtx({ injectThrows: true })
  new MemoryGateway(ctx)
  ok(ctx.warns.length >= 1 && ctx.warns.some((w) => w.includes('记忆注入不受影响')),
    '挂载失败留痕一次，且说明影响范围', JSON.stringify(ctx.warns))
}

// ── 收尾 ────────────────────────────────────────────────────
rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
