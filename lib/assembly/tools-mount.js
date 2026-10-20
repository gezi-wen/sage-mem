/**
 * 检索工具（`search_memory` / `read_memory`）的挂载（1.2.0 从构造函数原样搬出）。
 *
 * 工具是否注册成功。拿不到宿主的 `tools` 服务时为 false —— 状态卡据此换文案：
 * 有工具就教它「用 search_memory 搜」，没有就退回「直接读记忆目录」。
 *
 * 为什么是个可变量：注册是**异步就绪**的（`ctx.inject` 要等依赖服务上线），而注入链
 * 每步都跑 —— 前几步可能还没就绪、后几步才就绪，这是正常的。
 * 因此返回 `{ ready: () => boolean }` 而不是一个布尔值：值拷贝会让注入链永远读到 false。
 *
 * ⚠️ **用 `ctx.inject` 挂子 fiber，绝不给本类加 `static inject = ['tools']`。**
 * 理由（`docs/decisions.md` D5，有官方依据）：`inject` 是**硬依赖** —— 声明了它的插件
 * 要等依赖就绪才会被加载。宿主没有 `tools` 服务时，整个 sage-mem 会一直待机，
 * **记忆注入跟着一起消失**。而工具只是锦上添花，不值得拿核心功能去换。
 * `ctx.inject` 只让这个子回调等依赖就绪，主插件照常工作；依赖永远不来就只有它不生效。
 *
 * 另一条实测事实（`docs/host-facts.md`）：不声明 inject 时 `ctx.get('tools')` 只给
 * `undefined`（那一刻服务还没被提供，而插件不会重跑），所以「先探测再注册」在这里
 * 是行不通的 —— 必须走 `ctx.inject`。
 */
import { createMemoryTools } from '../tools/memory-tools.js'
import { warnLog } from '../memory/util.js'

export function mountMemoryTools(ctx) {
  const state = { ready: false }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (inner) => {
        try {
          const { searchMemory, readMemory } = createMemoryTools(ctx)
          inner.tools.register(searchMemory)
          inner.tools.register(readMemory)
          state.ready = true
        } catch (err) {
          // 注册失败 ≠ 注入失败。出声一次，然后什么也不做。
          warnLog(ctx, `检索工具注册失败（记忆注入不受影响）：${err?.message ?? err}`)
        }
      })
    }
  } catch (err) {
    warnLog(ctx, `检索工具挂载失败（记忆注入不受影响）：${err?.message ?? err}`)
  }
  return { ready: () => state.ready }
}
