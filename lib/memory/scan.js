/**
 * sage-mem 记忆层 —— 目录扫描 + 归档区的读写形状。
 *
 * 归档区（`memory/archive/`）**不参与检索**：`scanMemoryFiles` 只扫根目录 ——
 * 这就是「归档 = 静默失效且可回退」的语义，不是漏扫。归档只在两个地方现身：
 * 星图（`scanStars(ctx, true)`）与归档列表（`scanArchived`）—— 让**用户**看得见，
 * 而不是让**模型**想起来。
 *
 * 归档留痕写在文件自己的 frontmatter 里（`archived_at` / `archived_reason`）：
 * 文件可能被手工搬来搬去，随文件走的元数据才不会与文件脱节。
 */

import { MEMORY_DIR } from './config.js'
import { parseBaseline, parseFrontmatter } from './frontmatter.js'
import { isMemoryEntry } from './naming.js'
import { warnLog } from './util.js'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 归档区目录名。与 autodream 工具里的 ARCHIVE_DIR 同名同义（同一个目录）。 */
export const ARCHIVE_DIR_NAME = 'archive'

/** 归档区绝对路径。文件名不变，只换目录。 */
export const MEMORY_ARCHIVE_DIR = join(MEMORY_DIR, ARCHIVE_DIR_NAME)

/** 本地时间 `YYYY-MM-DD HH:mm` —— 归档留痕是给人看的，不用 ISO / UTC。 */
export function localStamp(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 把一个值写成 YAML 标量。
 *
 * 三层处理，少一层就是一个「不报错、值悄悄变形」的陷阱：
 *   1. **换行折成一个空格**（有意的规范化，不是截断）：裸写出去的话，后半行会变成
 *      **另一个 YAML 键**（`理由\narchived_reason: 假的` 会写出两个 `archived_reason`），
 *      或者让 `---` 提前闭合 frontmatter；而 YAML 的多行引号标量读回来又会把换行折成
 *      空格 —— 两种含糊都不如显式折叠。带过换行的值额外加引号，让读者看得出这行被
 *      规范化过。
 *   2. `: `（冒号+空格 → 被当成嵌套映射）与 ` #`（空格+井号 → 后半句被当注释吞掉）
 *      必须给整值加单引号。
 *   3. 空值写 `''`（裸写会变 YAML null）。
 * 单引号按 YAML 规矩翻倍转义。`reason` 来自用户输入，指望人「别写冒号、别写换行」不现实。
 */
export function yamlScalar(value) {
  const raw = String(value ?? '')
  const hadNewline = /[\r\n]/.test(raw)
  const s = raw.replace(/[\r\n]+/g, ' ').trim()
  if (s === '') return "''"
  if (hadNewline || /:(?:\s|$)| #/.test(s) || /^[-?#&*!|>%@`{}[\],'"]/.test(s)) {
    return `'${s.replace(/'/g, "''")}'`
  }
  return s
}

/** frontmatter 块（含两侧 `---`）的匹配；没有 frontmatter 返回 null。 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/

/** 文件用的是哪种换行：回写沿用原风格，别把用户文件的 CRLF 悄悄换成 LF。 */
const eolOf = (content) => (content.includes('\r\n') ? '\r\n' : '\n')

/** 剥掉 YAML 标量两侧的引号（单引号的 `''` 还原成一个 `'`）。 */
function unquoteYaml(raw) {
  const s = String(raw ?? '').trim()
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"')
  return s
}

/** 读 frontmatter 里的归档留痕。没有 frontmatter / 没有这两个字段都回空串。 */
export function readArchivedMeta(content) {
  const m = String(content ?? '').match(FRONTMATTER_RE)
  if (!m) return { archivedAt: '', archivedReason: '' }
  const grab = (key) => {
    const hit = m[1].match(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t\\r]*$`, 'm'))
    return hit ? unquoteYaml(hit[1]) : ''
  }
  return { archivedAt: grab('archived_at'), archivedReason: grab('archived_reason') }
}

/** 去掉归档留痕两行（恢复时用）。没有 frontmatter 就原样返回。 */
export function stripArchiveMeta(content) {
  const src = String(content ?? '')
  const m = src.match(FRONTMATTER_RE)
  if (!m) return src
  const eol = eolOf(src)
  const body = m[1]
    .split(/\r?\n/)
    .filter((line) => !/^[ \t]*archived_(at|reason)[ \t]*:/.test(line))
  const block = ['---', ...body, '---'].join(eol)
  return block + src.slice(m.index + m[0].length)
}

/**
 * 写入归档留痕：`archived_at` + `archived_reason` 插在 frontmatter 末尾。
 *
 * 已经是归档态的文件再归档没有意义（上层会先拒绝），所以这里只做 upsert：
 * 先剥掉旧的两行再插，免得同一份文件里出现两个 `archived_at`。
 * 没有 frontmatter 的文件补一个最小块 —— 归档信息必须有地方放。
 */
export function addArchiveMeta(content, reason, at) {
  const src = String(content ?? '')
  const eol = eolOf(src)
  const lines = [`archived_at: ${yamlScalar(at)}`, `archived_reason: ${yamlScalar(reason)}`]
  const stripped = stripArchiveMeta(src)
  const m = stripped.match(FRONTMATTER_RE)
  if (!m) return ['---', ...lines, '---', '', stripped].join(eol)
  const block = m[0].split(/\r?\n/)
  block.splice(block.length - 1, 0, ...lines)
  return stripped.slice(0, m.index) + block.join(eol) + stripped.slice(m.index + m[0].length)
}

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

/** 扫一个目录，读回星图要的轻量元数据（正文 + 体积 + 修改时间）。 */
async function readStarDir(dir, ctx) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err?.code !== 'ENOENT') warnLog(ctx, `cannot scan ${dir}: ${err?.message ?? err}`)
    return []
  }
  const names = entries
    .filter(e => e.isFile() && isMemoryEntry(e.name))
    .map(e => e.name)
  const loaded = await Promise.all(names.map(async (name) => {
    try {
      const full = join(dir, name)
      const [content, info] = await Promise.all([readFile(full, 'utf8'), stat(full)])
      return { name, content, bytes: info.size, mtimeMs: info.mtimeMs }
    } catch (err) {
      if (err?.code !== 'ENOENT') warnLog(ctx, `cannot read ${full}: ${err?.message ?? err}`)
      return null
    }
  }))
  return loaded.filter(Boolean)
}

/**
 * 扫归档区 `memory/archive/`。返回形状与 `readStarDir` 一致（多了 `archived: true`）。
 * 归档区不存在是正常状态（没人归档过）→ 空数组，不是错误。
 */
export async function scanArchived(ctx) {
  const rows = await readStarDir(MEMORY_ARCHIVE_DIR, ctx)
  return rows.map(f => ({ ...f, archived: true }))
}

/**
 * 扫记忆目录，读全部 .md（跳过索引与 session-log），带体积与修改时间。
 *
 * @param {boolean} [includeArchived] — 带上归档区的条目（默认不带：星图默认只看活着的）
 */
export async function scanStars(ctx, includeArchived = false) {
  const active = (await readStarDir(MEMORY_DIR, ctx)).map(f => ({ ...f, archived: false }))
  if (includeArchived !== true) return active
  return [...active, ...(await scanArchived(ctx))]
}
