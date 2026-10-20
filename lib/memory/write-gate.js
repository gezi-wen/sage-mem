/**
 * sage-mem 记忆层 —— 写入门：给记忆目录的写入补上**版本守卫**。
 *
 * ## 它为什么存在
 *
 * 宿主的 `fs/write-intent` / `fs/edit-intent` 会**在写入之前**问插件一次：「这次写入按什么
 * 意图做」。没有插件回答时，一次「读-改-写」之间只要有人插进来写过，后写的那个就**静默**
 * 把前一个覆盖掉 —— 谁也不报错，谁也不知情。
 *
 * 本模块的回答是：目标在记忆目录内、且我们已经知道它的当前版本时，把这次写入钉在
 * `replaceIfVersion(当前版本)` 上。于是并发写入不再互踩，而是由宿主报出 `FS_STALE_VERSION`，
 * 交给上层（冲突队列 / 人）决定怎么办。
 *
 * ## ⚠️ 两个事件都**没有「拒绝」这个动作**
 *
 * 它们是**单槽意图决策**：只能决定写入**意图**（`createIfAbsent` / `replaceIfVersion`）或编辑
 * **守卫**（`{version}`），不能阻止写入。所以这里**没有 deny、没有 null、没有抛错**——
 * 只有「给意图」「给守卫」和「不管」（返回 `undefined`）。唯一的失败信号是宿主自己报的
 * `FS_STALE_VERSION`，我们只需保证它报得出来。
 *
 * ## ⚠️ 这个事件只覆盖「工具发起的写入」（真实 headless 宿主实测）
 *
 * 宿主对这两个事件的派发范围比直觉窄：
 *
 * - **模型调内置 `write` / `edit`** 时派发（实测 `fs/write-intent = 1`：模型用 `write` 写了一个
 *   临时文件；监听器不需要声明 `inject` 也能收到，与 sage-mem 主插件的处境一致）。
 * - **插件自己调 `ctx.fs.writeText` / `editText` 时一次都不派发**（实测 0）。所以 autodream
 *   那类**插件内部写入不经过这里**，本模块也不假装能兜底它 —— 那条路由调用方自己传
 *   `expected`（`lib/autodream/tools.js` 就是这么做的）。
 *
 * 由此两条硬结论：
 *
 * 1. 这道门**确实拦得到**「模型直接改记忆文件」的写入 —— 这是它存在的意义，不是空想。
 * 2. 宿主的派发范围是**整个盘**（实测那一次的目标就在记忆目录之外），所以 `facts.memoryPath`
 *    的过滤是**唯一**一道屏障：没有它，我们就会去干涉整个盘的写入。这就是判定表把
 *    `outside_memory` 排在第一位、且必须返回 `undefined` 的原因。
 *
 * ⚠️ **集成侧的放行方式**：本模块给出 `undefined`（不管）时，监听器应当 `return next()` 把链
 * 放下去，**不要只计数不返回** —— 实测 `ctx.on(waterfallEvent, () => count++)` 会让宿主拿到
 * `undefined` 后去读它的 `.contexts`，整轮对话崩在 `Cannot read properties of undefined
 * (reading 'contexts')`。本模块不做订阅，只算结论。
 *
 * ## 判定表（顺序即优先级）
 *
 * | 条件 | reason | 返回 |
 * |---|---|---|
 * | 不是记忆目录里的路径（含目录本身、相对路径、根目录） | `outside_memory` | `undefined` |
 * | 调用方自己已经给了意图 / 守卫 | `caller_wins` | **原样透传**（同一个对象，不复制不改写） |
 * | 明确知道目标不存在（`exists === false`） | `created` | 写入：`createIfAbsent`；编辑：无守卫 |
 * | 不确知存在（`exists` 缺失 / 非布尔）且拿不到版本 | `no_version` | 写入：`createIfAbsent`；编辑：无守卫 |
 * | 存在且有版本 | `guarded` | 写入：`replaceIfVersion(版本)`；编辑：`{version: 版本}` |
 * | 其余（存在但没有可用的版本等） | `unknown` | `undefined`（**不猜**） |
 *
 * ## 三个容易做反的地方（都写进了断言）
 *
 * 1. **`outside_memory` 判在最前面，连「调用方给了什么」都不看。**
 *    单槽的含义是「第一个返回值的监听器拥有决策权」——所以在目录外**返回任何值**（哪怕只是
 *    原样回传调用方的意图）都会把这个槽占掉，后面的监听器再没有机会。只有返回 `undefined`
 *    才是字面意义上的「整个盘的其它写入完全不受影响」。目录内才轮到「尊重调用方」。
 * 2. **存在但没有版本 → `unknown`，绝不退化成 `createIfAbsent`。**
 *    这两件事的行为完全不同：`replaceIfVersion` 是「覆盖这份内容，除非它已经变了」，
 *    `createIfAbsent` 是「只在它不存在时才写」。退化等于把一次覆盖悄悄变成一次「已存在就失败」，
 *    而调用方拿到的理由会是错的。
 * 3. **版本是不透明值**：不解析、不比较大小、不当数字用，只做「是不是非空字符串」的形状检查
 *    然后**原样**放进意图里。宿主给什么就是什么。
 *
 * ## ⚠️ `exists` 必须是**观测到的**事实，不是回落值（接线实测踩到过）
 *
 * `exists !== true` 那条分支给的是 `createIfAbsent` —— 它是这里唯一不可能**静默覆盖**的意图，
 * 但目标其实存在时它是一次**误拦**：写入必然失败，而调用方（模型）拿到的是一个它无从理解的
 * 错误，它本来只是想改一份自己刚读过的记忆。
 *
 * 生产接线踩到的正是这里：原来写成 `exists: !!info`，于是「没有 `fs` 服务 / stat 抛错」这种
 * **探不到**被压成了 `false` —— 一个看起来像事实的回落值，与 `access.js` 那次「扫 A 目录写 B
 * 台账」属于同一类错误。
 *
 * 所以：`exists: false` 只允许表示「**明确探到不存在**」（stat 的 ENOENT）。**探不到**不是
 * `false`，是「不知道」—— 那种情况**不要调用本模块**，接线应自行短路成「不碰」（生产路径
 * `lib/index.js` 就是这么做的：探不到就把调用方的意图原样交回）。判定表对「调用方没给
 * `exists`」仍然有确定的答案（`no_version`，见下），但那是**契约的确定性**，不是鼓励拿
 * 「不知道」去换一个意图。
 *
 * `facts.toolWrite`（是否来自内置 `write` / `edit` 工具）**不参与判定**：判据只有四个
 * 「在不在目录内 / 确不确知存在 / 有没有版本 / 调用方给没给」。把「谁在写」也变成分支，
 * 就是同一件事的第二套判据。它留在 facts 里供调用方记录与排查。
 *
 * 路径判据一律走 `paths.js`（与 `observe.js` 同一个函数），**本模块不写第二份**。
 */

import { memoryPathOf } from './paths.js'

export const GATE_REASONS = Object.freeze([
  'outside_memory', // 目标不在记忆目录内 → 不管
  'no_version', // 目标不存在且拿不到版本 → createIfAbsent
  'created', // 目标不存在 → createIfAbsent
  'guarded', // 目标存在 → replaceIfVersion(version)
  'caller_wins', // 调用方自己已经给了意图/守卫 → 原样透传（**尊重调用方**）
  'unknown', // 信息不足 → 返回 undefined（不猜）
])

/** 目标位置的三种结论：在目录内 / 不在目录内 / 说不清。 */
function locationOf(facts) {
  const mp = facts.memoryPath
  // 主契约：调用方已经把 paths.js 的 memoryPathOf 结果算好了。只认带布尔 ok 的对象，
  // 免得一个形状不对的字段被当成「不在目录内」（那是把一个错误悄悄读成一个结论）。
  if (mp && typeof mp === 'object' && typeof mp.ok === 'boolean') {
    return { inside: mp.ok === true }
  }
  // 便捷入口：只给了原始路径就现算 —— 仍然走 paths.js 的**同一个** memoryPathOf，
  // 所以两条路不可能判出两个结果（这正是把判据抽出去的目的）。
  if (typeof facts.path === 'string' && facts.path !== '') {
    return { inside: memoryPathOf(facts.path, facts.memoryDir).ok === true }
  }
  return { unknown: true }
}

/**
 * 核心判定：把 facts 压成「给什么 / 为什么」。
 *
 * 两个公开函数（写入意图、编辑守卫）共用它，是为了让 reason 的含义在两条路上完全一致 ——
 * 分成两份实现，迟早出现「同一个事实在写入侧叫 created、在编辑侧叫 unknown」这种漂移。
 *
 * @returns {{reason:string, caller?:*, create?:boolean, version?:string}}
 */
function gate(facts) {
  if (!facts || typeof facts !== 'object') return { reason: 'unknown' }

  const where = locationOf(facts)
  if (where.unknown) return { reason: 'unknown' }
  // 先判位置，理由见文件头第 1 条：目录外返回任何值都会占掉单槽。
  if (!where.inside) return { reason: 'outside_memory' }

  // 尊重调用方：他给了就原样透传，我们只是**补充**守卫的，不覆盖他的意图。
  // `null` 与 `undefined` 一起当「没给」—— 宿主的契约里「没给」就是 undefined。
  if (facts.caller !== undefined && facts.caller !== null) {
    return { reason: 'caller_wins', caller: facts.caller }
  }

  // 只认严格的 `exists === true` 为「确知存在」；缺失 / 非布尔一律按「不确知」处理（不猜）。
  if (facts.exists !== true) {
    // 「明确不存在」与「不确知存在」给不同 reason：前者是确定的事实，后者是信息不足，
    // 但两者都只能给 createIfAbsent —— 它是这里唯一**不可能静默覆盖**的意图。
    // ⚠️ 正因为这个分支会 createIfAbsent，接线**不许**把「探不到」写成 `exists: false`
    // （那是误拦，见文件头那节）；`no_version` 是给「调用方确实没给这个字段」的确定答案。
    return facts.exists === false ? { reason: 'created', create: true } : { reason: 'no_version', create: true }
  }

  // 版本是不透明的非空字符串。空串 / 非字符串一律当「拿不到版本」：拿一个形状不对的东西
  // 去构造 replaceIfVersion，只会换来宿主一句看不懂的报错。
  const version = typeof facts.version === 'string' && facts.version !== '' ? facts.version : null
  if (version === null) return { reason: 'unknown' }
  return { reason: 'guarded', version }
}

/**
 * 决定一次**整份写入**的意图。纯函数：只吃已观测到的事实，不读盘、不看时钟、不抛。
 *
 * @param {object} facts `{memoryPath, exists, version, caller, toolWrite?, path?, memoryDir?}`
 * @returns {{intent: {kind:'createIfAbsent'}|{kind:'replaceIfVersion',version:string}|undefined, reason:string}}
 *   `undefined` = 不管 / 不猜（**不是拒绝**：宿主照它自己的默认继续）。
 */
export function decideWriteIntent(facts) {
  try {
    const d = gate(facts)
    if (d.reason === 'caller_wins') return { intent: d.caller, reason: d.reason }
    if (d.create) return { intent: { kind: 'createIfAbsent' }, reason: d.reason }
    if (d.reason === 'guarded') return { intent: { kind: 'replaceIfVersion', version: d.version }, reason: d.reason }
    return { intent: undefined, reason: d.reason }
  } catch {
    // 调用方的 facts 可能来自带抛错 getter 的对象。写入门在宿主的写入链路上，
    // 抛出去会把一次正常写入炸掉 —— 任何意外都退化成「不管」，让写入按默认语义走。
    return { intent: undefined, reason: 'unknown' }
  }
}

/**
 * 决定一次**编辑**的守卫。与 `decideWriteIntent` 同一张判定表，只是输出改成一个版本守卫。
 *
 * 编辑没有「创建」这个动作，所以 `created` / `no_version` 两条在这里都返回**无守卫**
 * （`undefined`）—— 文件不存在时该不该创建由宿主与调用方决定，不是我们替它决定。
 *
 * @returns {{guard: {version:string}|undefined, reason:string}}
 */
export function decideEditGuard(facts) {
  try {
    const d = gate(facts)
    if (d.reason === 'caller_wins') return { guard: d.caller, reason: d.reason }
    if (d.reason === 'guarded') return { guard: { version: d.version }, reason: d.reason }
    return { guard: undefined, reason: d.reason }
  } catch {
    return { guard: undefined, reason: 'unknown' }
  }
}
