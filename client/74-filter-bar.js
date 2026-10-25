		// ── 筛选条（1.5.2 从 Section 里抽出）────────────────────────────────
		// 只接收 props、只渲染；筛选语义（哪些项互斥、怎么 AND/OR）仍在 Section 里算好再传进来。
		// 抽出来的收益是 Section 少了 60 行 UI 细节，而筛选条可以单独看、单独改（比如以后再加
		// 「只显示锁定」这类维度），不用在一千行的 Section 里翻。
		function FilterBar(props) {
			const { hasFilter, statusFilter, setStatusFilter, totalCount, items, archiveItems, statusItems, typeFilter, setTypeFilter, typeList, typeCounts, tagList, tagShown, tagHiddenCount, tagCounts, tagFilter, setTagFilter, tagOpen, setTagOpen, TAG_VISIBLE_MAX, query, setQuery, toggleIn, sumItem } = props;
			return h("div", { className: "smem-filters" }, [
							hasFilter
								? h("div", { className: "smem-filter-summary", key: "sum" }, [
										statusFilter !== "all"
											? sumItem(t("filter.sumStatus", { value: statusFilter === "active" ? t("filter.active") : t("filter.archived") }), function () { setStatusFilter("all"); })
											: null,
										typeFilter.map(function (typeId) {
											return sumItem(t("filter.sumType", { value: typeLabel(typeId) }), function () { toggleIn(setTypeFilter, typeId); });
										}),
										tagFilter.map(function (g) {
											return sumItem(t("filter.sumTag", { value: g }), function () { toggleIn(setTagFilter, g); });
										}),
										query.trim() ? sumItem(t("filter.sumQuery", { value: query.trim() }), function () { setQuery(""); }) : null,
										h("button", {
											type: "button", className: "smem-sum-clear", key: "all",
											onClick: function () { setStatusFilter("all"); setTypeFilter([]); setTagFilter([]); setQuery(""); },
										}, t("filter.clearAll")),
									])
								: null,
							h("span", { className: "smem-filters-label", key: "lst" }, t("filter.statusLabel")),
							h("button", {
								type: "button", key: "st-all", className: "smem-chip",
								"data-on": statusFilter === "all" ? "1" : "0",
								title: t("filter.allTitle"),
								onClick: function () { setStatusFilter("all"); },
							}, [t("filter.all"), h("span", { className: "smem-chip-n", key: "n" }, String(totalCount))]),
							h("button", {
								type: "button", key: "st-active", className: "smem-chip",
								"data-on": statusFilter === "active" ? "1" : "0",
								title: t("filter.activeTitle"),
								onClick: function () { setStatusFilter("active"); },
							}, [t("filter.active"), h("span", { className: "smem-chip-n", key: "n" }, String(items.length))]),
							h("button", {
								type: "button", key: "st-arch", className: "smem-chip",
								"data-on": statusFilter === "archived" ? "1" : "0",
								title: t("filter.archivedTitle"),
								onClick: function () { setStatusFilter("archived"); },
							}, [t("filter.archived"), h("span", { className: "smem-chip-n", key: "n" }, String(archiveItems.length))]),
							h("span", { className: "smem-sep", key: "sep0" }),
							h("span", { className: "smem-filters-label", key: "lt" }, t("filter.typeLabel")),
							h("button", {
								type: "button", key: "all", className: "smem-chip",
								"data-on": typeFilter.length ? "0" : "1",
								onClick: function () { setTypeFilter([]); },
							}, [t("filter.all"), h("span", { className: "smem-chip-n", key: "n" }, String(statusItems.length))]),
							typeList.map(function (typeId) {
								return h("button", {
									type: "button", key: typeId, className: "smem-chip",
									"data-on": typeFilter.indexOf(typeId) >= 0 ? "1" : "0",
									onClick: function () { toggleIn(setTypeFilter, typeId); },
								}, [typeLabel(typeId), h("span", { className: "smem-chip-n", key: "n" }, String(typeCounts[typeId]))]);
							}),
							tagList.length ? h("span", { className: "smem-sep", key: "sep" }) : null,
							tagList.length ? h("span", { className: "smem-filters-label", key: "lgt" }, t("filter.tags")) : null,
							tagShown.map(function (g) {
								return h("button", {
									type: "button", key: "tag-" + g, className: "smem-chip",
									"data-on": tagFilter.indexOf(g) >= 0 ? "1" : "0",
									onClick: function () { toggleIn(setTagFilter, g); },
								}, ["#" + g, h("span", { className: "smem-chip-n", key: "n" }, String(tagCounts[g]))]);
							}),
							tagList.length > TAG_VISIBLE_MAX
								? h("button", {
										type: "button", key: "moretag", className: "smem-btn",
										title: tagOpen ? t("filter.collapseTags") : t("filter.moreTagsTitle"),
										onClick: function () { setTagOpen(!tagOpen); },
									}, tagOpen ? t("filter.collapseTags") : t("filter.moreTags", { count: String(tagHiddenCount) }) )
								: null,
							hasFilter
								? h("button", {
										type: "button", key: "clear", className: "smem-btn",
										onClick: function () { setStatusFilter("all"); setTypeFilter([]); setTagFilter([]); setQuery(""); },
									}, t("filter.clear"))
								: null,

			]);
		}

