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

import { ARCHIVE_DIR_NAME, addArchiveMeta, inspectDir, inspectMemoryEntry, localStamp, readArchivedMeta, stripArchiveMeta } from './scan.js'
import { isReserved, nameKey, safeName } from './naming.js'
import { retireTaken, returnSource, takeOverSource, writeFileAtomic, writeFileExclusive } from './util.js'
import { isLocked } from './lock.js'
import { ensureIndexEntry, dropIndexEntry } from './index-file.js'
import { link, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

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
  /**
   * 读**字节**而不是先转字符串：后面复核「移走的是不是我读的那一份」要逐字节比，
   * 转成字符串再比会在非法 UTF-8 / 不同换行归一上失真。
   */
  const sourceBytes = await readFile(src)
  const content = sourceBytes.toString('utf8')
  // 空理由给默认值：手动 remote 允许省略（工具那侧自己会先挡掉空理由，那是它自己的语义）。
  const why = String(reason ?? '').trim() || '手动归档'
  const stamped = addArchiveMeta(content, why, at)
  await mkdir(archiveDirOf(memoryDir), { recursive: true })
  /**
   * 先落归档副本、再删原件：中途崩了最坏是两份都在（人工可收拾），不会一份都没有。
   *
   * **排他落位**（复审 R06）：上面那句 `stat(dst)` 与这次写入之间是两条独立系统调用，
   * 别人在这中间把同名归档建出来时，`writeFileAtomic` 的 rename 会直接把它盖掉。
   * `writeFileExclusive` 把「目标不存在」变成写入本身的原子前提。
   */
  try {
    await writeFileExclusive(dst, stamped)
  } catch (err) {
    if (err?.code === 'EEXIST') return { ok: false, code: 'exists', error: `sage-mem: already archived: ${safe}` }
    throw err
  }
  /**
   * ⚠️ 收走原件这一步交给 **`takeOverSource`**（`rename` 到私有名 → 逐字节复核 → 还回 /
   * 退役），不是 `unlink`（复审 R06 场景①；2026-10-31 外部审查 Q06 起归档与恢复共用
   * 同一份事务移动原语，见 `memory/util.js`）。
   *
   * 从上面那次 `inspectMemoryEntry(src)` 到现在，中间隔着读文件 + 写归档副本两次 IO；
   * 这期间若有人（面板保存、另一个进程、模型工具）把 `a.md` 写成了新版本，
   * 直接删就会把**从未被归档过的新版本**删掉 —— 归档件里躺着的是旧内容，而函数返回成功。
   *
   * 「删除前再 stat 一次」**修不了**这个问题：文件系统没有「比较再删除」这种原子动作，
   * `unlink(路径)` 只认名字，而名字底下的 inode 在两次系统调用之间随时可能被换掉。
   * 可用的手法是**把身份和名字解耦**：`rename` 是原子的，先把源移到一个只有本函数知道的
   * 私有名上，再对**移走的那份实物**核对 —— 与 `autodream/gate.js`「抢占过期锁 + 复核 + 还回」
   * 是同一套手法。
   *
   * ⚠️ 复核判据必须是**内容**，不能是 `dev:ino + size + mtime`（复审复核实测：改用后者
   * 12 次里仍有 2 次被穿过）。原地截断改写 + 体积刚好相同 + 把 mtime 回写成原值
   * （`cp -p` / `rsync -t` 这类还原工具，或 mtime 粒度粗的文件系统）会让三元组全部命中，
   * 于是**新版本被当成旧版本收走**，顶层与归档件里都不再有它。`ino` 在拿不到 inode 的卷上
   * 还会退化成 `null === null` 恒真，把判据进一步削弱成「体积 + 时间」。
   * 内容比对是精确判据，而且成本可忽略（归档本来就要把这份内容读进内存）。
   *   · 与读到的字节完全相同 → 就是当初那一份，归档完成，退役私有名；
   *   · 不同（或读不回来）→ 是别人的新版本，原语用 `link()` 还回原名，放弃本次归档。
   *
   * 崩在中途的代价说清楚：私有名文件会留在记忆目录里（不是 `.md`，扫描与注入都不认它），
   * 而归档副本已经写好 —— 不会出现「一份都没有」；体检会把 `.archiving-` 残留报出来。
   */
  const takenRes = await takeOverSource(src, sourceBytes, 'archiving')
  if (!takenRes.ok) {
    /**
     * ⚠️ `rename` 失败**不等于**「源不见了」（复审复核实测，真机 Windows）：
     * 另一进程只读占用（编辑器 / 杀软 / 同步工具）时 `rename` 报 **EBUSY** 而不是 ENOENT，
     * 而文件明明还在、内容也读得出来。原先一律报 `not-found`，工具层再翻成
     * 「错误：没有这个文件」—— 诊断是错的，人会去别处找。按真实错误码分流。
     */
    await rm(dst, { force: true }).catch(() => {})
    if (takenRes.code === 'not-found') {
      return { ok: false, code: 'not-found', error: `sage-mem: file not found: ${safe}（归档途中源文件消失了）` }
    }
    if (takenRes.code === 'move-failed') {
      const moveErr = takenRes.cause
      return {
        ok: false,
        code: 'move-failed',
        error: `sage-mem: 归档 ${safe} 时移不动它（${moveErr?.code ?? moveErr}：${moveErr?.message ?? moveErr}）。文件仍在原处、一个字节没动，本次归档未完成 —— 可稍后重试（若是被其它程序占用，关掉它再来）。`,
      }
    }
    if (takenRes.keptAt) {
      /**
       * ⚠️ 归还失败时**绝不能删 `taken`**：它是这份新版本**唯一**的落身处
       * （原名此刻已被别人占着，link 才报的 EEXIST）。删掉它就是真的丢数据。
       * 原语把它原样留下，这里把路径如实写进错误里让人去捞 —— 名字带 `.archiving-`
       * 后缀，不是 `.md`，扫描 / 注入 / 星图都不会把它当成一条记忆，体检会报出来。
       */
      return {
        ok: false,
        code: 'changed',
        error: `sage-mem: ${safe} 在归档过程中被改写，已放弃本次归档；归还时原名已被占用，**内容仍保留在 ${basename(takenRes.keptAt)}**，请手工改回 ${safe}`,
      }
    }
    return {
      ok: false,
      code: 'changed',
      error: `sage-mem: ${safe} 在归档过程中被改写，已放弃本次归档（新版本保留在原处，请重试）`,
    }
  }
  await retireTaken(takenRes.taken)
  /**
   * **从索引里摘掉**（与恢复时补索引对称）：索引是「活动记忆的清单」，
   * 记忆归档了就该从清单里退出 —— 不摘的话审计会报「索引悬空」。
   * 2026-10-11 在真实库里撞到过：归档两条，体检立刻从 0 问题变 2 问题。
   * 摘失败**不算归档失败**：文件已经移走了，那才是主要结果。
   *
   * 但**失败要说出去**（复审 R11 的配套）：读不动索引时旧写法会把「读失败」折成空串、
   * 顺手把用户的索引整体重写；现在改成不写，同时把理由带在返回值里。
   * **抛异常那条路也要接住**（复审复核点出）：`dropIndexEntry` 写索引时抛出的
   * EIO / 占用 / 权限原先会被 `.catch(() => null)` 吞成 null，于是「索引里那行还在、
   * 却报成功」无人知晓。读失败与写失败在这里对称上报。
   */
  let unindexedRemoved = false
  let indexError = ''
  try {
    const unindexed = await dropIndexEntry(memoryDir, safe)
    unindexedRemoved = !!(unindexed && unindexed.removed)
    if (unindexed && unindexed.ok === false) indexError = unindexed.error ?? '索引没摘掉'
  } catch (err) {
    indexError = `摘索引失败（${err?.code ?? err}）：${err?.message ?? err}`
  }
  return {
    ok: true,
    file: safe,
    archivedReason: why,
    // `unindexed` 的原语义不变：**确实摘掉了一行**（不是「索引没出错」）。
    unindexed: unindexedRemoved,
    ...(indexError ? { indexError } : {}),
  }
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
  const sourceBytes = await readFile(src)
  const content = sourceBytes.toString('utf8')
  /**
   * **事务接管源 + 目标排他落位**（2026-10-31 外部审查 Q06）。
   *
   * 旧写法是「先把 A 排他落位到顶层，再 `unlink(归档源)`」：落位确实保护了目标
   * （复审 R06 场景②），但最后那步按名删除**没有绑定读取时的源版本** —— 落位与 unlink
   * 之间另一路把归档源改写成 B，`unlink(名字)` 删的就是 B，新版本从两个位置一起消失，
   * 而函数报 `ok:true`。
   *
   * 现在顺序反过来，用与归档同一份原语（`memory/util.js` 的 `takeOverSource`）：
   *   ① 先把源原子 `rename` 成私有名，并逐字节核对它仍是当初读到的那一份；
   *   ② 内容对不上 → 原语把 B 还回原名，本次放弃（一个字节都不丢）；
   *   ③ 排他落位目标（`writeFileExclusive`：目标冒出来就 EEXIST，绝不覆盖）；
   *   ④ 落位失败 → 把接管的那份**原样还回**归档区；还不动时留在私有名上并点名；
   *   ⑤ 落位成功后才退役**私有副本** —— 不碰「当前叫 archive/a.md 的那个文件」，
   *      所以落位之后被写进来的 B 会老老实实留在归档区。
   *
   * 崩在中途的代价：`.restoring-` 私有副本会留在归档区（不是 `.md`，扫描 / 注入都不认），
   * 体检会把它报出来 —— 至少有一份可定位、可恢复的原文。
   */
  const takenRes = await takeOverSource(src, sourceBytes, 'restoring')
  if (!takenRes.ok) {
    if (takenRes.code === 'not-found') {
      return { ok: false, code: 'not-archived', error: `sage-mem: not archived: ${safe}（恢复途中源文件消失了）` }
    }
    if (takenRes.code === 'move-failed') {
      const moveErr = takenRes.cause
      return {
        ok: false,
        code: 'move-failed',
        error: `sage-mem: 恢复 ${safe} 时移不动它（${moveErr?.code ?? moveErr}：${moveErr?.message ?? moveErr}）。文件仍在 archive/ 里、一个字节没动 —— 可稍后重试（若是被其它程序占用，关掉它再来）。`,
      }
    }
    if (takenRes.keptAt) {
      // 核对时发现是别人的新版本，而原名已被再次占住 —— 新版本留在私有名上，点名给人捞。
      return {
        ok: false,
        code: 'changed',
        error: `sage-mem: ${safe} 在恢复过程中被改写，已放弃本次恢复；归还时原名已被占用，**内容（新版本）仍保留在 archive/${basename(takenRes.keptAt)}**，请手工改回 ${safe} 再试。`,
      }
    }
    return {
      ok: false,
      code: 'changed',
      error: `sage-mem: ${safe} 在恢复过程中被改写，已放弃本次恢复（新版本保留在归档区原处，请重试）`,
    }
  }
  /**
   * **排他落位**（复审 R06 场景②）：上面那句 `dstGate` 检查通过 ≠ 目标此刻仍不存在 ——
   * 检查与写入之间，用户完全可能在顶层新建一条同名记忆（实测用 IPC 固定交错即可复现）。
   * 旧写法 `writeFileAtomic` 的 rename 会**直接盖掉**它，而函数报成功、归档源也删了，
   * 于是「新写的那版」在两个位置都不存在。`writeFileExclusive` 把「目标必须不存在」
   * 变成写入本身的原子前提：目标冒出来就 EEXIST，一个字节都不动。
   */
  try {
    await writeFileExclusive(dst, stripArchiveMeta(content))
  } catch (err) {
    // 落位没成：接管的归档件必须先还回去 —— 它此刻是这个名字下唯一的一份内容。
    const back = await returnSource(takenRes.taken, src)
    if (!back.ok) {
      return {
        ok: false,
        code: 'restore-failed',
        error: `sage-mem: 恢复 ${safe} 落位失败（${err?.code ?? err}），且归还归档区原名时被占用 —— **内容仍保留在 archive/${basename(back.keptAt)}**，请手工改回 ${safe} 再试。`,
      }
    }
    if (err?.code === 'EEXIST') {
      return { ok: false, code: 'target-exists', error: `sage-mem: already exists, refusing to overwrite: ${safe}` }
    }
    throw err
  }
  await retireTaken(takenRes.taken)
  /**
   * **注册回索引**：移回文件不等于这条记忆又存在了 —— 索引里没有它，
   * 面板与检索都看不见，体检会报「漏索引」（真实事故见 lib/memory/index-file.js 的头注）。
   *
   * 幂等（索引里已有指向它的一行就什么都不做）；索引缺失或写不进去**不算恢复失败** ——
   * 文件已经回到顶层了，那才是主要结果，索引只是补账。
   *
   * 索引**读不动**时（复审 R11）旧写法会当成「索引是空的」然后整体重写 —— 用户手写的
   * 标题、段落、其它条目一起没了。现在这种情况一个字都不写，只把理由带回去；
   * 写索引时抛出的异常同样接住（与归档那侧对称）。
   */
  let indexedAdded = false
  let indexError = ''
  try {
    const indexed = await ensureIndexEntry(memoryDir, safe)
    indexedAdded = !!(indexed && indexed.added)
    if (indexed && indexed.ok === false) indexError = indexed.error ?? '索引没补上'
  } catch (err) {
    indexError = `补索引失败（${err?.code ?? err}）：${err?.message ?? err}`
  }
  return {
    ok: true,
    file: safe,
    // `indexed` 的原语义不变：**确实补上了一行**。
    indexed: indexedAdded,
    ...(indexError ? { indexError } : {}),
  }
}

/**
 * 从归档区**彻底删除**一条记忆（不可恢复）。
 *
 * 为什么不复用 `deleteFile`：归档的承诺是「只移不删」，活记忆的 `deleteFile` 承诺的
 * 是「删掉活的这份」。两者混在一个名字下，用户就永远分不清自己按的是哪一个；
 * 而这个操作**没有回收站**。
 *
 * 三道判据，缺一不可：
 *   1. **归档区的目录闸门**：它若被换成指向外部的联接，删掉的是别人的文件；
 *   2. **条目闸门**：链接 / 硬链接指向的可能是记忆目录之外的内容，删它等于替别人删文件；
 *   3. **代次（`archivedAt`）**：名字不是身份。用户从列表看到确认框、到请求到达之间，
 *      这条完全可能被恢复回顶层、又被另一版同名记忆归档进来 —— 按名删掉的就不再是他
 *      确认过的那一份。所以调用方必须交回它当时看见的 `archived_at`，对不上就拒绝。
 *      老数据没有留痕时两边都是空串，仍然一致（那是「同一份、只是没有时间戳」）。
 *
 * ⚠️ 删除本身用 **`rename` 到私有名 + `rm` 私有名**：`inspect` 与 `unlink` 之间隔着
 * 读文件，直接 `unlink(full)` 认的是**名字**而不是我们核对过的那份实物。`rename` 是原子的，
 * 之后删的一定是刚移走的那一个 inode。删失败时把名字 `link()` 还回去 —— 绝不让它
 * 以 `.deleting-` 的私有名留在盘上（扫描不认那个名字，等于文件凭空消失）。
 *
 * @param {string} memoryDir — 记忆根目录（调用方给，不许拿模块常量）
 * @param {string} name — 归档区里的文件名
 * @param {string} expectedArchivedAt — 调用方看见的 `archived_at`（没有留痕时传空串）
 * @returns {Promise<{ok:true,file:string}|{ok:false,code:string,error:string}>}
 */
export async function deleteArchivedMemory(memoryDir, name, expectedArchivedAt = '') {
  const gate = checkName(name, 'delete')
  if (!gate.ok) return gate
  const safe = gate.safe
  const dirGate = await inspectDir(archiveDirOf(memoryDir))
  if (!dirGate.ok) {
    return {
      ok: false,
      code: dirGate.code === 'missing' ? 'not-archived' : dirGate.code,
      error: `sage-mem: not archived: ${safe}（${dirGate.error}）`,
    }
  }
  const full = join(archiveDirOf(memoryDir), safe)
  const srcGate = await inspectMemoryEntry(full, { limitBytes: null })
  if (!srcGate.ok) {
    return {
      ok: false,
      code: srcGate.code === 'missing' ? 'not-archived' : srcGate.code,
      error: `sage-mem: not archived: ${safe}（${srcGate.error}）`,
    }
  }
  // 读全文只为取留痕：代次判据必须来自**盘上的那份**，不能信调用方一路传下来的展示值。
  const onDisk = readArchivedMeta(await readFile(full, 'utf8'))
  const expected = String(expectedArchivedAt ?? '')
  if (expected !== onDisk.archivedAt) {
    return {
      ok: false,
      code: 'changed',
      error:
        `sage-mem: ${safe} 在确认之后被换成了另一版（界面上是「${expected || '时间未知'}」，` +
        `盘上是「${onDisk.archivedAt || '时间未知'}」），本次一个字节都没删 —— 请刷新列表再看一眼。`,
    }
  }
  const taken = join(archiveDirOf(memoryDir), `.${safe}.deleting-${randomUUID().replace(/-/g, '')}`)
  const moveErr = await rename(full, taken).then(
    () => null,
    (err) => err,
  )
  if (moveErr) {
    if (moveErr?.code === 'ENOENT') {
      return { ok: false, code: 'not-archived', error: `sage-mem: not archived: ${safe}（删除途中它从归档区消失了）` }
    }
    return {
      ok: false,
      code: 'move-failed',
      error: `sage-mem: 删除 ${safe} 时移不动它（${moveErr?.code ?? moveErr}：${moveErr?.message ?? moveErr}）。文件仍在 archive/ 里、一个字节没动 —— 可稍后重试（若是被其它程序占用，关掉它再来）。`,
    }
  }
  const delErr = await rm(taken, { force: true }).then(
    () => null,
    (err) => err,
  )
  if (delErr) {
    const restored = await link(taken, full).then(
      () => true,
      () => false,
    )
    if (!restored) {
      return {
        ok: false,
        code: 'delete-failed',
        error:
          `sage-mem: 删除 ${safe} 失败（${delErr?.code ?? delErr}），且归还原名时被占用 —— ` +
          `**内容仍保留在 archive/${basename(taken)}**，请手工改回 ${safe} 再试。`,
      }
    }
    await rm(taken, { force: true }).catch(() => {})
    return {
      ok: false,
      code: 'delete-failed',
      error: `sage-mem: 删除 ${safe} 失败（${delErr?.code ?? delErr}：${delErr?.message ?? delErr}），文件已还回 archive/${safe}，没有丢。`,
    }
  }
  return { ok: true, file: safe }
}
