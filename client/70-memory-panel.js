		function Section(props) {
			const remote = props.ctx.get("remote.memory");
			const sItems = react.useState([]);
			const items = sItems[0], setItems = sItems[1];
			const sLoading = react.useState(false);
			const loading = sLoading[0], setLoading = sLoading[1];
			const sError = react.useState(null);
			const error = sError[0], setError = sError[1];
			const sNotice = react.useState("");
			const notice = sNotice[0], setNotice = sNotice[1];
			const sQuery = react.useState("");
			const query = sQuery[0], setQuery = sQuery[1];
			const sExpanded = react.useState({});
			const expanded = sExpanded[0], setExpanded = sExpanded[1];
			const sDeleting = react.useState(null);
			const deleting = sDeleting[0], setDeleting = sDeleting[1];
			const sFormOpen = react.useState(false);
			const formOpen = sFormOpen[0], setFormOpen = sFormOpen[1];
			const sEditingFile = react.useState(null);
			const editingFile = sEditingFile[0], setEditingFile = sEditingFile[1];
			const sFormType = react.useState("feedback");
			const formType = sFormType[0], setFormType = sFormType[1];
			const sFormName = react.useState("");
			const formName = sFormName[0], setFormName = sFormName[1];
			const sFormDesc = react.useState("");
			const formDesc = sFormDesc[0], setFormDesc = sFormDesc[1];
			const sFormBody = react.useState("");
			const formBody = sFormBody[0], setFormBody = sFormBody[1];
			const sFormTags = react.useState("");
			const formTags = sFormTags[0], setFormTags = sFormTags[1];
			// 筛选：空数组 = 不筛。类型与标签各自组内 OR、两组之间 AND，再与搜索框 AND。
			const sTypeFilter = react.useState([]);
			const typeFilter = sTypeFilter[0], setTypeFilter = sTypeFilter[1];
			const sTagFilter = react.useState([]);
			const tagFilter = sTagFilter[0], setTagFilter = sTagFilter[1];
			function toggleIn(setter, value) {
				setter(function (cur) {
					return cur.indexOf(value) >= 0
						? cur.filter(function (x) { return x !== value; })
						: cur.concat([value]);
				});
			}
			// 打开编辑时的原 frontmatter 原文（null = 该文件没有 frontmatter）
			const sFormFm = react.useState(null);
			const formFm = sFormFm[0], setFormFm = sFormFm[1];
			// 打开时展示给用户的类型（判断他是否真的改过类型）
			const sFormBaseType = react.useState("");
			const formBaseType = sFormBaseType[0], setFormBaseType = sFormBaseType[1];
			const sBusy = react.useState(false);
			const busy = sBusy[0], setBusy = sBusy[1];
			const sOk = react.useState(false);
			const dirOk = sOk[0], setDirOk = sOk[1];
			const sTab = react.useState("files");
			const tab = sTab[0], setTab = sTab[1];
			// ── 档案馆（v0.9.0）──
			// 归档不是「另一个视图」，而是和类型 / 标签并列的**筛选维度**：
			// 状态（全部 / 活动中 / 已归档）。三组筛选组内 OR、组间 AND，再与搜索框 AND。
			const sStatus = react.useState("all");
			const statusFilter = sStatus[0], setStatusFilter = sStatus[1];
			const sArchive = react.useState([]);
			const archiveItems = sArchive[0], setArchiveItems = sArchive[1];
			const sArchiving = react.useState(null);
			const archiving = sArchiving[0], setArchiving = sArchiving[1];
			const sArchiveReason = react.useState("");
			const archiveReason = sArchiveReason[0], setArchiveReason = sArchiveReason[1];
			const sRestoring = react.useState(null);
			const restoring = sRestoring[0], setRestoring = sRestoring[1];
			// 归档文件的「原样文本」编辑器：正在编辑谁、编辑框里是什么、读/存进行中
			const sArchEdit = react.useState(null);
			const archEdit = sArchEdit[0], setArchEdit = sArchEdit[1];
			const sArchText = react.useState("");
			const archText = sArchText[0], setArchText = sArchText[1];
			const sArchLoad = react.useState(false);
			const archLoad = sArchLoad[0], setArchLoad = sArchLoad[1];
			const sArchSaving = react.useState(false);
			const archSaving = sArchSaving[0], setArchSaving = sArchSaving[1];
			// ── 工具面板（体检 / 归档候选 / 保留名原样编辑）──
			// 一次只开一个：三个面板同时展开会把文件列表整个顶下去。数据按需拉，
			// 打开时才打 remote（不给每一次渲染都加一次全目录扫描）。
			const sTool = react.useState(null);
			const tool = sTool[0], setTool = sTool[1];
			const sAudit = react.useState(null);
			const audit = sAudit[0], setAudit = sAudit[1];
			const sAuditBusy = react.useState(false);
			const auditBusy = sAuditBusy[0], setAuditBusy = sAuditBusy[1];
			const sCand = react.useState(null);
			const cand = sCand[0], setCand = sCand[1];
			const sCandBusy = react.useState(false);
			const candBusy = sCandBusy[0], setCandBusy = sCandBusy[1];
			const sPicked = react.useState({});
			const picked = sPicked[0], setPicked = sPicked[1];
			const sCandConfirm = react.useState(null);
			const candConfirm = sCandConfirm[0], setCandConfirm = sCandConfirm[1];
			const sSettings = react.useState(null);
			const settings = sSettings[0], setSettings = sSettings[1];
			const sRawName = react.useState(null);
			const rawName = sRawName[0], setRawName = sRawName[1];
			const sRawText = react.useState("");
			const rawText = sRawText[0], setRawText = sRawText[1];
			const sRawIsNew = react.useState(false);
			const rawIsNew = sRawIsNew[0], setRawIsNew = sRawIsNew[1];
			const sRawBusy = react.useState(false);
			const rawBusy = sRawBusy[0], setRawBusy = sRawBusy[1];
			const sRawLoading = react.useState(false);
			const rawLoading = sRawLoading[0], setRawLoading = sRawLoading[1];
			const renderSlot = props.renderSlot;

			function load() {
				setLoading(true);
				setError(null);
				remote.listFiles()
					.then(function (res) {
						if (res && typeof res === "object" && res.ok === false) {
							const msg = res.error && res.error.message ? res.error.message : "remote 调用失败";
							throw new Error("listFiles RPC 失败: " + msg);
						}
						const list = unwrap(res);
						setItems(Array.isArray(list) ? list : []);
						setDirOk(true);
					})
					.catch(function (e) { setError(String((e && e.message) || e)); setDirOk(false); })
					.then(function () { setLoading(false); });
				// 归档区与活动列表分开拉：归档区读不到不该拖垮活动列表。
				// 旧版宿主没有 listArchived → 界面退化成一个空档案馆，不报错。
				if (typeof remote.listArchived !== "function") return;
				Promise.resolve()
					.then(function () { return remote.listArchived(); })
					.then(function (res) {
						const d = unwrap(res);
						setArchiveItems(d && Array.isArray(d.files) ? d.files : []);
					})
					.catch(function () { setArchiveItems([]); });
			}

			react.useEffect(function () { load(); }, []);

			function closeForm() {
				setFormOpen(false); setEditingFile(null); setFormName(""); setFormDesc(""); setFormBody(""); setFormType("feedback");
				setFormFm(null); setFormBaseType(""); setFormTags("");
			}

			function openEdit(file) {
				setError(null);
				setBusy(true);
				remote.readFile(file)
					.then(function (res) {
						const data = unwrap(res);
						const content = (data && data.content) || "";
						// 解析走顶层纯函数：拆 frontmatter / 认类型 / 取描述
						const parts = splitFrontmatter(content);
						// detectType 只认 type 行（锚行首，不碰 node_type）；
						// 老文件里 node_type 直接就是类型的，才退回 detectNodeType。
						const found = detectType(parts.fm) || detectNodeType(parts.fm);
						const shown = TYPE_ORDER.indexOf(found) >= 0 ? found : "reference";
						setEditingFile(file);
						setFormName(file);
						setFormType(shown);
						setFormBaseType(shown);
						setFormDesc(extractDescription(parts.fm));
						setFormBody(parts.body);
						setFormTags(detectTags(parts.fm).join(", "));
						// 关键：原 frontmatter 原文留着，保存时「就地合并」而不是重建
						setFormFm(parts.hasFm ? parts.fm : null);
						setFormOpen(true);
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			function openAdd() {
				setError(null);
				setEditingFile(null);
				setFormName("");
				setFormType("feedback");
				setFormBaseType("feedback");
				setFormDesc("");
				setFormBody("");
				setFormFm(null);
				setFormTags("");
				setFormOpen(true);
			}

			function submit() {
				if (!formDesc.trim()) { setError("描述不能为空"); return; }
				setBusy(true); setError(null); setNotice("");
				const type = formType;
				const name = (formName.trim() || (type + "_note.md"));
				const safeName = name.endsWith(".md") ? name : name + ".md";
				const desc = formDesc.trim();
				const tags = parseTagInput(formTags);
				let content;
				if (formFm === null) {
					// 没有 frontmatter（新增记忆 / 索引文件）→ 生成一份
					content = buildFrontmatter(type, desc, safeName, tags) + formBody;
				} else {
					// 有 frontmatter → 就地合并：除 description / type / tags 外一字不动
					const original = "---\n" + formFm + "\n---\n" + formBody;
					content = mergeFrontmatter(original, {
						type: type,
						description: desc,
						// 原文没有 type 行时，只有用户确实改过类型才补写一行
						addMissingType: type !== formBaseType,
						tags: tags,
					});
				}
				remote.writeFile(safeName, content)
					.then(function (r) {
						// host 侧对保留名 / 非字符串内容 / 超限一律返回 { ok: false, error }，不再抛异常。
						if (r && r.ok === false) { setError(r.error || "写入被拒绝"); return; }
						closeForm();
						setNotice(editingFile ? "已更新 " + safeName : "已保存 " + safeName);
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			function confirmDelete(file) {
				setBusy(true); setError(null); setNotice("");
				remote.deleteFile(file)
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || "删除被拒绝"); return; }
						setDeleting(null);
						setNotice("已删除 " + file);
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			/**
			 * 归档：把一条记忆移进档案馆。
			 *
			 * 与删除的区别要在界面上说清 —— 归档是「静默失效且可回退」，删除是真的没了。
			 * 所以这一问问的是「为什么」（留痕给以后的自己看），不是「确定吗」。
			 */
			function confirmArchive(file) {
				if (typeof remote.archive !== "function") {
					setError("宿主侧还没有 archive 接口（插件版本较旧）");
					return;
				}
				setBusy(true); setError(null); setNotice("");
				remote.archive(file, archiveReason.trim())
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || "归档被拒绝"); return; }
						setArchiving(null);
						setArchiveReason("");
						setNotice("已归档 " + file + " —— 它现在在「已归档」视图里，随时可以恢复");
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			/** 从档案馆捞回来：文件移回记忆目录，归档留痕被抹掉。 */
			function restoreFile(file) {
				if (typeof remote.restore !== "function") {
					setError("宿主侧还没有 restore 接口（插件版本较旧）");
					return;
				}
				setBusy(true); setError(null); setNotice("");
				setRestoring(file);
				remote.restore(file)
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || "恢复被拒绝"); return; }
						setNotice("已恢复 " + file + " —— 它回到了活动记忆里");
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); setRestoring(null); });
			}

			/**
			 * 打开归档文件的**原样文本**编辑器。
			 *
			 * 读回来的 content 一字不改地放进编辑框；保存时也一字不改地交回去。
			 * 这是刻意的：活跃记忆那套表单会用 buildFrontmatter 重建 frontmatter，
			 * 它会吞掉自己不认识的字段（曾经的数据事故）；归档文件里还多两行
			 * archived_at / archived_reason，重建就是丢留痕。
			 */
			function openArchEdit(file) {
				if (typeof remote.readArchived !== "function") {
					setError("宿主侧还没有 readArchived 接口（插件版本较旧）");
					return;
				}
				setError(null); setNotice("");
				setArchEdit(file);
				setArchText("");
				setArchLoad(true);
				remote.readArchived(file)
					.then(function (r) {
						const d = unwrap(r);
						setArchText(d && typeof d.content === "string" ? d.content : "");
						setArchLoad(false);
					})
					.catch(function (e) {
						setError(String((e && e.message) || e));
						setArchLoad(false);
						setArchEdit(null);
					});
			}

			function saveArchEdit(file) {
				if (typeof remote.writeArchived !== "function") {
					setError("宿主侧还没有 writeArchived 接口（插件版本较旧）");
					return;
				}
				setArchSaving(true); setError(null); setNotice("");
				// 原样交回：不 trim、不补 frontmatter、不做任何「智能」处理。
				remote.writeArchived(file, archText)
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || "保存被拒绝"); return; }
						setArchEdit(null);
						setNotice("已保存 " + file);
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setArchSaving(false); });
			}

			function cancelArchEdit() { setArchEdit(null); setArchText(""); }

			// ── 工具面板的三个数据通道 ──────────────────────────────────────

			function runAudit() {
				if (typeof remote.audit !== "function") { setError("宿主侧还没有 audit 接口（插件版本较旧）"); return; }
				setAuditBusy(true); setError(null);
				remote.audit()
					.then(function (r) { setAudit(unwrap(r) || null); })
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setAuditBusy(false); });
			}

			function loadCandidates() {
				if (typeof remote.archiveCandidates !== "function") { setError("宿主侧还没有 archiveCandidates 接口（插件版本较旧）"); return; }
				setCandBusy(true); setError(null);
				remote.archiveCandidates()
					.then(function (r) {
						const d = unwrap(r) || {};
						setCand(d);
						// 候选没了就把选中项一起清掉，免得留下指向不存在文件的对勾
						const keep = {};
						(d.candidates || []).forEach(function (x) { if (picked[x.file]) keep[x.file] = true; });
						setPicked(keep);
						setCandConfirm(null);
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setCandBusy(false); });
			}

			function loadSettings() {
				if (typeof remote.getSettings !== "function") { setError("宿主侧还没有 getSettings 接口（插件版本较旧）"); return; }
				remote.getSettings()
					.then(function (r) { const d = unwrap(r) || {}; setSettings(d); })
					.catch(function (e) { setError(String((e && e.message) || e)); });
			}

			/**
			 * 打开 / 收起一个工具面板。数据只在第一次打开时拉；已经拉过就复用
			 * （「刷新」「重新体检」是显式动作，别替用户反复扫目录）。
			 */
			function toggleTool(name) {
				const next = tool === name ? null : name;
				setTool(next);
				setError(null);
				if (next === "audit" && !audit) runAudit();
				if (next === "candidates" && !cand) loadCandidates();
				if (next === "raw" && !settings) loadSettings();
			}

			/**
			 * 执行归档（逐条 / 批量都走这里）。reason 用候选算出来的那个
			 * —— 归档留痕要写清「为什么」，不能把模型/界面的判断丢掉。
			 */
			function archiveCandidates(list) {
				if (!list.length) return;
				if (typeof remote.archive !== "function") { setError("宿主侧还没有 archive 接口（插件版本较旧）"); return; }
				setBusy(true); setError(null); setNotice("");
				const done = [];
				const failed = [];
				const step = function (i) {
					if (i >= list.length) {
						setBusy(false);
						setCandConfirm(null);
						setPicked({});
						setNotice(failed.length
							? ("已归档 " + done.length + " 条，" + failed.length + " 条没成功：" + failed.join("、"))
							: ("已归档 " + done.length + " 条 —— 它们现在在档案馆里，随时可以恢复"));
						load();
						loadCandidates();
						return;
					}
					const c = list[i];
					Promise.resolve()
						.then(function () { return remote.archive(c.file, c.reason); })
						.then(function (r) {
							if (r && r.ok === false) failed.push(c.file); else done.push(c.file);
						}, function () { failed.push(c.file); })
						.then(function () { step(i + 1); });
				};
				step(0);
			}

			function openRaw(name) {
				if (typeof remote.readRaw !== "function") { setError("宿主侧还没有 readRaw 接口（插件版本较旧）"); return; }
				setError(null); setNotice("");
				setRawName(name);
				setRawText("");
				setRawIsNew(false);
				setRawLoading(true);
				remote.readRaw(name)
					.then(function (r) {
						const d = unwrap(r);
						setRawText(d && typeof d.content === "string" ? d.content : "");
						setRawLoading(false);
					})
					.catch(function (e) {
						const msg = String((e && e.message) || e);
						// 文件还不存在 → 允许**新建**（索引/流水这类文件此前只能靠文件工具建，
						// 那正是「只有模型能操作」的一处）。但必须让用户**看见**这是新建：
						// 静默开一个空编辑框，用户会以为原文件是空的，一存就把内容顶掉。
						if (/ENOENT|no such file|not exist/i.test(msg)) {
							setRawText("");
							setRawIsNew(true);
							setRawLoading(false);
							return;
						}
						setError("读不到 " + name + "：" + msg);
						setRawLoading(false);
						setRawName(null);
					});
			}

			function saveRaw(name) {
				if (typeof remote.writeRaw !== "function") { setError("宿主侧还没有 writeRaw 接口（插件版本较旧）"); return; }
				setRawBusy(true); setError(null); setNotice("");
				// 原样交回：不 trim、不补 frontmatter、不做任何「智能」处理。
				remote.writeRaw(name, rawText)
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || "保存被拒绝"); return; }
						setNotice((rawIsNew ? "已新建 " : "已保存 ") + name);
						setRawIsNew(false);
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setRawBusy(false); });
			}
			// ── 筛选条的数据 ──
			// 状态是筛选维度之一：先按状态取一批，类型 / 标签 / 搜索都在这一批里继续收窄。
			// 组内 OR、组间 AND —— 与「类型 × 标签」原有的语义完全一致。
			// 归档条目在这里打一个本地 archived 标记（宿主 listArchived 的形状不动），
			// 列表渲染靠它决定用哪张卡；顺序是**活动在前、归档在后**。
			const archivedTagged = archiveItems.map(function (x) {
				return Object.assign({}, x, { archived: true });
			});
			const statusItems = statusFilter === "archived"
				? archivedTagged
				: statusFilter === "active"
					? items
					: items.concat(archivedTagged);
			const totalCount = items.length + archiveItems.length;
			// 计数一律按**全量**算，不随当前筛选变化 —— 否则一筛下去别的类型就都显示 0，
			// 用户没法知道「换个类型还有多少条」。
			const typeCounts = {};
			const tagCounts = {};
			for (let i = 0; i < statusItems.length; i++) {
				const it = statusItems[i];
				const t = it.type || "reference";
				typeCounts[t] = (typeCounts[t] || 0) + 1;
				const tg = Array.isArray(it.tags) ? it.tags : [];
				for (let j = 0; j < tg.length; j++) tagCounts[tg[j]] = (tagCounts[tg[j]] || 0) + 1;
			}
			// 类型顺序：认识的类型按固定次序在前（用户/反馈/项目/参考/特殊），
			// 遇到 frontmatter 里写了别的 type 的，按名字排在后面 —— 不丢任何一个。
			const typeList = Object.keys(typeCounts).sort(function (a, b) {
				const ia = TYPE_SORT.indexOf(a), ib = TYPE_SORT.indexOf(b);
				if (ia >= 0 && ib >= 0) return ia - ib;
				if (ia >= 0) return -1;
				if (ib >= 0) return 1;
				return a < b ? -1 : 1;
			});
			const tagList = Object.keys(tagCounts).sort(function (a, b) {
				return tagCounts[b] - tagCounts[a] || (a < b ? -1 : 1);
			});

			const q = query.trim().toLowerCase();
			const filtered = statusItems.filter(function (it) {
				if (typeFilter.length && typeFilter.indexOf(it.type || "reference") < 0) return false;
				if (tagFilter.length) {
					const tg = Array.isArray(it.tags) ? it.tags : [];
					let hit = false;
					for (let i = 0; i < tagFilter.length; i++) {
						if (tg.indexOf(tagFilter[i]) >= 0) { hit = true; break; }
					}
					if (!hit) return false;
				}
				if (!q) return true;
				const hay = ((it.file || "") + "\n" + (it.description || "") + "\n" + (it.type || "") + "\n" +
					(Array.isArray(it.tags) ? it.tags.join(" ") : "")).toLowerCase();
				return hay.indexOf(q) >= 0;
			});
			const hasFilter = !!(statusFilter !== "all" || typeFilter.length || tagFilter.length || q);
			// 两个计数永远一起露脸：用户不必先筛状态才知道档案馆里有没有东西。
			const headerCount = (hasFilter ? "筛出 " + String(filtered.length) + " / " + String(statusItems.length) + " · " : "") +
				"活动中 " + String(items.length) + " · 已归档 " + String(archiveItems.length);

			// 「文件列表」这一屏：状态筛选决定看哪一批，灰色卡片与留痕块自带「退役」语义。
			// banner 只在**专门看归档**时出现，切到全部时不重复说一遍。
			let filesView;
			if (loading && totalCount === 0) {
				filesView = h("div", { className: "smem-muted", key: "loading" }, "加载中…");
			} else if (totalCount === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" },
					"还没有记忆文件。对话中值得记住的事会写到这里，也可以点「添加记忆」手动写入。");
			} else if (statusFilter === "archived" && archiveItems.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" },
					"档案馆是空的 —— 在活动记忆那张卡上点「归档」，它就会收到这里。");
			} else if (statusFilter === "active" && items.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" },
					"活动记忆是空的 —— 状态筛到「已归档」还能捞出 " + archiveItems.length + " 条。");
			} else if (filtered.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, "没有符合搜索或筛选条件的文件。");
			} else {
				const list = h("div", { className: "smem-list", key: "list" }, filtered.map(function (it) {
					if (it.archived === true) {
						return h(ArchivedCard, {
							key: it.file,
							item: it,
							busy: busy,
							restoring: restoring === it.file,
							editing: archEdit === it.file,
							loading: archLoad && archEdit === it.file,
							saving: archSaving && archEdit === it.file,
							text: archText,
							onText: setArchText,
							onEdit: openArchEdit,
							onSave: saveArchEdit,
							onCancel: cancelArchEdit,
							onRestore: restoreFile,
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
								"「编辑」是原样文本编辑，改完存回同一份文件。"),
							list,
						]
					: list;
			}

			return h("div", { className: "smem-root" }, [
				h("div", { className: "smem-tabs", key: "tabs" }, [
					h("button", { type: "button", className: "smem-tab" + (tab === "files" ? " smem-tab--on" : ""), key: "f", onClick: function () { setTab("files"); } }, "文件列表"),
					h("button", { type: "button", className: "smem-tab" + (tab === "star" ? " smem-tab--on" : ""), key: "s", onClick: function () { setTab("star"); } }, "记忆星图"),
					h("button", { type: "button", className: "smem-tab" + (tab === "autodream" ? " smem-tab--on" : ""), key: "d", onClick: function () { setTab("autodream"); } }, "自动做梦"),
				]),
				h("div", { className: "smem-head", key: "head" }, [
					h("span", { className: "smem-title", key: "t" }, "记忆文件（sage-mem）"),
					h("span", { className: "smem-dot" + (dirOk ? "" : " smem-dot--bad"), key: "dot", title: dirOk ? "memory 目录可读" : "memory 目录不可读" }),
					h("span", { className: "smem-muted", key: "st" }, dirOk ? "目录可读" : "目录不可读"),
					h("span", { className: "smem-badge", key: "cnt" }, headerCount),
				]),
				// 搜索 / 刷新 / 添加 / 筛选都只属于「文件列表」这个视图。
				// 放在 tab 分支外面，会让星图和自动做梦页也顶着一排用不上的控件
				// （走查时发现：「+ 添加记忆」出现在星图页上）。
				tab === "files" ? h("div", { className: "smem-toolbar", key: "bar" }, [
					h("input", { className: "smem-search", key: "q", value: query, placeholder: "搜索文件名 / 描述 / 类型 / 标签…", onChange: function (e) { setQuery(e.target.value); } }),
					h("button", { type: "button", className: "smem-btn", key: "refresh", disabled: busy || loading, onClick: load }, "刷新"),
					h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "add", onClick: openAdd }, "+ 添加记忆"),
				]) : null,
				// 三个新入口：一行轻量文字按钮，不跟主工具栏抢重量级，也不各占一块版面。
				// 面板一次只开一个（tool 状态），所以列表始终留在下面。
				tab === "files" ? h("div", { className: "smem-tools", key: "tools" }, [
					h("span", { className: "smem-filters-label", key: "l" }, "工具"),
					h("button", {
						type: "button", className: "smem-tool-btn", key: "audit",
						"data-on": tool === "audit" ? "1" : "0",
						title: "只读体检：索引、双链、frontmatter、行尾",
						onClick: function () { toggleTool("audit"); },
					}, tool === "audit" ? "收起体检" : "体检"),
					h("button", {
						type: "button", className: "smem-tool-btn", key: "cand",
						"data-on": tool === "candidates" ? "1" : "0",
						title: "按闲置天数列出可归档的候选，并逐个执行",
						onClick: function () { toggleTool("candidates"); },
					}, tool === "candidates" ? "收起归档候选" : "归档候选"),
					h("button", {
						type: "button", className: "smem-tool-btn", key: "raw",
						"data-on": tool === "raw" ? "1" : "0",
						title: "索引 / 流水这类保留名：原样文本编辑",
						onClick: function () { toggleTool("raw"); },
					}, tool === "raw" ? "收起保留名编辑" : "保留名编辑"),
				]) : null,
				tab === "files" && tool === "audit"
					? h(AuditPanel, { report: audit, busy: auditBusy, onRun: runAudit })
					: null,
				tab === "files" && tool === "candidates"
					? h(CandidatePanel, {
							data: cand,
							busy: candBusy || busy,
							picked: picked,
							confirm: candConfirm,
							onLoad: loadCandidates,
							onPick: function (file) {
								const nx = Object.assign({}, picked);
								if (nx[file]) delete nx[file]; else nx[file] = true;
								setPicked(nx);
							},
							onPickAll: function () {
								const list = (cand && cand.candidates) || [];
								const all = list.length > 0 && list.every(function (x) { return picked[x.file]; });
								const nx = {};
								if (!all) list.forEach(function (x) { nx[x.file] = true; });
								setPicked(nx);
							},
							onAskOne: function (file) { setCandConfirm(file); },
							onAskPicked: function () { setCandConfirm("__batch__"); },
							onCancelConfirm: function () { setCandConfirm(null); },
							onArchiveOne: function (x) { archiveCandidates([x]); },
							onArchivePicked: function () {
								const list = ((cand && cand.candidates) || []).filter(function (x) { return picked[x.file]; });
								archiveCandidates(list);
							},
						})
					: null,
				tab === "files" && tool === "raw"
					? h(RawPanel, {
							reserved: settings && settings.reserved,
							name: rawName,
							text: rawText,
							isNew: rawIsNew,
							loading: rawLoading,
							busy: rawBusy,
							saving: rawBusy,
							onOpen: openRaw,
							onText: setRawText,
							onSave: saveRaw,
							onClose: function () { setRawName(null); setRawText(""); setRawIsNew(false); },
						})
					: null,
				// 三排筛选：状态 / 类型 / 标签。组内 OR、组间 AND，再与搜索框 AND。
				tab === "files" && totalCount
					? h("div", { className: "smem-filters", key: "filters" }, [
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
							tagList.map(function (g) {
								return h("button", {
									type: "button", key: "tag-" + g, className: "smem-chip",
									"data-on": tagFilter.indexOf(g) >= 0 ? "1" : "0",
									onClick: function () { toggleIn(setTagFilter, g); },
								}, ["#" + g, h("span", { className: "smem-chip-n", key: "n" }, String(tagCounts[g]))]);
							}),
							hasFilter
								? h("button", {
										type: "button", key: "clear", className: "smem-btn",
										onClick: function () { setStatusFilter("all"); setTypeFilter([]); setTagFilter([]); setQuery(""); },
									}, "清除筛选")
								: null,
						])
					: null,
				error ? h("div", { className: "smem-err", key: "err" }, "⚠ " + error) : null,
				notice && !error ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
				formOpen
					? h("div", { className: "smem-form", key: "form" }, [
							h("div", { className: "smem-form-title", key: "ft" }, editingFile ? "编辑 " + editingFile : "添加记忆"),
							h("div", { className: "smem-row", key: "cat" }, [
								h("span", { className: "smem-label", key: "l" }, "类型："),
								h("div", { className: "smem-chips", key: "chips" }, TYPE_ORDER.map(function (t) {
									const meta = TYPE_META[t];
									return h(Chip, { key: t, label: meta[0] + " " + meta[1], on: formType === t, onClick: function () { setFormType(t); } });
								})),
							]),
							h("label", { className: "smem-label", key: "ln" }, "文件名（.md，留空自动 " + formType + "_note.md）"),
							h("input", { className: "smem-input", key: "tn", value: formName, onChange: function (e) { setFormName(e.target.value); }, placeholder: "例如 project_example.md" }),
							h("label", { className: "smem-label", key: "ld" }, "描述（写进 frontmatter，检索与列表都靠它）"),
							h("input", { className: "smem-input", key: "td", value: formDesc, onChange: function (e) { setFormDesc(e.target.value); }, placeholder: "一句话说清这条记忆是什么" }),
							h("label", { className: "smem-label", key: "lt" }, "自定义标签（可选，逗号分隔；会写进 frontmatter 的 tags，列表页可按它筛）"),
							h("input", { className: "smem-input", key: "tt", value: formTags, onChange: function (e) { setFormTags(e.target.value); }, placeholder: "例如 部署, 笔记, dsh" }),
							h("label", { className: "smem-label", key: "lb" }, "正文（可选，frontmatter 自动生成）"),
							h("textarea", { className: "smem-textarea", key: "tb", rows: 6, value: formBody, onChange: function (e) { setFormBody(e.target.value); }, placeholder: "要长期记住的细节" }),
							h("div", { className: "smem-row", key: "btns" }, [
								h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "save", disabled: busy, onClick: submit }, busy ? "保存中…" : "保存"),
								h("button", { type: "button", className: "smem-btn", key: "cancel", disabled: busy, onClick: closeForm }, "取消"),
							]),
						])
					: null,
				tab === "autodream"
					? h(AutodreamPanel, { key: "autodream", ctx: props.ctx })
					: tab === "star"
					? h("div", { className: "smem-starmap", key: "starmap" },
							h(StarmapRuntime.StarMap, { ctx: props.ctx }))
					: filesView,
			]);
		}

