/**
 * 注入链的调试出口（1.2.0 从 `lib/index.js` 原样搬出；1.7.0 起兼作面板的数据源）。
 *
 * `SAGE_MEM_DEBUG=1` 才出声的一行结构化 JSON，并把同一份 payload 记进进程内的
 * 环形缓冲，供面板「工具 → 注入调试」读。它回答的是「这条记忆为什么没被召回」
 * ——一个光看上下文永远查不出的问题。
 *
 * ⚠️ **不开时零输出、零开销**：每个调用点都先 `if (debugEnabled())`，
 * 不成立时连 payload 对象都不会被构造出来，更不会进缓冲。
 *
 * ⚠️ **绝不落盘**：缓冲只在进程内存里（最多 `MAX_DEBUG_RECORDS` 条），重启即空。
 * 调试信息不是记忆，不该写进用户的记忆目录或状态目录 —— 1.7.0 的验收里有一条
 * 「跑完注入后记忆目录/状态目录逐字节不变」在盯着这件事。
 *
 * 为什么开关是**每次现读**而不是模块级常量：原来是常量，靠「测试里用 query 重载
 * `lib/index.js` 重新求值」来切换；1.2.0 把它拆成独立模块后，重载 index.js 不会重载
 * 它，常量就永远停在旧值（`test/access-test.mjs` 第 4 组当场变红）。现读一次环境变量
 * 的成本可以忽略，而它换来了「运行时也能打开调试」这个更诚实的行为。
 */

/** 面板里最多看几次注入尝试。每步 assemble 都会尝试一次，8 条约等于一轮多步。 */
export const MAX_DEBUG_RECORDS = 8

/**
 * 最近几次注入尝试（**旧 → 新**）。
 *
 * 模块级单例：一个进程一个插件事例，环形缓冲天然是全局的。记录里带 sessionId，
 * 多会话混在一起时面板按时间倒序展示。
 */
const records = []

export function debugEnabled() {
  return process.env.SAGE_MEM_DEBUG === '1'
}

export function debugRecall(payload) {
  if (!debugEnabled()) return
  console.log(`[sage-mem] recall ${JSON.stringify(payload)}`)
}

/**
 * 记一次注入尝试（调用点已确认 `debugEnabled()` 成立）。
 *
 * ⚠️ 存**副本**：payload 里的数组是现构造的，但调用方之后若再改它们，
 * 面板读到的就不该跟着变 —— 一份账记下来就是那一刻的事实。
 */
export function recordInjection(payload) {
  records.push(JSON.parse(JSON.stringify(payload)))
  if (records.length > MAX_DEBUG_RECORDS) {
    records.splice(0, records.length - MAX_DEBUG_RECORDS)
  }
}

/**
 * 面板读口：`{ enabled, records }`，**最新在前**。
 *
 * 关着开关时也返回 `{ enabled: false, records: [] }`（缓冲里本来就不该有东西）；
 * 面板据此决定「工具」抽屉里出不出现「注入调试」这一项。
 */
export function readRecallDebug() {
  // 深拷贝：调用方（面板 / 测试）拿到的必须是一份**独立的账** —— 改它不该改到内部
  // 缓冲（浅拷贝只拷数组，记录对象还是同一批引用，`records[0].query = …` 会污染）。
  return {
    enabled: debugEnabled(),
    records: records.slice().reverse().map((r) => JSON.parse(JSON.stringify(r))),
  }
}

/** 测试专用：清空缓冲（跨用例隔离；生产路径没有任何地方调它）。 */
export function resetRecallDebug() {
  records.length = 0
}
