/**
 * sage-mem client 拼接构建（零依赖，只用 node: 内置）。
 *
 * `lib/client.js` 是**提交进仓库的产物**，也是 `package.json` 的 `exports["./client"]`
 * 指向的那一份 —— 宿主与消费者不需要构建、不需要改 `files`、`pnpm pack` 照旧。
 * 这个脚本只解决「以后在哪儿写代码」：改 `client/*.js` → `npm run build:client` → 覆盖产物。
 *
 * 三条约定：
 *   1. **分片顺序写死在下面的数组里**（不靠文件名排序：显式列表更可读，改名也不会把顺序搞乱）；
 *   2. **用 Buffer 拼接**，产物必须与分片逐字节相同 —— 任何编码层面的自作聪明（BOM、行尾
 *      转换、末尾补换行）都会让 `test/build-fresh.mjs` 的漂移守卫失效；
 *   3. 被当模块 import 时**不写盘**（`test/build-fresh.mjs` 只借它的顺序表与拼接函数）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 分片清单（**唯一**的顺序来源）。
 *
 * 切点都落在顶层语句边界上，拼起来才是一个完整文件 —— 单看某一分片不保证能 parse。
 * ⚠️ 这文件里有**两处同名声明**（两个 `TYPERT_REMOTE`、两份 `CSS`），分属两个模块作用域：
 * 它们分别在 `10..13`（StarmapRuntime 那个 IIFE 里）与 `20..80`（工厂主体里），**别合错**。
 */
export const CLIENT_PARTS = [
  'client/00-header.js', // 文件头注释 + __ModuleLoader__.load 包装开头
  'client/10-starmap-head.js', // StarmapRuntime IIFE 头：常量 / 纯函数 / Markdown 渲染 / overlay store
  'client/11-starmap-styles.js', // 星图那份 CSS（同名第一份，IIFE 作用域内）
  'client/12-starmap-render.js', // 渲染层：WebGL 星野 + canvas2d 兜底
  'client/13-starmap-panel.js', // 星图主体 / 按需重绘 / 诞生回放 / 全屏 overlay / 右缘浮标 + IIFE 收尾
  'client/20-codecs.js', // 手写 strict codec（浏览器无 zod）
  'client/30-descriptors.js', // 主模块的 TYPERT_REMOTE 描述符表
  'client/40-styles.js', // 主模块那份 CSS（同名第二份，工厂作用域内）
  'client/50-shared-ui.js', // TYPE_META / frontmatter 纯逻辑 / Chip・Card・ArchivedCard / 体检・候选・原样编辑面板
  'client/60-autodream-panel.js', // 「自动做梦」面板
  'client/70-memory-panel.js', // 记忆管理 Section：文件列表 / 筛选 / 归档 / 工具面板 / tab
  'client/80-apply.js', // inject + apply(ctx) + 收尾
]

/** 产物路径（相对仓库根）。 */
export const CLIENT_OUT = 'lib/client.js'

/** 按顺序读回所有分片并拼成一个 Buffer（不写盘）。 */
export function concatClient() {
  return Buffer.concat(CLIENT_PARTS.map((rel) => readFileSync(join(ROOT, rel))))
}

/** 拼接并覆盖产物，返回 { bytes, files }。 */
export function buildClient() {
  const out = concatClient()
  writeFileSync(join(ROOT, CLIENT_OUT), out)
  return { bytes: out.length, files: CLIENT_PARTS.length }
}

// 直接 `node scripts/build-client.mjs` 才写盘
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const r = buildClient()
  console.log(`${CLIENT_OUT} ← ${r.files} 个分片，${r.bytes} 字节`)
}
