/**
 * 待办看板（2.11.0 实验性）的**纯逻辑**验证：解析 + 行级手术。
 *
 * 为什么不测 UI：这一版的正确性全押在「只动该动的那几行」上 —— 一个解析错位就会
 * 把 frontmatter 或别的节写坏。UI 层由 `client-render-test` / 浏览器 E2E 覆盖。
 *
 * 做法与 `client-exec-test` 相同：假 `window.__ModuleLoader__` + 假 react 把 client.js 跑一遍，
 * 拿 factory 导出的 `todoBoardInternals` 直接调纯函数（真实运行期没人读那个出口）。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))

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

// ── 1. 拿到纯函数 ──────────────────────────────────────────────────────────
const code = await readFile(CLIENT, 'utf8')
let loaded = null
const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { loaded = def } } },
  document: undefined,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Symbol, Object, Array, JSON, Math, Date, Map, Set, Promise, Error,
  String, Number, Boolean, RegExp, isNaN, parseInt, parseFloat,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  Fragment: 'Fragment',
}
const requireFn = (name) => (name === 'react' ? fakeReact : new Proxy({}, { get: () => () => ({}) }))

console.log('== 1. 测试缝 ==')
const mod = loaded.factory(requireFn)
const T = mod && mod.todoBoardInternals
ok(T && typeof T.parse === 'function', '导出了 todoBoardInternals（解析 + 行级手术）')
ok(T && T.FILE === 'project_session-state.md', `认的文件是 project_session-state.md（实际 ${T && T.FILE}）`)
ok(mod && typeof mod.apply === 'function', '插件本体仍然只导出 apply（测试缝是额外字段，不影响装载）')

// ── 2. 解析 ────────────────────────────────────────────────────────────────
// 这份 fixture 照真文件的形状抄：frontmatter / 引用块 / 空行分组 / `[x]` / 缩进续行 / 约束节。
const FIXTURE = [
  '---',
  'name: session-state',
  'description: 跨会话【代办清单】',
  'metadata:',
  '  node_type: memory',
  '  baseline: true',
  '---',
  '',
  '# 代办清单（session-state）',
  '',
  '> 只记未完成的事，一条一行。',
  '',
  '## ⏳ 等你一句话',
  '- **甲任务**（`a.md`）。说明一。',
  '- **乙任务** —— 说明二。',
  '  - 缩进续行不该算新条目',
  '',
  '## 待办（条件到了才动）',
  '',
  '',
  '- **丙任务** —— 第三个。',
  '- [x] **丁任务** —— 第四个。',
  '',
  '## 长期约束（不是待办，别删）',
  '- ⚠️ **约束一** —— 别动。',
  '',
].join('\n')

console.log('== 2. parseTodoList：节 / 条目 / 计数 ==')
const p = T.parse(FIXTURE)
ok(p.sections.length === 3, `认出 3 节（实际 ${p.sections.length}）`, JSON.stringify(p.sections.map((s) => s.title)))
ok(p.sections[0].title.includes('等你一句话'), '第一节标题保留原文（含 emoji）', p.sections[0].title)
ok(p.sections[0].kind === 'todo' && p.sections[2].kind === 'constraint', '「长期约束」节被标成 constraint（默认收起）')
ok(p.sections[0].items.length === 2, `缩进续行没有变成第 3 条（实际 ${p.sections[0].items.length}）`)
ok(p.sections[0].items[1].cont.includes('缩进续行'), '续行并进了上一条的 cont（只影响显示）')
ok(p.sections[0].items[0].line === 13, `甲任务的行号是 13（实际 ${p.sections[0].items[0].line}）`)
ok(p.sections[0].items[0].title === '甲任务', `标题取 **…** 里的内容（实际「${p.sections[0].items[0].title}」）`)
ok(!p.sections[0].items[0].detail.includes('**甲任务**'), '正文里不再重复一遍标题（截图里才发现的重影）', p.sections[0].items[0].detail.slice(0, 24))
ok(p.sections[0].items[0].detail.startsWith('（'), '正文从标题后面的分隔符之后开始', p.sections[0].items[0].detail.slice(0, 16))
ok(p.sections[1].items.length === 2 && p.sections[1].items[1].done === true, '`- [x]` 被认成已完成')
ok(p.sections[1].items[1].text.startsWith('**丁任务**'), '已完成条目的正文剥掉了 [x] 前缀')
ok(p.open === 4 && p.done === 1, `计数：4 未完成 / 1 已完成（实际 ${p.open} / ${p.done}）`)
ok(p.lines.length === FIXTURE.split('\n').length, '行数组原样保留（解析不改输入）')
ok(p.lines.some((l) => l.startsWith('name: session-state')), 'frontmatter 留在 lines 里（写回时逐字节带走）')
ok(p.sections.flatMap((s) => s.items).every((it) => !/node_type/.test(it.text)), 'frontmatter 没被当成条目')

// 没有 `##` 的文件：条目落进兜底组，不丢。
const flat = T.parse('- 一\n- 二\n')
ok(flat.sections.length === 1 && flat.sections[0].title === '' && flat.sections[0].items.length === 2,
  '没有小节时条目进兜底组（title 为空，渲染时用 i18n 兜底）', JSON.stringify(flat.sections[0] && flat.sections[0].items.length))

// 空文件 / null 不炸。
ok(T.parse('').sections.length === 0 && T.parse(null).lines.length === 1, '空输入与 null 都安全')

// CRLF：读得懂，行内不留 \r；写回那一行会变成 LF（记录在案，不假装支持 CRLF 文件）。
const crlf = T.parse('## 节\r\n- **甲** —— 说明\r\n')
ok(crlf.sections[0].items[0].text.endsWith('说明'), 'CRLF 输入的条目正文没有残留 \\r', JSON.stringify(crlf.sections[0].items[0].text))

// 没有 `**…**` 的条目：title 为 null（渲染时不画标题行），detail 就是整段正文。
const noBold = T.parse('## 节\n- 裸条目 —— 没有加粗\n')
ok(noBold.sections[0].items[0].title === null, '没有加粗时 title 为 null（不硬造一个标题）')
ok(noBold.sections[0].items[0].detail === '裸条目 —— 没有加粗', '没有加粗时 detail 是整段正文')

// ── 3. 行级手术 ───────────────────────────────────────────────────────────
console.log('== 3. 行级手术：只动该动的那一行 ==')
const lineA = p.sections[0].items[0].line
const marked = T.toggle(FIXTURE, lineA, true)
const markedLines = marked.split('\n')
const beforeLines = FIXTURE.split('\n')
const diff = markedLines.map((l, i) => [i, beforeLines[i], l]).filter(([, a, b]) => a !== b)
ok(diff.length === 1 && diff[0][0] === lineA, `只有第 ${lineA} 行变了（实际变了 ${diff.length} 行）`, JSON.stringify(diff.slice(0, 2)))
ok(markedLines[lineA].startsWith('- [x] **甲任务**'), '勾选 = 行首加 [x]，正文原样', markedLines[lineA].slice(0, 30))
ok(T.parse(marked).done === 2 && T.parse(marked).open === 3, '再解析：2 已完成 / 3 未完成')

const unmarked = T.toggle(marked, lineA, false)
ok(unmarked === FIXTURE, '取消完成 === 原始文本（逐字节回到原状）')
ok(T.toggle(FIXTURE, 0, true) === null, '非条目行不给改（返回 null，调用方据此不写盘）')
ok(T.toggle(FIXTURE, 999, true) === null, '越界行号返回 null')

const insAt = p.sections[1].insertAt
const inserted = T.insert(FIXTURE, insAt, '**新任务** —— 刚加的')
ok(inserted.split('\n')[insAt] === '- **新任务** —— 刚加的', '新增落在节尾最后一条的下一行', inserted.split('\n')[insAt])
ok(T.parse(inserted).sections[1].items.length === 3, '新增后那一节变成 3 条')
ok(T.insert(FIXTURE, insAt, '   ') === null, '空白内容不写（返回 null）')

const lineB = p.sections[0].items[1].line
const replaced = T.replace(FIXTURE, lineB, '**乙任务改** —— 换了说明')
ok(replaced.split('\n')[lineB] === '- **乙任务改** —— 换了说明', '编辑替换整行正文')
const replacedDone = T.replace(marked, lineA, '**甲任务改**')
ok(replacedDone.split('\n')[lineA] === '- [x] **甲任务改**', '已完成的条目编辑后仍保留 [x]')
ok(T.replace(FIXTURE, 0, 'x') === null, '非条目行不给替换')

const removed = T.remove(FIXTURE, [lineA])
ok(removed.split('\n').length === FIXTURE.split('\n').length - 1, '删一行 = 行数减一')
ok(!removed.includes('**甲任务**'), '删掉了目标行')

const cleared = T.clearDone(FIXTURE)
ok(cleared.count === 1 && !cleared.next.includes('[x]'), `清理已完成删掉 1 行（实际 ${cleared.count}）`)
ok(T.clearDone(marked).count === 2, '两行已完成时清理两条')
ok(T.clearDone('- 未完成\n').next === null, '没有已完成时不返回新文本（不白写一次盘）')

// 端到端一轮：勾 → 读 → 改 → 读 → 清理，每一轮都还能解析成同样的结构。
let round = FIXTURE
round = T.toggle(round, T.parse(round).sections[0].items[0].line, true)
round = T.insert(round, T.parse(round).sections[1].insertAt, '**再一条**')
round = T.replace(round, T.parse(round).sections[2].items[0].line, '⚠️ **约束一改** —— 还是别动')
const end = T.parse(round)
ok(end.sections.length === 3 && end.done === 2 && end.open === 4, `三轮手术后结构仍稳定（${end.open} open / ${end.done} done）`)
ok(round.startsWith('---\nname: session-state'), 'frontmatter 始终在文件最前面（逐字节没动）')

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
