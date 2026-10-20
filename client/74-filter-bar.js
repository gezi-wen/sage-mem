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
											? sumItem("状态：" + (statusFilter === "active" ? "活动中" : "已归档"), function () { setStatusFilter("all"); })
											: null,
										typeFilter.map(function (t) {
											return sumItem("类型：" + (TYPE_LABEL[t] || t), function () { toggleIn(setTypeFilter, t); });
										}),
										tagFilter.map(function (g) {
											return sumItem("标签：#" + g, function () { toggleIn(setTagFilter, g); });
										}),
										query.trim() ? sumItem("搜索：" + query.trim(), function () { setQuery(""); }) : null,
										h("button", {
											type: "button", className: "smem-sum-clear", key: "all",
											onClick: function () { setStatusFilter("all"); setTypeFilter([]); setTagFilter([]); setQuery(""); },
										}, "清除全部"),
									])
								: null,
							h("span", { className: "smem-filters-label", key: "lst" }, "状态"),
							h("button", {
								type: "button", key: "st-all", className: "smem-chip",
								"data-on": statusFilter === "all" ? "1" : "0",
								title: "活动与已归档一起看（归档条走灰色）",
								onClick: function () { setStatusFilter("all"); },
							}, ["全部", h("span", { className: "smem-chip-n", key: "n" }, String(totalCount))]),
							h("button", {
								type: "button", key: "st-active", className: "smem-chip",
								"data-on": statusFilter === "active" ? "1" : "0",
								title: "正在参与检索与星图的记忆",
								onClick: function () { setStatusFilter("active"); },
							}, ["活动中", h("span", { className: "smem-chip-n", key: "n" }, String(items.length))]),
							h("button", {
								type: "button", key: "st-arch", className: "smem-chip",
								"data-on": statusFilter === "archived" ? "1" : "0",
								title: "已收进档案馆：不参与检索与星图，可编辑 / 恢复",
								onClick: function () { setStatusFilter("archived"); },
							}, ["已归档", h("span", { className: "smem-chip-n", key: "n" }, String(archiveItems.length))]),
							h("span", { className: "smem-sep", key: "sep0" }),
							h("span", { className: "smem-filters-label", key: "lt" }, "类型"),
							h("button", {
								type: "button", key: "all", className: "smem-chip",
								"data-on": typeFilter.length ? "0" : "1",
								onClick: function () { setTypeFilter([]); },
							}, ["全部", h("span", { className: "smem-chip-n", key: "n" }, String(statusItems.length))]),
							typeList.map(function (t) {
								return h("button", {
									type: "button", key: t, className: "smem-chip",
									"data-on": typeFilter.indexOf(t) >= 0 ? "1" : "0",
									onClick: function () { toggleIn(setTypeFilter, t); },
								}, [TYPE_LABEL[t] || t, h("span", { className: "smem-chip-n", key: "n" }, String(typeCounts[t]))]);
							}),
							tagList.length ? h("span", { className: "smem-sep", key: "sep" }) : null,
							tagList.length ? h("span", { className: "smem-filters-label", key: "lgt" }, "标签") : null,
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
										title: tagOpen ? "收起标签" : "还有一些标签没显示",
										onClick: function () { setTagOpen(!tagOpen); },
									}, tagOpen ? "收起标签" : ("更多标签 (" + String(tagHiddenCount) + ")") )
								: null,
							hasFilter
								? h("button", {
										type: "button", key: "clear", className: "smem-btn",
										onClick: function () { setStatusFilter("all"); setTypeFilter([]); setTagFilter([]); setQuery(""); },
									}, "清除筛选")
								: null,

			]);
		}

