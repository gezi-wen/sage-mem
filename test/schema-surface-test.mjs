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

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
