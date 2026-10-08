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

import { ARCHIVE_DIR_NAME, addArchiveMeta, localStamp, stripArchiveMeta } from './scan.js'
import { isReserved, nameKey, safeName } from './naming.js'
import { writeFileAtomic } from './util.js'
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
  const src = join(memoryDir, safe)
  const dst = join(archiveDirOf(memoryDir), safe)
  const info = await stat(src).catch(() => null)
  // 根目录里没有 → 文件名写错，或者它已经是归档态（归档区那份不该再归档一次）。
  if (!info?.isFile()) return { ok: false, code: 'not-found', error: `sage-mem: file not found: ${safe}` }
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
  return { ok: true, file: safe, archivedReason: why }
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
  const info = await stat(src).catch(() => null)
  if (!info?.isFile()) return { ok: false, code: 'not-archived', error: `sage-mem: not archived: ${safe}` }
  if (await stat(dst).catch(() => null)) {
    return { ok: false, code: 'target-exists', error: `sage-mem: already exists, refusing to overwrite: ${safe}` }
  }
  const content = await readFile(src, 'utf8')
  await writeFileAtomic(dst, stripArchiveMeta(content))
  await unlink(src)
  return { ok: true, file: safe }
}
