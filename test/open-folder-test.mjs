/**
 * open-folder-test.mjs — 「打开记忆文件夹」host 侧的断言。
 *
 * 三组：
 *   1. 平台 → 命令映射（win32 / darwin / 其它），路径原样进 args，不拼 shell；
 *   2. spawn 接线：detached + stdio ignore、**不许 windowsHide**（1.7.0：它会藏掉 explorer 的窗口），
 *      必须 unref（不等窗口退出）；
 *   3. 失败路径：目录为空、spawn 同步抛错 → { ok:false, error }，不抛。
 */
import { folderOpenCommand, openMemoryFolder } from '../lib/memory/open-folder.js'

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

console.log('== 1. 平台 → 命令映射 ==')
{
  const win = folderOpenCommand('win32', 'C:\\Users\\me\\.sage-mem\\memory')
  ok(win.command === 'explorer.exe', 'Windows 用 explorer.exe')
  ok(win.args.length === 1 && win.args[0] === 'C:\\Users\\me\\.sage-mem\\memory', 'Windows 路径原样作为一个 argv')
  ok(!win.args.join(' ').includes('&'), '不拼 shell 元字符')

  const mac = folderOpenCommand('darwin', '/Users/me/.sage-mem/memory')
  ok(mac.command === 'open' && mac.args[0] === '/Users/me/.sage-mem/memory', 'macOS 用 open')

  const linux = folderOpenCommand('linux', '/home/me/.sage-mem/memory')
  ok(linux.command === 'xdg-open' && linux.args[0] === '/home/me/.sage-mem/memory', 'Linux 用 xdg-open')

  let threw = false
  try { folderOpenCommand('linux', '') } catch { threw = true }
  ok(threw, '空目录直接抛（由 openMemoryFolder 转成 { ok:false }）')
}

console.log('\n== 2. spawn 接线 ==')
{
  const calls = []
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options })
    return {
      onCalls: [],
      unrefCalls: 0,
      on(name) { this.onCalls.push(name) },
      unref() { this.unrefCalls++ },
    }
  }
  const result = openMemoryFolder('C:\\mem', { platform: 'win32', spawn: fakeSpawn })
  ok(result.ok === true, '返回 { ok:true }')
  ok(calls.length === 1, '只 spawn 一次')
  ok(calls[0].command === 'explorer.exe' && calls[0].args[0] === 'C:\\mem', '命令与参数正确')
  ok(calls[0].options.detached === true, 'detached：不随宿主退出')
  ok(calls[0].options.stdio === 'ignore', '不持有 stdio')
  // ⚠️ 这里**必须是「不许传 windowsHide」**（1.7.0 修的真 bug，2026-10-24 A/B 实测）：
  // windowsHide 在 Windows 上映射 CREATE_NO_WINDOW，explorer.exe 会启动成功、退出码也正常，
  // 但文件夹窗口被藏起来 —— 用户看到的就是「点了没反应」。原来这条断言写的是
  // `windowsHide === true`（注释「Windows 不闪窗」），等于把这个 bug 钉成了正确行为。
  ok(calls[0].options.windowsHide !== true, 'win32 不传 windowsHide（传了 explorer 的窗口会被藏起来）')
  ok(calls[0].options.shell === undefined, '不经过 shell（避免路径注入）')
}

console.log('\n== 3. 失败路径 ==')
{
  const empty = openMemoryFolder('', { platform: 'linux', spawn: () => ({ unref() {} }) })
  ok(empty.ok === false && /unknown/.test(empty.error), '空目录 → { ok:false, error }')

  const throwing = openMemoryFolder('/mem', {
    platform: 'linux',
    spawn: () => { throw new Error('EACCES') },
  })
  ok(throwing.ok === false && /EACCES/.test(throwing.error), 'spawn 同步抛错 → 转成 ok:false，不冒泡')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
