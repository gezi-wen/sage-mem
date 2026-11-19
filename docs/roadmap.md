# sage-mem 路线图（2026-11-17 定 · 2.11.1 已发布、发布流水线已跑通）

> **发布流程现状（已落地，不用再改）**：push `v*` tag → `.github/workflows/publish.yml`
> （Trusted Publishing / OIDC，无 token、无 OTP、带 provenance）。tag 必须等于 `package.json` 版本。
> 预演：Actions 页面 Run workflow（`dry_run=true`，会临时改版本号跑 `--dry-run`，不发布）。
> 2026-11-17 实测：CI 跑 `5234 passed, 0 failed`，预演绿。
>
> **口径**：一版一件事。每版收尾同时更新 CHANGELOG、双语 README 锚点、`.release-notes.md`。

---

## 2.12.0 ·「初始记忆」→ **已发（2026-11-17）**，形态改了

原计划：安装后按需写 3–5 份默认记忆（`feedback_*` / `reference_*` 骨架），挂在实验开关后面。

**实际做法（当天推翻，见 `docs/decisions.md` D46）**：**插件一个记忆文件都不写**。改成一张卡：一段可复制 / 可下载的初始化提示词，用户把它粘给会话里的 agent，由 agent 先查已有文件、再建索引 `MEMORY.md`、流水 `session-log.md` 与三条起步记忆。**卡片位置 2.12.1 定了「实验性」页签顶部**（2.12.0 那天先放在文件列表，他看过真机后要求挪走：一次性上手材料不占日常那一屏）。

为什么改：① 写盘就得防「覆盖用户已有记忆」，要状态文件 + revision 守卫 + 撤销栈，三样都是保险费；② 随包技能 `skills/sage-mem/SKILL.md` 已经讲透机制，再来一份正文就是第二份真相；③ 「建哪几条、按谁的情况写」只有会话里的 agent 知道。

**验收（已达成）**：提示词含防覆盖条款 / 索引与流水格式 / 三条起步记忆 / 收尾自检；界面有复制 + 下载 + 复制失败兜底；整个流程零写盘（`client-render-test` 第 28 组守着）；`test/initial-guide-test.mjs` 37 条断言。

---

## 2.13 · 待办看板第二轮（打磨）

1. **完成项留档自动化**：勾选搬进「已完成，待删除」后，收尾把那些行搬进 `session-log.md` 再删（现在靠 agent 自觉，要落成代码或工具面）。
2. **撤销栈可配**：现在两步（撤销/重做各一步），改成 3–5 步可配，仍只存内存。
3. **跨文件聚合**：检查点 `tasks/*/WORKING.md` 的「未完成」节一并显示（只读，不合并写入）。
4. **筛选**：「未完成 / 全部」切换，默认只看未完成。
5. **组展开状态记忆**：`localStorage` 记上次展开到哪一组（按 origin 隔离）。

---

## 2.13 · 待办看板第二轮（打磨）—— **本版跳过（2026-11-19 定）**

> 维护者 2026-11-19 拍板：直接做 2.14 治理，号码跳过 2.13。这五项原样留在这里，以后并进后续版本再发
> （版本号只能往上走，所以它们不会以 2.13.x 的名字出现）。

1. **完成项留档自动化**：勾选搬进「已完成，待删除」后，收尾把那些行搬进 `session-log.md` 再删（现在靠 agent 自觉，要落成代码或工具面）。
2. **撤销栈可配**：现在两步（撤销/重做各一步），改成 3–5 步可配，仍只存内存。
3. **跨文件聚合**：检查点 `tasks/*/WORKING.md` 的「未完成」节一并显示（只读，不合并写入）。
4. **筛选**：「未完成 / 全部」切换，默认只看未完成。
5. **组展开状态记忆**：`localStorage` 记上次展开到哪一组（按 origin 隔离）。

---

## 2.14 · 记忆治理 —— **已发（2026-11-19）**

- **归档件名收短**：slug 40 → 16 code point，尾部加 4 位**正文**短 hash（`<原名>-<slug≤16>-<YYYYMMDD>-<hash4>.md`）。
  实测最长一条 69 字符 / 103 字节（roadmap 原写「80+」是按字节或更长原名推的，据实记录）。
  旧归档件不迁移；撞名仍是硬拒绝（加 hash 是为了让「同日同前缀不同内容」不假撞）。
- **孤儿归档件检测**：体检新增 `orphans`（`no_source` / `duplicate`），**不进 problems**；
  「没有任何引用」只做 `archiveReferenced` 统计（实测 102/126 = 81%，逐条列就是常驻红灯）。
- **索引瘦身提案**：`indexProposals`（悬空条目带行号 / 超长行带行号+字数+预览），**只报不改**，
  走「复制修复提示词」；同时补上 `indexConflicts` / `oversize` 两个「进了 problems 却没有渲染位置」的分类。
- **`detail` ReferenceError**：搬到 `05-shared.js`；`client-scope-test` 第 7 组按作用域守这一类。

**明确不做（写在这里，免得下次重开）**：索引一键写盘（没有备份机制之前不开）；合并同主题行；
把超长节搬进 archive（复用不了 `planTrim`）。详见 `docs/decisions.md` D47。

---

## 3.0 · 跨设备（探索）

不自研同步、不套邮局；Syncthing 可行但要常驻进程。目标：一份记忆在两台机器上可读、冲突可裁决。
先读 `docs/cross-device-sync-research.md`，别重复调研。

---

## 常驻清单（每版都做）

1. `npm test` 全绿（含 build-fresh / client-render-test / release-test / structure-test / suite-registry-test）；
2. 脱敏：工作区文件 + 全部 git 历史 + 提交信息 + 发布物，四查 + **逐行通读**（2026-11-17 就是从注释里抓出 4 处真名）；
3. 版本面：`package.json` ↔ CHANGELOG 最新节 ↔ 双语 README 锚点 ↔ tag，四处同号；
4. 发布：push tag，等 CI 绿；Release 用 `.release-notes.md` 当正文；
5. 装机与记忆：更新 `project_sage-mem.md` 的发布面段落。
