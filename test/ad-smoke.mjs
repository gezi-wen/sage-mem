/**
 * autodream 冒烟测试（仓库内测试，随 npm test 一起跑）。
 * 不依赖 DSH 运行时：用一个假的 ctx 把引擎单独拉起来。
 */
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AutodreamEngine } from '../lib/autodream.js'
import { createToolRunner, autodreamToolSchemas } from '../lib/autodream-tools.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'ad-smoke-'))
const memoryDir = join(root, 'memory')
const stateRoot = join(root, '.sage-mem')
await mkdir(memoryDir, { recursive: true })
await mkdir(stateRoot, { recursive: true })

const F = (n) => join(memoryDir, n)
await writeFile(F('a.md'), '---\nname: a\ntype: project\n---\n\n# A\n\n旧内容\n', 'utf8')
await writeFile(F('b.md'), '---\nname: b\ntype: reference\n---\n\n# B\n\n将要被归档\n', 'utf8')
await writeFile(F('MEMORY.md'), '---\nname: memory\ntype: reference\n---\n\n# 索引\n', 'utf8')
// 旧版配置：验证改名迁移
await writeFile(
  join(stateRoot, 'dream.json'),
  JSON.stringify({ config: { enabled: true, apply: true, minHours: 6 }, lastRunAt: 111, lastResult: null, retryAfter: 0 }, null, 2),
  'utf8',
)
// 旧版报告目录：验证只读兼容
await mkdir(join(memoryDir, 'dream'), { recursive: true })
await writeFile(join(memoryDir, 'dream', '20260927-134209.md'), '# 老报告\n', 'utf8')

const ctx = { get: () => undefined, logger: { warn: () => {}, error: () => {} } }
const engine = new AutodreamEngine(ctx, { memoryDir, sessionsRoot: '' })

console.log('== 1. 改名迁移 ==')
await engine.load()
ok(engine.state.config.enabled === true, '旧配置 enabled 被读到')
ok(engine.state.config.minHours === 6, '旧配置 minHours 被读到')
ok(engine.state.config.rollbackScope === 'files', '新字段 rollbackScope 补上默认值')
ok(await stat(engine.configPath).then(() => true, () => false), '新配置文件 autodream.json 已写出')
ok(await stat(join(stateRoot, 'dream.json')).then(() => true, () => false), '旧配置文件保留未删')

console.log('== 2. 模型路线 ==')
const rNone = engine.resolveRoute({ provider: '', model: '' })
ok(rNone.source === 'none' && !!rNone.error, '空配置且无默认模型 → source=none 且带原因')
const rHalf = engine.resolveRoute({ provider: 'deepseek', model: '' })
ok(rHalf.source === 'none' && rHalf.error.includes('成对'), '只填一半 → 判为配置错误')
const rCfg = engine.resolveRoute({ provider: 'p', model: 'm' })
ok(rCfg.source === 'config' && rCfg.fromDefault === false, '两项都填 → source=config')

console.log('== 3. 回滚点 ==')
const snap = await engine.snapshot('20261001-120000-abcd', 'run')
ok(snap.count === 3, `快照 3 个顶层 md（实际 ${snap.count}）`)
ok(snap.files.every((f) => typeof f.sha256 === 'string' && f.sha256.length === 64), '每条都带 sha256')
const snaps = await engine.listSnapshots()
ok(snaps.some((s) => s.name === '20261001-120000-abcd' && s.runId === '20261001-120000-abcd'), 'listSnapshots 认出 run 绑定')

console.log('== 4. 工具层：缘由来源 + 变更记录 ==')
const runner = createToolRunner({ memoryDir, sessionsRoot: '', apply: true, withSessions: false })
const schemas = autodreamToolSchemas({ apply: true, withSessions: false })
const wmSchema = schemas.find((t) => t.name === 'write_memory').parameters
ok(!wmSchema.required.includes('reason'), 'write_memory 的 reason 不再是必填（硬拒会丢掉正确的修正）')
ok(JSON.stringify(wmSchema.properties).includes('reason'), 'reason 仍在参数表里（强烈建议）')
ok(schemas.find((t) => t.name === 'archive_memory').parameters.required.includes('reason'), 'archive_memory 的 reason 仍然必填（不可逆动作）')

const noReason = await runner.run('write_memory', { file: 'a.md', content: '---\nname: a\n---\n\n改了\n' })
ok(noReason.startsWith('已写入'), '缺 reason 的写入**不再被拒**，改动生效', noReason)
ok(runner.notes().length === 1, '未自述缘由进了 notes（改动已生效，不是「未能落地」）')
ok(runner.warnings().length === 0, 'notes 不进 warnings（两者不能混）')
const written = await runner.run('write_memory', { file: 'a.md', content: '---\nname: a\n---\n\n改了第二遍\n', reason: '合并重复段落' })
ok(written.startsWith('已写入'), '带 reason 的写入成功')
const created = await runner.run('write_memory', { file: 'c.md', content: '---\nname: c\n---\n\n新条目\n', reason: '新增一条' })
ok(created.includes('新建'), '新建被标出')
const archNoReason = await runner.run('archive_memory', { file: 'b.md' })
ok(archNoReason.startsWith('错误'), '归档缺 reason 被拒（不可逆动作不放行）')
const archived = await runner.run('archive_memory', { file: 'b.md', reason: '已被 c 取代' })
ok(archived.startsWith('已归档'), '归档成功')
const changes = runner.changes()
ok(changes.length === 4, `记下 4 条变更（实际 ${changes.length}）`)
ok(changes[0].op === 'update' && changes[0].reasonSource === 'auto' && changes[0].reason === '', '第 1 条是「未自述」的 auto 变更')
ok(changes[1].op === 'update' && changes[1].reason === '合并重复段落' && changes[1].reasonSource === 'model', '第 2 条带模型自述的缘由')
ok(changes[2].op === 'create' && changes[2].before.exist === false, '新建条目 before.exist=false')
ok(changes[3].op === 'archive', '归档条目 op=archive')

console.log('== 5. 声明 ==')
const decl = await engine.writeDeclaration({
  runId: '20261001-120000-abcd',
  startedAt: Date.now() - 30000,
  endedAt: Date.now(),
  reason: '手动触发',
  apply: true,
  source: 'memory',
  provider: 'p',
  model: 'm',
  fromDefault: false,
  hoursSince: 26,
  sessionCount: 7,
  tokensIn: 100,
  tokensOut: 20,
  snapshot: snap,
  changes,
  warnings: runner.warnings(),
  notes: runner.notes(),
  auditBefore: { problems: 2 },
  auditAfter: { problems: 2 },
  finalText: '收尾说明',
})
ok(decl.markdown.includes('合并重复段落'), '声明里带缘由')
ok(decl.markdown.includes('改写') && decl.markdown.includes('归档'), '声明里有操作类型')
ok((decl.markdown.match(/^\| \d+ \|/gm) || []).length === 4, '声明表格 4 行')
ok(decl.markdown.includes('未自述'), '声明里标出了模型未自述缘由的那条')
ok(decl.markdown.includes('宿主追溯'), '声明里有「未自述」的说明段')
ok(decl.markdown.includes('未能落地的改动'), '声明里有被拒动作一节（那一条改动没发生）')
ok(decl.markdown.includes('提示（改动已生效'), '声明里另有提示一节（未自述那条改动**已生效**）')
// 关键：两种东西不能混进同一节——混了就会「标题说未能落地、正文说已生效」自相矛盾
const warnBlock = decl.markdown.split('未能落地的改动')[1].split('## ')[0]
ok(!warnBlock.includes('未自述'), '「未能落地的改动」一节里不出现「未自述」（那是已生效的改动）')
const runs = await engine.listRuns()
ok(runs.length === 1 && runs[0].changeCount === 4, 'listRuns 报出 4 条改动')
const rd = await engine.readDeclaration('20261001-120000-abcd')
ok(rd.runId === '20261001-120000-abcd' && rd.manifest.changes.length === 4, 'readDeclaration 返回机读 manifest')
ok(rd.manifest.changes[0].reasonSource === 'auto' && rd.manifest.changes[1].reasonSource === 'model', '机读记录里带 reasonSource')

console.log('== 6. 回滚（files）==')
const rb = await engine.rollback({ snapshotId: '20261001-120000-abcd', scope: 'files' })
ok(rb.ok === true, `回滚成功（${rb.error ?? ''}）`)
ok(rb.restored === 3, `写回 3 个（a.md 两次改写退回 + b.md 从 archive 移回，实际 ${rb.restored}）`)
ok(rb.parked === 1, `移走 1 个（c.md，实际 ${rb.parked}）`)
ok((await readFile(F('a.md'), 'utf8')).includes('旧内容'), 'a.md 内容已退回')
ok(await stat(F('c.md')).then(() => false, () => true), 'c.md 已不在顶层')
ok(await stat(join(memoryDir, 'archive', 'c.md')).then(() => true, () => false), 'c.md 被移进 archive/ 而非删除')
ok((await readFile(F('b.md'), 'utf8')).includes('将要被归档'), 'b.md 已从 archive 移回顶层')
ok(await stat(join(memoryDir, 'archive', 'b.md')).then(() => false, () => true), 'archive/ 里的 b.md 已不在')
ok(rb.protection && (await stat(join(engine.snapshotRoot, rb.protection)).then(() => true, () => false)), '回滚前保护快照存在')
const rolled = await engine.listRuns()
ok(rolled[0].rolledBackAt > 0, '运行记录被标记为已回滚')
const rollbacks = await engine.listRollbacks()
ok(rollbacks.length === 1 && rollbacks[0].snapshotId === '20261001-120000-abcd', '回滚留痕已落盘')

console.log('== 7. 回滚（all）==')
await writeFile(F('d.md'), '---\nname: d\n---\n\n快照之后才建的\n', 'utf8')
const rb2 = await engine.rollback({ snapshotId: 'pre-rollback-' + rb.protection.replace('pre-rollback-', ''), scope: 'all' })
ok(rb2.ok === true, `整目录回滚成功（${rb2.error ?? ''}）`)
const aAfter = await readFile(F('a.md'), 'utf8')
ok(aAfter.includes('改了'), 'a.md 退回到保护快照那一版（即回滚后的状态）', JSON.stringify(aAfter.slice(0, 120)))

console.log('== 8. 报告与旧版兼容 ==')
const reports = await engine.listReports()
ok(reports.some((r) => r.name === 'dream/20260927-134209.md' && r.legacy === true), '旧版报告被列出并标 legacy')
const old = await engine.readReport('dream/20260927-134209.md')
ok(old.content.includes('老报告'), '旧版报告能读全文')
const bad = await engine.readReport('../evil.md').then(() => null, (e) => e)
ok(bad instanceof Error, '路径穿越被拒')

console.log(`\n结果：${pass} passed, ${fail} failed  （临时目录 ${root}）`)
process.exit(fail ? 1 : 0)
