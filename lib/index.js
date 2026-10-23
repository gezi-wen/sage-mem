/**
 * sage-mem — 文件式记忆插件。
 *
 * 记忆存在本地 markdown 文件目录（frontmatter + 正文，4 类），不是数据库。
 * host 侧三件事：
 *   1. 按问题检索注入：system-prompt/assemble 时扫 memory 目录，按双字匹配
 *      选相关文件，读全文注入 system prompt，让 agent 第一轮就「想起」
 *   2. TypertRemoteService：给设置页「记忆管理」提供文件列表/读/写/删
 *   3. autodream（自动做梦）：可选的记忆整理，见 lib/autodream.js
 *
 * 写入靠 AGENTS.md 的「记忆使用」规则引导 agent 自己判断 + 用文件工具写
 * memory 目录——透明、可检查、防膨胀。无 worker、无 SQLite、无端口。
 *
 * 旧 worker 版见 git 分支 `sqlite-worker`。
 */

import { AutodreamEngine } from './autodream.js'
import { auditMemoryDir } from './autodream/audit.js'
import { DEFAULT_CONFIG } from './autodream/config.js'
import { LIMIT_SPECS, MAX_BASELINE, MAX_CHARS_PER_FILE, MAX_FILE_BYTES, MAX_RESULTS, MAX_SESSION_BYTES, MEMORY_DIR, RECALL_DISCIPLINE, RESERVED_FILES, SESSIONS_ROOT, STALE_DAYS, STATE_ROOT } from './memory/config.js'
import { INDEX_FILE_KEY, SESSION_LOG_KEY, isPlainMdName } from './shared/md-name.js'
import { parseAliases, parseBaseline, parseBaselinePriority, parseFrontmatter, parseTags } from './memory/frontmatter.js'
import { ageDays, bigrams, score, selectBaseline, selectRelevant } from './memory/retrieval.js'
import { isReserved, nameKey, safeName } from './memory/naming.js'
import { MEMORY_ARCHIVE_DIR, addArchiveMeta, extractTitle, inspectDir, inspectMemoryEntry, readArchivedMeta, readVerified, scanArchived, scanMemoryFiles, scanStars, shadowsReserved } from './memory/scan.js'
import { archiveMemory, deleteArchivedMemory, restoreMemory } from './memory/archive.js'
import { flushAccess, pickArchiveCandidates, readAccessLedger } from './memory/access.js'
import { warnLog, writeFileAtomic } from './memory/util.js'
import { readLockSet, setLocked as setLockedImpl } from './memory/lock.js'
import { openMemoryFolder } from './memory/open-folder.js'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkUpdate as checkUpdateImpl } from './update.js'
import { autodreamConfigSnapshot, clampInt, MAX_RAW_BYTES, pendingLimits, rawName, readReservedFile, readSettingsFile, RESERVED_FILE, SETTINGS_FILE } from './settings.js'
import { createRecallInjector, createSessionInjectState, readRecallDebug } from './recall/index.js'
import { mountAutodream, mountMemoryTools, mountObserve, mountWriteGate } from './assembly/index.js'

/**
 * 手动 @Remote marker 注册（Node 24 不解析装饰器语法，手写 decorator context）。
 */
function markRemote(cls, method, exportName) {
  const instance = Object.create(cls.prototype)
  Remote(exportName)(undefined, {
    kind: 'method',
    name: method,
    private: false,
    static: false,
    addInitializer(fn) {
      fn.call(instance)
    },
  })
}

export class MemoryGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'memory')
    // 一并挂载星图 remote（同一记忆目录，纯只读）—— starmap.* 服务
    new StarmapGateway(ctx)

    // 四块挂载（1.2.0 从构造函数里搬出的四段）。顺序保持原样：
    // autodream → 检索工具 → 观测 → 写入门。
    mountAutodream(ctx, {
      AutodreamEngine,
      AutodreamGateway,
      memoryDir: MEMORY_DIR,
      sessionsRoot: SESSIONS_ROOT,
      reservedFiles: [...RESERVED_FILES],
    })
    const tools = mountMemoryTools(ctx)
    mountObserve(ctx, MEMORY_DIR)
    // ⚠️ 写入门必须在 apply 里**同步**注册（见 lib/assembly/write-gate-mount.js 头注的「注册窗口」）。
    mountWriteGate(ctx, MEMORY_DIR)

    // 会话级注入状态：一处持有、一处提交（见 lib/recall/state.js 的头注）。
    const injectState = createSessionInjectState()

    // 按问题检索注入：system-prompt/assemble 是异步 waterfall，监听器可 await。
    // 编排骨架在 lib/recall/injector.js，选材 / 渲染 / 预算三段是纯函数；行为由
    // test/recall-golden-test.mjs 的 11 个场景逐字节守着。
    ctx.on('system-prompt/assemble', createRecallInjector({ ctx, state: injectState, tools }))
  }

  /**
   * 查有没有新版本（面板进入时静默调一次）。
   *
   * 实现全在 `lib/update.js`：**当前版本运行时读自己的 `package.json`**（不内联常量 ——
   * 内联会在「构建早于 bump」时停留在旧版本，插件于是永远对自己报「有新版本」）；
   * 查不到一律降级为「不提示」，绝不在界面上冒红条。
   */
  async checkUpdate() {
    return await checkUpdateImpl()
  }

  /**
   * 最近几次注入尝试的账（1.7.0 面板「工具 → 注入调试」的唯一数据源）。
   *
   * **只读、不落盘**：数据是注入链在 `SAGE_MEM_DEBUG=1` 时记进进程内存的环形缓冲
   * （见 `lib/recall/debug.js`）；开关关着时返回 `{ enabled: false, records: [] }`，
   * 面板据此不显示入口。不提供「清空 / 修改」能力 —— 一份账记下来就是那一刻的事实。
   */
  async recallDebug() {
    return readRecallDebug()
  }

  /** 列出 memory 目录全部记忆文件（文件名 + 类型 + 描述 + 大小 + 自定义标签 + 是否锁定）。 */
  async listFiles() {
    const [files, locked] = await Promise.all([scanMemoryFiles(this.ctx, ''), readLockSet(MEMORY_DIR)])
    return files.map(f => {
      const meta = parseFrontmatter(f.content)
      return {
        file: f.file,
        type: meta.type || 'reference',
        description: meta.description || '',
        size: f.content.length,
        tags: meta.tags,
        // 锁定状态跟着每条一起给：卡片上的「锁定 / 已锁定」按钮要据此渲染
        locked: locked.has(nameKey(f.file)),
      }
    })
  }

  /**
   * 读单个记忆文件全文。
   *
   * 过闸门再读：名字在记忆目录里**不等于**内容住在记忆目录里 —— 符号链接 / 目录联接 /
   * 硬链接都能让一次「读自己的记忆」变成读别人的文件，而读到的内容会被注入模型上下文。
   */
  async readFile(name) {
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    const full = join(MEMORY_DIR, safe)
    // 名字不是保留名 ≠ 文件不是保留名：8.3 短名（`MEMORY~1.MD`）文本上与索引毫无关系，
    // 却是同一个文件。别把索引当普通记忆交出去。
    if (await shadowsReserved(full)) {
      throw new Error(`sage-mem: refusing to read ${safe}: 这是某个保留名（索引 / 流水）的另一个名字`)
    }
    const gate = await inspectMemoryEntry(full)
    if (!gate.ok) throw new Error(`sage-mem: refusing to read ${safe}: ${gate.error}`)
    const content = await readVerified(full, gate, 'utf8')
    return { name: safe, content }
  }

  /**
   * 写（新增或覆盖）单个记忆文件。
   *
   * 三道闸：保留名不可写、内容必须是字符串、体积有上限；落盘走原子写。
   * 拒绝一律返回 { ok: false, error }（不是抛异常）——设置页的调用方按 ok 判定。
   */
  async writeFile(name, content) {
    // 保留名判定放在最前面、且以 nameKey 归一：'memory.md' / 'MEMORY.MD' /
    // 'Session-Log.md' 在 NTFS 上都是同一个文件，必须一律走 { ok: false } 这条路
    // （设置页按 ok 判定，见 client.js 的 submit()）。
    if (isReserved(name)) {
      return { ok: false, file: nameKey(name), error: `sage-mem: reserved file, edit it with the file tools: ${nameKey(name)}` }
    }
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    // 名字文本不是保留名 **不等于** 文件不是保留名：NTFS 的 8.3 短名（`MEMORY~1.MD`）
    // 在文本上跟索引毫无关系，inode 却是同一个 —— 实测它能改写索引。
    // 保留名保护必须落在**文件身份**上，否则「保留名不可写」这句承诺是假的。
    if (await shadowsReserved(join(MEMORY_DIR, safe))) {
      return { ok: false, file: safe, error: `sage-mem: reserved file (它的另一个名字是 ${safe})，请用文件工具改` }
    }
    // 不加这一层，传个对象进来会被 String() 写成 "[object Object]" 还回 { ok: true }，
    // 原文件就此被一行垃圾顶掉，且没有任何错误信号。
    if (typeof content !== 'string') {
      return { ok: false, file: safe, error: `sage-mem: content must be a string, got ${typeof content}` }
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_FILE_BYTES) {
      return { ok: false, file: safe, error: `sage-mem: content too large (${bytes} bytes > ${MAX_FILE_BYTES})` }
    }
    /**
     * 目标已存在时也要过闸门：链接 / 硬链接一律拒绝。
     *
     * 原子写本身不会写穿链接（rename 换掉的是链接本身），但那样「改这条记忆」就变成了
     * 「把这个名字指向别处」—— 用户以为改的是记忆，实际磁盘上多了一个指向外部的名字。
     * `limitBytes = 0` 表示不在这里判体积（上面刚按字符数查过）。
     */
    const target = join(MEMORY_DIR, safe)
    const existing = await inspectMemoryEntry(target, { limitBytes: null })
    if (!existing.ok && existing.code !== 'missing') {
      return { ok: false, file: safe, error: `sage-mem: refusing to write ${safe}: ${existing.error}` }
    }
    await writeFileAtomic(target, content)
    return { ok: true, file: safe }
  }

  /** 删除单个记忆文件：保留名一律拒绝（unlink 不可逆）。判定同 writeFile。 */
  async deleteFile(name) {
    if (isReserved(name)) {
      return { ok: false, error: `sage-mem: reserved file, refusing to delete: ${nameKey(name)}` }
    }
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    // 同 writeFile：8.3 短名能绕过名字文本判据，删除保护也必须看文件身份。
    if (await shadowsReserved(join(MEMORY_DIR, safe))) {
      return { ok: false, error: `sage-mem: reserved file (它的另一个名字是 ${safe})，拒绝删除` }
    }
    await unlink(join(MEMORY_DIR, safe))
    return { ok: true }
  }

  /**
   * 归档一条记忆：把文件移进 `memory/archive/`（**不删**），并在 frontmatter 里留下
   * `archived_at` / `archived_reason`。
   *
   * 语义是「静默失效且可回退」：归档区不参与检索（见 memory/scan.js 的 scanMemoryFiles），
   * 但列表与星图都看得见它，也能一键恢复 —— 所以这里只是移动 + 打标，绝不 unlink。
   *
   * 真正的实现在 `memory/archive.js`：autodream 的 `archive_memory` 工具与自动归档策略
   * 走的是同一份 —— 三条入口只许有一种行为。
   *
   * 拒绝一律返回 `{ ok: false, error }`（不是抛）：面板按 ok 判定，抛出去只会变成
   * 一句没有上下文的报错。
   */
  async archive(name, reason) {
    const res = await archiveMemory(MEMORY_DIR, name, reason)
    if (!res.ok) return { ok: false, error: res.error }
    /**
     * ⚠️ `unindexed` / `indexError` 必须**原样透出去**（2026-10-12 复审 R11 的配套）：
     * 归档本身成功、索引却没摘掉时，这正是用户该被告知的那件事 —— 底下那句
     * 「索引没摘」在面板上要看得见，不能只活在 host 的返回值里被 strict 剥掉。
     */
    return {
      ok: true,
      file: res.file,
      archivedReason: res.archivedReason,
      unindexed: res.unindexed,
      ...(res.indexError ? { indexError: res.indexError } : {}),
    }
  }

  /**
   * 从归档区恢复一条记忆：移回根目录，并去掉 `archived_at` / `archived_reason` 两行。
   * 同样委托给 `memory/archive.js`（判断与拒绝矩阵只有一份）。
   */
  async restore(name) {
    const res = await restoreMemory(MEMORY_DIR, name)
    if (!res.ok) return { ok: false, error: res.error }
    // 与 `archive` 对称：文件回来了但索引没补上时，如实告诉界面（见那边的说明）。
    return {
      ok: true,
      file: res.file,
      indexed: res.indexed,
      ...(res.indexError ? { indexError: res.indexError } : {}),
    }
  }

  /**
   * 列出归档区的全部记忆（面板的「已归档」区）。
   *
   * 与 `listFiles()` 分开、形状也不同：`listFiles` 只列活动记忆、多一个字段都会破坏
   * 界面与断言依赖的形状；归档条目额外带 `archivedAt` / `archivedReason`。
   * 旧版 autodream 工具直接移文件、不写留痕，所以这两个字段可能是空串。
   */
  async listArchived() {
    const files = await scanArchived(this.ctx)
    const out = files.map(f => {
      const meta = parseFrontmatter(f.content)
      const archived = readArchivedMeta(f.content)
      return {
        file: f.name,
        type: meta.type || 'reference',
        description: meta.description || '',
        size: f.content.length,
        tags: meta.tags,
        archivedAt: archived.archivedAt,
        archivedReason: archived.archivedReason,
      }
    })
    return { count: out.length, files: out }
  }

  /**
   * 读一份**已归档**记忆的全文。
   *
   * 归档不是删除，正文就该和活跃记忆一样能看能改（使用者的要求）。名字仍然只走
   * `safeName`：调用方永远不许自己拼路径，归档区也只认 `memory/archive/` 这一层。
   */
  async readArchived(name) {
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    // 归档区本身先过目录闸门：它若是指向别处的联接，读归档就等于读外部的文件。
    const dirGate = await inspectDir(MEMORY_ARCHIVE_DIR)
    if (!dirGate.ok) throw new Error(`sage-mem: archive dir unavailable: ${dirGate.error}`)
    const full = join(MEMORY_ARCHIVE_DIR, safe)
    const gate = await inspectMemoryEntry(full)
    // 找不到就抛：与 readFile 一致。静默返回空串会让面板显示一个「空的记忆」，
    // 而用户改完一存 —— 就把一条真实内容顶掉了。
    if (!gate.ok) {
      // ⚠️「形状不对」与「不存在」是两回事：把联接 / 超限都报成「文件不存在」，
      // 会让用户去找一个明明躺在盘上的文件。
      if (gate.code === 'missing') throw new Error(`sage-mem: archived file not found: ${safe}`)
      throw new Error(`sage-mem: refusing to read archived ${safe}: ${gate.error}`)
    }
    const content = await readVerified(full, gate, 'utf8')
    return { name: safe, content }
  }

  /**
   * 写一份**已归档**记忆的正文（覆盖整份文件，形状与 `writeFile` 一致）。
   *
   * 三道闸照抄 writeFile：名字先过 safeName、内容必须是字符串、体积上限，最后原子写。
   * 额外一条：**盘上那份的归档留痕（`archived_at` / `archived_reason`）不许因为改正文而丢**。
   * 调用方若交回一份连留痕都没有的内容（「重建 frontmatter」式编辑器就是这样），
   * 这里按盘上原来的值补回去 —— 归档凭据不该依赖调用方是否体贴。
   */
  async writeArchived(name, content) {
    if (isReserved(name)) {
      return { ok: false, file: nameKey(name), error: `sage-mem: reserved file, edit it with the file tools: ${nameKey(name)}` }
    }
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    const dirGate = await inspectDir(MEMORY_ARCHIVE_DIR)
    if (!dirGate.ok) return { ok: false, file: safe, error: `sage-mem: archive dir unavailable: ${dirGate.error}` }
    const full = join(MEMORY_ARCHIVE_DIR, safe)
    const gate = await inspectMemoryEntry(full, { limitBytes: null })
    // 只改归档区里**已经存在**的文件：这条 remote 不是「把任意文件写进归档区」的后门。
    if (!gate.ok) {
      return {
        ok: false,
        file: safe,
        error:
          gate.code === 'missing'
            ? `sage-mem: archived file not found: ${safe}`
            : `sage-mem: refusing to write archived ${safe}: ${gate.error}`,
      }
    }
    if (typeof content !== 'string') {
      return { ok: false, file: safe, error: `sage-mem: content must be a string, got ${typeof content}` }
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_FILE_BYTES) {
      return { ok: false, file: safe, error: `sage-mem: content too large (${bytes} bytes > ${MAX_FILE_BYTES})` }
    }
    const given = readArchivedMeta(content)
    let toWrite = content
    if (!given.archivedAt && !given.archivedReason) {
      const onDisk = readArchivedMeta(await readVerified(full, gate, 'utf8'))
      if (onDisk.archivedAt || onDisk.archivedReason) {
        toWrite = addArchiveMeta(content, onDisk.archivedReason, onDisk.archivedAt)
      }
    }
    await writeFileAtomic(full, toWrite)
    return { ok: true, file: safe }
  }

  /**
   * **彻底删除**一条已归档记忆（不可恢复）。
   *
   * 与 `deleteFile` 的区别要在代码里就分开：那个删的是活动记忆，这个删的是档案馆里的退役件；
   * 归档「只移不删」的承诺不变 —— 走进档案馆之后，删不删由人单独决定。
   *
   * `archivedAt` 是**身份判据**（见 `memory/archive.js` 的头注）：调用方交回它当时看见的
   * 归档时间，盘上那份对不上就拒绝。不传 / 传空串只对「本来就没有留痕的老归档件」成立。
   */
  async deleteArchived(name, archivedAt) {
    const res = await deleteArchivedMemory(MEMORY_DIR, name, archivedAt)
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true, file: res.file }
  }

  /**
   * 记忆目录体检：结构化审计结果。
   *
   * **直接透出 `auditMemoryDir` 的返回**，不另写一套检查 —— 面板上的「问题」与 autodream
   * 报告里的必须是同一份判断，否则用户与模型看到的健康状况会互相打架。只读。
   */
  async audit() {
    return auditMemoryDir(MEMORY_DIR)
  }

  /**
   * 用系统文件管理器打开记忆目录（设置页「打开记忆文件夹」）。
   *
   * host 侧起一个 detached 进程就返回，不等待窗口出现；路径是插件自己的记忆目录，
   * 不接受界面传入，避免把「打开任意路径」变成一个能力。
   */
  async openMemoryDir() {
    return openMemoryFolder(MEMORY_DIR)
  }

  /**
   * 自动归档候选 + 当前策略与阈值（面板「执行归档」前先看清单）。
   *
   * 复用 `memory/access.js` 的台账与候选计算，与 autodream 引擎跑的是同一份逻辑。
   * 先强制 flush 台账：面板看到的候选不能比引擎少（内存里还压着的那批注入必须算进去）。
   */
  /**
   * 上锁 / 解锁一条记忆。锁上的记忆**拒绝归档**（自动与手动都不行）。
   *
   * 落点是**状态目录**（`.sage-mem/locked.json`），不写进记忆自己的 frontmatter ——
   * 理由见 `lib/memory/lock.js` 的头注：frontmatter 会被「自动做梦」重写，锁写在里面
   * 可能被整理过程擦掉，而锁一丢那条记忆就重新进了自动归档候选（正是这功能要防的事）。
   */
  async setLocked(name, locked) {
    return await setLockedImpl(MEMORY_DIR, name, locked === true)
  }

  async archiveCandidates() {
    await flushAccess(MEMORY_DIR)
    const [ledger, files, locked] = await Promise.all([
      readAccessLedger(),
      scanMemoryFiles(this.ctx, ''),
      readLockSet(MEMORY_DIR),
    ])
    const cfg = await autodreamConfigSnapshot()
    const thresholds = {
      project: cfg.archiveAfterDaysProject,
      reference: cfg.archiveAfterDaysReference,
      user: cfg.archiveAfterDaysUser,
    }
    // 锁表交给候选计算：锁上的记忆一个都不选（用户对**单条**记忆说的话优先于阈值）。
    const candidates = pickArchiveCandidates(files, ledger, { thresholds, locked })
    return {
      count: candidates.length,
      candidates,
      autoArchive: cfg.autoArchive,
      thresholds,
      // 面板要显示「哪些锁着」，所以把锁表也带回去（已按 nameKey 归一）
      locked: [...locked],
    }
  }

  /**
   * 面板上的注入设置（5 项上限 + 保留名保护名单）。
   *
   * ⚠️ **这 5 个常量是模块加载时读的**：面板改完要**重启 DSH** 才生效。所以这里同时给出
   * 「当前生效值」`limits` 与「待生效值」`pendingLimits`，外加 `restartRequired` ——
   * 界面才能诚实地说「改好了，重启后生效」，而不是让用户以为立刻生效又看不到变化。
   */
  async getSettings() {
    const file = await readSettingsFile()
    const limits = {
      maxResults: MAX_RESULTS,
      maxChars: MAX_CHARS_PER_FILE,
      maxBaseline: MAX_BASELINE,
      maxSessionBytes: MAX_SESSION_BYTES,
      staleDays: STALE_DAYS,
    }
    const pending = pendingLimits(file)
    const reservedExtra = await readReservedFile()
    // 模块加载时那份「用户声明的保护名」（RESERVED_FILES 里抠掉两个内置名）
    const activeExtra = [...RESERVED_FILES].filter((n) => n !== INDEX_FILE_KEY && n !== SESSION_LOG_KEY)
    const norm = (list) => JSON.stringify([...list].map((s) => String(s).toLowerCase()).sort())
    const restartRequired =
      JSON.stringify(limits) !== JSON.stringify(pending) || norm(activeExtra) !== norm(reservedExtra)
    return {
      limits,
      pendingLimits: pending,
      restartRequired,
      // 生效的保护名单（含两个内置名）+ 用户声明的那部分原文（面板编辑的是后者）
      reserved: [...new Set([INDEX_FILE_KEY, SESSION_LOG_KEY, ...reservedExtra.map((s) => s.toLowerCase())])],
      reservedExtra,
    }
  }

  /**
   * 改设置：5 项上限落 `<状态根>/settings.json`，保护名单落 `<状态根>/reserved.json`。
   *
   * 校验**先全部过一遍再写盘**：任何一个值非法就整体 `{ ok:false }`，绝不写半份。
   * 越界不是「夹到边界」（那是环境变量的宽容语义）—— 面板上手输的数字越界是笔误，
   * 静默改成别的值比报错更让人困惑。
   */
  async setSettings(patch) {
    const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
    const limitsPatch = p.limits && typeof p.limits === 'object' && !Array.isArray(p.limits) ? p.limits : null
    const nextLimits = {}
    if (limitsPatch) {
      for (const [key, value] of Object.entries(limitsPatch)) {
        const spec = LIMIT_SPECS[key]
        if (!spec) return { ok: false, error: `sage-mem: unknown setting: ${key}` }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return { ok: false, error: `sage-mem: ${key} must be a number, got ${typeof value}` }
        }
        const rounded = Math.round(value)
        if (rounded < spec.lo || rounded > spec.hi) {
          return { ok: false, error: `sage-mem: ${key} must be an integer in [${spec.lo}, ${spec.hi}], got ${value}` }
        }
        nextLimits[key] = rounded
      }
    }
    let nextReserved = null
    if (p.reserved !== undefined) {
      if (!Array.isArray(p.reserved)) return { ok: false, error: 'sage-mem: reserved must be an array of file names' }
      const cleaned = []
      for (const item of p.reserved) {
        const s = String(item ?? '').trim()
        if (!isPlainMdName(s) || s.startsWith('..')) {
          return { ok: false, error: `sage-mem: invalid reserved file name: ${String(item)}` }
        }
        if (!cleaned.includes(s)) cleaned.push(s)
      }
      nextReserved = cleaned
    }
    if (!limitsPatch && nextReserved === null) return { ok: false, error: 'sage-mem: empty patch' }

    await mkdir(STATE_ROOT, { recursive: true })
    if (limitsPatch) {
      const current = await readSettingsFile()
      const merged = { ...(current?.limits ?? {}), ...nextLimits }
      await writeFileAtomic(SETTINGS_FILE, JSON.stringify({ limits: merged, updatedAt: Date.now() }, null, 2))
    }
    if (nextReserved !== null) {
      await writeFileAtomic(RESERVED_FILE, `${JSON.stringify(nextReserved, null, 2)}\n`)
    }
    // 写盘即提示重启：这些值在模块加载时就固化了，不重启它一定还没生效。
    return { ok: true, settings: await this.getSettings(), restartRequired: true }
  }

  /**
   * 原样读保留名文件（`MEMORY.md` / `session-log.md` / 用户声明的保护名）。
   *
   * **不解析、不重建**：索引与流水是纯文本，面板拿到什么就显示什么。
   */
  async readRaw(name) {
    if (!isReserved(name)) {
      return { ok: false, error: `sage-mem: ${String(name)} is not a reserved file; normal memories use the memory form or readFile` }
    }
    const safe = rawName(name)
    if (!safe) return { ok: false, error: `sage-mem: invalid file name: ${String(name)}` }
    // 保留名同样过闸门：链接 / 硬链接一样能把「读索引 / 读流水」变成读外部文件。
    // ⚠️ 体积**不**在这里判（`limitBytes = 0`）：流水天然比单条记忆大得多，
    // 它有自己的上限（`MAX_RAW_BYTES`，见上面的注释）。
    const full = join(MEMORY_DIR, safe)
    const gate = await inspectMemoryEntry(full, { limitBytes: null })
    if (!gate.ok) throw new Error(`sage-mem: refusing to read ${safe}: ${gate.error}`)
    // 读不到就抛（与 readFile 一致）：静默返回空串会让面板显示一份「空的索引」，
    // 用户一存就把真索引顶掉。
    const content = await readVerified(full, gate, 'utf8')
    return { name: safe, content }
  }

  /**
   * 原样写保留名文件：**逐字节照写，绝不重建 frontmatter**。
   *
   * 这就是 2026-09-25 那次 P0 数据丢失事故（表单重建 frontmatter 把 baseline /
   * node_type / originSessionId 全抹掉）的解药：索引与流水只许原样进出。
   */
  async writeRaw(name, content) {
    if (!isReserved(name)) {
      return { ok: false, error: `sage-mem: ${String(name)} is not a reserved file; normal memories use the memory form or writeFile` }
    }
    const safe = rawName(name)
    if (!safe) return { ok: false, error: `sage-mem: invalid file name: ${String(name)}` }
    if (typeof content !== 'string') {
      return { ok: false, file: safe, error: `sage-mem: content must be a string, got ${typeof content}` }
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    // ⚠️ 与 writeFile 的 512 KB 上限**不是同一个数**：流水天然更大（见 MAX_RAW_BYTES 的注释）。
    if (bytes > MAX_RAW_BYTES) {
      return {
        ok: false,
        file: safe,
        error: `sage-mem: content too large (${bytes} bytes > ${MAX_RAW_BYTES / (1024 * 1024)} MB raw limit)`,
      }
    }
    const target = join(MEMORY_DIR, safe)
    // 与 `writeFile` 同一条理由：目标已存在时若是链接 / 硬链接，一律拒绝 ——
    // 「改这份索引」不该变成「把这个名字指向别处」。体积由上面那道 `MAX_RAW_BYTES` 管。
    const existing = await inspectMemoryEntry(target, { limitBytes: null })
    if (!existing.ok && existing.code !== 'missing') {
      return { ok: false, file: safe, error: `sage-mem: refusing to write ${safe}: ${existing.error}` }
    }
    await writeFileAtomic(target, content)
    return { ok: true, file: safe }
  }
}

markRemote(MemoryGateway, 'listFiles', 'listFiles')
markRemote(MemoryGateway, 'readFile', 'readFile')
markRemote(MemoryGateway, 'writeFile', 'writeFile')
markRemote(MemoryGateway, 'deleteFile', 'deleteFile')
markRemote(MemoryGateway, 'archive', 'archive')
markRemote(MemoryGateway, 'restore', 'restore')
markRemote(MemoryGateway, 'listArchived', 'listArchived')
markRemote(MemoryGateway, 'readArchived', 'readArchived')
markRemote(MemoryGateway, 'writeArchived', 'writeArchived')
markRemote(MemoryGateway, 'deleteArchived', 'deleteArchived')
markRemote(MemoryGateway, 'audit', 'audit')
markRemote(MemoryGateway, 'openMemoryDir', 'openMemoryDir')
markRemote(MemoryGateway, 'checkUpdate', 'checkUpdate')
markRemote(MemoryGateway, 'setLocked', 'setLocked')
markRemote(MemoryGateway, 'archiveCandidates', 'archiveCandidates')
markRemote(MemoryGateway, 'getSettings', 'getSettings')
markRemote(MemoryGateway, 'setSettings', 'setSettings')
markRemote(MemoryGateway, 'readRaw', 'readRaw')
markRemote(MemoryGateway, 'writeRaw', 'writeRaw')
// 1.7.0：注入调试账（只读；开关关着时返回 { enabled: false, records: [] }）
markRemote(MemoryGateway, 'recallDebug', 'recallDebug')

/**
 * 记忆星图（宿主侧）—— 只读扫描记忆目录，把每条记忆解析成一颗「星」。
 * 通过 TypertRemoteService 暴露两个 remote 方法给界面侧：
 *   - starmap.listStars(includeArchived)  全部星（元数据，不含正文）
 *   - starmap.readFile(n)                 单条记忆全文（文件名白名单校验）
 */
export class StarmapGateway extends TypertRemoteService {
  constructor(ctx) { super(ctx, 'starmap') }

  /**
   * @param {boolean} [includeArchived] — 连归档区一起给（默认 false：与从前一样只看活着的星）
   */
  async listStars(includeArchived) {
    const files = await scanStars(this.ctx, includeArchived === true)
    const stars = files.map(f => {
      const meta = parseFrontmatter(f.content)
      const title = extractTitle(f.content)
      const star = {
        file: f.name,
        kind: meta.type || 'special',
        title: title || meta.name || (meta.description ? meta.description.slice(0, 24) : f.name.replace(/\.md$/, '')),
        desc: meta.description || '',
        bytes: f.bytes,
        mtimeMs: f.mtimeMs,
        archived: f.archived === true,
      }
      // 归档留痕只对归档星有意义；活动星连键都不出现（保持与旧形状逐字段相同）。
      if (star.archived) {
        const a = readArchivedMeta(f.content)
        star.archivedAt = a.archivedAt
        star.archivedReason = a.archivedReason
      }
      return star
    })
    return { count: stars.length, stars }
  }

  async readFile(name) {
    // 与 MemoryGateway.readFile 收敛到同一个 safeName：它现在同时排除
    // MEMORY.md 与 session-log.md，且大小写不敏感。
    const safe = safeName(name)
    if (!safe) throw new Error('sage-starmap: invalid file name')
    const full = join(MEMORY_DIR, safe)
    // 2026-10-23 审查 R19：面板读原先只过 safeName，与注入链 / 工具读不是同一套闸门。
    // 面板读不进模型上下文，但「同一个名字在不同入口有不同含义」本身就是缺陷面 —— 收口。
    if (await shadowsReserved(full)) {
      throw new Error(`sage-starmap: refusing to read ${safe}: 这是某个保留名（索引 / 流水）的另一个名字`)
    }
    const gate = await inspectMemoryEntry(full)
    if (!gate.ok) throw new Error(`sage-starmap: refusing to read ${safe}: ${gate.error}`)
    const content = await readVerified(full, gate, 'utf8')
    return { name: safe, content }
  }
}

markRemote(StarmapGateway, 'listStars', 'listStars')
markRemote(StarmapGateway, 'readFile', 'readFile')

/**
 * autodream 的 remote 面：设置页「自动做梦」标签页唯一的数据通道。
 *
 * 这一层刻意很薄——全部判断（门控、模式、白名单）都在 AutodreamEngine 里，
 * 这里只负责把 ctx 里的引擎接到 typert 的调用表上。想看行为就读 autodream.js。
 */
export class AutodreamGateway extends TypertRemoteService {
  constructor(ctx, engine) {
    super(ctx, 'autodream')
    this.engine = engine
  }

  /** 配置 + 状态 + 路径 + 默认值（设置面板一次拿全）。 */
  async getConfig() {
    return this.engine.getConfig()
  }

  /** 改配置（补丁式）。 */
  async setConfig(patch) {
    return this.engine.setConfig(patch)
  }

  /** 轮询用：是否在跑、跑到哪一步、上次结果。 */
  async status() {
    return this.engine.status()
  }

  /**
   * 手动跑一趟。设置页的「立即整理」走这里。
   *
   * force 默认为 true —— 人点了按钮，就不该再被「还没到 24 小时」挡回来。
   *
   * **故意不 await**：一趟 autodream 可能跑几分钟（多轮模型调用 + 工具），
   * remote 调用挂在那儿等会直接撞上前端超时，界面上表现为「点了没反应」。
   * 所以这里只负责点火，进度与结果都从 status() 轮询 —— run() 自己会把
   * lastResult 落盘，界面刷新几次就能看到。
   */
  async runNow(opts) {
    if (this.engine.running) return { ok: false, error: '已有一趟 autodream 在跑' }
    const reason = typeof opts?.reason === 'string' && opts.reason.trim() ? opts.reason.trim().slice(0, 120) : '设置页手动触发'
    this.engine.run({ reason, force: true }).catch(() => {})
    return { ok: true }
  }

  /** 历史报告列表。 */
  async listReports() {
    return this.engine.listReports()
  }

  /** 读一份报告全文。 */
  async readReport(name) {
    return this.engine.readReport(name)
  }

  /** 已有快照（面板显示「可回退到哪一份」）。 */
  async listSnapshots() {
    return this.engine.listSnapshots()
  }

  /** 运行记录列表（面板的「整理声明」区）。 */
  async listRuns(opts) {
    return this.engine.listRuns(opts?.limit)
  }

  /** 读某次运行的完整整理声明（人读 markdown + 机读 manifest）。 */
  async readDeclaration(opts) {
    return this.engine.readDeclaration(opts?.runId)
  }

  /**
   * 回滚到某个回滚点。
   *
   * 与 runNow 相反，这里**必须 await**：回滚是几十毫秒级的文件操作，
   * 而「点完按钮不知道到底滚没滚」正是回滚这种动作最不能接受的体验。
   */
  async rollback(opts) {
    return this.engine.rollback({ snapshotId: opts?.snapshotId, scope: opts?.scope })
  }

  /** 可选的整理模型路线（设置面板的模型下拉）。 */
  async listModels() {
    return this.engine.listModels()
  }
}

markRemote(AutodreamGateway, 'getConfig', 'getConfig')
markRemote(AutodreamGateway, 'setConfig', 'setConfig')
markRemote(AutodreamGateway, 'status', 'status')
markRemote(AutodreamGateway, 'runNow', 'runNow')
markRemote(AutodreamGateway, 'listReports', 'listReports')
markRemote(AutodreamGateway, 'readReport', 'readReport')
markRemote(AutodreamGateway, 'listSnapshots', 'listSnapshots')
markRemote(AutodreamGateway, 'listRuns', 'listRuns')
markRemote(AutodreamGateway, 'readDeclaration', 'readDeclaration')
markRemote(AutodreamGateway, 'rollback', 'rollback')
markRemote(AutodreamGateway, 'listModels', 'listModels')

export default MemoryGateway

/**
 * **仅供测试**的只读出口。
 *
 * 检索这条链（frontmatter 解析 → 双字打分 → 名额裁剪）没有任何对外可见的调用面：
 * 想验证「写了 aliases 之后换个说法能不能命中」，否则只能起一个真的 DSH 端到端跑一遍。
 * 把这些纯函数露出来是为了能写断言，**不是给外部用的 API**，别依赖。
 */
export const __testables = {
  bigrams,
  score,
  parseFrontmatter,
  parseAliases,
  parseBaselinePriority,
  parseBaseline,
  parseTags,
  ageDays,
  selectRelevant,
  selectBaseline,
  limits: { MAX_RESULTS, MAX_CHARS_PER_FILE, MAX_BASELINE, MAX_SESSION_BYTES, STALE_DAYS },
  recallDiscipline: RECALL_DISCIPLINE,
}

