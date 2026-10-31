# 外部审查（2026-10-31，基于 2.1.1 / `62b5f75`）响应

> 审查报告：`sage-mem-v2.1.1-review-2026-10-31.md`（20 项未关闭：7×P1 + 13×P2）
> 处置方式（文歌子 2026-10-31 定）：**一项一版** —— 每个问题一个独立 patch 版本（2.1.2 → 2.1.21），
> 每版含「失败回归测试 + 修复 + 正常路径反向对照」，可独立回退、独立解释。
> 版本 → 问题映射与集成顺序见 `plans/sage-mem-2.1.2-2.1.21-审查响应表.md`。

## 总表

| 版本 | 编号 | 优先级 | 主题 | 关闭证据（回归测试） |
|---|---|---|---|---|
| 2.1.2 | Q02 | P1 | 面板保存带读时 revision，版本变了就拒绝覆盖 | `review-211-q02-test.mjs`（39） |
| 2.1.3 | Q01 | P1 | 读时版本与读到正文同源（stat → read → stat） | `review-211-q01-test.mjs`（25） |
| 2.1.4 | N03 | P1 | 自动整理三个读分支统一句柄闸门（`readVerified`） | `review-211-n03-test.mjs`（26+1 平台） |
| 2.1.5 | Q06 | P1 | 恢复归档改事务移动（接管源 → 复核 → 排他落位） | `review-211-q06-test.mjs`（43） |
| 2.1.6 | Q07 | P1 | 归档删除用内容身份（归档代次 @ 正文 revision） | `review-211-q07-test.mjs`（46） |
| 2.1.7 | Q11 | P1 | 回滚排他移动收敛（不支持的 link 不降级成覆盖 rename） | `review-211-q11-test.mjs`（39） |
| 2.1.8 | N02 | P1 | 裁决按 conflict id 串行，后到者明确拒绝 | `review-211-n02-test.mjs`（58） |
| 2.1.9 | N01 | P2 | 撤销绑定原裁决标记（标记被重写 → `stale_decision`） | `review-211-n01-test.mjs`（38） |
| 2.1.10 | Q10 | P2 | 建立索引骨架 = 一次意图调用（mkdir + createIfAbsent） | `review-211-q10-test.mjs`（29） |
| 2.1.11 | Q04 | P2 | 启动解析与面板 pending 共用一份判据（重启真的生效） | `review-211-q04-test.mjs`（40） |
| 2.1.12 | Q05 | P2 | 锁表按路径串行；坏表返回 unknown 并暂停归档 | `review-211-q05-test.mjs`（27） |
| 2.1.13 | Q09 | P2 | 状态根一次解析、显式传给所有子模块 | `review-211-q09-test.mjs`（31） |
| 2.1.14 | Q08 | P2 | 观测代次与投递账分开推进（压缩能识别） | `review-211-q08-test.mjs`（19） |
| 2.1.15 | Q12 | P2 | 检查点句柄只表达一次身份、可解析定位 | `review-211-q12-test.mjs`（30） |
| 2.1.16 | Q13 | P2 | 主动摘要检索不再被注入名额截断 | `review-211-q13-test.mjs`（28） |
| 2.1.17 | Q14 | P2 | 扫描失败 = 检索不可用，不再渲染成空命中 | `review-211-q14-test.mjs`（38） |
| 2.1.18 | Q17 | P2 | 体检复用实际索引定位规则（大小写归一） | `review-211-q17-test.mjs`（41） |
| 2.1.19 | Q18 | P2 | 原子替换继承原文件权限（新建用 0600） | `review-211-q18-test.mjs`（7+6 POSIX） |
| 2.1.20 | Q15 | P2 | 星图入场 / 回放调度（单调时钟 + 标脏 + 不空转） | `review-211-q15-test.mjs`（28） |
| 2.1.21 | Q16 | P2 | 文件列表展开按钮接业务回调（不再 ReferenceError） | `review-211-q16-test.mjs`（30） |

**Q03** 本次复核确认已关闭（星图 `readFile` 走 `shadowsReserved + inspectMemoryEntry + readVerified`），本次未再改。

## 逐项关闭说明

### 2.1.2 · Q02（P1）面板保存没有 revision

- **反例**：读 A → 别处存 B → 面板提交基于 A 的 C，返回 `ok:true`、B 被覆盖。
- **修法**：新增 `lib/memory/write-protocol.js`（`readSnapshot` / `writeSnapshot` + 固定冲突码）；`readFile` / `readArchived` / `readRaw` 返回 `revision`（正文字节 SHA-256）；`writeFile` / `writeArchived` / `writeRaw` 接受可选 `{ expectedRevision, create }`；不匹配 → `stale_revision`（内容逐字节不变），`create` 撞名 → `already_exists`；不传参数的旧调用方兼容 + warn。面板读时记 revision、保存带回、冲突保草稿不自动重试。typert strict 契约与 client 描述符同步（全 additive）。
- **关闭证据**：活动文件 / 归档 / `MEMORY.md` 三组「旧读后新写」均被拒且当前内容逐字节不变；`createIfAbsent` 撞名明确失败；无并发保存成功并回新 revision（反向对照）；旧调用方兼容。
- **边界**：审查附录 `current-repro.mjs` 的 Q02 段调用的是旧协议（不传 revision），仍打印 `ok:true` —— 这正是 additive 契约的预期；面板路径由新协议覆盖。

### 2.1.3 · Q01（P1）自动整理读时版本取错窗口

- **反例**：`readFile → stat → stat`，读 A、两次 stat 都读到 B → A 的正文绑到 B 的版本 → 写回通过宿主 CAS、B 被静默覆盖。
- **修法**：新增 `readEntryWithVersion()`，顺序固定 `stat → read → stat`，两次版本相同才认「内容 = 那个版本」；取不到就按未知处理、**不拿当前版本补票**；未知版本不登记，写回按「没读过」拒绝并落冲突。
- **关闭证据**：受控宿主 fs（版本 = SHA-256、条件写校验真实内容）分别控制 `before-stat→read`、`read→after-stat`、`after-stat→write` 三个窗口；判据是**盘上最后留下的是哪份字节**（B 必须保留）；未变化时可正常写入（反向对照）。
- **边界**：宿主 `fs` 没有原子 read-with-version 原语，本版用双 stat 夹读兜底；有该原语时应优先使用。

### 2.1.4 · N03（P1）自动整理 read_memory 未接公共读取闸门

- **反例**：`inspectMemoryEntry → readFile(路径)`，检查后把路径换成指向目录外的链接，返回目录外内容（`OUTSIDE_SYNTHETIC_CONTENT`）。
- **修法**：三个模型可调用读分支（`read_memory` / `list_memory` / `report_contradiction` 取正文）统一走 `inspectMemoryEntry → readVerified`（同句柄 `fstat` 复核身份与大小），检查后换链接/换文件一律拒绝。
- **关闭证据**：同尺寸替换、大文件替换、检查后删除逐一故障注入，返回值不含目录外哨兵；合法读取三分支正常（反向对照）；Windows 用 `rename` 换文件等价手法，真符号链接分支运行时探测、Linux CI 真跑。
- **边界**：星图扫描等其它入口此前已由 1.6.3 的闸门覆盖，本次不重复改。

### 2.1.5 · Q06（P1）恢复归档无条件删除可能已更新的源

- **反例**：restore 读归档源 A → 目标排他落位 → `unlink(src)`；期间源被写成 B → A 落位、B 被删，新版本两个位置都没了。
- **修法**：抽出事务移动原语 `takeOverSource` / `returnSource` / `retireTaken`（`lib/memory/util.js`），归档与恢复共用：`rename` 到私有名 → 逐字节核对 → 排他落位目标 → 退役私有副本；核对发现是别人的新版本就还回并放弃。
- **关闭证据**：四个交错点（读源后 / 接管前 / 接管后 / 落位后）注入「源改成 B」，任何路径都不丢 B；EEXIST / EIO / 归还失败 / 崩溃残留各验一份可定位原文；归档侧行为不变（反向对照）。
- **边界**：不引入跨进程锁；进程内队列不当作外部编辑器的全局锁。

### 2.1.6 · Q07（P1）归档删除用分钟时间戳当版本

- **反例**：A 改成相同 `archived_at` 的 B 后提交旧确认 → 删除成功、B 消失；同一分钟恢复再归档也会复用时间戳。
- **修法**：`listArchived` 每条带 `revision`（归档代次 @ 正文字节 SHA-256）；`deleteArchived(name, archivedAt, revision)` 必须带内容身份，缺失 → `stale-confirm`；接管实物后再复核一次内容身份。
- **关闭证据**：同时间戳不同正文拒绝、同分钟重新归档拒绝旧确认、校验后被替换也保住新版本；老数据（无留痕）仍可删（反向对照）。
- **点名改掉的旧断言**：`archive-test` 10b 把「只带 `archived_at` 能删」钉成正确行为，已改为带 revision + 「缺 revision 被拒」。

### 2.1.7 · Q11（P1）回滚的 link 降级覆盖已有归档

- **反例**：整目录回滚把 `extra.md` 停进 `archive/`，`archive/extra.md` 已存在，`link` 返回 EPERM → 私有实现 `rename(from,to)` 覆盖旧归档。
- **修法**：合并成一份 `moveFileExclusive`（`lib/memory/util.js`），rollback 复用；不支持 link 时用 `COPYFILE_EXCL` / `wx` 排他复制，校验后才删源；未知错误直接失败，**不默认 rename**。
- **关闭证据**：EEXIST / EPERM / ENOTSUP / EXDEV / EIO 分支逐一注入，已有归档逐字节保持、撞名换退役名、复制失败保留源。

### 2.1.8 · N02（P1）相反裁决没有串行化

- **反例**：同一 open 矛盾 a.md / b.md，两个并发 `invalidate` 都 `ok:true`，两份正文都带 `invalid_at`，记录只记得最后一份。
- **修法**：以 conflict id 为键串行「读记录 → 写记忆 → 写收据」（复用 `createWriteQueue` 派生 `createKeyedWriteQueue` + `serializeByKey`），队列内**重新读状态**；败方返回 `invalid_transition`。另加两条安全阀：已标失效的记录不能被 `dismiss` 覆盖、不能直接 `removeRecord`。
- **关闭证据**：相反并发只一方成功、败方记忆不被标失效、只发生一次有效写入、**写入最大并发 = 1**；两个不同文件的合法裁决都能提交（反向对照）。
- **边界**：审查的 `new-repro.mjs` N02 段用 barrier 等两个写入到达，串行后该 barrier 会永久等待 —— 这是修复生效的直接后果，改用等价无 barrier 断言。

### 2.1.9 · N01（P2）撤销清掉后来写入的有效性标记

- **反例**：裁决把 a.md 标失效 → 别人把标记改成 `invalid_at: 2026-10-30…` + `superseded_by: c.md` → 撤销旧记录成功，后来的标记被删。
- **修法**：撤销保存操作身份与标记前后快照；撤销前确认当前标记仍属于该次操作 —— 仅正文变化照常撤销、标记被重写返回 `stale_decision` 并保留别人的判断。老记录（无快照）保持旧行为。
- **关闭证据**：原标记未变可撤销；仅正文变化不丢正文；`invalid_at` / `superseded_by` 被改时撤销被拒且标记逐字节保留。

### 2.1.10 · Q10（P2）建立索引骨架的初始化与「不会覆盖」边界

- **反例**：全新安装 memory 目录不存在 → `writeRaw('MEMORY.md')` 抛 ENOENT；前端把任意读取失败当「不存在」再走可覆盖写。
- **修法**：复用 `writeRaw(…, { create: true })`：创建分支先 `mkdir -p` 再 `createIfAbsent`；撞名 → `already_exists`；前端只调这一个意图接口，不再用「先读失败」判断可否覆盖。
- **关闭证据**：缺目录能初始化；已有索引逐字节不变；读权限失败不触发覆盖；创建竞争唯一胜者；旧路径（`create:false`）行为不变（反向对照）。
- **说明**：审查建议的 `ensureIndexSkeleton` 语义被复用到既有 `writeRaw`，**不新增 remote 方法**（不新增对外面、不动 39 条契约计数）。

### 2.1.11 · Q04（P2）面板上限设置重启不生效

- **反例**：`setSettings({limits:{maxResults:3}})` → 另起进程 → `current=10 / pending=3 / restartRequired=true`（永远「待重启」但重启不加载）。
- **修法**：新增 `resolveLimits()`：持久设置 > 环境变量 > 默认值；`getSettings` 的 `pendingLimits` 与启动解析共用同一份函数；坏设置给明确诊断（`limitDiagnostics`），不静默回默认。
- **关闭证据**：五个字段分别「保存 → 另起新进程读取」；无设置文件 / 非法 JSON / 环境变量与持久值并存的优先级；保存后 `restartRequired=false`、复现值 = 待生效值（反向对照）。
- **边界**：`limitDiagnostics` 目前只在宿主 API 与日志可见，面板展示留待客户端批次。

### 2.1.12 · Q05（P2）锁表丢更新且损坏时当全解锁

- **反例**：12 次并发 `setLocked` 全报成功、最终只剩 1 条；锁文件写成 `{broken` 时 `readLockSet` 返回空集（受保护记忆照常被自动归档）。
- **修法**：按锁表路径分键串行 RMW（复用 `createWriteQueue`）；新增 `readLockState()`（`ok` / `missing`（仅 ENOENT）/ `unknown`）；`readLockSet` 在 unknown 抛 `LOCK_TABLE_UNKNOWN`；`setLocked` 在坏表拒绝且不动坏文件；归档在 unknown 时拒绝（`lock-unknown`）；面板仍可读并带出 `lockedUnknown` / `lockedError`。
- **关闭证据**：12 并发 → 12 条全在；坏表 → unknown、归档拒绝、坏文件逐字节不变；正常表路径反向对照。
- **点名翻转的旧断言**：`race-guards-test` R08 原为「至少一条生效（丢一条是已声明取舍）」，现改为「3 并发必须 3/3」。

### 2.1.13 · Q09（P2）状态根覆写只对部分模块生效

- **反例**：`SAGE_MEM_STATE_DIR` 指向自定义根 → `AutodreamEngine` 与 `lockFileOf` 仍指向默认 `.sage-mem`；面板快照 `autoArchive=report` 而引擎 `off`。
- **修法**：装配期一次解析 `{memoryDir, stateRoot, sessionsRoot}` 显式传给引擎、锁、台账、冲突、检查点、快照；旧根**不自动迁移**（新根优先、旧 `.sage-mem` 原样保留，启动打印一行提示点名剩余数据）。README 双语补「状态根的范围与迁移」一段。
- **关闭证据**：自定义根下配置 / 锁 / 台账 / 冲突 / 检查点 / 快照完整往返；引擎与面板读到同一策略；默认根不新增文件（反向对照）；旧根文件逐字节不动。

### 2.1.14 · Q08（P2）去重轮次不更新观测计数

- **反例**：2 条时注入过 → 涨到 20 条（同题去重、无投递）→ 压缩回 10 条 → 比较的是 10 与 2，判不出压缩，同题不再注入。
- **修法**：拆开 `lastObservedMessageCount` 与投递账；每次 assemble 先推进观测代次，发现下降就清签名与预算；只有成功投递才推进 delivered。
- **关闭证据**：2 → 20（去重）→ 10 重新注入；预算拒绝 / 零命中轮次后的压缩也能识别；未缩短时同题仍被抑制、不串会话（反向对照）。
- **边界**：「条数不下降的压缩」仍不可识别（既有声明边界不变）。

### 2.1.15 · Q12（P2）长任务 ID 的检查点句柄给出不存在的路径

- **反例**：64 字符 taskId 时句柄退化成「读 tasks/WORKING.md」，真实布局里没有这条路径。
- **修法**：id 只出现一次（完整相对路径 `tasks/<id>/WORKING.md` 里）+ 显式基准「状态根下」；退化只丢项目名与提示，路径与 revision 永不截断；新增 `parseCheckpointHandle()` 与生成共用同一规则。
- **关闭证据**：64 字符 id / 中文项目名 / 长 revision 三种形状 ≤160 字节**且**能定位到刚写下的真实文件；旧退化句柄与缺基准的裸路径都解析失败（反向对照）。
- **说法变更**：句柄文案变了，golden 与 `inject-test` 的固定说法同步更新（断言名保留）。

### 2.1.16 · Q13（P2）主动摘要检索被注入名额截断

- **反例**：`SAGE_MEM_MAX_RESULTS=3`、7 份摘要全命中 → 主动检索只返回 3 条、`nextCursor=null`、`complete=true`，翻页取不回。
- **修法**：抽出 `rankSummaries()`（只排序不截断）；`selectRelevant()` 改为「排序后取前 MAX_RESULTS」（注入侧语义不变）；主动检索在完整候选上应用自己的 limit/cursor。
- **关闭证据**：`MAX_RESULTS=1/3/10` 下主动检索完整翻页结果相同、每页不重复不漏；注入侧条数仍守配置（反向对照）；离线评测 exit 0 无退化。

### 2.1.17 · Q14（P2）扫描失败被转换成「完整搜索且没有命中」

- **反例**：路径被普通文件占住（readdir ENOTDIR）→ 工具返回 `ok:true, searched:0, complete:true, hits:[]`。
- **修法**：新增 `scanMemoryDirDetailed` / `scanMemoryFilesDetailed` 返回 `{files, complete, errors, skipped, missing, namesKey}`（旧数组签名保留兼容）；契约拍板：目录不存在 = 合法空库（`complete:true, missing:true`），ENOTDIR / EACCES = 检索不可用（`complete:false` + errors，不落缓存）；`search_memory` 如实转达 `{ok:false, code:'memory_unavailable', coverage:{complete:false, errors}}`。
- **关闭证据**：真实 ENOTDIR → 检索不可用文案（不再像「没有匹配项」）；空目录 = 成功零命中；EACCES 恢复后能重新扫到（失败没被缓存）；单条目跳过与目录失败分开计数（反向对照）。

### 2.1.18 · Q17（P2）体检对索引大小写的规则与其他入口不一致

- **反例**：索引合法地叫 `memory.md` → 体检把它报成 `unlisted` + `noFrontmatter`（只改大小写后 problems 4 → 1）。
- **修法**：索引识别收口到 `lib/memory/index-file.js`（`isIndexName` / `resolveIndexNames`，规范名优先、多变色器变体报冲突）；audit 用真实索引名读取、按名字归一排除索引；报告新增 `indexFile` / `indexConflicts`。
- **关闭证据**：`memory.md` / `MEMORY.md` 体检结果一致；真记忆漏索引 / 前缀不一致仍报（反向对照）。
- **边界**：Windows NTFS 不区分大小写，物理「双索引」本机造不出 —— 测试**显式断言该事实**，纯函数判据本地验，物理分支留 Linux CI。

### 2.1.19 · Q18（P2）面板原子替换放宽 POSIX 权限

- **反例**：umask=022、记忆文件 0600，面板保存一次 → 0644。
- **修法**：`writeFileAtomic` 在 `rename` 前把 mode 贴到临时文件上：已有普通文件继承其 mode（`& 0o7777`），新建用保守 `0600`；不跟随符号链接取 mode。
- **关闭证据**：0600 保存后仍 0600；错误路径不放宽；新建默认 0600；硬链接备份不被写穿。权限位断言按运行时探测执行（Windows SKIP + 机制断言，Linux CI 真跑）。
- **边界**：ACL / owner / Windows 权限不在保证范围。

### 2.1.20 · Q15（P2）星图按需绘制没有接上入场与回放调度

- **反例**：入场相位 `-1699999998.983`（`Date.now` 与 rAF `ts` 两个时间原点）、只画 2 帧；回放 3 次 reveal 更新而 `renderCalls=0`。
- **修法**：统一 `performance.now` 单调时钟；入场 / 回放期间持续排帧、静止后一帧不排；`startReplay` 先 `markDirty`、回放进度用 rAF `ts`；隐藏暂停 + `visibilitychange` 恢复；停止后补一帧全亮。
- **关闭证据**：伪时钟验证入场推进、回放每次状态变更触发绘制、停止后不再排帧；静止 40 帧不画 / hover 唤醒一帧 / 隐藏不空转（反向对照）。
- **边界**：未做真实 GPU 截图；WebGL `uTime` 用 epoch ms 喂 Float32 的精度问题已检查（ulp≈131072 ms）但**未修、未计为已验证缺陷**，建议单开一版。

### 2.1.21 · Q16（P2）文件列表展开按钮引用未定义 setExpanded

- **反例**：点击活动卡片 → `ReferenceError: setExpanded is not defined`（拆分后只解构了 `expanded`，`onToggle` 仍引用旧闭包）。
- **修法**：`FilesView` 改收业务回调 `onToggleExpanded(file)`；父组件用函数式 setState + 新增纯函数 `mergeExpanded`（`client/50-shared-ui.js`）合并。
- **关闭证据**：VM 真渲染源组件后调 `onToggle` 不再抛错、展开状态真的翻转、再点收起、点 B 只展开 B；快照式合并的反向对照与定点 `no-undef` 判据。

## 测试与评测（全部 20 版累计）

| 指标 | 2.1.1（审查基线） | 2.1.21 |
|---|---|---|
| `npm test` 断言 | 3614 / 0 | **4280 / 0** |
| 新增回归套件 | — | 20 个 `test/review-211-*-test.mjs` + 2 个夹具（`_client-vm-harness.mjs` / `_q13-child.mjs`） |
| 离线评测 `--mode all --baseline` | exit 0 | 每版 exit 0、`compared`、无退化 |
| 公开面 | 39 条 typert invocation | 仍是 39 条（Q10 复用既有 `writeRaw`，不新增 remote） |

## 已知未做 / 留待后续

1. **UI 展示缺口**：Q04 的 `limitDiagnostics`、Q05 的 `lockedUnknown/lockedError` 目前只在宿主 API 与日志可见，面板尚未展示（本批次不动界面；属客户端文案批次）。
2. **WebGL 时间精度**（Q15 边界里发现）：`uTime` 用 epoch 毫秒喂 Float32，渐亮窗口落在 1 个 ulp 内 → WebGL 后端实际是瞬亮。未修，建议单开一小版。
3. **跨进程并发**：N02 / Q05 / Q06 / Q07 的串行化都是进程内；跨进程仍依赖宿主 `replaceIfVersion` 兜底（仓库既有声明未变）。
4. **权限真验证**：Q18 的 POSIX 行为断言只能在 Linux CI 跑（本机 Windows 无 WSL/docker）。
5. **真实浏览器 / GPU 走查**：Q15 / Q16 的客户端断言是源组件 VM 执行，不是真机截图。
