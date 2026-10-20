/**
 * 注入文本的**组装**（1.2.0 从 `lib/index.js` 原样搬出）。
 *
 * 只有正文时：头部 + 引用纪律 + 正文 [+ 卡]
 * 只有卡时：**就只发卡** —— 头部那句「以下是与你当前问题相关的历史记忆」在没有正文
 * 的情况下是假陈述，而引用纪律管的是「别把记过的东西当当前事实」，没有正文就没有
 * 需要约束的对象。
 */
export function composeRecallText({ parts, cardPart, memoryDir, discipline }) {
  if (!parts.length) return cardPart || ''
  return `以下是与你当前问题相关的历史记忆（文件式，来自 ${memoryDir}）：\n\n` +
    `${discipline}\n\n${parts.join('\n\n')}` +
    (cardPart ? `\n\n${cardPart}` : '')
}
