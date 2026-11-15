#!/usr/bin/env node
/**
 * 体积治理判据的断言（`lib/memory/size-policy.js`，2.10.1 A 片）。
 *
 * 为什么这套件几乎全在盯**边界**：体积治理出错的样子不是崩溃，是「差一个字节」——
 * `16*1024-1` 与 `16*1024` 归到同一档，用户就会看到「明明没到 16 KB 也提醒我」；
 * CRLF 忘了剥 `\r`，Windows 上写出来的索引每一行都多一个字，240 那条线整体偏一位。
 * 所以每一组都成对写：`n-1` 与 `n` 各一条，围栏里与围栏外各一条，CRLF 与 LF 各一条。
 *
 * 三条**反向对照**（判据本身会不会红）单独放在最后一组：把围栏去掉、把边界挪一格，
 * 结果**必须**变。少了这一组，上面所有「没报出来」都可能是判据恒假。
 *
 * 纯函数、零 I/O、不联网；唯一碰磁盘的地方是给自己搭一个临时状态根（只为
 * `reserved.json` 这一种名字），跑完自删 —— **绝不碰真实记忆目录**。
 * 最后一组把判据接到**写路径**上（`prepareWrite`）：闸门全部注入桩，一次盘都不落，
 * 只验「过软线不拒写、成功回执带 softLimit、拒绝回执形状不变」。
 *
 * 用法（先设沙箱环境变量，否则会碰真实记忆目录）：
 *   SAGE_MEM_DIR=… SAGE_MEM_STATE_DIR=… node test/size-policy-test.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INDEX_DOC_BYTES, INDEX_LINE_CHARS, MAX_FILE_BYTES, TRIM_FORCE_BYTES, TRIM_WARN_BYTES } from '../lib/shared/limits.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}
const group = (t) => console.log(`== ${t} ==`)
const show = (x) => JSON.stringify(x)

/**
 * 临时状态根 + 一条「使用者自己声明的保护名」。
 *
 * ⚠️ 必须在**动态 import 之前**做完：`memory/config.js` 在模块加载时就把
 * `SAGE_MEM_DIR` / `SAGE_MEM_STATE_DIR` 读成常量，并且 `RESERVED_FILES` 在那时
 * 已经包含 `reserved.json` 里的名字。静态 import 会被提升到这些代码之前，
 * 所以被测模块一律走 `await import()`。
 */
const sandbox = mkdtempSync(join(tmpdir(), 'sage-mem-size-policy-'))
const RESERVED_NAME = 'keep-me-protected.md'
writeFileSync(join(sandbox, 'reserved.json'), JSON.stringify([RESERVED_NAME]), 'utf8')
process.env.SAGE_MEM_DIR = join(sandbox, 'memory')
process.env.SAGE_MEM_STATE_DIR = sandbox

const { adviceText, classifySize, indexFindings, kindOfName, sizeText } =
  await import('../lib/memory/size-policy.js')
// 反向对照要用的「为什么顺序不能换」证据：索引与流水**本身就是保留名**。
const { isReserved } = await import('../lib/memory/naming.js')

/** 恰好 n 字节的 ASCII 正文（ASCII 一字符一字节，字节数可控）。 */
const ascii = (n) => 'a'.repeat(n)
/** 按行拼一段索引（不追尾随换行 —— 尾随换行会多出一行，见下面专门那一条）。 */
const linesOf = (...rows) => rows.join('\n')

// ── 1. 四条线只有一处定义，且软线在硬闸门之下 ──────────────────────
group('1. 常量（唯一来源 shared/limits.js）')
{
  ok(TRIM_WARN_BYTES === 16 * 1024, `TRIM_WARN_BYTES = 16 KB（实际 ${TRIM_WARN_BYTES}）`)
  ok(TRIM_FORCE_BYTES === 40 * 1024, `TRIM_FORCE_BYTES = 40 KB（实际 ${TRIM_FORCE_BYTES}）`)
  ok(INDEX_LINE_CHARS === 240, `INDEX_LINE_CHARS = 240（实际 ${INDEX_LINE_CHARS}）`)
  ok(INDEX_DOC_BYTES === 24 * 1024, `INDEX_DOC_BYTES = 24 KB（实际 ${INDEX_DOC_BYTES}）`)
  ok(TRIM_WARN_BYTES < TRIM_FORCE_BYTES, '提醒线在强制线之下（否则 warn 永远走不到）')
  ok(TRIM_FORCE_BYTES < MAX_FILE_BYTES, '两条软线都在 512 KB 硬闸门之下（软线到不了硬闸门那一步）')
}

// ── 2. kindOfName：四类，且「先认索引/流水」的顺序不能换 ─────────────
group('2. kindOfName 四类')
{
  ok(kindOfName('project_alpha.md') === 'entry', '普通记忆 → entry')
  ok(kindOfName('MEMORY.md') === 'index', 'MEMORY.md → index')
  ok(kindOfName('memory.md') === 'index', '小写 memory.md 同样 → index（NTFS 不区分大小写）')
  ok(kindOfName('MEMORY.MD') === 'index', 'MEMORY.MD（扩展名大写）→ index')
  ok(kindOfName('session-log.md') === 'sessionLog', 'session-log.md → sessionLog')
  ok(kindOfName('Session-Log.MD') === 'sessionLog', '大小写混写 → sessionLog')
  ok(kindOfName('..\\..\\MEMORY.md') === 'index', '带目录成分的名字先取 basename → index')
  ok(kindOfName(RESERVED_NAME) === 'reserved', `reserved.json 里声明的名字 → reserved（${RESERVED_NAME}）`)
  ok(kindOfName(RESERVED_NAME.toUpperCase()) === 'reserved', '保护名单同样大小写不敏感')
  ok(kindOfName(undefined) === 'entry' && kindOfName('') === 'entry', '非字符串 / 空值 → entry（分类器不抛）')
  // 反向对照：顺序写反（先判保留名）会把索引归成 reserved —— 那它就会被 skip 掉、
  // 再也不进体积账。用 isReserved 的真实结果证明这条顺序确实有必要，不是自我安慰。
  ok(isReserved('MEMORY.md') === true && isReserved('session-log.md') === true,
    '索引与流水本身也在保护名单里（所以必须先认它们，再判 reserved）')
}

// ── 3. classifySize：三档边界 ────────────────────────────────────
group('3. classifySize 三档（边界成对写）')
{
  const entry = (b) => classifySize({ bytes: b, kind: 'entry' })
  ok(entry(TRIM_WARN_BYTES - 1).level === 'ok', `entry ${TRIM_WARN_BYTES - 1} 字节 → ok（提醒线下方一个字节）`)
  ok(entry(TRIM_WARN_BYTES).level === 'warn', `entry ${TRIM_WARN_BYTES} 字节 → warn（提醒线本身算超）`)
  ok(entry(TRIM_FORCE_BYTES - 1).level === 'warn', `entry ${TRIM_FORCE_BYTES - 1} 字节 → warn（强制线下方一个字节）`)
  ok(entry(TRIM_FORCE_BYTES).level === 'force', `entry ${TRIM_FORCE_BYTES} 字节 → force（强制线本身算超）`)
  ok(entry(MAX_FILE_BYTES).level === 'force', 'entry 到 512 KB 仍是 force（硬闸门在别处判，这里只分级）')
  ok(entry(TRIM_WARN_BYTES).limit === TRIM_WARN_BYTES && entry(TRIM_FORCE_BYTES).limit === TRIM_FORCE_BYTES,
    'limit = 触发当前档位的那条线')
  ok(entry(0).limit === TRIM_WARN_BYTES, 'ok 档的 limit 给「下一条会响的线」')
  ok(entry(TRIM_WARN_BYTES).advice === 'trim-or-compress' && entry(TRIM_WARN_BYTES - 1).advice === 'none',
    'advice 枚举跟着档位走（trim-or-compress / none）')
  ok(entry(TRIM_WARN_BYTES).bytes === TRIM_WARN_BYTES && entry(TRIM_WARN_BYTES).kind === 'entry',
    '回执带回 kind 与 bytes（调用方不必再算一遍）')

  const index = (b) => classifySize({ bytes: b, kind: 'index' })
  ok(index(INDEX_DOC_BYTES / 2 - 1).level === 'ok', `index ${INDEX_DOC_BYTES / 2 - 1} 字节 → ok（提醒线下方一个字节）`)
  ok(index(INDEX_DOC_BYTES / 2).level === 'warn', `index ${INDEX_DOC_BYTES / 2} 字节 → warn（半份即提醒）`)
  ok(index(INDEX_DOC_BYTES - 1).level === 'warn', `index ${INDEX_DOC_BYTES - 1} 字节 → warn（整份线下方一个字节）`)
  ok(index(INDEX_DOC_BYTES).level === 'force', `index ${INDEX_DOC_BYTES} 字节 → force（整份线本身算超）`)
  ok(index(INDEX_DOC_BYTES).advice === 'index-slim' && index(0).advice === 'none', 'index 的 advice 是 index-slim / none')
  ok(index(INDEX_DOC_BYTES / 2).limit === INDEX_DOC_BYTES / 2, 'index warn 档的 limit 是半份线（12 KB）')

  ok(classifySize({ bytes: 512 * 1024, kind: 'sessionLog' }).level === 'skip', '流水再大也是 skip（永不计入问题）')
  ok(classifySize({ bytes: 512 * 1024, kind: 'reserved' }).level === 'skip', '保护名单再大也是 skip（一个字都不许动）')
  ok(classifySize({ bytes: 512 * 1024, kind: 'sessionLog' }).advice === 'none'
    && classifySize({ bytes: 512 * 1024, kind: 'reserved' }).limit === 0, 'skip 档没有线（limit 0、advice none）')

  ok(classifySize({ bytes: TRIM_WARN_BYTES, kind: '我乱传的' }).level === 'warn', '未知 kind 按普通条目算（不抛、不静默 skip）')
  ok(classifySize({ bytes: TRIM_WARN_BYTES }).level === 'warn', '不传 kind 默认 entry')
  ok(classifySize({ bytes: TRIM_WARN_BYTES, kind: null }).level === 'warn', 'kind=null 默认 entry')
  ok(classifySize({ bytes: undefined }).level === 'ok' && classifySize({}).level === 'ok',
    'bytes 缺失 → 当 0（审计直接叫它，不许抛）')
  ok(classifySize({ bytes: NaN }).level === 'ok' && classifySize({ bytes: -1 }).level === 'ok',
    'NaN / 负数 → 当 0')
  ok(classifySize({ bytes: '16384' }).level === 'ok', '字符串 "16384" 不认（只收数字，避免隐式转换把闸门判松）')
  ok(classifySize({ bytes: 16384.9 }).bytes === 16384, '小数向下取整（字节是整数，不留 16384.9 这种值）')
}

// ── 4. indexFindings：长行 / 围栏 / CRLF / 整份体积 ─────────────────
group('4. indexFindings')
{
  const empty = indexFindings('')
  ok(empty.bytes === 0 && empty.lines === 1 && empty.longLines.length === 0 && empty.overDoc === false,
    '空串：0 字节、1 行、没有长行', show(empty))
  ok(empty.level === 'ok' && empty.advice === 'none', '空串 → ok / none')
  const nonString = indexFindings(null)
  ok(nonString.bytes === 0 && nonString.level === 'ok', '非字符串按空串算（不抛）')

  // 长行：恰好 240 不报，241 报；行号是 1-based。
  const at240 = indexFindings(linesOf('# 索引', '甲'.repeat(INDEX_LINE_CHARS)))
  const at241 = indexFindings(linesOf('# 索引', '甲'.repeat(INDEX_LINE_CHARS + 1)))
  ok(at240.longLines.length === 0, `恰好 ${INDEX_LINE_CHARS} 字不算长行（边界本身在限内）`)
  ok(at241.longLines.length === 1 && at241.longLines[0].line === 2 && at241.longLines[0].chars === INDEX_LINE_CHARS + 1,
    `第 2 行 ${INDEX_LINE_CHARS + 1} 字 → 报出来，行号 1-based`, show(at241.longLines))
  ok(at241.level === 'force' && at241.advice === 'index-slim' && at241.overDoc === false,
    '单行超长 → force / index-slim，但整份没超（overDoc false）')
  ok(at241.lines === 2 && at241.bytes > 0, '行数与字节数都带回（审计要两个数）')

  // 代码围栏：三个反引号里的长行不算；围栏关闭后照算，行号仍然对得上。
  const fenced = indexFindings(linesOf(
    '# 索引',
    '```md',
    '甲'.repeat(500),
    '```',
    '乙'.repeat(500),
  ))
  ok(fenced.longLines.length === 1 && fenced.longLines[0].line === 5,
    '围栏里的长行不算，围栏后的长行照算（行号 5）', show(fenced.longLines))
  const bare = indexFindings(linesOf('甲'.repeat(500)))
  ok(bare.longLines.length === 1, '【反向对照】去掉围栏，同一行立刻被报出来')
  const tilde = indexFindings(linesOf('~~~', '甲'.repeat(500), '~~~'))
  ok(tilde.longLines.length === 0, '波浪号围栏（~~~）里的长行同样不算')
  const unclosed = indexFindings(linesOf('```', '甲'.repeat(500)))
  ok(unclosed.longLines.length === 0, '围栏没闭合 → 后面的长行一律不算（宁可少报一条）')
  const inlineCode = indexFindings(linesOf('`' + '甲'.repeat(500) + '`'))
  ok(inlineCode.longLines.length === 1, '行内单反引号不是围栏（只有行首三个以上才算）')

  // CRLF：行尾的 \r 不许进字符数 —— 否则 Windows 上每一行都虚增一个字。
  const lfText = linesOf('# 索引', '甲'.repeat(INDEX_LINE_CHARS + 1), '乙'.repeat(INDEX_LINE_CHARS))
  const crlfText = lfText.replace(/\n/g, '\r\n')
  const lf = indexFindings(lfText)
  const crlf = indexFindings(crlfText)
  ok(show(crlf.longLines) === show(lf.longLines), 'CRLF 与 LF 给出同一份长行清单（行号、字符数都一样）', show(crlf.longLines))
  ok(crlf.longLines[0].chars === INDEX_LINE_CHARS + 1, `CRLF 下字符数仍是 ${INDEX_LINE_CHARS + 1}（不是 +2）`)
  ok(lf.lines === crlf.lines, 'CRLF 与 LF 的行数一致')
  ok(crlf.bytes === lf.bytes + 2, 'CRLF 字节数按真实内容算（每行多一个 \\r 字节）')

  // 整份体积：只看字节，不看行。
  const manyShort = (ch, rows) => linesOf(...Array.from({ length: rows }, () => ch.repeat(64)))
  const overDoc = indexFindings(manyShort('a', 400)) // 400 × 65 ≈ 26 KB
  ok(overDoc.overDoc === true && overDoc.longLines.length === 0 && overDoc.level === 'force',
    '整份超过 24 KB → force（哪怕每行都很短）', show({ bytes: overDoc.bytes, long: overDoc.longLines.length }))
  const nearDoc = indexFindings(manyShort('b', 200)) // 200 × 65 ≈ 13 KB
  ok(nearDoc.overDoc === false && nearDoc.level === 'warn', '半份到整份之间 → warn（先提醒，不强制）')
  ok(nearDoc.longLines.length === 0 && nearDoc.advice === 'index-slim', 'warn 档也给 index-slim（处置方向一样）')

  // 行数口径：尾随换行会多出一个空行 —— 这与 split(/\r?\n/) 的语义一致，写进断言里钉住。
  ok(indexFindings('a\nb').lines === 2, '两行文本 → lines 2')
  ok(indexFindings('a\nb\n').lines === 3, '尾随换行 → lines 3（split 语义，别处据此算行号）')
}

// ── 5. sizeText：人读的格式 ──────────────────────────────────────
group('5. sizeText')
{
  ok(sizeText(0) === '0 B', '0 → 0 B')
  ok(sizeText(812) === '812 B', '812 → 812 B（契约里的例子）')
  ok(sizeText(1023) === '1023 B', '1023 → 1023 B（B 档的边界）')
  ok(sizeText(1024) === '1 KB', '1024 → 1 KB（进位到 KB）')
  ok(sizeText(8192) === '8 KB', '8192 → 8 KB（整数 KB 不写成 8.0 KB）')
  ok(sizeText(16384) === '16 KB', '16384 → 16 KB（提醒线；文案里「超过 16 KB 提醒线」靠它）')
  ok(sizeText(40960) === '40 KB', '40960 → 40 KB（2.10.2 的强制线）')
  ok(sizeText(24576) === '24 KB', '24576 → 24 KB')
  ok(sizeText(27034) === '26.4 KB', '27034 → 26.4 KB（契约里的例子）')
  ok(sizeText(1048576) === '1 MB', '1 MB → 1 MB（进位到 MB）')
  ok(sizeText(1572864) === '1.5 MB', '1.5 MB → 1.5 MB')
  ok(sizeText(undefined) === '0 B' && sizeText(NaN) === '0 B' && sizeText(-5) === '0 B',
    '非法输入一律 0 B（文案里绝不出现 undefined / NaN）')
}

// ── 6. adviceText：一句话，且与 read_memory 回执那句逐字一致 ─────────
group('6. adviceText')
{
  const force = adviceText({ bytes: 44135, kind: 'entry' })
  ok(force === '这条 43.1 KB，超过 40 KB 强制线：按 sage-mem 技能的「体积治理」处置（裁段归档 / 压缩）',
    'entry force 的句子与契约 §4 的 read_memory 回执逐字一致', force)
  const warn = adviceText({ bytes: 16384, kind: 'entry' })
  ok(warn.includes('超过 16 KB 提醒线') && warn.includes('裁段归档'), 'entry warn 说清「超了哪条线 + 怎么做」', warn)
  const fine = adviceText({ bytes: 1024, kind: 'entry' })
  ok(fine.includes('体积正常') && fine.includes('16 KB') && fine.includes('40 KB'),
    'entry ok 顺带报两条线（用户知道离得还有多远）', fine)

  const idxWarn = adviceText({ bytes: 12288, kind: 'index' })
  ok(idxWarn.includes('接近 24 KB 上限') && idxWarn.includes('索引瘦身'), 'index warn 指向索引瘦身', idxWarn)
  const idxForce = adviceText({ bytes: 25000, kind: 'index' })
  ok(idxForce.includes('超过 24 KB 整份上限'), 'index 整份超线说「整份上限」', idxForce)
  // 一行 500 字的索引可能总共才 1 KB —— 只给字节数会判成「体积正常」，所以允许补 longLines。
  const idxLong = adviceText({ bytes: 1024, kind: 'index', longLines: [{ line: 2, chars: 500 }] })
  ok(idxLong.includes('有 1 行超过 240 字'), '带上 longLines 时不会对着超长行说「体积正常」', idxLong)
  ok(adviceText({ bytes: 1024, kind: 'index' }).includes('体积正常'),
    '【反向对照】不传 longLines 时只能说「体积正常」（这就是必须传的理由）')

  ok(adviceText({ bytes: 999999, kind: 'sessionLog' }).includes('跳过'), '流水 → 明确说跳过（永不计入问题）')
  ok(adviceText({ bytes: 999999, kind: 'reserved' }).includes('跳过'), '保护名单 → 明确说跳过（一个字都不许动）')

  // 全组合扫描：任何一档、任何缺失输入都不许把 undefined / NaN 漏进文案。
  const bad = []
  for (const kind of ['entry', 'index', 'sessionLog', 'reserved', undefined, '乱传']) {
    for (const bytes of [undefined, NaN, -1, 0, 1, TRIM_WARN_BYTES - 1, TRIM_WARN_BYTES, TRIM_FORCE_BYTES, INDEX_DOC_BYTES, 512 * 1024]) {
      const text = adviceText({ bytes, kind })
      if (typeof text !== 'string' || text === '' || /undefined|NaN|null/.test(text)) bad.push(`${kind}/${bytes}: ${text}`)
    }
  }
  ok(bad.length === 0, '所有 kind × bytes 组合都给出一句非空、且不含 undefined / NaN 的中文建议', bad.slice(0, 3).join(' | '))
  ok(/undefined|NaN/.test(adviceText({})) === false, '一个参数都不给也不漏 undefined')
}

// ── 7. 导出面与依赖面（纯函数、无 IO 这条要能自己证明） ──────────────
group('7. 导出面 / 依赖面')
{
  ok([adviceText, classifySize, indexFindings, kindOfName, sizeText].every((f) => typeof f === 'function'),
    '契约 §1 的五个函数都在（kindOfName / classifySize / indexFindings / sizeText / adviceText）')
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/memory/size-policy.js', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
  ok(imports.every((i) => ['../shared/limits.js', '../shared/md-name.js', './naming.js'].includes(i)),
    '只 import 数字来源与名字判据（不碰 IO / autodream / recall / 组合根）', imports.join(','))
  ok(!imports.some((i) => i.startsWith('node:')), '没有任何 node: 内建 import（纯函数，零 IO）')
  ok(!/readFileSync\(|writeFileSync\(|await import\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
    '源码里没有任何读写盘调用（注释里提到不算）')
}

// ── 8. 写路径接线：prepareWrite 的 softLimit 只在成功回执里出现 ────────
group('8. prepareWrite 的软线回执（闸门全注入桩，不落盘）')
{
  const { prepareWrite } = await import('../lib/memory/write-protocol.js')
  const warns = []
  const ctx = { logger: { warn: (m) => warns.push(String(m)) } }
  /** 一套全桩的 prepareWrite 入参：名字先按「普通记忆」过，磁盘探针一律 missing。 */
  const spec = (p) => ({
    isReserved: () => false,
    nameKey: (n) => String(n ?? '').toLowerCase(),
    safeName: (n) => n,
    dir: sandbox,
    inspectEntry: async () => ({ ok: false, code: 'missing' }),
    limitBytes: MAX_FILE_BYTES,
    ctx,
    ...p,
  })

  const passLine = await prepareWrite(spec({ name: 'project_x.md', content: ascii(TRIM_WARN_BYTES - 1) }))
  ok(passLine.ok === true && !('softLimit' in passLine), `不过线（${TRIM_WARN_BYTES - 1} 字节）的成功回执里没有 softLimit`)
  ok(warns.length === 0, '不过线时不刷体积提醒（日志不能变成噪音）')

  const warnLine = await prepareWrite(spec({ name: 'project_x.md', content: ascii(TRIM_WARN_BYTES) }))
  ok(warnLine.ok === true && warnLine.softLimit?.bytes === TRIM_WARN_BYTES && warnLine.softLimit?.level === 'warn',
    '过提醒线 → 成功回执带 softLimit{bytes, level:warn}', show(warnLine.softLimit))
  ok(warnLine.ok === true, '过软线**不拒写**（体积治理不是丢数据）')
  ok(warns.length === 1 && warns[0].includes('体积提醒') && warns[0].includes(sizeText(TRIM_WARN_BYTES)),
    '同时落一行日志（回执字段被组合根丢掉时，日志是唯一一定看得见的出口）', warns.join(' | '))

  const forceLine = await prepareWrite(spec({ name: 'project_x.md', content: ascii(TRIM_FORCE_BYTES) }))
  ok(forceLine.softLimit?.level === 'force' && forceLine.softLimit?.bytes === TRIM_FORCE_BYTES, '过强制线 → level force')

  const logLine = await prepareWrite(spec({ name: 'session-log.md', content: ascii(TRIM_FORCE_BYTES * 4) }))
  ok(logLine.ok === true && !('softLimit' in logLine), '流水（skip 档）再大也不带 softLimit —— 它有自己的上限')

  const tooBig = await prepareWrite(spec({ name: 'project_x.md', content: ascii(MAX_FILE_BYTES + 1) }))
  ok(tooBig.ok === false && tooBig.code === 'too_big' && !('softLimit' in tooBig),
    '拒绝路径的 {ok:false, code} 形状没变（不带 softLimit）', show(tooBig))

  const before = warns.length
  const refused = await prepareWrite(spec({
    name: 'project_x.md',
    content: ascii(TRIM_FORCE_BYTES),
    inspectEntry: async () => ({ ok: false, code: 'symlink' }),
  }))
  ok(refused.ok === false && warns.length === before,
    '被 ⑦ 磁盘探针拒掉的写入不刷体积提醒（没写成的文件不该收到提醒）', show(refused))
}

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
