/**
 * sage-mem 记忆层 —— 检索：双字打分、名额裁剪、baseline 排序、新鲜度换算。
 */

import { MAX_BASELINE, MAX_RESULTS } from './config.js'

/** 提取消息文本，兼容 content 为字符串或 text-block 数组两种形态。 */
export function extractText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

/** 提取双字（2-gram）集合，中英文数字通用。 */
export function bigrams(s) {
  const clean = String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

/** query 的双字在 text 中的覆盖率（0~1），作为相关性得分。 */
export function score(query, text) {
  const q = bigrams(query)
  if (q.size === 0) return 0
  const t = bigrams(text)
  let hit = 0
  for (const g of q) if (t.has(g)) hit++
  return hit / q.size
}

/**
 * 相关性打分只用 frontmatter 的 description + 文件名，不扫全文。
 *
 * 旧版拿 query 的双字去全文里找，得分是「覆盖率」，分母是 query，不惩罚
 * 文件长度 —— 越长的记忆越容易蒙中。实测：长记忆在全文匹配下对任何问题都能
 * 蒙中足量双字组，连寒暄问句都能注入上千 token；而真正该命中的那条反被
 * 挤掉。description 是「一句话说清这条是什么」的精准摘要，用它当检索
 * 信号，噪音大幅下降。
 */
export function selectRelevant(query, files) {
  return files
    .map(f => {
      // aliases 一并进检索面：它是专门为「换个说法也能命中」准备的字段。
      const aliasText = Array.isArray(f.aliases) && f.aliases.length ? ' ' + f.aliases.join(' ') : ''
      const hay = f.description + aliasText + ' ' + f.file.replace(/\.md$/, '').replace(/[_-]/g, ' ')
      return { ...f, score: score(query, hay) }
    })
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
}

/**
 * 选 baseline 条目：按显式 `baselinePriority` 排，不按文件名。
 *
 * 文件名排序等于让 `feedback_*` 无条件压过 `user_*`，与「哪条更该出现在每场
 * 会话开头」毫无关系。没写这个字段的老条目一律算 0，行为与从前一致。
 */
export function selectBaseline(files) {
  return files
    .filter(f => f.baseline)
    .sort((a, b) => (b.baselinePriority || 0) - (a.baselinePriority || 0) || a.file.localeCompare(b.file))
    .slice(0, MAX_BASELINE)
}

/**
 * 一条记忆「多久以前写下的」（整数天；null = 无从判断）。
 *
 * **优先 frontmatter 的 `updated`，缺失才回落文件 mtime —— 顺序不能反。**
 * 文件系统时间会被复制、checkout、备份还原整批改掉，它表示的是「这个文件什么时候
 * 被动过」，不是「这条记忆什么时候写的」。手写的时间戳才是权威。
 *
 * 未来日期（时钟偏差 / 手写错）一律当 0：宁可标「今天」也不要标负数。
 */
export function ageDays(f, nowMs) {
  const fromMeta = Date.parse(f?.updated || '')
  const base = Number.isFinite(fromMeta) ? fromMeta : (Number.isFinite(f?.mtimeMs) ? f.mtimeMs : NaN)
  if (!Number.isFinite(base)) return null
  const days = Math.floor((nowMs - base) / 86400000)
  return days > 0 ? days : 0
}
