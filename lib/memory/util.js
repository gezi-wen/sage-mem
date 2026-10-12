/**
 * sage-mem 记忆层 —— 通用小工具：统一日志出口与原子写。
 */

import { link, open, rename, unlink, writeFile } from 'node:fs/promises'

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
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 直写的风险是崩在中途（断电、进程被杀、磁盘满）留下半截文件 —— frontmatter
 * 缺半边，这条记忆从此解析不出来、检索不到，而文件看上去还在。
 * 同卷 rename 是原子的：读方要么看到旧全文、要么看到新全文，不存在中间态。
 * 任何一步失败都不碰目标文件，**自己那份**临时文件收尾清掉。
 */
export async function writeFileAtomic(target, content) {
  tmpSeq += 1
  const uniq = `${process.pid}-${Date.now().toString(36)}-${tmpSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = `${target}.${uniq}.tmp`
  try {
    await writeFile(tmp, content, 'utf8')
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
