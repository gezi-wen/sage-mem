#!/usr/bin/env node
/**
 * 2.14.0 记忆治理的**宿主侧**断言：孤儿归档件（②）与索引瘦身提案（③）。
 *
 * 为什么单独一个套件：这两项都**不进 problems**（判据是「假阳性会让这盏灯永远亮着」），
 * 所以它们出错的方式不是「体检变红」，而是**悄悄什么都不报** —— 面板上永远空白、
 * 提示词里永远缺一段，而 problems 照样是 0，看起来一片健康。
 *
 * 三层：
 *   1. 判定：真实临时目录 → `auditMemoryDir()` 的输出（含反向对照：不该报的一个都不许报）
 *   2. 呈现：`formatAudit()` 给人/模型看的短文本
 *   3. 传输：`typert` 的 strict schema 不许把新字段剥掉（剥掉 = 面板与模型面口径分叉）
 *
 * 全程不碰真实记忆目录：SAGE_MEM_DIR / SAGE_MEM_STATE_DIR 指向临时目录，
 * 且必须在动态 import **之前**设好（模块顶层读环境变量）。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = join(tmpdir(), 'sage-mem-governance-test-' + process.pid)
const memDir = join(sandbox, 'memory')
const archiveDir = join(memDir, 'archive')
mkdirSync(archiveDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const LIB = new URL('../lib/', import.meta.url)
const { auditMemoryDir, formatAudit } = await import(new URL('autodream/audit.js', LIB).href)
const { TYPERT } = await import(new URL('typert.host.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)
const j = (v) => JSON.stringify(v)

/** 写一条记忆（顶层 frontmatter；type 与前缀一致，免得顺带制造 typeMismatch）。 */
function writeMem(dir, name, { body = '', extra = [] } = {}) {
  const lines = ['---', `name: ${name.replace(/\.md$/, '')}`, `type: ${name.split('_')[0]}`, `description: 夹具`]
  for (const l of extra) lines.push(l)
  lines.push('---', '', `# ${name}`, '', body, '')
  writeFileSync(join(dir, name), lines.join('\n'), 'utf8')
}

/** 归档件：`archived_from` 是可选的（普通整份归档没有它，只有 trim 切片有）。 */
function writeArchived(name, { body = '', from = null, title = null } = {}) {
  const lines = ['---', `name: ${name.replace(/\.md$/, '')}`, `type: ${name.split('_')[0]}`, 'description: 归档夹具']
  if (from) lines.push(`archived_from: ${from}`)
  lines.push('archived_at: 2026-11-19T12:00:00+08:00')
  lines.push('---', '', `# ${title || name}`, '', body, '')
  writeFileSync(join(archiveDir, name), lines.join('\n'), 'utf8')
}

// ═══ 夹具 ═══════════════════════════════════════════════════════
// 活动区：一条普通记忆，一条指向归档切片的记忆（用来验「被引用就不算孤儿」）。
writeMem(memDir, 'project_alive.md', { body: '活着的一条。' })
writeMem(memDir, 'reference_linked.md', {
  // 两种引用形态都写进来：`[[wikilink]]` 与 trim 的**指针行**（`archive/<名字>`）。
  // 第二条尤其重要：切片在原位置留下的就是这种指针，它**不是** wikilink ——
  // 只按 wikilink 统计会把绝大多数切片算成「没人引用」。
  body: '见 [[project_ghost-旧段-20261004-aa11]]。\n\n> 另有一段已归档到 archive/project_viaPointer-旧段-20261006-cc33.md（2026-11-19，缘由：夹具）\n',
})

// 归档区：
//   a. 源件已不在、也没人引用 → no_source（该报）
//   b. 源件还在 → 不算孤儿（不该报）
//   c. 源件已不在，但被活动记忆链接 → 有上下文，不算孤儿（不该报）
//   d/e. 内容完全相同 → duplicate（该报）
//   f. 内容只差一个空格 → 不是重复（不该报）
const DUP_BODY = '正文写得一模一样。'
// 两份「整份归档」：正文与一级标题都相同（真实形态就是同一份文件被归档两次，
// 只有 frontmatter 里的 name / archived_at 不同 —— 所以判据必须只看正文）。
writeArchived('project_dead-旧段-20261001-cd34.md', { from: 'project_dead.md' })
writeArchived('project_alive-旧段-20261003-9988.md', { from: 'project_alive.md' })
writeArchived('project_ghost-旧段-20261004-aa11.md', { from: 'project_ghost.md' })
// 源件已不在、但原文里留着「指针行」指向它 → 有上下文，不算孤儿（验第二条引用通道）。
writeArchived('project_viaPointer-旧段-20261006-cc33.md', { from: 'project_viaPointer.md' })
writeArchived('reference_dup.md', { title: '同一份旧内容', body: DUP_BODY })
writeArchived('reference_dup-旧段-20261002-ef56.md', { title: '同一份旧内容', body: DUP_BODY })
writeArchived('reference_near-旧段-20261005-bb22.md', { title: '同一份旧内容', body: DUP_BODY + ' ' })

// 索引：4 行有链接，其中一行悬空（第 4 行），第 5 行超长（> 240 字）。
const LONG_LINE = `- [长行](project_alive.md) — ${'很长'.repeat(130)}`
writeFileSync(join(memDir, 'MEMORY.md'), [
  '# 索引',
  '- [alive](project_alive.md) — 一句话',
  '- [linked](reference_linked.md) — 一句话',
  '- [gone](gone.md) — 悬空条目',
  LONG_LINE,
  '',
].join('\n'), 'utf8')

// ═══ 1. 孤儿归档件：该报的两类 ═══════════════════════════════════
const report = await auditMemoryDir(memDir)
group('1. 孤儿归档件：只报「源件已不在」与「内容完全相同」')
{
  const orphans = Array.isArray(report.orphans) ? report.orphans : []
  const noSource = orphans.filter((o) => o.kind === 'no_source')
  const dup = orphans.filter((o) => o.kind === 'duplicate')
  ok(noSource.length === 1, `no_source 只报 1 条（实际 ${noSource.length}：${j(noSource.map((o) => o.file))}）`)
  ok(noSource[0] && noSource[0].file === 'project_dead-旧段-20261001-cd34.md' && noSource[0].from === 'project_dead.md',
    'no_source 指向那条切片并写出原件名', j(noSource[0]))
  ok(dup.length === 1, `duplicate 只报 1 条（实际 ${dup.length}：${j(dup.map((o) => o.file))}）`)
  // 报哪一份取决于目录枚举顺序（Windows / Linux 不同）—— 判据只承诺「两份互为对手」，
  // 所以断言写成集合关系而不是钉死文件名（否则这个套件会变成跨平台红）。
  const PAIR = ['reference_dup.md', 'reference_dup-旧段-20261002-ef56.md']
  ok(!!dup[0] && PAIR.indexOf(dup[0].file) >= 0 && PAIR.indexOf(dup[0].with) >= 0 && dup[0].file !== dup[0].with,
    '重复件报其中一份、并写明与哪一份相同（人要先比对再决定留哪份）', j(dup[0]))
}

group('2. 【反向对照】不该报的一个都不许报')
{
  const files = (Array.isArray(report.orphans) ? report.orphans : []).map((o) => o.file)
  ok(files.indexOf('project_alive-旧段-20261003-9988.md') < 0, '源件还在 → 不算孤儿')
  ok(files.indexOf('project_ghost-旧段-20261004-aa11.md') < 0, '源件没了但被活动记忆链接 → 有上下文，不算孤儿')
  ok(files.indexOf('reference_near-旧段-20261005-bb22.md') < 0, '内容只差一个空格 → 不是重复（sha1 + 字节数双判）')
  ok(files.filter((f) => f === 'reference_dup.md' || f === 'reference_dup-旧段-20261002-ef56.md').length === 1,
    '重复对里只报一份，不两份都报')
  ok(files.indexOf('project_viaPointer-旧段-20261006-cc33.md') < 0, '只靠「指针行」引用的切片不算孤儿（trim 的指针不是 wikilink）')
}

group('3. 「没有任何引用」只做统计，不逐条列')
{
  // 该条判据在真实库里命中 81%（102/126），逐条列就是常驻红灯 —— 所以它只以数字出现。
  ok(report.archiveReferenced === 2, `archiveReferenced = 2（wikilink 1 + 指针行 1；实际 ${j(report.archiveReferenced)}）`)
  ok(report.archivedCount === 7, `archivedCount 照旧数全部归档件（实际 ${j(report.archivedCount)}）`)
  const files = (report.orphans || []).map((o) => o.file)
  ok(files.length === 2, `孤儿清单只有两类共 2 条，没有把 7 份归档件全列出来（实际 ${files.length}）`)
}

// ═══ 4. 两项都不进 problems ══════════════════════════════════════
group('4. 孤儿与提案都不进 problems（problems 是唯一的健康数字）')
{
  // 夹具里真正的硬问题只有索引悬空那 1 条（gone.md）。
  ok(report.problems === 1, `problems = 1（实际 ${j(report.problems)}）`)
  ok(report.dangling.length === 1 && report.dangling[0].file === 'gone.md', 'hard 项仍然是那条悬空索引', j(report.dangling))
}

// ═══ 5. 索引瘦身提案：指到行号 ══════════════════════════════════
group('5. 索引瘦身提案：悬空条目与超长行都要能指到行号')
{
  const props = Array.isArray(report.indexProposals) ? report.indexProposals : []
  const dangling = props.filter((p) => p.kind === 'dangling')
  const long = props.filter((p) => p.kind === 'long_line')
  ok(dangling.length === 1 && dangling[0].line === 4 && dangling[0].target === 'gone.md',
    '悬空条目指到第 4 行与目标名', j(dangling))
  ok(long.length === 1 && long[0].line === 5, '超长行指到第 5 行', j(long))
  ok(long[0] && long[0].chars === [...LONG_LINE].length && typeof long[0].head === 'string' && long[0].head.length > 0,
    '超长行给出行内字数与开头预览', j(long[0]))
  ok(!props.some((p) => p.kind === 'dangling' && p.target === 'project_alive.md'), '正常条目不会被当成悬空')
}

// ═══ 6. 给模型看的短文本里要出现这两节 ═════════════════════════
group('6. formatAudit：两节都要出现，并写明「不计入问题 / 只报不改」')
{
  const text = formatAudit(report)
  ok(text.indexOf('孤儿归档件（提示，不计入问题）') >= 0, '有「孤儿归档件」一节')
  ok(text.indexOf('索引瘦身提案（只报不改') >= 0, '有「索引瘦身提案」一节')
  ok(text.indexOf('原件 project_dead.md 已不在') >= 0, '写出孤儿件的原件名')
  ok(text.indexOf('第 4 行指向不存在的 gone.md') >= 0, '提案里带行号')
}

// ═══ 7. typert strict：新字段不许被剥掉 ═════════════════════════
group('7. typert 审计 schema：新字段必须声明（strict 会剥掉没声明的）')
{
  const schema = TYPERT.invocations.find((i) => i.id === 'sage-mem#memory/audit')?.result?.schema
  ok(!!schema, '拿到 memory/audit 的 strict schema')
  const parsed = schema.parse(report)
  ok(Array.isArray(parsed.orphans) && parsed.orphans.length === 2, 'orphans 穿过 strict 保留下来', j(parsed.orphans))
  ok(parsed.archiveReferenced === 2, 'archiveReferenced 保留', j(parsed.archiveReferenced))
  ok(Array.isArray(parsed.indexProposals) && parsed.indexProposals.length === 2, 'indexProposals 保留', j(parsed.indexProposals))
  // 旧宿主 / 旧运行记录回放不带这三项，也必须能过（optional）—— 否则升级即全红。
  const { orphans, archiveReferenced, indexProposals, ...legacyIn } = report
  const legacy = schema.parse(legacyIn)
  ok(legacy.problems === report.problems && !('orphans' in legacy), '不带新字段的旧审计结果照样能过（optional）',
    j(Object.keys(legacy).filter((k) => k === 'orphans' || k === 'indexProposals')))
}

// ═══ 8. 空库 / 没有 archived_from 的老归档：零误报 ══════════════
group('8. 干净目录与「老式归档」（无 archived_from）都不许报孤儿')
{
  const clean = join(sandbox, 'clean')
  mkdirSync(join(clean, 'archive'), { recursive: true })
  writeMem(clean, 'user_plain.md')
  writeFileSync(join(clean, 'MEMORY.md'), '# 索引\n- [plain](user_plain.md) — 一句话\n', 'utf8')
  // 普通整份归档不写 archived_from（archive.js 的默认行为），名字就是原件名。
  writeArchived('user_old.md', { body: '旧的。' })
  const r1 = await auditMemoryDir(clean)
  ok((r1.orphans || []).length === 0, `无孤儿可报（实际 ${j(r1.orphans)}）`)
  ok(r1.problems === 0, `干净目录 problems = 0（实际 ${j(r1.problems)}）`)
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
