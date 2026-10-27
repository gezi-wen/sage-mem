# 检索诊断报告

> 由 `scripts/eval-retrieval.mjs --report` 生成，**不要手改**。
> 生成时间：2026-10-27T04:23:24.613Z；mode=all，limit=5，per-file=2。

## 运行信息

- 语料：38 份；问题集：103 题；语料指纹 `f484bb8c1f59`，题号指纹 `436ae39878e5`。
- 误注入（主指标）：17/91 道有黑名单检查的题；检查项共 268 个。
- 白名单外：3/4 道有白名单检查的题。
- 无答案题：仍注入 12/21，拒绝率 42.9%。
- 基线比较：compared

## 指标（含诊断口径）

| 指标 | 值 |
|---|---|
| Recall@k（任一命中） | 73/82 = 89.0% |
| 全中率（全部 needed） | 71/82 = 86.6% |
| 条目级召回 | 80/94 = 85.1% |
| 段落命中（严格） | 41/60 = 68.3% |
| MRR | 0.8059（Σ1/rank = 66.0833 / 82） |
| 误注入率（主指标） | 17/91 = 18.7% |
| 白名单外误注入 | 3/4 = 75.0% |
| 被失效抑制的命中 | 33 条 / 23 题（1361 字节未进正文） |
| 无答案题拒绝率 | 9/21 = 42.9% |
| Precision@k（标注相关集·下界） | 88/237 = 37.1%（可评题 80） |
| 注入字节（候选片段代理） | 14057 总 / 136.5 平均每题 |
| 延迟 p50 / p95 | 1.015 ms / 1.465 ms |

## 难负例（按为什么难单列）

| 类别 | 题数 | 主要读数 |
|---|---|---|
| 共享常用词 | 8 | 误注入 7/8（检查项 24，命中 11） |
| 同名不同项目 | 6 | 误注入 6/6（检查项 9，命中 9） |
| 相同实体不同时间 | 4 | 新版召回 4/4；旧版压新版 0/4；旧版被抑制 4/4 |
| 已失效内容 | 6 | 误注入 0/6（检查项 6，命中 0）；被抑制 4/6 |

这四类各自独立分母；**不要**拿「无共享词元子集」代替它们（那个切片会把这四类排除掉）。

## 逐案例

触发诊断的题：30 道（误注入 / 白名单外 / 无答案注入 / 词法边界 / MISS）。

### a08 · ALL · scope=all

- 问题：「潮汐定时任务的时间窗与幂等约定」
- 备注：摘要直命中
- needed：project_tide-scheduler.md ✓@1
- 标记：黑名单命中：reference_birdwatching-log.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_tide-scheduler.md | 11-13 | 58.6128 | description+alias+body | 0.8761 / 38.92 / 1 / 7 |
| 2 | project_tide-failures.md | — | 0.2143 | description+alias | —（摘要层无门槛） |
| 3 | project_tide-window.md | — | 0.2143 | description+alias | —（摘要层无门槛） |
| 4 | reference_birdwatching-log.md | — | 0.0714 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `project_tide-scheduler.md` 正文门槛：✓ ratio 0.8761 ≥ 0.35；✓ sum 38.92 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 7 ≥ 2（通过）
  - 词元贡献（前 6）：`窗与` idf=4.50 tf=1 → 6.12；`等约` idf=4.50 tf=1 → 6.12；`汐定` idf=3.40 tf=2 → 5.72；`时任` idf=3.40 tf=2 → 5.72；`与幂` idf=3.99 tf=1 → 5.43；`定时` idf=3.20 tf=2 → 5.38

### b06 · MISS · scope=all

- 问题：「退避最长要等多久」
- 备注：正文独有
- needed：project_harbor-backpressure.md [16-16] ✗

（没有命中）

**诊断**：

- 未命中线索：needed 不在 top-5；本次候选 0 条，正文门槛滤掉 6 条。

### b09 · MISS · scope=all

- 问题：「租户编号是哪个字段，不是文档编号」
- 备注：正文独有：摘要只写「重分片的实际步骤」
- needed：project_quarry-shard-split.md [13-13] ✗

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_lumen-sync.md | 21-25 | 10.0475 | description+body | 0.3675 / 11.3792 / 1 / 3 |
| 2 | reference_sagemem-frontmatter.md | — | 0.0769 | description+alias | —（摘要层无门槛） |
| 3 | project_harbor-backpressure.md | — | 0.0769 | description | —（摘要层无门槛） |
| 4 | reference_harbor-config.md | — | 0.0769 | description | —（摘要层无门槛） |
| 5 | reference_lumen-shortcuts.md | — | 0.0769 | description | —（摘要层无门槛） |

**诊断**：

- `project_lumen-sync.md` 正文门槛：✓ ratio 0.3675 ≥ 0.35；✓ sum 11.3792 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 3）：`哪个` idf=4.50 tf=1 → 3.37；`个字` idf=4.50 tf=1 → 3.37；`字段` idf=2.38 tf=3 → 3.18
- 未命中线索：needed 不在 top-5；本次候选 5 条，正文门槛滤掉 54 条。

### b12 · MISS · scope=all

- 问题：「命名要写清什么才算合格」
- 备注：正文独有：第 1 条在正文第 13 行
- needed：feedback_review-checklist.md [13-13] ✗
- 标记：黑名单命中：reference_birdwatching-log.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | feedback_deploy-frozen.md | 20-25 | 6.9752 | body | 0.5175 / 9.105 / 4 / 2 |
| 2 | reference_harbor-metrics.md | 21-25 | 5.6851 | body | 0.3866 / 6.8024 / 4 / 2 |
| 3 | reference_birdwatching-log.md | 17-23 | 4.6378 | body | 0.3866 / 6.8024 / 4 / 2 |

**诊断**：

- 误注入来自**正文路径**：下面是它通过证据门槛的现场数值。
- `feedback_deploy-frozen.md` 正文门槛：✓ ratio 0.5175 ≥ 0.35；✓ sum 9.105 ≥ 1.5；✓ rarestDf 4 / 0.0299 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 3）：`要写` idf=3.40 tf=1 → 2.58；`写清` idf=3.40 tf=1 → 2.58；`什么` idf=2.30 tf=1 → 1.75
- `reference_harbor-metrics.md` 正文门槛：✓ ratio 0.3866 ≥ 0.35；✓ sum 6.8024 ≥ 1.5；✓ rarestDf 4 / 0.0299 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`要写` idf=3.40 tf=1 → 2.82；`写清` idf=3.40 tf=1 → 2.82
- `reference_birdwatching-log.md` 正文门槛：✓ ratio 0.3866 ≥ 0.35；✓ sum 6.8024 ≥ 1.5；✓ rarestDf 4 / 0.0299 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`要写` idf=3.40 tf=1 → 2.30；`写清` idf=3.40 tf=1 → 2.30
- 未命中线索：needed 不在 top-5；本次候选 3 条，正文门槛滤掉 14 条。

### b14 · ALL · scope=all

- 问题：「和备份重叠时让出多少时间」
- 备注：正文独有
- needed：project_tide-window.md [14-14] ✓@2
- 标记：黑名单命中：reference_birdwatching-log.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_tide-scheduler.md | — | 0.0909 | description+alias | —（摘要层无门槛） |
| 2 | project_tide-window.md | 11-16 | 17.4677 | body | 0.7344 / 16.4668 / 1 / 2 |
| 3 | reference_birdwatching-log.md | — | 0.0909 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `project_tide-window.md` 正文门槛：✓ ratio 0.7344 ≥ 0.35；✓ sum 16.4668 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 4）：`备份` idf=3.99 tf=2 → 4.99；`重叠` idf=3.99 tf=2 → 4.99；`叠时` idf=4.50 tf=1 → 3.93；`让出` idf=3.99 tf=1 → 3.49

### b15 · ALL · scope=all

- 问题：「手写日期和系统时间冲突时听谁的」
- 备注：正文独有：摘要只列字段名
- needed：reference_sagemem-frontmatter.md [17-17] ✓@3
- 标记：黑名单命中：reference_birdwatching-log.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_lumen-sync.md | — | 0.0714 | description+alias | —（摘要层无门槛） |
| 2 | project_tide-scheduler.md | — | 0.0714 | description+alias | —（摘要层无门槛） |
| 3 | reference_sagemem-frontmatter.md | 11-17 | 17.0637 | body | 0.5131 / 14.9547 / 1 / 3 |
| 4 | reference_birdwatching-log.md | — | 0.0714 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `reference_sagemem-frontmatter.md` 正文门槛：✓ ratio 0.5131 ≥ 0.35；✓ sum 14.9547 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 4）：`手写` idf=4.50 tf=1 → 5.12；`写日` idf=4.50 tf=1 → 5.12；`日期` idf=4.50 tf=1 → 5.12；`时间` idf=1.46 tf=1 → 1.65

### b17 · MISS · scope=all

- 问题：「任务被拒之后落在哪个目录」
- 备注：正文独有：摘要只写「字段含义速查」
- needed：reference_harbor-config.md [18-18] ✗

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_tide-failures.md | — | 0.0909 | description | —（摘要层无门槛） |
| 2 | project_tide-scheduler.md | — | 0.0909 | description | —（摘要层无门槛） |
| 3 | project_tide-window.md | — | 0.0909 | description | —（摘要层无门槛） |

**诊断**：

- 未命中线索：needed 不在 top-5；本次候选 3 条，正文门槛滤掉 66 条。

### b19 · MISS · scope=all

- 问题：「断网期间的改动怎么排」
- 备注：正文独有
- needed：project_lumen-sync.md [16-16] ✗

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | reference_lumen-shortcuts.md | 19-24 | 4.9897 | body | 0.4087 / 6.8794 / 1 / 2 |
| 2 | feedback_deploy-frozen.md | — | 0.1111 | description | —（摘要层无门槛） |

**诊断**：

- `reference_lumen-shortcuts.md` 正文门槛：✓ ratio 0.4087 ≥ 0.35；✓ sum 6.8794 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`的改` idf=4.50 tf=1 → 3.23；`改动` idf=2.38 tf=1 → 1.71
- 未命中线索：needed 不在 top-5；本次候选 2 条，正文门槛滤掉 25 条。

### c01 · MISS · scope=all

- 问题：「长度本身会不会影响排序」
- 备注：[lexfail] 词法失败边界：正文说的是「篇幅不再自带优势」，query 与正文无词面重合
- needed：project_ember-chunking.md [14-14] ✗
- 标记：已知词法边界（query 与原文没有词面重合）

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_orchard-ci.md | 19-23 | 7.2573 | body | 0.5881 / 8.2174 / 5 / 3 |
| 2 | reference_orchard-flags.md | 11-19 | 6.066 | body | 0.4053 / 5.6635 / 5 / 2 |
| 3 | reference_sourdough-starter.md | 17-24 | 6.0409 | body | 0.4053 / 5.6635 / 5 / 2 |
| 4 | project_quarry-noise-index.md | 40-42 | 5.949 | body | 0.4053 / 5.6635 / 5 / 2 |
| 5 | reference_lumen-shortcuts.md | 19-24 | 4.1112 | body | 0.4053 / 5.6635 / 5 / 2 |

**诊断**：

- `project_orchard-ci.md` 正文门槛：✓ ratio 0.5881 ≥ 0.35；✓ sum 8.2174 ≥ 1.5；✓ rarestDf 5 / 0.0373 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 3）：`影响` idf=2.46 tf=2 → 2.80；`会影` idf=3.20 tf=1 → 2.45；`不会` idf=2.55 tf=1 → 1.95
- `reference_orchard-flags.md` 正文门槛：✓ ratio 0.4053 ≥ 0.35；✓ sum 5.6635 ≥ 1.5；✓ rarestDf 5 / 0.0373 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`会影` idf=3.20 tf=1 → 3.41；`影响` idf=2.46 tf=1 → 2.62
- `reference_sourdough-starter.md` 正文门槛：✓ ratio 0.4053 ≥ 0.35；✓ sum 5.6635 ≥ 1.5；✓ rarestDf 5 / 0.0373 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`会影` idf=3.20 tf=2 → 3.39；`影响` idf=2.46 tf=2 → 2.61
- `project_quarry-noise-index.md` 正文门槛：✓ ratio 0.4053 ≥ 0.35；✓ sum 5.6635 ≥ 1.5；✓ rarestDf 5 / 0.0373 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`会影` idf=3.20 tf=1 → 3.34；`影响` idf=2.46 tf=1 → 2.57
- `reference_lumen-shortcuts.md` 正文门槛：✓ ratio 0.4053 ≥ 0.35；✓ sum 5.6635 ≥ 1.5；✓ rarestDf 5 / 0.0373 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`会影` idf=3.20 tf=1 → 2.30；`影响` idf=2.46 tf=1 → 1.77
- 未命中线索：needed 不在 top-5；本次候选 5 条，正文门槛滤掉 28 条。

### c02 · MISS · scope=all

- 问题：「睡着以后谁在替我收拾东西」
- 备注：[lexfail] 词法失败边界：正文说的是「设定时刻自动跑一遍，把重复条目并到一处」
- needed：project_ember-nightpass.md [13-13] ✗
- 标记：已知词法边界（query 与原文没有词面重合）

（没有命中）

**诊断**：

- 未命中线索：needed 不在 top-5；本次候选 0 条，正文门槛滤掉 6 条。

### c03 · MISS · scope=all

- 问题：「接触装着密钥的材料时，第一步该做什么」
- 备注：[lexfail] 词法失败边界：正文说的是「先只列键名」，与 query 用词完全不同
- needed：feedback_credential-habit.md [13-13] ✗
- 标记：已知词法边界（query 与原文没有词面重合）

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_ember-nightpass.md | 16-18 | 11.9632 | body | 0.6058 / 10.4549 / 1 / 2 |

**诊断**：

- `project_ember-nightpass.md` 正文门槛：✓ ratio 0.6058 ≥ 0.35；✓ sum 10.4549 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 3）：`做什` idf=4.50 tf=1 → 4.76；`一步` idf=3.65 tf=1 → 3.87；`什么` idf=2.30 tf=2 → 3.29
- 未命中线索：needed 不在 top-5；本次候选 1 条，正文门槛滤掉 26 条。

### c04 · MISS · scope=all

- 问题：「分块大小的上限是怎么定的」
- 备注：[lexfail] 词法失败边界：正文说的是「片长定在一段话说得完的量级」
- needed：project_ember-chunking.md [19-19] ✗
- 标记：已抑制（expired_source）：project_cobalt-quota.md, project_harbor-backpressure-superseded.md；已知词法边界（query 与原文没有词面重合）

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_cobalt-quota-revised.md | — | 0.0909 | description | —（摘要层无门槛） |

**诊断**：

- 未命中线索：needed 不在 top-5；本次候选 3 条，正文门槛滤掉 31 条。

### g02 · INJ · scope=all

- 问题：「帮我推荐一部电影」
- 备注：无关新问题：语料里没有影视内容
- needed：—
- 标记：无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | user_preferences-writing.md | 21-26 | 9.6147 | body | 0.6667 / 8.9996 / 1 / 2 |

**诊断**：

- `user_preferences-writing.md` 正文门槛：✓ ratio 0.6667 ≥ 0.35；✓ sum 8.9996 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`推荐` idf=4.50 tf=3 → 6.10；`荐一` idf=4.50 tf=1 → 3.45

### i01 · ALL · scope=all

- 问题：「潮汐任务的时间窗写死在哪」
- 备注：白名单：只有这三份潮汐笔记算在范围内
- needed：project_tide-scheduler.md [15-15] ✓@1
- 标记：白名单外：reference_birdwatching-log.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_tide-scheduler.md | 15-17 | 26.6504 | description+alias+body | 0.694 / 20.7648 / 1 / 5 |
| 2 | project_tide-failures.md | 15-19 | 14.6256 | description+alias+body | 0.4187 / 12.5273 / 3 / 3 |
| 3 | project_tide-window.md | 18-22 | 10.1353 | description+alias+body | 0.3736 / 11.1774 / 4 / 2 |
| 4 | reference_birdwatching-log.md | — | 0.0909 | description | —（摘要层无门槛） |

**诊断**：

- `project_tide-scheduler.md` 正文门槛：✓ ratio 0.694 ≥ 0.35；✓ sum 20.7648 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 5 ≥ 2（通过）
  - 词元贡献（前 6）：`窗写` idf=4.50 tf=1 → 5.53；`死在` idf=3.99 tf=1 → 4.90；`间窗` idf=3.40 tf=1 → 4.18；`写死` idf=3.40 tf=1 → 4.18；`潮汐` idf=2.65 tf=1 → 3.26；`任务` idf=1.36 tf=2 → 2.15
- `project_tide-failures.md` 正文门槛：✓ ratio 0.4187 ≥ 0.35；✓ sum 12.5273 ≥ 1.5；✓ rarestDf 3 / 0.0224 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 5）：`汐任` idf=3.65 tf=1 → 4.13；`间窗` idf=3.40 tf=1 → 3.85；`潮汐` idf=2.65 tf=1 → 3.00；`时间` idf=1.46 tf=1 → 1.65；`任务` idf=1.36 tf=1 → 1.54
- `project_tide-window.md` 正文门槛：✓ ratio 0.3736 ≥ 0.35；✓ sum 11.1774 ≥ 1.5；✓ rarestDf 4 / 0.0299 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 5）：`写死` idf=3.40 tf=1 → 2.79；`潮汐` idf=2.65 tf=1 → 2.18；`的时` idf=2.30 tf=1 → 1.89；`任务` idf=1.36 tf=2 → 1.63；`时间` idf=1.46 tf=1 → 1.19

### i02 · ALL · scope=all

- 问题：「果园构建的缓存目录是哪个」
- 备注：白名单：只有这三份果园构建笔记算在范围内
- needed：project_orchard-cache.md [13-13] ✓@1
- 标记：已抑制（expired_source）：project_orchard-timeout-superseded.md；白名单外：project_orchard-noise-log.md, reference_orchard-flags.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_orchard-cache.md | 18-22 | 18.3458 | description+alias+body | 0.4757 / 14.2925 / 5 / 3 |
| 2 | project_orchard-timeout.md | 22-25 | 17.4802 | description+alias+body | 0.5677 / 17.0577 / 5 / 4 |
| 3 | project_orchard-noise-log.md | — | 0.2727 | description+alias | —（摘要层无门槛） |
| 4 | reference_orchard-flags.md | 21-25 | 13.4019 | body | 0.3692 / 11.092 / 6 / 3 |

**诊断**：

- `project_orchard-cache.md` 正文门槛：✓ ratio 0.4757 ≥ 0.35；✓ sum 14.2925 ≥ 1.5；✓ rarestDf 5 / 0.0373 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 6）：`建的` idf=3.20 tf=2 → 3.87；`缓存` idf=2.30 tf=5 → 3.81；`目录` idf=2.38 tf=4 → 3.71；`存目` idf=3.03 tf=2 → 3.67；`构建` idf=1.75 tf=1 → 1.46；`果园` idf=1.63 tf=1 → 1.36
- `project_orchard-timeout.md` 正文门槛：✓ ratio 0.5677 ≥ 0.35；✓ sum 17.0577 ≥ 1.5；✓ rarestDf 5 / 0.0373 满足冷门判据；✓ run 4 ≥ 2（通过）
  - 词元贡献（前 6）：`缓存` idf=2.30 tf=3 → 3.33；`建的` idf=3.20 tf=1 → 2.74；`存目` idf=3.03 tf=1 → 2.60；`构建` idf=1.75 tf=3 → 2.53；`园构` idf=2.77 tf=1 → 2.37；`目录` idf=2.38 tf=1 → 2.04
- `reference_orchard-flags.md` 正文门槛：✓ ratio 0.3692 ≥ 0.35；✓ sum 11.092 ≥ 1.5；✓ rarestDf 6 / 0.0448 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 5）：`缓存` idf=2.30 tf=5 → 3.84；`存目` idf=3.03 tf=2 → 3.71；`目录` idf=2.38 tf=2 → 2.91；`构建` idf=1.75 tf=1 → 1.48；`果园` idf=1.63 tf=1 → 1.38

### i04 · ALL · scope=all

- 问题：「明灯的面板颜色变量在哪查」
- 备注：白名单：只有这三份明灯文档算在范围内
- needed：reference_lumen-theme-tokens.md [13-13] ✓@2
- 标记：白名单外：project_lumen-noise-dump.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_lumen-noise-dump.md | 17-19 | 15.3109 | description+alias+body | 0.5113 / 12.0566 / 2 / 2 |
| 2 | reference_lumen-theme-tokens.md | 22-26 | 13.1386 | description+alias+body | 0.5444 / 12.8357 / 1 / 2 |
| 3 | project_lumen-sync.md | — | 0.1818 | description+alias | —（摘要层无门槛） |
| 4 | reference_lumen-shortcuts.md | — | 0.0909 | description+alias | —（摘要层无门槛） |

**诊断**：

- `project_lumen-noise-dump.md` 正文门槛：✓ ratio 0.5113 ≥ 0.35；✓ sum 12.0566 ≥ 1.5；✓ rarestDf 2 / 0.0149 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 4）：`的面` idf=3.99 tf=1 → 4.68；`面板` idf=2.77 tf=2 → 4.23；`颜色` idf=3.20 tf=1 → 3.76；`明灯` idf=2.10 tf=1 → 2.47
- `reference_lumen-theme-tokens.md` 正文门槛：✓ ratio 0.5444 ≥ 0.35；✓ sum 12.8357 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 4）：`变量` idf=3.03 tf=5 → 4.96；`量在` idf=4.50 tf=1 → 3.64；`颜色` idf=3.20 tf=1 → 2.59；`明灯` idf=2.10 tf=1 → 1.70

### j01 · INJ · scope=all

- 问题：「上次检查完之后配置是谁改的」
- 备注：共享常用词：检查 / 配置 / 之后 在三份文件里都出现，但没有一份记录过「谁改了配置」
- needed：—
- 标记：黑名单命中：project_tide-window.md, feedback_review-checklist.md；无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_lantern-release.md | — | 0.0833 | description+alias | —（摘要层无门槛） |
| 2 | reference_harbor-config.md | — | 0.0833 | description+alias | —（摘要层无门槛） |
| 3 | project_tide-window.md | 18-22 | 6.4311 | body | 0.4043 / 7.7784 / 1 / 2 |
| 4 | feedback_review-checklist.md | — | 0.0833 | description | —（摘要层无门槛） |
| 5 | project_atlas-gateway.md | — | 0.0833 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `project_tide-window.md` 正文门槛：✓ ratio 0.4043 ≥ 0.35；✓ sum 7.7784 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 3）：`完之` idf=4.50 tf=1 → 3.69；`配置` idf=1.88 tf=1 → 1.55；`之后` idf=1.39 tf=1 → 1.14

### j02 · INJ · scope=all

- 问题：「之前那个版本是什么时候发布的」
- 备注：共享常用词：版本 / 发布 在灯笼发布清单里出现，但清单只写锚点与回滚步骤，没有发布日期；另两份只有「之前 / 什么时候」
- needed：—
- 标记：黑名单命中：project_lantern-release.md；无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_lantern-release.md | — | 0.0769 | description+alias | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。

### j03 · INJ · scope=all

- 问题：「这个问题的结论最后定了没有」
- 备注：共享常用词：问题 / 结论 在三份长文里反复出现，但没有一份写过「结论定了没有」
- needed：—
- 标记：黑名单命中：project_lumen-noise-dump.md；无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_lumen-noise-dump.md | 11-15 | 13.677 | body | 0.3817 / 11.5722 / 1 / 3 |

**诊断**：

- 误注入来自**正文路径**：下面是它通过证据门槛的现场数值。
- `project_lumen-noise-dump.md` 正文门槛：✓ ratio 0.3817 ≥ 0.35；✓ sum 11.5722 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 4）：`题的` idf=3.40 tf=2 → 4.68；`个问` idf=4.50 tf=1 → 4.50；`问题` idf=2.04 tf=2 → 2.81；`没有` idf=1.63 tf=1 → 1.63

### j04 · INJ · scope=all

- 问题：「一次完整的构建要跑多久」
- 备注：共享常用词：「一次完整的（全量）构建」在三份果园文件里都有，但没有一处写过构建耗时
- needed：—
- 标记：已抑制（expired_source）：project_orchard-timeout-superseded.md；黑名单命中：project_orchard-cache.md, project_orchard-timeout.md, reference_orchard-flags.md；无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_orchard-cache.md | 18-22 | 12.6796 | description+body | 0.7828 / 14.378 / 2 / 4 |
| 2 | project_orchard-timeout.md | 22-25 | 10.8902 | description+alias+body | 0.5656 / 10.389 / 3 / 3 |
| 3 | project_orchard-noise-log.md | — | 0.1 | description+alias | —（摘要层无门槛） |
| 4 | reference_orchard-flags.md | 21-25 | 12.769 | body | 0.7828 / 14.378 / 2 / 4 |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `project_orchard-cache.md` 正文门槛：✓ ratio 0.7828 ≥ 0.35；✓ sum 14.378 ≥ 1.5；✓ rarestDf 2 / 0.0149 满足冷门判据；✓ run 4 ≥ 2（通过）
  - 词元贡献（前 5）：`整的` idf=3.99 tf=1 → 3.32；`次完` idf=3.65 tf=1 → 3.04；`完整` idf=3.65 tf=1 → 3.04；`一次` idf=1.34 tf=2 → 1.61；`构建` idf=1.75 tf=1 → 1.46
- `project_orchard-timeout.md` 正文门槛：✓ ratio 0.5656 ≥ 0.35；✓ sum 10.389 ≥ 1.5；✓ rarestDf 3 / 0.0224 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 4）：`次完` idf=3.65 tf=1 → 3.13；`完整` idf=3.65 tf=1 → 3.13；`构建` idf=1.75 tf=3 → 2.53；`一次` idf=1.34 tf=3 → 1.93
- `reference_orchard-flags.md` 正文门槛：✓ ratio 0.7828 ≥ 0.35；✓ sum 14.378 ≥ 1.5；✓ rarestDf 2 / 0.0149 满足冷门判据；✓ run 4 ≥ 2（通过）
  - 词元贡献（前 5）：`整的` idf=3.99 tf=1 → 3.38；`次完` idf=3.65 tf=1 → 3.09；`完整` idf=3.65 tf=1 → 3.09；`一次` idf=1.34 tf=2 → 1.63；`构建` idf=1.75 tf=1 → 1.48

### j05 · INJ · scope=all

- 问题：「哪个文件里记了那次操作的检查结果」
- 备注：共享常用词：检查 / 结果 / 文件 都有，但没有一份记录过「那次操作的检查结果」
- needed：—
- 标记：无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | feedback_credential-habit.md | — | 0.0667 | description+alias | —（摘要层无门槛） |
| 2 | project_lantern-release.md | — | 0.0667 | description+alias | —（摘要层无门槛） |
| 3 | reference_harbor-config.md | — | 0.0667 | description+alias | —（摘要层无门槛） |
| 4 | project_ember-nightpass.md | — | 0.1333 | description | —（摘要层无门槛） |
| 5 | feedback_review-checklist.md | — | 0.0667 | description | —（摘要层无门槛） |

**诊断**：


### j06 · INJ · scope=all

- 问题：「之前改过的参数是不是配错了」
- 备注：共享常用词：参数 / 之前 / 不是 都有，但没有一处写过参数被配错
- needed：—
- 标记：黑名单命中：reference_orchard-flags.md；无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | reference_orchard-flags.md | — | 0.0833 | description+alias | —（摘要层无门槛） |
| 2 | project_tide-failures.md | — | 0.0833 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。

### j07 · INJ · scope=all

- 问题：「那次操作是什么时候做的」
- 备注：共享常用词：什么时候 / 那次 都有（冻结点、晚间自动动作、重试高峰），但没有具体钟点
- needed：—
- 标记：黑名单命中：feedback_deploy-frozen.md, project_ember-nightpass.md；无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | feedback_deploy-frozen.md | 20-25 | 7.6571 | body | 0.4351 / 10.0029 / 1 / 3 |
| 2 | project_ember-nightpass.md | — | 0.1 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `feedback_deploy-frozen.md` 正文门槛：✓ ratio 0.4351 ≥ 0.35；✓ sum 10.0029 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 3）：`么时` idf=4.50 tf=1 → 3.42；`时候` idf=3.20 tf=1 → 2.43；`什么` idf=2.30 tf=1 → 1.75

### j08 · INJ · scope=all

- 问题：「检查配置的时候有没有发现对不上的地方」
- 备注：共享常用词：检查 / 配置 / 发现 都有，但没有一次「检查配置」的记录；「对不上」只出现在配额账单的语境里
- needed：—
- 标记：黑名单命中：feedback_review-checklist.md；无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_lantern-release.md | — | 0.0588 | description+alias | —（摘要层无门槛） |
| 2 | reference_harbor-config.md | — | 0.0588 | description+alias | —（摘要层无门槛） |
| 3 | feedback_review-checklist.md | — | 0.0588 | description | —（摘要层无门槛） |
| 4 | project_atlas-gateway.md | — | 0.0588 | description | —（摘要层无门槛） |
| 5 | project_atlas-ingest.md | — | 0.0588 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。

### k01 · ALL · scope=all

- 问题：「Atlas 摄取管线的单批最大条数是多少」
- 备注：同名不同项目：两份文件的 description 都含 Atlas、都有配置 / 失败处理 / 限制三段，只有「摄取」把范围收到 A
- needed：project_atlas-ingest.md [15-15] ✓@1
- 标记：黑名单命中：project_atlas-gateway.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_atlas-ingest.md | 11-16 | 52.2872 | description+alias+filename+body | 0.8117 / 38.7844 / 1 / 6 |
| 2 | project_atlas-gateway.md | — | 0.2222 | description+alias+filename | —（摘要层无门槛） |
| 3 | project_orchard-noise-log.md | — | 0.0556 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `project_atlas-ingest.md` 正文门槛：✓ ratio 0.8117 ≥ 0.35；✓ sum 38.7844 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 6 ≥ 2（通过）
  - 词元贡献（前 6）：`摄取` idf=3.65 tf=3 → 6.26；`取管` idf=3.65 tf=2 → 5.63；`管线` idf=3.65 tf=2 → 5.63；`批最` idf=4.50 tf=1 → 5.34；`最大` idf=4.50 tf=1 → 5.34；`大条` idf=4.50 tf=1 → 5.34

### k02 · ALL · scope=all

- 问题：「Atlas 摄取侧失败之后怎么重放」
- 备注：同名不同项目：两份都有「失败处理」段落且都出现「失败」，A 讲重放队列、B 讲换后端
- needed：project_atlas-ingest.md [20-20] ✓@1
- 标记：黑名单命中：project_atlas-gateway.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_atlas-ingest.md | 23-30 | 20.189 | description+alias+filename+body | 0.8095 / 16.9466 / 2 / 3 |
| 2 | project_atlas-gateway.md | — | 0.3333 | description+alias+filename | —（摘要层无门槛） |
| 3 | project_tide-failures.md | — | 0.0667 | description+alias | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `project_atlas-ingest.md` 正文门槛：✓ ratio 0.8095 ≥ 0.35；✓ sum 16.9466 ≥ 1.5；✓ rarestDf 2 / 0.0149 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 6）：`摄取` idf=3.65 tf=4 → 5.37；`取侧` idf=3.99 tf=3 → 5.28；`重放` idf=2.89 tf=4 → 4.25；`atlas` idf=3.03 tf=1 → 2.23；`失败` idf=1.99 tf=1 → 1.46；`之后` idf=1.39 tf=1 → 1.03

### k03 · ALL · scope=all

- 问题：「Atlas 摄取侧的硬限制有哪些」
- 备注：同名不同项目：两份都有「限制」段落且都写「硬限制」，A 是单批条数、B 是每秒请求数
- needed：project_atlas-ingest.md [26-26] ✓@1
- 标记：已抑制（expired_source）：project_cobalt-quota.md；黑名单命中：project_atlas-gateway.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_atlas-ingest.md | 23-30 | 24.0582 | description+alias+filename+body | 1 / 20.6779 / 2 / 4 |
| 2 | project_atlas-gateway.md | 23-30 | 12.6963 | description+alias+filename+body | 0.6305 / 13.0364 / 4 / 2 |
| 3 | project_cobalt-quota-revised.md | 26-27 | 11.6188 | body | 0.4837 / 10.0029 / 4 / 2 |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `project_atlas-ingest.md` 正文门槛：✓ ratio 1 ≥ 0.35；✓ sum 20.6779 ≥ 1.5；✓ rarestDf 2 / 0.0149 满足冷门判据；✓ run 4 ≥ 2（通过）
  - 词元贡献（前 6）：`摄取` idf=3.65 tf=4 → 5.37；`取侧` idf=3.99 tf=3 → 5.28；`限制` idf=3.20 tf=3 → 4.23；`侧的` idf=3.40 tf=2 → 3.75；`硬限` idf=3.40 tf=1 → 2.50；`atlas` idf=3.03 tf=1 → 2.23
- `project_atlas-gateway.md` 正文门槛：✓ ratio 0.6305 ≥ 0.35；✓ sum 13.0364 ≥ 1.5；✓ rarestDf 4 / 0.0299 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 4）：`限制` idf=3.20 tf=3 → 4.42；`侧的` idf=3.40 tf=1 → 2.69；`硬限` idf=3.40 tf=1 → 2.69；`atlas` idf=3.03 tf=1 → 2.40
- `project_cobalt-quota-revised.md` 正文门槛：✓ ratio 0.4837 ≥ 0.35；✓ sum 10.0029 ≥ 1.5；✓ rarestDf 4 / 0.0299 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 3）：`侧的` idf=3.40 tf=1 → 3.93；`硬限` idf=3.40 tf=1 → 3.93；`限制` idf=3.20 tf=1 → 3.70

### k04 · INJ · scope=all

- 问题：「Atlas 这个代号的项目是谁负责的」
- 备注：同名不同项目 + 无答案：两份 Atlas 文件都没写负责人，问句越不过「代号相同」这一层
- needed：—
- 标记：黑名单命中：project_atlas-ingest.md, project_atlas-gateway.md；无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_atlas-gateway.md | — | 0.25 | description+alias+filename | —（摘要层无门槛） |
| 2 | project_atlas-ingest.md | — | 0.25 | description+alias+filename | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。

### k05 · INJ · scope=all

- 问题：「Atlas 项目的预算是多少」
- 备注：同名不同项目 + 无答案：两份都只写技术口径，没有预算数字
- needed：—
- 标记：已抑制（expired_source）：project_cobalt-quota.md；黑名单命中：project_atlas-ingest.md, project_atlas-gateway.md；无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_atlas-ingest.md | 23-30 | 10.9172 | description+alias+filename+body | 0.5721 / 12.0331 / 1 / 2 |
| 2 | project_atlas-gateway.md | — | 0.3333 | description+alias+filename | —（摘要层无门槛） |
| 3 | project_ember-nightpass.md | — | 0.25 | description+filename | —（摘要层无门槛） |
| 4 | project_cobalt-quota-revised.md | — | 0.1667 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `project_atlas-ingest.md` 正文门槛：✓ ratio 0.5721 ≥ 0.35；✓ sum 12.0331 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 3）：`预算` idf=4.50 tf=2 → 4.96；`算是` idf=4.50 tf=1 → 3.31；`atlas` idf=3.03 tf=1 → 2.23

### k06 · INJ · scope=all

- 问题：「Atlas 是什么时候上线的」
- 备注：同名不同项目 + 无答案：两份都没有上线时间，metadata.updated 只是改写日期
- needed：—
- 标记：黑名单命中：project_atlas-ingest.md, project_atlas-gateway.md；无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_atlas-ingest.md | — | 0.4167 | description+alias+filename | —（摘要层无门槛） |
| 2 | project_atlas-gateway.md | — | 0.3333 | description+alias+filename | —（摘要层无门槛） |
| 3 | feedback_deploy-frozen.md | 20-25 | 7.6721 | body | 0.3844 / 10.0029 / 1 / 3 |
| 4 | project_orchard-noise-log.md | — | 0.0833 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `feedback_deploy-frozen.md` 正文门槛：✓ ratio 0.3844 ≥ 0.35；✓ sum 10.0029 ≥ 1.5；✓ rarestDf 1 / 0.0075 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 3）：`么时` idf=4.50 tf=1 → 3.42；`时候` idf=3.20 tf=1 → 2.43；`什么` idf=2.30 tf=1 → 1.75

## 口径说明

- **Precision@k 是下界**：相关集取「标注 needed ∪ allowFiles」；合成语料里未标注但相关的文件不会计入分子。
- **注入字节**用候选片段字节代理；真实注入还受单场会话预算裁切（契约 2.5，软上限）。
- **失效抑制**：注入前先按 `invalid_at`（评测时钟固定为 2026-10-31T16:00:00.000Z）判 `expired_source`；被抑制的命中仍占检索候选位次，但不计入注入、也不计入误注入。误注入归零时请对照难负例表里的「被抑制 / 旧版被抑制」列，别把抑制当成检索变好了。
- **黑名单主指标**按「有黑名单检查的题」计，不按检查项计；本版是 17/91 题、检查项 268 个。
- **摘要层没有 evidence 门槛**是有意设计（摘要只有一句话，词面重合已经是较强信号）；代价是共享常用词的记忆会被误注入，这正是 1.7.2 难负例扩容要压的。

## 复现

```powershell
node scripts/eval-retrieval.mjs --mode all --limit 5 --per-file 2 --baseline test/eval/baseline.json --report docs/retrieval-diagnostics.md
```
