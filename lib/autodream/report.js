/**
 * autodream —— 整理声明与人读报告（引擎方法体）。
 *
 * 本文件里的函数都是 `AutodreamEngine` 的方法体：`engine.js` 里保留同名同签名的方法，
 * 用 `xxxMod.name.call(this, …)` 转发进来 —— 所以函数体里的 `this` 就是引擎实例，
 * 与拆分前完全一致，没有引入任何模块级可变状态。
 */

import { formatAudit } from './audit.js'
import { budgetFactGroups, FACTS_TOTAL_MAX } from './facts.js'
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
    // 自动归档策略那一段：候选清单是**确定性算出来的**（访问台账 → updated → mtime），
    // 与模型的判断无关。report 模式下这里就是全部动作（一个文件都不动）。
    archive: {
      mode: payload.archiveMode ?? 'off',
      requested: payload.archiveRequested ?? payload.archiveMode ?? 'off',
      candidates: payload.archiveCandidates ?? [],
      archived: payload.archivedByPolicy ?? [],
      // 降级说明（例如 auto 撞上只读模式）：非空就是「配置想要的没做成，原因在这儿」。
      degraded: payload.archiveDegraded ?? '',
    },
    report: payload.report ?? null,
    finalText: payload.finalText ?? '',
    // 1.0.1：输出撞上单次上限这件事要进机读记录 —— 残篇在界面上和「话说一半」长得一模一样。
    continuations: Number(payload.continuations) || 0,
    // 1.9.2：零正文重试是另一本账 —— 「接着写过」与「根本没写出来」不能混成一个数字。
    retries: Number(payload.retries) || 0,
    truncated: payload.truncated === true,
    rolledBackAt: 0,
    rolledBackAtHuman: '',
  }
  const markdown = this.renderDeclaration(manifest)
  // 人读用完整数据渲染（它自己有 8000 字符的预算），机读记录才按 64 KB 裁 —— 见 capFactsForManifest。
  const capped = capFactsForManifest(manifest)
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(capped.stored, null, 2), 'utf8')
  await writeFile(join(dir, 'declaration.md'), markdown, 'utf8')
  return { dir, manifest, markdown, factsTruncated: capped.capped }
}

/**
 * 从一份 manifest 里收拢「被删掉的事实」，来源有两处：
 *   - `changes[]`：模型调用 `write_memory`（改写）与 `archive_memory`（整条退役）时宿主算的 diff；
 *   - `archive.archived[]`：自动归档策略收走的文件（模型没碰过，但事实同样从活动记忆里消失）。
 *
 * 两处都要收 —— 只收 changes 会漏掉自动归档，那正好是「无人值守时丢了东西」最容易发生的地方。
 */
function collectFactGroups(m) {
  const groups = []
  const push = (src, kind) => {
    const facts = Array.isArray(src?.removedFacts) ? src.removedFacts.filter((f) => f && typeof f.text === 'string') : []
    if (!facts.length) {
      /**
       * 读不到旧正文：**必须留痕**。否则「这一趟读不到、不知道删了什么」与
       * 「这一趟什么都没删」在纸上长得一模一样 —— 而它们是完全不同的两件事。
       */
      if (src?.removedUnavailable === true) {
        groups.push({
          file: String(src.file ?? ''),
          kind,
          removed: [],
          total: 0,
          beforeLines: 0,
          afterLines: 0,
          title: '',
          unavailable: true,
        })
      }
      return
    }
    groups.push({
      file: String(src.file ?? ''),
      kind,
      removed: facts,
      total: Number(src.removedTotal) || facts.length,
      beforeLines: Number(src.linesBefore) || 0,
      afterLines: Number(src.linesAfter) || 0,
      title: typeof src.entryTitle === 'string' ? src.entryTitle : '',
    })
  }
  for (const c of Array.isArray(m.changes) ? m.changes : []) push(c, c?.removedKind === 'archive' ? 'archive' : 'rewrite')
  for (const a of Array.isArray(m.archive?.archived) ? m.archive.archived : []) {
    // ⚠️ 归档**失败**的条目一个字都不能列：文件还在活动记忆里（最常见是 archive/ 已有同名），
    // 把它列进「被删掉的事实」会让同一份声明自相矛盾 —— 2026-11-05 审查抓到这处。
    if (a?.ok === false) continue
    push(a, 'archive')
  }
  return groups
}

/**
 * 渲染「被删掉的事实」一节。
 *
 * 这一节存在的唯一理由：**结构审计看不见事实丢失**。它能报断链、格式、索引不一致，
 * 但一条仍然生效的账被压缩掉时，它在每一张表上都是绿的（2026-11-05 实测）。
 * 所以这里不留一句概括，逐条列原文 —— 人扫一眼就能说「这条不该删」。
 */
function renderRemovedFacts(lines, groups, H) {
  if (!groups.length) return
  const { shown, omittedGroups, omittedFacts } = budgetFactGroups(groups)
  if (!shown.length) return
  lines.push(
    `${H}# 被删掉的事实`,
    '',
    '> 这一趟之后，下面这些内容**不再存在于活动记忆里**。结构审计（断链 / 格式 / 索引）',
    '> 看不见事实丢失 —— 2026-11-05 就有「一条仍然生效的到期账被压缩掉、审计报 2→0 全绿」的先例。',
    '> 对着这里扫一眼，比事后翻回滚点便宜得多。',
    '>',
    '> 行号 `L12` 指**改动前**那份正文的行号（归档条目指 `archive/` 里那份），在回滚点快照里对得上。',
    '',
  )
  for (const g of shown) {
    if (g.unavailable) {
      lines.push(
        `**\`${g.file}\`**（${g.kind === 'archive' ? '归档' : '改写'} · ⚠ 改动前的原文读不到，这一条给不出对照）`,
        '',
      )
      continue
    }
    lines.push(
      g.kind === 'archive'
        ? `**\`${g.file}\`**（归档 · 承载 ${g.total} 条事实${g.title ? ` · 「${g.title}」` : ''}）`
        : // 说「事实行」而不是「行」：这个数字是**去掉空行与 frontmatter 之后**的行数，
          // 拿它当文件行数会让人对不上（一篇 60 行的文件可能只有 45 个事实行）。
          `**\`${g.file}\`**（改写 · 事实行 ${g.beforeLines} → ${g.afterLines} · 删掉 ${g.total} 条）`,
    )
    for (const f of g.removed) {
      // 有 mergedInto 只是**线索**（按长度比例推测「可能被并进了哪一行」），不是「所以没删」。
      // 合并、否定翻转（「自动续费」→「不自动续费」）都可能落在这一档，判断交给人。
      const hint = f.mergedInto ? `（内容可能已并进 \`L${f.mergedInto}\`，按长度比例推测）` : ''
      lines.push(`- \`L${f.line}\` ${String(f.text).replace(/\s*\n\s*/g, ' ')}${hint}`)
    }
    const unlisted = g.total - g.removed.length
    if (unlisted > 0) {
      lines.push(`- …还有 ${unlisted} 条没列（全文${g.kind === 'archive' ? '已移入 `archive/`' : '在回滚点快照里'}）`)
    }
    lines.push('')
  }
  if (omittedGroups) {
    lines.push(
      `> ⚠ 还有 ${omittedGroups} 个文件共 ${omittedFacts} 条没列出` +
        `（这一节上限 ${FACTS_TOTAL_MAX} 字符；完整差异见回滚点快照）`,
      '',
    )
  }
}

/**
 * `manifest.json` 里「被删事实」的总量上限（字符）。
 *
 * **为什么需要**：运行记录**不轮转**（`listRuns` 那边写着「运行记录不会淘汰」），
 * 一份被几百条事实撑到几百 KB 的机读记录会一直躺在状态目录里、一次都不会被清掉。
 * 人读的 `declaration.md` 另有一份 8000 字符的预算，两边各算各的 —— 它们服务两种读者。
 */
const MANIFEST_FACTS_MAX = 64 * 1024

/**
 * 按预算裁掉机读记录里的事实明细（保留 `removedTotal` 这个数字，只丢原文）。
 *
 * ⚠️ 只在**写盘**时裁：`renderDeclaration` 拿到的是完整数据，所以人读的声明不受影响。
 */
function capFactsForManifest(manifest) {
  let used = 0
  let capped = false
  const take = (list) => {
    const keep = []
    for (const f of list) {
      // ⚠️ 按**字节**算，不是按 `String.length` —— 中文一个字 3 字节，
      // 按字符数封顶会让上限定成 64 KB 却写出 190 KB 的文件（第一版就这么错的）。
      const cost = Buffer.byteLength(String(f?.text ?? ''), 'utf8') + 24
      if (used + cost > MANIFEST_FACTS_MAX) {
        capped = true
        break
      }
      used += cost
      keep.push(f)
    }
    return keep
  }
  const changes = (Array.isArray(manifest.changes) ? manifest.changes : []).map((c) => {
    if (!Array.isArray(c?.removedFacts) || !c.removedFacts.length) return c
    const keep = take(c.removedFacts)
    return keep.length === c.removedFacts.length ? c : { ...c, removedFacts: keep, factsOmitted: true }
  })
  const archived = (Array.isArray(manifest.archive?.archived) ? manifest.archive.archived : []).map((a) => {
    if (!Array.isArray(a?.removedFacts) || !a.removedFacts.length) return a
    const keep = take(a.removedFacts)
    return keep.length === a.removedFacts.length ? a : { ...a, removedFacts: keep, factsOmitted: true }
  })
  return {
    stored: { ...manifest, changes, archive: { ...manifest.archive, archived }, ...(capped ? { factsTruncated: true } : {}) },
    capped,
  }
}

/** 渲染人读声明（报告里内嵌，所以标题层级可以从外面压）。 */
export function renderDeclaration(m, headingLevel = 1) {  const H = '#'.repeat(Math.max(1, Math.min(6, headingLevel)))
  const lines = [
    `${H} 整理声明 · ${m.startedAtHuman}`,
    '',
    `- 运行：\`${m.runId}\` · 模式：${m.mode === 'apply' ? '直接改写' : '只出报告'} · 模型：\`${m.route.provider}/${m.route.model}\``,
    m.snapshot
      ? `- 回滚点：\`${m.snapshot.id}\`（${m.snapshot.files} 个文件）`
      : '- 回滚点：未做（只出报告模式不写盘，无需回滚）',
    `- 审计：结构问题 ${m.audit.before.problems} → ${m.audit.after.problems}`,
    ...(m.truncated
      ? [
          `- ⚠️ 输出被单次长度上限截断：续写 ${m.continuations ?? 0} 轮${m.retries ? `、零正文重试 ${m.retries} 次` : ''}后仍未写完，收尾说明是**残篇**`,
        ]
      : m.retries
        ? [`- 输出曾出现零正文截断（思考吃满额度），重试 ${m.retries} 次后补齐`]
        : m.continuations
          ? [`- 输出曾撞上单次长度上限，已自动续写 ${m.continuations} 轮补齐`]
          : []),
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
  // 「删了什么」紧跟在改动表之后：读完「改了哪几个文件」自然要问「丢了哪些事实」。
  // 必须放在自动归档候选**之前** —— 那一节是「将要发生的清单」，混在一起会读成同一件事。
  renderRemovedFacts(lines, collectFactGroups(m), H)
  if (m.archive && m.archive.mode !== 'off' && (m.archive.candidates.length || m.archive.degraded)) {
    lines.push(`${H}# 自动归档候选（策略：${m.archive.mode}）`, '')
    // 降级必须**明说**：用户设了 auto 却什么都没动，原因不写在报告里就等于静默失灵。
    if (m.archive.degraded) lines.push(`> ⚠ ${m.archive.degraded}`, '')
    if (m.archive.mode === 'auto') {
      const done = m.archive.archived.filter((a) => a.ok).length
      lines.push(`- 已移入 \`archive/\`：${done} / ${m.archive.archived.length} 条（只移不删）`)
    } else {
      lines.push('- **本次只出清单，没有移动任何文件**（策略 `report`；想自动跑请把 `autoArchive` 改成 `auto`）')
    }
    lines.push('')
    if (m.archive.candidates.length) {
      lines.push('| 文件 | 类型 | 闲置 | 阈值 | 说明 |', '|---|---|---|---|---|')
      for (const c of m.archive.candidates) {
        lines.push(`| \`${c.file}\` | ${c.type} | ${c.days} 天 | ${c.limit} 天 | ${c.reason} |`)
      }
      lines.push('')
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

  /**
   * 输出撞上限这件事**必须在报告第一屏就说**。
   * 为什么：残篇与「模型话说一半」在文件里长得一样，读者无从分辨；而这一版之前，
   * 被截断的那份报告在界面上报的是「成功」。
   */
  const truncLines = payload.truncated
    ? [
        `- ⚠️ **本次输出被单次长度上限截断**：自动续写 ${payload.continuations ?? 0} 轮` +
          `${payload.retries ? `、零正文重试 ${payload.retries} 次` : ''}后仍未写完 —— ` +
          '下面「模型的收尾说明」是**残篇**，后文缺失',
      ]
    : payload.retries
      ? [`- 输出曾出现零正文截断（思考吃满额度），重试 ${payload.retries} 次后补齐（报告完整）`]
      : payload.continuations
        ? [`- 输出曾撞上单次长度上限，已自动续写 ${payload.continuations} 轮补齐（报告完整）`]
        : []

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
    ...truncLines,
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
    ...payload.transcript.map((t) => {
      // 「续写」与「零正文重试」都必须标出来：否则同一轮出现好几条，读起来像模型重复劳动。
      // 两者分开标 —— 一个是「接着写」，一个是「上一段根本没写出来」，读者要看得出区别。
      const mark = t.retry ? '（零正文重试）' : t.continuation ? '（截断续写）' : ''
      const kind = t.tools.length ? `：调用 ${t.tools.join('、')}` : '：结束'
      // ⚠️ **先压平空白再截断**。模型这一步的文字里常带换行与 `## 标题`，直接 slice(0,120)
      // 会把标题漏成真标题 —— 报告读起来像「内容重复了一遍」（2026-10-17 10:42 那次真踩到：
      // 「过程」最后一条把下一节的 `## 一、必须修改的…` 顶了出来）。
      const brief = String(t.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
      return `- 第 ${t.step} 轮${mark}${kind}${brief ? ` — ${brief}` : ''}`
    }),
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
