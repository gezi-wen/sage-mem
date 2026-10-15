---
name: sagemem-frontmatter
description: 记忆文件的字段速查，写新文件时对着填
aliases: [字段速查, frontmatter fields]
metadata:
  node_type: memory
  type: reference
  updated: 2026-09-10
---

# 记忆文件字段

- `name`：短标识，文件内唯一
- `description`：一句话说清这条是什么，检索拿它当摘要
- `aliases`：同一件事的别的叫法
- `metadata.type`：分区类型
- `metadata.updated`：手写日期，优先于文件修改时间

`metadata.updated` 缺失时会回落到文件系统时间，那表示的是「文件被动过」，
不是「这条记忆写于何时」，两者在批量复制之后会差很远。

`description` 是最值得花时间的一项：检索先看它，写得含糊就等于这条记忆不存在。
`aliases` 用来补「我可能怎么问它」，凡是同一件事有几种叫法的，都该写进去。
