#!/usr/bin/env node
/**
 * 库健康「复制修复提示词」（2.6.0）—— 纯函数 + 复制路径 + 兜底模态。
 *
 * 为什么单独一个套件：这段逻辑是**生成给人拿去指挥智能体的文本**，它出错的方式不是
 * 崩溃，而是「少了一类问题 / 把 A 段写进 B 段 / 悄悄截断 / 没内容也冒一颗按钮」。
 * 那几种坏法都不会让界面报错，只会让智能体照着改错 —— 所以每条判据都盯**具体文本**，
 * 而不是「长度大于 0」。
 *
 * 三层：
 *   1. 纯函数：`buildHealthFixPrompt({report, conflicts})` —— 一颗按钮、两段内容
 *      （A 体检问题要修 / B 待裁决只判断），三种组合各自的开场白与分段标题
 *   2. 复制路径：Clipboard API → 隐藏 textarea + execCommand → false（绝不抛）
 *   3. 组件：兜底模态把文本摊出来、有关闭按钮、点了真的调 onClose
 *
 * 只依赖 node: 内置模块（组件层借 `_client-vm-harness.mjs` 的迷你 react）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeMiniReact, runFragments, findAll, findButton, byClass } from './_client-vm-harness.mjs'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const SHARD = 'client/56-health-prompt.js'
const SOURCE = readFileSync(fileURLToPath(new URL('../' + SHARD, import.meta.url)), 'utf8')

/** 从 shard 里取出要测的具名函数（分片是拼接用片段，不能直接 import）。 */
function loadShard(extra = {}) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, Object, Array, JSON, Math, String, Number, Boolean, Error, RegExp, isFinite,
    setTimeout, clearTimeout,
    ...extra,
  }
  sandbox.globalThis = sandbox
  const prelude = extra.react ? 'const h = react.createElement; const t = function (k) { return k; };\n' : ''
  return runFragments(
    [SHARD],
    [prelude + SOURCE],
    sandbox,
    `globalThis.__hp = { buildHealthFixPrompt, auditFixLines, conflictFixLines, copyPromptText,
       legacyCopyPrompt, PromptFallbackModal, AUDIT_SECTIONS, AUDIT_ARCHIVED_LINKS, AUDIT_PROMPT_MAX_ITEMS };`,
  ).__hp
}

// ── 夹具：形状照真实 auditMemoryDir() / conflict.list 的返回 ──────────────
const AUDIT = {
  dir: '/tmp/memory',
  fileCount: 12, skipped: 0, archivedCount: 2, indexEntries: 9, problems: 4,
  dangling: [{ file: 'dangling_one.md' }, { file: 'dangling_two.md' }],
  unlisted: [{ file: 'unlisted_one.md' }],
  typeMismatch: [],
  crlf: [],
  brokenLinks: [{ file: 'project_beta.md', target: 'not_there' }],
  archivedLinks: [{ file: 'reference_gamma.md', target: 'feedback_old' }],
  hashHazards: [],
  noFrontmatter: [],
  unreadable: [],
  strays: [],
}

const CLEAN = {
  dir: '/tmp/memory',
  fileCount: 12, skipped: 0, archivedCount: 2, indexEntries: 12, problems: 0,
  dangling: [], unlisted: [], typeMismatch: [], crlf: [], brokenLinks: [],
  archivedLinks: [{ file: 'reference_gamma.md', target: 'feedback_old' }],
  hashHazards: [], noFrontmatter: [], unreadable: [], strays: [],
}

const CONFLICTS = {
  counts: { open: 2, total: 3 },
  items: [
    { id: 'c1', kind: 'contradiction', status: 'open', file: 'user_a.md', otherFile: 'user_b.md', note: '部署地址两边不一致' },
    { id: 'c2', kind: 'stale_version', status: 'open', file: 'project_c.md', otherFile: '', note: '' },
    { id: 'c3', kind: 'contradiction', status: 'resolved', file: 'x.md', otherFile: 'y.md', note: '' },
    { id: 'c4', kind: 'contradiction', status: 'dismissed', file: 'z.md', otherFile: '', note: '' },
  ],
}

const hp = loadShard()

group('0. 前置：分片读得到东西、入口只有一个')
{
  ok(typeof SOURCE === 'string' && SOURCE.length > 500, `源分片读进来了（${SOURCE.length} 字符）`)
  ok(typeof hp.buildHealthFixPrompt === 'function', '导出了唯一入口 buildHealthFixPrompt')
  ok(typeof hp.auditFixLines === 'function' && typeof hp.conflictFixLines === 'function', '两段的正文生成各自可测')
  ok(typeof hp.copyPromptText === 'function' && typeof hp.legacyCopyPrompt === 'function', '导出了两条复制路径')
  ok(typeof hp.PromptFallbackModal === 'function', '导出了兜底模态组件')
  ok(hp.AUDIT_PROMPT_MAX_ITEMS === 50, `每类上限是 50（实际 ${hp.AUDIT_PROMPT_MAX_ITEMS}）`)
  // 一颗按钮就该只有一个提示词入口：旧的两个 build* 名字不许回来（否则面板会挑错那个）
  ok(typeof hp.buildAuditFixPrompt === 'undefined' && typeof hp.buildConflictFixPrompt === 'undefined',
    '不再有旧的 buildAuditFixPrompt / buildConflictFixPrompt（避免两套入口）')
}

group('1. 两段都有：开场白说清有两段，A / B 各自成段')
{
  const r = hp.buildHealthFixPrompt({ report: AUDIT, conflicts: CONFLICTS })
  const text = r ? r.text : ''
  ok(!!r && r.hasAudit === true && r.hasConflict === true, '两段都被标为「有」')
  ok(text.indexOf('这次两部分都有') >= 0, '开场白明说两部分都有')
  ok(text.indexOf('A · 体检问题') >= 0 && text.indexOf('B · 待裁决的矛盾') >= 0, 'A / B 两段各有分隔标题')
  ok(text.indexOf('A · 体检问题') < text.indexOf('B · 待裁决的矛盾'), 'A 在前、B 在后（先修再判断）')
  ok(text.indexOf('要修') >= 0 && text.indexOf('只做判断，不要改盘上的文件') >= 0,
    '开场白把两段的纪律先声明一遍')
  ok(text.indexOf('【索引悬空】') < text.indexOf('B · 待裁决的矛盾'),
    '体检的分类清单落在 A 段之内，没跑到 B 段那边')
  ok(text.indexOf('1. 矛盾 · user_a.md ↔ user_b.md') > text.indexOf('B · 待裁决的矛盾'),
    '冲突条目落在 B 段之内')
  ok(text.indexOf('记忆目录：/tmp/memory') >= 0, '带上记忆目录')
  ok((text.match(/记忆目录：/g) || []).length === 1, `记忆目录只出现一次（实际 ${(text.match(/记忆目录：/g) || []).length} 次）`)
  ok(r.count === 6, `count = 体检 4 + 冲突 2（实际 ${r ? r.count : 'null'}）`)
}

group('2. 只有体检：不出现 B 段，开场白说「没有待裁决」')
{
  const r = hp.buildHealthFixPrompt({ report: AUDIT, conflicts: { items: [] } })
  const text = r ? r.text : ''
  ok(!!r && r.hasAudit === true && r.hasConflict === false, '只有 A')
  ok(text.indexOf('这次只有 A') >= 0 && text.indexOf('没有待裁决的矛盾') >= 0, '开场白说清只有体检')
  ok(text.indexOf('B · 待裁决的矛盾') < 0, 'B 段整段不出现')
  ok(text.indexOf('【双链断链】') >= 0 && text.indexOf('- dangling_one.md') >= 0, 'A 段内容照旧')
  ok(r.count === 4, `count = 4（实际 ${r ? r.count : 'null'}）`)
}

group('3. 只有冲突：不出现 A 段，开场白说「体检没有问题」')
{
  const r = hp.buildHealthFixPrompt({ report: CLEAN, conflicts: CONFLICTS })
  const text = r ? r.text : ''
  ok(!!r && r.hasAudit === false && r.hasConflict === true, '只有 B')
  ok(text.indexOf('这次只有 B') >= 0 && text.indexOf('体检没有发现问题') >= 0, '开场白说清只有冲突')
  ok(text.indexOf('A · 体检问题') < 0, 'A 段整段不出现（体检干净时不摆一段空清单）')
  ok(text.indexOf('【索引悬空】') < 0 && text.indexOf('修复口径') < 0, '体检的口径与分类都不出现')
  ok(text.indexOf('1. 矛盾 · user_a.md ↔ user_b.md') >= 0, 'B 段内容在')
  ok(r.count === 2, `count = 2（实际 ${r ? r.count : 'null'}）`)
}

group('4. 两边都没事 → null（那颗按钮因此不渲染）')
{
  ok(hp.buildHealthFixPrompt({ report: CLEAN, conflicts: { items: [] } }) === null, '体检干净 + 无冲突 → null')
  ok(hp.buildHealthFixPrompt({ report: null, conflicts: null }) === null, '数据没到 → null')
  ok(hp.buildHealthFixPrompt({}) === null && hp.buildHealthFixPrompt(null) === null, '空对象 / null 入参 → null')
  ok(hp.buildHealthFixPrompt({ report: { problems: 4 } }) !== null, '只有 problems 没有分类数组也不炸')
}

group('5. 上限：每类 50 条 + 明写还剩几条')
{
  const many = Array.from({ length: 60 }, (_, i) => ({ file: `f${i}.md` }))
  const r = hp.buildHealthFixPrompt({
    report: { ...AUDIT, problems: 60, dangling: many, unlisted: [], brokenLinks: [], archivedLinks: [] },
  })
  const lines = r.text.split('\n').filter((x) => x.indexOf('- f') === 0)
  ok(lines.length === 50, `只列 50 条（实际 ${lines.length}）`)
  ok(r.text.indexOf('还有 10 条') >= 0, '截断处写明「还有 10 条，见面板」')
  ok(r.count === 60, '计数仍是 60（截断不改事实）')
}

group('6. B 段的措辞：只取待裁决、不许智能体替人改盘')
{
  const text = hp.buildHealthFixPrompt({ report: AUDIT, conflicts: CONFLICTS }).text
  ok(text.indexOf('（记录 c1）') >= 0, '带记录 id，人能回面板对上')
  ok(text.indexOf('备注：部署地址两边不一致') >= 0, '带原始备注')
  ok(text.indexOf('2. 版本冲突') >= 0, '编号 + 中文类型标签')
  ok(text.indexOf('c3') < 0 && text.indexOf('c4') < 0, '已裁决 / 已忽略的不进来')
  ok(text.indexOf('也不要把任何一方标失效') >= 0 && text.indexOf('点哪颗按钮由我来') >= 0,
    '明写裁决权在人手里（提示词不是授权书）')
  ok(text.indexOf('不要为此恢复归档') >= 0, 'A 段里「指向已归档」仍写明不是错误、不许恢复归档')
}

group('7. 复制路径：Clipboard API → execCommand → false')
{
  const calls = []
  const navShard = loadShard({
    navigator: { clipboard: { writeText: (v) => { calls.push(v); return Promise.resolve() } } },
  })
  const r1 = await navShard.copyPromptText('你好提示词')
  ok(r1 === true && calls[0] === '你好提示词', 'Clipboard API 路径：把原文原样写出去')

  // 拒绝 → 落到隐藏 textarea + execCommand
  const docReject = fakeDoc({ execOk: true })
  const shardReject = loadShard({
    navigator: { clipboard: { writeText: () => Promise.reject(new Error('not allowed')) } },
    document: docReject,
  })
  const r2 = await shardReject.copyPromptText('降级文本')
  ok(r2 === true, 'API 被拒时降级到 execCommand 复制成功')
  ok(!!docReject._last && docReject._last.value === '降级文本',
    `降级路径写进去的是同一段文本（实际 ${docReject._last && docReject._last.value}）`)
  ok(docReject.body.children.length === 0, '降级用的 textarea 用完就摘掉（不留隐藏节点）')

  const shardDead = loadShard({
    navigator: { clipboard: { writeText: () => Promise.reject(new Error('nope')) } },
    document: fakeDoc({ execOk: false }),
  })
  const r3 = await shardDead.copyPromptText('x')
  ok(r3 === false, '两条都失败 → 返回 false（调用方必须摊出来手抄）')

  const shardNone = loadShard({ navigator: undefined, document: fakeDoc({ execOk: false }) })
  const r4 = await shardNone.copyPromptText('y')
  ok(r4 === false, '没有 navigator（非安全上下文 / 老环境）也不抛错')

  // 反向对照：真的写成功时不会误报 false
  const shardOk = loadShard({ navigator: undefined, document: fakeDoc({ execOk: true }) })
  ok((await shardOk.copyPromptText('z')) === true, '【反向对照】execCommand 成功时报 true')
}

group('8. 兜底模态：文本摊得出来、能手动关')
{
  const rt = makeMiniReact()
  const shard = loadShard({ react: rt.api })
  let closed = 0
  const tree = await rt.settle(shard.PromptFallbackModal, {
    text: '第一行\n第二行', onClose: () => { closed++ },
  })
  const ta = findAll(tree, (n) => n.type === 'textarea')[0]
  ok(!!ta && ta.props.value === '第一行\n第二行', '只读 textarea 里就是整段提示词')
  ok(!!ta && ta.props.readOnly === true, 'textarea 只读（别让人改完再粘错）')
  const btn = findButton(tree, 'prompt.close')
  ok(!!btn, '有关闭按钮（用户能手动关）')
  if (btn && typeof btn.props.onClick === 'function') btn.props.onClick()
  ok(closed === 1, '点关闭真的调了 onClose')
  const scrim = byClass(tree, 'smem-modal-scrim')[0]
  ok(!!scrim && typeof scrim.props.onClick === 'function', '点遮罩也能关')
  ok(byClass(tree, 'smem-modal').length === 1, '走的是面板既有模态壳')
}

/** 假 DOM：够 legacyCopyPrompt 走完「建 textarea → 选中 → execCommand → 删掉」。 */
function fakeDoc(opts = {}) {
  const doc = {
    _last: null,
    created: [],
    body: {
      children: [],
      appendChild(el) { this.children.push(el); doc._last = el },
      removeChild(el) { const i = this.children.indexOf(el); if (i >= 0) this.children.splice(i, 1) },
    },
    createElement() {
      const el = { value: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, select() { doc._selected = this } }
      doc.created.push(el)
      return el
    },
    execCommand(cmd) { return cmd === 'copy' ? opts.execOk === true : false },
  }
  return doc
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
