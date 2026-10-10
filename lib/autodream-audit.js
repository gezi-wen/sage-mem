/**
 * sage-mem autodream — 记忆目录审计（七查）。
 *
 * 审计清单内置在 host 侧，让 autodream 每次跑完都能自证
 * 没把记忆改坏（七项，外加「读不动」单列一类）：
 *   1. 索引悬空 —— MEMORY.md 指向不存在的文件
 *   2. 漏索引   —— 存在但没进索引的记忆文件
 *   3. type 与前缀不一致（分类看 type，前缀骗不了它）
 *   4. CRLF     —— 「某个 Windows 编辑器碰过」的可疑信号
 *   5. 双链断链 —— [[目标]] 找不到对应文件或 frontmatter name
 *   6. 未加引号值里的「空格+#」—— 会被 YAML 当注释吞掉，解析不报错但描述残缺
 *
 * **归档区（`archive/`）不是审计对象**，只贡献「名字池」：正文里指向已归档记忆的
 * `[[链接]]` 单列成 `archivedLinks`（提示），**不计入 problems** —— 归档是「静默失效
 * 且可回退」，不是删除。不这么分，归档越多假红灯越多。
 *
 * **纯只读**：不修任何东西。修哪条、怎么修，由 autodream agent 或人决定。
 *
 * 这一份解析是 sage-mem 宿主侧 parseFrontmatter 的同源精简版，故意不共用：
 * 那边带着一长串历史坑的注释与行为（baseline、type 回落），审计只读不写，
 * 重复二十行换零回归风险是划算的。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectMemoryEntry } from './memory/scan.js'
import { warnLog } from './memory/util.js'

/** 索引文件名。它本身不是一条记忆，是索引。 */
const INDEX_FILE = 'MEMORY.md'

/**
 * 审计**整个跳过**的文件（不读、不当被审对象）。
 *
 * session-log.md 是追加型流水，逐会话的账本而不是一条记忆；它没有
 * `user_/feedback_/project_/reference_` 前缀，扫进来只会白白读一大坨再报假问题。
 *
 * ⚠️ 别和 `lib/memory/config.js` 的 `NON_ENTRY_FILES` 混为一谈 —— **同名不同义**：
 * 那个管「列不列进设置页 / 星图 / 检索」，这个管「审计读不读」。它们的差集就是
 * **索引 `MEMORY.md`**：它**要**被读（要当链接来源、要查行尾与链接），只是
 * **不是一条记忆** —— 见下面 `f !== INDEX_FILE` 那两处。
 */
const AUDIT_SKIP_FILES = new Set(['session-log.md'])

/** 归档区目录名（与 autodream-tools.js 的 ARCHIVE_DIR、宿主侧 memory/scan.js 同名）。 */
const ARCHIVE_DIR = 'archive'

/** YAML 行形态：`key: value`（顶层键，不含缩进的嵌套行）。 */
const YAML_LEAF_RE = /^[A-Za-z0-9_.-]+:\s*(.*)$/

/**
 * 极简 frontmatter 解析，读法与 宿主侧一致：
 * 顶层 `type:` 优先，没有才下钻 `metadata.type:`。
 * @param {string} content — 文件全文
 * @returns {{name: string, description: string, type: string, hasFrontmatter: boolean}}
 */
export function parseFrontmatterLite(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { name: '', description: '', type: '', hasFrontmatter: false }
  const body = m[1]
  const grab = (key) => {
    const hit = body.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t\\r]*$`, 'm'))
    return hit ? hit[1].replace(/^["']|["']$/g, '').trim() : ''
  }
  const nested = body.match(/^metadata:\s*\r?\n(?:\s+[^\r\n]+\r?\n)*?\s+type:\s*(\S+)/m)
  const type = grab('type') || (nested ? nested[1] : '')
  return {
    name: grab('name'),
    description: grab('description'),
    type: String(type).trim(),
    hasFrontmatter: true,
  }
}

/**
 * 抽 MEMORY.md 里的相对链接目标（`](file.md)` / `](file.md#L12)`）。
 * @param {string} indexText
 * @returns {string[]} 去重后的文件名列表
 */
export function indexTargets(indexText) {
  const out = new Set()
  for (const m of indexText.matchAll(/\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
    const raw = m[1].trim()
    // 跳过外链与子目录路径：索引只指根目录下的记忆文件。
    if (/^[a-z]+:\/\//i.test(raw) || raw.includes('/') || raw.includes('\\')) continue
    out.add(raw)
  }
  return [...out]
}

/**
 * 扫一个目录下的记忆文件（不含子目录 —— 归档区就该扫不到），
 * 外加归档区的**名字池**（只有名字，不做检查）。
 * @param {string} dir
 * @returns {Promise<{files: string[], all: string[], skipped: number, indexText: string, archiveKeys: Set<string>, archiveCount: number}>}
 */
async function readDirSnapshot(dir) {
  let entries
  entries = await readdir(dir, { withFileTypes: true })
  const all = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
  const files = []
  for (const f of all) {
    if (AUDIT_SKIP_FILES.has(f.toLowerCase())) continue
    /**
     * 与「列表 / 注入 / 模型工具」同一条闸门。
     *
     * 审计原先自己扫目录、不过闸门，于是同一个目录会给出互相矛盾的两个数：
     * 列表说 1 条（链接 / 超大的被跳过），体检说 3 条 —— 用户根本不知道该信哪个。
     * 被跳过的条目在这里同样不计入 fileCount，原因落到日志。
     */
    const gate = await inspectMemoryEntry(join(dir, f))
    if (!gate.ok) {
      warnLog(null, `audit: skip ${f}: ${gate.error}`)
      continue
    }
    files.push(f)
  }
  let indexText = ''
  try {
    indexText = await readFile(join(dir, INDEX_FILE), 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  // 归档区：文件名、去掉 .md 的名字、以及 frontmatter 里的 `name`。
  // 内容读不动只少一个名字，绝不让整场审计失败 —— 归档区本来就不是被审对象。
  const archiveKeys = new Set()
  let archiveCount = 0
  try {
    const archived = await readdir(join(dir, ARCHIVE_DIR), { withFileTypes: true })
    for (const e of archived) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue
      archiveCount++
      archiveKeys.add(e.name)
      archiveKeys.add(e.name.replace(/\.md$/i, ''))
      try {
        const meta = parseFrontmatterLite(await readFile(join(dir, ARCHIVE_DIR, e.name), 'utf8'))
        if (meta.name) archiveKeys.add(meta.name.trim())
      } catch {
        /* 读不动：名字池少一条而已 */
      }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  return { files, all, skipped: all.length - files.length, indexText, archiveKeys, archiveCount }
}

/**
 * 把**代码**从正文里拿掉，只留散文 —— 用来避免把代码里的 `[[…]]` 当成链接。
 *
 * 两类都要剥：**围栏代码块**（跨行，```` ``` ```` 起止）与**行内代码**
 * （`` `x` ``、`` `` x `` `` —— 后者的内容里可以再出现反引号，所以闭合必须找
 * **等长**的那一串，不能用「遇到下一枚反引号就算完」）。
 *
 * ⚠️ **按行剥行内代码**：行内代码本来就极少跨行，按行做能把「反引号不配对」时的
 * 损失限制在一行内，不至于把后面真正的链接整段吞掉。2026-10-09 实测踩过一次：
 * 只认单反引号时，`` `` `[[双链]]` `` `` 这种写法会被漏掉、照样报假断链。
 * @param {string} raw — 文件全文
 */
function stripCode(raw) {
  const out = []
  let fence = null
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(`{3,})/)
    if (fence !== null) {
      if (m && m[1].length >= fence.length) fence = null // 围栏闭合
      continue // 围栏内的行整行丢弃（含起止那两行）
    }
    if (m) { fence = m[1]; continue }
    out.push(line.replace(/(`+)[^\n]*?\1/g, ''))
  }
  return out.join('\n')
}

/**
 * 七查主入口。
 * @param {string} dir — 记忆根目录
 * @returns {Promise<object>} 结构化审计结果（problems 是六项之和）
 */
export async function auditMemoryDir(dir) {
  const { files, all, skipped, indexText, archiveKeys, archiveCount } = await readDirSnapshot(dir)
  const entries = files.filter((f) => f !== INDEX_FILE)

  const targets = indexTargets(indexText)
  const targetSet = new Set(targets.map((t) => t.toLowerCase()))
  // 悬空判定用 `all`（含 session-log.md）：索引万一真引用了它，那是索引的问题，
  // 不该因为「审计不检查 session-log」而被顺手放过。
  const allSet = new Set(all.map((f) => f.toLowerCase()))

  const dangling = targets.filter((t) => !allSet.has(t.toLowerCase()))
  const unlisted = entries.filter((f) => !targetSet.has(f.toLowerCase()))

  const typeMismatch = []
  const crlf = []
  const hashHazards = []
  const brokenLinks = []
  const archivedLinks = []
  const noFrontmatter = []
  const linkKeys = new Set()

  const contents = new Map()
  /**
   * 读不动的文件（权限、被占用、编码坏）。
   *
   * **绝不抛**：`run()` 把「运行前审计」当作开工前置，裸抛一个 EPERM 会让
   * 「有个文件读不了」升级成「自动整理整个停摆」，而且报出来的是宿主内部的原文。
   * 它们单列一类，**不参与**后面每一项检查 —— 免得被戴上「没 frontmatter」「CRLF」的帽子
   */
  const unreadable = []
  for (const f of files) {
    try {
      contents.set(f, await readFile(join(dir, f), 'utf8'))
    } catch {
      unreadable.push(f)
    }
  }
  const readable = files.filter((f) => contents.has(f))
  for (const f of readable) {
    const meta = parseFrontmatterLite(contents.get(f))
    if (meta.name) linkKeys.add(meta.name.trim())
  }
  for (const f of readable) linkKeys.add(f)
  for (const f of readable) linkKeys.add(f.replace(/\.md$/, ''))
  /**
   * ⚠️ 链接目标池还必须含**非条目文件**（`session-log.md` / `MEMORY.md`）。
   *
   * 它们不在 `readable` 里（不参与检索），但 `[[session-log]]` 指向的是**真实存在的文件** ——
   * 只因它不参与检索就报成断链，是假阳性。这与上面 `dangling` 用 `allSet` 而非 `files`
   * 判定悬空是同一个理由，别只在一处想到。（2026-10-09 实测：健康记忆库被报 1 条假断链）
   */
  for (const f of all) {
    linkKeys.add(f)
    linkKeys.add(f.replace(/\.md$/i, ''))
  }

  for (const f of readable) {
    const raw = contents.get(f)
    if (raw.includes('\r')) crlf.push(f)
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!fmMatch) {
      /**
       * 索引 `MEMORY.md` 是**纯清单、不是一条记忆**（见 `lib/memory/config.js` 的
       * `NON_ENTRY_FILES` 说明），不要求 frontmatter。报它等于给每一个健康的记忆库挂一盏常驻红灯。
       */
      if (f !== INDEX_FILE) noFrontmatter.push(f)
    } else {
      const meta = parseFrontmatterLite(raw)
      const prefix = f.split('_')[0]
      const effective = meta.type || 'reference'
      if (effective !== prefix) {
        typeMismatch.push({ file: f, type: meta.type || '(缺失)', prefix, effective })
      }
      for (const line of fmMatch[1].split(/\r?\n/)) {
        const mv = line.match(YAML_LEAF_RE)
        if (mv && !/^["']/.test(mv[1]) && / #/.test(mv[1])) {
          hashHazards.push({ file: f, line: line.trim().slice(0, 100) })
        }
      }
    }
    /**
     * ⚠️ 只在**非代码**文本里找双链。
     *
     * `` `[[双链]]` `` 写在行内代码或围栏代码块里，是在**讲链接语法本身**，不是一条链接。
     * 直接在原文上 `matchAll` 会把它报成断链（2026-10-09 实测的假阳性）。
     */
    const prose = stripCode(raw)
    for (const m of prose.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = m[1].trim()
      if (linkKeys.has(target)) continue
      // 指向归档区的链接：单列提示、不计问题 —— 归档不是删除，目标还在库里躺着。
      if (archiveKeys.has(target)) {
        archivedLinks.push({ file: f, target })
        continue
      }
      brokenLinks.push({ file: f, target })
    }
  }

  const problems =
    dangling.length +
    unlisted.length +
    typeMismatch.length +
    crlf.length +
    brokenLinks.length +
    hashHazards.length +
    noFrontmatter.length +
    unreadable.length

  return {
    dir,
    fileCount: entries.length,
    skipped,
    archivedCount: archiveCount,
    indexEntries: targets.length,
    dangling: dangling.map((file) => ({ file })),
    unlisted: unlisted.map((file) => ({ file })),
    typeMismatch,
    crlf: crlf.map((file) => ({ file })),
    brokenLinks,
    // 指向归档的链接是提示，**不进 problems**（见文件头那段）。
    archivedLinks,
    hashHazards,
    noFrontmatter: noFrontmatter.map((file) => ({ file })),
    unreadable: unreadable.map((file) => ({ file })),
    problems,
  }
}

/**
 * 把审计结果压成给模型看的短文本（autodream 工具返回值 / 报告附录都用它）。
 * @param {object} report — auditMemoryDir 的返回值
 * @param {number} [limit] — 每个分项最多列几条
 * @returns {string}
 */
export function formatAudit(report, limit = 12) {
  const lines = [
    `扫描 ${report.fileCount} 个记忆文件 · 索引 ${report.indexEntries} 条 · 问题合计 ${report.problems}`,
  ]
  const section = (title, rows, render) => {
    if (!rows.length) return
    lines.push(`${title} (${rows.length})`)
    for (const r of rows.slice(0, limit)) lines.push(`  - ${render(r)}`)
    if (rows.length > limit) lines.push(`  … 另有 ${rows.length - limit} 条`)
  }
  section('索引悬空', report.dangling, (r) => r.file)
  section('漏索引', report.unlisted, (r) => r.file)
  section('type 与前缀不一致', report.typeMismatch, (r) => `${r.file} type=${r.type} 前缀=${r.prefix}`)
  section('CRLF', report.crlf, (r) => r.file)
  section('双链断链', report.brokenLinks, (r) => `${r.file} -> [[${r.target}]]`)
  // 指向归档单列且写明「不计问题」：否则模型会去「修」一条本来正确的链接。
  section('指向已归档（提示，不计入问题）', report.archivedLinks ?? [], (r) => `${r.file} -> [[${r.target}]]`)
  section('未加引号的「空格+#」', report.hashHazards, (r) => `${r.file} :: ${r.line}`)
  section('无 frontmatter', report.noFrontmatter, (r) => r.file)
  // 读不动的单列，且排最后：它不是「这条记忆写错了」，是「我没读到它」——
  // 别让模型以为去改改 frontmatter 就能好。
  section('读不动（权限/占用/编码，不参与上面各项检查）', report.unreadable ?? [], (r) => r.file)
  return lines.join('\n')
}
