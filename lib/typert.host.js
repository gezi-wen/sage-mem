/**
 * sage-mem — 手写 strict typert host manifest（对齐官方生成文件格式）。
 * typert-loader 在插件挂载时读 package.json 的 exports["./typert"]，
 * import 本文件并把 TYPERT 注册进 ctx.typert.local（strict 定义）。
 * schema 必须是 zod v4 实例（typert-loader 校验 "_zod" in schema）。
 */
import { z } from 'zod'

// 文件名：与 host 侧 safeName 同一套底线 —— 非空、无路径分隔符与 Windows 非法字符、
// 以 .md 结尾、长度有界。（真正的目录逃逸防护仍在 host 侧 safeName。）
const fileNameSchema = z.string().min(1).max(255).regex(/^[^\\/:*?"<>|\u0000-\u001f]+\.md$/)
// 正文：512 KB 上限。理由是「记忆要塞进 system prompt」——现行 memory 目录最大一条 19 KB，
// 到半兆量级基本是写错了目标（贴了日志/代码进来）。与 lib/index.js 的 MAX_FILE_BYTES 一致。
const fileContentSchema = z.string().max(512 * 1024)

const starmapStarSchema = z.object({
	'file': z.string().readonly(),
	'kind': z.string().readonly(),
	'title': z.string().readonly(),
	'desc': z.string().readonly(),
	'bytes': z.number().readonly(),
	'mtimeMs': z.number().readonly(),
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
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#FileList', schema: listResultSchema },
			sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/readFile',
			service: 'memory',
			namespace: 'memory',
			method: 'readFile',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileName', schema: fileNameSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#FileContent', schema: readResultSchema },
			sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/writeFile',
			service: 'memory',
			namespace: 'memory',
			method: 'writeFile',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileName', schema: fileNameSchema } },
				{ name: 'content', wire: 'content', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileContent', schema: fileContentSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#WriteResult', schema: writeResultSchema },
			sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#memory/deleteFile',
			service: 'memory',
			namespace: 'memory',
			method: 'deleteFile',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileName', schema: fileNameSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#DeleteResult', schema: deleteResultSchema },
			sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#starmap/listStars',
			service: 'starmap',
			namespace: 'starmap',
			method: 'listStars',
			invocation: { kind: 'direct' },
			parameters: [],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#StarmapList', schema: starmapListSchema },
			sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
		},
		{
			id: 'sage-mem#starmap/readFile',
			service: 'starmap',
			namespace: 'starmap',
			method: 'readFile',
			invocation: { kind: 'direct' },
			parameters: [
				{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'sage-mem/types#FileName', schema: fileNameSchema } },
			],
			result: { mode: 'strict', typeSymbol: 'sage-mem/types#StarmapRead', schema: starmapReadSchema },
			sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
		},
	],
	model: {
		"services": [],
		"events": [],
		"objects": [],
	},
}
