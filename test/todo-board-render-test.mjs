#!/usr/bin/env node
/**
 * 待办看板 2.15.0 的**渲染层**验证：把真实分片拼进 vm，用迷你 react 渲染整个页签，
 * 再按「人点得下去」的标准读树（按钮文案 / 选中态 / 数据落在哪个文件）。
 *
 * 为什么另开一份（`todo-board-test.mjs` 只测纯函数）：
 * 2.15.0 的四件事**全在交互层** —— 筛选项、撤销步数选择、组展开记忆、搬进流水那颗按钮。
 * 纯函数测得到「算得对」，测不到「按钮在不在、点了有没有反应、写没写对文件」。
 * 这也是 2026-09-15 那次返工的结论：DOM 断言全绿 ⇏ 能用，所以这里直接读渲染树的文案。
 *
 * 用法: node test/todo-board-render-test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { makeMiniReact, findAll, findButton, byClass, textOf, runFragments } from './_client-vm-harness.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PARTS = ['client/05-shared.js', 'client/20-codecs.js', 'client/40-styles.js', 'client/50-shared-ui.js', 'client/55-i18n-memory.js', 'client/79-todo-board.js']

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')) }
}

const FIXTURE = [
  '---',
  'name: session-state',
  'description: 跨会话【代办清单】',
  '---',
  '',
  '# 代办清单',
  '',
  '## ⏳ 等你一句话',
  '- **甲任务** —— 说明一。',
  '- [x] **旧写法已完成** —— 只该在「全部」里出现。',
  '',
  '## 长期约束（不是待办，别删）',
  '- ⚠️ **约束一** —— 别动。',
  '',
  '## 已完成，待删除',
  '- **乙任务** —— 说明二。',
  '',
].join('\n')

/** 假 localStorage：只实现看板用到的两个方法，并记下真的写过什么。 */
const store = new Map()
const localStorage = {
  getItem: (k) => (store.has(String(k)) ? store.get(k) : null),
  setItem: (k, v) => store.set(String(k), String(v)),
}

/** 记录所有写盘调用：文件名 + 内容（断言「写对文件、内容对」靠它）。 */
const writes = []

/** typert 的 `{ok, value}` 信封：host 真实返回就是这个形状，假 remote 必须照它来。 */
const wrap = (value) => Promise.resolve({ ok: true, value })

function makeRemote() {
  return {
    readFile: (name) => wrap({ ok: true, content: name === 'project_session-state.md' ? FIXTURE : '', revision: 'r1' }),
    writeFile: (name, content, opts) => { writes.push({ api: 'writeFile', name, content, opts }); return wrap({ ok: true }) },
    readRaw: (name) => (name === 'session-log.md'
      ? wrap({ ok: true, content: '# 会话日志\n\n## 2026-11-20 22:29 · 上一段\n\n**做法**：啥也没干。\n', revision: 'log1' })
      : wrap({ ok: false, code: 'missing', error: '不存在' })),
    writeRaw: (name, content, opts) => { writes.push({ api: 'writeRaw', name, content, opts }); return wrap({ ok: true }) },
    checkpoints: () => wrap({
      ok: true,
      truncated: false,
      tasks: [{ taskId: 'task-a', project: '合成项目', revision: 2, items: ['把看板接上', '补一条断言'] }],
    }),
    getSettings: () => wrap({ experimental: { todoBoard: 1 } }),
  }
}

const remote = makeRemote()
const ctx = {
  get: (name) => (name === 'remote.memory' ? remote : null),
  slots: { inject: () => () => {}, register: () => () => {} },
  on: () => () => {},
}

const mini = makeMiniReact()
const sandbox = {
  window: { __ModuleLoader__: { load: () => {} } },
  document: { createElement: () => ({ dataset: {}, style: {} }), addEventListener() {}, removeEventListener() {} },
  localStorage,
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  exports: {},
  Symbol, Object, Array, JSON, Math, Date, Map, Set, Promise, Error, Number, String, Boolean, RegExp,
  isNaN, parseInt, parseFloat, Intl,
  __testReact: mini.api,
}
const sources = PARTS.map((rel) => readFileSync(join(ROOT, rel), 'utf8'))
runFragments(PARTS, sources, sandbox, [
  'const require = function () { return new Proxy({}, { get: () => () => ({}) }); };',
  'const react = __testReact;',
  // 00-header.js 在真实产物里提供这两行；这里只拼中段分片，得自己补上。
  'const h = react.createElement;',
  'globalThis.__board = { Board: TodoBoard, apply: applyTodoBoard, internals: exports.todoBoardInternals };',
].join('\n'))

const B = sandbox.__board
const T = B.internals

async function main() {
  ok(typeof B.Board === 'function', '取到了页签正文组件（真实分片，不是复制品）')
  B.apply(true)  // 打开看板：设置开关在模块级，正文据此渲染

  const props = { ctx, useTabInfo: () => ({ tab: { visible: true } }) }
  const tree = await mini.settle(B.Board, props)

  // ── 1. 顶栏：筛选 / 撤销步数 ────────────────────────────────────────────
  console.log('\n── 1. 筛选与撤销步数 ──')
  const openBtn = findButton(tree, '未完成')
  const allBtn = findButton(tree, '全部')
  ok(!!openBtn && !!allBtn, '两个筛选按钮都在（未完成 / 全部）')
  ok(openBtn && openBtn.props['aria-pressed'] === true, '默认停在「未完成」（默认只看未完成）')
  ok(allBtn && allBtn.props['aria-pressed'] === false, '「全部」默认没被选中')

  const select = byClass(tree, 'smem-todo-depth-select')[0]
  ok(!!select, '有撤销步数选择器')
  ok(select && select.props.value === '5', `默认 5 步（实际 ${select && select.props.value}）`)
  const opts = select ? findAll(select, (n) => n.type === 'option').map((n) => n.props.value) : []
  ok(opts.join(',') === '3,4,5', `可选 3 / 4 / 5（实际 ${opts.join('/')}）`)
  const depthLabel = byClass(tree, 'smem-todo-depth-label')[0]
  ok(!!depthLabel && /撤销上限/.test(textOf(depthLabel)), `步数标签是「撤销上限」，不会被读成一个动作（实际「${textOf(depthLabel || {})}」）`)

  // 2.15.1：统计口径 ——「长期约束」不算未完成。
  ok(/1 条未完成/.test(textOf(tree)), `统计条把约束排除在外（实际「${(textOf(tree).match(/\d+ 条未完成/) || ['?'])[0]}」）`)

  // ── 2. 组展开记忆 ──────────────────────────────────────────────────────
  console.log('\n── 2. 组展开状态记忆 ──')
  // ⚠️ 检查点那块用的是同一套外观（`smem-todo-group-toggle`），数「三组」时必须把它排除。
  const isCp = (n) => /检查点/.test(textOf(n))
  const groups = byClass(tree, 'smem-todo-group-toggle').filter((n) => !isCp(n))
  ok(groups.length === 3, `三组都在（实际 ${groups.length}）`)
  ok(byClass(tree, 'smem-todo-list').length === 0, '默认全部收起（2.11.1 的口径没变）')
  groups[0].props.onClick()  // 点开第一组
  const treeOpen1 = await mini.settle(B.Board, props)
  ok(byClass(treeOpen1, 'smem-todo-list').length === 1, `点开一组之后只展开这一组（实际 ${byClass(treeOpen1, 'smem-todo-list').length}）`)
  const saved = T.openMapParse(localStorage.getItem(T.PREF_OPEN))
  ok(Object.keys(saved).length === 1, '展开偏好只记了这一组', JSON.stringify(saved))
  const savedKey = Object.keys(saved)[0]
  ok(saved[savedKey] === true && savedKey.includes('等你一句话'), '键是节标题原文、值是 true', savedKey)
  ok(textOf(treeOpen1).includes('甲任务') && !textOf(treeOpen1).includes('旧写法已完成'),
    '「未完成」档：展开后只看到未完成的那条，旧 [x] 行不出现')

  // 切到「全部」：旧写法那一条 `- [x]` 才出现。
  byClass(treeOpen1, 'smem-todo-filter').filter((n) => textOf(n) === '全部')[0].props.onClick()
  const treeAll = await mini.settle(B.Board, props)
  ok(textOf(treeAll).includes('旧写法已完成'), '点「全部」后能看到旧文件里遗留的 [x] 行')
  ok(!textOf(treeOpen1).includes('旧写法已完成'), '同一组在「未完成」档里看不到它（反向对照）')

  // 「全部展开」是**一次性动作**，不该改写偏好（否则下次打开就永远全展开）。
  const expandAll = findButton(treeAll, '全部展开')
  ok(!!expandAll, '顶栏有「全部展开」')
  expandAll.props.onClick()
  const treeExpanded = await mini.settle(B.Board, props)
  ok(byClass(treeExpanded, 'smem-todo-list').length === 3, `「全部展开」把三组都打开（实际 ${byClass(treeExpanded, 'smem-todo-list').length}）`)
  ok(Object.keys(T.openMapParse(localStorage.getItem(T.PREF_OPEN))).length === 1, '「全部展开」不写偏好（仍只有原来那一组）')

  // 改步数：偏好写进 localStorage，且值被归一。
  byClass(treeExpanded, 'smem-todo-depth-select')[0].props.onChange({ target: { value: '3' } })
  const tree3 = await mini.settle(B.Board, props)
  ok(byClass(tree3, 'smem-todo-depth-select')[0].props.value === '3', '选了 3 步之后选择器就是 3')
  ok(String(localStorage.getItem(T.PREF_UNDO)).indexOf('3') >= 0, '步数偏好落到 localStorage（栈本身仍只在内存）')
  ok(findButton(tree3, '全部收起'), '展开之后按钮翻成「全部收起」（文案跟着状态走）')

  // ── 3. 待删除块：搬进流水 ──────────────────────────────────────────────
  console.log('\n── 3. 搬进流水（写对文件、写对内容）──')
  const archiveBtn = byClass(tree3, 'smem-todo-archive')[0]
  const clearBtn = byClass(tree3, 'smem-todo-del').filter((n) => /清空全部/.test(textOf(n)))[0]
  ok(!!archiveBtn, '待删除块上有「搬进流水」')
  ok(!!clearBtn, '「清空全部」还在（两个动作并列，不互相顶掉）')
  ok(/搬进流水（1）/.test(textOf(archiveBtn)), `按钮上带条数（实际「${textOf(archiveBtn)}」）`)

  // 2.15.1：两步确认 —— 第一次点击只进确认态，绝不写盘。
  writes.length = 0
  archiveBtn.props.onClick()
  const treeConfirm = await mini.settle(B.Board, props)
  ok(writes.length === 0, `第一次点击不写盘（实际写了 ${writes.length} 次）`)
  const confirmBtn = byClass(treeConfirm, 'smem-todo-archive').filter((n) => /确认搬进流水/.test(textOf(n)))[0]
  ok(!!confirmBtn, '第一次点击后按钮变成「确认搬进流水」')
  ok(!!findButton(treeConfirm, '取消'), '确认态旁边有「取消」')

  await confirmBtn.props.onClick()
  const treeAfter = await mini.settle(B.Board, props)
  const logWrite = writes.find((w) => w.api === 'writeRaw')
  const listWrite = writes.find((w) => w.api === 'writeFile')
  ok(writes.length === 2, `恰好两次写盘（实际 ${writes.length}：${writes.map((w) => w.api).join('、')}）`)
  ok(!!logWrite && logWrite.name === 'session-log.md', '第一次写的是流水（先写流水，再删清单行）')
  ok(logWrite && logWrite.content.includes('- **乙任务** —— 说明二。'), '流水里照抄条目正文')
  ok(logWrite && logWrite.opts && logWrite.opts.expectedRevision === 'log1', '流水写入带 revision（并发冲突交给宿主判）')
  ok(!!listWrite && listWrite.name === 'project_session-state.md', '第二次写的是清单本身')
  ok(listWrite && !listWrite.content.includes('乙任务'), '清单里那一条被删掉')
  ok(listWrite && listWrite.opts && listWrite.opts.expectedRevision === 'r1', '清单写入也带 revision')
  ok(/搬进/.test(textOf(treeAfter)), '回执说清发生了什么', textOf(treeAfter).slice(0, 160))

  // ── 4. 检查点聚合（只读） ──────────────────────────────────────────────
  console.log('\n── 4. 检查点里的未完成（只读）──')
  const cpToggle = byClass(treeAfter, 'smem-todo-group-toggle').filter(isCp)[0]
  ok(!!cpToggle, '有「检查点里的未完成」一块')
  ok(/2/.test(textOf(cpToggle)), '块标题上写着条数', textOf(cpToggle))
  cpToggle.props.onClick()
  const treeCp = await mini.settle(B.Board, props)
  const cpItems = byClass(treeCp, 'smem-todo-cp-item')
  ok(cpItems.length === 2, `展开后两条未完成都在（实际 ${cpItems.length}）`)
  ok(textOf(cpItems[0]) === '把看板接上', '条目顺序与检查点里一致')
  const cpHead = byClass(treeCp, 'smem-todo-cp-head')[0]
  ok(!!cpHead && /合成项目 · task-a/.test(textOf(cpHead)), '带上项目名与任务 id')
  ok(byClass(treeCp, 'smem-todo-box').length === byClass(treeAfter, 'smem-todo-box').length,
    '检查点条目没有勾选框（只读，不冒充可勾）')

  console.log(`\n结果：${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
