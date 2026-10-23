# 检索诊断报告

> 由 `scripts/eval-retrieval.mjs --report` 生成，**不要手改**。
> 生成时间：2026-10-23T15:52:40.772Z；mode=all，limit=5，per-file=2。

## 运行信息

- 语料：30 份；问题集：79 题；语料指纹 `637913e49b54`，题号指纹 `72c65df645a3`。
- 误注入（主指标）：4/71 道有黑名单检查的题；检查项共 229 个。
- 白名单外：4/4 道有白名单检查的题。
- 无答案题：仍注入 1/10，拒绝率 90.0%。
- 基线比较：compared

## 指标（含诊断口径）

| 指标 | 值 |
|---|---|
| Recall@k（任一命中） | 60/69 = 87.0% |
| 全中率（全部 needed） | 58/69 = 84.1% |
| 条目级召回 | 67/81 = 82.7% |
| 段落命中（严格） | 30/47 = 63.8% |
| MRR | 0.7693（Σ1/rank = 53.0833 / 69） |
| 误注入率（主指标） | 4/71 = 5.6% |
| 白名单外误注入 | 4/4 = 100.0% |
| 无答案题拒绝率 | 9/10 = 90.0% |
| Precision@k（标注相关集·下界） | 75/203 = 36.9%（可评题 66） |
| 注入字节（候选片段代理） | 10939 总 / 138.5 平均每题 |
| 延迟 p50 / p95 | 0.902 ms / 1.521 ms |

## 逐案例

触发诊断的题：17 道（误注入 / 白名单外 / 无答案注入 / 词法边界 / MISS）。

### a08 · ALL · scope=all

- 问题：「潮汐定时任务的时间窗与幂等约定」
- 备注：摘要直命中
- needed：project_tide-scheduler.md ✓@1
- 标记：黑名单命中：reference_birdwatching-log.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_tide-scheduler.md | 11-13 | 55.0301 | description+alias+body | 0.8751 / 36.1633 / 1 / 7 |
| 2 | project_tide-failures.md | — | 0.2143 | description+alias | —（摘要层无门槛） |
| 3 | project_tide-window.md | — | 0.2143 | description+alias | —（摘要层无门槛） |
| 4 | reference_birdwatching-log.md | — | 0.0714 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `project_tide-scheduler.md` 正文门槛：✓ ratio 0.8751 ≥ 0.35；✓ sum 36.1633 ≥ 1.5；✓ rarestDf 1 / 0.0096 满足冷门判据；✓ run 7 ≥ 2（通过）
  - 词元贡献（前 6）：`窗与` idf=4.25 tf=1 → 5.85；`等约` idf=4.25 tf=1 → 5.85；`汐定` idf=3.15 tf=2 → 5.33；`时任` idf=3.15 tf=2 → 5.33；`与幂` idf=3.74 tf=1 → 5.14；`定时` idf=2.95 tf=2 → 4.99

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
| 1 | project_lumen-sync.md | 21-25 | 9.6105 | description+body | 0.3501 / 10.6252 / 1 / 3 |
| 2 | reference_sagemem-frontmatter.md | — | 0.0769 | description+alias | —（摘要层无门槛） |
| 3 | project_harbor-backpressure.md | — | 0.0769 | description | —（摘要层无门槛） |
| 4 | reference_harbor-config.md | — | 0.0769 | description | —（摘要层无门槛） |
| 5 | reference_lumen-shortcuts.md | — | 0.0769 | description | —（摘要层无门槛） |

**诊断**：

- `project_lumen-sync.md` 正文门槛：✓ ratio 0.3501 ≥ 0.35；✓ sum 10.6252 ≥ 1.5；✓ rarestDf 1 / 0.0096 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 3）：`哪个` idf=4.25 tf=1 → 3.29；`个字` idf=4.25 tf=1 → 3.29；`字段` idf=2.13 tf=3 → 2.90
- 未命中线索：needed 不在 top-5；本次候选 5 条，正文门槛滤掉 48 条。

### b12 · MISS · scope=all

- 问题：「命名要写清什么才算合格」
- 备注：正文独有：第 1 条在正文第 13 行
- needed：feedback_review-checklist.md [13-13] ✗
- 标记：黑名单命中：reference_birdwatching-log.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | feedback_deploy-frozen.md | 20-25 | 6.6174 | body | 0.5112 / 8.351 / 4 / 2 |
| 2 | reference_harbor-metrics.md | 21-25 | 5.4313 | body | 0.3856 / 6.2998 / 4 / 2 |
| 3 | reference_birdwatching-log.md | 17-23 | 4.4557 | body | 0.3856 / 6.2998 / 4 / 2 |

**诊断**：

- 误注入来自**正文路径**：下面是它通过证据门槛的现场数值。
- `feedback_deploy-frozen.md` 正文门槛：✓ ratio 0.5112 ≥ 0.35；✓ sum 8.351 ≥ 1.5；✓ rarestDf 4 / 0.0385 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 3）：`要写` idf=3.15 tf=1 → 2.47；`写清` idf=3.15 tf=1 → 2.47；`什么` idf=2.05 tf=1 → 1.61
- `reference_harbor-metrics.md` 正文门槛：✓ ratio 0.3856 ≥ 0.35；✓ sum 6.2998 ≥ 1.5；✓ rarestDf 4 / 0.0385 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`要写` idf=3.15 tf=1 → 2.70；`写清` idf=3.15 tf=1 → 2.70
- `reference_birdwatching-log.md` 正文门槛：✓ ratio 0.3856 ≥ 0.35；✓ sum 6.2998 ≥ 1.5；✓ rarestDf 4 / 0.0385 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`要写` idf=3.15 tf=1 → 2.21；`写清` idf=3.15 tf=1 → 2.21
- 未命中线索：needed 不在 top-5；本次候选 3 条，正文门槛滤掉 14 条。

### b14 · ALL · scope=all

- 问题：「和备份重叠时让出多少时间」
- 备注：正文独有
- needed：project_tide-window.md [14-14] ✓@2
- 标记：黑名单命中：reference_birdwatching-log.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_tide-scheduler.md | — | 0.0909 | description+alias | —（摘要层无门槛） |
| 2 | project_tide-window.md | 11-16 | 16.803 | body | 0.9203 / 15.4615 / 1 / 2 |
| 3 | reference_birdwatching-log.md | — | 0.0909 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `project_tide-window.md` 正文门槛：✓ ratio 0.9203 ≥ 0.35；✓ sum 15.4615 ≥ 1.5；✓ rarestDf 1 / 0.0096 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 4）：`备份` idf=3.74 tf=2 → 4.77；`重叠` idf=3.74 tf=2 → 4.77；`叠时` idf=4.25 tf=1 → 3.82；`让出` idf=3.74 tf=1 → 3.36

### b15 · ALL · scope=all

- 问题：「手写日期和系统时间冲突时听谁的」
- 备注：正文独有：摘要只列字段名
- needed：reference_sagemem-frontmatter.md [17-17] ✓@3
- 标记：黑名单命中：reference_birdwatching-log.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_lumen-sync.md | — | 0.0714 | description+alias | —（摘要层无门槛） |
| 2 | project_tide-scheduler.md | — | 0.0714 | description+alias | —（摘要层无门槛） |
| 3 | reference_sagemem-frontmatter.md | 11-17 | 16.3935 | body | 0.5165 / 14.0853 / 1 / 3 |
| 4 | reference_birdwatching-log.md | — | 0.0714 | description | —（摘要层无门槛） |

**诊断**：

- 误注入中有**摘要层**命中：`summary` 路径（description / alias / filename）**没有 evidence 门槛**，词面重合就入选 —— 这是「共享常用词」误注入的直接原因。
- `reference_sagemem-frontmatter.md` 正文门槛：✓ ratio 0.5165 ≥ 0.35；✓ sum 14.0853 ≥ 1.5；✓ rarestDf 1 / 0.0096 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 4）：`手写` idf=4.25 tf=1 → 4.93；`写日` idf=4.25 tf=1 → 4.93；`日期` idf=4.25 tf=1 → 4.93；`时间` idf=1.34 tf=1 → 1.55

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

- 未命中线索：needed 不在 top-5；本次候选 3 条，正文门槛滤掉 48 条。

### b19 · MISS · scope=all

- 问题：「断网期间的改动怎么排」
- 备注：正文独有
- needed：project_lumen-sync.md [16-16] ✗

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | reference_lumen-shortcuts.md | 19-24 | 4.9204 | body | 0.4107 / 6.5511 / 1 / 2 |
| 2 | feedback_deploy-frozen.md | — | 0.1111 | description | —（摘要层无门槛） |

**诊断**：

- `reference_lumen-shortcuts.md` 正文门槛：✓ ratio 0.4107 ≥ 0.35；✓ sum 6.5511 ≥ 1.5；✓ rarestDf 1 / 0.0096 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`的改` idf=4.25 tf=1 → 3.16；`改动` idf=2.30 tf=1 → 1.71
- 未命中线索：needed 不在 top-5；本次候选 2 条，正文门槛滤掉 22 条。

### c01 · MISS · scope=all

- 问题：「长度本身会不会影响排序」
- 备注：[lexfail] 词法失败边界：正文说的是「篇幅不再自带优势」，query 与正文无词面重合
- needed：project_ember-chunking.md [14-14] ✗
- 标记：已知词法边界（query 与原文没有词面重合）

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_orchard-ci.md | 19-23 | 7.1569 | body | 0.5664 / 7.8909 / 5 / 3 |
| 2 | reference_sourdough-starter.md | 17-24 | 5.7563 | body | 0.377 / 5.2518 / 5 / 2 |
| 3 | reference_orchard-flags.md | 11-19 | 5.7541 | body | 0.377 / 5.2518 / 5 / 2 |
| 4 | project_quarry-noise-index.md | 40-42 | 5.6473 | body | 0.377 / 5.2518 / 5 / 2 |
| 5 | reference_lumen-shortcuts.md | 19-24 | 3.9489 | body | 0.377 / 5.2518 / 5 / 2 |

**诊断**：

- `project_orchard-ci.md` 正文门槛：✓ ratio 0.5664 ≥ 0.35；✓ sum 7.8909 ≥ 1.5；✓ rarestDf 5 / 0.0481 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 3）：`影响` idf=2.30 tf=2 → 2.68；`会影` idf=2.95 tf=1 → 2.33；`不会` idf=2.64 tf=1 → 2.09
- `reference_sourdough-starter.md` 正文门槛：✓ ratio 0.377 ≥ 0.35；✓ sum 5.2518 ≥ 1.5；✓ rarestDf 5 / 0.0481 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`会影` idf=2.95 tf=2 → 3.21；`影响` idf=2.30 tf=2 → 2.51
- `reference_orchard-flags.md` 正文门槛：✓ ratio 0.377 ≥ 0.35；✓ sum 5.2518 ≥ 1.5；✓ rarestDf 5 / 0.0481 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`会影` idf=2.95 tf=1 → 3.21；`影响` idf=2.30 tf=1 → 2.51
- `project_quarry-noise-index.md` 正文门槛：✓ ratio 0.377 ≥ 0.35；✓ sum 5.2518 ≥ 1.5；✓ rarestDf 5 / 0.0481 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`会影` idf=2.95 tf=1 → 3.15；`影响` idf=2.30 tf=1 → 2.46
- `reference_lumen-shortcuts.md` 正文门槛：✓ ratio 0.377 ≥ 0.35；✓ sum 5.2518 ≥ 1.5；✓ rarestDf 5 / 0.0481 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`会影` idf=2.95 tf=1 → 2.20；`影响` idf=2.30 tf=1 → 1.71
- 未命中线索：needed 不在 top-5；本次候选 5 条，正文门槛滤掉 20 条。

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
| 1 | project_ember-nightpass.md | 16-18 | 11.3008 | body | 0.6034 / 9.701 / 1 / 2 |

**诊断**：

- `project_ember-nightpass.md` 正文门槛：✓ ratio 0.6034 ≥ 0.35；✓ sum 9.701 ≥ 1.5；✓ rarestDf 1 / 0.0096 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 3）：`做什` idf=4.25 tf=1 → 4.60；`一步` idf=3.40 tf=1 → 3.68；`什么` idf=2.05 tf=2 → 2.98
- 未命中线索：needed 不在 top-5；本次候选 1 条，正文门槛滤掉 25 条。

### c04 · MISS · scope=all

- 问题：「分块大小的上限是怎么定的」
- 备注：[lexfail] 词法失败边界：正文说的是「片长定在一段话说得完的量级」
- needed：project_ember-chunking.md [19-19] ✗
- 标记：已知词法边界（query 与原文没有词面重合）

（没有命中）

**诊断**：

- 未命中线索：needed 不在 top-5；本次候选 0 条，正文门槛滤掉 19 条。

### g02 · INJ · scope=all

- 问题：「帮我推荐一部电影」
- 备注：无关新问题：语料里没有影视内容
- needed：—
- 标记：无答案题仍注入

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | user_preferences-writing.md | 21-26 | 9.3028 | body | 0.6667 / 8.497 / 1 / 2 |

**诊断**：

- `user_preferences-writing.md` 正文门槛：✓ ratio 0.6667 ≥ 0.35；✓ sum 8.497 ≥ 1.5；✓ rarestDf 1 / 0.0096 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 2）：`推荐` idf=4.25 tf=3 → 5.87；`荐一` idf=4.25 tf=1 → 3.37

### i01 · ALL · scope=all

- 问题：「潮汐任务的时间窗写死在哪」
- 备注：白名单：只有这三份潮汐笔记算在范围内
- needed：project_tide-scheduler.md [15-15] ✓@1
- 标记：白名单外：reference_birdwatching-log.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_tide-scheduler.md | 15-17 | 25.1509 | description+alias+body | 0.6923 / 19.2646 / 1 / 5 |
| 2 | project_tide-failures.md | 15-19 | 13.7594 | description+alias+body | 0.4143 / 11.5298 / 3 / 3 |
| 3 | project_tide-window.md | 18-22 | 9.6702 | description+alias+body | 0.3716 / 10.3402 / 4 / 2 |
| 4 | reference_birdwatching-log.md | — | 0.0909 | description | —（摘要层无门槛） |

**诊断**：

- `project_tide-scheduler.md` 正文门槛：✓ ratio 0.6923 ≥ 0.35；✓ sum 19.2646 ≥ 1.5；✓ rarestDf 1 / 0.0096 满足冷门判据；✓ run 5 ≥ 2（通过）
  - 词元贡献（前 6）：`窗写` idf=4.25 tf=1 → 5.30；`死在` idf=3.74 tf=1 → 4.67；`间窗` idf=3.15 tf=1 → 3.93；`写死` idf=3.15 tf=1 → 3.93；`潮汐` idf=2.40 tf=1 → 3.00；`任务` idf=1.24 tf=2 → 1.97
- `project_tide-failures.md` 正文门槛：✓ ratio 0.4143 ≥ 0.35；✓ sum 11.5298 ≥ 1.5；✓ rarestDf 3 / 0.0288 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 5）：`汐任` idf=3.40 tf=1 → 3.92；`间窗` idf=3.15 tf=1 → 3.63；`潮汐` idf=2.40 tf=1 → 2.77；`时间` idf=1.34 tf=1 → 1.55；`任务` idf=1.24 tf=1 → 1.43
- `project_tide-window.md` 正文门槛：✓ ratio 0.3716 ≥ 0.35；✓ sum 10.3402 ≥ 1.5；✓ rarestDf 4 / 0.0385 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 5）：`写死` idf=3.15 tf=1 → 2.67；`潮汐` idf=2.40 tf=1 → 2.03；`的时` idf=2.21 tf=1 → 1.87；`任务` idf=1.24 tf=2 → 1.51；`时间` idf=1.34 tf=1 → 1.13

### i02 · ALL · scope=all

- 问题：「果园构建的缓存目录是哪个」
- 备注：白名单：只有这三份果园构建笔记算在范围内
- needed：project_orchard-cache.md [13-13] ✓@1
- 标记：白名单外：project_orchard-noise-log.md, reference_orchard-flags.md, reference_lumen-shortcuts.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_orchard-cache.md | 18-22 | 18.6083 | description+alias+body | 0.4787 / 14.1284 / 4 / 3 |
| 2 | project_orchard-timeout.md | 21-24 | 18.1308 | description+alias+body | 0.5854 / 17.2783 / 4 / 4 |
| 3 | project_orchard-noise-log.md | — | 0.2727 | description+alias | —（摘要层无门槛） |
| 4 | reference_orchard-flags.md | 21-25 | 13.6395 | body | 0.372 / 10.9785 / 5 / 3 |
| 5 | reference_lumen-shortcuts.md | — | 0.0909 | description | —（摘要层无门槛） |

**诊断**：

- `project_orchard-cache.md` 正文门槛：✓ ratio 0.4787 ≥ 0.35；✓ sum 14.1284 ≥ 1.5；✓ rarestDf 4 / 0.0385 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 6）：`缓存` idf=2.40 tf=5 → 4.03；`建的` idf=3.15 tf=2 → 3.89；`目录` idf=2.40 tf=4 → 3.80；`存目` idf=2.95 tf=2 → 3.64；`构建` idf=1.68 tf=1 → 1.45；`果园` idf=1.54 tf=1 → 1.32
- `project_orchard-timeout.md` 正文门槛：✓ ratio 0.5854 ≥ 0.35；✓ sum 17.2783 ≥ 1.5；✓ rarestDf 4 / 0.0385 满足冷门判据；✓ run 4 ≥ 2（通过）
  - 词元贡献（前 6）：`缓存` idf=2.40 tf=3 → 3.53；`园构` idf=3.15 tf=1 → 2.78；`建的` idf=3.15 tf=1 → 2.78；`存目` idf=2.95 tf=1 → 2.60；`构建` idf=1.68 tf=3 → 2.47；`目录` idf=2.40 tf=1 → 2.12
- `reference_orchard-flags.md` 正文门槛：✓ ratio 0.372 ≥ 0.35；✓ sum 10.9785 ≥ 1.5；✓ rarestDf 5 / 0.0481 满足冷门判据；✓ run 3 ≥ 2（通过）
  - 词元贡献（前 5）：`缓存` idf=2.40 tf=5 → 4.05；`存目` idf=2.95 tf=2 → 3.68；`目录` idf=2.40 tf=2 → 3.00；`构建` idf=1.68 tf=1 → 1.47；`果园` idf=1.54 tf=1 → 1.34

### i03 · ALL · scope=all

- 问题：「港口调度的失败任务落在哪」
- 备注：白名单：允许跨到潮汐的失败处理，因为它同名
- needed：reference_harbor-config.md [18-18] ✓@1
- 标记：白名单外：reference_harbor-metrics.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | reference_harbor-config.md | 15-18 | 13.5747 | description+alias+body | 0.5808 / 9.0761 / 2 / 4 |
| 2 | project_harbor-backpressure.md | — | 0.2727 | description+alias | —（摘要层无门槛） |
| 3 | project_harbor-noise-notes.md | — | 0.2727 | description+alias | —（摘要层无门槛） |
| 4 | project_tide-failures.md | — | 0.2727 | description+alias | —（摘要层无门槛） |
| 5 | reference_harbor-metrics.md | — | 0.2727 | description+alias | —（摘要层无门槛） |

**诊断**：

- `reference_harbor-config.md` 正文门槛：✓ ratio 0.5808 ≥ 0.35；✓ sum 9.0761 ≥ 1.5；✓ rarestDf 2 / 0.0192 满足冷门判据；✓ run 4 ≥ 2（通过）
  - 词元贡献（前 4）：`度的` idf=3.74 tf=1 → 5.24；`调度` idf=1.63 tf=2 → 2.80；`口调` idf=1.91 tf=1 → 2.68；`港口` idf=1.79 tf=1 → 2.51

### i04 · ALL · scope=all

- 问题：「明灯的面板颜色变量在哪查」
- 备注：白名单：只有这三份明灯文档算在范围内
- needed：reference_lumen-theme-tokens.md [13-13] ✓@2
- 标记：白名单外：project_lumen-noise-dump.md

| # | 文件 | 行 | 分数 | 命中层 | evidence（ratio / sum / rarestDf / run） |
|---|---|---|---|---|---|
| 1 | project_lumen-noise-dump.md | 17-19 | 14.2725 | description+alias+body | 0.5065 / 11.0514 / 2 / 2 |
| 2 | reference_lumen-theme-tokens.md | 22-26 | 12.4105 | description+alias+body | 0.5422 / 11.8305 / 1 / 2 |
| 3 | project_lumen-sync.md | — | 0.1818 | description+alias | —（摘要层无门槛） |
| 4 | reference_lumen-shortcuts.md | — | 0.0909 | description+alias | —（摘要层无门槛） |

**诊断**：

- `project_lumen-noise-dump.md` 正文门槛：✓ ratio 0.5065 ≥ 0.35；✓ sum 11.0514 ≥ 1.5；✓ rarestDf 2 / 0.0192 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 4）：`的面` idf=3.74 tf=1 → 4.47；`面板` idf=2.51 tf=2 → 3.90；`颜色` idf=2.95 tf=1 → 3.53；`明灯` idf=1.85 tf=1 → 2.21
- `reference_lumen-theme-tokens.md` 正文门槛：✓ ratio 0.5422 ≥ 0.35；✓ sum 11.8305 ≥ 1.5；✓ rarestDf 1 / 0.0096 满足冷门判据；✓ run 2 ≥ 2（通过）
  - 词元贡献（前 4）：`变量` idf=2.78 tf=5 → 4.61；`量在` idf=4.25 tf=1 → 3.54；`颜色` idf=2.95 tf=1 → 2.46；`明灯` idf=1.85 tf=1 → 1.54

## 口径说明

- **Precision@k 是下界**：相关集取「标注 needed ∪ allowFiles」；合成语料里未标注但相关的文件不会计入分子。
- **注入字节**用候选片段字节代理；真实注入还受单场会话预算裁切（契约 2.5，软上限）。
- **黑名单主指标**按「有黑名单检查的题」计，不按检查项计；71 是题数，检查项是 229（2026-10-23 审查口径纠正）。
- **摘要层没有 evidence 门槛**是有意设计（摘要只有一句话，词面重合已经是较强信号）；代价是共享常用词的记忆会被误注入，这正是 1.7.1 难负例扩容要压的。

## 复现

```powershell
node scripts/eval-retrieval.mjs --mode all --limit 5 --per-file 2 --baseline test/eval/baseline.json --report docs/retrieval-diagnostics.md
```
