#!/usr/bin/env node
/**
 * review-211-q17-test.mjs — 外部审查 Q17 的回归（2.1.18）
 *
 * 问题：体检对索引大小写的规则与其他入口不一致。
 *   `audit.js` 读取索引硬编码 `MEMORY.md`，排除索引又用精确字符串比较；索引合法地
 *   叫 `memory.md`（或其他大小写）时，体检把索引本身报成「漏索引 + 无 frontmatter」，
 *   而其他入口早已按大小写归一 / 实际索引名查找。
 *
 * 判据：
 *   1. memory.md / MEMORY.md / MEMORY.MD 三种写法下，体检结果**逐项一致**，
 *      且索引本身既不算条目、也不报「漏索引 / 无 frontmatter / type 与前缀」；
 *      报告里的 `indexFile` 是**真实读到的那个名字**（不是硬编码的常量）。
 *   2. 大小写敏感卷上同时存在两个变体 → **单独报冲突**（计入 problems、formatAudit 有专节），
 *      且两份索引都不被当成「漏索引」；删掉多余的之后冲突消失。
 *      大小写不敏感卷上做不到两份并存 —— 断言这一事实本身（而不是假装测过了）。
 *   3. 反向对照：真实记忆文件没进索引仍然报「漏索引」、前缀不一致仍然报 ——
 *      证明这次修的是索引识别规则，不是把检查删了。
 *
 * 大小写敏感性**运行时探测**（`_platform.mjs` 的 `fsIsCaseInsensitive`），
 * 不按 `process.platform` 猜：NTFS 默认不区分、Linux 区分，两边都要绿。
 *
 * 用法: node test/review-211-q17-test.mjs
 */
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatAudit, auditMemoryDir } from '../lib/autodream/audit.js'
import { fsIsCaseInsensitive } from './_platform.mjs'

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
const group = (t) => console.log(`== ${t} ==`)
const j = (v) => JSON.stringify(v)

const root = await mkdtemp(join(tmpdir(), 'sage-mem-q17-'))
const memDir = join(root, 'memory')
await mkdir(memDir, { recursive: true })

/** 索引的三种合法写法（大小写不同，同一个文件的不同拼法）。 */
const VARIANTS = ['memory.md', 'MEMORY.md', 'MEMORY.MD']
const INDEX_PLAIN = '# 记忆索引\n\n- [项目 A](project_a.md) — 项目 A 的现状\n- [用户偏好](user_b.md) — 用户偏好\n'
const INDEX_WITH_FM = '---\nname: 记忆索引\ntype: reference\n---\n\n- [项目 A](project_a.md) — 项目 A 的现状\n- [用户偏好](user_b.md) — 用户偏好\n'

/** 一条正常记忆（带 frontmatter）。 */
const MEMORY = (frontmatter) => `---\n${frontmatter}\n---\n\n正文。\n`

/** 清掉全部索引写法，再用指定名字写一份（NTFS 上不先删会沿用旧名字的拼法）。 */
async function writeIndex(name, text) {
  for (const v of VARIANTS) await unlink(join(memDir, v)).catch(() => {})
  await writeFile(join(memDir, name), text, 'utf8')
}

/** 清掉记忆文件与索引，按用例重建。 */
async function resetDir() {
  await rm(memDir, { recursive: true, force: true })
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'project_a.md'), MEMORY('name: project-a\ntype: project\ndescription: 项目 A'), 'utf8')
  await writeFile(join(memDir, 'user_b.md'), MEMORY('name: user-b\ntype: user\ndescription: 用户偏好'), 'utf8')
}

/** 只看「与索引拼法无关」的那几项：它们必须在三种写法下完全一致。 */
const stable = (r) => j({
  problems: r.problems,
  fileCount: r.fileCount,
  indexEntries: r.indexEntries,
  unlisted: r.unlisted.map((x) => x.file),
  dangling: r.dangling.map((x) => x.file),
  noFrontmatter: r.noFrontmatter.map((x) => x.file),
  typeMismatch: r.typeMismatch.map((x) => x.file),
})

group('0. 前置：大小写敏感性是运行时探测出来的')
const caseInsensitive = await fsIsCaseInsensitive(root)
ok(typeof caseInsensitive === 'boolean', `探测到本卷${caseInsensitive ? '不区分' : '区分'}大小写（fsIsCaseInsensitive）`)

group('1. memory.md / MEMORY.md / MEMORY.MD 的体检结果一致')
{
  const reports = []
  for (const name of VARIANTS) {
    await resetDir()
    await writeIndex(name, INDEX_PLAIN)
    const r = await auditMemoryDir(memDir)
    reports.push({ name, r })
    ok(r.problems === 0, `${name}：健康库 problems === 0（实际 ${r.problems}）`, j(r.problems && {
      unlisted: r.unlisted, noFrontmatter: r.noFrontmatter, typeMismatch: r.typeMismatch,
    }))
    ok(r.unlisted.length === 0, `${name}：索引本身不被报成「漏索引」`, j(r.unlisted))
    ok(r.noFrontmatter.length === 0, `${name}：索引本身不被报成「无 frontmatter」`, j(r.noFrontmatter))
    ok(r.typeMismatch.length === 0, `${name}：索引本身不参与「type 与前缀」检查`, j(r.typeMismatch))
    ok(r.fileCount === 2, `${name}：条目数只算两条记忆（实际 ${r.fileCount}）`)
    ok(r.indexEntries === 2, `${name}：索引条数按真实内容读出（实际 ${r.indexEntries}）`)
    // 「读取用真实返回的名字」：报告里说得出它是从哪个名字读的，且与磁盘上的写法一致。
    ok(String(r.indexFile).toLowerCase() === name.toLowerCase(),
      `${name}：报告 indexFile 是真实读到的名字（实际 ${r.indexFile}）`)
  }
  ok(stable(reports[0].r) === stable(reports[1].r) && stable(reports[0].r) === stable(reports[2].r),
    '三种写法下的体检结果逐项一致',
    reports.map(({ name, r }) => `${name}: ${stable(r)}`).join('\n       '))
}

group('2. 大小写不敏感卷：同一目录只有一份索引（写不出「两个变体」）')
if (caseInsensitive) {
  await resetDir()
  await writeIndex('memory.md', INDEX_PLAIN)
  // 再按另一种拼法写一次同一个文件：NTFS 上它还是同一个目录项，只是内容被覆盖。
  await writeFile(join(memDir, 'MEMORY.md'), INDEX_WITH_FM, 'utf8')
  const r = await auditMemoryDir(memDir)
  ok((r.indexConflicts ?? []).length === 0, '不敏感卷上不存在索引变体冲突（预期 0）', j(r.indexConflicts))
  ok(r.problems === 0, '覆盖写之后健康库仍是 0 问题', j(r.problems))
  ok(String(r.indexFile).toLowerCase() === 'memory.md', `真实索引名仍是原目录项（实际 ${r.indexFile}）`)
} else {
  // 只在区分大小写的卷上才说明「这里测不了」—— 不静默跳过，也不假装通过。
  ok(true, '本卷区分大小写：不敏感卷的那条分支不适用（冲突场景在下面单独测）')
}

group('3. 大小写敏感卷：两个变体并存要单独报冲突')
if (!caseInsensitive) {
  await resetDir()
  const bothIndex = '# 记忆索引\n\n- [项目 A](project_a.md) — 项目 A 的现状\n- [用户偏好](user_b.md) — 用户偏好\n'
  await writeFile(join(memDir, 'MEMORY.md'), bothIndex, 'utf8')
  await writeFile(join(memDir, 'memory.md'), bothIndex, 'utf8')
  const r = await auditMemoryDir(memDir)
  const names = (r.indexConflicts ?? []).map((x) => x.file).sort()
  ok((r.indexConflicts ?? []).length === 2, `两个变体都被报出来（实际 ${j(names)}）`)
  ok(j(names) === j(['MEMORY.md', 'memory.md']), '报的就是那两个文件名（大小写写法原样）', j(names))
  ok(r.problems === 2, `冲突计入 problems（实际 ${r.problems}）`, j(r.problems))
  ok(r.unlisted.length === 0, '两份索引都**不**被当成「漏索引」', j(r.unlisted))
  ok(r.noFrontmatter.length === 0 && r.typeMismatch.length === 0, '也不被当成普通记忆检查', j({ noFrontmatter: r.noFrontmatter, typeMismatch: r.typeMismatch }))
  ok(r.indexFile === 'MEMORY.md', `优先读规范名（实际 ${r.indexFile}）`)
  const text = formatAudit(r)
  ok(text.includes('索引大小写冲突') && text.includes('MEMORY.md') && text.includes('memory.md'),
    'formatAudit 把冲突单列成节并点名两份文件', text.split('\n').filter((l) => l.includes('索引')).join(' / '))

  // 删掉多余的那份 → 冲突消失、健康库回到 0。
  await unlink(join(memDir, 'memory.md'))
  const after = await auditMemoryDir(memDir)
  ok((after.indexConflicts ?? []).length === 0 && after.problems === 0,
    '删掉多余变体后冲突消失、problems 回到 0', j({ conflicts: after.indexConflicts, problems: after.problems }))
} else {
  ok(true, '本卷不区分大小写：双变体场景无法构造（上面的「写不出两个变体」那条已覆盖）')
}

group('4. 反向对照：索引识别变了，但其他检查没有被顺手删掉')
{
  await resetDir()
  await writeIndex('memory.md', '# 记忆索引\n\n- [项目 A](project_a.md) — 项目 A 的现状\n')
  const r = await auditMemoryDir(memDir)
  ok(r.unlisted.length === 1 && r.unlisted[0].file === 'user_b.md',
    '小写索引下，真的没进索引的记忆仍报「漏索引」', j(r.unlisted))
  ok(!r.unlisted.some((x) => String(x.file).toLowerCase() === 'memory.md'),
    '但索引自己不在「漏索引」里（修的是识别规则，不是关掉检查）')
  ok(r.problems === 1, `problems 只有那条真实问题（实际 ${r.problems}）`)

  // 前缀检查：普通记忆写错 type 仍要报（索引自己的 type 不算）。
  await writeIndex('MEMORY.md', '# 记忆索引\n\n- [项目 A](project_a.md)\n- [用户偏好](user_b.md)\n')
  await writeFile(join(memDir, 'user_b.md'), MEMORY('name: user-b\ntype: project\ndescription: 用户偏好'), 'utf8')
  const t = await auditMemoryDir(memDir)
  ok(t.typeMismatch.length === 1 && t.typeMismatch[0].file === 'user_b.md',
    '【反向对照】user_b.md 的 type: project 仍被报前缀不一致', j(t.typeMismatch))
  ok(t.indexFile === 'MEMORY.md' && t.problems === 1, '索引仍免检，problems 只反映那条真实缺陷', j({ problems: t.problems, indexFile: t.indexFile }))
}

group('5. 索引定位规则本身（纯函数）：三种写法归一 + 多变体给冲突')
{
  const mod = await import('../lib/memory/index-file.js')
  // 2.1.18 新增的判据/定位函数。旧代码里没有 → 回落到「什么都不认」，
  // 这样修前跑出来的是**一条条失败的断言**，而不是 import 之后第一次调用就抛。
  const isIndexName = mod.isIndexName ?? (() => false)
  const resolveIndexNames = mod.resolveIndexNames ?? (() => ({ name: null, variants: [] }))
  ok(isIndexName('MEMORY.md') && isIndexName('memory.md') && isIndexName('MEMORY.MD'),
    'isIndexName 对三种写法都成立（大小写归一）')
  ok(!isIndexName('notes.md') && !isIndexName('my_memory.md'), '普通记忆文件不算索引（反向对照）')

  const single = resolveIndexNames(['notes.md', 'memory.md'])
  ok(single.name === 'memory.md' && single.variants.length === 1, '单变体：返回磁盘上的真实名字', j(single))
  const dual = resolveIndexNames(['memory.md', 'MEMORY.md', 'notes.md'])
  ok(dual.variants.length === 2 && j(dual.variants) === j(['MEMORY.md', 'memory.md']),
    '双变体：两个都列出来（排序稳定，便于报告）', j(dual))
  ok(dual.name === 'MEMORY.md', '双变体时优先规范名 MEMORY.md（而不是每次随意挑一个）', String(dual.name))
  const odd = resolveIndexNames(['MEMORY.MD'])
  ok(odd.name === 'MEMORY.MD' && odd.variants.length === 1, '只有一个非规范写法时就读它（不硬编码规范名）', j(odd))
  ok(resolveIndexNames([]).name === null && resolveIndexNames(null).name === null, '没有索引 → null，不抛')

  // formatAudit 对冲突的呈现：给一份**合成报告**（与 auditMemoryDir 返回同形），
  // 这样「冲突节怎么显示」在任何平台都能验，不必依赖本卷支不支持两份并存。
  const synthetic = {
    fileCount: 2, indexEntries: 2, problems: 2,
    dangling: [], unlisted: [], indexConflicts: [{ file: 'MEMORY.md' }, { file: 'memory.md' }],
    typeMismatch: [], crlf: [], brokenLinks: [], archivedLinks: [], validityHints: [],
    hashHazards: [], noFrontmatter: [], unreadable: [], strays: [],
  }
  const text = formatAudit(synthetic)
  ok(text.includes('索引大小写冲突') && text.includes('MEMORY.md') && text.includes('memory.md'),
    'formatAudit 的冲突节点名两份文件', text.split('\n').filter((l) => l.includes('索引')).join(' / '))
  ok(formatAudit({ ...synthetic, problems: 0, indexConflicts: [] }).includes('索引大小写冲突') === false,
    '没有冲突时不显示这一节（反向对照）')
}

await rm(root, { recursive: true, force: true })

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
