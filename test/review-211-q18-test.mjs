/**
 * 2.1.19 / Q18 回归：面板原子替换会放宽原文件的 POSIX 权限。
 *
 * 审查原文（2026-10-31 外部审查 Q18，P2）：
 *   POSIX + umask=022 时，用户把记忆文件设成 0600，随后通过面板保存；`writeFileAtomic`
 *   新建的临时文件走默认 mode，rename 换掉原 inode —— 原 mode 不被继承，0600 → 0644，
 *   隐私被悄悄放宽。回滚那条路已经专门保存并贴回权限，说明项目意识到了该风险，面板入口没覆盖。
 *
 * 本套件的断言分两层（Windows 上 mode 位没有意义，实测 before=666 after=666）：
 *   · **行为断言（POSIX 才成立）**：本机先**运行时探测**能不能真的设出 0600；
 *     拿不到就 SKIP 并明确打印，绝不让 Windows 红、也不假装验过。
 *   · **机制断言（所有平台）**：注入一个「目标已是 0600 普通文件」的 lstat 视图，
 *     断言原语确实把 mode 贴到临时文件上再 rename —— 这样 Windows 上也能给出「修前红」。
 *   · **内容保全断言（所有平台）**：替换后内容正确、无临时残留、硬链接备份不被写穿。
 *
 * 只 import `lib/memory/util.js`（纯 node: 内置依赖），不拉宿主依赖 —— 本套件在
 * 任何 Node 环境（含 CI 的 Linux）都能直接跑。
 */
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIB = new URL('../lib/', import.meta.url)
const utilMod = await import(new URL('memory/util.js', LIB).href)
const writeFileAtomic = utilMod.writeFileAtomic

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
const skip = (name, why) => console.log(`  SKIP ${name}（${why}）`)
const group = (t) => console.log(`== ${t} ==`)

const tmpRoots = []
async function tmpdirNamed(prefix) {
  const d = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(d)
  return d
}

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

const modeOf = async (p) => (await stat(p)).mode & 0o777
const bytesOf = (p) => readFile(p, 'utf8').catch(() => null)

/**
 * 本机能不能真的表达 POSIX 权限位？**运行时探测**，不看平台名：
 * 写一个 0600 文件再读回 stat.mode —— Windows 上拿回的是 666（mode 位无意义）。
 */
const probeDir = await tmpdirNamed('smem-q18-probe-')
const probeFile = join(probeDir, 'probe.md')
await writeFile(probeFile, 'probe', { mode: 0o600 })
const POSIX = (await modeOf(probeFile)) === 0o600
console.log(
  POSIX
    ? '  （本机支持 POSIX 权限位：行为断言全跑）'
    : '  （本机 mode 位无意义（Windows）：权限行为断言 SKIP，机制断言与内容保全断言照跑）',
)

// ─────────────── ① 内容保全（所有平台） ───────────────
group('1. 内容保全：替换成功、不留临时文件')
{
  const d = await tmpdirNamed('smem-q18-content-')
  const target = join(d, 'a.md')
  await writeFile(target, 'OLD content', 'utf8')
  await writeFileAtomic(target, 'NEW content')
  ok((await bytesOf(target)) === 'NEW content', '目标文件换成新内容')
  const leftovers = (await readdir(d)).filter((f) => f.endsWith('.tmp'))
  ok(leftovers.length === 0, '没有留下临时文件', JSON.stringify(leftovers))
}

// ─────────────── ② 硬链接备份不被写穿（所有平台；NTFS 也支持硬链接） ───────────────
group('2. 已有硬链接备份不被写穿（rename 换目录项，不往旧 inode 里灌）')
{
  const d = await tmpdirNamed('smem-q18-link-')
  const target = join(d, 'a.md')
  const backup = join(d, 'backup-a.md')
  await writeFile(target, 'OLD', 'utf8')
  await link(target, backup)
  await writeFileAtomic(target, 'NEW')
  ok((await bytesOf(backup)) === 'OLD', '硬链接备份仍是 OLD（旧实现用 copyFile 会一起改掉）')
  ok((await bytesOf(target)) === 'NEW', '目标已是 NEW')
}

// ─────────────── ③ 机制断言（所有平台）：rename 之前把 mode 贴到临时文件 ───────────────
group('3. 机制：替换已有普通文件时，临时文件按原 mode 建立后再 rename')
{
  const d = await tmpdirNamed('smem-q18-mech-')
  const target = join(d, 'a.md')
  await writeFile(target, 'OLD', 'utf8')
  const seen = { writeModes: [], chmods: [] }
  const FAKE_MODE = 0o600
  await withFsPatch(
    {
      // 注入「目标是一个 mode=0600 的普通文件」的视图：Windows 上也能验这段机制。
      lstat: (orig) => async (p, ...a) => {
        if (p === target) return { isFile: () => true, isSymbolicLink: () => false, mode: 0o100000 | FAKE_MODE }
        return orig(p, ...a)
      },
      writeFile: (orig) => async (p, data, opts) => {
        if (typeof p === 'string' && p.endsWith('.tmp')) {
          seen.writeModes.push(opts && typeof opts === 'object' ? opts.mode : undefined)
        }
        return orig(p, data, opts)
      },
      chmod: (orig) => async (p, mode) => {
        if (typeof p === 'string' && p.endsWith('.tmp')) seen.chmods.push(mode)
        return orig(p, mode)
      },
    },
    () => writeFileAtomic(target, 'NEW'),
  )
  ok(seen.writeModes.length === 1 && seen.writeModes[0] === FAKE_MODE,
    '（机制）临时文件用原文件的 mode(0600) 建立（旧实现走默认 umask）', JSON.stringify(seen.writeModes))
  ok(seen.chmods.length === 1 && seen.chmods[0] === FAKE_MODE,
    '（机制）rename 前把 mode 精确贴到临时文件（writeFile 的 mode 会被 umask 掩掉一部分）',
    JSON.stringify(seen.chmods))
  ok((await bytesOf(target)) === 'NEW', '内容照常替换成功')
}

// ─────────────── ④ 新建默认 mode（POSIX） ───────────────
group('4. 新建文件用明确的保守模式 0600（不是 umask 默认）')
{
  if (!POSIX) {
    skip('新建文件默认 0600', '本机 mode 位无意义（Windows），行为断言留给 Linux CI')
  } else {
    const d = await tmpdirNamed('smem-q18-new-')
    const target = join(d, 'new.md')
    await writeFileAtomic(target, 'sensitive')
    ok((await modeOf(target)) === 0o600, `新建文件是 0600（实际 ${(await modeOf(target)).toString(8)}）`)
  }
}

// ─────────────── ⑤ 已有文件保留原权限（POSIX） ───────────────
group('5. 已有文件：0600 保存后仍 0600，0640 保存后仍 0640（不放宽也不乱收紧）')
{
  if (!POSIX) {
    skip('已有 0600 → 保存后仍 0600', '本机 mode 位无意义（Windows），行为断言留给 Linux CI')
    skip('已有 0640 → 保存后仍 0640', '本机 mode 位无意义（Windows），行为断言留给 Linux CI')
  } else {
    const d = await tmpdirNamed('smem-q18-keep-')
    const a600 = join(d, 'a600.md')
    await writeFile(a600, 'OLD', 'utf8')
    await chmod(a600, 0o600)
    await writeFileAtomic(a600, 'NEW')
    ok((await modeOf(a600)) === 0o600, `0600 保存后仍是 0600（实际 ${(await modeOf(a600)).toString(8)}，旧实现会变 644）`)
    ok((await bytesOf(a600)) === 'NEW', '内容确实更新了')

    const a640 = join(d, 'a640.md')
    await writeFile(a640, 'OLD', 'utf8')
    await chmod(a640, 0o640)
    await writeFileAtomic(a640, 'NEW')
    ok((await modeOf(a640)) === 0o640, `0640 保存后仍是 0640（实际 ${(await modeOf(a640)).toString(8)}）`)
  }
}

// ─────────────── ⑥ 错误路径不放宽权限（POSIX） ───────────────
group('6. 错误路径：rename / chmod 失败时目标文件原样（不会「放宽一半」）')
{
  if (!POSIX) {
    skip('rename 失败 → 目标仍 0600、内容原样', '本机 mode 位无意义（Windows），行为断言留给 Linux CI')
    skip('chmod 失败 → 目标仍 0600、内容原样', '本机 mode 位无意义（Windows），行为断言留给 Linux CI')
  } else {
    const d = await tmpdirNamed('smem-q18-err-')
    const target = join(d, 'a.md')
    await writeFile(target, 'OLD', 'utf8')
    await chmod(target, 0o600)

    let threw = null
    await withFsPatch(
      {
        rename: (orig) => async (from, to, ...a) => {
          if (to === target) throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
          return orig(from, to, ...a)
        },
      },
      async () => {
        try {
          await writeFileAtomic(target, 'NEW')
        } catch (err) {
          threw = err
        }
      },
    )
    ok(threw?.code === 'EIO', 'rename 失败原样抛出', String(threw?.code))
    ok((await modeOf(target)) === 0o600 && (await bytesOf(target)) === 'OLD', '目标仍是 0600 + 旧内容')
    ok((await readdir(d)).filter((f) => f.endsWith('.tmp')).length === 0, '临时文件已清理')

    let threw2 = null
    await withFsPatch(
      {
        chmod: (orig) => async (p, mode) => {
          if (typeof p === 'string' && p.endsWith('.tmp')) throw Object.assign(new Error('injected EPERM'), { code: 'EPERM' })
          return orig(p, mode)
        },
      },
      async () => {
        try {
          await writeFileAtomic(target, 'NEW2')
        } catch (err) {
          threw2 = err
        }
      },
    )
    ok(threw2?.code === 'EPERM', 'chmod 失败原样抛出', String(threw2?.code))
    ok((await modeOf(target)) === 0o600 && (await bytesOf(target)) === 'OLD',
      '没换目标文件：既没放宽权限、也没写进半截内容')
  }
}

// ─────────────── ⑦ 不跟随符号链接取 mode（运行时探测能否建符号链接） ───────────────
group('7. 符号链接：不跟随取 mode，rename 把链接本身换掉')
{
  const d = await tmpdirNamed('smem-q18-sym-')
  const outside = join(d, 'outside.md')
  const target = join(d, 'a.md')
  await writeFile(outside, 'OUTSIDE', 'utf8')
  let linkable = true
  try {
    await symlink(outside, target)
  } catch {
    linkable = false
  }
  if (!linkable) {
    skip('符号链接场景', '本机建不了文件符号链接（Windows 需要开发者模式 / 特权）')
  } else {
    await writeFileAtomic(target, 'NEW')
    ok((await bytesOf(outside)) === 'OUTSIDE', '目录外的真实文件没被穿过链接改写')
    const info = await lstat(target)
    ok(!info.isSymbolicLink(), 'a.md 现在是普通文件（链接被替换，而不是被穿透）')
    if (POSIX) ok((await modeOf(target)) === 0o600, '新建的普通文件是保守默认 0600（没去跟随链接取外部 mode）')
  }
}

for (const d of tmpRoots) await rm(d, { recursive: true, force: true }).catch(() => {})

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
