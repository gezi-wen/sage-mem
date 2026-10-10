/**
 * 更新检查（面板上的「发现新版本」）的断言。
 *
 * 这是**新功能**，所以断言就是规格本身；两条最容易写错的地方各有一组反面：
 *   ① 版本比较必须是**数字段**逐位比 —— 字符串比较会把 `0.9.10` 判成小于 `0.9.9`
 *   ② 当前版本必须**运行时读 package.json** —— 内联常量会在「构建早于 bump」时
 *      停留在旧版本，插件于是永远对自己报「有新版本」
 * 另外：查版本失败（限流 / 网络 / 没有 release）一律降级为「不提示」，绝不抛。
 */
import { readFile } from 'node:fs/promises'
import { checkUpdate, compareVersions, currentVersion } from '../lib/update.js'

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

/** 假 fetch：只认状态码与 JSON 体。 */
const fakeFetch = (status, body) => async () => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  body: { cancel: async () => {} },
})
const throwingFetch = () => async () => {
  throw new Error('ENOTFOUND api.github.com')
}

console.log('== 1. 版本比较：数字段逐位，不是字符串比较 ==')
{
  ok(compareVersions('0.9.6', '0.9.5') > 0, '0.9.6 > 0.9.5')
  ok(compareVersions('0.9.10', '0.9.9') > 0, '0.9.10 > 0.9.9（字符串比较会判反）')
  ok(compareVersions('0.10.0', '0.9.6') > 0, '0.10.0 > 0.9.6（同上）')
  ok(compareVersions('1.0.0', '0.99.99') > 0, '1.0.0 > 0.99.99')
  ok(compareVersions('v0.9.6', '0.9.6') === 0, '`v` 前缀不影响比较')
  ok(compareVersions('0.9.6', '0.9.6') === 0, '相等返回 0')
  ok(compareVersions('0.9.5', '0.9.6') < 0, '更小返回负数')
  ok(compareVersions('0.9.7-rc.1', '0.9.6') > 0, '预发布后缀不参与比较（0.9.7-rc.1 > 0.9.6）')
  ok(compareVersions('', '0.9.6') < 0, '空版本视为最小，不会误报「有新版」')
}

console.log('== 2. 当前版本：运行时读 package.json ==')
{
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const cur = await currentVersion()
  ok(cur === pkg.version, `currentVersion() 等于 package.json 的 version（${cur}）`, String(cur))
  ok(cur !== '' && /\d+\.\d+/.test(cur), '读出来像版本号')
}

console.log('== 3. checkUpdate：只有真的更新才提示 ==')
{
  const cur = await currentVersion()

  const newer = await checkUpdate({ fetchImpl: fakeFetch(200, { tag_name: 'v99.0.0' }) })
  ok(newer.updateAvailable === true && newer.latest === '99.0.0', '更新版本 → updateAvailable', JSON.stringify(newer))
  ok(newer.current === cur, '带上当前版本（界面要显示「当前 vX」）')
  ok(typeof newer.releasesUrl === 'string' && newer.releasesUrl.indexOf('github.com') >= 0, '带上 release 地址（单一事实源在宿主侧）')

  const same = await checkUpdate({ fetchImpl: fakeFetch(200, { tag_name: `v${cur}` }) })
  ok(same.updateAvailable === false && same.latest === cur, '同版本 → 不提示', JSON.stringify(same))

  const older = await checkUpdate({ fetchImpl: fakeFetch(200, { tag_name: 'v0.0.1' }) })
  ok(older.updateAvailable === false, '比当前旧 → 不提示（防止 latest 回退时误报）', JSON.stringify(older))
}

console.log('== 4. checkUpdate：失败一律降级为「不提示」，绝不抛 ==')
{
  const limited = await checkUpdate({ fetchImpl: fakeFetch(403, {}) })
  ok(limited.updateAvailable === false && limited.rateLimited === true, '403 → 标记限流、不提示', JSON.stringify(limited))
  ok(limited.error !== '', '限流也留一句原因（给日志看，不给用户看）')

  const err500 = await checkUpdate({ fetchImpl: fakeFetch(500, {}) })
  ok(err500.updateAvailable === false && err500.error.indexOf('500') >= 0, '500 → 记下状态码、不提示', JSON.stringify(err500))

  const netErr = await checkUpdate({ fetchImpl: throwingFetch() })
  ok(netErr.updateAvailable === false && /ENOTFOUND/.test(netErr.error), '网络异常 → 不抛、只记原因', JSON.stringify(netErr))

  const noTag = await checkUpdate({ fetchImpl: fakeFetch(200, {}) })
  ok(noTag.updateAvailable === false && noTag.latest === null, '没有 tag_name 的 release → 不提示', JSON.stringify(noTag))
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
