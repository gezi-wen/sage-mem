#!/usr/bin/env node
/**
 * 跨进程状态写租约（2.20.0）。
 *
 * 用真实 `fork` 子进程，而不是 Promise.all：进程内队列只能证明同一进程内不覆盖，
 * 证明不了两个 DSH 实例同时写同一个状态根。
 *
 * 断言汇总行格式必须与 `test/run.mjs` 一致：`结果：N passed, M failed`。
 */

import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
let pass = 0
let fail = 0
function ok(cond, label, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  PASS ${label}${extra ? `（${extra}）` : ''}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}${extra ? `（${extra}）` : ''}`)
  }
}
function group(name) {
  console.log(`\n── ${name} ──`)
}

async function workerMain(mode, dir, arg) {
  const access = await import('../lib/memory/access.js')
  const lock = await import('../lib/memory/lock.js')
  process.send?.({ ready: true })
  await new Promise((resolve) => process.once('message', resolve))

  if (mode === 'locked') {
    for (let i = 0; i < 60; i += 1) {
      const r = await lock.setLocked(dir, `w${arg}-${i}.md`, true)
      if (!r.ok) throw new Error(`setLocked failed: ${JSON.stringify(r)}`)
    }
    process.send?.({ done: 60 })
  } else if (mode === 'access') {
    const names = Array.from({ length: 30 }, (_, i) => `w${arg}-${i}.md`)
    for (let round = 0; round < 5; round += 1) {
      access.recordAccess(names, Date.now() + round)
      const r = await access.flushAccess(dir)
      if (!r.ok) throw new Error(`flushAccess failed: ${JSON.stringify(r)}`)
    }
    process.send?.({ done: 30 })
  } else if (mode === 'lease') {
    const { createFileLease } = await import('../lib/shared/file-lease.js')
    // 初始锁已由父进程 utimes 老化；活锁必须明显长于 worker 的 500ms 持有时间。
    const lease = createFileLease({ lockPath: arg, staleMs: 10_000, waitMs: 0 })
    const r = await lease.acquire()
    process.send?.({ won: r.ok })
    // 等父进程确认「所有竞争者都试过了」再释放。固定 sleep 不够：
    // 机器慢时后到者可能在放锁之后才起跑，测出来就成了串行。
    if (r.ok) {
      await new Promise((resolve) => process.once('message', resolve))
      await lease.release(r.token)
    }
  }
}

async function spawnAndRun(mode, count, dir, arg) {
  const children = []
  for (let i = 0; i < count; i += 1) {
    const child = fork(SELF, ['--worker', mode, dir, String(i), ...(arg ? [arg] : [])], {
      // 子进程不要继承父进程的 stdout：父进程在 npm test / spawnSync 里时，
      // 那条管道被多个子进程共享会丢输出；结果一律走 IPC 回传。
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, SAGE_MEM_DEBUG: '' },
    })
    child._stderr = ''
    child.stderr?.on('data', (buf) => { child._stderr += String(buf) })
    children.push(child)
  }
  const ready = []
  const done = []
  for (const [i, child] of children.entries()) {
    await new Promise((resolve, reject) => {
      child.once('message', (m) => {
        if (m.ready) resolve()
        else reject(new Error(`unexpected first message: ${JSON.stringify(m)}`))
      })
      child.once('error', reject)
      ready[i] = true
    })
  }
  // 先挂好结果监听，再统一发令。反过来会输给「响应极快的 child」：
  // 它的 done 消息可能在没有 listener 时到达，随后双方都静默退出。
  const results = children.map((child) => new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('exit', (code) => {
      reject(new Error(code === 0
        ? 'worker exited without result'
        : `worker exited ${code}: ${child._stderr ?? ''}`))
    })
  }))
  for (const child of children) child.send({ go: true })
  for (const m of await Promise.all(results)) done.push(m)
  if (mode === 'lease') for (const child of children) child.send({ release: true })
  return done
}

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'sage-mem-xproc-'))
  const state = join(base, 'state')
  await mkdir(state, { recursive: true })
  process.env.SAGE_MEM_STATE_DIR = state

  group('1. 两个进程同时锁不同文件：锁表并集不丢')
  {
    const mem = join(base, 'mem-locked')
    await mkdir(mem, { recursive: true })
    const done = await spawnAndRun('locked', 2, mem)
    ok(done.every((d) => d.done === 60), '两个 worker 各完成 60 次上锁')
    const { readLockState } = await import('../lib/memory/lock.js')
    const st = await readLockState(mem)
    ok(st.status === 'ok', '锁表可读')
    ok(st.status === 'ok' && st.locked.size === 120, '120 条锁一条不少', st.status === 'ok' ? `${st.locked.size}` : st.reason)
  }

  group('2. 两个进程同时刷不同记忆的台账：时间戳不互相覆盖')
  {
    const mem = join(base, 'mem-access')
    await mkdir(mem, { recursive: true })
    for (let w = 0; w < 2; w += 1) {
      for (let i = 0; i < 30; i += 1) {
        await writeFile(join(mem, `w${w}-${i}.md`), '---\ntype: project\ndescription: x\n---\nbody\n')
      }
    }
    const done = await spawnAndRun('access', 2, mem)
    ok(done.every((d) => d.done === 30), '两个 worker 各刷 30 个键')
    const { flushAccess, readAccessLedger, ledgerFileFor } = await import('../lib/memory/access.js')
    await flushAccess(mem)
    const ledger = await readAccessLedger(ledgerFileFor(mem))
    ok(Object.keys(ledger).length === 60, '台账里 60 个键都在', `${Object.keys(ledger).length}`)
  }

  group('3. 抢同一把过期锁：多进程竞争只有一个赢家')
  {
    const lockPath = join(base, 'one.lock')
    await writeFile(lockPath, JSON.stringify({ token: 'old', at: 1 }))
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)
    const done = await spawnAndRun('lease', 4, base, lockPath)
    const winners = done.filter((d) => d.won).length
    ok(winners === 1, '四个进程恰好一个抢到', `${winners}`)
  }

  group('4. 共享租约：活锁不被第二个进程抢走，释放后可复得')
  {
    const lockPath = join(base, 'live.lock')
    const { createFileLease } = await import('../lib/shared/file-lease.js')
    const a = createFileLease({ lockPath, staleMs: 10_000, waitMs: 0 })
    const b = createFileLease({ lockPath, staleMs: 10_000, waitMs: 0 })
    const gotA = await a.acquire()
    ok(gotA.ok, 'A 拿到锁')
    const gotB = await b.acquire()
    ok(!gotB.ok && gotB.code === 'lock_busy', 'B 被拒绝', gotB.code)
    await a.release(gotA.token)
    const gotB2 = await b.acquire()
    ok(gotB2.ok, 'A 释放后 B 可拿到')
    if (gotB2.ok) await b.release(gotB2.token)
  }

  console.log(`\n结果：${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}

if (process.argv[2] === '--worker') {
  // locked/access 的 arg 是 worker 序号；lease 多带一个序号后再跟锁路径。
  workerMain(process.argv[3], process.argv[4], process.argv[6] ?? process.argv[5]).catch((err) => {
    console.error(err)
    process.exit(1)
  })
} else {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
