/**
 * 检索面断言（lib/memory/search.js）。
 *
 * 这个套件盯三件事：
 *   1. **长文不许垄断**（本次改动最核心的一条）；
 *   2. **相关性门槛**：BM25 对任何问题都给得出非零分，所以「有分」不等于「相关」——
 *      滤掉的条数必须能被区分成「不够格」而不是「没有候选」；
 *   3. 线上形状（scope / limit / cursor / excerpt / 缓存）不出错。
 * 这四样都不会抛异常，错了只是「悄悄给错的结果」，只能靠断言拦住。
 *
 * 全部 fixture 都是合成文本，不含任何真实记忆内容。
 * 语料里刻意垫了 150 份与查询完全无关的填充材料：段落数太少会让 df/N 失真，
 * 那正是相关性门槛最容易误杀真命中的地方（见 §15）。
 *
 * ⚠️ 门槛现在是**四条同时成立**（ratio / sum / 冷门 / 连续命中），
 * 所以所有 retrieve 用例的 query 都必须能在目标段落里**连续命中 ≥ 2 个词元**
 * （对纯中文就是「至少 3 个字连着出现」）。这是有意的设计，不是可以绕开的细节。
 */
import {
  rankChunks,
  rankChunksInternal,
  retrieve,
  summaryHits,
  chunksOf,
  excerptAround,
  normalizeScope,
  __resetSearchCacheForTest,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PER_FILE_CHUNKS,
  EXCERPT_CHARS,
  MIN_EVIDENCE_RATIO,
  MIN_EVIDENCE_SUM,
  MAX_EVIDENCE_DF_RATIO,
  MIN_MATCHED_RUN,
} from '../lib/memory/search.js'
import { queryTermsOf, tokenize, evidence, idfOf, maxMatchedRun } from '../lib/memory/bm25.js'
import { revisionOf } from '../lib/memory/chunks.js'

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
const eq = (a, b) => j(a) === j(b)

/** 组装一条记忆：file + description + 正文（正文自带同名 frontmatter，贴近 scanMemoryFiles 的给法）。 */
const fm = (meta, body) => `---\n${meta}\n---\n\n${body}\n`
const mem = (file, description, body, aliases = []) => ({
  file,
  description,
  aliases,
  content: fm(`name: ${file.replace(/\.md$/, '')}\ndescription: ${description}`, body),
})
const filesOf = (list) => list.map(h => h.file)

/** 填充语料：文件名与 description 都用中文，避免和 ASCII 查询在双字面上偶然重合。 */
const FILL = Array.from({ length: 150 }, (_, i) => mem(
  `填充材料第${i}条.md`,
  `与任何查询都无关的填充材料第 ${i} 条`,
  `# 填充 ${i}\n\n第 ${i} 份填充材料，讨论的是与要查的东西完全无关的话题，比如出行路线与做饭的心得体会。`,
))

/** 本套件里 retrieve 用例统一用的查询：三段连续命中，稳稳过「连续命中 ≥ 2」这条判据。 */
const W = '限温超限'

console.log('== 1. 常量 ==')
ok(DEFAULT_LIMIT === 5, `默认条数 5（实际 ${DEFAULT_LIMIT}）`)
ok(MAX_LIMIT === 10, `上限 10（实际 ${MAX_LIMIT}）`)
ok(PER_FILE_CHUNKS === 2, `每文件段落名额 2（实际 ${PER_FILE_CHUNKS}）`)
ok(EXCERPT_CHARS === 200, `片段字符上限 200（实际 ${EXCERPT_CHARS}）`)
ok(MIN_EVIDENCE_RATIO === 0.35, `相关性门槛 ratio 0.35（实际 ${MIN_EVIDENCE_RATIO}）`)
ok(MIN_EVIDENCE_SUM === 1.5, `相关性门槛 sum 1.5（实际 ${MIN_EVIDENCE_SUM}）`)
ok(MAX_EVIDENCE_DF_RATIO === 0.1, `相关性门槛 df/N 0.10（实际 ${MAX_EVIDENCE_DF_RATIO}）`)
ok(MIN_MATCHED_RUN === 2, `连续性门槛 2（实际 ${MIN_MATCHED_RUN}）`)

console.log('== 2. evidence 单元行为（门槛的输入）==')
ok(idfOf(1, 100) > idfOf(50, 100), `越冷门的词元 idf 越大（${idfOf(1, 100).toFixed(3)} > ${idfOf(50, 100).toFixed(3)}）`)
ok(idfOf(100, 100) > 0, `df = N 时 idf 仍为正、不取负（实际 ${idfOf(100, 100).toFixed(5)}）`)
ok(idfOf(100, 100) < 0.05, 'df = N 时 idf 趋近 0')
ok(idfOf(0, 0) === 0 && idfOf(1, 0) === 0, 'N = 0 时 idf 为 0（不除零、不产生 NaN）')
const evStats = { N: 100, avgdl: 10, df: new Map([['甲', 5], ['乙', 100]]) }
const evZero = evidence(['甲', '语料里没有的词'], new Map([['甲', 1]]), evStats)
ok(evZero.matched === 1, 'df = 0 的词元不计入 matched')
ok(evZero.ratio === 1, '⚠️ 分母剔除 df=0 的词元，所以命中唯一存在的词元时 ratio 就是 1', j(evZero.ratio))
ok(evZero.rarestDf === 5 && evZero.rarestDfRatio === 0.05, 'rarestDf 取命中词元里最小的文档频率', j([evZero.rarestDf, evZero.rarestDfRatio]))
const evMiss = evidence(['不存在'], new Map(), evStats)
ok(evMiss.matched === 0 && evMiss.ratio === 0 && evMiss.sum === 0, '一个都没命中时 ratio / sum 都是 0')
ok(evMiss.rarestDf === Number.POSITIVE_INFINITY && evMiss.rarestDfRatio === 1, '没命中时 rarestDf 是 +∞（不能被当成「够冷门」）', j([evMiss.rarestDf, evMiss.rarestDfRatio]))
const evHit = evidence(['甲', '乙'], new Map([['甲', 1], ['乙', 1]]), evStats)
ok(evHit.matched === 2 && evHit.sum > evZero.sum, '命中越多，sum 越大', j([evHit.sum.toFixed(3), evZero.sum.toFixed(3)]))

console.log('== 3. 长文不垄断（本次改动最核心的一条）==')
// 长文：4700 字符反复重复同一对词；短文：一句话把问题说全。
const Q = '温漂 阈值 排查 记录 版本'
const LONG_BODY = '# 系统\n\n' + ('温漂阈值'.repeat(12) + '\n').repeat(96)
const FIX_BODY = '# 温漂记录\n\n系统温漂与阈值的关系，先看排查记录里的版本号，确认改动之前的状态是否一致。'
const longDoc = mem('project_long.md', '系统温漂的长期记录', LONG_BODY)
const fixDoc = mem('project_fix.md', '温漂阈值排查记录', FIX_BODY)
const plaza = [...FILL, longDoc, fixDoc]
ok(LONG_BODY.length > 4000, `fixture 成立：长文 ${LONG_BODY.length} 字符`)
ok(FIX_BODY.length < 900, `fixture 成立：短文 ${FIX_BODY.length} 字符`)

__resetSearchCacheForTest()
const longOwn = chunksOf(plaza).chunks.filter(c => c.file === 'project_long.md').length
ok(longOwn > PER_FILE_CHUNKS + 2, `fixture 成立：长文自身被切成 ${longOwn} 段（远多于 ${PER_FILE_CHUNKS}）`)

const gated = rankChunksInternal(Q, plaza)
ok(gated.hits.length > 0, '默认门槛下有命中', j(filesOf(gated.hits)))
ok(gated.hits[0].file === 'project_fix.md', `精确描述问题的短文排第一（实际 ${gated.hits[0] && gated.hits[0].file}）`, j(filesOf(gated.hits)))
ok(filesOf(gated.hits).filter(f => f === 'project_long.md').length <= PER_FILE_CHUNKS, `长文最多占 ${PER_FILE_CHUNKS} 个候选位`)
ok(gated.filtered >= longOwn, `长文那 ${longOwn} 段被相关性门槛挡住（filtered = ${gated.filtered}）`, String(gated.filtered))

// 关掉门槛看排序机制本身：长文所有段落都参与竞争，仍然只能拿 2 个位次，且排不过短文。
const ungated = rankChunksInternal(Q, plaza, { minEvidence: false })
ok(ungated.filtered === 0, 'minEvidence:false 时没有任何条被滤掉')
const longKept = ungated.hits.filter(h => h.file === 'project_long.md').length
ok(longKept > 0, '关掉门槛后长文确实有命中（不是靠「它没分」赢的）', j(filesOf(ungated.hits)))
ok(longKept === PER_FILE_CHUNKS, `长文段落全部参与竞争时仍只用满 ${PER_FILE_CHUNKS} 个名额（实际 ${longKept}）`)
ok(ungated.hits[0].file === 'project_fix.md', '关掉门槛后短文依然排第一', j(filesOf(ungated.hits)))
const longTop = ungated.hits.filter(h => h.file === 'project_long.md')[0]
ok(ungated.hits[0].score > longTop.score, `短文得分高于长文任何一段（${ungated.hits[0].score.toFixed(2)} > ${longTop.score.toFixed(2)}）`)
ok(eq(rankChunks(Q, plaza).map(h => h.id), gated.hits.map(h => h.id)), 'rankChunks 是 rankChunksInternal().hits 的薄包装（结果一致）')
// 自定义门槛：把四条都放到最松，效果应与关掉门槛一致。
const loose = rankChunksInternal(Q, plaza, { minEvidence: { ratio: 0, sum: 0, maxDfRatio: 1, minRun: 1 } })
ok(loose.hits.length === ungated.hits.length, `自定义门槛被采纳（${loose.hits.length} 条 = 无门槛 ${ungated.hits.length} 条）`)

console.log('== 4. 纯标点 / 空 query 的 rankChunks ==')
ok(eq(rankChunks('。，！', plaza), []), '纯中文标点 → 空数组')
ok(eq(rankChunks('---', plaza), []), '纯符号 → 空数组')
ok(eq(rankChunks('', plaza), []), '空 query → 空数组')
ok(eq(rankChunks('   ', plaza), []), '空白 query → 空数组')

console.log('== 5. 摘要漏掉正文：错误码只在正文中段 ==')
const CODE = 'FS_STALE_VERSION'
const body5 = [
  '# 排查记录', // 6
  '', // 7
  '前面的正文讲了一堆无关的东西，先把背景写清楚再进入正题以免误导读者判断，这一段本身不含关键信息。', // 8
  '', // 9
  '第二段继续铺垫，描述环境与版本，尽量写得像一份真实的排查笔记而不像测试数据，同样与结论无关。', // 10
  '', // 11
  `真正的原因是写入时命中了 ${CODE} 这个错误码，说明版本已经过期需要重新读取，必须先重读再改写。`, // 12
  '', // 13
  '后面的段落继续说明处置方式，把文件重新读一遍再改写就恢复正常了，没有再出现异常，这里是收尾。', // 14
].join('\n')
const writeDoc = mem('写文件注意事项.md', '写文件的注意事项', body5)
const writeSet = [...FILL, writeDoc]
ok(!writeDoc.description.includes(CODE), 'fixture 成立：摘要里没有这个错误码')
ok(summaryHits(CODE, FILL).length === 0, 'fixture 成立：填充语料不会在摘要面上污染这个查询')
__resetSearchCacheForTest()
const r5 = retrieve({ query: CODE, files: writeSet, scope: 'all' })
const codeLine = writeDoc.content.split('\n').findIndex(l => l.includes(CODE)) + 1
ok(filesOf(r5.hits).includes('写文件注意事项.md'), '正文独有的错误码能被检索到', j(filesOf(r5.hits)))
const hit5 = r5.hits.find(h => h.file === '写文件注意事项.md')
ok(Array.isArray(hit5.lines) && hit5.lines[0] <= codeLine && codeLine <= hit5.lines[1], `lines 覆盖错误码所在行 ${codeLine}（实际 ${j(hit5.lines)}）`)
ok(hit5.matchedBy.includes('body'), '标出这是正文命中', j(hit5.matchedBy))
ok(hit5.matchedBy.includes('exact-term'), 'query 原样出现 → 额外标 exact-term', j(hit5.matchedBy))
ok(hit5.excerpt.toLowerCase().includes(CODE.toLowerCase()), '片段里能看到命中词本体')
ok(hit5.revision === revisionOf(writeDoc.content), 'hit 带的是这份内容的 revision')

console.log('== 6. 每文件限量 ==')
// 三段都必须自己就过 60 字符，否则会被「短段合并」并成一段，限量就验不到了 —— 句尾的 pad 就是为这个。
const pad = '这里再补足一些字数，确保它稳稳超过独立成段的门槛。'
const MULTI_BODY = [
  '# 一', '',
  `限温超限处理第一段：先把网关日志翻出来看看有没有异常，这一段刻意写得足够长，保证它能独立成段而不是被向后合并掉。${pad}`, '',
  '# 二', '',
  `限温超限处理第二段：再看后端服务的健康检查结果，这一段同样写得足够长，保证它能独立成段并顺利进入候选表里面。${pad}`, '',
  '# 三', '',
  `限温超限处理第三段：最后确认依赖是否健康，这一段也写得足够长，保证它不会与相邻的段落合并到一起变成一段。${pad}`, '',
].join('\n')
const spread = [...FILL,
  mem('多段命中.md', '多段命中的长文档', MULTI_BODY),
  mem('补充甲.md', '另一份相关记录', '# 其他\n\n限温超限的补充说明，内容写得足够长，保证它是独立的一段而不是被合并掉，这里再补几个字上去。'),
  mem('补充乙.md', '第三份相关记录', '# 再一份\n\n限温超限的另外一条补充，同样写得足够长，确保它单独成段并进入候选表，这里再补几个字上去。'),
]
__resetSearchCacheForTest()
const multiOwn = chunksOf(spread).chunks.filter(c => c.file === '多段命中.md').length
ok(multiOwn === 3, `fixture 成立：多段命中.md 被切成 3 段（实际 ${multiOwn}）`)
const r6 = rankChunks(W, spread, { limit: 10 })
const kept6 = r6.filter(h => h.file === '多段命中.md').length
ok(kept6 <= PER_FILE_CHUNKS, `同一文件最多贡献 ${PER_FILE_CHUNKS} 条（实际 ${kept6}）`)
ok(kept6 === PER_FILE_CHUNKS, '它是得分最高的一档，所以正好用满名额（证明是「被限住」而不是「没命中」）')
ok(r6.length > PER_FILE_CHUNKS, `其他文件仍然进得来（实际共 ${r6.length} 条）`, j(filesOf(r6)))
const kept6No = rankChunksInternal(W, spread, { limit: 10, minEvidence: false }).hits.filter(h => h.file === '多段命中.md').length
ok(kept6No === PER_FILE_CHUNKS, `关掉门槛后限量照样生效（实际 ${kept6No}）`)

console.log('== 7. scope 三态 ==')
const scoped = [...FILL,
  mem('摘要命中.md', `${W}问题的排查思路`, '# 无关正文\n\n这一段正文讲的是完全不同的主题，跟查询词一点关系都没有，纯粹用来占位而已，没有任何命中。'),
  mem('正文命中.md', '一条与问题无关的摘要', `# 正文\n\n这里才写到 ${W} 该怎么处理，先看网关日志再看后端服务的健康检查结果，内容足够长。`),
]
__resetSearchCacheForTest()
const sum7 = retrieve({ query: W, files: scoped, scope: 'summary' })
ok(eq(filesOf(sum7.hits), ['摘要命中.md']), 'summary 只回摘要命中的那条', j(filesOf(sum7.hits)))
ok(sum7.hits[0].lines === null && sum7.hits[0].excerpt === '', '摘要命中不带正文行号与片段', j([sum7.hits[0].lines, sum7.hits[0].excerpt]))
ok(!filesOf(sum7.hits).includes('正文命中.md'), 'summary 不返回只有正文命中的文件')
__resetSearchCacheForTest()
const bod7 = retrieve({ query: W, files: scoped, scope: 'body' })
ok(eq(filesOf(bod7.hits), ['正文命中.md']), 'body 只回正文命中的那条', j(filesOf(bod7.hits)))
ok(!filesOf(bod7.hits).includes('摘要命中.md'), 'body 不返回只有摘要命中的文件')
ok(Array.isArray(bod7.hits[0].lines) && bod7.hits[0].lines[0] <= 7 && bod7.hits[0].lines[1] >= 7, '正文命中带行号', j(bod7.hits[0].lines))
__resetSearchCacheForTest()
const all7 = retrieve({ query: W, files: scoped, scope: 'all' })
ok(all7.hits.length === 2, `all 把两类命中合起来（实际 ${all7.hits.length}）`, j(filesOf(all7.hits)))
ok(new Set(filesOf(all7.hits)).size === all7.hits.length, 'all 里同一文件不重复占位')
const bothDoc = mem('双命中.md', `${W}记录`, `# 正文\n\n${W}的正文段落，写得足够长，保证它自己就能独立成段并参与正文匹配，不会与别的段落合并。`)
__resetSearchCacheForTest()
const r7b = retrieve({ query: W, files: [...FILL, bothDoc], scope: 'all' })
ok(r7b.hits.length === 1, `摘要 + 正文双命中只占一个位（实际 ${r7b.hits.length}）`)
ok(r7b.hits[0].matchedBy.includes('description') && r7b.hits[0].matchedBy.includes('body'), 'matchedBy 同时标出两个来源', j(r7b.hits[0].matchedBy))
ok(Array.isArray(r7b.hits[0].lines), '合并时仍带上最好的正文段落行号', j(r7b.hits[0].lines))

console.log('== 8. normalizeScope ==')
const scopeTable = [
  ['summary', 'summary'], ['body', 'body'], ['all', 'all'],
  ['BODY', 'body'], [' Summary ', 'summary'],
  ['', 'all'], ['weird', 'all'], ['both', 'all'], ['snippets', 'all'],
  [null, 'all'], [undefined, 'all'],
]
for (const [input, want] of scopeTable) {
  ok(normalizeScope(input) === want, `normalizeScope(${j(input)}) === ${j(want)}`, `实际 ${j(normalizeScope(input))}`)
}
ok(normalizeScope('weird') !== 'summary', '非法值回落 all —— 不静默降级成 summary')

console.log('== 9. limit 收敛到 [1, MAX_LIMIT] ==')
// 12 份都命中同一个三段查询：df=12，语料 162 段 → df/N = 0.074，稳过门槛。
const many = Array.from({ length: 12 }, (_, i) => mem(
  `记录第${i}份.md`,
  `第 ${i} 份记录`,
  `# 段${i}\n\n这里有 ${W} 相关的说明，内容写得足够长，保证它自己就能独立成段并参与匹配，不会和别的段落合并。`,
))
const dozen = [...FILL, ...many]
const limitCase = (limit, want, label) => {
  __resetSearchCacheForTest()
  const r = retrieve({ query: W, files: dozen, scope: 'body', limit })
  ok(r.hits.length === want, label, `实际 ${r.hits.length}`)
}
limitCase(undefined, DEFAULT_LIMIT, `不传 limit → ${DEFAULT_LIMIT}`)
limitCase(NaN, DEFAULT_LIMIT, `limit=NaN → ${DEFAULT_LIMIT}`)
limitCase(0, 1, 'limit=0 → 1')
limitCase(-5, 1, 'limit 为负 → 1')
limitCase(3.7, 4, 'limit 小数四舍五入')
limitCase(100, MAX_LIMIT, `limit=100 → ${MAX_LIMIT}`)

console.log('== 10. cursor / nextCursor 翻页不重不漏 ==')
__resetSearchCacheForTest()
const paged = []
let cursor = 0
let guard = 0
while (guard++ < 50) {
  const page = retrieve({ query: W, files: dozen, scope: 'body', limit: 2, cursor })
  ok(page.cursor === cursor, `第 ${guard} 页原样回带 cursor=${cursor}`, String(page.cursor))
  paged.push(...page.hits.map(h => h.id))
  if (page.nextCursor === null) break
  ok(page.nextCursor === page.cursor + 2, `nextCursor = cursor + limit（实际 ${page.nextCursor}）`)
  cursor = page.nextCursor
}
ok(paged.length === 12, `翻页取回全部 12 条（实际 ${paged.length}）`)
ok(new Set(paged).size === paged.length, '翻页没有重复的段落 id')
__resetSearchCacheForTest()
const oneShot = retrieve({ query: W, files: dozen, scope: 'body', limit: MAX_LIMIT })
ok(oneShot.hits.length === MAX_LIMIT, `一次取 ${MAX_LIMIT} 条`)
ok(eq(paged.slice(0, MAX_LIMIT), oneShot.hits.map(h => h.id)), '前 10 条与「一次取 10 条」的顺序完全一致（没有错位）')
// summary 一路的翻页：候选数 ≤ MAX_RESULTS 时同样不重不漏。
const descEight = Array.from({ length: 8 }, (_, i) => mem(
  `摘要第${i}份.md`, `${W}问题的第 ${i} 份记录`,
  `# 正文${i}\n\n这一段正文与查询无关，只用来占位，内容写得足够长以便它自己就能独立成段并被切出来。`,
))
const sumSet = [...FILL, ...descEight]
__resetSearchCacheForTest()
const summaryPool = summaryHits(W, sumSet, MAX_LIMIT).length
ok(summaryPool === 8, '（前置）摘要面上确实有 8 条候选', String(summaryPool))
const pagedSum = []
let sumCursor = 0
let sumPages = 0
let firstSummaryPage = null
for (let i = 0; i < 20; i++) {
  const page = retrieve({ query: W, files: sumSet, scope: 'summary', limit: 3, cursor: sumCursor })
  if (!firstSummaryPage) firstSummaryPage = page
  sumPages++
  pagedSum.push(...filesOf(page.hits))
  if (page.nextCursor === null) break
  sumCursor = page.nextCursor
}
// 回归：候选池必须**比本页窗口宽**，否则 candidates 会退化成「本页条数」、nextCursor 永远是 null。
ok(
  pagedSum.length === summaryPool && new Set(pagedSum).size === pagedSum.length,
  'summary scope 翻页不重不漏',
  j({ 摘要候选: summaryPool, 实际取回: pagedSum.length, 去重后: new Set(pagedSum).size }),
)
ok(sumPages === 3 && firstSummaryPage.nextCursor === 3, `summary 一路真的翻到了多页（${sumPages} 页，第一页 nextCursor=${firstSummaryPage.nextCursor}）`, j({ 页数: sumPages, 首页next: firstSummaryPage.nextCursor }))
ok(firstSummaryPage.coverage.candidates === summaryPool, 'summary scope 的 candidates 也是真实总数（本页只返 3 条时也报 8）', String(firstSummaryPage.coverage.candidates))
// 回归：candidates 不能随 limit 变 —— 它曾经是内部池的大小（limit=1 → 3、limit=5 → 12）。
const candCounts = [1, 5, 10].map(l => {
  __resetSearchCacheForTest()
  return retrieve({ query: W, files: dozen, scope: 'body', limit: l }).coverage.candidates
})
ok(candCounts.every(c => c === 12), 'coverage.candidates 是真实总数，不随 limit 变', j(candCounts))

console.log('== 11. 缓存：改内容必须立刻跟着变 ==')
const cacheDoc = mem('缓存测试.md', '缓存测试', '# 标题\n\n第一版正文，包含标记丙丁戊己这一个词。')
const cacheSet = [...FILL, cacheDoc]
__resetSearchCacheForTest()
const c1 = chunksOf(cacheSet)
ok(c1.chunks.some(c => c.text.includes('丙丁戊己')), '第一版切出的段落里含标记词')
cacheDoc.content = mem('缓存测试.md', '缓存测试', '# 标题\n\n第二版正文，包含标记庚辛壬癸，而且整个换掉了。').content
const c2 = chunksOf(cacheSet)
ok(c2.chunks.some(c => c.text.includes('庚辛壬癸')) && !c2.chunks.some(c => c.text.includes('丙丁戊己')), '改内容后 chunksOf 立刻跟着变（revision 不同 → 不吃旧缓存）')
ok(c1.chunks.find(c => c.file === '缓存测试.md').revision !== c2.chunks.find(c => c.file === '缓存测试.md').revision, 'revision 也跟着变')
__resetSearchCacheForTest()
ok(chunksOf(cacheSet).chunks.some(c => c.text.includes('庚辛壬癸')), '显式重置缓存后再取，仍是改后的内容')
// 从检索面再验一次：同一个 query，改内容后不该再命中旧词。
const mut = { file: '变更测试.md', description: '变更测试', aliases: [], content: fm('name: 变更测试\ndescription: 变更测试', '# 标题\n\n这一段正文里写着丙丁戊己这个词。') }
const mutSet = [...FILL, mut]
__resetSearchCacheForTest()
ok(retrieve({ query: '丙丁戊己', files: mutSet, scope: 'body' }).hits.length === 1, '改之前能检索到旧标记词')
mut.content = fm('name: 变更测试\ndescription: 变更测试', '# 标题\n\n这一段正文里换成了庚辛壬癸这个词。')
ok(retrieve({ query: '丙丁戊己', files: mutSet, scope: 'body' }).hits.length === 0, '改内容后旧词不再命中（没有吃到缓存）')
ok(retrieve({ query: '庚辛壬癸', files: mutSet, scope: 'body' }).hits.length === 1, '新词立刻能命中')
mut.content = fm('name: 变更测试\ndescription: 变更测试', '# 标题\n\n这一段正文里又换成了辛壬癸甲乙这个词。')
__resetSearchCacheForTest()
ok(retrieve({ query: '辛壬癸甲乙', files: mutSet, scope: 'body' }).hits.length === 1, '重置缓存这条路径同样拿到最新内容')

console.log('== 12. excerptAround：以命中位置为中心 ==')
const longText = '铺垫内容，没有任何关键信息。'.repeat(20) + `关键错误码 ${CODE} 出现在这里。` + '后面的补充说明还有很多很多字。'.repeat(10)
const at = longText.indexOf(CODE)
ok(longText.length > EXCERPT_CHARS * 2, `fixture 成立：文本 ${longText.length} 字符`)
ok(at > EXCERPT_CHARS, `fixture 成立：命中位置在下标 ${at}（远在中后部）`)
const ex = excerptAround(longText, queryTermsOf(CODE), EXCERPT_CHARS)
ok(ex.toLowerCase().includes(CODE.toLowerCase()), '片段里包含命中词（不是永远取开头）')
ok(ex !== longText.slice(0, EXCERPT_CHARS), '确实不等于「开头截 200 字」')
ok(ex.startsWith('…'), '前面被裁掉时以省略号起头', j(ex.slice(0, 8)))
ok(ex.length <= EXCERPT_CHARS + 2, `长度不超过上限 + 两个省略号（实际 ${ex.length}）`)
ok(excerptAround('短文本', ['丙丁'], EXCERPT_CHARS) === '短文本', '短于上限时原样返回')
const miss = excerptAround(longText, ['丙丁戊己'], EXCERPT_CHARS)
ok(miss.length === EXCERPT_CHARS + 1 && miss.endsWith('…'), `一个词都没命中时退回取开头（实际长度 ${miss.length}）`)
// 回归：小写化会改变长度时（`İ` → 两个码元），不能拿小写串的下标去切原串 ——
// 那会给出一个既不含命中词、位置也错位的片段；宁可退回原串查找。
const tricky = `${'a'.repeat(250)}İ尾巴`
ok(excerptAround(tricky, ['i̇'], 100) === tricky.slice(0, 100) + '…', '小写化改变长度时退回原串查找，不给错位片段', j(excerptAround(tricky, ['i̇'], 100).slice(-8)))
ok(excerptAround(tricky, ['i̇'], 400) === tricky, '没超过上限时仍原样返回')

console.log('== 13. retrieve 的健壮性与线上形状 ==')
const emptyCall = retrieve()
ok(emptyCall.ok === true && emptyCall.hits.length === 0 && emptyCall.coverage.searched === 0, 'retrieve() 无参不抛错', j(emptyCall.coverage))
__resetSearchCacheForTest()
ok(retrieve({ query: 'x', files: [] }).ok === true, 'files 为空不抛错')
ok(retrieve({ query: 'x' }).ok === true, 'files 缺失不抛错')
ok(retrieve({ query: '', files: plaza }).hits.length === 0, 'query 为空 → 没有命中')
ok(retrieve({ query: '   ', files: plaza }).hits.length === 0, 'query 全是空白 → 没有命中')
const noFm = [{ file: '无头文件.md', description: '', aliases: [], content: `没有 frontmatter 的纯正文，里面写着 ${W} 的处理记录，内容写得足够长以便独立成段参与匹配。` }]
__resetSearchCacheForTest()
const rNoFm = retrieve({ query: W, files: [...FILL, ...noFm], scope: 'body' })
ok(rNoFm.hits.length === 1 && rNoFm.hits[0].lines[0] === 1, '无 frontmatter 的文件从第 1 行起算', j(rNoFm.hits[0] && rNoFm.hits[0].lines))
const noDesc = [{ file: '无摘要.md', content: `没有 description 字段的文件，正文里写着 ${W} 的处理，内容写得足够长以便独立成段。` }]
__resetSearchCacheForTest()
ok(retrieve({ query: W, files: [...FILL, ...noDesc], scope: 'all' }).ok === true, '缺 description / aliases 字段不抛错')
const noContent = [{ file: '无正文.md', description: `${W}的记录` }]
__resetSearchCacheForTest()
const rNoContent = retrieve({ query: W, files: [...FILL, ...noContent], scope: 'all' })
ok(rNoContent.hits.length === 1 && rNoContent.hits[0].lines === null, '缺 content 字段时按空正文处理', j(filesOf(rNoContent.hits)))
__resetSearchCacheForTest()
const shaped = retrieve({ query: W, files: dozen, scope: 'body', limit: 2 })
const cov = shaped.coverage
ok(
  typeof cov.searched === 'number' && typeof cov.skipped === 'number' && cov.complete === true
  && typeof cov.chunks === 'number' && typeof cov.candidates === 'number' && typeof cov.filteredBelowFloor === 'number',
  'coverage 形状齐全（含 filteredBelowFloor）', j(cov),
)
ok(cov.filteredBelowFloor === 0, '全部过门槛时 filteredBelowFloor 为 0', String(cov.filteredBelowFloor))
// 回归：summary scope 曾经把 coverage.chunks 写死成 0（其实已经切过段了），现在要报真实数。
__resetSearchCacheForTest()
const sumCov = retrieve({ query: W, files: sumSet, scope: 'summary' }).coverage
ok(sumCov.chunks === chunksOf(sumSet).chunks.length && sumCov.chunks > 0, `summary scope 也报真实切段数（实际 ${sumCov.chunks}）`, j(sumCov))
__resetSearchCacheForTest()
const floored = retrieve({ query: Q, files: plaza, scope: 'body' })
ok(floored.coverage.filteredBelowFloor >= longOwn, `不够格的条数与「没有候选」分开报（实际 ${floored.coverage.filteredBelowFloor}）`, j(floored.coverage))
const wire = shaped.hits[0]
const wireKeys = ['id', 'file', 'revision', 'title', 'headingPath', 'lines', 'excerpt', 'score', 'matchedBy', 'evidence', 'evidenceSum', 'evidenceRarest', 'evidenceRarestDf', 'evidenceRun']
ok(wireKeys.every(k => k in wire), `hit 带上全部约定字段 ${j(wireKeys)}`, j(Object.keys(wire)))
ok(typeof wire.evidence === 'number' && typeof wire.evidenceSum === 'number' && typeof wire.evidenceRarest === 'number', '三个证据字段都是数字', j([wire.evidence, wire.evidenceSum, wire.evidenceRarest]))
ok(wire.evidence === 1 && wire.evidenceRarest > 0 && wire.evidenceRarest <= MAX_EVIDENCE_DF_RATIO, `证据字段带的是真实值（ratio ${wire.evidence} / rarest ${wire.evidenceRarest}）`)
ok(wire.evidenceRarestDf === 12, `命中最冷门词元的绝对 df 也在出口上（实际 ${wire.evidenceRarestDf}）`)
ok(wire.evidenceRun >= MIN_MATCHED_RUN, `连续命中个数也在出口上（实际 ${wire.evidenceRun}）`)

console.log('== 14. summaryHits：说清是哪一栏命中 ==')
const hitByDescription = summaryHits(W, scoped)
ok(eq(filesOf(hitByDescription), ['摘要命中.md']), 'description 命中的被选中', j(filesOf(hitByDescription)))
ok(eq(hitByDescription[0].matchedBy, ['description']), '标成 description', j(hitByDescription[0].matchedBy))
ok(hitByDescription[0].revision === revisionOf(scoped[scoped.length - 2].content), 'summaryHits 也带 revision')
const aliasOnly = [mem('别称命中.md', '一条与问题无关的摘要', '# 正文\n\n无关正文。', ['待办清单', 'todo'])]
const hitByAlias = summaryHits('待办', aliasOnly)
ok(hitByAlias.length === 1 && hitByAlias[0].matchedBy.includes('alias'), 'alias 命中的标成 alias', j(hitByAlias[0].matchedBy))
ok(!hitByAlias[0].matchedBy.includes('description'), '只靠 alias 命中的不冒充 description', j(hitByAlias[0].matchedBy))
ok(summaryHits(W, scoped, 1).length === 1, 'limit 参数生效')
ok(summaryHits('', scoped).length === 0 && summaryHits('   ', scoped).length === 0, '空 query → 空数组')
/*
 * 回归（曾经是缺陷）：cross_b 的 description 单独并不含「待办」、alias「办清单」单独也不含；
 * 它被选中是因为 retrieval.js 把 description + aliases 去标点拼成一整串后，在**拼接边界**上
 * 生成了一个跨字段的双字「待办」。三个字段各自都不命中时必须回落成中性标签 `summary`，
 * 不能谎报成 `description`（那会让展示层给出错误的原因）。
 */
const crossBoundary = [
  { file: 'cross_a.md', description: '收尾待', aliases: [], content: fm('name: cross_a\ndescription: 收尾待', '# 正文\n\n无关正文。') },
  { file: 'cross_b.md', description: '收尾待', aliases: ['办清单'], content: fm('name: cross_b\ndescription: 收尾待', '# 正文\n\n无关正文。') },
]
const cross = summaryHits('待办', crossBoundary)
ok(cross.length === 1 && cross[0].file === 'cross_b.md', '（前置）跨字段双字确实让 cross_b 被选中', j(filesOf(cross)))
ok(eq(cross[0].matchedBy, ['summary']), '三个字段单独都不命中时回落成中性标签 summary', j(cross[0].matchedBy))
// 反过来：真的由 description 命中时不许被这次改动带歪。
const trueDesc = [mem('真摘要命中.md', `${W}的记录`, '# 正文\n\n与查询无关的占位正文，写得足够长以便独立成段。')]
ok(eq(summaryHits(W, trueDesc)[0].matchedBy, ['description']), '真 description 命中仍然标 description（没有被回落改动带歪）', j(summaryHits(W, trueDesc)[0].matchedBy))

console.log('== 15. 小语料不被误杀 ==')
// 5 段的小目录：df/N 在那里会失真，所以门槛第三条用了「df ≤ 1 或 df/N ≤ 0.1」的析取。
const small = [
  mem('小一.md', '第 1 条', '# 一\n\n这一条讲的是天气与出行，内容写得足够长，保证它自己就是一段，不和别的段落合并到一起。'),
  mem('小二.md', '第 2 条', '# 二\n\n这一条讲的是做饭与食材，内容同样写得足够长，保证它自己就是一段，不和别的段落合并到一起。'),
  mem('小三.md', '第 3 条', '# 三\n\n这一条讲的是植物养护，内容同样写得足够长，保证它自己就是一段，不和别的段落合并到一起。'),
  mem('小四.md', '第 4 条', '# 四\n\n这一条讲的是旅行记录，内容同样写得足够长，保证它自己就是一段，不和别的段落合并到一起。'),
  mem('小五.md', '第 5 条', `# 五\n\n这一条讲的是 ${W} 的处理，内容同样写得足够长，保证它自己就是一段，不和别的段落合并到一起。`),
]
__resetSearchCacheForTest()
const rSmall = retrieve({ query: W, files: small, scope: 'body' })
ok(eq(filesOf(rSmall.hits), ['小五.md']), '5 段的目录里真命中没有被误杀（df/N 失真的那条修好了）', j({ hits: filesOf(rSmall.hits), filtered: rSmall.coverage.filteredBelowFloor }))
// 24 段的目录（比阈值扫参用的 16 份更接近真实规模）同样要留住真命中。
const medium = [...small, ...Array.from({ length: 19 }, (_, i) => mem(
  `中${i}.md`, `第 ${i} 条`,
  `# 中${i}\n\n这一条讲的是别的事情，内容写得足够长，保证它自己就是一段，不和别的段落合并到一起。`,
))]
__resetSearchCacheForTest()
ok(filesOf(retrieve({ query: W, files: medium, scope: 'body' }).hits).includes('小五.md'), '24 段的目录里真命中同样留得住')
/*
 * 回归（曾经是缺陷）：`sum ≥ 1.5` 用的是 idf，而 idf 随语料规模对数增长 —— 也就是说
 * **它本身也是语料规模相关量**。修法是给 `sum` 加逃生口：命中的是「全库独一份」（df ≤ 1）
 * 且连成片段（run 达标）时不再看绝对量。单段语料里原样命中的错误码必须过闸。
 */
const soloDoc = mem('孤本.md', '写文件', `# 记录\n\n正文里写着 ${CODE} 这个错误码，说明版本已经过期需要重新读取，必须先重读再改写才行。`)
__resetSearchCacheForTest()
const soloInfo = chunksOf([soloDoc])
const soloEv = evidence(queryTermsOf(CODE), soloInfo.chunks[0].tf, soloInfo.stats)
const rSolo = retrieve({ query: CODE, files: [soloDoc], scope: 'body' })
ok(
  rSolo.hits.length === 1,
  '单段语料里原样命中的错误码过了闸（sum 的逃生口生效）',
  j({
    hits: rSolo.hits.length,
    filtered: rSolo.coverage.filteredBelowFloor,
    ratio: soloEv.ratio,
    sum: Number(soloEv.sum.toFixed(3)),
    rarestDf: soloEv.rarestDf,
    run: maxMatchedRun(tokenize(CODE), soloInfo.chunks[0].tf),
    门槛: { ratio: MIN_EVIDENCE_RATIO, sum: MIN_EVIDENCE_SUM, minRun: MIN_MATCHED_RUN },
  }),
)
// 逃生口不能顺手把整个门槛放开：同一份语料上「没有连续命中」的弱查询仍要被拒。
__resetSearchCacheForTest()
const rWeak = retrieve({ query: '版本号是多少', files: [soloDoc], scope: 'body' })
ok(rWeak.hits.length === 0 && rWeak.coverage.filteredBelowFloor === 1, '逃生口只对「全库独一份 + 连成片段」开；弱查询照样被拒', j({ hits: rWeak.hits.length, filtered: rWeak.coverage.filteredBelowFloor }))

console.log('== 16. 门槛要治的那类漏网（跨词假词元 + 虚词）==')
// 真实漏网构造：「明天会不会下雨」打中潮汐笔记，靠的是跨词边界假词元「天会」（df=1，IDF 最大）
// 与虚词「不会」。两条判据都不该让它进来 —— 连续性（run=1）是拦住它的那一条。
const weather = '明天会不会下雨'
const tideDoc = mem('潮汐笔记.md', '潮汐与月相记录', '# 潮汐\n\n大潮那一天会缩短几个小时的高潮间隙，但这一段简单的记录不会影响任何结论。')
const tideSet = [...FILL, tideDoc]
__resetSearchCacheForTest()
const tideChunk = chunksOf(tideSet).chunks.find(c => c.file === '潮汐笔记.md')
ok(maxMatchedRun(tokenize(weather), tideChunk.tf) === 1, '这段无关文字对天气问题的最长连续命中就是 1', String(maxMatchedRun(tokenize(weather), tideChunk.tf)))
ok(Boolean(tideChunk.tf.get('天会')) && Boolean(tideChunk.tf.get('不会')), '（前置）假词元「天会」与虚词「不会」都真的命中了')
const tideNoGate = rankChunksInternal(weather, tideSet, { minEvidence: false })
ok(filesOf(tideNoGate.hits).includes('潮汐笔记.md'), '（前置）无门槛时它确实有非零分 —— BM25 拦不住这种漏网')
const tideGated = rankChunksInternal(weather, tideSet)
ok(!filesOf(tideGated.hits).includes('潮汐笔记.md'), '默认门槛拒掉这条无关命中')
ok(tideGated.filtered >= 1, '拒掉的方式是计入 filtered，而不是「没有候选」', String(tideGated.filtered))
const tideLoose = rankChunksInternal(weather, tideSet, { minEvidence: { minRun: 1 } })
ok(filesOf(tideLoose.hits).includes('潮汐笔记.md'), '把 minRun 放宽到 1 就又能进来 —— 拒它的正是连续性这条判据', j(filesOf(tideLoose.hits)))
// 已知代价，有意为之：孤立的两字专名单独命中时 run=1，过不了默认门槛（要用 minRun 放宽）。
ok(rankChunks('限温', spread).length === 0, '默认门槛拒掉孤立的两字命中（run=1）—— 有意的严格')
ok(rankChunksInternal('限温', spread, { minEvidence: { minRun: 1 } }).hits.length > 0, '把 minRun 放宽到 1 → 同一批命中又能过闸')

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
