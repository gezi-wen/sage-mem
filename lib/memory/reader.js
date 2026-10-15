/**
 * sage-mem 记忆层 —— 统一的安全读取入口（按行分页 + revision 校验）。
 *
 * 为什么要有这一层：0.9.17 会给模型一个 `read_memory` 工具，它必须走**同一条**读路径。
 * 工具一旦自己拼路径、自己判「这个文件名行不行」，就多出一条**绕过闸门的读路径** ——
 * 符号链接 / 目录联接 / 保留名的另一个名字（8.3 短名、硬链接）这些手法，注入链与设置页
 * 都拦住了，新工具会原样把它们放行。所以这里刻意**不新写任何路径判据**：
 * `safeName` → `shadowsReserved` → `inspectMemoryEntry`，与 `MemoryGateway.readFile`
 * 同序同函数。顺序本身是契约的一部分：先认名字才谈路径，先认身份才谈内容。
 *
 * 分页只做两件事：把行号锚在**整份文件**上（与 `chunks.js` 的段落行号同一口径，中间不许再
 * 换算一次 —— 换算是这类功能最常见的错位来源）、把窗口按 **UTF-8 字节**卡住。
 * 为什么必须是字节：一个汉字 3 字节，按 `String.length` 卡窗口会实发三倍体积。
 * 为什么要有 `startByte`：单行的字节数可以大于整个窗口，只按行号推进的话下一轮还是这一行
 * —— 那就是一个**不前进的分页循环**。
 */

import { MEMORY_DIR } from './config.js'
import { inspectMemoryEntry, shadowsReserved } from './scan.js'
import { safeName } from './naming.js'
import { revisionOf } from './chunks.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 一屏默认给多少字节。4 KB ≈ 一屏可读正文，比一次注入的 60 KB 会话预算小一个量级。 */
export const DEFAULT_MAX_BYTES = 4096

/** 单次上限。再大就失去「分页」的意义了（一次全量读反而更省往返）。 */
export const MAX_MAX_BYTES = 65536

/**
 * 下限 = 一个 UTF-8 字符最多占的字节数。
 *
 * 低于它就没有任何一次读取**能保证前进**：单行超长那条路要靠「取下一个字节窗口」推进，
 * 而窗口装不下哪怕一个汉字时窗口只能是空的 —— 空窗口 + 原地行号 = 死循环。
 * 所以归一化时把小于它的请求抬到它，而不是让调用方拿到一个必然死循环的参数。
 */
export const MIN_MAX_BYTES = 4

/**
 * 归一化请求。**不抛**：非法返回 `{error}`，由调用方转成 `{ok:false, code:'invalid'}`。
 *
 * `name` 直接过 `safeName`（唯一的名字校验函数）：它同时挡掉路径成分、`:` 交替数据流、
 * 非 `.md`、以及索引 / 流水这类非条目。返回的是**磁盘上的原始大小写**。
 *
 * @param {object} input
 * @returns {{name:string,revision:string,startLine:number,startByte:number,maxBytes:number}|{error:string}}
 */
export function normalizeReadRequest(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const name = safeName(raw.name)
  if (!name) return { error: 'invalid_name' }
  /**
   * revision 是可选的：带了就必须对得上，没带（或不是非空字符串）就照读。
   * 传个数字 / 对象进来只当「没带」——**不新增一个错误码**，因为「你没给我 revision」
   * 和「你给的 revision 是错的」是两回事，前者不该让一次读失败。
   */
  const revision = typeof raw.revision === 'string' && raw.revision !== '' ? raw.revision : ''
  const startLine = integerOr(raw.startLine, 1, 1)
  if (startLine === null) return { error: 'invalid_start' }
  const startByte = integerOr(raw.startByte, 0, 0)
  if (startByte === null) return { error: 'invalid_start' }
  const maxBytes = maxBytesOf(raw.maxBytes)
  if (maxBytes === null) return { error: 'invalid_bytes' }
  return { name, revision, startLine, startByte, maxBytes }
}

/** 严格整数：缺省给 dflt；非 number / 非整数 / 低于 min 一律 null（不静默取整）。 */
function integerOr(value, dflt, min) {
  if (value === undefined || value === null || value === '') return dflt
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) return null
  return value
}

/**
 * 字节窗口的收敛：≥1 的数字取整后夹在 [MIN_MAX_BYTES, MAX_MAX_BYTES]。
 *
 * 上限是给调用方的护栏而不是拒绝理由 —— 要得比顶格还大就按顶格给，不因为「要太多」
 * 让整条读失败；下限见 MIN_MAX_BYTES（低于它就保证不了前进）。
 */
function maxBytesOf(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_BYTES
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null
  return Math.max(MIN_MAX_BYTES, Math.min(Math.floor(value), MAX_MAX_BYTES))
}

/** 一个码点的 UTF-8 字节数。不调 Buffer：分页每一步都要按字符走一遍，够用且便宜。 */
function utf8LenOf(cp) {
  if (cp < 0x80) return 1
  if (cp < 0x800) return 2
  if (cp < 0x10000) return 3
  return 4
}

/**
 * 行内 UTF-8 字节偏移 → 字符下标；**不落在字符边界上返回 -1**。
 *
 * 越界也用 -1 表示：`startByte` 与 `startLine` 是一对（同一行内的偏移），对不上就是调用方
 * 拿着过期游标，宁可按非法拒掉，也不猜一个「大概的位置」去读错内容。
 */
function charIndexOfByte(text, byteOff) {
  if (byteOff === 0) return 0
  let bytes = 0
  let i = 0
  for (const ch of text) {
    bytes += utf8LenOf(ch.codePointAt(0))
    i += ch.length
    if (bytes === byteOff) return i
    if (bytes > byteOff) return -1
  }
  return -1
}

/** 从字符下标起，取尽可能多、但 UTF-8 字节数不超过 limit 的**字符数**（同样不切碎多字节字符）。 */
function charsWithinBytes(text, fromChar, limit) {
  let bytes = 0
  let i = fromChar
  while (i < text.length) {
    const cp = text.codePointAt(i)
    const step = cp > 0xffff ? 2 : 1
    const b = utf8LenOf(cp)
    if (bytes + b > limit) break
    bytes += b
    i += step
  }
  return i - fromChar
}

/**
 * 切一屏。返回的行号一律是**整份文件**的 1-based 行号。
 *
 * 两条路互斥：
 *   - 首行从 startByte 起的剩余本身 > maxBytes → 单行超长：只给这一行的字节窗口，
 *     并把 nextStartByte（仍在同一行内）交给调用方。此时 `lineTooLong: true`、
 *     `nextStartLine === startLine`。
 *   - 否则按整行累积，遇到第一行放不下的就停：`nextStartLine` = 那一行、`truncated: true`。
 *     下一次它是首行，若它自己也超长就走上面那条路。
 *
 * 换行符按 1 字节记进账：不记的话多行窗口的真实字节数会把 maxBytes 顶穿（每行漏 1 字节）。
 * 返回内容里的换行统一成 `\n`（与 chunks.js 的 `split(/\r?\n/)` 同一口径），CRLF 文件的
 * 行号与段落划分因此和 LF 文件完全一致。
 */
function sliceOf(lines, startLine, startByte, maxBytes) {
  const firstText = lines[startLine - 1]
  const fromChar = startByte > 0 ? charIndexOfByte(firstText, startByte) : 0
  if (fromChar < 0) return { error: 'invalid_start' }
  const restBytes = Buffer.byteLength(firstText.slice(fromChar), 'utf8')
  if (restBytes > maxBytes) {
    const chars = charsWithinBytes(firstText, fromChar, maxBytes)
    const text = firstText.slice(fromChar, fromChar + chars)
    const bytes = Buffer.byteLength(text, 'utf8')
    return {
      startLine,
      endLine: startLine,
      content: text,
      bytes,
      truncated: true,
      lineTooLong: true,
      nextStartLine: startLine,
      nextStartByte: startByte + bytes,
    }
  }
  const parts = []
  let bytes = 0
  let lastLine = startLine
  let nextStartLine = null
  for (let i = startLine - 1; i < lines.length; i++) {
    const isFirst = i === startLine - 1
    const seg = isFirst && fromChar > 0 ? lines[i].slice(fromChar) : lines[i]
    const segBytes = Buffer.byteLength(seg, 'utf8')
    const sep = parts.length ? 1 : 0
    // 首行在这一步必定装得下（restBytes ≤ maxBytes 且没有 sep），所以不会一上来就 break。
    if (bytes + sep + segBytes > maxBytes) {
      nextStartLine = i + 1
      break
    }
    parts.push(seg)
    bytes += sep + segBytes
    lastLine = i + 1
  }
  return {
    startLine,
    endLine: lastLine,
    content: parts.join('\n'),
    bytes,
    truncated: nextStartLine !== null,
    lineTooLong: false,
    nextStartLine,
    // 只有单行超长那条路会给出非 0 偏移；这里保持数字类型（不用 null），免得工具 schema
    // 里出现一个 nullable 字段 —— 读到底时 nextStartLine 已经是 null，够判了。
    nextStartByte: 0,
  }
}

/** 归一化错误码 → 给模型看的一句话（不出路径：本仓库是公开仓库，错误串会进工具输出）。 */
function invalidMessage(error) {
  if (error === 'invalid_name') return '文件名不合法：只认记忆目录下的单段 .md，且不能是索引 / 流水这类非条目'
  if (error === 'invalid_start') return '起始位置不合法：startLine 须是 ≥1 的整数，startByte 须是 ≥0 的整数且落在字符边界上'
  return 'maxBytes 不合法：须是 ≥1 的数字'
}

/**
 * 读一段。**所有失败都返回对象，绝不抛** —— 工具层不许因为一次读失败把整轮对话炸掉。
 *
 * @param {{name:string,revision?:string,startLine?:number,startByte?:number,maxBytes?:number,dir?:string}} req
 *   `dir` 只用于测试注入（默认 `MEMORY_DIR`）；生产调用方不许传它 —— 文件名一律经 `safeName`。
 * @returns {Promise<object>} 见文件头的接口说明；`code ∈ invalid|not_found|denied|revision_changed|io_error`
 */
export async function readSlice(req = {}) {
  try {
    const norm = normalizeReadRequest(req)
    if (norm.error) return { ok: false, code: 'invalid', error: invalidMessage(norm.error) }
    const dir = typeof req?.dir === 'string' && req.dir !== '' ? req.dir : MEMORY_DIR
    const full = join(dir, norm.name)

    // ── 闸门：与 MemoryGateway.readFile 同序同函数，一条都不新写 ──
    if (await shadowsReserved(full, dir)) {
      return {
        ok: false,
        code: 'denied',
        error: `拒绝读取 ${norm.name}：这是某个保留名（索引 / 流水）的另一个名字`,
      }
    }
    const gate = await inspectMemoryEntry(full)
    // 体积闸门就用 inspectMemoryEntry 的默认上限（MAX_FILE_BYTES = 512 KB），与写入路径
    // 同一把尺子：不传 limitBytes 是有意的 —— 上限只有一个来源，工具这条路不开后门。
    if (!gate.ok) {
      if (gate.code === 'missing') return { ok: false, code: 'not_found', error: `没有这份记忆：${norm.name}` }
      // stat-failed 不是「形状不对」，是读不到属性（权限 / 盘掉线）→ 归 io_error 更好排查
      if (gate.code === 'stat-failed') return { ok: false, code: 'io_error', error: `读不到文件属性：${gate.error}` }
      return { ok: false, code: 'denied', error: `拒绝读取 ${norm.name}：${gate.error}` }
    }

    const content = await readFile(full, 'utf8')
    const revision = revisionOf(content)
    /**
     * 带了 revision 就一定校验，且**不返回任何内容 / 行号**：过期行号比「读不到」危险得多 ——
     * 调用方会以为自己在说「那份文件的第 40 行」，实际读到的是改过之后的第 40 行。
     */
    if (norm.revision && norm.revision !== revision) {
      return {
        ok: false,
        code: 'revision_changed',
        revision,
        error: `内容已变（当前 ${revision}），请按新 revision 重新定位`,
      }
    }

    /**
     * 行号口径 = `content.split(/\r?\n/)` 的下标 + 1，与 chunks.js 完全同一份写法。
     * 所以以换行结尾的文件会多出一个空行 —— 这个「多出来的第 N 行」是**故意**与分段层对齐的：
     * 两边各自立一套口径，才会出现「工具读第 40 行、段落说第 40 行、内容却不是同一行」这种错位。
     */
    const lines = content.split(/\r?\n/)
    const totalLines = lines.length
    if (norm.startLine > totalLines) {
      return {
        ok: false,
        code: 'invalid',
        error: `起始行 ${norm.startLine} 超出行数 ${totalLines}（行号是 1-based，可能拿着过期游标）`,
      }
    }

    const cut = sliceOf(lines, norm.startLine, norm.startByte, norm.maxBytes)
    if (cut.error) {
      return { ok: false, code: 'invalid', error: `起始字节 ${norm.startByte} 不落在字符边界上（或超出该行）` }
    }
    return {
      ok: true,
      name: norm.name,
      revision,
      startLine: cut.startLine,
      endLine: cut.endLine,
      // 请求里的行内偏移原样回显，客户端据此接着算 nextStartByte（同一把尺子）
      startByte: norm.startByte,
      nextStartLine: cut.nextStartLine,
      nextStartByte: cut.nextStartByte,
      totalLines,
      content: cut.content,
      bytes: cut.bytes,
      truncated: cut.truncated,
      lineTooLong: cut.lineTooLong,
    }
  } catch (err) {
    // 扫到读之间被删是正常状态（不是故障）；其余一律出声，别让「读不到」变成无声空内容。
    if (err?.code === 'ENOENT') return { ok: false, code: 'not_found', error: '这份记忆在读取过程中被删掉了' }
    return { ok: false, code: 'io_error', error: `读取失败（${err?.code ?? err?.message ?? err}）` }
  }
}
