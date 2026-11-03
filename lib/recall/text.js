/**
 * 注入文本的**组装**（1.2.0 从 `lib/index.js` 原样搬出）。
 *
 * 只有正文时：头部 + 引用纪律 + **本轮上限** + 正文 [+ 卡]
 * 只有卡时：**就只发卡** —— 头部那句「以下是与你当前问题相关的历史记忆」在没有正文
 * 的情况下是假陈述，而引用纪律管的是「别把记过的东西当当前事实」，没有正文就没有
 * 需要约束的对象。
 *
 * 2.3.0：上限行**现读**传入（调用方从 `LIMIT_SPECS` 派生）。为什么不让随包技能写死
 * 这些数字：技能一旦发布就是第二份真相，插件改了上限它不会跟着改。现在数字只有
 * 一个来源 —— 这条刚刚打印出来的行。
 */
export function composeRecallText({ parts, cardPart, memoryDir, discipline, limits }) {
  if (!parts.length) return cardPart || ''
  const kb = (n) => Math.round(n / 1024)
  const limitLine = limits
    ? `> **本轮上限**（插件现读，随版本与设置变）：一次最多 ${limits.maxResults} 条、每条最多 ${limits.maxChars} 字、单会话累计 ${kb(limits.maxSessionBytes)} KB 到顶、单文件 ${kb(limits.maxFileBytes)} KB。\n\n`
    : ''
  return `以下是与你当前问题相关的历史记忆（文件式，来自 ${memoryDir}）：\n\n` +
    `${discipline}\n\n${limitLine}${parts.join('\n\n')}` +
    (cardPart ? `\n\n${cardPart}` : '')
}
