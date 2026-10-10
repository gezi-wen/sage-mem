/**
 * 「锁定」—— 让一条记忆拒绝归档。
 *
 * 为什么用**状态文件**而不是写进记忆自己的 frontmatter：
 *   1. frontmatter 是用户的正文，而「自动做梦」会重写它 —— 锁写在里面可能被整理过程擦掉，
 *      而锁一旦丢失，那条记忆就会重新进入自动归档候选（**正是这个功能要防的事**）
 *   2. 状态根 `.sage-mem/` 已经是访问台账、快照、回滚点的家，锁放同一层语义一致
 * 代价要说清楚：锁不在记忆文件里，**跟着文件单独拷贝时不会跟走**。别把它当文件属性。
 *
 * 锁表按 `nameKey()` 归一存放：NTFS 不区分大小写，`User_Persona.MD` 与 `user_persona.md`
 * 是同一个文件 —— 锁必须认得出这一点（与保留名保护同一套判据）。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { nameKey } from './naming.js'
import { writeFileAtomic } from './util.js'

/** 锁表文件：状态根下，与记忆文件分开。 */
export function lockFileOf(memoryDir) {
  return join(dirname(memoryDir), '.sage-mem', 'locked.json')
}

/**
 * 读锁表。读不到 / JSON 坏 / 不是对象 / 值不是 `true` → 一律当空表。
 * **绝不抛**：锁表坏了最坏是「锁没生效」，不该升级成「读不了记忆」。
 */
export async function readLockSet(memoryDir) {
  try {
    const parsed = JSON.parse(await readFile(lockFileOf(memoryDir), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set()
    const out = new Set()
    for (const [k, v] of Object.entries(parsed)) {
      if (v === true) out.add(nameKey(k))
    }
    return out
  } catch {
    return new Set()
  }
}

/** 这条记忆锁上了吗。 */
export async function isLocked(memoryDir, name) {
  return (await readLockSet(memoryDir)).has(nameKey(name))
}

/**
 * 上锁 / 解锁。
 *
 * 读-改-写：两张并发的锁操作理论上会互相覆盖（丢一次锁）。这里**不引入锁**：
 * 代价是「同时锁两条记忆时可能少一条」，而这远轻于给一个状态文件加一套锁 ——
 * 重按一次就好，用户看得见结果。
 */
export async function setLocked(memoryDir, name, locked) {
  const key = nameKey(name)
  const file = lockFileOf(memoryDir)
  let table = {}
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) table = parsed
  } catch {
    table = {}
  }
  if (locked) table[key] = true
  else delete table[key]
  await mkdir(dirname(file), { recursive: true })
  await writeFileAtomic(file, JSON.stringify(table, null, 2) + '\n')
  return { ok: true, file: name, locked: !!locked }
}
