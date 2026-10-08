/**
 * typert manifest ↔ 引擎输出的一致性测试（主殿自用）。
 *
 * 为什么必须做：strict 模式的结果 schema 一旦对不上，故障形态不是「某个字段缺失」，
 * 而是整条 remote 调用失败——界面上表现为整片空白，日志里只有一句不痛不痒的校验错。
 * 这些 schema 是手写的，手写就意味着会漂移。
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const LIB = new URL('../lib/', import.meta.url)
const { TYPERT } = await import(new URL('typert.host.js', LIB).href)
const { AutodreamEngine } = await import(new URL('autodream.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`)
  }
}

console.log('== 0. manifest 自身能加载 ==')
const inv = TYPERT.invocations.filter((i) => i.service === 'autodream')
ok(inv.length === 11, `autodream 有 11 条 invocation（实际 ${inv.length}）`)
const byId = new Map(inv.map((i) => [i.method, i]))

console.log('== 1. 造一个引擎实盘 ==')
const root = await mkdtemp(join(tmpdir(), 'ad-typert-'))
const memoryDir = join(root, 'memory')
const stateRoot = join(root, '.sage-mem')
await mkdir(memoryDir, { recursive: true })
await mkdir(stateRoot, { recursive: true })
await writeFile(join(memoryDir, 'a.md'), '---\nname: a\ntype: project\n---\n\n# A\n', 'utf8')
await writeFile(join(memoryDir, 'MEMORY.md'), '---\nname: memory\n---\n\n# 索引\n', 'utf8')
const ctx = { get: () => undefined, logger: { warn: () => {}, error: () => {} } }
const engine = new AutodreamEngine(ctx, { memoryDir, sessionsRoot: '' })

/** 用 manifest 里那条 invocation 的 schema 校验一个返回值。 */
const check = (method, value, label) => {
  const entry = byId.get(method)
  if (!entry) {
    ok(false, `${label}：manifest 里没有 ${method}`)
    return
  }
  const r = entry.result.schema.safeParse(value)
  ok(r.success, `${label} 通过 ${entry.result.typeSymbol} 校验`, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 4)))
}

/** 用 manifest 里声明的参数 schema 校验一次「客户端会发的入参」。 */
const checkArgs = (method, args, label) => {
  const entry = byId.get(method)
  const ps = entry.parameters
  if (!ps.length) {
    ok(args === undefined, `${label}：该方法无参，且我们不传参`)
    return
  }
  const r = ps[0].codec.schema.safeParse(args)
  ok(r.success, `${label} 通过 ${ps[0].codec.typeSymbol} 校验`, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 4)))
}

console.log('== 2. 逐个方法：输出过 schema ==')
await engine.load()
check('getConfig', await engine.getConfig(), 'getConfig')
check('status', await engine.status(), 'status')
check('listReports', await engine.listReports(), 'listReports')
check('listSnapshots', await engine.listSnapshots(), 'listSnapshots')
check('listRuns', await engine.listRuns(20), 'listRuns')
check('listModels', await engine.listModels(), 'listModels')
check('rollback', await engine.rollback({ snapshotId: 'nope', scope: 'files' }), 'rollback(失败分支)')
check('runNow', { ok: true }, 'runNow(点火返回)')
checkArgs('runNow', { reason: '设置页手动触发' }, 'runNow 入参')
checkArgs('listRuns', { limit: 20 }, 'listRuns 入参')
checkArgs('readDeclaration', { runId: 'x' }, 'readDeclaration 入参')
checkArgs('rollback', { snapshotId: 'x', scope: 'files' }, 'rollback 入参')
checkArgs('listModels', undefined, 'listModels 无参')
check('setConfig', await engine.setConfig({ rollbackScope: 'all' }), 'setConfig(含新字段 rollbackScope)')
check('setConfig', await engine.getConfig(), 'getConfig(改配置后)')

console.log('== 3. 有产物之后再过一遍 ==')
const snap = await engine.snapshot('20261001-130000-zzzz', 'run')
check('listSnapshots', await engine.listSnapshots(), 'listSnapshots(有快照)')
const { createToolRunner } = await import(new URL('autodream-tools.js', LIB).href)
const runner = createToolRunner({ memoryDir, sessionsRoot: '', apply: true, withSessions: false })
await runner.run('write_memory', { file: 'b.md', content: '---\nname: b\n---\n\n新\n', reason: '新增一条测试记忆' })
await engine.writeDeclaration({
  runId: '20261001-130000-zzzz',
  startedAt: Date.now() - 5000,
  endedAt: Date.now(),
  reason: '测试',
  apply: true,
  source: 'memory',
  provider: 'p',
  model: 'm',
  fromDefault: false,
  hoursSince: 1,
  sessionCount: 1,
  tokensIn: 1,
  tokensOut: 1,
  snapshot: snap,
  changes: runner.changes(),
  warnings: runner.warnings(),
  auditBefore: { problems: 0 },
  auditAfter: { problems: 0 },
  finalText: 'ok',
})
check('listRuns', await engine.listRuns(20), 'listRuns(有记录)')
check('readDeclaration', await engine.readDeclaration('20261001-130000-zzzz'), 'readDeclaration(有记录)')
check('listReports', await engine.listReports(), 'listReports(仍为空，不该炸)')
check('rollback', await engine.rollback({ snapshotId: '20261001-130000-zzzz', scope: 'files' }), 'rollback(成功分支)')
check('status', await engine.status(), 'status(跑完一次之后)')

console.log('== 4. 有真 llm 服务时：目录枚举 + 运行前存在性校验 ==')
const fakeLlm = {
  listProviders: () => [
    { id: 'p1', name: 'P1 渠道' },
    { id: 'p2', name: 'P2 渠道' },
  ],
  listModels: async (pid) => {
    if (pid === 'p1') return [{ id: 'm1', name: 'M1 模型' }, { id: 'm2', name: 'M2 模型' }]
    if (pid === 'p2') throw new Error('这条渠道的 key 过期了')
    return []
  },
}
const fakeCtx = {
  get: (name) => (name === 'llm' ? fakeLlm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p2', model: 'm9' }) } : undefined),
  logger: { warn: () => {}, error: () => {} },
}
const e2 = new AutodreamEngine(fakeCtx, { memoryDir, sessionsRoot: '' })
const cat = await e2.listModels()
ok(cat.catalogAvailable === true, 'catalogAvailable=true')
ok(cat.routes.some((r) => r.provider === 'p1' && r.model === 'm1' && r.label.includes('M1 模型')), 'p1/m1 在目录里且带显示名')
ok(cat.routes.some((r) => r.provider === 'p2' && r.model === 'm9' && r.isDefault === true), '默认模型 p2/m9 被补进目录并标 isDefault')
ok(cat.routes.filter((r) => r.provider === 'p2').length === 1, 'p2 抛错的那条没把整表拖垮，只留默认那条')
check('listModels', cat, 'listModels(有 llm)')
check('getConfig', await e2.getConfig(), 'getConfig(有默认模型 → route.source=default)')
ok((await e2.getConfig()).route.source === 'default', '有默认模型时 route.source=default')

const a1 = await e2.checkRouteAvailable('p1', 'm1')
ok(a1.ok === true && a1.checked === true, 'p1/m1 存在 → 放行且已校验')
const a2 = await e2.checkRouteAvailable('p1', '不存在')
ok(a2.ok === false && a2.reason.includes('没有模型'), 'p1 目录里没有该模型 → 拒绝', a2.reason)
const a3 = await e2.checkRouteAvailable('p9', 'm1')
ok(a3.ok === false && a3.reason.includes('provider'), '宿主没注册该 provider → 拒绝', a3.reason)
const a4 = await e2.checkRouteAvailable('p2', 'm9')
ok(a4.ok === false, 'provider 的 listModels 抛错 → 拒绝而不是静默放行', a4.reason)
const llmEmpty = { listProviders: () => [{ id: 'pe', name: 'PE' }], listModels: async () => [] }
const e3 = new AutodreamEngine({ get: (n) => (n === 'llm' ? llmEmpty : undefined), logger: { warn: () => {}, error: () => {} } }, { memoryDir, sessionsRoot: '' })
const a5 = await e3.checkRouteAvailable('pe', '任何模型')
ok(a5.ok === true && a5.checked === false, '目录为空 → 放行但标记未校验（不能误杀）', a5.reason)
const e4 = new AutodreamEngine({ get: () => undefined, logger: { warn: () => {}, error: () => {} } }, { memoryDir, sessionsRoot: '' })
const a6 = await e4.checkRouteAvailable('p', 'm')
ok(a6.ok === true && a6.checked === false, 'llm 服务不可用 → 放行（不因宿主差异阻塞整理）', a6.reason)

console.log(`\n结果：${pass} passed, ${fail} failed  （临时目录 ${root}）`)
process.exit(fail ? 1 : 0)
