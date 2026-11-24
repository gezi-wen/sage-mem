/**
 * 提醒档位的**会话内记忆** —— 只在进程内存里，不落盘、不跨会话、不参与持久化。
 *
 * ## 为什么按 session 而不是按 agent
 *
 * 一个 agent 可以在会话之间切换（`agent.session` 会变），而「这次会话已经提醒到
 * 哪一档」讲的是会话的事实。按 agent 记会在切换会话时把旧账带过去，于是新会话
 * 永远收不到第一条提醒 —— 这种 bug 不报错，只是静默少了一条。
 *
 * ## 为什么用 WeakMap
 *
 * 会话对象被回收时账也该跟着走。用普通 Map 会攒住已经结束的会话，长跑进程里
 * 一直涨 —— 而这个插件的寿命与宿主进程一样长。
 *
 * ## 为什么 `armTier('urge')` 连 `warn` 一起标
 *
 * 一步吃掉很多 token 时会从「没到预警线」直接跨到触发线附近。此时只发 `urge`
 * （更紧急的那条已经把话说全），但若不把 `warn` 也标上，下一次判定会在同一条
 * 会话里补发一条「预警」—— 两档的说辞几乎一样，两条连着发只是噪音。
 */

const STATES = new WeakMap()

/**
 * 取（或建）一个会话的提醒账。
 *
 * @param {object} session
 * @returns {{armed: Set<'warn'|'urge'>}}
 */
export function stateOf(session) {
  let st = STATES.get(session)
  if (st === undefined) {
    st = { armed: new Set() }
    STATES.set(session, st)
  }
  return st
}

/** 这一档在本会话里发过没有。 */
export function isArmed(session, tier) {
  return stateOf(session).armed.has(tier)
}

/**
 * 记账：这一档已发。
 *
 * @param {object} session
 * @param {'warn'|'urge'|'after'} tier
 */
export function armTier(session, tier) {
  const { armed } = stateOf(session)
  armed.add(tier)
  // 跨档只发一条：发过 urge 就把 warn 一并标掉，免得下一步补一条重复话术。
  if (tier === 'urge') armed.add('warn')
}

/**
 * 压缩发生后重新武装（两档都清空）。
 *
 * 为什么压缩就要复位：压缩把上下文砍回低压力，之前「已经提醒过」的账对应的
 * 是**压缩前**的那一段历史。下一次逼近触发线时是新的危险，该说就得说。
 *
 * @param {object} session
 */
export function resetSession(session) {
  const st = STATES.get(session)
  if (st !== undefined) st.armed.clear()
}

/** 测试用：把某个会话的账彻底丢掉（不影响别人）。 */
export function forgetSession(session) {
  STATES.delete(session)
}
