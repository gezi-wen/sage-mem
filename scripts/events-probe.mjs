/**
 * events-probe.mjs — 在真实宿主里数：**哪些宿主事件真的能到达一个普通插件的 `ctx`**。
 *
 * ⚠️ 不是 `node scripts/events-probe.mjs` 能跑的脚本 —— 它导出的是 DSH 插件。
 *
 * 为什么必须实测：`docs/host-facts.md` 里那些事件签名是**声明**，而「声明了」不等于
 * 「发得到」。已经实测到 `fs/write-intent` 在插件自己调 `ctx.fs.writeText` 时**一次都不发**；
 * 那么其它事件的到达性同样不能靠推断。
 *
 * 本探针**不声明 `inject`** —— 这与 sage-mem 主插件的处境一致（它有意不声明硬依赖）。
 *
 * 跑法：`dsh --profile headless --patch <yml> "…让模型调一次工具…"`
 * 产物：`%TEMP%\sage-mem-events-probe.json`
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const name = 'sage-mem-events-probe'

const REPORT = join(tmpdir(), 'sage-mem-events-probe.json')

/**
 * 要数的事件，以及**该怎么放行**。
 *
 * ⚠️ 这张表是这个探针踩过两次坑换来的：只 `.on(ev, () => count++)` 会把 **waterfall**
 * 事件的链子掐断 —— 宿主拿到 `undefined` 后去读它的 `.contexts`，整轮对话崩在
 * `Cannot read properties of undefined (reading 'contexts')`。
 * 所以：emit 类只数；waterfall 类数完必须**原样放行**（`return next()` 或返回原值）。
 */
const WATCHED = [
  { ev: 'tools/result', mode: 'emit' },
  { ev: 'fs/observed', mode: 'emit' },
  { ev: 'fs/write-intent', mode: 'waterfall' },
  { ev: 'fs/edit-intent', mode: 'waterfall' },
]

export function apply(ctx) {
  const counts = {}
  const samples = {}
  const errors = []
  for (const { ev } of WATCHED) counts[ev] = 0

  for (const { ev, mode } of WATCHED) {
    try {
      if (mode === 'waterfall') {
        ctx.on(ev, (...args) => {
          counts[ev]++
          if (!samples[ev]) {
            const target = args[0]
            samples[ev] = { keys: target && typeof target === 'object' ? Object.keys(target).slice(0, 8) : [], displayPath: target?.displayPath ?? null }
          }
          // **本探针最要紧的一条**：不声明 inject 的插件，能不能在**事件处理器里**拿到 fs 服务？
          // 写入门要靠 `ctx.get('fs').stat(target)` 取版本；拿不到就只能走 unknown，门形同虚设。
          // （已知 `apply()` 执行时刻树还很浅、拿不到服务；处理器是**之后**才跑的，理应能拿到 —— 但要实测。）
          if (ev === 'fs/write-intent' && report.getFsInHandler === null) {
            try {
              const fs = typeof ctx.get === 'function' ? ctx.get('fs') : undefined
              report.getFsInHandler = { hasFs: !!fs, hasStat: typeof fs?.stat === 'function' }
            } catch (err) {
              report.getFsInHandler = { error: String(err?.message ?? err) }
            }
          }
          // 数完原样放行：我们只是旁观者，不该改变任何决策。
          const next = args[args.length - 1]
          return typeof next === 'function' ? next() : undefined
        })
      } else {
        ctx.on(ev, (...args) => {
          counts[ev]++
          if (!samples[ev]) {
            const first = args[0]
            samples[ev] = first && typeof first === 'object'
              ? { keys: Object.keys(first).slice(0, 12), name: typeof first.name === 'string' ? first.name : null }
              : { type: typeof first }
          }
        })
      }
    } catch (err) {
      errors.push(`${ev}: ${err?.message ?? err}`)
    }
  }

  const report = { at: new Date().toISOString(), injectDeclared: false, counts, samples, errors, getFsInHandler: null, note: '只旁观，不改行为' }

  const write = () => {
    try { writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8') } catch {}
    console.log('[sage-mem-events-probe]', JSON.stringify(report))
  }

  // ⚠️ **`apply` 不许 return 函数**：实测在真实宿主里会把它当成别的东西用，
  // 随后崩在 `Cannot read properties of undefined (reading 'contexts')` ——
  // 整轮对话直接失败，而计数也就全是 0（不可信）。要清理就登记成 `ctx.effect`。
  let timer = null
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { if (timer) clearInterval(timer) })
  }
  // 周期落盘：进程随时可能退出，只在最后写一次会丢掉全部证据。
  timer = setInterval(write, 2000)
  if (typeof timer.unref === 'function') timer.unref()
  write()
}
