/**
 * sage-mem 记忆层 —— 任务检查点（`<状态根>/tasks/<taskId>/WORKING.md`）。
 *
 * 为什么要有这一层：宿主什么时候压缩上下文，插件说了不算 —— 所以**不能承诺
 * 「压缩前一定保存」**。能做的只有两件事：任务走到里程碑时把状态写下来，
 * 压缩之后再用一个短句柄把它读回来。检查点与长期记忆刻意分开：长期记忆答
 * 「我记住的事」，检查点答「这件任务走到哪了」，两者的生命周期、检索方式、
 * 失效条件都不一样，混在一起会让两边都不可信。
 *
 * 这个模块存在的理由**不是格式检查**：固定标题 + 最小长度只能验证格式，而一份格式完美、
 * 内容错误的交接材料仍然是错的。所以 `parseCheckpoint` 除了报缺节，还报
 * `claimsDoneWithoutEvidence` —— 「已完成」里没有任何证据标记的条目。判据的取向是刻意
 * 严格的：**「测试过了」不是证据，「结果：12 passed, 0 failed」才是**。没有证据，
 * 不许把「准备做」写成「已经完成」。
 *
 * 并发：本模块**不实现锁**。同一个 taskId 的并发写由调用方串行（进程内用 `util.js` 的
 * `createWriteQueue`，跨进程本模块明确不管）—— 本模块只负责把每一份写原子化。
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATE_ROOT } from './config.js'
import { writeFileAtomic } from './util.js'

/** 检查点都放在状态根的这个子目录下，一个任务一个目录。 */
export const TASKS_DIR_NAME = 'tasks'

/** 检查点文件名。固定不变，短句柄里要引用它。 */
export const CHECKPOINT_FILE_NAME = 'WORKING.md'

/**
 * 单份检查点的体积上限（字节）。
 *
 * 与记忆的 512 KB 上限分开：检查点是**要反复注入**的东西，一份 64 KB 的交接材料
 * 等于把上下文又用掉一大块，那正好抵消了压缩腾出来的空间。到 64 KB 说明写成了流水账，
 * 该拆成多份（或把稳定结论移进长期记忆）。
 */
export const CHECKPOINT_MAX_BYTES = 64 * 1024

/** 必需的节标题（顺序即模板顺序）。 */
export const CHECKPOINT_SECTIONS = Object.freeze([
  '目标与约束',
  '已完成与证据',
  '未完成',
  '关键决定',
  '记忆引用',
  '待核实',
])

/**
 * 缺字段的占位文本。
 *
 * 为什么用占位符而不是空行：空行在 markdown 里与排版空白没有区别，「这里少东西」这件事
 * 在渲染结果里看不见；而且 `parseCheckpoint` 需要能区分「有标题」与「有内容」——
 * 占位符是「有标题、没内容」在文本里的可判定形态。
 */
const PLACEHOLDER = '（待补）'

/**
 * 任务 id 允许的字符集：单段、`[A-Za-z0-9._-]`、1..64 字符。
 *
 * **刻意不含** `/`、`\`、`:`：三个都是路径语义的元字符（`:` 在 NTFS 上是交替数据流的分隔符）。
 * 判定走纯字符类、**不走 `path.basename`** —— `\` 在 Windows 是分隔符、在 Linux 只是普通字符，
 * 用平台 API 判会得出「同一份输入在两个平台上合法性相反」的结论（本仓库刚被 Linux CI 抓过
 * 同类缺陷）。这里的判据在两个平台上逐字一致。
 */
const TASK_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Windows 保留设备名。在这个平台上 `tasks/CON` 这类目录**建不出来**（报错或行为未定义），
 * 而 Linux 上完全正常 —— 同一份状态目录同步过去就会「在那边能写、在这边写不了」。
 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/**
 * 任务 id 归一：合法原样返回，非法返回 null。
 *
 * 只收字符串，也不 trim：路径两端的空格在 Windows 上会被静默裁掉、在 Linux 上不会，
 * 「帮忙归一化」本身就会造出两个平台指向不同文件的输入 —— 那正是要防的东西。
 */
export function normalizeTaskId(raw) {
  if (typeof raw !== 'string') return null
  if (!TASK_ID_RE.test(raw)) return null
  // `.` / `..` 单看是合法的一段字符，但 join 会把它们折掉：`..` 让路径跳出 tasks 目录、
  // 落到状态根上（`<状态根>/WORKING.md`）。「字符合法、语义是穿越」的输入必须单独拒。
  if (/^\.+$/.test(raw)) return null
  // 尾随点在 Windows 上被静默吃掉（`a.` 与 `a` 是**同一个**目录项），Linux 上是两个不同目录。
  // 「同一个 id 在两个平台指向不同文件夹」与本仓库刚修掉的那类平台差异同源，所以无条件拒。
  if (raw.endsWith('.')) return null
  // Windows 保留设备名同理（见上）：那个平台上建不出来，Linux 上可以。
  if (WINDOWS_RESERVED.has(raw.split('.')[0].toLowerCase())) return null
  return raw
}

/** stateRoot 的归一：非空字符串才用，否则回落 config.js 的 STATE_ROOT。 */
function rootOf(stateRoot) {
  return typeof stateRoot === 'string' && stateRoot !== '' ? stateRoot : STATE_ROOT
}

/**
 * 检查点文件路径；taskId 非法返回 null（调用方据此在写之前就拦住，而不是等 IO 报错）。
 */
export function checkpointPathFor(taskId, stateRoot) {
  const id = normalizeTaskId(taskId)
  if (id === null) return null
  return join(rootOf(stateRoot), TASKS_DIR_NAME, id, CHECKPOINT_FILE_NAME)
}

/** 缺的字段渲染成「（待补）」而不是空行。 */
function orPlaceholder(value) {
  const s = value === undefined || value === null ? '' : String(value).trim()
  return s === '' ? PLACEHOLDER : s
}

/** 列表字段渲染成 bullet；空列表给一条占位 bullet（保证节里不是空的）。 */
function bulletBlock(list) {
  const items = (Array.isArray(list) ? list : list === undefined || list === null ? [] : [list])
    .map((x) => String(x ?? '').trim())
    .filter((x) => x !== '')
  if (items.length === 0) return `- ${PLACEHOLDER}`
  return items.map((x) => `- ${x}`).join('\n')
}

/**
 * 渲染一份检查点（模板）。字段都可以缺，缺的渲染成「（待补）」。
 *
 * 刻意**不做校验**：渲染是给人补写的起点，格式问题由 `parseCheckpoint` 在读的那一端报出，
 * 这样「写进去」和「读回来判它」是两条独立的路径，不会互相掩盖。
 *
 * @param {{taskId?, project?, revision?, goal?, constraints?, done?, todo?, decisions?, refs?, toVerify?}} input
 */
export function renderCheckpoint(input) {
  const src = input && typeof input === 'object' ? input : {}
  const taskId = orPlaceholder(src.taskId)
  const revision = Number.isInteger(src.revision) && src.revision >= 0 ? src.revision : 0
  const S = CHECKPOINT_SECTIONS
  const lines = [
    `# 任务检查点 ${taskId}`,
    '',
    `- 任务：${taskId}`,
    `- 项目：${orPlaceholder(src.project)}`,
    `- revision：${revision}`,
    '',
    `## ${S[0]}`,
    '',
    `目标：${orPlaceholder(src.goal)}`,
    '',
    '约束：',
    bulletBlock(src.constraints),
    '',
    `## ${S[1]}`,
    '',
    bulletBlock(src.done),
    '',
    `## ${S[2]}`,
    '',
    bulletBlock(src.todo),
    '',
    `## ${S[3]}`,
    '',
    bulletBlock(src.decisions),
    '',
    `## ${S[4]}`,
    '',
    bulletBlock(src.refs),
    '',
    `## ${S[5]}`,
    '',
    bulletBlock(src.toVerify),
    '',
  ]
  return lines.join('\n')
}

/**
 * 「证据标记」数据表 —— **数据而不是 if 链**，因为面板与文档要能展示「凭什么算证据」，
 * 断言也要能逐条核对它。
 *
 * 取证的取向：一条「已完成」条目必须**指向一个可以去核对的东西**（命令、路径、行号、
 * 测试结果、提交哈希、外部链接、带单位的测量值）。所以刻意**不**把「测试过了」「已验证」
 * 这类**关于测试的说法**当证据 —— 那正是这个模块要抓的谎报形态：它没有让任何人能去核对。
 */
export const EVIDENCE_MARKERS = Object.freeze([
  Object.freeze({
    id: 'code_span',
    label: '反引号包裹的命令 / 路径 / 标识符',
    pattern: /`[^`\n]+`/,
  }),
  Object.freeze({
    id: 'path_with_dir',
    label: '带目录成分且带扩展名的路径',
    pattern: /\b[\w-]+(?:\/[\w.-]+)+\.[A-Za-z]{1,6}\b/,
  }),
  Object.freeze({
    id: 'file_with_ext',
    label: '带扩展名的文件名（可去核对的东西）',
    pattern: /[\w-]+\.(?:md|mjs|cjs|js|json|jsonl|yml|yaml|toml|ts|py|ps1|sh|txt|log)\b/i,
  }),
  Object.freeze({
    id: 'line_ref',
    label: '文件:行号（精确到行的定位）',
    pattern: /(?:[\w-]+\/[\w./-]*|\b[\w-]+\.[A-Za-z0-9]+):\d+(?:-\d+)?/,
  }),
  Object.freeze({
    id: 'test_result',
    label: '测试 / 断言的具体结果（带数字、PASS/FAIL 或退出码）',
    pattern:
      /\b\d+\s*(?:passed|failed)\b|\b(?:PASS|FAIL)\b|\bexit\s*code\s*[:：]?\s*\d|\d+\s*(?:个|项|条)?(?:断言|用例|测试)?\s*通过|退出码\s*[:：]?\s*\d|结果\s*[:：]\s*\d/,
  }),
  Object.freeze({
    id: 'commit_ref',
    label: 'commit / revision / sha256 后跟具体值',
    pattern: /(?:\bcommit\b|\brevision\b|\bsha256\b)[\s:：]*[0-9a-z]/i,
  }),
  Object.freeze({
    id: 'hex_ref',
    label: '看起来是提交哈希的十六进制串（含字母、至少 7 位）',
    pattern: /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i,
  }),
  Object.freeze({
    id: 'link',
    label: '可核对的外部链接',
    pattern: /https?:\/\/\S+/,
  }),
  Object.freeze({
    id: 'measurement',
    label: '带单位的具体测量值',
    pattern: /[：:]\s*\d+(?:\.\d+)?\s*(?:字节|KB|MB|GB|ms|毫秒|秒|条|项|处|个)/,
  }),
])

/** 一条条目里有没有**可以去核对**的东西。任一标记命中即算有。 */
export function hasEvidence(item) {
  const s = String(item ?? '')
  return EVIDENCE_MARKERS.some((m) => m.pattern.test(s))
}

/** 子标签行（`目标：` / `约束：`）：它们只是排版，不是内容。 */
const SUB_LABEL_RE = /^(?:目标|约束|限制|备注)\s*[:：]?\s*$/

/**
 * 两个有语义的节名：解析时按**名字**取，不用数组下标 —— 顺序虽然冻结，名字更经得起改。
 * 下标只在渲染模板（顺序即模板顺序）里用。
 */
const DONE_SECTION = '已完成与证据'
const TODO_SECTION = '未完成'

/**
 * 节内容的「实义行」：剥掉列表标记与子标签，再滤掉空行与占位符。
 *
 * 这是「有标题 ≠ 有内容」的落点：一个节只要还有一条实义行才算存在；只有一个标题、
 * 或者标题下全是「（待补）」，都算缺。
 */
function significantLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .map((line) => line.replace(/^(?:目标|约束|限制|备注)\s*[:：]\s*/, '').trim())
    .filter((line) => line !== '' && line !== PLACEHOLDER && !SUB_LABEL_RE.test(line))
}

/**
 * 把节内容切成条目：bullet（`-` / `*` / `1.`）各算一条，**不以 bullet 开头的行并入上一条**
 * （同一件事的证据常常写在换行的续行里，切开会把证据判丢）。节内的小标题不算条目。
 */
function itemsOf(text) {
  const items = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || /^#{1,6}\s/.test(line)) continue
    const bullet = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (bullet) {
      items.push(bullet[1].trim())
      continue
    }
    if (items.length === 0) items.push(line)
    else items[items.length - 1] = `${items[items.length - 1]} ${line}`.trim()
  }
  return items.filter((item) => item !== '' && item !== PLACEHOLDER)
}

/** 「没有剩余工作」的声明：它不是下一件事。只认这几种明确的收尾说法，不猜别的。 */
function isNoWork(item) {
  const s = String(item ?? '').replace(/[\s。.!！,，;；:：、]/g, '')
  if (/^(?:无|没有|暂无|尚无|无剩余|无待办|无未完成|均已?完成|全部完成|none|nothing|n\/?a)$/i.test(s)) return true
  return /^(?:无|没有|暂无|尚无)/.test(s) && s.length <= 8
}

/**
 * 解析检查点。
 *
 * 三件事分开报，因为它们对应三种不同的错：
 *   · `missing` —— 缺节，或**只有标题没有内容**（占位符不算内容）；
 *   · `claimsDoneWithoutEvidence` —— 声称完成却没有任何证据标记（本模块的主要理由）；
 *   · `malformedReason` —— 连检查点的骨架都读不出来（不是文本 / 空 / 没有任务标记 /
 *     revision 不是非负整数）。**缺节不算坏文件**：那是不完整，不是不可读。
 *
 * 绝不抛：任何输入都返回同一形状的对象。
 *
 * @returns {{taskId: string, project: string, revision: number, sections: Object,
 *            missing: string[], claimsDoneWithoutEvidence: string[],
 *            hasNextStep: boolean, malformedReason: string}}
 */
export function parseCheckpoint(text) {
  const out = {
    taskId: '',
    project: '',
    revision: 0,
    sections: {},
    missing: [],
    claimsDoneWithoutEvidence: [],
    hasNextStep: false,
    malformedReason: '',
  }
  // 六个键先铺满：调用方不必自己判 undefined，`missing` 才是「哪几节没内容」的答案。
  for (const name of CHECKPOINT_SECTIONS) out.sections[name] = ''

  if (typeof text !== 'string') {
    out.malformedReason = '内容不是文本'
    out.missing = [...CHECKPOINT_SECTIONS]
    return out
  }

  const lines = text.split(/\r?\n/)

  // 元信息只认**第一个二级及更深标题之前**的行：一级标题是本模板的文档标题（`# 任务检查点 x`），
  // 而节正文里的 `- 任务：…` 是内容、不是元信息 —— 用「二级标题」当元信息区的结束，两者都不误伤。
  let metaEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{0,3}#{2,}\s+\S/.test(lines[i])) {
      metaEnd = i
      break
    }
  }

  let revisionRaw = null
  for (let i = 0; i < metaEnd; i++) {
    const line = lines[i]
    if (out.taskId === '') {
      const m = line.match(/^[-*+]?\s*任务\s*[:：]\s*(.*)$/)
      if (m) {
        out.taskId = m[1].trim()
        continue
      }
    }
    if (out.project === '') {
      const m = line.match(/^[-*+]?\s*项目\s*[:：]\s*(.*)$/)
      if (m) {
        out.project = m[1].trim()
        continue
      }
    }
    if (revisionRaw === null) {
      const m = line.match(/^[-*+]?\s*revision\s*[:：]\s*(\S*)\s*$/i)
      if (m) revisionRaw = m[1]
    }
  }
  // 渲染出的占位符不是值 —— 回了占位符等于没写。
  if (out.taskId === PLACEHOLDER) out.taskId = ''
  if (out.project === PLACEHOLDER) out.project = ''

  let revReason = ''
  if (revisionRaw !== null) {
    if (!/^\d+$/.test(revisionRaw)) {
      revReason = `revision 不是非负整数：${revisionRaw}`
    } else {
      const n = Number(revisionRaw)
      if (!Number.isSafeInteger(n)) revReason = `revision 超出安全整数范围：${revisionRaw}`
      else out.revision = n
    }
  }

  const bodies = new Map(CHECKPOINT_SECTIONS.map((name) => [name, []]))
  let current = null
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      const level = heading[1].length
      const title = heading[2].replace(/\s*[：:]\s*$/, '').trim()
      if (CHECKPOINT_SECTIONS.includes(title)) {
        current = title
        continue
      }
      // 六节固定是二级标题：别的二级及更浅标题是节边界；`###` 更深的是节内小标题，
      // 落到下面照样进正文（它是一个节的排版结构，不是新节）。
      if (level <= 2) {
        current = null
        continue
      }
    }
    if (current !== null) bodies.get(current).push(line)
  }
  for (const name of CHECKPOINT_SECTIONS) out.sections[name] = bodies.get(name).join('\n').trim()

  out.missing = CHECKPOINT_SECTIONS.filter((name) => significantLines(out.sections[name]).length === 0)
  out.claimsDoneWithoutEvidence = itemsOf(out.sections[DONE_SECTION]).filter((item) => !hasEvidence(item))
  out.hasNextStep = itemsOf(out.sections[TODO_SECTION]).some((item) => !isNoWork(item))

  if (out.taskId === '') out.malformedReason = '缺少任务标记（- 任务：…）'
  else if (revReason !== '') out.malformedReason = revReason

  return out
}

/**
 * 读一份检查点。**所有失败都返回对象，绝不抛**（注入链上不许因为一次读失败炸掉）。
 *
 * @param {string} taskId
 * @param {{stateRoot?: string}} [opts]
 * @returns {Promise<{ok:true, path, bytes, text, taskId, project, revision, sections, missing,
 *   claimsDoneWithoutEvidence, hasNextStep, malformedReason, declaredTaskId, warnings, handle}
 *   | {ok:false, code:'invalid'|'missing'|'io_error'|'malformed', path?, error, revision?}>}
 */
export async function readCheckpoint(taskId, opts) {
  const id = normalizeTaskId(taskId)
  if (id === null) return { ok: false, code: 'invalid', error: `任务 id 非法：${JSON.stringify(taskId)}` }

  const path = checkpointPathFor(id, opts && typeof opts === 'object' ? opts.stateRoot : undefined)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, code: 'missing', path, error: '检查点文件不存在' }
    return { ok: false, code: 'io_error', path, error: String(err?.message ?? err) }
  }

  const parsed = parseCheckpoint(text)
  if (parsed.malformedReason !== '') {
    // 坏文件**不把正文交出去**：一份读不出来的东西被当成检查点用，比读不到更危险。
    return { ok: false, code: 'malformed', path, error: parsed.malformedReason, revision: parsed.revision }
  }

  // 目录名才是我们请求的身份；文件里写的 id 只当**声明**核对，不一致要说出来而不是静默采信。
  const warnings = []
  if (parsed.taskId !== id) warnings.push(`文件内声明的任务 id（${parsed.taskId}）与所在目录（${id}）不一致`)

  return {
    ok: true,
    path,
    bytes: Buffer.byteLength(text, 'utf8'),
    text,
    ...parsed,
    taskId: id,
    declaredTaskId: parsed.taskId,
    warnings,
    handle: checkpointHandleText({ taskId: id, revision: parsed.revision, project: parsed.project }),
  }
}

/**
 * 写一份检查点（原子写，覆盖旧版本）。
 *
 * 复用 `util.js` 的 `writeFileAtomic`：直写崩在中途会留下半截检查点 —— 而半截的交接材料
 * 比没有更糟（它看起来像一份状态，实际是错的）。这里**不校验内容**：校验的落点在读/解析
 * 那一端，写路径只守体积与原子性。写进去的东西至少是完整的一份，能被读出来判它坏。
 *
 * ⚠️ 本模块不实现锁：并发写同一个 taskId 由**调用方串行**（进程内用 createWriteQueue）。
 *
 * @param {string} taskId
 * @param {string} text
 * @param {{stateRoot?: string}} [opts]
 * @returns {Promise<{ok:true, bytes:number, path:string} | {ok:false, code:'invalid'|'too_big'|'io_error', ...}>}
 */
export async function writeCheckpoint(taskId, text, opts) {
  const id = normalizeTaskId(taskId)
  if (id === null) return { ok: false, code: 'invalid', error: `任务 id 非法：${JSON.stringify(taskId)}` }
  if (typeof text !== 'string') return { ok: false, code: 'invalid', error: '检查点正文必须是字符串' }

  // 按 UTF-8 字节算，不是字符数 —— 一份中文检查点的字符数只有字节数的三分之一，
  // 用字符数当闸门等于把上限放大三倍。
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > CHECKPOINT_MAX_BYTES) {
    return {
      ok: false,
      code: 'too_big',
      bytes,
      limit: CHECKPOINT_MAX_BYTES,
      error: `检查点 ${bytes} 字节，超过上限 ${CHECKPOINT_MAX_BYTES} 字节`,
    }
  }

  const path = checkpointPathFor(id, opts && typeof opts === 'object' ? opts.stateRoot : undefined)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFileAtomic(path, text)
  } catch (err) {
    return { ok: false, code: 'io_error', path, error: String(err?.message ?? err) }
  }
  return { ok: true, bytes, path }
}

/** 注入用的短句柄硬上限（字节）。它要跟正文抢上下文，不能自己长起来。 */
const HANDLE_MAX_BYTES = 160

/** 按**码点**截断到不超过 maxBytes 字节：不许把一个字符切成半个（注入文本里会变 U+FFFD）。 */
function truncateByBytes(s, maxBytes) {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (used + b > maxBytes) break
    out += ch
    used += b
  }
  return out
}

/**
 * 注入用的短句柄（一行，≤ 160 字节）：说清「有这个检查点、revision 几、怎么读」。
 *
 * 预算是硬的，所以按优先级退化：**id 与 revision 不可丢**（它们才是身份），项目是可选线索
 * （放不下就截短或整个丢掉），最后连「重复一次 id 的完整相对路径」放不下时（64 字符的
 * 极端 id），退成不含重复路径的说法。绝不把多字节字符截半个。taskId 非法返回 ''。
 *
 * revision 缺省按 0（与 renderCheckpoint 的缺省一致）。
 */
export function checkpointHandleText({ taskId, revision, project } = {}) {
  const id = normalizeTaskId(taskId)
  if (id === null) return ''
  const rev = Number.isInteger(revision) && revision >= 0 ? revision : 0
  const proj = String(project ?? '').replace(/\s+/g, ' ').trim()

  const head = `检查点 ${id}（revision ${rev}）：`
  const detail = `读 tasks/${id}/WORKING.md`
  const tail = '，续做前先读'
  const build = (p) => `${head}${p === '' ? '' : `项目 ${p}，`}${detail}${tail}`

  let line = build(proj)
  if (Buffer.byteLength(line, 'utf8') > HANDLE_MAX_BYTES) {
    // 项目放不下：按剩余预算截断它，截不下就整个丢掉。
    const fixed = Buffer.byteLength(build(''), 'utf8')
    const room = HANDLE_MAX_BYTES - fixed - Buffer.byteLength('项目 ，', 'utf8')
    line = build(room > 0 ? truncateByBytes(proj, room) : '')
  }
  if (Buffer.byteLength(line, 'utf8') > HANDLE_MAX_BYTES) {
    // 到这儿只剩「id 太长」一种可能：完整相对路径（id 出现两次）放不下，退成不重复的写法。
    line = `${head}读 ${TASKS_DIR_NAME}/${CHECKPOINT_FILE_NAME}`
  }
  return line
}
