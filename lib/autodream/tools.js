/**
 * sage-mem autodream — 交给 autodream 模型的工具集，以及它们的 host 侧执行器。
 *
 * 这一层是**安全边界**，不是提示词。常见做法是「让模型随便请求、宿主逐个裁决」；
 * 这里换了个更硬的写法 —— **模型只能看见这几个工具**，
 * 而每个工具的宿主实现只认 memory 目录顶层的 `.md` 文件名。模型想越界
 * （写别的目录、动子目录、写非 md、路径穿越）不是「被拒绝」，是**没有这个能力**。
 *
 * 还有两条刻意的不对称：
 *   - 「只出报告」模式下，写工具**根本不注册** —— 不是让模型别写，是它没有手。
 *   - 删除也不是删除：archive_memory 把文件移进 `archive/`，可人工捞回。
 *     memory 目录不在任何版本控制下、unlink 没有回收站，所以不留真删这条路径。
 *
 * **每一次写操作都必须留下「改了什么、为什么」**：
 *   - `write_memory` 的 `reason` **强烈建议**但不强制：缺了照样写入，声明里标成「未自述」
 *     并用宿主能追溯到的信息（第几轮 / 操作 / 字节变化）顶替。**硬拒的代价是丢掉一次
 *     本来正确的修正**，那比缺一句解释更糟（由参考设计调研推翻硬拒方案）。
 *   - `archive_memory` 的 `reason` 仍**必填**：归档是不可逆的退役动作，必须有人能说清为什么。
 *   - 每次成功写入/归档都产出一条结构化 `change`（前后指纹 + 缘由 + 缘由来源 + 字节差），
 *     由 `changes()` 交给上层落成「整理声明」。**回滚也靠它**：只有知道动过哪几个文件、
 *     动之前长什么样，才谈得上把文件级回滚做准。
 *
 * 模型与宿主对同一份数据的理解必须一致：`list_memory` 的字段顺序、
 * `write_memory` 的 frontmatter 规范都沿用 sage-mem 的既有约定，不另造一套。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { auditMemoryDir, formatAudit, parseFrontmatterLite } from './audit.js'
import { archiveMemory } from '../memory/archive.js'
import { MAX_FILE_BYTES, STATE_ROOT } from '../memory/config.js'
import { INDEX_FILE_KEY, SESSION_LOG_KEY } from '../shared/md-name.js'
import { stampHuman as localStamp } from '../shared/stamp.js'
import { writeFileAtomic, warnLog } from '../memory/util.js'
import { buildConflict, listConflicts, readConflict, sameConflict, writeConflict } from '../memory/conflicts.js'
import { memoryPathOf } from '../memory/paths.js'
import { decideWriteIntent } from '../memory/write-gate.js'
import { inspectMemoryEntry, readVerified, reservedIdentitySet } from '../memory/scan.js'

/** 单次 read_memory 返回的正文上限（字符）。超过就截断并明确告诉模型。 */
const READ_LIMIT = 20000
/** list_memory 里每条描述保留多少字。 */
const LIST_DESC_CHARS = 70
/** search_sessions 单次返回上限（字符）。 */
const SEARCH_LIMIT = 8000
/**
 * 把一个模型给的文件名收敛成 memory 目录顶层的一个真实路径。
 *
 * 返回 null 表示「这个请求不合法」——调用方一律当成工具执行失败回给模型，
 * 不抛异常打断整个 autodream（模型写错一次文件名不该毁掉整趟整理）。
 *
 * @param {string} memoryDir — 记忆根目录
 * @param {unknown} raw — 模型给的 file 参数
 * @returns {string|null} 绝对路径，或 null
 */
export function safeMemoryPath(memoryDir, raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // 显式拒绝任何路径分隔与上跳：basename 只做兜底，先拒绝更清楚。
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return null
  if (!/\.md$/i.test(trimmed)) return null
  const base = basename(trimmed)
  if (base.startsWith('.')) return null
  return join(memoryDir, base)
}

/**
 * 把模型给的文件名解析成**磁盘上的真实名字**。
 *
 * 为什么必须有这一步：NTFS 不区分大小写 —— 模型写 `A.md` 而盘上是 `a.md` 时，
 * 读写命中的是**同一个文件**。但变更记录、快照清单、回滚时用的都是「模型给的那个名字」，
 * 于是回滚会去快照里找一个不存在的 `A.md`，**明明有原版却退不回去**，
 * 而且留痕还写着「回滚点里没有这一版，可能已被别的整理改过」——理由是错的。
 *
 * 文件不存在时按原样返回（新建场景）。
 */
async function resolveRealName(memoryDir, base) {
  const lower = base.toLowerCase()
  const entries = await readdir(memoryDir, { withFileTypes: true }).catch(() => [])
  const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === lower)
  return hit ? hit.name : base
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm`（唯一实现在 shared/stamp.js）。 */

/** 距今多少天，给模型一个人话尺度。 */
function ageDays(ms) {
  return Math.round(((Date.now() - ms) / 86400000) * 10) / 10
}

/**
 * 扫记忆目录，产出列表用的轻量元数据（不读全文）。
 * @param {string} memoryDir
 * @returns {Promise<Array<object>>}
 */
async function scanEntries(memoryDir, ctx) {
  let entries
  try {
    entries = await readdir(memoryDir, { withFileTypes: true })
  } catch (err) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
  const reservedIds = await reservedIdentitySet(memoryDir)
  const names = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== SESSION_LOG_KEY)
    .map((e) => e.name)
  const out = []
  for (const name of names) {
    const full = join(memoryDir, name)
    // 与注入 / 面板同一条闸门：模型看到的清单不该包含「住在别处」的文件。
    const gate = await inspectMemoryEntry(full)
    if (!gate.ok) {
      warnLog(ctx, `autodream: skip ${name}: ${gate.error}`)
      continue
    }
    if (gate.id && reservedIds.has(gate.id)) {
      warnLog(ctx, `autodream: skip ${name}: 这是某个保留名的另一个名字`)
      continue
    }
    try {
      // 同上：清单也要从闸门检查过的那个句柄读（N03 —— 检查后换文件不能把外部标题带进来）。
      const content = await readVerified(full, gate, 'utf8')
      const meta = parseFrontmatterLite(content)
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
      const h1 = body.match(/^#\s+(.+)$/m)
      out.push({
        file: name,
        // 索引不是一条记忆：标出来，否则模型会看到「MEMORY.md · reference」而困惑。
        type: name.toLowerCase() === INDEX_FILE_KEY ? '索引' : meta.type || 'reference',
        bytes: gate.size,
        mtimeMs: gate.mtimeMs,
        title: (h1 ? h1[1] : meta.name || '').trim(),
        description: meta.description || '',
      })
    } catch (err) {
      if (err?.code !== 'ENOENT') out.push({ file: name, type: '?', bytes: 0, mtimeMs: 0, title: '', description: `(读取失败: ${err?.message ?? err})` })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/** zstd 帧魔数（小端读出来的值）。 */
const ZSTD_MAGIC = 0xfd2fb528
/** 同一个魔数的字节形态：认不出帧头时要靠它找下一个帧的起点。 */
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 量一个 zstd 帧占多少字节（从 `off` 开始）。不是合法帧头、或帧被截断，返回 0。
 *
 * 为什么要自己量：会话记录是**逐行一个帧**拼起来的，而 Node 的解码器都只认第一个帧 ——
 *   - `zstdDecompressSync(buf)`：实测只解出第一帧（4.44 MB / 3148 帧的文件只出 266 字符）
 *   - `zstdDecompress(buf)`：**单参数调用直接抛** `ERR_INVALID_ARG_TYPE`（它要 callback，
 *     不是 promise 版）—— 旧代码正是这么调的，于是每个会话都在 `catch` 里被静默跳过，
 *     整条 `search_sessions` 实际上**一次都没成功过**
 * 所以只能沿帧头走一遍：Magic → Frame_Header_Descriptor → （Window / DictID / ContentSize）
 * → 逐块 Block_Header 直到 Last_Block → 可选 checksum。
 */
function zstdFrameLength(buf, off) {
  if (off + 5 > buf.length) return 0
  if (buf.readUInt32LE(off) !== ZSTD_MAGIC) return 0
  let p = off + 4
  const fhd = buf[p++]
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictIdFlag = fhd & 3
  if (!singleSegment) p += 1 // Window_Descriptor
  p += [0, 1, 2, 4][dictIdFlag] // Dictionary_ID
  p += singleSegment ? [1, 2, 4, 8][fcsFlag] : [0, 2, 4, 8][fcsFlag] // Frame_Content_Size
  if (p > buf.length) return 0
  for (;;) {
    if (p + 3 > buf.length) return 0
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = h & 1
    const type = (h >> 1) & 3
    const size = h >>> 3
    if (type === 3) return 0 // Reserved：不是我们能认的帧
    p += type === 1 ? 1 : size // RLE 块只存 1 字节
    if (last) break
    if (p > buf.length) return 0
  }
  if (checksum) p += 4
  return p <= buf.length ? p - off : 0
}

/**
 * 把「可能由多个帧拼成」的 zstd 缓冲解成文本。
 *
 * 逐帧解、**一帧坏掉不影响后面的帧**；连帧头都认不出时跳到下一个魔数继续。
 * 解不出来的帧会被跳过（可能返回空串），整个缓冲里一帧都没解出来则返回 `null`
 * —— 由调用方决定怎么记账。
 */
function decodeZstdFrames(zlib, buf) {
  const parts = []
  let off = 0
  let frames = 0
  let decoded = 0
  while (off < buf.length) {
    const len = zstdFrameLength(buf, off)
    if (len <= 0) {
      /**
       * 认不出帧头：**跳到下一个魔数**继续，而不是停下。
       *
       * 停下的代价是「这一帧之后的内容全部静默丢失」—— 而那些帧本来是好的
       * （实测：5 帧里第 3 帧的块头被改成 Reserved，后面两帧就再也搜不到了）。
       * 未对齐的魔数也可能落在压缩数据里，那时的帧长多半解析不通，由下面的 catch 兜住。
       */
      const next = buf.indexOf(ZSTD_MAGIC_BYTES, off + 1)
      if (next < 0) break
      off = next
      continue
    }
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(off, off + len)))
      decoded += 1
    } catch {
      // 单帧坏掉：跳过它，继续后面的帧
    }
    off += len
    frames += 1
  }
  if (frames === 0) {
    try {
      return zlib.zstdDecompressSync(buf).toString('utf8')
    } catch {
      return null
    }
  }
  if (decoded === 0) return null
  return Buffer.concat(parts).toString('utf8')
}

/**
 * 在 DSH 会话记录里做定向搜索。
 *
 * 会话正文是 zstd 压缩的（`session.v4.jsonl.zstd`），而且是**逐行一个帧** ——
 * 所以解压必须逐帧走（见 `decodeZstdFrames`），不需要外部 zstd 可执行文件。
 * 只按 mtime 从新到旧扫，命中够数就停：这是「找昨天的报错原文」这类
 * 定向问题的用法，不是全量索引。
 *
 * @param {string} sessionsRoot — `$DSH_HOME/sessions`
 * @param {string} query — 关键词（≥2 字符）
 * @param {number} limit — 最多返回多少段
 * @param {number} sinceMs — 只看这个时间之后改过的会话。工具层**有意传 0**：
 *   模型搜的是全部会话，不限于上次整理之后（这个参数留给按需过滤的调用方）
 * @returns {Promise<string>}
 */
async function searchSessions(sessionsRoot, query, limit, sinceMs) {
  if (!sessionsRoot) return '（未配置 sessions 目录，无法搜索会话记录）'
  const needle = String(query || '').toLowerCase()
  if (needle.length < 2) return '（关键词太短，至少 2 个字符）'

  let zlib
  try {
    zlib = await import('node:zlib')
  } catch {
    return '（当前 Node 不支持 zstd 解压，无法读取会话记录）'
  }
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return '（当前 Node 不支持 zstd 解压，无法读取会话记录）'
  }

  let dirs
  try {
    const projects = await readdir(sessionsRoot, { withFileTypes: true })
    dirs = []
    for (const p of projects) {
      if (!p.isDirectory()) continue
      const projPath = join(sessionsRoot, p.name)
      const sessions = await readdir(projPath, { withFileTypes: true }).catch(() => [])
      for (const s of sessions) {
        if (!s.isDirectory()) continue
        const file = join(projPath, s.name, 'session.v4.jsonl.zstd')
        const info = await stat(file).catch(() => null)
        if (info && info.mtimeMs >= sinceMs) dirs.push({ file, mtimeMs: info.mtimeMs })
      }
    }
  } catch (err) {
    return `（读取 sessions 目录失败：${err?.message ?? err}）`
  }

  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const hits = []
  let total = 0
  for (const d of dirs.slice(0, 40)) {
    try {
      const raw = await readFile(d.file)
      const text = decodeZstdFrames(zlib, raw)
      if (text === null) continue
      const lines = text.split(/\r?\n/)
      for (const line of lines) {
        if (line.length < 8) continue
        if (!line.toLowerCase().includes(needle)) continue
        hits.push(`[${localStamp(d.mtimeMs)}] ${line.length > 500 ? line.slice(0, 500) + '…' : line}`)
        total += line.length
        // `>= limit`：判据是「已经攒够 limit 段了」，不是「超过了」——后者每次多返回一段。
        if (total > SEARCH_LIMIT || hits.length >= limit) break
      }
    } catch {
      // 单个会话读不动就跳过：autodream 不该因为一个坏文件整体失败。
    }
    if (total > SEARCH_LIMIT || hits.length >= limit) break
  }
  if (!hits.length) return `（在 ${sinceMs ? '上次整理之后' : '全部'}的会话记录里没找到含「${query}」的内容）`
  return `命中 ${hits.length} 段（按 mtime 由新到旧）：\n\n${hits.join('\n')}`
}

/** JSON Schema 片段：工具参数。 */
const str = (description) => ({ type: 'string', description })

/**
 * 组装这一趟 autodream 能用的工具定义。
 * @param {{apply: boolean, withSessions: boolean}} opts
 * @returns {Array<{name:string,description:string,parameters:object}>}
 */
export function autodreamToolSchemas(opts) {
  const tools = [
    {
      name: 'list_memory',
      description:
        '列出记忆目录里的全部条目（文件名 / 类型 / 体积 / 距今多少天 / 描述）。这是第一步：先看清已有什么，再决定改哪一条，避免造出重复文件。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'read_memory',
      description: '读一条记忆的全文（frontmatter + 正文）。文件名要和 list_memory 返回的完全一致。',
      parameters: {
        type: 'object',
        properties: { file: str('记忆文件名，例如 feedback_example.md') },
        required: ['file'],
        additionalProperties: false,
      },
    },
    {
      name: 'audit_memory',
      description:
        '对记忆目录跑一遍结构审计：索引悬空 / 漏索引 / type 与文件名前缀不一致 / CRLF / 双链断链 / frontmatter 里被 YAML 当注释吞掉的「空格+#」。只读，不修改任何文件。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]
  if (opts.withSessions) {
    tools.push({
      name: 'search_sessions',
      description:
        '在 DSH 会话记录（zstd 压缩的 jsonl）里做定向关键词搜索，由新到旧。只在确实需要某个具体细节时才用（例如某次报错原文），不要用它通读会话。',
      parameters: {
        type: 'object',
        properties: {
          query: str('要搜的关键词，至少 2 个字符'),
          limit: { type: 'number', description: '最多返回多少段，默认 20' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    })
  }
  if (opts.apply) {
    tools.push(
      {
        name: 'write_memory',
        description:
          '写入或整体覆盖一条记忆文件（frontmatter + 正文）。只允许 memory 目录顶层的 .md。整合新信息时优先改写已有文件，不要新建近似重复的文件。**reason 请尽量填写**：这些改动会连同缘由一起写进整理声明，人要靠它判断这次自动整理干得对不对；缺了不会被拒绝，但声明里会把那条标成「未自述」。',
        parameters: {
          type: 'object',
          properties: {
            file: str('记忆文件名，例如 project_example.md'),
            content: str(
              '完整文件内容，必须以 --- 开头的 YAML frontmatter 起始。**唯一的例外是索引 `MEMORY.md`**：' +
                '它是一份清单、不是一条记忆，没有 type / 前缀，直接写正文（`- [标题](文件.md) — 一句话`）即可，不要给它补 frontmatter。',
            ),
            reason: str(
              '强烈建议填。一句话说清为什么改这条、改了什么（例如「合并了重复的部署记录，删掉被推翻的旧路径」）。' +
                '缺了**不会**被拒绝——改动照样生效——但整理声明会把这条标成「未自述」，用宿主能追溯到的信息' +
                '（第几轮 / 什么操作 / 字节变化）顶替。硬拒的代价是丢掉一次本来正确的修正，那比缺一句解释更糟。',
            ),
          },
          required: ['file', 'content'],
          additionalProperties: false,
        },
      },
      {
        name: 'archive_memory',
        description:
          '把一条记忆移进 archive/ 子目录（等于退役：不再参与检索与星图，但文件仍在、可人工捞回）。用于被推翻的、或被别的记忆取代的条目。没有删除功能——归档是这里能造成的最强后果。',
        parameters: {
          type: 'object',
          properties: {
            file: str('要归档的记忆文件名'),
            reason: str('一句话说明为什么归档'),
          },
          required: ['file', 'reason'],
          additionalProperties: false,
        },
      },
      {
        name: 'report_contradiction',
        description:
          '报告一对**说法互斥**的记忆（同一件事两种说法，例如「部署在 A」与「部署在 B」）。它只落一条待人工裁决的记录，**不修改任何记忆文件**。裁决之前这两条都不会被注入正文；不要自己删改其中任何一条来「消除矛盾」。',
        parameters: {
          type: 'object',
          properties: {
            old: str('旧说法 / 可能已作废的那条记忆的文件名'),
            new: str('新说法 / 现行的那条记忆的文件名'),
            note: str('一句话说明两条到底哪里互斥（人要靠它判断该保留哪条）'),
          },
          required: ['old', 'new', 'note'],
          additionalProperties: false,
        },
      },
    )
  }
  return tools
}

/**
 * 一条记忆文件当前的指纹。不存在时返回 `exist:false`（这不算错——新建文件的第一步）。
 *
 * 为什么留 sha256 而不只留体积：回滚前的「这文件还是我改完那一版吗」需要能判等，
 * 体积相同内容不同的情况在 markdown 里太常见了。
 */
async function fileFingerprint(full) {
  try {
    const buf = await readFile(full)
    return { exist: true, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }
  } catch (err) {
    if (err?.code === 'ENOENT') return { exist: false, bytes: 0, sha256: null }
    throw err
  }
}

/** 缘由的最短长度：比这更短的基本都是「整理了一下」这种没有信息量的敷衍。 */
const MIN_REASON_CHARS = 4

/**
 * 造一个工具执行器。返回的 run() 永远解析成字符串（失败信息也回给模型），
 * 不抛异常 —— 模型拿到错误描述才能自己改，而不是让整趟 autodream 崩掉。
 *
 * @param {{memoryDir:string, sessionsRoot:string, apply:boolean, withSessions:boolean}} opts
 * @returns {{run:(name:string, args:object)=>Promise<string>, touchedFiles:()=>string[], changes:()=>object[], warnings:()=>string[]}}
 */
export function createToolRunner(opts) {
  const { memoryDir, sessionsRoot, apply, withSessions, ctx } = opts
  let listCache = null
  let auditCache = null
  const touched = []
  /** 结构化变更清单——「整理声明」与「文件级回滚」共用这一份数据。 */
  const changes = []
  /** 被拒绝的写操作（归档没给 reason 之类）：**改动没有发生**，声明里单列一节。 */
  const warnings = []
  /**
   * 被**宿主文件沙箱**拒绝的写入（与「模型没给 reason」这类被拒分开记）。
   *
   * 为什么单列：这类失败不是模型写错了，是**环境不允许**——把它混进 warnings 只能让人
   * 以为「某次写入没成功」，而真正要回答的问题是「这一趟到底有没有落地任何东西」。
   * 上层（`engine.js`）靠它把「零改动的假成功」判成失败（外部报告 2026-10-25 抓到）。
   */
  const denials = []
  /**
   * 提示（advisory）：**改动发生了**，只是有话要说（例如模型没自述缘由）。
   *
   * 与 warnings 分开是必须的：两者在「到底改没改」上完全相反，混在一个数组里渲染出去，
   * 就会出现「标题写着『未能落地的改动』、正文却告诉你『改动已经生效』」这种自相矛盾
   */
  const notes = []
  let seq = 0
  /** 当前处在 agent 循环的第几轮——未自述缘由时用它追溯「哪一步干的」。 */
  let currentStep = 0

  /**
   * 记一条变更。seq 是本次运行内的序号，从 1 开始。
   * @param {'create'|'update'|'archive'} op
   * @param {'model'|'auto'} reasonSource — model = 模型自述；auto = 宿主追溯（模型没给）
   */
  /**
   * 「这份文件我们读到时是什么版本」——**按规范化路径**记，写的时候拿它当守卫。
   *
   * 为什么必须有这张表（外部复审 R01，P1 数据丢失）：守卫如果取**写的那一刻**的版本，
   * 它只保护 `stat → writeText` 这一小段，而真实的危险窗口是 **`读 → 生成 → 写`** 整个周期。
   * 复现：读 A → 人工改成 B → 自动整理基于 A 生成 C → 写时 stat 拿到 B → 守卫通过 → **B 被覆盖**。
   * 单进程里顺序交错就能发生，不需要多进程竞争。
   *
   * 存的是**读到内容那一刻的版本**：C 是基于 A 生成的，就该拿 A 去比。
   * 磁盘已经是 B 时，守卫会以 `FS_STALE_VERSION` 拒绝，内容不丢。
   */
  const readVersions = new Map()

  /**
   * 把「这份内容对应磁盘上的哪个版本」记下来（写回时当守卫）。
   *
   * 取不到可信版本（`version` 为 null）就**什么都不记** —— 宁可让写入走「拒绝」，
   * 也不要拿一个来路不明的版本假装有守卫。
   *
   * ⚠️ 这里只登记、**自己不 stat**。版本由 `readEntryWithVersion` 在**实际读取的前后**
   * 各取一次得到；以前是在 `readFile` **之后**才 stat 两次，读 A、盘上已是 B 时两次 stat
   * 都是 B，于是 A 的正文被绑到 B 的版本上（外部审查 2026-10-31，Q01）。
   */
  function rememberReadVersion(fullPath, version, truncated) {
    if (!version) return
    const where = memoryPathOf(fullPath, memoryDir)
    if (where.ok) readVersions.set(where.canon, { version, truncated: truncated === true })
  }

  /**
   * 「读内容」与「取版本」共用的**唯一入口**（外部审查 2026-10-31，Q01）。
   *
   * 为什么必须是入口、不是两段调用：写回守卫要回答的是「**这份正文**对应哪一个版本」。
   * 分开写时，调用方手里是 `readFile` 的返回值和两次 `stat` 的结果，把三者拼起来那一步最容易错
   * —— 真实代码曾是 `readFile → stat → stat`：读的是 A，两次 stat 都读到 B，
   * 于是 A 的正文被绑到 B 的版本，宿主的 CAS 即使完全正确也救不了这个错配。
   *
   * 顺序固定 **stat → read → stat**，两次版本**相同**才认这份内容就是那个版本的快照；
   * 任何一次取不到（没有宿主 fs 服务 / stat 抛错 / 版本字段缺失）都按「版本未知」处理，
   * 不拿当前版本补票 —— 补票等于替调用方担保一份它没读过的内容。
   *
   * 宿主 `fs` 契约里目前**没有**「原子 read-with-version」这一原语（`readText` 只回正文），
   * 所以退到两次 stat 夹住实际读取。将来宿主提供这个原语，应当优先在 open 句柄上一次性拿到。
   *
   * @returns {Promise<{ok:false, gate:object}|{ok:true, gate:object, content:string, version:string|null}>}
   *   `gate` 是 `inspectMemoryEntry` 的结果（2.1.4 起内容读还用它做身份核对）
   */
  async function readEntryWithVersion(full) {
    const gate = await inspectMemoryEntry(full)
    if (!gate.ok) return { ok: false, gate }
    const fs = hostFs()
    const hostStat = async () => {
      if (!fs || typeof fs.stat !== 'function') return null
      try {
        const info = await fs.stat(await fs.resolve(full))
        return info?.version ?? null
      } catch {
        return null // 取不到就是未知：不要拿「现在」的版本顶替
      }
    }
    const before = await hostStat()
    let content
    try {
      /**
       * 内容走**公共句柄读取入口**（外部审查 2026-10-31，N03）：`inspectMemoryEntry` 是按路径
       * `lstat`，`readFile(路径)` 是另一次按路径打开 —— 两次之间把普通文件换成符号链接 / 另一份
       * 文件，读的就是没检查过的东西（审查用真符号链接复现出目录外内容）。`readVerified`
       * 改成 open 句柄 + fstat 比对 `dev:ino` / 大小，只从那个句柄读；体积上限也在全文读入
       * **之前**生效，不会先整份读进内存再判。
       */
      content = await readVerified(full, gate, 'utf8')
    } catch (err) {
      // 扫到读之间被删是正常状态；其余读失败（含「检查后被换掉」）照旧抛给上层。
      if (err?.code === 'ENOENT') return { ok: false, gate: { ok: false, code: 'missing' } }
      throw err
    }
    const after = await hostStat()
    // 两次版本相同才认「内容 = 版本」；只要中间可能被动过就当作未知。
    const version = before && after && before === after ? before : null
    return { ok: true, gate, content, version }
  }

  /**
   * 取「这次写入该用哪个守卫」。
   *
   * 三种情形，**每一种都是有意的**：
   *   - 文件不存在 → `createIfAbsent`（新建不可能覆盖谁）
   *   - 文件存在 + 我们记过它被读到时是哪个版本 → `replaceIfVersion(那个版本)`
   *   - 文件存在 + **没记过**（没读过 / 版本取不到 / 读的是截断内容）→ **不给守卫，由调用方拒绝**
   *
   * 第三种是 R01 的要害：以前这里退化成「用当前版本」，等于**替调用方担保了一份它没读过的内容**。
   * 现在返回 `{refuse, why}`，让调用方把这次写入转成一条待人工处理的冲突，而不是盲写。
   */
  async function guardForWrite(fullPath) {
    const fs = hostFs()
    if (!fs || typeof fs.stat !== 'function') return { expected: undefined, known: false }
    const target = await fs.resolve(fullPath)
    let info
    try {
      info = await fs.stat(target)
    } catch (err) {
      // stat 抛错 = **不知道盘上是什么**。不知道就不写，而不是「不传守卫让宿主随便写」。
      return { expected: undefined, known: false, refuse: true, why: `取不到当前版本（${err?.code ?? err?.message ?? err}），不能替你覆盖` }
    }
    // 「明确不存在」这一支仍走写门的判定表（`write-gate.js`）—— 能共用的就别写第二份。
    if (!info) return { expected: decideWriteIntent({ memoryPath: memoryPathOf(fullPath, memoryDir), exists: false, version: null, caller: undefined }).intent, known: true }
    const where = memoryPathOf(fullPath, memoryDir)
    const seen = where.ok ? readVersions.get(where.canon) : undefined
    if (!seen?.version) return { expected: undefined, known: false, refuse: true, why: '这份记忆我们没有读过（或版本取不到），不能替你覆盖它' }
    if (seen.truncated) return { expected: undefined, known: false, refuse: true, why: '上次读到的是截断内容，不能拿它作为整份覆盖的依据' }
    return { expected: { kind: 'replaceIfVersion', version: seen.version }, known: true }
  }

  /**
   * 取宿主的 `fs` 服务，拿不到就返回 null。
   *
   * ⚠️ 必须用 `ctx.get('fs')` 而不是 `ctx.fs`：后者在插件没声明 `inject: ['fs']` 时会**抛**
   * `cannot get property "fs" without inject`（实测，见 docs/host-facts.md）。
   * 而 sage-mem 有意不声明这个硬依赖 —— 声明了它，没有 fs 服务的宿主上整个插件会一直待机。
   */
  function hostFs() {
    try {
      const fs = typeof ctx?.get === 'function' ? ctx.get('fs') : undefined
      return fs && typeof fs.resolve === 'function' && typeof fs.writeText === 'function' ? fs : null
    } catch {
      return null
    }
  }

  /**
   * 这一次写入该带上的**逐次沙箱策略**（宿主 `fs.writeText` 的第 5 个参数）。
   *
   * 为什么必须有（外部报告 2026-10-25，issue #6）：autodream **刻意不在会话里跑**
   * （见 README「整理刻意不走会话」），所以永远没有 `session.cwd` 可以继承。宿主的
   * `sandboxPolicy.resolve()` 在没有 session 时退到**部署回退根**（配置的 workspaceRoot，
   * 缺省 `process.cwd()`）；而 workspace-write 的可写根只有那个根 + 临时区。于是
   * 默认记忆目录 `~/.sage-mem/memory` 必然落在根外 → **每一次写入都被围栏拒绝**，
   * 和宿主怎么配无关，是这条路径的结构性缺口。
   *
   * 传 `{ mode: 'workspace-write', workspaceRoot: memoryDir }` 把可写根**收窄到记忆目录**
   * （比回退根更窄，不是更宽），让「插件写自己的数据目录」这件事成立。
   *
   * 三条边界，每一条都是刻意的：
   *   - `read-only` **原样尊重**：只读是用户此刻的选择，不由后台整理替它翻案；
   *     这时不传策略，宿主照旧拒绝，失败会如实上报（见下面 `denials`）。
   *   - `danger-full-access` 本来就不围栏，传了也没意义。
   *   - 拿不到 `sandboxPolicy` 服务（老宿主 / 测试假 ctx）就**不传**，退回宿主默认行为，
   *     与改动前逐字一致。
   *
   * @returns {{mode:string, workspaceRoot:string}|undefined}
   */
  function writeSandboxPolicy() {
    try {
      const sp = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined
      if (!sp || typeof sp.resolve !== 'function') return undefined
      const policy = sp.resolve()
      if (!policy || policy.mode !== 'workspace-write') return undefined
      return { mode: 'workspace-write', workspaceRoot: memoryDir }
    } catch {
      return undefined
    }
  }

  /** 记一次「宿主沙箱拒绝写入」。调用点只有 `writeMemoryText` 的 catch —— 别在别处重复记。 */
  function recordSandboxDenial(fullPath, err) {
    const file = basename(fullPath)
    const message = String(err?.message ?? err)
    denials.push({ file, code: String(err?.code ?? ''), message })
    // 同时进 warnings：整理声明里原本就有「未能落地的改动」一节，别让这类失败只活在内存里。
    warnings.push(`写入 ${file} 被宿主文件沙箱拒绝：${message}`)
    warnLog(ctx, `写入被沙箱拒绝：${file}: ${message}`)
  }

  /**
   * 沙箱拒绝时给模型的**一句话出路**。
   *
   * 原样回一句 `access denied` 的话，模型只会换个文件名反复重试；而人读 transcript 时
   * 也看不出该去改什么配置。这句提示只说明「这是环境问题、该改哪里」，绝不暗示
   * 「换个方式绕过围栏」—— 那会把一次功能故障变成一次安全边界失效。
   */
  function sandboxDenialHint(err) {
    if (err?.code !== 'FS_SANDBOX_DENIED') return ''
    return (
      '（这次写入被宿主文件沙箱拒绝，与文件名、内容都无关。自动做梦在会话外运行，' +
      '拿不到会话的工作区：宿主是 read-only 时这是预期行为；是 workspace-write 时，' +
      '请把记忆目录放进宿主的 workspaceRoot，或给 @deepseek-ai/dsh-sandbox-policy 配置 workspaceRoot。' +
      '不要用其它方式绕过围栏。）'
    )
  }

  /**
   * 把一次「版本过期」落成一条**待人工判定**的冲突记录。
   *
   * 为什么不是「重试」也不是「放弃」：两者都是在替用户决定保留哪一边。
   * 我们要做的是把这次失败从**一个报错**变成**一条可查询的记录** —— 盘上那份是什么、
   * 我们想写的是什么，都留下来，让用户在面板里看到再选。
   *
   * ⚠️ 这里**吞掉一切异常**：它发生在「写入已经失败」的路径上，再抛一次只会把真正的原因
   * （`FS_STALE_VERSION`）盖掉。留不下记录就只留日志，绝不改变向外抛的那个错误。
   */
  async function recordStaleConflict(fullPath, incoming, err, kind = 'stale_version') {
    try {
      const fs = hostFs()
      let onDisk = null
      // 把盘上那一版也存下来 —— 冲突记录的价值就在「两份都在」，只有一边等于没得判。
      try {
        if (fs && typeof fs.readText === 'function') onDisk = await fs.readText(await fs.resolve(fullPath))
      } catch { /* 读不到就只留我们这一版：宁缺一半，也不要为它把冲突记录整条丢掉 */ }
      const record = buildConflict({
        kind,
        file: basename(fullPath),
        expectedVersion: 'unknown',   // 守卫是我们自己按 stat 到的版本构造的，这里拿不到那个字符串
        actualVersion: String(err?.code ?? ''),
        incoming,
        onDisk,
        note: '自动做梦写入时版本已变化：有人在这份记忆被读入之后改过它',
        tool: 'write_memory',
        at: new Date().toISOString(),
      })
      // 同一件事只留一条：否则每一趟重试都会给队列添一份副本（见 hasSameOpenConflict）。
      if (await hasSameOpenConflict(record)) return
      await writeConflict(record, { stateRoot: STATE_ROOT })
    } catch (conflictErr) {
      warnLog(ctx, `冲突记录没写下来（写入失败的原因不受影响）：${conflictErr?.message ?? conflictErr}`)
    }
  }

  /**
   * 队列里是否已有一条**完全同一件事**的未裁决记录。
   *
   * 为什么需要（外部报告 2026-10-25，issue #7）：记录的 id 带着 `at` 的时间戳前缀
   * （见 `buildConflict`），而「模型每一趟都试图覆盖一份它没读过的记忆」是**结构性**的
   * —— 每一趟都会生成新 id，于是 `conflicts/` 只增不减，而其中绝大多数是同一件事的副本。
   *
   * 判据是**逐字段相等**（kind / file / otherFile / 两份正文 / 两个版本）：任何一处不同都算另一件事，
   * 仍然是两条独立记录 —— 去重只跳过重复，不做「合并」，更不做裁决。
   * `otherFile` 必须进比较列表：否则「A 对 B」与「A 对 C」会被当成同一件事，
   * 第二对矛盾就永远落不了盘。
   * 读队列失败一律当作「没有重复」：去重是省磁盘的优化，不能因为读不动就连该留的记录也不留。
   */
  async function hasSameOpenConflict(record) {
    try {
      const listed = await listConflicts({ stateRoot: STATE_ROOT })
      if (!listed.ok) return false
      // 判据本身在 `conflicts.js` 的 `sameConflict`（唯一一份）：这里只负责「读队列 + 任一相等」。
      return listed.items.some((c) => sameConflict(c, record))
    } catch {
      return false
    }
  }

  /**
   * 把内容写进一条记忆文件。
   *
   * **优先走宿主的 `fs.writeText`**，理由是它同时吃到 `fs/write-intent` 那道**写入门**
   * （见 `lib/memory/write-gate.js`）：我们自己那套 `writeFileAtomic` **绕过它**。
   * 绕过意味着 autodream 排在版本守卫之外 —— 而 autodream 恰恰是最可能与用户手动编辑
   * 撞上的写入者（它在后台跑，用户看不见）。两套写入者之间还能静默互踩，就等于没修。
   *
   * ⚠️ **宿主写入失败时绝不回落。** 回落等于「版本守卫拒绝之后我们照样写进去」，
   * 那把守卫整个作废了，还更糟：它会让失败看起来像成功。失败如实抛给调用方。
   *
   * 只有**宿主没有 fs 服务**时才回落（老宿主 / 测试里的假 ctx）——那条路径的行为与改动前
   * 逐字一致，所以既有断言不受影响。
   *
   * @returns {Promise<object|null>} 宿主的 `FsWriteOutcome`；回落时返回 null
   */
  async function writeMemoryText(fullPath, content) {
    const fs = hostFs()
    if (!fs) {
      await writeFileAtomic(fullPath, content)
      return null
    }
    const target = await fs.resolve(fullPath)
    // ⚠️ **守卫必须由我们自己传。** `fs/write-intent` 只为「工具发起」的写入派发，
    // 插件自己调 `writeText` 时一次都不发（实测）—— 不自己传，这次写入就是**无守卫**的。
    //
    // ⚠️⚠️ **而且必须是「读到内容那一刻」的版本，不是「现在」的版本。** 拿现在这个版本当守卫
    // 只保护 `stat → writeText` 这一小段；真正的危险窗口是 `读 → 生成 → 写`。
    // 外部复审 R01 就是这样复现出数据丢失的（读 A → 人工改 B → 基于 A 生成 C → 写时拿到 B 的版本
    // → 守卫通过 → B 没了）。守卫的版本来自 `readVersions`，见 guardForWrite。
    const guard = await guardForWrite(fullPath)
    if (guard.refuse) {
      // **不知道就不写。** 以前这条路会退化成「用当前版本当守卫」，等于替调用方担保一份它没读过的
      // 内容 —— 那比「什么都不做」危险得多。转成一条待人工处理的冲突，让人来判。
      await recordStaleConflict(fullPath, content, { code: 'UNVERIFIED_OVERWRITE', message: guard.why }, 'external_change')
      throw Object.assign(new Error(guard.why), { code: 'SAGE_MEM_UNVERIFIED_OVERWRITE' })
    }
    try {
      // 第 4 个参数是 abort signal（这里不用）；第 5 个是逐次沙箱策略 —— 见 writeSandboxPolicy。
      return await fs.writeText(target, content, guard.expected, undefined, writeSandboxPolicy())
    } catch (err) {
      // 版本过期不是「写失败」，是**一次待判定的冲突**：有人在我们读入之后改过这份记忆。
      // 落一条记录（保留哪边由人决定），然后**照旧把错误抛出去** ——
      // 静默重试或静默放弃都是在替用户做决定。
      if (err?.code === 'FS_STALE_VERSION') await recordStaleConflict(fullPath, content, err)
      // 沙箱拒绝是环境故障：记下来，让上层别把「零改动」报成成功。
      if (err?.code === 'FS_SANDBOX_DENIED') recordSandboxDenial(fullPath, err)
      throw err
    }
  }

  function changeRecord(op, file, reason, before, after, reasonSource = 'model', extra = null) {
    seq += 1
    const at = Date.now()
    changes.push({
      seq,
      at,
      atHuman: localStamp(at),
      step: currentStep || null,
      file,
      op,
      reason,
      reasonSource,
      before,
      after,
      deltaBytes: after.bytes - before.bytes,
      // 这一笔是走宿主 fs 写的、还是回落到本地原子写；走宿主时带**版本**。
      // 回落时两者都如实写 null —— 不假装知道一个我们其实拿不到的版本。
      ...(extra && typeof extra === 'object' ? extra : {}),
    })
  }

  return {
    /** 报告要写「改了哪些文件」，由这里记录。 */
    touchedFiles() {
      return [...touched]
    },
    /** 结构化变更清单（含缘由与前后指纹）。 */
    changes() {
      return changes.map((c) => ({ ...c }))
    },
    /** 被拒绝的写操作说明（改动没有发生）。 */
    warnings() {
      return [...warnings]
    },
    /**
     * 被**宿主文件沙箱**拒绝的写入（环境故障，不是模型写错）。
     * 上层用「有拒绝 + 零改动」把空转判成失败，别只靠 warnings 里的一句话。
     */
    denials() {
      return denials.map((d) => ({ ...d }))
    },
    /** 提示（改动发生了，但有话要说）。 */
    notes() {
      return [...notes]
    },
    /** agent 循环每进一轮调一次，供未自述缘由时追溯来源。 */
    setStep(n) {
      currentStep = Math.max(0, Math.round(Number(n) || 0))
    },

    async run(name, args) {
      const a = args && typeof args === 'object' ? args : {}
      try {
        switch (name) {
          case 'list_memory': {
            if (!listCache) listCache = await scanEntries(memoryDir, ctx)
            const lines = listCache.map(
              (e) =>
                `- ${e.file} · ${e.type} · ${Math.round(e.bytes / 1024)}KB · ${ageDays(e.mtimeMs)}天前 · ${localStamp(e.mtimeMs)}\n    ${(e.title || '(无标题)').slice(0, 60)}${e.description ? ' — ' + e.description.slice(0, LIST_DESC_CHARS) : ''}`,
            )
            return `记忆目录：${memoryDir}\n共 ${listCache.length} 条（按修改时间由新到旧）：\n\n${lines.join('\n')}`
          }
          case 'read_memory': {
            const validated = safeMemoryPath(memoryDir, a.file)
            if (!validated) return `错误：文件名不合法（只能是 memory 目录顶层的 .md 文件名）：${String(a.file)}`
            // 统一落到磁盘上的真实名字：NTFS 大小写不敏感，`A.md` 与 `a.md` 是同一个文件。
            const full = join(memoryDir, await resolveRealName(memoryDir, basename(validated)))
            /**
             * 过闸门再读：**名字在记忆目录里不等于内容住在记忆目录里**。
             * 注入与面板两条腿都挡住了，这条腿（模型工具）也必须挡 ——
             * 否则外部文件的内容照样会被读进来、送进模型上下文。
             *
             * 内容与版本一起取（`readEntryWithVersion`）：守卫要的是「这份正文对应哪个版本」，
             * 分开取会把 A 的正文绑到 B 的版本上（Q01）。
             */
            const seen = await readEntryWithVersion(full)
            if (!seen.ok) {
              return seen.gate.code === 'missing'
                ? `错误：没有这个文件：${basename(full)}`
                : `错误：拒绝读取 ${basename(full)}：${seen.gate.error}`
            }
            const content = seen.content
            // 记下「这份内容对应磁盘上的哪个版本」——写回时用它当守卫（外部复审 R01 / Q01）。
            // 截断的读也要标出来：截断内容不足以作为整份覆盖的依据。
            const truncated = content.length > READ_LIMIT
            rememberReadVersion(full, seen.version, truncated)
            if (truncated) {
              return `${content.slice(0, READ_LIMIT)}\n\n…（已截断，全文 ${content.length} 字符。注意：截断的读不能作为整份覆盖的依据）`
            }
            return content
          }
          case 'audit_memory': {
            if (!auditCache) auditCache = await auditMemoryDir(memoryDir)
            return formatAudit(auditCache, 20)
          }
          case 'search_sessions': {
            if (!withSessions) return '错误：本次 autodream 的输入源不包含会话记录，search_sessions 不可用。'
            const lim = Number.isFinite(a.limit) ? Math.max(1, Math.min(60, Number(a.limit))) : 20
            return await searchSessions(sessionsRoot, a.query, lim, 0)
          }
          case 'write_memory': {
            if (!apply) return '错误：当前是「只出报告」模式，没有写权限。请把改动写进你的最终回复。'
            const validated = safeMemoryPath(memoryDir, a.file)
            if (!validated) return `错误：文件名不合法（只能是 memory 目录顶层的 .md 文件名）：${String(a.file)}`
            // 落盘前先解析成磁盘真实名字，否则变更记录与快照清单会各记一个名字，
            // 文件级回滚就找不到原版（RB-9）。
            const full = join(memoryDir, await resolveRealName(memoryDir, basename(validated)))
            if (typeof a.content !== 'string' || !a.content.trim()) return '错误：content 为空。'
            /**
             * 索引 `MEMORY.md` **不要求 frontmatter**（外部报告 2026-10-25，issue #8）。
             *
             * 索引是一份清单、不是一条记忆：它没有 `type`，也没有能对上的文件名前缀。
             * 硬要求 frontmatter 只会让模型为了「能写进去」给它编一个 `type: reference`，
             * 而体检随后按「type 与前缀不一致」报警 —— 一个纯粹的假阳性，而且是常驻的。
             * 手动入口（面板「建立索引骨架」）写出来的骨架本来也没有 frontmatter，
             * 两条写入路径不该对同一个文件给出两套规矩。
             */
            const isIndex = basename(full).toLowerCase() === INDEX_FILE_KEY
            if (!isIndex && !/^---\r?\n/.test(a.content)) {
              return '错误：内容必须以 `---` 开头的 YAML frontmatter 起始。参考 list_memory 里已有文件的写法。'
            }
            /**
             * ⚠️ 体积闸门必须按**字节**算，与读取端（`inspectMemoryEntry` 的 `info.size`）同一把尺子。
             *
             * 原先按 `content.length`（UTF-16 码元数）判：18 万个汉字 = 18 万「字符」、
             * 却是 54 万字节 —— 工具高高兴兴回「已写入」，紧接着这条记忆就被读端的
             * 512 KiB 闸门判成 `too-big` 拒绝。**自己写出自己读不了的文件**，
             * 而模型收到的是一句成功。多字节文本（中文正是常态）下两把尺子差了 3 倍。
             */
            const bytes = Buffer.byteLength(a.content, 'utf8')
            if (bytes > MAX_FILE_BYTES) {
              return `错误：内容过大（${bytes} 字节，上限 ${MAX_FILE_BYTES} 字节 / ${a.content.length} 字符）。请拆成多条记忆，或只保留要点。`
            }
            const reason = typeof a.reason === 'string' ? a.reason.trim() : ''
            const selfReported = reason.length >= MIN_REASON_CHARS
            const before = await fileFingerprint(full)
            // 走宿主写入（有 fs 服务时）：原子性由宿主保证，**并且吃到写入门**（见 writeMemoryText）。
            // 内容闸门上面已按字节判过，这里只关心「写没写进去、写成了什么版本」。
            const outcome = await writeMemoryText(full, a.content)
            const after = await fileFingerprint(full)
            if (!selfReported) {
              // **不拒绝。** 一次改写缺了缘由，拒掉的代价是这条修正彻底丢失——而它可能
              // 正是这趟整理最该做的事。「照写 + 标未自述 + 用宿主能追溯到的信息顶替」
              // 既保住了改动，也让声明里一眼看得出哪些缘由是模型自己说的。
              notes.push(`${basename(full)} 的改动模型没有自述缘由，声明里已标「未自述」并附追溯信息`)            }
            changeRecord(
              // 宿主给了 operation（create / update）就直接用 —— 它比「看写之前存不存在」更权威：
              // 那个指纹是我们**自己**在写之前 stat 的，中间还有一道缝。回落时才由指纹推。
              outcome?.operation === 'create' || outcome?.operation === 'update'
                ? outcome.operation
                : (before.exist ? 'update' : 'create'),
              basename(full),
              selfReported ? reason : '',
              before,
              after,
              selfReported ? 'model' : 'auto',
              { via: outcome ? 'fs' : 'atomic', version: outcome?.version ?? null },
            )
            touched.push(basename(full))
            listCache = null
            auditCache = null
            return `已写入 ${basename(full)}（${a.content.length} 字符）${before.exist ? '' : '（新建）'}。`
          }
          case 'archive_memory': {
            if (!apply) return '错误：当前是「只出报告」模式，没有归档权限。请把建议写进你的最终回复。'
            const validated = safeMemoryPath(memoryDir, a.file)
            if (!validated) return `错误：文件名不合法：${String(a.file)}`
            const full = join(memoryDir, await resolveRealName(memoryDir, basename(validated)))
            // reason 必填这条语义由**工具自己**守（模型必须为不可逆动作说清为什么）；
            // 落盘动作则交给 memory/archive.js —— 与手动 remote、自动策略共用同一份。
            const reason = typeof a.reason === 'string' ? a.reason.trim() : ''
            if (reason.length < MIN_REASON_CHARS) {
              warnings.push(`拒绝对 ${basename(full)} 的归档：模型没给 reason（或太短）`)
              return '错误：archive_memory 必须给 reason —— 一句话说明为什么这条该退役。请带上 reason 重发。'
            }
            const before = await fileFingerprint(full)
            const res = await archiveMemory(memoryDir, basename(full), reason)
            if (!res.ok) {
              if (res.code === 'not-found') return `错误：没有这个文件：${basename(full)}`
              if (res.code === 'exists') return `错误：archive/ 里已有同名文件（${basename(full)}），请先人工处理，避免覆盖。`
              return `错误：${String(res.error).replace(/^sage-mem: /, '')}`
            }
            changeRecord('archive', basename(full), reason, before, { exist: false, bytes: 0, sha256: null })
            touched.push(`${basename(full)} → archive/`)
            listCache = null
            auditCache = null
            /**
             * 归档成功、索引却没摘掉时**必须说出来**（复审 R11 的配套）：索引会留下一条
             * 指向「已不在顶层」的悬空条目，下次体检报问题，而模型只看到一句「已归档」时
             * 完全无从修正。这类「说了要做就得做到」的出口，缺一个都等于没修。
             */
            if (res.indexError) {
              warnings.push(`${basename(full)} 的索引没摘掉：${res.indexError}`)
              return `已归档 ${basename(full)}（原因：${reason}）。⚠ 但索引里的那一行没能摘掉（${res.indexError}）—— 这条记忆已不在顶层，索引会显示为悬空条目，需要人工处理。`
            }
            return `已归档 ${basename(full)}（原因：${reason}）。`
          }
          case 'report_contradiction': {
            // 2.0.0：**只落待裁决记录，不动记忆文件**。检测只发生在整理这条已有路径上
            // （不做常驻扫描、不加公开工具面，D29 Q5）；裁决永远由人做。
            if (!apply) return '错误：当前是「只出报告」模式，没有写权限。请把发现的矛盾写进你的最终回复。'
            const oldName = safeMemoryPath(memoryDir, a.old)
            const newName = safeMemoryPath(memoryDir, a.new)
            if (!oldName || !newName) return '错误：文件名不合法（只能是 memory 目录顶层的 .md 文件名）。'
            const oldFull = join(memoryDir, await resolveRealName(memoryDir, basename(oldName)))
            const newFull = join(memoryDir, await resolveRealName(memoryDir, basename(newName)))
            if (basename(oldFull) === basename(newFull)) return '错误：old 与 new 不能是同一个文件。'
            const note = typeof a.note === 'string' ? a.note.trim() : ''
            if (note.length < MIN_REASON_CHARS) {
              return '错误：report_contradiction 必须给 note —— 一句话说明这两条到底哪里互斥。'
            }
            // 两份正文都存进记录：面板上人要对照着判，只留一边等于没得判。
            // 同样走句柄读取入口（N03）：记录里的正文会被人和模型看到，不能来自目录外。
            const readBody = async (full) => {
              const gate = await inspectMemoryEntry(full)
              if (!gate.ok) return null
              return await readVerified(full, gate, 'utf8').catch(() => null)
            }
            const onDisk = await readBody(oldFull)
            const incoming = await readBody(newFull)
            if (onDisk === null || incoming === null) {
              return '错误：old / new 里有读不到的文件，先用 list_memory 确认真实文件名。'
            }
            const record = buildConflict({
              kind: 'contradiction',
              file: basename(oldFull),
              otherFile: basename(newFull),
              incoming,
              onDisk,
              note,
              tool: 'report_contradiction',
              at: new Date().toISOString(),
            })
            const pair = `${basename(oldFull)} ↔ ${basename(newFull)}`
            if (await hasSameOpenConflict(record)) {
              notes.push(`发现矛盾：${pair}（队列里已有同一对，未重复落盘）`)
              return `已记录（此前已有同一对待裁决记录）：${pair}。`
            }
            /**
             * id 的时间戳只精确到秒：同一对在**同一秒**里「裁决完又重报」会撞上已裁决记录的 id，
             * 盲写会把它拉回 open 并把裁决收据冲掉（状态机被这条路径绕过）。
             * 撞上就换一个后缀，让这次报告成为**一条新记录** —— 旧判断留在原记录里，不该被覆盖。
             */
            let target = record
            for (let n = 2; n <= 9; n++) {
              const existing = await readConflict(target.id, { stateRoot: STATE_ROOT })
              if (existing?.code === 'missing') break
              target = { ...record, id: `${record.id}-${n}` }
            }
            const written = await writeConflict(target, { stateRoot: STATE_ROOT })
            if (!written.ok) return `错误：矛盾记录没落下来（${written.code}）：${written.error ?? ''}`
            notes.push(`发现矛盾：${pair}（待人工裁决：${note}）`)
            return `已记录矛盾：${pair}。裁决之前这两条都不会被注入正文；请不要自行删改其中任何一条。`
          }
          default:
            return `错误：没有这个工具：${name}`
        }
      } catch (err) {
        return `工具执行失败：${err?.message ?? String(err)}${sandboxDenialHint(err)}`
      }
    },
  }
}
