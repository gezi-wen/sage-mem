# 体积治理 · 模块契约（2.10.1 实现基准）

> 2.10.2 起两条软线为提醒 16 KB / 强制 40 KB（2.10.1 落地时是 8 KB / 16 KB）；其余契约不变。
> 2.14.0 ①：归档名收短 —— slug 上限 40 → 16，尾部加 4 位内容 hash（`<原名>-<slug>-<YYYYMMDD>-<hash4>.md`，见 §2 第 5 条）。

> 本文件是实现的**唯一接口真相**。四个实现片各自只碰自己的文件，跨片调用只按这里的签名。
> 设计与取舍（含被驳回的方案与代价）记在 `docs/decisions.md` 的 **D45**。
> 违反依赖方向会被 `test/structure-test.mjs` 第 2 组（依赖方向）红掉：`memory/**` 不许 import `autodream/**`、`recall/**`、`assembly/**`、组合根。

## 0. 三条线（唯一定义处 `lib/shared/limits.js`）

```js
export const TRIM_WARN_BYTES  = 16 * 1024   // 提醒 16 KB
export const TRIM_FORCE_BYTES = 40 * 1024   // 强制处置 40 KB
export const INDEX_LINE_CHARS = 240         // MEMORY.md 单行字符上限
export const INDEX_DOC_BYTES  = 24 * 1024   // MEMORY.md 整份字节上限
```
`test/duplication-test.mjs:52` 的同类规则：这些常量只许出现在 `shared/limits.js`，别处只 import。

## 1. `lib/memory/size-policy.js`（纯，无 IO）

```js
import { INDEX_DOC_BYTES, INDEX_LINE_CHARS, TRIM_FORCE_BYTES, TRIM_WARN_BYTES } from '../shared/limits.js'
import { INDEX_FILE_KEY, SESSION_LOG_KEY } from '../shared/md-name.js'   // 规范名的唯一来源
import { isNonEntry, isReserved } from './naming.js'

/** 名字 → 类别：'entry' | 'index' | 'sessionLog' | 'reserved' */
export function kindOfName(name)

/** 单条正文判定。bytes 用 UTF-8 字节。 */
export function classifySize({ bytes, kind = 'entry' })
// → { kind, bytes, level:'ok'|'warn'|'force'|'skip', limit:number, advice:'trim-or-compress'|'index-slim'|'none' }

/** MEMORY.md 专用：逐行长度 + 整份体积 */
export function indexFindings(text)
// → { bytes, lines, longLines:[{line:number, chars:number}], overDoc:boolean,
//     level:'ok'|'warn'|'force', advice:'index-slim'|'none' }

/** 人读的体积：'26.4 KB' / '812 B' */
export function sizeText(bytes)

/** 一整句中文建议（回执与审计共用同一句，别各写一套）。可选 longLines 用于索引长行的措辞。 */
export function adviceText({ bytes, kind, longLines })
```

> **实现备注（2026-11-15，A 片落地后补记，视为契约的一部分）**
> - `limit` 的语义：**触发当前档的那条线**；`ok` 档给「下一条会响的线」；`skip` 档为 `0`。
> - 规则 3「存在长行即 force」落在 `indexFindings`（`classifySize` 只吃 bytes，物理上判不了长行）；`adviceText` 接受可选 `longLines`，否则「一行 500 字、总共 1 KB」的索引会被说成体积正常。
> - `kindOfName` 先认 `index` / `sessionLog`（它们同时也在保护名单里，顺序反了索引会被判成 skip），再判 `reserved`。
> - `adviceText` 返回**整句**，调用方只许写 `ℹ ${adviceText(...)}`，不许再拼前缀。
> - `prepareWrite` 对 `MEMORY.md` 也跑索引规则（只提醒、不拦，符合「只报不改」）；`spec.ctx` 可选，不传时告警落 `console.warn`（生产可见性受限，已知代价）。

判定规则（必须与测试一一对应）：
- `kind==='entry'`：`bytes ≥ TRIM_FORCE_BYTES` → `level:'force'`；`≥ TRIM_WARN_BYTES` → `warn`；否则 `ok`。
- `kind==='index'`：`bytes ≥ INDEX_DOC_BYTES` **或** 存在 `chars > INDEX_LINE_CHARS` 的行 → `force`；`bytes ≥ INDEX_DOC_BYTES*0.5` → `warn`。
- `sessionLog` / `reserved` → `level:'skip'`，`advice:'none'`（**永不计入问题**）。

## 2. `lib/memory/trim-plan.js`（纯，无 IO）

```js
export const TRIM_MIN_SEGMENT_BYTES = 1024
export const TRIM_MIN_REMAIN_BYTES  = 1024

/**
 * selector: { heading: string }             // 二级/三级小节标题，不含 #
 *         | { startLine: number, endLine: number }  // 1-based，闭区间，行号按 content.split(/\r?\n/)
 * reason: string（必填，≥4 字）
 * at: number（毫秒时间戳，注入点用 Date.now()；测试可传固定值）
 */
export function planTrim({ content, name, selector, reason, at })
// ok:  { ok:true, archiveName, segment, remaining, pointer, title, range:{start,end}, sourceMeta:{name,description,type,tags} }
// err: { ok:false, code, error }
```

不变量（每条都要有断言）：
1. 正文必须以 `---` 开头的 frontmatter 起始；`remaining` 里**必须**仍带完整 frontmatter。
2. 行号选择器**不许**触到 frontmatter 区（`code:'selector_invalid'`）。
3. 被裁段 ≥ `TRIM_MIN_SEGMENT_BYTES`（`segment_too_small`）；剩余正文 ≥ `TRIM_MIN_REMAIN_BYTES`（`remain_too_small`）。
4. 标题找不到 → `heading_not_found`；标题重复 → `heading_ambiguous`。
5. `archiveName` = `<原名去掉 .md>-<slug>-<YYYYMMDD>-<hash4>.md`（四段，2.14.0 起）：
   - **段序是硬约束**：原名必须在最前 —— 归档件被「恢复」搬回根目录后就是一条活记忆，体检按 `f.split('_')[0]` 判类型前缀（`lib/autodream/audit.js` 的 `typeMismatch`），把日期/类型/hash 挪到前面会让它常亮。
   - `slug` 取标题/首行的实义词，去空白与 `\\/:*?"<>|`，长度 **≤ 16**（code point；40 → 16 于 2.14.0 收短），空则 `section`。
   - `hash4` = **被归档那段正文**（`segment`，也就是归档件的正文）的 FNV-1a 32 位指纹，取 4 位小写十六进制，实现在 `lib/shared/hash.js`（零 import）。**取低 4 位**（不是高 4 位）：FNV-1a 的乘法把影响从低位向高位传播，近似文本（同一份记忆的不同切片只差末尾几行）的差异先落在低位 —— 实测 200 条近似文本取高 4 位只有 162 个不同、取低 4 位 200 个全不同。不能用 `node:crypto`：`trim-plan.js` 是纯逻辑层，`test/structure-test.mjs` 第 5 组钉住它零 node 内建 import。
   - 为什么要有 `hash4`：撞名是**硬拒绝**（§3 第 5 步，不覆盖、不改名、不加序号），slug 一收短，「同一天 + 同一前缀 + 同一截断标题」就会假撞，治理直接跑不动。加了内容指纹后只有**正文真重复**才撞 —— 那本来就该拒。
   - `archiveName` 必须能通过 `shared/md-name.js` 的 `isPlainMdName`。
   - **旧归档件不迁移、不重命名**：库里同时存在三种归档命名（本形状 / `name-YYYYMMDD` / `name.YYYYMMDD-before-split`），所以任何逻辑（孤儿检测、去重、排序）都**不许按名字形状判**，只按 `archived_from` / 指针行 / frontmatter 判。
6. `pointer` 一行：`> 这段旧内容已归档到 archive/<archiveName>（<YYYY-MM-DD>，缘由：<reason>）`；`remaining` 在原位置留 `pointer` + 前后各一空行，**其余正文一字不动**（用严格相等断言：把 pointer 换回 segment 应还原原文件）。
7. `segment` 是 Markdown 正文（不含 frontmatter）。

## 3. `lib/memory/trim-archive.js`（IO）

```js
/**
 * @param {{memoryDir:string, name:string, selector:object, reason:string,
 *          at:number, ctx?:object}} p
 * @returns {Promise<
 *   {ok:true, archivedFile:string, beforeBytes:number, afterBytes:number, segmentBytes:number, pointer:string} |
 *   {ok:false, code:string, error:string, stage:string}>}
 */
export async function trimArchive(p)
```

写序（**顺序即安全**，不许换）：
1. `readLockState(memoryDir)`；`status==='unknown'` → `{code:'lock_unknown'}`。
2. `isReserved(name)` → `reserved`；`isNonEntry(name)` → `non_entry`。
3. `inspectMemoryEntry(full,{limitBytes:null})` → 失败透出 code；`readSnapshot` 拿 `{content, revision}`。
4. `planTrim` 在**这份内容**上重算；失败透出 code。
5. `writeFileExclusive(archive/<archiveName>)` 写归档件（撞名 → `exists`，**不覆盖、不改名**）；归档件 frontmatter = 源 `name/description/type` + `archived_from` + `archived_slice`，再经 `addArchiveMeta(content, reason, stampHuman(at))` 补 `archived_at/archived_reason`。
6. `writeSnapshot(target, remaining, gate, {expectedRevision: revision}, meta)` 改主文件；`stale_revision` 原样透出。
7. 第 6 步失败：把归档件退役成 `archive/.retired-<stamp>-<hex>.md`（借用 `autodream/rollback.js:258-278` 的命名模板，**移动不删除**），返回 `{ok:false, code, stage:'after_archive', error}`（`archivedFile` 放在 error 文案里）。
8. **不摘索引**（文件还在）、**不写访问台账**。

## 4. 主智能体工具（`lib/tools/memory-tools.js` + `lib/assembly/tools-mount.js`）

新工具 `trim_memory`，参数：
```json
{ "file": "…md", "heading": "…", "startLine": 0, "endLine": 0, "reason": "…" }
```
- `heading` 与 `startLine/endLine` 二选一，缺两个或都给 → 回文案错误（说明怎么填）。
- `reason` 必填 ≥4 字。
- 回执是**字符串**（工具面惯例）：成功给「已裁剪 <n> 字节到 archive/<file>，主文件 <a> → <b> 字节」；失败给 `错误：<code> — <一句处置建议>`。
- `read_memory` 的回执在命中条目超线时**追加一行**：`ℹ 这条 43.1 KB，超过 40 KB 强制线：按 sage-mem 技能的「体积治理」处置（裁段归档 / 压缩）`。

## 5. 自动做梦挂点

### 5.1 `lib/autodream/size-tools.js`（新）
```js
export function archiveSegmentToolSchema()            // {name,description,parameters}
export async function runArchiveSegment(args, deps)   // → string（永不抛）
// deps: { memoryDir, ctx, apply, record(op, info) }  // record 由 tools.js 注入，内部即 changeRecord
```
工具名 `archive_segment`，参数 `{file, heading?, startLine?, endLine?, reason}`（reason 必填）。
内部只调 `trimArchive`，绝不自己拼写盘逻辑。

### 5.2 `lib/autodream/tools.js`
- `autodreamToolSchemas` 的 `if (opts.apply)` 分支里 push `archiveSegmentToolSchema()`。
- `switch` 加 `case 'archive_segment':` → 转调 `runArchiveSegment`，`record('trim', …)` 落 `op: 'trim'`。
- `write_memory` 成功且 `before.exist && after.bytes <= before.bytes * 0.8` 时，宿主自动向**写回的内容**补 frontmatter：`compressed_at` / `compressed_reason`（reason 或 `'整理时压缩'`）/ `compressed_from_bytes`。补完再落盘（同一 case 内，顺序：算好增强内容 → 写）。
- `lib/autodream/util.js` 的 `OP_LABEL` 加 `trim`。

### 5.3 `lib/autodream/audit.js`
- 新数组 `oversize: [{file, bytes, level:'warn'|'force'}]`（只收 ≥ warn 的条目，**跳过 `isReserved` 与 `NON_ENTRY_FILES`**）。
- 新数组 `indexOversize: [{file, bytes, longLines:number}]`（仅 `MEMORY.md`）。
- `problems` 只加 `oversize` 里 `level==='force'` 的条数；`warn` 级与 `indexOversize` 只提示（照 `archivedLinks` 的写法）。
- `formatAudit` 加两节，标题含处置建议（例如「超过 40 KB（必须处置）」/「索引过长（只报不改）」）。

### 5.4 `lib/autodream/report.js`
- manifest 顶层新键 `trim`：
```js
{ requested:number, applied:[{file, op:'trim'|'compress', reason:string, beforeBytes:number, afterBytes:number, archivedFile?:string}],
  skipped:[{file:string, bytes:number, why:'protected'|'deferred'}], deferred:boolean }
```
- `declaration.md` 新增一节「裁剪与压缩」（放在「被删事实」之后）：逐条 `文件 / 操作 / 缘由 / 体积变化`；`skipped` 里 protected 的单列一句。
- 人读报告 `## 裁剪`。
- **不要**把 `trim` 塞进 `changes` / `archive.archived`（那两处会被 64 KB 裁剪与回滚当成动作记录）。

### 5.5 `lib/autodream/prompt.js`
- 用户提示在「阶段 3 整合」与「阶段 4 修剪与索引」之间插入 **「## 阶段 3.5 — 体积治理」**，内容要点：
  - 超过 40 KB 的条目本趟必须处置；能拆成完整小节 → `archive_segment`；拆不开 → `write_memory` 压缩（结论前置、去重、删被推翻的）。
  - `MEMORY.md`、`session-log.md`、保护名单里的文件**不算**（不许动）。
  - 裁段必须带 `reason`；工具会自动在主文件留指针。
  - 若确实一条都没处置，回报里说明为什么。
- 系统提示的 `reservedNote` 措辞扩写为「保护名单：不许改、也不计入超线」。

### 5.6 `lib/typert.host.js`
`auditReportSchema` 加两个字段（strict 下不声明会被剥掉）：
```js
oversize: z.array(z.object({ file: z.string(), bytes: z.number(), level: z.string() })).optional(),
indexOversize: z.array(z.object({ file: z.string(), bytes: z.number(), longLines: z.number() })).optional(),
```
**`test/structure-test.mjs` 第 1 组的单文件行数上限同时从 1100 改到 1120**（文件头注释写明理由：审计新增两类字段是传输契约，不能搬走）。

## 6. 设置页「不参与整理的文件」（`client/`）

- 新分片 `client/65-tidy-scope.js`，**必须**登记进 `scripts/build-client.mjs:27-49` 的顺序表（`build-fresh.mjs:42-52` 会验）。
- 数据源：`memRemote.listFiles()`（`{file,type,description,size,tags,locked}`）+ `memRemote.getSettings()`（`reserved` 含两个内置名，要标成不可取消）。
- 交互：搜索框 + 每行 checkbox + 保存 → `memRemote.setSettings({ reserved:[...] })` → 回执要显示「需重启 DSH 才生效」（该设置强制 `restartRequired:true`）。
- 宿主没有设置接口时（`typeof memRemote.getSettings !== 'function'`）换文案，不报错。
- 挂载点：`client/60-autodream-panel.js` 的「设置」子页签，替换现有 `:594-622` 那段「保留名保护名单」文本框为「摘要 chips + 勾选面板」；旧的加/删入口可以保留在 chips 上。
- i18n：`client/55-i18n-memory.js` 的 ZH 与 EN **两份都加**（缺 EN 会静默回落中文，`client-render-test.mjs:3692` 有断言）。

## 7. 新测试（四个套件，必须登记进 `test/run.mjs` 的 `SUITES`）

| 文件 | 覆盖 |
|---|---|
| `test/size-policy-test.mjs` | 三档判定 / 边界值 / index 长行 / skip 类目 |
| `test/trim-plan-test.mjs` | 六条不变量 + 往返还原（pointer ↔ segment） |
| `test/trim-archive-test.mjs` | 完整写序：成功、撞名、`stale_revision`、`lock_unknown`、保留名拒绝、失败退役 |
| `test/autodream-size-test.mjs` | 审计两数组与 problems 计数、prompt 含阶段 3.5、`trim` 声明渲染、压缩留痕 |

写法约束（现有惯例）：自研 `ok(cond,name,extra)` + 每个断言打 `  PASS <名>` + 结尾 **必须**打 `结果：N passed, M failed`；临时目录自清理；不许联网；不许碰真实记忆目录。
