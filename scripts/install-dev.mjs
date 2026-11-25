#!/usr/bin/env node
/**
 * install-dev.mjs — 本仓库**唯一**的开发安装入口（2.19.1）。
 *
 * 为什么要有它：安装这件事以前有两套写法 —— README 让人 `npm install`，CI 却在
 * 装之前临时从 `package.json` 里删掉一个 peer、装上再还原，参数是
 * `--no-save --no-package-lock` 加五个手写版本号。两套都「能跑」，但谁也复现不了谁。
 * 真因不在 CI 那几行参数，而在**声明**：`devDependencies` 里只镜像了 `react`，
 * 另外四个与宿主共享实例的 dsh 包只写了 `peerDependencies`（官方要求两侧都写），
 * 于是 npm 只能自己去猜版本，猜出来的是 `latest` 标签停在的旧代，与仓库自己要的
 * 那一代撞在同一个槽位上 → ERESOLVE。声明补对之后，安装就是一个命令的事。
 *
 * 三条纪律（改这个文件之前先读）：
 *   1. **绝不改 lock**：正常路径只跑 `npm ci`。`npm ci` 按 `package-lock.json` 装，
 *      发现 lock 与 `package.json` 不一致会直接失败 —— 那是想要的，别绕过它。
 *   2. **只在这里更新 lock**：`--refresh-lock` 才跑 `npm install --package-lock-only`，
 *      而且是**在一个只放着 `package.json` 的空临时目录里**解析（本机 `node_modules`
 *      会让 npm 直接复用现状，那样生成的不是「按声明能装到什么」）。它不碰
 *      `node_modules`，也不改 `package.json` 的任何依赖声明；结果校验通过才写回根目录。
 *      有意改依赖之后必须显式刷新，并在评审里看 lock 的 diff。
 *   3. **失败要透传**：npm 非零退出，本进程就以同一个码退出。安装失败却回 0
 *      会让 CI 在下一步用一棵半死的树跑测试，那种红最难查。
 *
 * 只用 `node:` 内置模块，Node >= 18（与 `engines.node` 一致），Windows 与 Linux 同一份。
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 与宿主共享实例的 dsh 包（`devDependencies` 里精确钉版的那四个）。 */
const DSH_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-skill-filesystem',
]

/** 运行期依赖里也要看一眼的那两个（不是 dsh 包，装错了同样会莫名其妙地红）。 */
const RUNTIME_PACKAGES = ['zod', 'react']

const USAGE = `用法：node scripts/install-dev.mjs [--refresh-lock]

  默认            按 package-lock.json 安装（npm ci）。会**重建 node_modules**。
  --refresh-lock  只重写 package-lock.json（npm install --package-lock-only），
                  不动 node_modules、不改 package.json —— 有意改依赖时才用。

  package-lock.json 是依赖树的权威：CI 与本地都用它，别再手写版本号。`

function die(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { refreshLock: false }
  for (const raw of argv) {
    if (raw === '--refresh-lock') { out.refreshLock = true; continue }
    if (raw === '-h' || raw === '--help') {
      console.log(USAGE)
      process.exit(0)
    }
    die(`不认识的参数：${raw}\n\n${USAGE}`)
  }
  return out
}

/**
 * 跑 npm，**返回退出码**（不在里面 `process.exit`：刷新锁那条路要先清理临时目录再报错）。
 *
 * `stdio: 'inherit'` 是刻意的：安装进度要给人看；而 DSH 的 file sandbox 下
 * 子进程拿不到管道（`stdio: 'pipe'` 会 EPERM），inherit 不受影响。
 * Windows 上 `npm` 是 `npm.cmd`，必须经 shell 才找得到 —— 直接 spawn 会 ENOENT。
 */
function runNpm(args, label, cwd = ROOT) {
  const onWindows = process.platform === 'win32'
  console.log(`\n▶ ${label}\n  npm ${args.join(' ')}${cwd === ROOT ? '' : `\n  （在临时目录 ${cwd} 里跑）`}\n`)
  const base = {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, npm_config_update_notifier: 'false' },
  }
  /**
   * Windows 上 `npm` 是 `npm.cmd`：不经 shell 直接 spawn 会 ENOENT。走 shell 时把命令拼成
   * 一个字符串 —— 给 `spawn` 传「shell + 参数数组」在 Node 22 起会打 DEP0190
   * （参数不转义、只拼接）。这里的参数全是本文件里的常量，没有外部输入。
   */
  const r = onWindows
    ? spawnSync(['npm', ...args].join(' '), { ...base, shell: true })
    : spawnSync('npm', args, base)
  if (r.error) return { status: 1, why: `${label} 启动失败：${r.error.message}` }
  if (r.status === null) return { status: 1, why: `${label} 被信号中断（${r.signal ?? 'unknown'}）` }
  return { status: r.status, why: `${label} 失败：npm 退出 ${r.status}` }
}

/** 装/刷新这两条路都不许「失败但回 0」。 */
function runNpmOrDie(args, label, cwd = ROOT) {
  const { status, why } = runNpm(args, label, cwd)
  if (status !== 0) die(why)
}

/** 读一个已安装包的版本；读不到就 `null`（调用方决定这算不算失败）。 */
function versionOf(name) {
  const p = join(ROOT, 'node_modules', ...name.split('/'), 'package.json')
  try {
    return JSON.parse(readFileSync(p, 'utf8')).version
  } catch {
    return null
  }
}

/** 从 lock 里读顶层条目（lock 模式下 `node_modules` 可能还不存在）。 */
function versionsFromLock() {
  const p = join(ROOT, 'package-lock.json')
  if (!existsSync(p)) die('找不到 package-lock.json —— 先跑 `node scripts/install-dev.mjs --refresh-lock`')
  let lock
  try {
    lock = JSON.parse(readFileSync(p, 'utf8'))
  } catch (err) {
    die(`package-lock.json 不是合法 JSON：${err.message}`)
  }
  const out = {}
  for (const name of [...DSH_PACKAGES, ...RUNTIME_PACKAGES]) {
    const entry = lock.packages?.[`node_modules/${name}`]
    out[name] = entry?.version ?? null
  }
  return { versions: out, lockfileVersion: lock.lockfileVersion ?? null }
}

/** 装完自检：要打印的每个包都必须真的在树里，缺一个就失败（不许假报）。 */
function reportInstalled(mode) {
  if (mode === 'lock') {
    const { versions, lockfileVersion } = versionsFromLock()
    const missing = Object.entries(versions).filter(([, v]) => !v).map(([n]) => n)
    if (missing.length) die(`package-lock.json 里缺这些包的条目：${missing.join('、')}`)
    console.log(`\n✓ package-lock.json（lockfileVersion ${lockfileVersion}）解析出的顶层版本：`)
    for (const [name, v] of Object.entries(versions)) console.log(`  ${name.padEnd(38)} ${v}`)
    console.log('  （只是写 lock，本次没有动 node_modules）')
    return
  }

  const versions = {}
  for (const name of [...DSH_PACKAGES, ...RUNTIME_PACKAGES]) versions[name] = versionOf(name)
  const missing = Object.entries(versions).filter(([, v]) => !v).map(([n]) => n)
  if (missing.length) {
    die(`安装后这些包在 node_modules 里找不到：${missing.join('、')}\n` +
      '  ——如果刚改过依赖，先跑 `node scripts/install-dev.mjs --refresh-lock`；否则说明 lock 与 package.json 不同步。')
  }
  console.log('\n✓ node_modules 里实际装上的版本：')
  for (const [name, v] of Object.entries(versions)) console.log(`  ${name.padEnd(38)} ${v}`)
}

/** 键序无关的比较：npm 会把锁里的 peer 按字母序重排，逐字比会假报不一致。 */
function canonical(o) {
  return Object.keys(o ?? {}).sort().map((k) => [k, o[k]])
}

function sameJSON(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

/** 只取「依赖声明」三块，用来核对锁的根条目与 `package.json` 是同一份东西。 */
function rootManifestOf(o) {
  return {
    dependencies: o.dependencies ?? {},
    devDependencies: o.devDependencies ?? {},
    peerDependencies: o.peerDependencies ?? {},
  }
}

/**
 * 重写 lock —— **必须在空目录里解析**。
 *
 * 为什么不能就在仓库根跑：`npm install --package-lock-only` 会**优先复用已有的
 * `node_modules`**（输出一句 "up to date" 就结束）。本机装着旧版本时，那样生成出来的锁
 * 只是把本机现状抄了一遍，而不是「按声明能解析到什么」。实测过：同一份 `package.json`，
 * 仓库根得到 `zod@4.4.3`（而那条有公告），空目录得到 `zod@4.6.7`。
 * 所以这里：复制一份 `package.json` 到 OS 临时目录 → 在那里解析 → 校验 → 写回根 →
 * 无论成败都删掉临时目录。
 */
function refreshLock() {
  const pkgPath = join(ROOT, 'package.json')
  const lockPath = join(ROOT, 'package-lock.json')
  const tmp = mkdtempSync(join(tmpdir(), 'sage-mem-lock-'))
  let failure = null
  try {
    copyFileSync(pkgPath, join(tmp, 'package.json'))
    const { status, why } = runNpm(
      ['install', '--package-lock-only', '--ignore-scripts'],
      '在空目录里按 package.json 解析依赖',
      tmp,
    )
    if (status !== 0) {
      failure = why
    } else {
      const generated = join(tmp, 'package-lock.json')
      if (!existsSync(generated)) {
        failure = '空目录里没有生成 package-lock.json'
      } else {
        let lock = null
        try {
          lock = JSON.parse(readFileSync(generated, 'utf8'))
        } catch (err) {
          failure = `生成的锁不是合法 JSON：${err.message}`
        }
        if (!failure) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
          const mine = rootManifestOf(pkg)
          const theirs = rootManifestOf(lock.packages?.[''] ?? {})
          const differing = Object.keys(mine).filter((k) => !sameJSON(mine[k], theirs[k]))
          if (differing.length) {
            failure = `生成的锁与 package.json 的依赖声明不一致（${differing.join(' / ')}）—— 两者不是同一份声明，拒绝写回`
          } else {
            const missing = [...DSH_PACKAGES, ...RUNTIME_PACKAGES]
              .filter((n) => !lock.packages?.[`node_modules/${n}`]?.version)
            if (missing.length) failure = `生成的锁里缺这些包的条目：${missing.join('、')}`
            else copyFileSync(generated, lockPath)
          }
        }
      }
    }
  } finally {
    // 成功失败都要清：`die()` 在 try/finally 之外，所以这里一定会跑到。
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不该掩盖前面的结果 */ }
  }
  if (failure) die(failure)
  reportInstalled('lock')
  console.log('\n下一步：`node scripts/install-dev.mjs` 按新锁安装，再 `npm test`。')
}

function main() {
  const { refreshLock: doRefresh } = parseArgs(process.argv.slice(2))

  const pkgPath = join(ROOT, 'package.json')
  if (!existsSync(pkgPath)) die(`不在仓库根？找不到 ${pkgPath}`)

  if (doRefresh) {
    console.log('▶ 只刷新 lock：在空目录里解析，不装 node_modules、不改 package.json')
    refreshLock()
    return
  }

  const lockPath = join(ROOT, 'package-lock.json')
  if (!existsSync(lockPath)) {
    die('没有 package-lock.json —— 它是依赖树的权威，不能跳过。\n' +
      '  先跑 `node scripts/install-dev.mjs --refresh-lock` 生成并提交它。')
  }

  // `npm ci` 会先删掉整个 node_modules 再按锁装：这是它「可复现」的来源，
  // 也是它比 `npm install` 值得当唯一入口的原因。别改成 npm install ——
  // 那会按 package.json 的浮动范围重新解析，锁就形同虚设。
  runNpmOrDie(['ci', '--ignore-scripts'], '按 package-lock.json 安装（npm ci）')
  reportInstalled('tree')
  console.log('\n下一步：`npm test`')
}

main()
