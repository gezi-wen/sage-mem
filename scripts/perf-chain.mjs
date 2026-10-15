#!/usr/bin/env node
/**
 * perf-chain.mjs — **全链**耗时：`scan → rank → render → append`（2026-10-15 建）
 *
 * 为什么要有它：外部复审报告指出，原有性能数字只覆盖「分段 + 词元化 + 内存检索」，
 * **不含真实磁盘扫描的完整代价**，因此不能与「30 份语料的端到端结果」拼成
 * 「1000 份端到端已验证」。复审者还测到 1000 文件时 p95 越过 50 ms，要求「先测热点再选索引方案」。
 *
 * 本脚本把那四段**分开计时**，30 / 300 / 1000 三档规模，冷热路径分开。
 *
 * ⚠️ **每一档必须跑在独立子进程里。** `config.js` 的 `MEMORY_DIR` 是**模块顶层**读环境变量的 ——
 * 同一进程里换目录再 `import` 是没用的：传递依赖（`scan.js` / `search.js` / `config.js`）不会因为
 * `?v=N` 重新求值。初版就栽在这上面：第二档起实际扫的还是第一档那个**已被删掉**的目录，
 * 于是 `scan` 只花 0.3 ms、注入 0 条 —— **看着像「规模大了反而更快」的漂亮结果，实际什么都没测**。
 *
 * 用法：
 *   node scripts/perf-chain.mjs            # 30 / 300 / 1000
 *   node scripts/perf-chain.mjs 100 500    # 自定规模
 *
 * 合成语料，不联网、不调模型、不碰真实记忆目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const HERE = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 造一份合成记忆：摘要 + 若干段落，段落里埋一个只属于它的词。 */
function makeFile(i) {
  const topic = `topic${i}`
  const paras = Array.from({ length: 8 }, (_, p) => `第 ${p} 段讲 ${topic} 的第 ${p} 个细节，用于让正文足够长。`)
  return ['---', `name: mem${i}`, `description: ${topic} 的说明与约定`, `aliases: [${topic}, 别名${i}]`, 'type: reference', '---', '', `# 记忆 ${i}`, '', ...paras, ''].join('\n')
}

const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]
const ms = (n) => `${n.toFixed(2)} ms`
const root = process.cwd().replace(/\\/g, '/')

/** 跑**一档**。只在子进程里调用（环境变量必须在本进程 import 之前设好）。 */
async function lane(n) {
  const sandbox = mkdtempSync(join(tmpdir(), `sage-perf-${n}-`))
  const memDir = join(sandbox, 'memory')
  mkdirSync(memDir, { recursive: true })
  let bytes = 0
  for (let i = 0; i < n; i++) {
    const text = makeFile(i)
    bytes += Buffer.byteLength(text, 'utf8')
    writeFileSync(join(memDir, `mem${i}.md`), text, 'utf8')
  }
  process.env.SAGE_MEM_DIR = memDir
  process.env.SAGE_MEM_STATE_DIR = join(sandbox, '.sage-mem')
  process.env.DSH_HOME = join(sandbox, 'dsh-home')

  const { default: MemoryGateway } = await import(`file://${root}/lib/index.js`)
  const { scanMemoryFiles } = await import(`file://${root}/lib/memory/scan.js`)
  const { rankChunks } = await import(`file://${root}/lib/memory/search.js`)

  const handlers = new Map()
  const base = { on: (e, h) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(h) }, logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }, effect: () => {}, get: () => undefined }
  let stub
  stub = new Proxy(function () {}, { get: (t, p) => (p === 'then' ? undefined : stub), apply: () => undefined })
  const ctx = new Proxy(base, { get: (t, p) => (p in t ? t[p] : stub) })
  new MemoryGateway(ctx)
  const assemble = handlers.get('system-prompt/assemble').at(-1)

  let t = performance.now()
  const files = await scanMemoryFiles(ctx, '')
  const scanCold = performance.now() - t
  t = performance.now()
  await scanMemoryFiles(ctx, '')
  const scanHot = performance.now() - t
  // 自检：这一档真的扫到了东西吗？扫不到就不许打印一行好看的数字。
  if (files.length !== n) {
    console.error(`PERF-BROKEN 期望 ${n} 份、实际扫到 ${files.length} 份 —— 这一档的结果不可采信`)
    process.exit(2)
  }

  const queries = Array.from({ length: 20 }, (_, i) => `topic${(i * Math.max(1, Math.floor(n / 20))) % n} 的说明`)
  const rankTimes = []
  for (const q of queries) {
    t = performance.now()
    rankChunks(q, files, { limit: 10, perFile: 1 })
    rankTimes.push(performance.now() - t)
  }

  const fullTimes = []
  let entries = 0
  for (const [i, q] of queries.entries()) {
    // 每问换一个会话 id：否则去重会把后续几次变成空操作，测不到真实全链
    const msgs = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: q }] }]
    t = performance.now()
    const out = await assemble({}, { agent: { session: { id: `perf-${n}-${i}`, deriveMessages: () => msgs } } }, async () => ({}))
    fullTimes.push(performance.now() - t)
    const text = out?.contexts?.find((c) => c?.name === 'sage-mem:recall')?.text ?? ''
    entries += (text.match(/^### /gm) || []).length
  }

  rmSync(sandbox, { recursive: true, force: true })
  return { n, bytes, entries: entries / queries.length, scanCold, scanHot, rank50: pct(rankTimes, 0.5), rank95: pct(rankTimes, 0.95), full50: pct(fullTimes, 0.5), full95: pct(fullTimes, 0.95) }
}

const argvSizes = process.argv.slice(2).map(Number).filter((x) => Number.isFinite(x) && x > 0)

if (process.env.SAGE_PERF_CHILD) {
  // 子进程：只跑一档，把结果打成一行 JSON 交给父进程
  const r = await lane(argvSizes[0])
  console.log('PERF_ROW ' + JSON.stringify(r))
} else {
  const sizes = argvSizes.length ? argvSizes : [30, 300, 1000]
  console.log('sage-mem 全链耗时（合成语料；冷 = 首次，热 = 同内容再来一次）')
  console.log('')
  console.log('| 规模 | 总字节 | 注入条目/问 | scan 冷 | scan 热 | rank p50 / p95 | 全链 p50 / p95 |')
  console.log('|---|---|---|---|---|---|---|')
  let broken = 0
  for (const n of sizes) {
    const r = spawnSync(process.execPath, [HERE, String(n)], { encoding: 'utf8', env: { ...process.env, SAGE_PERF_CHILD: '1' } })
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('PERF_ROW '))
    if (!line) {
      // 子进程失败就如实报错，**不许**打印一行看似正常的数字
      broken++
      console.log(`| ${n} | — | — | — | — | — | 子进程失败：${(r.stderr ?? '').trim().split('\n').pop() ?? ''} |`)
      continue
    }
    const d = JSON.parse(line.slice('PERF_ROW '.length))
    console.log(`| ${d.n} | ${(d.bytes / 1024).toFixed(0)} KB | ${d.entries.toFixed(1)} | ${ms(d.scanCold)} | ${ms(d.scanHot)} | ${ms(d.rank50)} / ${ms(d.rank95)} | ${ms(d.full50)} / ${ms(d.full95)} |`)
  }
  console.log('')
  console.log('口径说明：')
  console.log('- **scan** = `scanMemoryFiles` 真的走磁盘列目录 + 读 frontmatter；冷 = 进程内第一次。')
  console.log('- **rank** = `rankChunks`（分段 + 词元化 + 打分）；段落缓存按内容 hash，热路径会命中。')
  console.log('- **全链** = 真的调用注册的 `system-prompt/assemble` 回调（与本机注入链同一份代码），')
  console.log('  但它走的是**手动调用 + 模拟 ctx**，不含真实宿主注册、会话持久化与模型调用。')
  console.log('- 每档 20 个问题、每问一个新会话 id（否则同题去重会把后续变成空操作）。')
  console.log('- 每档跑在**独立子进程**里（模块顶层读环境变量，同进程换目录无效）。')
  console.log('- 自检：扫到的文件数不等于预期就整档报错，绝不打印可疑数字。')
  if (broken) process.exit(1)
}
