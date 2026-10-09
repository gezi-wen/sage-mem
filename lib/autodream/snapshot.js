/**
 * autodream —— 回滚点（快照）：建立、修剪、定位、列出（引擎方法体）。
 *
 * 本文件里的函数都是 `AutodreamEngine` 的方法体：`engine.js` 里保留同名同签名的方法，
 * 用 `xxxMod.name.call(this, …)` 转发进来 —— 所以函数体里的 `this` 就是引擎实例，
 * 与拆分前完全一致，没有引入任何模块级可变状态。
 */

import { DEFAULT_CONFIG, PRE_ROLLBACK_KEEP } from './config.js'
import { readJson, safeName, snapshotEntries, stampHuman } from './util.js'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 把 memory 目录顶层的 markdown 整体快照一份，作为**回滚点**。
 *
 * 只快照顶层 `.md`：`archive/` 子目录是退役区（不需要每次跟着复制），
 * `autodream/` 是报告区（自己就是产物）。
 *
 * 每条都记 sha256：回滚后「是不是真的回到了那一版」靠它判等——只看体积在 markdown 里太容易骗人。
 *
 * @param {string} id — 快照 id（apply 运行就是 runId；保护快照用 `pre-rollback-<时间戳>`）
 * @param {'run'|'pre-rollback'} kind
 * @returns {Promise<{id:string, dir:string, count:number, expected:number, failed:string[], files:Array<{name:string,bytes:number,sha256:string}>}>}
 */
export async function snapshot(id, kind = 'run') {
  const dir = join(this.snapshotRoot, id)
  await mkdir(this.snapshotRoot, { recursive: true })
  // **故意不用 recursive**：快照 id 撞车必须是硬错误，不能静默覆盖一份已有的回滚点。
  // 实测踩到 —— 同一秒里连着两次回滚，`pre-rollback-<秒级时间戳>` 撞车，
  // 第二次的保护快照把第一次的覆盖成「回滚后」的状态，于是「退回到保护点」等于什么都没退。
  try {
    await mkdir(dir)
  } catch (err) {
    if (err?.code === 'EEXIST') throw new Error(`回滚点 id 撞车：${id} 已存在，拒绝覆盖已有的回滚点`)
    throw err
  }
  /**
   * ⚠️ 枚举失败**不能**当成「目录是空的」。
   *
   * 旧写法是 `.catch(() => [])`：读不动时静默返回空列表，于是生成一份 `count=0 / expected=0 /
   * failed=[]` 的快照 —— 它在任何一个下游检查里都长得像「一次成功的快照」，而实际上它
   * 什么都没存。回滚据此认为「退得回去」，`scope:'all'` 时更会把顶层文件全部当成
   * 「快照里没有」而停进 `archive/`。
   *
   * `ENOENT` 是唯一合法的「这里没有文件」（记忆目录还没建）。其余一律出声：宁可让调用方
   * 在写任何东西之前中止，也不要交出一份假的回滚点。
   */
  let entries
  try {
    entries = await readdir(this.memoryDir, { withFileTypes: true })
  } catch (err) {
    if (err?.code === 'ENOENT') entries = []
    else throw new Error(`快照失败：读不了记忆目录（${err?.message ?? err}），拒绝生成一份不完整的回滚点`)
  }
  const files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
  const recorded = []
  /** 没存下来的文件。**不是「警告一下就继续」**：调用方要拿它决定是否中止。 */
  const failed = []
  for (const f of files) {
    try {
      const buf = await readFile(join(this.memoryDir, f.name))
      await writeFile(join(dir, f.name), buf)
      recorded.push({ name: f.name, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') })
    } catch (err) {
      failed.push(f.name)
      this.log('warn', `快照 ${f.name} 失败：${err?.message ?? err}`)
    }
  }
  const manifest = {
    schema: 1,
    id,
    kind,
    runId: kind === 'run' ? id : null,
    createdAt: Date.now(),
    createdAtHuman: stampHuman(Date.now()),
    files: recorded,
    fileCount: recorded.length,
    failed,
  }
  await writeFile(join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await this.pruneSnapshots()
  return { id, dir, count: recorded.length, expected: files.length, failed, files: recorded }
}

/**
 * 淘汰旧回滚点。
 *
 * **两类分开数**：普通运行的快照按 `maxSnapshotKeep`；「回滚前保护快照」
 * 另给一个额度（`PRE_ROLLBACK_KEEP`）—— 保护快照的唯一用途就是「刚回滚完发现滚错了」，
 * 被普通运行的快照轮转挤掉等于没有。旧版目录（`<stateRoot>/snapshots/`）只读，不参与淘汰。
 */
export async function pruneSnapshots() {
  const keep = Math.max(1, this.state.config.maxSnapshotKeep || DEFAULT_CONFIG.maxSnapshotKeep)
  const entries = await readdir(this.snapshotRoot, { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  const preRollback = dirs.filter((n) => n.startsWith('pre-rollback-'))
  const runs = dirs.filter((n) => !n.startsWith('pre-rollback-'))
  for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
    await rm(join(this.snapshotRoot, name), { recursive: true, force: true }).catch(() => {})
  }
  for (const name of preRollback.slice(0, Math.max(0, preRollback.length - PRE_ROLLBACK_KEEP))) {
    await rm(join(this.snapshotRoot, name), { recursive: true, force: true }).catch(() => {})
  }
}

/** 快照目录的真实位置：先找新版，再找旧版；都没有返回 null。 */
export async function resolveSnapshotDir(id) {
  const name = safeName(id)
  if (!name) return null
  for (const root of [this.snapshotRoot, this.legacySnapshotRoot]) {
    const dir = join(root, name)
    const info = await stat(dir).catch(() => null)
    if (info?.isDirectory()) return dir
  }
  return null
}

/**
 * 列出所有回滚点（新版 + 旧版目录都列）。
 *
 * 「可回退到哪一份」是给人看的，所以：旧版快照标 `legacy:true`、保护快照标 `kind`，
 * 让界面能说清「这一份是哪来的」。
 */
export async function listSnapshots() {
  const out = []
  for (const [root, legacy] of [
    [this.snapshotRoot, false],
    [this.legacySnapshotRoot, true],
  ]) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = join(root, e.name)
      const manifest = await readJson(join(dir, 'MANIFEST.json'))
      const names = await snapshotEntries(dir)
      out.push({
        name: e.name,
        at: manifest?.createdAt ?? 0,
        atHuman: manifest?.createdAtHuman ?? e.name,
        files: Array.isArray(manifest?.files)
          ? manifest.files.length
          : typeof manifest?.files === 'number'
            ? manifest.files
            : names.length,
        path: dir,
        runId: manifest?.runId ?? (manifest?.kind === 'run' ? e.name : null),
        kind: manifest?.kind ?? (legacy ? 'legacy' : 'run'),
        legacy,
      })
    }
  }
  // 新的在前（名字里带时间戳，字典序即时间序）。
  out.sort((a, b) => b.name.localeCompare(a.name))
  return out
}

// ────────────────────────────── LLM 循环 ──────────────────────────────
