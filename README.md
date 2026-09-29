# sage-mem · DSH 的文件式记忆插件

[![npm version](https://img.shields.io/npm/v/sage-mem.svg?color=blue)](https://www.npmjs.com/package/sage-mem)
[![npm downloads](https://img.shields.io/npm/dm/sage-mem.svg)](https://www.npmjs.com/package/sage-mem)
[![license](https://img.shields.io/npm/l/sage-mem.svg)](https://github.com/gezi-wen/sage-mem/blob/main/LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.1.2--rc.1-8a2be2)](https://github.com/deepseek-ai/deepseek-harness)

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）装上跨会话记忆。纯 Markdown 存储，透明、可检查。**

> **如果这个工具帮到了你，欢迎给个 ⭐️ Star 支持一下！**

记忆就是本地的一堆 Markdown 文件（frontmatter + 正文）——不是数据库，没有私有格式。agent 今天记住的事，明天的新会话自动想起来。

> **English** — file-based cross-session memory for DeepSeek Harness: every memory is a plain markdown file you can open, edit and delete; no database, no worker, no port.

## 为什么需要 sage-mem

DSH 原生没有记忆系统。每个新会话都是一张白纸——agent 不记得你是谁，不记得你们昨天做到哪，不记得项目进行到哪一步。你只能每次重新交代一遍。

市面上的记忆方案大多走 SQLite + 常驻 worker：记忆写进数据库就**不透明**（想看看存了什么得去查表），事件全捕获又会让库**膨胀**（「用户打了个招呼」也算一条），还得额外养一个进程和一个端口。

sage-mem 换一条路：**每条记忆就是一个 Markdown 文件**。用编辑器打开就能看、能改、能删；存不存由 agent 按规则判断，不做无差别捕获。让 agent 真正记住你和你的项目，而这份记忆始终握在你自己手里。

## 核心特性

| 特性 | 说明 |
|---|---|
| **文件式存储** | 每条记忆一个 `.md`：frontmatter 存元数据，正文存内容。无数据库、无隐藏格式，VS Code 直接打开就能改 |
| **跨会话记忆** | 每轮提问自动扫记忆目录、按相关度挑出最相关的几条注入上下文。agent 第一轮就「想起来」，不需要它自己去翻文件 |
| **Claude Code 无损迁移** | CC 的记忆与人格都是 Markdown——**直接拷文件**就完成迁移，不写转换脚本。详见[下一节](#从-claude-code-无损迁移) |
| **零额外服务** | 无 worker、无 SQLite、无端口、无常驻进程，不需要额外的 API key 或云服务（运行时唯一的依赖是普通 npm 库 `zod`） |
| **防膨胀** | 靠规则引导 agent 判断「值不值得存」：无实质内容的不存，靠读代码 / git 能推出来的不存 |

界面上还有三块附加能力（都可以不用）：

- **记忆管理页**（v0.4）——DSH 设置页里的「记忆管理」：浏览、查看、编辑、删除、新建记忆，不用离开 GUI
- **类型与标签筛选**（v0.6）——文件列表顶部一排 chip，按四类 + 自定义标签筛；标签从全库自动聚合计数，与搜索框是 AND 关系
- **记忆星图**（v0.4 起，v0.6 重做）——把记忆画成星空：按类型着色、按体积分级、按新鲜度分亮度，还支持时间线与「诞生回放」。渲染是**按需重绘**，画面静止时不发起任何绘制

## 快速开始

需要 DSH `0.1.2-rc.1` 或更高（见[兼容性](#dsh-兼容性)），Node.js `>= 18`。

```bash
# 把 web 换成你自己的 profile 名
dsh plugin --profile web add sage-mem
```

`dsh plugin add` 一步做两件事：把 `sage-mem` 装进这个 profile 的依赖，**并自动把它的 bundle 追加进 `dsh.profile.bundles`**——不用手改 `package.json`。

装完重启 DSH。确认装上了：

```bash
dsh plugin --profile web list
```

然后**开一个新会话**试一句：

1. 跟 agent 说「记住：我的猫叫芝麻，它喜欢晒太阳」——它按规则把这条写进记忆目录
2. 再开一个**新会话**，问「我的猫叫什么」
3. 第一轮就该答出「芝麻」——记忆由插件自动检索并注入，agent 没有主动去翻

<details>
<summary>手动安装（不想用 CLI，或要装本地开发版本）</summary>

在 profile 的 `package.json` 里加依赖，并把包名写进 `dsh.profile.bundles`：

```json
{
  "dependencies": {
    "sage-mem": "^0.6.2"
  },
  "dsh": {
    "profile": {
      "bundles": ["sage-mem"]
    }
  }
}
```

本地开发用 clone 出来的源码：

```json
{
  "dependencies": {
    "sage-mem": "link:../sage-mem"
  }
}
```

改完跑 `pnpm install`，再重启 DSH。

</details>

### 记忆目录

默认在 `~/.sage-mem/memory`。想放到别处（比如放进项目仓库、跟着 git 走）就设环境变量：

```bash
SAGE_MEM_DIR=/path/to/your/memory
```

## 从 Claude Code 无损迁移

你已经在 Claude Code（CC）里养了一个 agent，舍不得它的记忆和人格？sage-mem 是「CC → DSH」迁移方案的一部分，**两样都能无损搬过来**：

| 搬什么 | 从 | 到 | 怎么搬 |
|---|---|---|---|
| **人格** | CC 的 `CLAUDE.md` | DSH 的 `AGENTS.md` | DSH 原生加载，纯文本，一字不改就能用 |
| **记忆** | CC 沉淀的跨会话记忆 | sage-mem 的 `memory/` 目录 | markdown + frontmatter 四类，拷进去即可 |

没有数据库、没有私有格式——全都是 Markdown 文本，**直接拷文件就完成迁移**。agent 换了身体，但依然记得你是谁、记得你们聊过什么、记得进行中的项目。

## 检索是怎么工作的

透明的东西值得说清楚它怎么选料，因为它直接决定注入多少 token：

- **信号是 `description`，不是全文**。每条记忆的 `description`（「一句话说清这条是什么」）加文件名参与打分，最多注入 **5 条**相关记忆。旧版拿问题里的双字去全文里蒙，长记忆天生占便宜——实测连「今天天气不错」都能注入 2300 token；改用 `description` 后噪音大幅下降
- **正文超 1500 字符就截断**并标 `…（截断）`，单条记忆不会吃掉整个上下文
- **同一个问题不会重复注入**（按会话记签名），问第二遍不会又追加一遍
- **`baseline: true` 的记忆每场会话第一步无条件注入**，最多 5 条——给「你是谁」「待办清单」这类每次开场都该在场的记忆用
- 记忆目录读不到、权限错、frontmatter 格式坏，这些都**降级为不注入并写日志**，不会静默失效

单文件上限 512 KB；标签最多 20 个、每个 40 字符（再多就不是标签，是一句话被塞进 `tags` 了）。

## 做梦（dream）

可选的记忆整理功能：把记忆目录通读一遍——合并重复的、删掉被推翻的、修索引与断链、把相对日期换成绝对日期，让下一次会话能快速对上位置。

**默认关闭**，在设置页「记忆管理 → 做梦」里开。三件事各自可选：

| 选项 | 取值 | 说明 |
|---|---|---|
| 触发 | 只手动 / 满足条件自动跑 | 自动模式走三级门控，**最便宜的先查**：时间门（距上次 ≥ N 小时，一次读写）→ 会话门（期间 ≥ M 个会话有更新，一次目录扫描）→ 锁（防并发）。中间夹一层 10 分钟扫描节流，免得「时间门过了、会话门没过」时每轮白扫 |
| 改动方式 | 只出报告 / 直接改写 | 「只出报告」模式下**写工具根本不会挂给模型**——不是靠一句「请不要写」约束，是它没有手 |
| 输入源 | 仅记忆目录 / 记忆 + 会话记录 | 后者会解压会话记录（zstd）做定向关键词搜索；代价是私密对话会进入模型上下文，token 成本也更高 |

模型可配（留空则跟随聊天页当前的默认模型），最多轮数、快照保留份数在「高级设置」里。

**三道安全网：**

1. **安全边界在工具集上，不在提示词里**——做梦时宿主只把 `list_memory` / `read_memory` / `audit_memory`（只读模式另加 `search_sessions`）交给模型，改写模式才多给 `write_memory` / `archive_memory`。而且**没有「删除」这个能力**：归档是把文件移进 `archive/`，可以人工捞回
2. **改写前自动快照**整个记忆目录（只快照顶层 `.md`，不含 `archive/`），落在 `<memory 目录的上一层>/.sage-mem/snapshots/<时间戳>/`，保留最近 N 份。理由是记忆目录**不在任何版本控制下**、删除没有回收站，「可回滚」得自己造
3. **跑完自动审计**：六查（索引悬空 / 漏索引 / `type` 与文件名前缀不一致 / CRLF / 双链断链 / frontmatter 里被 YAML 当注释吞掉的「空格 + #」），结果与前后对比写进报告。它**只报不改**

报告落在 `memory/dream/YYYYMMDD-HHmmss.md`——子目录，不会被扫成记忆条目。

## 记忆文件格式

````markdown
---
name: 可选的短名
description: 一句话说清这条记忆是什么（检索靠它，务必写准）
metadata:
  type: user        # user / feedback / project / reference
tags: [项目, 待办]   # 可选，供列表页筛选
baseline: true      # 可选：新会话第一步无条件注入（上限 5 条）
---

记忆正文。
````

四类记忆：

| 类型 | 存什么 |
|---|---|
| `user` | 用户是谁 |
| `feedback` | 工作方式指导（建议带 `**Why:**` 与 `**How to apply:**` 两行，方便判断边界） |
| `project` | 进行中的工作与状态 |
| `reference` | 外部信息在哪找的指针 |

## 架构

```
DSH（Cordis 插件）
  └─ sage-mem 插件（按问题检索 + 注入）← 本仓库
       │  Node fs 直读
       ▼
memory/ 目录（markdown 文件，4 类）
  ├── user_*.md
  ├── feedback_*.md
  ├── project_*.md
  ├── reference_*.md
  └── MEMORY.md          ← 索引
```

没有 worker、没有 SQLite、没有 HTTP 端口、没有常驻进程。

## 权限与数据

sage-mem 只做三件事，全都在你本机：

| 它做什么 | 具体范围 |
|---|---|
| **读记忆** | 只读 `SAGE_MEM_DIR`（默认 `~/.sage-mem/memory`）下的顶层 `*.md`，单文件上限 512 KB |
| **写记忆** | 经 agent 的文件工具或设置页写同一个目录；`MEMORY.md`、`session-log.md` 等保留名受保护，设置页碰不到 |
| **注入** | 把选中的记忆作为上下文交给模型（最多 5 条相关 + 5 条 `baseline`） |

**它不做什么**：不联网、不开端口、不起常驻进程、不需要任何 API key；不读记忆目录以外的文件；
不做事件全捕获（存不存由 agent 按规则判断，不是"你说了什么都记"）。

记忆就是那个目录里的文件，随时可以打开确认——这也是选文件式的原因。

（唯一会调用模型的功能是「做梦」，用的是你已在用的那个模型，默认关闭。）

## DSH 兼容性

sage-mem 是纯 DSH 插件，在 `package.json` 的 `dsh.compatibility.dshReleases` 里逐版本声明兼容状态：

| DSH 版本 | 状态 |
| --- | --- |
| 0.1.2-rc.1 | compatible |
| 0.1.3-alpha.1 | compatible |
| 0.1.3-alpha.2 | compatible |
| 0.1.5-rc.1 | compatible |
| 0.1.6-alpha.1 | compatible |
| 0.1.6-alpha.2 | compatible |
| 0.1.7-rc.1 | compatible |
| 0.1.7-rc.2 | compatible |
| 0.2.0-rc.1 | compatible |

两点值得说明：

- **同一份构建同时覆盖 `0.1.x` 与 `0.2.x` 两条线。** 自 DSH `0.1.6-alpha.2` 起，TypertCodec 契约从「读 `schema`」改为「读 `create()` 工厂」——仍只写 `schema:` 的插件会在注册阶段直接抛错，把整棵插件树拖垮。自 0.5.2 起每个 codec 同时带 `schema` 与 `create: () => schema`，因此两个时代的 DSH 都能加载。peer 范围也随之放宽为 `^0.1.2-rc.1 || ^0.2.0-rc.1`（已逐字节核对 `dsh-typert-protocol` 与 `dsh-client-locale` 在 `0.1.7-rc.2 → 0.2.0-rc.1` 之间导出符号零增删）
- **0.5.3 起带一层防御留痕。** `deriveMessages()`（仍是同步）、`system-prompt/assemble` 事件、`context.agent.session` 这条链在升级中都没变；但如果哪天 DSH 把它们改成异步或改了名，插件会在**日志里报警**，而不是像以前那样静默地不再注入记忆

## 卸载

在 profile 的 `package.json` 里删掉 `sage-mem` 依赖，并从 `dsh.profile.bundles` 移除 `"sage-mem"`；`pnpm install` 后重启 DSH 即可。**记忆 Markdown 文件留在原目录，不受影响。**

## 相关项目

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — DSH 本体，一切皆插件
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) — DSH 插件生态清单

## 旧版

本仓库早期是 SQLite + worker 架构，已归档到 [`sqlite-worker`](https://github.com/gezi-wen/sage-mem/tree/sqlite-worker) 分支。文件式是继任实现。

## License

Apache-2.0
