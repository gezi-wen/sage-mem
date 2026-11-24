/**
 * 面板设置与「保留名原样读写」的落点（1.2.0 从 `lib/index.js` 原样搬出）。
 *
 * 这里的每一项都与 `memory/config.js` 的 `SAGE_MEM_*` 一一对应；边界值照抄那边的
 * envInt 调用（lo/hi 不许在这里另立一套）。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LIMIT_SPECS,
  MAX_BASELINE,
  MAX_CHARS_PER_FILE,
  MAX_RESULTS,
  MAX_SESSION_BYTES,
  RESERVED_FILES,
  STALE_DAYS,
  STARTUP_LIMIT_DIAGNOSTICS,
  STATE_ROOT,
  resolveLimits,
} from './memory/config.js'
import {
  EXPERIMENTAL_SPECS,
  STARTUP_EXPERIMENTAL_DIAGNOSTICS,
  applyRuntimeExperimental,
  liveExperimental,
  resolveExperimental,
} from './memory/experimental.js'
import { MAX_RAW_BYTES } from './shared/limits.js'
import { INDEX_FILE_KEY, SESSION_LOG_KEY, isPlainMdName } from './shared/md-name.js'
export { LIMIT_SPECS, MAX_RAW_BYTES }
import { DEFAULT_CONFIG } from './autodream/config.js'
import { readJson } from './autodream/util.js'
import { warnLog, writeFileAtomic } from './memory/util.js'

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

/**
 * 面板上的注入设置（5 项上限 + 保护名 + 实验性开关 + 界面入口）。
 *
 * ⚠️ **那 5 个上限常量是模块加载时读的**：面板改完要**重启 DSH** 才生效。所以这里同时给出
 * 「当前生效值」`limits`、「待生效值」`pendingLimits` 与 `restartRequired` —— 界面才能诚实地说
 * 「改好了，重启后生效」，而不是让用户以为立刻生效。带 `live: true` 的实验性开关是例外：
 * 它们不进 `restartRequired`（说「要重启」而实际已经生效，比不说更糟）。
 *
 * 2.17.1 从 `lib/index.js` 搬来（组合根撞 1000 行上限）。搬的理由不只是行数：设置的读与写、
 * 合并与校验本来就该住在一个文件里，原先读在组合根、写也在组合根，而 `parseUiPatch` /
 * `pendingExperimental` 这些判据却住在这里 —— 一处概念散在两个文件。
 *
 * @param {object} ctx — 宿主上下文（`warnLog` 用）
 */
export async function readSettingsSnapshot(ctx) {
  const fileRead = await readSettingsFileDetailed()
  const limits = {
    maxResults: MAX_RESULTS,
    maxChars: MAX_CHARS_PER_FILE,
    maxBaseline: MAX_BASELINE,
    maxSessionBytes: MAX_SESSION_BYTES,
    staleDays: STALE_DAYS,
  }
  // Q04：pending 与**启动解析**共用 `resolveLimits` 这一份判据（持久设置 > 环境变量 > 默认）。
  const pending = resolveLimits(fileRead.data?.limits)
  // 2.17.0：从 `EXPERIMENTAL_SPECS` 派生（原先手写 mmr/todoBoard 两份，加开关就得来改第三次）。
  const experimental = Object.fromEntries(Object.keys(EXPERIMENTAL_SPECS).map((k) => [k, liveExperimental(k)]))
  const pendingLab = pendingExperimental(fileRead.data)
  // 坏设置给明确诊断、不静默回默认：启动期那份 + 这次读文件的问题 + 逐项非法/越界说明，去重后一起给。
  const limitDiagnostics = [...new Set([
    ...STARTUP_LIMIT_DIAGNOSTICS,
    ...STARTUP_EXPERIMENTAL_DIAGNOSTICS,
    ...(fileRead.error ? [fileRead.error] : []),
    ...pending.diagnostics,
  ])]
  if (limitDiagnostics.length > 0) {
    warnLog(ctx, `上限设置有问题（本次仍按环境变量/默认值生效）：${limitDiagnostics.join('；')}`)
  }
  const reservedExtra = await readReservedFile()
  // 模块加载时那份「用户声明的保护名」（RESERVED_FILES 里抠掉两个内置名）
  const activeExtra = [...RESERVED_FILES].filter((n) => n !== INDEX_FILE_KEY && n !== SESSION_LOG_KEY)
  const norm = (list) => JSON.stringify([...list].map((s) => String(s).toLowerCase()).sort())
  const restartRequired =
    JSON.stringify(limits) !== JSON.stringify(pending.limits) ||
    // 2.11.0：实验性开关里带 `live: true` 的（如 todoBoard）由 client 半当场应用，
    // 不参与 restartRequired。
    Object.keys(pendingLab).some((k) => !EXPERIMENTAL_SPECS[k]?.live && experimental[k] !== pendingLab[k]) ||
    norm(activeExtra) !== norm(reservedExtra)
  // 2.7.0：entry 是 canonical；sidebarEntry 只为 2.6.0 的客户端保留（派生值，不落盘）。
  const ui = pendingUi(fileRead.data)
  return {
    limits,
    pendingLimits: pending.limits,
    // 2.9.0 实验性：`experimental` = 已生效值，`pendingExperimental` = 待生效值。
    experimental,
    pendingExperimental: pendingLab,
    restartRequired,
    // Q04 的诊断出口：面板据此说明「你保存的值没生效，原因是 X」；宿主侧先如实给出。
    limitDiagnostics,
    // 1.8.0 / 2.7.0：客户端行为（界面入口三选一）。**不参与** restartRequired —— 改完立刻生效。
    ui: { ...ui, sidebarEntry: ui.entry !== 'settings' },
    // 生效的保护名单（含两个内置名）+ 用户声明的那部分原文（面板编辑的是后者）
    reserved: [...new Set([INDEX_FILE_KEY, SESSION_LOG_KEY, ...reservedExtra.map((s) => s.toLowerCase())])],
    reservedExtra,
  }
}

/**
 * 改设置：5 项上限落 `<状态根>/settings.json`，保护名单落 `<状态根>/reserved.json`。
 *
 * 校验**先全部过一遍再写盘**：任何一个值非法就整体 `{ ok:false }`，绝不写半份。
 * 越界不是「夹到边界」（那是环境变量的宽容语义）—— 面板上手输的数字越界是笔误，
 * 静默改成别的值比报错更让人困惑。
 *
 * @param {object} ctx — 宿主上下文（`warnLog` 用）
 * @param {object} patch
 */
export async function applySettingsPatch(ctx, patch) {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const limitsPatch = p.limits && typeof p.limits === 'object' && !Array.isArray(p.limits) ? p.limits : null
  const nextLimits = {}
  if (limitsPatch) {
    for (const [key, value] of Object.entries(limitsPatch)) {
      const spec = LIMIT_SPECS[key]
      if (!spec) return { ok: false, error: `sage-mem: unknown setting: ${key}` }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `sage-mem: ${key} must be a number, got ${typeof value}` }
      }
      const rounded = Math.round(value)
      if (rounded < spec.lo || rounded > spec.hi) {
        return { ok: false, error: `sage-mem: ${key} must be an integer in [${spec.lo}, ${spec.hi}], got ${value}` }
      }
      nextLimits[key] = rounded
    }
  }
  let nextReserved = null
  if (p.reserved !== undefined) {
    if (!Array.isArray(p.reserved)) return { ok: false, error: 'sage-mem: reserved must be an array of file names' }
    const cleaned = []
    for (const item of p.reserved) {
      const s = String(item ?? '').trim()
      if (!isPlainMdName(s) || s.startsWith('..')) {
        return { ok: false, error: `sage-mem: invalid reserved file name: ${String(item)}` }
      }
      if (!cleaned.includes(s)) cleaned.push(s)
    }
    nextReserved = cleaned
  }
  // 1.8.0：ui 与 limits / reserved 同一套「先全验、后一起写」—— 任何一个非法，整份 patch 不落盘。
  const uiCheck = parseUiPatch(p.ui)
  if (!uiCheck.ok) return { ok: false, error: uiCheck.error }
  const uiPatch = uiCheck.patch
  // 2.9.0：实验性开关与 limits / ui 同一套「先全验、后一起写」。
  const labCheck = parseExperimentalPatch(p.experimental)
  if (!labCheck.ok) return { ok: false, error: labCheck.error }
  const labPatch = labCheck.patch
  if (!limitsPatch && nextReserved === null && uiPatch === null && labPatch === null) return { ok: false, error: 'sage-mem: empty patch' }

  await mkdir(STATE_ROOT, { recursive: true })
  if (limitsPatch || uiPatch !== null || labPatch !== null) {
    const currentRead = await readSettingsFileDetailed()
    // 坏文件上不写：没有可合并的旧值，整份重写会把用户手改的内容静默吞掉。
    // 明确拒绝、让用户先修文件，比「保存成功但别的设置都没了」诚实。
    if (currentRead.error) {
      return { ok: false, error: `sage-mem: ${currentRead.error}；请先修复或删除它再保存（不会静默覆盖）` }
    }
    const current = currentRead.data
    const mergedLimits = { ...(current?.limits ?? {}), ...nextLimits }
    // 实验性：只覆盖这次给出的键，没给就沿用文件里的有效值（缺失 = 全关）。
    const mergedLab = { ...pendingExperimental(current), ...(labPatch ?? {}) }
    // ui 只覆盖这次给出的键；没给就沿用文件里的有效值（坏值 / 缺失一律按默认「两个都显示」）。
    // 2.7.0：落盘只写 canonical 的 entry，旧 sidebarEntry 由 pendingUi 迁移进来、不再写出。
    const mergedUi = { ...pendingUi(current), ...(uiPatch ?? {}) }
    await writeFileAtomic(SETTINGS_FILE, JSON.stringify({ limits: mergedLimits, experimental: mergedLab, ui: mergedUi, updatedAt: Date.now() }, null, 2))
  }
  if (nextReserved !== null) {
    await writeFileAtomic(RESERVED_FILE, `${JSON.stringify(nextReserved, null, 2)}\n`)
  }
  // 2.17.0：live 开关写盘后立刻生效；必须在下面读快照之前（否则返回的已生效值是旧的）。
  if (labPatch !== null) applyRuntimeExperimental(labPatch)
  // 上限 / 保护名单在模块加载时就固化了，写盘即提示重启；ui 是**客户端行为**，改完立刻生效，
  // 所以只有前两者会强制 true，纯 ui 补丁照实回传（通常就是 false）。
  const settings = await readSettingsSnapshot(ctx)
  // 2.11.0：实验性补丁只在**碰到要重启的键**时才强制 true —— 带 `live: true` 的
  // 由 client 半当场应用，写盘即生效，不该再吓用户一次。
  const labNeedsRestart = labPatch !== null && Object.keys(labPatch).some((k) => !EXPERIMENTAL_SPECS[k]?.live)
  return {
    ok: true,
    settings,
    restartRequired: limitsPatch || nextReserved !== null || labNeedsRestart ? true : settings.restartRequired,
  }
}
