/**
 * autodream —— 通用小工具：数值收敛、时间戳、runId、安全文件名、JSON 读、
 * 快照枚举、会话计数与增量描述。
 */

import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const clampNum = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt)

/** 本地时间戳，给文件名用。 */
export function stampCompact(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 本地时间戳，给人看。 */
export function stampHuman(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 运行 id：`YYYYMMDD-HHmmss-<4 位>`。
 *
 * 加后缀是因为**同一秒里跑第二趟**在手动连点时真会发生，而 runId 同时是
 * 快照目录名、运行记录目录名和报告文件名——撞一次就是三个地方互相覆盖。
 */
export function newRunId(ms) {
  return `${stampCompact(ms)}-${randomUUID().replace(/-/g, '').slice(0, 4)}`
}

/** 文件名/目录名的白名单校验（快照 id、运行 id、报告名都走这里，别让路径穿越进来）。 */
export function safeName(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..')) return null
  if (!/^[\w.-]+$/.test(s)) return null
  return s
}

/** 读一个 JSON，读不到/解析失败都返回 null（配置与清单文件损坏不该拖死流程）。 */
export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** 快照里实际躺着哪些 .md（清单不可信时以目录为准）。 */
export async function snapshotEntries(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')).map((e) => e.name)
}

/**
 * 精简版 chunk 组装器。
 *
 * 只保留 autodream 用得上的两种块，并**自己实现而不是依赖宿主内部包** ——
 * 依赖漂移时挂的是「整个插件加载不了」这种级别的故障，而这里需要的逻辑只有三十行。
 *
 * 两条必须保证的行为：
 *   - delta-only 协议（没有 block-start/block-end）也要能组装
 *   - `finish.kind === 'max-tokens'` 时**丢掉 tool-call 块**：被截断的调用参数
 *     是不完整的 JSON，拿去执行等于凭半句话动手

/** 数一下 `$DSH_HOME/sessions` 下 mtime 晚于 sinceMs 的会话（只看文件时间，不解压）。 */
export async function countSessionsSince(root, sinceMs) {
  if (!root) return 0
  let n = 0
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const projPath = join(root, p.name)
    let sessions
    try {
      sessions = await readdir(projPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const file = join(projPath, s.name, 'session.v4.jsonl.zstd')
      try {
        const info = await stat(file)
        if (info.mtimeMs >= sinceMs) n++
      } catch {
        // 目录里没有这个文件：不是每一代格式都叫这个名字，跳过即可。
      }
    }
  }
  return n
}

/** 人读的字节差：`12.0KB → 10.0KB（-2.0KB）`。 */
export function formatDelta(before, after) {
  const kb = (n) => `${(n / 1024).toFixed(1)}KB`
  const d = after.bytes - before.bytes
  const sign = d > 0 ? '+' : ''
  return `${kb(before.bytes)} → ${kb(after.bytes)}（${sign}${(d / 1024).toFixed(1)}KB）`
}

/** 操作类型的中文名（声明表格里给人看）。 */
export const OP_LABEL = { create: '新建', update: '改写', archive: '归档' }
