/**
 * sage-mem — 手写 strict typert host manifest。
 * typert-loader 在插件挂载时读 package.json 的 exports["./typert"]，
 * import 本文件并把 TYPERT 注册进 ctx.typert.local（strict 定义）。
 * schema 必须是 zod v4 实例（typert-loader 校验 "_zod" in schema）。
 */
import { z } from 'zod'
import { MD_NAME_PATTERN } from './shared/md-name.js'
import { MAX_FILE_BYTES, MAX_RAW_BYTES } from './shared/limits.js'

// 文件名：与 host 侧 safeName 同一套底线 —— 非空、无路径分隔符与 Windows 非法字符、
// 以 .md 结尾、长度有界。（真正的目录逃逸防护仍在 host 侧 safeName。）
//
// ⚠️ 结尾的 `i` **不能去掉**：`safeName`（`memory/naming.js`）判扩展名用的是 `/\.md$/i`，
// 而文件名闸门原先**没有** `i`，两层判据宽度不一致 —— 宿主侧认可的 `a.MD`
// 会被传输入参 schema 挡在门外（读不了自己列表里列出来的文件）。大小写不敏感是
// NTFS / APFS 的事实，判据必须与文件系统同宽（与 `nameKey` 归一同一原则）。
const fileNameSchema = z.string().min(1).max(255).regex(new RegExp(MD_NAME_PATTERN, 'i'))
// 正文：512 KB 上限。理由是「记忆要塞进 system prompt」——单条正常量级在几十 KB，
// 到半兆量级基本是写错了目标（贴了日志/代码进来）。与 lib/index.js 的 MAX_FILE_BYTES 一致。
const fileContentSchema = z.string().max(MAX_FILE_BYTES)

// 2.1.2（Q02）：写协议第三参（expectedRevision / create），都 optional；不声明的话 strictObject 会把新面板传的 revision 整个拒掉。
const writeOptsSchema = z.object({ 'expectedRevision': z.string().max(128).readonly().optional(), 'create': z.boolean().readonly().optional() }).readonly()

// autodream 报告引用：比 fileNameSchema 宽——旧版报告列表里的条目带 `dream/` 前缀
// （新版 `autodream/` 不加前缀只给裸文件名）。这里放行斜杠，真正的目录逃逸防护
// 在 host 侧 AutodreamEngine.readReport 里（先剥已知前缀、再对 basename 走 safeName）。
const reportRefSchema = z.string().min(1).max(320)

const starmapStarSchema = z.object({
	'file': z.string().readonly(),
	'kind': z.string().readonly(),
	'title': z.string().readonly(),
	'desc': z.string().readonly(),
	'bytes': z.number().readonly(),
	'mtimeMs': z.number().readonly(),
	// 归档星：`archived` 每颗星都有（活动星是 false）；两个留痕字段只对归档星出现，
	// 且旧版 autodream 工具归档的文件没有它们 —— 所以 optional，不是 nullable。
	'archived': z.boolean().readonly(),
	'archivedAt': z.string().readonly().optional(),
	'archivedReason': z.string().readonly().optional(),
}).readonly()
const starmapListSchema = z.object({
	'count': z.number().readonly(),
	'stars': z.array(starmapStarSchema).readonly(),
}).readonly()
const starmapReadSchema = z.object({
	'name': z.string().readonly(),
	'content': z.string().readonly(),
}).readonly()

const fileSchema = z.object({
	'file': z.string().readonly(),
	'type': z.string().readonly(),
	'description': z.string().readonly(),
	'size': z.number().readonly(),
	// 自定义标签：来自 frontmatter 的 tags（flow / block / 逗号三种写法都收）。
	// strict 模式下 host 多返回的字段会被剥掉，所以「列表页要能按标签筛」这件事
	// 必须在这里显式声明，否则前端永远拿到 undefined。
	'tags': z.array(z.string()).readonly(),
	// 锁定状态（拒绝归档）跟着每条一起给 —— strict 会把没声明的字段剥掉，
	// 不在这里声明，卡片上的「锁定 / 已锁定」按钮就永远拿到 undefined。
	'locked': z.boolean().readonly(),
}).readonly()

const listResultSchema = z.array(fileSchema)
const readResultSchema = z.object({
	'name': z.string().readonly(),
	'content': z.string().readonly(),
	// 2.1.2（Q02）：读快照的版本令牌（optional —— additive 契约只许加，不许把已有字段改成必填）。
	'revision': z.string().readonly().optional(),
}).readonly()
// 写/删失败不再抛异常，走 { ok: false, error } 分支：error 必须声明，否则 strict
// 校验会把它当未知字段剥掉，设置页只能看到一个没有原因的 ok:false。
const writeResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'file': z.string().readonly(),
	'error': z.string().readonly().optional(),
	// 2.1.2（Q02）：成功回新 revision；冲突回固定错误码（stale_revision / already_exists）。都是 optional。
	'revision': z.string().readonly().optional(), 'code': z.string().readonly().optional(),
}).readonly()
const deleteResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'error': z.string().readonly().optional(),
}).readonly()

// ── 归档区（v0.9.0 档案馆）─────────────────────────────────────────────────
// 归档条目的形状 = fileSchema + 两个留痕字段。留痕可能为空串（旧版 autodream 工具
// 直接移文件、不写留痕），所以是 string 而不是 optional —— 面板永远能拿到一个值。
const archivedFileSchema = z.object({
	'file': z.string().readonly(),
	'type': z.string().readonly(),
	'description': z.string().readonly(),
	'size': z.number().readonly(),
	'tags': z.array(z.string()).readonly(),
	'archivedAt': z.string().readonly(),
	'archivedReason': z.string().readonly(),
	// 2.1.6（外部审查 Q07）：**内容身份**（归档代次 + 正文 revision）；strict 会把没声明的字段剥掉。
	'revision': z.string().readonly(),
}).readonly()
const archivedListSchema = z.object({
	'count': z.number().readonly(),
	'files': z.array(archivedFileSchema).readonly(),
}).readonly()

// 归档缘由：用户输入的一句话。真正的 YAML 转义在 host 侧 yamlScalar（值里的「: 」「 #」），
// 这里只兜长度 —— 缘由不该长到把 frontmatter 变成正文。
const archiveReasonSchema = z.string().max(1000).optional()
// 归档代次（`archived_at`，`YYYY-MM-DD HH:mm`）：展示时间，老归档件没有留痕时传空串。
const archiveStampSchema = z.string().max(64)
// 归档内容身份（`归档代次@内容 revision`，见 archive.js 的 archivedRevisionOf）：2.1.6（Q07）起
// 「彻底删除」必须带它 —— 没有它就只能按名字删，而名字不是身份；格式是不透明字符串。
const archiveRevisionSchema = z.string().min(1).max(128)
// starmap.listStars 的可选开关：不看归档星时行为与从前完全一致。
const includeArchivedSchema = z.boolean().optional()

// 归档 / 恢复的结果：成功 `{ ok, file, unindexed|indexed, indexError? }`，失败 `{ ok:false, error }`
// —— 失败分支**没有 file**，不能复用 writeResultSchema（那边 file 必填，strict 会把失败判成坏结果）。
//
// ⚠️ `unindexed` / `indexed` / `indexError` / `archivedReason` 必须在这里声明（2026-10-12 复审 R11）：
// strict codec 会把没声明的字段整个剥掉，「索引没摘掉 / 没补上」在界面路径上就永远不可见。
const archiveResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'file': z.string().readonly().optional(),
	'error': z.string().readonly().optional(),
	'archivedReason': z.string().readonly().optional(),
	'unindexed': z.boolean().readonly().optional(),
	'indexed': z.boolean().readonly().optional(),
	'indexError': z.string().readonly().optional(),
}).readonly()

// 归档文件的读 / 写（v0.9.0 B1b）：归档不是删除，正文要能看能改。三个类型名与活跃记忆
// 那套（FileName / FileContent / WriteResult）对称，只是作用目录换成 `memory/archive/`。
// 名字仍受 safeName 约束 —— 调用方不许自己拼路径。
const archivedReadResultSchema = z.object({
	'name': z.string().readonly(),
	'content': z.string().readonly(),
	// 2.1.2（Q02）：与活跃记忆同一套读快照协议（optional，同 readResultSchema 的理由）。
	'revision': z.string().readonly().optional(),
}).readonly()
// 写归档的结果与 writeResultSchema 同形，但**另立一个类型名**：strict 层要能区分
// 「写活跃记忆」与「写归档记忆」两条路径，将来两者形状分叉时也不必回头改协议。
const archivedWriteResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'file': z.string().readonly(),
	'error': z.string().readonly().optional(),
	'revision': z.string().readonly().optional(), 'code': z.string().readonly().optional(),
}).readonly()

// ── 面板 API（v0.9.0 D1）：体检 / 归档候选 / 设置 / 保留名原样读写 ──────────────
// 更新检查：只回答「有没有更新的正式版」。失败一律降级为「不提示」（error / rateLimited
// 只是给日志与调试看的，界面不该因为查版本失败而冒红条）。
const updateCheckSchema = z.object({
	'current': z.string().readonly(),
	'latest': z.string().readonly().nullable(),
	'updateAvailable': z.boolean().readonly(),
	'rateLimited': z.boolean().readonly(),
	'error': z.string().readonly(),
	'releasesUrl': z.string().readonly(),
}).readonly()
// 审计报告：字段面就是 `auditMemoryDir()` 的返回，逐项在这里钉住 —— strict 会把没声明的
// 字段剥掉，面板看到的清单必须与模型看到的一致。
const auditItemSchema = z.object({ 'file': z.string().readonly() }).readonly()
const auditLinkSchema = z.object({ 'file': z.string().readonly(), 'target': z.string().readonly() }).readonly()
const auditTypeMismatchSchema = z.object({
	'file': z.string().readonly(),
	'type': z.string().readonly(),
	'prefix': z.string().readonly(),
	'effective': z.string().readonly(),
}).readonly()
const auditHazardSchema = z.object({ 'file': z.string().readonly(), 'line': z.string().readonly() }).readonly()
const auditReportSchema = z.object({
	'dir': z.string().readonly(),
	'fileCount': z.number().readonly(),
	'skipped': z.number().readonly(),
	'archivedCount': z.number().readonly(),
	'indexEntries': z.number().readonly(),
	'dangling': z.array(auditItemSchema).readonly(),
	'unlisted': z.array(auditItemSchema).readonly(),
	'typeMismatch': z.array(auditTypeMismatchSchema).readonly(),
	'crlf': z.array(auditItemSchema).readonly(),
	'brokenLinks': z.array(auditLinkSchema).readonly(),
	'archivedLinks': z.array(auditLinkSchema).readonly(),
	'hashHazards': z.array(auditHazardSchema).readonly(),
	'noFrontmatter': z.array(auditItemSchema).readonly(),
	'unreadable': z.array(auditItemSchema).readonly(),
	// 归档/恢复中途崩溃留下的私有名残留（`*.md.archiving-<hex>`）。它可能装着用户唯一
	// 一份内容，所以体检必须报出来 —— strict 不声明它就等于界面上永远看不见。
	'strays': z.array(auditItemSchema).readonly(),
	// 2.0.0：有效性标注的**提示**（不进 problems —— problems 是唯一健康数字）。
	// 不声明的话 strict 会把它剥掉，面板与设置页就永远看不到「某个字段格式坏了」。
	'validityHints': z.array(z.object({
		'file': z.string().readonly(),
		'field': z.string().readonly(),
		'reason': z.string().readonly(),
	}).readonly()).readonly(),
	'problems': z.number().readonly(),
}).readonly()

/** 「打开记忆目录」的结果：成功只有 ok，失败带原因。 */
const openFolderResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'error': z.string().readonly().optional(),
}).readonly()

const archiveCandidateSchema = z.object({
	'file': z.string().readonly(),
	'type': z.string().readonly(),
	'days': z.number().readonly(),
	'limit': z.number().readonly(),
	'reason': z.string().readonly(),
}).readonly()
const archiveCandidatesResultSchema = z.object({
	'count': z.number().readonly(),
	'candidates': z.array(archiveCandidateSchema).readonly(),
	'autoArchive': z.string().readonly(),
	'thresholds': z.object({
		'project': z.number().readonly(),
		'reference': z.number().readonly(),
		'user': z.number().readonly(),
	}).readonly(),
	// 锁定的记忆（已按 nameKey 归一）：面板要显示「哪些锁着」
	'locked': z.array(z.string().readonly()).readonly(),
}).readonly()
// 上锁 / 解锁的结果
const lockResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'file': z.string().readonly(),
	'locked': z.boolean().readonly(),
}).readonly()

// 设置：limits = 当前**已生效**的值（模块加载时读的），pendingLimits = 待生效值
// （settings.json > 环境变量 > 默认）。两个都给，界面才说得清「改了要重启」。
const settingsLimitsSchema = z.object({
	'maxResults': z.number().readonly(),
	'maxChars': z.number().readonly(),
	'maxBaseline': z.number().readonly(),
	'maxSessionBytes': z.number().readonly(),
	'staleDays': z.number().readonly(),
}).readonly()
// 1.8.0：面板 UI 设置。`sidebarEntry` 是**客户端行为**（改完立刻生效），不进 restartRequired。
const settingsUiSchema = z.object({
	'sidebarEntry': z.boolean().readonly(),
}).readonly()
const settingsSchema = z.object({
	'limits': settingsLimitsSchema,
	'pendingLimits': settingsLimitsSchema,
	'restartRequired': z.boolean().readonly(),
	'ui': settingsUiSchema,
	'reserved': z.array(z.string()).readonly(),
	'reservedExtra': z.array(z.string()).readonly(),
}).readonly()
const settingsPatchSchema = z.object({
	'limits': z.object({
		'maxResults': z.number().optional(),
		'maxChars': z.number().optional(),
		'maxBaseline': z.number().optional(),
		'maxSessionBytes': z.number().optional(),
		'staleDays': z.number().optional(),
	}).readonly().optional(),
	'ui': z.object({
		'sidebarEntry': z.boolean().optional(),
	}).readonly().optional(),
	'reserved': z.array(z.string()).optional(),
}).readonly()
// 成功回 { ok, settings, restartRequired }，失败回 { ok:false, error } —— 两条分支并集。
const settingsResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'error': z.string().readonly().optional(),
	'settings': settingsSchema.optional(),
	'restartRequired': z.boolean().readonly().optional(),
}).readonly()

// 保留名原样读写。读的两条分支（成功 {name,content} / 拒绝 {ok:false,error}）用可选字段
// 的并集接住；写的失败分支可能没有 file，所以 file 也是 optional。
const rawReadResultSchema = z.object({
	'name': z.string().readonly().optional(),
	'content': z.string().readonly().optional(),
	'ok': z.boolean().readonly().optional(),
	'error': z.string().readonly().optional(),
	// 2.1.2（Q02）：保留名读快照的版本令牌（optional，同 readResultSchema 的理由）。
	'revision': z.string().readonly().optional(),
}).readonly()
const rawWriteResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'file': z.string().readonly().optional(),
	'error': z.string().readonly().optional(),
	'revision': z.string().readonly().optional(), 'code': z.string().readonly().optional(),
}).readonly()
// 保留名的体积上限比单条记忆大得多（session-log.md 天然 > 512 KB）—— 4 MB，独立于
// fileContentSchema，别把两者混用。
const rawFileContentSchema = z.string().max(MAX_RAW_BYTES)

// ── 注入调试账（1.7.0）─────────────────────────────────────────────────────
// 这份形状就是 `lib/recall/debug.js` 里 payload 的**逐字段**镜像。strict 会剥掉
// 未声明的字段，所以面板要看的每一样都必须写在这里 —— 少写一个，界面上就是
// 一个永远 undefined 的格子（与 R01 漏四个配置字段同一类错误）。
// 写法比相邻 schema 紧凑（一行多字段）：本文件已有 ≤900 行的结构守卫
// （test/structure-test.mjs），加一条 remote 不能把文件顶爆。
const recallDebugScoreSchema = z.object({ 'file': z.string().readonly(), 'score': z.number().readonly() }).readonly()
const recallDebugRecordSchema = z.object({
	'at': z.number().readonly(), 'sessionId': z.string().readonly(), 'query': z.string().readonly(),
	// injected | card-only | empty：这一步到底注进去了什么
	'outcome': z.string().readonly(), 'deduped': z.boolean().readonly(), 'baseline': z.number().readonly(),
	'scanned': z.number().readonly(), 'hits': z.number().readonly(),
	'scores': z.array(recallDebugScoreSchema).readonly(), 'body': z.array(recallDebugScoreSchema).readonly(),
	'picked': z.array(z.string()).readonly(), 'injected': z.array(z.string()).readonly(),
	// chars = 这一步正文；sessionChars = 本代累计；cardChars = 这一步的卡
	'chars': z.number().readonly(), 'sessionChars': z.number().readonly(), 'cardChars': z.number().readonly(),
	'skippedByBudget': z.number().readonly(), 'card': z.string().readonly(),
}).readonly()
// 开关关着时 records 是空数组、enabled 是 false —— 面板据此不显示入口。
const recallDebugResultSchema = z.object({ 'enabled': z.boolean().readonly(), 'records': z.array(recallDebugRecordSchema).readonly() }).readonly()

// ── autodream（夜间记忆整理）───────────────────────────────────────────────
// 配置的每一项都可写；lastResult 是一个「成功/失败两条分支共用」的结构，
// 所以除了三个必有字段外全是 optional —— 用 strict 校验两种形态的并集，
// 比给成功与失败各来一套 schema 少一半维护面。
const autodreamConfigSchema = z.object({
	'enabled': z.boolean().readonly(),
	'trigger': z.string().readonly(),
	'apply': z.boolean().readonly(),
	'source': z.string().readonly(),
	'minHours': z.number().readonly(),
	'minSessions': z.number().readonly(),
	'provider': z.string().readonly(),
	'model': z.string().readonly(),
	'maxSteps': z.number().readonly(),
	// 1.9.2：单次输出上限（token）。响应与 patch 两侧都必须声明 —— strict codec 会剥掉未声明字段。
	'maxOutputTokens': z.number().readonly(),
	'maxSnapshotKeep': z.number().readonly(),
	'rollbackScope': z.string().readonly(),
	/**
	 * ⚠️ 这一组必须留在这里（2026-10-12 补）。
	 *
	 * 入参 schema（`autodreamPatchSchema`）补了这四个字段只解决了「写得进去」；
	 * **响应**走的还是本 schema，strict 会把未声明的字段剥掉 —— 于是界面
	 * 「保存 → 回读 → 比对」这套自检永远拿到 `undefined`：`autoArchive` 被当成默认的
	 * `report`，三个阈值被当成「仍是旧值」，改对了也报「保存没生效」。
	 *
	 * 契约是**双向**的：能写进去的字段，返回里也必须看得见。
	 * `test/race-guards-test.mjs` 第 1 组拿 `engine.getConfig().config` 的**全部键**
	 * 对这份 schema 做覆盖断言 —— 以后再加配置项、漏了这里，会立刻红。
	 */
	'autoArchive': z.string().readonly(),
	'archiveAfterDaysProject': z.number().readonly(),
	'archiveAfterDaysReference': z.number().readonly(),
	'archiveAfterDaysUser': z.number().readonly(),
}).readonly()

const autodreamPathsSchema = z.object({
	'memoryDir': z.string().readonly(),
	'configPath': z.string().readonly(),
	'stateRoot': z.string().readonly(),
	'home': z.string().readonly(),
}).readonly()

const autodreamRouteSchema = z.object({
	'provider': z.string().readonly(),
	'model': z.string().readonly(),
	'fromDefault': z.boolean().readonly(),
	'source': z.string().readonly(),
	'error': z.string().readonly().nullable(),
}).readonly()

const autodreamLastResultSchema = z.object({
	'at': z.number().readonly(),
	'atHuman': z.string().readonly(),
	'ok': z.boolean().readonly(),
	'apply': z.boolean().readonly().optional(),
	'error': z.string().readonly().optional(),
	'touched': z.array(z.string()).readonly().optional(),
	'problemsBefore': z.number().readonly().optional(),
	'problemsAfter': z.number().readonly().optional(),
	'tokensIn': z.number().readonly().optional(),
	'tokensOut': z.number().readonly().optional(),
	'runId': z.string().readonly().optional(),
	'changeCount': z.number().readonly().optional(),
	'preflight': z.boolean().readonly().optional(),
	'snapshotId': z.string().readonly().nullable().optional(),
	'report': z.string().readonly().optional(),
}).readonly()

const autodreamConfigResultSchema = z.object({
	'config': autodreamConfigSchema,
	'route': autodreamRouteSchema.nullable(),
	'lastRunAt': z.number().readonly(),
	'lastResult': autodreamLastResultSchema.nullable(),
	'paths': autodreamPathsSchema,
	'defaults': autodreamConfigSchema,
}).readonly()

const autodreamStepSchema = z.object({
	'step': z.number().readonly(),
	'tools': z.array(z.string()).readonly(),
	'chars': z.number().readonly(),
	'at': z.number().readonly(),
}).readonly()

const autodreamStatusSchema = z.object({
	'running': z.boolean().readonly(),
	'phase': z.string().readonly(),
	'startedAt': z.number().readonly(),
	'runId': z.string().readonly(),
	'steps': z.array(autodreamStepSchema).readonly(),
	'config': autodreamConfigSchema,
	'route': autodreamRouteSchema.nullable(),
	'lastRunAt': z.number().readonly(),
	'hoursSince': z.number().readonly().nullable(),
	'lastResult': autodreamLastResultSchema.nullable(),
	'retryAfter': z.number().readonly(),
	'gate': z.object({ 'minHours': z.number().readonly(), 'minSessions': z.number().readonly() }).readonly().nullable(),
	'paths': autodreamPathsSchema,
}).readonly()

const autodreamRunResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'error': z.string().readonly().optional(),
	'report': z.string().readonly().optional(),
	'touched': z.array(z.string()).readonly().optional(),
	'runId': z.string().readonly().optional(),
	'changeCount': z.number().readonly().optional(),
	'snapshotId': z.string().readonly().nullable().optional(),
}).readonly()

// setConfig 的补丁：全部 optional —— 设置面板每次只改动一项，传整个对象反而
// 容易把没碰过的字段用旧值覆盖回去。
const autodreamPatchSchema = z.object({
	'enabled': z.boolean().optional(),
	'trigger': z.string().optional(),
	'apply': z.boolean().optional(),
	'source': z.string().optional(),
	'minHours': z.number().optional(),
	'minSessions': z.number().optional(),
	'provider': z.string().optional(),
	'model': z.string().optional(),
	'maxSteps': z.number().optional(),
	'maxOutputTokens': z.number().optional(),
	'maxSnapshotKeep': z.number().optional(),
	'rollbackScope': z.string().optional(),
	/**
	 * ⚠️ 这一组是 2026-10-11 补的 —— 之前**漏了**，而 strict codec 会把**未声明的字段整个剥掉**，
	 * 所以 patch 还没到宿主侧就已经少了一半：
	 *   · `autoArchive` 缺席 = **三档策略从 v0.9.0 起一直是摆设**（界面点了、值没落盘）
	 *   · 三个 `archiveAfterDays*` 缺席 = v0.9.9 新加的阈值界面必然报「保存没生效」
	 * 断言在 `test/autodream-config-test.mjs`，它**先过 schema 再调 setConfig**，
	 * 走的才是界面的真实路径（直接调 setConfig 会绕过这一层，测不出剥字段）。
	 */
	'autoArchive': z.string().optional(),
	'archiveAfterDaysProject': z.number().optional(),
	'archiveAfterDaysReference': z.number().optional(),
	'archiveAfterDaysUser': z.number().optional(),
}).readonly()

const reportListSchema = z.array(z.object({
	'name': z.string().readonly(),
	'bytes': z.number().readonly(),
	'at': z.number().readonly(),
	'atHuman': z.string().readonly(),
	'legacy': z.boolean().readonly(),
}).readonly()).readonly()

const snapshotListSchema = z.array(z.object({
	'name': z.string().readonly(),
	'at': z.number().readonly(),
	'atHuman': z.string().readonly(),
	'files': z.number().readonly(),
	'path': z.string().readonly(),
	'runId': z.string().readonly().nullable(),
	'kind': z.string().readonly(),
	'legacy': z.boolean().readonly(),
}).readonly()).readonly()

// ── autodream 回滚点 / 整理声明 / 模型目录（新增）──
// 「运行」是这四样东西的共同线索：runId 同时是快照目录名、运行记录目录名与报告文件名，
// 所以 listRuns 的一条记录能把「改了哪些文件、为什么、能不能退」一次串起来。
const runListSchema = z.array(z.object({
	'runId': z.string().readonly(),
	'at': z.number().readonly(),
	'atHuman': z.string().readonly(),
	'mode': z.string().readonly(),
	'reason': z.string().readonly(),
	'changeCount': z.number().readonly(),
	'report': z.string().readonly().nullable(),
	'snapshotId': z.string().readonly().nullable(),
	'snapshotAvailable': z.boolean().readonly(),
	'rolledBackAt': z.number().readonly(),
	'rolledBackAtHuman': z.string().readonly(),
}).readonly()).readonly()

// manifest 是机读记录，字段面宽且在演进；这里用宽松对象接住，
// 前端的「整理声明」区只读 markdown，manifest 留给后续工具消费。
const declarationSchema = z.object({
	'runId': z.string().readonly(),
	'markdown': z.string().readonly(),
	'manifest': z.unknown(),
}).readonly()

const rollbackResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'error': z.string().readonly().optional(),
	'restored': z.number().readonly().optional(),
	'parked': z.number().readonly().optional(),
	'skipped': z.number().readonly().optional(),
	'protection': z.string().readonly().optional(),
	'report': z.string().readonly().optional(),
}).readonly()

const modelListSchema = z.object({
	'routes': z.array(z.object({
		'provider': z.string().readonly(),
		'model': z.string().readonly(),
		'label': z.string().readonly(),
		'isDefault': z.boolean().readonly(),
	}).readonly()).readonly(),
	'defaultRoute': z.object({
		'provider': z.string().readonly(),
		'model': z.string().readonly(),
	}).readonly().nullable(),
	'catalogAvailable': z.boolean().readonly(),
	'note': z.string().readonly(),
}).readonly()

// 四个新方法的入参形状不同，但都是「一个对象参数」；合并成一个全 optional 的 schema，
// 免得为每个方法各写一份。注意 zod 默认会**丢掉未声明的键**，所以用到的字段必须在这里列全。
const autodreamOptsSchema = z.object({
	'reason': z.string().optional(),
	'limit': z.number().optional(),
	'runId': z.string().optional(),
	'snapshotId': z.string().optional(),
	'scope': z.string().optional(),
}).readonly()

// ── 2.0.0：冲突裁决面（conflict.*）────────────────────────────────
// 结果 schema 必须**同时容纳成功与失败两种形状**：这一面的约定是失败返回
// `{ok:false, code, error}` 而不是抛异常。strict 校验会按声明裁剪 —— 只声明成功字段，
// 失败时的 code / error 就会在传到界面前消失，面板只剩一个没有原因的 ok:false。
//
// 另一条边界：列表只回摘要（`invalidate` / `undo` 等动作的结果回完整记录）。
// 一份记录里两份正文各上限 48 KB，整批列表搬过去会把 remote 面撑爆。
const conflictIdSchema = z.string().min(1).max(64)
const conflictOptsSchema = z.object({
	'id': conflictIdSchema,
	'file': fileNameSchema.optional(),
	'note': z.string().max(4096).optional(),
}).readonly()
const conflictItemBase = z.object({
	'id': z.string().readonly(),
	'at': z.string().readonly(),
	'kind': z.string().readonly(),
	'status': z.string().readonly(),
	'file': z.string().readonly(),
	'otherFile': z.string().readonly(),
	'note': z.string().readonly(),
	'decision': z.string().readonly(),
	'decidedAt': z.string().readonly(),
	'appliedVersion': z.string().readonly(),
	// 这次被标失效的是哪一方（`file` 或 `otherFile`）——`undo` 唯一可信的落点。
	'invalidatedFile': z.string().readonly(),
	'truncated': z.boolean().readonly(),
})
const conflictItemSchema = conflictItemBase.readonly()
const conflictRecordSchema = conflictItemBase.extend({
	'incoming': z.string().readonly(),
	'onDisk': z.string().readonly(),
}).readonly()
const conflictCountsSchema = z.object({
	'open': z.number().readonly(),
	'total': z.number().readonly(),
}).readonly()
const conflictWroteSchema = z.object({
	'file': z.string().readonly(),
	'invalidAt': z.string().readonly(),
	'version': z.string().readonly(),
}).readonly()
const conflictListSchema = z.object({
	'ok': z.boolean().readonly(),
	'items': z.array(conflictItemSchema).readonly().optional(),
	'broken': z.array(z.string()).readonly().optional(),
	'ignored': z.array(z.string()).readonly().optional(),
	'counts': conflictCountsSchema.optional(),
	'code': z.string().readonly().optional(),
	'error': z.string().readonly().optional(),
}).readonly()
const conflictReadResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'record': conflictRecordSchema.optional(),
	'warnings': z.array(z.string()).readonly().optional(),
	'code': z.string().readonly().optional(),
	'error': z.string().readonly().optional(),
}).readonly()
const conflictInvalidateResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'record': conflictRecordSchema.optional(),
	'wrote': conflictWroteSchema.optional(),
	'code': z.string().readonly().optional(),
	'error': z.string().readonly().optional(),
}).readonly()
const conflictDismissResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'record': conflictRecordSchema.optional(),
	'code': z.string().readonly().optional(),
	'error': z.string().readonly().optional(),
}).readonly()
const conflictUndoResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'record': conflictRecordSchema.optional(),
	'cleared': z.object({ 'file': z.string().readonly() }).readonly().optional(),
	'code': z.string().readonly().optional(),
	'error': z.string().readonly().optional(),
}).readonly()
const conflictRemoveResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'code': z.string().readonly().optional(),
	'error': z.string().readonly().optional(),
}).readonly()

export const TYPERT = {
	package: 'sage-mem',
	face: 'host',
	schemas: [],
	invocations: [
		{
			id: 'sage-mem#memory/listFiles',
			service: 'memory',
			namespace: 'memory',
			method: 'listFiles',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#FileList', schema: listResultSchema, create: () => listResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/readFile',
			service: 'memory',
			namespace: 'memory',
			method: 'readFile',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileName', schema: fileNameSchema, create: () => fileNameSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#FileContent', schema: readResultSchema, create: () => readResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/writeFile',
			service: 'memory',
			namespace: 'memory',
			method: 'writeFile',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileName', schema: fileNameSchema, create: () => fileNameSchema } },
				{ name: 'content', wire: 'content', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileContent', schema: fileContentSchema, create: () => fileContentSchema } },
				{ name: 'opts', wire: 'opts', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'sage-mem/types#WriteOpts', schema: writeOptsSchema, create: () => writeOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#WriteResult', schema: writeResultSchema, create: () => writeResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/deleteFile',
			service: 'memory',
			namespace: 'memory',
			method: 'deleteFile',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileName', schema: fileNameSchema, create: () => fileNameSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#DeleteResult', schema: deleteResultSchema, create: () => deleteResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/archive',
			service: 'memory',
			namespace: 'memory',
			method: 'archive',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileName', schema: fileNameSchema, create: () => fileNameSchema } },
				{ name: 'reason', wire: 'reason', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchiveReason', schema: archiveReasonSchema, create: () => archiveReasonSchema } },
			],
			// 归档与恢复都回「成不成、动的哪个文件」；失败分支没有 file（名字本身可能就非法），
			// 所以用 ArchiveResult（file / error 都 optional），不能复用 file 必填的 writeResultSchema。
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchiveResult', schema: archiveResultSchema, create: () => archiveResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/restore',
			service: 'memory',
			namespace: 'memory',
			method: 'restore',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileName', schema: fileNameSchema, create: () => fileNameSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchiveResult', schema: archiveResultSchema, create: () => archiveResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/listArchived',
			service: 'memory',
			namespace: 'memory',
			method: 'listArchived',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchivedList', schema: archivedListSchema, create: () => archivedListSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/readArchived',
			service: 'memory',
			namespace: 'memory',
			method: 'readArchived',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchivedFileName', schema: fileNameSchema, create: () => fileNameSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchivedFileContent', schema: archivedReadResultSchema, create: () => archivedReadResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/writeArchived',
			service: 'memory',
			namespace: 'memory',
			method: 'writeArchived',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchivedFileName', schema: fileNameSchema, create: () => fileNameSchema } },
				// 正文与「写活跃记忆」共用同一个 512 KB 上限 schema；类型名沿用 #ArchivedFileContent
				// 是为了与「读归档」那一侧对称（活跃记忆那套也是 FileContent 一符两用）。
				{ name: 'content', wire: 'content', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchivedFileContent', schema: fileContentSchema, create: () => fileContentSchema } },
				{ name: 'opts', wire: 'opts', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'sage-mem/types#WriteOpts', schema: writeOptsSchema, create: () => writeOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchivedWriteResult', schema: archivedWriteResultSchema, create: () => archivedWriteResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			// **彻底删除**一条归档件（不可恢复）。`archivedAt` 是展示时间，`revision` 才是内容身份
			// （归档代次 + 正文 revision）—— 期间可能被恢复＋同分钟重新归档、或改成同时间戳另一版（Q07）。
			id: 'sage-mem#memory/deleteArchived',
			service: 'memory',
			namespace: 'memory',
			method: 'deleteArchived',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchivedFileName', schema: fileNameSchema, create: () => fileNameSchema } },
				{ name: 'archivedAt', wire: 'archivedAt', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchiveStamp', schema: archiveStampSchema, create: () => archiveStampSchema } },
				{ name: 'revision', wire: 'revision', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchiveRevision', schema: archiveRevisionSchema, create: () => archiveRevisionSchema } },
			],
			// 成功 `{ ok: true, file }`、失败 `{ ok: false, error }` —— 与归档 / 恢复同形，复用 ArchiveResult。
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchiveResult', schema: archiveResultSchema, create: () => archiveResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/audit',
			service: 'memory',
			namespace: 'memory',
			method: 'audit',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#AuditReport', schema: auditReportSchema, create: () => auditReportSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/openMemoryDir',
			service: 'memory',
			namespace: 'memory',
			method: 'openMemoryDir',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#OpenFolderResult', schema: openFolderResultSchema, create: () => openFolderResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			// 面板进入时静默查一次；只有「有新版本」才在界面上提醒。
			id: 'sage-mem#memory/checkUpdate',
			service: 'memory',
			namespace: 'memory',
			method: 'checkUpdate',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#UpdateCheck', schema: updateCheckSchema, create: () => updateCheckSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			// 上锁 / 解锁一条记忆：锁上的记忆拒绝归档（自动与手动都不行）。
			id: 'sage-mem#memory/setLocked',
			service: 'memory',
			namespace: 'memory',
			method: 'setLocked',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileName', schema: fileNameSchema, create: () => fileNameSchema } },
				{ name: 'locked', wire: 'locked', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#LockFlag', schema: z.boolean().readonly(), create: () => z.boolean().readonly() } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#LockResult', schema: lockResultSchema, create: () => lockResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/archiveCandidates',
			service: 'memory',
			namespace: 'memory',
			method: 'archiveCandidates',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchiveCandidates', schema: archiveCandidatesResultSchema, create: () => archiveCandidatesResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/getSettings',
			service: 'memory',
			namespace: 'memory',
			method: 'getSettings',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#MemorySettings', schema: settingsSchema, create: () => settingsSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/setSettings',
			service: 'memory',
			namespace: 'memory',
			method: 'setSettings',
			invocation: { kind: 'direct' },
			parameters: [
				// 补丁式：面板一次只改一项时不该把没碰过的字段用旧值覆盖回去。
				{ name: 'patch', wire: 'patch', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#MemorySettingsPatch', schema: settingsPatchSchema, create: () => settingsPatchSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#MemorySettingsResult', schema: settingsResultSchema, create: () => settingsResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/readRaw',
			service: 'memory',
			namespace: 'memory',
			method: 'readRaw',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ReservedFileName', schema: fileNameSchema, create: () => fileNameSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#RawFileContent', schema: rawReadResultSchema, create: () => rawReadResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/writeRaw',
			service: 'memory',
			namespace: 'memory',
			method: 'writeRaw',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ReservedFileName', schema: fileNameSchema, create: () => fileNameSchema } },
				// 4 MB：与 fileContentSchema（512 KB）**不是同一个上限**，见 rawFileContentSchema 的注释。
				{ name: 'content', wire: 'content', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#RawFileContent', schema: rawFileContentSchema, create: () => rawFileContentSchema } },
				{ name: 'opts', wire: 'opts', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'sage-mem/types#WriteOpts', schema: writeOptsSchema, create: () => writeOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#RawWriteResult', schema: rawWriteResultSchema, create: () => rawWriteResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			// 1.7.0：最近几次注入的账（只读；关着 SAGE_MEM_DEBUG 时 enabled=false）。
			id: 'sage-mem#memory/recallDebug',
			service: 'memory',
			namespace: 'memory',
			method: 'recallDebug',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#RecallDebug', schema: recallDebugResultSchema, create: () => recallDebugResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#starmap/listStars',
			service: 'starmap',
			namespace: 'starmap',
			method: 'listStars',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'includeArchived', wire: 'includeArchived', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#StarmapIncludeArchived', schema: includeArchivedSchema, create: () => includeArchivedSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#StarmapList', schema: starmapListSchema, create: () => starmapListSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#starmap/readFile',
			service: 'starmap',
			namespace: 'starmap',
			method: 'readFile',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileName', schema: fileNameSchema, create: () => fileNameSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#StarmapRead', schema: starmapReadSchema, create: () => starmapReadSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		// ── autodream 的七个方法 ──
		// 全部挂在 package `sage-mem` 下（和 memory 同一份 manifest），
		// 所以前端直接 ctx.get('remote.autodream') 就能用，不需要像 starmap 那样
		// 在 client 侧再 $mount 一次 —— 那个 mount 是因为 starmap 曾是独立包
		// （package: 'sage-starmap'），合并进 sage-mem 后一直没改回来。
		{
			id: 'sage-mem#autodream/getConfig',
			service: 'autodream',
			namespace: 'autodream',
			method: 'getConfig',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamConfigResult', schema: autodreamConfigResultSchema, create: () => autodreamConfigResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#autodream/setConfig',
			service: 'autodream',
			namespace: 'autodream',
			method: 'setConfig',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'patch', wire: 'patch', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamPatch', schema: autodreamPatchSchema, create: () => autodreamPatchSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamConfigResult', schema: autodreamConfigResultSchema, create: () => autodreamConfigResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#autodream/status',
			service: 'autodream',
			namespace: 'autodream',
			method: 'status',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamStatus', schema: autodreamStatusSchema, create: () => autodreamStatusSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#autodream/runNow',
			service: 'autodream',
			namespace: 'autodream',
			method: 'runNow',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'opts', wire: 'opts', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamOpts', schema: autodreamOptsSchema, create: () => autodreamOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamRunResult', schema: autodreamRunResultSchema, create: () => autodreamRunResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#autodream/listReports',
			service: 'autodream',
			namespace: 'autodream',
			method: 'listReports',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamReportList', schema: reportListSchema, create: () => reportListSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#autodream/readReport',
			service: 'autodream',
			namespace: 'autodream',
			method: 'readReport',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamReportRef', schema: reportRefSchema, create: () => reportRefSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#FileContent', schema: readResultSchema, create: () => readResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#autodream/listSnapshots',
			service: 'autodream',
			namespace: 'autodream',
			method: 'listSnapshots',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamSnapshotList', schema: snapshotListSchema, create: () => snapshotListSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#autodream/listRuns',
			service: 'autodream',
			namespace: 'autodream',
			method: 'listRuns',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'opts', wire: 'opts', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamOpts', schema: autodreamOptsSchema, create: () => autodreamOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamRunList', schema: runListSchema, create: () => runListSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#autodream/readDeclaration',
			service: 'autodream',
			namespace: 'autodream',
			method: 'readDeclaration',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'opts', wire: 'opts', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamOpts', schema: autodreamOptsSchema, create: () => autodreamOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamDeclaration', schema: declarationSchema, create: () => declarationSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#autodream/rollback',
			service: 'autodream',
			namespace: 'autodream',
			method: 'rollback',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'opts', wire: 'opts', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamOpts', schema: autodreamOptsSchema, create: () => autodreamOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamRollbackResult', schema: rollbackResultSchema, create: () => rollbackResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#autodream/listModels',
			service: 'autodream',
			namespace: 'autodream',
			method: 'listModels',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#AutodreamModelList', schema: modelListSchema, create: () => modelListSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		// ── 2.0.0：冲突裁决面（sourceLocation 硬编码为 lib/index.js —— 见 D21）──
		{
			id: 'sage-mem#conflict/list',
			service: 'conflict',
			namespace: 'conflict',
			method: 'list',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ConflictList', schema: conflictListSchema, create: () => conflictListSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#conflict/read',
			service: 'conflict',
			namespace: 'conflict',
			method: 'read',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'opts', wire: 'opts', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ConflictOpts', schema: conflictOptsSchema, create: () => conflictOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ConflictReadResult', schema: conflictReadResultSchema, create: () => conflictReadResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#conflict/invalidate',
			service: 'conflict',
			namespace: 'conflict',
			method: 'invalidate',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'opts', wire: 'opts', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ConflictOpts', schema: conflictOptsSchema, create: () => conflictOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ConflictInvalidateResult', schema: conflictInvalidateResultSchema, create: () => conflictInvalidateResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#conflict/dismiss',
			service: 'conflict',
			namespace: 'conflict',
			method: 'dismiss',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'opts', wire: 'opts', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ConflictOpts', schema: conflictOptsSchema, create: () => conflictOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ConflictDismissResult', schema: conflictDismissResultSchema, create: () => conflictDismissResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#conflict/undo',
			service: 'conflict',
			namespace: 'conflict',
			method: 'undo',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'opts', wire: 'opts', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ConflictOpts', schema: conflictOptsSchema, create: () => conflictOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ConflictUndoResult', schema: conflictUndoResultSchema, create: () => conflictUndoResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
		{
			// ⚠️ 不叫 `remove`：客户端 RemoteNamespaceService 的保留方法名，见 lib/index.js 的注释。
			id: 'sage-mem#conflict/removeRecord',
			service: 'conflict',
			namespace: 'conflict',
			method: 'removeRecord',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'opts', wire: 'opts', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#ConflictOpts', schema: conflictOptsSchema, create: () => conflictOptsSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ConflictRemoveResult', schema: conflictRemoveResultSchema, create: () => conflictRemoveResultSchema },
			sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
		},
	],
	model: {
		"services": [],
		"events": [],
		"objects": [],
	},
}
