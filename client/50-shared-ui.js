		const TYPE_META = {
			user: ["👤", "用户"],
			feedback: ["📌", "反馈"],
			project: ["📁", "项目"],
			reference: ["🔗", "参考"],
		};
		const TYPE_ORDER = ["user", "feedback", "project", "reference"];
		// 筛选条上的显示名：emoji 在筛选条里太吵，只用文字；special 是星图的兜底类，
		// 文件列表里出现它说明 frontmatter 写了 type: special。
		const TYPE_LABEL = { user: "用户", feedback: "反馈", project: "项目", reference: "参考", special: "特殊" };
		const TYPE_SORT = ["user", "feedback", "project", "reference", "special"];

		/**
		 * 把输入框里的一串标签切成数组。
		 *
		 * 分隔符收半角逗号、全角逗号、顿号三种 —— 中文输入法下这三种都会自然敲出来。
		 * 顺手剥掉 YAML 里有语法含义的字符（[ ] " ' # :），因为标签是按 flow 写法
		 * 落进 frontmatter 的，带着这些字符写进去会让整行解析错位。
		 */
		function parseTagInput(s) {
			return String(s == null ? "" : s)
				.split(/[,，、]+/)
				.map(function (t) { return t.replace(/[\[\]"'#:]/g, "").trim(); })
				.filter(Boolean)
				.slice(0, 20)
				.map(function (t) { return t.slice(0, 40); });
		}

		// ── frontmatter 纯逻辑（顶层自包含普通函数，不碰 React state）─────
		//
		// 重建 frontmatter 会造成字段丢失，三条硬规矩：
		//   1) 绝不「重建」frontmatter —— 就地合并，除 description / type 外每一行
		//      逐字保留。旧版 buildFrontmatter() 只写 name/description/type 三个字段，
		//      保存一次就把 baseline / node_type / originSessionId / updated 全抹掉
		//      （baseline 一丢，「每次会话必读」的记忆从此不再注入）。
		//   2) 类型正则必须锚行首：`  node_type: memory` 里的 `type:` 否则会被先命中，
		//      捕获到 memory → 不在 TYPE_ORDER 里 → 兜底成 reference。
		//   3) 换行必须容忍 CRLF（一次保存就可能变成 \r\n）；回写沿用原文件的
		//      换行风格，从而 LF / CRLF 都能逐字节 round-trip。

		/** 去掉值两侧成对的引号（与 宿主侧 parseFrontmatter 的剥法一致）。 */
		function stripQuotes(v) {
			const s = typeof v === "string" ? v.trim() : "";
			return s.replace(/^["']|["']$/g, "").trim();
		}

		/** 渲染成双引号 YAML 标量：转义反斜杠与双引号（旧版把 " 换成 ' 会改字）。 */
		function yamlQuote(v) {
			return String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		}

		/** 传整篇 content 或只传 fm 文本都能用；以 --- 开头的当整篇拆。 */
		function fmInner(text) {
			const t = typeof text === "string" ? text : "";
			return /^---[ \t]*\r?\n/.test(t) ? splitFrontmatter(t).fm : t;
		}

		/**
		 * 拆 frontmatter。返回 { hasFm, fm, body }：
		 *   fm   = 两条 --- 之间的原始文本（不含定界行）
		 *   body = 定界之后的内容（只吃掉紧跟 --- 的那一个换行，其余原样）
		 * 没有 frontmatter 时 hasFm=false、fm=""、body=整个 content。
		 */
		function splitFrontmatter(content) {
			const text = typeof content === "string" ? content : "";
			const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?/);
			if (!m) return { hasFm: false, fm: "", body: text };
			return { hasFm: true, fm: m[1], body: text.slice(m[0].length) };
		}

		/**
		 * 识别记忆类型。锚行首（^ + m），**不看 node_type**：
		 *   1) 顶层 `type: X`
		 *   2) metadata 块内的缩进写法 `  type: X`
		 * 优先级与 宿主侧 parseFrontmatter 一致（顶层优先）。找不到返回 ""。
		 */
		function detectType(text) {
			const fm = fmInner(text);
			const top = fm.match(/^type[ \t]*:[ \t]*([^\r\n]*)/m);
			if (top) return stripQuotes(top[1]);
			const nested = fm.match(/^[ \t]+type[ \t]*:[ \t]*([^\r\n]*)/m);
			if (nested) return stripQuotes(nested[1]);
			return "";
		}

		/**
		 * 兜底：读 node_type。个别老文件没有 type 行，node_type 直接就是类型
		 * （例如 project_example.md → project）。
		 * 只由调用方在 detectType 返回空时使用 —— detectType 本身绝不认 node_type。
		 */
		function detectNodeType(text) {
			const fm = fmInner(text);
			const m = fm.match(/^[ \t]*node_type[ \t]*:[ \t]*([^\r\n]*)/m);
			return m ? stripQuotes(m[1]) : "";
		}

		/** 取顶层 description 的值（剥掉成对引号）。 */
		function extractDescription(text) {
			const fm = fmInner(text);
			const m = fm.match(/^description[ \t]*:[ \t]*([^\r\n]*)/m);
			return m ? stripQuotes(m[1]) : "";
		}

		/**
		 * 取顶层 tags 的值。三种写法都认，与 宿主侧 parseTags 保持同一套规则：
		 *   tags: ["a", "b"]       （flow，本插件自己写出去的就是这种）
		 *   tags:\n  - a\n  - b    （block，手写文件常见）
		 *   tags: a, b             （松散逗号串）
		 */
		function detectTags(text) {
			const fm = fmInner(text);
			const flow = fm.match(/^tags[ \t]*:[ \t]*\[([^\]]*)\]/m);
			if (flow) return flow[1].split(",").map(stripQuotes).filter(Boolean);
			const block = fm.match(/^tags[ \t]*:[ \t]*\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)+)/m);
			if (block) {
				return block[1].split(/\r?\n/).map(function (l) {
					return stripQuotes(l.replace(/^[ \t]*-[ \t]*/, ""));
				}).filter(Boolean);
			}
			const inline = fm.match(/^tags[ \t]*:[ \t]*(.+?)[ \t\r]*$/m);
			if (inline && inline[1].trim()) return inline[1].split(",").map(stripQuotes).filter(Boolean);
			return [];
		}

		/** 渲染 tags 成一行 YAML flow（带引号：标签可能含空格或中文标点）。 */
		function renderTags(tags) {
			return "tags: [" + tags.map(function (t) { return '"' + yamlQuote(t) + '"'; }).join(", ") + "]";
		}

		/**
		 * 就地合并 frontmatter，返回新的完整文件内容。
		 * patch = { type, description, addMissingType }
		 *   - description：与原文相同时整行逐字保留；不同时改写该行；原本没有该行才补一行。
		 *   - type：只改写已有的 type 行（顶层优先，其次 metadata 内缩进那一行）并保留原缩进；
		 *     原本没有 type 行时默认一行都不加（不动 node_type-only 的老文件），
		 *     只有 patch.addMissingType === true 才插入（插进 metadata 块或顶层）。
		 *   - 其余所有行（name / baseline / node_type / originSessionId / updated / 任意键）
		 *     逐字保留，顺序不变。
		 * 没有 frontmatter 的文件原样返回（新增文件走 buildFrontmatter）。
		 */
		function mergeFrontmatter(content, patch) {
			const src = typeof content === "string" ? content : "";
			const p = patch || {};
			const parts = splitFrontmatter(src);
			if (!parts.hasFm) return src;

			const oldDesc = extractDescription(parts.fm);
			const oldType = detectType(parts.fm);
			const srcLines = parts.fm.split(/\r?\n/);

			// 目标 type 行的下标：与 detectType 同一优先级（顶层 → 缩进）
			let typeIdx = -1;
			for (let i = 0; i < srcLines.length; i++) {
				if (/^type[ \t]*:/.test(srcLines[i])) { typeIdx = i; break; }
			}
			if (typeIdx < 0) {
				for (let i = 0; i < srcLines.length; i++) {
					if (/^[ \t]+type[ \t]*:/.test(srcLines[i])) { typeIdx = i; break; }
				}
			}

			const wantDesc = typeof p.description === "string" && p.description !== oldDesc;
			const wantType = typeof p.type === "string" && p.type !== "" && p.type !== oldType;
			// tags：只有传了数组才管（undefined = 调用方不关心，一行都不动）；空数组 = 明确要求移除。
			// 相同则整行逐字保留 —— 与 description 一样的规矩，别把用户手写的
			// `tags:\n  - a` block 形式悄悄改写成 flow 形式。
			const wantTags = Array.isArray(p.tags);
			const tagsSame = wantTags && JSON.stringify(detectTags(parts.fm)) === JSON.stringify(p.tags);
			let tagsIdx = -1;
			for (let i = 0; i < srcLines.length; i++) {
				if (/^tags[ \t]*:/.test(srcLines[i])) { tagsIdx = i; break; }
			}
			const out = [];
			let descDone = !wantDesc;
			let typeDone = !wantType || typeIdx < 0;
			let tagsDone = !wantTags || tagsSame;
			let tagsBlockChild = false;
			let metadataAt = -1;
			for (let i = 0; i < srcLines.length; i++) {
				const line = srcLines[i];
				// block 形式 tags 的缩进子行：紧跟在被替换/移除的 tags 行之后，一起处理掉
				if (tagsBlockChild) {
					if (/^[ \t]*-[^\r\n]*$/.test(line)) continue;
					tagsBlockChild = false;
				}
				if (!tagsDone && i === tagsIdx) {
					if (p.tags.length) out.push(renderTags(p.tags));
					tagsDone = true;
					tagsBlockChild = true;
					continue;
				}
				if (/^metadata[ \t]*:/.test(line)) metadataAt = out.length;
				if (!descDone && /^description[ \t]*:/.test(line)) {
					out.push('description: "' + yamlQuote(p.description) + '"');
					descDone = true;
					continue;
				}
				if (!typeDone && i === typeIdx) {
					out.push((line.match(/^[ \t]*/) || [""])[0] + "type: " + p.type);
					typeDone = true;
					continue;
				}
				out.push(line);
			}
			// 原本没有 type 行 → 仅在调用方明确要求时插入
			if (typeIdx < 0 && p.addMissingType === true) {
				if (metadataAt >= 0) {
					let at = metadataAt + 1;
					let indent = "  ";
					for (let i = metadataAt + 1; i < out.length; i++) {
						const mm = out[i].match(/^([ \t]+)\S/);
						if (!mm) break;
						indent = mm[1];
						at = i + 1;
					}
					out.splice(at, 0, indent + "type: " + p.type);
				} else {
					out.push("type: " + p.type);
				}
			}
			// 原本没有 description 行 → 补一行（description 本就在可改范围内）
			if (!descDone) {
				const rendered = 'description: "' + yamlQuote(p.description) + '"';
				let at = -1;
				for (let i = 0; i < out.length; i++) {
					if (/^name[ \t]*:/.test(out[i])) { at = i + 1; break; }
				}
				if (at >= 0) out.splice(at, 0, rendered); else out.unshift(rendered);
			}
			// 原本没有 tags 行 → 只在这次确实要写标签时插一行（空数组不插，避免留下一行空 tags）
			if (wantTags && tagsIdx < 0 && p.tags.length) {
				let at = -1;
				for (let i = 0; i < out.length; i++) {
					if (/^description[ \t]*:/.test(out[i])) { at = i + 1; break; }
				}
				if (at < 0) {
					for (let i = 0; i < out.length; i++) {
						if (/^name[ \t]*:/.test(out[i])) { at = i + 1; break; }
					}
				}
				if (at >= 0) out.splice(at, 0, renderTags(p.tags)); else out.unshift(renderTags(p.tags));
			}

			// 原文件是 CRLF 就照样回写 CRLF（LF 文件回写 \n）——保证逐字节 round-trip。
			// 组件把原文重建成 "---\n" + fm + "\n---\n" + body，所以还要从 fm / body 里看 CRLF。
			const eol = /^---[ \t]*\r\n/.test(src) || parts.fm.indexOf("\r\n") >= 0 || parts.body.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
			return "---" + eol + out.join(eol) + eol + "---" + eol + parts.body;
		}

		/**
		 * 新建记忆的 frontmatter（只用于「添加记忆」或原本没有 frontmatter 的文件；
		 * 编辑已有文件一律走 mergeFrontmatter，绝不重建）。
		 */
		function buildFrontmatter(type, desc, fileName, tags) {
			const slug = String(fileName == null ? "" : fileName).replace(/\.md$/i, "");
			const tagLine = Array.isArray(tags) && tags.length ? "\n" + renderTags(tags) : "";
			return "---\nname: \"" + yamlQuote(slug) + "\"\ndescription: \"" + yamlQuote(desc) + "\"" +
				tagLine + "\nmetadata:\n  node_type: memory\n  type: " + type + "\n---\n\n";
		}

		function fmtSize(n) {
			if (n < 1024) return n + " B";
			if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
			return (n / 1024 / 1024).toFixed(1) + " MB";
		}

		/** 拆 typert remote 的 {ok, value} 信封。 */
		function unwrap(result) {
			return result && result.ok ? result.value : result;
		}

		function Chip(props) {
			return h("button", {
				type: "button",
				className: "smem-chip",
				"data-on": props.on ? "1" : "0",
				onClick: props.onClick,
			}, props.label);
		}

		function Card(props) {
			const item = props.item;
			const meta = TYPE_META[item.type] || TYPE_META.reference;
			const isOpen = !!props.expanded;
			return h("div", { className: "smem-card", key: item.file }, [
				h("div", { className: "smem-card-head", key: "head" }, [
					h("span", { className: "smem-badge", key: "badge", title: "类型 " + String(item.type) }, meta[0] + " " + meta[1]),
					h("span", { className: "smem-card-title", key: "title" }, item.file),
					h("span", { className: "smem-muted", key: "size" }, fmtSize(item.size)),
				]),
				(item.tags && item.tags.length)
					? h("div", { className: "smem-taglist", key: "tags" }, item.tags.map(function (t) {
							return h("span", { className: "smem-tag", key: t }, "#" + t);
						}))
					: null,
				item.description
					? h("div", {
							className: "smem-narrative",
							"data-clamp": isOpen ? "0" : "1",
							key: "body",
							onClick: function () { props.onToggle(item.file); },
							title: isOpen ? "点击收起" : "点击展开全文",
						}, String(item.description))
					: null,
				h("div", { className: "smem-card-foot", key: "foot" },
					props.archiving
						? h("div", { className: "smem-ar-confirm", key: "ar" }, [
								h("div", { key: "what" }, "把「" + item.file + "」收进档案馆：它不再参与检索与星图，文件移进 archive/，随时可以恢复。"),
								// 「可留空」必须跟输入框贴在一起、并且独立成行 —— 它是这一块最容易
								// 被误读成「必须填才能按」的地方。
								h("label", { className: "smem-label", key: "lb" }, "归档理由（可留空）"),
								h("input", {
									className: "smem-input", key: "in",
									value: props.archiveReason || "",
									placeholder: "例如：结论已被 project_beta 取代",
									onChange: function (e) { props.onArchiveReason(e.target.value); },
								}),
								h("div", { className: "smem-ar-hint", key: "hint" },
									"写下当时的判断，以后翻到它时就知道这条还值不值得捞回来。"),
								h("div", { className: "smem-row", key: "btns" }, [
									h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "ok", disabled: props.busy, onClick: function () { props.onConfirmArchive(item.file); } }, "确认归档"),
									h("button", { type: "button", className: "smem-btn", key: "no", disabled: props.busy, onClick: props.onCancelArchive }, "取消"),
								]),
							])
						: h("div", { className: "smem-actions", key: "acts" },
								props.deleting
									? [
											h("button", { type: "button", className: "smem-btn smem-btn-danger", key: "yes", onClick: function () { props.onConfirmDelete(item.file); } }, "确认删除"),
											h("button", { type: "button", className: "smem-btn", key: "no", onClick: function () { props.onCancelDelete(); } }, "取消"),
										]
									: [
											h("button", { type: "button", className: "smem-btn", key: "edit", onClick: function () { props.onEdit(item.file); } }, "编辑"),
											/**
											 * 锁定排在「编辑」与「归档」之间（用户 2026-10-11 指定）：
											 * 它是「别归档这条」的开关，紧挨着归档才说得通。
											 *
											 * 锁上的记忆**自动与手动都不许归档** —— 候选计算会跳过它，
											 * 手动点归档会被宿主拒绝。图标用 🔒 / 🔓 之外还留着文字，
											 * 因为「锁」在这里是**拒绝归档**，不是「只读」。
											 */
											h("button", {
												type: "button",
												className: "smem-btn" + (item.locked ? " smem-btn-locked" : ""),
												key: "lock",
												title: item.locked
													? "已锁定：自动归档不会选它，手动归档也会被拒绝。点一下解锁"
													: "锁定这条记忆：自动与手动归档都不再动它（重要的人设 / 偏好建议锁上）",
												disabled: props.busy,
												onClick: function () { props.onToggleLock(item.file, !item.locked); },
											}, item.locked ? "🔒 已锁定" : "🔓 锁定"),
											// 归档排在「锁定」和「删除」之间：比编辑轻、比删除温和，且随时可逆。
											h("button", {
												type: "button", className: "smem-btn", key: "arch",
												title: item.locked
													? "这条已锁定，归档会被拒绝（先解锁）"
													: "收进档案馆：不再参与检索与星图，随时可以恢复",
												disabled: props.busy || item.locked === true,
												onClick: function () { props.onAskArchive(item.file); },
											}, "归档"),
											h("button", { type: "button", className: "smem-btn smem-btn-danger-ghost", key: "del", onClick: function () { props.onAskDelete(item.file); } }, "删除"),
										])),
			]);
		}

		/**
		 * 归档区的一条。与活动卡片共用骨架（类型章 / 标题 / 标签 / 描述），刻意的差异：
		 * 虚线边框 + 整体压灰（退役感）、多一行归档留痕、动作是「编辑 / 恢复」。
		 *
		 * ⚠️ 灰的只有**内容**（`.smem-card--archived` 那几条只点标题/类型章/标签/正文的字色）。
		 * 按钮一律保持原样 —— 按钮一灰，用户就以为不能按。
		 *
		 * ⚠️ 编辑走**原样文本**：readArchived 拿到的全文直接进 textarea，保存时原样交回
		 * writeArchived。绝不走活跃记忆那套 buildFrontmatter 重建 —— 重建会吞字段，
		 * 归档文件里还有 archived_at / archived_reason 这种留痕，更动不得。
		 * 也不提供删除：归档 = 不删，host 侧也没有那条 remote。
		 */
		function ArchivedCard(props) {
			const item = props.item;
			const meta = TYPE_META[item.type] || TYPE_META.reference;
			return h("div", { className: "smem-card smem-card--archived", key: item.file }, [
				h("div", { className: "smem-card-head", key: "head" }, [
					h("span", { className: "smem-badge", key: "badge", title: "类型 " + String(item.type) }, meta[0] + " " + meta[1]),
					h("span", { className: "smem-card-title", key: "title" }, item.file),
					h("span", { className: "smem-ar-meta", key: "at", title: "归档时间" }, "已归档 " + (item.archivedAt || "（时间未知）")),
					h("span", { className: "smem-muted", key: "size" }, fmtSize(item.size)),
				]),
				(item.tags && item.tags.length)
					? h("div", { className: "smem-taglist", key: "tags" }, item.tags.map(function (t) {
							return h("span", { className: "smem-tag", key: t }, "#" + t);
						}))
					: null,
				// 描述留在活动卡片里的同一个位置（标签下面），归档留痕块再往下 ——
				// 否则「归档理由」像卡片结尾，后面孤零零一行描述没人认得它是什么。
				item.description
					? h("div", { className: "smem-narrative", key: "desc" }, String(item.description))
					: null,
				h("div", { className: "smem-ar-reason", key: "why" }, "归档理由：" + (item.archivedReason || "（没写）")),
				props.editing
					? h("div", { className: "smem-ar-edit", key: "edit" }, [
							h("div", { className: "smem-ar-hint", key: "note" },
								"原样文本编辑：下面就是这份文件的全文（含 frontmatter 与归档留痕），保存时原样写回，不会被重新生成。"),
							props.loading
								? h("div", { className: "smem-status", key: "loading" }, "读取中…")
								: h("textarea", {
										className: "smem-textarea smem-ar-editor", key: "ta",
										value: props.text || "",
										spellCheck: false,
										onChange: function (e) { props.onText(e.target.value); },
									}),
							h("div", { className: "smem-row", key: "btns" }, [
								h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "save", disabled: props.busy || props.loading, onClick: function () { props.onSave(item.file); } }, props.saving ? "保存中…" : "保存"),
								h("button", { type: "button", className: "smem-btn", key: "cancel", disabled: props.busy, onClick: props.onCancel }, "取消"),
							]),
						])
					: h("div", { className: "smem-card-foot", key: "foot" },
							h("div", { className: "smem-actions", key: "acts" }, [
								h("button", {
									type: "button", className: "smem-btn", key: "edit",
									disabled: props.busy,
									onClick: function () { props.onEdit(item.file); },
								}, "编辑"),
								h("button", {
									type: "button", className: "smem-btn smem-btn-primary", key: "restore",
									disabled: props.busy,
									onClick: function () { props.onRestore(item.file); },
								}, props.restoring ? "恢复中…" : "恢复"),
							])),
			]);
		}

		// ── 自动归档三档的**唯一**一套措辞 ──
		// 文件列表的「归档候选」与自动做梦 tab 的开关都从这里取词：同一件事在两处出现，
		// 用两套说法等于让用户以为它们是两回事。
		const AUTO_ARCHIVE_LABEL = { off: "关闭", report: "只出报告", auto: "满足条件自动跑" };
		const AUTO_ARCHIVE_COST = {
			off: "关闭：一个文件都不动 —— 候选只列在清单里，等你手点。",
			report: "只出报告：候选写进整理报告，一个文件都不动。默认档，最保守。",
			auto: "满足条件自动跑：会真的把候选移进 archive/（只移不删，随时可恢复）；" +
				"若「改动方式」是只出报告，这一档会自动降级成只出报告。",
		};
		const autoArchiveOf = (v) => (v === "off" || v === "auto" ? v : "report");

		/** 头部带上的「我在哪」：五个 tab 的中文名（与 .smem-tabs 上的字面一致）。 */
		const TAB_LABEL = { files: "文件列表", star: "记忆星图", autodream: "自动做梦", archive: "自动归档", audit: "体检" };

		/**
		 * 工具面板头部的「收起」按钮：抽屉里开的工具要能一键收回去 ——
		 * 面板不收，列表就还在下面被顶着。
		 */
		const toolClose = (props) => (props.onClose
			? h("button", { type: "button", className: "smem-btn", key: "close", onClick: props.onClose }, "收起")
			: null);

		/**
		 * 稳定的 remote 引用。
		 *
		 * 起因（issue #3，2026-10-10 外部报告）：面板在**渲染期**取 `ctx.get("remote.x")`，
		 * 又把结果放进 `useEffect` 的依赖数组 —— 而真实宿主里 `ctx.get()` 每次返回一个
		 * **新的包装对象**，于是
		 *   渲染 → effect 重跑 → 6 个 RPC + setState → 再渲染 → …
		 * 滚成无限请求风暴（报告者实测每秒上千次；本机观察到的形态是「组件一直在 setState」）。
		 *
		 * 为什么本机测试一直没抓到：mock 的 `ctx.get` 每次返回**同一个**对象 —— 假的安全。
		 * 测试里现在有 `unstableRemoteRefs` 开关来复现真实行为。
		 *
		 * 同一个 ctx 永远拿到同一个 remote。用 WeakMap 而不是普通 Map：ctx 是长生命周期对象，
		 * WeakMap 不会因为这张缓存把它拖住。
		 */
		const REMOTE_CACHE = new WeakMap();
		function stableRemote(ctx, name) {
			if (!ctx || typeof ctx.get !== "function") return null;
			let byName = REMOTE_CACHE.get(ctx);
			if (!byName) { byName = new Map(); REMOTE_CACHE.set(ctx, byName); }
			if (!byName.has(name)) byName.set(name, ctx.get(name) || null);
			return byName.get(name);
		}

		/**
		 * 「体检」结果面板。
		 *
		 * 只读：这里**不提供任何「顺手修一下」的按钮** —— 修哪条、怎么修由用户决定，
		 * 走列表里那条记忆自己的编辑入口。
		 *
		 * 硬问题与提示**分开渲染**：`archivedLinks` 是提示（归档不是删除，目标还在档案馆里），
		 * 跟问题一样染红会让人去「修」一条本来正确的链接 —— 那正是审计里那条分界线。
		 */
		/**
		 * 面板底部的一行仓库链接。
		 *
		 * 参照手机访问插件那一行的做法：放在不抢视线的地方、语气轻、点开是新标签页。
		 * 它**是引流不是功能** —— 所以不占一屏、不做成按钮、失败也没有任何副作用；
		 * 四个 tab 下都在（谁也没必要为看它切页）。
		 */
		function StarLine() {
			return h("div", { className: "smem-star" }, [
				h("span", { key: "ask" }, "⭐ 顺手留颗 Star，作者能高兴一整天"),
				h("a", {
					key: "cta",
					href: "https://github.com/gezi-wen/sage-mem",
					target: "_blank",
					rel: "noreferrer",
					className: "smem-star-link",
				}, "行，给你一颗 Star"),
			]);
		}

		function AuditPanel(props) {
			const r = props.report || {};
			/**
			 * 独立成 tab 时不套抽屉那层窄框（`--cap` 有 320px 限高）、也不给「收起」按钮 ——
			 * 它不是「暂时摊开的一层」，它就是这一屏。
			 */
			const standalone = props.standalone === true;
			const rows = (list, render) => (list || []).map(function (x, i) {
				return h("div", { className: "smem-audit-row", key: String(x.file || "?") + "-" + i }, render(x));
			});
			const section = (title, list, render) => ((list && list.length)
				? h("div", { className: "smem-audit-sec", key: title }, [
						h("div", { className: "smem-audit-h smem-audit-h--hard", key: "h" }, title + "（" + list.length + "）"),
						rows(list, render),
					])
				: null);
			const hints = r.archivedLinks || [];
			return h("div", { className: "smem-tool-panel" + (standalone ? " smem-tool-panel--full" : " smem-tool-panel--cap"), key: "audit" }, [
				h("div", { className: "smem-tool-head", key: "head" }, [
					h("span", { className: "smem-tool-title", key: "t" }, "体检"),
					h("span", { className: "smem-muted", key: "s" },
						"扫了 " + String(r.fileCount == null ? "?" : r.fileCount) + " 个记忆 · 索引 " +
						String(r.indexEntries == null ? "?" : r.indexEntries) + " 条 · 档案馆 " +
						String(r.archivedCount == null ? "?" : r.archivedCount) + " 条"),
					h("span", { className: "smem-tool-badge" + (r.problems ? " smem-tool-badge--bad" : ""), key: "p" },
						r.problems ? ("问题 " + r.problems) : "没有问题"),
					h("button", { type: "button", className: "smem-btn", key: "again", disabled: props.busy, onClick: props.onRun }, props.busy ? "体检中…" : "重新体检"),
					standalone ? null : toolClose(props),
				]),
				r.problems
					? h("div", { className: "smem-audit-secs", key: "secs" }, [
							section("索引悬空（索引里有、文件没了）", r.dangling, (x) => x.file),
							section("漏索引（文件在、索引里没有）", r.unlisted, (x) => x.file),
							section("type 与前缀对不上", r.typeMismatch, (x) => x.file + " · type=" + x.type + "，文件名前缀=" + x.prefix),
							section("行尾是 CRLF", r.crlf, (x) => x.file),
							section("双链断链", r.brokenLinks, (x) => x.file + " → [[" + x.target + "]]"),
							section("未加引号的「空格+#」", r.hashHazards, (x) => x.file + " · " + x.line),
							section("没有 frontmatter", r.noFrontmatter, (x) => x.file),
							section("读不出来", r.unreadable, (x) => x.file),
						])
					: h("div", { className: "smem-empty smem-empty--ok", key: "ok" },
							"没有发现问题 —— 索引、双链、frontmatter 与行尾都对得上。"),
				hints.length
					? h("div", { className: "smem-audit-hint", key: "hint" }, [
							h("div", { className: "smem-audit-h", key: "h" }, "指向已归档（提示，不计入问题）"),
							h("div", { className: "smem-ar-hint", key: "n" },
								"归档不是删除：这些链接的目标还在档案馆里躺着，恢复它链接就活了 —— 不用改。"),
							rows(hints, (x) => x.file + " → [[" + x.target + "]]"),
						])
					: null,
				h("div", { className: "smem-ar-hint", key: "ro" }, "这里只报告、不修改 —— 要改哪条，用那条记忆自己的编辑入口。"),
			]);
		}

		/**
		 * 「归档候选」面板。
		 *
		 * 每一条都必须把**为什么建议归档**写出来（`reason` 就是干这个的）——
		 * 只列文件名等于让人凭感觉点。执行前一律过一道确认，逐条与批量都要过。
		 */
		function CandidatePanel(props) {
			const c = props.data || {};
			const cands = Array.isArray(c.candidates) ? c.candidates : [];
			const th = c.thresholds || {};
			const pickedN = cands.filter((x) => props.picked[x.file]).length;
			const mode = autoArchiveOf(c.autoArchive);
			const allPicked = cands.length > 0 && pickedN === cands.length;
			return h("div", { className: "smem-tool-panel smem-tool-panel--cap", key: "cand" }, [
				h("div", { className: "smem-tool-head", key: "head" }, [
					h("span", { className: "smem-tool-title", key: "t" }, "归档候选"),
					h("span", { className: "smem-muted", key: "s" },
						"自动归档：" + AUTO_ARCHIVE_LABEL[mode] + " · 阈值：项目 " + String(th.project == null ? "?" : th.project) + " 天 / 参考 " +
						String(th.reference == null ? "?" : th.reference) + " 天 / 用户 " +
						String(th.user == null ? "?" : th.user) + " 天"),
					h("span", { className: "smem-tool-badge", key: "n" }, "候选 " + cands.length),
					h("button", { type: "button", className: "smem-btn", key: "again", disabled: props.busy, onClick: props.onLoad }, props.busy ? "刷新中…" : "刷新"),
					toolClose(props),
				]),
				cands.length === 0
					? h("div", { className: "smem-empty", key: "empty" },
							"按当前阈值没有可归档的 —— 要么闲置天数还没到该类型的阈值，要么台账里还没有访问记录。")
					: h("div", { className: "smem-cand-list", key: "list" }, [
							h("div", { className: "smem-cand-note", key: "note" },
								"候选只按「多久没被注入过」算。归档 = 移进 archive/（不删），随时可以恢复。"),
							cands.map((x) => h("div", { className: "smem-cand", key: x.file }, [
								h("label", { className: "smem-cand-main", key: "m" }, [
									h("input", { type: "checkbox", key: "cb", checked: !!props.picked[x.file], onChange: function () { props.onPick(x.file); } }),
									h("span", { className: "smem-card-title", key: "f" }, x.file),
									h("span", { className: "smem-badge", key: "ty" }, TYPE_LABEL[x.type] || x.type || "—"),
									h("span", { className: "smem-muted", key: "d" }, "闲置 " + String(x.days) + " 天 / 阈值 " + String(x.limit) + " 天"),
								]),
								h("div", { className: "smem-cand-reason", key: "why" },
									"为什么建议归档：" + (x.reason || ("闲置 " + String(x.days) + " 天，超过该类型阈值 " + String(x.limit) + " 天"))),
								props.confirm === x.file
									? h("div", { className: "smem-cand-confirm", key: "cf" }, [
											h("span", { key: "t" }, "确认把「" + x.file + "」移进档案馆？它不再参与检索与星图，随时可以恢复。"),
											h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "yes", disabled: props.busy, onClick: function () { props.onArchiveOne(x); } }, "确认归档"),
											h("button", { type: "button", className: "smem-btn", key: "no", disabled: props.busy, onClick: props.onCancelConfirm }, "取消"),
										])
									: h("div", { className: "smem-cand-act", key: "act" },
											h("button", { type: "button", className: "smem-btn", key: "one", disabled: props.busy, onClick: function () { props.onAskOne(x.file); } }, "归档这一条")),
							])),
						]),
				cands.length
					? h("div", { className: "smem-tool-foot", key: "foot" }, [
							h("button", { type: "button", className: "smem-btn", key: "all", disabled: props.busy, onClick: props.onPickAll }, allPicked ? "全不选" : "全选"),
							props.confirm === "__batch__"
								? [
										h("span", { className: "smem-ar-hint", key: "t" }, "确认把选中的 " + pickedN + " 条一起移进档案馆？"),
										h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "yes", disabled: props.busy || !pickedN, onClick: props.onArchivePicked }, "确认归档"),
										h("button", { type: "button", className: "smem-btn", key: "no", disabled: props.busy, onClick: props.onCancelConfirm }, "取消"),
									]
								: h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "go", disabled: props.busy || !pickedN, onClick: props.onAskPicked }, "执行归档（选中 " + pickedN + " 条）"),
						])
					: null,
			]);
		}

		/**
		 * 保留名（索引 / 流水）的**原样文本**编辑。
		 *
		 * readRaw 拿到的全文直接进 textarea，保存时逐字节交回 writeRaw —— 不解析、不重建。
		 * 这是那次数据事故（表单重建 frontmatter 把 baseline / node_type 抹掉）的解药，
		 * 所以这里刻意不复用上面的记忆表单。
		 */
		function RawPanel(props) {
			const names = Array.isArray(props.reserved) ? props.reserved : [];
			return h("div", { className: "smem-tool-panel", key: "raw" }, [
				h("div", { className: "smem-tool-head", key: "head" }, [
					h("span", { className: "smem-tool-title", key: "t" }, "保留名原样编辑"),
					h("span", { className: "smem-muted", key: "s" },
						"索引与流水这类文件不走记忆表单：读到的全文直接给你，保存时逐字节写回，" +
						"不解析、也不重建 frontmatter（普通记忆才走表单）。"),
				]),
				names.length
					? h("div", { className: "smem-raw-names", key: "names" }, names.map((n) =>
							h("button", {
								type: "button", key: n, className: "smem-chip",
								"data-on": props.name === n ? "1" : "0",
								onClick: function () { props.onOpen(n); },
							}, n)))
					: h("div", { className: "smem-ar-hint", key: "nonames" }, "宿主没给出保留名清单。"),
				props.name
					? h("div", { className: "smem-ar-edit", key: "edit" }, [
							h("div", { className: "smem-ar-hint", key: "n" }, "正在编辑 " + props.name + " —— 保存就是覆盖这一份文件。"),
							props.isNew
								? h("div", { className: "smem-ar-hint smem-ad-warn", key: "new" },
										"⚠ 这个文件还不存在 —— 保存会新建它。")
								: null,
							props.loading
								? h("div", { className: "smem-status", key: "l" }, "读取中…")
								: h("textarea", {
										className: "smem-textarea smem-ar-editor", key: "ta",
										value: props.text || "",
										spellCheck: false,
										onChange: function (e) { props.onText(e.target.value); },
									}),
							h("div", { className: "smem-row", key: "btns" }, [
								h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "save", disabled: props.busy || props.loading, onClick: function () { props.onSave(props.name); } }, props.saving ? "保存中…" : (props.isNew ? "新建并保存" : "保存")),
								h("button", { type: "button", className: "smem-btn", key: "close", disabled: props.busy, onClick: props.onClose }, "关闭"),
							]),
						])
					: h("div", { className: "smem-ar-hint", key: "pick" }, "选一个文件名开始编辑。"),
			]);
		}

		/** 单选按钮组。复用已有的 chip 语言，不另造一套视觉。 */
		function Seg(props) {
			return h("div", { className: "smem-chips" }, props.options.map(function (o) {
				return h("button", {
					type: "button",
					key: o.value,
					className: "smem-chip",
					"data-on": props.value === o.value ? "1" : "0",
					onClick: function () { if (props.value !== o.value) props.onChange(o.value); },
				}, o.label);
			}));
		}

		/**
		 * 模型路线的编码：`<select>` 的 value ↔ {provider, model}。
		 *
		 * 用 JSON 数组而不是 "provider/model" 拼串 —— provider 名里带斜杠的情况
		 * （比如 openrouter 的 "deepseek/deepseek-chat"）会把分隔符解析弄错。
		 * 空串代表「跟随当前会话默认模型」（值是 ['', '']）。
		 */
		function encodeRoute(provider, model) {
			return JSON.stringify([String(provider == null ? "" : provider), String(model == null ? "" : model)]);
		}
		function decodeRoute(v) {
			try {
				const a = JSON.parse(String(v == null ? "" : v));
				if (Array.isArray(a) && a.length === 2) {
					return { provider: String(a[0] == null ? "" : a[0]), model: String(a[1] == null ? "" : a[1]) };
				}
			} catch (_) {}
			return { provider: "", model: "" };
		}

