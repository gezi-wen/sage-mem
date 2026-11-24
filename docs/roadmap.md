# sage-mem 路线图（2026-11-20 更新 · 2.15.0 已发布）

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
**下一步的门槛**：`lib/index.js` 992/1000、`lib/typert.host.js` 1150/1160 —— 再加 remote 必须先拆模块。

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
