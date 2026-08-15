/**
 * sage-mem — 客户端半：DSH 设置页「记忆管理」界面（文件管理器）。
 *
 * 手写 ModuleLoader bundle（与官方 dsh-client-* 包的构建产物同格式）：
 * window.__ModuleLoader__.load({ id, factory })，factory 内 require('react')
 * 可用，module.exports 导出标准 Cordis 插件（apply/inject）。
 *
 * 数据通道：TypertRemoteService（host 半 MemoryGateway），通过
 * ctx.get("remote.memory") 调用文件列表/读/写/删。remote 返回 {ok, value}
 * 信封。浏览器侧无 zod，schema 手写（codec 只要求 mode==="strict" + parse）。
 *
 * 功能：浏览 memory 目录的 markdown 记忆文件（类型徽章 + 描述预览）、
 * 查看/编辑全文、两步确认删除、添加新记忆（选类型 + 描述 + 正文）。
 */

window.__ModuleLoader__.load({
	id: "sage-mem",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;

		// ── 手写 strict codec（浏览器无 zod，typert 只要求 parse 方法）──
		function parseSchema(shape) {
			return {
				parse(value) {
					if (value === null || typeof value !== "object") throw new Error("sage-mem: invalid payload");
					for (const [key, check] of Object.entries(shape)) {
						if (!(key in value)) throw new Error("sage-mem: missing field " + key);
						check(value[key]);
					}
					return value;
				},
			};
		}
		const isStr = (v) => { if (typeof v !== "string") throw new Error("expected string"); };
		const isBool = (v) => { if (typeof v !== "boolean") throw new Error("expected boolean"); };
		const isNum = (v) => { if (typeof v !== "number") throw new Error("expected number"); };
		const strSchema = { parse(v) { isStr(v); return v; } };
		const fileSchema = parseSchema({ "file": isStr, "type": isStr, "description": isStr, "size": isNum });
		const listSchema = { parse(v) { if (!Array.isArray(v)) throw new Error("expected array"); v.forEach((f) => fileSchema.parse(f)); return v; } };
		const readSchema = parseSchema({ "name": isStr, "content": isStr });
		const writeSchema = parseSchema({ "ok": isBool, "file": isStr });
		const deleteSchema = parseSchema({ "ok": isBool });

		const TYPERT_REMOTE = {
			package: "sage-mem",
			descriptors: [
				{
					id: "sage-mem#memory/listFiles",
					service: "memory",
					namespace: "memory",
					method: "listFiles",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#FileList", schema: listSchema },
					sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/readFile",
					service: "memory",
					namespace: "memory",
					method: "readFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#FileContent", schema: readSchema },
					sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/writeFile",
					service: "memory",
					namespace: "memory",
					method: "writeFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema } },
						{ name: "content", wire: "content", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileContent", schema: strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#WriteResult", schema: writeSchema },
					sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/deleteFile",
					service: "memory",
					namespace: "memory",
					method: "deleteFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#DeleteResult", schema: deleteSchema },
					sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
				},
			],
		};

		const CSS = [
			".smem-root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);max-width:760px;}",
			".smem-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".smem-title{font-size:15px;font-weight:600;}",
			".smem-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:none;}",
			".smem-dot--bad{background:var(--dsw-alias-state-error-primary,#ef4444);}",
			".smem-muted{color:var(--dsw-alias-label-secondary);font-size:12px;}",
			".smem-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".smem-search{flex:1;min-width:160px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;padding:5px 10px;font-size:12px;outline:none;font-family:inherit;}",
			".smem-search:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;}",
			".smem-btn:hover{border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-btn:disabled{opacity:.5;cursor:default;}",
			".smem-btn-primary{background:var(--dsw-alias-brand-primary,#4d76e6);border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-bg-base,#fff);}",
			".smem-btn-primary:hover{color:var(--dsw-alias-bg-base,#fff);opacity:.88;}",
			".smem-btn-danger-ghost{color:var(--dsw-alias-state-error-primary,#ef4444);border-color:var(--dsw-alias-border-l2);}",
			".smem-btn-danger{background:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;}",
			".smem-btn-danger:hover{color:#fff;opacity:.9;}",
			".smem-list{display:flex;flex-direction:column;gap:10px;}",
			".smem-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:6px;}",
			".smem-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".smem-card-title{font-weight:600;flex:1;min-width:120px;overflow-wrap:anywhere;text-align:left;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}",
			".smem-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px;white-space:nowrap;}",
			".smem-narrative{color:var(--dsw-alias-label-secondary);font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere;}",
			'.smem-narrative[data-clamp="1"]{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;}',
			".smem-card-foot{display:flex;justify-content:flex-end;}",
			".smem-actions{display:flex;gap:6px;}",
			".smem-form{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:8px;}",
			".smem-form-title{font-weight:600;font-size:13px;}",
			".smem-label{font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".smem-input,.smem-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;padding:6px 10px;font-size:13px;outline:none;font-family:inherit;}",
			".smem-input:focus,.smem-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-textarea{resize:vertical;min-height:72px;}",
			".smem-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
			".smem-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 12px;font-size:12px;cursor:pointer;font-family:inherit;}",
			".smem-chip:hover{border-color:var(--dsw-alias-border-l2);}",
			'.smem-chip[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-brand-primary,#4d76e6);}',
			".smem-chips{display:flex;gap:6px;flex-wrap:wrap;}",
			".smem-err{border:1px solid var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-state-error-primary,#ef4444);border-radius:8px;padding:6px 10px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;}",
			".smem-ok{color:var(--dsw-alias-state-success-primary,#16a34a);font-size:12px;}",
			".smem-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:22px 14px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;}",
		].join("\n");

		const TYPE_META = {
			user: ["👤", "用户"],
			feedback: ["📌", "反馈"],
			project: ["📁", "项目"],
			reference: ["🔗", "参考"],
		};
		const TYPE_ORDER = ["user", "feedback", "project", "reference"];

		function fmtSize(n) {
			if (n < 1024) return n + " B";
			if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
			return (n / 1024 / 1024).toFixed(1) + " MB";
		}

		/** 拆 typert remote 的 {ok, value} 信封。 */
		function unwrap(result) {
			return result && result.ok ? result.value : result;
		}

		function Chip(props) {
			return h("button", {
				type: "button",
				className: "smem-chip",
				"data-on": props.on ? "1" : "0",
				onClick: props.onClick,
			}, props.label);
		}

		function Card(props) {
			const item = props.item;
			const meta = TYPE_META[item.type] || TYPE_META.reference;
			const isOpen = !!props.expanded;
			return h("div", { className: "smem-card", key: item.file }, [
				h("div", { className: "smem-card-head", key: "head" }, [
					h("span", { className: "smem-badge", key: "badge", title: "类型 " + String(item.type) }, meta[0] + " " + meta[1]),
					h("span", { className: "smem-card-title", key: "title" }, item.file),
					h("span", { className: "smem-muted", key: "size" }, fmtSize(item.size)),
				]),
				item.description
					? h("div", {
							className: "smem-narrative",
							"data-clamp": isOpen ? "0" : "1",
							key: "body",
							onClick: function () { props.onToggle(item.file); },
							title: isOpen ? "点击收起" : "点击展开全文",
						}, String(item.description))
					: null,
				h("div", { className: "smem-card-foot", key: "foot" },
					h("div", { className: "smem-actions", key: "acts" },
						props.deleting
							? [
									h("button", { type: "button", className: "smem-btn smem-btn-danger", key: "yes", onClick: function () { props.onConfirmDelete(item.file); } }, "确认删除"),
									h("button", { type: "button", className: "smem-btn", key: "no", onClick: function () { props.onCancelDelete(); } }, "取消"),
								]
							: [
									h("button", { type: "button", className: "smem-btn", key: "edit", onClick: function () { props.onEdit(item.file); } }, "编辑"),
									h("button", { type: "button", className: "smem-btn smem-btn-danger-ghost", key: "del", onClick: function () { props.onAskDelete(item.file); } }, "删除"),
								])),
			]);
		}

		function Section(props) {
			const remote = props.ctx.get("remote.memory");
			const sItems = react.useState([]);
			const items = sItems[0], setItems = sItems[1];
			const sLoading = react.useState(false);
			const loading = sLoading[0], setLoading = sLoading[1];
			const sError = react.useState(null);
			const error = sError[0], setError = sError[1];
			const sNotice = react.useState("");
			const notice = sNotice[0], setNotice = sNotice[1];
			const sQuery = react.useState("");
			const query = sQuery[0], setQuery = sQuery[1];
			const sExpanded = react.useState({});
			const expanded = sExpanded[0], setExpanded = sExpanded[1];
			const sDeleting = react.useState(null);
			const deleting = sDeleting[0], setDeleting = sDeleting[1];
			const sFormOpen = react.useState(false);
			const formOpen = sFormOpen[0], setFormOpen = sFormOpen[1];
			const sEditingFile = react.useState(null);
			const editingFile = sEditingFile[0], setEditingFile = sEditingFile[1];
			const sFormType = react.useState("feedback");
			const formType = sFormType[0], setFormType = sFormType[1];
			const sFormName = react.useState("");
			const formName = sFormName[0], setFormName = sFormName[1];
			const sFormDesc = react.useState("");
			const formDesc = sFormDesc[0], setFormDesc = sFormDesc[1];
			const sFormBody = react.useState("");
			const formBody = sFormBody[0], setFormBody = sFormBody[1];
			const sBusy = react.useState(false);
			const busy = sBusy[0], setBusy = sBusy[1];
			const sOk = react.useState(false);
			const dirOk = sOk[0], setDirOk = sOk[1];

			function load() {
				setLoading(true);
				setError(null);
				remote.listFiles()
					.then(function (res) {
						const list = unwrap(res);
						setItems(Array.isArray(list) ? list : []);
						setDirOk(true);
					})
					.catch(function (e) { setError(String((e && e.message) || e)); setDirOk(false); })
					.then(function () { setLoading(false); });
			}

			react.useEffect(function () { load(); }, []);

			function closeForm() {
				setFormOpen(false); setEditingFile(null); setFormName(""); setFormDesc(""); setFormBody(""); setFormType("feedback");
			}

			function openEdit(file) {
				setError(null);
				setBusy(true);
				remote.readFile(file)
					.then(function (res) {
						const data = unwrap(res);
						const content = (data && data.content) || "";
						const fm = content.match(/^---\n([\s\S]*?)\n---\n?/);
						let type = "reference";
						let desc = "";
						let body = content;
						if (fm) {
							body = content.slice(fm[0].length);
							const t = fm[1].match(/type:\s*(\S+)/);
							if (t) type = t[1];
							const d = fm[1].match(/description:\s*"?(.+?)"?\n/);
							if (d) desc = d[1].replace(/["']/g, "");
						}
						setEditingFile(file);
						setFormName(file);
						setFormType(TYPE_ORDER.indexOf(type) >= 0 ? type : "reference");
						setFormDesc(desc);
						setFormBody(body);
						setFormOpen(true);
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			function openAdd() {
				setError(null);
				setEditingFile(null);
				setFormName("");
				setFormType("feedback");
				setFormDesc("");
				setFormBody("");
				setFormOpen(true);
			}

			function buildFrontmatter(type, desc) {
				return "---\nname: \"\"\ndescription: \"" + desc.replace(/"/g, "'") + "\"\nmetadata:\n  type: " + type + "\n---\n\n";
			}

			function submit() {
				if (!formDesc.trim()) { setError("描述不能为空"); return; }
				setBusy(true); setError(null); setNotice("");
				const type = formType;
				const name = (formName.trim() || (type + "_note.md"));
				const safeName = name.endsWith(".md") ? name : name + ".md";
				const content = buildFrontmatter(type, formDesc.trim()) + formBody;
				remote.writeFile(safeName, content)
					.then(function () {
						closeForm();
						setNotice(editingFile ? "已更新 " + safeName : "已保存 " + safeName);
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			function confirmDelete(file) {
				setBusy(true); setError(null); setNotice("");
				remote.deleteFile(file)
					.then(function () {
						setDeleting(null);
						setNotice("已删除 " + file);
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			const q = query.trim().toLowerCase();
			const filtered = items.filter(function (it) {
				if (!q) return true;
				const hay = ((it.file || "") + "\n" + (it.description || "") + "\n" + (it.type || "")).toLowerCase();
				return hay.indexOf(q) >= 0;
			});

			return h("div", { className: "smem-root" }, [
				h("div", { className: "smem-head", key: "head" }, [
					h("span", { className: "smem-title", key: "t" }, "记忆文件（sage-mem）"),
					h("span", { className: "smem-dot" + (dirOk ? "" : " smem-dot--bad"), key: "dot", title: dirOk ? "memory 目录可读" : "memory 目录不可读" }),
					h("span", { className: "smem-muted", key: "st" }, dirOk ? "目录可读" : "目录不可读"),
					h("span", { className: "smem-badge", key: "cnt" }, "共 " + String(items.length) + " 个文件"),
				]),
				h("div", { className: "smem-toolbar", key: "bar" }, [
					h("input", { className: "smem-search", key: "q", value: query, placeholder: "搜索文件名 / 描述 / 类型…", onChange: function (e) { setQuery(e.target.value); } }),
					h("button", { type: "button", className: "smem-btn", key: "refresh", disabled: busy || loading, onClick: load }, "刷新"),
					h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "add", onClick: openAdd }, "+ 添加记忆"),
				]),
				error ? h("div", { className: "smem-err", key: "err" }, "⚠ " + error) : null,
				notice && !error ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
				formOpen
					? h("div", { className: "smem-form", key: "form" }, [
							h("div", { className: "smem-form-title", key: "ft" }, editingFile ? "编辑 " + editingFile : "添加记忆"),
							h("div", { className: "smem-row", key: "cat" }, [
								h("span", { className: "smem-label", key: "l" }, "类型："),
								h("div", { className: "smem-chips", key: "chips" }, TYPE_ORDER.map(function (t) {
									const meta = TYPE_META[t];
									return h(Chip, { key: t, label: meta[0] + " " + meta[1], on: formType === t, onClick: function () { setFormType(t); } });
								})),
							]),
							h("label", { className: "smem-label", key: "ln" }, "文件名（.md，留空自动 " + formType + "_note.md）"),
							h("input", { className: "smem-input", key: "tn", value: formName, onChange: function (e) { setFormName(e.target.value); }, placeholder: "例如 project_traveler.md" }),
							h("label", { className: "smem-label", key: "ld" }, "描述（写进 frontmatter，检索与列表都靠它）"),
							h("input", { className: "smem-input", key: "td", value: formDesc, onChange: function (e) { setFormDesc(e.target.value); }, placeholder: "一句话说清这条记忆是什么" }),
							h("label", { className: "smem-label", key: "lb" }, "正文（可选，frontmatter 自动生成）"),
							h("textarea", { className: "smem-textarea", key: "tb", rows: 6, value: formBody, onChange: function (e) { setFormBody(e.target.value); }, placeholder: "要长期记住的细节" }),
							h("div", { className: "smem-row", key: "btns" }, [
								h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "save", disabled: busy, onClick: submit }, busy ? "保存中…" : "保存"),
								h("button", { type: "button", className: "smem-btn", key: "cancel", disabled: busy, onClick: closeForm }, "取消"),
							]),
						])
					: null,
				loading && items.length === 0
					? h("div", { className: "smem-muted", key: "loading" }, "加载中…")
					: filtered.length === 0
						? h("div", { className: "smem-empty", key: "empty" },
								items.length === 0
									? "还没有记忆文件。对话中值得记住的事会写到这里，也可以点「添加记忆」手动写入。"
									: "没有符合搜索条件的文件。")
						: h("div", { className: "smem-list", key: "list" }, filtered.map(function (it) {
								return h(Card, {
									key: it.file,
									item: it,
									expanded: !!expanded[it.file],
									deleting: deleting === it.file,
									onToggle: function (file) {
										const nx = {};
										nx[file] = !expanded[file];
										setExpanded(Object.assign({}, expanded, nx));
									},
									onEdit: openEdit,
									onAskDelete: function (file) { setDeleting(file); },
									onCancelDelete: function () { setDeleting(null); },
									onConfirmDelete: confirmDelete,
								});
							})),
			]);
		}

		const inject = ["slots", "remote"];

		/**
		 * Client 插件：$mount strict remote contribution（第三方 remote 不在
		 * dsh-api-remotes 的固定列表里，必须自己挂），再注册设置页签。
		 */
		async function apply(ctx) {
			await ctx.remote.$mount(TYPERT_REMOTE);
			// 样式注入（参照官方 client bundle 的 data-plugin-css 约定，幂等）
			const tagId = "sage-mem/settings.css";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "sage-mem";
				tag.dataset.pluginCss = tagId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{ name: "settings.section", id: "sage-mem", order: 20, label: "记忆管理" },
					(props) => react.createElement(Section, { ...props, ctx }),
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
