/**
 * sage-mem — 手写 strict typert host manifest。
 * typert-loader 在插件挂载时读 package.json 的 exports["./typert"]，
 * import 本文件并把 TYPERT 注册进 ctx.typert.local（strict 定义）。
 * schema 必须是 zod v4 实例（typert-loader 校验 "_zod" in schema）。
 */
import { z } from 'zod'

// 文件名：与 host 侧 safeName 同一套底线 —— 非空、无路径分隔符与 Windows 非法字符、
// 以 .md 结尾、长度有界。（真正的目录逃逸防护仍在 host 侧 safeName。）
const fileNameSchema = z.string().min(1).max(255).regex(/^[^\\/:*?"<>|\u0000-\u001f]+\.md$/)
// 正文：512 KB 上限。理由是「记忆要塞进 system prompt」——单条正常量级在几十 KB，
// 到半兆量级基本是写错了目标（贴了日志/代码进来）。与 lib/index.js 的 MAX_FILE_BYTES 一致。
const fileContentSchema = z.string().max(512 * 1024)

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
}).readonly()

const listResultSchema = z.array(fileSchema)
const readResultSchema = z.object({
	'name': z.string().readonly(),
	'content': z.string().readonly(),
}).readonly()
// 写/删失败不再抛异常，走 { ok: false, error } 分支：error 必须声明，否则 strict
// 校验会把它当未知字段剥掉，设置页只能看到一个没有原因的 ok:false。
const writeResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'file': z.string().readonly(),
	'error': z.string().readonly().optional(),
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
}).readonly()
const archivedListSchema = z.object({
	'count': z.number().readonly(),
	'files': z.array(archivedFileSchema).readonly(),
}).readonly()

// 归档缘由：用户输入的一句话。真正的 YAML 转义在 host 侧 yamlScalar（值里的「: 」「 #」），
// 这里只兜长度 —— 缘由不该长到把 frontmatter 变成正文。
const archiveReasonSchema = z.string().max(1000).optional()
// starmap.listStars 的可选开关：不看归档星时行为与从前完全一致。
const includeArchivedSchema = z.boolean().optional()

// 归档 / 恢复的结果：成功 `{ ok: true, file }`，失败 `{ ok: false, error }` —— 失败分支
// **没有 file**（名字本身可能就是非法的）。所以不能复用 writeResultSchema：那边 `file`
// 是必填（writeFile 连失败都带着归一后的文件名），strict 校验会把失败分支判成坏结果。
const archiveResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'file': z.string().readonly().optional(),
	'error': z.string().readonly().optional(),
}).readonly()

// 归档文件的读 / 写（v0.9.0 B1b）：归档不是删除，正文要能看能改。三个类型名与活跃记忆
// 那套（FileName / FileContent / WriteResult）对称，只是作用目录换成 `memory/archive/`。
// 名字仍受 safeName 约束 —— 调用方不许自己拼路径。
const archivedReadResultSchema = z.object({
	'name': z.string().readonly(),
	'content': z.string().readonly(),
}).readonly()
// 写归档的结果与 writeResultSchema 同形，但**另立一个类型名**：strict 层要能区分
// 「写活跃记忆」与「写归档记忆」两条路径，将来两者形状分叉时也不必回头改协议。
const archivedWriteResultSchema = z.object({
	'ok': z.boolean().readonly(),
	'file': z.string().readonly(),
	'error': z.string().readonly().optional(),
}).readonly()

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
	'maxSnapshotKeep': z.number().readonly(),
	'rollbackScope': z.string().readonly(),
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
	'maxSnapshotKeep': z.number().optional(),
	'rollbackScope': z.string().optional(),
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
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#ArchivedWriteResult', schema: archivedWriteResultSchema, create: () => archivedWriteResultSchema },
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
	],
	model: {
		"services": [],
		"events": [],
		"objects": [],
	},
}
