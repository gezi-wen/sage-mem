# sage-mem 的宿主事实（2026-10-15 核验）

**一句话**：sage-mem 依赖的宿主能力分两档 —— **有就拿、没有就整块跳过**。
本文把「哪些能力真的在」与「拿不到时会怎样」写成可复核的记录，而不是口头假设。

- **可重跑断言**：`node test/host-facts-test.mjs`（降级契约，53 条）
- **真实宿主探针**：`node scripts/host-facts-probe.mjs` —— ⚠️ 这条命令**跑不了**，它是
  插件不是脚本。正确步骤见下面第 2 节（也是探针文件头那段）。

---

## 1. 结论先摆出来（按重要性排）

1. **不声明 `inject` 时，`ctx.<服务名>` 会抛，`ctx.get('<服务名>')` 只给 `undefined`。**
   实测原文：`cannot get property "tools" without inject`。
   这条直接决定降级怎么写：`ctx.get(a) ?? ctx[a]` 这种「先 get 再取属性」的写法在服务缺失时
   **不是返回 undefined，而是抛**。`lib/autodream/engine.js:90-93` 的 `svc()` 就是这个形状 ——
   它现在只被 `MemoryGateway` 构造函数的 try/catch（`lib/index.js:194-198`）兜住，
   一旦有人把 `svc()` 用到注入链里，异常就会升级成「记忆不注入」。
2. **要塞的工具能力，宿主确实有**：`tools` 服务由 `ToolRuntime` 提供，`register` 是
   1 参函数（`register(definition)` → disposer）。事件 `tools/pre-execute` / `tools/execute` /
   `tools/post-execute`（waterfall）与 `tools/result`（emit）四个名字上**都挂着宿主自己的监听**。
3. **0.9.15 一个都还没接**：`ctx.tools.register` 在构造过程中零调用（有断言盯着，
   还做过变异验证 —— 见第 5 节）。所以本轮打的是**降级契约**，不是功能。
4. **服务的声明是逐步长出来的**：同一个进程里 `props`（声明表）从 24 条长到 80 条
   （声明了 inject 的那次是 81 → 86）。插件 `apply()` 那一刻看不到全貌 ——
   要判「宿主一共有什么」得看收尾阶段，要判「我启动时能不能拿到」才看启动阶段。
5. **`ctx.get` 的严格读依赖「提供方 fiber 处于 ACTIVE」**：启动阶段严格读拿得到实现，
   收尾阶段拿不到（提供方已经离开 ACTIVE），只有 `ctx.get(name, false)` 还拿得到。

---

## 2. 怎么复核探针（三条命令，2026-10-15 全部实跑过）

```powershell
# step 1：生成 overlay（写 %TEMP%，不碰仓库 / 不碰任何 profile 配置）
$probe = (Resolve-Path '<仓库目录>\scripts\host-facts-probe.mjs').Path -replace '\\','/'
$yml   = Join-Path $env:TEMP 'sage-mem-host-facts-probe.yml'
"- insert:`n    - id: sage-mem-host-facts-probe`n      name: '$probe'" | Set-Content -Encoding ascii $yml

# step 2a：模式 A —— 不声明 inject（sage-mem 0.9.15 的现状）
dsh --profile headless --patch $yml "只回复 ok，不要调用任何工具"

# step 2b：模式 B —— 声明 inject 之后服务到底拿不拿得到
$env:SAGE_MEM_PROBE_INJECT = 'tools,systemPrompt,fs,tokenMeter,compaction'
dsh --profile headless --patch $yml "只回复 ok，不要调用任何工具"
Remove-Item Env:\SAGE_MEM_PROBE_INJECT
```

产物（每个阶段各一份，别只看最后一份）：

| 文件 | 看什么 |
|---|---|
| `%TEMP%\sage-mem-host-facts-probe.load.json` | **服务可达性的主证据**：插件 `apply()` 那一刻能拿到什么 |
| `%TEMP%\sage-mem-host-facts-probe.dispose.json` | 声明表全貌（`props` 已长齐）+ 事件被动计数 |
| `%TEMP%\sage-mem-host-facts-probe.json` | 最后一次写入（= 最新阶段）；headless 的 stdout 也有同样内容 |

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
| `ctx.reflect.props`（声明表） | 只在探针里用 | 探针查不到时写 `null`（**不是**「宿主没有」） | 观测手段，非产品依赖 |

**一句话读这张表**：sage-mem 0.9.15 真正依赖的宿主契约只有两条 ——
`system-prompt/assemble` 事件与 `ctx.get`/`ctx[name]` 式的服务解析；
其余五条（tools / 四个事件 / fs / tokenMeter / compaction）都还没接，
**没接就是最彻底的降级**。

---

## 5. 降级契约的断言（`test/host-facts-test.mjs`）

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

每个场景另外走 6 步 assemble，断言降级提示**不随步数增长**（不是每步刷屏）。

**变异验证（防「这个测试永远不会红」）**：把 `lib/` 复制到临时目录，往 `MemoryGateway`
构造函数里插一句无保护的 `ctx.get('tools').register({...})`，再跑同一个套件 ——
**16 条断言转红**（场景 1/2/3/4/6 的「构造不抛错」「记忆照常注入」，场景 5/6 的「零注册」，
场景 4 的「响一次」），最终 exit 1。仓库里的 `lib/` 全程没被动过。

---

## 6. 我没能验证 / 不确定的部分

1. **`web` profile 没跑过探针**。`dsh --profile web --patch $yml` 会长期监听（不是一次性），
   本次没启。web 与 headless 共用同一套 DSH 包，大概率一致，但**这是推断不是实测**。
2. **`desktop` profile 没跑过探针**（CLI 加不了 `--patch`）。第 3.2 节的 desktop 事实来自
   Host Inspect 查询，它证明「宿主里有这个服务 / 这个事件」，**不证明**「一个不声明 inject 的
   插件能拿到它」—— 后者只有 headless 上的探针实测过。
3. **`ctx.reflect.store` / `ctx.events._hooks` / `ctx.reflect.props` 都是 cordis 内部结构**
   （下划线 / 非公开字段）。它们变了只会让探针报 `null`，不会让产品出问题 ——
   但这意味着探针的某些字段会随 cordis 升级而失效。第 3.1 节里「声明表」的结论就建立在这上面。
   另外 `ctx.reflect.store` 还**随加载时机变化**（8 / 58 / 0 / 41 都是实测过的数字），
   拿它当「宿主有没有某服务」的判据会得出假结论。
4. **事件 `observed` 的语义边界**：本次 headless 那一轮没有工具调用，所以
   `tools/*` 四个事件的 observed 是 0。**0 = 没触发，不是「事件不存在」**；
   要坐实它们的派发，得让那一轮真的调一次工具（本次没做）。
5. **`.length` 只是形参个数**，不是必填个数，也不含 optional 标记。第 3.1 节的签名表
   只能用来判断「方法还在不在 + 形状大致变没变」，精确签名看第 3.2 节。
6. **模式 B 的 `inject` 是探针自己的**（用环境变量开关），不代表 sage-mem 已经声明了它 ——
   仓库里 sage-mem 目前**没有**任何 `inject` 声明。
