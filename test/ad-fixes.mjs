/**
 * 针对一批并发与边界缺陷的回归测试。
 *   R-8 自动触发被扫描节流双重门控卡死
 *   R-5 改名过渡期新旧两把锁互不相识
 *   R-6 快照不完整仍开工 → 残缺回滚点
 *   R-7 运行中途失败留下「有改动、无声明」的孤儿改动
 */
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const LIB = new URL('../lib/', import.meta.url)
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

/** 造一个只按剧本吐 chunk 的假 llm。 */
function makeLlm(script) {
  let i = 0
  return {
    async *stream() {
      const chunks = script[Math.min(i, script.length - 1)]
      i += 1
      for (const c of chunks) yield c
    },
    calls: () => i,
  }
}
const writeCall = (file, reason) => [
  {
    type: 'block-end',
    index: 1,
    block: {
      type: 'tool-call',
      id: 'c1',
      name: 'write_memory',
      arguments: JSON.stringify({ file, content: `---\nname: ${file.replace('.md', '')}\n---\n\n新内容\n`, reason }),
    },
  },
  { type: 'finish', reason: { kind: 'stop' } },
]
const justStop = [{ type: 'finish', reason: { kind: 'stop' } }]
const modelError = [{ type: 'finish', reason: { kind: 'error', failure: { message: '模拟模型挂了' } } }]

async function makeWorld({ llm, config = {} }) {
  const root = await mkdtemp(join(tmpdir(), 'ad-fix-'))
  const memoryDir = join(root, 'memory')
  const sessionsRoot = join(root, 'sessions')
  await mkdir(memoryDir, { recursive: true })
  // 造一个「有更新的会话」，好让会话门能过
  const s = join(sessionsRoot, 'proj', 'sess1')
  await mkdir(s, { recursive: true })
  await writeFile(join(s, 'session.v4.jsonl.zstd'), 'x', 'utf8')
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
  // lastRunAt 归零 → 时间门必过
  engine.state.lastRunAt = 0
  await engine.persist()
  return { root, memoryDir, sessionsRoot, engine }
}

console.log('== R-8：自动触发不能被自己的扫描节流挡死 ==')
{
  const { engine } = await makeWorld({ llm: makeLlm([justStop]) })
  const g = await engine.gate()
  ok(g.ok === true, '门控本身通过（时间门 + 会话门）', JSON.stringify(g))

  // 先证明「旧写法确实会死」—— 必须自己复现出来才算数，不能只凭推理
  const buggy = await engine.run({ reason: '自动（门控通过）' })
  ok(buggy.ok === false && String(buggy.error).includes('节流'), '旧写法（run 内再跑一次 gate）确实被节流挡回', JSON.stringify(buggy))

  // 新写法：把门控结果带进去
  engine.state.lastRunAt = 0
  const fixed = await engine.run({ reason: '自动（门控通过）', gateResult: g })
  ok(fixed.ok === true, '新写法（带 gateResult）真的跑起来了', JSON.stringify(fixed))
  const st = await engine.status()
  ok(st.lastResult && st.lastResult.ok === true, 'lastResult 记录为成功')
  ok(st.lastResult.runId === fixed.runId, 'lastResult.runId 与本次一致')
}

console.log('== R-6：快照返回完整性信息 ==')
{
  const { engine, memoryDir } = await makeWorld({ llm: makeLlm([justStop]) })
  const snap = await engine.snapshot('20261001-140000-aaaa', 'run')
  ok(Array.isArray(snap.failed) && snap.failed.length === 0, '正常快照 failed 为空数组')
  ok(snap.expected >= 2 && snap.count === snap.expected, `expected 与 count 一致（${snap.count}/${snap.expected}）`)
  const m = JSON.parse(await readFile(join(engine.snapshotRoot, '20261001-140000-aaaa', 'MANIFEST.json'), 'utf8'))
  ok(Array.isArray(m.failed), 'MANIFEST 里也写了 failed 字段')
  void memoryDir
}

console.log('== R-5：旧版锁在过渡期必须挡住新版 ==')
{
  const { engine } = await makeWorld({ llm: makeLlm([justStop]) })
  await mkdir(engine.stateRoot, { recursive: true })
  await writeFile(engine.legacyLockPath, JSON.stringify({ pid: 1, at: Date.now() }), 'utf8')
  const got = await engine.acquireLock()
  ok(got === false, '新鲜的 dream.lock 存在时，新版拒绝拿锁')
  // 过期的旧锁不该永久挡路
  const old = new Date(Date.now() - 5 * 60 * 60 * 1000)
  const { utimes } = await import('node:fs/promises')
  await utimes(engine.legacyLockPath, old, old)
  const got2 = await engine.acquireLock()
  ok(got2 === true, '过期的 dream.lock 不再挡路（否则新版永远回不来）')
  await engine.releaseLock()
}

console.log('== R-7：中途失败也要留下「已改了什么」的声明 ==')
{
  const { engine, memoryDir } = await makeWorld({ llm: makeLlm([writeCall('c.md', '新增一条测试记忆'), modelError]) })
  const r = await engine.run({ reason: '手动触发', force: true })
  ok(r.ok === false, '运行确实失败了（模型报错）', JSON.stringify(r))
  const onDisk = await readFile(join(memoryDir, 'c.md'), 'utf8').catch(() => null)
  ok(onDisk !== null, '失败前那一条已经落盘（孤儿改动真实存在）')

  const runs = await engine.listRuns()
  ok(runs.length === 1, `留下了 1 条运行记录（实际 ${runs.length}）`)
  ok(runs[0].changeCount === 1, `记录里写着 1 条改动（实际 ${runs[0].changeCount}）`)
  ok(String(runs[0].reason).includes('中断'), '运行记录标了「中断」', runs[0].reason)
  const decl = await engine.readDeclaration(runs[0].runId)
  ok(decl.markdown.includes('新增一条测试记忆'), '声明里带着那条改动的缘由')
  ok(decl.markdown.includes('运行中断'), '声明正文写明运行中断')
  ok(decl.manifest.warnings.some((w) => String(w).includes('中断')), 'warnings 里记了中断原因')
  const st = await engine.status()
  ok(st.lastResult.changeCount === 1, 'lastResult 也带上了已发生改动的条数')
  ok(!!st.lastResult.snapshotId, 'lastResult 带上了回滚点（此刻仍然可用）')
  const snaps = await engine.listSnapshots()
  ok(snaps.some((s) => s.name === st.lastResult.snapshotId), '那个回滚点真的在盘上')
}

console.log('== 回归：正常路径不受影响 ==')
{
  // 剧本要以 justStop 收尾 —— makeLlm 会把最后一段无限重复，少写这一段就会跑满 maxSteps
  const { engine, memoryDir } = await makeWorld({ llm: makeLlm([writeCall('d.md', '正常写一条'), justStop]) })
  const r = await engine.run({ reason: '手动触发', force: true })
  ok(r.ok === true && r.changeCount === 1, '正常一趟仍然成功', JSON.stringify(r))
  ok((await stat(join(memoryDir, 'd.md')).then(() => true, () => false)) === true, '写入生效')
  const rb = await engine.rollback({ snapshotId: r.snapshotId, scope: 'files' })
  ok(rb.ok === true && rb.parked === 1, '回滚仍然把新建的文件移进 archive/')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
