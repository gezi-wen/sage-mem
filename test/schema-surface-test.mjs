#!/usr/bin/env node
/**
 * 契约面「宿主真实返回值 → manifest schema」逐条过堂（2026-11-22 建）。
 *
 * 为什么单开一份：`typert-test.mjs` 只覆盖 autodream 那 11 条，而 strict 结果 schema 的
 * 失效形态不是「少一个字段」，是**整条调用被判坏**或**字段被静默 strip**。
 * 2026-11-22 的外部审查一次点出六处「代码返回了、schema 没声明」——它们的共同点是
 * **没有一条断言拿真实返回值去 safeParse**。这份文件就是那六条断言的落脚处。
 *
 * 做法：不启动引擎、不读盘，只把**已知的真实返回形状**（含失败分支）喂给同一条 invocation
 * 的 schema，断言 (a) 通过，(b) 该有的字段还在（没被 strip 掉），(c) 额外字段会被 strip
 * （这是 strict + z.object 的既定语义，写出来是为了让人知道「多给也没用」）。
 *
 * 用法: node test/schema-surface-test.mjs
 */
const LIB = new URL('../lib/', import.meta.url)
const { TYPERT } = await import(new URL('typert.host.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')) }
}

const invocation = (id) => {
  const found = TYPERT.invocations.find((i) => i.id === id)
  if (!found) throw new Error(`manifest 里没有 ${id}`)
  return found
}
const parse = (id, value) => invocation(id).result.schema.safeParse(value)

// ── 2.15.6（M1）：memory/getSettings 的 limitDiagnostics ────────────────────
console.log('== 2.15.6 · getSettings.limitDiagnostics ==')
{
  const limits = { maxResults: 10, maxChars: 1500, maxBaseline: 8000, maxSessionBytes: 61440, staleDays: 90 }
  const payload = {
    limits,
    pendingLimits: limits,
    restartRequired: false,
    ui: { entry: 'sidebar', sidebarEntry: true },
    reserved: ['session-log.md'],
    reservedExtra: [],
    experimental: { mmr: 0, todoBoard: 1 },
    pendingExperimental: { mmr: 0, todoBoard: 1 },
    // Q04 的真实形态：坏设置 / 越界项 / 启动期告警各一条
    limitDiagnostics: ['settings.json 不是合法 JSON', 'maxResults 越界（1）', '启动期：SAGE_MEM_MAX_CHARS 非法'],
  }
  const r = parse('sage-mem#memory/getSettings', payload)
  ok(r.success, 'getSettings 的真实返回过 schema', r.success ? '' : JSON.stringify(r.error?.issues?.slice(0, 3)))
  ok(r.success && Array.isArray(r.data.limitDiagnostics) && r.data.limitDiagnostics.length === 3,
    'limitDiagnostics 没被 strip（三条诊断都在）', r.success ? JSON.stringify(r.data.limitDiagnostics) : '')
  const extra = parse('sage-mem#memory/getSettings', { ...payload, somethingNew: 1 })
  ok(extra.success && extra.data.somethingNew === undefined, '没声明的字段会被 strip（这是既定语义，不是 bug）')
  const bad = parse('sage-mem#memory/getSettings', { ...payload, limitDiagnostics: 'not-an-array' })
  ok(bad.success === false, 'limitDiagnostics 给错类型时 schema 会拒（不是静默放行）')
}

// ── 2.15.7（M2）：memory/archiveCandidates 的 lockedUnknown / lockedError ──
console.log('== 2.15.7 · archiveCandidates.lockedUnknown / lockedError ==')
{
  const base = {
    count: 2,
    candidates: [
      { file: 'project_a.md', type: 'project', days: 40, limit: 30, reason: 'stale' },
      { file: 'reference_b.md', type: 'reference', days: 61, limit: 60, reason: 'stale' },
    ],
    autoArchive: 'off',
    thresholds: { project: 30, reference: 60, user: 0 },
    locked: ['project_locked.md'],
    lockedUnknown: false,
    lockedError: '',
  }
  const okState = parse('sage-mem#memory/archiveCandidates', base)
  ok(okState.success, '锁表可读时的返回过 schema', okState.success ? '' : JSON.stringify(okState.error?.issues?.slice(0, 3)))
  ok(okState.success && okState.data.lockedUnknown === false, 'lockedUnknown 没被 strip（false 也在）')
  const unknown = parse('sage-mem#memory/archiveCandidates', { ...base, lockedUnknown: true, lockedError: 'locked.json 不是合法 JSON' })
  ok(unknown.success && unknown.data.lockedUnknown === true && /locked\.json/.test(unknown.data.lockedError || ''),
    '锁表坏掉时 lockedUnknown / lockedError 都还在（「不知道」不会被渲染成「都没锁」）')
}

// ── 2.15.8（M3）：autodream 的 lastResult 里 continuations / retries / truncated ──
console.log('== 2.15.8 · autodream.lastResult 的残篇标记 ==')
{
  const last = {
    at: 1763712000000, atHuman: '2026-11-22 01:00', ok: true, apply: true,
    touched: ['project_a.md'], changeCount: 1, problemsBefore: 3, problemsAfter: 1,
    tokensIn: 12000, tokensOut: 800, runId: 'run-1', preflight: false,
    continuations: 2, retries: 1, truncated: true,
    report: '20261122-010000.md', snapshotId: 'snap-1',
  }
  // 整条 status 的夹具要铺 config / paths / steps，噪音太大；这里直接取内层 lastResult 的
  // schema 验「残篇三键」，另用 key 清单钉住「不再漏声明」。
  const unwrap = (s) => (typeof s?.unwrap === 'function' ? s.unwrap() : s)
  const statusSchema = unwrap(invocation('sage-mem#autodream/status').result.schema)
  const inner = unwrap(unwrap(statusSchema.shape.lastResult))
  const keys = Object.keys(inner.shape || {})
  ok(keys.includes('truncated') && keys.includes('continuations') && keys.includes('retries'),
    'lastResult 的三个残篇标记都声明了', keys.join(','))
  const one = inner.safeParse(last)
  ok(one.success, '真实 lastResult 形状过 schema', one.success ? '' : JSON.stringify(one.error?.issues?.slice(0, 3)))
  ok(one.success && one.data.truncated === true && one.data.continuations === 2 && one.data.retries === 1,
    'truncated / continuations / retries 都没被 strip（残篇不会被显示成成功）',
    one.success ? JSON.stringify({ t: one.data.truncated, c: one.data.continuations, r: one.data.retries }) : '')
}

// ── 2.15.9（M4）：memory/setLocked 的失败分支形状 ──────────────────────────
console.log('== 2.15.9 · setLocked 的失败分支 ==')
{
  const success = parse('sage-mem#memory/setLocked', { ok: true, file: 'project_a.md', locked: true })
  ok(success.success && success.data.locked === true, '成功分支过 schema')
  const failure = parse('sage-mem#memory/setLocked', {
    ok: false, code: 'lock_unknown', error: '锁表不可读（locked.json 不是合法 JSON），本次没有写入',
  })
  ok(failure.success, '失败分支也过 schema（不再因为缺 file/locked 被判坏）',
    failure.success ? '' : JSON.stringify(failure.error?.issues?.slice(0, 3)))
  ok(failure.success && /锁表不可读/.test(failure.data.error || '') && failure.data.code === 'lock_unknown',
    '失败原因与错误码都保留（界面能说清「什么都没写」）')
}

// ── 2.15.11（M5）：memory/recallDebug 的 gated / validitySuppressed ────────
console.log('== 2.15.11 · recallDebug 的两个「为什么没进来」 ==')
{
  const base = {
    at: 1763712000000, sessionId: 's1', query: '为什么这条没进来', outcome: 'empty', deduped: false,
    baseline: 2, scanned: 120, hits: 0, scores: [{ file: 'a.md', score: 3.5 }], body: [],
    picked: [], injected: [], chars: 0, sessionChars: 0, cardChars: 0, skippedByBudget: 0, card: '',
  }
  const gated = parse('sage-mem#memory/recallDebug', { enabled: true, records: [{ ...base, gated: true }] })
  ok(gated.success, '带 gated 的记录过 schema', gated.success ? '' : JSON.stringify(gated.error?.issues?.slice(0, 3)))
  ok(gated.success && gated.data.records[0].gated === true, 'gated 没被 strip（「同题没重算」看得见）')
  const suppressed = parse('sage-mem#memory/recallDebug', {
    enabled: true,
    records: [{
      ...base, gated: false,
      validitySuppressed: [
        { file: 'old.md', reason: 'expired_source', label: '已失效' },
        { file: 'clash.md', reason: 'conflict_pending', label: '待裁决矛盾', conflictId: 'c-1' },
      ],
    }],
  })
  ok(suppressed.success, '带 validitySuppressed 的记录过 schema', suppressed.success ? '' : JSON.stringify(suppressed.error?.issues?.slice(0, 3)))
  ok(suppressed.success && suppressed.data.records[0].validitySuppressed.length === 2,
    'validitySuppressed 没被 strip（被挡掉的条目连同 conflictId 都在）')
}

// ── 2.15.12（M6）：memory/audit 的 indexConflicts / indexFile ──────────────
console.log('== 2.15.12 · audit 的索引变体与索引文件名 ==')
{
  const empty = (n) => Array.from({ length: n }, (_, i) => ({ file: `x${i}.md` }))
  const report = {
    dir: 'memory', fileCount: 124, skipped: 0, archivedCount: 128, indexEntries: 130,
    problems: 1, dangling: [], unlisted: [], typeMismatch: [], crlf: [], brokenLinks: [],
    archivedLinks: [], hashHazards: [], noFrontmatter: [], unreadable: [], strays: [],
    validityHints: [], orphans: [], indexProposals: [], indexOversize: [],
    indexConflicts: [{ file: 'MEMORY.md' }, { file: 'memory.md' }],
    indexFile: 'MEMORY.md',
  }
  const r = parse('sage-mem#memory/audit', report)
  ok(r.success, 'audit 报告过 schema', r.success ? '' : JSON.stringify(r.error?.issues?.slice(0, 3)))
  ok(r.success && Array.isArray(r.data.indexConflicts) && r.data.indexConflicts.length === 2,
    'indexConflicts 没被 strip（「索引有多份变体」终于有渲染位置）')
  ok(r.success && r.data.indexFile === 'MEMORY.md', 'indexFile 也在（null 表示没有索引文件）')
  const nul = parse('sage-mem#memory/audit', { ...report, indexFile: null })
  ok(nul.success && nul.data.indexFile === null, '没有索引文件时 indexFile 是 null，不判坏')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
