/**
 * 2.1.10 / 外部审查 Q10：建立索引骨架的初始化与「不会覆盖」边界不完整。
 *
 * 问题（修前）：
 *   ① 全新安装时 memory 目录还不存在，点「建立索引骨架」→ writeRaw 不建父目录，
 *      临时文件落盘直接 ENOENT（审查实测 `{error:"ENOENT"}`）；
 *   ② 前端把**任意** readRaw 失败当成「索引不存在」，再调用可覆盖的 writeRaw ——
 *      读失败若是权限 / 形状错误，那一存就顶掉一份真实索引；
 *   ③ 就算正常 ENOENT，「检查」与「写」之间新冒出来的索引也没有排他保护。
 *
 * 这组断言盯的：
 *   ① 缺目录 → createIfAbsent 先建父目录、成功初始化；
 *   ② 已有索引 → 明确 already_exists，逐字节不变（不是「静默跳过」也不是覆盖）；
 *   ③ 不可读 / 形状不对 → 原样报错、绝不触发覆盖；
 *   ④ 创建竞争 → 只有一个胜者，另一方得到明确「已存在」；
 *   ⑤ 前端只调一个意图接口（静态守卫：不再有「先读失败再写」的探针）。
 *
 * 修前红证据（审查报告 Q10 复现）：writeRaw 在目录不存在时抛 ENOENT。
 *
 * 只碰临时目录：SAGE_MEM_DIR / SAGE_MEM_STATE_DIR 必须在 import lib 之前设好。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = join(tmpdir(), `sage-mem-q10-test-${process.pid}`)
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
mkdirSync(memDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const LIB = new URL('../lib/', import.meta.url)
const { MemoryGateway } = await import(new URL('index.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

const api = Object.create(MemoryGateway.prototype)
api.ctx = { logger: { warn: () => {}, error: () => {} } }
const SKELETON = '# 记忆索引\n\n- [示例](example.md) — 骨架\n'
const indexAt = () => join(memDir, 'MEMORY.md')
const resetDir = () => { rmSync(memDir, { recursive: true, force: true }) }
const restoreDir = () => { rmSync(memDir, { recursive: true, force: true }); mkdirSync(memDir, { recursive: true }) }

// ── 1. 全新安装：目录不存在也能建立索引骨架 ───────────────────────
group('1. 缺目录 → createIfAbsent 建父目录并初始化')
{
  resetDir()
  ok(!existsSync(memDir), '前置：memory 目录确实不存在（全新安装状态）')
  let r
  try {
    r = await api.writeRaw('MEMORY.md', SKELETON, { create: true })
  } catch (e) {
    r = { threw: e?.code || String(e?.message ?? e) }
  }
  ok(r && r.ok === true, '缺目录时建立索引骨架成功（修前抛 ENOENT）', JSON.stringify(r))
  ok(r && r.created === true, '回执标明这是新建（created:true）', JSON.stringify(r))
  ok(existsSync(indexAt()), '索引文件确实落到盘上')
  ok(existsSync(indexAt()) && readFileSync(indexAt(), 'utf8') === SKELETON, '写入的正是骨架内容（逐字节）')
}

// ── 2. 已有索引：明确 already_exists，逐字节不变 ───────────────────
group('2. 已有索引 → already_exists，绝不覆盖')
{
  restoreDir()
  const existing = '# 我自己手写的索引\n\n- [a](a.md)\n'
  writeFileSync(indexAt(), existing, 'utf8')
  const before = readFileSync(indexAt())
  const r = await api.writeRaw('MEMORY.md', '# 新骨架（不该落盘）\n', { create: true })
  ok(r && r.ok === false, '已有索引时 createIfAbsent 被拒绝（不是 ok:true）', JSON.stringify(r))
  ok(r && r.code === 'already_exists', '冲突码是固定常量 already_exists', JSON.stringify(r))
  ok(readFileSync(indexAt()).equals(before), '已有索引逐字节不变（一份真实索引不该被顶掉）')
  const again = await api.writeRaw('MEMORY.md', '# 再试一次\n', { create: true })
  ok(again && again.ok === false && again.code === 'already_exists', '重复创建仍明确已存在（幂等拒绝）', JSON.stringify(again))
  ok(readFileSync(indexAt()).equals(before), '重复拒绝期间索引仍然逐字节不变')
}

// ── 3. 不可读 / 形状不对：原样报错，绝不触发覆盖 ───────────────────
group('3. 读不了 / 形状不对 → 不覆盖')
{
  // 3a. MEMORY.md 位置是一个目录（读不成文件）：createIfAbsent 必须拒绝且不动它
  restoreDir()
  mkdirSync(indexAt())
  const r = await api.writeRaw('MEMORY.md', SKELETON, { create: true })
  ok(r && r.ok === false, '目标形状不对（是目录）→ 明确拒绝', JSON.stringify(r))
  ok(r && r.code !== 'already_exists', '不是「已存在」的假成功：是形状/读取问题原样报出', JSON.stringify(r))
  ok(statSync(indexAt()).isDirectory(), '原来那个目录还在（没有被改成文件，也没有被覆盖）')
}
{
  // 3b. memory 路径本身不可用（是文件）：读写都失败 → 原样报错，不制造任何东西
  rmSync(memDir, { recursive: true, force: true })
  writeFileSync(memDir, 'not a directory', 'utf8')
  let r
  try {
    r = await api.writeRaw('MEMORY.md', SKELETON, { create: true })
  } catch (e) {
    r = { threw: e?.code || String(e?.message ?? e) }
  }
  ok(r && r.ok === false, 'memory 路径不可用 → 明确失败（不是静默成功）', JSON.stringify(r))
  ok(readFileSync(memDir, 'utf8') === 'not a directory', '那个占位文件逐字节未变（没有往它里面写索引）')
  restoreDir()
}

// ── 4. 创建竞争：只有一个胜者，另一方明确「已存在」──────────────────
group('4. 并发创建：一个胜者 + 一个明确已存在')
{
  resetDir()
  let pair
  try {
    pair = await Promise.all([
      api.writeRaw('MEMORY.md', '# 骨架 A\n', { create: true }),
      api.writeRaw('MEMORY.md', '# 骨架 B\n', { create: true }),
    ])
  } catch (e) {
    // 修前基线：writeRaw 在缺目录时直接抛 ENOENT —— 记成失败而不是让测试崩掉。
    pair = [{ threw: e?.code || String(e?.message ?? e) }, { threw: e?.code || String(e?.message ?? e) }]
  }
  const winners = pair.filter((x) => x && x.ok === true && x.created === true)
  const losers = pair.filter((x) => x && x.ok === false)
  ok(winners.length === 1, '并发创建只有一个胜者（排他落位）', JSON.stringify(pair.map((x) => ({ ok: x && x.ok, code: x && x.code }))))
  ok(losers.length === 1 && losers[0].code === 'already_exists', '另一方得到明确的 already_exists', JSON.stringify(losers[0]))
  const content = existsSync(indexAt()) ? readFileSync(indexAt(), 'utf8') : ''
  ok(content === '# 骨架 A\n' || content === '# 骨架 B\n', '落盘内容是其中一份胜出的骨架（没有半份/混合）', JSON.stringify(content))
  ok(pair.find((x) => x && x.ok === true) && content === (pair[0].ok ? '# 骨架 A\n' : '# 骨架 B\n'), '落盘内容就是胜出那一方交回的内容（对得上回执）')
}

// ── 5. 反向对照：已有目录 + create 正常成功；旧调用方不隐式建目录 ────
group('5. 反向对照')
{
  restoreDir()
  const r = await api.writeRaw('session-log.md', '# 流水\n', { create: true })
  ok(r && r.ok === true && r.created === true, '目录已存在时 createIfAbsent 正常建立（不误伤正常路径）', JSON.stringify(r))
  ok(readFileSync(join(memDir, 'session-log.md'), 'utf8') === '# 流水\n', '内容逐字节写入')
}
{
  // 旧调用方（不带 create）在缺目录时不再「抛 ENOENT」，而是结构化 io_error，且不隐式建目录。
  resetDir()
  let r
  try {
    r = await api.writeRaw('MEMORY.md', '# 旧协议\n')
  } catch (e) {
    r = { threw: e?.code || String(e?.message ?? e) }
  }
  ok(r && r.ok === false, '旧调用方缺目录 → 结构化失败（不是静默成功）', JSON.stringify(r))
  ok(r && r.code === 'io_error', '失败码是 io_error（可诊断）', JSON.stringify(r))
  ok(!existsSync(memDir), '旧调用方没有隐式创建目录（建目录只属于 createIfAbsent 意图）')
  restoreDir()
}

// ── 6. 前端分片：只调一个意图接口，不再「先读失败再写」────────────
group('6. 面板分片只调意图接口（静态守卫）')
{
  const panel = readFileSync(new URL('../client/70-memory-panel.js', import.meta.url), 'utf8')
  const start = panel.indexOf('function createIndexSkeleton')
  const end = panel.indexOf('function openMemoryFolder', start)
  const body = start >= 0 && end > start ? panel.slice(start, end) : ''
  ok(body !== '', '找到 createIndexSkeleton 函数体')
  ok(!/readRaw\s*\(/.test(body), '不再用 readRaw 当「不存在」探针（读失败可能是权限错误）')
  ok(/writeRaw\("MEMORY\.md",\s*INDEX_SKELETON,\s*\{\s*create:\s*true\s*\}\)/.test(body), '只调 writeRaw(create:true) 这一个意图接口')
  ok(/already_exists/.test(body) && /notice\.indexExists/.test(body), '把 already_exists 映射成「索引已存在」提示（不发错误）')
  ok(!/\.then\(function \(\) \{\s*setNotice\(t\("notice\.indexExists"\)\)/.test(body), '不再有「读成功 → 直接当已存在」的分支')
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
