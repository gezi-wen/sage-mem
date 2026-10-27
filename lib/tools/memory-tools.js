/**
 * sage-mem —— 给模型的两个检索工具。
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
 */

import { DEFAULT_MAX_BYTES, MAX_MAX_BYTES, readSlice } from '../memory/reader.js'
import { DEFAULT_LIMIT, MAX_LIMIT, retrieve } from '../memory/search.js'
import { scanMemoryFiles } from '../memory/scan.js'
import { parseFrontmatter } from '../memory/frontmatter.js'
import { describeValidity } from '../memory/validity.js'

/** 工具返回内容统一用 text block（宿主把 ContentBlock[] 交给模型）。 */
const text = (s) => [{ type: 'text', text: String(s ?? '') }]

/** 渲染层对单条的字节上限：工具输出也吃上下文，不该一次吐一整份记忆。 */
const renderClip = (s, n) => {
  const str = String(s ?? '')
  return str.length > n ? `${str.slice(0, n)}…` : str
}

function renderSearchResult(args, value) {
  const v = value ?? {}
  if (v.ok === false) return text(`检索失败：${v.error ?? '未知错误'}`)
  const cov = v.coverage ?? {}
  const head = [
    `检索面：${v.scope ?? 'all'}；扫了 ${cov.searched ?? 0} 份记忆（切出 ${cov.chunks ?? 0} 个段落）`,
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
  return text(`${head}${flags.length ? `（${flags.join('；')}）` : ''}\n\n${v.content ?? ''}${tail}`)
}

/**
 * 造两个工具定义。
 *
 * @param {object} ctx — 插件上下文（`scanMemoryFiles` 要用它写警告日志）
 * @returns {{searchMemory: object, readMemory: object}}
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
        const files = await scanMemoryFiles(ctx, exec?.agent?.id ?? '')
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
        }
        return result
      } catch (err) {
        return { ok: false, code: 'io_error', error: `读取出错：${err?.message ?? err}` }
      }
    },
  }

  return { searchMemory, readMemory }
}
