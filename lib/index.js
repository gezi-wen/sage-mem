/**
 * sage-mem — 文件式记忆插件（CC 原生方式）。
 *
 * 记忆存在本地 markdown 文件目录（frontmatter + 正文，4 类），不是数据库。
 * host 侧两件事：
 *   1. 按问题检索注入：system-prompt/assemble 时扫 memory 目录，按双字匹配
 *      选相关文件，读全文注入 system prompt，让 agent 第一轮就「想起」
 *   2. TypertRemoteService：给设置页「记忆管理」提供文件列表/读/写/删
 *
 * 写入靠 AGENTS.md 的「记忆使用」规则引导 agent 自己判断 + 用文件工具写
 * memory 目录——透明、可检查、防膨胀。无 worker、无 SQLite、无端口。
 *
 * 旧 worker 版见 git 分支 `sqlite-worker`。
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { homedir } from 'node:os'
import { readFile, readdir, writeFile, rename, unlink, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'

const MEMORY_DIR = process.env.SAGE_MEM_DIR || join(homedir(), '.sage-mem', 'memory')
const MAX_RESULTS = 5
const MAX_CHARS_PER_FILE = 1500
const MAX_BASELINE = 5

/**
 * 保留名：设置页的写/删方法一律不得触碰。
 *
 * 列进来的两类文件：
 *   1. MEMORY.md / session-log.md —— 不是记忆条目：不进检索、不进星图、不出现在
 *      设置页列表里，它们是索引与追加型流水（session-log.md 已 130+ KB）。
 *      「+ 添加记忆」表单里手打这两个名字就能整份覆盖，而这个表单是照
 *      buildFrontmatter() 重建 frontmatter 的，原有内容一个字都留不下。
 *   2. project_heartscape.md / project_self-cognition.md —— 人格连续性的手写载体
 *      （AGENTS.md 指定的落盘目标），单副本、纯人工维护；表单写还会把
 *      frontmatter 里的 originSessionId / birthday 等字段一并抹掉。
 *
 * 判定依据是「丢了能不能从别处重建」：memory 目录**不在任何版本控制下**
 * （在 E:\shengdian 下 `git rev-parse` 直接报 not a git repository），
 * deleteFile 是 unlink、没有回收站，所以宁严勿松。
 * 这几个文件要改，用文件工具直接编辑。
 */
const RESERVED_FILES = new Set([
  'MEMORY.md',
  'session-log.md',
  'project_heartscape.md',
  'project_self-cognition.md',
])

/**
 * 单文件体积上限（字节）。定 512 KB 的理由：
 *   - 当前 memory 目录最大的一条正文 19 KB（project_guikit.md），索引与流水都排除在外，
 *     512 KB 是它的 26 倍，任何正常记忆都够用；
 *   - 记忆是要塞进 system prompt 的，一条 512 KB 的记忆本身就等于把上下文撑爆——
 *     到这个量级基本可以判定是写错了目标（比如把日志、代码贴进来）。
 * 与 lib/typert.host.js 的 fileContentSchema.max(512 * 1024) 保持一致。
 */
const MAX_FILE_BYTES = 512 * 1024

/**
 * 统一告警出口。所有非 ENOENT 的失败都必须落到日志，绝不静默
 * （历史坑见 assemble 监听器里那段注释：表现是「插件在、记忆不再注入」，日志一字没有）。
 * @param ctx — 插件上下文，取 ctx.logger.warn
 * @param msg — 消息正文，调用方负责带上文件名 / 目录名
 * @param sessionId — 可选 session id，有就带
 */
function warnLog(ctx, msg, sessionId) {
  const line = `sage-mem: ${msg}${sessionId ? ` (session ${sessionId})` : ''}`
  if (ctx?.logger?.warn) ctx.logger.warn(line)
  else console.warn(line)
}

/** 提取消息文本，兼容 content 为字符串或 text-block 数组两种形态。 */
function extractText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

/** 提取双字（2-gram）集合，中英文数字通用。 */
function bigrams(s) {
  const clean = String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

/** query 的双字在 text 中的覆盖率（0~1），作为相关性得分。 */
function score(query, text) {
  const q = bigrams(query)
  if (q.size === 0) return 0
  const t = bigrams(text)
  let hit = 0
  for (const g of q) if (t.has(g)) hit++
  return hit / q.size
}

/** 扫 memory 目录，读回全部记忆文件（跳过索引与子目录），并解析 frontmatter 摘要。 */
async function scanMemoryFiles(ctx, sessionId) {
  try {
    const entries = await readdir(MEMORY_DIR, { withFileTypes: true })
    const names = entries
      .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md' && e.name !== 'session-log.md')
      .map(e => e.name)
    const loaded = await Promise.all(names.map(async (name) => {
      try {
        const content = await readFile(join(MEMORY_DIR, name), 'utf8')
        const meta = parseFrontmatter(content)
        return {
          file: name,
          content,
          description: meta.description || '',
          baseline: parseBaseline(content),
        }
      } catch (err) {
        // 只有 ENOENT 是正常状态（扫到读之间被删）。其余——权限错、编码坏、盘掉线——
        // 一律出声：这里的静默化就是把「记忆不再注入」变成无声事故的那一手。
        if (err?.code !== 'ENOENT') warnLog(ctx, `cannot read ${name}: ${err?.message ?? err}`, sessionId)
        return null
      }
    }))
    return loaded.filter(Boolean)
  } catch (err) {
    if (err?.code !== 'ENOENT') warnLog(ctx, `cannot scan ${MEMORY_DIR}: ${err?.message ?? err}`, sessionId)
    return []
  }
}

/**
 * 相关性打分只用 frontmatter 的 description + 文件名，不扫全文。
 *
 * 旧版拿 query 的双字去全文里找，得分是「覆盖率」，分母是 query，不惩罚
 * 文件长度 —— 越长的记忆越容易蒙中。实测 8 个典型问题：project_heartscape
 * (5.9KB) 与 project_self-cognition (6.8KB) 命中 7 个，连「今天天气不错」都
 * 注入 2300 token；而「论文写得怎么样了」该命中的 project_position-paper
 * 反被挤掉。description 是「一句话说清这条是什么」的精准摘要，用它当检索
 * 信号，噪音大幅下降。
 */
function selectRelevant(query, files) {
  return files
    .map(f => {
      const hay = f.description + ' ' + f.file.replace(/\.md$/, '').replace(/[_-]/g, ' ')
      return { ...f, score: score(query, hay) }
    })
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
}

/** 解析 frontmatter 的 name/description/type（兼容顶层与 metadata 嵌套两种 type）。 */
function parseFrontmatter(content) {
  // 换行必须容忍 CRLF：任何用 Windows 编辑器碰过一次的文件都会被换成 \r\n，
  // 而旧版这里写的是 /^---\n/ —— 匹配失败 → description/type 全空 →
  // 「baseline 走 parseBaseline 那条带 \r?\n 的正则照旧命中，但这条记忆永远检索不到」，
  // 症状极具欺骗性。:123 的 parseBaseline 与 :277 的 extractTitle 早已是 \r?\n。
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { name: '', description: '', type: '' }
  const body = m[1]
  const grab = (key) => {
    // [ \t] / [ \t\r] 而不是 \s：\s 会连 CRLF 的 \r 一起吃进捕获组，值尾留一个 \r
    // 会让下面的引号剥离（["']$）失配，description 尾巴上挂一个残引号。
    const hit = body.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t\\r]*$`, 'm'))
    if (!hit) return ''
    return hit[1].replace(/^["']|["']$/g, '').trim()
  }
  let type = grab('type')
  if (!type) {
    const nested = body.match(/^metadata:\s*\r?\n(?:\s+[^\r\n]+\r?\n)*?\s+type:\s*(\S+)/m)
    if (nested) type = nested[1]
  }
  return { name: grab('name'), description: grab('description'), type }
}

/** 解析 frontmatter 的 `baseline` 标记：会话第一回合无条件注入。 */
function parseBaseline(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return false
  const hit = m[1].match(/^baseline:\s*(.+)$/m)
  if (!hit) return false
  return /^(true|yes|1)$/i.test(hit[1].replace(/^["']|["']$/g, '').trim())
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 直写的风险是崩在中途（断电、进程被杀、磁盘满）留下半截文件 —— frontmatter
 * 缺半边，这条记忆从此解析不出来、检索不到，而文件看上去还在。
 * 同卷 rename 是原子的：读方要么看到旧全文、要么看到新全文，不存在中间态。
 * 任何一步失败都不碰目标文件，临时文件收尾清掉。
 */
async function writeFileAtomic(target, content) {
  const tmp = `${target}.${process.pid}.tmp`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, target)
  } finally {
    // rename 成功后 tmp 已不存在（ENOENT），失败时把它清掉不留垃圾。
    await unlink(tmp).catch(() => {})
  }
}

/** 防路径穿越：只取 basename，且必须在 memory 目录内（.md，排除索引）。 */
function safeName(raw) {
  const name = basename(String(raw || ''))
  if (!name || !name.endsWith('.md') || name === 'MEMORY.md') return null
  return name
}

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

    // 同一轮对话里问题不变、注入内容也不变，但 DSH 每一步都会往 session 追加
    // 一条 context 消息——不去重的话同一份记忆会被反复追加，撑爆上下文。
    const recallCache = new Map()

    // 按问题检索注入：system-prompt/assemble 是异步 waterfall，监听器可 await。
    // 从 agent.session 拿当前 user message，扫 memory 目录按摘要匹配选相关
    // 文件，读全文作为动态 context 段注入——让 agent 第一轮就「想起」。
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next()
      // session id 在 try 外先取好：catch 里也要能带上它（拿到什么带什么）。
      const sessionId = context?.agent?.session?.id ?? ''
      try {
        const agent = context?.agent
        const session = agent?.session
        if (!session || typeof session.deriveMessages !== 'function') return assembled
        const messages = [...session.deriveMessages()]

        // 关键：DSH 0.1.5 把工具结果（source.kind === 'tool'）和注入内容
        // （source.kind === 'plugin'）也存成 role: 'user' 的消息。只按 role 取
        // 「最后一条」会取到 tool-result，extractText 得到空串，下面的长度检查
        // 直接返回——表现就是全程静默不注入。只有 source.kind === 'user' 是真人输入。
        const userMessages = messages.filter(m => m?.role === 'user' && m?.source?.kind === 'user')
        const text = extractText(userMessages[userMessages.length - 1]?.content)

        const files = await scanMemoryFiles(ctx, sessionId)
        const picked = []
        const seen = new Set()
        const take = (f) => {
          if (seen.has(f.file)) return
          seen.add(f.file)
          picked.push(f)
        }

        // 新会话首步：注入 frontmatter 标了 `baseline: true` 的记忆。当前这条
        // 用户消息在 assemble 时还没写进 session，所以首步这里恰好是 0 条。
        // 这一层补「开场白失忆」——「继续吧」这类短话在 description 里找不到
        // 匹配，纯检索会返回 0 条，而那恰恰是最需要上下文的时刻。
        if (userMessages.length === 0) {
          files
            .filter(f => f.baseline)
            .sort((a, b) => a.file.localeCompare(b.file))
            .slice(0, MAX_BASELINE)
            .forEach(take)
        }

        if (text && text.length >= 2) selectRelevant(text, files).forEach(take)
        if (picked.length === 0) return assembled

        const signature = text + '\u0000' + picked.map(f => f.file).join(',')
        if (recallCache.get(session.id) === signature) return assembled
        recallCache.set(session.id, signature)
        if (recallCache.size > 8) recallCache.delete(recallCache.keys().next().value)

        const parts = picked.map(f => {
          const body = f.content.length > MAX_CHARS_PER_FILE
            ? f.content.slice(0, MAX_CHARS_PER_FILE) + '\n…（截断）'
            : f.content
          return `### ${f.file}\n${body}`
        })

        return {
          ...assembled,
          contexts: [...(assembled.contexts ?? []), {
            name: 'sage-mem:recall',
            order: 1000,
            text: `以下是与你当前问题相关的历史记忆（文件式，来自 ${MEMORY_DIR}）：\n\n${parts.join('\n\n')}`,
          }],
        }
      } catch (err) {
        // 这是整条注入链的外壳。裸吞的代价就是 :174-193 记的那个坑：权限错、编码坏、
        // frontmatter 正则哪天不匹配，表现都是「插件在、但记忆不再注入」，日志一字没有。
        // 现在只降级（返回未注入的 assembly），但一定留痕。
        warnLog(ctx, `recall injection failed: ${err?.message ?? err}`, sessionId)
        return assembled
      }
    })
  }

  /** 列出 memory 目录全部记忆文件（文件名 + 类型 + 描述 + 大小）。 */
  async listFiles() {
    const files = await scanMemoryFiles(this.ctx, '')
    return files.map(f => {
      const meta = parseFrontmatter(f.content)
      return {
        file: f.file,
        type: meta.type || 'reference',
        description: meta.description || '',
        size: f.content.length,
      }
    })
  }

  /** 读单个记忆文件全文。 */
  async readFile(name) {
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    const content = await readFile(join(MEMORY_DIR, safe), 'utf8')
    return { name: safe, content }
  }

  /**
   * 写（新增或覆盖）单个记忆文件。
   *
   * 三道闸：保留名不可写、内容必须是字符串、体积有上限；落盘走原子写。
   * 拒绝一律返回 { ok: false, error }（不是抛异常）——设置页的调用方按 ok 判定。
   */
  async writeFile(name, content) {
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    if (RESERVED_FILES.has(safe)) {
      return { ok: false, file: safe, error: `sage-mem: reserved file, edit it with the file tools: ${safe}` }
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
    await writeFileAtomic(join(MEMORY_DIR, safe), content)
    return { ok: true, file: safe }
  }

  /** 删除单个记忆文件：保留名一律拒绝（unlink 不可逆）。 */
  async deleteFile(name) {
    const safe = safeName(name)
    if (!safe) throw new Error('sage-mem: invalid file name')
    if (RESERVED_FILES.has(safe)) {
      return { ok: false, error: `sage-mem: reserved file, refusing to delete: ${safe}` }
    }
    await unlink(join(MEMORY_DIR, safe))
    return { ok: true }
  }
}

markRemote(MemoryGateway, 'listFiles', 'listFiles')
markRemote(MemoryGateway, 'readFile', 'readFile')
markRemote(MemoryGateway, 'writeFile', 'writeFile')
markRemote(MemoryGateway, 'deleteFile', 'deleteFile')

/** 提取正文第一个 `# ` 标题作为展示标题。 */
function extractTitle(content) {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---/)
  const body = m ? content.slice(m[0].length) : content
  const h1 = body.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : ''
}

/** 扫记忆目录，读全部 .md（跳过索引与 session-log），带体积与修改时间。 */
async function scanStars(ctx) {
  let entries
  try {
    entries = await readdir(MEMORY_DIR, { withFileTypes: true })
  } catch (err) {
    if (err?.code !== 'ENOENT') warnLog(ctx, `cannot scan ${MEMORY_DIR}: ${err?.message ?? err}`)
    return []
  }
  const names = entries
    .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md' && e.name !== 'session-log.md')
    .map(e => e.name)
  const loaded = await Promise.all(names.map(async (name) => {
    try {
      const full = join(MEMORY_DIR, name)
      const [content, info] = await Promise.all([readFile(full, 'utf8'), stat(full)])
      return { name, content, bytes: info.size, mtimeMs: info.mtimeMs }
    } catch (err) {
      if (err?.code !== 'ENOENT') warnLog(ctx, `cannot read ${name}: ${err?.message ?? err}`)
      return null
    }
  }))
  return loaded.filter(Boolean)
}

/**
 * 记忆星图（host 半）—— 只读扫描记忆目录，把每条记忆解析成一颗「星」。
 * 通过 TypertRemoteService 暴露两个 remote 方法给浏览器半：
 *   - starmap.listStars()  全部星（元数据，不含正文）
 *   - starmap.readFile(n)  单条记忆全文（文件名白名单校验）
 */
export class StarmapGateway extends TypertRemoteService {
  constructor(ctx) { super(ctx, 'starmap') }

  async listStars() {
    const files = await scanStars(this.ctx)
    const stars = files.map(f => {
      const meta = parseFrontmatter(f.content)
      const title = extractTitle(f.content)
      return {
        file: f.name,
        kind: meta.type || 'special',
        title: title || meta.name || (meta.description ? meta.description.slice(0, 24) : f.name.replace(/\.md$/, '')),
        desc: meta.description || '',
        bytes: f.bytes,
        mtimeMs: f.mtimeMs,
      }
    })
    return { count: stars.length, stars }
  }

  async readFile(name) {
    const raw = String(name || '')
    const safe = basename(raw)
    if (!safe || safe !== raw || !safe.endsWith('.md') || safe === 'MEMORY.md') {
      throw new Error('sage-starmap: invalid file name')
    }
    const content = await readFile(join(MEMORY_DIR, safe), 'utf8')
    return { name: safe, content }
  }
}

markRemote(StarmapGateway, 'listStars', 'listStars')
markRemote(StarmapGateway, 'readFile', 'readFile')

export default MemoryGateway
