/**
 * tools-probe.mjs — 真实宿主里验「工具注册」这条路（不是 mock）。
 *
 * ⚠️ **这不是一条 `node scripts/tools-probe.mjs` 能跑的脚本** —— 它导出的是 DSH 插件。
 * 裸 node 里没有 `ctx`，只会报错；那种「跑不通的说明」比不写更糟。
 *
 * ── 怎么在真实宿主里跑（本机 headless profile，实测步骤）──
 *
 *   $repo  = '<本仓库目录>'
 *   $yml   = Join-Path $env:TEMP 'sage-mem-tools-probe.yml'
 *   "- insert:`n    - id: sage-mem-tools-probe`n      name: '$($repo.Replace('\','/'))/scripts/tools-probe.mjs'" |
 *     Set-Content -Encoding ascii $yml
 *   dsh --profile headless --patch $yml "只回复 ok，不要调用任何工具"
 *
 * 产物：`%TEMP%\sage-mem-tools-probe.json`（外加 stdout 一行 `[sage-mem-tools-probe] {...}`）。
 *
 * ── 这个探针要回答的三个问题（mock 回答不了）──
 *   1. 宿主**接受**我们的 ToolDefinition 形状吗？（名字注册得进去吗）
 *   2. 注册完，`ctx.tools.schemas()` 里**真的看得到**这两个工具吗？
 *   3. 走一次宿主自己的 `execute` dispatch，参数校验与返回值通得过吗？
 * 第 3 条最要紧：schema 对不代表 dispatch 对 —— 参数 schema 与 execute 的期望不一致时，
 * 只有真的调一次才会露出来。
 *
 * 为什么声明 `inject: ['tools']`：实测（见 host-facts-probe）不声明时 `ctx.tools` 直接抛
 * `cannot get property "tools" without inject`，`ctx.get('tools')` 只给 undefined。
 * 所以探针必须声明 —— 这正是 sage-mem 主插件**不能**用的接法（它用了 `ctx.inject` 挂
 * 子 fiber，见 docs/decisions.md D5），探针用硬 inject 只是为了「确保能拿到服务」。
 */

import { createMemoryTools } from '../lib/tools/memory-tools.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const name = 'sage-mem-tools-probe'

/** 探针用硬依赖：确保 `apply` 里一定拿得到 tools 服务。 */
export const inject = ['tools']

const REPORT = join(tmpdir(), 'sage-mem-tools-probe.json')

function write(report) {
  try { writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8') } catch {}
  console.log('[sage-mem-tools-probe]', JSON.stringify(report))
}

export function apply(ctx) {
  const report = {
    stage: 'applied',
    at: new Date().toISOString(),
    inject: inject,
    registerOk: false,
    registered: [],
    visibleInSchemas: [],
    schemaKeys: [],
    execute: null,
    errors: [],
  }

  try {
    const { searchMemory, readMemory } = createMemoryTools(ctx)

    // ① 注册：宿主接不接受我们的形状
    const disposers = []
    disposers.push(ctx.tools.register(searchMemory))
    disposers.push(ctx.tools.register(readMemory))
    report.registerOk = true
    report.registered = [searchMemory.name, readMemory.name]
    report.registerReturnsDisposer = disposers.every((d) => typeof d === 'function')

    // ② 宿主眼里有没有这两个工具
    const schemas = ctx.tools.schemas() || []
    report.schemaTotal = schemas.length
    report.visibleInSchemas = schemas.map((s) => s.name).filter((n) => report.registered.includes(n))
    const one = schemas.find((s) => s.name === 'search_memory')
    report.schemaKeys = one ? Object.keys(one).sort() : []
    report.searchSchemaHasParameters = !!(one && one.parameters && one.parameters.properties)

    // ③ 真调一次宿主的 dispatch —— schema 对不代表 dispatch 对
    const ac = new AbortController()
    Promise.resolve()
      .then(() => ctx.tools.execute({
        callId: 'sage-mem-tools-probe-call-1',
        name: 'search_memory',
        arguments: { query: '探针用的合成检索词', limit: 3 },
        signal: ac.signal,
      }))
      .then((result) => {
        report.execute = {
          isError: result?.isError === true,
          hasValue: result?.value != null,
          valueKeys: result?.value && typeof result.value === 'object' ? Object.keys(result.value).slice(0, 12) : [],
          contentBlocks: Array.isArray(result?.content) ? result.content.length : null,
          errorMessage: result?.error?.message ?? null,
        }
        report.stage = 'executed'
        write(report)
      })
      .catch((err) => {
        report.execute = { threw: String(err?.message ?? err) }
        report.stage = 'execute-threw'
        write(report)
      })
  } catch (err) {
    report.errors.push(String(err?.message ?? err))
    report.stage = 'failed'
    write(report)
  }

  // 同步部分先落一次盘：异步那步万一没跑完，至少有注册与 schema 的证据
  write(report)
}
