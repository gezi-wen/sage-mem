/**
 * autodream —— 「被删事实」的探测端（宿主侧，会碰文件系统）。
 *
 * `facts.js` 只管**怎么比、怎么列**（纯函数，好单测）。这里管**怎么读、怎么装进 change**：
 *   1. 从真实文件取正文，且走与读工具同一条句柄读取入口（外部审查 2026-10-31 N03）——
 *      声明会被人看到，里面引用的原文不能来自目录外。
 *   2. 把比对结果整理成一条 `change` 的附加字段，让 `tools.js` 那边只留一句展开。
 *
 * **为什么单独一个文件**：`tools.js` 有一条 1100 行的体积守卫（`test/structure-test.mjs`），
 * 这条护栏防的是「往工具执行器里塞逻辑」。声明功能加了几十行就把它顶爆了 ——
 * 于是把「读 + 组装」搬出来，而不是把护栏改松。这种时候改护栏等于把唯一的门拆了。
 */

import { inspectMemoryEntry, readVerified } from '../memory/scan.js'
import { diffRemovedFacts, entryFacts } from './facts.js'

/**
 * 读一份正文，只给「被删掉的事实」做对照用。
 *
 * 为什么不复用 `fileFingerprint` 顺带读回来的字节：它的返回值会**原样进 manifest.json**
 * 的 `before` / `after` 字段，多塞一份正文会把机读记录撑成两倍。
 *
 * 读不到就返回 `null` —— 声明里如实标「原文读不到」，绝不拿半份内容假装对比过。
 */
export async function readTextForFacts(full) {
  try {
    const gate = await inspectMemoryEntry(full)
    if (!gate.ok) return null
    return await readVerified(full, gate, 'utf8')
  } catch {
    return null
  }
}

/**
 * 改写（`write_memory`）：算出要被写进 change 的「被删事实」字段。
 *
 * @param {'create'|'update'} op — 新建没有对照面
 * @param {string|null} beforeText — 写之前的正文（读不到是 null）
 * @param {string} afterText — 写进去的新正文
 * @returns {object} 直接展开进 `changeRecord` 的 extra；没删到东西时是空对象
 */
export function rewriteFactExtra(op, beforeText, afterText) {
  if (op !== 'update') return {}
  /**
   * 读不到旧正文时**必须留痕**：否则「这份声明没有列出被删事实」与「这一趟什么都没删」
   * 在纸上长得一模一样，而前者是「我们不知道」，后者是「我们知道没有」。
   */
  if (beforeText === null) return { removedUnavailable: true }
  const removed = diffRemovedFacts(beforeText, afterText)
  if (removed.total <= 0) return {}
  return {
    removedKind: 'rewrite',
    removedFacts: removed.removed,
    removedTotal: removed.total,
    linesBefore: removed.beforeLines,
    linesAfter: removed.afterLines,
  }
}

/**
 * 整条归档（`archive_memory`）：把这条记忆承载的事实列出来。
 *
 * 归档后它不再参与检索，那些事实对模型来说就等同于不存在了 —— 所以这里列的是
 * 「这条记忆自己写下的全部事实」，不是「和谁比少了几行」（归档没有对照面）。
 *
 * @param {string|null} beforeText — 归档前的正文
 * @returns {object} 直接展开进 `changeRecord` 的 extra
 */
export function archiveFactExtra(beforeText) {
  if (beforeText === null) return { removedUnavailable: true }
  const entry = entryFacts(beforeText)
  if (entry.total <= 0) return {}
  return {
    removedKind: 'archive',
    removedFacts: entry.facts,
    removedTotal: entry.total,
    entryTitle: entry.title,
  }
}
