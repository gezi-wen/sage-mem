/**
 * autodream 的挂载（1.2.0 从 `MemoryGateway` 构造函数原样搬出）。
 *
 * 整个包在 try 里：autodream 起不来（比如 timer 服务缺失、状态目录没权限）
 * 不该把 sage-mem 最核心的那件事——「记忆按问题注入」——一起拖死。
 * 这是本插件唯一一处「降级而不是失败」的设计，理由就在这里。
 */
import { warnLog } from '../memory/util.js'

/** @param {object} ctx @param {{AutodreamEngine:Function, AutodreamGateway:Function, memoryDir:string, sessionsRoot:string, reservedFiles:string[]}} deps */
export function mountAutodream(ctx, { AutodreamEngine, AutodreamGateway, memoryDir, sessionsRoot, reservedFiles }) {
  try {
    const engine = new AutodreamEngine(ctx, { memoryDir, sessionsRoot, reservedFiles })
    new AutodreamGateway(ctx, engine)
    engine.start()
    // 卸载时把定时器与锁收干净。effect 拿不到就交给 unref 兜底（不阻止进程退出）。
    if (typeof ctx.effect === 'function') ctx.effect(() => () => engine.dispose())
  } catch (err) {
    warnLog(ctx, `autodream 初始化失败（记忆本体不受影响）：${err?.message ?? err}`)
    // 异常路径额外打一行到 stderr：warnLog 走 ctx.logger，某些启动阶段它还没接上，
    // 而「autodream 静默不工作」正是最难查的那种故障（曾为此排查很久）。
    console.error('[sage-mem] autodream init failed:', err && err.stack ? err.stack : err)
  }
}
