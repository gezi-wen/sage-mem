/**
 * sage-mem 记忆层 —— 工具调用观测：这一次调用是不是在读记忆目录。
 *
 * 宿主的 `tools/result` 会把**每一次**工具调用的 `exec`（含 `name` 与 `arguments`）交给我们，
 * 于是「模型自己用内置工具翻了记忆」这件事第一次能被记进台账（0.9.16 之前只能记「注入过什么」）。
 * 本模块只做**判定**：写台账是 access.js 的事 —— 这里不落盘、不看时钟、不 stat。
 *
 * ## 三条边界（都是「宁可漏记，绝不误记」）
 *
 * 1. **只认能可靠判定的形状。**
 *    `read` 的 `file_path`、`grep` / `glob` 的 `path` 是结构化参数，能可靠判定；而 `pwsh` 的
 *    `command` 是一段程序 —— `cat 某记忆`、`Get-Content`、`type`、`Select-String`、变量拼接、
 *    管道、重定向……认不全。认一半的代价是把「读的是别的东西」记成「读了记忆」，所以执行类
 *    工具一律 `kind:'unobservable'`：**这是已知观测盲区，不是「这一步没有读取」**。
 *    同理不猜的还有：`grep` / `glob` 缺 `path` 时不拿 `pattern` 反推目录（pattern 里可以有
 *    `*` / `{a,b}` / `**`）；`read` 拿到相对路径时不猜 cwd（cwd 是运行时状态，纯函数看不到）。
 *
 * 2. **`atime` 永远不许当证据。** 索引器、备份程序、挂载选项都会改它，它既不等于「模型读过」，
 *    也不等于「用户用过」。本模块只用传进来的参数判定，一个文件系统调用都不发。
 *
 * 3. **路径判定与平台无关。** `\` 在 Windows 是分隔符、在 Linux 只是普通字符：同一份输入在
 *    两个平台上会被 `path` 的默认语义解析成不同目录（`naming.js` 的 `safeName` 刚被 Linux CI
 *    用同一类缺陷抓过一次）。所以这里**不用** `path.resolve` / `path.relative` / `path.sep`，
 *    按下面这套固定规则自己归一 —— 语义只由规则决定，不由运行平台决定。
 *
 * ## 归一规则（两个平台完全一致，实现见 canonicalPathOf）
 *
 * - 只接受**绝对路径**（`/…`、`//server/share…`、`X:/…`）；相对路径不认。
 * - `\` 与 `/` **一律**当分隔符（显式同时处理两者，而不是交给 `path.sep`）。
 * - 折叠 `.`、连续分隔符，逐段回退 `..`（绝对路径在根上的 `..` 是空操作）。
 * - 盘符统一小写；其余部分**大小写敏感**。NTFS 不敏感、ext4 敏感 —— 取交集（敏感）只会漏记，
 *   取并集（不敏感）会误记，观测层宁可漏记。
 * - 包含关系按**段边界**判定（父目录 + 分隔符），所以 `记忆目录-evil/x.md` 不会被当成
 *   `记忆目录/x.md` —— 字符串前缀比较的经典错。
 *
 * ## 已知残留边界（写清楚，不假装没有）
 *
 * - POSIX 上 `\` 可以是文件名里的普通字符，本模块把它当分隔符：那种畸形名字可能被归到隔壁。
 *   方向只会是**漏记**（或把一个本来就在目录内的名字算成目录内的另一个名字），且 `safeName`
 *   本来就禁止记忆条目名里出现 `\`。
 * - 符号链接 / 8.3 短名 / 目录联接不做解析（纯函数不读盘）。路径里先有指向外部的链接时，
 *   `link/../x` 这类写法按字面归一 —— 这是观测层能做到的上限，宁可少记。
 *
 * ## 字段口径
 *
 * - `file` = **记忆文件名**，不是路径。与 `scanMemoryFiles` / `hits[].file` / 台账
 *   `access.json` 的键同一口径：调用方拿到就能直接进 `accessEventKey` 与 `recordAccess`，
 *   不必再 basename 一次 —— 每多一次转换就多一个「键域搞错」的机会（D18 就是这么来的）。
 * - `dir` = **规范化后的绝对路径**，只在「值指向记忆目录里的一个目录（含记忆目录本身）」时给出。
 */

// 路径身份判据**抽到 paths.js 共用**：写入门（write-gate.js）要回答同一个问题
// 「这个路径在不在记忆目录里」。两处各写一份迟早漂成两套判据，而漂移的后果不是报错，
// 是「看起来很勤快、实际判错了对象」。注意 paths.js 同样不依赖 node:path。
import { canonicalPathOf, isSameOrInside, fileNameOf, isRootLike } from './paths.js'

/** 认得的读工具 → 取路径的参数名。表是**数据**：调用方与测试都直接读它，不写第二份分支。 */
export const READ_TOOLS = Object.freeze({ read: 'file_path', grep: 'path', glob: 'path' })

/** 判为「写」的工具。列出来是为了可解释：它们改记忆，不是读记忆。 */
export const WRITE_TOOLS = Object.freeze(['write', 'edit'])

/**
 * 判为「看不见」的工具。
 *
 * 单列出来就是为了可解释：台账里出现 `unobservable` 才说明「这一步**可能**有读取但我们没记」，
 * 而不是「这一步没有读取」。两者的区别决定了排查方向。
 */
export const UNOBSERVABLE_TOOLS = Object.freeze(['pwsh', 'bash', 'shell'])

/**
 * 记忆条目一律是 `.md`（`naming.js` 的唯一判据）。这里**不** import `isMemoryEntry`：
 * 观测层判的是「这次调用碰的是不是记忆文件」，不该跟着扫描层的排除名单（索引 / 流水）一起变
 * —— 读 `MEMORY.md` 同样是读了记忆目录，该不该记进台账由调用方决定。
 */
const MEMORY_FILE_RE = /\.md$/i

/** 写工具取路径的参数名（读工具的对应项在 READ_TOOLS 里）。 */
const WRITE_PATH_ARG = 'file_path'

/** 只有这两种事件有「哪个文件」这个键，才进得了以文件名为键的台账。 */
const RECORDABLE_KINDS = new Set(['active_read', 'write'])

/** 结果工厂：保证四个字段恒在，调用方不必到处判 undefined。 */
function verdict(kind, why) {
  return { kind, file: null, dir: null, why }
}

/** 安全取参：参数不是对象就当作没给；getter 抛错由 classifyToolExecution 的外层兜住。 */
function argOf(args, key) {
  if (!args || typeof args !== 'object') return undefined
  return args[key]
}

/** 写工具：是写就不是读，但仍要如实说出「写的是不是记忆文件」。 */
function classifyWrite(args, memoryDir) {
  const canon = canonicalPathOf(argOf(args, WRITE_PATH_ARG))
  if (!memoryDir) return verdict('write', '写操作；记忆目录不可判定，不判断是否落在记忆里')
  if (!canon) return verdict('write', '写操作；没有可判定的绝对文件路径')
  if (!isSameOrInside(memoryDir, canon)) return verdict('write', '写操作，但目标不在记忆目录内')
  if (!MEMORY_FILE_RE.test(canon)) return verdict('write', '写操作，目标在记忆目录内但不是 .md 记忆条目')
  return { kind: 'write', file: fileNameOf(canon), dir: null, why: '写记忆文件（不是读取）' }
}

/**
 * 读工具（`read` / `grep` / `glob`）。
 *
 * `grep` / `glob` 的 `path` 既可能是目录也可能是文件，纯函数不 stat，所以按**值的形状**分：
 * `.md` 结尾当文件（仓库里记忆条目一律 `.md`），否则当目录。`read` 按语义必须落在文件上，
 * 非 `.md` 一律不认。
 */
function classifyRead(toolName, args, memoryDir) {
  const argName = READ_TOOLS[toolName]
  const raw = argOf(args, argName)
  if (typeof raw !== 'string' || raw === '') {
    return verdict('other', `没有可用的 ${argName} 字符串，不猜这次读的是哪`)
  }
  const canon = canonicalPathOf(raw)
  if (!canon) {
    return verdict('other', '不是绝对路径（相对路径的基准是运行时的 cwd，纯函数看不到），不猜')
  }
  if (!isSameOrInside(memoryDir, canon)) return verdict('other', '路径不在记忆目录内')

  if (toolName === 'read') {
    if (!MEMORY_FILE_RE.test(canon)) return verdict('other', '在记忆目录内，但不是 .md 记忆条目')
    return { kind: 'active_read', file: fileNameOf(canon), dir: null, why: '读了记忆目录里的记忆文件' }
  }
  // glob 只列清单（不算读正文）；grep 会读正文，所以是 active_read。两者都不刷「读了多少」，
  // 交给台账按文件名去重。
  const kind = toolName === 'glob' ? 'list_only' : 'active_read'
  if (MEMORY_FILE_RE.test(canon)) {
    return {
      kind,
      file: fileNameOf(canon),
      dir: null,
      why: toolName === 'glob' ? '列了记忆目录里的一个文件（只列清单，不算读正文）' : '在记忆目录里按模式检索这个文件',
    }
  }
  return {
    kind,
    file: null,
    dir: canon,
    why: toolName === 'glob' ? '列了记忆目录（只列清单，不算读正文）' : '在记忆目录里按模式检索（读的是记忆正文）',
  }
}

/**
 * 判定一次工具调用。**纯函数**：不读盘、不看时钟、不抛。
 *
 * @param {string} toolName
 * @param {object} args — 原始 arguments
 * @param {string} memoryDir — 记忆根目录（绝对路径）
 * @returns {{kind:'active_read'|'list_only'|'write'|'unobservable'|'other',
 *            file:string|null, dir:string|null, why:string}}
 *   `file`（记忆文件名）只在确实指向记忆目录里的一个记忆文件时给出；`dir`（规范绝对路径）只在
 *   其值指向记忆目录里的一个目录（含记忆目录本身）时给出。**指向别处的路径一律不认**
 *   （`kind:'other'`）—— 观测层不许把「读了别的东西」记成「读了记忆」。
 */
export function classifyToolExecution(toolName, args, memoryDir) {
  try {
    const name = typeof toolName === 'string' ? toolName : ''
    if (!name) return verdict('other', '工具名缺失或不合法，不猜')

    // 看不见的工具先判：它和参数能不能解析无关 —— 「我们看不见」本身就是结论。
    if (UNOBSERVABLE_TOOLS.includes(name)) {
      return verdict('unobservable', `${name} 的命令行无法可靠认出读了哪个文件 —— 已知观测盲区，不是「没有读取」`)
    }

    const dir = canonicalPathOf(memoryDir)
    // 相对 / 空的记忆目录不猜（猜了就是拿一个不知道的基准做包含判定）；根目录拒掉的原因见 isRootLike。
    const usableDir = dir && !isRootLike(dir) ? dir : null

    if (WRITE_TOOLS.includes(name)) return classifyWrite(args, usableDir)

    if (Object.prototype.hasOwnProperty.call(READ_TOOLS, name)) {
      if (!usableDir) {
        return verdict('other', dir ? '记忆目录是根目录，用它判定会把整块盘算成记忆，不判' : '记忆目录不可判定（不是绝对路径），不判')
      }
      return classifyRead(name, args, usableDir)
    }

    return verdict('other', `不认得的工具（${name}），不猜它的参数形状`)
  } catch {
    // 观测层是**顺带**记一笔，绝不许有能力把调用方拖下水：任何意外都退化成「没看见」。
    return verdict('other', '判定过程出错，按不认处理')
  }
}

/**
 * 去重键：同一 session × 文件 × revision × kind 只算一次。
 *
 * 翻页（`read` 的 `offset` / `limit` 不同）不在这里出现 —— 它们根本不在入参里，所以
 * 「翻页不刷计数」是**结构上**成立的，不靠调用方自觉。换了 revision 就是另一份内容，
 * 要重新计一次。
 *
 * ⚠️ **它不是台账键**：台账 `access.json` 的键是文件名，这个键是四元组。别混用。
 *
 * @returns {string|null} null = 不该记（没有文件，或者不是一次访问事件）
 */
export function accessEventKey(input = {}) {
  const a = input && typeof input === 'object' ? input : {}
  const file = typeof a.file === 'string' ? a.file : ''
  if (file === '') return null
  if (!RECORDABLE_KINDS.has(a.kind)) return null
  // 缺 session 时退化成「整个进程一个会话」的去重域：宁可少记重复的，也不因为拿不到 session
  // 就一条都不记。revision 缺失同理（空串），它有值时自然与空串区分开。
  const session = typeof a.sessionId === 'string' ? a.sessionId : ''
  const revision = typeof a.revision === 'string' ? a.revision : ''
  return `${session}\u0000${file}\u0000${revision}\u0000${a.kind}`
}

/**
 * 已经记过的键的容器（纯内存，调用方持有）。
 *
 * 为什么由调用方持有而不是模块级单例：模块级单例会在热加载 / 测试之间串味，而这个集合的
 * 生命周期本来就该等于「一场会话」。调用方拿同一份实例跑完会话，`clear()` 就能重来。
 */
export function createDeduper() {
  const seen = new Set()
  return {
    /** @returns {boolean} true = 这次该记（第一次见到这个键） */
    shouldCount(key) {
      if (typeof key !== 'string' || key === '') return false
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
    get size() {
      return seen.size
    },
    clear() {
      seen.clear()
    },
  }
}
