#!/usr/bin/env node
/**
 * 「压缩前记忆提醒」的断言（`lib/precompact/*` + `lib/assembly/precompact-mount.js`）。
 *
 * 组织原则同 `mmr-test.mjs`：重点不是「效果好不好」，而是**护栏**。这个功能的
 * 失败形态特别隐蔽 —— 它不报错，只是「该提醒的时候没提醒」或「提醒晚于压缩」，
 * 而这两种从界面上都看不出来。所以按五条护栏分块：
 *
 *   1. 触发线与宿主引擎**同一条公式**（数字对表，含本机真实参数）；
 *   2. 两条提醒线永远落在触发线之前，且 warn < urge；
 *   3. 档位判定：同档只发一次、跨档只发一条；
 *   4. 开关关着时**一次测压都不做**（不是「测了但不发」）；
 *   5. 子代理会话、低于便宜门槛的步骤、被 reject 的步骤都不注入。
 *
 * 全部 mock，不碰磁盘、不真启动宿主。
 */
import {
  DEFAULT_HEADROOM_TOKENS,
  DEFAULT_THRESHOLD_RATIO,
  decideTier,
  fmtTokens,
  pct,
  resolveLines,
  resolveThreshold,
  worthMeasuring,
} from '../lib/precompact/policy.js'
import { armTier, forgetSession, isArmed, resetSession, stateOf } from '../lib/precompact/state.js'
import { NUDGE_SOURCE_KIND, renderAfterCompaction, renderNudge } from '../lib/precompact/text.js'
import { applyRuntimeExperimental, resetRuntimeExperimental } from '../lib/memory/experimental.js'
import { mountPreCompact } from '../lib/assembly/precompact-mount.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}

// 本机实测的那一组参数：窗口 1MiB、输出预留 256k、headroom 64k → 面板显示 69.3%。
const W = 1048576
const RESERVED = 256000
const MEM = '/tmp/sage-mem-test/memory'

// ── 1. 触发线：与宿主引擎同一条公式 ────────────────────────────────
console.log('== 1. 触发线（对表：本机真实参数 = 面板的 69.3%）==')
{
  const r = resolveThreshold({
    contextWindow: W,
    thresholdRatio: 0.8,
    headroomTokens: 65536,
    reservedTokens: RESERVED,
  })
  ok(r !== null && r.thresholdTokens === 727040, '阈值 = W−reserved−headroom = 727040', String(r?.thresholdTokens))
  ok(r !== null && r.enginePct === 69.3, '换算成窗口百分比 = 69.3（与 dsh-context 面板一致）', String(r?.enginePct))

  const byRatio = resolveThreshold({ contextWindow: W, reservedTokens: 0 })
  ok(byRatio !== null && byRatio.thresholdTokens === Math.floor(W * DEFAULT_THRESHOLD_RATIO), '输出预留为 0 时改由 W×0.8 封顶', String(byRatio?.thresholdTokens))

  const small = resolveThreshold({ contextWindow: 204800, reservedTokens: 131072, headroomTokens: 65536 })
  ok(small !== null && small.thresholdTokens === 8192, '小窗口下预算分支生效（204800−131072−65536=8192）', String(small?.thresholdTokens))
}

console.log('== 1b. 触发线的边界：拿不到就不猜 ==')
{
  ok(resolveThreshold({ contextWindow: undefined }) === null, '窗口未知 → null（不提醒）')
  ok(resolveThreshold({ contextWindow: 0 }) === null, '窗口 0 → null')
  ok(resolveThreshold({ contextWindow: NaN }) === null, '窗口 NaN → null')
  // 预算非正 = 引擎那个目标根本压不了（它会抛配置错），没有威胁就不打扰。
  ok(resolveThreshold({ contextWindow: 65536, reservedTokens: 0, headroomTokens: 65536 }) === null,
    '预算恰好为 0 → null（引擎那边会抛错而不是压缩）')
  const bad = resolveThreshold({ contextWindow: W, thresholdRatio: 3, headroomTokens: -1, reservedTokens: RESERVED })
  ok(bad !== null && bad.thresholdTokens === 727040, '非法 ratio / headroom 回落引擎默认值', String(bad?.thresholdTokens))
  const over = resolveThreshold({ contextWindow: W, reservedTokens: W * 2 })
  ok(over === null, '输出预留超过窗口 → null（不编一个负数预算）')
}

// ── 2. 两条提醒线 ─────────────────────────────────────────────────
console.log('== 2. 两条提醒线：都在触发线之前，warn < urge ==')
{
  const lines = resolveLines({ contextWindow: W, thresholdTokens: 727040, leadPct: 8 })
  ok(lines !== null && lines.warnTokens < 727040, '预警线在触发线之前')
  ok(lines !== null && lines.urgeTokens < 727040, '催促线也在触发线之前')
  ok(lines !== null && lines.warnTokens < lines.urgeTokens, '预警线早于催促线（warn < urge）')
  ok(lines !== null && lines.warnPct === 61.3, '提前 8 个点 → 61.3%（面板 69.3% 时）', String(lines?.warnPct))

  const wide = resolveLines({ contextWindow: W, thresholdTokens: 727040, leadPct: 20 })
  ok(wide !== null && wide.warnPct === 49.3, '提前 20 个点 → 49.3%（上限值可用）', String(wide?.warnPct))

  ok(resolveLines({ contextWindow: W, thresholdTokens: 727040, leadPct: 0 }) === null, '提前量 0 → null（不编默认值）')
  ok(resolveLines({ contextWindow: W, thresholdTokens: 727040, leadPct: undefined }) === null, '提前量缺失 → null')
  ok(resolveLines({ contextWindow: W, thresholdTokens: 0, leadPct: 8 }) === null, '阈值 0 → null')
}

// ── 3. 档位判定 ───────────────────────────────────────────────────
console.log('== 3. 档位：同档只发一次，跨档只发一条 ==')
{
  const lines = { warnTokens: 643154, urgeTokens: 699078 }
  const empty = new Set()
  ok(decideTier({ totalTokens: 500000, lines, armed: empty }) === null, '未到预警线 → null')
  ok(decideTier({ totalTokens: 650000, lines, armed: empty }) === 'warn', '到预警线 → warn')
  ok(decideTier({ totalTokens: 700000, lines, armed: empty }) === 'urge', '到催促线 → urge')
  ok(decideTier({ totalTokens: 700000, lines, armed: new Set(['urge']) }) === null, 'urge 已发 → null')
  ok(decideTier({ totalTokens: 650000, lines, armed: new Set(['warn']) }) === null, 'warn 已发 → null')
  // 一步跨两档：只发更紧急的那条，别在同一步里发两条。
  const jumped = decideTier({ totalTokens: 700000, lines, armed: new Set() })
  ok(jumped === 'urge', '一步跨两档只发 urge（不叠发 warn）')
  ok(decideTier({ totalTokens: NaN, lines, armed: empty }) === null, '非数字压力 → null')
  ok(decideTier({ totalTokens: 700000, lines: null, armed: empty }) === null, '线缺失 → null')
}

console.log('== 3b. 便宜门槛：不到半个窗口就不测压 ==')
{
  ok(worthMeasuring({ totalTokens: W * 0.5, contextWindow: W }) === true, '正好一半 → 值得测')
  ok(worthMeasuring({ totalTokens: W * 0.49, contextWindow: W }) === false, '差一点 → 不测')
  ok(worthMeasuring({ totalTokens: 100, contextWindow: undefined }) === false, '窗口未知 → 不测')
}

// ── 4. 会话账 ─────────────────────────────────────────────────────
console.log('== 4. 会话账：按会话隔离、可复位 ==')
{
  const a = { id: 'a' }
  const b = { id: 'b' }
  forgetSession(a)
  forgetSession(b)
  ok(!isArmed(a, 'warn'), '新会话初始未发光')
  armTier(a, 'urge')
  ok(isArmed(a, 'urge') && isArmed(a, 'warn'), '发过 urge 自动带上 warn（不补发重复话术）')
  ok(!isArmed(b, 'warn'), '另一个会话不受影响（按 session 记账，不按 agent）')
  armTier(a, 'after')
  ok(isArmed(a, 'after'), '事后档也能单独记')
  resetSession(a)
  ok(!isArmed(a, 'warn') && !isArmed(a, 'urge') && !isArmed(a, 'after'), 'resetSession 清空全部档（压缩后重新武装）')
  ok(stateOf(a).armed.size === 0, '复位后账本为空')
  forgetSession(a)
  forgetSession(b)
}

// ── 5. 文案 ───────────────────────────────────────────────────────
console.log('== 5. 文案：带实际数字、带记忆目录、不含模板花括号 ==')
{
  const warn = renderNudge({ tier: 'warn', memoryDir: MEM, totalTokens: 650000, windowTokens: W, enginePct: 69.3 })
  ok(warn.includes(MEM), '预警文案里有记忆目录路径')
  ok(warn.includes('69.3'), '预警文案里有引擎触发点（人能对着面板核）')
  ok(warn.includes('忽略'), '预警文案给了「没有就忽略」的退路')
  ok(!warn.includes('{{'), '预警文案不含 {{（宿主会当模板变量解析）')

  const urge = renderNudge({ tier: 'urge', memoryDir: MEM, totalTokens: 700000, windowTokens: W, enginePct: 69.3 })
  ok(urge.includes('随时'), '催促文案点明「随时会压」')
  ok(!urge.includes('{{'), '催促文案不含 {{')
  ok(urge !== warn, '两档文案不同（不是同一段重复发两次）')

  const after = renderAfterCompaction({ memoryDir: MEM })
  ok(after.includes('压缩'), '事后文案说明已经压过')
  ok(after.includes('别凭印象编'), '事后文案禁止编造（被摘要替换后模型没有原文）')
  ok(!after.includes('{{'), '事后文案不含 {{')
}

console.log('== 5b. 数字显示 ==')
{
  ok(fmtTokens(727040) === '727k', '727040 → 727k')
  ok(fmtTokens(1048576) === '1M', '1048576 → 1M（一位小数取整）')
  ok(fmtTokens(500) === '500', '小数字原样')
  ok(pct(727040, W) === 69.3, '百分比一位小数，与面板同一口径')
  ok(pct(1, 0) === 0, '窗口 0 不产生 NaN')
  ok(DEFAULT_HEADROOM_TOKENS === 65536 && DEFAULT_THRESHOLD_RATIO === 0.8, '引擎默认值常量与宿主一致')
}

// ── 6. 接线：mount 之后的行为 ────────────────────────────────────
console.log('== 6. 接线：开关 / 门槛 / 子代理 / 去重 / 复位 ==')

function mockCtx() {
  const handlers = new Map()
  const calls = { measure: 0 }
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    fiber: { assertActive() {} },
    on(name, fn, opts) { handlers.set(name, { fn, opts }) },
    get(name) {
      if (name === 'tokenMeter') {
        return {
          // 投影直读：便宜。真实宿主里 `pressureTokens` 是「上次落定请求的 prompt 大小」。
          contextPressure: (s) => ({ contextWindow: s.window, pressureTokens: s.pressure ?? s.tokens }),
          measure: (s) => { calls.measure += 1; return { totalTokens: s.tokens } },
        }
      }
      if (name === 'compaction') return { config: { thresholdRatio: 0.8, headroomTokens: 65536 } }
      return undefined
    },
  }
  return { ctx, handlers, calls }
}

function makeSession({ tokens = 0, origin, generation = 0, maxTokens = RESERVED } = {}) {
  return {
    window: W,
    tokens,
    header: { origin },
    surface: { replaceGeneration: generation },
    requestHeader: () => ({ config: { maxTokens } }),
  }
}

const payloadOf = (session) => ({ agent: { session }, signal: { aborted: false } })
const enterWith = (messages = []) => async () => ({ kind: 'enter', messages })

{
  // — 开关关：一次测压都不做（这是最重要的一条：关掉就是零开销）—
  resetRuntimeExperimental()
  const { ctx, handlers, calls } = mockCtx()
  ok(mountPreCompact(ctx, { memoryDir: MEM }).installed === true, '挂载成功')
  ok(handlers.get('agent/pre-step')?.opts?.prepend === true, 'pre-step 用 prepend（抢在压缩之前取样）')
  const pre = handlers.get('agent/pre-step').fn

  const offSession = makeSession({ tokens: 900000 })
  const offOut = await pre(payloadOf(offSession), enterWith(['m1']))
  ok(offOut.messages.length === 1, '开关关：messages 不变')
  ok(calls.measure === 0, '开关关：measure 一次都没调（不是「测了但不发」）')

  // — 打开开关（走运行期覆盖，顺带验 live 生效）—
  applyRuntimeExperimental({ preCompact: 1, preCompactLead: 8 })

  const lowSession = makeSession({ tokens: 100000 })
  calls.measure = 0
  const lowOut = await pre(payloadOf(lowSession), enterWith(['m1']))
  ok(lowOut.messages.length === 1 && calls.measure === 0, '低于便宜门槛：不测压、不注入')

  const subSession = makeSession({ tokens: 900000, origin: 'subagent' })
  calls.measure = 0
  const subOut = await pre(payloadOf(subSession), enterWith(['m1']))
  ok(subOut.messages.length === 1 && calls.measure === 0, '子代理会话：不测压、不注入')

  // — 跨过预警线：注入一条 notice —
  const hot = makeSession({ tokens: 650000 })
  const hotOut = await pre(payloadOf(hot), enterWith(['m1']))
  ok(hotOut.messages.length === 2, '跨过预警线：messages 多一条')
  const injected = hotOut.messages[1]
  ok(injected.role === 'user', '注入的是 user 消息')
  ok(injected.source?.kind === NUDGE_SOURCE_KIND, 'source.kind 是 sage-mem:precompact')
  ok(injected.source?.form === 'notice', 'source.form 是 notice（界面按通知渲染，不喧哗）')
  ok(typeof injected.id === 'string' && injected.id.length > 10, '消息带稳定 id')
  ok(injected.content[0].text.includes('61.3') || injected.content[0].text.includes('69.3'), '文案里带算出来的百分比')
  ok(hotOut.messages[0] === 'm1', '原有消息顺序没被改（追加，不是插队）')

  // — 同档不重复 —
  const again = await pre(payloadOf(hot), enterWith(['m1']))
  ok(again.messages.length === 1, '同一档位不重复提醒')

  // — 压缩发生后复位，可以再提醒 —
  const onEvent = handlers.get('session/event').fn
  onEvent(hot, { type: 'compaction/start' })
  ok(!isArmed(hot, 'warn'), 'compaction/start 后账已清')
  const afterReset = await pre(payloadOf(hot), enterWith(['m1']))
  ok(afterReset.messages.length === 2, '复位后能再次提醒')

  // — reject 步骤不注入 —
  const rejecting = async () => ({ kind: 'reject' })
  const rejected = await pre(payloadOf(makeSession({ tokens: 650000 })), rejecting)
  ok(rejected.kind === 'reject' && rejected.messages === undefined, '被 reject 的步骤不注入')

  // — 本步就压缩了：换成事后文案 —
  const flipping = makeSession({ tokens: 700000 })
  const flipNext = async () => {
    flipping.surface.replaceGeneration = 1
    return { kind: 'enter', messages: [] }
  }
  const flipOut = await pre(payloadOf(flipping), flipNext)
  ok(flipOut.messages.length === 1, '压缩发生的那一步仍会给一条')
  ok(flipOut.messages[0].content[0].text.includes('刚才这一步上下文被压缩了'), '用的是事后文案（不说「快压缩了」这种假话）')

  // — 宿主缺服务时整体降级，不抛 —
  const { ctx: bareCtx, handlers: bareHandlers } = mockCtx()
  bareCtx.get = () => undefined
  mountPreCompact(bareCtx, { memoryDir: MEM })
  const barePre = bareHandlers.get('agent/pre-step').fn
  const bareOut = await barePre(payloadOf(makeSession({ tokens: 900000 })), enterWith(['m1']))
  ok(bareOut.messages.length === 1, '宿主没有 tokenMeter 时静默跳过（不抛、不注入）')

  resetRuntimeExperimental()
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
