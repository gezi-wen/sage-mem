/**
 * MMR（Maximal Marginal Relevance，边际相关度最大化）—— **只是「挑哪几条」的重排**。
 *
 * 它解决的具体病症：注入名额只有 10 条，而检索只按相关度排序，于是同一件事的四份记忆
 * （例如四篇课程笔记：老师 / 平台 / 死规矩 / 作业形态）可能把名额全占掉，别的主题一条都进不来。
 * MMR 每挑一条之前，先扣掉它与**已挑中**条目的相似度，让「不重复但相关」的那条先上。
 *
 * 公式（Carbonell & Goldstein, 1998）：
 *
 *     MMR(d) = λ · 归一化相关度(d) − (1 − λ) · max{ 相似度(d, s) | s ∈ 已选 }
 *
 * λ = 1 退化为「完全按相关度」；λ = 0 退化为「完全按不重复」。默认 0.7（相关度为主、去重为辅）。
 *
 * ── 三道护栏（本函数的对外契约，改之前先读）──────────────────────────────
 *
 * 1. **λ 收敛到 [0,1]，0 表示关闭**：`λ <= 0` 时直接按原顺序取前 k 条，与不启用等价。
 *    非法值（NaN / 负数 / 超过 1）一律收敛，不抛错 —— 这是设置在面板上可调的参数，
 *    一个手滑的输入不该让整条注入链失效。
 * 2. **只有「候选数 > 名额」才启用**：候选本来就不够时原样返回。理由：重排不改变成员，
 *    却会让「按相关度排好」变成「按另一种顺序排」，徒增不可解释性。
 * 3. **只挑不改**：不删除、不改分、不碰文件、不碰写路径。输入数组的每个元素原样返回，
 *    调用方拿到的仍是同一批对象引用；本函数只决定「哪几条、什么顺序」。
 *
 * 另外两条与调用点共担的约束（不在这层实现，但改调用点时别破坏）：
 *   - **baseline 不参与重排**：`selectBaseline` 走的是另一条线，按显式 `baselinePriority` 排。
 *   - **相似度只算词面**：与相关性打分共用同一套 2-gram（见 `ngram.js`），不引入向量/模型。
 */
import { jaccard } from './ngram.js'

/** 默认 λ：相关度 70%、去重 30%。调高更保守（更接近原始排序），调低更激进。 */
export const DEFAULT_MMR_LAMBDA = 0.7

/** 收敛 λ 到 [0,1]；非数字按 0（= 关闭）处理，与「配置写坏了就当没开」一致。 */
export function clampLambda(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  if (n <= 0) return 0
  return n >= 1 ? 1 : n
}

/**
 * 按 MMR 从候选里挑出 k 条。
 *
 * @param {Array<{score:number, terms:Set<string>}>} items
 *   候选，**必须已按相关度降序**（调用方负责）；`score` 的量纲由调用方决定，
 *   `terms` 是用于算相似度的词集（通常 = 摘要面 `description + aliases + 文件名` 的双字集）。
 * @param {{k?:number, lambda?:number}} [opts]
 *   `k` 名额（缺省 = 全部）、`lambda` 见文件头（缺省 `DEFAULT_MMR_LAMBDA`）。
 * @returns {Array} 被选中的条目（顺序即 MMR 挑选顺序）。**元素是原数组里的同一批引用**。
 */
export function mmrSelect(items, opts = {}) {
  const list = Array.isArray(items) ? items : []
  const k = Number.isFinite(opts.k) ? Math.max(0, Math.floor(opts.k)) : list.length
  if (k <= 0 || list.length === 0) return []
  // 护栏 2：候选不超过名额 → 原样返回（连顺序都不动）。
  if (list.length <= k) return list.slice()

  const lambda = clampLambda(opts.lambda === undefined ? DEFAULT_MMR_LAMBDA : opts.lambda)
  // 护栏 1：λ <= 0 表示关闭，等价于「按原顺序取前 k」。
  if (lambda <= 0) return list.slice(0, k)

  // 相关度归一到 [0,1]：score 与 Jaccard 是两种量纲，不归一就没有可比性。
  // 全 0 分（理论上不会出现在命中集，但防御一下）时归一化退化为「纯去重」。
  const maxScore = list.reduce((m, it) => Math.max(m, Number(it?.score) || 0), 0)
  const rel = list.map(it => (maxScore > 0 ? (Number(it?.score) || 0) / maxScore : 0))

  const picked = []
  // 保留原始下标：归一化相关度靠它取；`rest` 只做删除，不重排。
  const rest = list.map((it, idx) => ({ it, idx }))
  while (picked.length < k && rest.length > 0) {
    let bestPos = 0
    let bestValue = -Infinity
    for (let p = 0; p < rest.length; p += 1) {
      const cand = rest[p]
      let maxSim = 0
      for (const chosen of picked) {
        const sim = jaccard(cand.it?.terms, chosen.terms)
        if (sim > maxSim) maxSim = sim
      }
      const value = lambda * (rel[cand.idx] || 0) - (1 - lambda) * maxSim
      // 严格大于：平分时留在前面那条（`rest` 维持原顺序 = 相关度降序），
      // 结果因此是确定的——同样的输入永远给出同样的顺序，测试才能钉住它。
      if (value > bestValue) {
        bestValue = value
        bestPos = p
      }
    }
    picked.push(rest[bestPos].it)
    rest.splice(bestPos, 1)
  }
  return picked
}
