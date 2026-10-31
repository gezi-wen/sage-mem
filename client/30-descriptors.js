		const TYPERT_REMOTE = {
			package: "sage-mem",
			descriptors: [
				{
					id: "sage-mem#memory/listFiles",
					service: "memory",
					namespace: "memory",
					method: "listFiles",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#FileList", schema: listSchema, create: () => listSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/readFile",
					service: "memory",
					namespace: "memory",
					method: "readFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#FileContent", schema: readSchema, create: () => readSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/writeFile",
					service: "memory",
					namespace: "memory",
					method: "writeFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
						{ name: "content", wire: "content", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileContent", schema: strSchema, create: () => strSchema } },
						// 2.1.2（Q02）：写协议第三参（expectedRevision / create），可选 —— 与宿主 manifest 同一条。
						{ name: "opts", wire: "opts", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "sage-mem/types#WriteOpts", schema: writeOptsSchema, create: () => writeOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#WriteResult", schema: writeSchema, create: () => writeSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/deleteFile",
					service: "memory",
					namespace: "memory",
					method: "deleteFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#DeleteResult", schema: deleteSchema, create: () => deleteSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/archive",
					service: "memory",
					namespace: "memory",
					method: "archive",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
						{ name: "reason", wire: "reason", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveReason", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveResult", schema: archiveSchema, create: () => archiveSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/restore",
					service: "memory",
					namespace: "memory",
					method: "restore",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveResult", schema: archiveSchema, create: () => archiveSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/listArchived",
					service: "memory",
					namespace: "memory",
					method: "listArchived",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedList", schema: archivedListSchema, create: () => archivedListSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/readArchived",
					service: "memory",
					namespace: "memory",
					method: "readArchived",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedFileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedFileContent", schema: archivedReadSchema, create: () => archivedReadSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/writeArchived",
					service: "memory",
					namespace: "memory",
					method: "writeArchived",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedFileName", schema: strSchema, create: () => strSchema } },
						{ name: "content", wire: "content", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedFileContent", schema: strSchema, create: () => strSchema } },
						{ name: "opts", wire: "opts", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "sage-mem/types#WriteOpts", schema: writeOptsSchema, create: () => writeOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedWriteResult", schema: archivedWriteSchema, create: () => archivedWriteSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 彻底删除一条归档件（不可恢复）。第二个参数是归档代次：宿主拿它核对
					// 「要删的是不是用户确认过的那一版」，传错（比如列表过期）会被拒绝。
					id: "sage-mem#memory/deleteArchived",
					service: "memory",
					namespace: "memory",
					method: "deleteArchived",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedFileName", schema: strSchema, create: () => strSchema } },
						{ name: "archivedAt", wire: "archivedAt", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveStamp", schema: archiveStampSchema, create: () => archiveStampSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveResult", schema: archiveSchema, create: () => archiveSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				// ── 面板 API（D1）：体检 / 归档候选 / 设置 / 保留名原样读写 ──
				// 结果形状都在演进（审计清单、候选表、设置项），顶层用 objCodec 接住、
				// 内部宽松 —— 与 autodream 那几个 codec 同一套理由：host 加字段不该让旧界面整体报错。
				{
					id: "sage-mem#memory/audit",
					service: "memory",
					namespace: "memory",
					method: "audit",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AuditReport", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/openMemoryDir",
					service: "memory",
					namespace: "memory",
					method: "openMemoryDir",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#OpenFolderResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/checkUpdate",
					service: "memory",
					namespace: "memory",
					method: "checkUpdate",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#UpdateCheck", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 上锁 / 解锁一条记忆：锁上的记忆拒绝归档（自动与手动都不行）。
					id: "sage-mem#memory/setLocked",
					service: "memory",
					namespace: "memory",
					method: "setLocked",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
						{ name: "locked", wire: "locked", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#LockFlag", schema: boolSchema, create: () => boolSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#LockResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/archiveCandidates",
					service: "memory",
					namespace: "memory",
					method: "archiveCandidates",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveCandidates", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 1.8.0：结果里多了 `ui.sidebarEntry`（侧栏入口开关）。客户端这份 codec 是
					// **顶层严格、内部宽松**的 objCodec —— host 加字段不需要改这里（与 audit /
					// autodream 那批同一套理由）；host 侧真正的形状约束在 typert.host.js 的 zod schema。
					id: "sage-mem#memory/getSettings",
					service: "memory",
					namespace: "memory",
					method: "getSettings",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#MemorySettings", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 1.8.0：patch 可带 `{ ui: { sidebarEntry: boolean } }`。objCodec 只保证顶层是对象，
					// 字段级严格校验在 host 的 setSettings（非布尔 / 未知键都回 {ok:false}）。
					id: "sage-mem#memory/setSettings",
					service: "memory",
					namespace: "memory",
					method: "setSettings",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "patch", wire: "patch", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#MemorySettingsPatch", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#MemorySettingsResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/readRaw",
					service: "memory",
					namespace: "memory",
					method: "readRaw",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ReservedFileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#RawFileContent", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/writeRaw",
					service: "memory",
					namespace: "memory",
					method: "writeRaw",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ReservedFileName", schema: strSchema, create: () => strSchema } },
						{ name: "content", wire: "content", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#RawFileContent", schema: strSchema, create: () => strSchema } },
						{ name: "opts", wire: "opts", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "sage-mem/types#WriteOpts", schema: writeOptsSchema, create: () => writeOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#RawWriteResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 1.7.0：最近几次注入的账。**宽松 codec**（与 audit / 设置那批同一套理由）：
					// 面板只按字段取值、缺失就降级显示，host 将来加字段不该让整条调用报错。
					// 每一条记录的字段口径见 lib/recall/debug.js 的 makeDebug 注释。
					id: "sage-mem#memory/recallDebug",
					service: "memory",
					namespace: "memory",
					method: "recallDebug",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#RecallDebug", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#starmap/listStars",
					service: "starmap",
					namespace: "starmap",
					method: "listStars",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "includeArchived", wire: "includeArchived", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#StarmapIncludeArchived", schema: boolSchema, create: () => boolSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#StarmapList", schema: starmapListSchema, create: () => starmapListSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#starmap/readFile",
					service: "starmap",
					namespace: "starmap",
					method: "readFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#StarmapRead", schema: starmapReadSchema, create: () => starmapReadSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				// ── autodream（自动做梦）──
				// 踩到的坑：namespace 不会自动出现。宿主那份 remote 清单是**构建期生成的
				// 产物**，只有 memory / starmap 在里面；
				// 后加的 autodream 不在，于是 `ctx.get("remote.autodream")` 永远 undefined ——
				// 界面上表现为「remote.autodream 不可用」，而 宿主侧日志明确写着
				// 「autodream gateway mounted ok」（服务是真的挂上了，只是 client 不知道）。
				// 修法就是自己声明 + $mount，和 memory / starmap 一样（现在共十一条：
				// 七个原有方法 + listRuns / readDeclaration / rollback / listModels）。
				{
					id: "sage-mem#autodream/getConfig",
					service: "autodream",
					namespace: "autodream",
					method: "getConfig",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamConfigResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/setConfig",
					service: "autodream",
					namespace: "autodream",
					method: "setConfig",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "patch", wire: "patch", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamPatch", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamConfigResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/status",
					service: "autodream",
					namespace: "autodream",
					method: "status",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamStatus", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/runNow",
					service: "autodream",
					namespace: "autodream",
					method: "runNow",
					invocation: { kind: "direct" },
					parameters: [
						// 契约：runNow({reason})。前端只负责给一个缘由字符串（落进
						// manifest.reason 给人看）；「手动触发跳过门控」由 宿主侧决定。
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamOpts", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamRunResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/listReports",
					service: "autodream",
					namespace: "autodream",
					method: "listReports",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamReportList", schema: arrCodec, create: () => arrCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/readReport",
					service: "autodream",
					namespace: "autodream",
					method: "readReport",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamReportRef", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#FileContent", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/listSnapshots",
					service: "autodream",
					namespace: "autodream",
					method: "listSnapshots",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamSnapshotList", schema: arrCodec, create: () => arrCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				// ── 运行记录 / 整理声明 / 回滚 / 模型目录 ──
				// 都是「单个对象参数」形态（与 setConfig(patch) 同形），契约第二节的
				// {limit} / {runId} / {snapshotId, scope} 逐字对应这个对象的字段。
				{
					id: "sage-mem#autodream/listRuns",
					service: "autodream",
					namespace: "autodream",
					method: "listRuns",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamOpts", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamRunList", schema: arrCodec, create: () => arrCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/readDeclaration",
					service: "autodream",
					namespace: "autodream",
					method: "readDeclaration",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamOpts", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamDeclaration", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/rollback",
					service: "autodream",
					namespace: "autodream",
					method: "rollback",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamOpts", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamRollbackResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/listModels",
					service: "autodream",
					namespace: "autodream",
					method: "listModels",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamModelList", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				// ── 冲突裁决（2.0.0 矛盾检测）──
				// 第四个 namespace。与 autodream 那批同一个坑：namespace **不会自动出现**
				// （宿主 remote 清单是构建期产物），不在这里声明 `ctx.get("remote.conflict")`
				// 就永远是 undefined —— 界面表现为「一整个页签消失」。
				// 6 条都在同一个 `conflict` 面上：列表 / 读正文 / 标失效 / 标记已裁决 / 撤销 / 删记录。
				{
					id: "sage-mem#conflict/list",
					service: "conflict",
					namespace: "conflict",
					method: "list",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictList", schema: conflictListSchema, create: () => conflictListSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 只读：拿一条记录的两份正文（record = item + incoming/onDisk）。
					id: "sage-mem#conflict/read",
					service: "conflict",
					namespace: "conflict",
					method: "read",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ConflictOpts", schema: conflictOptsSchema, create: () => conflictOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictReadResult", schema: conflictReadSchema, create: () => conflictReadSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 唯一会写记忆文件的动作（标 invalid_at）；file 允许是记录的 file 或 otherFile。
					id: "sage-mem#conflict/invalidate",
					service: "conflict",
					namespace: "conflict",
					method: "invalidate",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ConflictOpts", schema: conflictOptsSchema, create: () => conflictOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictInvalidateResult", schema: conflictInvalidateSchema, create: () => conflictInvalidateSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 只改记录状态，不碰记忆文件。
					id: "sage-mem#conflict/dismiss",
					service: "conflict",
					namespace: "conflict",
					method: "dismiss",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ConflictOpts", schema: conflictOptsSchema, create: () => conflictOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictDismissResult", schema: conflictDismissSchema, create: () => conflictDismissSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 撤销失效：删掉 invalidate 写进记忆 frontmatter 的那两行。
					id: "sage-mem#conflict/undo",
					service: "conflict",
					namespace: "conflict",
					method: "undo",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ConflictOpts", schema: conflictOptsSchema, create: () => conflictOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictUndoResult", schema: conflictUndoSchema, create: () => conflictUndoSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 删除记录：不可恢复，但记忆文件一个字节都不动。
					// ⚠️ 方法名不能叫 `remove`：DSH 客户端 RemoteNamespaceService 的原型上有这个名字，
					// 客户端声明同名方法会在 $mount 的 assertMethodAvailable 抛错 —— **整个 client
					// 插件 activate 失败**（2026-10-27 真机复现）。两端统一用 `removeRecord`。
					id: "sage-mem#conflict/removeRecord",
					service: "conflict",
					namespace: "conflict",
					method: "removeRecord",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ConflictOpts", schema: conflictOptsSchema, create: () => conflictOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictRemoveResult", schema: conflictRemoveSchema, create: () => conflictRemoveSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
			],
		};

