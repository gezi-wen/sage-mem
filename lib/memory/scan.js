/**
 * sage-mem 记忆层 —— 目录扫描 + 归档区的读写形状。
 *
 * 归档区（`memory/archive/`）**不参与检索**：`scanMemoryFiles` 只扫根目录 ——
 * 这就是「归档 = 静默失效且可回退」的语义，不是漏扫。归档只在两个地方现身：
 * 星图（`scanStars(ctx, true)`）与归档列表（`scanArchived`）—— 让**用户**看得见，
 * 而不是让**模型**想起来。
 *
 * 归档留痕写在文件自己的 frontmatter 里（`archived_at` / `archived_reason`）：
 * 文件可能被手工搬来搬去，随文件走的元数据才不会与文件脱节。
 */

import { MAX_FILE_BYTES, MEMORY_DIR } from './config.js'
import { parseBaseline, parseFrontmatter } from './frontmatter.js'
import { isMemoryEntry, isReserved } from './naming.js'
import { warnLog } from './util.js'
import { createDirWatcher } from './watch.js'
import { lstat, open, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 归档区目录名。与 autodream 工具里的 ARCHIVE_DIR 同名同义（同一个目录）。 */
export const ARCHIVE_DIR_NAME = 'archive'

/** 归档区绝对路径。文件名不变，只换目录。 */
export const MEMORY_ARCHIVE_DIR = join(MEMORY_DIR, ARCHIVE_DIR_NAME)

export { stampHuman as localStamp } from '../shared/stamp.js'

/**
 * 把一个值写成 YAML 标量。
 *
 * 三层处理，少一层就是一个「不报错、值悄悄变形」的陷阱：
 *   1. **换行折成一个空格**（有意的规范化，不是截断）：裸写出去的话，后半行会变成
 *      **另一个 YAML 键**（`理由\narchived_reason: 假的` 会写出两个 `archived_reason`），
 *      或者让 `---` 提前闭合 frontmatter；而 YAML 的多行引号标量读回来又会把换行折成
 *      空格 —— 两种含糊都不如显式折叠。带过换行的值额外加引号，让读者看得出这行被
 *      规范化过。
 *   2. `: `（冒号+空格 → 被当成嵌套映射）与 ` #`（空格+井号 → 后半句被当注释吞掉）
 *      必须给整值加单引号。
 *   3. 空值写 `''`（裸写会变 YAML null）。
 * 单引号按 YAML 规矩翻倍转义。`reason` 来自用户输入，指望人「别写冒号、别写换行」不现实。
 */
export function yamlScalar(value) {
  const raw = String(value ?? '')
  const hadNewline = /[\r\n]/.test(raw)
  const s = raw.replace(/[\r\n]+/g, ' ').trim()
  if (s === '') return "''"
  if (hadNewline || /:(?:\s|$)| #/.test(s) || /^[-?#&*!|>%@`{}[\],'"]/.test(s)) {
    return `'${s.replace(/'/g, "''")}'`
  }
  return s
}

/** frontmatter 块（含两侧 `---`）的匹配；没有 frontmatter 返回 null。 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/

/** 文件用的是哪种换行：回写沿用原风格，别把用户文件的 CRLF 悄悄换成 LF。 */
const eolOf = (content) => (content.includes('\r\n') ? '\r\n' : '\n')

/** 剥掉 YAML 标量两侧的引号（单引号的 `''` 还原成一个 `'`）。 */
function unquoteYaml(raw) {
  const s = String(raw ?? '').trim()
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"')
  return s
}

/** 读 frontmatter 里的归档留痕。没有 frontmatter / 没有这两个字段都回空串。 */
export function readArchivedMeta(content) {
  const m = String(content ?? '').match(FRONTMATTER_RE)
  if (!m) return { archivedAt: '', archivedReason: '' }
  const grab = (key) => {
    const hit = m[1].match(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t\\r]*$`, 'm'))
    return hit ? unquoteYaml(hit[1]) : ''
  }
  return { archivedAt: grab('archived_at'), archivedReason: grab('archived_reason') }
}

/** 去掉归档留痕两行（恢复时用）。没有 frontmatter 就原样返回。 */
export function stripArchiveMeta(content) {
  const src = String(content ?? '')
  const m = src.match(FRONTMATTER_RE)
  if (!m) return src
  const eol = eolOf(src)
  const body = m[1]
    .split(/\r?\n/)
    .filter((line) => !/^[ \t]*archived_(at|reason)[ \t]*:/.test(line))
  const block = ['---', ...body, '---'].join(eol)
  return block + src.slice(m.index + m[0].length)
}

/**
 * 写入归档留痕：`archived_at` + `archived_reason` 插在 frontmatter 末尾。
 *
 * 已经是归档态的文件再归档没有意义（上层会先拒绝），所以这里只做 upsert：
 * 先剥掉旧的两行再插，免得同一份文件里出现两个 `archived_at`。
 * 没有 frontmatter 的文件补一个最小块 —— 归档信息必须有地方放。
 */
export function addArchiveMeta(content, reason, at) {
  const src = String(content ?? '')
  const eol = eolOf(src)
  const lines = [`archived_at: ${yamlScalar(at)}`, `archived_reason: ${yamlScalar(reason)}`]
  const stripped = stripArchiveMeta(src)
  const m = stripped.match(FRONTMATTER_RE)
  if (!m) return ['---', ...lines, '---', '', stripped].join(eol)
  const block = m[0].split(/\r?\n/)
  block.splice(block.length - 1, 0, ...lines)
  return stripped.slice(0, m.index) + block.join(eol) + stripped.slice(m.index + m[0].length)
}

/**
 * 记忆文件形状闸门：只认「普通文件、体积在给定上限内」的 `.md`。
 *
 * 为什么要闸门：记忆目录里的一条 `x.md` **不一定真的住在记忆目录里** ——
 * **符号链接 / 目录联接**把名字留在记忆目录、把内容指到任意路径：读它就是读别人的文件，
 * 写它就是改别人的文件，而这些内容会被注入模型上下文。
 * 用 `lstat` 而不是 `stat`：`stat` 会跟随链接，永远看不出这一层。
 *
 * ⚠️ 本机实测：Windows 上 `symlink()`（文件或目录）要特权、默认 EPERM，但
 * `symlink(dir, 'junction')` **能建** —— 所以这不是理论风险。
 *
 * **硬链接（`nlink > 1`）不拦，只提示**（返回值里的 `links`，由调用方负责出声）。
 * 取舍理由：硬链接**不提供**「指向任意路径」的能力（不能跨卷，只能由已在同卷上有权限的人建），
 * 它带来的是「内容可能被记忆目录之外改到」—— 这是完整性提示，不是越界读取。
 * 而拦它的代价是**真实误伤**：`cp -al` / `rsync --link-dest` 这类快照备份会让源文件的
 * `nlink` 变成 2，于是整条记忆从注入与面板里静默消失（实测复现过）。
 * 宁可提示、不可丢记忆 —— 与「大小写判定宁可多留」同一条原则。
 *
 * 体积上限也在这里：它原先只写在**写入**路径上，读路径谁来都全量读进内存，
 * 等于上限只在「自己人写」的前提下成立（一条被手工粘进来的日志就能把整轮注入吃光）。
 *
 * @param {string} full — 绝对路径
 * @param {{limitBytes?: number|null}} [opts] — `limitBytes: null` = **不判体积**（归档区用）；
 *   不传则用 `MAX_FILE_BYTES`。⚠️ 显式 `null` 与「随便传个 0 / NaN」是两回事：
 *   非有限数一律按「超过上限」处理，不会静默把闸门关掉。
 * @returns {Promise<{ok:true,size:number,mtimeMs:number,links:number}|{ok:false,code:string,error:string}>}
 */
export async function inspectMemoryEntry(full, opts = {}) {
  const limitBytes = opts?.limitBytes === undefined ? MAX_FILE_BYTES : opts.limitBytes
  let info
  try {
    info = await lstat(full)
  } catch (err) {
    return {
      ok: false,
      code: err?.code === 'ENOENT' ? 'missing' : 'stat-failed',
      error: `读不到文件属性（${err?.code ?? err}）`,
    }
  }
  if (info.isSymbolicLink()) return { ok: false, code: 'symlink', error: '是指向别处的符号链接 / 目录联接' }
  if (!info.isFile()) return { ok: false, code: 'not-file', error: '不是普通文件' }
  // null = 明确「不判体积」；其余一律按数值上限处理（0 / NaN / 字符串都会被当成超限）。
  if (limitBytes !== null && (!Number.isFinite(limitBytes) || info.size > limitBytes)) {
    return {
      ok: false,
      code: 'too-big',
      error: Number.isFinite(limitBytes)
        ? `体积 ${info.size} 字节，超过单文件上限 ${limitBytes} 字节`
        : `体积 ${info.size} 字节，上限参数不合法（${String(limitBytes)}）`,
    }
  }
  return { ok: true, size: info.size, mtimeMs: info.mtimeMs, links: info.nlink, id: identityOf(info) }
}

/** 文件身份键（`dev:ino`）。拿不到 inode 的平台返回 null（那就退回名字文本判据）。 */
export function identityOf(info) {
  return info && info.ino ? `${info.dev}:${info.ino}` : null
}

/**
 * 读一份**已经过 `inspectMemoryEntry` 闸门**的文件，并确认「读到的就是闸门检查过的那一份」。
 *
 * 为什么需要它（2026-10-23 外部审查 SEC-01）：`inspectMemoryEntry` 用的是 `lstat(路径)`，
 * 而调用方随后用 `readFile(路径)` —— 两次**按路径**操作之间，另一个进程可以把路径换成
 * 符号链接 / 另一个文件。窗口已被确定性复现：闸门看到 57 B 的正常文件，换入 5 MB 文件后
 * `readFile` 实际读进 5,242,896 B，**512 KB 单文件上限被绕过**。
 *
 * 修法不是「再 stat 一次路径」（那只是把窗口挪小），而是：
 *   1. `open(路径)` 拿到**文件句柄**；
 *   2. 对**同一个句柄** `fstat`，用 `dev:ino` 与闸门给出的身份比对，并复核大小；
 *   3. 只从这个句柄读内容。
 * 这样即使路径在 open 之后被换掉，读的仍是 open 时的那个对象；若在 open 之前被换掉，
 * 身份/大小对不上 → 拒绝，绝不把「没检查过的内容」交出去。
 *
 * 平台差异：Node 没有跨平台的 `O_NOFOLLOW`（Windows 上符号链接还要管理员权限），
 * 所以这里用「身份比对」而不是「不跟随链接」；`inspectMemoryEntry` 的 `lstat` 仍负责
 * 在 open 之前识别链接。两者合起来覆盖「链接被换成普通文件」「普通文件被换成链接/别的文件」
 * 两个方向。拿不到 inode 的平台（`gate.id === null`）退化为只比大小。
 *
 * @param {string} full — 绝对路径
 * @param {{id?: string|null, size?: number}} gate — `inspectMemoryEntry` 的成功返回值
 * @param {string|false} [encoding] — `'utf8'` 返回字符串；`false` 返回 Buffer
 * @returns {Promise<string|Buffer>}
 */
export async function readVerified(full, gate, encoding = 'utf8') {
  const handle = await open(full, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      const err = new Error('文件在检查与读取之间变成了非普通文件')
      err.code = 'changed'
      throw err
    }
    if (gate?.id && identityOf(info) !== gate.id) {
      const err = new Error('文件在检查与读取之间被替换（身份不一致）')
      err.code = 'changed'
      throw err
    }
    if (gate && Number.isFinite(gate.size) && info.size !== gate.size) {
      const err = new Error(`文件在检查与读取之间变过（${gate.size} → ${info.size} 字节）`)
      err.code = 'changed'
      throw err
    }
    return encoding === false ? await handle.readFile() : await handle.readFile({ encoding })
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 保留名在磁盘上的**文件身份**集合（`dev:ino`）。
 *
 * 为什么需要它：保留名保护原先只比**名字文本**（`nameKey` 归一 + 小写）。但 NTFS 上一个
 * 文件可以有第二个 8.3 短名 —— `MEMORY~1.MD` 与 `MEMORY.md` 文本上毫无关系，判据却必须
 * 认出它们是**同一个文件**：实测在能建短名的卷上，`writeFile('MEMORY~1.MD')` 能改写索引、
 * `deleteFile('MEMORY~2.MD')` 能把它删掉，而 `isReserved()` 一路放行。
 *
 * 返回集合在每次调用时现取（保留名就那两三个，一次目录写入的开销可忽略）。
 */
export async function reservedIdentitySet(dir = MEMORY_DIR) {
  const ids = new Set()
  /**
   * ⚠️ **不能**拿 `RESERVED_FILES` 里的字符串直接 join 路径：那个集合是小写归一的
   * （`memory.md`），而磁盘上的真名是 `MEMORY.md`。大小写不敏感的文件系统上两者等价、
   * 看不出问题；**大小写敏感的卷上 `lstat(dir/'memory.md')` 直接 ENOENT，整个身份集合
   * 就是空的 —— 保留名保护静默失效**（Linux CI 实测逮到，本地 Windows 永远看不见）。
   *
   * 所以按**目录里的真实名字**取身份，用 `isReserved()`（它自己做大小写归一）判定。
   */
  const names = await readdir(dir).catch(() => [])
  for (const name of names) {
    if (!isReserved(name)) continue
    const info = await lstat(join(dir, name)).catch(() => null)
    const id = identityOf(info)
    if (id) ids.add(id)
  }
  return ids
}

/** 这个名字在磁盘上是不是某个保留名的另一个名字（8.3 短名 / 硬链接）。 */
export async function shadowsReserved(full, dir = MEMORY_DIR) {
  const ids = await reservedIdentitySet(dir)
  if (!ids.size) return false
  const info = await lstat(full).catch(() => null)
  const id = identityOf(info)
  return id !== null && ids.has(id)
}

/**
 * 子目录闸门：`archive/` 这类**插件自己管理的目录**必须是真目录，不能是指向别处的联接。
 *
 * ⚠️ 只对 `archive/` 这类子目录用，**不**对记忆目录本身用：把 `SAGE_MEM_DIR` 指向一个
 * 链接目录（例如网盘同步目录）是正当用法，拦掉它属于误伤。而 `archive/` 是归档动作的
 * 落地处 —— 它若是联接，归档就等于把记忆搬出记忆目录，恢复则可能把外部文件搬进来。
 *
 * @returns {Promise<{ok:true}|{ok:false,code:string,error:string}>}
 */
export async function inspectDir(dir) {
  let info
  try {
    info = await lstat(dir)
  } catch (err) {
    return {
      ok: false,
      code: err?.code === 'ENOENT' ? 'missing' : 'stat-failed',
      error: `读不到目录属性（${err?.code ?? err}）`,
    }
  }
  if (info.isSymbolicLink()) return { ok: false, code: 'symlink', error: '是指向别处的符号链接 / 目录联接' }
  if (!info.isDirectory()) return { ok: false, code: 'not-dir', error: '不是目录' }
  return { ok: true }
}

/**
 * 进程内扫描缓存，**按目录分账**。
 *
 * 为什么按目录分：`scanMemoryFiles` 用的是模块级 `MEMORY_DIR`，但「扫一个目录」这件事本身
 * 与目录无关（`scanMemoryDir` 允许显式给一个）。两个目录的失效信号、文件名集合、文件内容
 * 都不该互相污染 —— 与 D18「台账跟着它依据的目录走」同一条道理。串了账的缓存比没有缓存
 * 更危险：它会拿 A 目录的内容去回答关于 B 目录的问题。
 *
 * 每条：`{generation, watcher, entry}`
 *   - `generation` —— watcher 送来的失效信号计数，只增不减。
 *   - `watcher`    —— `createDirWatcher` 的句柄；**`ok === false` 时一律不缓存**。
 *   - `entry`      —— `{generation, namesKey, files}`，命中要同时满足代次相同与文件名集合相同。
 */
const scanStates = new Map()

/** 目录名集合的指纹：排序后拼接。新增 / 删除 / 重命名都会换指纹。 */
function namesKeyOf(names) {
  return [...names].sort().join('\n')
}

/** 取（必要时建）某个目录的缓存账与它的失效信号源。 */
function scanStateOf(dir) {
  let st = scanStates.get(dir)
  if (!st) {
    st = { generation: 0, watcher: null, entry: null }
    scanStates.set(dir, st)
  }
  /**
   * watcher 起不来时**每轮再试一次**，而不是永久禁用：记忆目录可能在插件加载时还不存在
   * （首扫落空）、之后才被建出来，永久禁用会让这一整个进程都拿不到加速。失败一次的代价
   * 只是一次系统调用级的失败（相对全量扫描可忽略）。
   */
  if (!st.watcher || !st.watcher.ok) {
    if (st.watcher) st.watcher.dispose()
    /**
     * 换失效信号源时把缓存一起丢掉。旧 watcher 死掉（报错 / 洪流哨兵）这件事本身说明
     * 「它最后一次送信号之后的这段时间里目录可能变过」，留着旧条目就是拿一段无据可依的
     * 历史继续供内容。代价只是多一次全扫，而换 watcher 是罕见事件。
     */
    st.entry = null
    // 失效信号只做一件事：代次 +1。去抖在 watcher 内部完成（首个事件立刻、窗口末尾再一次）。
    st.watcher = createDirWatcher(dir, () => {
      st.generation++
    })
  }
  return st
}

/**
 * 扫 memory 目录，读回全部记忆文件（跳过索引与子目录），并解析 frontmatter 摘要。
 *
 * A2 之后本函数**可能命中进程内缓存**：目录真的没变时，直接把上一次的结果还给你，
 * 一份文件都不打开。失效判据与残余风险见 `scanMemoryDir`。
 */
export async function scanMemoryFiles(ctx, sessionId) {
  return scanMemoryDir(ctx, sessionId, MEMORY_DIR)
}

/**
 * 同 `scanMemoryFiles`，但目录可显式给（缓存按目录分账；测试用它证明两个目录不互相污染）。
 *
 * 失效判据**两层**，缺一不可：
 *   1. **主判据 —— watcher 代次**：目录里发生过事件就重扫。它也是「只改内容、不改名」这类
 *      变更**唯一**的失效来源 —— 文件名集合看不出内容变没变。
 *   2. **兜底判据 —— 文件名集合**：每次仍做一次 `readdir`（1000 份实测 0.7 ms）比集合。
 *      它防的是 watcher 最可能漏的那一类：**新增 / 删除 / 重命名**（漏事件时它仍然准确）。
 *
 * ⚠️ **残余风险（有意的取舍，不是疏忽）**：watcher 漏掉「只改内容、不改文件名」的事件时，
 * 本进程会继续供旧内容，直到下一次任何失效。为什么接受：想独立复核内容变没变，只能逐份
 * `lstat` 比 mtime，而那是这次要省掉的主要成本（1000 份实测 83 ms）—— 要复核就等于放弃加速。
 * 后果是**一次注入拿到旧内容**，不是永久错误：文件一旦被增 / 删 / 改名，兜底判据立刻恢复正确，
 * 下一次侥幸收到的事件也会。漏事件概率主要落在「外部程序原地覆写文件」这类姿势上：
 * 插件自己的写入路径（设置页 / 工具）走的是原子写（临时名 + rename），必然触发事件。
 *
 * watcher 不可用（起不来 / 报错）时**一律全扫**，与加缓存之前逐字一致 —— 拿不到失效信号
 * 就不许缓存，这是这条优化的安全底线。
 */
export async function scanMemoryDir(ctx, sessionId, dir = MEMORY_DIR) {
  const st = scanStateOf(dir)
  // ── 命中检查：代次 + 文件名集合，两道都对上才算「目录真的没变」──
  if (st.watcher.ok && st.entry) {
    const g0 = st.generation
    if (st.entry.generation === g0) {
      const names = await readdir(dir).catch(() => null)
      /**
       * 校验期间若又来了事件（代次变了）就当没命中。与落缓存时同一条理由：我无法证明
       * 「刚读到的这份指纹」与「刚比过的那份缓存」描述的是同一瞬间的那个目录。
       */
      if (names && namesKeyOf(names) === st.entry.namesKey && st.generation === g0) {
        // 还一个新数组：缓存是共享的，调用方就地排序 / splice 不该改到别人的那一份。
        return st.entry.files.slice()
      }
    }
  }
  // ── 未命中：全扫（与加缓存之前逐字一致），只在「扫描期间没有任何变更」时才落缓存 ──
  const gStart = st.generation
  const scanned = await fullScanMemoryDir(ctx, sessionId, dir)
  const gEnd = st.generation
  st.entry = null
  /**
   * 连目录都列不出来（不存在 / 无权限）→ 这个失效信号源已经不可信，就地关掉。
   * 为什么必须这么干：句柄在目录消失后会变成**空转的**（每秒十几万个 'change'，
   * 且不发 'error'，见 watch.js 的洪流哨兵）—— 主动关掉比等哨兵兜底更早、也更直白。
   * 关掉之后下一轮扫描会重新起表：目录回来了就继续用，回不来就是 fs.watch 抛错 → 全扫。
   */
  if (scanned.namesKey === null && st.watcher) {
    st.watcher.dispose()
    st.watcher = null
  }
  if (st.watcher && st.watcher.ok && scanned.namesKey !== null && gStart === gEnd) {
    st.entry = { generation: gEnd, namesKey: scanned.namesKey, files: scanned.files }
  }
  // 也还新数组：上面刚把同一份引用存进了缓存，交出去就等于把缓存的所有权给了调用方。
  return scanned.files.slice()
}

/**
 * 真的走一遍磁盘。返回 `{files, namesKey}`。
 *
 * `namesKey === null` 表示目录根本没列出来（不存在 / 无权限）→ 这一轮**不落缓存**：
 * 把一次失败当成「目录是空的」存下来，会让之后每一次读取都命中这份假结果。
 */
async function fullScanMemoryDir(ctx, sessionId, dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    // 目录名集合的指纹：作为缓存的**兜底判据**（watcher 漏掉增 / 删 / 改名时的第二道闸）。
    const namesKey = namesKeyOf(entries.map(e => e.name))
    /** 保留名的文件身份：8.3 短名与硬链接都得靠它才认得出（名字文本上它们毫无关系）。 */
    const reservedIds = await reservedIdentitySet(dir)
    /**
     * 链接条目在 `isFile()` 这一步就被滤掉了（`readdir` 的 Dirent 报的是链接本身），
     * 也就是说**闸门根本没机会看到它们** —— 不在这里出声，用户只会看到「这条记忆不见了」。
     */
    for (const e of entries) {
      if (e.isSymbolicLink() && /\.md$/i.test(e.name)) {
        warnLog(ctx, `skip ${e.name}: 是指向别处的符号链接 / 目录联接`, sessionId)
      }
    }
    const names = entries
      .filter(e => e.isFile() && isMemoryEntry(e.name))
      .map(e => e.name)
    const loaded = await Promise.all(names.map(async (name) => {
      const full = join(dir, name)
      // 先过闸门（lstat + 体积），再读：链接与超大文件都在**全量读之前**被挡下，
      // 而不是读进来之后才发现不该读。mtime 由闸门一并给出，比原来少一跳 stat。
      const gate = await inspectMemoryEntry(full)
      /**
       * 8.3 短名 / 硬链接都可能是「保留名的另一个名字」：`MEMORY~1.MD` 与 `MEMORY.md`
       * 文本上毫无关系，inode 却是同一个。不按身份拦，索引就会以普通记忆的身份被读进上下文。
       */
      if (gate.ok && gate.id && reservedIds.has(gate.id)) {
        warnLog(ctx, `skip ${name}: 这是某个保留名（索引 / 流水）的另一个名字，不当记忆读`, sessionId)
        return null
      }
      // 硬链接**不拦**（见 inspectMemoryEntry 的取舍），但要让用户知道内容可能被外部改到。
      if (gate.ok && gate.links > 1) {
        warnLog(ctx, `note ${name}: 有 ${gate.links} 个硬链接名，内容可能被记忆目录之外改到`, sessionId)
      }
      if (!gate.ok) {
        warnLog(ctx, `skip ${name}: ${gate.error}`, sessionId)
        return null
      }
      try {
        const content = await readVerified(full, gate, 'utf8')
        const meta = parseFrontmatter(content)
        return {
          file: name,
          content,
          description: meta.description || '',
          aliases: meta.aliases || [],
          baseline: parseBaseline(content),
          baselinePriority: meta.baselinePriority || 0,
          // 新鲜度的两个来源：frontmatter 的 updated（权威）与文件 mtime（退路）。
          updated: meta.updated || '',
          /**
           * 有效性三字段（2.0.0）：与 description / aliases 同一处带出 —— 记录形状只在这里
           * 组装一次，注入链 / 面板 / 审计都从这份记录读。平铺而不是嵌套，是为了让
           * `validity.js` 的判据只依赖 `f.invalidAt` 一个路径（同一形状少一层解构）。
           *
           * 缺失一律空串（R1）：三字段全缺时这条记录与 1.9.2 逐字相同 —— 老记忆的
           * 「仍有效、时间未知」不是靠下游特判，而是靠这里没有多出任何真值。
           * 坏格式也原样带出，不在这里判（R2）；判据只有 validity.js 一份。
           */
          validAt: meta.validAt || '',
          invalidAt: meta.invalidAt || '',
          supersededBy: meta.supersededBy || '',
          mtimeMs: gate.mtimeMs,
        }
      } catch (err) {
        // 只有 ENOENT 是正常状态（扫到读之间被删）。其余——权限错、编码坏、盘掉线——
        // 一律出声：这里的静默化就是把「记忆不再注入」变成无声事故的那一手。
        if (err?.code !== 'ENOENT') warnLog(ctx, `cannot read ${name}: ${err?.message ?? err}`, sessionId)
        return null
      }
    }))
    return { files: loaded.filter(Boolean), namesKey }
  } catch (err) {
    if (err?.code !== 'ENOENT') warnLog(ctx, `cannot scan ${dir}: ${err?.message ?? err}`, sessionId)
    return { files: [], namesKey: null }
  }
}

/** 提取正文第一个 `# ` 标题作为展示标题。 */
export function extractTitle(content) {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---/)
  const body = m ? content.slice(m[0].length) : content
  const h1 = body.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : ''
}

/** 扫一个目录，读回星图要的轻量元数据（正文 + 体积 + 修改时间）。 */
async function readStarDir(dir, ctx, opts = {}) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err?.code !== 'ENOENT') warnLog(ctx, `cannot scan ${dir}: ${err?.message ?? err}`)
    return []
  }
  const names = entries
    .filter(e => e.isFile() && isMemoryEntry(e.name))
    .map(e => e.name)
  const reservedIds = await reservedIdentitySet()
  const loaded = await Promise.all(names.map(async (name) => {
    const full = join(dir, name)
    const gate = await inspectMemoryEntry(full, opts)
    if (!gate.ok) {
      warnLog(ctx, `skip ${full}: ${gate.error}`)
      return null
    }
    // 星图同样不显示「保留名的另一个名字」（8.3 短名 / 硬链接）。
    if (gate.id && reservedIds.has(gate.id)) {
      warnLog(ctx, `skip ${full}: 这是某个保留名（索引 / 流水）的另一个名字`)
      return null
    }
    try {
      const content = await readVerified(full, gate, 'utf8')
      return { name, content, bytes: gate.size, mtimeMs: gate.mtimeMs }
    } catch (err) {
      if (err?.code !== 'ENOENT') warnLog(ctx, `cannot read ${full}: ${err?.message ?? err}`)
      return null
    }
  }))
  return loaded.filter(Boolean)
}

/**
 * 扫归档区 `memory/archive/`。返回形状与 `readStarDir` 一致（多了 `archived: true`）。
 * 归档区不存在是正常状态（没人归档过）→ 空数组，不是错误。
 */
export async function scanArchived(ctx) {
  // 归档区是**插件自己建的子目录**，必须过目录闸门：它若被换成指向外部的联接，
  // 「归档 = 搬进 archive/」就变成「把记忆搬出记忆目录」。
  const gate = await inspectDir(MEMORY_ARCHIVE_DIR)
  if (!gate.ok) {
    // ENOENT 是正常状态（还没人归档过）→ 空数组；其余一律出声，绝不静默当成「没有归档」。
    if (gate.code !== 'missing') warnLog(ctx, `归档区不可用，跳过：${gate.error}`)
    return []
  }
  /**
   * ⚠️ 归档区**不判体积**（`limitBytes: null`）：归档是「把这条记忆收起来」，
   * 不是「新写一条记忆」—— 拿活动记忆的上限去卡归档区，会造出「能归档、列不出、
   * 读不回」的半死状态（实测：600 KB 的记忆归档成功，却从馆里消失、又还能被覆盖）。
   * 形状闸门（symlink）照旧生效。
   */
  const rows = await readStarDir(MEMORY_ARCHIVE_DIR, ctx, { limitBytes: null })
  return rows.map(f => ({ ...f, archived: true }))
}

/**
 * 扫记忆目录，读全部 .md（跳过索引与 session-log），带体积与修改时间。
 *
 * @param {boolean} [includeArchived] — 带上归档区的条目（默认不带：星图默认只看活着的）
 */
export async function scanStars(ctx, includeArchived = false) {
  const active = (await readStarDir(MEMORY_DIR, ctx)).map(f => ({ ...f, archived: false }))
  if (includeArchived !== true) return active
  return [...active, ...(await scanArchived(ctx))]
}
