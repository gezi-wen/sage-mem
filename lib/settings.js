/**
 * 面板设置与「保留名原样读写」的落点（1.2.0 从 `lib/index.js` 原样搬出）。
 *
 * 这里的每一项都与 `memory/config.js` 的 `SAGE_MEM_*` 一一对应；边界值照抄那边的
 * envInt 调用（lo/hi 不许在这里另立一套）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LIMIT_SPECS, STATE_ROOT } from './memory/config.js'
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
 * 面板 UI 设置（1.8.0）。
 *
 * ⚠️ 与 `limits` **不是一类**：上限在模块加载时就固化进常量，改完必须重启；
 * `ui.sidebarEntry` 是**客户端行为** —— 界面读到值就决定注不注册侧栏槽位，
 * 改完立刻生效。所以它不进 `restartRequired` 的计算。
 */
export const DEFAULT_UI = Object.freeze({ sidebarEntry: true })

/** 读出 `ui` 的**有效值**：文件里没有 / 坏对象 / 不是布尔 → 一律回落默认（开）。 */
export function pendingUi(fileObj) {
  const saved = fileObj?.ui && typeof fileObj.ui === 'object' && !Array.isArray(fileObj.ui) ? fileObj.ui : {}
  return { sidebarEntry: typeof saved.sidebarEntry === 'boolean' ? saved.sidebarEntry : DEFAULT_UI.sidebarEntry }
}

/**
 * 校验 `setSettings({ ui })` 的那一段：**只认 `sidebarEntry` 一个键**，值必须是布尔。
 *
 * 返回 `{ ok:true, patch }`（patch 为 null = 调用方没给 ui，或给的是空对象）；`{ ok:false, error }`。
 * 与 limits 同一套严格语义：绝不静默丢掉不认识的键。
 */
export function parseUiPatch(ui) {
  if (ui === undefined) return { ok: true, patch: null }
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return { ok: false, error: 'sage-mem: ui must be an object' }
  const patch = {}
  for (const [key, value] of Object.entries(ui)) {
    if (key !== 'sidebarEntry') return { ok: false, error: `sage-mem: unknown ui setting: ${key}` }
    if (typeof value !== 'boolean') return { ok: false, error: `sage-mem: ui.sidebarEntry must be a boolean, got ${typeof value}` }
    patch.sidebarEntry = value
  }
  return { ok: true, patch: Object.keys(patch).length ? patch : null }
}

/** 读 `<状态根>/settings.json`；缺失、坏 JSON、不是对象都当「没设置」。 */
export async function readSettingsFile() {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 待生效的 5 项上限：`settings.json` > 环境变量 > 内置默认。 */
export function pendingLimits(fileObj) {
  const out = {}
  const saved = fileObj?.limits && typeof fileObj.limits === 'object' ? fileObj.limits : {}
  for (const [key, spec] of Object.entries(LIMIT_SPECS)) {
    const fromFile = Number(saved[key])
    if (Number.isFinite(fromFile)) {
      out[key] = clampInt(fromFile, spec)
      continue
    }
    const raw = process.env[spec.env]
    out[key] = clampInt(raw === undefined || raw === '' ? NaN : Number(raw), spec)
  }
  return out
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
