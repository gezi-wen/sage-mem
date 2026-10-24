#!/usr/bin/env node
/**
 * release-test.mjs — 发布物一致性守卫（1.6.2 新增，对应外部审查 DOC-01 / REL-01 / COMP-01）
 *
 * 为什么要有它：一次发布有五个数字/三份声明要互相对得上，而它们以前全是**手抄**的：
 *
 *   - `package.json.version` ↔ `CHANGELOG` 最新一节 ↔ 双语 README 的「当前发布版本」；
 *   - `package.json.dsh.compatibility.dshReleases` ↔ 双语 README 兼容表；
 *   - `npm pack` 实际打出的文件 ↔ `files` 白名单 ↔ `lib/` 下真实存在的运行时文件。
 *
 * 2026-10-23 外部审查抓到的 DOC-01（README 停在 1.0.0、包已是 1.6.1）就是第一组漂移。
 * 本套件让这些漂移全部在 `npm test` 里变红，并且**不联网**（`npm pack --dry-run` 是本地操作）。
 *
 * 放在 `contract-binding-test` / `doc-consistency-test` 之前：前两组发现账要引用本套件的断言，
 * 而台账只能证明「在它之前跑过的套件」打出的 PASS。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const readRoot = (f) => readFileSync(join(ROOT, f), 'utf8')

function walkJs(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkJs(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

/** `npm pack --dry-run --json`：npm 自己的权威清单。 */
function dryRun() {
  const args = ['pack', '--dry-run', '--json']
  const npmExec = String(process.env.npm_execpath ?? '')
  /**
   * ⚠️ 不能只看 `npm_execpath` 非空就 `node <它>`：`pnpm test` 下它是 `pnpm.mjs`，
   * 而 pnpm 的 `pack --json` 输出是**对象** `{name, version, files}`、不是 npm 的数组。
   * 所以只在确认是 npm 的 CLI 时直接执行；否则回退到 `npm`（PATH 上一定有）。
   * 解析端也兼容对象形态，双保险。
   */
  const isNpmCli = /npm-cli\.js$/i.test(npmExec)
  const r = isNpmCli
    ? spawnSync(process.execPath, [npmExec, ...args], { cwd: ROOT, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
  const stdout = String(r.stdout ?? '')
  const objAt = stdout.indexOf('{')
  const arrAt = stdout.indexOf('[')
  const start = objAt >= 0 && (arrAt < 0 || objAt < arrAt) ? objAt : arrAt
  let parsed = null
  if (start >= 0) {
    try {
      const raw = JSON.parse(stdout.slice(start))
      parsed = Array.isArray(raw) ? raw[0] : raw
    } catch { parsed = null }
  }
  return { status: r.status, signal: r.signal, stderr: String(r.stderr ?? ''), parsed }
}

// ── 1. 打包白名单（REL-01） ─────────────────────────────────────
const ROOT_FILES = new Set([
  'package.json', 'README.md', 'README.zh.md', 'LICENSE', 'NOTICE', 'cordis.patch.yml',
  // 1.8.2：品牌图标（package.json 的 `icon` 与 files 白名单一起声明）
  'icon.png',
])
const allowedPath = (p) => p.startsWith('lib/') || ROOT_FILES.has(p)

group('0. npm pack --dry-run 跑得通')
{
  const { status, signal, stderr, parsed } = dryRun()
  ok(status === 0 && !!parsed,
    'npm pack --dry-run --json 退出 0 且能解析（npm 自身可用）',
    `status=${status} signal=${signal} ${stderr.split('\n').filter(Boolean).slice(0, 2).join(' / ')}`)
  if (!parsed) {
    console.log('')
    console.log(`结果：${pass} passed, ${fail} failed`)
    process.exit(1)
  }

  const entries = (parsed.files ?? []).map((f) => (typeof f === 'string' ? { path: f } : f))
  const paths = entries.map((f) => String(f.path).replace(/\\/g, '/'))
  const set = new Set(paths)

  group('1. 包的身份与内容')
  ok(parsed.name === pkg.name, `包名 = ${pkg.name}（实际 ${parsed.name}）`)
  ok(parsed.version === pkg.version,
    `包内版本 = 仓库版本（包「${parsed.version}」，package.json「${pkg.version}」）`)
  ok(set.size === paths.length, `文件清单无重复（${paths.length} 个条目）`)
  ok(paths.length >= 60, `文件数不少于 60（实际 ${paths.length}）`)

  group('2. 运行时必需文件一个不少')
  const required = [
    'package.json', 'README.md', 'README.zh.md', 'LICENSE', 'NOTICE', 'cordis.patch.yml',
    'icon.png',
    'lib/index.js', 'lib/client.js', 'lib/typert.host.js',
  ]
  const missingRoot = required.filter((p) => !set.has(p))
  ok(missingRoot.length === 0, '根文件与三个入口模块都在包里', missingRoot.join(', '))

  const libJs = walkJs(join(ROOT, 'lib'))
  const missingLib = libJs
    .map((p) => relative(ROOT, p).replace(/\\/g, '/'))
    .filter((p) => !set.has(p))
  ok(missingLib.length === 0,
    `lib/ 下每个 .js 都打进了包（${libJs.length} 个，漏 ${missingLib.length} 个）`,
    missingLib.slice(0, 5).join(', '))

  group('3. 白名单：不该进的什么都没进')
  const outside = paths.filter((p) => !allowedPath(p))
  ok(outside.length === 0, '包内路径全部在白名单内（lib/** 或根文件）', outside.slice(0, 5).join(', '))

  const forbidden = paths.filter((p) =>
    p.startsWith('test/') || p.startsWith('docs/') || p.startsWith('scripts/') ||
    p.startsWith('.github/') || p.endsWith('.tgz') ||
    ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.gitignore'].includes(p))
  ok(forbidden.length === 0, '测试 / 文档 / 脚本 / CI / 锁文件 / tgz 都不在包里', forbidden.slice(0, 5).join(', '))

  group('4. 反向对照：白名单不是恒真的')
  ok(allowedPath('lib/index.js') && allowedPath('package.json'), '白名单放行真正的包内文件')
  ok(!allowedPath('test/release-test.mjs') && !allowedPath('docs/1.0.0-contract.md'),
    '【反向对照】白名单确实会拒绝 test/ 与 docs/')
}

// ── 2. 版本一致性（DOC-01） ─────────────────────────────────────
group('5. 版本一致性：package.json ↔ CHANGELOG ↔ 双语 README')
{
  const versionOf = (md, re) => (md.match(re) || [])[1] ?? null
  const en = readRoot('README.md')
  const zh = readRoot('README.zh.md')
  const changelog = readRoot('CHANGELOG.md')
  const CUR_EN = /\*\*Current release: `([^`]+)`\*\*/
  const CUR_ZH = /\*\*当前发布版本：`([^`]+)`\*\*/
  const CHG = /^##\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m

  ok(versionOf(en, CUR_EN) === pkg.version,
    `README.md 的当前发布版本 = package.json.version（读「${versionOf(en, CUR_EN)}」，包「${pkg.version}」）`)
  ok(versionOf(zh, CUR_ZH) === pkg.version,
    `README.zh.md 的当前发布版本 = package.json.version（读「${versionOf(zh, CUR_ZH)}」，包「${pkg.version}」）`)
  ok(versionOf(changelog, CHG) === pkg.version,
    `CHANGELOG 最新一节的版本 = package.json.version（读「${versionOf(changelog, CHG)}」，包「${pkg.version}」）`)

  // 1.0.0 是**冻结契约**的版本线，不是当前发布版本；两者必须同时在场、语义分开。
  ok(/\*\*Contract baseline: `1\.0\.0`\*\*/.test(en), 'README.md 明确区分「当前发布版本」与「契约基线 1.0.0」')
  ok(/\*\*契约基线：`1\.0\.0`\*\*/.test(zh), 'README.zh.md 明确区分「当前发布版本」与「契约基线 1.0.0」')
  ok(!/Current version 1\.0\.0/.test(en) && !/当前版本 1\.0\.0/.test(zh),
    '两份 README 不再把 1.0.0 标成「当前版本」（DOC-01 的形态不许回来）')

  // 【反向对照】改掉那个数字，比较判据必须报出来 —— 否则上面三条可能只是恒真。
  const mutated = versionOf(en.replace(pkg.version, '9.9.9'), CUR_EN)
  ok(mutated === '9.9.9' && mutated !== pkg.version,
    '【反向对照】改掉当前版本，比较判据确实会报不一致')
}

// ── 3. 兼容表对拍（COMP-01） ────────────────────────────────────
group('6. 兼容表：双语 README ↔ package.json.dshReleases')
{
  // 同一份声明被手抄了三遍（package.json + 中英 README）。1.6.1 之前它已经漂移过一次：
  // 本机实跑用的 DSH 0.2.1-rc.1 根本不在表里。这里让三份互相对拍。
  const readmeRows = (md) => {
    const out = new Map()
    for (const m of md.matchAll(/^\|\s*([0-9][0-9A-Za-z.\-]*)\s*\|\s*(compatible)\s*\|\s*$/gm)) out.set(m[1], m[2])
    return out
  }
  const want = new Map(Object.entries(pkg.dsh?.compatibility?.dshReleases ?? {}))
  const en = readmeRows(readRoot('README.md'))
  const zh = readmeRows(readRoot('README.zh.md'))
  const diff = (a, b) => [...new Set([...a.keys(), ...b.keys()])]
    .filter((k) => a.get(k) !== b.get(k))
    .map((k) => `${k}: ${a.get(k) ?? '—'} / ${b.get(k) ?? '—'}`)

  ok(want.size >= 5, `package.json.dshReleases 有足够多的行（实际 ${want.size}）`)
  ok(en.size >= 5 && diff(en, want).length === 0,
    `README.md 兼容表 = package.json.dsh.compatibility.dshReleases（差 ${diff(en, want).length} 行）`,
    diff(en, want).slice(0, 4).join('；'))
  ok(zh.size >= 5 && diff(zh, want).length === 0,
    `README.zh.md 兼容表 = 同一份声明（差 ${diff(zh, want).length} 行）`,
    diff(zh, want).slice(0, 4).join('；'))
  ok(diff(en, zh).length === 0, '双语兼容表逐行相同', diff(en, zh).slice(0, 4).join('；'))
}

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
