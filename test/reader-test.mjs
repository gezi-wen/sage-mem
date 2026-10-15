#!/usr/bin/env node
/**
 * reader.js 的断言（2026-10-15 建）—— 统一读取入口的分页、字节限额与闸门一致性。
 *
 * 单开一个文件而不是并进 search/chunks 套件：本套件要**在系统临时目录里真造文件**
 * （目录、超大文件、硬链接、目录联接），与那些纯函数套件不是一类。
 *
 * 三个必须遵守的前提：
 *   1. `MEMORY_DIR` 是**模块顶层**读的环境变量 —— 必须在动态 import **之前**设好
 *      （静态 import 会被提升，用不得）。
 *   2. 全程只碰 mkdtemp 出来的临时目录，**不碰任何真实记忆目录**。
 *   3. 夹具一律合成：本仓库是公开仓库，不许出现真实记忆内容或本机路径。
 *
 * 用法: node test/reader-test.mjs
 */
import { link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
    console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`)
  }
}
const skip = (name, why) => console.log(`  SKIP ${name}（${why}）`)

// ── 沙箱：环境变量必须在 import 之前 ─────────────────────────
const world = await mkdtemp(join(tmpdir(), 'sage-mem-reader-'))
const memDir = join(world, 'memory')
const otherDir = join(world, 'other')
const outside = join(world, 'outside')
await mkdir(memDir, { recursive: true })
await mkdir(otherDir, { recursive: true })
await mkdir(outside, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(world, '.sage-mem')

const { DEFAULT_MAX_BYTES, MAX_MAX_BYTES, MIN_MAX_BYTES, normalizeReadRequest, readSlice } =
  await import(new URL('../lib/memory/reader.js', import.meta.url).href)
const { revisionOf } = await import(new URL('../lib/memory/chunks.js', import.meta.url).href)
const { MAX_FILE_BYTES } = await import(new URL('../lib/memory/config.js', import.meta.url).href)

const write = (name, content, dir = memDir) => writeFile(join(dir, name), content, 'utf8')

// ────────────────────────── 1. 归一化 ──────────────────────────

console.log('== 1. normalizeReadRequest：名字 / 起点 / 字节三处归一 ==')
const n1 = normalizeReadRequest({ name: 'a.md' })
ok(
  n1.name === 'a.md' && n1.startLine === 1 && n1.startByte === 0 && n1.revision === '' && n1.maxBytes === DEFAULT_MAX_BYTES,
  '默认值：startLine 1 / startByte 0 / 不带 revision / maxBytes = DEFAULT_MAX_BYTES',
  JSON.stringify(n1),
)
const n2 = normalizeReadRequest({ name: 'a.md', revision: 'sha256:abc', startLine: 7, startByte: 3, maxBytes: 100 })
ok(n2.startLine === 7 && n2.startByte === 3 && n2.maxBytes === 100 && n2.revision === 'sha256:abc', '显式值原样通过')
ok(DEFAULT_MAX_BYTES === 4096 && MAX_MAX_BYTES === 65536, '两个冻结常量取值正确')
ok(MIN_MAX_BYTES >= 4, `MIN_MAX_BYTES ≥ 4（实际 ${MIN_MAX_BYTES}）：小于它就没有一次读取能保证前进`)

for (const bad of ['', '../a.md', 'sub/a.md', '..\\a.md', 'a.txt', 'MEMORY.md', 'session-log.md', 'Memory.MD', 'a.md:stream.md', 42, null, undefined, []]) {
  const r = normalizeReadRequest({ name: bad })
  ok(r.error === 'invalid_name', `非法名字被拒：${JSON.stringify(bad) ?? String(bad)}`, JSON.stringify(r))
}
ok(normalizeReadRequest('一个字符串').error === 'invalid_name', '入参不是对象 → 不抛，按无名字处理')
ok(normalizeReadRequest(null).error === 'invalid_name', '入参是 null → 不抛')

for (const bad of [0, -1, 1.5, '2', NaN, true, []]) {
  ok(normalizeReadRequest({ name: 'a.md', startLine: bad }).error === 'invalid_start', `非法 startLine 被拒：${String(bad)}`)
}
for (const bad of [-1, 1.5, -0.5, '0', NaN, true, []]) {
  ok(normalizeReadRequest({ name: 'a.md', startByte: bad }).error === 'invalid_start', `非法 startByte 被拒：${String(bad)}`)
}
ok(normalizeReadRequest({ name: 'a.md', startLine: 0, startByte: -1 }).error === 'invalid_start', 'startLine 与 startByte 任一非法即 invalid_start')

for (const bad of [0, -5, 0.5, NaN, Infinity, '4096', true, {}]) {
  ok(normalizeReadRequest({ name: 'a.md', maxBytes: bad }).error === 'invalid_bytes', `非法 maxBytes 被拒：${String(bad)}`)
}
ok(normalizeReadRequest({ name: 'a.md', maxBytes: 1 }).maxBytes === MIN_MAX_BYTES, `maxBytes 抬到下限 ${MIN_MAX_BYTES}（防止死循环）`)
ok(normalizeReadRequest({ name: 'a.md', maxBytes: 999999 }).maxBytes === MAX_MAX_BYTES, `maxBytes 收敛到上限 ${MAX_MAX_BYTES}`)
ok(normalizeReadRequest({ name: 'a.md', maxBytes: 100.9 }).maxBytes === 100, 'maxBytes 向下取整（不静默放大窗口）')
ok(normalizeReadRequest({ name: 'a.md', revision: 42 }).revision === '', 'revision 不是字符串 → 当没带（不新增错误码）')

// ────────────────────────── 2. 行号口径 ──────────────────────────

console.log('== 2. readSlice：整份读 + 行号 1-based 相对整份文件（含 frontmatter）==')
const T1_LINES = [
  '---',
  'name: reader-fixture',
  'description: 合成夹具，不含任何真实记忆',
  'metadata:',
  '  node_type: memory',
  '---',
  '',
  '# 排查记录',
  '',
  '第一行正文。',
  '第二行正文：FS_STALE_VERSION 出现在这里。',
  '第三行正文。',
]
const t1 = T1_LINES.join('\n')
await write('t1.md', t1)

const all = await readSlice({ name: 't1.md' })
ok(all.ok === true, '整份读成功', JSON.stringify(all).slice(0, 200))
ok(all.content === t1, '不带 maxBytes 时整份原样读回（默认 4 KB 够这一段）')
ok(
  all.startLine === 1 && all.endLine === T1_LINES.length && all.totalLines === T1_LINES.length,
  `行号 1-based、相对整份文件：1..${T1_LINES.length}`,
  JSON.stringify({ s: all.startLine, e: all.endLine, t: all.totalLines }),
)
ok(all.nextStartLine === null && all.nextStartByte === 0, '读到底：nextStartLine 为 null')
ok(all.truncated === false && all.lineTooLong === false, '读到底：truncated / lineTooLong 都是 false')
ok(all.bytes === Buffer.byteLength(t1, 'utf8'), `bytes 是 UTF-8 字节数（实际 ${all.bytes}）`)
ok(all.revision === revisionOf(t1), 'revision 复用 chunks.js 的 revisionOf（没另写一套哈希）')
ok(all.name === 't1.md' && all.startByte === 0, 'name / startByte 回显')

const from11 = await readSlice({ name: 't1.md', startLine: 11 })
ok(
  from11.ok === true && from11.content === T1_LINES.slice(10).join('\n') && from11.startLine === 11 && from11.endLine === 12,
  '从第 11 行起读：内容与行号都对（frontmatter 那 6 行照样计进行号）',
  JSON.stringify({ c: from11.content, s: from11.startLine, e: from11.endLine }),
)
const from7 = await readSlice({ name: 't1.md', startLine: 7 })
ok(from7.ok === true && from7.content.split('\n')[0] === '', '指向空行也照读（空行是合法行号）')

let lineOk = true
for (let i = 1; i <= T1_LINES.length; i++) {
  const r = await readSlice({ name: 't1.md', startLine: i })
  if (!r.ok || r.content.split('\n')[0] !== T1_LINES[i - 1]) lineOk = false
}
ok(lineOk, '第 i 行的首个返回行 = split(/\\r?\\n/) 的第 i 项（与 chunks.js 同一口径，不重换算）')

// ────────────────────────── 3. 字节不是字符 ──────────────────────────

console.log('== 3. maxBytes 约束 UTF-8 字节，不是字符数 ==')
const ZH = '汉字测试内容很长'.repeat(4) // 32 个汉字 = 96 字节
await write('zh.md', ['---', 'name: zh', '---', '', ZH].join('\n'))
const rz = await readSlice({ name: 'zh.md', startLine: 5, maxBytes: 9 })
ok(rz.ok === true && rz.lineTooLong === true, '中文长行进单行超长分支', JSON.stringify(rz).slice(0, 160))
ok(Buffer.byteLength(rz.content, 'utf8') <= 9, `返回内容 ≤ 9 字节（实际 ${Buffer.byteLength(rz.content, 'utf8')} 字节）`)
ok(rz.bytes === Buffer.byteLength(rz.content, 'utf8'), 'bytes 字段 = content 的 UTF-8 字节数')
ok(
  rz.content.length === 3,
  `9 字节只装得下 3 个汉字；若按字符数算会返回 9 个汉字（27 字节）—— 实际字符数 ${rz.content.length}`,
)
ok(rz.nextStartLine === 5 && rz.nextStartByte === 9, '单行超长：nextStartLine 原地不动、给行内字节偏移 9', JSON.stringify({ l: rz.nextStartLine, b: rz.nextStartByte }))
ok(rz.totalLines === 5 && rz.endLine === 5, '行号仍是整份文件口径')

// ────────────────────────── 4. 多行分页 ──────────────────────────

console.log('== 4. 多行分页：一路读完、不重不漏、行号首尾相接 ==')
const P_LINES = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：分页夹具内容`)
const paged = P_LINES.join('\n')
await write('page.md', paged)

/** 按 nextStartLine / nextStartByte 一路翻页，收齐每一页的结果对象。 */
const collectPages = async (name, maxBytes) => {
  const out = []
  let cur = { startLine: 1, startByte: 0 }
  while (out.length < 500) {
    const r = await readSlice({ name, startLine: cur.startLine, startByte: cur.startByte, maxBytes })
    if (!r.ok) return { pages: out, error: r }
    out.push(r)
    if (r.nextStartLine === null) break
    cur = { startLine: r.nextStartLine, startByte: r.nextStartByte }
  }
  return { pages: out, error: null }
}

const PAGE_MAX = 64
const pageRun = await collectPages('page.md', PAGE_MAX)
const pages = pageRun.pages
ok(pageRun.error === null, '分页读取不该失败', JSON.stringify(pageRun.error))
ok(pages.length > 1 && pages.length < 500, `确实分了多页且读完：${pages.length} 页`)
ok(pages.map((p) => p.content).join('\n') === paged, '各页按 \\n 拼回与原文逐字相同（没有漏行、没有重复行）')
ok(pages.every((p) => p.bytes <= PAGE_MAX), '每页都不超 maxBytes 字节')
ok(
  pages.every((p, i) => i === 0 || p.startLine === pages[i - 1].endLine + 1),
  '页与页行号首尾相接（无重叠、无跳行）',
  JSON.stringify(pages.slice(0, 3).map((p) => [p.startLine, p.endLine, p.nextStartLine])),
)
ok(
  pages.slice(0, -1).every((p) => p.nextStartLine === p.endLine + 1 && p.nextStartByte === 0),
  '非末页：nextStartLine = 本次末行 + 1、nextStartByte = 0',
)
ok(pages[pages.length - 1].nextStartLine === null, '末页 nextStartLine 为 null')
ok(
  pages.reduce((s, p) => s + p.bytes, 0) + (pages.length - 1) === Buffer.byteLength(paged, 'utf8'),
  '页字节数之和 + 页间换行 = 全文字节数（换行也记进了账）',
)

// ────────────────────────── 5. 单行超长分页 ──────────────────────────

console.log('== 5. 单行超长：startByte 分页、不前进即失败、步数有界 ==')

// 5a：ASCII 单行 5000 字节 —— 窗口能正好填满，步数应等于理想页数（可精确断言）
const LONG_ASCII = 'abcdefghij'.repeat(500)
await write('long-ascii.md', LONG_ASCII)
{
  let offset = 0
  let acc = ''
  let steps = 0
  let firstNextByte = null
  let last = null
  while (steps < 5000) {
    const r = await readSlice({ name: 'long-ascii.md', startLine: 1, startByte: offset, maxBytes: 64 })
    if (!r.ok) {
      ok(false, 'ASCII 单行分页不该失败', JSON.stringify(r))
      break
    }
    if (steps === 0) firstNextByte = r.nextStartByte
    steps++
    if (Buffer.byteLength(r.content, 'utf8') === 0) {
      ok(false, '出现 0 字节的一页（不前进 = 死循环）')
      break
    }
    acc += r.content
    last = r
    if (r.nextStartLine !== 1) break
    if (r.nextStartByte <= offset) {
      ok(false, `nextStartByte 没有前进：${offset} → ${r.nextStartByte}`)
      break
    }
    offset = r.nextStartByte
  }
  const ideal = Math.ceil(Buffer.byteLength(LONG_ASCII, 'utf8') / 64)
  ok(acc === LONG_ASCII, `分片拼回与那一行逐字相同（${Buffer.byteLength(acc, 'utf8')} 字节）`)
  ok(steps === ideal, `步数 = 理想页数 ${ideal}（ASCII 窗口正好填满，实际 ${steps}）`)
  ok(firstNextByte === 64, `首屏 nextStartByte = 64（原地续读同一行，实际 ${firstNextByte}）`)
  ok(last.lineTooLong === false && last.nextStartLine === null, '最后一页不再标 lineTooLong，且读到底')
}

// 5b：中文单行 3600 字节 —— 窗口必须停在字符边界上，步数有界
const LONG_ZH = '超长单行夹具'.repeat(200) // 1200 个汉字 = 3600 字节
await write('long-zh.md', ['---', 'name: long-zh', '---', '', LONG_ZH, '尾巴'].join('\n'))
{
  const MAXB = 100
  const totalZh = Buffer.byteLength(LONG_ZH, 'utf8')
  let offset = 0
  let acc = ''
  let steps = 0
  let first = null
  let last = null
  let noReplacement = true
  let progressed = true
  while (steps < 5000 && acc.length < LONG_ZH.length) {
    const r = await readSlice({ name: 'long-zh.md', startLine: 5, startByte: offset, maxBytes: MAXB })
    if (!r.ok) {
      ok(false, '中文单行分页不该失败', JSON.stringify(r))
      break
    }
    if (steps === 0) first = r
    steps++
    if (Buffer.byteLength(r.content, 'utf8') === 0) {
      progressed = false
      break
    }
    if (r.content.includes('\uFFFD')) noReplacement = false
    if (Buffer.byteLength(r.content, 'utf8') > MAXB) {
      ok(false, `单页超出 maxBytes：${Buffer.byteLength(r.content, 'utf8')} > ${MAXB}`)
    }
    acc += r.content
    last = r
    if (r.nextStartLine === 5) {
      if (r.nextStartByte <= offset) {
        progressed = false
        break
      }
      offset = r.nextStartByte
    }
  }
  const bound = Math.ceil(totalZh / (MAXB - 3)) + 2
  ok(progressed && steps < 5000 && acc.length >= LONG_ZH.length, `用 startByte 一路读完，共 ${steps} 步（每一步都前进，没有死循环）`)
  ok(acc.slice(0, LONG_ZH.length) === LONG_ZH, `${totalZh} 字节的中文行拼回后逐字相同`)
  ok(noReplacement, '每个窗口都停在字符边界上（没有半个汉字被截成 U+FFFD）')
  ok(steps <= bound, `步数 ≤ ⌈总字节/(上限-3)⌉+2 = ${bound}（实际 ${steps}；-3 是回退到一个码点的最大代价）`)
  ok(first.lineTooLong === true && first.nextStartLine === 5, '首屏：lineTooLong、nextStartLine 原地')
  ok(
    first.nextStartByte > 0 && first.nextStartByte <= MAXB && first.nextStartByte === Buffer.byteLength(first.content, 'utf8'),
    `首屏 nextStartByte 与已读字节一致（${first.nextStartByte}）`,
  )
  ok(
    last.lineTooLong === false && last.endLine === 6 && last.nextStartLine === null && acc === `${LONG_ZH}\n尾巴`,
    '最后一屏回到整行累积：装完这一行的剩余后顺带装下后面的短行（窗口是填满为止，不是一行一屏）',
    JSON.stringify({ e: last.endLine, n: last.nextStartLine, over: acc.length - LONG_ZH.length }),
  )
}
ok((await readSlice({ name: 'long-zh.md', startLine: 6 })).content === '尾巴', '超长行的下一行照常能读')

// ────────────────────────── 6. revision ──────────────────────────

console.log('== 6. revision 校验 ==')
const revBody = ['---', 'name: rev', '---', '', '# 防抖记录', '', '正文一。'].join('\n')
await write('rev.md', revBody)
const rv0 = await readSlice({ name: 'rev.md' })
ok(rv0.ok === true && rv0.revision === revisionOf(revBody), '不带 revision 照读，并回报当前 revision')
const rv1 = await readSlice({ name: 'rev.md', revision: rv0.revision })
ok(rv1.ok === true && rv1.content === revBody, '带对的 revision 正常返回内容')

const stale = await readSlice({ name: 'rev.md', revision: 'sha256:000000000000' })
ok(stale.ok === false && stale.code === 'revision_changed', '对不上的 revision → revision_changed', JSON.stringify(stale))
ok(stale.revision === rv0.revision, 'revision_changed 带**当前** revision（调用方据此重新定位）')
ok(
  !('content' in stale) && !('startLine' in stale) && !('endLine' in stale) && !('bytes' in stale) && !('nextStartLine' in stale),
  'revision_changed **不返回内容与行号**（否则调用方会拿着过期行号读错东西）',
  JSON.stringify(stale),
)
ok(
  Object.keys(stale).every((k) => ['ok', 'code', 'error', 'revision'].includes(k)),
  `revision_changed 只有 ok/code/error/revision 四个键（实际 ${JSON.stringify(Object.keys(stale))}）`,
)

await write('rev.md', `${revBody}\n补一行。`)
const rv2 = await readSlice({ name: 'rev.md' })
ok(rv2.revision !== rv0.revision, '内容改一处 revision 就变')
ok((await readSlice({ name: 'rev.md', revision: rv0.revision })).code === 'revision_changed', '拿旧 revision 读改过的文件仍被拒')

// ────────────────────────── 7. 闸门：denied ──────────────────────────

console.log('== 7. denied：闸门复用既有函数（目录 / 超大 / 联接 / 保留名的另一个名字）==')
await mkdir(join(memDir, 'dirname.md'), { recursive: true })
const rd = await readSlice({ name: 'dirname.md' })
ok(rd.ok === false && rd.code === 'denied', '名字落在目录上 → denied（inspectMemoryEntry 的 not-file）', JSON.stringify(rd))

await write('big.md', `---\nname: big\n---\n\n${'x'.repeat(MAX_FILE_BYTES + 1024)}`)
const rb = await readSlice({ name: 'big.md' })
ok(
  rb.ok === false && rb.code === 'denied' && /体积|上限/.test(rb.error),
  '超过 MAX_FILE_BYTES → denied（体积闸门复用 inspectMemoryEntry，与写入路径同一把尺子）',
  JSON.stringify(rb),
)

await mkdir(join(outside, 'inner.md'), { recursive: true })
let junctionOk = true
try {
  // 本机实测：文件 / 目录符号链接默认要特权（EPERM），但 junction 能建 —— 所以这不是理论风险
  await symlink(join(outside, 'inner.md'), join(memDir, 'linkdir.md'), 'junction')
} catch (err) {
  junctionOk = false
  skip('目录联接', `本机建不出 junction：${err?.code}`)
}
if (junctionOk) {
  ok((await lstat(join(memDir, 'linkdir.md'))).isSymbolicLink() === true, '测试前提成立：linkdir.md 是一个联接')
  const rj = await readSlice({ name: 'linkdir.md' })
  ok(rj.ok === false && rj.code === 'denied', '指向别处的目录联接 → denied（不会读成记忆）', JSON.stringify(rj))
}

await write('target.md', '# 外部目标\n', outside)
let symOk = true
try {
  await symlink(join(outside, 'target.md'), join(memDir, 'sym.md'))
} catch (err) {
  symOk = false
  skip('文件符号链接', `本机无创建符号链接的特权：${err?.code}`)
}
if (symOk) {
  const rs = await readSlice({ name: 'sym.md' })
  ok(rs.ok === false && rs.code === 'denied', '文件符号链接 → denied', JSON.stringify(rs))
}

// 保留名的另一个名字：用硬链接模拟 NTFS 的 8.3 短名（同一 inode、两个毫无关系的名字文本）
let hardOk = true
try {
  await write('MEMORY.md', '# 索引（合成）\n\n- 一条合成条目\n')
  await link(join(memDir, 'MEMORY.md'), join(memDir, 'MEMORY~1.MD'))
} catch (err) {
  hardOk = false
  skip('保留名的另一个名字', `本机建不出硬链接：${err?.code}`)
}
if (hardOk) {
  ok((await lstat(join(memDir, 'MEMORY~1.MD'))).nlink === 2, '测试前提成立：MEMORY~1.MD 与索引同 inode')
  const alias = await readSlice({ name: 'MEMORY~1.MD' })
  ok(
    alias.ok === false && alias.code === 'denied',
    '经第二个名字读索引 → denied（shadowsReserved：判据落在文件身份上，不是名字文本）',
    JSON.stringify(alias),
  )
}

// ────────────────────────── 8. not_found / invalid / 不抛 ──────────────────────────

console.log('== 8. not_found / invalid：失败一律返回对象，绝不抛 ==')
const nf = await readSlice({ name: 'nope.md' })
ok(nf.ok === false && nf.code === 'not_found', '不存在的记忆 → not_found', JSON.stringify(nf))

const beyond = await readSlice({ name: 't1.md', startLine: T1_LINES.length + 1 })
ok(
  beyond.ok === false && beyond.code === 'invalid',
  `起始行超出行数（${T1_LINES.length + 1} > ${T1_LINES.length}）→ invalid：拿着过期游标时出声，比回一份空内容更容易被发现`,
  JSON.stringify(beyond),
)

const cases = [
  [{}, 'invalid', '空请求'],
  [null, 'invalid', 'req 为 null'],
  [{ name: '../escape.md' }, 'invalid', '名字带目录成分'],
  [{ name: 'notes.txt' }, 'invalid', '非 .md'],
  [{ name: 'MEMORY.md' }, 'invalid', '索引本身不是记忆条目（safeName 挡下）'],
  [{ name: 't1.md', startLine: 0 }, 'invalid', 'startLine 0'],
  [{ name: 't1.md', startLine: 2.5 }, 'invalid', 'startLine 小数'],
  [{ name: 't1.md', startByte: -1 }, 'invalid', 'startByte 负数'],
  [{ name: 'zh.md', startLine: 5, startByte: 1 }, 'invalid', 'startByte 落在汉字中间（不切碎多字节字符）'],
  [{ name: 'zh.md', startLine: 5, startByte: 999 }, 'invalid', 'startByte 超出该行'],
  [{ name: 't1.md', maxBytes: 0 }, 'invalid', 'maxBytes 0（0 字节窗口必然不前进）'],
]
for (const [req, code, label] of cases) {
  let r = null
  let thrown = null
  try {
    r = await readSlice(req)
  } catch (err) {
    thrown = String(err?.message ?? err)
  }
  ok(
    thrown === null && r && r.ok === false && r.code === code,
    `${label} → ${code}（不抛）`,
    thrown ?? JSON.stringify(r),
  )
}

const weird = [undefined, 0, '', 'x', [], {}, { name: {} }, { name: 'a.md', maxBytes: {} }, { name: 'a.md', startLine: {} }, { name: 'a.md', startByte: {} }, { name: 'a.md', dir: 42 }, { name: 'a.md', revision: 42 }]
let weirdThrew = null
for (const w of weird) {
  try {
    const r = await readSlice(w)
    if (!r || typeof r.ok !== 'boolean') weirdThrew = `${JSON.stringify(w)} → 返回形状不对`
  } catch (err) {
    weirdThrew = `${JSON.stringify(w)} → 抛了：${err?.message}`
  }
}
ok(weirdThrew === null, '一串畸形请求全部返回对象、无异常（工具层不会因为一次读失败炸掉）', String(weirdThrew))
ok((await readSlice()).code === 'invalid', '空调用也不抛')

// ────────────────────────── 9. 边界 ──────────────────────────

console.log('== 9. 边界：空文件 / 正好等于上限 / CRLF / dir 注入 ==')
await write('empty.md', '')
const re = await readSlice({ name: 'empty.md' })
ok(
  re.ok === true && re.content === '' && re.bytes === 0 && re.totalLines === 1 && re.startLine === 1 && re.endLine === 1,
  '空文件：确定行为（1 行、0 字节）',
  JSON.stringify(re),
)
ok(re.nextStartLine === null && re.truncated === false && re.lineTooLong === false, '空文件读到底')

await write('exact.md', 'a'.repeat(64))
const rx1 = await readSlice({ name: 'exact.md', maxBytes: 64 })
ok(
  rx1.ok === true && rx1.bytes === 64 && rx1.truncated === false && rx1.nextStartLine === null && rx1.lineTooLong === false,
  '正好等于 maxBytes：整行装下，不标超长 / truncated',
  JSON.stringify(rx1),
)
const rx2 = await readSlice({ name: 'exact.md', maxBytes: 63 })
ok(
  rx2.ok === true && rx2.bytes === 63 && rx2.lineTooLong === true && rx2.nextStartLine === 1 && rx2.nextStartByte === 63,
  '差 1 字节：走单行超长窗口，nextStartByte = 63',
  JSON.stringify(rx2),
)
ok(rx2.startByte === 0, 'startByte 字段是请求值的回显')
const rx3 = await readSlice({ name: 'exact.md', maxBytes: 63, startByte: 63 })
ok(
  rx3.ok === true && rx3.content === 'a' && rx3.lineTooLong === false && rx3.endLine === 1 && rx3.nextStartLine === null && rx3.bytes === 1,
  '带 startByte 续读最后一字节：读到底、不再标超长',
  JSON.stringify(rx3),
)

await write('crlf.md', T1_LINES.join('\r\n'))
const rcr = await readSlice({ name: 'crlf.md' })
ok(rcr.ok === true && rcr.content === t1, 'CRLF 读回来归一成 \\n（与 chunks.js 的分段口径一致）')
ok(rcr.totalLines === T1_LINES.length, 'CRLF 与 LF 的行数相同（行号口径一致）')
const lfRun = await collectPages('t1.md', 64)
const crlfRun = await collectPages('crlf.md', 64)
ok(lfRun.error === null && lfRun.pages.length > 1, `LF 夹具确实分了多页（${lfRun.pages.length} 页）`)
ok(lfRun.pages.map((p) => p.content).join('\n') === t1, 'LF 分页拼回原文')
/**
 * 只比「分页语义」那几栏：name 是两个不同的文件，revision 跟磁盘字节走 ——
 * 这两栏本来就该different，混进来会让断言变成「两个文件是同一个文件」。
 */
const pageShape = (pages) =>
  pages.map((p) => ({
    startLine: p.startLine,
    endLine: p.endLine,
    startByte: p.startByte,
    nextStartLine: p.nextStartLine,
    nextStartByte: p.nextStartByte,
    totalLines: p.totalLines,
    bytes: p.bytes,
    truncated: p.truncated,
    lineTooLong: p.lineTooLong,
    content: p.content,
  }))
ok(
  JSON.stringify(pageShape(crlfRun.pages)) === JSON.stringify(pageShape(lfRun.pages)),
  'CRLF 与 LF 文件的分页结果逐页相同（每一页的内容、行号、字节数都一样）',
)
ok(
  crlfRun.pages[0].revision !== lfRun.pages[0].revision,
  'CRLF 与 LF 磁盘字节不同 → revision 不同（revision 是内容哈希，不跟着归一化后的文本走）',
)

await write('x.md', '---\nname: x\n---\n\n# 另外的目录\n\n正文\n', otherDir)
const ro = await readSlice({ name: 'x.md', dir: otherDir })
ok(ro.ok === true && ro.content.includes('另外的目录'), 'dir 注入能读到别的目录（只给测试用）')
ok((await readSlice({ name: 'x.md' })).code === 'not_found', '不传 dir 时用 MEMORY_DIR：注入目录里的文件读不到')
ok((await readSlice({ name: '../x.md', dir: otherDir })).code === 'invalid', 'dir 注入也不能让名字带目录成分（safeName 照旧）')
ok((await readSlice({ name: 'x.md', dir: otherDir })).name === 'x.md', 'name 返回校验后的原始文件名')

// ────────────────────────── 收尾 ──────────────────────────

await rm(world, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
