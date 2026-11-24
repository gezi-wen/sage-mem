/**
 * sage-mem — 手写 strict typert host manifest。
 * typert-loader 在插件挂载时读 package.json 的 exports["./typert"]，
 * import 本文件并把 TYPERT 注册进 ctx.typert.local（strict 定义）。
 * schema 必须是 zod v4 实例（typert-loader 校验 "_zod" in schema）。
 */
import { z } from 'zod'
import { checkpointsResultSchema } from './shared/checkpoints-schema.js'
import { recallDebugResultSchema } from './shared/recall-debug-schema.js'
import { MD_NAME_PATTERN } from './shared/md-name.js'
import { MAX_FILE_BYTES, MAX_RAW_BYTES } from './shared/limits.js'


// 2.17.1：schema 定义搬到 `lib/typert.schemas.js`，本文件只留 manifest。
import {
  fileNameSchema, fileContentSchema, writeOptsSchema, reportRefSchema, starmapStarSchema, starmapListSchema,
  starmapReadSchema, fileSchema, listResultSchema, readResultSchema, writeResultSchema, deleteResultSchema,
  archivedFileSchema, archivedListSchema, archiveReasonSchema, archiveStampSchema, archiveRevisionSchema, includeArchivedSchema,
  archiveResultSchema, archivedReadResultSchema, archivedWriteResultSchema, updateCheckSchema, auditItemSchema, auditLinkSchema,
  auditTypeMismatchSchema, auditHazardSchema, auditOrphanSchema, auditIndexProposalSchema, auditReportSchema, openFolderResultSchema,
  archiveCandidateSchema, archiveCandidatesResultSchema, lockResultSchema, settingsLimitsSchema, settingsUiSchema, settingsSchema,
  settingsPatchSchema, settingsResultSchema, rawReadResultSchema, rawWriteResultSchema, rawFileContentSchema, autodreamConfigSchema,
  autodreamPathsSchema, autodreamRouteSchema, autodreamLastResultSchema, autodreamConfigResultSchema, autodreamStepSchema, autodreamStatusSchema,
  autodreamRunResultSchema, autodreamPatchSchema, reportListSchema, snapshotListSchema, runListSchema, declarationSchema,
  rollbackResultSchema, modelListSchema, autodreamOptsSchema, conflictIdSchema, conflictOptsSchema, conflictItemBase,
  conflictItemSchema, conflictRecordSchema, conflictCountsSchema, conflictWroteSchema, conflictListSchema, conflictReadResultSchema,
  conflictInvalidateResultSchema, conflictDismissResultSchema, conflictUndoResultSchema, conflictRemoveResultSchema,
} from './typert/schemas.js'
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
			// 2.15.0：待办看板把各任务检查点里的「未完成」并进视野（只读，不写回）。
			id: 'sage-mem#memory/checkpoints',
			service: 'memory', namespace: 'memory', method: 'checkpoints',
			invocation: { kind: 'direct' }, parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#Checkpoints', schema: checkpointsResultSchema, create: () => checkpointsResultSchema },
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
