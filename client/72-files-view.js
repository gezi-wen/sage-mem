		// ── 文件列表这一屏（1.5.3 从 Section 里抽出；D23 计划的 72 片）──────────
		// 只负责「按状态/筛选把卡片摆出来 + 四种空态」；状态、筛选语义、动作回调全部由 Section 传。
		// 抽出的判据：它是 Section 里最大的一块纯渲染，而卡片组件（Card / ArchivedCard）本来就在 50 共享层。
		function FilesView(props) {
			const { loading, totalCount, openAdd, createIndexSkeleton, statusFilter, setStatusFilter, items, archiveItems, filtered, setTypeFilter, setTagFilter, setQuery, busy, restoring, archDelete, archEdit, archLoad, archSaving, archText, setArchText, openArchEdit, saveArchEdit, cancelArchEdit, restoreFile, setArchDelete, setArchEdit, deleteArchivedFile, expanded, deleting, archiving, archiveReason, setArchiveReason, setArchiving, setDeleting, confirmArchive, toggleLock, openEdit, confirmDelete } = props;
			let filesView;
			if (loading && totalCount === 0) {
				filesView = h("div", { className: "smem-skeleton", key: "loading", "data-loading": "1" }, [0, 1, 2].map(function (i) {
					return h("div", { className: "smem-skeleton-row", key: i });
				}));
			} else if (totalCount === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, "还没有记忆文件。对话中值得记住的事会写到这里，也可以手动写入。"),
					h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "add", onClick: openAdd }, "+ 添加记忆"),
					h("button", { type: "button", className: "smem-btn", key: "idx", title: "写入一份 MEMORY.md 索引骨架（已有索引不会覆盖）", onClick: createIndexSkeleton }, "建立索引骨架"),
				]);
			} else if (statusFilter === "archived" && archiveItems.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, "档案馆是空的 —— 在活动记忆那张卡上点「归档」，它就会收到这里。"),
					h("button", { type: "button", className: "smem-btn", key: "back", onClick: function () { setStatusFilter("active"); } }, "回文件列表"),
				]);
			} else if (statusFilter === "active" && items.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, "活动记忆是空的 —— 状态筛到「已归档」还能捞出 " + archiveItems.length + " 条。"),
					h("button", { type: "button", className: "smem-btn", key: "go", onClick: function () { setStatusFilter("archived"); } }, "切到已归档"),
				]);
			} else if (filtered.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, "没有符合搜索或筛选条件的文件。"),
					h("button", { type: "button", className: "smem-btn", key: "clear", onClick: function () { setStatusFilter("all"); setTypeFilter([]); setTagFilter([]); setQuery(""); } }, "清除筛选"),
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
						onToggle: function (file) {
							const nx = {};
							nx[file] = !expanded[file];
							setExpanded(Object.assign({}, expanded, nx));
						},
						onEdit: openEdit,
						onAskDelete: function (file) { setDeleting(file); setArchiving(null); },
						onCancelDelete: function () { setDeleting(null); },
						onConfirmDelete: confirmDelete,
					});
				}));
				filesView = statusFilter === "archived"
					? [
							h("div", { className: "smem-ar-banner", key: "banner" },
								"档案馆里的记忆不参与检索与星图，原文仍在记忆目录的 archive/ 下 —— 恢复后它就回到活动列表；" +
								"「编辑」是原样文本编辑，改完存回同一份文件；「彻底删除」会真的从 archive/ 里删掉它（不可恢复，删除前还要再确认一次）。"),
							list,
						]
					: list;
			}

			return filesView;
		}

