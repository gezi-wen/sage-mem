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
 * 这是 Sage 的第三道题：我下次应该怎么想 —— 跨会话沉淀事实与教训。
 */

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

  // 1. 会话启动：同步注入上个会话的记忆缓存
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
