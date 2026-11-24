/**
 * 「压缩前提醒」的判据 —— **纯函数，零 I/O，零 import**。
 *
 * ## 为什么要把引擎的公式抄一份
 *
 * 宿主的自动压缩没有对外事件（压缩发生在 `agent/pre-step` 的 waterfall 里，
 * 由 `dsh-compaction-basic` 就地判定）。想在压缩**之前**提醒，就只能自己算
 * 「引擎会在哪一点动手」。
 *
 * 抄的不是它的实现，是它公开的判据（`dsh-compaction-basic/lib/index.js:124-132`）：
 *
 *     threshold = min( floor(W × thresholdRatio), W − reserved − headroom )
 *
 * 三个输入全部可读：`W` 来自 `ctx.tokenMeter.contextPressure()`，
 * `thresholdRatio` / `headroom` 来自 `ctx.compaction.config`（本机没配过，走默认
 * 0.8 / 65536），`reserved` 来自 `session.requestHeader().config.maxTokens`。
 *
 * **对过表的一次**：窗口 1048576、输出预留 256000、headroom 65536
 * → 727040 tokens → 69.34%，与 dsh-context 面板显示的 69.3% 一致。
 * 也就是说：用户看到面板说「69.3% 触发」，提醒就会在 61.3%（提前 8 个点）出现
 * —— 两端同一个数，不是各算一套。
 *
 * ## 为什么 `pressureBudget <= 0` 时返回 null（不提醒）
 *
 * 那个分支里引擎**会抛错而不是压缩**（`TargetPressureConfigError`，见引擎
 * `:129-131`）。没有压缩威胁却去打扰模型，是把提醒当噪声发。宁可沉默。
 *
 * ## 为什么两档而不是一档
 *
 * 一档要么太早（写完了后面还有很长，白打扰一次）、要么太晚（只剩一两步，
 * 模型来不及写）。两档给模型一次「可以写」和一次「只写要紧的」，也让人
 * 在会话里看得出趋势。
 *
 * ## 提前量为什么不在这里定边界
 *
 * `{dflt, lo, hi}` 的唯一定义处是 `memory/experimental.js` 的 `EXPERIMENTAL_SPECS`
 * （它同时供解析、面板校验、环境变量兜底三处使用）。这里再存一份 `3/20/8`
 * 就是第二份真相 —— 改一处漏一处。所以本模块对外部传入的 `leadPct` 只做
 * **合法性判定**（非法就返回 null 让调用方跳过），不自己编一个默认值。
 */

/** 引擎的压缩预留默认值（token）。源：`dsh-compaction-basic` 的 `headroomTokens ?? 65536`。 */
export const DEFAULT_HEADROOM_TOKENS = 65536

/** 引擎的触发比例默认值。源：同文件 `thresholdRatio ?? 0.8`。 */
export const DEFAULT_THRESHOLD_RATIO = 0.8

/**
 * 便宜门槛：窗口用量不到这个比例时，pre-step 连 `measure()` 都不调。
 *
 * 为什么是 0.5 而不是贴着提前量（比如 0.55）：`measure()` 是 O(surface) 的，
 * 而 pre-step 每一步都跑。大多数步数离压缩很远，用一个明显偏低的常数挡住，
 * 比「按档位动态算门槛」少一次计算，也少一处可能与档位算错的地方。
 */
export const NEAR_WINDOW_RATIO = 0.5

const isPos = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0
const isNonNeg = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0

/**
 * 复刻引擎的触发线。
 *
 * @param {object} input
 * @param {number} input.contextWindow — 该路由模型的窗口（`tokenMeter.contextPressure` 给的）
 * @param {number} [input.thresholdRatio] — 引擎的触发比例，缺失/非法回落 0.8
 * @param {number} [input.headroomTokens] — 引擎的压缩预留，缺失/非法回落 65536
 * @param {number} [input.reservedTokens] — 模型最大输出预留，缺失按 0 算
 * @returns {{thresholdTokens:number, enginePct:number}|null} 窗口未知或预算非正 → null（不提醒）
 */
export function resolveThreshold({ contextWindow, thresholdRatio, headroomTokens, reservedTokens }) {
  if (!isPos(contextWindow)) return null
  const ratio = isPos(thresholdRatio) && thresholdRatio <= 1 ? thresholdRatio : DEFAULT_THRESHOLD_RATIO
  const headroom = isNonNeg(headroomTokens) ? headroomTokens : DEFAULT_HEADROOM_TOKENS
  // 输出预留不许超过窗口本身 —— 引擎那边用 Math.min(t, e) 做同一件事（`dsh-context:305575`）。
  const reserved = Math.min(isNonNeg(reservedTokens) ? reservedTokens : 0, contextWindow)
  const byRatio = Math.floor(contextWindow * ratio)
  const byBudget = contextWindow - reserved - headroom
  // 预算非正 = 引擎这个目标根本压不了（它会抛配置错）。没有威胁就不打扰。
  if (byBudget <= 0) return null
  const thresholdTokens = Math.min(byRatio, byBudget)
  if (thresholdTokens <= 0) return null
  return { thresholdTokens, enginePct: pct(thresholdTokens, contextWindow) }
}

/**
 * 把触发线换算成两条提醒线（绝对值，token）。
 *
 * @param {object} input
 * @param {number} input.contextWindow
 * @param {number} input.thresholdTokens — `resolveThreshold` 的 `thresholdTokens`
 * @param {number} input.leadPct — 提前多少个百分点（调用方按 `EXPERIMENTAL_SPECS` 收敛过的值）
 * @returns {{warnTokens:number, urgeTokens:number, warnPct:number, urgePct:number}|null}
 *   窗口或提前量非法 → null
 */
export function resolveLines({ contextWindow, thresholdTokens, leadPct }) {
  if (!isPos(contextWindow)) return null
  if (!isNonNeg(thresholdTokens) || thresholdTokens <= 0) return null
  if (!isPos(leadPct) || leadPct >= 100) return null
  // 催促档只提前 lead/3（默认 8 → 2.67 个点），夹在预警档与触发线之间。
  const warnTokens = Math.max(0, thresholdTokens - (contextWindow * leadPct) / 100)
  const urgeTokens = Math.max(0, thresholdTokens - (contextWindow * (leadPct / 3)) / 100)
  return {
    warnTokens,
    urgeTokens,
    warnPct: pct(warnTokens, contextWindow),
    urgePct: pct(urgeTokens, contextWindow),
  }
}

/**
 * 该发哪一档。**只判「还没发过」的档**，已发过的由 `armed` 挡住。
 *
 * 一次跨两档的情形（一步吃掉很多 token）只发 `urge` —— 更紧急的那条已经把
 * 话说全了，再补一条 `warn` 是同一步里发两条噪音。
 *
 * 还有一条单调性在这里兜底：**`urge` 发过之后 `warn` 也不必再发**。`state.js`
 * 的 `armTier('urge')` 会顺手把 `warn` 一起标上，两层都说同一件事是有意的 ——
 * 判据自身正确，才不依赖调用方记得先 arm。
 *
 * @param {object} input
 * @param {number} input.totalTokens — 当前压力（压缩**之前**取的）
 * @param {{warnTokens:number, urgeTokens:number}} input.lines
 * @param {Set<string>} input.armed — 本会话已发过的档
 * @returns {'warn'|'urge'|null}
 */
export function decideTier({ totalTokens, lines, armed }) {
  if (!isNonNeg(totalTokens) || !lines) return null
  if (armed.has('urge')) return null
  if (totalTokens >= lines.urgeTokens) return 'urge'
  if (totalTokens >= lines.warnTokens && !armed.has('warn')) return 'warn'
  return null
}

/**
 * 便宜门槛：这一步值得往下算吗。
 *
 * 只跟窗口比，不与档位比 —— 它是在「还不知道触发线」的时候用的最早那层闸。
 */
export function worthMeasuring({ totalTokens, contextWindow }) {
  if (!isPos(contextWindow) || !isNonNeg(totalTokens)) return false
  return totalTokens >= contextWindow * NEAR_WINDOW_RATIO
}

/** 百分比，保留一位小数（与 dsh-context 面板的取整一致，好让人一眼对上）。 */
export function pct(tokens, window) {
  if (!isPos(window)) return 0
  return Math.min(100, Math.round((tokens / window) * 1000) / 10)
}

/**
 * token 数的显示形式（`727040` → `727k`）。
 *
 * 为什么不用 1024 进制：面板与模型都习惯看「1.0M / 69.3%」这种十进制读数，
 * 这里跟它保持一致，别让同屏出现两种口径。
 */
export function fmtTokens(n) {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  if (v >= 1e6) return `${Math.round((v / 1e6) * 10) / 10}M`
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`
  return String(Math.round(v))
}
