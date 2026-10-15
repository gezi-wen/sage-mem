/**
 * 分段层断言（lib/memory/chunks.js）。
 *
 * 为什么值得单开一个套件：段落行号与 id 是 `read_memory` / 注入链的直接输入。
 * 这类错误不会抛异常 —— 它只会静默地让你取回「隔壁那一段」，所以只能靠逐条核对
 * 行号把它钉住。全部 fixture 都是合成文本，不含任何真实记忆内容。
 */
import {
  chunkFile,
  revisionOf,
  frontmatterEndLine,
  CHUNK_TARGET_CHARS,
  CHUNK_MAX_CHARS,
  CHUNK_MIN_CHARS,
} from '../lib/memory/chunks.js'

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

/** 段落速览：`起-止@标题`，失败时好一眼看出错在哪。 */
const shape = (chunks) => j(chunks.map(c => `${c.startLine}-${c.endLine}@${c.headingPath}`))

console.log('== 1. 常量 ==')
ok(CHUNK_TARGET_CHARS === 600, `目标段落长度 600（实际 ${CHUNK_TARGET_CHARS}）`)
ok(CHUNK_MAX_CHARS === 900, `硬上限 900（实际 ${CHUNK_MAX_CHARS}）`)
ok(CHUNK_MIN_CHARS === 60, `独立成段门槛 60（实际 ${CHUNK_MIN_CHARS}）`)

/*
 * 主 fixture：行号全部按 1-based 手工数过。7 行 frontmatter（含一个缩进子键）
 * 之后是两级标题 + 三个长段 + 一个短段，用来同时验行号、headingPath 与「短段向上合并」。
 */
const P1 = '甲段第一行的正文内容，这里凑够六十个字符以上，以便这一段能独立成段而不被向后合并掉。'
const P2 = '甲段第二行的正文内容，同样是为了把这一段拉到足够长，好让行号核对这件事真正有意义。'
const P3 = '乙段第一行正文，需要独立成段来验证 headingPath 与行号是否算得正确，所以这里要写长一点才行，长到足以跨过门槛。'
const P4 = '丙段第一行正文，用来核对代码块之后的段落起点行号是否正确无误，这里继续补足字数，确保它稳稳超过六十个字符的门槛。再多写一句以免数错。'
const P5 = '短句。'
const DOC_LINES = [
  '---', // 1
  'name: chunks-fixture', // 2
  'description: 合成语料，用来核对分段行号', // 3
  'metadata:', // 4
  '  type: project', // 5
  '---', // 6
  '', // 7
  '# 甲标题', // 8
  '', // 9
  P1, // 10
  P2, // 11
  '', // 12
  '## 乙子标题', // 13
  '', // 14
  P3, // 15
  '', // 16
  P4, // 17
  '', // 18
  P5, // 19
]
const DOC = DOC_LINES.join('\n')

console.log('== 2. 行号是 1-based、相对整份文件（含 frontmatter）==')
// 先钉住 fixture 本身：乙段与丙段都得真的过 60，否则「短段合并」会把预期结构吃掉
// （甲段的两行之间没有空行，本来就是同一块，不参与这条约束）。
ok(P3.length >= CHUNK_MIN_CHARS && P4.length >= CHUNK_MIN_CHARS, 'fixture 的乙段与丙段都 ≥ 60 字符', j([P3.length, P4.length]))
ok(DOC.split('\n').length === 19, 'fixture 共 19 行', String(DOC.split('\n').length))
ok(frontmatterEndLine(DOC_LINES) === 6, `frontmatter 结束在第 6 行（实际 ${frontmatterEndLine(DOC_LINES)}）`)

const doc = chunkFile({ file: 'doc.md', content: DOC })
ok(doc.length === 3, `切成 3 段（实际 ${doc.length}）：${shape(doc)}`)
ok(
  shape(doc) === j(['8-11@甲标题', '13-15@甲标题 › 乙子标题', '17-19@甲标题 › 乙子标题']),
  '逐段核对起止行号与 headingPath',
  shape(doc),
)
ok(doc[0].startLine === 8 && doc[0].endLine === 11, '第 1 段覆盖标题行 8 到正文 11（标题行本身留在正文里）')
ok(doc[1].startLine === 13 && doc[1].endLine === 15, '第 2 段从二级标题行 13 起')
ok(doc[2].startLine === 17 && doc[2].endLine === 19, '第 3 段把 17 行与 19 行的短句合并在一起')
ok(doc[2].text.endsWith(P5), '短段是**向上**并进上一段（结尾仍是短句）', j(doc[2].text.slice(-12)))
// 回归断言：两段原本就隔着空行，合并时必须用 `\n\n` —— 用单换行拼会把它们粘成一整段。
ok(doc[2].text === `${P4}\n\n${P5}`, '合并后的文本里两段之间保留空行', j(doc[2].text.slice(-16)))
ok(doc[0].text.includes('甲段第一行') && doc[0].text.includes('甲段第二行'), '第 1 段正文含两行原文')
ok(doc.every(c => c.startLine > 6), '没有任何段落落在 frontmatter 的 1-6 行里', shape(doc))

console.log('== 3. frontmatter 不进段落 ==')
const onlyFm = chunkFile({ file: 'x.md', content: '---\nname: x\ndescription: y\n---\n' })
ok(onlyFm.length === 0, `只有 frontmatter 的文件不产生段落（实际 ${onlyFm.length}）`)
ok(!doc.some(c => c.text.includes('description:') || c.text.includes('name:')), '段落正文里不出现 frontmatter 的键名')
ok(chunkFile({ file: 'x.md', content: '' }).length === 0, '空内容不产生段落')
ok(chunkFile().length === 0, 'chunkFile() 无参不抛错且返回空数组')
ok(chunkFile({ file: 'x.md', content: '---\nname: x\n正文一' }).length === 1, '只有开头 --- 没有结束：整体当正文（与 frontmatter.js 的正则同形）')

console.log('== 4. frontmatterEndLine 三种情形 ==')
ok(frontmatterEndLine(['# 标题', '', '正文']) === 0, '无 frontmatter → 0')
ok(frontmatterEndLine(['---', 'name: x', '', '正文']) === 0, '只有开头 --- 没有结束 → 0')
ok(frontmatterEndLine(['# 标题', '', '---', '', '正文']) === 0, '正文里的 --- 水平线不算 frontmatter → 0')
ok(frontmatterEndLine(['---', 'name: x', '---', '', '正文']) === 3, '正常闭合时返回闭合行号 3')
ok(frontmatterEndLine([]) === 0 && frontmatterEndLine(undefined) === 0, '空数组 / undefined → 0')

console.log('== 5. CRLF 与 LF 给出完全相同的结果 ==')
// 只比段落本体，**不比 revision**：revision 是内容哈希，换行符不同本就该不同值。
const withoutRevision = (chunks) => chunks.map(({ revision, ...rest }) => rest)
const crlf = chunkFile({ file: 'doc.md', content: DOC.replace(/\n/g, '\r\n') })
ok(j(withoutRevision(crlf)) === j(withoutRevision(doc)), 'CRLF 与 LF 的段落（行号 / 正文 / id / 标题路径）逐字段相同')
ok(crlf[0].revision !== doc[0].revision, 'CRLF 是不同字节 → revision 跟着变，这是设计而非错位')

console.log('== 6. 围栏代码块里的空行不分段 ==')
// 两侧代码行都刻意超过 60 字符：真被空行切开的话，两半谁也不会被合并掩盖。
const codeA = `const a = '${'a'.repeat(80)}'`
const codeB = `const b = '${'b'.repeat(80)}'`
const FENCE = [
  '---', // 1
  'name: fence-fixture', // 2
  '---', // 3
  '', // 4
  '# 代码样例', // 5
  '', // 6
  '```js', // 7
  codeA, // 8
  '', // 9
  codeB, // 10
  '```', // 11
  '', // 12
  '尾段正文，写够六十个字符以上，确保它是独立的一段而不会并入代码块，这样断言才分得清，再多补几个字以免数错，到这里应该够了。', // 13
].join('\n')
ok(codeA.length > CHUNK_MIN_CHARS && codeB.length > CHUNK_MIN_CHARS, 'fixture 两侧代码行都 > 60（切开就藏不住了）')
const fence = chunkFile({ file: 'fence.md', content: FENCE })
ok(fence.length === 2, `代码块整体算 1 段（实际 ${fence.length}）：${shape(fence)}`)
ok(fence[0].startLine === 5 && fence[0].endLine === 11, '代码块段落覆盖 5-11 行（标题行 + 围栏起止）', shape(fence))
ok(
  fence[0].text.includes(`${codeA}\n\n${codeB}`),
  '代码块内部的空行被原样保留，没有被当成分段点',
  j(fence[0].text.slice(0, 30)),
)
ok(
  j(withoutRevision(chunkFile({ file: 'fence.md', content: FENCE.replace(/\n/g, '\r\n') }))) === j(withoutRevision(fence)),
  'CRLF 的围栏代码块同样不分段',
)

console.log('== 7. 长块被切开：片段不重叠、行号单调 ==')
const fill = Array.from({ length: 20 }, (_, i) => `第 ${String(i + 1).padStart(2, '0')} 行填充内容：${'填'.repeat(50)}`)
const LONG = ['---', 'name: longblock', '---', '', '# 长块', '', ...fill].join('\n')
const long = chunkFile({ file: 'long.md', content: LONG })
ok(long.length >= 3, `超过 900 字符的块被切成多片（实际 ${long.length}）：${shape(long)}`)
ok(long.every(c => c.text.length <= CHUNK_MAX_CHARS), '每个片段都不超过硬上限 900', j(long.map(c => c.text.length)))
ok(long.every((c, i) => i === 0 || long[i - 1].endLine < c.startLine), '片段之间不重叠：上一片的结束行严格小于下一片的开始行', shape(long))
ok(long[0].startLine === 5 && long[long.length - 1].endLine === 26, '首片从标题行 5 起、末片到正文最后一行 26', shape(long))
ok(long.every(c => c.text.length > 0), '没有空片段')

console.log('== 8. 单行超长：不一个片段占满、不死循环 ==')
const longLine = '甲'.repeat(5000)
const ONE = ['---', 'name: oneline', '---', '', '# 单行', '', longLine].join('\n')
const one = chunkFile({ file: 'one.md', content: ONE })
const onePieces = one.filter(c => c.id.startsWith('one.md#7-7'))
ok(one.length === 10, `5000 字符单行切成 9 片 + 1 个标题片（实际 ${one.length}）：${shape(one)}`)
ok(onePieces.length === 9, `长行本身切成 9 片（实际 ${onePieces.length}）`)
ok(one.every(c => c.text.length <= CHUNK_MAX_CHARS), '每一片都不超过硬上限', j(one.map(c => c.text.length)))
ok(onePieces.map(c => c.text).join('') === longLine, '九片拼起来等于原始长行：既不重叠也不丢字')
ok(onePieces.every(c => c.startLine === 7 && c.endLine === 7), '长行的所有片段共享那一行的行号（行号粒度不承诺到字节）')
const noNewline = chunkFile({ file: 'raw.md', content: '乙'.repeat(5000) })
ok(noNewline.length === 9 && noNewline.every(c => c.text.length <= CHUNK_MAX_CHARS), `无换行的 5000 字符单行也正常收敛（实际 ${noNewline.length} 片）`)

console.log('== 9. id：形式 `file.md#起-止`、同文件内唯一 ==')
ok(/^doc\.md#\d+-\d+$/.test(doc[0].id), `常见形状是 file.md#起-止（实际 ${doc[0].id}）`)
for (const [name, chunks] of [['doc', doc], ['fence', fence], ['long', long], ['one', one], ['raw', noNewline]]) {
  const ids = chunks.map(c => c.id)
  ok(new Set(ids).size === ids.length, `${name}.md 的 id 在同一文件内唯一（${ids.length} 片）`)
}
// 这条是回归断言：单行超长时多片共享同一行号，光用行号当 id 会撞车（曾经 10 片只剩 2 个 id）。
const oneIds = one.map(c => c.id)
ok(
  j(oneIds) === j(['one.md#5-5', ...Array.from({ length: 9 }, (_, i) => (i === 0 ? 'one.md#7-7' : `one.md#7-7~${i}`))]),
  '撞车时按 `~n` 递增后缀，常见情形保持 file#起-止 的可读形式',
  j(oneIds),
)

console.log('== 10. revisionOf 与 knownRevision ==')
ok(revisionOf('同一份内容') === revisionOf('同一份内容'), '同内容 → 同 revision')
ok(revisionOf('同一份内容') !== revisionOf('同一份内宾'), '改一个字符 → revision 就变')
ok(revisionOf(undefined) === revisionOf(''), 'undefined 按空串算')
ok(/^sha256:[0-9a-f]{12}$/.test(revisionOf('x')), `形状是 sha256:12 位十六进制（实际 ${revisionOf('x')}）`)
const known = chunkFile({ file: 'k.md', content: DOC }, 'sha256:0123456789ab')
ok(known.every(c => c.revision === 'sha256:0123456789ab'), '传了 knownRevision 就不再自己算')
ok(chunkFile({ file: 'k.md', content: DOC })[0].revision === revisionOf(DOC), '不传时自己按内容算')
ok(new Set(doc.map(c => c.revision)).size === 1, '同一份文件的所有段落共享同一 revision')
ok(doc[0].revision === revisionOf(DOC), '段落 revision 等于整份内容的 revision')

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
