#!/usr/bin/env node
/**
 * 单一事实来源的对拍（1.3.0 新增）。
 *
 * 1.3.0 把「合法 .md 文件名」「本地时间戳」「frontmatter 解析」各自收敛成一份实现。
 * 这个套件盯的是**收敛之后各处判据仍然同宽** —— 不是读源码，是拿同一批输入喂给每个入口，
 * 比较接受/拒绝集合与输出。收敛的反面（某处又抄了一份、且抄漏一个条件）会当场现形。
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const sandbox = join(tmpdir(), 'sage-mem-parity-' + process.pid)
mkdirSync(join(sandbox, 'memory'), { recursive: true })
process.env.SAGE_MEM_DIR = join(sandbox, 'memory')
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const LIB = new URL('../lib/', import.meta.url)
const { isPlainMdName } = await import(new URL('shared/md-name.js', LIB).href)
const { rawName } = await import(new URL('settings.js', LIB).href)
const { safeName } = await import(new URL('memory/naming.js', LIB).href)
const { TYPERT } = await import(new URL('typert.host.js', LIB).href)
const { stampHuman, stampCompact } = await import(new URL('shared/stamp.js', LIB).href)
const { localStamp } = await import(new URL('memory/scan.js', LIB).href)
const { stampHuman: adHuman, stampCompact: adCompact } = await import(new URL('autodream/util.js', LIB).href)
const { parseFrontmatter } = await import(new URL('memory/frontmatter.js', LIB).href)
const { parseFrontmatterLite } = await import(new URL('autodream/audit.js', LIB).href)
const { safeMemoryPath } = await import(new URL('autodream/tools.js', LIB).href)

const fileNameSchema = TYPERT.invocations.find((i) => i.id === 'sage-mem#memory/readFile').parameters[0].codec.schema

// ── 1. 文件名：四个入口的接受集合必须同宽 ───────────────────────
group('1. 文件名判据：isPlainMdName / rawName / fileNameSchema / safeName')
{
  const inputs = [
    'a.md', 'A.MD', 'a.Md', 'a.txt', '.md', 'md', '', ' ', 'a b.md', '项目_一.md',
    'a/b.md', 'a\\b.md', '..\\a.md', '../a.md', 'a..md', '..a.md', 'a:b.md', 'MEMORY.md:evil.md',
    'a:b', 'a.b.md', 'a.md ', ' a.md', 'a?.md', 'a*.md', 'a|.md', 'a<.md', 'a>.md', 'a".md',
    'session-log.md', 'memory.md', 'MEMORY.md', 'Session-Log.md', 'x'.repeat(240) + '.md',
  ]
  const accepted = (fn) => inputs.map((s) => !!fn(s))
  const plain = accepted((s) => isPlainMdName(s))
  const raw = accepted((s) => rawName(s))
  const schema = accepted((s) => fileNameSchema.safeParse(s).success)
  ok(JSON.stringify(plain) === JSON.stringify(raw), 'isPlainMdName 与 rawName 的接受集合一致',
    inputs.filter((s, i) => plain[i] !== raw[i]).join(','))
  ok(JSON.stringify(plain) === JSON.stringify(schema), 'isPlainMdName 与 typert fileNameSchema 的接受集合一致',
    inputs.filter((s, i) => plain[i] !== schema[i]).join(','))
  // safeName = 同一底线 + 「不是非记忆条目」
  const expectedSafe = inputs.map((s) => isPlainMdName(s) && !/^(memory|session-log)\.md$/i.test(s))
  ok(JSON.stringify(expectedSafe) === JSON.stringify(accepted((s) => safeName(s))),
    'safeName = isPlainMdName − 非记忆条目（索引 / 流水被拒）',
    inputs.filter((s, i) => expectedSafe[i] !== !!safeName(s)).join(','))
  ok(isPlainMdName('a.md') && !isPlainMdName('a/b.md') && !isPlainMdName('a\\b.md'), '路径分隔符在两种平台上都拒')
  ok(!isPlainMdName('x:y.md'), '冒号（NTFS 交替数据流）一律拒')
  ok(isPlainMdName('A.MD'), '扩展名大小写不敏感（与文件系统同宽）')
  const long = 'x'.repeat(250) + '.md' // 254 字符：底线规则收，传输层 255 上限也收
  ok(isPlainMdName(long) && fileNameSchema.safeParse(long).success, '254 字符的名字两侧都收')
  const tooLong = 'x'.repeat(260) + '.md'
  ok(isPlainMdName(tooLong) && !fileNameSchema.safeParse(tooLong).success, '超长名字：底线规则不管长度，传输层 max(255) 管')
  ok(safeName('MEMORY.md') === null && rawName('MEMORY.md') === 'MEMORY.md', '索引名：safeName 拒（不是一条记忆）、rawName 收（原样读写目标）')

  // ── 第 5 个消费者（2.1.24 收敛）：autodream 写路径的入口 ──
  // 它原先自己抄了一份判据，只拒 `/ \ ..`，于是 `a:b.md` / `MEMORY.md:evil.md`
  // 能一路走到 join —— 那是**模型可达**的写路径（write_memory / report_contradiction）。
  const acceptPath = inputs.map((s) => !!safeMemoryPath('/mem', s))
  // 语义上先 trim 再判；额外只多一条「不写隐藏文件」
  const expectPath = inputs.map((s) => { const t = s.trim(); return isPlainMdName(t) && !t.startsWith('.') })
  ok(JSON.stringify(expectPath) === JSON.stringify(acceptPath),
    'safeMemoryPath = isPlainMdName（先 trim）− 隐藏文件',
    inputs.filter((s, i) => expectPath[i] !== acceptPath[i]).join(','))
  // ① 不许比基准**宽**：接受基准拒绝的名字 = 判据漂了（这正是 2.1.24 之前的 bug 形状）。
  //    基准取 **trim 后**：safeMemoryPath 的语义是「先去掉首尾空白再判名字」，
  //    所以 `'a.md '` 被它接受是设计，不算宽。
  const plainTrim = inputs.map((s) => isPlainMdName(s.trim()))
  const wider = inputs.filter((s, i) => acceptPath[i] && !plainTrim[i])
  ok(wider.length === 0, 'safeMemoryPath 不比基准宽（trim 后，不接受基准拒绝的名字）', wider.join(','))
  // ② 比基准严的项只许是「. 开头」这一类
  const stricter = inputs.filter((s, i) => !acceptPath[i] && plainTrim[i])
  ok(stricter.every((s) => s.trim().startsWith('.')), 'safeMemoryPath 比基准严的项只有隐藏文件', stricter.join(','))
  // ③ 报告里的具体形状，钉成行为断言
  ok(!safeMemoryPath('/mem', 'a:b.md') && !safeMemoryPath('/mem', 'MEMORY.md:evil.md'), 'NTFS 交替数据流名字被写路径拒绝')
  ok(!!safeMemoryPath('/mem', 'a.md') && !safeMemoryPath('/mem', '.hidden.md'), '正常名字收、隐藏文件拒')
  // ④ 反向对照：判据本身会红
  const fakeWide = (s) => !!s
  const fakeWider = inputs.filter((s) => fakeWide(s) && !isPlainMdName(s))
  ok(fakeWider.length > 0, '【反向对照】「照收」的实现会被「不比基准宽」抓到', fakeWider.slice(0, 3).join(','))
  const fakeStrict = (s) => isPlainMdName(s) && !s.trim().startsWith('.') && !s.startsWith('session-')
  const fakeStricter = inputs.filter((s) => !fakeStrict(s) && isPlainMdName(s))
  ok(fakeStricter.some((s) => !s.trim().startsWith('.')), '【反向对照】多拒一类会被「只许隐藏文件」抓到', fakeStricter.join(','))
}

// ── 2. 时间戳：三处入口逐字相同 ─────────────────────────────────
group('2. 时间戳：shared / scan / autodream 三处输出逐字相同')
{
  const oldHuman = (ms) => {
    const d = new Date(ms); const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const oldCompact = (ms) => {
    const d = new Date(ms); const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }
  const times = [
    new Date(2026, 0, 1, 0, 0, 0).getTime(),
    new Date(2026, 11, 31, 23, 59, 59).getTime(),
    new Date(2026, 6, 15, 9, 5, 7).getTime(),
    new Date(2027, 2, 1, 0, 0, 1).getTime(),
    Date.parse('2026-10-20T19:45:00+08:00'),
  ]
  ok(times.every((ms) => stampHuman(ms) === oldHuman(ms)), 'stampHuman 与 1.2.x 实现逐字相同')
  ok(times.every((ms) => stampCompact(ms) === oldCompact(ms)), 'stampCompact 与 1.2.x 实现逐字相同')
  ok(times.every((ms) => localStamp(ms) === stampHuman(ms)), 'scan.localStamp 就是 shared.stampHuman')
  ok(times.every((ms) => adHuman(ms) === stampHuman(ms) && adCompact(ms) === stampCompact(ms)),
    'autodream/util 的两个再导出指向同一实现')
  ok(stampHuman(times[2]) === '2026-07-15 09:05', '给人看的形态是 YYYY-MM-DD HH:mm', stampHuman(times[2]))
}

// ── 3. frontmatter：正典 vs 审计薄包装 ─────────────────────────
group('3. frontmatter：parseFrontmatter 与 parseFrontmatterLite 逐字段一致')
{
  const cases = [
    '---\nname: a\ndescription: d\ntype: project\n---\n\n正文',
    '---\r\nname: a\r\ndescription: d\r\ntype: project\r\n---\r\n\r\n正文',
    '---\nname: a\ndescription: d\nmetadata:\n  node_type: memory\n  type: feedback\n---\n\n正文',
    '---\nname: a\ndescription: d\nmetadata:\n  type: project\n  updated: 2026-01-01\n---\n\n正文',
    '---\nname: "引号值"\ndescription: \'单引号\'\ntype: reference\n---\n\n正文',
    '---\r\nname: a\r\ndescription: d\r\nmetadata:\r\n  type: project\r\n---\r\n\r\n正文',
    '---\nname: a\n---\n\n没有 description 与 type',
    '---\ntype: user\n---\n\n只有 type',
    '---\n---\n\n空 frontmatter',
    '没有 frontmatter 的正文\n',
    '',
    '---\nname: a\ndescription: d\ntype: project\n',
    '\uFEFF---\nname: bom\ndescription: d\ntype: project\n---\n\nBOM 开头',
    '---\ntags:\n  - a\n  - b\nname: t\ntype: reference\n---\n\n正文',
  ]
  for (const c of cases) {
    const canon = parseFrontmatter(c)
    const lite = parseFrontmatterLite(c)
    const same = canon.name === lite.name && canon.description === lite.description &&
      String(canon.type).trim() === lite.type
    ok(same, `name/description/type 一致（${JSON.stringify(c.slice(0, 24))}…）`,
      JSON.stringify({ canon: [canon.name, canon.description, canon.type], lite: [lite.name, lite.description, lite.type] }))
    const shouldHave = canon.name !== '' || canon.description !== '' || canon.type !== ''
    ok(lite.hasFrontmatter === shouldHave || (lite.hasFrontmatter === true && !shouldHave),
      `hasFrontmatter 与「是否解析出字段」不矛盾（${JSON.stringify(c.slice(0, 16))}…）`,
      `hasFrontmatter=${lite.hasFrontmatter} parsed=${shouldHave}`)
  }
  // 真实语料 30 份：两份解析器逐份一致
  const { readFileSync, readdirSync } = await import('node:fs')
  const corpus = new URL('../test/eval/corpus/', import.meta.url)
  const files = readdirSync(corpus).filter((f) => f.endsWith('.md'))
  let bad = 0
  for (const f of files) {
    const text = readFileSync(new URL(f, corpus), 'utf8')
    const a = parseFrontmatter(text)
    const b = parseFrontmatterLite(text)
    if (a.name !== b.name || a.description !== b.description || String(a.type).trim() !== b.type) bad++
  }
  ok(files.length >= 25, `评测语料里读到足够多的 md（${files.length} 份）`)
  ok(bad === 0, `评测语料里两份解析器逐份一致（不一致 ${bad} 份）`)
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
