/**
 * sage-mem 记忆层 —— frontmatter 解析全家（tags / aliases / baseline / 摘要字段）。
 */

/**
 * 解析 frontmatter 的 `tags`（自定义标签，用于列表页筛选）。
 *
 * 三种写法都收 —— 手写记忆时这三种都会自然出现，只认一种就等于「标签时灵时不灵」：
 *   tags: [a, b]           （YAML flow）
 *   tags:\n  - a\n  - b    （YAML block）
 *   tags: a, b             （松散的逗号串）
 *
 * 上限 20 个、每个 40 字符：标签是给人点着筛的，超过这个量级已经不是标签，
 * 而是一句话被塞进了 tags 字段。
 */
export function parseTags(body) {
  const clean = (arr) =>
    arr
      .map((s) => String(s).trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((s) => s.slice(0, 40))
  const flow = body.match(/^tags:[ \t]*\[([^\]]*)\]/m)
  if (flow) return clean(flow[1].split(','))
  const block = body.match(/^tags:[ \t]*\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)+)/m)
  if (block) return clean(block[1].split(/\r?\n/).map((l) => l.replace(/^[ \t]*-[ \t]*/, '')))
  const inline = body.match(/^tags:[ \t]*(.+?)[ \t\r]*$/m)
  if (inline && inline[1].trim()) return clean(inline[1].split(','))
  return []
}

/** 解析 frontmatter 的 name/description/type（兼容顶层与 metadata 嵌套两种 type）。 */
export function parseFrontmatter(content) {
  // 换行必须容忍 CRLF：任何用 Windows 编辑器碰过一次的文件都会被换成 \r\n，
  // 而旧版这里写的是 /^---\n/ —— 匹配失败 → description/type 全空 →
  // 「baseline 走 parseBaseline 那条带 \r?\n 的正则照旧命中，但这条记忆永远检索不到」，
  // 症状极具欺骗性。下文定义的 parseBaseline 与 extractTitle 早已是 \r?\n。
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { name: '', description: '', type: '', tags: [], aliases: [], updated: '', baselinePriority: 0 }
  const body = m[1]
  const grab = (key) => {
    // [ \t] / [ \t\r] 而不是 \s：\s 会连 CRLF 的 \r 一起吃进捕获组，值尾留一个 \r
    // 会让下面的引号剥离（["']$）失配，description 尾巴上挂一个残引号。
    const hit = body.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t\\r]*$`, 'm'))
    if (!hit) return ''
    return hit[1].replace(/^["']|["']$/g, '').trim()
  }
  let type = grab('type')
  if (!type) {
    const nested = body.match(/^metadata:\s*\r?\n(?:\s+[^\r\n]+\r?\n)*?\s+type:\s*(\S+)/m)
    if (nested) type = nested[1]
  }
  // `updated` 踩的是与 `type` 同一个坑：它通常写在 `metadata:` 嵌套块里（缩进两格），
  // 顶层 `^updated:` 抓不到 —— 于是「明明写了日期却永远显示不出来」。
  // 抓不到就回落文件 mtime（见 ageDays）：手写时间戳是权威的，文件系统时间只是退路。
  let updated = grab('updated')
  if (!updated) {
    const nestedUpdated = body.match(/^metadata:\s*\r?\n(?:\s+[^\r\n]+\r?\n)*?\s+updated:\s*(\S+)/m)
    if (nestedUpdated) updated = nestedUpdated[1]
  }
  return {
    name: grab('name'),
    description: grab('description'),
    type,
    tags: parseTags(body),
    aliases: parseAliases(body),
    updated,
    baselinePriority: parseBaselinePriority(body),
  }
}

/**
 * 解析 frontmatter 的 `aliases`（别称 / 同义词 / 我可能用的另一种叫法）。
 *
 * 为什么要有它：检索是**词面重合**的，不是语义的——问「我有什么待办」而文件里
 * 写的是「代办清单」，差一个字就完全不命中。`description` 回答「我会怎么问它」，
 * `aliases` 补上「我还可能怎么问」。写法与 tags 完全一致（flow / block / 逗号串三种都收），
 * 免得手写时「时灵时不灵」。
 */
export function parseAliases(body) {
  const clean = (arr) =>
    arr
      .map((s) => String(s).trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .slice(0, 24)
      .map((s) => s.slice(0, 60))
  const flow = body.match(/^aliases:[ \t]*\[([^\]]*)\]/m)
  if (flow) return clean(flow[1].split(','))
  const block = body.match(/^aliases:[ \t]*\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)+)/m)
  if (block) return clean(block[1].split(/\r?\n/).map((l) => l.replace(/^[ \t]*-[ \t]*/, '')))
  const inline = body.match(/^aliases:[ \t]*(.+?)[ \t\r]*$/m)
  if (inline && inline[1].trim()) return clean(inline[1].split(','))
  return []
}

/**
 * 解析 frontmatter 的 `baselinePriority`（数字，越大越先注入）。
 *
 * 旧版 baseline 是 `MAX_BASELINE = 5` + **按文件名排序**——`feedback_*` 永远排在
 * `user_*` 前面，与「哪条真的更该在每场会话开头出现」毫无关系。缺失当 0，
 * 于是没写这个字段的老条目行为不变。
 */
export function parseBaselinePriority(body) {
  const hit = body.match(/^baselinePriority:[ \t]*(.+?)[ \t\r]*$/m)
  if (!hit) return 0
  const n = Number(hit[1].replace(/^["']|["']$/g, '').trim())
  return Number.isFinite(n) ? n : 0
}

/** 解析 frontmatter 的 `baseline` 标记：会话第一回合无条件注入。 */
export function parseBaseline(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return false
  const hit = m[1].match(/^baseline:\s*(.+)$/m)
  if (!hit) return false
  return /^(true|yes|1)$/i.test(hit[1].replace(/^["']|["']$/g, '').trim())
}
