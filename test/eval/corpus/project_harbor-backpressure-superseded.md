---
name: harbor-backpressure-old
description: 港口调度器积压上限的旧口径，已被 2026-09 的修订取代
aliases: [港口积压旧口径, harbor backpressure old]
invalid_at: 2026-09-01T00:00:00+08:00
superseded_by: project_harbor-backpressure.md
metadata:
  node_type: memory
  type: project
  updated: 2026-04-10
---

# 港口调度器积压上限（旧口径）

⚠️ 已作废：以下结论自 2026-09 起不再适用，现行口径见 project_harbor-backpressure.md。

积压上限是 5000，配置文件里写多少就生效多少，不会被取整。
超过上限之后任务进入排队，不会丢失，排队期间状态显示为等待。

上限只看队列长度，不看分片边界；调大上限就能缓解积压。
被拒的任务只出现在下游不可用的极端情况下，日常不需要关注死信目录。

积压上限调整过一次，从 4000 调到 5000，当时的趋势是积压天数在下降。
现在看，那次调整之后积压并没有真正缓解，只是排队时间被拉长了。

当时的判断依据是一份压测报告，报告里的上限与实际配置一致。
现在回看，压测没有覆盖分片边界，但记录保留原样，不做改写。
