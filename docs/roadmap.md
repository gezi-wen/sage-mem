# sage-mem 路线图（2026-11-17 定 · 2.11.1 已发布、发布流水线已跑通）

> **发布流程现状（已落地，不用再改）**：push `v*` tag → `.github/workflows/publish.yml`
> （Trusted Publishing / OIDC，无 token、无 OTP、带 provenance）。tag 必须等于 `package.json` 版本。
> 预演：Actions 页面 Run workflow（`dry_run=true`，会临时改版本号跑 `--dry-run`，不发布）。
> 2026-11-17 实测：CI 跑 `5234 passed, 0 failed`，预演绿。
>
> **口径**：一版一件事。每版收尾同时更新 CHANGELOG、双语 README 锚点、`.release-notes.md`。

---

## 2.11.2 ·「初始记忆」（下一版，新会话开工）

**问题**：新用户装完 sage-mem，agent 没有任何默认操作规范 —— 该记什么、不该记什么、frontmatter 怎么写，全靠用户自己交代。别人用这个插件时，agent 往往把记忆写成日记。

**做法**：安装后**按需添加**一份默认记忆（`feedback_*` / `reference_*` 骨架），**只新增、绝不覆盖**同名文件；整件事挂在**实验性开关** `experimental.seedMemory` 后面，默认关。

**具体设计（待新会话确认）**

| 项 | 决定 |
|---|---|
| 触发时机 | 首次 `apply()` 且开关打开时检查；不监听文件变化 |
| 判定「已存在」 | 按 `name:` 字段 + 文件名双重比对；命中即跳过并回执，绝不写 |
| 内容 | 3–5 条：记忆分类怎么写、frontmatter 必填项、「推不出来才存」的判据、待办看板的 agent 义务 |
| 不写什么 | 不预置个人信息；不写 `baseline: true`（避免每场无条件注入）；不写版本号 |
| 回执 | 设置页显示「已添加 N 条默认记忆」+ 文件名清单，并提供「撤销（删掉这次新建的）」 |
| 卸载 | 不删已生成的记忆（与插件其它行为一致：记忆是用户的） |

**验收**：① 已有同名记忆 → 只跳过不写；② 开关关闭 → 一个文件都不产生；③ 重启不重复添加；④ `skills/sage-mem/SKILL.md` 里说明这份默认记忆的来历与关闭方法；⑤ 新增测试套件覆盖「跳过 / 新增 / 撤销」三条路径。

**不做**：不做记忆模板市场、不做导入导出、不预置语言风格。

---

## 2.12 · 待办看板第二轮（打磨）

1. **完成项留档自动化**：勾选搬进「已完成，待删除」后，收尾把那些行搬进 `session-log.md` 再删（现在靠 agent 自觉，要落成代码或工具面）。
2. **撤销栈可配**：现在两步（撤销/重做各一步），改成 3–5 步可配，仍只存内存。
3. **跨文件聚合**：检查点 `tasks/*/WORKING.md` 的「未完成」节一并显示（只读，不合并写入）。
4. **筛选**：「未完成 / 全部」切换，默认只看未完成。
5. **组展开状态记忆**：`localStorage` 记上次展开到哪一组（按 origin 隔离）。

---

## 2.13 · 记忆治理

- 归档件名收短（现在把整段小节标题塞进文件名，实测 80+ 字符）；
- 孤儿归档件检测；
- 索引瘦身规则（2.10.1 起只报不改）；
- `client/60-autodream-panel.js` 那个 `detail` ReferenceError（4 处，错误分支一落下就抛）。

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
