/**
 * 工具调用观测（lib/memory/observe.js）的断言 —— 仓库内测试，随 npm test 一起跑。
 *
 * 重点不是 happy path，而是**反向对照**：目录外的读不许被认成「读了记忆」，前缀相似的
 * 目录不许过，`pwsh` 一律按「看不见」记。这一层最容易出的错不是崩溃，而是**看起来很勤快
 * 地在观测、实际观测错了对象** —— access.js 的台账事故（扫 A 目录写 B 台账）就是这一类。
 *
 * 夹具一律合成：`/srv/notes/memory` 与 `C:\Users\someone\memory` 都不对应任何真实路径。
 */
import { readFile } from 'node:fs/promises'

const mod = await import(new URL('../lib/memory/observe.js', import.meta.url).href)
const { READ_TOOLS, WRITE_TOOLS, UNOBSERVABLE_TOOLS, classifyToolExecution, accessEventKey, createDeduper } = mod

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const KINDS = ['active_read', 'list_only', 'write', 'unobservable', 'other']
const MEM = '/srv/notes/memory'
const MEM_WIN = 'C:\\Users\\someone\\memory'
const c = (tool, args, dir = MEM) => classifyToolExecution(tool, args, dir)
const show = (r) => JSON.stringify(r)

console.log('== 1. 工具表是数据 ==')
ok(READ_TOOLS.read === 'file_path' && READ_TOOLS.grep === 'path' && READ_TOOLS.glob === 'path',
  'READ_TOOLS 三个映射与实测一致', show(READ_TOOLS))
ok(Object.isFrozen(READ_TOOLS) && Object.isFrozen(WRITE_TOOLS) && Object.isFrozen(UNOBSERVABLE_TOOLS),
  '三张表都冻结（调用方改不动判定）')
ok(WRITE_TOOLS.includes('write') && WRITE_TOOLS.includes('edit'), 'write / edit 都在写工具表里')
ok(UNOBSERVABLE_TOOLS.includes('pwsh') && UNOBSERVABLE_TOOLS.includes('bash') && UNOBSERVABLE_TOOLS.includes('shell'),
  '执行类工具三个都在「看不见」表里')

console.log('== 2. read：记忆目录内 → active_read 带文件名 ==')
const inside = c('read', { file_path: `${MEM}/project_alpha.md` })
ok(inside.kind === 'active_read', '目录内文件 → active_read', show(inside))
ok(inside.file === 'project_alpha.md', 'file 是记忆文件名（不是路径）', show(inside))
ok(inside.dir === null, 'read 不给 dir')
ok(typeof inside.why === 'string' && inside.why !== '', 'why 非空（可解释性）')
ok(c('read', { file_path: `${MEM}/archive/old_beta.md` }).kind === 'active_read', '子目录里的记忆文件也认')
ok(c('read', { file_path: `${MEM}/MEMORY.md` }).file === 'MEMORY.md', '索引文件同样在记忆目录内（记不记进台账由调用方决定）')
ok(c('read', { file_path: `${MEM}/a.md` }, `${MEM}/`).kind === 'active_read', '记忆目录带尾分隔符照样认')
ok(c('read', { file_path: `${MEM}//./a.md` }).file === 'a.md', '重复分隔符与 `.` 归一后照样认')
ok(c('read', { file_path: `${MEM}/sub/../inner.md` }).file === 'inner.md', '目录内的 `..` 回退后仍在目录内 → 认')

console.log('== 3. 反向对照：目录外 / 前缀陷阱 / `..` 逃逸 ==')
const outside = c('read', { file_path: '/srv/notes/other/doc.md' })
ok(outside.kind === 'other' && outside.file === null && outside.dir === null,
  '目录外的读 → other，且不给 file / dir', show(outside))
ok(c('read', { file_path: `${MEM}-evil/project_alpha.md` }).kind === 'other',
  '前缀陷阱：<记忆目录>-evil 下的文件不算记忆')
ok(c('read', { file_path: `${MEM}-evil/project_alpha.md` }).file === null, '前缀陷阱里连 file 都不给')
ok(c('read', { file_path: '/srv/notes/memory2/x.md' }, '/srv/notes/mem').kind === 'other',
  '短目录名不做裸前缀匹配（/srv/notes/mem 不含 /srv/notes/memory2）')
ok(c('read', { file_path: `${MEM}/../secret.md` }).kind === 'other', '`..` 逃出记忆目录 → other')
ok(c('read', { file_path: `${MEM}/../../notes/memory/a.md` }).kind === 'active_read',
  '绕一圈又回到目录内 → 认（字面归一，不 stat）')

console.log('== 4. 分隔符与平台无关（规则只看形状，不看 path.sep）==')
const win = c('read', { file_path: 'C:\\Users\\someone\\memory\\user_beta.md' }, MEM_WIN)
ok(win.kind === 'active_read' && win.file === 'user_beta.md', 'Windows 形状（反斜杠）→ active_read', show(win))
const fwd = c('read', { file_path: 'C:/Users/someone/memory/user_beta.md' }, MEM_WIN)
const mixed = c('read', { file_path: 'C:\\Users\\someone\\memory/user_beta.md' }, MEM_WIN)
ok(fwd.kind === win.kind && fwd.file === win.file, '同一路径的正斜杠写法同判')
ok(mixed.kind === win.kind && mixed.file === win.file, '正反斜杠混写同判')
ok(c('read', { file_path: '/srv\\notes\\memory\\a.md' }, '/srv/notes/memory').kind === 'active_read',
  '记忆目录给正斜杠、目标给反斜杠 → 认（两边各自归一）')
ok(c('read', { file_path: 'C:\\Users\\someone\\memory-evil\\x.md' }, MEM_WIN).kind === 'other',
  'Windows 形状的前缀陷阱同样不过')
// 只换盘符大小写、其余逐字相同：验的是「盘符归一」这一条，不掺大小写敏感那条（下一条单独验）
ok(c('read', { file_path: 'c:/Users/someone/memory/x.md' }, MEM_WIN).kind === 'active_read',
  '盘符大小写归一（C: 与 c: 同义）')
ok(c('read', { file_path: '/srv/notes/Memory/a.md' }).kind === 'other',
  '盘符之外大小写敏感：Windows 上会漏记，这是有意的（宁可漏记不可误记）')
ok(c('read', { file_path: 'relative/a.md' }).kind === 'other', '相对路径不猜 cwd → other')
ok(c('read', { file_path: '\\memories\\a.md' }).kind === 'other',
  'Windows 当前盘根（单反斜杠开头）落点不确定 → other')

console.log('== 5. read 的参数边界：一律 other，绝不抛 ==')
const bad = [
  ['没有 file_path', {}],
  ['file_path 是空串', { file_path: '' }],
  ['file_path 是数字', { file_path: 42 }],
  ['file_path 是 null', { file_path: null }],
  ['file_path 是数组', { file_path: [`${MEM}/a.md`] }],
  ['file_path 是对象', { file_path: { path: `${MEM}/a.md` } }],
  ['目录内但不是 .md', { file_path: `${MEM}/notes.txt` }],
]
for (const [label, args] of bad) {
  const r = c('read', args)
  ok(r.kind === 'other' && r.file === null, `${label} → other`, show(r))
}
ok(c('read', undefined).kind === 'other', 'args 整个缺失（undefined）→ other')
ok(c('read', null).kind === 'other', 'args 是 null → other')
ok(c('read', 'not-an-object').kind === 'other', 'args 是字符串 → other')
ok(c('', { file_path: `${MEM}/a.md` }).kind === 'other', '工具名空串 → other')
ok(c(null, { file_path: `${MEM}/a.md` }).kind === 'other', '工具名 null → other')
// 显式传 undefined 必须绕开 c() 的默认参数 —— 否则测的是默认记忆目录，不是「记忆目录缺失」
ok(classifyToolExecution('read', { file_path: `${MEM}/a.md` }, undefined).kind === 'other', '记忆目录缺失 → other')
ok(c('read', { file_path: `${MEM}/a.md` }, 'memory').kind === 'other', '记忆目录是相对路径 → other')
const rootDir = c('read', { file_path: `${MEM}/a.md` }, '/')
ok(rootDir.kind === 'other' && rootDir.why.includes('根目录'), '记忆目录是文件系统根 → other（否则整块盘都算记忆）', show(rootDir))
ok(c('some_future_tool', { file_path: `${MEM}/a.md` }).kind === 'other', '不认得的工具不猜它的参数形状')
const hostile = { get file_path() { throw new Error('boom') } }
let hostileThrew = null
let hostileResult = null
try { hostileResult = c('read', hostile) } catch (err) { hostileThrew = err }
ok(hostileThrew === null && hostileResult !== null && hostileResult.kind === 'other',
  '参数对象的 getter 抛错 → 不抛，按 other 处理', hostileThrew ? hostileThrew.message : show(hostileResult))

console.log('== 6. grep / glob：目录判定 ==')
const gDir = c('grep', { pattern: '超时', path: MEM })
ok(gDir.kind === 'active_read' && gDir.dir === MEM && gDir.file === null, 'grep 搜记忆目录 → active_read + dir，无 file', show(gDir))
const gFile = c('grep', { pattern: 'FS_STALE_VERSION', path: `${MEM}/project_alpha.md` })
ok(gFile.kind === 'active_read' && gFile.file === 'project_alpha.md' && gFile.dir === null, 'grep 指定记忆文件 → 带 file', show(gFile))
const gSub = c('grep', { pattern: 'x', path: `${MEM}/archive` })
ok(gSub.kind === 'active_read' && gSub.dir === `${MEM}/archive`, 'grep 搜记忆目录下的子目录 → dir 是该子目录', show(gSub))
ok(c('grep', { pattern: 'x', path: '/srv/notes' }).kind === 'other', 'grep 搜记忆目录之外 → other')
ok(c('grep', { pattern: 'x', path: `${MEM}-evil` }).kind === 'other', 'grep 的前缀陷阱 → other')
ok(c('grep', { pattern: 'x' }).kind === 'other', 'grep 缺 path 时不拿 pattern 反推目录 → other')
const gExtra = c('grep', { pattern: 'x', path: MEM, include: '*.md', glob: '**' })
ok(gExtra.kind === 'active_read' && gExtra.dir === MEM, 'include / glob 这些过滤参数不影响目录判定')
const glDir = c('glob', { pattern: '*.md', path: MEM })
ok(glDir.kind === 'list_only' && glDir.dir === MEM, 'glob 列记忆目录 → list_only（不算读正文）', show(glDir))
ok(glDir.why.includes('不算读正文'), 'glob 的 why 明说不算读正文')
const glFile = c('glob', { pattern: '*', path: `${MEM}/a.md` })
ok(glFile.kind === 'list_only' && glFile.file === 'a.md', 'glob 的 path 指向 .md 文件 → 仍按 list_only（glob 读不到正文）', show(glFile))
ok(c('glob', { pattern: '*.md', path: `${MEM}-evil` }).kind === 'other', 'glob 的前缀陷阱 → other')
ok(c('glob', { pattern: '*.md' }).kind === 'other', 'glob 缺 path → other（pattern 里可能是 `**`，不猜）')
ok(c('glob', { pattern: 'x', path: '/srv/notes' }).kind === 'other', 'glob 列目录之外 → other')

console.log('== 7. write / edit：是写，不是读 ==')
const w = c('write', { file_path: `${MEM}/project_alpha.md` })
ok(w.kind === 'write' && w.file === 'project_alpha.md', 'write 记忆文件 → kind write + file', show(w))
ok(c('edit', { file_path: `${MEM}/project_alpha.md` }).kind === 'write', 'edit 记忆文件 → kind write（不是 active_read）')
const wOut = c('write', { file_path: '/tmp/out.md' })
ok(wOut.kind === 'write' && wOut.file === null, '目录外的写仍是 write，但不给 file（别处不许记成记忆）', show(wOut))
const wNone = c('write', {})
ok(wNone.kind === 'write' && wNone.file === null, 'write 参数缺失 → write + file null', show(wNone))
ok(c('edit', { file_path: 7 }).kind === 'write', 'edit 的 file_path 不是字符串 → 仍按 write，不抛')

console.log('== 8. 执行类工具：已知盲区，如实说看不见 ==')
for (const t of ['pwsh', 'bash', 'shell']) {
  const r = c(t, { command: `cat ${MEM}/project_alpha.md` })
  ok(r.kind === 'unobservable' && r.file === null && r.dir === null, `${t} 里的 cat 不被假装看见 → unobservable`, show(r))
}
ok(c('pwsh', { command: 'cat x' }).why.includes('盲区'), 'why 明说这是观测盲区，而不是「没有读取」')
ok(c('bash', {}).kind === 'unobservable', '参数缺失也照样 unobservable（结论与参数无关）')
ok(classifyToolExecution('pwsh', { command: 'cat x' }, undefined).kind === 'unobservable',
  '记忆目录不可判定时照样 unobservable（它与目录无关）')

console.log('== 9. 返回形状契约与「绝不抛」（含敌意输入）==')
const shapes = [
  ['read', { file_path: `${MEM}/a.md` }, MEM],
  ['read', { file_path: `${MEM}-evil/a.md` }, MEM],
  ['read', { file_path: 3 }, MEM],
  ['read', null, MEM],
  ['read', { file_path: '\u0000' }, MEM],
  ['grep', { path: 9 }, MEM],
  ['glob', { path: [] }, MEM],
  ['write', { file_path: `${MEM}/a.md` }, MEM],
  ['pwsh', { command: 'x' }, MEM],
  ['未知工具', {}, MEM],
  [undefined, undefined, undefined],
  [42, 42, 42],
  [null, [], null],
  ['read', { file_path: 'a\nb.md' }, MEM],
]
const shapeBad = []
let shapeThrew = null
for (const [t, a, d] of shapes) {
  try {
    const r = classifyToolExecution(t, a, d)
    const good = r && KINDS.includes(r.kind) && typeof r.why === 'string' && r.why !== '' &&
      'file' in r && 'dir' in r && (r.file === null || typeof r.file === 'string') && (r.dir === null || typeof r.dir === 'string')
    if (!good) shapeBad.push(show(r))
  } catch (err) {
    shapeThrew = err
  }
}
ok(shapeBad.length === 0, '所有输入的返回都是 {kind∈枚举, file, dir, why 非空}', shapeBad.join(' | '))
ok(shapeThrew === null, '敌意输入一个都不抛', shapeThrew ? shapeThrew.message : '')
const det1 = c('read', { file_path: `${MEM}/project_alpha.md` })
const det2 = c('read', { file_path: `${MEM}/project_alpha.md` })
ok(show(det1) === show(det2), '同一输入两次调用结果完全一致（确定性：不看时钟、不读盘）')

console.log('== 10. 去重键：翻页不刷计数、换 revision 重新计 ==')
const base = { sessionId: 'sess-1', file: 'project_alpha.md', revision: 'rev-a', kind: 'active_read' }
const k1 = accessEventKey(base)
ok(typeof k1 === 'string' && k1 !== '', '四元组给出非空字符串键')
ok(k1 === accessEventKey({ ...base }), '同四元组同键')
ok(k1 !== accessEventKey({ ...base, revision: 'rev-b' }), 'revision 变了 → 键不同')
ok(k1 !== accessEventKey({ ...base, sessionId: 'sess-2' }), 'session 变了 → 键不同')
ok(k1 !== accessEventKey({ ...base, file: 'other.md' }), '文件变了 → 键不同')
ok(k1 !== accessEventKey({ ...base, kind: 'write' }), 'kind 变了 → 键不同')
ok(accessEventKey({ ...base, file: '' }) === null, '没有文件 → null（不该记）')
ok(accessEventKey({ ...base, kind: 'other' }) === null, 'other 不是访问事件 → null')
ok(accessEventKey({ ...base, kind: 'list_only' }) === null, 'list_only 没有文件键 → null')
ok(accessEventKey() === null && accessEventKey(null) === null && accessEventKey(42) === null,
  '参数缺失 / null / 数字都不抛，返回 null')
const p1 = c('read', { file_path: `${MEM}/a.md`, offset: 0, limit: 40 })
const p2 = c('read', { file_path: `${MEM}/a.md`, offset: 40, limit: 40 })
const pk1 = accessEventKey({ sessionId: 'sess-1', file: p1.file, revision: 'rev-a', kind: p1.kind })
const pk2 = accessEventKey({ sessionId: 'sess-1', file: p2.file, revision: 'rev-a', kind: p2.kind })
ok(p1.kind === p2.kind && p1.file === p2.file, '翻页两次的判定结果本身相同')
ok(pk1 !== null && pk1 === pk2, '翻页（offset / limit 不同）不刷计数：键相同', `${pk1} vs ${pk2}`)
const slashName = c('read', { file_path: `${MEM}/a.md` }).file
const backslashName = c('read', { file_path: '/srv\\notes\\memory\\a.md' }).file
ok(accessEventKey({ ...base, file: slashName }) === accessEventKey({ ...base, file: backslashName }),
  '分隔符写法不同、同一个文件 → 同一个键（同一动作不许记两次）')
ok(accessEventKey({ sessionId: undefined, file: 'a.md', revision: 'r', kind: 'active_read' }) !== null,
  '缺 sessionId 仍给键（退化成整个进程一个去重域）')

console.log('== 11. createDeduper：首次 true、重复 false ==')
const ded = createDeduper()
ok(ded.shouldCount(k1) === true, '首次 → true')
ok(ded.shouldCount(k1) === false, '同一键再来 → false')
ok(ded.size === 1, 'size = 已记的不同键数', String(ded.size))
const k2 = accessEventKey({ ...base, revision: 'rev-b' })
ok(ded.shouldCount(k2) === true && ded.size === 2, '换 revision 是新的一个', String(ded.size))
ok(ded.shouldCount(null) === false && ded.shouldCount(undefined) === false && ded.shouldCount('') === false,
  'null / undefined / 空串一律不记')
ok(ded.size === 2, '不该记的键不占位', String(ded.size))
ded.clear()
ok(ded.size === 0 && ded.shouldCount(k1) === true, 'clear 之后 size 归零且可以重新计')

console.log('== 12. 边界写进注释与实现（源码级断言）==')
const src = await readFile(new URL('../lib/memory/observe.js', import.meta.url), 'utf8')
ok(!/node:fs/.test(src), '模块不 import node:fs（不读盘，也就不可能拿 atime 当证据）')
ok(!/from 'node:path'/.test(src), '不从 node:path 取平台相关的路径语义')
ok(!/Date\.now|performance\.now/.test(src), '模块不看时钟（纯函数）')
ok(/atime/.test(src), '「atime 永远不许当证据」写进了注释')
ok(/pwsh/.test(src) && /盲区/.test(src), 'pwsh 的观测盲区写进了注释与 why')

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
