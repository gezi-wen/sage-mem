#!/usr/bin/env node
/**
 * host-facts-test.mjs — sage-mem 的「宿主可选能力降级契约」断言（2026-10-15 建）
 *
 * 为什么单开一个套件：inject-test 测的是**行为正确性**（新鲜度、预算、去重），
 * 本文件测的是**生存性** —— 宿主少给一个服务、给个残缺的服务、探测本身抛错时，
 * 记忆注入链必须照常工作。两者的失败面完全不同（一个是「注错了」，一个是「不注了」），
 * 混在一起会把 inject-test 的定位搅浑。
 *
 * 契约出处：阶段一计划的决定 D5「拿不到就不阻断注入链」。
 * 0.9.15 **还不会真注册检索工具**，所以本文件此刻的价值是**前置护栏**：
 *   · 谁以后往构造函数里塞 `ctx.get('tools').register(...)` 而忘了兜异常，
 *     「ctx.get 自己抛错」那组会当场变红；
 *   · 半落地的注册（工具还没接完、register 先跑起来了）会被
 *     「工具服务健康时也一次都不许注册」那组抓住。
 *
 * 两个必须知道的坑（与 inject-test.mjs 同源）：
 *   1. SAGE_MEM_DIR / SAGE_MEM_STATE_DIR 是**模块顶层**读的环境变量 —— 必须在动态
 *      import **之前**设好。静态 import 会被提升到赋值之前，用不得。
 *   2. 万能 Proxy 桩会把**没定义的成员**兜成「可调用函数」—— 想表达「老宿主根本没有
 *      ctx.get」，光不写它是不行的（会拿到桩），必须让 proxy 对 `get` 显式返回 undefined。
 *      第 0 组「量具自检」就是钉这一条的，别删。
 *
 * 用法: node host-facts-test.mjs
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

// ── 沙箱：环境变量必须在 import 之前 ─────────────────────────
const sandbox = join(tmpdir(), 'sage-mem-host-facts-test-' + process.pid)
const memDir = join(sandbox, 'memory')
mkdirSync(memDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const MOD = new URL('../lib/index.js', import.meta.url).href
const mod = await import(MOD)
const MemoryGateway = mod.default

// ── 合成记忆（公开仓库：绝不复制真实记忆） ───────────────────
function resetDir() {
  rmSync(memDir, { recursive: true, force: true })
  mkdirSync(memDir, { recursive: true })
}

function mem(file, desc) {
  const lines = [
    '---',
    `name: ${file.replace(/\.md$/, '')}`,
    `description: ${desc}`,
    'metadata:',
    '  node_type: memory',
    '  type: reference',
    '---',
    '',
    '这是合成正文，用来验证注入链在缺服务的宿主里还活着。',
  ]
  writeFileSync(join(memDir, file), lines.join('\n'), 'utf8')
}

// ── mock ctx ────────────────────────────────────────────────
/**
 * 「工具服务」间谍：既能当健康的服务，也能当半接上的服务（register 抛错）。
 *
 * 为什么要间谍而不是空对象：`一次都没调用 register` 只有在**记得到调用**时才是有意义的
 * 断言。第 0 组会先打一枪确认这个计数器真的会动。
 */
function makeTools({ registerThrows = false } = {}) {
  const calls = []
  const tools = {
    register(def) {
      calls.push(def)
      if (registerThrows) throw new Error('tools.register 半接上了（模拟）')
      return () => {}
    },
    get: () => undefined,
    schemas: () => [],
  }
  return { tools, calls }
}

/**
 * 造 mock ctx。
 *
 * @param options.get — 不传 = **老宿主，没有 ctx.get**；传函数 = 就用它当 ctx.get
 *   （想模拟「返回 undefined / 返回残缺对象 / 自己抛错」都从这里进）。
 */
function makeCtx(options = {}) {
  const hasGet = typeof options.get === 'function'
  const handlers = new Map()
  const warns = []
  const base = {
    on: (ev, h) => {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(h)
    },
    logger: {
      warn: (m) => warns.push(String(m)),
      error: () => {},
      info: () => {},
      debug: () => {},
    },
    // 与 inject-test 同款空实现：cordis 的 effect 会**立即**调一次回调并登记返回的 disposer，
    // 这里不调就少跑一次 autodream 的 dispose，对本文件的断言没有影响。
    effect: () => {},
    handlers,
    warns,
  }
  if (hasGet) base.get = options.get
  // 未知成员一律给一个可调用、且可继续取属性的桩：TypertRemoteService 构造会走
  // `ctx.reflect.provide(...)`，只返回一次 undefined 会在那儿炸。`then` 必须给 undefined，
  // 否则 await 会把桩当 thenable。
  let stub
  stub = new Proxy(function () {}, {
    get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined),
    apply: () => undefined,
  })
  return new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p]
      // 坑 2：`ctx.get` 不存在时必须是 undefined，不能被桩兜成函数
      if (p === 'get') return undefined
      return stub
    },
  })
}

/** 造一条插件实例并拿回 assemble handler。 */
function newGateway(ctx) {
  new MemoryGateway(ctx)
  const hs = ctx.handlers.get('system-prompt/assemble') || []
  if (!hs.length) throw new Error('没有注册 system-prompt/assemble 监听器')
  return hs[hs.length - 1]
}

/**
 * 跑一步 assemble。
 *
 * 返回 `{ text, names }` 而不是单独一段文本：**段名**和**段正文**是两件事，
 * 只拿正文断言段名是假绿（第一版就在这里翻过车）。
 */
async function step(handler, sessionId, question) {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: question }] },
  ]
  const assembled = {}
  const session = { id: sessionId, deriveMessages: () => messages }
  const out = await handler(assembled, { agent: { session } }, async () => assembled)
  const contexts = out?.contexts ?? []
  const hit = contexts.find((c) => c?.name === 'sage-mem:recall')
  return { text: hit ? hit.text : null, names: contexts.map((c) => c?.name) }
}

// ═══ 0. 量具自检：没有这一组，下面的绿可能是假的 ═══
group('0. 量具自检（防假绿）')
{
  const oldHost = makeCtx()
  ok(typeof oldHost.get !== 'function',
    '老宿主 mock 里 ctx.get 不是函数（没被万能桩兜成函数）', typeof oldHost.get)
  ok('get' in oldHost === false, '`get` 连名字都不在（真的模拟「老宿主没有这个成员」）')
  ok(typeof oldHost.timer === 'function',
    '陌生成员仍由桩兜住（TypertRemoteService 构造要靠它）', typeof oldHost.timer)
  ok(typeof oldHost.reflect?.provide === 'function', '桩可以继续取属性（reflect.provide 拿得到）')

  const { tools, calls } = makeTools()
  ok(typeof tools.register === 'function' && calls.length === 0, '工具间谍初始为零')
  tools.register({ name: 'self-check' })
  ok(calls.length === 1, '工具间谍真的会记到调用（所以「零次」不是空断言）')

  const withGet = makeCtx({ get: () => undefined })
  ok(typeof withGet.get === 'function', '显式给了 get 时它就是函数（对照组）')
}

// ═══ 1~6. 逐个缺服务 / 坏服务场景 ═══
/**
 * 每个场景都要回答同一个问题：**注入链还活着吗**。所以断言写法统一 ——
 * 构造不抛、一步 assemble 不抛、记忆照样进文本、降级提示不刷屏、没注册工具。
 */
const SCENARIOS = [
  {
    name: '老宿主：ctx.get 不存在',
    make: () => ({ ctx: makeCtx() }),
  },
  {
    name: 'ctx.get("tools") 返回 undefined',
    make: () => ({ ctx: makeCtx({ get: () => undefined }) }),
  },
  {
    name: 'ctx.get("tools") 返回没有 register 的对象',
    make: () => ({ ctx: makeCtx({ get: (n) => (n === 'tools' ? { get: () => undefined } : undefined) }) }),
  },
  {
    name: 'ctx.get 自己抛错',
    make: () => ({ ctx: makeCtx({ get: () => { throw new Error('probe exploded') } }) }),
    // 这一条会触发 autodream 的降级：engine.start() 里 svc('timer') 也走 ctx.get。
    // 下降级必须**留痕**（warnLog 一行 + console.error 一行），否则「静默不工作」最难查。
    expectOneWarn: true,
  },
  {
    name: '工具服务健康（最像半落地代码会碰到的宿主）',
    make: () => {
      const spy = makeTools()
      return { ctx: makeCtx({ get: (n) => (n === 'tools' ? spy.tools : undefined) }), spy }
    },
  },
  {
    name: 'tools.register 抛错（服务半接上）',
    make: () => {
      const spy = makeTools({ registerThrows: true })
      return { ctx: makeCtx({ get: (n) => (n === 'tools' ? spy.tools : undefined) }), spy }
    },
  },
]

for (let i = 0; i < SCENARIOS.length; i++) {
  const sc = SCENARIOS[i]
  group(`${i + 1}. ${sc.name}`)
  const { ctx, spy } = sc.make()
  const sid = `host-facts-${i}`

  // 降级路径会往 console.error 打栈（lib/index.js 故意的）。收进数组而不是放它污染输出 ——
  // 断言照样查它，只是不让它盖住 PASS/FAIL 行。
  const realError = console.error
  const stderrLines = []
  console.error = (...a) => stderrLines.push(a.map((x) => String(x)).join(' '))

  let handler = null
  let buildErr = ''
  try {
    resetDir()
    mem('probe-hit.md', 'sagebound')
    handler = newGateway(ctx)
  } catch (err) {
    buildErr = err?.message ?? String(err)
  }
  ok(!buildErr, '构造 MemoryGateway 不抛错', buildErr)

  let first = null
  let stepErr = ''
  if (handler) {
    try {
      first = await step(handler, sid, 'sagebound')
    } catch (err) {
      stepErr = err?.message ?? String(err)
    }
  }
  ok(!stepErr, '一次 system-prompt/assemble 不抛错', stepErr)
  const firstText = first?.text ?? null
  ok(!!firstText && firstText.includes('### probe-hit.md'), '记忆照常注入', firstText ? '文本里没有 ### probe-hit.md' : '压根没注入')
  ok(first?.names.includes('sage-mem:recall') === true, '注入段的名字是 sage-mem:recall', JSON.stringify(first?.names ?? []))

  const warnsAfterFirst = ctx.warns.length
  // 再走 5 步、每步换个问法（换签名），专门看降级提示会不会「每步一次」地刷屏
  if (handler) {
    for (let k = 0; k < 5; k++) {
      try {
        await step(handler, sid, `sagebound 换个问法 ${k}`)
      } catch (err) {
        ok(false, '后续步骤不抛错', err?.message ?? String(err))
        break
      }
    }
  }
  const warnsAfterSix = ctx.warns.length
  ok(warnsAfterSix === warnsAfterFirst,
    '后续步骤没有再刷降级提示（不是每步一次）', `${warnsAfterFirst} → ${warnsAfterSix}`)
  ok(warnsAfterSix <= 1, '降级提示最多一次', String(warnsAfterSix))
  if (sc.expectOneWarn) {
    ok(warnsAfterSix === 1, '确实响了**一次**（降级留痕，不是静默）', String(warnsAfterSix))
    ok(stderrLines.some((l) => l.includes('autodream init failed')),
      'stderr 也留了一行（warnLog 在启动阶段可能还没接上 logger）', stderrLines.slice(0, 1).join(' | '))
  }

  const registerCalls = spy ? spy.calls.length : 0
  ok(registerCalls === 0, '0.9.15 不该注册任何工具（ctx.tools.register 零调用）',
    `register 被调了 ${registerCalls} 次`)

  console.error = realError
}

// ═══ 7. 老宿主也要能把原 assembly 原样带出去 ═══
group('7. 老宿主下不破坏宿主已组装的内容')
{
  const ctx = makeCtx()
  const handler = newGateway(ctx)
  resetDir()
  mem('probe-pass.md', 'sagebound')
  const assembled = { sections: ['宿主自己的段'], contexts: [] }
  const session = {
    id: 'host-facts-passthrough',
    deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'sagebound' }] }],
  }
  const out = await handler(assembled, { agent: { session } }, async () => assembled)
  ok(out.sections === assembled.sections && out.sections[0] === '宿主自己的段',
    '宿主原有的 sections 原样保留')
  ok(Array.isArray(out.contexts) && out.contexts.length === 1 && out.contexts[0].name === 'sage-mem:recall',
    'contexts 是「原有的 + 新增的一条」而不是整体替换',
    JSON.stringify(out.contexts?.map((c) => c?.name)))
}

// ── 收尾 ────────────────────────────────────────────────────
rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
