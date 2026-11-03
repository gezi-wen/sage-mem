#!/usr/bin/env node
'use strict'
/**
 * frontmatter-assert.cjs — 记忆文件的 frontmatter 断言（2026-10-06 从 SKILL.md §9.1 固化）
 *
 * 原先 §9.1 是一条 `node -e "...一大坨..."` 命令。实际用起来有两个问题：
 *   ① **PowerShell 的引号地狱**：命令里有 `^["']` 这类片段，放进 pwsh 的双引号串会
 *      提前结束字符串，手抄一次要试两遍（2026-10-06 亲历，改用临时 .cjs 才跑通）；
 *   ② 它一次只验一个文件，批量改完记忆得循环手拼。
 * 现在：多文件一次过，逐行 OK/FAIL，退出码 0/1。
 *
 * 三件事都要有（解析通过 ≠ 字段完整）：
 *   1. 真有 frontmatter 块；2. 能被**真 YAML 解析**；3. `name` / `description` / `type` 非空；
 *   外加逐行查「未加引号的值里有空格+#」—— 那会让后半句被当注释吞掉，检索面残缺且零提示。
 *
 * ⚠️ 这是给**记忆文件**用的。技能文件（SKILL.md）没有 `type` 字段，对它跑必然报「缺 type」。
 *
 * 用法: node frontmatter-assert.cjs <记忆文件.md> [更多文件...]
 * 退出码: 0 = 全部通过；1 = 有文件有问题；2 = 用法/环境错
 */
const fs = require('fs')
const path = require('path')

function loadYaml() {
  const guesses = [
    // ① DSH 的 profile 依赖树（DSH 自带 yaml，装了 DSH 就一定有）
    process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'profiles/node_modules/yaml'),
    // ② 本脚本所在包自己的依赖树（技能在 <包>/skills/<技能名>/scripts/，往上三级到包根）
    path.join(__dirname, '../../../node_modules/yaml'),
    path.join(__dirname, '../../node_modules/yaml'),
    // ③ 正常的模块解析
    'yaml',
  ].filter(Boolean)
  for (const g of guesses) {
    try { return require(g) } catch { /* 试下一个 */ }
  }
  console.error('找不到 yaml 包。三条出路：① 设好 DSH_HOME（DSH 自带 yaml）；② 在本插件目录 npm install yaml；③ 全局装 yaml 并把路径加进本脚本的 guesses')
  process.exit(2)
}

const yaml = loadYaml()
const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法: node frontmatter-assert.cjs <记忆文件.md> [更多文件...]')
  process.exit(2)
}

let bad = 0
for (const p of files) {
  const label = path.basename(p)
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch (e) {
    console.log(`FAIL ${label} — 读不到：${e.message}`)
    bad++
    continue
  }
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) { console.log(`FAIL ${label} — 没有 frontmatter 块`); bad++; continue }

  let m
  try {
    m = yaml.parse(fm[1])
  } catch (e) {
    console.log(`FAIL ${label} — YAML 解析失败：${e.message}`)
    bad++
    continue
  }

  const errs = []
  const type = m.type || (m.metadata && m.metadata.type)
  for (const k of ['name', 'description']) if (!m[k]) errs.push(`缺 ${k}`)
  if (!type) errs.push('缺 type（会被静默兜底成 reference）')
  for (const l of fm[1].split(/\r?\n/)) {
    const mv = l.match(/^[A-Za-z0-9_.-]+:\s*(.*)$/)
    if (mv && !/^["']/.test(mv[1]) && / #/.test(mv[1])) {
      errs.push(`未加引号的值里有「空格+#」：${l.trim().slice(0, 70)}`)
    }
  }

  if (errs.length) { console.log(`FAIL ${label} — ${errs.join(' | ')}`); bad++ }
  else console.log(`OK   ${label}  type=${type}  name=${m.name}`)
}

console.log(bad ? `结果：${bad} 个文件有问题` : `结果：${files.length} 个文件全部通过 ✅`)
process.exit(bad ? 1 : 0)
