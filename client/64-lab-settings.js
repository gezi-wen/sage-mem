		/**
		 * 「实验性设置」一屏（2.9.0）—— 只放**会改变选材**的开关，不放在注入上限那一栏。
		 *
		 * 为什么单开一屏而不是塞进「自动做梦 → 设置」：
		 *   注入上限改的是**预算**（多给或少给上下文），这一屏改的是**选材**
		 *   （哪些记忆被端上来）。后者出事的样子是「该来的那条没来」，也就是失忆 ——
		 *   用户必须能一眼找到这是实验性的、并且知道怎么关掉。
		 *
		 * 2.12.1：这一屏最上面还挂着**初始记忆卡片**（`InitialGuideCard`，不是开关）——
		 * 它和 MMR / 待办看板同属「不天天用、需要时找得到」的那一栏；文件列表留给「今天读哪条」。
		 * 卡片由装配层（`client/70-memory-panel.js`）造好放进同一屏，本文件不 import 它。
		 *
		 * 目前只有一个开关：**MMR 去重**（注入名额有限时，同族记忆不再互相挤占名额）。
		 * 语义与三道护栏在宿主侧 `lib/memory/mmr.js`；这里只负责读写与说清楚代价。
		 *
		 * 数据全走已有的 `remote.memory.getSettings` / `setSettings`：
		 *   - 读回的是 `{ experimental, pendingExperimental, restartRequired, ... }`；
		 *   - `setSettings` 的返回是 `{ ok, settings, restartRequired }`，**不要过 unwrap**
		 *     （unwrap 只认 `{ok, value}`，会把 settings 吃掉 —— 60-autodream-panel 里有同一条）
		 *   - 生效值是**模块加载时**读的 → 改完要重启 DSH，界面必须诚实地说这一句。
		 */
		function LabSettingsPanel(props) {
			const memRemote = stableRemote(props.ctx, "remote.memory");
			const sSet = react.useState(null); const memSet = sSet[0], setMemSet = sSet[1];
			const sDraft = react.useState(""); const draft = sDraft[0], setDraft = sDraft[1];
			const sErr = react.useState(null); const err = sErr[0], setErr = sErr[1];
			const sNotice = react.useState(""); const notice = sNotice[0], setNotice = sNotice[1];
			const sBusy = react.useState(false); const busy = sBusy[0], setBusy = sBusy[1];

			/** 安全取百分比：非数字一律当 0（= 关闭），与宿主侧的收敛语义一致。 */
			const pct = function (v) {
				const n = Number(v);
				return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
			};
			const active = pct(memSet && memSet.experimental && memSet.experimental.mmr);
			const pending = memSet && memSet.pendingExperimental
				? pct(memSet.pendingExperimental.mmr)
				: active;

			function load() {
				if (!memRemote || typeof memRemote.getSettings !== "function") {
					setErr(t("lab.err.noSettings"));
					return;
				}
				Promise.resolve(memRemote.getSettings()).then(function (res) {
					const d = unwrap(res) || {};
					setMemSet(d);
					const p = d.pendingExperimental ? pct(d.pendingExperimental.mmr) : pct(d.experimental && d.experimental.mmr);
					setDraft(String(p));
				}, function (e) { setErr(String((e && e.message) || e)); });
			}

			react.useEffect(function () { load(); }, []);

			/**
			 * 写一项实验性设置。
			 * @param {number} mmr 0~100
			 * @param {string} okMsg 成功回执
			 */
			function save(mmr, okMsg) {
				if (!memRemote || typeof memRemote.setSettings !== "function") { setErr(t("lab.err.noSettings")); return; }
				setBusy(true); setErr(null); setNotice("");
				Promise.resolve(memRemote.setSettings({ experimental: { mmr: mmr } })).then(function (out) {
					setBusy(false);
					// setSettings 自带 {ok, settings, restartRequired}：直接读，不要 unwrap。
					if (out && out.ok === false) { setErr(out.error || t("lab.err.rejected")); return; }
					if (out && out.settings) setMemSet(out.settings); else load();
					setDraft(String(mmr));
					setNotice(okMsg);
				}, function (e) {
					setBusy(false);
					setErr(String((e && e.message) || e));
				});
			}

			/** 开关：开 → 回到草稿里的值（默认 70）；关 → 写 0。 */
			function toggle() {
				if (pending > 0) { save(0, t("lab.notice.off")); return; }
				const n = Number(draft);
				const target = Number.isFinite(n) && n > 0 ? Math.round(n) : 70;
				save(target, t("lab.notice.on", { value: target }));
			}

			/** 保存强度：本地先拦明显笔误（宿主也会拒，但白跑一趟没必要）。 */
			function saveStrength() {
				const raw = String(draft == null ? "" : draft).trim();
				const n = Number(raw);
				if (raw === "" || !Number.isFinite(n) || !Number.isInteger(n)) { setErr(t("lab.err.integer")); return; }
				if (n < 0 || n > 100) { setErr(t("lab.err.range")); return; }
				save(n, n > 0 ? t("lab.notice.strengthOn", { value: n }) : t("lab.notice.off"));
			}

			const statusText = busy
				? t("lab.action.saving")
				: (pending > 0 ? t("lab.status.on", { value: pending }) : t("lab.status.off"));

			return h("div", { className: "smem-lab smem-module-card" }, [
				// ── 模块卡头：开关 + 标题 + 状态（照自动归档那张卡的形状）──
				h("div", { className: "smem-modcard-head", key: "head" }, [
					h(Switch, {
						key: "sw",
						on: pending > 0,
						label: t("lab.switch"),
						title: pending > 0 ? t("lab.switch.onTitle") : t("lab.switch.offTitle"),
						disabled: busy || !memSet,
						onClick: toggle,
					}),
					h("span", { className: "smem-modcard-title", key: "t" }, t("lab.title")),
					h("span", { className: "smem-modcard-status", key: "s" }, statusText),
				]),

				// ── 它做什么：一句话 + 代价（这一屏存在的理由写在最前面）──
				h("div", { className: "smem-autodream-sec", key: "what" }, [
					h("div", { className: "smem-autodream-note", key: "p1" }, t("lab.what1")),
					h("div", { className: "smem-autodream-note", key: "p2" }, t("lab.what2")),
				]),

				// ── 强度 ──
				h("div", { className: "smem-autodream-sec", key: "strength" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, t("lab.strength")),
						h("input", {
							className: "smem-input smem-num", key: "i", type: "number", min: 0, max: 100, step: 5,
							value: draft,
							disabled: busy || !memSet,
							onChange: function (e) { setDraft(e.target.value); },
						}),
						h("span", { className: "smem-muted", key: "u" }, t("lab.unit")),
						h("button", {
							type: "button", className: "smem-btn smem-btn-primary", key: "save",
							disabled: busy || !memSet, onClick: saveStrength,
						}, busy ? t("lab.action.saving") : t("lab.action.save")),
					]),
					h("div", { className: "smem-autodream-note", key: "hint" }, t("lab.hint.strength")),
					h("div", { className: "smem-autodream-note", key: "restart" },
						t("lab.note.restart", { active: active, pending: pending })),
				]),

				// ── 实验性声明：用现成的虚线提示框（「提示，不计入问题」那一个）──
				h("div", { className: "smem-audit-hint", key: "declare" }, [
					h("div", { key: "t", style: { fontWeight: "600" } }, t("lab.declare.title")),
					h("div", { key: "a" }, t("lab.declare.forget")),
					h("div", { key: "b" }, t("lab.declare.feedback")),
					h("div", { key: "c" }, t("lab.declare.default")),
				]),

				// ── 2.17.0 新增：压缩前记忆提醒（默认关；host 侧 live，改完立刻生效）──
				h(PreCompactLabCard, { key: "precompact", ctx: props.ctx }),

				// ── 2.11.0 新增：待办清单看板（界面入口类开关，改完立刻生效）──
				h(TodoBoardLabCard, { key: "todos", ctx: props.ctx }),

				// 错误与回执留在最后：不管在哪按的，结果都得看得见。
				err ? h("div", { className: "smem-err", key: "err" }, "⚠ " + err) : null,
				notice ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
			]);
		}

		/**
		 * 实验性页里的「压缩前记忆提醒」卡（2.17.0）。
		 *
		 * 与 `TodoBoardLabCard` 同构：读 → 开关 → 说明 → 数值 → 错误与回执。
		 * 为什么单开一张卡而不是塞进 MMR 那张：它**不改选材**，改的是「会话里会不会
		 * 冒出一条提醒」。出事的样子也不同 —— MMR 出事是「该来的记忆没来」，这条出事是
		 * 「该提醒的时候没提醒」。用户在面板上得能分别关掉。
		 *
		 * ⚠️ 这里的 3 / 20 / 8 是**客户端的一份副本**（宿主侧 `EXPERIMENTAL_SPECS`
		 * 才是判据）。为什么只能复制：client bundle 不能 import `memory/experimental.js`
		 * —— 那条模块链会拉到 `node:os` 与 `process.env`，在浏览器里直接炸。所以边界写在
		 * 这里是既定取舍（MMR 卡的 0–100 同样如此）；改动时两边一起改，宿主那边会拒越界值。
		 */
		function PreCompactLabCard(props) {
			const remote = stableRemote(props.ctx, "remote.memory");
			const sSet = react.useState(null); const memSet = sSet[0], setMemSet = sSet[1];
			const sOn = react.useState(false); const on = sOn[0], setOn = sOn[1];
			const sLead = react.useState("8"); const lead = sLead[0], setLead = sLead[1];
			const sBusy = react.useState(false); const busy = sBusy[0], setBusy = sBusy[1];
			const sErr = react.useState(null); const err = sErr[0], setErr = sErr[1];
			const sNotice = react.useState(""); const notice = sNotice[0], setNotice = sNotice[1];

			/**
			 * 读整数：非数字给默认值。
			 * 与上面 `pct` 的区别是有意的 —— 那个把非法当 0（= 关闭），而提前量的 0 不是
			 * 合法值，静默变成 0 会让用户以为自己关掉了开关。
			 */
			const readInt = function (v, dflt) {
				const n = Number(v);
				return Number.isFinite(n) ? Math.round(n) : dflt;
			};

			// 初次挂载：以宿主设置里的值为准（live 开关的 pending 与 active 是一致的）。
			react.useEffect(function () {
				if (!remote || typeof remote.getSettings !== "function") {
					setErr(t("pre.compact.err.noSettings"));
					return;
				}
				Promise.resolve(remote.getSettings()).then(function (res) {
					const d = unwrap(res) || {};
					setMemSet(d);
					const lab = d.pendingExperimental || d.experimental || {};
					setOn(readInt(lab.preCompact, 0) > 0);
					setLead(String(readInt(lab.preCompactLead, 8)));
				}, function (e) { setErr(String((e && e.message) || e)); });
			}, []);

			/** 写一项：`setSettings` 自带 `{ok, settings, restartRequired}`，不要过 unwrap。 */
			function save(patch, okMsg) {
				if (!remote || typeof remote.setSettings !== "function") {
					setErr(t("pre.compact.err.noSettings"));
					return;
				}
				setBusy(true); setErr(null); setNotice("");
				Promise.resolve(remote.setSettings({ experimental: patch })).then(function (out) {
					setBusy(false);
					if (out && out.ok === false) { setErr(out.error || t("lab.err.rejected")); return; }
					if (out && out.settings) setMemSet(out.settings);
					setNotice(okMsg);
				}, function (e) {
					setBusy(false);
					setErr(String((e && e.message) || e));
				});
			}

			function toggle() {
				const next = on ? 0 : 1;
				setOn(next > 0);
				save({ preCompact: next }, t(next > 0 ? "pre.compact.notice.on" : "pre.compact.notice.off"));
			}

			/** 保存提前量：本地先拦明显笔误（宿主也会拒，但白跑一趟没必要）。 */
			function saveLead() {
				const raw = String(lead == null ? "" : lead).trim();
				const n = Number(raw);
				if (raw === "" || !Number.isInteger(n) || n < 3 || n > 20) { setErr(t("pre.compact.err.range")); return; }
				save({ preCompactLead: n }, t("pre.compact.notice.lead", { value: n }));
			}

			const statusText = busy
				? t("lab.action.saving")
				: (on ? t("pre.compact.status.on", { value: readInt(lead, 8) }) : t("pre.compact.status.off"));

			return h("div", { className: "smem-module-card" }, [
				h("div", { className: "smem-modcard-head", key: "head" }, [
					h(Switch, {
						key: "sw",
						on: on,
						label: t("pre.compact.switch"),
						title: t("pre.compact.switch.title"),
						disabled: busy || !memSet,
						onClick: toggle,
					}),
					h("span", { className: "smem-modcard-title", key: "t" }, t("pre.compact.title")),
					h("span", { className: "smem-modcard-status", key: "s" }, statusText),
				]),

				h("div", { className: "smem-autodream-sec", key: "what" }, [
					h("div", { className: "smem-autodream-note", key: "p1" }, t("pre.compact.what1")),
					h("div", { className: "smem-autodream-note", key: "p2" }, t("pre.compact.what2")),
					h("div", { className: "smem-autodream-note", key: "p3" }, t("pre.compact.what3")),
				]),

				h("div", { className: "smem-autodream-sec", key: "lead" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, t("pre.compact.lead")),
						h("input", {
							className: "smem-input smem-num", key: "i", type: "number", min: 3, max: 20, step: 1,
							value: lead,
							disabled: busy || !memSet,
							onChange: function (e) { setLead(e.target.value); },
						}),
						h("span", { className: "smem-muted", key: "u" }, t("pre.compact.unit")),
						h("button", {
							type: "button", className: "smem-btn smem-btn-primary", key: "save",
							disabled: busy || !memSet, onClick: saveLead,
						}, busy ? t("lab.action.saving") : t("lab.action.save")),
					]),
					h("div", { className: "smem-autodream-note", key: "hint" }, t("pre.compact.hint.lead")),
				]),

				err ? h("div", { className: "smem-err", key: "err" }, "⚠ " + err) : null,
				notice ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
			]);
		}
