/**
 * sage-mem 记忆层 —— 访问台账 + 自动归档候选。
 *
 * 台账 = `<状态根>/access.json`：`{ "<文件名>": <最近一次被注入的毫秒时间戳> }`。
 *
 * ⚠️ **只写状态目录，绝不往记忆文件里写 `last_accessed`。** 往记忆文件写等于在读路径上
 * 写盘：只读模式、并发、mtime 抖动全会出问题 —— 而读路径必须无副作用。
 *
 * 它同时是「自动归档」那个 N 天阈值**唯一**的数据来源：没有台账，「多久没被用过」只能
 * 看 frontmatter 的 updated 或文件 mtime，而这两个都不等于「没被用过」（手改一个字就刷新）。
 *
 * 候选计算是**纯确定性**的：不调模型、不看语义，只看「距上次被注入多少天」。
 */

import { MEMORY_DIR, STATE_ROOT } from './config.js'
import { ARCHIVE_DIR_NAME } from './scan.js'
import { isMemoryEntry } from './naming.js'
import { parseFrontmatter } from './frontmatter.js'
import { writeFileAtomic } from './util.js'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { nameKey } from './naming.js'

/** 台账文件：状态根下，与记忆文件分开。 */
export const ACCESS_LEDGER_FILE = join(STATE_ROOT, 'access.json')

/** 落盘节流：内存先累计，最多每 30 秒写一次盘。 */
export const ACCESS_FLUSH_INTERVAL_MS = 30 * 1000

/** 开了才出声：台账写不进去是**静默降级**，没有这个开关就查不出「为什么阈值算不准」。 */
const DEBUG = process.env.SAGE_MEM_DEBUG === '1'

/** 「永不自动归档」的类型：feedback 是用户给的做事方式，退役它等于把人的交代扔掉。 */
export const NEVER_ARCHIVE_TYPES = new Set(['feedback'])

/** 内存累计（尚未落盘）：文件名 → 时间戳，同名取最新。 */
let pending = new Map()
let flushTimer = null
let lastFlushAt = 0

/**
 * 记一次「这些文件真的被注入了」。
 *
 * 只进内存，落盘交给节流器 —— 注入链每步都跑，每步落盘就是拿读路径的稳定性换数据。
 * **同步、绝不抛**：台账是观测数据，它的问题不许升级成「记忆不再注入」。
 */
export function recordAccess(names, at = Date.now()) {
  for (const n of names ?? []) {
    if (typeof n === 'string' && n) pending.set(n, at)
  }
  scheduleFlush()
}

function scheduleFlush() {
  if (flushTimer) return
  const wait = Math.max(0, ACCESS_FLUSH_INTERVAL_MS - (Date.now() - lastFlushAt))
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushAccess().catch(() => {})
  }, wait)
  // 不阻止进程退出：这只是「顺带记一笔」的台账。
  if (typeof flushTimer.unref === 'function') flushTimer.unref()
}

/** 读盘上的台账。读不到 / JSON 坏 / 不是对象 / 值不是有限数 → 一律当空台账。 */
export async function readAccessLedger() {
  try {
    const parsed = JSON.parse(await readFile(ACCESS_LEDGER_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 当前**真实存在**的记忆文件名（根目录 + `archive/`）。
 *
 * 归档区的名字要算：归档的记忆将来可能被恢复，它「上次被注入」的时间仍然有意义。
 * 返回 `null` = 「这次扫不动」→ 调用方**保留全部键**，绝不把一次读盘失败当成
 * 「文件都没了」而清空台账。
 *
 * 两类 ENOENT 必须分开看：**`archive/` 的 ENOENT 是正常状态**（没人归档前它一直不存在），
 * 而**记忆根目录的 ENOENT 不是** —— 那说明这个路径根本不是记忆目录，按「空」回收就是
 * 一次静默的数据清空。详见下面的注释。
 */
async function currentMemoryNames(memoryDir) {
  const out = new Set()
  let unknown = false
  const collect = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) if (e.isFile() && isMemoryEntry(e.name)) out.add(e.name)
  }
  // 记忆根目录：**任何**读失败（含 ENOENT）都算「不知道」。
  // 根目录不存在不等于「记忆都没了」，而是「这个路径根本不是记忆目录」——参数传错、
  // 盘没挂上、目录被挪走。这时按「空」回收就是一次**静默的数据清空**：idleDays 会全体
  // 回落到 updated/mtime，自动归档阈值从此算错，而且没有任何信号。
  // 宁可留死键（下轮真扫到时自然会清），不可误清。
  try {
    await collect(memoryDir)
  } catch {
    unknown = true
  }
  // 归档区：ENOENT 是**正常状态**（没人归档前这个目录一直不存在）→ 算空；
  // 其余读失败（权限、盘掉线、父路径不是目录）保留全部键。
  try {
    await collect(join(memoryDir, ARCHIVE_DIR_NAME))
  } catch (err) {
    if (err?.code !== 'ENOENT') unknown = true
  }
  return unknown ? null : out
}

/**
 * 把内存里的增量并到盘上（合并写：同一文件只留最新时间戳），**落盘前顺手回收死键**。
 *
 * 台账没有别的回收物：记忆被归档 / 改名 / 删除之后，它再也不会被注入，那条时间戳
 * 就永远烂在盘上 —— autodream 的状态有 pruneSnapshots，台账也得有对应物。
 * 回收**只跟着真正的写盘一起做**（batch 非空）：一次纯粹的强刷不该去动一个没必要
 * 动的文件，也避免「拿着别的记忆目录来刷」时误清。
 *
 * **强制 flush 的时机**：每次 autodream 运行前 —— 否则「这趟整理看到的台账」可能落后
 * 若干步注入，阈值就会算偏。失败时把这一批放回内存，下次还有机会。
 *
 * @param {string} [memoryDir] — 记忆根目录（引擎必须传自己的，不许拿模块常量：它可能是别的目录）
 */
export async function flushAccess(memoryDir = MEMORY_DIR) {
  if (pending.size === 0) return { ok: true, written: 0 }
  const batch = pending
  pending = new Map()
  try {
    const onDisk = await readAccessLedger()
    for (const [name, at] of batch) {
      if (!Number.isFinite(onDisk[name]) || at > onDisk[name]) onDisk[name] = at
    }
    const alive = await currentMemoryNames(memoryDir)
    if (alive) {
      for (const key of Object.keys(onDisk)) {
        if (!alive.has(key)) delete onDisk[key]
      }
    }
    // 状态目录是插件自己的地盘，缺了可以建（autodream 的配置也存在这儿）。
    // 建不出来（只读、父路径不是目录）就走 catch 静默降级。
    await mkdir(dirname(ACCESS_LEDGER_FILE), { recursive: true })
    await writeFileAtomic(ACCESS_LEDGER_FILE, JSON.stringify(onDisk, null, 2))
    lastFlushAt = Date.now()
    return { ok: true, written: batch.size, reclaimed: alive ? true : false }
  } catch (err) {
    for (const [name, at] of batch) if (!pending.has(name)) pending.set(name, at)
    // 静默降级：注入是插件最核心的事，台账写不进去不许把它拖下水。开了 DEBUG 才出声。
    if (DEBUG) console.warn(`[sage-mem][debug] access ledger flush failed: ${err?.message ?? err}`)
    return { ok: false, error: err?.message ?? String(err) }
  }
}

/** 清掉内存里没落盘的增量（只给测试用：一次进程里想从头验节流）。 */
export function __resetAccessPendingForTest() {
  pending = new Map()
  flushTimer = null
  lastFlushAt = 0
}

/** 一条记忆的类型：frontmatter 的 `type` 优先，回落文件名前缀（`project_x.md` → `project`）。 */
export function fileType(f) {
  const fromMeta = f?.content ? parseFrontmatter(f.content).type : ''
  return String(fromMeta || f?.type || f?.file || '').split('_')[0].toLowerCase()
}

/**
 * 一条记忆「多久没被注入」（整数天；null = 无从判断）。
 *
 * 顺序不能反：**台账 → frontmatter 的 updated → 文件 mtime**。台账是「真的被用过」的
 * 唯一证据；updated 是「人写过」；mtime 只是「文件被动过」——复制、checkout、备份还原
 * 都会把它整批改掉。
 */
export function idleDays(f, ledger = {}, now = Date.now()) {
  const seen = ledger?.[f?.file]
  const fromMeta = Date.parse(f?.updated || '')
  const base = Number.isFinite(seen)
    ? seen
    : (Number.isFinite(fromMeta) ? fromMeta : (Number.isFinite(f?.mtimeMs) ? f.mtimeMs : NaN))
  if (!Number.isFinite(base)) return null
  const days = Math.floor((now - base) / 86400000)
  return days > 0 ? days : 0
}

/**
 * 算自动归档候选（确定性，不调模型）。
 *
 * @param {Array} files — `scanMemoryFiles` 的结果（**只有根目录**，所以归档区天然不在内）
 * @param {Object} ledger — 访问台账
 * @param {{thresholds?: Object, locked?: Set<string>}} opts — 按类型的阈值（天；缺阈值＝该类型永不候选）
 *        与**锁表**（`lib/memory/lock.js` 的 `readLockSet`，键已按 `nameKey` 归一）
 * @returns {Array<{file:string,type:string,days:number,limit:number,reason:string}>} 按闲置天数降序
 */
export function pickArchiveCandidates(files, ledger = {}, opts = {}, now = Date.now()) {
  const thresholds = opts.thresholds ?? {}
  const locked = opts.locked ?? null
  const out = []
  for (const f of files ?? []) {
    if (!f?.file || f.archived === true) continue
    // 锁定的记忆一个都不选：这是用户对**单条**记忆说的「别动它」，优先于阈值。
    if (locked && locked.has(nameKey(f.file))) continue
    const type = fileType(f)
    if (NEVER_ARCHIVE_TYPES.has(type)) continue
    // baseline 是「每场会话必读」的那几条：它们本来就不靠检索命中，闲置天数没有意义。
    if (f.baseline === true) continue
    const limit = Number(thresholds[type])
    if (!Number.isFinite(limit) || limit <= 0) continue
    const days = idleDays(f, ledger, now)
    if (days === null || days < limit) continue
    out.push({
      file: f.file,
      type,
      days,
      limit,
      reason: `已 ${days} 天未被注入（${type} 阈值 ${limit} 天）`,
    })
  }
  return out.sort((a, b) => b.days - a.days || a.file.localeCompare(b.file))
}
