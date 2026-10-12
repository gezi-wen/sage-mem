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
      const moveErr = await rename(this.lockPath, grabbed).then(
        () => null,
        (err) => err,
      )
      if (moveErr) {
        /**
         * ⚠️ 失败要分流，否则「占用/权限类失败」会让这条路径**递归到自己爆栈**
         * （旧写法 `if (!moved) return this.acquireLock()`：锁没被移走，重来再走同一条分支，
         * 一路递归下去）。只有 ENOENT（别人抢先移走了、锁位确实空着）重来才有意义。
         */
        if (moveErr?.code === 'ENOENT') return this.acquireLock() // 别人抢先移走了，直接重来
        this.log?.('warn', `抢占过期锁失败（rename ${moveErr?.code ?? moveErr}）：${this.lockPath} 没能移走；${moveErr?.message ?? moveErr}`)
        return false
      }
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
        if (restored) {
          // 名字已经回到原位，这个私有名可以收掉了。
          await rm(grabbed, { force: true }).catch((err) => {
            this.log?.('warn', `锁抢占复核不通过且遗留文件清不掉：${grabbed}（${err?.message ?? err}）`)
          })
        } else {
          /**
           * ⚠️ 还回失败（锁位置已被第三方占用）时**不能删 `grabbed`**。
           *
           * 它是我们误移走的那份锁的唯一落身处，删掉等于「既没还回去、又把人家的凭据抹了」
           * —— 与 R05 同一个根因。留着它：名字带 `.stale-` 后缀，不会被任何逻辑当成锁路径，
           * 内容还在磁盘上，排错时看得见。
           */
          this.log?.('warn', `锁抢占复核不通过，且锁位置已被占用 —— 未覆盖它；被移走的那份留在 ${grabbed}`)
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
 * ⚠️ 光有 token 判据还不够（2026-10-12 复审 R05）：「读锁 → 比 token → rm」是三次独立
 * 系统调用，**比较通过之后、rm 之前**别人完全可能抢走过期锁并写入新 token（实测用
 * 两个真实进程 + IPC 暂停点即可稳定复现：新持有者拿到了锁，随即被旧持有者删掉）。
 * 判据正确的写法必须让「删」这个动作本身带上身份前提 —— 这里复用 `acquireLock` 里
 * 抢占过期锁的同一套手法：
 *
 *   ① `rename(lockPath, 私有名)` —— **原子地**把锁文件移走。同一把锁只可能被一个进程移走；
 *   ② 读移走的那份，token 是**自己的** → `rm` 私有名，释放完成；
 *   ③ token **不是自己的**（说明我们移走的是别人刚建的新锁）→ 用 `link()` 还回去。
 *      `link` 在锁位置已被占用时报 EEXIST，**绝不覆盖**；还回去了就什么都不少。
 *
 * 顺序是**三层**：预检（廉价，挡住绝大多数）→ `rename` 抢占（原子）→ 复核 + 还回（兜换主）。
 * 三层缺一不可：只有预检就是原来的 R05；只有 rename + 复核则会留下「锁位空着的窗口」——
 * 第三方在那个窗口里 `open(wx)` 能直接拿到锁（三实例实测），所以预检必须先做。
 *
 * 两条已知残留，说清楚不藏：
 *   · 预检通过之后、`rename` 之前换主 → 移走别人的锁 → 复核发现 → `link` 还回（不会删错东西）；
 *     若此刻锁位已被第三方占用，还回失败，那份锁会**留在 `.released-*`**（内容不丢，可人工捞，
 *     不会被任何路径当成锁）。
 *   · 进程在本函数中途被 kill → 锁位可能空着，后来者免过期直接拿到锁。这是「崩溃」的代价，
 *     与「两把锁同时有效」不同：那时没有任何进程会以为自己还持着已被移走的那把。
 *
 * ⚠️ 边界说清楚：`token` 明文躺在锁文件里，**它不是秘密**，防的是「协作的两个实例各跑各的」
 * 这类误删，不防「能读这个目录的对手」—— 那种对手本来就能直接删锁文件。
 */
export async function releaseLock() {
  const token = this.lockToken
  // 没持有过（acquireLock 从没成功过）→ 什么都不做。旧实现会在这里删掉别人的锁。
  if (!token) return
  /**
   * ① **廉价预检**：锁位上现在这把还是我的吗？不是就**一个动作都不做**。
   *
   * 这一步不能省（复审复核实测的三实例反例）：只靠「rename 移走 + 复核 + 还回」的话，
   * 从 `rename` 成功到 `link` 还回之间，**锁位置是空的** —— 第三方在这个窗口里
   * `open(wx)` 能直接拿到锁，而原来那把（B 的）还躺在 `.released-*` 里；
   * 终态是「B 以为独占、C 也拿着锁」，正是 R05 要防的两个整理进程同时写。
   * 预检把绝大多数情况挡在 `rename` 之前（旧实现本来就有这一步，不该丢），
   * `rename + 复核 + 还回` 只用来兜「预检通过之后才换主」那一小段。
   */
  const head = await readJson(this.lockPath)
  if (!head || head.token !== token) {
    this.lockToken = ''
    return
  }
  const grabbed = `${this.lockPath}.released-${randomUUID().replace(/-/g, '')}`
  const moveErr = await rename(this.lockPath, grabbed).then(
    () => null,
    (err) => err,
  )
  if (moveErr) {
    /**
     * ⚠️ 这里**必须分流**（复审复核实测，真机 Windows）：`rename` 失败的原因不只有
     * 「锁已经不在」。锁文件被占用（AV / 同步盘 / 只读共享）时报 EBUSY / EPERM / EACCES，
     * 那时锁**还留在盘上**，而旧写法把它和 ENOENT 混成一个分支、清掉 token 就返回 ——
     * 一行日志都没有，engine 以为自己释放了，autodream 却被自己的判据挡满 LOCK_STALE_MS。
     * `util.js` 头注那条「非 ENOENT 的失败必须落到日志」正在这条路上。
     */
    if (moveErr?.code === 'ENOENT') {
      // 锁确实不在了（另一实例抢先释放 / 被人工清掉）：没有可删的东西，也不算失败。
      this.lockToken = ''
      return
    }
    this.log?.('warn', `释放锁失败（rename ${moveErr?.code ?? moveErr}）：${this.lockPath} 没能移走，锁可能仍在盘上；${moveErr?.message ?? moveErr}`)
    // 保留 lockToken：锁大概还在，下次再试；也让调用方看得见这次没释放成功。
    return
  }
  const held = await readJson(grabbed)
  if (held?.token !== token) {
    // 预检之后、移走之前被换主了：移走的是**别人**的锁，还回去。`link` 不覆盖已存在的锁位置。
    const restored = await link(grabbed, this.lockPath).then(
      () => true,
      () => false,
    )
    if (restored) {
      await rm(grabbed, { force: true }).catch((err) => {
        this.log?.('warn', `释放锁：归还成功后残留文件清不掉：${grabbed}（${err?.message ?? err}）`)
      })
    } else {
      /**
       * ⚠️ 归还失败时**不能删 `grabbed`**：那是被我们误移走的那份锁的唯一落身处。
       * 删掉它就成了「既没还回去、又把人家的凭据抹了」—— 与 R05 同一个根因。
       * 名字带 `.released-` 后缀，不会在任何路径上被当成锁；内容留着，排错时看得见。
       */
      this.log?.('warn', `释放锁：移走的不是自己的锁，且锁位置已被占用 —— 未覆盖它；被移走的那份留在 ${grabbed}`)
    }
    this.lockToken = ''
    return
  }
  await rm(grabbed, { force: true }).catch((err) => {
    this.log?.('warn', `释放锁：删自己的私有名失败（${err?.message ?? err}）；残留 ${grabbed}`)
  })
  this.lockToken = ''
}

// ────────────────────────────── 回滚点（快照） ──────────────────────────────
