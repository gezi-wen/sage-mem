/**
 * D1 行为断言：面板 API 六条 remote（体检 / 归档候选 / 设置 / 保留名原样读写）。
 *
 * 全部只碰临时目录（SAGE_MEM_DIR / SAGE_MEM_STATE_DIR，必须在 import lib 之前设好）。
 * 重点守三件事：① 体检与候选**不另写一套实现**；② 设置项的「已生效 vs 待生效」诚实；
 * ③ 保留名原样读写：逐字节进、逐字节出，且体积上限**不是** 512 KB。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = join(tmpdir(), `sage-mem-panel-test-${process.pid}`)
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
mkdirSync(memDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
mkdirSync(join(sandbox, 'dsh-home'), { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const LIB = new URL('../lib/', import.meta.url)
const mod = await import(new URL('index.js', LIB).href)
const access = await import(new URL('memory/access.js', LIB).href)
const scan = await import(new URL('memory/scan.js', LIB).href)
const { auditMemoryDir } = await import(new URL('autodream-audit.js', LIB).href)
const { DEFAULT_CONFIG } = await import(new URL('autodream/config.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)
const SETTINGS_FILE = join(stateDir, 'settings.json')
const RESERVED_FILE = join(stateDir, 'reserved.json')
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

/** 假 ctx（cordis 的 Service 构造要 ctx.reflect.*，未知成员给可调用的桩）。 */
function makeCtx() {
  const base = { on: () => {}, get: () => undefined, logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }, effect: () => {} }
  let stub
  stub = new Proxy(function () {}, { get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined), apply: () => undefined })
  return new Proxy(base, { get(t, p) { return p in t ? t[p] : stub } })
}

const gw = new mod.default(makeCtx())

// ── 夹具：故意造出三类审计问题 ────────────────────────────────
writeFileSync(join(memDir, 'project_x.md'), '---\nname: x\ntype: project\ndescription: 一条正常记忆\n---\n\n# x\n\n正文\n', 'utf8')
writeFileSync(join(memDir, 'project_crlf.md'), '---\r\nname: crlf\r\ntype: project\r\n---\r\n\r\n# crlf\r\n\r\nCRLF 正文\r\n', 'utf8')
writeFileSync(join(memDir, 'project_linker.md'), '---\nname: linker\ntype: project\n---\n\n# linker\n\n见 [[missing_target]]\n', 'utf8')
writeFileSync(join(memDir, 'project_old.md'), `---\nname: old\ntype: project\nupdated: ${daysAgo(200)}\n---\n\n# old\n\n很久没用了\n`, 'utf8')
writeFileSync(join(memDir, 'MEMORY.md'), '---\nname: memory\n---\n\n# 索引\n\n- [悬空](missing.md)\n', 'utf8')
writeFileSync(join(memDir, 'session-log.md'), '# 流水\n\n旧内容\n', 'utf8')

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const allHashes = () => Object.fromEntries(readdirSync(memDir).filter((f) => f.endsWith('.md')).map((f) => [f, sha256(join(memDir, f))]))

// ── 1. audit：如实报问题 + 一个字节都不改 ────────────────────
group('1. audit()：如实报出问题，且一个文件都没被改')
{
  const before = allHashes()
  const report = await gw.audit()
  const after = allHashes()
  ok(JSON.stringify(before) === JSON.stringify(after), '体检前后所有记忆文件 sha256 全等（只读）')
  ok(report.problems > 0, '人为制造的问题被报出来了', `problems=${report.problems}`)
  ok(report.unlisted.some((r) => r.file === 'project_x.md'), '「漏索引」里能看到 project_x.md', JSON.stringify(report.unlisted))
  ok(report.crlf.some((r) => r.file === 'project_crlf.md'), '「CRLF」里能看到 project_crlf.md', JSON.stringify(report.crlf))
  ok(report.dangling.some((r) => r.file === 'missing.md'), '「索引悬空」里能看到 missing.md', JSON.stringify(report.dangling))
  ok(report.brokenLinks.some((r) => r.file === 'project_linker.md' && r.target === 'missing_target'),
    '「双链断链」里能看到 project_linker.md → missing_target', JSON.stringify(report.brokenLinks))
  // 与复用实现同源：同一时刻直接调 auditMemoryDir 必须逐字节相同
  const direct = await auditMemoryDir(memDir)
  ok(JSON.stringify(report) === JSON.stringify(direct), 'audit() 与 auditMemoryDir() 的输出完全一致（没有第二套检查）')
}

// ── 2. archiveCandidates：与纯函数同源、阈值取配置 ───────────
group('2. archiveCandidates()：与 access.js 的纯函数同源')
{
  const res = await gw.archiveCandidates()
  const files = await scan.scanMemoryFiles(makeCtx(), '')
  const ledger = await access.readAccessLedger()
  const thresholds = {
    project: DEFAULT_CONFIG.archiveAfterDaysProject,
    reference: DEFAULT_CONFIG.archiveAfterDaysReference,
    user: DEFAULT_CONFIG.archiveAfterDaysUser,
  }
  const direct = access.pickArchiveCandidates(files, ledger, { thresholds })
  ok(JSON.stringify(res.candidates) === JSON.stringify(direct), 'candidates 与 pickArchiveCandidates 同源（同一份输入两边一致）')
  ok(res.count === direct.length, 'count 与清单长度一致')
  ok(res.candidates.some((c) => c.file === 'project_old.md'), '200 天没用的 project 进了候选', JSON.stringify(res.candidates))
  ok(res.autoArchive === 'report', '回传当前策略（默认 report）', String(res.autoArchive))
  ok(JSON.stringify(res.thresholds) === JSON.stringify(thresholds), '回传实际阈值（取自配置）', JSON.stringify(res.thresholds))
}

// ── 3. getSettings：默认值 / 已生效 vs 待生效 / 环境变量 ─────
group('3. getSettings()：默认值、已生效值 vs 待生效值、环境变量优先级')
{
  const s = await gw.getSettings()
  const builtin = { maxResults: 10, maxChars: 1500, maxBaseline: 8, maxSessionBytes: 60 * 1024, staleDays: 1 }
  ok(JSON.stringify(s.limits) === JSON.stringify(builtin), 'limits 与内置默认逐项相等', JSON.stringify(s.limits))
  ok(JSON.stringify(s.pendingLimits) === JSON.stringify(builtin), '没有任何覆盖时 pendingLimits 也等于默认')
  ok(s.restartRequired === false, '一切与已生效值一致时不喊重启')
  ok(Array.isArray(s.reserved) && s.reserved.includes('memory.md') && s.reserved.includes('session-log.md'),
    'reserved 至少含两个内置保护名', JSON.stringify(s.reserved))

  // 环境变量 > 默认：进程里现设一个（模块常量已固化，所以只会体现在 pending 上）
  process.env.SAGE_MEM_MAX_RESULTS = '7'
  const s2 = await gw.getSettings()
  ok(s2.pendingLimits.maxResults === 7 && s2.limits.maxResults === 10,
    '环境变量进 pendingLimits，已生效值不变（模块加载时固化）', JSON.stringify({ pending: s2.pendingLimits.maxResults, active: s2.limits.maxResults }))
  ok(s2.restartRequired === true, '两者不一致时 restartRequired=true（不骗用户说立刻生效）')

  // settings.json > 环境变量
  const set = await gw.setSettings({ limits: { maxResults: 12 } })
  ok(set.ok === true && set.restartRequired === true, 'setSettings 写盘成功并提示重启', JSON.stringify({ ok: set.ok, rr: set.restartRequired }))
  ok(existsSync(SETTINGS_FILE) && JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).limits.maxResults === 12, '落到 <状态根>/settings.json')
  const s3 = await gw.getSettings()
  ok(s3.pendingLimits.maxResults === 12 && s3.limits.maxResults === 10,
    '文件优先于环境变量（12 而不是 7），已生效值仍是 10', JSON.stringify(s3.pendingLimits))
  ok(JSON.stringify(set.settings.pendingLimits) === JSON.stringify(s3.pendingLimits), 'setSettings 回传的 settings 与随后 getSettings 一致')
  delete process.env.SAGE_MEM_MAX_RESULTS
}

// ── 4. setSettings：非法值拒绝且不写盘 ───────────────────────
group('4. setSettings()：非法值一律拒绝、文件一个字节都不动')
{
  const before = readFileSync(SETTINGS_FILE, 'utf8')
  const cases = [
    ['超范围', { limits: { maxResults: 999 } }, 'must be an integer'],
    ['低于下限', { limits: { maxChars: 1 } }, 'must be an integer'],
    ['类型不对', { limits: { staleDays: '三天' } }, 'must be a number'],
    ['未知项', { limits: { nope: 1 } }, 'unknown setting'],
    ['reserved 不是数组', { reserved: 'x.md' }, 'must be an array'],
    ['reserved 带路径', { reserved: ['a/b.md'] }, 'invalid reserved file name'],
    ['空补丁', {}, 'empty patch'],
  ]
  for (const [label, patch, needle] of cases) {
    let res = null
    let threw = null
    try { res = await gw.setSettings(patch) } catch (e) { threw = e }
    ok(threw === null && res?.ok === false && String(res.error).includes(needle),
      `非法值被拒（${label}）`, threw ? `抛了 ${threw.message}` : JSON.stringify(res))
  }
  ok(readFileSync(SETTINGS_FILE, 'utf8') === before, '被拒的这批一次都没写盘（settings.json 逐字节未变）')

  // reserved 合法写入 +「改了要重启」的诚实体现
  const set = await gw.setSettings({ reserved: ['my_secret.md'] })
  ok(set.ok === true, '写入 reserved 成功', JSON.stringify(set).slice(0, 120))
  const s = await gw.getSettings()
  ok(JSON.stringify(s.reservedExtra) === JSON.stringify(['my_secret.md']), 'reservedExtra 原样读回', JSON.stringify(s.reservedExtra))
  ok(s.reserved.includes('my_secret.md') && s.restartRequired === true, '生效清单里算上它、并提示重启')
  // 未重启前 isReserved 还是旧的那份 → readRaw 不该放行（诚实：设置要重启才生效）
  const r = await gw.readRaw('my_secret.md')
  ok(r.ok === false, '未重启前 readRaw 不认新加的保护名（设置要重启才生效）', JSON.stringify(r))
}

// ── 5. readRaw：原样读、只对保留名开口 ──────────────────────
group('5. readRaw()：保留名原样读、普通记忆被拒')
{
  const disk = readFileSync(join(memDir, 'MEMORY.md'), 'utf8')
  const r = await gw.readRaw('MEMORY.md')
  ok(r.name === 'MEMORY.md' && r.content === disk, '读到 MEMORY.md 且逐字节等于盘上内容')
  const sl = await gw.readRaw('session-log.md')
  ok(sl.name === 'session-log.md' && sl.content.includes('旧内容'), 'session-log.md 也读得到')
  const bad = await gw.readRaw('project_x.md')
  ok(bad.ok === false && /readFile|form/.test(String(bad.error)), '普通记忆 → {ok:false} 且文案指路', JSON.stringify(bad))
  let threw = null
  try { await gw.readRaw('memory.md') } catch (e) { threw = e }
  ok(threw === null, '保留名用大小写变体也读得到（NTFS 不区分大小写）')
  // 读不到要抛（与 readFile 一致）
  rmSync(join(memDir, 'session-log.md'))
  let missingThrew = null
  try { await gw.readRaw('session-log.md') } catch (e) { missingThrew = e }
  ok(missingThrew !== null, '保留名读不到 → 抛错（不静默返回空串）', String(missingThrew?.message))
}

// ── 6. writeRaw：大文件能存、原样、非保留名被拒 ──────────────
group('6. writeRaw()：>512KB 能存、逐字节原样、非保留名被拒')
{
  // ① 守那个上限坑：600 KB > MAX_FILE_BYTES(512 KB)，但必须写得进去
  const big = `# 流水\n${'甲'.repeat(200 * 1024)}\n` // 中文 3 字节/字 → 约 600 KB
  ok(Buffer.byteLength(big, 'utf8') > 512 * 1024, '前置：这段内容确实超过 512 KB', String(Buffer.byteLength(big, 'utf8')))
  const w = await gw.writeRaw('session-log.md', big)
  ok(w.ok === true && w.file === 'session-log.md', '大内容写得进去（上限不是 512 KB）', JSON.stringify(w))
  const back = await gw.readRaw('session-log.md')
  ok(back.content === big, '写回后逐字节相同')
  ok(statSync(join(memDir, 'session-log.md')).size === Buffer.byteLength(big, 'utf8'), '盘上字节数与写入一致')

  // ② 绝不重建 frontmatter：奇怪缩进 / 注释 / 重复键都原样
  const weird = '---\nname:   memory\n# 这是注释\nmetadata:\n    node_type: memory\n\ttype:\tproject\n---\n\n# 索引\n\n- 缩进   保留\n\n\n'
  const w2 = await gw.writeRaw('MEMORY.md', weird)
  ok(w2.ok === true, '奇怪文本写得进去', JSON.stringify(w2))
  const back2 = await gw.readRaw('MEMORY.md')
  ok(back2.content === weird, '逐字节原样读回（没有 frontmatter 重建）')
  ok(readFileSync(join(memDir, 'MEMORY.md'), 'utf8') === weird, '盘上也是逐字节相同')

  // ③ 非保留名被拒 + 目标文件未被碰
  const xBefore = readFileSync(join(memDir, 'project_x.md'), 'utf8')
  const bad = await gw.writeRaw('project_x.md', '改掉你')
  ok(bad.ok === false && /readFile|form/.test(String(bad.error)), '普通记忆 → {ok:false}', JSON.stringify(bad))
  ok(readFileSync(join(memDir, 'project_x.md'), 'utf8') === xBefore, '被拒的写入没有碰那个文件')

  // ④ 独立的大上限：超过 4 MB 才拒，且文案能看出是哪个上限
  const tooBig = 'x'.repeat(4 * 1024 * 1024 + 1)
  const over = await gw.writeRaw('session-log.md', tooBig)
  ok(over.ok === false && /raw limit/.test(String(over.error)), '超过 4 MB 才拒，文案写明 raw limit', JSON.stringify(over).slice(0, 160))
  ok((await gw.readRaw('session-log.md')).content === big, '越界的写入没有落盘（还是上一份内容）')
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
