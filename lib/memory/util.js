/**
 * sage-mem 记忆层 —— 通用小工具：统一日志出口与原子写。
 */

import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, link, lstat, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'

/**
 * 统一告警出口。所有非 ENOENT 的失败都必须落到日志，绝不静默
 * （历史坑见 assemble 监听器里那段注释：表现是「插件在、记忆不再注入」，日志一字没有）。
 * @param ctx — 插件上下文，取 ctx.logger.warn
 * @param msg — 消息正文，调用方负责带上文件名 / 目录名
 * @param sessionId — 可选 session id，有就带
 */
export function warnLog(ctx, msg, sessionId) {
  const line = `sage-mem: ${msg}${sessionId ? ` (session ${sessionId})` : ''}`
  if (ctx?.logger?.warn) ctx.logger.warn(line)
  else console.warn(line)
}

/**
 * 进程内的临时文件序号：`writeFileAtomic` 的临时名必须**每次调用都不同**。
 *
 * 旧写法是固定的 `${target}.${process.pid}.tmp` —— 同一进程里两个调用同时写同一个目标
 * （访问台账 flush 与面板写就真实地会抢），会共用同一个临时文件：先写的 rename 成功、
 * 后写的 rename 拿到 ENOENT，而失败那方的 `finally` 还会把**别人正在用的**临时文件删掉。
 * 实测 20 次并发只有 4 次成功 —— 另外 16 次全栽在共享的那个临时文件上。
 *
 * 序号 + 随机后缀 + pid 一起用：单进程内不会撞，多进程也不会撞。
 */
let tmpSeq = 0

/** rename 的瞬时失败码：Windows 上目标正被另一个 rename 覆盖时会短暂 EPERM/EBUSY。 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST'])

/** 带退避重试的 rename —— 并发写同一目标时，瞬时占用不该被当成失败。 */
async function renameWithRetry(from, to, attempts = 8) {
  for (let i = 1; ; i++) {
    try {
      return await rename(from, to)
    } catch (err) {
      if (i >= attempts || !RENAME_RETRY_CODES.has(err?.code)) throw err
      await new Promise((r) => setTimeout(r, 4 * i))
    }
  }
}

/**
 * 新建文件（写进本原语的那些记忆与状态）的默认 mode：**只对本人可读写**。
 *
 * 为什么是明确的 0600 而不是「umask 默认」（2026-10-31 外部审查 Q18）：记忆正文是隐私
 * 内容，权限不该由开发机 / 服务器的 umask 环境决定（umask=022 时默认新建是 0644，
 * 同机其它账号可读）。写进 `writeFileAtomic` 的既有文件一律继承原 mode，
 * 所以这一条只影响**新建**。
 */
const NEW_FILE_MODE = 0o600

/**
 * 这次替换该用的 mode：**已有普通文件**继承它现在的权限位；新建文件用保守默认。
 *
 * ⚠️ 用 `lstat` 而不是 `stat`（2026-10-31 外部审查 Q18）：目标是符号链接时不该跟随 ——
 * `stat` 会拿到链接指向的**外部**文件的权限，等于把记忆文件的权限交给别处的文件决定；
 * 而 rename 之后被替换的是链接本身（不是穿透），本来也不该继承外部的 mode。
 *
 * @returns {Promise<number>} mode 位（含 setuid/setgid/sticky：`& 0o7777`）
 */
async function modeForTarget(target) {
  const info = await lstat(target).catch(() => null)
  if (!info || !info.isFile() || typeof info.mode !== 'number') return NEW_FILE_MODE
  return info.mode & 0o7777
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 直写的风险是崩在中途（断电、进程被杀、磁盘满）留下半截文件 —— frontmatter
 * 缺半边，这条记忆从此解析不出来、检索不到，而文件看上去还在。
 * 同卷 rename 是原子的：读方要么看到旧全文、要么看到新全文，不存在中间态。
 * 任何一步失败都不碰目标文件，**自己那份**临时文件收尾清掉。
 *
 * ⚠️ **权限继承**（2026-10-31 外部审查 Q18）：rename 替换的是**目录项**，新 inode
 * 不会继承原文件的 mode。旧写法新建临时文件走默认 mode，于是一个被用户设成 0600 的
 * 记忆，面板保存一次就变成 0644（umask=022），隐私被悄悄放宽，而且没有任何提示。
 * 现在在 rename **之前**把 mode 贴到临时文件上：
 *   - 已有普通文件 → 继承它现在的权限（用 lstat，不跟随符号链接）；
 *   - 新建文件 → 明确的保守模式 `NEW_FILE_MODE`（0600，不随 umask 漂）。
 * 先 `writeFile(tmp, …, { mode })` 让临时文件**一开始就不会比目标宽**，再 `chmod` 成精确值
 * （writeFile 的 mode 会被 umask 掩掉一部分，比如 0660 & ~022 = 0640）。
 * 任何一步失败都发生在 rename 之前 → 目标文件一个字节、一个权限位都不会动。
 * Windows 上 chmod 是 no-op，这里不依赖它能生效（行为断言在 POSIX 上跑）。
 */
export async function writeFileAtomic(target, content) {
  tmpSeq += 1
  const uniq = `${process.pid}-${Date.now().toString(36)}-${tmpSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = `${target}.${uniq}.tmp`
  const mode = await modeForTarget(target)
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode })
    // 精确落位：writeFile 传的 mode 受 umask 掩码，chmod 不受 —— 两者都做才既「不会更宽」
    // 又「不会被收紧」。放在 rename 之前，失败时目标仍是原样。
    await chmod(tmp, mode)
    await renameWithRetry(tmp, target)
  } finally {
    // rename 成功后 tmp 已不存在（ENOENT），失败时把它清掉不留垃圾。
    // 临时名每次唯一，所以这里删的只可能是自己那份。
    await unlink(tmp).catch(() => {})
  }
}

/** 硬链接不被支持的失败码（部分网络盘 / exFAT / 某些 FUSE）。 */
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'EXDEV'])

/**
 * **排他**落位：目标已存在时绝不覆盖，报 `EEXIST` 让调用方自己决定。
 *
 * 为什么要它（2026-10-12 复审 R06）：归档 / 恢复都是「先检查目标在不在 → 再写」，
 * 两步之间别人完全可能把目标建出来 —— `writeFileAtomic` 的 rename 会**直接盖掉**它。
 * 恢复那条路上，被盖掉的正是用户刚落笔的活动记忆。
 *
 * 实现用 `writeFile(tmp)` + `link(tmp, target)`：`link` 在目标存在时原子地报 `EEXIST`，
 * 不覆盖、没有中间态 —— 与 `autodream/gate.js` 里「还回锁」用的是同一套手法。
 *
 * ⚠️ 平台不支持硬链接时退回 **`open(target, 'wx')` 排他创建**（`exclusive:false`）：
 * 少数网络盘 / exFAT 上 link 会 EPERM/ENOTSUP，但 `open` 的 `wx` 排除标志在所有平台都可用，
 * 所以「目标已存在就绝不覆盖」这条**在降级路径上依然成立**。
 * 代价只剩一条：内容不是「一次性原子写入」（崩在中途会留下半截**新**文件），
 * 而它绝不会破坏已存在的那份数据 —— 与「把用户的活记忆盖掉」不是一个量级。
 *
 * （复审复核点出过一版更差的降级：退回 `rename` 覆盖写。那等于把 R06② 原样放回来，
 * 而且静默 —— 谁都没发现自己在网盘上失去了这层保护。别退回去。）
 *
 * 返回值 `exclusive` 是**诊断用**的：调用方不据此改变成功 / 失败的判定（降级不是错误），
 * 但断言与排错需要知道本次究竟有没有拿到排他性 —— `test/race-guards-test.mjs` 就会检查
 * 本机走的是哪条路，并单独验降级路径仍然排他。
 *
 * @returns {Promise<{exclusive:boolean}>} `exclusive:false` = 走的是 `open('wx')` 降级路径
 */
export async function writeFileExclusive(target, content) {
  tmpSeq += 1
  const uniq = `${process.pid}-${Date.now().toString(36)}-${tmpSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = `${target}.${uniq}.tmp`
  let exclusive = true
  try {
    await writeFile(tmp, content, 'utf8')
    try {
      await link(tmp, target)
    } catch (err) {
      // 目标已存在：这是**预期**的拒绝，原样抛给调用方（它负责翻译成业务错误码）。
      if (err?.code === 'EEXIST') throw err
      if (!LINK_UNSUPPORTED_CODES.has(err?.code)) throw err
      // 降级：`wx` 同样「已存在就 EEXIST」，只是内容分多次写。
      const fh = await open(target, 'wx')
      try {
        await fh.writeFile(content, 'utf8')
      } finally {
        await fh.close().catch(() => {})
      }
      exclusive = false
    }
  } finally {
    // link 成功后 target 与 tmp 是同一 inode，删 tmp 不影响 target；
    // 降级路径与失败路径下 tmp 都还是多余的那份，清掉。
    await unlink(tmp).catch(() => {})
  }
  return { exclusive }
}

/**
 * **排他移动**：把 `from` 移到 `to`，目标已存在时原子地报 `EEXIST`（绝不覆盖），
 * 成功后删源。归档 / 回滚把「不该再留在顶层的文件」移进 `archive/` 时共用这一份。
 *
 * 为什么要有它（2026-10-31 外部审查 Q11）：`rename` 在 POSIX 上会**静默覆盖**已存在的
 * 目标。回滚的旧私有实现是「`link` 失败（非 EEXIST）就 `rename`」—— 在少数网络盘 /
 * exFAT 上 link 报 EPERM/ENOTSUP，于是一份**历史旧归档**被当前文件顶掉，而回滚报成功。
 * 「先 stat 再 rename」也修不了：两次系统调用之间正是别人写同名文件的位置。
 *
 * 两条路：
 *   1. **硬链接**（首选）：`link` 在目标存在时原子报 EEXIST；成功后再删源 —— 一次性原子可见；
 *   2. **降级**（link 不可用）：`copyFile(…, COPYFILE_EXCL)` 排他复制，逐字节校验**之后**
 *      才删源。降级失去的是「一次性原子可见」，**不能同时放弃「不覆盖已有内容」**。
 *
 * ⚠️ 无法识别的错误直接失败，**绝不默认 `rename`** —— 那正是这次修掉的 bug。
 * 任何一步失败都保证**源原样保留**、目标不留半截（源是唯一内容时不丢）。
 *
 * @returns {Promise<{exclusive:boolean}>} `exclusive:false` = 走的是复制降级（诊断用，不改变成败判定）
 */
export async function moveFileExclusive(from, to) {
  try {
    await link(from, to)
  } catch (err) {
    // 目标已存在：这是**预期**的拒绝，原样抛给调用方（它负责换退役名）。
    if (err?.code === 'EEXIST') throw err
    if (!LINK_UNSUPPORTED_CODES.has(err?.code)) throw err
    return copyMoveExclusive(from, to)
  }
  try {
    await rm(from, { force: true })
  } catch (err) {
    // link 成功后 from/to 是同一 inode：删源失败时把**新名字**收回去，让调用方能干净重试。
    await rm(to, { force: true }).catch(() => {})
    throw err
  }
  return { exclusive: true }
}

/** 降级路径：排他复制 → 逐字节校验 → 删源；任何一步失败都删掉半成品、源原样保留。 */
async function copyMoveExclusive(from, to) {
  await copyFile(from, to, constants.COPYFILE_EXCL)
  try {
    const [srcBytes, dstBytes] = await Promise.all([readFile(from), readFile(to)])
    if (Buffer.compare(srcBytes, dstBytes) !== 0) {
      throw Object.assign(new Error(`sage-mem: 复制 ${from} → ${to} 后内容不一致，已放弃（源未动）`), { code: 'EIO' })
    }
  } catch (err) {
    await rm(to, { force: true }).catch(() => {})
    throw err
  }
  try {
    await rm(from, { force: true })
  } catch (err) {
    // 源删不掉：目标已经是校验过的完整副本，把它删掉让调用方能干净重试（源还在，不丢内容）。
    await rm(to, { force: true }).catch(() => {})
    throw err
  }
  return { exclusive: false }
}

/**
 * **事务式接管源文件**：把源 `rename` 到只有本次调用知道的私有名，再逐字节核对
 * 它是不是调用方读到的那些字节。
 *
 * 为什么需要它（2026-10-31 外部审查 Q06 / 复审 R06）：`unlink(名字)` / `rm(名字)`
 * 只认名字 —— 从「读到内容」到「动手删」之间隔着若干次 IO，别人完全可能在这段时间里
 * 把那个名字换成新版本，按名删除就会把**从未被收走过的新版本**从唯一的位置抹掉。
 * `rename` 是原子的：先把源移到私有名上，再对**移走的那份实物**核对内容，
 * 「名字」与「身份」就解耦了（与 `autodream/gate.js`「抢占过期锁 + 复核 + 还回」同一套手法）。
 *
 * ⚠️ 判据必须是**内容**，不能是 `dev:ino + size + mtime`（复审复核实测：原地截断改写 +
 * 体积刚好相同 + 回写 mtime 会让三元组全部命中，新版本被当成旧版本收走）。内容比对
 * 成本可忽略 —— 归档 / 恢复本来就要把这份内容读进内存。
 *
 * 失败时**绝不直接丢掉**这份内容：
 *   - 内容对不上 → 用 `link()` 还回原名；原名已被别人占住时，把它留在私有名上并带回路径；
 *   - 移不动 → 源还在原处、一个字节没动（按真实错误码分流，别谎称「源不存在」）。
 *
 * @param {string} from — 源路径
 * @param {Buffer} expected — 调用方读到的字节
 * @param {string} tag — 私有名后缀（`archiving` / `restoring`）；体检按它认崩溃残留
 * @returns {Promise<
 *   {ok:true, taken:string} |
 *   {ok:false, code:'not-found'|'move-failed'|'changed', cause?:Error, keptAt?:string}
 * >}
 */
export async function takeOverSource(from, expected, tag) {
  const taken = `${from}.${tag}-${randomUUID().replace(/-/g, '')}`
  const moveErr = await rename(from, taken).then(
    () => null,
    (err) => err,
  )
  if (moveErr) {
    return { ok: false, code: moveErr?.code === 'ENOENT' ? 'not-found' : 'move-failed', cause: moveErr }
  }
  const current = await readFile(taken).catch(() => null)
  if (current !== null && Buffer.compare(current, expected) === 0) return { ok: true, taken }
  // 移走的是**别人**的新版本：还回去，一个字节都不动。
  const back = await returnSource(taken, from)
  return { ok: false, code: 'changed', ...(back.ok ? {} : { keptAt: back.keptAt }) }
}

/**
 * 把 `takeOverSource` 接管的那份**原样**还回原名。
 *
 * 还成功时删掉私有副本；原名已被别人占住（`link` 报 EEXIST）或其它原因还不动时，
 * **绝不删它** —— 它是这份内容唯一的落身处，留在私有名上让人去捞。
 *
 * @returns {Promise<{ok:true}|{ok:false,keptAt:string}>}
 */
export async function returnSource(taken, to) {
  const linked = await link(taken, to).then(
    () => true,
    () => false,
  )
  if (!linked) return { ok: false, keptAt: taken }
  await rm(taken, { force: true }).catch(() => {})
  return { ok: true }
}

/**
 * 退役一份已经被**成功接管并落位**的私有副本。
 *
 * 调用者必须已经确认落位目标拿到了同一份内容：这里删的是私有名，不是任何可能
 * 已经被别人改过的公开名字 —— 「目标落位后归档源又被写成 B」时，B 住在公开名上，
 * 这里一个字节都碰不到它。
 */
export async function retireTaken(taken) {
  await rm(taken, { force: true }).catch(() => {})
}

/**
 * 造一个**进程内串行队列**：同一个队列上的任务一个接一个跑，绝不并发。
 *
 * 给「读整份文件 → 改 → 整体覆盖」这类操作兜底。两个这样的操作并发时，后写的那个
 * 会把先写的成果盖回去，而两边都报成功 —— 已经踩过两次：
 *   · 索引 `MEMORY.md`（复审 R07：两条并发归档各摘一行，最后总留一条悬空）
 *   · 访问台账 `access.json`（复审复核点出：debounce 定时器与运行前强刷撞上时丢时间戳）
 *
 * ⚠️ 边界：**进程内**串行，不是跨进程锁。真实并发（界面 remote、模型工具、归档策略、
 * 定时器）都在同一个插件进程里，所以覆盖得住；同时开两个 DSH 实例写同一个记忆目录时
 * 仍可能丢一次 —— 那要另加文件锁，复杂度与误伤面都不划算，这里明确不做。
 *
 * ⚠️ **队内函数不许再调同一个队列上的函数**（会自己等自己，永久挂住）。
 *
 * @returns {(fn:()=>Promise<any>)=>Promise<any>}
 */
export function createWriteQueue() {
  let tail = Promise.resolve()
  return function enqueue(fn) {
    // 显式包一层：前一次失败的 reason 不该被当成参数传进 fn（fn 不接参数）。
    const run = tail.then(
      () => fn(),
      () => fn(),
    )
    // 队尾吞掉结果与异常：一次失败不该毒化后面所有排队的任务。
    tail = run.then(
      () => {},
      () => {},
    )
    return run
  }
}

/**
 * 造一个**按 key 分队列**的进程内串行器（2.1.8 / 外部审查 N02 引入）。
 *
 * 为什么不能用一个全局队列：冲突裁决按 conflict id 串行，但不同 id 之间不该互相排队 ——
 * 一条卡住的写入不该拖住整张冲突表。同一个 key 上，整段「读记录 → 写记忆 → 写收据」
 * 必须一个接一个：两个相反裁决并发时，各自改不同记忆文件都能合法成功，最后同一份收据
 * 只剩最后一份，而两份记忆都失效了 —— 单文件的版本 CAS 保护不了整项操作。
 *
 * 队列空闲后把 entry 摘掉：长进程里 id 会不断累积，不能每个 key 永久留一条闭包链。
 * ⚠️ 与 `createWriteQueue` 同一条边界：**进程内**串行，不是跨进程锁。
 *
 * @returns {(key:string, fn:()=>Promise<any>)=>Promise<any>}
 */
export function createKeyedWriteQueue() {
  const entries = new Map()
  return function enqueue(key, fn) {
    const k = String(key)
    let entry = entries.get(k)
    if (!entry) {
      entry = { queue: createWriteQueue(), pending: 0 }
      entries.set(k, entry)
    }
    entry.pending += 1
    const done = () => {
      entry.pending -= 1
      // pending 归零且这一条还是当前那条时才摘：期间有人入队的话 pending 不会到 0。
      if (entry.pending === 0 && entries.get(k) === entry) entries.delete(k)
    }
    const run = entry.queue(fn)
    // 只挂回调、不改返回的那条 promise（失败仍由调用方接住）。
    run.then(done, done)
    return run
  }
}

/**
 * 把一组「第一个参数是 `{id}`」的 remote 方法按 id 串行（2.1.8 / N02 的用法）。
 *
 * 为什么用原型包装而不是给每个方法再写一层：四个入口（invalidate / dismiss / undo /
 * removeRecord）的**方法体本身要重新读状态**（这是队列内重读的实现），外面只多一层
 * 「按 id 排队」的接线。包装发生在 class 定义之后、宿主清单之外；typert 的调用是
 * `Reflect.get(receiver, method)` 现取，所以包装后的原型方法就是真正被执行的那个。
 *
 * @param {Function} cls — 目标类（方法定义在它的 prototype 上）
 * @param {string[]} methods — 方法名
 */
export function serializeByKey(cls, methods) {
  const withLock = createKeyedWriteQueue()
  for (const name of methods) {
    const run = cls.prototype[name]
    cls.prototype[name] = function serializeOne(first) {
      return withLock(String(first?.id ?? ''), () => run.call(this, first))
    }
  }
}

/**
 * ⚠️ 回滚写回请用 **`writeFileAtomic`**，不要用 `copyFile(src, dst)`。
 *
 * 差别只有一个，但那一个是关键：`writeFileAtomic` 是「写新文件 + rename 替换**目录项**」，
 * 而 `copyFile` 是**打开目标、往它已有的 inode 里灌内容**。后者的后果
 * （2026-10-12 复审 R02，两类链接都实测写穿）：
 *   - 目标有硬链接（`cp -al` / `rsync --link-dest` 做的快照备份）→ 记忆目录外的备份**跟着一起变**
 *   - 目标是符号链接 → 内容穿过链接落到目录外的真实文件上
 * rename 之后：硬链接关系自然解除（旧 inode 的那份备份保持原样），符号链接被**替换成本身**
 * 而不是被穿透 —— 这正是「把记忆目录恢复成快照那一版」该有的语义。
 */
