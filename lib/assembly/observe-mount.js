/**
 * 「模型自己翻了记忆目录」的观测挂载（1.2.0 从构造函数原样搬出）。
 *
 * 宿主的 `tools/result` 把**每一次**工具调用的 `exec`（含 name / arguments）交给我们，
 * 于是「模型用内置 read/grep 读了哪份记忆」第一次变得可观测 —— 此前台账只记得下
 * 「插件注入了什么」，记不下「模型主动翻了什么」。
 *
 * 三条纪律：
 *   1. **只记能可靠判定的**（`observe.js` 认 read/grep/glob 的路径参数；`pwsh` 一律不认，
 *      那是**已知观测盲区** —— 不许把「看不到」说成「没读」）。
 *   2. **按 session × 文件去重**：翻页（read 的 offset 不同）不刷计数，那是同一个动作。
 *   3. **失败绝不影响任何东西**：观测是副产品，它的问题不许冒泡到工具调用链上。
 */
import { accessEventKey, classifyToolExecution, createDeduper } from '../memory/observe.js'
import { recordRead } from '../memory/access.js'

export function mountObserve(ctx, memoryDir) {
  const observedReads = createDeduper()
  try {
    ctx.on('tools/result', (exec) => {
      try {
        const cls = classifyToolExecution(exec?.name, exec?.arguments, memoryDir)
        if (cls.kind !== 'active_read' || !cls.file) return
        const key = accessEventKey({
          sessionId: exec?.agent?.id ?? '',
          file: cls.file,
          // revision 要读盘才算得出，这里拿不到 —— 所以去重粒度是「session × 文件」。
          // 写明这条口径，免得以后有人以为它按内容去重。
          revision: '',
          kind: cls.kind,
        })
        if (!key || !observedReads.shouldCount(key)) return
        recordRead(cls.file, '')
      } catch { /* 观测失败静默：它不该有任何存在感 */ }
    })
  } catch { /* 老宿主没有这个事件：不影响注入 */ }
}
