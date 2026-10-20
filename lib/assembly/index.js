/**
 * 组合根的四块挂载（1.2.0 的模块边界）。
 *
 * 每块一个文件、一个 `mountXxx(ctx, …)`：组合根的构造函数只负责按顺序调用它们。
 * 顺序是语义的一部分（autodream → 工具 → 观测 → 写门），所以这里按同一顺序再导出。
 *
 * ⚠️ `mountWriteGate` 必须**同步**调用（注册窗口在 fs 就绪之前就关），
 * 这条约束写在 `write-gate-mount.js` 头注里，并由 `write-gate-wiring-test.mjs` 第 7 组看着。
 */
export { mountAutodream } from './autodream-mount.js'
export { mountMemoryTools } from './tools-mount.js'
export { mountObserve } from './observe-mount.js'
export { mountWriteGate } from './write-gate-mount.js'
