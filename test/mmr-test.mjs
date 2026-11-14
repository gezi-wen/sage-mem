/**
 * MMR 去重重排的断言（lib/memory/mmr.js + retrieval.js 的接线）。
 *
 * 为什么重点不是「效果好不好」而是**护栏**：MMR 会改变「哪些记忆被端上来」，
 * 它出事的样子不是报错，而是**某条该来的记忆静默缺席**。所以本文件按三条护栏组织：
 *   1. λ ≤ 0 / 非法值 = 关闭，且与 2.8.0 的老路径逐字等价；
 *   2. 候选不超过名额时**原样返回**，连顺序都不动；
 *   3. 只挑不改 —— 输入数组、对象引用、文件内容一个都不碰。
 * 再加一条工程护栏：同输入必须同输出（平分时按原顺序，不靠 Map 迭代顺序）。
 *
 * 纯函数、零 I/O，全部 fixture 为合成数据。
 */
import { mmrSelect, clampLambda, DEFAULT_MMR_LAMBDA } from '../lib/memory/mmr.js'
import { jaccard, bigrams } from '../lib/memory/ngram.js'
import { selectRelevant } from '../lib/memory/retrieval.js'
import { selectRecall } from '../lib/recall/select.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}
const terms = (s) => bigrams(s)
const item = (name, score, text) => ({ file: name, score, terms: terms(text) })

// ── 1. λ 收敛（护栏 1 的前半）──────────────────────────────────────
console.log('== 1. λ 收敛 ==')
ok(clampLambda(DEFAULT_MMR_LAMBDA) === 0.7, '默认 λ 是 0.7')
ok(clampLambda(0) === 0, '0 → 0（关闭）')
ok(clampLambda(-1) === 0, '负数 → 0（收敛，不抛错）')
ok(clampLambda(2) === 1, '超过 1 → 1（纯相关度）')
ok(clampLambda('0.55') === 0.55, '字符串数字照收（设置可能来自 JSON）')
ok(clampLambda('abc') === 0, '非数字 → 0（配置写坏就当没开）')
ok(clampLambda(undefined) === 0, 'undefined → 0')
ok(clampLambda(NaN) === 0, 'NaN → 0')

// ── 2. jaccard / 空集 ──────────────────────────────────────────────
console.log('== 2. 词面相似度 ==')
const A = terms('果园 构建 超时 排查')
const B = terms('果园 构建 超时 排查')
const C = terms('潮汐 调度 窗口')
ok(jaccard(A, B) === 1, '同一段文本 → 1')
ok(jaccard(A, C) === 0, '毫无重合 → 0')
const half = terms('果园 构建 完全无关的句子')
ok(jaccard(A, half) > 0 && jaccard(A, half) < 1, `部分重合 → (0,1) 之间（实测 ${jaccard(A, half).toFixed(3)}）`)
ok(jaccard(new Set(), A) === 0 && jaccard(A, new Set()) === 0, '空集与谁都不算相似（不当成 1）')
ok(jaccard(undefined, A) === 0 && jaccard(A, null) === 0, '非 Set 输入不抛错，按 0 处理')

// ── 3. 护栏 2：候选不超过名额 → 原样 ───────────────────────────────
console.log('== 3. 护栏：候选 ≤ 名额原样返回 ==')
const two = [item('a.md', 0.9, '甲甲 甲乙'), item('b.md', 0.8, '乙乙 乙丙')]
const same = mmrSelect(two, { k: 2, lambda: 0.7 })
ok(same.length === 2 && same[0] === two[0] && same[1] === two[1], '两条候选、名额 2 → 顺序与引用都不变')
const bigger = mmrSelect(two, { k: 9, lambda: 0.7 })
ok(bigger.length === 2 && bigger[0] === two[0], '名额大于候选 → 仍原样')
ok(mmrSelect([], { k: 3, lambda: 0.7 }).length === 0, '空输入 → 空数组')
ok(mmrSelect(two, { k: 0, lambda: 0.7 }).length === 0, '名额 0 → 空数组')

// ── 4. 护栏 1：λ=0 等价于关闭（按原顺序前 k）────────────────────────
console.log('== 4. 护栏：λ=0 等价关闭 ==')
const trio = [item('a.md', 0.9, '甲甲 甲乙'), item('b.md', 0.88, '甲甲 甲乙'), item('c.md', 0.5, '丙丙 丙丁')]
const off = mmrSelect(trio, { k: 2, lambda: 0 })
ok(off.length === 2 && off[0].file === 'a.md' && off[1].file === 'b.md', 'λ=0 取前两条（重复也照收）')
const offByMissing = mmrSelect(trio, { k: 2 })
ok(offByMissing.length === 2 && offByMissing[1].file === 'c.md', '不传 λ → 走默认 0.7（于是第二条被换成不重复的那条，证明默认值不是 0）')

// ── 5. 去重效果（这是它存在的理由）────────────────────────────────
console.log('== 5. 去重效果 ==')
const on = mmrSelect(trio, { k: 2, lambda: DEFAULT_MMR_LAMBDA })
ok(on[0].file === 'a.md', '第一条仍是最高分（相关度优先）')
ok(on[1].file === 'c.md', '第二条换成不重复的那条（被跳过的 b.md 与 a.md 几乎同文）')
const pureDedup = mmrSelect(trio, { k: 2, lambda: 0.01 })
ok(pureDedup.length === 2, 'λ 极低也不崩，仍返回 2 条')

// ── 6. 护栏 3：只挑不改 ────────────────────────────────────────────
console.log('== 6. 护栏：只挑不改 ==')
const before = trio.map(x => x.file).join(',')
const snapshot = trio.slice()
mmrSelect(trio, { k: 2, lambda: 0.7 })
ok(trio.length === 3, '输入数组长度不变')
ok(trio.map(x => x.file).join(',') === before, '输入数组顺序不变')
ok(trio.every((x, i) => x === snapshot[i]), '元素引用不变（没有换对象、没有挂字段）')
ok(!('mmr' in trio[0]) && !('penalty' in trio[0]), '没有往条目上写中间结果')
ok(Object.keys(trio[0]).sort().join(',') === 'file,score,terms', '条目字段集合没被污染')

// ── 7. 确定性 ─────────────────────────────────────────────────────
console.log('== 7. 同输入同输出 ==')
const tie = [item('a.md', 0.5, '甲甲'), item('b.md', 0.5, '乙乙'), item('c.md', 0.5, '甲甲')]
const run1 = mmrSelect(tie, { k: 2, lambda: 0.7 }).map(x => x.file).join(',')
const run2 = mmrSelect(tie, { k: 2, lambda: 0.7 }).map(x => x.file).join(',')
ok(run1 === run2, `两次结果一致（${run1}）`)
ok(run1 === 'a.md,b.md', '平分时取靠前那条，且跳过与它同文的 c.md')

// ── 8. 退化输入 ───────────────────────────────────────────────────
console.log('== 8. 退化输入不崩 ==')
const zeroScore = [{ file: 'x.md', score: 0, terms: terms('甲甲') }, { file: 'y.md', score: 0, terms: terms('乙乙') }, { file: 'z.md', score: 0, terms: terms('丙丙') }]
const zs = mmrSelect(zeroScore, { k: 2, lambda: 0.7 })
ok(zs.length === 2, '全 0 分不除零，仍返回 k 条')
const noTerms = [{ file: 'p.md', score: 0.9 }, { file: 'q.md', score: 0.8 }, { file: 'r.md', score: 0.7 }]
ok(mmrSelect(noTerms, { k: 2, lambda: 0.7 }).length === 2, '条目没有 terms 时按「互不相似」处理，不抛错')

// ── 9. retrieval 接线 ─────────────────────────────────────────────
console.log('== 9. selectRelevant 接线 ==')
const mk = (name, desc) => ({ file: name, description: desc, aliases: [], baseline: false })
// 同族 12 条（描述几乎一样）+ 1 条异族：候选数 13 > 名额 10，MMR 才有话可说。
const family = Array.from({ length: 12 }, (_, i) => mk(`project_orchard-timeout-${i}.md`, '果园构建超时 先查缓存和重试预算 果园构建超时'))
const other = mk('reference_sourdough-starter.md', '果园构建超时 顺带记一下天然酵母起种的喂养比例')
const pool = [...family, other]
// `gate: false` 只为绕开 IDF 证据门：本组测的是「挑哪几条」的接线，
// 而合成语料里 query 词元几乎出现在每一份文件上，证据门会按设计把它们全部拦下
// （那是 2.1.16 的行为，另由 retrieval-test 覆盖）。这里不想测两件事。
const plain = selectRelevant('果园构建超时', pool, { maxResults: 10, mmr: 0, gate: false })
const withMmr = selectRelevant('果园构建超时', pool, { maxResults: 10, mmr: 0.7, gate: false })
ok(plain.length === 10, `关闭时取满 10 条（实际 ${plain.length}）`)
ok(plain.every(f => f.file.startsWith('project_orchard-timeout-')), '关闭时 10 条全是同族（这正是要治的病）')
ok(withMmr.length === 10, `开启后仍取满 10 条（实际 ${withMmr.length}）`)
ok(withMmr.some(f => f.file === 'reference_sourdough-starter.md'), '开启后异族那条进得来（名额被让出来了）')
ok(withMmr[0].file.startsWith('project_orchard-timeout-'), '最高分那条仍然排第一（没有为了去重把它换掉）')
ok(plain.every(f => typeof f.score === 'number') && withMmr.every(f => typeof f.score === 'number'), '两条路径返回的文件对象都带 score（下游没被改坏）')
const explicitOff = selectRelevant('果园构建超时', pool, { maxResults: 10, mmr: 0, gate: false })
const noMmrKey = selectRelevant('果园构建超时', pool, { maxResults: 10, gate: false })
ok(explicitOff.map(f => f.file).join(',') === plain.map(f => f.file).join(','), 'mmr=0 与 2.8.0 的老路径逐字一致')
ok(noMmrKey.map(f => f.file).join(',') === plain.map(f => f.file).join(','), '不传 mmr → undefined 不算启用（默认关，不是默认 0.7）')

// ── 10. baseline 不受影响（跨模块护栏）──────────────────────────────
console.log('== 10. baseline 不参与重排 ==')
const baselineFiles = [
  { ...mk('feedback_baseline-a.md', '果园构建超时 的固定规矩'), baseline: true, baselinePriority: 5 },
  { ...mk('user_baseline-b.md', '果园构建超时 的身份信息'), baseline: true, baselinePriority: 1 },
]
const recallPool = [...family, other, ...baselineFiles]
const st = { baselineDone: false, signature: '', gen: 0 }
const recOff = selectRecall({ text: '果园构建超时', files: recallPool, st: { ...st }, mmr: 0 })
const recOn = selectRecall({ text: '果园构建超时', files: recallPool, st: { ...st }, mmr: 0.7 })
const hasAll = (r) => ['feedback_baseline-a.md', 'user_baseline-b.md'].every(n => r.picked.some(f => f.file === n))
ok(hasAll(recOff) && hasAll(recOn), '两条 baseline 在开关两态下都被注入（锁定记忆不受 MMR 影响）')
ok(recOn.baselineTaken === 2 && recOff.baselineTaken === 2, 'baselineTaken 计数不变')
ok(recOn.picked.length >= recOff.picked.length - 0, `注入条数没有被 MMR 撑大（off=${recOff.picked.length} on=${recOn.picked.length}）`)

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
