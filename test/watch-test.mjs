#!/usr/bin/env node
/**
 * watch.js / scan.js 缓存的断言（2026-10-15 建）—— A2「目录监视失效」。
 *
 * 这个套件要回答的问题只有一个：**「快了」是不是真的**。
 * 所以核心断言不是计时，而是**计数**：把 `scan.js` 真正用的读函数（`readFile` / `open` /
 * `lstat`）包一层计数器，然后断言「第二次扫描同一目录时，打开文件的次数为 0」。
 * 没有这条断言，整个改动就是「以为快了」—— 那个假绿灯这个项目已经吃过三次。
 *
 * 三个必须遵守的前提：
 *   1. `MEMORY_DIR` 是**模块顶层**读的环境变量 —— 必须在动态 import **之前**设好。
 *   2. 全程只碰 mkdtemp 出来的临时目录，**不碰任何真实记忆目录**。
 *   3. 夹具一律合成：本仓库是公开仓库，不许出现真实记忆内容或本机路径。
 *
 * 两个测法说明：
 *   - 覆盖面而不是单个 happy path：命中 / 三方向失效 / 静默 watcher（事件全丢）/ watcher 起不来 /
 *     目录被删 / 多目录分账 / 反向对照（改了必须不命中）。
 *   - 「静默 watcher」不是造假：`fs.watch` 的事件本来就可能丢，那一组就是把**残余风险**
 *     固定成断言（增删改名仍正确、只改内容供旧值），让取舍写在测试里而不是口头上。
 *
 * 用法: node test/watch-test.mjs
 */
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
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
const skip = (name, why) => console.log(`  SKIP ${name}（${why}）`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 沙箱：环境变量必须在 import 之前 ─────────────────────────
const world = mkdtempSync(join(tmpdir(), 'sage-mem-watch-'))
const memDir = join(world, 'memory')
mkdirSync(memDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = join(world, '.sage-mem')
process.env.DSH_HOME = join(world, 'dsh-home')

/**
 * 读函数计数器 —— 本套件的**量具**。
 * ESM 的具名导入不会跟着 CJS 导出对象的改动走，所以改完要 `syncBuiltinESMExports()`
 * 把绑定重新同步一次（与 `race-guards-test` 同一套做法，那边也靠这个固定交错）。
 */
const counts = { open: 0, readFile: 0, lstat: 0, readdir: 0 }
const real = {
  open: fsPromises.open,
  readFile: fsPromises.readFile,
  lstat: fsPromises.lstat,
  readdir: fsPromises.readdir,
}
const bump = (k) => {
  counts[k]++
}
fsPromises.open = async (...a) => { bump('open'); return real.open(...a) }
fsPromises.readFile = async (...a) => { bump('readFile'); return real.readFile(...a) }
fsPromises.lstat = async (...a) => { bump('lstat'); return real.lstat(...a) }
fsPromises.readdir = async (...a) => { bump('readdir'); return real.readdir(...a) }
syncBuiltinESMExports()

/** 打开过文件没有 = open + readFile + lstat（scan 一次全扫这三样都会用上）。 */
const opened = () => counts.open + counts.readFile + counts.lstat
const zeroCounts = () => { counts.open = 0; counts.readFile = 0; counts.lstat = 0; counts.readdir = 0 }

// fs.watch 的拦截（默认透传；个别场景里换成「静默」或「抛错」的假货）
const realWatch = fs.watch
const makeFakeWatcher = () => {
  const handlers = new Map()
  const self = {
    closed: false,
    on(ev, cb) {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(cb)
      return self
    },
    close() { self.closed = true },
    fire(ev, arg) { for (const cb of handlers.get(ev) ?? []) cb(arg) },
  }
  return self
}
const restoreWatch = () => {
  fs.watch = realWatch
  syncBuiltinESMExports()
}

const { createDirWatcher } = await import(new URL('../lib/memory/watch.js', import.meta.url).href)
const { scanMemoryFiles, scanMemoryDir } = await import(new URL('../lib/memory/scan.js', import.meta.url).href)

// ── 夹具与小工具 ─────────────────────────────────────────────
const makeCtx = () => ({ logger: { warn: () => {}, info: () => {}, error: () => {} } })

/** 写一条合成记忆。`tag` 同时进 description 与正文，便于断言「这一版内容」。 */
const mem = (dir, name, tag = '合成条目') => writeFileSync(join(dir, name), [
  '---',
  `name: ${name.replace(/\.md$/, '')}`,
  `description: ${tag} 的说明`,
  'type: reference',
  '---',
  '',
  `# ${tag}`,
  '',
  '合成正文，不含任何真实记忆。',
  '',
].join('\n'), 'utf8')

const namesOf = (files) => files.map((f) => f.file).sort()
const tagOf = (files, name) => (files.find((f) => f.file === name)?.content ?? '').includes('改') ? '改' : '原'

// ══════════════════════ 1. createDirWatcher ══════════════════════

console.log('== 1. createDirWatcher：起表 / 去抖 / 失败不抛 / dispose ==')
{
  const dirA = join(world, 'w-basic')
  mkdirSync(dirA, { recursive: true })
  let n = 0
  const w = createDirWatcher(dirA, () => { n++ })
  ok(w.ok === true && w.reason === '' && typeof w.dispose === 'function', '目录存在 → ok:true、reason 空、有 dispose', JSON.stringify({ ok: w.ok, r: w.reason }))

  // 一次保存常触发多个事件：连写三个文件只该通知 1–2 次（首次立即 + 窗口末尾一次），不是三次
  mem(dirA, 'a.md')
  mem(dirA, 'b.md')
  mem(dirA, 'c.md')
  await sleep(220)
  ok(n >= 1 && n <= 2, `一次突发只通知 1–2 次（实际 ${n}）`)

  const before = n
  w.dispose()
  mem(dirA, 'd.md')
  await sleep(180)
  ok(n === before, `dispose 之后不再回调（${before} → ${n}）`)
  w.dispose()
  ok(true, 'dispose 幂等：重复调用不抛')
}
{
  const w = createDirWatcher(join(world, 'w-missing'), () => {})
  ok(w.ok === false && typeof w.reason === 'string' && w.reason.length > 0, '目录不存在 → ok:false + reason（不抛）', JSON.stringify({ ok: w.ok, r: w.reason }))
  w.dispose()
  ok(true, '起表失败的句柄也能 dispose')
}
{
  fs.watch = () => { throw Object.assign(new Error('假装这个平台不支持'), { code: 'EFAKE' }) }
  syncBuiltinESMExports()
  const w = createDirWatcher(join(world, 'w-basic'), () => {})
  ok(w.ok === false && /EFAKE/.test(w.reason), 'fs.watch 抛错 → 转成 ok:false（原因带上错误码，不抛给调用方）', JSON.stringify(w.reason))
  w.dispose()
  restoreWatch()
}
{
  let fake = null
  fs.watch = () => { fake = makeFakeWatcher(); return fake }
  syncBuiltinESMExports()
  const w = createDirWatcher(join(world, 'w-basic'), () => {})
  ok(w.ok === true, '假 watcher 起表成功时 ok:true')
  fake.fire('error', Object.assign(new Error('句柄坏了'), { code: 'EPERM' }))
  ok(w.ok === false && /EPERM/.test(w.reason), 'watcher 报错后**活的** ok 变 false（调用方据此丢缓存、退回全扫）', JSON.stringify({ ok: w.ok, r: w.reason }))
  ok(fake.closed === true, '报错后底层句柄被关掉（不留悬空 watcher）')
  w.dispose()
  restoreWatch()
}
{
  /**
   * 回归：**被监视的目录被删之后，Windows 上 `fs.watch` 会空转**。
   * 实测（本机）：2.9 秒收到 388,196 个 `'change'`，而且**不发 `'error'`** ——
   * `persistent: false` 拦不住一个忙等的句柄，于是进程 100% CPU 且永不退出。
   * 仓库里 `scripts/perf-chain.mjs` 每档结束都 `rmSync` 掉沙箱，就是这么卡死的
   * （父进程 `spawnSync` 无限等待）。这一条钉住「洪流哨兵会把它掐掉」。
   */
  const dirF = join(world, 'w-flood')
  mkdirSync(dirF, { recursive: true })
  let fired = 0
  const w = createDirWatcher(dirF, () => { fired++ })
  ok(w.ok === true, '洪流场景：先正常起表')
  rmSync(dirF, { recursive: true, force: true })
  const floodDeadline = Date.now() + 3000
  while (w.ok && Date.now() < floodDeadline) await sleep(20)
  ok(
    fired >= 1 && fired <= 3,
    `目录被删之后不空转（实际 ${fired} 次通知，不是十几万次）`,
    JSON.stringify({ ok: w.ok, r: w.reason, fired }),
  )
  /**
   * ⚠️ **这里只能断言不变量，不能断言机制。**
   *
   * 洪流哨兵是 **Windows 专属**的补丁：那边句柄失效后会以每秒十几万个事件空转、且一个 `error`
   * 都不发（实测 2.9 秒 388,196 个），哨兵是用来掐它的。
   * 而 Linux 的 inotify 在目录被删时**直接停发事件**，根本不产生洪流 —— CI 上实测
   * `{"ok":true,"r":"","fired":2}`，句柄**不会**自报失效。
   *
   * 两个平台共有的不变量是「**不空转**」（上面那条），不是「`ok` 变 false」。
   * 「watcher 死了之后正确性怎么保证」由**兜底判据**负责：每次扫描仍做一次 `readdir`
   * 比文件名集合，目录没了/重建了都会被它逮到（第 3 组有独立断言，且是在「事件全丢」的
   * 假 watcher 下验的）。
   *
   * 教训：本仓库这个月**第二次**因为「断言了机制而不是不变量」在 CI 上翻车
   * （上一次是 `..\a.md`：Windows 上 `\` 是路径分隔符、Linux 上只是普通字符）。
   */
  if (process.platform === 'win32') {
    ok(
      w.ok === false && /FLOOD|出错/.test(w.reason),
      'Windows：洪流哨兵把句柄掐掉（ok 变 false，不再空转）',
      JSON.stringify({ ok: w.ok, r: w.reason }),
    )
  } else {
    ok(
      typeof w.ok === 'boolean',
      `非 Windows：inotify 不发洪流，句柄不一定自报失效（实际 ok=${w.ok}）—— 正确性由兜底判据负责`,
    )
  }
  w.dispose()
}

// ══════════════════════ 2. 核心断言：命中时零次打开 ══════════════════════

console.log('== 2. 目录没变 → 第二次扫描一次文件都不打开（核心断言）==')
const ctx = makeCtx()
{
  for (let i = 0; i < 12; i++) mem(memDir, `cache-${i}.md`, `第 ${i} 号合成记忆`)
  const cold = await scanMemoryFiles(ctx, 'w-cold')
  ok(cold.length === 12, `冷扫拿到 12 份（实际 ${cold.length}）`, JSON.stringify(namesOf(cold)))

  zeroCounts()
  const hot = await scanMemoryFiles(ctx, 'w-hot')
  ok(namesOf(hot).join(',') === namesOf(cold).join(','), '热扫结果与冷扫一致（文件名集合逐个相同）')
  ok(hot !== cold, '热扫返回的是新数组（调用方拿不到缓存本体）')
  ok(
    opened() === 0,
    `**命中时 open / readFile / lstat 全为 0**（实际 ${JSON.stringify(counts)}）`,
    JSON.stringify(counts),
  )
  ok(counts.readdir === 1, `兜底判据仍在：命中时正好 1 次 readdir（实际 ${counts.readdir}）`)
  const f0 = hot.find((f) => f.file === 'cache-0.md')
  ok(
    !!f0 && f0.content === cold.find((f) => f.file === 'cache-0.md').content && f0.mtimeMs > 0 && f0.baseline === false,
    '缓存里的字段与冷扫逐字相同（content / mtimeMs / baseline 都在）',
  )
  zeroCounts()
  const hot2 = await scanMemoryFiles(ctx, 'w-hot2')
  ok(opened() === 0 && hot2.length === 12, '连续命中：第三次扫描同样是零打开')
  ok(counts.readdir === 1, '连续命中时每次仍只做那 1 次兜底 readdir')
}

// ══════════════════════ 3. 静默 watcher：兜底判据 + 残余风险 ══════════════════════

console.log('== 3. 静默 watcher（事件全丢）：增 / 删 / 改名靠文件名集合兜底；只改内容供旧值（已知残余风险）==')
{
  const dirS = join(world, 'silent')
  mkdirSync(dirS, { recursive: true })
  // 只对这个目录换成「永远不会回调」的 watcher：等价于 fs.watch 把事件全丢了
  const silent = new Set([dirS])
  fs.watch = (p, ...a) => (silent.has(String(p)) ? makeFakeWatcher() : realWatch(p, ...a))
  syncBuiltinESMExports()

  mem(dirS, 'a.md', '甲版')
  mem(dirS, 'b.md', '乙版')
  const cold = await scanMemoryDir(ctx, 's', dirS)
  ok(namesOf(cold).join(',') === 'a.md,b.md', '静默 watcher 下冷扫正常', JSON.stringify(namesOf(cold)))
  zeroCounts()
  const hot = await scanMemoryDir(ctx, 's', dirS)
  ok(opened() === 0 && namesOf(hot).join(',') === 'a.md,b.md', '静默 watcher 也是可信信号：目录没变时照样命中（零打开）')

  // 方向一：新增
  mem(dirS, 'c.md', '丙版')
  zeroCounts()
  const afterAdd = await scanMemoryDir(ctx, 's', dirS)
  ok(namesOf(afterAdd).includes('c.md'), '**新增**：watcher 一个字都没说，兜底判据仍让新文件出现')
  ok(opened() > 0, '新增那一轮确实走了全扫（不是命中缓存）', JSON.stringify(counts))

  // 方向二：删除
  unlinkSync(join(dirS, 'b.md'))
  zeroCounts()
  const afterDel = await scanMemoryDir(ctx, 's', dirS)
  ok(!namesOf(afterDel).includes('b.md'), '**删除**：兜底判据让消失的文件真的消失')
  ok(opened() > 0, '删除那一轮确实走了全扫', JSON.stringify(counts))

  // 方向三：改名
  renameSync(join(dirS, 'a.md'), join(dirS, 'a2.md'))
  zeroCounts()
  const afterRename = await scanMemoryDir(ctx, 's', dirS)
  ok(namesOf(afterRename).join(',') === 'a2.md,c.md', '**改名**：文件名集合变了 → 重扫', JSON.stringify(namesOf(afterRename)))
  ok(opened() > 0, '改名那一轮确实走了全扫', JSON.stringify(counts))

  // 残余风险：只改内容、名字一个字不动 —— 静默 watcher 下缓存会继续供旧值
  writeFileSync(join(dirS, 'c.md'), ['---', 'name: c', 'description: 丙版改 的说明', 'type: reference', '---', '', '# 丙版改', ''].join('\n'), 'utf8')
  zeroCounts()
  const afterEdit = await scanMemoryDir(ctx, 's', dirS)
  const c = afterEdit.find((f) => f.file === 'c.md')
  ok(
    !!c && !c.content.includes('丙版改') && opened() === 0,
    '⚠️ 已知残余风险：watcher 漏掉「只改内容」的事件时，本进程继续供**旧**内容（零打开 = 命中缓存）',
    JSON.stringify({ opened: opened(), tag: tagOf(afterEdit, 'c.md') }),
  )
  // 恢复路径：下一次任何失效（这里用新增一个文件）之后，同一份内容就对了
  mem(dirS, 'd.md', '丁版')
  const afterRecover = await scanMemoryDir(ctx, 's', dirS)
  const c2 = afterRecover.find((f) => f.file === 'c.md')
  ok(!!c2 && c2.content.includes('丙版改'), '下一次任何失效（新增文件）之后，新内容立刻可见 —— 残余风险只是「一次注入拿到旧内容」，不是永久错误')

  restoreWatch()
}

// ══════════════════════ 4. 降级路径 ══════════════════════

console.log('== 4. watcher 起不来 → 一律全扫（与改动前逐字一致，正确但不快）==')
{
  const dirD = join(world, 'degraded')
  mkdirSync(dirD, { recursive: true })
  mem(dirD, 'a.md', '第一版')
  fs.watch = () => { throw Object.assign(new Error('假装这个平台不支持'), { code: 'EPERM' }) }
  syncBuiltinESMExports()

  const first = await scanMemoryDir(ctx, 'd', dirD)
  ok(first.length === 1, '起不来也照样扫得到（不是空数组）')
  // 只改内容、名字不动：没有 watcher 时必须**立刻**看得到（因为每一轮都是全扫）
  mem(dirD, 'a.md', '第二版改')
  zeroCounts()
  const second = await scanMemoryDir(ctx, 'd', dirD)
  ok(second.length === 1 && second[0].content.includes('第二版改'), 'watcher 不可用时同名内容改动立刻可见（降级路径仍然正确）')
  ok(opened() > 0, '降级路径确实每轮都读盘（没有偷偷命中缓存）', JSON.stringify(counts))
  const third = await scanMemoryDir(ctx, 'd', dirD)
  ok(third.length === 1, '再扫一次照样正确、不抛')
  restoreWatch()
}

// ══════════════════════ 5. 目录被删 ══════════════════════

console.log('== 5. 目录被删掉之后不抛（watcher 会收到事件 / 错误）==')
{
  const dirE = join(world, 'gone')
  mkdirSync(dirE, { recursive: true })
  mem(dirE, 'a.md')
  const cold = await scanMemoryDir(ctx, 'e', dirE)
  ok(cold.length === 1, '删除之前扫得到那一份')
  rmSync(dirE, { recursive: true, force: true })
  // 让 watcher 的 rename / error 事件送达：没有 error 监听的话这里会直接崩掉整个进程
  await sleep(150)
  let threw = null
  let after = null
  try {
    after = await scanMemoryDir(ctx, 'e', dirE)
  } catch (err) {
    threw = String(err?.message ?? err)
  }
  ok(threw === null && Array.isArray(after) && after.length === 0, '目录被删后扫描返回空数组、不抛', threw ?? JSON.stringify(after))
  let threw2 = null
  try {
    await scanMemoryDir(ctx, 'e', dirE)
  } catch (err) {
    threw2 = String(err?.message ?? err)
  }
  ok(threw2 === null, '目录仍不存在时再扫也不抛（watcher 每轮重试起表，失败只是失败）')
  await sleep(80)
  ok(true, '睡过一个 watcher 错误窗口后进程还活着 —— 说明 error 事件被接住了（没接住这里是 uncaughtException）')
}

// ══════════════════════ 6. 缓存按目录分账 ══════════════════════

console.log('== 6. 缓存按目录分账：两个目录不互相污染 ==')
{
  const d1 = join(world, 'multi-a')
  const d2 = join(world, 'multi-b')
  mkdirSync(d1, { recursive: true })
  mkdirSync(d2, { recursive: true })
  mem(d1, 'only-a.md', '甲的条目')
  mem(d2, 'only-b.md', '乙的条目')
  const a = await scanMemoryDir(ctx, 'm1', d1)
  const b = await scanMemoryDir(ctx, 'm2', d2)
  ok(namesOf(a).join(',') === 'only-a.md' && namesOf(b).join(',') === 'only-b.md', '各自拿到自己那份（不是谁先扫谁说了算）', JSON.stringify([namesOf(a), namesOf(b)]))
  zeroCounts()
  const a2 = await scanMemoryDir(ctx, 'm1', d1)
  ok(namesOf(a2).join(',') === 'only-a.md' && opened() === 0, '回到第一个目录仍命中它自己的缓存（没被第二个目录顶掉）', JSON.stringify(namesOf(a2)))
}

// ══════════════════════ 7. 反向对照：改了必须不命中 ══════════════════════

console.log('== 7. 反向对照：真实 watcher 下「改一下再扫」必须不命中 ==')
{
  zeroCounts()
  const cached = await scanMemoryFiles(ctx, 'rev-0')
  ok(opened() === 0 && cached.length === 12, '先证明此刻确实是命中（零打开）', JSON.stringify(counts))

  // 7a. 新增文件 —— 兜底判据保证它一定被看见（不依赖事件是否送达）
  mem(memDir, 'zzz-brand-new.md', '新写入的条目')
  let sawNew = false
  let rescanned = false
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    zeroCounts()
    const after = await scanMemoryFiles(ctx, 'rev-1')
    if (namesOf(after).includes('zzz-brand-new.md')) {
      sawNew = true
      rescanned = opened() > 0
      break
    }
    await sleep(20)
  }
  ok(sawNew, '新增之后下一次扫描必须看到它（不是「永远命中」）')
  ok(rescanned, '看到新文件的那一轮确实走了全扫（打开计数 > 0），不是假象')

  // 7b. 只改内容、名字不动 —— 这一条只能靠 watcher 的事件（兜底判据看不出来）
  mem(memDir, 'zzz-brand-new.md', '换了一版改')
  let sawEdit = false
  let rescannedEdit = false
  const dl2 = Date.now() + 1500
  while (Date.now() < dl2) {
    zeroCounts()
    const after = await scanMemoryFiles(ctx, 'rev-2')
    const f = after.find((x) => x.file === 'zzz-brand-new.md')
    if (f && f.content.includes('换了一版改')) {
      sawEdit = true
      rescannedEdit = opened() > 0
      break
    }
    await sleep(20)
  }
  ok(sawEdit && rescannedEdit, '同名只改内容：watcher 的事件让缓存失效并重扫（代次判据真的在起作用）', JSON.stringify({ sawEdit, rescannedEdit }))

  // 7c. 稳定下来之后必须重新命中（不能因为改过一次就再也不缓存）
  const settleDeadline = Date.now() + 1000
  let rehit = false
  while (Date.now() < settleDeadline) {
    await sleep(80)
    zeroCounts()
    await scanMemoryFiles(ctx, 'rev-3')
    if (opened() === 0) {
      rehit = true
      break
    }
  }
  ok(rehit, '目录安静下来之后重新命中缓存（失效后能重新建立，不是一次性作废）')
}

// ══════════════════════ 8. 既有行为不变 ══════════════════════

console.log('== 8. 既有形状与过滤不变（缓存不许放宽任何一条）==')
{
  // 保留名（索引 / 流水）不是记忆条目；超大文件仍被体积闸门挡下
  writeFileSync(join(memDir, 'MEMORY.md'), '# 索引（合成）\n', 'utf8')
  writeFileSync(join(memDir, 'session-log.md'), '# 流水（合成）\n', 'utf8')
  writeFileSync(join(memDir, 'huge.md'), `---\nname: huge\n---\n\n${'x'.repeat(512 * 1024 + 1024)}`, 'utf8')
  let junctioned = false
  try {
    mkdirSync(join(world, 'outside-target'), { recursive: true })
    fs.symlinkSync(join(world, 'outside-target'), join(memDir, 'linkdir.md'), 'junction')
    junctioned = true
  } catch (err) {
    skip('目录联接夹具', `本机建不出 junction：${err?.code}`)
  }

  const cold = await scanMemoryFiles(ctx, 'shape-cold')
  const names = namesOf(cold)
  ok(!names.includes('MEMORY.md') && !names.includes('session-log.md'), '保留名（索引 / 流水）不算记忆条目', JSON.stringify(names))
  ok(!names.includes('huge.md'), '超过体积上限的条目仍被挡下（缓存没有放宽闸门）')
  if (junctioned) ok(!names.includes('linkdir.md'), '指向别处的目录联接仍被挡下')
  const sample = cold.find((f) => f.file === 'cache-1.md')
  ok(
    !!sample && ['file', 'content', 'description', 'aliases', 'baseline', 'baselinePriority', 'updated', 'mtimeMs'].every((k) => k in sample),
    '扫描结果字段与改动前一致（8 个键一个不少）',
    JSON.stringify(Object.keys(sample ?? {})),
  )
  // 命中这一轮的形状也必须一样（缓存里存的就是这份）
  const hot = await scanMemoryFiles(ctx, 'shape-hot')
  ok(
    namesOf(hot).join(',') === names.join(',') && !namesOf(hot).includes('huge.md'),
    '命中缓存那一轮过滤结果完全相同',
  )
}

// ── 收尾 ──
rmSync(world, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
