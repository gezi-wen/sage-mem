/**
 * 把 ZCode 外包的《测试用例矩阵》变成可执行断言（主殿自用）。
 * 只挑我原有 5 个套件**没覆盖**的用例；每条注释里保留她给的用例号，便于对账。
 */
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const LIB = new URL('../lib/', import.meta.url)
const { AutodreamEngine } = await import(new URL('autodream.js', LIB).href)
const { createToolRunner } = await import(new URL('autodream-tools.js', LIB).href)
const { auditMemoryDir } = await import(new URL('autodream-audit.js', LIB).href)

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

function makeLlm(script = []) {
  let i = 0
  return {
    async *stream() {
      const chunks = script[Math.min(i, script.length - 1)] ?? []
      i += 1
      for (const c of chunks) yield c
    },
  }
}
const justStop = [{ type: 'finish', reason: { kind: 'stop' } }]
const modelError = [{ type: 'finish', reason: { kind: 'error', failure: { message: '模拟模型挂了' } } }]

async function world({ llm = makeLlm([justStop]), config = {}, sess = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ad-mx-'))
  const memoryDir = join(root, 'memory')
  const sessionsRoot = join(root, 'sessions')
  await mkdir(memoryDir, { recursive: true })
  if (sess) {
    const s = join(sessionsRoot, 'proj', 'sess1')
    await mkdir(s, { recursive: true })
    await writeFile(join(s, 'session.v4.jsonl.zstd'), 'x', 'utf8')
  }
  await writeFile(join(memoryDir, 'a.md'), '---\nname: a\ntype: project\n---\n\n# A\n\n原文\n', 'utf8')
  await writeFile(join(memoryDir, 'MEMORY.md'), '---\nname: memory\n---\n\n# 索引\n', 'utf8')
  const ctx = {
    get: (n) =>
      n === 'llm' ? llm : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined,
    logger: { warn: () => {}, error: () => {} },
  }
  const engine = new AutodreamEngine(ctx, { memoryDir, sessionsRoot })
  await engine.load()
  await engine.setConfig({ enabled: true, trigger: 'auto', minHours: 1, minSessions: 1, apply: true, ...config })
  engine.state.lastRunAt = 0
  await engine.persist()
  return { root, memoryDir, sessionsRoot, engine, ctx }
}

const hashDir = async (dir) => {
  const names = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
  const parts = []
  for (const n of names) {
    const buf = await readFile(join(dir, n))
    const st = await stat(join(dir, n))
    parts.push(`${n}:${createHash('sha256').update(buf).digest('hex')}:${st.mtimeMs}:${st.size}`)
  }
  return parts.join('|')
}

console.log('== LOCK-01 锁竞争：另一趟在跑时第二次 run 拿不到锁 ==')
{
  const { engine } = await world()
  await engine.acquireLock()
  const r = await engine.run({ reason: 'x', force: true })
  ok(r.ok === false && String(r.error).includes('拿不到锁'), '第二次 run 被锁拒绝', JSON.stringify(r))
  await engine.releaseLock()
}

console.log('== LOCK-02/03 死锁过期自愈 vs 新鲜锁拒绝 ==')
{
  const { engine } = await world()
  await mkdir(engine.home, { recursive: true })
  await writeFile(engine.lockPath, JSON.stringify({ pid: 999999, at: Date.now() }), 'utf8')
  const fresh = await engine.run({ reason: 'x', force: true })
  ok(fresh.ok === false, '新鲜锁在 → 拒绝', JSON.stringify(fresh))

  const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
  await utimes(engine.lockPath, old, old)
  const healed = await engine.run({ reason: 'x', force: true })
  ok(healed.ok === true, '陈锁（>2h）自愈 → 照常跑完', JSON.stringify(healed))
}

console.log('== LOCK-04 回滚与运行互斥 ==')
{
  const { engine } = await world()
  const snap = await engine.snapshot('20261001-150000-lk04', 'run')
  engine.running = true
  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'files' })
  engine.running = false
  ok(rb.ok === false && String(rb.error).includes('正在整理中'), '运行中拒绝回滚', JSON.stringify(rb))
  const snaps = await engine.listSnapshots()
  ok(snaps.some((s) => s.name === snap.id), '被拒绝的回滚没有动任何东西（快照还在）')
}

console.log('== DECL-05 变化量与磁盘实测一致 ==')
{
  const { engine, memoryDir } = await world()
  const before = await readFile(join(memoryDir, 'a.md'))
  const runner = createToolRunner({ memoryDir, sessionsRoot: '', apply: true, withSessions: false })
  const next = '---\nname: a\ntype: project\n---\n\n# A\n\n改过的正文，带中文。\n'
  await runner.run('write_memory', { file: 'a.md', content: next, reason: 'DECL-05 变化量' })
  const c = runner.changes()[0]
  const expectAfter = Buffer.byteLength(next, 'utf8')
  const expectDelta = expectAfter - before.length
  ok(c.after.bytes === expectAfter, `after.bytes = 实测字节数（${c.after.bytes} vs ${expectAfter}）`)
  ok(c.before.bytes === before.length, `before.bytes = 实测字节数（${c.before.bytes} vs ${before.length}）`)
  ok(c.deltaBytes === expectDelta, `deltaBytes = 实测差（${c.deltaBytes} vs ${expectDelta}）`)
  ok(c.before.sha256 === createHash('sha256').update(before).digest('hex'), 'before.sha256 与磁盘实测一致')
  void engine
}

console.log('== SNAP-02 保护快照有独立配额，不被普通快照淘汰 ==')
{
  const { engine } = await world({ config: { maxSnapshotKeep: 1 } })
  for (let i = 0; i < 5; i++) await engine.snapshot(`pre-rollback-20261001-15000${i}-aaaa`, 'pre-rollback')
  for (let i = 0; i < 5; i++) await engine.snapshot(`20261001-15000${i}-bbbb`, 'run')
  const snaps = await engine.listSnapshots()
  const pre = snaps.filter((s) => s.name.startsWith('pre-rollback-'))
  const runs = snaps.filter((s) => !s.name.startsWith('pre-rollback-'))
  ok(runs.length === 1, `普通回滚点按 maxSnapshotKeep=1 只剩 1 份（实际 ${runs.length}）`)
  ok(pre.length === 3, `保护快照按独立配额只剩 3 份（实际 ${pre.length}）`)
}

console.log('== SNAP-03 回滚点被淘汰后，运行记录仍列出并标「已不可用」 ==')
{
  const { engine } = await world()
  const snap = await engine.snapshot('20261001-150000-sn03', 'run')
  await engine.writeDeclaration({
    runId: '20261001-150000-sn03', startedAt: Date.now() - 1000, endedAt: Date.now(),
    reason: 'SNAP-03', apply: true, source: 'memory', provider: 'p', model: 'm', fromDefault: false,
    hoursSince: 1, sessionCount: 1, tokensIn: 1, tokensOut: 1, snapshot: snap,
    changes: [], warnings: [], auditBefore: { problems: 0 }, auditAfter: { problems: 0 }, finalText: '',
  })
  let runs = await engine.listRuns()
  ok(runs[0].snapshotAvailable === true, '有快照时 snapshotAvailable=true')

  // 手工模拟「被 maxSnapshotKeep 轮转淘汰」：把快照目录删掉，运行记录留着
  const { rm } = await import('node:fs/promises')
  await rm(join(engine.snapshotRoot, '20261001-150000-sn03'), { recursive: true, force: true })
  runs = await engine.listRuns()
  ok(runs.length === 1, '运行记录本身不会被快照淘汰带走')
  ok(runs[0].snapshotAvailable === false, '快照没了 → snapshotAvailable=false（界面据此说「不可回滚」）')
}

console.log('== AUD-08 审计只读性：跑审计前后目录内容与 mtime 不变 ==')
{
  const { memoryDir } = await world()
  const before = await hashDir(memoryDir)
  await auditMemoryDir(memoryDir)
  await auditMemoryDir(memoryDir)
  const after = await hashDir(memoryDir)
  ok(before === after, '审计不改任何文件（内容 + mtime + 大小）')
}

console.log('== REPORT-04 报告名白名单：`..md` 这类也要拒 ==')
{
  const { engine, memoryDir } = await world()
  await mkdir(join(memoryDir, 'autodream'), { recursive: true })
  await writeFile(join(memoryDir, 'autodream', '20261001-150000.md'), '# ok\n', 'utf8')
  const good = await engine.readReport('20261001-150000.md')
  ok(good.content.includes('ok'), '正常报告名可读')
  for (const bad of ['..md', '../evil.md', 'a/b.md', 'a.txt', '', '.hidden.md']) {
    const threw = await engine.readReport(bad).then(() => false, () => true)
    ok(threw, `非法报告名被拒：${JSON.stringify(bad)}`)
  }
}

console.log('== MODEL-03 开工前的确定性失败不吃失败退避（preflight）==')
{
  // provider 在宿主里不存在 → 运行前就判死
  const badLlm = {
    listProviders: () => [{ id: 'other', name: 'Other' }],
    listModels: async () => [{ id: 'x', name: 'X' }],
    async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
  }
  const { engine } = await world({ llm: badLlm, config: { provider: 'nope', model: 'nope' } })
  const r = await engine.run({ reason: 'preflight', force: true })
  ok(r.ok === false && String(r.error).includes('不存在') || String(r.error).includes('不可用'), '未配置的路线在开工前被判死', JSON.stringify(r))
  const st = await engine.status()
  ok(st.retryAfter === 0, `preflight 失败不吃退避（retryAfter=${st.retryAfter}）——改完配置应当立刻能用`)
  ok(st.lastResult.preflight === true, 'lastResult 标了 preflight=true')
  const snaps = await engine.listSnapshots()
  ok(snaps.length === 0, 'preflight 失败没有产生快照（还没到那一步）')

  // 对照组：运行期故障（模型报错）**要**吃退避
  const { engine: e2 } = await world({ llm: makeLlm([modelError]) })
  await e2.run({ reason: 'runtime', force: true })
  const st2 = await e2.status()
  ok(st2.retryAfter > Date.now(), '运行期故障仍然吃退避（防止偶发故障把门控刷成高频重试）')
  ok(st2.lastResult.preflight === false, '运行期故障标 preflight=false')
  ok(st2.lastResult.changeCount === 0, '运行期故障没有遗留改动')
}

console.log('== RB-9 / D-2 回归：NTFS 大小写失配也能回滚 ==')
{
  const { engine, memoryDir } = await world()
  const runner = createToolRunner({ memoryDir, sessionsRoot: '', apply: true, withSessions: false })
  const snap = await engine.snapshot('20261001-160000-cas1', 'run')
  // 盘上是 a.md，模型给 A.md —— NTFS 下是同一个文件
  await runner.run('write_memory', {
    file: 'A.md',
    content: '---\nname: a\ntype: project\n---\n\n改写后内容\n',
    reason: '大小写失配',
  })
  const c = runner.changes()[0]
  ok(c.file === 'a.md', `变更记录落到磁盘真实名字（实际 ${c.file}）`)
  await engine.writeDeclaration({
    runId: '20261001-160000-cas1', startedAt: Date.now() - 1000, endedAt: Date.now(),
    reason: 'RB-9', apply: true, source: 'memory', provider: 'p', model: 'm', fromDefault: false,
    hoursSince: 1, sessionCount: 1, tokensIn: 1, tokensOut: 1, snapshot: snap,
    changes: runner.changes(), warnings: [], notes: [],
    auditBefore: { problems: 0 }, auditAfter: { problems: 0 }, finalText: '',
  })
  ok((await readFile(join(memoryDir, 'a.md'), 'utf8')).includes('改写后内容'), '写入确实生效（命令与磁盘真实名字是同一个文件）')
  const rb = await engine.rollback({ snapshotId: snap.id, scope: 'files' })
  ok(rb.ok === true && rb.restored === 1, `文件级回滚把原版退回来（restored=${rb.restored}, skipped=${rb.skipped}）`, JSON.stringify(rb))
  ok((await readFile(join(memoryDir, 'a.md'), 'utf8')).includes('原文'), '内容确实是原版')
}

console.log('== AUD-09 / D-1 回归：有一个文件读不动时，审计不裸抛、单列一类 ==')
{
  const { memoryDir } = await world()
  await writeFile(join(memoryDir, 'locked.md'), '---\nname: locked\n---\n\nx\n', 'utf8')
  const { spawnSync } = await import('node:child_process')
  const deny = spawnSync('icacls', [join(memoryDir, 'locked.md'), '/deny', 'Everyone:(R)'], { encoding: 'utf8' })
  const canConstruct = deny.status === 0
  if (!canConstruct) {
    console.log('  SKIP 环境无法构造不可读文件（icacls 失败），本用例不判定')
  } else {
    let threw = null
    let report = null
    try {
      report = await auditMemoryDir(memoryDir)
    } catch (e) {
      threw = e
    }
    // 先恢复权限，否则临时目录清不掉
    spawnSync('icacls', [join(memoryDir, 'locked.md'), '/remove:d', 'Everyone'], { encoding: 'utf8' })
    ok(threw === null, '不可读文件不会让审计裸抛', threw ? threw.message : '')
    if (report) {
      ok(Array.isArray(report.unreadable) && report.unreadable.some((r) => r.file === 'locked.md'),
        '读不动的文件单列在 unreadable 里', JSON.stringify(report.unreadable))
      ok(!report.noFrontmatter.some((r) => r.file === 'locked.md'),
        '读不动的文件**不会**被冤枉成「无 frontmatter」')
      ok(report.problems >= 1, `problems 计入了这一类（${report.problems}）`)
    }
  }
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
