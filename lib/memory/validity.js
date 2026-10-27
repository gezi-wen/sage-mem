/**
 * sage-mem 记忆层 —— 有效性（`valid_at` / `invalid_at` / `superseded_by`）的解析与判定。
 *
 * 2.0.0 的数据模型层（`docs/2.0.0-plan.md` §4.1 R1–R6）。这一片**只判定、不读盘、不写盘、
 * 不改注入**：它把「frontmatter 里那三个字段」翻译成「这条记忆现在算不算失效」与
 * 「哪些文件该被抑制」两个集合，交给上层（注入链 / 面板）消费。
 *
 * 三条贯穿全文件的规矩：
 *
 * 1. **时钟必须由调用方传入（R3）。** 这些函数一个都不读 `Date.now()`：判定的边界值
 *    （`invalid_at` 恰好等于此刻、未来一秒）是夹具与 `TZ=UTC` 的 CI 唯一能钉住的东西，
 *    模块里读一次时钟就变成「跑测试那一刻碰运气」。注入链本来就带着 `nowMs`
 *    （`lib/recall/injector.js`），顺着传下来零成本。
 * 2. **认不出就不猜（R2）。** 坏格式一律按「未标注」处理，绝不编一个时间：猜出来的时间
 *    会让一条写坏的标注变成一条**永久失效**的记忆，而失效是静默的 —— 它只表现为
 *    「这条记忆不再出现」，没有报错。
 * 3. **缺失即老行为（R1）。** 三字段全缺时，这里的每个判定都与 1.9.2 的空集逐字相同：
 *    失效集合为空、冲突集合为空。零迁移的全部依据就是这一条。
 *
 * 冲突记录**不是事实来源**（§4.4）：一条记忆有 `invalid_at` 才算失效；冲突记录只说明
 * 「有一对手工/模型标记的互斥说法待裁决」。两者不一致时，注入看 frontmatter、面板看记录。
 */

/**
 * 被认可的时间格式：ISO 8601 带偏移 —— `YYYY-MM-DDTHH:MM(:SS)?(Z|±HH:MM)`。
 *
 * 为什么**额外接受 1–3 位小数秒**（规格里没写）：裁决入口写 `invalid_at` 时会用
 * `new Date().toISOString()`，它的天然产物是 `2026-10-24T18:30:00.000Z`。严格按规格
 * 拒掉小数秒，就等于**宿主自己写的时间自己认不出** → 按未标注处理 → 失效标记静默不生效。
 * 这是最容易发生、也最难发现的一类坑：文件里明明写着 `invalid_at`，那条记忆却照常注入。
 * 小数秒仍是合法 ISO 8601，收它不违反 R2（R2 防的是「像时间的胡话」）。
 *
 * 其余部分刻意从严：必须带时区偏移、必须有 `T`、必须是完整日期。`Date.parse` 其实也认
 * `2026-10-24`（按本地时区解释）与 `Oct 24 2026`，但「哪一天」在跨时区时会漂一天，
 * 而失效判定恰好是「早一天 / 晚一天」的语义 —— 认它等于把一个时区隐患埋进数据模型。
 */
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * 解析一个有效性时间值。
 *
 * 两道闸门（R2）：格式正则 + `Date.parse` 有限。前者挡「不像 ISO 的胡话」，
 * 后者挡「格式像、日期不存在」（例如月份越界）—— 任一不过都返回 `ok: false`，
 * 由调用方按「未标注」处理，**不要**在这里回落成某个时间。
 *
 * @param {unknown} value — frontmatter 里的原始值（正常是字符串；缺失 / 非字符串都按未标注）
 * @returns {{ok: boolean, ms: number|null}} `ok` 为 false 时 `ms` 必为 null
 */
export function parseValidityTime(value) {
  if (typeof value !== 'string') return { ok: false, ms: null }
  const raw = value.trim()
  if (!TIME_RE.test(raw)) return { ok: false, ms: null }
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? { ok: true, ms } : { ok: false, ms: null }
}

/**
 * 这条记忆的失效时刻到了没有。
 *
 * 只读 `file.invalidAt`（**不看** `validAt`：`valid_at` 是「说法何时开始成立」，
 * 与「现在还算不算数」无关。用 `valid_at` 推断失效等于把「开始」当成「结束的线索」，
 * R4 明确禁止这种互相推导）。
 *
 * 四种「不失效」情形都是刻意的：字段缺失 / 坏格式 / 未来时间 / `nowMs` 传了非法值。
 * 后两种宁可当有效：把一条本该注入的记忆藏起来是用户看得见的损失，而把一条刚过期的
 * 多看一轮，下一次注入就会修正。
 *
 * @param {{invalidAt?: string}|null|undefined} file — scan 记录（`file` 字段为文件名）
 * @param {number} nowMs — 调用方的「现在」（毫秒时间戳），不读时钟是 R3 的硬要求
 * @returns {boolean}
 */
export function isExpired(file, nowMs) {
  if (!Number.isFinite(nowMs)) return false
  const parsed = parseValidityTime(file?.invalidAt)
  // `<=` 而不是 `<`：到点即失效（裁决入口写的就是「从这一刻起不作数」）。
  return parsed.ok && parsed.ms <= nowMs
}

/**
 * 给面板 / 审计 / 状态卡用的一句话视图。
 *
 * `expired` = 已到点失效；`pendingFuture` = 时间可解析但在未来（「暂不失效」，
 * 审计要提示、注入不能动手）；两者都为 false 包含「未标注」与「坏格式」两种 ——
 * 它们在行为上等价（老行为、有效），区别只在审计提示里，不要在这里合成第三种状态。
 *
 * 返回值里的时间字段是**原样字符串**（不是时间戳）：面板要显示用户写的那个时区，
 * 换算成 UTC 反而让「我写的是下午六点半」变得认不出来。判定另行计算。
 *
 * @param {{invalidAt?: string, supersededBy?: string}|null|undefined} file
 * @param {number} nowMs
 * @returns {{invalidAt: string, supersededBy: string, expired: boolean, pendingFuture: boolean}}
 */
export function describeValidity(file, nowMs) {
  const invalidAt = typeof file?.invalidAt === 'string' ? file.invalidAt : ''
  const supersededBy = typeof file?.supersededBy === 'string' ? file.supersededBy : ''
  const parsed = parseValidityTime(invalidAt)
  const usable = parsed.ok && Number.isFinite(nowMs)
  return {
    invalidAt,
    supersededBy,
    expired: usable && parsed.ms <= nowMs,
    pendingFuture: usable && parsed.ms > nowMs,
  }
}

/**
 * 从一次扫描结果里取出「已失效」的文件名集合。
 *
 * 返回的是**文件名**（scan 记录的 `file` 字段，如 `project_a.md`），不是路径：
 * 注入链与状态卡都按文件名对账，混进绝对路径会让集合在两侧永远对不上
 * （而且绝对路径会把用户目录结构带进日志 / 状态卡）。
 *
 * 纯函数：给同样的 `files` 与 `nowMs` 永远得到同样的集合 —— 失效名单是要进
 * golden 断言与评测基线的，任何隐式输入（时钟 / 环境变量）都会让它不可重放。
 *
 * @param {Array<{file?: string, invalidAt?: string}>} files — `scanMemoryFiles` 的记录
 * @param {number} nowMs
 * @returns {Set<string>}
 */
export function buildExpirySet(files, nowMs) {
  const out = new Set()
  if (!Array.isArray(files)) return out
  for (const f of files) {
    if (!f || typeof f.file !== 'string' || f.file === '') continue
    if (isExpired(f, nowMs)) out.add(f.file)
  }
  return out
}

/**
 * 从冲突记录里取出「未裁决矛盾」涉及的文件名集合（两方都要）。
 *
 * 只收 `status === 'open'` 且 `kind === 'contradiction'` 的记录（§6.3）：
 * 另外三种 kind 都是「想写、没写成」——`stale_version` 时盘上那份**才是现行的**，
 * 把它们也当成「不可信」会重演「记忆悄悄消失」的事故（D27）。「记录还没裁决」
 * 与「记忆不可信」是两件事，这条判据就是那个分界线。
 *
 * `file` 是拟标失效的一方，`otherFile` 是另一方：抑制必须两边都放，只藏一方等于
 * 让用户继续看到一份**已经被判定为可能作废**的说法。`otherFile` 可能缺失 / 为空串
 * （老记录没有这个字段），跳过而不是拼出一个空文件名。
 *
 * @param {Array<{kind?: string, status?: string, file?: string, otherFile?: string}>} records
 * @returns {Set<string>}
 */
export function buildContradictionFileSet(records) {
  const out = new Set()
  if (!Array.isArray(records)) return out
  for (const r of records) {
    if (!r || r.status !== 'open' || r.kind !== 'contradiction') continue
    for (const key of ['file', 'otherFile']) {
      const name = typeof r[key] === 'string' ? r[key].trim() : ''
      if (name !== '') out.add(name)
    }
  }
  return out
}
