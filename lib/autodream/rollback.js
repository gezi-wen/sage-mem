/**
 * autodream —— 回滚与留痕（引擎方法体）。
 *
 * 本文件里的函数都是 `AutodreamEngine` 的方法体：`engine.js` 里保留同名同签名的方法，
 * 用 `xxxMod.name.call(this, …)` 转发进来 —— 所以函数体里的 `this` 就是引擎实例，
 * 与拆分前完全一致，没有引入任何模块级可变状态。
 */

import { REPORT_DIR } from './config.js'
import { readJson, safeName, snapshotEntries, stampCompact, stampHuman } from './util.js'
import { restoreMemory } from '../memory/archive.js'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 读回滚留痕（面板也许要显示「最近谁退回过」）。 */
export async function listRollbacks(limit = 20) {
  const all = await readJson(this.rollbacksPath)
  const list = Array.isArray(all) ? all : []
  return list.slice(-limit).reverse()
}

/** 追加一条回滚留痕。 */
export async function appendRollback(entry) {
  const all = await readJson(this.rollbacksPath)
  const list = Array.isArray(all) ? all : []
  list.push(entry)
  await mkdir(this.home, { recursive: true })
  await writeFile(this.rollbacksPath, JSON.stringify(list.slice(-200), null, 2), 'utf8')
}

/** 把运行记录标成「已被回滚」。 */
export async function markRunRolledBack(runId, at) {
  const id = safeName(runId)
  if (!id) return
  const file = join(this.runsRoot, id, 'manifest.json')
  const m = await readJson(file)
  if (!m) return
  m.rolledBackAt = at
  m.rolledBackAtHuman = stampHuman(at)
  await writeFile(file, JSON.stringify(m, null, 2), 'utf8')
}

/**
 * 把记忆目录退回到某个回滚点。
 *
 * 四步顺序不可变（见 contract §5）：
 *   ① 保护快照 —— 回滚本身也可能滚错，所以回滚前先把「现在」存下来
 *   ② 恢复 —— `all` 整目录；`files` 只动该次运行动过的文件
 *   ③ 留痕 —— 报告 + `rollbacks.json`
 *   ④ 回写运行记录
 *
 * **全程不删文件**：回滚中「不该存在」的文件一律移进 `archive/`（人工可捞回）。
 * memory 目录没有版本控制也没有回收站，`unlink` 不该出现在这条路径上。
 *
 * @param {{snapshotId:string, scope?:'files'|'all'}} opts
 */
export async function rollback(opts = {}) {
  const snapshotId = safeName(opts?.snapshotId)
  const scope = opts?.scope === 'all' ? 'all' : 'files'
  if (!snapshotId) return { ok: false, error: '快照 id 不合法' }
  if (this.running) return { ok: false, error: '正在整理中，等它跑完再回滚' }

  const snapDir = await this.resolveSnapshotDir(snapshotId)
  if (!snapDir) return { ok: false, error: `找不到回滚点：${snapshotId}` }

  await this.load()
  if (!(await this.acquireLock())) return { ok: false, error: '拿不到锁（另一趟整理正在跑？）' }
  const startedAt = Date.now()
  const stamp = stampCompact(startedAt)
  try {
    const manifest = await readJson(join(snapDir, 'MANIFEST.json'))
    const runId = manifest?.runId ?? null

    // 文件级回滚要知道「这次动过哪几个文件」——那信息在运行记录里，不在快照里。
    let runManifest = null
    if (scope === 'files') {
      if (!runId) return { ok: false, error: '这份回滚点没有绑定运行记录（旧版快照），只能选「整目录恢复」' }
      runManifest = await readJson(join(this.runsRoot, runId, 'manifest.json'))
      if (!runManifest) return { ok: false, error: `找不到回滚点 ${snapshotId} 对应的运行记录，只能选「整目录恢复」` }
    }

    // ① 保护快照
    this.phase = '回滚前保护快照'
    // 带随机后缀：秒级时间戳会撞（同一秒内连点两次回滚是真实用法），
    // 而撞车的后果是**覆盖掉上一次的保护快照**——那等于把「回滚也能退」这条承诺吃掉。
    const protectionId = `pre-rollback-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 4)}`
    const protection = await this.snapshot(protectionId, 'pre-rollback')

    /**
     * ⚠️ 保护快照不完整就**中止**，一个字都不许写。
     *
     * 它是「滚错了还能再退回来」这句承诺的唯一支撑。残缺时继续往下滚，等于拿一张假保险
     * 去覆盖当前版本 —— 而当前版本恰恰是此刻最想保住的东西。残缺的回滚点比没有回滚点
     * **更危险**，这与 `engine.js` 开工前那条（`snapshot.failed.length` 就中止）是同一条原则，
     * 只是回滚这条路上一直漏了。
     *
     * 顺手把它删掉：它落进 `snapshots/` 就会被 `listSnapshots()` 当成一份可选的回滚点，
     * 而按它恢复只会把「没存下来的那些文件」误判成「快照里没有」→ 停进 `archive/`。
     */
    if (protection.failed.length || protection.count !== protection.expected) {
      await rm(protection.dir, { recursive: true, force: true }).catch(() => {})
      const why = protection.failed.length
        ? `有 ${protection.failed.length} 个文件没存下来（${protection.failed.slice(0, 3).join('、')}${
            protection.failed.length > 3 ? '…' : ''
          }）`
        : `只存下 ${protection.count}/${protection.expected} 个文件`
      this.log('warn', `回滚中止：保护快照不完整，${why}`)
      this.phase = ''
      return {
        ok: false,
        error:
          `回滚前保护快照不完整（${why}）。为免滚错之后退不回来，这次回滚已中止，` +
          '记忆目录一个字没动。请检查文件占用与磁盘空间后重试。',
      }
    }

    // ② 恢复
    this.phase = '恢复文件'
    const snapNames = await snapshotEntries(snapDir)
    const snapSet = new Set(snapNames)
    const current = (await readdir(this.memoryDir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)

    const restored = []
    const parked = []
    const skipped = []
    const archiveDir = join(this.memoryDir, 'archive')
    await mkdir(archiveDir, { recursive: true })

    /** 移进 archive/（不删）。同名冲突就跳过并记账，绝不覆盖。 */
    const park = async (name, why) => {
      const target = join(archiveDir, name)
      const clash = await stat(target).catch(() => null)
      if (clash) {
        skipped.push(`${name}（本想${why}，但 archive/ 里已有同名文件）`)
        return false
      }
      await rename(join(this.memoryDir, name), target)
      parked.push(`${name}（${why}）`)
      return true
    }

    if (scope === 'all') {
      for (const name of snapNames) {
        try {
          await copyFile(join(snapDir, name), join(this.memoryDir, name))
          restored.push(name)
        } catch (err) {
          skipped.push(`${name}（写回失败：${err?.message ?? err}）`)
        }
      }
      // 快照之后新建的文件：整目录回滚要让它退场，但不能删——移进 archive/。
      for (const name of current) {
        if (!snapSet.has(name)) await park(name, '快照里没有，整目录回滚需退场')
      }
    } else {
      for (const c of runManifest.changes ?? []) {
        const name = c.file
        if (c.op === 'update') {
          if (snapSet.has(name)) {
            try {
              await copyFile(join(snapDir, name), join(this.memoryDir, name))
              restored.push(name)
            } catch (err) {
              skipped.push(`${name}（写回失败：${err?.message ?? err}）`)
            }
          } else {
            skipped.push(`${name}（回滚点里没有这一版，可能已被别的整理改过）`)
          }
        } else if (c.op === 'create') {
          if (current.includes(name)) await park(name, '本次整理新建，回滚即退场')
        } else if (c.op === 'archive') {
          // 归档 = 从顶层移进 archive/；回滚就是把它移回来。
          const src = join(archiveDir, name)
          const exists = await stat(src).catch(() => null)
          const atTop = await stat(join(this.memoryDir, name)).catch(() => null)
          if (!exists) skipped.push(`${name}（archive/ 里找不到，可能已人工处理过）`)
          else if (atTop) skipped.push(`${name}（顶层已有同名文件，不覆盖）`)
          else {
            await rename(src, join(this.memoryDir, name))
            restored.push(name)
          }
        }
      }

      /**
       * 策略自动归档也要退回来 —— 它按设计**不写进 `changes`**。
       *
       * `engine.js` 把两本账分开了：模型改的进 `changes`，确定性归档策略移走的进
       * `archive.archived`（已落盘在运行记录 `manifest.json` 里）。只遍历 `changes`
       * 就会整段漏掉，而这趟运行照样被标成「已回滚」、面板照报「恢复 0 个文件…已回滚」——
       * 用户以为退回来了，文件其实还躺在 `archive/` 里。
       *
       * 恢复走 `memory/archive.js` 的共享实现（与手动恢复、模型工具同一份）：它会顺手
       * 去掉 `archived_at` / `archived_reason` 两行留痕，否则「恢复」回来的是一份带着
       * 「我已被归档」标记的活记忆。
       *
       * ⚠️ 只恢复**运行前快照里存在**的文件：策略候选是运行末尾扫出来的，理论上可能包含
       * 这趟新造的文件，把它搬回来等于凭空激活一条运行前不存在的记忆（Q06 的形态）。
       */
      for (const a of runManifest.archive?.archived ?? []) {
        if (!a?.ok || !a.file) continue
        const name = a.file
        if (restored.includes(name)) continue // 上面 `changes` 那段已经把它放回来了
        if (!snapSet.has(name)) {
          skipped.push(`${name}（运行前快照里没有，说明是这趟新造的，回滚不激活它）`)
          continue
        }
        if (await stat(join(this.memoryDir, name)).catch(() => null)) {
          skipped.push(`${name}（顶层已有同名文件，不覆盖）`)
          continue
        }
        const res = await restoreMemory(this.memoryDir, name)
        if (res.ok) restored.push(name)
        else skipped.push(`${name}（恢复失败：${res.error}）`)
      }
    }

    // ③ 留痕
    this.phase = '写回滚报告'
    const reportName = `${stamp}-rollback.md`
    const lines = [
      `# Autodream 回滚报告 · ${stampHuman(startedAt)}`,
      '',
      `- 回滚目标：\`${snapshotId}\`${runId ? `（运行 \`${runId}\`）` : '（旧版快照）'}`,
      `- 范围：${scope === 'all' ? '整目录恢复到该时点' : '只恢复该次运行动过的文件'}`,
      `- 回滚前保护快照：\`${protection.id}\`（${protection.count} 个文件）—— 滚错了还能再退回来`,
      '',
      '## 写回的文件',
      '',
      restored.length ? restored.map((f) => `- \`${f}\``).join('\n') : '- （没有文件被写回）',
      '',
      '## 移进 archive/ 的文件（没有删除）',
      '',
      parked.length ? parked.map((f) => `- ${f}`).join('\n') : '- （没有）',
      '',
    ]
    if (skipped.length) {
      lines.push('## 跳过', '', ...skipped.map((f) => `- ${f}`), '')
    }
    const reportDir = join(this.memoryDir, REPORT_DIR)
    await mkdir(reportDir, { recursive: true })
    await writeFile(join(reportDir, reportName), lines.join('\n'), 'utf8')

    const entry = {
      at: startedAt,
      atHuman: stampHuman(startedAt),
      snapshotId,
      scope,
      runId,
      restored: restored.length,
      parked: parked.length,
      skipped: skipped.length,
      protection: protection.id,
      report: reportName,
    }
    await this.appendRollback(entry)
    // ④ 回写运行记录
    if (runId) await this.markRunRolledBack(runId, startedAt)

    this.phase = ''
    return {
      ok: true,
      restored: restored.length,
      parked: parked.length,
      skipped: skipped.length,
      protection: protection.id,
      report: reportName,
    }
  } catch (err) {
    const message = err?.message ?? String(err)
    this.log('warn', `回滚失败：${message}`)
    this.phase = ''
    return { ok: false, error: message }
  } finally {
    await this.releaseLock()
  }
}

// ────────────────────────────── 主流程 ──────────────────────────────
