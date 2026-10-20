/**
 * 写入门（版本守卫）的挂载（1.2.0 从构造函数原样搬出）。
 *
 * 实测（`scripts/events-probe.mjs`，本机 headless，2026-10-15）：这两个事件**只对
 * 「工具发起」的写入**触发 —— 模型调内置 `write` / `edit` 打到记忆文件时会走这里；
 * 而**插件自己**调 `ctx.fs.writeText` 时一次都不发（实测 0 次），那条路由调用方自己传
 * `expected`（见 `lib/autodream/tools.js` 的 `writeMemoryText`）。
 * 监听器**不需要声明 inject** 也能收到，所以这里不挂子 fiber。
 *
 * 它买到的东西：**模型的 `write` 没法在一个记忆文件被改过之后静默覆盖它** ——
 * 守卫过不了，宿主会以 `FS_STALE_VERSION` 明确拒绝（实测确实会被拒）。
 * 这属于「把静默的坏结果变成显式的失败」，不是「阻止写入」：这个事件**没有拒绝动作**，
 * 我们也不发明一个（见 write-gate.js 的头注释）。
 *
 * 单槽纪律：返回 `undefined` 才是「不管」。目录外**必须**返回 undefined，否则会占掉槽位、
 * 影响整块盘的写入（write-gate.js 的 `outside_memory` 判在 `caller_wins` 之前正是为此）。
 *
 * ⚠️⚠️ **本函数必须在 `apply()` 里被直接调用，绝不能挪进 `ctx.inject(['fs'], …)`，也不能给
 * 插件加 `static inject = ['fs']`。** 这不是风格偏好，是实测出来的硬约束：
 * 这两个事件有一个**注册窗口**，窗口在 fs 服务就绪**之前**就关了。
 *   不 inject、apply 里直接挂     → 收到 1 次 ✅
 *   顶层 `inject:['fs']`           → **0 次**
 *   顶层 `inject:['tokenMeter']`   → **0 次**（与 fs 无关，是时机问题）
 *   `ctx.inject(['fs'], sub)` 子 fiber → **0 次**
 *   不 inject、但 apply 之后 2.5 秒再挂 → **0 次**（晚挂收不到）
 * 证据：`scripts/host-facts-probe.mjs` 的七组对照 + `docs/host-facts.md` 3.3 节。
 * 之所以特别标注：**按 D5 的规范直觉（可选服务要用 ctx.inject 挂子 fiber）改这里，
 * 会让写门静默失效** —— 编译得过、测试可能也过，只是永远不触发。
 * 而我们**不需要** inject：实测不声明 inject 时，处理器**内部** `ctx.get('fs')` 照样拿得到服务
 * （`{hasFs:true, hasStat:true}`），取版本就靠它。
 */
import { memoryPathOf } from '../memory/paths.js'
import { decideEditGuard, decideWriteIntent } from '../memory/write-gate.js'

/**
 * 探目标的当前版本。**区分「不存在」与「不知道」**。
 *
 * 这个区分不是洁癖：`!!info` 会把「拿不到 fs 服务」也写成 `exists:false`，判定表据此给
 * `createIfAbsent` —— 而目标**其实是存在的**记忆文件时，那是一次**误拦**（写入必然失败，
 * 模型收到一句看不懂的错误）。拿不准就不干涉，比猜一个安全。
 */
function makeProbeTarget(ctx) {
  return async (target) => {
    try {
      const fs = typeof ctx.get === 'function' ? ctx.get('fs') : undefined
      if (!fs || typeof fs.stat !== 'function' || !target) return { known: false }
      const info = await fs.stat(target)
      return { known: true, exists: !!info, version: info?.version ?? null }
    } catch {
      return { known: false }
    }
  }
}

export function mountWriteGate(ctx, memoryDir) {
  const probeTarget = makeProbeTarget(ctx)
  try {
    if (typeof ctx.on === 'function') {
      // 公共骨架：**先判位置、再决定要不要碰链子**。
      //
      // ⚠️ 三条纪律（都是踩出来的）：
      //   1. **目录外连 `next()` 都不调**。宿主对**任何**工具写入都发这个事件（实测：写一个
      //      临时文件也发），无条件调 next() + stat 等于给整个系统的每次写文件都加一次系统调用，
      //      而我们本来就什么都不该做。直接 `return next()` 把决策权原样交出去。
      //   2. **一旦调了 `next()`，就必须把它给的东西交回去**。`next()` 返回的是下游（或调用方
      //      自己）已经做出的决定；此时再 `return undefined` 会把这个决定**丢掉** ——
      //      我们本想「不干涉」，实际却比干涉还糟。
      //   3. **探不到版本就不碰**（见 probeTarget）：把「不知道」当「不存在」会误拦真实存在的文件。
      const gateEvent = (decide) => async (target, actor, next) => {
        try {
          const memoryPath = memoryPathOf(target?.displayPath, memoryDir)
          if (!memoryPath.ok) return typeof next === 'function' ? next() : undefined
          const caller = typeof next === 'function' ? await next() : undefined
          const probed = await probeTarget(target)
          if (!probed.known) return caller
          const chosen = decide({
            memoryPath,
            exists: probed.exists,
            version: probed.version,
            caller,
          })
          // 我们给出决定就用我们的；决定不了（undefined）就把 `caller` 原样交回去，不吞。
          return chosen === undefined ? caller : chosen
        } catch {
          return undefined /* 写门在宿主的写入链路上：抛出去会把一次正常写入炸掉 */
        }
      }
      ctx.on('fs/write-intent', gateEvent((facts) => decideWriteIntent(facts).intent))
      ctx.on('fs/edit-intent', gateEvent((facts) => decideEditGuard(facts).guard))
    }
  } catch { /* 老宿主没有这两个事件：写入按宿主默认语义走 */ }
}
