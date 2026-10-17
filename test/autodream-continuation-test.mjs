#!/usr/bin/env node
/**
 * autodream-continuation-test.mjs — 「报告撞上输出上限后接着写」的断言（2026-10-17，1.0.1）
 *
 * 为什么需要它（真实事故，不是假想）：2026-10-17 凌晨那次手动整理，报告**断在半个句子里**
 * （`finalText` 8553 字符；前两次运行是 5532 / 5957 字符，都完整收尾），
 * 而运行状态报的是「成功」，界面上看不出任何异常。
 * 根因：每步硬编码 `maxTokens: 4096`，而循环只检查 `finish.kind === 'error'`，
 * 撞上 `max-tokens` 就等于「模型说完了」——半篇被当成成品写进报告。
 *
 * 这一版的行为是两件事：
 *   B. 撞上上限就**回灌已写内容 + 要下一段**（最多 3 轮）；
 *   C. 续写名额用尽仍没写完时，报告与声明里**显式标注残篇**（不再静默）。
 *
 * 用法: node autodream-continuation-test.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const LIB = new URL('../lib/', import.meta.url)
const { AutodreamEngine } = await import(new URL('autodream.js', LIB).href)

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

// ────────────────────────────── 夹具 ──────────────────────────────

/**
 * 假 llm：按剧本吐 chunk，**同时记账**（调用次数、每次传的 maxTokens、消息条数、最后一条 user 文本）。
 * 记账是必要的 —— 「续写发生了」的判据只能是「它真的又调了一次、且那次带着续写指令」。
 */
function makeLlm(script) {
  const calls = []
  let i = 0
  return {
    calls,
    async *stream(req = {}) {
      const chunks = script[Math.min(i, script.length - 1)] ?? []
      const msgs = req.messages ?? []
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      calls.push({
        n: i,
        maxTokens: req.maxTokens,
        messageCount: msgs.length,
        roles: msgs.map((m) => m.role).join(','),
        lastUser: lastUser?.content?.[0]?.text ?? '',
      })
      i += 1
      for (const c of chunks) yield c
    },
  }
}

const usage = (i, o) => ({ type: 'usage', usage: { inputTokens: i, outputTokens: o } })
const textChunks = (t) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: t },
  { type: 'block-end', index: 0, block: { type: 'text', text: t } },
]
/** 被输出上限截断的一段。 */
const cutStep = (t) => [...textChunks(t), usage(10, 100), { type: 'finish', reason: { kind: 'max-tokens' } }]
/** 正常说完的一段。 */
const stopStep = (t) => [...textChunks(t), usage(10, 100), { type: 'finish', reason: { kind: 'stop' } }]
/** 一个字都没有、却被判为截断（续写无从下手的那条边界）。 */
const emptyCut = () => [usage(10, 0), { type: 'finish', reason: { kind: 'max-tokens' } }]
/** 一次工具调用（拿来钉住「重构没有把工具路径改坏」）。 */
const toolStep = (id, name, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  usage(10, 20),
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

async function world(lmm, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ad-cont-'))
  const memoryDir = join(root, 'memory')
  const sessionsRoot = join(root, 'sessions')
  await mkdir(memoryDir, { recursive: true })
  await writeFile(join(memoryDir, 'a.md'), '---\nname: a\ntype: project\n---\n\n# A\n\n原文\n', 'utf8')
  await writeFile(join(memoryDir, 'MEMORY.md'), '---\nname: memory\n---\n\n# 索引\n\n- [a](a.md)\n', 'utf8')
  const ctx = {
    get: (n) =>
      n === 'llm' ? lmm : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined,
    logger: { warn: () => {}, error: () => {} },
  }
  const engine = new AutodreamEngine(ctx, { memoryDir, sessionsRoot })
  await engine.load()
  // apply:false = 只出报告模式 —— 与出事故那一次同档，不写记忆目录。
  await engine.setConfig({ enabled: true, trigger: 'auto', minHours: 1, minSessions: 1, apply: false, ...config })
  engine.state.lastRunAt = 0
  await engine.persist()
  return { root, memoryDir, engine }
}

async function artifacts(engine, memoryDir, runId) {
  const report = await readFile(join(memoryDir, 'autodream', `${runId}.md`), 'utf8')
  const manifest = JSON.parse(await readFile(join(engine.runsRoot, runId, 'manifest.json'), 'utf8'))
  const declaration = await readFile(join(engine.runsRoot, runId, 'declaration.md'), 'utf8')
  return { report, manifest, declaration }
}

// ────────────────────────────── 1. 续写把残篇接起来 ──────────────────────────────

group('1. 撞上上限 → 自动续写（报告应当是完整的）')
{
  const seg1 = '第一段：先看索引与最近改动的记忆。'
  const seg2 = '第二段：B6 那条发现，frontmatter 缺 updated。'
  const seg3 = '第三段：收尾——以上是本轮全部建议。'
  const lmm = makeLlm([cutStep(seg1), cutStep(seg2), stopStep(seg3)])
  const { engine, memoryDir } = await world(lmm)
  const r = await engine.run({ reason: 'x', force: true })
  const { report, manifest, declaration } = await artifacts(engine, memoryDir, r.runId)

  ok(r.ok === true, '整趟跑成功', JSON.stringify(r))
  ok(lmm.calls.length === 3, `模型被调用了 3 次（1 + 2 段续写），实际 ${lmm.calls.length}`)
  ok(r.continuations === 2, `续写轮数 = 2，实际 ${r.continuations}`)
  ok(r.truncated === false, '续写补齐后**不是**残篇')
  // ⚠️ 用可选链：续写被关掉时这几条要是直接抛 TypeError，红色就只剩一行崩溃，
  // 看不出「哪几条判据没成立」——变异验证时就踩到了这个。
  ok((lmm.calls[1]?.messageCount ?? 0) > lmm.calls[0].messageCount, '续写那次把已写内容回灌进了消息历史')
  ok((lmm.calls[1]?.lastUser ?? '').includes('继续写'), '续写那次的最后一条 user 是「接着写」指令', lmm.calls[1]?.lastUser)
  ok(lmm.calls.every((c) => c.maxTokens === 4096), '单次上限没有被偷偷改大（B 是接写，不是调大数字）')

  const joined = `${seg1}${seg2}${seg3}`
  ok(report.includes(joined), '报告里的收尾说明是**三段拼起来的完整文字**')
  ok(report.includes('已自动续写 2 轮补齐'), '报告第一屏写明「曾撞上限、已续写补齐」')
  ok(!report.includes('本次输出被单次长度上限截断'), '补齐的报告里**不**出现残篇警告')
  ok(declaration.includes('已自动续写 2 轮补齐'), '整理声明里也有这句')
  ok(manifest.truncated === false && manifest.continuations === 2, '机读记录：truncated=false / continuations=2',
    JSON.stringify({ t: manifest.truncated, c: manifest.continuations }))
  ok((report.match(/（截断续写）/g) ?? []).length === 2, '「过程」把两段续写都标了出来')
  ok(engine.stepLog.filter((s) => s.continuation === true).length === 2, 'stepLog 也记了续写（面板的步骤列表）')
  ok(engine.stepLog.filter((s) => s.continuation !== true).length === 1, '未被标成续写的那条是第一步')
}

// ────────────────────────────── 2. 续写用尽 → 残篇被标出来 ──────────────────────────────

group('2. 续写用尽仍没写完 → 报告里显式标注残篇（不许静默）')
{
  // 5 段都被截断：假 llm 会一直重放最后一段，所以「停不停得下来」本身也是断言。
  const lmm = makeLlm([cutStep('一'), cutStep('二'), cutStep('三'), cutStep('四'), cutStep('五')])
  const { engine, memoryDir } = await world(lmm)
  const r = await engine.run({ reason: 'x', force: true })
  const { report, manifest, declaration } = await artifacts(engine, memoryDir, r.runId)

  ok(r.ok === true, '整趟仍然算跑完（残篇不是运行失败）')
  ok(lmm.calls.length === 4, `调用次数被卡在 1 + 3 轮续写，实际 ${lmm.calls.length}`)
  ok(r.continuations === 3, `续写轮数停在硬上限 3，实际 ${r.continuations}`)
  ok(r.truncated === true, 'truncated 如实为 true')
  ok(report.includes('本次输出被单次长度上限截断'), '报告第一屏有残篇警告')
  ok(report.includes('残篇'), '警告里说清「下面那段是残篇」')
  ok(report.includes('上面这段是残篇，后文缺失'), '「过程」末尾以「没写完」收尾')
  ok(declaration.includes('残篇'), '整理声明里也标了残篇')
  ok(manifest.truncated === true && manifest.continuations === 3, '机读记录：truncated=true / continuations=3')
  ok(engine.stepLog.filter((s) => s.continuation === true).length === 3, '三段续写都进了 stepLog')
}

// ────────────────────────────── 3. 空段不许空转 ──────────────────────────────

group('3. 一个字都没有的截断段：不续写、不空转')
{
  const lmm = makeLlm([emptyCut()])
  const { engine } = await world(lmm)
  const r = await engine.run({ reason: 'x', force: true })

  ok(lmm.calls.length === 1, `没有拿着空回复去要下一段（调用 ${lmm.calls.length} 次）`)
  ok(r.continuations === 0, '续写轮数为 0')
  ok(r.truncated === true, '空回复也算「没写完」，truncated=true')
}

// ────────────────────────────── 4. 回归：正常路径与工具路径 ──────────────────────────────

group('4. 回归：没截断时行为与从前一致，工具路径仍通')
{
  const lmm = makeLlm([stopStep('完整收尾，一句话没被切断。')])
  const { engine, memoryDir } = await world(lmm)
  const r = await engine.run({ reason: 'x', force: true })
  const { report, manifest } = await artifacts(engine, memoryDir, r.runId)

  ok(lmm.calls.length === 1, '没截断就只调一次模型（不多要一轮）')
  ok(r.continuations === 0 && r.truncated === false, '续写与残篇两个账都是 0/false')
  ok(manifest.continuations === 0 && manifest.truncated === false, '机读记录同样干净')
  ok(!report.includes('续写'), '报告里不出现「续写」字样')
  ok(report.includes('完整收尾，一句话没被切断。'), '收尾说明原样落进报告')
  ok((report.match(/（截断续写）/g) ?? []).length === 0, '「过程」里一条续写标记都没有')

  const lmm2 = makeLlm([toolStep('call-1', 'list_memory', {}), stopStep('看完清单，收尾。')])
  const w2 = await world(lmm2)
  const r2 = await w2.engine.run({ reason: 'x', force: true })
  const a2 = await artifacts(w2.engine, w2.memoryDir, r2.runId)
  ok(lmm2.calls.length === 2, '工具步之后还跑了第二步', `实际 ${lmm2.calls.length}`)
  ok(lmm2.calls[1].roles.includes('tool'), '第二步的历史里有工具结果（回灌没断）', lmm2.calls[1].roles)
  ok(a2.manifest.finalText === '看完清单，收尾。', '收尾说明取的是最后一步的文字', JSON.stringify(a2.manifest.finalText))
  ok(a2.report.includes('调用 list_memory'), '「过程」记下了工具调用')
}

// ────────────────────────────── 5. 「过程」排版：模型文本不许把标题漏出来 ──────────────────────────────

group('5. 「过程」每步只占一行（模型文本里的换行与标题不许漏成真标题）')
{
  // 真实踩点（2026-10-17 10:42 那份报告）：「结束」那一步的文字以「这次整合已经完成。下面逐条列出建议的改动。」
  // 开头，紧接着两个换行 + `## 一、必须修改的…`。直接对原文 slice(0,120) 会把后面的标题当成真标题渲染，
  // 整份报告读起来像「内容重复了一遍」。
  const stepText =
    '这次整合已经完成。下面逐条列出建议的改动。\n\n## 一、必须修改的\n\n**文件：`a.md`**，在「gh CLI」那一节'
  const lmm = makeLlm([stopStep(stepText)])
  const { engine, memoryDir } = await world(lmm)
  const r = await engine.run({ reason: 'x', force: true })
  const { report } = await artifacts(engine, memoryDir, r.runId)

  const proc = report.slice(report.indexOf('## 过程'))
  const procLines = proc.split('\n').filter((l) => l.trim())
  ok(procLines.length >= 2, '「过程」节存在且有内容', JSON.stringify(procLines.slice(0, 2)))
  ok(
    procLines.slice(1).every((l) => l.startsWith('- 第 ')),
    '「过程」里除标题外全是「- 第 N 轮」行（换行被压平成一行）',
    JSON.stringify(procLines.slice(1, 4)),
  )
  ok(!proc.includes('\n## 一、'), '模型文本里的 `## 标题` 没有漏成报告的真标题')
  ok(report.includes('## 一、必须修改的'), '但它在「模型的收尾说明」里原样保留（那是模型的原文）')
}

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
