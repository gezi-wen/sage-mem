#!/usr/bin/env node
/**
 * sage-mem 测试总入口（仓库内，随 npm test 一起跑）。
 *
 * 逐个跑本目录下的断言脚本，汇总每个脚本自报的断言数；任一脚本非零退出、
 * 有失败断言、或压根没打出汇总行（多半是 import 就炸了），整体即 exit 1。
 *
 * 为什么用子进程而不是 import 进同一个进程：inject-test 会在**模块顶层**读环境变量
 * （SAGE_MEM_DIR / SAGE_MEM_MAX_SESSION_BYTES …），而且它自己还要另起子进程验默认值；
 * 同进程复用会让这些顶层状态互相污染。一脚本一进程最省心，也最接近各自单跑的结果。
 *
 * 只依赖 node: 内置模块 —— 不引入任何测试框架，与各脚本手写 ok() 的风格保持一致。
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 固定顺序：先纯函数与引擎层，再产物对表，最后客户端真执行。 */
const SUITES = [
  'ad-smoke.mjs',
  'ad-fixes.mjs',
  'ad-matrix.mjs',
  // 1.0.1：报告撞上单次输出上限时的「接着写」与残篇标注（真实事故：10-17 凌晨那份报告断在半句）。
  'autodream-continuation-test.mjs',
  'rollback-guard-test.mjs',
  // 1.6.3：快照在多文件 / 大文件下的正确性与内存峰值回归（外部审查 PERF-01）。
  'snapshot-stress-test.mjs',
  'race-guards-test.mjs',
  // 2.1.3：自动整理的读时版本必须与读到的那份正文同源（外部审查 2026-10-31，Q01）。
  'review-211-q01-test.mjs',
  // 2.1.4：自动整理的三个模型可调用读取分支统一走 readVerified（外部审查 N03）。
  'review-211-n03-test.mjs',
  // 2.1.17：扫描失败不能被渲染成「完整搜索且没有命中」（外部审查 Q14）。
  'review-211-q14-test.mjs',
  'q-fixes-093.mjs',
  'q-fixes-094.mjs',
  'q-fixes-095.mjs',
  'q-fixes-098.mjs',
  'archive-index-test.mjs',
  'autodream-config-test.mjs',
  'open-folder-test.mjs',
  'update-test.mjs',
  'retrieval-test.mjs',
  // 1.6.4：检索诊断报告的可回归守卫（外部审查 RET-01 / OBS-01）。
  'retrieval-report-test.mjs',
  // 1.2.0：注入链拆成纯函数后的直接单测（不需要 new MemoryGateway）。
  'recall-unit-test.mjs',
  // 1.7.0：注入调试账（开关语义 / 环形缓冲 / 不落盘 / typert 对拍）。
  'recall-debug-test.mjs',
  'chunks-test.mjs',
  'bm25-test.mjs',
  'search-test.mjs',
  'intent-test.mjs',
  'reader-test.mjs',
  // 1.6.3：检查与读取之间换文件的确定性复现 + 星图读收口（外部审查 SEC-01 / R19）。
  'safe-read-test.mjs',
  'memory-tools-test.mjs',
  'observe-test.mjs',
  'write-gate-test.mjs',
  'write-gate-wiring-test.mjs',
  'deliver-test.mjs',
  'status-card-test.mjs',
  'conflicts-test.mjs',
  'stale-conflict-test.mjs',
  // 1.9.1：三份外部报告（issue #6 沙箱 / #7 队列膨胀 / #8 索引假阳性）各一条会红的断言。
  'issue-fixes-191.mjs',
  'watch-test.mjs',
  // 守卫放最后：它检查的是「上面这份名单完不完整」。
  'suite-registry-test.mjs',
  'checkpoint-test.mjs',
  // 2.1.15：Q12 —— 长任务 ID 的检查点句柄必须能按同一解析规则定位到真实文件。
  'review-211-q12-test.mjs',
  // 2.1.16：Q13 —— 主动摘要检索在完整候选上分页，自动注入名额仍守自己的配置。
  'review-211-q13-test.mjs',
  // 2.1.18：Q17 —— 体检的索引识别走实际索引名（大小写归一），双变体报冲突。
  'review-211-q17-test.mjs',
  'typert-test.mjs',
  'inject-test.mjs',
  // 1.2.0：注入链从组合根搬出前先建的 golden —— 11 个场景逐字节比对，
  // 证明「纯搬移」不是一句自述（fixtures 由 scripts/gen-recall-golden.mjs 生成）。
  'recall-golden-test.mjs',
  'host-facts-test.mjs',
  'archive-test.mjs',
  // 2.1.5（外部审查 Q06）：恢复归档改成「接管源 → 核对 → 排他落位 → 退役私有副本」的事务移动，
  // 读源后 / 接管前后 / 目标落位后插入源改写都不许丢新版本；EEXIST / EIO / 崩溃残留各留一份可捞回的原文。
  'review-211-q06-test.mjs',
  // 2.1.6（外部审查 Q07）：归档删除的内容身份 = 归档代次 + 正文 revision；分钟时间戳只是展示值。
  // 同一时间戳不同正文 / 同分钟重新归档 / 校验后被替换都拒绝，老确认（缺 revision）一律拒绝。
  'review-211-q07-test.mjs',
  // 2.1.7（外部审查 Q11）：回滚的「不支持硬链接」降级改为 COPYFILE_EXCL 排他复制，绝不默认
  // rename 覆盖已有归档；EEXIST / EPERM / ENOTSUP / EXDEV / EIO 逐分支验证，失败保留源。
  'review-211-q11-test.mjs',
  // 2.1.19（外部审查 Q18）：原子替换继承已有普通文件的 POSIX 权限、新建文件用保守 0600；
  // 权限位只在 POSIX 有意义 → 运行时探测，Windows 上跳过行为断言（机制/内容断言照跑）。
  'review-211-q18-test.mjs',
  'access-test.mjs',
  'access-v2-test.mjs',
  'panel-api-test.mjs',
  // 1.3.0：单一事实来源的对拍与「只许一处」守卫（放 build-fresh 之前：都是静态/纯函数）。
  'shared-parity-test.mjs',
  'duplication-test.mjs',
  'build-fresh.mjs',
  'client-exec-test.mjs',
  // 1.4.0：客户端共享基元的「只许一处」与拼接顺序守卫。
  'client-scope-test.mjs',
  'client-render-test.mjs',
  // 2.1.20：外部审查 Q15 —— 星图按需绘制的入场 / 回放 / 页面隐藏调度
  // （伪时钟 + 假 WebGL 直接读 render 写进去的 uTime / uRevealT）。
  'review-211-q15-test.mjs',
  // 契约 §5（环境变量）的默认值 / 越界夹取 —— 以前这半边一条断言都没有。
  'env-contract-test.mjs',
  // 1.2.0：结构守卫 —— 组合根体积 / 依赖方向 / typert 契约位置。
  'structure-test.mjs',
  // 1.6.2：发布物一致性 —— 打包白名单 / 版本三处一致 / 兼容表对拍（本地操作，不联网）。
  'release-test.mjs',
  // 2.0.0：有效性标注（三字段解析 / 失效判定 / 冲突→集合映射），每条都带反向对照。
  'validity-test.mjs',
  // 2.0.0：冲突记录模型 / 裁决状态机 / 写路径（版本守卫 + 沙箱 + CRLF 保真）/ 注入侧端到端。
  'conflict-decision-test.mjs',
  'conflict-arbitration-test.mjs',
  'conflict-inject-test.mjs',
  // 2.1.2：外部审查 Q02 —— 读快照带 revision、写带 expectedRevision 的守卫、createIfAbsent。
  'review-211-q02-test.mjs',
  // 2.1.8：外部审查 N02 —— 相反并发裁决按冲突 id 串行、文件级协调、交错与重试一致性。
  'review-211-n02-test.mjs',
  // 2.1.9：外部审查 N01 —— 撤销绑定原裁决标记（标记被重写 → stale_decision，不删别人的判断）。
  'review-211-n01-test.mjs',
  // 2.1.10：外部审查 Q10 —— 建立索引骨架：缺目录先建、已有索引明确已存在、创建排他。
  'review-211-q10-test.mjs',
  // 2.1.11：Q04 —— 面板上限设置「保存 → 重启」后真的生效（启动解析与面板 pending 共用一份）。
  'review-211-q04-test.mjs',
  // 2.1.12：Q05 —— 锁表并发丢更新 + 坏表当全解锁（按锁表路径串行 RMW / unknown 暂停归档）。
  'review-211-q05-test.mjs',
  // 2.1.13：Q09 —— 状态根覆写对全部模块生效（装配期一次解析，旧目录不迁移但提示）。
  'review-211-q09-test.mjs',
  // 2.1.14：Q08 —— 被去重的轮次也推进观测计数（压缩判据对着观测账，不是投递账）。
  'review-211-q08-test.mjs',
  // ⚠️ 下面两个必须排在最后：它们读的是**前面套件跑完落的断言台账**（见 `_passlog.mjs`），
  // 排在前面就会读到残缺的账。它们盯的是「契约里说了不验的承诺」与「两份文档说法不一致」。
  'contract-binding-test.mjs',
  'doc-consistency-test.mjs',
]

/** 各脚本收尾那行：`结果：53 passed, 0 failed`。 */
const SUMMARY = /结果：(\d+)\s*passed,\s*(\d+)\s*failed/

const HERE = fileURLToPath(new URL('.', import.meta.url))
const rows = []
let passed = 0
let failed = 0
const broken = []

/**
 * **沙箱环境**：给每个子套件一套临时目录，任何套件都不许碰真实记忆目录与真实状态根。
 *
 * 为什么需要它（2026-10-15 实测的事故）：DSH 进程本身带着 `SAGE_MEM_DIR`，于是
 * **静态 `import` 的套件会在它覆盖环境变量之前就把 `lib/memory/config.js` 加载完** ——
 * 模块常量指向真实目录。其中 `ad-smoke.mjs` 会跑 autodream，而 autodream 跑前强制 flush
 * 访问台账，于是把用户**真实**的 `.sage-mem/access.json` 冲成了它的夹具名。
 *
 * 子进程从父进程继承环境，所以在这里设一次就覆盖全部套件（含将来新加的）。
 * 各套件自己设的临时目录优先级更高，不受影响。
 */
const sandboxRoot = mkdtempSync(join(tmpdir(), 'sage-mem-suites-'))

/**
 * **断言台账**：本次运行里每个套件**实际打出过**的 PASS 断言名，一行一个套件。
 *
 * 为什么要有它：`1.0.0-contract.md` 里每条「保证」都必须指向一条**真的存在**的断言
 * （见 `contract-binding-test.mjs`）。守卫要核对这件事，最可靠的办法是看**本次运行的实况**，
 * 而不是去 grep 源码 —— 源码里的字符串可能落在注释里、或在一条永远不走的 `if` 分支里。
 * 让守卫自己再跑一遍那些套件，等于把 `npm test` 跑两遍；所以在运行器里顺手落账。
 *
 * 消费方：`SAGE_MEM_PASSLOG` 指向的那个文件。守卫单独跑（没这个变量）时自己起子进程补。
 * ⚠️ 契约绑定守卫必须排在 `SUITES` **最后** —— 它要读的账在它之前才写完。
 */
const PASSLOG = join(sandboxRoot, 'pass-log.jsonl')
const PASS_LINE = /^ {2}PASS (.*)$/gm

const SANDBOX_ENV = {
  SAGE_MEM_DIR: join(sandboxRoot, 'memory'),
  SAGE_MEM_STATE_DIR: join(sandboxRoot, '.sage-mem'),
  DSH_HOME: join(sandboxRoot, 'dsh-home'),
  SAGE_MEM_PASSLOG: PASSLOG,
}
mkdirSync(SANDBOX_ENV.SAGE_MEM_DIR, { recursive: true })
mkdirSync(SANDBOX_ENV.SAGE_MEM_STATE_DIR, { recursive: true })

/**
 * **环境隔离**：套件必须跑在「干净环境」里，绝不继承开发机上的调参。
 *
 * 2026-10-24 实测：把 `SAGE_MEM_DEBUG=1` 设进用户级环境变量之后（为了看面板的注入调试），
 * 宿主进程继承它 → 本运行器的子进程也继承它 → `access-test` 里「不开 DEBUG 时零日志 /
 * 恰好一行」两条当场红。那不是产品回归，是**测试被环境污染**。
 *
 * 所以这里显式删掉一批「只在开发时才会设」的变量；将来再加同类开关（前缀 `SAGE_MEM_` 的
 * 调试 / 探针变量）也放这个名单。注意**不能**把 DIR / STATE / MAX_* 也删 —— 下面
 * SANDBOX_ENV 会给它们统一覆盖，删掉反而让个别套件读到默认值。
 */
const SCRUBBED = ['SAGE_MEM_DEBUG', 'SAGE_MEM_TASK_ID', 'SAGE_MEM_PROBE_AFTER_MS']
const childEnv = { ...process.env, ...SANDBOX_ENV }
for (const k of SCRUBBED) delete childEnv[k]

for (const name of SUITES) {
  const r = spawnSync(process.execPath, [join(HERE, name)], {
    encoding: 'utf8',
    env: childEnv,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = out.match(SUMMARY)
  const p = m ? Number(m[1]) : 0
  const f = m ? Number(m[2]) : 0
  const code = r.status === null ? 1 : r.status
  passed += p
  failed += f
  const bad = !m || f > 0 || code !== 0
  if (!m || f > 0 || code !== 0) broken.push(name)

  // 断言台账：供契约绑定守卫核对「这片保证指向的断言真的跑过」。
  appendFileSync(PASSLOG, `${JSON.stringify({
    name,
    bad,
    pass: [...out.matchAll(PASS_LINE)].map((x) => x[1]),
  })}\n`)

  console.log(`\n──── ${name} ────`)
  process.stdout.write(out.endsWith('\n') || !out ? out : `${out}\n`)
  if (!m) console.log('  （没有读到汇总行，按失败计）')

  rows.push({ name, p, f, code, bad })
}

// 沙箱用完就删。放在汇总之前也没关系 —— 断言早就跑完了。
rmSync(sandboxRoot, { recursive: true, force: true })

console.log('\n════ 汇总 ════')
for (const r of rows) {
  console.log(`  ${r.bad ? 'FAIL' : 'ok  '}  ${r.name.padEnd(20)} ${r.p} passed, ${r.f} failed  (exit ${r.code})`)
}
console.log(`  合计：${passed} passed, ${failed} failed`)
if (broken.length) console.log(`  未通过：${broken.join(', ')}`)

process.exit(failed > 0 || broken.length ? 1 : 0)
