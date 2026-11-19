/**
 * 裁段归档的 **IO 层**（`lib/memory/trim-archive.js`）—— 完整写序，一步一验。
 *
 * 这个模块是全仓**唯一改写一条活记忆正文**的地方，所以测试的分工很明确：
 *   - `trim-plan-test.mjs` 验「算得对不对」（纯函数，无磁盘）；
 *   - 本套验「**顺序**对不对」：哪一步失败、留下什么状态、下一句能不能重来。
 *
 * 六个失败面各一组：撞名（`exists`）、版本变了（`stale_revision` + 退役件）、
 * 锁表坏了（`lock_unknown`）、锁定（`locked`）、保留名 / 非条目名（`reserved` / `non_entry`）、
 * 文件名不合法（`invalid_name`）。每条都断言**主文件一个字节没动** ——
 * 「拒绝了但顺手改了点什么」是这类代码最常见的事故形态。
 *
 * `stale_revision` 那组用了一个小手法：把 `selector` 做成 getter，`planTrim` 第一次读
 * `selector.heading` 时在**同一事件循环内**改写主文件 —— 这正好落在
 * 「readSnapshot 之后、writeSnapshot 之前」的窗口里，把 TOCTOU 窗口变成可复现的断言。
 * ⚠️ 它同时钉住写序：谁把 `planTrim` 挪到 `readSnapshot` 之前，这一组立刻红。
 *
 * 写法照 `test/archive-index-test.mjs`：`mkdtemp` 造临时记忆目录、末尾自清理、
 * 自研 `ok()`、结尾结果行。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const LIB = new URL('../lib/', import.meta.url)
const { trimArchive } = await import(new URL('memory/trim-archive.js', LIB).href)
const { planTrim } = await import(new URL('memory/trim-plan.js', LIB).href)
const { readArchivedMeta } = await import(new URL('memory/scan.js', LIB).href)
const { fnv1aHex } = await import(new URL('shared/hash.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) } else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

/** 固定时间戳（本地时间构造）：归档名里的日期与 `archived_at` 都由它决定。 */
const AT = new Date(2026, 10, 15, 9, 30, 0).getTime()
const REASON = '体积治理'

/**
 * 归档名的期望值：`<原名>-<slug>-<YYYYMMDD>-<hash4>.md`，hash 吃**被归档的正文**，
 * 所以它只能由纯函数算出来 —— 手抄一份字面量，实现一改（或 hash 输入一换）两边会一起旧。
 */
const nameOf = (src) => {
  const plan = planTrim({ content: src, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  return plan.ok ? plan.archiveName : ''
}
const ARCHIVED_NAME = nameOf(docOf())

const exists = async (p) => Boolean(await stat(p).then(() => true, () => false))

/** 夹具：与 `trim-plan-test.mjs` 同一份（行号固定，便于断言 range）。 */
function docOf({ eol = '\n', oldLines = 20, tail = 400, extraFm = [], second = '## 新段', title = '## 旧段' } = {}) {
  const old = Array.from({ length: oldLines }, (_, i) => `旧段第 ${i} 行 ` + '内容'.repeat(20)).join(eol)
  const lines = [
    '---',
    'name: 甲',
    'description: 体积治理夹具',
    'type: project',
    ...extraFm,
    '---',
    '',
    '# 标题',
    '',
    title,
    '',
    old,
    '',
    second,
    '',
    '尾巴 '.repeat(tail),
    '',
  ]
  return lines.join(eol)
}

const INDEX = ['# 记忆索引', '', '- [甲](note.md) — 夹具', '', ''].join('\n')

const tmp = []
async function makeDir(files = {}, { archive = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sage-mem-trim-'))
  tmp.push(root)
  const memoryDir = join(root, 'memory')
  await mkdir(memoryDir, { recursive: true })
  if (archive) await mkdir(join(memoryDir, 'archive'), { recursive: true })
  await writeFile(join(memoryDir, 'MEMORY.md'), INDEX, 'utf8')
  for (const [n, body] of Object.entries(files)) await writeFile(join(memoryDir, n), body, 'utf8')
  return { root, memoryDir }
}

console.log('== 1. 成功路径：归档件 + 主文件指针 + 字节数，索引与台账都不许动 ==')
{
  const src = docOf({ extraFm: ['baseline: true', 'aliases: [x]'] })
  const other = '---\nname: 乙\ndescription: 别的记忆\n---\n\n不该被动。\n'
  const { root, memoryDir } = await makeDir({ 'note.md': src, 'other.md': other })
  const indexBefore = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')

  const r = await trimArchive({ memoryDir, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  ok(r.ok === true, '裁段归档成功', JSON.stringify(r))
  ok(r.ok && r.archivedFile === ARCHIVED_NAME, `归档名 = 原名-slug-日期-hash4（${ARCHIVED_NAME}）`, r.ok ? r.archivedFile : '')
  ok(r.ok && /^note-旧段-20261115-[0-9a-f]{4}\.md$/.test(r.archivedFile), `落盘名是 4 段骨架，hash 段 4 位十六进制（实际 ${r.ok ? r.archivedFile : ''}）`, r.ok ? r.archivedFile : '')
  ok(r.ok && r.archivedFile === `note-旧段-20261115-${fnv1aHex(planTrim({ content: src, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT }).segment)}.md`,
    'hash 段 = 被归档那段正文的指纹（IO 侧原样落盘，不重算）', r.ok ? r.archivedFile : '')
  ok(r.ok && r.archivedPath === `archive/${ARCHIVED_NAME}`, 'archivedPath 带 archive/ 前缀（回执用）', r.ok ? r.archivedPath : '')
  ok(r.ok && r.pointer.includes(`archive/${r.archivedFile}`), '指针行里带**完整**新名字（含 hash 段，人能照着找回来）', r.ok ? r.pointer : '')

  const archivePath = join(memoryDir, 'archive', ARCHIVED_NAME)
  ok(await exists(archivePath), '归档件落在 archive/ 里')
  const doc = await readFile(archivePath, 'utf8')
  const meta = readArchivedMeta(doc)
  ok(meta.archivedAt === '2026-11-15 09:30', `归档件写了 archived_at（实际 ${JSON.stringify(meta.archivedAt)}）`)
  ok(meta.archivedReason === REASON, `归档件写了 archived_reason（实际 ${JSON.stringify(meta.archivedReason)}）`)
  ok(doc.includes('name: 甲') && doc.includes('description: 体积治理夹具') && doc.includes('type: project'), '归档件 frontmatter 沿用源 name / description / type')
  ok(doc.includes('tags:') === false, '源文件没有 tags → 归档件也不写 tags 行')
  ok(doc.includes(`archived_from: note.md`), '归档件写了 archived_from')
  ok(doc.includes('archived_slice: 旧段'), '归档件写了 archived_slice（小节标题）')
  ok(!doc.includes('baseline: true') && !doc.includes('aliases:'), '归档件**不**复制源 frontmatter 的其它字段（只留 name/description/type/tags）')

  /** 被裁段必须原样躺在归档件里（用纯函数算出来的段作对照，避免「两边一起错」）。 */
  const plan = planTrim({ content: src, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  ok(plan.ok && doc.includes(plan.segment), '归档件正文包含被裁段（逐字）')

  const main = await readFile(join(memoryDir, 'note.md'), 'utf8')
  ok(main.startsWith('---\nname: 甲'), '主文件仍以完整 frontmatter 起始')
  ok(main.includes(r.pointer) && new RegExp(`^${r.pointer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(main), '主文件在原位置留了一整行指针')
  ok(!main.includes('旧段第 19 行'), '旧段落已经从主文件里消失')
  ok(main.includes('## 新段') && main.includes('尾巴'), '指针之后的正文一个字没动')
  ok(main.replace(r.pointer, () => plan.segment) === src, '**往返**：主文件把指针换回段落后逐字节还原原文')

  ok(r.beforeBytes === Buffer.byteLength(src, 'utf8'), `beforeBytes = 原文件字节数（${r.beforeBytes}）`)
  ok(r.afterBytes === Buffer.byteLength(main, 'utf8'), `afterBytes = 新主文件字节数（${r.afterBytes}）`)
  ok(r.segmentBytes === Buffer.byteLength(plan.segment, 'utf8'), `segmentBytes = 被裁段字节数（${r.segmentBytes}）`)
  ok(r.afterBytes < r.beforeBytes, '主文件确实小了')
  // 夹具多带两行 frontmatter（baseline / aliases），所以 `## 旧段` 在第 11 行、旧段正文到第 32 行。
  ok(r.range.start === 11 && r.range.end === 32, 'range 回显真实裁剪区间', JSON.stringify(r.range))

  ok((await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')) === indexBefore, '**不摘索引**：文件还在，索引一个字节没动')
  ok(await exists(join(root, '.sage-mem', 'access.json')) === false, '**不写访问台账**：状态目录里没有 access.json')
  ok((await readFile(join(memoryDir, 'other.md'), 'utf8')) === other, '同目录其它记忆一个字节没动')
  ok((await readdir(join(memoryDir, 'archive'))).length === 1, 'archive/ 里只多了那一个归档件（没有临时文件残留）')
}

console.log('== 2. 撞名：exists，不覆盖、不改名、主文件不动 ==')
{
  const src = docOf()
  const { memoryDir } = await makeDir({ 'note.md': src }, { archive: true })
  const plan = planTrim({ content: src, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  const archivePath = join(memoryDir, 'archive', plan.archiveName)
  await writeFile(archivePath, 'SENTINEL — 上一次的归档\n', 'utf8')

  const r = await trimArchive({ memoryDir, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  ok(r.ok === false && r.code === 'exists' && r.stage === 'archive', '撞名 → exists，stage=archive', JSON.stringify(r))
  ok((await readFile(archivePath, 'utf8')) === 'SENTINEL — 上一次的归档\n', '已有归档件一个字节没被覆盖')
  ok((await readFile(join(memoryDir, 'note.md'), 'utf8')) === src, '撞名时主文件一个字节没动')
  ok((await readdir(join(memoryDir, 'archive'))).length === 1, '撞名时没有改名 / 没有多出副本')

  /**
   * 【反向对照】slug 从 40 收到 16 之后，「假撞名」由尾部的内容 hash 兜住：
   * 同一天、同一个标题、**不同正文** → 名字不同 → 照常落盘；而正文真重复才撞（上一组）。
   */
  const otherSrc = docOf().replace('旧段第 3 行', '旧段第 三 行')
  const { memoryDir: dir2 } = await makeDir({ 'note.md': otherSrc }, { archive: true })
  const otherSentinel = 'SENTINEL — 另一段正文的归档\n'
  await writeFile(join(dir2, 'archive', ARCHIVED_NAME), otherSentinel, 'utf8')
  const other = await trimArchive({ memoryDir: dir2, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  ok(other.ok === true, '同标题 + 同日 + 不同正文 → 不撞名（hash 把它们区分开）', JSON.stringify(other))
  ok(other.ok && other.archivedFile !== ARCHIVED_NAME && /-[0-9a-f]{4}\.md$/.test(other.archivedFile), '新件的 hash 段与另一段不同', other.ok ? other.archivedFile : '')
  ok((await readFile(join(dir2, 'archive', ARCHIVED_NAME), 'utf8')) === otherSentinel, '另一段正文的归档件一个字节没被碰')
}

console.log('== 3. 读完之后主文件被改：stale_revision + 归档件退役（不删）==')
{
  const src = docOf({ extraFm: ['marker: AAAA'] })
  const mutated = src.replace('marker: AAAA', 'marker: BBBB')
  const { memoryDir } = await makeDir({ 'note.md': src })
  const mainPath = join(memoryDir, 'note.md')
  ok(Buffer.byteLength(mutated, 'utf8') === Buffer.byteLength(src, 'utf8'), '（前提）改写后字节数不变 → 走 revision 判据而不是大小判据')

  // planTrim 读 selector.heading 时（readSnapshot 之后、writeSnapshot 之前）改写主文件。
  let armed = true
  const selector = {
    get heading() {
      if (armed) {
        armed = false
        writeFileSync(mainPath, mutated, 'utf8')
      }
      return '旧段'
    },
  }
  const r = await trimArchive({ memoryDir, name: 'note.md', selector, reason: REASON, at: AT })
  ok(r.ok === false && r.code === 'stale_revision', '版本变了 → stale_revision 原样透出', JSON.stringify(r))
  ok(r.stage === 'after_archive', 'stage=after_archive（归档件此刻已经写下去了）')
  ok((await readFile(mainPath, 'utf8')) === mutated, '主文件一个字节都没被我们写（别人的新版本保留在原处）')

  const files = await readdir(join(memoryDir, 'archive'))
  ok(!files.includes(ARCHIVED_NAME), '归档件不再占用原名（否则下次裁同一段永远撞名）')
  const retired = files.filter((f) => f.startsWith('.retired-') && f.endsWith('.md'))
  ok(retired.length === 1, `退役件恰好一个（实际：${files.join(', ') || '空'}）`)
  ok(r.error.includes(retired[0]), '错误文案里点名退役后的归档件', r.error)
  const retiredDoc = await readFile(join(memoryDir, 'archive', retired[0]), 'utf8')
  ok(retiredDoc.includes('旧段第 19 行'), '退役件里仍是被裁段的内容（**移动不删除**）')
  ok(retiredDoc.includes('archived_from: note.md'), '退役件保留了归档留痕（人工能看出它是什么）')

  // 重来一次（主文件已恢复稳定）：应当成功，且不再撞名。
  const again = await trimArchive({ memoryDir, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  ok(again.ok === true, '退役之后立刻重试能成功（退役就是为了不留占位）', JSON.stringify(again))
  ok(again.ok && again.archivedFile === ARCHIVED_NAME, '重试用的是原名（不是第二个退役名）')
}

console.log('== 4. 锁表坏了（unknown）：一律拒，且什么都不建 ==')
{
  const src = docOf()
  const { root, memoryDir } = await makeDir({ 'note.md': src })
  await mkdir(join(root, '.sage-mem'), { recursive: true })
  await writeFile(join(root, '.sage-mem', 'locked.json'), '{ 这不是 JSON', 'utf8')

  const r = await trimArchive({ memoryDir, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  ok(r.ok === false && r.code === 'lock_unknown' && r.stage === 'lock', '锁表不可读 → lock_unknown', JSON.stringify(r))
  ok((await readFile(join(memoryDir, 'note.md'), 'utf8')) === src, '锁表坏了时主文件一个字节没动')
  ok((await exists(join(memoryDir, 'archive'))) === false, '锁表坏了时连 archive/ 都不建')
}

console.log('== 5. 锁定：这条拒、别的照常 ==')
{
  const src = docOf()
  const { root, memoryDir } = await makeDir({ 'note.md': src, 'other.md': docOf() })
  await mkdir(join(root, '.sage-mem'), { recursive: true })
  await writeFile(join(root, '.sage-mem', 'locked.json'), JSON.stringify({ 'note.md': true }), 'utf8')

  const r = await trimArchive({ memoryDir, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  ok(r.ok === false && r.code === 'locked' && r.stage === 'lock', '锁定条目 → locked（改正文比整份归档更该尊重这把锁）', JSON.stringify(r))
  ok((await readFile(join(memoryDir, 'note.md'), 'utf8')) === src, '锁定条目一个字节没动')

  const other = await trimArchive({ memoryDir, name: 'other.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  ok(other.ok === true, '别的文件被锁不影响这一条（锁按 nameKey 精确匹配）', JSON.stringify(other))
}

console.log('== 6. 名字闸门：保留名 / 非条目名 / 路径成分 ==')
{
  const src = docOf()
  const { memoryDir } = await makeDir({ 'note.md': src, 'session-log.md': src })
  const sel = { heading: '旧段' }
  const reserved = await trimArchive({ memoryDir, name: 'MEMORY.md', selector: sel, reason: REASON, at: AT })
  ok(reserved.ok === false && reserved.code === 'reserved' && reserved.stage === 'name', '索引 → reserved', JSON.stringify(reserved))
  /**
   * ⚠️ 流水报 `reserved` 而不是 `non_entry`：`config.js:306` 的 RESERVED_FILES 是
   * `[INDEX_FILE_KEY, SESSION_LOG_KEY, ...readExtraReserved()]`，而 NON_ENTRY_FILES 是它的子集 ——
   * 契约 §3 第 2 步把 `isReserved` 排在 `isNonEntry` 前面，所以「两个都命中」的名字先报 reserved。
   * `non_entry` 因此是一支**防御性分支**（自定义保留名里若有非条目名才会用到），
   * 这里把它记成未覆盖事实，不在测试里假装覆盖到了。详见交付说明。
   */
  const nonEntry = await trimArchive({ memoryDir, name: 'session-log.md', selector: sel, reason: REASON, at: AT })
  ok(nonEntry.ok === false && nonEntry.code === 'reserved' && nonEntry.stage === 'name', '流水 → reserved（NON_ENTRY ⊆ RESERVED，保留名那一支先命中）', JSON.stringify(nonEntry))
  const traversal = await trimArchive({ memoryDir, name: '../evil.md', selector: sel, reason: REASON, at: AT })
  ok(traversal.ok === false && traversal.code === 'invalid_name', '带路径成分的名字 → invalid_name（防穿越）', JSON.stringify(traversal))
  const nested = await trimArchive({ memoryDir, name: 'sub/note.md', selector: sel, reason: REASON, at: AT })
  ok(nested.ok === false && nested.code === 'invalid_name', '带目录成分的名字 → invalid_name', JSON.stringify(nested))
  ok((await exists(join(memoryDir, 'archive'))) === false, '四个拒绝都没往 archive/ 写任何东西')
  ok((await readFile(join(memoryDir, 'note.md'), 'utf8')) === src, '四个拒绝都没动主文件')
}

console.log('== 7. 文件不存在 / 规划失败：code 透出，stage 分得清 ==')
{
  const src = docOf()
  const { memoryDir } = await makeDir({ 'note.md': src })
  const missing = await trimArchive({ memoryDir, name: 'nope.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  ok(missing.ok === false && missing.code === 'not_found' && missing.stage === 'read', '文件不存在 → not_found，stage=read', JSON.stringify(missing))
  const noHeading = await trimArchive({ memoryDir, name: 'note.md', selector: { heading: '不存在的段' }, reason: REASON, at: AT })
  ok(noHeading.ok === false && noHeading.code === 'heading_not_found' && noHeading.stage === 'plan', '规划失败 → heading_not_found，stage=plan', JSON.stringify(noHeading))
  const badReason = await trimArchive({ memoryDir, name: 'note.md', selector: { heading: '旧段' }, reason: '略', at: AT })
  ok(badReason.ok === false && badReason.code === 'reason_too_short' && badReason.stage === 'plan', '缘由太短 → reason_too_short，stage=plan', JSON.stringify(badReason))
  ok((await exists(join(memoryDir, 'archive'))) === false, '这三种失败都没建 archive/')
  ok((await readFile(join(memoryDir, 'note.md'), 'utf8')) === src, '这三种失败都没动主文件')
}

console.log('== 8. 行号选择器 + CRLF：落盘一侧也不许把换行归一 ==')
{
  const crlf = docOf({ eol: '\r\n' })
  const { memoryDir } = await makeDir({ 'note.md': crlf })
  const r = await trimArchive({ memoryDir, name: 'note.md', selector: { startLine: 11, endLine: 30 }, reason: REASON, at: AT })
  ok(r.ok === true, '行号选择器端到端成功', JSON.stringify(r))
  ok(r.ok && r.range.start === 11 && r.range.end === 30, 'range 回显 11-30', JSON.stringify(r.range))
  const main = await readFile(join(memoryDir, 'note.md'), 'utf8')
  ok(!main.replace(/\r\n/g, '').includes('\n'), '主文件里没有半截 LF（CRLF 被完整保留）')
  ok(main.replace(r.pointer, () => planTrim({ content: crlf, name: 'note.md', selector: { startLine: 11, endLine: 30 }, reason: REASON, at: AT }).segment) === crlf, 'CRLF 文件往返逐字节成立')

  const doc = await readFile(join(memoryDir, 'archive', r.archivedFile), 'utf8')
  ok(doc.includes('\r\n'), '归档件正文也保留 CRLF（不把用户内容归一）')
  ok(doc.startsWith('---\r\n') && !doc.replace(/\r\n/g, '').includes('\n'), '归档件整份都是 CRLF（frontmatter 与正文不混排）', JSON.stringify(doc.slice(0, 40)))
}

console.log('== 9. 归档件形状：frontmatter 闭合、YAML 值安全、段落归属清楚 ==')
{
  const nasty = docOf({ extraFm: [], tail: 400 }).replace('description: 体积治理夹具', 'description: 带冒号: 和 #井号 的描述')
  const { memoryDir } = await makeDir({ 'note.md': nasty })
  const r = await trimArchive({ memoryDir, name: 'note.md', selector: { heading: '旧段' }, reason: '整理时压缩: 太大了', at: AT })
  ok(r.ok === true, '（前提）description / reason 带冒号井号时仍能裁', JSON.stringify(r))
  const doc = await readFile(join(memoryDir, 'archive', r.archivedFile), 'utf8')
  const fm = doc.split('\n---\n')[0]
  ok(doc.startsWith('---\n') && doc.includes('\n---\n'), '归档件有完整的 frontmatter 块')
  ok(fm.includes(`description: '带冒号: 和 #井号 的描述'`), '带冒号的描述被 YAML 引号包住（不会变成嵌套键）', fm.split('\n').find((l) => l.startsWith('description')) ?? '')
  ok(readArchivedMeta(doc).archivedReason === '整理时压缩: 太大了', '带冒号的缘由读回来一字不差', JSON.stringify(readArchivedMeta(doc).archivedReason))
  ok(doc.includes('archived_slice: 旧段'), '归档件按小节标注了切片来源')
  ok(!doc.includes('# 标题'), '归档件不带源文件的一级标题（只带被裁的那一段）')
}

console.log('== 10. 参数闸门：memoryDir 必填（不许回落模块常量）==')
{
  const r = await trimArchive({ name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
  ok(r.ok === false && r.code === 'invalid' && r.stage === 'params', '没有 memoryDir → 拒绝（绝不猜记忆目录）', JSON.stringify(r))
  const r2 = await trimArchive()
  ok(r2.ok === false && r2.code === 'invalid', '完全不传参数也不抛异常', JSON.stringify(r2))
}

console.log('== 11. 归档区被换成联接：拒，且绝不写到记忆目录外 ==')
{
  /**
   * 为什么这条值得单列：`archive/` 是插件自己建的子目录，它若被换成指向别处的联接
   * （Windows 上 `symlink(dir,'junction')` 不需要特权，实测能建），「归档 = 搬进 archive/」
   * 就变成「把记忆正文搬到记忆目录之外」。`inspectDir` 是这条路上唯一的闸门。
   */
  const src = docOf()
  const { root, memoryDir } = await makeDir({ 'note.md': src })
  const outside = join(root, 'outside')
  await mkdir(outside, { recursive: true })
  let linked = true
  try {
    await symlink(outside, join(memoryDir, 'archive'), 'junction')
  } catch {
    linked = false
  }
  ok(linked, '（前提）本平台能建目录联接 / 符号链接（建不了就跳过本组余下断言）')
  if (linked) {
    const r = await trimArchive({ memoryDir, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT })
    ok(r.ok === false && r.code === 'symlink' && r.stage === 'archive', '归档区是联接 → symlink，stage=archive', JSON.stringify(r))
    ok((await readdir(outside)).length === 0, '记忆目录之外**一个文件都没写**')
    ok((await readFile(join(memoryDir, 'note.md'), 'utf8')) === src, '主文件一个字节没动')
  }
}

for (const d of tmp) await rm(d, { recursive: true, force: true }).catch(() => {})
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
