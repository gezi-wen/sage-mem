/**
 * sage-mem 记忆层 —— **裁段归档**：把一个完整小节搬进 `archive/`，主文件原位留一行指针。
 *
 * 为什么单独一个模块：这是全仓**唯一会改写一条活记忆正文**的写入路径（压缩走
 * `write_memory`、整份归档走 `archive.js`，都不是它）。它的危险不在「算错段」——
 * 那件事由纯函数 `trim-plan.js` 负责，能对着字符串验 —— 而在**写序**：
 * 两个落点（归档件、主文件）之间没有事务，任何一步崩了都会留下「两份都有」或「两份都不对」。
 * 拆成一个模块，才能把每一步的失败单独造出来验（撞名 / 版本变了 / 写不下去），
 * 也才能让 `test/trim-archive-test.mjs` 直接对着这个文件说「不许换顺序」。
 *
 * ── 写序（**顺序即安全**，一步都不许换，见 `docs/size-governance-contract.md` §3）──────
 *   1. `readLockState`：锁表 `unknown` 一律拒 —— 「保护状态未知」不等于「没锁」。
 *   2. `isReserved` → 拒；`safeName` → 非条目名 / 带路径成分的名字拒。
 *   3. `inspectMemoryEntry(full, {limitBytes:null})` → `readSnapshot`：正文与 revision **同一次读**。
 *   4. 在这**份正文**上 `planTrim` 重算 —— 从选段到落盘中间隔着若干次 IO，用「上一次读到的
 *      正文」算出来的段，可能已经不是盘上那一份了（TOCTOU）。
 *   5. **先**排他写归档件（`writeFileExclusive`：撞名 EEXIST，不覆盖、不改名）。
 *   6. **再**用 `writeSnapshot(..., { expectedRevision })` 改主文件。
 *   7. 第 6 步失败 → 归档件**退役**成 `archive/.retired-<stamp>-<hex>.md`（移动、不删除），
 *      回执带 `stage:'after_archive'`，错误文案里点名退役后的文件。
 *
 * 为什么「先归档件、后主文件」不能反过来：反过来的话，主文件改完、归档件还没落，
 * 崩在中间就是**旧段落彻底消失**——正文被指针替换掉了，而被替换的内容没有任何副本。
 * 现在这个顺序的最坏结果是「两份都有」：内容一个字都不丢，退役一步还会让下一次重试不撞名。
 *
 * 与整文件归档（`archive.js`）的**两处刻意差异**（最容易抄错的地方）：
 *   - **不摘索引**：文件还在根目录、还在被检索，索引里那一行必须留着。摘掉等于告诉
 *     体检「这条悬空」——2026-10-11 在真实库里撞过一次的那种问题。
 *   - **不写访问台账**：裁剪不改「这条记忆最近被用到过吗」这个事实（台账的消费者是
 *     自动归档策略）；顺手写一笔会让「刚剪过的文件」在策略眼里变成刚用过的。
 *
 * 最坏情况与防线：
 *   - 「归档件写了、主文件没改成」→ 退役件留在 `archive/` 里（隐藏名，不是活记忆）。
 *   - 「归档区被换成联接」→ `inspectDir` 在写之前挡下（否则归档件会落到记忆目录之外）。
 *   - 「中途被别人改写主文件」→ `expectedRevision` 版本守卫拒绝，一个字节不写。
 *   - 「归档件撞名」→ 直接拒，绝不覆盖：那一份可能是用户上一次裁的同名段落。
 *   - 明确**不做**的：跨进程文件锁（与 `util.js` 的边界一致）、自动清理退役件
 *     （它只是改了名字，人工可捞；自动删就违背「只移不删」这条底线）。
 */

import { archiveDirOf } from './archive.js'
import { addArchiveMeta, inspectDir, inspectMemoryEntry, yamlScalar } from './scan.js'
import { moveFileExclusive, writeFileExclusive } from './util.js'
import { readLockState } from './lock.js'
import { readSnapshot, writeSnapshot } from './write-protocol.js'
import { isNonEntry, isReserved, nameKey, safeName } from './naming.js'
import { planTrim } from './trim-plan.js'
import { stampCompact, stampHuman } from '../shared/stamp.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 失败回执拼装。`stage` 说明「停在哪一步」——排错时它比 code 更有信息量。
 *
 * ⚠️ 入参是**对象**而不是三个位置参数：`code` 必须在调用点写成 `code: '…'` 字面量，
 * 因为 `test/code-registry-test.mjs` 是拿正则扫字面量来查「新码有没有登记进
 * `lib/shared/codes.js`」的。`bail('新码', …)` 这种写法会让新码从守卫眼皮底下溜过去。
 */
const bail = (spec) => ({ ok: false, code: spec.code, error: spec.error, stage: spec.stage })

/**
 * 归档件的全文：源 frontmatter 三件（`name` / `description` / `type`，有 tags 也带上）
 * + `archived_from` + `archived_slice`，再补 `archived_at` / `archived_reason`。
 *
 * 为什么用 `addArchiveMeta` 补时间与缘由而不是自己拼 YAML：那两行是**归档留痕的既有形状**
 * （`readArchivedMeta` 读它、恢复时 `stripArchiveMeta` 剥它）。自己拼一份，字段名或引号规则
 * 一漂移，归档件在面板上就会显示「时间未知 / 没写理由」。
 *
 * 值一律过 `yamlScalar`：源文件的 description 里带冒号、井号、换行的都不罕见，
 * 裸写出去会把半个值变成另一个 YAML 键（`scan.js` 头注里有完整推演）。
 *
 * `eol` 单独传：归档件是**新写的文件**，但它的正文是从 CRLF 源文件里切出来的。
 * frontmatter 用 LF 拼、正文是 CRLF，会造出一个混排文件（读得回来，但看 dif 很难受）；
 * 统一跟源文件的换行风格走，也让 `addArchiveMeta` 内部的 `eolOf` 只有一种答案。
 */
function archiveDocFor(plan, safe, at, eol = '\n') {
  const meta = plan.sourceMeta ?? {}
  const head = [
    '---',
    `name: ${yamlScalar(meta.name)}`,
    `description: ${yamlScalar(meta.description)}`,
    `type: ${yamlScalar(meta.type)}`,
  ]
  const tags = Array.isArray(meta.tags) ? meta.tags : []
  if (tags.length > 0) head.push(`tags: [${tags.map((t) => yamlScalar(t)).join(', ')}]`)
  head.push(`archived_from: ${yamlScalar(safe)}`, `archived_slice: ${yamlScalar(plan.sliceLabel)}`, '---')
  // frontmatter 与正文之间固定一个空行；正文以换行收尾（与源文件的常见形态一致）。
  const doc = `${head.join(eol)}${eol}${eol}${plan.segment}${eol}`
  return addArchiveMeta(doc, plan.reason, stampHuman(at))
}

/**
 * 把刚写好的归档件**退役**：改成 `archive/.retired-<stamp>-<hex>.md`，**移动、不删除**。
 *
 * 命名模板借自 `lib/autodream/rollback.js:258-278` 的 `park()`（`<name>.retired-<stamp>-<hex>.md`）。
 * ⚠️ 这里**不能** import rollback.js：`memory/**` 不许 import `autodream/**`
 * （`test/structure-test.mjs:64-93` 会红）。所以模板只留这一行，出处写在这里。
 *
 * 为什么要退役而不是留在原名上：原名是「裁到这一段的归档件」，留在那儿会让**下一次**裁
 * 同一段撞名（`exists`），而这一次主文件其实没改成 —— 相当于把一次失败变成永久的占位。
 * 退役之后名字唯一，内容一个字节没丢，人工随时能从 `archive/.retired-*` 里捞回来。
 *
 * @returns {Promise<string|null>} 退役后的文件名；移不动（被占用 / 名字都被占了）返回 null
 */
async function retireArchiveFile(archiveDir, archivedFile, at) {
  const stamp = stampCompact(at)
  const retiredNameOf = () => `.retired-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 6)}.md`
  const from = join(archiveDir, archivedFile)
  for (let i = 0; i < 3; i += 1) {
    const candidate = retiredNameOf()
    try {
      // 排他移动：撞名 EEXIST → 换下一个名字。绝不 rename 覆盖（`rename` 会静默盖掉别人的文件）。
      await moveFileExclusive(from, join(archiveDir, candidate))
      return candidate
    } catch (err) {
      if (err?.code === 'EEXIST') continue
      return null
    }
  }
  return null
}

/**
 * 裁段归档：把 `selector` 选中的那一段搬进 `archive/`，主文件原位留一行指针。
 *
 * @param {object} p
 * @param {string} p.memoryDir — 记忆根目录（调用方给，不许拿模块常量）
 * @param {string} p.name — 记忆文件名（必须是根目录里的一条条目）
 * @param {{heading?:string}|{startLine?:number,endLine?:number}} p.selector — 二选一
 * @param {string} p.reason — 裁剪缘由（必填，≥4 字）
 * @param {number} [p.at] — 毫秒时间戳（归档名日期 / 留痕时间；不传用 `Date.now()`）
 * @param {object} [p.ctx] — 插件上下文（只用于写协议里的告警日志）
 * @returns {Promise<
 *   {ok:true, archivedFile:string, archivedPath:string, beforeBytes:number, afterBytes:number,
 *    segmentBytes:number, pointer:string, title:string, range:{start:number,end:number}} |
 *   {ok:false, code:string, error:string, stage:string}>}
 */
export async function trimArchive(p = {}) {
  const memoryDir = typeof p?.memoryDir === 'string' ? p.memoryDir : ''
  const rawName = String(p?.name ?? '')
  const at = Number.isFinite(p?.at) ? p.at : Date.now()
  if (memoryDir === '') {
    return bail({ code: 'invalid', error: 'trimArchive 需要 memoryDir（显式传入；拿模块级常量会写到真实记忆目录）', stage: 'params' })
  }

  // ── 1. 锁表：未知 = 拒绝 ──────────────────────────────────────────────────
  const lock = await readLockState(memoryDir)
  if (lock.status === 'unknown') {
    return bail({
      code: 'lock_unknown',
      error: `sage-mem: 锁表不可读（${lock.reason}），无法确认这条记忆是否受保护，拒绝裁剪：${nameKey(rawName)}`,
      stage: 'lock',
    })
  }
  // 锁定 = 「这条别动」。裁剪改的是正文，比整份归档更该尊重这把锁。
  if (lock.locked.has(nameKey(rawName))) {
    return bail({ code: 'locked', error: `sage-mem: ${nameKey(rawName)} 已锁定（受保护），拒绝裁剪 —— 要裁先在界面里解锁`, stage: 'lock' })
  }

  // ── 2. 名字：保留名 / 非条目名 / 带路径成分 ────────────────────────────────
  if (isReserved(rawName)) {
    return bail({ code: 'reserved', error: `sage-mem: 保留名不参与体积治理，拒绝裁剪：${nameKey(rawName)}`, stage: 'name' })
  }
  const safe = safeName(rawName)
  if (!safe) {
    // 契约点名的两个码分开报：`non_entry` = 索引 / 流水（不参与治理），
    // `invalid_name` = 名字本身不合法（带路径 / 不是 .md）——后者是「你写错名字了」。
    if (isNonEntry(rawName)) {
      return bail({ code: 'non_entry', error: `sage-mem: 索引 / 流水不是一条记忆，不参与体积治理：${nameKey(rawName)}`, stage: 'name' })
    }
    return bail({ code: 'invalid_name', error: `sage-mem: 文件名不合法（单段 .md、无路径分隔符、无冒号）：${String(rawName)}`, stage: 'name' })
  }

  // ── 3. 读：形状闸门 + 正文与 revision 同一次读取 ────────────────────────────
  const full = join(memoryDir, safe)
  const gate = await inspectMemoryEntry(full, { limitBytes: null })
  if (!gate.ok) {
    // 体积不在这里判（`limitBytes:null`）：超线正是要裁它的原因。
    const code = gate.code === 'missing' ? 'not_found' : gate.code
    return bail({ code, error: `sage-mem: 读不到 ${safe}：${gate.error}`, stage: 'read' })
  }
  let snap
  try {
    snap = await readSnapshot(full, gate, safe)
  } catch (err) {
    const code = err?.code === 'ENOENT' ? 'not_found' : err?.code === 'changed' ? 'changed' : 'io_error'
    return bail({ code, error: `sage-mem: 读 ${safe} 失败（${err?.code ?? err}）：${err?.message ?? err}`, stage: 'read' })
  }

  // ── 4. 在**这份正文**上重算（防 TOCTOU）──────────────────────────────────
  const plan = planTrim({ content: snap.content, name: safe, selector: p?.selector, reason: p?.reason, at })
  if (!plan.ok) return bail({ code: plan.code, error: plan.error, stage: 'plan' })

  // ── 5. 先落归档件：排他、撞名即拒 ─────────────────────────────────────────
  const archiveDir = archiveDirOf(memoryDir)
  const dirGate = await inspectDir(archiveDir)
  if (!dirGate.ok && dirGate.code !== 'missing') {
    // 归档区还不存在是正常状态（下面 mkdir 建）；是联接 / 不是目录就绝不能往里写。
    return bail({ code: dirGate.code, error: `sage-mem: 归档区不可用：${dirGate.error}`, stage: 'archive' })
  }
  const archivedFile = plan.archiveName
  // 归档件的换行风格跟源文件走（`scan.js` 的 `eolOf` 同一套判据）：新文件里混排最难读。
  const eol = snap.content.includes('\r\n') ? '\r\n' : '\n'
  try {
    await mkdir(archiveDir, { recursive: true })
    await writeFileExclusive(join(archiveDir, archivedFile), archiveDocFor(plan, safe, at, eol))
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return bail({
        code: 'exists',
        error: `sage-mem: archive/${archivedFile} 已经存在 —— 不覆盖、也不改名（那一份可能是你上次裁的同名段落），请换一个标题或用 startLine/endLine 另选一段`,
        stage: 'archive',
      })
    }
    return bail({ code: 'io_error', error: `sage-mem: 写归档件 archive/${archivedFile} 失败（${err?.code ?? err}）：${err?.message ?? err}`, stage: 'archive' })
  }

  // ── 6. 再改主文件：revision 守卫，版本变了就一个字节都不写 ──────────────────
  const written = await writeSnapshot(full, plan.remaining, gate, { expectedRevision: snap.revision }, { ctx: p?.ctx, name: safe, kind: 'trim' })
  if (!written.ok) {
    /**
     * ── 7. 失败收尾：归档件退役（不删）────────────────────────────────────
     * `stale_revision` 原样透出（它是写协议定义的码，别在这里改名 —— 改名等于让上层
     * 分不清「别人改过」和「写坏了」，那两条的重试动作完全不同）。
     */
    const retired = await retireArchiveFile(archiveDir, archivedFile, at)
    const where = retired
      ? `归档件已退役为 archive/${retired}`
      : `归档件仍在 archive/${archivedFile}（退役没成功，文件名被占用）`
    return bail({
      code: written.code,
      error: `sage-mem: 裁段没改成主文件（${written.code}：${written.error}）—— ${where}，内容一个字节都没丢；主文件保持原样，请刷新后重试`,
      stage: 'after_archive',
    })
  }

  return {
    ok: true,
    archivedFile,
    // 相对路径是给回执用的便捷字段（工具面的文案要写「归档到 archive/…」）；
    // `archivedFile` 本身保持**裸文件名**，与 `planTrim` 的 `archiveName`、`archive.js` 的 `file` 同一种形状。
    archivedPath: `archive/${archivedFile}`,
    beforeBytes: Buffer.byteLength(snap.content, 'utf8'),
    afterBytes: Buffer.byteLength(plan.remaining, 'utf8'),
    segmentBytes: Buffer.byteLength(plan.segment, 'utf8'),
    pointer: plan.pointer,
    title: plan.title,
    range: plan.range,
  }
}
