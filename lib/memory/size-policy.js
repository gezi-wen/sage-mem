/**
 * 体积治理的**判据**（纯函数，零 IO）。
 *
 * 为什么要有这个模块：2.10.1 之前「一条记忆算不算太大」这件事根本没有判据 ——
 * 阈值只以数字的形式散在文案与提示词里（`read_memory` 的一句提醒、自动整理的
 * 「超过 40 KB 必须处置」、审计的统计），谁也没法把它们对同一份内容问一遍。
 * 结果是同一份 20 KB 的记忆，工具面说「没超」，审计说「超了」—— 这种自相矛盾
 * 最容易被读成「插件坏了」。判据收到这里，别处只调用，不再自己写数字。
 *
 * ⚠️ 这是**软线**判定，不是写闸门。512 KB 那条硬线在 `memory/write-protocol.js`
 * 的 `prepareWrite`（超了直接拒写、行为不可变）；本模块只回答「该不该提醒」
 * 「该不该强制处置」「该不该只报不改」。两条线混在一起，体积治理就会变成
 * 「写到一半突然被拒」，那是最坏的一种改动。
 *
 * 依赖方向（`test/structure-test.mjs` 盯着）：只认 `shared/limits.js`（数字）与
 * `./naming.js`（名字归属）。名字与保留名判据必须与写路径同一份 —— 各写一套的话，
 * 「这个文件算不算一条记忆」在两处会给出相反答案，而其中一处是写闸门。
 */

import { INDEX_DOC_BYTES, INDEX_LINE_CHARS, TRIM_FORCE_BYTES, TRIM_WARN_BYTES } from '../shared/limits.js'
// 索引 / 流水的规范名只在 `shared/md-name.js` 有（`duplication-test.mjs` 会红掉
// 别处的字面量副本）。这里按 key 认名字，而不是自己拼字符串。
import { INDEX_FILE_KEY, SESSION_LOG_KEY } from '../shared/md-name.js'
import { isNonEntry, isReserved, nameKey } from './naming.js'

/**
 * 索引的**提醒线** = 整份上限的一半。
 *
 * 为什么不直接等到 24 KB 才说：索引被整份顶到上限时，摘掉条目这件事已经要手工
 * 做很久了；12 KB 时提醒一句，代价只是几行文字。
 */
const INDEX_WARN_BYTES = INDEX_DOC_BYTES / 2

/**
 * 名字 → 类别：`'entry' | 'index' | 'sessionLog' | 'reserved'`。
 *
 * 顺序**不能换**：索引与流水也都在保护名单里（`RESERVED_FILES` 是它们的超集），
 * 先认它们、剩下的保留名才是「使用者自己声明的保护名单」—— 两者的处置完全不同
 * （一个是「该瘦身」，一个是「一个字都不许动」）。
 *
 * 比较走 `nameKey()`：NTFS / APFS 不区分大小写，`MEMORY.MD` 与 `MEMORY.md` 是同一个
 * 文件（这条洞在设置页上真实地漏过一次整份索引覆盖）。
 *
 * 非字符串 / 空值一律当普通条目：本函数是**分类器**不是校验器，名字合法性归
 * `shared/md-name.js` 的 `isPlainMdName`（写路径用 `safeName` 复核）。
 */
export function kindOfName(name) {
  const key = nameKey(name)
  if (key === INDEX_FILE_KEY) return 'index'
  if (key === SESSION_LOG_KEY) return 'sessionLog'
  // 兜底：将来若再加一个「非条目名」，一律按「不许动」处理（skip 档），而不是当普通条目
  // 去算体积。今天这段走不到 —— 两个非条目名上面已经认掉了，而且 `NON_ENTRY_FILES` 是
  // `RESERVED_FILES` 的子集、下面那条迟早也会接住它。写出来是把「非条目永不进体积账」
  // 变成一条**显式规则**，不靠子集关系的巧合；少报一条永远比多报一条安全。
  if (isNonEntry(name)) return 'reserved'
  if (isReserved(name)) return 'reserved'
  return 'entry'
}

/**
 * 单条正文判定。`bytes` 用 **UTF-8 字节**，不是字符数。
 *
 * 为什么按字节：中文一个字 3 字节，同样「8000 字」的中文正文比英文大三倍；
 * 按字符数判会让一条实际上三倍大的记忆看起来「还没到线」。
 *
 * @param {{bytes:number, kind?:string}} p
 * @returns {{kind:string, bytes:number, level:'ok'|'warn'|'force'|'skip',
 *   limit:number, advice:'trim-or-compress'|'index-slim'|'none'}}
 *   `limit` = 当前这一档对照的那条线（`ok` 档给「下一条会响的线」，好让调用方说出
 *   「离哪条线还有多远」；`skip` 档没有线，给 0）。
 *   `advice` 是给调用方做分支的**稳定枚举**；人读的那句话在 `adviceText()` 里
 *   —— 回执与审计共用同一句，别各写一套。
 */
export function classifySize({ bytes, kind = 'entry' } = {}) {
  // 非法输入一律当 0：这个函数会被审计与工具回执直接叫，抛异常等于「体积治理把
  // 整趟整理弄挂了」。负数 / NaN / 字符串数字都在这里归一。
  const n = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0
  const k = kind === 'index' || kind === 'sessionLog' || kind === 'reserved' ? kind : 'entry'

  // 流水与保护名单**永不计入问题**（契约 §1）：流水只会越来越长（它是追加型流水），
  // 保护名单里的条目是使用者明说「别动」的东西 —— 拿体积去催它们，等于把「保护」
  // 变成一句空话。
  if (k === 'sessionLog' || k === 'reserved') {
    return { kind: k, bytes: n, level: 'skip', limit: 0, advice: 'none' }
  }

  if (k === 'index') {
    // 索引这里只看**整份体积**；单行超长要读正文才知道，归 `indexFindings()`。
    // 两处判据共用同一条线（`INDEX_DOC_BYTES`），别在别处再写一遍数字。
    if (n >= INDEX_DOC_BYTES) return { kind: k, bytes: n, level: 'force', limit: INDEX_DOC_BYTES, advice: 'index-slim' }
    if (n >= INDEX_WARN_BYTES) return { kind: k, bytes: n, level: 'warn', limit: INDEX_WARN_BYTES, advice: 'index-slim' }
    return { kind: k, bytes: n, level: 'ok', limit: INDEX_WARN_BYTES, advice: 'none' }
  }

  if (n >= TRIM_FORCE_BYTES) return { kind: k, bytes: n, level: 'force', limit: TRIM_FORCE_BYTES, advice: 'trim-or-compress' }
  if (n >= TRIM_WARN_BYTES) return { kind: k, bytes: n, level: 'warn', limit: TRIM_WARN_BYTES, advice: 'trim-or-compress' }
  return { kind: k, bytes: n, level: 'ok', limit: TRIM_WARN_BYTES, advice: 'none' }
}

/** 围栏标记：行首（去缩进后）三个及以上的反引号或波浪号。返回标记字符，不是围栏返回空串。 */
function fenceMark(trimmed) {
  const m = /^(`{3,}|~{3,})/.exec(trimmed)
  return m ? m[1][0] : ''
}

/**
 * `MEMORY.md` 专用：逐行长度 + 整份体积。
 *
 * 三件容易做错的事，都在这里一次性判掉：
 *   1. **CRLF**：先按 `\r?\n` 切，行尾那个 `\r` 不进字符数。不这么做的话，Windows
 *      上写出来的每一行都凭空多一个字 —— 240 字的边界整体偏一位，而「恰好 240 字」
 *      与「241 字」正是这里唯一要区分的两件事。
 *   2. **代码围栏**：索引里偶尔会嵌一段示例（``` 开头到 ``` 结尾）。围栏里的长行是
 *      内容，不是「索引塞了正文」，一律不算 —— 反过来，把围栏里的行算进去会让一份
 *      完全正常的索引年年报「有超长行」。
 *   3. **空行**：不算长行（长度 0），也不需要为它单开分支。
 *
 * `chars` 按 **Unicode 码点**数（`[...line].length`），不是 UTF-16 单元：一个补充平面
 * 字符（emoji / 生僻字）在 `.length` 里算 2，用户看到的是 1 个字。
 *
 * @param {string} text — 索引全文（可为空 / 非法值，非法值按空串算）
 * @returns {{bytes:number, lines:number, longLines:{line:number, chars:number}[],
 *   overDoc:boolean, level:'ok'|'warn'|'force', advice:'index-slim'|'none'}}
 *   `line` 是 **1-based** 行号，与 `text.split(/\r?\n/)` 的下标 +1 一致。
 */
export function indexFindings(text) {
  const src = typeof text === 'string' ? text : ''
  const bytes = Buffer.byteLength(src, 'utf8')
  const lines = src.split(/\r?\n/)
  const longLines = []
  /** 当前打开的围栏标记字符（空串 = 不在围栏里）。 */
  let fence = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const mark = fenceMark(line.trimStart())
    if (fence) {
      // 围栏里的一切都不算长行；同种标记（``` 或 ~~~）再来一次就是关闭。
      if (mark === fence) fence = ''
      continue
    }
    if (mark) {
      fence = mark
      continue
    }
    const chars = [...line].length
    if (chars > INDEX_LINE_CHARS) longLines.push({ line: i + 1, chars })
  }
  const overDoc = bytes >= INDEX_DOC_BYTES
  // 有一行超长就与「整份超上限」同档（都是 force）：这两种都说明索引里塞了不该在
  // 索引里的东西，处置方式一模一样（瘦身），分成两档只会让审计多一个没人看的数字。
  const level = overDoc || longLines.length > 0 ? 'force' : bytes >= INDEX_WARN_BYTES ? 'warn' : 'ok'
  return { bytes, lines: lines.length, longLines, overDoc, level, advice: level === 'ok' ? 'none' : 'index-slim' }
}

/** 去掉 `toFixed` 留下的 `.0`：`16 KB` 比 `16.0 KB` 更像人话（文案里就是「超过 40 KB」）。 */
function trimZero(x) {
  return String(Number(x.toFixed(1)))
}

/**
 * 人读的体积：`'26.4 KB'` / `'812 B'`。
 *
 * 规则有意写得简单，因为界面、工具回执、审计文案都靠它：
 *   - `< 1 KB` → 整数字节 + `B`；
 *   - `< 1 MB` → KB，保留一位小数，`.0` 去掉（`16 KB`，不是 `16.0 KB`）；
 *   - 再往上 → MB，同一套进位。
 *
 * 非法输入（undefined / NaN / 负数）一律当 0：**文案里绝不能出现 `undefined KB`**
 * —— 这类字符串一旦落到回执上，用户第一反应是「插件报错了」。
 */
export function sizeText(bytes) {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (n < 1024) return `${Math.round(n)} B`
  const kb = n / 1024
  if (kb < 1024) return `${trimZero(kb)} KB`
  return `${trimZero(n / (1024 * 1024))} MB`
}

/**
 * 一行中文建议（回执与审计共用同一句，别各写一套）。
 *
 * 为什么不是 `classifySize().advice` 那句枚举：枚举是给代码做分支的（`'index-slim'`
 * 对模型没有信息量），而模型与用户读到的是这一句 —— 它必须同时说清**多少、超了哪条
 * 线、下一步怎么做**。`read_memory` 回执里那句「ℹ 这条 43.1 KB，超过 40 KB 强制线：
 * 按 sage-mem 技能的「体积治理」处置（裁段归档 / 压缩）」就是本函数的产物。
 *
 * 阈值一律经 `sizeText()` 生成（`40 KB` 而不是 `40960`）：一句话里混两种单位，
 * 读的人要多做一次除法。
 *
 * `longLines` 是**可选**补充：索引「单行超长」光看字节数看不出来（一行 500 字的索引
 * 可能总共才 1 KB），所以给索引写建议时把 `indexFindings().longLines`（数组或条数）
 * 带进来 —— 否则这边会对着一条超长行说「体积正常」。普通记忆不传。
 */
export function adviceText({ bytes, kind, longLines } = {}) {
  const v = classifySize({ bytes, kind })
  const size = sizeText(v.bytes)
  const long = Array.isArray(longLines)
    ? longLines.length
    : Number.isFinite(longLines) && longLines > 0 ? Math.floor(longLines) : 0

  if (v.kind === 'sessionLog') return `流水不算体积问题（${size}），跳过`
  if (v.kind === 'reserved') return `保护名单里的文件不算体积问题（${size}），跳过`

  if (v.kind === 'index') {
    if (v.level === 'force' || long > 0) {
      const why = []
      if (v.bytes >= INDEX_DOC_BYTES) why.push(`超过 ${sizeText(INDEX_DOC_BYTES)} 整份上限`)
      if (long > 0) why.push(`有 ${long} 行超过 ${INDEX_LINE_CHARS} 字`)
      return `索引 ${size}，${why.join('、')}：按 sage-mem 技能的「索引瘦身」只留一行一条指针，细节写进正文`
    }
    if (v.level === 'warn') return `索引 ${size}，接近 ${sizeText(INDEX_DOC_BYTES)} 上限：按 sage-mem 技能的「索引瘦身」删掉过期条目，把细节留给正文`
    return `索引 ${size}，体积正常（上限 ${sizeText(INDEX_DOC_BYTES)}、单行 ${INDEX_LINE_CHARS} 字）`
  }

  if (v.level === 'force') return `这条 ${size}，超过 ${sizeText(TRIM_FORCE_BYTES)} 强制线：按 sage-mem 技能的「体积治理」处置（裁段归档 / 压缩）`
  if (v.level === 'warn') return `这条 ${size}，超过 ${sizeText(TRIM_WARN_BYTES)} 提醒线：能拆成完整小节就裁段归档，拆不开就压缩`
  return `这条 ${size}，体积正常（提醒线 ${sizeText(TRIM_WARN_BYTES)}、强制线 ${sizeText(TRIM_FORCE_BYTES)}）`
}
