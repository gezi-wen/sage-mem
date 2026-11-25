/**
 * autodream —— 门控（时间 / 会话 / 锁）与锁适配层。
 *
 * 锁协议本身在 `../shared/file-lease.js`：内存状态文件与 autodream 运行锁共用同一套
 * token / mtime / rename 复核语义，避免两份实现各自漂移。这里只保留 autodream 特有策略：
 * 2 小时过期、legacy `dream.lock` 前置检查、`boolean + 裸 token` 的旧调用接口。
 */

import { LOCK_STALE_MS, SESSION_SCAN_INTERVAL_MS } from './config.js'
import { countSessionsSince } from './util.js'
import { stat } from 'node:fs/promises'
import { createFileLease } from '../shared/file-lease.js'

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

function leaseFor(engine) {
  return createFileLease({
    lockPath: engine.lockPath,
    staleMs: LOCK_STALE_MS,
    waitMs: 0,
    meta: () => ({ runId: engine.runId }),
    log: (level, msg) => engine.log?.(level, msg),
  })
}

/**
 * 抢 autodream 运行锁。
 *
 * 保持旧接口：成功 `true`、抢不到 `false`；token 仍是裸字符串存在 `this.lockToken`。
 * `dream.lock` 是升级过渡期的旧锁文件 —— 它一样在改 memory，所以新鲜时就不尝试。
 */
export async function acquireLock() {
  const legacy = await stat(this.legacyLockPath).catch(() => null)
  if (legacy && Date.now() - legacy.mtimeMs <= LOCK_STALE_MS) return false

  const got = await leaseFor(this).acquire()
  if (!got.ok) {
    // lock_busy 是正常的「别人在跑」，不刷 warn；真正的 IO 异常才值得留痕。
    if (got.code !== 'lock_busy') this.log?.('warn', `获取运行锁失败：${got.reason ?? got.code}`)
    return false
  }
  this.lockToken = got.token
  return true
}

/**
 * 释放运行锁。不是自己的 token 一个字节都不动；IO 失败保留 token，下一次还能再试。
 */
export async function releaseLock() {
  if (!this.lockToken) return
  const result = await leaseFor(this).release(this.lockToken)
  if (result.ok) {
    this.lockToken = ''
    return
  }
  this.log?.('warn', `释放运行锁失败：${result.reason ?? result.code}；token 保留以便下次重试`)
}
