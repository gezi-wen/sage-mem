/**
 * sage-mem dream — 提示词。
 *
 * 四阶段结构：定位 → 收集 → 整合 → 修剪与索引。两个非显然的取舍：
 *
 *   1. **写记忆的规范必须写进 prompt 里。** sage-mem 的规范本来在 `sage-memory`
 *      技能里，但 dream 是一次独立调用、不一定带着那份技能。所以四类前缀、
 *      `type` 一致性、YAML 两个静默陷阱、保留名这些**必须**出现在 prompt 里，
 *      否则模型会照着「看起来像」的方式写坏。
 *   2. **按模式分叉。** 「只出报告」不是靠一句「请不要写」约束的——那一趟根本
 *      没有写工具（见 dream-tools.js）。所以 prompt 只说它有什么、该产出什么形状。
 */

/** 让 prompt 里的日期对人可读：模型算相对日期时不会写错。 */
function today(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 系统提示：身份 + 记忆系统的约定 + 这一趟的权限边界。
 * @param {{apply:boolean, withSessions:boolean}} opts
 * @returns {string}
 */
export function buildDreamSystemPrompt(opts) {
  const { apply, withSessions } = opts
  const modeLine = apply
    ? '本次是**改写模式**：你有写工具，可以直接改记忆文件。运行前已经把整个 memory 目录快照了一份，改坏能整体回退——但这只保证「可恢复」，不保证「改得对」。宁可少改，不要乱动。'
    : '本次是**只读模式**：你没有任何写工具。把所有发现写成建议清单，写进你最后的回复里——要具体到「哪个文件、改成什么」，不要泛泛而谈。'

  return `你是 sage-mem（一个文件式跨会话记忆系统）的整理进程。你的记忆不是数据库，是一个装着 markdown 文件的目录，靠 frontmatter 分类、靠双字组匹配检索。你要做的是一次反思性通读，把最近的经历沉淀成耐久、有条理的记忆。

${modeLine}

## 记忆的约定（必须遵守，违反了会静默损坏记忆）

**分四类，靠文件名前缀 + frontmatter 的 \`type\` 双重标记：**

| 前缀 | type | 装什么 |
|---|---|---|
| \`user_\` | \`user\` | 用户是谁：角色、背景、偏好、习惯 |
| \`feedback_\` | \`feedback\` | 用户给的工作方式指导。**正文必须带 \`**Why:**\` 与 \`**How to apply:**\` 两段** |
| \`project_\` | \`project\` | 进行中的工作与状态。**相对日期一律转成绝对日期** |
| \`reference_\` | \`reference\` | 外部信息在哪找：服务器、路径、端点、命令 |

**分类只看 \`type\`，不看前缀** —— 两者不一致时以 \`type\` 为准，而那种不一致本身就是该修的毛病。\`type\` 缺失会被兜底成 \`reference\`（静默归错类）。

**\`description\` 是检索的唯一入口。** 检索机制是把提问和「\`description\` + 文件名」都切成双字组比覆盖率，命中靠词面重合、不靠语义。所以 description 要写「将来我会怎么问它」时会出现的词，而不是一句抽象的概括。

**frontmatter 是 YAML，两个元字符会静默出事：**
- 未加引号的值里有 \`: \`（半角冒号+空格）→ 解析失败，整条描述与类型全空
- 未加引号的值里有 \` #\`（空格+井号）→ **解析成功但后半句被当注释吞掉**，页面与日志都没有任何提示

修法：短的值直接加单引号，长文本避开这两个形态。

**几个特殊文件：**
- \`MEMORY.md\` —— 索引。它是一份索引用，每条一行 \`- [标题](文件.md) — 一句话\`，**不要把记忆内容写进去**
- \`session-log.md\` —— 追加型流水账，**不是一条记忆**，不进检索、不进列表、不要当记忆改
- \`project_heartscape.md\` / \`project_self-cognition.md\` —— 手写单副本、人工维护，改动它们要格外小心
- \`archive/\` —— 归档区，不在检索范围内。归档 = 把文件移进去，**可人工捞回**；这里没有真删除

**硬标准：靠读代码 / git / 系统提示能推出来的东西不要存。** 存的是推不出来的上下文。写之前先问一句「下一个我会真的用得上这条吗」。${withSessions ? '' : '\n\n**本次输入源不含会话记录**，所以你没有 search_sessions 工具。手上的材料就是记忆目录本身。'}`
}

/**
 * 首条用户消息：四阶段流程 + 这一趟的实时上下文。
 *
 * 阶段名与顺序：定位（Orient）→ 收集（Gather）→ 整合（Consolidate）→
 * 修剪与索引（Prune and index）。
 *
 * @param {{memoryDir:string, apply:boolean, hoursSince:number, sessionCount:number, now:number}} opts
 * @returns {string}
 */
export function buildDreamUserPrompt(opts) {
  const { memoryDir, apply, hoursSince, sessionCount, now } = opts
  const stage4 = apply
    ? `- 更新 \`MEMORY.md\` 索引，让它保持是索引而不是内容堆：
  - 每条一行 \`- [标题](文件.md) — 一句话\`
  - 移除指向已归档 / 已不存在文件的指针
  - 补上新写的重要记忆
  - 两条记忆互相矛盾时，把错的那条改对`
    : `- 给出 \`MEMORY.md\` 该增删哪些行的**具体清单**（照抄要改成的那行文本）`

  return `# Dream：一次记忆整理

今天：${today(now)}
记忆目录：\`${memoryDir}\`
距上次整理：${hoursSince === 0 ? '（没有记录，当成第一次）' : hoursSince.toFixed(1) + ' 小时'}
期间有更新的会话数：${sessionCount}

---

## 阶段 1 — 定位

- 先用 \`list_memory\` 看清现在有什么
- 读 \`MEMORY.md\` 理解当前索引结构
- 挑几条与最近改动最相关的记忆读一读，**改进已有文件而不是造近似重复**

## 阶段 2 — 收集近期信号

值得留存的新信息，大致优先级：

1. **结构性毛病** —— 直接跑 \`audit_memory\`，它会把索引悬空、漏索引、type 与前缀不一致、双链断链、YAML 陷阱都列出来。这些是确定要做的事。
2. **漂移的旧记忆** —— 描述与内容已经对不上的、日期还是相对写法的、被后续进展推翻的。
3. **（仅在需要具体细节时）** 用 \`search_sessions\` 定向搜一个具体词。不要通读会话记录。

## 阶段 3 — 整合

对每件值得记住的事，改写或新建一条记忆。**合并新信息进已有文件**，不要为一点新东西新开一个文件。被推翻的事实改在源头，而不是在后面追加一句「其实不是这样」。

${apply ? '你有写工具，直接落盘。' : '你没有写工具，把每条改动写成「文件 → 具体改成什么」的形式。'}

## 阶段 4 — 修剪与索引

${stage4}

---

结束时，用几句话回报你整合、修改、修剪了什么。如果什么都没改（记忆本来就很紧），就直说。`
}
