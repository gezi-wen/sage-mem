/**
 * 复审回归（2026-10-11 那份外部复审里判定为 bug 的十条）。
 *
 * 覆盖:
 *   R01 归档配置在**响应** codec 里被剥掉        → 保存回读永远对不上
 *   R02 回滚 `copyFile` 写穿硬链接 / 符号链接    → 记忆目录之外的备份被改
 *   R03 保护快照轮转删掉正在用的回滚源           → ok:true / restored:0 的假成功
 *   R04 manifest 已声明捕获失败仍过校验          → 残缺快照被当成「当时那一版」
 *   R05 释放锁的「检查之后、删除之前」换主       → 删掉新持有者的锁
 *   R06 归档 / 恢复删掉或覆盖并发保存的新版本    → 新写的那版两个位置都没有
 *   R07 并发归档互相覆盖索引更新                 → 索引里留下悬空条目
 *   R09 宿主放行的大写 `.MD` 被传输入参拒绝      → 列表里有、读不了
 *   R10 写工具按字符放行、读端按字节拒绝         → 写出自己读不了的文件
 *   R11 索引读失败被当成空文件                   → 恢复操作抹掉用户手写内容
 *   （R08 并发上锁丢一条是**已声明的设计取舍**，这里只钉住「行为与声明一致」，不算回归。）
 *
 * 两处测法说明:
 *   - R05 / R06 用**两个真实 Node 进程**，在真实文件系统调用之前设 IPC 暂停点固定交错。
 *     不伪造调用结果 —— 暂停点两侧跑的都是一行没改的仓库代码（只包了 fs 的入参判断）。
 *   - R04 / R11 显式注入一次读取故障（EIO）来验证错误分支，**不声称真实磁盘发生了故障**。
 *   - R07 是真实的 `Promise.all` 并发。
 *   - R02 的硬链接场景本机（NTFS）可直接构造；符号链接场景**运行时探测**能力，
 *     建不出来就跳过并明确标出（不静默当通过）。跳过时的那条断言已在**真实 Linux**
 *     上用同一份 `lib/memory/util.js` 单独验过：旧写法 `copyFile` 会把目录外的
 *     `outside.md` 从 OUTSIDE 改成 SNAPSHOT（写穿），新写法 `writeFileAtomic` 下
 *     目录外内容不变、`a.md` 由符号链接变成普通文件（替换而非穿透）。
 */
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const LIB = new URL('../lib/', import.meta.url)
const SELF = fileURLToPath(import.meta.url)

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

const makeCtx = () => ({ get: () => undefined, logger: { info: () => {}, warn: () => {}, error: () => {} } })
const body = (t) => '---\nname: example\ndescription: review\ntype: project\n---\n' + t + '\n'
const exists = async (p) => (await stat(p).catch(() => null)) !== null

// ────────────────────────────── 子进程 worker ──────────────────────────────
// 每个 worker 只做一件事：把 lib 的真实调用跑到某个**真实 fs 调用之前**停住，
// 发 ready 给主进程，等 continue。主进程在那段窗口里制造并发动作。
//
// ⚠️ 暂停点一律取**修复前 / 修复后两条路径的并集**（例如归档那条既拦 `unlink(源)`
// 又拦 `rename(源 → 私有名)`）。这样同一套断言在两边都能把交错固定住 ——
// 否则改动本身会把暂停点挪走，测试就变成「只对新代码有效」，失去回归的意义。
const WORKER = process.argv[2]
if (WORKER) {
  const memoryDir = process.argv[3]
  const argA = process.argv[4]
  const argB = process.argv[5]
  let waited = false
  /** `reentrant = true` 允许停两次（多阶段交错用；单阶段场景仍只停一次，避免死等）。 */
  const wait = async (reentrant = false) => {
    if (!reentrant && waited) return
    waited = true
    process.send({ ready: true })
    await once(process, 'message')
  }
  const mod = (p) => import(new URL(p, LIB).href)
  const src = join(memoryDir, 'a.md')

  if (WORKER === 'archive-take') {
    // 暂停在「源被移走 / 删掉」之前 —— 主进程在这段窗口里落笔一个新版本，
    // 于是 worker 收走的将是**新版本**，必须靠身份复核发现并还回。
    const realRename = fsPromises.rename
    const realUnlink = fsPromises.unlink
    fsPromises.rename = async (from, to, ...a) => {
      if (from === src) await wait()
      return realRename(from, to, ...a)
    }
    fsPromises.unlink = async (p, ...a) => {
      if (p === src) await wait()
      return realUnlink(p, ...a)
    }
    syncBuiltinESMExports()
    const { archiveMemory } = await mod('memory/archive.js')
    process.send({ result: await archiveMemory(memoryDir, 'a.md', 'review archive') })
  } else if (WORKER === 'archive-return') {
    // 两阶段：① 停在「移走源」之前（主进程落笔新版本）；
    //         ② 停在「归还」之前（主进程占住原名，让 link 必然 EEXIST）。
    // 用来验证最坏分支：**还回失败时那份内容绝不能丢**。
    const realRename = fsPromises.rename
    const realLink = fsPromises.link
    fsPromises.rename = async (from, to, ...a) => {
      if (from === src) await wait(true)
      return realRename(from, to, ...a)
    }
    fsPromises.link = async (p, q, ...a) => {
      if (q === src) await wait(true)
      return realLink(p, q, ...a)
    }
    syncBuiltinESMExports()
    const { archiveMemory } = await mod('memory/archive.js')
    process.send({ result: await archiveMemory(memoryDir, 'a.md', 'review archive') })
  } else if (WORKER === 'restore-link') {
    // 落位之前：新版是 `link(tmp, 顶层)`，旧版是 `rename(tmp, 顶层)`，两条都拦。
    const realLink = fsPromises.link
    const realRename = fsPromises.rename
    fsPromises.link = async (p, q, ...a) => {
      if (q === src) await wait()
      return realLink(p, q, ...a)
    }
    fsPromises.rename = async (from, to, ...a) => {
      if (to === src) await wait()
      return realRename(from, to, ...a)
    }
    syncBuiltinESMExports()
    const { restoreMemory } = await mod('memory/archive.js')
    process.send({ result: await restoreMemory(memoryDir, 'a.md') })
  } else if (WORKER === 'release-before-rename' || WORKER === 'release-before-rm') {
    const lockPath = argA
    const lockToken = argB
    if (WORKER === 'release-before-rename') {
      // 暂停在「锁被移走 / 删掉」**之前** —— 主进程在这段窗口里抢走锁（换主）。
      // 新版会移走别人的锁（随后复核+归还），旧版会直接删掉别人的锁。
      const realRename = fsPromises.rename
      const realRm = fsPromises.rm
      fsPromises.rename = async (from, to, ...a) => {
        if (from === lockPath && String(to).includes('.released-')) await wait()
        return realRename(from, to, ...a)
      }
      fsPromises.rm = async (p, ...a) => {
        if (p === lockPath) await wait()
        return realRm(p, ...a)
      }
    } else {
      // 暂停在「移走自己那把**之后**、删掉它之前」—— 主进程在这段窗口里拿到锁。
      // 新版停在私有名的 rm 上；旧版没有「先移走」这一步，就停在 rm(锁路径) 上。
      const realRm = fsPromises.rm
      fsPromises.rm = async (p, ...a) => {
        if (String(p).includes('.released-') || p === lockPath) await wait()
        return realRm(p, ...a)
      }
    }
    syncBuiltinESMExports()
    const { AutodreamEngine } = await mod('autodream.js')
    const engine = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot: '' })
    await engine.load()
    engine.lockToken = lockToken
    await engine.releaseLock()
    process.send({ done: true })
  } else {
    process.send({ error: `unknown worker: ${WORKER}` })
  }
  process.disconnect()
} else {
  // ────────────────────────────── 主进程 ──────────────────────────────
  const { TYPERT } = await import(new URL('typert.host.js', LIB).href)
  const { AutodreamEngine } = await import(new URL('autodream.js', LIB).href)
  const { archiveMemory, restoreMemory } = await import(new URL('memory/archive.js', LIB).href)
  const { setLocked, readLockSet } = await import(new URL('memory/lock.js', LIB).href)
  const utilMod = await import(new URL('memory/util.js', LIB).href)
  const { writeFileAtomic } = utilMod
  /**
   * `writeFileExclusive` 是本次修复新加的导出。用**容错**方式取它：否则在「修复前的代码」
   * 上跑这套断言时，ESM 的命名导入会直接抛 SyntaxError，整个套件加载失败、一条断言都跑不到
   * —— 那就没法用它证明「修复前是红的」了。拿不到时给一个必抛的桩，相关断言照常判 FAIL。
   */
  const writeFileExclusive =
    utilMod.writeFileExclusive ??
    (async () => {
      throw new Error('writeFileExclusive 不存在（这是修复前的代码）')
    })
  const { createToolRunner } = await import(new URL('autodream-tools.js', LIB).href)
  const { inspectMemoryEntry } = await import(new URL('memory/scan.js', LIB).href)
  const { safeName } = await import(new URL('memory/naming.js', LIB).href)
  const { PRE_ROLLBACK_KEEP } = await import(new URL('autodream/config.js', LIB).href)
  const invOf = (id) => TYPERT.invocations.find((i) => i.id === id)

  /** 一个临时世界：临时根 + memory 目录 + 引擎。 */
  async function world() {
    const root = await mkdtemp(join(tmpdir(), 'smem-recheck-'))
    const memoryDir = join(root, 'memory')
    await mkdir(memoryDir, { recursive: true })
    const engine = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot: '' })
    await engine.load()
    return { root, memoryDir, engine }
  }

  /**
   * 起一个停在暂停点上的 worker。
   * 返回 `{ step, exit }`：`step()` 放行一次并等它下一条消息（下一个暂停点的 ready，
   * 或最终结果），`exit()` 等进程收尾。多阶段交错要求它可以被调用多次。
   *
   * ⚠️ 等暂停点带**超时**：在「修复前的代码」上跑时，暂停点根本不会被触发
   * （旧实现走的是另一条系统调用），若不设超时，整个套件会在这里抛未捕获异常崩掉、
   * 后面的断言一条都跑不到、汇总行也读不出来。超时后返回一个「结果里带错误」的桩，
   * 让相关断言照常判 FAIL，套件照常跑完。
   */
  async function startWorker(mode, memoryDir, ...args) {
    const cp = fork(SELF, [mode, memoryDir, ...args], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let err = ''
    cp.stderr.on('data', (b) => { err += b })
    let timer = null
    const first = await Promise.race([
      once(cp, 'message').then((m) => m[0]),
      new Promise((r) => { timer = setTimeout(() => r('__timeout__'), 15000) }),
    ])
    if (timer) clearTimeout(timer)
    if (first === '__timeout__' || !first?.ready) {
      cp.kill()
      const why =
        first === '__timeout__'
          ? `15s 内没等到 ${mode} 的暂停点（多半是这段代码没走那条系统调用）`
          : `worker 未就绪：${JSON.stringify(first)} ${err}`
      return {
        broken: why,
        step: async () => ({ result: { ok: null, error: why } }),
        exit: async () => {},
      }
    }
    return {
      step: async () => {
        const answer = once(cp, 'message')
        cp.send('continue')
        const [out] = await answer
        return out
      },
      exit: () => once(cp, 'exit'),
    }
  }

  console.log('== R01：能写进去的配置字段，返回里也必须看得见（响应 codec 是双向契约）==')
  {
    const { memoryDir, engine } = await world()
    const setInv = invOf('sage-mem#autodream/setConfig')
    const getInv = invOf('sage-mem#autodream/getConfig')
    ok(!!setInv && !!getInv, '（前提）找得到 setConfig / getConfig')

    const requested = { autoArchive: 'auto', archiveAfterDaysProject: 30, archiveAfterDaysReference: 200, archiveAfterDaysUser: 500 }
    // 界面真实路径：请求过入参 codec → engine.setConfig → 响应过返回 codec
    const wired = setInv.parameters[0].codec.schema.parse(requested)
    const raw = await engine.setConfig(wired)
    const back = setInv.result.schema.parse(raw)
    const keys = Object.keys(requested)
    const missing = keys.filter((k) => !(k in back.config))
    ok(missing.length === 0, 'setConfig 响应的 config 里四个字段都在', JSON.stringify(missing))

    const reread = getInv.result.schema.parse(await engine.getConfig())
    const missing2 = keys.filter((k) => !(k in reread.config))
    ok(missing2.length === 0, 'getConfig 响应的 config 里四个字段都在', JSON.stringify(missing2))
    ok(
      reread.config.autoArchive === 'auto' && reread.config.archiveAfterDaysProject === 30 &&
        reread.config.archiveAfterDaysReference === 200 && reread.config.archiveAfterDaysUser === 500,
      '界面回读拿到的是刚存进去的值（渲染层据此判「保存没生效」）',
      JSON.stringify({ autoArchive: reread.config.autoArchive, p: reread.config.archiveAfterDaysProject }),
    )

    // 覆盖面断言：engine 配置里的**每一个键**都必须在响应 schema 里声明，
    // 否则 strict codec 会静默剥掉它（以后再加配置项、漏了这里就立刻红）。
    const allKeys = Object.keys((await engine.getConfig()).config)
    const shape = getInv.result.schema.parse(await engine.getConfig()).config
    const dropped = allKeys.filter((k) => !(k in shape))
    ok(allKeys.length >= 15 && dropped.length === 0, `响应 schema 覆盖全部 ${allKeys.length} 个配置键（漏掉即被剥）`, JSON.stringify(dropped))
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R09：文件名闸门与 safeName 必须同宽（大写扩展名）==')
  {
    const readInv = invOf('sage-mem#memory/readFile')
    ok(safeName('a.MD') === 'a.MD', 'host 侧 safeName 认可 a.MD')
    const wire = readInv.parameters[0].codec.schema.safeParse('a.MD')
    ok(wire.success === true, '传输入参 schema 也认可 a.MD（旧写法正则少了 i）', JSON.stringify(wire.error?.issues ?? []))
    const lower = readInv.parameters[0].codec.schema.safeParse('a.md')
    ok(lower.success === true, '（前提）小写不受影响')
    ok(readInv.parameters[0].codec.schema.safeParse('../a.md').success === false, '路径成分仍然被拒')
  }

  console.log('== R10：模型写入工具的闸门必须按字节（与读取端同一把尺子）==')
  {
    const { memoryDir } = await world()
    const runner = createToolRunner({ memoryDir, apply: true })
    // 18 万汉字：18 万「字符」但 54 万字节 —— 旧写法放行，写入后立刻被读取端判 too-big。
    const huge = body('中'.repeat(180000))
    const out = await runner.run('write_memory', { file: 'project_large.md', content: huge, reason: '复审体积样本' })
    ok(String(out).startsWith('错误'), '超限内容被拒绝（而不是高高兴兴回「已写入」）', String(out).slice(0, 120))
    ok(/字节/.test(String(out)), '理由里说的是字节数', String(out).slice(0, 160))
    ok(!(await exists(join(memoryDir, 'project_large.md'))), '磁盘上确实没有这个「自己读不了」的文件')

    // 反向断言：闸门不能收得过紧 —— 正常大小的中文记忆照样写得进去、读得出来。
    const small = body('一条正常大小的中文记忆。'.repeat(50))
    const out2 = await runner.run('write_memory', { file: 'project_ok.md', content: small, reason: '复审体积样本（小）' })
    ok(String(out2).startsWith('已写入'), '正常大小的多字节内容仍然写得进去', String(out2).slice(0, 80))
    const gate = await inspectMemoryEntry(join(memoryDir, 'project_ok.md'))
    ok(gate.ok === true, '写完立刻过读取端闸门（写入端与读取端一致）', JSON.stringify(gate))
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R11：索引读失败 ≠ 索引是空的（不许抹掉用户手写内容）==')
  {
    const { memoryDir } = await world()
    await mkdir(join(memoryDir, 'archive'), { recursive: true })
    await writeFile(join(memoryDir, 'archive', 'a.md'), body('ARCHIVE'), 'utf8')
    const indexPath = join(memoryDir, 'MEMORY.md')
    const original = '# User notes\nKeep this handwritten paragraph.\n- [B](b.md)\n'
    await writeFile(indexPath, original, 'utf8')

    const real = fsPromises.readFile
    let injected = false
    fsPromises.readFile = async (p, ...a) => {
      if (p === indexPath && !injected) {
        injected = true
        const err = Error('injected EIO')
        err.code = 'EIO'
        throw err
      }
      return real(p, ...a)
    }
    syncBuiltinESMExports()
    let res
    try {
      res = await restoreMemory(memoryDir, 'a.md')
    } finally {
      fsPromises.readFile = real
      syncBuiltinESMExports()
    }

    ok(injected === true, '（前提）故障注入生效')
    ok((await readFile(indexPath, 'utf8')) === original, '索引一个字没动（旧写法会被整体重写成只剩新条目）')
    ok(res.ok === true, '文件本身仍然恢复成功（索引只是补账）', JSON.stringify(res))
    ok(res.indexed === false, '如实报告「索引没补上」', JSON.stringify(res))
    ok(typeof res.indexError === 'string' && res.indexError.length > 0, '带回失败原因，让上层能出声', JSON.stringify(res))
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R07：并发归档不许互相覆盖索引更新 ==')
  {
    const { memoryDir } = await world()
    await writeFile(join(memoryDir, 'MEMORY.md'), '- [A](a.md)\n- [B](b.md)\n', 'utf8')
    for (const n of ['a.md', 'b.md']) await writeFile(join(memoryDir, n), body(n), 'utf8')
    const res = await Promise.all([
      archiveMemory(memoryDir, 'a.md', 'review archive'),
      archiveMemory(memoryDir, 'b.md', 'review archive'),
    ])
    ok(res.every((r) => r.ok === true), '两次归档都成功', JSON.stringify(res))
    const index = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
    ok(!/\]\(a\.md\)/.test(index) && !/\]\(b\.md\)/.test(index), '两条索引行都摘掉了（旧写法总留一条悬空）', JSON.stringify(index))
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R08：并发上锁丢一条是**已声明的取舍**（钉住行为，不计回归）==')
  {
    const { memoryDir } = await world()
    const rs = await Promise.all([setLocked(memoryDir, 'a.md', true), setLocked(memoryDir, 'b.md', true)])
    const locked = [...(await readLockSet(memoryDir))]
    ok(rs.every((r) => r.ok === true), '两次上锁都返回成功（与源码注释的声明一致）', JSON.stringify(rs))
    ok(locked.length >= 1, `至少有一条真的生效（实测 ${JSON.stringify(locked)}）—— 源码注释已明示允许丢一条`)
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R02：回滚写回不许写穿记忆目录之外的硬链接 ==')
  {
    const { root, memoryDir, engine } = await world()
    await writeFile(join(memoryDir, 'a.md'), body('SNAPSHOT'), 'utf8')
    const snap = await engine.snapshot('run-hardlink', 'run')
    await writeFileAtomic(join(memoryDir, 'a.md'), body('CURRENT'))
    // cp -al / rsync --link-dest 那种快照备份会在磁盘上留下同 inode 的第二份
    const backup = join(root, 'backup.md')
    await fsPromises.link(join(memoryDir, 'a.md'), backup)

    const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
    ok(rb.ok === true && rb.restored === 1, `回滚本身成功（restored=${rb.restored}）`, JSON.stringify(rb))
    ok((await readFile(join(memoryDir, 'a.md'), 'utf8')) === body('SNAPSHOT'), '记忆目录里的 a.md 回到了快照那一版')
    ok((await readFile(backup, 'utf8')) === body('CURRENT'), '目录外的硬链接备份仍是 CURRENT（旧写法被一起改掉）')
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R02（符号链接）：回滚不许穿过链接写到目录外 ==')
  {
    const { root, memoryDir, engine } = await world()
    const probe = await (async () => {
      try {
        await writeFile(join(root, 'probe-target.md'), 'x', 'utf8')
        await fsPromises.symlink(join(root, 'probe-target.md'), join(root, 'probe-link.md'))
        return true
      } catch {
        return false
      }
    })()
    if (!probe) {
      skip('符号链接场景', '本机建不了文件符号链接（Windows 需要开发者模式 / 特权），未验证')
    } else {
      await writeFile(join(memoryDir, 'a.md'), body('SNAPSHOT'), 'utf8')
      const snap = await engine.snapshot('run-symlink', 'run')
      await fsPromises.unlink(join(memoryDir, 'a.md'))
      const outside = join(root, 'outside.md')
      await writeFile(outside, body('OUTSIDE'), 'utf8')
      await fsPromises.symlink(outside, join(memoryDir, 'a.md'))

      const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
      ok(rb.ok === true, '回滚本身成功', JSON.stringify(rb))
      ok((await readFile(outside, 'utf8')) === body('OUTSIDE'), '目录外的真实文件没被穿过链接改写')
      const lst = await fsPromises.lstat(join(memoryDir, 'a.md'))
      ok(!lst.isSymbolicLink(), 'a.md 现在是普通文件（链接被替换，而不是被穿透）')
    }
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R03：轮转不许淘汰本次回滚正在用的源 ==')
  {
    const { memoryDir, engine } = await world()
    await writeFile(join(memoryDir, 'a.md'), body('OLD'), 'utf8')
    // 攒满保护快照额度，最旧的那份就是我们要回滚到的目标
    await engine.snapshot('pre-rollback-20000101-000000', 'pre-rollback')
    for (let i = 1; i < PRE_ROLLBACK_KEEP; i++) {
      await engine.snapshot(`pre-rollback-20000101-00000${i}`, 'pre-rollback')
    }
    await writeFileAtomic(join(memoryDir, 'a.md'), body('CURRENT'))

    const rb = await engine.rollback({ snapshotId: 'pre-rollback-20000101-000000', scope: 'all' })
    ok(rb.ok === true, '回滚成功', JSON.stringify(rb))
    ok(rb.restored === 1, `真的恢复了 1 个文件（旧写法 restored=0 却报 ok:true）`, JSON.stringify(rb))
    ok(
      (await readFile(join(memoryDir, 'a.md'), 'utf8').catch(() => null)) === body('OLD'),
      '活动文件回到了选中那份快照的内容',
      String(await readFile(join(memoryDir, 'a.md'), 'utf8').catch(() => null)).slice(0, 60),
    )
    ok(await exists(join(engine.snapshotRoot, 'pre-rollback-20000101-000000')), '选中的回滚点仍在（没被自己这趟回滚删掉）')
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R03（边界）：空快照不许被「名录为空」的中止条件误伤 ==')
  {
    const { memoryDir, engine } = await world()
    // 记忆目录里一个 .md 都没有时建的快照：清单与名录**都**空 —— 这是一份合法的回滚点。
    // 中止条件只在「清单说有、目录里一个都没有」时成立；写错成「名录为空就中止」的话，
    // 会把这个正常场景连同真正的掏空一起拒掉。
    const snap = await engine.snapshot('20261012-empty', 'run')
    ok(snap.count === 0 && snap.expected === 0, '（前提）空目录快照是 count=0 / expected=0', JSON.stringify({ count: snap.count, expected: snap.expected }))
    await writeFile(join(memoryDir, 'a.md'), body('AFTER'), 'utf8')
    const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
    ok(rb.ok === true, '空快照的整目录回滚仍然合法（没被中止条件误伤）', JSON.stringify(rb))
    ok(rb.restored === 0 && rb.parked === 1, '快照之后新建的那条被移进 archive/（只移不删）', JSON.stringify(rb))
    ok(!(await exists(join(memoryDir, 'a.md'))), '顶层确实没有它了')
    ok(await exists(join(memoryDir, 'archive', 'a.md')), '它在 archive/ 里')
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R04：manifest 声明过「没存全」的快照，校验与回滚都必须拒绝 ==')
  {
    const { memoryDir, engine } = await world()
    await writeFile(join(memoryDir, 'a.md'), body('A'), 'utf8')
    await writeFile(join(memoryDir, 'b.md'), body('B'), 'utf8')

    const real = fsPromises.readFile
    fsPromises.readFile = async (p, ...a) => {
      if (p === join(memoryDir, 'a.md')) {
        const err = Error('injected EIO')
        err.code = 'EIO'
        throw err
      }
      return real(p, ...a)
    }
    syncBuiltinESMExports()
    let snap
    try {
      snap = await engine.snapshot('partial', 'run')
    } finally {
      fsPromises.readFile = real
      syncBuiltinESMExports()
    }

    ok(Array.isArray(snap.failed) && snap.failed.includes('a.md'), '（前提）快照如实记下 a.md 捕获失败', JSON.stringify(snap.failed))

    const verdict = await engine.verifySnapshot(snap.dir)
    ok(verdict.ok === false, '校验拒绝一份自己声明过残缺的快照', JSON.stringify(verdict))
    ok(String(verdict.reason ?? '').includes('没存全'), '理由说清是「当初就没存全」', String(verdict.reason ?? ''))

    const rb = await engine.rollback({ snapshotId: snap.id, scope: 'all' })
    ok(rb.ok === false, '回滚也被拒绝（旧写法 ok:true / restored:1）', JSON.stringify(rb))
    ok(await exists(join(memoryDir, 'a.md')), 'a.md 仍在活动目录（没被当成「快照里本来就没有」而停进 archive/）')
    ok((await readFile(join(memoryDir, 'a.md'), 'utf8').catch(() => null)) === body('A'), 'a.md 内容一个字没动')
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R06①：并发保存的新版本，不许被归档删掉 ==')
  {
    const { memoryDir } = await world()
    await writeFile(join(memoryDir, 'a.md'), body('OLD'), 'utf8')
    const w = await startWorker('archive-take', memoryDir)
    // 窗口：worker 已经读完 OLD、写好了归档副本，正停在「原子移走源」之前
    await writeFileAtomic(join(memoryDir, 'a.md'), body('NEW SAVE'))
    const out = await w.step()
    await w.exit()

    ok(out?.result?.ok === false, '归档如实报告「源被改写，放弃本次归档」', JSON.stringify(out?.result))
    ok((await readFile(join(memoryDir, 'a.md'), 'utf8').catch(() => null)) === body('NEW SAVE'), '新保存的版本留在原处（旧写法被 unlink 掉）')
    ok(!(await exists(join(memoryDir, 'archive', 'a.md'))), '本次没留下一份「谁的都不是」的归档副本')
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R06③：归还失败时，被误移走的那份内容绝不能丢 ==')
  {
    const { memoryDir } = await world()
    await writeFile(join(memoryDir, 'a.md'), body('OLD'), 'utf8')
    const w = await startWorker('archive-return', memoryDir)
    // 阶段①：worker 尚未移走源，主进程落笔一个新版本 —— 它将是「被误移走的那份」
    await writeFileAtomic(join(memoryDir, 'a.md'), body('NEW SAVE'))
    const m1 = await w.step()
    ok(m1?.ready === true, '（前提）worker 停在「归还」之前')
    // 阶段②：占住原名，让 link 必然 EEXIST（最坏分支）
    await writeFile(join(memoryDir, 'a.md'), body('占位'), 'utf8')
    const out = await w.step()
    await w.exit()

    ok(out?.result?.ok === false, '如实报告归还失败', JSON.stringify(out?.result))
    const leftovers = (await fsPromises.readdir(memoryDir)).filter((f) => f.includes('.archiving-'))
    ok(leftovers.length === 1, '被误移走的那份仍留在记忆目录里（旧写法/疏漏会把它删掉）', JSON.stringify(leftovers))
    // 没留下时不要把下一句变成崩测试：让它照常判 FAIL，汇总行才读得到。
    const kept = leftovers.length ? await readFile(join(memoryDir, leftovers[0]), 'utf8').catch(() => null) : null
    ok(kept === body('NEW SAVE'), '留下来的正是新版本的内容（一个字没丢）', String(kept).slice(0, 60))
    ok((await readFile(join(memoryDir, 'a.md'), 'utf8').catch(() => null)) === body('占位'), '占住原名的文件没被动过')
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== 排他落位本身：目标存在必须 EEXIST（不许靠调用方「先检查」）==')
  {
    const { memoryDir } = await world()
    const target = join(memoryDir, 'x.md')
    let r1 = null
    try {
      r1 = await writeFileExclusive(target, 'first')
    } catch (e) {
      r1 = { error: String(e?.message ?? e) }
    }
    ok((await readFile(target, 'utf8').catch(() => null)) === 'first', '目标不存在时正常写入')
    ok(r1?.exclusive === true, '本机（NTFS）走的是排他路径（硬链接可用），没有降级', JSON.stringify(r1))
    let threw = null
    try {
      await writeFileExclusive(target, 'second')
    } catch (e) {
      threw = e
    }
    ok(threw?.code === 'EEXIST', '目标已存在时原子报 EEXIST', String(threw?.code))
    ok((await readFile(target, 'utf8').catch(() => null)) === 'first', '已存在的那份一个字没动')
    const junk = (await fsPromises.readdir(memoryDir)).filter((f) => f.endsWith('.tmp'))
    ok(junk.length === 0, '两条路径都不留临时文件', JSON.stringify(junk))
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== 降级路径（平台不支持硬链接）也必须排他，不许静默退回覆盖写 ==')
  {
    const { memoryDir } = await world()
    const realLink = fsPromises.link
    // 模拟网络盘 / exFAT：link 直接报 ENOTSUP
    fsPromises.link = async () => {
      const e = new Error('injected ENOTSUP')
      e.code = 'ENOTSUP'
      throw e
    }
    syncBuiltinESMExports()
    let r = null
    let threw = null
    try {
      r = await writeFileExclusive(join(memoryDir, 'fresh.md'), 'fresh')
      try {
        await writeFileExclusive(join(memoryDir, 'fresh.md'), 'should-not-land')
      } catch (e) {
        threw = e
      }
    } catch (e) {
      // 修复前的代码没有这个导出（桩会抛）：记成结果，别让套件崩在这里。
      if (!threw) threw = e
    } finally {
      fsPromises.link = realLink
      syncBuiltinESMExports()
    }
    ok(r?.exclusive === false, 'link 不可用时走的是降级路径（如实自报 exclusive:false）', JSON.stringify(r))
    ok((await readFile(join(memoryDir, 'fresh.md'), 'utf8').catch(() => null)) === 'fresh', '降级路径下新建正常')
    ok(threw?.code === 'EEXIST', '降级路径下「目标已存在」照样 EEXIST（旧写法会静默覆盖）', String(threw?.code))
    ok((await readFile(join(memoryDir, 'fresh.md'), 'utf8').catch(() => null)) === 'fresh', '已存在的那份仍然一个字没动')
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== 索引结果字段必须过 wire codec（否则「没摘掉」在界面上永远看不见）==')
  {
    const archiveInv = invOf('sage-mem#memory/archive')
    const restoreInv = invOf('sage-mem#memory/restore')
    ok(!!archiveInv && !!restoreInv, '（前提）找得到 archive / restore 两个 remote')
    const a = archiveInv.result.schema.parse({ ok: true, file: 'a.md', archivedReason: '因为', unindexed: false, indexError: '读不了索引' })
    ok(a.indexError === '读不了索引' && a.unindexed === false, 'archive 响应的 indexError / unindexed 没被 strict 剥掉', JSON.stringify(a))
    const r = restoreInv.result.schema.parse({ ok: true, file: 'a.md', indexed: false, indexError: '读不了索引' })
    ok(r.indexError === '读不了索引' && r.indexed === false, 'restore 响应的 indexError / indexed 没被 strict 剥掉', JSON.stringify(r))
  }

  console.log('== R06⑤：内容相同、只是换了 inode（备份还原 / cp -p）不许被当成「被改写」==')
  {
    const { memoryDir } = await world()
    await writeFile(join(memoryDir, 'a.md'), body('OLD'), 'utf8')
    const w = await startWorker('archive-take', memoryDir)
    // 窗口：worker 还没移走源。用原子写把**完全相同的内容**重新落一份 —— inode 变了、内容没变。
    // 这正是 `rsync -t` / `cp -p` 还原、或备份工具回写同一份记忆的样子。
    // 判据若拿 dev:ino 当身份（曾经那版），这里会被误判成「别人写了新版本」而白白放弃归档。
    await writeFileAtomic(join(memoryDir, 'a.md'), body('OLD'))
    const out = await w.step()
    await w.exit()
    ok(out?.result?.ok === true, '内容没变就照常归档（判据是内容，不是 inode）', JSON.stringify(out?.result))
    ok((await readFile(join(memoryDir, 'archive', 'a.md'), 'utf8').catch(() => null))?.includes('OLD'), '归档件里有那条记忆')
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== 归档移不动源（被别的程序占用 → EBUSY）不许报成「文件不存在」==')
  {
    const { memoryDir } = await world()
    await writeFile(join(memoryDir, 'a.md'), body('OLD'), 'utf8')
    const realRename = fsPromises.rename
    fsPromises.rename = async (from, to, ...a) => {
      if (from === join(memoryDir, 'a.md')) {
        const e = new Error('injected EBUSY')
        e.code = 'EBUSY'
        throw e
      }
      return realRename(from, to, ...a)
    }
    syncBuiltinESMExports()
    let res
    try {
      res = await archiveMemory(memoryDir, 'a.md', '复核诊断样本')
    } finally {
      fsPromises.rename = realRename
      syncBuiltinESMExports()
    }
    ok(res.ok === false && res.code === 'move-failed', '如实报「移不动」（不是 not-found）', JSON.stringify(res))
    ok(!/not found|没有这个文件/.test(String(res.error)), '错误里不谎称文件不存在', String(res.error).slice(0, 120))
    ok(await exists(join(memoryDir, 'a.md')), '源文件仍在原处（一个字节没动）')
    ok(!(await exists(join(memoryDir, 'archive', 'a.md'))), '没留下半截归档副本')
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R05（窗口）：释放锁前必须先做廉价预检，别把锁位让给第三方 ==')
  {
    const { memoryDir, engine } = await world()
    await engine.acquireLock()
    await fsPromises.utimes(engine.lockPath, new Date(0), new Date(0))
    const next = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot: '' })
    const acquired = await next.acquireLock()
    ok(acquired === true, '（前提）B 抢到了过期锁')

    // 插桩：只要 A 去动 link，就说明它已经把自己的锁位让出去了 —— 那一刻让 C 来抢。
    const realLink = fsPromises.link
    let linkCalled = false
    let cAcquired = false
    const third = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot: '' })
    fsPromises.link = async (p, q, ...a) => {
      linkCalled = true
      cAcquired = (await third.acquireLock()) === true
      return realLink(p, q, ...a)
    }
    syncBuiltinESMExports()
    try {
      await engine.releaseLock()
    } finally {
      fsPromises.link = realLink
      syncBuiltinESMExports()
    }

    const finalLock = JSON.parse(await readFile(engine.lockPath, 'utf8').catch(() => 'null'))
    ok(linkCalled === false, '预检就发现锁不是自己的 → 根本不碰锁位（旧版会 rename 让出窗口）')
    ok(cAcquired === false, '第三方没能在窗口里拿到锁')
    ok(finalLock?.token === next.lockToken, '锁位上仍是 B 的 token', JSON.stringify(finalLock?.token === next.lockToken))
    const leftovers = (await fsPromises.readdir(join(memoryDir, '..', '.sage-mem', 'autodream')).catch(() => [])).filter((f) => f.includes('.released-'))
    ok(leftovers.length === 0, '没有把别人的锁丢成 .released-* 残留', JSON.stringify(leftovers))
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R06②：恢复不许覆盖并发新建的活动文件 ==')
  {
    const { memoryDir } = await world()
    await mkdir(join(memoryDir, 'archive'), { recursive: true })
    await writeFile(join(memoryDir, 'archive', 'a.md'), body('ARCHIVE'), 'utf8')
    const w = await startWorker('restore-link', memoryDir)
    // 窗口：worker 已经确认顶层没有 a.md，正停在落位之前
    await writeFileAtomic(join(memoryDir, 'a.md'), body('NEW ACTIVE'))
    const out = await w.step()
    await w.exit()

    ok(out?.result?.ok === false, '恢复如实报告「顶层已有同名，拒绝覆盖」', JSON.stringify(out?.result))
    ok((await readFile(join(memoryDir, 'a.md'), 'utf8').catch(() => null)) === body('NEW ACTIVE'), '新写的那版没有被盖掉')
    ok(await exists(join(memoryDir, 'archive', 'a.md')), '归档源还在（没有「覆盖 + 删源」双输）')
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('== R05：释放锁不许删掉并发换主之后的新锁 ==')
  {
    // 场景①：换主发生在「移走锁文件」之前 —— 旧持有者会移走**别人的**锁。
    const { memoryDir, engine } = await world()
    await engine.acquireLock()
    ok(!!engine.lockToken, '（前提）拿到锁')
    await fsPromises.utimes(engine.lockPath, new Date(0), new Date(0)) // 判成过期，允许抢占
    const w = await startWorker('release-before-rename', memoryDir, engine.lockPath, engine.lockToken)

    const next = new AutodreamEngine(makeCtx(), { memoryDir, sessionsRoot: '' })
    const acquired = await next.acquireLock()
    ok(acquired === true, '（前提）新持有者抢到了过期锁')
    await w.step()
    await w.exit()

    const finalLock = JSON.parse(await readFile(engine.lockPath, 'utf8').catch(() => 'null'))
    ok(finalLock !== null, '新持有者的锁文件仍然存在（旧持有者没把它移走不放）')
    ok(finalLock?.token === next.lockToken, '锁上的 token 仍是新持有者的', JSON.stringify(finalLock?.token === next.lockToken))
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {})

    // 场景②：换主发生在旧持有者「移走自己那把之后、删除之前」—— 旧实现会删掉新锁。
    const w2 = await world()
    await w2.engine.acquireLock()
    const w2w = await startWorker('release-before-rm', w2.memoryDir, w2.engine.lockPath, w2.engine.lockToken)
    // 旧实现此刻锁还在原地，抢它得先判过期；新实现已经把它移走了（utimes 自然 ENOENT）。
    await fsPromises.utimes(w2.engine.lockPath, new Date(0), new Date(0)).catch(() => {})
    const next2 = new AutodreamEngine(makeCtx(), { memoryDir: w2.memoryDir, sessionsRoot: '' })
    const acquired2 = await next2.acquireLock()
    ok(acquired2 === true, '（前提）旧锁已被移走，新持有者顺利拿到锁')
    await w2w.step()
    await w2w.exit()

    const finalLock2 = JSON.parse(await readFile(w2.engine.lockPath, 'utf8').catch(() => 'null'))
    ok(finalLock2 !== null, '新持有者的锁文件仍然存在（旧写法在这里被 rm 掉）')
    ok(finalLock2?.token === next2.lockToken, '锁上的 token 仍是新持有者的')
    await rm(w2.memoryDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log(`\n结果：${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
