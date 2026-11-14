		/**
		 * 「实验性设置」一屏（2.9.0）—— 只放**会改变选材**的开关，不放在注入上限那一栏。
		 *
		 * 为什么单开一屏而不是塞进「自动做梦 → 设置」：
		 *   注入上限改的是**预算**（多给或少给上下文），这一屏改的是**选材**
		 *   （哪些记忆被端上来）。后者出事的样子是「该来的那条没来」，也就是失忆 ——
		 *   用户必须能一眼找到这是实验性的、并且知道怎么关掉。
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

				// 错误与回执留在最后：不管在哪按的，结果都得看得见。
				err ? h("div", { className: "smem-err", key: "err" }, "⚠ " + err) : null,
				notice ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
			]);
		}
