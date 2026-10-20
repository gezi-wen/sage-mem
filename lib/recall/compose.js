/**
 * 注入链的**渲染与预算**阶段（1.2.0 从 `lib/index.js` 原样搬出）。
 *
 * 三段，每段都能单独测（`test/recall-unit-test.mjs`）：
 *   - `buildCandidates`：只负责「每条候选长什么样」；
 *   - `composeDelivery`：只负责「在正文预算内该给哪几条」（`decideDelivery` 是纯函数）；
 *   - `composeStatus`：只负责「缺口卡 / 检查点句柄该不该说、还能不能说」。
 *
 * 两件事分开是 v0.9.17 的教训：预算、渲染、去重挤在一个循环里时，谁也说不清
 * 某条为什么没进去。
 */
import { CONTENT_BUDGET, MAX_CHARS_PER_FILE, STALE_DAYS, STATUS_RESERVE } from '../memory/config.js'
import { ageDays } from '../memory/retrieval.js'
import { decideDelivery } from '../memory/deliver.js'
import { renderStatusCard } from '../memory/status.js'
import { recordAccess } from '../memory/access.js'
import { dedupeByFile } from './select.js'

/** 把候选文件渲染成「要不要端上去」的条目（不含预算决策）。 */
export function buildCandidates({ picked, bestChunk, nowMs = Date.now() }) {
  const candidates = []
  for (const f of picked) {
    // **baseline 不吃段落替换**：它的语义是「这条记忆每场会话都该完整在场」
    // （你是谁、待办清单）。一旦用户的问句碰巧命中它，替换成单个段落就等于
    // 把「完整在场」偷偷降级成「命中在场」—— 那正是 baseline 要防的事。
    const chunk = f.baseline ? null : bestChunk.get(f.file)
    // 命中段落优先；没有命中（baseline、或 query 太短没做正文检索）才回到「文件开头」。
    // 旧写法对**任何**问题都端同一段开头，等于把「命中在哪」这个信息扔掉了。
    const raw = chunk ? chunk.text : f.content
    const body = raw.length > MAX_CHARS_PER_FILE
      ? raw.slice(0, MAX_CHARS_PER_FILE) + '\n…（截断）'
      : raw
    const days = ageDays(f, nowMs)
    const stamp = days !== null && days >= STALE_DAYS ? `（保存于 ${days} 天前）` : ''
    // 段落命中时补两样东西：
    //   - 行号：模型据此能直接用文件工具跳过去核对来源，「引用可核对」靠它成立；
    //   - 摘要：段落本身不含 frontmatter，补回「这一段是从哪条记忆里切出来的」。
    const loc = chunk ? `:${chunk.startLine}-${chunk.endLine}` : ''
    const brief = chunk && f.description ? ` · ${f.description.slice(0, 80)}` : ''
    candidates.push({
      file: f.file,
      id: chunk?.id ?? `${f.file}#head`,
      revision: chunk?.revision ?? '',
      score: f.score ?? 0,
      baseline: f.baseline === true,
      lines: chunk ? [chunk.startLine, chunk.endLine] : null,
      title: f.description || '',
      text: `### ${f.file}${loc}${stamp}${brief}\n${body}`,
    })
  }
  return candidates
}

/**
 * 展示层决策 + 记账。
 *
 * 按**实际进正文的字节**记账，而不是 `delivery.totals` —— 后者含指针的额度，
 * 而指针没有真的进上下文。两本账要对得上，就不能把没花出去的钱记进去。
 */
export function composeDelivery({ candidates, text, intent, contentBytes, nowMs = Date.now() }) {
  const delivery = decideDelivery(candidates, {
    intent,
    // ⚠️ 这里**故意传空集**：按 revision 抑制重复对「同一份文件的不同段落」太粗 ——
    // 换一个问题往往会命中同一份文件的**另一段**，按文件级 revision 抑制会把新相关
    // 的那段一起挡掉。要启用它得先用「段落身份」而不是「文件 revision」做键，
    // 并且单独评测一次。这条记在 docs/decisions.md 的 D15，不是遗漏。
    visibleRevisions: new Set(),
    scopeDenied: new Set(),
    conflicts: new Set(),
    expired: new Set(),
    needle: text ? text.slice(0, 40) : '',
  }, { bytes: Math.max(0, CONTENT_BUDGET - contentBytes) })

  const parts = []
  const injectedFiles = []
  let skippedForBudget = 0
  for (const item of delivery.items) {
    if (item.kind === 'snippet') {
      parts.push(item.text)
      injectedFiles.push(item.file)
    } else {
      // pointer / suppress / unresolved 都**不进正文**。
      // 「被省略几条」这件事由下面的状态卡统一说，正文里再逐条列一行
      // `### 某某.md（未展开）` 是重复的信息，还白占上下文 —— 卡片本来就带着
      // 「最佳线索 + 一个可做的动作」。
      skippedForBudget++
    }
  }
  // 进上下文的这些才算「被用过」—— 台账是自动归档阈值的唯一数据源，记错一步阈值就偏。
  // recordAccess 同步、绝不抛：台账的问题不许升级成注入失败。
  recordAccess(injectedFiles, nowMs)

  const contentBytesNext = contentBytes + parts.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0)
  return { delivery, parts, injectedFiles, skippedForBudget, contentBytes: contentBytesNext }
}

/**
 * 缺口状态卡 + 检查点句柄（共用卡池）。
 *
 * 返回 `{ cardBody, cardText, cardPart, cardSig, cardBytes }`：
 *   - `cardBody` 要原样写回状态（签名没变时下一步沿用它，避免换个数字重发）；
 *   - `cardPart` 是这一步真正要发出去的文本（'' 表示不发）。
 */
export function composeStatus({
  files, selected, bodyRanked, bodySearched, text, parts, injectedFiles, skippedForBudget,
  deduped, st, toolsReady, checkpointLine, memoryDir, intentHistoryDependent,
}) {
  // ── 缺口状态卡 ──
  // 它**替换**原来那行状态文字，不是额外追加：同一件事不说两遍。
  // 卡池与正文池互不借用 —— 正文满了照样发得出卡，这正是预留的意义（见 config.js）。
  const bodyOnly = bodySearched ? dedupeByFile(bodyRanked) : []
  const unread = Math.max(0, selected.length - injectedFiles.length)
  // 最佳线索取「正文命中里第一条没被注进去的」——那正是模型下一步最该去读的东西。
  const beacon = bodyOnly.find(h => !injectedFiles.includes(h.file)) ?? bodyOnly[0] ?? null
  // 什么时候该说话：
  //   - **有真缺口**（有候选没读、或有候选被预算省略）→ 说；
  //   - **没有缺口也没有命中** → 只在「用户这句话在问自己的历史」时说。
  // 后者是计划里点名的一条：没有历史依赖时不要插「你可能遗漏记忆」，否则提示
  // 每轮都出现，等真有缺口时它已经被当噪音忽略了。
  const gapExists = unread > 0 || skippedForBudget > 0

  const wantCard = gapExists || intentHistoryDependent === true || !!checkpointLine
  // 签名没变时沿用上一步渲染好的那份缺口卡，而不是重渲染一张。
  // 两条理由：其一，那一步与这一步的检索面**逐字相同**，缺口也相同，重渲染只会把
  // 同一件事换个数字再说一遍 —— 而局部变量算出来的数字还是错的（上一步注了 N 条，
  // 这一步按本轮 parts 算是 0 条）；其二，文本一变 `cardSig` 去重就失效，同一张语义
  // 的卡会被反复追加进会话。
  // 检查点句柄不在此列：它是可能刚刚才出现的接力棒，所以始终参与合成。
  const cardBody = !wantCard
    ? ''
    : deduped
      ? st.gapCard
      : renderStatusCard({
          scope: bodySearched ? 'all' : 'summary',
          scanned: files.length,
          injected: parts.length,
          omitted: skippedForBudget,
          unread,
          best: beacon ? { file: beacon.file, title: beacon.chunk?.title || beacon.chunk?.headingPath || '' } : null,
          needle: text ? text.slice(0, 40) : null,
          toolsAvailable: toolsReady,
          memoryDir,
        })
  // 句柄与卡**共用卡池**：它是同一个通道里的另一句提示，不该另开一份额度。
  const cardText = [cardBody, checkpointLine].filter(Boolean).join('\n')
  let cardPart = ''
  let cardSig = st.cardSig
  let cardBytes = st.cardBytes
  // 卡按**内容签名**去重：签名没变就不重复发。否则每一步都追加一张一模一样的卡，
  // 而每张卡都是落到会话里的持久消息 —— 那不叫提示，那叫刷屏。
  if (cardText && cardText !== cardSig) {
    const cardSize = Buffer.byteLength(cardText, 'utf8')
    if (cardBytes + cardSize <= STATUS_RESERVE) {
      cardBytes += cardSize
      cardPart = cardText
      cardSig = cardText
    }
  }
  return { cardBody, cardText, cardPart, cardSig, cardBytes }
}
