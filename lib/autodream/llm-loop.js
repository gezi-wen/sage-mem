/**
 * autodream —— 极简 agent 循环：流式块装配、消息构造、单次调用与多步循环。
 *
 * 本文件里的函数都是 `AutodreamEngine` 的方法体：`engine.js` 里保留同名同签名的方法，
 * 用 `xxxMod.name.call(this, …)` 转发进来 —— 所以函数体里的 `this` 就是引擎实例，
 * 与拆分前完全一致，没有引入任何模块级可变状态。
 *
 * 之所以不用真正的子代理：见 engine.js 顶部第 2 条设计决定。
 */

import { buildAutodreamSystemPrompt, buildAutodreamUserPrompt } from '../autodream-prompt.js'
import { randomUUID } from 'node:crypto'

export class BlockAssembler {
  constructor() {
    this.partials = new Map()
    this.order = []
    this._usage = null
    this._finish = null
  }

  push(chunk) {
    switch (chunk?.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, { blockType: chunk.blockType, text: '', args: '' })
        }
        return
      }
      case 'text-delta': {
        const p = this.ensure(chunk.index, 'text')
        if (p.block) return
        p.text += chunk.text
        return
      }
      case 'reasoning-delta':
        return
      case 'tool-call-delta': {
        const p = this.ensure(chunk.index, 'tool-call')
        if (p.block) return
        p.callId = chunk.id
        if (chunk.name) p.callName = chunk.name
        p.args += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const p = this.ensure(chunk.index, chunk.block?.type ?? 'text')
        if (p.block) return
        p.block = chunk.block
        return
      }
      case 'usage':
        this._usage = chunk.usage
        return
      case 'finish':
        this._finish = chunk.reason
        return
      default:
        return
    }
  }

  ensure(index, blockType) {
    let p = this.partials.get(index)
    if (!p) {
      p = { blockType, text: '', args: '' }
      this.partials.set(index, p)
      this.order.push(index)
    }
    return p
  }

  assemble(p, index) {
    if (p.block) return p.block
    switch (p.blockType) {
      case 'text':
        return { type: 'text', text: p.text }
      case 'reasoning':
        return { type: 'reasoning', text: p.text }
      case 'tool-call':
        return { type: 'tool-call', id: p.callId ?? `call-${index}`, name: p.callName ?? '', arguments: p.args }
      default:
        return null
    }
  }

  blocks() {
    const all = this.order.map((i) => this.assemble(this.partials.get(i), i)).filter(Boolean)
    if (this.finish.kind === 'max-tokens') return all.filter((b) => b.type !== 'tool-call')
    return all
  }

  get usage() {
    return this._usage
  }

  get finish() {
    return this._finish ?? { kind: 'stop' }
  }
}

/** 造一条 user 消息（字段形状遵循 `ctx.llm.stream()` 的消息协议）。 */
export function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'sage-mem-autodream' }, id: randomUUID() }
}

/** 造一条 assistant 消息，把模型这一轮的块原样回灌进历史。 */
export function assistantMessage(blocks, provider, model) {
  return {
    role: 'assistant',
    content: blocks,
    source: { kind: 'model', provider, model },
    id: randomUUID(),
  }
}

/** 造一条工具结果消息。callId 是把结果接回那次调用的唯一凭据。 */
export function toolMessage(callId, text, isError) {
  const msg = {
    role: 'tool',
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId },
    toolCallId: callId,
    id: randomUUID(),
  }
  if (isError) msg.isError = true
  return msg
}

/**
 * 跑一次模型调用，返回组装好的块。
 * @returns {Promise<BlockAssembler>}
 */
export async function streamOnce(llm, req) {
  const asm = new BlockAssembler()
  const options = {
    provider: req.provider,
    model: req.model,
    system: req.system,
    messages: req.messages,
    maxTokens: req.maxTokens,
    signal: req.signal,
    purpose: 'session-title', // 标记为非交互式调用，避免被当成主对话轮次记账
  }
  if (req.tools && req.tools.length) options.tools = req.tools
  for await (const chunk of llm.stream(options)) {
    asm.push(chunk)
  }
  return asm
}

/**
 * 极简 agent 循环：模型 → 工具 → 结果回灌 → 再问，直到模型不再要工具或触顶。
 *
 * 每一步都把「这一轮要了什么工具」记进 stepLog，设置面板显示的就是这个。
 */
export async function agentLoop(cfg, runOpts) {
  const { provider, model, toolSchemas, runner, maxSteps, tokenBudget, signal } = runOpts
  const llm = this.svc('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用，autodream 无法运行')

  const system = buildAutodreamSystemPrompt({
    apply: cfg.apply,
    withSessions: cfg.source === 'memory+sessions',
    reservedFiles: this.reservedFiles,
  })
  const userText = buildAutodreamUserPrompt({
    memoryDir: this.memoryDir,
    apply: cfg.apply,
    hoursSince: runOpts.hoursSince ?? 0,
    sessionCount: runOpts.sessionCount ?? 0,
    now: Date.now(),
  })
  const messages = [userMessage(userText)]

  const transcript = []
  let tokensIn = 0
  let tokensOut = 0
  let finalText = ''
  const allToolsUsed = []

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) throw new Error('autodream 被取消')
    // 让工具执行器知道现在是第几轮：模型没自述缘由时，声明要靠这个追溯「哪一步干的」。
    if (typeof runner.setStep === 'function') runner.setStep(step)
    this.phase = `第 ${step} 轮：等待模型`
    const asm = await this.streamOnce(llm, {
      provider,
      model,
      system,
      messages,
      tools: toolSchemas,
      maxTokens: 4096,
      signal,
    })
    const usage = asm.usage
    if (usage) {
      tokensIn += usage.inputTokens ?? 0
      tokensOut += usage.outputTokens ?? 0
    }
    const blocks = asm.blocks()
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
    const calls = blocks.filter((b) => b.type === 'tool-call')
    if (text) finalText = text
    transcript.push({ step, text, tools: calls.map((c) => c.name) })
    this.stepLog.push({ step, tools: calls.map((c) => c.name), chars: text.length, at: Date.now() })

    if (asm.finish.kind === 'error') {
      throw new Error(`模型返回错误：${asm.finish.failure?.message ?? '未知'}`)
    }
    if (!calls.length) break

    messages.push(assistantMessage(blocks, provider, model))
    for (const call of calls) {
      let args = {}
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {}
      } catch {
        args = {}
      }
      this.phase = `第 ${step} 轮：${call.name}`
      const out = await runner.run(call.name, args)
      allToolsUsed.push(call.name)
      messages.push(toolMessage(call.id, out, /^(错误|工具执行失败)/.test(out)))
    }

    if (tokensIn + tokensOut > tokenBudget) {
      transcript.push({ step: step + 1, text: `（已达 token 预算 ${tokenBudget}，提前收工）`, tools: [] })
      break
    }
  }

  return {
    transcript,
    finalText,
    tokensIn,
    tokensOut,
    toolsUsed: allToolsUsed,
    touched: runner.touchedFiles(),
    changes: runner.changes(),
    // warnings = 改动**没发生**（被拒）；notes = 改动**发生了**但有话要说。两者不可混。
    warnings: runner.warnings(),
    notes: typeof runner.notes === 'function' ? runner.notes() : [],
  }
}

// ────────────────────────────── 声明（整理交代） ──────────────────────────────
