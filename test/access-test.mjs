/**
 * C1 行为断言：访问台账 / 自动归档候选 / SAGE_MEM_DEBUG 可观测性。
 *
 * 三个场景必须在 import lib 之前改环境变量（模块顶层读 env），所以：
 *   - 「台账写不进去」用子进程跑（`--child-ledger-fail`）；
 *   - 「DEBUG 打开」用带 query 的重复 import 拿到一份重新求值的 index.js；
 *   - 其余在父进程里跑。
 * 全程只碰临时目录（SAGE_MEM_DIR / SAGE_MEM_STATE_DIR）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const IS_CHILD_LEDGER = process.argv.includes('--child-ledger-fail')

const sandbox = join(tmpdir(), `sage-mem-access-test-${process.pid}${IS_CHILD_LEDGER ? '-ledgerfail' : ''}`)
const memDir = join(sandbox, 'memory')
const stateDir = IS_CHILD_LEDGER ? join(sandbox, 'blocker', 'state') : join(sandbox, '.sage-mem')
mkdirSync(memDir, { recursive: true })
mkdirSync(join(sandbox, 'dsh-home'), { recursive: true })
// 子进程场景：状态目录的父路径是个**文件** → mkdir 必失败 → 台账永远写不进去
if (IS_CHILD_LEDGER) writeFileSync(join(sandbox, 'blocker'), 'not a directory\n')
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const LIB = new URL('../lib/', import.meta.url)
const mod = await import(new URL('index.js', LIB).href)
const access = await import(new URL('memory/access.js', LIB).href)
const scan = await import(new URL('memory/scan.js', LIB).href)
const adMod = await import(new URL('autodream.js', LIB).href)
const { DEFAULT_CONFIG } = await import(new URL('autodream/config.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LEDGER = access.ACCESS_LEDGER_FILE

// ── 夹具 ──────────────────────────────────────────────────────
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
/** 写一条记忆：updated 用来控制「多久没被用过」。 */
function writeMem(name, { type = name.split('_')[0], description = '', updated = '', baseline = false, body = '正文' } = {}) {
  const lines = ['---', `name: ${name.replace(/\.md$/, '')}`, `type: ${type}`]
  if (description) lines.push(`description: ${description}`)
  if (updated) lines.push(`updated: ${updated}`)
  if (baseline) lines.push('baseline: true')
  lines.push('---', '', `# ${name}`, '', body, '')
  writeFileSync(join(memDir, name), lines.join('\n'), 'utf8')
}

const TOKEN = '台账阿尔法令牌'
writeMem('project_a.md', { description: `有一条 ${TOKEN} 的记忆`, updated: daysAgo(1) })

/** 假 ctx：cordis 的 Service 构造要 ctx.reflect.*，未知成员给可调用的桩。 */
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

/** 跑一步注入，返回 recall 文本（没注入就是空串）。 */
let seq = 0
function makeInjector(memoryGateway) {
  const ctx = memoryGateway.ctx
  const assemble = (ctx.handlers.get('system-prompt/assemble') ?? []).at(-1)
  return async function inject(question) {
    const msgs = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: question }] }]
    const session = { id: `access-test-${++seq}`, deriveMessages: () => msgs }
    const assembled = {}
    const out = await assemble(assembled, { agent: { session } }, async () => assembled)
    return (out?.contexts ?? []).find((c) => c?.name === 'sage-mem:recall')?.text ?? ''
  }
}

// ── 子进程：台账写不进去时注入仍必须成功 ─────────────────────
if (IS_CHILD_LEDGER) {
  const gw = new mod.default(makeCtx())
  const inject = makeInjector(gw)
  const text = await inject(TOKEN)
  ok(text.includes('project_a.md'), '注入成功（有 recall 文本）')
  ok(!existsSync(LEDGER), '台账确实写不进去（文件不存在）')
  // 回收 + 落盘一起失败：必须静默降级、不抛
  access.recordAccess(['project_a.md'])
  let flushRes = null
  let flushThrew = null
  try { flushRes = await access.flushAccess() } catch (e) { flushThrew = e }
  ok(flushThrew === null && flushRes?.ok === false, '回收/落盘失败也不抛（静默降级）', flushThrew ? String(flushThrew.message) : JSON.stringify(flushRes))
  console.log(`\n结果：${pass} passed, ${fail} failed`)
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(fail ? 1 : 0)
}

const gw = new mod.default(makeCtx())
const inject = makeInjector(gw)

// ── 1. 注入 → 台账（含节流）─────────────────────────────────
group('1. 注入一次 → 台账记下来；30 秒内只落盘一次')
const memBytesBefore = readFileSync(join(memDir, 'project_a.md'), 'utf8')
const memMtimeBefore = statSync(join(memDir, 'project_a.md')).mtimeMs
let firstStamp = 0
{
  const t0 = Date.now()
  const text = await inject(TOKEN)
  ok(text.includes('project_a.md'), '注入一次能命中 project_a.md')
  await sleep(40) // 等 debounce（首次 flush 是 setTimeout 0）
  ok(existsSync(LEDGER), '台账文件出现了（状态目录下）')
  const ledger = await access.readAccessLedger()
  firstStamp = ledger['project_a.md']
  ok(Number.isFinite(firstStamp), '台账里有 project_a.md')
  ok(Number.isFinite(firstStamp) && Math.abs(firstStamp - t0) < 5000, '时间戳是本次注入的', String(firstStamp))
  ok(LEDGER.startsWith(stateDir), '台账落在状态目录，不在记忆目录', LEDGER)
  // 硬约束：绝不往记忆文件里写 last_accessed
  ok(readFileSync(join(memDir, 'project_a.md'), 'utf8') === memBytesBefore && statSync(join(memDir, 'project_a.md')).mtimeMs === memMtimeBefore,
    '记忆文件本身一个字节都没被写（没有 last_accessed）')

  // 节流：窗口内再注入 4 次，磁盘不该再动
  const mtime1 = statSync(LEDGER).mtimeMs
  for (let i = 0; i < 4; i++) await inject(TOKEN)
  await sleep(40)
  ok(statSync(LEDGER).mtimeMs === mtime1, '30 秒窗口内连续注入只落盘一次（mtime 未变）')
  const flushed = await access.flushAccess()
  ok(flushed.ok === true && flushed.written >= 1, '强制 flush 把内存增量并到盘上', JSON.stringify(flushed))
  const after = await access.readAccessLedger()
  ok(after['project_a.md'] > firstStamp, 'flush 后盘上是更新的时间戳', `${firstStamp} → ${after['project_a.md']}`)
}

// ── 2. 零命中 → 台账不新增 ──────────────────────────────────
group('2. 注入零命中 → 台账不新增')
{
  const before = Object.keys(await access.readAccessLedger()).length
  const text = await inject('zzz 完全不相干的问句 qqq')
  await sleep(40)
  const after = Object.keys(await access.readAccessLedger())
  ok(text === '' || !text.includes('project_a.md'), '零命中不注入任何记忆')
  ok(after.length === before, '台账条目数不变', `${before} → ${after.length}`)
}

// ── 3. 台账写不进去（子进程）→ 注入仍成功 ────────────────────
group('3. 台账写不进去 → 注入仍然成功（静默降级）')
{
  const r = spawnSync(process.execPath, [SELF, '--child-ledger-fail'], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  ok(r.status === 0 && /结果：3 passed, 0 failed/.test(out), '子进程：注入成功、台账确实写不进去、失败不抛', out.trim().split('\n').slice(-3).join(' | '))
  ok(!/access ledger flush failed/.test(out), 'DEBUG 未开时台账失败是静默的（没有输出）')
}

// ── 4. SAGE_MEM_DEBUG ───────────────────────────────────────
group('4. SAGE_MEM_DEBUG=1 一行结构化日志；不开时零输出')
const quietText = await (async () => {
  const cap = []
  const origLog = console.log
  const origWarn = console.warn
  console.log = (...a) => cap.push(a.join(' '))
  console.warn = (...a) => cap.push(a.join(' '))
  try { return { text: await inject(TOKEN), logs: cap.slice() } } finally { console.log = origLog; console.warn = origWarn }
})()
ok(quietText.logs.filter((l) => l.includes('[sage-mem] recall')).length === 0, '不开 DEBUG：没有该日志', quietText.logs.join(' | '))
{
  process.env.SAGE_MEM_DEBUG = '1'
  const mod2 = await import(new URL('index.js?debug=1', LIB).href) // query 让它重新求值 → 重新读 env
  const gw2 = new mod2.default(makeCtx())
  const inject2 = makeInjector(gw2)
  const cap = []
  const origLog = console.log
  console.log = (...a) => cap.push(a.join(' '))
  let dbgText = ''
  try { dbgText = await inject2(TOKEN) } finally { console.log = origLog }
  delete process.env.SAGE_MEM_DEBUG
  const lines = cap.filter((l) => l.includes('[sage-mem] recall'))
  ok(lines.length === 1, '开了 DEBUG：恰好一行日志', cap.join(' | '))
  let payload = null
  try { payload = JSON.parse(lines[0].slice(lines[0].indexOf('{'))) } catch { /* 下面会报 */ }
  ok(!!payload, '那一行是合法 JSON', lines[0])
  ok(payload && ['scanned', 'hits', 'scores', 'picked', 'injected', 'chars', 'skippedByBudget'].every((k) => k in payload),
    '字段齐：候选数 / 命中数 / 逐条得分 / 入选 / 真注入 / 字符数 / 被预算挡掉几条', JSON.stringify(payload))
  ok(payload?.injected?.includes('project_a.md') && payload.chars > 0, '日志里能看到入选文件与注入字符数')
  ok(dbgText === quietText.text, 'DEBUG 不改变注入结果（开与关的注入文本逐字节一致）')
}

// ── 5. 候选计算 ─────────────────────────────────────────────
group('5. 候选计算：feedback 永不入选 / baseline 排除 / 归档区不算 / 阈值差异化')
{
  const now = Date.parse('2026-06-01T00:00:00Z')
  const rec = (file, type, days, extra = {}) => ({ file, type, updated: new Date(now - days * 86400000).toISOString(), ...extra })
  const TH = { thresholds: { project: 90, reference: 180, user: 365 } }
  const files = [
    rec('feedback_old.md', 'feedback', 999),
    rec('project_old.md', 'project', 200),
    rec('reference_mid.md', 'reference', 100),
    rec('user_old.md', 'user', 200),
    rec('project_baseline.md', 'project', 400, { baseline: true }),
    rec('project_fresh.md', 'project', 1),
  ]
  const picked = access.pickArchiveCandidates(files, {}, TH, now).map((c) => c.file)
  ok(!picked.includes('feedback_old.md'), 'feedback_* 永不进候选')
  ok(!picked.includes('project_baseline.md'), 'baseline: true 被排除')
  ok(picked.includes('project_old.md'), 'project 超过 90 天 → 入选')
  ok(!picked.includes('reference_mid.md'), 'reference 100 天未到 180 天阈值 → 不入选')
  ok(!picked.includes('user_old.md'), 'user 200 天未到 365 天阈值 → 不入选')
  ok(!picked.includes('project_fresh.md'), '新记忆不入选')
  ok(access.pickArchiveCandidates([rec('x.md', 'feedback', 999)], {}, TH, now).length === 0, '只由 feedback 组成时候选为空')

  // 真实目录：进了 archive/ 的不算
  writeMem('project_archived.md', { updated: daysAgo(400) })
  mkdirSync(join(memDir, 'archive'), { recursive: true })
  renameSync(join(memDir, 'project_archived.md'), join(memDir, 'archive', 'project_archived.md'))
  const real = await scan.scanMemoryFiles(makeCtx(), '')
  const realPicked = access.pickArchiveCandidates(real, {}, TH).map((c) => c.file)
  ok(!realPicked.includes('project_archived.md'), '已在 archive/ 的不进候选（scanMemoryFiles 只扫根目录）')
}

// ── 6. 阈值边界 ─────────────────────────────────────────────
group('6. 阈值边界：刚好 N 天 vs N-1 天')
{
  const now = Date.parse('2026-06-01T00:00:00Z')
  const rec = (days) => ({ file: 'project_x.md', type: 'project', updated: new Date(now - days * 86400000).toISOString() })
  const TH = { thresholds: { project: 90 } }
  ok(access.idleDays(rec(90), {}, now) === 90, 'idleDays 刚好 90 天', String(access.idleDays(rec(90), {}, now)))
  ok(access.pickArchiveCandidates([rec(90)], {}, TH, now).length === 1, '刚好 N 天 → 入选')
  ok(access.pickArchiveCandidates([rec(89)], {}, TH, now).length === 0, 'N-1 天 → 不入选')
  // 台账优先于 updated：台账说 1 天前，即便 updated 是 300 天前也不算闲置
  const ledger = { 'project_x.md': now - 86400000 }
  ok(access.idleDays(rec(300), ledger, now) === 1, '台账优先于 frontmatter updated')
  ok(access.pickArchiveCandidates([rec(300)], ledger, TH, now).length === 0, '台账说刚用过 → 不进候选')
}

// ── 7. 配置默认最保守 ───────────────────────────────────────
group('7. 配置默认：autoArchive=report（只出报告）')
{
  ok(DEFAULT_CONFIG.autoArchive === 'report', '默认 autoArchive = report', String(DEFAULT_CONFIG.autoArchive))
  const { archiveAfterDaysProject: p, archiveAfterDaysReference: r, archiveAfterDaysUser: u } = DEFAULT_CONFIG
  ok(Number.isFinite(p) && Number.isFinite(r) && Number.isFinite(u) && p < r && r < u,
    '阈值按类差异化且保守（project < reference < user）', `${p} / ${r} / ${u}`)
}

// ── autodream 的一趟真运行（假 llm）────────────────────────
function makeLlm(script) {
  let i = 0
  return { async *stream() { const c = script[Math.min(i, script.length - 1)]; i += 1; for (const x of c) yield x } }
}
const justStop = [{ type: 'finish', reason: { kind: 'stop' } }]
async function runOnce(mode, { apply = true } = {}) {
  const ctx = {
    get: (n) => (n === 'llm' ? makeLlm([justStop])
      : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    logger: { warn: () => {}, error: () => {} },
  }
  const engine = new adMod.AutodreamEngine(ctx, { memoryDir: memDir, sessionsRoot: '' })
  await engine.load()
  // 走面板会走的同一条路：setConfig（白名单 + 落盘）。autoArchive 若不在白名单里被静默丢掉，
  // 下面 auto/off 那几组的行为断言会直接红 —— 这条路径本身就是回归守卫。
  await engine.setConfig({ apply, autoArchive: mode })
  const res = await engine.run({ force: true, reason: 'access-test' })
  return { engine, res }
}
/** 数记忆文件（只算记忆根与 archive/，**排除** autodream 的报告目录 —— 那是产物不是记忆）。 */
function countMd(dir) {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'autodream' || e.name === 'dream') continue
      n += countMd(join(dir, e.name))
    } else if (e.name.toLowerCase().endsWith('.md')) n += 1
  }
  return n
}
const manifestOf = (runId) => JSON.parse(readFileSync(join(stateDir, 'autodream', 'runs', runId, 'manifest.json'), 'utf8'))

// 为第 8/9 节准备夹具
writeMem('project_old.md', { updated: daysAgo(200) })
writeMem('reference_mid.md', { updated: daysAgo(100) })
writeMem('feedback_old.md', { type: 'feedback', updated: daysAgo(999) })
writeMem('user_old.md', { type: 'user', updated: daysAgo(200) })

// ── 8. report 模式：一个文件都不动，但报告里有清单 ───────────
group("8. report 模式跑一趟：archive/ 一个文件都没动，报告里有候选清单")
let ledgerBeforeRun = 0
let reportPath = ''
{
  // 先制造一条「内存里待 flush」的增量：证明 run 之前会强制 flush
  await inject(TOKEN)
  ledgerBeforeRun = (await access.readAccessLedger())['project_a.md'] ?? 0
  const totalBefore = countMd(memDir)
  const { res } = await runOnce('report')
  ok(res.ok === true, 'report 模式的一趟运行成功', JSON.stringify(res).slice(0, 200))
  ok(!existsSync(join(memDir, 'archive', 'project_old.md')) && !existsSync(join(memDir, 'archive', 'reference_mid.md')),
    'autoArchive=report：候选一个都没被移进 archive/')
  ok(existsSync(join(memDir, 'project_old.md')), '根目录里它们都还在')
  ok(countMd(memDir) === totalBefore, '文件总数守恒（没有任何删除）')
  reportPath = join(memDir, 'autodream', res.report)
  const md = readFileSync(reportPath, 'utf8')
  ok(/自动归档候选/.test(md) && /策略：report/.test(md), '报告里出现了「自动归档候选」一节')
  ok(md.includes('project_old.md') && /没有移动任何文件/.test(md), '报告里列出了候选并写明未动文件')
  const cand = manifestOf(res.runId).archive.candidates.map((c) => c.file)
  ok(JSON.stringify(cand) === JSON.stringify(['project_old.md']),
    '机读 manifest 的候选清单只含够龄的 project（feedback / 未到阈值的都不在）', JSON.stringify(cand))
  const ledgerAfterRun = (await access.readAccessLedger())['project_a.md'] ?? 0
  ok(ledgerAfterRun > ledgerBeforeRun, 'autodream 运行前强制 flush 了台账（盘上时间戳前进）', `${ledgerBeforeRun} → ${ledgerAfterRun}`)
}

// ── 9. auto 模式：候选真的进 archive/、文件总数守恒 ──────────
group("9. auto 模式跑一趟：候选进 archive/、只移不删")
{
  const totalBefore = countMd(memDir)
  const { res } = await runOnce('auto')
  ok(res.ok === true, 'auto 模式的一趟运行成功', JSON.stringify(res).slice(0, 200))
  ok(existsSync(join(memDir, 'archive', 'project_old.md')), '候选被移进 archive/')
  ok(!existsSync(join(memDir, 'project_old.md')), '根目录里没有它了')
  ok(existsSync(join(memDir, 'feedback_old.md')), 'feedback 仍在根目录（永不自动归档）')
  ok(existsSync(join(memDir, 'user_old.md')), 'user 未到阈值，仍在根目录')
  ok(countMd(memDir) === totalBefore, '只移不删：文件总数守恒', `${totalBefore} → ${countMd(memDir)}`)
  const md = readFileSync(join(memDir, 'autodream', res.report), 'utf8')
  ok(/策略：auto/.test(md) && /已移入/.test(md), '报告里写明已移入 archive/')
}

// ── 10. apply:false 时 auto 降级为报告（只读是绝对承诺）─────
group('10. 只读模式（apply:false）+ autoArchive:auto → 降级为报告并明说')
{
  writeMem('project_readonly.md', { updated: daysAgo(200) })
  const totalBefore = countMd(memDir)
  const { res } = await runOnce('auto', { apply: false })
  ok(res.ok === true, '只读模式的一趟运行成功', JSON.stringify(res).slice(0, 160))
  ok(!existsSync(join(memDir, 'archive', 'project_readonly.md')), '一个文件都没被移走（只读承诺没被绕过）')
  ok(existsSync(join(memDir, 'project_readonly.md')), '候选仍在根目录')
  ok(countMd(memDir) === totalBefore, '文件总数守恒')
  const md = readFileSync(join(memDir, 'autodream', res.report), 'utf8')
  ok(/只读模式，本轮只出报告/.test(md), '报告里**明说**降级（不是静默什么都不做）')
  const m = manifestOf(res.runId).archive
  ok(m.mode === 'report' && m.requested === 'auto' && !!m.degraded,
    'manifest 记下「想要 auto、实际 report、降级原因」', JSON.stringify({ mode: m.mode, requested: m.requested, degraded: m.degraded }))
}

// ── 11. 三条归档路径共用一份实现：留痕格式完全一致 ───────────
group('11. 手动 / 工具 / 自动 三条路径：留痕同一格式、都写 archived_at 与 archived_reason')
{
  const AT_RE = /^archived_at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m
  const metaOf = (f) => scan.readArchivedMeta(readFileSync(join(memDir, 'archive', f), 'utf8'))

  // ① 自动策略（第 9 节留下的那份）
  const autoContent = readFileSync(join(memDir, 'archive', 'project_old.md'), 'utf8')
  const autoMeta = metaOf('project_old.md')
  ok(AT_RE.test(autoContent) && /^archived_reason: /m.test(autoContent), '自动归档写出了 archived_at + archived_reason')
  ok(autoMeta.archivedReason.startsWith('自动归档：') && autoMeta.archivedReason.includes('90 天未被注入'),
    '自动归档的 reason 由策略明确生成', autoMeta.archivedReason)

  // ② 手动 remote
  writeMem('project_manual.md', { updated: daysAgo(3) })
  const rManual = await gw.archive('project_manual.md', '手动写的理由')
  ok(rManual.ok === true, '手动 remote 归档成功')
  const manualContent = readFileSync(join(memDir, 'archive', 'project_manual.md'), 'utf8')
  ok(AT_RE.test(manualContent) && metaOf('project_manual.md').archivedReason === '手动写的理由', '手动路径留痕同格式、理由原样')

  // ③ autodream 的 archive_memory 工具
  const { createToolRunner } = await import(new URL('autodream-tools.js', LIB).href)
  writeMem('project_tool.md', { updated: daysAgo(3) })
  const runner = createToolRunner({ memoryDir: memDir, sessionsRoot: '', apply: true, withSessions: false })
  const toolOut = await runner.run('archive_memory', { file: 'project_tool.md', reason: '工具写的理由' })
  ok(toolOut.startsWith('已归档'), '工具归档成功（reason 必填语义不变）', toolOut)
  const toolContent = readFileSync(join(memDir, 'archive', 'project_tool.md'), 'utf8')
  ok(AT_RE.test(toolContent) && metaOf('project_tool.md').archivedReason === '工具写的理由', '工具路径留痕同格式、理由原样')

  // 四条：三个文件的时间戳形状完全一样（同一份实现产出的）
  const shapes = ['project_old.md', 'project_manual.md', 'project_tool.md']
    .map((f) => (readFileSync(join(memDir, 'archive', f), 'utf8').match(/^archived_at: .*$/m) ?? [''])[0])
  ok(shapes.every((s) => AT_RE.test(s)), '三条路径产出的 archived_at 形状逐字同格式', JSON.stringify(shapes))
  ok(new Set(shapes.map((s) => s.slice(0, 13))).size === 1, '三条路径连字段名与分隔都一致（同一实现）', JSON.stringify(shapes))

  // 界面可见性：listArchived 能看到自动归档那条的留痕
  const listed = (await gw.listArchived()).files.find((f) => f.file === 'project_old.md')
  ok(!!listed && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(listed.archivedAt) && listed.archivedReason.startsWith('自动归档：'),
    'listArchived 能看到自动归档的「何时、为什么」', JSON.stringify(listed))

  // 静态确认：三个入口都指向共享核心（不是各自又写了一份）
  const srcs = ['lib/index.js', 'lib/autodream/engine.js', 'lib/autodream-tools.js']
    .map((p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8'))
  ok(srcs.every((s) => s.includes('archiveMemory') && s.includes("memory/archive.js")),
    '三个入口都 import 共享核心 memory/archive.js（没有第二份实现）')
}

// ── 12. 台账回收死键 ─────────────────────────────────────────
group('12. 台账回收：归档/改名/删除后不再永远留着那条时间戳')
{
  writeMem('project_alive.md', { updated: daysAgo(2) })
  access.recordAccess(['gone.md', 'project_a.md', 'project_old.md', 'project_alive.md'])
  const flush = await access.flushAccess()
  ok(flush.ok === true, '带回收的 flush 成功', JSON.stringify(flush))
  const ledger = await access.readAccessLedger()
  ok(!('gone.md' in ledger), '记忆目录里不存在的 gone.md → 键被清掉')
  ok('project_a.md' in ledger && 'project_alive.md' in ledger, '根目录仍在的文件键留着')
  ok('project_old.md' in ledger, '归档区里的文件名键留着（将来恢复它，访问时间仍然有意义）')
  const raw = readFileSync(LEDGER, 'utf8')
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { /* 下面会判 */ }
  ok(!!parsed && typeof parsed === 'object' && !Array.isArray(parsed), '回收后仍是合法 JSON 对象')
  ok(access.idleDays({ file: 'project_a.md', mtimeMs: 0 }, parsed, Date.now()) ===
     access.idleDays({ file: 'project_a.md', mtimeMs: 0 }, ledger, Date.now()), '存活文件的 idleDays 行为不变')
}

// ── 13. 两类 ENOENT 必须分开：根目录不存在 ≠ 记忆都没了 ──────
group('13. 回收的 ENOENT 分类：记忆根不存在时一个键都不许清')
{
  const beforeKeys = Object.keys(await access.readAccessLedger())
  ok(beforeKeys.length > 0, '前置：台账里已经有若干键', JSON.stringify(beforeKeys))

  // ① 记忆根指向一个**不存在**的路径（ENOENT）+ 非空 batch
  access.recordAccess(['project_a.md'], Date.now())
  const r1 = await access.flushAccess(join(sandbox, 'no-such-memory-dir'))
  const after1 = await access.readAccessLedger()
  ok(r1.ok === true, '根目录不存在时 flush 仍成功（不抛）', JSON.stringify(r1))
  ok(beforeKeys.every((k) => k in after1),
    '根目录 ENOENT → 原有键一个都没少（宁可留死键，不可误清）',
    JSON.stringify({ before: beforeKeys, after: Object.keys(after1) }))
  ok(Object.keys(after1).length === beforeKeys.length, '也没有凭空多出键')

  // ② 非 ENOENT 的读失败：记忆根是一个**文件**（ENOTDIR）
  const notADir = join(sandbox, 'not-a-dir')
  writeFileSync(notADir, 'x\n')
  const before2 = Object.keys(await access.readAccessLedger())
  access.recordAccess(['project_alive.md'], Date.now())
  const r2 = await access.flushAccess(notADir)
  const after2 = await access.readAccessLedger()
  ok(r2.ok === true && before2.every((k) => k in after2),
    '非 ENOENT 读失败（ENOTDIR）→ 同样保留全部键', JSON.stringify({ r2, after: Object.keys(after2) }))

  // ③ 对照组：正常记忆目录下，真的不存在的键**仍然会被回收**（这次修改没把语义带偏）
  access.recordAccess(['still-gone.md'], Date.now())
  const r3 = await access.flushAccess()
  const after3 = await access.readAccessLedger()
  ok(r3.ok === true && !('still-gone.md' in after3), '对照组：正常目录下假键仍会被回收')
  ok(beforeKeys.every((k) => k in after3), '对照组：真实存在的键仍然留着', JSON.stringify(Object.keys(after3)))
}

// ── 14. autoArchive 进配置面（面板可读写、非法值拒、落盘、重读得到）──
group('14. autoArchive 三档：白名单接受、非法值拒、落盘后重新加载读得到')
{
  const mkEngine = () => new adMod.AutodreamEngine(
    { get: () => undefined, logger: { warn: () => {}, error: () => {} } },
    { memoryDir: memDir, sessionsRoot: '' },
  )
  const engine = mkEngine()
  await engine.load()
  const cfgPath = engine.configPath
  ok(DEFAULT_CONFIG.autoArchive === 'report', '默认值就是 report', String(DEFAULT_CONFIG.autoArchive))

  // ① 合法值：读回 + 落盘
  const c1 = await engine.setConfig({ autoArchive: 'auto' })
  ok(c1.config.autoArchive === 'auto', 'setConfig(auto) 后 getConfig 读回 auto', String(c1.config.autoArchive))
  ok(JSON.parse(readFileSync(cfgPath, 'utf8')).config.autoArchive === 'auto', '落盘到 .sage-mem/autodream.json')

  // ② 「重进程」：换一个引擎实例走 load()（真实代码路径就是读这个文件）
  const fresh = mkEngine()
  await fresh.load()
  ok(fresh.state.config.autoArchive === 'auto', '新实例 load() 后仍是 auto（重进程读得到）')
  ok((await fresh.getConfig()).config.autoArchive === 'auto', '新实例 getConfig() 也回 auto')

  // ③ 非法值：一律不写入（照抄现有 setConfig 处理非法枚举的方式：保留原值，不另立 {ok:false}）
  const badValues = [['sometimes', '字符串乱填'], [123, '数字'], [{ mode: 'auto' }, '对象'], [null, 'null'], [true, '布尔']]
  for (const [bad, label] of badValues) {
    let threw = null
    let got = null
    try { got = await engine.setConfig({ autoArchive: bad }) } catch (e) { threw = e }
    ok(threw === null && got?.config?.autoArchive === 'auto',
      `非法值被拒（${label}）且原值保持 auto`, threw ? `抛了 ${threw.message}` : String(got?.config?.autoArchive))
  }
  ok(JSON.parse(readFileSync(cfgPath, 'utf8')).config.autoArchive === 'auto', '非法值那几轮没有改到配置文件')
  for (const v of ['off', 'report', 'auto']) {
    const c = await engine.setConfig({ autoArchive: v })
    ok(c.config.autoArchive === v, `三个合法值都收（${v}）`, String(c.config.autoArchive))
  }
  ok((await engine.getConfig()).defaults.autoArchive === 'report', 'getConfig().defaults 里也能看到默认值')

  // ④ off 档：什么都不做（连候选清单都不出）
  writeMem('project_off_candidate.md', { updated: daysAgo(200) })
  const { res } = await runOnce('off')
  ok(res.ok === true, 'off 档的一趟运行成功')
  ok(existsSync(join(memDir, 'project_off_candidate.md')), 'off 档：够龄的候选也留在根目录')
  ok(!existsSync(join(memDir, 'archive', 'project_off_candidate.md')), 'off 档：archive/ 里没有它')
  const md = readFileSync(join(memDir, 'autodream', res.report), 'utf8')
  ok(!/自动归档候选/.test(md), 'off 档：报告里连候选清单都不出')
  const m = manifestOf(res.runId).archive
  ok(m.mode === 'off' && m.candidates.length === 0, 'off 档：manifest 记 mode=off、候选为空', JSON.stringify({ mode: m.mode, n: m.candidates.length }))
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
