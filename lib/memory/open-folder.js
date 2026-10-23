/**
 * 打开记忆目录（设置页「打开记忆文件夹」按钮的 host 侧实现）。
 *
 * 为什么放在 host 侧：浏览器不能起进程；而 DSH 的 `open-in-app` 路由属于界面内部接口，
 * 老版本 DSH 不一定有。这里只依赖 `node:child_process`，三条命令覆盖三个平台：
 *   - Windows  → `explorer.exe <dir>`
 *   - macOS    → `open <dir>`
 *   - 其它     → `xdg-open <dir>`
 *
 * 进程是**一次性、detached** 的：不等待退出（Explorer / Finder 是常驻进程，等它等于
 * 永不返回），也不持有 stdio。这条路径不改变插件「无 worker / 无端口 / 无常驻进程」的性质。
 *
 * ⚠️ **绝对不要传 `windowsHide: true`**（2026-10-24 实测，A/B 对照）：它在 Windows 上
 * 映射成 CREATE_NO_WINDOW，而 `explorer.exe` 是 GUI 进程 —— 传了之后进程起来了、
 * 退出码也正常，**但那个文件夹窗口被藏起来**，用户体验就是「点了没反应」。去掉它，
 * 同一份代码窗口正常弹出。原先那句「Windows 不闪窗」是错的：explorer 本来就没有控制台窗口。
 *
 * 返回 `{ ok, error? }`，不抛：设置页按 ok 显示错误。`spawn` 的 'error' 事件是异步的，
 * 调用方拿不到，所以这里只挂一个空处理器，避免「命令不存在」变成未捕获异常 ——
 * 返回值表达的是「已发起」，不是「窗口已经出现」。
 */
import { spawn } from 'node:child_process'

/**
 * 平台 → 打开目录的命令与参数（纯函数，测试直接钉它）。
 * @param {string} platform — `process.platform` 的取值
 * @param {string} dir — 绝对路径
 * @returns {{command: string, args: string[]}}
 */
export function folderOpenCommand(platform, dir) {
  if (typeof dir !== 'string' || dir.length === 0) throw new Error('sage-mem: memory directory is unknown')
  if (platform === 'win32') return { command: 'explorer.exe', args: [dir] }
  if (platform === 'darwin') return { command: 'open', args: [dir] }
  return { command: 'xdg-open', args: [dir] }
}

/**
 * 发起「打开目录」，立即返回。
 * @param {string} dir — 记忆目录绝对路径
 * @param {{platform?: string, spawn?: Function}} [options] — 测试注入点
 * @returns {{ok: boolean, error?: string}}
 */
export function openMemoryFolder(dir, options = {}) {
  const platform = options.platform || process.platform
  const spawnImpl = options.spawn || spawn

  let plan
  try {
    plan = folderOpenCommand(platform, dir)
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }

  try {
    // 注意：**没有 windowsHide**。它是 Windows 上「文件夹窗口不出现」的元凶（见文末头注）；
    // `stdio: 'ignore'` 已经保证了不持有管道、不弹控制台。
    const child = spawnImpl(plan.command, plan.args, { detached: true, stdio: 'ignore' })
    child.on?.('error', () => {})
    child.unref?.()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `sage-mem: cannot open ${dir}: ${error?.message ?? error}` }
  }
}
