#!/usr/bin/env node
/**
 * write-gate.js 的断言（写入门：给记忆目录的写入补版本守卫）。
 *
 * 重点有三处**反向对照**，因为这一层最容易做反：
 *   1. 目录外的写入**一点都不许碰**（单槽语义下，返回任何值都会占掉槽位）；
 *   2. 调用方自己给了意图/守卫时必须原样透传，不许被我们覆盖；
 *   3. 「存在但拿不到版本」→ `unknown`，**不许**退化成 `createIfAbsent`。
 *
 * 夹具一律合成：`/srv/notes/memory` 与 `C:\Users\someone\memory` 都不对应任何真实路径；
 * `V` 是一个刻意不可解析的版本串（版本是**不透明值**）。
 *
 * 用法: node test/write-gate-test.mjs
 */
import { readFile } from 'node:fs/promises'
import { memoryPathOf } from '../lib/memory/paths.js'
import { GATE_REASONS, decideEditGuard, decideWriteIntent } from '../lib/memory/write-gate.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`)
  }
}

const MEM = '/srv/notes/memory'
const MEM_WIN = 'C:\\Users\\someone\\memory'
/** 刻意「不像版本号」的版本：用来盯住「原样透传，不做任何转换」。 */
const V = 'opaque::zz-9e99-not-a-number'
const show = (x) => JSON.stringify(x)
/** 走 paths.js 的真实判据造 facts —— 顺带证明本模块吃的是同一个 memoryPathOf 的结果。 */
const factsFor = (target, extra = {}) => ({ memoryPath: memoryPathOf(target, MEM), exists: false, version: null, ...extra })

console.log('== 1. GATE_REASONS 是数据 ==')
ok(Array.isArray(GATE_REASONS) && Object.isFrozen(GATE_REASONS), 'GATE_REASONS 是冻结数组')
ok(JSON.stringify(GATE_REASONS) === JSON.stringify(['outside_memory', 'no_version', 'created', 'guarded', 'caller_wins', 'unknown']),
  '内容与顺序和冻结接口一致', show(GATE_REASONS))

console.log('== 2. 目录外一律不管（反向对照：整块盘的写入不受影响）==')
const outsideFacts = factsFor('/srv/notes/other/doc.md', { exists: true, version: V })
const ow = decideWriteIntent(outsideFacts)
ok(ow.intent === undefined && ow.reason === 'outside_memory', '目录外的写入 → 无意图 + outside_memory', show(ow))
const oe = decideEditGuard(outsideFacts)
ok(oe.guard === undefined && oe.reason === 'outside_memory', '目录外的编辑 → 无守卫 + outside_memory', show(oe))
ok(decideWriteIntent(factsFor(`${MEM}-evil/a.md`, { exists: false })).reason === 'outside_memory',
  '前缀陷阱：<记忆目录>-evil 下的写入不管')
ok(decideEditGuard(factsFor(`${MEM}-evil/a.md`, { exists: true, version: V })).guard === undefined, '前缀陷阱的编辑同样不管')
ok(decideWriteIntent(factsFor(MEM, { exists: true, version: V })).reason === 'outside_memory',
  '目标是记忆目录本身 → 不管（写文件的门不管目录）')
ok(decideWriteIntent({ memoryPath: memoryPathOf('/srv/notes/memory2/x.md', '/srv/notes/mem'), exists: false }).reason === 'outside_memory',
  '短目录名不做裸前缀匹配')
// 这条是本套件的重心：目录外**即使调用方带了意图**，也必须返回 undefined ——
// 单槽语义下「返回调用方的值」就等于把槽占掉，后面监听器再没有机会，那就不是「不受影响」了。
const oCaller = factsFor('/srv/notes/other/doc.md', { exists: true, version: V, caller: { kind: 'replaceIfVersion', version: V } })
ok(decideWriteIntent(oCaller).intent === undefined, '目录外 + 调用方有意图：仍返回 undefined（不占单槽）', show(decideWriteIntent(oCaller)))
ok(decideWriteIntent(oCaller).reason === 'outside_memory', '理由仍是 outside_memory（连看都不看 caller）')
ok(decideEditGuard({ ...oCaller, caller: { version: V } }).guard === undefined, '编辑侧同理：目录外不占槽')
// 「唯一防线」的正面压力测试：宿主对**任何**工具写入都派发这个事件（实测那一次的目标就在
// 记忆目录之外），所以拿一批形状各异的目录外目标过一遍 —— 必须一律「什么都不改」。
const outsideTargets = [
  '/tmp/scratch/notes.md',
  '/srv/notes/other/doc.md',
  `${MEM}-evil/a.md`,
  '/srv/notes/memory2/a.md',
  MEM,
  'relative/a.md',
  '/',
]
const outsideLeak = []
for (const target of outsideTargets) {
  const f = { memoryPath: memoryPathOf(target, MEM), exists: true, version: V, caller: { kind: 'replaceIfVersion', version: V } }
  const w = decideWriteIntent(f)
  const e = decideEditGuard(f)
  if (w.intent !== undefined || w.reason !== 'outside_memory' || e.guard !== undefined || e.reason !== 'outside_memory') {
    outsideLeak.push(`${target} → ${show(w)} / ${show(e)}`)
  }
}
ok(outsideLeak.length === 0,
  '七个目录外目标（临时目录 / 兄弟目录 / 前缀陷阱 / 短名兄弟 / 记忆目录本身 / 相对路径 / 根）一律 undefined + outside_memory',
  outsideLeak.join(' | '))
ok(decideWriteIntent({ memoryPath: memoryPathOf('C:\\Users\\someone\\memory-evil\\a.md', MEM_WIN), exists: false }).reason === 'outside_memory',
  'Windows 形状的前缀陷阱也不管')
ok(decideWriteIntent({ memoryPath: memoryPathOf('C:\\Users\\someone\\memory\\a.md', MEM_WIN), exists: false }).reason === 'created',
  'Windows 形状的目录内正常进判定')

console.log('== 3. 尊重调用方：caller_wins 原样透传 ==')
const callerIntent = { kind: 'replaceIfVersion', version: 'caller-owned-version' }
const cw = decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: V, caller: callerIntent }))
ok(cw.reason === 'caller_wins' && cw.intent === callerIntent, '非空 caller → 原样透传（同一个对象，不是复制）', show(cw))
const callerGuard = { version: 'caller-owned-version' }
ok(decideEditGuard(factsFor(`${MEM}/a.md`, { exists: true, version: V, caller: callerGuard })).guard === callerGuard,
  '编辑守卫同样原样透传（对象同一）')
ok(decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: false, caller: callerIntent })).reason === 'caller_wins',
  'caller 优先于「不存在」分支')
ok(decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: null, caller: callerIntent })).reason === 'caller_wins',
  'caller 优先于「存在但无版本」分支（我们不替他判 unknown）')
ok(decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: V, caller: { kind: 'createIfAbsent' } })).intent.kind === 'createIfAbsent',
  '调用方要 createIfAbsent 也照传（不多嘴改他的意图）')
ok(decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: V, caller: { kind: 'createIfAbsent' } })).reason === 'caller_wins',
  '理由仍是 caller_wins')
ok(decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: false, caller: undefined })).reason === 'created', 'caller: undefined 当「没给」')
ok(decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: false, caller: null })).reason === 'created', 'caller: null 当「没给」')

console.log('== 4. created / no_version：不存在时只给 createIfAbsent ==')
const created = decideWriteIntent(factsFor(`${MEM}/new_note.md`, { exists: false, version: null }))
ok(created.reason === 'created' && created.intent !== undefined && created.intent.kind === 'createIfAbsent',
  '明确不存在 → created + createIfAbsent', show(created))
ok(show(created.intent) === '{"kind":"createIfAbsent"}', '意图只有 kind 一个字段')
ok(decideEditGuard(factsFor(`${MEM}/new_note.md`, { exists: false })).reason === 'created' &&
  decideEditGuard(factsFor(`${MEM}/new_note.md`, { exists: false })).guard === undefined,
  '编辑侧：目标不存在 → 无守卫（创建与否不由我们替宿主决定）')
// 「调用方确实没给 exists 字段」时的确定答案。⚠️ 生产接线不走这条：它自己区分「探到不存在」
// 与「探不到」，后者直接不碰（见 section 11 钉的那条用法边界）。
const noVersion = decideWriteIntent({ memoryPath: { ok: true, canon: `${MEM}/a.md`, name: 'a.md' } })
ok(noVersion.reason === 'no_version' && noVersion.intent.kind === 'createIfAbsent',
  'exists 字段缺失（不确知存在）且无版本 → no_version + createIfAbsent', show(noVersion))
ok(decideWriteIntent({ memoryPath: { ok: true, canon: `${MEM}/a.md`, name: 'a.md' }, exists: 'yes' }).reason === 'no_version',
  'exists 不是布尔 → 按「不确知」处理，不猜')
ok(decideEditGuard({ memoryPath: { ok: true, canon: `${MEM}/a.md`, name: 'a.md' } }).reason === 'no_version' &&
  decideEditGuard({ memoryPath: { ok: true, canon: `${MEM}/a.md`, name: 'a.md' } }).guard === undefined,
  '编辑侧的 no_version 同样不给守卫')

console.log('== 5. guarded：版本原样透传（不透明值，不解析）==')
const g = decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: V }))
ok(g.reason === 'guarded' && g.intent.kind === 'replaceIfVersion' && g.intent.version === V,
  '存在 + 有版本 → replaceIfVersion，版本原样', show(g))
ok(Object.keys(g.intent).sort().join(',') === 'kind,version', '意图只有 kind 与 version 两个字段', show(g.intent))
const numericLike = decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: '42' }))
ok(numericLike.intent.version === '42' && typeof numericLike.intent.version === 'string',
  '看起来像数字的版本不许被当数字（仍是字符串 "42"）', show(numericLike.intent))
const weird = decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: 'sha256:DEAD-beef::0001' }))
ok(weird.intent.version === 'sha256:DEAD-beef::0001', '不解析、不改写：怪字符串照样原样')
const eg = decideEditGuard(factsFor(`${MEM}/a.md`, { exists: true, version: V }))
ok(eg.reason === 'guarded' && eg.guard.version === V, '编辑 → {version}，版本同一', show(eg))
ok(Object.keys(eg.guard).length === 1 && Object.keys(eg.guard)[0] === 'version', '守卫对象只有一个 version 键', show(eg.guard))

console.log('== 6. unknown：存在但拿不到版本，绝不退化 ==')
const u = decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: null }))
ok(u.reason === 'unknown' && u.intent === undefined, '存在但没有版本 → unknown + 无意图', show(u))
ok(!(u.intent && u.intent.kind === 'createIfAbsent'),
  '**不许**退化成 createIfAbsent（「覆盖这份内容」与「只在不存在时写」是两回事）')
ok(decideEditGuard(factsFor(`${MEM}/a.md`, { exists: true, version: null })).reason === 'unknown' &&
  decideEditGuard(factsFor(`${MEM}/a.md`, { exists: true, version: null })).guard === undefined,
  '编辑侧同样 unknown + 无守卫')
ok(decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: '' })).reason === 'unknown', '空串版本当「拿不到版本」')
ok(decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: 42 })).reason === 'unknown', '非字符串版本当「拿不到版本」（不解析）')
ok(decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: {} })).reason === 'unknown', '对象版本同样不认')
ok(decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: V })).intent.kind === 'replaceIfVersion',
  '对照：有版本时同一条事实给的是守护（证明上面那条不是永远 unknown）')

console.log('== 7. facts 缺失 / 不抛 / 返回形状 ==')
const missing = [
  ['facts 是 undefined', undefined],
  ['facts 是 null', null],
  ['facts 是字符串', 'nope'],
  ['facts 是数字', 7],
  ['facts 是空对象', {}],
  ['memoryPath 不是对象', { memoryPath: 'x', exists: false, version: V }],
  ['memoryPath.ok 不是布尔', { memoryPath: { ok: 'yes' }, exists: false, version: V }],
  ['memoryPath 是 null 且没有 path', { memoryPath: null, exists: false, version: V }],
]
for (const [label, f] of missing) {
  const w = decideWriteIntent(f)
  const e = decideEditGuard(f)
  ok(w.reason === 'unknown' && w.intent === undefined && e.reason === 'unknown' && e.guard === undefined,
    `${label} → unknown + undefined，不抛`)
}
const hostile = { get memoryPath() { throw new Error('boom') } }
let hostileThrew = null
let hostileW = null
let hostileE = null
try {
  hostileW = decideWriteIntent(hostile)
  hostileE = decideEditGuard(hostile)
} catch (err) {
  hostileThrew = err
}
ok(hostileThrew === null && hostileW.reason === 'unknown' && hostileE.reason === 'unknown',
  'facts 的 getter 抛错 → 不抛，按 unknown 处理', hostileThrew ? hostileThrew.message : show([hostileW, hostileE]))

console.log('== 8. 复用 paths.js：memoryPath 与 {path, memoryDir} 两条入口同判 ==')
const viaPath = decideWriteIntent({ path: `${MEM}/a.md`, memoryDir: MEM, exists: true, version: V })
const viaMP = decideWriteIntent(factsFor(`${MEM}/a.md`, { exists: true, version: V }))
ok(show(viaPath) === show(viaMP), '便捷入口 {path, memoryDir} 与现成 memoryPath 结果逐字相同', `${show(viaPath)} vs ${show(viaMP)}`)
ok(decideWriteIntent({ path: `${MEM}/a.md`, memoryDir: MEM, exists: false }).reason === 'created', '便捷入口：目录内不存在 → created')
ok(decideWriteIntent({ path: `${MEM}-evil/a.md`, memoryDir: MEM, exists: false }).reason === 'outside_memory',
  '便捷入口的前缀陷阱 → outside_memory')
ok(decideWriteIntent({ path: '/srv\\notes\\memory\\a.md', memoryDir: '/srv/notes/memory', exists: true, version: V }).reason === 'guarded',
  '分隔符形状不同也同判（判据来自 paths.js，与平台无关）')
ok(decideWriteIntent({ path: 'relative/a.md', memoryDir: MEM, exists: false }).reason === 'outside_memory', '相对路径 → 不管')
ok(decideWriteIntent({ path: `${MEM}/a.md`, memoryDir: '/', exists: false }).reason === 'outside_memory',
  '记忆目录是文件系统根 → 不管（paths.js 的根保护）')
ok(decideWriteIntent({ path: String.raw`C:\Users\someone\memory\a.md`, memoryDir: MEM_WIN, exists: true, version: V }).reason === 'guarded',
  'Windows 形状的目录内正常守护')
const both = decideWriteIntent({ memoryPath: { ok: true, canon: `${MEM}/a.md`, name: 'a.md' }, path: '/srv/notes/other/x.md', memoryDir: MEM, exists: false })
ok(both.reason === 'created', '给了 memoryPath 时以它为准（path 只是便捷入口，不参与）')

console.log('== 9. 没有 deny：写入意图只有两种形状 ==')
const matrix = [
  factsFor(`${MEM}/a.md`, { exists: true, version: V }),
  factsFor(`${MEM}/a.md`, { exists: true, version: null }),
  factsFor(`${MEM}/a.md`, { exists: false, version: null }),
  factsFor(`${MEM}/a.md`, { exists: false }),
  { memoryPath: { ok: true, canon: `${MEM}/a.md`, name: 'a.md' } },
  factsFor(`${MEM}/a.md`, { exists: true, version: V, caller: callerIntent }),
  factsFor(`${MEM}/a.md`, { exists: true, version: V, caller: callerGuard }),
  outsideFacts,
  undefined,
]
const badIntents = []
const badGuards = []
const seenReasons = new Set()
for (const f of matrix) {
  const w = decideWriteIntent(f)
  const e = decideEditGuard(f)
  seenReasons.add(w.reason)
  seenReasons.add(e.reason)
  if (Object.keys(w).sort().join(',') !== 'intent,reason') badIntents.push(show(w))
  if (Object.keys(e).sort().join(',') !== 'guard,reason') badGuards.push(show(e))
  // 同编辑侧：caller_wins 的意图是调用方自己的对象，我们不检查它的形状（只保证我们构造的那种）。
  if (w.reason !== 'caller_wins' && w.intent !== undefined) {
    const i = w.intent
    if (!i || typeof i !== 'object') badIntents.push(show(w))
    else if (i.kind === 'createIfAbsent' && Object.keys(i).length === 1) { /* ok */ }
    else if (i.kind === 'replaceIfVersion' && typeof i.version === 'string' && Object.keys(i).length === 2) { /* ok */ }
    else badIntents.push(show(w))
  }
  // caller_wins 时守卫是**调用方自己的对象**，原样透传、我们碰都没碰 —— 它的形状由调用方负责，
  // 不在这条断言的管辖范围里（本函数只保证「我们自己构造的守卫」长成 {version}）。
  if (e.reason !== 'caller_wins' && e.guard !== undefined && !(e.guard && typeof e.guard === 'object' && typeof e.guard.version === 'string' && Object.keys(e.guard).length === 1)) {
    badGuards.push(show(e))
  }
}
ok(badIntents.length === 0, '写入侧返回恰好 {intent, reason}，意图只可能是 createIfAbsent / replaceIfVersion / undefined（没有 deny 这类发明）', badIntents.join(' | '))
ok(badGuards.length === 0, '编辑侧返回恰好 {guard, reason}，守卫只可能是 {version} / undefined', badGuards.join(' | '))

console.log('== 10. 六个 reason 全部被覆盖 ==')
const seenSorted = [...seenReasons].sort()
ok(show(seenSorted) === show([...GATE_REASONS].sort()), `GATE_REASONS 每个都有用例走到（实际 ${seenSorted.join(', ')}）`)

console.log('== 11. 源码级：`exists` 的用法边界写进了注释 ==')
// `no_version` 会给 createIfAbsent，所以「探不到」被写成 `exists: false` 就是一次误拦。
// 这条用法边界没有行为可断言（它是调用方的责任，生产接线自己短路），只能钉在文档面上 ——
// 与 observe-test 里钉「atime 不许当证据 / pwsh 是盲区」同一手法。
const src = await readFile(new URL('../lib/memory/write-gate.js', import.meta.url), 'utf8')
ok(/误拦/.test(src), '「探不到 → createIfAbsent 会误拦」写进了模块注释')
ok(/探不到/.test(src) && /ENOENT/.test(src), '「探不到不是 false，只有明确 ENOENT 才是 false」写进了注释')
ok(/return next\(\)/.test(src), '「不管时要 return next() 放行」写进了注释（waterfall 放行的坑）')

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
