/**
 * sage-mem 记忆层 —— 文件名归一与保留名判定（**唯一**的名字比较基准）。
 */

import { NON_ENTRY_FILES, RESERVED_FILES } from './config.js'
import { basename } from 'node:path'

/**
 * 文件名归一：只取单段文件名再小写。
 *
 * 这是**唯一**的名字比较基准（保留名、非条目名、扫描过滤全走它）。
 * 不能直接用原始字符串比：NTFS 不区分大小写，`memory.md` 与 `MEMORY.md`
 * 是同一个文件；`basename` 还顺手挡掉 `..\..\MEMORY.md` 这类带目录成分的输入。
 */
export function nameKey(raw) {
  return basename(String(raw ?? '')).toLowerCase()
}

/** 是否是保留名（写/删一律拒绝）。大小写不敏感。 */
export function isReserved(raw) {
  return RESERVED_FILES.has(nameKey(raw))
}

/** 是否是非记忆条目（索引与流水）：列出/检索/星图/读写全部排除。大小写不敏感。 */
export function isNonEntry(raw) {
  return NON_ENTRY_FILES.has(nameKey(raw))
}

/** 目录扫描过滤：这个名字算不算一条记忆条目。 */
export function isMemoryEntry(name) {
  return /\.md$/i.test(String(name ?? '')) && !isNonEntry(name)
}

/**
 * 唯一的路径校验函数（防穿越 + 扩展名 + 排除非记忆条目）。
 *
 * MemoryGateway.readFile / StarmapGateway.readFile 都走这里，不再各写一套
 * —— 旧版 starmap 那套内联校验只排除了 'MEMORY.md'（大小写敏感）且**完全不排除
 * session-log.md**，于是 `starmap.readFile('session-log.md')` 能把整份流水
 * 整个拉进浏览器。
 *
 * 不复用 nameKey 的原因：这里要保留磁盘上的原始大小写（返回值直接 join 进路径）。
 * @param raw — 调用方传来的文件名（任意值）
 * @returns 通过校验的原始文件名；非法返回 null
 */
export function safeName(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  // basename 与原文不一致＝含目录成分。旧版是「悄悄取 basename 继续」，
  // 与 starmap 那套（要求 safe === raw）行为不一致；现在统一为拒绝。
  if (basename(raw) !== raw) return null
  if (!/\.md$/i.test(raw)) return null
  if (isNonEntry(raw)) return null
  return raw
}
