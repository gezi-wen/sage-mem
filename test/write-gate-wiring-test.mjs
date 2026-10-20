#!/usr/bin/env node
/**
 * write-gate-wiring-test.mjs — 验**接线**，不验判定表（2026-10-15 建）
 *
 * 分工：`write-gate-test.mjs` 验纯函数（给定事实 → 给什么意图）；
 * 宿主侧的事实（事件会不会发、处理器里拿不拿得到 fs、守卫会不会被强制执行）由
 * `scripts/events-probe.mjs` / `scripts/fs-probe.mjs` 在**真实宿主**里实测。
 * 本套件补的是中间那段胶水 —— 它最容易出的两个错都不是逻辑错，而是**语义错**：
 *
 *   1. **目录外还去调 `next()`**：宿主对任何工具写文件都发这个事件，无条件往下推
 *      等于给整个系统的每次写入都加一次 stat，而我们本来什么都不该做。
 *   2. **调了 `next()` 却把结果丢掉**：`next()` 返回的是下游/调用方已经做出的决定，
 *      再 `return undefined` 会让「不干涉」变成「把别人的决定抹掉」。
 *
 * 这两条都是实际踩出来的，所以它们各有一条断言专门钉住。
 *
 * 用法: node write-gate-wiring-test.mjs
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-gate-wiring-'))
const memDir = join(sandbox, 'memory')
mkdirSync(memDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const { default: MemoryGateway } = await import(new URL('../lib/index.js', import.meta.url).href)

/**
 * 假宿主 ctx。`fs` 可开关：关掉时验「拿不到服务也不炸」。
 * `statCalls` 记账 —— 「目录外不调 next() / 不 stat」这两条靠它证。
 */
function makeCtx(opts = {}) {
  const handlers = new Map()
  const registered = new Map()          // 事件名 → 本插件注册的处理器
  const statCalls = []
  const base = {
    on: (ev, h) => {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(h)
      if (!registered.has(ev)) registered.set(ev, [])
      registered.get(ev).push(h)
    },
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    effect: () => {},
    handlers,
    registered,
    statCalls,
  }
  if (opts.fs !== false) {
    const versions = opts.versions ?? {}
    base.get = (name) => {
      if (name !== 'fs') return undefined
      return {
        stat: async (target) => {
          statCalls.push(target?.displayPath ?? null)
          const v = versions[target?.displayPath]
          return v ? { version: v, type: 'file' } : undefined
        },
        resolve: async (p) => ({ targetKey: 'k:' + p, displayPath: p }),
        writeText: async () => ({ operation: 'update', version: 'v-new', before: 'x', after: 'y' }),
      }
    }
  }
  let stub
  stub = new Proxy(function () {}, { get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined), apply: () => undefined })
  return new Proxy(base, { get: (t, p) => (p in t ? t[p] : (p === 'get' ? undefined : stub)) })
}

const MEM_FILE = join(memDir, 'project_alpha.md')
const OUT_FILE = join(sandbox, 'elsewhere.md')

/** 装好插件，返回两个事件的处理器。next() 的返回值由调用方给。 */
function setup(opts = {}) {
  const ctx = makeCtx(opts)
  new MemoryGateway(ctx)
  const handlersFor = (ev) => ctx.registered.get(ev) ?? []
  return {
    ctx,
    writeIntent: handlersFor('fs/write-intent').at(-1),
    editIntent: handlersFor('fs/edit-intent').at(-1),
  }
}
const target = (p) => ({ targetKey: 'k:' + p, displayPath: p })

// ═══ 1. 事件真的被订阅了 ═══
group('1. 订阅')
{
  const { writeIntent, editIntent } = setup()
  ok(typeof writeIntent === 'function', '订阅了 fs/write-intent')
  ok(typeof editIntent === 'function', '订阅了 fs/edit-intent')
}

// ═══ 2. 目录外：不碰链子（两条纪律） ═══
group('2. 目录外：既不 stat，也不吞 next() 的结果')
{
  const { ctx, writeIntent } = setup({ versions: {} })
  let nextCalls = 0
  const downstream = { kind: 'replaceIfVersion', version: 'caller-version' }
  const got = await writeIntent(target(OUT_FILE), undefined, async () => { nextCalls++; return downstream })
  ok(got === downstream, '目录外把 next() 的结果**原样交回**（不吞掉别人的决定）', JSON.stringify(got))
  ok(nextCalls === 1, '目录外只调一次 next()（不是两次）', String(nextCalls))
  ok(ctx.statCalls.length === 0, '目录外**一次 stat 都不做**（不给全系统的写入加系统调用）', JSON.stringify(ctx.statCalls))
}
{
  const { writeIntent } = setup()
  let nextCalls = 0
  const got = await writeIntent(target(OUT_FILE), undefined, async () => { nextCalls++; return undefined })
  ok(got === undefined && nextCalls === 1, '目录外且下游也无决定时返回 undefined（等价于没干预过）')
}
{
  // 前缀陷阱必须走「目录外」这条路
  const { ctx, writeIntent } = setup()
  const sibling = { targetKey: 'k', displayPath: memDir + '-evil/x.md' }
  let nextCalls = 0
  await writeIntent(sibling, undefined, async () => { nextCalls++; return undefined })
  ok(nextCalls === 1 && ctx.statCalls.length === 0, '前缀陷阱兄弟目录按「目录外」处理（不 stat）')
}

// ═══ 3. 目录内：补上版本守卫 ═══
group('3. 目录内：给写入补版本守卫')
{
  const V = 'fsv:current-1'
  const { ctx, writeIntent } = setup({ versions: { [MEM_FILE]: V } })
  const got = await writeIntent(target(MEM_FILE), undefined, async () => undefined)
  ok(got && got.kind === 'replaceIfVersion' && got.version === V,
    '目标存在 → replaceIfVersion + 当前版本（版本原样透传）', JSON.stringify(got))
  ok(ctx.statCalls.length === 1, '目录内恰好 stat 一次', String(ctx.statCalls.length))
}
{
  const { writeIntent } = setup({ versions: {} })   // stat 拿不到 → 不存在
  const got = await writeIntent(target(MEM_FILE), undefined, async () => undefined)
  ok(got && got.kind === 'createIfAbsent', '目标不存在 → createIfAbsent（不可能静默覆盖）', JSON.stringify(got))
}
{
  // 拿不到版本（exists 未知）→ 走 unknown，不许退化成 createIfAbsent
  const ctx = makeCtx({ fs: false })
  new MemoryGateway(ctx)
  const h = (ctx.registered.get('fs/write-intent') ?? []).at(-1)
  const got = await h(target(MEM_FILE), undefined, async () => undefined)
  ok(got === undefined, '拿不到 fs 服务 → 无决定（不猜、不退化）', JSON.stringify(got))
}

// ═══ 4. 尊重调用方 ═══
group('4. 调用方已有意图 → 原样透传')
{
  const V = 'fsv:current-2'
  const { writeIntent } = setup({ versions: { [MEM_FILE]: V } })
  const mine = { kind: 'createIfAbsent' }
  const got = await writeIntent(target(MEM_FILE), undefined, async () => mine)
  ok(got === mine, '调用方要 createIfAbsent，我们不改成 replaceIfVersion（同一个对象）', JSON.stringify(got))
}

// ═══ 5. 编辑侧 ═══
group('5. 编辑侧守卫')
{
  const V = 'fsv:current-3'
  const { editIntent } = setup({ versions: { [MEM_FILE]: V } })
  const got = await editIntent(target(MEM_FILE), undefined, async () => undefined)
  ok(got && got.version === V, '存在 → 给 {version} 守卫', JSON.stringify(got))
}
{
  const { editIntent } = setup({ versions: {} })
  const got = await editIntent(target(MEM_FILE), undefined, async () => undefined)
  ok(got === undefined, '文件不存在 → 编辑不给守卫（编辑不该创建文件）', JSON.stringify(got))
}
{
  const { editIntent } = setup({ versions: {} })
  let nextCalls = 0
  const got = await editIntent(target(OUT_FILE), undefined, async () => { nextCalls++; return { version: 'caller' } })
  ok(got && got.version === 'caller' && nextCalls === 1, '目录外编辑：原样交回调用方的守卫')
}

// ═══ 6. 绝不抛出写入链路 ═══
group('6. 异常一律退化成「不管」')
{
  const { writeIntent } = setup()
  // next() 自己抛 —— 写门在宿主的写入链路上，绝不能把异常往外放
  let threw = false
  let got
  try { got = await writeIntent(target(MEM_FILE), undefined, async () => { throw new Error('下游炸了') }) } catch { threw = true }
  ok(!threw, '下游抛错时我们不把它放出去')
  ok(got === undefined, '退化成 undefined（让宿主按默认语义继续）', JSON.stringify(got))
}
{
  const { writeIntent } = setup()
  let got
  try { got = await writeIntent(undefined, undefined, async () => undefined) } catch { got = 'THREW' }
  ok(got === undefined, 'target 是 undefined 也不抛', String(got))
}

// ═══ 7. 注册方式守卫（源代码级） ═══
group('7. 注册方式：不许挪进 ctx.inject（注册窗口）')
{
  // 这一组补的是**真实宿主才暴露的那类失败**：`fs/write-intent` 有注册窗口，
  // 窗口在 fs 服务就绪之前就关了。按本仓库自己的 D5 规范（可选服务用 ctx.inject 挂子 fiber）
  // 去「顺手规范化」这段注册，写门会**静默失效** —— 编译过、上面的 DOM 断言全绿、
  // 事件永远不来。套件里那几条行为断言**结构上抓不到**这种改动，只能看源码。
  //
  // 依据：docs/host-facts.md 3.3 节的七组对照（不 inject 收到 1 次；顶层 inject / 子 fiber / 晚挂都是 0 次）。
  //
  // ⚠️ 1.2.0 把这段注册搬进 `lib/assembly/write-gate-mount.js`：守卫的**目标文件跟着搬**，
  // 并**新增**一条「组合根真的调了 mountWriteGate」的断言 —— 只迁不补，等于允许
  // 「模块写得对、但没人调用」。删守卫是错的做法，不是修红。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/assembly/write-gate-mount.js', import.meta.url), 'utf8')
  const rootSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // ⚠️ 判「有没有做某件坏事」必须**先剥掉注释**：那段警示注释里正写着
  // `ctx.inject(['fs'], …)` 这个反例，不剥就会把自己的警告当成违规（初版就这么红的）。
  // 剥法很朴素（`//` 到行尾、`/* */` 成对），可能误伤字符串里的 `//`；
  // 但这里只用于「不存在」判断，误伤的后果是**漏报**不是误报 —— 方向是安全的。
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const code = strip(src)
  const rootCode = strip(rootSrc)

  ok(/ctx\.on\('fs\/write-intent'/.test(code), '直接在 apply 里注册 fs/write-intent')
  ok(/ctx\.on\('fs\/edit-intent'/.test(code), '直接在 apply 里注册 fs/edit-intent')
  ok(!/ctx\.inject\(\s*\[\s*'fs'/.test(code),
    '**没有**把写门挪进 ctx.inject([\'fs\']) —— 那会让它静默失效（七组对照）')
  ok(!/inject\s*=\s*\[[^\]]*'fs'/.test(code),
    '**没有**给插件加含 fs 的静态 inject（同样是注册窗口问题）')
  ok(/ctx\.get\('fs'\)/.test(code), '服务在**处理器内部**用 ctx.get 取（所以不需要 inject）')
  ok(/注册窗口/.test(src),
    '代码旁留着「注册窗口」的警示 —— 删了它，下一个人就会顺手把这段改规范')
  // 关键补充：模块本身再对，没人调用也是白搭。组合根必须**同步直调** mountWriteGate。
  ok(/mountWriteGate\(ctx,\s*MEMORY_DIR\)/.test(rootCode),
    '组合根在构造函数里直接调用 mountWriteGate(ctx, MEMORY_DIR)')
  ok(!/ctx\.inject\(/.test(rootCode),
    '组合根里没有 ctx.inject（写门一旦被塞进子 fiber 就收不到事件）')
  // 反向对照：判据本身要能认出「被挪进 inject」的写法，否则上面那两条可能是空转
  const movedSrc = src.replace("ctx.on('fs/write-intent'", "ctx.inject(['fs'], () => { ctx.on('fs/write-intent'")
  ok(/ctx\.inject\(\s*\[\s*'fs'/.test(movedSrc),
    '【反向对照】把注册挪进 inject 之后，判据确实会命中')
}

rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
