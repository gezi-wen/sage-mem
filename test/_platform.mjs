/**
 * 测试用的小工具：**运行时探测**文件系统特性（不许用 `process.platform` 猜）。
 *
 * 为什么必须探测：`C:\` 上的 NTFS 默认不区分大小写，但**单个目录**可以打开区分大小写的
 * 标志；macOS 也能把卷格式化成区分大小写。猜平台只会在别人的机器上给出相反的结论 ——
 * 而这类结论直接决定断言该写「一个」还是「两个」。
 */
import { rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 这个目录所在的文件系统区分大小写吗？
 * @param {string} dir — 已存在的目录
 * @returns {Promise<boolean>} true = 不区分（NTFS 默认 / 大多数 macOS）
 */
export async function fsIsCaseInsensitive(dir) {
  const name = `case-probe-${process.pid}-${Date.now()}.tmp`
  const upper = name.replace(/[a-z]/g, (c) => c.toUpperCase())
  try {
    await writeFile(join(dir, name), 'x', 'utf8')
    return await stat(join(dir, upper)).then(
      () => true,
      () => false,
    )
  } finally {
    await rm(join(dir, name), { force: true }).catch(() => {})
  }
}
