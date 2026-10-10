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
			const remote = props.ctx && props.ctx.get ? props.ctx.get("remote.autodream") : null;
			const sCfg = react.useState(null); const cfg = sCfg[0], setCfg = sCfg[1];
			const sDraft = react.useState(null); const draft = sDraft[0], setDraft = sDraft[1];
			const sErr = react.useState(null); const err = sErr[0], setErr = sErr[1];
			const sNotice = react.useState(""); const notice = sNotice[0], setNotice = sNotice[1];
			const sBusy = react.useState(false); const busy = sBusy[0], setBusy = sBusy[1];

			const TH_KEYS = ["archiveAfterDaysProject", "archiveAfterDaysReference", "archiveAfterDaysUser"];
			const TH_LABEL = { archiveAfterDaysProject: "项目", archiveAfterDaysReference: "参考", archiveAfterDaysUser: "用户" };
			const TH_HINT = {
				archiveAfterDaysProject: "project_* 连续这么多天没被注入 → 进候选",
				archiveAfterDaysReference: "reference_* 同上（资料一般比项目留得久）",
				archiveAfterDaysUser: "user_* 同上（人设这类动它要格外谨慎）",
			};

			/** 阈值 → 输入框草稿。存成字符串：number input 清空时立刻变 0 会很难用。 */
			const draftOf = function (c) {
				const src = c || {};
				const out = {};
				for (const k of TH_KEYS) out[k] = String(src[k] == null ? "" : src[k]);
				return out;
			};

			react.useEffect(function () {
				if (!remote || typeof remote.getConfig !== "function") {
					setErr("宿主侧没有 autodream 配置接口（插件版本较旧）");
					return;
				}
				remote.getConfig()
					.then(function (r) {
						const d = unwrap(r);
						const c = d && d.config ? d.config : null;
						if (!c) { setErr("读不出自动做梦配置"); return; }
						setCfg(c);
						setDraft(draftOf(c));
					})
					.catch(function (e) { setErr("读配置失败：" + ((e && e.message) || e)); });
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
						setErr("保存没生效：" + bad + "。setConfig 对非法值会忽略并保留原值 —— 请重试，或看 DSH 启动日志。");
					})
					.catch(function (e) { setErr("保存失败：" + ((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			function saveMode(v) {
				save({ autoArchive: v }, "自动归档已设为「" + AUTO_ARCHIVE_LABEL[v] + "」", function (got) {
					const g = got ? autoArchiveOf(got.autoArchive) : null;
					return g === v ? null : ("配置里仍是「" + (g ? AUTO_ARCHIVE_LABEL[g] : "读不出来") + "」");
				});
			}

			/** 越界/非整数**本地先拦**（host 也会拒），别让它白跑一趟。 */
			function saveThresholds() {
				const d = draft || {};
				const patch = {};
				for (const k of TH_KEYS) {
					const n = Number(d[k]);
					if (!Number.isFinite(n) || n < 1 || n > 3650) {
						setErr(TH_LABEL[k] + "的阈值要是 1~3650 之间的天数（现在是「" + d[k] + "」）");
						return;
					}
					patch[k] = Math.round(n);
				}
				save(patch, "归档条件已保存", function (got) {
					const bad = TH_KEYS.filter(function (k) { return !got || Number(got[k]) !== patch[k]; });
					if (!bad.length) return null;
					return bad.map(function (k) { return TH_LABEL[k] + " 仍是 " + (got ? got[k] : "读不出来"); }).join("、");
				});
			}

			return h("div", { className: "smem-seg" }, [
				// ── ① 它做什么（这一屏存在的理由写在最前面）──
				h("div", { className: "smem-autodream-sec", key: "what" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "自动归档做什么"),
					]),
					h("div", { className: "smem-autodream-note", key: "p1" },
						"闲置太久没被注入过的记忆，会被移进 archive/ —— 不删除，随时能恢复。这一页决定「多久算闲置」，以及要不要真的动手。"),
					h("div", { className: "smem-autodream-note", key: "p2" },
						"它不调模型：候选完全按访问台账的天数算，同一份输入每次算出来都一样。"),
					h("div", { className: "smem-autodream-note", key: "p3" },
						"想现在看看会被收走哪些：文件列表 →「工具 ▾」→ 归档候选。"),
				]),
				// ── ② 三档策略 ──
				h("div", { className: "smem-autodream-sec", key: "mode" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "自动归档"),
						h(Seg, {
							key: "v", value: mode,
							options: [
								{ value: "off", label: AUTO_ARCHIVE_LABEL.off },
								{ value: "report", label: AUTO_ARCHIVE_LABEL.report },
								{ value: "auto", label: AUTO_ARCHIVE_LABEL.auto },
							],
							onChange: function (v) { if (v !== mode) saveMode(v); },
						}),
						busy ? h("span", { className: "smem-status", key: "s" }, "保存中…") : null,
					]),
					h("div", { className: "smem-autodream-note", key: "cost" }, AUTO_ARCHIVE_COST[mode]),
					mode === "auto" && !c.apply
						? h("div", { className: "smem-autodream-note smem-ad-warn", key: "deg" },
								"注意：「自动做梦 → 改动方式」现在是只出报告 —— 这一档会自动降级成只出报告，不会动文件。")
						: null,
				]),
				// ── ③ 三个阈值 ──
				h("div", { className: "smem-autodream-sec", key: "th" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "闲置多少天算可以归档"),
					]),
					draft
						? h("div", { key: "rows" }, TH_KEYS.map(function (k) {
								return h("div", { className: "smem-autodream-row", key: k }, [
									h("span", { className: "smem-autodream-key", key: "k" }, TH_LABEL[k]),
									h("input", {
										className: "smem-input smem-num", key: "i", type: "number", min: 1, max: 3650,
										value: draft[k],
										onChange: function (e) {
											const nx = Object.assign({}, draft);
											nx[k] = e.target.value;
											setDraft(nx);
										},
									}),
									h("span", { className: "smem-muted", key: "u" }, TH_HINT[k]),
								]);
							}))
						: h("div", { className: "smem-muted", key: "loading" }, "读配置中…"),
					h("div", { className: "smem-autodream-row", key: "btns" }, [
						h("button", {
							type: "button", className: "smem-btn smem-btn-primary", key: "save",
							disabled: busy || !draft, onClick: saveThresholds,
						}, busy ? "保存中…" : "保存归档条件"),
						h("span", { className: "smem-muted", key: "n" }, "保存即生效，不用重启 DSH"),
					]),
					h("div", { className: "smem-autodream-note", key: "note" },
						"天数按访问台账算（这条记忆上次被注入给模型是什么时候）。feedback_* 永不入选；锁定的记忆也不会被选中。"),
				]),
				err ? h("div", { className: "smem-err", key: "err" }, "⚠ " + err) : null,
				notice ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
			]);
		}
