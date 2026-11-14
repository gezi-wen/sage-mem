/**
 * 词面相似度的最小公共件：双字（2-gram）集合与 Jaccard。
 *
 * 为什么单独一个文件：`retrieval.js` 要用双字做相关性打分，`mmr.js` 要用双字算
 * 「两条记忆像不像」。若让 mmr 反过来 import retrieval，就成了循环（retrieval 也必须
 * import mmr 才能做重排）——把这一层词面工具提到无依赖处，两边都往下引，谁也不用回头。
 *
 * 行为与旧 `retrieval.js:bigrams` 逐字一致；那里仍 re-export 本函数，历史调用点不受影响。
 */

/** 提取双字（2-gram）集合，中英文数字通用；标点与空白一律剥掉。 */
export function bigrams(s) {
  const clean = String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

/**
 * 两个词集的 Jaccard 相似度（交集 / 并集），取值 0~1。
 *
 * 任一侧为空（超短文本、全是标点）时返回 0：**空集之间不算相似**。这条是刻意的——
 * 若把「没有可比词」当成「相似度为 1」，MMR 会把两条无关的短条目当成重复而丢弃；
 * 若当成「相似度为 0」，它们又会被排在前面。统一按 0 处理，等于「这一对没有信息量」，
 * 排序仍由相关度决定。
 */
export function jaccard(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set) || a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}
