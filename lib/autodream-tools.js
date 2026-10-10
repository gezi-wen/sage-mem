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
import { auditMemoryDir, formatAudit, parseFrontmatterLite } from './autodream-audit.js'
import { archiveMemory } from './memory/archive.js'
import { writeFileAtomic } from './memory/util.js'

/** 单次 read_memory 返回的正文上限（字符）。超过就截断并明确告诉模型。 */
const READ_LIMIT = 20000
/** list_memory 里每条描述保留多少字。 */
const LIST_DESC_CHARS = 70
/** search_sessions 单次返回上限（字符）。 */
const SEARCH_LIMIT = 8000
/** 索引文件名：它在列表里要单独标注，免得模型当成一条普通记忆去改。 */
const INDEX_FILE = 'memory.md'
/**
 * 非记忆条目：不进 list_memory。
 *
 * session-log.md 是追加型流水，不是一条记忆 —— 列出来既
 * 占掉模型一大块注意力，又诱导它去「整理」一份流水账。冒烟测试
 * 逮到的就是这条：它出现在了 list_memory 的输出里。
 */
const NON_ENTRY_FILES = new Set(['session-log.md'])

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

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm`（报告与列表里给人看）。 */function localStamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 距今多少天，给模型一个人话尺度。 */
function ageDays(ms) {
  return Math.round(((Date.now() - ms) / 86400000) * 10) / 10
}

/**
 * 扫记忆目录，产出列表用的轻量元数据（不读全文）。
 * @param {string} memoryDir
 * @returns {Promise<Array<object>>}
 */
async function scanEntries(memoryDir) {
  let entries
  try {
    entries = await readdir(memoryDir, { withFileTypes: true })
  } catch (err) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
  const names = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && !NON_ENTRY_FILES.has(e.name.toLowerCase()))
    .map((e) => e.name)
  const out = []
  for (const name of names) {
    const full = join(memoryDir, name)
    try {
      const [content, info] = await Promise.all([readFile(full, 'utf8'), stat(full)])
      const meta = parseFrontmatterLite(content)
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
      const h1 = body.match(/^#\s+(.+)$/m)
      out.push({
        file: name,
        // 索引不是一条记忆：标出来，否则模型会看到「MEMORY.md · reference」而困惑。
        type: name.toLowerCase() === INDEX_FILE ? '索引' : meta.type || 'reference',
        bytes: info.size,
        mtimeMs: info.mtimeMs,
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

/**
 * 在 DSH 会话记录里做定向搜索。
 *
 * 会话正文是 zstd 压缩的（`session.v4.jsonl.zstd`），Node 24 的
 * `zlib.zstdDecompress` 能直接解 —— 不需要外部 zstd 可执行文件。
 * 只按 mtime 从新到旧扫，命中够数就停：这是「找昨天的报错原文」这类
 * 定向问题的用法，不是全量索引。
 *
 * @param {string} sessionsRoot — `$DSH_HOME/sessions`
 * @param {string} query
 * @param {number} limit
 * @param {number} sinceMs — 只看这个时间之后改过的会话
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
  if (typeof zlib.zstdDecompress !== 'function') {
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
      const text = zlib.zstdDecompress(raw).toString('utf8')
      const lines = text.split(/\r?\n/)
      for (const line of lines) {
        if (line.length < 8) continue
        if (!line.toLowerCase().includes(needle)) continue
        hits.push(`[${localStamp(d.mtimeMs)}] ${line.length > 500 ? line.slice(0, 500) + '…' : line}`)
        total += line.length
        if (total > SEARCH_LIMIT || hits.length > limit) break
      }
    } catch {
      // 单个会话读不动就跳过：autodream 不该因为一个坏文件整体失败。
    }
    if (total > SEARCH_LIMIT || hits.length > limit) break
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
            content: str('完整文件内容，必须以 --- 开头的 YAML frontmatter 起始'),
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
  const { memoryDir, sessionsRoot, apply, withSessions } = opts
  let listCache = null
  let auditCache = null
  const touched = []
  /** 结构化变更清单——「整理声明」与「文件级回滚」共用这一份数据。 */
  const changes = []
  /** 被拒绝的写操作（归档没给 reason 之类）：**改动没有发生**，声明里单列一节。 */
  const warnings = []
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
  function changeRecord(op, file, reason, before, after, reasonSource = 'model') {
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
            if (!listCache) listCache = await scanEntries(memoryDir)
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
            const content = await readFile(full, 'utf8').catch((err) => {
              if (err?.code === 'ENOENT') return null
              throw err
            })
            if (content === null) return `错误：没有这个文件：${basename(full)}`
            if (content.length > READ_LIMIT) {
              return `${content.slice(0, READ_LIMIT)}\n\n…（已截断，全文 ${content.length} 字符）`
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
            if (!/^---\r?\n/.test(a.content)) {
              return '错误：内容必须以 `---` 开头的 YAML frontmatter 起始。参考 list_memory 里已有文件的写法。'
            }
            if (a.content.length > 512 * 1024) return `错误：内容过大（${a.content.length} 字符）。`
            const reason = typeof a.reason === 'string' ? a.reason.trim() : ''
            const selfReported = reason.length >= MIN_REASON_CHARS
            const before = await fileFingerprint(full)
            // 原子写：这是**唯一**会把模型生成的内容写进记忆目录的路径。
            // 直写若崩在中途，留下的是半截 frontmatter —— 文件还在、列表还列得出，
            // 但解析不出类型与标题，检索与星图同时哑掉。
            await writeFileAtomic(full, a.content)
            const after = await fileFingerprint(full)
            if (!selfReported) {
              // **不拒绝。** 一次改写缺了缘由，拒掉的代价是这条修正彻底丢失——而它可能
              // 正是这趟整理最该做的事。「照写 + 标未自述 + 用宿主能追溯到的信息顶替」
              // 既保住了改动，也让声明里一眼看得出哪些缘由是模型自己说的。
              notes.push(`${basename(full)} 的改动模型没有自述缘由，声明里已标「未自述」并附追溯信息`)            }
            changeRecord(
              before.exist ? 'update' : 'create',
              basename(full),
              selfReported ? reason : '',
              before,
              after,
              selfReported ? 'model' : 'auto',
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
            return `已归档 ${basename(full)}（原因：${reason}）。`
          }
          default:
            return `错误：没有这个工具：${name}`
        }
      } catch (err) {
        return `工具执行失败：${err?.message ?? String(err)}`
      }
    },
  }
}
