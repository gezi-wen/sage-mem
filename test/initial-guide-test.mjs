/**
 * initial-guide-test.mjs — 2.12.0「初始记忆」提示词的断言。
 *
 * 这一版唯一交付物就是**一段文本**，所以测试也对着文本断言 —— 没有 host 侧代码可测，
 * 也不该有（插件不写任何记忆文件；真正动笔的是会话里的 agent）。
 *
 * 四组：
 *   1. 组装出口的形状：`buildInitialGuide()` 返回 {text, file, lines}，纯函数（两次调用同值）；
 *   2. 必写要点逐条在场：先读随包技能 / **已有文件只做增量** / 索引 / 流水 / 三步起步记忆 / 收尾自检；
 *   3. 反向对照：把「只做增量」那句删掉，`guideProblems()` 必须报出来 —— 否则第 2 组只是摆设；
 *   4. 不许出现的东西：个人信息、版本号、host 机制细节（frontmatter 字段表 / SAGE_MEM_* 环境变量）、CRLF。
 */
import { readFileSync } from 'node:fs'

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

const SRC = readFileSync(new URL('../client/66-initial-guide.js', import.meta.url), 'utf8')
// 分片是工厂作用域里的顶层语句（const + function 声明），把它整段当函数体跑一遍就能拿到出口。
// 这比「渲染一遍卡片再从 DOM 里抠文本」直接：本测试要钉的是**文本内容**，不是排版。
const load = new Function(`${SRC}
;return { buildInitialGuide: buildInitialGuide, initialGuideLines: initialGuideLines, INITIAL_GUIDE_FILE: INITIAL_GUIDE_FILE }`)
const { buildInitialGuide, INITIAL_GUIDE_FILE } = load()

/**
 * 提示词必须满足的要点 → 判据（一条一个断言名）。
 * 返回命中的问题清单；`text` 是可替换的（反向对照用）。
 */
const REQUIRED = [
  ['read-skill', '先读随包技能，别在这份提示里复述机制', (t) => t.includes('sage-mem 技能')],
  ['increment-only', '已有文件只做增量（防覆盖条款）', (t) => t.includes('已有文件一律只做增量')],
  ['no-overwrite', '明确写「不要覆盖」', (t) => t.includes('不要覆盖')],
  ['ask-when-unsure', '拿不准就停下来问', (t) => t.includes('停下来问')],
  ['index-file', '索引文件 MEMORY.md', (t) => t.includes('MEMORY.md')],
  ['index-one-line', '索引一行一条的格式', (t) => t.includes('- [文件名](文件名)')],
  ['log-file', '流水 session-log.md', (t) => t.includes('session-log.md')],
  ['log-format', '流水的时间标题格式', (t) => t.includes('## YYYY-MM-DD HH:MM')],
  ['four-prefixes', '四类前缀都在', (t) =>
    ['user_', 'feedback_', 'project_', 'reference_'].every((p) => t.includes(p))],
  ['starter-1', '起步记忆 1：记忆纪律', (t) => t.includes('feedback_memory-discipline.md')],
  ['starter-2', '起步记忆 2：库结构', (t) => t.includes('reference_memory-layout.md')],
  ['starter-3', '起步记忆 3：收尾动作', (t) => t.includes('feedback_session-hygiene.md')],
  ['not-derivable', '「推不出来的才存」这条判据', (t) => t.includes('推不出来')],
  ['no-baseline', '禁止写 baseline: true', (t) => /不要写\s*`baseline: true`/.test(t)],
  ['no-personal', '不预置个人信息（明说）', (t) => t.includes('不要预置我的个人信息')],
  ['todo-duty', '待办看板的搬运义务', (t) => t.includes('已完成，待删除')],
  ['wrap-up', '收尾自检四问', (t) => t.includes('第 4 步')],
]

/** 提示词里**不许**出现的东西：个人信息、版本号、host 机制细节。 */
const FORBIDDEN = [
  ['no-personal-name', '不含真名', (t) => !t.includes('文歌子')],
  ['no-sage-name', '不含三殿内部称呼', (t) => !t.includes('昼殿') && !t.includes('圣殿')],
  ['no-local-path', '不含本机路径', (t) => !/E:\\\\?shengdian|E:\/shengdian/.test(t)],
  ['no-version', '不含版本号字面量', (t) => !/\b\d+\.\d+\.\d+\b/.test(t)],
  ['no-env-vars', '不写 SAGE_MEM_* 环境变量', (t) => !t.includes('SAGE_MEM_')],
  ['no-frontmatter-table', '不抄 frontmatter 字段表（机制住随包技能）', (t) => !t.includes('node_type')],
  ['no-crlf', '正文是 LF（没有 \\r）', (t) => !t.includes('\r')],
]

/** 把两组判据跑一遍，返回 { id, why } 的问题清单。 */
function guideProblems(text) {
  const out = []
  for (const [id, why, test] of REQUIRED) if (!test(text)) out.push({ id, why })
  for (const [id, why, test] of FORBIDDEN) if (!test(text)) out.push({ id, why })
  return out
}

console.log('== 1. 组装出口的形状 ==')
{
  const built = buildInitialGuide()
  ok(typeof built === 'object' && built !== null, 'buildInitialGuide() 返回对象')
  ok(typeof built.text === 'string' && built.text.length > 1500, `正文足够长（实际 ${built.text ? built.text.length : 0} 字符）`)
  ok(built.lines >= 40, `正文行数 ≥ 40（实际 ${built.lines}）`)
  ok(built.file === INITIAL_GUIDE_FILE, '返回的下载文件名与常量一致（单一真相源）')
  ok(/^[^\\/]+\.md$/.test(built.file), `文件名是裸 .md（实际 ${built.file}）`)
  const again = buildInitialGuide()
  ok(again.text === built.text && again.lines === built.lines, '纯函数：两次调用逐字节相同')
  ok(initialGuideLinesLength(), '行数组与 text 的行数对得上')
}
function initialGuideLinesLength() {
  const built = buildInitialGuide()
  return built.text.split('\n').length === built.lines
}

console.log('\n== 2. 必写要点逐条在场 ==')
{
  const built = buildInitialGuide()
  for (const [id, why, test] of REQUIRED) ok(test(built.text), `${id} — ${why}`)
  ok(guideProblems(built.text).length === 0, '整体：没有任何要点缺失',
    JSON.stringify(guideProblems(built.text).slice(0, 3)))
}

console.log('\n== 3. 反向对照：改坏一句必须被抓住 ==')
{
  const built = buildInitialGuide()
  const withoutClause = built.text.replace('已有文件一律只做增量', '看着办')
  const problems = guideProblems(withoutClause)
  ok(problems.some((p) => p.id === 'increment-only'), '【反向对照】删掉「只做增量」那句会被抓到',
    problems.map((p) => p.id).join(','))
  ok(problems.length === 1, '【反向对照】只改了那一句时只报那一条（判据之间不互相顶替）',
    problems.map((p) => p.id).join(','))

  const withCaps = built.text + '\r\n随便加一行\r\n'
  ok(guideProblems(withCaps).some((p) => p.id === 'no-crlf'), '【反向对照】混进 CRLF 会被抓到')

  const withName = built.text + '\n文歌子的记忆\n'
  ok(guideProblems(withName).some((p) => p.id === 'no-personal-name'), '【反向对照】混进真名会被抓到')

  const withVersion = built.text + '\nsage-mem 2.12.0\n'
  ok(guideProblems(withVersion).some((p) => p.id === 'no-version'), '【反向对照】混进版本号会被抓到')
}

console.log('\n== 4. 不许出现的东西 ==')
{
  const built = buildInitialGuide()
  for (const [id, why, test] of FORBIDDEN) ok(test(built.text), `${id} — ${why}`)
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
