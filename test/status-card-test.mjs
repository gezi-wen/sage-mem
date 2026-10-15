/**
 * 缺口状态卡的断言（lib/memory/status.js）。
 *
 * 为什么「无缺口返回空串」也要单独测：这张卡唯一的失败方式是**每轮都说话** ——
 * 一旦它变成常驻噪音，真有缺口时模型也不会再看。所以正反两面都要钉住：
 * 没缺口必须一个字都不说，有缺口必须说出「还能做什么」。
 * 纯函数、零 I/O；全部 fixture 为合成文本（本仓库是公开仓库，不用真实记忆内容与本机路径）。
 */
import { renderStatusCard, STATUS_MAX_BYTES } from '../lib/memory/status.js'

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
const linesOf = (s) => s.split('\n').filter(Boolean)

/** 合成基线输入：一条已经注入了正文、也不缺任何东西的正常轮次。 */
const BASE = {
  scope: 'all',
  scanned: 12,
  injected: 2,
  omitted: 0,
  unread: 0,
  best: { file: 'project_alpha.md', title: '示例条目甲' },
  needle: '示例词',
  toolsAvailable: true,
  memoryDir: 'mem-notes',
}
const card = (over = {}) => renderStatusCard({ ...BASE, ...over })

console.log('== 1. 常量 ==')
ok(STATUS_MAX_BYTES === 512, `卡片上限 512 字节（实际 ${STATUS_MAX_BYTES}）`)

console.log('== 2. 无缺口就一个字都不说 ==')
ok(card() === '', '注入了正文、没有未读也没有省略 → 空串')
ok(card({ injected: 1, best: BASE.best }) === '', '有最佳线索也不说话（线索不是缺口）')
ok(card({ injected: 0 }) !== '', '【反向对照】什么都没命中 → 必须说话')
ok(card({ unread: 3 }) !== '', '【反向对照】有候选没读 → 必须说话')
ok(card({ omitted: 2 }) !== '', '【反向对照】有候选被预算省略 → 必须说话')
const omittedOnly = card({ injected: 0, unread: 0, omitted: 3, best: null })
ok(omittedOnly !== '' && !omittedOnly.includes('摘要里没有命中'), '【反向对照】有省略时不说「摘要未命中」（那是谎报故障类型）', omittedOnly)

console.log('== 3. 摘要未命中卡 ==')
const miss = card({ injected: 0, best: null })
ok(miss.includes('摘要里没有命中'), '含「摘要没命中」那一句')
ok(miss.includes('search_memory') && miss.includes('read_memory'), '建议里含两个工具名')
ok(miss.includes('12'), '含扫描份数')
ok(card({ injected: 0, scope: 'summary' }).includes('「摘要」'), '范围标签：summary → 摘要')
ok(card({ injected: 0, scope: 'body' }).includes('「正文」'), '范围标签：body → 正文')
ok(card({ injected: 0, scope: 'weird' }).includes('「全部」'), '非法范围回落「全部」（不悄悄降级成摘要）')
ok(card({ injected: 0, scope: undefined }).includes('「全部」'), 'scope 缺省 → 全部')
ok(card({ injected: 0 }).includes('示例词'), '有 needle 时把它放进建议里')
ok(!card({ injected: 0, needle: null }).includes('例如'), 'needle 为空时不编一个例子出来')
const missNoTools = card({ injected: 0, toolsAvailable: false })
ok(!missNoTools.includes('search_memory') && !missNoTools.includes('read_memory'), '【反向】工具不可用时不出现工具名（模型会去调一个不存在的工具）')
ok(missNoTools.includes('mem-notes'), '工具不可用时给可直接打开的目录')
ok(!card({ injected: 0, toolsAvailable: undefined }).includes('search_memory'), 'toolsAvailable 缺省按不可用处理（严格认 true）')
const noDir = card({ injected: 0, toolsAvailable: false, memoryDir: '' })
ok(noDir !== '' && !noDir.includes('undefined'), '目录为空也说得通，不出现 undefined', noDir)

console.log('== 4. 缺口卡 ==')
const gap = card({ unread: 3, omitted: 2, injected: 1 })
ok(gap.includes('3 条') && gap.includes('2 条') && gap.includes('1 条'), '含未读 / 省略 / 已注入三个条数', gap)
ok(gap.includes('「全部」'), '含检索范围')
ok(gap.includes('示例条目甲') && gap.includes('project_alpha.md'), '含最佳线索的标题与文件名')
ok(gap.includes('动作：'), '含一个可做的动作（不是只有统计）')
ok(gap.includes('search_memory'), '动作指向工具')
ok(gap.includes('示例词'), 'needle 进了动作')
ok(card({ unread: 1, needle: null }).includes('search_memory') && !card({ unread: 1, needle: null }).includes('例如'), 'needle 为空时动作仍可执行')
ok(!card({ unread: 1, best: null }).includes('最佳线索'), '没有线索时不说「最佳线索」')
ok(card({ unread: 1, best: { file: 'project_beta.md', title: '' } }).includes('project_beta.md'), '只有文件名时也能给线索')
const gapNoTools = card({ unread: 2, toolsAvailable: false })
ok(!gapNoTools.includes('search_memory') && !gapNoTools.includes('read_memory'), '【反向】工具不可用时缺口卡也不出现工具名')
ok(gapNoTools.includes('mem-notes') && gapNoTools.includes('project_alpha.md'), '工具不可用时改成「打开目录 + 读哪个文件」')
const budgetOnly = card({ unread: 0, omitted: 4, injected: 0 })
ok(budgetOnly.includes('预算') && !budgetOnly.includes('还没读'), '只有预算省略时不说「0 条还没读」', budgetOnly)

console.log('== 5. 512 字节硬上限与完整句子 ==')
const longTitle = card({ unread: 5, best: { file: 'project_alpha.md', title: '甲'.repeat(4000) } })
ok(bytes(longTitle) <= STATUS_MAX_BYTES, `超长标题被裁到上限内（实际 ${bytes(longTitle)} 字节）`)
ok(longTitle.includes('…'), '裁掉的痕迹是省略号（不是硬切）')
ok(longTitle.includes('最佳线索') && longTitle.includes('动作：'), '裁完仍保留线索与动作')
ok(linesOf(longTitle).every(l => l.endsWith('。')), '每一行都以句号收尾（没有截半句）', j(linesOf(longTitle).map(l => l.slice(-14))))
const longDir = card({ unread: 1, toolsAvailable: false, memoryDir: 'd'.repeat(500) })
ok(bytes(longDir) <= STATUS_MAX_BYTES, `超长目录被裁到上限内（实际 ${bytes(longDir)} 字节）`)
const longNeedle = card({ unread: 1, needle: 'x'.repeat(500) })
ok(bytes(longNeedle) <= STATUS_MAX_BYTES, `超长 needle 被裁到上限内（实际 ${bytes(longNeedle)} 字节）`)
const bothLong = card({ unread: 1, toolsAvailable: false, memoryDir: 'd'.repeat(500), best: { file: 'f'.repeat(500), title: '甲'.repeat(4000) } })
ok(bytes(bothLong) <= STATUS_MAX_BYTES, `标题与目录同时超长也被裁到上限内（实际 ${bytes(bothLong)} 字节）`)
// 一份清单把所有路径都过一遍：任何一条越界都说明某条分支绕过了额度控制。
const samples = [
  card(),
  miss,
  gap,
  card({ injected: 0, unread: 0, omitted: 0, best: null }),
  card({ unread: 1, best: null, needle: null, memoryDir: '' }),
  card({ unread: 1, toolsAvailable: false, best: null }),
  card({ unread: 999999, omitted: 999999, injected: 999999, best: { title: '甲'.repeat(60), file: 'f'.repeat(60) } }),
]
ok(samples.every(s => bytes(s) <= STATUS_MAX_BYTES), '所有分支的卡片都 ≤ 512 字节', j(samples.map(bytes)))
ok(samples.filter(Boolean).every(s => linesOf(s).every(l => l.endsWith('。'))), '所有分支的每一行都是完整句子')

console.log('== 6. 鲁棒性与纯函数 ==')
ok(typeof renderStatusCard() === 'string' && bytes(renderStatusCard()) <= STATUS_MAX_BYTES, '不传参数也能渲染出合法卡片')
ok(typeof renderStatusCard(null) === 'string', '传 null 不抛')
ok(typeof renderStatusCard({ best: '不是对象', unread: 1 }) === 'string', 'best 不是对象时当没有处理')
const junk = card({ scanned: 'abc', injected: -1, unread: Number.NaN, omitted: 2.9 })
ok(junk.includes('2 条'), '坏数字当 0、小数向下取整', junk)
ok(!junk.includes('NaN') && !junk.includes('abc'), '卡片里不出现原始坏值')
const huge = card({ unread: 1e9 })
ok(huge.includes('999999+') && bytes(huge) <= STATUS_MAX_BYTES, '超大计数按显示上限收口（字节上界才可证）')
const folded = card({ unread: 1, best: { file: 'project_alpha.md', title: '第一行\n第二行' } })
ok(folded.includes('第一行 第二行'), '字段里的换行被折成空格（否则会拆出半截行）')
ok(linesOf(folded).every(l => l.endsWith('。')), '折叠后每行仍是完整句子')
const inp = { ...BASE, unread: 3 }
const before = j(inp)
ok(j(renderStatusCard(inp)) === j(renderStatusCard(inp)), '纯函数：同输入两次结果一致')
ok(j(inp) === before, '不修改传入的输入对象')

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
