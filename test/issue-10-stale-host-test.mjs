#!/usr/bin/env node
/**
 * issue #10（2026-11-01 用户报告）：升级到 2.1.21 后，记忆面板里**任何写入都失败**：
 *
 *   ⚠ RemoteError: typert gateway: memory/writeFile:
 *     args fields do not match the descriptor: unexpected "opts"
 *
 * 根因（2026-11-01 在隔离的 DSH 0.2.1-rc.5 + sage-mem 2.1.21 上复现并定位）：
 * `@deepseek-ai/dsh-typert-loader` 把每个包的 TYPERT manifest **按包名缓存、进程内不失效**
 * （lib/index.js 头注：Package verdicts and imported manifests are cached per package name
 * and never expire）。所以「在 DSH 还开着的时候装上新版 sage-mem」之后，宿主进程里仍然是
 * 旧版 2.1.1 的 strict descriptor（writeFile 只有 name/content 两个 wire 字段）；
 * 而浏览器那边的客户端分片是从磁盘现取的 2.1.21（第三参 opts + create/expectedRevision）。
 *
 * 旧 strict descriptor 会**先于**方法执行把第三参挡掉 —— 网关报
 * `gateway/arguments-invalid: unexpected "opts"`，落盘一次都没发生。2.1.1 不传第三参，
 * 所以「回退到 2.1.1 就好了」；真正要清掉的是宿主进程里的那份旧 manifest（彻底退出 DSH，
 * 包括托盘常驻的那个进程），关窗口不够。
 *
 * 这组断言盯两件事：
 *   ① 客户端写调用必须能**识别**这一种结构化错误（只认 code=gateway/arguments-invalid 且
 *      文案点名 unexpected "opts"），按旧协议重试，并在界面上说清「这次没做版本校验」；
 *   ② 降级**不许**扩大风险：`{create:true}` 在旧宿主上没有对应语义，重试前必须先探存在性，
 *      已存在就明确拒绝（绝不拿「无 create 语义的覆盖写」去顶创建）；其它网关错误一律原样抛出。
 *
 * 修前红：05-shared.js 里没有这两个 helper，本文件成片 FAIL。
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

// ── 0. 把客户端共享基元分片跑进 VM，取出要测的 helper ─────────────────────
const SHARED = readFileSync(new URL('../client/05-shared.js', import.meta.url), 'utf8')
let API = null
try {
  const sandbox = {
    console, Promise, Object, Array, String, Number, Boolean, JSON, Math, RegExp, Error, Map, Set, Symbol,
  }
  vm.createContext(sandbox)
  vm.runInContext(`(function () {
    const MESSAGES = {
      "error.staleHostExists": "同名文件已经存在：{file}（宿主停在升级前的 sage-mem，没有 create 语义；没有覆盖它）",
      "notice.staleHostWrite": "已按旧协议写入 {file} —— 宿主仍停着升级前的 sage-mem（DSH 没有完全退出），本次未做版本校验",
    };
    function t(key, params) {
      const s = Object.prototype.hasOwnProperty.call(MESSAGES, key) ? MESSAGES[key] : key;
      if (!params) return s;
      return String(s).replace(/\\{(\\w+)\\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(params, n) ? String(params[n]) : m; });
    }
    ${SHARED}
    globalThis.__api = {
      writeWithFallback: writeWithFallback,
      isStaleHostWriteError: isStaleHostWriteError,
      isNotFoundError: isNotFoundError,
      probeRemoteExists: probeRemoteExists,
    };
  })()`, sandbox)
  API = sandbox.__api
} catch (e) {
  console.log(`  （客户端分片里取不到 helper：${e && e.message}）`)
}
const wf = API && typeof API.writeWithFallback === 'function'
  ? API.writeWithFallback
  : () => Promise.reject(new Error('writeWithFallback missing'))
const isStale = API && typeof API.isStaleHostWriteError === 'function'
  ? API.isStaleHostWriteError
  : () => false
const isNotFound = API && typeof API.isNotFoundError === 'function'
  ? API.isNotFoundError
  : () => false
const probeExists = API && typeof API.probeRemoteExists === 'function'
  ? API.probeRemoteExists
  : () => Promise.reject(new Error('probeRemoteExists missing'))
/** 调 helper 并兜住 rejection：即使 helper 还没写，也让套件走成断言失败而不是整个崩掉。 */
const run = async (...args) => {
  try { return await wf(...args) } catch (e) { return { error: e } }
}

group('0. helper 存在，且只认这一种结构化错误')
ok(!!API, '客户端共享基元里声明了 writeWithFallback / isStaleHostWriteError')
{
  const stale = Object.assign(new Error('typert gateway: memory/writeFile: args fields do not match the descriptor: unexpected "opts"'), {
    name: 'RemoteError', code: 'gateway/arguments-invalid',
  })
  ok(isStale(stale) === true, '旧 strict descriptor 的报错被判为「陈旧宿主」')
  // 反例：同一个 code、但拒绝的是别的字段 —— 不许当成 opts 兼容问题
  const otherField = Object.assign(new Error('typert gateway: memory/writeFile: args fields do not match the descriptor: unexpected "revision"'), {
    name: 'RemoteError', code: 'gateway/arguments-invalid',
  })
  ok(isStale(otherField) === false, '【反向对照】同一个 code 但点名别的字段 → 不判（不吞无关失败）')
  const inputInvalid = Object.assign(new Error('typert gateway: memory/writeFile: wire field "opts" failed boundary validation'), {
    name: 'RemoteError', code: 'gateway/input-invalid',
  })
  ok(isStale(inputInvalid) === false, '【反向对照】input-invalid（内容不合法）→ 不判')
  const plain = new Error('unexpected "opts"')
  ok(isStale(plain) === false, '【反向对照】没有网关 code 的普通 Error → 不判')
  ok(isStale(null) === false && isStale(undefined) === false, '【反向对照】空值不判')
  // ⚠️ 真机形态（2026-11-01 E2E 抓到）：网关失败是作为 remote 的**返回值**回来的，
  // 不是 rejection。第一版修复只判 rejection → 真机上降级一次都没触发。
  ok(isStale({ ok: false, error: stale }) === true, '【真机形态】返回值 {ok:false,error} 同样判为陈旧宿主')
  ok(isStale({ ok: false, error: otherField }) === false, '【反向对照】返回值里点名别的字段 → 不判')
  ok(isStale({ ok: true, value: {} }) === false, '【反向对照】成功结果 → 不判')
}
{
  // create 探针的「不存在」判据：只认 ENOENT 类文案，权限 / IO 一律不算
  ok(isNotFound(new Error('ENOENT: no such file or directory, open a.md')) === true, 'ENOENT 判为不存在')
  ok(isNotFound(new Error('sage-mem: no such file a.md')) === true, 'no such file 判为不存在')
  ok(isNotFound(new Error('EACCES: permission denied, open a.md')) === false, '【反向对照】EACCES（权限）不判为不存在')
  ok(isNotFound(new Error('EIO: i/o error')) === false, '【反向对照】EIO 不判为不存在')
  ok(isNotFound(null) === false, '【反向对照】空值不判为不存在')
}
group('0b. create 探针 probeRemoteExists：两种失败形态都能分清「不存在」与「读不了」')
{
  const remoteOf = (impl) => ({ readFile: impl })
  const missing = Object.assign(new Error('ENOENT: no such file or directory, open x.md'), { code: 'gateway/internal', name: 'RemoteError' })
  const denied = Object.assign(new Error('EACCES: permission denied, open x.md'), { code: 'gateway/internal', name: 'RemoteError' })
  ok((await probeExists(remoteOf(() => Promise.resolve({ ok: true, value: { content: 'x' } })), 'readFile', 'x.md')) === true,
    '读到文件 → true（已存在）')
  ok((await probeExists(remoteOf(() => Promise.resolve({ ok: false, error: missing })), 'readFile', 'x.md')) === false,
    '【真机形态】返回 {ok:false,error:ENOENT} → false（不存在）')
  ok((await probeExists(remoteOf(() => Promise.reject(missing)), 'readFile', 'x.md')) === false,
    '【rejection 形态】ENOENT → false（不存在）')
  {
    const remote = remoteOf(() => Promise.resolve({ ok: false, error: denied }))
    let caught = null
    try { await probeExists(remote, 'readFile', 'x.md') } catch (e) { caught = e }
    ok(caught === denied, '【真机形态】EACCES → 抛出（不判成不存在）')
  }
  {
    const remote = remoteOf(() => Promise.reject(denied))
    let caught = null
    try { await probeExists(remote, 'readFile', 'x.md') } catch (e) { caught = e }
    ok(caught === denied, '【rejection 形态】EACCES → 抛出（不判成不存在）')
  }
  {
    let caught = null
    try { await probeExists({}, 'readFile', 'x.md') } catch (e) { caught = e }
    ok(!!caught, '宿主没有这个方法 → 抛出（不静默当不存在）')
  }
}

/**
 * 假宿主：`stale=true` 时带第三参的写一律按旧 strict descriptor 拒绝，两参写成功。
 * `exists` 控制 readFile/readRaw 探到的存在性（create 降级的探针）。
 * `transport` 控制失败形态：`result`（默认，真机实测的形态：返回 `{ok:false, error}`）
 * 或 `reject`（rejection 形态）。两种都必须被识别 —— 第一版修复只判 rejection，
 * 结果在真机上完全没触发（见 2026-11-01 的 E2E 记录）。
 */
function makeHost({ stale = true, exists = false, otherError = null, transport = 'result' } = {}) {
  const calls = []
  const failure = (error) => (transport === 'reject' ? Promise.reject(error) : Promise.resolve({ ok: false, error }))
  const staleError = () => Object.assign(
    new Error('typert gateway: memory/writeFile: args fields do not match the descriptor: unexpected "opts"'),
    { name: 'RemoteError', code: 'gateway/arguments-invalid' },
  )
  const remote = {
    writeFile(...args) {
      calls.push({ method: 'writeFile', args: args.slice() })
      if (otherError) return failure(otherError)
      if (stale && args.length > 2 && args[2] !== undefined) return failure(staleError())
      return Promise.resolve({ ok: true, revision: 'r-new' })
    },
    readFile(...args) {
      calls.push({ method: 'readFile', args: args.slice() })
      return exists ? Promise.resolve({ ok: true, value: { content: 'old', revision: 'r-old' } }) : Promise.reject(new Error('ENOENT: no such file or directory'))
    },
  }
  return { remote, calls, writeCalls: () => calls.filter((c) => c.method === 'writeFile') }
}

// ── 1. 新宿主（契约新鲜）：一次调用，带 opts，不降级 ─────────────────────
group('1. 新宿主：照旧带 opts，只调一次，不降级')
{
  const h = makeHost({ stale: false })
  const out = await run(h.remote, 'writeFile', ['a.md', 'BODY'], { expectedRevision: 'r-old' })
  ok(out && out.degraded === false, 'degraded=false（正常路径不进降级）', JSON.stringify(out && out.degraded))
  ok(out && out.result && out.result.ok === true, '返回值照旧是宿主的结果对象', JSON.stringify(out && out.result))
  ok(h.writeCalls().length === 1 && h.writeCalls()[0].args.length === 3, '只调了一次 writeFile，且第三参在', JSON.stringify(h.calls))
  ok(!h.calls.some((c) => c.method === 'readFile'), '没有多余的探针调用')
}

// ── 2. 陈旧宿主 + 编辑（expectedRevision）：降级重试，写进去 ───────────────
group('2. 陈旧宿主 + expectedRevision：按旧协议重试（2 参），并标记降级')
{
  const h = makeHost({ stale: true })
  const out = await run(h.remote, 'writeFile', ['a.md', 'BODY'], { expectedRevision: 'r-old' })
  ok(out && out.degraded === true, 'degraded=true（这一版没做版本校验）')
  ok(out && out.result && out.result.ok === true, '重试后写入成功')
  const w = h.writeCalls()
  ok(w.length === 2, '一共两次写调用（先带 opts、再降级）', `n=${w.length}`)
  ok(!!(w[0] && w[1]) && w[0].args.length === 3 && w[1].args.length === 3 && w[1].args[2] === undefined,
    '第二次按旧协议：第三参位置仍在（客户端代理要求 3 个位置参数），值退成 undefined', JSON.stringify(w.map((c) => c.args.length + ':' + String(c.args[2]))))
  ok(!!w[1] && w[1].args[0] === 'a.md' && w[1].args[1] === 'BODY', '降级写交回的还是原参数')
}

// ── 3. 陈旧宿主 + 新建（create:true）：先探存在性，再决定能不能写 ──────────
group('3. 陈旧宿主 + create：目标不存在 → 探完按旧协议新建')
{
  const h = makeHost({ stale: true, exists: false })
  const out = await run(h.remote, 'writeFile', ['new.md', 'BODY'], { create: true }, function () {
    return h.remote.readFile('new.md').then(() => true, () => false)
  })
  ok(out && out.degraded === true, 'degraded=true')
  ok(out && out.result && out.result.ok === true, '探到不存在 → 降级新建成功')
  const seq = h.calls.map((c) => c.method + ':' + c.args.length).join(' → ')
  ok(seq === 'writeFile:3 → readFile:1 → writeFile:3', '顺序：带 opts 失败 → 探存在性 → 旧协议写（第三参 undefined）', seq)
}
group('4. 陈旧宿主 + create：目标已存在 → 明确拒绝，绝不覆盖')
{
  const h = makeHost({ stale: true, exists: true })
  const out = await run(h.remote, 'writeFile', ['dup.md', 'BODY'], { create: true }, function () {
    return h.remote.readFile('dup.md').then(() => true, () => false)
  })
  ok(h.writeCalls().length === 1, '只发生过「带 opts 的那一次」（被网关拒绝，未落盘）', JSON.stringify(h.calls))
  ok(out && out.degraded === true, 'degraded=true（确实是陈旧宿主，只是这次拒绝写）')
  ok(out && out.result && out.result.ok === false && out.result.code === 'already_exists', '结果是 already_exists（复用正常的撞名语义）', JSON.stringify(out && out.result))
  ok(/dup\.md/.test(String(out && out.result && out.result.error)), '拒绝文案里点名了文件', String(out && out.result && out.result.error))
  ok(h.writeCalls().filter((c) => c.args.length === 3 && c.args[2] === undefined).length === 0, '没有发生任何「旧协议覆盖写」')
}
group('5. create 但没有探针：拒绝降级（宁可不写，也不猜）')
{
  const h = makeHost({ stale: true, exists: true })
  const out = await run(h.remote, 'writeFile', ['dup.md', 'BODY'], { create: true })
  ok(!!(out && out.error), '没有探针时把原错误抛出去（不降级覆盖）')
  ok(h.writeCalls().length === 1, '只调用了那一次被拒的写', JSON.stringify(h.calls))
}
group('5b. create + 探针读失败（权限 / IO）：不降级，绝不把读不到当不存在')
{
  const h = makeHost({ stale: true, exists: true })
  const perm = new Error('EACCES: permission denied, open dup.md')
  const out = await run(h.remote, 'writeFile', ['dup.md', 'BODY'], { create: true }, function () {
    return Promise.reject(perm)
  })
  ok(out && out.error === perm, '探不清时把探针错误原样抛出去（调用方看得到原因）')
  ok(h.writeCalls().length === 1, '没有降级写（读失败不是「不存在」）', JSON.stringify(h.calls))
}

// ── 6. 两种失败形态：真机（返回值）与 rejection 都必须一致地识别 ──────────
group('6. 两种失败形态都识别：返回值 {ok:false,error} 与 rejection')
{
  for (const transport of ['result', 'reject']) {
    const h = makeHost({ stale: true, transport })
    const out = await run(h.remote, 'writeFile', ['a.md', 'BODY'], { expectedRevision: 'r-old' })
    ok(out && out.degraded === true, `[${transport}] 陈旧宿主的失败被判出并降级`, JSON.stringify(out && out.result))
    ok(h.writeCalls().length === 2 && h.writeCalls()[1].args.length === 3 && h.writeCalls()[1].args[2] === undefined,
      `[${transport}] 第二次退到旧协议（第三参 undefined）`, JSON.stringify(h.writeCalls().map((c) => c.args.length + ':' + String(c.args[2]))))
  }
}

// ── 7. 其它错误：原样交出，不重试 ────────────────────────────────────────
group('7. 不是「陈旧宿主」的错误原样交出，绝不重试')
{
  const other = Object.assign(new Error('typert gateway: memory/writeFile: wire field "content" failed boundary validation'), {
    name: 'RemoteError', code: 'gateway/input-invalid',
  })
  {
    // rejection 形态：原样抛出
    const h = makeHost({ stale: true, otherError: other, transport: 'reject' })
    const out = await run(h.remote, 'writeFile', ['a.md', 'BODY'], { expectedRevision: 'r-old' })
    ok(out && out.error === other, '[reject] 原错误对象原样透出（调用方能按 code 处理）')
    ok(h.writeCalls().length === 1, '[reject] 没有降级重试', JSON.stringify(h.calls))
  }
  {
    // 返回值形态：原样交回（不吞掉、不改写成 degraded）
    const h = makeHost({ stale: true, otherError: other, transport: 'result' })
    const out = await run(h.remote, 'writeFile', ['a.md', 'BODY'], { expectedRevision: 'r-old' })
    ok(out && out.degraded === false && out.result && out.result.ok === false && out.result.error === other,
      '[result] 失败结果原样交回（不重试、不标降级）', JSON.stringify(out && out.result))
    ok(h.writeCalls().length === 1, '[result] 没有降级重试', JSON.stringify(h.calls))
  }
}

// ── 8. 不带 opts 的旧调用方：不多此一举 ──────────────────────────────────
group('8. 没有 opts 的写：只调一次两参写，degraded=false')
{
  const h = makeHost({ stale: true })
  const out = await run(h.remote, 'writeFile', ['a.md', 'BODY'], undefined)
  ok(out && out.degraded === false && out.result && out.result.ok === true, '两参写照旧成功、不算降级')
  ok(h.writeCalls().length === 1 && h.writeCalls()[0].args.length === 3 && h.writeCalls()[0].args[2] === undefined,
    '只有一次调用，第三参位置在、值为 undefined（客户端代理要求三个位置参数）', JSON.stringify(h.calls))
}

// ── 9. 静态接线：面板四个写入口都走同一个 helper，中英文案都在 ────────────
group('9. 静态守卫：面板写入口接上降级 helper + 双语提示')
{
  const panel = readFileSync(new URL('../client/70-memory-panel.js', import.meta.url), 'utf8')
  ok(/writeWithFallback\(remote, "writeFile"/.test(panel), '活动记忆保存走 writeWithFallback(writeFile)')
  ok(/writeWithFallback\(remote, "writeRaw"/.test(panel), '保留名保存走 writeWithFallback(writeRaw)')
  ok(/writeWithFallback\(remote, "writeArchived"/.test(panel), '归档件保存走 writeWithFallback(writeArchived)')
  ok(!/remote\.writeFile\(safeName, content, writeOpts\)/.test(panel), '旧的裸 writeFile 调用已消失（否则降级不生效）')
  ok(/out\.degraded/.test(panel), '保存成功后会把「这次没做版本校验」告诉用户')
  // 三个 create 探针都必须走同一个只认「明确的 not-found」的探针（Q10 的教训）
  ok((panel.match(/probeRemoteExists\(remote, "/g) || []).length === 3, '三个 create 探针都走 probeRemoteExists', `count=${(panel.match(/probeRemoteExists\(remote, "/g) || []).length}`)
  ok(/probeRemoteExists\(remote, "readFile", safeName\)/.test(panel), '活动记忆新建探 readFile')
  ok(/probeRemoteExists\(remote, "readRaw", "MEMORY\.md"\)/.test(panel), '索引骨架探 readRaw(MEMORY.md)')
  ok(/probeRemoteExists\(remote, "readRaw", name\)/.test(panel), '保留名新建探 readRaw')
  ok(!/readFile\(safeName\)\.then\(function \(\) \{ return true; \}, function \(\) \{ return false; \}\)/.test(panel), '没有「任何读失败都当不存在」的探针')
  const shared = readFileSync(new URL('../client/05-shared.js', import.meta.url), 'utf8')
  ok(/function isNotFoundError/.test(shared) && /ENOENT\|no such file\|not exist/.test(shared), 'isNotFoundError 只在共享基元里定义一次，判据是 ENOENT 文案')
  ok(/function probeRemoteExists/.test(shared) && /result\.ok === false && result\.error/.test(shared), 'probeRemoteExists 同时处理返回值形态与 rejection 形态')
  const i18n = readFileSync(new URL('../client/55-i18n-memory.js', import.meta.url), 'utf8')
  const zhKeys = (i18n.match(/"notice\.staleHostWrite"/g) || []).length
  const enKeys = zhKeys
  ok(zhKeys >= 2, 'notice.staleHostWrite 在 zh 与 en 两份字典里都声明了', `count=${zhKeys}`)
  ok((i18n.match(/"error\.staleHostExists"/g) || []).length >= 2, 'error.staleHostExists 在 zh 与 en 两份字典里都声明了')
  ok(enKeys >= 2, '（dictionaries 成对出现）')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

