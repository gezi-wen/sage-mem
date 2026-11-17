		// ── 待办清单看板（2.11.0 · 实验性）──────────────────────────────────
		//
		// 数据源**唯一**：`memory/project_session-state.md`（跨会话代办清单，baseline 每场注入）。
		// 面板只做**行级手术**：勾选 = 给那一行加 `[x]`，新增 / 编辑 / 清理只动那几行，
		// 其余字节（frontmatter、引用块、空行、别的节）原样带走。
		//
		// 为什么不建自己的存储：文歌子要的是「AI 直接在 md 里调试」—— 同一个文件是唯一真相，
		// 面板只是它的另一种视图。第二份状态一定会漂移，而漂移的代价是「看板说做完了、文件里还在」。
		//
		// 承载面走**官方**注册表（`sidebarRightTabs`）：
		//   1. 给 tab 类型 `sage-mem:todo` + 一条 guide 条目（开始页卡片自动出现，better-sidebar 也读这张表）；
		//   2. 正文注册进键控槽 `sidebar.right.pane.tab`，标题注册进 `sidebar.right.pane.tab.title`；
		//   3. **definition + body 常驻，只有 guide 随开关变** —— 关掉开关时已打开的页签不会变成孤儿，
		//      它只是切到「已关闭」态。热开关靠的就是这条：注销 → 下一拍重注册（Phase 0 已实测）。

		/** 看板认的那一个文件（唯一真相源：改这个名字只改这里）。 */
		const TODO_FILE = "project_session-state.md";
		const TODO_TAB_ID = "sage-mem-todo";
		const TODO_TAB_KIND = "sage-mem:todo";
		const TODO_GUIDE_ID = "sage-mem-todo";
		/** 轮询间隔：AI 用普通编辑工具改文件后，面板最多这么久就该跟上。 */
		const TODO_POLL_MS = 4000;
		/** 卡片正文折叠阈值（字符数；右栏很窄，两三行就够看了）。 */
		const TODO_DETAIL_CHARS = 150;
		/** 没有 `##` 节时条目落进这个兜底组。 */
		const TODO_SECTION_FALLBACK = "todo.fallbackSection";

		/** 开关状态（模块级：设置卡与页签共享）。 */
		let todoBoardEnabled = false;
		/** 当前 definition 是否带着 guide 卡片（避免每次 apply 都白重注册一次）。 */
		let todoBoardGuideShown = false;
		let todoBoardCtx = null;
		let todoBoardRegistryDispose = null;
		let todoBoardBodyDispose = null;
		let todoBoardTitleDispose = null;
		const todoBoardListeners = new Set();

		/** 无条件调用的钩子替身（宿主没给 `useTabInfo` 时用，避免条件调 hook）。 */
		function todoBoardNoTabInfo() { return null; }

		function todoBoardNotify() {
			todoBoardListeners.forEach(function (fn) {
				try { fn(); } catch (e) { /* 单个订阅者坏掉不影响别的 */ }
			});
		}

		/** 订阅开关变化（页签正文与设置卡都靠它重渲染）。 */
		function useTodoBoardEnabled() {
			const s = react.useState(todoBoardEnabled);
			const setV = s[1];
			react.useEffect(function () {
				const fn = function () { setV(todoBoardEnabled); };
				todoBoardListeners.add(fn);
				fn();
				return function () { todoBoardListeners.delete(fn); };
			}, []);
			return s[0];
		}

		// ── 解析：markdown → 节 + 条目（纯函数，不碰 IO）────────────────────

		/**
		 * 条目标题：`**…**` 里的那一截；没有就用 null（渲染时不画标题行，正文自己说话）。
		 * @param {string} text 条目正文（`- ` 之后，已剥掉 `[x]`）
		 */
		function todoItemTitle(text) {
			const bold = /\*\*(.+?)\*\*/.exec(text);
			return bold ? bold[1].trim() : null;
		}

		/**
		 * 条目正文：去掉开头那段 `**标题**` 与紧随的分隔符 —— 标题已经在上面单独画了一行，
		 * 正文再带一遍就是同一句话说两次（第一次真机截图就是这么发现的）。
		 */
		function todoItemDetail(text) {
			const body = String(text == null ? "" : text);
			const m = /^\s*\*\*(?:.+?)\*\*/.exec(body);
			if (!m) return body.trim();
			return body.slice(m[0].length).replace(/^[\s—–\-:：、，,。]+/, "").trim();
		}

		/**
		 * 极简内联渲染：`**加粗**` / `` `代码` `` / `[[记忆]]`。其余原样。
		 * 不引 markdown 解析器：这里只显示，不需要块级语法。
		 */
		function todoInline(text) {
			const out = [];
			const re = /(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\])/g;
			let last = 0;
			let m;
			let i = 0;
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) out.push(text.slice(last, m.index));
				const tok = m[0];
				if (tok.startsWith("**")) out.push(h("strong", { key: "b" + i }, tok.slice(2, -2)));
				else if (tok.startsWith("[[")) out.push(h("span", { key: "l" + i, className: "smem-todo-ref" }, tok.slice(2, -2)));
				else out.push(h("code", { key: "c" + i, className: "smem-todo-code" }, tok.slice(1, -1)));
				last = m.index + tok.length;
				i += 1;
			}
			if (last < text.length) out.push(text.slice(last));
			return out;
		}

		/**
		 * 拆一份代办清单。**只读**：`lines` 原样保留，条目只记「行号 + 内容」，
		 * 写回时按行号替换，所以任何没被操作的字节都不会变。
		 *
		 * @param {string} text
		 * @returns {{lines: string[], sections: Array<object>, open: number, done: number}}
		 */
		function parseTodoList(text) {
			const lines = String(text == null ? "" : text).split("\n");
			const sections = [];
			let current = null;
			let lastItem = null;
			let inFront = false;
			let seenContent = false;
			let open = 0;
			let done = 0;
			for (let i = 0; i < lines.length; i++) {
				// 分析用去掉行尾 `\r`（CRLF 文件读得懂）；`lines` 本身原样留着，写回不动没碰过的行。
				const rawLine = lines[i];
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
				if (!seenContent && /^---\s*$/.test(line)) { inFront = true; seenContent = true; continue; }
				if (inFront) {
					if (/^---\s*$/.test(line)) inFront = false;
					continue;
				}
				if (line.trim() !== "") seenContent = true;
				const heading = /^##\s+(.*)$/.exec(line);
				if (heading) {
					const title = heading[1].trim();
					const constraint = /长期约束|不是待办|别删/.test(title);
					current = { title: title, kind: constraint ? "constraint" : "todo", items: [], insertAt: i + 1, headingIndex: i };
					sections.push(current);
					lastItem = null;
					continue;
				}
				const bullet = /^(\s*)-\s+(.*)$/.exec(line);
				if (bullet && bullet[1] !== "" && lastItem !== null) {
					// 缩进的 `- ` 是上一条的子项（真文件里只有缩进续行）：并进 cont，**不**算新条目。
					let sub = bullet[2];
					const subBox = /^\[([ xX])\]\s*(.*)$/.exec(sub);
					if (subBox) sub = subBox[2];
					lastItem.cont += (lastItem.cont ? " " : "") + sub;
					continue;
				}
				if (bullet) {
					let body = bullet[2];
					let isDone = false;
					const box = /^\[([ xX])\]\s*(.*)$/.exec(body);
					if (box) { isDone = box[1].toLowerCase() === "x"; body = box[2]; }
					const item = { line: i, done: isDone, text: body, title: todoItemTitle(body), detail: todoItemDetail(body), cont: "" };
					if (current === null) {
						current = { title: "", kind: "todo", items: [], insertAt: i, headingIndex: -1 };
						sections.push(current);
					}
					current.items.push(item);
					// 插入点 = 本条之后：节尾最后一条的下方，不会被后面的空行 / 下一节吃掉。
					current.insertAt = i + 1;
					if (isDone) done += 1; else open += 1;
					lastItem = item;
					continue;
				}
				// 续行（两个空格以上缩进、不是 `- `）：并进上一条的正文，只用于显示。
				if (lastItem !== null && /^\s{2,}\S/.test(line)) {
					lastItem.cont += (lastItem.cont ? " " : "") + line.trim();
				} else if (line.trim() !== "") {
					lastItem = null;
				}
			}
			return { lines: lines, sections: sections, open: open, done: done };
		}

		// ── 行级手术（纯函数：输入旧全文 → 输出新全文，不改入参）────────────

		/** 在第 line 行上加/去 `[x]`。返回新全文；行不认识（没有 `- `）就回 null。 */
		function todoToggle(text, line, done) {
			const lines = String(text).split("\n");
			const raw = lines[line];
			if (raw === undefined) return null;
			const m = /^(\s*)-\s+(.*)$/.exec(raw);
			if (!m) return null;
			let body = m[2];
			const box = /^\[([ xX])\]\s*(.*)$/.exec(body);
			if (box) body = box[2];
			lines[line] = m[1] + "- " + (done ? "[x] " : "") + body;
			return lines.join("\n");
		}

		/** 在第 at 行插入一条 `- <body>`。 */
		function todoInsert(text, at, body) {
			const lines = String(text).split("\n");
			const clean = String(body == null ? "" : body).replace(/\r?\n/g, " ").trim();
			if (clean === "") return null;
			const index = Math.max(0, Math.min(at, lines.length));
			lines.splice(index, 0, "- " + clean);
			return lines.join("\n");
		}

		/** 替换第 line 行的正文（保留 `[x]` 标记与缩进）。 */
		function todoReplace(text, line, body) {
			const lines = String(text).split("\n");
			const raw = lines[line];
			if (raw === undefined) return null;
			const m = /^(\s*)-\s+(.*)$/.exec(raw);
			if (!m) return null;
			const clean = String(body == null ? "" : body).replace(/\r?\n/g, " ").trim();
			if (clean === "") return null;
			const box = /^\[([ xX])\]\s*/.exec(m[2]);
			lines[line] = m[1] + "- " + (box ? box[0] : "") + clean;
			return lines.join("\n");
		}

		/** 删掉若干行（从大到小删，行号不互相错位）。 */
		function todoRemove(text, lineNumbers) {
			const lines = String(text).split("\n");
			const sorted = lineNumbers.slice().sort(function (a, b) { return b - a; });
			sorted.forEach(function (n) { if (n >= 0 && n < lines.length) lines.splice(n, 1); });
			return lines.join("\n");
		}

		/** 清理已完成：删掉所有 `- [x]` 行。返回 { next, count }。 */
		function todoClearDone(text) {
			const parsed = parseTodoList(text);
			const targets = [];
			parsed.sections.forEach(function (sec) {
				sec.items.forEach(function (it) { if (it.done) targets.push(it.line); });
			});
			if (targets.length === 0) return { next: null, count: 0 };
			return { next: todoRemove(text, targets), count: targets.length };
		}

		// ── 视图 ──────────────────────────────────────────────────────────

		/** 一条待办的卡片：勾选 + 标题 + 折叠正文 + 行内编辑。 */
		function TodoItemRow(props) {
			const item = props.item;
			const sOpen = react.useState(false);
			const expanded = sOpen[0], setExpanded = sOpen[1];
			const sDraft = react.useState(null);
			const draft = sDraft[0], setDraft = sDraft[1];
			const editing = draft !== null;
			const body = item.detail + (item.cont ? " " + item.cont : "");
			const long = body.length > TODO_DETAIL_CHARS;
			const shown = long && !expanded ? body.slice(0, TODO_DETAIL_CHARS) + "…" : body;
			return h("div", { className: "smem-todo-item" + (item.done ? " smem-todo-item-done" : "") }, [
				h("button", {
					key: "box",
					type: "button",
					className: "smem-todo-box" + (item.done ? " smem-todo-box-on" : ""),
					title: item.done ? t("todo.action.uncheck") : t("todo.action.check"),
					disabled: props.busy,
					onClick: function () { props.onToggle(item, !item.done); },
				}, item.done ? "✓" : ""),
				h("div", { key: "body", className: "smem-todo-body" }, [
					item.title ? h("div", { key: "title", className: "smem-todo-title" }, todoInline(item.title)) : null,
					editing
						? h("textarea", {
							key: "edit",
							className: "smem-input smem-todo-edit",
							value: draft,
							rows: 3,
							onChange: function (e) { setDraft(e.target.value); },
						})
						: (shown ? h("div", { key: "text", className: "smem-todo-text" }, todoInline(shown)) : null),
					h("div", { key: "act", className: "smem-todo-actions" }, editing
						? [
							h("button", { key: "s", type: "button", className: "smem-btn smem-btn-primary smem-todo-mini", disabled: props.busy, onClick: function () { props.onEdit(item, draft); setDraft(null); } }, t("todo.action.save")),
							h("button", { key: "c", type: "button", className: "smem-btn smem-todo-mini", onClick: function () { setDraft(null); } }, t("todo.action.cancel")),
						]
						: [
							long ? h("button", { key: "m", type: "button", className: "smem-link smem-todo-mini", onClick: function () { setExpanded(!expanded); } }, expanded ? t("todo.less") : t("todo.more")) : null,
							h("button", { key: "e", type: "button", className: "smem-link smem-todo-mini", disabled: props.busy, onClick: function () { setDraft(item.text); } }, t("todo.action.edit")),
						]),
				]),
			]);
		}

		/** 一组（一个 `##` 节）：标题 + 计数 + 条目 + 新增框。 */
		function TodoSectionGroup(props) {
			const sec = props.section;
			const constraint = sec.kind === "constraint";
			const sCollapsed = react.useState(constraint);
			const collapsed = sCollapsed[0], setCollapsed = sCollapsed[1];
			const sDraft = react.useState("");
			const draft = sDraft[0], setDraft = sDraft[1];
			const openCount = sec.items.filter(function (it) { return !it.done; }).length;
			const doneCount = sec.items.length - openCount;
			return h("section", { className: "smem-todo-group" }, [
				h("button", {
					key: "head",
					type: "button",
					className: "smem-todo-group-head",
					onClick: function () { setCollapsed(!collapsed); },
				}, [
					h("span", { key: "chev", className: "smem-todo-chev" }, collapsed ? "▸" : "▾"),
					h("span", { key: "t", className: "smem-todo-group-title" }, sec.title || t(TODO_SECTION_FALLBACK)),
					h("span", { key: "n", className: "smem-todo-count" }, String(openCount) + (doneCount > 0 ? " / " + String(doneCount) : "")),
				]),
				collapsed ? null : h("div", { key: "list", className: "smem-todo-list" }, sec.items.length === 0
					? [h("div", { key: "empty", className: "smem-todo-empty" }, t("todo.empty.section"))]
					: sec.items.map(function (it) {
						return h(TodoItemRow, {
							key: "i" + it.line, item: it, busy: props.busy,
							onToggle: props.onToggle, onEdit: props.onEdit,
						});
					})),
				collapsed ? null : h("div", { key: "add", className: "smem-todo-add" }, [
					h("input", {
						key: "in",
						className: "smem-input smem-todo-add-input",
						placeholder: t("todo.add.placeholder"),
						value: draft,
						disabled: props.busy,
						onChange: function (e) { setDraft(e.target.value); },
						onKeyDown: function (e) {
							if (e.key === "Enter") {
								const body = String(draft).trim();
								if (body === "") return;
								props.onAdd(sec, body);
								setDraft("");
							}
						},
					}),
				]),
			]);
		}

		/** 页签正文。承载全部读写状态（宿主只给 ctx / sessionId / 标准 hooks）。 */
		function TodoBoard(props) {
			const ctx = props.ctx;
			const remote = stableRemote(ctx, "remote.memory");
			const enabled = useTodoBoardEnabled();
			const useTabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo : todoBoardNoTabInfo;
			const tabInfo = useTabInfo();
			const visible = !(tabInfo && tabInfo.tab && tabInfo.tab.visible === false);

			const sDoc = react.useState(null); const doc = sDoc[0], setDoc = sDoc[1];
			const sErr = react.useState(null); const err = sErr[0], setErr = sErr[1];
			const sNotice = react.useState(""); const notice = sNotice[0], setNotice = sNotice[1];
			const sBusy = react.useState(false); const busy = sBusy[0], setBusy = sBusy[1];
			// 撤销只留一步：上一次写入前的 {content, revision}。够用，且不会让人误以为能回滚一整天。
			const sUndo = react.useState(null); const undo = sUndo[0], setUndo = sUndo[1];

			/** 读一次文件。`quiet` = 轮询调用（出错不弹条，避免每 4 秒闪一次）。 */
			const load = react.useCallback(function (quiet) {
				if (!remote || typeof remote.readFile !== "function") {
					if (!quiet) setErr(t("todo.err.noRemote"));
					return;
				}
				return Promise.resolve(remote.readFile(TODO_FILE)).then(function (res) {
					const data = unwrap(res);
					if (data && data.ok === false) {
						setDoc({ missing: true, content: "", revision: null, parsed: parseTodoList("") });
						if (!quiet) setErr(data.error || t("todo.err.read", { error: String(data.code || "error") }));
						return;
					}
					const content = (data && data.content) || "";
					const revision = data && typeof data.revision === "string" ? data.revision : null;
					// quiet 轮询里 revision 没变就什么都不做 —— 否则每 4 秒整棵树重渲染一次。
					setDoc(function (prev) {
						if (quiet && prev && !prev.missing && prev.revision === revision) return prev;
						return { missing: false, content: content, revision: revision, parsed: parseTodoList(content) };
					});
				}, function (e) {
					if (!quiet) setErr(String((e && e.message) || e));
				});
			}, [remote]);

			react.useEffect(function () { load(false); }, [load]);

			// 轮询：只在页签可见时跑；切走（不可见）就停，别在后台白读盘。
			react.useEffect(function () {
				if (!visible || !enabled) return undefined;
				const id = setInterval(function () {
					if (typeof document !== "undefined" && document.hidden) return;
					load(true);
				}, TODO_POLL_MS);
				return function () { clearInterval(id); };
			}, [visible, enabled, load]);

			/**
			 * 一次写入：带上读到的 revision（盘上变了宿主回 stale_revision，我们只重读、不覆盖）。
			 * @param {string} label 回执文案（已翻译）
			 * @param {string} next 新全文
			 */
			function mutate(label, next) {
				if (!next || next === doc.content) return;
				setBusy(true); setErr(null); setNotice("");
				const revision = doc.revision;
				const opts = revision ? { expectedRevision: revision } : undefined;
				writeWithFallback(remote, "writeFile", [TODO_FILE, next], opts, null)
					.then(function (out) {
						const r = out.result;
						if (r && r.ok === false) {
							if (r.code === "stale_revision") {
								setNotice(t("todo.notice.stale"));
								return load(false);
							}
							setErr(r.error || t("todo.err.write", { error: String(r.code || "error") }));
							return;
						}
						setUndo({ content: doc.content, revision: revision });
						setNotice(out.degraded ? t("todo.notice.degraded") : label);
						return load(false);
					}, function (e) { setErr(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			function onToggle(item, done) {
				mutate(t(done ? "todo.notice.done" : "todo.notice.undone"), todoToggle(doc.content, item.line, done));
			}

			function onAdd(section, body) {
				mutate(t("todo.notice.added"), todoInsert(doc.content, section.insertAt, body));
			}

			function onEdit(item, body) {
				mutate(t("todo.notice.edited"), todoReplace(doc.content, item.line, body));
			}

			function onClearDone() {
				const out = todoClearDone(doc.content);
				if (out.count === 0) return;
				mutate(t("todo.notice.cleared", { count: out.count }), out.next);
			}

			function onUndo() {
				if (!undo) return;
				const revision = doc.revision;
				setBusy(true); setErr(null); setNotice("");
				writeWithFallback(remote, "writeFile", [TODO_FILE, undo.content], revision ? { expectedRevision: revision } : undefined, null)
					.then(function (out) {
						const r = out.result;
						if (r && r.ok === false) { setErr(r.error || t("todo.err.write", { error: String(r.code || "error") })); return; }
						setUndo(null);
						setNotice(t("todo.notice.undo"));
						return load(false);
					}, function (e) { setErr(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			if (!enabled) {
				return h("div", { className: "smem-todo-done-state" }, [
					h("div", { key: "t", className: "smem-todo-done-title" }, t("todo.disabled.title")),
					h("div", { key: "h", className: "smem-muted" }, t("todo.disabled.hint")),
				]);
			}

			const parsed = doc && doc.parsed ? doc.parsed : parseTodoList("");
			const missing = doc && doc.missing;
			const stats = t("todo.stat", { open: parsed.open, done: parsed.done, sections: parsed.sections.length });

			return h("div", { className: "smem-todo" }, [
				h("div", { key: "head", className: "smem-todo-head" }, [
					h("span", { key: "s", className: "smem-todo-stat" }, stats),
					h("span", { key: "sp", "data-spring": "" }),
					undo ? h("button", { key: "u", type: "button", className: "smem-link smem-todo-mini", disabled: busy, onClick: onUndo }, t("todo.action.undo")) : null,
					parsed.done > 0 ? h("button", { key: "c", type: "button", className: "smem-link smem-todo-mini", disabled: busy, onClick: onClearDone }, t("todo.action.clearDone", { count: parsed.done })) : null,
					h("button", { key: "r", type: "button", className: "smem-link smem-todo-mini", disabled: busy, onClick: function () { load(false); } }, t("todo.refresh")),
				]),
				err ? h("div", { key: "err", className: "smem-err" }, "⚠ " + err) : null,
				notice ? h("div", { key: "ok", className: "smem-ok" }, "✓ " + notice) : null,
				missing
					? h("div", { key: "miss", className: "smem-todo-empty" }, t("todo.empty.file", { file: TODO_FILE }))
					: h("div", { key: "groups", className: "smem-todo-groups" }, parsed.sections.map(function (sec, i) {
						return h(TodoSectionGroup, {
							key: "s" + i, section: sec, busy: busy,
							onToggle: onToggle, onAdd: onAdd, onEdit: onEdit,
						});
					})),
			]);
		}

		// ── 注册与热开关 ──────────────────────────────────────────────────

		/** guide 条目（开始页那张卡片）。关掉开关时整条不给 —— 卡片随之消失。 */
		function todoBoardGuideEntry() {
			return {
				id: TODO_GUIDE_ID,
				order: 30,
				title: function () { return t("todo.guide.title"); },
				description: function () { return t("todo.guide.desc"); },
			};
		}

		/**
		 * 注册 / 重注册 tab 定义。**body 与 title 槽不在这里**（它们常驻，见 applyTodoBoard）。
		 * @param {boolean} withGuide 是否带开始页卡片
		 */
		function registerTodoBoardDefinition(withGuide) {
			const ctx = todoBoardCtx;
			const tabs = ctx && typeof ctx.get === "function" ? ctx.get("sidebarRightTabs") : null;
			if (!tabs || typeof tabs.register !== "function") return false;
			if (todoBoardRegistryDispose !== null) {
				try { todoBoardRegistryDispose(); } catch (e) { /* 已经注销过就忽略 */ }
				todoBoardRegistryDispose = null;
			}
			try {
				todoBoardRegistryDispose = tabs.register({
					id: TODO_TAB_ID,
					kind: TODO_TAB_KIND,
					priority: "extension",
					title: function () { return t("todo.tabTitle"); },
					guide: withGuide ? [todoBoardGuideEntry()] : undefined,
				});
				return true;
			} catch (e) {
				todoBoardRegistryDispose = null;
				return false;
			}
		}

		/** 打开一次页签（失败静默：宿主可能不支持程序化打开，用户点卡片也一样）。 */
		function openTodoBoardTab() {
			try {
				const nav = todoBoardCtx && typeof todoBoardCtx.get === "function" ? todoBoardCtx.get("sidebarRight") : null;
				if (nav && typeof nav.openTab === "function") nav.openTab(TODO_TAB_KIND);
			} catch (e) { /* 打不开不是错，卡片还在 */ }
		}

		/**
		 * 热开关的唯一入口：设置卡拨开关、apply 启动时都走这里。
		 *
		 * - 开：body / title 槽先注册好，再注册 definition（带 guide），最后试着开一次页签；
		 * - 关：**只**重注册 definition（不带 guide）—— body 常驻，已开的页签切到「已关闭」态，
		 *   不会变成孤儿页签，也不需要刷新页面。
		 * @param {boolean} on
		 */
		function applyTodoBoard(on) {
			const next = !!on;
			todoBoardEnabled = next;
			const ctx = todoBoardCtx;
			if (ctx === null) { todoBoardNotify(); return; }
			if (next) {
				if (todoBoardBodyDispose === null) {
					try {
						todoBoardBodyDispose = ctx.slots.inject("sidebar.right.pane.tab", function () {
							return ctx.slots.register({ name: "sidebar.right.pane.tab", key: TODO_TAB_ID }, function (props) {
								// 把 ctx 传进正文：正文只用标准 hooks + 我们自己的 remote，不额外依赖宿主内部。
								return react.createElement(TodoBoard, Object.assign({}, props, { ctx: ctx }));
							});
						});
						todoBoardTitleDispose = ctx.slots.inject("sidebar.right.pane.tab.title", function () {
							return ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TODO_TAB_ID }, function () {
								return h("span", null, t("todo.tabTitle"));
							});
						});
					} catch (e) {
						todoBoardBodyDispose = null;
						todoBoardTitleDispose = null;
					}
				}
				if (!todoBoardGuideShown) {
					if (registerTodoBoardDefinition(true)) {
						todoBoardGuideShown = true;
						openTodoBoardTab();
					}
				}
			} else if (todoBoardBodyDispose !== null && todoBoardGuideShown) {
				// body 常驻、只摘掉 guide：已打开的页签留下，正文切到「已关闭」态。
				if (registerTodoBoardDefinition(false)) todoBoardGuideShown = false;
			}
			todoBoardNotify();
		}

		/** 宿主有没有右侧栏能力（设置卡据此置灰 / 解释）。 */
		function todoBoardHostSupported(ctx) {
			try {
				const tabs = ctx && typeof ctx.get === "function" ? ctx.get("sidebarRightTabs") : null;
				return !!(tabs && typeof tabs.register === "function");
			} catch (e) { return false; }
		}

		/** 实验性页里的那张卡：开关 + 三句话（这是什么 / 立刻生效 / 宿主不支持时置灰）。 */		function TodoBoardLabCard(props) {
			const ctx = props.ctx;
			const remote = stableRemote(ctx, "remote.memory");
			const supported = todoBoardHostSupported(ctx);
			const sOn = react.useState(todoBoardEnabled);
			const on = sOn[0], setOn = sOn[1];
			const sBusy = react.useState(false); const busy = sBusy[0], setBusy = sBusy[1];
			const sErr = react.useState(null); const err = sErr[0], setErr = sErr[1];
			const sNotice = react.useState(""); const notice = sNotice[0], setNotice = sNotice[1];

			// 初次挂载：以宿主设置里的值为准（模块加载时那份 + 待生效那份对 live 开关是一致的）。
			react.useEffect(function () {
				const m = stableRemote(ctx, "remote.memory");
				if (!m || typeof m.getSettings !== "function") return;
				Promise.resolve(m.getSettings()).then(function (res) {
					const d = unwrap(res) || {};
					const value = d.pendingExperimental && typeof d.pendingExperimental.todoBoard === "number"
						? d.pendingExperimental.todoBoard
						: (d.experimental && d.experimental.todoBoard) || 0;
					setOn(value > 0);
					applyTodoBoard(value > 0);
				}, function () { /* 读不到就按当前内存态显示 */ });
			}, [ctx]);

			function toggle() {
				const next = on ? 0 : 1;
				setBusy(true); setErr(null); setNotice("");
				Promise.resolve(remote.setSettings({ experimental: { todoBoard: next } })).then(function (out) {
					setBusy(false);
					// setSettings 自带 {ok, settings, restartRequired}：直接读，不要 unwrap。
					if (out && out.ok === false) { setErr(out.error || t("todo.lab.rejected")); return; }
					setOn(next > 0);
					applyTodoBoard(next > 0);
					setNotice(t(next > 0 ? "todo.lab.onNotice" : "todo.lab.offNotice"));
				}, function (e) { setBusy(false); setErr(String((e && e.message) || e)); });
			}

			return h("div", { className: "smem-todo-lab smem-module-card" }, [
				h("div", { className: "smem-modcard-head", key: "head" }, [
					h(Switch, {
						key: "sw",
						on: on,
						label: t("todo.lab.switch"),
						title: supported ? t("todo.lab.switch.title") : t("todo.lab.unsupported"),
						disabled: busy || !supported,
						onClick: toggle,
					}),
					h("span", { className: "smem-modcard-title", key: "t" }, t("todo.lab.title")),
					h("span", { className: "smem-modcard-status", key: "s" }, on ? t("todo.lab.status.on") : t("todo.lab.status.off")),
				]),
				h("div", { className: "smem-autodream-sec", key: "what" }, [
					h("div", { className: "smem-autodream-note", key: "p1" }, t("todo.lab.what")),
					h("div", { className: "smem-autodream-note", key: "p2" }, t("todo.lab.live")),
					supported ? null : h("div", { className: "smem-autodream-note", key: "p3" }, t("todo.lab.unsupported")),
				]),
				err ? h("div", { className: "smem-err", key: "err" }, "⚠ " + err) : null,
				notice ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
			]);
		}

		// 测试缝：解析与行级手术是纯函数，而在 factory 闭包里外面拿不到 ——
		// 只给 `test/todo-board-test.mjs` 用，运行期没有任何代码读它（宿主只认 apply / inject）。
		exports.todoBoardInternals = {
			FILE: TODO_FILE,
			TAB_KIND: TODO_TAB_KIND,
			parse: parseTodoList,
			titleOf: todoItemTitle,
			toggle: todoToggle,
			insert: todoInsert,
			replace: todoReplace,
			remove: todoRemove,
			clearDone: todoClearDone,
			isEnabled: function () { return todoBoardEnabled; },
			notify: todoBoardNotify,
		};
