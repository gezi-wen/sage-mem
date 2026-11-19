/**
 * 内容短指纹（FNV-1a 32 位，零依赖）—— **只给文件名用**，不做安全哈希。
 *
 * ## 为什么不用 `node:crypto`
 *
 * 用它的是 `lib/memory/trim-plan.js`（裁段规划器），而那个模块被
 * `test/structure-test.mjs` 第 5 组钉成「纯逻辑层」：**零 node 内建 import**。
 * 那条守卫不是为了洁癖 —— `planTrim` 要在没有磁盘、没有夹具的情况下对着字符串
 * 做几百条断言（`test/trim-plan-test.mjs`），一旦它 import 了 `node:*`，
 * 纯度就从「结构上成立」退化成「这次没人写错」。
 *
 * 另一条路是把 hash 算在 IO 层（`trim-archive.js`）再传进 `planTrim` —— 那会改
 * `planTrim` 的签名，等于让「归档名怎么算」横跨两层，`trim-plan-test.mjs` 再也
 * 不能单独验证一个名字。所以：**函数留在这里，算在纯函数那一侧。**
 *
 * 本项目还有别的哈希（`lib/autodream/snapshot.js` / `memory/chunks.js` 用
 * `node:crypto` 的 sha256、`lib/autodream/audit.js` 用 sha1）—— 那些是**内容校验**
 * 与**去重判据**，要抗碰撞，该用 crypto。这里只要「同一天同前缀的两段不同正文
 * 别撞在同一个名字上」，32 位足够，且必须零依赖。两种需求，两套实现。
 *
 * ## 为什么是 4 位十六进制
 *
 * 名字的骨架是 `<原名去 .md>-<slug ≤16>-<YYYYMMDD>-<hash4>.md`：
 *
 *   - 撞名的后果不是「换个名字」，而是**硬拒绝**（`trim-archive.js` 的
 *     `writeFileExclusive` → `code:'exists'`，不覆盖也不改名）。slug 从 40 收短到 16
 *     之后，「同一天、同一前缀、标题被截断成同一串」就会假撞 —— 一次治理跑不动。
 *   - 4 位 = 16 位 = 65536 个取值。同一前缀同一天真的有 10 段要归档时，
 *     假撞概率 ≈ 10×9/2/65536 ≈ **0.07%**；而 body 真重复（同一段被裁两次）
 *     得到同名、被 `exists` 拒，那本来就是**该拒**的。
 *   - 再短（3 位）假撞率 ×16；再长（6 位）名字又要多两个字符，且对「同日同前缀」
 *     这个真实场景没有额外收益。
 *
 * 取的是**低位**（`padStart(8,'0')` 之后 `slice(-n)`），这一点容易写反，实测说话：
 *
 *   FNV-1a 的一步是 `h = (h ^ b) * prime`。乘法把进位从**低位向高位**传播，
 *   所以末字节的改动先落在低位、要再经过若干字节才扩散到高位。于是对「只差末尾
 *   一点点」的文本，**低位才是强端**。
 *
 *   本机实测（`fnv1a32` 同一实现，200 条 `'很长的正文内容'×20` + 依次换末字）：
 *     - 取高 4 位：**162 / 200 distinct** —— 38 次碰撞
 *     - 取低 4 位：**200 / 200 distinct** —— 0 次碰撞
 *
 *   这个场景不是刁难，它就是 `planTrim` 的真实输入：同一份记忆的不同切片，往往
 *   只差标题和末尾几行。取高位 = 假撞 = `writeFileExclusive` 硬拒 = 一次治理直接
 *   跑不动 —— 那正是加这个 hash 要堵的洞。`test/trim-plan-test.mjs` 第 11 组有一条
 *   属性断言（200 条近似文本必须 200 个不同名字）盯着这件事，改回高位当场红。
 *
 * 输入按 **UTF-8 字节**喂（不是 UTF-16 code unit）：同一份中文正文在任何平台上
 * 都得同一个名字，而「文件里那段字节」正是我们对它的直觉。
 *
 * 零 import（`test/duplication-test.mjs` 第 2 组要求 `shared/*.js` 谁都能引、
 * 不制造循环）—— 所以这里手写 UTF-8 拆字节，不借 `TextEncoder` 之外的任何东西，
 * 干脆连全局都不借。
 */

/** FNV-1a 的初始值（32 位偏移基数）。 */
const FNV_OFFSET_BASIS = 2166136261

/** FNV-1a 的乘法质数（32 位）。 */
const FNV_PRIME = 16777619

/** 喂一个字节：异或后乘质数，`Math.imul` 保证按 32 位整数取模（`*` 会溢出成浮点）。 */
const stepByte = (h, b) => Math.imul(h ^ b, FNV_PRIME) >>> 0

/**
 * 字符串 → 32 位无符号整数指纹（UTF-8 字节序，FNV-1a）。
 *
 * 代理对先合成真正的 code point 再拆字节；落单的代理（半个表情、截断的文件）
 * 按 3 字节形态编码 —— 不抛错，也不去修它：哈希只要**确定性**，不做字符校验。
 */
export function fnv1a32(str) {
  const s = String(str ?? '')
  let h = FNV_OFFSET_BASIS >>> 0
  for (let i = 0; i < s.length; i += 1) {
    let cp = s.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
        i += 1
      }
    }
    if (cp < 0x80) {
      h = stepByte(h, cp)
    } else if (cp < 0x800) {
      h = stepByte(h, 0xc0 | (cp >> 6))
      h = stepByte(h, 0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      h = stepByte(h, 0xe0 | (cp >> 12))
      h = stepByte(h, 0x80 | ((cp >> 6) & 0x3f))
      h = stepByte(h, 0x80 | (cp & 0x3f))
    } else {
      h = stepByte(h, 0xf0 | (cp >> 18))
      h = stepByte(h, 0x80 | ((cp >> 12) & 0x3f))
      h = stepByte(h, 0x80 | ((cp >> 6) & 0x3f))
      h = stepByte(h, 0x80 | (cp & 0x3f))
    }
  }
  return h >>> 0
}

/**
 * 文件名里那一段：`n` 位小写十六进制（默认 4），取 32 位的**低位**。
 *
 * 为什么是低位：见文件头「取的是低位」那一段（乘法把影响从低位向高位传播，
 * 近似文本的差异先落在低位）。`padStart(8,'0')` 不能省 —— 指纹恰好小到不足 8 位时
 * （例如 `0x0000abcd`），`slice(-n)` 会拿到比 `n` 短的串，名字就长短不一了。
 *
 * @param {string} str — 要指纹化的正文
 * @param {number} [n] — 位数（1-8，默认 4；越界按 4 处理，不抛错 —— 这是个命名助手，不该在治理路上炸）
 * @returns {string} 例：`fnv1aHex('hello')` = `'2cab'`（完整指纹 `4f9f2cab` 的低 4 位）
 */
export function fnv1aHex(str, n = 4) {
  const width = Number.isInteger(n) && n > 0 && n <= 8 ? n : 4
  return fnv1a32(str).toString(16).padStart(8, '0').slice(-width)
}
