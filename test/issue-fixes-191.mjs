#!/usr/bin/env node
/**
 * issue-fixes-191.mjs — 1.9.1 的三份外部报告（issue #6 / #7 / #8）各留一条会红的断言
 *
 * 建这套的规矩：**每一条修复都必须有一条「改回去就红」的断言**，而不是只证明「现在没报错」。
 * 三组分别对应：
 *
 *   1. **#8 索引假阳性** —— `MEMORY.md` 带不带 frontmatter，都不能被报「type 与前缀不一致」；
 *      但普通记忆文件的前缀检查**必须照旧生效**（反向对照，否则修法可能是「把检查删了」）。
 *   2. **#6 沙箱写入** —— workspace-write 宿主上写入要带上**收窄到记忆目录**的逐次策略；
 *      read-only 不许被插件绕过；被拒时 `denials()` 要有记录、`judgeWriteOutcome` 要判失败。
 *   3. **#7 冲突队列膨胀** —— 同一件事重复失败只留一条记录；内容不同仍是两条。
 *
 * 用法: node issue-fixes-191.mjs
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function group(t) { console.log('== ' + t + ' ==') }

const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-191-'))
const memDir = join(sandbox, 'memory')
const stateDir = join(sandbox, '.sage-mem')
mkdirSync(memDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
process.env.SAGE_MEM_DIR = memDir
process.env.SAGE_MEM_STATE_DIR = stateDir
process.env.DSH_HOME = join(sandbox, 'dsh-home')

const LIB = new URL('../lib/', import.meta.url)
const { auditMemoryDir } = await import(new URL('autodream/audit.js', LIB).href)
const { createToolRunner } = await import(new URL('autodream/tools.js', LIB).href)
const { judgeWriteOutcome } = await import(new URL('autodream/engine.js', LIB).href)

const INDEX = join(memDir, 'MEMORY.md')
const ALPHA = join(memDir, 'project_alpha.md')
const BETA = join(memDir, 'user_beta.md')
const CONFLICTS_DIR = join(stateDir, 'conflicts')

const ALPHA_BODY = '---\nname: project_alpha\ndescription: 项目 A 的现状\ntype: project\n---\n\n正文 A\n'
const BETA_BODY = '---\nname: user_beta\ndescription: 用户的偏好\ntype: project\n---\n\n正文 B\n'

/** 假 ctx：同时提供 `fs` 与 `sandboxPolicy`，并记录第 5 个参数（逐次策略）有没有传、传了什么。 */
function makeCtx(opts = {}) {
  const seen = { policy: 'NOT_CALLED', writes: 0, denials: 0 }
  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    effect: () => {},
    on: () => {},
    seen,
  }
  const mode = opts.mode ?? 'workspace-write'
  ctx.get = (name) => {
    if (name === 'sandboxPolicy') {
      if (opts.policyService === false) return undefined
      return { resolve: () => ({ mode, workspaceRoot: opts.fallbackRoot ?? join(sandbox, 'ws') }) }
    }
    if (name !== 'fs') return undefined
    if (opts.fsService === false) return undefined
    return {
      resolve: async (p) => ({ targetKey: 'k:' + p, displayPath: p }),
      stat: async () => (opts.fileAbsent ? undefined : { version: 'fsv:1', type: 'file' }),
      readText: async () => opts.onDisk ?? '盘上这一版\n',
      writeText: async (_t, _c, _e, _s, policy) => {
        seen.writes++
        seen.policy = policy
        if (opts.deny) {
          seen.denials++
          const e = new Error('cannot write "' + _t.displayPath + '": file access denied under ' + mode + ' mode')
          e.code = 'FS_SANDBOX_DENIED'
          throw e
        }
        return { operation: opts.fileAbsent ? 'create' : 'update', version: 'fsv:2', before: '', after: _c }
      },
    }
  }
  return ctx
}
const runnerFor = (ctx) => createToolRunner({ memoryDir: memDir, sessionsRoot: '', apply: true, withSessions: false, ctx })

// ═══ 1. #8：索引的 type/前缀假阳性 ═══
group('1. #8 索引带 frontmatter 也不再报 type 与前缀不一致')
{
  writeFileSync(ALPHA, ALPHA_BODY, 'utf8')
  // 历史版本 write_memory 硬要求 frontmatter，模型只好给索引补一个 type —— 正是现实形态。
  writeFileSync(INDEX, '---\nname: 记忆索引\ntype: reference\n---\n\n# 记忆索引\n\n- [项目 A](project_alpha.md) — 项目 A 的现状\n', 'utf8')

  const a = await auditMemoryDir(memDir)
  ok(a.typeMismatch.length === 0, 'MEMORY.md 带 type: reference 不再进 typeMismatch', JSON.stringify(a.typeMismatch))
  ok(a.problems === 0, '健康记忆库的 problems 回到 0', String(a.problems))
  ok(a.fileCount === 1, '索引不计入 fileCount（条目数是 1）', String(a.fileCount))

  // 反向对照：普通记忆文件的前缀检查必须照旧生效（否则这次修法可能是「把检查删了」）。
  writeFileSync(BETA, BETA_BODY, 'utf8')
  writeFileSync(INDEX, '---\nname: 记忆索引\ntype: reference\n---\n\n- [项目 A](project_alpha.md)\n- [用户偏好](user_beta.md)\n', 'utf8')
  const b = await auditMemoryDir(memDir)
  ok(b.typeMismatch.length === 1 && b.typeMismatch[0].file === 'user_beta.md',
    '【反向对照】user_beta.md 的 type: project 仍然被报', JSON.stringify(b.typeMismatch))

  // 索引不带 frontmatter（手册里「建立索引骨架」写出来的形态）→ 也不许报「无 frontmatter」。
  writeFileSync(INDEX, '# 记忆索引\n\n- [项目 A](project_alpha.md)\n- [用户偏好](user_beta.md)\n', 'utf8')
  const c = await auditMemoryDir(memDir)
  ok(c.noFrontmatter.length === 0, 'MEMORY.md 没有 frontmatter 也不报「无 frontmatter」', JSON.stringify(c.noFrontmatter))
  ok(c.typeMismatch.length === 1, '没有 frontmatter 的索引同样不参与前缀检查', JSON.stringify(c.typeMismatch))
}

// ═══ 2. #8 写入侧：write_memory 允许索引不写 frontmatter ═══
group('2. #8 write_memory 对 MEMORY.md 免除 frontmatter 要求')
{
  // 没有 fs 服务 → 走本地原子写回落，观察的是「写入门槛」本身。
  const runner = runnerFor(makeCtx({ fsService: false }))
  const indexText = '# 记忆索引\n\n- [项目 A](project_alpha.md) — 项目 A 的现状\n'
  const w = await runner.run('write_memory', { file: 'MEMORY.md', content: indexText, reason: '整理索引' })
  ok(/^已写入 MEMORY\.md/.test(w), '索引可以不带 frontmatter 写入', w)
  ok(readFileSync(INDEX, 'utf8') === indexText, '落盘内容与提交内容逐字节相同')

  const refused = await runner.run('write_memory', {
    file: 'feedback_plain.md',
    content: '没有 frontmatter 的普通记忆\n',
    reason: '试试',
  })
  ok(/必须以 `---` 开头/.test(refused), '【反向对照】普通记忆仍然必须带 frontmatter', refused)

  const d = await auditMemoryDir(memDir)
  ok(d.noFrontmatter.length === 0 && d.typeMismatch.length === 1,
    '写入后的体检仍只有那条真实的前缀问题', JSON.stringify({ noFrontmatter: d.noFrontmatter, typeMismatch: d.typeMismatch }))
}

// ═══ 3. #6：逐次沙箱策略 ═══
group('3. #6 workspace-write 宿主：写入带上收窄到记忆目录的逐次策略')
{
  const ctx = makeCtx({ mode: 'workspace-write', fileAbsent: true })
  const r = runnerFor(ctx)
  const out = await r.run('write_memory', {
    file: 'feedback_sandbox.md',
    content: '---\nname: feedback_sandbox\ntype: feedback\n---\n\n正文\n',
    reason: '新写一条',
  })
  ok(/^已写入 feedback_sandbox\.md/.test(out), '写入成功', out)
  ok(ctx.seen.policy && ctx.seen.policy.mode === 'workspace-write',
    '第 5 个参数传了 workspace-write 策略', JSON.stringify(ctx.seen.policy))
  ok(ctx.seen.policy && ctx.seen.policy.workspaceRoot === memDir,
    '可写根收窄到记忆目录（不是会话工作区、也不是 process.cwd()）', ctx.seen.policy && ctx.seen.policy.workspaceRoot)
}

group('3b. #6 read-only 宿主：不许被插件绕过，且失败要能诊断')
{
  const ctx = makeCtx({ mode: 'read-only', fileAbsent: true, deny: true })
  const r = runnerFor(ctx)
  const out = await r.run('write_memory', {
    file: 'feedback_readonly.md',
    content: '---\nname: feedback_readonly\ntype: feedback\n---\n\n正文\n',
    reason: '新写一条',
  })
  ok(ctx.seen.policy === undefined, 'read-only 下不传逐次策略（不替用户翻案）', String(ctx.seen.policy))
  ok(/工具执行失败/.test(out), '拒绝如实回给模型', out)
  ok(/沙箱/.test(out) && /workspaceRoot/.test(out), '错误里带可诊断的出路，而不是只有 access denied', out)
  ok(r.denials().length === 1 && r.denials()[0].file === 'feedback_readonly.md', 'denials() 记下了这一次拒绝')
  ok(r.warnings().length === 1, '同一件事也进了 warnings（整理声明要能看见）')

  const judged = judgeWriteOutcome({ apply: true, changeCount: 0, denials: r.denials() })
  ok(judged.allDenied === true && /全部被宿主文件沙箱拒绝/.test(judged.error),
    '零改动 + 全被拒 → 判失败，不再报成「成功，没改什么」', JSON.stringify(judged))
}

group('3c. #6 其余两种宿主模式不传策略；部分成功仍算成功')
{
  const full = makeCtx({ mode: 'danger-full-access', fileAbsent: true })
  const r1 = runnerFor(full)
  await r1.run('write_memory', { file: 'feedback_full.md', content: '---\nname: x\ntype: feedback\n---\n\n正文\n', reason: '新写' })
  ok(full.seen.policy === undefined, 'danger-full-access 本来就不围栏，不传策略', String(full.seen.policy))

  const oldHost = makeCtx({ mode: 'workspace-write', fileAbsent: true, policyService: false })
  const r2 = runnerFor(oldHost)
  await r2.run('write_memory', { file: 'feedback_old.md', content: '---\nname: y\ntype: feedback\n---\n\n正文\n', reason: '新写' })
  ok(oldHost.seen.policy === undefined, '没有 sandboxPolicy 服务（老宿主/假 ctx）时不传，退回宿主默认行为', String(oldHost.seen.policy))

  const partial = judgeWriteOutcome({ apply: true, changeCount: 2, denials: [{ message: 'denied' }] })
  ok(partial.allDenied === false, '【反向对照】有改动落地时不算失败（被拒的由声明交代）')
  const dry = judgeWriteOutcome({ apply: false, changeCount: 0, denials: [{ message: 'denied' }] })
  ok(dry.allDenied === false, '【反向对照】只出报告模式不判失败（它本来就不写）')
}

// ═══ 4. #7：冲突队列去重 ═══
group('4. #7 同一件事重复失败只留一条冲突记录')
{
  // 干净的队列：上一组写过文件，冲突目录可能已经被 1.9.1 之前的路径碰过，这里先清空。
  rmSync(CONFLICTS_DIR, { recursive: true, force: true })
  // 盘上已有、但模型从没读过 → 走 guard.refuse（UNVERIFIED_OVERWRITE）这条落冲突的路。
  writeFileSync(ALPHA, ALPHA_BODY, 'utf8')
  const ctx = makeCtx({ mode: 'workspace-write' })
  const r = runnerFor(ctx)
  const body = '---\nname: project_alpha\ntype: project\n---\n\n自动整理想写的新内容\n'

  const first = await r.run('write_memory', { file: 'project_alpha.md', content: body, reason: '合并段落' })
  const second = await r.run('write_memory', { file: 'project_alpha.md', content: body, reason: '合并段落' })
  ok(/工具执行失败/.test(first) && /工具执行失败/.test(second), '两次都如实拒绝（不静默覆盖）', first + ' / ' + second)
  const files1 = readdirSync(CONFLICTS_DIR).filter((n) => n.endsWith('.json'))
  ok(files1.length === 1, '同一件事重复失败只落一条记录', `实际 ${files1.length}: ${files1.join(', ')}`)
  const rec = JSON.parse(readFileSync(join(CONFLICTS_DIR, files1[0]), 'utf8'))
  ok(rec.status === 'open' && rec.kind === 'external_change' && rec.file === 'project_alpha.md',
    '记录本身仍是完整的一条待裁决冲突（不是被合并/裁决）', JSON.stringify({ status: rec.status, kind: rec.kind, file: rec.file }))

  // 反向对照：内容不同 = 另一件事，必须落第二条。
  await r.run('write_memory', { file: 'project_alpha.md', content: body + '\n不同的第二版\n', reason: '再改一版' })
  const files2 = readdirSync(CONFLICTS_DIR).filter((n) => n.endsWith('.json'))
  ok(files2.length === 2, '【反向对照】内容不同仍然是两条独立记录', `实际 ${files2.length}`)
}

rmSync(sandbox, { recursive: true, force: true })

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
