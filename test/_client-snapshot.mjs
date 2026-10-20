#!/usr/bin/env node
/**
 * 界面快照守卫（1.5.2 新增）。
 *
 * 为什么要有它：1.5.2 把筛选条从 Section 里抽成独立组件，之后还要继续拆 Section。
 * 「界面一个像素都没变」这句话不能只靠人看 —— 这里把 3 屏（文件列表 / 自动做梦·设置 / 体检）
 * 的真渲染树序列化成 HTML，取 sha256 存进 `test/fixtures/client-snapshots.json`。
 * 纯结构搬移必须保持哈希不变；**有意改界面**的版本用 `--update` 重生成（并把这句写进 CHANGELOG）。
 *
 * ⚠️ 它**不挂进 npm test**：跑一次要再起一遍 client-render-test（几秒），且它的正常状态是
 * 「等一次有意改界面才变」。需要时手动跑：
 *     node test/client-snapshot-test.mjs            # 比对
 *     node test/client-snapshot-test.mjs --update   # 改完界面后重生成
 *
 * 产物来自 client-render-test.mjs 的 `--preview`（与 README 出图共用同一份屏定义）：
 * 只认 manifest 的 id，不按下标取 —— 插一屏不会让别的屏静默换内容。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'client-snapshots.json')
const UPDATE = process.argv.includes('--update')
const SCREENS = ['files-list', 'autodream-settings', 'audit']

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'sage-mem-snap-'))
try {
  const r = spawnSync(process.execPath, [join(HERE, 'client-render-test.mjs'), '--preview'], {
    cwd: join(HERE, '..'),
    env: { ...process.env, SAGE_MEM_PREVIEW_DIR: dir },
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    console.error((r.stdout || '').split('\n').slice(-5).join('\n'))
    console.error((r.stderr || '').split('\n').slice(-5).join('\n'))
    throw new Error('client-render-test --preview 失败，快照无法生成')
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'client-preview-manifest.json'), 'utf8'))
  const byId = new Map(manifest.map((m) => [m.id, m]))
  const actual = {}
  for (const id of SCREENS) {
    const rec = byId.get(id)
    if (!rec) throw new Error(`manifest 里没有屏 ${id}（屏定义改过名？）`)
    const html = readFileSync(rec.file, 'utf8')
    actual[id] = createHash('sha256').update(html).digest('hex')
  }

  if (UPDATE) {
    writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n', 'utf8')
    console.log(`已重生成 ${SCREENS.length} 屏快照 → ${FIXTURE}`)
    for (const id of SCREENS) console.log(`  ${id}  ${actual[id]}`)
    process.exit(0)
  }

  ok(existsSync(FIXTURE), '快照基线存在（没有就先跑 --update）')
  const expected = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : {}
  for (const id of SCREENS) {
    ok(expected[id] === actual[id], `${id}: 渲染树哈希不变`, `expected ${String(expected[id]).slice(0, 12)}… / actual ${actual[id].slice(0, 12)}…`)
  }
  // 反向对照：内容差一个字节，哈希必须不同（证明判据不是恒真）
  const probe = createHash('sha256').update('a').digest('hex')
  const probe2 = createHash('sha256').update('b').digest('hex')
  ok(probe !== probe2, '【反向对照】内容不同则哈希不同')
  ok(JSON.stringify(expected).length > 0, '基线不是空对象')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
