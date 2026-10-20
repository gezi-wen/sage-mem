#!/usr/bin/env node
/**
 * 「同一个字面量只许有一种定义」的启发式守卫（1.3.0 新增）。
 *
 * 1.3.0 收敛了文件名规则 / 时间戳 / 体积上限。合并完成不等于以后不会长回去 ——
 * 下一个人复制粘贴一个 `'session-log.md'` 不会有任何东西变红。这里按**字面量**扫
 * `lib/**`：每个"应该只有一处"的串，只允许出现在白名单文件里。
 *
 * ⚠️ 扫描前先剥注释：这些词在解释性注释里被提到是**正确**的（注释就是写给下一个人看的），
 * 只有代码里再写一份才是重复。剥法朴素，但这里只用于"出现次数"判断，误伤方向是漏报。
 *
 * 反向对照写在本套件里（不碰仓库文件）：构造一份带重复的源码，判据必须报出来。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { relative } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const LIB = new URL('../lib/', import.meta.url)
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.js') && e.name !== 'client.js') out.push({ rel: relative(decodeURIComponent(LIB.pathname).replace(/^\//, ''), decodeURIComponent(p.pathname).replace(/^\//, '')).replace(/\\/g, '/'), src: readFileSync(p, 'utf8') })
  }
  return out
}
const SOURCES = walk(LIB)
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 判据：literal 出现在 allow 之外的文件里 → 违规。 */
function violations(sources, literal, allow) {
  const out = []
  for (const f of sources) {
    if (allow.includes(f.rel)) continue
    const n = strip(f.src).split(literal).length - 1
    if (n > 0) out.push(`${f.rel}(${n})`)
  }
  return out
}

const RULES = [
  { literal: "'session-log.md'", allow: ['shared/md-name.js'], why: '流水规范名只在 shared/md-name.js（其余用 SESSION_LOG_KEY）' },
  { literal: "'memory.md'", allow: ['shared/md-name.js'], why: '索引规范名只在 shared/md-name.js（其余用 INDEX_FILE_KEY）' },
  { literal: 'MAX_FILE_BYTES =', allow: ['shared/limits.js'], why: '512 KB 上限只在 shared/limits.js 定义' },
  { literal: 'MAX_RAW_BYTES =', allow: ['shared/limits.js'], why: '4 MB 上限只在 shared/limits.js 定义' },
  { literal: '${p(d.getMonth() + 1)}-${p(d.getDate())}', allow: ['shared/stamp.js'], why: '本地日期/时间戳只在 shared/stamp.js 格式化' },
  { literal: 'LIMIT_SPECS = {', allow: ['memory/config.js'], why: '注入上限的取值与边界只在 memory/config.js' },
  { literal: 'NON_ENTRY_FILES = new Set', allow: ['memory/config.js'], why: '非记忆条目集合只在 memory/config.js' },
]

group('1. 每个「只许一处」的字面量都只剩一处')
for (const r of RULES) {
  const bad = violations(SOURCES, r.literal, r.allow)
  ok(bad.length === 0, r.why, bad.join(', '))
  ok(SOURCES.some((f) => r.allow.includes(f.rel) && f.src.includes(r.literal)),
    `白名单文件里确实还留着它：${r.literal}`, r.allow.join(','))
}

group('2. 共享模块必须是零依赖')
{
  for (const name of ['md-name.js', 'stamp.js', 'limits.js']) {
    const f = SOURCES.find((x) => x.rel === `shared/${name}`)
    ok(!!f && !/^import\s/m.test(f.src), `${name} 零 import（谁都能引，不制造循环）`, f ? f.src.match(/^import[^\n]*/m)?.[0] : '文件不存在')
  }
}

group('3. lib/ 根目录只剩组合根与再导出层')
{
  const root = SOURCES.filter((f) => !f.rel.includes('/')).map((f) => f.rel).sort()
  ok(JSON.stringify(root) === JSON.stringify(['autodream.js', 'index.js', 'settings.js', 'typert.host.js', 'update.js']),
    'lib/ 根只有 index / autodream / settings / update / typert.host（client.js 是构建产物已排除）', root.join(','))
}

group('4. 【反向对照】判据本身会红')
{
  const fake = [
    { rel: 'shared/limits.js', src: 'export const MAX = 512 * 1024' },
    { rel: 'memory/elsewhere.js', src: 'const x = 512 * 1024' },
  ]
  const v = violations(fake, '512 * 1024', ['shared/limits.js'])
  ok(v.length === 1 && v[0].startsWith('memory/elsewhere.js'), '【反向对照】多写一份副本 → 判据命中', v.join(','))
  const clean = [fake[0]]
  ok(violations(clean, '512 * 1024', ['shared/limits.js']).length === 0, '【反向对照】只有白名单那一份 → 不报')
  const commented = [{ rel: 'memory/x.js', src: '// 512 * 1024 是上限\n/* 512 * 1024 */' }]
  ok(violations(commented, '512 * 1024', []).length === 0, '【反向对照】注释里提到不算重复（先剥注释）')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
