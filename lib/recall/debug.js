/**
 * 注入链的调试出口（1.2.0 从 `lib/index.js` 原样搬出）。
 *
 * `SAGE_MEM_DEBUG=1` 才出声的一行结构化 JSON：候选数 / 命中数 / 逐条得分 /
 * 入选与真注入的文件名 / 注入字符数 / 被会话预算挡掉几条。它回答的是
 * 「这条记忆为什么没被召回」——一个光看上下文永远查不出的问题。
 *
 * ⚠️ **不开时零输出、零额外开销**：每个调用点都先 `if (debugEnabled())`，
 * 不成立时连 payload 对象都不会被构造出来。
 *
 * 为什么开关是**每次现读**而不是模块级常量：原来是常量，靠「测试里用 query 重载
 * `lib/index.js` 重新求值」来切换；1.2.0 把它拆成独立模块后，重载 index.js 不会重载
 * 它，常量就永远停在旧值（`test/access-test.mjs` 第 4 组当场变红）。现读一次环境变量
 * 的成本可以忽略，而它换来了「运行时也能打开调试」这个更诚实的行为。
 */
export function debugEnabled() {
  return process.env.SAGE_MEM_DEBUG === '1'
}

export function debugRecall(payload) {
  if (!debugEnabled()) return
  console.log(`[sage-mem] recall ${JSON.stringify(payload)}`)
}
