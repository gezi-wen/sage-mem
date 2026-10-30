		/**
		 * 「自动归档」面板 —— 独立成一屏（v0.9.9）。
		 *
		 * 为什么独立出来（用户 2026-10-11）：这一块原来塞在「自动做梦 → 设置」里，
		 * 他自己的原话是「扔这里连我都找不到」。而且它确实是**另一件事**：
		 *   自动做梦 = 让模型读记忆、整理、改写（要调模型、有 token 成本）
		 *   自动归档 = 按「多久没被注入过」把记忆移进 archive/（纯确定性规则、不调模型）
		 * 混在模型那套设置里，既难找、也容易让人以为归档会花钱。
		 *
		 * 这一页管两件事：
		 *   1. **三档策略**：关闭 / 只出报告 / 满足条件自动跑
		 *   2. **三个阈值**（项目 / 参考 / 用户）：多少天没被注入就算闲置
		 *
		 * 数据全走 `remote.autodream` 的 `getConfig` / `setConfig` —— 阈值本来就在配置里
		 * （`lib/autodream/config.js` 的 archiveAfterDays*），只是以前**界面够不着**。
		 * 所以这一版没有新增任何 remote。
		 *
		 * 两处诚实标注：阈值**存完立即生效**（不经过模块加载期固化，与注入参数不同）；
		 * 保存后**一定回读**（`setConfig` 对非法值是「忽略并保留原值」，只信返回值会骗人）。
		 */
		function ArchiveSettingsPanel(props) {
			const remote = stableRemote(props.ctx, "remote.autodream");
			const sCfg = react.useState(null); const cfg = sCfg[0], setCfg = sCfg[1];
			const sDraft = react.useState(null); const draft = sDraft[0], setDraft = sDraft[1];
			const sErr = react.useState(null); const err = sErr[0], setErr = sErr[1];
			const sNotice = react.useState(""); const notice = sNotice[0], setNotice = sNotice[1];
			const sBusy = react.useState(false); const busy = sBusy[0], setBusy = sBusy[1];

			const TH_KEYS = ["archiveAfterDaysProject", "archiveAfterDaysReference", "archiveAfterDaysUser"];
			// 2.1.0：标签与提示走字典（键在这里，文案在 55-i18n-memory.js）。
			const TH_LABEL_KEY = {
				archiveAfterDaysProject: "archive.th.project",
				archiveAfterDaysReference: "archive.th.reference",
				archiveAfterDaysUser: "archive.th.user",
			};
			const TH_HINT_KEY = {
				archiveAfterDaysProject: "archive.th.hintProject",
				archiveAfterDaysReference: "archive.th.hintReference",
				archiveAfterDaysUser: "archive.th.hintUser",
			};
			const thLabel = function (k) { return t(TH_LABEL_KEY[k] || ""); };
			const thHint = function (k) { return t(TH_HINT_KEY[k] || ""); };
			// 2.1.0：三档策略的标题与代价走字典。键必须**写成字面量**（死键守卫会逐键回分片里找）；
			// 用 "archive.mode." + v 拼接既拿不到字面量，也会让守卫把前缀当成一个缺失的键。
			const MODE_KEY = { off: "archive.mode.off", report: "archive.mode.report", auto: "archive.mode.auto" };
			const COST_KEY = { off: "archive.cost.off", report: "archive.cost.report", auto: "archive.cost.auto" };
			const modeLabel = function (v) { return t(MODE_KEY[v] || ""); };
			const costText = function (v) { return t(COST_KEY[v] || ""); };

			/** 阈值 → 输入框草稿。存成字符串：number input 清空时立刻变 0 会很难用。 */
			const draftOf = function (c) {
				const src = c || {};
				const out = {};
				for (const k of TH_KEYS) out[k] = String(src[k] == null ? "" : src[k]);
				return out;
			};

			react.useEffect(function () {
				if (!remote || typeof remote.getConfig !== "function") {
					setErr(t("archive.err.noConfig"));
					return;
				}
				remote.getConfig()
					.then(function (r) {
						const d = unwrap(r);
						const c = d && d.config ? d.config : null;
						if (!c) { setErr(t("archive.err.readConfig")); return; }
						setCfg(c);
						setDraft(draftOf(c));
					})
					.catch(function (e) { setErr(t("archive.err.readFailed", { error: (e && e.message) || e })); });
			}, []);

			const c = cfg || {};
			const mode = autoArchiveOf(c.autoArchive);

			/**
			 * 存完回读。
			 * @param {Object} patch 要写的配置
			 * @param {string} okMsg 成功提示
			 * @param {Function} failOf (got) => string|null —— 返回 null 表示这次改动真的落进去了
			 */
			function save(patch, okMsg, failOf) {
				setBusy(true); setErr(null); setNotice("");
				remote.setConfig(patch)
					.then(function () { return remote.getConfig(); })
					.then(function (r) {
						const d = unwrap(r);
						const got = d && d.config ? d.config : null;
						if (got) { setCfg(got); setDraft(draftOf(got)); }
						const bad = failOf(got);
						if (!bad) { setNotice(okMsg); return; }
						setErr(t("archive.err.notApplied", { error: bad }));
					})
					.catch(function (e) { setErr(t("archive.err.saveFailed", { error: (e && e.message) || e })); })
					.then(function () { setBusy(false); });
			}

			function saveMode(v) {
				save({ autoArchive: v }, t("archive.notice.modeSet", { mode: modeLabel(v) }), function (got) {
					const g = got ? autoArchiveOf(got.autoArchive) : null;
					return g === v ? null : t("archive.err.modeStill", { mode: g ? modeLabel(g) : t("archive.unknown") });
				});
			}

			/** 越界/非整数**本地先拦**（host 也会拒），别让它白跑一趟。 */
			function saveThresholds() {
				const d = draft || {};
				const patch = {};
				for (const k of TH_KEYS) {
					const n = Number(d[k]);
					if (!Number.isFinite(n) || n < 1 || n > 3650) {
						setErr(t("archive.err.thresholdBad", { label: thLabel(k), value: d[k] }));
						return;
					}
					patch[k] = Math.round(n);
				}
				save(patch, t("archive.notice.thresholdsSaved"), function (got) {
					const bad = TH_KEYS.filter(function (k) { return !got || Number(got[k]) !== patch[k]; });
					if (!bad.length) return null;
					return bad.map(function (k) { return t("archive.err.thresholdStill", { label: thLabel(k), value: got ? got[k] : t("archive.unknown") }); }).join(t("ad.toolSep"));
				});
			}

			return h("div", { }, [
				// ── ① 它做什么（这一屏存在的理由写在最前面）──
				h("div", { className: "smem-autodream-sec", key: "what" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, t("archive.title")),
					]),
					h("div", { className: "smem-autodream-note", key: "p1" }, t("archive.intro1")),
					h("div", { className: "smem-autodream-note", key: "p2" }, t("archive.intro2")),
					h("div", { className: "smem-autodream-note", key: "p3" }, t("archive.intro3")),
				]),
				// ── ② 三档策略 ──
				h("div", { className: "smem-autodream-sec", key: "mode" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, t("archive.modeTitle")),
						h(Seg, {
							key: "v", value: mode,
							options: [
								{ value: "off", label: modeLabel("off") },
								{ value: "report", label: modeLabel("report") },
								{ value: "auto", label: modeLabel("auto") },
							],
							onChange: function (v) { if (v !== mode) saveMode(v); },
						}),
						busy ? h("span", { className: "smem-status", key: "s" }, t("archive.action.saving")) : null,
					]),
					h("div", { className: "smem-autodream-note", key: "cost" }, costText(mode)),
					mode === "auto" && !c.apply
						? h("div", { className: "smem-autodream-note smem-ad-warn", key: "deg" }, t("archive.degrade"))
						: null,
				]),
				// ── ③ 三个阈值 ──
				h("div", { className: "smem-autodream-sec", key: "th" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, t("archive.th.title")),
					]),
					draft
						? h("div", { key: "rows" }, TH_KEYS.map(function (k) {
								return h("div", { className: "smem-autodream-row", key: k }, [
									h("span", { className: "smem-autodream-key", key: "k" }, thLabel(k)),
									h("input", {
										className: "smem-input smem-num", key: "i", type: "number", min: 1, max: 3650,
										value: draft[k],
										onChange: function (e) {
											const nx = Object.assign({}, draft);
											nx[k] = e.target.value;
											setDraft(nx);
										},
									}),
									h("span", { className: "smem-muted", key: "u" }, thHint(k)),
								]);
							}))
						: h("div", { className: "smem-muted", key: "loading" }, t("archive.loadingConfig")),
					h("div", { className: "smem-autodream-row", key: "btns" }, [
						h("button", {
							type: "button", className: "smem-btn smem-btn-primary", key: "save",
							disabled: busy || !draft, onClick: saveThresholds,
						}, busy ? t("archive.action.saving") : t("archive.action.save")),
						h("span", { className: "smem-muted", key: "n" }, t("archive.note.immediate")),
					]),
					h("div", { className: "smem-autodream-note", key: "note" }, t("archive.note.thresholds")),
				]),
				err ? h("div", { className: "smem-err", key: "err" }, "⚠ " + err) : null,
				notice ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
			]);
		}
