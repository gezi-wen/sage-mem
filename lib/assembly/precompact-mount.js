/**
 * 「压缩前记忆提醒」的挂载（2.17.0）。
 *
 * ## 接缝图（谁 import 谁，单向）
 *
 *     memory/experimental.js   开关边界与生效值（唯一定义处）
 *     memory/util.js           warnLog
 *            ↑
 *     precompact/policy.js     纯判据：触发线 / 两档线 / 该发哪档（零 IO、零 import）
 *     precompact/text.js       纯文案（import policy 的 fmtTokens / pct）
 *     precompact/state.js      会话账（WeakMap，无 IO）
 *            ↑
 *     assembly/precompact-mount.js   ← 本文件：只接线，不写业务判据
 *            ↑
 *     assembly/index.js        barrel
 *     index.js                 构造函数里一行调用
 *
 * 判据只有 `policy.js` 一份、文案只有 `text.js` 一份、账只有 `state.js` 一份；
 * 本文件除了「取数 → 问判据 → 交文案 → 造消息」之外不做别的。
 *
 * ## 为什么 `{ prepend: true }`
 *
 * 压缩就发生在 `agent/pre-step` 的同一条 waterfall 里（`dsh-compaction-basic`
 * 的监听器）。`prepend` 把我们排到**它前面**，于是 `next()` 之前拿到的是
 * **压缩前**的真实压力。排在后面就只能看到压缩后的低压力 —— 那时提醒已经没有
 * 意义（要写的细节刚被砍掉）。这是整套设计成立的前提，不是性能优化。
 *
 * ## 为什么要两个监听器
 *
 * 一个测压提醒（pre-step），一个复位（session 事件里的 `compaction/start`）。
 * 少了后者，一条长会话只会在头一次逼近触发线时提醒，之后再也不会 —— 因为账
 * 一直挂着。压缩把压力砍回去了，账也该跟着清。
 *
 * ## 失败纪律
 *
 * 这是锦上添花的功能：任何异常都必须**回到 `next()` 的原有结果**上，绝不因为
 * 提醒出问题而让某一步走不动。每类异常只 warn 一次（`logOnce`），免得一条会话
 * 刷出几百行。
 */
import { randomUUID } from 'node:crypto'
import { EXPERIMENTAL_SPECS, liveExperimental } from '../memory/experimental.js'
import { warnLog } from '../memory/util.js'
import {
  decideTier,
  resolveLines,
  resolveThreshold,
  worthMeasuring,
} from '../precompact/policy.js'
import { armTier, isArmed, resetSession, stateOf } from '../precompact/state.js'
import {
  NUDGE_SOURCE_KIND,
  NUDGE_SUMMARY,
  renderAfterCompaction,
  renderNudge,
} from '../precompact/text.js'

/** 本插件注入的消息来源标识（会话里认它用）。 */
const SOURCE = Object.freeze({ kind: NUDGE_SOURCE_KIND, form: 'notice', summary: NUDGE_SUMMARY })

/**
 * 挂载压缩前提醒。
 *
 * @param {object} ctx — 宿主上下文
 * @param {{memoryDir: string}} opts — 记忆目录（文案里要写给人/模型看的那条路径）
 * @returns {{installed: boolean}} `installed:false` 表示宿主缺事件面，功能整体不生效
 */
export function mountPreCompact(ctx, { memoryDir }) {
  const seen = new Set()
  const logOnce = (key, msg) => {
    if (seen.has(key)) return
    seen.add(key)
    warnLog(ctx, msg)
  }

  /** 开关与提前量：每步现读，改完立刻生效（见 `experimental.js` 的运行期覆盖）。 */
  const readEnabled = () => Number(liveExperimental('preCompact')) > 0
  const readLeadPct = () => {
    const spec = EXPERIMENTAL_SPECS.preCompactLead
    const v = Math.round(Number(liveExperimental('preCompactLead')))
    // 边界只在 `EXPERIMENTAL_SPECS` 定义一处；这里只判「在不在里面」，不另编默认值。
    return Number.isFinite(v) && v >= spec.lo && v <= spec.hi ? v : spec.dflt
  }

  /**
   * 压缩**之前**的一次取样。返回 null 表示「本步不关心」。
   *
   * 顺序是按代价排的：开关 → 会话类型 → 窗口 → 便宜门槛 → measure → 精确线。
   * 绝大多数步数在前四步就返回了，`measure()`（O(surface)）只在压力过半时才跑。
   */
  function sampleBefore(agent) {
    const session = agent?.session
    if (!session) return null
    if (!readEnabled()) return null
    // 子代理不提醒：它的写入会污染主记忆，而且它通常活不过这一轮。
    if (session.header?.origin === 'subagent') return null
    const get = typeof ctx.get === 'function' ? (name) => ctx.get(name) : () => undefined
    const meter = get('tokenMeter')
    if (!meter || typeof meter.measure !== 'function' || typeof meter.contextPressure !== 'function') return null
    // `contextPressure` 是投影直读（便宜），`measure` 要重算整个 surface（O(surface)）。
    // 所以先用前者的 `pressureTokens` 过便宜门槛 —— 顺序反了的话门槛就白设了
    // （那正是这条测试第一次跑出来的失败：measure 被调了一次）。
    const { contextWindow, pressureTokens } = meter.contextPressure(session) ?? {}
    if (!(typeof contextWindow === 'number' && contextWindow > 0)) return null
    if (!worthMeasuring({ totalTokens: pressureTokens, contextWindow })) return null
    // 过了门槛才精确测一次。`pressureTokens` 只算 prompt 侧，可能低估 —— 所以用它
    // 只是省开销，真正的判定一律用这里的 `totalTokens`（与引擎同一个函数）。
    const totalTokens = meter.measure(session)?.totalTokens
    // 输出预留是触发线公式的一项。拿不到就**不猜** —— 猜错方向是「提醒晚于压缩」，
    // 而晚了就等于没提醒。首轮会话还拿不到 header 时压力也远未过半，实际不损失。
    const reservedTokens = session.requestHeader?.()?.config?.maxTokens
    if (!(typeof reservedTokens === 'number' && reservedTokens >= 0)) return null
    const compactConfig = get('compaction')?.config ?? {}
    const threshold = resolveThreshold({
      contextWindow,
      thresholdRatio: compactConfig.thresholdRatio,
      headroomTokens: compactConfig.headroomTokens,
      reservedTokens,
    })
    if (threshold === null) return null
    const lines = resolveLines({
      contextWindow,
      thresholdTokens: threshold.thresholdTokens,
      leadPct: readLeadPct(),
    })
    if (lines === null) return null
    return {
      session,
      totalTokens,
      contextWindow,
      enginePct: threshold.enginePct,
      lines,
      // surface 代次：`next()` 之后拿它对比，就知道这一步有没有真的压缩过。
      generation: session.surface?.replaceGeneration,
    }
  }

  /** 造一条 notice 级的用户消息（与 `dsh-time-context` / `dsh-repeat-tool-reminder` 同形）。 */
  function notice(text) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { ...SOURCE },
    }
  }

  /** 该发哪条文案（不注入就返回 null）。 */
  function textFor(before, compacted) {
    const { session } = before
    if (compacted) {
      // 本步就压了：细节已经没了，换成「要补记就现在，记不清就别编」。
      if (isArmed(session, 'after')) return null
      armTier(session, 'after')
      return renderAfterCompaction({ memoryDir })
    }
    const tier = decideTier({ totalTokens: before.totalTokens, lines: before.lines, armed: stateOf(session).armed })
    if (tier === null) return null
    armTier(session, tier)
    return renderNudge({
      tier,
      memoryDir,
      totalTokens: before.totalTokens,
      windowTokens: before.contextWindow,
      enginePct: before.enginePct,
    })
  }

  const onPreStep = async (payload, next) => {
    let before = null
    try {
      before = sampleBefore(payload?.agent)
    } catch (err) {
      logOnce('sample', `压缩前提醒：取样失败，本步跳过（${err?.message ?? err}）`)
      before = null
    }
    // 不关心就走人：不 await、不再算任何东西。
    if (before === null) return next()

    const decision = await next()
    try {
      if (decision?.kind === 'reject') return decision
      if (payload?.signal?.aborted) return decision
      // 异步边界之后 fiber 可能已经被销毁（`dsh-time-context` 同款守卫）。
      if (typeof ctx.fiber?.assertActive === 'function') ctx.fiber.assertActive()
      const compacted = before.session.surface?.replaceGeneration !== before.generation
      const text = textFor(before, compacted)
      if (text === null) return decision
      const messages = Array.isArray(decision?.messages) ? decision.messages : []
      return { ...decision, messages: [...messages, notice(text)] }
    } catch (err) {
      logOnce('emit', `压缩前提醒：注入失败，本步照常继续（${err?.message ?? err}）`)
      return decision
    }
  }

  const onSessionEvent = (session, event) => {
    try {
      if (event?.type !== 'compaction/start') return
      // 压缩把压力砍回去了：账也清掉，下一次逼近是新的危险。
      resetSession(session)
    } catch { /* 清账失败不该有任何存在感 */ }
  }

  let installed = false
  try {
    ctx.on('agent/pre-step', onPreStep, { prepend: true })
    ctx.on('session/event', onSessionEvent)
    installed = true
  } catch (err) {
    // 老宿主没有这两条事件面：功能整体不生效，但记忆注入照常。
    warnLog(ctx, `压缩前提醒挂载失败（记忆注入不受影响）：${err?.message ?? err}`)
  }
  return { installed }
}

/** 测试用：暴露消息来源标识，免得测试里另写一份字面量。 */
export const __testables = { SOURCE }
