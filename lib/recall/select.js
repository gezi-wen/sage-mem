/**
 * 注入链的**选材**阶段（1.2.0 从 `lib/index.js` 原样搬出，纯函数化）。
 *
 * 输入：`{ text, files, st }`（问题文本、扫到的记忆、会话状态快照）。
 * 输出：候选文件（`picked`，顺序即注入顺序）、检索签名、各条检索线的中间结果。
 *
 * 为什么单独一个文件：这一段以前埋在 348 行监听器里，只能 `new MemoryGateway(ctx)` 间接测；
 * 现在 `selectRecall()` 是纯函数，`test/recall-unit-test.mjs` 可以直接喂夹具。
 */
import { MAX_RESULTS } from '../memory/config.js'
import { selectBaseline, selectRelevant } from '../memory/retrieval.js'
import { detectIntent } from '../memory/intent.js'
import { rankChunks } from '../memory/search.js'

/**
 * 按文件去重，保留每个文件**首次**（也就是得分最高）出现的那条正文命中。
 *
 * 正文检索是段落粒度的，同一份文件可能返回多个段落。注入链要的是「这份文件要不要端上来」，
 * 所以在这里收成文件粒度 —— 而**不是**把同一文件的多个段落一起端上去：那正是
 * `retrieval.js` 当初从「全文匹配」退回「只比摘要」要躲开的病（长文靠段数多占满候选位）。
 */
export function dedupeByFile(hits) {
  const seen = new Set()
  const out = []
  for (const h of hits) {
    if (seen.has(h.file)) continue
    seen.add(h.file)
    out.push(h)
  }
  return out
}

/**
 * 选出这一步要端上去的文件。
 *
 * @param {{text:string, files:Array, st:object, maxResults?:number}} input
 * @returns {{picked:Array, baselineTaken:number, relevant:Array, intentInfo:object,
 *   bodyRanked:Array, bestChunk:Map, selected:Array, signature:string, deduped:boolean}}
 */
export function selectRecall({ text, files, st, maxResults = MAX_RESULTS }) {
  const picked = []
  const seen = new Set()
  const take = (f) => {
    if (seen.has(f.file)) return
    seen.add(f.file)
    picked.push(f)
  }

  // baseline：每个会话注入一次，**不看消息条数**。
  //
  // 旧写法 `if (userMessages.length === 0)` 依赖一个真实存在的时序：assemble
  // 触发时当前这条用户消息还没写进 session。已在 DSH 0.1.7-rc.1 上核实为真 ——
  //   宿主从 pending 队列取走本轮输入
  //   组装 system prompt（本监听器在这里跑）
  //   之后才把这条 user 消息落进 session
  // 所以全新会话首步 pick 到 0 条 user message，分支命中。
  //
  // 但**恢复 / 续聊会话**的历史消息早就在 session 里，条数永远 ≥ 1 → 分支永不
  // 命中 → 永不注入。而「继续吧」这类短问题在 description 里找不到匹配、检索
  // 返回 0 条，baseline 恰恰是那时唯一的兜底。这是本会话级状态要修的东西。
  let baselineTaken = 0
  if (!st.baselineDone) {
    selectBaseline(files)
      .forEach(f => {
        const before = picked.length
        take(f)
        if (picked.length > before) baselineTaken++
      })
    // 只有真取到才算「给过」：首步若正好撞上目录读不到（scanMemoryFiles 降级返回 []），
    // 整场会话就再也没机会补 baseline 了。宁可下一步重算一次。
    // 标记本身随这一步一起在 commit() 落 —— 与「提交放最后」同一条理由：
    // 没真注进去的东西不能记成「已经给过」。
  }

  // 检索签名只覆盖「检索出来的那批」，baseline 不再掺进这个签名。
  // 旧版两者共用 signature，首步签名一旦与后续某步相同，baseline 会连坐被吞；
  // 反过来，旧版把 baseline 文件名也算进签名，会让同一步的检索结果在下一步
  // 因签名变化而被重复注入。现在 baseline 由会话级标记保证只来一次，
  // 检索由这份签名保证同一问题不重复追加，两条线互不干扰。
  const relevant = text && text.length >= 2 ? selectRelevant(text, files) : []

  // ── 意图：先判，因为它要影响下面正文检索的**门槛松紧** ──
  // 用户是不是在问自己的历史（上次 / 之前 / 更正 / 问依据 / 继续）。
  // 判不出来就是 `none`，不猜 —— 误判的代价是把不该抑制的正文抑制掉。
  const intentInfo = text ? detectIntent(text) : { intent: 'none', historyDependent: false, suppressible: true }

  // ── 正文检索 ──
  // 摘要（description + aliases + 文件名）是最省的检索面，代价是**正文里的东西天生检索不到**。
  // 这里用它做两件事：
  //   1. 给候选文件定位「最相关的那一段」，注入时替代「文件开头 1500 字」——
  //      旧写法对任何问题都端同一段开头，等于把「命中在哪」这件事扔掉了；
  //   2. 摘要一条都没命中时，用正文兜一次底。此前这种情况直接等于「没有记忆可用」。
  //
  // query 短于 4 个字符不做正文匹配：`继续` 这种两个字的问题拿去匹配正文，
  // 命中的全是「继续」这个词本身，与用户问什么毫无关系。
  //
  // **门槛按意图放宽**：默认要求「连续命中 ≥ 2 个词元」（那条防的是跨词边界的假词元，
  // 见 search.js）。代价是整句只对上一个两字专名时会被拦下 —— 那是 0.9.16 有意付的。
  // 但用户**明确在问自己的历史**时，宁可多给一条也不该让他拿不到依据：这类问题的
  // 代价不对称（少给 = 答错，多给 = 多花一点上下文）。所以这时把 `minRun` 放到 1。
  const bodyRanked = typeof text === 'string' && text.length >= 4
    ? rankChunks(text, files, {
        limit: maxResults,
        perFile: 1,
        ...(intentInfo.historyDependent ? { minEvidence: { minRun: 1 } } : {}),
      })
    : []
  const bestChunk = new Map()
  for (const h of bodyRanked) if (!bestChunk.has(h.file)) bestChunk.set(h.file, h.chunk)

  // 「摘要命中就按摘要排；一条都没有才让正文接手」这个**保守写法是错的**，
  // 由评测数据推翻（scripts/eval-retrieval.mjs 的对照 + 注入链实测）：
  // 摘要只要命中**任何一条**（哪怕很弱、甚至命中错的文件），正文里那份真正相关的
  // 就再也没有机会——应注入的文件级召回从 87.0% 掉到 60.9%。而噪音并没有因此更低
  // （正文命中本来就要过相关性门槛，实测误召回 1/10，与保守写法持平）。
  //
  // 所以改成**并集**：摘要命中的在前（它经过人工写的 description，精确度高），
  // 正文独有的在后（按 BM25 + 证据强度排序）。`take` 按文件去重，
  // 同一份文件不会因为两条检索线都命中而占两个名额。
  const byFile = new Map(files.map(f => [f.file, f]))
  const selected = relevant.slice()
  const taken = new Set(selected.map(f => f.file))
  for (const h of dedupeByFile(bodyRanked)) {
    if (taken.has(h.file)) continue
    taken.add(h.file)
    const f = byFile.get(h.file)
    if (f) selected.push(f)
  }

  const signature = text + '\u0000' + selected.map(f => f.file).join(',')
  // 检索签名没变 = 这一代里这条问题已经处理过 → 不再重复追加同一份记忆。
  // ⚠️ 这个判断必须排在代次处理**之后**：压缩后的同题恢复，靠的就是上面 `begin()`
  // 把签名一起清掉（复审 R03）。
  const deduped = st.signature === signature
  if (!deduped) selected.forEach(take)

  return { picked, baselineTaken, relevant, intentInfo, bodyRanked, bestChunk, selected, signature, deduped }
}
