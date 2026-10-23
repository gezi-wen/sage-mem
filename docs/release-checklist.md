# 发布清单（每次发版逐条走）

> 建 2026-10-16。为什么要有这份文件：边界表 §三 第 2 条点出「写入门真实到达性的另一半 ——
> **发布清单**」当时**全仓库搜不到**（只有边界表自己引用了两次），而外部复审 R04 / R08
> 的处置也都落在「发布前人工跑一次」这类**不能被 CI 覆盖**的步骤上。
> 一份只存在于记忆里的清单，等于没有清单。
>
> **顺序本身是纪律**：`git push` 到公开远端**就是**发布动作，所以第 1 步必须在 push **之前**。
> 顺序反了只能重写历史，而 force-push 并不真正抹掉旧的 SHA。

## 1. 脱敏四查（`dsh-publish-desensitization` 技能，一个都不能少）

| # | 查什么 | 命令 |
|---|---|---|
| 1 | **工作区文件** | `node "$env:DSH_HOME\skills\dsh-publish-desensitization\scripts\desensitize.mjs" <仓库目录> --check` |
| 2 | **全部 git 历史**（旧提交的注释里也带着） | `git log -p --all \| Select-String -Pattern <词> -CaseSensitive` |
| 3 | **提交信息**（标题干净 ≠ 正文干净；**最容易漏的一查**） | `git log --format='%B'`，**逐个未推提交**扫。历史里漏过一处（老提交 `7462df9` 的信息里有服务器昵称，在 `origin/main` 里可达，2026-10-15 决定接受现状） |
| 4 | **已发布 / 待发布的包** | `npm pack` → 解包 → 对解开的目录再跑第 1 查 |

⚠️ **四查只覆盖「名字与路径」。** 词表扫不到的那七类（陈旧文案 / 个人数据指纹 /
我们自己的工作流痕迹 / 把当下任务写进 UI 字符串 / 依赖内部实现溯源 / 内部行话 /
自引用行号）**必须逐行通读** —— 2026-10-01 实测过「扫描器报干净零命中，实际 37 条问题」。

⚠️ **判据以脚本自己的 `--check` 为准，别自己拿文本比对**（2026-10-16 实测踩到）：
用 PowerShell 把 `git show` 的输出喂给 `--stdin` 再比字符串时，`Out-String` 产生 **CRLF**
而 node 打回来的是 **LF** —— 两者永远不相等，于是**每一行都被报成命中**（那次 19 个文件全"命中"）。
要比就先归一化行尾（`-replace "\`r", ""`），或者干脆只用 `--check` 的退出码。
**假警报有代价**：它可能让人去重写本来干净的历史。

## 2. `npm test` 全绿（本机 + Linux CI）

```bash
npm test
```

- 本机跑一遍；**推上去之后看 CI**（`.github/workflows/test.yml`，ubuntu-latest + Node 24.x，
  `npm test` 跑两遍，第二遍 `TZ=UTC`）。
- `npm test` 已包含 `test/release-test.mjs`：`npm pack --dry-run` 的白名单、`lib/` 运行时文件完整性、
  包内版本、双语 README 与 CHANGELOG 的当前版本、兼容表对拍。**发布物一致性不再靠人工目测。**
- **干净副本**：复制仓库（排除 `node_modules` / `.git`）→ `npm install` → `npm test`。
  **不要**用 `pnpm install --frozen-lockfile`：`pnpm-workspace.yaml` 当前未入库（2026-10-23 核验发现，R18，1.6.3 处理）。
- **Linux CI 能逮到 Windows 上永远测不出来的缺陷**（区分大小写的卷）：保留名身份集合、
  路径分隔符语义、时区。本机一万遍全绿也不代表 CI 会绿。
- 断言里不许出现「只在某个平台成立」的机制性断言 —— 写成**两个平台都必须满足的不变量**。

## 3. 离线评测（**不在 CI**，必须人工跑）

```bash
node scripts/eval-retrieval.mjs --mode all --baseline test/eval/baseline.json
```

- **退出码必须是 0**。显式 `--baseline` 不可比时脚本退出 1（外部复审 R04 的修复）；
  确需探索用 `--allow-baseline-skip`，它**只放行「没比成」，不豁免真退化**。
- 主指标一律看「**全部检查项**」，不看「无共享词元子集」那个诊断切片（R08）。
- 评测脚本**有意不登记**进 `test/run.mjs`（它打的是指标不是汇总行，见 D4）—— 所以它
  永远只能靠这条清单人工跑。

## 4. 真实宿主探针（只有本次动了宿主侧才需要）

- 探针：`scripts/host-facts-probe.mjs` / `tools-probe.mjs` / `fs-probe.mjs` / `events-probe.mjs`，
  挂法与产物见 `docs/host-facts.md` 第 2 节。提示词**必须真的让模型调一次工具** ——
  没触发时计数全是 0，那是 `inconclusive`，**不许读成 pass**。
- ⚠️ **跑完看 `git status`**：让模型写文件的那一轮写的是**宿主的 cwd**（通常就是仓库根），
  会留下 `tmp-*` / `.tmp-*` / `test-temp-*`。**一律清掉再提交**。

### 4a. `web` profile（2026-10-16 已跑通，可重复）

```powershell
$env:SAGE_MEM_PROBE_AFTER_MS = '90000'      # 长驻 profile 必须放大窗口，见 host-facts 3.5
dsh --profile web --patch $yml --port 0 --no-open
# 从它打印的 http://127.0.0.1:<port>/?token=… 用浏览器发一句「必须用 write 工具…」的提示词
```

- `--port 0` 避开正在跑的 GUI 端口；`--no-open` 不弹浏览器。
- ⚠️ **两个宿主实例同时开着时，`job_kill` 不会带走后起的那个**（Windows 进程树）——
  要按监听端口找到进程显式结束：`Get-NetTCPConnection -State Listen -LocalPort <port>`。
- 预期：`fs/write-intent` observed ≥ 1、`system-prompt/assemble` observed ≥ 1。

### 4b. `desktop` profile（**仍未做到**，需要项目负责人逐次授权）

- CLI 完全进不去：`dsh --profile desktop --dump-config` 与 `--dump-default-profile` 都被拒
  （`profile "desktop" is managed exclusively by the Electron application`）。
- 官方模板只有 `acp / headless / sdk / sdk-minimal / web` —— **没有 desktop**，
  所以「克隆一个模板出来测」这条路也不通。
- 剩下唯一的通道是 **GUI 侧的动态加载**：把探针做成一个 bundle，用 `plugin_manager`
  临时装进 desktop profile —— 桌面版是 **live profile，改动立即生效**，测完卸掉。
  ⚠️ **它会当场作用在你正在用的那个宿主进程上**（如果你就在桌面版里说话，受影响的是当前会话），
  所以：**每次都要先问、先备份 `cordis.patch.yml` 与 `package.json`，再动手**。
- 在此之前，能力边界表 D6 与契约 6.10 保持「**未验证**」—— 不要把 Head Inspect 的
  「宿主里有这个事件」读成「插件收得到」。

## 5. 行为变更写进 CHANGELOG

- 新增 / 修复 / **行为变更**分节写。「行为变更」那一节是给升级者看的承诺，别把修复混进去。
- 若某条旧承诺被**降级或被更正说法**，也要写 —— 静默改口径等于骗人。

## 6. 五锚点核对

代码里的版本号、`CHANGELOG.md` 的标题、**双语 README 的「当前发布版本」**、npm 上的版本、git tag ——
五个地方必须是同一个数字。改完代码忘记改 `package.json` 的 `version` 是这个项目**踩过**的坑
（元数据不等于事实）；2026-10-23 外部审查又抓到 README 停在 `1.0.0` 而包已是 `1.6.1`。

前三处已由 `test/release-test.mjs` 第 5 组在 `npm test` 里自动核对（含反向对照）；
后两处由本清单与 `release-standards` 技能里的 `scripts/verify-release.mjs`（在 `$DSH_HOME` 下，不在本仓库）核对。**别靠眼睛对。**

⚠️ **另有两处「手写副本」已被对拍**：README 顶部那两条静态徽章（`DSH ≥ x` / `node ≥ y`）必须等于
`package.json` 的 `engines`（`doc-consistency-test.mjs` 第 5 组看着）；双语兼容表必须等于
`package.json.dsh.compatibility.dshReleases`（`release-test.mjs` 第 6 组看着）——
**看到那组红，先去比对 `engines` / `dshReleases`，别去改断言。**

## 7. 推上去（release）

```bash
git push origin feat/autodream
git push origin feat/autodream:main
```

- 两个 ref 内容一致；CI 只挂在 `main`（全分支重复跑会白吵人）。
- npm：`node "$env:DSH_HOME\tools\npm-publish.ps1"`（直接 `npm publish` 会因为 DSH 剥掉
  `*TOKEN*` 类环境变量而 E401/E404，那不是 token 坏了）。
- 推完**再跑一次第 4 查**（把 npm 上的包拉回来重扫）—— 那是唯一能验到「真正发出去的东西」的一步。

## 8. 发版后

- 给 GitHub Release 写变更摘要。
- 如果这一版动了公开承诺（契约 / README），把差异同步进 `docs/1.0.0-contract.md` 的
  `断言` 列与 `docs/review-findings.md` 的「谁看着」列 —— 承诺变了而看着它的东西没变，是下次复审的靶子。
