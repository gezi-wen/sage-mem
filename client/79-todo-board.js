		// ── 待办清单看板（2.11.0 · 实验性 / 2.11.1 勾选改「搬家」）─────────────
		//
		// 数据源**唯一**：`memory/project_session-state.md`（跨会话代办清单，baseline 每场注入）。
		// 面板只做**行级手术**：勾选 = 把那一行从原组删掉、搬进「已完成，待删除」块；
		// 新增 / 编辑 / 删除只动那几行，其余字节（frontmatter、引用块、空行、别的节）原样带走。
		//
		// 为什么勾选是**搬家**而不是加 `[x]`（2.11.1，用户反馈 2026-11-17）：完成项留在原组里，
		// 原组就越读越长，而「已完成」本来只该是**待清理的队列**。搬进单独一块之后，
		// agent 收尾时一眼就能看见该搬哪几条进 `session-log.md`、搬完从这块删掉。
		// 这也把「谁来删」从模型自觉变成了一个显式位置 —— 见 `skills/sage-mem/SKILL.md`。
		//
		// 为什么不建自己的存储：用户要的是「AI 直接在 md 里调试」—— 同一个文件是唯一真相，
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
		/** 「已完成，待删除」块：标题匹配它就算 done 组（`kind: "done"`）。 */
		const TODO_DONE_PATTERN = /已完成|待删除/;
		/**
		 * 文件里还没有这个块时，第一次勾选按这行标题建块。
		 * **字面量写进文件，不跟界面语言走** —— 它是文件格式的一部分，不是 UI 文案。
		 */
		const TODO_DONE_HEADING = "## 已完成，待删除";
		/** 撤销 / 重做各留几步（用户要两步；再多会让人误以为能回滚一整天）。 */
		const TODO_UNDO_DEPTH = 2;

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
					// 三档：done（「已完成，待删除」块，勾选搬进这里）/ constraint（长期约束，别删）/ 普通待办。
					const kind = TODO_DONE_PATTERN.test(title) ? "done" : (/长期约束|不是待办|别删/.test(title) ? "constraint" : "todo");
					current = { title: title, kind: kind, items: [], insertAt: i + 1, headingIndex: i };
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
					if (current === null) {
						current = { title: "", kind: "todo", items: [], insertAt: i, headingIndex: -1 };
						sections.push(current);
					}
					// 待删除块里的条目按语义就是「已完成」，不靠行首 `[x]` 自证（手写的也算）。
					const inDone = current.kind === "done";
					const item = {
						line: i, done: isDone || inDone, inDone: inDone,
						text: body, title: todoItemTitle(body), detail: todoItemDetail(body), cont: "",
					};
					current.items.push(item);
					// 插入点 = 本条之后：节尾最后一条的下方，不会被后面的空行 / 下一节吃掉。
					current.insertAt = i + 1;
					if (item.done) done += 1; else open += 1;
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

		/**
		 * 把一行拆成 `- ` 条目的三段。行不认识（不是 `- ` 开头）就回 null。
		 * ⚠️ 先把行尾 `\r` 摘掉再匹配：JS 的 `.` 与 `$` 都不吃 `\r`，
		 * 带着它匹配 `/^(\s*)-\s+(.*)$/` 一律不中 —— CRLF 文件会一条都认不出来。
		 * @returns {{indent: string, body: string, done: boolean}|null} body 已剥掉 `[x]`
		 */
		function todoBullet(line) {
			const raw = String(line == null ? "" : line).replace(/\r+$/, "");
			const m = /^(\s*)-\s+(.*)$/.exec(raw);
			if (!m) return null;
			let body = m[2];
			let done = false;
			const box = /^\[([ xX])\]\s*(.*)$/.exec(body);
			if (box) { done = box[1].toLowerCase() === "x"; body = box[2]; }
			return { indent: m[1], body: body.replace(/\s+$/, ""), done: done };
		}

		/** 文件用的行尾：CRLF 文件里插的新行也带 `\r`，免得一份文件两种换行。 */
		function todoEol(text) {
			return String(text == null ? "" : text).indexOf("\r\n") >= 0 ? "\r" : "";
		}

		/**
		 * 找「已完成，待删除」块的行区间。
		 * @returns {{start: number, end: number}|null} `[start, end)`：`start` 是标题行，`end` 是下一个 `##` 或文件尾
		 */
		function todoDoneRange(lines) {
			const heading = /^##\s+(.*)$/;
			for (let i = 0; i < lines.length; i++) {
				// 先摘 `\r`：CRLF 文件里带 `\r` 的行用 `.` / `$` 匹配不到（见 todoBullet 那条注释）。
				const m = heading.exec(String(lines[i]).replace(/\r+$/, ""));
				if (!m || !TODO_DONE_PATTERN.test(m[1].trim())) continue;
				let end = lines.length;
				for (let j = i + 1; j < lines.length; j++) {
					if (heading.exec(String(lines[j]).replace(/\r+$/, ""))) { end = j; break; }
				}
				return { start: i, end: end };
			}
			return null;
		}

		/**
		 * 勾选 = **搬家**：从原组删掉第 line 行，在「已完成，待删除」块末尾追加 `- [x] <正文>`。
		 *
		 * - 文件里还没有那个块时，在**文件末尾**追加 `\n## 已完成，待删除\n` 再写条目，其余字节不动。
		 * - 只搬**顶层**条目（缩进行是上一条的续行，跟着它自己留在原处，不在此处重构）。
		 * - 正文只带原正文：不带原行首 `- `，也剥掉已有的 `[x]` 前缀。
		 *
		 * @returns {string|null} 新全文；不认识的行 / 空正文回 null（调用方据此不写盘）
		 */
		function todoMoveToDone(text, line) {
			const src = String(text == null ? "" : text);
			const lines = src.split("\n");
			if (line < 0 || line >= lines.length) return null;
			const bullet = todoBullet(lines[line]);
			if (!bullet || bullet.indent !== "" || bullet.body === "") return null;
			const eol = todoEol(src);
			const next = lines.slice();
			next.splice(line, 1);
			const range = todoDoneRange(next);
			if (!range) {
				if (next.length > 0 && next[next.length - 1] === "") next.pop();
				const tail = next.length > 0 ? [""] : [];
				return next.concat(tail, [TODO_DONE_HEADING + eol, "- [x] " + bullet.body + eol, ""]).join("\n");
			}
			// 块末尾 = 块内**最后一条条目**的下一行；块里一条都没有就紧贴标题。
			let at = range.start + 1;
			for (let i = range.start + 1; i < range.end; i++) {
				if (todoBullet(next[i])) at = i + 1;
			}
			next.splice(at, 0, "- [x] " + bullet.body + eol);
			return next.join("\n");
		}

		/**
		 * 取消完成 = **反向搬家**：从待删除块删掉第 line 行，回到它原来所在组的末尾。
		 *
		 * 「原来在哪一组」只存在内存里（`rememberTodoOrigin`）—— 文件里不留标记，因为
		 * 那会把看板的私有状态写进用户的数据。记不住时（换了个页面 / 手写的条目）退而求其次：
		 * 第一个普通待办组的末尾，再不行就文件末尾。
		 *
		 * @param {string} originTitle 原组标题（空 = 不知道）
		 */
		function todoRestore(text, line, originTitle) {
			const src = String(text == null ? "" : text);
			const lines = src.split("\n");
			if (line < 0 || line >= lines.length) return null;
			const bullet = todoBullet(lines[line]);
			if (!bullet || bullet.indent !== "" || bullet.body === "") return null;
			const eol = todoEol(src);
			const next = lines.slice();
			next.splice(line, 1);
			const parsed = parseTodoList(next.join("\n"));
			const want = String(originTitle == null ? "" : originTitle).trim();
			const byTitle = want === "" ? null : parsed.sections.find(function (sec) {
				return sec.kind !== "done" && sec.title === want;
			});
			const fallback = byTitle || parsed.sections.find(function (sec) {
				return sec.kind === "todo" && sec.items.length > 0;
			}) || parsed.sections.find(function (sec) { return sec.kind === "todo"; });
			if (!fallback) {
				if (next.length > 0 && next[next.length - 1] === "") next.pop();
				return next.concat(["- " + bullet.body + eol, ""]).join("\n");
			}
			next.splice(fallback.insertAt, 0, "- " + bullet.body + eol);
			return next.join("\n");
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

		/**
		 * 清空「已完成，待删除」块：删掉块内**全部条目行**，`## 标题` 留着（块还要继续接下一次勾选）。
		 * @returns {{next: string|null, count: number}} count=0 → next 为 null（不白写一次盘）
		 */
		function todoClearDoneBlock(text) {
			const src = String(text == null ? "" : text);
			const lines = src.split("\n");
			const range = todoDoneRange(lines);
			if (!range) return { next: null, count: 0 };
			const hits = [];
			for (let i = range.start + 1; i < range.end; i++) {
				if (todoBullet(lines[i])) hits.push(i);
			}
			if (hits.length === 0) return { next: null, count: 0 };
			return { next: todoRemove(src, hits), count: hits.length };
		}

		/**
		 * 「这条原来在哪一组」的内存账本 —— 取消完成要靠它把条目送回原组。
		 * 只活在这个页面里（不落盘）；键是正文归一化后的文本，最多留 200 条。
		 */
		const todoOrigins = new Map();

		function rememberTodoOrigin(text, title) {
			const key = String(text == null ? "" : text).trim();
			if (key === "") return;
			if (todoOrigins.size > 200) todoOrigins.clear();
			todoOrigins.set(key, String(title == null ? "" : title));
		}

		function recallTodoOrigin(text) {
			return todoOrigins.get(String(text == null ? "" : text).trim()) || "";
		}

		// ── 视图 ──────────────────────────────────────────────────────────

		/**
		 * 撤销 / 重做图标：**内联 SVG**（不引图标库、不外链、不靠字体）。
		 * 撤销 = 一条水平基线 + 从右上绕回的弧形箭头，箭头尖在左端；重做是它的左右镜像
		 * （x → 16-x，圆弧的 sweep 反过来）。
		 * @param {"undo"|"redo"} dir
		 */
		function todoArrowIcon(dir) {
			const paths = dir === "redo"
				? ["M13.5 6.5h-7a4 4 0 0 0 0 8h3", "M10.5 3.5l3 3-3 3"]
				: ["M2.5 6.5h7a4 4 0 0 1 0 8h-3", "M5.5 3.5l-3 3 3 3"];
			return h("svg", {
				viewBox: "0 0 16 16", width: 14, height: 14, fill: "none",
				stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
				"aria-hidden": "true",
			}, paths.map(function (d, i) { return h("path", { key: "p" + i, d: d }); }));
		}

		/** 一条待办的卡片：勾选 + 标题 + 折叠正文 + 行内编辑（待删除块里还有「删除」）。 */
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
							// 「删除」只在待删除块里出现：别的位置删条目等于绕过「搬进流水」这一步。
							props.onDelete
								? h("button", { key: "d", type: "button", className: "smem-link smem-todo-mini smem-todo-del", disabled: props.busy, onClick: function () { props.onDelete(item); } }, t("todo.action.delete"))
								: null,
						]),
				]),
			]);
		}

		/** 一组（一个 `##` 节）：标题 + 计数 + 条目 + 新增框；待删除块另有「清空全部」。 */
		function TodoSectionGroup(props) {
			const sec = props.section;
			const isDone = sec.kind === "done";
			// 2.11.1（用户 2026-11-17 反馈）：**所有组默认收起**，一屏先看见「有几组、各组几条」，
			// 想看的组自己点开。原来只收「长期约束」，长清单照样一屏铺满。
			const sCollapsed = react.useState(true);
			const collapsed = sCollapsed[0], setCollapsed = sCollapsed[1];
			// 上层「全部展开 / 全部收起」：allOpen 为 null 时不管（各组各管各的）。
			react.useEffect(function () {
				if (props.allOpen === null || props.allOpen === undefined) return;
				setCollapsed(!props.allOpen);
			}, [props.allOpen]);
			const sDraft = react.useState("");
			const draft = sDraft[0], setDraft = sDraft[1];
			const openCount = sec.items.filter(function (it) { return !it.done; }).length;
			const doneCount = sec.items.length - openCount;
			// 「清空全部」清的是**整个块**（不是当前筛出来的这几条），所以按钮上的数字要取块的真实条数。
			const blockCount = typeof props.doneCount === "number" ? props.doneCount : sec.items.length;
			return h("section", { className: "smem-todo-group" + (isDone ? " smem-todo-group-done" : "") }, [
				// 标题行是**行**不是按钮：右边还要放「清空全部」，按钮套按钮在浏览器里会互相吃掉。
				h("div", { key: "head", className: "smem-todo-group-head" }, [
					h("button", {
						key: "toggle",
						type: "button",
						className: "smem-todo-group-toggle",
						onClick: function () { setCollapsed(!collapsed); },
					}, [
						h("span", { key: "chev", className: "smem-todo-chev" }, collapsed ? "▸" : "▾"),
						h("span", { key: "t", className: "smem-todo-group-title" }, sec.title || (isDone ? t("todo.doneGroup") : t(TODO_SECTION_FALLBACK))),
						h("span", { key: "n", className: "smem-todo-count" }, String(openCount) + (doneCount > 0 ? " / " + String(doneCount) : "")),
					]),
					isDone && blockCount > 0
						? h("button", {
							key: "clear",
							type: "button",
							className: "smem-todo-mini smem-todo-del",
							title: t("todo.action.clearDone", { count: blockCount }),
							disabled: props.busy,
							onClick: function () { props.onClearDone(sec); },
						}, t("todo.action.clearDone", { count: blockCount }))
						: null,
				]),
				collapsed ? null : h("div", { key: "list", className: "smem-todo-list" }, sec.items.length === 0
					? [h("div", { key: "empty", className: "smem-todo-empty" }, isDone ? t("todo.empty.done") : t("todo.empty.section"))]
					: sec.items.map(function (it) {
						return h(TodoItemRow, {
							key: "i" + it.line, item: it, busy: props.busy,
							onToggle: props.onToggle, onEdit: props.onEdit,
							onDelete: isDone ? props.onDelete : null,
						});
					})),
				// 待删除块不给「加一条」：那一块只能由勾选搬进来，手写进去等于无来源的条目。
				collapsed || isDone ? null : h("div", { key: "add", className: "smem-todo-add" }, [
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
			// 撤销 / 重做：两步栈，元素是写入前的 `{content, revision}`。只在内存里，不落盘。
			// 任何**新**写入都清空 redoStack —— 从历史里分叉出去之后，原来那条「未来」就不成立了。
			const sUndo = react.useState([]); const undoStack = sUndo[0], setUndoStack = sUndo[1];
			const sRedo = react.useState([]); const redoStack = sRedo[0], setRedoStack = sRedo[1];
			// 「全部展开」是**一次性动作**而不是持久状态：默认 null（各组按自己的默认走 = 收起）。
			const sAll = react.useState(null); const allOpen = sAll[0], setAllOpen = sAll[1];
			// 搜索：只过滤**显示**，绝不改文件；有查询时匹配的组强制展开，没匹配的组整组隐掉。
			const sQuery = react.useState(""); const rawQuery = sQuery[0], setQuery = sQuery[1];
			const query = String(rawQuery).trim().toLowerCase();

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
				// 写入前的快照先抓住：新写入一律清空 redoStack（历史分叉了）。
				const snapshot = { content: doc.content, revision: doc.revision };
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
						setUndoStack(function (prev) { return prev.concat([snapshot]).slice(-TODO_UNDO_DEPTH); });
						setRedoStack([]);
						setNotice(out.degraded ? t("todo.notice.degraded") : label);
						return load(false);
					}, function (e) { setErr(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			/**
			 * 写回一份历史快照（撤销 / 重做共用）。**只有写成功才动栈** ——
			 * 失败时界面不该显示「已经挪过一步」。
			 * @param {{content: string, revision: string|null}} target 要写回的快照
			 * @param {string} label 回执文案
			 * @param {function} onDone 成功后的栈操作
			 */
			function writeSnapshot(target, label, onDone) {
				if (!target || typeof target.content !== "string") return;
				const revision = doc.revision;
				setBusy(true); setErr(null); setNotice("");
				writeWithFallback(remote, "writeFile", [TODO_FILE, target.content], revision ? { expectedRevision: revision } : undefined, null)
					.then(function (out) {
						const r = out && (out.result || out);
						if (r && r.ok === false) {
							if (r.code === "stale_revision") { setNotice(t("todo.notice.stale")); return load(false); }
							setErr(r.error || t("todo.err.write", { error: String(r.code || "error") }));
							return;
						}
						if (typeof onDone === "function") onDone();
						setNotice(label);
						return load(false);
					}, function (e) { setErr(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			/** 当前盘上内容的快照（撤销 / 重做要把它推到另一侧的栈里）。 */
			function currentPoint() {
				return { content: doc.content, revision: doc.revision };
			}

			/**
			 * 勾选 / 取消完成：**搬家**与**反向搬家**。
			 * 勾选 → 从原组删行、追加到「已完成，待删除」块；取消 → 删掉、送回原组末尾。
			 */
			function onToggle(item, done, originTitle) {
				if (done) {
					const next = todoMoveToDone(doc.content, item.line);
					if (!next) return;
					// 记住它原来在哪一组，取消完成时靠这条回到原位（只在内存里）。
					rememberTodoOrigin(item.text, originTitle);
					mutate(t("todo.notice.movedToDone", { group: t("todo.doneGroup") }), next);
					return;
				}
				mutate(t("todo.notice.restored"), todoRestore(doc.content, item.line, recallTodoOrigin(item.text)));
			}

			function onAdd(section, body) {
				mutate(t("todo.notice.added"), todoInsert(doc.content, section.insertAt, body));
			}

			function onEdit(item, body) {
				mutate(t("todo.notice.edited"), todoReplace(doc.content, item.line, body));
			}

			/** 删掉待删除块里的一条（只删那一行）。 */
			function onDelete(item) {
				mutate(t("todo.notice.deleted"), todoRemove(doc.content, [item.line]));
			}

			/** 清空待删除块的**全部条目行**，`## 标题` 留着。 */
			function onClearDone() {
				const out = todoClearDoneBlock(doc.content);
				if (out.count === 0) return;
				mutate(t("todo.notice.cleared", { count: out.count }), out.next);
			}

			function onUndo() {
				if (undoStack.length === 0) return;
				const target = undoStack[undoStack.length - 1];
				const point = currentPoint();
				writeSnapshot(target, t("todo.notice.undo"), function () {
					setUndoStack(function (prev) { return prev.slice(0, -1); });
					setRedoStack(function (prev) { return prev.concat([point]).slice(-TODO_UNDO_DEPTH); });
				});
			}

			function onRedo() {
				if (redoStack.length === 0) return;
				const target = redoStack[redoStack.length - 1];
				const point = currentPoint();
				writeSnapshot(target, t("todo.notice.redone"), function () {
					setRedoStack(function (prev) { return prev.slice(0, -1); });
					setUndoStack(function (prev) { return prev.concat([point]).slice(-TODO_UNDO_DEPTH); });
				});
			}

			if (!enabled) {
				return h("div", { className: "smem-todo-done-state" }, [
					h("div", { key: "t", className: "smem-todo-done-title" }, t("todo.disabled.title")),
					h("div", { key: "h", className: "smem-muted" }, t("todo.disabled.hint")),
				]);
			}

			const parsed = doc && doc.parsed ? doc.parsed : parseTodoList("");
			const missing = doc && doc.missing;
			// 匹配口径：标题 + 正文 + 续行里任一处包含子串（大小写不敏感；不解释正则，免得用户被自己的输入坑）。
			const sections = query === "" ? parsed.sections : parsed.sections
				.map(function (sec) {
					const hit = sec.items.filter(function (it) {
						const hay = ((it.title || "") + " " + it.text + " " + (it.cont || "")).toLowerCase();
						return hay.indexOf(query) >= 0;
					});
					return { sec: sec, hit: hit };
				})
				.filter(function (row) { return row.hit.length > 0; })
				.map(function (row) { return Object.assign({}, row.sec, { items: row.hit }); });
			const matchCount = sections.reduce(function (n, sec) { return n + sec.items.length; }, 0);
			const stats = t("todo.stat", { open: parsed.open, done: parsed.done, sections: parsed.sections.length });
			// 「清空全部」清的是整个待删除块，数字取块的真实条数（搜索过滤后也一样）。
			const doneBlock = parsed.sections.find(function (sec) { return sec.kind === "done"; });
			const doneBlockCount = doneBlock ? doneBlock.items.length : 0;

			return h("div", { className: "smem-todo" }, [
				h("div", { key: "head", className: "smem-todo-head" }, [
					h("span", { key: "s", className: "smem-todo-stat" }, query === "" ? stats : t("todo.search.count", { count: matchCount })),
					h("span", { key: "sp", "data-spring": "" }),
					h("button", {
						key: "u", type: "button", className: "smem-todo-icon-btn",
						title: t("todo.action.undo"), "aria-label": t("todo.action.undo"),
						disabled: busy || undoStack.length === 0,
						onClick: onUndo,
					}, todoArrowIcon("undo")),
					h("button", {
						key: "d", type: "button", className: "smem-todo-icon-btn",
						title: t("todo.action.redo"), "aria-label": t("todo.action.redo"),
						disabled: busy || redoStack.length === 0,
						onClick: onRedo,
					}, todoArrowIcon("redo")),
					h("button", { key: "a", type: "button", className: "smem-link smem-todo-mini", onClick: function () { setAllOpen(allOpen === true ? false : true); } }, allOpen === true ? t("todo.collapseAll") : t("todo.expandAll")),
					h("button", { key: "r", type: "button", className: "smem-link smem-todo-mini", disabled: busy, onClick: function () { load(false); } }, t("todo.refresh")),
				]),
				// 搜索框放统计条下面一行：右栏很窄，塞进同一行会把按钮挤没。
				h("div", { key: "search", className: "smem-todo-search-row" }, [
					h("input", {
						key: "q",
						className: "smem-input smem-todo-search",
						type: "search",
						placeholder: t("todo.search.placeholder"),
						value: rawQuery,
						onChange: function (e) { setQuery(e.target.value); },
					}),
					rawQuery === "" ? null : h("button", { key: "x", type: "button", className: "smem-link smem-todo-mini", onClick: function () { setQuery(""); } }, t("todo.action.cancel")),
				]),
				err ? h("div", { key: "err", className: "smem-err" }, "⚠ " + err) : null,
				notice ? h("div", { key: "ok", className: "smem-ok" }, "✓ " + notice) : null,
				missing
					? h("div", { key: "miss", className: "smem-todo-empty" }, t("todo.empty.file", { file: TODO_FILE }))
					: (query !== "" && sections.length === 0
						? h("div", { key: "nomatch", className: "smem-todo-empty" }, t("todo.search.none"))
						: h("div", { key: "groups", className: "smem-todo-groups" }, sections.map(function (sec, i) {
							return h(TodoSectionGroup, {
								key: "s" + i, section: sec, busy: busy, allOpen: query === "" ? allOpen : true,
								doneCount: doneBlockCount,
								onToggle: function (it, d) { onToggle(it, d, sec.title); },
								onAdd: onAdd, onEdit: onEdit, onDelete: onDelete, onClearDone: onClearDone,
							});
						}))),
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
			DONE_HEADING: TODO_DONE_HEADING,
			UNDO_DEPTH: TODO_UNDO_DEPTH,
			parse: parseTodoList,
			titleOf: todoItemTitle,
			bullet: todoBullet,
			doneRange: todoDoneRange,
			moveToDone: todoMoveToDone,
			restore: todoRestore,
			insert: todoInsert,
			replace: todoReplace,
			remove: todoRemove,
			clearDoneBlock: todoClearDoneBlock,
			rememberOrigin: rememberTodoOrigin,
			recallOrigin: recallTodoOrigin,
			arrowIcon: todoArrowIcon,
			isEnabled: function () { return todoBoardEnabled; },
			notify: todoBoardNotify,
		};
