#!/usr/bin/env node
/**
 * sage-mem 测试总入口（仓库内，随 npm test 一起跑）。
 *
 * 逐个跑本目录下的断言脚本，汇总每个脚本自报的断言数；任一脚本非零退出、
 * 有失败断言、或压根没打出汇总行（多半是 import 就炸了），整体即 exit 1。
 *
 * 为什么用子进程而不是 import 进同一个进程：inject-test 会在**模块顶层**读环境变量
 * （SAGE_MEM_DIR / SAGE_MEM_MAX_SESSION_BYTES …），而且它自己还要另起子进程验默认值；
 * 同进程复用会让这些顶层状态互相污染。一脚本一进程最省心，也最接近各自单跑的结果。
 *
 * 只依赖 node: 内置模块 —— 不引入任何测试框架，与各脚本手写 ok() 的风格保持一致。
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 固定顺序：先纯函数与引擎层，再产物对表，最后客户端真执行。 */
const SUITES = [
  'ad-smoke.mjs',
  'ad-fixes.mjs',
  'ad-matrix.mjs',
  // 1.0.1：报告撞上单次输出上限时的「接着写」与残篇标注（真实事故：10-17 凌晨那份报告断在半句）。
  'autodream-continuation-test.mjs',
  'rollback-guard-test.mjs',
  'race-guards-test.mjs',
  'q-fixes-093.mjs',
  'q-fixes-094.mjs',
  'q-fixes-095.mjs',
  'q-fixes-098.mjs',
  'archive-index-test.mjs',
  'autodream-config-test.mjs',
  'open-folder-test.mjs',
  'update-test.mjs',
  'retrieval-test.mjs',
  // 1.2.0：注入链拆成纯函数后的直接单测（不需要 new MemoryGateway）。
  'recall-unit-test.mjs',
  'chunks-test.mjs',
  'bm25-test.mjs',
  'search-test.mjs',
  'intent-test.mjs',
  'reader-test.mjs',
  'memory-tools-test.mjs',
  'observe-test.mjs',
  'write-gate-test.mjs',
  'write-gate-wiring-test.mjs',
  'deliver-test.mjs',
  'status-card-test.mjs',
  'conflicts-test.mjs',
  'stale-conflict-test.mjs',
  'watch-test.mjs',
  // 守卫放最后：它检查的是「上面这份名单完不完整」。
  'suite-registry-test.mjs',
  'checkpoint-test.mjs',
  'typert-test.mjs',
  'inject-test.mjs',
  // 1.2.0：注入链从组合根搬出前先建的 golden —— 11 个场景逐字节比对，
  // 证明「纯搬移」不是一句自述（fixtures 由 scripts/gen-recall-golden.mjs 生成）。
  'recall-golden-test.mjs',
  'host-facts-test.mjs',
  'archive-test.mjs',
  'access-test.mjs',
  'access-v2-test.mjs',
  'panel-api-test.mjs',
  // 1.3.0：单一事实来源的对拍与「只许一处」守卫（放 build-fresh 之前：都是静态/纯函数）。
  'shared-parity-test.mjs',
  'duplication-test.mjs',
  'build-fresh.mjs',
  'client-exec-test.mjs',
  // 1.4.0：客户端共享基元的「只许一处」与拼接顺序守卫。
  'client-scope-test.mjs',
  'client-render-test.mjs',
  // 契约 §5（环境变量）的默认值 / 越界夹取 —— 以前这半边一条断言都没有。
  'env-contract-test.mjs',
  // 1.2.0：结构守卫 —— 组合根体积 / 依赖方向 / typert 契约位置。
  'structure-test.mjs',
  // ⚠️ 下面两个必须排在最后：它们读的是**前面套件跑完落的断言台账**（见 `_passlog.mjs`），
  // 排在前面就会读到残缺的账。它们盯的是「契约里说了不验的承诺」与「两份文档说法不一致」。
  'contract-binding-test.mjs',
  'doc-consistency-test.mjs',
]

/** 各脚本收尾那行：`结果：53 passed, 0 failed`。 */
const SUMMARY = /结果：(\d+)\s*passed,\s*(\d+)\s*failed/

const HERE = fileURLToPath(new URL('.', import.meta.url))
const rows = []
let passed = 0
let failed = 0
const broken = []

/**
 * **沙箱环境**：给每个子套件一套临时目录，任何套件都不许碰真实记忆目录与真实状态根。
 *
 * 为什么需要它（2026-10-15 实测的事故）：DSH 进程本身带着 `SAGE_MEM_DIR`，于是
 * **静态 `import` 的套件会在它覆盖环境变量之前就把 `lib/memory/config.js` 加载完** ——
 * 模块常量指向真实目录。其中 `ad-smoke.mjs` 会跑 autodream，而 autodream 跑前强制 flush
 * 访问台账，于是把用户**真实**的 `.sage-mem/access.json` 冲成了它的夹具名。
 *
 * 子进程从父进程继承环境，所以在这里设一次就覆盖全部套件（含将来新加的）。
 * 各套件自己设的临时目录优先级更高，不受影响。
 */
const sandboxRoot = mkdtempSync(join(tmpdir(), 'sage-mem-suites-'))

/**
 * **断言台账**：本次运行里每个套件**实际打出过**的 PASS 断言名，一行一个套件。
 *
 * 为什么要有它：`1.0.0-contract.md` 里每条「保证」都必须指向一条**真的存在**的断言
 * （见 `contract-binding-test.mjs`）。守卫要核对这件事，最可靠的办法是看**本次运行的实况**，
 * 而不是去 grep 源码 —— 源码里的字符串可能落在注释里、或在一条永远不走的 `if` 分支里。
 * 让守卫自己再跑一遍那些套件，等于把 `npm test` 跑两遍；所以在运行器里顺手落账。
 *
 * 消费方：`SAGE_MEM_PASSLOG` 指向的那个文件。守卫单独跑（没这个变量）时自己起子进程补。
 * ⚠️ 契约绑定守卫必须排在 `SUITES` **最后** —— 它要读的账在它之前才写完。
 */
const PASSLOG = join(sandboxRoot, 'pass-log.jsonl')
const PASS_LINE = /^ {2}PASS (.*)$/gm

const SANDBOX_ENV = {
  SAGE_MEM_DIR: join(sandboxRoot, 'memory'),
  SAGE_MEM_STATE_DIR: join(sandboxRoot, '.sage-mem'),
  DSH_HOME: join(sandboxRoot, 'dsh-home'),
  SAGE_MEM_PASSLOG: PASSLOG,
}
mkdirSync(SANDBOX_ENV.SAGE_MEM_DIR, { recursive: true })
mkdirSync(SANDBOX_ENV.SAGE_MEM_STATE_DIR, { recursive: true })

for (const name of SUITES) {
  const r = spawnSync(process.execPath, [join(HERE, name)], {
    encoding: 'utf8',
    env: { ...process.env, ...SANDBOX_ENV },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = out.match(SUMMARY)
  const p = m ? Number(m[1]) : 0
  const f = m ? Number(m[2]) : 0
  const code = r.status === null ? 1 : r.status
  passed += p
  failed += f
  const bad = !m || f > 0 || code !== 0
  if (!m || f > 0 || code !== 0) broken.push(name)

  // 断言台账：供契约绑定守卫核对「这片保证指向的断言真的跑过」。
  appendFileSync(PASSLOG, `${JSON.stringify({
    name,
    bad,
    pass: [...out.matchAll(PASS_LINE)].map((x) => x[1]),
  })}\n`)

  console.log(`\n──── ${name} ────`)
  process.stdout.write(out.endsWith('\n') || !out ? out : `${out}\n`)
  if (!m) console.log('  （没有读到汇总行，按失败计）')

  rows.push({ name, p, f, code, bad })
}

// 沙箱用完就删。放在汇总之前也没关系 —— 断言早就跑完了。
rmSync(sandboxRoot, { recursive: true, force: true })

console.log('\n════ 汇总 ════')
for (const r of rows) {
  console.log(`  ${r.bad ? 'FAIL' : 'ok  '}  ${r.name.padEnd(20)} ${r.p} passed, ${r.f} failed  (exit ${r.code})`)
}
console.log(`  合计：${passed} passed, ${failed} failed`)
if (broken.length) console.log(`  未通过：${broken.join(', ')}`)

process.exit(failed > 0 || broken.length ? 1 : 0)
