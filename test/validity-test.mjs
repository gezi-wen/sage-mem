#!/usr/bin/env node
/**
 * validity-test.mjs — 2.0.0「有效性数据模型」的断言（frontmatter 三字段 / 纯函数判定 /
 * scan 带出 / audit 提示）。
 *
 * 这一片**不改注入行为、不写任何用户文件**（`docs/2.0.0-plan.md` 切片 2.0.0-alpha.1），
 * 所以本套件全长在纯函数与只读函数上，唯一的 IO 是 mkdtemp 出来的临时目录。
 *
 * 重点是**反向对照**（本仓库的验收传统：只测「会报错」等于没测）：
 *   · 未标注 → 有效（失效集合为空，与 1.9.2 逐字相同）；
 *   · 坏格式 → 按未标注处理（**不是**失效）；
 *   · 未来 `invalid_at` → 暂不失效（`expired:false`、`pendingFuture:true`）；
 *   · CRLF 文件的三字段照常解析（1.6.x 那次「CRLF 让整条记忆检索不到」的教训）；
 *   · `stale_version` 的 open 记录**不进**抑制集合（§6.3，D27）；
 *   · audit 的坏标注只进提示、**不抬高 problems**（issue #8 的教训）。
 *
 * 三个前提（与 watch/conflicts 套件同口径）：
 *   1. `MEMORY_DIR` 是模块顶层读的环境变量 —— 必须在动态 import **之前**设好；
 *   2. 只碰 mkdtemp 出来的临时目录，不碰真实记忆 / 状态目录；
 *   3. 夹具一律合成：公开仓库里不出现真实记忆内容或本机绝对路径。
 *
 * 用法: node test/validity-test.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// ── 沙箱：环境变量必须在 import 之前 ─────────────────────────
const world = await mkdtemp(join(tmpdir(), 'sage-mem-validity-'))
process.env.SAGE_MEM_DIR = join(world, 'memory')
process.env.SAGE_MEM_STATE_DIR = join(world, '.sage-mem')
process.env.DSH_HOME = join(world, 'dsh-home')
await mkdir(process.env.SAGE_MEM_DIR, { recursive: true })
await mkdir(process.env.SAGE_MEM_STATE_DIR, { recursive: true })

const modUrl = (rel) => new URL(`../lib/${rel}`, import.meta.url).href
const { parseFrontmatter } = await import(modUrl('memory/frontmatter.js'))
const validity = await import(modUrl('memory/validity.js'))
const scan = await import(modUrl('memory/scan.js'))
const { auditMemoryDir, formatAudit } = await import(modUrl('autodream/audit.js'))

const { parseValidityTime, isExpired, describeValidity, buildExpirySet, buildContradictionFileSet } = validity

/** 合成一份带 frontmatter 的记忆正文。行用 LF；CRLF 单独造。 */
const memo = (lines, body = '# 标题\n\n正文\n') => `---\n${lines.join('\n')}\n---\n\n${body}`

group('0. 前置：解析入口与导出面')
{
  const fm = parseFrontmatter(memo(['name: a', 'type: project', 'valid_at: 2026-10-01T08:00:00+08:00']))
  ok(
    typeof fm.validAt === 'string' && typeof fm.invalidAt === 'string' && typeof fm.supersededBy === 'string',
    'parseFrontmatter 返回 validAt / invalidAt / supersededBy 三个字符串字段',
    JSON.stringify({ validAt: fm.validAt, invalidAt: fm.invalidAt, supersededBy: fm.supersededBy }),
  )
  const nonArr = [parseValidityTime, isExpired, describeValidity, buildExpirySet, buildContradictionFileSet]
  ok(nonArr.every((f) => typeof f === 'function'), 'validity.js 的五个接口都是函数')
  // 判据只有一份：audit 的薄包装必须透传同一份解析（D22）。
  const { parseFrontmatterLite } = await import(modUrl('autodream/audit.js'))
  const shared = memo(['name: a', 'invalid_at: 2026-10-01T00:00:00Z'])
  const lite = parseFrontmatterLite(shared)
  ok(lite.invalidAt === parseFrontmatter(shared).invalidAt && lite.invalidAt === '2026-10-01T00:00:00Z',
    'audit 的 parseFrontmatterLite 透传同一份解析（没有第二套 frontmatter 规则）', String(lite.invalidAt))
}

group('1. frontmatter：三字段的读取口径（顶层 / 缺失 / CRLF / 引号）')
{
  const top = parseFrontmatter(memo([
    'name: a',
    'type: project',
    'valid_at: 2026-10-01T08:00:00+08:00',
    'invalid_at: 2026-10-20T18:30:00+08:00',
    'superseded_by: project_beta.md',
    'updated: 2026-10-21',
  ]))
  ok(top.validAt === '2026-10-01T08:00:00+08:00', '顶层 valid_at 抓得到', JSON.stringify(top.validAt))
  ok(top.invalidAt === '2026-10-20T18:30:00+08:00', '顶层 invalid_at 抓得到', JSON.stringify(top.invalidAt))
  ok(top.supersededBy === 'project_beta.md', '顶层 superseded_by 抓得到', JSON.stringify(top.supersededBy))
  // 反向对照：三字段的加入不许动到其它字段的解析（零回归）
  ok(top.description === '' && top.type === 'project' && top.updated === '2026-10-21',
    '【反向对照】新增三字段后其它 frontmatter 字段逐字不受影响',
    JSON.stringify({ description: top.description, type: top.type, updated: top.updated }))

  const missing = parseFrontmatter(memo(['name: a', 'type: project']))
  ok(missing.validAt === '' && missing.invalidAt === '' && missing.supersededBy === '',
    '写了 frontmatter 但没这三字段 → 三个空串（缺失即老行为）',
    JSON.stringify([missing.validAt, missing.invalidAt, missing.supersededBy]))

  const none = parseFrontmatter('没有 frontmatter 的纯正文\n')
  ok(none.validAt === '' && none.invalidAt === '' && none.supersededBy === '',
    '完全没有 frontmatter → 三个空串，不报错也不猜',
    JSON.stringify([none.validAt, none.invalidAt, none.supersededBy]))

  // CRLF：1.6.x 那次事故是「用 Windows 编辑器碰过一次 → 整条记忆检索不到」。
  const crlf = parseFrontmatter('---\r\nname: a\r\ntype: project\r\nvalid_at: 2026-10-01T08:00:00+08:00\r\ninvalid_at: 2026-10-20T18:30:00+08:00\r\nsuperseded_by: project_beta.md\r\n---\r\n\r\n正文\r\n')
  ok(crlf.invalidAt === '2026-10-20T18:30:00+08:00' && crlf.validAt === '2026-10-01T08:00:00+08:00' &&
    crlf.supersededBy === 'project_beta.md',
    'CRLF 文件的三个字段照常解析（不是空串）',
    JSON.stringify([crlf.validAt, crlf.invalidAt, crlf.supersededBy]))

  const quoted = parseFrontmatter(memo(['name: a', 'invalid_at: "2026-10-20T18:30:00+08:00"']))
  ok(quoted.invalidAt === '2026-10-20T18:30:00+08:00', '值两侧的引号被剥掉（手写 YAML 的自然产物）', JSON.stringify(quoted.invalidAt))

  // 反向对照：规范只认顶层。metadata 嵌套里的同名字段**不**回落 —— 否则同一条记忆的
  // 语义会取决于写它的人用了哪种格式，而这三个字段直接决定它会不会被注入。
  const nested = parseFrontmatter(memo([
    'name: a',
    'metadata:',
    '  node_type: memory',
    '  invalid_at: 2026-10-20T18:30:00+08:00',
  ]))
  ok(nested.invalidAt === '', '【反向对照】metadata 嵌套里的 invalid_at 不被认（规范只认顶层）', JSON.stringify(nested.invalidAt))
}

group('2. parseValidityTime：认得出 / 认不出（R2 两道闸门）')
{
  const utc = parseValidityTime('2026-10-24T10:30:00Z')
  ok(utc.ok === true && utc.ms === Date.UTC(2026, 9, 24, 10, 30, 0), 'Z 结尾的完整 ISO 8601 认得出',
    JSON.stringify(utc))

  const offset = parseValidityTime('2026-10-24T18:30:00+08:00')
  ok(offset.ok === true && offset.ms === Date.UTC(2026, 9, 24, 10, 30, 0), '+08:00 按偏移换算成同一时刻',
    JSON.stringify(offset))

  const secondsOmitted = parseValidityTime('2026-10-24T18:30+08:00')
  ok(secondsOmitted.ok === true && secondsOmitted.ms === Date.UTC(2026, 9, 24, 10, 30, 0), '秒可以省略（规格两个形态都收）',
    JSON.stringify(secondsOmitted))

  const negative = parseValidityTime('2026-10-24T06:30:00-04:00')
  ok(negative.ok === true && negative.ms === Date.UTC(2026, 9, 24, 10, 30, 0), '负偏移也认',
    JSON.stringify(negative))

  // 这条最容易变成静默事故：裁决入口写 `new Date().toISOString()`，天然带 `.000Z`。
  // 拒掉小数秒 = 宿主自己写的时间自己认不出 = 失效标记静默不生效（注释在 validity.js）。
  const fractional = parseValidityTime('2026-10-24T18:30:00.000+08:00')
  ok(fractional.ok === true && fractional.ms === Date.UTC(2026, 9, 24, 10, 30, 0),
    '宿主 toISOString() 的小数秒（.000）也认 —— 否则失效标记会静默不生效', JSON.stringify(fractional))
  ok(parseValidityTime('2026-10-24T10:30:00.1Z').ok === true &&
    parseValidityTime('2026-10-24T10:30:00.12Z').ok === true &&
    parseValidityTime('2026-10-24T10:30:00.123Z').ok === true,
    '1–3 位小数秒都认（更长的不管：不是 isostring 的产物，也不该猜）')

  const empty = parseValidityTime('')
  ok(empty.ok === false && empty.ms === null, '空串 → ok:false、ms:null（不是 0 / 不是 epoch）', JSON.stringify(empty))
  ok(parseValidityTime(undefined).ok === false && parseValidityTime(null).ok === false &&
    parseValidityTime(123).ok === false && parseValidityTime({}).ok === false,
    '非字符串 / 缺失 → ok:false（不把数字当时刻猜）')

  // 下面几种 Date.parse 其实都「能认」，但都不是规范格式：拒掉不是挑剔，是为了不让
  // 「哪一天」这种语义受本地时区影响（裸日期会被按本地时区解释，跨时区差一天）。
  ok(parseValidityTime('2026-10-24').ok === false, '裸日期（无时刻无偏移）→ 认不出，不按本地时区猜')
  ok(parseValidityTime('2026-10-24T18:30:00').ok === false, '缺时区偏移 → 认不出（时刻依赖时区就没有确定语义）')
  ok(parseValidityTime('2026-10-24 18:30:00+08:00').ok === false, '空格代替 T → 认不出（规格是 ISO 8601）')
  ok(parseValidityTime('2026-13-01T00:00:00Z').ok === false, '月份越界 → Date.parse 有限性那道闸拦下')
  ok(parseValidityTime('明天下午').ok === false, '胡话 → 认不出')
  ok(parseValidityTime('2026-10-24T10:30:00z').ok === false, '小写 z 也不认（格式从严，认不出就不猜）')

  const first = parseValidityTime('2026-10-24T18:30:00+08:00')
  const again = parseValidityTime('2026-10-24T18:30:00+08:00')
  ok(first.ok === again.ok && first.ms === again.ms, '同一输入两次结果相同（纯函数，不读时钟）')
}

const NOW = Date.parse('2026-10-24T12:00:00Z')

group('3. isExpired / describeValidity：失效判定只看 invalid_at 与传入的 nowMs')
{
  const past = { file: 'a.md', invalidAt: '2026-10-24T11:59:59Z' }
  ok(isExpired(past, NOW) === true, 'invalid_at 在过去 → 失效')
  ok(describeValidity(past, NOW).expired === true && describeValidity(past, NOW).pendingFuture === false,
    'describeValidity：过去 → expired:true、pendingFuture:false')

  const boundary = { file: 'b.md', invalidAt: '2026-10-24T12:00:00Z' }
  ok(isExpired(boundary, NOW) === true, 'invalid_at 恰好等于 nowMs → 到点即失效（<= 边界）')
  ok(isExpired(boundary, NOW - 1) === false, '【反向对照】比 nowMs 晚 1ms → 还没到点，不失效')

  const future = { file: 'c.md', invalidAt: '2026-10-25T12:00:00Z' }
  ok(isExpired(future, NOW) === false, '未来 invalid_at → 暂不失效')
  ok(describeValidity(future, NOW).pendingFuture === true && describeValidity(future, NOW).expired === false,
    '【反向对照】未来时间 → pendingFuture:true（审计要提示、注入不能动手）')

  const bad = { file: 'd.md', invalidAt: '2026-13-40T99:99:99Z' }
  ok(isExpired(bad, NOW) === false && describeValidity(bad, NOW).expired === false &&
    describeValidity(bad, NOW).pendingFuture === false,
    '【反向对照】坏格式按未标注：既不失效、也不算「未来待生效」', JSON.stringify(describeValidity(bad, NOW)))

  const missing = { file: 'e.md' }
  ok(isExpired(missing, NOW) === false && describeValidity(missing, NOW).invalidAt === '',
    '字段缺失 → 不失效、describeValidity 的 invalidAt 是空串（R1）')

  // R4：`updated` / `valid_at` 与失效判定互不推导 —— 只有 valid_at 的记忆不该被当成过期。
  const onlyValidAt = { file: 'f.md', validAt: '2020-01-01T00:00:00Z', updated: '2020-01-01' }
  ok(isExpired(onlyValidAt, NOW) === false, '【反向对照】只有 valid_at（且很旧）也不失效 —— 与 invalid_at 互不推导')

  ok(isExpired(future, Number.NaN) === false && isExpired(future, undefined) === false,
    'nowMs 非法 → 一律不失效（宁可多注入一轮，不可凭坏时钟藏记忆）')

  const view = describeValidity(
    { file: 'g.md', invalidAt: '2026-10-24T18:30:00+08:00', supersededBy: 'project_beta.md' },
    NOW,
  )
  ok(view.invalidAt === '2026-10-24T18:30:00+08:00' && view.supersededBy === 'project_beta.md',
    'describeValidity 原样返回时间字符串（不换算 UTC，面板要显示用户写的时区）',
    JSON.stringify(view))
  const emptyView = describeValidity(null, NOW)
  ok(emptyView.invalidAt === '' && emptyView.supersededBy === '' && emptyView.expired === false &&
    emptyView.pendingFuture === false,
    'describeValidity(空 record) 不崩，四项都是「未知 / 有效」')
  ok(Object.keys(emptyView).sort().join(',') === 'expired,invalidAt,pendingFuture,supersededBy',
    'describeValidity 的返回面恰好是约定的四个键', Object.keys(emptyView).join(','))
}

group('4. buildExpirySet：files → 失效文件名集合（R1 / R3）')
{
  const files = [
    { file: 'project_past.md', invalidAt: '2026-10-24T11:00:00Z' },
    { file: 'project_equal.md', invalidAt: '2026-10-24T12:00:00Z' },
    { file: 'project_future.md', invalidAt: '2026-10-25T00:00:00Z' },
    { file: 'project_bad.md', invalidAt: '不是时间' },
    { file: 'project_plain.md' },
    { file: 'project_valid_only.md', validAt: '2020-01-01T00:00:00Z' },
  ]
  const set = buildExpirySet(files, NOW)
  ok(set instanceof Set, '返回的是 Set')
  ok(set.has('project_past.md') && set.has('project_equal.md'), '过去的与恰好到点的都进集合')
  ok(!set.has('project_future.md'), '【反向对照】未来 invalid_at 不进集合（暂不失效）')
  ok(!set.has('project_bad.md'), '【反向对照】坏格式不进集合（按未标注处理）')
  ok(!set.has('project_plain.md') && !set.has('project_valid_only.md'),
    '【反向对照】未标注 / 只有 valid_at 的不进集合（老行为：有效）', JSON.stringify([...set]))
  ok([...set].every((n) => !n.includes('/') && !n.includes('\\')),
    '集合里是文件名而不是路径（注入链按文件名对账）', JSON.stringify([...set]))

  ok(buildExpirySet([], NOW).size === 0, '空数组 → 空集合')
  ok(buildExpirySet(null, NOW).size === 0 && buildExpirySet(undefined, NOW).size === 0,
    '非数组 → 空集合（不抛）')
  ok(buildExpirySet([{ invalidAt: '2026-10-24T11:00:00Z' }, null, {}], NOW).size === 0,
    '缺 file 字段 / 空元素 → 跳过而不是拼一个空文件名')

  // 反向对照的终极形态：一个**没有任何标注**的老库 → 空集 → 注入链行为与 1.9.2 逐字相同。
  const legacy = [{ file: 'user_a.md' }, { file: 'project_b.md', updated: '2025-01-01' }]
  ok(buildExpirySet(legacy, NOW).size === 0, '【反向对照】老库（三字段全缺）→ 空集 = 零迁移')
}

group('5. buildContradictionFileSet：只收 open 的矛盾型（§6.3）')
{
  const records = [
    { kind: 'contradiction', status: 'open', file: 'project_old.md', otherFile: 'project_new.md' },
    { kind: 'stale_version', status: 'open', file: 'project_stale.md' },
    { kind: 'external_change', status: 'open', file: 'project_external.md' },
    { kind: 'contradiction', status: 'resolved', file: 'project_resolved.md', otherFile: 'project_winner.md' },
    { kind: 'contradiction', status: 'dismissed', file: 'project_dismissed.md' },
    { kind: 'contradiction', status: 'open', file: 'project_solo.md', otherFile: '' },
  ]
  const set = buildContradictionFileSet(records)
  ok(set.has('project_old.md') && set.has('project_new.md'), 'open 的矛盾型：两方（file 与 otherFile）都进集合')
  ok(!set.has('project_stale.md'), '【反向对照】stale_version 的 open 记录不进集合（盘上那份才是现行的，见 D27）')
  ok(!set.has('project_external.md'), '【反向对照】external_change 不进集合（那是「没读过」，不是「不可信」）')
  ok(!set.has('project_resolved.md') && !set.has('project_winner.md') && !set.has('project_dismissed.md'),
    '【反向对照】已裁决 / 已驳回的记录不进集合（抑制只针对未裁决）', JSON.stringify([...set]))
  ok(set.has('project_solo.md') && !set.has(''), 'otherFile 缺省 / 空串 → 只收 file，不塞一个空文件名',
    JSON.stringify([...set]))
  ok(set.size === 3, '集合大小与预期一致（3 个文件名）', `${set.size}: ${[...set].join(',')}`)

  ok(buildContradictionFileSet([]).size === 0, '空数组 → 空集合')
  ok(buildContradictionFileSet(null).size === 0 && buildContradictionFileSet({ records: [] }).size === 0,
    '非数组 → 空集合（不猜 {records} 这种包装形状）')
  const dupes = buildContradictionFileSet([
    { kind: 'contradiction', status: 'open', file: 'a.md', otherFile: 'b.md' },
    { kind: 'contradiction', status: 'open', file: 'a.md', otherFile: 'c.md' },
  ])
  ok(dupes.size === 3 && dupes.has('b.md') && dupes.has('c.md'), '同一文件出现在两条记录里 → Set 去重，另一方的名字都在')

  // 老记录（没有 otherFile / kind）不制造抑制 —— 与 1.9.2 行为一致。
  const legacy = [{ kind: 'stale_version', status: 'open', file: 'project_a.md' }, { status: 'open', file: 'project_b.md' }]
  ok(buildContradictionFileSet(legacy).size === 0, '【反向对照】老记录（无 kind / 非矛盾型）→ 空集 = 不抑制')
}

group('6. scan：文件记录带出三字段（缺失 = 空串）')
{
  const dir = join(world, 'scan-memory')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'project_labelled.md'), memo([
    'name: labelled',
    'type: project',
    'valid_at: 2026-09-01T08:00:00+08:00',
    'invalid_at: 2026-10-24T11:00:00Z',
    'superseded_by: project_newer.md',
  ]), 'utf8')
  // CRLF 夹具：三字段必须照常带出，而不是因为换行风格变成空串。
  await writeFile(join(dir, 'project_crlf.md'),
    '---\r\nname: crlf\r\ntype: project\r\ninvalid_at: 2026-10-25T00:00:00Z\r\n---\r\n\r\n正文\r\n', 'utf8')
  await writeFile(join(dir, 'project_plain.md'), memo(['name: plain', 'type: project']), 'utf8')

  const files = await scan.scanMemoryDir({}, '', dir)
  const byName = new Map(files.map((f) => [f.file, f]))
  const labelled = byName.get('project_labelled.md')
  const crlf = byName.get('project_crlf.md')
  const plain = byName.get('project_plain.md')

  ok(labelled?.validAt === '2026-09-01T08:00:00+08:00' && labelled?.invalidAt === '2026-10-24T11:00:00Z' &&
    labelled?.supersededBy === 'project_newer.md',
    'scan 记录带出 validAt / invalidAt / supersededBy（形状只在这里组装一次）',
    JSON.stringify(labelled && [labelled.validAt, labelled.invalidAt, labelled.supersededBy]))
  ok(crlf?.invalidAt === '2026-10-25T00:00:00Z', '【反向对照】CRLF 文件的 invalidAt 也照常带出（不是空串）',
    JSON.stringify(crlf?.invalidAt))
  ok(plain?.validAt === '' && plain?.invalidAt === '' && plain?.supersededBy === '',
    '【反向对照】未标注文件的三字段是空串（老记录与 1.9.2 逐字相同）',
    JSON.stringify(plain && [plain.validAt, plain.invalidAt, plain.supersededBy]))

  // 集成：scan 记录直接喂集合函数，过期的那个被挑出来、其余不误伤。
  const expired = buildExpirySet(files, NOW)
  ok(expired.has('project_labelled.md') && !expired.has('project_crlf.md') && !expired.has('project_plain.md'),
    'scan 记录 → 失效集合：只挑出已到点的那个', JSON.stringify([...expired]))
}

group('7. audit：坏标注进「提示」、不进 problems（R2 / R3 / R6）')
{
  const dir = join(world, 'audit-memory')
  await mkdir(dir, { recursive: true })
  // 两个文件从始至终都在（不增不减），这样前后对 problems 的比较只反映 frontmatter 的变化。
  const subject = join(dir, 'project_subject.md')
  const target = join(dir, 'project_target.md')
  await writeFile(target, memo(['name: target', 'type: project']), 'utf8')
  const writeSubject = (lines) => writeFile(subject, memo(['name: subject', 'type: project', ...lines]), 'utf8')
  const audit = (nowMs) => auditMemoryDir(dir, { nowMs })
  const hintsOf = (rep) => rep.validityHints ?? []

  await writeSubject(['invalid_at: 2026-10-01T00:00:00Z'])
  const base = await audit(NOW)
  ok(Array.isArray(base.validityHints) && hintsOf(base).length === 0,
    '【反向对照】标注合法 → 没有任何有效性提示', JSON.stringify(hintsOf(base)))

  await writeSubject(['invalid_at: 下个月再说'])
  const bad = await audit(NOW)
  ok(hintsOf(bad).length === 1 && hintsOf(bad)[0].file === 'project_subject.md' &&
    hintsOf(bad)[0].field === 'invalid_at' && hintsOf(bad)[0].reason === 'bad_format',
    '坏格式 → 一条 bad_format 提示，点名文件与字段', JSON.stringify(hintsOf(bad)))
  ok(bad.problems === base.problems,
    '【反向对照】坏标注只进提示、不抬高 problems（problems 是唯一健康数字，issue #8）',
    `${base.problems} → ${bad.problems}`)
  ok(Object.keys(hintsOf(bad)[0]).sort().join(',') === 'field,file,reason',
    '提示条目恰好三个键 {file, field, reason}（typert 契约面）', Object.keys(hintsOf(bad)[0]).join(','))

  await writeSubject(['invalid_at: 2099-01-01T00:00:00Z'])
  const future = await audit(NOW)
  ok(hintsOf(future).some((h) => h.field === 'invalid_at' && h.reason === 'future'),
    '未来 invalid_at → future 提示（暂不失效）', JSON.stringify(hintsOf(future)))
  ok(future.problems === base.problems, '【反向对照】未来时间同样不抬高 problems', `${base.problems} → ${future.problems}`)
  // 不传 nowMs 时按当下判断：2099 年无论如何都在未来 —— 这条守住默认时钟路径。
  const futureDefault = await auditMemoryDir(dir)
  ok(hintsOf(futureDefault).some((h) => h.reason === 'future'), '不传 nowMs 时用当下判断，未来时间仍报 future')
  // 到点之后再审计：同一条字段不再报 future（提示跟着时钟走，不是恒定的噪声）。
  const after = await audit(Date.parse('2099-01-01T00:00:01Z'))
  ok(!hintsOf(after).some((h) => h.reason === 'future'), '【反向对照】时间到点之后不再报 future')

  await writeSubject(['invalid_at: 2026-10-01T00:00:00Z', 'superseded_by: project_missing.md'])
  const missing = await audit(NOW)
  ok(hintsOf(missing).some((h) => h.field === 'superseded_by' && h.reason === 'missing'),
    'superseded_by 指向本目录与归档区都不存在的文件 → missing 提示', JSON.stringify(hintsOf(missing)))

  await writeSubject(['invalid_at: 2026-10-01T00:00:00Z', 'superseded_by: project_target.md'])
  const resolved = await audit(NOW)
  ok(hintsOf(resolved).length === 0,
    '【反向对照】superseded_by 目标存在 → 不提示（R6 不做一致性校验）', JSON.stringify(hintsOf(resolved)))

  await writeSubject(['invalid_at: 2026-10-01T00:00:00Z', 'superseded_by: sub/project_target.md'])
  const pathy = await audit(NOW)
  ok(hintsOf(pathy).some((h) => h.field === 'superseded_by' && h.reason === 'bad_format'),
    'superseded_by 是路径而不是文件名 → bad_format（文件名判据复用 shared/md-name.js）',
    JSON.stringify(hintsOf(pathy)))

  // valid_at 在未来本身合法（说法尚未开始成立），本版没有「未开始就不注入」的语义，
  // 所以不提示 —— 提示只留给真的会改变行为的标注。
  await writeSubject(['valid_at: 2099-01-01T00:00:00Z'])
  const futureValid = await audit(NOW)
  ok(hintsOf(futureValid).length === 0, '【反向对照】valid_at 在未来不提示（本版不据此抑制）',
    JSON.stringify(hintsOf(futureValid)))

  // 给模型看的文本：提示独立成节并写明「不计入问题」，否则模型会去「修」一个可选字段。
  await writeSubject(['invalid_at: 下个月再说'])
  const forModel = formatAudit(await audit(NOW))
  ok(forModel.includes('有效性标注提示（提示，不计入问题）'), 'formatAudit 把有效性提示单列成节（写明清零口径）')
  ok(forModel.includes('project_subject.md') && forModel.includes('invalid_at'),
    'formatAudit 的提示行点名文件与字段', forModel.split('\n').find((l) => l.includes('project_subject.md')))
}

group('8. 零回归：没有任何标注时不产生任何抑制输入')
{
  // 注入链在 2.0.0 之前传的是两个硬编码空集；这一组证明「老库 → 传出去仍是空集」。
  const files = [
    { file: 'user_a.md', updated: '2026-01-01' },
    { file: 'feedback_b.md', description: 'x' },
  ]
  ok(buildExpirySet(files, NOW).size === 0 && buildContradictionFileSet([]).size === 0,
    '【反向对照】老库 + 无冲突记录 → 两个集合都为空（行为与 1.9.2 逐字相同）')
}

await rm(world, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
