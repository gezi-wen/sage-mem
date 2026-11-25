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
 *
 * ── 2.1.12（外部审查 Q05）──────────────────────────────────────────────
 * 旧实现两处硬伤，都已修：
 *   1. 整文件 read-modify-write **没有排队**：两个并发上锁各自读到旧表，后写的把先写的
 *      盖掉，而两边都报成功。原子 rename 只保证「不写半截」，不负责「合并两处修改」。
 *      现在按锁表路径分键复用 `util.js` 的 `createWriteQueue()` 串行 RMW。
 *   2. 读任何异常都返回空 Set —— 「保护状态未知」与「确实没有锁」因此无法区分，
 *      自动归档会把**受保护**的记忆当成没锁继续删。现在只有 ENOENT 算「确实没有锁」；
 *      坏 JSON / 权限失败 / 路径是目录……一律 `status:'unknown'`，危险操作据此暂停。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { nameKey } from './naming.js'
import { resolveStateRoot } from './config.js'
import { createWriteQueue, writeFileAtomic } from './util.js'
import { createFileLease } from '../shared/file-lease.js'

/**
 * 锁表文件：状态根下，与记忆文件分开。
 *
 * ⚠️ Q09：状态根必须经 `config.js` 的 `resolveStateRoot()` 解析（尊重 `SAGE_MEM_STATE_DIR`），
 * 不许在这里 `dirname(memoryDir)` + 拼 `.sage-mem` —— 旧写法让「状态目录覆写」只对一部分
 * 模块生效，于是面板读的锁表与引擎写的是两份。装配期显式给了 `stateRoot` 就用它。
 */
export function lockFileOf(memoryDir, stateRoot) {
  const root = typeof stateRoot === 'string' && stateRoot !== '' ? stateRoot : resolveStateRoot(memoryDir)
  return join(root, 'locked.json')
}

/** 状态文件的短租约：临界区只含一份小 JSON 的读改写。 */
const STATE_LEASE_STALE_MS = 5000
const STATE_LEASE_WAIT_MS = 2000

function stateLeaseFor(memoryDir) {
  return createFileLease({
    lockPath: join(dirname(lockFileOf(memoryDir)), 'write.lock'),
    staleMs: STATE_LEASE_STALE_MS,
    waitMs: STATE_LEASE_WAIT_MS,
    meta: () => ({ purpose: 'locked-json' }),
  })
}

/**
 * 锁表的**进程内串行队列**，按锁表路径分键（不同记忆目录互不阻塞）。
 * 跨进程互斥由 `stateLeaseFor()` 的短租约负责；队列只减少本进程内无谓争抢。
 */
const lockQueues = new Map()
function lockQueueFor(file) {
  let queue = lockQueues.get(file)
  if (!queue) {
    queue = createWriteQueue()
    lockQueues.set(file, queue)
  }
  return queue
}

/**
 * 读锁表**原始对象**，区分「确实没有」与「不知道」。
 *
 * @returns {Promise<{status:'ok'|'missing'|'unknown', table:object, reason:string}>}
 */
async function readLockTable(memoryDir) {
  let text
  try {
    text = await readFile(lockFileOf(memoryDir), 'utf8')
  } catch (err) {
    // 只有 ENOENT 可以当空表：文件不存在 = 一次锁都没上过。
    if (err?.code === 'ENOENT') return { status: 'missing', table: {}, reason: '' }
    return { status: 'unknown', table: {}, reason: `读锁表失败（${err?.code || err?.message}）` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { status: 'unknown', table: {}, reason: `锁表不是合法 JSON（${err?.message ?? err}）` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unknown', table: {}, reason: '锁表不是 JSON 对象' }
  }
  return { status: 'ok', table: parsed, reason: '' }
}

/**
 * 读锁状态 —— **安全路径唯一该用的读口**。
 *
 *   - `{status:'ok', locked:Set}`：读到有效表（可能为空）
 *   - `{status:'missing', locked:Set()}`：锁表不存在 = 确实没有锁
 *   - `{status:'unknown', locked:Set(), reason}`：保护状态**未知**，自动归档必须暂停
 *
 * ⚠️ `unknown` 时返回的 `locked` 是**空集合**，但它不表示「没有锁」；调用方必须先看
 * `status`，拿它当空表用就是把 Q05 原样放回去。
 */
export async function readLockState(memoryDir) {
  const read = await readLockTable(memoryDir)
  if (read.status === 'unknown') return { status: 'unknown', locked: new Set(), reason: read.reason }
  const out = new Set()
  for (const [k, v] of Object.entries(read.table)) {
    if (v === true) out.add(nameKey(k))
  }
  return { status: read.status, locked: out, reason: '' }
}

/**
 * 兼容出口：只要集合的调用方用这个。
 *
 * 与 `readLockState` 的差别只有一条：`unknown` 时**抛** `LOCK_TABLE_UNKNOWN`，而不是
 * 返回空 Set —— 返回空 Set 正是「坏表当全解锁」这个 bug 的入口。缺文件仍返回空 Set。
 */
export async function readLockSet(memoryDir) {
  const state = await readLockState(memoryDir)
  if (state.status === 'unknown') {
    throw Object.assign(new Error(`sage-mem: ${state.reason}`), { code: 'LOCK_TABLE_UNKNOWN', reason: state.reason })
  }
  return state.locked
}

/** 这条记忆锁上了吗。`unknown` 时抛错（调用方不能把「不知道」当成「没锁」）。 */
export async function isLocked(memoryDir, name) {
  return (await readLockSet(memoryDir)).has(nameKey(name))
}

/**
 * 上锁 / 解锁。
 *
 * 读最新表 → 改一项 → 原子写回，整段放进按路径分键的进程内队列，并由状态根
 * `<stateRoot>/write.lock` 的短租约串行到**跨进程**。锁表损坏时 fail-closed。
 */
export async function setLocked(memoryDir, name, locked) {
  const key = nameKey(name)
  const file = lockFileOf(memoryDir)
  return lockQueueFor(file)(async () => {
    const lease = stateLeaseFor(memoryDir)
    const got = await lease.acquire()
    if (!got.ok) {
      return {
        ok: false,
        code: got.code === 'lock_busy' ? 'lock_busy' : 'lock_io',
        error: `sage-mem: 无法取得状态写租约（${got.reason ?? got.code}），本次没有写入：${name}`,
      }
    }
    try {
      const read = await readLockTable(memoryDir)
      if (read.status === 'unknown') {
        return {
          ok: false,
          code: 'lock_table_unknown',
          error: `sage-mem: 锁表不可读（${read.reason}），本次没有写入，也不会把它重置成空表：${name}`,
        }
      }
      const table = { ...read.table }
      if (locked) table[key] = true
      else delete table[key]
      await writeFileAtomic(file, JSON.stringify(table, null, 2) + '\n')
      return { ok: true, file: name, locked: !!locked }
    } finally {
      const released = await lease.release(got.token)
      if (!released.ok) console.warn(`sage-mem: 释放锁表写租约失败（${released.reason ?? released.code}）`)
    }
  })
}
