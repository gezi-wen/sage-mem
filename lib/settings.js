/**
 * 面板设置与「保留名原样读写」的落点（1.2.0 从 `lib/index.js` 原样搬出）。
 *
 * 这里的每一项都与 `memory/config.js` 的 `SAGE_MEM_*` 一一对应；边界值照抄那边的
 * envInt 调用（lo/hi 不许在这里另立一套）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LIMIT_SPECS, STATE_ROOT, resolveLimits } from './memory/config.js'
import { EXPERIMENTAL_SPECS, resolveExperimental } from './memory/experimental.js'
import { MAX_RAW_BYTES } from './shared/limits.js'
import { isPlainMdName } from './shared/md-name.js'
export { LIMIT_SPECS, MAX_RAW_BYTES }
import { DEFAULT_CONFIG } from './autodream/config.js'
import { readJson } from './autodream/util.js'

/** 面板设置的落点：状态根下（与 autodream 的配置、台账同级）。 */
export const SETTINGS_FILE = join(STATE_ROOT, 'settings.json')
export const RESERVED_FILE = join(STATE_ROOT, 'reserved.json')

/** 整数收敛（与 config.js 的 envInt 同一套语义）：非有限数回落默认，越界夹到边界。 */
export const clampInt = (v, spec) => (Number.isFinite(v) ? Math.max(spec.lo, Math.min(spec.hi, Math.round(v))) : spec.dflt)

/**
 * 面板 UI 设置（1.8.0；2.7.0 改成三选一）。
 *
 * ⚠️ 与 `limits` **不是一类**：上限在模块加载时就固化进常量，改完必须重启；
 * `ui.entry` 是**客户端行为** —— 界面读到值就决定注不注册侧栏 / 设置页槽位，
 * 改完立刻生效。所以它不进 `restartRequired` 的计算。
 *
 * 2.7.0：`entry` 取代 1.8.0 的布尔 `sidebarEntry`。三个值从类型上就保证
 * 「至少保留一个入口」，不需要额外的互斥校验；旧字段只读不写。
 */
export const ENTRY_MODES = Object.freeze(['both', 'sidebar', 'settings'])
export const DEFAULT_UI = Object.freeze({ entry: 'both' })

/**
 * 读出 `ui` 的**有效值**：新字段优先，旧 `sidebarEntry` 按
 * `true → both` / `false → settings` 迁移；缺失或坏值回落默认（两个都显示）。
 */
export function pendingUi(fileObj) {
  const saved = fileObj?.ui && typeof fileObj.ui === 'object' && !Array.isArray(fileObj.ui) ? fileObj.ui : {}
  if (ENTRY_MODES.includes(saved.entry)) return { entry: saved.entry }
  if (typeof saved.sidebarEntry === 'boolean') return { entry: saved.sidebarEntry ? 'both' : 'settings' }
  return { entry: DEFAULT_UI.entry }
}

/**
 * 校验 `setSettings({ ui })` 的那一段：认 `entry`（2.7.0）与旧 `sidebarEntry`（1.8.0）。
 *
 * 两个键同时给时要求语义一致（`sidebarEntry === (entry !== 'settings')`），否则报冲突 ——
 * 旧客户端写 true 的语义是「侧栏显示、设置页也保留」，和 `entry:'sidebar'` 不是一回事。
 *
 * 返回 `{ ok:true, patch }`（patch 为 null = 调用方没给 ui，或给的是空对象）；`{ ok:false, error }`。
 * 与 limits 同一套严格语义：绝不静默丢掉不认识的键。
 */
export function parseUiPatch(ui) {
  if (ui === undefined) return { ok: true, patch: null }
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return { ok: false, error: 'sage-mem: ui must be an object' }
  const patch = {}
  let hasLegacy = false
  let legacy = null
  for (const [key, value] of Object.entries(ui)) {
    if (key === 'entry') {
      if (typeof value !== 'string' || !ENTRY_MODES.includes(value)) {
        return { ok: false, error: `sage-mem: ui.entry must be one of ${ENTRY_MODES.join(' | ')}, got ${JSON.stringify(value)}` }
      }
      patch.entry = value
      continue
    }
    if (key === 'sidebarEntry') {
      if (typeof value !== 'boolean') return { ok: false, error: `sage-mem: ui.sidebarEntry must be a boolean, got ${typeof value}` }
      hasLegacy = true
      legacy = value
      continue
    }
    return { ok: false, error: `sage-mem: unknown ui setting: ${key}` }
  }
  if (hasLegacy) {
    const derived = legacy ? 'both' : 'settings'
    if (patch.entry !== undefined && patch.entry !== derived) {
      return { ok: false, error: `sage-mem: ui.entry=${patch.entry} conflicts with ui.sidebarEntry=${legacy}` }
    }
    patch.entry = derived
  }
  return { ok: true, patch: Object.keys(patch).length ? patch : null }
}

/**
 * 读 `<状态根>/settings.json`，并把「为什么没读到」说清楚。
 *
 * 缺失是正常状态（`data:null, error:''`）；坏 JSON / 不是对象返回 `error` ——
 * Q04 要求坏设置给明确诊断，而不是让调用方一律看到 `null`、分不清「没设置过」
 * 与「文件被我改坏了」。启动期的同步版本在 `memory/config.js`（语义一致）。
 */
export async function readSettingsFileDetailed() {
  let text
  try {
    text = await readFile(SETTINGS_FILE, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { data: null, error: '' }
    return { data: null, error: `读 settings.json 失败（${err?.code || err?.message}）` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { data: null, error: `settings.json 解析失败（${err?.message ?? err}）` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { data: null, error: 'settings.json 不是 JSON 对象' }
  }
  return { data: parsed, error: '' }
}

/** 读 `<状态根>/settings.json`；缺失、坏 JSON、不是对象都当「没设置」（要区分请用上面那个）。 */
export async function readSettingsFile() {
  return (await readSettingsFileDetailed()).data
}

/**
 * 待生效的 5 项上限：`settings.json` > 环境变量 > 内置默认。
 *
 * ⚠️ 判据**只有** `config.js` 的 `resolveLimits` 一份（Q04 的根因就是这里另写了一套）：
 * 启动生成常量与面板算 pending 必须共用同一份校验与优先级，否则 UI 会一直喊「待重启」。
 */
export function pendingLimits(fileObj) {
  return resolveLimits(fileObj?.limits).limits
}

/**
 * 待生效的**实验性**开关（2.9.0）。与 `pendingLimits` 共用同一条纪律：
 * 判据只有 `resolveExperimental` 一份，面板算 pending、启动算生效值都走它。
 *
 * 为什么不并进 limits：默认值与告警口径不同 —— limits 改错是「多给/少给上下文」，
 * 实验性开关改错是「该来的记忆没来」，两者在面板上要说的话也不一样。
 */
export function pendingExperimental(fileObj) {
  return resolveExperimental(fileObj?.experimental).experimental
}

/**
 * 校验 `setSettings({ experimental })` 的那一段。
 *
 * 与 limits 的严格语义一致：**绝不静默丢不认识的键**，越界直接报错（不夹到边界）——
 * 面板上手输的数字越界是笔误，静默改成别的值比报错更让人困惑。
 *
 * @returns {{ok:true, patch:object|null}|{ok:false, error:string}}
 */
export function parseExperimentalPatch(experimental) {
  if (experimental === undefined) return { ok: true, patch: null }
  if (!experimental || typeof experimental !== 'object' || Array.isArray(experimental)) {
    return { ok: false, error: 'sage-mem: experimental must be an object' }
  }
  const patch = {}
  for (const [key, value] of Object.entries(experimental)) {
    const spec = EXPERIMENTAL_SPECS[key]
    if (!spec) return { ok: false, error: `sage-mem: unknown experimental setting: ${key}` }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: `sage-mem: experimental.${key} must be a number, got ${typeof value}` }
    }
    const rounded = Math.round(value)
    if (rounded < spec.lo || rounded > spec.hi) {
      return { ok: false, error: `sage-mem: experimental.${key} must be an integer in [${spec.lo}, ${spec.hi}], got ${value}` }
    }
    patch[key] = rounded
  }
  return { ok: true, patch: Object.keys(patch).length ? patch : null }
}

/** 读 `<状态根>/reserved.json`（用户声明的保护名单）。**保留原始大小写**，好让 get 读回一致。 */
export async function readReservedFile() {
  try {
    const arr = JSON.parse(await readFile(RESERVED_FILE, 'utf8'))
    if (!Array.isArray(arr)) return []
    return arr
      .map((s) => String(s).trim())
      .filter((s) => s.endsWith('.md') && !s.includes('/') && !s.includes('\\') && !s.startsWith('..'))
  } catch {
    return []
  }
}

/**
 * 原样读写用的名字校验：只要求「单段、`.md`」。
 *
 * ⚠️ **故意不走 `safeName`**：那个函数把 `MEMORY.md` / `session-log.md` 当非记忆条目排除，
 * 而它们恰恰是 `readRaw` / `writeRaw` 的目标。这里只防路径成分与扩展名。
 */
export function rawName(raw) {
  const s = typeof raw === 'string' ? raw : ''
  if (!isPlainMdName(s)) return null
  return s
}

/** autodream 的实际配置（缺文件/坏文件回落默认值）—— 面板要显示真实策略，不能显示想象。 */
export async function autodreamConfigSnapshot() {
  const parsed = await readJson(join(STATE_ROOT, 'autodream.json'))
  return { ...DEFAULT_CONFIG, ...(parsed?.config ?? {}) }
}
