#!/usr/bin/env node
/**
 * 注入链的**直接单测**（1.2.0 新增）。
 *
 * 为什么它是「结构变好」的证据：这 15 条断言里**没有一条**需要 `new MemoryGateway(ctx)`。
 * 1.2.0 之前，这些分支（并集排序、签名去重、预算分账、卡去重、代次归零）只能靠
 * `inject-test` 或 `recall-golden` 造一个假宿主间接碰到 —— 测不到就等于没断言。
 *
 * 环境变量必须在动态 import 之前设好（config.js 在模块顶层读它们）。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const sandbox = join(tmpdir(), 'sage-mem-recall-unit-' + process.pid)
const memDir = join(sandbox, 'memory')
mkdirSync(memDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')
process.env.SAGE_MEM_MAX_SESSION_BYTES = '5120' // 正文池 4096
delete process.env.SAGE_MEM_DEBUG
delete process.env.SAGE_MEM_TASK_ID

const R = new URL('../lib/recall/', import.meta.url)
const { createSessionInjectState } = await import(new URL('state.js', R).href)
const { dedupeByFile, selectRecall } = await import(new URL('select.js', R).href)
const { buildCandidates, composeDelivery, composeStatus } = await import(new URL('compose.js', R).href)
const { composeRecallText } = await import(new URL('text.js', R).href)

const file = (name, { description = '', content = '', baseline = false } = {}) => ({
  file: name, description, content, baseline, type: 'project', tags: [], updated: '', score: 0,
})
const LONG = '甲'.repeat(1200)

// ── 1. state：代次变化四样一起归零 ──────────────────────────────
group('1. state：begin/commit 与压缩代次')
{
  const st = createSessionInjectState()
  const a = st.begin('s1', 5)
  ok(a.signature === null && a.contentBytes === 0 && a.baselineDone === false,
    '新会话 begin 返回空白状态（签名 / 字节 / baseline 标记）')
  ok(a.generationChanged === false, '第一次 begin 不算代次变化')
  st.commit('s1', { signature: 'sig', contentBytes: 100, cardBytes: 50, cardSig: 'card', gapCard: 'gap', messageCount: 5, baselineDone: true })
  const b = st.begin('s1', 5)
  ok(b.signature === 'sig' && b.contentBytes === 100 && b.baselineDone === true, 'commit 之后 begin 读得到同一个状态')
  const c = st.begin('s1', 2) // 条数下降 = 压缩
  ok(c.generationChanged === true, '消息条数下降 → generationChanged')
  ok(c.signature === null && c.contentBytes === 0 && c.cardBytes === 0 && c.cardSig === '' && c.baselineDone === false,
    '压缩后签名 / 正文账 / 卡账 / baseline 标记一起归零（复审 R03）')
  const fifo = createSessionInjectState(2)
  fifo.commit('a', { signature: 'a' }); fifo.commit('b', { signature: 'b' }); fifo.commit('c', { signature: 'c' })
  ok(fifo.begin('a', 1).signature === null, '超过上限时按 FIFO 淘汰最老的会话（不无限增长）')
}

// ── 2. select：baseline / 取交集 / 签名 ─────────────────────────
group('2. select：baseline 只来一次、摘要与正文并集、签名去重')
{
  const base = file('user_base.md', { description: '身份锚点', content: '---\nname: user_base\n---\n\n我是甲。', baseline: true })
  const alpha = file('project_alpha.md', { description: '阿尔法项目进度', content: '---\nname: alpha\n---\n\n进度表。' })
  const beta = file('reference_beta.md', { description: '贝塔资料', content: '---\nname: beta\n---\n\n正文提到伽马射线。' })
  const files = [base, alpha, beta]

  const s1 = selectRecall({ text: '阿尔法和伽马射线', files, st: { signature: null, baselineDone: false } })
  ok(s1.picked[0].file === 'user_base.md' && s1.baselineTaken === 1, 'baseline 排在候选第一位，且只计一次')
  ok(s1.selected.map((f) => f.file).join(',') === 'project_alpha.md,reference_beta.md',
    '摘要命中在前、正文独有在后（并集排序）', s1.selected.map((f) => f.file).join(','))
  ok(s1.picked.length === 3, 'picked 里 baseline + 两条检索结果，没有重复文件')
  const s2 = selectRecall({ text: '阿尔法和伽马射线', files, st: { signature: s1.signature, baselineDone: true } })
  ok(s2.baselineTaken === 0 && s2.picked.length === 0, 'baseline 已给过 + 签名相同 → 这一步一个都不追加')
  ok(s2.deduped === true, '签名相同 → deduped')
  const s3 = selectRecall({ text: '丙', files, st: { signature: null, baselineDone: true } })
  ok(s3.bodyRanked.length === 0, '问题短于 4 个字符不做正文检索')
}

// ── 3. select：意图放宽正文门槛 ────────────────────────────────
group('3. select：问历史时把正文门槛从 minRun 2 放宽到 1')
{
  const zeta = file('reference_zeta.md', { description: '无关描述', content: '---\nname: zeta\n---\n\n泽塔的来历写在这里。' })
  const relaxed = selectRecall({ text: '上次说的泽塔是什么', files: [zeta], st: { signature: null, baselineDone: true } })
  const strict = selectRecall({ text: '泽塔是什么', files: [zeta], st: { signature: null, baselineDone: true } })
  ok(relaxed.intentInfo.historyDependent === true, '「上次」被判成问历史')
  ok(strict.intentInfo.historyDependent === false, '普通问句不被误判成问历史')
  ok(relaxed.bodyRanked.length >= strict.bodyRanked.length, '放宽之后正文档位不少于严格档', `${relaxed.bodyRanked.length} vs ${strict.bodyRanked.length}`)
  ok(dedupeByFile([{ file: 'a.md', chunk: 1 }, { file: 'a.md', chunk: 2 }]).length === 1, 'dedupeByFile 同一文件只留第一条')
}

// ── 4. compose：渲染 ───────────────────────────────────────────
group('4. compose.buildCandidates：段落优先 / baseline 不吃替换 / 截断')
{
  const chunk = { id: 'c1', text: '段落正文', startLine: 7, endLine: 9, revision: 'r1', title: '小标题' }
  const cands = buildCandidates({
    picked: [
      file('project_a.md', { description: '甲项目', content: 'A'.repeat(2000) }),
      file('user_base.md', { description: '人设', content: '完整正文', baseline: true }),
      file('project_long.md', { description: '超长', content: 'B'.repeat(2000) }),
    ],
    bestChunk: new Map([['project_a.md', chunk], ['user_base.md', chunk]]),
    nowMs: Date.now(),
  })
  ok(cands[0].text.includes('### project_a.md:7-9') && cands[0].text.includes('段落正文'),
    '非 baseline 用命中段落，标题带行号')
  ok(cands[0].lines[0] === 7 && cands[0].id === 'c1', 'lines 与 id 来自段落')
  ok(cands[1].text.includes('完整正文') && !cands[1].text.includes('段落正文'),
    'baseline 不吃段落替换（完整在场）')
  ok(cands[2].text.includes('…（截断）'), '超长正文按 MAX_CHARS 截断并留标记')
}

// ── 5. compose：两本账 ─────────────────────────────────────────
group('5. compose：正文预算与卡池互不借用')
{
  const text = '长文甲'
  const candidates = [
    { file: 'a.md', id: 'a', revision: '', score: 1, baseline: false, lines: null, title: '', text: `### a.md\n${LONG}` },
    { file: 'b.md', id: 'b', revision: '', score: 1, baseline: false, lines: null, title: '', text: `### b.md\n${LONG}` },
  ]
  const d = composeDelivery({ candidates, text, intent: 'none', contentBytes: 0, nowMs: Date.now() })
  ok(d.parts.length === 1 && d.skippedForBudget === 1, '正文池只装得下一条，另一条被预算省略', `${d.parts.length}/${d.skippedForBudget}`)
  ok(d.contentBytes > 3000 && d.contentBytes <= 4096, '记账按实际进正文的字节数（不含指针额度）', String(d.contentBytes))
  const st = { cardBytes: 0, cardSig: '', gapCard: '' }
  const gap = composeStatus({
    files: [file('a.md'), file('b.md')], selected: [file('a.md'), file('b.md')],
    bodyRanked: [{ file: 'b.md', chunk: {} }], bodySearched: true, text, parts: d.parts,
    injectedFiles: ['a.md'], skippedForBudget: 1, deduped: false, st, toolsReady: false,
    checkpointLine: '', memoryDir: '/tmp/mem', intentHistoryDependent: false,
  })
  ok(gap.cardPart.length > 0 && gap.cardPart.includes('直接打开记忆目录'),
    '正文池满但卡池还有额度 → 发卡，且无工具时给「直接打开记忆目录」的降级说法')
  const again = composeStatus({
    files: [file('a.md'), file('b.md')], selected: [file('a.md'), file('b.md')], bodyRanked: [{ file: 'b.md', chunk: {} }],
    bodySearched: true, text, parts: d.parts, injectedFiles: ['a.md'], skippedForBudget: 1, deduped: true,
    st: { cardBytes: gap.cardBytes, cardSig: gap.cardSig, gapCard: gap.cardBody },
    toolsReady: true, checkpointLine: '', memoryDir: '/tmp/mem', intentHistoryDependent: false,
  })
  ok(again.cardPart === '' && again.cardBody === gap.cardBody,
    '同一张卡（内容签名没变）不重复发，且沿用上一步渲染好的正文')
  const noGap = composeStatus({
    files: [file('a.md')], selected: [], bodyRanked: [], bodySearched: false, text: '', parts: ['x'],
    injectedFiles: ['a.md'], skippedForBudget: 0, deduped: false, st, toolsReady: true,
    checkpointLine: '', memoryDir: '/tmp/mem', intentHistoryDependent: false,
  })
  ok(noGap.cardPart === '', '没有缺口、没在问历史、没有检查点 → 一个字都不说')
}

// ── 6. text：正文 / 卡 的两种形态 ──────────────────────────────
group('6. composeRecallText：只有卡时只发卡')
{
  const withParts = composeRecallText({ parts: ['P1', 'P2'], cardPart: 'CARD', memoryDir: '/m', discipline: 'D' })
  ok(withParts.startsWith('以下是与你当前问题相关的历史记忆') && withParts.includes('D\n\nP1\n\nP2') && withParts.endsWith('CARD'),
    '有正文时：头部 + 引用纪律 + 正文 + 卡')
  ok(composeRecallText({ parts: [], cardPart: 'CARD', memoryDir: '/m', discipline: 'D' }) === 'CARD',
    '只有卡时：不发头部与引用纪律（不然是假陈述）')
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
