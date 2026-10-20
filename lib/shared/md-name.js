/**
 * 「合法 .md 文件名」的**唯一**判据（零依赖，host 与 manifest 共用）。
 *
 * 为什么单独一个文件：这条规则原先有 5 份实现（`memory/naming.js` 的 safeName、
 * 设置页的 rawName、`setSettings` 里手写一遍、`config.js` 的 readExtraReserved 过滤、
 * `typert.host.js` 的 fileNameSchema 正则）。它们**不是复制粘贴这么简单**：
 * 有一份漏了 `i`、有一份少了 `:` 判定，于是同一份"能过的名字"在不同入口得到相反结论。
 * 判据必须只有一份，平台相关的例外必须写成显式规则。
 *
 * 三条平台无关的底线（全部有事故来源）：
 *   - `/` 与 `\\` 一律拒：Windows 当路径分隔符、Linux 不当，判据不能依赖 path.sep；
 *   - `:` 一律拒：NTFS 交替数据流（`MEMORY.md:evil.md` 能过扩展名判据却写到隐藏流）；
 *   - 扩展名大小写不敏感：文件系统（NTFS/APFS）就是如此，`a.MD` 必须与 `a.md` 同宽。
 */
export const MD_NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]+\.md$/i
export const MD_NAME_PATTERN = MD_NAME_RE.source

/** 单段、`.md` 结尾、无路径分隔符 / 冒号 / 控制字符。**不含**保留名判定。 */
export function isPlainMdName(raw) {
  return typeof raw === 'string' && raw !== '' && MD_NAME_RE.test(raw)
}

/** 索引与流水的规范名（小写）。它们不是"某条记忆"，但多处要按名字识别。 */
export const INDEX_FILE_KEY = 'memory.md'
export const SESSION_LOG_KEY = 'session-log.md'
