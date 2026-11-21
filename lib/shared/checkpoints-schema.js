/**
 * 检查点聚合的结果形状（2.15.0 引入，2026-11-22 从 `typert.host.js` 拆出）。
 *
 * 为什么单独一份：`typert.host.js` 的行数线（1160）是「契约面不许无限膨胀」的守卫，
 * 2026-11-22 补残篇/诊断字段时正好贴顶（1162 行）。D47 已经写过一次「下次撞线先想
 * 能不能挪走」，这里按它执行：**只把这一族 schema 挪出来**，invocation 声明仍留在
 * `typert.host.js`（那一份是契约的索引面，拆开就找不到入口了）。
 *
 * 依赖方向：只依赖 zod，不 import 任何本仓库模块 —— 它是纯形状。
 */
import { z } from 'zod'

/** 一个任务检查点的「未完成」摘要。 */
export const checkpointTaskSchema = z.object({
  'taskId': z.string().readonly(),
  'project': z.string().readonly(),
  'revision': z.number().readonly(),
  'items': z.array(z.string().readonly()).readonly(),
}).readonly()

/**
 * `memory.checkpoints` 的结果。
 *
 * `truncated` 同时表达两种截断（任务数超上限 / 某任务条目超上限）；
 * `skipped` 是「读不出来被跳过」的任务数（2.15.2 起）。
 */
export const checkpointsResultSchema = z.object({
  'ok': z.boolean().readonly(),
  'truncated': z.boolean().readonly(),
  'tasks': z.array(checkpointTaskSchema).readonly(),
  'skipped': z.number().readonly().optional(),
  'error': z.string().readonly().optional(),
}).readonly()
