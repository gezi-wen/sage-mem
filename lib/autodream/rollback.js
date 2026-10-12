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
import { nameKey } from '../memory/naming.js'
import { stripArchiveMeta } from '../memory/scan.js'
import { writeFileAtomic } from '../memory/util.js'
import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

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

    /**
     * ①-a 校验回滚点内容。
     *
     * 顺序在保护快照**之前**：判据不成立时连快照都不该建 —— 拒绝要干净，不留任何副作用。
     * 校验失败一律拒绝整趟，不做「只恢复没坏的那几个」的部分回滚：部分回滚会把记忆目录
     * 变成「半新半旧」的第三种状态，比不回滚更难收拾，而记忆目录没有版本控制兜底。
     */
    const verdict = await this.verifySnapshot(snapDir, { legacy: dirname(snapDir) === this.legacySnapshotRoot })
    if (!verdict.ok) {
      this.log('warn', `回滚中止：${verdict.reason}`)
      this.phase = ''
      return {
        ok: false,
        error:
          `${verdict.reason}。这份回滚点已不能代表「当时那一版」，拿它覆盖记忆目录风险太大，` +
          '这次回滚已中止，记忆目录一个字没动。请换一份回滚点。',
      }
    }
    if (verdict.schema === 'unhashed') this.log('warn', `回滚：${verdict.reason}`)

    // ① 保护快照
    this.phase = '回滚前保护快照'
    // 带随机后缀：秒级时间戳会撞（同一秒内连点两次回滚是真实用法），
    // 而撞车的后果是**覆盖掉上一次的保护快照**——那等于把「回滚也能退」这条承诺吃掉。
    const protectionId = `pre-rollback-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 4)}`
    /**
     * ⚠️ 把选中的回滚源列进**轮转豁免名单**（2026-10-12 复审 R03）。
     *
     * 保护快照走的是 `snapshot()`，而它末尾会轮转旧快照。被选中的源若正好是最旧的
     * 那份保护快照，就会在**恢复开始之前**被这趟回滚自己删掉：之后枚举源得到空集合，
     * 回滚以 `ok:true / restored:0` 收场 —— 报成功、什么都没恢复，而人以为退回去了。
     * 「正在被使用的回滚点」不该参与淘汰。豁免只对当前快照根里的那份有意义（旧版根不轮转）。
     */
    const sourceDirName = basename(snapDir)
    const protect = dirname(snapDir) === this.snapshotRoot ? [sourceDirName] : []
    const protection = await this.snapshot(protectionId, 'pre-rollback', { protect })

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
    /**
     * ②-a 开工前**再确认一次源还在**。
     *
     * 上面那句 `protect` 是根治，这里再加一道兜底：从校验（`verifySnapshot`）到现在，
     * 中间夹着一次完整的保护快照（建目录、逐文件复制、轮转删除），期间外部完全可能
     * 把快照根清掉或轮转掉。源的消失意味着「恢复」退化成「把顶层文件按『快照里没有』
     * 处理」—— 那是**比不回滚更糟**的结局。宁可中止，一个字不写。
     */
    if (!(await stat(snapDir).catch(() => null))?.isDirectory()) {
      this.log('warn', `回滚中止：回滚点 ${snapshotId} 在恢复动作开始前消失了`)
      this.phase = ''
      return {
        ok: false,
        error: `回滚点 ${snapshotId} 在恢复动作开始前消失了（可能被轮转或人工清理）。这次回滚已中止，记忆目录一个字没动。`,
      }
    }
    const snapNames = await snapshotEntries(snapDir)
    /**
     * 名录为空而清单说有文件 → 源被掏空了（轮转删目录内容、杀软隔离、外部清理）。
     * 照旧往下走的话，整目录回滚会把顶层**每一条记忆**都判成「快照里没有」→ 全部移进
     * `archive/`，然后报 `ok:true / restored:0`。这是必须挡死的方向。
     */
    const expectedSnapFiles = Array.isArray(manifest?.files) ? manifest.files.length : 0
    if (!snapNames.length && expectedSnapFiles > 0) {
      this.log('warn', `回滚中止：回滚点 ${snapshotId} 的清单记着 ${expectedSnapFiles} 个文件，但目录里一个都没有`)
      this.phase = ''
      return {
        ok: false,
        error: `回滚点 ${snapshotId} 的内容不见了（清单记着 ${expectedSnapFiles} 个文件，目录里一个都没有）。为免把现有记忆全部误判成「多余的」而移进 archive/，这次回滚已中止，记忆目录一个字没动。`,
      }
    }
    /**
     * **写回一份快照内容**。
     *
     * ⚠️ 用 `writeFileAtomic`（写临时文件 + rename 替换**目录项**），**不用 `copyFile`**
     * （2026-10-12 复审 R02）。`copyFile` 是打开目标、往它**已有的 inode** 里灌内容，
     * 于是：
     *   - 目标有硬链接（`cp -al` / `rsync --link-dest` 做的快照备份）→ 记忆目录**之外**那份
     *     备份被一起改掉，实测复现；
     *   - 目标是符号链接 / 目录联接 → 内容穿过链接，写到目录外的真实文件上，实测复现。
     * rename 之后硬链接关系自然解除（备份保持原样），符号链接被**替换成本身**而不是穿透。
     * 这正是「把记忆目录恢复成快照那一版」该有的语义：动的是这个名字，不是它指向的那个 inode。
     */
    const writeBack = async (name, snapName) => {
      const target = join(this.memoryDir, name)
      /**
       * 记下目标原来的权限位，写完再贴回去。
       *
       * 为什么（复审复核点出的 R02 副作用）：`writeFileAtomic` 是「新建临时文件 + rename」，
       * 新文件的 mode 走 umask；而 `copyFile`（旧实现）会沿用源文件的 mode。于是一个被用户
       * 设成 0600 的记忆文件，回滚一趟就变成 0644 —— 隐私被悄悄放宽。
       * 用 `lstat`：目标是符号链接时不该跟随（`stat` 会拿到链接指向的外部文件权限）。
       * 只有**普通文件**才贴回原权限；链接 / 新建文件用默认值。Windows 上 chmod 是 no-op。
       */
      const before = await lstat(target).catch(() => null)
      const keepMode = before && before.isFile() && typeof before.mode === 'number' ? before.mode : null
      await writeFileAtomic(target, await readFile(join(snapDir, snapName)))
      if (keepMode !== null) await chmod(target, keepMode).catch(() => {})
    }
    /**
     * 快照名录按**归一化名字**索引（`nameKey`：小写归一）。
     *
     * Windows / macOS 的文件名大小写不敏感，`a.md` 与 `A.md` 是同一个文件。旧写法用
     * `new Set(snapNames)` 做大小写敏感的 `has()`：**快照之后只改了大小写的文件**，在整目录
     * 回滚里会被判成「快照里没有」→ 先被写回、紧接着被 park 进 `archive/` → 活动记忆静默
     * 消失，而回滚报 `ok:true`（实测复现过）。判据必须与文件系统同宽。
     */
    const snapByKey = new Map(snapNames.map((n) => [nameKey(n), n]))
    /** 名字在当前文件系统上算不算「快照里已有」；返回快照里那一份的**真实文件名**。 */
    const snapNameOf = (name) => snapByKey.get(nameKey(name)) ?? null

    const restored = []
    const parked = []
    const skipped = []
    /** 说明（不是「跳过」也不是「移走」）：结果达到了，只是过程和常规路径不同，要写进报告。 */
    const notes = []
    const archiveDir = join(this.memoryDir, 'archive')
    await mkdir(archiveDir, { recursive: true })

    /**
     * **排他移动**：先 `link` 到目标（目标已存在 → `EEXIST`，绝不覆盖），成功后再删源。
     *
     * 为什么不能 `stat → rename`（复审复核实测构造出了覆盖）：`rename` 在目标已存在时
     * **静默覆盖**，而 `stat` 与 `rename` 之间正是别人（面板 / 模型工具的 `archiveMemory`，
     * 它们不取 autodream 这把锁）可能刚把同名归档写进去的窗口 —— 与 R06② 同一类：
     * 第二次系统调用没有存在性前提。而本函数的注释一直承诺「绝不覆盖」，代码却做不到。
     *
     * 平台不支持硬链接 / 跨卷时退回 `rename`（与 `memory/util.js` 那边的降级口径一致），
     * 那是已知降级；NTFS / APFS / ext4 上走的是排他路径。
     */
    const moveExclusive = async (from, to) => {
      try {
        await link(from, to)
      } catch (err) {
        if (err?.code === 'EEXIST') throw err
        await rename(from, to)
        return
      }
      await rm(from, { force: true })
    }

    /**
     * 移进 archive/（不删）。同名时**换一个退役名**落进去，绝不覆盖，也绝不放弃。
     *
     * 旧写法撞名就 `skipped` 走人，代价是：同一趟 `create → archive → create` 的文件，
     * 归档区已经被本趟占着，回滚要让它从顶层退场时撞名 → 直接放弃 → 那条运行前根本
     * 不存在的记忆继续活在顶层。目标状态是「顶层没有它」，撞名只是「原件名被占了」
     * ——换个名字照样达到目标，且仍然一个文件都没删。
     *
     * 现在连「撞名判定」都不需要了：直接按「原名 → 退役名 → 再一个退役名」依次**排他落位**，
     * `EEXIST` 就换下一个。判定与动作合成一步，窗口自然消失。
     */
    const park = async (name, why) => {
      const from = join(this.memoryDir, name)
      const retiredName = () => `${name.replace(/\.md$/i, '')}.retired-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 6)}.md`
      for (const candidate of [name, retiredName(), retiredName()]) {
        try {
          await moveExclusive(from, join(archiveDir, candidate))
        } catch (err) {
          if (err?.code === 'EEXIST') continue
          skipped.push(`${name}（本想${why}，archive/ 里写不进去：${err?.message ?? err}）`)
          return false
        }
        parked.push(
          candidate === name
            ? `${name}（${why}）`
            : `${name} → ${candidate}（${why}；archive/ 已有同名，改用退役名，未删除）`,
        )
        return true
      }
      skipped.push(`${name}（本想${why}，archive/ 里原名与两个退役名都被占了）`)
      return false
    }

    if (scope === 'all') {
      for (const name of snapNames) {
        try {
          await writeBack(name, name)
          restored.push(name)
        } catch (err) {
          skipped.push(`${name}（写回失败：${err?.message ?? err}）`)
        }
      }
      // 快照之后新建的文件：整目录回滚要让它退场，但不能删——移进 archive/。
      // `current` 只在这条分支用得上，扫一遍目录就够了（文件级回滚按 ledger 逐个 stat）。
      const current = (await readdir(this.memoryDir, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
        .map((e) => e.name)
      for (const name of current) {
        if (!snapNameOf(name)) await park(name, '快照里没有，整目录回滚需退场')
      }
    } else {
      /**
       * 文件级回滚**按文件聚合**，不按 `changes` 的条目顺序逐条执行。
       *
       * 同一趟里模型完全可能先 `write_memory` 新建、再 `archive_memory` 归档同一个文件。
       * 逐条执行时 create 那条把它 park 进 `archive/`、archive 那条又把它 `rename` 回顶层 ——
       * 回滚反而**激活**了一条运行前根本不存在的记忆，而面板照报「已回滚」。
       *
       * 判据只有一个：**这个文件在运行前快照里存在吗**。
       *   存在   → 目标是「顶层有一份运行前的版本」：内容从快照取；若已被归档，从 `archive/`
       *            洗掉留痕搬回来（走 `memory/archive.js` 的共享实现，与手动恢复同一份）
       *   不存在 → 目标是「顶层没有它」：在顶层就 park 进 `archive/`；已经在 `archive/` 里
       *            就留在那儿 —— 「不删」不等于「重新激活」
       *
       * 两本账（模型的 `changes` + 确定性策略的 `archive.archived`）在这里**合流成一个文件清单**：
       * 策略归档按设计不写进 `changes`，只遍历 `changes` 会整段漏掉；而同一个文件在两本账里
       * 各出现一次时，逐条执行会互相打架。按文件聚合把这两个问题一起消掉。
       */
      const ledger = new Set()
      for (const c of runManifest.changes ?? []) {
        if (typeof c?.file === 'string' && c.file) ledger.add(c.file)
      }
      for (const a of runManifest.archive?.archived ?? []) {
        if (a?.ok && a.file) ledger.add(a.file)
      }

      for (const name of ledger) {
        const atTop = await stat(join(this.memoryDir, name)).catch(() => null)
        /** 快照里那一份的真实文件名（大小写可能不同），null = 运行前不存在。 */
        const snapName = snapNameOf(name)
        if (!snapName) {
          // 运行前不存在：目标状态是「顶层没有它」。
          if (atTop) await park(name, '本次整理新建，回滚即退场')
          // 已被这趟归档进 archive/ 的：留在档案馆，不搬回来。
          continue
        }
        // 运行前存在：目标状态是「顶层是运行前那一版」。
        if (atTop) {
          try {
            await writeBack(name, snapName)
            restored.push(name)
          } catch (err) {
            skipped.push(`${name}（写回失败：${err?.message ?? err}）`)
          }
          continue
        }
        if (!(await stat(join(archiveDir, name)).catch(() => null))) {
          skipped.push(`${name}（顶层与 archive/ 里都找不到，可能已人工处理过）`)
          continue
        }
        /**
         * archive/ 里那份**必须是运行前那一版**，才谈得上「移回来」。
         *
         * 一个真实的反例：顶层已不在、而 `archive/` 里躺着一份**更早的另一版**时，
         * 旧写法直接 `restoreMemory()` 把它搬回顶层并报 `restored: 1` —— 出来的既不是
         * 运行前那一版，档案馆那份还被吃掉了。`snapshot.js` 那句「回滚后是不是真回到了
         * 那一版」得在这里落地：
         *   - 洗掉留痕后与快照**逐字节相同** → 就是它，走 `restoreMemory`（顺手洗留痕）
         *   - 不同 → 它是别的东西：从**快照**复制到顶层，`archive/` 那份原样留着（不删不动）
         */
        const snapContent = await readFile(join(snapDir, snapName)).catch(() => null)
        const archContent = await readFile(join(archiveDir, name), 'utf8').catch(() => null)
        if (snapContent && archContent !== null && stripArchiveMeta(archContent) === snapContent.toString('utf8')) {
          const res = await restoreMemory(this.memoryDir, name)
          if (res.ok) restored.push(name)
          else skipped.push(`${name}（恢复失败：${res.error}）`)
        } else if (snapContent) {
          try {
            await writeBack(name, snapName)
            restored.push(name)
            // ⚠️ 记进 notes 而**不是** skipped：文件确实恢复了（restored 里算一个），
            // 只是没走「从 archive/ 移回」那条常规路径。计进 skipped 会让面板说
            // 「跳过 1 个」，读者以为它没回来。
            notes.push(`${name}：archive/ 里那份不是运行前那一版，已改用快照版本写回；archive/ 那份原样保留`)
          } catch (err) {
            skipped.push(`${name}（写回失败：${err?.message ?? err}）`)
          }
        } else {
          skipped.push(`${name}（快照里没有这一版，无法恢复）`)
        }
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
    if (notes.length) {
      lines.push('## 说明', '', ...notes.map((n) => `- ${n}`), '')
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
