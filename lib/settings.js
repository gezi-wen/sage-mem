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
