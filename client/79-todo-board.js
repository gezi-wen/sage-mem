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
		/**
		 * 撤销 / 重做步数（2.15.0 起可配 3–5，默认 5）。
		 * 栈本身**只在内存里**（关页面即失效）；落 localStorage 的只有「用户选了几步」这个偏好。
		 */
		const TODO_UNDO_DEFAULT = 5;
		const TODO_UNDO_MIN = 3;
		const TODO_UNDO_MAX = 5;
		/** 偏好键：撤销步数 / 各组展开状态。localStorage 本身就按 origin 隔离。 */
		const TODO_PREF_UNDO = "sage-mem.todo.undoDepth";
		const TODO_PREF_OPEN = "sage-mem.todo.openGroups";
		/** 筛选两档：默认只看未完成；`全部`才把旧文件里遗留的 `- [x]` 行也画出来。 */
		const TODO_FILTER_OPEN = "open";
		const TODO_FILTER_ALL = "all";
		/** 完成项留档的落点：跨会话流水（保留名，走 readRaw / writeRaw）。 */
		const TODO_LOG_FILE = "session-log.md";

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

		// ── 本地偏好（2.15.0）：只存「用户怎么选的」，不存任何清单内容 ──────────
		//
		// 纪律与「不建自己的存储」一致：清单的唯一真相仍是那份 markdown。
		// 这里存的只有两件纯界面偏好 —— 撤销留几步、哪几组是展开的。
		// 读不到（隐私模式 / 配额满 / 无 DOM 的测试环境）一律按默认走，**不报错**。

		function todoStore() {
			try {
				if (typeof localStorage === "undefined" || localStorage === null) return null;
				return localStorage;
			} catch (e) { return null; }
		}

		function todoPrefGet(key) {
			const s = todoStore();
			if (!s || typeof s.getItem !== "function") return null;
			try { return s.getItem(key); } catch (e) { return null; }
		}

		function todoPrefSet(key, value) {
			const s = todoStore();
			if (!s || typeof s.setItem !== "function") return;
			try { s.setItem(key, value); } catch (e) { /* 偏好丢了不影响主流程 */ }
		}

		/** 撤销步数归一：非数字 / 越界都收进 [3, 5]，坏值（含 null / 空串）回默认 5。 */
		function todoClampUndoDepth(n) {
			if (n === null || n === undefined || n === "") return TODO_UNDO_DEFAULT;
			const v = Math.round(Number(n));
			if (!Number.isFinite(v)) return TODO_UNDO_DEFAULT;
			return Math.min(TODO_UNDO_MAX, Math.max(TODO_UNDO_MIN, v));
		}

		/** 组展开偏好的键：就是节标题原文（空标题用同一个兜底键）。 */
		function todoGroupKey(title) {
			return String(title == null ? "" : title);
		}

		/**
		 * 解析 `{组标题: true|false}` 偏好。坏 JSON、数组、别的类型一律当「没有偏好」——
		 * 于是所有组回到默认（收起），而不是让整块看板因为一行坏数据打不开。
		 * @returns {Object<string, boolean>}
		 */
		function todoOpenMapParse(raw) {
			const out = Object.create(null);
			let value = null;
			try { value = JSON.parse(String(raw == null ? "" : raw)); } catch (e) { return out; }
			if (!value || typeof value !== "object" || Array.isArray(value)) return out;
			Object.keys(value).forEach(function (k) {
				if (value[k] === true || value[k] === false) out[k] = value[k];
			});
			return out;
		}

		/** 序列化展开偏好（只留布尔值，别的键丢掉）。 */
		function todoOpenMapSerialize(map) {
			const out = {};
			Object.keys(map || {}).forEach(function (k) {
				if (map[k] === true || map[k] === false) out[k] = map[k];
			});
			try { return JSON.stringify(out); } catch (e) { return "{}"; }
		}

		/**
		 * 筛选：`open` 档只留未完成（待删除块里的条目照旧显示 —— 它是**队列**，
		 * 不是「已完成的历史」，藏起来就没法清空 / 留档了）。
		 */
		function todoFilterItems(items, filter) {
			const list = items || [];
			if (filter === TODO_FILTER_ALL) return list;
			return list.filter(function (it) { return !it.done || it.inDone; });
		}

		/** 比较用的归一化正文：连续空白压成一个空格、去首尾。 */
		function todoLogKey(text) {
			return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
		}

		/** 流水里已经记过的条目正文（归一化后）。用于「重复点一次不会写两遍」。 */
		function todoLogKeys(logText) {
			const set = new Set();
			String(logText == null ? "" : logText).split(/\r?\n/).forEach(function (line) {
				const m = /^\s*[-*+]\s+(.*)$/.exec(line);
				if (m && m[1].trim() !== "") set.add(todoLogKey(m[1]));
			});
			return set;
		}

		/** `YYYY-MM-DD HH:mm`（本地时区；流水的人读时间，不用 UTC）。 */
		function todoStamp(now) {
			const d = now instanceof Date ? now : new Date();
			const p = function (n) { return String(n).padStart(2, "0"); };
			return String(d.getFullYear()) + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
				" " + p(d.getHours()) + ":" + p(d.getMinutes());
		}

		/**
		 * 把待删除块里的条目拼成一段流水（纯函数，不碰 IO、不改入参）。
		 *
		 * **逐字照抄条目正文**，不改写成概括 —— 2.14.0 做归档时那条纪律同样适用：
		 * 概化过的流水半年后没人能据此复现。已经在流水里记过的（`existingKeys`）跳过，
		 * 于是「上次写了一半」的失败可以安全重试。
		 *
		 * @param {Array<object>} items 待删除块里的条目（`text` 已剥掉 `[x]`）
		 * @param {Date} now 时间戳
		 * @param {Set<string>} [existingKeys] 流水里已有的正文键
		 * @returns {{text: string, bodies: string[], count: number}}
		 */
		function todoArchiveBlock(items, now, existingKeys) {
			const keys = existingKeys || new Set();
			const seen = new Set();
			const bodies = [];
			(items || []).forEach(function (it) {
				const body = String(it && it.text != null ? it.text : "").trim();
				if (body === "") return;
				const key = todoLogKey(body);
				if (keys.has(key) || seen.has(key)) return;
				seen.add(key);
				bodies.push(body);
			});
			if (bodies.length === 0) return { text: "", bodies: [], count: 0 };
			const head = "## " + todoStamp(now) + " · 待办收尾（" + String(bodies.length) + " 条）";
			const lines = [
				head,
				"",
				// ⚠️ 这两处字面量进的是**文件内容**（流水），不跟界面语言走 —— 与 TODO_DONE_HEADING 同理。
				"**来源**：`" + TODO_FILE + "` 的「已完成，待删除」块，由待办看板搬入（正文照抄）。",
				"",
			].concat(bodies.map(function (b) { return "- " + b; }));
			return { text: lines.join("\n"), bodies: bodies, count: bodies.length };
		}

		/**
		 * 把一段流水接到已有内容末尾：保证「原有内容不动 + 空一行 + 新段 + 以换行结尾」。
		 *
		 * ⚠️ 按**行**拼，别在 `"\r\n"` 后面再补一个裸 `"\r"` —— CRLF 文件会被拼出
		 * `"\r\n\r"` 这种既不是 CRLF 也不是 LF 的东西（2.15.0 的第一版就踩了这条）。
		 */
		function todoSessionLogAppend(logText, blockText) {
			const src = String(logText == null ? "" : logText);
			const block = String(blockText == null ? "" : blockText);
			if (block === "") return src;
			const eol = todoEol(src);
			const out = src === "" ? [] : src.split("\n");
			// `split` 的末尾空串代表「文件以换行结尾」，不是一行内容。
			if (out.length > 0 && out[out.length - 1] === "") out.pop();
			const body = block.split("\n").filter(function (line, i, arr) {
				return !(line === "" && i === arr.length - 1);
			});
			if (out.length > 0) out.push(eol);
			body.forEach(function (line) { out.push(line + eol); });
			out.push("");
			return out.join("\n");
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
					// 2.15.1：**「长期约束」不算未完成**。那一节的标题自己写着「不是待办」，
					// 把它计入「N 条未完成」既骗人又和标题冲突（真机截图里 30 条里有 8 条是约束）。
					// 已完成计数不受影响：待删除块里的条目本来就是 done。
					if (item.done) done += 1; else if (current.kind !== "constraint") open += 1;
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

		/** 一组（一个 `##` 节）：标题 + 计数 + 条目 + 新增框；待删除块另有「清空 / 搬进流水」。 */
		function TodoSectionGroup(props) {
			const sec = props.section;
			const isDone = sec.kind === "done";
			// 2.11.1（用户 2026-11-17 反馈）：**所有组默认收起**，一屏先看见「有几组、各组几条」，
			// 想看的组自己点开。原来只收「长期约束」，长清单照样一屏铺满。
			// 2.15.0：**记住用户点开过哪几组**（localStorage，按节标题）。默认仍收起。
			const key = todoGroupKey(sec.title);
			const sCollapsed = react.useState(function () {
				const map = props.openMap || {};
				return map[key] !== true;
			});
			const collapsed = sCollapsed[0], setCollapsed = sCollapsed[1];
			// 上层「全部展开 / 全部收起」：一次性动作，**不写偏好**（写了就变成「永远全展开」）。
			react.useEffect(function () {
				if (props.allOpen === null || props.allOpen === undefined) return;
				setCollapsed(!props.allOpen);
			}, [props.allOpen]);
			function toggleGroup() {
				// 点一下 = 把「收起」反过来；记进偏好的是**点击后的展开态**（不是「收起态」）。
				const nextOpen = collapsed;
				setCollapsed(!collapsed);
				if (typeof props.onGroupToggle === "function") props.onGroupToggle(key, nextOpen);
			}
			const sDraft = react.useState("");
			const draft = sDraft[0], setDraft = sDraft[1];
			// 2.15.1：「搬进流水」两步确认 —— 它不可撤销（流水那半撤不回来），
			// 点一下就把记忆流水写掉、清单行删掉，不该是一次误触就能完成的动作。
			const sConfirm = react.useState(false);
			const confirming = sConfirm[0], setConfirming = sConfirm[1];
			react.useEffect(function () {
				// 块被清空 / 换了一份文件时，别让确认态悬着。
				if (blockCountRaw() === 0) setConfirming(false);
			}, [props.doneCount, sec.items.length]);
			function blockCountRaw() {
				return typeof props.doneCount === "number" ? props.doneCount : sec.items.length;
			}
			const openCount = sec.items.filter(function (it) { return !it.done; }).length;
			const doneCount = sec.items.length - openCount;
			// 「清空全部」清的是**整个块**（不是当前筛出来的这几条），所以按钮上的数字要取块的真实条数。
			const blockCount = blockCountRaw();
			// 2.15.1：待删除块里没有「未完成」，别画那个永远是 0 的「0 / N」。
			const countText = isDone ? String(doneCount || blockCount) : String(openCount) + (doneCount > 0 ? " / " + String(doneCount) : "");
			return h("section", { className: "smem-todo-group" + (isDone ? " smem-todo-group-done" : "") }, [
				// 标题行是**行**不是按钮：右边还要放「清空全部」，按钮套按钮在浏览器里会互相吃掉。
				h("div", { key: "head", className: "smem-todo-group-head" }, [
					h("button", {
						key: "toggle",
						type: "button",
						className: "smem-todo-group-toggle",
						onClick: toggleGroup,
					}, [
						h("span", { key: "chev", className: "smem-todo-chev" }, collapsed ? "▸" : "▾"),
						h("span", { key: "t", className: "smem-todo-group-title" }, sec.title || (isDone ? t("todo.doneGroup") : t(TODO_SECTION_FALLBACK))),
						h("span", { key: "n", className: "smem-todo-count" }, countText),
					]),
					isDone && blockCount > 0
						? (confirming
							? h("button", {
								key: "archiveConfirm",
								type: "button",
								className: "smem-todo-mini smem-todo-archive smem-todo-del",
								title: t("todo.action.archiveConfirm.title", { count: blockCount, file: TODO_LOG_FILE }),
								disabled: props.busy,
								onClick: function () { setConfirming(false); props.onArchive(sec); },
							}, t("todo.action.archiveConfirm", { count: blockCount }))
							: h("button", {
								key: "archive",
								type: "button",
								className: "smem-todo-mini smem-todo-archive",
								title: t("todo.action.archive", { count: blockCount, file: TODO_LOG_FILE }),
								disabled: props.busy,
								onClick: function () { setConfirming(true); },
							}, t("todo.action.archive", { count: blockCount, file: TODO_LOG_FILE })))
						: null,
					isDone && blockCount > 0 && confirming
						? h("button", {
							key: "archiveCancel",
							type: "button",
							className: "smem-todo-mini",
							disabled: props.busy,
							onClick: function () { setConfirming(false); },
						}, t("todo.action.cancel"))
						: null,
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

		/**
		 * 检查点聚合（2.15.0）—— **只读**。
		 *
		 * 把 `<状态根>/tasks/<id>/WORKING.md` 的「未完成」节并到清单上方显示。
		 * **不合并写入**：那些条目在别的文件里、有自己的 revision 与写协议，
		 * 看板只负责让人看见「还有哪些任务没收尾」，动手改仍然回到那份检查点。
		 * 老宿主的 remote 上没有 `checkpoints`，于是整块不出现（不是显示一个空壳）。
		 */
		function TodoCheckpointBlock(props) {
			const sOpen = react.useState(false);
			const open = sOpen[0], setOpen = sOpen[1];
			const tasks = props.tasks || [];
			return h("section", { className: "smem-todo-group smem-todo-group-cp" }, [
				h("div", { key: "head", className: "smem-todo-group-head" }, [
					h("button", {
						key: "toggle",
						type: "button",
						className: "smem-todo-group-toggle",
						title: t("todo.cp.title"),
						onClick: function () { setOpen(!open); },
					}, [
						h("span", { key: "chev", className: "smem-todo-chev" }, open ? "▾" : "▸"),
						h("span", { key: "t", className: "smem-todo-group-title" }, t("todo.cp.title")),
						h("span", { key: "n", className: "smem-todo-count" }, String(props.count || 0)),
					]),
				]),
				open ? h("div", { key: "list", className: "smem-todo-list" }, tasks.map(function (task) {
					const id = String(task && task.taskId ? task.taskId : "");
					const label = task && task.project ? String(task.project) + " · " + id : id;
					return h("div", { key: "t" + id, className: "smem-todo-cp-task" }, [
						h("div", { key: "h", className: "smem-todo-cp-head" }, label),
						h("div", { key: "i", className: "smem-todo-cp-items" }, (task.items || []).map(function (txt, i) {
							return h("div", { key: "x" + i, className: "smem-todo-cp-item" }, todoInline(String(txt)));
						})),
					]);
				})) : null,
				open ? h("div", { key: "note", className: "smem-todo-cp-note" }, t("todo.cp.note")) : null,
				// 2.15.2：宿主说了「被截断 / 有任务读不出来」就必须说出来 ——
				// 只说「检查点里的未完成」而不提这两件事，等于把不完整的清单当完整的给。
				props.truncated ? h("div", { key: "trunc", className: "smem-todo-cp-note" }, t("todo.cp.truncated")) : null,
				props.skipped > 0 ? h("div", { key: "skip", className: "smem-todo-cp-note" }, t("todo.cp.skipped", { count: props.skipped })) : null,
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
			// 撤销 / 重做：元素是写入前的 `{content, revision}`。栈**只在内存里**，
			// 深度 3–5 可配（偏好落 localStorage）；任何**新**写入都清空 redoStack —— 历史分叉了。
			const sDepth = react.useState(function () { return todoClampUndoDepth(todoPrefGet(TODO_PREF_UNDO)); });
			const undoDepth = sDepth[0], setUndoDepth = sDepth[1];
			const sUndo = react.useState([]); const undoStack = sUndo[0], setUndoStack = sUndo[1];
			const sRedo = react.useState([]); const redoStack = sRedo[0], setRedoStack = sRedo[1];
			// 「全部展开」是**一次性动作**而不是持久状态：默认 null（各组按自己的默认走）。
			const sAll = react.useState(null); const allOpen = sAll[0], setAllOpen = sAll[1];
			// 各组展开偏好（2.15.0）：`{节标题: true|false}`，点开/收起就写回 localStorage。
			const sOpenMap = react.useState(function () { return todoOpenMapParse(todoPrefGet(TODO_PREF_OPEN)); });
			const openMap = sOpenMap[0], setOpenMap = sOpenMap[1];
			// 筛选：默认只看未完成（旧文件里遗留的 `- [x]` 行要先点「全部」才出现）。
			const sFilter = react.useState(TODO_FILTER_OPEN); const filter = sFilter[0], setFilter = sFilter[1];
			// 搜索：只过滤**显示**，绝不改文件；有查询时匹配的组强制展开，没匹配的组整组隐掉。
			const sQuery = react.useState(""); const rawQuery = sQuery[0], setQuery = sQuery[1];
			const query = String(rawQuery).trim().toLowerCase();
			// 检查点聚合（2.15.0，只读）：老宿主没有 memory/checkpoints，读到就藏起来。
			const sCps = react.useState(null); const checkpoints = sCps[0], setCheckpoints = sCps[1];

			/** 读一次检查点（宿主没这个方法就保持 null，界面上整块不出现）。 */
			const loadCheckpoints = react.useCallback(function () {
				if (!remote || typeof remote.checkpoints !== "function") return;
				Promise.resolve(remote.checkpoints()).then(function (res) {
					const data = unwrap(res);
					if (!data || data.ok === false) { setCheckpoints(null); return; }
					// 2.15.2：把「被截断」与「读不出来被跳过」也带上 —— 否则面板说的「完整」是假的。
					setCheckpoints({
						tasks: Array.isArray(data.tasks) ? data.tasks : [],
						truncated: data.truncated === true,
						skipped: typeof data.skipped === "number" ? data.skipped : 0,
					});
				}, function () { /* 读不到就不显示，别在清单旁边堆一条错误 */ });
			}, [remote]);

			function toggleGroupPref(title, next) {
				const map = Object.assign({}, openMap);
				map[title] = next;
				setOpenMap(map);
				todoPrefSet(TODO_PREF_OPEN, todoOpenMapSerialize(map));
			}

			/** 改撤销步数：写偏好 + 立刻把两份栈裁到新深度（否则旧的深栈还能退回去）。 */
			function changeDepth(n) {
				const next = todoClampUndoDepth(n);
				setUndoDepth(next);
				todoPrefSet(TODO_PREF_UNDO, String(next));
				setUndoStack(function (prev) { return prev.slice(-next); });
				setRedoStack(function (prev) { return prev.slice(-next); });
			}

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

			// 检查点聚合（只读）：进页签读一次；点刷新再读（别的会话可能刚写过 WORKING.md）。
			react.useEffect(function () { loadCheckpoints(); }, [loadCheckpoints]);

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
						setUndoStack(function (prev) { return prev.concat([snapshot]).slice(-undoDepth); });
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

			/**
			 * 「搬进流水」：把待删除块里的条目搬进跨会话流水（2.15.0）。
			 *
			 * 两次写盘，顺序是刻意的：**先追加流水、再从清单删行**。反过来做，第二步失败就真丢条目；
			 * 这样失败最多在流水里留一份重复，而重复由正文去重挡住（所以重试是安全的）。
			 * 也正因为流水那半没法撤回，搬完**清空撤销栈** —— 留着一个「撤销」只会骗人。
			 */
			async function onArchive(section) {
				const items = (section && section.items) || [];
				if (items.length === 0) return;
				if (!remote || typeof remote.readRaw !== "function" || typeof remote.writeRaw !== "function") {
					setErr(t("todo.err.noArchive"));
					return;
				}
				const revision = doc.revision;
				const fileContent = doc.content;
				setBusy(true); setErr(null); setNotice("");
				let logged = 0;
				try {
					let content = "";
					let logRev = null;
					const log = unwrap(await remote.readRaw(TODO_LOG_FILE));
					if (log && log.ok === false) {
						// 新库还没有流水：当空文件起头。别的读失败照旧报（别把「读坏了」当成「还没有」）。
						if (!/missing|not.?found|enoent/i.test(String(log.code || ""))) {
							throw new Error(log.error || String(log.code || "error"));
						}
					} else {
						content = (log && log.content) || "";
						logRev = log && typeof log.revision === "string" ? log.revision : null;
					}
					const block = todoArchiveBlock(items, new Date(), todoLogKeys(content));
					if (block.count > 0) {
						const next = todoSessionLogAppend(content, block.text);
						const out = await remote.writeRaw(TODO_LOG_FILE, next, logRev ? { expectedRevision: logRev } : undefined);
						const r = out && (out.result || out);
						if (r && r.ok === false) throw new Error(r.error || String(r.code || "error"));
						logged = block.count;
					}
					const nextTodo = todoRemove(fileContent, items.map(function (it) { return it.line; }));
					const out2 = await writeWithFallback(remote, "writeFile", [TODO_FILE, nextTodo], revision ? { expectedRevision: revision } : undefined, null);
					const r2 = out2 && (out2.result || out2);
					if (r2 && r2.ok === false) {
						if (r2.code === "stale_revision") {
							setNotice(t("todo.notice.archiveStale", { count: logged }));
							await load(false);
							return;
						}
						throw new Error(r2.error || String(r2.code || "error"));
					}
					setUndoStack([]); setRedoStack([]);
					setNotice(logged > 0
						? t("todo.notice.archived", { count: logged, file: TODO_LOG_FILE })
						: t("todo.notice.archivedDup", { file: TODO_LOG_FILE }));
					await load(false);
				} catch (e) {
					setErr(t("todo.err.archive", { error: String((e && e.message) || e) }));
				} finally {
					setBusy(false);
				}
			}

			function onUndo() {
				if (undoStack.length === 0) return;
				const target = undoStack[undoStack.length - 1];
				const point = currentPoint();
				writeSnapshot(target, t("todo.notice.undo"), function () {
					setUndoStack(function (prev) { return prev.slice(0, -1); });
					setRedoStack(function (prev) { return prev.concat([point]).slice(-undoDepth); });
				});
			}

			function onRedo() {
				if (redoStack.length === 0) return;
				const target = redoStack[redoStack.length - 1];
				const point = currentPoint();
				writeSnapshot(target, t("todo.notice.redone"), function () {
					setRedoStack(function (prev) { return prev.slice(0, -1); });
					setUndoStack(function (prev) { return prev.concat([point]).slice(-undoDepth); });
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
			// 两道过滤，顺序固定：先按「未完成 / 全部」筛条目，再按搜索词筛。都只影响**显示**。
			// 匹配口径：标题 + 正文 + 续行里任一处包含子串（大小写不敏感；不解释正则，免得用户被自己的输入坑）。
			const filtered = parsed.sections
				.map(function (sec) {
					const kept = todoFilterItems(sec.items, filter);
					const hit = query === "" ? kept : kept.filter(function (it) {
						const hay = ((it.title || "") + " " + it.text + " " + (it.cont || "")).toLowerCase();
						return hay.indexOf(query) >= 0;
					});
					return { sec: sec, kept: kept, hit: hit };
				})
				.filter(function (row) {
					// 空组：搜索时整组隐掉；只筛「未完成」时，普通组没剩条目也隐掉
					// （否则一屏「▸ 组名 0 / 3」的空壳），待删除块例外 —— 见 todoFilterItems 的注释。
					if (row.sec.kind === "done") return true;
					if (row.hit.length > 0) return true;
					return row.sec.items.length === 0 && query === "";
				})
				.map(function (row) { return Object.assign({}, row.sec, { items: row.hit }); });
			const sections = filtered;
			const matchCount = sections.reduce(function (n, sec) { return n + sec.items.length; }, 0);
			const stats = t("todo.stat", { open: parsed.open, done: parsed.done, sections: parsed.sections.length });
			// 「清空全部」清的是整个待删除块，数字取块的真实条数（搜索过滤后也一样）。
			const doneBlock = parsed.sections.find(function (sec) { return sec.kind === "done"; });
			const doneBlockCount = doneBlock ? doneBlock.items.length : 0;
			// 检查点区块的条目总数（只读，来自 tasks/*/WORKING.md）。
			const cpTasks = ((checkpoints && checkpoints.tasks) || []).filter(function (task) {
				return task && Array.isArray(task.items) && task.items.length > 0;
			});
			const cpCount = cpTasks.reduce(function (n, task) { return n + task.items.length; }, 0);
			const cpTruncated = !!(checkpoints && checkpoints.truncated);
			const cpSkipped = (checkpoints && checkpoints.skipped) || 0;

			return h("div", { className: "smem-todo" }, [
				h("div", { key: "head", className: "smem-todo-head" }, [
					h("span", { key: "s", className: "smem-todo-stat" }, query === "" ? stats : t("todo.search.count", { count: matchCount })),
					h("span", { key: "sp", "data-spring": "" }),
					h("button", {
						key: "u", type: "button", className: "smem-todo-icon-btn",
						title: t("todo.action.undoTitle", { depth: undoDepth }), "aria-label": t("todo.action.undo"),
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
					h("button", { key: "r", type: "button", className: "smem-link smem-todo-mini", disabled: busy, onClick: function () { load(false); loadCheckpoints(); } }, t("todo.refresh")),
				]),
				// 第二行：筛选 + 撤销步数。右栏很窄，搜索框单独一行。
				h("div", { key: "tools", className: "smem-todo-tools" }, [
					h("button", {
						key: "f1", type: "button",
						className: "smem-todo-mini smem-todo-filter" + (filter === TODO_FILTER_OPEN ? " smem-todo-filter-on" : ""),
						title: t("todo.filter.openTitle"), "aria-pressed": filter === TODO_FILTER_OPEN,
						onClick: function () { setFilter(TODO_FILTER_OPEN); },
					}, t("todo.filter.open")),
					h("button", {
						key: "f2", type: "button",
						className: "smem-todo-mini smem-todo-filter" + (filter === TODO_FILTER_ALL ? " smem-todo-filter-on" : ""),
						title: t("todo.filter.allTitle"), "aria-pressed": filter === TODO_FILTER_ALL,
						onClick: function () { setFilter(TODO_FILTER_ALL); },
					}, t("todo.filter.all")),
					h("span", { key: "sp2", "data-spring": "" }),
					h("label", { key: "dep", className: "smem-todo-depth" }, [
						h("span", { key: "l", className: "smem-todo-depth-label" }, t("todo.undoDepth.label")),
						h("select", {
							key: "sel",
							className: "smem-input smem-todo-depth-select",
							value: String(undoDepth),
							disabled: busy,
							onChange: function (e) { changeDepth(e.target.value); },
						}, [TODO_UNDO_MIN, TODO_UNDO_MIN + 1, TODO_UNDO_MAX].map(function (n) {
							return h("option", { key: "o" + n, value: String(n) }, t("todo.undoDepth.option", { n: n }));
						})),
					]),
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
				cpCount > 0
					? h(TodoCheckpointBlock, { key: "cp", tasks: cpTasks, count: cpCount, truncated: cpTruncated, skipped: cpSkipped })
					: null,
				missing
					? h("div", { key: "miss", className: "smem-todo-empty" }, t("todo.empty.file", { file: TODO_FILE }))
					: (query !== "" && sections.length === 0
						? h("div", { key: "nomatch", className: "smem-todo-empty" }, t("todo.search.none"))
						: h("div", { key: "groups", className: "smem-todo-groups" }, sections.map(function (sec, i) {
							return h(TodoSectionGroup, {
								key: "s" + i, section: sec, busy: busy, allOpen: query === "" ? allOpen : true,
								doneCount: doneBlockCount,
								openMap: openMap,
								onGroupToggle: toggleGroupPref,
								onToggle: function (it, d) { onToggle(it, d, sec.title); },
								onAdd: onAdd, onEdit: onEdit, onDelete: onDelete,
								onClearDone: onClearDone, onArchive: onArchive,
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
			LOG_FILE: TODO_LOG_FILE,
			TAB_KIND: TODO_TAB_KIND,
			DONE_HEADING: TODO_DONE_HEADING,
			UNDO_MIN: TODO_UNDO_MIN,
			UNDO_MAX: TODO_UNDO_MAX,
			UNDO_DEFAULT: TODO_UNDO_DEFAULT,
			FILTER_OPEN: TODO_FILTER_OPEN,
			FILTER_ALL: TODO_FILTER_ALL,
			PREF_UNDO: TODO_PREF_UNDO,
			PREF_OPEN: TODO_PREF_OPEN,
			clampDepth: todoClampUndoDepth,
			filterItems: todoFilterItems,
			groupKey: todoGroupKey,
			openMapParse: todoOpenMapParse,
			openMapSerialize: todoOpenMapSerialize,
			logKey: todoLogKey,
			logKeys: todoLogKeys,
			stamp: todoStamp,
			archiveBlock: todoArchiveBlock,
			logAppend: todoSessionLogAppend,
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
