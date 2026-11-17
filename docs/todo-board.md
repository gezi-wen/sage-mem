# 待办清单看板（2.11.0 · 实验性）

右侧栏的一个页签：把记忆目录里的 `project_session-state.md`（跨会话代办清单）画成分组卡片，可勾选、可新增、可编辑。**默认关闭**，开关在 设置 → 记忆管理 → 实验性。

## 三条前提

1. **文件是唯一真相。** 看板不建自己的存储、不缓存草稿：读的是那个 markdown，写的是那个 markdown。AI 用普通编辑工具改它，看板 4 秒内跟上（按 `revision` 比对，内容没变就不重渲染）。
2. **只做行级手术。** 勾选 = 给那一行加 `[x] `；新增 = 在那组最后一条后面插一行；编辑 = 替换那一行；清理已完成 = 删掉 `- [x]` 行。frontmatter、引用块、空行、别的节一个字节都不动。
3. **不代写留档。** 完成项只是被标成 `[x]`，收尾时由 agent 把要留的写进 `session-log.md`；看板不碰那份大文件。

## 认的文件形状

```markdown
---
name: session-state          # frontmatter 原样保留，不解析
---
# 标题
> 说明引用块

## ⏳ 等你一句话             # 每个 ## 是一组
- **标题**（指针）。正文……   # `- ` 开头是一张卡；`**…**` 是标题，其余是正文
- [x] **已完成的一条** —— 正文
  - 缩进的行并进上一条显示（不算新条目）

## 长期约束（不是待办，别删）  # 标题含「长期约束 / 不是待办 / 别删」→ 默认收起
```

- 没有 `##` 的文件：所有条目落进一个兜底组（标题显示「未分节」）。
- 没有 `**…**` 的条目：不画标题行，正文自己说话。
- CRLF 文件读得懂；但写回那一行时会变成 LF（改动行的行尾归一，未触碰的行原样）。

## 交互与错误形态

| 动作 | 落盘 | 失败时 |
|---|---|---|
| 勾选 / 取消 | 那一行加 / 去 `[x] ` | `stale_revision` → 提示「文件刚被别处改过，已重新加载」，**不覆盖** |
| 新增 | 该组末条之后插 `- <文本>` | 同上；空白内容不写 |
| 编辑 | 替换该行正文（保留 `[x]`） | 同上 |
| 清理已完成 | 删掉全部 `- [x]` 行 | 计数为 0 时不写盘 |
| 撤销 | 写回上一次写入前的整份内容 | 一步；再按就没了 |

- 陈旧宿主（装着旧 manifest 的进程）：写入会降级重试，成功后提示「这次写入没有版本校验，请确认内容正确」。
- 文件不存在：显示「没找到 project_session-state.md」，**不代建** —— 免得造出缺 frontmatter 的文件。

## 实现位置

| 层 | 文件 | 是什么 |
|---|---|---|
| host | `lib/memory/experimental.js` | `todoBoard` 的唯一定义（`live: true` = 不参与 `restartRequired`） |
| host | `lib/typert.host.js` | settings result / pending / patch 三处 zod（**两侧都要声明**，只加一侧会被 strict 剥掉） |
| host | `lib/index.js` | `experimental` 初值、`restartRequired` 按 `live` 跳过、`setSettings` 同口径 |
| client | `client/79-todo-board.js` | 解析 / 行级手术 / 页签注册 / 热开关 / 实验性页那张卡 |
| client | `client/80-apply.js` | 启动读一次开关并 `applyTodoBoard()` |
| client | `client/64-lab-settings.js` | 实验性页里挂上那张卡 |

## 为什么这样承载

- 走**官方** `sidebarRightTabs` 注册表：`register({ id, kind, title, guide })` + 键控槽 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`。`guide` 条目让「开始」页自动长出卡片（better-sidebar 从同一张表读）。
- **definition + body 常驻，只随开关换 guide**：关掉开关时已打开的页签不会变成孤儿，它切到「已关闭」态；再打开时不需要刷新页面。
- 不新增 remote：`memory/readFile` 回 `{ content, revision }`，`memory/writeFile` 带 `expectedRevision` 做 CAS —— 并发冲突由宿主判定，客户端只负责重读。
