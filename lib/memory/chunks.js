/**
 * sage-mem 记忆层 —— 正文分段：把一份记忆切成可检索、可定位的段落。
 *
 * 为什么要有这一层：检索原先只比 `description` + `aliases` + 文件名（见 retrieval.js），
 * 换来的是「噪音大幅下降」，代价是**摘要没写到的内容永远检索不到**。要补这个漏，
 * 就得让正文参与匹配 —— 但**不能让整份文件参与匹配**：那会重演旧版的病
 * （长文件什么都能蒙中）。所以改变评分单位：**用段落匹配问题，再把最佳段落归并回文件**，
 * 而不是把一份文件的所有命中次数加起来。
 *
 * 三个必须守住的约束：
 *   1. **行号是 1-based、相对整份文件**（含 frontmatter 那几行）。`read_memory` 的
 *      `startLine` 直接吃这个值，中间不许再换算一次 —— 换算是这类功能最常见的错位来源。
 *   2. **revision 是内容 hash，不是路径或标题**。路径会改名、标题会改写，两者都不是身份。
 *   3. **frontmatter 不进段落**。它的键名（`name` / `description` / `node_type`…）在每份
 *      文件里都一样，进了正文索引就等于给每条记忆灌入同一批高频词，正好抬高通用词的 df。
 */

import { createHash } from 'node:crypto'

/** 目标段落长度（字符）。低于它就与邻居合并，避免碎片段把候选表塞满。 */
export const CHUNK_TARGET_CHARS = 600

/** 硬上限：超过就切。定在目标的 1.5 倍，留出「一行稍长就整段爆掉」的余量。 */
export const CHUNK_MAX_CHARS = 900

/**
 * 独立成段的门槛（字符）。
 *
 * 低于它的段落优先并入相邻段：一条 `- 记完了` 这样的项目符号独立成段，既占一个候选位、
 * 又几乎没有任何可匹配的词。合并是**就近向上**（并进已经攒好的上一段），因为 markdown
 * 里短行通常是上一段同一主题的补充。
 */
export const CHUNK_MIN_CHARS = 60

/**
 * 内容 revision：`sha256:<前 12 位>`。
 *
 * 12 位十六进制 = 48 bit，对本场景（一份记忆目录内区分版本）绰绰有余，而短到能塞进
 * 注入的状态卡与工具响应里不心疼。**它只表示「内容变了」，不表示「更新了」** ——
 * 加一行注释也会换 revision，这不是错误信息，是「你之前读到的正文已经不是现在这份」。
 */
export function revisionOf(content) {
  const hex = createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')
  return `sha256:${hex.slice(0, 12)}`
}

/**
 * frontmatter 块的结束行（1-based）；没有 frontmatter 返回 0。
 *
 * 判定刻意与 `frontmatter.js` 的正则同形（首行必须是整行 `---`，结束取**第一个**
 * 行首 `---`），否则会出现「frontmatter 解析出来有 description，分段却把它当正文」
 * 这种两边不一致的怪状态。
 */
export function frontmatterEndLine(lines) {
  if (String(lines?.[0] ?? '').trim() !== '---') return 0
  for (let i = 1; i < lines.length; i++) {
    if (String(lines[i]).trim() === '---') return i + 1
  }
  return 0
}

/**
 * 把一份记忆切成段落。
 *
 * @param {{file:string, content:string}} f — `scanMemoryFiles` 的条目
 * @param {string} [knownRevision] — 调用方已经算过 revision 时传进来，省一次对整份正文的 sha256
 * @returns {Array<{id:string,file:string,revision:string,headingPath:string,startLine:number,endLine:number,text:string}>}
 */
export function chunkFile(f, knownRevision) {
  const file = String(f?.file ?? '')
  const content = String(f?.content ?? '')
  const revision = typeof knownRevision === 'string' && knownRevision ? knownRevision : revisionOf(content)
  const lines = content.split(/\r?\n/)
  const from = frontmatterEndLine(lines)
  const out = []
  // id 去重表：**必须去重**，因为「单行超长」那条路径会把一行按字符切成多片，
  // 而它们共享同一个行号 → 光用行号当 id 会撞车（实测一份含 5000 字符单行的文件
  // 产出 10 个片段、去重后只剩 2 个）。撞车会让「按 id 取回某一段」取到错的那片。
  // 常见情形（一行以内）保持 `file#起-止` 的可读形式，只有撞车时才追加 `~n`。
  const idSeen = new Map()
  for (const block of mergeBlocks(splitBlocks(lines, from))) {
    for (const piece of splitOne(block)) {
      const base = `${file}#${piece.startLine}-${piece.endLine}`
      const n = idSeen.get(base) ?? 0
      idSeen.set(base, n + 1)
      out.push({
        id: n === 0 ? base : `${base}~${n}`,
        file,
        revision,
        headingPath: piece.headingPath,
        startLine: piece.startLine,
        endLine: piece.endLine,
        text: piece.text,
      })
    }
  }
  // 空段落（整块只有空白）不产出：它们没有可匹配的词，只会稀释 df。
  return out.filter(c => c.text.length > 0)
}

/**
 * 第一批：按标题与空行切出「原生块」。
 *
 * **每行带着自己的行号**（`{no, text}`），不是裸字符串 —— 合并与再切分之后行号仍要准确，
 * 而「用内容反查行号」在有重复行的文件里必然出错（`---`、空行、重复的项目符号）。
 *
 * 围栏代码块里的空行不算分段点：一段代码被空行切成两半，两边都不再是完整的可读内容，
 * 第二半的标题路径也指不对。
 */
function splitBlocks(lines, from) {
  const blocks = []
  const stack = []
  let cur = null
  let pendingHead = []
  let inFence = false
  const flush = () => {
    if (cur && cur.raw.length) blocks.push(cur)
    cur = null
  }
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence) {
      const h = line.match(/^(#{1,6})[ \t]+(.+?)[ \t]*$/)
      if (h) {
        flush()
        const level = h[1].length
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
        stack.push({ level, text: h[2] })
        // **标题行本身要留在下一段的正文里**（不是只记进 headingPath）。
        // 只记 headingPath 会丢字：一段横跨 `## 解决办法` 与 `## 无关小节` 的合并段落，
        // 只有起始标题进索引，「解决办法」这四个字在检索面上等于不存在。
        // 连续多个标题攒在一起，等下一条正文行来了再一起种进新块（避免产出只有标题的空段）。
        pendingHead.push({ no: i + 1, text: line })
        continue
      }
      if (line.trim() === '') {
        flush()
        continue
      }
    }
    if (!cur) {
      cur = {
        startLine: pendingHead[0]?.no ?? i + 1,
        endLine: i + 1,
        raw: pendingHead.slice(),
        headingPath: stack.map(s => s.text).join(' › '),
      }
      pendingHead = []
    }
    cur.endLine = i + 1
    cur.raw.push({ no: i + 1, text: line })
  }
  flush()
  return blocks
}

/** 第二批：过短的块往上一块合并，直到接近目标长度。 */
function mergeBlocks(rawBlocks) {
  const out = []
  for (const b of rawBlocks) {
    const text = b.raw.map(l => l.text).join('\n').trim()
    if (!text) continue
    const prev = out[out.length - 1]
    // 用 `\n\n` 而不是 `\n` 拼接：两块之间**原本就隔着空行**，用单换行拼起来会让
    // 注入文本里两段粘成一整段。这条只在「合并」路径上出现；被切分的单块内部是连续行，
    // 那边的 `\n` 才是对的 —— 两条路径互斥（合并只到 600，切分只对 > 900 的原始块）。
    if (prev && text.length < CHUNK_MIN_CHARS && prev.text.length + text.length + 2 <= CHUNK_TARGET_CHARS) {
      prev.text = `${prev.text}\n\n${text}`
      prev.endLine = b.endLine
      prev.raw = prev.raw.concat(b.raw)
      continue
    }
    out.push({ startLine: b.startLine, endLine: b.endLine, headingPath: b.headingPath, raw: b.raw, text })
  }
  return out
}

/**
 * 第三批：超过硬上限的块按行切成多个片段。
 *
 * **单行超长的情形单独处理**：一份把日志或代码贴成一行的记忆，按行切分永远切不动
 * （一个片段 = 那一整行），于是「长度归一」失效、候选位被一行占满。这里按字符硬切，
 * 该行的行号由所有片段共享 —— 段落级的行号本来就不承诺精确定位到字节。
 */
function splitOne(block) {
  if (block.text.length <= CHUNK_MAX_CHARS) return [block]
  const out = []
  let buf = []
  let start = 0
  let end = 0
  const emit = () => {
    if (!buf.length) return
    const text = buf.join('\n').trim()
    if (text) out.push({ startLine: start, endLine: end, headingPath: block.headingPath, text })
    buf = []
  }
  for (const { no, text: line } of block.raw) {
    if (line.length > CHUNK_MAX_CHARS) {
      emit()
      for (let i = 0; i < line.length; i += CHUNK_TARGET_CHARS) {
        out.push({ startLine: no, endLine: no, headingPath: block.headingPath, text: line.slice(i, i + CHUNK_TARGET_CHARS) })
      }
      continue
    }
    const pending = buf.length ? buf.join('\n').length + 1 : 0
    if (pending + line.length > CHUNK_TARGET_CHARS) emit()
    if (!buf.length) {
      start = no
      end = no
    }
    end = no
    buf.push(line)
  }
  emit()
  return out
}
