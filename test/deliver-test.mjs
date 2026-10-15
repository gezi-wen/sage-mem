/**
 * 展示层 `decideDelivery` 的断言（lib/memory/deliver.js）。
 *
 * 为什么每条规则都配一条反向对照：这一层的价值全在「该抑制的抑制、**不该抑制的绝不抑制**」。
 * 只验「会注入」的话，一个永远返回 snippet 的实现也能全绿 —— 那正好是它要防的故障。
 * 纯函数、零 I/O；全部 fixture 为合成文本（本仓库是公开仓库，不用任何真实记忆内容）。
 */
import { decideDelivery, DELIVERY_REASONS, DELIVERY_KINDS, POINTER_BYTES } from '../lib/memory/deliver.js'
// 名单从**它的唯一出处**取：deliver.js 若自己藏了一份副本，下面的断言就不会跟着它走。
import { NO_SUPPRESS_INTENTS } from '../lib/memory/intent.js'

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
const bytes = (s) => Buffer.byteLength(s, 'utf8')

/** 合成正文：中文 + 中文标点，用来证明记账走的是 UTF-8 字节而不是字符数。 */
const TEXT = '示例正文甲：先校验序号，再写入台账。'
const TEXT_BYTES = bytes(TEXT)

/** 合成候选：默认是一条「有正文、非 baseline」的普通候选，各条断言只覆盖自己关心的字段。 */
const cand = (over = {}) => ({
  file: 'project_alpha.md',
  id: 'project_alpha.md#3-9',
  revision: 'sha256:111111111111',
  score: 1.5,
  title: '示例条目甲',
  lines: [3, 9],
  text: TEXT,
  ...over,
})

const run = (candidates, ctx = {}, budget = {}) => decideDelivery(candidates, ctx, budget)
const kindOf = (r, i = 0) => r.items[i].kind
const reasonOf = (r, i = 0) => r.items[i].reason

console.log('== 1. 常量 ==')
ok(Object.isFrozen(DELIVERY_REASONS), 'DELIVERY_REASONS 冻结（对外字段必须稳定）')
ok(
  j(DELIVERY_REASONS) === j([
    'baseline', 'explicit_recall', 'evidence_missing', 'same_revision_visible', 'budget_omitted',
    'scope_denied', 'conflict_pending', 'expired_source', 'below_floor', 'no_relevant_hit',
  ]),
  '理由枚举逐条一致',
  j(DELIVERY_REASONS),
)
ok(Object.isFrozen(DELIVERY_KINDS) && j(DELIVERY_KINDS) === j(['snippet', 'pointer', 'suppress', 'unresolved']), '处置种类一致', j(DELIVERY_KINDS))
ok(POINTER_BYTES === 90, `指针记账字节 90（实际 ${POINTER_BYTES}）`)
// 这是一条**契约断言**（钉住 intent.js 该给哪三个），不是第二份出处 —— deliver.js 里那份副本
// 已经被上面这行的「从 intent.js 取名单」加上第 5 节的行为断言排除掉了。
ok(j(NO_SUPPRESS_INTENTS) === j(['explicit_recall', 'correction', 'explain_prior']), '显式意图三类（取自 intent.js 的唯一出处）', j(NO_SUPPRESS_INTENTS))
ok(TEXT_BYTES === 54 && TEXT.length === 18, `夹具自检：中文一字三字节（${TEXT_BYTES} 字节 / ${TEXT.length} 字符）`)

console.log('== 2. 规则 1：baseline 永远给正文，不受预算裁剪 ==')
const b0 = run([cand({ baseline: true })], {}, { bytes: 0 })
ok(kindOf(b0) === 'snippet' && reasonOf(b0) === 'baseline', '预算 0 时 baseline 仍是 snippet/baseline')
ok(b0.items[0].bytes === TEXT_BYTES, 'baseline 的字节按 UTF-8 计', `${b0.items[0].bytes}`)
ok(b0.items[0].bytes !== b0.items[0].text.length, '字节数确实不等于字符数（不是在比 length）')
ok(b0.totals.bytes === TEXT_BYTES && b0.totals.injected === 1, 'baseline 计入 totals', j(b0.totals))
const bNoText = run([cand({ baseline: true, text: '' })], {}, { bytes: 0 })
ok(kindOf(bNoText) === 'snippet' && bNoText.items[0].bytes === 0, 'baseline 没正文时仍是 snippet（规则 1 不看正文有无）')

console.log('== 3. 规则 2：scopeDenied ==')
const sd = run([cand()], { scopeDenied: new Set(['project_alpha.md']) })
ok(kindOf(sd) === 'suppress' && reasonOf(sd) === 'scope_denied', '按文件名命中 → suppress/scope_denied')
ok(sd.items[0].bytes === 0 && sd.items[0].text === undefined, '被拒绝的条目不带正文、不记字节')
const sdById = run([cand()], { scopeDenied: new Set(['project_alpha.md#3-9']) })
ok(reasonOf(sdById) === 'scope_denied', '按 chunk id 也能命中（正文候选手里常常只有 id）')
const sdArr = run([cand()], { scopeDenied: ['project_alpha.md'] })
ok(reasonOf(sdArr) === 'scope_denied', '传数组而不是 Set 也认')
const sdNo = run([cand()], { scopeDenied: new Set(['project_beta.md']) })
ok(reasonOf(sdNo) === 'evidence_missing', '【反向】不在集合里就不该被拒', reasonOf(sdNo))

console.log('== 4. 规则 3/4：expired 与 conflicts 走 unresolved ==')
const ex = run([cand()], { expired: new Set(['project_alpha.md']) })
ok(kindOf(ex) === 'unresolved' && reasonOf(ex) === 'expired_source', '来源失效 → unresolved/expired_source')
ok(ex.items[0].bytes === 0 && ex.items[0].text === undefined, 'unresolved 不注入正文')
const cf = run([cand()], { conflicts: new Set(['project_alpha.md']) })
ok(kindOf(cf) === 'unresolved' && reasonOf(cf) === 'conflict_pending', '有未裁决冲突 → unresolved/conflict_pending')
ok(cf.items[0].text === undefined, '冲突时**不给任一方正文**（正文只可能让人当真）')
const both = run([cand()], { expired: new Set(['project_alpha.md']), conflicts: new Set(['project_alpha.md']) })
ok(reasonOf(both) === 'expired_source', '过期先于冲突（先判的赢）')
const three = run([cand()], { scopeDenied: new Set(['project_alpha.md']), expired: new Set(['project_alpha.md']), conflicts: new Set(['project_alpha.md']) })
ok(reasonOf(three) === 'scope_denied', '作用域拒绝最先判')
const cfNo = run([cand()], { conflicts: new Set(['project_beta.md']) })
ok(reasonOf(cfNo) === 'evidence_missing', '【反向】不在冲突集合里就照常给正文')

console.log('== 5. 规则 5/6：同 revision 抑制，显式意图绝不抑制 ==')
const VIS = new Set(['sha256:111111111111'])
const sup = run([cand()], { intent: 'none', visibleRevisions: VIS })
ok(kindOf(sup) === 'suppress' && reasonOf(sup) === 'same_revision_visible', '非显式意图 + 同 revision → 抑制重复')
const supC = run([cand()], { intent: 'continue', visibleRevisions: VIS })
ok(reasonOf(supC) === 'same_revision_visible', 'continue 不算显式意图，照样抑制')
for (const intent of NO_SUPPRESS_INTENTS) {
  const r = run([cand()], { intent, visibleRevisions: VIS })
  ok(kindOf(r) === 'snippet' && r.items[0].text === TEXT, `【反向】${intent} 时同 revision 也不抑制，仍给正文`)
}
const noVis = run([cand()], { intent: 'none', visibleRevisions: new Set() })
ok(reasonOf(noVis) === 'evidence_missing', '【反向对照】revision 不可见时不抑制（抑制确实来自 visibleRevisions）')
const emptyRev = run([cand({ revision: '' })], { intent: 'none', visibleRevisions: new Set(['']) })
ok(reasonOf(emptyRev) === 'evidence_missing', '空 revision 不参与匹配（缺值不该等于相等）')

console.log('== 6. 规则 6：显式意图的三种出口 ==')
const exText = run([cand()], { intent: 'explicit_recall' })
ok(kindOf(exText) === 'snippet' && reasonOf(exText) === 'explicit_recall' && exText.items[0].text === TEXT, '有正文 → snippet/explicit_recall')
const exExcerpt = run([cand({ text: '', excerpt: '示例片段乙' })], { intent: 'explicit_recall' })
ok(kindOf(exExcerpt) === 'snippet' && exExcerpt.items[0].text === '示例片段乙', '只有 excerpt → 用 excerpt 当正文')
ok(exExcerpt.items[0].bytes === bytes('示例片段乙'), 'excerpt 也按 UTF-8 记字节')
const exEmpty = run([cand({ text: '', excerpt: '' })], { intent: 'correction' })
ok(kindOf(exEmpty) === 'pointer' && reasonOf(exEmpty) === 'explicit_recall', '两者都空 → pointer 仍记 explicit_recall（留入口，不假装给了内容）')
ok(exEmpty.items[0].bytes === POINTER_BYTES && exEmpty.items[0].text === undefined, '这种指针计入 POINTER_BYTES 且不带正文')
ok(kindOf(exEmpty) !== 'snippet', '不会产出 text 为空的 snippet')
const noneEmpty = run([cand({ text: '', excerpt: '' })], { intent: 'none' })
ok(kindOf(noneEmpty) === 'suppress' && reasonOf(noneEmpty) === 'below_floor', '【反向对照】同一候选非显式意图 → suppress/below_floor')
const textWins = run([cand({ text: '正文优先', excerpt: '片段兜底' })])
ok(textWins.items[0].text === '正文优先', '同时有 text 与 excerpt 时 text 优先（降级只发生在数据上）')

console.log('== 6b. 规则 7 也收 excerpt（真实 wire shape 没有 text）==')
// 与 retrieve() 的真实 hit 同形：**没有 text 字段**，正文证据只以 excerpt 出现。
const wireHit = {
  id: 'project_alpha.md#3-9',
  file: 'project_alpha.md',
  revision: 'sha256:111111111111',
  title: '示例条目甲',
  headingPath: '示例',
  lines: [3, 9],
  excerpt: TEXT,
  score: 2.1,
  matchedBy: ['body'],
}
const wire = decideDelivery([wireHit], { intent: 'none' }, { bytes: 8000 })
ok(kindOf(wire) === 'snippet' && reasonOf(wire) === 'evidence_missing', '【反向对照】只给 excerpt 的普通轮次必须给正文，不是 below_floor', reasonOf(wire))
ok(wire.items[0].text === TEXT, 'excerpt 被当作正文交给消费方')
ok(wire.items[0].bytes === TEXT_BYTES, 'excerpt 也按 UTF-8 记字节')
ok(reasonOf(wire) !== 'below_floor', '不会因为缺 text 字段就静默全量 below_floor（那正是「没找到」与「找到了没展示」混成一团）')
ok(reasonOf(decideDelivery([wireHit], { intent: 'explicit_recall' }, { bytes: 8000 })) === 'explicit_recall', '同一候选在显式意图下记 explicit_recall（reason 只说「为什么给」）')
ok(reasonOf(decideDelivery([wireHit], { intent: 'none' }, { bytes: TEXT_BYTES - 1 })) === 'budget_omitted', 'excerpt 同样受预算闸门（不是绕过预算的后门）')

console.log('== 7. 规则 7/8：预算闸门与「不静默丢弃」 ==')
const exact = run([cand()], {}, { bytes: TEXT_BYTES })
ok(kindOf(exact) === 'snippet', '预算正好等于所需字节 → 给正文（边界）')
const short = run([cand()], {}, { bytes: TEXT_BYTES - 1 })
ok(kindOf(short) === 'pointer' && reasonOf(short) === 'budget_omitted', '少 1 字节 → pointer/budget_omitted')
ok(short.items.length === 1 && short.items[0].file === 'project_alpha.md', '【不静默丢弃】降级后条目仍在，file 仍可定位')
ok(short.items[0].bytes === POINTER_BYTES && short.totals.bytes === POINTER_BYTES, '指针计 90 字节')
const zero = run([cand()], {}, { bytes: 0 })
ok(reasonOf(zero) === 'budget_omitted' && zero.items.length === 1, '预算 0 也要留下入口')
const exBudget = run([cand()], { intent: 'explicit_recall' }, { bytes: 1 })
ok(kindOf(exBudget) === 'pointer' && reasonOf(exBudget) === 'budget_omitted', '显式意图一样受预算闸门（它保证的是不抑制，不是无视预算）')
ok(kindOf(exBudget) !== 'suppress', '显式意图预算不足时也不是抑制')

const bigA = cand({ file: 'project_alpha.md', id: 'a', text: '甲'.repeat(30) })
const smallB = cand({ file: 'project_beta.md', id: 'b', text: '乙' })
const greedy = run([bigA, smallB], {}, { bytes: bytes('乙') })
ok(reasonOf(greedy, 0) === 'budget_omitted' && kindOf(greedy, 1) === 'snippet', '指针不消耗正文额度：后面的小候选仍能拿到正文（否则一个超长候选就能把后面全压成指针）')

const noBudget = run([cand(), cand({ file: 'project_beta.md', id: 'b' })])
ok(noBudget.totals.injected === 2 && noBudget.totals.pointers === 0, '未传预算 → 不设限，不静默降级成指针')
const badBudget = run([cand()], {}, { bytes: 'abc' })
ok(kindOf(badBudget) === 'snippet', '预算非数字 → 同样按不设限处理')

const blBig = cand({ baseline: true, file: 'user_baseline.md', id: 'bl', text: '甲'.repeat(30) })
const after = run([blBig, smallB], {}, { bytes: 10 })
ok(kindOf(after) === 'snippet' && after.totals.bytes > 10, '预算装不下 baseline 时 totals.bytes 可以超支（如实暴露，不裁必给项）', j(after.totals))
ok(reasonOf(after, 1) === 'budget_omitted', 'baseline 之后的候选按剩余额度降级')

console.log('== 8. 字节守恒与逐 kind 计数 ==')
const mixed = [
  cand({ baseline: true, file: 'user_baseline.md', id: 'bl' }),
  cand({ file: 'project_alpha.md', id: 'a1' }),
  cand({ file: 'project_beta.md', id: 'b1' }),
  cand({ file: 'project_gamma.md', id: 'g1' }),
  cand({ file: 'reference_delta.md', id: 'd1' }),
  cand({ file: 'archive_epsilon.md', id: 'e1', text: '' }),
]
const res = run(mixed, { scopeDenied: new Set(['project_gamma.md']), expired: new Set(['reference_delta.md']) }, { bytes: TEXT_BYTES + 6 })
const sumKind = (kind) => res.items.filter(i => i.kind === kind).reduce((n, i) => n + i.bytes, 0)
const countKind = (kind) => res.items.filter(i => i.kind === kind).length
ok(res.items.length === mixed.length, '每条候选都有对应的处置（一条都不丢）')
ok(res.totals.bytes === sumKind('snippet') + sumKind('pointer'), 'totals.bytes === snippet+pointer 的字节之和')
ok(res.totals.injected === countKind('snippet'), 'injected 计数与 items 一致')
ok(res.totals.pointers === countKind('pointer') && res.totals.pointers === 2, 'pointers 计数一致（实际应为 2）', String(res.totals.pointers))
ok(res.totals.suppressed === countKind('suppress') && res.totals.suppressed === 2, 'suppressed 计数一致')
ok(res.totals.unresolved === countKind('unresolved') && res.totals.unresolved === 1, 'unresolved 计数一致')
ok(res.items.every(i => DELIVERY_KINDS.includes(i.kind)), '每种 kind 都在枚举里')
ok(res.items.every(i => DELIVERY_REASONS.includes(i.reason)), '每种 reason 都在枚举里')
ok(res.items.filter(i => i.kind !== 'snippet').every(i => i.text === undefined), '非 snippet 一律不带正文')
ok(res.items.every(i => typeof i.bytes === 'number' && i.bytes >= 0), 'bytes 都是非负数')
const itemOrder = res.items.map(i => i.id)
ok(j(itemOrder) === j(mixed.map(c => c.id)), 'items 顺序与输入一致（本模块不重排）')

console.log('== 9. 形状与鲁棒性 ==')
const empty = decideDelivery([], {}, { bytes: 100 })
ok(j(empty.items) === '[]' && empty.totals.bytes === 0 && empty.totals.injected === 0, '空候选 → 空结果、零合计')
ok(j(decideDelivery(null)) === j({ items: [], totals: { bytes: 0, injected: 0, pointers: 0, suppressed: 0, unresolved: 0 } }), 'candidates 不是数组 → 同样形状，不抛')
const dirty = decideDelivery([null, 42, 'x', cand()])
ok(dirty.items.length === 1 && reasonOf(dirty) === 'evidence_missing', '混进 null / 数字 / 字符串时跳过它们，正常候选照常处置')
const noLines = decideDelivery([cand({ lines: undefined, title: undefined })])
ok(noLines.items[0].lines === null && noLines.items[0].title === '', '缺 lines/title 时给 null / 空串，不出现 undefined')

const src = cand()
const before = j(src)
const out = run([src], { intent: 'none', visibleRevisions: new Set(), scopeDenied: new Set() }, { bytes: 100 })
ok(j(src) === before, '不修改传入的候选对象')
ok(out.items[0].lines !== src.lines && j(out.items[0].lines) === j(src.lines), 'lines 是副本，不是同一个数组引用')
ok(Array.isArray(out.items) && typeof out.totals?.bytes === 'number', '返回 {items, totals} 形状')
ok(j(decideDelivery([cand()])) === j(decideDelivery([cand()])), '纯函数：同输入两次结果一致')

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
