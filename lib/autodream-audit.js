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
 * **纯只读**：不修任何东西。修哪条、怎么修，由 autodream agent 或人决定。
 *
 * 这一份解析是 sage-mem 宿主侧 parseFrontmatter 的同源精简版，故意不共用：
 * 那边带着一长串历史坑的注释与行为（baseline、type 回落），审计只读不写，
 * 重复二十行换零回归风险是划算的。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 索引文件名。它本身不是一条记忆，是索引。 */
const INDEX_FILE = 'MEMORY.md'

/**
 * 非记忆条目：不是四类记忆、也不该套「type 与前缀一致」这条规则。
 *
 * session-log.md 是追加型流水，逐会话的账本而不是一条记忆；
 * 它没有 `user_/feedback_/project_/reference_` 前缀，扫进来只会白白读一大坨
 * 再报一条假问题（实测：报出 `session-log.md type=reference`）。
 * 同理 MEMORY.md 是索引本身，只作为链接来源读，不作为被审对象。
 */
const NON_ENTRY_FILES = new Set(['session-log.md'])

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
 * 扫一个目录下的记忆文件（不含子目录 —— 归档区就该扫不到）。
 * @param {string} dir
 * @returns {Promise<{files: string[], indexText: string}>}
 */
async function readDirSnapshot(dir) {
  let entries
  entries = await readdir(dir, { withFileTypes: true })
  const all = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
  const files = all.filter((f) => !NON_ENTRY_FILES.has(f.toLowerCase()))
  let indexText = ''
  try {
    indexText = await readFile(join(dir, INDEX_FILE), 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  return { files, all, skipped: all.length - files.length, indexText }
}

/**
 * 七查主入口。
 * @param {string} dir — 记忆根目录
 * @returns {Promise<object>} 结构化审计结果（problems 是六项之和）
 */
export async function auditMemoryDir(dir) {
  const { files, all, skipped, indexText } = await readDirSnapshot(dir)
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

  for (const f of readable) {
    const raw = contents.get(f)
    if (raw.includes('\r')) crlf.push(f)
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!fmMatch) {
      noFrontmatter.push(f)
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
    for (const m of raw.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = m[1].trim()
      if (!linkKeys.has(target)) brokenLinks.push({ file: f, target })
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
    indexEntries: targets.length,
    dangling: dangling.map((file) => ({ file })),
    unlisted: unlisted.map((file) => ({ file })),
    typeMismatch,
    crlf: crlf.map((file) => ({ file })),
    brokenLinks,
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
  section('未加引号的「空格+#」', report.hashHazards, (r) => `${r.file} :: ${r.line}`)
  section('无 frontmatter', report.noFrontmatter, (r) => r.file)
  // 读不动的单列，且排最后：它不是「这条记忆写错了」，是「我没读到它」——
  // 别让模型以为去改改 frontmatter 就能好。
  section('读不动（权限/占用/编码，不参与上面各项检查）', report.unreadable ?? [], (r) => r.file)
  return lines.join('\n')
}
