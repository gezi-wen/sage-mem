---
name: cobalt-retention
description: Cobalt 项目的日志保留口径，含原始日志与聚合指标的期限
aliases: [Cobalt 保留, cobalt retention, 日志保留]
invalid_at: 2026-09-18T00:00:00+08:00
superseded_by: project_cobalt-retention-revised.md
metadata:
  node_type: memory
  type: project
  updated: 2026-05-20
---

# Cobalt 日志保留

原始日志保留 30 天，到期后按天批量删除，删除不可恢复。
聚合指标保留 400 天，超过之后只留下月级的汇总，明细不再保留。

保留策略按数据类型分别配置，不改动归档本身的存储位置。
需要更长的保留期要在申请里写明用途，默认不给长期保留。

保留期按天计算，不足一天的按一天算，跨月的按当月天数折算。
期限变更从下一天开始生效，已经写入的数据仍按变更前的期限处理。
保留策略每年复核一次，复核只改期限，不改数据类型。

删除任务每天凌晨跑一次，跑之前先生成一份待删清单，清单留七天备查。
保留天数从写入当天开始算，不从日志产生的时间算，这一点在跨时区时尤其要留意。
