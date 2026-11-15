/**
 * sage-mem 记忆层 —— **裁段归档的规划器**（纯函数，一个字节都不碰磁盘）。
 *
 * 为什么单独一个模块：「把哪一段搬走」与「怎么搬」是两件事，而这两件事的危险程度差一个量级。
 * 切分逻辑长在 IO 里，就只能靠「跑一遍真实写入」来验它 —— 而这里改的是**用户记忆的正文**。
 * 拆出来之后：选择器、体积下限、指针格式、归档名全部能对着字符串写断言（`test/trim-plan-test.mjs`），
 * 不需要临时目录、不需要夹具文件，一次跑完几百条。
 *
 * 六条不变量（每条都有专属失败 code，调用方按 code 分支，不靠文案判断）：
 *   1. 正文必须以 frontmatter（`---` 开头、`---` 结尾）起始；`remaining` 里**仍带完整 frontmatter**
 *      —— 否则算出来的就不是「没有 frontmatter」而是「把一条记忆改坏了」。code: `no_frontmatter`
 *   2. 行号选择器**不许**触到 frontmatter 区。code: `selector_invalid`（契约指定）
 *   3. 被裁段 ≥ `TRIM_MIN_SEGMENT_BYTES`；剩余正文 ≥ `TRIM_MIN_REMAIN_BYTES`
 *      —— 太小没有收益，剪到只剩骨架就该走整文件归档那条路。code: `segment_too_small` / `remain_too_small`（契约指定）
 *   4. 标题找不到 / 重名不猜。code: `heading_not_found` / `heading_ambiguous`（契约指定）
 *   5. `archiveName` = `<原名去 .md>-<slug>-<YYYYMMDD>.md`，且必须过 `shared/md-name.js` 的
 *      `isPlainMdName`（归档名也是要落盘的名字，非法名会把归档件写到意想不到的地方）。code: `invalid_name`
 *   6. `remaining` = 前缀 + `pointer` + 后缀，其中「前缀 + segment + 后缀 === 原文」**逐字节成立**。
 *      这条就是往返断言：把 pointer 换回 segment，必须一字不差地还原原文件。
 *      code: `invalid`（内部不变量被破坏时的兜底，正常情况下永不出现）
 *
 * ⚠️ 所有 code 都登在 `lib/shared/codes.js`（2.10.0 的「裁段」一节）。新增码必须先去那里登记 ——
 * `test/code-registry-test.mjs` 就是靠**字面量**扫这件事的，所以下面每个失败回执里的 `code`
 * 都写成对象字面量，不许拐一层小工具函数（那正是让新码绕过登记守卫的写法）。
 *
 * 最坏情况与防线：
 *   - 最坏情况**不是**丢数据（本模块不写盘），而是「规划出一个看起来合法、实际把正文剪坏的结果」，
 *     再由调用方原样写进真实记忆。防线：`remaining` 用**切片拼接**构造而不是按行重排
 *     （`prefix + pointer + suffix`），并在返回前把三者拼回去与原文做一次全等断言；
 *     任何偏移算错都在这里被拦下，绝不给调用方一个坏结果。
 *   - 空行归属：段的首尾空行**不归段**（留在前后缀里），于是指针天然落在前后各一空行之间，
 *     同时又不需要往正文里插任何字节 —— 「格式好看」与「逐字节还原」在这里不冲突。
 *   - 换行风格：段落偏移按**实际换行符长度**累加（`\r\n` 记 2），不按 `lines.join()` 重排，
 *     所以 CRLF 文件裁完仍是 CRLF，混排文件也不会被悄悄归一。
 *
 * 纯函数的边界：`at` 不传时回落 `Date.now()`（只有这一处非确定性），
 * 调用方（`trim-archive.js` / 工具层）**应当显式传**，测试一律传固定值。
 */

import { isPlainMdName } from '../shared/md-name.js'
import { stampDate } from '../shared/stamp.js'
import { parseFrontmatter } from './frontmatter.js'

/** 被裁段的最小体积。太小的段搬进 archive/ 只是把垃圾换个地方放。 */
export const TRIM_MIN_SEGMENT_BYTES = 1024

/** 剩余正文的最小体积。剪到只剩骨架 = 整文件归档，那有另一条路（`archive.js`）。 */
export const TRIM_MIN_REMAIN_BYTES = 1024

/** 缘由最少几个字（去空白后数）。「整理」两个字说不清为什么要动用户的正文。 */
const MIN_REASON_CHARS = 4

/** 归档名里 slug 的长度上限（契约 §2 第 5 条）。 */
const MAX_SLUG_CHARS = 40

/** `title` 只是给人看的标签，别把整段正文塞进去。 */
const MAX_TITLE_CHARS = 80

/** slug 里不许出现的字符：Windows 文件名保留集 + 空白 + 控制字符（`isPlainMdName` 的子集）。 */
const SLUG_BAD_RE = /[\s\\/:*?"<>|\u0000-\u001f]/g

/**
 * ATX 标题：`## 标题`。`#` 与标题之间**必须**有空白 —— 与 CommonMark 一致，
 * 也让 `#标签` 这种正文里的井号写法不会被误当成标题。
 */
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/

/**
 * ⚠️ 失败回执一律写成**对象字面量**（`{ ok:false, code:'…', error }`），不许过一层
 * `fail(code, error)` 之类的小工具函数：`test/code-registry-test.mjs` 是靠**字面量**
 * 找 `code:` 的（正则扫 `code: '…'`），拐一道函数就等于让新码绕过「必须先写进
 * `lib/shared/codes.js`」这条登记守卫 —— 那是一个不会被任何测试变红的静默漂移。
 */

/** 按 code point 数（`.length` 数的是 UTF-16 单元，遇到表情符号会把一个字符算成两个）。 */
const charCount = (s) => Array.from(s).length

/** 按 code point 截断（不会把代理对劈成半个字符）。 */
const cutChars = (s, n) => Array.from(s).slice(0, n).join('')

/**
 * 每行的**起始偏移**（按 `content.split(/\r?\n/)` 的行号口径，0-based 数组）。
 *
 * 不按 `join` 重排的原因：`split` 之后每行之间的换行符长度可能不同（混排文件），
 * 重排会把它们统一成一种风格 —— 而这里要的是「除了被换掉的那一段，其余字节一个都不动」。
 */
function lineOffsets(src, lines) {
  const out = new Array(lines.length)
  let p = 0
  for (let i = 0; i < lines.length; i += 1) {
    out[i] = p
    p += lines[i].length
    if (i < lines.length - 1) p += src.startsWith('\r\n', p) ? 2 : 1
  }
  return out
}

/**
 * frontmatter 闭合行是第几行（1-based）；没有 frontmatter 返回 0。
 *
 * 判据是**整行**等于 `---`，不跨行猜：`--- ===`、`---x` 这类半吊子写法不认 ——
 * 这里要动的是用户正文，宁可报 `no_frontmatter` 让它走文件工具，也不要猜错边界。
 * 行首 BOM 单独容忍（Windows 编辑器存出来的文件很常见），BOM 本身留在原文里不动。
 */
function frontmatterEndLine(lines) {
  const first = String(lines[0] ?? '').replace(/^\ufeff/, '').trimEnd()
  if (first !== '---') return 0
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === '---') return i + 1
  }
  return 0
}

/** 一行的标题文字（去掉行首的 `#` 与空白）；不是标题样式的行原样返回。 */
const headingTextOf = (line) => String(line ?? '').replace(/^#+[ \t]*/, '').trim()

/**
 * 把段首尾的**空行**剔出去，只留真正有内容的行。
 *
 * 为什么剔：首尾空行属于「周围」而不属于「这一段」。留在前后缀里之后，
 * `remaining` 里的指针天然前后各有一空行，而正文一个字节都不用插 ——
 * 插字节会破坏「前缀 + segment + 后缀 === 原文」这条往返断言。
 *
 * @returns {{start:number,end:number}|null} 全是空行时返回 null
 */
function trimBlankEdges(lines, start, end) {
  let s = -1
  let e = -1
  for (let i = start - 1; i <= end - 1; i += 1) {
    if (lines[i].trim() !== '') {
      if (s < 0) s = i
      e = i
    }
  }
  if (s < 0) return null
  return { start: s + 1, end: e + 1 }
}

/** 标题/正文 → slug：去掉空白与文件名保留字符，最长 40 个字符，空则 `section`。 */
function slugOf(text) {
  const cleaned = cutChars(String(text ?? '').replace(SLUG_BAD_RE, ''), MAX_SLUG_CHARS)
  return cleaned || 'section'
}

/**
 * 指针那一行（**唯一定义处**）：主文件里替掉旧段落的就是这一句。
 *
 * 单独导出而不是在 planTrim 里内联：工具层/报告要引用同一句话时，
 * 抄第二份就会出现「主文件写的是一套、回执说的是另一套」。
 *
 * @param {string} archiveName — 归档件文件名（不含 `archive/` 前缀）
 * @param {string} date — `YYYY-MM-DD`
 * @param {string} reason — 已压成一行的缘由
 */
export function trimPointerLine(archiveName, date, reason) {
  return `> 这段旧内容已归档到 archive/${archiveName}（${date}，缘由：${reason}）`
}

/**
 * 标题选择器：找到唯一那个标题小节，返回 1-based 闭区间的**行号范围**（未剔空行）。
 *
 * 收 1-6 级（契约只提二级/三级）：把四级子小节排除在外只会逼人改用行号，
 * 而 h1 通常覆盖全文，会被 `remain_too_small` 自然挡下 —— 用体积判据兜底比用级别判据更贴题。
 */
function pickByHeading(lines, bodyFrom, wanted) {
  const target = wanted.toLowerCase()
  const hits = []
  for (let i = bodyFrom; i < lines.length; i += 1) {
    const m = lines[i].match(HEADING_RE)
    if (m && m[2].trim().toLowerCase() === target) hits.push({ line: i + 1, level: m[1].length })
  }
  if (hits.length === 0) {
    return { ok: false, code: 'heading_not_found', error: `找不到标题「${wanted}」（只认正文里的 # / ## / ### 小节标题，且不含 #）` }
  }
  if (hits.length > 1) {
    return {
      ok: false,
      code: 'heading_ambiguous',
      error: `标题「${wanted}」出现了 ${hits.length} 次（第 ${hits.map((h) => h.line).join('、')} 行）—— 不猜是哪一段，请改用 startLine/endLine 指定`,
    }
  }
  const hit = hits[0]
  // 小节到「下一个同级或更高级标题」的上一行为止；没有下一个则到文件末尾。
  let end = lines.length
  for (let i = hit.line; i < lines.length; i += 1) {
    const m = lines[i].match(HEADING_RE)
    if (m && m[1].length <= hit.level) {
      end = i
      break
    }
  }
  return { ok: true, start: hit.line, end }
}

/**
 * 把选择器翻译成行号区间。二选一（heading / startLine+endLine），都给或都不给都算 `selector_invalid`。
 *
 * @param {string[]} lines — `content.split(/\r?\n/)`
 * @param {number} fmEnd — frontmatter 闭合行（1-based）
 * @returns {{ok:true,start:number,end:number,title:string,sliceLabel:string}|{ok:false,code:string,error:string}}
 */
function pickRange(lines, selector, fmEnd) {
  const sel = selector && typeof selector === 'object' ? selector : null
  if (!sel) {
    return { ok: false, code: 'selector_invalid', error: '缺少选择器：给 heading（小节标题，不含 #）或 startLine + endLine（1-based 闭区间）' }
  }
  const hasHeading = typeof sel.heading === 'string' && sel.heading.trim() !== ''
  const hasLines = sel.startLine !== undefined || sel.endLine !== undefined
  if (hasHeading === hasLines) {
    return { ok: false, code: 'selector_invalid', error: '选择器必须二选一：要么 heading，要么 startLine + endLine（不能既给又给、也不能都不给）' }
  }

  if (hasHeading) {
    const wanted = String(sel.heading).replace(/^#+[ \t]*/, '').trim()
    if (wanted === '') return { ok: false, code: 'selector_invalid', error: 'heading 是空的（给标题正文，不要带 #）' }
    // 正文从闭合 --- 的下一行开始；frontmatter 里就算有像标题的行也不许当小节。
    const hit = pickByHeading(lines, fmEnd, wanted)
    if (!hit.ok) return hit
    const trimmed = trimBlankEdges(lines, hit.start, hit.end)
    if (!trimmed) return { ok: false, code: 'selector_invalid', error: `标题「${wanted}」的小节里没有正文（全是空行）` }
    return { ok: true, start: trimmed.start, end: trimmed.end, title: cutChars(wanted, MAX_TITLE_CHARS), sliceLabel: cutChars(wanted, MAX_TITLE_CHARS) }
  }

  const s = sel.startLine
  const e = sel.endLine
  if (!Number.isInteger(s) || !Number.isInteger(e)) {
    return { ok: false, code: 'selector_invalid', error: `startLine / endLine 必须是整数行号（1-based，收到 ${String(s)} / ${String(e)}）` }
  }
  if (s < 1 || e < s) return { ok: false, code: 'selector_invalid', error: `行区间不成立：startLine=${s}、endLine=${e}（要求 1 ≤ startLine ≤ endLine）` }
  if (e > lines.length) return { ok: false, code: 'selector_invalid', error: `endLine=${e} 超出行数 ${lines.length}（行号是 1-based，可能拿着过期游标）` }
  if (s <= fmEnd) {
    return { ok: false, code: 'selector_invalid', error: `startLine=${s} 落在 frontmatter 区（第 1-${fmEnd} 行）—— frontmatter 要用文件工具改，不参与裁剪` }
  }
  const trimmed = trimBlankEdges(lines, s, e)
  if (!trimmed) return { ok: false, code: 'selector_invalid', error: `第 ${s}-${e} 行全是空行，没有可归档的正文` }
  const firstText = cutChars(headingTextOf(lines[trimmed.start - 1]), MAX_TITLE_CHARS)
  return { ok: true, start: trimmed.start, end: trimmed.end, title: firstText, sliceLabel: `第 ${trimmed.start}-${trimmed.end} 行` }
}

/**
 * 规划一次裁段归档。**纯函数**：同样的入参（含 `at`）永远得到同样的结果。
 *
 * @param {object} p
 * @param {string} p.content — 整份文件正文（含 frontmatter）
 * @param {string} p.name — 记忆文件名（`.md`，与磁盘上的名字一致）
 * @param {{heading?:string}|{startLine?:number,endLine?:number}} p.selector — 二选一的选择器
 * @param {string} p.reason — 裁剪缘由（必填，≥4 字；换行会被压成空格）
 * @param {number} [p.at] — 毫秒时间戳（决定归档名的日期与指针里的日期；不传用 `Date.now()`）
 * @returns {{ok:true, archiveName:string, segment:string, remaining:string, pointer:string,
 *            title:string, range:{start:number,end:number}, sliceLabel:string, reason:string,
 *            sourceMeta:{name:string,description:string,type:string,tags:string[]}}
 *   |{ok:false, code:string, error:string}}
 */
export function planTrim({ content, name, selector, reason, at } = {}) {
  const src = typeof content === 'string' ? content : ''
  const rawName = String(name ?? '')
  // ① 名字：归档名由它派生，非法名会派生出一个非法归档名。
  if (!isPlainMdName(rawName)) {
    return { ok: false, code: 'invalid_name', error: `名字不是合法的 .md 文件名：${String(name)}（单段、无路径分隔符、无冒号）` }
  }
  // ② 缘由：必填、够长、且必须能压成一行（指针是一行，多行缘由会把它劈成两行）。
  // 再截到 200 字：指针是给未来的人**一眼认路**的，不是档案全文。不加这条，一条 10 KB
  // 的 reason 会把主文件里那行指针变成一整面墙 —— 而指针本来是为了让人愿意读它。
  const WHY_MAX_CHARS = 200
  const whyRaw = String(reason ?? '').replace(/[\r\n]+/g, ' ').trim()
  const why = charCount(whyRaw) > WHY_MAX_CHARS
    ? [...whyRaw].slice(0, WHY_MAX_CHARS).join('').trimEnd() + '…'
    : whyRaw
  if (charCount(why) < MIN_REASON_CHARS) {
    return { ok: false, code: 'reason_too_short', error: `裁剪缘由必填且至少 ${MIN_REASON_CHARS} 个字（收到 ${JSON.stringify(String(reason ?? ''))}）—— 档案馆要能回答「它为什么被收起来」` }
  }

  const lines = src.split(/\r?\n/)
  // ③ frontmatter：没有它就没有「剩余正文仍带完整 frontmatter」这个保证。
  const fmEnd = frontmatterEndLine(lines)
  if (fmEnd === 0) {
    return { ok: false, code: 'no_frontmatter', error: '这份文件没有 frontmatter（正文不是以单独的 --- 行开头、并以 --- 行闭合）—— 裁剪保证不了剩余正文仍带完整 frontmatter，拒绝执行（用文件工具改它）' }
  }

  // ④ 选择器 → 行号区间（契约里六条不变量的 2 与 4 都在这一步判）。
  const picked = pickRange(lines, selector, fmEnd)
  if (!picked.ok) return picked
  const { start, end, title, sliceLabel } = picked

  // ⑤ 归档名：<原名去 .md>-<slug>-<YYYYMMDD>.md
  const when = Number.isFinite(at) ? at : Date.now()
  const date = stampDate(when)
  const archiveName = `${rawName.replace(/\.md$/i, '')}-${slugOf(title)}-${date.replace(/-/g, '')}.md`
  if (!isPlainMdName(archiveName)) {
    return { ok: false, code: 'invalid_name', error: `算出来的归档名不合法：${archiveName}` }
  }

  // ⑥ 切片。这三段拼回去必须与原文逐字节相同（不变量 6 的实现侧断言）。
  const offsets = lineOffsets(src, lines)
  const startOff = offsets[start - 1]
  const endOff = offsets[end - 1] + lines[end - 1].length
  const prefix = src.slice(0, startOff)
  const segment = src.slice(startOff, endOff)
  const suffix = src.slice(endOff)
  if (prefix + segment + suffix !== src) {
    return { ok: false, code: 'invalid', error: '内部不变量被破坏（行偏移切不出原文），拒绝给出结果' }
  }
  const pointer = trimPointerLine(archiveName, date, why)
  const remaining = prefix + pointer + suffix

  // ⑦ 体积：段太小没收益、剩余太小就该整份归档。
  const segmentBytes = Buffer.byteLength(segment, 'utf8')
  if (segmentBytes < TRIM_MIN_SEGMENT_BYTES) {
    return { ok: false, code: 'segment_too_small', error: `被裁段只有 ${segmentBytes} 字节（下限 ${TRIM_MIN_SEGMENT_BYTES}）—— 这么小的段不值得单开一个归档件，直接改正文更好` }
  }
  const remainingBytes = Buffer.byteLength(remaining, 'utf8')
  if (remainingBytes < TRIM_MIN_REMAIN_BYTES) {
    return { ok: false, code: 'remain_too_small', error: `裁完只剩 ${remainingBytes} 字节（下限 ${TRIM_MIN_REMAIN_BYTES}）—— 整份搬走请用「归档这条记忆」（archive_memory）` }
  }

  const meta = parseFrontmatter(src)
  return {
    ok: true,
    archiveName,
    segment,
    remaining,
    pointer,
    title,
    range: { start, end },
    sliceLabel,
    // 归一后的缘由原样带出：落盘那一侧要写进归档件的 archived_reason，
    // 两边各归一一次就会出现「主文件指针说 A、归档件说 B」。
    reason: why,
    sourceMeta: { name: meta.name, description: meta.description, type: meta.type, tags: meta.tags },
  }
}
