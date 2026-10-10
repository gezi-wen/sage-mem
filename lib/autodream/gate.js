/**
 * autodream —— 门控（时间 / 会话 / 锁）与锁本身（引擎方法体）。
 *
 * 本文件里的函数都是 `AutodreamEngine` 的方法体：`engine.js` 里保留同名同签名的方法，
 * 用 `xxxMod.name.call(this, …)` 转发进来 —— 所以函数体里的 `this` 就是引擎实例，
 * 与拆分前完全一致，没有引入任何模块级可变状态。
 */

import { LOCK_STALE_MS, SESSION_SCAN_INTERVAL_MS } from './config.js'
import { countSessionsSince, readJson } from './util.js'
import { link, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/**
 * 三级门控（顺序即成本顺序）。
 * @returns {Promise<{ok:boolean, reason?:string, hoursSince?:number, sessionCount?:number}>}
 */
export async function gate() {
  await this.load()
  const cfg = this.state.config
  if (!cfg.enabled) return { ok: false, reason: '未启用' }
  if (cfg.trigger !== 'auto') return { ok: false, reason: '手动模式（不会自动触发）' }

  const now = Date.now()
  if (this.state.retryAfter && now < this.state.retryAfter) {
    return { ok: false, reason: `上次失败后的退避中（还有 ${Math.ceil((this.state.retryAfter - now) / 60000)} 分钟）` }
  }

  // ① 时间门
  const lastAt = this.state.lastRunAt
  const hoursSince = lastAt ? (now - lastAt) / 3600000 : Number.POSITIVE_INFINITY
  if (hoursSince < cfg.minHours) {
    return { ok: false, reason: `距上次整理 ${hoursSince.toFixed(1)}h < ${cfg.minHours}h` }
  }

  // ② 扫描节流（在真正扫盘之前）
  if (now - this.lastScanAt < SESSION_SCAN_INTERVAL_MS) {
    return { ok: false, reason: `扫描节流中（${Math.round((now - this.lastScanAt) / 1000)}s 前刚扫过）` }
  }
  this.lastScanAt = now

  // ③ 会话门
  const sessionCount = await countSessionsSince(this.sessionsRoot, lastAt || 0)
  if (sessionCount < cfg.minSessions) {
    return { ok: false, reason: `期间只有 ${sessionCount} 个会话更新 < ${cfg.minSessions}` }
  }
  return { ok: true, hoursSince, sessionCount }
}

// ────────────────────────────── 锁 ──────────────────────────────

export async function acquireLock() {
  await mkdir(this.home, { recursive: true })
  // 改名过渡期：旧版进程的 `dream.lock` 本插件看不见，但它一样在改 memory。
  // 新鲜（未过期）就先拒绝——正常升级流程会重启进程，这条只兜「新旧并行」那一小段窗口。
  const legacy = await stat(this.legacyLockPath).catch(() => null)
  if (legacy && Date.now() - legacy.mtimeMs <= LOCK_STALE_MS) return false
  /** 本次持有的凭据：释放时靠它认「这把锁还是我的吗」。 */
  const token = randomUUID()
  try {
    const fh = await open(this.lockPath, 'wx')
    await fh.write(JSON.stringify({ pid: process.pid, at: Date.now(), runId: this.runId, token }))
    await fh.close()
    this.lockToken = token
    return true
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err
    const info = await stat(this.lockPath).catch(() => null)
    if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      /**
       * 上次进程崩了留下的锁：清掉重来（不然 autodream 永远回不来）。
       *
       * 「判断过期 → 删掉 → 重来」这三步之间有窗口：另一个进程可能在这中间**抢到了这把锁**。
       * 所以改用 `rename` 抢占（原子，同一把锁只有一个进程能移走）。移走之后**两道复核**，
       * 缺一不可：
       *
       *   ① `mtime` 仍然超期 —— 这是**真正的判据**。`stat` 判过期与读 `before` 之间还有一次
       *      FS 操作的缝：若这期间别人已完成抢占并建了一把**新鲜**锁，我们读到的 `before`
       *      就是它，token 比对会放行，于是两个实例都以为自己拿到了（实测能复现）。
       *   ② `token` 与读到的 `before` 一致 —— 防「内容被换过」。
       *
       * 任一条不成立：说明我们移走的不是自己判定的那把过期锁，**还回去、认输**。
       */
      const before = await readJson(this.lockPath)
      const grabbed = `${this.lockPath}.stale-${randomUUID().replace(/-/g, '')}`
      const moved = await rename(this.lockPath, grabbed).then(
        () => true,
        () => false,
      )
      if (!moved) return this.acquireLock() // 别人抢先移走了，直接重来
      const movedInfo = await stat(grabbed).catch(() => null)
      const after = await readJson(grabbed)
      const stillStale = movedInfo !== null && Date.now() - movedInfo.mtimeMs > LOCK_STALE_MS
      if (!stillStale || after?.token !== before?.token) {
        // 还回去**不能覆盖**已经存在的锁（Windows 的 rename 会直接盖掉别人刚建的新锁）。
        // 用 `link` 还原：目标存在时它报 EEXIST，不会覆盖任何东西。
        const restored = await link(grabbed, this.lockPath).then(
          () => true,
          () => false,
        )
        await rm(grabbed, { force: true }).catch((err) => {
          this.log?.('warn', `锁抢占复核不通过且遗留文件清不掉：${grabbed}（${err?.message ?? err}）`)
        })
        if (!restored) {
          this.log?.('warn', `锁抢占复核不通过，但锁位置已被占用，未覆盖它：${this.lockPath}`)
        }
        return false
      }
      await rm(grabbed, { force: true }).catch((err) => {
        this.log?.('warn', `过期锁清理失败（残留 ${grabbed}）：${err?.message ?? err}`)
      })
      return this.acquireLock()
    }
    return false
  }
}

/**
 * 释放锁 —— **只删自己那一把**。
 *
 * 旧实现是无条件 `rm`：一个慢下来的持有者（比如刚跑完两小时的整理）释放时，
 * 会把**别人中途抢到的新锁**删掉 —— 于是两个整理进程同时往里写，而两边都以为自己独占。
 * 判据落在锁文件里的 `token` 上：不是自己的，一个字都不动。
 *
 * ⚠️ 边界说清楚：`token` 明文躺在锁文件里，**它不是秘密**，防的是「协作的两个实例各跑各的」
 * 这类误删，不防「能读这个目录的对手」—— 那种对手本来就能直接删锁文件。
 */
export async function releaseLock() {
  const token = this.lockToken
  // 没持有过（acquireLock 从没成功过）→ 什么都不做。旧实现会在这里删掉别人的锁。
  if (!token) return
  const held = await readJson(this.lockPath)
  if (!held || held.token !== token) {
    this.lockToken = ''
    return
  }
  await rm(this.lockPath, { force: true }).catch((err) => {
    this.log?.('warn', `释放锁失败：${err?.message ?? err}`)
  })
  this.lockToken = ''
}

// ────────────────────────────── 回滚点（快照） ──────────────────────────────
