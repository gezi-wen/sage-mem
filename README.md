# sage-mem · DSH 的记忆系统插件

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）装上**跨会话记忆**——agent 今天记住的事，明天的新会话自动想起来。

## 为什么需要它

DSH 原生没有记忆系统。每个会话都是白纸：用户说过「我喜欢在深夜写代码」，下个会话再问「我喜欢什么」，agent 只能答不知道。

sage-mem 补上这一块。它监听 DSH 的事件流，把会话内容沉淀到 SQLite，新会话启动时自动检索注入历史记忆。

**中文优先**。市面上的记忆方案在中文检索上普遍失效（SQLite FTS5 默认分词器对中文全部 0 命中）。sage-mem 的 worker 用 trigram 分词 + 短词兜底，中文实测全命中。

## 功能

- **自动捕获**：工具调用（读写文件、执行命令）自动记录，无需手动整理
- **AI 压缩**：会话内容由 LLM 压缩成结构化记忆（事实、摘要），中文输出
- **跨会话注入**：新会话启动时自动检索并注入历史记忆，agent 不用自己翻
- **中文检索**：trigram 分词（≥3 字查询）+ LIKE 兜底（<3 字短词如「猫」「芝麻」）
- **Web 记忆管理**（v0.2）：DSH 设置页新增「记忆管理」，可视化查看/编辑/删除全部跨会话记忆，支持自定义记忆与偏好记忆
- **get_observations 工具**（v0.2）：补齐注入头承诺却缺失的按 ID 取回记忆正文通道

## 架构

```
DSH（Cordis 插件）
  └─ sage-mem 插件（事件监听 → HTTP 转发）← 本仓库
       │  HTTP 127.0.0.1
       ▼
sage-mem worker（Bun 常驻，fork 自 claude-mem）← gezi-wen/claude-mem
       │
       ▼
SQLite（FTS5 trigram 中文分词 + LLM 压缩）
```

设计选择：记忆逻辑复用 [claude-mem](https://github.com/thedotmack/claude-mem)（Apache-2.0，9 万星），fork 后加中文修复，DSH 侧只写一个轻量桥接插件。改动最小，能追上游更新。

## 安装

### 1. 部署 worker

```bash
git clone https://github.com/gezi-wen/claude-mem.git
cd claude-mem
git checkout sage-mem-worker   # 含中文 trigram 修复
bun install
```

配置 `~/.claude-mem/settings.json`（worker 数据目录）：

```json
{
  "CLAUDE_MEM_PROVIDER": "openrouter",
  "CLAUDE_MEM_OPENROUTER_BASE_URL": "https://api.deepseek.com",
  "CLAUDE_MEM_OPENROUTER_MODEL": "deepseek-chat",
  "CLAUDE_MEM_CHROMA_ENABLED": "false",
  "CLAUDE_MEM_MODE": "code--zh"
}
```

`~/.claude-mem/.env` 放 API key（任意 OpenAI 兼容服务均可，不限于 DeepSeek）：

```
OPENROUTER_API_KEY=<你的 API key>
```

启动：

```bash
bun src/services/worker-service.ts --daemon
```

### 2. 安装插件

在你的 DSH profile 的 `package.json` 里加：

```json
{
  "dependencies": {
    "sage-mem": "github:gezi-wen/sage-mem"
  },
  "dsh": {
    "profile": {
      "bundles": ["sage-mem"]
    }
  }
}
```

或 clone 后本地 link：

```json
{
  "dependencies": {
    "sage-mem": "link:../sage-mem"
  }
}
```

然后 `pnpm install` 重启 DSH。

## 验证

跨会话中文记忆链路（实测）：

1. 会话 A 说「记住：我的猫叫芝麻，它喜欢晒太阳」
2. 开新会话 B 问「我的猫叫什么」
3. agent 直接答出「芝麻」——记忆自动注入，无需 agent 自己找

搭配 [sage-persona](https://github.com/gezi-wen/sage-persona)（我是谁）和 [sage-meta](https://github.com/gezi-wen/sage-meta)（我做得对吗）组成 Sage 三件套——这是三道题的第三道：**我下次应该怎么想**。

## 已知边界

- trigram 分词对 `<3` 字符查询无效，worker 已加 LIKE 兜底
- worker 不可用时插件静默跳过（不阻塞 DSH），记忆功能暂缺
- MVP 存储统一在 `project=sage` 空间，按工作区分项目是后续计划
- worker 的 `/api/memory/save` 会写入空 `concepts`，导致手动记忆被上下文生成的 concepts 白名单过滤、对新会话不可见 —— v0.2 的保存路径改走 `/api/import` 规避（详见 lib/index.js 注释），治本需修 worker
- 注入时间线只携带记忆标题（`CLAUDE_MEM_CONTEXT_FULL_COUNT` 默认 0），v0.2 保存手动记忆时生成「自包含标题」并把事实写进标题，保证新会话直接可见

## License

MIT（worker fork 为 Apache-2.0，见 [gezi-wen/claude-mem](https://github.com/gezi-wen/claude-mem)）
