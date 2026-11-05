/**
 * autodream —— 「被删掉的事实」抽取（纯函数，零依赖，可单测）。
 *
 * **为什么要有这一层**：整理声明原先只交代「改了哪个文件、字节从 A 变成 B」。
 * 结构审计（断链 / 格式 / 索引）能看见这些，**看不见事实**。2026-11-05 实测：
 * 一趟自动整理把某条记忆里「到期 2027-10-03、不自动续费」这句仍然生效的账压掉了，
 * 跑完自报「审计 2 问题 → 0 问题」—— 结构一片绿，丢掉的东西没有任何痕迹。
 * 人能发现它，只因为事后拿回滚点快照逐行 diff。
 *
 * 所以这一层回答一个问题：**这两份正文之间，哪几条事实不再存在了？**
 * 它只做比对与呈现，不做判断 —— 判断永远是人的事。
 *
 * **口径（2026-11-05 定）**：
 *   - 覆盖两种删除动作：`archive`（整条退役）与 `update`（改写里被覆盖掉的内容）。
 *   - 事实的来源是**宿主自己算的 diff**，不是模型自述 —— 模型可以漏报，diff 不会。
 *
 * 三个降噪规则，都是为了「宁可少报噪音，不可多报噪音」：
 *   1. **归一化比较**：抹掉纯格式差异（`-` / `#` / `>` / `**` / 反引号 / 空白），
 *      重新排版不算删事实。
 *   2. **多重集配额**：同一行在 after 里出现几次，before 里就保留几次；
 *      只有「配额用完还没找到」的行才算删除（重复行被删掉一条也报得出来）。
 *   3. **不降「包含关系」的噪**。曾经试过：删除行若被 after 的某一行包含（压缩合并成一句），
 *      就当内容还在、不报。**2026-11-05 审查推翻了这个做法** —— 它会把真删除静默吃掉：
 *        - before「到期 2027-10-03，不自动续费」被删、after 里有 `## 2027` → 一行 4 字标题吞掉整条账；
 *        - before「自动续费」→ after「不自动续费」→ 否定翻转被当成「内容还在」。
 *      这恰恰是本功能要防的那类静默丢失。所以现在**删除照报**，只在确认「长度比例合理」时
 *      附一个 `mergedInto` 线索（可能是被并进了哪一行），让人自己判断，而不是替人不报。
 */

/** 短于这个长度的行不算「事实」—— 分隔符、单字这类行列出来只会淹没真信号。 */
const MIN_FACT_CHARS = 4

/** 单条事实在声明里最多显示多少字符。 */
export const FACT_TEXT_MAX = 200

/** 单个文件最多列多少条被删事实（超出的只报数字，完整原文在快照 / archive/ 里）。 */
export const FACTS_PER_FILE = 40

/**
 * 自动归档策略一次可能收走一批文件 —— 每条只留在机读记录里的前 N 条事实。
 * 完整原文在 `archive/` 里，声明中会写明还有多少条没列。
 */
export const POLICY_FACT_LIMIT = 10

/** 整份声明里「被删事实」这一节最多用多少字符 —— 声明会内嵌进报告，不能把它撑爆。 */
export const FACTS_TOTAL_MAX = 8000

/** 一行的比较键：抹掉纯格式差异。 */
export function lineKey(raw) {
  return String(raw ?? '')
    .replace(/\r/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 正文切行：带 1-based 行号；空行丢掉（空行不是事实，也不该参与比对）。 */
function factLines(text) {
  const raw = String(text ?? '').split('\n')
  const out = []
  /**
   * frontmatter 是元数据，不是「这条记忆承载的事实」—— 它的键值变化（`type: project`
   * 被删掉）不该出现在「被删掉的事实」里，否则每一趟整理都会被元数据噪音刷屏。
   *
   * 只在**文件开头**认它：正文中间的 `---` 是水平分隔线，跳过它会漏掉真事实。
   */
  let start = 0
  const isFence = (s) => s.replace(/\r$/, '').trim() === '---'
  if (raw.length && isFence(raw[0])) {
    for (let j = 1; j < raw.length; j += 1) {
      if (isFence(raw[j])) {
        start = j + 1
        break
      }
    }
  }
  for (let i = start; i < raw.length; i += 1) {
    const key = lineKey(raw[i])
    if (!key) continue
    out.push({ line: i + 1, raw: raw[i].replace(/\s+$/, ''), key })
  }
  return out
}

/** 单条事实的展示文本：去掉行首的 markdown 结构标记，超长截断。 */
function factText(raw) {
  const s = String(raw ?? '')
    .replace(/\r/g, '')
    .replace(/^\s*(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/, '')
    .trim()
  if (s.length <= FACT_TEXT_MAX) return s
  return `${s.slice(0, FACT_TEXT_MAX)}…`
}

/**
 * 找「这条被删的内容可能是被并进了哪一行」。
 *
 * ⚠️ 这不是降噪，是**线索**。删除照报，这里只回答「有没有可能它还在别处」。
 * 长度比例必须合理，否则 `## 2027` 这种 4 字标题会把整条 19 字的到期账说成「已合并」
 * —— 那正是审查抓到的反例。上界放宽（3 倍或 60 字）因为「多行并成一行」时
 * 合并后的行本来就比单行长好几倍；放宽的代价只是多一个提示，**不会让删除消失**。
 *
 * @returns {number} after 里的行号；找不到返回 0
 */
function mergeHint(b, after) {
  const lo = b.key.length * 0.6
  const hi = Math.max(b.key.length * 3, 60)
  for (const a of after) {
    const n = a.key.length
    if (n < lo || n > hi) continue
    if (a.key === b.key) continue
    if (a.key.includes(b.key) || (b.key.includes(a.key) && a.key.length >= MIN_FACT_CHARS)) return a.line
  }
  return 0
}

/**
 * 从 before → after 的改写里抽出**被删掉的事实**。
 *
 * @param {string} beforeText — 写之前磁盘上的正文
 * @param {string} afterText — 写之后的正文
 * @returns {{removed:{line:number,text:string,mergedInto?:number}[], total:number, beforeLines:number, afterLines:number}}
 *   `removed` 已按 FACTS_PER_FILE 截断；`total` 是截断前真实条数。
 */
export function diffRemovedFacts(beforeText, afterText) {
  const before = factLines(beforeText)
  const after = factLines(afterText)
  /** after 里每个 key 还剩几次「可用来配对」。 */
  const pool = new Map()
  for (const a of after) pool.set(a.key, (pool.get(a.key) ?? 0) + 1)

  const removed = []
  let total = 0
  for (const b of before) {
    const left = pool.get(b.key) ?? 0
    if (left > 0) {
      pool.set(b.key, left - 1)
      continue
    }
    if (b.key.length < MIN_FACT_CHARS) continue
    total += 1
    if (removed.length >= FACTS_PER_FILE) continue
    // 只给**真正会展示出来的**那些算线索：前 40 条 × after 行数，而不是 N × M。
    // 审查实测过不设这个界的版本：444 KB / 17.5k 短行时同步阻塞 3.6s（`after.some` 退化成 O(N²)）。
    const hint = mergeHint(b, after)
    removed.push(hint ? { line: b.line, text: factText(b.raw), mergedInto: hint } : { line: b.line, text: factText(b.raw) })
  }
  return { removed, total, beforeLines: before.length, afterLines: after.length }
}

/**
 * 整条归档时「这条记忆承载了哪些事实」。
 *
 * 归档不是改写 —— 没有对照面可言，整个条目都从活动记忆里消失了。
 * 所以这里列的是**这条记忆自己写下的每一条事实**（不含 frontmatter 的分隔线与标题行），
 * 让人一眼看完「我丢了什么」，而不是只看到一句「已归档 1 条」。
 *
 * @param {string} text — 归档前的正文
 * @returns {{title:string, facts:{line:number,text:string}[], total:number}}
 */
export function entryFacts(text) {
  const lines = factLines(text)
  let title = ''
  const facts = []
  let total = 0
  for (const l of lines) {
    // 标题行单独拿出来当小标题，不重复进事实列表。
    if (!title && /^\s*#\s+/.test(l.raw)) {
      title = factText(l.raw.replace(/^\s*#\s+/, ''))
      continue
    }
    // frontmatter 的键值行不当作事实（它是元数据）。值里可能带正文性质的信息
    // （description），但那是「这条记忆是什么」的一句话，不是它承载的事实。
    if (/^\s*(?:---|name|description|metadata|aliases|type|node_type|updated|baseline|originSessionId)\s*:/.test(l.raw)) continue
    if (/^\s*---\s*$/.test(l.raw)) continue
    if (l.key.length < MIN_FACT_CHARS) continue
    total += 1
    if (facts.length < FACTS_PER_FILE) facts.push({ line: l.line, text: factText(l.raw) })
  }
  return { title, facts, total }
}

/**
 * 把「被删事实」按整份声明的总预算收拢。
 *
 * @param {{file:string, kind:'rewrite'|'archive', removed:{line:number,text:string}[], total:number, beforeLines?:number, afterLines?:number, title?:string}[]} groups
 * @returns {{shown:typeof groups, omittedGroups:number, omittedFacts:number, chars:number}}
 */
export function budgetFactGroups(groups) {
  const shown = []
  let chars = 0
  let omittedGroups = 0
  let omittedFacts = 0
  for (const g of groups) {
    const cost = g.removed.reduce((n, f) => n + f.text.length + 24, 0) + 80
    // 第一组总是显示：整节一条都出不来，等于这个功能没做。
    if (shown.length > 0 && chars + cost > FACTS_TOTAL_MAX) {
      omittedGroups += 1
      omittedFacts += g.total
      continue
    }
    chars += cost
    shown.push(g)
  }
  return { shown, omittedGroups, omittedFacts, chars }
}
