/**
 * 会话级注入状态的持有者（1.2.0 从 `lib/index.js` 原样搬出）。
 *
 * 一处持有、一处提交：`begin()` 只读并处理代次，`commit()` 一次写回。
 * 为什么提交放最后：中途抛错时状态不该前进 —— 没注进去的东西不能记成「已注过」，
 * 否则一次失败会把这条记忆永久挡在门外。唯一的例外是代次变化：那是**已经发生的事实**
 * （上下文真的被压缩了），必须在算任何东西之前生效，否则这一步会拿着上一代的账做判断。
 *
 * ── 2.1.14（外部审查 Q08）：两本账拆开 ─────────────────────────────────
 * 旧实现只有一个 `messageCount`，记的是「上一次**见效**时的条数」，只有真正提交才前进。
 * 于是被去重 / 零命中 / 预算拒绝的那些轮次从不更新它 —— 2 条时注入过、涨到 20 条被去重、
 * 压缩到 10 条再问时，压缩判定拿 10 比的是 2（投递账），不是 20（刚观测到的实况），
 * 判不出压缩，签名没清，继续去重、不注入。
 *
 * 现在两本账：
 *   - `lastObservedMessageCount`：**每次 assemble 都推进**（观测是既成事实，与是否投递无关）；
 *   - `messageCount`（delivered 账）：只有成功投递才前进。
 * 压缩判定只看观测账；`begin()` 会在返回前把观测写回状态，所以「不提交的轮次」也不会丢。
 *
 * ⚠️ 诚实边界（作者已声明，本版不越界）：压缩信号是「消息条数下降」这条启发式，它
 * **覆盖不了条数不降的压缩**（宿主原地改写历史，或截断后又在同一步补足条数）。那种情况下
 * 这里看不出代次变化，记忆仍会被去重挡住。要真正解决得等宿主给出可比的上下文代次标识。
 */
export function createSessionInjectState(maxSessions = 64) {
  const sessions = new Map()
  const fresh = () => ({
    signature: null,      // 已注入过的检索签名（问题 + 命中文件集）
    contentBytes: 0,      // 本代正文累计字节
    cardBytes: 0,         // 本代状态卡累计字节（与正文分账，见 config.js）
    cardSig: '',          // 本代已发过的那张卡（含检查点句柄的合成文本）
    gapCard: '',          // 本代渲染过的缺口卡正文（签名没变时沿用，避免换个数字重发）
    lastObservedMessageCount: -1, // 上一次 assemble **观测到**的消息条数（压缩判据的唯一基点）
    messageCount: -1,     // 上一次**成功投递**时的消息条数（delivered 账，只有 commit 推进）
    baselineDone: false,  // 本代是否已经给过 baseline
  })
  return {
    /**
     * 处理代次变化，取回本会话这一代的起点。**必须在算正文与控制提示之前调用。**
     * 返回值是一份快照 —— 调用方只读，写回统一走 `commit()`。
     *
     * ⚠️ 与旧实现不同：这里会**立刻**把观测到的条数写回状态。观测是已经发生的事实，
     * 而「去重 / 零命中 / 预算拒绝」的轮次不会调用 `commit()` —— 不在这里落账，
     * 下一次 begin 就还拿着旧基数比（Q08）。
     */
    begin(key, messageCount) {
      const prev = sessions.get(key)
      const observed = Number.isFinite(messageCount) ? messageCount : -1
      // 压缩判据对着**观测账**比，不是对着上一次投递比。
      const generationChanged = !!prev && observed >= 0 && prev.lastObservedMessageCount >= 0 &&
        observed < prev.lastObservedMessageCount
      // 条数下降 → 除了观测基点，四样东西一起归零。少清任何一样都会留下一个「上一代的真相」：
      // 字节账残留 → 新内容注不进来；baseline 残留 → 它再也不出现；
      // 卡签名残留 → 恢复入口永久失效；投递账残留 → 调试/诊断把旧代当新代。
      const base = generationChanged ? fresh() : { ...(prev ?? fresh()) }
      base.lastObservedMessageCount = observed
      sessions.set(key, base)
      // 只 begin 不提交的会话（全程被去重）也会进 Map —— 长驻宿主里必须同样按 FIFO 收敛。
      if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value)
      return { ...base, generationChanged }
    },
    /**
     * 一次写回。只防长驻进程无限增长：被挤掉的老会话下次醒来至多把同一批记忆再注一次。
     *
     * 合并（而不是整体替换）是刻意的：`begin()` 刚写下的观测账必须留在状态里 ——
     * 调用方只回传投递账（签名 / 字节 / 卡 / baseline），不该关心、也不该覆盖观测账。
     */
    commit(key, next) {
      const prev = sessions.get(key) ?? fresh()
      sessions.set(key, { ...prev, ...(next && typeof next === 'object' ? next : {}) })
      // FIFO 而不是 LRU：Map 重写已存在的键不会挪动位置，与旧行为一致。
      if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value)
    },
  }
}
