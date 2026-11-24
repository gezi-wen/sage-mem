/**
 * 提醒文案的渲染 —— **纯函数，零 I/O**。
 *
 * 三条口径，都是踩过坑才定下来的：
 *
 * 1. **不带 `{{ }}`**。注入链早就在 `recall/injector.js` 上吃过这个亏：宿主的
 *    prompt 模板会把双花括号当变量解析，正文里出现一对就抛
 *    `malformed prompt variable reference`，模型还没开跑就挂了。提醒走的是另一条
 *    路（user 消息，不过模板），但同一份纪律不因为路径不同就放松。
 *
 * 2. **明说「没有就忽略」**。提醒最坏的失败形态不是没提醒到，而是把模型从用户
 *    手上的活里拽出来、逼它编几条记忆填数。所以每一档结尾都给一条退路。
 *
 * 3. **数字全用实际算出来的值**，与 dsh-context 面板同一个触发线（见 `policy.js`）。
 *    写「快满了」这种定性描述，人和模型都没法判断还有多少步。
 *
 * 文案里出现的工具名只有 `search_memory` / `read_memory` —— 写入走宿主文件工具，
 * 这个插件自己没有写记忆的工具（`lib/assembly/tools-mount.js` 只注册三个读/裁工具）。
 */
import { fmtTokens, pct } from './policy.js'

/** 提醒消息的来源标识。也是面板/会话里认这条消息的唯一标记。 */
export const NUDGE_SOURCE_KIND = 'sage-mem:precompact'

/** 一句话摘要（UI 折叠时显示）。 */
export const NUDGE_SUMMARY = '压缩前记忆提醒'

const HEAD = '【sage-mem】'
const MEMORY_TODO = [
  '- 定下来的决定，以及为什么这么定',
  '- 查清的事实、踩过的坑（症状 → 根因 → 修法）',
  '- 下次要接着做的事',
].join('\n')

/**
 * 渲染一条提醒。
 *
 * @param {object} input
 * @param {'warn'|'urge'} input.tier
 * @param {string} input.memoryDir — 记忆目录（注入链同一份路径）
 * @param {number} input.totalTokens — 压缩**之前**测到的压力
 * @param {number} input.windowTokens
 * @param {number} input.enginePct — 引擎预计触发点（百分比）
 * @returns {string}
 */
export function renderNudge({ tier, memoryDir, totalTokens, windowTokens, enginePct }) {
  const head = `${HEAD}上下文约 ${fmtTokens(totalTokens)} / ${fmtTokens(windowTokens)}（${pct(totalTokens, windowTokens)}%）。`
  const engine = `这个会话的自动压缩预计在 ${enginePct}% 处触发。`
  const where = `写进记忆目录 \`${memoryDir}\`：新建一条 \`project_*.md\`，或在已有文件里补一段；动了清单就同步更新 \`MEMORY.md\`。写之前先用 \`search_memory\` 搜一下、\`read_memory\` 看看，别写重复的。`

  if (tier === 'urge') {
    return [
      `${head}${engine}也就是说随时会压 —— 被压掉的对话细节，之后你就看不见了。`,
      '',
      '只写真正要紧的（决定了什么、为什么、下一步做什么），别整段抄对话。' + where,
      '',
      '已经写完了、或者这个会话没什么值得留的，就忽略这条，继续手上的事。',
    ].join('\n')
  }

  return [
    `${head}${engine}再往后若干步，早先的对话细节就会被整段压掉，压掉之后就看不见了。`,
    '',
    '如果本会话里有值得跨会话留下的东西：',
    MEMORY_TODO,
    '',
    '现在' + where,
    '',
    '没有要留的就忽略这条，继续手上的事 —— 同一档位每次压缩前只发一次。',
  ].join('\n')
}

/**
 * 压缩**已经在本步发生**时用的文案。
 *
 * 为什么要单独一套：pre-step 里我们抢在引擎之前测压，但压力可能一步就从
 * 预警线跳到触发线以上 —— 那一步引擎当场就压了，此时再喊「快压缩了」是假话。
 * 这一档只说真话：已经压了、细节你看不到了、还记得就补记。
 *
 * 最后一句「别凭印象编」是有意的：被摘要替换之后模型并没有原文，
 * 让它「回忆」只会得到一段听起来合理、实际编造的记忆 —— 那比不记更坏。
 *
 * @param {object} input
 * @param {string} input.memoryDir
 * @returns {string}
 */
export function renderAfterCompaction({ memoryDir }) {
  return [
    `${HEAD}刚才这一步上下文被压缩了：早先的一整段对话已被摘要替换，具体细节你看不到了。`,
    '',
    `如果你还记得本会话里值得跨会话保留的东西（决定 / 事实 / 坑 / 待办），现在补记到 \`${memoryDir}\`：新建一条 \`project_*.md\` 或补进已有文件，动了清单就同步 \`MEMORY.md\`。`,
    '',
    '记不清具体内容就忽略这条 —— 别凭印象编。',
  ].join('\n')
}
