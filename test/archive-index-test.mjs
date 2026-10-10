/**
 * 归档时要从索引里摘掉那一行（v0.9.12）。
 *
 * 起因：v0.9.8 只做了「恢复时补索引」这**一半** —— 归档时没摘，于是每归档一条，
 * 索引里就多一条指向「已不在顶层」的条目，审计报「索引悬空」。
 * 我在自己机器上归档两条时当场撞上：审计从 0 问题变 2 问题，两条都是刚归档的。
 *
 * 与 ensureIndexEntry 对称：索引是**活动记忆的清单**，记忆归档了就该从清单里退出。
 * 往返必须一致：归档摘掉 → 恢复补回来。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const LIB = new URL('../lib/', import.meta.url)
const { archiveMemory, restoreMemory } = await import(new URL('memory/archive.js', LIB).href)
const { dropIndexEntry, ensureIndexEntry, findIndexFile } = await import(new URL('memory/index-file.js', LIB).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) } else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`) }
}

const INDEX = [
  '# 记忆索引',
  '',
  '> 索引里每条的描述必须与文件实际内容一致；改动记忆时同步改这里。',
  '',
  '- [甲](alpha.md) — 第一条',
  '- [乙](x_alpha.md) — 名字里含 alpha 的另一条',
  '- [丙](beta.md) — 第三条',
  '',
].join('\n')

async function makeDir(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sage-mem-0912-'))
  const memoryDir = join(root, 'memory')
  await mkdir(join(memoryDir, 'archive'), { recursive: true })
  await writeFile(join(memoryDir, 'MEMORY.md'), INDEX, 'utf8')
  for (const [n, body] of Object.entries(files)) {
    await writeFile(join(memoryDir, n), body, 'utf8')
  }
  return { root, memoryDir }
}
const NOTE = (desc) => `---\nname: 甲\ndescription: ${desc}\nmetadata:\n  node_type: memory\n---\n\n正文。\n`
const tmp = []

console.log('== 1. 归档 → 索引里那一行没了（当前实现不摘，这条先红）==')
{
  const { root, memoryDir } = await makeDir({ 'alpha.md': NOTE('第一条') })
  tmp.push(root)
  const idx = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
  ok(idx.includes('](alpha.md)'), '（前提）归档前索引里有它')

  const r = await archiveMemory(memoryDir, 'alpha.md', '测试归档')
  ok(r.ok === true, '归档本身成功', JSON.stringify(r))

  const after = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
  ok(!/\]\(\s*alpha\.md/i.test(after), '归档后索引里不再指向它', after.split('\n').filter((l) => l.includes('alpha')).join(' | '))
  ok(/\]\(\s*x_alpha\.md/i.test(after), '**名字里含 alpha 的另一条不许误伤**（x_alpha.md 还在）')
  ok(after.includes('](beta.md)'), '其它条目一条不少')
  ok(after.startsWith('# 记忆索引') && after.includes('改动记忆时同步改这里'), '索引的标题与说明段原样保留')
}

console.log('== 2. 往返一致：归档摘掉 → 恢复补回来 ==')
{
  const { root, memoryDir } = await makeDir({ 'alpha.md': NOTE('第一条') })
  tmp.push(root)
  await archiveMemory(memoryDir, 'alpha.md', '测试')
  const mid = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
  ok(!/\]\(\s*alpha\.md/i.test(mid), '（前提）归档后已摘')
  const r = await restoreMemory(memoryDir, 'alpha.md')
  ok(r.ok === true && r.indexed === true, '恢复时把索引补了回来', JSON.stringify(r))
  const back = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
  ok(/\]\(\s*alpha\.md/i.test(back), '索引里重新有了它')
  ok((back.match(/\]\(\s*alpha\.md/gi) || []).length === 1, '而且只有一条（不重复）')
}

console.log('== 3. 索引里本来就没有它 → 不报错、别的行不动 ==')
{
  const { root, memoryDir } = await makeDir({ 'gamma.md': NOTE('从没进过索引') })
  tmp.push(root)
  const before = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
  const d = await dropIndexEntry(memoryDir, 'gamma.md')
  ok(d.ok === true && d.removed === false, 'dropIndexEntry 是幂等的', JSON.stringify(d))
  ok((await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')) === before, '索引一个字节没变')
}

console.log('== 4. 归档失败时索引不动（已锁定的拒绝归档）==')
{
  const { root, memoryDir } = await makeDir({ 'alpha.md': NOTE('第一条') })
  tmp.push(root)
  const { setLocked } = await import(new URL('memory/lock.js', LIB).href)
  await setLocked(memoryDir, 'alpha.md', true)
  const before = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
  const r = await archiveMemory(memoryDir, 'alpha.md', '测试')
  ok(r.ok === false && r.code === 'locked', '（前提）锁定的拒绝归档', JSON.stringify(r))
  ok((await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')) === before, '拒绝时索引不动')
}

console.log('== 5. 没有索引文件 → 归档照常，不崩 ==')
{
  const root = await mkdtemp(join(tmpdir(), 'sage-mem-0912-noindex-'))
  const memoryDir = join(root, 'memory')
  await mkdir(join(memoryDir, 'archive'), { recursive: true })
  tmp.push(root)
  await writeFile(join(memoryDir, 'alpha.md'), NOTE('第一条'), 'utf8')
  ok((await findIndexFile(memoryDir)) === null, '（前提）目录里没有索引')
  const r = await archiveMemory(memoryDir, 'alpha.md', '测试')
  ok(r.ok === true, '没有索引也照常归档', JSON.stringify(r))
}

console.log('== 6. 大小写：索引写成小写也要认得出来 ==')
{
  const { root, memoryDir } = await makeDir({ 'Alpha.md': NOTE('大写文件名') })
  tmp.push(root)
  await writeFile(join(memoryDir, 'MEMORY.md'), INDEX.replace('alpha.md', 'Alpha.md'), 'utf8')
  const r = await ensureIndexEntry(memoryDir, 'Alpha.md')
  ok(r.ok === true && r.added === false, '（前提）已有条目就不重复加', JSON.stringify(r))
  await dropIndexEntry(memoryDir, 'Alpha.md')
  const idx = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8')
  // ⚠️ 必须锚定 `](`：只写 /Alpha\.md/i 会因为 `i` 标志把 `x_alpha.md` 也匹配进去，
  // 那条断言就恒失败（我自己写歪过一次 —— 断言本身也要当代码审）。
  ok(!/\]\(\s*Alpha\.md(?:#[^)]*)?\s*\)/i.test(idx), '摘干净了（指向它的条目没了）')
  ok(/\]\(\s*x_alpha\.md\s*\)/i.test(idx), '名字里含 alpha 的那条没被误伤')
}

for (const d of tmp) await rm(d, { recursive: true, force: true }).catch(() => {})
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
