/**
 * sage-mem 记忆层 —— 冲突队列（`<状态根>/conflicts/<id>.json`）。
 *
 * 为什么要有这一层：宿主的文件写入是**原子**的、而且带版本守卫 —— 版本过期会抛
 * `FS_STALE_VERSION`。所以「冲突」不需要我们去比内容差异，宿主已经把「谁的版本旧了」
 * 告诉调用方了。我们要做的只有一件事：**把这次失败从「一个报错」变成「一条待判定的记录」**，
 * 这样用户能在面板上看到「有 N 条冲突等你处理」，而不是让一次静默覆盖把别人的改动吃掉。
 *
 * ⚠️ **本模块不做任何自动裁决**。保留磁盘那份 / 保留我的 / 手工合并 —— 由**人**决定，
 * 插件不猜（自动合并冲突留到 1.0.0 之后）。所以这里只有五个动作：
 * 落记录（buildConflict / writeConflict）、读一条（readConflict）、列全部（listConflicts）、
 * 标记状态（resolveConflict）、删除（removeConflict）。**不要在这里加「聪明」的合并逻辑。**
 *
 * ⚠️ **冲突正文是用户的记忆内容，本模块永不把它写进日志/控制台**：进终端就等于进日志，
 * 而这份记录里放的是两份正文。所以本模块**一处 console 都没有**，失败一律用返回值表达。
 *
 * 并发：同一个 id 的并发写由**调用方串行**（进程内用 `util.js` 的 `createWriteQueue`）；
 * 不同 id 互不影响（一个 id 一个文件）。本模块自己只保证每次写是原子的。
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATE_ROOT } from './config.js'
import { writeFileAtomic } from './util.js'

/** 冲突记录都放在状态根的这个子目录下。 */
export const CONFLICTS_DIR_NAME = 'conflicts'

/** 一条冲突一个文件。 */
export const CONFLICT_FILE_SUFFIX = '.json'

/**
 * 冲突的种类。`stale_version` 是宿主版本守卫直接报出来的那种（最常见）；
 * `external_change` 是文件在别处被改了；`unresolved_merge` 是人工合并到一半留下的。
 */
export const CONFLICT_KINDS = Object.freeze(['stale_version', 'external_change', 'unresolved_merge'])

/**
 * 记录的状态。`open` 是唯一「待处理」的状态；另外两种都是人的判断结果，
 * 区别只在语义（`resolved` = 处理过了，`dismissed` = 看过、决定不管）。
 */
export const CONFLICT_STATUSES = Object.freeze(['open', 'resolved', 'dismissed'])

/**
 * 单份冲突记录的体积上限（字节）。
 *
 * 定 256 KB：一份记录里要放**两份**正文（我的版本 + 磁盘上的版本），所以它天生比记忆大；
 * 但再大就不该整份塞进上下文了 —— 到量说明该人工合并，而不是把两份都留着。
 */
export const CONFLICT_MAX_BYTES = 256 * 1024

/**
 * 各字段的单字段字节上限（**数据表**而不是散落的魔法数：面板与文档要能展示凭什么是这个数）。
 *
 * 为什么要「上限之外另有一条」：整个记录的上限（256 KB）管不住**一个字段**把预算吃光 ——
 * 一份 200 KB 的 `incoming` 能挤掉 `onDisk`，而后者恰恰是判定冲突时最需要对照的那份。
 * 所以两个正文字段各自先卡 48 KB（两份共 96 KB，还有一半留给元信息与 JSON 转义），
 * 小字段给到只够装下它们的量级。超了就**截断头部**并置 `truncated: true`。
 */
export const CONFLICT_FIELD_LIMITS = Object.freeze({
  incoming: 48 * 1024,
  onDisk: 48 * 1024,
  file: 1024,
  note: 4096,
  tool: 256,
  version: 256,
})

/**
 * 状态机（**数据**，不是 if 链：面板要能显示「这一步能不能点」，断言也要能逐条核对）。
 *
 * `open → resolved` / `open → dismissed` / `resolved ↔ dismissed` 允许；
 * **不许从 `resolved`/`dismissed` 回到 `open`** —— 那等于把一条已经做过判断的记录
 * 悄悄复活成「待处理」，而判断的理由不在记录里，复活后没人知道当初为什么关掉它。
 * 要重开就新建一条（带上新的证据）。
 */
export const CONFLICT_TRANSITIONS = Object.freeze({
  open: Object.freeze(['resolved', 'dismissed']),
  resolved: Object.freeze(['dismissed']),
  dismissed: Object.freeze(['resolved']),
})

/**
 * 冲突 id 允许的字符集：单段、`[A-Za-z0-9-]`、1..64 字符。
 *
 * 字符集里**根本没有** `.`、`/`、`\`、`:` —— 前三个是路径语义（`.` 的尾随形态还会被 Windows
 * 静默吃掉），`:` 在 NTFS 上是交替数据流的分隔符。判定走纯字符类、**不走 `path.basename`**：
 * `\` 在 Windows 是分隔符、在 Linux 只是普通字符，用平台 API 判会得出「同一份输入在两个平台上
 * 合法性相反」的结论（本仓库刚被 Linux CI 抓过同类缺陷）。这里的判据两个平台逐字一致。
 */
const CONFLICT_ID_RE = /^[A-Za-z0-9-]{1,64}$/

/**
 * Windows 保留设备名：`conflicts/CON.json` 在这个平台上**建不出来**（设备名带扩展名同样保留），
 * Linux 上完全正常 —— 同一份状态目录同步过去就会「在那边能写、在这边写不了」。
 *
 * 同一份判据 `checkpoint.js` 里也有一份：两个模块各守自己的 id 空间，为此去动 `lib/` 加一个
 * 共享文件等于引入跨模块耦合，而表本身很小 —— 重复比耦合便宜。
 */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/**
 * 冲突 id 归一：合法原样返回，非法返回 null。
 *
 * 只收字符串，也不 trim：路径两端的空格在 Windows 上会被静默裁掉、在 Linux 上不会，
 * 「帮忙归一化」本身就会造出两个平台指向不同文件的输入。
 */
export function normalizeConflictId(raw) {
  if (typeof raw !== 'string') return null
  if (!CONFLICT_ID_RE.test(raw)) return null
  // 纯点号（`.` / `..`）与尾随点在这里已经被字符集挡掉了（字符集不含 `.`），
  // 但下面这条**设备名**判据必须在：`con` / `com1` 全是合法字符，却是 Windows 的保留名。
  if (WINDOWS_RESERVED.has(raw.toLowerCase())) return null
  return raw
}

/** stateRoot 的归一：非空字符串才用，否则回落 config.js 的 STATE_ROOT。 */
function rootOf(stateRoot) {
  return typeof stateRoot === 'string' && stateRoot !== '' ? stateRoot : STATE_ROOT
}

/** 冲突目录。 */
function conflictsDir(stateRoot) {
  return join(rootOf(stateRoot), CONFLICTS_DIR_NAME)
}

/** 一条冲突的文件路径；调用方必须先过 `normalizeConflictId`。 */
function conflictPathFor(id, stateRoot) {
  return join(conflictsDir(stateRoot), `${id}${CONFLICT_FILE_SUFFIX}`)
}

/**
 * 按**码点**截断到不超过 maxBytes 字节。
 *
 * 不能按字符数截（`s.slice(0, N)`）：一个汉字 3 字节，按字符截出来的东西是预算的三倍，
 * 闸门等于没设。也不能按字节硬切：那会把一个码点切成半个，注入 / 面板上显示成 U+FFFD。
 */
function truncateByBytes(s, maxBytes) {
  const text = String(s ?? '')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (used + b > maxBytes) break
    out += ch
    used += b
  }
  return out
}

/** 单字段限长。非字符串按「缺」处理（不去猜一个对象 / Buffer 的内容）。 */
function clampText(value, limit) {
  if (typeof value !== 'string') return { text: '', cut: false }
  if (Buffer.byteLength(value, 'utf8') <= limit) return { text: value, cut: false }
  return { text: truncateByBytes(value, limit), cut: true }
}

/** 版本号一律当字符串用（`undefined` / `null` = 没有这个版本，不是字符串 "null"）。 */
function versionText(value) {
  return value === undefined || value === null ? '' : String(value)
}

/** 时间戳归一：认得出才用，认不出就是空串（**不编一个时间**）。 */
function normalizeAt(raw) {
  if (typeof raw !== 'string' || raw === '') return ''
  return Number.isFinite(Date.parse(raw)) ? raw : ''
}

/** 把时间戳压成 id 里能用的紧凑形态：`2026-10-15T19:47:54.000Z` → `20261015T194754Z`。 */
function compactStamp(at) {
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 内容指纹（8 位十六进制）。
 *
 * 这里**刻意不用随机数**，虽然接口注释写的是「时间戳 + 短随机」：
 *   1. 随机数会让「同输入两次结果一致」不成立 —— 一个从「写失败」造记录的纯函数不该读随机源；
 *   2. 指纹还有个更好的性质：**同一条冲突被重复上报时 id 相同**，队列里不会长出重复项。
 * 指纹取的是「这次冲突是什么」的字段（种类 / 文件 / 两个版本 / 两份正文），不含 `note` / `tool`
 * 这类关于「谁在什么时候碰上的」的元信息 —— 换一次说明不该变成另一条冲突。
 */
function shortDigest(parts) {
  const canonical = parts.map((p) => String(p ?? '')).join('\u0000')
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 8)
}

/**
 * 从「一次写失败」造一条记录（**纯函数**：不落盘、不读时钟、不掷随机数）。
 *
 * 时间与 id 从输入来：`at` 给定了就是逐字确定、可重放的结果；不给 `at` 就是空串
 * （id 也就没有时间戳前缀）。**不自己读时钟**是刻意的 —— 时间是调用方的事实
 * （只有它知道这次过期发生在何时），编一个「现在」会让重放与去重都失效。
 * `id` 也可以直接传（面板要指定 id 时用），非法就按内容指纹现算。
 *
 * 截断：各字段按 `CONFLICT_FIELD_LIMITS` 卡字节，截过就置 `truncated: true`。
 *
 * @param {{kind?, file?, expectedVersion?, actualVersion?, incoming?, onDisk?, note?, tool?, at?, id?}} input
 */
export function buildConflict(input) {
  const src = input && typeof input === 'object' ? input : {}

  const at = normalizeAt(src.at)
  // 不认识的 kind **原样保留**：静默换成某个已知值等于把「未知」伪装成「已知」。
  const kind = typeof src.kind === 'string' ? src.kind : ''

  const file = clampText(src.file, CONFLICT_FIELD_LIMITS.file)
  const incoming = clampText(src.incoming, CONFLICT_FIELD_LIMITS.incoming)
  const onDisk = clampText(src.onDisk, CONFLICT_FIELD_LIMITS.onDisk)
  const note = clampText(src.note, CONFLICT_FIELD_LIMITS.note)
  const tool = clampText(src.tool, CONFLICT_FIELD_LIMITS.tool)
  const expectedVersion = clampText(versionText(src.expectedVersion), CONFLICT_FIELD_LIMITS.version)
  const actualVersion = clampText(versionText(src.actualVersion), CONFLICT_FIELD_LIMITS.version)

  const truncated =
    file.cut || incoming.cut || onDisk.cut || note.cut || tool.cut || expectedVersion.cut || actualVersion.cut

  const stamp = compactStamp(at)
  const digest = shortDigest([kind, file.text, expectedVersion.text, actualVersion.text, incoming.text, onDisk.text])
  const id = normalizeConflictId(src.id) ?? `${stamp === '' ? '' : `${stamp}-`}${digest}`

  return {
    v: 1,
    id,
    kind,
    status: 'open',
    file: file.text,
    expectedVersion: expectedVersion.text,
    actualVersion: actualVersion.text,
    at,
    incoming: incoming.text,
    onDisk: onDisk.text,
    note: note.text,
    tool: tool.text,
    truncated,
  }
}

/** 记录 → 文件正文。紧凑 JSON + 一个尾换行：状态目录是给程序读的，行数少一点更好 diff。 */
function serialize(record) {
  try {
    return `${JSON.stringify(record)}\n`
  } catch {
    // 循环引用 / BigInt 会让 JSON.stringify 抛 —— 契约要求「所有失败都返回对象」，所以在这里收住。
    return null
  }
}

/**
 * 整份记录超上限时，按字节削两个正文字段（两份都保留**头部**，只削当前最大的那份）。
 *
 * 为什么要迭代而不是一次算准：JSON 转义会让同一段文本的落盘字节数变多（引号、反斜杠、
 * 控制字符最多膨胀到 6 倍），所以「预算」只能边算边收。步数有界：每轮至少削 1 字节，
 * 削到两个字段都空还放不下就放弃（返回 null，由调用方报 too_big，绝不静默写半份）。
 */
function fitBodies(record, limit) {
  const bodyOf = (k) => (typeof record[k] === 'string' ? record[k] : '')
  const originals = [bodyOf('incoming'), bodyOf('onDisk')]
  const keep = originals.map((s) => Buffer.byteLength(s, 'utf8'))
  for (let round = 0; round < 128; round++) {
    const trial = {
      ...record,
      incoming: truncateByBytes(originals[0], keep[0]),
      onDisk: truncateByBytes(originals[1], keep[1]),
      truncated: true,
    }
    const text = serialize(trial)
    if (text === null) return null
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes <= limit) return text
    // 每轮只削**当前最大的**那个正文字段：撑爆预算的是大的那份；两份一起削会把短的那份
    // 先削没，而短的那份往往正是用户想保留的 `incoming`。两份都空了还放不下 = 放弃。
    let largest = -1
    for (let i = 0; i < keep.length; i++) {
      if (keep[i] > 0 && (largest === -1 || keep[i] > keep[largest])) largest = i
    }
    if (largest === -1) return null
    keep[largest] = Math.max(0, keep[largest] - Math.max(1, Math.ceil((bytes - limit) / 2)))
  }
  return null
}

/**
 * 落盘一条冲突记录（原子写，复用 `util.js` 的 `writeFileAtomic`）。
 *
 * ⚠️ **并发：同一个 id 由调用方串行**（进程内 `createWriteQueue`）—— 本模块不做锁，
 * 因为跨进程锁的成本与误伤面都不划算，而真实并发都发生在同一个插件进程里。不同 id
 * 各写各的文件，互不影响。
 *
 * 超 `CONFLICT_MAX_BYTES` 时**按字节截断两个正文字段**并置 `truncated: true`（而不是拒收：
 * 一条被截断的冲突记录仍然是人可以判定的，一份写不进去的记录才是真的丢了）。
 * 只有「削完正文还放不下」（元信息本身畸形地大）才报 `too_big`。
 *
 * 本函数**不校验记录的内容**（除了 id —— 路径需要它）：校验的落点在读的那一端，
 * 写路径只守体积与原子性。
 *
 * @param {object} record
 * @param {{stateRoot?: string}} [opts]
 * @returns {Promise<{ok:true, bytes:number, path:string, truncated:boolean}
 *   | {ok:false, code:'invalid'|'too_big'|'io_error', ...}>}
 */
export async function writeConflict(record, opts) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, code: 'invalid', error: '冲突记录必须是一个对象' }
  }
  const id = normalizeConflictId(record.id)
  if (id === null) return { ok: false, code: 'invalid', error: `冲突 id 非法：${JSON.stringify(record.id)}` }

  const path = conflictPathFor(id, opts && typeof opts === 'object' ? opts.stateRoot : undefined)

  let text = serialize(record)
  if (text === null) return { ok: false, code: 'invalid', error: '冲突记录无法序列化（循环引用或非法值）' }
  let truncated = record.truncated === true
  if (Buffer.byteLength(text, 'utf8') > CONFLICT_MAX_BYTES) {
    const fitted = fitBodies(record, CONFLICT_MAX_BYTES)
    if (fitted === null) {
      return {
        ok: false,
        code: 'too_big',
        bytes: Buffer.byteLength(text, 'utf8'),
        limit: CONFLICT_MAX_BYTES,
        error: `冲突记录超过 ${CONFLICT_MAX_BYTES} 字节，且削完两个正文字段仍放不下`,
      }
    }
    text = fitted
    truncated = true
  }

  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFileAtomic(path, text)
  } catch (err) {
    return { ok: false, code: 'io_error', path, error: String(err?.message ?? err) }
  }
  return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), path, truncated }
}

/**
 * 解析一条记录的正文。形状不对就报原因 —— 判据是「读不读得出这是哪条冲突」：
 * 必须有非空 `id`，`status` 必须是已知状态。`kind` 允许未知（老记录 / 别处写的记录照读）。
 */
function parseConflictText(text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch (err) {
    return { ok: false, reason: `JSON 解析失败：${err?.message ?? err}` }
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: '不是一个 JSON 对象' }
  if (typeof obj.id !== 'string' || obj.id === '') return { ok: false, reason: '缺少 id' }
  if (!CONFLICT_STATUSES.includes(obj.status)) {
    return { ok: false, reason: `status 不是已知状态：${JSON.stringify(obj.status)}` }
  }
  return { ok: true, record: obj }
}

/**
 * 读一条冲突记录。**所有失败都返回对象，绝不抛**。
 *
 * 文件名才是身份：文件里声明的 id 与文件名不一致时，以文件名为准并给出警告
 * （不静默采信标签，也不把整条记录判成坏 —— 内容还在，人还能判定）。
 *
 * @returns {Promise<{ok:true, path, bytes, record, warnings:string[]}
 *   | {ok:false, code:'invalid'|'missing'|'io_error'|'malformed', path?, error}>}
 */
export async function readConflict(id, opts) {
  const cid = normalizeConflictId(id)
  if (cid === null) return { ok: false, code: 'invalid', error: `冲突 id 非法：${JSON.stringify(id)}` }

  const path = conflictPathFor(cid, opts && typeof opts === 'object' ? opts.stateRoot : undefined)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, code: 'missing', path, error: '冲突记录不存在' }
    return { ok: false, code: 'io_error', path, error: String(err?.message ?? err) }
  }

  const parsed = parseConflictText(text)
  if (!parsed.ok) return { ok: false, code: 'malformed', path, error: parsed.reason }

  const record = { ...parsed.record, id: cid }
  const warnings = []
  if (parsed.record.id !== cid) {
    warnings.push(`文件内声明的冲突 id（${parsed.record.id}）与文件名（${cid}）不一致，已按文件名归一`)
  }
  return { ok: true, path, bytes: Buffer.byteLength(text, 'utf8'), record, warnings }
}

/** 稳定比较：不用 localeCompare（它跟 ICU 走，跨环境可能给出不同顺序）。 */
function cmp(a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * 列出全部冲突（只读目录）。
 *
 * 一个坏文件**绝不能**让整张列表打不开 —— 那等于「有一条冲突坏了，面板上什么都看不见」。
 * 所以坏文件只记名字进 `broken`，能读的照列；非 `.json` 的文件（编辑器临时文件、别的模块的垃圾）
 * 进 `ignored`，一样报告出来但不当成冲突。
 *
 * 目录不存在**不是错误**（还没发生过冲突）：返回空列表。
 *
 * @returns {Promise<{ok:true, items:Array, broken:string[], ignored:string[], dir:string}
 *   | {ok:false, code:'io_error', dir, error}>}
 */
export async function listConflicts(opts) {
  const dir = conflictsDir(opts && typeof opts === 'object' ? opts.stateRoot : undefined)
  let names
  try {
    names = await readdir(dir)
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, items: [], broken: [], ignored: [], dir }
    return { ok: false, code: 'io_error', dir, error: String(err?.message ?? err) }
  }

  const items = []
  const broken = []
  const ignored = []
  // readdir 的顺序不保证：先排序，让 broken / ignored 这两个「报告用」的数组也逐次一致。
  for (const name of [...names].sort(cmp)) {
    if (!name.endsWith(CONFLICT_FILE_SUFFIX)) {
      ignored.push(name)
      continue
    }
    const id = name.slice(0, -CONFLICT_FILE_SUFFIX.length)
    if (normalizeConflictId(id) === null) {
      broken.push(name)
      continue
    }
    let text
    try {
      text = await readFile(join(dir, name), 'utf8')
    } catch {
      broken.push(name)
      continue
    }
    const parsed = parseConflictText(text)
    if (!parsed.ok) {
      broken.push(name)
      continue
    }
    items.push({ ...parsed.record, id })
  }

  // 新的在前（队列的第一眼应该是最新那条）；没有 at 的排在后面，同档按 id 排，保证顺序确定。
  items.sort((a, b) => cmp(String(b.at ?? ''), String(a.at ?? '')) || cmp(a.id, b.id))
  return { ok: true, items, broken, ignored, dir }
}

/**
 * 改状态并落盘。
 *
 * 状态机见 `CONFLICT_TRANSITIONS`：`open` 只能去 `resolved` / `dismissed`，那两个之间可以互转，
 * **都不许回到 `open`**（要重开就新建一条）。同状态重复点是**幂等**的 —— 界面上连点两下
 * 不该报错，也不重写文件。
 *
 * @returns {Promise<{ok:true, record:object} | {ok:false, code:'invalid'|'invalid_transition'|'missing'|'malformed'|'io_error', error?}>}
 */
export async function resolveConflict(id, status, opts) {
  const cid = normalizeConflictId(id)
  if (cid === null) return { ok: false, code: 'invalid', error: `冲突 id 非法：${JSON.stringify(id)}` }
  if (!CONFLICT_STATUSES.includes(status)) {
    return { ok: false, code: 'invalid', error: `未知状态：${JSON.stringify(status)}` }
  }

  const read = await readConflict(cid, opts)
  if (!read.ok) return { ok: false, code: read.code, error: read.error }

  const from = read.record.status
  if (from === status) return { ok: true, record: read.record }
  const allowed = CONFLICT_TRANSITIONS[from] ?? []
  if (!allowed.includes(status)) {
    return {
      ok: false,
      code: 'invalid_transition',
      error: `${from} → ${status} 不被允许（已判定过的记录不许回到 open，要重开请新建一条）`,
    }
  }

  const next = { ...read.record, status }
  const written = await writeConflict(next, opts)
  if (!written.ok) return { ok: false, code: written.code, error: written.error }
  return { ok: true, record: next }
}

/**
 * 删一条（清理）。
 *
 * 刻意**不看状态**：拦截「删掉一条还没处理的冲突」是面板的确认动作，不是数据层的事 ——
 * 数据层再拦一道只会让「用户明确要删」变成删不掉。文件不存在 → `missing`。
 *
 * @returns {Promise<{ok:true, path:string} | {ok:false, code:'invalid'|'missing'|'io_error', path?, error}>}
 */
export async function removeConflict(id, opts) {
  const cid = normalizeConflictId(id)
  if (cid === null) return { ok: false, code: 'invalid', error: `冲突 id 非法：${JSON.stringify(id)}` }

  const path = conflictPathFor(cid, opts && typeof opts === 'object' ? opts.stateRoot : undefined)
  try {
    await unlink(path)
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, code: 'missing', path, error: '冲突记录不存在' }
    return { ok: false, code: 'io_error', path, error: String(err?.message ?? err) }
  }
  return { ok: true, path }
}
