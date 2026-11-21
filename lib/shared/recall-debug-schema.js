/**
 * 注入调试账的结果形状（2026-11-22 从 `typert.host.js` 拆出）。
 *
 * 为什么单独一份：`typert.host.js` 有 1160 行那条守卫（契约面不许无限膨胀）。2.15.11 补
 * `gated` / `validitySuppressed` 时又贴顶，按 D47 的口径「先想能不能挪走」——把这一族纯形状
 * 挪出来，invocation 声明仍留在 `typert.host.js`。
 *
 * 依赖方向：只依赖 zod。
 */
import { z } from 'zod'

/** 一条打分（文件 + 分数）。 */
export const recallDebugScoreSchema = z.object({
  'file': z.string().readonly(),
  'score': z.number().readonly(),
}).readonly()

/**
 * 一步装配的调试记录。
 *
 * `gated` 与 `validitySuppressed` 是「这条记忆为什么没进来」的两个主要线索：
 * 前者把「同题同目录没重算」与「算过了但没东西可给」分开（两者 `outcome` 都是 `empty`），
 * 后者列出被失效 / 待裁决矛盾挡掉的条目。
 */
export const recallDebugRecordSchema = z.object({
  'at': z.number().readonly(),
  'sessionId': z.string().readonly(),
  'query': z.string().readonly(),
  // injected | card-only | empty：这一步到底注进去了什么
  'outcome': z.string().readonly(),
  'deduped': z.boolean().readonly(),
  'baseline': z.number().readonly(),
  'scanned': z.number().readonly(),
  'hits': z.number().readonly(),
  'scores': z.array(recallDebugScoreSchema).readonly(),
  'body': z.array(recallDebugScoreSchema).readonly(),
  'picked': z.array(z.string()).readonly(),
  'injected': z.array(z.string()).readonly(),
  // chars = 这一步正文；sessionChars = 本代累计；cardChars = 这一步的卡
  'chars': z.number().readonly(),
  'sessionChars': z.number().readonly(),
  'cardChars': z.number().readonly(),
  'skippedByBudget': z.number().readonly(),
  'card': z.string().readonly(),
  'gated': z.boolean().readonly().optional(),
  // ⚠️ 2.15.11 定为可选：有的分支（短路、早期返回）不带这个键，写成必填会让整条调用被判坏 ——
  // 那正是这一族 bug 的形态。
  'validitySuppressed': z.array(z.object({
    'file': z.string().readonly(),
    'reason': z.string().readonly(),
    'label': z.string().readonly(),
    'conflictId': z.string().readonly().optional(),
  }).readonly()).readonly().optional(),
}).readonly()

/** 开关关着时 records 是空数组、enabled 是 false —— 面板据此不显示入口。 */
export const recallDebugResultSchema = z.object({
  'enabled': z.boolean().readonly(),
  'records': z.array(recallDebugRecordSchema).readonly(),
}).readonly()
