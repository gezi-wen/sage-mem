/**
 * sage-mem 记忆层 —— 写协议：**读快照带 revision、整份覆盖带守卫**（2.1.2 / 外部审查 Q02）。
 *
 * 问题：原来的 `readFile` 只交正文、不交「这份正文是哪一版」；`writeFile` / `writeArchived` /
 * `writeRaw` 只管原子替换（不暴露半截内容），**不保证没有别的更新** —— 面板读 A、别处存 B、
 * 面板再把基于 A 的 C 存回去，B 就没了，而两边都报成功。
 *
 * 契约（additive，旧调用方不受影响）：
 *   · 读：结果多一个 `revision`（正文**字节**的 sha256）；
 *   · 写：可选 `opts.expectedRevision`；对不上 → `{ok:false, code:'stale_revision'}`，
 *     当前内容一个字节不动；调用方拿新 revision 重读、比较、重新应用。
 *   · 写：可选 `opts.create`（createIfAbsent）—— 新建撞名一律 `{ok:false, code:'already_exists'}`，
 *     **绝不**走覆盖入口；
 *   · 不传 `opts` 的旧调用方照旧覆盖，但会落一条 warn（静默无守卫覆盖不再允许）。
 *
 * 为什么单列一个模块而不是长在 `lib/index.js`：组合根有 ≤1000 行的结构守卫
 * （`test/structure-test.mjs`），而「读版本 → 比版本 → 写」这段顺序是**协议**不是组合根的接线。
 *
 * ⚠️ 边界：这是**内容 hash 守卫**，不是跨进程锁。校验与落盘之间仍有一个极窄窗口
 * （外部编辑器恰在此刻改文件仍会被覆盖）；进程内并发由 `createWriteQueue` 那一层负责，
 * 面板这条路上「读快照 → 用户思考 → 保存」的窗口正是 revision 覆盖的那一段。
 */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readVerified } from './scan.js'
import { warnLog, writeFileAtomic, writeFileExclusive } from './util.js'

/** 冲突码：内容在「读快照」之后被改过。固定字符串，界面与测试都只认它。 */
export const ERR_STALE_REVISION = 'stale_revision'
/** 冲突码：`create`（createIfAbsent）撞上已有文件 —— 新建绝不覆盖已有内容。 */
export const ERR_ALREADY_EXISTS = 'already_exists'

/** 内容 revision：字节的 sha256。读与写必须用同一个算法，调用方原样回传。 */
export function revisionOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 读一份**可信快照**：content 与 revision 在同一次读取里拿到。
 *
 * 调用方不能只拿一半 —— 「正文来自这次读、版本来自另一次读」正是 Q02 的成因。
 *
 * @returns {Promise<{name:string, content:string, revision:string}>}
 */
export async function readSnapshot(full, gate, name) {
  const bytes = await readVerified(full, gate, false)
  return { name, content: bytes.toString('utf8'), revision: revisionOf(bytes) }
}

/** 旧调用方的兼容提示（一次写入一行，不做去重 —— 谁漏传一眼就能在日志里翻到）。 */
const LEGACY_WARN = '没有带 expectedRevision，按旧协议直接覆盖（面板必须带；旧调用方仅兼容，建议尽快带上）'

/**
 * 写入前置闸门：**一套顺序**，三处写路径（`writeFile` / `writeArchived` / `writeRaw`）共用。
 *
 * 为什么要有它：这三处曾经各写一遍，闸门顺序还不一样 —— 内容类型检查分别排在
 * 第 3 / 第 6 / 第 3 位，`writeRaw` 用的上限常量也不同。于同一个坏输入从三个入口进去
 * 会报三个不同的「第一个错」，而这里正是历史事故最集中的地方（D4、2026-09-25 P0、R01）。
 *
 * 现在的顺序**固定为**：
 *   ① 保留名（`requireReserved` 时反向：只许保留名）
 *   ② 名字合法（唯一判据 `shared/md-name.js` 的 `safeName`）
 *   ③ 目录闸（归档区专属，可选）
 *   ④ 影子文件 / 8.3 短名（内存区专属，可选）
 *   ⑤ 内容必须是字符串
 *   ⑥ 体积上限
 *   ⑦ 磁盘探针（链接 / 硬链接拒绝；`allowMissing` 决定「不存在」算不算合法）
 *
 * 失败一律返回 `{ok:false, code, file, error}` —— **不抛异常**（调用方按 ok 判定）。
 *
 * @param {object} spec
 * @param {string} spec.name       调用方给的名字（未归一）
 * @param {unknown} spec.content   待写正文
 * @param {number} spec.limitBytes 体积上限
 * @param {string} [spec.limitLabel] 错误文案里的上限描述（默认字节数）
 * @param {(n:string)=>boolean} spec.isReserved
 * @param {(n:string)=>string} spec.nameKey
 * @param {(n:string)=>string|null} spec.safeName
 * @param {boolean} [spec.requireReserved=false]
 * @param {((full:string)=>Promise<boolean>)} [spec.shadowCheck]
 * @param {(()=>Promise<{ok:boolean,error?:string}>)} [spec.dirCheck]
 * @param {string} spec.dir         目标目录
 * @param {(full:string, opts:object)=>Promise<object>} spec.inspectEntry
 * @param {boolean} [spec.allowMissing=true] 磁盘探针是否允许「不存在」
 * @returns {Promise<{ok:true, safe:string, target:string, gate:object}
 *   | {ok:false, code:string, file?:string, error:string}>}
 */
export async function prepareWrite(spec) {
  const {
    name, content, limitBytes, limitLabel,
    isReserved, nameKey, safeName,
    requireReserved = false,
    shadowCheck = null,
    dirCheck = null,
    dir,
    inspectEntry,
    allowMissing = true,
  } = spec

  // ① 保留名。writeRaw 是反向的：它**只**服务索引 / 流水。
  const reserved = typeof isReserved === 'function' ? isReserved(name) : false
  if (requireReserved ? !reserved : reserved) {
    return requireReserved
      ? { ok: false, code: 'reserved', error: `sage-mem: ${String(name)} is not a reserved file; normal memories use the memory form or writeFile` }
      : { ok: false, code: 'reserved', file: nameKey(name), error: `sage-mem: reserved file, edit it with the file tools: ${nameKey(name)}` }
  }

  // ② 名字合法。这里**返回回执而不是抛** —— 同一方法里「保留名回执、非法名抛异常」曾经
  // 让 writeFile 的 JSDoc（「拒绝一律返回 { ok: false }」）变成假话。
  const safe = safeName(name)
  if (!safe) return { ok: false, code: 'invalid_name', file: '', error: `sage-mem: invalid file name: ${String(name)}` }

  // ③ 目录闸（归档区：目录读不了就别谈写）
  if (dirCheck) {
    const d = await dirCheck()
    if (!d.ok) return { ok: false, code: 'io_error', file: safe, error: `sage-mem: archive dir unavailable: ${d.error}` }
  }

  const target = join(dir, safe)

  // ④ 影子文件：名字文本不是保留名 ≠ 文件不是保留名（NTFS 8.3 短名能改写索引）
  if (shadowCheck && (await shadowCheck(target))) {
    return { ok: false, code: 'reserved', file: safe, error: `sage-mem: reserved file (它的另一个名字是 ${safe})，请用文件工具改` }
  }

  // ⑤ 内容类型。不加这一层，传个对象进来会被 String() 写成 "[object Object]" 还回 ok:true。
  if (typeof content !== 'string') {
    return { ok: false, code: 'invalid', file: safe, error: `sage-mem: content must be a string, got ${typeof content}` }
  }

  // ⑥ 体积
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > limitBytes) {
    return { ok: false, code: 'too_big', file: safe, error: `sage-mem: content too large (${bytes} bytes > ${limitLabel || limitBytes})` }
  }

  // ⑦ 磁盘探针：目标已存在时若是链接 / 硬链接，一律拒绝 ——
  // 「改这条记忆」不该变成「把这个名字指向别处」。体积上面刚查过，这里不判。
  const gate = await inspectEntry(target, { limitBytes: null })
  if (!gate.ok && !(allowMissing && gate.code === 'missing')) {
    return {
      ok: false,
      code: gate.code || 'io_error',
      file: safe,
      error: allowMissing
        ? `sage-mem: refusing to write ${safe}: ${gate.error}`
        : gate.code === 'missing'
          ? `sage-mem: archived file not found: ${safe}`
          : `sage-mem: refusing to write archived ${safe}: ${gate.error}`,
    }
  }

  return { ok: true, safe, target, gate }
}

/**
 * 整份覆盖写：`create` / `expectedRevision` / 旧调用方三种语义，一个出口。
 *
 * @param {string} target — 完整路径（名字闸门由调用方先过）
 * @param {string} content — 要写的正文
 * @param {object} gate — 调用方刚取到的 `inspectMemoryEntry` 结果（ok 或 code:'missing'）
 * @param {object} [opts] — `{ expectedRevision?, create? }`
 * @param {{ctx:object, name:string, kind:string}} meta — 日志与回执用
 * @returns {Promise<{ok:true, file:string, revision:string, created?:boolean}
 *   | {ok:false, code:string, file?:string, error:string}>}
 */
export async function writeSnapshot(target, content, gate, opts, meta) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const name = meta?.name ?? ''
  const rejected = (code, error) => ({ ok: false, code, file: name, error })

  // ① createIfAbsent：新建只能「建出来」或「明确报已存在」，没有第三条路。
  if (o.create === true) {
    if (gate?.ok) return rejected(ERR_ALREADY_EXISTS, `sage-mem: ${name} 已经存在，新建不会覆盖它（要改正文请打开它）`)
    try {
      // 2.1.10（Q10）：createIfAbsent 也负责「全新安装、父目录还不存在」这一种：
      // writeFileExclusive 的临时文件落在同一目录，目录不在就会 ENOENT（审查实测）。
      // 只建父目录、绝不动目标文件 —— 「建立索引骨架」这个意图由调用方一次说清。
      await mkdir(dirname(target), { recursive: true })
      await writeFileExclusive(target, content)
    } catch (err) {
      if (err?.code === 'EEXIST') return rejected(ERR_ALREADY_EXISTS, `sage-mem: ${name} 刚刚被别的写入建出来了，新建没有覆盖它`)
      return rejected('io_error', `sage-mem: 写入 ${name} 失败：${String(err?.message ?? err)}`)
    }
    return { ok: true, file: name, revision: revisionOf(Buffer.from(content, 'utf8')), created: true }
  }

  // ② 带 expectedRevision：盘上版本与调用方读到的不一致 → 拒绝，内容一个字节不动。
  if (o.expectedRevision !== undefined && o.expectedRevision !== null) {
    if (!gate?.ok) {
      // 读快照时还在、现在没了：这同样是「版本已变」，不能悄悄当成新建写回去。
      return rejected(ERR_STALE_REVISION, `sage-mem: ${name} 已经不在盘上了（读取之后被删除或改名），没有写入`)
    }
    let current
    try {
      current = revisionOf(await readVerified(target, gate, false))
    } catch (err) {
      return rejected(ERR_STALE_REVISION, `sage-mem: 读不到 ${name} 的当前版本（${err?.code ?? err}），没有写入`)
    }
    if (current !== o.expectedRevision) {
      // 错误正文是给用户看的：草稿还在、下一步该做什么，都要说清楚（界面直接显示它）。
      return rejected(
        ERR_STALE_REVISION,
        `sage-mem: ${name} 在你保存之前已经被别的写入改过（当前版本 ${current.slice(0, 12)}…）。你的草稿还在，请先查看最新内容再决定如何重新应用 —— 没有自动覆盖`,
      )
    }
  } else {
    // ③ 旧调用方：additive 契约允许继续工作，但必须留痕（否则「静默覆盖」永远查不出来）。
    warnLog(meta?.ctx, `${meta?.kind ?? 'write'}(${name}) ${LEGACY_WARN}`)
  }

  try {
    await writeFileAtomic(target, content)
  } catch (err) {
    return rejected('io_error', `sage-mem: 写入 ${name} 失败：${String(err?.message ?? err)}`)
  }
  return { ok: true, file: name, revision: revisionOf(Buffer.from(content, 'utf8')) }
}
