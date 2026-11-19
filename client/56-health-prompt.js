		// ── 库健康：把「要处理的事」整理成能给智能体的提示词（2.6.0）──────────
		//
		// 为什么是「复制」而不是「一键修」：体检与冲突都是只读面 —— 改哪一条、标哪一方
		// 由人定。智能体该拿到的是一份**可执行的清单**，而不是让面板替人去改文件。
		//
		// 为什么生成放在客户端、不新增 remote：整段文本只由「界面已经拿到的体检 / 冲突
		// 数据」拼出来，宿主半身一个字段都不用加 —— 升级界面不需要重启宿主，也不牵动
		// typert 契约（那套 manifest 按包名缓存、进程内不失效，加 wire 参数最容易出事）。
		//
		// **一颗按钮、两段内容**（2026-11-10 定）：界面只留一颗「复制修复提示词」，
		// 但提示词里必须把 A（体检问题：要修）与 B（待裁决的矛盾：只判断）**分开写清楚** ——
		// 两段的纪律是相反的，混成一段智能体很容易把「只判断」做成「顺手改了」。
		//
		// 提示词正文**暂只出中文**：体检卡与冲突卡本身仍是硬编码中文（D31 遗留），
		// 半翻译的提示词只会更怪。按钮文案 / title / 提示条走 i18n，正文等 i18n 批次
		// 连同那两卡一起翻（见 docs/decisions.md D40）。

		/** 每类最多列多少条：再多就让智能体自己看面板，不把剪贴板撑爆。 */
		const AUDIT_PROMPT_MAX_ITEMS = 50;

		/**
		 * 体检的九类硬问题（**唯一一份**：体检面板的分节与提示词共用）。
		 *
		 * 面板（`client/50-shared-ui.js` 的 `AuditPanel`）用 `title` + `sub` 渲染成
		 * 「索引悬空（索引里有、文件没了）」，提示词用 `title` + `fix` 渲染成
		 * 「【索引悬空】…怎么改」。**`item` 是两处共用的一份**：面板上看到的每一行，
		 * 就是粘给智能体的那一行 —— 改一处不会只改半边。
		 *
		 * 顺序 = `lib/autodream/audit.js` 里 problems 的计数顺序，别按字母重排。
		 */
		const AUDIT_SECTIONS = [
			{
				field: "dangling", title: "索引悬空", sub: "索引里有、文件没了",
				fix: "索引里有、文件不存在 —— 从索引删掉这一行；若是文件被误删，把文件补回来",
				item: function (x) { return String(x.file == null ? "" : x.file); },
			},
			{
				field: "unlisted", title: "漏索引", sub: "文件在、索引里没有",
				fix: "文件在、索引里没有 —— 在索引里补一行 `- [标题](文件.md) — 一句话`",
				item: function (x) { return String(x.file == null ? "" : x.file); },
			},
			{
				// 2.14.0：这一类**已经算进 problems** 却一直没有渲染位置 —— 于是「问题 N」
				// 徽标亮着、清单里一行都没有（只有大小写敏感的卷上才会出现，但一旦出现就是哑的）。
				field: "indexConflicts", title: "索引有多份变体", sub: "同一目录里同时存在多个大小写变体",
				fix: "只保留一份索引（通常是 MEMORY.md），把多余的变体改名或删掉 —— 它们的内容可能不一样，先各自看一眼",
				item: function (x) { return String(x.file == null ? "" : x.file); },
			},
			{
				field: "typeMismatch", title: "type 与前缀对不上", sub: "",
				fix: "本库以前缀为准，改 frontmatter 的 type（确实该换类型的再改文件名）",
				item: function (x) {
					return String(x.file == null ? "" : x.file) +
						" · type=" + String(x.type == null ? "" : x.type) +
						"，文件名前缀=" + String(x.prefix == null ? "" : x.prefix);
				},
			},
			{
				field: "crlf", title: "行尾是 CRLF", sub: "",
				fix: "转成 LF，正文一个字节都不要改",
				item: function (x) { return String(x.file == null ? "" : x.file); },
			},
			{
				field: "brokenLinks", title: "双链断链", sub: "",
				fix: "改指向真实存在的文件名，或去掉链接只留文字",
				item: function (x) {
					return String(x.file == null ? "" : x.file) + " → [[" + String(x.target == null ? "" : x.target) + "]]";
				},
			},
			{
				field: "hashHazards", title: "未加引号的「空格+#」", sub: "",
				fix: "这个值会被 YAML 当注释吞掉 —— 给它加引号",
				item: function (x) {
					return String(x.file == null ? "" : x.file) + " · " + String(x.line == null ? "" : x.line);
				},
			},
			{
				field: "noFrontmatter", title: "没有 frontmatter", sub: "",
				fix: "按该文件的类型补 name / description / metadata",
				item: function (x) { return String(x.file == null ? "" : x.file); },
			},
			{
				field: "unreadable", title: "读不出来", sub: "",
				fix: "先报给我，不要凭猜重写",
				item: function (x) { return String(x.file == null ? "" : x.file); },
			},
			{
				// 归档中途崩溃留下的私有名残留：它不是一条记忆（扫描 / 注入都不认），
				// 但里面可能是用户唯一一份内容 —— 所以要在体检里露头，而不是隐形。
				field: "strays", title: "归档残留", sub: "内容可能还在，请确认后改回 .md 或删除",
				fix: "归档中途崩溃留下的私有名，内容可能还在 —— 先问我，再决定改回 .md 还是删除",
				item: function (x) { return String(x.file == null ? "" : x.file); },
			},
			{
				// 2.14.0：体积这一项原先也不在分节表里 —— force 档计数进了 problems，
				// 面板却没有位置显示是哪几条（与上面 indexConflicts 同一个缺口）。
				// warn / force 都列（面板要看见「该处置了」），但只有 force 进 problems。
				field: "oversize", title: "超线体积", sub: "≥40 KB 必须处置，16 KB 起只提醒",
				fix: "能拆一节就 archive_segment，拆不开就 write_memory 压缩（正文别为了省行删事实）",
				item: function (x) {
					const lv = String(x.level == null ? "" : x.level) === "force" ? "必须处置" : "提醒";
					return String(x.file == null ? "" : x.file) + " · " + fmtSize(typeof x.bytes === "number" ? x.bytes : 0) + " · " + lv;
				},
			},
		];

		/**
		 * 体检的**提示类**（不计入 problems）—— 面板与提示词共用同一份（2.6.0 的教训：
		 * 两处各写一份标题，久了就会出现「面板说 8 条、复制出去只有 6 条」）。
		 *
		 *   · `note` 给面板的一句「为什么不用管 / 该怎么处置」；
		 *   · `fix`  给提示词的行动口径（纪律必须写死：归档不是删除、索引只报不改）。
		 *
		 * 2.14.0 新增两类：孤儿归档件（治理发现的死件）、索引瘦身提案（只报不改）。
		 */
		const AUDIT_HINTS = [
			{
				field: "archivedLinks",
				title: "指向已归档（提示，不计入问题）",
				note: "归档不是删除：这些链接的目标还在档案馆里躺着，恢复它链接就活了 —— 不用改。",
				fix: "归档不是删除，目标还在档案馆里 —— 能改成指向现有活动记忆就改；改不了就保持原样，不要为此恢复归档，也不要删掉链接所在的记忆",
				item: function (x) {
					return String(x.file == null ? "" : x.file) + " → [[" + String(x.target == null ? "" : x.target) + "]]";
				},
			},
			{
				field: "orphans",
				title: "孤儿归档件（提示，不计入问题）",
				note: "「原件已不在」= 这段旧内容所属的那条记忆没了；「内容相同」= 整理时留了两份 —— 恢复还是删，你定。",
				fix: "这两类都**先别动手**：no_source 的先确认原件该不该恢复（可能是有意删掉的）；duplicate 的两份都要读一遍，可能是「新版 + 旧版」而不是重复。拿不准就原样留着，归档件不影响检索",
				item: function (x) {
					const f = String(x.file == null ? "" : x.file);
					if (String(x.kind == null ? "" : x.kind) === "duplicate") {
						return f + " 与 " + String(x.with == null ? "?" : x.with) + " 内容完全相同";
					}
					return f + " ← 原件 " + String(x.from == null ? "?" : x.from) + " 已不在";
				},
			},
			{
				field: "indexProposals",
				title: "索引瘦身提案（只报不改）",
				note: "MEMORY.md 是每轮注入的入口，插件不自动改它 —— 要动就复制修复提示词，按行号改，改前先落一份 .bak。",
				// dangling 与上面「索引悬空」是**同一批条目**（这里只是补上行号），不重复算两件事；
				// 真正只有这里才有的是 long_line（超长行）。
				fix: "只改**下面点到行号**的地方：dangling 那几行与上面「索引悬空」是同一批，这里多给行号，别当成两件事；long_line 那行压成「一句描述 + 指针」。动 MEMORY.md 之前先把它备份成 MEMORY.md.bak-<时间戳>，改完把改动的行贴给我",
				item: function (x) {
					const line = "第 " + String(x.line == null ? "?" : x.line) + " 行";
					if (String(x.kind == null ? "" : x.kind) === "dangling") return line + " 指向不存在的 " + String(x.target == null ? "?" : x.target);
					return line + " " + String(x.chars == null ? "?" : x.chars) + " 字：" + String(x.head == null ? "" : x.head);
				},
			},
		];

		/** 冲突类型 → 中文标签（提示词正文只出中文，所以不走界面那份 i18n 键）。 */
		const CONFLICT_KIND_ZH = {
			contradiction: "矛盾",
			stale_version: "版本冲突", staleVersion: "版本冲突",
			external_change: "外部改动", externalChange: "外部改动",
			unresolved_merge: "合并未完成", unresolvedMerge: "合并未完成",
		};

		/** 统计行里的数字：缺字段写 `?`，别把它渲染成 0（0 是「查过、确实没有」）。 */
		function auditPromptNum(v) {
			return typeof v === "number" && isFinite(v) ? String(v) : "?";
		}

		/**
		 * 把一类条目写进 lines；返回这一波一共列了几条。
		 *
		 * 空类**整节不出现**（面板上不显示的分类，提示词里也不该占位），超过上限截断
		 * 并留一句「还有 N 条」—— 悄悄截断会让智能体以为改完了。
		 */
		function appendPromptGroups(lines, groups, report) {
			let listed = 0;
			groups.forEach(function (g) {
				const raw = report && Array.isArray(report[g.field]) ? report[g.field] : [];
				const items = raw.filter(function (x) { return x && typeof x === "object"; });
				if (!items.length) return;
				lines.push("");
				lines.push("【" + g.title + "】" + g.fix + "（" + items.length + " 条）");
				items.slice(0, AUDIT_PROMPT_MAX_ITEMS).forEach(function (x) {
					lines.push("- " + g.item(x));
				});
				if (items.length > AUDIT_PROMPT_MAX_ITEMS) {
					lines.push("- …（还有 " + (items.length - AUDIT_PROMPT_MAX_ITEMS) + " 条，见面板）");
				}
				listed += items.length;
			});
			return listed;
		}

		/**
		 * A 段（体检问题）的正文行。
		 *
		 * `problems <= 0` 时返回 null：整段不出现，一颗空按钮也不该冒出来。
		 * 返回的是**正文**（统计 + 口径 + 分类 + 收尾），不带自己的开场白 ——
		 * 开场白由 `buildHealthFixPrompt` 统一写，免得合成一颗按钮之后出现两句「请修复」。
		 */
		function auditFixLines(report) {
			const r = report && typeof report === "object" ? report : null;
			if (!r) return null;
			const problems = typeof r.problems === "number" && isFinite(r.problems) ? r.problems : 0;
			/**
			 * 提示类（孤儿归档件 / 索引瘦身提案）里有几条。
			 *
			 * 2.14.0 起这段的门槛从「problems > 0」放宽成「problems > 0 **或** 有提案」——
			 * 否则治理发现的死件与索引超长永远走不到这颗按钮上（它们按设计不进 problems）。
			 */
			const hintCount = AUDIT_HINTS.reduce(function (n, g) {
				const list = Array.isArray(r[g.field]) ? r[g.field] : [];
				return n + list.filter(function (x) { return x && typeof x === "object"; }).length;
			}, 0);
			if (problems <= 0 && hintCount === 0) return null;

			const lines = [];
			// 不在这里写「记忆目录」—— 那是整段提示词的开头（`buildHealthFixPrompt` 统一写一次），
			// 两段各写一遍会在合成后的文本里出现两次同样的路径。
			lines.push(
				"扫描 " + auditPromptNum(r.fileCount) + " 个记忆 · 索引 " + auditPromptNum(r.indexEntries) +
				" 条 · 档案馆 " + auditPromptNum(r.archivedCount) +
				(typeof r.archiveReferenced === "number" ? " 条（被活动记忆引用 " + auditPromptNum(r.archiveReferenced) + " 条）" : " 条") +
				" · 问题合计 " + problems,
			);
			lines.push("");
			lines.push("修复口径：");
			// 工具名写成条件句：聊天会话里的智能体通常只有 search_memory / read_memory，
			// write_memory / archive_memory 属 autodream 工具面 —— 不能假设它一定拿得到。
			lines.push("1. 能直接改就改（有 sage-mem 的 write_memory / archive_memory 就用它们；没有就直接编辑文件），改完把每条的处理结果列给我。");
			lines.push("2. 只改清单里指出的那一点：正文与其它 frontmatter 字段不要顺手动，行尾保持 LF。");
			lines.push("3. 不删记忆：要下线用归档，不要删文件；「归档残留」这一类先问我再动。");
			lines.push("4. 拿不准的（读不出来、type 该怎么统一）先说不确定，不要猜着改。");
			if (problems <= 0) {
				lines.push("5. 本屏**没有硬问题**：下面全是提示与提案（只报不改）。没有我点头之前，一个文件都不要动。");
			}

			const listed = problems > 0 ? appendPromptGroups(lines, AUDIT_SECTIONS, r) : 0;
			const hinted = appendPromptGroups(lines, AUDIT_HINTS, r);
			lines.push("");
			lines.push("改完请自己再核对一遍（能跑 audit_memory 就跑），然后告诉我每条改了什么。");
			return { lines: lines, count: listed + hinted, hard: problems > 0, hints: hinted };
		}

		/**
		 * B 段（待裁决的矛盾）的正文行。
		 *
		 * 只取**待裁决**的记录；一份都没有就返回 null。措辞刻意把裁决权留在人手里
		 * （标失效只写一行 frontmatter，真正点按钮的是我）—— 提示词不是授权书。
		 */
		function conflictFixLines(data) {
			const d = data && typeof data === "object" ? data : null;
			const all = d && Array.isArray(d.items) ? d.items : [];
			const items = all.filter(function (x) { return x && typeof x === "object" && x.status === "open"; });
			if (!items.length) return null;

			const lines = [];
			lines.push("请对每一条：读这两份正文，用一两句话说清「哪一份过时 / 两边说的其实是不同的事」，并给出你的建议 —— 标哪一方失效，还是两边都留着。拿不准就直说不确定。");
			lines.push("");
			items.slice(0, AUDIT_PROMPT_MAX_ITEMS).forEach(function (x, i) {
				const kind = CONFLICT_KIND_ZH[String(x.kind)] || String(x.kind || "矛盾");
				const pair = x.otherFile
					? String(x.file == null ? "" : x.file) + " ↔ " + String(x.otherFile)
					: String(x.file == null ? "" : x.file);
				lines.push((i + 1) + ". " + kind + " · " + pair + "（记录 " + String(x.id == null ? "" : x.id) + "）");
				if (x.note) lines.push("   备注：" + String(x.note));
			});
			if (items.length > AUDIT_PROMPT_MAX_ITEMS) {
				lines.push("…（还有 " + (items.length - AUDIT_PROMPT_MAX_ITEMS) + " 条，见面板）");
			}
			return { lines: lines, count: items.length };
		}

		/**
		 * 「库健康」一屏 → 一段提示词（**全场唯一入口**，对应界面上那一颗按钮）。
		 *
		 * 两段**分开写**：A 是体检问题（要修），B 是待裁决的矛盾（只判断）。开头的
		 * 一句话先说清这次有哪几段、没什么 —— 智能体不该靠猜「为什么 B 不见了」。
		 * 两边都没有时返回 null：界面据此不渲染那颗按钮。
		 */
		function buildHealthFixPrompt(input) {
			const src = input && typeof input === "object" ? input : {};
			const audit = src.report;
			const a = auditFixLines(audit);
			const b = conflictFixLines(src.conflicts);
			if (!a && !b) return null;

			const dir = audit && typeof audit.dir === "string" ? audit.dir : "";
			const lines = [];
			lines.push("sage-mem「库健康」这一屏要处理的事，分两部分；两部分的纪律不一样，别混。");
			lines.push("");
			if (a && b) {
				lines.push("这次两部分都有：A 是体检发现的结构问题（**要修**），B 是待裁决的矛盾（**只做判断，不要改盘上的文件**）。");
			} else if (a) {
				// 2.14.0：A 段现在也可能是「只有提示与提案」—— 措辞必须跟着分叉，
				// 不然智能体会把一段只报告的内容当成「按清单修」去改盘。
				lines.push(a.hard
					? "这次只有 A：体检发现的结构问题（**要修**）；当前没有待裁决的矛盾。"
					: "这次只有 A 的提示类：体检**没有硬问题**，下面是治理提案（**只报不改**）；当前没有待裁决的矛盾。");
			} else {
				lines.push("这次只有 B：待裁决的矛盾（**只做判断，不要改盘上的文件**）；体检没有发现问题。");
			}
			if (dir) lines.push("记忆目录：" + dir);

			if (a) {
				lines.push("");
				lines.push(a.hard ? "════ A · 体检问题：按下面的清单修 ════" : "════ A · 体检提示与提案：只报不改 ════");
				Array.prototype.push.apply(lines, a.lines);
			}
			if (b) {
				lines.push("");
				lines.push("════ B · 待裁决的矛盾：只给判断，不要改盘 ════");
				lines.push("这些要我来裁决 —— 你只做判断，不要改盘上的文件，也不要把任何一方标失效。面板里的「标失效」只往 frontmatter 加一行 invalid_at、不动正文；点哪颗按钮由我来。");
				Array.prototype.push.apply(lines, b.lines);
			}
			return {
				text: lines.join("\n"),
				count: (a ? a.count : 0) + (b ? b.count : 0),
				hasAudit: !!a,
				hasConflict: !!b,
			};
		}

		/**
		 * 写剪贴板：优先异步 Clipboard API，失败降级到隐藏 textarea + execCommand。
		 *
		 * 两条都不承诺「一定成功」—— 局域网 http 部署不是安全上下文，两条都可能被拒；
		 * 调用方拿到 `false` 必须把文本摊出来让人手抄（`PromptFallbackModal`），
		 * 绝不静默失败（D25：点了没反应是最坏的失败形态）。
		 */
		function copyPromptText(text) {
			const value = String(text == null ? "" : text);
			let clip = null;
			try {
				if (typeof navigator !== "undefined" && navigator && navigator.clipboard &&
					typeof navigator.clipboard.writeText === "function") {
					clip = navigator.clipboard;
				}
			} catch (e) { clip = null; }
			if (clip) {
				return Promise.resolve()
					.then(function () { return clip.writeText(value); })
					.then(function () { return true; })
					.catch(function () { return legacyCopyPrompt(value); });
			}
			return Promise.resolve(legacyCopyPrompt(value));
		}

		/** 降级路径：老的 textarea + execCommand（已废弃但仍是 http 页面唯一的出路）。 */
		function legacyCopyPrompt(value) {
			try {
				if (typeof document === "undefined" || !document || !document.body) return false;
				const ta = document.createElement("textarea");
				ta.value = value;
				ta.setAttribute("readonly", "readonly");
				ta.style.position = "fixed";
				ta.style.left = "-9999px";
				ta.style.top = "0";
				document.body.appendChild(ta);
				if (typeof ta.select === "function") ta.select();
				const ok = typeof document.execCommand === "function" && document.execCommand("copy") === true;
				document.body.removeChild(ta);
				return ok;
			} catch (e) {
				return false;
			}
		}

		/**
		 * 复制失败时的兜底：把提示词摊在一只只读 textarea 里，点一下即全选。
		 *
		 * 用户手动关（× / 关闭 / 点遮罩）—— 与面板里其它模态同一套壳。
		 */
		function PromptFallbackModal(props) {
			return h("div", { className: "smem-modal-host" }, [
				h("div", { className: "smem-modal-scrim", key: "scrim", onClick: props.onClose }),
				h("div", {
					className: "smem-modal", key: "m",
					role: "dialog", "aria-modal": "true",
					"aria-label": t("prompt.copyFailedTitle"),
				}, [
					h("div", { className: "smem-modal-title", key: "t" }, t("prompt.copyFailedTitle")),
					h("div", { className: "smem-modal-body", key: "b" }, [
						h("textarea", {
							className: "smem-textarea smem-prompt-ta", key: "ta",
							readOnly: true, rows: 12, value: String(props.text == null ? "" : props.text),
							onFocus: function (e) {
								if (e && e.target && typeof e.target.select === "function") e.target.select();
							},
						}),
						h("div", { className: "smem-ar-hint", key: "h" }, t("prompt.copyFailedHint")),
					]),
					h("div", { className: "smem-modal-foot", key: "f" }, [
						h("button", { type: "button", className: "smem-btn", key: "c", onClick: props.onClose }, t("prompt.close")),
					]),
				]),
			]);
		}
