/**
 * 自动做梦配置的**写入面**必须真的写得进去（v0.9.12）。
 *
 * 起因（用户 2026-10-11 在界面上撞到）：改了「闲置多少天算可以归档」的参考阈值 → 保存 →
 * 界面红字报「保存没生效：参考 仍是 180」。
 *
 * 两层根因，都在这份断言里钉住：
 *   ① `lib/typert.host.js` 的 `autodreamPatchSchema` 没有这两个字段 —— **strict codec 会把
 *      未声明的字段剥掉**，所以 patch 到了宿主侧早就不见了。连 `autoArchive` 都不在里面，
 *      意味着**三档策略从 v0.9.0 起就一直是摆设**（界面点了、值没落盘）。
 *   ② `lib/autodream/settings.js` 的 `setConfig` 是逐字段白名单，也没收 `archiveAfterDays*`。
 *
 * ⚠️ 这个 bug 之前测不出来，是因为断言只测了「调用了 setConfig」——
 * 没测「值真的变了」。**调用 ≠ 生效**，这是「假绿」的又一例（与 issue #3 同类）。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const LIB = new URL('../lib/', import.meta.url)
const { TYPERT } = await import(new URL('typert.host.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) } else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`) }
}

console.log('== 1. typert patch schema 必须放行这些字段（strict 会剥掉未声明的）==')
{
  const inv = TYPERT.invocations.find((i) => i.id === 'sage-mem#autodream/setConfig')
  ok(!!inv, '（前提）找得到 autodream/setConfig')
  const schema = inv?.parameters?.[0]?.codec?.schema
  ok(!!schema, '（前提）它带 schema')

  const patch = {
    autoArchive: 'auto',
    archiveAfterDaysProject: 30,
    archiveAfterDaysReference: 200,
    archiveAfterDaysUser: 500,
  }
  const parsed = schema.safeParse(patch)
  ok(parsed.success === true, 'schema 接受了这份 patch', JSON.stringify(parsed.error?.issues ?? []))
  const got = parsed.success ? parsed.data : {}
  ok(got.autoArchive === 'auto', `autoArchive 没被剥掉（实际 ${JSON.stringify(got.autoArchive)}）`, JSON.stringify(got))
  for (const k of ['archiveAfterDaysProject', 'archiveAfterDaysReference', 'archiveAfterDaysUser']) {
    ok(got[k] === patch[k], `${k} 没被剥掉（实际 ${JSON.stringify(got[k])}）`, JSON.stringify(got))
  }
}

console.log('== 2. 端到端：setConfig 之后 getConfig 真的变了 ==')
{
  const root = await mkdtemp(join(tmpdir(), 'sage-mem-0912-cfg-'))
  // engine 需要 ctx：给一个「取什么都是 undefined」的桩——setConfig 只用到 load/persist
  const stub = new Proxy(function () {}, { get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined), apply: () => undefined })
  const ctx = new Proxy({ on: () => {}, get: () => undefined, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }, { get: (t, p) => (p in t ? t[p] : stub) })
  const { AutodreamEngine } = await import(new URL('autodream.js', LIB).href)
  const engine = new AutodreamEngine(ctx, { home: root, memoryDir: join(root, 'memory') })
  await engine.load()

  const before = await engine.getConfig()
  ok(typeof before.config.archiveAfterDaysReference === 'number', '（前提）初始配置里有阈值', JSON.stringify(before.config.archiveAfterDaysReference))

  const r1 = await engine.setConfig({ autoArchive: 'auto' })
  ok(r1.config.autoArchive === 'auto', `autoArchive 真的写进去了（实际 ${r1.config.autoArchive}）`)

  const r2 = await engine.setConfig({ archiveAfterDaysReference: 200, archiveAfterDaysProject: 30 })
  ok(r2.config.archiveAfterDaysReference === 200, `参考阈值真的写进去了（实际 ${r2.config.archiveAfterDaysReference}）`)
  ok(r2.config.archiveAfterDaysProject === 30, `项目阈值真的写进去了（实际 ${r2.config.archiveAfterDaysProject}）`)

  // 落盘了才算数：重新 load 一遍
  const engine2 = new AutodreamEngine(ctx, { home: root, memoryDir: join(root, 'memory') })
  await engine2.load()
  const after = await engine2.getConfig()
  ok(after.config.archiveAfterDaysReference === 200, '重读配置仍是 200（真落盘了）', JSON.stringify(after.config.archiveAfterDaysReference))
  ok(after.config.autoArchive === 'auto', '重读配置仍是 auto')

  // 越界值要被收敛，而不是写进一份坏配置
  const r3 = await engine.setConfig({ archiveAfterDaysUser: 99999 })
  ok(r3.config.archiveAfterDaysUser <= 3650 && r3.config.archiveAfterDaysUser > 0, `越界值被收敛到合法范围（实际 ${r3.config.archiveAfterDaysUser}）`)
  const r4 = await engine.setConfig({ archiveAfterDaysUser: 0 })
  ok(r4.config.archiveAfterDaysUser > 0, `0 也被收敛（实际 ${r4.config.archiveAfterDaysUser}）`)

  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log('== 3. 端到端（走界面的真实路径：先过 codec，再 setConfig）==')
{
  // ⚠️ 这一段是关键：直接调 engine.setConfig 会**绕过 typert codec**，
  // 于是「schema 剥字段」这类 bug 一条都测不出来（上面组 2 就是这样漏掉 autoArchive 的）。
  // 界面的真实路径是 client → codec（strict，剥未声明字段）→ setConfig。
  const inv = TYPERT.invocations.find((i) => i.id === 'sage-mem#autodream/setConfig')
  const schema = inv.parameters[0].codec.schema
  const root = await mkdtemp(join(tmpdir(), 'sage-mem-0912-wire-'))
  const stub = new Proxy(function () {}, { get: (t, p) => (typeof p === 'string' && p !== 'then' ? stub : undefined), apply: () => undefined })
  const ctx = new Proxy({ on: () => {}, get: () => undefined, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }, { get: (t, p) => (p in t ? t[p] : stub) })
  const { AutodreamEngine } = await import(new URL('autodream.js', LIB).href)
  const engine = new AutodreamEngine(ctx, { home: root, memoryDir: join(root, 'memory') })
  await engine.load()

  const raw = { autoArchive: 'auto', archiveAfterDaysProject: 30, archiveAfterDaysReference: 200, archiveAfterDaysUser: 500 }
  const wired = schema.safeParse(raw).data // 客户端发出去时会被 codec 过一遍
  const r = await engine.setConfig(wired)
  ok(r.config.autoArchive === 'auto', `真实路径下 autoArchive 落盘（实际 ${r.config.autoArchive}）`)
  ok(r.config.archiveAfterDaysReference === 200 && r.config.archiveAfterDaysProject === 30 && r.config.archiveAfterDaysUser === 500,
    `真实路径下三个阈值都落盘（实际 ${r.config.archiveAfterDaysProject}/${r.config.archiveAfterDaysReference}/${r.config.archiveAfterDaysUser}）`)

  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
