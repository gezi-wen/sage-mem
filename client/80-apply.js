		// ⚠️ 不把 `layout` 写进 inject：它是**可选**依赖（官方 inspect：optional access =
		// `ctx.get("layout")` + 判空；hardDependency 才是 inject）。写进 inject 会让旧外壳
		// 缺这个服务时整个 client 插件不 apply —— 连带丢掉设置页。返回会话优先用宿主给的
		// `props.backToConversation`，layout 只是兜底。
		const inject = ["slots", "remote"];

		/**
		 * Client 插件：$mount strict remote contribution（第三方 remote 不在
		 * 宿主的固定 remote 清单里，必须自己挂），再注册设置页签 / 侧栏入口。
		 */
		async function apply(ctx) {
			await ctx.remote.$mount(TYPERT_REMOTE);
			// 样式注入（参照官方 client bundle 的 data-plugin-css 约定，幂等）
			const tagId = "sage-mem/settings.css";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "sage-mem";
				tag.dataset.pluginCss = tagId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
			setupI18n(ctx);
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "sage-mem",
						order: 20,
						label: () => t("section.label"),
						// 声明「记忆星图」子槽：sage-starmap 向它注入星空视图，
						// 记忆管理页用 renderSlot 渲染。声明 children 后 shell 才会
						// 向本 section 组件传入 renderSlot。
						children: { "settings.memory.starmap": { kind: "list", scope: "root" } },
					},
					(props) => react.createElement(Section, { ...props, ctx }),
				),
			);
			// ── 1.8.0 侧栏入口：先记住 ctx，再读一次设置决定注不注册 ──────────────
			// 设置页 section **永远**保留（关闭侧栏入口只是少一个入口，不是少一个设置页）。
			// 读失败 / 旧宿主没有 ui 字段 / 值坏掉 → 一律按「开」处理，绝不阻塞界面。
			sidebarCtx = ctx;
			let sidebarEnabled = true;
			try {
				const mem = typeof ctx.get === "function" ? ctx.get("remote.memory") : null;
				if (mem && typeof mem.getSettings === "function") {
					const loaded = unwrap(await mem.getSettings()) || {};
					if (loaded.ui && loaded.ui.sidebarEntry === false) sidebarEnabled = false;
				}
			} catch (e) {
				sidebarEnabled = true;
			}
			setSidebarEntry(sidebarEnabled);

			// ── 1.8.2 插件详情页的「侧栏入口」卡片 ──────────────────────────────
			// `plugins.bundle.config` 是 keyed 槽，key = 本 bundle 的 **package name**（sage-mem）。
			// 宿主在插件页的 description 与「包含的组件」行之间渲染它；ownerProps 形如
			// `{ view: "summary" | "page" }`，卡片里自己再判一次（summary 返回 null）。
			//
			// ⚠️ 这个槽 0.1.7+ 才有。旧宿主上 inject 会**抛错**，所以必须整段 try/catch ——
			// 否则一个可选的插件页卡片会把设置页与侧栏入口一起拖垮（整个 client 插件不 apply）。
			// 放在 apply 最后：即使这里因宿主差异出问题，前面的界面已经挂上去了。
			try {
				if (ctx.slots && typeof ctx.slots.inject === "function") {
					ctx.slots.inject("plugins.bundle.config", function () {
						return ctx.slots.register({
							name: "plugins.bundle.config",
							key: "sage-mem",
						}, function (props) {
							return react.createElement(SidebarEntryConfigCard, { ...(props || {}), ctx });
						});
					});
				}
			} catch (e) {
				// 旧宿主没有这个槽 / 不接受注册：静默跳过，绝不影响其余界面。
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
