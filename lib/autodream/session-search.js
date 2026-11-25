/**
 * sage-mem autodream — `search_sessions` 的**运行时层**：zstd 帧解析、目录枚举、读文件、编排。
 *
 * 与 `session-search-policy.js` 的分工：**这里只做 IO，不做决定**。选哪个会话、片段切多宽、
 * 账怎么算、话怎么说，全在纯层（那条边界由 `test/structure-test.mjs` 第 5 组看着）。
 *
 * ## 为什么解压要逐帧走
 *
 * 会话正文是**逐行一个 zstd 帧**拼起来的，而 Node 的解码器都只认第一个帧：
 *   - `zstdDecompressSync(buf)` 只解第一帧，后面的帧全丢，于是搜到的永远只有会话开头
 *   - `zstdDecompress(buf)` 单参数调用直接抛（它要 callback）—— 旧代码正是这么调的，
 *     于是每个会话都在 catch 里被静默跳过，整条 `search_sessions` **一次都没成功过**
 * 所以沿帧头走：Magic → Frame_Header_Descriptor → (Window / DictID / ContentSize) →
 * 逐块 Block_Header 直到 Last_Block → 可选 checksum。
 *
 * ## 2.19.0：把「解了一半」变成可证的事实
 *
 * 旧解码器只回 `text|null`，于是「5 帧里坏了 1 帧」与「5 帧全好」在调用方看来完全一样。
 * 现在 `decodeZstdFramesDetailed` 回报 `frames` / `decoded` / `resynced`，纯层据此把该文件
 * 记成 `partial` 而不是 `searched` —— 覆盖率才不是自述。
 *
 * ## 成本（为什么不扩大上限）
 *
 * 解压是整份进内存的：未命中时没有任何早停点，候选份数 × 单份正文体积就是每次调用的固定开销，
 * 而单份会话解出来往往是它压缩体积的数倍。要扩大扫描面，第一步是逐帧早停或流式，
 * 而不是把上限改大。
 *
 * ## 两个注入点（都只为测试，生产不传）
 *
 * - `opts.zlib`：证明「没有 zstd 时不许谎称零命中」；
 * - `opts.io`：`{readdir, stat, readFile}` —— 让 ENOTDIR / 枚举失败这类**真实失败分支**
 *   能被确定性地跑到（照 `autodream/reconcile.js` 注入 `listEntries` / `readLedger` 的同一手法）。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { stampHuman as localStamp } from '../shared/stamp.js'
import {
  CHAR_BUDGET,
  DEFAULT_HIT_LIMIT,
  HIT_CHARS,
  MAX_HIT_LIMIT,
  MIN_NEEDLE_CHARS,
  SEARCH_DIR_CAP,
  classifyCoverage,
  classifySessionFileName,
  matchLines,
  pickSessionsByMtime,
  renderSearchReport,
} from './session-search-policy.js'

/** zstd 帧魔数（小端读出来的值）。 */
const ZSTD_MAGIC = 0xfd2fb528
/** 同一个魔数的字节形态：认不出帧头时要靠它找下一个帧的起点。 */
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 真实文件系统（测试可经 `opts.io` 换掉）。 */
const REAL_IO = Object.freeze({ readdir, stat, readFile })

/**
 * 量一个 zstd 帧占多少字节（从 `off` 开始）。不是合法帧头、或帧被截断，返回 0。
 * @returns {number}
 */
export function zstdFrameLength(buf, off) {
  if (off + 5 > buf.length) return 0
  if (buf.readUInt32LE(off) !== ZSTD_MAGIC) return 0
  let p = off + 4
  const fhd = buf[p++]
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictIdFlag = fhd & 3
  if (!singleSegment) p += 1 // Window_Descriptor
  p += [0, 1, 2, 4][dictIdFlag] // Dictionary_ID
  p += singleSegment ? [1, 2, 4, 8][fcsFlag] : [0, 2, 4, 8][fcsFlag] // Frame_Content_Size
  if (p > buf.length) return 0
  for (;;) {
    if (p + 3 > buf.length) return 0
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = h & 1
    const type = (h >> 1) & 3
    const size = h >>> 3
    if (type === 3) return 0 // Reserved：不是我们能认的帧
    p += type === 1 ? 1 : size // RLE 块只存 1 字节
    if (last) break
    if (p > buf.length) return 0
  }
  if (checksum) p += 4
  return p <= buf.length ? p - off : 0
}

/**
 * 把「可能由多个帧拼成」的 zstd 缓冲解成文本，并**如实回报解了多少**。
 *
 * - `frames`：认出长度的帧数（含解失败的）；
 * - `decoded`：真正解出来的帧数；
 * - `resynced`：认不出帧头、跳到下一个魔数的次数（中间那些字节被丢弃）；
 * - `trailing`：扫完后**还剩下没被解析的字节**（帧被截断时最外层帧头都读不出来，
 *   于是它既不算 frames 也不算 resynced —— 不单独记这一条，「尾部丢了」就会无声无息）；
 * - `fallback`：一帧都没认出长度时，退回整块解（单帧老文件的形状）。
 *
 * `text === null` 才是「一个字节都没解出来」；`decoded < frames`、`resynced > 0` 或
 * `trailing === true` 都表示**部分解码** —— 由纯层记成 `partial`。
 *
 * @returns {{text:string|null, frames:number, decoded:number, resynced:number,
 *            trailing:boolean, fallback:boolean}}
 */
export function decodeZstdFramesDetailed(zlib, buf) {
  const parts = []
  let off = 0
  let frames = 0
  let decoded = 0
  let resynced = 0
  while (off < buf.length) {
    const len = zstdFrameLength(buf, off)
    if (len <= 0) {
      /**
       * 认不出帧头：**跳到下一个魔数**继续，而不是停下。
       *
       * 停下的代价是「这一帧之后的内容全部静默丢失」—— 而那些帧本来是好的
       * （把某帧的块头改成 Reserved 就能让后面所有帧都再也搜不到）。
       */
      const next = buf.indexOf(ZSTD_MAGIC_BYTES, off + 1)
      if (next < 0) break
      off = next
      resynced += 1
      continue
    }
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(off, off + len)))
      decoded += 1
    } catch {
      // 单帧坏掉：跳过它，继续后面的帧
    }
    off += len
    frames += 1
  }
  // 循环退出时 off 还没走到末尾 = 尾部有解析不了的字节（典型形态：最后一帧被截断）。
  const trailing = off < buf.length
  if (frames === 0) {
    try {
      return {
        text: zlib.zstdDecompressSync(buf).toString('utf8'),
        frames: 0,
        decoded: 1,
        resynced,
        trailing,
        fallback: true,
      }
    } catch {
      return { text: null, frames: 0, decoded: 0, resynced, trailing, fallback: true }
    }
  }
  if (decoded === 0) return { text: null, frames, decoded, resynced, trailing, fallback: false }
  return { text: Buffer.concat(parts).toString('utf8'), frames, decoded, resynced, trailing, fallback: false }
}

/** `err.code` → coverage 的根状态。**不许**把读不了降级成「空的」。 */
function rootStateOf(err) {
  const code = err?.code
  if (code === 'ENOENT') return 'missing'
  if (code === 'ENOTDIR') return 'notdir'
  if (code === 'EACCES' || code === 'EPERM') return 'denied'
  return 'error'
}

function messageOf(err) {
  return String(err?.message ?? err ?? '')
}

/**
 * 走一遍 `$DSH_HOME/sessions`：project 目录 → 会话目录 → 认得的会话文件。
 *
 * 两处刻意与旧实现相反：
 *   - 项目的 `readdir` 失败**不再** `catch(() => [])`（那等于「这个 project 不存在」），
 *     而是记进 `enumerationFailed` —— 枚举不全本身就是覆盖不完整的一条；
 *   - 一个会话目录里**先数完所有文件名**：认不得的代际（v3 / 无版本）一律计入
 *     `unrecognized`，再去挑 v4。先挑后数会漏掉「v4 与旧格式同目录」里的旧格式。
 *
 * @param {string} root
 * @param {{readdir:Function, stat:Function}} [io]
 * @returns {Promise<{root:string, message:string, files:Array<{file:string, mtimeMs:number}>,
 *                    unrecognized:number, enumerationFailed:number}>}
 */
export async function enumerateSessions(root, io = REAL_IO) {
  const out = { root: 'ok', message: '', files: [], unrecognized: 0, enumerationFailed: 0 }
  let projects
  try {
    projects = await io.readdir(root, { withFileTypes: true })
  } catch (err) {
    out.root = rootStateOf(err)
    out.message = messageOf(err)
    return out
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const projPath = join(root, p.name)
    let sessions
    try {
      sessions = await io.readdir(projPath, { withFileTypes: true })
    } catch {
      out.enumerationFailed += 1
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const dirPath = join(projPath, s.name)
      let names
      try {
        names = await io.readdir(dirPath, { withFileTypes: true })
      } catch {
        out.enumerationFailed += 1
        continue
      }
      let recognized = ''
      for (const f of names) {
        // 候选既可以是普通文件，也可以是符号链接：链接目标是不是普通文件由下面的
        // `stat` 判定（`stat` 跟着链接走）。早先用 `isFile()` 把它们直接跳过，
        // 结果是「stat 能读到、搜索却看不见」—— 同一份会话在两条路径上待遇不同。
        if (!f.isFile() && !f.isSymbolicLink()) continue
        const kind = classifySessionFileName(f.name)
        // 先把旧代际数掉，再挑 v4：**不许**在遇到 v4 时 break —— 否则同一目录里
        // 排在 v4 之后的旧格式会被静默漏计。
        if (kind === 'unrecognized') {
          out.unrecognized += 1
          continue
        }
        if (kind !== 'v4') continue
        // 同一目录出现第二份 v4（大小写不同的文件系统上可能）不是「随便挑一个」的时候：
        // 挑哪份都会漏另一份，所以记账（枚举失败）并只用第一份。
        if (recognized) {
          out.enumerationFailed += 1
          continue
        }
        recognized = f.name
      }
      if (!recognized) continue
      const file = join(dirPath, recognized)
      let info
      try {
        info = await io.stat(file)
      } catch {
        out.enumerationFailed += 1
        continue
      }
      // 链接指向目录 / 设备 / 不存在的东西：读不了就是读不了，记一笔，别让它变成「零命中」。
      if (typeof info.isFile !== 'function' || !info.isFile()) {
        out.enumerationFailed += 1
        continue
      }
      out.files.push({ file, mtimeMs: info.mtimeMs })
    }
  }
  return out
}

/** `limit` 夹到 1..MAX_HIT_LIMIT；非法回落默认值。 */
function clampLimit(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_HIT_LIMIT
  return Math.max(1, Math.min(MAX_HIT_LIMIT, Math.floor(n)))
}

/** 取 zlib；允许注入（测试要证明「没有 zstd 时不许谎称零命中」）。 */
async function resolveZlib(injected) {
  if (injected !== undefined) return injected
  try {
    return await import('node:zlib')
  } catch {
    return null
  }
}

/**
 * 搜索的**结构化**形态：`{text, hits, coverage}`。
 *
 * 为什么要和 `searchSessions` 分开：工具契约是「永远回字符串」（`llm-loop.js:383` 只吃字符串），
 * 但覆盖率是一份**账**，测试与将来可能的报告要能逐字段断言，而不是去正则里捞。
 *
 * @param {string} sessionsRoot — `$DSH_HOME/sessions`
 * @param {string} query — 关键词（≥2 字符）
 * @param {{limit?:number, sinceMs?:number, zlib?:object|null, io?:object, cap?:number, charBudget?:number}} [opts]
 * @returns {Promise<{text:string, hits:Array<object>, coverage:object|null}>}
 */
export async function runSessionSearch(sessionsRoot, query, opts = {}) {
  const raw = String(query ?? '')
  const needle = raw.toLowerCase()
  if (needle.length < MIN_NEEDLE_CHARS) {
    return { text: `（关键词太短，至少 ${MIN_NEEDLE_CHARS} 个字符）`, hits: [], coverage: null }
  }

  const limit = clampLimit(opts.limit)
  const dirCap = Number.isFinite(opts.cap) ? Math.max(1, Math.floor(opts.cap)) : SEARCH_DIR_CAP
  const charBudget = Number.isFinite(opts.charBudget) ? Math.max(1, Math.floor(opts.charBudget)) : CHAR_BUDGET
  const caps = { dirCap, charBudget, limit }
  const sinceMs = Number.isFinite(opts.sinceMs) ? Number(opts.sinceMs) : 0
  const io = opts.io ?? REAL_IO

  const build = (partial) => {
    const coverage = classifyCoverage({ caps, ...partial })
    const hits = Array.isArray(partial.hits) ? partial.hits : []
    return { text: renderSearchReport({ rawQuery: raw, hits, coverage }), hits, coverage }
  }

  if (!sessionsRoot) return build({ root: 'unset' })

  const zlib = await resolveZlib(opts.zlib)
  const zstdUnsupported = !zlib || typeof zlib.zstdDecompressSync !== 'function'

  const enumerated = await enumerateSessions(sessionsRoot, io)
  if (enumerated.root !== 'ok') {
    return build({ root: enumerated.root, rootMessage: enumerated.message })
  }
  const picked = pickSessionsByMtime(enumerated.files, { cap: dirCap, sinceMs })

  if (zstdUnsupported) {
    /**
     * 读不了解压就别假装看过：但**账要真实** —— 枚举到的份数、上限截掉的份数、
     * 旧格式的份数照记，进队的那几份以「一个字节都解不出来」记成 `failed`。
     *
     * 两处刻意不做的假账：不把 `available` 抹成 0（那会让「有 40 份会话」变成「一份都没有」），
     * 也不把进队的记成 `skippedByOutput`（它们根本不是被输出预算停下的）。
     */
    return build({
      root: 'ok',
      zstdUnsupported: true,
      available: picked.available,
      outcomes: picked.considered.map(() => 'failed'),
      unrecognized: enumerated.unrecognized,
      enumerationFailed: enumerated.enumerationFailed,
    })
  }

  const outcomes = []
  const hits = []
  let hitChars = 0
  let clipped = false
  let stoppedBy = null
  let skippedByOutput = 0

  for (const entry of picked.considered) {
    // 输出已经停了：后面的会话**一份都不读**（不花 I/O），但必须记账 —— 它们是「没开始」。
    if (stoppedBy) {
      skippedByOutput += 1
      continue
    }
    let buf
    try {
      buf = await io.readFile(entry.file)
    } catch {
      outcomes.push('failed')
      continue
    }
    const decoded = decodeZstdFramesDetailed(zlib, buf)
    if (decoded.text === null) {
      outcomes.push('failed')
      continue
    }
    const scan = matchLines(decoded.text, raw, {
      perLineChars: HIT_CHARS,
      limit: Math.max(1, limit - hits.length),
      charBudget: Math.max(0, charBudget - hitChars),
    })
    for (const h of scan.hits) hits.push({ ...h, stamp: localStamp(entry.mtimeMs) })
    hitChars += scan.hitChars
    if (scan.clipped) clipped = true
    if (scan.stoppedBy) stoppedBy = scan.stoppedBy
    // 四条 partial 通道：帧解丢、跳帧重同步、尾部有没解析到的字节、这一份没读完（输出上限）。
    const decodePartial =
      (decoded.frames > 0 && decoded.decoded < decoded.frames) || decoded.resynced > 0 || decoded.trailing === true
    outcomes.push(decodePartial || scan.stoppedEarly ? 'partial' : 'searched')
  }

  return build({
    root: 'ok',
    // 分母与「因上限没看」同源：都取自时间过滤之后的那份名单。
    available: picked.available,
    outcomes,
    skippedByOutput,
    unrecognized: enumerated.unrecognized,
    enumerationFailed: enumerated.enumerationFailed,
    hitCount: hits.length,
    hitChars,
    stoppedBy,
    clipped,
    hits,
  })
}

/**
 * 工具面入口：**永远回字符串**（失败也是话，不是异常）。
 *
 * @returns {Promise<string>}
 */
export async function searchSessions(sessionsRoot, query, opts = {}) {
  const result = await runSessionSearch(sessionsRoot, query, opts)
  return result.text
}

/** 三个上限的单一来源（测试据此断言「没被悄悄改大」；生产代码别读）。 */
export const SESSION_SEARCH_CAPS = Object.freeze({
  dirCap: SEARCH_DIR_CAP,
  charBudget: CHAR_BUDGET,
  hitChars: HIT_CHARS,
})
