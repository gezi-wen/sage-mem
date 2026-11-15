/**
 * sage-mem —— 给模型的三个工具（2.10.0 起多了 `trim_memory`）。
 *
 * 这是「主动记忆」的落点：注入链是插件**猜**模型想看什么，而工具让模型**自己**去翻。
 * 两者不是替代关系 —— 注入是零边际成本的（宿主反正每步组装 prompt），工具则有真实代价
 * （一次工具调用的 token 与步数），所以只在注入不够时才该被用上。
 *
 * 三条设计约束：
 *   1. **不许另开读路径**。`read_memory` 走 `memory/reader.js`，而 reader 复用的是与设置页
 *      同序同函数的闸门（`safeName` → `shadowsReserved` → `inspectMemoryEntry`）。
 *      工具一旦自己拼路径，符号链接 / 8.3 短名 / 硬链接这些手法就会被它原样放行。
 *   2. **失败是值，不是异常**。所有错误都返回 `{ok:false, code, error}` —— 工具抛错会打断
 *      模型那一轮，而「这份记忆读不到」不该有那么大的杀伤力。
 *   3. **如实区分「没找到」与「找到但没给」**。`retrieve()` 的 `coverage` 里带着
 *      `filteredBelowFloor`（被相关性门槛滤掉几条），工具输出必须把它说出来 ——
 *      否则「不够格」会被读成「记忆里没有」，而这两件事对模型下一步的指示完全相反。
 *
 * 2.10.0 新增 `trim_memory`（体积治理的模型入口）。三条与之相关的取舍：
 *   - **它不自己拼写盘逻辑**：裁段规划与归档全在 `memory/trim-archive.js`（`trimArchive`），
 *     这里只做「参数校验 + 把结果翻成人话」。写序是安全边界，入口多一份实现就多一条绕过它的路。
 *   - **回执是字符串**（契约 §4）：成功报体积变化，失败给「错误：<code> — <一句处置建议>」。
 *     只丢一个 code 的话，模型下一步只能瞎猜该换标题还是该改用压缩。
 *   - `read_memory` 在命中**超出体积线**的条目时多一行提示：读得到 ≠ 这份还该原样留着。
 */

import { join } from 'node:path'
import { DEFAULT_MAX_BYTES, MAX_MAX_BYTES, readSlice } from '../memory/reader.js'
import { DEFAULT_LIMIT, MAX_LIMIT, retrieve } from '../memory/search.js'
import { inspectMemoryEntry, scanMemoryFilesDetailed } from '../memory/scan.js'
import { MEMORY_DIR } from '../memory/config.js'
import { safeName } from '../memory/naming.js'
import { parseFrontmatter } from '../memory/frontmatter.js'
import { describeValidity } from '../memory/validity.js'
import { classifySize, adviceText } from '../memory/size-policy.js'
import { trimArchive } from '../memory/trim-archive.js'

/** 工具返回内容统一用 text block（宿主把 ContentBlock[] 交给模型）。 */
const text = (s) => [{ type: 'text', text: String(s ?? '') }]

/** 渲染层对单条的字节上限：工具输出也吃上下文，不该一次吐一整份记忆。 */
const renderClip = (s, n) => {
  const str = String(s ?? '')
  return str.length > n ? `${str.slice(0, n)}…` : str
}

/**
 * 一份记忆在盘上的**字节数**（给 `read_memory` 的体积提示用）。
 *
 * 为什么再 stat 一次：`readSlice` 回的是**本次切片**的字节数，不是整份的 ——
 * 而「这条一共多大」正是提示要说的事。读失败一律返回 null（提示是附加信息，
 * 不该让一次成功的读变成失败）：闸门本身照旧由 `readSlice` 走。
 */
async function entryBytesOf(name) {
  try {
    const safe = safeName(name)
    if (!safe) return null
    const gate = await inspectMemoryEntry(join(MEMORY_DIR, safe))
    return gate && gate.ok ? gate.size : null
  } catch {
    return null
  }
}

function renderSearchResult(args, value) {
  const v = value ?? {}
  if (v.ok === false) return text(`检索失败：${v.error ?? '未知错误'}`)
  const cov = v.coverage ?? {}
  const head = [
    `检索面：${v.scope ?? 'all'}；扫了 ${cov.searched ?? 0} 份记忆（切出 ${cov.chunks ?? 0} 个段落）`,
    // 目录不存在 = 还没建过记忆（合法空库），说出来，别让「空」被读成「扫过且没有」。
    cov.missingDir ? '；记忆目录还不存在（可能还没建过任何记忆）' : '',
    // 单条目被闸门跳过（链接 / 超限 / 保留名别名 / 读失败）：与「目录级读不了」分开报。
    cov.skippedFiles ? `；有 ${cov.skippedFiles} 份被读取闸门跳过（链接 / 超限 / 读不了）` : '',
    cov.skipped ? `；有 ${cov.skipped} 份没读成` : '',
    cov.filteredBelowFloor ? `；另有 ${cov.filteredBelowFloor} 段因相关性不够被滤掉` : '',
    `。`,
  ].join('')
  if (!v.hits?.length) {
    return text(`${head}\n没有命中。可以换个说法（近义词、具体实体名、错误码或文件名）再搜一次。`)
  }
  const lines = v.hits.map((h, i) => {
    const where = h.lines ? `${h.file}:${h.lines[0]}-${h.lines[1]}` : h.file
    const why = Array.isArray(h.matchedBy) ? h.matchedBy.join('+') : ''
    // 2.0.0：失效记忆**仍然能被搜到**（问历史时旧口径是证据），但必须标出来 ——
    // 不标的话模型会把旧口径当现状，那正是「标了失效却仍在误导」的更坏版本。
    const validity = h.expired
      ? `（已失效${h.invalidAt ? `：invalid_at=${h.invalidAt}` : ''}，不是现行口径${h.supersededBy ? `；现行见 ${h.supersededBy}` : ''}）`
      : h.invalidAt || h.supersededBy
        ? `（有失效标记但未到点${h.invalidAt ? `：invalid_at=${h.invalidAt}` : ''}${h.supersededBy ? `；现行见 ${h.supersededBy}` : ''}）`
        : ''
    const excerpt = h.excerpt ? `\n    ${renderClip(h.excerpt.replace(/\n/g, ' '), 200)}` : ''
    return `${i + 1}. ${where}${why ? `（${why}）` : ''}${validity}${excerpt}`
  })
  const tail = v.nextCursor != null ? `\n\n还有下一页：用 cursor=${v.nextCursor} 继续。` : ''
  return text(`${head}\n${lines.join('\n')}${tail}`)
}

function renderReadResult(args, value) {
  const v = value ?? {}
  if (v.ok === false) {
    // revision 变化要单独说清楚：调用方需要拿**当前的** revision 重新读，
    // 而不是拿着过期行号去猜。
    if (v.code === 'revision_changed') {
      return text(`这份记忆在你上次读之后被改过（revision 已变）。当前 revision：${v.revision}。请用新 revision 重读。`)
    }
    return text(`读取失败（${v.code ?? 'unknown'}）：${v.error ?? '未知错误'}`)
  }
  const head = `${v.name}:${v.startLine}-${v.endLine}（共 ${v.totalLines} 行，revision ${v.revision}）`
  const flags = [
    v.lineTooLong ? '这一行本身超过了一屏' : '',
    v.truncated ? '内容被截断' : '',
    // 2.0.0：失效标记必须跟着正文一起给模型 —— 读得到 ≠ 仍然是现行口径。
    v.expired ? '这条记忆已失效（invalid_at 已到点），下面是历史口径，不是现状' : '',
    !v.expired && v.invalidAt ? `这条记忆带失效标记但未到点（invalid_at=${v.invalidAt}）` : '',
    v.supersededBy ? `现行口径见 ${v.supersededBy}` : '',
  ].filter(Boolean)
  const tail = v.nextStartLine != null
    ? `\n\n还有内容：startLine=${v.nextStartLine}${v.nextStartByte ? ` startByte=${v.nextStartByte}` : ''}`
    : '\n\n（已读到末尾）'
  // 2.10.0：体积提示**追加在最后一行**，不混进页头那圈括号（那里说的是「这一页怎么读」）。
  // 整句由 size-policy 的 adviceText 出 —— 回执 / 审计 / 做梦提示共用同一句，别各写一套。
  const sizeHint = v.sizeHint
    ? `\n\nℹ ${adviceText({ bytes: v.sizeHint.bytes, kind: v.sizeHint.kind })}`
    : ''
  return text(`${head}${flags.length ? `（${flags.join('；')}）` : ''}\n\n${v.content ?? ''}${sizeHint}${tail}`)
}

/**
 * 裁段的失败码 → **一句处置建议**（契约 §4：回执要能直接指导下一步动作）。
 *
 * 码出自 `memory/trim-plan.js` 与 `memory/trim-archive.js`；这里只翻译、不改判。
 * 没登记过的码落到通用那一句 —— 宁可少说，也别编一个不存在的理由。
 */
const TRIM_ADVICE = {
  lock_unknown: '锁表读不出来（被占用或损坏），确认没有别的整理进程在跑再重试',
  locked: '这条记忆被锁定了 —— 先在面板上解锁，锁定优先于体积治理',
  reserved: '这是保留名（索引 / 流水 / 保护名单里的文件），体积治理不裁它们',
  non_entry: '这不是一条普通记忆（可能是整理报告 / 快照），不在治理范围',
  missing: '没有这份记忆 —— 用 search_memory 确认文件名',
  not_found: '没有这份记忆 —— 用 search_memory 确认文件名',
  too_big: '这份记忆本身超了单文件上限，先用 write_memory 压小它，再裁段',
  symlink: '这个文件指向别处（符号链接 / 目录联接），出于安全不处理',
  not_file: '这不是普通文件，不处理',
  no_frontmatter: '正文没有 frontmatter —— 裁剪保证不了剩余正文仍带完整 frontmatter，用文件工具补上再裁',
  invalid: '这次算出来的切法不安全（内部不变量没通过）—— 换个选择器再试，主文件没动',
  selector_invalid: '行区间碰到了 frontmatter 或行号非法 —— 改用 heading 指小节更稳',
  segment_too_small: '要裁的这段太小（不足 1 KB）：小段不值得裁，就地压缩更合适',
  remain_too_small: '裁完剩下的正文会不足 1 KB —— 换更短的一段，或改用压缩',
  heading_not_found: '标题没找到 —— 标题写小节文字本身（不含 #），或改用 startLine/endLine',
  heading_ambiguous: '同名标题不止一处 —— 改用 startLine/endLine 精确指定',
  exists: '归档件重名（同一标题今天已经裁过）—— 换个标题，或今天就别再裁这段',
  stale_revision: '读到之后文件被改过 —— 重新读一遍再裁（会按最新内容重算）',
  invalid_name: '文件名不合法：要一个 .md 文件名，不能带路径',
  reason_too_short: '缘由至少 4 个字 —— 档案馆要能回答「它为什么被收起来」',
  io_error: '读写失败（权限 / 盘掉线 / 文件被占用），稍后重试',
}

/**
 * `<code> — <建议>`；成功回执里也用它指归档件的位置。
 *
 * `extra` 是**阶段补充**（契约 §3 第 7 步）：`stage === 'after_archive'` 表示归档件
 * 已经写成、随后又被退役进 archive/ —— 那不是 `code`，不能塞进上面那张表。
 * 这件事必须说出来：否则用户看到「失败」会以为旧内容没了。
 */
function trimFailureText(code, error, extra) {
  const advice = TRIM_ADVICE[code] || '这次没改成，主文件一字未动；换个选择器或稍后重试'
  return `错误：${code} — ${advice}${extra ? `（${extra}）` : ''}${error ? `（宿主原话：${renderClip(error, 200)}）` : ''}`
}

/** 归档件的展示名：宿主可能给文件名、相对路径或绝对路径，统一显示成 `archive/<文件名>`。 */
function archiveLabel(p) {
  const s = String(p ?? '')
  if (!s) return 'archive/（未命名）'
  const tail = s.split(/[\\/]/).filter(Boolean).pop() || s
  return `archive/${tail}`
}function renderTrimResult(args, value) {
  const v = value ?? {}
  return text(v.text != null ? v.text : trimFailureText(v.code ?? 'unknown', v.error))
}

/**
 * 造三个工具定义。
 *
 * @param {object} ctx — 插件上下文（`scanMemoryFiles` 要用它写警告日志）
 * @returns {{searchMemory: object, readMemory: object, trimMemory: object}}
 */
export function createMemoryTools(ctx) {
  const searchMemory = {
    name: 'search_memory',
    description:
      '在本地记忆库（markdown 文件）里检索历史记忆。先用一句话摘要匹配、再按段落查正文，返回候选与命中片段。' +
      '当你需要依据既往决定、用户偏好、或继续未完成的任务，而当前上下文里没有可定位的依据时用它。' +
      'scope 选 summary 只比摘要（最省）、body 只查正文段落、all 两者都查（默认）。' +
      '结果里带 file 与行号，可直接用 read_memory 读那一段。' +
      '已标失效（invalid_at）的记忆**仍然会被搜到**，结果里会带 invalidAt / supersededBy —— 那是历史口径，不是现状。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词或问题原文（自然语言即可）' },
        scope: { type: 'string', enum: ['summary', 'body', 'all'], description: '检索面，默认 all' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `最多返回几条候选，默认 ${DEFAULT_LIMIT}` },
        cursor: { type: 'integer', minimum: 0, description: '翻页游标：用上一次返回的 nextCursor' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderSearchResult },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim()
      if (!query) return { ok: false, error: 'query 不能为空' }
      try {
        /**
         * 用 Detailed 入口（外部审查 2026-10-31，Q14）：目录级失败（ENOTDIR / EACCES…）
         * 以前被 `scanMemoryDir` 降级成空数组，工具照样回 `ok:true` + `complete:true`，
         * 「读不了记忆」就被渲染成「记忆里没有」。现在把「检索不可用」单独带出去。
         */
        const scan = await scanMemoryFilesDetailed(ctx, exec?.agent?.id ?? '')
        if (scan.complete === false) {
          const detail = (scan.errors ?? []).map((e) => `${e.code ? `${e.code}: ` : ''}${e.message}`).join('；') || '目录读取失败'
          return {
            ok: false,
            code: 'memory_unavailable',
            error: `记忆目录读不了（${detail}）。这是「检索不可用」，不代表记忆里没有匹配项 —— 换个时间重试，或检查记忆目录是否存在、是否是个目录。`,
            coverage: { searched: 0, complete: false, errors: scan.errors ?? [] },
          }
        }
        const files = scan.files
        const result = retrieve({ query, files, scope: args?.scope, limit: args?.limit, cursor: args?.cursor })
        // 2.0.0：把每条命中对应的失效信息带出去（D29 Q3）。检索本身**不过滤**失效记忆 ——
        // 问历史时旧口径是证据；过滤掉才是丢信息。模型靠这里的标记判断「这是不是现状」。
        if (result && result.ok !== false && Array.isArray(result.hits)) {
          const byFile = new Map(files.map((f) => [f.file, f]))
          const nowMs = Date.now()
          result.hits = result.hits.map((h) => {
            const file = byFile.get(h.file)
            if (!file) return h
            const v = describeValidity(file, nowMs)
            const extra = {}
            if (v.invalidAt) extra.invalidAt = v.invalidAt
            if (v.supersededBy) extra.supersededBy = v.supersededBy
            if (v.expired) extra.expired = true
            return Object.keys(extra).length ? { ...h, ...extra } : h
          })
          // 扫描层的「单条目被跳过」与目录级失败分开报（Q14）：坏一份 ≠ 整库读不了。
          if (result.coverage && typeof result.coverage === 'object') {
            result.coverage.skippedFiles = scan.skipped ?? 0
            if (scan.missing) result.coverage.missingDir = true
          }
        }
        return result
      } catch (err) {
        // 工具**绝不抛**：一次检索失败不该打断模型那一轮。
        return { ok: false, error: `检索出错：${err?.message ?? err}` }
      }
    },
  }

  const readMemory = {
    name: 'read_memory',
    description:
      '按文件名读取一份本地记忆的正文，可按行分页。用 search_memory 拿到的 file 与行号来读。' +
      '返回内容带 revision；如果你上次读之后这份记忆被改过，会告诉你 revision 已变，需要重新确认。' +
      '如果这份记忆已标失效（invalid_at 已到点），页头会明确写出来 —— 那是历史口径。' +
      `一次默认读 ${DEFAULT_MAX_BYTES} 字节，返回的 nextStartLine / nextStartByte 用于继续往下读。`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '记忆文件名（如 project_deploy.md）' },
        startLine: { type: 'integer', minimum: 1, description: '从第几行开始（1-based），默认第 1 行' },
        startByte: { type: 'integer', minimum: 0, description: '行内字节偏移，用于读超长行的下一段，默认 0' },
        maxBytes: { type: 'integer', minimum: 1, maximum: MAX_MAX_BYTES, description: `一次最多读多少字节，默认 ${DEFAULT_MAX_BYTES}` },
        revision: { type: 'string', description: '你上次读到的 revision；带上它可发现内容已被改动' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderReadResult },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const result = await readSlice({
          name: args?.name,
          revision: args?.revision,
          startLine: args?.startLine,
          startByte: args?.startByte,
          maxBytes: args?.maxBytes,
        })
        // 只在本页包含 frontmatter 时解析（分页读的后半段没有 frontmatter，解析出来是空 —— 不猜）。
        if (result && result.ok !== false && typeof result.content === 'string') {
          const meta = parseFrontmatter(result.content)
          if (meta.invalidAt || meta.supersededBy) {
            const v = describeValidity({ invalidAt: meta.invalidAt, supersededBy: meta.supersededBy }, Date.now())
            result.invalidAt = v.invalidAt
            result.supersededBy = v.supersededBy
            result.expired = v.expired
          }
          // 2.10.0：整份体积过线时多带一行提示（渲染层决定怎么说）。
          // 每一次读都算一次 stat —— 这是只读的、与内容读取同一条闸门，代价可忽略。
          const bytes = await entryBytesOf(args?.name)
          if (bytes != null) {
            const c = classifySize({ bytes })
            if (c.level === 'warn' || c.level === 'force') {
              result.sizeHint = { bytes: c.bytes, kind: c.kind, level: c.level, limit: c.limit }
            }
          }
        }
        return result
      } catch (err) {
        return { ok: false, code: 'io_error', error: `读取出错：${err?.message ?? err}` }
      }
    },
  }

  /**
   * 裁段归档（体积治理的模型入口，2.10.0）。
   *
   * **只做参数校验 + 结果翻译**：规划与写序全在 `memory/trim-archive.js`。
   * 不复刻实现是有意的 —— 写序（先归档、再改主文件、失败退役）是安全边界，
   * 多一个入口就多一条绕过它的路。
   *
   * 参数校验为什么放在这里而不是宿主 manifest：契约 §4 要求「缺两个或都给」时回一句
   * 能照做的文案（说清 heading 与行区间怎么选），那是给人/模型看的话，不是 schema 能表达的。
   */
  const trimMemory = {
    name: 'trim_memory',
    description:
      '把一份记忆里的一段旧内容**裁下来归档**到 archive/，主文件原位置只留一行指针 —— 不是删除，随时能捞回来。' +
      '用在「这条记忆太大了、而其中某几节已经过时」的时候：拆得开就裁段，拆不开就 write_memory 压缩。' +
      'heading 与 startLine/endLine 二选一：给小节标题（不含 #），或给行区间（1-based，含两端）。' +
      'reason 必填（≥4 字），会写进归档件与主文件指针 —— 半年后要靠它看懂为什么裁。' +
      '被裁段至少 1 KB、剩余正文至少 1 KB；MEMORY.md / session-log.md / 保护名单里的文件一律拒绝。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '记忆文件名（如 project_deploy.md）' },
        heading: { type: 'string', description: '要裁的小节标题（不含 #，如「故障记录」）。与行区间二选一' },
        startLine: { type: 'integer', minimum: 1, description: '行区间起点（1-based，含）。与 endLine 一起给' },
        endLine: { type: 'integer', minimum: 1, description: '行区间终点（1-based，含）' },
        reason: { type: 'string', description: '为什么裁（≥4 字，写进归档件与主文件指针）' },
      },
      required: ['file', 'reason'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderTrimResult },
    // 会写盘：两个裁段并行跑会互相踩 revision，串行更诚实（宿主据此排队）。
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const name = String(args?.file ?? '').trim()
      const reason = String(args?.reason ?? '').trim()
      const headingRaw = args?.heading
      const heading = typeof headingRaw === 'string' ? headingRaw.trim().replace(/^#+\s*/, '') : ''
      const hasLines = args?.startLine != null || args?.endLine != null

      if (!name) {
        return {
          ok: false,
          code: 'invalid_name',
          text: '错误：invalid_name — file 要给一个 .md 文件名（如 project_deploy.md），不能带路径',
        }
      }
      if (reason.length < 4) {
        return {
          ok: false,
          code: 'reason_too_short',
          text: '错误：reason_too_short — reason 至少 4 个字，写清为什么裁（它会进归档件与主文件指针，半年后靠它看懂）',
        }
      }
      if (heading && hasLines) {
        return {
          ok: false,
          code: 'selector_conflict',
          text: '错误：selector_conflict — heading 与 startLine/endLine 只能给一个：要裁整节就写 heading，要裁几行就写 startLine + endLine',
        }
      }
      if (!heading && !hasLines) {
        return {
          ok: false,
          code: 'selector_missing',
          text: '错误：selector_missing — 没说裁哪一段：给 heading（小节标题，不含 #）或 startLine + endLine（1-based，含两端）',
        }
      }
      let selector
      if (heading) {
        selector = { heading }
      } else {
        const startLine = Number(args?.startLine)
        const endLine = Number(args?.endLine)
        if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
          return {
            ok: false,
            code: 'selector_invalid',
            text: '错误：selector_invalid — 行区间要写成 startLine ≥ 1 且 endLine ≥ startLine（1-based，含两端）',
          }
        }
        selector = { startLine, endLine }
      }

      try {
        const r = await trimArchive({
          memoryDir: MEMORY_DIR,
          name,
          selector,
          reason,
          at: Date.now(),
          ctx,
        })
        if (!r || r.ok !== true) {
          const code = (r && r.code) || 'io_error'
          // `stage` 不是 code：契约 §3 第 7 步说的「归档写成、主文件没改成」要单独讲清楚，
          // 否则「失败」会被读成「旧内容没了」。
          const extra = r && r.stage === 'after_archive'
            ? '归档件已写成并退役进 archive/，没有丢；主文件一字未动，重试一次即可'
            : null
          return { ok: false, code, text: trimFailureText(code, r && r.error, extra) }
        }
        const out = `已裁剪 ${r.segmentBytes} 字节到 ${archiveLabel(r.archivedPath || r.archivedFile)}，主文件 ${r.beforeBytes} → ${r.afterBytes} 字节`
        return { ok: true, text: `${out}${r.pointer ? `\n\n主文件里留的指针：${r.pointer}` : ''}` }
      } catch (err) {
        // 工具**绝不抛**：一次裁段失败不该打断模型那一轮（主文件是否被改动由 trimArchive 保证，
        // 它要么整段成功、要么在 after_archive 阶段留退役归档件）。
        return { ok: false, code: 'io_error', text: trimFailureText('io_error', err?.message ?? String(err)) }
      }
    },
  }

  return { searchMemory, readMemory, trimMemory }
}
