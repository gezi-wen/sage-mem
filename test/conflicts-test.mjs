#!/usr/bin/env node
/**
 * conflicts.js 的断言（2026-10-15 建）—— 冲突队列：落记录、读、列、标状态、删。
 *
 * 本套件要**在系统临时目录里真写文件**（原子写往返、坏文件、整份记录截断、并发写、
 * IO 失败路径），而且要把「用户内容不许进日志」当成断言 —— 所以它单开一个文件。
 *
 * 四组反向对照（只测「会报错」是不够的）：
 *   · 坏 JSON → malformed 不抛 ↔ 正常记录往返逐字相同；
 *   · 坏文件只进 broken 而其余照列 ↔ 没有坏文件时 broken 为空；
 *   · 按字节截断超限 ↔ 没超限时 truncated 为 false；
 *   · 状态机禁止的迁移被拒（且磁盘不动）↔ 允许的迁移都成功且落盘。
 *
 * 三个前提：
 *   1. `STATE_ROOT` 是**模块顶层**读的环境变量 —— 必须在动态 import **之前**指到临时目录，
 *      这样「不传 stateRoot」的降级路径也只落在沙箱里（静态 import 会被提升，用不得）；
 *   2. 只碰 mkdtemp 出来的临时目录，不碰任何真实记忆 / 状态目录；
 *   3. 夹具一律合成：本仓库是公开仓库，不许出现真实记忆内容或本机绝对路径。
 *
 * 用法: node test/conflicts-test.mjs
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ── 沙箱：环境变量必须在 import 之前 ─────────────────────────
const world = await mkdtemp(join(tmpdir(), 'sage-mem-conflicts-'))
const defaultRoot = join(world, 'default-state')
process.env.SAGE_MEM_STATE_DIR = defaultRoot
process.env.SAGE_MEM_DIR = join(world, 'default-memory')

const {
  CONFLICT_FIELD_LIMITS,
  CONFLICT_FILE_SUFFIX,
  CONFLICT_KINDS,
  CONFLICT_MAX_BYTES,
  CONFLICT_STATUSES,
  CONFLICT_TRANSITIONS,
  CONFLICTS_DIR_NAME,
  buildConflict,
  listConflicts,
  normalizeConflictId,
  readConflict,
  removeConflict,
  resolveConflict,
  writeConflict,
} = await import(new URL('../lib/memory/conflicts.js', import.meta.url).href)

const dirOf = (root) => join(root, CONFLICTS_DIR_NAME)
const pathOf = (root, id) => join(dirOf(root), `${id}${CONFLICT_FILE_SUFFIX}`)

/**
 * **硬编码**的状态机期望（冻结契约的原文），不从 `CONFLICT_TRANSITIONS` 读。
 *
 * 为什么必须这样：下面 3×3 的循环如果拿导出表当期望，「实现改了表、测试跟着改」，
 * 那个循环就退化成「原地打转」—— 变异验证时正是这么漏掉一条的。期望写在测试里才叫断言。
 */
const EXPECTED_TRANSITIONS = {
  open: ['resolved', 'dismissed'],
  resolved: ['dismissed'],
  dismissed: ['resolved'],
}

const AT = '2026-10-15T19:47:54.000Z'
/** 合成冲突输入：全部字段都是合成文本。 */
const base = (extra = {}) => ({
  kind: 'stale_version',
  file: 'project_alpha.md',
  expectedVersion: 'sha256:111111111111',
  actualVersion: 'sha256:222222222222',
  incoming: '# 合成正文（我的版本）\n这一行是我的改动。',
  onDisk: '# 合成正文（磁盘上的版本）\n这一行是别人先写下的改动。',
  note: '合成说明：两个写入者碰到同一份记忆',
  tool: 'write_memory',
  at: AT,
  ...extra,
})

// ────────────────────────── 1. 冻结常量与状态机表 ──────────────────────────

console.log('== 1. 冻结常量 / 状态机表 ==')
ok(CONFLICTS_DIR_NAME === 'conflicts' && CONFLICT_FILE_SUFFIX === '.json', '目录名与后缀取冻结值')
ok(CONFLICT_MAX_BYTES === 256 * 1024, `整份记录上限 256 KB（实际 ${CONFLICT_MAX_BYTES}）`)
ok(
  Object.isFrozen(CONFLICT_KINDS) &&
    JSON.stringify(CONFLICT_KINDS) === JSON.stringify(['stale_version', 'external_change', 'unresolved_merge', 'contradiction']),
  'CONFLICT_KINDS 冻结且取值正确（2.0.0 追加矛盾型，写失败型三条仍在）',
  JSON.stringify(CONFLICT_KINDS),
)
ok(
  Object.isFrozen(CONFLICT_STATUSES) &&
    JSON.stringify(CONFLICT_STATUSES) === JSON.stringify(['open', 'resolved', 'dismissed']),
  'CONFLICT_STATUSES 冻结且取值正确',
  JSON.stringify(CONFLICT_STATUSES),
)
ok(
  Object.isFrozen(CONFLICT_TRANSITIONS) &&
    CONFLICT_STATUSES.every((s) => Array.isArray(CONFLICT_TRANSITIONS[s]) && Object.isFrozen(CONFLICT_TRANSITIONS[s])),
  'CONFLICT_TRANSITIONS 是冻结的数据表（每个状态一条出边列表）',
)
ok(
  JSON.stringify(CONFLICT_TRANSITIONS) === JSON.stringify(EXPECTED_TRANSITIONS),
  '导出表逐字等于冻结契约（期望写在测试里，不是拿导出表当期望）',
  JSON.stringify(CONFLICT_TRANSITIONS),
)
ok(
  JSON.stringify(CONFLICT_TRANSITIONS.open) === JSON.stringify(['resolved', 'dismissed']),
  'open 只能去 resolved / dismissed',
  JSON.stringify(CONFLICT_TRANSITIONS.open),
)
ok(
  !CONFLICT_TRANSITIONS.resolved.includes('open') && !CONFLICT_TRANSITIONS.dismissed.includes('open'),
  '**没有**任何一条边回到 open（要重开就新建一条）',
)
ok(
  CONFLICT_TRANSITIONS.resolved.includes('dismissed') && CONFLICT_TRANSITIONS.dismissed.includes('resolved'),
  'resolved ↔ dismissed 互通',
)
ok(
  Object.isFrozen(CONFLICT_FIELD_LIMITS) &&
    CONFLICT_FIELD_LIMITS.incoming === 48 * 1024 &&
    CONFLICT_FIELD_LIMITS.onDisk === 48 * 1024,
  `两个正文字段各有 48 KB 的单字段上限（实际 ${CONFLICT_FIELD_LIMITS.incoming}）`,
)
ok(
  CONFLICT_FIELD_LIMITS.file < CONFLICT_FIELD_LIMITS.incoming &&
    CONFLICT_FIELD_LIMITS.note < CONFLICT_FIELD_LIMITS.incoming &&
    CONFLICT_FIELD_LIMITS.tool < CONFLICT_FIELD_LIMITS.note,
  '小字段的上限逐级更小（路径 < 说明 < 工具名）',
  JSON.stringify(CONFLICT_FIELD_LIMITS),
)

// ────────────────────────── 2. normalizeConflictId ──────────────────────────

console.log('== 2. normalizeConflictId：单段字符类，判据与平台无关 ==')
for (const good of ['c1', '20261015T194754Z-a1b2c3d4', 'a', '0', '---', 'x'.repeat(64), 'con-x', 'com0', 'com10']) {
  ok(normalizeConflictId(good) === good, `合法 id 原样通过：${JSON.stringify(good)}`)
}
for (const bad of ['', ' ', '../x', '..', '.', './a', 'a/', '/a', 'a/b', 'a\\b', '..\\x', 'a:b', 'a.', '.a', 'a.b', 'a b', 'a\tb', 'a\nb', '汉字', 'x'.repeat(65)]) {
  ok(normalizeConflictId(bad) === null, `非法 id 返回 null：${JSON.stringify(bad)}`)
}
for (const bad of [42, null, undefined, true, [], {}, () => {}]) {
  ok(normalizeConflictId(bad) === null, `非字符串一律 null：${String(bad)}`)
}
for (const reserved of ['con', 'CON', 'Prn', 'aux', 'nul', 'com1', 'COM9', 'lpt1', 'LPT9']) {
  ok(
    normalizeConflictId(reserved) === null,
    `Windows 保留设备名被拒：${reserved}（conflicts/${reserved}.json 在这个平台上建不出来）`,
  )
}
ok(
  normalizeConflictId('a\\b') === null &&
    normalizeConflictId('a/b') === null &&
    normalizeConflictId('a\\b') === normalizeConflictId('a/b'),
  '`\\` 与 `/` 判成同一结果：字符类判定不走 basename —— Windows 当分隔符、Linux 不当，结论必须一致',
)
ok(normalizeConflictId('a.') === null && normalizeConflictId('.a') === null, '尾随点与点号开头都被拒（字符集里根本没有 `.`）')
ok(normalizeConflictId(' x ') === null, '不 trim：两端的空格在 Windows 会被静默裁掉、Linux 不会，帮忙归一化=造出平台差异')

// ────────────────────────── 3. buildConflict：纯函数 ──────────────────────────

console.log('== 3. buildConflict：同输入两次结果一致、不落盘、不读时钟 ==')
const recA = buildConflict(base())
const recB = buildConflict(base())
ok(JSON.stringify(recA) === JSON.stringify(recB), '同输入两次 → 逐字相同（含 id 与 at）')
ok(recA.id === recB.id, `同一条冲突重复上报 → id 相同（队列里不会长重复项，实际 ${recA.id}）`)
ok(
  /^20261015T194754Z-[0-9a-f]{8}$/.test(recA.id),
  'id = 紧凑时间戳 + 内容指纹（接口注释写「短随机」，这里换成指纹：随机数会让上面那条不成立）',
  recA.id,
)
ok(buildConflict(base({ incoming: '换一段正文' })).id !== recA.id, '正文不同 → id 不同')
ok(buildConflict(base({ file: 'project_beta.md' })).id !== recA.id, '文件不同 → id 不同')
ok(buildConflict(base({ note: '换一句说明' })).id === recA.id, '换 `note` 不换 id（说明是「谁碰上的」，不是冲突本身）')
ok(
  JSON.stringify(Object.keys(recA)) ===
    JSON.stringify([
      'v',
      'id',
      'kind',
      'status',
      'file',
      'expectedVersion',
      'actualVersion',
      'at',
      'incoming',
      'onDisk',
      'note',
      'tool',
      'truncated',
      // 2.0.0 追加：只增不改、`v` 仍是 1 —— 1.9.x 读端只认 id 与非空 status，多出的键被忽略。
      'otherFile',
      'decision',
      'decidedAt',
      'appliedVersion',
      'invalidatedFile',
    ]),
  '字段与顺序都按冻结契约（2.0.0 的 5 个新字段必须**尾部追加**）',
  JSON.stringify(Object.keys(recA)),
)
ok(recA.v === 1 && recA.status === 'open' && recA.truncated === false, 'v=1 / status=open / truncated=false')
ok(
  recA.file === base().file && recA.expectedVersion === base().expectedVersion && recA.actualVersion === base().actualVersion,
  '文件与两个版本号原样带进记录',
)
ok(
  recA.incoming === base().incoming && recA.onDisk === base().onDisk && recA.note === base().note && recA.tool === base().tool,
  '两个正文与说明 / 工具名原样带进记录',
)
{
  const noAt = buildConflict(base({ at: undefined }))
  ok(noAt.at === '' && /^[0-9a-f]{8}$/.test(noAt.id), '不给 at → at 为空串、id 没有时间戳前缀（不自己读时钟）')
  ok(buildConflict(base({ at: '昨天下午' })).at === '', '认不出的 at → 空串（不编一个时间）')
  ok(buildConflict(base({ id: 'manual-1' })).id === 'manual-1', '显式给的合法 id 优先')
  ok(/^20261015T194754Z-[0-9a-f]{8}$/.test(buildConflict(base({ id: '../x' })).id), '显式 id 非法 → 回落到内容指纹（时间戳前缀照旧），不抛')
}
{
  const fresh = join(world, 'pure-root')
  buildConflict(base())
  const code = await readdir(join(fresh, CONFLICTS_DIR_NAME)).catch((e) => e.code)
  ok(code === 'ENOENT', 'buildConflict 不落盘（连目录都没建）', String(code))
}
ok(
  buildConflict(null).status === 'open' && buildConflict(undefined).status === 'open' && buildConflict('字符串').status === 'open',
  '入参为 null / undefined / 字符串都不抛，仍回一条 open 记录',
)
ok(buildConflict({ kind: 'weird_kind' }).kind === 'weird_kind', '不认识的 kind 原样保留（不把「未知」伪装成「已知」）')
ok(buildConflict({ kind: 42 }).kind === '', 'kind 非字符串 → 空串')
ok(buildConflict({ incoming: { a: 1 } }).incoming === '', '正文字段不是字符串 → 空串（不去猜一个对象的内容）')
ok(
  buildConflict({ expectedVersion: 42 }).expectedVersion === '42' && buildConflict({ expectedVersion: null }).expectedVersion === '',
  '版本号一律当字符串；null 是「没有」不是 "null"',
)

// ────────────────────────── 4. 单字段按字节截断 ──────────────────────────

console.log('== 4. 单字段截断：按字节、码点边界、置 truncated ==')
{
  const long = '汉'.repeat(60000) // 180000 字节，远超 48 KB
  const rec = buildConflict(base({ incoming: long, onDisk: '短正文' }))
  ok(rec.truncated === true, '超限的字段被截断 → truncated: true')
  ok(
    Buffer.byteLength(rec.incoming, 'utf8') <= CONFLICT_FIELD_LIMITS.incoming,
    `截断后 ≤ 单字段上限 ${CONFLICT_FIELD_LIMITS.incoming} 字节（实际 ${Buffer.byteLength(rec.incoming, 'utf8')}）`,
  )
  ok(!rec.incoming.includes('\uFFFD'), '按码点截断：没有留下半个汉字')
  ok(rec.incoming.length > 0 && long.startsWith(rec.incoming), '保留的是**头部**（前缀），不是尾部')
  ok(rec.onDisk === '短正文', '没超限的字段不动')

  const short = buildConflict(base())
  ok(short.truncated === false && short.incoming === base().incoming, '都没超限 → truncated: false（反向对照）')

  const longFile = buildConflict(base({ file: 'p'.repeat(5000) }))
  ok(
    Buffer.byteLength(longFile.file, 'utf8') <= CONFLICT_FIELD_LIMITS.file && longFile.truncated === true,
    '路径字段也照单字段上限截断（5000 字节 → ≤1024）',
  )

  // 四字节字符（代理对）：按字节卡 + 按**码点**截 —— `slice` 会把代理对切成半个
  const astral = '𠀀'.repeat(60000) // U+20000，每个 4 字节 = 240000 字节
  const recAstral = buildConflict(base({ onDisk: astral }))
  ok(
    Buffer.byteLength(recAstral.onDisk, 'utf8') <= CONFLICT_FIELD_LIMITS.onDisk,
    `四字节字符同样按字节卡住（实际 ${Buffer.byteLength(recAstral.onDisk, 'utf8')} 字节）`,
  )
  ok(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(recAstral.onDisk),
    '没有留下半个代理对（截断落在码点边界上）',
  )
  ok(astral.startsWith(recAstral.onDisk), '四字节字符截断后仍是原文前缀')
}

// ────────────────────────── 5. 落盘 / 读回往返 ──────────────────────────

console.log('== 5. writeConflict / readConflict：真落盘、逐字往返 ==')
const rootA = join(world, 'state-a')
const rec1 = buildConflict(base())
{
  const w = await writeConflict(rec1, { stateRoot: rootA })
  ok(w.ok === true && w.path === pathOf(rootA, rec1.id) && w.truncated === false, '写成功并回报路径与 truncated', JSON.stringify(w))
  ok(w.bytes === Buffer.byteLength(await readFile(w.path, 'utf8'), 'utf8'), 'bytes 与磁盘上的字节数一致')
  const names = await readdir(dirOf(rootA))
  ok(
    JSON.stringify(names) === JSON.stringify([`${rec1.id}${CONFLICT_FILE_SUFFIX}`]),
    '目录里只有这一个文件（原子写没留 .tmp 垃圾）',
    JSON.stringify(names),
  )

  const r = await readConflict(rec1.id, { stateRoot: rootA })
  ok(r.ok === true && r.bytes === w.bytes && r.warnings.length === 0, '读回成功、无警告', JSON.stringify({ ok: r.ok, warn: r.warnings }))
  ok(JSON.stringify(r.record) === JSON.stringify(rec1), '读回的记录与写进去的逐字相同', JSON.stringify(r.record))
  ok(r.record.status === 'open', '新记录是 open')

  // 不传 stateRoot 时回落到 config.js 的 STATE_ROOT —— 本套件已把它指到临时目录
  const def = await writeConflict(buildConflict(base({ incoming: '走默认状态根的那条' })))
  ok(
    def.ok === true && def.path === pathOf(defaultRoot, JSON.parse(await readFile(def.path, 'utf8')).id),
    '不传 stateRoot → 用 STATE_ROOT（降级路径可用，且只落在沙箱里）',
    JSON.stringify(def.path),
  )
}

// ────────────────────────── 6. 整份记录截断（256 KB）──────────────────────────

console.log('== 6. 整份记录超上限：削正文而不是拒收 ==')
const rootB = join(world, 'state-b')
{
  const huge = 'x'.repeat(300 * 1024) // 300 KB 单字段（ASCII：JSON 转义不膨胀）
  const big = { ...buildConflict(base()), onDisk: huge, truncated: false }
  const w = await writeConflict(big, { stateRoot: rootB })
  ok(
    w.ok === true && w.truncated === true && w.bytes <= CONFLICT_MAX_BYTES,
    `削完正文后落盘 ≤ ${CONFLICT_MAX_BYTES} 字节（实际 ${w.bytes}）`,
    JSON.stringify(w),
  )
  const r = await readConflict(big.id, { stateRoot: rootB })
  ok(
    r.ok === true && r.record.truncated === true && r.record.onDisk.length < huge.length && huge.startsWith(r.record.onDisk),
    '读回：正文被削短、仍是原文前缀、truncated 持久化',
  )
  ok(r.record.incoming === base().incoming, '削的是撑爆预算的那份（onDisk），短的那份 incoming 没被牵连')
}
{
  const hugeZh = '汉'.repeat(200000) // 600000 字节
  const big = { ...buildConflict(base()), onDisk: hugeZh, truncated: false }
  const w = await writeConflict(big, { stateRoot: rootB })
  const text = await readFile(w.path, 'utf8')
  ok(w.ok === true && Buffer.byteLength(text, 'utf8') <= CONFLICT_MAX_BYTES, '中文超长记录同样削到上限内')
  ok(!text.includes('\uFFFD'), '整份记录的截断也在码点边界上（没有 U+FFFD）')
  const r = await readConflict(big.id, { stateRoot: rootB })
  ok(r.ok === true && r.record.onDisk.length > 0 && hugeZh.startsWith(r.record.onDisk), '削完的正文是原文前缀')
}
{
  // 「削完正文还放不下」只有一种可能：元信息本身畸形地大。这时报 too_big，且**什么都不写**
  const metaHuge = { id: 'meta-huge', status: 'open', kind: 'stale_version', file: 'y'.repeat(CONFLICT_MAX_BYTES + 1024) }
  const w = await writeConflict(metaHuge, { stateRoot: rootB })
  ok(w.ok === false && w.code === 'too_big' && w.limit === CONFLICT_MAX_BYTES, '元信息超限 → too_big（不写半份）', JSON.stringify(w))
  ok((await readConflict('meta-huge', { stateRoot: rootB })).code === 'missing', '被拒的那次什么都没落盘')
}

// ────────────────────────── 7. 状态机 ──────────────────────────

console.log('== 7. 状态机：允许的迁移落盘 / 禁止的迁移被拒且磁盘不动 ==')
const rootC = join(world, 'state-c')
{
  // 表驱动：3×3 全部组合逐条核对 resolveConflict 的判决与 CONFLICT_TRANSITIONS 一致
  let mismatched = null
  for (const from of CONFLICT_STATUSES) {
    for (const to of CONFLICT_STATUSES) {
      const id = `sm-${from}-${to}`
      await writeConflict({ ...buildConflict(base()), id, status: from }, { stateRoot: rootC })
      const r = await resolveConflict(id, to, { stateRoot: rootC })
      const expectOk = from === to || EXPECTED_TRANSITIONS[from].includes(to)
      const back = await readConflict(id, { stateRoot: rootC })
      if (r.ok !== expectOk) mismatched = `${from} → ${to}：期望 ok=${expectOk}，实际 ${JSON.stringify(r)}`
      else if (expectOk && (r.record.status !== to || !back.ok || back.record.status !== to)) {
        mismatched = `${from} → ${to}：落盘状态是 ${back.record?.status}`
      } else if (!expectOk && (r.code !== 'invalid_transition' || !back.ok || back.record.status !== from)) {
        mismatched = `${from} → ${to}：错误码 ${r.code}，落盘状态 ${back.record?.status}`
      }
    }
  }
  ok(mismatched === null, '3×3 全部组合都与 CONFLICT_TRANSITIONS 一致（含被拒时磁盘不动）', String(mismatched))
}
{
  const id = 'sm-idem'
  await writeConflict({ ...buildConflict(base()), id, status: 'open' }, { stateRoot: rootC })
  const before = await readFile(pathOf(rootC, id), 'utf8')
  const same = await resolveConflict(id, 'open', { stateRoot: rootC })
  ok(same.ok === true && same.record.status === 'open', 'open → open 幂等：不报错（界面上连点两下不该失败）')
  ok((await readFile(pathOf(rootC, id), 'utf8')) === before, '幂等那一次不重写文件')

  ok((await resolveConflict(id, 'archived', { stateRoot: rootC })).code === 'invalid', '未知状态 → invalid')
  ok((await resolveConflict('sm-not-there', 'resolved', { stateRoot: rootC })).code === 'missing', '不存在的记录 → missing')
  ok((await resolveConflict('../x', 'resolved', { stateRoot: rootC })).code === 'invalid', '非法 id → invalid')
  ok((await resolveConflict(42, 'resolved', { stateRoot: rootC })).code === 'invalid', '非字符串 id → invalid')
  await writeFile(pathOf(rootC, 'sm-broken'), '{ 这不是 JSON')
  ok((await resolveConflict('sm-broken', 'resolved', { stateRoot: rootC })).code === 'malformed', '坏记录 → malformed（不抛）')
}

// ────────────────────────── 8. listConflicts ──────────────────────────

console.log('== 8. listConflicts：坏文件只进 broken，不拖垮整张列表 ==')
const rootD = join(world, 'state-d')
{
  const empty = await listConflicts({ stateRoot: rootD })
  ok(
    empty.ok === true && empty.items.length === 0 && empty.broken.length === 0 && empty.ignored.length === 0,
    '还没发生过冲突（目录不存在）→ 空列表，不是错误',
    JSON.stringify(empty),
  )
  ok(empty.dir === dirOf(rootD), 'dir 回显状态根下的 conflicts 目录')

  const older = buildConflict(base({ at: '2026-10-14T10:00:00.000Z', incoming: '较早的那条' }))
  const newer = buildConflict(base({ at: '2026-10-15T10:00:00.000Z', incoming: '较新的那条' }))
  const noAt = buildConflict(base({ at: undefined, incoming: '没有时间的' }))
  await writeConflict(older, { stateRoot: rootD })
  await writeConflict(newer, { stateRoot: rootD })
  await writeConflict(noAt, { stateRoot: rootD })
  await writeFile(pathOf(rootD, 'c-broken'), '{ 坏掉的 JSON')
  await writeFile(join(dirOf(rootD), 'a.b.json'), '{"id":"a.b","status":"open"}') // 文件名不是合法 id
  await writeFile(join(dirOf(rootD), 'notes.txt'), '不是冲突文件')

  const list = await listConflicts({ stateRoot: rootD })
  // 用 `?? []` 读：列表若整体失败（ok:false），这些断言该**报 FAIL** 而不是让套件崩掉
  // （变异验证时踩到过：崩掉只留一个非零退出码，看不到是哪几条断言该红）。
  const listed = list.items ?? []
  ok(list.ok === true && listed.length === 3, '能读的三条照列（一个坏文件不影响其余）', JSON.stringify(listed.map((i) => i.id)))
  ok(
    JSON.stringify(list.broken ?? null) === JSON.stringify(['a.b.json', 'c-broken.json']),
    '坏文件进 broken（含「文件名不是合法 id」的那种）',
    JSON.stringify(list.broken),
  )
  ok(
    JSON.stringify(list.ignored ?? null) === JSON.stringify(['notes.txt']),
    '非 .json 文件进 ignored（报告出来，但不当成冲突）',
    JSON.stringify(list.ignored),
  )
  ok(
    JSON.stringify(listed.map((i) => i.id)) === JSON.stringify([newer.id, older.id, noAt.id]),
    '新的在前；没有 at 的排最后，同档按 id 排（顺序确定）',
    JSON.stringify(listed.map((i) => [i.id, i.at])),
  )
  ok(
    listed.length > 0 && Object.keys(listed[0]).length === 18 && !('path' in listed[0]),
    'items 里就是记录本身（没有塞进去的额外键；2.0.0 是 13 + 5 = 18 个字段）',
    JSON.stringify(listed.length > 0 ? Object.keys(listed[0]) : null),
  )
  ok(
    listed.every((i) => i.status === 'open'),
    '列出来的记录状态照原样',
  )

  await mkdir(join(dirOf(rootD), 'c-dir.json'))
  const withDir = await listConflicts({ stateRoot: rootD })
  ok(
    withDir.ok === true && (withDir.broken ?? []).includes('c-dir.json') && (withDir.items ?? []).length === 3,
    '目录冒充 .json → 进 broken，列表照常',
    JSON.stringify(withDir.broken),
  )
}
{
  // 文件名才是身份：文件里声明的 id 与文件名不一致 → 以文件名为准 + 警告（不静默采信标签）
  const mismatchId = 'c-mismatch'
  await writeFile(pathOf(rootD, mismatchId), JSON.stringify({ ...buildConflict(base()), id: 'other' }))
  const r = await readConflict(mismatchId, { stateRoot: rootD })
  ok(
    r.ok === true && r.record.id === mismatchId && r.warnings.length === 1,
    '声明 id 与文件名不一致 → 按文件名归一 + 一条警告',
    JSON.stringify(r.warnings),
  )
  const list = await listConflicts({ stateRoot: rootD })
  const listed = list.items ?? []
  ok(
    listed.every((i) => i.id !== 'other') && listed.some((i) => i.id === mismatchId),
    '列表里用的是文件名，不是文件里声明的那个',
  )
}

// ────────────────────────── 9. 坏文件 / 非法输入 / IO 失败：一律不抛 ──────────────────────────

console.log('== 9. 坏文件与 IO 失败：全部返回对象，绝不抛 ==')
const rootE = join(world, 'state-e')
{
  await mkdir(dirOf(rootE), { recursive: true })
  const badCases = [
    ['c-notjson', '{ 这不是 JSON'],
    ['c-array', '[1,2,3]'],
    ['c-emptyobj', '{}'],
    ['c-nostatus', '{"id":"c-nostatus"}'],
    ['c-badstatus', '{"id":"c-badstatus","status":"weird"}'],
    ['c-null', 'null'],
  ]
  for (const [id, text] of badCases) {
    await writeFile(pathOf(rootE, id), text)
    const r = await readConflict(id, { stateRoot: rootE })
    ok(
      r.ok === false && r.code === 'malformed' && typeof r.error === 'string' && r.error !== '' && !('record' in r),
      `坏记录 ${id} → malformed 带原因，且不交出 record`,
      JSON.stringify(r),
    )
  }
  ok((await readConflict('c-absent', { stateRoot: rootE })).code === 'missing', '不存在的记录 → missing')
  ok((await readConflict('../x', { stateRoot: rootE })).code === 'invalid', '非法 id → invalid（在 IO 之前）')
  ok((await readConflict(42, { stateRoot: rootE })).code === 'invalid', '非字符串 id → invalid')

  await mkdir(pathOf(rootE, 'c-isdir'))
  const ioRead = await readConflict('c-isdir', { stateRoot: rootE })
  ok(ioRead.ok === false && ioRead.code === 'io_error', '路径落在目录上（EISDIR）→ io_error，不误报 missing', JSON.stringify(ioRead))

  const badWrites = [null, undefined, [], '字符串', 42, { status: 'open' }, { id: '../x' }, { id: 'con' }, { id: '' }]
  let writeBad = null
  for (const rec of badWrites) {
    try {
      const r = await writeConflict(rec, { stateRoot: rootE })
      if (!r || typeof r.ok !== 'boolean' || r.ok !== false) writeBad = `${JSON.stringify(rec)} → ${JSON.stringify(r)}`
    } catch (err) {
      writeBad = `${JSON.stringify(rec)} → 抛了：${err?.message}`
    }
  }
  ok(writeBad === null, '一串畸形 / 非法 id 记录全部返回 {ok:false}、无异常', String(writeBad))
  ok(
    (await writeConflict({ id: 'ok-id', status: 'open' }, { stateRoot: rootE })).ok === true,
    '只带 id/status 的最小记录也写得进去（写路径不校验内容）',
  )
  const circular = { id: 'circular', status: 'open' }
  circular.self = circular
  const circ = await writeConflict(circular, { stateRoot: rootE })
  ok(circ.ok === false && circ.code === 'invalid', '循环引用的记录 → invalid（JSON.stringify 的异常被收住）', JSON.stringify(circ))

  const weirdOpts = [undefined, null, 0, '', [], {}, { stateRoot: 42 }, { stateRoot: null }]
  let optsBad = null
  for (const opts of weirdOpts) {
    for (const call of [
      () => readConflict('ok-id', opts),
      () => listConflicts(opts),
      () => resolveConflict('ok-id', 'resolved', opts),
      () => removeConflict('ok-id', opts),
    ]) {
      try {
        const r = await call()
        if (!r || typeof r.ok !== 'boolean') optsBad = `opts=${JSON.stringify(opts)} → 形状不对`
      } catch (err) {
        optsBad = `opts=${JSON.stringify(opts)} → 抛了：${err?.message}`
      }
    }
  }
  ok(optsBad === null, '八种畸形 opts × 四个 API 全部返回对象、无异常', String(optsBad))
}
{
  // 父路径被文件占住。**平台差异**：Linux 给 ENOTDIR → io_error；Windows 给 ENOENT →
  // 模块只能按契约报 missing（在 Windows 上「父目录是个文件」与「不存在」报同一个码）。
  // 所以这里只断言「不抛 + 是文档化的失败码」，io_error 本身由上面 EISDIR 那条覆盖。
  const rootF = join(world, 'state-f')
  await mkdir(rootF, { recursive: true })
  await writeFile(dirOf(rootF), 'x')
  const parentIsFile = (r) => r.ok === false && ['missing', 'io_error'].includes(r.code)
  const w = await writeConflict(buildConflict(base()), { stateRoot: rootF })
  ok(w.ok === false && w.code === 'io_error', 'conflicts 被文件占住 → 写 io_error（mkdir 的 ENOTDIR 两个平台一致）', JSON.stringify(w))
  ok((await listConflicts({ stateRoot: rootF })).code === 'io_error', '列目录 io_error（readdir 的 ENOTDIR 两个平台一致）')
  const rRead = await readConflict('c1', { stateRoot: rootF })
  ok(parentIsFile(rRead), '读：不抛，报文档化的失败码（Windows=missing / Linux=io_error）', JSON.stringify(rRead))
  const rRemove = await removeConflict('c1', { stateRoot: rootF })
  ok(parentIsFile(rRemove), '删：不抛，报文档化的失败码', JSON.stringify(rRemove))
  const rResolve = await resolveConflict('c1', 'resolved', { stateRoot: rootF })
  ok(parentIsFile(rResolve), '标状态：不抛，报文档化的失败码', JSON.stringify(rResolve))
}

// ────────────────────────── 10. 删除 ──────────────────────────

console.log('== 10. removeConflict ==')
const rootG = join(world, 'state-g')
{
  const rec = buildConflict(base())
  await writeConflict(rec, { stateRoot: rootG })
  const removed = await removeConflict(rec.id, { stateRoot: rootG })
  ok(removed.ok === true && removed.path === pathOf(rootG, rec.id), '删除成功并回报路径')
  ok((await readConflict(rec.id, { stateRoot: rootG })).code === 'missing', '删掉之后读不到')
  ok((await listConflicts({ stateRoot: rootG })).items.length === 0, '删掉之后列表里也没有')
  ok((await removeConflict(rec.id, { stateRoot: rootG })).code === 'missing', '再删一次 → missing')
  ok((await removeConflict('a/b', { stateRoot: rootG })).code === 'invalid', '非法 id → invalid')
  ok((await removeConflict(42, { stateRoot: rootG })).code === 'invalid', '非字符串 id → invalid')

  // 删一条还没处理的冲突**不拦状态**：拦是面板的确认动作，数据层再拦一道只会让「明确要删」删不掉
  const openRec = buildConflict(base({ incoming: '还没判定的那条' }))
  await writeConflict(openRec, { stateRoot: rootG })
  ok((await removeConflict(openRec.id, { stateRoot: rootG })).ok === true, 'open 状态的记录也能删（数据层不替用户做确认）')
}

// ────────────────────────── 11. 用户内容不许进日志 ──────────────────────────

console.log('== 11. 冲突正文永不进控制台 / 日志 ==')
{
  const src = await readFile(fileURLToPath(new URL('../lib/memory/conflicts.js', import.meta.url)), 'utf8')
  ok(!/\bconsole\s*\./.test(src), '源码里一处 console 都没有（结构保证，不只是行为观察）')

  const SENTINEL = 'SENTINEL-CONFLICT-BODY-绝不进终端'
  const rootH = join(world, 'state-h')
  const captured = []
  const consoleOriginals = {}
  const writeOriginals = { out: process.stdout.write, err: process.stderr.write }
  const restore = () => {
    for (const m of Object.keys(consoleOriginals)) console[m] = consoleOriginals[m]
    process.stdout.write = writeOriginals.out
    process.stderr.write = writeOriginals.err
  }
  for (const m of ['log', 'warn', 'error', 'info', 'debug', 'trace']) {
    consoleOriginals[m] = console[m]
    console[m] = (...args) => {
      captured.push(`${m}: ${args.map((a) => String(a)).join(' ')}`)
    }
  }
  process.stdout.write = (chunk) => {
    captured.push(`stdout: ${String(chunk)}`)
    return true
  }
  process.stderr.write = (chunk) => {
    captured.push(`stderr: ${String(chunk)}`)
    return true
  }

  let cycle = null
  try {
    const rec = buildConflict(base({ incoming: SENTINEL, onDisk: SENTINEL, note: SENTINEL }))
    const w = await writeConflict(rec, { stateRoot: rootH })
    const r = await readConflict(rec.id, { stateRoot: rootH })
    const l = await listConflicts({ stateRoot: rootH })
    const s = await resolveConflict(rec.id, 'resolved', { stateRoot: rootH })
    const rm = await removeConflict(rec.id, { stateRoot: rootH })
    const afterRemove = await readConflict(rec.id, { stateRoot: rootH }) // missing 路径
    const badId = await readConflict('../x', { stateRoot: rootH }) // invalid 路径
    const broken = await (async () => {
      await writeFile(pathOf(rootH, 'c-sentinel-broken'), SENTINEL) // 坏 JSON 路径（内容就是哨兵）
      return readConflict('c-sentinel-broken', { stateRoot: rootH })
    })()
    cycle = { w: w.ok, r: r.ok, l: l.ok, s: s.ok, rm: rm.ok, miss: afterRemove.code, inv: badId.code, bad: broken.code }
  } finally {
    restore()
  }

  ok(
    cycle !== null && cycle.w && cycle.r && cycle.l && cycle.s && cycle.rm && cycle.miss === 'missing' && cycle.inv === 'invalid' && cycle.bad === 'malformed',
    '哨兵正文走完一整套 API（写 / 读 / 列 / 标状态 / 删 / 三条失败路径）',
    JSON.stringify(cycle),
  )
  ok(captured.length === 0, `整轮下来控制台**一行都没有**（实际 ${captured.length} 行）`, captured.slice(0, 3).join(' | '))
  ok(!captured.some((line) => line.includes(SENTINEL)), '冲突正文没有出现在任何输出里')
}

// ────────────────────────── 12. 并发：原子写 + 不同 id 互不影响 ──────────────────────────

console.log('== 12. 并发：同 id 不撕裂 / 不同 id 互不影响 ==')
const rootI = join(world, 'state-i')
{
  const recs = Array.from({ length: 8 }, (_, i) => buildConflict(base({ incoming: `第 ${i} 条` })))
  const results = await Promise.all(recs.map((r) => writeConflict(r, { stateRoot: rootI })))
  ok(
    results.every((r) => r.ok === true),
    '八个不同 id 并发写全部成功',
  )
  const list = await listConflicts({ stateRoot: rootI })
  ok(list.ok === true && list.items.length === 8, `八个不同 id 互不影响，列出来就是 8 条（实际 ${list.items.length}）`)

  const sameId = 'c-race'
  const bodies = Array.from({ length: 8 }, (_, i) => `并发正文 ${i}`)
  const race = await Promise.all(
    bodies.map((b) => writeConflict({ ...buildConflict(base()), id: sameId, incoming: b }, { stateRoot: rootI })),
  )
  ok(
    race.every((r) => r.ok === true),
    '同一个 id 并发写八次：每次都成功（原子 rename，没有互相删临时文件）',
  )
  const final = await readConflict(sameId, { stateRoot: rootI })
  ok(
    final.ok === true && bodies.includes(final.record.incoming),
    '同 id 并发的终态是**某一次完整的写**（JSON 没被撕成两半）',
    final.ok ? String(final.record.incoming) : JSON.stringify(final),
  )
  const names = await readdir(dirOf(rootI))
  ok(
    names.every((n) => n.endsWith(CONFLICT_FILE_SUFFIX)),
    '并发跑完目录里没有残留的 .tmp 文件',
    JSON.stringify(names.filter((n) => !n.endsWith(CONFLICT_FILE_SUFFIX))),
  )
}

// ────────────────────────── 收尾 ──────────────────────────

await rm(world, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
