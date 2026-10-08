/**
 * autodream —— 整理声明与人读报告（引擎方法体）。
 *
 * 本文件里的函数都是 `AutodreamEngine` 的方法体：`engine.js` 里保留同名同签名的方法，
 * 用 `xxxMod.name.call(this, …)` 转发进来 —— 所以函数体里的 `this` 就是引擎实例，
 * 与拆分前完全一致，没有引入任何模块级可变状态。
 */

import { formatAudit } from '../autodream-audit.js'
import { LEGACY_REPORT_DIR, REPORT_DIR } from './config.js'
import { OP_LABEL, formatDelta, readJson, safeName, stampHuman } from './util.js'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 把「改了什么、为什么」写成两种形态，落在 `<home>/runs/<runId>/` 下：
 *   - `manifest.json` 机读（回滚也从它读「这次动过哪几个文件」）
 *   - `declaration.md` 人读（报告里内嵌同一份）
 *
 * 没有改动时也照样写：**「这趟什么都没改」本身就是要交代的信息**。
 */
export async function writeDeclaration(payload) {
  const dir = join(this.runsRoot, payload.runId)
  await mkdir(dir, { recursive: true })
  const manifest = {
    schema: 1,
    runId: payload.runId,
    startedAt: payload.startedAt,
    startedAtHuman: stampHuman(payload.startedAt),
    endedAt: payload.endedAt,
    durationMs: payload.endedAt - payload.startedAt,
    reason: payload.reason,
    mode: payload.apply ? 'apply' : 'report',
    source: payload.source,
    route: { provider: payload.provider, model: payload.model, fromDefault: !!payload.fromDefault },
    gate: { hoursSince: payload.hoursSince, sessionCount: payload.sessionCount },
    tokens: { in: payload.tokensIn, out: payload.tokensOut },
    snapshot: payload.snapshot ? { id: payload.snapshot.id, dir: payload.snapshot.dir, files: payload.snapshot.count } : null,
    audit: {
      before: { problems: payload.auditBefore?.problems ?? 0 },
      after: { problems: payload.auditAfter?.problems ?? 0 },
    },
    changes: payload.changes,
    warnings: payload.warnings,
    notes: payload.notes ?? [],
    report: payload.report ?? null,
    finalText: payload.finalText ?? '',
    rolledBackAt: 0,
    rolledBackAtHuman: '',
  }
  const markdown = this.renderDeclaration(manifest)
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await writeFile(join(dir, 'declaration.md'), markdown, 'utf8')
  return { dir, manifest, markdown }
}

/** 渲染人读声明（报告里内嵌，所以标题层级可以从外面压）。 */
export function renderDeclaration(m, headingLevel = 1) {
  const H = '#'.repeat(Math.max(1, Math.min(6, headingLevel)))
  const lines = [
    `${H} 整理声明 · ${m.startedAtHuman}`,
    '',
    `- 运行：\`${m.runId}\` · 模式：${m.mode === 'apply' ? '直接改写' : '只出报告'} · 模型：\`${m.route.provider}/${m.route.model}\``,
    m.snapshot
      ? `- 回滚点：\`${m.snapshot.id}\`（${m.snapshot.files} 个文件）`
      : '- 回滚点：未做（只出报告模式不写盘，无需回滚）',
    `- 审计：结构问题 ${m.audit.before.problems} → ${m.audit.after.problems}`,
    '',
    `${H}# 改了什么、为什么`,
    '',
  ]
  if (!m.changes.length) {
    lines.push(m.mode === 'apply' ? '（本次没有改动任何文件）' : '（只出报告模式，未改动文件）', '')
  } else {
    lines.push('| # | 文件 | 操作 | 缘由 | 变化 |', '|---|---|---|---|---|')
    let autoCount = 0
    for (const c of m.changes) {
      const op = OP_LABEL[c.op] ?? c.op
      const delta =
        c.op === 'archive' ? `${(c.before.bytes / 1024).toFixed(1)}KB → archive/` : formatDelta(c.before, c.after)
      let reason
      if (c.reasonSource === 'auto' || !String(c.reason ?? '').trim()) {
        // 模型没自述缘由 → 用宿主追溯得到的信息顶替，并**显式标出来**。
        // 这条路径存在的理由：硬拒会丢掉一次本来正确的修正，那比缺一句解释更糟。
        autoCount += 1
        reason = `⚠（未自述）${c.step ? `第 ${c.step} 轮` : '轮次未知'} · ${op} · ${delta}`
      } else {
        // 缘由里的竖线会撕坏表格；换行也会——一并压平。
        reason = String(c.reason)
          .replace(/\|/g, '/')
          .replace(/\s*\n\s*/g, ' ')
      }
      lines.push(`| ${c.seq} | \`${c.file}\` | ${op} | ${reason} | ${delta} |`)
    }
    lines.push('')
    if (autoCount) {
      lines.push(
        `> 其中 ${autoCount} 条的缘由是**宿主追溯**的（模型没有自述）。改动已经生效，` +
          '但动机未经模型确认 —— 值得人工看一眼这几条。',
        '',
      )
    }
  }
  if (m.warnings?.length) {
    lines.push(`${H}# 未能落地的改动（这些改动没有发生）`, '')
    for (const w of m.warnings) lines.push(`- ${w}`)
    lines.push('')
  }
  if (m.notes?.length) {
    // 与上一节**必须分开**：上一节说「没发生」，这一节说「已经生效，只是有话要说」。
    // 混在一节里会出现「标题写着未能落地、正文告诉你已生效」这种自相矛盾
    lines.push(`${H}# 提示（改动已生效，只是有话要说）`, '')
    for (const n of m.notes) lines.push(`- ${n}`)
    lines.push('')
  }
  lines.push(`${H}# 模型的收尾说明`, '', m.finalText ? m.finalText : '（模型没有给出文字说明）', '')
  return lines.join('\n')
}

/** 列运行记录（面板的「整理声明」区）。 */
export async function listRuns(limit = 20) {
  const entries = await readdir(this.runsRoot, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const m = await readJson(join(this.runsRoot, e.name, 'manifest.json'))
    if (!m) continue
    const snapId = m.snapshot?.id ?? null
    out.push({
      runId: m.runId ?? e.name,
      at: m.startedAt ?? 0,
      atHuman: m.startedAtHuman ?? e.name,
      mode: m.mode ?? 'apply',
      reason: m.reason ?? '',
      // 只出报告模式下 changes 必为空；面板要能区分「没改」和「还没跑」。
      changeCount: Array.isArray(m.changes) ? m.changes.length : 0,
      report: m.report ?? null,
      snapshotId: snapId,
      // 回滚点会被 maxSnapshotKeep 轮转淘汰，**运行记录不会**。所以「这一趟还能不能退」
      // 必须现查一次——否则界面上会给出「可回滚」的错觉，点下去才发现没得退。
      snapshotAvailable: snapId ? (await this.resolveSnapshotDir(snapId)) !== null : false,
      rolledBackAt: Number(m.rolledBackAt) || 0,
      rolledBackAtHuman: m.rolledBackAtHuman ?? '',
    })
  }
  out.sort((a, b) => b.runId.localeCompare(a.runId))
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(200, Math.round(Number(limit))) : 20
  return out.slice(0, n)
}

/** 读一份运行记录的完整声明（机读 + 人读）。 */
export async function readDeclaration(runId) {
  const id = safeName(runId)
  if (!id) throw new Error('sage-mem autodream: 运行 id 不合法')
  const dir = join(this.runsRoot, id)
  const manifest = await readJson(join(dir, 'manifest.json'))
  if (!manifest) throw new Error(`sage-mem autodream: 没有这份运行记录：${id}`)
  const markdown = await readFile(join(dir, 'declaration.md'), 'utf8').catch(() => this.renderDeclaration(manifest))
  return { runId: id, markdown, manifest }
}

// ────────────────────────────── 报告 ──────────────────────────────

/** 写一份报告到 `memory/autodream/<runId>.md`。 */
export async function writeReport(payload) {
  const dir = join(this.memoryDir, REPORT_DIR)
  await mkdir(dir, { recursive: true })
  // 报告名直接用 runId —— 它已经带时间戳，且与运行记录目录同名，两边对得上。
  const name = `${payload.runId}.md`
  const file = join(dir, name)

  const lines = [
    `# Autodream 报告 · ${stampHuman(payload.startedAt)}`,
    '',
    `- 运行：\`${payload.runId}\``,
    `- 触发：${payload.reason}`,
    `- 模式：${payload.apply ? '改写记忆（已建回滚点）' : '只出报告'}`,
    `- 输入源：${payload.source === 'memory+sessions' ? '记忆目录 + 会话记录' : '仅记忆目录'}`,
    `- 模型：\`${payload.provider}/${payload.model}\`${payload.fromDefault ? '（跟随当前会话默认模型）' : '（配置里指定）'}`,
    `- 门控：距上次 ${payload.hoursSince === null ? '（首次）' : payload.hoursSince.toFixed(1) + 'h'} · 期间 ${payload.sessionCount} 个会话更新`,
    `- 耗时：${((payload.endedAt - payload.startedAt) / 1000).toFixed(1)}s · token ${payload.tokensIn} in / ${payload.tokensOut} out`,
    payload.snapshot
      ? `- 回滚点：\`${payload.snapshot.id}\` · ${payload.snapshot.dir}（${payload.snapshot.count} 个文件）`
      : '- 回滚点：未做（只读模式不写盘）',
    '',
    '## 改动的文件',
    '',
    payload.touched.length ? payload.touched.map((f) => `- ${f}`).join('\n') : '- （没有改动任何文件）',
    '',
    '## 审计（运行前 → 运行后）',
    '',
    '```',
    `运行前：${payload.auditBefore.problems} 个问题`,
    `运行后：${payload.auditAfter.problems} 个问题`,
    '```',
    '',
    '### 运行后明细',
    '',
    '```',
    formatAudit(payload.auditAfter, 20),
    '```',
    '',
    // 声明内嵌进报告：一个文件就能回答「这趟干了什么、为什么」，不用两头翻。
    payload.declarationMarkdown,
    '## 过程',
    '',
    ...payload.transcript.map(
      (t) =>
        `- 第 ${t.step} 轮${t.tools.length ? `：调用 ${t.tools.join('、')}` : '：结束'}${t.text ? ` — ${t.text.slice(0, 120)}` : ''}`,
    ),
    '',
  ]
  await writeFile(file, lines.join('\n'), 'utf8')
  return { file, name }
}

/** 列已有报告（设置面板的历史列表）。新版目录 + 旧版目录都列，旧版标出来。 */
export async function listReports(limit = 30) {
  const out = []
  for (const [dirName, legacy] of [
    [REPORT_DIR, false],
    [LEGACY_REPORT_DIR, true],
  ]) {
    const dir = join(this.memoryDir, dirName)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const info = await stat(join(dir, e.name)).catch(() => null)
      out.push({
        name: legacy ? `${dirName}/${e.name}` : e.name,
        bytes: info?.size ?? 0,
        at: info?.mtimeMs ?? 0,
        atHuman: stampHuman(info?.mtimeMs ?? 0),
        legacy,
      })
    }
  }
  out.sort((a, b) => b.name.localeCompare(a.name))
  return out.slice(0, limit)
}

/** 读一份报告全文（白名单校验：只能是报告目录里的 .md，允许旧版目录前缀）。 */
export async function readReport(name) {
  let dirName = REPORT_DIR
  let base = String(name || '')
  if (base.startsWith(`${LEGACY_REPORT_DIR}/`)) {
    dirName = LEGACY_REPORT_DIR
    base = base.slice(LEGACY_REPORT_DIR.length + 1)
  }
  const safe = safeName(base)
  if (!safe || !/\.md$/i.test(safe)) throw new Error('sage-mem autodream: 报告名不合法')
  const content = await readFile(join(this.memoryDir, dirName, safe), 'utf8')
  return { name: dirName === REPORT_DIR ? safe : `${dirName}/${safe}`, content }
}

// ────────────────────────────── 回滚 ──────────────────────────────
