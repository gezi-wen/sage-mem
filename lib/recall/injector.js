/**
 * 注入链的编排骨架（1.2.0 从 `MemoryGateway` 构造函数里整段搬出）。
 *
 * 为什么搬：这段逻辑（约 350 行）以前是构造函数的闭包 —— 想测「压缩后 baseline 会不会
 * 重来」「正文池满了卡还能不能发」这类分支，只能先搭一个万能 Proxy ctx 再
 * `new MemoryGateway(ctx)`，测的其实是「组合根能不能被构造」。
 * 现在它是一等函数：`createRecallInjector({ ctx, state, tools })` 返回监听器，
 * 而选材 / 渲染 / 预算三段各自是纯函数（`select.js` / `compose.js` / `text.js`）。
 *
 * 行为由 `test/recall-golden-test.mjs` 的 11 个场景逐字节守 —— 这个文件里任何一行
 * 改动如果影响了注入文本，golden 会红，不是「测试太紧」。
 *
 * ⚠️ 两条历史坑（搬动时注释与代码必须一起搬，拆开就会重犯）：
 *   1. 只取 `source.kind === 'user'` 的消息 —— DSH 0.1.5 起注入与工具结果也存成 role:'user'；
 *   2. 代次处理（`state.begin`）必须在算正文与控制提示**之前**，否则压缩后会拿上一代的账去判重（复审 R03）。
 */
import { MEMORY_DIR, RECALL_DISCIPLINE, STATE_ROOT, validityEnabled } from '../memory/config.js'
import { listConflictIndex } from '../memory/conflicts.js'
import { buildContradictionFileSet, buildExpirySet } from '../memory/validity.js'
import { extractText } from '../memory/retrieval.js'
import { scanMemoryFiles } from '../memory/scan.js'
import { readCheckpoint } from '../memory/checkpoint.js'
import { warnLog } from '../memory/util.js'
import { selectRecall, dedupeByFile } from './select.js'
import { buildCandidates, composeDelivery, composeStatus } from './compose.js'
import { composeRecallText } from './text.js'
import { debugEnabled, debugRecall, recordInjection } from './debug.js'

/**
 * 2.0.1：调试账里「被有效性挡掉」的两类理由（2.0.0 新引入的抑制）。
 *
 * ⚠️ **只收这两个**：`below_floor` / `budget_omitted` 等老理由在 2.0.0 之前就有，
 * 它们的解释已经在面板的「预算挡掉 N 条」与得分列表里；而失效与未裁决矛盾是
 * 2.0.0 让记忆**从正文里消失**的唯一原因 —— 不单列出来，用户与维护侧都只能靠
 * 猜「这条到底是没检索到，还是被新规则挡住了」。
 */
const VALIDITY_SUPPRESS_REASONS = new Set(['expired_source', 'conflict_pending'])

/** reason → 面板上的一句人话（英文由 client 侧字典决定，这里只给稳定键）。 */
const VALIDITY_REASON_LABEL = Object.freeze({
  expired_source: '已失效',
  conflict_pending: '待裁决矛盾',
})

/**
 * 从 `decideDelivery` 的逐条处置里挑出被有效性挡掉的，附上文件名、理由与（可选）冲突 id。
 *
 * 纯函数，给调试账用；**不影响注入结果** —— items 是决策的产物，这里只是把其中
 * 两类 reason 摘出来。`conflictIds` 是「文件名 → 冲突记录 id」的映射：同一份文件被
 * 多条记录牵扯时取第一条（按 `listConflictIndex` 的时间倒序），够定位就行。
 */
function validitySuppressedItems(items, conflictIds) {
  const out = []
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !VALIDITY_SUPPRESS_REASONS.has(it.reason)) continue
    const row = { file: String(it.file ?? ''), reason: it.reason, label: VALIDITY_REASON_LABEL[it.reason] }
    if (it.reason === 'conflict_pending' && conflictIds instanceof Map) {
      const id = conflictIds.get(row.file)
      if (id) row.conflictId = id
    }
    out.push(row)
  }
  return out
}

/**
 * @param {object} deps
 * @param {object} deps.ctx — 宿主 ctx（`scanMemoryFiles` / `warnLog` 用）
 * @param {object} deps.state — `createSessionInjectState()` 的实例
 * @param {{ready: () => boolean}} deps.tools — 检索工具是否注册就绪（异步就绪，每步读一次）
 * @param {(session: object) => string} [deps.taskIdOf] — 任务 id 取值（检查点用）
 * @returns {(assembly: object, context: object, next: Function) => Promise<object>}
 */
export function createRecallInjector({ ctx, state, tools, taskIdOf }) {
  const resolveTaskId = typeof taskIdOf === 'function'
    ? taskIdOf
    // 任务 id：`SAGE_MEM_TASK_ID` 优先（给「跨会话的同一条任务」用），否则用 session id。
    // **绝不用查询文本自定作用域** —— 那句话是模型或用户写的，不该决定去读哪个目录。
    : (session) => process.env.SAGE_MEM_TASK_ID || session?.id || ''

  // 按问题检索注入：system-prompt/assemble 是异步 waterfall，监听器可 await。
  // 从 agent.session 拿当前 user message，扫 memory 目录按摘要匹配选相关
  // 文件，读全文作为动态 context 段注入——让 agent 第一轮就「想起」。
  return async function recallInjection(assembly, context, next) {
    const assembled = await next()
    // session id 在 try 外先取好：catch 里也要能带上它（拿到什么带什么）。
    const sessionId = context?.agent?.session?.id ?? ''
    try {
      const agent = context?.agent
      const session = agent?.session
      if (!session) return assembled
      // DSH 0.1.7 起 Session 的历史读取接口在陆续调整（snapshotEvents / eventAt /
      // ownEvents 已弃用）。deriveMessages 在 0.1.7-rc.1 实测仍在且仍同步，但这三行
      // 不是白写的：方法一旦被改名或改成异步，老写法要么静默不注入、要么把 Promise
      // 当数组展开成空。宁可日志里响一声，也不要"记忆不注入但日志一字没有"。
      if (typeof session.deriveMessages !== 'function') {
        warnLog(ctx, 'session.deriveMessages() 不可用 —— 记忆召回已跳过（DSH session API 变了？）', sessionId)
        return assembled
      }
      const derived = session.deriveMessages()
      const messages = [...(derived && typeof derived.then === 'function' ? await derived : derived)]

      // 关键：DSH 0.1.5 把工具结果（source.kind === 'tool'）和注入内容
      // （source.kind === 'plugin'）也存成 role: 'user' 的消息。只按 role 取
      // 「最后一条」会取到 tool-result，extractText 得到空串，下面的长度检查
      // 直接返回——表现就是全程静默不注入。只有 source.kind === 'user' 是真人输入。
      const userMessages = messages.filter(m => m?.role === 'user' && m?.source?.kind === 'user')
      const text = extractText(userMessages[userMessages.length - 1]?.content)

      const files = await scanMemoryFiles(ctx, sessionId)

      // ── 代次：**先处理状态转换，再算正文与控制提示** ──
      // 压缩 / 清空（消息条数下降）在这一行里就让签名、两本账、卡签名、baseline 标记
      // 一起归零。放到后面（比如去重之后再算）就等于「拿上一代的账本判这一代」——
      // 复审 R03 的「同题压缩后仍被挡住」正是这么来的。
      const ledgerKey = session.id || 'no-session-id'
      const st = state.begin(ledgerKey, messages.length)

      const { picked, baselineTaken, relevant, intentInfo, bodyRanked, bestChunk, selected, signature, deduped } =
        selectRecall({ text, files, st })

      // ⚠️ 这里**不能**再写「picked 为空就返回」：检查点句柄与未命中提示都不依赖候选，
      // 提前返回会让它们在「目录为空」或「零命中」时永远不可达（复审 R02）。
      // 统一的出口在下面 —— 只有**正文与控制提示都为空**才返回。

      const nowMs = Date.now()
      // ── 2.0.0：有效性过滤与矛盾抑制的真实集合 ──────────────────────────
      // 两件事分开算：失效看**记忆自己的 frontmatter**（事实来源），矛盾看冲突队列
      // （待办 + 审计）。队列读不动时**不抑制**、只留日志 —— 抑制是「少给点内容」，
      // 拿一个读失败去换「记忆消失」不划算（D27）。
      //
      // ⚠️ 只对 `contradiction` 进集合：写失败型记录里盘上那份仍是现行内容（§6.3）。
      let conflictsForDelivery = new Set()
      let pendingConflicts = 0
      // 2.0.1：调试账用的「文件名 → 冲突记录 id」。只在开关打开时才读得到，但先按需
      // 建一份空 Map（代价可忽略，比在 makeDebug 里为了 id 再扫一次队列便宜）。
      const conflictIdByFile = new Map()
      const validity = validityEnabled()
      const expired = validity ? buildExpirySet(files, nowMs) : new Set()
      if (validity) {
        try {
          // 用**摘要索引**（不带两份正文、进程内缓存 1 秒）：100 条记录时 `listConflicts`
          // 单次实测 p50 78 ms，而它每一步 assemble 都会被调一次（见 conflicts.js 的缓存注释）。
          const listed = await listConflictIndex({ stateRoot: STATE_ROOT })
          if (listed.ok) {
            conflictsForDelivery = buildContradictionFileSet(listed.items)
            for (const c of listed.items) {
              if (!c || c.status !== 'open' || c.kind !== 'contradiction') continue
              for (const key of ['file', 'otherFile']) {
                const name = typeof c[key] === 'string' ? c[key].trim() : ''
                if (name !== '' && !conflictIdByFile.has(name)) conflictIdByFile.set(name, c.id)
              }
            }
            pendingConflicts = listed.items.filter((c) => c.status === 'open' && c.kind === 'contradiction').length
          } else {
            warnLog(ctx, `读冲突队列失败，本轮不做矛盾抑制：${listed.error ?? listed.code}`, sessionId)
          }
        } catch (err) {
          warnLog(ctx, `读冲突队列异常，本轮不做矛盾抑制：${err?.message ?? err}`, sessionId)
        }
      }
      const candidates = buildCandidates({ picked, bestChunk, nowMs })

      // ── 单会话累计预算：**拆成两本账** ──
      //   正文池 = CONTENT_BUDGET（总上限 − 状态卡预留）／卡池 = STATUS_RESERVE
      // 拆的理由见 config.js：到顶之后旧行为是一个字都不注、连「为什么没注、还能怎么查」
      // 都没有；而那个上限是**本插件自己定的**，完全可以给状态卡留一份固定额度。
      // 账记在 session id 上；picked 里 baseline 永远排在检索结果之前，所以预算不够时
      // 先被挤掉的是「更晚才想起来的」那些 —— baseline 有优先权。
      // 起点来自 `begin()`：它可能刚因压缩把两本账连同卡签名一起归零过。
      const delivered = composeDelivery({
        candidates,
        text,
        intent: intentInfo.intent,
        contentBytes: st.contentBytes,
        nowMs,
        conflicts: conflictsForDelivery,
        expired,
      })
      const { parts, injectedFiles, skippedForBudget, contentBytes } = delivered

      // ── 任务检查点：压缩后的恢复入口 ──
      // 宿主**什么时候**压缩上下文，插件控制不了 —— 所以这里**不承诺「压缩前保存」**，
      // 只保证「存在检查点就给一条短句柄」。压缩后两本账与卡的签名会一起归零，
      // 句柄因此会重新出现，这就是恢复路径（而不是靠某个压缩前钩子）。
      const taskId = resolveTaskId(session)
      let checkpointLine = ''
      try {
        const cp = taskId ? await readCheckpoint(taskId, { stateRoot: STATE_ROOT }) : null
        if (cp?.ok && cp.handle) checkpointLine = cp.handle
      } catch { /* 读不到检查点就当没有：它是可选的接力棒，不是必需件 */ }

      const bodySearched = typeof text === 'string' && text.length >= 4
      const status = composeStatus({
        files, selected, bodyRanked, bodySearched, text, parts, injectedFiles, skippedForBudget,
        deduped, st, toolsReady: tools.ready(), checkpointLine, memoryDir: MEMORY_DIR,
        intentHistoryDependent: intentInfo.historyDependent,
        pendingConflicts,
      })
      const { cardBody, cardPart } = status

      // ── 调试账（1.7.0）────────────────────────────────────────────────
      // 控制台一行 JSON 与面板「工具 → 注入调试」共用这一份 payload。
      // **只在开关打开时才构造 payload**：关着的时候 makeDebug 返回 null，payload
      // 与缓冲记录都不会被建出来（零开销）；debugEnabled() 每次现读，与 debug.js 同一条。
      //
      // 口径（面板上照此措辞，别让人误读）：
      //   - `chars` = **这一步**真进正文的字节（不含状态卡、不含历史累计）；
      //   - `sessionChars` = 本代累计正文字节（预算账）；
      //   - `cardChars` = 这一步发出去的状态卡字节（没发就是 0）；
      //   - `deduped` = 同题同命中集刚注过，这一步没重复追加 —— 面板上要解释成
      //     「不是坏了，是去重生效」，否则每轮多步里大部分账看着都是空的；
      //   - `validitySuppressed`（2.0.1）= 被 2.0.0 的有效性规则挡在正文外的条目，
      //     带 `reason`（expired_source / conflict_pending）与 `label`；矛盾还带
      //     `conflictId`，便于去「冲突」页签定位。**这不是检索失败**，是规则生效。
      const debugOn = debugEnabled()
      const makeDebug = debugOn
        ? (outcome) => ({
            at: nowMs,
            sessionId,
            query: typeof text === 'string' ? text.slice(0, 160) : '',
            outcome,
            deduped,
            baseline: baselineTaken,
            scanned: files.length,
            hits: relevant.length,
            scores: relevant.map(f => ({ file: f.file, score: Number(f.score.toFixed(4)) })),
            body: dedupeByFile(bodyRanked).slice(0, 5).map(h => ({ file: h.file, score: Number((h.score ?? 0).toFixed(4)) })),
            picked: picked.map(f => f.file),
            injected: injectedFiles,
            chars: Math.max(0, contentBytes - st.contentBytes),
            sessionChars: contentBytes,
            cardChars: cardPart ? Buffer.byteLength(cardPart, 'utf8') : 0,
            skippedByBudget: skippedForBudget,
            validitySuppressed: validitySuppressedItems(delivered.delivery.items, conflictIdByFile),
            card: cardPart ? 'sent' : (status.cardText ? 'deduped-or-over-budget' : 'none'),
          })
        : () => null
      const emitDebug = (payload) => {
        if (!payload) return
        debugRecall(payload)
        recordInjection(payload)
      }

      // 正文与卡都没有 → 一个字都不注。注意这与旧行为不同：旧行为「正文池满」就到此为止，
      // 现在只要卡池还有额度就会发出卡（说清范围、缺口与下一步动作）。
      if (parts.length === 0 && !cardPart) {
        emitDebug(makeDebug('empty'))
        return assembled
      }

      // 状态一次写回：签名、两本账、卡签名、缺口卡、条数、baseline 标记。
      // 放在这里（而不是更早）是刻意的 —— 上面每一步都可能没真注进去东西，
      // 那就不该让状态前进；一次失败把一条记忆永久挡在门外是最难查的一种。
      state.commit(ledgerKey, {
        signature,
        contentBytes,
        cardBytes: status.cardBytes,
        cardSig: status.cardSig,
        gapCard: cardBody,
        messageCount: messages.length,
        baselineDone: st.baselineDone || baselineTaken > 0,
      })

      emitDebug(makeDebug(parts.length > 0 ? 'injected' : 'card-only'))

      const recallText = composeRecallText({
        parts,
        cardPart,
        memoryDir: MEMORY_DIR,
        discipline: RECALL_DISCIPLINE,
      })

      return {
        ...assembled,
        contexts: [...(assembled.contexts ?? []), {
          name: 'sage-mem:recall',
          order: 1000,
          text: recallText,
        }],
      }
    } catch (err) {
      // 这是整条注入链的外壳。裸吞的代价就是 :174-193 记的那个坑：权限错、编码坏、
      // frontmatter 正则哪天不匹配，表现都是「插件在、但记忆不再注入」，日志一字没有。
      // 现在只降级（返回未注入的 assembly），但一定留痕。
      warnLog(ctx, `recall injection failed: ${err?.message ?? err}`, sessionId)
      return assembled
    }
  }
}
