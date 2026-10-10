#!/usr/bin/env node
/**
 * 重出 README / 市场的展示图（**显式动作，不挂进 npm test**）。
 *
 *     npm run images                     # 重出全部 7 张（6 张展示图 + docs/starmap.png）
 *     npm run images -- --html-only      # 只出 HTML（不截图），用来核对文案/结构
 *     npm run images -- --against <dir>  # 顺便把 <dir> 里的 .md 文件名逐个对一遍（脱敏）
 *     npm run images -- --keep           # 保留中间产物（HTML 与原始截图）
 *
 * 为什么要有这个脚本：出图管线原来只在仓库外，界面一改，README 上的图就**静默变成旧的**。
 * 现在屏定义在 `test/client-render-test.mjs` 的 `emitPreview()` 里**只有一份**，
 * 这里只读它写出的 manifest（`client-preview-manifest.json`）：
 *   - 出图脚本**不按下标取图**，只认 manifest 的 id —— 插一屏不会让别的图静默换内容；
 *   - manifest 里的 `out` 就是发布路径，README 与市场（screenshots.json）共用同一批文件。
 *
 * 依赖：只用 `node:` 内置 + 一个本机浏览器（Edge/Chrome）做无头截图。
 * PNG 的裁剪/re-encode 由本文件自带的极简 codec 完成（zlib 内置），不引第三方包。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ARGS = process.argv.slice(2)
const has = (f) => ARGS.includes(f)
const argOf = (f) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : null }

/**
 * 图宽与可视高度：默认 1120（README 里按容器缩放），高度给足再按内容裁掉底部空白。
 *
 * `SAGE_MEM_IMG_WIDTH` 可以覆盖宽度 —— 用来检查**窄窗口下的换行行为**：
 * 头部带那类 `flex-wrap` 容器在 1120 宽下永远排得开，溢出问题只有窗口窄了才露出来。
 */
const WIDTH = Number(process.env.SAGE_MEM_IMG_WIDTH) || 1120
const WINDOW_HEIGHT = 1500
/** 底部留白：与已提交的那批图保持一致。 */
const BOTTOM_PAD = 26
/** 单张体积上限（验收要求 ≤300KB，6 张合计 ≤1.5MB）。 */
const MAX_BYTES = 300 * 1024

// ── 极简 PNG 编解码（只支持 8bit / 非隔行 / RGB 或 RGBA，够用）─────────────────
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let off = 8
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      depth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`只支持 8bit 非隔行（depth=${depth} interlace=${interlace}）`)
  if (colorType !== 2 && colorType !== 6) throw new Error(`只支持 RGB/RGBA（colorType=${colorType}）`)
  const bpp = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const dst = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dst[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      let v = src[x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      dst[x] = v & 255
    }
  }
  return { width, height, bpp, data: out }
}
function encodePng(img) {
  const { width, height, bpp, data } = img
  const stride = width * bpp
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = bpp === 4 ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const px = (img, x, y) => { const i = y * img.width * img.bpp + x * img.bpp; return [img.data[i], img.data[i + 1], img.data[i + 2]] }

/** 按内容裁掉底部空白（背景取左上角像素），保持原宽。 */
function trimPng(file) {
  const img = decodePng(readFileSync(file))
  const [br, bg, bb] = px(img, 2, 2)
  let last = img.height - 1
  for (; last > 0; last--) {
    let hit = false
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = px(img, x, last)
      if (Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) > 12) { hit = true; break }
    }
    if (hit) break
  }
  const h = Math.min(img.height, last + BOTTOM_PAD)
  if (h === img.height) return { buffer: encodePng(img), width: img.width, height: img.height }
  const cropped = { width: img.width, height: h, bpp: img.bpp, data: img.data.subarray(0, h * img.width * img.bpp) }
  // 自检：编完再解一遍，尺寸与若干像素必须对得上（量具自己也要被量）
  const enc = encodePng(cropped)
  const back = decodePng(enc)
  if (back.width !== cropped.width || back.height !== cropped.height) throw new Error('PNG 自检失败：尺寸不一致')
  for (const [x, y] of [[0, 0], [cropped.width - 1, h - 1], [Math.floor(cropped.width / 2), Math.floor(h / 2)]]) {
    if (String(px(back, x, y)) !== String(px(cropped, x, y))) throw new Error(`PNG 自检失败：像素 (${x},${y}) 不一致`)
  }
  return { buffer: enc, width: cropped.width, height: cropped.height }
}

// ── 浏览器 ──────────────────────────────────────────────────────────────────
function findBrowser() {
  const cands = [
    process.env.SAGE_MEM_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean)
  return cands.find((p) => existsSync(p)) || null
}

// ── 脱敏守卫（不需要在任何地方写死私人词）────────────────────────────────────
/** 图上出现的每一个 `.md` 名字，都必须是这几类之一：演示数据 / 内置保留名 / 体检用的假条目。 */
const ALLOWED_MD = /^(demo_[a-z]+_\d\d|user_alpha|project_beta|reference_gamma|feedback_old|project_dead|memory|session-log|project_notes|dangling_one|dangling_two|unlisted_one|not_there)\.md$/i
function desense(html, files, against) {
  const problems = []
  const text = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, '\n')
  // 1) 任何 .md 名字都要在允许清单里（真实记忆名一旦漏进来就会在这里炸）
  for (const m of new Set(text.match(/[\w.-]+\.md/g) || [])) {
    if (!ALLOWED_MD.test(m)) problems.push(`${files}: 出现了不在允许清单里的文件名「${m}」`)
  }
  // 2) 盘符 / 家目录 / file:// —— 私人语境与绝对路径的通用特征
  for (const m of new Set(text.match(/[A-Za-z]:[\\/][^\s"']*|\/(?:Users|home)\/[^\s"']*|file:\/\/\/[^\s"']*/g) || [])) {
    problems.push(`${files}: 出现了本机路径「${m}」`)
  }
  // 3) 每张图都带「演示数据」标注
  if (text.indexOf('界面预览 · 演示数据') < 0) problems.push(`${files}: 缺少「界面预览 · 演示数据」标注`)
  // 4) 可选：把某个目录里的 .md 名字逐个对一遍（路径由命令行给，不写进仓库）
  if (against && existsSync(against)) {
    for (const f of readdirSync(against)) {
      if (!f.endsWith('.md')) continue
      if (text.indexOf(f) >= 0 && !ALLOWED_MD.test(f)) problems.push(`${files}: 命中了 ${against} 里的真实文件名`)
    }
  }
  return problems
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const browser = findBrowser()
if (!browser) {
  console.error('找不到本机浏览器（Edge/Chrome）。用 SAGE_MEM_BROWSER=<可执行文件路径> 指定，或先跑 --html-only。')
  process.exit(2)
}
if (!has('--html-only') && !browser) process.exit(2)

const tmp = mkdtempSync(join(tmpdir(), 'sage-mem-images-'))
const r = spawnSync(process.execPath, [join(ROOT, 'test/client-render-test.mjs'), '--preview'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, SAGE_MEM_PREVIEW_DIR: tmp },
})
if (r.status !== 0) {
  console.error('预览渲染失败：\n' + (r.stdout || '') + (r.stderr || ''))
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(join(tmp, 'client-preview-manifest.json'), 'utf8'))
const published = manifest.filter((m) => m.out)
if (!published.length) {
  console.error('manifest 里没有可发布的屏')
  process.exit(1)
}
console.log(`预览渲染完成：manifest ${manifest.length} 屏，其中发布 ${published.length} 张`)

// 脱敏守卫：对每张要发布的图先过一遍 HTML 文本
const against = argOf('--against')
let problems = []
const htmls = published.map((p) => ({ id: p.id, text: readFileSync(p.readmeFile, 'utf8') }))
for (const h of htmls) problems = problems.concat(desense(h.text, h.id, against))
// 反空洞检查：上面那条白名单若因为「图里根本没有文件名」而通过，就等于没查。
// 所以再要求：整批里必须有假数据文件名，且多数屏上要出现允许清单内的 .md 名。
const all = htmls.map((h) => h.text).join('\n')
for (const must of ['user_alpha.md', 'project_beta.md']) {
  if (all.indexOf(must) < 0) problems.push(`整批图里都没出现假数据「${must}」—— 白名单可能是空过的`)
}
if (!/demo_[a-z]+_\d\d\.md/.test(all)) problems.push('整批图里都没出现星图演示数据（demo_*.md）—— 白名单可能是空过的')
const withMd = htmls.filter((h) => /[\w.-]+\.md/.test(h.text)).length
if (withMd < 5) problems.push(`只有 ${withMd} 张图里有文件名，少于 5 张 —— 请确认不是渲染坏了`)
if (problems.length) {
  console.error('脱敏核对未通过：\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log(`脱敏核对通过：${published.length} 张图的 HTML 里，.md 名字全在允许清单内、无本机路径、都带演示数据标注；假数据在（${withMd} 张图含文件名）${against ? `；并与 ${against} 的真实文件名逐个对过` : ''}`)

if (has('--html-only')) {
  console.log('（--html-only：只出 HTML，未截图）中间产物：' + tmp)
  process.exit(0)
}

const rows = []
for (const p of published) {
  const shot = join(tmp, p.id + '.png')
  // 这些参数都为了**可复现**，不碰任何渲染参数：
  //  - user-data-dir 每跑一次都是全新的空 profile → 冷启动与热启动走同一条路，不会"第一次不一样"；
  //  - run-all-compositor-stages-before-draw + 充裕的虚拟时间 → 抓到的是提交之后的那一帧；
  //  - 动画相位已在 harness 侧钉死（见 test/client-render-test.mjs 的 FIXED_NOW）。
  // 试过再加 --disable-lcd-text / --force-color-profile=srgb：确实更"机器无关"，但会把**文字
  // 栅格化**也改掉 —— 那 6 张 DOM 图本来就已经 3 连跑全稳定、且与已提交版本逐像素相同，
  // 为了不白白换掉它们的像素，这两条不加。
  const profile = join(tmp, 'profile-' + p.id)
  mkdirSync(profile, { recursive: true })
  const s = spawnSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=5000', `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${WINDOW_HEIGHT}`,
    `--screenshot=${shot}`, 'file:///' + p.readmeFile.split('\\').join('/'),
  ], { encoding: 'utf8' })
  if (!existsSync(shot)) {
    console.error(`截图失败：${p.id}\n` + (s.stdout || '') + (s.stderr || ''))
    process.exit(1)
  }
  const { buffer, width, height } = trimPng(shot)
  if (buffer.length > MAX_BYTES) {
    console.error(`${p.out} 有 ${(buffer.length / 1024).toFixed(1)} KB，超过单张 ${MAX_BYTES / 1024} KB 的上限`)
    process.exit(1)
  }
  const dst = resolve(ROOT, p.out)
  mkdirSync(dirname(dst), { recursive: true })
  const old = existsSync(dst) ? createHash('sha256').update(readFileSync(dst)).digest('hex').slice(0, 12) : '（新文件）'
  writeFileSync(dst, buffer)
  const sha = createHash('sha256').update(buffer).digest('hex').slice(0, 12)
  rows.push({ out: p.out, id: p.id, size: buffer.length, w: width, h: height, old, sha })
}

const total = rows.reduce((s, x) => s + x.size, 0)
console.log('\n产出：')
for (const x of rows) {
  console.log(`  ${x.out.padEnd(38)} ${String(x.w) + 'x' + x.h}`.padEnd(74) + `${(x.size / 1024).toFixed(1).padStart(6)} KB   ${x.old} → ${x.sha}`)
}
console.log(`  合计 ${(total / 1024).toFixed(1)} KB（上限 ${published.length * MAX_BYTES / 1024} KB）`)
if (!has('--keep')) rmSync(tmp, { recursive: true, force: true })
else console.log('中间产物：' + tmp)
