/**
 * sage-mem — 记忆桥接插件。
 *
 * 把 DSH 的事件流翻译成 sage-mem worker（fork 自 claude-mem）的 HTTP 调用：
 *   user/message        → POST /api/sessions/init        存用户 prompt
 *   tool/call + result  → POST /api/sessions/observations 捕获工具 IO
 *   turn/end            → POST /api/sessions/summarize   触发压缩
 *                         + 拉取最新记忆上下文缓存
 *   agent/session-start → 同步注入上个会话的记忆缓存（避免异步注入的时序丢失）
 *
 * 注入用「上一回合结束时的缓存」而非当场 fetch：agent/session-start 时 turn
 * 组装已经开始，异步 fetch 回来再 inject 会被 inbox 消费时序吞掉。缓存在上个
 * turn/end 时已就绪，session-start 同步注入必然生效。
 *
 * worker 不可用时静默跳过，不阻塞 DSH 主流程。worker 进程由启动脚本管理
 * （sage-bundle 阶段统一装配，先起 worker 再起 dsh）。
 *
 * ── v0.2 新增：Web 记忆管理界面支撑（feat/web-memory-editor）──
 *
 *   1. webServer 同源代理（/sage-mem/api/*）：
 *      浏览器侧 lib/client.js 在 DSH 设置页渲染「记忆管理」，通过同源
 *      fetch 访问 worker（worker 只监听 127.0.0.1:37700 且无 CORS，浏览器
 *      无法直连；由 host 半原生 fetch 中转）。
 *
 *   2. get_observations 动态工具：
 *      worker 注入头写着「Fetch details: get_observations([IDs])」，但该
 *      工具此前在 DSH 环境并不存在 —— 注入只含标题（时间线格式
 *      `ID TIME TYPE TITLE`，CLAUDE_MEM_CONTEXT_FULL_COUNT 默认 0，正文
 *      不注入），导致任何记忆的正文对新会话不可达。补上工具让正文可达。
 *
 * 这是 Sage 的第三道题：我下次应该怎么想 —— 跨会话沉淀事实与教训。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const WORKER_URL = process.env.SAGE_MEM_WORKER_URL || 'http://127.0.0.1:37700'
const REQUEST_TIMEOUT_MS = 3000
const PROJECT = 'sage' // MVP：统一记忆空间；后续可按 cwd 分项目

export const name = 'sage-mem'
export const inject = []

/**
 * 构造 UserMessage（手写，零依赖：dsh-llm 无法从 workspace 插件解析）。
 * source 必需——DSH 消费消息时访问 message.source.kind，纯字符串会崩。
 */
function pluginMessage(text, plugin) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
  }
}

/* ────────────────────────── Web 管理界面支撑 ────────────────────────── */

/** 读取请求体（JSON），空请求体返回 undefined。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
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

/**
 * 浏览器同源代理。子路径白名单一一映射 worker 端点，只暴露管理界面
 * 需要的四个操作，不做成通用转发。
 */
const WEB_BRIDGE_ROUTES = [
  { method: 'GET',    suffix: '/health',       worker: () => '/health' },
  { method: 'GET',    suffix: '/observations', worker: (q) => `/api/observations?project=${q.get('project') || PROJECT}&offset=${q.get('offset') || '0'}&limit=${q.get('limit') || '50'}` },
  { method: 'POST',   suffix: '/import',       worker: () => '/api/import' },
  { method: 'DELETE', suffix: '/observation',  worker: (_q, id) => `/api/observation/${id}` },
]

function registerWebBridge(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return // 无 web（headless 部署）：静默跳过

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/sage-mem/api',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const sub = (url.pathname.replace(/^\/sage-mem\/api/, '') || '/').replace(/\/+$/, '') || '/'
      let matched = null
      for (const r of WEB_BRIDGE_ROUTES) {
        if (req.method !== r.method) continue
        if (sub === r.suffix || sub.startsWith(r.suffix + '/')) {
          matched = { route: r, tail: sub === r.suffix ? '' : sub.slice(r.suffix.length + 1) }
          break
        }
      }
      if (matched === null) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `no such route: ${req.method} ${sub}` }))
        return
      }
      try {
        const init = { method: req.method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2) }
        if (req.method === 'POST') {
          init.headers = { 'Content-Type': 'application/json' }
          init.body = JSON.stringify(await readBody(req))
        }
        const id = matched.tail.split('/').filter(Boolean)[0] ?? ''
        const target = matched.route.worker(url.searchParams, id)
        const workerRes = await fetch(WORKER_URL + target, init)
        const text = await workerRes.text()
        res.writeHead(workerRes.status, { 'Content-Type': 'application/json' })
        res.end(text)
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `sage-mem worker unreachable: ${e?.message || e}` }))
      }
    },
  }), 'sage-mem: web bridge')
}

/**
 * 注册 get_observations 工具：按 ID 取回记忆完整内容。
 * 见文件头注释第 2 点 —— 补齐注入头承诺却缺失的正文检索通道。
 */
function registerObservationTool(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) return

  ctx.effect(() => tools.register(defineTool({
    name: 'get_observations',
    description:
      '按 ID 取回 sage-mem 跨会话记忆的完整内容（标题、正文、事实、时间）。' +
      '会话开头注入的「过往会话沉淀的记忆（sage-mem 检索）」只列出每条记忆的 ID 和标题；' +
      '当需要某条记忆的正文细节时用本工具按 ID 取回。ids 为逗号分隔的 ID 列表或 JSON 数组字符串。',
    parameters: {
      ids: {
        type: 'string',
        required: true,
        description: '要取回的记忆 ID，逗号分隔（如 "35,17"）或 JSON 数组字符串（如 "[35,17]"）',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const raw = typeof (args || {}).ids === 'string' ? args.ids.trim() : ''
      if (!raw) throw new Error('ids 不能为空')
      const res = await fetch(`${WORKER_URL}/api/observations/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: raw, orderBy: 'date_desc' }),
        signal: exec?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
      })
      if (!res.ok) throw new Error(`worker ${res.status}`)
      const data = await res.json()
      const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
      return {
        count: items.length,
        observations: items.map((o) => {
          let facts = []
          try {
            const parsed = JSON.parse(o.facts || '[]')
            if (Array.isArray(parsed)) facts = parsed
          } catch {}
          return {
            id: o.id,
            type: o.type,
            title: o.title,
            subtitle: o.subtitle === 'Manual memory' ? '手动记忆' : o.subtitle,
            narrative: o.narrative || o.text || '',
            facts,
            created_at: o.created_at,
          }
        }),
      }
    },
  })), 'sage-mem: get_observations tool')
}

/* ─────────────────────────── 既有事件桥接 ─────────────────────────── */

export function apply(ctx) {
  // tool/call 先记 callId，等 tool/result 配对后一起送 worker
  const pendingCalls = new Map()
  // 上个会话的记忆上下文（turn/end 时拉取，下个 session-start 同步注入）
  let cachedContext = ''
  // 最后一条 assistant 消息（summarize 需要）
  let lastAssistantText = ''

  async function post(path, body) {
    try {
      return await fetch(WORKER_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      return null // worker 不可用：静默跳过，不阻塞 DSH
    }
  }

  function textOf(message) {
    const blocks = Array.isArray(message?.content) ? message.content : []
    const texts = blocks.filter(b => b?.type === 'text').map(b => b.text).filter(Boolean)
    return texts.length ? texts.join('\n') : null
  }

  // 提取消息文本，兼容 content 为字符串或 text-block 数组两种形态
  function extractText(content) {
    if (typeof content === 'string') return content.trim()
    if (!Array.isArray(content)) return ''
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
      .trim()
  }

  // 0. Web 管理界面支撑（v0.2）：同源代理 + get_observations 工具
  registerWebBridge(ctx)
  registerObservationTool(ctx)

  // 0.5 按问题检索注入（核心改造）：system-prompt/assemble 是异步 waterfall，
  // 监听器可 await worker 检索。从 agent.session 拿当前 user message，
  // 按 query 检索相关记忆，作为动态 context 段注入 system prompt。
  // 这取代「只注入最近缓存」的旧行为——让 agent 第一轮就「想起」相关记忆，
  // 而不是几轮之后才从缓存里翻到。参照 CC 的 findRelevantMemories 语义。
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

      const res = await fetch(
        `${WORKER_URL}/api/search/observations?project=${encodeURIComponent(PROJECT)}&query=${encodeURIComponent(text)}`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      )
      if (!res.ok) return assembled
      const data = await res.json()
      const content = Array.isArray(data?.content)
        ? data.content.map(c => c?.text).filter(Boolean).join('\n')
        : ''
      if (!content || /Found 0/.test(content)) return assembled

      return {
        ...assembled,
        contexts: [...(assembled.contexts ?? []), {
          name: 'sage-mem:recall',
          order: 1000,
          text: `以下是与你当前问题相关的历史记忆（sage-mem 检索，按需用 get_observations 取正文）：\n\n${content}`,
        }],
      }
    } catch {
      return assembled
    }
  })

  // 1. 会话启动：同步注入上个会话的记忆缓存（兜底：问题检索注入失效时仍有一份记忆上下文）
  // 注意：事件名是 'agent/session-start'（'emit' 只是分发模式，不是事件名）
  ctx.on('agent/session-start', (payload) => {
    const { agent } = payload
    if (cachedContext) {
      agent.inject(pluginMessage(`以下是过往会话沉淀的记忆（sage-mem 检索）：\n\n${cachedContext}`, 'sage-mem'))
    }
  })

  // 2. 会话内事件：写入记忆
  ctx.on('session/event', (subject, event) => {
    const sessionId = subject?.header?.id
    if (!sessionId) return

    switch (event.type) {
      case 'user/message': {
        const text = textOf(event.data)
        if (!text) return
        post('/api/sessions/init', { contentSessionId: sessionId, project: PROJECT, prompt: text })
        break
      }
      case 'assistant/message': {
        // payload 是 { turn, step, message, usage }，message 嵌套一层
        const text = textOf(event.data?.message)
        if (text) lastAssistantText = text
        break
      }
      case 'tool/call': {
        pendingCalls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
        break
      }
      case 'tool/result': {
        const message = event.data?.message
        const call = pendingCalls.get(message?.callId)
        pendingCalls.delete(message?.callId)
        if (!call) return
        post('/api/sessions/observations', {
          contentSessionId: sessionId,
          tool_name: call.name,
          tool_input: call.arguments,
          tool_response: message.content,
        })
        break
      }
      case 'turn/end': {
        post('/api/sessions/summarize', {
          contentSessionId: sessionId,
          ...(lastAssistantText ? { last_assistant_message: lastAssistantText } : {}),
        })
        // 元认知捕获：回合最后一条 assistant 输出（装了 sage-meta 时是自检输出）
        // 作为带标记的 observation 发，worker 压缩时按 lesson 类型引导归类
        if (lastAssistantText) {
          post('/api/sessions/observations', {
            contentSessionId: sessionId,
            tool_name: 'meta/self-check',
            tool_input: { turn: event.data?.turn },
            tool_response: lastAssistantText,
          })
        }
        // 拉取最新记忆上下文，缓存给下一个会话注入
        fetch(`${WORKER_URL}/api/context/inject?project=${encodeURIComponent(PROJECT)}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
          .then(r => (r.ok ? r.text() : null))
          .then(text => {
            if (text) cachedContext = text
          })
          .catch(() => {})
        break
      }
    }
  })
}
