		// ── 侧栏入口（1.8.0）─────────────────────────────────────────────
		// 宿主侧栏的官方契约是两个槽位：
		//   `sidebar.panellist`（list 槽）：只画一个 size 见方的图标，行标题由宿主从 label 投影；
		//   `main`（keyed 槽）：key **必须**与侧栏条目 id 相同，选中缺失 key 宿主会直接抛错。
		// 开关（settings.ui.sidebarEntry）是**客户端行为**：这里持有两个 inject 的清理句柄，
		// 关 → 调清理器（宿主会连带注销 register 进去的条目），开 → 重新 inject/register。
		const SIDEBAR_ENTRY_ID = "sage-mem";
		/** 插件 ctx（80-apply 在 apply 时挂进来）；setSidebarEntry 之后要拿它重注册。 */
		let sidebarCtx = null;
		/** 该槽位的清理句柄数组（null = 当前没注册）。 */
		let sidebarDispose = null;

		/**
		 * 侧栏图标：内联 SVG、currentColor、细线 —— 不引外部图片/字体，跟随宿主明暗主题。
		 *
		 * 1.8.2 起字形与仓库根的 `icon.png` 同源：**叠层记忆卡片**（后面一张只描边、低透明，
		 * 前面一张压在左下），不再是「文档三行」。单色而不是品牌金：侧栏图标必须跟随
		 * 宿主的 currentColor，深色 / 浅色主题下才都可读。
		 */
		function SidebarEntryIcon(props) {
			const edge = typeof props.size === "number" && props.size > 0 ? props.size : 16;
			return h("svg", {
				width: edge, height: edge, viewBox: "0 0 16 16", fill: "none",
				"aria-hidden": "true", focusable: "false",
			}, [
				// 后面那张卡：错开、只描边、低透明 —— 表达「一叠记忆」而不是两张孤立的卡。
				h("rect", {
					key: "back", x: "4.4", y: "2.2", width: "9.4", height: "9", rx: "1.8",
					stroke: "currentColor", strokeWidth: "1.2", opacity: "0.45",
				}),
				// 前面那张卡：压在左下，实心描边。
				h("rect", {
					key: "front", x: "2.2", y: "4.8", width: "9.4", height: "9", rx: "1.8",
					stroke: "currentColor", strokeWidth: "1.2",
				}),
				h("path", {
					key: "l1", d: "M4.7 8.2h4.4",
					stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round",
				}),
				h("path", {
					key: "l2", d: "M4.7 10.6h3.1",
					stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round",
				}),
			]);
		}

		/** 卡片里的错误文案：remote 可能 reject 一个字符串 / 对象 / Error，尽量展开成人话。 */
		function pluginCardErr(e) {
			if (!e) return t("pluginCard.saveFailed");
			if (e instanceof Error) return e.message || String(e);
			try {
				const s = JSON.stringify(e);
				return s && s !== "{}" ? s.slice(0, 200) : String(e);
			} catch (_) {
				return String(e);
			}
		}

		/**
		 * 插件详情页的「侧栏入口」卡片（1.8.2）。
		 *
		 * 槽位 `plugins.bundle.config` 是 keyed 槽（key = 包名），宿主在 sage-mem 的插件页里、
		 * description 与「包含的组件」行之间渲染它，ownerProps 为 `{ view: "summary" | "page" }`：
		 *   - summary：标题下的一块摘要位 —— 这里返回 null，不在摘要位重复渲染；
		 *   - page：详情页本体（本卡片自己写设置，所以宿主给的是 page）。
		 *
		 * 数据与设置页同一个来源（remote.memory 的 getSettings / setSettings），切换成功后调
		 * 模块级 `setSidebarEntry`：**立即**增删侧栏图标，不需要刷新 / 重启。
		 * 勾选态一律由服务端回传的 settings 派生 —— 失败时什么都不改，于是自动回到原值。
		 */
		function SidebarEntryConfigCard(props) {
			const ctx = props && props.ctx;
			// 必须走 stableRemote：真实宿主里 ctx.get() 每次返回新对象，进依赖数组会无限重跑。
			const remote = stableRemote(ctx, "remote.memory");
			const sOn = react.useState(true); const on = sOn[0], setOn = sOn[1];
			const sBusy = react.useState(false); const busy = sBusy[0], setBusy = sBusy[1];
			const sErr = react.useState(""); const err = sErr[0], setErr = sErr[1];

			react.useEffect(function () {
				if (!remote || typeof remote.getSettings !== "function") return undefined;
				let alive = true;
				Promise.resolve(remote.getSettings()).then(function (out) {
					if (!alive) return;
					const loaded = unwrap(out) || {};
					// 旧宿主没有 ui 字段 / 值不是布尔 → 保持默认「开」，不弹错、不阻塞界面。
					if (loaded.ui && typeof loaded.ui.sidebarEntry === "boolean") setOn(loaded.ui.sidebarEntry);
				}, function () {
					// 读设置失败也按「开」显示：这里只是插件页的一张卡片，不该因为它报红。
				});
				return function () { alive = false; };
			}, [remote]);

			// summary 位不渲染（hooks 必须在上方无条件调用完再返回，规则与顺序都不变）。
			if (props && props.view === "summary") return null;

			function toggle(next) {
				if (busy) return;
				if (!remote || typeof remote.setSettings !== "function") {
					setErr(t("pluginCard.noSetSettings"));
					return;
				}
				setBusy(true); setErr("");
				Promise.resolve(remote.setSettings({ ui: { sidebarEntry: !!next } })).then(function (out) {
					setBusy(false);
					// setSettings 是 { ok, settings, restartRequired } 形状，不要过 unwrap。
					if (out && out.ok === false) {
						setErr(out.error || t("error.saveRejected"));
						return;
					}
					const settings = out && out.settings ? out.settings : null;
					const applied = settings && settings.ui && typeof settings.ui.sidebarEntry === "boolean"
						? settings.ui.sidebarEntry
						: !!next;
					setOn(applied);
					// 写盘成功之后才动槽位：设置没落盘时界面不该先变一个样。
					setSidebarEntry(!!next);
				}, function (e) {
					setBusy(false);
					setErr(pluginCardErr(e));
				});
			}

			return h("div", { className: "smem-plugin-card" }, [
				h("div", { className: "smem-plugin-card-head", key: "h" }, [
					h("span", { className: "smem-plugin-card-title", key: "t" }, t("pluginCard.title")),
					h("span", { className: "smem-plugin-card-status", key: "s" }, on ? t("pluginCard.on") : t("pluginCard.off")),
				]),
				h("label", { className: "smem-check smem-plugin-card-check", key: "row" }, [
					h("input", {
						type: "checkbox", key: "c",
						checked: on,
						disabled: busy,
						onChange: function (e) { toggle(!!(e.target && e.target.checked)); },
					}),
					h("span", { key: "l" }, t("pluginCard.label")),
				]),
				h("div", { className: "smem-plugin-card-note", key: "n" },
					t("pluginCard.note")),
				err ? h("div", { className: "smem-plugin-card-err", key: "e" }, err) : null,
			]);
		}

		/**
		 * 返回会话：宿主 layout 服务的 `selectPanel(null)` 就是把中央主区还给 Conversation。
		 * 取不到 layout（旧外壳 / 测试环境）时是**空操作**，不影响页面其它部分。
		 */
		function backToConversation() {
			try {
				const layout = sidebarCtx && typeof sidebarCtx.get === "function" ? sidebarCtx.get("layout") : null;
				if (layout && typeof layout.selectPanel === "function") layout.selectPanel(null);
			} catch (e) {
				// 返回按钮不能因为宿主差异把整页搞崩
			}
		}

		/** 中央主区的整页：页顶「返回会话」+ 复用设置页那份 Section。 */
		function MemoryPanelPage(props) {
			const onBack = typeof props.backToConversation === "function" ? props.backToConversation : backToConversation;
			return h("div", { className: "smem-page" }, [
				h("div", { className: "smem-page-top", key: "top" }, [
					h("button", {
						type: "button", className: "smem-page-back", key: "back",
						title: t("page.back"), onClick: onBack,
					}, [
						h("svg", {
							key: "i", width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
						}, h("path", {
							d: "M10 3.5 5.5 8l4.5 4.5", stroke: "currentColor", strokeWidth: "1.6",
							strokeLinecap: "round", strokeLinejoin: "round",
						})),
						h("span", { key: "l" }, t("page.back")),
					]),
				]),
				h(Section, { key: "sec", ...props, ctx: sidebarCtx }),
			]);
		}

		/** 注册两个槽位（幂等：已经注册就什么都不做）。 */
		function registerSidebarEntry() {
			if (sidebarDispose !== null || !sidebarCtx) return true;
			const ctx = sidebarCtx;
			const handles = [];
			// 侧栏 list 槽：只给图标与 label，按钮由宿主自己画。
			handles.push(ctx.slots.inject("sidebar.panellist", function () {
				return ctx.slots.register({
					name: "sidebar.panellist",
					id: SIDEBAR_ENTRY_ID,
					order: 20,
					label: () => t("sidebar.label"),
				}, SidebarEntryIcon);
			}));
			// 中央主区 keyed 槽：key 与侧栏 id 相同；inject 面把「返回会话」交给页面组件。
			handles.push(ctx.slots.inject("main", function () {
				return ctx.slots.register({
					name: "main",
					key: SIDEBAR_ENTRY_ID,
					inject: function () { return { backToConversation: backToConversation }; },
				}, MemoryPanelPage);
			}));
			sidebarDispose = handles;
			return true;
		}

		/**
		 * 开 / 关侧栏入口（立即生效，不改设置文件 —— 写盘由设置页负责）。
		 *
		 * 关闭顺序是**反序**：先摘 main、再摘 sidebar，避免宿主在「侧栏条目还在、main 已没了」
		 * 的中间态里去解析一个不存在的 key（官方契约里那会抛错）。
		 */
		function setSidebarEntry(enabled) {
			if (enabled) return registerSidebarEntry();
			const handles = sidebarDispose;
			sidebarDispose = null;
			if (Array.isArray(handles)) {
				for (let i = handles.length - 1; i >= 0; i--) {
					const dispose = handles[i];
					if (typeof dispose !== "function") continue;
					try { dispose(); } catch (e) { /* 注销失败也不该把开关卡死在「已注册」状态 */ }
				}
			}
			return true;
		}
