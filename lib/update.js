/**
 * 版本检查（宿主侧）。
 *
 * 为什么放在宿主侧查、而不是界面里 fetch：
 *   - 跨域与限流都按用户的浏览器出口 IP 算（未认证 60 次/小时），宿主侧可以带
 *     `GITHUB_TOKEN` 把额度提到 5000 次/小时
 *   - 界面拿不到进程环境里的凭据，宿主侧拿得到
 *
 * ⚠️ **当前版本一律运行时读自己的 `package.json`**，绝不内联常量：
 * 客户端 bundle 是构建期产物，如果版本号在构建时被写死，那么「先 build 再 bump」
 * 的发布流程会让插件永远拿旧常量去比最新 release —— 于是它**对自己报「有新版本」**，
 * 而其实已经是最新的。运行时读文件没有这个时间差。
 */
import { readFile } from 'node:fs/promises'

/** 仓库与接口（单一事实源：界面上的「看更新内容」也指向它）。 */
export const REPO_SLUG = 'gezi-wen/sage-mem'
export const REPO_URL = `https://github.com/${REPO_SLUG}`
export const RELEASES_URL = `${REPO_URL}/releases`
export const RELEASES_LATEST_API = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`

/** 当前安装的版本；读不到就回空串（宁可不提示，也不误报）。 */
export async function currentVersion() {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const pkg = JSON.parse(raw)
    return typeof pkg?.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/**
 * 简易版本比较：数字段逐位比，忽略 `v` 前缀与预发布后缀（`-rc.1` 这种不参与）。
 *
 * **故意不引 semver 依赖**：这里只回答「有没有更新的正式版」，
 * 预发布前缀的比较规则（`1.0.0-rc.1 < 1.0.0`）不在这个问题的范围内。
 * @returns {number} a > b 返回正数，a < b 返回负数，相等返回 0
 */
export function compareVersions(a, b) {
  const parts = (v) =>
    String(v ?? '')
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 查有没有新版本。
 *
 * 失败一律**降级为「不提示」**，并把原因放在 `error` / `rateLimited` 里 ——
 * 网络不可达、被限流、仓库还没建 release，都不该在面板上冒一个红条打断人。
 *
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [opts] — `fetchImpl` 只为测试注入
 * @returns {Promise<{current:string, latest:string|null, updateAvailable:boolean, rateLimited:boolean, error:string}>}
 */
export async function checkUpdate(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const current = await currentVersion()
  const base = { current, latest: null, updateAvailable: false, rateLimited: false, error: '', releasesUrl: RELEASES_URL }
  if (typeof fetchImpl !== 'function') return { ...base, error: '当前运行时不支持 fetch' }

  // 手动 AbortController + finally 清理：AbortSignal.timeout 的隐式定时器在 Windows 上
  // 退出时可能触发 libuv 断言（UV_HANDLE_CLOSING）。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000)
  try {
    const token = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim()
    const res = await fetchImpl(RELEASES_LATEST_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'sage-mem',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (res.status === 403 || res.status === 429) {
      await res.body?.cancel?.().catch?.(() => {})
      return { ...base, rateLimited: true, error: 'GitHub API 限流' }
    }
    if (!res.ok) {
      await res.body?.cancel?.().catch?.(() => {})
      return { ...base, error: `GitHub API ${res.status}` }
    }
    const data = await res.json().catch(() => undefined)
    const tag = typeof data?.tag_name === 'string' ? data.tag_name.replace(/^v/i, '') : ''
    if (!tag) return { ...base, error: 'release 里没有 tag_name' }
    return { ...base, latest: tag, updateAvailable: current !== '' && compareVersions(tag, current) > 0 }
  } catch (err) {
    return { ...base, error: err?.message ?? String(err) }
  } finally {
    clearTimeout(timer)
  }
}
