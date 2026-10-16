# sage-mem 的宿主事实（2026-10-15 核验）

**一句话**：sage-mem 依赖的宿主能力分两档 —— **有就拿、没有就整块跳过**。
本文把「哪些能力真的在」与「拿不到时会怎样」写成可复核的记录，而不是口头假设。

- **可重跑断言**：`node test/host-facts-test.mjs`（降级契约 + 探针检查器，82 条）
- **真实宿主探针**：`node scripts/host-facts-probe.mjs` —— ⚠️ 这条命令**跑不了**，它是
  插件不是脚本。正确步骤见下面第 2 节（也是探针文件头那段）。
- 本文所有实测都取自 **headless profile**；`desktop` / `web` 未跑过探针，见第 6 节。

---

## 1. 结论先摆出来（按重要性排）

1. **`fs/write-intent` 这类「单槽」事件有注册窗口，晚了就一次都收不到**（2026-10-15 新增，
   第 3.3 节）。同一个 ctx 上**晚 2.5 秒**注册的监听器收到 0 次，而早监听器在那之后 0.5 秒
   确实收到了那次事件；顶层 `inject` 与 `ctx.inject` 子 fiber 都会把注册推到窗口之外。
   写入门（task-9）能不能成立**完全取决于这一条** —— 它不能靠「声明了 inject 拿到服务再挂」。
2. **不声明 `inject` 时，`ctx.<服务名>` 会抛，`ctx.get('<服务名>')` 只给 `undefined`。**
   实测原文：`cannot get property "tools" without inject`。
   这条直接决定降级怎么写：`ctx.get(a) ?? ctx[a]` 这种「先 get 再取属性」的写法在服务缺失时
   **不是返回 undefined，而是抛**。`lib/autodream/engine.js:90-93` 的 `svc()` 就是这个形状 ——
   它现在只被 `MemoryGateway` 构造函数的 try/catch（`lib/index.js:194-198`）兜住，
   一旦有人把 `svc()` 用到注入链里，异常就会升级成「记忆不注入」。
3. **事件的「到达性」与「签名」必须分开验**（第 3.3 节）：`tools/result` 在一个**不声明 inject**
   的插件里确实收到 2 次，`exec` 键名实测是
   `token / callId / rootCallId / name / signal / agent / deferContext / concludeTurn / arguments`。
   「名字在类型里有」不等于「事件会到」。
4. **写入门只对「工具发起」的写入生效**：插件自己调 `ctx.fs.writeText` 时
   `fs/write-intent` **一次都不发**（写成功也是 0）。守得住模型内置 `write`/`edit`，
   守不住插件自己的写入 —— 那条路由调用方自己传 `expected`。
5. **要塞的工具能力，宿主确实有**：`tools` 服务由 `ToolRuntime` 提供，`register` 是
   1 参函数（`register(definition)` → disposer）。事件 `tools/pre-execute` / `tools/execute` /
   `tools/post-execute`（waterfall）与 `tools/result`（emit）四个名字上**都挂着宿主自己的监听**。
6. **0.9.15 一个都还没接**：`ctx.tools.register` 在构造过程中零调用（有断言盯着，
   还做过变异验证 —— 见第 5 节）。所以本轮打的是**降级契约**，不是功能。
7. **服务的声明是逐步长出来的**：同一个进程里 `props`（声明表）从 24 条长到 80 条
   （声明了 inject 的那次是 81 → 86）。插件 `apply()` 那一刻看不到全貌 ——
   要判「宿主一共有什么」得看收尾阶段，要判「我启动时能不能拿到」才看启动阶段。
8. **`ctx.get` 的严格读依赖「提供方 fiber 处于 ACTIVE」**：启动阶段严格读拿得到实现，
   收尾阶段拿不到（提供方已经离开 ACTIVE），只有 `ctx.get(name, false)` 还拿得到。

---

## 2. 怎么复核探针（2026-10-15 全部实跑过）

```powershell
# step 1：生成 overlay（写 %TEMP%，不碰仓库 / 不碰任何 profile 配置）
$probe = (Resolve-Path '<仓库目录>\scripts\host-facts-probe.mjs').Path -replace '\\','/'
$yml   = Join-Path $env:TEMP 'sage-mem-host-facts-probe.yml'
"- insert:`n    - id: sage-mem-host-facts-probe`n      name: '$probe'" | Set-Content -Encoding ascii $yml

# step 2a：模式 A —— 不声明 inject（sage-mem 0.9.15 的现状）
#          提示词必须真的让模型调一次工具，否则事件计数全是 0（0 = 没触发，不是不存在）
dsh --profile headless --patch $yml "先用 write 工具写一个临时文件，再用 read 工具读回来"

# step 2b：模式 B —— 声明 inject 之后服务拿不拿得到 + 插件自己写会不会触发写入门
$env:SAGE_MEM_PROBE_INJECT = 'fs'
dsh --profile headless --patch $yml "先用 write 工具写一个临时文件，再用 read 工具读回来"
Remove-Item Env:\SAGE_MEM_PROBE_INJECT
```

探针的四个诊断开关（都只影响探针自己，默认全关）：

| 环境变量 | 作用 |
|---|---|
| `SAGE_MEM_PROBE_INJECT=tools,fs` | 给探针声明硬 `inject`；不设 = 不声明 |
| `SAGE_MEM_PROBE_NO_WRITE=1` | 关掉「插件自己写一次」的实验（用来分辨「inject 本身」与「插件写了」） |
| `SAGE_MEM_PROBE_SUBFIBER=1` | 改为把 `fs/*` 监听器挂在 `ctx.inject` 的**子 fiber** 里（sage-mem D5 的接法） |
| `SAGE_MEM_PROBE_LATE_ON=1` | apply 之后 2.5 秒再挂一个 `fs/write-intent` 监听器（验证注册窗口） |
| `SAGE_MEM_PROBE_STRICT=1` | 让 `checks` 里的 `fail` 变成非零退出码（默认只记录，不改宿主成败） |
| `SAGE_MEM_PROBE_AFTER_MS=<毫秒>` | 补拍快照的窗口，默认 20000。**长驻 profile（web / desktop）要放大** —— 插件在回合之前就挂载了，20 秒常在真实工具调用之前拍完，读出来像「事件没到达」（见第 3.5 节） |

产物（每个阶段各一份，别只看最后一份）：

| 文件 | 看什么 |
|---|---|
| `%TEMP%\sage-mem-host-facts-probe.load.json` | **服务可达性的主证据**：插件 `apply()` 那一刻能拿到什么 |
| `%TEMP%\sage-mem-host-facts-probe.dispose.json` | 声明表全貌（`props` 已长齐）+ 事件计数（最全） |
| `%TEMP%\sage-mem-host-facts-probe.json` | 最后一次写入（= 最新阶段）；headless 的 stdout 也有同样内容 |

报告里的 `checks` 是三态（`pass` / `fail` / `inconclusive`）—— **`inconclusive` 不许读成 pass**：
「本轮没触发」与「这条事实不成立」是两件事。产物里不写本机绝对路径（只留 flag 与文件名）。

⚠️ **跑完看一眼 `git status`**：让模型写文件的那一轮，模型写的是**宿主的 cwd**（通常就是本仓库
目录），跑几轮就会在仓库根留下 `tmp-*.txt` / `test-temp-file.txt` 这类临时文件（实测有一份还带
内部称呼）。这些是垃圾，公开发布前必须清掉。

两个**已实测的边界**，别当它们能替代 step 2：

- `dsh --profile headless --dump-config --patch $yml` 只验 patch 组合、**不加载模块**
  （实测：探针一句都不打印）。
- `desktop` profile 加不了 `--patch`（桌面版被 Electron 独占），这份探针**没在 desktop 上跑过**。

---

## 3. 本次实测结果

### 3.1 headless profile（探针，2026-10-15）

模式 A（不声明 `inject`，= sage-mem 0.9.15 现状）：

| 服务 | 在声明表里 | 插件拿得到吗 | 直接读属性 |
|---|---|---|---|
| `tools` | `service`（dispose 阶段可见） | 否 | 抛 `cannot get property "tools" without inject` |
| `systemPrompt` | `service` | 否 | 同样抛 |
| `fs` | `service` | 否 | 同样抛 |
| `tokenMeter` | `service` | 否 | 同样抛 |
| `compaction` | `service` | 否 | 同样抛 |

- 启动阶段 `props` 共 24 条（8 个 service），**五个目标服务一个都还没声明**；
  收尾阶段 80 条（64 个 service），五个全部是 `service`。
- 事件（启动阶段就已存在）：`tools/pre-execute` / `tools/execute` / `tools/post-execute` /
  `tools/result` / `system-prompt/assemble` **五个名字上都有宿主自己的监听者**；
  收尾时 `system-prompt/assemble` 的被动计数 = **1** —— 宿主**真的派发过**它。
  （其余四个 observed=0：探针跑的那一轮没有工具调用，这是没触发，不是没这个事件。）
- 服务表 `ctx.reflect.store` 同样是「没长齐」的：启动阶段 8 个符号键、收尾阶段 0 个，
  两次都翻不到目标服务（`ctx.root.reflect !== ctx.reflect`，两处不是同一个实例）。
  所以**判「宿主有没有这个服务」以声明表 `props` 为准**，别只看 store。

模式 B（`inject = ['tools','systemPrompt','fs','tokenMeter','compaction']`）：

| 服务 | 拿得到 | 走哪条路 | 提供方 fiber |
|---|---|---|---|
| `tools` | 是 | `ctx.get`（严格读） | `ToolRuntime` |
| `systemPrompt` | 是 | `ctx.get` | `SystemPrompt` |
| `fs` | 是 | `ctx.get` | `SandboxedFileSystem` |
| `tokenMeter` | 是 | `ctx.get` | `TokenMeter` |
| `compaction` | 是 | `ctx.get` | `BasicCompactionEngine` |

同一份探针、同一个 overlay，只因**声明了 inject**，启动阶段的 `props` 就是 81 条、
服务表 58 个符号键（模式 A 那两组数字是 24 / 8）。原因不神秘：**不 inject 的插件
在树还很浅的时候就被 `apply` 了**，声明 inject 的插件要等依赖就绪才被调用。
「同一时刻的宿主长什么样」取决于插件什么时候被叫醒 —— 这条比任何单个数字都重要。

启动阶段拿到的方法签名（`.length` = **形参个数**）：

```
tools.register          arity=1     tools.get            arity=2
tools.schemas           arity=1     tools.execute        arity=1
tools.restrict          arity=1     tools.guard          arity=1
tools.executionMode     arity=1
systemPrompt.tools      arity=1     systemPrompt.context arity=1
systemPrompt.section    arity=1     systemPrompt.variable arity=2
systemPrompt.assemble   arity=0
fs.writeText            arity=5     fs.editText          arity=5
fs.readText             arity=2     fs.resolve           arity=2     fs.stat  arity=2
tokenMeter.measure      arity=2     tokenMeter.estimateMessage arity=1
compaction.compactNow   arity=3     compaction.compactIfNeeded arity=3
compaction.compactRegion arity=4
```

收尾阶段同一次运行里，`tools` / `systemPrompt` / `fs` / `compaction` 的 `resolvedBy`
都变成 `ctx.get(name,false)`（`tokenMeter` 走 `ctx.<key>`）—— 严格读在这一刻已经拿不到
（提供方 fiber 不再 ACTIVE），**非严格读仍拿得到**。这不是抖动，是阶段差异：
收尾时 `props` 已长到 86 条、服务表 41 个符号键（比启动阶段更大，因为整棵树都装配完了）。

### 3.2 desktop profile（`cordis_inspect` 的 Host 查询，2026-10-15）

探针跑不了的平台，用 Host Inspect 的 Service / Event 两个 provider 查运行中的 desktop 宿主。
**这一节是权威签名**（带类型），第 3.1 节是「插件自己能不能拿到」的运行时事实。

| 契约 | 权威签名（节选） |
|---|---|
| `tools`（"Tool registry and execution pipeline"） | `register(definition: ToolDefinition): () => void`；另有 `get(name, scope?)` / `schemas(scope?)` / `execute(exec)` / `restrict(filter)` / `guard(guard)` / `presentAs(mode)` / `executionMode(exec)` |
| `systemPrompt`（"Registry service for the prompt inputs assembled before each model step"） | `tools(provider: (context: AssembleContext) => ToolProviderResult): () => void`、`context(context: PromptContext): () => void`、`section(...)`、`variable(name, provider)`、`assemble(context?)` |
| `tools/pre-execute` | **waterfall** `(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>` |
| `tools/execute` | **waterfall** `(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>)` |
| `tools/post-execute` | **waterfall** `(this: Scoped<ToolRuntime>, exec: ToolExecution, result, next: () => Promise<PostToolDecision>)` |
| `tools/result` | **emit** `(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined` |
| `system-prompt/assemble` | **waterfall** `(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>)` |
| `fs`（"Abstract filesystem provider"） | `writeText(target, content, expected?: FsWriteIntent, signal?, sandboxPolicy?): Promise<FsWriteOutcome>`、`editText(target, edit, expected?: {version: FsVersion}, signal?, sandboxPolicy?): Promise<FsEditOutcome>` |
| `tokenMeter` | `measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement`、`estimateMessage(message): number` |
| `compaction` | `compactNow(agent, signal, sourceCommandId?)`、`compactIfNeeded(agent, trigger, signal)`、`compactRegion(start, end, agent, signal?)` |

⚠️ **与任务里那份契约清单的一处出入**：`fs.writeText` / `fs.editText` 实际还多两个可选参数
（`signal`、`sandboxPolicy`）—— 探针实测 arity=5 与之一致。照老清单写调用不会错
（多出来的都是可选的），但别以为只有 3 个形参。
另外 `tools` 的 `presentCall` / `presentResult` / `timeoutMs` / `isConcurrencySafe` 是
`ToolDefinition` 的字段（定义里的形状），不是 `tools` 服务上的方法 —— 探针只探服务方法，
这些字段要读 `ToolDefinition` 类型。

### 3.3 事件到达性与写入门（2026-10-15，headless，两个探针交叉印证）

**获取方式**：`dsh --profile headless --patch <yml> "<让模型先 write 再 read 的提示词>"`，
一次性宿主，跑完即退。两个独立探针各跑各的：

- `scripts/events-probe.mjs`（无 `inject`，只旁观计数）
- `scripts/host-facts-probe.mjs`（无 `inject`，模式 A；同一提示词复跑 3 轮，数字一致）

**事实 1：到达性与签名是两件事，必须分开验。** 一条「模型先 write 再 read」的提示词下：

| 事件 | observed | 说明 |
|---|---|---|
| `tools/result` | **2** | write + read 两次都到达 |
| `fs/observed` | **2** | 两次 fs 动作 |
| `fs/write-intent` | **1** | 只有「工具发起」的那次写 |
| `fs/edit-intent` | **0** | 本轮没有 edit |

同一轮里 `tools/pre-execute` / `tools/execute` / `tools/post-execute` 也都是 2，
工具名三个来源完全一致（`["write","read"]`）—— 这就是「数到的是真的」的交叉证据，
探针把它做成了检查（`exec_name_cross_checked`）。签名单独记：详见事实 3。

**事实 2：`fs/write-intent` / `fs/edit-intent` 只对「工具发起」的写入触发。**
插件自己调 `ctx.fs.writeText` 时**一次都不发**。本探针模式 B 独立复现，并且**把「写成功了」
一起记下来**（不然 0 次是零信息量）：

```
pluginWrite: { status:"ok", wrote:true, operation:"create", afterBytes:98,
               intentsBefore:0, intentsAfter:0 }      ← 写成功，写入门事件增量 0
```

推论：写入门守得住模型内置 `write`/`edit` 对记忆文件的写入，**守不住插件自己的写入** ——
那条路由调用方自己传 `expected`。检查 `plugin_write_emits_no_intent` 只有在
「写成功」时才判 pass；写失败一律 inconclusive（不能拿一次没发生的写去证明「不发事件」）。

**事实 3：`tools/result` 的 `exec` 形状是实测的，不是推断的**（键名逐个对）：

```
[token, callId, rootCallId, name, signal, agent, deferContext, concludeTurn, arguments]
```

`name` / `arguments` / `agent` 都在 —— 观测模块（task-8）靠 `name` + `arguments` 判
「模型读了哪份记忆」时，用的就是这几个键。探针的 `exec_shape_matches_baseline` 会逐条核对，
宿主以后多出来的键只记 `extra`、不算失败。

**事实 4（本次新发现，也是最重要的一条）：`fs/write-intent` 有注册窗口，晚了收不到。**

同一条提示词、同一个宿主，只改探针的挂载方式，7 组对照（每组的 `tools/result` 计数不同，
说明模型每轮调的次数不一样，不影响结论）：

| # | 监听器挂在哪 | `fs/write-intent` | `fs/observed` |
|---|---|---|---|
| A | 不声明 inject，`ctx.on` | **1** | 2 |
| B | 顶层 `inject:['fs']` | **0** | 2 |
| C | 顶层 `inject:['fs']`，且插件**不写** | **0** | 3 |
| D | 顶层 `inject:['tokenMeter']` | **0** | 2 |
| E | 顶层 `inject:['tools']` | **0** | 2 |
| F | 不声明 inject，改用 `ctx.inject(['fs'], sub)` 子 fiber | **0**（子 fiber）；顶层 ctx 反而 2 | 3 |
| G | 不声明 inject，apply **之后 2.5 秒**再挂一个 | **0**（晚的那个）；早的那个 1 | — |

G 是决定性的那一组：早监听器在 **t=3071ms** 收到事件，晚监听器在 **t=2507ms** 注册
（早于事件），却收到 **0** 次 —— 「注册时间晚」这条假说被坐实，而「作用域不对」被排除：

- 不是作用域：B/C/D/E 里在 `ctx.root` 上再挂一份，同样 0 次。
- 不是「插件自己写」：C 组插件一次都没写，照样 0。
- 不是 fs 专属：D（`tokenMeter`）、E（`tools`）同样 0。

**行为结论**（可复核）：`fs/write-intent` 只送给**注册得足够早**的监听器，窗口在
`fs` 服务就绪之前就关了；声明 `inject`（顶层或 `ctx.inject` 子 fiber）都会把注册推到窗口之外。
`fs/observed` 这类 **emit** 事件不受影响（F 组的子 fiber 照样收到 3 次）。

**对 sage-mem 的含义（方案层面，不是本轮代码）**：

- 写入门要能收到 `fs/write-intent`，**必须在 `apply()` 一开始、且在不 inject `fs` 的 ctx 上**注册；
- 「先声明 inject 拿到 fs，再挂监听器」这条路**走不通**——那时候窗口已经关了；
- 这与 D5「用 `ctx.inject` 挂子 fiber、避免硬依赖」**直接冲突**：子 fiber 的挂载时机晚于窗口。
  两者怎么取舍是方案决定，但**不能再假设「拿到服务就能收到事件」**。
- **未验证**：在事件到达的那一刻，不 inject 的 ctx 能不能用 `ctx.get('fs', false)` 取到 fs
  去 stat 目标 —— 这决定了「早注册 + 事件时取服务」这条折中路线可不可行。

### 3.4 写这种探针必踩的两个坑（都实测过）

1. **`apply` 不许 `return` 一个函数**。宿主会拿它当别的东西用，随后崩在
   `Cannot read properties of undefined (reading 'contexts')`，**整轮对话直接失败**
   （计数也就全是 0，不可信）。要清理就登记成 `ctx.effect`。
2. **只为计数而 `ctx.on(waterfallEvent, () => count++)` 会掐断事件链**。宿主拿到 `undefined`
   后去读它的 `.contexts`，同样崩在上面那句。**waterfall 类必须原样放行**
   （`return next()` 或返回原值）；`emit` 类不参与分发，只数即可。

本探针的 `EVENTS` 表把 `mode` 写在数据里就是为了防第二条：`waterfall` 一律通用放行
（把最后一个参数当 `next` 调）。

### 3.5 `web` profile（探针，2026-10-16 —— 第一次真跑）

在这之前，所有真实宿主实测都只在 headless 上做过，web 侧是**推断**（「web 与 headless
共用同一套 DSH 包」）。2026-10-16 补上：起一个**随机端口**的长驻 web 宿主并挂上探针，
再用浏览器真的发起一轮对话、让模型调工具。

⚠️ **长驻 profile 有一个坑**：插件在**回合之前**就挂载了，而默认那份补拍快照是 20 秒后 ——
20 秒常常在真实工具调用**之前**就拍完，于是两份快照全是 0，看起来像「事件没到达」，
实际是「**拍早了**」。为此探针新增 `SAGE_MEM_PROBE_AFTER_MS`（默认仍是 20000）。
**这是「拍早了」与「没到达」的区别**，也是为什么这条事实在 2026-10-15 没被看到。

```powershell
# 模式 A：不声明 inject —— 与 sage-mem 现状一致（A7 关心的就是这一种）
$env:SAGE_MEM_PROBE_INJECT = $null      # 或干脆不设
$env:SAGE_MEM_PROBE_AFTER_MS = '90000'
dsh --profile web --patch $yml --port 0 --no-open   # 随机端口、不自动开浏览器
# 再从这个宿主打印的 http://127.0.0.1:<port>/?token=… 发一句「必须用 write 工具 …」的提示词
```

结果（那一轮模型用了 `pwsh` / `write` / `read` 三个工具）：

| 观测 | 值 |
|---|---|
| `system-prompt/assemble` | **observed 6** —— 注入主链在 web 上照常被派发 |
| `tools/pre-execute` / `execute` / `post-execute` / `result` | **observed 5**，`toolNames = pwsh, write, read` |
| `fs/observed` | observed 3 |
| **`fs/write-intent`** | **observed 2** |
| `fs/edit-intent` | observed 0（那一轮没人编辑） |
| `checksSummary` | **pass 7 · fail 0 · inconclusive 1** |

**四条结论：**

1. **不声明 `inject` 的早注册监听器，在 web profile 上真的收得到 `fs/write-intent`（2 次）。**
   这正是写门依赖的那条事实，也是第 3.3 节事实 4 那个「注册窗口」在**第二个 profile** 上的复现 ——
   与 headless 一致。
2. `system-prompt/assemble`（注入主链）与 `tools/*` 事件链在 web 上照常派发。
3. 唯一的 `inconclusive` 是 `plugin_write_emits_no_intent` —— 那是**探针自己的写实验**没跑：
   它要 `inject=fs` 才拿得到 `ctx.fs`（模式 B）。**与 web 无关**，别读成 web 的缺陷。
4. 附带一个**观测盲区的现场例子**：那一轮模型先用 `pwsh` 写了文件，于是 `fs/observed` 记了 3、
   而 `fs/write-intent` 只有 2 —— 差的正是 shell 那条路（执行类工具里的写入**不发**写入门）。

⚠️ 这些都是**探针实测**，仍然**不是回归断言**（CI 的容器里没有 DSH 宿主）。
所以能力边界表里 web 那一行是「**尽力**」而不是「保证」。

⚠️ 两个当时的环境事实，别当成一般性结论：那一轮跑在 **Windows + Node 24.x**；
两个宿主实例同时开着时，**先起来的那个不会因为 `job_kill` 而退出**（Windows 上进程树没被带走），
要按监听端口找到进程显式结束。


---

## 4. 每条契约 → sage-mem 的哪个决定

| 宿主契约 | sage-mem 现在怎么用它 | 拿不到时的降级 | 对应决定 |
|---|---|---|---|
| `ctx.on('system-prompt/assemble', …)`（waterfall） | 注入主链：`lib/index.js:230` | 整条链包在 try/catch 里（`lib/index.js:431` 的 `recall injection failed`），**只降级、必留痕** | 注入链的生存性外壳 |
| `ctx.get(name)` / `ctx[name]` 服务解析 | `svc()`：`lib/autodream/engine.js:90-93` | **现状不够**：没 inject 时后半句会抛。当前靠 `MemoryGateway` 构造函数的 try/catch（`lib/index.js:194-198`）兜住，代价是 autodream 整块不启动 + 一行 warn | **D5**：拿不到就不阻断注入链 —— 探针实测出「会抛」这条，正说明 D5 不是纸面条款 |
| `tools.register(definition)` | **0.9.15 未接**（有断言盯着零调用） | 后续版本接的时候：探测（`ctx.get('tools')?.register`）必须自带 try/catch，且 `apply` 里声明 `inject` 才拿得到 | D5 的前置：注册失败 ≠ 注入失败 |
| `tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result` | **0.9.15 未订阅**（后续要拿工具结果回写记忆才需要） | 不订阅就没有这块功能，注入链一无所知、也一无所失 | 计划的「监听 tools/result」 |
| `ctx.fs.writeText` / `editText`（`FS_STALE_VERSION`） | **0.9.15 未用**：记忆落盘走 `node:fs` + 原子写（`lib/memory/util.js`） | 不用就没有降级问题；将来若改用宿主 fs，必须自己处理过期版本码（宿主**不**替你重试） | 未决（本轮不动） |
| `ctx.tokenMeter.measure` | **0.9.15 未用**：注入预算按自己记的字节账本算（`lib/index.js` 的 `injectLedger`） | 不依赖宿主计量 → 宿主没有也不影响 | 预算口径自持 |
| `ctx.compaction` | **0.9.15 未用**：压缩感知靠「消息条数变小」这个信号（`injectLedger` 归零） | 同上 | 不把压缩 API 变成硬依赖 |
| `fs/write-intent` / `fs/edit-intent` | **0.9.15 未订阅**（写入门在 task-9） | 不订阅就没有写入门；**要订阅就必须抢早**：实测声明 `inject` 后窗口已过，一次都收不到（第 3.3 节事实 4）。这与 D5 的 `ctx.inject` 子 fiber 接法冲突，取舍未定 | **D5 与写入门冲突点**（本轮只记录，不裁决） |
| `fs/observed` | **0.9.15 未订阅** | emit 类事件不受注册窗口影响（子 fiber 里也收得到），将来要用没有上述限制 | 未决 |
| `ctx.reflect.props`（声明表） | 只在探针里用 | 探针查不到时写 `null`（**不是**「宿主没有」） | 观测手段，非产品依赖 |

**一句话读这张表**：sage-mem 0.9.15 真正依赖的宿主契约只有两条 ——
`system-prompt/assemble` 事件与 `ctx.get`/`ctx[name]` 式的服务解析；
其余（tools / 工具与 fs 事件 / fs / tokenMeter / compaction）都还没接，
**没接就是最彻底的降级**。而「准备接」的那几条里，`fs/write-intent` 有一个额外的
**注册时机**门槛 —— 它不是「拿到服务就能收到」的事件。

---

## 5. 断言（`test/host-facts-test.mjs`，82 条）

### 5.1 降级契约（第 0–7 组）

六个场景，每个都回答同一个问题「注入链还活着吗」：

| # | 场景 | 断言要点 |
|---|---|---|
| 0 | 量具自检 | 老宿主 mock 里 `ctx.get` **真不是函数**（防被万能 Proxy 桩兜成假绿）；工具间谍真的会记到调用（防「零次」是空断言） |
| 1 | 老宿主：`ctx.get` 不存在 | 构造不抛、assemble 不抛、记忆照样注入、段名对、零注册 |
| 2 | `ctx.get('tools')` 返回 `undefined` | 同上 |
| 3 | `ctx.get('tools')` 返回没有 `register` 的对象 | 同上 |
| 4 | `ctx.get` 自己抛错 | 同上 **+ 必须响一次**（warnLog 一行 + stderr 一行）—— 降级不等于静默 |
| 5 | 工具服务健康 | 同上 **+ `tools.register` 仍必须零调用**（防半落地代码） |
| 6 | `tools.register` 抛错（服务半接上） | 注入链不受影响 |
| 7 | 老宿主下不破坏宿主已组装的内容 | 原 `sections` 原样保留、`contexts` 是「原有的 + 新增一条」 |

每个场景另外走 6 步 assemble，断言降级提示**不随步数增长**（不是每步刷屏）。

### 5.2 探针检查器（第 8 组）

探针只在真实宿主里跑，它的绿很容易是「计数器根本没接上」造成的假绿（全 0 也能凑出 pass）。
所以第 8 组把探针里的纯函数 `evaluateChecks()`（8 条检查）拿**合成观测**打两面：

- 健康观测必须全绿（`pass` 数 = 检查数，零 `fail` / 零 `inconclusive`）；
- 本轮没触发时逐条是 `inconclusive`（**不许**读成 pass）；
- 探针自己坏掉时逐条会红：`exec` 少了 `name`/`agent`、`tools/result` 有数而 `pre-execute`
  没数、工具名只在 `tools/result` 出现、`exec.name` 不可读、监听器没挂上；
- 写实验「写失败」或「还没跑完」判 `inconclusive`，插件自己写却发了写入门事件判 `fail`；
- 「模型写了而写入门没到」判 `fail`（第 3.3 节事实 4 的落点），没写类工具时判 `inconclusive`。

这一组是「探针在真实宿主里报的绿算不算数」的前提：真实宿主里跑的是同一份函数。

**变异验证（防「这个测试永远不会红」）**：把 `lib/` 复制到临时目录，往 `MemoryGateway`
构造函数里插一句无保护的 `ctx.get('tools').register({...})`，再跑同一个套件 ——
**16 条断言转红**（场景 1/2/3/4/6 的「构造不抛错」「记忆照常注入」，场景 5/6 的「零注册」，
场景 4 的「响一次」），最终 exit 1。仓库里的 `lib/` 全程没被动过。

---

## 6. 我没能验证 / 不确定的部分

1. **~~`web` profile 没跑过探针~~ —— 2026-10-16 已跑，见第 3.5 节**。
   结论：不声明 `inject` 的早注册监听器在 web 上**收得到** `fs/write-intent`（2 次），
   `system-prompt/assemble` 与 `tools/*` 链照常派发，`checksSummary` **pass 7 · fail 0 · inconclusive 1**。
   仍未做到的：这只是**一次实测**，没有回归断言（CI 里没有宿主），次数也少（一轮对话）。
2. **`desktop` profile 没跑过探针** —— 2026-10-16 **重新确认并且更严格**：不只是「加不了 `--patch`」，
   `dsh --profile desktop --dump-config` 与 `--dump-default-config` **都被拒绝**：
   `error: profile "desktop" is managed exclusively by the Electron application`。
   也就是说连**只读的配置合成**都进不去，探针只能走 GUI 侧通道或临时试验 profile。
   第 3.2 节的 desktop 事实来自 Host Inspect 查询，它证明「宿主里有这个服务 / 这个事件」，
   **不证明**「一个不声明 inject 的插件能拿到它」—— 后者目前只在 headless 与 web 上实测过。
3. **`ctx.reflect.store` / `ctx.events._hooks` / `ctx.reflect.props` 都是 cordis 内部结构**
   （下划线 / 非公开字段）。它们变了只会让探针报 `null`，不会让产品出问题 ——
   但这意味着探针的某些字段会随 cordis 升级而失效。第 3.1 节里「声明表」的结论就建立在这上面。
   另外 `ctx.reflect.store` 还**随加载时机变化**（8 / 58 / 0 / 41 都是实测过的数字），
   拿它当「宿主有没有某服务」的判据会得出假结论。
4. **7 组对照每组只跑 1–3 轮**，且模型的工具调用次数每轮不同（`tools/result` 在 2–9 之间波动）。
   `fs/write-intent` 的 1 vs 0 是二元结果、重复一致，但这是**行为观测**，不是受控实验。
5. **第 3.3 节事实 4 的机制只追到「注册窗口」为止，没到源码级**：证明了「晚注册收不到、
   早注册收得到」，也排除了作用域 / 插件自己写 / fs 专属三种解释，但**没有**去读 DSH 侧
   固定监听器名单的那段实现。「窗口在 fs 服务就绪之前关闭」是从 F 组（子 fiber 在 fs 就绪时
   挂载即已错过）反推的，不是读代码读出来的。
6. **「早注册 + 事件到达时用 `ctx.get('fs', false)` 取服务」这条折中路线 —— 已验（0.9.19 起）**。
   不声明 `inject` 时，处理器内部 `ctx.get('fs')` 拿得到服务（`hasFs` / `hasStat` 均为真），
   代码里走的就是这条路线。2026-10-16 的 web 那次也一致：`load` 阶段两份 `present=false`，
   到回合那一份已经是 `present=true`（服务是一个个挂上去的），而 `fs/write-intent` 同时记到了 2 次。
7. **`ctx.reflect.store` / `ctx.events._hooks` / `ctx.reflect.props` 都是 cordis 内部结构**
   （下划线 / 非公开字段）。它们变了只会让探针报 `null`，不会让产品出问题 ——
   但这意味着探针的某些字段会随 cordis 升级而失效。第 3.1 节里「声明表」的结论就建立在这上面。
   另外 `ctx.reflect.store` 还**随加载时机变化**（8 / 58 / 0 / 41 都是实测过的数字），
   拿它当「宿主有没有某服务」的判据会得出假结论。
8. **事件计数在「这一轮没触发」时全是 0**（例如没让模型调工具的那轮）：
   **0 = 没触发，不是「事件不存在」**。探针把这种情况判成 `inconclusive` 就是为了防误读。
9. **`.length` 只是形参个数**，不是必填个数，也不含 optional 标记。第 3.1 节的签名表
   只能用来判断「方法还在不在 + 形状大致变没变」，精确签名看第 3.2 节。
10. **模式 B / 各诊断开关里的 `inject` 都是探针自己的**（用环境变量开关），
    不代表 sage-mem 声明过它。⚠️ **2026-10-16 更正**：这里原先写「仓库里 sage-mem 目前
    **没有**任何 `inject` 声明」——**那句是错的**，`lib/index.js` 里有 `ctx.inject(['tools'], …)`
    （工具挂子 fiber，D5 的接法）。那句话想说的是「**`fs` 没有声明 `inject`**」，
    而这正是第 3.3 节事实 4 那个注册窗口的由来。
