#!/usr/bin/env node
/**
 * checkpoint.js 的断言（2026-10-15 建）—— 任务检查点的读写、防穿越与「有证据才算完成」。
 *
 * 为什么单开一个套件：本套件要**在系统临时目录里真写文件**（原子写后读回、坏文件、
 * 体积闸门、IO 失败），与纯函数套件不是一类。
 *
 * 两组反向对照是本套件的重点（只测「会报错」是不够的）：
 *   · 「已完成但没证据」会被抓出来 ↔ 真带证据的条目**不**被误抓；
 *   · 缺节会报 ↔ 六节齐全且有内容时 `missing` 为空；
 *   · 有标题没内容算缺 ↔ 有标题有内容不算缺。
 *
 * 三个前提：
 *   1. 一律传 `stateRoot` 参数（不去动模块顶层的 STATE_ROOT 环境变量）；
 *   2. 只碰 mkdtemp 出来的临时目录，不碰任何真实记忆 / 状态目录；
 *   3. 夹具一律合成：本仓库是公开仓库，不许出现真实记忆内容或本机路径。
 *
 * 用法: node test/checkpoint-test.mjs
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { STATE_ROOT } from '../lib/memory/config.js'
import {
  CHECKPOINT_FILE_NAME,
  CHECKPOINT_MAX_BYTES,
  CHECKPOINT_SECTIONS,
  EVIDENCE_MARKERS,
  TASKS_DIR_NAME,
  checkpointHandleText,
  checkpointPathFor,
  hasEvidence,
  normalizeTaskId,
  parseCheckpoint,
  readCheckpoint,
  renderCheckpoint,
  writeCheckpoint,
} from '../lib/memory/checkpoint.js'

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

/** 断言一段调用不抛，且返回值的形状对（「绝不抛」这类契约要单独测）。 */
const noThrow = (fn, name) => {
  try {
    const v = fn()
    return v
  } catch (err) {
    ok(false, name, `抛了：${err?.message}`)
    return undefined
  }
}

const world = await mkdtemp(join(tmpdir(), 'sage-mem-checkpoint-'))
const stateRoot = join(world, 'state')
const tasksRoot = join(stateRoot, TASKS_DIR_NAME)

/** 造一份手写检查点：能精确控制「哪几节有内容」。 */
const mkText = (sections, meta = ['- 任务：t1', '- 项目：合成项目', '- revision：1']) =>
  ['# 任务检查点 t1', '', ...meta, '', ...CHECKPOINT_SECTIONS.flatMap((s) => [`## ${s}`, '', sections[s] ?? '', ''])].join(
    '\n',
  )

// ────────────────────────── 1. 冻结常量 ──────────────────────────

console.log('== 1. 冻结常量 ==')
ok(TASKS_DIR_NAME === 'tasks' && CHECKPOINT_FILE_NAME === 'WORKING.md', '目录名与文件名取冻结值')
ok(CHECKPOINT_MAX_BYTES === 64 * 1024, `上限 64 KB（实际 ${CHECKPOINT_MAX_BYTES}）`)
ok(Object.isFrozen(CHECKPOINT_SECTIONS) && CHECKPOINT_SECTIONS.length === 6, 'CHECKPOINT_SECTIONS 冻结且是六节')
ok(
  JSON.stringify(CHECKPOINT_SECTIONS) ===
    JSON.stringify(['目标与约束', '已完成与证据', '未完成', '关键决定', '记忆引用', '待核实']),
  '六节名称与顺序冻结（顺序即模板顺序，改它会让既有检查点全部「缺节」）',
  JSON.stringify(CHECKPOINT_SECTIONS),
)

// ────────────────────────── 2. normalizeTaskId ──────────────────────────

console.log('== 2. normalizeTaskId：单段字符类，判据与平台无关 ==')
for (const good of ['a', 'task-1', 'T-1.2_3', 'a..b', '.hidden', '0', 'x'.repeat(64)]) {
  ok(normalizeTaskId(good) === good, `合法 id 原样通过：${JSON.stringify(good)}`)
}
for (const bad of [
  '',
  ' ',
  '../x',
  '..',
  '.',
  './a',
  'a/',
  '/a',
  'a/b',
  'a\\b',
  '..\\x',
  'a:b',
  'a b',
  'a\tb',
  'a\nb',
  '汉字',
  'x'.repeat(65),
  '...',
]) {
  ok(normalizeTaskId(bad) === null, `非法 id 返回 null：${JSON.stringify(bad)}`)
}
for (const bad of [42, null, undefined, true, [], {}, () => {}]) {
  ok(normalizeTaskId(bad) === null, `非字符串一律 null：${String(bad)}`)
}
ok(
  normalizeTaskId('a\\b') === null && normalizeTaskId('a/b') === null && normalizeTaskId('a\\b') === normalizeTaskId('a/b'),
  '`\\` 与 `/` 判成同一结果：字符类判定不走 basename —— Windows 当分隔符、Linux 不当，结论必须一致',
)
ok(normalizeTaskId(' x ') === null, '不 trim：路径两端的空格在 Windows 会被静默裁掉、Linux 不会，帮忙归一化=造出平台差异')

// ── 平台身份一致的另外两类（Windows 会静默改掉、Linux 不会）──
// 尾随点：Windows 上 `a.` 与 `a` 是**同一个**目录项，Linux 上是两个不同目录。
// 「同一个 id 在两个平台指向不同文件夹」与本仓库刚修掉的 `\` 缺陷同源，所以无条件拒。
ok(normalizeTaskId('a.') === null && normalizeTaskId('..a') !== null,
  '尾随点被拒（Windows 会静默吃掉它 → 与不带点的 id 撞成同一个目录）')
ok(normalizeTaskId('a.b.') === null, '尾随点判定不管前面有几个点')
// Windows 保留设备名：`tasks/CON` 在这个平台上建不出来，Linux 上正常。
for (const reserved of ['CON', 'con', 'PRN', 'NUL', 'COM1', 'com9', 'LPT1', 'AUX']) {
  ok(normalizeTaskId(reserved) === null, `Windows 保留设备名被拒：${reserved}`)
}
ok(normalizeTaskId('CON.md') === null, '保留名带扩展名同样拒（Windows 上 `CON.md` 也是设备名）')
ok(normalizeTaskId('CONSOLE') !== null && normalizeTaskId('com10') !== null,
  '反向对照：不是保留名的相似串照收（`CONSOLE` / `com10`）')

ok(normalizeTaskId('x'.repeat(64)) !== null && normalizeTaskId('x'.repeat(65)) === null, '长度闸门正好卡在 64')

// ────────────────────────── 3. checkpointPathFor ──────────────────────────

console.log('== 3. checkpointPathFor：不越界 ==')
ok(
  checkpointPathFor('task-1', stateRoot) === join(stateRoot, TASKS_DIR_NAME, 'task-1', CHECKPOINT_FILE_NAME),
  '路径形状 <状态根>/tasks/<id>/WORKING.md',
  String(checkpointPathFor('task-1', stateRoot)),
)
ok(
  checkpointPathFor('../x', stateRoot) === null &&
    checkpointPathFor('a\\b', stateRoot) === null &&
    checkpointPathFor('', stateRoot) === null &&
    checkpointPathFor(42, stateRoot) === null,
  '非法 id 连路径都拿不到（在 IO 之前就拦住）',
)
ok(checkpointPathFor('..', stateRoot) === null, '`..` 单独拒：字符合法但语义是跳出 tasks 目录')
ok(
  checkpointPathFor('t1') === join(STATE_ROOT, TASKS_DIR_NAME, 't1', CHECKPOINT_FILE_NAME),
  'stateRoot 缺省用 config.js 的 STATE_ROOT',
)
ok(
  checkpointPathFor('t1', '') === checkpointPathFor('t1'),
  'stateRoot 传空串 → 回落默认值（不给「写到相对当前目录」的机会）',
)
{
  let escaped = null
  for (const id of ['a', '.hidden', 'a..b', 'x'.repeat(64)]) {
    const full = checkpointPathFor(id, stateRoot)
    if (!full.startsWith(join(stateRoot, TASKS_DIR_NAME) + sep)) escaped = full
  }
  ok(escaped === null, '所有合法 id 的路径都落在 <状态根>/tasks/ 之下', String(escaped))
}

// ────────────────────────── 4. renderCheckpoint ──────────────────────────

console.log('== 4. renderCheckpoint：六节齐全、缺的渲染成（待补）==')
const fullInput = {
  taskId: 'task-1',
  project: '合成夹具项目',
  revision: 3,
  goal: '把检查点的读写与证据校验跑通。',
  constraints: ['只动 checkpoint.js 与 checkpoint-test.mjs', '夹具一律合成'],
  done: ['写完 `lib/memory/checkpoint.js`，`node test/checkpoint-test.mjs` 结果：12 passed, 0 failed'],
  todo: ['补一条「六节齐全不报缺节」的反向对照'],
  decisions: ['证据判据做成数据表（EVIDENCE_MARKERS），便于解释与断言'],
  refs: ['docs/decisions.md:236'],
  toVerify: ['64 字符 taskId 的短句柄是否仍 ≤ 160 字节'],
}
const fullText = renderCheckpoint(fullInput)
{
  const idx = CHECKPOINT_SECTIONS.map((s) => fullText.indexOf(`## ${s}`))
  ok(
    idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]),
    '六个节标题都在，且顺序与 CHECKPOINT_SECTIONS 一致',
    JSON.stringify(idx),
  )
  ok(
    fullText.includes('- 任务：task-1') && fullText.includes('- 项目：合成夹具项目') && fullText.includes('- revision：3'),
    '元信息三行都在（任务 / 项目 / revision）',
  )
  ok(fullInput.constraints.every((c) => fullText.includes(`- ${c}`)), '数组字段逐条渲染成 bullet')
  ok(fullText.endsWith('\n'), '结尾留一个换行（追加 / diff 都更干净）')
}
{
  const blank = renderCheckpoint({ taskId: 'blank' })
  const bodies = blank
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((h) => h.replace(/^##\s+/, ''))
  ok(bodies.length === 6, '空输入也照样渲染出六节（模板不是「有什么写什么」）')
  ok(
    CHECKPOINT_SECTIONS.every((s) => blank.includes(`## ${s}`)) && (blank.match(/（待补）/g) ?? []).length >= 6,
    '缺的字段渲染成「（待补）」而不是空行',
  )
  ok(renderCheckpoint(null).includes('## 目标与约束') && typeof renderCheckpoint(undefined) === 'string', '入参 null/undefined 不抛，仍回模板')
  ok(renderCheckpoint({ taskId: 'x', revision: -1 }).includes('- revision：0'), 'revision 非法 → 按 0（metadata 必须可被解析回整数）')
}

// ────────────────────────── 5. 往返解析（六节齐全的正向对照）──────────────────────────

console.log('== 5. 往返：六节齐全 + 全部带证据 ==')
{
  const cp = parseCheckpoint(fullText)
  ok(cp.malformedReason === '', '完整检查点不算坏文件', cp.malformedReason)
  ok(cp.taskId === 'task-1' && cp.project === '合成夹具项目' && cp.revision === 3, '任务 / 项目 / revision 都解析回来', JSON.stringify({ t: cp.taskId, p: cp.project, r: cp.revision }))
  ok(cp.missing.length === 0, '六节齐全且有内容 → missing 为空（反向对照：不是「永远报缺」）', JSON.stringify(cp.missing))
  ok(
    cp.claimsDoneWithoutEvidence.length === 0,
    '真带证据的已完成条目不误抓（反向对照：判据不是「见 已完成 就报」）',
    JSON.stringify(cp.claimsDoneWithoutEvidence),
  )
  ok(cp.hasNextStep === true, '未完成里有具体动作 → hasNextStep true')
  ok(
    CHECKPOINT_SECTIONS.every((s) => typeof cp.sections[s] === 'string') && Object.keys(cp.sections).length === 6,
    'sections 六键齐全且都是字符串（调用方不必判 undefined）',
  )
  ok(
    Object.keys(cp).sort().join(',') ===
      ['taskId', 'project', 'revision', 'sections', 'missing', 'claimsDoneWithoutEvidence', 'hasNextStep', 'malformedReason'].sort().join(','),
    '返回键与冻结契约一致',
    JSON.stringify(Object.keys(cp)),
  )
  ok(
    cp.sections['已完成与证据'].includes('node test/checkpoint-test.mjs') && cp.sections['目标与约束'].includes('把检查点的读写'),
    '节正文按标题切分，落到正确的节里',
  )
}

// ────────────────────────── 6. missing 的两面 ──────────────────────────

console.log('== 6. missing：缺节会报 / 齐全不报 / 有标题没内容也算缺 ==')
{
  const partial = parseCheckpoint(mkText({ '已完成与证据': '- 写完了 `lib/memory/checkpoint.js`' }))
  const expect = CHECKPOINT_SECTIONS.filter((s) => s !== '已完成与证据')
  ok(JSON.stringify(partial.missing) === JSON.stringify(expect), '只有一节有内容 → 另外五节按模板顺序报缺', JSON.stringify(partial.missing))

  const headingsOnly = parseCheckpoint(mkText({}))
  ok(
    headingsOnly.missing.length === 6,
    '六节标题都在、内容全空 → 六节全报缺（有标题 ≠ 有内容）',
    JSON.stringify(headingsOnly.missing),
  )

  const allFilled = parseCheckpoint(
    mkText(
      Object.fromEntries(
        CHECKPOINT_SECTIONS.map((s, i) => [s, `第 ${i + 1} 节的真实内容。`]),
      ),
    ),
  )
  ok(allFilled.missing.length === 0, '六节都有一段实义内容 → missing 为空（齐全不报）', JSON.stringify(allFilled.missing))

  const placeholderOnly = parseCheckpoint(mkText({ '未完成': '- （待补）' }))
  ok(placeholderOnly.missing.length === 6, '节里只有占位符 → 仍算缺（占位符不是内容）', JSON.stringify(placeholderOnly.missing))

  const blankRender = parseCheckpoint(renderCheckpoint({ taskId: 'blank' }))
  ok(blankRender.missing.length === 6, '刚渲染出来的空模板：六节全缺 —— 格式完美不等于内容完整')
  ok(blankRender.malformedReason === '', '有身份、没内容 → 可读但不完整（「缺内容」与「读不出骨架」是两件事）')
  ok(
    parseCheckpoint(renderCheckpoint({})).malformedReason !== '',
    '连任务 id 都还是占位符的模板 → 算「读不出骨架」',
  )

  const subHeading = parseCheckpoint(mkText({ '关键决定': '### 子标题\n\n决定：先守住「没有证据不算完成」。' }))
  ok(subHeading.missing.length === 5 && !subHeading.missing.includes('关键决定'), '节内的 `###` 小标题算内容，不算节边界')
  ok(subHeading.sections['关键决定'].includes('### 子标题'), '`###` 小标题留在节正文里（没被当成新的节）')
}

// ────────────────────────── 7. claimsDoneWithoutEvidence 的两面 ──────────────────────────

console.log('== 7. 「已完成但没证据」会被抓 / 带证据的不会 ==')
const bareClaims = ['整理了一遍文档', '功能已经准备完成', '测试过了，没问题']
const evidenceClaims = [
  '写完 `lib/memory/checkpoint.js`，`node test/checkpoint-test.mjs` 结果：12 passed, 0 failed',
  '体积闸门落在 lib/memory/checkpoint.js:120',
  '上游行为按 https://example.com/spec 对齐',
  '落地在 commit 4f2a1c9',
  '渲染体积：4128 字节',
]
{
  const caught = parseCheckpoint(renderCheckpoint({ taskId: 'c1', done: bareClaims, todo: ['接着写'] }))
  ok(
    JSON.stringify(caught.claimsDoneWithoutEvidence) === JSON.stringify(bareClaims),
    '三条「声称完成、没有任何证据」全部被抓出来（顺序保持）',
    JSON.stringify(caught.claimsDoneWithoutEvidence),
  )

  const mixed = renderCheckpoint({ taskId: 'c2', done: [evidenceClaims[0], bareClaims[0]], todo: ['接着写'] })
  ok(
    JSON.stringify(parseCheckpoint(mixed).claimsDoneWithoutEvidence) === JSON.stringify([bareClaims[0]]),
    '混合项里只抓没证据的那条（不是「有一条没证据就整节作废」）',
    JSON.stringify(parseCheckpoint(mixed).claimsDoneWithoutEvidence),
  )

  ok(
    parseCheckpoint(renderCheckpoint({ taskId: 'c3' })).claimsDoneWithoutEvidence.length === 0,
    '空模板没有任何「已完成」声明 → 一条都不报（占位符不是声明）',
  )

  const carried = mkText({
    '已完成与证据': '- 改完两个文件\n  验证：`node test/checkpoint-test.mjs` 结果：12 passed, 0 failed',
  })
  ok(parseCheckpoint(carried).claimsDoneWithoutEvidence.length === 0, '证据写在续行里也算数（续行并入上一条，不把证据判丢）')

  ok(
    evidenceClaims.every((s) => EVIDENCE_MARKERS.some((m) => m.pattern.test(s))),
    '五条对照证据分别命中导出表里的标记（判据是数据，能被逐条核对）',
  )
  ok(bareClaims.every((s) => !hasEvidence(s)), '三条「没证据」的说法对全表都不命中 —— 「测试过了」刻意不算证据')
  ok(
    evidenceClaims.every((s) => hasEvidence(s) === EVIDENCE_MARKERS.some((m) => m.pattern.test(s))),
    'hasEvidence 就是「表里有任意一条命中」，没有第二套隐藏判据',
  )
  ok(
    Object.isFrozen(EVIDENCE_MARKERS) &&
      EVIDENCE_MARKERS.length >= 6 &&
      EVIDENCE_MARKERS.every((m) => typeof m.id === 'string' && typeof m.label === 'string' && m.pattern instanceof RegExp),
    'EVIDENCE_MARKERS 是冻结数据表（id / label / pattern 三栏，可展示「凭什么算证据」）',
  )
  ok(hasEvidence('') === false && hasEvidence(null) === false && hasEvidence(undefined) === false, '空值不命中，且不抛')
}

// ────────────────────────── 8. hasNextStep 的两面 ──────────────────────────

console.log('== 8. hasNextStep：有下一件事 / 明确没有下一件事 ==')
{
  const next = (todo) => parseCheckpoint(mkText({ 未完成: todo })).hasNextStep
  ok(next('- 补边界断言') === true, '写了具体动作 → true')
  ok(next('- 把 `lib/memory/checkpoint.js` 的证据判据接进面板') === true, '带路径的动作 → true')
  ok(next('- 无') === false, '「无」→ false')
  ok(next('- 暂无') === false, '「暂无」→ false')
  ok(next('- 无剩余工作') === false, '「无剩余工作」→ false（前缀式收尾声明同样不算下一件事）')
  ok(next('- 没有其他待办了') === false, '「没有其他待办了」→ false')
  ok(next('- （待补）') === false, '占位符 → false')
  ok(next('') === false, '节是空的 → false')
  ok(parseCheckpoint(mkText({})).hasNextStep === false, '没有「未完成」这一节 → false')
  ok(next('- 无\n- 补一条边界断言') === true, '「无」与真动作混排时，只要有一条真动作就是 true')
  ok(parseCheckpoint(fullText).hasNextStep === true, '完整夹具（有一条待办）→ true')
}

// ────────────────────────── 9. malformed：坏文件不抛 ──────────────────────────

console.log('== 9. malformed：读不出骨架 → 报原因，绝不抛 ==')
{
  const badCases = [
    [42, '内容不是文本'],
    ['', '空内容'],
    ['   \n  \n', '空内容（只剩空白）'],
    ['这不是检查点，只是一段随便的文本。', '缺任务标记'],
    ['# 任务检查点\n\n## 已完成与证据\n\n- 写完了\n', '缺任务标记'],
    ['- 任务：t1\n- revision：abc\n\n## 未完成\n\n- 接着写\n', 'revision 不是整数'],
    ['- 任务：t1\n- revision：99999999999999999999\n', 'revision 超出安全整数'],
  ]
  for (const [text, label] of badCases) {
    const r = noThrow(() => parseCheckpoint(text), `${label}：不抛`)
    if (!r) continue
    const keysOk = ['taskId', 'project', 'revision', 'sections', 'missing', 'claimsDoneWithoutEvidence', 'hasNextStep', 'malformedReason'].every((k) => k in r)
    ok(
      r.malformedReason !== '' && typeof r.revision === 'number' && keysOk && Object.keys(r.sections).length === 6,
      `${label} → malformedReason 非空且形状完整`,
      JSON.stringify(r).slice(0, 160),
    )
  }
  ok(parseCheckpoint(42).malformedReason === '内容不是文本', '非字符串的原因文案确定')
  ok(parseCheckpoint('# 随便一段\n- 任务：t1\n\n## 未完成\n\n- 接着写\n').malformedReason === '', '只要任务标记在，标题写得随意也照样可读（容忍排版，不允许缺身份）')
  ok(parseCheckpoint(fullText).malformedReason === '', '正常夹具 malformedReason 为空（反向对照）')
}

// ────────────────────────── 10. 真落盘：写 / 读 / 闸门 / 原子性 ──────────────────────────

console.log('== 10. readCheckpoint / writeCheckpoint：真落盘 ==')
{
  const miss = await readCheckpoint('nope', { stateRoot })
  ok(miss.ok === false && miss.code === 'missing', '文件不存在 → missing', JSON.stringify(miss))
  ok((await readCheckpoint('../x', { stateRoot })).code === 'invalid', '非法 id → invalid（在 IO 之前）')
  ok((await readCheckpoint(42, { stateRoot })).code === 'invalid', '非字符串 id → invalid，不抛')

  const w1 = await writeCheckpoint('task-1', fullText, { stateRoot })
  ok(
    w1.ok === true && w1.bytes === Buffer.byteLength(fullText, 'utf8') && w1.path === checkpointPathFor('task-1', stateRoot),
    '写成功并回报 bytes（供调用方记账）与路径',
    JSON.stringify(w1),
  )
  const created = await readdir(join(tasksRoot, 'task-1')).catch(() => null)
  ok(created !== null && created.includes(CHECKPOINT_FILE_NAME), '任务目录被自动创建（调用方不必自己 mkdir）', String(created))
  ok(
    JSON.stringify(created) === JSON.stringify([CHECKPOINT_FILE_NAME]),
    '原子写之后目录里只剩 WORKING.md —— 没有 .tmp 垃圾（rename 成功后临时文件已被收尾）',
    JSON.stringify(created),
  )

  const r1 = await readCheckpoint('task-1', { stateRoot })
  ok(r1.ok === true && r1.text === fullText && r1.bytes === Buffer.byteLength(fullText, 'utf8'), '读回逐字相同', JSON.stringify({ ok: r1.ok, bytes: r1.bytes }))
  ok(r1.revision === 3 && r1.taskId === 'task-1' && r1.project === '合成夹具项目' && r1.missing.length === 0, '读回的对象里解析结果直接可用')
  ok(typeof r1.handle === 'string' && Buffer.byteLength(r1.handle, 'utf8') <= 160 && r1.handle.includes('task-1'), '读回时附带的短句柄可用且 ≤ 160 字节', r1.handle)

  const v4 = renderCheckpoint({ ...fullInput, revision: 4 })
  const w2 = await writeCheckpoint('task-1', v4, { stateRoot })
  const r2 = await readCheckpoint('task-1', { stateRoot })
  ok(w2.ok === true && r2.ok === true && r2.revision === 4 && r2.revision > r1.revision, '写下一版后 revision 递增（3 → 4）', JSON.stringify({ a: r1.revision, b: r2.revision }))
  ok(r2.text === v4 && r2.text !== fullText, '读回的是新版本（覆盖写，没有拼接旧内容）')

  const tooBig = await writeCheckpoint('big', 'x'.repeat(CHECKPOINT_MAX_BYTES + 1), { stateRoot })
  ok(tooBig.ok === false && tooBig.code === 'too_big' && tooBig.bytes === CHECKPOINT_MAX_BYTES + 1 && tooBig.limit === CHECKPOINT_MAX_BYTES, '超过上限被拒，并回报实际字节与上限', JSON.stringify(tooBig))
  ok((await readCheckpoint('big', { stateRoot })).code === 'missing', '被拒的那次**什么都没写**（不是「写了再报错」）')

  const exact = await writeCheckpoint('exact', 'x'.repeat(CHECKPOINT_MAX_BYTES), { stateRoot })
  ok(exact.ok === true && exact.bytes === CHECKPOINT_MAX_BYTES, '正好等于上限 → 允许（闸门是「超过」才拒）')
  ok((await readFile(checkpointPathFor('exact', stateRoot), 'utf8')).length === CHECKPOINT_MAX_BYTES, '磁盘上的字节数与回报一致')

  const noId = await writeCheckpoint('../x', fullText, { stateRoot })
  ok(noId.ok === false && noId.code === 'invalid', '写非法 id → invalid')
  const noText = await writeCheckpoint('t9', 42, { stateRoot })
  ok(noText.ok === false && noText.code === 'invalid' && (await readCheckpoint('t9', { stateRoot })).code === 'missing', '写非字符串正文 → invalid 且没落盘')

  const broken = await readCheckpoint('exact', { stateRoot })
  ok(broken.ok === false && broken.code === 'malformed' && broken.error !== '' && !('text' in broken), '磁盘上的坏文件 → malformed 带原因，且**不把正文交出去**', JSON.stringify(broken))

  await mkdir(join(tasksRoot, 'dirfile', CHECKPOINT_FILE_NAME), { recursive: true })
  const ioRead = await readCheckpoint('dirfile', { stateRoot })
  ok(ioRead.ok === false && ioRead.code === 'io_error' && ioRead.code !== 'missing', '路径落在目录上（EISDIR）→ io_error，不误报 missing', JSON.stringify(ioRead))

  await writeFile(join(tasksRoot, 'blocked'), 'x')
  const ioWrite = await writeCheckpoint('blocked', fullText, { stateRoot })
  ok(ioWrite.ok === false && ioWrite.code === 'io_error', '父路径被文件占住（ENOTDIR）→ io_error，不抛', JSON.stringify(ioWrite))

  await writeCheckpoint('mismatch', renderCheckpoint({ ...fullInput, taskId: 'other' }), { stateRoot })
  const mm = await readCheckpoint('mismatch', { stateRoot })
  ok(mm.ok === true && mm.taskId === 'mismatch' && mm.declaredTaskId === 'other' && mm.warnings.length === 1, '文件内声明的 id 与目录不一致 → 以目录为身份并给出警告（不静默采信标签）', JSON.stringify(mm.warnings))
  ok((await readCheckpoint('task-1', { stateRoot })).warnings.length === 0, '一致时没有警告（反向对照）')

  const weird = [undefined, null, 0, '', {}, { stateRoot: 42 }, { stateRoot: null }]
  let weirdBad = null
  for (const opts of weird) {
    try {
      const r = await readCheckpoint('task-1', opts)
      if (!r || typeof r.ok !== 'boolean') weirdBad = `opts=${JSON.stringify(opts)} → 形状不对`
    } catch (err) {
      weirdBad = `opts=${JSON.stringify(opts)} → 抛了：${err?.message}`
    }
  }
  ok(weirdBad === null, '一堆畸形 opts 全部返回对象、无异常', String(weirdBad))
}

// ────────────────────────── 11. checkpointHandleText ──────────────────────────

console.log('== 11. checkpointHandleText：一行、≤160 字节、说清怎么读 ==')
{
  const h1 = checkpointHandleText({ taskId: 'task-1', revision: 3, project: '合成夹具项目' })
  ok(Buffer.byteLength(h1, 'utf8') <= 160, `常用形状 ≤ 160 字节（实际 ${Buffer.byteLength(h1, 'utf8')}）`, h1)
  ok(!h1.includes('\n') && !h1.includes('\r'), '始终是一行（注入时不会被拆成多行）')
  ok(h1.includes('task-1') && h1.includes('revision 3') && h1.includes('WORKING.md'), '说清：哪个任务、revision 几、怎么读', h1)

  const longId = 'x'.repeat(64)
  const h2 = checkpointHandleText({ taskId: longId, revision: 12, project: '很长的项目名'.repeat(40) })
  ok(Buffer.byteLength(h2, 'utf8') <= 160, `极端形状（64 字符 id + 很长项目名）也 ≤ 160（实际 ${Buffer.byteLength(h2, 'utf8')}）`, h2)
  ok(h2.includes(longId) && h2.includes('revision 12'), '退化时 id 与 revision **不截断**（身份不能丢）')
  ok(!h2.includes('\uFFFD'), '按码点截断，不会留下半个汉字')
  ok(!h2.includes('\n'), '极端形状仍是一行')

  const h3 = checkpointHandleText({ taskId: 't9', revision: 0 })
  ok(h3.includes('revision 0') && Buffer.byteLength(h3, 'utf8') <= 160, '没有项目名也能用；revision 缺省按 0', h3)
  const h4 = checkpointHandleText({ taskId: 't9', revision: 1, project: '第一行\n第二行\t第三行' })
  ok(!h4.includes('\n') && !h4.includes('\t'), '项目名里的换行/制表符被压成空格（句柄不能被拆行）', h4)
  ok(checkpointHandleText({ taskId: '../x', revision: 1 }) === '', '非法 id → 空串（没有身份就不给句柄）')
  ok(checkpointHandleText({}) === '' && checkpointHandleText() === '', '缺 taskId 也不抛，返回空串')
  ok(checkpointHandleText({ taskId: 't1', revision: -5 }).includes('revision 0'), '非法 revision 按 0，不把负数写进句柄')
}

// ────────────────────────── 收尾 ──────────────────────────

await rm(world, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
