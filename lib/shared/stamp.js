/**
 * 本地时间戳的**唯一**实现（零依赖）。
 *
 * 原先三份：`memory/scan.js` 的 localStamp、`autodream/util.js` 的 stampHuman、
 * `autodream/tools.js` 里那行与注释挤在一起的 localStamp。三份输出必须逐字相同 ——
 * 它们都会写进**记忆文件本身**（archived_at）或报告，差一个补零规则就是数据不一致。
 *
 * 一律本地时间：这是给人看的（"什么时候归档的"），不是机器间传输的 ISO 时间。
 */

/** `YYYY-MM-DD` —— 只要日期的场合（提示词里的「今天是」）。 */
export function stampDate(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** `YYYY-MM-DD HH:mm` —— 给人看（归档留痕、报告列表）。 */
export function stampHuman(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `YYYYMMDD-HHmmss` —— 给文件名用（快照目录 / 运行 id 的前半）。 */
export function stampCompact(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
