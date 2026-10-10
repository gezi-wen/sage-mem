/**
 * 索引（`MEMORY.md`）的**写入侧** —— 只有一件事：确保某条记忆在索引里有一行。
 *
 * 为什么要单独一个文件：索引是**用户手写**的东西（「改动记忆时同步改这里」这条就写在
 * 索引自己的说明段里）。所以这里只做**追加**，绝不重排、绝不删用户已有的行、绝不重建
 * 整个文件 —— 索引被整份覆盖就等于用户的维护成果没了。
 *
 * 起因（2026-10-11 在一次真实使用中确认）：恢复归档记忆时只把文件搬回顶层、
 * 不补索引，于是顶层有文件、索引里没有 → 体检报「漏索引」。
 */
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseFrontmatter } from './frontmatter.js'
import { nameKey } from './naming.js'
import { writeFileAtomic } from './util.js'

const INDEX_KEY = 'memory.md'
/** 条目里的描述上限：索引是清单，不是内容堆。 */
const DESC_MAX = 120

/**
 * 索引文件的**磁盘真名**（大小写不敏感地找）。
 * 不假设盘上是 `MEMORY.md` —— 系统盘是 Windows、用户可能就写成了小写。
 */
export async function findIndexFile(memoryDir) {
  const names = await readdir(memoryDir).catch(() => [])
  return names.find((n) => nameKey(n) === INDEX_KEY) ?? null
}

/** 索引里有没有指向该文件的条目（`](file.md)` 或 `](file.md#L12)`，大小写不敏感）。 */
function hasEntry(indexText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\]\\(\\s*${escaped}(?:#[^)]*)?\\s*\\)`, 'i').test(indexText)
}

/**
 * 确保索引里有指向 `name` 的一行；已经有就**什么都不做**（幂等）。
 *
 * 条目形状与索引自己声明的约定一致：`- [标题](文件.md) — 一句话`。
 * 标题取 frontmatter 的 `name`（没有就用文件名），描述取 `description`。
 *
 * @returns {Promise<{ok:boolean, added:boolean, file?:string, line?:string, error?:string}>}
 */
export async function ensureIndexEntry(memoryDir, name) {
  const indexName = await findIndexFile(memoryDir)
  // 没有索引是**正常状态**（索引是可选件）：不崩、不建、不当失败。
  if (!indexName) return { ok: true, added: false, error: 'no-index' }
  const indexPath = join(memoryDir, indexName)
  const indexText = await readFile(indexPath, 'utf8').catch(() => '')
  if (hasEntry(indexText, name)) return { ok: true, added: false }

  const content = await readFile(join(memoryDir, name), 'utf8').catch(() => '')
  const fm = parseFrontmatter(content)
  const title = fm.name || basename(name, '.md')
  const desc = (fm.description || '').trim().slice(0, DESC_MAX)
  const line = `- [${title}](${name})${desc ? ' — ' + desc : ''}`
  // 追加到末尾。文件末尾没换行就先补一个，别把新条目粘到上一行的尾巴上。
  const head = indexText === '' || indexText.endsWith('\n') ? indexText : indexText + '\n'
  await writeFileAtomic(indexPath, head + line + '\n')
  return { ok: true, added: true, file: name, line }
}

/**
 * 把指向 `name` 的索引行**摘掉**（归档时用）。与 `ensureIndexEntry` 对称：
 * 索引是**活动记忆的清单**，记忆归档了就该从清单里退出。
 *
 * 为什么必须做（2026-10-11 在真实库里撞到）：v0.9.8 只做了「恢复时补索引」那一半，
 * 归档时没摘 —— 于是每归档一条，索引里就多一条指向「已不在顶层」的条目，审计报「索引悬空」。
 * 我归档两条时当场看到体检从 0 问题变 2 问题。
 *
 * 只删**指向它的那一行**，别的一律不动（索引是用户手写的）。
 * 匹配与 `hasEntry` 同一套：大小写不敏感、容忍 `#L12` 锚点；因为锚定了 `](`，
 * 所以 `a.md` 不会误伤 `x_a.md`。幂等：本来就没有这一行时一个字节都不改。
 *
 * @returns {Promise<{ok:boolean, removed:boolean, error?:string}>}
 */
export async function dropIndexEntry(memoryDir, name) {
  const indexName = await findIndexFile(memoryDir)
  // 没有索引是正常状态：归档照常进行，只是没有清单要维护。
  if (!indexName) return { ok: true, removed: false, error: 'no-index' }
  const indexPath = join(memoryDir, indexName)
  const indexText = await readFile(indexPath, 'utf8').catch(() => '')
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lineRe = new RegExp(`\\]\\(\\s*${escaped}(?:#[^)]*)?\\s*\\)`, 'i')
  const lines = indexText.split('\n')
  const kept = lines.filter((l) => !lineRe.test(l))
  if (kept.length === lines.length) return { ok: true, removed: false }
  await writeFileAtomic(indexPath, kept.join('\n'))
  return { ok: true, removed: true }
}
