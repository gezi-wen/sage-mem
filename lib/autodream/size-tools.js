/**
 * sage-mem autodream — 体积治理的**模型面薄适配层**（2.10.1）。
 *
 * 为什么单开一个文件，而不是写进 `tools.js`：
 *   · `tools.js` 已经 1071/1100 行，塞不下一个工具 schema + 一个 case + 压缩留痕；
 *   · 更重要的是**分层**：这里只做三件事 —— 把模型给的中文参数整理成选择器、
 *     转调 `memory/trim-archive.js`、把结果翻成一句人话回执。
 *     **一行写盘逻辑都不许有**（写序的安全性是 `trim-archive.js` 的契约，见
 *     `docs/size-governance-contract.md` §3：先写归档件、再拿 revision 守卫改主文件、
 *     失败把归档件退役不删）。在这里「顺手补一个 mkdir / rename」就等于把那套顺序抄了第二份。
 *
 * 返回值**永远是字符串、永远不抛**：工具面的惯例 —— 模型拿到错误描述才能自己改下一步，
 * 抛异常只会让整趟自动做梦崩在半夜。
 */

import { basename } from 'node:path'
import { isPlainMdName } from '../shared/md-name.js'
import { stampHuman } from '../shared/stamp.js'
import { trimArchive } from '../memory/trim-archive.js'
import { sizeText } from '../memory/size-policy.js'

/**
 * 缘由的最短长度。与 `tools.js` 的 `MIN_REASON_CHARS` 同值，但这里**故意各写一份**：
 * 那是「写记忆」的判据，这是「裁段」的判据，将来一个放宽一个收紧都不该牵连对方。
 */
const MIN_REASON_CHARS = 4

/** 压缩留痕的三个键（重写时要先把旧值摘掉，否则同一份文件会攒出两套 `compressed_at`）。 */
const COMPRESSED_KEY_RE = /^compressed_(?:at|reason|from_bytes)\s*:/i

/** 压缩留痕：模型没自述缘由时的兜底缘由（与契约 §5.2 逐字一致）。 */
const DEFAULT_COMPRESS_REASON = '整理时压缩'

/**
 * `archive_segment` 的参数面。
 *
 * 与 §契约 5.1 一字不差：`{file, heading?, startLine?, endLine?, reason}`。
 * `heading` 与行区间**二选一**（两者都给时执行器会回文案拒绝 —— 猜「以哪个为准」
 * 会让模型以为另一种写法也生效，下一次继续这么写）。
 */
export function archiveSegmentToolSchema() {
  return {
    name: 'archive_segment',
    description:
      '把一条记忆里的**一整段**裁下来（旧内容移进 archive/，主文件原位置留一行指针）。' +
      '用于超过 40 KB、但能拆出一个完整小节的条目 —— 拆得开就别整体压缩，旧内容进档案馆还能人工捞回。' +
      '参数给 heading（小节标题，不含 #）或 startLine/endLine（1-based 闭区间）**二选一**，reason 必填。' +
      '归档件命名、frontmatter、指针都由宿主写，你只需要说清「裁哪段、为什么」。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '记忆文件名，例如 project_example.md（只能是 memory 目录顶层的 .md）' },
        heading: {
          type: 'string',
          description: '要裁的小节标题，不含 #（例如「旧方案」）。与 startLine/endLine 二选一。',
        },
        startLine: { type: 'number', description: '行区间起点（1-based，含）。与 endLine 成对出现。' },
        endLine: { type: 'number', description: '行区间终点（1-based，含）。与 startLine 成对出现。' },
        reason: {
          type: 'string',
          description: '必填。一句话说清这段为什么该进档案馆（至少 4 个字）。会写进指针与归档件的 archived_reason，人靠它判断裁得对不对。',
        },
      },
      required: ['file', 'reason'],
      additionalProperties: false,
    },
  }
}

/**
 * 给要落盘的内容补上压缩留痕（`compressed_at` / `compressed_reason` / `compressed_from_bytes`）。
 *
 * 为什么由**宿主**补而不是让模型自己写（契约 §5.2）：模型不用记三个字段名，也漏不了；
 * 而人读声明时要能在文件本身看到「这条被压过、原来多大」—— 只记在运行记录里，
 * 半年后翻到这份文件的人不会去翻那次运行记录。
 *
 * 三条边界，都是踩过才写下来的：
 *   · **没有 frontmatter 就原样返回**（`MEMORY.md` 是清单、不是一条记忆，不硬给它造一个头）；
 *   · 已有 `compressed_*` 时**先摘掉再写**，否则反复压缩会攒出重复键（YAML 后者覆盖前者，
 *     阅读时两份 `compressed_at` 却同时存在，看起来像两次互相矛盾的记录）；
 *   · 值一律单引号 + 转义，理由里出现 `: ` 或 ` #` 时不会被 YAML 静默吞掉。
 *
 * @param {string} content — 模型给的完整内容（frontmatter + 正文）
 * @param {{reason?:string, fromBytes?:number, at?:number}} info
 * @returns {string} 补过留痕的内容（不合法输入原样返回，绝不抛）
 */
export function withCompressionNote(content, info = {}) {
  const text = String(content ?? '')
  const m = text.match(/^---(\r?\n)([\s\S]*?)\r?\n---/)
  if (!m) return text
  const eol = m[1]
  const reason = String(info.reason ?? '').trim()
  const fromBytes = Math.round(Number(info.fromBytes) || 0)
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`
  const body = m[2].split(/\r?\n/).filter((line) => !COMPRESSED_KEY_RE.test(line))
  body.push(
    `compressed_at: ${q(stampHuman(Number.isFinite(info.at) ? info.at : Date.now()))}`,
    `compressed_reason: ${q(reason.length >= MIN_REASON_CHARS ? reason : DEFAULT_COMPRESS_REASON)}`,
    `compressed_from_bytes: ${fromBytes}`,
  )
  return `---${eol}${body.join(eol)}${eol}---${text.slice(m[0].length)}`
}

/** 失败码 → 一句「下一步怎么做」（只说一条能立刻执行的处置，不让模型自己猜）。 */
const CODE_HINT = Object.freeze({
  selector_invalid: '选择器不合法：行号不许触到文件头的 frontmatter，标题也不能为空。',
  heading_not_found: '小节标题没找到：先 read_memory 核一遍标题原文（不含 #），或改用 startLine/endLine。',
  heading_ambiguous: '这个标题在文件里出现了多次：改用 startLine/endLine 指明是哪一段。',
  segment_too_small: '这一段太小（不足 1 KB）：不值得单开一个归档件，直接把整条压缩更划算。',
  remain_too_small: '裁完主文件会不足 1 KB：换一段更小的，或整条压缩。',
  no_frontmatter: '文件头没有 frontmatter 起始：裁段要求 frontmatter 完整（`---` 开头），先 read_memory 看一眼原文。',
  invalid_name: '文件名不合法（只能是 memory 目录顶层的 .md 文件名）。',
  invalid: '选择器不合法：给 heading（小节标题，不含 #），或给 startLine/endLine（1-based 闭区间）。',
  reserved: '这条在保护名单里（不许改）：跳过它，别换个名字重试。',
  non_entry: '它不是一条记忆（索引 / 流水）：体积治理不管这两类，跳过。',
  locked: '这条被人工锁定：本轮不要动它，如实回报「被锁定挡住」。',
  not_found: '没有这个文件：用 list_memory 确认真实文件名。',
  exists: 'archive/ 里已有同名归档件：不要覆盖，改裁另一段，或请人工处理。',
  stale_revision: '这份记忆在你读到之后被人改过：重新 read_memory 再决定裁哪段（一个字节都没写）。',
  lock_unknown: '锁状态读不出来，本轮不敢动记忆文件：如实回报「被锁挡住了」。',
  io_error: '写盘出错（磁盘 / 权限）：如实回报，不要拿同一段重试。',
  after_archive: '归档件已写成、主文件没改成功，归档件已退役保留：把这条如实报给人，不要重试。',
})

/** 模型给的名字 → memory 目录顶层的一个合法 .md 名（null = 不合法）。 */
function targetName(raw) {
  const s = String(raw ?? '').trim()
  if (!s || !isPlainMdName(s)) return null
  const base = basename(s)
  // 只认顶层文件名：带目录成分的（`archive/x.md` / `../x.md`）一律拒绝，理由与 tools.js 同一条。
  if (base !== s || base.startsWith('.')) return null
  return base
}

/** 数值参数宽容一点：模型把 12 写成 "12" 很常见，没必要为此拒一次正确的裁剪。 */
function asInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : NaN
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? Math.round(n) : NaN
  }
  return NaN
}

/**
 * `heading` 与 `startLine/endLine` 二选一 → 选择器对象。
 * @returns {{heading:string}|{startLine:number,endLine:number}|string} 字符串 = 已写好的错误回执
 */
function pickSelector(a) {
  const heading = typeof a.heading === 'string' ? a.heading.trim().replace(/^#+\s*/, '') : ''
  const start = asInt(a.startLine)
  const end = asInt(a.endLine)
  const hasLines = Number.isFinite(start) || Number.isFinite(end)
  if (heading && hasLines) {
    return '错误：heading 与 startLine/endLine 只能给一种 —— 给小节标题，或给行区间（1-based 闭区间），不要都给。'
  }
  if (!heading && !hasLines) {
    return '错误：必须说清裁哪一段：给 heading（小节标题，不含 #），或给 startLine 与 endLine（1-based 闭区间）。'
  }
  if (heading) return { heading }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return '错误：行区间要同时给 startLine 与 endLine（1-based，闭区间）。'
  }
  return { startLine: start, endLine: end }
}

/**
 * 执行 `archive_segment`。
 *
 * @param {object} args — 模型给的参数
 * @param {{memoryDir:string, ctx?:object, apply?:boolean,
 *          record?:(op:string, info:object)=>void}} deps
 *   `record` 由 `tools.js` 注入，内部即 `changeRecord` —— 本模块不直接碰变更账。
 * @returns {Promise<string>} 回执（成功或错误，永不抛）
 */
export async function runArchiveSegment(args, deps = {}) {
  try {
    const { memoryDir, ctx, apply, record } = deps
    if (!apply) {
      return '错误：当前是「只出报告」模式，没有裁剪权限。请把超线条目与建议裁哪一段写进你的最终回复。'
    }
    const a = args && typeof args === 'object' ? args : {}
    const name = targetName(a.file)
    if (!name) return `错误：文件名不合法（只能是 memory 目录顶层的 .md 文件名）：${String(a.file)}`
    const reason = typeof a.reason === 'string' ? a.reason.trim() : ''
    if (reason.length < MIN_REASON_CHARS) {
      return '错误：archive_segment 必须给 reason —— 一句话说明这段为什么该进档案馆（至少 4 个字）。'
    }
    const selector = pickSelector(a)
    // 字符串 = 已经写好的错误文案（二选一被违反），直接回给模型。
    if (typeof selector === 'string') return selector

    const res = await trimArchive({ memoryDir, name, selector, reason, at: Date.now(), ctx })
    if (!res || res.ok !== true) {
      const code = String(res?.code ?? 'unknown')
      const hint = CODE_HINT[code] ?? '按 sage-mem 技能的「体积治理」换一条路处置（例如用 write_memory 就地压缩）。'
      const detail = typeof res?.error === 'string' && res.error.trim() ? `：${res.error.trim()}` : ''
      return `错误：${code} — ${hint}${detail}`
    }
    /**
     * 变更记录**只记「主文件被改了」这一件事**。
     *
     * 归档件不是被删掉的记忆（它还在 archive/ 里、可人工捞回），把两条都记进 changes 会让
     * 声明里同一件事出现两行；而回滚是按**文件**聚合的，主文件这一条就足以把它写回运行前那一版。
     */
    record?.('trim', {
      file: name,
      reason,
      before: { exist: true, bytes: res.beforeBytes, sha256: null },
      after: { exist: true, bytes: res.afterBytes, sha256: null },
      extra: { archivedFile: basename(String(res.archivedFile ?? '')), segmentBytes: res.segmentBytes },
    })
    const archived = basename(String(res.archivedFile ?? '')) || '（归档件）'
    return (
      `已裁剪 ${name}：${sizeText(res.segmentBytes)} 移进 archive/${archived}，` +
      `主文件 ${sizeText(res.beforeBytes)} → ${sizeText(res.afterBytes)}，原位置已留一行指针。`
    )
  } catch (err) {
    // 兜到底：这一层的返回值是工具面契约（字符串），抛出去会让整趟整理崩掉。
    return `错误：archive_segment 执行失败 — ${err?.message ?? String(err)}`
  }
}
