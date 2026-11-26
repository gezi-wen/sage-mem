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
 *   - fast-path 创建成功后若看到新鲜的 `.stale-*` 接管临时文件，必须撤掉自己的锁：
 *     那是「接管者正在把误移走的新鲜锁还回」的窗口，此时落位会产生第二个赢家。
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
 * 接管标记的回收阈值。
 *
 * 过期锁接管必须独占：`lockPath.steal` 用 `open(wx)` 抢，只有拿到它的进程才能
 * rename 过期锁。fast-path 创建锁后看到这个标记，就撤掉自己刚创建的那把。
 * 标记持有者进程若崩溃，下一次接管先看 pid：只有进程确实不在了才回收标记。
 * 没有 pid 的残缺标记（崩溃在写盘前）等 2 秒后按残留处理。
 */
const STEAL_STALE_MS = 2000

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

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

  /** 原子创建自己的锁文件；EEXIST 是正常的竞争结果。 */
  async function tryCreate(token) {
    let fh = null
    let created = false
    try {
      fh = await open(lockPath, 'wx')
      created = true
      await fh.write(JSON.stringify({ ...ownerMeta(), pid: process.pid, at: Date.now(), token }))
      await fh.close()
      fh = null
      return { ok: true, token }
    } catch (err) {
      if (fh) await fh.close().catch(() => {})
      // 自己创建后写入 / 关闭失败：清掉半截锁，别把后来者永久挡在外面。
      if (created) await rm(lockPath, { force: true }).catch(() => {})
      if (err?.code === 'EEXIST') {
        return { ok: false, code: 'lock_busy', reason: '另一个进程正持有锁' }
      }
      return { ok: false, code: 'lock_io', reason: `创建锁失败：${err?.message ?? err}` }
    }
  }

  const stealPath = `${lockPath}.steal`

  /**
   * 抢「过期锁接管」标记。成功返回 token；别人持有（或刚死、还没确认）返回 null。
   * 回收死者的标记也必须先 rename 到唯一名，只有一个回收者能成功。
   */
  async function acquireStealMarker() {
    const token = randomUUID()
    for (let i = 0; i < 16; i += 1) {
      let fh = null
      try {
        fh = await open(stealPath, 'wx')
        await fh.write(JSON.stringify({ pid: process.pid, at: Date.now(), token }))
        await fh.close()
        return token
      } catch (err) {
        if (fh) await fh.close().catch(() => {})
        if (err?.code !== 'EEXIST') return null
      }
      const info = await stat(stealPath).catch(() => null)
      if (!info) continue
      const holder = await readJson(stealPath)
      if (pidAlive(holder?.pid)) return null
      // 没有 pid 的标记可能是「刚创建、还没写完」：先给一个短窗口。
      if (!holder?.pid && Date.now() - info.mtimeMs <= STEAL_STALE_MS) return null
      const reaped = `${stealPath}.reaped-${randomUUID().replace(/-/g, '')}`
      const moved = await rename(stealPath, reaped).then(
        () => true,
        () => false,
      )
      if (moved) await rm(reaped, { force: true }).catch(() => {})
    }
    return null
  }

  async function releaseStealMarker(token) {
    if (!token) return
    const holder = await readJson(stealPath)
    if (!holder || holder.token !== token) return
    const released = `${stealPath}.released-${randomUUID().replace(/-/g, '')}`
    const moved = await rename(stealPath, released).then(
      () => true,
      () => false,
    )
    if (!moved) return
    const movedHolder = await readJson(released)
    if (movedHolder?.token === token) {
      await rm(released, { force: true }).catch(() => {})
    } else {
      await link(released, stealPath).catch(() => {})
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
    const marker = await stat(stealPath).catch(() => null)
    if (marker) {
      // 已有接管者。顺手回收一次死者的标记（活着的持有者会原样保留）。
      const cleanup = await acquireStealMarker()
      if (cleanup) {
        await releaseStealMarker(cleanup)
        return { ok: false, code: 'retry', reason: '回收了死者的接管标记' }
      }
      return { ok: false, code: 'lock_busy', reason: '过期锁接管进行中' }
    }

    const fresh = await tryCreate(token)
    if (fresh.ok) {
      // 创建成功不等于可以返回：若接管者恰在此刻拿到标记，这次创建必须撤回，
      // 否则接管者还原旧锁后会出现两个持有者。
      if (await stat(stealPath).catch(() => null)) {
        await release(token)
        return { ok: false, code: 'retry', reason: '过期锁接管进行中，撤回本次创建' }
      }
      return fresh
    }
    if (fresh.code !== 'lock_busy') return fresh

    const info = await stat(lockPath).catch(() => null)
    if (!info) return { ok: false, code: 'retry', reason: '锁刚消失' }
    if (Date.now() - info.mtimeMs <= staleMs) {
      return { ok: false, code: 'lock_busy', reason: '另一个进程正持有锁' }
    }

    // 只有拿到独占接管标记的进程才能 rename 过期锁。这把「多个接管者 + 空窗
    // fast-path」收成一条串行线；标记的回收靠 pid，不靠续租。
    const stealToken = await acquireStealMarker()
    if (!stealToken) return { ok: false, code: 'lock_busy', reason: '另一个进程正在接管过期锁' }
    try {
      const recheck = await stat(lockPath).catch(() => null)
      if (!recheck) return { ok: false, code: 'retry', reason: '锁在复核前消失' }
      if (Date.now() - recheck.mtimeMs <= staleMs) {
        return { ok: false, code: 'lock_busy', reason: '复核时锁已换成新鲜锁' }
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
        // 移走的是别人刚创建的新鲜锁。接管标记还在我们手里，fast-path 看到它会撤回；
        // 这里短暂重试 link，等它撤完再把原锁还原。
        let restored = false
        for (let i = 0; i < 10 && !restored; i += 1) {
          restored = await link(grabbed, lockPath).then(
            () => true,
            () => false,
          )
          if (!restored) await delay(2)
        }
        if (restored) {
          await rm(grabbed, { force: true }).catch(() => {})
        } else {
          log('warn', `锁抢占复核不通过，且锁位已被占用；被移走的那份留在 ${grabbed}`)
        }
        return { ok: false, code: 'lock_busy', reason: '复核时锁已被换主' }
      }

      // 接管标记在手：fast-path 的创建会自行撤回。给它几个毫秒收尾，然后落位。
      for (let i = 0; i < 10; i += 1) {
        const taken = await tryCreate(token)
        if (taken.ok) {
          await rm(grabbed, { force: true }).catch(() => {})
          return taken
        }
        if (taken.code !== 'lock_busy') {
          await rm(grabbed, { force: true }).catch(() => {})
          return taken
        }
        await delay(2)
      }
      await rm(grabbed, { force: true }).catch(() => {})
      return { ok: false, code: 'retry', reason: '接管后锁位仍被占用' }
    } finally {
      await releaseStealMarker(stealToken)
    }
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
      const base = backoffMs[Math.min(i, backoffMs.length - 1)] ?? 0
      // 两个进程用同一串退避会同步醒来、反复互相撞（实测首轮只差 1/80）。
      // 加 0..base 的抖动，打散轮询节拍；waitMs=0 的 gate 不走这里。
      const wait = base > 0 ? base + Math.floor(Math.random() * (base + 1)) : 1
      const left = deadline - Date.now()
      if (left <= 0) return last
      await delay(Math.min(wait, left))
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
