/**
 * sage-mem 记忆层 —— 归档的**唯一实现**。
 *
 * 归档有三条入口：手动 remote（`memory.archive`）、模型工具（autodream 的
 * `archive_memory`）、自动归档策略。三处都调这里 —— 之前「手动写留痕、工具只 rename」
 * 是两份实现，已经漂移过一次：自动归档收起来的记忆在面板上显示「时间未知 / 没写理由」，
 * 而档案馆的意义恰恰是回答「它为什么被收起来」。
 *
 * 语义（A 阶段冻结、三条路径共用）：
 *   - **只移不删**：文件进 `archive/`，名字不变；
 *   - 移动前写 `archived_at`（本地时间 `YYYY-MM-DD HH:mm`）与 `archived_reason`；
 *   - 拒绝一律返回 `{ ok:false, code, error }`，由调用方决定抛还是回 `{ ok:false }`。
 *
 * ⚠️ 记忆目录**必须由调用方传进来**：autodream 引擎的 memoryDir 可以是任意目录（测试里
 * 就是临时目录），拿模块级常量会写错地方 —— 那是会碰到真实记忆的危险错误。
 */

import { ARCHIVE_DIR_NAME, addArchiveMeta, inspectDir, inspectMemoryEntry, localStamp, stripArchiveMeta } from './scan.js'
import { isReserved, nameKey, safeName } from './naming.js'
import { writeFileAtomic } from './util.js'
import { isLocked } from './lock.js'
import { ensureIndexEntry, dropIndexEntry } from './index-file.js'
import { mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** 归档区绝对路径（按调用方给的记忆目录算）。 */
export const archiveDirOf = (memoryDir) => join(memoryDir, ARCHIVE_DIR_NAME)

/** 名字闸门：保留名 → 非 .md / 带路径成分。返回 { ok:true, safe } 或 { ok:false, code, error }。 */
function checkName(name, verb) {
  if (isReserved(name)) {
    return { ok: false, code: 'reserved', error: `sage-mem: reserved file, refusing to ${verb}: ${nameKey(name)}` }
  }
  const safe = safeName(name)
  if (!safe) return { ok: false, code: 'invalid-name', error: `sage-mem: invalid file name: ${String(name)}` }
  return { ok: true, safe }
}

/**
 * 归档一条记忆：写留痕 + 移进 `archive/`（不删）。
 *
 * @param {string} memoryDir — 记忆根目录（调用方给，不许拿模块常量）
 * @param {string} name — 文件名（根目录里必须已存在）
 * @param {string} [reason] — 归档缘由；空/省略时写默认「手动归档」
 * @param {string} [at] — 归档时间（默认本地时间 `YYYY-MM-DD HH:mm`）
 * @returns {Promise<{ok:true,file:string,archivedReason:string}|{ok:false,code:string,error:string}>}
 */
export async function archiveMemory(memoryDir, name, reason, at = localStamp()) {
  const gate = checkName(name, 'archive')
  if (!gate.ok) return gate
  const safe = gate.safe
  /**
   * 「锁定」优先于一切：锁上的记忆**自动与手动都不许归档**。
   * 放在最前面判 —— 名字合法之后立刻拒绝，不读目录、不算理由。
   */
  if (await isLocked(memoryDir, safe)) {
    return { ok: false, code: 'locked', error: `sage-mem: locked, refusing to archive: ${safe}（先在界面里解锁）` }
  }
  const src = join(memoryDir, safe)
  const dst = join(archiveDirOf(memoryDir), safe)
  /**
   * 两道闸门，缺一不可：
   *   - 源文件：链接 / 硬链接指向的可能是记忆目录**之外**的文件，归档它 = 把它从外部搬走
   *   - 归档区：它若被换成指向外部的目录联接，归档 = 把记忆搬出记忆目录
   * （体积不在这里判：归档是搬移，不是写入。）
   */
  const srcGate = await inspectMemoryEntry(src, { limitBytes: null })
  // 根目录里没有 → 文件名写错，或者它已经是归档态（归档区那份不该再归档一次）。
  if (!srcGate.ok) {
    return {
      ok: false,
      code: srcGate.code === 'missing' ? 'not-found' : srcGate.code,
      error: `sage-mem: file not found: ${safe}（${srcGate.error}）`,
    }
  }
  const dirGate = await inspectDir(archiveDirOf(memoryDir))
  // 归档区还不存在是正常状态（下面 mkdir 会建）。
  if (!dirGate.ok && dirGate.code !== 'missing') {
    return { ok: false, code: dirGate.code, error: `sage-mem: archive dir unavailable: ${dirGate.error}` }
  }
  if (await stat(dst).catch(() => null)) {
    // 归档区已有同名：不覆盖 —— 那份旧归档可能是用户想留的另一版。
    return { ok: false, code: 'exists', error: `sage-mem: already archived: ${safe}` }
  }
  const content = await readFile(src, 'utf8')
  // 空理由给默认值：手动 remote 允许省略（工具那侧自己会先挡掉空理由，那是它自己的语义）。
  const why = String(reason ?? '').trim() || '手动归档'
  const stamped = addArchiveMeta(content, why, at)
  await mkdir(archiveDirOf(memoryDir), { recursive: true })
  // 先落归档副本、再删原件：中途崩了最坏是两份都在（人工可收拾），不会一份都没有。
  await writeFileAtomic(dst, stamped)
  await unlink(src)
  /**
   * **从索引里摘掉**（与恢复时补索引对称）：索引是「活动记忆的清单」，
   * 记忆归档了就该从清单里退出 —— 不摘的话审计会报「索引悬空」。
   * 2026-10-11 在真实库里撞到过：归档两条，体检立刻从 0 问题变 2 问题。
   * 摘失败**不算归档失败**：文件已经移走了，那才是主要结果。
   */
  const unindexed = await dropIndexEntry(memoryDir, safe).catch(() => null)
  return { ok: true, file: safe, archivedReason: why, unindexed: !!(unindexed && unindexed.removed) }
}

/**
 * 从归档区恢复：移回根目录并去掉两行留痕。
 *
 * 根目录已有同名时**拒绝**：根目录那份是正在用的记忆，归档这份只是退役版 ——
 * 覆盖等于悄悄改掉一条活记忆。
 */
export async function restoreMemory(memoryDir, name) {
  const gate = checkName(name, 'restore')
  if (!gate.ok) return gate
  const safe = gate.safe
  const dst = join(memoryDir, safe)
  const src = join(archiveDirOf(memoryDir), safe)
  // 归档区过目录闸门：联接指向外部时，「恢复」会把外部的文件搬进记忆目录。
  const dirGate = await inspectDir(archiveDirOf(memoryDir))
  if (!dirGate.ok) {
    return {
      ok: false,
      code: dirGate.code === 'missing' ? 'not-archived' : dirGate.code,
      error: `sage-mem: not archived: ${safe}（${dirGate.error}）`,
    }
  }
  const srcGate = await inspectMemoryEntry(src, { limitBytes: null })
  if (!srcGate.ok) return { ok: false, code: 'not-archived', error: `sage-mem: not archived: ${safe}（${srcGate.error}）` }
  // 顶层已有同名（且不是链接）时拒绝：根目录那份是正在用的记忆，归档这份只是退役版。
  const dstGate = await inspectMemoryEntry(dst, { limitBytes: null })
  if (dstGate.ok) {
    return { ok: false, code: 'target-exists', error: `sage-mem: already exists, refusing to overwrite: ${safe}` }
  }
  if (dstGate.code !== 'missing') {
    return { ok: false, code: dstGate.code, error: `sage-mem: refusing to restore over ${safe}: ${dstGate.error}` }
  }
  const content = await readFile(src, 'utf8')
  await writeFileAtomic(dst, stripArchiveMeta(content))
  await unlink(src)
  /**
   * **注册回索引**：移回文件不等于这条记忆又存在了 —— 索引里没有它，
   * 面板与检索都看不见，体检会报「漏索引」（真实事故见 lib/memory/index-file.js 的头注）。
   *
   * 幂等（索引里已有指向它的一行就什么都不做）；索引缺失或写不进去**不算恢复失败** ——
   * 文件已经回到顶层了，那才是主要结果，索引只是补账。
   */
  const indexed = await ensureIndexEntry(memoryDir, safe).catch(() => null)
  return { ok: true, file: safe, indexed: !!(indexed && indexed.added) }
}
