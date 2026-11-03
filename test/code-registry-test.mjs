#!/usr/bin/env node
/**
 * 错误码登记守卫（2.2.0 新增）。
 *
 * 为什么需要它：`code` 曾经同时有三种命名法（snake / kebab / UPPER），
 * 而且**同一概念两个值并存**（`not_found` 与 `not-found`、`too_big` 与 `too-big`）。
 * 消费方只能两边都匹配，漏一边就是静默的错误分支 —— 这类漂移不会被任何功能测试抓到，
 * 因为每一条单测只看自己那条路径。
 *
 * 本套件盯三件事：
 *   1. `lib/**` 里出现的 `code:` 字面量必须在 `lib/shared/codes.js` 的清单里；
 *   2. 使用面与清单都不许出现 kebab-case；
 *   3. 清单自身「键 = 值」（唯一拼写）。
 *
 * 约定：三类码**不在本清单**，白名单列出 —— Node errno、宿主码、`Error.code`。
 * 白名单本身也被钉住（第 5 组），防止有人把真码塞进去。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')
const LIB = join(ROOT, 'lib')
const { CODES, CODE_VALUES } = await import(new URL('../lib/shared/codes.js', import.meta.url).href)

function walk(d, a = []) {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p, a)
    else if (e.endsWith('.js') && e !== 'client.js') a.push(p)
  }
  return a
}
const files = walk(LIB)

/** 剥注释：注释里提到 `code: 'x'` 不算使用（与 duplication-test 同一手法）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l })
    .join('\n')
}

/** 不属于本项目 code 命名空间的三类：Node errno / 宿主的码 / Error.code。 */
const NOT_OURS = new Set([
  // Node errno
  'ENOENT', 'EEXIST', 'EIO', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EBUSY', 'EMFILE', 'ENFILE', 'ELOOP', 'ENAMETOOLONG',
  // 宿主（DSH）的码：我们在解读它，不改名
  'FS_SANDBOX_DENIED', 'FS_STALE_VERSION',
  // 挂在 Error 对象上的码（与 errno 区分而保留 UPPER 前缀）
  'SAGE_MEM_UNVERIFIED_OVERWRITE', 'LOCK_TABLE_UNKNOWN',
])

const PATTERNS = [
  /\bcode:\s*'([A-Za-z0-9_-]+)'/g,
  /\.code\s*===\s*'([A-Za-z0-9_-]+)'/g,
  /\bcode\s*===\s*'([A-Za-z0-9_-]+)'/g,
  /\.code\s*!==\s*'([A-Za-z0-9_-]+)'/g,
]

const seen = new Map()
for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'))
  src.split('\n').forEach((line, i) => {
    for (const re of PATTERNS) {
      re.lastIndex = 0
      for (const m of line.matchAll(re)) {
        const v = m[1]
        if (!seen.has(v)) seen.set(v, [])
        seen.get(v).push(`${relative(ROOT, f).replace(/\\/g, '/')}:${i + 1}`)
      }
    }
  })
}

group('0. 前置：能读出东西来')
{
  ok(CODE_VALUES.size > 20, `清单登记了足够多的业务码（实际 ${CODE_VALUES.size}）`)
  ok(seen.size > 10, `在 lib 里扫到足够多的 code 字面量（实际 ${seen.size}）`)
  ok(files.length > 40, `扫描面覆盖足够多的源文件（实际 ${files.length}）`)
}

group('1. 每个业务码都在清单里')
{
  const unknown = [...seen.entries()].filter(([v]) => !NOT_OURS.has(v) && !CODE_VALUES.has(v))
  ok(unknown.length === 0, '没有未登记的业务码（新码必须先写进 codes.js）',
    unknown.map(([v, locs]) => `${v} @ ${locs[0]}`).join('; '))
  // 正向对照：清单里的码确实在用（清单不是空的）
  const used = [...CODE_VALUES].filter((v) => seen.has(v))
  ok(used.length > 10, `清单里超过十条真的在用（实际 ${used.length} / ${CODE_VALUES.size}）`)
}

group('2. 使用面与清单都是 snake_case')
{
  const kebabUsed = [...seen.keys()].filter((v) => /^[a-z]+-[a-z_-]+$/.test(v))
  ok(kebabUsed.length === 0, '使用面没有 kebab-case 的 code', kebabUsed.join(','))
  const kebabList = [...CODE_VALUES].filter((v) => v.includes('-'))
  ok(kebabList.length === 0, '清单里没有 kebab-case', kebabList.join(','))
  const upperUsed = [...seen.keys()].filter((v) => /^[A-Z_]+$/.test(v) && !NOT_OURS.has(v))
  ok(upperUsed.length === 0, '使用面没有未登记的 UPPER 码（Error.code 走白名单）', upperUsed.join(','))
}

group('3. 清单自身：键 = 值（唯一拼写）')
{
  const bad = Object.entries(CODES).filter(([k, v]) => k !== v)
  ok(bad.length === 0, '每个键的值等于键名', bad.map(([k, v]) => `${k}≠${v}`).join(','))
  ok(Object.values(CODES).every((v) => typeof v === 'string'), '清单值全是字符串')
}

group('4. 反向对照：判据确实会红')
{
  ok(!CODE_VALUES.has('ghost_code'), '【反向对照】未登记的值会被第 1 组判成未登记')
  ok(/^[a-z]+-[a-z_-]+$/.test('not-found'), '【反向对照】kebab 判据能识别 not-found')
  ok(/^[a-z]+-[a-z_-]+$/.test('lock-table-unknown'), '【反向对照】kebab 判据能识别多段 kebab')
  ok(!/^[a-z]+-[a-z_-]+$/.test('not_found'), '【反向对照】snake_case 不会被误判成 kebab')
  const fakeSources = new Map([['x.js', "return { code: 'ghost_code' }"]])
  const fakeSeen = new Map()
  for (const [, src] of fakeSources) {
    for (const re of PATTERNS) {
      re.lastIndex = 0
      for (const m of src.matchAll(re)) fakeSeen.set(m[1], ['x.js:1'])
    }
  }
  ok([...fakeSeen.keys()].some((v) => !NOT_OURS.has(v) && !CODE_VALUES.has(v)),
    '【反向对照】合成源码里的未登记码会被抓到', [...fakeSeen.keys()].join(','))
  ok([...NOT_OURS].every((v) => !CODE_VALUES.has(v)), '白名单与清单不重叠（防止把真码塞进白名单）')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
