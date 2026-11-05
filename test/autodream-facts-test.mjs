#!/usr/bin/env node
/**
 * autodream-facts-test.mjs — 「被删掉的事实」这一节（2.4.0 建）
 *
 * **为什么这条守卫必须存在**：结构审计（断链 / 格式 / 索引）看不见事实丢失。
 * 2026-11-05 09:15 实测：一趟自动整理把某条记忆里「到期 2027-10-03、不自动续费」
 * 这条仍然生效的账压掉了，跑完自报「审计 2 问题 → 0 问题」—— 每一张表都是绿的。
 * 人能发现它，只因为事后拿回滚点快照逐行 diff。
 *
 * 所以这份套件把那次事故本身做成了夹具，并且钉住三条口径：
 *   1. 删除动作覆盖 `update`（改写）与 `archive`（整条退役）；
 *   2. 事实来自**宿主自己算的 diff**，不是模型自述；
 *   3. 逐条列原文 —— 不许退化成一句「压缩成 X KB」。
 *
 * 用法: node test/autodream-facts-test.mjs
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  budgetFactGroups,
  diffRemovedFacts,
  entryFacts,
  lineKey,
  FACTS_PER_FILE,
  FACTS_TOTAL_MAX,
} from '../lib/autodream/facts.js'
import { renderDeclaration, writeDeclaration } from '../lib/autodream/report.js'
import { createToolRunner } from '../lib/autodream/tools.js'

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}
function group(t) {
  console.log('== ' + t + ' ==')
}

const FM = '---\nname: x\ntype: reference\n---\n'

// ────────────────────────────── 1. 归一化 ──────────────────────────────
group('1. 归一化：重新排版不算删事实')
{
  ok(lineKey('- 到期 2027-10-03') === lineKey('>   到期   2027-10-03'), '列表/引用标记与多余空白被抹平')
  ok(lineKey('- **到期** 2027-10-03') === lineKey('- 到期 2027-10-03'), '**强调** 符号不算内容')
  ok(lineKey('`到期` 2027-10-03') === lineKey('到期 2027-10-03'), '反引号不算内容')
  ok(lineKey('') === '' && lineKey('   ') === '', '空行归一成空串')

  const before = `${FM}\n# X\n\n- 到期 2027-10-03、不自动续费\n- 机房在洛杉矶\n`
  const reformatted = `${FM}\n# X\n\n* **到期 2027-10-03、不自动续费**\n  > 机房在洛杉矶\n`
  const r = diffRemovedFacts(before, reformatted)
  ok(r.total === 0, '只是换了列表符号与强调 → 零条删除', JSON.stringify(r.removed))
}

// ────────────────────────────── 2. 真删除（事故复现）──────────────────────────────
group('2. 真删除：2026-11-05 那次压缩把仍然生效的账删掉了')
{
  const before = [
    FM,
    '# 远程服务器',
    '',
    '- 洛杉矶机房：2026-10-04 开通',
    '- 到期 2027-10-03、不自动续费',
    '- 11-03 重建只换机房，不换订阅',
    '- SSH 走 Tailscale，不开公网',
    '',
  ].join('\n')
  // 模型「降级为历史留档」时把三行压成一行，顺手丢了订阅期限。
  const after = [FM, '# 远程服务器', '', '- 洛杉矶机房：2026-10-04 开通（历史留档）', ''].join('\n')
  const r = diffRemovedFacts(before, after)
  ok(
    r.removed.some((f) => f.text.includes('2027-10-03')),
    '【事故】「到期 2027-10-03、不自动续费」被列了出来',
    JSON.stringify(r.removed),
  )
  // 四条原文全部不在新正文里 —— 其中包括被并进「（历史留档）」那句的那条：\n  // 它照样算删除，只是多一个「可能已并进」的线索（审查口径：线索不能变成不报）。\n  ok(r.total === 4, `四条原文都列出来（实际 ${r.total}）`, JSON.stringify(r.removed.map((f) => f.text)))\n  ok(r.removed.some((f) => f.mergedInto > 0), '被并进另一行的那条带 mergedInto 线索')
  ok(
    r.removed.every((f) => typeof f.line === 'number' && f.line > 0),
    '每条都带原文行号（人要能回到快照里对）',
  )
  ok(r.removed.every((f) => !f.text.includes('历史留档')), '新增的内容不会混进「被删」清单')
  ok(r.removed.every((f) => !/^\s*[-*+>#]/.test(f.text)), '展示文本已去掉 markdown 结构标记')
}

// ────────────────────────────── 3. 三条降噪规则 ──────────────────────────────
group('3. 降噪与误报：宁可多报噪音，不可静默吃掉真删除')
{
  // ① 合并**不再降噪**：照报，只附一个「可能并进了哪一行」的线索
  const merged = diffRemovedFacts(
    `${FM}\n- 到期 2027-10-03\n- 不自动续费\n`,
    `${FM}\n- 到期 2027-10-03、不自动续费（合并后的一句话）\n`,
  )
  ok(merged.total === 2, `两行被并进一行 → 仍然报（宁可多报，不可静默吃掉真删除），实际 ${merged.total}`, JSON.stringify(merged.removed))
  ok(merged.removed.every((f) => f.mergedInto === 6), '附上「可能已并进 L6」的线索（不是「所以没删」）', JSON.stringify(merged.removed))

  // ② 审查 2026-11-05 抓到的两个真反例：包含关系不许把真删除吃掉
  const shortTitle = diffRemovedFacts(`${FM}\n- 到期 2027-10-03，不自动续费\n`, `${FM}\n## 2027\n`)
  ok(shortTitle.total === 1, '短标题（## 2027）不许吞掉整条到期账', JSON.stringify(shortTitle.removed))
  const negated = diffRemovedFacts(`${FM}\n- 自动续费\n`, `${FM}\n- 不自动续费\n`)
  ok(negated.total === 1, '否定翻转（自动续费 → 不自动续费）必须报出来', JSON.stringify(negated.removed))

  // ② 多重集配额：重复出现的行被删掉一条也要报
  const dup = diffRemovedFacts(`${FM}\n- 同一句话在同一份文件里出现两次\n- 同一句话在同一份文件里出现两次\n`, `${FM}\n- 同一句话在同一份文件里出现两次\n`)
  ok(dup.total === 1, `重复行被删掉一条也要报（实际 ${dup.total}）`, JSON.stringify(dup.removed))

  // ③ 太短的行不算事实
  const short = diffRemovedFacts(`${FM}\n- 到期 2027-10-03\n- a\n---\n`, `${FM}\n- 到期 2027-10-03\n---\n`)
  ok(short.total === 0, '短于 4 字的行不当作事实（分隔符 / 单字噪音）', JSON.stringify(short.removed))

  // frontmatter 是元数据，它的键被删不该刷屏
  const fm = diffRemovedFacts(`${FM}\n- 一条真的事实\n`, `---\nname: x\n---\n\n- 一条真的事实\n`)
  ok(fm.total === 0, 'frontmatter 里被删掉的 type 行不算「事实被删」', JSON.stringify(fm.removed))

  // 正文中间的 `---` 是分隔线，不能把它当成 frontmatter 的结束而跳过后面
  const dashed = diffRemovedFacts(
    `---\nname: x\n---\n\n- 第一条事实\n\n---\n\n- 第二条事实被删了\n`,
    `---\nname: x\n---\n\n- 第一条事实\n\n---\n`,
  )
  ok(
    dashed.removed.some((f) => f.text.includes('第二条事实被删了')),
    '水平分隔线之后的事实照样参与比对',
    JSON.stringify(dashed.removed),
  )
}

// ────────────────────────────── 4. 归档：整条退役 ──────────────────────────────
group('4. entryFacts：归档把整条记忆承载的事实列出来')
{
  const text = [
    '---',
    'name: old-thing',
    'description: 一条会被当成元数据排除的描述',
    'type: project',
    '---',
    '',
    '# 旧项目',
    '',
    '- 接口在 2026-09-01 下线',
    '- 备份留在灰云的 backup 目录',
    '- 联系人已经换过一次',
    '',
  ].join('\n')
  const e = entryFacts(text)
  ok(e.title === '旧项目', `标题被单独取出来（实际 ${JSON.stringify(e.title)}）`)
  ok(e.total === 3, `三条事实全部列出（实际 ${e.total}）`, JSON.stringify(e.facts.map((f) => f.text)))
  ok(e.facts.every((f) => !f.text.includes('description:')), 'frontmatter 不出现在事实列表里')
  ok(e.facts.every((f) => f.text !== '旧项目'), '标题不重复进事实列表')

  // 超长时截断，但 total 报真实条数 —— 声明里才有「还有 N 条没列」
  const many = `${FM}\n# 多\n\n${Array.from({ length: FACTS_PER_FILE + 5 }, (_, i) => `- 第 ${i + 1} 条事实描述内容`).join('\n')}\n`
  const e2 = entryFacts(many)
  ok(e2.facts.length === FACTS_PER_FILE, `列表截断到 ${FACTS_PER_FILE} 条`)
  ok(e2.total === FACTS_PER_FILE + 5, `但总数报真实的 ${FACTS_PER_FILE + 5} 条`)
}

// ────────────────────────────── 5. 预算 ──────────────────────────────
group('5. 预算：声明不能被这一节撑爆')
{
  const big = '很长的原文'.repeat(400) // 2000 字符
  const groups = Array.from({ length: 6 }, (_, i) => ({
    file: `f${i}.md`,
    kind: 'rewrite',
    removed: [{ line: 1, text: big }],
    total: 1,
    beforeLines: 10,
    afterLines: 9,
  }))
  const b = budgetFactGroups(groups)
  ok(b.shown.length >= 1 && b.shown.length < groups.length, `超预算后只保留前几组（实际 ${b.shown.length}）`)
  ok(b.chars <= FACTS_TOTAL_MAX, `实际用量不超上限（${b.chars} ≤ ${FACTS_TOTAL_MAX}）`)
  ok(b.omittedGroups === groups.length - b.shown.length, '被省略的组数算对了')
  ok(b.omittedFacts === groups.length - b.shown.length, '被省略的事实条数算对了')

  // 第一组永远显示：整节一条都出不来等于这个功能没做
  const single = budgetFactGroups([{ file: 'only.md', kind: 'rewrite', removed: [{ line: 1, text: big }], total: 1 }])
  ok(single.shown.length === 1, '只有一组时即使超预算也照样显示')
}

// ────────────────────────────── 6. 声明端到端 ──────────────────────────────
group('6. renderDeclaration：逐条列出，不退化成一句概括')
{
  const base = {
    runId: '20261105-091500-0001',
    startedAtHuman: '2026-11-05 09:15:00',
    mode: 'apply',
    route: { provider: 'p', model: 'm' },
    snapshot: { id: 'snap-1', dir: '/x', files: 12 },
    audit: { before: { problems: 2 }, after: { problems: 0 } },
    truncated: false,
    continuations: 0,
    retries: 0,
    warnings: [],
    notes: [],
    finalText: '收尾',
    archive: { mode: 'off', candidates: [], archived: [], degraded: '' },
    changes: [
      {
        seq: 1,
        file: 'reference_remote-servers.md',
        op: 'update',
        reason: '洛杉矶节降级为历史留档',
        reasonSource: 'model',
        before: { exist: true, bytes: 1200 },
        after: { exist: true, bytes: 900 },
        removedKind: 'rewrite',
        removedTotal: 2,
        removedFacts: [
          { line: 42, text: '到期 2027-10-03、不自动续费' },
          { line: 43, text: '11-03 重建只换机房，不换订阅' },
        ],
        linesBefore: 58,
        linesAfter: 51,
      },
    ],
  }
  const md = renderDeclaration(base)
  ok(md.includes('被删掉的事实'), '声明里有「被删掉的事实」一节')
  ok(md.includes('到期 2027-10-03、不自动续费'), '【事故】事故那条原文被逐条列出')
  ok(md.includes('`L42`'), '每条带行号')
  ok(md.includes('改写') && md.includes('事实行 58 → 51'), '标题写明是改写与事实行数变化')
  ok(md.indexOf('被删掉的事实') > md.indexOf('改了什么、为什么'), '这一节排在改动表之后')
  ok(
    !/被删掉的事实[\s\S]*压缩成/.test(md),
    '没有任何一处退化成「压缩成 X KB」这种概括',
  )

  // 归档：列出这条记忆承载的事实
  const arch = renderDeclaration({
    ...base,
    changes: [
      {
        seq: 1,
        file: 'project_old.md',
        op: 'archive',
        reason: '已被取代',
        reasonSource: 'model',
        before: { exist: true, bytes: 800 },
        after: { exist: false, bytes: 0 },
        removedKind: 'archive',
        removedTotal: 1,
        removedFacts: [{ line: 8, text: '接口在 2026-09-01 下线' }],
        entryTitle: '旧项目',
      },
    ],
  })
  ok(arch.includes('归档 · 承载 1 条事实'), '归档条目写明承载多少条事实')
  ok(arch.includes('接口在 2026-09-01 下线'), '归档的事实被逐条列出')

  // 自动归档策略收走的文件同样要列 —— 那正是「无人值守时丢了东西」最容易发生的地方
  const policy = renderDeclaration({
    ...base,
    changes: [],
    archive: {
      mode: 'auto',
      candidates: [{ file: 'reference_zzz.md', type: 'reference', days: 120, limit: 90, reason: '超过 90 天未被注入' }],
      archived: [
        {
          file: 'reference_zzz.md',
          ok: true,
          message: '已归档',
          removedKind: 'archive',
          removedTotal: 1,
          removedFacts: [{ line: 5, text: '这条事实随归档一起不再参与检索' }],
          entryTitle: '一个旧参考',
        },
      ],
      degraded: '',
    },
  })
  ok(policy.includes('这条事实随归档一起不再参与检索'), '自动归档策略收走的文件也逐条列事实')

  // 老 manifest（没有 removedFacts 字段）不许报错，也不许伪造一节
  const legacy = renderDeclaration({ ...base, changes: [{ seq: 1, file: 'a.md', op: 'update', reason: 'x', reasonSource: 'model', before: { bytes: 10 }, after: { bytes: 9 } }] })
  ok(!legacy.includes('被删掉的事实'), '没有事实数据时不出这一节（老运行记录照常渲染）')
  ok(legacy.includes('改了什么、为什么'), '老运行记录的其余部分不受影响')

  // 归档**失败**的文件一个字都不能列 —— 它还在活动记忆里（2026-11-05 审查抓到的自相矛盾）
  const failedArchive = renderDeclaration({
    ...base,
    changes: [],
    archive: {
      mode: 'auto',
      candidates: [],
      archived: [
        {
          file: 'still-here.md',
          ok: false,
          message: '错误：archive/ 里已有同名文件，请先人工处理',
          removedKind: 'archive',
          removedTotal: 3,
          removedFacts: [{ line: 1, text: '这段原文不该出现在被删清单里' }],
        },
      ],
      degraded: '',
    },
  })
  ok(!failedArchive.includes('这段原文不该出现在被删清单里'), '归档失败的文件不进「被删掉的事实」（它没有消失）')
  ok(!failedArchive.includes('被删掉的事实'), '全是失败归档时这一节根本不出（不留空节）')

  // 读不到改动前的正文：留痕，别和「这一趟什么都没删」混成一样
  const unavailable = renderDeclaration({
    ...base,
    changes: [{ seq: 1, file: 'huge.md', op: 'update', reason: 'x', reasonSource: 'model', before: { bytes: 600000 }, after: { bytes: 100 }, removedUnavailable: true }],
  })
  ok(unavailable.includes('原文读不到'), '读不到改动前正文时在声明里留痕')
  ok(unavailable.includes('被删掉的事实'), '这种情况下这一节仍然出现（它不是「没删」，是「不知道」）')
}

// ────────────────────────────── 6b. 机读记录的预算 ──────────────────────────────
group('6b. manifest 也守预算：运行记录不轮转，不能让它无限长')
{
  const root = await mkdtemp(join(tmpdir(), 'ad-facts-run-'))
  const bigFact = (i) => ({ line: i, text: '这一条是长得像真事实的原文'.repeat(18) }) // ≈390 字符
  const changes = Array.from({ length: 12 }, (_, k) => ({
    seq: k + 1,
    file: `f${k}.md`,
    op: 'update',
    reason: '压缩',
    reasonSource: 'model',
    before: { exist: true, bytes: 9000 },
    after: { exist: true, bytes: 100 },
    removedKind: 'rewrite',
    removedTotal: 40,
    removedFacts: Array.from({ length: 40 }, (_, i) => bigFact(i + 1)),
    linesBefore: 50,
    linesAfter: 5,
  }))
  const engineLike = { runsRoot: join(root, 'runs'), renderDeclaration }
  const r = await writeDeclaration.call(engineLike, {
    runId: '20261105-000000-bulk',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    reason: '测试',
    apply: true,
    source: 'memory',
    provider: 'p',
    model: 'm',
    fromDefault: false,
    hoursSince: 1,
    sessionCount: 1,
    tokensIn: 1,
    tokensOut: 1,
    snapshot: null,
    changes,
    warnings: [],
    notes: [],
    auditBefore: { problems: 0 },
    auditAfter: { problems: 0 },
    finalText: '收尾',
  })
  ok(r.factsTruncated === true, '超预算时声明返回 factsTruncated')
  // 内存里那份必须是完整的 —— 人读的 markdown 就是从它渲染出来的
  ok(r.manifest.changes.every((c) => c.removedFacts.length === 40), '返回给调用方的 manifest 不被裁剪（人读声明不受影响）')
  ok(r.markdown.includes('被删掉的事实'), '人读声明照样有这一节')

  const stored = JSON.parse(await readFile(join(r.dir, 'manifest.json'), 'utf8'))
  ok(stored.factsTruncated === true, '写盘那份标了 factsTruncated')
  ok(stored.changes.some((c) => c.factsOmitted === true), '被裁掉的条目带 factsOmitted（不假装没有事实）')
  ok(stored.changes.every((c) => c.removedTotal === 40), '裁掉原文时 removedTotal 这个数字保留（丢的不是条数）')
  const bytes = Buffer.byteLength(JSON.stringify(stored), 'utf8')
  ok(bytes < 90 * 1024, `机读记录真的被压住了（${bytes} 字节 < 90 KB）`)
  // 短清单不该被无故裁剪 —— 否则「factsTruncated」就成了永远为真的噪音
  const small = await writeDeclaration.call(engineLike, {
    runId: '20261105-000001-small',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    reason: '测试',
    apply: true,
    source: 'memory',
    provider: 'p',
    model: 'm',
    fromDefault: false,
    hoursSince: 1,
    sessionCount: 1,
    tokensIn: 1,
    tokensOut: 1,
    snapshot: null,
    changes: [{ ...changes[0], removedFacts: [bigFact(1)] }],
    warnings: [],
    notes: [],
    auditBefore: { problems: 0 },
    auditAfter: { problems: 0 },
    finalText: '',
  })
  ok(small.factsTruncated === false, '一小份声明不会被无故标成截断')
}

// ────────────────────────────── 7. 真实链路：工具层 ──────────────────────────────
group('7. 真实链路：write_memory / archive_memory 把事实塞进 change')
{
  const root = await mkdtemp(join(tmpdir(), 'ad-facts-'))
  const mem = join(root, 'memory')
  await mkdir(mem, { recursive: true })
  const ctx = { get: () => undefined, logger: { warn: () => {}, error: () => {} } }
  const runner = createToolRunner({ memoryDir: mem, sessionsRoot: '', apply: true, withSessions: false, ctx })
  await writeFile(
    join(mem, 'server.md'),
    `${FM}\n# 远程服务器\n\n- 洛杉矶机房：2026-10-04 开通\n- 到期 2027-10-03、不自动续费\n- SSH 走 Tailscale，不开公网\n`,
    'utf8',
  )
  const w = await runner.run('write_memory', {
    file: 'server.md',
    content: `${FM}\n# 远程服务器\n\n- 洛杉矶机房：2026-10-04 开通（历史留档）\n`,
    reason: '洛杉矶节降级为历史留档',
  })
  ok(w.startsWith('已写入'), `改写成功（${w}）`)
  const c1 = runner.changes()[0]
  ok(c1.op === 'update' && c1.removedKind === 'rewrite', '改写记录了 removedKind=rewrite')
  ok(c1.removedTotal === 3, `数出 3 条被删事实（实际 ${c1.removedTotal}）`, JSON.stringify(c1.removedFacts))
  ok(
    (c1.removedFacts ?? []).some((f) => f.text.includes('到期 2027-10-03')),
    '【事故】那条仍然生效的账进了机读记录',
  )

  await writeFile(join(mem, 'retire.md'), `${FM}\n# 待退役\n\n- 接口在 2026-09-01 下线\n- 备份在灰云\n`, 'utf8')
  const a = await runner.run('archive_memory', { file: 'retire.md', reason: '已被取代' })
  ok(a.startsWith('已归档'), `归档成功（${a}）`)
  const c2 = runner.changes()[1]
  ok(c2.op === 'archive' && c2.removedKind === 'archive', '归档记录了 removedKind=archive')
  ok(c2.removedTotal === 2, `归档列出整条的 2 条事实（实际 ${c2.removedTotal}）`, JSON.stringify(c2.removedFacts))
  ok(c2.entryTitle === '待退役', `归档带上条目标题（实际 ${JSON.stringify(c2.entryTitle)}）`)

  // 新建没有对照面 —— 不许凭空报「删了东西」
  const n = await runner.run('write_memory', { file: 'fresh.md', content: `${FM}\n# 新条目\n\n- 一条新事实\n`, reason: '新增' })
  ok(n.includes('新建'), '新建成功')
  const c3 = runner.changes()[2]
  ok(c3.op === 'create' && !c3.removedKind && !c3.removedFacts, '新建不带任何「被删事实」字段')

  // 模型自述有无都不影响事实抽取（来源是宿主 diff，不是模型的话）
  const n2 = await runner.run('write_memory', { file: 'server.md', content: `${FM}\n# 远程服务器\n\n- 只剩这一行\n` })
  const c4 = runner.changes()[3]
  ok(c4.reasonSource === 'auto' && c4.removedTotal === 1, '未自述缘由时事实照样被算出来（不靠模型诚实）')
}

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
