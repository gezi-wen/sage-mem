/**
 * sage-mem 记忆层 —— 展示层：缺口状态卡。
 *
 * 为什么要有这张卡：模型不知道检索层「找到了但没给」，于是它会在「本来有依据」的
 * 情况下凭印象回答 —— 那正是最难查的一类错答。所以只在**真有缺口**时插一句，
 * 说清范围、缺口条数、一条可做的动作。
 *
 * 反向同样重要：没有缺口时必须返回空串。一张每轮都出现的提示会被当噪音忽略，
 * 等真有缺口时它就没有说服力了。
 *
 * 纯函数：不读盘、不看时钟；同一份输入永远给同一张卡。
 */

/** 卡片硬上限。它是**预算**，不是建议：超了宁可少说一句线索，也不许悄悄多占上下文。 */
export const STATUS_MAX_BYTES = 512

/** 显示用的字段上限。这些字符串来自记忆内容，长度不可控 —— 不钳制就没有可证的字节上界。 */
const CLIP = Object.freeze({ needle: 24, dir: 48, file: 32 })

/** 计数显示上限：卡片是给人看的，六位数以上没有信息量，钳制后字节上界才可证。 */
const COUNT_MAX = 999999

/**
 * 范围标签。非法值回落「全部」——
 * 与 `search.normalizeScope` 同一口径：**不静默降级成摘要**，否则卡片会谎报查了什么。
 */
function scopeLabel(raw) {
  const k = String(raw ?? '').trim().toLowerCase()
  if (k === 'summary') return '摘要'
  if (k === 'body') return '正文'
  return '全部'
}

/** 计数归一：负数 / NaN / 字符串一律当 0，卡片不该因为一个坏数字整张消失。 */
function count(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function countText(n) {
  return n > COUNT_MAX ? `${COUNT_MAX}+` : String(n)
}

/**
 * 字段归一：折叠空白并去首尾。
 *
 * 换行必须折掉 —— 逐行裁剪的前提是「一行 = 一句完整的话」，
 * 字段自带换行会把卡片拆出半截行，让「不许把句子截半」这条直接失效。
 */
function str(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim()
}

/** 按字符截断（走码点，不切出半个代理对），超长用省略号收尾。 */
function clipChars(s, maxChars) {
  const chars = Array.from(s)
  if (chars.length <= maxChars) return s
  return chars.slice(0, Math.max(0, maxChars - 1)).join('') + '…'
}

/** 按 UTF-8 字节截断：中文一个字三个字节，按字符数算会超三倍。 */
function clipBytes(s, maxBytes) {
  if (maxBytes <= 0) return ''
  if (byteLen(s) <= maxBytes) return s
  const room = maxBytes - byteLen('…')
  if (room <= 0) return ''
  let out = ''
  let used = 0
  for (const ch of s) {
    const b = byteLen(ch)
    if (used + b > room) break
    out += ch
    used += b
  }
  return out + '…'
}

function byteLen(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8')
}

function normalizeBest(best) {
  if (!best || typeof best !== 'object') return null
  const file = str(best.file)
  const title = str(best.title)
  return file || title ? { file, title } : null
}

function gapHeader(scope, scanned, injected, unread, omitted) {
  const parts = []
  if (unread > 0) parts.push(`有 ${countText(unread)} 条相关候选还没读`)
  if (omitted > 0) parts.push(`另有 ${countText(omitted)} 条因预算省略`)
  return `sage-mem：按「${scope}」范围扫了 ${countText(scanned)} 份记忆，${parts.join('，')}，本次注入 ${countText(injected)} 条正文。`
}

function missHeader(scope, scanned) {
  return `sage-mem：按「${scope}」范围扫了 ${countText(scanned)} 份记忆，摘要里没有命中。`
}

/** 工具不可用时的说法：不许出现工具名（模型会去调一个不存在的工具）。 */
function missAction({ tools, needle, memoryDir }) {
  if (tools) {
    const retry = needle ? `换个说法（例如「${needle}」）用 search_memory 再搜一次` : '换个说法用 search_memory 再搜一次'
    return `可以${retry}，或按文件名用 read_memory 读正文。`
  }
  return memoryDir
    ? `可以直接打开记忆目录 ${memoryDir}，按文件名翻查相关记忆。`
    : '可以直接打开记忆目录，按文件名翻查相关记忆。'
}

/**
 * 缺口卡的动作必须**可执行**：「省略了 N 条」只有统计没有下一步，
 * 模型读完照样不知道该干什么，等于白占额度。
 */
function gapAction({ tools, needle, memoryDir, best }) {
  const file = best && best.file ? clipChars(best.file, CLIP.file) : ''
  if (tools) {
    const hint = needle ? `用 search_memory 搜「${needle}」` : '用 search_memory 继续翻候选'
    return file
      ? `动作：${hint}，再按文件名 ${file} 用 read_memory 读全文。`
      : `动作：${hint}，再用 read_memory 按文件名读全文。`
  }
  const where = memoryDir ? `记忆目录 ${memoryDir}` : '记忆目录'
  return file
    ? `动作：直接打开${where}里的 ${file}，读那份记忆的正文。`
    : `动作：直接打开${where}，按文件名翻查相关候选。`
}

/**
 * 最佳线索行。放不下时只留最长的那个字段并按剩余字节截断，
 * 但**句子照旧以句号收尾** —— 截半句比少说一句更难读，也更容易被误读。
 */
function bestLine(best, room) {
  if (!best) return ''
  const head = '最佳线索：'
  const end = '。'
  const title = best.title
  const file = best.file
  if (!title && !file) return ''
  const full = title && file
    ? `${head}${title}（${clipChars(file, CLIP.file)}）${end}`
    : `${head}${clipChars(title || file, CLIP.file * 2)}${end}`
  if (byteLen(full) <= room) return full
  const field = title.length >= file.length ? title : file
  const fieldRoom = room - byteLen(head) - byteLen(end)
  if (fieldRoom < 8) return ''
  return `${head}${clipBytes(field, fieldRoom)}${end}`
}

/**
 * 拼卡：先给「头」与「动作」留额度，剩下的才给线索。
 *
 * 这个顺序有理由：动作是这张卡存在的意义（模型据此知道下一步干什么），
 * 线索只是佐料。若按显示顺序先装线索，一条超长标题就能把动作挤出 512 字节。
 * 兜底再按行丢一次 —— 只是保险，钳制后的正常路径不该走到那里。
 */
function assemble(header, action, buildBest) {
  const used = byteLen(header) + byteLen(action) + (header && action ? 1 : 0)
  const room = STATUS_MAX_BYTES - used - 1
  const best = room > 0 ? buildBest(room) : ''
  const out = [header, best, action].filter(s => s).join('\n')
  if (byteLen(out) <= STATUS_MAX_BYTES) return out
  const kept = []
  let acc = 0
  for (const line of [header, action, best]) {
    if (!line) continue
    const add = byteLen(line) + (kept.length ? 1 : 0)
    if (acc + add > STATUS_MAX_BYTES) continue
    kept.push(line)
    acc += add
  }
  return [header, best, action].filter(l => l && kept.includes(l)).join('\n')
}

/**
 * 「有矛盾待裁决」那句话（2.0.0）。
 *
 * 为什么必须是**固定一句 + 具体条数**：卡片按内容签名去重（`lib/recall/compose.js`），
 * 签名里不带条数的话，第二封（条数变了）发不出去；而条数不变时重复发同一句就是刷屏。
 * 为什么必须发：抑制是「记忆不再进正文」——用户不看面板时，那是唯一会自己撞进视线的提示
 * （D27 拒绝先上抑制的理由正是「用户无从得知」）。
 */
function conflictNotice(pending) {
  return `sage-mem：另有 ${countText(pending)} 条矛盾待裁决，相关记忆本轮未注入正文。`
}

/**
 * 把冲突提示并进卡片，且**保住 512 字节预算**。
 *
 * 冲突提示是这一版新增的「必须可见」项，所以它优先于「最佳线索」：放不下时先丢线索，
 * 再放不下就只发这一句 —— 一张只剩提示的卡仍然成立，一张把提示挤掉的卡不成立。
 */
function withConflictNotice(card, notice) {
  if (!notice) return card
  if (!card) return notice
  const joined = `${card}\n${notice}`
  if (byteLen(joined) <= STATUS_MAX_BYTES) return joined
  return notice
}

/**
 * 渲染缺口状态卡。返回 `''` = 本次不该注入任何提示。
 *
 * 三条判定（顺序即优先级）：
 *   1. 没有缺口（unread=0 且 omitted=0）且注入了正文 → `''`，没有缺口就不要说话；
 *      但**有矛盾待裁决时例外**：抑制必须可见，那是一句独立的提示；
 *   2. 没有缺口、也没有注入 → 摘要未命中那一句 + 建议；
 *   3. 有缺口（有候选没读，或有候选被预算省略）→ 范围 + 条数 + 最佳线索 + 一个动作。
 *
 * ⚠️ 第 2 条要求「确实一条都没找到」。`omitted > 0` 时那是有候选、只是没给，
 * 说「摘要里没有命中」是**谎报故障类型** —— 而这张卡的整个意义就是把
 * 「没找到」与「找到了但没展示」分开，所以有省略时一律走第 3 条。
 *
 * @param {object} input `{scope, scanned, injected, omitted, unread, best, needle, toolsAvailable, memoryDir, pendingConflicts}`
 * @returns {string} 卡片文本，或 `''`
 */
export function renderStatusCard(input = {}) {
  const i = input ?? {}
  const scope = scopeLabel(i.scope)
  const scanned = count(i.scanned)
  const injected = count(i.injected)
  const omitted = count(i.omitted)
  const unread = count(i.unread)
  // 严格认 `true`：拿不到 tools 服务时调用方给的就是 false/undefined，两种情况都该走降级文案。
  const tools = i.toolsAvailable === true
  const needle = clipChars(str(i.needle), CLIP.needle)
  const memoryDir = clipChars(str(i.memoryDir), CLIP.dir)
  const best = normalizeBest(i.best)
  const pending = count(i.pendingConflicts)
  const notice = pending > 0 ? conflictNotice(pending) : ''

  const gap = unread > 0 || omitted > 0
  if (!gap && injected > 0) return notice

  if (!gap) {
    return withConflictNotice(assemble(missHeader(scope, scanned), missAction({ tools, needle, memoryDir }), () => ''), notice)
  }
  return withConflictNotice(
    assemble(
      gapHeader(scope, scanned, injected, unread, omitted),
      gapAction({ tools, needle, memoryDir, best }),
      room => bestLine(best, room),
    ),
    notice,
  )
}
