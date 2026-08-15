/**
 * sage-mem — 文件式记忆插件（CC 原生方式）。
 *
 * 记忆存在本地 markdown 文件目录（frontmatter + 正文，4 类），不是数据库。
 * 本插件只做一件事：按问题检索相关记忆文件，注入 system prompt 让 agent
 * 第一轮就「想起」。
 *
 * 写入靠 AGENTS.md 的「记忆使用」规则引导 agent 自己判断 + 用文件工具写
 * memory 目录——透明、可检查、防膨胀。
 *
 * 无 worker、无 SQLite、无端口、无常驻进程。这是与旧 sqlite-worker 版的
 * 本质区别（旧版见 git 分支 `sqlite-worker`）。
 */

import { homedir } from 'node:os'
import { readFile, readdir, writeFile, unlink } from 'node:fs/promises'
import { join, basename } from 'node:path'

const MEMORY_DIR = process.env.SAGE_MEM_DIR || join(homedir(), '.sage-mem', 'memory')
const MAX_RESULTS = 5
const MAX_CHARS_PER_FILE = 1500

export const name = 'sage-mem'
export const inject = []

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

/** 扫 memory 目录，读回全部记忆文件的正文（跳过索引与子目录）。 */
async function scanMemoryFiles() {
  try {
    const entries = await readdir(MEMORY_DIR, { withFileTypes: true })
    const names = entries
      .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md')
      .map(e => e.name)
    const loaded = await Promise.all(names.map(async (name) => {
      try {
        const content = await readFile(join(MEMORY_DIR, name), 'utf8')
        return { file: name, content }
      } catch {
        return null
      }
    }))
    return loaded.filter(Boolean)
  } catch {
    return []
  }
}

/** 按得分选相关文件，降序取 top N。 */
function selectRelevant(query, files) {
  return files
    .map(f => ({ ...f, score: score(query, f.content) }))
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
}

/* ───────────────────── Web 文件管理器支撑 ───────────────────── */

/** 解析 frontmatter 的 name/description/type（兼容顶层与 metadata 嵌套两种 type）。 */
function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return { name: '', description: '', type: '' }
  const body = m[1]
  const grab = (key) => {
    const hit = body.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    if (!hit) return ''
    return hit[1].replace(/^["']|["']$/g, '').trim()
  }
  let type = grab('type')
  if (!type) {
    const nested = body.match(/^metadata:\s*\n(?:\s+[^\n]+\n)*?\s+type:\s*(\S+)/m)
    if (nested) type = nested[1]
  }
  return { name: grab('name'), description: grab('description'), type }
}

/** 读 JSON 请求体，空体返回 undefined。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

/** 防路径穿越：只取 basename，且必须在 memory 目录内。 */
function safeName(raw) {
  const name = basename(String(raw || ''))
  if (!name || !name.endsWith('.md') || name === 'MEMORY.md') return null
  return name
}

/**
 * 浏览器同源代理：/sage-mem/api/* 映射到 memory 目录的文件操作。
 * 只暴露四个动作（列表/读/写/删），不做通用文件转发。
 */
function registerWebBridge(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return // 无 web（headless）：静默跳过

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/sage-mem/api',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const sub = (url.pathname.replace(/^\/sage-mem\/api/, '') || '/').replace(/\/+$/, '') || '/'
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      try {
        // 列表
        if (sub === '/files' && req.method === 'GET') {
          const files = await scanMemoryFiles()
          const items = files.map(f => {
            const meta = parseFrontmatter(f.content)
            return { file: f.file, type: meta.type || 'reference', description: meta.description || '', size: f.content.length }
          })
          send(200, { items })
          return
        }
        // 读单个
        if (sub === '/file' && req.method === 'GET') {
          const name = safeName(url.searchParams.get('name'))
          if (!name) return send(400, { error: 'invalid name' })
          const content = await readFile(join(MEMORY_DIR, name), 'utf8')
          send(200, { name, content })
          return
        }
        // 写（新增/更新）
        if (sub === '/file' && req.method === 'POST') {
          const body = await readBody(req)
          const name = safeName(body?.name)
          if (!name) return send(400, { error: 'invalid name' })
          await writeFile(join(MEMORY_DIR, name), String(body?.content ?? ''), 'utf8')
          send(200, { ok: true, file: name })
          return
        }
        // 删
        if (sub === '/file' && req.method === 'DELETE') {
          const name = safeName(url.searchParams.get('name'))
          if (!name) return send(400, { error: 'invalid name' })
          await unlink(join(MEMORY_DIR, name))
          send(200, { ok: true })
          return
        }
        send(404, { error: `no such route: ${req.method} ${sub}` })
      } catch (e) {
        send(500, { error: String(e?.message || e) })
      }
    },
  }), 'sage-mem: web bridge')
}

export function apply(ctx) {
  // Web 文件管理器支撑（设置页「记忆管理」）
  registerWebBridge(ctx)

  // 按问题检索注入：system-prompt/assemble 是异步 waterfall，监听器可 await。
  // 从 agent.session 拿当前 user message，扫 memory 目录按双字匹配选相关
  // 文件，读全文作为动态 context 段注入——让 agent 第一轮就「想起」。
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    try {
      const agent = context?.agent
      const session = agent?.session
      if (!session || typeof session.deriveMessages !== 'function') return assembled
      const messages = [...session.deriveMessages()]
      const lastUser = messages.reverse().find(m => m?.role === 'user')
      const text = extractText(lastUser?.content)
      if (!text || text.length < 2) return assembled

      const files = await scanMemoryFiles()
      const relevant = selectRelevant(text, files)
      if (relevant.length === 0) return assembled

      const parts = relevant.map(f => {
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
    } catch {
      return assembled
    }
  })
}
