/**
 * 「对账候选」的挑选（2.18.0）。
 *
 * ## 为什么要有它
 *
 * 自动做梦原先拿会话记录的方式是**查字典**（`prompt.js` 里那句「用 `search_sessions`
 * 定向搜一个具体词，不要通读会话记录」）。查字典能补漏，但发现不了「记错了 / 过时了」——
 * 而那恰恰是 Anthropic 的 Dreams 在做的事（把 session transcripts 当输入，跟记忆逐条对）。
 *
 * 我们不通读会话是有意的取舍（token 与隐私）。所以这里换个更省的切口：
 * **不让模型通读，而是先给它一张「最可能与现状不符」的短名单**，让它只对这几条去核对。
 *
 * ## 候选判据（两个条件同时成立）
 *
 *   1. **最近还被注入过**（`injected` 在 N 天内）—— 说明它仍在服役，不是死文件；
 *   2. **但内容很久没动过**（文件 mtime 早于 M 天）—— 说明这段话很可能是旧的。
 *
 * 「还在用 + 很久没改」= 最危险的组合：新的事实进不来，旧的说法还在每次注入里出现。
 *
 * 为什么用 mtime 而不读 frontmatter 的 `updated`：这里只需要粗筛，读 129 个文件的
 * frontmatter 要解析 YAML，而 mtime 一次 stat 就够。**粗筛宁宽勿严** —— 名单是给模型
 * 参考的，它自己会判断要不要真去改。
 *
 * ## 为什么不用语义
 *
 * 与整个插件一致：这一层只做「哪几条值得看一眼」的排序，不做「哪条错了」的判断。
 * 判断留给模型（它在做梦时本来就有 tool 和上下文）。
 */

/** 候选条数的默认上限。给多了模型读不完，给少了覆盖不到。 */
export const DEFAULT_RECONCILE_LIMIT = 5

/** 「最近还被注入过」的窗口（天）。 */
export const DEFAULT_FRESH_DAYS = 7

/** 「内容很久没动」的门槛（天）。 */
export const DEFAULT_STALE_DAYS = 14

const day = 86400000

/**
 * 纯函数：从「文件 × 台账」里挑对账候选。
 *
 * @param {object} input
 * @param {Array<{file: string, mtime: number, bytes?: number}>} input.entries — 记忆目录里的条目
 * @param {Record<string, {injected?: number, read?: number}>} input.ledger — access 台账
 * @param {number} [input.limit]
 * @param {number} [input.freshDays]
 * @param {number} [input.staleDays]
 * @param {number} [input.now]
 * @returns {Array<{file: string, idleDays: number, injectedDays: number}>} 按「最久没改」优先
 */
export function pickReconcileCandidates({
  entries,
  ledger,
  limit = DEFAULT_RECONCILE_LIMIT,
  freshDays = DEFAULT_FRESH_DAYS,
  staleDays = DEFAULT_STALE_DAYS,
  now = Date.now(),
}) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const rows = []
  for (const e of entries) {
    if (!e || typeof e.file !== 'string') continue
    const rec = ledger?.[e.file] ?? ledger?.[e.file.toLowerCase()]
    const injected = typeof rec?.injected === 'number' ? rec.injected : 0
    // 条件一：最近还被注入过（0 = 从没注入过，不算候选 —— 那种不叫「过时」，叫「没用上」）
    if (injected <= 0) continue
    const injectedDays = (now - injected) / day
    if (injectedDays > freshDays) continue
    // 条件二：内容很久没动
    const mtime = typeof e.mtime === 'number' ? e.mtime : 0
    if (mtime <= 0) continue
    const idleDays = (now - mtime) / day
    if (idleDays < staleDays) continue
    rows.push({ file: e.file, idleDays: Math.floor(idleDays), injectedDays: Math.floor(injectedDays) })
  }
  // 「还在服役」这一点越强（注入越近）、「内容越旧」，越该先对账。
  rows.sort((a, b) => (a.injectedDays - b.injectedDays) || (b.idleDays - a.idleDays))
  return rows.slice(0, Math.max(0, limit))
}

/**
 * 带上 IO 的那层：读目录 + 读台账，交给纯函数挑。
 *
 * @param {object} input
 * @param {string} input.memoryDir
 * @param {(dir: string) => Promise<Array<{file: string, mtime: number, bytes?: number}>>} input.listEntries — 由调用方注入，避免本文件依赖 scan
 * @param {(ledgerFile: string) => Promise<object>} input.readLedger
 * @param {string} input.ledgerFile
 * @param {number} [input.now]
 * @param {number} [input.limit]
 * @returns {Promise<Array<{file: string, idleDays: number, injectedDays: number}>>}
 */
export async function collectReconcileCandidates({ listEntries, readLedger, ledgerFile, now = Date.now(), limit }) {
  const [entries, ledger] = await Promise.all([listEntries(), readLedger(ledgerFile)])
  return pickReconcileCandidates({ entries, ledger, limit, now })
}

/**
 * 把候选渲染成 prompt 里那一段。
 *
 * 为什么渲染在 prompt 侧而不是这里拼好整段：这一段要跟「阶段 2.5」的标题与指令一起出现，
 * 分开写会让两处措辞漂移。这里只负责**列表本身**，措辞归 `prompt.js`。
 *
 * @param {Array<{file: string, idleDays: number, injectedDays: number}>} rows
 * @returns {string} 每行一条；空数组返回空串（调用方据此整段不出现）
 */
export function renderReconcileList(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return ''
  return rows
    .map((r) => `- \`${r.file}\` —— 最近 ${r.injectedDays} 天内还在被注入，但内容已经 ${r.idleDays} 天没动过`)
    .join('\n')
}

/** 只有会话记录也在输入源里时才有「拿会话去核对」这回事。 */
export const RECONCILE_SOURCE = 'memory+sessions'

/**
 * 引擎实际调用的那一层：**按输入源开关 + 失败降级**都收在这里，好被测试直接钉住。
 *
 * 为什么把「什么时候算、算不出来怎么办」也放本文件：这两条是这一版唯一有行为风险的
 * 决定（错了要么拖垮整趟做梦，要么在「仅记忆目录」时凭空多出一段）。留在引擎的方法体里
 * 就只能靠读源码断言，放到这里可以直接喂假 IO 跑。
 *
 * ⚠️ 降级是**静默**的：对账是附加价值，它挂了不该让整趟做梦失败，也不该往报告里塞错误。
 *
 * @param {object} input
 * @param {string} input.source — 本次输入源
 * @param {() => Promise<Array<{file: string, mtime: number}>>} input.listEntries
 * @param {(file: string) => Promise<object>} input.readLedger
 * @param {string} input.ledgerFile
 * @param {number} [input.limit]
 * @param {number} [input.now]
 * @returns {Promise<string>} 列表文本；不该有或算不出来时是空串
 */
export async function buildReconcileList({ source, listEntries, readLedger, ledgerFile, limit, now = Date.now() }) {
  if (source !== RECONCILE_SOURCE) return ''
  try {
    const rows = await collectReconcileCandidates({ listEntries, readLedger, ledgerFile, limit, now })
    return renderReconcileList(rows)
  } catch {
    return ''
  }
}
