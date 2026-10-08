/**
 * autodream —— 门控（时间 / 会话 / 锁）与锁本身（引擎方法体）。
 *
 * 本文件里的函数都是 `AutodreamEngine` 的方法体：`engine.js` 里保留同名同签名的方法，
 * 用 `xxxMod.name.call(this, …)` 转发进来 —— 所以函数体里的 `this` 就是引擎实例，
 * 与拆分前完全一致，没有引入任何模块级可变状态。
 */

import { LOCK_STALE_MS, SESSION_SCAN_INTERVAL_MS } from './config.js'
import { countSessionsSince } from './util.js'
import { mkdir, open, rm, stat } from 'node:fs/promises'

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
  try {
    const fh = await open(this.lockPath, 'wx')
    await fh.write(JSON.stringify({ pid: process.pid, at: Date.now(), runId: this.runId }))
    await fh.close()
    return true
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err
    const info = await stat(this.lockPath).catch(() => null)
    if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      // 上次进程崩了留下的锁：清掉重来（不然 autodream 永远回不来）。
      await rm(this.lockPath, { force: true })
      return this.acquireLock()
    }
    return false
  }
}

export async function releaseLock() {
  await rm(this.lockPath, { force: true }).catch(() => {})
}

// ────────────────────────────── 回滚点（快照） ──────────────────────────────
