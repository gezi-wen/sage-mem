---
name: orchard-flags
description: 果园命令行参数表，含很少用到的几个
aliases: [果园参数, orchard flags]
metadata:
  node_type: memory
  type: reference
  updated: 2026-08-20
---

# 果园命令行参数

- `--jobs`：并行度，默认 4
- `--watch`：监听文件变化
- `--max-retries 5`：单步重试上限，超过就整条失败
- `--no-cache`：跳过缓存读取，仍会写缓存
- `--profile`：输出各步耗时

`--max-retries 5` 是唯一一个改动会影响总耗时的参数。

其余参数只影响这一次运行，不改变缓存的写入结果。
`--no-cache` 与清空缓存目录不是一回事：前者跳过读取但仍然写入，
所以它适合验证「缓存内容是否正确」，不适合验证「没有缓存时会怎样」。
清空缓存目录才能验证后者，代价是一次完整的全量构建。
参数解析不区分大小写，但写成全大写也不会被拒绝，容易在脚本里留下两种风格。
