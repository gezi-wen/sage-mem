/**
 * sage-mem 记忆层 —— 裁决写入（2.0.0 矛盾检测的写路径）。
 *
 * 「这条记忆不再作数」是一个**写进记忆文件 frontmatter 的事实**，不是旁路索引：
 * 记忆目录自包含、可 git diff、状态根丢了标记还在（D29 Q2）。代价是这个写入碰的是
 * **用户的记忆文件**，所以这里每一条都是硬约束（docs/2.0.0-plan.md §5.5）：
 *
 *   1. 幂等：同一份标记连写两次，第二次不写盘、不报错；
 *   2. 不半份：原子写（宿主的 `fs.writeText`）；
 *   3. 不动别的字节：只加/删 `invalid_at` / `superseded_by` 两行，键顺序、缩进、CRLF 原样；
 *   4. 不改 `updated`：失效不是「文件被改过」，改了会让新鲜度提示说谎；
 *   5. 给收据：成功返回 `{ok, file, invalidAt, version}`，失败返回 `{ok:false, code}`。
 *
 * 拆分：**纯函数**（`upsertValidityLines` / `removeValidityLines`）负责字节级改写，
 * 能直接单测；**IO**（`invalidateMemory` / `undoMemoryInvalidation`）负责版本守卫、
 * 沙箱策略与错误码。不读时钟 —— 裁决时间由调用方给（`nowIso` 的取值落在 Gateway 一层）。
 */

import { join } from 'node:path'
import { inspectMemoryEntry, readVerified, yamlScalar } from './scan.js'
import { safeName } from './naming.js'
import { createKeyedWriteQueue } from './util.js'
import { parseValidityTime } from './validity.js'

/**
 * 2.1.8（外部审查 N02）：同一份记忆文件的「读快照 → 改标记 → 写回」整段串行。
 *
 * 单文件的版本 CAS 只覆盖「这一次读写窗口」，保护不了「两个不同冲突同时标同一文件」：
 * 两边都基于旧字节改写，后写的那个会把前一个标记静默盖掉，而两份收据都声称成功。
 * 串行之后后一个读到的就是前一个写完的字节（跨进程仍由宿主 replaceIfVersion 兜底）。
 */
const withFileLock = createKeyedWriteQueue()

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/

/** 失效标记的两行（只认顶层键：`metadata:` 嵌套块里同名的键不是我们的）。 */
const VALIDITY_LINE_RE = /^(?:invalid_at|superseded_by):/

/**
 * 2.1.9（外部审查 N01）：撤销时发现「文件上的标记已经不是这条记录写的那份」。
 * 固定字符串，界面与测试都只认它（不解析错误文案）。
 */
export const ERR_STALE_DECISION = 'stale_decision'

function eolOf(text) {
  const src = String(text ?? '')
  const i = src.indexOf('\r\n')
  if (i >= 0) return '\r\n'
  return '\n'
}

/**
 * 给 frontmatter 写（或更新）`invalid_at` / `superseded_by`。
 *
 * 写法与归档留痕（`scan.js` 的 `addArchiveMeta`）同一口径：**先剥旧行再插**，
 * 免得同一份文件里出现两个 `invalid_at`。新行插在 frontmatter 末尾 ——
 * 插在别处就要决定「放第几行」，而键顺序本身没有语义，末尾最不容易碰到别的字节。
 *
 * @param {string} content — 记忆全文
 * @param {{invalidAt:string, supersededBy?:string}} input
 * @returns {{ok:true, content:string, changed:boolean} | {ok:false, code:'invalid', error:string}}
 */
export function upsertValidityLines(content, input) {
  if (typeof content !== 'string') return { ok: false, code: 'invalid', error: '记忆内容必须是字符串' }
  const invalidAt = typeof input?.invalidAt === 'string' ? input.invalidAt.trim() : ''
  if (!invalidAt) return { ok: false, code: 'invalid', error: 'invalid_at 不能为空' }
  const supersededBy = typeof input?.supersededBy === 'string' ? input.supersededBy.trim() : ''

  const eol = eolOf(content)
  const lines = [`invalid_at: ${yamlScalar(invalidAt)}`]
  if (supersededBy) lines.push(`superseded_by: ${yamlScalar(supersededBy)}`)

  const m = content.match(FRONTMATTER_RE)
  if (!m) {
    // 没有 frontmatter：补一个**最小块**，正文原样跟在后面。失效标记必须有地方放，
    // 而「拒绝标记」会让用户在面板上点了没反应 —— 那是更坏的一种静默。
    const next = ['---', ...lines, '---', '', content].join(eol)
    return { ok: true, content: next, changed: true }
  }

  const body = m[1].split(/\r?\n/).filter((line) => !VALIDITY_LINE_RE.test(line))
  const block = ['---', ...body, ...lines, '---'].join(eol)
  const next = content.slice(0, m.index) + block + content.slice(m.index + m[0].length)
  return { ok: true, content: next, changed: next !== content }
}

/**
 * 删掉 `invalid_at` / `superseded_by` 两行（撤销失效）。
 *
 * 只删这两行 —— 「撤销」不是「把文件恢复成某个版本」，其它任何改动都不动。
 * 两行本来就不存在时返回 `changed:false`（幂等）。
 */
export function removeValidityLines(content) {
  if (typeof content !== 'string') return { ok: false, code: 'invalid', error: '记忆内容必须是字符串' }
  const m = content.match(FRONTMATTER_RE)
  if (!m) return { ok: true, content, changed: false }
  const eol = eolOf(content)
  const body = m[1].split(/\r?\n/)
  const kept = body.filter((line) => !VALIDITY_LINE_RE.test(line))
  if (kept.length === body.length) return { ok: true, content, changed: false }
  const block = ['---', ...kept, '---'].join(eol)
  const next = content.slice(0, m.index) + block + content.slice(m.index + m[0].length)
  return { ok: true, content: next, changed: next !== content }
}

/** 裸值 / 单引号 / 双引号（`yamlScalar` 会按需加引号）→ 原始字符串。 */
function unquoteScalar(raw) {
  const s = String(raw ?? '').trim()
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'")
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1)
  return s
}

/**
 * 读文件**当前**的失效标记（只认顶层两行）。没有 `invalid_at` 就返回 null。
 *
 * 2.1.9（N01）：撤销要先知道「现在文件上写的是哪一次判断」。读回来的值可能是带引号的
 * 形式（`yamlScalar` 对含 `: ` 之类的值会加引号），所以这里统一去引号后再比对。
 *
 * @returns {{invalidAt:string, supersededBy:string} | null}
 */
export function readValidityMarker(content) {
  if (typeof content !== 'string') return null
  const m = content.match(FRONTMATTER_RE)
  if (!m) return null
  const marker = { invalidAt: '', supersededBy: '' }
  for (const line of m[1].split(/\r?\n/)) {
    const hit = line.match(/^(invalid_at|superseded_by)\s*:\s*(.*)$/)
    if (!hit) continue
    if (hit[1] === 'invalid_at') marker.invalidAt = unquoteScalar(hit[2])
    else marker.supersededBy = unquoteScalar(hit[2])
  }
  return marker.invalidAt ? marker : null
}

/** 从宿主的 `fs` 服务取版本（拿不到就是 undefined —— 那就**不写**，不拿「现在」冒充）。 */
function versionOf(info) {
  return info && info.version !== undefined && info.version !== null ? info.version : undefined
}

/** 这一次写入该带的逐次沙箱策略（与 autodream 同一口径：收窄到记忆目录，`read-only` 不翻案）。 */
function writeSandboxPolicy(ctx, memoryDir) {
  try {
    const sp = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined
    if (!sp || typeof sp.resolve !== 'function') return undefined
    const policy = sp.resolve()
    if (!policy || policy.mode !== 'workspace-write') return undefined
    return { mode: 'workspace-write', workspaceRoot: memoryDir }
  } catch {
    return undefined
  }
}

/** 宿主写失败的 err.code → 裁决入口的错误码（面板据此给可诊断出路）。 */
function mapWriteError(err) {
  const code = String(err?.code ?? '')
  if (code === 'FS_STALE_VERSION') return 'stale_version'
  if (code === 'FS_SANDBOX_DENIED') return 'write_denied'
  if (code === 'ENOENT') return 'missing'
  return 'io_error'
}

function hostFs(ctx) {
  try {
    const fs = typeof ctx?.get === 'function' ? ctx.get('fs') : undefined
    return fs && typeof fs.resolve === 'function' && typeof fs.writeText === 'function' ? fs : null
  } catch {
    return null
  }
}

/**
 * 读出「准备改写的那份记忆」并拿到**读到内容那一刻**的版本。
 *
 * 版本取法照 autodream 的 R01 结论：写前复核一次版本没变，变了就报 `stale_version`
 * （内容在 `stat → read` 之间被改过，我们手里这份已经过期）。
 */
async function readForWrite(ctx, memoryDir, file) {
  const safe = safeName(file)
  if (!safe) return { ok: false, code: 'invalid', error: `文件名非法：${String(file)}` }
  const fs = hostFs(ctx)
  if (!fs) return { ok: false, code: 'unsupported', error: '宿主没有 fs 服务，只能手工编辑记忆文件' }
  const full = join(memoryDir, safe)

  const gate = await inspectMemoryEntry(full)
  if (!gate.ok) {
    return {
      ok: false,
      code: gate.code === 'missing' ? 'missing' : 'invalid',
      error: gate.error,
    }
  }

  let before
  try {
    const target = await fs.resolve(full)
    before = await fs.stat(target)
    if (!before) return { ok: false, code: 'missing', error: `记忆不存在：${safe}` }
    // 版本守卫的**前提**：宿主必须给出一个版本。给不出就不能写 ——
    // 「拿一个 undefined 当版本」在宿主那里可能等于「不校验」，那就是一次无守卫覆盖。
    // 这与计划 §5.3 一致：拿不到版本就不写，让人手工编辑（面板会把这句话显示出来）。
    if (versionOf(before) === undefined) {
      return { ok: false, code: 'unsupported', error: '宿主没有给出这份记忆的版本号，无法安全写入（请手工编辑 frontmatter）' }
    }
    const content = await readVerified(full, gate, 'utf8')
    const after = await fs.stat(target)
    if (!after || versionOf(after) !== versionOf(before)) {
      return { ok: false, code: 'stale_version', error: '读取期间文件被改过，请重试' }
    }
    return { ok: true, fs, full, target, version: versionOf(before), content }
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, code: 'missing', error: `记忆不存在：${safe}` }
    return { ok: false, code: 'io_error', error: String(err?.message ?? err) }
  }
}

/**
 * 标一条记忆失效：写 `invalid_at`（+ 可选 `superseded_by`），其余字节不动。
 *
 * @param {object} deps `{ctx, memoryDir}`
 * @param {{file:string, invalidAt:string, supersededBy?:string}} input
 * @returns {Promise<{ok:true, file:string, invalidAt:string, version:string, wrote:boolean}
 *   | {ok:false, code:'invalid'|'missing'|'stale_version'|'write_denied'|'unsupported'|'io_error', error:string}>}
 */
export async function invalidateMemory({ ctx, memoryDir }, input) {
  // 2.1.8（N02）：按记忆文件串行（见 withFileLock 的注释）。文件名归一后当 key。
  return withFileLock(String(safeName(input?.file) ?? ''), () => invalidateMemoryLocked({ ctx, memoryDir }, input))
}

async function invalidateMemoryLocked({ ctx, memoryDir }, input) {
  const invalidAt = typeof input?.invalidAt === 'string' ? input.invalidAt.trim() : ''
  // 写进用户文件的标记必须是我们能解析的格式：坏值会被 validity 层按「未标注」处理、
  // 记忆照常注入 —— 用户会看到「标了却没用」，那是最难查的一类静默失效。
  if (!parseValidityTime(invalidAt).ok) {
    return { ok: false, code: 'invalid', error: `invalid_at 必须是 ISO 8601 带偏移的时间（收到 ${JSON.stringify(input?.invalidAt)}）` }
  }
  const read = await readForWrite(ctx, memoryDir, input?.file)
  if (!read.ok) return read
  const built = upsertValidityLines(read.content, input)
  if (!built.ok) return built
  if (!built.changed) {
    // 幂等：标记已经在那儿了。不写盘，但照样给收据（面板会显示「已失效」）。
    return { ok: true, file: safeName(input.file), invalidAt: String(input.invalidAt), version: String(read.version ?? ''), wrote: false }
  }
  try {
    const outcome = await read.fs.writeText(
      read.target,
      built.content,
      { kind: 'replaceIfVersion', version: read.version },
      undefined,
      writeSandboxPolicy(ctx, memoryDir),
    )
    const version = outcome && outcome.version !== undefined && outcome.version !== null ? String(outcome.version) : ''
    return { ok: true, file: safeName(input.file), invalidAt: String(input.invalidAt), version, wrote: true }
  } catch (err) {
    return { ok: false, code: mapWriteError(err), error: String(err?.message ?? err) }
  }
}

/**
 * 撤销失效：删掉 `invalid_at` / `superseded_by` 两行，其余字节不动。
 *
 * 2.1.9（N01）：可选第三参 `opts` 是**这次撤销的操作身份**（来自冲突记录：
 * `expectedInvalidAt = record.decidedAt`，`expectedSupersededBy` = 记录里的另一方）。
 * 文件当前标记对不上 → `stale_decision`，**一个字节都不删**：后来人改过标记，那已经是
 * 别人的判断，撤销它等于把别人的决定抹掉。正文变化不参与比对 —— 撤销只删两行标记，
 * 正文照旧保留。
 *
 * @param {object} deps `{ctx, memoryDir}`
 * @param {string} file
 * @param {{expectedInvalidAt?:string, expectedSupersededBy?:string}} [opts]
 * @returns {Promise<{ok:true, file:string, cleared:boolean, version:string}
 *   | {ok:false, code:'invalid'|'missing'|'stale_version'|'stale_decision'|'write_denied'|'unsupported'|'io_error', error:string}>}
 */
export async function undoMemoryInvalidation({ ctx, memoryDir }, file, opts) {
  // 2.1.8（N02）：与 invalidateMemory 同一条文件级串行（撤销和标记可能同时发生）。
  return withFileLock(String(safeName(file) ?? ''), () => undoMemoryInvalidationLocked({ ctx, memoryDir }, file, opts))
}

async function undoMemoryInvalidationLocked({ ctx, memoryDir }, file, opts) {
  const read = await readForWrite(ctx, memoryDir, file)
  if (!read.ok) return read
  // 2.1.9（N01）：先确认「现在文件上的标记仍是这条记录写的那一份」，再决定删不删。
  const expect = opts && typeof opts === 'object' ? opts : null
  const expectedInvalidAt = typeof expect?.expectedInvalidAt === 'string' ? expect.expectedInvalidAt : ''
  if (expectedInvalidAt) {
    const marker = readValidityMarker(read.content)
    if (!marker) {
      // 标记已经不在了（可能已撤销过 / 被别的写入清掉）：不删任何东西，幂等返回。
      return { ok: true, file: safeName(file), cleared: false, version: String(read.version ?? '') }
    }
    const expectedSupersededBy = typeof expect?.expectedSupersededBy === 'string' ? expect.expectedSupersededBy : ''
    if (marker.invalidAt !== expectedInvalidAt || marker.supersededBy !== expectedSupersededBy) {
      return {
        ok: false,
        code: ERR_STALE_DECISION,
        error: `文件上的失效标记已不是这条记录写下的那一份（记录：invalid_at=${expectedInvalidAt} / superseded_by=${expectedSupersededBy}；盘上：invalid_at=${marker.invalidAt} / superseded_by=${marker.supersededBy}）—— 没有删除别人的判断，请先比较两边内容`,
      }
    }
  }
  const built = removeValidityLines(read.content)
  if (!built.ok) return built
  if (!built.changed) {
    return { ok: true, file: safeName(file), cleared: false, version: String(read.version ?? '') }
  }
  try {
    const outcome = await read.fs.writeText(
      read.target,
      built.content,
      { kind: 'replaceIfVersion', version: read.version },
      undefined,
      writeSandboxPolicy(ctx, memoryDir),
    )
    const version = outcome && outcome.version !== undefined && outcome.version !== null ? String(outcome.version) : ''
    return { ok: true, file: safeName(file), cleared: true, version }
  } catch (err) {
    return { ok: false, code: mapWriteError(err), error: String(err?.message ?? err) }
  }
}
