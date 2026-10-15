/**
 * sage-mem 记忆层 —— 目录监视（**只为缓存失效服务**，不承载任何业务语义）。
 *
 * 为什么需要它：记忆注入每走一步都要 `scanMemoryFiles` 全量列目录 + 逐份开文件读
 * frontmatter，而成本几乎全在 `open` 这个系统调用上（1000 份合成记忆实测：只 `lstat`
 * 不开文件 83 ms，`open`+`close` 只开不读 614 ms，`readFile` 全文 719 ms）。
 * 也就是说「读的文件少一点」省不下来 —— 只有**不去打开没变过的文件**才省得下来。
 *
 * 那怎么知道「没变过」？本模块给出的信号是：**目录里发生过事件**。调用方（`scan.js`）
 * 拿它当缓存的主判据，并且**只在 watcher 真的可用时才敢缓存** —— 拿不到信号就一律全扫，
 * 与没有缓存时逐字一致。这是一条安全降级：性能优化不许以「看到的内容可能是旧的」为代价。
 *
 * ⚠️ 本模块的取舍（调用方必须知道的那条残余风险）：
 * `fs.watch` 是**通知**机制，不是**保证**机制。平台、网络盘、编辑器写文件的姿势（先写临时
 * 文件再 rename / 直接覆写 / 只在内存里改）都可能让事件丢掉。丢掉一个「只改内容、不改文件名」
 * 的事件时，缓存会在本进程内继续供旧内容，直到下一次**任何**失效（新增 / 删除 / 重命名，
 * 或下一次侥幸收到的事件）—— 那时会退回全扫，正确性恢复。有意选这个取舍，而不是每次扫都
 * 逐份 `lstat` 复核 mtime：后者在 1000 份上要 83 ms，正是这次要省掉的东西。
 * 真丢事件的后果是**一次注入拿到旧内容**，不是永久错误 —— 调用方 `scan.js` 的兜底判据
 * （每次仍做一次 `readdir` 比文件名集合）覆盖了「新增 / 删除 / 重命名」这一大类，
 * 而「只改内容」这一类是**明知的、写在这里的**残余风险。
 */

import { watch } from 'node:fs'

/**
 * 事件去抖窗口（毫秒）。
 *
 * 一次保存常常触发多个事件（临时文件 + rename + 内容写），去抖把一串合并成「两次通知」：
 * 第一次**立刻**，最后一次在窗口结束时。为什么保留第一次而不只留末尾那次 —— 见 onEvent。
 */
export const WATCH_DEBOUNCE_MS = 50

/**
 * 事件洪流哨兵：窗口内超过这么多个事件，就认定这个句柄已经坏了，主动掐掉。
 *
 * ⚠️ 这不是防御性编程，是**实测踩到的坑**：Windows 上被监视的目录一旦被删（或删除后
 * 用同名目录重建），底层句柄失效，`fs.watch` 会以**每秒十几万个** `'change'` 事件空转，
 * 而且**不会**发 `'error'` —— 实测 2.9 秒收到 388,196 个事件。后果有两层：
 *   1. 进程 100% CPU 空转、**永远不退出**（`persistent: false` 拦不住一个忙等的句柄）；
 *      仓库里 `scripts/perf-chain.mjs` 每档结束都会 `rmSync` 掉沙箱，于是子进程卡死、
 *      父进程 `spawnSync` 无限等待 —— 整个脚本挂住（这次就是这么发现的）。
 *   2. 每个事件都重置去抖定时器 → 定时器分配风暴，进一步烧 CPU。
 * 真实变更不可能到这个量级（一次批量写 1000 个文件也就 1000 个事件），所以阈值取哨兵值即可；
 * 万一误判，代价也只是「这个目录退回全扫」（正确性不受影响），下一轮扫描会重新起表。
 */
export const WATCH_FLOOD_WINDOW_MS = 1000

/** 见 WATCH_FLOOD_WINDOW_MS。 */
export const WATCH_FLOOD_MAX_EVENTS = 2000

/**
 * 起一个只在**失效信号**意义上使用的目录监视器。
 *
 * @param {string} dir — 要监视的目录（不存在也算「起不来」，不抛）
 * @param {() => void} [onChange] — 目录有变更时的通知（去抖后 + 首次立即各一次）
 * @returns {{ok:boolean, reason:string, dispose:() => void}}
 *   `ok` / `reason` 是**活的取值器**：起表成功之后如果 watcher 报错，`ok` 会变成 false、
 *   `reason` 会变成失败原因 —— 调用方每次用之前重新读一遍，就不会拿着一个已经死掉的
 *   watcher 继续相信缓存。**任何失败都不抛**，一律用 `ok: false` 表达。
 */
export function createDirWatcher(dir, onChange) {
  const notify = typeof onChange === 'function' ? onChange : () => {}
  /** 起表失败的原因；空串 = 还活着。 */
  let failed = ''

  let watcher
  try {
    // persistent: false —— 监视器不许拖住进程退出（测试里也会造一堆临时目录的 watcher）。
    watcher = watch(dir, { persistent: false })
  } catch (err) {
    // 目录不存在 / 没有权限 / 平台不支持：都是「起不来」，调用方据此退回全扫。
    return { ok: false, reason: `fs.watch 打不开（${err?.code ?? err?.message ?? err}）`, dispose() {} }
  }

  let disposed = false
  let timer = null
  /** 本轮突发里「第一次通知」是否已经发过 —— 决定后面的还发不发。 */
  let burstOpen = false
  /** 洪流哨兵的固定窗口计数（见 WATCH_FLOOD_WINDOW_MS）。 */
  let floodWindowStart = 0
  let floodCount = 0

  const fire = () => {
    if (disposed || failed) return
    try {
      notify()
    } catch {
      // 通知是调用方的代码，它出错不该把 watcher 弄死；失效信号本身已经送到了。
    }
  }

  /**
   * 第一条事件**立刻**透传，之后同一突发里的事件只在去抖窗口结束时再通知一次。
   *
   * 为什么不干脆等去抖结束：去抖的目的是**合并通知**，不是**延迟失效**。等 50 ms 才失效，
   * 意味着这 50 ms 里来一次扫描就会喂旧内容 —— 而「每走一步扫一次」正是本插件的用法，
   * 两步之间远小于 50 ms。所以：首个事件立刻失效（把窗口压到事件送达那一刻），
   * 窗口结束时再补一次（合并掉这一串的其余事件）。
   */
  const onEvent = () => {
    const now = Date.now()
    if (now - floodWindowStart > WATCH_FLOOD_WINDOW_MS) {
      floodWindowStart = now
      floodCount = 0
    }
    floodCount++
    if (floodCount > WATCH_FLOOD_MAX_EVENTS) {
      // 句柄已坏（多半是目录被删 / 被同名重建）：报错这条路会顺手 close 掉，空转立刻停。
      onError({ code: 'FLOOD', message: `${WATCH_FLOOD_WINDOW_MS}ms 内 ${floodCount} 个变更事件，句柄已不可信` })
      return
    }
    if (!burstOpen) {
      burstOpen = true
      fire()
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      burstOpen = false
      fire()
    }, WATCH_DEBOUNCE_MS)
    // 定时器也不许拖住进程退出（与 persistent: false 同一目的；老 Node 上没有 unref 就跳过）。
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * 失败一律转成「这台 watcher 死了」，而不是抛出去。
   * 调用方（scan.js）看到 `ok` 变 false 会丢掉缓存并退回全扫 —— 所以这里**必须**
   * 把失败暴露出来，静默吞掉等于让它继续相信一份再也收不到失效信号的缓存。
   */
  const onError = (err) => {
    failed = `fs.watch 出错（${err?.code ?? err?.message ?? err}）`
    cleanup()
  }

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    burstOpen = false
    try {
      watcher.close()
    } catch {
      // 已经关掉了 / 底层句柄没了 —— dispose 必须幂等，不许在这里抛。
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    cleanup()
  }

  watcher.on('change', onEvent)
  // 'error' 是失败的另一条路（句柄彻底失效时 Node 才报）。⚠️ **目录被删不走这条** ——
  // 实测 Windows 上是「静默洪流」（见洪流哨兵），所以两条都得接；不接 'error' 会变成
  // uncaughtException，不接洪流就是 100% CPU 空转。
  watcher.on('error', onError)

  return {
    get ok() {
      return !disposed && failed === ''
    },
    get reason() {
      return failed
    },
    dispose,
  }
}
