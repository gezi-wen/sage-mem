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
			const remote = props.ctx && props.ctx.get ? props.ctx.get("remote.autodream") : null;
			// 注入设置走 memory 那半边（autodream 只管整理那趟）
			const memRemote = props.ctx && props.ctx.get ? props.ctx.get("remote.memory") : null;
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
			const sAutoSaving = react.useState(false); const autoSaving = sAutoSaving[0], setAutoSaving = sAutoSaving[1];
			const sReservedNew = react.useState(""); const reservedNew = sReservedNew[0], setReservedNew = sReservedNew[1];

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

			react.useEffect(function () {
				if (!remote) { setErr("remote.autodream 不可用 —— 插件的 宿主侧可能没加载成功，看 DSH 启动日志"); return undefined; }
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
				if (typeof fn !== "function") { if (onErr) onErr("宿主侧没有 " + name + " 接口（版本较旧？）"); return; }
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
				{ key: "maxResults", label: "一次注入条数", lo: 1, hi: 30, unit: "条" },
				{ key: "maxChars", label: "单条字符上限", lo: 200, hi: 20000, unit: "字符" },
				{ key: "maxBaseline", label: "baseline 名额", lo: 1, hi: 50, unit: "条" },
				{ key: "maxSessionBytes", label: "单会话字节预算", lo: 4096, hi: 524288, unit: "字节" },
				{ key: "staleDays", label: "新鲜度门槛", lo: 0, hi: 365, unit: "天" },
			];

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

			/**
			 * 自动归档三档：保存后**回读校验**。
			 *
			 * `setConfig` 对非法值沿用的是「忽略、保留原值」的语义（没有 `{ok:false}` 通道），
			 * 所以不能只看它返回的 config —— 必须再 `getConfig()` 一次，确认那个值真的落在
			 * 配置里。没变就报错：**不能让用户点了保存以为成了、实际什么都没发生**。
			 */
			function saveAutoArchive(v) {
				setErr(null); setNotice(""); setAutoSaving(true);
				callRemote("setConfig", [{ autoArchive: v }], function (d) {
					if (d && d.config && d.config.autoArchive === v) {
						setCfg(d.config);
						setAutoSaving(false);
						setNotice("自动归档已设为「" + AUTO_ARCHIVE_LABEL[v] + "」");
						return;
					}
					// 返回的 config 里没看到新值 → 回读一次再定论
					callRemote("getConfig", [], function (d2) {
						const next = d2 && d2.config ? d2.config : null;
						setAutoSaving(false);
						if (next) setCfg(next);
						const got = next ? autoArchiveOf(next.autoArchive) : null;
						if (got === v) { setNotice("自动归档已设为「" + AUTO_ARCHIVE_LABEL[v] + "」"); return; }
						setErr("保存没生效：配置里仍是「" + (got ? AUTO_ARCHIVE_LABEL[got] : "读不出来") +
							"」。setConfig 对非法值会忽略并保留原值 —— 请重试，或看 DSH 启动日志。");
					}, function (m) { setAutoSaving(false); setErr("保存后回读失败：" + m); });
				}, function (m) { setAutoSaving(false); setErr(m); });
			}

			/** 保存 5 项上限。越界/非整数**本地先拦**（host 也是直接拒绝），别让它白跑一趟。 */
			function saveLimits() {
				if (!memRemote || typeof memRemote.setSettings !== "function") { setErr("宿主侧还没有 setSettings 接口（插件版本较旧）"); return; }
				const draft = limitsDraft || {};
				const limits = {};
				const bad = [];
				for (const f of LIMIT_FIELDS) {
					const raw = String(draft[f.key] == null ? "" : draft[f.key]).trim();
					const n = Number(raw);
					if (raw === "" || !Number.isFinite(n) || !Number.isInteger(n)) { bad.push(f.label + "要整数"); continue; }
					if (n < f.lo || n > f.hi) { bad.push(f.label + " 要在 " + f.lo + "–" + f.hi + " 之间"); continue; }
					limits[f.key] = n;
				}
				if (bad.length) { setErr("没保存 —— " + bad.join("；")); return; }
				setSaveBusy(true); setErr(null); setNotice("");
				Promise.resolve(memRemote.setSettings({ limits: limits })).then(function (out) {
					setSaveBusy(false);
					// setSettings 是 {ok:true, settings, restartRequired} 形状：不要过 unwrap
					// （unwrap 只认 {ok, value}，这里会把 settings 吃掉）。
					if (out && out.ok === false) { setErr(out.error || "保存被拒绝"); return; }
					if (out && out.settings) { setMemSet(out.settings); setLimitsDraft(limitsDraftOf(out.settings.pendingLimits)); }
					else loadMemSettings();
					setNotice("已保存 —— 需重启 DSH 才生效");
				}, function (e) { setSaveBusy(false); setErr(detail(e)); });
			}

			/**
			 * 保存保留名名单（用户声明的那部分）。
			 *
			 * 两个内置名（memory.md / session-log.md）**不在**这份名单里，也不在界面上给删除入口 ——
			 * 那是生效清单里固定的两个，删不掉。这里管的只是用户自己加的那些。
			 */
			function saveReserved(list) {
				if (!memRemote || typeof memRemote.setSettings !== "function") { setErr("宿主侧还没有 setSettings 接口（插件版本较旧）"); return; }
				setSaveBusy(true); setErr(null); setNotice("");
				Promise.resolve(memRemote.setSettings({ reserved: list })).then(function (out) {
					setSaveBusy(false);
					if (out && out.ok === false) { setErr(out.error || "名单被拒绝"); return; }
					if (out && out.settings) setMemSet(out.settings);
					else loadMemSettings();
					setNotice("保留名名单已保存 —— 需重启 DSH 才生效");
				}, function (e) { setSaveBusy(false); setErr(detail(e)); });
			}

			function addReserved() {
				const name = String(reservedNew || "").trim();
				const extra = Array.isArray(memSet && memSet.reservedExtra) ? memSet.reservedExtra : [];
				if (!name) { setErr("先写一个文件名，例如 project_notes.md"); return; }
				// 与 host 的校验同一套：单个 .md 文件名、不许带路径
				if (!name.endsWith(".md") || name.includes("/") || name.includes("\\") || name.startsWith("..")) {
					setErr("保留名要是一个 .md 文件名（不能带路径）：" + name);
					return;
				}
				if (extra.some(function (x) { return String(x).toLowerCase() === name.toLowerCase(); })) {
					setErr("名单里已经有 " + name + " 了");
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
					setModels({ catalogAvailable: false, routes: [], note: "模型目录不可用（" + m + "）—— 请在下面手填 provider 与 model。" });
				});
			}

			function run() {
				setErr(null); setNotice(""); setBusy(true);
				// 契约：runNow({ reason })。reason 只落进 manifest 给人看；门控的豁免
				// 由 宿主侧负责（手动点了按钮就不该被「还没到 N 小时」挡回来）。
				callRemote("runNow", [{ reason: "设置页手动触发" }], function (d) {
					if (d && d.ok === false) setErr(d.error || "启动失败");
					else { setNotice("已开始整理 —— 进度每 2 秒刷新一次"); refreshLists(); }
					setBusy(false);
				}, function (m) { setErr(m); setBusy(false); });
			}

			function openReport(name) {
				if (name === null) { setOpen(null); setBody(""); return; }
				setOpen(name); setBody("载入中…");
				callRemote("readReport", [name], function (d) {
					setBody((d && d.content) || "(空)");
				}, function (m) { setBody("读取失败：" + m); });
			}

			/** 整理声明：点开才拉，拉回来的是 Markdown 原文，直接用 pre 呈现。 */
			function openDecl(runId) {
				if (declOpen === runId) { setDeclOpen(null); setDeclBody(""); return; }
				setDeclOpen(runId); setDeclBody("载入中…");
				callRemote("readDeclaration", [{ runId: runId }], function (d) {
					setDeclBody((d && d.markdown) || "(这一趟没有留下声明正文)");
				}, function (m) { setDeclBody("读取失败：" + m); });
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
						setRbMsg({ bad: true, text: "回滚失败：" + (x.error || "未知原因") });
					} else {
						setRbMsg({ bad: false, text: "已回滚到 " + String(sp.atHuman || "") + "：恢复 " +
							(x.restored == null ? "?" : x.restored) + " 个文件，移走 " + (x.parked == null ? "?" : x.parked) + " 个" +
							// skipped = 想动但没动的（archive/ 已有同名、或回滚点里没那一版）。
							// 不显示它等于「部分成功」被说成「成功」——回滚这种事不能含糊。
							(x.skipped ? "，跳过 " + x.skipped + " 个（详见回滚报告）" : "") +
							(x.protection ? " · 保护快照 " + x.protection : "") + (x.report ? " · 报告 " + x.report : "") });
						setConfirmSnap(null);
					}
					setRbBusy(null);
					refreshLists();
				}, function (m) { setRbMsg({ bad: true, text: "回滚失败：" + m }); setRbBusy(null); });
			}

			// 实际生效路线（契约：route 可能为 null；source==='none' 时 error 里是原因）。
			const routeBad = !route || route.source === "none" || !route.provider || !route.model;
			const routeInfo = routeBad
				? ("实际生效路线：拿不到 —— " + ((route && route.error) || "宿主没能解析出 provider / model（配置留空且取不到会话默认模型）"))
				: ("实际生效路线：" + route.provider + " / " + route.model + (route.fromDefault ? "（跟随默认）" : "（配置指定）"));

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
					subtab("run", "运行"),
					subtab("settings", "设置"),
					subtab("records", "记录", String(snaps.length + runs.length + reports.length)),
				]),
				segOf === "run" ? h("div", { className: "smem-seg", key: "seg-run" }, [
				h("div", { className: "smem-autodream-sec", key: "top" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("button", {
							type: "button", key: "sw", className: "smem-switch",
							"data-on": c.enabled ? "1" : "0",
							title: c.enabled ? "点击停用" : "点击启用",
							"aria-label": "启用或停用自动做梦",
							onClick: function () { patch({ enabled: !c.enabled }); },
						}),
						h("span", { key: "t", style: { fontWeight: "600" } }, "自动做梦"),
						h("span", { className: "smem-status", key: "s" },
							running ? ("运行中 · " + String((st && st.phase) || "准备中")) : (c.enabled ? "已启用 · 空闲" : "未启用")),
					]),
					h("div", { className: "smem-autodream-note", key: "n" },
						"把记忆目录通读一遍：合并重复的、删掉被推翻的、修索引与断链、把相对日期换成绝对日期。"),
				]),
				h("div", { className: "smem-autodream-sec", key: "mode" }, [
					h("div", { className: "smem-autodream-row", key: "a" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "触发"),
						h(Seg, {
							key: "v", value: c.trigger,
							options: [{ value: "manual", label: "只手动" }, { value: "auto", label: "满足条件自动跑" }],
							onChange: function (v) { patch({ trigger: v }); },
						}),
					]),
					h("div", { className: "smem-autodream-row", key: "b" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "改动方式"),
						h(Seg, {
							key: "v", value: c.apply ? "apply" : "report",
							options: [{ value: "report", label: "只出报告" }, { value: "apply", label: "直接改写（先快照）" }],
							onChange: function (v) { patch({ apply: v === "apply" }); },
						}),
					]),
					h("div", { className: "smem-autodream-row", key: "c" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "输入源"),
						h(Seg, {
							key: "v", value: c.source,
							options: [{ value: "memory", label: "仅记忆目录" }, { value: "memory+sessions", label: "记忆 + 会话记录" }],
							onChange: function (v) { patch({ source: v }); },
						}),
					]),
					h("div", { className: "smem-autodream-note", key: "w" },
						c.source === "memory+sessions"
							? "会解压会话记录做定向搜索 —— 私密对话会进入模型上下文，token 成本也更高。"
							: "只看记忆文件本身，不碰会话记录。"),
					h("div", { className: "smem-autodream-note", key: "w2" },
						c.apply
							? "改写前会自动把整个记忆目录快照一份（memory 上一层 .sage-mem/autodream/snapshots/），改坏可回退。"
							: "只读模式：这一趟连写工具都不会挂给模型，所以它不可能改到任何文件。"),
				]),
				h("div", { className: "smem-autodream-sec", key: "model" }, [
					h("div", { className: "smem-autodream-row", key: "model" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "模型"),
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
										"跟随当前会话默认模型" + ((models.defaultRoute && models.defaultRoute.provider && models.defaultRoute.model)
											? ("（" + String(models.defaultRoute.provider) + " / " + String(models.defaultRoute.model) + "）")
											: ""),
									)].concat(
										modelValueInCatalog ? [] : [h("option", { key: "__cur", value: modelValue }, String(c.provider) + " / " + String(c.model) + "（配置里指定，不在目录中）")],
										modelRoutes.map(function (r) {
											return h("option", { key: String(r.provider) + "/" + String(r.model), value: encodeRoute(r.provider, r.model) },
												r.label || (String(r.provider) + " / " + String(r.model)));
										}),
									))
							: models
								? [
										h("input", { className: "smem-input", key: "p", style: { flex: "1", minWidth: "110px" }, value: prov, placeholder: "provider（留空=跟随默认）", onChange: function (e) { setProv(e.target.value); } }),
										h("input", { className: "smem-input", key: "m", style: { flex: "1", minWidth: "110px" }, value: model, placeholder: "model（留空=跟随默认）", onChange: function (e) { setModel(e.target.value); } }),
										h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "ok", onClick: function () { patch({ provider: prov, model: model }); setNotice("模型已保存"); } }, "保存"),
									]
								: [
										h("span", { className: "smem-status", key: "load" }, "模型目录载入中…"),
										h("button", { type: "button", className: "smem-btn", key: "man", onClick: function () { setModels({ catalogAvailable: false, routes: [], note: "" }); } }, "手填"),
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
						}, running ? "正在整理…" : "立即整理"),
						h("span", { className: "smem-status", key: "s" },
							running
								? ("已跑 " + ((st && st.steps && st.steps.length) || 0) + " 轮 · " + String((st && st.phase) || ""))
								: (st && st.hoursSince != null ? ("距上次整理 " + st.hoursSince.toFixed(1) + " 小时") : "从未整理过")),
					]),
					running && st && st.steps && st.steps.length
						? h("div", { className: "smem-autodream-note", key: "prog" }, st.steps.map(function (x) {
								return "第 " + x.step + " 轮：" + (x.tools.length ? x.tools.join("、") : "结束");
							}).join("　·　"))
						: null,
					last
						? h("div", { className: "smem-status", key: "last" },
								"上次 " + String(last.atHuman || "") + " · " + (last.ok
									? ("成功" + (last.apply ? "，改写了 " + ((last.touched || []).length) + " 个文件" : "（只出报告）") +
										" · 结构问题 " + last.problemsBefore + " → " + last.problemsAfter +
										" · token " + last.tokensIn + " / " + last.tokensOut)
									: ("失败：" + (last.error || "未知"))) +
								(last.report ? " · 报告 " + last.report : ""))
						: null,
				]),
				]) : null,
				segOf === "settings" ? h("div", { className: "smem-seg", key: "seg-set" }, [
				h("div", { className: "smem-autodream-sec", key: "autoarchive" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "自动归档"),
						h(Seg, {
							key: "v", value: autoArchiveOf(c.autoArchive),
							options: [
								{ value: "off", label: AUTO_ARCHIVE_LABEL.off },
								{ value: "report", label: AUTO_ARCHIVE_LABEL.report },
								{ value: "auto", label: AUTO_ARCHIVE_LABEL.auto },
							],
							// 点一档就存一档，但**存完要回读**：setConfig 对非法值是静默忽略，
							// 只信返回值不够（见 saveAutoArchive 的注释）。
							onChange: function (v) { if (v !== autoArchiveOf(c.autoArchive)) saveAutoArchive(v); },
						}),
						autoSaving ? h("span", { className: "smem-status", key: "s" }, "保存中…") : null,
					]),
					h("div", { className: "smem-autodream-note", key: "cost" }, AUTO_ARCHIVE_COST[autoArchiveOf(c.autoArchive)]),
					autoArchiveOf(c.autoArchive) === "auto" && !c.apply
						? h("div", { className: "smem-autodream-note smem-ad-warn", key: "deg" },
								"注意：现在「改动方式」是只出报告 —— 这一档会自动降级成只出报告，不会动文件。")
						: null,
				]),
				h("div", { className: "smem-autodream-sec", key: "limits" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "记忆注入参数"),
						memSet && memSet.restartRequired
							? h("span", { className: "smem-ad-badge smem-ad-badge--warn", key: "w" }, "有改动待生效")
							: null,
					]),
					memSet && memSet.restartRequired
						? h("div", { className: "smem-autodream-note smem-ad-warn", key: "rw" },
								"⚠ 这些值在 DSH 启动时就固化了 —— 要重启 DSH 才生效。下面每行都写清「当前 → 重启后」。")
						: h("div", { className: "smem-autodream-note", key: "rn" },
								"这些值在 DSH 启动时固化：保存后要重启 DSH 才生效 —— 所以每行都会标出「当前生效」与「重启后」。"),
					// 五个参数排两列（一行两个）：同样的信息，行数少一半，扫读反而更清楚。
					h("div", { className: "smem-ad-grid2", key: "grid" }, LIMIT_FIELDS.map(function (f) {
						const cur = memSet && memSet.limits ? memSet.limits[f.key] : null;
						const pend = memSet && memSet.pendingLimits ? memSet.pendingLimits[f.key] : null;
						const diff = cur != null && pend != null && cur !== pend;
						return h("div", { className: "smem-ad-field", key: f.key }, [
							h("span", { className: "smem-autodream-key", key: "k", title: f.unit + " · 范围 " + f.lo + "–" + f.hi }, f.label),
							h("input", {
								className: "smem-num", key: "v", type: "number",
								min: String(f.lo), max: String(f.hi),
								title: "范围 " + f.lo + "–" + f.hi + " " + f.unit,
								value: limitsDraft && limitsDraft[f.key] != null ? limitsDraft[f.key] : "",
								onChange: function (e) {
									const nx = Object.assign({}, limitsDraft);
									nx[f.key] = e.target.value;
									setLimitsDraft(nx);
								},
							}),
							diff
								? h("span", { className: "smem-ad-badge smem-ad-badge--warn", key: "d" }, "当前 " + String(cur) + " → 重启后 " + String(pend))
								: h("span", { className: "smem-status", key: "d" }, "范围 " + f.lo + "–" + f.hi + (cur == null ? "" : (" · 当前生效 " + String(cur)))),
						]);
					})),
					h("div", { className: "smem-autodream-row", key: "save" }, [
						h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "s", disabled: saveBusy, onClick: saveLimits }, saveBusy ? "保存中…" : "保存注入参数"),
						h("span", { className: "smem-status", key: "n" }, "保存后需重启 DSH 才生效"),
					]),
				]),
				h("div", { className: "smem-autodream-sec", key: "reserved" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "保留名保护名单"),
						h("span", { className: "smem-status", key: "c" }, "名单里的文件不参与注入"),
					]),
					h("div", { className: "smem-autodream-note", key: "n" },
						"内置的两个固定不可删；下面可以再加自己的（只写文件名，不要带路径）。改完需重启 DSH 才生效。"),
					h("div", { className: "smem-raw-names", key: "fixed" }, fixedReserved.map(function (n) {
						return h("span", { className: "smem-chip smem-chip--fixed", key: n, title: "内置固定，不可删除" }, n + " · 固定");
					})),
					h("div", { className: "smem-raw-names", key: "extra" },
						extraReserved.length
							? extraReserved.map(function (n) {
									return h("span", { className: "smem-chip", key: n, "data-on": "1" }, [
										n,
										h("button", { type: "button", className: "smem-chip-x", key: "x", title: "从名单里移除 " + n, onClick: function () { removeReserved(n); } }, "✕"),
									]);
								})
							: h("span", { className: "smem-status", key: "none" }, "（还没有自己加的保留名）")),
					h("div", { className: "smem-autodream-row", key: "add" }, [
						h("input", {
							className: "smem-input", key: "i",
							style: { flex: "1", minWidth: "150px" },
							value: reservedNew,
							placeholder: "例如 project_notes.md（要 .md 文件名）",
							onChange: function (e) { setReservedNew(e.target.value); },
						}),
						h("button", { type: "button", className: "smem-btn", key: "a", disabled: saveBusy, onClick: addReserved }, "加入名单"),
					]),
				]),
				h("details", { className: "smem-autodream-adv", key: "adv", open: true }, [
					h("summary", { key: "s" }, "高级设置"),
					h("div", { key: "d" }, [
						c.trigger === "auto" ? h("div", { className: "smem-autodream-row", key: "gate" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, "自动触发"),
							h("span", { className: "smem-status", key: "a" }, "距上次 ≥"),
							h("input", { className: "smem-num", key: "h", type: "number", min: "1", max: "720", value: c.minHours, onChange: function (e) { patch({ minHours: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "b" }, "小时，且期间 ≥"),
							h("input", { className: "smem-num", key: "m", type: "number", min: "1", max: "200", value: c.minSessions, onChange: function (e) { patch({ minSessions: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "c" }, "个会话有更新"),
						]) : null,
						h("div", { className: "smem-autodream-row", key: "steps" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, "最多轮数"),
							h("input", { className: "smem-num", key: "v", type: "number", min: "1", max: "80", value: c.maxSteps, onChange: function (e) { patch({ maxSteps: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "s" }, "一轮 = 一次模型调用 + 它要的工具调用"),
						]),
						h("div", { className: "smem-autodream-row", key: "keep" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, "保留快照"),
							h("input", { className: "smem-num", key: "v", type: "number", min: "1", max: "50", value: c.maxSnapshotKeep, onChange: function (e) { patch({ maxSnapshotKeep: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "s" }, "份"),
						]),
						h("div", { className: "smem-status", key: "paths" }, "配置与状态：" + ((st && st.paths && st.paths.configPath) || "—")),
					]),
				]),
				]) : null,
				// ── 回滚点（新）──────────────────────────────────────────────
				// 只改这一个文件、只用既有 h() 写法；数据全走 remote.autodream。
				segOf === "records" ? h("div", { className: "smem-seg", key: "seg-rec" }, [
				h("div", { className: "smem-autodream-sec", key: "snap" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "回滚点"),
						h("span", { className: "smem-status", key: "c" }, String(snaps.length) + " 个"),
						h("button", { type: "button", className: "smem-btn", key: "rf", onClick: refreshLists }, "刷新"),
					]),
					h("div", { className: "smem-autodream-row", key: "scope" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "回滚范围"),
						h(Seg, {
							key: "v", value: rollbackScope,
							options: [{ value: "files", label: "只恢复本次动过的文件" }, { value: "all", label: "整目录回到该时点" }],
							onChange: function (v) { patch({ rollbackScope: v }); },
						}),
					]),
					h("div", { className: "smem-autodream-note", key: "n" },
						"回滚前会自动把整个记忆目录再存一份保护快照 —— 所以回滚本身也能再退回来。多出来的文件只移进 archive/，不删除。"),
					snaps.length === 0
						? h("div", { className: "smem-status", key: "e" }, "还没有回滚点 —— 用「直接改写」跑过一次就有了。")
						: h("div", { className: "smem-autodream-list", key: "l" }, snaps.slice(0, 15).map(function (sp) {
								const label = sp.legacy ? "旧版快照" : (sp.runId ? ("运行 " + String(sp.runId)) : "回滚保护");
								return h("div", { className: "smem-ad-wrap", key: String(sp.name) }, [
									h("div", { className: "smem-ad-snap", key: "row" }, [
										h("div", { className: "smem-ad-main", key: "m" }, [
											h("div", { key: "l1" }, String(sp.atHuman || "") + " · " + (sp.files == null ? "?" : sp.files) + " 个文件"),
											h("div", { className: "smem-ad-sub", key: "l2" }, label + " · " + String(sp.name || "")),
										]),
										sp.legacy ? h("span", { className: "smem-ad-badge smem-ad-badge--legacy", key: "lg" }, "旧版") : null,
										confirmSnap === sp.name
											? null
											: h("button", {
													type: "button", className: "smem-btn", key: "go",
													disabled: rbBusy !== null,
													onClick: function () { setRbMsg(null); setConfirmSnap(sp.name); },
												}, "回滚"),
									]),
									confirmSnap === sp.name
										? h("div", { className: "smem-ad-confirm", key: "cf" }, [
												h("div", { key: "t", style: { fontWeight: "600" } }, "确认回滚到 " + String(sp.atHuman || "") + "？"),
												h("div", { key: "d" }, "范围：" + (rollbackScope === "all"
													? "整目录回到该时点 —— 快照里没有、当前目录里有的文件会被移进 archive/（不删除）"
													: "只恢复这次运行动过的文件 —— 该次新建的移进 archive/，该次归档的移回顶层") +
													"。回滚前会先存一份保护快照，所以这一步本身也能退。"),
												h("div", { className: "smem-autodream-row", key: "acts" }, [
													h("button", {
														type: "button", className: "smem-btn smem-btn-danger", key: "yes",
														disabled: rbBusy === sp.name,
														onClick: function () { doRollback(sp); },
													}, rbBusy === sp.name ? "回滚中…" : "确认回滚"),
													h("button", { type: "button", className: "smem-btn", key: "no", onClick: function () { setConfirmSnap(null); } }, "取消"),
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
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "整理记录"),
						h("span", { className: "smem-status", key: "c" }, String(runs.length) + " 条"),
						h("button", { type: "button", className: "smem-btn", key: "rf", onClick: refreshLists }, "刷新"),
					]),
					h("div", { className: "smem-autodream-note", key: "n" },
						"每一趟都留一份整理声明：改了什么、为什么改、哪些想法被拒了。点一条看全文。"),
					runs.length === 0
						? h("div", { className: "smem-status", key: "e" }, "还没有整理记录 —— 跑一次就有了。")
						: h("div", { className: "smem-autodream-list", key: "l" }, runs.slice(0, 15).map(function (rn) {
								return h("div", { className: "smem-ad-wrap", key: String(rn.runId) }, [
									h("button", {
										type: "button", className: "smem-ad-run",
										"data-on": declOpen === rn.runId ? "1" : "0",
										onClick: function () { openDecl(rn.runId); },
									}, [
										h("span", { key: "t" }, String(rn.atHuman || "")),
										h("span", { className: "smem-ad-badge", key: "m" }, rn.mode === "apply" ? "直接改写" : "只出报告"),
										h("span", { key: "c" }, "改 " + (rn.changeCount == null ? "?" : rn.changeCount) + " 条"),
										rn.report ? h("span", { className: "smem-ad-sub", key: "r" }, "报告 " + String(rn.report)) : null,
										rn.rolledBackAt
											? h("span", { className: "smem-ad-badge smem-ad-badge--warn", key: "rb" },
													"已回滚" + (rn.rolledBackAtHuman ? (" · " + String(rn.rolledBackAtHuman)) : ""))
											: null,
										h("span", { className: "smem-ad-sub", key: "x" }, declOpen === rn.runId ? "收起" : "看声明"),
									]),
									declOpen === rn.runId
										? h("pre", { className: "smem-ad-md", key: "body" }, declBody)
										: null,
								]);
							})),
				]),
				h("div", { className: "smem-autodream-sec", key: "rep" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "历史报告"),
						h("span", { className: "smem-status", key: "c" }, String(reports.length) + " 份"),
					]),
					reports.length === 0
						? h("div", { className: "smem-status", key: "e" }, "还没有报告 —— 跑一次就有了。报告写在 memory/autodream/ 下，不会混进记忆列表。")
						: h("div", { className: "smem-autodream-list", key: "l" }, reports.slice(0, 12).map(function (r) {
								return h("button", {
									type: "button", key: r.name, className: "smem-report",
									"data-on": open === r.name ? "1" : "0",
									onClick: function () { openReport(open === r.name ? null : r.name); },
								}, [
									h("span", { key: "t" }, String(r.atHuman || "") + " · " + String(r.name) + " · " + fmtSize(r.bytes)),
									r.legacy ? h("span", { className: "smem-ad-badge smem-ad-badge--legacy", key: "lg", style: { marginLeft: "6px" } }, "旧版") : null,
									h("span", { className: "smem-ad-sub", key: "x", style: { marginLeft: "6px" } }, open === r.name ? "收起" : "查看"),
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

