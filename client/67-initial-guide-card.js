		// ── 初始记忆卡片（2.12.0）：把 `66-initial-guide.js` 的提示词摊开、复制、下载 ──
		//
		// 三条约束（都由这个文件负责，正文不掺和）：
		//   1. **不写盘**：卡片只读提示词，一个记忆文件都不碰 —— 「会不会覆盖我已有的记忆」
		//      这个问题因此不存在。真正动笔的是会话里的 agent，它能先看见用户库里有什么。
		//   2. **复制失败不许静默**（D25）：剪贴板不可用时走 `PromptFallbackModal` 手抄；
		//      下载不可用时同样把文本摊出来 —— 那颗按钮点了没反应是最坏的形态。
		//   3. **提醒弹窗挂在 `.smem-root` 直属层**：`.smem-view` 有进场 transform，
		//      `position:fixed` 会被那个祖先改写定位。所以卡片只**上报**事件，
		//      弹窗由 Section 在根层渲染（与 2.6.0 的复制提示词同一套壳）。
		//
		// 空库自动展开、老库默认收起：卡片是给「刚装完、库还空着」的人用的，
		// 已经有内容的人不该每次进来都看见一大段说明。

		/** 卡片的展开状态：空库默认展开（这就是他们要做的事），有记忆时默认收起。 */
		function InitialGuideCard(props) {
			const empty = props && props.empty === true;
			const sOpen = react.useState(empty); const open = sOpen[0], setOpen = sOpen[1];
			const sCopied = react.useState(false); const copied = sCopied[0], setCopied = sCopied[1];
			const built = buildInitialGuide();

			function copy() {
				copyPromptText(built.text).then(function (ok) {
					if (ok) {
						setCopied(true);
						if (props && typeof props.onCopied === "function") props.onCopied();
						return;
					}
					// 失败：把文本交回上层摊出来（不在这里渲染模态 —— 见文件头第 3 条）。
					if (props && typeof props.onCopyFailed === "function") props.onCopyFailed(built.text);
				});
			}

			/** 下载成 .md：走 Blob + 临时 `<a download>`；任何一步不可用都退回复制兜底。 */
			function download() {
				const fallback = function () {
					if (props && typeof props.onCopyFailed === "function") props.onCopyFailed(built.text);
				};
				try {
					if (typeof document === "undefined" || !document || typeof document.createElement !== "function" ||
						typeof Blob !== "function" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
						fallback();
						return;
					}
					const url = URL.createObjectURL(new Blob([built.text], { type: "text/markdown;charset=utf-8" }));
					const a = document.createElement("a");
					a.href = url;
					a.download = built.file;
					document.body.appendChild(a);
					if (typeof a.click === "function") a.click();
					document.body.removeChild(a);
					URL.revokeObjectURL(url);
				} catch (e) {
					fallback();
				}
			}

			const status = copied
				? t("guide.status.copied")
				: (empty ? t("guide.status.empty") : t("guide.status.filled"));

			return h("div", { className: "smem-guide smem-module-card" }, [
				h("div", { className: "smem-modcard-head", key: "head" }, [
					h("span", { className: "smem-modcard-title", key: "t" }, t("guide.title")),
					h("span", { className: "smem-modcard-status", key: "s" }, status),
					h("button", {
						type: "button", className: "smem-btn", key: "x",
						"aria-expanded": open ? "true" : "false",
						onClick: function () { setOpen(!open); },
					}, open ? t("guide.collapse") : t("guide.expand")),
				]),
				open
					? h("div", { className: "smem-guide-body", key: "body" }, [
							h("div", { className: "smem-autodream-note", key: "why1" }, t("guide.why1")),
							h("div", { className: "smem-autodream-note", key: "why2" }, t("guide.why2")),
							h("pre", { className: "smem-guide-preview", key: "preview" }, built.text),
							h("div", { className: "smem-guide-actions", key: "act" }, [
								h("button", {
									type: "button", className: "smem-btn smem-btn-primary", key: "copy",
									onClick: copy,
								}, copied ? t("guide.copy.again") : t("guide.copy")),
								h("button", { type: "button", className: "smem-btn", key: "dl", onClick: download }, t("guide.download")),
								h("span", { className: "smem-muted", key: "hint" }, t("guide.hint")),
							]),
						])
					: h("div", { className: "smem-autodream-note", key: "closed" }, t("guide.closedNote")),
			]);
		}

		/**
		 * 复制成功后的提醒弹窗（渲染在 `.smem-root` 直属层，由 Section 挂）。
		 *
		 * 为什么要弹一下：复制成功是**没有视觉证据**的动作（剪贴板不可见），而下一步
		 * 「粘到会话里发给 agent」是用户必须自己做的事 —— 不提醒，用户会以为插件已经建好了。
		 */
		function InitialGuideNotice(props) {
			return h("div", { className: "smem-modal-host" }, [
				h("div", { className: "smem-modal-scrim", key: "scrim", onClick: props.onClose }),
				h("div", {
					className: "smem-modal", key: "m",
					role: "dialog", "aria-modal": "true",
					"aria-label": t("guide.notice.title"),
				}, [
					h("div", { className: "smem-modal-title", key: "t" }, t("guide.notice.title")),
					h("div", { className: "smem-modal-body", key: "b" }, [
						h("div", { key: "1" }, t("guide.notice.step1")),
						h("div", { key: "2", style: { marginTop: "6px" } }, t("guide.notice.step2")),
						h("div", { className: "smem-ar-hint", key: "3", style: { marginTop: "8px" } }, t("guide.notice.hint")),
					]),
					h("div", { className: "smem-modal-foot", key: "f" }, [
						h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "ok", onClick: props.onClose }, t("guide.notice.ok")),
					]),
				]),
			]);
		}
