#!/usr/bin/env node
/**
 * _passlog.mjs — 断言台账读取器（**共享辅助**，`_` 开头，按 `run.mjs` 的约定不登记为套件）
 *
 * 为什么需要它：`docs/1.0.0-contract.md` 里每条「保证」都必须指向一条**真的存在**的断言
 * （守卫见 `contract-binding-test.mjs` / `doc-consistency-test.mjs`）。要证明「真的存在」，
 * 唯一可信的证据是**本次运行里它真的打出了 PASS** —— 而不是去源码里 grep 一个字符串：
 * 那个字符串可能落在注释里、或在一条永远不走的 `if` 分支里。
 *
 * 两种取法，优先第一种：
 *
 * 1. **读台账**（`SAGE_MEM_PASSLOG`）—— `run.mjs` 每跑完一个套件就把「它实际打过的 PASS 名」
 *    追加一行 JSON。在 `npm test` 里守卫因此是**零成本**的。
 * 2. **自己补跑**—— 守卫被单独执行时没有台账，这时按需起子进程补那几条。
 *    代价是慢，但结果同样来自真实运行。**子进程一样走沙箱环境**，绝不碰真实记忆目录。
 *
 * ⚠️ 依赖顺序：在 `npm test` 里，消费台账的守卫必须排在 `SUITES` **最后**，
 * 否则它读到的账是残缺的 —— 那时会退化成第 2 种取法（能出结果，但白跑一遍）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 各套件收尾那行统一是 `  PASS <断言名>`（39 个套件里有 39 个这么打）。 */
const PASS_LINE = /^ {2}PASS (.*)$/gm

/**
 * 取本套件需要的断言台账。
 *
 * @param {string[]} neededSuites 需要其台账的套件文件名（如 `inject-test.mjs`）
 * @returns {{ source: 'run'|'self', log: Map<string, string[]> }}
 *   `source` 说明台账从哪来：`run` = 本次 `npm test` 的实况（零成本），
 *   `self` = 本守卫自己补跑的。**报告里必须说清是哪个** —— 两者的可信度范围不同
 *   （`self` 只覆盖被点名的套件）。
 */
export function loadPassLog(neededSuites) {
  const unique = [...new Set(neededSuites)]

  const fromRun = readRunLog(unique)
  if (fromRun) return { source: 'run', log: fromRun }

  return { source: 'self', log: spawnPassLog(unique) }
}

/** 读 `run.mjs` 落的账；只要有一条套件不在账里就返回 null（交给补跑分支）。 */
function readRunLog(needed) {
  const path = process.env.SAGE_MEM_PASSLOG
  if (!path) return null
  let rows
  try {
    rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return null
  }
  if (!needed.every((n) => rows.some((r) => r.name === n))) return null
  return new Map(rows.map((r) => [r.name, r.pass]))
}

/** 补跑：只为被点名的套件起子进程。沙箱环境与 `run.mjs` 同口径。 */
function spawnPassLog(needed) {
  const root = mkdtempSync(join(tmpdir(), 'sage-mem-passlog-'))
  const env = {
    ...process.env,
    SAGE_MEM_DIR: join(root, 'memory'),
    SAGE_MEM_STATE_DIR: join(root, '.sage-mem'),
    DSH_HOME: join(root, 'dsh-home'),
    SAGE_MEM_PASSLOG: '', // 防递归：子套件不该再去找台账
  }
  mkdirSync(env.SAGE_MEM_DIR, { recursive: true })
  mkdirSync(env.SAGE_MEM_STATE_DIR, { recursive: true })

  const log = new Map()
  try {
    for (const name of needed) {
      const r = spawnSync(process.execPath, [join(HERE, name)], { encoding: 'utf8', env })
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
      log.set(name, [...out.matchAll(PASS_LINE)].map((m) => m[1]))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return log
}

/**
 * 从 `run.mjs` 里读出 `SUITES` 名单（读源码而不是 import：import 会真的跑一遍测试）。
 * 与 `suite-registry-test.mjs` 用同一手法 —— 那边盯「该登记的有没有登记」，
 * 这边盯「绑定指向的套件在不在登记名单里」。
 */
export function registeredSuites() {
  const src = readFileSync(join(HERE, 'run.mjs'), 'utf8')
  const start = src.indexOf('const SUITES')
  const end = start >= 0 ? src.indexOf(']', start) : -1
  const text = start >= 0 && end > start ? src.slice(start, end) : ''
  return [...text.matchAll(/'([^']+\.mjs)'/g)].map((m) => m[1])
}

/** `套件::断言名子串` → `{ suite, needle }`；不合格式返回 null。 */
export function parseBinding(text) {
  const i = text.indexOf('::')
  if (i <= 0) return null
  const suite = text.slice(0, i).trim()
  const needle = text.slice(i + 2).trim()
  if (!suite.endsWith('.mjs') || needle.length === 0) return null
  return { suite, needle }
}
