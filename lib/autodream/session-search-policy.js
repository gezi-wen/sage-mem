/**
 * sage-mem autodream — `search_sessions` 的**纯策略层**：选谁、切多宽、记哪些账、怎么说。
 *
 * 这一层**零 import**（连 `node:` 都没有）：所有决定都能对着字符串与假对象断言。
 * 真正的 readdir / readFile / zstd 解压在 `session-search.js`，纯度边界由
 * `test/structure-test.mjs` 第 5 组看着。
 *
 * ## 为什么要把「决定」从「IO」里拆出来（2.19.0）
 *
 * 旧实现把五件事混在一个函数里，而**每一件都能静默缩小搜索面**：只扫最近若干个会话、
 * 片段从行首硬切、字符预算按**未切片的整行长度**记账、文件名只认一个代际、
 * 读不动或只解出一半的文件直接跳过。最后那句「在**全部**的会话记录里没找到」
 * 于是把「看完了没有」与「没看全」说成了同一句话 —— 而下游会拿它当证据。
 *
 * ## 四条口径（本文件是它们的唯一落点）
 *
 * 1. **两条轴不许混算**：
 *    - **输入覆盖** `complete` —— 我到底看了多少、跳了多少；
 *    - **输出截断** `truncated` —— 给出去的片段有多完整。
 *    `complete:true, truncated:true` 完全合法（全部会话都读了，但每条证据被窗口裁短），
 *    反过来 `complete:false, truncated:false` 也合法（只看了若干个，一个也没命中）。
 *    把 `truncated` 塞进 `complete` 的判据里，这两件事就再也分不开了。
 *
 * 2. **文件桶互斥且穷尽**：每个「进队」的会话文件恰好落进
 *    `searched / partial / failed / skippedByOutput` 之一，再加上没进队的 `skippedByCap`，
 *    其和必须等于 `available`。`partial` **不再**同时计入 `searched` —— 「解了一半」
 *    被当成「完整」正是旧账算不清的根源。
 *
 * 3. **预算按实际吐出的字算**（`hitChars`），不是按源行长度。片段以关键词为中心取窗，
 *    因此「片段里看得到关键词」是可断言的，而不是碰运气。
 *
 * 4. **零命中的说法由 `complete` 决定**：完整才允许说「没有」，不完整必须限定范围；
 *    目录读不了时，一句话都不许听起来像「没有」。
 */

/** 会话正文的**唯一**认得格式（2.19.0 只读 v4；v3 / 无版本只报告不读）。 */
export const RECOGNIZED_SESSION_FILE = 'session.v4.jsonl.zstd'

/** 单次最多看多少个会话（**不扩大**：要扩先做逐帧早停，见 session-search.js 的成本注释）。 */
export const SEARCH_DIR_CAP = 40

/** 单条命中片段最多多少字。 */
export const HIT_CHARS = 500

/**
 * 命中片段的**总字符预算**（全部 hitChars 之和）。
 *
 * ⚠️ 旧实现的同名概念记的是**源行长度之和**，于是「一条几万字的长记录」就能把预算花光、
 * 只吐出一小段。现在它约束的是真正发出去的字符数。
 */
export const CHAR_BUDGET = 8000

/** `limit` 的默认值与上限（工具层夹取用）。 */
export const DEFAULT_HIT_LIMIT = 20
export const MAX_HIT_LIMIT = 60

/** 关键词至少几个字符。 */
export const MIN_NEEDLE_CHARS = 2

/** 短于这个长度的行直接跳过（粘贴出来的 `}` / `0` 之类，命中它没有信息量）。 */
export const MIN_LINE_CHARS = 8

/** coverage 的口径版本。加字段不换号，**改已有字段的含义**才换。 */
export const COVERAGE_SCHEMA = 1

/** 会话目录的根状态（决定「能不能搜索」，与「搜到了多少」是两件事）。 */
export const ROOT_STATES = ['ok', 'unset', 'missing', 'notdir', 'denied', 'error']

function intOf(v, dflt = 0) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt
}

function normalizeRoot(v) {
  return ROOT_STATES.includes(v) ? v : 'error'
}

/**
 * 一个会话目录里的文件名该算什么：认得 / 旧格式 / 与搜索无关。
 *
 * 为什么这条判据在纯层：它是「能不能看见这个会话」的**唯一**决定，
 * 混进 readdir 里就没法对着文件名做单测。`test/session-search-test.mjs` 第 5 组
 * 逐条钉住 v4 / v3 / 无版本 / `.bak` / 临时文件 / 点文件。
 *
 * @param {string} name 会话目录里的一个文件名
 * @returns {'v4'|'unrecognized'|'ignore'}
 */
export function classifySessionFileName(name) {
  const base = String(name ?? '')
  if (!base || base.startsWith('.')) return 'ignore'
  // 备份 / 临时件：既不是「认得」，也不该被当成「旧格式」吓人一跳。
  if (/\.bak(?:$|[-_.])/i.test(base)) return 'ignore'
  if (base.endsWith('~') || /\.(?:tmp|temp|swp)$/i.test(base)) return 'ignore'
  if (base.toLowerCase() === RECOGNIZED_SESSION_FILE) return 'v4'
  // v3 / 无版本 / 将来别的代际：都是「会话正文但本条路径读不了」→ 只报告，不读。
  if (/^session(?:\.[a-z0-9]+)?\.jsonl\.zstd$/i.test(base)) return 'unrecognized'
  return 'ignore'
}

/**
 * 按 mtime 由新到旧选会话，并把「因为上限没看」**数出来**（以前这个 40 是静默的）。
 *
 * `available` 是**过了时间过滤之后**的总数（coverage 的分母必须与「因上限没看」同源，
 * 否则 `sinceMs>0` 时被时间滤掉的那些会被误算成「因上限没看」）。
 *
 * @param {Array<{file:string, mtimeMs:number}>} entries
 * @param {{cap?:number, sinceMs?:number}} [opts]
 * @returns {{considered:Array<{file:string, mtimeMs:number}>, skippedByCap:number, available:number}}
 */
export function pickSessionsByMtime(entries, opts = {}) {
  const cap = intOf(opts.cap ?? SEARCH_DIR_CAP, SEARCH_DIR_CAP)
  const sinceMs = Number.isFinite(opts.sinceMs) ? Number(opts.sinceMs) : 0
  const rows = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.file === 'string' && Number.isFinite(e.mtimeMs) && e.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { considered: rows.slice(0, cap), skippedByCap: Math.max(0, rows.length - cap), available: rows.length }
}

/**
 * 在行里找关键词的起点。
 *
 * 先试**原样**匹配（对中文、对含大小写变化就改变长度的字符都稳），再退回小写匹配
 * （`ERROR` 要能命中 `error`）。退回那条只在两侧长度一致时位置可信 —— 不一致时仍返回
 * 小写索引（最好的努力），片段是否真的含关键词由 `hasMatch` 如实标出，不靠猜。
 */
function findNeedle(line, raw, needle) {
  if (!raw) return -1
  const exact = line.indexOf(raw)
  if (exact >= 0) return exact
  return line.toLowerCase().indexOf(needle)
}

/**
 * 以**关键词位置为中心**取窗（从行首硬切时，关键词落在窗口之后，片段里就看不到它）。
 *
 * `maxChars` 是硬上限：加了省略号也不会超。**省略号只在真的被裁掉的那一侧出现** ——
 * 关键词几乎占满窗口时（例如 499 字关键词配 500 字窗口）左侧没有可省的上下文，
 * 再补一个 `…` 就会吃掉关键词的第一个字，于是「命中」返回的片段里反而搜不到它。
 */
export function centeredExcerpt(line, idx, needleLen, maxChars = HIT_CHARS) {
  const src = String(line ?? '')
  const room = Math.max(1, intOf(maxChars, HIT_CHARS) || HIT_CHARS)
  if (src.length <= room) return { text: src, clipped: false }
  if (needleLen >= room) return { text: src.slice(idx, idx + room), clipped: true }
  let start = Math.max(0, idx - Math.floor((room - needleLen) / 2))
  let end = Math.min(src.length, start + room)
  // 贴到尾部时往回挪，别让窗口白白空出半截。
  start = Math.max(0, end - room)
  let text = src.slice(start, end)
  // 省略号在窗口**内部**换字，因此总长恒等于 room。
  // 左侧只在 `start < idx`（确有被省掉的上下文）时才补，否则会切到关键词本身。
  if (start > 0 && start < idx && text.length >= room) text = '…' + text.slice(1)
  if (end < src.length && end > idx + needleLen && text.length >= room) text = text.slice(0, room - 1) + '…'
  return { text, clipped: true }
}

/**
 * 在一份已解码的会话文本里找命中。
 *
 * @param {string} text 解出来的会话正文（逐行 jsonl）
 * @param {string} rawQuery 模型给的原样关键词
 * @param {{perLineChars?:number, limit?:number, charBudget?:number}} [opts]
 * @returns {{hits:Array<{lineNo:number, offset:number, excerpt:string, chars:number, hasMatch:boolean}>,
 *            hitChars:number, stoppedBy:null|'limit'|'chars', clipped:boolean,
 *            stoppedEarly:boolean, scannedLines:number, totalLines:number}}
 */
export function matchLines(text, rawQuery, opts = {}) {
  const raw = String(rawQuery ?? '')
  const needle = raw.toLowerCase()
  const perLineChars = intOf(opts.perLineChars ?? HIT_CHARS, HIT_CHARS) || HIT_CHARS
  const limit = Math.max(1, intOf(opts.limit ?? DEFAULT_HIT_LIMIT, DEFAULT_HIT_LIMIT) || DEFAULT_HIT_LIMIT)
  const charBudget = intOf(opts.charBudget ?? CHAR_BUDGET, CHAR_BUDGET)
  const lines = String(text ?? '').split(/\r?\n/)
  // 尾随换行会 split 出一个空串：算「有没有读完」时得把它剔掉，否则会假报 stoppedEarly。
  let effectiveTotal = 0
  for (let i = 0; i < lines.length; i++) if (lines[i].length > 0) effectiveTotal = i + 1

  const hits = []
  let hitChars = 0
  let stoppedBy = null
  let clipped = false
  let scannedLines = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    scannedLines = i + 1
    if (line.length < MIN_LINE_CHARS) continue
    if (needle.length < MIN_NEEDLE_CHARS) break
    const idx = findNeedle(line, raw, needle)
    if (idx < 0) continue
    const cut = centeredExcerpt(line, idx, needle.length, perLineChars)
    if (cut.clipped) clipped = true
    // 预算判据按**实际吐出的字**算，且先判后加 —— 所以 hitChars 恒 ≤ charBudget。
    if (hitChars + cut.text.length > charBudget) {
      stoppedBy = 'chars'
      break
    }
    hits.push({
      lineNo: i + 1,
      offset: idx,
      excerpt: cut.text,
      chars: cut.text.length,
      hasMatch: cut.text.includes(raw) || cut.text.toLowerCase().includes(needle),
    })
    hitChars += cut.text.length
    if (hits.length >= limit) {
      stoppedBy = 'limit'
      break
    }
  }

  return {
    hits,
    hitChars,
    stoppedBy,
    clipped,
    // 「这个文件没读完」—— 因为输出上限停下的，才算 partial；正好停在最后一行不算。
    stoppedEarly: stoppedBy !== null && scannedLines < effectiveTotal,
    scannedLines,
    totalLines: effectiveTotal,
  }
}

/**
 * 把逐文件结果折成 coverage。**`complete` 只在这里算**（别处算就会有两套口径）。
 *
 * 派生关系（契约）：
 *   `searched + partial + failed + skippedByCap + skippedByOutput === available`
 *   `complete = root==='ok' && !zstdUnsupported && enumerationFailed===0 && unrecognized===0
 *               && skippedByCap===0 && skippedByOutput===0 && failed===0 && partial===0`
 *   `truncated = clipped || stoppedBy !== null` —— **不进 complete**（见文件头第 1 条）。
 *
 * @param {object} input
 * @param {string} [input.root] `ROOT_STATES` 之一
 * @param {Array<'searched'|'partial'|'failed'>} [input.outcomes] 逐个**已开始**文件的结局
 * @param {number} [input.available] 枚举到的、认得的会话总数（分母）
 * @param {number} [input.skippedByOutput] 已进队但因输出停止没开始的份数
 * @param {number} [input.unrecognized] 旧格式 / 不认得而没读的会话份数
 * @param {number} [input.enumerationFailed] 枚举阶段失败的次数（目录列不出来等）
 * @param {boolean} [input.zstdUnsupported] 当前 Node 没有 zstd 解压
 * @param {string} [input.rootMessage] 根失败时的补充说明（给人看）
 * @param {string|null} [input.stoppedBy] `null` / `'limit'` / `'chars'`
 * @param {boolean} [input.clipped] 有片段被窗口裁短
 * @param {number} [input.hitCount]
 * @param {number} [input.hitChars]
 * @param {object} [input.caps] `{dirCap, charBudget, limit}`
 * @returns {object} coverage（字段见契约；schema 见 `COVERAGE_SCHEMA`）
 */
export function classifyCoverage(input = {}) {
  const outcomes = Array.isArray(input.outcomes) ? input.outcomes : []
  let searched = 0
  let partial = 0
  let failed = 0
  for (const o of outcomes) {
    if (o === 'failed') failed += 1
    else if (o === 'partial') partial += 1
    else if (o === 'searched') searched += 1
  }
  const skippedByOutput = intOf(input.skippedByOutput)
  const considered = searched + partial + failed + skippedByOutput
  const available = input.available === undefined ? considered : intOf(input.available)
  const skippedByCap = Math.max(0, available - considered)
  const root = normalizeRoot(input.root)
  const zstdUnsupported = input.zstdUnsupported === true
  const unrecognized = intOf(input.unrecognized)
  const enumerationFailed = intOf(input.enumerationFailed)
  const stoppedBy = input.stoppedBy === 'limit' || input.stoppedBy === 'chars' ? input.stoppedBy : null
  const clipped = input.clipped === true
  const caps = input.caps && typeof input.caps === 'object' ? input.caps : {}

  return {
    schema: COVERAGE_SCHEMA,
    root,
    rootMessage: typeof input.rootMessage === 'string' ? input.rootMessage : '',
    available,
    considered,
    searched,
    partial,
    failed,
    skippedByCap,
    skippedByOutput,
    unrecognized,
    enumerationFailed,
    zstdUnsupported,
    hitCount: intOf(input.hitCount),
    hitChars: intOf(input.hitChars),
    stoppedBy,
    // 输出轴：只由「片段被裁」与「预算停下」决定，与输入覆盖无关。
    truncated: clipped || stoppedBy !== null,
    // 输入轴：派生值，不许单独赋真。
    complete:
      root === 'ok' &&
      !zstdUnsupported &&
      enumerationFailed === 0 &&
      unrecognized === 0 &&
      skippedByCap === 0 &&
      skippedByOutput === 0 &&
      failed === 0 &&
      partial === 0,
    dirCap: intOf(caps.dirCap ?? SEARCH_DIR_CAP, SEARCH_DIR_CAP),
    charBudget: intOf(caps.charBudget ?? CHAR_BUDGET, CHAR_BUDGET),
    limit: intOf(caps.limit ?? DEFAULT_HIT_LIMIT, DEFAULT_HIT_LIMIT),
  }
}

/** 根不可用时的那一句（**不许**听起来像「搜过了但没有」）。 */
function rootHead(c) {
  const tail = '本次一次会话都没读，既不能当「有」也不能当「没有」。'
  if (c.root === 'unset') return `无法搜索：没有配置会话目录（DSH_HOME 未设置）。${tail}`
  if (c.root === 'missing') return `无法搜索：会话目录不存在。${tail}`
  if (c.root === 'notdir') return `无法搜索：会话目录的路径不是一个目录。${tail}`
  if (c.root === 'denied') return `无法搜索：没有权限读取会话目录。${tail}`
  if (c.root !== 'ok') {
    const why = c.rootMessage ? `（${c.rootMessage}）` : ''
    return `无法搜索：读取会话目录失败${why}。${tail}`
  }
  // 根没问题，是运行时读不了：这是环境限制，同样不许说成「没有」。
  return '无法搜索：当前 Node 不支持 zstd 解压，会话记录一个都读不了。这是环境限制，不代表会话里有没有相关内容。'
}

/** 覆盖那句话（首行）。 */
export function formatCoverageLine(c) {
  const parts = [`可用 ${c.available} 个会话`]
  parts.push(c.considered === c.available ? `进队 ${c.considered} 个` : `进队 ${c.considered} 个（上限 ${c.dirCap}）`)
  parts.push(`完整搜索 ${c.searched}`, `只读到一部分 ${c.partial}`, `读不动 ${c.failed}`)
  if (c.skippedByCap) parts.push(`因上限没看 ${c.skippedByCap}`)
  if (c.skippedByOutput) parts.push(`因输出预算没开始 ${c.skippedByOutput}`)
  if (c.unrecognized) parts.push(`旧格式 / 不认得 ${c.unrecognized}`)
  if (c.enumerationFailed) parts.push(`枚举失败 ${c.enumerationFailed}`)
  return parts.join(' · ')
}

/** 输出被截断的原因（与输入覆盖是两件事，所以单列）。 */
export function stopReason(c) {
  if (c.stoppedBy === 'limit') return `段数到上限 ${c.limit}`
  if (c.stoppedBy === 'chars') return `片段字符预算 ${c.charBudget} 到顶`
  if (c.truncated) return `每条片段都被窗口裁到 ${HIT_CHARS} 字以内`
  return ''
}

/**
 * 零命中时的那一句：**完整**才允许说「没有」。
 *
 * 范围的分母用 `searched + partial`（真正读到了内容的那些），**不**把
 * `skippedByOutput` / `failed` 算进「看得到」—— 没开始读的与读不动的都不是证据。
 */
export function formatMissLine(rawQuery, c) {
  const q = String(rawQuery ?? '')
  if (c.complete) return `（完整搜索了全部 ${c.available} 个会话，没找到含「${q}」的内容）`
  const readable = c.searched + c.partial
  const gaps = []
  if (c.skippedByCap) gaps.push(`${c.skippedByCap} 个因上限没看`)
  if (c.skippedByOutput) gaps.push(`${c.skippedByOutput} 个因输出预算没开始`)
  if (c.failed) gaps.push(`${c.failed} 个读不动`)
  if (c.partial) gaps.push(`${c.partial} 个只读到一部分`)
  if (c.unrecognized) gaps.push(`${c.unrecognized} 个是旧格式没读`)
  if (c.enumerationFailed) gaps.push(`${c.enumerationFailed} 次目录枚举失败`)
  const scope = gaps.length ? `（另有 ${gaps.join('、')}）` : ''
  if (readable === 0) {
    return `（一个会话都没读到内容${scope} —— 这既不是「有」也不是「没有」）`
  }
  return `（在真正读到的 ${readable} 个会话里没找到含「${q}」的内容${scope} —— **这不等于会话里没有**）`
}

/**
 * 渲染整份结果：**首行先报覆盖，再报命中**（埋到末尾等于没有）。
 *
 * 兼容约定：命中行仍以 `[时间戳]` 开头、命中摘要仍是 `命中 N 段`、零命中仍是「没找到」——
 * `test/q-fixes-095.mjs` 的判据依赖这三个 token（`isHit` 与 `/没找到/`）。
 *
 * @param {{rawQuery?:string, hits?:Array<{stamp:string, excerpt:string}>, coverage:object}} input
 * @returns {string}
 */
export function renderSearchReport(input = {}) {
  const c = input.coverage
  const rawQuery = String(input.rawQuery ?? '')
  const hits = Array.isArray(input.hits) ? input.hits : []

  if (c.root !== 'ok' || c.zstdUnsupported) return rootHead(c)

  const head = `${c.complete ? '覆盖完整' : '覆盖不完整'}：${formatCoverageLine(c)}。`
  const scopeNote = c.complete ? '' : '\n下面的结果只代表**看得到的这些会话**，不代表全部会话。'
  if (!hits.length) return `${head}${scopeNote}\n${formatMissLine(rawQuery, c)}`

  const body = hits.map((h) => `[${h.stamp}] ${h.excerpt}`).join('\n')
  const tail = c.truncated ? `\n\n（输出被截断：${stopReason(c)}；输入覆盖见首行）` : ''
  return `${head}${scopeNote}\n命中 ${hits.length} 段（按 mtime 由新到旧）：\n\n${body}${tail}`
}
