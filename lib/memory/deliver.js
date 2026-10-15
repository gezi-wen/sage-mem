/**
 * sage-mem 记忆层 —— 展示层：把「检索到的候选」落成「这次到底给什么」。
 *
 * 为什么单独一层：检索若顺手「因为模型读过就删候选」，「没找到」与「找到了但没展示」
 * 就成了同一个输出 —— 那是排查不了的那类故障。所以检索只负责排序与证据，
 * 由这里逐条给出可解释的处置（正文 / 指针 / 抑制 / 待裁决），并逐条记字节。
 *
 * 纯函数：不读盘、不看时钟、不改传入对象。调用方保证 `candidates` **已经过相关性门槛**，
 * 本模块不重算分数 —— 门槛那套判据只该有一个出处（`bm25.js` 的 evidence）。
 */

import { NO_SUPPRESS_INTENTS } from './intent.js'

/**
 * 「这几类意图绝不抑制重复正文」—— 用户在核实、更正、问依据，要的就是原文。
 *
 * ⚠️ 这份名单**只有一个出处**（`intent.js` 的 `NO_SUPPRESS_INTENTS`），本模块不保留副本：
 * 同一个业务概念写在两个文件里迟早会漂，而漂了的后果是「某一天显式核实请求被当成重复内容
 * 抑制掉」—— 正是要防的那个失败模式。展示层 `DELIVERY_REASONS` 里也有这三个词，
 * 但那只是**理由怎么命名**的词汇表，不是「谁不许被抑制」这份名单。
 */

/** 指针的记账字节 —— 指针也占上下文，不记账就等于假装它免费。 */
export const POINTER_BYTES = 90

/**
 * 展示理由枚举 —— 对外字段，必须稳定（面板、日志、评测都按它分类）。
 *
 * `no_relevant_hit` 不由本模块产出：候选为空时没有可供挂理由的条目，
 * 它留给调用方在「压根没有候选」那条路上使用。
 */
export const DELIVERY_REASONS = Object.freeze([
  'baseline',              // baseline 记忆：每场会话必给正文
  'explicit_recall',       // 用户在显式问历史 → 给正文，不抑制
  'evidence_missing',      // 摘要没覆盖、正文命中了 → 给正文
  'same_revision_visible', // 同 revision 的正文已在当前上下文 → 抑制重复
  'budget_omitted',        // 预算不够 → 给指针（不静默丢弃）
  'scope_denied',          // 作用域不允许
  'conflict_pending',      // 有未裁决冲突 → 不把任一方当定论
  'expired_source',        // 来源明确失效
  'below_floor',           // 没过相关性门槛（由调用方传入 alreadyFiltered 信息）
  'no_relevant_hit',       // 压根没有相关命中
])

/** 处置种类。`unresolved` 与 `suppress` 都不注入正文，但前者要留入口给歧义裁决。 */
export const DELIVERY_KINDS = Object.freeze(['snippet', 'pointer', 'suppress', 'unresolved'])

/**
 * 判断候选是否落在某个「按文件记账」的集合里。
 *
 * 为什么同时认 `file` 与 `id`：作用域拒绝、冲突、失效都是**按文件**标注的，
 * 但候选可能来自正文段落，调用方手里只有 chunk id。两种键都收，调用方不必先做映射。
 * Set 为主，容忍数组（调用方从 JSON 复原时常常是数组）。
 */
function hitsFileSet(setLike, cand) {
  const keys = [cand.file, cand.id].filter(v => typeof v === 'string' && v !== '')
  if (!keys.length || !setLike) return false
  if (typeof setLike.has === 'function') return keys.some(k => setLike.has(k))
  if (Array.isArray(setLike)) return keys.some(k => setLike.includes(k))
  return false
}

/** 同上，但按 revision 记账（`visibleRevisions`）。空 revision 不参与匹配 —— 缺值不该等于相等。 */
function hitsRevisionSet(setLike, revision) {
  if (typeof revision !== 'string' || revision === '' || !setLike) return false
  if (typeof setLike.has === 'function') return setLike.has(revision)
  if (Array.isArray(setLike)) return setLike.includes(revision)
  return false
}

/**
 * 候选身上可用的正文：`text` 优先，`excerpt` 兜底。
 *
 * 两者都是「检索层能给出的正文证据」，只是丰俭不同（全文 vs 200 字符片段）——
 * 降级发生在**数据**上，不发生在逻辑里：调用方拿得到全文就给全文，只拿得到片段就给片段。
 *
 * ⚠️ 这条兜底不是可选项：真实 wire shape（`search.toHit`）**根本不输出 `text`**，
 * 正文只以 `excerpt` 出现。若这里只认 `text`，「调用方忘了映射」的后果是普通轮次
 * **全量 below_floor**，而且没有任何外部信号 —— 状态卡会说「没有相关命中」，
 * 实际是找到了。展示层不该依赖调用方记得做映射。
 */
function bodyOf(cand) {
  if (typeof cand.text === 'string' && cand.text.length > 0) return cand.text
  if (typeof cand.excerpt === 'string' && cand.excerpt.length > 0) return cand.excerpt
  return ''
}

/**
 * UTF-8 字节数：中文一个字三个字节，用 `length` 记账会把额度算成三倍。
 */
function byteLen(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8')
}

/**
 * 决定每条候选怎么交付。
 *
 * 规则顺序即优先级，先判的赢（与 `DELIVERY_REASONS` 的注释顺序一致）：
 *   1. baseline → snippet（不受预算裁剪）
 *   2. scopeDenied → suppress
 *   3. expired → unresolved
 *   4. conflicts → unresolved（保留入口，不注入任一方正文）
 *   5. 同 revision 可见且意图非显式 → suppress
 *   6. 显式意图 → 有正文给 snippet（`text` 优先、`excerpt` 兜底）；两者都空 → pointer
 *   7. 有正文（同上：`text` 或只有 `excerpt`）→ snippet
 *   8. 预算放不下正文 → pointer（不静默丢弃）
 *   9. 其余 → suppress（below_floor）
 *
 * ⚠️ 规则 6/7 与规则 8 的关系（**这一层最容易被后人改坏的地方，改之前先读完这段**）：
 * 6/7 决定「这条**想要**正文」，规则 8 是它的**预算闸门**。若把规则 8 当成「先于 6/7 判」
 * 的一条独立规则，它就永远不可达（有正文的候选早在 7 就被定成 snippet 了），而那正好会让
 * 「预算不够」这种状态从输出里消失 —— 与「不静默丢弃」相悖。所以：想要正文 → 放得下给
 * snippet，放不下给 pointer。
 *
 * ⚠️ **显式意图不是特权通道**：那三类意图保证的是「不抑制」（用户在看原文、在更正、在问
 * 依据），**不是**「无视预算」。预算面前人人平等，否则 totals 的账就不守恒了。
 *
 * 预算语义：`budget.bytes` 是**含 baseline** 的正文总额度，baseline 从中扣除但自身永不降级；
 * 预算小到装不下 baseline 时，`totals.bytes` **允许超过** `budget.bytes` —— 超支如实暴露，
 * 不靠悄悄裁掉必给项来维持一个好看的数字。对此**调用方（`lib/index.js`）有责任为 baseline
 * 预留空间**：超支是在报告「调用方没留够」，不是本模块的静默行为。
 *
 * 指针**不参与**正文额度的竞争 —— 它是「给不起正文时留的入口」，若也扣额度，
 * 一条超长候选就能把后续候选全压成指针。
 *
 * 未传 / 非数字的 `budget.bytes` 按「不设限」处理：调用方漏传参数时，宁可多给正文，
 * 也不要静默把所有正文降级成指针（那是更难查的一种「记忆不再注入」）。
 *
 * items 顺序与输入顺序一致（调用方负责排序，本模块不重排 —— 重排会让「同一条候选
 * 在两次调用里被处置成不同种类」，反而更难解释）。
 *
 * @param {Array} candidates 每条：`{file, id, revision, score, title?, lines?, text?, baseline?}`
 * @param {object} ctx `{intent, visibleRevisions, scopeDenied, conflicts, expired, needle}`
 * @param {object} budget `{bytes}` 本次可用于正文的字节
 * @returns {{items: Array, totals: {bytes, injected, pointers, suppressed, unresolved}}}
 *   items 每项 `{file, id, revision, kind, reason, bytes, title, lines, text?}`；
 *   `text` 只在 kind 为 snippet 时出现（其余处置不带正文，避免消费方误注入）。
 */
export function decideDelivery(candidates, ctx = {}, budget = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const c = ctx ?? {}
  const intent = String(c.intent ?? '')
  const explicit = NO_SUPPRESS_INTENTS.includes(intent)
  const rawBudget = Number(budget?.bytes)
  let remaining = Number.isFinite(rawBudget) ? Math.max(0, rawBudget) : Infinity

  const items = []
  const totals = { bytes: 0, injected: 0, pointers: 0, suppressed: 0, unresolved: 0 }

  for (const cand of list) {
    // 非对象候选直接跳过：展示层不该因为调用方混进一个 null 就把整批候选丢掉。
    if (!cand || typeof cand !== 'object') continue

    const revision = String(cand.revision ?? '')
    const title = String(cand.title ?? '')
    const lines = Array.isArray(cand.lines) ? [...cand.lines] : null
    let kind = 'suppress'
    let reason = 'below_floor'
    let bytes = 0
    let text

    if (cand.baseline === true) {
      // 规则 1：baseline 永远给正文，不因预算降级（它的额度由调用方在总额度里预留）。
      kind = 'snippet'
      reason = 'baseline'
      text = String(cand.text ?? '')
      bytes = byteLen(text)
      remaining -= bytes
    } else if (hitsFileSet(c.scopeDenied, cand)) {
      kind = 'suppress'
      reason = 'scope_denied'
    } else if (hitsFileSet(c.expired, cand)) {
      kind = 'unresolved'
      reason = 'expired_source'
    } else if (hitsFileSet(c.conflicts, cand)) {
      // 规则 4：有未裁决冲突时两端都不当定论 —— 这里**不给正文**，只留入口。
      kind = 'unresolved'
      reason = 'conflict_pending'
    } else if (!explicit && hitsRevisionSet(c.visibleRevisions, revision)) {
      kind = 'suppress'
      reason = 'same_revision_visible'
    } else {
      // 规则 6/7/8/9 共用这一段：先看「这条手上有没有可端的正文」，
      // 再决定给正文、给指针还是不说话。
      const body = bodyOf(cand)
      if (!body) {
        // 规则 6 的空集出口：显式意图只留入口（reason 记它为什么被端出来），
        // 不产出 `text:''` 的空 snippet。规则 9：意图不指向历史又没有正文，占位不如不说话。
        kind = explicit ? 'pointer' : 'suppress'
        reason = explicit ? 'explicit_recall' : 'below_floor'
        bytes = explicit ? POINTER_BYTES : 0
      } else if (byteLen(body) <= remaining) {
        kind = 'snippet'
        reason = explicit ? 'explicit_recall' : 'evidence_missing'
        text = body
        bytes = byteLen(body)
        remaining -= bytes
      } else {
        // 规则 8：降级成指针，reason 如实写 budget_omitted —— 消费方能看出
        // 「这条不是不相关，是这次给不起」。
        kind = 'pointer'
        reason = 'budget_omitted'
        bytes = POINTER_BYTES
      }
    }

    const item = { file: String(cand.file ?? ''), id: String(cand.id ?? ''), revision, kind, reason, bytes, title, lines }
    if (kind === 'snippet') item.text = text ?? ''
    items.push(item)

    if (kind === 'snippet') {
      totals.injected++
      totals.bytes += bytes
    } else if (kind === 'pointer') {
      totals.pointers++
      totals.bytes += bytes
    } else if (kind === 'unresolved') {
      totals.unresolved++
    } else {
      totals.suppressed++
    }
  }

  return { items, totals }
}
