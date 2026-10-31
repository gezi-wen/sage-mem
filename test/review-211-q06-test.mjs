/**
 * 2.1.5 / Q06 回归：恢复归档时「保护了目标，却无条件删除可能已更新的源」。
 *
 * 审查原文（2026-10-31 外部审查 Q06，P1）：
 *   restore 读 archive/a.md 得到 A；目标 a.md 成功排他落位之后、源 unlink 之前，
 *   另一个编辑操作把归档源改成 B。旧实现先落位 A、再 `unlink(src)` —— 而 `unlink(名字)`
 *   只认名字，不认我们读过的那一份，于是 B 被删：新版本从两个位置一起消失，
 *   函数还回 `ok:true`。
 *
 * 本套件断言的是**最后留下了哪些字节**，不是返回值好不好看：
 *   ① 读源后 / 接管前后 / 目标落位后分别插入「把源改成 B」——任何路径都不许丢 B；
 *   ② 注入 EEXIST / EIO / 归还失败时，A 与 B 至少各留一份**可定位**的原文；
 *   ③ 正常路径反向对照：不多留废文件、归档区那份确实退役；
 *   ④ 归档侧（同一个事务移动原语）既有保证不许被这次重构改掉。
 *
 * 测法：在真实 `node:fs/promises` 系统调用边界插桩（`syncBuiltinESMExports()` 让
 * lib 里的具名导入看到补丁），两侧跑的都是仓库真实代码，不伪造调用结果。
 */
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIB = new URL('../lib/', import.meta.url)
const { restoreMemory, archiveMemory } = await import(new URL('memory/archive.js', LIB).href)
const { auditMemoryDir } = await import(new URL('autodream/audit.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`)
  }
}
const group = (t) => console.log(`== ${t} ==`)

/** 归档区里一条「A 版」原文（留痕与正文都写全，便于逐字节比对）。 */
const ARCHIVED_A = '---\narchived_at: 2026-10-23 12:34\narchived_reason: review\n---\n\nA old\n'
/** 恢复时应当落位到顶层的形状（剥掉两行留痕）。 */
const STRIPPED_A = '---\n---\n\nA old\n'
/** 并发编辑器写进来的「B 版」：连 archived_at 都没变（这正是最坏的那种改写）。 */
const CHANGED_B = '---\narchived_at: 2026-10-23 12:34\n---\n\nB concurrent edit\n'
/** 顶层被别人新建的活动记忆。 */
const ACTIVE_NEW = '---\nname: a\ntype: project\n---\n\nX new active\n'

const exists = async (p) => (await stat(p).catch(() => null)) !== null
const read = (p) => readFile(p, 'utf8').catch(() => null)

/** 一个新的临时世界：memory/ + memory/archive/。 */
async function world() {
  const root = await mkdtemp(join(tmpdir(), 'smem-q06-'))
  const mem = join(root, 'memory')
  await mkdir(join(mem, 'archive'), { recursive: true })
  return { root, mem, src: join(mem, 'archive', 'a.md'), dst: join(mem, 'a.md') }
}

/**
 * 在指定的 fs 调用边界上打补丁，跑完**一定**恢复原函数。
 * `patch` 的每个键是 fs.promises 的方法名，值是 `(orig) => wrapper`。
 */
async function withFsPatch(patch, run) {
  const saved = new Map()
  for (const key of Object.keys(patch)) {
    saved.set(key, fsPromises[key])
    fsPromises[key] = patch[key](saved.get(key))
  }
  syncBuiltinESMExports()
  try {
    return await run()
  } finally {
    for (const [key, fn] of saved) fsPromises[key] = fn
    syncBuiltinESMExports()
  }
}

/** 调一个可能抛异常的 lib 函数：抛出来的也接住，别让套件半路崩掉读不到汇总行。 */
async function call(fn) {
  try {
    return { value: await fn() }
  } catch (err) {
    return { threw: err }
  }
}

// ────────────────────────────── ① 读源之后被改写 ──────────────────────────────
group('1. 读源之后立刻出现 B：不许把 A 与 B 一起弄丢')
{
  const { mem, src, dst } = await world()
  await writeFile(src, ARCHIVED_A, 'utf8')
  let injected = false
  const out = await withFsPatch(
    {
      readFile: (orig) => async (p, ...a) => {
        const data = await orig(p, ...a)
        // 恢复读源的调用形态两版不同（新版拿 Buffer 做逐字节比对），首读即注入。
        if (!injected && p === src) {
          injected = true
          await writeFile(src, CHANGED_B, 'utf8')
        }
        return data
      },
    },
    async () => (await call(() => restoreMemory(mem, 'a.md'))).value,
  )
  ok(injected === true, '（前提）注入生效：读完归档源之后把它换成 B')
  ok(out?.ok === false, '恢复如实报告「源被改写，放弃本次恢复」', JSON.stringify(out))
  ok((await read(src)) === CHANGED_B, 'B 留在归档区（旧代码先读 A 再按名字 unlink，B 与 A 一起没）')
  ok(!(await exists(dst)), '顶层没有落位一份 A（没把一份「已经不是当前内容」的东西报成恢复成功）')
  const residue = (await fsPromises.readdir(join(mem, 'archive'))).filter((f) => /\.(archiving|restoring)-/.test(f))
  ok(residue.length === 0, '没有留下私有名残留（还回去了）', JSON.stringify(residue))
  await rm(mem, { recursive: true, force: true }).catch(() => {})
}

// ────────────────────────────── ② 接管之前被改写 ──────────────────────────────
group('2. 接管源之前出现 B：B 必须留在归档区')
{
  const { mem, src, dst } = await world()
  await writeFile(src, ARCHIVED_A, 'utf8')
  let injected = false
  /** 两版实现各拦一条：新版在 rename(源 → 私有名) 之前，旧版在 unlink(源) 之前。 */
  const inject = async () => {
    if (injected) return
    injected = true
    await writeFile(src, CHANGED_B, 'utf8')
  }
  const out = await withFsPatch(
    {
      rename: (orig) => async (from, to, ...a) => {
        if (from === src) await inject()
        return orig(from, to, ...a)
      },
      unlink: (orig) => async (p, ...a) => {
        if (p === src) await inject()
        return orig(p, ...a)
      },
    },
    async () => (await call(() => restoreMemory(mem, 'a.md'))).value,
  )
  ok(injected === true, '（前提）注入生效：源被移走之前写成 B')
  ok(out?.ok === false, '放弃本次恢复（没有把 B 当成 A 收走）', JSON.stringify(out))
  ok((await read(src)) === CHANGED_B, 'B 仍在归档区原处')
  ok(!(await exists(dst)), '顶层没有落位 A')
  await rm(mem, { recursive: true, force: true }).catch(() => {})
}

// ──────────────────── ③ 接管之后（核对之前）被改写 ────────────────────
group('3. 接管之后源名短暂空缺：期间新建的同名归档件不许被删')
{
  const { mem, src, dst } = await world()
  await writeFile(src, ARCHIVED_A, 'utf8')
  let injected = false
  const out = await withFsPatch(
    {
      // 新版会把源 rename 成 `.restoring-<hex>` 再把它读回来核对 —— 在「读私有副本」这一刻
      // 往原名里落一个 B：此时原名空着（A 已被接管），B 会稳稳占住它。
      readFile: (orig) => async (p, ...a) => {
        const data = await orig(p, ...a)
        if (!injected && typeof p === 'string' && p.includes('.restoring-')) {
          injected = true
          await writeFile(src, CHANGED_B, 'utf8')
        }
        return data
      },
    },
    async () => (await call(() => restoreMemory(mem, 'a.md'))).value,
  )
  ok(injected === true, '（前提）注入生效：核对待收内容的那一刻原名被 B 占住')
  ok(out?.ok === true, '（前提）接管的确实是当初读到的那一份，恢复照常完成', JSON.stringify(out))
  ok((await read(dst)) === STRIPPED_A, '顶层拿到 A（接管副本已逐字节核对过）')
  ok((await read(src)) === CHANGED_B, '接管期间新建的 B 留在归档区（没有「退役私有副本时连它一起删」）')
  const residue = (await fsPromises.readdir(join(mem, 'archive'))).filter((f) => /\.(archiving|restoring)-/.test(f))
  ok(residue.length === 0, '没有留下私有副本', JSON.stringify(residue))
  await rm(mem, { recursive: true, force: true }).catch(() => {})
}

// ──────────────────── ④ 目标落位之后被改写（核心场景）────────────────────
group('4. 目标落位之后出现 B：旧实现的 unlink 会把它删掉')
{
  const { mem, src, dst } = await world()
  await writeFile(src, ARCHIVED_A, 'utf8')
  let injected = false
  const out = await withFsPatch(
    {
      link: (orig) => async (p, q, ...a) => {
        const r = await orig(p, q, ...a)
        // 排他落位成功的那一下：目标已经是 A 了，这时另一路把**归档源**写成 B。
        if (!injected && q === dst) {
          injected = true
          await writeFile(src, CHANGED_B, 'utf8')
        }
        return r
      },
    },
    async () => (await call(() => restoreMemory(mem, 'a.md'))).value,
  )
  ok(injected === true, '（前提）注入生效：目标落位之后归档源被写成 B')
  ok(out?.ok === true, '（前提）本次恢复本身成功', JSON.stringify(out))
  ok((await read(dst)) === STRIPPED_A, '顶层拿到的正是 A 剥掉留痕后的形状')
  ok((await read(src)) === CHANGED_B, '落位之后写进来的 B 留在归档区（旧实现这里 unlink(src) 删的就是它）')
  const residue = (await fsPromises.readdir(join(mem, 'archive'))).filter((f) => /\.(archiving|restoring)-/.test(f))
  ok(residue.length === 0, '退役的是私有副本，不是「当前名叫 archive/a.md 的那个文件」', JSON.stringify(residue))
  await rm(mem, { recursive: true, force: true }).catch(() => {})
}

// ──────────────── ⑤ 落位时目标冒出来（EEXIST）—— 既有排他保证的反向对照 ────────────────
group('5. 落位瞬间目标被新建：拒绝覆盖，A 原样退回归档区')
{
  const { mem, src, dst } = await world()
  await writeFile(src, ARCHIVED_A, 'utf8')
  let injected = false
  const out = await withFsPatch(
    {
      link: (orig) => async (p, q, ...a) => {
        if (!injected && q === dst) {
          injected = true
          await writeFile(dst, ACTIVE_NEW, 'utf8')
        }
        return orig(p, q, ...a)
      },
    },
    async () => (await call(() => restoreMemory(mem, 'a.md'))).value,
  )
  ok(injected === true, '（前提）注入生效：落位前顶层冒出一份同名活动记忆')
  ok(out?.ok === false && /already exists|refusing to overwrite/.test(String(out?.error)), '拒绝覆盖', JSON.stringify(out))
  ok((await read(dst)) === ACTIVE_NEW, '顶层那份新记忆一个字节没动')
  ok((await read(src)) === ARCHIVED_A, '归档区那份 A 原样退回（没有「覆盖 + 删源」双输）')
  await rm(mem, { recursive: true, force: true }).catch(() => {})
}

// ──────────────── ⑥ 落位失败且归还失败：A 必须留在可定位的私有名上 ────────────────
group('6. 落位 EIO + 归还原名被占：A 仍留在可定位的私有副本里，体检能报')
{
  const { mem, src, dst } = await world()
  await writeFile(src, ARCHIVED_A, 'utf8')
  const out = await withFsPatch(
    {
      link: (orig) => async (p, q, ...a) => {
        // 排他落位失败（EIO 不在「不支持硬链接」那组里 → 不会静默降级）
        if (q === dst) throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
        // 归还 A 到原名的 link 也被占住 → 只能留在私有名上
        if (q === src) throw Object.assign(new Error('occupied'), { code: 'EEXIST' })
        return orig(p, q, ...a)
      },
    },
    async () => (await call(() => restoreMemory(mem, 'a.md'))).value,
  )
  ok(out?.ok === false, '如实报告失败（不是抛出去让调用方瞎猜）', JSON.stringify(out))
  const residue = (await fsPromises.readdir(join(mem, 'archive'))).filter((f) => /\.restoring-/.test(f))
  ok(residue.length === 1, 'A 留在私有副本里', JSON.stringify(residue))
  ok(residue.length === 1 && (await read(join(mem, 'archive', residue[0]))) === ARCHIVED_A, '残留里逐字节就是 A 的原文')
  ok(typeof out?.error === 'string' && out.error.includes(residue[0] ?? '\u0000'), '错误里点名残留文件')
  ok(!(await exists(dst)), '顶层没有半截结果')
  const rep = await auditMemoryDir(mem)
  ok(rep.strays.some((s) => String(s.file).includes('.restoring-')) && rep.problems >= 1, '体检把它计入问题（界面上亮得起来）', JSON.stringify(rep.strays))
  await rm(mem, { recursive: true, force: true }).catch(() => {})
}

// ──────────────── ⑦ 崩溃残留：预先躺着的 .restoring- 文件也要被报出来 ────────────────
group('7. 崩溃残留（扫描侧）：.restoring- 与 .archiving- 一样可定位')
{
  const { mem } = await world()
  await writeFile(join(mem, 'archive', 'a.md.restoring-deadbeef12'), ARCHIVED_A, 'utf8')
  await writeFile(join(mem, 'b.md.archiving-cafebabe34'), '---\n---\n\nB\n', 'utf8')
  const rep = await auditMemoryDir(mem)
  ok(rep.strays.some((s) => String(s.file).includes('.restoring-')), '恢复残留被报出来（旧实现只认 .archiving-）', JSON.stringify(rep.strays))
  ok(rep.strays.some((s) => String(s.file).includes('.archiving-')), '归档残留照旧被报出来（没有为了新后缀弄丢旧的）', JSON.stringify(rep.strays))
  ok(rep.problems >= 2, '两条都计入 problems', String(rep.problems))
  await rm(mem, { recursive: true, force: true }).catch(() => {})
}

// ──────────────── ⑧ 正常路径反向对照 + 归档侧保证不变 ────────────────
group('8. 正常路径：一次干净的恢复不多留任何东西')
{
  const { mem, src, dst } = await world()
  await writeFile(src, ARCHIVED_A, 'utf8')
  const out = await call(() => restoreMemory(mem, 'a.md'))
  ok(out.value?.ok === true, '恢复成功', JSON.stringify(out.value ?? String(out.threw)))
  ok((await read(dst)) === STRIPPED_A, '顶层是 A 剥掉留痕后的逐字节内容')
  ok(!(await exists(src)), '归档区那份确实退役了')
  const residue = (await fsPromises.readdir(join(mem, 'archive'))).filter((f) => /\.(archiving|restoring)-/.test(f))
  ok(residue.length === 0, '没有留下私有副本', JSON.stringify(residue))
  const again = await call(() => restoreMemory(mem, 'a.md'))
  ok(again.value?.ok === false && /not archived/.test(String(again.value?.error)), '再恢复一次 → not archived', JSON.stringify(again.value))
  await rm(mem, { recursive: true, force: true }).catch(() => {})
}
group('9. 同一个事务移动原语：归档侧既有保证不许被这次重构改掉')
{
  // 归档的正常路径（反向对照：修复前后都必须成立）。
  const { root, mem } = await world()
  const active = join(mem, 'a.md')
  await writeFile(active, '---\nname: a\ntype: project\ndescription: x\n---\n\nA handled\n', 'utf8')
  const out = await call(() => archiveMemory(mem, 'a.md', 'review'))
  ok(out.value?.ok === true, '（前提）归档成功', JSON.stringify(out.value ?? String(out.threw)))
  ok((await read(join(mem, 'archive', 'a.md')))?.includes('A handled'), '归档件里有那条记忆')
  ok(!(await exists(active)), '活动区里那份移走了')
  await rm(root, { recursive: true, force: true }).catch(() => {})

  // 归档遇到并发改写（R06 的既有保证）：放弃归档、新版本原样留在原处。
  const w = await world()
  const active2 = join(w.mem, 'a.md')
  await writeFile(active2, '---\nname: a\ntype: project\ndescription: x\n---\n\nA old\n', 'utf8')
  let injected = false
  const raced = await withFsPatch(
    {
      // 归档侧读源用的是 `readFile(路径)`（拿 Buffer，不带编码）—— 任何参数形态都要拦到。
      readFile: (orig) => async (p, ...a) => {
        const data = await orig(p, ...a)
        if (!injected && p === active2) {
          injected = true
          await writeFile(active2, '---\nname: a\ntype: project\ndescription: x\n---\n\nB new\n', 'utf8')
        }
        return data
      },
    },
    async () => (await call(() => archiveMemory(w.mem, 'a.md', 'review'))).value,
  )
  ok(raced?.ok === false && raced.code === 'changed', '归档照样如实报告「源被改写，放弃本次归档」', JSON.stringify(raced))
  ok((await read(active2))?.includes('B new'), '新版本原样留在活动区')
  ok(!(await exists(join(w.mem, 'archive', 'a.md'))), '没留下半截归档副本')
  await rm(w.root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
