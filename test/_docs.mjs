#!/usr/bin/env node
/**
 * _docs.mjs — 1.0.0 材料包的文档解析器（**共享辅助**，`_` 开头，按 `run.mjs` 的约定不登记为套件）
 *
 * 为什么把解析单独拿出来：`1.0.0-contract.md`（契约）与 `1.0.0-boundaries.md`（边界表）
 * 这两份文档之间要**逐行对得上**，而这件事以前是**靠人眼维持的** —— 复审者抓到的那处
 * 自相矛盾（边界表把「事件注册窗口」标成 best effort，契约正文别处又写成保证）就是这么来的。
 * 两个守卫（`contract-binding-test.mjs` / `doc-consistency-test.mjs`）都要读这两份文档，
 * 解析规则必须只有一份，否则「守卫的假设」和「文档的格式」会各自漂移。
 *
 * 约定（两份文档都遵守）：
 *   - 表的**表头**决定列的语义（`定性` / `断言` / `契约`），不靠列序。列序换来换去不会误导守卫。
 *   - 契约行首格是 `1.3` 这种编号；边界表行首格是 `**A7** …`，编号取 `A7`。
 *   - 绑定写在 `断言` 列，多条用 `<br>` 分隔；没有就写 `—`。
 *   - 交叉引用写在边界表的 `契约` 列（指向契约行编号），没有对应行就写 `—`。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DOCS = join(HERE, '..', 'docs')

/** 去掉 markdown 的粗体与反引号，留下可比较的纯文本。 */
export function plain(cell) {
  return String(cell ?? '').replace(/\*\*/g, '').replace(/`/g, '').trim()
}

/**
 * 定性格的归一：`明确做不到（有意）` → `明确做不到`。
 * 括号里是给人看的补充（「有意」「未验证」这类），不该被当成第五档定性。
 */
export function labelOf(cell) {
  return plain(cell).replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim()
}

/** `| a | b |` → `['a','b']`。 */
export function splitRow(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim())
}

/**
 * 把 markdown 拆成一张张表（连续以 `|` 开头的行算一块；第 2 行是 `|---|` 分隔行才算表）。
 * 每一块给出 `{ header, rows }`，都是字符串数组。
 */
export function parseTables(md) {
  const tables = []
  let block = []
  const flush = () => {
    if (block.length >= 2 && /^\|[\s:|-]+\|$/.test(block[1]) && /^\|/.test(block[0])) {
      tables.push({ header: splitRow(block[0]), rows: block.slice(2).map(splitRow) })
    }
    block = []
  }
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*\|/.test(line)) block.push(line.trim())
    else flush()
  }
  flush()
  return tables
}

/** 每行的单元格数必须与表头一致 —— 不一致说明格子里的 `|` 把表格撑坏了（Markdown 的经典坑）。 */
export function shapeProblems(tables, idPattern) {
  const bad = []
  for (const t of tables) {
    for (const cells of t.rows) {
      if (cells.length === t.header.length) continue
      const id = plain(cells[0])
      if (idPattern.test(id)) bad.push(`「${id}」列数 ${cells.length} ≠ 表头 ${t.header.length}`)
    }
  }
  return bad
}

/** 契约的定性词汇（只有这四档）。 */
export const LABELS = ['保证', '尽力', '明确做不到', '未验证']

/**
 * 读契约 `docs/1.0.0-contract.md`。
 * @returns {{ vocab: string[], rows: Array<{id:string,label:string,bindings:string[]}>, tables: object[] }}
 */
export function loadContract() {
  const tables = parseTables(readFileSync(join(DOCS, '1.0.0-contract.md'), 'utf8'))
  const rows = []
  let vocab = []
  for (const t of tables) {
    const head = t.header.map(plain)
    if (!head.includes('定性')) continue
    // 定性定义表（`定性 | 含义`）：行首格就是标签本身，词汇表以它为准。
    if (head.includes('含义') && !head.includes('断言')) {
      vocab = t.rows.map((c) => plain(c[0])).filter(Boolean)
      continue
    }
    const iLabel = head.indexOf('定性')
    const iBind = head.indexOf('断言')
    for (const cells of t.rows) {
      if (cells.length !== t.header.length) continue
      const id = plain(cells[0])
      if (!/^\d+\.\d+$/.test(id)) continue
      const raw = iBind >= 0 ? plain(cells[iBind]) : ''
      rows.push({
        id,
        label: labelOf(cells[iLabel]),
        bindings: raw && raw !== '—' && raw !== '-' ? raw.split(/<br\s*\/?>/i).map((s) => s.trim()).filter(Boolean) : [],
      })
    }
  }
  return { vocab, rows, tables }
}

/**
 * 读边界表 `docs/1.0.0-boundaries.md`。
 * @returns {{ rows: Array<{id:string,label:string,cells:string[],contract:string[],evidence:string}> }}
 */
export function loadBoundaries() {
  const tables = parseTables(readFileSync(join(DOCS, '1.0.0-boundaries.md'), 'utf8'))
  const rows = []
  for (const t of tables) {
    const head = t.header.map(plain)
    if (!head.includes('定性') || !head.includes('依据')) continue
    const iLabel = head.indexOf('定性')
    const iContract = head.indexOf('契约')
    const iEvidence = head.indexOf('依据')
    for (const cells of t.rows) {
      if (cells.length !== t.header.length) continue
      const id = plain(cells[0]).match(/^([A-Z]\d+)/)?.[1]
      if (!id) continue
      const rawRef = iContract >= 0 ? plain(cells[iContract]) : ''
      rows.push({
        id,
        label: labelOf(cells[iLabel]),
        evidence: iEvidence >= 0 ? cells[iEvidence] : '',
        hasContractColumn: iContract >= 0,
        contractRaw: rawRef,
        contract: rawRef && rawRef !== '—' && rawRef !== '-'
          ? rawRef.split(/<br\s*\/?>/i).map((s) => s.trim().replace(/^契约\s*/, '')).filter(Boolean)
          : [],
      })
    }
  }
  return { rows, tables }
}

/**
 * 读外部发现永久账 `docs/review-findings.md`。
 * 表头需含 `编号` 与 `断言`；`断言` 列为 `套件.mjs::子串` 或 `—`（明确「无断言」）。
 * @returns {{ rows: Array<{id:string,status:string,bindings:string[]}> }}
 */
export function loadReviewFindings() {
  const tables = parseTables(readFileSync(join(DOCS, 'review-findings.md'), 'utf8'))
  const rows = []
  for (const t of tables) {
    const head = t.header.map(plain)
    if (!head.includes('编号') || !head.includes('断言')) continue
    const iStatus = head.indexOf('处置')
    const iBind = head.indexOf('断言')
    const iWho = head.indexOf('谁看着')
    for (const cells of t.rows) {
      if (cells.length !== t.header.length) continue
      const id = plain(cells[0])
      if (!/^R\d+$/.test(id)) continue
      const raw = plain(cells[iBind])
      rows.push({
        id,
        status: iStatus >= 0 ? plain(cells[iStatus]) : '',
        who: iWho >= 0 ? plain(cells[iWho]) : '',
        bindings: raw && raw !== '—' && raw !== '-' ? raw.split(/<br\s*\/?>/i).map((s) => s.trim()).filter(Boolean) : [],
      })
    }
  }
  return { rows, tables }
}
