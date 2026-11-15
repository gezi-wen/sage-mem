/**
 * 裁段归档的**规划器**（`lib/memory/trim-plan.js`）—— 六条不变量逐条钉住。
 *
 * 为什么这套测试值得写这么多条：这个纯函数决定了「用户记忆的哪一段会被搬走、剩下的正文长什么样」。
 * 它算错一个字节，落盘那一侧就会把一条好好的记忆写成残的。而它**不碰磁盘**，
 * 所以这里能把每条判据都造出来、几百毫秒跑完，不需要临时目录。
 *
 * 最要紧的一条是第 6 组的**往返断言**：
 *   把 `remaining` 里的 pointer 换回 `segment`，必须**逐字节**等于原文。
 * 它不是「再测一遍切片」（切片是 `slice` 的实现细节），而是**用户视角的可逆性**：
 * 「我能不能确认，除了指针那一行，这份文件一个字都没被改过」。
 *
 * 写法照 `test/archive-index-test.mjs`：自研 `ok()` + 每个断言打 `  PASS <名>` + 结尾结果行。
 */
import { isPlainMdName } from '../lib/shared/md-name.js'
import { planTrim } from '../lib/memory/trim-plan.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) } else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`) }
}
const group = (t) => console.log(`== ${t} ==`)

/** 固定时间戳：**本地时间**构造，`stampDate` / `stampHuman` 都按本地时区格式化，任何时区下结果一致。 */
const AT = new Date(2026, 10, 15, 9, 30, 0).getTime()
const REASON = '体积治理'

/**
 * 夹具：frontmatter + 标题 + 一个「旧段」小节 + 一个新段 + 长尾。
 *
 * 行号（1-based，`content.split(/\r?\n/)` 口径）：
 *   1 --- ／ 2 name ／ 3 description ／ 4 type ／（extraFm）／ 闭合 --- ／ 空行 ／ # 标题 ／ 空行
 *   9 ## 旧段 ／ 空行 ／ 11-30 旧段正文（20 行）／ 空行 ／ 32 ## 新段 ／ 空行 ／ 长尾 ／ 末尾空行
 */
function docOf({ eol = '\n', oldLines = 20, tail = 400, extraFm = [], second = '## 新段', title = '## 旧段' } = {}) {
  const old = Array.from({ length: oldLines }, (_, i) => `旧段第 ${i} 行 ` + '内容'.repeat(20)).join(eol)
  const lines = [
    '---',
    'name: 甲',
    'description: 体积治理夹具',
    'type: project',
    ...extraFm,
    '---',
    '',
    '# 标题',
    '',
    title,
    '',
    old,
    '',
    second,
    '',
    '尾巴 '.repeat(tail),
    '',
  ]
  return lines.join(eol)
}

const planOf = (content, selector, extra = {}) =>
  planTrim({ content, name: 'note.md', selector, reason: REASON, at: AT, ...extra })

/** 往返：把指针换回被裁段。用函数式替换 —— 直接传字符串会让 `$&`、`$1` 被当成捕获组引用。 */
const roundTrip = (r) => r.remaining.replace(r.pointer, () => r.segment)

console.log('== 0. 前置：夹具本身就是合法输入 ==')
{
  const src = docOf()
  const r = planOf(src, { heading: '旧段' })
  ok(r.ok === true, '（前提）基准夹具能裁成功', r.ok ? '' : `${r.code} ${r.error}`)
  ok(r.ok && r.range.start > 4 && r.range.end < src.split('\n').length, '（前提）被裁段落在正文里，不碰首尾')
}

console.log('== 1. 不变量 1：必须以 frontmatter 起始，且 remaining 仍带完整 frontmatter ==')
{
  const src = docOf()
  const r = planOf(src, { heading: '旧段' })
  const fm = '---\nname: 甲\ndescription: 体积治理夹具\ntype: project\n---'
  ok(r.ok && r.remaining.startsWith(fm), 'remaining 仍以**完整**的 frontmatter 起始（含收尾 ---）', r.ok ? r.remaining.slice(0, 60) : '')
  ok(r.ok && !r.segment.includes('name: 甲'), '被裁段不含源 frontmatter（第 7 条不变量）')
  ok(r.ok && r.segment.trimStart().startsWith('## 旧段'), 'segment 从选中的标题行开始')

  const noFm = planOf(['# 没有 frontmatter', '', '正文 '.repeat(400), '', '## 小节', '', '内容 '.repeat(400)].join('\n'), { heading: '小节' })
  ok(noFm.ok === false && noFm.code === 'no_frontmatter', '正文没有 frontmatter → no_frontmatter', JSON.stringify(noFm))

  const unclosed = planOf(['---', 'name: 甲', '', '## 小节', '', '内容 '.repeat(400)].join('\n'), { heading: '小节' })
  ok(unclosed.ok === false && unclosed.code === 'no_frontmatter', 'frontmatter 没闭合（只有开头 ---）→ no_frontmatter', JSON.stringify(unclosed))

  const bom = '\ufeff' + docOf()
  const onBom = planOf(bom, { heading: '旧段' })
  ok(onBom.ok === true, '带 BOM 的文件仍可裁（BOM 不是 --- 的一部分，但行首 BOM 单独容忍）', onBom.ok ? '' : onBom.code)
  ok(onBom.ok && onBom.remaining.startsWith('\ufeff---'), 'BOM 原样保留在 remaining 里（不去掉用户的字节）')
}

console.log('== 2. 不变量 2：行号选择器不许触到 frontmatter 区（selector_invalid）==')
{
  const src = docOf()
  const inside = planOf(src, { startLine: 2, endLine: 30 })
  ok(inside.ok === false && inside.code === 'selector_invalid', 'startLine 落在 frontmatter 里 → selector_invalid', JSON.stringify(inside))

  const atClosing = planOf(src, { startLine: 5, endLine: 30 })
  ok(atClosing.ok === false && atClosing.code === 'selector_invalid', 'startLine 正好是闭合 --- 那一行 → selector_invalid', JSON.stringify(atClosing))

  const onlyBlank = planOf(src, { startLine: 6, endLine: 6 })
  ok(onlyBlank.ok === false && onlyBlank.code === 'selector_invalid', '只选到空行（frontmatter 后那行）→ selector_invalid', JSON.stringify(onlyBlank))

  const whole = planOf(src, { startLine: 1, endLine: src.split('\n').length })
  ok(whole.ok === false && whole.code === 'selector_invalid', '从第 1 行开始整份搬走 → selector_invalid（整份归档另有入口）')

  const okRange = planOf(src, { startLine: 9, endLine: 30 })
  ok(okRange.ok === true && okRange.range.start === 9 && okRange.range.end === 30, '正文区间可以裁，range 原样回显', okRange.ok ? JSON.stringify(okRange.range) : `${okRange.code} ${okRange.error}`)
}

console.log('== 3. 不变量 3：段 ≥ 1024 字节、剩余 ≥ 1024 字节 ==')
{
  const tiny = docOf({ oldLines: 1, tail: 400 }).replace('旧段第 0 行 ', '')
  const small = planOf(tiny, { heading: '旧段' })
  ok(small.ok === false && small.code === 'segment_too_small', '被裁段不到 1 KB → segment_too_small', JSON.stringify(small))

  const nearlyAll = docOf({ oldLines: 60, tail: 1 })
  const tooMuch = planOf(nearlyAll, { heading: '旧段' })
  ok(tooMuch.ok === false && tooMuch.code === 'remain_too_small', '裁完只剩一丁点 → remain_too_small（该走整份归档）', JSON.stringify(tooMuch))

  // 边界：刚好等于下限也要过（判据是 `<`，不是 `<=`）。
  const seg1024 = 'a'.repeat(1024)
  const exact = ['---', 'name: 甲', '---', '', '## 边', '', seg1024, '', '## 后', '', '尾 '.repeat(400), ''].join('\n')
  const edge = planOf(exact, { heading: '边' })
  ok(edge.ok === true && edge.segment === `## 边\n\n${seg1024}`, '被裁段正好 1024 字节 → 通过（下限含等号）', edge.ok ? '' : `${edge.code} ${edge.error}`)
}

console.log('== 4. 不变量 4：标题找不到 / 重名不猜 ==')
{
  const src = docOf()
  const none = planOf(src, { heading: '不存在的小节' })
  ok(none.ok === false && none.code === 'heading_not_found', '标题找不到 → heading_not_found', JSON.stringify(none))

  const dup = docOf({ second: '## 旧段' })
  const amb = planOf(dup, { heading: '旧段' })
  ok(amb.ok === false && amb.code === 'heading_ambiguous', '同一标题出现两次 → heading_ambiguous', JSON.stringify(amb))

  // 大小写不算重复（比较时归一）：英文标题只出现一次就该裁得动。
  const en = docOf({ title: '## Old Notes', second: '## Next' })
  const enOk = planOf(en, { heading: 'old notes' })
  ok(enOk.ok === true, '英文标题大小写不敏感（old notes 命中 Old Notes）', enOk.ok ? '' : `${enOk.code} ${enOk.error}`)

  const withHash = planOf(src, { heading: '## 旧段' })
  ok(withHash.ok === true, '选择器带 # 也认（内部会剥掉）', withHash.ok ? '' : `${withHash.code} ${withHash.error}`)

  const h3 = docOf({ title: '### 三级小节' })
  const three = planOf(h3, { heading: '三级小节' })
  ok(three.ok === true && three.range.start === 9, '三级小节也能选（契约提到二级/三级）', three.ok ? '' : `${three.code} ${three.error}`)
  ok(three.ok && !three.segment.includes('## 新段'), '段在下一个同级或更高级标题前收住（不吃掉后一节）')
}

console.log('== 5. 不变量 5：archiveName = <原名去 .md>-<slug>-<YYYYMMDD>.md，且过 isPlainMdName ==')
{
  const r = planOf(docOf(), { heading: '旧段' })
  ok(r.ok && r.archiveName === 'note-旧段-20261115.md', '默认形状：原名-标题-日期.md', r.ok ? r.archiveName : '')
  ok(r.ok && isPlainMdName(r.archiveName), 'archiveName 过 isPlainMdName', r.ok ? r.archiveName : '')

  const sluggy = planOf(docOf({ title: '## 路径 a/b:c 段落' }), { heading: '路径 a/b:c 段落' })
  ok(sluggy.ok === true, '（前提）带非法字符的标题能选中', sluggy.ok ? '' : `${sluggy.code} ${sluggy.error}`)
  ok(sluggy.ok && isPlainMdName(sluggy.archiveName), '标题里有 / : 之类 → slug 去掉它们后仍过 isPlainMdName', sluggy.ok ? sluggy.archiveName : '')
  ok(sluggy.ok && !/[/\\:*?"<>|]/.test(sluggy.archiveName), 'archiveName 里没有任何文件名保留字符', sluggy.ok ? sluggy.archiveName : '')

  const symbolsOnly = planOf(docOf({ title: '## ///' }), { heading: '///' })
  ok(symbolsOnly.ok === true && symbolsOnly.archiveName === 'note-section-20261115.md', '标题去掉后为空 → slug 用 section', symbolsOnly.ok ? symbolsOnly.archiveName : `${symbolsOnly.code} ${symbolsOnly.error}`)

  const longTitle = '很长的标题'.repeat(30)
  const longName = planOf(docOf({ title: `## ${longTitle}` }), { heading: longTitle })
  const slugPart = longName.ok ? longName.archiveName.replace(/^note-/, '').replace(/-\d{8}\.md$/, '') : ''
  ok(longName.ok && Array.from(slugPart).length <= 40, `slug 长度 ≤ 40（实际 ${Array.from(slugPart).length}）`, slugPart)

  // slug 会**去掉**空白（契约 §2 第 5 条「去空白」），所以 `旧段第 0 行` 变成 `旧段第0行`。
  const byLines = planOf(docOf(), { startLine: 11, endLine: 30 })
  ok(byLines.ok && byLines.archiveName.startsWith('note-旧段第0行') && byLines.archiveName.endsWith('-20261115.md'), '行号选择器的 slug 取首行实义词（去掉空白）', byLines.ok ? byLines.archiveName : `${byLines.code} ${byLines.error}`)
  ok(byLines.ok && isPlainMdName(byLines.archiveName), '行号选择器算出的 name 也过 isPlainMdName')
  ok(planOf('x', { heading: 'a' }, { name: 'notes' }).code === 'invalid_name', '名字不是 .md → invalid_name')
  ok(planOf(docOf(), { heading: '旧段' }, { name: 'dir/note.md' }).code === 'invalid_name', '名字带路径成分 → invalid_name（防穿越）')
}

console.log('== 6. 不变量 6：pointer 一行、前后各一空行、其余一字不动（往返断言）==')
{
  const src = docOf()
  const r = planOf(src, { heading: '旧段' })
  ok(r.ok === true, '（前提）基准裁段成功', r.ok ? '' : `${r.code} ${r.error}`)
  ok(!r.pointer.includes('\n'), 'pointer 只有一行')
  ok(r.pointer === `> 这段旧内容已归档到 archive/${r.archiveName}（2026-11-15，缘由：${REASON}）`, 'pointer 文案与契约逐字一致', r.pointer)
  ok(r.remaining.split(r.pointer).length - 1 === 1, '指针在 remaining 里只出现一次（往返断言的前提）')
  ok(roundTrip(r) === src, '**往返**：把 pointer 换回 segment，逐字节还原原文')
  const at = r.remaining.indexOf(r.pointer)
  ok(r.remaining.slice(0, at).endsWith('\n\n'), '指针**前**留一个空行')
  ok(r.remaining.slice(at + r.pointer.length).startsWith('\n\n'), '指针**后**留一个空行')
  ok(r.remaining.includes('\n\n' + r.pointer + '\n\n'), '指针上下各一整行空白（不靠行尾拼出来）')
  ok(src.includes(r.segment), 'segment 是原文里的一段（不是重新拼出来的）')
  ok(r.remaining.length < src.length, '裁完确实变短了')
  ok(roundTrip(planOf(src, { startLine: 11, endLine: 30 })) === src, '行号选择器同样满足往返')
  ok(planTrim({ content: src, name: 'note.md', selector: { heading: '旧段' }, reason: REASON, at: AT }).remaining === r.remaining, '纯函数：同参同结果（确定性）')
}

console.log('== 7. CRLF 与混排换行：不许把用户的换行归一 ==')
{
  const crlf = docOf({ eol: '\r\n' })
  const r = planOf(crlf, { heading: '旧段' })
  ok(r.ok === true, '（前提）CRLF 文件能裁', r.ok ? '' : `${r.code} ${r.error}`)
  ok(r.ok && roundTrip(r) === crlf, 'CRLF 文件往返还原逐字节成立')
  ok(r.ok && r.segment.includes('\r\n'), '被裁段保留 CRLF')
  ok(r.ok && r.remaining.includes('\r\n'), 'remaining 保留 CRLF')
  ok(r.ok && !r.remaining.replace(/\r\n/g, '').includes('\n'), 'remaining 里没有半截 LF（CRLF 没被拆成两半）', r.ok ? JSON.stringify(r.remaining.slice(0, 40)) : '')

  // 混排：段落前面用 LF、后面用 CRLF —— 偏移按实际换行长度累加，往返必须仍然成立。
  const lf = docOf()
  const mixed = lf.replace('## 新段\n\n尾巴', '## 新段\r\n\r\n尾巴')
  ok(mixed !== lf, '（前提）夹具真的被改成混排了')
  const m = planOf(mixed, { heading: '旧段' })
  ok(m.ok === true, '（前提）混排文件能裁', m.ok ? '' : `${m.code} ${m.error}`)
  ok(m.ok && roundTrip(m) === mixed, '混排换行的文件往返仍然逐字节成立')
}

console.log('== 8. reason：必填、≥4 字、压成一行 ==')
{
  const src = docOf()
  ok(planOf(src, { heading: '旧段' }, { reason: '' }).code === 'reason_too_short', '空缘由 → reason_too_short')
  ok(planOf(src, { heading: '旧段' }, { reason: '整理' }).code === 'reason_too_short', '不足 4 个字 → reason_too_short')
  ok(planOf(src, { heading: '旧段' }, { reason: '   ' }).code === 'reason_too_short', '只有空白 → reason_too_short')
  ok(planOf(src, { heading: '旧段' }, { reason: undefined }).code === 'reason_too_short', '完全不传 → reason_too_short')

  const multiline = planOf(src, { heading: '旧段' }, { reason: '第一行\n第二行缘由' })
  ok(multiline.ok === true, '多行缘由可用（会被压成一行）', multiline.ok ? '' : `${multiline.code} ${multiline.error}`)
  ok(multiline.ok && !multiline.pointer.includes('\n'), '多行缘由不会把指针劈成两行')
  ok(multiline.ok && multiline.reason === '第一行 第二行缘由', '返回的 reason 是归一后的一行（落盘侧直接用它）', multiline.ok ? JSON.stringify(multiline.reason) : '')
  ok(multiline.ok && roundTrip(multiline) === src, '带多行缘由时往返仍成立')
  ok(multiline.ok && multiline.sourceMeta.name === '甲' && multiline.sourceMeta.type === 'project', 'sourceMeta 带出来源 frontmatter（name/type）', multiline.ok ? JSON.stringify(multiline.sourceMeta) : '')
}

console.log('== 9. 选择器形状：二选一，不猜 ==')
{
  const src = docOf()
  ok(planOf(src, undefined).code === 'selector_invalid', '没有选择器 → selector_invalid')
  ok(planOf(src, {}).code === 'selector_invalid', '空选择器 → selector_invalid')
  ok(planOf(src, { heading: '旧段', startLine: 11, endLine: 30 }).code === 'selector_invalid', '既给 heading 又给行号 → selector_invalid')
  ok(planOf(src, { heading: '   ' }).code === 'selector_invalid', 'heading 只有空白 → selector_invalid')
  ok(planOf(src, { startLine: '11', endLine: 30 }).code === 'selector_invalid', '行号是字符串 → selector_invalid（不隐式转换）')
  ok(planOf(src, { startLine: 30, endLine: 11 }).code === 'selector_invalid', 'endLine < startLine → selector_invalid')
  ok(planOf(src, { startLine: 11 }).code === 'selector_invalid', '只给 startLine → selector_invalid')
  ok(planOf(src, { startLine: 11, endLine: 9999 }).code === 'selector_invalid', 'endLine 超出行数 → selector_invalid')
  ok(planOf(src, { startLine: 0, endLine: 30 }).code === 'selector_invalid', '行号 0（0-based 误用）→ selector_invalid')
}

console.log('== 10. 段首尾空行：空行留给「周围」，不写进归档件 ==')
{
  // 段落上下的空行如果被算进段里，指针就会被挤到贴着上一行文字的位置（没有空行）。
  const src = docOf()
  const r = planOf(src, { heading: '旧段' })
  ok(r.ok && !r.segment.startsWith('\n') && !r.segment.endsWith('\n'), '被裁段首尾都没有多余空行', r.ok ? JSON.stringify(r.segment.slice(0, 8)) : '')
  const byLines = planOf(src, { startLine: 10, endLine: 31 }) // 用户把两边的空行也框进来
  ok(byLines.ok && byLines.range.start === 11 && byLines.range.end === 30, '行号选择器把首尾空行剔掉（range 回显真实范围）', byLines.ok ? JSON.stringify(byLines.range) : `${byLines.code} ${byLines.error}`)
  ok(byLines.ok && roundTrip(byLines) === src, '剔空行后往返仍成立（空行留在前后缀里）')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
