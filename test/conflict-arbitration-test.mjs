#!/usr/bin/env node
/**
 * conflict-arbitration-test.mjs — 2.0.0「裁决写盘」的断言。
 *
 * 这一层直接改**用户的记忆文件**，所以每条断言都对着一条数据风险：
 *   · **只加/删两行**：键顺序、缩进、CRLF、正文逐字节不变（`docs/2.0.0-plan.md` §4.1 R5）；
 *   · **不改 `updated`**：失效不是「文件被改过」，改了会让新鲜度提示说谎（§5.5）；
 *   · **版本守卫必须是「读到内容那一刻」的版本**：写时 `expected` 逐字钉住 ——
 *     拿「现在」的版本冒充「读到的」版本，等于替调用方担保（R01 教训）；
 *   · **幂等**：同一份标记连写两次，第二次不写盘、不报错（§5.5）；
 *   · **失败不半份**：版本过期 / 沙箱拒绝 / 无 fs / 文件没了 / 文件名非法，各有专属错误码，
 *     且磁盘在这几种情况下**一个字节都不动**。
 *
 * 夹具是混合的：**真临时文件**（`inspectMemoryEntry` 与 `readVerified` 走真盘）
 * + **内存 fs 桩**（`resolve` / `stat` / `readText` / `writeText`）。桩负责三件真宿主才有的事：
 * 版本号可控、`writeText` 收到的 `expected` / `sandboxPolicy` 可记录、失败码可控。
 * 注意 `readForWrite` 是 stat → 读 → 再 stat 比对版本，**两次 stat 之间桩不能自己改版本**，
 * 否则会被判 stale —— 那条路径本身也做成了一条断言。
 *
 * 用法: node test/conflict-arbitration-test.mjs
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

// ── 沙箱：环境变量必须在 import 之前（config.js 在模块顶层读它）──
const world = await mkdtemp(join(tmpdir(), 'sage-mem-arbitration-'))
const memoryDir = join(world, 'memory')
process.env.SAGE_MEM_DIR = memoryDir
process.env.SAGE_MEM_STATE_DIR = join(world, '.sage-mem')
process.env.DSH_HOME = join(world, 'dsh-home')
await mkdir(memoryDir, { recursive: true })
await mkdir(process.env.SAGE_MEM_STATE_DIR, { recursive: true })

const { upsertValidityLines, removeValidityLines, invalidateMemory, undoMemoryInvalidation } =
  await import(new URL('../lib/memory/arbitrate.js', import.meta.url).href)

const INVALID_AT = '2026-10-24T18:30:00+08:00'
const readDisk = (name) => readFile(join(memoryDir, name), 'utf8')
const seed = (name, content) => writeFile(join(memoryDir, name), content, 'utf8')

/** 把 `{displayPath}` 解回路径：宿主契约里 stat / readText / writeText 收的是 FsTarget 对象。 */
const pathOf = (p) => (p && typeof p === 'object' ? p.displayPath : p)

/**
 * 内存 fs 桩。
 *
 * @param {object} [opts]
 * @param {string} [opts.version] — 初始版本号
 * @param {string[]} [opts.statVersions] — 按调用次序返回的版本（用于「读的两次 stat 之间被改过」）
 * @param {boolean} [opts.statMissing] — stat 返回 undefined（宿主说文件没了）
 * @param {Error} [opts.writeError] — writeText 抛这个错（版本过期 / 沙箱拒绝 / IO 失败）
 * @param {boolean} [opts.missingFs] — 不提供 fs 服务（模拟旧宿主）
 */
function makeHost(opts = {}) {
  const state = { version: opts.version ?? 'v1', calls: [], writes: [], statCount: 0 }
  const fs = {
    resolve: async (p) => {
      state.calls.push('resolve')
      return { displayPath: p, targetKey: `k:${p}` }
    },
    stat: async () => {
      state.statCount++
      state.calls.push(`stat:${state.statCount}`)
      if (opts.statMissing) return undefined
      const v = opts.statVersions
        ? opts.statVersions[Math.min(state.statCount - 1, opts.statVersions.length - 1)]
        : state.version
      return { version: v, type: 'file' }
    },
    readText: async () => '',
    writeText: async (target, content, expected, _encoding, sandboxPolicy) => {
      state.calls.push('writeText')
      state.writes.push({ target, content, expected, sandboxPolicy })
      if (opts.writeError) throw opts.writeError
      // 真宿主的成功副作用：盘上内容变了、版本号前进。
      await writeFile(pathOf(target), content, 'utf8')
      state.version = 'v-next'
      return { operation: 'update', version: 'v-next', before: '', after: content }
    },
  }
  return { state, fs: opts.missingFs ? undefined : fs }
}

/** 假 ctx：只提供裁决路径会问的两个服务。 */
function makeCtx({ fs, policy = 'workspace-write' } = {}) {
  return {
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    get(name) {
      if (name === 'fs') return fs
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: policy }) }
      return undefined
    },
  }
}

const hostError = (code, message = '宿主拒绝') => Object.assign(new Error(message), { code })

/** 一份正常的记忆正文：frontmatter 有几个键（用来验「不删别的键」）+ 带空行的正文。 */
const BASE = '---\nname: project_a\ntype: project\nupdated: 2026-10-01\ntags: [alpha, beta]\n---\n\n# 标题\n\n正文第一段。\n\n正文第二段。\n'
const BASE_WITH_MARKERS = '---\nname: project_a\ntype: project\nupdated: 2026-10-01\ninvalid_at: 2026-10-01T00:00:00Z\nsuperseded_by: project_b.md\ntags: [alpha]\n---\n\n# 标题\n\n正文。\n'
const BASE_WITH_MARKERS_CLEAN = '---\nname: project_a\ntype: project\nupdated: 2026-10-01\ntags: [alpha]\n---\n\n# 标题\n\n正文。\n'

group('0. 前置：导出面')
{
  ok([upsertValidityLines, removeValidityLines, invalidateMemory, undoMemoryInvalidation]
    .every((f) => typeof f === 'function'),
    'arbitrate.js 的四个接口都已导出')
}

group('1. upsertValidityLines：只追加两行，别的字节不动')
{
  const out = upsertValidityLines(BASE, { invalidAt: INVALID_AT })
  const expected = '---\nname: project_a\ntype: project\nupdated: 2026-10-01\ntags: [alpha, beta]\n' +
    `invalid_at: ${INVALID_AT}\n---\n\n# 标题\n\n正文第一段。\n\n正文第二段。\n`
  ok(out.ok === true && out.changed === true, '正常写入返回 ok + changed')
  ok(out.content === expected, '逐字节符合预期：新行追加在 frontmatter 末尾，正文与空行原样',
    JSON.stringify(out.ok ? out.content : out))
  ok(out.content.includes('name: project_a\ntype: project\nupdated: 2026-10-01\ntags: [alpha, beta]'),
    '【反向对照】原有键顺序 / 内容一个都没动')
  ok(out.content.includes(`invalid_at: ${INVALID_AT}\n---`), '新行在闭合 `---` 之前（没有跑到正文里）')

  // superseded_by 可选：不给就只写一行，不给老实说「我没写」。
  const onlyAt = upsertValidityLines(BASE, { invalidAt: INVALID_AT })
  ok(!onlyAt.content.includes('superseded_by'), 'superseded_by 未给 → 不写这一行（可选字段不伪造）')
  const withSup = upsertValidityLines(BASE, { invalidAt: INVALID_AT, supersededBy: 'project_b.md' })
  ok(withSup.content.includes(`invalid_at: ${INVALID_AT}\nsuperseded_by: project_b.md\n---`),
    '给了 superseded_by → 紧跟 invalid_at 一行，仍插在 frontmatter 末尾',
    JSON.stringify(withSup.ok ? withSup.content.split('\n').slice(0, 8) : withSup))

  // CRLF：用 Windows 编辑器碰过一次的文件必须原样回来（1.6.x 那次「CRLF 让记忆检索不到」）。
  const crlf = BASE.replace(/\n/g, '\r\n')
  const crlfOut = upsertValidityLines(crlf, { invalidAt: INVALID_AT, supersededBy: 'project_b.md' })
  const crlfExpected = '---\r\nname: project_a\r\ntype: project\r\nupdated: 2026-10-01\r\ntags: [alpha, beta]\r\n' +
    `invalid_at: ${INVALID_AT}\r\nsuperseded_by: project_b.md\r\n---\r\n\r\n# 标题\r\n\r\n正文第一段。\r\n\r\n正文第二段。\r\n`
  ok(crlfOut.content === crlfExpected, 'CRLF 文件逐字节保真（换行风格不被悄悄改成 LF）',
    JSON.stringify(crlfOut.ok ? crlfOut.content : crlfOut))
  ok(!/(^|[^\r])\n/.test(crlfOut.content), '输出里没有混进裸 LF（换行风格统一）')

  // 幂等：把输出再喂一次，内容不变、changed:false —— 「已经标过」不该被当成失败。
  const again = upsertValidityLines(out.content, { invalidAt: INVALID_AT })
  ok(again.ok === true && again.changed === false && again.content === out.content,
    '重复 upsert 同一份标记 → changed:false、内容不变（不会长出第二行）',
    JSON.stringify(again.ok ? { changed: again.changed } : again))
  ok(again.content.match(/invalid_at:/g).length === 1, '【反向对照】文件里只有一行 invalid_at')

  // 先剥后插：旧的两行被替换而不是叠加；不带 superseded_by 时旧的也一并清掉
  // （失效标记是**一个整体**，不能留一半旧指针）。
  const replaced = upsertValidityLines(BASE_WITH_MARKERS, { invalidAt: '2026-11-01T00:00:00Z' })
  ok(replaced.content.includes('invalid_at: 2026-11-01T00:00:00Z') &&
    !replaced.content.includes('2026-10-01T00:00:00Z') && !replaced.content.includes('project_b.md'),
    '已有标记 → 旧值被替换（同一份文件里不会出现两个 invalid_at）',
    JSON.stringify(replaced.ok ? replaced.content : replaced))
  ok((replaced.content.match(/invalid_at:/g) ?? []).length === 1, '替换后 invalid_at 仍只有一行')

  // 没有 frontmatter：补一个最小块，正文原样跟在后面（拒绝标记＝面板点了没反应，更坏）。
  const raw = upsertValidityLines('# 只有正文\n\n第二行\n', { invalidAt: INVALID_AT })
  ok(raw.content === `---\ninvalid_at: ${INVALID_AT}\n---\n\n# 只有正文\n\n第二行\n`,
    '没有 frontmatter → 补最小块 + 空行，正文逐字节保留', JSON.stringify(raw.ok ? raw.content : raw))

  // 参数闸门：空值 / 非字符串都拒绝（静默写一个 `invalid_at: ` 空行会让解析层把它当「未标注」）。
  ok(upsertValidityLines(BASE, { invalidAt: '' }).ok === false &&
    upsertValidityLines(BASE, { invalidAt: '   ' }).ok === false,
    'invalidAt 为空 / 全空白 → invalid（不许写一个没有值的标记）')
  ok(upsertValidityLines(null, { invalidAt: INVALID_AT }).ok === false,
    '内容不是字符串 → invalid（不把 null 当空文件拼）')
}

group('2. removeValidityLines：撤销只删这两行')
{
  const out = removeValidityLines(BASE_WITH_MARKERS)
  const expected = '---\nname: project_a\ntype: project\nupdated: 2026-10-01\ntags: [alpha]\n---\n\n# 标题\n\n正文。\n'
  ok(out.ok === true && out.changed === true, '有标记 → 删除并报告 changed')
  ok(out.content === expected, '逐字节符合预期：只少两行，updated / tags / 正文都原样',
    JSON.stringify(out.ok ? out.content : out))
  ok(out.content.includes('updated: 2026-10-01') && out.content.includes('tags: [alpha]'),
    '【反向对照】`updated` 与其它 frontmatter 键都没被删')

  const clean = removeValidityLines(BASE)
  ok(clean.ok === true && clean.changed === false && clean.content === BASE,
    '没有标记 → changed:false、内容逐字节相同（幂等）')
  const noFm = removeValidityLines('# 只有正文\n')
  ok(noFm.ok === true && noFm.changed === false && noFm.content === '# 只有正文\n',
    '没有 frontmatter → 原样返回（不凭空造块）')

  // CRLF 保真。
  const crlfOut = removeValidityLines(BASE_WITH_MARKERS.replace(/\n/g, '\r\n'))
  ok(crlfOut.ok === true && crlfOut.content === BASE_WITH_MARKERS_CLEAN.replace(/\n/g, '\r\n'),
    'CRLF 文件撤销后逐字节还原（换行风格不变）', JSON.stringify(crlfOut.ok ? crlfOut.content : crlfOut))

  // 只删顶层那两行：metadata 嵌套的同名键、前缀相似的键都不许碰。
  const tricky = '---\nname: a\nmetadata:\n  invalid_at: 嵌套里的不是我们的\ninvalid_at_extra: keep\n---\n\n正文\n'
  const trickyOut = removeValidityLines(tricky)
  ok(trickyOut.ok === true && trickyOut.changed === false && trickyOut.content === tricky,
    '【反向对照】只删**顶层**的 invalid_at / superseded_by：metadata 嵌套与 invalid_at_extra 原样',
    JSON.stringify(trickyOut.ok ? trickyOut.content : trickyOut))

  ok(removeValidityLines(null).ok === false, '内容不是字符串 → invalid')
}

group('3. invalidateMemory：正常路径（版本守卫 + 沙箱策略 + 收据）')
{
  await seed('project_a.md', BASE)
  const host = makeHost({ version: 'v-read' })
  const ctx = makeCtx({ fs: host.fs })
  const res = await invalidateMemory({ ctx, memoryDir }, { file: 'project_a.md', invalidAt: INVALID_AT })
  ok(res.ok === true && res.wrote === true, '写入成功且如实报告 wrote:true', JSON.stringify(res))
  ok(res.file === 'project_a.md' && res.invalidAt === INVALID_AT, '收据带文件名与写的值', JSON.stringify(res))
  ok(res.version === 'v-next', '收据带宿主返回的**写后**版本（不是写前版本）', JSON.stringify(res.version))
  ok(host.state.writes.length === 1, '只调用一次 writeText（没有试写 / 重试）', String(host.state.writes.length))

  const expected = host.state.writes[0]?.expected
  ok(expected && expected.kind === 'replaceIfVersion', '传出去的是 replaceIfVersion 守卫',
    JSON.stringify(expected))
  ok(expected?.version === 'v-read', '【关键】守卫里是**读到内容那一刻**的版本（v-read），不是写时的版本',
    JSON.stringify(expected))
  const sandbox = host.state.writes[0]?.sandboxPolicy
  ok(sandbox && sandbox.mode === 'workspace-write' && sandbox.workspaceRoot === memoryDir,
    '逐次沙箱策略收窄到记忆目录（mode + workspaceRoot）', JSON.stringify(sandbox))

  const onDisk = await readDisk('project_a.md')
  ok(onDisk === upsertValidityLines(BASE, { invalidAt: INVALID_AT }).content,
    '落盘内容 = 纯函数的结果（写路径没有另一套拼法）')
  ok(onDisk.includes('updated: 2026-10-01'), '【反向对照】`updated` 一个字节都没改（失效不是「被改过」）')
  ok(onDisk.includes('正文第一段。') && onDisk.includes('tags: [alpha, beta]'),
    '【反向对照】正文与其它 frontmatter 键原样')

  // superseded_by 可选：一次写两行。
  await seed('project_sup.md', BASE)
  const host2 = makeHost({ version: 'v1' })
  const res2 = await invalidateMemory({ ctx: makeCtx({ fs: host2.fs }), memoryDir },
    { file: 'project_sup.md', invalidAt: INVALID_AT, supersededBy: 'project_b.md' })
  ok(res2.ok === true && (await readDisk('project_sup.md')).includes(`superseded_by: project_b.md`),
    'supersededBy 给了 → 两行一起写（撤销时也一起清）')
}

group('4. invalidateMemory：幂等（第二次不写盘）')
{
  // 上一条已经把 project_a.md 标过：再标一次（值相同）不该重写。
  const before = await readDisk('project_a.md')
  const host = makeHost({ version: 'v-now' })
  const res = await invalidateMemory({ ctx: makeCtx({ fs: host.fs }), memoryDir },
    { file: 'project_a.md', invalidAt: INVALID_AT })
  ok(res.ok === true && res.wrote === false,
    '【反向对照】同状态重复点不重写：已标过 → ok + wrote:false（不报错，也不假装写了一次）', JSON.stringify(res))
  ok(host.state.writes.length === 0, '【反向对照】幂等时一次 writeText 都没调', String(host.state.writes.length))
  ok(await readDisk('project_a.md') === before, '磁盘内容逐字节不变（版本号也没必要前进）')
}

group('5. invalidateMemory：错误码与「失败时磁盘不动」')
{
  const seedFile = async (name) => { await seed(name, BASE); return name }

  // ① 宿主报版本过期（CAS 失败）：这是最真实的一种 —— 读之后有人改了文件。
  const name1 = await seedFile('project_stale.md')
  const host1 = makeHost({ version: 'v1', writeError: hostError('FS_STALE_VERSION') })
  const r1 = await invalidateMemory({ ctx: makeCtx({ fs: host1.fs }), memoryDir }, { file: name1, invalidAt: INVALID_AT })
  ok(r1.ok === false && r1.code === 'stale_version', 'FS_STALE_VERSION → code:stale_version', JSON.stringify(r1))
  ok(await readDisk(name1) === BASE, '【反向对照】版本过期 → 磁盘一个字节没动')
  ok(host1.state.writes[0]?.expected?.version === 'v1', '被拒的那次写也确实带了读到时的版本（不是不带守卫就扔出去）')

  // ② 读的两次 stat 之间版本变了 → 我们自己判 stale，根本不该发起写。
  const name2 = await seedFile('project_raced.md')
  const host2 = makeHost({ statVersions: ['v1', 'v2'] })
  const r2 = await invalidateMemory({ ctx: makeCtx({ fs: host2.fs }), memoryDir }, { file: name2, invalidAt: INVALID_AT })
  ok(r2.ok === false && r2.code === 'stale_version', 'read → stat 之间被改过 → stale_version（R01 的读时版本绑定）',
    JSON.stringify(r2))
  ok(host2.state.writes.length === 0, '【反向对照】判 stale 时没有发起写入')
  ok(await readDisk(name2) === BASE, '磁盘内容不变')

  // ③ 沙箱拒绝。
  const name3 = await seedFile('project_denied.md')
  const host3 = makeHost({ version: 'v1', writeError: hostError('FS_SANDBOX_DENIED') })
  const r3 = await invalidateMemory({ ctx: makeCtx({ fs: host3.fs }), memoryDir }, { file: name3, invalidAt: INVALID_AT })
  ok(r3.ok === false && r3.code === 'write_denied', 'FS_SANDBOX_DENIED → code:write_denied（面板据此给诊断出路）',
    JSON.stringify(r3))
  ok(await readDisk(name3) === BASE, '【反向对照】沙箱拒绝 → 磁盘不动')

  // ④ 宿主是 read-only：不翻案、也不假装成功 —— 逐次策略收窄不到 workspace-write 就不传。
  const name4 = await seedFile('project_readonly.md')
  const host4 = makeHost({ version: 'v1' })
  const r4 = await invalidateMemory({ ctx: makeCtx({ fs: host4.fs, policy: 'read-only' }), memoryDir },
    { file: name4, invalidAt: INVALID_AT })
  ok(host4.state.writes[0]?.sandboxPolicy === undefined,
    'read-only 宿主 → 不传收窄策略（不绕过围栏）', JSON.stringify(host4.state.writes[0]?.sandboxPolicy))
  ok(r4.ok === true && r4.wrote === true, '策略不传时写入仍由宿主裁决（这里桩放行 → 成功，成败归宿主）')

  // ⑤ 其它 IO 失败。
  const name5 = await seedFile('project_io.md')
  const host5 = makeHost({ version: 'v1', writeError: hostError('ENOSPC', '磁盘满了') })
  const r5 = await invalidateMemory({ ctx: makeCtx({ fs: host5.fs }), memoryDir }, { file: name5, invalidAt: INVALID_AT })
  ok(r5.ok === false && r5.code === 'io_error', '其它写失败 → io_error（不冒充 stale / denied）', JSON.stringify(r5))

  // ⑥ 旧宿主没有 fs 服务：只能手工编辑，不许自己拿 node:fs 兜底偷偷写。
  const r6 = await invalidateMemory({ ctx: makeCtx({ fs: undefined }), memoryDir },
    { file: 'project_a.md', invalidAt: INVALID_AT })
  ok(r6.ok === false && r6.code === 'unsupported', '没有 fs 服务 → unsupported（旧宿主降级口径）', JSON.stringify(r6))

  // ⑦ 文件不存在 / stat 说没了。
  const host7 = makeHost({ version: 'v1' })
  const r7 = await invalidateMemory({ ctx: makeCtx({ fs: host7.fs }), memoryDir },
    { file: 'project_ghost.md', invalidAt: INVALID_AT })
  ok(r7.ok === false && r7.code === 'missing', '文件不存在 → missing', JSON.stringify(r7))
  const host7b = makeHost({ version: 'v1', statMissing: true })
  const r7b = await invalidateMemory({ ctx: makeCtx({ fs: host7b.fs }), memoryDir },
    { file: 'project_a.md', invalidAt: INVALID_AT })
  ok(r7b.ok === false && r7b.code === 'missing', '宿主 stat 说文件没了 → missing（不硬写）', JSON.stringify(r7b))

  // ⑧ 非法文件名：路径成分 / 扩展名 / 非记忆条目，一律在碰盘之前拒。
  const host8 = makeHost({ version: 'v1' })
  for (const bad of ['../project_a.md', 'sub/project_a.md', 'project_a.txt', 'MEMORY.md', '']) {
    const r = await invalidateMemory({ ctx: makeCtx({ fs: host8.fs }), memoryDir }, { file: bad, invalidAt: INVALID_AT })
    ok(r.ok === false && r.code === 'invalid', `非法文件名 ${JSON.stringify(bad)} → invalid`, JSON.stringify(r))
  }
  ok(host8.state.writes.length === 0 && host8.state.calls.length === 0,
    '【反向对照】非法文件名连 fs.resolve 都没调（不猜路径）', JSON.stringify(host8.state.calls))
}

group('6. undoMemoryInvalidation：撤销只删两行')
{
  await seed('project_undo.md', BASE_WITH_MARKERS)
  const host = makeHost({ version: 'v-read' })
  const res = await undoMemoryInvalidation({ ctx: makeCtx({ fs: host.fs }), memoryDir }, 'project_undo.md')
  ok(res.ok === true && res.cleared === true, '有标记 → cleared:true', JSON.stringify(res))
  ok(res.file === 'project_undo.md' && res.version === 'v-next', '收据带文件名与写后版本', JSON.stringify(res))
  ok(host.state.writes[0]?.expected?.kind === 'replaceIfVersion' && host.state.writes[0]?.expected?.version === 'v-read',
    '撤销同样带「读到那一刻」的版本守卫', JSON.stringify(host.state.writes[0]?.expected))

  const onDisk = await readDisk('project_undo.md')
  ok(onDisk === removeValidityLines(BASE_WITH_MARKERS).content, '落盘内容 = 纯函数删除结果')
  ok(onDisk === BASE_WITH_MARKERS_CLEAN, '逐字节还原到「没有标记」的原始正文（updated / tags / 正文都回来了）',
    JSON.stringify(onDisk))
  ok(!onDisk.includes('invalid_at') && !onDisk.includes('superseded_by'), '两行都被删掉')

  // 幂等：没有标记时撤销 → cleared:false，且不写盘。
  const host2 = makeHost({ version: 'v1' })
  const res2 = await undoMemoryInvalidation({ ctx: makeCtx({ fs: host2.fs }), memoryDir }, 'project_undo.md')
  ok(res2.ok === true && res2.cleared === false, '没标记 → ok + cleared:false（连点两下不报错）', JSON.stringify(res2))
  ok(host2.state.writes.length === 0, '【反向对照】没标记时一次 writeText 都没调')
  ok(await readDisk('project_undo.md') === BASE_WITH_MARKERS_CLEAN, '磁盘内容逐字节不变')

  // 只有 superseded_by 一种标记（历史数据 / 手工编辑）也能撤。
  await seed('project_half.md', '---\nname: half\ntype: project\nsuperseded_by: project_b.md\n---\n\n正文\n')
  const host3 = makeHost({ version: 'v1' })
  const res3 = await undoMemoryInvalidation({ ctx: makeCtx({ fs: host3.fs }), memoryDir }, 'project_half.md')
  ok(res3.ok === true && res3.cleared === true && !(await readDisk('project_half.md')).includes('superseded_by'),
    '只有 superseded_by 的标记也能撤（撤销不假设两行总是成对）')

  // 撤销失败：版本过期 → stale_version，磁盘不动。
  await seed('project_undo_stale.md', BASE_WITH_MARKERS)
  const host4 = makeHost({ version: 'v1', writeError: hostError('FS_STALE_VERSION') })
  const res4 = await undoMemoryInvalidation({ ctx: makeCtx({ fs: host4.fs }), memoryDir }, 'project_undo_stale.md')
  ok(res4.ok === false && res4.code === 'stale_version', '撤销遇到版本过期 → stale_version', JSON.stringify(res4))
  ok(await readDisk('project_undo_stale.md') === BASE_WITH_MARKERS, '【反向对照】撤销失败 → 磁盘不动（标记还在，可重试）')
}

group('7. 反向对照：写入路径绝不碰的东西')
{
  // 标失效 + 撤销各走一遍，逐行确认 `updated` 与正文没变 —— 这一组是「不做比做更重要」的证明。
  await seed('project_roundtrip.md', BASE)
  const originalUpdatedLine = BASE.split('\n').find((l) => l.startsWith('updated:'))
  await invalidateMemory({ ctx: makeCtx({ fs: makeHost({ version: 'v1' }).fs }), memoryDir },
    { file: 'project_roundtrip.md', invalidAt: INVALID_AT })
  const marked = await readDisk('project_roundtrip.md')
  ok(marked.split('\n').find((l) => l.startsWith('updated:')) === originalUpdatedLine,
    '标失效后 updated 行逐字不变')
  ok(!marked.includes('archived_at') && !marked.includes('archived_reason'),
    '【反向对照】失效不是归档：不写 archived_* 留痕')
  ok(marked.endsWith('\n正文第一段。\n\n正文第二段。\n'), '正文（含空行）原样贴在闭合 --- 之后')

  await undoMemoryInvalidation({ ctx: makeCtx({ fs: makeHost({ version: 'v1' }).fs }), memoryDir }, 'project_roundtrip.md')
  ok(await readDisk('project_roundtrip.md') === BASE,
    '【关键】标失效再撤销 → 文件逐字节回到原样（「只标不删」可逆的机器证明）')
}

await rm(world, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
