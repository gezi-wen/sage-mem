/**
 * sage-mem 记忆层 —— **路径身份**的唯一基准（归一 + 包含判定）。
 *
 * 为什么要有这个文件：观测（`observe.js`）与写入门（`write-gate.js`）都要回答同一个问题 ——
 * 「这个路径在不在记忆目录里」。两处各写一份，迟早漂成两套判据；而那类漂移的后果不是报错，
 * 是**看起来很勤快、实际判错了对象**（`access.js` 的「扫 A 目录写 B 台账」就是这一类）。
 * 与 `naming.js`（文件名身份基准）同一个思路，只是这里管的是路径。
 *
 * ⚠️ **判据只依赖输入的形状，绝不依赖 `path.sep` / `path.resolve`。**
 * `path.resolve` 在 Windows 上把 `\` 当分隔符、在 Linux 上不当，于是同一份输入在两个平台上
 * 得到不同结论 —— 而记忆目录是会被同步 / 拷贝 / 备份还原的。本仓库已经因此被 Linux CI 抓过
 * 一次（`safeName` 的 `basename` 判据），不要再犯同一类。
 */

/**
 * 把路径归一成规范形式；**不是绝对路径就返回 null**（调用方一律按「不认」处理）。
 *
 * 规则：只接受绝对路径（`/…`、`//server/share…`、`X:/…`）→ `\` 与 `/` **一律**当分隔符 →
 * 折叠 `.`、连续分隔符与逐段回退 `..`（绝对路径在根上的 `..` 是空操作）→ 盘符小写 →
 * 其余**大小写敏感**。不做磁盘解析，所以符号链接意义上的「真实位置」不保证被还原。
 */
export function canonicalPathOf(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  const isDrive = /^[A-Za-z]:[\\/]/.test(raw)
  // UNC（`\\server\share…` / `//server/share…`）保留双斜杠前缀：它和「根下的同名目录」不是
  // 一回事，合并成一个前缀会把两个不同的位置判成同一个（那才是误判）。
  const isUnc = !isDrive && (raw.startsWith('//') || raw.startsWith('\\\\'))
  let prefix
  let rest
  if (isDrive) {
    // 盘符统一小写：Windows 上 `C:` 与 `c:` 必然同义；POSIX 上这种形状不是绝对路径，到不了这里。
    prefix = `${raw[0].toLowerCase()}:`
    rest = raw.slice(2)
  } else if (isUnc) {
    prefix = '//'
    rest = raw.slice(2)
  } else if (raw.startsWith('/')) {
    prefix = '/'
    rest = raw.slice(1)
  } else {
    // `\x`（Windows 当前盘的根）、`a/b`（相对 cwd）、`C:foo`（盘符相对）都在这里被拒：
    // 它们的真实落点取决于运行时状态，纯函数看不到，猜一个基准就是误判。
    return null
  }
  const segs = []
  for (const seg of rest.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (segs.length) segs.pop()
      continue
    }
    segs.push(seg)
  }
  if (prefix === '/') return segs.length ? `/${segs.join('/')}` : '/'
  if (prefix === '//') return segs.length ? `//${segs.join('/')}` : '//'
  return segs.length ? `${prefix}/${segs.join('/')}` : `${prefix}/`
}

/**
 * 段边界包含：`/mem` 含 `/mem/x.md` 与它自己，**不含** `/memories/x.md`。
 *
 * 判据是「父目录 + 分隔符」，不是裸字符串前缀 —— 裸前缀正是那个经典陷阱。
 */
export function isSameOrInside(parent, child) {
  if (parent === child) return true
  const boundary = parent.endsWith('/') ? parent : `${parent}/`
  return child.startsWith(boundary)
}

/** 规范路径的最后一段（要文件名而不是路径时用它）。 */
export function fileNameOf(canon) {
  const cut = canon.lastIndexOf('/')
  return cut < 0 ? canon : canon.slice(cut + 1)
}

/**
 * 根目录不算记忆目录。
 *
 * 拿根（`/`、`//`、`X:/`）做包含判定，等于把整块盘都算成记忆 —— 一条配置写错就能把台账
 * 灌满「读了别处」的记录，或者把整个盘的写入都套上守卫。宁可不判。
 */
export function isRootLike(canon) {
  return canon === '/' || canon === '//' || /^[a-z]:\/$/.test(canon)
}

/**
 * 一步到位：这个路径是不是**记忆目录里的**条目（含目录本身时 `includeSelf` 决定）。
 *
 * 三条拒绝理由都返回 `{ok:false, why}` 而不是抛 —— 调用方在事件回调里，抛出去会打断
 * 宿主的写入链路。
 *
 * @returns {{ok:true, canon:string, name:string} | {ok:false, why:string}}
 */
export function memoryPathOf(raw, memoryDir, opts = {}) {
  const canon = canonicalPathOf(raw)
  if (canon === null) return { ok: false, why: '不是绝对路径（相对路径的真实落点取决于运行时状态，不猜）' }
  const root = canonicalPathOf(memoryDir)
  if (root === null) return { ok: false, why: '记忆目录本身不是绝对路径' }
  if (isRootLike(root)) return { ok: false, why: '记忆目录是文件系统根：不做包含判定' }
  if (!isSameOrInside(root, canon)) return { ok: false, why: '路径不在记忆目录内' }
  if (canon === root) return opts.includeSelf ? { ok: true, canon, name: '' } : { ok: false, why: '目标是记忆目录本身' }
  return { ok: true, canon, name: fileNameOf(canon) }
}
