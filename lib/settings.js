/**
 * 面板设置与「保留名原样读写」的落点（1.2.0 从 `lib/index.js` 原样搬出）。
 *
 * 这里的每一项都与 `memory/config.js` 的 `SAGE_MEM_*` 一一对应；边界值照抄那边的
 * envInt 调用（lo/hi 不许在这里另立一套）。
 */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { STATE_ROOT } from './memory/config.js'
import { DEFAULT_CONFIG } from './autodream/config.js'
import { readJson } from './autodream/util.js'

/**
 * 面板可改的 5 项注入上限 —— 与 `memory/config.js` 里的 `SAGE_MEM_*` 一一对应。
 * 边界值照抄那边的 envInt 调用（lo/hi 不许在这里另立一套）。
 */
export const LIMIT_SPECS = {
  maxResults: { env: 'SAGE_MEM_MAX_RESULTS', dflt: 10, lo: 1, hi: 30 },
  maxChars: { env: 'SAGE_MEM_MAX_CHARS', dflt: 1500, lo: 200, hi: 20000 },
  maxBaseline: { env: 'SAGE_MEM_MAX_BASELINE', dflt: 8, lo: 1, hi: 50 },
  maxSessionBytes: { env: 'SAGE_MEM_MAX_SESSION_BYTES', dflt: 60 * 1024, lo: 4096, hi: 512 * 1024 },
  staleDays: { env: 'SAGE_MEM_STALE_DAYS', dflt: 1, lo: 0, hi: 365 },
}

/** 面板设置的落点：状态根下（与 autodream 的配置、台账同级）。 */
export const SETTINGS_FILE = join(STATE_ROOT, 'settings.json')
export const RESERVED_FILE = join(STATE_ROOT, 'reserved.json')

/**
 * `writeRaw` 的体积上限（4 MB）。
 *
 * ⚠️ **故意不复用 `MAX_FILE_BYTES`（512 KB）**：保留名里就有 `session-log.md` 这种追加型
 * 流水，它天然长得比单条记忆大得多（实测已 > 512 KB）。沿用小上限 = 用户永远存不回去。
 */
export const MAX_RAW_BYTES = 4 * 1024 * 1024

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
  if (!s || basename(s) !== s) return null
  // `:` 是 NTFS 交替数据流的分隔符：`MEMORY.md:evil.md` 能过扩展名判据，落盘却是写到
  // 索引的隐藏流上（`readdir` 看不见）。与 `safeName` 同一条理由，这里也要拒。
  if (s.includes(':')) return null
  return /\.md$/i.test(s) ? s : null
}

/** autodream 的实际配置（缺文件/坏文件回落默认值）—— 面板要显示真实策略，不能显示想象。 */
export async function autodreamConfigSnapshot() {
  const parsed = await readJson(join(STATE_ROOT, 'autodream.json'))
  return { ...DEFAULT_CONFIG, ...(parsed?.config ?? {}) }
}
