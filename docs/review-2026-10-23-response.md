# 2026-10-23 外部代码审查响应

> 审查对象：`sage-mem` **1.6.1**（外部提供的 `sage-mem-main.zip`）
> 审查日期：2026-10-23
> 响应版本：**1.6.2**（本文件随该版本发布）
> 原则：**报告里写「潜在风险」的，不写成「已确认缺陷」；我们没修的，不写成「已修」。**

这份文件记录三件事：① 我们怎么核验报告的每一条；② 这一版改了什么；③ 没改的为什么没改、排到了哪里。
报告原文不随包发布；下面的「发现」列是摘录，不是全文。

---

## 1. 判定摘要

| 报告编号 | 判定 | 一句话结论 | 本版动作 |
|---|---|---|---|
| DOC-01 | **成立**（确认缺陷） | README 把契约基线 `1.0.0` 标成了「当前版本」，包版本已是 1.6.1 | 已修 + 门禁 |
| SEC-01 | 窗口真实，**不构成已确认漏洞** | `lstat` 与 `readFile` 之间确有 TOCTOU 窗口（已确定性复现）；但能换文件的人本就能直接写记忆，未发现跨信任边界的利用或外带通道 | 不修读取原语，排 1.6.3 |
| PERF-01 | 全量读取属实，**真实规模不构成问题** | 110 文件 / 1.6 MB：峰值 45 MB、167 ms；1000×512 KB：82 MB / 2.3 s | 不改为流式，排 1.6.3 补压力回归 |
| RET-01 | **数字全部一致，口径需纠正** | 5/5 指标与仓库 baseline 吻合；「71」是题数不是检查项；无答案题注入的是 baseline 记忆 | 排 1.6.4 补诊断与指标 |
| TEST-01 | **环境阻塞，不是仓库缺陷** | 裸解压未装依赖 → `zod` 找不到；本机与按 README 安装后均 2949/0 | 不改代码；CI/发布清单兜住 |
| COMP-01 | **部分成立**（口径缺口） | 无硬矛盾，但「声明范围」被读成「逐版本端到端验过」；本机实跑的 DSH `0.2.1-rc.1` 不在表里 | 已改说法 + 对拍门禁 |
| REL-01 | **未发现缺陷** | 包内 64 条目，`lib/` 58 个文件齐全，零 test/docs/tgz；装包 `import` 正常 | 加 `release-test` 防回归 |
| OBS-01 | 成立（改进建议） | 检索诊断缺 token / 权重 / gate 数值与自动案例报告 | 排 1.6.4 |

**两处核验中额外发现**（不在原报告）：

- **R18**：被跟踪的 `pnpm-lock.yaml` 在 fresh clone 下 `--frozen-lockfile` 失败
  （`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`）—— `pnpm-workspace.yaml` 被 `.gitignore` 掉了。
  干净副本已复现。README 的 `npm install` 路径可用；锁文件口径待 1.6.3 决定。
- **R19**：`StarmapGateway.readFile` 只过 `safeName`，没有 `inspectMemoryEntry` / `shadowsReserved`。
  面板读、不进模型上下文，但与其他两条读路径不一致。排 1.6.3 收口。

---

## 2. 逐条核验

### DOC-01（成立，已修）

- 证据：`README.md` 原第 15 行 `Current version 1.0.0 (the first stable release)`；
  `README.zh.md` 原第 17 行 `当前版本 1.0.0（稳定版）`；`package.json` = `1.6.1`；`CHANGELOG` 最新 = `1.6.1`。
- 关键分辨：`1.0.0` **不是笔误** —— 它是冻结契约的版本线（`docs/1.0.0-*.md`）。错的是把它标成「当前版本」。
- 修法：双语 README 改成
  `**Current release: \`1.6.2\`**` + `**Contract baseline: \`1.0.0\`**`（中文同义），
  并把「当前发布版本 / CHANGELOG 最新节 / `package.json.version`」三处一致做成断言；
  以后再出现「包版本前进了、README 没动」会直接 `npm test` 变红。

### SEC-01（窗口真实，未修）

核验方式：import 真实函数，在临时目录做确定性实验与跨进程竞态。

- **确定性复现**：闸门 `lstat` 看到 57 B 的正常文件 → 在读取前 `rename` 换入 5 MB 文件 →
  `readFile` 实际读进 **5,242,896 B**。这证明「闸门检查的对象」和「实际读的对象」可以不是同一个，
  也说明 512 KB 单文件上限可被这个窗口绕过。
- **真竞态**：独立子进程满速 `rename` 乒乓 20000 次，闸门通过 10,626 次，出现 **8 次身份错配（0.075%）**。
- **威胁模型**：能替换文件的人必须已经能写记忆目录；那个人本来就能直接写记忆内容
  （提示注入不需要 TOCTOU）。唯一新增能力是「读记忆目录外的文件」：
  Windows 非管理员建不出文件符号链接（本机实测 EPERM）；junction 只对目录且 `readFile` 得 `EISDIR`；
  Linux 同用户可建符号链接，但同用户本就能读目标 —— 未找到把内容带回攻击者的通道。
  这台机器上**本机记忆目录**的 ACL 继承了 `Authenticated Users: Modify`，
  「只有同用户可写」的假设不成立，但结论不变（可写者本就能注入）。
- **为什么不本版修**：统一安全读取原语（`open` → `fstat` → 同句柄读）要改 5+ 调用点、
  回归 ENOENT / EISDIR / 超限语义、每文件多一次 `stat`，且 Node 没有跨平台的 `O_NOFOLLOW`
  （Windows 上符号链接竞态无法纯代码闭合）。代价与收益不成比例。
- **已排期**：1.6.3 —— 先补确定性换文件测试与 `StarmapGateway.readFile` 收口，
  再按测试结果决定是否上同句柄原语。环境级更有效的做法是把记忆目录 ACL 收紧到当前用户。

### PERF-01（真实规模不构成问题，未改实现）

`lib/autodream/snapshot.js` 的 `snapshot()` 确实是串行 `readFile` 全量缓冲、无单文件上限；
但完整性判定已经做得很好（`failed` 非空 → 中止；`count != expected` → 拒绝；`manifest.failed` → 拒绝）。

实测（独立子进程 + 外部 5 ms 轮询 Working Set）：

| 场景 | 总数据 | 耗时 | 峰值工作集 | 净增（相对 node 基线 ≈38.7 MB） |
|---|---|---|---|---|
| 真实记忆目录（110 文件） | 1.6 MB | 167 ms | 45.3 MB | +6.6 MB |
| 1000 × 64 KB | 62.5 MB | 1.64 s | 50.8 MB | +12 MB |
| 1000 × 512 KB | 500 MB | 2.31 s | 81.7 MB | +43 MB |
| 10 × 20 MB | 200 MB | 0.31 s | 141.1 MB | +102 MB |
| 1 × 100 MB | 100 MB | 0.15 s | 140.1 MB | +101 MB |

峰值 ≈ Node 基线 + GC 滞后 + **最大单文件**，不随总量线性增长。
流式复制的收益上限就是「最大单文件」（真实 0.64 MB，约占基线 2%），对照实现自己还带 +18 MB 缓冲。
**所以不改实现**；1.6.3 把上表固化成压力回归，并在文档写清「快照 = 顶层 `.md` 全量复制，
磁盘占用上限 ≈ `maxSnapshotKeep` × 总量 + 保护快照」。

### RET-01（数字一致，口径纠正）

复跑 `node scripts/eval-retrieval.mjs --mode all --baseline test/eval/baseline.json`：
EXIT 0、`compared`、判定「无退化」、11 项全部持平。对照结果：

| 指标 | 报告 | 本次复跑 | 判定 |
|---|---|---|---|
| Recall@5（任一命中） | 87.0%（60/69） | 60/69 = 87.0% | ✓ |
| 必要条目召回 | 82.7%（67/81） | 67/81 = 82.7% | ✓ |
| 误注入率 | 5.6%（4/71） | 4/71 = 5.6% | ✓ |
| 无答案仍注入 | 10%（1/10） | 1/10 = 10.0% | ✓ |
| 摘要-only 对照 | 47.8% | 33/69 = 47.8% | ✓ |

三处必须纠正的口径：

1. **71 是「有黑名单的题数」**，不是检查项数；检查项共 229。主指标 = 出现黑名单的题数 / 有黑名单的题数。
2. **「无答案仍注入 10%」的唯一一题是 g02**（「帮我推荐一部电影」），命中的是 `baseline: true`
   记忆；端到端测量里 10 道无关题的非 baseline 注入为 0。它是离线检索口径，不等于真实回答污染。
3. **「摘要-only 47.8%」是脚本内置对照**（同一题集跑 summary），不是 `test/eval/baseline.json`；
   后者是 all 模式的 87.0%。两个「基线」不能混用。

另外：4 个误注入案例是 **a08 / b12 / b14 / b15**，**全部指向同一份** `reference_birdwatching-log.md`
（description 含「候鸟的到达时间」）；3 条是 summary 层近零分（0.0714–0.0909），原因是 summary 路径
没有相关性门槛。词法失败边界 c01–c04 已带 `[lexfail]` 标记，Recall 0/4 —— 报告这部分描述准确。
`--strict` 实测 EXIT 1，报红 `a08, b12, b14, b15` 与白名单外的 `i01–i04`；回归门本身可用。

### TEST-01（环境阻塞，不是仓库缺陷）

- 本机 `npm test`：**2949 passed / 0 failed**；`TZ=UTC` 复跑同样 2949/0。
- 干净副本（排除 `node_modules` / `.git`，不装依赖）：2105/32，18 个套件 exit 1；
  `test/typert-test.mjs` 直接报 `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'` —— 与报告现象完全对上。
- 干净副本按 README 执行 `npm install` + `npm test`：**2949/0 全绿**。
- `zod` 在 `dependencies` 里、锁文件里也有 —— **缺的是安装动作，不是声明**。

顺带确认了 R18：干净副本 `pnpm install --frozen-lockfile` 会因 `pnpm-workspace.yaml` 未入库而失败；
非 frozen 会改写锁。CI 走的是 `npm install --no-save` 显式钉 peer 的路径，因此 CI 不受影响。

### COMP-01（口径已改）

无硬矛盾，但原文「Version-by-version verification record」容易被读成「整个开放范围都做过端到端验证」。
实际自动化只有 Ubuntu + Node 24 + `0.2.0-rc.1` 一代 peer；真实宿主探针只有 headless（2026-10-15）
与 web（2026-10-16），desktop 从未跑过；`engines.node` 声明 ≥18 但 CI 不覆盖 18。
本版把 README 改成「兼容记录 + 怎么读 `compatible`」，补记本机实跑的 DSH `0.2.1-rc.1`，
并让双语兼容表与 `package.json.dsh.compatibility.dshReleases` 互相对拍（漂移会红）。

### REL-01（未发现缺陷，加门禁）

`npm pack --dry-run --json`（审查对象 1.6.1 的实测）：64 条目 / 337,878 B —— `lib/` 58 个文件 + `cordis.patch.yml` +
`NOTICE` + `LICENSE` + 双语 README + `package.json`；零 `test/`、`docs/`、`scripts/`、`*.tgz`。
（1.6.2 因 README 变长，同一份清单是 338,569 B；条目数不变。）
装 tarball 后 `import('sage-mem')` 与 `import('sage-mem/typert')` 均正常；`zod` 自动装上。
`import('sage-mem/client')` 报 `window is not defined` 是浏览器半包的预期行为，不是缺文件。

本版新增 `test/release-test.mjs`（22 条）：包内版本 = 仓库版本；`lib/` 每个 `.js` 都在包里；
白名单外零文件；`test/` / `docs/` / `scripts/` / 锁 / tgz 一律拒绝（含反向对照）；
双语 README 与 CHANGELOG 的版本三处一致；双语兼容表 == `dshReleases`。

---

## 3. 1.6.2 实际改了什么

- 双语 README：当前发布版本 + 契约基线分开表述；兼容性口径写清；补 DSH `0.2.1-rc.1` 行。
- `package.json`：版本 `1.6.2`；`dshReleases` 补 `0.2.1-rc.1`。
- `test/doc-consistency-test.mjs`：保持 55 条（自己的台账不能被自己引用）。
- `test/release-test.mjs`：新增 22 条（打包白名单 11 + 版本一致性 7 + 兼容表对拍 4），登记进 `npm test`。
- `docs/review-findings.md`：增记 R10–R19 与「仍未做」清单。
- `docs/release-checklist.md`：四锚点 → 五锚点（加入双语 README 当前版本），补打包门禁与干净副本步骤。
- 本文件。
- **运行时零改动**：`lib/` 一行没动。

---

## 4. 后续（已排期，不在本版）

| 版本 | 主题 | 验收判据 |
|---|---|---|
| **1.6.3** | 读路径一致性与快照压力 | ① 确定性换文件测试可重复（闸门对象 ≠ 读取对象时必须能检出）；② `StarmapGateway.readFile` 过 `shadowsReserved` + `inspectMemoryEntry`；③ 快照压力回归固化（1000×512 KB / 10×20 MB，断言 `failed=0` 且峰值 < 256 MB）；④ 决定 R18 的锁文件口径（提交 workspace + 重生成，或去掉 pnpm 锁） |
| **1.6.4** | 检索诊断与指标补齐 | ① 自动生成逐案例诊断报告（命中文件 / 段落 / 分数 / 门槛）；② 输出 token / 权重 / gate 数值；③ 补 Precision@k、无答案拒绝率、注入字节数；④ 白名单外误注入纳入门禁 |
| **1.7.0** | 注入调试视图（原 1.6.2） | 面板能看到最近一次注入的完整账；关掉调试开关零开销；新增断言 ≥8 条 |
| **1.7.1** | 难负例扩容 + 版本化基线（原 1.7.0/1.7.1） | 难负例 ≥20 条；召回不降、误召回可测且下降；任意两个历史 baseline 可对比 |
| **1.8.0** | 侧栏「记忆管理」入口（原 1.6.3） | 开/关即时生效；设置页入口保留；断言覆盖关闭态 |

> 版本号按 `release-standards` 的版本迭代规则：**1.6.2/1.6.3/1.6.4 是 patch**
> （文本、测试、内部加固，用法不变）；**1.7.0/1.8.0 是 minor**（用户可感知的新能力）。
> 原路线图把两个功能项放在 1.6.x（patch 位）上，2026-10-23 一并纠正。

---

## 5. 怎么复核这份响应

```bash
npm test \
  && node scripts/eval-retrieval.mjs --mode all --baseline test/eval/baseline.json \
  && node test/release-test.mjs
```

- 抽验 DOC-01：把 `package.json.version` 改成任意别的数字，`npm test` 必须变红并点名 README/CHANGELOG。
- 抽验 REL-01：把 `package.json` 的 `files` 临时改成只列 `lib/index.js`，`release-test` 必须报
  「`lib/` 下每个 `.js` 都打进了包（漏 N 个）」；在 `files` 里加 `docs/`，必须报白名单外。
  ⚠️ 「在 `lib/` 下新加一个空 `.js` 看它报漏」**不成立** —— `files: ["lib/"]` 会把 lib 下所有文件自动打进包，
  那条断言只在白名单被改窄时才有意义（2026-10-23 独立复核实测）。
- 重跑 SEC-01 的确定性实验：`gate = inspectMemoryEntry(f)` 之后、`readFile(f)` 之前换文件，看读到的
  字节数是否与 `gate.size` 不一致。**能复现不等于可利用** —— 评估威胁模型时把「谁能写记忆目录」算进去。

> 本响应是基于有限环境的工程核验，不是完整逐行审计、正式渗透测试或全平台兼容性认证。
> 报告与我们都没有声称「没有发现的 Bug 就不存在」。
