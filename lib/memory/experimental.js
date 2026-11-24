/**
 * 实验性开关 —— 只放「还没被长期使用验证」的配置：会改变**选出哪些记忆**的（mmr），
 * 或会改变**界面入口**的（todoBoard）。
 *
 * 为什么与 `LIMIT_SPECS` 分开（而不是塞进 limits）：
 *   - `limits` 管的是**预算**（条数、字数、会话总量）。改错了，代价是「多给或少给上下文」。
 *   - 这里管的是**选材 / 界面**。改错了，代价是「该来的那条记忆没来」或「多出一个页签」，
 *     而不是上下文变长。两者该有不同的默认值、不同的诊断，和面板上不同的说法。
 *
 * 取值统一用**整数**（0~100 表示百分比），三处原因：
 *   1. 与 `parseLimitValue` 的整数语义共用一套校验，不必为浮点再造一份；
 *   2. `settings.json` 里手写 `0.7` 与 `"70"` 的差异不再影响解析；
 *   3. 0 天然表示「关闭」，与「没配过」同义 —— 实验性功能必须默认关。
 */
import { STARTUP_SETTINGS, parseLimitValue } from './config.js'

/**
 * 实验性开关的**唯一定义**（值 + 边界）。
 *
 * - `mmr`：注入链的 MMR 去重强度（百分比）。`0` = 关闭；`70` = λ0.7（相关度 70% / 去重 30%）。
 *   取值越接近 100 越接近「纯按相关度」，越接近 0 越接近「只求不重复」。
 *   为什么默认 0：它是**选材**变化，会改变「哪些记忆被端上来」，必须由用户显式打开。
 */
export const EXPERIMENTAL_SPECS = {
  mmr: { env: 'SAGE_MEM_MMR', dflt: 0, lo: 0, hi: 100 },
  // 2.11.0：右侧栏「待办清单」看板（0 = 关闭 / 1 = 开启）。它不是选材开关，而是**界面入口**：
  // 消费者是 client 半（注册右侧栏页签 + 开始页卡片），所以标 `live: true` —— 改完立刻生效，
  // 不计入 `restartRequired`（组合根按这个标记跳过它，见 `lib/index.js` 的 restartRequired）。
  // 之所以仍住在 EXPERIMENTAL_SPECS：同一套持久化、同一套环境变量优先级、同一处面板。
  todoBoard: { env: 'SAGE_MEM_TODO_BOARD', dflt: 0, lo: 0, hi: 1, live: true },
  // 2.17.0：**压缩前记忆提醒**（0 = 关闭 / 1 = 开启）。宿主自动压缩前若干步，往本轮注入一条
  // 提醒，让模型先把该跨会话留的东西写下来。消费者是 host 半的 `agent/pre-step`（见
  // `lib/assembly/precompact-mount.js`），但标 `live: true` —— 监听器每步现读生效值，
  // 不需要重启。挂载是常驻的、极便宜的一层壳（开关关着时第一步就返回），
  // 所以「先挂上、再开关」不会带来任何后台开销。
  preCompact: { env: 'SAGE_MEM_PRECOMPACT', dflt: 0, lo: 0, hi: 1, live: true },
  // 提前量：在「引擎预计触发点」之前多少个**百分点**提醒。默认 8（面板显示 69.3% 时
  // 约在 61.3% 提醒）。为什么是百分点而不是「触发线的百分之几」：宿主面板与压缩引擎
  // 用的是同一个窗口百分比（`precompact/policy.js` 复刻了那条公式），用百分点能让人
  // 直接对着面板读数理解「还差 8 个点」。
  preCompactLead: { env: 'SAGE_MEM_PRECOMPACT_LEAD', dflt: 8, lo: 3, hi: 20, live: true },
}

/**
 * 解析实验性设置：持久设置 > 环境变量 > 内置默认。
 *
 * 与 `resolveLimits` 同构（含诊断口径）：非法值回落、越界收敛并各留一条说明。
 * 缺失（`hasOwnProperty` 为假）是正常状态，不产生诊断。
 *
 * @param {object|null|undefined} saved — `settings.json` 的 `experimental` 段
 * @param {object} [env] — 默认 `process.env`（测试可注入）
 * @returns {{experimental: Record<string, number>, diagnostics: string[]}}
 */
export function resolveExperimental(saved, env = process.env) {
  const experimental = {}
  const diagnostics = []
  const savedObj = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null
  for (const [key, spec] of Object.entries(EXPERIMENTAL_SPECS)) {
    const hasSaved = savedObj !== null && Object.prototype.hasOwnProperty.call(savedObj, key)
    if (hasSaved) {
      const value = parseLimitValue(savedObj[key], spec)
      if (value !== undefined) {
        if (String(savedObj[key]).trim() !== String(value)) {
          diagnostics.push(`settings.json 的 experimental.${key}=${JSON.stringify(savedObj[key])} 不是 [${spec.lo}, ${spec.hi}] 内的整数，已收敛为 ${value}`)
        }
        experimental[key] = value
        continue
      }
      diagnostics.push(`settings.json 的 experimental.${key}=${JSON.stringify(savedObj[key])} 不是有效数字，已回落环境变量/默认值`)
    }
    const envValue = parseLimitValue(env?.[spec.env], spec)
    experimental[key] = envValue === undefined ? spec.dflt : envValue
  }
  return { experimental, diagnostics }
}

/** 启动期解析结果（与 `config.js` 共用同一份 `settings.json` 快照，不重复读盘）。 */
export const STARTUP_EXPERIMENTAL = resolveExperimental(STARTUP_SETTINGS.data?.experimental)
export const STARTUP_EXPERIMENTAL_DIAGNOSTICS = [...STARTUP_EXPERIMENTAL.diagnostics]

/** MMR 强度百分比（0 = 关闭）。 */
export const MMR_PERCENT = STARTUP_EXPERIMENTAL.experimental.mmr

/** 待办清单看板开关（0/1）。**只有 client 半消费它** —— 见 `EXPERIMENTAL_SPECS.todoBoard`。 */
export const TODO_BOARD_ON = STARTUP_EXPERIMENTAL.experimental.todoBoard

/**
 * 注入链用的 λ。`0` 表示关闭 —— `selectRelevant` 见到 `(lambda > 0)` 才重排。
 * 调用点（`lib/recall/select.js`）以它为默认值，因此「面板/环境变量改了 → 下一次注入生效」。
 */
export const MMR_LAMBDA = MMR_PERCENT / 100

/**
 * 运行期覆盖层（2.17.0）：面板改了 `live: true` 的开关后，host 侧**不必重启**
 * 就能读到新值。
 *
 * 为什么需要这一层：`STARTUP_EXPERIMENTAL` 是模块加载时算出来的常量，改设置
 * 只能等重启。而「压缩前提醒」的消费者是 `agent/pre-step` 监听器，它每一步都跑 ——
 * 让它去读 `settings.json` 就是每步一次磁盘 IO。这里换成「写设置时顺手把新值
 * 塞进内存」，零 IO、零延迟。
 *
 * ⚠️ **不是第二套解析**：进来的补丁已经过 `parseExperimentalPatch` 与
 * `resolveExperimental` 的同一套 `parseLimitValue`，这里只做「收下」动作。
 * 判据仍只有一处。
 */
let runtimeOverride = null

/**
 * 收下面板刚保存的补丁。未知键与非法值直接丢弃（上游已经校验过一遍，这里只兜底）。
 *
 * @param {Record<string, number>|null|undefined} patch
 */
export function applyRuntimeExperimental(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return
  const next = { ...(runtimeOverride ?? {}) }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    const spec = EXPERIMENTAL_SPECS[key]
    if (!spec) continue
    const parsed = parseLimitValue(value, spec)
    if (parsed === undefined) continue
    next[key] = parsed
    changed = true
  }
  if (changed) runtimeOverride = next
}

/**
 * 读一个实验性开关的**当前实际生效值**。
 *
 * 优先级：运行期覆盖（仅 `live: true`）> 启动快照 > 内置默认。
 *
 * ⚠️ **非 `live` 的开关不吃运行期覆盖**，这一点是刻意的，也是 `panel-api-test`
 * 逼出来的：`mmr` 这类开关的生效点在模块加载时（注入链每步都读那份常量），
 * 面板改完必须重启才真的变。如果这里也返回覆盖值，`getSettings()` 就会报
 * 「已生效 35」，而「待生效 35 / 当前生效 0」那行说明还在同一屏上 —— 同一个界面
 * 说两套话，比不说更糟。
 *
 * 所以本函数回答的是「**现在真的按哪个值在跑**」，不是「用户最近保存了什么」。
 * 后者是 `pendingExperimental` 的事。
 *
 * @param {string} key — `EXPERIMENTAL_SPECS` 的键
 * @returns {number|undefined}
 */
export function liveExperimental(key) {
  const spec = EXPERIMENTAL_SPECS[key]
  if (!spec) return undefined
  const startup = STARTUP_EXPERIMENTAL.experimental[key] ?? spec.dflt
  if (!spec.live) return startup
  const live = runtimeOverride?.[key]
  return live !== undefined ? live : startup
}

/** 测试用：把运行期覆盖清回「只有启动快照」的状态。 */
export function resetRuntimeExperimental() {
  runtimeOverride = null
}
