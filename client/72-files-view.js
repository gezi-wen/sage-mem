		// ── 文件列表这一屏（1.5.3 从 Section 里抽出；D23 计划的 72 片）──────────
		// 只负责「按状态/筛选把卡片摆出来 + 四种空态」；状态、筛选语义、动作回调全部由 Section 传。
		// 抽出的判据：它是 Section 里最大的一块纯渲染，而卡片组件（Card / ArchivedCard）本来就在 50 共享层。
		function FilesView(props) {
			const { loading, totalCount, openAdd, createIndexSkeleton, statusFilter, setStatusFilter, items, archiveItems, filtered, setTypeFilter, setTagFilter, setQuery, busy, restoring, archDelete, archEdit, archLoad, archSaving, archText, setArchText, openArchEdit, saveArchEdit, cancelArchEdit, restoreFile, setArchDelete, setArchEdit, deleteArchivedFile, expanded, onToggleExpanded, deleting, archiving, archiveReason, setArchiveReason, setArchiving, setDeleting, confirmArchive, toggleLock, openEdit, confirmDelete } = props;
			let filesView;
			if (loading && totalCount === 0) {
				filesView = h("div", { className: "smem-skeleton", key: "loading", "data-loading": "1" }, [0, 1, 2].map(function (i) {
					return h("div", { className: "smem-skeleton-row", key: i });
				}));
			} else if (totalCount === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, t("files.emptyTitle")),
					h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "add", onClick: openAdd }, t("action.add")),
					h("button", { type: "button", className: "smem-btn", key: "idx", title: t("files.skeletonTitle"), onClick: createIndexSkeleton }, t("files.skeleton")),
				]);
			} else if (statusFilter === "archived" && archiveItems.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, t("files.archiveEmpty")),
					h("button", { type: "button", className: "smem-btn", key: "back", onClick: function () { setStatusFilter("active"); } }, t("files.backToFiles")),
				]);
			} else if (statusFilter === "active" && items.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, t("files.activeEmpty", { count: archiveItems.length })),
					h("button", { type: "button", className: "smem-btn", key: "go", onClick: function () { setStatusFilter("archived"); } }, t("files.goArchived")),
				]);
			} else if (filtered.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, t("files.noMatch")),
					h("button", { type: "button", className: "smem-btn", key: "clear", onClick: function () { setStatusFilter("all"); setTypeFilter([]); setTagFilter([]); setQuery(""); } }, t("filter.clear")),
				]);
			} else {
				const list = h("div", { className: "smem-list", key: "list" }, filtered.map(function (it) {
					if (it.archived === true) {
						return h(ArchivedCard, {
							key: it.file,
							item: it,
							busy: busy,
							restoring: restoring === it.file,
							deleting: archDelete === it.file,
							editing: archEdit === it.file,
							loading: archLoad && archEdit === it.file,
							saving: archSaving && archEdit === it.file,
							text: archText,
							onText: setArchText,
							onEdit: openArchEdit,
							onSave: saveArchEdit,
							onCancel: cancelArchEdit,
							onRestore: restoreFile,
							// 两个「危险动作的确认」互斥：问到一半又去改文本，界面就会同时摆两个确认条。
							onAskDelete: function (file) { setArchDelete(file); setArchEdit(null); },
							onCancelDelete: function () { setArchDelete(null); },
							onConfirmDelete: deleteArchivedFile,
						});
					}
					return h(Card, {
						key: it.file,
						item: it,
						expanded: !!expanded[it.file],
						deleting: deleting === it.file,
						archiving: archiving === it.file,
						archiveReason: archiveReason,
						busy: busy,
						onArchiveReason: setArchiveReason,
						onAskArchive: function (file) { setArchiving(file); setArchiveReason(""); setDeleting(null); },
						onCancelArchive: function () { setArchiving(null); setArchiveReason(""); },
						onConfirmArchive: confirmArchive,
						onToggleLock: toggleLock,
						// 展开 / 收起是**业务回调**（Q16）：卡片只上报「点了哪张」，
						// 合并逻辑归 Section。旧版这里引用旧 Section 闭包里的 `setExpanded` ——
						// 拆件后它不在本函数作用域，点击即 ReferenceError: setExpanded is not defined。
						onToggle: onToggleExpanded,
						onEdit: openEdit,
						onAskDelete: function (file) { setDeleting(file); setArchiving(null); },
						onCancelDelete: function () { setDeleting(null); },
						onConfirmDelete: confirmDelete,
					});
				}));
				filesView = statusFilter === "archived"
					? [
							h("div", { className: "smem-ar-banner", key: "banner" }, t("files.archiveIntro")),
							list,
						]
					: list;
			}

			// 2.12.0：初始记忆卡片由**装配层**（Section）造好传进来（`guideCard`）。
			// 这一屏保持「只吃 props 的纯渲染」：不 import 卡片、也不判断库空不空 ——
			// 于是它单独被渲染（比如 Q16 那套只拼 05+55+50+72 的量具）时照样成立。
			// 没有卡片时**原样返回**（不包数组）：旧调用点拿到的形状必须与 2.11.1 一致。
			if (!props.guideCard) return filesView;
			const body = Array.isArray(filesView) ? filesView : [filesView];
			return [props.guideCard].concat(body);
		}

