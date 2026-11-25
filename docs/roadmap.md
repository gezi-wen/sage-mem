# sage-mem 路线图（2026-11-25 更新 · 2.20.0）

> **发布流程现状（已落地，不用再改）**：push `v*` tag → `.github/workflows/publish.yml`
> （Trusted Publishing / OIDC，无 token、无 OTP、带 provenance）。tag 必须等于 `package.json` 版本。
> 预演：Actions 页面 Run workflow（`dry_run=true`，会临时改版本号跑 `--dry-run`，不发布）。
>
> **口径**：一版一件事。每版收尾同时更新 CHANGELOG、双语 README 锚点、`.release-notes.md`。

---

## 2.12.0 ·「初始记忆」→ **已发（2026-11-17）**，形态改了

原计划：安装后按需写 3–5 份默认记忆（`feedback_*` / `reference_*` 骨架），挂在实验开关后面。

**实际做法（当天推翻，见 `docs/decisions.md` D46）**：**插件一个记忆文件都不写**。改成一张卡：一段可复制 / 可下载的初始化提示词，用户把它粘给会话里的 agent，由 agent 先查已有文件、再建索引 `MEMORY.md`、流水 `session-log.md` 与三条起步记忆。**卡片位置 2.12.1 定了「实验性」页签顶部**。

**验收（已达成）**：提示词含防覆盖条款 / 索引与流水格式 / 三条起步记忆 / 收尾自检；界面有复制 + 下载 + 复制失败兜底；整个流程零写盘（`client-render-test` 第 28 组守着）；`test/initial-guide-test.mjs` 37 条断言。

---

## 2.14.0 · 记忆治理 —— **已发（2026-11-19）**

- **归档件名收短**：slug 40 → 16 code point，尾部加 4 位**正文**短 hash（`<原名>-<slug≤16>-<YYYYMMDD>-<hash4>.md`）。
  旧归档件不迁移；撞名仍是硬拒绝。
- **孤儿归档件检测**：体检新增 `orphans`（`no_source` / `duplicate`），**不进 problems**。
- **索引瘦身提案**：`indexProposals`，**只报不改**，走「复制修复提示词」。
- **`detail` ReferenceError**：搬到 `05-shared.js`；`client-scope-test` 第 7 组按作用域守这一类。

**明确不做（写在这里，免得下次重开）**：索引一键写盘（没有备份机制之前不开）；合并同主题行；
把超长节搬进 archive（复用不了 `planTrim`）。详见 `docs/decisions.md` D47。

---

## 2.15.0 · 待办看板收尾 —— **已发（2026-11-20）**

原计划叫 2.13，2026-11-19 因为先做治理而跳号；五项原样并进这一版（版本号只能往上走，
所以它们没有以 2.13.x 的名字出现过）。

1. **完成项留档自动化** ✅ —— 待删除块上的**「搬进流水」**：先追加 `session-log.md`、再删清单行；
   正文照抄、已记过的跳过（所以重试安全）、不可撤销（搬完清空撤销栈）。
2. **撤销栈可配** ✅ —— 3–5 步，默认 5；偏好进 `localStorage`，栈本身仍只在内存。
3. **跨文件聚合** ✅ —— `tasks/*/WORKING.md` 的「未完成」节汇总成**只读**区块（新 remote `memory/checkpoints`）。
4. **筛选** ✅ —— 「未完成 / 全部」切换，默认只看未完成；待删除块不受筛选影响。
5. **组展开状态记忆** ✅ —— 按节标题进 `localStorage`；「全部展开 / 收起」不写偏好。

**取舍**：搬进流水为什么不落成 host 工具（一次事务）—— 见 `docs/decisions.md` D48。
**行数余量（2026-11-25 复测）**：`lib/index.js` 876/1000、`lib/typert.host.js` 518/1160、
`lib/autodream/tools.js` 940/1160 —— 都还在线内，但 `tools.js` 已是最接近上限的那个；
下次要往 `lib/` 里加逻辑，先看看能不能放进既有模块的纯函数层，而不是继续往组合根与工具层堆。

---

## 2.19.0 · 搜索覆盖度

对账阶段（2.18.0）把 `search_sessions` 当证据用，而它当时会把自己的局限藏起来：只扫最近若干会话、
片段从行首硬切、预算按未切片的整行长度记账、旧代际静默跳过，零命中一律回「全部会话里没找到」。
这一版只修**说真话**这件事：

- **结果首行是覆盖率**：可用 / 进队（上限 40）/ 完整搜索 / 只读到一部分 / 读不动 / 因上限没看 /
  因输出预算没开始 / 旧格式未读 / 枚举失败。
- **两条轴分开**：`complete` 只说输入覆盖，`truncated` 只说输出被裁；「完整但被裁」是合法组合。
- **片段以关键词为中心**、每段最多 500 字；**8000** 是片段总预算（不是整份输出上限）。
- **零命中分两种说法**，不完整时必须限定范围并写明「这不等于会话里没有」。
- **对账 prompt 加一条纪律**：覆盖不完整时的零命中不能当成「过时 / 该归档」的反证。

**明确不做（写在这里，免得下次重开）**：扩大扫描面（要先做逐帧早停 / 流式）；读 v3 与无版本代际
（只计入覆盖率）；把 `search_sessions` 从「字符串返回」改成结构化返回（`llm-loop` 只吃字符串）。
理由见 `docs/decisions.md` D50。

**下一步的门槛**：`lib/autodream/session-search.js` 的枚举 + 读取是串行的，扩面之前必须先有早停。

---

## 2.19.1 · 开发安装统一（PATCH）

没有人改功能，改的是「怎么把仓库装起来」。以前有两套写法：README 让人 `npm install`，CI 却在装之前
**临时从 `package.json` 删掉** `@deepseek-ai/dsh-skill-filesystem` 这个 peer、手写五个版本号、
装完再还原，`publish.yml` 又复制了一遍。结果是谁也复现不了谁，仓库里也没有锁。

根因是声明：那个 peer 写的是 `"*"`，npm 对空范围走 `latest` 标签解析，而它的 `latest` 停在
`0.0.1-rc.3` 那一代 —— 旧链的 `dsh-session` 要求 `dsh-typert-protocol@^0.0.1-rc.5`，与仓库自己声明的
`>=0.1.2-rc.1` 落在同一个槽位、没有交集。修法是把声明补对，不是继续绕：

- **两侧镜像**：四个与宿主共享实例的 dsh 包同时写进 `devDependencies`（**精确版本**）与
  `peerDependencies`（范围），这是官方对「需要与宿主共享实例的包」的要求。
- **收窄最后一个 peer**：`skill-filesystem` 从 `"*"` 改成 `">=0.1.2-rc.1"`，与另外两个同风格。
- **单一入口**：`node scripts/install-dev.mjs`（默认 `npm ci`）—— 本地、`test.yml`、`publish.yml`
  都是这一条；`--refresh-lock` 才重写锁，普通路径绝不改 `package-lock.json`。
- **锁入库**：`package-lock.json` 成为依赖树的权威；`npm ci` 会核对它与 `package.json` 是否一致。
- **发布步不抽 reusable workflow**：npm 的 Trusted Publishing 绑「仓库 + workflow 文件名」，
  抽成 `workflow_call` 会让 provenance 身份变成调用方。只共用安装脚本，不共用发布步。

**明确不做**：改回临时摘 peer / `--legacy-peer-deps`（实测会把显式列出的 peer 也跳过，35 个套件成片红）；
把发布步搬进可复用 workflow；用 `overrides` 掩盖 peer 代差（那只是把冲突压下去，两家各自的 peer 要求
仍然对不上）。理由与实测细节见 `docs/decisions.md` D51。

---

## 2.20.0 · 跨进程状态写租约（MINOR）

`locked.json` / `access.json` 的整份 RMW 由共享 `file-lease` 原语串行；autodream 运行锁同步迁移。
只承诺同一本地卷、同一 stateRoot、sage-mem 自身写入；不是多文件事务。台账抢锁失败不摘 pending，
dead-key 回收在锁内逐个确认文件不存在。证据：真实双进程 120/120、60/60、竞争恰好 1 胜；父提交实测 61/120、30/60。
明确不做：把 `MEMORY.md` / settings / conflicts 顺手塞进本版；把 TTL 锁说成 fencing 事务；跨设备合并。
详见 D52。

---

## 3.0 · 跨设备（探索）

不自研同步、不套邮局；Syncthing 可行但要常驻进程。目标：一份记忆在两台机器上可读、冲突可裁决。
先读 `docs/cross-device-sync-research.md`，别重复调研。

---

## 常驻清单（每版都做）

1. `npm test` 全绿（含 build-fresh / client-render-test / release-test / structure-test / suite-registry-test / **todo-board-render-test**）；
2. 脱敏：工作区文件 + 全部 git 历史 + 提交信息 + 发布物，四查 + **逐行通读**；
3. 版本面：`package.json` ↔ CHANGELOG 最新节 ↔ 双语 README 锚点 ↔ tag，四处同号；
4. 界面快照：`npm test` 已覆盖比对（`client-snapshot-test.mjs`，2.17.1 起）；**有意改界面**才 `node test/client-snapshot-test.mjs --update`，并把原因写进 CHANGELOG；
5. 发布：push tag，等 CI 绿；Release 用 `.release-notes.md` 当正文；
6. 装机与记忆：更新 `project_sage-mem.md` 的发布面段落。
