---
name: harbor-config
description: 港口调度器的配置文件位置与字段含义速查
aliases: [港口配置, harbor config, 调度器配置文件]
metadata:
  node_type: memory
  type: reference
  updated: 2026-09-28
---

# 港口调度器配置

配置文件在主目录下的 `harbor.yml`，字段含义按出现顺序：

- `window`：允许调度的时段
- `retry`：重试策略名
- `backpressure`：队列积压上限
- `deadletter`：死信目录

改完必须重启调度器；热加载只覆盖 `retry` 一项。
其余字段在进程启动时读一次，之后不再回看，改了也不报错，只是不生效。
这一点很容易被当成「配置写错了」，实际是热加载的范围限制。

配置文件支持环境变量插值，插值失败的字段会回落到内置默认值，同样不报错。
排查配置问题时先确认读到的值和文件里写的一样，再看行为是否符合预期。
插值失败只留一行启动日志，错过它就只能靠对比默认值猜。
