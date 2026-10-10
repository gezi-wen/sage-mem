/**
 * sage-mem 记忆层 —— 通用小工具：统一日志出口与原子写。
 */

import { rename, unlink, writeFile } from 'node:fs/promises'

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
