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
 * 索引写的**进程内串行队列**。
 *
 * 为什么要它（2026-10-12 复审 R07）：两个归档同时跑时，两边都先读整份索引、
 * 各自算「摘掉我这条之后剩下的行」、再各自整体覆盖 —— 后写的那个把先写的成果盖回去，
 * 于是索引里留下一条指向「已不在顶层」的悬空条目，而两次调用都报 `ok:true`。
 * 实测两个 `archiveMemory` 并发（`Promise.all`）就能稳定看到。
 *
 * ⚠️ **边界说清楚**：这是**进程内**串行，不是跨进程锁。真实并发（界面 remote、
 * 模型工具、自动归档策略）都跑在同一个插件进程里，所以覆盖得住；同时开两个 DSH 实例
 * 各自归档同一条记忆时，仍可能丢掉一次索引更新 —— 那要另加一套跨进程文件锁，
 * 复杂度与误伤面都不划算，这里明确不做。
 *
 * 串行只包**读-改-写**那一段，不包调用方（归档/恢复）的整个流程，避免把文件搬移也串起来。
 *
 * ⚠️ **队内函数不许再调另一个带队列的函数**（那会自己等自己，永久挂住）。目前两个队列函数
 * 内部只碰 `findIndexFile` / `readIndexText` / `writeFileAtomic`，都没有嵌套；将来加逻辑时
 * 要么留在同一个队列任务里，要么走非队列的内部实现。
 */
let indexTail = Promise.resolve()
function withIndexWrite(fn) {
  // 显式包一层：前一次失败的 reason 不该被当成参数传进 fn（fn 不接参数）。
  const run = indexTail.then(
    () => fn(),
    () => fn(),
  )
  // 队尾吞掉结果与异常：一次失败不该毒化后面所有排队的写。
  indexTail = run.then(
    () => {},
    () => {},
  )
  return run
}

/**
 * 读索引正文。**读失败绝不等于「索引是空的」**（2026-10-12 复审 R11）。
 *
 * 旧写法 `.catch(() => '')` 把 EIO / EACCES / 被占用一律折叠成空字符串，而调用方
 * 拿到空串后会走「索引里没有这一行 → 整体重写」这条路 —— 用户手写的标题、段落、
 * 其它条目**一起被覆盖掉**，而函数报的是成功。一次瞬时读失败就吃掉用户的手工维护成果。
 *
 * 判据收紧成：读得到就返回正文；读不到就**明确上报失败、一个字节都不写**。
 * 「磁盘上确实没有索引」不走这条 —— 那由 `findIndexFile` 判（名字找不到就直接返回）。
 */
async function readIndexText(indexPath) {
  try {
    return { ok: true, text: await readFile(indexPath, 'utf8') }
  } catch (err) {
    return { ok: false, error: `读不了索引文件（${err?.code ?? err}）：${err?.message ?? err}` }
  }
}

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
  return withIndexWrite(() => ensureIndexEntryLocked(memoryDir, name))
}

async function ensureIndexEntryLocked(memoryDir, name) {
  const indexName = await findIndexFile(memoryDir)
  // 没有索引是**正常状态**（索引是可选件）：不崩、不建、不当失败。
  if (!indexName) return { ok: true, added: false, error: 'no-index' }
  const indexPath = join(memoryDir, indexName)
  // 读失败 → 不写（R11）。宁可这次不补索引，也不能拿一份「读出来的空索引」覆盖用户的正文。
  const read = await readIndexText(indexPath)
  if (!read.ok) return { ok: false, added: false, error: read.error }
  const indexText = read.text
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
  return withIndexWrite(() => dropIndexEntryLocked(memoryDir, name))
}

async function dropIndexEntryLocked(memoryDir, name) {
  const indexName = await findIndexFile(memoryDir)
  // 没有索引是正常状态：归档照常进行，只是没有清单要维护。
  if (!indexName) return { ok: true, removed: false, error: 'no-index' }
  const indexPath = join(memoryDir, indexName)
  // 读失败 → 不写（R11）：摘不掉一行只是"索引暂时不准"，而拿空串当基线整体重写
  // 会把用户手写的整份索引抹平 —— 两者不是一个量级。
  const read = await readIndexText(indexPath)
  if (!read.ok) return { ok: false, removed: false, error: read.error }
  const indexText = read.text
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lineRe = new RegExp(`\\]\\(\\s*${escaped}(?:#[^)]*)?\\s*\\)`, 'i')
  const lines = indexText.split('\n')
  const kept = lines.filter((l) => !lineRe.test(l))
  if (kept.length === lines.length) return { ok: true, removed: false }
  await writeFileAtomic(indexPath, kept.join('\n'))
  return { ok: true, removed: true }
}
