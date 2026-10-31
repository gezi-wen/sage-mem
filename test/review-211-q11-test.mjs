/**
 * 2.1.7 / Q11 回归：回滚的「不支持硬链接」降级仍可能覆盖已有归档。
 *
 * 审查原文（2026-10-31 外部审查 Q11，P1）：
 *   整目录回滚要把快照之后出现的 extra.md 移进 archive/；archive/extra.md 已存在；
 *   此时 `link` 返回 EPERM/ENOTSUP 等非 EEXIST 错误。旧的私有 moveExclusive 对**所有**
 *   非 EEXIST 错误直接 `rename(from, to)` —— POSIX rename 会静默覆盖已有目标，
 *   于是「保护快照里没有的旧归档」被当前这份活动文件顶掉，而回滚报 ok:true。
 *
 * 验收（断言的是最后留下了哪些字节，不是返回值好不好看）：
 *   ① EPERM / ENOTSUP / EXDEV 降级路径：已有归档逐字节保持，A 撞名换退役名落位；
 *   ② 无法识别的错误（ENOSPC）直接失败，**不默认 rename**，源与归档都不动；
 *   ③ 复制失败（EIO）保留源、不留下半截目标；
 *   ④ EEXIST 既有保证不变（硬链接可用时目标被抢 → 退役名）；
 *   ⑤ 直接对公共排他移动原语逐分支验证；
 *   ⑥ 反向对照：正常路径不产生退役名、不多留文件。
 */
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIB = new URL('../lib/', import.meta.url)
const { AutodreamEngine } = await import(new URL('autodream.js', LIB).href)
const utilMod = await import(new URL('memory/util.js', LIB).href)
/**
 * `moveFileExclusive` 是本次修复新加的导出。用**容错**方式取它：否则在修复前的代码上跑
 * 这套断言时，ESM 具名导入会直接抛 SyntaxError，整个套件加载失败、一条断言都跑不到
 * （那就没法用它证明「修复前是红的」）。拿不到时给一个必抛的桩，相关断言照常判 FAIL。
 */
const moveFileExclusive =
  utilMod.moveFileExclusive ??
  (async () => {
    throw new Error('moveFileExclusive 不存在（这是修复前的代码）')
  })

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

const makeCtx = () => ({ get: () => undefined, logger: { info: () => {}, warn: () => {}, error: () => {} } })
const exists = async (p) => (await stat(p).catch(() => null)) !== null
const read = async (p) => readFile(p, 'utf8').catch(() => null)

async function withFsPatch(patch, run) {
  const saved = new Map()
  for (const key of Object.keys(patch)) {
    saved.set(key, fsPromises[key])
    fsPromises[key] = patch[key](saved.get(key))
  }
  syncBuiltinESMExports()
  try {
    return await run()
  } finally {
    for (const [key, fn] of saved) fsPromises[key] = fn
    syncBuiltinESMExports()
  }
}

/**
 * 一个真实世界：快照里只有 base.md；之后新建 extra.md（活动区），而 archive/ 里
 * **已经有一份同名旧归档**（它是历史版本，不该被这次回滚覆盖）。
 */
async function world() {
  const root = await mkdtemp(join(tmpdir(), 'smem-q11-'))
  const mem = join(root, 'memory')
  await mkdir(mem, { recursive: true })
  const engine = new AutodreamEngine(makeCtx(), { memoryDir: mem, sessionsRoot: '' })
  await engine.load()
  await writeFile(join(mem, 'base.md'), '---\nname: base\ntype: project\n---\n\nbase body\n', 'utf8')
  const snap = await engine.snapshot('20261023-120000-q11', 'run')
  await mkdir(join(mem, 'archive'), { recursive: true })
  await writeFile(join(mem, 'extra.md'), 'A current extra\n', 'utf8')
  await writeFile(join(mem, 'archive', 'extra.md'), 'B old archive must survive\n', 'utf8')
  return { root, mem, engine, snapId: snap.id, extra: join(mem, 'extra.md') }
}

/** 跑一趟整目录回滚，并只对「把 extra.md 移进 archive」这条 link 注入指定错误码。 */
async function rollbackWithLinkError(w, code) {
  return withFsPatch(
    {
      link: (orig) => async (from, to, ...a) => {
        if (from === w.extra) throw Object.assign(new Error(`injected ${code}`), { code })
        return orig(from, to, ...a)
      },
    },
    () => w.engine.rollback({ snapshotId: w.snapId, scope: 'all' }),
  )
}

const archiveFiles = async (w) => readdir(join(w.mem, 'archive'))
const retiredOf = (files) => files.find((f) => /^extra\.retired-.*\.md$/.test(f))

// ─────────────── ① EPERM：不支持硬链接 → 排他复制降级 ───────────────
group('1. link 报 EPERM（网络盘 / exFAT）：已有归档逐字节保持，A 换退役名')
{
  const w = await world()
  const r = await rollbackWithLinkError(w, 'EPERM')
  ok(r?.ok === true, '（前提）回滚整体成功', JSON.stringify(r))
  ok((await read(join(w.mem, 'archive', 'extra.md'))) === 'B old archive must survive\n',
    'archive/extra.md 仍是 B 的原文（旧实现 rename 会把 B 顶成 A）')
  const files = await archiveFiles(w)
  const retired = retiredOf(files)
  ok(!!retired, 'A 以退役名落进 archive/（撞名不覆盖、也不放弃）', JSON.stringify(files))
  ok(!!retired && (await read(join(w.mem, 'archive', retired))) === 'A current extra\n', '退役名里逐字节就是 A')
  ok(!(await exists(w.extra)), '顶层 extra.md 已退场（降级失去原子可见性，但不丢「移走」这个结果）')
  ok(r?.parked === 1 && r?.skipped === 0, '报告如实：移走 1 个、跳过 0 个', JSON.stringify({ parked: r?.parked, skipped: r?.skipped }))
  await rm(w.root, { recursive: true, force: true }).catch(() => {})
}

// ─────────────── ② ENOTSUP ───────────────
group('2. link 报 ENOTSUP：同一套保证')
{
  const w = await world()
  const r = await rollbackWithLinkError(w, 'ENOTSUP')
  ok(r?.ok === true && r.parked === 1 && r.skipped === 0, '回滚成功、parked=1', JSON.stringify(r))
  ok((await read(join(w.mem, 'archive', 'extra.md'))) === 'B old archive must survive\n', '已有归档 B 保持')
  const retired = retiredOf(await archiveFiles(w))
  ok(!!retired && (await read(join(w.mem, 'archive', retired))) === 'A current extra\n', 'A 落到退役名')
  await rm(w.root, { recursive: true, force: true }).catch(() => {})
}

// ─────────────── ③ EXDEV：跨卷 ───────────────
group('3. link 报 EXDEV（跨卷）：同一套保证')
{
  const w = await world()
  const r = await rollbackWithLinkError(w, 'EXDEV')
  ok(r?.ok === true && r.skipped === 0, '回滚成功', JSON.stringify(r))
  ok((await read(join(w.mem, 'archive', 'extra.md'))) === 'B old archive must survive\n', '已有归档 B 保持')
  const retired = retiredOf(await archiveFiles(w))
  ok(!!retired && (await read(join(w.mem, 'archive', retired))) === 'A current extra\n', 'A 落到退役名')
  await rm(w.root, { recursive: true, force: true }).catch(() => {})
}

// ─────────────── ④ 无法识别的错误：不许默认 rename ───────────────
group('4. link 报 ENOSPC（无法识别的错误）：直接失败，不默认 rename')
{
  const w = await world()
  const r = await rollbackWithLinkError(w, 'ENOSPC')
  ok(r?.ok === true, '（前提）回滚整体收尾成功（单个文件失败记进 skipped）', JSON.stringify(r))
  ok(r?.parked === 0 && r?.skipped === 1, '如实报告「这个文件没移走」', JSON.stringify({ parked: r?.parked, skipped: r?.skipped }))
  ok((await read(w.extra)) === 'A current extra\n', '顶层源原样保留（一个字节没动）')
  ok((await read(join(w.mem, 'archive', 'extra.md'))) === 'B old archive must survive\n', '已有归档 B 保持')
  const files = await archiveFiles(w)
  ok(files.length === 1 && files[0] === 'extra.md', '没有偷偷用 rename 落位、也没留半截目标', JSON.stringify(files))
  await rm(w.root, { recursive: true, force: true }).catch(() => {})
}

// ─────────────── ⑤ 复制失败（EIO）：保留源、不留半截目标 ───────────────
group('5. 降级复制本身失败（EIO）：源保留，归档区不留半成品')
{
  const w = await world()
  const archiveDir = join(w.mem, 'archive')
  const r = await withFsPatch(
    {
      link: (orig) => async (from, to, ...a) => {
        if (from === w.extra) throw Object.assign(new Error('injected ENOTSUP'), { code: 'ENOTSUP' })
        return orig(from, to, ...a)
      },
      copyFile: (orig) => async (from, to, ...a) => {
        if (String(to).startsWith(archiveDir)) throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
        return orig(from, to, ...a)
      },
    },
    () => w.engine.rollback({ snapshotId: w.snapId, scope: 'all' }),
  )
  ok(r?.ok === true, '（前提）回滚整体收尾成功', JSON.stringify(r))
  ok(r?.parked === 0 && r?.skipped === 1, '移走失败如实记进 skipped', JSON.stringify({ parked: r?.parked, skipped: r?.skipped }))
  ok((await read(w.extra)) === 'A current extra\n', '源原样保留（复制失败绝不删源）')
  ok((await read(join(archiveDir, 'extra.md'))) === 'B old archive must survive\n', '已有归档 B 保持')
  ok((await archiveFiles(w)).length === 1, '归档区没有留下半截目标文件', JSON.stringify(await archiveFiles(w)))
  await rm(w.root, { recursive: true, force: true }).catch(() => {})
}

// ─────────────── ⑥ EEXIST：硬链接可用、目标被抢（既有保证的反向对照） ───────────────
group('6. link 报 EEXIST（目标被抢）：退役名落位，B 保持')
{
  const w = await world()
  const target = join(w.mem, 'archive', 'extra.md')
  const r = await withFsPatch(
    {
      link: (orig) => async (from, to, ...a) => {
        if (from === w.extra && to === target) throw Object.assign(new Error('injected EEXIST'), { code: 'EEXIST' })
        return orig(from, to, ...a)
      },
    },
    () => w.engine.rollback({ snapshotId: w.snapId, scope: 'all' }),
  )
  ok(r?.ok === true && r.parked === 1 && r.skipped === 0, '回滚成功、parked=1', JSON.stringify(r))
  ok((await read(target)) === 'B old archive must survive\n', '已有归档 B 保持')
  const retired = retiredOf(await archiveFiles(w))
  ok(!!retired && (await read(join(w.mem, 'archive', retired))) === 'A current extra\n', 'A 落到退役名')
  await rm(w.root, { recursive: true, force: true }).catch(() => {})
}

// ─────────────── ⑦ 直接验证公共排他移动原语 ───────────────
group('7. moveFileExclusive：逐分支验证（EEXIST / 降级 / 失败不丢源）')
{
  const root = await mkdtemp(join(tmpdir(), 'smem-q11-prim-'))
  const d = join(root, 'd')
  await mkdir(d, { recursive: true })

  // 正常（link 可用）：目标出现、源退役。
  const from1 = join(d, 'from1.md')
  const to1 = join(d, 'to1.md')
  await writeFile(from1, 'one', 'utf8')
  const r1 = await moveFileExclusive(from1, to1).catch((e) => ({ error: e?.message ?? String(e) }))
  ok(r1?.exclusive === true && (await read(to1)) === 'one' && !(await exists(from1)),
    '正常路径：目标有内容、源移走、exclusive=true', JSON.stringify(r1))

  // EEXIST：目标已存在 → 原子拒绝，两个文件都原样。
  await writeFile(join(d, 'from2.md'), 'two', 'utf8')
  await writeFile(join(d, 'to2.md'), 'keep', 'utf8')
  let threw2 = null
  try {
    await moveFileExclusive(join(d, 'from2.md'), join(d, 'to2.md'))
  } catch (err) {
    threw2 = err
  }
  ok(threw2?.code === 'EEXIST', '目标已存在 → 报 EEXIST（不覆盖）', String(threw2?.code))
  ok((await read(join(d, 'to2.md'))) === 'keep' && (await read(join(d, 'from2.md'))) === 'two',
    '那条已存在的目标逐字节没动，源也还在')

  // 降级：link 不支持 → 排他复制 + 校验 + 删源。
  await writeFile(join(d, 'from3.md'), 'three', 'utf8')
  const r3 = await withFsPatch(
    {
      link: (orig) => async (from, to, ...a) => {
        if (from === join(d, 'from3.md')) throw Object.assign(new Error('injected ENOTSUP'), { code: 'ENOTSUP' })
        return orig(from, to, ...a)
      },
    },
    async () => {
      try {
        return await moveFileExclusive(join(d, 'from3.md'), join(d, 'to3.md'))
      } catch (err) {
        return { error: err?.message ?? String(err) }
      }
    },
  )
  ok(r3?.exclusive === false && (await read(join(d, 'to3.md'))) === 'three' && !(await exists(join(d, 'from3.md'))),
    '降级路径：复制成功、校验后删源、如实自报 exclusive=false', JSON.stringify(r3))

  // 降级 + 目标已存在：copyFile 排他 → EEXIST，不覆盖。
  await writeFile(join(d, 'from4.md'), 'four', 'utf8')
  await writeFile(join(d, 'to4.md'), 'keep4', 'utf8')
  let threw4 = null
  await withFsPatch(
    {
      link: (orig) => async (from, to, ...a) => {
        if (from === join(d, 'from4.md')) throw Object.assign(new Error('injected ENOTSUP'), { code: 'ENOTSUP' })
        return orig(from, to, ...a)
      },
    },
    async () => {
      try {
        await moveFileExclusive(join(d, 'from4.md'), join(d, 'to4.md'))
      } catch (err) {
        threw4 = err
      }
    },
  )
  ok(threw4?.code === 'EEXIST', '降级路径下目标已存在 → 仍报 EEXIST（不许静默覆盖）', String(threw4?.code))
  ok((await read(join(d, 'to4.md'))) === 'keep4' && (await read(join(d, 'from4.md'))) === 'four', '两个文件都原样')

  // 降级复制失败：源必须保留，目标不得留半截。
  await writeFile(join(d, 'from5.md'), 'five', 'utf8')
  let threw5 = null
  await withFsPatch(
    {
      link: (orig) => async (from, to, ...a) => {
        if (from === join(d, 'from5.md')) throw Object.assign(new Error('injected ENOTSUP'), { code: 'ENOTSUP' })
        return orig(from, to, ...a)
      },
      copyFile: (orig) => async (from, to, ...a) => {
        if (to === join(d, 'to5.md')) throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
        return orig(from, to, ...a)
      },
    },
    async () => {
      try {
        await moveFileExclusive(join(d, 'from5.md'), join(d, 'to5.md'))
      } catch (err) {
        threw5 = err
      }
    },
  )
  ok(threw5?.code === 'EIO', '复制失败的错误原样抛出', String(threw5?.code))
  ok((await read(join(d, 'from5.md'))) === 'five' && !(await exists(join(d, 'to5.md'))), '源保留、目标不存在')

  // 无法识别的 link 错误：直接失败，不默认 rename。
  await writeFile(join(d, 'from6.md'), 'six', 'utf8')
  let threw6 = null
  await withFsPatch(
    {
      link: (orig) => async (from, to, ...a) => {
        if (from === join(d, 'from6.md')) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' })
        return orig(from, to, ...a)
      },
    },
    async () => {
      try {
        await moveFileExclusive(join(d, 'from6.md'), join(d, 'to6.md'))
      } catch (err) {
        threw6 = err
      }
    },
  )
  ok(threw6?.code === 'ENOSPC', '无法识别的错误原样抛出（不默认 rename）', String(threw6?.code))
  ok((await read(join(d, 'from6.md'))) === 'six' && !(await exists(join(d, 'to6.md'))), '源没动、没有偷偷落位')
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

// ─────────────── ⑧ 反向对照：正常回滚 ───────────────
group('8. 反向对照：没有冲突的正常回滚不产生退役名')
{
  const root = await mkdtemp(join(tmpdir(), 'smem-q11-ok-'))
  const mem = join(root, 'memory')
  await mkdir(mem, { recursive: true })
  const engine = new AutodreamEngine(makeCtx(), { memoryDir: mem, sessionsRoot: '' })
  await engine.load()
  await writeFile(join(mem, 'base.md'), '---\nname: base\ntype: project\n---\n\nbase body\n', 'utf8')
  const snap = await engine.snapshot('20261023-120000-q11ok', 'run')
  await writeFile(join(mem, 'extra.md'), 'A current extra\n', 'utf8')
  const r = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
  ok(r?.ok === true && r.parked === 1 && r.skipped === 0, '回滚成功、parked=1', JSON.stringify(r))
  const files = await readdir(join(mem, 'archive'))
  ok(files.length === 1 && files[0] === 'extra.md', '原名落位（没有多余的退役名）', JSON.stringify(files))
  ok((await read(join(mem, 'archive', 'extra.md'))) === 'A current extra\n', '归档里就是 A')
  ok(!(await exists(join(mem, 'extra.md'))), '顶层已退场')
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

