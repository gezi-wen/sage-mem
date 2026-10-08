/**
 * 检索改进的断言（aliases 并入检索面 / baseline 优先级 / 名额）。
 * 仓库内测试，随 npm test 一起跑。
 */
const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const T = mod.__testables

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

const fm = (lines) => `---\n${lines}\n---\n\n# 标题\n\n正文\n`

console.log('== 1. aliases 解析（三种写法）==')
const f1 = T.parseFrontmatter(fm('name: x\ntype: project\ndescription: 一条测试\naliases: [待办, todo, 清单]'))
ok(f1.aliases.length === 3 && f1.aliases[0] === '待办', 'flow 写法：3 个别称', JSON.stringify(f1.aliases))
const f2 = T.parseFrontmatter(fm('name: x\ntype: project\ndescription: 一条测试\naliases:\n  - 待办\n  - 代办清单'))
ok(f2.aliases.length === 2 && f2.aliases[1] === '代办清单', 'block 写法：2 个别称', JSON.stringify(f2.aliases))
const f3 = T.parseFrontmatter(fm('name: x\ntype: project\ndescription: 一条测试\naliases: 待办, 清单'))
ok(f3.aliases.length === 2, '逗号串写法：2 个别称', JSON.stringify(f3.aliases))
const f4 = T.parseFrontmatter(fm('name: x\ntype: project\ndescription: 没有别称'))
ok(Array.isArray(f4.aliases) && f4.aliases.length === 0, '没有 aliases 时返回空数组而不是 undefined')
const f5 = T.parseFrontmatter('没有 frontmatter 的纯文本')
ok(Array.isArray(f5.aliases) && f5.aliases.length === 0 && f5.baselinePriority === 0, '无 frontmatter 也不炸')

console.log('== 2. aliases 真的让检索面变宽 ==')
const files = [
  {
    file: 'project_todo.md',
    description: '当前进行中的收尾事项',
    aliases: ['待办', '代办清单', 'todo'],
    baseline: false,
    baselinePriority: 0,
    content: '',
  },
  {
    file: 'project_server.md',
    description: '服务器与部署相关的记录',
    aliases: [],
    baseline: false,
    baselinePriority: 0,
    content: '',
  },
]
const q = '我有什么待办'
const withAlias = T.selectRelevant(q, files)
ok(withAlias.length === 1 && withAlias[0].file === 'project_todo.md', '有 aliases 的文件被命中', JSON.stringify(withAlias.map((f) => f.file)))
// 把 aliases 摘掉，同一个问题应该打不中（证明命中确实来自 aliases，而不是 description 偶然重合）
const stripped = files.map((f) => (f.file === 'project_todo.md' ? { ...f, aliases: [] } : f))
ok(T.selectRelevant(q, stripped).length === 0, '摘掉 aliases 后同一问题打不中（对照组成立）')

console.log('== 3. baseline 按显式优先级排 ==')
const baselines = [
  { file: 'feedback_a.md', baseline: true, baselinePriority: 0 },
  { file: 'user_z.md', baseline: true, baselinePriority: 9 },
  { file: 'project_m.md', baseline: false, baselinePriority: 99 },
  { file: 'reference_b.md', baseline: true, baselinePriority: 1 },
]
const picked = T.selectBaseline(baselines).map((f) => f.file)
ok(picked[0] === 'user_z.md', `优先级最高的排第一（实际 ${picked[0]}）`)
ok(picked[1] === 'reference_b.md', `次高的排第二（实际 ${picked[1]}）`)
ok(picked[2] === 'feedback_a.md', '优先级为 0 的垫底')
ok(!picked.includes('project_m.md'), '没标 baseline 的不进（哪怕优先级最大）')
ok(picked.length === 3, '三条 baseline 全选中')
const legacy = [
  { file: 'feedback_x.md', baseline: true },
  { file: 'user_y.md', baseline: true },
]
ok(JSON.stringify(T.selectBaseline(legacy).map((f) => f.file)) === JSON.stringify(['feedback_x.md', 'user_y.md']), '没写 baselinePriority 的老条目仍按文件名排（行为不变）')

console.log('== 4. 名额 ==')
ok(T.limits.MAX_RESULTS === 10, `MAX_RESULTS 默认 10（实际 ${T.limits.MAX_RESULTS}）`)
ok(T.limits.MAX_BASELINE === 8, `MAX_BASELINE 默认 8（实际 ${T.limits.MAX_BASELINE}）`)
const many = Array.from({ length: 30 }, (_, i) => ({
  file: `project_n${i}.md`,
  description: '待办事项清单',
  aliases: [],
  baseline: false,
  baselinePriority: 0,
  content: '',
}))
ok(T.selectRelevant('待办', many).length === 10, '命中上限确实是 10 条')

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
