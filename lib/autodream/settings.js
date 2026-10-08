/**
 * autodream —— 配置与状态（引擎方法体）。
 *
 * 本文件里的函数都是 `AutodreamEngine` 的方法体：`engine.js` 里保留同名同签名的方法，
 * 用 `xxxMod.name.call(this, …)` 转发进来 —— 所以函数体里的 `this` 就是引擎实例，
 * 与拆分前完全一致，没有引入任何模块级可变状态。
 */

import { CONFIG_VERSION, DEFAULT_CONFIG, LEGACY_STATE_FILE } from './config.js'
import { clampNum, readJson } from './util.js'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'

/**
 * 读配置 + 状态（同一个文件）。缺失或损坏都回落到默认值，绝不让它拖死插件加载。
 *
 * **改名迁移**：新文件 `<stateRoot>/autodream.json` 不存在而旧文件 `<stateRoot>/dream.json`
 * 存在时，读旧文件、把配置搬到新文件，**旧文件原样留着不删**（用户手改过的东西，
 * 插件没有替用户清理的资格；留着也让人能对照）。迁移只发生一次。
 */
export async function load() {
  if (this._configLoaded) return this.state
  let parsed = await readJson(this.configPath)
  let migratedFrom = ''
  if (!parsed) {
    const legacy = await readJson(this.legacyConfigPath)
    if (legacy && typeof legacy === 'object') {
      parsed = legacy
      migratedFrom = LEGACY_STATE_FILE
    }
  }
  if (parsed && typeof parsed === 'object') {
    this.state = {
      version: CONFIG_VERSION,
      config: { ...DEFAULT_CONFIG, ...(parsed.config ?? {}) },
      lastRunAt: Number(parsed.lastRunAt) || 0,
      lastResult: parsed.lastResult ?? null,
      retryAfter: Number(parsed.retryAfter) || 0,
    }
  } else {
    this.state = { version: CONFIG_VERSION, config: { ...DEFAULT_CONFIG }, lastRunAt: 0, lastResult: null, retryAfter: 0 }
  }
  this._configLoaded = true
  if (migratedFrom) {
    this.log('warn', `读到旧版配置 ${this.legacyConfigPath}，已迁移到 ${this.configPath}（旧文件保留不动）`)
    await this.persist().catch((err) => this.log('warn', `迁移落盘失败（本次仍按内存里的配置跑）：${err?.message ?? err}`))
  }
  return this.state
}

/** 落盘。写入是原子的（临时文件 + rename），半截文件不会留在盘上。 */
export async function persist() {
  await mkdir(this.stateRoot, { recursive: true })
  const tmp = `${this.configPath}.${process.pid}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    await rename(tmp, this.configPath)
  } finally {
    // rename 成功后 tmp 已不存在（ENOENT），失败时清掉不留垃圾。
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/** 给 UI 的完整配置（含有效模型路线与门控快照）。 */
export async function getConfig() {
  await this.load()
  const route = this.resolveRoute(this.state.config)
  return {
    config: { ...this.state.config },
    route,
    lastRunAt: this.state.lastRunAt,
    lastResult: this.state.lastResult,
    paths: { memoryDir: this.memoryDir, configPath: this.configPath, stateRoot: this.stateRoot, home: this.home },
    defaults: { ...DEFAULT_CONFIG },
  }
}

/** 改配置。逐项做类型与范围收敛——UI 传什么进来都不该写出一份坏配置。 */
export async function setConfig(patch) {
  await this.load()
  const p = patch && typeof patch === 'object' ? patch : {}
  const c = { ...this.state.config }
  if (typeof p.enabled === 'boolean') c.enabled = p.enabled
  if (p.trigger === 'auto' || p.trigger === 'manual') c.trigger = p.trigger
  if (typeof p.apply === 'boolean') c.apply = p.apply
  if (p.source === 'memory' || p.source === 'memory+sessions') c.source = p.source
  if (p.rollbackScope === 'files' || p.rollbackScope === 'all') c.rollbackScope = p.rollbackScope
  // 归档策略三档：与上面 trigger / rollbackScope 同一套写法 —— 非法值不写入，保留原值。
  if (p.autoArchive === 'off' || p.autoArchive === 'report' || p.autoArchive === 'auto') c.autoArchive = p.autoArchive
  if (p.minHours !== undefined) c.minHours = clampNum(Number(p.minHours), 1, 720, DEFAULT_CONFIG.minHours)
  if (p.minSessions !== undefined) c.minSessions = Math.round(clampNum(Number(p.minSessions), 1, 200, DEFAULT_CONFIG.minSessions))
  if (p.maxSteps !== undefined) c.maxSteps = Math.round(clampNum(Number(p.maxSteps), 1, 80, DEFAULT_CONFIG.maxSteps))
  if (p.maxSnapshotKeep !== undefined)
    c.maxSnapshotKeep = Math.round(clampNum(Number(p.maxSnapshotKeep), 1, 50, DEFAULT_CONFIG.maxSnapshotKeep))
  if (typeof p.provider === 'string') c.provider = p.provider.trim().slice(0, 120)
  if (typeof p.model === 'string') c.model = p.model.trim().slice(0, 160)
  this.state.config = c
  await this.persist()
  return await this.getConfig()
}

/** 当前会话默认模型路线（取不到就是 null）。 */
export function defaultSelection() {
  try {
    const sel = this.svc('agentDefaultModel')?.currentSelection?.()
    const provider = String(sel?.provider ?? '').trim()
    const model = String(sel?.model ?? '').trim()
    if (!provider || !model) return null
    return { provider, model }
  } catch {
    return null
  }
}

/**
 * 解析这一趟该用哪条模型路线。
 *
 * 三条语义必须分得清（否则「我明明选了模型它怎么还用别的」这类问题查不出来）：
 *   - `source:'config'`  用户显式指定 → **指定了就只认它**，解析不出来宁可报错也不回落
 *   - `source:'default'` 配置留空 → 用当前会话默认模型
 *   - `source:'none'`    两条都拿不到 → `error` 里写清原因
 * 永远返回对象，不抛异常；UI 两种形状都要能读（见 contract）。
 */
export function resolveRoute(config) {
  const p = String(config?.provider ?? '').trim()
  const m = String(config?.model ?? '').trim()
  const explicit = !!(p && m)
  // 只填了一半：这是配置错误，不是「跟随默认」。说清楚，别猜。
  if (!explicit && (p || m)) {
    return {
      provider: p,
      model: m,
      fromDefault: false,
      source: 'none',
      error: `配置里只填了 ${p ? 'provider' : 'model'}，必须成对填；两项都清空则跟随当前会话默认模型`,
    }
  }
  if (explicit) return { provider: p, model: m, fromDefault: false, source: 'config', error: null }
  const def = this.defaultSelection()
  if (def) return { provider: def.provider, model: def.model, fromDefault: true, source: 'default', error: null }
  return {
    provider: '',
    model: '',
    fromDefault: false,
    source: 'none',
    error: '配置里没写 provider/model，也拿不到当前会话默认模型',
  }
}

/**
 * 可选的模型路线清单。
 *
 * 数据源是宿主的 **`llm` 服务**（`listProviders()` + 逐 provider 的 `listModels()`），
 * 三个「看起来更顺手但会出错」的替代都被排除了：
 *   - `agentDefaultModel` 只有当前那一条，不是目录；
 *   - 面向子代理的模型选择策略会**按白名单过滤 provider**，拿它当全量目录会漏；
 *   - `sessionController.modelCatalog()` 依赖会话控制器挂载，而整理是后台任务。
 *
 * 单个 provider 取模型失败**不拖垮整表**（宿主自己的目录也是这么处理的）——
 * 一条渠道的 key 过期不该让整个下拉框变空。
 */
export async function listModels() {
  const routes = []
  let catalogAvailable = false
  let note = ''
  const llm = this.svc('llm')
  if (!llm || typeof llm.listProviders !== 'function') {
    note = 'llm 服务不可用，取不到模型目录，请手填 provider 与 model'
  } else {
    let providers = []
    try {
      providers = llm.listProviders() ?? []
    } catch (err) {
      note = `读取 provider 列表失败：${err?.message ?? err}`
    }
    for (const p of providers) {
      const pid = String(p?.id ?? '').trim()
      if (!pid) continue
      const pName = String(p?.name ?? pid).trim()
      let models = []
      try {
        // 同步返回数组或 Promise 都收（不同宿主版本两种都有）。
        models = (await llm.listModels(pid)) ?? []
      } catch {
        // 单个 provider 挂了不记 note：那是常态，不是整表故障。
        models = []
      }
      for (const m of models) {
        const mid = String(m?.id ?? '').trim()
        if (!mid) continue
        const mName = String(m?.name ?? mid).trim()
        routes.push({ provider: pid, model: mid, label: `${pName} / ${mName}`, isDefault: false })
      }
    }
    catalogAvailable = routes.length > 0
  }
  const def = this.defaultSelection()
  if (def) {
    const hit = routes.find((r) => r.provider === def.provider && r.model === def.model)
    if (hit) hit.isDefault = true
    else {
      // 当前默认模型可能来自一个 listModels 拿不到东西的 provider（见下面「空目录放行」）。
      // 把它补进来，否则下拉框会显示「跟随默认」但目录里找不到它。
      routes.unshift({
        provider: def.provider,
        model: def.model,
        label: `${def.provider} / ${def.model}`,
        isDefault: true,
      })
      catalogAvailable = true
    }
  }
  if (!catalogAvailable && !note) note = '宿主没有可枚举的模型目录，请手填 provider 与 model'
  routes.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))
  return { routes, defaultRoute: def, catalogAvailable, note }
}

/**
 * 运行前判「这条路线在宿主里存在吗」。
 *
 * 运行前先做一次**纯本地的存在性校验**（只比对宿主已注册的 provider / model 目录，
 * 不发任何模型请求）—— 这正是「运行前就报错，别跑到一半才失败」要的东西。
 *
 * 两个已知陷阱，都刻意避开：
 *   - **空目录放行**：某些适配器的 `listModels` 恒返回 `[]`。
 *     若把「目录为空」当「模型不存在」，会把明明能用的路线毙掉 → 返回 `ok:true, checked:false`。
 *   - **不做「查模型元数据」式的存在性判断**：有的适配器对未知模型不报错，
 *     而是合成一份假元数据（`name === id`），拿它校验等于永远通过。
 *
 * @returns {Promise<{ok:boolean, checked:boolean, reason:string}>}
 */
export async function checkRouteAvailable(provider, model) {
  const llm = this.svc('llm')
  if (!llm || typeof llm.listProviders !== 'function') {
    return { ok: true, checked: false, reason: 'llm 服务不可用，跳过存在性校验' }
  }
  let providers = []
  try {
    providers = llm.listProviders() ?? []
  } catch (err) {
    return { ok: true, checked: false, reason: `读取 provider 列表失败（${err?.message ?? err}），跳过校验` }
  }
  const ids = providers.map((p) => String(p?.id ?? '')).filter(Boolean)
  if (!ids.includes(provider)) {
    return { ok: false, checked: true, reason: `宿主没有名为 ${provider} 的 provider（已注册：${ids.join('、') || '（无）'}）` }
  }
  let models = []
  try {
    models = (await llm.listModels(provider)) ?? []
  } catch (err) {
    return { ok: false, checked: true, reason: `读取 ${provider} 的模型目录失败：${err?.message ?? err}` }
  }
  if (!models.length) {
    return { ok: true, checked: false, reason: `${provider} 的模型目录为空，无法判断该模型是否存在（放行）` }
  }
  if (!models.some((m) => String(m?.id ?? '') === model)) {
    const names = models.map((m) => String(m?.id ?? '')).filter(Boolean)
    return {
      ok: false,
      checked: true,
      reason: `${provider} 的目录里没有模型 ${model}（可选：${names.slice(0, 8).join('、')}${names.length > 8 ? '…' : ''}）`,
    }
  }
  return { ok: true, checked: true, reason: '' }
}

/** 当前状态快照，供设置面板轮询。 */
export async function status() {
  await this.load()
  const cfg = this.state.config
  const lastAt = this.state.lastRunAt
  const hoursSince = lastAt ? (Date.now() - lastAt) / 3600000 : null
  return {
    running: this.running,
    phase: this.phase,
    startedAt: this.startedAt,
    runId: this.runId,
    steps: this.stepLog,
    config: { ...cfg },
    route: this.resolveRoute(cfg),
    lastRunAt: lastAt,
    hoursSince,
    lastResult: this.state.lastResult,
    retryAfter: this.state.retryAfter,
    gate: cfg.enabled && cfg.trigger === 'auto' ? { minHours: cfg.minHours, minSessions: cfg.minSessions } : null,
    paths: { memoryDir: this.memoryDir, configPath: this.configPath, stateRoot: this.stateRoot, home: this.home },
  }
}

// ────────────────────────────── 门控 ──────────────────────────────
