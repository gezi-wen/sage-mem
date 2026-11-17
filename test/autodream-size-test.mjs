#!/usr/bin/env node
/**
 * autodream-size-test.mjs — 体积治理在「自动做梦」这一侧的挂点（2.10.1 新增）
 *
 * 为什么单开一个套件：体积治理有四个面（裁段模块 / 主智能体工具 / 自动做梦 / 设置页），
 * 而**自动做梦这一面是最危险的那个** —— 它半夜无人值守地改记忆，模型看得到的提示词、
 * 审计给它的判据、它手上的工具、以及事后那份声明，四处任何一处口径不对，
 * 都会变成「改了但没人知道为什么」。
 *
 * 覆盖（契约 §5–§7）：
 *   1. 审计：`oversize` / `indexOversize` 两个数组与 `problems` 计数（含「保留名不计」）；
 *   2. 提示词：阶段 3.5 与 `archive_segment` 真的写进了用户提示，保护名单措辞扩到「不计入超线」；
 *   3. 声明：`manifest.trim` 的结构与「裁剪与压缩」一节逐条渲染（文件/操作/缘由/体积变化）；
 *   4. 压缩留痕：`write_memory` 缩水 ≥20% 时落盘内容带 `compressed_from_bytes`（真跑工具执行器）；
 *   5. 挂点接线：`archive_segment` 只在改写模式注册、转调裁段模块并落 `op:'trim'` 变更账；
 *   6. `OP_LABEL` 有 `trim`。
 *
 * 必须知道的坑（与其它套件同源）：`SAGE_MEM_DIR` / `SAGE_MEM_STATE_DIR`（以及从状态根读的
 * `reserved.json`）都是**模块顶层**读的 —— 必须在动态 import **之前**设好 / 写好，
 * 静态 import 会被提升到赋值之前。
 *
 * 全程只碰临时目录，结束时自清理。
 *
 * 用法: node test/autodream-size-test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const group = (t) => console.log(`== ${t} ==`)
const j = (v) => (typeof v === 'string' ? v : JSON.stringify(v))

// ── 沙箱：先设环境、先写保护名单，再动态 import ─────────────────
const sandbox = mkdtempSync(join(tmpdir(), 'sm-autodream-size-'))
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
const hugeIndexDir = join(sandbox, 'memory-huge-index')
mkdirSync(memDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
mkdirSync(hugeIndexDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')

/** 使用者自己声明的保护名单（`<状态根>/reserved.json`，小写存放）。 */
const RESERVED_NAME = 'reference_big_reserved.md'
writeFileSync(join(stateDir, 'reserved.json'), JSON.stringify([RESERVED_NAME]), 'utf8')

const auditMod = await import(new URL('../lib/autodream/audit.js', import.meta.url).href)
const promptMod = await import(new URL('../lib/autodream/prompt.js', import.meta.url).href)
const toolsMod = await import(new URL('../lib/autodream/tools.js', import.meta.url).href)
const sizeTools = await import(new URL('../lib/autodream/size-tools.js', import.meta.url).href)
const utilMod = await import(new URL('../lib/autodream/util.js', import.meta.url).href)
const { AutodreamEngine } = await import(new URL('../lib/autodream.js', import.meta.url).href)

const F = (n) => join(memDir, n)
const entryText = (name, type, body, desc = '一句话描述') =>
  `---\nname: ${name}\ndescription: '${desc}'\ntype: ${type}\n---\n\n${body}\n`
/** 造一段正文：`n` 行、每行约 `width` 个汉字（3 字节/字）。 */
const filler = (n, width) =>
  Array.from({ length: n }, (_, i) => `- 第 ${i + 1} 条：${'细'.repeat(width)}`).join('\n')

// ── 夹具：一条正常、一条提醒线、一条强制线、一条保留名、一份流水、一份索引 ──
const SMALL_BODY = '## 现状\n\n- 一切正常\n'
const WARN_BODY = `## 提醒线\n\n${filler(420, 14)}` // ≈ 420 × 59B ≈ 24 KB（2.10.2：提醒线 16 KB）
const FORCE_BODY = `## 强制线\n\n${filler(410, 30)}` // ≈ 410 × 107B ≈ 43 KB（2.10.2：强制线 40 KB）
const RESERVED_BODY = `## 手写单副本\n\n${filler(420, 30)}` // 同样超强制线，但在保护名单里
const SESSION_LOG_BODY = filler(300, 30)

writeFileSync(F('project_small.md'), entryText('project_small', 'project', SMALL_BODY, '小条目'), 'utf8')
writeFileSync(F('project_warn.md'), entryText('project_warn', 'project', WARN_BODY, '接近强制线'), 'utf8')
writeFileSync(F('project_force.md'), entryText('project_force', 'project', FORCE_BODY, '必须处置'), 'utf8')
writeFileSync(F(RESERVED_NAME), entryText('reference_big_reserved', 'reference', RESERVED_BODY, '手写单副本'), 'utf8')
writeFileSync(F('session-log.md'), SESSION_LOG_BODY, 'utf8')
// 索引：13 KB 左右（→ warn），且有一行远超单行字符上限（长行提示）。
const indexLines = [
  '# 索引',
  '- [小条目](project_small.md) — 小条目',
  '- [提醒线](project_warn.md) — 接近强制线',
  '- [强制线](project_force.md) — 必须处置',
  '- [保留名](reference_big_reserved.md) — 手写单副本',
  `- ${'长'.repeat(300)}`,
  ...Array.from({ length: 150 }, (_, i) => `- [填充 ${i}](project_small.md) — 把索引撑到提醒线以上`),
]
writeFileSync(F('MEMORY.md'), indexLines.join('\n'), 'utf8')

// ═══ 1. 审计：两个新数组 + problems 只计强制线 ═══
group('1. 审计 oversize / indexOversize（保护名单与非条目不计）')
{
  const report = await auditMod.auditMemoryDir(memDir)
  const files = (report.oversize ?? []).map((o) => o.file)
  ok(Array.isArray(report.oversize), '审计结果多了一个 oversize 数组（机读面才不会漏）')
  ok(Array.isArray(report.indexOversize), '审计结果多了一个 indexOversize 数组')
  ok(files.length === 2, `oversize 只收超线的两条（实际 ${j(files)}）`)
  const force = (report.oversize ?? []).find((o) => o.file === 'project_force.md')
  const warn = (report.oversize ?? []).find((o) => o.file === 'project_warn.md')
  ok(!!force && force.level === 'force' && force.bytes >= 40 * 1024,
    '43 KB 的条目判成 force（≥40 KB）', j(force))
  ok(!!warn && warn.level === 'warn' && warn.bytes >= 16 * 1024 && warn.bytes < 40 * 1024,
    '24 KB 的条目判成 warn（16~40 KB 之间）', j(warn))
  ok(!files.includes(RESERVED_NAME), '保护名单里的文件不计入超线（哪怕它 44 KB）', j(files))
  ok(!files.includes('session-log.md'), '追加型流水不计入超线（它不是一条记忆）', j(files))
  ok(!files.includes('project_small.md'), '正常条目不出现在 oversize 里', j(files))
  ok(report.problems === 1, 'problems 只计强制线那一条（warn 只提示）', `problems=${report.problems}`)
  ok(report.indexOversize.length === 1 && report.indexOversize[0].file === 'MEMORY.md',
    '索引超长单列一条（仅 MEMORY.md）', j(report.indexOversize))
  ok((report.indexOversize[0]?.longLines ?? 0) >= 1, '索引超长里带「超长行有几行」',
    j(report.indexOversize[0]))
  const text = auditMod.formatAudit(report)
  ok(text.includes('≥40 KB 必须处置'), 'formatAudit 的超线段标题带处置建议（≥40 KB 必须处置）')
  ok(text.includes('· 必须处置') && text.includes('· 提醒'), '同一条超线段里逐行标出「必须处置 / 提醒」', text)
  ok(text.includes('索引过长') && text.includes('只报不改'), 'formatAudit 有「索引过长（只报不改）」那一节')
  ok(!text.includes(RESERVED_NAME), '保护名单里的文件不出现在审计文本里（不催人动它）', text.slice(0, 200))
}

// 索引超强制线时**也不进 problems**：这是「只报不改」最关键的一条（否则挂一盏关不掉的红灯）
group('1b. 索引超过整份上限：报出来，但永不计入 problems')
{
  const hugeIndex = [
    '# 索引',
    '- [小条目](project_small.md) — 小条目',
    ...Array.from({ length: 400 }, () => `- ${'索'.repeat(40)}`),
  ].join('\n')
  writeFileSync(join(hugeIndexDir, 'MEMORY.md'), hugeIndex, 'utf8')
  writeFileSync(
    join(hugeIndexDir, 'project_small.md'),
    entryText('project_small', 'project', '## 现状\n\n- 一切正常\n', '小条目'),
    'utf8',
  )
  const report = await auditMod.auditMemoryDir(hugeIndexDir)
  ok(report.indexOversize.length === 1 && report.indexOversize[0].bytes > 24 * 1024,
    `索引超过 24 KB 被报出来（实际 ${report.indexOversize[0]?.bytes ?? 0} 字节）`, j(report.indexOversize))
  ok(report.problems === 0, '索引超长不进 problems（只报不改）', `problems=${report.problems}`)
}

// ═══ 1c. typert 传输契约：strict 不剥掉两个新字段 ═══
group('1c. typert 审计 schema：新字段必须声明（strict 会剥掉没声明的）')
{
  const { TYPERT } = await import(new URL('../lib/typert.host.js', import.meta.url).href)
  const schema = TYPERT.invocations.find((i) => i.id === 'sage-mem#memory/audit')?.result?.schema
  ok(!!schema, '找到 memory/audit 的结果 schema（传输契约的落点）')
  const sample = {
    dir: 'x',
    fileCount: 2,
    skipped: 0,
    archivedCount: 0,
    indexEntries: 1,
    dangling: [],
    unlisted: [],
    typeMismatch: [],
    crlf: [],
    brokenLinks: [],
    archivedLinks: [],
    hashHazards: [],
    noFrontmatter: [],
    unreadable: [],
    strays: [],
    validityHints: [],
    oversize: [{ file: 'a.md', bytes: 44100, level: 'force' }],
    indexOversize: [{ file: 'MEMORY.md', bytes: 30000, longLines: 2 }],
    problems: 1,
  }
  const parsed = schema.parse(sample)
  ok(
    Array.isArray(parsed.oversize) && parsed.oversize[0]?.level === 'force',
    'oversize 穿过 strict 保留下来（不声明就会被剥掉，面板与模型面口径分叉）',
    j(parsed.oversize),
  )
  ok(Array.isArray(parsed.indexOversize) && parsed.indexOversize[0]?.longLines === 2,
    'indexOversize 同样保留', j(parsed.indexOversize))
  // 老调用方（或旧运行记录回放）不带这两个字段也必须能过 —— 否则升级即全红。
  const { oversize, indexOversize, ...legacyIn } = sample
  const legacy = schema.parse(legacyIn)
  ok(legacy.problems === 1 && !('oversize' in legacy), '不带新字段的旧审计结果照样能过（optional）',
    j(Object.keys(legacy).filter((k) => k.includes('versize'))))
}

// ═══ 2. 提示词：阶段 3.5 + archive_segment + 保护名单措辞 ═══group('2. 提示词（阶段 3.5 体积治理）')
{
  const now = Date.UTC(2026, 10, 15, 12)
  const applyPrompt = promptMod.buildAutodreamUserPrompt({
    memoryDir: memDir,
    apply: true,
    hoursSince: 20,
    sessionCount: 3,
    now,
  })
  ok(applyPrompt.includes('## 阶段 3.5'), '用户提示里有「## 阶段 3.5」一节')
  ok(applyPrompt.includes('体积治理'), '这一节的标题是体积治理')
  ok(applyPrompt.indexOf('## 阶段 3.5') > applyPrompt.indexOf('## 阶段 3'),
    '阶段 3.5 排在阶段 3 之后（顺序照契约）')
  ok(applyPrompt.indexOf('## 阶段 3.5') < applyPrompt.indexOf('## 阶段 4'),
    '阶段 3.5 排在阶段 4 之前')
  ok(applyPrompt.includes('archive_segment'), '改写模式的提示点名了 archive_segment（不点名模型不会用）')
  ok(applyPrompt.includes('write_memory'), '也给了拆不开时的另一条路（write_memory 压缩）')
  ok(applyPrompt.includes('40 KB'), '写清了强制线的数值')
  ok(applyPrompt.includes('reason'), '提醒裁段必须带 reason')
  ok(/说明为什么|说明为什么/.test(applyPrompt) && applyPrompt.includes('回报里'), '一条都没处置时要求回报说明为什么')

  const reportPrompt = promptMod.buildAutodreamUserPrompt({
    memoryDir: memDir,
    apply: false,
    hoursSince: 20,
    sessionCount: 3,
    now,
  })
  ok(reportPrompt.includes('## 阶段 3.5'), '只出报告模式也有阶段 3.5（否则模型根本不知道体积线存在）')
  ok(!reportPrompt.includes('archive_segment'), '只出报告模式不点名写工具（那一趟它没有手）', reportPrompt.slice(0, 80))

  const sys = promptMod.buildAutodreamSystemPrompt({
    apply: true,
    withSessions: false,
    reservedFiles: ['project_mine.md'],
  })
  ok(sys.includes('project_mine.md'), '系统提示里带使用者声明的保护名单')
  ok(sys.includes('不计入超线'), '保护名单措辞扩写成「不许改、也不计入超线」')
  ok(sys.includes('也不计入超线') || sys.includes('不算「待处置」'), '措辞包含「体积再大也不算待处置」的意思')
}

// ═══ 3. 声明：manifest.trim 与「裁剪与压缩」一节 ═══
group('3. 整理声明与 manifest.trim')
{
  const ctx = { get: () => undefined, logger: { warn: () => {}, error: () => {} } }
  const engine = new AutodreamEngine(ctx, { memoryDir: memDir, sessionsRoot: '' })
  await engine.load()
  const at = Date.parse('2026-11-15T10:00:00Z')
  const mkChange = ({ seq, file, op, reason, beforeBytes, afterBytes, extra = {} }) => ({
    seq,
    at,
    atHuman: '2026-11-15 18:00',
    step: 3,
    file,
    op,
    reason,
    reasonSource: 'model',
    before: { exist: true, bytes: beforeBytes, sha256: null },
    after: { exist: true, bytes: afterBytes, sha256: null },
    deltaBytes: afterBytes - beforeBytes,
    ...extra,
  })
  const changes = [
    mkChange({
      seq: 1,
      file: 'project_force.md',
      op: 'trim',
      reason: '旧方案已被现行方案取代',
      beforeBytes: 44100,
      afterBytes: 9000,
      extra: { archivedFile: 'project_force-旧方案-20261115.md', segmentBytes: 11000 },
    }),
    mkChange({
      seq: 2,
      file: 'project_warn.md',
      op: 'update',
      reason: '合并重复段落',
      beforeBytes: 9000,
      afterBytes: 6000,
      extra: { compressed: true, compressedFromBytes: 9000 },
    }),
  ]
  const decl = await engine.writeDeclaration({
    runId: '20261115-180000-abcd',
    startedAt: at - 30_000,
    endedAt: at,
    reason: '手动触发',
    apply: true,
    source: 'memory',
    provider: 'p',
    model: 'm',
    fromDefault: false,
    hoursSince: 20,
    sessionCount: 3,
    tokensIn: 100,
    tokensOut: 20,
    snapshot: null,
    changes,
    warnings: [],
    notes: [],
    auditBefore: {
      problems: 2,
      oversize: [
        { file: 'project_force.md', bytes: 44100, level: 'force' },
        { file: 'project_warn.md', bytes: 24000, level: 'warn' },
        { file: 'project_untouched.md', bytes: 41000, level: 'force' },
      ],
      indexOversize: [{ file: 'MEMORY.md', bytes: 13000, longLines: 2 }],
    },
    auditAfter: { problems: 0, oversize: [], indexOversize: [] },
    finalText: '这趟裁了一段、压了一段。',
  })
  const trim = decl.manifest.trim
  ok(!!trim, 'manifest 有顶层键 trim')
  ok(trim.requested === 2, `requested = 运行前超过强制线的条数（实际 ${trim?.requested}）`, j(trim))
  ok(trim.applied.length === 2, `applied 记了两条（实际 ${trim?.applied?.length}）`, j(trim?.applied))
  ok(trim.applied[0].op === 'trim' && trim.applied[0].archivedFile === 'project_force-旧方案-20261115.md',
    '第一条是 op:trim，带归档件名', j(trim.applied[0]))
  ok(trim.applied[1].op === 'compress', '第二条是 op:compress（write_memory 缩水自动留痕那一笔）', j(trim.applied[1]))
  ok(trim.deferred === false, '运行后超线条数降到 0 → deferred=false', j(trim.deferred))
  ok(trim.skipped.some((s) => s.file === 'MEMORY.md' && s.why === 'protected'),
    '索引超长落在 skipped/protected（只报不改）', j(trim.skipped))
  ok(trim.skipped.some((s) => s.file === 'project_untouched.md' && s.why === 'deferred'),
    '超线却没动的条目落在 skipped/deferred', j(trim.skipped))
  ok(decl.manifest.archive.archived.length === 0, 'trim 没有混进 archive.archived（那会被回滚当成整条退役）')
  ok(!decl.manifest.changes.some((c) => c === trim), 'trim 是独立键，不是 changes 里的某一条')

  const md = decl.markdown
  ok(md.includes('裁剪与压缩'), '声明里有「裁剪与压缩」一节')
  ok(md.includes('| 文件 | 操作 | 缘由 | 体积变化 |'), '这一节是四列表（文件/操作/缘由/体积变化）')
  ok(md.includes('`project_force.md`') && md.includes('裁段归档'), '逐条给出文件与操作（裁段归档）', md.slice(0, 400))
  ok(md.includes('就地压缩'), '压缩那条也在表里（就地压缩）')
  ok(md.includes('旧方案已被现行方案取代'), '缘由逐条列出（人靠它判断裁得对不对）')
  ok(md.includes('43.1KB → 8.8KB'), '体积变化按 before → after 给（KB）')
  ok(md.includes('archive/project_force-旧方案-20261115.md'), '裁段那条标出归档件落点')
  ok(md.includes('只报不改'), 'protected 的条目单列一句（不催人去动索引）')
  ok(md.includes('本趟没处置'), 'deferred 的条目单列一句', md.slice(0, 600))
  // 这一节必须排在「被删掉的事实」之后、「自动归档候选」之前 —— 顺序错了会被读成同一件事。
  ok(md.indexOf('裁剪与压缩') > md.indexOf('被删掉的事实'), '排在「被删掉的事实」之后')
  // 表格行不能以 `| 数字 |` 开头：ad-smoke 用它数「改动表有几行」，两种表混在一起会数错。
  ok((md.match(/^\| \d+ \|/gm) || []).length === 2, '改动表仍是 2 行（裁剪表不冒充改动表）')

  const stored = JSON.parse(readFileSync(join(decl.dir, 'manifest.json'), 'utf8'))
  ok(!!stored.trim && stored.trim.applied.length === 2, '落盘的 manifest.json 里也有 trim（面板/回放读它）')

  // 超线条数没下降 → deferred=true，声明里必须明说。
  const decl2 = await engine.writeDeclaration({
    runId: '20261115-190000-abcd',
    startedAt: at,
    endedAt: at + 30_000,
    reason: '手动触发',
    apply: true,
    source: 'memory',
    provider: 'p',
    model: 'm',
    fromDefault: false,
    hoursSince: 20,
    sessionCount: 3,
    tokensIn: 10,
    tokensOut: 5,
    snapshot: null,
    changes: [],
    warnings: [],
    notes: [],
    auditBefore: { problems: 1, oversize: [{ file: 'project_force.md', bytes: 44100, level: 'force' }], indexOversize: [] },
    auditAfter: { problems: 1, oversize: [{ file: 'project_force.md', bytes: 44100, level: 'force' }], indexOversize: [] },
    finalText: '什么都没做。',
  })
  ok(decl2.manifest.trim.deferred === true, '超线条数没降 → deferred=true', j(decl2.manifest.trim))
  ok(decl2.markdown.includes('没有下降'), '声明里明说「没有下降」（不能静默）', decl2.markdown.slice(0, 400))
  ok(decl2.manifest.trim.applied.length === 0 && decl2.markdown.includes('本趟没有裁段或压缩'),
    '零动作时那一节也如实写「没有裁段或压缩」')
}

// ═══ 4. 压缩留痕：write_memory 缩水 ≥20% ═══
group('4. 压缩留痕（落盘前自动补 compressed_*）')
{
  const ctx = { get: () => undefined, logger: { warn: () => {}, error: () => {} } }
  const runner = toolsMod.createToolRunner({ memoryDir: memDir, sessionsRoot: '', apply: true, withSessions: false, ctx })
  const bigBody = `## 部署\n\n${filler(150, 20)}`
  writeFileSync(F('project_huge.md'), entryText('project_huge', 'project', bigBody, '很长的部署记录'), 'utf8')
  const beforeBytes = readFileSync(F('project_huge.md')).length
  const out = await runner.run('write_memory', {
    file: 'project_huge.md',
    content: entryText('project_huge', 'project', '## 部署\n\n- 只在服务器上跑，入口 deploy.sh\n', '部署记录（已压缩）'),
    reason: '压缩掉重复的部署步骤',
  })
  ok(String(out).startsWith('已写入'), '缩水写入成功', String(out))
  const disk = readFileSync(F('project_huge.md'), 'utf8')
  ok(disk.includes(`compressed_from_bytes: ${beforeBytes}`), '落盘内容带 compressed_from_bytes（原始体积）',
    `want=${beforeBytes} got=${disk.match(/compressed_from_bytes: \d+/)?.[0] ?? '(缺失)'}`)
  ok(disk.includes("compressed_reason: '压缩掉重复的部署步骤'"), '落盘内容带 compressed_reason（模型自述的缘由）',
    disk.match(/compressed_reason: .*/)?.[0] ?? '(缺失)')
  ok(/compressed_at: '[^']+'/.test(disk), '落盘内容带 compressed_at（时间）', disk.match(/compressed_at: .*/)?.[0] ?? '(缺失)')
  ok(readFileSync(F('project_huge.md')).length < beforeBytes * 0.8, '确实缩水到 80% 以下',
    `${beforeBytes} → ${readFileSync(F('project_huge.md')).length}`)
  const last = runner.changes().at(-1)
  ok(last?.op === 'update' && last?.compressed === true, '变更账里这一笔标了 compressed（声明据此记成压缩）', j({
    op: last?.op,
    compressed: last?.compressed,
  }))

  // 反向对照：内容**变大**时不补留痕（留痕只在真的压过时出现，否则人人头上都顶一条）。
  writeFileSync(F('project_grow.md'), entryText('project_grow', 'project', '## 现状\n\n- 一条\n', '会变大'), 'utf8')
  const grown = await runner.run('write_memory', {
    file: 'project_grow.md',
    content: entryText('project_grow', 'project', `## 现状\n\n${filler(40, 10)}`, '会变大'),
    reason: '补了三条新进展',
  })
  const growDisk = readFileSync(F('project_grow.md'), 'utf8')
  ok(String(grown).startsWith('已写入') && !growDisk.includes('compressed_at'),
    '内容变大的改写不补压缩留痕（反向对照）', growDisk.slice(0, 200))
  ok(!runner.changes().at(-1).compressed, '这一笔的变更账也没有 compressed 标记')

  // 反复补留痕不能攒出重复键（YAML 后者覆盖前者，两份同时存在就像两条互相矛盾的记录）。
  const once = sizeTools.withCompressionNote('---\nname: x\ntype: project\n---\n\n正文\n', {
    reason: '第一次压缩',
    fromBytes: 9000,
    at: Date.parse('2026-11-15T10:00:00Z'),
  })
  const twice = sizeTools.withCompressionNote(once, { reason: '第二次压缩', fromBytes: 4000, at: Date.now() })
  ok((twice.match(/^compressed_at:/gm) || []).length === 1, '重复压缩只留一份 compressed_at', twice)
  ok(twice.includes('第二次压缩') && !twice.includes('第一次压缩'), '留痕取最后一次（覆盖旧的）', twice)
  ok(twice.includes('compressed_from_bytes: 4000'), 'compressed_from_bytes 也取最后一次')
}

// ═══ 5. 挂点：archive_segment 的注册面与转调 ═══
group('5. archive_segment 挂点（只在改写模式注册 + 落 op:trim）')
{
  const applyTools = toolsMod.autodreamToolSchemas({ apply: true, withSessions: false }).map((t) => t.name)
  const reportTools = toolsMod.autodreamToolSchemas({ apply: false, withSessions: false }).map((t) => t.name)
  ok(applyTools.includes('archive_segment'), '改写模式注册了 archive_segment', j(applyTools))
  ok(!reportTools.includes('archive_segment'), '只出报告模式**没有**这个工具（不是靠提示词约束）', j(reportTools))
  const schema = toolsMod.autodreamToolSchemas({ apply: true, withSessions: false }).find((t) => t.name === 'archive_segment')
  ok(JSON.stringify(schema.parameters.required) === JSON.stringify(['file', 'reason']),
    '参数面：file 与 reason 必填', j(schema.parameters.required))
  ok(['heading', 'startLine', 'endLine'].every((k) => k in schema.parameters.properties),
    '参数面：heading 与 startLine/endLine 都在（二选一由执行器判）', j(Object.keys(schema.parameters.properties)))

  // 只出报告模式下调它 → 一句错误文案，不抛。
  const dry = await sizeTools.runArchiveSegment(
    { file: 'project_force.md', heading: '强制线', reason: '旧内容进档案馆' },
    { memoryDir: memDir, apply: false },
  )
  ok(typeof dry === 'string' && dry.startsWith('错误'), '只出报告模式调用回错误文案（永不抛）', dry.slice(0, 120))

  // 真跑一次：伪 ctx（没有宿主 fs）→ 走 memory/trim-archive.js 的写序。
  const ctx = { get: () => undefined, logger: { warn: () => {}, error: () => {} } }
  const trimBody =
    `## 现行方案\n\n${filler(40, 12)}\n\n## 旧方案\n\n${filler(60, 12)}`
  writeFileSync(F('project_trim.md'), entryText('project_trim', 'project', trimBody, '要裁一段的条目'), 'utf8')
  const runner = toolsMod.createToolRunner({ memoryDir: memDir, sessionsRoot: '', apply: true, withSessions: false, ctx })
  const trimmed = await runner.run('archive_segment', {
    file: 'project_trim.md',
    heading: '旧方案',
    reason: '旧方案已被现行方案取代',
  })
  ok(String(trimmed).startsWith('已裁剪'), '裁段成功（转调 memory/trim-archive.js）', String(trimmed).slice(0, 200))
  const afterTrim = readFileSync(F('project_trim.md'), 'utf8')
  ok(afterTrim.includes('已归档到 archive/'), '主文件原位置留了一行指针（工具自动做的，模型不用管）',
    afterTrim.slice(-260))
  const lastChange = runner.changes().at(-1)
  ok(lastChange?.op === 'trim' && lastChange?.file === 'project_trim.md', '变更账落 op:trim（声明与回滚靠它）',
    j({ op: lastChange?.op, file: lastChange?.file }))
  ok(lastChange?.archivedFile && /^project_trim-.+\.md$/.test(lastChange.archivedFile),
    '变更账里带归档件名（回执与声明要用）', j(lastChange?.archivedFile))
  ok(lastChange?.before?.bytes > lastChange?.after?.bytes, '变更账的前后字节真的变小了', j({
    before: lastChange?.before?.bytes,
    after: lastChange?.after?.bytes,
  }))
  ok(existsSync(join(memDir, 'archive', lastChange.archivedFile)), '归档件真的落在 archive/ 里（只移不删）',
    lastChange?.archivedFile)
  ok(existsSync(join(memDir, 'project_trim.md')), '主文件仍在顶层（裁段不是整条归档）')

  // 参数面错误一律回文案：heading 与行区间同时给、都不给、缺 reason。
  const both = await runner.run('archive_segment', {
    file: 'project_trim.md',
    heading: '现行方案',
    startLine: 1,
    endLine: 3,
    reason: '两个选择器都给',
  })
  ok(String(both).startsWith('错误') && String(both).includes('只能给一种'), 'heading 与行区间同时给 → 回文案拒绝',
    String(both).slice(0, 120))
  const neither = await runner.run('archive_segment', { file: 'project_trim.md', reason: '没给选择器' })
  ok(String(neither).startsWith('错误'), '两个选择器都不给 → 回文案要求说清裁哪段', String(neither).slice(0, 120))
  const noReason = await runner.run('archive_segment', { file: 'project_trim.md', heading: '现行方案' })
  ok(String(noReason).startsWith('错误') && String(noReason).includes('reason'), '缺 reason → 回文案拒绝',
    String(noReason).slice(0, 120))
  const reserved = await runner.run('archive_segment', {
    file: RESERVED_NAME,
    heading: '手写单副本',
    reason: '想裁一段试试',
  })
  ok(String(reserved).startsWith('错误') && String(reserved).includes('reserved'),
    '保护名单里的文件被裁段层拒绝（工具面不放行）', String(reserved).slice(0, 160))
}

// ═══ 6. OP_LABEL ═══
group('6. OP_LABEL 有 trim')
{
  ok(utilMod.OP_LABEL.trim === '裁段归档', `OP_LABEL.trim = ${utilMod.OP_LABEL.trim}`, j(utilMod.OP_LABEL))
  ok(utilMod.OP_LABEL.create === '新建' && utilMod.OP_LABEL.update === '改写' && utilMod.OP_LABEL.archive === '归档',
    '旧的三项没被改动（兼容声明里已有的表格）', j(utilMod.OP_LABEL))
}

// ── 收尾 ────────────────────────────────────────────────────
rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
