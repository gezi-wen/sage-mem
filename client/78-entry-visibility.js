		// ── 界面入口三选一（2.7.0）──────────────────────────────────────────
		// 两个入口不是重复：设置页那个是所有宿主版本都有的保底，侧栏那个是可选、
		// 用户还能在插件详情页关掉。所以「只留一个」必须是**用户选择**，而不是
		// 默认删掉一个；三选一从类型上就保证不会出现「一个入口都没有」。
		//
		// 这一分片负责三件事：
		//   1. 把服务端的 ui.entry / 旧 ui.sidebarEntry 归一成一个模式；
		//   2. 按「宿主实际能力」解析出该注册哪一侧（侧栏槽 / 设置页 section）；
		//   3. 提供两个控制面共用的 EntryChooser（面板 60 与插件页 76 都渲染它）。
		//
		// 旧接口（stale host：客户端已更新、宿主模块还是 2.6.0）没有 ui.entry，
		// 这时只能表达「侧栏开 / 关」，所以「只显示侧栏」置灰，保存退回 sidebarEntry。

		/** 三个合法模式；顺序就是界面里的顺序。 */
		const ENTRY_MODES = ["both", "sidebar", "settings"];

		/** 当前存储值（canonical）；apply 时从 getSettings 读入。 */
		let entryMode = "both";
		/** 宿主是否认识 ui.entry；false = stale host，只能写 sidebarEntry。 */
		let entryApiModern = true;
		/** 侧栏槽能力：null = 还没探测，true / false = 探测结果。 */
		let sidebarSupported = null;
		/** 设置页 section 能力：null = 还没注册过，true / false = 结果。 */
		let settingsSupported = null;
		/** settings.section 的注销句柄（null = 当前没注册）。 */
		let settingsSectionDispose = null;

		/** 合法模式原样返回，其余（含旧布尔）交给调用方回落。 */
		function normalizeEntryMode(value) {
			return ENTRY_MODES.indexOf(value) >= 0 ? value : null;
		}

		/** 从 getSettings 返回值里取模式：新字段优先，旧字段按 true→both / false→settings。 */
		function entryModeFromSettings(settings) {
			const ui = settings && settings.ui;
			const next = normalizeEntryMode(ui && ui.entry);
			if (next) return next;
			if (ui && typeof ui.sidebarEntry === "boolean") return ui.sidebarEntry ? "both" : "settings";
			return "both";
		}

		/** 宿主模块是不是 2.7.0：有 ui.entry 才算认识三选一。 */
		function hasModernEntryApi(settings) {
			return !!(settings && settings.ui && normalizeEntryMode(settings.ui.entry));
		}

		/** 选项文案（三处共用：折叠行状态、面板状态、radio label）。 */
		function entryStatusLabel(mode) {
			return t(mode === "sidebar" ? "entry.opt.sidebar" : mode === "settings" ? "entry.opt.settings" : "entry.opt.both");
		}

		/**
		 * 某宿主上「实际会显示哪一个」。
		 *
		 * - 存 sidebar 但侧栏不可用 → 回落 settings（绝不两个都不显示）；
		 * - 存 settings 但设置页不可用 → 回落 sidebar；
		 * - 两个都不可用（极旧宿主）→ 交给插件页卡片兜底，这里不抛错。
		 */
		function resolveEntryVisibility(mode, support) {
			const sidebarOk = support.sidebar !== false;
			const settingsOk = support.settings !== false;
			if (mode === "sidebar") {
				if (sidebarOk) return { sidebar: true, settings: false };
				return { sidebar: false, settings: settingsOk };
			}
			if (mode === "settings") {
				if (settingsOk) return { sidebar: false, settings: true };
				return { sidebar: sidebarOk, settings: false };
			}
			return { sidebar: sidebarOk, settings: settingsOk };
		}

		/** 界面上展示的模式：降级时把 sidebar 显示成 settings，避免控件与实际不符。 */
		function entryDisplayMode() {
			if (entryMode === "sidebar" && (sidebarSupported === false || entryApiModern === false)) return "settings";
			return entryMode;
		}

		/** 降级提示是否要出现（存了 sidebar、当前宿主却显示设置页）。 */
		function entryDegraded() {
			return entryMode === "sidebar" && (sidebarSupported === false || entryApiModern === false);
		}

		/** 「只显示侧栏」这一项能不能选：宿主支持侧栏，且认识 ui.entry。 */
		function sidebarEntryAvailable() {
			return sidebarSupported !== false && entryApiModern !== false;
		}

		/** 探测侧栏槽能力：真实注册一次，失败时 registerSidebarEntry 自己清干净半注册。 */
		function detectSidebarSupport() {
			if (sidebarSupported !== null) return sidebarSupported;
			sidebarSupported = !!registerSidebarEntry();
			return sidebarSupported;
		}

		/** 注册设置页 section（幂等）。失败返回 false —— 旧外壳 / 没有设置面的宿主。 */
		function registerSettingsSection() {
			if (settingsSectionDispose !== null) return true;
			if (!sidebarCtx) return false;
			const ctx = sidebarCtx;
			try {
				settingsSectionDispose = ctx.slots.inject("settings.section", function () {
					return ctx.slots.register({
						name: "settings.section",
						id: "sage-mem",
						order: 20,
						label: function () { return t("section.label"); },
						// 声明「记忆星图」子槽（沿用 1.8.0 的契约）：sage-starmap 之类的
						// 第三方插件向它注入视图。⚠️ 现状：Section 还没有调用 renderSlot，
						// 所以这个子槽目前只声明、不渲染（2.7.0 未改；渲染它是独立事项）。
						// 保留声明是为了不破坏第三方插件的注入面。
						children: { "settings.memory.starmap": { kind: "list", scope: "root" } },
					}, function (props) {
						return react.createElement(Section, { ...props, ctx: ctx });
					});
				});
				return true;
			} catch (e) {
				settingsSectionDispose = null;
				return false;
			}
		}

		/** 注销设置页 section（反序不需要：只有一个 inject 句柄）。 */
		function disposeSettingsSection() {
			const stop = settingsSectionDispose;
			settingsSectionDispose = null;
			if (typeof stop !== "function") return;
			try { stop(); } catch (e) { /* 注销失败不能把设置卡死在「已注销」状态 */ }
		}

		/**
		 * 立即应用一个入口模式（改完槽位就变，不需要刷新）。
		 *
		 * 顺序：探测侧栏 → 解析可见性 → 按需注册 / 注销两侧。
		 * 设置页注册失败而侧栏又被要求隐藏时，强制把侧栏放回来 —— 这是最后一道门。
		 */
		function applyEntryMode(mode) {
			entryMode = normalizeEntryMode(mode) || "both";
			const sidebarOk = detectSidebarSupport();
			const visible = resolveEntryVisibility(entryMode, { sidebar: sidebarOk, settings: settingsSupported });

			if (visible.sidebar) {
				if (!registerSidebarEntry()) {
					sidebarSupported = false;
					visible.sidebar = false;
				}
			} else {
				setSidebarEntry(false);
			}

			if (visible.settings) {
				settingsSupported = registerSettingsSection();
				if (!settingsSupported && !visible.sidebar) {
					if (registerSidebarEntry()) {
						sidebarSupported = true;
						visible.sidebar = true;
					}
				}
			} else {
				disposeSettingsSection();
			}

			return {
				mode: entryMode,
				sidebar: visible.sidebar,
				settings: visible.settings,
				sidebarOk: sidebarSupported,
				settingsOk: settingsSupported,
			};
		}

		/**
		 * 保存一个入口模式：先写设置、成功后再动槽位。
		 *
		 * stale host 上没有 ui.entry，退回旧写法 sidebarEntry（true = 两个都显示，
		 * false = 只显示设置页）；若宿主真的拒绝了 entry，也自动重试一次旧写法。
		 */
		function saveEntryMode(remote, mode) {
			const next = normalizeEntryMode(mode) || "both";
			const writeModern = function () {
				return Promise.resolve(remote.setSettings({ ui: { entry: next } }));
			};
			const writeLegacy = function () {
				return Promise.resolve(remote.setSettings({ ui: { sidebarEntry: next !== "settings" } }));
			};
			const finish = function (out, retried) {
				if (out && out.ok === false) {
					// stale host 的报错形如 "unknown ui setting: entry"：自动退回旧写法再试一次。
					if (!retried && entryApiModern !== false && /unknown ui setting/i.test(String(out.error || ""))) {
						entryApiModern = false;
						return writeLegacy().then(function (legacyOut) { return finish(legacyOut, true); });
					}
					return { ok: false, error: out.error || t("ad.err.saveRejected") };
				}
				const settings = out && out.settings ? out.settings : null;
				// 服务端回传的形状就是事实：带 ui.entry 才是新接口。
				if (settings) entryApiModern = hasModernEntryApi(settings);
				const applied = settings ? entryModeFromSettings(settings) : next;
				applyEntryMode(applied);
				return { ok: true, settings: settings, mode: applied };
			};
			return (entryApiModern === false ? writeLegacy() : writeModern()).then(function (out) {
				return finish(out, entryApiModern === false);
			});
		}

		/** 读一次设置并同步全局模式；失败时返回 null（界面按默认渲染，不阻塞）。 */
		function readEntrySettings(remote) {
			if (!remote || typeof remote.getSettings !== "function") return Promise.resolve(null);
			return Promise.resolve(remote.getSettings()).then(function (out) {
				const settings = unwrap(out) || {};
				entryApiModern = hasModernEntryApi(settings);
				const mode = entryModeFromSettings(settings);
				applyEntryMode(mode);
				return { settings: settings, mode: mode };
			}, function () { return null; });
		}

		/**
		 * 三选一控件（受控）。
		 *
		 * 不自己读设置、不自己保存：两个控制面各自处理 busy / error，
		 * 这样插件页卡片与面板里的交互文案可以不同，而选项本身只有一份。
		 */
		function EntryChooser(props) {
			const mode = props && normalizeEntryMode(props.mode) ? props.mode : entryDisplayMode();
			const busy = !!(props && props.busy);
			const sidebarOk = !(props && props.sidebarOk === false);
			const modernApi = !(props && props.modernApi === false);
			const onPick = props && typeof props.onPick === "function" ? props.onPick : function () {};
			const labels = { both: "entry.opt.both", sidebar: "entry.opt.sidebar", settings: "entry.opt.settings" };
			return h("div", { className: "smem-entry-opts" }, ENTRY_MODES.map(function (value) {
				const blocked = value === "sidebar" && (!sidebarOk || !modernApi);
				const disabled = busy || blocked;
				const blockedWhy = !modernApi ? t("entry.legacyHost") : t("entry.sidebarUnsupported");
				return h("label", {
					className: "smem-check smem-entry-opt", key: value,
					title: blocked ? blockedWhy : undefined,
				}, [
					h("input", {
						type: "radio", key: "r", name: "smem-entry-mode",
						value: value, checked: mode === value, disabled: disabled,
						onChange: function () { if (!disabled) onPick(value); },
					}),
					h("span", { key: "l" }, t(labels[value])),
				]);
			}));
		}
