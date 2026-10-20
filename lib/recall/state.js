/**
 * 会话级注入状态的持有者（1.2.0 从 `lib/index.js` 原样搬出）。
 *
 * 一处持有、一处提交：`begin()` 只读并处理代次，`commit()` 一次写回。
 * 为什么提交放最后：中途抛错时状态不该前进 —— 没注进去的东西不能记成「已注过」，
 * 否则一次失败会把这条记忆永久挡在门外。唯一的例外是代次变化：那是**已经发生的事实**
 * （上下文真的被压缩了），必须在算任何东西之前生效，否则这一步会拿着上一代的账做判断。
 *
 * ⚠️ 诚实边界：压缩信号是「消息条数下降」这条启发式，它**覆盖不了条数不降的压缩**
 * （宿主原地改写历史，或截断后又在同一步补足条数）。那种情况下这里看不出代次变化，
 * 记忆仍会被去重挡住。要真正解决得等宿主给出可比的上下文代次标识（目前没有）。
 */
export function createSessionInjectState(maxSessions = 64) {
  const sessions = new Map()
  const fresh = () => ({
    signature: null,      // 已注入过的检索签名（问题 + 命中文件集）
    contentBytes: 0,      // 本代正文累计字节
    cardBytes: 0,         // 本代状态卡累计字节（与正文分账，见 config.js）
    cardSig: '',          // 本代已发过的那张卡（含检查点句柄的合成文本）
    gapCard: '',          // 本代渲染过的缺口卡正文（签名没变时沿用，避免换个数字重发）
    messageCount: -1,     // 上一次见效时的消息条数（压缩判据）
    baselineDone: false,  // 本代是否已经给过 baseline
  })
  return {
    /**
     * 处理代次变化，取回本会话这一代的起点。**必须在算正文与控制提示之前调用。**
     * 返回值是一份快照 —— 调用方只读，写回统一走 `commit()`。
     */
    begin(key, messageCount) {
      const prev = sessions.get(key)
      const generationChanged = !!prev && messageCount < prev.messageCount
      // 条数下降 → 四样东西一起归零。少清任何一样都会留下一个「上一代的真相」：
      // 字节账残留 → 新内容注不进来；baseline 残留 → 它再也不出现；
      // 卡签名残留 → 恢复入口永久失效。
      if (generationChanged) sessions.set(key, { ...fresh(), messageCount })
      const cur = sessions.get(key) ?? fresh()
      return { ...cur, generationChanged }
    },
    /** 一次写回。只防长驻进程无限增长：被挤掉的老会话下次醒来至多把同一批记忆再注一次。 */
    commit(key, next) {
      sessions.set(key, { ...next })
      // FIFO 而不是 LRU：Map 重写已存在的键不会挪动位置，与旧行为一致。
      if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value)
    },
  }
}
