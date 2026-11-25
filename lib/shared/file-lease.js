/**
 * 一个进程间协作的文件租约（**不是分布式事务**）。
 *
 * 协议只解决一件事：让同一台机器、同一个本地卷上的多个 sage-mem 进程，不会同时改写
 * 同一份状态 JSON。它不神奇地让多文件操作变成事务，也不防外部编辑器 / 同步盘 / git。
 *
 * 不变量：
 *   - `open(path, 'wx')` 是唯一的创建判定；rename 只用于抢占，绝不当条件替换。
 *   - 过期只看锁文件的 **mtime**（JSON 里的 at 仅供诊断，永不推翻 mtime）。
 *   - 抢占过期锁后必须双重复核（mtime 仍过期 **且** token 与移走前一致）；任一不成立
 *     就用 link 还回。还回不许覆盖别人的新锁。
 *   - 释放只删自己 token 那把；预检不过一个动作都不做。
 *   - 后缀 `.stale-*` / `.released-*` 是排错落点，永远不会被当成有效锁。
 */

import { link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {object} opts
 * @param {string} opts.lockPath 锁文件绝对路径
 * @param {number} opts.staleMs 超过这个 mtime 年龄视为崩溃残留
 * @param {number} [opts.waitMs=0] 抢不到时最多等多久（0 = 立即返回 busy）
 * @param {number[]} [opts.backoffMs=[4,12,36,80]] 每次失败后的等待序列
 * @param {() => object} [opts.meta] 额外写进锁文件的诊断字段
 * @param {(level:string,msg:string)=>void} [opts.log]
 */
export function createFileLease({
  lockPath,
  staleMs,
  waitMs = 0,
  backoffMs = [4, 12, 36, 80],
  meta = () => ({}),
  log = () => {},
}) {
  if (!lockPath || !Number.isFinite(staleMs) || staleMs <= 0) {
    throw new Error('createFileLease: lockPath 与 staleMs 必填')
  }

  const ownerMeta = () => {
    try {
      const value = meta()
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  /** 有一次尝试；busy / retry / io 三类结果由 acquire 决定是否再试。 */
  async function acquireOnce() {
    try {
      await mkdir(dirname(lockPath), { recursive: true })
    } catch (err) {
      return { ok: false, code: 'lock_io', reason: `创建锁目录失败：${err?.message ?? err}` }
    }
    const token = randomUUID()
    let fh
    try {
      fh = await open(lockPath, 'wx')
      await fh.write(JSON.stringify({ ...ownerMeta(), pid: process.pid, at: Date.now(), token }))
      await fh.close()
      fh = null
      return { ok: true, token }
    } catch (err) {
      if (fh) await fh.close().catch(() => {})
      if (err?.code !== 'EEXIST') {
        return { ok: false, code: 'lock_io', reason: `创建锁失败：${err?.message ?? err}` }
      }
    }

    const info = await stat(lockPath).catch(() => null)
    if (!info) return { ok: false, code: 'retry', reason: '锁刚消失' }
    if (Date.now() - info.mtimeMs <= staleMs) {
      return { ok: false, code: 'lock_busy', reason: '另一个进程正持有锁' }
    }

    const before = await readJson(lockPath)
    const grabbed = `${lockPath}.stale-${randomUUID().replace(/-/g, '')}`
    const moveErr = await rename(lockPath, grabbed).then(
      () => null,
      (err) => err,
    )
    if (moveErr) {
      if (moveErr?.code === 'ENOENT') return { ok: false, code: 'retry', reason: '别人抢先移走了' }
      return { ok: false, code: 'lock_io', reason: `抢占过期锁失败（${moveErr?.code ?? moveErr}）` }
    }

    const movedInfo = await stat(grabbed).catch(() => null)
    const after = await readJson(grabbed)
    const stillStale = movedInfo !== null && Date.now() - movedInfo.mtimeMs > staleMs
    if (!stillStale || after?.token !== before?.token) {
      const restored = await link(grabbed, lockPath).then(
        () => true,
        () => false,
      )
      if (restored) {
        await rm(grabbed, { force: true }).catch(() => {})
      } else {
        log('warn', `锁抢占复核不通过，且锁位已被占用；被移走的那份留在 ${grabbed}`)
      }
      return { ok: false, code: 'lock_busy', reason: '复核时锁已被换主' }
    }

    await rm(grabbed, { force: true }).catch(() => {})
    return { ok: false, code: 'retry', reason: '已清理过期锁，重试创建' }
  }

  /**
   * 抢锁。返回 `{ok:true, token}` 或 `{ok:false, code, reason}`。
   * 超过 waitMs 或重试序列用尽即返回 busy，不会无限递归。
   */
  async function acquire() {
    const deadline = Date.now() + Math.max(0, waitMs)
    let last = { ok: false, code: 'lock_busy', reason: '未尝试' }
    for (let i = 0; i < 128; i += 1) {
      last = await acquireOnce()
      if (last.ok) return last
      if (last.code === 'lock_io') return last
      // 已清掉过期锁 / 别人刚移走：立刻再做一次。若调用方允许等，也加一点退避，
      // 避免释放窗口里的瞬时 retry 在一微秒内把重试次数烧完。
      if (last.code === 'retry' && waitMs <= 0) continue
      if (last.code === 'lock_busy' && waitMs <= 0) return last
      const wait = backoffMs[Math.min(i, backoffMs.length - 1)] ?? 0
      const left = deadline - Date.now()
      if (left <= 0) return last
      await delay(Math.min(Math.max(wait, 1), left))
    }
    return last
  }

  /**
   * 释放 token 对应那把锁。幂等；不是自己的锁绝不删。
   * @returns {Promise<{ok:boolean, code?:string}>}
   */
  async function release(token) {
    if (!token) return { ok: true }
    const head = await readJson(lockPath)
    if (!head || head.token !== token) return { ok: true }

    const grabbed = `${lockPath}.released-${randomUUID().replace(/-/g, '')}`
    const moveErr = await rename(lockPath, grabbed).then(
      () => null,
      (err) => err,
    )
    if (moveErr) {
      if (moveErr?.code === 'ENOENT') return { ok: true }
      return { ok: false, code: 'io_error', reason: `释放锁失败（${moveErr?.code ?? moveErr}）` }
    }

    const held = await readJson(grabbed)
    if (held?.token !== token) {
      const restored = await link(grabbed, lockPath).then(
        () => true,
        () => false,
      )
      if (restored) {
        await rm(grabbed, { force: true }).catch(() => {})
      } else {
        log('warn', `释放时移走的不是自己的锁，且锁位已被占用；被移走的那份留在 ${grabbed}`)
      }
      return { ok: true }
    }
    await rm(grabbed, { force: true }).catch(() => {})
    return { ok: true }
  }

  return { acquire, release }
}
