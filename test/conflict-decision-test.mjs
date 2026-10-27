#!/usr/bin/env node
/**
 * conflict-decision-test.mjs — 2.0.0「冲突记录与裁决判定」的断言。
 *
 * 这一层要守住的是**数据风险**，不是功能好看：
 *   1. `CONFLICT_KINDS` 四条、`buildConflict` 的字段是**尾部追加**（只增不改，`v` 仍是 1）——
 *      旧版本读新记录会忽略不认识的键，新版本读旧记录缺省为空串，双向兼容不需要迁移；
 *   2. **老种类的 id 与 1.9.2 逐字相同**（固定输入钉一个已知 id）：老记录还在盘上，
 *      新版本只要把 id 换了，同一件事就有了两个身份，去重与撤销全乱；
 *   3. 去重判据里**必须有 `otherFile`**：否则「A 对 B」与「A 对 C」被当成同一件事，
 *      第二对矛盾永远落不了盘（外部报告 2026-10-25 / issue #7 的形状）；
 *   4. `patchConflict` 只能改「裁决收据」那几个字段 —— **改不到 id / 两份正文 / 两个版本**。
 *      裁决入口能改证据，等于「用面板把一份记忆的冲突证据擦掉」。
 *
 * 反向对照（每条正面判据都有对面）：
 *   · 同对重复报告 → 不新增 ↔ 换 otherFile / 换正文 / 换方向 → 新增；
 *   · 老种类 id 不变 ↔ 给了 otherFile 就变；
 *   · 同状态重复点 → 不重写（mtime 不动）↔ 真状态迁移 → 落盘；
 *   · 白名单外的键写不进去 ↔ 白名单内的键确实写进去了（否则「拦住了」可能只是全都没写）。
 *
 * 前提：`STATE_ROOT` / `MEMORY_DIR` 是模块顶层读的环境变量 —— 必须在动态 import **之前**
 * 指到临时目录；全程只碰 mkdtemp 出来的目录，不碰真实记忆 / 状态目录。
 *
 * 用法: node test/conflict-decision-test.mjs
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 沙箱：环境变量必须在 import 之前 ─────────────────────────
const world = await mkdtemp(join(tmpdir(), 'sage-mem-decision-'))
const memoryDir = join(world, 'memory')
const stateRoot = join(world, '.sage-mem')
const patchRoot = join(world, '.sage-mem-patch')
process.env.SAGE_MEM_DIR = memoryDir
process.env.SAGE_MEM_STATE_DIR = stateRoot
process.env.DSH_HOME = join(world, 'dsh-home')
await mkdir(memoryDir, { recursive: true })
await mkdir(stateRoot, { recursive: true })
await mkdir(patchRoot, { recursive: true })

const modUrl = (rel) => new URL(`../lib/${rel}`, import.meta.url).href
const conflicts = await import(modUrl('memory/conflicts.js'))
const { createToolRunner } = await import(modUrl('autodream/tools.js'))
const {
  CONFLICT_KINDS, CONFLICT_STATUSES, CONFLICT_TRANSITIONS, CONFLICT_FIELD_LIMITS,
  buildConflict, summarizeConflict, patchConflict, writeConflict, readConflict, listConflicts, sameConflict,
} = conflicts

const conflictPath = (id, root = stateRoot) => join(root, 'conflicts', `${id}.json`)

group('0. 前置：导出面与冻结常量')
{
  ok(typeof buildConflict === 'function' && typeof sameConflict === 'function' &&
    typeof patchConflict === 'function' && typeof summarizeConflict === 'function',
    'buildConflict / sameConflict / patchConflict / summarizeConflict 都已导出')
  ok(Object.isFrozen(CONFLICT_KINDS) && Object.isFrozen(CONFLICT_STATUSES) &&
    Object.isFrozen(CONFLICT_TRANSITIONS),
    '种类 / 状态 / 状态迁移表都是冻结对象（运行时改不掉）')
  ok(Array.isArray(CONFLICT_KINDS) && Array.isArray(CONFLICT_STATUSES), '种类与状态是数组（面板要能遍历）')
}

group('1. CONFLICT_KINDS：四条，写失败型三条一个不少')
{
  ok(CONFLICT_KINDS.length === 4, `恰好四条（实际 ${CONFLICT_KINDS.length}）`, CONFLICT_KINDS.join(','))
  ok(JSON.stringify(CONFLICT_KINDS) === JSON.stringify([
    'stale_version', 'external_change', 'unresolved_merge', 'contradiction',
  ]), '逐字四条且顺序不变（前三条是 1.x 冻结值，第四条第尾部追加）', CONFLICT_KINDS.join(','))
  ok(CONFLICT_KINDS.includes('contradiction'), '新种类 contradiction 在列（注入抑制只对它生效）')
  // 反向对照：新增一条不许顺手把旧的三条挤掉 —— 老记录里全是它们的 kind。
  ok(['stale_version', 'external_change', 'unresolved_merge'].every((k) => CONFLICT_KINDS.includes(k)),
    '【反向对照】三条写失败型仍在（老记录照旧可读）', CONFLICT_KINDS.join(','))
  ok(JSON.stringify(CONFLICT_STATUSES) === JSON.stringify(['open', 'resolved', 'dismissed']),
    '状态仍是三条且顺序不变', CONFLICT_STATUSES.join(','))
  ok(CONFLICT_TRANSITIONS.open.length === 2 && !CONFLICT_TRANSITIONS.open.includes('open') &&
    !CONFLICT_TRANSITIONS.resolved.includes('open') && !CONFLICT_TRANSITIONS.dismissed.includes('open'),
    '状态机数据里没有任何一条能回到 open（要重开就新建）',
    JSON.stringify(CONFLICT_TRANSITIONS))
}

group('2. buildConflict：新字段尾部追加、缺省空串（只增不改）')
{
  const rec = buildConflict({ kind: 'stale_version', file: 'project_alpha.md' })
  const keys = Object.keys(rec)
  ok(keys.length === 18, `记录恰好 18 个键（1.9.2 的 13 + 2.0.0 的 5；实际 ${keys.length}）`, keys.join(','))
  ok(JSON.stringify(keys) === JSON.stringify([
    'v', 'id', 'kind', 'status', 'file', 'expectedVersion', 'actualVersion', 'at',
    'incoming', 'onDisk', 'note', 'tool', 'truncated',
    'otherFile', 'decision', 'decidedAt', 'appliedVersion', 'invalidatedFile',
  ]), '字段顺序逐字：新字段全部在尾部（老版本按位置读不会错位）', keys.join(','))
  ok(rec.v === 1, '记录版本仍是 1（不开 v2：没有读者会看，只会多一份迁移）', String(rec.v))
  // 反向对照：老输入（一个 1.9.2 形状的调用）产出的新字段必须全是空串 —— 老行为零变化。
  ok(rec.otherFile === '' && rec.decision === '' && rec.decidedAt === '' &&
    rec.appliedVersion === '' && rec.invalidatedFile === '',
    '【反向对照】老输入 → 五个新字段都是空串（1.9.2 行为不变）',
    JSON.stringify([rec.otherFile, rec.decision, rec.decidedAt, rec.appliedVersion, rec.invalidatedFile]))

  const full = buildConflict({
    kind: 'contradiction',
    file: 'project_old.md',
    otherFile: 'project_new.md',
    invalidatedFile: 'project_old.md',
    decision: 'invalidate',
    decidedAt: '2026-10-24T18:30:00+08:00',
    appliedVersion: 42,
    incoming: '新说法',
    onDisk: '旧说法',
    note: '部署位置互斥',
    at: '2026-10-24T18:30:00+08:00',
  })
  ok(full.otherFile === 'project_new.md' && full.invalidatedFile === 'project_old.md' &&
    full.decision === 'invalidate' && full.decidedAt === '2026-10-24T18:30:00+08:00' &&
    full.appliedVersion === '42',
    '五个新字段往返正确；appliedVersion 一律当字符串（数字不会变成另一种类型）',
    JSON.stringify({ otherFile: full.otherFile, invalidatedFile: full.invalidatedFile, decision: full.decision, decidedAt: full.decidedAt, appliedVersion: full.appliedVersion }))

  const badAt = buildConflict({ kind: 'contradiction', decidedAt: 'not-a-date' })
  ok(badAt.decidedAt === '', 'decidedAt 坏格式 → 空串（认不出就不编时间，与 at 同口径）', JSON.stringify(badAt.decidedAt))
  const nullVersion = buildConflict({ kind: 'contradiction', appliedVersion: null })
  ok(nullVersion.appliedVersion === '', 'appliedVersion 为 null → 空串而不是字符串 "null"', JSON.stringify(nullVersion.appliedVersion))

  // 超限截断：新字段也要受字节上限管，否则一个 200 KB 的 otherFile 能把记录预算吃光。
  const longOther = 'x'.repeat(CONFLICT_FIELD_LIMITS.otherFile + 100)
  const cut = buildConflict({ kind: 'contradiction', file: 'a.md', otherFile: longOther })
  ok(cut.truncated === true && Buffer.byteLength(cut.otherFile, 'utf8') <= CONFLICT_FIELD_LIMITS.otherFile,
    'otherFile 超限 → 截断并置 truncated:true（新字段不是预算黑洞）',
    `${Buffer.byteLength(cut.otherFile, 'utf8')}/${CONFLICT_FIELD_LIMITS.otherFile}`)
  ok(cut.decision === '' && cut.invalidatedFile === '', '截断 otherFile 不牵连其它新字段（各自独立卡）')

  // 不认识的 kind 原样保留（老记录 / 别处写的记录照读），不要静默伪装成已知值。
  ok(buildConflict({ kind: 'future_kind' }).kind === 'future_kind',
    '未知 kind 原样保留（不静默换成已知值）')
  const weird = buildConflict({ kind: 'contradiction', otherFile: { evil: true }, decision: 123 })
  ok(weird.otherFile === '' && weird.decision === '',
    '非字符串的新字段按「缺」处理（不去猜对象 / 数字的语义）',
    JSON.stringify({ otherFile: weird.otherFile, decision: weird.decision }))
}

group('3. id 稳定性：老种类逐字不变，otherFile 非空才进指纹')
{
  /**
   * 固定输入（1.9.2 时代的形状）。期望值是**按 1.9.2 的公式手算后钉死的字面量**：
   * `timestamp-` + sha256(kind\0file\0expected\0actual\0incoming\0onDisk).slice(0,8)。
   * 这条断言的作用不是复述实现 —— 它保证「新版本读老记录时 id 还是那个 id」。
   */
  const legacyInput = {
    kind: 'stale_version',
    file: 'project_alpha.md',
    expectedVersion: 'v1',
    actualVersion: 'v2',
    incoming: '想写的新版本正文\n',
    onDisk: '盘上的旧版本正文\n',
    at: '2026-10-24T10:00:00.000Z',
  }
  const knownId = '20261024T100000Z-7e870799'
  ok(buildConflict(legacyInput).id === knownId, `【数据不变量】老种类 id 与 1.9.2 逐字相同（${knownId}）`,
    buildConflict(legacyInput).id)
  ok(buildConflict({ ...legacyInput, at: '' }).id === '7e870799',
    '不给 at → id 只有 8 位指纹（1.9.2 同规则）', buildConflict({ ...legacyInput, at: '' }).id)

  // 反向对照：otherFile 非空时指纹必须变 —— 否则「A 对 B」与「A 对 C」拿到同一个 id。
  const withOther = buildConflict({ ...legacyInput, otherFile: 'project_beta.md' })
  ok(withOther.id !== knownId, '【反向对照】给了 otherFile → id 变化（另一对矛盾是另一条）',
    `${knownId} vs ${withOther.id}`)
  // 反向对照的另一面：显式给空串仍然与老 id 相同（空串不进指纹，老种类的 id 才保住）。
  ok(buildConflict({ ...legacyInput, otherFile: '' }).id === knownId,
    '【反向对照】otherFile 显式空串 → 与老 id 相同（空串不参与指纹）')

  // 元信息不参与身份：同一件事被不同轮次碰到，不该长出第二条。
  const rec = buildConflict(legacyInput)
  ok(buildConflict({ ...legacyInput, note: '换一句说明', tool: 'write_memory' }).id === rec.id,
    '【反向对照】note / tool 变化不改变 id（它们不是「冲突本身」）')

  // 显式 id：合法就照用（面板要指定 id），非法就按内容指纹现算。
  ok(buildConflict({ ...legacyInput, id: 'my-fixed-id' }).id === 'my-fixed-id', '合法显式 id 原样保留')
  ok(buildConflict({ ...legacyInput, id: 'bad/id' }).id === knownId,
    '非法显式 id 被忽略、按内容指纹现算（不许把路径塞进 id）', buildConflict({ ...legacyInput, id: 'bad/id' }).id)
}

group('4. sameConflict：逐字段相等，otherFile 进比较、元信息不进')
{
  const base = buildConflict({
    kind: 'contradiction',
    file: 'project_old.md',
    otherFile: 'project_new.md',
    expectedVersion: 'v1',
    actualVersion: 'v2',
    incoming: '新说法正文',
    onDisk: '旧说法正文',
    note: '互斥',
    tool: 'report_contradiction',
    at: '2026-10-24T10:00:00.000Z',
  })
  ok(sameConflict(base, { ...base }) === true, '两次报告同一件事 → 判定重复（不去重就会每轮长一条）')
  ok(sameConflict(base, { ...base, note: '换个说法', tool: 'x', at: '2026-10-25T00:00:00.000Z' }) === true,
    '【反向对照】note / tool / at 不同仍是同一条（元信息不影响去重）')
  ok(sameConflict(base, { ...base, otherFile: 'project_other.md' }) === false,
    '【关键】换 otherFile → 不重复（否则「A 对 B」会把「A 对 C」吞掉）', 'otherFile 未进比较')
  ok(sameConflict(base, { ...base, incoming: '另一份新说法' }) === false, '换 incoming 正文 → 不重复（证据变了是另一件事）')
  ok(sameConflict(base, { ...base, onDisk: '另一份旧说法' }) === false, '换 onDisk 正文 → 不重复')
  ok(sameConflict(base, { ...base, expectedVersion: 'v9' }) === false, '换 expectedVersion → 不重复')
  ok(sameConflict(base, { ...base, actualVersion: 'v9' }) === false, '换 actualVersion → 不重复')
  ok(sameConflict(base, { ...base, status: 'resolved' }) === false, '【反向对照】状态不同 → 不重复（已裁决的不算待办）')
  // 老记录没有 otherFile 键：缺省必须与空串等价，否则 1.9.x 的记录永远对不上。
  ok(sameConflict({ status: 'open', kind: 'stale_version', file: 'a.md' },
    { status: 'open', kind: 'stale_version', file: 'a.md', otherFile: '' }) === true,
    '老记录缺 otherFile 键 ≡ 空串（1.9.x 记录照旧可比）')
  ok(sameConflict({ status: 'open', kind: 'stale_version', file: 'a.md' },
    { status: 'open', kind: 'stale_version', file: 'a.md', otherFile: 'b.md' }) === false,
    '【反向对照】老记录（无 otherFile）与带 otherFile 的不是同一条')
  ok(sameConflict(null, undefined) === true && sameConflict({}, {}) === true,
    '空参数不崩（两边都按空记录比较）')
}

group('5. 去重是真的落盘行为（report_contradiction 端到端）')
{
  // 纯函数判据之外，再从工具入口跑一遍：D22 的教训是「判据对了，但接线没调它」。
  const mem = memoryDir
  await writeFile(join(mem, 'project_where.md'), '---\nname: where-a\ntype: project\n---\n\n部署在 A 主机\n', 'utf8')
  await writeFile(join(mem, 'project_where_b.md'), '---\nname: where-b\ntype: project\n---\n\n部署在 B 主机\n', 'utf8')
  await writeFile(join(mem, 'project_where_c.md'), '---\nname: where-c\ntype: project\n---\n\n部署在 C 主机\n', 'utf8')
  const ctx = { logger: { warn() {}, error() {}, info() {}, debug() {} }, effect() {}, on() {} }
  const runner = createToolRunner({ memoryDir: mem, sessionsRoot: '', apply: true, withSessions: false, ctx })
  const count = async () => (await listConflicts({ stateRoot })).items.length
  const start = await count()

  const r1 = await runner.run('report_contradiction', {
    old: 'project_where.md', new: 'project_where_b.md', note: '部署主机说法互斥',
  })
  ok(typeof r1 === 'string' && r1.startsWith('已记录矛盾'), '第一次报告落一条记录', String(r1).slice(0, 40))
  ok(await count() === start + 1, `队列 ${start} → ${start + 1}`)
  const listed1 = await listConflicts({ stateRoot })
  const first = listed1.items.find((i) => i.file === 'project_where.md' && i.otherFile === 'project_where_b.md')
  ok(!!first && first.kind === 'contradiction' && first.status === 'open',
    '记录形状：kind=contradiction、status=open、两方文件名都在', JSON.stringify(first && { kind: first.kind, status: first.status, file: first.file, otherFile: first.otherFile }))

  const r2 = await runner.run('report_contradiction', {
    old: 'project_where.md', new: 'project_where_b.md', note: '部署主机说法互斥',
  })
  ok(typeof r2 === 'string' && r2.includes('此前已有同一对'), '同一对重复报告 → 明确告知「此前已有」', String(r2).slice(0, 50))
  ok(await count() === start + 1, '【反向对照】重复报告没有新增记录（queue 膨胀在 issue #7 里已经付过代价）')

  const r3 = await runner.run('report_contradiction', {
    old: 'project_where.md', new: 'project_where_c.md', note: '部署主机说法互斥',
  })
  ok(typeof r3 === 'string' && r3.startsWith('已记录矛盾') && await count() === start + 2,
    '【关键】换 new 文件（otherFile 不同）→ 第二个待办落盘，不被当成同一件事')

  // 证据变了就是另一件事：同一对文件、其中一份正文改写后再次报告 → 新记录。
  await writeFile(join(mem, 'project_where_b.md'), '---\nname: where-b\ntype: project\n---\n\n部署在 B2 主机\n', 'utf8')
  await runner.run('report_contradiction', {
    old: 'project_where.md', new: 'project_where_b.md', note: '部署主机说法互斥',
  })
  ok(await count() === start + 3, '【反向对照】同一对但正文变了 → 算另一件事（证据不同）')

  // 方向即身份：old/new 对调是 file / otherFile 互换，不是同一条。
  await runner.run('report_contradiction', {
    old: 'project_where_b.md', new: 'project_where.md', note: '部署主机说法互斥',
  })
  ok(await count() === start + 4, '【反向对照】old/new 对调 → 另立一条（file↔otherFile 交换）')

  // 只和 open 记录去重：已裁决的同一对再报告 → 允许新记录（证据可能又出现了）。
  // ⚠️ id 的时间戳只到**秒**：同一对、同一秒、同一份正文的两条记录 id 相同。
  // 这里跨过一秒再报，否则测到的是「id 撞车覆盖」而不是「开放状态过滤」（那是另一件事，
  // 已单独报给 Lead：同一秒内重报会覆盖已裁决记录里的 decision / appliedVersion 收据）。
  const target = listed1.items.find((i) => i.file === 'project_where.md' && i.otherFile === 'project_where_c.md') ??
    (await listConflicts({ stateRoot })).items.find((i) => i.file === 'project_where.md' && i.otherFile === 'project_where_c.md')
  if (target) {
    const patched = await patchConflict(target.id, { status: 'resolved' }, { stateRoot })
    await sleep(1100)
    const rr = await runner.run('report_contradiction', {
      old: 'project_where.md', new: 'project_where_c.md', note: '部署主机说法互斥',
    })
    const got = await count()
    ok(got === start + 5, '【反向对照】队列里只有已裁决的同对 → 重新报会新增（去重只看 open）',
      `patched=${patched.ok ? patched.record.status : JSON.stringify(patched)} count=${start}→${got} reply=${String(rr).slice(0, 40)}`)
    const stillResolved = await readConflict(target.id, { stateRoot })
    ok(stillResolved.ok && stillResolved.record.status === 'resolved' &&
      stillResolved.record.id === target.id,
      '已裁决的那条**原样留在盘上**（新证据另立一条，不改写旧判断）',
      JSON.stringify(stillResolved.ok ? stillResolved.record.status : stillResolved))
  } else {
    ok(false, '【反向对照】队列里只有已裁决的同对 → 重新报会新增（去重只看 open）', '没找到 project_where_c 那条记录')
  }
}

group('6. patchConflict：状态机（resolved/dismissed 之间可互转，不许回 open）')
{
  const seed = async (id, over = {}) => {
    const rec = buildConflict({
      kind: 'contradiction',
      file: 'project_patch.md',
      otherFile: 'project_patch_b.md',
      incoming: '新说法',
      onDisk: '旧说法',
      note: '互斥',
      at: '2026-10-24T10:00:00.000Z',
      id,
      ...over,
    })
    const w = await writeConflict(rec, { stateRoot: patchRoot })
    return w.ok ? rec : null
  }
  const readBack = async (id) => {
    const r = await readConflict(id, { stateRoot: patchRoot })
    return r.ok ? r.record : null
  }
  const bytesOf = async (id) => readFile(conflictPath(id, patchRoot), 'utf8')

  await seed('patch-open-resolved')
  const r1 = await patchConflict('patch-open-resolved', { status: 'resolved' }, { stateRoot: patchRoot })
  ok(r1.ok && r1.record.status === 'resolved', 'open → resolved 允许', JSON.stringify(r1.ok ? r1.record.status : r1))
  ok((await readBack('patch-open-resolved'))?.status === 'resolved', '状态真的落盘（不是只改返回值）')

  await seed('patch-open-dismissed')
  const r2 = await patchConflict('patch-open-dismissed', { status: 'dismissed' }, { stateRoot: patchRoot })
  ok(r2.ok && r2.record.status === 'dismissed', 'open → dismissed 允许')

  await seed('patch-resolved-dismissed')
  await patchConflict('patch-resolved-dismissed', { status: 'resolved' }, { stateRoot: patchRoot })
  const r3 = await patchConflict('patch-resolved-dismissed', { status: 'dismissed' }, { stateRoot: patchRoot })
  ok(r3.ok && r3.record.status === 'dismissed', 'resolved → dismissed 允许（人和模型对同一件事的判断可以改）')

  await seed('patch-dismissed-resolved')
  await patchConflict('patch-dismissed-resolved', { status: 'dismissed' }, { stateRoot: patchRoot })
  const r4 = await patchConflict('patch-dismissed-resolved', { status: 'resolved' }, { stateRoot: patchRoot })
  ok(r4.ok && r4.record.status === 'resolved', 'dismissed → resolved 允许')

  await seed('patch-no-reopen')
  await patchConflict('patch-no-reopen', { status: 'resolved' }, { stateRoot: patchRoot })
  const bytesBefore = await bytesOf('patch-no-reopen')
  const r5 = await patchConflict('patch-no-reopen', { status: 'open' }, { stateRoot: patchRoot })
  ok(!r5.ok && r5.code === 'invalid_transition', 'resolved → open 被拒（invalid_transition）', JSON.stringify(r5))
  ok(await bytesOf('patch-no-reopen') === bytesBefore, '【反向对照】被拒时磁盘一个字节都没动')
  ok((await readBack('patch-no-reopen'))?.status === 'resolved', '被拒后记录仍是 resolved（没有半态）')

  await seed('patch-dismissed-no-reopen')
  await patchConflict('patch-dismissed-no-reopen', { status: 'dismissed' }, { stateRoot: patchRoot })
  const r6 = await patchConflict('patch-dismissed-no-reopen', { status: 'open' }, { stateRoot: patchRoot })
  ok(!r6.ok && r6.code === 'invalid_transition', 'dismissed → open 同样被拒')

  await seed('patch-unknown-status')
  const r7 = await patchConflict('patch-unknown-status', { status: 'maybe' }, { stateRoot: patchRoot })
  ok(!r7.ok && r7.code === 'invalid', '未知状态 → invalid（不猜一个接近的状态）', JSON.stringify(r7))
}

group('7. patchConflict：同状态幂等（连点两下不重写、不报错）')
{
  const id = 'patch-idempotent'
  const rec = buildConflict({
    kind: 'contradiction', file: 'project_idem.md', otherFile: 'project_idem_b.md',
    incoming: '新', onDisk: '旧', note: '互斥', at: '2026-10-24T10:00:00.000Z', id,
  })
  await writeConflict(rec, { stateRoot: patchRoot })
  const path = conflictPath(id, patchRoot)
  const before = await stat(path)
  const beforeText = await readFile(path, 'utf8')
  await sleep(30)
  const again = await patchConflict(id, { status: 'open' }, { stateRoot: patchRoot })
  const after = await stat(path)
  const afterText = await readFile(path, 'utf8')
  ok(again.ok && again.record.status === 'open', 'open → open 不报错（界面连点两下是常态）', JSON.stringify(again.ok ? again.record.status : again))
  ok(after.mtimeMs === before.mtimeMs, '【反向对照】同状态重复点不重写（mtime 未变）',
    `${before.mtimeMs} → ${after.mtimeMs}`)
  ok(afterText === beforeText, '文件内容逐字节不变（幂等不只是状态看起来一样）', `${beforeText.length} → ${afterText.length}`)

  // 已 resolved 的再点 resolved：同一状态幂等，不重写。
  await patchConflict(id, { status: 'resolved' }, { stateRoot: patchRoot })
  const b2 = await stat(path)
  await sleep(30)
  const r2 = await patchConflict(id, { status: 'resolved' }, { stateRoot: patchRoot })
  const a2 = await stat(path)
  ok(r2.ok && a2.mtimeMs === b2.mtimeMs, 'resolved → resolved 幂等（不重写）', `${b2.mtimeMs} → ${a2.mtimeMs}`)
}

group('8. patchConflict：白名单（裁决入口改不到证据）')
{
  const id = 'patch-evidence'
  const rec = buildConflict({
    kind: 'contradiction',
    file: 'project_evidence.md',
    otherFile: 'project_evidence_b.md',
    expectedVersion: 'v-normal',
    actualVersion: 'v-disk',
    incoming: '新说法原文',
    onDisk: '旧说法原文',
    note: '互斥',
    at: '2026-10-24T10:00:00.000Z',
    id,
  })
  await writeConflict(rec, { stateRoot: patchRoot })
  const path = conflictPath(id, patchRoot)
  const before = await stat(path)
  const beforeText = await readFile(path, 'utf8')
  await sleep(30)
  const res = await patchConflict(id, {
    // 这些键是**证据**：裁决入口不许改。
    id: 'hacked-id',
    kind: 'external_change',
    incoming: '被篡改的新说法',
    onDisk: '被篡改的旧说法',
    expectedVersion: 'v-evil',
    actualVersion: 'v-evil',
    truncated: true,
    v: 99,
    at: '2000-01-01T00:00:00Z',
  }, { stateRoot: patchRoot })
  const after = await stat(path)
  ok(res.ok === true, '只有不可写键的 patch 不报错（等于「无事发生」）', JSON.stringify(res))
  ok(res.record.id === id && res.record.kind === 'contradiction' && res.record.incoming === '新说法原文' &&
    res.record.onDisk === '旧说法原文' && res.record.expectedVersion === 'v-normal' &&
    res.record.actualVersion === 'v-disk' && res.record.truncated === false && res.record.v === 1 &&
    res.record.at === '2026-10-24T10:00:00.000Z',
    '【关键】id / kind / 两份正文 / 两个版本 / truncated / v / at 全部没被改掉',
    JSON.stringify(res.record))
  ok(after.mtimeMs === before.mtimeMs && await readFile(path, 'utf8') === beforeText,
    '【反向对照】不可写键的 patch 根本没触发写盘（mtime 与字节都不变）')

  // 正向对照：白名单里的键**确实能写进去**，否则上面那条「拦住了」可能只是全都没写。
  const allowed = await patchConflict(id, {
    otherFile: 'project_evidence_c.md',
    invalidatedFile: 'project_evidence.md',
    decision: 'invalidate',
    appliedVersion: 'v-receipt',
    note: '裁决理由',
    decidedAt: '2026-10-24T18:30:00+08:00',
  }, { stateRoot: patchRoot })
  ok(allowed.ok && allowed.record.otherFile === 'project_evidence_c.md' &&
    allowed.record.invalidatedFile === 'project_evidence.md' && allowed.record.decision === 'invalidate' &&
    allowed.record.appliedVersion === 'v-receipt' && allowed.record.note === '裁决理由' &&
    allowed.record.decidedAt === '2026-10-24T18:30:00+08:00',
    '白名单内字段（otherFile / invalidatedFile / decision / appliedVersion / note / decidedAt）可写',
    JSON.stringify(allowed.record))
  const persisted = await readConflict(id, { stateRoot: patchRoot })
  ok(persisted.ok && persisted.record.appliedVersion === 'v-receipt' && persisted.record.otherFile === 'project_evidence_c.md',
    '白名单字段真的落盘（不是只改返回值）', JSON.stringify(persisted.ok ? persisted.record.appliedVersion : persisted))
}

group('9. patchConflict：decidedAt 归一与错误码')
{
  const id = 'patch-decided-at'
  await writeConflict(buildConflict({
    kind: 'contradiction', file: 'project_when.md', otherFile: 'project_when_b.md',
    incoming: '新', onDisk: '旧', note: '互斥', at: '2026-10-24T10:00:00.000Z', id,
  }), { stateRoot: patchRoot })
  const bad = await patchConflict(id, { status: 'resolved', decidedAt: '下周' }, { stateRoot: patchRoot })
  ok(bad.ok && bad.record.decidedAt === '', 'decidedAt 坏格式 → 归一为空串（不编时间）', JSON.stringify(bad.record.decidedAt))
  const good = await patchConflict(id, { decidedAt: '2026-10-24T18:30:00+08:00' }, { stateRoot: patchRoot })
  ok(good.ok && good.record.decidedAt === '2026-10-24T18:30:00+08:00', 'decidedAt 好格式 → 原样保留（保留时区）')

  const missing = await patchConflict('patch-does-not-exist', { status: 'resolved' }, { stateRoot: patchRoot })
  ok(!missing.ok && missing.code === 'missing', '不存在的 id → missing', JSON.stringify(missing))
  const invalid = await patchConflict('../evil', { status: 'resolved' }, { stateRoot: patchRoot })
  ok(!invalid.ok && invalid.code === 'invalid', '非法 id → invalid（不猜路径）', JSON.stringify(invalid))
  const badPatch = await patchConflict(id, 'not-an-object', { stateRoot: patchRoot })
  ok(!badPatch.ok && badPatch.code === 'invalid', 'patch 不是对象 → invalid（不把字符串展开成索引键）')
}

group('10. summarizeConflict：12 个键，两份正文不上列表')
{
  const rec = buildConflict({
    kind: 'contradiction',
    file: 'project_sum.md',
    otherFile: 'project_sum_b.md',
    invalidatedFile: 'project_sum.md',
    decision: 'invalidate',
    decidedAt: '2026-10-24T18:30:00+08:00',
    appliedVersion: 'v9',
    incoming: '新说法',
    onDisk: '旧说法',
    note: '互斥',
    at: '2026-10-24T10:00:00.000Z',
    id: 'sum-1',
  })
  const sum = summarizeConflict(rec)
  const keys = Object.keys(sum)
  ok(keys.length === 12, `摘要恰好 12 个键（实际 ${keys.length}）`, keys.join(','))
  ok(JSON.stringify(keys) === JSON.stringify([
    'id', 'at', 'kind', 'status', 'file', 'otherFile', 'note', 'decision', 'decidedAt',
    'appliedVersion', 'invalidatedFile', 'truncated',
  ]), '摘要字段顺序逐字（面板列表按这份形状渲染）', keys.join(','))
  ok(!('incoming' in sum) && !('onDisk' in sum),
    '【关键】摘要里没有两份正文（各 48 KB，一次列表能把几十兆推过 remote 边界）')
  ok(sum.otherFile === 'project_sum_b.md' && sum.invalidatedFile === 'project_sum.md' &&
    sum.decision === 'invalidate' && sum.appliedVersion === 'v9',
    '新字段进了摘要（面板要显示「裁决到哪一步」）', JSON.stringify(sum))

  // 老记录没有这几个键：摘要必须补空串，而不是把 undefined 发给面板。
  const legacy = summarizeConflict({ id: 'old-1', status: 'open', kind: 'stale_version', file: 'a.md' })
  ok(legacy.otherFile === '' && legacy.decision === '' && legacy.decidedAt === '' &&
    legacy.appliedVersion === '' && legacy.invalidatedFile === '',
    '老记录 → 新字段补空串（面板不会看到 undefined）', JSON.stringify(legacy))
  ok(summarizeConflict(null).id === '' && summarizeConflict(null).truncated === false,
    '空记录不崩，truncated 归一为 false')
}

group('11. 老记录兼容：1.9.2 形状照读，缺新字段不报坏')
{
  // 手写一条 1.9.2 形状的记录（13 个键，没有 otherFile 等），直接落盘。
  const legacyRecord = {
    v: 1,
    id: 'legacy-191',
    kind: 'stale_version',
    status: 'open',
    file: 'project_legacy.md',
    expectedVersion: 'v1',
    actualVersion: 'v2',
    at: '2026-10-20T10:00:00.000Z',
    incoming: '想写的新内容',
    onDisk: '盘上的旧内容',
    note: '被版本守卫拒绝',
    tool: 'write_memory',
    truncated: false,
  }
  await writeConflict(legacyRecord, { stateRoot: patchRoot })
  const read = await readConflict('legacy-191', { stateRoot: patchRoot })
  ok(read.ok && read.record.kind === 'stale_version' && read.record.status === 'open',
    '1.9.2 形状的记录照读（解析器只校验 id / status）', JSON.stringify(read.ok ? read.record.kind : read))
  const listed = await listConflicts({ stateRoot: patchRoot })
  ok(listed.items.some((i) => i.id === 'legacy-191'), '老记录照常出现在列表里（不当成坏文件）')
  ok(read.record.otherFile === undefined, '老记录读回时没有 otherFile（缺省不伪造）', JSON.stringify(read.record.otherFile))

  // 老记录与「同一件事的新记录」必须能被 sameConflict 判成同一条 —— 升级后去重不能失效。
  const rebuilt = buildConflict(legacyRecord)
  ok(rebuilt.id === 'legacy-191' && sameConflict(rebuilt, legacyRecord) === true,
    '老记录换成新对象时不长出新身份（显式 id 保留 + 去重成立）', `${rebuilt.id} / ${sameConflict(rebuilt, legacyRecord)}`)

  // 老记录也能被裁决：patch 后写回，新字段保持「没写过」而不是补一串空值。
  const patched = await patchConflict('legacy-191', { status: 'resolved', decidedAt: '2026-10-24T18:30:00+08:00' }, { stateRoot: patchRoot })
  ok(patched.ok && patched.record.status === 'resolved' && patched.record.decidedAt === '2026-10-24T18:30:00+08:00',
    '老记录可被裁决（升级后第一次处理不要求先迁移）', JSON.stringify(patched.ok ? patched.record.status : patched))
}

await rm(world, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
