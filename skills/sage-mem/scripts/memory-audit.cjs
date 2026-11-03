#!/usr/bin/env node
'use strict'
/**
 * memory-audit.cjs — 记忆库体检（2026-10-06 从 SKILL.md §9.2 固化下来）
 *
 * 为什么固化：原先它是技能正文里一段「存成临时脚本再跑」的代码，后果是
 * ① 每次手抄一遍，口径改一处要同步两处；② 断链检查的口径本来就要演进，
 * 散在文档里没法断言。现在体检这条链只有一个出口。
 *
 * 用法: node memory-audit.cjs [记忆目录]     # 默认读 $SAGE_MEM_DIR
 * 退出码: 0 = 无硬问题（软提醒不算失败）；1 = 有硬问题
 *
 * ── 2026-10-06 改了三处口径 ──
 *  1. **归档认可（P1-10）**：断链检查的名字池现在同时收 `archive/` 下的文件名与
 *     frontmatter name。原先只扫根目录，于是「文件被移进 archive/」会让所有指向它的
 *     `[[链接]]` 静默变成断链 —— 那等于把「归档」显示成「从未存在过」。
 *     分级：指向根目录 ✅ / 指向 archive/ 记一句提示（文件还在）/ 两边都没有 ❌ 断链。
 *     ⚠️ **只有审计认可 archive/，检索不认可** —— 归档的语义是「还在，但不该进上下文」。
 *  2. **代码块排除**：`[[...]]` 出现在反引号或围栏代码块里时不算链接。改这条是因为
 *     实测有误报：`reference_legacy-session-archive.md` 正文里拿 `` `[[双链]]` `` 当
 *     例子说明，被当成了一条真断链。
 *  3. **新增两类统计**：分类配比（P1-4）与整理阈值（P1-11）—— 报告式软提醒，不改数据。
 */
const fs = require('fs')
const path = require('path')

/**
 * 整理阈值（P1-11）。**按我们自己的现状定，不抄别家数字** —— Basic Memory 的索引线是
 * 500 行、Claude Code 是 200 行 / 25 KB，两个数差一倍多，说明这是各家拍的经验值。
 * 我们的现状（2026-10-06 实测）与取值理由：
 *   · 索引 112 行 / 36.5 KB → 线 150 行 / 45 KB（留约 30% 余量）。
 *     ⚠️ 注意字节线：CC 是 25 KB，**我们 36.5 KB 已经超了** —— 所以这条线按自己的
 *     体量定，照抄会变成「每天都在报警」。
 *   · 单条记忆最大 50.3 KB / 374 行（project_guikit.md）→ 线 30 KB / 300 行。
 *     它会一直报：这正是它该被拆开或做摘要前置的信号，不是误报。
 *   · 索引单行最长约 800 字符（那些把整段结论塞进索引行的条目）→ 线 400 字符。
 *   · session-log 538 KB → 线 600 KB。
 *   · project_* 占比 38% → 线 45%（论文里最容易陈旧、最该注意配比的正是这一类）。
 */
const LIMITS = {
  indexLines: 150,
  indexKB: 45,
  indexLineChars: 400,
  fileKB: 30,
  fileLines: 300,
  logKB: 600,
  projectSharePct: 45,
}

const dir = process.argv[2] || process.env.SAGE_MEM_DIR
if (!dir) {
  console.error('sage-mem: 未指定记忆目录，也未设置 SAGE_MEM_DIR')
  process.exit(2)
}
const archiveDir = path.join(dir, 'archive')
const INDEX = 'MEMORY.md'
const LOG = 'session-log.md'

// ── 工具 ─────────────────────────────────────────────────────────────
/** 剥掉围栏代码块与行内 code span —— 反引号里的 `[[x]]` 是例子，不是链接。 */
function stripCode(raw) {
  return raw.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
}

function readFiles(d) {
  try {
    return fs.readdirSync(d).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
}

/** 解析 frontmatter 的 name / type（兼容顶层与 metadata 嵌套两种 type）。 */
function parseFm(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { fm: null, name: '', type: '' }
  const grab = (k) => {
    const hit = raw.match(new RegExp(`^[ \\t]*${k}:[ \\t]*["']?([^"'\\r\\n]+?)["']?[ \\t]*$`, 'm'))
    return hit ? hit[1].trim() : ''
  }
  let type = grab('type')
  if (!type) {
    const nested = m[1].match(/^metadata:\s*\r?\n(?:\s+[^\r\n]+\r?\n)*?\s+type:\s*(\S+)/m)
    if (nested) type = nested[1]
  }
  return { fm: m[1], name: grab('name'), type }
}

function addKeys(set, file, meta) {
  set.add(file)
  set.add(file.replace(/\.md$/, ''))
  if (meta && meta.name) set.add(meta.name)
}

const load = (d, names) =>
  names.map((f) => {
    const raw = fs.readFileSync(path.join(d, f), 'utf8')
    return { file: f, raw, ...parseFm(raw), bytes: Buffer.byteLength(raw, 'utf8') }
  })

// ── 读数 ─────────────────────────────────────────────────────────────
const rootFiles = readFiles(dir).filter((f) => f !== INDEX)
const arcFiles = readFiles(archiveDir)
const rootData = load(dir, rootFiles)
const arcData = load(archiveDir, arcFiles)

const rootKeys = new Set()
rootData.forEach((o) => addKeys(rootKeys, o.file, o))
const arcKeys = new Set()
arcData.forEach((o) => addKeys(arcKeys, o.file, o))

const hard = []
const soft = []

// ── 1. 双链：断链 / 指向归档 ────────────────────────────────────────
const toArchive = []
for (const o of rootData) {
  for (const m of stripCode(o.raw).matchAll(/\[\[([^\]]+)\]\]/g)) {
    const k = m[1].trim()
    if (rootKeys.has(k)) continue
    if (arcKeys.has(k)) { toArchive.push(`${o.file} → [[${k}]]`); continue }
    hard.push(`双链断链：${o.file} → [[${k}]]`)
  }
}

// ── 2. 索引：悬空 / 漏索引 / 单行过长 ───────────────────────────────
// 索引读不到也要出报告，而不是崩掉 —— 体检工具在半坏的状态下更有用。
let idxRaw = ''
try {
  idxRaw = fs.readFileSync(path.join(dir, INDEX), 'utf8')
} catch {
  hard.push(`索引文件不存在或读不到：${INDEX}（目录 ${dir}）`)
}
const linked = [...new Set([...idxRaw.matchAll(/\]\(([^)\/]+\.md)\)/g)].map((m) => m[1]))]
const missing = linked.filter((f) => !fs.existsSync(path.join(dir, f)))
missing.forEach((f) => hard.push(`索引指向不存在的文件：${f}`))
const unlisted = rootFiles.filter((f) => !linked.includes(f))
unlisted.forEach((f) => hard.push(`漏在索引外的文件：${f}`))

const idxLines = idxRaw.split(/\r?\n/)
const longLines = idxLines
  .map((l, i) => ({ l, n: i + 1 }))
  .filter((o) => o.l.length > LIMITS.indexLineChars)
const idxKB = Buffer.byteLength(idxRaw, 'utf8') / 1024
// 口径与外部数字对齐：CC 那条「索引 200 行」说的是文件行数（含空行）。
const idxLineCount = idxLines.length

// ── 3. 每条：type / 前缀 / CRLF / 引号里的「 #」 ────────────────────
for (const o of rootData) {
  const prefix = o.file.split('_')[0]
  if (!o.type) hard.push(`缺 type（会被静默兜底成 reference）：${o.file}`)
  else if (o.type !== prefix && o.file !== LOG) {
    hard.push(`前缀与 type 不一致：${o.file} type=${o.type} 前缀=${prefix}`)
  }
  if (o.raw.includes('\r')) soft.push(`CRLF 换行：${o.file}`)
  if (o.fm) {
    for (const l of o.fm.split(/\r?\n/)) {
      const mv = l.match(/^[A-Za-z0-9_.-]+:\s*(.*)$/)
      if (mv && !/^["']/.test(mv[1]) && / #/.test(mv[1])) {
        hard.push(`未加引号的值里有「空格+#」（会被当注释吞掉）：${o.file} :: ${l.trim().slice(0, 80)}`)
      }
    }
  }
  // session-log 是追加型流水、天生巨大，由下面那条 logKB 专属线管 —— 别拿「一条记忆」
  // 的尺子量它，否则它会天天占着这个告警位，把真正该拆的那几条淹掉。
  if (o.file === LOG) continue
  const kb = o.bytes / 1024
  const lines = o.raw.split(/\r?\n/).length
  if (kb > LIMITS.fileKB || lines > LIMITS.fileLines) {
    soft.push(`单条超整理线：${o.file} ${kb.toFixed(1)} KB / ${lines} 行（线 ${LIMITS.fileKB} KB / ${LIMITS.fileLines} 行）`)
  }
}

// ── 4. 配比与体量（P1-4 / P1-11）───────────────────────────────────
const counts = {}
for (const o of rootData) {
  if (o.file === LOG) continue
  const p = o.file.split('_')[0]
  counts[p] = (counts[p] || 0) + 1
}
const totalMem = Object.values(counts).reduce((a, b) => a + b, 0)
const pct = (n) => (totalMem ? Math.round((n / totalMem) * 100) : 0)
const dist = Object.entries(counts).sort((a, b) => b[1] - a[1])
const totalKB = (rootData.reduce((n, o) => n + o.bytes, 0) + Buffer.byteLength(idxRaw, 'utf8')) / 1024

if (idxLineCount > LIMITS.indexLines) soft.push(`索引 ${idxLineCount} 行，超过 ${LIMITS.indexLines} 行的线`)
if (idxKB > LIMITS.indexKB) soft.push(`索引 ${idxKB.toFixed(1)} KB，超过 ${LIMITS.indexKB} KB 的线`)
if (longLines.length) {
  const worst = longLines.reduce((a, b) => (a.l.length > b.l.length ? a : b))
  soft.push(`索引有 ${longLines.length} 行超过 ${LIMITS.indexLineChars} 字符（最长第 ${worst.n} 行 ${worst.l.length} 字符）——该降级成一行一句`)
}
const projShare = pct(counts.project || 0)
if (projShare > LIMITS.projectSharePct) {
  soft.push(`project_* 占 ${projShare}%（${counts.project} 条），超过 ${LIMITS.projectSharePct}% —— 论文里最容易陈旧、最该注意配比的正是这一类`)
}
const log = rootData.find((o) => o.file === LOG)
if (log) {
  const logKB = log.bytes / 1024
  if (logKB > LIMITS.logKB) soft.push(`session-log.md ${logKB.toFixed(1)} KB，超过 ${LIMITS.logKB} KB 的线 —— 该考虑按年分段`)
}

// ── 报告 ─────────────────────────────────────────────────────────────
console.log(`══ 记忆库体检 · ${new Date().toLocaleString('zh-CN')} ══`)
console.log(`目录 ${dir}`)
console.log('')
console.log(`根目录 ${rootData.length} 条 / ${totalKB.toFixed(1)} KB  ·  归档 ${arcData.length} 条  ·  索引 ${idxLineCount} 行 / ${idxKB.toFixed(1)} KB`)
console.log(`分类：${dist.map(([k, n]) => `${k} ${n} (${pct(n)}%)`).join(' · ')}`)
console.log('')
console.log(`── 硬问题（${hard.length}）──`)
if (hard.length) hard.forEach((h) => console.log('  ❌ ' + h))
else console.log('  （无）')
console.log('')
console.log(`── 软提醒（${soft.length}）──`)
if (soft.length) soft.forEach((s) => console.log('  ⚠️ ' + s))
else console.log('  （无）')
console.log('')
console.log(`── 指向归档的引用（${toArchive.length} 条，不算问题）──`)
console.log(`  归档文件名与 name 都在认可池里，所以这些链接不再报断链。`)
console.log('  ⚠️ 只有审计认可 archive/，检索不认可 —— 归档的仍然不进上下文。')
console.log('')
console.log(hard.length ? `结果：${hard.length} 个硬问题` : '结果：无硬问题 ✅')
process.exit(hard.length ? 1 : 0)
