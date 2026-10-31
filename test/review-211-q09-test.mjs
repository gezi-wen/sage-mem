#!/usr/bin/env node
/**
 * review-211-q09-test.mjs — Q09（外部审查 2.1.1）：状态根覆写只对部分模块生效。
 *
 * 症状：`SAGE_MEM_STATE_DIR` 只被配置模块使用；AutodreamEngine 与 lockFileOf 仍从
 * `dirname(memoryDir)` 重拼 `.sage-mem`。于是面板读 custom-state、引擎写默认根 ——
 * 自动做梦的配置、锁、快照各读一套（审查实测 engineRoot 指向默认 `.sage-mem`，
 * 面板 snapshot 返回 report 而引擎 autoArchive=off）。
 *
 * 判据落在**磁盘上的实际落点**：六类状态（配置 / 锁 / 台账 / 冲突 / 检查点 / 快照）
 * 是否都在自定义根下完成往返、默认根是否零新增、旧数据是否「不迁移但明确提示」。
 *
 * 用法: node test/review-211-q09-test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const HERE = fileURLToPath(new URL('.', import.meta.url))
const LIB = join(HERE, '..', 'lib')
const mod = (p) => import(pathToFileURL(join(LIB, p)).href)

// ⚠️ 必须在 import lib 之前设好：路径常量是模块加载时算的（与真实宿主一致）。
const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-q09-'))
const mem = join(sandbox, 'memory')
const customState = join(sandbox, 'custom-state')
const defaultRoot = join(sandbox, '.sage-mem')
mkdirSync(mem, { recursive: true })
mkdirSync(customState, { recursive: true })
for (const k of Object.keys(process.env)) if (k.startsWith('SAGE_MEM_')) delete process.env[k]
process.env.SAGE_MEM_DIR = mem
process.env.SAGE_MEM_STATE_DIR = customState
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const config = await mod('memory/config.js')
const ENGINE_ROOT = config.STATE_ROOT
const lockMod = await mod('memory/lock.js')
const { AutodreamEngine } = await mod('autodream/engine.js')
const { autodreamConfigSnapshot } = await mod('settings.js')
const access = await mod('memory/access.js')
const conflicts = await mod('memory/conflicts.js')
const checkpoint = await mod('memory/checkpoint.js')

const body = (s) => `---\nname: audit\ndescription: quartz nebula\ntype: project\n---\n${s}\n`
const logsOf = () => { const lines = []; const ctx = { logger: { warn: (m) => lines.push(String(m)), error: () => {}, info: () => {} } }; return { ctx, lines } }

// ═══ 1. 装配期路径只解析一次（Q09 的单一来源） ═══
group('1. 装配期解析出 {memoryDir, stateRoot, sessionsRoot}，且尊重 SAGE_MEM_STATE_DIR')
{
  ok(config.MEMORY_DIR === mem && config.STATE_ROOT === customState,
    '模块常量仍按环境变量解析（默认根 = 记忆目录上一层的 .sage-mem 这条不变）',
    JSON.stringify({ memoryDir: config.MEMORY_DIR, stateRoot: config.STATE_ROOT }))
  if (config.PATHS && typeof config.resolvePaths === 'function') {
    ok(config.PATHS.memoryDir === mem && config.PATHS.stateRoot === customState,
      'PATHS 是同一份解析结果（装配方显式传给子模块的源头）', JSON.stringify(config.PATHS))
    const other = config.resolvePaths({ memoryDir: join(sandbox, 'other', 'memory') })
    ok(other.stateRoot === join(sandbox, 'other', '.sage-mem') && other.sessionsRoot === config.SESSIONS_ROOT,
      '【反向对照】显式传别的记忆目录时状态根跟着它派生（覆写不该污染多库场景）', JSON.stringify(other))
  } else {
    ok(false, 'config.js 暴露 resolvePaths/PATHS（装配期一次解析的落点）')
  }
}

// ═══ 2. 引擎与锁表必须用同一个状态根（修前两处都重拼默认根） ═══
group('2. 引擎的 stateRoot 与锁表落点 = 自定义根（修前都指向默认 .sage-mem）')
{
  const { ctx } = logsOf()
  const engine = new AutodreamEngine(ctx, { memoryDir: config.MEMORY_DIR, sessionsRoot: '' })
  ok(engine.stateRoot === customState, 'AutodreamEngine.stateRoot 指向 SAGE_MEM_STATE_DIR',
    `实际 ${engine.stateRoot}`)
  ok(lockMod.lockFileOf(config.MEMORY_DIR) === join(customState, 'locked.json'),
    'lockFileOf 指向自定义状态根下的 locked.json', `实际 ${lockMod.lockFileOf(config.MEMORY_DIR)}`)
  ok(lockMod.lockFileOf(config.MEMORY_DIR) === join(ENGINE_ROOT, 'locked.json'),
    '两条路径确实同一处（引擎状态根 === 锁表所在根）')

  // ── 2b. 六类状态在自定义根完整往返 ──────────────────────────────
  // 配置：写入 → 引擎读回 → **面板侧快照**读到同一份（修前面板读另一套，返回默认 report）
  const cfg = await engine.setConfig({ autoArchive: 'off' })
  ok(cfg.config.autoArchive === 'off' && existsSync(join(customState, 'autodream.json')),
    '配置写进 <自定义根>/autodream.json', JSON.stringify(cfg.config.autoArchive))
  const panel = await autodreamConfigSnapshot()
  ok(panel.autoArchive === 'off', '面板的 autodreamConfigSnapshot 读到同一份配置（修前返回默认 report）',
    `${panel.autoArchive}`)

  // 锁：写入 → 读回 → 归档因锁被拒（完整往返，不是只写不读）
  writeFileSync(join(mem, 'a.md'), body('PROTECTED'), 'utf8')
  await lockMod.setLocked(config.MEMORY_DIR, 'a.md', true)
  ok((await lockMod.readLockState(config.MEMORY_DIR)).locked.has('a.md'), '锁写入后读得回来')
  ok(existsSync(join(customState, 'locked.json')), '锁表落在 <自定义根>/locked.json')
  const { archiveMemory } = await mod('memory/archive.js')
  const denied = await archiveMemory(config.MEMORY_DIR, 'a.md', '手动归档')
  ok(denied.ok === false && denied.code === 'locked', '锁在归档入口真实生效（roundtrip 的闭环）', JSON.stringify(denied))

  // 台账：记一次访问 → 强刷 → 读回
  access.recordAccess(['a.md'], Date.now())
  await access.flushAccess(config.MEMORY_DIR)
  const ledger = await access.readAccessLedger()
  ok(!!ledger['a.md'], '台账条目写进并读得回来', JSON.stringify(Object.keys(ledger)))
  ok(existsSync(join(customState, 'access.json')), '台账落在 <自定义根>/access.json')

  // 冲突：写一条记录 → 列表/读取都能看到
  const record = conflicts.buildConflict({ kind: 'contradiction', file: 'a.md', otherFile: 'b.md', at: Date.now() })
  const written = await conflicts.writeConflict(record)
  ok(written.ok === true, '冲突记录写入成功', JSON.stringify(written).slice(0, 200))
  const listed = await conflicts.listConflictIndex()
  ok(listed.ok === true && listed.items.length === 1 && listed.items[0].id === record.id,
    '冲突记录在 <自定义根>/conflicts 下读得回来', JSON.stringify(listed.items?.map((x) => x.id)))
  ok(existsSync(join(customState, 'conflicts')), '冲突记录落在 <自定义根>/conflicts')

  // 检查点：写 → 读回路径一致
  const cp = await checkpoint.writeCheckpoint('task-g4-q09', '# 检查点\n\n- 任务：task-g4-q09\n')
  ok(cp.ok === true && cp.path.replaceAll('\\', '/').startsWith(customState.replaceAll('\\', '/')),
    '检查点落在 <自定义根>/tasks 下', cp.path)
  const back = await checkpoint.readCheckpoint('task-g4-q09')
  ok(back?.ok === true && String(back.text).includes('task-g4-q09'), '检查点读得回来（完整往返）')

  // 快照：拍一张 → 列得出来
  const snap = await engine.snapshot('g4-q09-run', 'run')
  ok(!!snap && snap.id, '快照创建成功', JSON.stringify(snap)?.slice(0, 120))
  ok(existsSync(join(customState, 'autodream', 'snapshots')), '快照落在 <自定义根>/autodream/snapshots')
  const snaps = await engine.listSnapshots()
  ok(Array.isArray(snaps) && snaps.length === 1, '引擎能列回自己的快照（不是写进另一个根）', JSON.stringify(snaps))

  // ── 2c. 默认根零新增 ───────────────────────────────────────────
  ok(!existsSync(defaultRoot), '覆写生效时默认根 <记忆目录上一层>/.sage-mem **一个文件都没有新增**',
    existsSync(defaultRoot) ? `多了：${readdirSync(defaultRoot).join(', ')}` : '')
}

// ═══ 3. 反向对照：没有覆写时仍按「记忆目录上一层」派生 ═══
group('3. 【反向对照】不设 SAGE_MEM_STATE_DIR 时默认根规则不变')
{
  if (typeof config.resolveStateRoot === 'function') {
    const derived = config.resolveStateRoot(join(sandbox, 'plain', 'memory'))
    ok(derived === join(sandbox, 'plain', '.sage-mem'),
      '别的记忆目录 → 状态跟着它派生（不是永远回落到默认根）', derived)
    ok(config.resolveStateRoot(mem) === customState,
      '默认记忆目录 → 用 SAGE_MEM_STATE_DIR 覆写（两条规则不打架）')
  } else {
    ok(false, 'config.js 暴露 resolveStateRoot（派生规则单一出口）')
  }
  // 装配默认值：不显式给 stateRoot 时，resolvePaths 也走同一条派生
  if (config.PATHS) {
    ok(config.resolvePaths().stateRoot === customState, 'resolvePaths() 缺省也是同一份结果')
  }
}

// ═══ 4. 旧数据：**不自动迁移 + 启动提示一次**，且新根优先 ═══
group('4. 两处都有数据时：新根优先、旧数据原位不动、明确提示不迁移')
{
  // 先给「旧根」（默认根）造数据 —— 此时自定义根里已经有一套新数据
  mkdirSync(defaultRoot, { recursive: true })
  const legacyConfig = join(defaultRoot, 'autodream.json')
  const legacyLock = join(defaultRoot, 'locked.json')
  writeFileSync(legacyConfig, JSON.stringify({ version: 2, config: { autoArchive: 'auto' }, lastRunAt: 0 }), 'utf8')
  writeFileSync(legacyLock, JSON.stringify({ 'legacy-keep.md': true }, null, 2), 'utf8')
  const lockBefore = readFileSync(legacyLock, 'utf8')

  const { ctx, lines } = logsOf()
  const customState2 = join(sandbox, 'custom-state-2')
  mkdirSync(customState2, { recursive: true })
  const engine = new AutodreamEngine(ctx, { memoryDir: config.MEMORY_DIR, stateRoot: customState2 })
  const loaded = await engine.load()
  ok(lines.some((l) => l.includes('旧状态根') && l.includes('不自动迁移')),
    '启动时明确提示「检测到旧状态根 + 不自动迁移」', lines.join(' | ').slice(0, 300))
  ok(lines.some((l) => l.includes('autodream.json') && l.includes('locked.json')),
    '提示里点名旧根里有哪些数据（用户知道要搬什么）', lines.join(' | ').slice(0, 300))
  ok(loaded.config.autoArchive !== 'auto',
    '旧根的配置**不被读取**（新根优先：这是确定的迁移规则，不是「两边随便挑」）', loaded.config.autoArchive)
  ok(readFileSync(legacyLock, 'utf8') === lockBefore && existsSync(legacyConfig),
    '旧数据原样不动（不自动迁移 = 不搬、不删、不改）')
  const countAfterFirst = lines.length
  await engine.load()
  ok(lines.length === countAfterFirst, '提示只打一次（load 会被启动检查与面板反复调，不能刷屏）')

  // 反向对照：旧根没有任何数据时不许乱报
  const fresh = join(sandbox, 'fresh')
  mkdirSync(join(fresh, 'memory'), { recursive: true })
  mkdirSync(join(fresh, 'custom'), { recursive: true })
  const freshLogs = logsOf()
  const engine2 = new AutodreamEngine(freshLogs.ctx, { memoryDir: join(fresh, 'memory'), stateRoot: join(fresh, 'custom') })
  await engine2.load()
  ok(freshLogs.lines.filter((l) => l.includes('旧状态根')).length === 0,
    '【反向对照】旧根没有数据时不乱报（提示不是无条件打印）', freshLogs.lines.join(' | ').slice(0, 200))
}

rmSync(sandbox, { recursive: true, force: true })

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
