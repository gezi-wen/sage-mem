/**
 * sage-mem 业务错误码的**唯一清单**（2026-11-03 归一，2.2.0）。
 *
 * 为什么要有它：`code` 曾经同时存在三套命名法 ——
 *   - snake_case：`io_error` / `not_found` / `stale_version`
 *   - kebab-case：`not-found` / `move-failed` / `lock-table-unknown`
 *   - UPPER：`UNVERIFIED_OVERWRITE` / `FLOOD`
 * 更糟的是**同一概念两个值并存**：`not_found`（reader）与 `not-found`（archive）、
 * `too_big` 与 `too-big`。消费方只能两边都匹配，漏一边就是静默的错误分支
 * （`client/50-shared-ui.js` 的 code → i18n 映射表就踩过）。
 *
 * 现在：**业务码一律 snake_case，且必须在本文件登记**。
 * `test/code-registry-test.mjs` 盯着两件事：
 *   1. `lib/**` 里出现的 `code:` 字面量必须在 `CODES` 里；
 *   2. 清单里不许出现 kebab-case。
 *
 * ⚠️ **不在本清单的三类码，不要往这里加：**
 *   - **Node errno**：`ENOENT` / `EEXIST` / `EIO` / `EACCES` …——不是我们的命名空间，
 *     它们来自 `node:fs`，我们只是判读。
 *   - **宿主的码**：`FS_SANDBOX_DENIED` / `FS_STALE_VERSION`——我们在解读 DSH 的文件沙箱
 *     与版本闸，改名等于假装自己拥有它。
 *   - **`Error.code`**：`SAGE_MEM_UNVERIFIED_OVERWRITE` / `LOCK_TABLE_UNKNOWN`——
 *     挂在**异常对象**上而非返回值里，保留 UPPER 前缀是为了与 errno 区分（`error.code`
 *     和 `result.code` 是两个命名空间，别合并）。
 */

/** 全部业务码。值的唯一合法拼写就是键名。 */
export const CODES = Object.freeze({
  // ── 读 / 扫描 ──
  missing: 'missing',
  not_found: 'not_found',
  denied: 'denied',
  symlink: 'symlink',
  stat_failed: 'stat_failed',
  not_file: 'not_file',
  not_dir: 'not_dir',
  too_big: 'too_big',
  malformed: 'malformed',
  // ── 写 ──
  invalid: 'invalid',
  invalid_transition: 'invalid_transition',
  io_error: 'io_error',
  changed: 'changed',
  stale_version: 'stale_version',
  revision_changed: 'revision_changed',
  unsupported: 'unsupported',
  exists: 'exists',
  // ── 归档 ──
  not_archived: 'not_archived',
  move_failed: 'move_failed',
  target_exists: 'target_exists',
  delete_failed: 'delete_failed',
  restore_failed: 'restore_failed',
  invalid_name: 'invalid_name',
  reserved: 'reserved',
  locked: 'locked',
  lock_unknown: 'lock_unknown',
  lock_table_unknown: 'lock_table_unknown',
  unverified_overwrite: 'unverified_overwrite',
  // ── 其它 ──
  memory_unavailable: 'memory_unavailable',
  flood: 'flood',
})

/** 值集合（判据用）。 */
export const CODE_VALUES = new Set(Object.keys(CODES))

/** 这个 code 是不是登记过的业务码。 */
export function isKnownCode(value) {
  return typeof value === 'string' && CODE_VALUES.has(value)
}
