		/**
		 * 「不参与整理的文件」勾选面板（2.10.1 体积治理 · 契约 §6）。
		 *
		 * 这一块原来是「一行说明 + 一个输名字的输入框」（自动做梦 → 设置 → 保留名保护名单）。
		 * 名单当时只有一个作用：注入时跳过。手输名字够用，因为写错了的后果只是「多注入一条」。
		 * 2.10.1 起它多了一层作用 —— 自动做梦的体积治理与 `trim_memory` **都按这份名单跳过**，
		 * 于是 `project_note.md` / `project_notes.md` 这种一位之差从「无害」变成「该保护的那条
		 * 被裁了，而你当时以为自己写了」。结论：名字不该靠手打，要从**目录里现成的文件名**里勾。
		 *
		 * 界面上每句话都对应一条事实，不是修饰：
		 *   1. 两个内置名（索引 / 流水）**不可取消** —— 它们各有自己的规则，取消保护只会让
		 *      「被当作普通记忆处理」成为可能。
		 *   2. 保存后**要重启 DSH** —— 名单在模块加载时读进内存（宿主的 `RESERVED_FILES`），
		 *      写盘只是写盘。界面上永远不写「已生效」。
		 *   3. 宿主没有设置接口时**只读、换文案、不报错** —— 旧宿主不该因为少一个接口就红一片。
		 *
		 * 状态只有一份，且**放在宿主里**（`AutodreamPanel` 的 `tidyState`，见 60 分片）：
		 * chips、「加入名单」输入框、勾选框画的全是同一份选择，所以不会出现
		 * 「chips 说勾着、框里没勾」。这也是本仓库既有的分工 —— `72-files-view.js` 就是
		 * 「纯渲染，状态在上层」。这个分片因此**不持有任何 hook**：它只把 props 画出来，
		 * 把动作交给 `onState` / `onSettings`。
		 *
		 * 「选择」用**增量**表达（`add` / `drop` 两个数组，相对宿主已保存的 `reservedExtra`）：
		 * 这样保存成功后把两个数组清空就等于「已对齐」，不需要第三个影子状态去同步，
		 * 也就没有「同步晚一拍」的那类 bug。
		 */

		/** 名字比较键：大小写无关（Windows 上 `MEMORY.md` 与 `memory.md` 是同一个文件）。 */
		function tidyKey(name) {
			return String(name == null ? "" : name).toLowerCase();
		}

		/**
		 * 归一化一份名字列表：去空、去重（大小写无关）、保序。
		 * 宿主那边也会做同样的事；这里做是为了「勾选 → 保存 → 回执校验」三处用同一把尺子。
		 */
		function tidyList(v) {
			const out = [];
			const seen = {};
			(Array.isArray(v) ? v : []).forEach(function (x) {
				const s = String(x == null ? "" : x).trim();
				if (!s) return;
				const k = tidyKey(s);
				if (seen[k]) return;
				seen[k] = true;
				out.push(s);
			});
			return out;
		}

		/**
		 * 勾选列表的行：内置 → 目录里的文件 → 已声明但文件已不在的。
		 *
		 * 顺序固定是**有意的**：勾一个文件不该让它在列表里换位置（那会让人以为点错了）。
		 * 「已声明但文件已不在」的单列一类 —— 名单里留着一个不存在的名字是合法的
		 * （文件是后来被改名 / 归档的），但必须看得出来，否则用户永远查不出「为什么没保护上」。
		 */
		function tidyRows(fixed, names, files) {
			const rows = [];
			const seen = {};
			const push = function (name, kind, meta) {
				const k = tidyKey(name);
				if (!k || seen[k]) return;
				seen[k] = true;
				rows.push({ name: String(name), kind: kind, meta: meta || null });
			};
			fixed.forEach(function (n) { push(n, "fixed", null); });
			files.forEach(function (f) { if (f && f.file) push(f.file, "file", f); });
			// 用户声明的（含本趟新勾的）——已在上面出现过的不再重复
			tidyList(names).forEach(function (n) { push(n, "extra", null); });
			return rows;
		}

		function TidyScopePanel(props) {
			const memRemote = stableRemote(props.ctx, "remote.memory");
			const settings = props.settings || null;
			// 宿主里那份界面状态（`{}` 兜底：空 / 旧值都当「什么都没做」）。
			const view = props.state && typeof props.state === "object" ? props.state : {};
			const patch = function (p) {
				if (typeof props.onState === "function") props.onState(Object.assign({}, view, p));
			};

			// 能力分两层（与设置页其它块同一条）：整个 remote 没有 / 只有读没有写。
			const canRead = !!(memRemote && typeof memRemote.getSettings === "function");
			const canWrite = !!(memRemote && typeof memRemote.setSettings === "function");

			// 每个字段都重新认一遍类型：这是「渲染不得抛」的最后一道（host 回执 / 旧状态都可能歪）。
			const files = Array.isArray(view.files) ? view.files : [];
			const query = typeof view.query === "string" ? view.query : "";
			const newName = typeof view.newName === "string" ? view.newName : "";
			const err = typeof view.err === "string" && view.err ? view.err : null;
			const notice = typeof view.notice === "string" && view.notice ? view.notice : null;
			const busy = view.busy === true;
			const add = tidyList(view.add);
			const drop = (Array.isArray(view.drop) ? view.drop : []).map(tidyKey);

			const extras = tidyList(settings && settings.reservedExtra);
			const extraKeys = extras.map(tidyKey);
			// 内置名 = 生效名单里不属于「用户声明」的那些。**不写死两个名字**：
			// 宿主改了名字 / 多了一个内置名，这里跟着变。
			const fixed = tidyList(settings && settings.reserved).filter(function (n) {
				return extraKeys.indexOf(tidyKey(n)) < 0;
			});
			// 当前选择 = 已保存的名单 - 本趟取消的 + 本趟勾上的。
			const selected = tidyList(extras.filter(function (n) {
				return drop.indexOf(tidyKey(n)) < 0;
			}).concat(add));
			const selectedKey = selected.slice().sort().join(",");
			const rows = tidyRows(fixed, selected, files);
			const q = String(query || "").trim().toLowerCase();
			// 搜索只筛「可勾的那些」：内置名恒定显示 —— 它们不是搜索结果，是这一块的前提。
			const shown = rows.filter(function (r) {
				return r.kind === "fixed" || !q || r.name.toLowerCase().indexOf(q) >= 0;
			});
			const picked = fixed.length + selected.length;
			// 与已保存的不一致才提示「未保存」（两个串都由同一把尺子拼出来）。
			const changed = selectedKey !== extras.slice().sort().join(",");

			/**
			 * 落盘一份名单（chips 的立即写 与 保存按钮 共用）。
			 *
			 * `setSettings` 回的是 `{ ok, settings, restartRequired }` —— **不要过 unwrap**
			 * （unwrap 只认 `{ok, value}`，会把 settings 整个吃掉）。回执里带回来的名单
			 * 要跟发出去的对一遍：对不上就不许说「已保存」。
			 */
			function put(next, okMsg) {
				if (!canWrite) { patch({ err: t("ad.tidyScope.noSettings") }); return; }
				if (busy) return;
				const list = tidyList(next);
				patch({ busy: true, err: null, notice: null });
				Promise.resolve(memRemote.setSettings({ reserved: list })).then(function (out) {
					if (out && out.ok === false) {
						patch({ busy: false, err: out.error || t("ad.err.reservedRejected") });
						return;
					}
					const s = out && out.settings ? out.settings : null;
					if (typeof props.onSettings === "function") props.onSettings(s);
					const back = s ? tidyList(s.reservedExtra).slice().sort().join(",") : list.slice().sort().join(",");
					if (s && back !== list.slice().sort().join(",")) {
						// 宿主说了算：回执里的名单不是刚发的那份，就不谎报「已保存」。
						patch({ busy: false, err: t("ad.tidyScope.notApplied"), add: [], drop: [] });
						return;
					}
					patch({
						busy: false,
						err: null,
						// 落盘成功 → 增量清零（选择重新以宿主那份为基准）
						add: [],
						drop: [],
						notice: out && out.restartRequired === false ? t("ad.tidyScope.savedNow") : (okMsg || t("ad.tidyScope.saved")),
					});
				}, function (e) {
					patch({ busy: false, err: String((e && e.message) || e) });
				});
			}

			/** 勾 / 取消一个名字：只改增量，落盘交给「保存」（一次能改好几个）。 */
			function toggle(name, on) {
				const k = tidyKey(name);
				if (on) patch({ add: tidyList(add.concat([name])), drop: drop.filter(function (x) { return x !== k; }) });
				else patch({ add: add.filter(function (x) { return tidyKey(x) !== k; }), drop: drop.concat([k]) });
			}

			/** chips 上的 ✕：旧入口，点一下立刻落盘（沿用 2.1.0 起的行为）。 */
			function removeName(name) {
				const k = tidyKey(name);
				put(selected.filter(function (x) { return tidyKey(x) !== k; }), t("ad.notice.reservedSaved"));
			}

			/** 「加入名单」：与宿主同一套校验（单个 .md 文件名、不许带路径、不许重复）。 */
			function addName() {
				const name = String(newName || "").trim();
				if (!name) { patch({ err: t("ad.err.reservedNeedName") }); return; }
				if (!name.endsWith(".md") || name.includes("/") || name.includes("\\") || name.startsWith("..")) {
					patch({ err: t("ad.err.reservedBadName", { name: name }) });
					return;
				}
				if (selected.some(function (x) { return tidyKey(x) === tidyKey(name); })) {
					patch({ err: t("ad.err.reservedDup", { name: name }) });
					return;
				}
				patch({ newName: "" });
				put(selected.concat([name]), t("ad.notice.reservedSaved"));
			}

			/** 一行元信息：内置说「不可取消」，文件说体积与类型，已声明但没文件就直说。 */
			function metaText(r) {
				if (r.kind === "fixed") return t("ad.tidyScope.builtin");
				if (!r.meta) return t("ad.tidyScope.missing");
				const size = typeof r.meta.size === "number" ? fmtSize(r.meta.size) : "";
				const kind = r.meta.type ? typeLabel(r.meta.type) : "";
				const base = [size, kind].filter(Boolean).join(" · ");
				return r.meta.locked ? base + " · " + t("ad.tidyScope.locked") : base;
			}

			const isOn = function (name) {
				const k = tidyKey(name);
				return fixed.some(function (x) { return tidyKey(x) === k; }) ||
					selected.some(function (x) { return tidyKey(x) === k; });
			};

			const rowEl = function (r) {
				const on = isOn(r.name);
				const locked = r.kind === "fixed";
				// 行用现成的 `.smem-check`（复选框 + 手型 + accent-color 都已经在库里），
				// 只把「内置不可取消」的视觉差别用内联样式补上 —— 不为这一块再长一段 CSS。
				return h("label", {
					className: "smem-check smem-tidy-row",
					key: "row-" + r.name,
					"data-on": on ? "1" : "0",
					style: locked
						? { opacity: 0.72, cursor: "default" }
						: (canWrite ? null : { cursor: "default" }),
				}, [
					h("input", {
						type: "checkbox", key: "c", className: "smem-tidy-check",
						checked: on,
						disabled: locked || busy || !canWrite,
						title: locked ? t("ad.tidyScope.builtin") : "",
						onChange: function (e) { toggle(r.name, !!(e && e.target && e.target.checked)); },
					}),
					h("span", { key: "n", style: { minWidth: "150px" } }, r.name),
					h("span", { className: "smem-status", key: "m" }, metaText(r)),
				]);
			};

			return h("div", { className: "smem-tidy-scope", key: "tidy" }, [
				// ── 已选 chips（内置固定 + 当前选择可删）──
				h("div", { className: "smem-raw-names", key: "fixed" }, fixed.map(function (n) {
					return h("span", { className: "smem-chip smem-chip--fixed", key: n, title: t("ad.reserved.fixedTitle") }, n + t("ad.reserved.fixedSuffix"));
				})),
				h("div", { className: "smem-raw-names", key: "extra" },
					selected.length
						? selected.map(function (n) {
								return h("span", { className: "smem-chip", key: n, "data-on": "1" }, [
									n,
									h("button", {
										type: "button", className: "smem-chip-x", key: "x",
										title: t("ad.reserved.removeTitle", { name: n }),
										disabled: busy || !canWrite,
										onClick: function () { removeName(n); },
									}, "✕"),
								]);
							})
						: h("span", { className: "smem-status", key: "none" }, t("ad.reserved.empty"))),
				// 旧入口保留在 chips 上：手输一个还没落到目录里的名字仍然有用（先保护、后建文件）。
				h("div", { className: "smem-autodream-row", key: "add" }, [
					h("input", {
						className: "smem-input", key: "i",
						style: { flex: "1", minWidth: "150px" },
						value: newName,
						disabled: busy || !canWrite,
						placeholder: t("ad.reserved.placeholder"),
						onChange: function (e) { patch({ newName: (e && e.target && e.target.value) || "" }); },
					}),
					h("button", {
						type: "button", className: "smem-btn", key: "a",
						disabled: busy || !canWrite, onClick: addName,
					}, t("ad.action.addToList")),
				]),

				// ── 勾选面板：从目录里现成的文件名里勾 ──
				h("div", { className: "smem-autodream-row", key: "head" }, [
					h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, t("ad.tidyScope.title")),
					h("span", { className: "smem-status", key: "c" }, t("ad.tidyScope.count", { on: String(picked), total: String(rows.length) })),
				]),
				h("div", { className: "smem-autodream-note", key: "n1" }, t("ad.tidyScope.note1")),
				h("div", { className: "smem-autodream-note", key: "n2" }, t("ad.tidyScope.note2")),
				!canRead
					? h("div", { className: "smem-autodream-note smem-ad-warn", key: "nosettings" }, t("ad.tidyScope.noSettings"))
					: null,
				canRead && !settings
					? h("div", { className: "smem-status", key: "loading" }, t("ad.loading"))
					: null,
				canRead
					? h("div", { className: "smem-autodream-row", key: "search" }, [
							h("input", {
								className: "smem-search", key: "q", type: "search",
								value: query,
								placeholder: t("ad.tidyScope.search"),
								onChange: function (e) { patch({ query: (e && e.target && e.target.value) || "" }); },
							}),
						])
					: null,
				canRead
					? h("div", {
							key: "list",
							// 滚动的是这一块而不是整页：名单可能几十条，把保存按钮推下去就找不到了。
							style: {
								maxHeight: "220px", overflowY: "auto",
								border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "8px",
								padding: "6px 10px",
							},
							className: "smem-autodream-list",
						}, shown.length
							? shown.map(rowEl)
							: [h("div", { className: "smem-status", key: "nomatch" }, t("ad.tidyScope.noMatch"))])
					: null,
				// ── 保存 ──
				h("div", { className: "smem-autodream-row", key: "save" }, [
					h("button", {
						type: "button", className: "smem-btn smem-btn-primary", key: "s",
						disabled: busy || !canWrite, onClick: function () { put(selected, t("ad.tidyScope.saved")); },
					}, busy ? t("ad.tidyScope.saving") : t("ad.tidyScope.save")),
					h("span", { className: "smem-status", key: "h" },
						changed ? t("ad.tidyScope.dirty") : t("ad.tidyScope.restartHint")),
				]),
				// 回执与错误留在这块的最下面：不管按的是 chips 还是保存按钮，结果都在同一处。
				err ? h("div", { className: "smem-err", key: "err" }, "⚠ " + err) : null,
				notice ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
			]);
		}
