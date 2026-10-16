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
 * 一次模型调用的输出上限。
 *
 * ⚠️ **调大它解决不了「长报告被截断」**：报告长度没有上界，调大只是把墙往后挪一格
 * （2026-10-17 实测：10-01 的报告 5532 字符、10-13 是 5957，都完整收尾；这次 8553 字符
 * 就断在半个句子里）。真正的处理是撞上它时**接着写** —— 见下面的 MAX_CONTINUATIONS。
 */
const MAX_TOKENS_PER_CALL = 4096
/** 撞上单次上限后最多续写几轮：够把最后一段写完，又不至于让一次跑飞掉。 */
const MAX_CONTINUATIONS = 3
/** 续写指令。三条禁令缺一不可 —— 重写整篇 / 重新开头 / 道歉寒暄，模型都干得出来。 */
const CONTINUE_PROMPT =
  '（上一条回答被输出长度上限截断了。请**从中断处继续写**，不要重复已经写过的内容，不要重新开头，不要解释或道歉，直接接着写。）'

/** 取这一次调用里的全部文字块，拼成一段。 */
function textOf(asm) {
  return asm
    .blocks()
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}

/**
 * 极简 agent 循环：模型 → 工具 → 结果回灌 → 再问，直到模型不再要工具或触顶。
 *
 * 每一步都把「这一轮要了什么工具」记进 stepLog，设置面板显示的就是这个。
 * **一步可以包含多次模型调用**：撞上输出上限时接着写，而不是把半篇当成品交出去。
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
  // 截断与续写的账：`continuations` 是「确实接着写过几轮」，`truncated` 是「续写用尽还是没写完」。
  // 两个都要进声明与报告 —— 「报告是残篇却报成功」正是这一版要修的那处静默。
  let continuations = 0
  let truncated = false
  let lastStep = 0
  const allToolsUsed = []
  const addUsage = (u) => {
    if (!u) return
    tokensIn += u.inputTokens ?? 0
    tokensOut += u.outputTokens ?? 0
  }

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) throw new Error('autodream 被取消')
    // 让工具执行器知道现在是第几轮：模型没自述缘由时，声明要靠这个追溯「哪一步干的」。
    if (typeof runner.setStep === 'function') runner.setStep(step)
    this.phase = `第 ${step} 轮：等待模型`
    lastStep = step

    let asm = await this.streamOnce(llm, {
      provider,
      model,
      system,
      messages,
      tools: toolSchemas,
      maxTokens: MAX_TOKENS_PER_CALL,
      signal,
    })
    addUsage(asm.usage)

    // 一段 = 一次模型调用产出的文字。正常只有一段；撞上输出上限时接着写下一段。
    let text = ''
    let calls = []
    let segment = 0
    for (;;) {
      const segText = textOf(asm)
      const blocks = asm.blocks()
      const segCalls = blocks.filter((b) => b.type === 'tool-call')
      // 只有第一段可能带工具调用：被截断时 BlockAssembler 已经丢掉了参数残缺的 tool-call。
      if (segment === 0) calls = segCalls
      text += segText
      transcript.push({
        step,
        text: segText,
        tools: segCalls.map((c) => c.name),
        ...(segment ? { continuation: true } : {}),
      })
      this.stepLog.push({
        step,
        tools: segCalls.map((c) => c.name),
        chars: segText.length,
        at: Date.now(),
        ...(segment ? { continuation: true } : {}),
      })
      segment += 1
      if (asm.finish.kind !== 'max-tokens') break
      // 空段没法接着写；续写名额用尽也一样 —— 两种都算「这篇没写完」，要如实记下来。
      if (!segText || continuations >= MAX_CONTINUATIONS) {
        truncated = true
        break
      }
      continuations += 1
      messages.push(assistantMessage(blocks, provider, model))
      messages.push(userMessage(CONTINUE_PROMPT))
      this.phase = `第 ${step} 轮：输出撞上单次上限，续写 ${continuations}/${MAX_CONTINUATIONS}`
      asm = await this.streamOnce(llm, {
        provider,
        model,
        system,
        messages,
        tools: toolSchemas,
        maxTokens: MAX_TOKENS_PER_CALL,
        signal,
      })
      addUsage(asm.usage)
    }

    if (text) finalText = text
    if (asm.finish.kind === 'error') {
      throw new Error(`模型返回错误：${asm.finish.failure?.message ?? '未知'}`)
    }
    if (!calls.length) break

    messages.push(assistantMessage(asm.blocks(), provider, model))
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

  if (truncated) {
    // 过程清单要以「没写完」收尾：否则报告里那半句话看起来只是模型话说到一半。
    transcript.push({
      step: lastStep,
      text: `（输出撞上单次长度上限，续写 ${continuations} 轮后仍未写完 —— 上面这段是残篇，后文缺失）`,
      tools: [],
    })
  }

  return {
    transcript,
    finalText,
    tokensIn,
    tokensOut,
    continuations,
    truncated,
    toolsUsed: allToolsUsed,
    touched: runner.touchedFiles(),
    changes: runner.changes(),
    // warnings = 改动**没发生**（被拒）；notes = 改动**发生了**但有话要说。两者不可混。
    warnings: runner.warnings(),
    notes: typeof runner.notes === 'function' ? runner.notes() : [],
  }
}

// ────────────────────────────── 声明（整理交代） ──────────────────────────────
