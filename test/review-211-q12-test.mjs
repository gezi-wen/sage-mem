#!/usr/bin/env node
/**
 * review-211-q12-test.mjs — 外部审查 Q12 的回归（2.1.15）
 *
 * 问题：长任务 ID 的检查点句柄**给出一个不存在的路径**。
 *   句柄内容超过 160 字节时，旧退化逻辑保留头部 ID，却把路径从
 *   `tasks/<id>/WORKING.md` 改成 `tasks/WORKING.md` —— 真实文件布局里没有后者。
 *   句柄因此「短了、也含 ID」，却不再是准确的读取指令。
 *
 * 为什么旧断言没抓到：它只检查「≤160 字节 + 包含 id + 包含 WORKING.md」。
 * 这三条对 `读 tasks/WORKING.md` 全部成立。所以本套件的断言是：
 *   **把句柄按同一解析规则解析回身份，再用这个身份去定位真实文件** ——
 *   解析失败、或解析出的路径不是刚写下的那个文件，都算红。
 *
 * 反向对照：
 *   · 旧的那种 `tasks/WORKING.md` 句柄必须解析失败（判据不是"任何字符串都过"）；
 *   · 合法 id / 非法 id 各验一遍（非法 id 不该给出句柄，也就无从定位）。
 *
 * 用法: node test/review-211-q12-test.mjs
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as checkpoint from '../lib/memory/checkpoint.js'

const { checkpointHandleText, checkpointPathFor, readCheckpoint, renderCheckpoint, writeCheckpoint } = checkpoint
/**
 * 2.1.15 新增的解析器。旧代码里没有它 → 回落到「永远解析不出身份」，
 * 这样修前跑出来的是**一条条失败的断言**（句柄定位不到文件），而不是 import 就炸。
 */
const parseCheckpointHandle = checkpoint.parseCheckpointHandle ?? (() => null)

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
const bytes = (s) => Buffer.byteLength(s, 'utf8')

const root = await mkdtemp(join(tmpdir(), 'sage-mem-q12-'))

/**
 * 写一份真实检查点，再走「句柄 → 解析 → 定位 → 读回」这条完整链路。
 * @returns {Promise<{handle:string, located:string|null, resolved:object|null, reread:object|null}>}
 */
async function roundTrip({ taskId, revision, project }) {
  const stateRoot = join(root, `state-${String(revision)}-${taskId.length}`)
  const written = await writeCheckpoint(
    taskId,
    renderCheckpoint({ taskId, project, revision, goal: '合成夹具目标', todo: ['做 B'] }),
    { stateRoot },
  )
  const handle = checkpointHandleText({ taskId, revision, project })
  const resolved = parseCheckpointHandle(handle)
  // 「同一解析规则定位真实文件」：解析出的 id 走**专用路径函数**，必须等于刚写下的路径。
  const located = resolved ? checkpointPathFor(resolved.taskId, stateRoot) : null
  const onDisk = located ? await stat(located).then(() => true, () => false) : false
  const reread = resolved ? await readCheckpoint(resolved.taskId, { stateRoot }) : null
  return { handle, resolved, writtenPath: written.ok ? written.path : null, located, onDisk, reread, stateRoot }
}

group('1. 最大长度 ID（64 字符）+ 中文项目名：句柄仍能定位真实文件')
{
  const taskId = 'a'.repeat(64)
  const project = '一个很长的中文项目名'.repeat(10)
  const r = await roundTrip({ taskId, revision: 1, project })

  ok(bytes(r.handle) <= 160, `句柄 ≤ 160 字节（实际 ${bytes(r.handle)}）`, r.handle)
  ok(!r.handle.includes('\n'), '句柄是一行（注入时不会被拆行）')
  // 这句是 Q12 的核心：退化时**不许**把 id 目录从路径里丢掉。
  ok(r.handle.includes(`tasks/${taskId}/WORKING.md`), '保留完整可解析路径 tasks/<id>/WORKING.md', r.handle)
  ok(!r.handle.includes('tasks/WORKING.md'), '不再出现不存在的退化路径 tasks/WORKING.md', r.handle)
  ok(r.handle.includes('状态根下'), '相对路径说明了基准是状态根（STATE_ROOT）', r.handle)
  ok(r.handle.split(taskId).length - 1 === 1, '身份只表达一次：id 在句柄里只出现一次', r.handle)
  ok(!r.handle.includes('\uFFFD'), '没有把多字节字符切成半个')

  ok(r.resolved !== null, '句柄能被同一解析规则解析回身份', r.handle)
  ok(r.resolved?.taskId === taskId, '解析出的 taskId 与写下去的一致', JSON.stringify(r.resolved))
  ok(r.resolved?.revision === 1, '解析出的 revision 与写下去的一致', JSON.stringify(r.resolved))
  ok(r.located === r.writtenPath, '解析出的身份定位到「刚写下的那个文件」', `${r.located} vs ${r.writtenPath}`)
  ok(r.onDisk === true, '文件在该路径上真实存在')
  ok(r.reread?.ok === true && r.reread?.revision === 1, '用解析出的身份读回了正确 revision', JSON.stringify(r.reread?.ok))
}

group('2. 短 id + 中文项目名（句柄放得下项目时）：同样可定位')
{
  const taskId = 'task-cn-project-01'
  const project = '合成夹具项目'
  const r = await roundTrip({ taskId, revision: 3, project })

  ok(bytes(r.handle) <= 160, `句柄 ≤ 160 字节（实际 ${bytes(r.handle)}）`, r.handle)
  ok(r.handle.includes(`tasks/${taskId}/WORKING.md`), '路径完整', r.handle)
  ok(r.handle.includes(project), '预算够时保留项目名（展示线索，不影响解析）', r.handle)
  ok(r.resolved?.taskId === taskId && r.resolved?.revision === 3, '解析回的身份正确', JSON.stringify(r.resolved))
  ok(r.located === r.writtenPath && r.onDisk, '解析出的身份定位到真实文件', `${r.located}`)
  ok(r.reread?.ok === true, '读回成功')
}

group('3. 较长 revision：数字不能被截断，解析后仍要定位到同一文件')
{
  const taskId = 't'.repeat(32)
  const revision = 987654321012
  const r = await roundTrip({ taskId, revision, project: '长 revision 的项目' })

  ok(bytes(r.handle) <= 160, `句柄 ≤ 160 字节（实际 ${bytes(r.handle)}）`, r.handle)
  ok(r.handle.includes(`revision ${revision}`), 'revision 完整出现在句柄里', r.handle)
  ok(r.resolved?.revision === revision, '解析回同一个 revision', JSON.stringify(r.resolved))
  ok(r.located === r.writtenPath && r.onDisk, '解析出的身份定位到真实文件', `${r.located}`)
  ok(r.reread?.revision === revision, '读回同一份 revision')
}

group('4. 反向对照：旧句柄（不存在的路径）与非法输入必须解析失败')
{
  const legacy = '检查点 aaaa（revision 1）：读 tasks/WORKING.md'
  ok(parseCheckpointHandle(legacy) === null, '旧退化句柄解析失败（判据不是「任何字符串都过」）', legacy)
  // 缺基准标记的裸相对路径是歧义的，不能猜。
  const noBase = `检查点 revision 1：tasks/${'b'.repeat(8)}/WORKING.md`
  ok(parseCheckpointHandle(noBase) === null, '没有「状态根下」基准标记 → 解析失败（歧义不猜）', noBase)
  ok(parseCheckpointHandle('') === null && parseCheckpointHandle(null) === null && parseCheckpointHandle(undefined) === null,
    '空 / 非字符串输入返回 null，不抛')
  // 非法 id：没有身份就不给句柄。
  ok(checkpointHandleText({ taskId: '../x', revision: 1 }) === '', '非法 id（路径穿越）→ 空句柄')
  ok(checkpointHandleText({ taskId: 'a'.repeat(65), revision: 1 }) === '', '超过 64 字符的 id → 空句柄')
  ok(checkpointHandleText({}) === '' && checkpointHandleText() === '', '缺 taskId 返回空串，不抛')
}

await rm(root, { recursive: true, force: true })

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
