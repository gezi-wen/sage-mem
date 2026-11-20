/**
 * 待办看板（2.11.0 实验性 · 2.11.1 勾选改「搬家」）的**纯逻辑**验证：解析 + 行级手术。
 *
 * 为什么不测 UI：这一版的正确性全押在「只动该动的那几行」上 —— 一个解析错位就会
 * 把 frontmatter 或别的节写坏。UI 层由 `client-render-test` / 浏览器 E2E 覆盖。
 *
 * 2.11.1 的语义变了：**勾选 = 搬家**（从原组删掉、追加到「已完成，待删除」块），
 * 取消 = 反向搬家（回原组末尾）。所以这里的断言主体从「勾选只让第 N 行加 `[x]`」
 * 变成「搬家后其余字节逐字节不变」+「反向搬家回到原组」。
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
ok(T && T.UNDO_DEFAULT === 5, `撤销栈默认 5 步（实际 ${T && T.UNDO_DEFAULT}）`)
ok(T && T.DONE_HEADING === '## 已完成，待删除', '待删除块的标题是写进文件的字面量，不随界面语言变')

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
ok(p.sections[0].kind === 'todo' && p.sections[2].kind === 'constraint', '「长期约束」节被标成 constraint')
ok(p.sections[0].items.length === 2, `缩进续行没有变成第 3 条（实际 ${p.sections[0].items.length}）`)
ok(p.sections[0].items[1].cont.includes('缩进续行'), '续行并进了上一条的 cont（只影响显示）')
ok(p.sections[0].items[0].line === 13, `甲任务的行号是 13（实际 ${p.sections[0].items[0].line}）`)
ok(p.sections[0].items[0].title === '甲任务', `标题取 **…** 里的内容（实际「${p.sections[0].items[0].title}」）`)
ok(!p.sections[0].items[0].detail.includes('**甲任务**'), '正文里不再重复一遍标题', p.sections[0].items[0].detail.slice(0, 24))
ok(p.sections[0].items[0].detail.startsWith('（'), '正文从标题后面的分隔符之后开始', p.sections[0].items[0].detail.slice(0, 16))
ok(p.sections[1].items.length === 2 && p.sections[1].items[1].done === true, '普通组里已有的 `- [x]` 照旧被认成已完成（旧文件读得懂）')
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

// CRLF：读得懂，行内不留 \r。
const crlf = T.parse('## 节\r\n- **甲** —— 说明\r\n')
ok(crlf.sections[0].items[0].text.endsWith('说明'), 'CRLF 输入的条目正文没有残留 \\r', JSON.stringify(crlf.sections[0].items[0].text))

// 没有 `**…**` 的条目：title 为 null（渲染时不画标题行），detail 就是整段正文。
const noBold = T.parse('## 节\n- 裸条目 —— 没有加粗\n')
ok(noBold.sections[0].items[0].title === null, '没有加粗时 title 为 null（不硬造一个标题）')
ok(noBold.sections[0].items[0].detail === '裸条目 —— 没有加粗', '没有加粗时 detail 是整段正文')

// 「已完成，待删除」块：标题匹配就算 done 组，块内条目一律按已完成算。
const WITH_DONE = [
  '---',
  'name: session-state',
  '---',
  '',
  '## ⏳ 等你一句话',
  '- **甲任务** —— 说明一。',
  '- **乙任务** —— 说明二。',
  '',
  '## 已完成，待删除',
  '- [x] **旧任务** —— 做完了。',
  '',
  '## 长期约束（不是待办，别删）',
  '- ⚠️ **约束一** —— 别动。',
  '',
].join('\n')

console.log('== 2b. 「已完成，待删除」块被认成 done 组 ==')
const pd = T.parse(WITH_DONE)
const doneSec = pd.sections.find((s) => s.kind === 'done')
ok(!!doneSec, '标题含「已完成 / 待删除」的节 kind = "done"')
ok(doneSec && doneSec.items.length === 1 && doneSec.items[0].text === '**旧任务** —— 做完了。', '块内条目解析成正文字（不带 `- ` / `[x]`）')
ok(doneSec && doneSec.items[0].done === true && doneSec.items[0].inDone === true, '块内条目按语义算已完成（不靠行首 [x] 自证）')
ok(pd.open === 3 && pd.done === 1, `计数把待删除块的条目算进已完成（${pd.open} / ${pd.done}）`)
const handWritten = T.parse('## 已完成，待删除\n- 手写的一条没有 [x]\n')
ok(handWritten.sections[0].items[0].done === true, '手写进块的条目也算已完成（kind 优先于行首标记）')
ok(T.doneRange(T.parse(WITH_DONE).lines).start === 8 && T.doneRange(T.parse(WITH_DONE).lines).end === 11,
  'doneRange 给出标题到下一节之前的区间', JSON.stringify(T.doneRange(T.parse(WITH_DONE).lines)))

// ── 3. 搬家（勾选） ───────────────────────────────────────────────────────
console.log('== 3. 勾选 = 搬家：原组删行 + 待删除块追加 ==')
const stripLine = (text, n) => text.split('\n').filter((_, i) => i !== n).join('\n')
const LINE_A = p.sections[0].items[0].line
const moved = T.moveToDone(FIXTURE, LINE_A)
ok(typeof moved === 'string', '返回新全文（不是 null）')
ok(moved === stripLine(FIXTURE, LINE_A) + '\n## 已完成，待删除\n- [x] **甲任务**（`a.md`）。说明一。\n',
  '除原行删除 + 文件末尾新建块外，**逐字节**不变', moved.slice(-120))
const mp = T.parse(moved)
ok(!mp.sections[0].items.some((it) => it.text.startsWith('**甲任务**')), '原组里已经没有这一条')
const movedDone = mp.sections.find((s) => s.kind === 'done')
ok(movedDone && movedDone.items.length === 1, '新块里有 1 条')
ok(movedDone && movedDone.items[0].text === '**甲任务**（`a.md`）。说明一。', '正文不带原行首 `- `，也不带 `[x]`', movedDone && movedDone.items[0].text)
ok(mp.sections.length === 4 && mp.sections[3].kind === 'done', '新块建在文件末尾（第 4 节）')
ok(mp.open === 3 && mp.done === 2, `搬完计数：3 未完成 / 2 已完成（实际 ${mp.open} / ${mp.done}）`)
ok(moved.startsWith('---\nname: session-state'), 'frontmatter 仍在文件最前面（逐字节没动）')
ok(T.moveToDone(FIXTURE, 0) === null, '非条目行不给搬（返回 null，调用方据此不写盘）')
ok(T.moveToDone(FIXTURE, 999) === null, '越界行号返回 null')
ok(T.moveToDone(FIXTURE, 15) === null, '缩进续行（上一条的子项）不给单独搬')

// 已有块：追加到块**末尾**（不是紧跟标题），且不新建第二个块。
const movedIntoExisting = T.moveToDone(WITH_DONE, 5)
const mie = T.parse(movedIntoExisting)
const mieDone = mie.sections.find((s) => s.kind === 'done')
ok(mieDone && mieDone.items.length === 2, `原有块接住新条目（实际 ${mieDone && mieDone.items.length} 条）`)
ok(mieDone && mieDone.items[0].text === '**旧任务** —— 做完了。' && mieDone.items[1].text === '**甲任务** —— 说明一。',
  '新条目排在块内最后一条之后，原来的条目位置不变')
ok((movedIntoExisting.match(/## 已完成，待删除/g) || []).length === 1, '没有建出第二个待删除块')
ok(mie.sections.find((s) => s.kind === 'constraint'), '后面的「长期约束」节仍在（不是被新条目顶掉）')

// 普通组里本来就是 `[x]` 的条目：搬过去仍只留一份 `[x]`。
const moveAlreadyX = T.parse(T.moveToDone(FIXTURE, 21)).sections.find((s) => s.kind === 'done')
ok(moveAlreadyX && moveAlreadyX.items[0].text === '**丁任务** —— 第四个。', '`- [x]` 条目搬家时剥掉旧前缀（不留 `[x] [x]`）')

// CRLF 文件：新行也带 \r，不制造一份两种换行。
const crlfMoved = T.moveToDone('## 节\r\n- **甲** —— 说明\r\n', 1)
ok(crlfMoved === '## 节\r\n\n## 已完成，待删除\r\n- [x] **甲** —— 说明\r\n', 'CRLF 文件里建块时新行也带 \\r', JSON.stringify(crlfMoved))

// ── 4. 反向搬家（取消完成） ────────────────────────────────────────────────
console.log('== 4. 取消完成 = 反向搬家：回原组末尾 ==')
const movedLine = mp.sections.find((s) => s.kind === 'done').items[0].line
const restored = T.restore(moved, movedLine, '⏳ 等你一句话')
const rp = T.parse(restored)
const backSec = rp.sections[0]
ok(backSec.items.length === 2, `回到原组（${backSec.items.length} 条）`)
ok(backSec.items[1].text === '**甲任务**（`a.md`）。说明一。', '落在原组**末尾**，正文原样', backSec.items[1].text)
ok(restored.split('\n')[backSec.items[1].line] === '- **甲任务**（`a.md`）。说明一。', '回到原组时是未完成形态（不带 `[x]`）')
ok(rp.sections.find((s) => s.kind === 'done').items.length === 0, '待删除块空了（标题保留，等下一次勾选）')
ok(restored.includes('## 已完成，待删除'), '待删除块的 `##` 标题留着（不是过河拆桥）')
ok(rp.done === 1 && rp.open === 4, `反向搬完计数回到原值（${rp.open} / ${rp.done}）`)

// 记不住原组（换过页面 / 手写条目）：退到第一个普通待办组的末尾，而不是丢掉。
const restoredFallback = T.parse(T.restore(moved, movedLine, ''))
ok(restoredFallback.sections[0].items.length === 2, '没有原组线索时回第一个普通组（不丢条目）')

// 全篇只有待删除块：条目落到文件末尾，仍然不丢。
const onlyDone = T.restore('## 已完成，待删除\n- [x] 甲\n', 1, '')
ok(onlyDone === '## 已完成，待删除\n- 甲\n', '没有任何普通组时退回文件末尾', JSON.stringify(onlyDone))
ok(T.restore(FIXTURE, 0, '') === null && T.restore(FIXTURE, 999, '') === null, '非条目 / 越界行号返回 null')

// ── 5. 删除与清空 ─────────────────────────────────────────────────────────
console.log('== 5. 待删除块的逐条删除与清空全部 ==')
const clearedBlock = T.clearDoneBlock('## 已完成，待删除\n- [x] 甲\n- [x] 乙\n\n## 下一节\n- 丙\n')
ok(clearedBlock.count === 2, `清空数到 2 条（实际 ${clearedBlock.count}）`)
ok(clearedBlock.next === '## 已完成，待删除\n\n## 下一节\n- 丙\n', '删掉块内全部条目行，`## 标题` 与别节原样', JSON.stringify(clearedBlock.next))
ok(T.clearDoneBlock('## 已完成，待删除\n').next === null, '空块不返回新文本（不白写一次盘）')
ok(T.clearDoneBlock(FIXTURE).count === 0, '文件里没有待删除块时无事可做')
ok(T.clearDoneBlock(FIXTURE).next === null, '没有块 → next 为 null')

const doneWithTwo = '## ⏳ 待办\n- **甲** —— 一。\n\n## 已完成，待删除\n- [x] **乙** —— 二。\n- [x] **丙** —— 三。\n'
const parsedTwo = T.parse(doneWithTwo)
const secDone = parsedTwo.sections.find((s) => s.kind === 'done')
const deletedOne = T.remove(doneWithTwo, [secDone.items[0].line])
const dp = T.parse(deletedOne)
ok(dp.sections.find((s) => s.kind === 'done').items.length === 1, '逐条删除只删那一行')
ok(dp.sections.find((s) => s.kind === 'done').items[0].text === '**丙** —— 三。', '留下的是另一条')
ok(dp.sections[0].items.length === 1 && dp.sections[0].items[0].text === '**甲** —— 一。', '普通组不受影响')

// ── 6. 新增 / 编辑（口径不变） ─────────────────────────────────────────────
console.log('== 6. 新增 / 编辑：只动那一行 ==')
const insAt = p.sections[1].insertAt
const inserted = T.insert(FIXTURE, insAt, '**新任务** —— 刚加的')
ok(inserted.split('\n')[insAt] === '- **新任务** —— 刚加的', '新增落在节尾最后一条的下一行', inserted.split('\n')[insAt])
ok(T.parse(inserted).sections[1].items.length === 3, '新增后那一节变成 3 条')
ok(T.insert(FIXTURE, insAt, '   ') === null, '空白内容不写（返回 null）')

const lineB = p.sections[0].items[1].line
const replaced = T.replace(FIXTURE, lineB, '**乙任务改** —— 换了说明')
ok(replaced.split('\n')[lineB] === '- **乙任务改** —— 换了说明', '编辑替换整行正文')
const replacedDone = T.replace(FIXTURE, 21, '**丁任务改**')
ok(replacedDone.split('\n')[21] === '- [x] **丁任务改**', '编辑已完成的条目仍保留 [x]')
ok(T.replace(FIXTURE, 0, 'x') === null, '非条目行不给替换')

// ── 7. 图标（内联 SVG） ────────────────────────────────────────────────────
console.log('== 7. 撤销 / 重做图标是内联 SVG ==')
const undoIcon = T.arrowIcon('undo')
const redoIcon = T.arrowIcon('redo')
ok(undoIcon && undoIcon.type === 'svg', '图标是 svg 元素（不引图标库、不外链）')
ok(undoIcon && undoIcon.props.viewBox === '0 0 16 16' && undoIcon.props.stroke === 'currentColor', 'viewBox 16 × 16、描边 currentColor')
ok(undoIcon && undoIcon.children[0].length === 2, `两个 path：基线弧 + 箭头（实际 ${undoIcon && undoIcon.children[0].length}）`)
ok(redoIcon && redoIcon.children[0].map((n) => n.props.d).join('|') !== undoIcon.children[0].map((n) => n.props.d).join('|'),
  '重做是撤销的左右镜像（路径不同）')

// ── 8. 端到端一轮 ──────────────────────────────────────────────────────────
console.log('== 8. 端到端：勾 → 读 → 取消 → 读 → 清空 ==')
let round = FIXTURE
round = T.moveToDone(round, T.parse(round).sections[0].items[0].line)
round = T.insert(round, T.parse(round).sections[1].insertAt, '**再一条**')
round = T.replace(round, T.parse(round).sections[2].items[0].line, '⚠️ **约束一改** —— 还是别动')
const mid = T.parse(round)
ok(mid.sections.length === 4 && mid.done === 2, `三轮手术后结构仍稳定（${mid.open} open / ${mid.done} done）`)
const midDone = mid.sections.find((s) => s.kind === 'done')
round = T.restore(round, midDone.items[0].line, '⏳ 等你一句话')
round = T.clearDoneBlock(T.parse(round).sections.find((s) => s.kind === 'done').items.length === 0
  ? round
  : round).next || round
const end = T.parse(round)
ok(end.sections.length === 4, '待删除块空了之后仍在（标题留着）')
ok(end.sections.find((s) => s.kind === 'done').items.length === 0, '清空后块内没有条目')
ok(end.sections[2].items[0].text.includes('约束一改'), '约束节的编辑生效了')
ok(round.startsWith('---\nname: session-state'), 'frontmatter 始终在文件最前面（逐字节没动）')

// ── 9. 2.15.0：撤销深度 / 筛选 / 展开偏好 ─────────────────────────────────
console.log('== 9. 撤销深度 / 筛选 / 展开偏好（纯逻辑） ==')
ok(T.UNDO_DEFAULT === 5 && T.UNDO_MIN === 3 && T.UNDO_MAX === 5,
  `撤销默认 5 步、可配范围 3–5（实际 ${T.UNDO_DEFAULT}，${T.UNDO_MIN}–${T.UNDO_MAX}）`)
ok(T.clampDepth(2) === 3, '低于下限收到 3（老配置里那个「两步」也被收上来）')
ok(T.clampDepth(9) === 5, '高于上限收到 5')
ok(T.clampDepth('4') === 4, '字符串数字照收（select 的 value 是字符串）')
ok(T.clampDepth(4.6) === 5, '小数先四舍五入再收界（4.6 → 5）')
ok(T.clampDepth('abc') === T.UNDO_DEFAULT && T.clampDepth(null) === T.UNDO_DEFAULT, '坏值回默认 5，不是 NaN')

const mixed = [
  { done: true, inDone: false, text: '普通组里的旧 [x]' },
  { done: false, inDone: false, text: '未完成' },
  { done: true, inDone: true, text: '待删除块里的' },
]
ok(T.filterItems(mixed, T.FILTER_OPEN).length === 2, '「未完成」档藏掉普通组里遗留的 [x] 行')
ok(T.filterItems(mixed, T.FILTER_OPEN).every((it) => !it.done || it.inDone), '待删除块里的条目照常显示（它是队列，不是历史）')
ok(T.filterItems(mixed, T.FILTER_ALL).length === 3, '「全部」档一条不少')
ok(T.filterItems(null, T.FILTER_ALL).length === 0, '入参为 null 时回空数组，不抛')

const openMap = T.openMapParse(JSON.stringify({ '⏳ 等你一句话': true, '长期约束': false, '杂项': 'yes' }))
ok(openMap['⏳ 等你一句话'] === true && openMap['长期约束'] === false, '展开偏好按节标题记住（true / false 都留）')
ok(openMap['杂项'] === undefined, '非布尔值的键丢掉（坏数据不传染）')
ok(Object.keys(T.openMapParse('{bad json')).length === 0, '坏 JSON 当作没有偏好')
ok(Object.keys(T.openMapParse('[1,2]')).length === 0, '数组当作没有偏好')
const openRound = T.openMapParse(T.openMapSerialize({ 甲: true, 乙: false }))
ok(openRound['甲'] === true && openRound['乙'] === false, '序列化 → 解析往返一致')
ok(T.groupKey(null) === '' && T.groupKey('甲') === '甲', '组键就是节标题原文（空标题共用一个兜底键）')
ok(T.PREF_UNDO.includes('undoDepth') && T.PREF_OPEN.includes('openGroups'), '两个偏好键分开存在（改一个不会冲掉另一个）')

// ── 10. 2.15.0：完成项留档（搬进流水） ────────────────────────────────────
console.log('== 10. 完成项留档：正文照抄 + 去重 + 只在尾部追加 ==')
ok(T.LOG_FILE === 'session-log.md', `留档落点是跨会话流水（实际 ${T.LOG_FILE}）`)
ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(T.stamp(new Date(2026, 0, 2, 3, 4))), '时间戳是 YYYY-MM-DD HH:mm（本地时区）')

const logStart = '# 会话日志\n\n## 2026-11-20 22:29 · 上一段\n\n**做法**：啥也没干。\n'
const now = new Date(2026, 10, 20, 23, 40)
const block = T.archiveBlock([{ text: '**甲** —— 一。' }, { text: '**乙** —— 二。' }, { text: '**甲** —— 一。' }], now)
ok(block.count === 2, `同一批里正文重复的只写一次（实际 ${block.count} 条）`)
ok(block.text.startsWith('## 2026-11-20 23:40 · 待办收尾（2 条）'), '段落带日期与条数', block.text.split('\n')[0])
ok(block.text.includes('- **甲** —— 一。'), '条目正文**逐字照抄**（不概括、不改写）')
ok(block.text.includes('`project_session-state.md`'), '段落写清来源文件（半年后还知道这是从哪儿搬来的）')
ok(T.archiveBlock([], now).count === 0 && T.archiveBlock([], now).text === '', '没有条目时不造空段落')
ok(T.archiveBlock([{ text: '   ' }], now).count === 0, '空白正文跳过')

const existing = T.logKeys(logStart + '\n- **甲** —— 一。\n')
ok(existing.has(T.logKey('**甲** —— 一。')), '流水里已有的条目认得出（连续空白归一后比对）')
const partial = T.archiveBlock([{ text: '**甲** —— 一。' }, { text: '**乙** —— 二。' }], now, existing)
ok(partial.count === 1 && partial.text.includes('**乙**') && !partial.text.includes('**甲**'),
  '重试时只补没记过的那条（「写了一半」可以安全重来）')

const appended = T.logAppend(logStart, block.text)
ok(appended.startsWith(logStart.replace(/\n$/, '')), '已有内容逐字节保留（只在尾部追加）')
ok(!/\n\n\n/.test(appended), '段落之间恰好一个空行（不叠空行）')
ok(appended.trimEnd().endsWith('- **乙** —— 二。'), '新内容落在文件末尾')
ok(T.logAppend('', block.text).split('\n')[0].startsWith('## '), '空文件：直接从段标题起头')
ok(T.logAppend(logStart, '').endsWith('**做法**：啥也没干。\n'), '空段落不写盘（原样返回）')
const crlfLog = T.logAppend('# 日志\r\n', '## 段\n- 一')
ok(crlfLog.includes('\r\n## 段\r\n'), 'CRLF 文件里追加的行也用 CRLF（不混两种换行）')

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)