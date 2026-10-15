/**
 * fs-probe.mjs — 在真实宿主里验「写入门」这条路能不能走通。
 *
 * ⚠️ 这不是 `node scripts/fs-probe.mjs` 能跑的脚本 —— 它导出的是 DSH 插件。
 *
 * 跑法（本机 headless profile，与 tools-probe 同一套路）：
 *   dsh --profile headless --patch <yml> "只回复 ok"
 * 产物：`%TEMP%\sage-mem-fs-probe.json`
 *
 * 要回答的三个问题（mock 回答不了）：
 *   1. 插件里 `ctx.get('fs')` 拿得到服务吗（**不声明 inject** 的前提下）？
 *   2. `ctx.on('fs/write-intent', …)` 真的会被调到吗？返回的意图真的生效吗？
 *   3. `ctx.fs.writeText` 返回的 `FsWriteOutcome` 里有什么（operation / version / before / after）？
 *
 * 第 3 条最要紧：autodream 的收据要用它的 `operation` 与 `version` 字段。
 */

import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const name = 'sage-mem-fs-probe'

// ⚠️ 探针声明硬 inject 只为「确保拿得到服务」。**sage-mem 主插件不这样** ——
// 它用 `ctx.inject` 挂子 fiber（见 docs/decisions.md D5），因为硬依赖会让缺服务的宿主上
// 整个插件待机、记忆注入跟着消失。
export const inject = ['fs']

const REPORT = join(tmpdir(), 'sage-mem-fs-probe.json')

function write(report) {
  try { writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8') } catch {}
  console.log('[sage-mem-fs-probe]', JSON.stringify(report))
}

export function apply(ctx) {
  const report = {
    at: new Date().toISOString(),
    gotFsViaGet: false,
    gotFsViaProp: false,
    intentListenerCalled: 0,
    intentReturned: null,
    outcome: null,
    staleDetected: null,
    errors: [],
  }

  // ① 两个取法都试：`ctx.get('fs')` 与 `ctx.fs`
  try {
    report.gotFsViaGet = typeof ctx.get === 'function' && !!ctx.get('fs')
  } catch (err) { report.errors.push('get: ' + (err?.message ?? err)) }
  try {
    report.gotFsViaProp = !!ctx.fs
  } catch (err) { report.errors.push('prop: ' + (err?.message ?? err)) }

  // ② 装一个与写入门同形的监听器：第一次调用返回「按当前版本守卫」，之后放行
  let first = true
  try {
    ctx.on('fs/write-intent', async (target, actor, next) => {
      report.intentListenerCalled++
      if (!first) return next()
      first = false
      // 目标已存在时返回 replaceIfVersion（拿真实版本）；不存在时 createIfAbsent
      let info
      try { info = await ctx.fs.stat(target) } catch { info = undefined }
      const intent = info?.version ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' }
      report.intentReturned = { kind: intent.kind, hasVersion: !!info?.version }
      return intent
    })
  } catch (err) { report.errors.push('on: ' + (err?.message ?? err)) }

  const dir = mkdtempSync(join(tmpdir(), 'sage-fs-probe-'))
  const file = join(dir, 'probe.md')

  Promise.resolve()
    .then(async () => {
      const fs = ctx.get('fs') ?? ctx.fs
      if (!fs) { report.errors.push('拿不到 fs 服务'); return }
      report.hasResolve = typeof fs.resolve === 'function'
      report.hasWriteText = typeof fs.writeText === 'function'
      report.hasStat = typeof fs.stat === 'function'

      // ③ 第一次写：新建
      const target = await fs.resolve(file)
      report.targetShape = { hasTargetKey: !!target?.targetKey, hasDisplayPath: !!target?.displayPath }
      const out1 = await fs.writeText(target, '# 探针\n\n第一版内容\n')
      report.outcome = {
        operation: out1?.operation ?? null,
        versionType: typeof out1?.version,
        versionLen: typeof out1?.version === 'string' ? out1.version.length : null,
        beforeIsNull: out1?.before === null,
        afterLen: typeof out1?.after === 'string' ? out1.after.length : null,
        keys: out1 && typeof out1 === 'object' ? Object.keys(out1).sort() : [],
      }

      // ④ 第二次写：用**过期版本**守卫，应当被拒（这就是写入门要买到的东西）
      const stale = await fs.writeText(target, '# 探针\n\n第二版\n', { kind: 'replaceIfVersion', version: 'fsv:definitely-not-current' })
        .then((o) => ({ rejected: false, operation: o?.operation ?? null }))
        .catch((err) => ({ rejected: true, code: err?.code ?? null, message: String(err?.message ?? err).slice(0, 120) }))
      report.staleDetected = stale

      write(report)
    })
    .catch((err) => {
      report.errors.push('async: ' + (err?.message ?? err))
      write(report)
    })

  write(report)   // 先落一次盘：异步那步万一没跑完，至少有同步部分的证据
}
