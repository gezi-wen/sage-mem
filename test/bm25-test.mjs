/**
 * BM25 词元化与打分断言（lib/memory/bm25.js）。
 *
 * 为什么重点是「退化」而不是 happy path：这一层要拦住的是**长文霸榜**。
 * 词频不饱和 → 一个词出现 300 次就能压过真正相关的那篇；长度不归一 → 长文件自带优势；
 * IDF 取负 → 到处都有的词反而加分。三条都只在极端输入下才暴露，所以断言也照着极端造。
 * 纯函数、零 I/O，全部 fixture 为合成文本。
 */
import {
  tokenize,
  termFreq,
  buildStats,
  scoreDoc,
  coverageOf,
  queryTermsOf,
  idfOf,
  evidence,
  maxMatchedRun,
  BM25_K1,
  BM25_B,
  COVERAGE_WEIGHT,
} from '../lib/memory/bm25.js'

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

console.log('== 1. 常量 ==')
ok(BM25_K1 === 1.2, `词频饱和系数 1.2（实际 ${BM25_K1}）`)
ok(BM25_B === 0.75, `长度归一系数 0.75（实际 ${BM25_B}）`)
ok(COVERAGE_WEIGHT === 0.2, `覆盖率权重 0.2（实际 ${COVERAGE_WEIGHT}）`)

console.log('== 2. tokenize：中文双字 ==')
ok(eq(tokenize('部署超时'), ['部署', '署超', '超时']), '「部署超时」切出 部署 / 署超 / 超时', j(tokenize('部署超时')))
// 「署超」是跨词边界的假词元：它几乎不会在文档里命中，这正是额外给覆盖率小项的原因。
ok(tokenize('部署超时').includes('署超'), '假词元也在（它的贡献靠 IDF 自然趋零，不靠特殊处理）')
ok(eq(tokenize('系统'), ['系统']), '恰好两个汉字 → 一个词元', j(tokenize('系统')))
ok(eq(tokenize('中'), ['中']), '单个汉字退化成那一个字本身', j(tokenize('中')))

console.log('== 3. tokenize：中文按段切、不跨标点 ==')
const split = tokenize('甲。乙')
ok(eq(split, ['甲', '乙']), '「甲。乙」切成两个字，不产生跨句词元', j(split))
ok(!split.some(t => t.includes('。')), '没有词元含标点')
ok(!split.includes('甲乙'), '没有跨过句号的假词元「甲乙」')
ok(eq(tokenize('甲，乙；丙'), ['甲', '乙', '丙']), '逗号分号同样切断连续段', j(tokenize('甲，乙；丙')))
ok(eq(tokenize('甲 乙'), ['甲', '乙']), '空格分开的单字各自成词元')

console.log('== 4. tokenize：ASCII 标识符 ==')
const ident = tokenize('lib/index.js')
ok(ident.includes('lib/index.js'), '保留原形，错误码 / 路径 / 版本号才能精确匹配', j(ident))
ok(ident.includes('lib') && ident.includes('index') && ident.includes('js'), '同时按分隔符切出长度 ≥ 2 的片段')
ok(eq(ident, ['lib/index.js', 'lib', 'index', 'js']), '顺序与内容都固定', j(ident))
ok(eq(tokenize('FS_STALE_VERSION'), ['fs_stale_version', 'fs', 'stale', 'version']), '下划线分隔的常量同样处理', j(tokenize('FS_STALE_VERSION')))

console.log('== 5. tokenize：长度 1 的片段是噪音 ==')
const ver = tokenize('1.0.0')
ok(eq(ver, ['1.0.0']), '「1.0.0」只留原形，切出的三个 0 被丢掉', j(ver))
ok(!ver.some(t => t.length === 1), '没有长度 1 的词元', j(ver))
// 取舍说明：过滤只作用于「拆分出来的片段」，长度 1 的整串仍然保留（它是精确匹配原形）。
ok(eq(tokenize('a b c'), ['a', 'b', 'c']), '单字符整串仍保留（过滤不作用于原形）', j(tokenize('a b c')))

console.log('== 6. tokenize：大小写归一与空输入 ==')
ok(eq(tokenize('Hello WORLD'), tokenize('hello world')), '大小写不影响词元序列')
ok(eq(tokenize('Hello WORLD'), ['hello', 'world']), '输出一律小写', j(tokenize('Hello WORLD')))
ok(tokenize('Hello 部署 ABC').every(t => t === t.toLowerCase()), '混合文本里也没有大写残留', j(tokenize('Hello 部署 ABC')))
ok(eq(tokenize(''), []) && eq(tokenize('   '), []) && eq(tokenize(null), []) && eq(tokenize(undefined), []), '空 / 空白 / null / undefined 都返回空数组')
ok(eq(queryTermsOf('部署超时 部署'), ['部署', '署超', '超时']), 'queryTermsOf 去重且保持原序', j(queryTermsOf('部署超时 部署')))
ok(eq(queryTermsOf(''), []), '空 query 的词元表是空数组')

console.log('== 7. termFreq ==')
const tf = termFreq(tokenize('系统 系统 部署'))
ok(tf.get('系统') === 2, `词频保留重复（系统 2 次，实际 ${tf.get('系统')}）`)
ok(tf.get('部署') === 1, '出现一次记 1')
ok(tf.get('不存在') === undefined, '没出现过的词元取不到')
ok(termFreq([]).size === 0, '空数组 → 空表')

console.log('== 8. buildStats：df 是「多少篇文档含该词元」 ==')
const corpus = [
  { tokens: ['zz', 'yy', 'zz'] }, // 同一篇里 zz 出现两次
  { tokens: ['zz', 'xx'] },
  { tokens: ['yy', 'yy'] },
]
const stats = buildStats(corpus)
ok(stats.N === 3, `N = 文档数 3（实际 ${stats.N}）`)
ok(stats.df.get('zz') === 2, `同一文档里重复只算一次（zz 在 2 篇里出现，实际 ${stats.df.get('zz')}）`)
ok(stats.df.get('yy') === 2, 'yy 出现在 2 篇里')
ok(stats.df.get('xx') === 1, 'xx 只出现在 1 篇里')
ok(Math.abs(stats.avgdl - 7 / 3) < 1e-9, `avgdl 是词元数的平均（实际 ${stats.avgdl}）`)
const empty = buildStats([])
ok(empty.N === 0 && empty.avgdl === 1 && empty.df.size === 0, '空语料：N=0、avgdl=1、df 为空表')

console.log('== 9. scoreDoc：词频饱和 ==')
const one = { N: 10, avgdl: 100, df: new Map([['部署', 2]]) }
const tfLow = new Map([['部署', 1]])
const tfHigh = new Map([['部署', 20]])
const sLow = scoreDoc(['部署'], tfLow, 100, one)
const sHigh = scoreDoc(['部署'], tfHigh, 100, one)
ok(sLow > 0 && sHigh > sLow, `出现 20 次确实比 1 次得分高（${sLow.toFixed(4)} → ${sHigh.toFixed(4)}）`)
ok(sHigh < sLow * 3, `但远不到 20 倍：饱和把差距压到 3 倍以内（实际 ${(sHigh / sLow).toFixed(2)} 倍）`)
ok(sHigh < sLow * (BM25_K1 + 1) + 1e-9, `上界贴着 k1+1 = ${BM25_K1 + 1}（实际 ${(sHigh / sLow).toFixed(3)}）`)

console.log('== 10. scoreDoc：长度归一 ==')
const sShort = scoreDoc(['部署'], tfLow, 50, one)
const sLong = scoreDoc(['部署'], tfLow, 500, one)
ok(sShort > sLong, `同样命中 1 次，长文档得分更低（短 ${sShort.toFixed(4)} > 长 ${sLong.toFixed(4)}）`)
ok(sShort > 0 && sLong > 0, '两边都是正分')
const sEqual = scoreDoc(['部署'], tfLow, 100, one)
ok(Math.abs(sLong - scoreDoc(['部署'], tfLow, 1000, one)) < sEqual, '再拉长也没有变成 0 或负数')

console.log('== 11. scoreDoc：IDF 行为 ==')
// df = N：语料里每篇都有的词元，IDF 应趋近 0，绝不能为负（负分会让「到处都有的词」变成惩罚项的反面）。
const common = { N: 5, avgdl: 10, df: new Map([['通用', 5]]) }
const sCommon = scoreDoc(['通用'], new Map([['通用', 1]]), 10, common)
ok(sCommon > 0, `df = N 时贡献仍是正的（实际 ${sCommon.toFixed(6)}）`)
ok(sCommon < 0.2, `且趋近 0（实际 ${sCommon.toFixed(6)}）`)
const rareStats = { N: 100, avgdl: 100, df: new Map([['罕见', 1]]) }
ok(scoreDoc(['罕见'], new Map([['罕见', 1]]), 100, rareStats) > sCommon * 3, '稀有词元的 IDF 显著更大')
ok(scoreDoc(['部署'], new Map([['部署', 1]]), 100, { ...one, df: new Map() }) > 0, 'df 表里查不到（df=0）也不炸、不给负分')
ok(scoreDoc(['部署'], tfLow, 100, { N: 0, avgdl: 1, df: new Map() }) === 0, 'N = 0 直接返回 0')
ok(scoreDoc(['部署'], tfLow, 100, null) === 0, 'stats 为空直接返回 0')
ok(scoreDoc(['不存在的词'], tfLow, 100, one) === 0, 'query 词元没出现在文档里 → 0 分')
ok(scoreDoc([], tfLow, 100, one) === 0, '空 queryTerms → 0 分')

console.log('== 12. coverageOf ==')
ok(coverageOf(['a', 'b'], new Map([['a', 1]])) === 0.5, '命中一半 → 0.5')
ok(coverageOf(['a'], new Map([['a', 1]])) === 1, '全部命中 → 1')
ok(coverageOf(['a'], new Map()) === 0, '一个都没命中 → 0')
ok(coverageOf([], new Map()) === 0, '空 queryTerms → 0（不除零）')
ok(coverageOf(['a'], new Map([['a', 0]])) === 1, '分母是 queryTerms、分子看「在不在表里」，不看词频')

console.log('== 13. idfOf（与 scoreDoc 同一口径）==')
// f=1 且 dl=avgdl 时 BM25 的分式恰好等于 1（1+k1 上下抵消），所以这时 scoreDoc 就是 idf 本身。
ok(scoreDoc(['甲'], new Map([['甲', 1]]), 100, { N: 10, avgdl: 100, df: new Map([['甲', 3]]) }) === idfOf(3, 10), 'scoreDoc 用的就是 idfOf 这一个口径（不存在两份实现）')
ok(idfOf(1, 100) > idfOf(50, 100), `越冷门 idf 越大（${idfOf(1, 100).toFixed(3)} > ${idfOf(50, 100).toFixed(3)}）`)
ok(idfOf(100, 100) > 0 && idfOf(100, 100) < 0.05, `df = N 时 idf 为正且趋近 0（实际 ${idfOf(100, 100).toFixed(5)}）`)
ok(idfOf(0, 0) === 0 && idfOf(1, 0) === 0, 'N = 0 时返回 0（不除零、不产生 NaN）')

console.log('== 14. evidence：门槛用的证据强度 ==')
const evStats = { N: 100, avgdl: 10, df: new Map([['甲', 5], ['乙', 100]]) }
const evZero = evidence(['甲', '语料里没有的词'], new Map([['甲', 1]]), evStats)
ok(evZero.matched === 1, 'df = 0 的词元不计入 matched')
ok(evZero.ratio === 1, '⚠️ 分母剔除 df=0 的词元 —— 否则错别字会带着最大 IDF 把真命中压到地板分', j(evZero.ratio))
ok(evZero.rarestDf === 5 && evZero.rarestDfRatio === 0.05, 'rarestDf 取命中词元里最小的文档频率', j([evZero.rarestDf, evZero.rarestDfRatio]))
const evMiss = evidence(['不存在'], new Map(), evStats)
ok(evMiss.matched === 0 && evMiss.ratio === 0 && evMiss.sum === 0, '一个都没命中时 ratio / sum 都是 0')
ok(evMiss.rarestDf === Number.POSITIVE_INFINITY && evMiss.rarestDfRatio === 1, '没命中时 rarestDf 是 +∞、rarestDfRatio 是 1（都不能被读成「够冷门」）', j([evMiss.rarestDf, evMiss.rarestDfRatio]))
ok(evMiss.matched !== undefined && evidence([], new Map(), evStats).ratio === 0, '空 queryTerms 也不除零')

console.log('== 15. maxMatchedRun：最长连续命中 ==')
const tfRun = new Map([['甲', 1], ['乙', 1], ['丙', 1]])
ok(maxMatchedRun(['甲', '乙', '丙'], tfRun) === 3, '三个词元全部连续命中 → 3')
ok(maxMatchedRun(['甲', '乙', '丁'], tfRun) === 2, '在断点处结束 → 2')
ok(maxMatchedRun(['甲', '丁', '乙'], tfRun) === 1, '中间断开时最长连续只有 1（不跨断点累加）')
ok(maxMatchedRun(['甲', '丁', '乙', '丙'], tfRun) === 2, '取最长的那一段（末尾两连）')
ok(maxMatchedRun(['丁', '戊'], tfRun) === 0, '一个都没命中 → 0')
ok(maxMatchedRun([], tfRun) === 0, '空 queryTokens → 0')
/*
 * ⚠️ 要知道的边界：这个函数只吃**扁平的词元序列**，不认标点、也不认段边界。
 * `tokenize('甲。乙')` 给出 `['甲','乙']`，两个都在 tf 里就记成 2 连 —— 哪怕它们在原文里
 * 隔着句号。真正防的是「同一个 CJK 连续段里的跨词假词元」，那段场景不受影响。
 */
ok(maxMatchedRun(tokenize('甲。乙'), new Map([['甲', 1], ['乙', 1]])) === 2, '跨标点的两个词元在函数看来仍算连续（它只看序列）')

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
