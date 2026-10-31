#!/usr/bin/env node
/**
 * review-211-q13-test.mjs — 外部审查 Q13 的回归（2.1.16）
 *
 * 问题：主动摘要检索被自动注入名额截断，翻页也取不全。
 *   `SAGE_MEM_MAX_RESULTS=3`、库中 7 份摘要全命中时，`scope=summary, limit=10`
 *   只返回 3 条、`nextCursor=null`、`complete=true` —— 丢掉的候选翻页也取不回。
 *   根因：摘要排序函数（为自动注入设计）自己先 `slice(0, MAX_RESULTS)`，
 *   工具的 limit/cursor 作用在**已截断的集合**上。
 *
 * 判据（不许只看 ok / 条数）：
 *   1. MAX_RESULTS=1 / 3 / 10 下，主动检索**完整翻页的集合与顺序完全一致**，且等于
 *      「一页取 10 条」的顺序 —— 每页不重复、不漏候选；
 *   2. **反向对照**：同一个进程里，自动注入的选择函数仍只取自己的配置条数
 *      （修好的是「排序与名额解耦」，不是把注入上限一起放开）。
 *
 * 为什么子进程：`MAX_RESULTS` 是模块加载时读的环境变量常量。同一进程里改不了，
 * 所以每个配置起一个干净子进程（与 env-contract-test 同一手法）。
 *
 * 用法: node test/review-211-q13-test.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** 子进程工作单元（在同一次运行里按不同的 MAX_RESULTS 反复起）。 */
const CHILD = join(HERE, '_q13-child.mjs')

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
const group = (t) => console.log(`== ${t} ==`)
const j = (v) => JSON.stringify(v)

const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-q13-'))

/** 起一个干净子进程，把 MAX_RESULTS 钉到 `value`，取回上面那份实况。 */
function runChild(value) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('SAGE_MEM_')) delete env[k]
  Object.assign(env, {
    SAGE_MEM_MAX_RESULTS: String(value),
    SAGE_MEM_DIR: join(sandbox, 'memory'),
    SAGE_MEM_STATE_DIR: join(sandbox, '.sage-mem'),
  })
  const r = spawnSync(process.execPath, [CHILD], { encoding: 'utf8', env })
  const out = `${r.stdout ?? ''}`
  const line = out.split('\n').find((l) => l.startsWith('@@'))
  if (!line) throw new Error(`子进程没打出实况（exit ${r.status}）：${(r.stderr || out || '(空)').slice(0, 800)}`)
  return JSON.parse(line.slice(2))
}

const results = new Map()
for (const v of [1, 3, 10]) {
  let r = null
  try {
    r = runChild(v)
  } catch (err) {
    ok(false, `MAX_RESULTS=${v} 的子进程能跑出实况`, err.message)
  }
  if (r) results.set(v, r)
}

group('0. 前置：注入名额确实被钉到了子进程里')
for (const [v, r] of results) {
  ok(r.maxResults === v, `SAGE_MEM_MAX_RESULTS=${v} 生效（子进程读到 ${r.maxResults}）`)
}

group('1. 每个注入名额下，主动检索都能取全候选并翻页')
for (const [v, r] of results) {
  ok(r.candidates === 7,
    `MAX_RESULTS=${v}：候选总数是完整合格集 7（实际 ${r.candidates}；旧版被截成 ${v}）`, j(r))
  ok(r.firstHits === 7 && r.firstNext === null,
    `MAX_RESULTS=${v}：limit=10 一页取全 7 条且没有下一页（实际 ${r.firstHits} 条 / next=${r.firstNext}）`)
  ok(j(r.pages) === '[3,3,1]', `MAX_RESULTS=${v}：limit=3 翻页是 3/3/1（实际 ${j(r.pages)}）`)
  ok(r.seen.length === 7 && new Set(r.seen).size === 7,
    `MAX_RESULTS=${v}：翻页不重复、不漏候选（取回 ${r.seen.length} 条，去重 ${new Set(r.seen).size}）`, j(r.seen))
  ok(r.complete === true, `MAX_RESULTS=${v}：coverage.complete 仍为 true（扫描完整）`)
}

group('2. MAX_RESULTS=1 / 3 / 10 的主动检索结果完全一致')
{
  const lists = [...results.values()]
  ok(lists.length === 3, '三种配置都跑出了实况')
  if (lists.length === 3) {
    ok(lists.every((r) => j(r.seen) === j(lists[0].seen)),
      '完整翻页的集合与顺序完全一致（不随自动注入名额变）',
      lists.map((r) => j(r.seen)).join('\n       '))
    ok(lists.every((r) => j(r.pages) === j(lists[0].pages)),
      '页数与每页条数完全一致', lists.map((r) => j(r.pages)).join(' / '))
    ok(lists.every((r) => j(r.oneShotFiles) === j(lists[0].oneShotFiles)),
      '「一页取 10 条」的顺序也一致（翻页与一次取全没有错位）')
    ok(lists.every((r) => j(r.seen) === j(r.oneShotFiles)),
      '翻页拼起来的结果与一次取全的顺序逐项相同',
      lists.map((r) => `${j(r.seen)} vs ${j(r.oneShotFiles)}`).join('\n       '))
  }
}

group('3. 反向对照：自动注入仍守自己的名额（没有把上限一起放开）')
for (const [v, r] of results) {
  // 候选只有 7 条，名额 10 时注入侧自然只取得到 7 —— 上限是「最多几条」，不是「必须几条」。
  const expect = Math.min(v, 7)
  ok(r.injectCount === expect,
    `MAX_RESULTS=${v}：注入侧选择函数只返回 ${expect} 条（实际 ${r.injectCount}）`)
}
{
  const r = results.get(3)
  if (r) {
    ok(r.rankCount === 7,
      '摘要排序函数本身不施加名额（完整 7 条）—— 名额由注入侧在消费端切',
      `rankSummaries=${r.rankCount}`)
    ok(r.injectCount < r.rankCount,
      '同一份语料：注入侧被名额收窄、主动检索不收窄（两个面确实分开了）',
      `inject=${r.injectCount} / rank=${r.rankCount}`)
  }
}

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
