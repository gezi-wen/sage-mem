		function Section(props) {
			// 走 stableRemote：真实宿主里 `ctx.get()` 每次返回新对象（issue #3 的成因）。
			// 这个面板的 effect 依赖是 `[]`、暂时不会爆，但引用稳定是**所有**面板的共同前提。
			const remote = stableRemote(props.ctx, "remote.memory");
			const sItems = react.useState([]);
			const items = sItems[0], setItems = sItems[1];
			const sLoading = react.useState(false);
			const loading = sLoading[0], setLoading = sLoading[1];
			const sError = react.useState(null);
			const error = sError[0], setError = sError[1];
			const sNotice = react.useState("");
			const notice = sNotice[0], setNotice = sNotice[1];
			const sQuery = react.useState("");
			const sTagOpen = react.useState(false);
			const tagOpen = sTagOpen[0], setTagOpen = sTagOpen[1];
			const query = sQuery[0], setQuery = sQuery[1];
			const sExpanded = react.useState({});
			const expanded = sExpanded[0], setExpanded = sExpanded[1];
			// Q16：卡片「展开 / 收起」是业务回调（FilesView 只上报点了哪张卡）。
			// 必须走**函数式** setState：事件里捕获的 expanded 可能是上一帧快照，
			// 直接 Object.assign({}, expanded, …) 会把连续点击的上一笔改动覆盖掉。
			function onToggleExpanded(file) {
				setExpanded(function (prev) { return mergeExpanded(prev, file); });
			}
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
			// 2.1.2（Q02）：打开编辑时读到的**版本**（readFile 的 revision）。保存时原样带回；
			// 宿主发现盘上已变就回 stale_revision，编辑框与草稿原地保留，绝不自动重试覆盖。
			const sFormRevision = react.useState(null);
			const formRevision = sFormRevision[0], setFormRevision = sFormRevision[1];
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
			// 「彻底删除」的二次确认：正在问哪一条（null = 没在问）。
			// 与 editing 互斥 —— 同一张卡上不能既在改又在删。
			const sArchDelete = react.useState(null);
			const archDelete = sArchDelete[0], setArchDelete = sArchDelete[1];
			// 归档文件的「原样文本」编辑器：正在编辑谁、编辑框里是什么、读/存进行中
			const sArchEdit = react.useState(null);
			const archEdit = sArchEdit[0], setArchEdit = sArchEdit[1];
			const sArchText = react.useState("");
			const archText = sArchText[0], setArchText = sArchText[1];
			// 2.1.2（Q02）：这份归档件读到的版本（保存时带回；冲突时草稿保留）
			const sArchRevision = react.useState(null);
			const archRevision = sArchRevision[0], setArchRevision = sArchRevision[1];
			const sArchLoad = react.useState(false);
			const archLoad = sArchLoad[0], setArchLoad = sArchLoad[1];
			const sArchSaving = react.useState(false);
			const archSaving = sArchSaving[0], setArchSaving = sArchSaving[1];
			// ── 工具面板（体检 / 归档候选 / 保留名原样编辑）──
			// 三个入口收进「工具 ▾」抽屉：关着时零占位，点开才占版面。
			// 面板一次只开一个（tool 状态），列表始终留在下面。
			// ⚠️ 抽屉本身不负责「可发现」——那是头部带上常显徽标的活。所以 audit / settings
			// 在面板挂载时就各拉一次（都只读）：体检有几个问题、有没有待重启项，不打开也看得见。
			const sDrawer = react.useState(false);
			const drawer = sDrawer[0], setDrawer = sDrawer[1];
			// 自动做梦的二级分段状态放在这里（不放面板内部）：头部带的「待重启生效」徽标
			// 点一下就切到自动做梦·设置那一段，需要跨组件指路。
			const sAdSeg = react.useState("run");
			const adSeg = sAdSeg[0], setAdSeg = sAdSeg[1];
			const sTool = react.useState(null);
			const tool = sTool[0], setTool = sTool[1];
			const sAudit = react.useState(null);
			const audit = sAudit[0], setAudit = sAudit[1];
			const sAuditBusy = react.useState(false);
			const auditBusy = sAuditBusy[0], setAuditBusy = sAuditBusy[1];
			// 更新提示：只在**确实有新版本**时才被赋值（查不到/限流/网络错都不赋值）
			const sUpdate = react.useState(null);
			const updateInfo = sUpdate[0], setUpdateInfo = sUpdate[1];
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
			// 2.1.2（Q02）：这份保留名文件读到的版本；null + rawIsNew = 走 createIfAbsent 新建
			const sRawRevision = react.useState(null);
			const rawRevision = sRawRevision[0], setRawRevision = sRawRevision[1];
			const sRawBusy = react.useState(false);
			const rawBusy = sRawBusy[0], setRawBusy = sRawBusy[1];
			const sRawLoading = react.useState(false);
			const rawLoading = sRawLoading[0], setRawLoading = sRawLoading[1];
			// ── 注入调试（1.7.0）──
			// 入口**只在 SAGE_MEM_DEBUG=1 时出现**：挂载时问宿主一次（enabled 由宿主每次现读
			// 环境变量），关着就什么都不显示、抽屉里也不多一项。
			const sDbgOn = react.useState(false);
			const dbgOn = sDbgOn[0], setDbgOn = sDbgOn[1];
			const sDbg = react.useState(null);
			const dbg = sDbg[0], setDbg = sDbg[1];
			const sDbgBusy = react.useState(false);
			const dbgBusy = sDbgBusy[0], setDbgBusy = sDbgBusy[1];
			// ── 冲突页签（2.0.0 矛盾检测）──
			// 能力检测分两层：remote 整个不存在 → 页签与徽标都不出现（旧宿主）；
			// remote 在、某个动作方法缺失 → 按钮禁用并在屏上写明缺哪个接口（版本错配时
			// 绝不能变成「点了没反应」—— D25 的教训）。
			const conflictRemote = stableRemote(props.ctx, "remote.conflict");
			const conflictOk = !!(conflictRemote && typeof conflictRemote.list === "function");
			const sConf = react.useState(null);
			const conf = sConf[0], setConf = sConf[1];
			const sConfLoad = react.useState(false);
			const confLoad = sConfLoad[0], setConfLoad = sConfLoad[1];
			const sConfErr = react.useState(null);
			const confErr = sConfErr[0], setConfErr = sConfErr[1];
			// 正文按 id 缓存（只在展开时去 read）；记录一变（裁决 / 刷新）就整批丢掉。
			const sConfBodies = react.useState({});
			const confBodies = sConfBodies[0], setConfBodies = sConfBodies[1];
			const sConfExpanded = react.useState({});
			const confExpanded = sConfExpanded[0], setConfExpanded = sConfExpanded[1];
			// 危险动作的两段式确认：{id, action, file}（null = 没在问）。
			const sConfConfirm = react.useState(null);
			const confConfirm = sConfConfirm[0], setConfConfirm = sConfConfirm[1];
			const sConfBusy = react.useState(null);
			const confBusy = sConfBusy[0], setConfBusy = sConfBusy[1];
			// renderSlot：shell 会经 props 传进来（见 80-apply 的 children 声明），
			// 但本插件改用并列 tab 渲染星图，不再调用它 —— 声明保留给 shell，这里不取。

			function load() {
				setLoading(true);
				setError(null);
				remote.listFiles()
					.then(function (res) {
						if (res && typeof res === "object" && res.ok === false) {
							const msg = res.error && res.error.message ? res.error.message : t("error.remote");
							throw new Error(t("error.listFiles", { message: msg }));
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

			react.useEffect(function () {
				load();
				// 头部带的两个徽标要有数据才立得住：体检（只读扫描）与待重启项。
				runAudit();
				loadSettings();
				// 1.7.0：只读问一次「调试开关开着吗」—— 关着时抽屉里不会多出「注入调试」。
				// 这是唯一一处为调试视图多付的调用（一次本地只读 remote，不碰磁盘）。
				loadRecallDebug();
				// 2.0.0：冲突徽标与体检徽标同一套道理 —— 不打开也知道有没有待裁决的。
				// 旧宿主没有 conflict 面时 conflictOk=false，这里一个调用都不发。
				loadConflicts();
				/**
				 * 更新检查：**静默**跑，失败一律不打扰 ——
				 * 网络不通、被 GitHub 限流、仓库还没建 release，都不该在面板上冒一条红。
				 * 只有 `updateAvailable` 为真才把结果放进 state，界面才有一条横幅。
				 */
				if (remote && typeof remote.checkUpdate === "function") {
					remote.checkUpdate()
						.then(function (r) {
							const d = unwrap(r);
							if (d && d.updateAvailable) setUpdateInfo(d);
						})
						.catch(function () { /* 查版本失败不是用户的事 */ });
				}
			}, []);

			/**
			 * 抽屉「点外部 / Esc 关闭」。
			 *
			 * ⚠️ 监听**只在展开时挂**（依赖 [drawer]）：关着时一个 document 监听都没有 ——
			 * 「点外部关闭」绝不能变成「点哪儿都没反应」。cleanup 里成对摘掉，不留悬挂监听。
			 * 用 click 而不是 pointerdown：宿主的弹窗里 pointerdown 可能被别的控件的拖拽吃掉。
			 * 点抽屉里的条目也一样会关（条目自己的 onClick 先把它设成 false，这里再设一次无害）。
			 */
			react.useEffect(function () {
				if (!drawer) return undefined;
				if (typeof document === "undefined" || !document.addEventListener) return undefined;
				/**
				 * ⚠️ **必须放过「抽屉内部」的点击**（2026-10-24 真机实测的 bug）。
				 *
				 * 打开抽屉的那一次点击，会在这个 effect 挂上监听之后**继续冒泡到 document**。
				 * DevTools 里记到的顺序：`DOC:工具 ▾@911408 → 弹层 ADD@911410 → REMOVE@911412`
				 * —— 弹层活了 2 毫秒就关掉自己，按钮连变色都来不及，用户看到的是
				 * 「点了完全没反应」。
				 *
				 * 为什么测试没抓到：测试点按钮是直接调 `onClick`，不经过真实的事件冒泡，
				 * 所以「同一次点击既开又关」这条路径在假环境里根本不存在。
				 *
				 * 判据用 `closest("[data-smem-drawer]")` 而不是比 DOM 引用：按钮与弹层条目
				 * 都在带这个属性的 span 里，text / svg 子节点也照样命中；也不依赖事件对象
				 * 上别的字段（测试喂一个只有 closest 的 target 就能复现）。
				 */
				function onOutside(e) {
					const t = e && e.target;
					if (t && typeof t.closest === "function" && t.closest("[data-smem-drawer]")) return;
					setDrawer(false);
				}
				function onKey(e) { if (e && (e.key === "Escape" || e.keyCode === 27)) setDrawer(false); }
				document.addEventListener("click", onOutside);
				document.addEventListener("keydown", onKey);
				return function () {
					document.removeEventListener("click", onOutside);
					document.removeEventListener("keydown", onKey);
				};
			}, [drawer]);

			function closeForm() {
				setFormOpen(false); setEditingFile(null); setFormName(""); setFormDesc(""); setFormBody(""); setFormType("feedback");
				setFormFm(null); setFormBaseType(""); setFormTags("");
				setFormRevision(null);
			}

			// 空记忆库时「建立索引骨架」写进去的引导文件。它只是给人看的起点：
			// 索引本来就是手写维护的，这里不猜用户有什么记忆、也不生成假条目。
			const INDEX_SKELETON = [
				"# 记忆索引",
				"",
				"> 这是 sage-mem 的记忆索引骨架：每条记忆一行，链接到同目录下的一个 Markdown 文件。",
				"> 索引由人（或 agent）手写维护，不是自动生成的；改写前建议先备份。",
				"",
				"## 活动记忆",
				"",
				"<!-- 一条记忆一行：「- [标题](文件名.md) — 一句话描述」 -->",
				"",
				"## 四类记忆",
				"",
				"- `user_*`：关于用户的事实与偏好",
				"- `feedback_*`：用户给的工作方式指导",
				"- `project_*`：进行中的工作与状态",
				"- `reference_*`：外部信息在哪找",
				"",
			].join("\n");

			function createIndexSkeleton() {
				setError(null);
				setNotice("");
				if (!remote || typeof remote.writeRaw !== "function") {
					setError(t("error.noRaw"));
					return;
				}
				setBusy(true);
				// 2.1.10（Q10）：只调**一个意图接口**（writeRaw 的 createIfAbsent）：
				// 服务端负责「全新安装、memory 目录还不存在」时先建父目录；
				// 已有索引 → 明确回 already_exists（逐字节不动）。绝不再「先读一次、读失败就当
				// 可以覆盖」—— 读失败也可能是权限错误，而那正是会顶掉一份真索引的路。
				remote.writeRaw("MEMORY.md", INDEX_SKELETON, { create: true }).then(function (res) {
					const out = unwrap(res);
					setBusy(false);
					if (out && out.code === "already_exists") { setNotice(t("notice.indexExists")); return; }
					if (out && out.ok === false) { setError(out.error || t("error.skeletonFailed")); return; }
					setNotice(t("notice.indexCreated"));
					load();
				}).catch(function (e) {
					setBusy(false);
					setError(String((e && e.message) || e));
				});
			}

			function openMemoryFolder() {
				setError(null);
				if (!remote || typeof remote.openMemoryDir !== "function") {
					setError(t("error.noOpenDir"));
					return;
				}
				remote.openMemoryDir()
					.then(function (res) {
						const result = unwrap(res);
						if (result && result.ok === false) setError(result.error || t("error.openDirFailed"));
					})
					.catch(function (e) { setError(String((e && e.message) || e)); });
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
						// 2.1.2（Q02）：把这一版的 revision 一起记住（保存时带回；旧宿主没有就是 null）
						setFormRevision(typeof data.revision === "string" ? data.revision : null);
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
				setFormRevision(null);
				setFormOpen(true);
			}

			function submit() {
				if (!formDesc.trim()) { setError(t("error.descEmpty")); return; }
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
				// 2.1.2（Q02）：编辑已有文件时交回读到的 revision（盘上变了 → 宿主拒绝）；
				// 新建走 createIfAbsent —— 撞上同名文件是**明确报已存在**，绝不覆盖入口。
				const writeOpts = editingFile
					? (formRevision ? { expectedRevision: formRevision } : undefined)
					: { create: true };
				remote.writeFile(safeName, content, writeOpts)
					.then(function (r) {
						// host 侧对保留名 / 非字符串内容 / 超限一律返回 { ok: false, error }，不再抛异常。
						// 冲突看**结构化 code**（stale_revision / already_exists），不解析文案：
						// 编辑框不关、草稿原地保留，由用户看过最新内容后自己决定重新应用 —— 绝不自动重试覆盖。
						if (r && r.ok === false) { setError(r.error || t("error.writeRejected")); return; }
						closeForm();
						setNotice(t(editingFile ? "notice.updated" : "notice.saved", { file: safeName }));
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			function confirmDelete(file) {
				setBusy(true); setError(null); setNotice("");
				remote.deleteFile(file)
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || t("error.deleteRejected")); return; }
						setDeleting(null);
						setNotice(t("notice.deleted", { file: file }));
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
					setError(t("error.noArchive"));
					return;
				}
				setBusy(true); setError(null); setNotice("");
				remote.archive(file, archiveReason.trim())
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || t("error.archiveRejected")); return; }
						setArchiving(null);
						setArchiveReason("");
						setNotice(t("notice.archived", { file: file }));
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			/**
			 * 上锁 / 解锁一条记忆。
			 *
			 * 锁定 = **拒绝归档**（自动归档的候选里不出现、手动点归档也被宿主拒绝），
			 * **不是「只读」** —— 文案必须按这个说，否则用户会以为锁上就不能编辑了。
			 */
			function toggleLock(file, locked) {
				if (typeof remote.setLocked !== "function") {
					setError(t("error.noLock"));
					return;
				}
				setBusy(true); setError(null); setNotice("");
				remote.setLocked(file, locked)
					.then(function (r) {
						const d = unwrap(r);
						if (d && d.ok === false) { setError(d.error || t("error.lockRejected")); return; }
						setNotice(locked
							? t("notice.locked", { file: file })
							: t("notice.unlocked", { file: file }));
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			/** 从档案馆捞回来：文件移回记忆目录，归档留痕被抹掉。 */
			function restoreFile(file) {				if (typeof remote.restore !== "function") {
					setError(t("error.noRestore"));
					return;
				}
				setBusy(true); setError(null); setNotice("");
				setRestoring(file);
				setArchDelete(null);
				remote.restore(file)
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || t("error.restoreRejected")); return; }
						// 恢复会顺带把这条补进索引：说清楚，否则用户不知道「漏索引」是怎么好的
						setNotice(t(r && r.indexed ? "notice.restoredIndexed" : "notice.restored", { file: file }));
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); setRestoring(null); });
			}

			/**
			 * **彻底删除**一条归档件（不可恢复）。
			 *
			 * 第二、第三个参数是身份判据：`archivedAt` 是展示时间，`revision` 是**内容身份**
			 * （归档代次 + 正文 revision，2.1.6 起）。宿主拿它们核对「要删的是不是我看过的那一版」——
			 * 只传时间的话，正文被改成同时间戳的另一版、或同一分钟内重新归档，旧确认都会删错。
			 * 二次确认只是交互，服务端的版本核对才是判据。
			 */
			function deleteArchivedFile(file) {
				if (typeof remote.deleteArchived !== "function") {
					setError(t("error.noDeleteArchived"));
					return;
				}
				const item = archiveItems.filter(function (x) { return x.file === file; })[0];
				const stamp = (item && item.archivedAt) || "";
				const revision = (item && item.revision) || "";
				setBusy(true); setError(null); setNotice("");
				remote.deleteArchived(file, stamp, revision)
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || t("error.deleteRejected")); return; }
						setArchDelete(null);
						setNotice(t("notice.purged", { file: file }));
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
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
					setError(t("error.noReadArchived"));
					return;
				}
				setError(null); setNotice("");
				setArchDelete(null);
				setArchEdit(file);
				setArchText("");
				setArchRevision(null);
				setArchLoad(true);
				remote.readArchived(file)
					.then(function (r) {
						const d = unwrap(r);
						setArchText(d && typeof d.content === "string" ? d.content : "");
						// 2.1.2（Q02）：记住这一版的 revision（保存时带回）
						setArchRevision(d && typeof d.revision === "string" ? d.revision : null);
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
					setError(t("error.noWriteArchived"));
					return;
				}
				setArchSaving(true); setError(null); setNotice("");
				// 原样交回：不 trim、不补 frontmatter、不做任何「智能」处理。
				// 2.1.2（Q02）：带上读到的 revision；归档件在别处被改过 → 宿主回 stale_revision，
				// 编辑框与文本原地保留（不自动重试覆盖）。
				const writeOpts = archRevision ? { expectedRevision: archRevision } : undefined;
				remote.writeArchived(file, archText, writeOpts)
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || t("error.saveRejected")); return; }
						setArchEdit(null);
						setNotice(t("notice.saved", { file: file }));
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setArchSaving(false); });
			}

			function cancelArchEdit() { setArchEdit(null); setArchText(""); setArchRevision(null); }

			// ── 工具面板的三个数据通道 ──────────────────────────────────────

			function runAudit() {
				if (typeof remote.audit !== "function") { setError(t("error.noAudit")); return; }
				setAuditBusy(true); setError(null);
				remote.audit()
					.then(function (r) { setAudit(unwrap(r) || null); })
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setAuditBusy(false); });
			}

			function loadCandidates() {
				if (typeof remote.archiveCandidates !== "function") { setError(t("error.noArchiveCandidates")); return; }
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
				if (typeof remote.getSettings !== "function") { setError(t("error.noGetSettings")); return; }
				remote.getSettings()
					.then(function (r) { const d = unwrap(r) || {}; setSettings(d); })
					.catch(function (e) { setError(String((e && e.message) || e)); });
			}

			/**
			 * 拉一次注入调试账（1.7.0）。
			 *
			 * 返回值同时决定入口出不出现：`enabled === false` 时「工具」抽屉里不渲染
			 * 「注入调试」这一项 —— 这是路线图「关掉调试开关时界面不出现」的落地方式。
			 *
			 * 旧宿主没有 recallDebug → 什么都不做、不报错（与 openMemoryDir / readRaw 同一套降级）。
			 */
			function loadRecallDebug() {
				if (!remote || typeof remote.recallDebug !== "function") return;
				setDbgBusy(true);
				remote.recallDebug()
					.then(function (r) {
						const d = unwrap(r) || {};
						setDbgOn(d.enabled === true);
						setDbg(d);
					})
					.catch(function () { setDbgOn(false); })
					.then(function () { setDbgBusy(false); });
			}

			/**
			 * 拉一次冲突队列（只读）。
			 *
			 * 头部徽标与「冲突」页签数的是同一批记录，所以挂载时就取一次（旧宿主没有
			 * conflict 面 → conflictOk=false，这里整段不跑，界面一个像素都不变）。
			 * 失败返回 `{ok:false, code}` 而不是抛 —— 契约的一部分，转成可读文案。
			 */
			function loadConflicts() {
				if (!conflictOk) return;
				setConfLoad(true); setConfErr(null);
				Promise.resolve()
					.then(function () { return conflictRemote.list(); })
					.then(function (res) {
						// ⚠️ 必须过 unwrap：typert remote 的通用传输层把返回值包成
						// `{ok:true, value:<方法返回值>}`。**方法返回值里自带的 `ok` 是内层**，
						// 与信封的 `ok` 是两个东西 —— 2026-10-27 真机就栽在这：直接把信封当
						// payload 读，`items` 永远是 undefined，界面显示「0 条待裁决」，
						// 而网络层明明返回了记录。与 76-sidebar-entry 的 setSettings 不同：
						// 那是特例，这里是通用路径。
						const d = unwrap(res) || {};
						if (d.ok === false) { setConf(null); setConfErr(conflictErrText(d)); return; }
						setConf({
							items: Array.isArray(d.items) ? d.items : [],
							broken: Array.isArray(d.broken) ? d.broken : [],
							ignored: Array.isArray(d.ignored) ? d.ignored : [],
							counts: d.counts && typeof d.counts === "object" ? d.counts : { open: 0, total: 0 },
						});
					})
					.catch(function (e) { setConf(null); setConfErr(String((e && e.message) || e)); })
					.then(function () { setConfLoad(false); });
			}

			/**
			 * 冲突动作的失败文案：先按 `code` 给出路，再附上宿主给的一句细节。
			 * 失败码是界面上**唯一**能把「为什么没成」翻译成下一步动作的地方 —— 尤其
			 * stale_version / write_denied / unsupported 三条，不问清就只会反复点同一颗按钮。
			 */
			function conflictErrText(err) {
				const code = err && typeof err.code === "string" ? err.code : "";
				const key = CONFLICT_CODE_KEY[code] || "conflict.code.unknown";
				const detail = err && typeof err.error === "string" ? err.error : "";
				return t(key) + (detail ? t("conflict.code.detail", { detail: detail }) : "");
			}

			/** 打开「冲突」这一屏。数据没取过才取（挂载时已经取过一次，通常直接有内容）。 */
			function openConflictTab() {
				setTab("conflict");
				setError(null); setNotice("");
				if (!conf || confErr) loadConflicts();
			}

			/**
			 * 展开 / 收起一条记录的两份正文。
			 *
			 * 正文只在**展开那一刻**才 read：列表阶段不取（记录里可能带几十 KB 正文），
			 * 而且展开后要把「宿主截断了」这件事显示出来。
			 */
			function toggleConflictBodies(item) {
				if (!conflictOk || typeof conflictRemote.read !== "function") return;
				const was = confExpanded[item.id] === true;
				const next = Object.assign({}, confExpanded);
				if (was) {
					delete next[item.id];
					setConfExpanded(next);
					return;
				}
				next[item.id] = true;
				setConfExpanded(next);
				if (confBodies[item.id] && confBodies[item.id].record) return;
				const mark = function (patch) {
					setConfBodies(function (cur) {
						const nx = Object.assign({}, cur);
						nx[item.id] = Object.assign({}, cur[item.id] || {}, patch);
						return nx;
					});
				};
				mark({ loading: true, error: null });
				Promise.resolve()
					.then(function () { return conflictRemote.read({ id: item.id }); })
					.then(function (res) {
						const d = unwrap(res) || {};
						if (d.ok === false) { mark({ loading: false, error: conflictErrText(d) }); return; }
						mark({
							loading: false,
							record: d.record || null,
							warnings: Array.isArray(d.warnings) ? d.warnings : [],
						});
					})
					.catch(function (e) { mark({ loading: false, error: String((e && e.message) || e) }); });
			}

			/**
			 * 请求一个动作。dismiss 不写记忆文件、按设计表**不需要二次确认**；标失效 /
			 * 撤销失效 / 删记录都会走两段式（前两个写文件，后一个不可恢复）。
			 */
			function askConflict(item, action) {
				setError(null); setNotice("");
				if (action === "dismiss") { runConflictNow(item.id, action, ""); return; }
				// 标失效默认选记录里的 `file`（= 被提议标失效的一方）；撤销时默认显示
				// 记录里真正被标过的那一方（invalidatedFile）。
				const file = action === "undo"
					? (item.invalidatedFile || item.file || "")
					: (item.file || item.otherFile || "");
				setConfConfirm({ id: item.id, action: action, file: file });
			}

			/** 两段式确认里改「标哪一方失效」（矛盾记录有两方）。 */
			function pickConflictFile(file) {
				setConfConfirm(function (cur) {
					return cur ? Object.assign({}, cur, { file: file }) : cur;
				});
			}

			function cancelConflictConfirm() { setConfConfirm(null); }

			function runConflictAction() {
				if (!confConfirm) return;
				runConflictNow(confConfirm.id, confConfirm.action, confConfirm.file);
			}

			/**
			 * 真正执行一个裁决动作。
			 *
			 * 顺序刻意固定：成功 → 清确认条 / 清正文缓存 → 重新拉队列 → 再刷记忆列表
			 * （invalidate / undo 改了记忆文件，文件列表与星图都得跟着变）。
			 * 失败**不动**记录之外的任何状态：错误文案（含出路）挂在全局错误条上。
			 */
			function runConflictNow(id, action, file) {
				if (!conflictOk) { setError(t("error.noConflict")); return; }
				const fn = conflictRemote[action];
				if (typeof fn !== "function") {
					setError(t("conflict.actionMissing", { method: action }));
					return;
				}
				const opts = { id: id };
				if (action === "invalidate" && file) opts.file = file;
				setConfBusy(id); setError(null); setNotice("");
				Promise.resolve()
					.then(function () { return fn.call(conflictRemote, opts); })
					.then(function (res) {
						const d = unwrap(res) || {};
						if (d.ok === false) { setError(conflictErrText(d)); return; }
						const rec = d.record || {};
						setConfConfirm(null);
						// 记录变了：正文缓存与展开状态一起作废，避免展示已过期的正文。
						setConfBodies({});
						setConfExpanded({});
						if (action === "invalidate") {
							const wrote = d.wrote || {};
							setNotice(t("notice.conflictInvalidated", {
								file: rec.invalidatedFile || wrote.file || file,
							}));
						} else if (action === "dismiss") {
							setNotice(t("notice.conflictDismissed"));
						} else if (action === "undo") {
							const cleared = d.cleared || {};
							setNotice(t("notice.conflictUndone", {
								file: rec.invalidatedFile || cleared.file || file,
							}));
						} else {
							setNotice(t("notice.conflictRemoved"));
						}
						loadConflicts();
						// 只有真的写过记忆文件的动作才需要重扫文件列表。
						if (action === "invalidate" || action === "undo") load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setConfBusy(null); });
			}

			/** 从冲突记录跳到文件列表看这条记忆（清掉筛选，否则可能被筛没）。 */
			function openConflictFile(name) {
				if (!name) return;
				setError(null);
				setTab("files");
				setStatusFilter("all");
				setTypeFilter([]);
				setTagFilter([]);
				setQuery(String(name));
			}

			/**
			 * 打开 / 收起一个工具面板。数据只在第一次打开时拉；已经拉过就复用
			 * （「刷新」「重新体检」是显式动作，别替用户反复扫目录）。
			 */
			function toggleTool(name) {
				const next = tool === name ? null : name;
				setTool(next);
				setError(null);
				if (next === "candidates" && !cand) loadCandidates();
				if (next === "raw" && !settings) loadSettings();
				// 调试账每次都重新取：它记的是「最近几次」，多一步就多一条 —— 缓存没有意义。
				if (next === "debug") loadRecallDebug();
			}

			/**
			 * 切到「体检」这一屏。
			 *
			 * 体检从工具抽屉里独立出来了（它本来就是「看」不是「做」），排在「自动做梦」之后。
			 * 数据没拉过才拉：初始加载已经跑过一次体检（头部带那个徽标要有数据才立得住），
			 * 切过来通常直接就看得见内容。
			 */
			function openAuditTab() {
				setTab("audit");
				setError(null);
				if (!audit) runAudit();
			}

			/** 打开某个工具（抽屉里点进来时用）。 */
			function openTool(name) {
				setTool(name);
				setError(null);
				if (name === "candidates" && !cand) loadCandidates();
				if (name === "raw" && !settings) loadSettings();
			}

			/**
			 * 执行归档（逐条 / 批量都走这里）。reason 用候选算出来的那个
			 * —— 归档留痕要写清「为什么」，不能把模型/界面的判断丢掉。
			 */
			function archiveCandidates(list) {
				if (!list.length) return;
				if (typeof remote.archive !== "function") { setError(t("error.noArchive")); return; }
				setBusy(true); setError(null); setNotice("");
				const done = [];
				const failed = [];
				const step = function (i) {
					if (i >= list.length) {
						setBusy(false);
						setCandConfirm(null);
						setPicked({});
						setNotice(failed.length
							? t("notice.batchPartial", { done: done.length, failed: failed.length, files: failed.join("、") })
							: t("notice.batchDone", { done: done.length }));
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
				if (typeof remote.readRaw !== "function") { setError(t("error.noReadRaw")); return; }
				setError(null); setNotice("");
				setRawName(name);
				setRawText("");
				setRawIsNew(false);
				setRawRevision(null);
				setRawLoading(true);
				remote.readRaw(name)
					.then(function (r) {
						const d = unwrap(r);
						setRawText(d && typeof d.content === "string" ? d.content : "");
						// 2.1.2（Q02）：记住这一版的 revision（保存时带回）
						setRawRevision(d && typeof d.revision === "string" ? d.revision : null);
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
						setError(t("error.readFailed", { file: name, message: msg }));
						setRawLoading(false);
						setRawName(null);
					});
			}

			function saveRaw(name) {
				if (typeof remote.writeRaw !== "function") { setError(t("error.noWriteRaw")); return; }
				setRawBusy(true); setError(null); setNotice("");
				// 原样交回：不 trim、不补 frontmatter、不做任何「智能」处理。
				// 2.1.2（Q02）：新建走 createIfAbsent（撞名明确失败、不覆盖）；编辑带读到的 revision
				// （盘上变了 → stale_revision，文本原地保留，绝不自动重试覆盖）。
				const writeOpts = rawIsNew
					? { create: true }
					: (rawRevision ? { expectedRevision: rawRevision } : undefined);
				remote.writeRaw(name, rawText, writeOpts)
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || t("error.saveRejected")); return; }
						setNotice(t(rawIsNew ? "notice.rawNew" : "notice.saved", { file: name }));
						setRawIsNew(false);
						// 保存成功后把版本换成刚写下的那一版，连续保存不用重读
						if (r && typeof r.revision === "string") setRawRevision(r.revision);
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
			// 标签最多平铺 6 个：再多就把筛选条撑成三行，而真正常用的标签通常就那几个。
			const TAG_VISIBLE_MAX = 6;
			const tagShown = tagOpen ? tagList : tagList.slice(0, TAG_VISIBLE_MAX);
			const tagHiddenCount = tagList.length - tagShown.length;
			// 汇总行里每一项都是「现在正在筛什么 + 单独撤掉它」；只出现有筛选时。
			function sumItem(label, onRemove) {
				return h("span", { className: "smem-sum-item", key: "sum-" + label }, [
					label,
					h("button", { type: "button", className: "smem-sum-x", key: "x", title: t("filter.remove"), onClick: onRemove }, "×"),
				]);
			}
			// 两个计数永远一起露脸：用户不必先筛状态才知道档案馆里有没有东西。
			const headerCount = hasFilter
				? t("header.countsFiltered", { shown: filtered.length, total: statusItems.length, active: items.length, archived: archiveItems.length })
				: t("header.counts", { active: items.length, archived: archiveItems.length });
			// 头部带的「待重启生效」徽标：有多少项要重启才生效，从 limits / pendingLimits 的差算出来
			// （reserved 名单的变化 getSettings 只给 restartRequired 布尔值，数不出来就不写数）。
			const LIMIT_KEYS = ["maxResults", "maxChars", "maxBaseline", "maxSessionBytes", "staleDays"];
			const pendingDiff = (settings && settings.limits && settings.pendingLimits)
				? LIMIT_KEYS.filter(function (k) { return settings.limits[k] !== settings.pendingLimits[k]; }).length
				: 0;
			const restartPending = !!(settings && settings.restartRequired);
			// 冲突徽标数的是**待裁决**（open）条数 —— 与冲突页签里的「N 条待裁决」同源。
			// -1 = 还没取到队列（显示「未载」，不假装 0 条）。
			const conflictOpen = conf && conf.counts && typeof conf.counts.open === "number" ? conf.counts.open : -1;

			// 「文件列表」这一屏：状态筛选决定看哪一批，灰色卡片与留痕块自带「退役」语义。
			// banner 只在**专门看归档**时出现，切到全部时不重复说一遍。
			const filesView = h(FilesView, {
				loading: loading, totalCount: totalCount, openAdd: openAdd, createIndexSkeleton: createIndexSkeleton,
				statusFilter: statusFilter, setStatusFilter: setStatusFilter,
				items: items, archiveItems: archiveItems, filtered: filtered,
				setTypeFilter: setTypeFilter, setTagFilter: setTagFilter, setQuery: setQuery,
				busy: busy, restoring: restoring,
				archDelete: archDelete, archEdit: archEdit, archLoad: archLoad, archSaving: archSaving,
				archText: archText, setArchText: setArchText,
				openArchEdit: openArchEdit, saveArchEdit: saveArchEdit, cancelArchEdit: cancelArchEdit,
				restoreFile: restoreFile, setArchDelete: setArchDelete, setArchEdit: setArchEdit, deleteArchivedFile: deleteArchivedFile,
				expanded: expanded, onToggleExpanded: onToggleExpanded, deleting: deleting, archiving: archiving,
				archiveReason: archiveReason, setArchiveReason: setArchiveReason,
				setArchiving: setArchiving, setDeleting: setDeleting,
				confirmArchive: confirmArchive, toggleLock: toggleLock,
				openEdit: openEdit, confirmDelete: confirmDelete,
			});


			return h("div", { className: "smem-root" }, [
				h("div", { className: "smem-tabs", key: "tabs", role: "tablist" }, [
					h("button", { type: "button", className: "smem-tab" + (tab === "files" ? " smem-tab--on" : ""), key: "f", role: "tab", "aria-selected": tab === "files" ? "true" : "false", onClick: function () { setTab("files"); } }, t("tab.files")),
					h("button", { type: "button", className: "smem-tab" + (tab === "star" ? " smem-tab--on" : ""), key: "s", role: "tab", "aria-selected": tab === "star" ? "true" : "false", onClick: function () { setTab("star"); } }, t("tab.star")),
					h("button", { type: "button", className: "smem-tab" + (tab === "autodream" ? " smem-tab--on" : ""), key: "d", role: "tab", "aria-selected": tab === "autodream" ? "true" : "false", onClick: function () { setTab("autodream"); } }, t("tab.autodream")),
					// 视觉分组：左边「看」（文件列表 / 星图），右边「设置 · 自动化」。
					h("span", { className: "smem-tabs-sep", key: "sep", "aria-hidden": "true" }),
					// 「自动归档」排在自动做梦之后：归档是**确定性规则**（按闲置天数算，不调模型），
					// 和「让模型整理记忆」是两件事。塞在自动做梦的设置里用户找不到
					// （2026-10-11 用户原话：「扔这里连我都找不到」）。
					h("button", { type: "button", className: "smem-tab" + (tab === "archive" ? " smem-tab--on" : ""), key: "ar", role: "tab", "aria-selected": tab === "archive" ? "true" : "false", onClick: function () { setTab("archive"); } }, t("tab.archive")),
					// 体检再排在「自动归档」之后、独立成一屏：它只报告不修改，和「文件列表」里的
					// 增删改是两件事，塞在工具抽屉里会让人以为它是个动作按钮。
					h("button", { type: "button", className: "smem-tab" + (tab === "audit" ? " smem-tab--on" : ""), key: "a", role: "tab", "aria-selected": tab === "audit" ? "true" : "false", onClick: openAuditTab }, t("tab.audit")),
					// 2.0.0「冲突」：裁决是**多动作、要逐条看两份正文**的流程，所以独立成第 6 个
					// 页签，而不是塞进工具抽屉（抽屉方案的前提是「一年用不了几次」）。
					// 没有 conflict 面的旧宿主：整颗不出现（能力检测，不是渲染错误）。
					conflictOk
						? h("button", { type: "button", className: "smem-tab" + (tab === "conflict" ? " smem-tab--on" : ""), key: "c", role: "tab", "aria-selected": tab === "conflict" ? "true" : "false", onClick: openConflictTab }, t("tab.conflict"))
						: null,
				]),
				// 四个 tab 共用的一条头部带：我在哪 · 目录状态 · 活动/归档计数 · 体检徽标 · 待重启徽标 · 主操作。
				// 层级形状固定：导航＝下划线（.smem-tabs）、筛选＝chip、动作＝按钮，三种不混用。
				h("div", { className: "smem-head", key: "head" }, [
					h("span", { className: "smem-title", key: "t" }, t("section.label")),
					// 目录状态收进状态点的 title（不可读时下面另有一条 smem-err，错误本来就该显眼）。
					h("span", { className: "smem-dot" + (dirOk ? "" : " smem-dot--bad"), key: "dot", title: t("header.dirTitle", { state: dirOk ? t("header.dirReadable") : t("header.dirUnreadable"), tab: tabLabel(tab) }) }),
					h("span", { className: "smem-badge", key: "cnt" }, headerCount),
					// 体检徽标：**抽屉关着也一直看得见**，点它就切到「体检」那一屏。
					h("button", {
						type: "button", key: "aud",
						className: "smem-tool-badge" + (audit && audit.problems ? " smem-tool-badge--bad" : ""),
						title: audit ? (audit.problems ? t("header.auditSwitch") : t("header.auditClean")) : t("header.auditRun"),
						onClick: openAuditTab,
					}, audit ? (audit.problems ? t("header.auditProblems", { count: audit.problems }) : t("header.auditPass")) : t("header.auditNotRun")),
					// 冲突徽标：与体检徽标同一套「抽屉关着也一直看得见」。**没有 conflict 面
					// 的旧宿主整颗不出现**（页签也不出现），不是灰按钮 —— 那会让用户以为插件坏了。
					conflictOk
						? h("button", {
								type: "button", key: "cf",
								className: "smem-tool-badge" + (conflictOpen > 0 ? " smem-tool-badge--bad" : ""),
								title: !conf
									? t("header.conflictMissing")
									: conflictOpen > 0 ? t("header.conflictSwitch") : t("header.conflictClean"),
								onClick: openConflictTab,
							}, !conf ? t("header.conflictNotRun")
								: conflictOpen > 0 ? t("header.conflictOpen", { count: conflictOpen })
								: t("header.conflictEmpty"))
						: null,
					restartPending
						? h("button", {
								type: "button", key: "rs", className: "smem-tool-badge smem-ad-badge--warn",
								title: t("header.restartTitle"),
								onClick: function () { setTab("autodream"); setAdSeg("settings"); },
							}, t(pendingDiff ? "header.restartPendingCount" : "header.restartPending", { count: pendingDiff }))
						: null,
					// 主操作：只放当前 tab 的那一个（星图/自动做梦的主操作在各自面板里，不重复摆一份）。
					// 弹簧：把主操作顶到右边。**换行时它留在上一行**，主操作于是落到下一行、
					// 左顶格 —— 这正是用 `margin-left:auto` 做不到的（那会把换行后的主操作
					// 也推到最右，看起来像"跑出格子了"）。
					h("span", { className: "smem-head-spacer", key: "sp" }),
					h("span", { className: "smem-head-actions", key: "act" }, tab === "files" ? [
						h("button", { type: "button", className: "smem-btn", key: "open", disabled: busy || !dirOk, title: t("header.openFolderTitle"), onClick: openMemoryFolder }, t("header.openFolder")),
						h("button", { type: "button", className: "smem-btn", key: "refresh", disabled: busy || loading, onClick: load }, t("header.refresh")),
						h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "add", onClick: openAdd }, t("action.add")),
					] : null),
				]),
				// 更新提示：四个 tab 共用一条，只在真有新版时出现；「×」只是这次不看
				updateInfo
					? h("div", { className: "smem-update", key: "update" }, [
							h("span", { key: "t" }, t("update.found", { latest: updateInfo.latest, current: updateInfo.current })),
							h("a", {
								key: "l", className: "smem-update-link",
								href: updateInfo.releasesUrl || "https://github.com/gezi-wen/sage-mem/releases",
								target: "_blank", rel: "noreferrer",
							}, t("update.notes")),
							h("button", {
								type: "button", key: "x", className: "smem-update-x",
								title: t("update.dismissTitle"),
								onClick: function () { setUpdateInfo(null); },
							}, "×"),
						])
					: null,
				// 工具栏只剩「搜索 + 工具 ▾」：刷新与添加已经收进头部带的主操作位。
				tab === "files" ? h("div", { className: "smem-toolbar", key: "bar" }, [
					h("input", { className: "smem-search", key: "q", value: query, placeholder: t("toolbar.search"), onChange: function (e) { setQuery(e.target.value); } }),
					// 工具抽屉：关着时这里只有一个按钮，零占位；面板一次只开一个。
					// `data-smem-drawer` 是「点外部关闭」的排除标记：这一整块里的点击
					// 都算「抽屉内部」，包括开抽屉的那一次点击本身（见上面 effect 的长注释）。
					h("span", { className: "smem-drawer", key: "drawer", "data-smem-drawer": "1" }, [
						h("button", {
							type: "button", key: "btn",
							className: "smem-btn" + (drawer ? " smem-btn-primary" : ""),
							"aria-expanded": drawer ? "true" : "false",
							"aria-haspopup": "menu",
							title: t(dbgOn ? "tools.titleDebug" : "tools.title"),
							onClick: function () { setDrawer(!drawer); },
						}, t("tools.button")),
						drawer ? h("div", { className: "smem-drawer-pop", key: "pop" }, [
							// 体检独立成 tab 之后，抽屉里只剩这两件「要动手」的事。
							h("button", {
								type: "button", className: "smem-drawer-item", key: "c",
								"data-on": tool === "candidates" ? "1" : "0",
								onClick: function () { toggleTool("candidates"); setDrawer(false); },
							}, [t("tools.candidates"), h("span", { className: "smem-status", key: "s" }, cand ? t("tools.candidatesCount", { count: cand.count }) : t("tools.candidatesEmpty"))]),
							h("button", {
								type: "button", className: "smem-drawer-item", key: "r",
								"data-on": tool === "raw" ? "1" : "0",
								onClick: function () { toggleTool("raw"); setDrawer(false); },
							}, [t("tools.raw"), h("span", { className: "smem-status", key: "s" }, settings && settings.reserved ? t("tools.rawCount", { count: settings.reserved.length }) : "")]),
							// 1.7.0：只在调试开关打开时出现（关着时抽屉仍是两项，界面零变化）
							dbgOn ? h("button", {
								type: "button", className: "smem-drawer-item", key: "d",
								"data-on": tool === "debug" ? "1" : "0",
								onClick: function () { toggleTool("debug"); setDrawer(false); },
							}, [t("tools.debug"), h("span", { className: "smem-status", key: "s" }, dbg && Array.isArray(dbg.records) ? t("tools.debugCount", { count: dbg.records.length }) : "")]) : null,
						]) : null,
					]),
				]) : null,
				tab === "audit"
					? h(AuditPanel, { report: audit, busy: auditBusy, onRun: runAudit, standalone: true })
					: null,
				tab === "files" && tool === "candidates"
					? h(CandidatePanel, {
							data: cand,
							busy: candBusy || busy,
							picked: picked,
							confirm: candConfirm,
							onLoad: loadCandidates,
							onClose: function () { setTool(null); },
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
				// 1.7.0：注入调试。只读面板；数据在打开那一刻现取（最近 8 次），
				// 「刷新」是显式动作 —— 与体检 / 候选同一条交互约定。
				tab === "files" && tool === "debug"
					? h(RecallDebugPanel, {
							data: dbg,
							busy: dbgBusy,
							onReload: loadRecallDebug,
							onClose: function () { setTool(null); },
						})
					: null,
				// 三排筛选：状态 / 类型 / 标签。组内 OR、组间 AND，再与搜索框 AND。
				tab === "files" && totalCount
					? h(FilterBar, {
						hasFilter: hasFilter, statusFilter: statusFilter, setStatusFilter: setStatusFilter,
						totalCount: totalCount, items: items, archiveItems: archiveItems, statusItems: statusItems,
						typeFilter: typeFilter, setTypeFilter: setTypeFilter, typeList: typeList, typeCounts: typeCounts,
						tagList: tagList, tagShown: tagShown, tagHiddenCount: tagHiddenCount, tagCounts: tagCounts,
						tagFilter: tagFilter, setTagFilter: setTagFilter, tagOpen: tagOpen, setTagOpen: setTagOpen,
						TAG_VISIBLE_MAX: TAG_VISIBLE_MAX, query: query, setQuery: setQuery,
						toggleIn: toggleIn, sumItem: sumItem,
					})
					: null,
				error ? h("div", { className: "smem-err", key: "err", role: "alert" }, "⚠ " + error) : null,
				notice && !error ? h("div", { className: "smem-ok", key: "ok", role: "status" }, "✓ " + notice) : null,
				formOpen
					? h("div", { className: "smem-form", key: "form" }, [
							h("div", { className: "smem-form-title", key: "ft" }, editingFile ? t("form.editTitle", { file: editingFile }) : t("form.addTitle")),
							h("div", { className: "smem-row", key: "cat" }, [
								h("span", { className: "smem-label", key: "l" }, t("form.type")),
								h("div", { className: "smem-chips", key: "chips" }, TYPE_ORDER.map(function (id) {
									const meta = TYPE_META[id];
									return h(Chip, { key: id, label: meta[0] + " " + typeLabel(id), on: formType === id, onClick: function () { setFormType(id); } });
								})),
							]),
							h("label", { className: "smem-label", key: "ln" }, t("form.fileName", { type: formType })),
							h("input", { className: "smem-input", key: "tn", value: formName, onChange: function (e) { setFormName(e.target.value); }, placeholder: t("form.fileNamePlaceholder") }),
							h("label", { className: "smem-label", key: "ld" }, t("form.desc")),
							h("input", { className: "smem-input", key: "td", value: formDesc, onChange: function (e) { setFormDesc(e.target.value); }, placeholder: t("form.descPlaceholder") }),
							h("label", { className: "smem-label", key: "lt" }, t("form.tags")),
							h("input", { className: "smem-input", key: "tt", value: formTags, onChange: function (e) { setFormTags(e.target.value); }, placeholder: t("form.tagsPlaceholder") }),
							h("label", { className: "smem-label", key: "lb" }, t("form.body")),
							h("textarea", { className: "smem-textarea", key: "tb", rows: 6, value: formBody, onChange: function (e) { setFormBody(e.target.value); }, placeholder: t("form.bodyPlaceholder") }),
							h("div", { className: "smem-row", key: "btns" }, [
								h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "save", disabled: busy, onClick: submit }, busy ? t("card.saving") : t("card.save")),
								h("button", { type: "button", className: "smem-btn", key: "cancel", disabled: busy, onClick: closeForm }, t("card.cancel")),
							]),
						])
					: null,
				tab === "autodream"
					? h(AutodreamPanel, { key: "autodream", ctx: props.ctx, seg: adSeg, onSeg: setAdSeg })
					: tab === "star"
					? h("div", { className: "smem-starmap", key: "starmap" },
							h(StarmapRuntime.StarMap, { ctx: props.ctx }))
					: tab === "archive"
					? h(ArchiveSettingsPanel, { key: "archive", ctx: props.ctx })
					: tab === "audit"
					// 体检面板在上面已经渲染过了 —— 这里必须显式给 null，
					// 否则会落进下面那个 `filesView` 兜底分支，变成「体检 + 一整套文件列表」同屏。
					? null
					: tab === "conflict"
					? h(ConflictPanel, {
							key: "conflict",
							data: conf,
							loading: confLoad,
							error: confErr,
							bodies: confBodies,
							expanded: confExpanded,
							confirm: confConfirm,
							busyId: confBusy,
							// 逐动作的能力检测：宿主有 list 没 invalidate（版本错配）时按钮要禁用，
							// 不是点了之后才报错。
							tools: {
								list: conflictOk,
								read: !!(conflictOk && typeof conflictRemote.read === "function"),
								invalidate: !!(conflictOk && typeof conflictRemote.invalidate === "function"),
								dismiss: !!(conflictOk && typeof conflictRemote.dismiss === "function"),
								undo: !!(conflictOk && typeof conflictRemote.undo === "function"),
								removeRecord: !!(conflictOk && typeof conflictRemote.removeRecord === "function"),
							},
							onReload: loadConflicts,
							onToggleBodies: toggleConflictBodies,
							onAsk: askConflict,
							onPickFile: pickConflictFile,
							onCancelConfirm: cancelConflictConfirm,
							onRun: runConflictAction,
							onOpenFile: openConflictFile,
						})
					: filesView,
				// 底部一行仓库链接（四个 tab 都在，不抢视线）
				h(StarLine, { key: "star-line" }),
			]);
		}

