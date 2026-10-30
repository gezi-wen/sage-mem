		/**
		 * 「自动做梦」面板 —— 让记忆自己整理一遍（引擎在 宿主侧 lib/autodream.js）。
		 *
		 * 数据全走 remote.autodream（宿主侧的 AutodreamGateway）。两条实现约定：
		 *   1. **轮询而不是等待**。「立即整理」启动后台任务后立刻返回 —— 一趟可能跑
		 *      几分钟，把 remote 调用挂在那儿等会撞上前端超时。进度靠每 2 秒拉一次
		 *      status() 显示。
		 *   2. **不替用户做判断**。触发方式 / 改动方式 / 输入源三件事各自明说代价
		 *      （比如「记忆 + 会话记录」会把私密对话送进模型），默认全是最保守的那一档。
		 */
		function AutodreamPanel(props) {
			// ⚠️ 必须走 stableRemote：真实宿主里 `ctx.get()` 每次返回**新对象**，
			// 而下面那个 effect 依赖 remote —— 直接用会让 effect 无限重跑（issue #3）。
			const remote = stableRemote(props.ctx, "remote.autodream");
			// 注入设置走 memory 那半边（autodream 只管整理那趟）
			const memRemote = stableRemote(props.ctx, "remote.memory");
			const sCfg = react.useState(null); const cfg = sCfg[0], setCfg = sCfg[1];
			const sSt = react.useState(null); const st = sSt[0], setSt = sSt[1];
			const sErr = react.useState(null); const err = sErr[0], setErr = sErr[1];
			const sNotice = react.useState(""); const notice = sNotice[0], setNotice = sNotice[1];
			const sBusy = react.useState(false); const busy = sBusy[0], setBusy = sBusy[1];
			const sReports = react.useState([]); const reports = sReports[0], setReports = sReports[1];
			const sOpen = react.useState(null); const open = sOpen[0], setOpen = sOpen[1];
			const sBody = react.useState(""); const body = sBody[0], setBody = sBody[1];
			const sProv = react.useState(""); const prov = sProv[0], setProv = sProv[1];
			const sModel = react.useState(""); const model = sModel[0], setModel = sModel[1];
			// ── 模型目录 / 回滚点 / 整理记录 / 整理声明 ──
			const sModels = react.useState(null); const models = sModels[0], setModels = sModels[1];
			const sSnaps = react.useState([]); const snaps = sSnaps[0], setSnaps = sSnaps[1];
			const sRuns = react.useState([]); const runs = sRuns[0], setRuns = sRuns[1];
			const sDeclOpen = react.useState(null); const declOpen = sDeclOpen[0], setDeclOpen = sDeclOpen[1];
			const sDeclBody = react.useState(""); const declBody = sDeclBody[0], setDeclBody = sDeclBody[1];
			const sConfirm = react.useState(null); const confirmSnap = sConfirm[0], setConfirmSnap = sConfirm[1];
			const sRbBusy = react.useState(null); const rbBusy = sRbBusy[0], setRbBusy = sRbBusy[1];
			const sRbMsg = react.useState(null); const rbMsg = sRbMsg[0], setRbMsg = sRbMsg[1];
			const sListErr = react.useState(null); const listErr = sListErr[0], setListErr = sListErr[1];
			const sWasRunning = react.useState(false); const wasRunning = sWasRunning[0], setWasRunning = sWasRunning[1];
			// ── 记忆注入设置（memory.getSettings / setSettings）──
			// limits = **当前生效**（模块加载时固化）；pendingLimits = **重启后才生效**。
			// 两个都必须在界面上，且看得出差别 —— 只显示一个就等于骗人。
			const sMemSet = react.useState(null); const memSet = sMemSet[0], setMemSet = sMemSet[1];
			const sLimitsDraft = react.useState(null); const limitsDraft = sLimitsDraft[0], setLimitsDraft = sLimitsDraft[1];
			const sSaveBusy = react.useState(false); const saveBusy = sSaveBusy[0], setSaveBusy = sSaveBusy[1];
			const sReservedNew = react.useState(""); const reservedNew = sReservedNew[0], setReservedNew = sReservedNew[1];
			// ── 1.8.0 侧栏入口开关（客户端行为：改完立刻生效，不需要重启）──
			const sSidebarBusy = react.useState(false); const sidebarBusy = sSidebarBusy[0], setSidebarBusy = sSidebarBusy[1];
			const sSidebarErr = react.useState(""); const sidebarErr = sSidebarErr[0], setSidebarErr = sSidebarErr[1];

			// 派生量放在 effect 之前：下面几个 effect 的依赖数组要在渲染期就能取到值。
			const c = cfg || {};
			const running = !!(st && st.running);
			const last = (st && st.lastResult) || null;
			const route = (st && st.route) || null;
			const rollbackScope = c.rollbackScope === "all" ? "all" : "files";
			// 保留名名单：reserved = 生效清单（含内置两个），reservedExtra = 用户自己声明的那部分。
			// 内置的两个 = 生效清单里不属于 reservedExtra 的那些 —— 不写死名字，host 那边改了这边跟着变。
			const extraReserved = Array.isArray(memSet && memSet.reservedExtra) ? memSet.reservedExtra : [];
			const extraLower = extraReserved.map(function (x) { return String(x).toLowerCase(); });
			const fixedReserved = ((memSet && memSet.reserved) || []).filter(function (n) {
				return extraLower.indexOf(String(n).toLowerCase()) < 0;
			});
			// 默认开：宿主没回 ui 字段（旧版本）或值不是布尔，都按「开」显示。
			const sidebarEntryOn = !(memSet && memSet.ui && memSet.ui.sidebarEntry === false);

			react.useEffect(function () {
				if (!remote) { setErr(t("ad.err.remoteUnavailable")); return undefined; }
				let alive = true;
				function pull() {
					callRemote("status", [], function (d) {
						if (!alive || !d) return;
						setSt(d); if (d.config) setCfg(d.config);
						setErr(null);
					}, function (m) { if (alive) setErr(m); });
				}
				pull();
				refreshLists();
				loadModels();
				loadMemSettings();
				const id = setInterval(pull, 2000);
				return function () { alive = false; clearInterval(id); };
			}, [remote]);

			// 一趟跑完（running true → false）就把回滚点 / 整理记录 / 报告刷一遍：
			// 刚跑完那一刻列表还是旧的，等下一次进面板才更新会让人以为没生效。
			react.useEffect(function () {
				if (wasRunning && !running) refreshLists();
				if (wasRunning !== running) setWasRunning(running);
			}, [running]);

			// 模型行的手填框：配置里的 provider/model 变了就同步过去（保存后回填）。
			react.useEffect(function () {
				setProv(c.provider || "");
				setModel(c.model || "");
			}, [c.provider, c.model]);

			/**
			 * 所有 remote 调用的统一出口。
			 *
			 * 契约的硬约束是「每个调用都 try/catch，失败显示错误文案、不白屏」，而
			 * 这里还有第三种失败：宿主侧是旧版本、方法根本不在 remote 对象上
			 * （typeof !== "function"）—— 那会在 `.then` 之前就抛 TypeError。
			 * 三种都收敛到 onErr，面板只会多一行红字。
			 */
			function callRemote(name, args, onOk, onErr) {
				const fn = remote ? remote[name] : null;
				if (typeof fn !== "function") { if (onErr) onErr(t("ad.err.noInterface", { name: name })); return; }
				let p;
				try { p = fn.apply(remote, args || []); }
				catch (e) { if (onErr) onErr(detail(e)); return; }
				Promise.resolve(p).then(function (r) { if (onOk) onOk(unwrap(r)); })
					.catch(function (e) { if (onErr) onErr(detail(e)); });
			}

			function patch(p) {
				setErr(null); setNotice("");
				callRemote("setConfig", [p], function (d) {
					if (d && d.config) setCfg(d.config);
				}, function (m) { setErr(m); });
			}

			// ── 注入设置：5 项上限 + 保留名名单 ─────────────────────────────
			// 边界与 host 的 LIMIT_SPECS 一一对应（那边是权威，这里只是提前拦明显笔误）。
			const LIMIT_FIELDS = [
				{ key: "maxResults", labelKey: "ad.limit.maxResults", lo: 1, hi: 30, unitKey: "ad.unit.items" },
				{ key: "maxChars", labelKey: "ad.limit.maxChars", lo: 200, hi: 20000, unitKey: "ad.unit.chars" },
				{ key: "maxBaseline", labelKey: "ad.limit.maxBaseline", lo: 1, hi: 50, unitKey: "ad.unit.items" },
				{ key: "maxSessionBytes", labelKey: "ad.limit.maxSessionBytes", lo: 4096, hi: 524288, unitKey: "ad.unit.bytes" },
				{ key: "staleDays", labelKey: "ad.limit.staleDays", lo: 0, hi: 365, unitKey: "ad.unit.days" },
			];
			const limitLabel = function (f) { return t(f.labelKey); };
			const limitUnit = function (f) { return t(f.unitKey); };

			/** 把一份 limits 对象摊成输入框用的字符串草稿（输入期间允许非法，保存时再校验）。 */
			function limitsDraftOf(src) {
				const out = {};
				for (const f of LIMIT_FIELDS) out[f.key] = src && src[f.key] != null ? String(src[f.key]) : "";
				return out;
			}

			function loadMemSettings(onOk) {
				if (!memRemote || typeof memRemote.getSettings !== "function") return;
				Promise.resolve(memRemote.getSettings()).then(function (res) {
					const d = unwrap(res) || {};
					setMemSet(d);
					setLimitsDraft(limitsDraftOf(d.pendingLimits || d.limits || {}));
					if (onOk) onOk(d);
				}, function (e) { setErr(detail(e)); });
			}

			/** 保存 5 项上限。越界/非整数**本地先拦**（host 也是直接拒绝），别让它白跑一趟。 */
			function saveLimits() {
				if (!memRemote || typeof memRemote.setSettings !== "function") { setErr(t("ad.err.noSetSettings")); return; }
				const draft = limitsDraft || {};
				const limits = {};
				const bad = [];
				for (const f of LIMIT_FIELDS) {
					const raw = String(draft[f.key] == null ? "" : draft[f.key]).trim();
					const n = Number(raw);
					if (raw === "" || !Number.isFinite(n) || !Number.isInteger(n)) { bad.push(t("ad.err.limitInteger", { label: limitLabel(f) })); continue; }
					if (n < f.lo || n > f.hi) { bad.push(t("ad.err.limitRange", { label: limitLabel(f), lo: f.lo, hi: f.hi })); continue; }
					limits[f.key] = n;
				}
				if (bad.length) { setErr(t("ad.err.notSaved", { detail: bad.join(t("ad.errSep")) })); return; }
				setSaveBusy(true); setErr(null); setNotice("");
				Promise.resolve(memRemote.setSettings({ limits: limits })).then(function (out) {
					setSaveBusy(false);
					// setSettings 是 {ok:true, settings, restartRequired} 形状：不要过 unwrap
					// （unwrap 只认 {ok, value}，这里会把 settings 吃掉）。
					if (out && out.ok === false) { setErr(out.error || t("ad.err.saveRejected")); return; }
					if (out && out.settings) { setMemSet(out.settings); setLimitsDraft(limitsDraftOf(out.settings.pendingLimits)); }
					else loadMemSettings();
					setNotice(t("ad.notice.limitsSaved"));
				}, function (e) { setSaveBusy(false); setErr(detail(e)); });
			}

			/**
			 * 侧栏入口开关（1.8.0）。
			 *
			 * 顺序是「先写设置、成功后再动槽位」：设置没落盘就不该让界面先变一个样。
			 * 失败只报错、不改任何东西 —— checkbox 的勾选状态由 memSet 派生，于是自动回到原值。
			 * 成功后调 `setSidebarEntry`：**立即**增删侧栏槽位，不刷新、不重启。
			 */
			function saveSidebarEntry(next) {
				if (!memRemote || typeof memRemote.setSettings !== "function") {
					setSidebarErr(t("ad.err.noSetSettings"));
					return;
				}
				if (sidebarBusy) return;
				setSidebarBusy(true); setSidebarErr(""); setNotice("");
				Promise.resolve(memRemote.setSettings({ ui: { sidebarEntry: !!next } })).then(function (out) {
					setSidebarBusy(false);
					// 与 saveLimits 同款：setSettings 是 {ok, settings, restartRequired} 形状，不要过 unwrap。
					if (out && out.ok === false) { setSidebarErr(out.error || t("ad.err.saveRejected")); return; }
					if (out && out.settings) setMemSet(out.settings);
					else loadMemSettings();
					setSidebarEntry(!!next);
					setNotice(!!next ? t("ad.notice.sidebarOn") : t("ad.notice.sidebarOff"));
				}, function (e) { setSidebarBusy(false); setSidebarErr(detail(e)); });
			}

			/**
			 * 保存保留名名单（用户声明的那部分）。
			 *
			 * 两个内置名（memory.md / session-log.md）**不在**这份名单里，也不在界面上给删除入口 ——
			 * 那是生效清单里固定的两个，删不掉。这里管的只是用户自己加的那些。
			 */
			function saveReserved(list) {
				if (!memRemote || typeof memRemote.setSettings !== "function") { setErr(t("ad.err.noSetSettings")); return; }
				setSaveBusy(true); setErr(null); setNotice("");
				Promise.resolve(memRemote.setSettings({ reserved: list })).then(function (out) {
					setSaveBusy(false);
					if (out && out.ok === false) { setErr(out.error || t("ad.err.reservedRejected")); return; }
					if (out && out.settings) setMemSet(out.settings);
					else loadMemSettings();
					setNotice(t("ad.notice.reservedSaved"));
				}, function (e) { setSaveBusy(false); setErr(detail(e)); });
			}

			function addReserved() {
				const name = String(reservedNew || "").trim();
				const extra = Array.isArray(memSet && memSet.reservedExtra) ? memSet.reservedExtra : [];
				if (!name) { setErr(t("ad.err.reservedNeedName")); return; }
				// 与 host 的校验同一套：单个 .md 文件名、不许带路径
				if (!name.endsWith(".md") || name.includes("/") || name.includes("\\") || name.startsWith("..")) {
					setErr(t("ad.err.reservedBadName", { name: name }));
					return;
				}
				if (extra.some(function (x) { return String(x).toLowerCase() === name.toLowerCase(); })) {
					setErr(t("ad.err.reservedDup", { name: name }));
					return;
				}
				setReservedNew("");
				saveReserved(extra.concat([name]));
			}

			function removeReserved(name) {
				const extra = Array.isArray(memSet && memSet.reservedExtra) ? memSet.reservedExtra : [];
				saveReserved(extra.filter(function (x) { return x !== name; }));
			}

			/** 报告 / 回滚点 / 整理记录三份列表一起刷。 */
			function refreshLists() {
				callRemote("listReports", [], function (d) {
					setReports(Array.isArray(d) ? d : []);
				}, function () {});
				callRemote("listSnapshots", [], function (d) {
					setSnaps(Array.isArray(d) ? d : []);
				}, function (m) { setListErr(m); });
				callRemote("listRuns", [{ limit: 20 }], function (d) {
					setRuns(Array.isArray(d) ? d : []);
				}, function (m) { setListErr(m); });
			}

			function loadModels() {
				callRemote("listModels", [], function (d) {
					setModels(d && typeof d === "object" && !Array.isArray(d) ? d : { catalogAvailable: false, routes: [], note: "" });
				}, function (m) {
					setModels({ catalogAvailable: false, routes: [], note: t("ad.note.modelCatalogUnavailable", { error: m }) });
				});
			}

			function run() {
				setErr(null); setNotice(""); setBusy(true);
				// 契约：runNow({ reason })。reason 只落进 manifest 给人看；门控的豁免
				// 由 宿主侧负责（手动点了按钮就不该被「还没到 N 小时」挡回来）。
				callRemote("runNow", [{ reason: "设置页手动触发" }], function (d) {
					if (d && d.ok === false) setErr(d.error || t("ad.err.startFailed"));
					else { setNotice(t("ad.notice.started")); refreshLists(); }
					setBusy(false);
				}, function (m) { setErr(m); setBusy(false); });
			}

			function openReport(name) {
				if (name === null) { setOpen(null); setBody(""); return; }
				setOpen(name); setBody(t("ad.loading"));
				callRemote("readReport", [name], function (d) {
					setBody((d && d.content) || t("ad.empty"));
				}, function (m) { setBody(t("ad.err.readFailed", { error: m })); });
			}

			/** 整理声明：点开才拉，拉回来的是 Markdown 原文，直接用 pre 呈现。 */
			function openDecl(runId) {
				if (declOpen === runId) { setDeclOpen(null); setDeclBody(""); return; }
				setDeclOpen(runId); setDeclBody(t("ad.loading"));
				callRemote("readDeclaration", [{ runId: runId }], function (d) {
					setDeclBody((d && d.markdown) || t("ad.emptyDeclaration"));
				}, function (m) { setDeclBody(t("ad.err.readFailed", { error: m })); });
			}

			/**
			 * 回滚。二次确认在 JSX 里（点了「回滚」先展开确认条），这里只负责调用。
			 * 结果就地回显 —— 恢复几个、移走几个、保护快照 id，全都写在同一行里。
			 */
			function doRollback(sp) {
				const scope = rollbackScope;
				setErr(null); setNotice(""); setRbMsg(null); setRbBusy(sp.name);
				callRemote("rollback", [{ snapshotId: sp.name, scope: scope }], function (d) {
					const x = d || {};
					if (x.ok === false) {
						setRbMsg({ bad: true, text: t("ad.err.rollbackFailed", { error: x.error || t("ad.unknownReason") }) });
					} else {
						setRbMsg({ bad: false, text: t("ad.rb.rolledBack", {
							at: String(sp.atHuman || ""),
							restored: (x.restored == null ? "?" : x.restored),
							parked: (x.parked == null ? "?" : x.parked),
						}) +
							// skipped = 想动但没动的（archive/ 已有同名、或回滚点里没那一版）。
							// 不显示它等于「部分成功」被说成「成功」——回滚这种事不能含糊。
							(x.skipped ? t("ad.rb.skipped", { count: x.skipped }) : "") +
							(x.protection ? t("ad.rb.protection", { id: x.protection }) : "") +
							(x.report ? t("ad.rb.report", { name: x.report }) : "") });
						setConfirmSnap(null);
					}
					setRbBusy(null);
					refreshLists();
				}, function (m) { setRbMsg({ bad: true, text: t("ad.err.rollbackFailed", { error: m }) }); setRbBusy(null); });
			}

			// 实际生效路线（契约：route 可能为 null；source==='none' 时 error 里是原因）。
			const routeBad = !route || route.source === "none" || !route.provider || !route.model;
			const routeInfo = routeBad
				? t("ad.route.bad", { error: (route && route.error) || t("ad.route.badFallback") })
				: t("ad.route.ok", { provider: route.provider, model: route.model }) +
					(route.fromDefault ? t("ad.route.fromDefault") : t("ad.route.fromConfig"));

			// 模型 <select> 的取值：''=跟随默认；否则是 "provider::model" 的 JSON 编码。
			// 配置里指定的路线万一下架了（不在目录里），也要让它显示出来 —— 否则
			// 下拉框会悄悄跳到「跟随默认」，与下面那行「实际生效路线」自相矛盾。
			const modelRoutes = (models && Array.isArray(models.routes)) ? models.routes : [];
			const modelValue = (c.provider && c.model) ? encodeRoute(c.provider, c.model) : "";
			const modelValueInCatalog = modelValue === "" || modelRoutes.some(function (r) {
				return encodeRoute(r.provider, r.model) === modelValue;
			});

			// 二级分组：**运行 / 设置 / 记录**。
			// 这三类东西原来混在一条滚动里（实测约 1760px）：跑一次要用的、要调的、回头看历史的
			// 全叠在一起，找什么东西都得滚。分段之后每段都落在一屏内（标尺：可视高度约 1000px）。
			// ⚠️ 分段状态放在 Section 里（props.seg），因为头部带的「待重启生效」徽标要能一步切到「设置」。
			const segOf = (props.seg === "settings" || props.seg === "records") ? props.seg : "run";
			const subtab = (name, label, note) => h("button", {
				type: "button", key: name, className: "smem-subtab" + (segOf === name ? " smem-subtab--on" : ""),
				"aria-current": segOf === name ? "true" : "false",
				onClick: function () { if (props.onSeg) props.onSeg(name); },
			}, [label, note ? h("span", { className: "smem-subtab-n", key: "n" }, note) : null]);

			return h("div", { className: "smem-autodream" }, [
				h("div", { className: "smem-subtabs", key: "segs" }, [
					subtab("run", t("ad.tab.run")),
					subtab("settings", t("ad.tab.settings")),
					subtab("records", t("ad.tab.records"), String(snaps.length + runs.length + reports.length)),
				]),
				segOf === "run" ? h("div", { key: "seg-run" }, [
				h("div", { className: "smem-autodream-sec", key: "top" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("button", {
							type: "button", key: "sw", className: "smem-switch",
							"data-on": c.enabled ? "1" : "0",
							title: c.enabled ? t("ad.switch.onTitle") : t("ad.switch.offTitle"),
							"aria-label": t("ad.switch.aria"),
							onClick: function () { patch({ enabled: !c.enabled }); },
						}),
						h("span", { key: "t", style: { fontWeight: "600" } }, t("ad.title")),
						h("span", { className: "smem-status", key: "s" },
							running ? t("ad.status.running", { phase: String((st && st.phase) || t("ad.status.preparing")) }) : (c.enabled ? t("ad.status.idle") : t("ad.status.off"))),
					]),
					h("div", { className: "smem-autodream-note", key: "n" }, t("ad.note.what")),
				]),
				h("div", { className: "smem-autodream-sec", key: "mode" }, [
					h("div", { className: "smem-autodream-row", key: "a" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, t("ad.row.trigger")),
						h(Seg, {
							key: "v", value: c.trigger,
							options: [{ value: "manual", label: t("ad.trigger.manual") }, { value: "auto", label: t("ad.trigger.auto") }],
							onChange: function (v) { patch({ trigger: v }); },
						}),
					]),
					h("div", { className: "smem-autodream-row", key: "b" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, t("ad.row.apply")),
						h(Seg, {
							key: "v", value: c.apply ? "apply" : "report",
							options: [{ value: "report", label: t("ad.apply.report") }, { value: "apply", label: t("ad.apply.apply") }],
							onChange: function (v) { patch({ apply: v === "apply" }); },
						}),
					]),
					h("div", { className: "smem-autodream-row", key: "c" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, t("ad.row.source")),
						h(Seg, {
							key: "v", value: c.source,
							options: [{ value: "memory", label: t("ad.source.memory") }, { value: "memory+sessions", label: t("ad.source.sessions") }],
							onChange: function (v) { patch({ source: v }); },
						}),
					]),
					h("div", { className: "smem-autodream-note", key: "w" },
						c.source === "memory+sessions"
							? t("ad.note.sourceSessions")
							: t("ad.note.sourceMemory")),
					h("div", { className: "smem-autodream-note", key: "w2" },
						c.apply
							? t("ad.note.applySnapshot")
							: t("ad.note.reportOnly")),
				]),
				h("div", { className: "smem-autodream-sec", key: "model" }, [
					h("div", { className: "smem-autodream-row", key: "model" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, t("ad.row.model")),
						// 有可枚举的模型目录就给 <select>（首项 = 跟随会话默认，值 "":""）；
						// 目录不可用就退化成两个文本框（契约第六节第 2 条）。
						(models && models.catalogAvailable)
							? h("select", {
									className: "smem-input smem-ad-select", key: "sel",
									value: modelValue,
									onChange: function (e) {
										const v = e.target.value;
										if (!v) { patch({ provider: "", model: "" }); return; }
										const r = decodeRoute(v);
										patch({ provider: r.provider, model: r.model });
									},
								}, [h("option", { key: "__def", value: "" },
										t("ad.model.followDefault") + ((models.defaultRoute && models.defaultRoute.provider && models.defaultRoute.model)
											? t("ad.model.defaultRoute", { provider: String(models.defaultRoute.provider), model: String(models.defaultRoute.model) })
											: ""),
									)].concat(
										modelValueInCatalog ? [] : [h("option", { key: "__cur", value: modelValue }, String(c.provider) + " / " + String(c.model) + t("ad.model.currentOutOfCatalog"))],
										modelRoutes.map(function (r) {
											return h("option", { key: String(r.provider) + "/" + String(r.model), value: encodeRoute(r.provider, r.model) },
												r.label || (String(r.provider) + " / " + String(r.model)));
										}),
									))
							: models
								? [
										h("input", { className: "smem-input", key: "p", style: { flex: "1", minWidth: "110px" }, value: prov, placeholder: t("ad.model.placeholder.provider"), onChange: function (e) { setProv(e.target.value); } }),
										h("input", { className: "smem-input", key: "m", style: { flex: "1", minWidth: "110px" }, value: model, placeholder: t("ad.model.placeholder.model"), onChange: function (e) { setModel(e.target.value); } }),
										h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "ok", onClick: function () { patch({ provider: prov, model: model }); setNotice(t("ad.model.saved")); } }, t("ad.action.save")),
									]
								: [
										h("span", { className: "smem-status", key: "load" }, t("ad.loadingModels")),
										h("button", { type: "button", className: "smem-btn", key: "man", onClick: function () { setModels({ catalogAvailable: false, routes: [], note: "" }); } }, t("ad.action.manualEntry")),
									],
					]),
					h("div", {
						className: "smem-autodream-note" + (routeBad ? " smem-ad-err" : ""),
						key: "route",
					}, (routeBad ? "✗ " : "✓ ") + routeInfo),
					models && models.catalogAvailable === false && models.note
						? h("div", { className: "smem-autodream-note", key: "mnote" }, String(models.note))
						: null,
				]),
				h("div", { className: "smem-autodream-sec", key: "run" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("button", {
							type: "button", className: "smem-btn smem-btn-primary", key: "go",
							disabled: busy || running || !remote,
							onClick: run,
						}, running ? t("ad.action.runningNow") : t("ad.action.runNow")),
						h("span", { className: "smem-status", key: "s" },
							running
								? t("ad.run.steps", { count: ((st && st.steps && st.steps.length) || 0), phase: String((st && st.phase) || "") })
								: (st && st.hoursSince != null ? t("ad.run.hoursSince", { hours: st.hoursSince.toFixed(1) }) : t("ad.run.never"))),
					]),
					running && st && st.steps && st.steps.length
						? h("div", { className: "smem-autodream-note", key: "prog" }, st.steps.map(function (x) {
								return t("ad.run.progress", { step: x.step, tools: (x.tools.length ? x.tools.join(t("ad.toolSep")) : t("ad.run.stepDone")) });
							}).join(t("ad.progressSep")))
						: null,
					last
						? h("div", { className: "smem-status", key: "last" },
								t("ad.last.prefix", {
									at: String(last.atHuman || ""),
									result: (last.ok
										? (t("ad.last.ok") + (last.apply ? t("ad.last.applied", { count: ((last.touched || []).length) }) : t("ad.last.reportOnly")) +
											t("ad.last.problems", { before: last.problemsBefore, after: last.problemsAfter }) +
											t("ad.last.tokens", { in: last.tokensIn, out: last.tokensOut }))
										: t("ad.last.failed", { error: (last.error || t("ad.unknown")) })),
								}) +
								// 1.9.2：残篇必须在状态行上就能看见 —— 只写「成功」正是 10-25 那次误判的来源。
								(last.ok && last.truncated ? t("ad.last.truncated") : "") +
								(last.ok && !last.truncated && last.retries ? t("ad.last.retried", { count: last.retries }) : "") +
								(last.continuations ? t("ad.last.continuations", { count: last.continuations }) : "") +
								(last.report ? t("ad.last.report", { name: last.report }) : ""))
						: null,
				]),
				]) : null,
				segOf === "settings" ? h("div", { key: "seg-set" }, [
				// 1.8.0：侧栏入口开关。默认开；关掉只影响侧栏那个图标，
				// 「设置 → 记忆管理」这个入口永远在（它注册在 80-apply，和这个开关无关）。
				h("div", { className: "smem-autodream-sec", key: "sidebar-entry" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, t("ad.sidebar.title")),
						h("span", { className: "smem-status", key: "s" }, sidebarEntryOn ? t("ad.sidebar.on") : t("ad.sidebar.off")),
					]),
					h("div", { className: "smem-autodream-note", key: "n" }, t("ad.sidebar.note")),
					h("label", { className: "smem-check", key: "row" }, [
						h("input", {
							type: "checkbox", key: "c",
							checked: sidebarEntryOn,
							disabled: sidebarBusy,
							onChange: function (e) { saveSidebarEntry(!!(e.target && e.target.checked)); },
						}),
						h("span", { key: "l" }, t("ad.sidebar.label")),
					]),
					sidebarErr ? h("div", { className: "smem-autodream-note smem-ad-warn", key: "err" }, sidebarErr) : null,
				]),
				// 自动归档那一段（三档策略 + 三个阈值）**已挪到「自动归档」页签**（v0.9.9）：
				// 归档是确定性规则、不调模型，和这一页的「让模型整理」不是一件事；
				// 同一件事只在一处设定，这里不再重复摆一份。
				h("div", { className: "smem-autodream-sec", key: "limits" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, t("ad.limits.title")),
						memSet && memSet.restartRequired
							? h("span", { className: "smem-ad-badge smem-ad-badge--warn", key: "w" }, t("ad.limits.pending"))
							: null,
					]),
					memSet && memSet.restartRequired
						? h("div", { className: "smem-autodream-note smem-ad-warn", key: "rw" }, t("ad.limits.restartWarn"))
						: h("div", { className: "smem-autodream-note", key: "rn" }, t("ad.limits.restartNote")),
					// 五个参数排两列（一行两个）：同样的信息，行数少一半，扫读反而更清楚。
					h("div", { className: "smem-ad-grid2", key: "grid" }, LIMIT_FIELDS.map(function (f) {
						const cur = memSet && memSet.limits ? memSet.limits[f.key] : null;
						const pend = memSet && memSet.pendingLimits ? memSet.pendingLimits[f.key] : null;
						const diff = cur != null && pend != null && cur !== pend;
						return h("div", { className: "smem-ad-field", key: f.key }, [
							h("span", { className: "smem-autodream-key", key: "k", title: t("ad.limit.labelTitle", { unit: limitUnit(f), lo: f.lo, hi: f.hi }) }, limitLabel(f)),
							h("input", {
								className: "smem-num", key: "v", type: "number",
								min: String(f.lo), max: String(f.hi),
								title: t("ad.limit.inputTitle", { lo: f.lo, hi: f.hi, unit: limitUnit(f) }),
								value: limitsDraft && limitsDraft[f.key] != null ? limitsDraft[f.key] : "",
								onChange: function (e) {
									const nx = Object.assign({}, limitsDraft);
									nx[f.key] = e.target.value;
									setLimitsDraft(nx);
								},
							}),
							diff
								? h("span", { className: "smem-ad-badge smem-ad-badge--warn", key: "d" }, t("ad.limit.diff", { current: String(cur), pending: String(pend) }))
								: h("span", { className: "smem-status", key: "d" }, t("ad.limit.range", { lo: f.lo, hi: f.hi }) + (cur == null ? "" : t("ad.limit.current", { current: String(cur) }))),
						]);
					})),
					h("div", { className: "smem-autodream-row", key: "save" }, [
						h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "s", disabled: saveBusy, onClick: saveLimits }, saveBusy ? t("ad.action.saving") : t("ad.action.saveLimits")),
						h("span", { className: "smem-status", key: "n" }, t("ad.limits.saveHint")),
					]),
				]),
				h("div", { className: "smem-autodream-sec", key: "reserved" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, t("ad.reserved.title")),
						h("span", { className: "smem-status", key: "c" }, t("ad.reserved.subtitle")),
					]),
					h("div", { className: "smem-autodream-note", key: "n" }, t("ad.reserved.note")),
					h("div", { className: "smem-raw-names", key: "fixed" }, fixedReserved.map(function (n) {
						return h("span", { className: "smem-chip smem-chip--fixed", key: n, title: t("ad.reserved.fixedTitle") }, n + t("ad.reserved.fixedSuffix"));
					})),
					h("div", { className: "smem-raw-names", key: "extra" },
						extraReserved.length
							? extraReserved.map(function (n) {
									return h("span", { className: "smem-chip", key: n, "data-on": "1" }, [
										n,
										h("button", { type: "button", className: "smem-chip-x", key: "x", title: t("ad.reserved.removeTitle", { name: n }), onClick: function () { removeReserved(n); } }, "✕"),
									]);
								})
							: h("span", { className: "smem-status", key: "none" }, t("ad.reserved.empty"))),
					h("div", { className: "smem-autodream-row", key: "add" }, [
						h("input", {
							className: "smem-input", key: "i",
							style: { flex: "1", minWidth: "150px" },
							value: reservedNew,
							placeholder: t("ad.reserved.placeholder"),
							onChange: function (e) { setReservedNew(e.target.value); },
						}),
						h("button", { type: "button", className: "smem-btn", key: "a", disabled: saveBusy, onClick: addReserved }, t("ad.action.addToList")),
					]),
				]),
				h("details", { className: "smem-autodream-adv", key: "adv", open: true }, [
					h("summary", { key: "s" }, t("ad.advanced")),
					h("div", { key: "d" }, [
						c.trigger === "auto" ? h("div", { className: "smem-autodream-row", key: "gate" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, t("ad.adv.autoTrigger")),
							h("span", { className: "smem-status", key: "a" }, t("ad.adv.since")),
							h("input", { className: "smem-num", key: "h", type: "number", min: "1", max: "720", value: c.minHours, onChange: function (e) { patch({ minHours: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "b" }, t("ad.adv.hoursAndSessions")),
							h("input", { className: "smem-num", key: "m", type: "number", min: "1", max: "200", value: c.minSessions, onChange: function (e) { patch({ minSessions: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "c" }, t("ad.adv.sessionsUpdated")),
						]) : null,
						h("div", { className: "smem-autodream-row", key: "steps" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, t("ad.adv.maxSteps")),
							h("input", { className: "smem-num", key: "v", type: "number", min: "1", max: "80", value: c.maxSteps, onChange: function (e) { patch({ maxSteps: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "s" }, t("ad.adv.stepNote")),
						]),
						// 1.9.2：单次输出上限（原写死 4096）。思考型模型下 4096 会让收尾轮只剩思考、零正文。
						h("div", { className: "smem-autodream-row", key: "maxout" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, t("ad.adv.maxOutput")),
							h("input", { className: "smem-num", key: "v", type: "number", min: "1024", max: "131072", value: c.maxOutputTokens, onChange: function (e) { patch({ maxOutputTokens: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "s" }, t("ad.adv.maxOutputNote")),
						]),
						h("div", { className: "smem-autodream-row", key: "keep" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, t("ad.adv.keepSnapshots")),
							h("input", { className: "smem-num", key: "v", type: "number", min: "1", max: "50", value: c.maxSnapshotKeep, onChange: function (e) { patch({ maxSnapshotKeep: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "s" }, t("ad.unit.copies")),
						]),
						h("div", { className: "smem-status", key: "paths" }, t("ad.adv.paths", { path: ((st && st.paths && st.paths.configPath) || "—") })),
					]),
				]),
				]) : null,
				// ── 回滚点（新）──────────────────────────────────────────────
				// 只改这一个文件、只用既有 h() 写法；数据全走 remote.autodream。
				segOf === "records" ? h("div", { key: "seg-rec" }, [
				h("div", { className: "smem-autodream-sec", key: "snap" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, t("ad.records.snapshots")),
						h("span", { className: "smem-status", key: "c" }, t("ad.records.countSnaps", { count: String(snaps.length) })),
						h("button", { type: "button", className: "smem-btn", key: "rf", onClick: refreshLists }, t("ad.action.refresh")),
					]),
					h("div", { className: "smem-autodream-row", key: "scope" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, t("ad.row.rollbackScope")),
						h(Seg, {
							key: "v", value: rollbackScope,
							options: [{ value: "files", label: t("ad.scope.files") }, { value: "all", label: t("ad.scope.all") }],
							onChange: function (v) { patch({ rollbackScope: v }); },
						}),
					]),
					h("div", { className: "smem-autodream-note", key: "n" }, t("ad.note.rollback")),
					snaps.length === 0
						? h("div", { className: "smem-status", key: "e" }, t("ad.snap.empty"))
						: h("div", { className: "smem-autodream-list", key: "l" }, snaps.slice(0, 15).map(function (sp) {
								const label = sp.legacy ? t("ad.snap.legacyLabel") : (sp.runId ? t("ad.snap.runLabel", { id: String(sp.runId) }) : t("ad.snap.protectionLabel"));
								return h("div", { className: "smem-ad-wrap", key: String(sp.name) }, [
									h("div", { className: "smem-ad-snap", key: "row" }, [
										h("div", { className: "smem-ad-main", key: "m" }, [
											h("div", { key: "l1" }, t("ad.snap.meta", { at: String(sp.atHuman || ""), files: (sp.files == null ? "?" : sp.files) })),
											h("div", { className: "smem-ad-sub", key: "l2" }, label + " · " + String(sp.name || "")),
										]),
										sp.legacy ? h("span", { className: "smem-ad-badge smem-ad-badge--legacy", key: "lg" }, t("ad.snap.legacyBadge")) : null,
										confirmSnap === sp.name
											? null
											: h("button", {
													type: "button", className: "smem-btn", key: "go",
													disabled: rbBusy !== null,
													onClick: function () { setRbMsg(null); setConfirmSnap(sp.name); },
												}, t("ad.action.rollback")),
									]),
									confirmSnap === sp.name
										? h("div", { className: "smem-ad-confirm", key: "cf" }, [
												h("div", { key: "t", style: { fontWeight: "600" } }, t("ad.snap.confirmTitle", { at: String(sp.atHuman || "") })),
												h("div", { key: "d" }, t("ad.snap.confirmScope", {
													scope: rollbackScope === "all" ? t("ad.snap.scopeAll") : t("ad.snap.scopeFiles"),
												}) + t("ad.snap.confirmSuffix")),
												h("div", { className: "smem-autodream-row", key: "acts" }, [
													h("button", {
														type: "button", className: "smem-btn smem-btn-danger", key: "yes",
														disabled: rbBusy === sp.name,
														onClick: function () { doRollback(sp); },
													}, rbBusy === sp.name ? t("ad.action.rollingBack") : t("ad.action.confirmRollback")),
													h("button", { type: "button", className: "smem-btn", key: "no", onClick: function () { setConfirmSnap(null); } }, t("ad.action.cancel")),
												]),
											])
										: null,
								]);
							})),
					rbMsg ? h("div", { className: "smem-ad-rb " + (rbMsg.bad ? "smem-ad-err" : "smem-ok"), key: "rb" }, (rbMsg.bad ? "⚠ " : "✓ ") + rbMsg.text) : null,
				]),
				// ── 整理声明（新）──────────────────────────────────────────
				h("div", { className: "smem-autodream-sec", key: "runs" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, t("ad.records.runs")),
						h("span", { className: "smem-status", key: "c" }, t("ad.records.countRuns", { count: String(runs.length) })),
						h("button", { type: "button", className: "smem-btn", key: "rf", onClick: refreshLists }, t("ad.action.refresh")),
					]),
					h("div", { className: "smem-autodream-note", key: "n" }, t("ad.records.runsNote")),
					runs.length === 0
						? h("div", { className: "smem-status", key: "e" }, t("ad.records.runsEmpty"))
						: h("div", { className: "smem-autodream-list", key: "l" }, runs.slice(0, 15).map(function (rn) {
								return h("div", { className: "smem-ad-wrap", key: String(rn.runId) }, [
									h("button", {
										type: "button", className: "smem-ad-run",
										"data-on": declOpen === rn.runId ? "1" : "0",
										onClick: function () { openDecl(rn.runId); },
									}, [
										h("span", { key: "t" }, String(rn.atHuman || "")),
										h("span", { className: "smem-ad-badge", key: "m" }, rn.mode === "apply" ? t("ad.badge.apply") : t("ad.badge.report")),
										h("span", { key: "c" }, t("ad.run.changes", { count: (rn.changeCount == null ? "?" : rn.changeCount) })),
										rn.report ? h("span", { className: "smem-ad-sub", key: "r" }, t("ad.run.reportName", { name: String(rn.report) })) : null,
										rn.rolledBackAt
											? h("span", { className: "smem-ad-badge smem-ad-badge--warn", key: "rb" },
													rn.rolledBackAtHuman ? t("ad.run.rolledBackAt", { at: String(rn.rolledBackAtHuman) }) : t("ad.run.rolledBack"))
											: null,
										h("span", { className: "smem-ad-sub", key: "x" }, declOpen === rn.runId ? t("ad.action.collapse") : t("ad.action.showDeclaration")),
									]),
									declOpen === rn.runId
										? h("pre", { className: "smem-ad-md", key: "body" }, declBody)
										: null,
								]);
							})),
				]),
				h("div", { className: "smem-autodream-sec", key: "rep" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, t("ad.records.reports")),
						h("span", { className: "smem-status", key: "c" }, t("ad.records.countReports", { count: String(reports.length) })),
					]),
					reports.length === 0
						? h("div", { className: "smem-status", key: "e" }, t("ad.records.reportsEmpty"))
						: h("div", { className: "smem-autodream-list", key: "l" }, reports.slice(0, 12).map(function (r) {
								return h("button", {
									type: "button", key: r.name, className: "smem-report",
									"data-on": open === r.name ? "1" : "0",
									onClick: function () { openReport(open === r.name ? null : r.name); },
								}, [
									h("span", { key: "t" }, String(r.atHuman || "") + " · " + String(r.name) + " · " + fmtSize(r.bytes)),
									r.legacy ? h("span", { className: "smem-ad-badge smem-ad-badge--legacy", key: "lg", style: { marginLeft: "6px" } }, t("ad.snap.legacyBadge")) : null,
									h("span", { className: "smem-ad-sub", key: "x", style: { marginLeft: "6px" } }, open === r.name ? t("ad.action.collapse") : t("ad.action.view")),
								]);
							})),
					open && body ? h("pre", { className: "smem-report-pre", key: "body" }, body) : null,
				]),
				]) : null,
				listErr && !err ? h("div", { className: "smem-err", key: "lerr" }, "⚠ " + listErr) : null,
				err ? h("div", { className: "smem-err", key: "err" }, "⚠ " + err) : null,
				notice && !err ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
			]);
		}

