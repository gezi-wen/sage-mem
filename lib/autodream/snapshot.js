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
import { join, basename } from 'node:path'

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
 * 校验一份回滚点：内容有没有被外部动过。
 *
 * 回滚是**把快照复制回记忆目录**——记忆目录没有版本控制也没有回收站，所以「拿一份假的
 * 回滚点去覆盖现在」等于一次性销毁当前全部记忆。而快照落盘后一直躺在磁盘上：备份工具
 * 还原错版本、手工编辑、杀软改写、半截写入，都会让 MANIFEST 里的哈希与实际内容对不上。
 * 校验失败必须**拒绝整趟回滚**，一个字都不许写。
 *
 * 三个方向都要查，缺一个就漏一种攻击面：
 *   - `missing`  清单里记了、盘上却没有 → 整目录回滚会把它当成「快照里没有」→ 停进 archive/
 *   - `tampered` 内容与 sha256 不符     → 会把被改过的内容当「原始版本」写回去
 *   - `extra`    盘上有、清单没记       → 整目录回滚会把它复制进记忆目录（凭空多出一条记忆）
 *
 * ⚠️ 已知边界：MANIFEST 与内容同源，**改了内容又顺手改哈希**骗得过这里（没有签名）。
 * 它防的是「无意的损坏与还原错版本」，不是有意的伪造。
 *
 * @returns {Promise<{ok:boolean, schema:'hashed'|'unhashed', checked:number,
 *   missing:string[], tampered:string[], extra:string[], invalid:string[], reason:string}>}
 */
export async function verifySnapshot(dir, opts = {}) {
  const legacy = opts?.legacy === true
  /** 无哈希可比（旧版回滚点）：放行，但要说清「这次没法校验」。 */
  const unhashed = (reason) => ({
    ok: true,
    schema: 'unhashed',
    checked: 0,
    missing: [],
    tampered: [],
    extra: [],
    invalid: [],
    reason,
  })
  /** 清单本身坏了：**拒绝**。坏掉的清单与「旧版格式」在数据上不可区分，只能从严。 */
  const broken = (reason) => ({
    ok: false,
    schema: 'broken',
    checked: 0,
    missing: [],
    tampered: [],
    extra: [],
    invalid: [],
    reason,
  })

  /**
   * ⚠️ 这里**不能**用 `readJson` 那种「读不出来就回 null」的写法。
   *
   * 一条真实的绕过：删掉 `MANIFEST.json`（或把它弄成半截 JSON）→ 旧写法一律当成
   * 「旧版快照没有哈希」放行 → 被篡改的快照内容照样写进记忆目录，**整套校验等于没有**。
   * 一个文件的删除就能拆掉安全带的修法不叫修法。
   *
   * 判据因此收紧成：新版目录（`snapshots/`）里的回滚点**必须**有一份能解析、且带逐文件
   * 哈希清单的 `MANIFEST.json`；只有旧版目录（`snapshots-legacy/` 一类）才允许没有哈希 ——
   * 那是历史遗留，废掉它等于把老回滚点全部作废。
   */
  let rawManifest
  try {
    rawManifest = await readFile(join(dir, 'MANIFEST.json'), 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT' && legacy) {
      return unhashed('这是一份旧版回滚点（目录里没有 MANIFEST.json），内容无法校验')
    }
    return broken(
      err?.code === 'ENOENT'
        ? '这份回滚点里没有 MANIFEST.json（新版回滚点必然带它）—— 无法校验内容'
        : `读不了 MANIFEST.json（${err?.message ?? err}）—— 无法校验内容`,
    )
  }
  let manifest
  try {
    manifest = JSON.parse(rawManifest)
  } catch (err) {
    return broken(`MANIFEST.json 解析失败（${err?.message ?? err}）—— 无法校验内容`)
  }
  const recorded = Array.isArray(manifest?.files) ? manifest.files : null
  if (!recorded) {
    if (legacy) return unhashed('这是一份旧版回滚点（MANIFEST 里没有逐文件哈希），内容无法校验')
    return broken('MANIFEST.json 里没有逐文件哈希清单（files 不是数组）—— 无法校验内容')
  }

  const missing = []
  const tampered = []
  const invalid = []
  let checked = 0
  for (const f of recorded) {
    const name = typeof f?.name === 'string' ? f.name : ''
    /**
     * 名字闸门只管一件事：**不许带路径成分**（`..\x.md`、`sub/x.md`、`C:\…` 一律判坏），
     * 否则 `join(dir, name)` 会指到快照目录外面去。
     *
     * 这里**不**复用 autodream 的 `safeName` —— 那套比记忆层（`memory/naming.js`）严，
     * 而 `snapshot()` 是照着 readdir 的原名记清单的：一份含 `笔记.md` / `a..b.md` 的
     * 快照会被判成「有非法文件名」而**整份滚不回去**（实测）。
     * 合法字符集由记忆层定义，这里只做边界防护。
     */
    if (!name || name !== basename(name) || name === '.' || name === '..') {
      invalid.push(name || '(空名字)')
      continue
    }
    let buf
    try {
      buf = await readFile(join(dir, name))
    } catch {
      missing.push(name)
      continue
    }
    const sha = createHash('sha256').update(buf).digest('hex')
    if (!f.sha256 || sha !== f.sha256) tampered.push(name)
    else checked += 1
  }
  const known = new Set(recorded.map((f) => f?.name))
  const extra = (await snapshotEntries(dir)).filter((n) => !known.has(n))

  const ok = !missing.length && !tampered.length && !extra.length && !invalid.length
  const parts = []
  if (missing.length) parts.push(`缺 ${missing.length} 个文件（${missing.slice(0, 3).join('、')}）`)
  if (tampered.length) parts.push(`${tampered.length} 个文件内容与哈希不符（${tampered.slice(0, 3).join('、')}）`)
  if (extra.length) parts.push(`多出 ${extra.length} 个未记录的文件（${extra.slice(0, 3).join('、')}）`)
  if (invalid.length) parts.push(`清单里有 ${invalid.length} 个非法文件名`)
  return {
    ok,
    schema: 'hashed',
    checked,
    missing,
    tampered,
    extra,
    invalid,
    reason: ok ? '' : `快照内容校验不通过：${parts.join('；')}`,
  }
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
