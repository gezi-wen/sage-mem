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

		/** 侧栏图标：内联 SVG、currentColor、细线 —— 不引外部图片/字体，跟随宿主明暗主题。 */
		function SidebarEntryIcon(props) {
			const edge = typeof props.size === "number" && props.size > 0 ? props.size : 16;
			return h("svg", {
				width: edge, height: edge, viewBox: "0 0 16 16", fill: "none",
				"aria-hidden": "true", focusable: "false",
			}, [
				h("rect", {
					key: "b", x: "2", y: "2.5", width: "12", height: "11", rx: "2.2",
					stroke: "currentColor", strokeWidth: "1.2",
				}),
				h("path", {
					key: "l1", d: "M5.2 6.2h5.6",
					stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round",
				}),
				h("path", {
					key: "l2", d: "M5.2 8.4h5.6",
					stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round",
				}),
				h("path", {
					key: "l3", d: "M5.2 10.6h3.2",
					stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round",
				}),
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
						title: "返回会话", onClick: onBack,
					}, [
						h("svg", {
							key: "i", width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
						}, h("path", {
							d: "M10 3.5 5.5 8l4.5 4.5", stroke: "currentColor", strokeWidth: "1.6",
							strokeLinecap: "round", strokeLinejoin: "round",
						})),
						h("span", { key: "l" }, "返回会话"),
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
					label: "记忆管理",
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
