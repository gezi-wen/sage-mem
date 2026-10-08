/**
 * sage-mem autodream —— 「自动做梦」：让记忆自己整理一遍。
 *
 * 一趟 autodream 做四件事：定位（看清已有什么）→ 收集（找新信号）→ 整合（合并、修正）
 * → 修剪（索引与断链）。下面是几个非显然的设计决定：
 *
 *   1. **门控三级，最便宜的先查**：
 *      时间门（一次读写状态）→ 会话门（一次目录扫描，且带 10 分钟节流）→ 锁。
 *      任何一级不过，后面的都不做 —— 顺序就是成本顺序。
 *   2. **执行不走真正的子代理**，直接 `ctx.llm.stream()` 手写一个极简 agent 循环。
 *      换来的是：工具集由插件提供（安全边界在 autodream-tools.js）、步数有上限、
 *      不需要 agent 生命周期与 provider 注册，**也不会把 autodream 写进用户的会话记录**。
 *   3. **每一趟可回滚、可交代**。memory 目录不在任何版本控制下、删除没有回收站，
 *      所以「可回滚」必须自己造：运行前全量快照 + 运行后逐文件变更清单（含缘由），
 *      二者用同一个 runId 绑在一起，于是「某次整理」既能被读懂，
 *      也能被退回去。审计则让每趟 autodream 自证没改坏。
 *   4. **模型路线可单独指定**。整理是后台批量任务，跟聊天用的模型不必是同一个；
 *      空配置 = 跟随当前默认模型，非空 = 用户显式指定，**指定了就绝不静默回落**。
 *
 * 目录约定（都在 memoryDir 的上一级 `.sage-mem/` 下）：
 *   - 配置与状态：`.sage-mem/autodream.json`（旧版 `.sage-mem/dream.json` 只读迁移）
 *   - 运行记录与声明：`.sage-mem/autodream/runs/<runId>/{manifest.json,declaration.md}`
 *   - 回滚点：`.sage-mem/autodream/snapshots/<id>/`（旧版 `.sage-mem/snapshots/` 只读兼容）
 *   - 回滚留痕：`.sage-mem/autodream/rollbacks.json`
 *   - 人读报告：`memory/autodream/<runId>.md`（旧版 `memory/dream/` 只读兼容）
 *
 * 手改配置文件也方便——它是纯文本，且和人读的东西放在一起。
 *
 * ── 拆分说明（v0.8.0）─────────────────────────────────────────────
 * 本类的方法体按关注点搬到了 `lib/autodream/` 下：配置与状态 → `settings.js`、
 * 门控与锁 → `gate.js`、回滚点 → `snapshot.js`、LLM 循环 → `llm-loop.js`、
 * 声明与报告 → `report.js`、回滚 → `rollback.js`、通用工具 → `util.js` / `config.js`。
 * 这里保留**同名同签名**的方法，以 `.call(this, …)` 转发 —— 纯搬移、零行为变更。
 */

import { auditMemoryDir } from '../autodream-audit.js'
import { autodreamToolSchemas, createToolRunner } from '../autodream-tools.js'
import { CONFIG_VERSION, DEFAULT_CONFIG, DEFAULT_TOKEN_BUDGET, FAILURE_BACKOFF_MS, FEATURE_DIR, LEGACY_SNAPSHOT_DIR, LEGACY_STATE_FILE, SCHEDULE_INTERVAL_MS, STARTUP_CHECK_DELAY_MS, STATE_DIR } from './config.js'
import { countSessionsSince, newRunId, stampHuman } from './util.js'
import { dirname, join } from 'node:path'

import * as gateMod from './gate.js'
import * as llmloopMod from './llm-loop.js'
import * as reportMod from './report.js'
import * as rollbackMod from './rollback.js'
import * as settingsMod from './settings.js'
import * as snapshotMod from './snapshot.js'

export class AutodreamEngine {
  /**
   * @param {object} ctx — 插件上下文（Cordis）
   * @param {{memoryDir:string, sessionsRoot:string, version?:string}} opts
   */
  constructor(ctx, opts) {
    this.ctx = ctx
    this.memoryDir = opts.memoryDir
    this.sessionsRoot = opts.sessionsRoot
    this.version = opts.version
    /** 使用者自己声明的受保护文件名（`<状态根>/reserved.json`）——注入 prompt，绝不写死。 */
    this.reservedFiles = Array.isArray(opts.reservedFiles) ? opts.reservedFiles : []
    this.stateRoot = join(dirname(this.memoryDir), STATE_DIR)
    this.home = join(this.stateRoot, FEATURE_DIR)
    this.configPath = join(this.stateRoot, 'autodream.json')
    this.legacyConfigPath = join(this.stateRoot, LEGACY_STATE_FILE)
    this.lockPath = join(this.home, 'autodream.lock')
    /** 改名过渡期：旧版进程可能还攥着这把锁。两把互不相识的锁 = 两个进程同时改 memory。 */
    this.legacyLockPath = join(this.stateRoot, 'dream.lock')
    this.snapshotRoot = join(this.home, 'snapshots')
    this.legacySnapshotRoot = join(this.stateRoot, LEGACY_SNAPSHOT_DIR)
    this.runsRoot = join(this.home, 'runs')
    this.rollbacksPath = join(this.home, 'rollbacks.json')

    this.running = false
    this.phase = ''
    this.startedAt = 0
    this.runId = ''
    this.stepLog = []
    this.lastScanAt = 0
    this.state = { config: { ...DEFAULT_CONFIG }, version: CONFIG_VERSION, lastRunAt: 0, lastResult: null, retryAfter: 0 }
    this.disposers = []
    this._configLoaded = false
  }

  /** 服务解析：优先 ctx.get()，回落直接属性（不同 Cordis 版本两种都在用）。 */
  svc(name) {
    const viaGet = typeof this.ctx?.get === 'function' ? this.ctx.get(name) : undefined
    return viaGet ?? this.ctx?.[name]
  }

  log(level, msg) {
    const line = `sage-mem autodream: ${msg}`
    const logger = this.ctx?.logger
    if (level === 'error' && logger?.error) logger.error(line)
    else if (logger?.warn) logger.warn(line)
    else console.warn(line)
  }

  // ────────────────────────────── 配置与状态 ──────────────────────────────

  // ── 配置与状态：实现在 lib/autodream/settings.js ──
  async load() { return settingsMod.load.call(this) }
  async persist() { return settingsMod.persist.call(this) }
  async getConfig() { return settingsMod.getConfig.call(this) }
  async setConfig(patch) { return settingsMod.setConfig.call(this, patch) }
  defaultSelection() { return settingsMod.defaultSelection.call(this) }
  resolveRoute(config) { return settingsMod.resolveRoute.call(this, config) }
  async listModels() { return settingsMod.listModels.call(this) }
  async checkRouteAvailable(provider, model) { return settingsMod.checkRouteAvailable.call(this, provider, model) }
  async status() { return settingsMod.status.call(this) }

  // ── 门控与锁：实现在 lib/autodream/gate.js ──
  async gate() { return gateMod.gate.call(this) }
  async acquireLock() { return gateMod.acquireLock.call(this) }
  async releaseLock() { return gateMod.releaseLock.call(this) }

  // ── 回滚点（快照）：实现在 lib/autodream/snapshot.js ──
  async snapshot(id, kind = 'run') { return snapshotMod.snapshot.call(this, id, kind) }
  async pruneSnapshots() { return snapshotMod.pruneSnapshots.call(this) }
  async resolveSnapshotDir(id) { return snapshotMod.resolveSnapshotDir.call(this, id) }
  async listSnapshots() { return snapshotMod.listSnapshots.call(this) }

  // ── LLM 循环：实现在 lib/autodream/llm-loop.js ──
  async streamOnce(llm, req) { return llmloopMod.streamOnce.call(this, llm, req) }
  async agentLoop(cfg, runOpts) { return llmloopMod.agentLoop.call(this, cfg, runOpts) }

  // ── 整理声明与报告：实现在 lib/autodream/report.js ──
  async writeDeclaration(payload) { return reportMod.writeDeclaration.call(this, payload) }
  renderDeclaration(m, headingLevel = 1) { return reportMod.renderDeclaration.call(this, m, headingLevel) }
  async listRuns(limit = 20) { return reportMod.listRuns.call(this, limit) }
  async readDeclaration(runId) { return reportMod.readDeclaration.call(this, runId) }
  async writeReport(payload) { return reportMod.writeReport.call(this, payload) }
  async listReports(limit = 30) { return reportMod.listReports.call(this, limit) }
  async readReport(name) { return reportMod.readReport.call(this, name) }

  // ── 回滚：实现在 lib/autodream/rollback.js ──
  async listRollbacks(limit = 20) { return rollbackMod.listRollbacks.call(this, limit) }
  async appendRollback(entry) { return rollbackMod.appendRollback.call(this, entry) }
  async markRunRolledBack(runId, at) { return rollbackMod.markRunRolledBack.call(this, runId, at) }
  async rollback(opts = {}) { return rollbackMod.rollback.call(this, opts) }
  /**
   * 跑一次 autodream。
   * @param {{reason?:string, force?:boolean}} opts — force 跳过门控（手动触发时用）
   */
  async run(opts = {}) {
    const reason = opts.reason ?? '手动触发'
    if (this.running) return { ok: false, error: '已有一趟 autodream 在跑' }

    await this.load()
    const cfg = this.state.config
    const startedAt = Date.now()
    const runId = newRunId(startedAt)

    let hoursSince = null
    let sessionCount = 0
    if (opts.gateResult) {
      // 自动触发路径：门控在 tick 里**已经跑过一遍**，这里绝不能再跑第二遍 ——
      // `gate()` 内部有 10 分钟扫描节流，第二次调用必然被刚设下的节流挡回来
      // （「扫描节流中（0s 前刚扫过）」），于是自动整理一次都跑不成；而 tick 若不查
      // run 的返回值，连一行错误日志都没有。
      hoursSince = Number.isFinite(opts.gateResult.hoursSince) ? opts.gateResult.hoursSince : null
      sessionCount = opts.gateResult.sessionCount ?? 0
    } else if (!opts.force) {
      const g = await this.gate()
      if (!g.ok) return { ok: false, error: `门控未通过：${g.reason}` }
      hoursSince = Number.isFinite(g.hoursSince) ? g.hoursSince : null
      sessionCount = g.sessionCount ?? 0
    } else {
      sessionCount = await countSessionsSince(this.sessionsRoot, this.state.lastRunAt || 0)
      hoursSince = this.state.lastRunAt ? (startedAt - this.state.lastRunAt) / 3600000 : null
    }

    if (!(await this.acquireLock())) return { ok: false, error: '拿不到锁（另一趟 autodream 正在跑？）' }

    this.running = true
    this.startedAt = startedAt
    this.runId = runId
    this.stepLog = []
    this.phase = '准备中'

    const route = this.resolveRoute(cfg)
    let snapshot = null
    let auditBefore = null
    /** 提到 try 外面：失败路径要拿它问「已经写进去哪几条」。 */
    let runner = null
    /**
     * 还没开始任何模型调用 / 写入 —— 也就是「开工前的确定性失败」（路线不存在、配置半填、
     * 快照不完整、审计跑不动）。
     *
     * 这类失败**不该吃失败退避**：退避是为了别让偶发故障把门控刷成高频重试，而配置错误
     * 是人去改配置才能好的——用户改完却还要等一小时才生效，是最没道理的一种等待。
     */
    let preflight = true
    try {
      // 路线在开工前就判死：跑到一半才发现模型不存在，等于白烧一整轮上下文。
      if (route.source === 'none') throw new Error(`模型路线不可用：${route.error}`)
      if (route.source === 'config') {
        const chk = await this.checkRouteAvailable(route.provider, route.model)
        if (!chk.ok) {
          throw new Error(
            `配置里指定的模型路线不可用：${chk.reason}。` +
              '请到「自动做梦 → 高级设置 → 模型」重新选一条，或清空两项改为跟随默认模型。',
          )
        }
        if (!chk.checked) this.log('warn', `模型路线存在性未完全校验：${chk.reason}`)
      }

      if (cfg.apply) {
        this.phase = '运行前快照（回滚点）'
        snapshot = await this.snapshot(runId, 'run')
        // 快照不完整就不许开工。残缺的回滚点比没有回滚点**更危险**——它让人以为
        // 「退得回去」。在任何写操作之前中止，是这条路径上唯一诚实的做法。
        if (snapshot.failed.length) {
          const shown = snapshot.failed.slice(0, 3).join('、')
          throw new Error(
            `运行前快照有 ${snapshot.failed.length} 个文件没存下来（${shown}${snapshot.failed.length > 3 ? '…' : ''}），` +
              '回滚点不完整，本次整理已中止（未改动任何文件）。请检查磁盘空间与文件占用后重试。',
          )
        }
      }

      this.phase = '运行前审计'
      auditBefore = await auditMemoryDir(this.memoryDir)

      const withSessions = cfg.source === 'memory+sessions'
      runner = createToolRunner({
        memoryDir: this.memoryDir,
        sessionsRoot: this.sessionsRoot,
        apply: !!cfg.apply,
        withSessions,
      })
      const toolSchemas = autodreamToolSchemas({ apply: !!cfg.apply, withSessions })

      // 从这里往下就会真的动模型和磁盘了 —— 之后的失败按「运行期故障」处理（吃退避）。
      preflight = false
      this.phase = '运行中'
      const result = await this.agentLoop(cfg, {
        provider: route.provider,
        model: route.model,
        toolSchemas,
        runner,
        maxSteps: cfg.maxSteps,
        tokenBudget: DEFAULT_TOKEN_BUDGET,
        hoursSince: hoursSince ?? 0,
        sessionCount,
      })

      this.phase = '运行后审计'
      const auditAfter = await auditMemoryDir(this.memoryDir)

      const endedAt = Date.now()
      this.phase = '整理声明'
      const declaration = await this.writeDeclaration({
        runId,
        startedAt,
        endedAt,
        reason,
        apply: !!cfg.apply,
        source: cfg.source,
        provider: route.provider,
        model: route.model,
        fromDefault: route.fromDefault,
        hoursSince,
        sessionCount,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        snapshot,
        changes: result.changes,
        warnings: result.warnings,
        notes: result.notes,
        auditBefore,
        auditAfter,
        finalText: result.finalText,
      })

      const report = await this.writeReport({
        runId,
        startedAt,
        endedAt,
        reason,
        apply: !!cfg.apply,
        source: cfg.source,
        provider: route.provider,
        model: route.model,
        fromDefault: route.fromDefault,
        hoursSince,
        sessionCount,
        snapshot,
        touched: result.touched,
        auditBefore,
        auditAfter,
        finalText: result.finalText,
        transcript: result.transcript,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        declarationMarkdown: declaration.markdown,
      })

      this.state.lastRunAt = Date.now()
      this.state.retryAfter = 0
      this.state.lastResult = {
        at: this.state.lastRunAt,
        atHuman: stampHuman(this.state.lastRunAt),
        ok: true,
        runId,
        apply: !!cfg.apply,
        touched: result.touched,
        changeCount: result.changes.length,
        problemsBefore: auditBefore.problems,
        problemsAfter: auditAfter.problems,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        report: report.name,
        snapshotId: snapshot?.id ?? null,
      }
      await this.persist()
      this.phase = ''
      return {
        ok: true,
        runId,
        report: report.name,
        touched: result.touched,
        changeCount: result.changes.length,
        snapshotId: snapshot?.id ?? null,
        auditBefore,
        auditAfter,
      }
    } catch (err) {
      const message = err?.message ?? String(err)
      this.log('warn', `运行失败：${message}`)

      // **中途失败也要交代。** 已经落盘的改动不会自己消失，而「有改动、无声明」是最坏的
      // 一种状态：人既不知道发生了什么，也不知道该不该回滚。回滚点此时仍然有效
      // （它在任何写操作之前就建好了），声明把「中断前已经改了什么」钉住。
      const partial = runner ? runner.changes() : []
      if (partial.length) {
        try {
          await this.writeDeclaration({
            runId,
            startedAt,
            endedAt: Date.now(),
            reason: `${reason}（运行中断）`,
            apply: !!cfg.apply,
            source: cfg.source,
            provider: route.provider,
            model: route.model,
            fromDefault: route.fromDefault,
            hoursSince,
            sessionCount,
            tokensIn: 0,
            tokensOut: 0,
            snapshot,
            changes: partial,
            warnings: [...(runner?.warnings() ?? []), `运行在写完 ${partial.length} 条改动之后中断：${message}`],
            notes: runner?.notes?.() ?? [],
            auditBefore,
            auditAfter: null,
            finalText: `本次运行中断。以上是中断前**已经落盘**的改动；中断原因：${message}`,
          })
        } catch (e2) {
          // 失败路径上的再失败不能盖住原始错误——只记一行，然后照原样把原始错误报出去。
          this.log('warn', `中断声明写入失败：${e2?.message ?? e2}`)
        }
      }

      this.state.retryAfter = preflight ? 0 : Date.now() + FAILURE_BACKOFF_MS
      this.state.lastResult = {
        at: Date.now(),
        atHuman: stampHuman(Date.now()),
        ok: false,
        runId,
        apply: !!cfg.apply,
        error: message,
        // preflight 失败会明确标出来：它和「模型跑到一半挂了」是两种病，退避策略也不同。
        preflight,
        changeCount: partial.length,
        snapshotId: snapshot?.id ?? null,
        tokensIn: 0,
        tokensOut: 0,
      }
      await this.persist().catch(() => {})
      this.phase = ''
      return { ok: false, error: message }
    } finally {
      this.running = false
      this.runId = ''
      await this.releaseLock()
    }
  }

  // ────────────────────────────── 调度 ──────────────────────────────

  /**
   * 挂上自动触发的定时器。
   *
   * 用 `ctx.timer`（Cordis 混合进 context 的定时器助手）而不是裸 setInterval：
   * 它的 dispose 会跟着插件生命周期走，插件卸载时定时器一起消失。
   * timer 服务拿不到时退回全局 setInterval，并在日志里说清楚。
   */
  start() {
    const timer = this.svc('timer')
    const tick = () => {
      this.gate()
        .then((g) => {
          if (!g.ok) return undefined
          this.log('warn', `门控通过，自动开始整理（${g.reason ?? ''} ${g.hoursSince?.toFixed?.(1) ?? '?'}h / ${g.sessionCount} 会话）`)
          // 门控结果**带进去**，别让 run() 再跑一遍 gate()——gate() 有 10 分钟扫描节流，
          // 第二遍必然被刚设下的节流挡回（详见 run() 里那段注释）。
          return this.run({ reason: '自动（门控通过）', gateResult: g })
        })
        .then((r) => {
          // run() 失败是**返回** `{ok:false}` 而不是抛；不看返回值就等于静默失败，
          // 而「自动整理悄悄不工作」正是这个功能最难查的故障形态。
          if (r && r.ok === false) this.log('warn', `自动整理没有跑成：${r.error ?? '未知原因'}`)
        })
        .catch((err) => this.log('warn', `自动触发失败：${err?.message ?? err}`))
    }

    if (timer?.interval) {
      this.disposers.push(timer.interval(tick, SCHEDULE_INTERVAL_MS))
    } else {
      const id = setInterval(tick, SCHEDULE_INTERVAL_MS)
      if (typeof id.unref === 'function') id.unref()
      this.disposers.push(() => clearInterval(id))
    }

    if (timer?.timeout) {
      this.disposers.push(timer.timeout(tick, STARTUP_CHECK_DELAY_MS))
    } else {
      const id = setTimeout(tick, STARTUP_CHECK_DELAY_MS)
      if (typeof id.unref === 'function') id.unref()
      this.disposers.push(() => clearTimeout(id))
    }
  }

  /** 插件卸载：停掉所有定时器与锁。 */
  dispose() {
    for (const d of this.disposers) {
      try {
        d()
      } catch {
        /* 忽略：卸载路径上的异常不该再冒出来 */
      }
    }
    this.disposers = []
    this.releaseLock().catch(() => {})
  }
}
