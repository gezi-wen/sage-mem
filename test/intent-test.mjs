/**
 * 意图识别断言（lib/memory/intent.js）。
 *
 * 为什么负例比正例多：这一层的失效方式是**误判**，而误判只有负例能抓住。
 * 一个「所有输入都返回 correction」的实现能通过全部正例 —— 所以寒暄、普通知识
 * 问题、纯标点、空串、非字符串这些负例是套件的一半，不是陪衬。
 *
 * 第二件要紧的事：`INTENT_RULES` 声称「表就是实现」。本套件用**独立复算**验证它 ——
 * 在测试里照表重跑一遍「第一条命中的规则获胜」，逐条与 `detectIntent` 对比。
 * 若代码里藏着一条表上没有的路径，这里立刻红。
 *
 * 全部 fixture 为合成文本，不含任何真实记忆内容。
 */
import {
  INTENTS,
  NO_SUPPRESS_INTENTS,
  HISTORY_INTENTS,
  INTENT_RULES,
  detectIntent,
} from '../lib/memory/intent.js'

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
const j = (v) => JSON.stringify(v)
const eq = (a, b) => j(a) === j(b)

console.log('== 1. 常量与枚举 ==')
ok(eq(INTENTS, ['explicit_recall', 'correction', 'explain_prior', 'continue', 'none']), 'INTENTS 五个枚举且顺序固定')
ok(eq(NO_SUPPRESS_INTENTS, ['explicit_recall', 'correction', 'explain_prior']), 'NO_SUPPRESS_INTENTS 恰好三类')
ok(eq(HISTORY_INTENTS, ['explicit_recall', 'correction', 'explain_prior', 'continue']), 'HISTORY_INTENTS 恰好四类')
ok(Object.isFrozen(INTENTS) && Object.isFrozen(NO_SUPPRESS_INTENTS) && Object.isFrozen(HISTORY_INTENTS), '三个枚举常量都是冻结的')
ok(INTENTS.includes('none'), 'none 在 INTENTS 里（调用方要能穷举）')
ok(NO_SUPPRESS_INTENTS.every((i) => HISTORY_INTENTS.includes(i)), '「绝不抑制」是「历史依赖」的子集')
ok(HISTORY_INTENTS.every((i) => INTENTS.includes(i)), '历史依赖里的每一项都是合法枚举')
ok(!NO_SUPPRESS_INTENTS.includes('continue') && HISTORY_INTENTS.includes('continue'), 'continue 是历史依赖但可抑制')

console.log('== 2. 规则表结构：顺序即优先级 ==')
ok(eq(INTENT_RULES.map((r) => r.intent), ['correction', 'explain_prior', 'explicit_recall', 'continue']), `规则表顺序 = correction > explain_prior > explicit_recall > continue（实际 ${j(INTENT_RULES.map((r) => r.intent))}）`)
ok(Object.isFrozen(INTENT_RULES), '规则表本身冻结')
ok(INTENT_RULES.every((r) => Array.isArray(r.patterns) && r.patterns.length >= 3), '每条规则至少 3 个模式（单模式等于把一句话当判据）')
ok(INTENT_RULES.every((r) => r.patterns.every((p) => p instanceof RegExp)), '模式都是正则对象')
ok(INTENT_RULES.every((r) => r.patterns.every((p) => !p.flags.includes('g'))), '表里的正则不带 g（带 g 的 test() 会记住 lastIndex，跨调用行为漂移）')
ok(INTENT_RULES.every((r) => typeof r.note === 'string' && r.note.length > 10), '每条规则都写了 note（给人看「凭什么这么判」）')
ok(INTENT_RULES.every((r) => INTENTS.includes(r.intent) && r.intent !== 'none'), '规则只覆盖四类非 none 意图')

// 测试自己的复算器：照 INTENT_RULES 重跑「第一条命中者获胜」。
const fromTable = (q) => {
  if (typeof q !== 'string' || !q.trim()) return 'none'
  const text = q.slice(0, 4000)
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((p) => new RegExp(p.source, p.flags.replace(/[gy]/g, '')).test(text))) return rule.intent
  }
  return 'none'
}

console.log('== 3. 正例：四类各至少 3 条 ==')
/** [query, 期望意图] */
const fixtures = [
  // —— correction ——
  ['不用方案 A 了', 'correction'],
  ['把超时时间改成 5 秒', 'correction'],
  ['那个锁不再用了', 'correction'],
  ['不是 30 秒了', 'correction'],
  ['我记错了，阈值是 5 秒', 'correction'],
  // —— explain_prior ——
  ['之前为什么没选 B？', 'explain_prior'],
  ['当初为什么把它拆成两个模块？', 'explain_prior'],
  ['为什么当时用轮询而不是长连接？', 'explain_prior'],
  ['当时定这个阈值的依据是什么？', 'explain_prior'],
  // —— explicit_recall ——
  ['上次决定用 A，对吧？', 'explicit_recall'],
  ['我们之前约定过什么？', 'explicit_recall'],
  ['沿用上一版的接口定义', 'explicit_recall'],
  ['还记得当时怎么定的吗', 'explicit_recall'],
  ['按之前的方案继续', 'explicit_recall'],
  // —— continue ——
  ['继续', 'continue'],
  ['接着来', 'continue'],
  ['然后呢', 'continue'],
  ['下一步做什么', 'continue'],
  ['我们继续', 'continue'],
  ['Continue', 'continue'],
  // —— none：负例 ——
  ['今天天气怎么样', 'none'],
  ['你好，在吗', 'none'],
  ['谢谢', 'none'],
  ['Python 里怎么合并两个字典？', 'none'],
  ['什么是 BM25？', 'none'],
  ['为什么天空是蓝色的', 'none'],
  ['我记得这个函数', 'none'],
  ['请把这段代码改一下', 'none'],
  ['这个方案不错', 'none'],
  ['在继续讨论前，先解释一下依赖注入', 'none'],
  ['不用了，谢谢', 'none'],
  ['不用这么客气吧', 'none'],
  ['呢？', 'none'],
  ['？。！，、；：', 'none'],
  ['', 'none'],
  ['   \n\t ', 'none'],
]

const counts = {}
for (const [q, want] of fixtures) {
  const got = detectIntent(q).intent
  counts[want] = (counts[want] ?? 0) + (got === want ? 1 : 0)
  ok(got === want, `「${q}」→ ${want}（实际 ${got}）`)
}
for (const intent of INTENTS.filter((i) => i !== 'none')) {
  ok((counts[intent] ?? 0) >= 3, `${intent} 正例 ≥ 3 条（实际 ${counts[intent] ?? 0}）`)
}
ok(counts.none >= 8, `负例 ≥ 8 条（实际 ${counts.none}）`)

console.log('== 4. 优先级冲突：一句话含多个信号 ==')
const c1 = detectIntent('上次那个不是改成两格了吗')
ok(c1.intent === 'correction', `更正压过回看（实际 ${c1.intent}）`)
ok(eq(c1.matched, ['改成']), `只回报获胜规则的片段（实际 ${j(c1.matched)}）`)
const c2 = detectIntent('按之前的方案继续')
ok(c2.intent === 'explicit_recall', `显式回看压过续接（实际 ${c2.intent}）`)
const c3 = detectIntent('之前为什么选 A，而不是 B？')
ok(c3.intent === 'explain_prior', `问依据压过纯回看（实际 ${c3.intent}）`)
const c4 = detectIntent('不用 A 了，之前不是定过吗')
ok(c4.intent === 'correction', `更正压过回看 + 反问核实（实际 ${c4.intent}）`)
const c5 = detectIntent('为什么天空是蓝色的，昨天也是这样吗')
ok(c5.intent === 'none', `只有「为什么」没有过去时点 → none（实际 ${c5.intent}）`)

console.log('== 5. matched 契约：非空、且确实是原文片段 ==')
const short = fixtures.filter(([q]) => typeof q === 'string' && q.length > 0)
for (const [q, want] of short) {
  const r = detectIntent(q)
  if (want === 'none') {
    ok(eq(r.matched, []), `none 时 matched 为空数组（「${q}」实际 ${j(r.matched)}）`)
    continue
  }
  const rule = INTENT_RULES.find((x) => x.intent === r.intent)
  const verbatim = r.matched.length > 0 && r.matched.every((m) => q.includes(m))
  const explained = r.matched.every((m) =>
    rule.patterns.some((p) => new RegExp(p.source, p.flags.replace(/[gy]/g, '')).test(m)),
  )
  ok(verbatim && explained, `「${q}」的 matched 是原文且由本规则解释（${j(r.matched)}）`)
}

console.log('== 6. 规则表就是实现：独立复算逐条对比 ==')
const mismatched = short.filter(([q]) => fromTable(q) !== detectIntent(q).intent)
ok(mismatched.length === 0, `复算与实现完全一致（不一致 ${mismatched.length} 条${mismatched.length ? '：' + j(mismatched) : ''}）`)
// 反向对照：复算器必须**双向**有效。只会说「命中」的复算器与恒定实现永远一致，
// 那样上面那条对比就是空转 —— 所以这里要求它也能给出 none。
ok(fromTable('明天会不会下雨') === 'none', '复算器对无信号输入给 none')
ok(fromTable('上次决定用 A，对吧？') === 'explicit_recall', '复算器对有信号输入给命中')

console.log('== 7. suppressible / historyDependent 与常量一致 ==')
let suppressBad = 0
let historyBad = 0
for (const [q] of short) {
  const r = detectIntent(q)
  if (r.suppressible !== !NO_SUPPRESS_INTENTS.includes(r.intent)) suppressBad++
  if (r.historyDependent !== HISTORY_INTENTS.includes(r.intent)) historyBad++
}
ok(suppressBad === 0, `suppressible = !NO_SUPPRESS_INTENTS.includes(intent) 逐条成立（违反 ${suppressBad}）`)
ok(historyBad === 0, `historyDependent = HISTORY_INTENTS.includes(intent) 逐条成立（违反 ${historyBad}）`)
ok(detectIntent('上次决定用 A，对吧？').suppressible === false, 'explicit_recall 不可抑制')
ok(detectIntent('继续').suppressible === true, 'continue 可抑制')
ok(detectIntent('今天天气怎么样').suppressible === true && detectIntent('今天天气怎么样').historyDependent === false, 'none 既不历史依赖、也不触发抑制')
ok(Object.keys(detectIntent('继续')).sort().join(',') === 'historyDependent,intent,matched,suppressible', '返回对象恰好四个字段')

console.log('== 8. 非字符串 / 空 / 超长：不许抛错，且一律保守 ==')
const weird = [null, undefined, 42, 0, true, {}, [], () => {}, Symbol('x'), new String('继续')]
for (const v of weird) {
  let r
  let threw = false
  try {
    r = detectIntent(v)
  } catch {
    threw = true
  }
  const label = typeof v === 'symbol' ? 'Symbol' : j(v) ?? String(v)
  ok(!threw && r.intent === 'none' && eq(r.matched, []), `非字符串 ${label} → none 且不抛`)
}
const hostile = { toString() { throw new Error('boom') } }
let hostileOk = true
try {
  hostileOk = detectIntent(hostile).intent === 'none'
} catch {
  hostileOk = false
}
ok(hostileOk, 'toString() 会抛的对象也不抛（不做隐式转换）')

const long = 'x'.repeat(200000)
let longOk = true
try {
  longOk = detectIntent(long).intent === 'none'
} catch {
  longOk = false
}
ok(longOk, '20 万字符无信号输入 → none 且不抛')
ok(detectIntent('继续' + 'x'.repeat(100000)).intent === 'continue', '超长输入仍从开头认信号（截断而非放弃）')
ok(detectIntent('x'.repeat(3999)).intent === 'none' && detectIntent('x'.repeat(4001)).intent === 'none', '截断边界两侧行为一致')

const many = detectIntent('上次 之前 以前 当时 当初 早先 那会儿 上回 先前')
ok(many.intent === 'explicit_recall' && many.matched.length === 8, `matched 有上限 8（实际 ${many.matched.length}）`)
ok(many.matched.every((m) => '上次 之前 以前 当时 当初 早先 那会儿 上回 先前'.includes(m)), '被截断后的 matched 仍是原文片段')

console.log('== 9. 无状态：反复调用结果一致（正则 lastIndex 不外泄）==')
const q9 = '上次约定了什么，继续吧'
const a9 = j(detectIntent(q9))
const b9 = j(detectIntent(q9))
ok(a9 === b9, '同一输入连续两次结果完全一致')
detectIntent('上次 之前 以前 当时 当初 早先 那会儿 上回 先前')
ok(j(detectIntent(q9)) === a9, '跑过一次多命中输入后结果仍一致')
ok(INTENT_RULES.every((r) => r.patterns.every((p) => p.lastIndex === 0)), '表里的正则 lastIndex 始终为 0（未被实现改动）')

console.log('== 10. 边界难例：每条都写明「为什么这么判」 ==')
/** [query, 期望意图, 判据] */
const boundary = [
  ['不是已经定了吗', 'none', '反问式核实：排除「不是…了+吗」后，没有其它历史信号，宁可漏判也不判成更正'],
  ['接着这个问题，我想问别的', 'none', '「接着」后面不是动作，不算续接指令（要求句首或句尾）'],
  ['为什么这段代码会崩', 'none', '只有「为什么」，没有过去时点 —— 纯知识/排错问题'],
  ['明天会不会下雨', 'none', '无关问题零误召的基准门（决策档里记过的对抗性用例）'],
  ['之前的事就别想了', 'explicit_recall', '过去时点本身就算锚回历史：宽，但代价只是多检索一次，不是答错'],
  ['之前的报错为什么消失了', 'explain_prior', '「之前」与「为什么」同现 → 归到问依据，正文补检索的目标段落不同'],
  ['继续讨论', 'continue', '句首「继续」+ 动作'],
  ['把日志级别改为 debug', 'correction', '「改为」是明确的变更动作'],
  ['方案 A 换成方案 B', 'correction', '「换成」与「改成」同义'],
  ['What did we decide last time?', 'none', '只覆盖中文与少量英文口令；英文历史问句落 none（漏判，方向可接受）'],
]
for (const [q, want, why] of boundary) {
  const got = detectIntent(q).intent
  ok(got === want, `「${q}」→ ${want}（实际 ${got}）｜${why}`)
}

console.log('== 11. 套件判别力自证：退化解必须被打掉 ==')
const degenerates = [
  ['恒 none', () => 'none'],
  ['恒 correction', () => 'correction'],
  ['恒 explicit_recall', () => 'explicit_recall'],
  ['恒 continue', () => 'continue'],
  ['凡带问号就 explicit_recall', (q) => (q.includes('？') || q.includes('?') ? 'explicit_recall' : 'none')],
  ['凡含「之前」就 correction', (q) => (q.includes('之前') ? 'correction' : 'none')],
]
for (const [name, fn] of degenerates) {
  const wrong = fixtures.filter(([q, want]) => fn(q) !== want).length
  ok(wrong >= 5, `退化解「${name}」在本套件上至少错 5 条（实际错 ${wrong}/${fixtures.length}）`)
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
