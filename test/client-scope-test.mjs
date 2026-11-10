#!/usr/bin/env node
/**
 * 客户端作用域守卫（1.4.0 新增）。
 *
 * 客户端所有分片共享一个 factory 作用域 —— 这是「不用打包器」的代价：任何分片声明的
 * `const` 都对别的分片可见，重名会在拼接后**静默覆盖或直接语法错**。1.4.0 把
 * 跨屏复用的小基元收敛到 `client/05-shared.js`，这个套件盯两件事：
 *   1. 那批名字**只在 05 声明一次**，别处分片不许再写一份；
 *   2. 05 的拼接顺序在所有分片之前（否则后面的 const 在 TDZ 里，一 import 就炸）。
 *
 * 反面证据写在套件里（合成源码 → 判据必须报），不靠「我记得只有一份」。
 */
import { readFileSync, readdirSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const ROOT = new URL('../client/', import.meta.url)
const PARTS = [...readFileSync(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8')
  .matchAll(/'client\/(\d\d-[^']+\.js)'/g)].map((m) => m[1])
const SOURCES = new Map(PARTS.map((rel) => [rel, readFileSync(new URL(rel, ROOT), 'utf8')]))

/** 名字在哪些分片里被**声明**（function/const/let/class）。注释里的提法不算。 */
function declaredIn(name, sources = SOURCES) {
  const re = new RegExp(`(?:^|[^\\w$.])(?:function|const|let|class)\\s+${name.replace(/\$/g, '\\$')}\\b`)
  const out = []
  for (const [rel, src] of sources) if (re.test(src)) out.push(rel)
  return out
}
const SHARED = [
  'isStr', 'isBool', 'isNum', 'parseSchema', 'strSchema', 'unwrap', 'fmtSize', 'hexA',
  'TYPE_ORDER', 'TYPE_SORT', 'TYPE_LABEL', 'TYPE_META', 'TYPE_COLOR_DARK', 'TYPE_COLOR_LIGHT',
]

group('1. 共享基元只在 05-shared.js 声明一次')
for (const name of SHARED) {
  const where = declaredIn(name)
  ok(where.length === 1 && where[0] === '05-shared.js', `${name} 只在 05-shared.js 声明`, where.join(','))
}

group('2. 构建顺序：05 必须排在所有引用它的分片之前')
{
  const idx05 = PARTS.indexOf('05-shared.js')
  ok(idx05 >= 0, 'build-client.mjs 的 CLIENT_PARTS 包含 05-shared.js')
  const before = PARTS.slice(0, idx05)
  ok(before.every((p) => !declaredIn('isStr', new Map([[p, SOURCES.get(p)]])).length),
    '05 之前的分片不声明共享基元（TDZ 安全）', before.join(','))
  ok(PARTS.indexOf('10-starmap-head.js') > idx05 && PARTS.indexOf('20-codecs.js') > idx05 && PARTS.indexOf('50-shared-ui.js') > idx05,
    '10 / 20 / 50 都排在 05 之后')
  const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok(built.includes('共享基元（1.4.0）'), '构建产物里确实含 05 的共享基元段')
  ok((built.match(/共享基元（1\.4\.0）/g) || []).length === 1, '产物里这份基元只出现一次（没被重复拼接）')
}

group('3. 死代码确实删掉了（删之前各自都在仓库里出现过）')
{
  const all = [...SOURCES.values()].join('\n')
  ok(!all.includes('StarmapOverlay'), 'StarmapOverlay 已删（B 方案后只剩子槽渲染）')
  ok(!all.includes('StarmapEdgeTab'), 'StarmapEdgeTab 已删（右缘浮标）')
  ok(!all.includes('uiStore'), 'uiStore 已删（随两个入口一起死）')
  ok(!all.includes('useOpen'), 'useOpen 已删')
  ok(!/\bfmtBytes\s*\(/.test(all), 'fmtBytes 已并入 fmtSize（星图不再有第二套字节格式化）')
  ok(!all.includes('smem-seg'), '无样式类名 smem-seg 已从 DOM 里拿掉')
  ok(!all.includes('smem-audit-secs'), '无样式类名 smem-audit-secs 已从 DOM 里拿掉')
}

group('4. 【反向对照】判据会红')
{
  const fake = new Map([
    ['05-shared.js', 'const isStr = 1'],
    ['20-codecs.js', 'const isStr = 2'],
  ])
  const where = declaredIn('isStr', fake)
  ok(where.length === 2, '【反向对照】同一基元声明两份 → 判据报 2 处', where.join(','))
  const once = declaredIn('isStr', new Map([['05-shared.js', 'const isStr = 1']]))
  ok(once.length === 1 && once[0] === '05-shared.js', '【反向对照】只有 05 一份 → 判据通过')
  ok(!declaredIn('isStr', new Map([['20-codecs.js', '// isStr 在 05\nconst fileSchema = 1']])).includes('20-codecs.js'),
    '【反向对照】注释里提到不算声明')
}

group('5. 每个作用域内的顶层声明不许重名（2026-11-03：原 14 名单只覆盖 8.5%）')
{
  // 作用域归属是**结构事实**，不是推测：10/11/12/13 在 StarmapRuntime IIFE 内，
  // 00/05/20..80 在 factory 主体。两者缩进都是 2 tab，所以只能按分片前缀分。
  // 为什么这条比「14 名单」重要：同一作用域里 `const` 重名会 SyntaxError（安全），
  // 但 **`function` 重名是静默覆盖**（后者胜出、零报错）—— 那正是最危险的形状。
  const scopeOf = (rel) => (/^(10|11|12|13)-/.test(rel) ? 'starmap-iife' : 'factory')
  const DECL = /^\t\t(?:const|let|var|function|class|async function)\s+([A-Za-z0-9_$]+)/gm
  const collect = (sources) => {
    const byScope = new Map()
    for (const [rel, src] of sources) {
      for (const m of src.matchAll(DECL)) {
        const sc = scopeOf(rel)
        if (!byScope.has(sc)) byScope.set(sc, new Map())
        const map = byScope.get(sc)
        if (!map.has(m[1])) map.set(m[1], [])
        map.get(m[1]).push(rel)
      }
    }
    return byScope
  }
  const hits = (byScope) => {
    const out = []
    for (const [sc, map] of byScope) for (const [name, files] of map) if (files.length > 1) out.push(`${sc}/${name} ← ${files.join(',')}`)
    return out
  }
  const byScope = collect(SOURCES)
  const total = [...byScope.values()].reduce((n, m) => n + [...m.values()].reduce((a, v) => a + v.length, 0), 0)
  ok(total > 100, `扫到足够多的顶层声明（实际 ${total}）`)
  const dupes = hits(byScope)
  ok(dupes.length === 0, '同一作用域内没有重名顶层声明（function 重名会静默覆盖）', dupes.join(' | '))
  // 反向对照：同作用域两份同名 function → 必须报出来
  const fakeDup = hits(collect(new Map([
    ['50-shared-ui.js', '\t\tfunction dupFn() {}'],
    ['70-memory-panel.js', '\t\tfunction dupFn() {}'],
  ])))
  ok(fakeDup.length === 1, '【反向对照】同作用域两份同名 function → 判据报 1 处', fakeDup.join(','))
  // 跨作用域同名**不算错**：CSS / TYPERT_REMOTE / listSchema / readSchema 是两处不同作用域的有意声明
  const crossHits = hits(collect(new Map([
    ['40-styles.js', '\t\tconst CSS = []'],
    ['11-starmap-styles.js', '\t\tconst CSS = []'],
  ])))
  ok(crossHits.length === 0, '【反向对照】跨作用域同名（CSS）不报')
}

group('6. 体检分类表只许一处（2.6.0：面板分节与「复制修复提示词」共用）')
{
  // 这张表描述的是「体检有哪些类、每类怎么渲染一行」。面板（50）与提示词（56）各抄一份，
  // 就会变成「面板上显示 8 条、复制出去的只有 6 条」这种只有用户才发现的错。
  const where = declaredIn('AUDIT_SECTIONS')
  ok(where.length === 1 && where[0] === '56-health-prompt.js',
    'AUDIT_SECTIONS 只在 56-health-prompt.js 声明一次', where.join(','))
  ok((SOURCES.get('50-shared-ui.js') || '').includes('AUDIT_SECTIONS'),
    '面板（50-shared-ui.js）确实复用了这张表，而不是自己再写一份')
  ok((SOURCES.get('50-shared-ui.js') || '').includes('AUDIT_ARCHIVED_LINKS'),
    '「指向已归档」的条目格式也共用（两处只各写自己的标题）')
  // 判据本身要有反证：把同一张表的两份声明塞进去，必须报出来
  const fake = declaredIn('AUDIT_SECTIONS', new Map([
    ['56-health-prompt.js', '\t\tconst AUDIT_SECTIONS = []'],
    ['50-shared-ui.js', '\t\tconst AUDIT_SECTIONS = []'],
  ]))
  ok(fake.length === 2, '【反向对照】两处各自声明一份 → 判据报 2 处', fake.join(','))
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
