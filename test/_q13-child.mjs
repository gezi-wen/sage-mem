#!/usr/bin/env node
/**
 * _q13-child.mjs — review-211-q13-test 的子进程工作单元（`_` 开头 = 共享辅助，不登记为套件）
 *
 * 为什么必须是独立文件而不是父测试里的内联字符串：这份实况要在**模块加载时**读
 * `SAGE_MEM_MAX_RESULTS`（`config.js` 的常量），同一进程改不了 —— 父测试按每个配置
 * 起一个干净子进程来跑它。内联 `-e` 里的相对 import 解析不到仓库路径，所以落成文件。
 *
 * 输出一行 `@@{...}` 的精确实况给父测试判断。
 */
import { MAX_RESULTS } from '../lib/memory/config.js'
import { retrieve } from '../lib/memory/search.js'
import * as retrieval from '../lib/memory/retrieval.js'

const { selectRelevant } = retrieval
/**
 * 2.1.16 新增的「不带注入名额的摘要排序」。旧代码里没有它 → 回落到注入侧的
 * `selectRelevant`，这样修前跑出来的是**被截断的候选集**这类实质证据，
 * 而不是一个 import 就直接炸掉。
 */
const rankSummaries = retrieval.rankSummaries ?? ((query, files) => selectRelevant(query, files))

/** 合成语料：7 份摘要全部命中同一 query（小于 8 份 → 证据门槛不介入）。 */
const files = Array.from({ length: 7 }, (_, i) => ({
  file: `project_${i}.md`,
  content: `---\nname: item${i}\ndescription: quartz nebula\ntype: project\n---\n`,
  description: 'quartz nebula',
  aliases: [],
}))
const query = 'quartz nebula'

const oneShot = retrieve({ query, scope: 'summary', limit: 10, files })
const pages = []
const seen = []
let cursor = 0
for (let i = 0; i < 20; i++) {
  const page = retrieve({ query, scope: 'summary', limit: 3, cursor, files })
  pages.push(page.hits.length)
  seen.push(...page.hits.map((h) => h.file))
  if (page.nextCursor === null) break
  cursor = page.nextCursor
}

console.log('@@' + JSON.stringify({
  maxResults: MAX_RESULTS,
  candidates: oneShot.coverage.candidates,
  firstHits: oneShot.hits.length,
  firstNext: oneShot.nextCursor,
  complete: oneShot.coverage.complete,
  oneShotFiles: oneShot.hits.map((h) => h.file),
  pages,
  seen,
  rankCount: rankSummaries(query, files).length,
  injectCount: selectRelevant(query, files, { gate: false }).length,
}))
