/**
 * sage-mem — 客户端半：DSH 设置页「记忆管理」界面。
 *
 * 手写 ModuleLoader bundle（与官方 dsh-client-* 包的构建产物同格式）：
 * window.__ModuleLoader__.load({ id, factory })，factory 内 require('react')
 * 可用，module.exports 导出标准 Cordis 插件（apply/inject）。
 *
 * 数据通道：全部走 host 半注册的同源代理 /sage-mem/api/*（worker 只监听
 * 127.0.0.1:37700 且无 CORS，浏览器无法直连）。
 *
 * 功能：
 *   - 展示系统自动沉淀的跨会话记忆（分页 + 类型徽章 + 展开正文）
 *   - 自定义跨会话记忆 / 偏好记忆（保存走 /api/import，见 host 半注释）
 *   - 编辑（保存新版 + 删除旧版）与两步确认删除
 *   - 筛选（全部/自动/自定义/偏好）与关键词搜索、worker 健康状态
 */
window.__ModuleLoader__.load({
	id: "sage-mem",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");
		const h = react.createElement;

		const API = "/sage-mem/api";
		const PAGE_SIZE = 50;
		const PROJECT = "sage";
		const PREF_PREFIX = "[偏好] ";

		const CSS = [
			".smem-root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);max-width:760px;}",
			".smem-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".smem-title{font-size:15px;font-weight:600;}",
			".smem-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:none;}",
			".smem-dot--bad{background:var(--dsw-alias-state-error-primary,#ef4444);}",
			".smem-muted{color:var(--dsw-alias-label-secondary);font-size:12px;}",
			".smem-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".smem-chips{display:flex;gap:6px;flex-wrap:wrap;}",
			".smem-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 12px;font-size:12px;cursor:pointer;font-family:inherit;}",
			".smem-chip:hover{border-color:var(--dsw-alias-border-l2);}",
			'.smem-chip[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-brand-primary,#4d76e6);}',
			".smem-search{flex:1;min-width:160px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;padding:5px 10px;font-size:12px;outline:none;font-family:inherit;}",
			".smem-search:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;}",
			".smem-btn:hover{border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-btn:disabled{opacity:.5;cursor:default;}",
			".smem-btn-primary{background:var(--dsw-alias-brand-primary,#4d76e6);border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-bg-base,#fff);}",
			".smem-btn-primary:hover{color:var(--dsw-alias-bg-base,#fff);opacity:.88;}",
			".smem-btn-primary:disabled{color:var(--dsw-alias-bg-base,#fff);opacity:.55;}",
			".smem-btn-danger-ghost{color:var(--dsw-alias-state-error-primary,#ef4444);border-color:var(--dsw-alias-border-l2);}",
			".smem-btn-danger{background:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;}",
			".smem-btn-danger:hover{color:#fff;opacity:.9;}",
			".smem-list{display:flex;flex-direction:column;gap:10px;}",
			".smem-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:6px;}",
			".smem-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".smem-card-title{font-weight:600;flex:1;min-width:120px;overflow-wrap:anywhere;text-align:left;}",
			".smem-time{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;}",
			".smem-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px;white-space:nowrap;}",
			".smem-tag{font-size:11px;border-radius:6px;padding:1px 7px;white-space:nowrap;border:1px solid transparent;}",
			".smem-tag--custom{color:var(--dsw-alias-brand-primary,#4d76e6);border-color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-tag--pref{color:var(--dsw-alias-state-warn-primary,#d97706);border-color:var(--dsw-alias-state-warn-primary,#d97706);}",
			".smem-narrative{color:var(--dsw-alias-label-secondary);font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere;}",
			'.smem-narrative[data-clamp="1"]{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;}',
			".smem-facts{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;flex-direction:column;gap:2px;}",
			".smem-card-foot{display:flex;justify-content:flex-end;}",
			".smem-actions{display:flex;gap:6px;}",
			".smem-form{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:8px;}",
			".smem-form-title{font-weight:600;font-size:13px;}",
			".smem-label{font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".smem-input,.smem-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;padding:6px 10px;font-size:13px;outline:none;font-family:inherit;}",
			".smem-input:focus,.smem-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-textarea{resize:vertical;min-height:72px;}",
			".smem-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
			".smem-foot{display:flex;justify-content:center;padding:4px 0;}",
			".smem-err{border:1px solid var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-state-error-primary,#ef4444);border-radius:8px;padding:6px 10px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;}",
			".smem-ok{color:var(--dsw-alias-state-success-primary,#16a34a);font-size:12px;}",
			".smem-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:22px 14px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;}",
		].join("\n");

		// 类型徽章与 worker 注入图例保持一致（code--zh 模式）
		const TYPE_META = {
			session: ["🎯", "会话"],
			bugfix: ["●", "修复"],
			feature: ["◆", "功能"],
			refactor: ["↻", "重构"],
			change: ["✓", "变更"],
			discovery: ["○", "发现"],
			decision: ["⚖", "决策"],
			security_alert: ["⚠", "安全警报"],
			security_note: ["⚷", "安全备注"],
			sensitive: ["⊘", "敏感"],
			lesson: ["💡", "教训"],
		};
		const CAT_LABEL = { auto: "自动记录", custom: "自定义", pref: "偏好" };
		const FILTERS = [
			["all", "全部"],
			["auto", "自动记录"],
			["custom", "自定义记忆"],
			["pref", "偏好记忆"],
		];

		function parseList(v) {
			if (Array.isArray(v)) return v;
			if (typeof v !== "string" || !v) return [];
			try {
				const p = JSON.parse(v);
				return Array.isArray(p) ? p : [];
			} catch {
				return [];
			}
		}

		function fmtTime(iso) {
			try {
				return new Date(iso).toLocaleString("zh-CN", { hour12: false });
			} catch {
				return String(iso || "");
			}
		}

		// 分类约定：worker 手动记忆固定 subtitle === 'Manual memory'（列表 API
		// 不返回 metadata，这是唯一可靠通道）；偏好再以标题前缀 [偏好] 区分。
		function categoryOf(item) {
			if (item && item.subtitle === "Manual memory") {
				return typeof item.title === "string" && item.title.indexOf(PREF_PREFIX) === 0 ? "pref" : "custom";
			}
			return "auto";
		}

		function displayTitle(item) {
			const t = (item && item.title) || "";
			return categoryOf(item) === "pref" && t.indexOf(PREF_PREFIX) === 0 ? t.slice(PREF_PREFIX.length) : t;
		}

		/** 同源代理请求：非 2xx 抛错，JSON 自动解析。 */
		async function api(path, init) {
			const res = await fetch(API + path, init);
			const text = await res.text();
			let data = null;
			try {
				data = text ? JSON.parse(text) : null;
			} catch {
				data = null;
			}
			if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
			return data;
		}

		/**
		 * 保存手动记忆。走 /api/import 而非 /api/memory/save，并生成
		 * 「自包含标题」—— 两个实测结论（详见 host 半 lib/index.js 注释）：
		 *   1. /api/memory/save 写死 concepts=[]，会被 worker 上下文生成的
		 *      concepts 白名单过滤，记忆对所有新会话永久不可见；
		 *   2. 注入时间线只携带标题（CLAUDE_MEM_CONTEXT_FULL_COUNT 默认 0），
		 *      事实必须写进标题才能被新会话直接看到。
		 */
		async function saveManualMemory(title, text, isPref) {
			let combined;
			if (!title) combined = text;
			else if (text.indexOf(title) >= 0 || title.indexOf(text.slice(0, 10)) >= 0) combined = text;
			else combined = title + "：" + text;
			let finalTitle = combined.length > 55 ? combined.slice(0, 54) + "…" : combined;
			if (isPref) finalTitle = PREF_PREFIX + finalTitle;
			const now = new Date();
			const iso = now.toISOString();
			const epoch = now.getTime();
			const payload = {
				sessions: [{
					content_session_id: "manual-content-" + PROJECT,
					memory_session_id: "manual-" + PROJECT,
					project: PROJECT,
					platform_source: "claude",
					user_prompt: "Manual memory",
					started_at: iso,
					started_at_epoch: epoch,
					completed_at: null,
					completed_at_epoch: null,
					status: "active",
				}],
				observations: [{
					memory_session_id: "manual-" + PROJECT,
					project: PROJECT,
					text: null,
					type: "discovery",
					title: finalTitle,
					subtitle: "Manual memory",
					facts: JSON.stringify([text]),
					narrative: text,
					concepts: '["why-it-exists"]',
					files_read: "[]",
					files_modified: "[]",
					prompt_number: 0,
					discovery_tokens: 0,
					created_at: iso,
					created_at_epoch: epoch,
				}],
			};
			const res = await api("/import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const imported = Number(res?.stats?.observationsImported) || 0;
			if (imported < 1) throw new Error("保存失败：worker 未导入任何记忆");
			return finalTitle;
		}

		function Chip(props) {
			return h("button", {
				type: "button",
				className: "smem-chip",
				"data-on": props.on ? "1" : "0",
				onClick: props.onClick,
			}, props.label + (props.count !== undefined ? " · " + props.count : ""));
		}

		function Card(props) {
			const item = props.item;
			const cat = categoryOf(item);
			const meta = TYPE_META[item.type] || TYPE_META.discovery;
			const facts = parseList(item.facts);
			const body = item.narrative || item.text || "";
			const isOpen = !!props.expanded;
			return h("div", { className: "smem-card", key: item.id }, [
				h("div", { className: "smem-card-head", key: "head" }, [
					h("span", { className: "smem-badge", key: "badge", title: "类型 " + String(item.type) }, meta[0] + " " + meta[1]),
					cat !== "auto" ? h("span", { className: "smem-tag smem-tag--" + cat, key: "tag" }, CAT_LABEL[cat]) : null,
					h("span", { className: "smem-card-title", key: "title" }, displayTitle(item) || "（无标题）"),
					h("span", { className: "smem-time", key: "time" }, "#" + String(item.id) + " · " + fmtTime(item.created_at)),
				]),
				item.subtitle && item.subtitle !== "Manual memory"
					? h("div", { className: "smem-muted", key: "sub" }, String(item.subtitle))
					: null,
				body
					? h("div", {
							className: "smem-narrative",
							"data-clamp": isOpen ? "0" : "1",
							key: "body",
							onClick: function () { props.onToggle(item.id); },
							title: isOpen ? "点击收起" : "点击展开全文",
						}, String(body))
					: null,
				facts.length
					? h("ul", { className: "smem-facts", key: "facts" },
							facts.map(function (f, i) { return h("li", { key: String(i) }, String(f)); }))
					: null,
				h("div", { className: "smem-card-foot", key: "foot" },
					h("div", { className: "smem-actions", key: "acts" },
						props.deleting
							? [
									h("button", { type: "button", className: "smem-btn smem-btn-danger", key: "yes", onClick: function () { props.onConfirmDelete(item.id); } }, "确认删除"),
									h("button", { type: "button", className: "smem-btn", key: "no", onClick: function () { props.onCancelDelete(); } }, "取消"),
								]
							: [
									h("button", { type: "button", className: "smem-btn", key: "edit", onClick: function () { props.onEdit(item); } }, "编辑"),
									h("button", { type: "button", className: "smem-btn smem-btn-danger-ghost", key: "del", onClick: function () { props.onAskDelete(item.id); } }, "删除"),
								])),
			]);
		}

		function Section() {
			const sItems = react.useState([]);
			const items = sItems[0], setItems = sItems[1];
			const sOffset = react.useState(0);
			const offset = sOffset[0], setOffset = sOffset[1];
			const sHasMore = react.useState(false);
			const hasMore = sHasMore[0], setHasMore = sHasMore[1];
			const sLoading = react.useState(false);
			const loading = sLoading[0], setLoading = sLoading[1];
			const sError = react.useState(null);
			const error = sError[0], setError = sError[1];
			const sNotice = react.useState("");
			const notice = sNotice[0], setNotice = sNotice[1];
			const sFilter = react.useState("all");
			const filter = sFilter[0], setFilter = sFilter[1];
			const sQuery = react.useState("");
			const query = sQuery[0], setQuery = sQuery[1];
			const sExpanded = react.useState({});
			const expanded = sExpanded[0], setExpanded = sExpanded[1];
			const sDeleting = react.useState(null);
			const deleting = sDeleting[0], setDeleting = sDeleting[1];
			const sFormOpen = react.useState(false);
			const formOpen = sFormOpen[0], setFormOpen = sFormOpen[1];
			const sEditingId = react.useState(null);
			const editingId = sEditingId[0], setEditingId = sEditingId[1];
			const sFormTitle = react.useState("");
			const formTitle = sFormTitle[0], setFormTitle = sFormTitle[1];
			const sFormText = react.useState("");
			const formText = sFormText[0], setFormText = sFormText[1];
			const sFormCat = react.useState("custom");
			const formCat = sFormCat[0], setFormCat = sFormCat[1];
			const sBusy = react.useState(false);
			const busy = sBusy[0], setBusy = sBusy[1];
			const sOk = react.useState(null);
			const workerOk = sOk[0], setWorkerOk = sOk[1];

			function load(reset) {
				setLoading(true);
				setError(null);
				const off = reset ? 0 : offset;
				api(`/observations?project=${PROJECT}&offset=${off}&limit=${PAGE_SIZE}`)
					.then(function (res) {
						const incoming = res && Array.isArray(res.items) ? res.items : [];
						setItems(reset ? incoming : items.concat(incoming));
						setOffset(off + incoming.length);
						setHasMore(!!(res && res.hasMore));
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setLoading(false); });
			}

			react.useEffect(function () {
				api("/health").then(function () { setWorkerOk(true); }, function () { setWorkerOk(false); });
				load(true);
			}, []);

			function closeForm() {
				setFormOpen(false); setEditingId(null); setFormTitle(""); setFormText(""); setFormCat("custom");
			}

			function openForm(item) {
				setError(null);
				if (item) {
					setEditingId(item.id);
					setFormTitle(displayTitle(item));
					setFormText(item.narrative || item.text || parseList(item.facts).join("\n"));
					const c = categoryOf(item);
					setFormCat(c === "auto" ? "custom" : c);
					setFormOpen(true);
				} else {
					setEditingId(null); setFormTitle(""); setFormText(""); setFormCat("custom"); setFormOpen(true);
				}
			}

			// 编辑语义：worker 无原地更新 API，保存新版 + 删除旧版
			function submit() {
				const text = formText.trim();
				if (!text) { setError("内容不能为空"); return; }
				setBusy(true); setError(null); setNotice("");
				const wasEditing = editingId;
				saveManualMemory(formTitle.trim(), text, formCat === "pref")
					.then(function () {
						if (wasEditing !== null) {
							return api("/observation/" + wasEditing, { method: "DELETE" });
						}
						return null;
					})
					.then(function () {
						closeForm();
						setNotice(wasEditing !== null ? "已更新记忆" : "已保存记忆（新会话即可检索）");
						load(true);
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			function confirmDelete(id) {
				setBusy(true); setError(null); setNotice("");
				api("/observation/" + id, { method: "DELETE" })
					.then(function () {
						setDeleting(null);
						setNotice("已删除记忆 #" + String(id));
						load(true);
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			const counts = { all: items.length, auto: 0, custom: 0, pref: 0 };
			items.forEach(function (it) { counts[categoryOf(it)] += 1; });

			const q = query.trim().toLowerCase();
			const filtered = items.filter(function (it) {
				if (filter !== "all" && categoryOf(it) !== filter) return false;
				if (!q) return true;
				const hay = ((it.title || "") + "\n" + (it.subtitle || "") + "\n" + (it.narrative || "") + "\n" + (it.text || "") + "\n" + String(it.facts || "")).toLowerCase();
				return hay.indexOf(q) >= 0;
			});

			const editingItem = editingId !== null ? items.filter(function (it) { return it.id === editingId; })[0] : undefined;

			return h("div", { className: "smem-root" }, [
				h("div", { className: "smem-head", key: "head" }, [
					h("span", { className: "smem-title", key: "t" }, "跨会话记忆（sage-mem）"),
					h("span", { className: "smem-dot" + (workerOk ? "" : " smem-dot--bad"), key: "dot", title: workerOk ? "记忆 worker 在线" : "记忆 worker 不可用" }),
					h("span", { className: "smem-muted", key: "st" }, workerOk ? "worker 在线" : "worker 不可用"),
					h("span", { className: "smem-badge", key: "pj" }, "项目 " + PROJECT),
				]),
				h("div", { className: "smem-toolbar", key: "bar" }, [
					h("div", { className: "smem-chips", key: "chips" }, FILTERS.map(function (f) {
						return h(Chip, { key: f[0], label: f[1], on: filter === f[0], count: counts[f[0]], onClick: function () { setFilter(f[0]); } });
					})),
					h("input", { className: "smem-search", key: "q", value: query, placeholder: "搜索标题 / 内容 / 事实…", onChange: function (e) { setQuery(e.target.value); } }),
					h("button", { type: "button", className: "smem-btn", key: "refresh", disabled: busy || loading, onClick: function () { load(true); } }, "刷新"),
					h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "add", onClick: function () { openForm(null); } }, "+ 添加记忆"),
				]),
				error ? h("div", { className: "smem-err", key: "err" }, "⚠ " + error) : null,
				notice && !error ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
				formOpen
					? h("div", { className: "smem-form", key: "form" }, [
							h("div", { className: "smem-form-title", key: "ft" }, editingId !== null ? "编辑记忆 #" + String(editingId) : "添加记忆"),
							editingItem && categoryOf(editingItem) === "auto"
								? h("div", { className: "smem-muted", key: "warn" }, "正在编辑一条自动记录：保存后将转为自定义记忆，原记录会被替换。")
								: null,
							h("div", { className: "smem-row", key: "cat" }, [
								h("span", { className: "smem-label", key: "l" }, "类别："),
								h(Chip, { key: "c1", label: "跨会话记忆", on: formCat === "custom", onClick: function () { setFormCat("custom"); } }),
								h(Chip, { key: "c2", label: "偏好记忆", on: formCat === "pref", onClick: function () { setFormCat("pref"); } }),
							]),
							h("label", { className: "smem-label", key: "lt" }, "标题（可选；保存时会自动带上内容摘要，确保新会话能直接检索到）"),
							h("input", { className: "smem-input", key: "tt", value: formTitle, onChange: function (e) { setFormTitle(e.target.value); }, placeholder: formCat === "pref" ? "例如：回答使用中文" : "例如：项目部署在 Bun 上" }),
							h("label", { className: "smem-label", key: "lx" }, "内容（将注入到未来会话）"),
							h("textarea", { className: "smem-textarea", key: "tx", rows: 4, value: formText, onChange: function (e) { setFormText(e.target.value); }, placeholder: "要长期记住的事实或偏好" }),
							h("div", { className: "smem-row", key: "btns" }, [
								h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "save", disabled: busy, onClick: submit }, busy ? "保存中…" : "保存"),
								h("button", { type: "button", className: "smem-btn", key: "cancel", disabled: busy, onClick: closeForm }, "取消"),
							]),
						])
					: null,
				h("div", { className: "smem-muted", key: "stats" },
					"共 " + String(items.length) + " 条 · 当前显示 " + String(filtered.length) + " 条" + (q ? "（搜索仅覆盖已加载部分）" : "")),
				loading && items.length === 0
					? h("div", { className: "smem-muted", key: "loading" }, "加载中…")
					: filtered.length === 0
						? h("div", { className: "smem-empty", key: "empty" },
								items.length === 0
									? "还没有记忆。对话中的事实与教训会自动沉淀到这里，也可以点「添加记忆」手动写入。"
									: "没有符合筛选条件的记忆。")
						: h("div", { className: "smem-list", key: "list" }, filtered.map(function (it) {
								return h(Card, {
									key: it.id,
									item: it,
									expanded: !!expanded[it.id],
									deleting: deleting === it.id,
									onToggle: function (id) {
										const nx = {};
										nx[id] = !expanded[id];
										setExpanded(Object.assign({}, expanded, nx));
									},
									onEdit: openForm,
									onAskDelete: function (id) { setDeleting(id); },
									onCancelDelete: function () { setDeleting(null); },
									onConfirmDelete: confirmDelete,
								});
							})),
				hasMore && !loading
					? h("div", { className: "smem-foot", key: "more" },
							h("button", { type: "button", className: "smem-btn", onClick: function () { load(false); } }, "加载更多"))
					: null,
			]);
		}

		const inject = ["slots"];

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			// 样式注入（参照官方 client bundle 的 data-plugin-css 约定，幂等）
			const tagId = "sage-mem/settings.css";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "sage-mem";
				tag.dataset.pluginCss = tagId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
			// 设置页入口：settings.section（list 型），排在 通用(0)/模型(10)/插件(15) 之后
			ctx.effect(() => slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "sage-mem", order: 20, label: "记忆管理" },
				Section,
			)), "sage-mem: settings section");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
