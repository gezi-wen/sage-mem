/**
 * sage-mem 记忆层 —— 目录扫描：读回全部记忆文件，以及星图要的轻量元数据。
 */

import { MEMORY_DIR } from './config.js'
import { parseBaseline, parseFrontmatter } from './frontmatter.js'
import { isMemoryEntry } from './naming.js'
import { warnLog } from './util.js'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 扫 memory 目录，读回全部记忆文件（跳过索引与子目录），并解析 frontmatter 摘要。 */
export async function scanMemoryFiles(ctx, sessionId) {
  try {
    const entries = await readdir(MEMORY_DIR, { withFileTypes: true })
    const names = entries
      .filter(e => e.isFile() && isMemoryEntry(e.name))
      .map(e => e.name)
    const loaded = await Promise.all(names.map(async (name) => {
      try {
        const full = join(MEMORY_DIR, name)
        // stat 与 readFile 并行 —— 多要一个 mtime 不该变成串行两跳。
        const [content, info] = await Promise.all([readFile(full, 'utf8'), stat(full)])
        const meta = parseFrontmatter(content)
        return {
          file: name,
          content,
          description: meta.description || '',
          aliases: meta.aliases || [],
          baseline: parseBaseline(content),
          baselinePriority: meta.baselinePriority || 0,
          // 新鲜度的两个来源：frontmatter 的 updated（权威）与文件 mtime（退路）。
          updated: meta.updated || '',
          mtimeMs: info.mtimeMs,
        }
      } catch (err) {
        // 只有 ENOENT 是正常状态（扫到读之间被删）。其余——权限错、编码坏、盘掉线——
        // 一律出声：这里的静默化就是把「记忆不再注入」变成无声事故的那一手。
        if (err?.code !== 'ENOENT') warnLog(ctx, `cannot read ${name}: ${err?.message ?? err}`, sessionId)
        return null
      }
    }))
    return loaded.filter(Boolean)
  } catch (err) {
    if (err?.code !== 'ENOENT') warnLog(ctx, `cannot scan ${MEMORY_DIR}: ${err?.message ?? err}`, sessionId)
    return []
  }
}

/** 提取正文第一个 `# ` 标题作为展示标题。 */
export function extractTitle(content) {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---/)
  const body = m ? content.slice(m[0].length) : content
  const h1 = body.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : ''
}

/** 扫记忆目录，读全部 .md（跳过索引与 session-log），带体积与修改时间。 */
export async function scanStars(ctx) {
  let entries
  try {
    entries = await readdir(MEMORY_DIR, { withFileTypes: true })
  } catch (err) {
    if (err?.code !== 'ENOENT') warnLog(ctx, `cannot scan ${MEMORY_DIR}: ${err?.message ?? err}`)
    return []
  }
  const names = entries
    .filter(e => e.isFile() && isMemoryEntry(e.name))
    .map(e => e.name)
  const loaded = await Promise.all(names.map(async (name) => {
    try {
      const full = join(MEMORY_DIR, name)
      const [content, info] = await Promise.all([readFile(full, 'utf8'), stat(full)])
      return { name, content, bytes: info.size, mtimeMs: info.mtimeMs }
    } catch (err) {
      if (err?.code !== 'ENOENT') warnLog(ctx, `cannot read ${name}: ${err?.message ?? err}`)
      return null
    }
  }))
  return loaded.filter(Boolean)
}
