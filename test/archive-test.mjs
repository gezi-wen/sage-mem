/**
 * 档案馆（v0.9.0）的后端行为断言。仓库内测试，随 npm test 一起跑。
 *
 * 断言的是**行为链**，不是函数形状：
 *   归档一条 → 检索不到它 → listArchived 看得见它 → restore → 又能检索到，
 * 外加 YAML 留痕转义（`: ` / ` #` 两个静默杀手）、拒绝矩阵、
 * 以及审计把「指向归档的链接」当提示而不是问题。
 *
 * 全程不碰真实记忆目录：SAGE_MEM_DIR / SAGE_MEM_STATE_DIR 一律指向临时目录，
 * 且必须在 import lib/index.js **之前**设好（模块顶层读环境变量）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = join(tmpdir(), 'sage-mem-archive-test-' + process.pid)
const memDir = join(sandbox, 'memory')
const archiveDir = join(memDir, 'archive')
mkdirSync(memDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const LIB = new URL('../lib/', import.meta.url)
const mod = await import(new URL('index.js', LIB).href)
const { auditMemoryDir } = await import(new URL('autodream-audit.js', LIB).href)
const scan = await import(new URL('memory/scan.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

// ── 沙箱与夹具 ────────────────────────────────────────────────
/** 写一条记忆（description 是检索入口，frontmatter 走宿主同一套解析）。 */
function writeMem(name, { description = '', body = '', tags = null } = {}) {
  const lines = [
    '---',
    `name: ${name.replace(/\.md$/, '')}`,
    `type: ${name.split('_')[0]}`,
    `description: ${description}`,
  ]
  if (tags) lines.push(`tags: [${tags.join(', ')}]`)
  lines.push('---', '', `# ${name}`, '', body, '')
  writeFileSync(join(memDir, name), lines.join('\n'), 'utf8')
}
const archivedPath = (name) => join(archiveDir, name)
const activePath = (name) => join(memDir, name)

/** 假 ctx：与 inject-test 同一套最小面 —— cordis 的 Service 构造会取 ctx.reflect.*， 
 *  未知成员必须给「可调用且能继续取属性」的桩，否则构造函数就炸。 */
function makeCtx() {
  const handlers = new Map()
  const base = {
    on: (ev, h) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(h) },
    get: () => undefined,
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    effect: () => {},
    handlers,
  }
  let stub
  stub = new Proxy(function () {}, {
    get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined),
    apply: () => undefined,
  })
  return new Proxy(base, { get(t, p) { return p in t ? t[p] : stub } })
}

const ctx = makeCtx()
const gw = new mod.default(ctx) // MemoryGateway（构造函数里一并挂 starmap）
const starmap = new mod.StarmapGateway(ctx)
const assemble = (ctx.handlers.get('system-prompt/assemble') ?? []).at(-1)

/** 跑一步注入（每次换 session id：绕过按会话的检索签名/baseline 缓存）。 */
let sessionSeq = 0
async function inject(question) {
  const msgs = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: question }] }]
  const session = { id: `archive-test-${++sessionSeq}`, deriveMessages: () => msgs }
  const assembled = {}
  const out = await assemble(assembled, { agent: { session } }, async () => assembled)
  const recall = (out?.contexts ?? []).find((c) => c?.name === 'sage-mem:recall')
  return recall?.text ?? ''
}

const TOKEN = '档案馆阿尔法令牌'
writeMem('project_alpha.md', { description: `有一条 ${TOKEN} 的记忆`, tags: ['归档', '测试'] })
writeMem('project_beta.md', { description: '档案测试用乙', body: '见 [[project_alpha]] 与 [[ghost_missing]]' })

// ── 1. 归档前：检索得到 ───────────────────────────────────────
group('1. 归档前：检索得到、listFiles 列得到')
{
  const recall = await inject(TOKEN)
  ok(recall.includes('project_alpha.md'), '归档前检索能命中它')
  const listed = await gw.listFiles()
  ok(listed.some((f) => f.file === 'project_alpha.md'), '归档前 listFiles 列得到它')
  ok(
    JSON.stringify(Object.keys(listed[0])) === JSON.stringify(['file', 'type', 'description', 'size', 'tags', 'locked']),
    'listFiles 的形状是「file/type/description/size/tags/locked」（v0.9.8 起多一个锁定状态，键顺序也一致）',
    JSON.stringify(Object.keys(listed[0])),
  )
  const archivedNow = await gw.listArchived()
  ok(archivedNow.count === 0 && Array.isArray(archivedNow.files), '归档区为空时 listArchived 回 { count: 0, files: [] }')
}

// ── 2. 归档：移动 + 留痕 ──────────────────────────────────────
const REASON = '已被 Beta 取代: 结论过期 # 附带说明'
group('2. 归档：移进 archive/、frontmatter 留下痕迹')
{
  const r = await gw.archive('project_alpha.md', REASON)
  ok(r.ok === true && r.file === 'project_alpha.md', 'archive 返回 { ok: true, file }', JSON.stringify(r))
  ok(!existsSync(activePath('project_alpha.md')), '根目录里没有它了')
  ok(existsSync(archivedPath('project_alpha.md')), 'archive/ 里出现了它（不删，只移动）')
  const raw = readFileSync(archivedPath('project_alpha.md'), 'utf8')
  ok(/^archived_at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m.test(raw), '写入了本地时间 archived_at', raw.split('\n').slice(0, 8).join(' | '))
  ok(/^archived_reason: '/m.test(raw), 'reason 含「冒号+空格」与「空格+#」→ 整值加了单引号', raw.split('\n').slice(0, 8).join(' | '))
  const archived = await gw.listArchived()
  ok(archived.count === 1 && archived.files[0].file === 'project_alpha.md', 'listArchived 看得见归档的那条')
  ok(archived.files[0].archivedReason === REASON, 'reason 原样读回（未被 YAML 吃掉后半句）', archived.files[0].archivedReason)
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(archived.files[0].archivedAt), 'archivedAt 是 YYYY-MM-DD HH:mm')
  ok(archived.files[0].type === 'project' && archived.files[0].description.includes(TOKEN), '归档条目带上了 type / description')
  ok(JSON.stringify(archived.files[0].tags) === JSON.stringify(['归档', '测试']), '归档条目带上了 tags')
  const listed = await gw.listFiles()
  ok(!listed.some((f) => f.file === 'project_alpha.md'), 'listFiles 只列活动记忆（归档的不在里面）')
  ok(!('archivedAt' in listed[0]), 'listFiles 的条目没有多出归档字段')
}

// ── 3. 归档后：检索与星图 ────────────────────────────────────
group('3. 归档后：检索不到、星图默认不画、开启后能看见')
{
  const recall = await inject(TOKEN)
  ok(!recall.includes('project_alpha.md'), '归档后检索不到它（归档 = 静默失效）')
  const files = await scan.scanMemoryFiles(ctx, '')
  ok(!files.some((f) => f.file === 'project_alpha.md'), 'scanMemoryFiles 只扫根目录（归档区不参与检索）')
  const plain = await starmap.listStars()
  ok(plain.count === 1 && !plain.stars.some((s) => s.file === 'project_alpha.md'), 'listStars() 默认不含归档星')
  ok(plain.stars.every((s) => s.archived === false), '活动星的 archived 是 false')
  const withArchived = await starmap.listStars(true)
  const star = withArchived.stars.find((s) => s.file === 'project_alpha.md')
  ok(withArchived.count === 2 && !!star, 'listStars(true) 把归档星带上了')
  ok(star && star.archived === true, '归档星的 archived 是 true')
  ok(star && star.archivedReason === REASON && /^\d{4}-/.test(star.archivedAt), '归档星带 archivedAt / archivedReason')
}

// ── 4. 审计：指向归档是提示，不是问题 ─────────────────────────
group('4. 审计：指向归档 → archivedLinks（不计 problems）')
{
  const report = await auditMemoryDir(memDir)
  ok(report.archivedCount === 1, '审计认得归档区（archivedCount=1）', String(report.archivedCount))
  ok(report.archivedLinks.some((r) => r.target === 'project_alpha' && r.file === 'project_beta.md'), '指向归档的 [[链接]] 进了 archivedLinks')
  ok(!report.brokenLinks.some((r) => r.target === 'project_alpha'), '同一条链接**没有**被算成断链')
  ok(report.brokenLinks.some((r) => r.target === 'ghost_missing'), '指向真正不存在的目标仍算断链（没被顺手放过）')
  const sum =
    report.dangling.length + report.unlisted.length + report.typeMismatch.length + report.crlf.length +
    report.brokenLinks.length + report.hashHazards.length + report.noFrontmatter.length + report.unreadable.length
  ok(report.problems === sum, 'problems 不含 archivedLinks（逐项重算一致）', `problems=${report.problems} sum=${sum}`)
  const text = (await import(new URL('autodream-audit.js', LIB).href)).formatAudit(report)
  ok(text.includes('指向已归档') && text.includes('不计入问题'), 'formatAudit 把归档链接单独成节并写明不计问题')
}

// ── 5. 恢复：移回根目录、去掉留痕、又能检索到 ────────────────
group('5. 恢复：移回根目录、去掉两行留痕、检索恢复')
{
  const r = await gw.restore('project_alpha.md')
  ok(r.ok === true && r.file === 'project_alpha.md', 'restore 返回 { ok: true, file }', JSON.stringify(r))
  ok(existsSync(activePath('project_alpha.md')) && !existsSync(archivedPath('project_alpha.md')), '文件回到根目录、归档区里那份没了')
  const raw = readFileSync(activePath('project_alpha.md'), 'utf8')
  ok(!/archived_(at|reason)/.test(raw), 'archived_at / archived_reason 两行被去掉')
  ok(raw.includes(TOKEN), '正文与其余 frontmatter 原样保留')
  ok((await gw.listArchived()).count === 0, '归档区回到空')
  const recall = await inject(TOKEN)
  ok(recall.includes('project_alpha.md'), '恢复后又能检索到它')
  const report = await auditMemoryDir(memDir)
  ok(report.archivedLinks.length === 0 && !report.brokenLinks.some((x) => x.target === 'project_alpha'), '目标回到活动区后，链接两边都不报')
}

// ── 6. 拒绝矩阵（一律 { ok: false, error }，不许抛）──────────
group('6. 拒绝矩阵')
const rejects = async (label, fn, needle = '') => {
  let threw = null
  let res = null
  try { res = await fn() } catch (e) { threw = e }
  ok(threw === null && res?.ok === false && typeof res.error === 'string' && (!needle || res.error.includes(needle)),
    label, threw ? `抛了：${threw.message}` : JSON.stringify(res))
}
{
  await rejects('归档保留名 memory.md → 拒绝', () => gw.archive('memory.md', 'x'), 'reserved')
  await rejects('归档保留名 session-log.md → 拒绝', () => gw.archive('session-log.md', 'x'), 'reserved')
  await rejects('归档非 .md → 拒绝', () => gw.archive('notes.txt', 'x'), 'invalid file name')
  await rejects('归档带路径成分 → 拒绝', () => gw.archive('../evil.md', 'x'), 'invalid file name')
  await rejects('归档根目录里没有的文件 → 拒绝', () => gw.archive('nope.md', 'x'), 'not found')
  await rejects('恢复不在归档区里的文件 → 拒绝', () => gw.restore('project_beta.md'), 'not archived')
  await rejects('恢复保留名 → 拒绝', () => gw.restore('memory.md'), 'reserved')

  // 已是归档态时再次归档：根目录里已经没有它了 → 拒绝
  await gw.archive('project_beta.md', '先归档乙')
  await rejects('已归档的文件再 archive 一次 → 拒绝', () => gw.archive('project_beta.md', 'again'), 'not found')

  // 根目录已有同名时的 restore：绝不覆盖
  const before = '根目录新写的乙\n'
  writeFileSync(activePath('project_beta.md'), before, 'utf8')
  await rejects('根目录已有同名时的 restore → 拒绝（不覆盖）', () => gw.restore('project_beta.md'), 'refusing to overwrite')
  ok(readFileSync(activePath('project_beta.md'), 'utf8') === before, '被拒绝的 restore 没有动根目录那份文件')
  ok(existsSync(archivedPath('project_beta.md')), '被拒绝的 restore 也没动归档区那份')
}

// ── 7. YAML 标量转义（两个静默杀手）─────────────────────────
group('7. YAML 标量转义与留痕读写')
{
  ok(scan.yamlScalar('手动归档') === '手动归档', '普通值不加引号')
  ok(scan.yamlScalar('a: b') === "'a: b'", '含「冒号+空格」→ 加单引号')
  ok(scan.yamlScalar('a #b') === "'a #b'", '含「空格+#」→ 加单引号')
  ok(scan.yamlScalar('结尾冒号:') === "'结尾冒号:'", '结尾冒号也加引号（同为 YAML 歧义）')
  ok(scan.yamlScalar('') === "''", '空值写成一对单引号（裸写会变 null）')
  ok(scan.yamlScalar("it's") === "it's", '值中间的单引号不需要转义')
  ok(scan.yamlScalar("a: 'b'") === "'a: ''b'''", '加了引号时单引号按 YAML 规矩翻倍')

  const base = '---\nname: x\ntype: project\ndescription: d\n---\n\n# x\n\n正文\n'
  const added = scan.addArchiveMeta(base, '理由: 带冒号 # 带井号', '2026-01-02 03:04')
  const back = scan.readArchivedMeta(added)
  ok(back.archivedAt === '2026-01-02 03:04' && back.archivedReason === '理由: 带冒号 # 带井号',
    'addArchiveMeta → readArchivedMeta 逐字往返', JSON.stringify(back))
  ok(added.includes(base.trim()) || added.split('---').length === 3, '原有字段一行未动')
  const stripped = scan.stripArchiveMeta(added)
  ok(!/archived_/.test(stripped) && stripped.includes('description: d'), 'stripArchiveMeta 只去掉那两行')
  const noFm = scan.addArchiveMeta('没有 frontmatter 的正文\n', 'r', '2026-01-02 03:04')
  ok(/^---\narchived_at: 2026-01-02 03:04/.test(noFm) && noFm.includes('没有 frontmatter 的正文'), '没有 frontmatter 时补一个最小块')
  const crlf = '---\r\nname: y\r\n---\r\n\r\n正文\r\n'
  const crlfAdded = scan.addArchiveMeta(crlf, 'r', '2026-01-02 03:04')
  ok(crlfAdded.includes('\r\n') && !/[^\r]\n/.test(crlfAdded), 'CRLF 文件写回去仍是 CRLF（不改用户的换行风格）')
}

// ── 8. 真实输出过一遍 typert manifest 的 zod schema ──────────
group('8. 引擎真实输出 vs typert manifest 的 zod schema')
{
  const { TYPERT } = await import(new URL('typert.host.js', LIB).href)
  const schemaOf = (id) => TYPERT.invocations.find((i) => i.id === id)?.result?.schema
  const shape = (label, id, value) => {
    const r = schemaOf(id).safeParse(value)
    ok(r.success, label, r.success ? '' : JSON.stringify((r.error?.issues ?? []).slice(0, 3)))
  }
  const paramOf = (id, i) => TYPERT.invocations.find((x) => x.id === id).parameters[i].codec.schema

  shape('listArchived() 的真实输出符合 #ArchivedList', 'sage-mem#memory/listArchived', await gw.listArchived())
  shape('listStars(true) 的真实输出符合 #StarmapList', 'sage-mem#starmap/listStars', await starmap.listStars(true))
  shape('listStars() 的真实输出符合 #StarmapList', 'sage-mem#starmap/listStars', await starmap.listStars())

  const okArchive = await gw.archive('project_alpha.md', '')
  shape('archive 成功分支符合 #ArchiveResult', 'sage-mem#memory/archive', okArchive)
  const withDefault = (await gw.listArchived()).files.find((f) => f.file === 'project_alpha.md')
  ok(withDefault?.archivedReason === '手动归档', 'reason 省略/空串时写默认理由「手动归档」', String(withDefault?.archivedReason))
  // 失败分支回 { ok:false, error }、**没有 file** —— 这正是不能复用 file 必填的 writeResultSchema 的原因
  shape('archive 失败分支（无 file）也符合 #ArchiveResult', 'sage-mem#memory/archive', await gw.archive('nope.md', 'x'))
  shape('restore 成功分支符合 #ArchiveResult', 'sage-mem#memory/restore', await gw.restore('project_alpha.md'))
  shape('restore 失败分支符合 #ArchiveResult', 'sage-mem#memory/restore', await gw.restore('nope.md'))

  const reason = paramOf('sage-mem#memory/archive', 1)
  ok(reason.safeParse('随便: 一句 # 理由').success && reason.safeParse(undefined).success,
    'ArchiveReason 收字符串、也允许省略（可选）')
  ok(!reason.safeParse(123).success, 'ArchiveReason 拒绝非字符串')
  const inc = paramOf('sage-mem#starmap/listStars', 0)
  ok(inc.safeParse(true).success && inc.safeParse(undefined).success && !inc.safeParse('yes').success,
    'StarmapIncludeArchived 只收 boolean（可省略）')
}

// ── 9. reason 含换行的边界（独立探针逮到的那一维）────────────
group('9. reason 含换行：显式折叠成一行（不截断、不注入键、不提前闭合 frontmatter）')
{
  const base = '---\nname: demo\ndescription: 一句话\ntype: project\n---\n\n正文\n'
  const countOf = (text, re) => (text.match(re) || []).length
  const cases = [
    ['LF', '第一行\n第二行', '第一行 第二行'],
    ['CRLF', '第一行\r\n第二行', '第一行 第二行'],
    ['第二行伪装成键', '理由\narchived_reason: 假的\ntype: user', '理由 archived_reason: 假的 type: user'],
    ['第二行是分隔符', '理由\n---\n\n这里是正文外的内容', '理由 --- 这里是正文外的内容'],
  ]
  for (const [label, reason, folded] of cases) {
    const out = scan.addArchiveMeta(base, reason, '2026-10-08 21:00')
    const lines = out.split(/\r?\n/)
    const reasonLine = lines.find((l) => l.startsWith('archived_reason:'))
    const atLine = lines.find((l) => l.startsWith('archived_at:'))
    // ① 写出的是「带引号的单行」
    ok(reasonLine === `archived_reason: '${folded}'`, `[${label}] 写出带引号的单行`, String(reasonLine))
    // ② 读回折叠后的值（不是被静默截断的前半行）
    ok(scan.readArchivedMeta(out).archivedReason === folded,
      `[${label}] 读回折叠后的完整值（不是被截断的前半）`, JSON.stringify(scan.readArchivedMeta(out).archivedReason))
    // ③ 键不重复、不被注入
    ok(countOf(out, /^archived_reason:/gm) === 1 && countOf(out, /^archived_at:/gm) === 1 && countOf(out, /^type:/gm) === 1,
      `[${label}] archived_reason / archived_at / type 各恰好 1 次（没有第二行冒充成键）`,
      `reason=${countOf(out, /^archived_reason:/gm)} at=${countOf(out, /^archived_at:/gm)} type=${countOf(out, /^type:/gm)}`)
    // ④ frontmatter 没被提前闭合
    ok(countOf(out, /^---$/gm) === 2, `[${label}] frontmatter 仍是完整一块（恰好 2 个 ---）`, `有 ${countOf(out, /^---$/gm)} 个`)
    // ⑤ 原有字段与正文都还在
    const fm = mod.__testables.parseFrontmatter(out)
    ok(fm.name === 'demo' && fm.description === '一句话' && fm.type === 'project' && out.includes('正文'),
      `[${label}] 原 name/description/type 与正文都没被破坏`,
      JSON.stringify({ name: fm.name, desc: fm.description, type: fm.type }))
    // ⑥ archived_at 走同一个函数，行本身不含换行
    ok(typeof atLine === 'string' && !/[\r\n]/.test(atLine), `[${label}] archived_at 行本身不含换行`, String(atLine))
  }
  ok(scan.yamlScalar('2026-10-08 21:00\n2026-10-08 21:01') === "'2026-10-08 21:00 2026-10-08 21:01'",
    'archived_at 与 reason 共用同一个 yamlScalar（换行同样折叠）')
}

// ── 10. 归档文件的读 / 写 remote（readArchived / writeArchived）──
group('10. 归档文件的读 / 写：改正文但留痕不许丢')
{
  const NAME = 'project_beta.md' // 第 6 节归档的那份（留痕理由「先归档乙」）
  const before = await gw.readArchived(NAME)
  ok(before.name === NAME && before.content.includes('# project_beta.md'), 'readArchived 能读到归档文件全文')
  ok(/^archived_at: /m.test(before.content) && /^archived_reason: /m.test(before.content), '读到的内容里带着归档留痕')
  const metaBefore = scan.readArchivedMeta(before.content)

  // ① 整份回写（面板把 readArchived 的内容改完正文再写回来）
  const edited = before.content.replace('档案测试用乙', '档案测试用乙（改过）')
  const w = await gw.writeArchived(NAME, edited)
  ok(w.ok === true && w.file === NAME, 'writeArchived 返回 { ok: true, file }', JSON.stringify(w))
  const after = await gw.readArchived(NAME)
  ok(after.content.includes('改过') && after.content !== before.content, '再 readArchived 拿到的是新正文')
  const metaAfter = scan.readArchivedMeta(after.content)
  ok(metaAfter.archivedAt === metaBefore.archivedAt && metaAfter.archivedReason === metaBefore.archivedReason,
    '**archived_at / archived_reason 一条没被抹掉**', JSON.stringify({ before: metaBefore, after: metaAfter }))
  ok((after.content.match(/^archived_reason:/gm) || []).length === 1, '留痕没有被重复写成两份')
  const listed = (await gw.listArchived()).files.find((f) => f.file === NAME)
  ok(listed && listed.size === after.content.length, 'listArchived 的 size 随正文更新', `${listed?.size} vs ${after.content.length}`)
  ok(listed?.archivedReason === metaBefore.archivedReason, 'listArchived 的留痕仍是原来那条')
  const disk = readFileSync(archivedPath(NAME), 'utf8')
  ok(/^archived_at: /m.test(disk) && /^archived_reason: /m.test(disk), '盘上那份文件本身也留着两行留痕')

  // ② 最狠的一种：调用方交回一份**连留痕都没有**的内容（「重建 frontmatter」式编辑器）
  const bare = '---\nname: project_beta\ntype: project\ndescription: 档案测试用乙\n---\n\n# project_beta\n\n只改了正文\n'
  const w2 = await gw.writeArchived(NAME, bare)
  ok(w2.ok === true, 'writeArchived 接受不含留痕的内容', JSON.stringify(w2))
  const after2 = await gw.readArchived(NAME)
  ok(/^archived_at: /m.test(after2.content) && /^archived_reason: /m.test(after2.content),
    '留痕被按盘上原值补回（改正文抹不掉归档凭据）')
  ok(scan.readArchivedMeta(after2.content).archivedReason === metaBefore.archivedReason, '补回的正是原来那条理由')

  // ③ 拒绝矩阵：不许静默成功
  // 非法名字这一路与 writeFile 一致是**抛错**（不是 {ok:false}），其余闸门回 {ok:false}。
  const throws = async (label, fn, needle = '') => {
    let threw = null
    let res = null
    try { res = await fn() } catch (e) { threw = e }
    ok(threw !== null && String(threw.message).includes(needle),
      label, threw ? `抛错信息不对：${threw.message}` : `没抛，返回 ${JSON.stringify(res)}`)
  }
  const contentBefore = after2.content
  await rejects('writeArchived 归档区没有的名字 → {ok:false}', () => gw.writeArchived('nope.md', 'x'), 'not found')
  await throws('writeArchived 带路径成分 → 抛错', () => gw.writeArchived('../evil.md', 'x'), 'invalid file name')
  await throws('writeArchived 非 .md → 抛错', () => gw.writeArchived('notes.txt', 'x'), 'invalid file name')
  await rejects('writeArchived 保留名 → {ok:false}', () => gw.writeArchived('memory.md', 'x'), 'reserved')
  await rejects('writeArchived 内容不是字符串 → {ok:false}', () => gw.writeArchived(NAME, 123), 'must be a string')
  await rejects('writeArchived 超体积 → {ok:false}', () => gw.writeArchived(NAME, 'x'.repeat(512 * 1024 + 1)), 'too large')
  ok((await gw.readArchived(NAME)).content === contentBefore, '被拒绝的那几次一个字节都没写进去')

  let readThrew = null
  try { await gw.readArchived('nope.md') } catch (e) { readThrew = e }
  ok(readThrew !== null && /not found/.test(readThrew.message), 'readArchived 找不到 → 抛错（不静默返回空串）', String(readThrew?.message))
  let readInvalid = null
  try { await gw.readArchived('../evil.md') } catch (e) { readInvalid = e }
  ok(readInvalid !== null && /invalid file name/.test(readInvalid.message), 'readArchived 带路径成分 → 抛错', String(readInvalid?.message))

  // ④ 「归档 = 不删」：这两条 remote 之外不许有删除/出档的入口。
  // D1 起 memory 面从 9 条长到 16 条（audit / archiveCandidates / checkUpdate / getSettings /
  // setSettings / readRaw / writeRaw），契约面由 client-exec 的 29 条对表守着；这里仍然逐名列全，
  // 防的是「顺手加了个 deleteArchived」这种没人看出来的新入口。
  const methods = Object.getOwnPropertyNames(mod.MemoryGateway.prototype).filter((n) => n !== 'constructor' && !n.startsWith('@')).sort()
  ok(JSON.stringify(methods) === JSON.stringify([
    'archive', 'archiveCandidates', 'audit', 'checkUpdate', 'deleteFile', 'getSettings', 'listArchived', 'listFiles',
    'readArchived', 'readFile', 'readRaw', 'restore', 'setLocked', 'setSettings', 'writeArchived', 'writeFile', 'writeRaw',
  ]),
    'memory 面恰好 17 个方法，没有 deleteArchived 之类的新入口', methods.join(','))

  // ⑤ 真实输出过一遍 manifest schema
  const { TYPERT } = await import(new URL('typert.host.js', LIB).href)
  const schemaOf = (id) => TYPERT.invocations.find((i) => i.id === id)?.result?.schema
  const shape = (label, id, value) => {
    const r = schemaOf(id).safeParse(value)
    ok(r.success, label, r.success ? '' : JSON.stringify((r.error?.issues ?? []).slice(0, 3)))
  }
  shape('readArchived 的真实输出符合 #ArchivedFileContent', 'sage-mem#memory/readArchived', after2)
  shape('writeArchived 成功分支符合 #ArchivedWriteResult', 'sage-mem#memory/writeArchived', w2)
  shape('writeArchived 失败分支符合 #ArchivedWriteResult', 'sage-mem#memory/writeArchived', await gw.writeArchived('nope.md', 'x'))
}

// ── 11. 体检的三种假阳性 ──────────────────────────────────────
// 2026-10-09 在**真实记忆库**上实测到的：一个健康的库被报 3 条「问题」，三条全是假的
// （[[session-log]] 指向真实存在的文件、`[[双链]]` 是行内代码、MEMORY.md 是索引不是条目）。
// 这一组**正反两面都断言** —— 修假阳性最容易顺手把真问题一起遮掉，所以每条放行都配一条反面。
group('11. 体检假阳性：非条目文件 / 代码里的双链 / 索引无 frontmatter')
{
  writeFileSync(join(memDir, 'MEMORY.md'), '# 记忆索引\n\n- [项目](project_beta.md)\n', 'utf8')
  writeFileSync(join(memDir, 'session-log.md'),
    '---\nname: session-log\ntype: reference\ndescription: 流水\n---\n\n流水正文\n', 'utf8')
  writeFileSync(join(memDir, 'reference_talker.md'), [
    '---', 'name: reference_talker', 'type: reference', 'description: 讲链接语法', '---', '',
    '行内代码里的不算链接：`[[双链]]`。', '',
    // ⚠️ 双反引号那种写法（内容里还含反引号）—— 2026-10-09 在真实记忆库上漏过一次：
    // 只认单反引号的剥法会把它漏掉，照样报假断链。这一行就是那次的回归守卫。
    '双反引号包着的也不算：`` `[[multi_ghost]]` ``。', '',
    '```', '围栏代码块里的也不算：[[fenced_ghost]]', '```', '',
    '但正文里真不存在的目标仍要报：[[real_ghost]]。', '',
    '而指向非条目文件是真链接：[[session-log]] 与 [[MEMORY]]。', '',
  ].join('\n'), 'utf8')

  const r = await auditMemoryDir(memDir)

  // ① 非条目文件（session-log.md / MEMORY.md）也在链接目标池里
  ok(!r.brokenLinks.some((x) => x.target === 'session-log'),
    '[[session-log]] 不算断链：文件真实存在，只是不参与检索')
  ok(!r.brokenLinks.some((x) => x.target === 'MEMORY'),
    '[[MEMORY]] 同理（索引文件也是真实存在的目标）')
  // ② 代码里的双链不是链接
  ok(!r.brokenLinks.some((x) => x.target === '双链'),
    '行内代码 `[[双链]]` 不算断链（那是在讲链接语法）')
  ok(!r.brokenLinks.some((x) => x.target === 'fenced_ghost'),
    '围栏代码块里的 [[目标]] 也不算断链')
  ok(!r.brokenLinks.some((x) => x.target === 'multi_ghost'),
    '双反引号行内代码（`` `` `[[x]]` `` ``）里的也不算断链 —— 只认单反引号会漏掉这种')
  // ③ 索引没有 frontmatter 不是问题
  ok(!r.noFrontmatter.some((x) => x.file === 'MEMORY.md'),
    '索引 MEMORY.md 没有 frontmatter 不算问题（它是清单，不是一条记忆）')

  // ── 反面：放行了这三类，别把真问题一起遮掉 ──
  ok(r.brokenLinks.some((x) => x.target === 'real_ghost'),
    '代码之外的**真**悬空目标仍然报断链（没被顺手放过）')
  writeFileSync(join(memDir, 'reference_nofm.md'), '# 没有 frontmatter 的普通记忆\n\n正文\n', 'utf8')
  const r2 = await auditMemoryDir(memDir)
  ok(r2.noFrontmatter.some((x) => x.file === 'reference_nofm.md'),
    '普通记忆缺 frontmatter 仍然报（只放行索引，没放行全体）')

  for (const n of ['MEMORY.md', 'session-log.md', 'reference_talker.md', 'reference_nofm.md']) {
    rmSync(join(memDir, n), { force: true })
  }
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
