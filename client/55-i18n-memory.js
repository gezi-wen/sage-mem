		// ── i18n pilot: settings.memory ─────────────────────────────────────
		// The `zh` values below are copied verbatim from the strings this shard
		// replaces; they must render byte-identically to the pre-i18n client.
		// The `en` draft is a complete key-for-key translation. Placeholders use
		// the host locale service's own syntax (`{name}`), so a bound `t` and the
		// local fallback below substitute the same way.
		const NS = "settings.memory";

		const ZH = {
			"section.label": "记忆管理",
			"page.back": "返回会话",
			"sidebar.label": "记忆管理",

			"tab.files": "文件列表",
			"tab.star": "记忆星图",
			"tab.autodream": "自动做梦",
			"tab.archive": "自动归档",
			"tab.audit": "体检",

			"type.user": "用户",
			"type.feedback": "反馈",
			"type.project": "项目",
			"type.reference": "参考",
			"type.special": "特殊",

			"header.dirReadable": "memory 目录可读",
			"header.dirUnreadable": "memory 目录不可读",
			"header.dirTitle": "{state} · {tab}",
			"header.counts": "活动中 {active} · 已归档 {archived}",
			"header.countsFiltered": "筛出 {shown} / {total} · 活动中 {active} · 已归档 {archived}",
			"header.auditSwitch": "切到体检看是哪几条",
			"header.auditClean": "体检没有发现问题",
			"header.auditRun": "跑一次体检（只读）",
			"header.auditProblems": "体检 {count} 个问题",
			"header.auditPass": "体检 通过",
			"header.auditNotRun": "体检 · 未跑",
			"header.restartTitle": "有改动要重启 DSH 才生效",
			"header.restartPending": "待重启生效",
			"header.restartPendingCount": "{count} 项待重启生效",
			"header.openFolderTitle": "在系统文件管理器里打开记忆目录",
			"header.openFolder": "打开记忆文件夹",
			"header.refresh": "刷新",
			"action.add": "+ 添加记忆",

			"form.addTitle": "添加记忆",
			"form.editTitle": "编辑 {file}",
			"form.type": "类型：",
			"form.fileName": "文件名（.md，留空自动 {type}_note.md）",
			"form.fileNamePlaceholder": "例如 project_example.md",
			"form.desc": "描述（写进 frontmatter，检索与列表都靠它）",
			"form.descPlaceholder": "一句话说清这条记忆是什么",
			"form.tags": "自定义标签（可选，逗号分隔；会写进 frontmatter 的 tags，列表页可按它筛）",
			"form.tagsPlaceholder": "例如 部署, 笔记, dsh",
			"form.body": "正文（可选，frontmatter 自动生成）",
			"form.bodyPlaceholder": "要长期记住的细节",

			"update.found": "发现新版本 v{latest}（当前 v{current}）",
			"update.notes": "看更新内容",
			"update.dismissTitle": "这次不看了（下次进面板还会提示）",

			"toolbar.search": "搜索文件名 / 描述 / 类型 / 标签…",
			"tools.button": "工具 ▾",
			"tools.title": "归档候选 / 保留名编辑",
			"tools.titleDebug": "归档候选 / 保留名编辑 / 注入调试",
			"tools.candidates": "归档候选",
			"tools.candidatesCount": "{count} 条",
			"tools.candidatesEmpty": "未取",
			"tools.raw": "保留名编辑",
			"tools.rawCount": "{count} 个",
			"tools.debug": "注入调试",
			"tools.debugCount": "{count} 次",

			"filter.sumStatus": "状态：{value}",
			"filter.sumType": "类型：{value}",
			"filter.sumTag": "标签：#{value}",
			"filter.sumQuery": "搜索：{value}",
			"filter.clearAll": "清除全部",
			"filter.statusLabel": "状态",
			"filter.all": "全部",
			"filter.allTitle": "活动与已归档一起看（归档条走灰色）",
			"filter.active": "活动中",
			"filter.activeTitle": "正在参与检索与星图的记忆",
			"filter.archived": "已归档",
			"filter.archivedTitle": "已收进档案馆：不参与检索与星图，可编辑 / 恢复",
			"filter.typeLabel": "类型",
			"filter.tags": "标签",
			"filter.collapseTags": "收起标签",
			"filter.moreTagsTitle": "还有一些标签没显示",
			"filter.moreTags": "更多标签 ({count})",
			"filter.clear": "清除筛选",
			"filter.remove": "撤掉这项筛选",

			"files.emptyTitle": "还没有记忆文件。对话中值得记住的事会写到这里，也可以手动写入。",
			"files.skeletonTitle": "写入一份 MEMORY.md 索引骨架（已有索引不会覆盖）",
			"files.skeleton": "建立索引骨架",
			"files.archiveEmpty": "档案馆是空的 —— 在活动记忆那张卡上点「归档」，它就会收到这里。",
			"files.backToFiles": "回文件列表",
			"files.activeEmpty": "活动记忆是空的 —— 状态筛到「已归档」还能捞出 {count} 条。",
			"files.goArchived": "切到已归档",
			"files.noMatch": "没有符合搜索或筛选条件的文件。",
			"files.archiveIntro": "档案馆里的记忆不参与检索与星图，原文仍在记忆目录的 archive/ 下 —— 恢复后它就回到活动列表；「编辑」是原样文本编辑，改完存回同一份文件；「彻底删除」会真的从 archive/ 里删掉它（不可恢复，删除前还要再确认一次）。",

			"card.typeTitle": "类型 {type}",
			"card.collapse": "点击收起",
			"card.expand": "点击展开全文",
			"card.archiveWhat": "把「{file}」收进档案馆：它不再参与检索与星图，文件移进 archive/，随时可以恢复。",
			"card.archiveReason": "归档理由（可留空）",
			"card.archiveReasonPlaceholder": "例如：结论已被 project_beta 取代",
			"card.archiveHint": "写下当时的判断，以后翻到它时就知道这条还值不值得捞回来。",
			"card.confirmArchive": "确认归档",
			"card.cancel": "取消",
			"card.confirmDelete": "确认删除",
			"card.edit": "编辑",
			"card.lockedTitle": "已锁定：自动归档不会选它，手动归档也会被拒绝。点一下解锁",
			"card.unlockedTitle": "锁定这条记忆：自动与手动归档都不再动它（重要的人设 / 偏好建议锁上）",
			"card.locked": "🔒 已锁定",
			"card.lock": "🔓 锁定",
			"card.archiveLockedTitle": "这条已锁定，归档会被拒绝（先解锁）",
			"card.archiveTitle": "收进档案馆：不再参与检索与星图，随时可以恢复",
			"card.archive": "归档",
			"card.delete": "删除",
			"card.archivedAtTitle": "归档时间",
			"card.archivedAt": "已归档 {at}",
			"card.unknownTime": "（时间未知）",
			"card.reason": "归档理由：{reason}",
			"card.noReason": "（没写）",
			"card.rawEditNote": "原样文本编辑：下面就是这份文件的全文（含 frontmatter 与归档留痕），保存时原样写回，不会被重新生成。",
			"card.reading": "读取中…",
			"card.saving": "保存中…",
			"card.save": "保存",
			"card.purgeWhat": "彻底删除「{file}」：它会从 archive/ 里被真的删掉，不能恢复。要保留它就先点「恢复」，把它放回活动记忆。",
			"card.purgeHint": "这一步之后没有任何界面能把内容找回来 —— 只剩你自己在磁盘上留过备份。",
			"card.confirmPurge": "确认彻底删除",
			"card.restoring": "恢复中…",
			"card.restore": "恢复",
			"card.purgeTitle": "从 archive/ 里彻底删掉，不可恢复（要留就先恢复）",
			"card.purge": "彻底删除",

			"star.ask": "⭐ 顺手留颗 Star，作者能高兴一整天",
			"star.cta": "行，给你一颗 Star",

			"pluginCard.saveFailed": "保存失败（未知原因）",
			"pluginCard.noSetSettings": "宿主侧还没有 setSettings 接口（插件版本较旧）",
			"pluginCard.title": "侧栏入口",
			"pluginCard.on": "已开启",
			"pluginCard.off": "已关闭",
			"pluginCard.label": "在侧栏显示「记忆管理」入口",
			"pluginCard.note": "默认开启；改动立即生效，不需要重启。关闭后「设置 → 记忆管理」入口仍然保留。",

			"error.remote": "remote 调用失败",
			"error.listFiles": "listFiles RPC 失败: {message}",
			"error.noRaw": "宿主侧还没有 readRaw / writeRaw 接口（插件版本较旧）",
			"error.noOpenDir": "宿主侧还没有 openMemoryDir 接口（插件版本较旧）",
			"error.noArchive": "宿主侧还没有 archive 接口（插件版本较旧）",
			"error.noLock": "宿主侧还没有 setLocked 接口（插件版本较旧）",
			"error.noRestore": "宿主侧还没有 restore 接口（插件版本较旧）",
			"error.noDeleteArchived": "宿主侧还没有 deleteArchived 接口（插件版本较旧）",
			"error.noReadArchived": "宿主侧还没有 readArchived 接口（插件版本较旧）",
			"error.noWriteArchived": "宿主侧还没有 writeArchived 接口（插件版本较旧）",
			"error.noAudit": "宿主侧还没有 audit 接口（插件版本较旧）",
			"error.noArchiveCandidates": "宿主侧还没有 archiveCandidates 接口（插件版本较旧）",
			"error.noGetSettings": "宿主侧还没有 getSettings 接口（插件版本较旧）",
			"error.noReadRaw": "宿主侧还没有 readRaw 接口（插件版本较旧）",
			"error.noWriteRaw": "宿主侧还没有 writeRaw 接口（插件版本较旧）",
			"error.readFailed": "读不到 {file}：{message}",
			"error.descEmpty": "描述不能为空",
			"error.writeRejected": "写入被拒绝",
			"error.deleteRejected": "删除被拒绝",
			"error.archiveRejected": "归档被拒绝",
			"error.lockRejected": "锁定操作被拒绝",
			"error.restoreRejected": "恢复被拒绝",
			"error.saveRejected": "保存被拒绝",
			"error.skeletonFailed": "建立索引骨架失败",
			"error.openDirFailed": "打开记忆目录失败",
			"notice.indexExists": "MEMORY.md 已经存在，没有改动它。",
			"notice.indexCreated": "已建立 MEMORY.md 索引骨架。",
			"notice.updated": "已更新 {file}",
			"notice.saved": "已保存 {file}",
			"notice.rawNew": "已新建 {file}",
			"notice.deleted": "已删除 {file}",
			"notice.archived": "已归档 {file} —— 它现在在「已归档」视图里，随时可以恢复",
			"notice.batchPartial": "已归档 {done} 条，{failed} 条没成功：{files}",
			"notice.batchDone": "已归档 {done} 条 —— 它们现在在档案馆里，随时可以恢复",
			"notice.locked": "已锁定 {file} —— 自动归档不会再选它，手动归档也会被拒绝",
			"notice.unlocked": "已解锁 {file}",
			"notice.restored": "已恢复 {file} —— 它回到了活动记忆里",
			"notice.restoredIndexed": "已恢复 {file} —— 它回到了活动记忆里，并补进了索引",
			"notice.purged": "已彻底删除 {file} —— 归档区里也没有它了，找不回来",
		};

		const EN = {
			"section.label": "Memory management",
			"page.back": "Back to conversation",
			"sidebar.label": "Memory management",

			"tab.files": "Files",
			"tab.star": "Star map",
			"tab.autodream": "Autodream",
			"tab.archive": "Auto-archive",
			"tab.audit": "Audit",

			"type.user": "User",
			"type.feedback": "Feedback",
			"type.project": "Project",
			"type.reference": "Reference",
			"type.special": "Special",

			"header.dirReadable": "memory directory readable",
			"header.dirUnreadable": "memory directory unreadable",
			"header.dirTitle": "{state} · {tab}",
			"header.counts": "Active {active} · Archived {archived}",
			"header.countsFiltered": "Showing {shown} / {total} · Active {active} · Archived {archived}",
			"header.auditSwitch": "Switch to Audit to see which entries",
			"header.auditClean": "Audit found no problems",
			"header.auditRun": "Run an audit (read-only)",
			"header.auditProblems": "Audit: {count} problems",
			"header.auditPass": "Audit passed",
			"header.auditNotRun": "Audit · not run",
			"header.restartTitle": "Changes take effect after restarting DSH",
			"header.restartPending": "restart to apply",
			"header.restartPendingCount": "{count} items pending restart",
			"header.openFolderTitle": "Open the memory directory in the system file manager",
			"header.openFolder": "Open memory folder",
			"header.refresh": "Refresh",
			"action.add": "+ Add memory",

			"form.addTitle": "Add memory",
			"form.editTitle": "Edit {file}",
			"form.type": "Type:",
			"form.fileName": "File name (.md; leave blank to use {type}_note.md automatically)",
			"form.fileNamePlaceholder": "e.g. project_example.md",
			"form.desc": "Description (written to frontmatter; retrieval and the list both rely on it)",
			"form.descPlaceholder": "One sentence saying what this memory is",
			"form.tags": "Custom tags (optional, comma-separated; written to frontmatter tags, filterable in the list)",
			"form.tagsPlaceholder": "e.g. deploy, notes, dsh",
			"form.body": "Body (optional; frontmatter is generated automatically)",
			"form.bodyPlaceholder": "Details worth remembering long-term",

			"update.found": "New version v{latest} available (current v{current})",
			"update.notes": "See what's new",
			"update.dismissTitle": "Skip this time (it will show again next time)",

			"toolbar.search": "Search file name / description / type / tag…",
			"tools.button": "Tools ▾",
			"tools.title": "Archive candidates / Reserved-name editor",
			"tools.titleDebug": "Archive candidates / Reserved-name editor / Injection debug",
			"tools.candidates": "Archive candidates",
			"tools.candidatesCount": "{count}",
			"tools.candidatesEmpty": "not loaded",
			"tools.raw": "Reserved-name editor",
			"tools.rawCount": "{count}",
			"tools.debug": "Injection debug",
			"tools.debugCount": "{count}",

			"filter.sumStatus": "Status: {value}",
			"filter.sumType": "Type: {value}",
			"filter.sumTag": "Tag: #{value}",
			"filter.sumQuery": "Search: {value}",
			"filter.clearAll": "Clear all",
			"filter.statusLabel": "Status",
			"filter.all": "All",
			"filter.allTitle": "See active and archived together (archived rows are grey)",
			"filter.active": "Active",
			"filter.activeTitle": "Memories currently participating in retrieval and the star map",
			"filter.archived": "Archived",
			"filter.archivedTitle": "Moved to the archive: out of retrieval and the star map; can be edited / restored",
			"filter.typeLabel": "Type",
			"filter.tags": "Tags",
			"filter.collapseTags": "Collapse tags",
			"filter.moreTagsTitle": "Some tags are hidden",
			"filter.moreTags": "More tags ({count})",
			"filter.clear": "Clear filters",
			"filter.remove": "Remove this filter",

			"files.emptyTitle": "No memory files yet. Things worth remembering from a conversation are written here, and you can add them by hand.",
			"files.skeletonTitle": "Write a MEMORY.md index skeleton (an existing index is never overwritten)",
			"files.skeleton": "Create index skeleton",
			"files.archiveEmpty": "The archive is empty — press Archive on an active memory card and it will land here.",
			"files.backToFiles": "Back to files",
			"files.activeEmpty": "There are no active memories — switching the status filter to Archived still finds {count}.",
			"files.goArchived": "Switch to archived",
			"files.noMatch": "No files match the search or filters.",
			"files.archiveIntro": "Archived memories stay out of retrieval and the star map; the original text remains in archive/ under the memory directory — restoring returns it to the active list. Edit opens the raw text and saves back to the same file; Delete permanently really removes it from archive/ (irreversible, and asks once more before deleting).",

			"card.typeTitle": "Type {type}",
			"card.collapse": "Click to collapse",
			"card.expand": "Click to expand",
			"card.archiveWhat": "Move “{file}” into the archive: it stops participating in retrieval and the star map, moves under archive/, and can be restored at any time.",
			"card.archiveReason": "Archive reason (optional)",
			"card.archiveReasonPlaceholder": "e.g. superseded by project_beta",
			"card.archiveHint": "Write down the judgment you are making now, so a future reader knows whether this is still worth recovering.",
			"card.confirmArchive": "Confirm archive",
			"card.cancel": "Cancel",
			"card.confirmDelete": "Confirm delete",
			"card.edit": "Edit",
			"card.lockedTitle": "Locked: auto-archive never selects it and a manual archive is refused. Click to unlock",
			"card.unlockedTitle": "Lock this memory: auto and manual archiving both leave it alone (lock important personas / preferences)",
			"card.locked": "🔒 Locked",
			"card.lock": "🔓 Lock",
			"card.archiveLockedTitle": "This memory is locked, so archiving will be refused (unlock first)",
			"card.archiveTitle": "Move into the archive: out of retrieval and the star map, restorable at any time",
			"card.archive": "Archive",
			"card.delete": "Delete",
			"card.archivedAtTitle": "Archived at",
			"card.archivedAt": "Archived {at}",
			"card.unknownTime": "(time unknown)",
			"card.reason": "Archive reason: {reason}",
			"card.noReason": "(not written)",
			"card.rawEditNote": "Raw text editing: what follows is the whole file (including frontmatter and archive traces). Saving writes it back unchanged, without regenerating anything.",
			"card.reading": "Reading…",
			"card.saving": "Saving…",
			"card.save": "Save",
			"card.purgeWhat": "Permanently delete “{file}”: it is really removed from archive/ and cannot be recovered. To keep it, press Restore first and put it back among the active memories.",
			"card.purgeHint": "After this step no screen can bring the content back — only a backup you kept on disk can.",
			"card.confirmPurge": "Confirm permanent delete",
			"card.restoring": "Restoring…",
			"card.restore": "Restore",
			"card.purgeTitle": "Remove permanently from archive/, irreversible (restore first to keep it)",
			"card.purge": "Delete permanently",

			"star.ask": "⭐ Leave a star — it makes the author's day",
			"star.cta": "Sure, here's a star",

			"pluginCard.saveFailed": "Save failed (unknown reason)",
			"pluginCard.noSetSettings": "The host has no setSettings API yet (older plugin version)",
			"pluginCard.title": "Sidebar entry",
			"pluginCard.on": "On",
			"pluginCard.off": "Off",
			"pluginCard.label": "Show the “Memory management” entry in the sidebar",
			"pluginCard.note": "On by default; changes take effect immediately, no restart needed. Turning it off keeps the Settings → Memory management entry.",

			"error.remote": "remote call failed",
			"error.listFiles": "listFiles RPC failed: {message}",
			"error.noRaw": "The host has no readRaw / writeRaw API yet (older plugin version)",
			"error.noOpenDir": "The host has no openMemoryDir API yet (older plugin version)",
			"error.noArchive": "The host has no archive API yet (older plugin version)",
			"error.noLock": "The host has no setLocked API yet (older plugin version)",
			"error.noRestore": "The host has no restore API yet (older plugin version)",
			"error.noDeleteArchived": "The host has no deleteArchived API yet (older plugin version)",
			"error.noReadArchived": "The host has no readArchived API yet (older plugin version)",
			"error.noWriteArchived": "The host has no writeArchived API yet (older plugin version)",
			"error.noAudit": "The host has no audit API yet (older plugin version)",
			"error.noArchiveCandidates": "The host has no archiveCandidates API yet (older plugin version)",
			"error.noGetSettings": "The host has no getSettings API yet (older plugin version)",
			"error.noReadRaw": "The host has no readRaw API yet (older plugin version)",
			"error.noWriteRaw": "The host has no writeRaw API yet (older plugin version)",
			"error.readFailed": "Cannot read {file}: {message}",
			"error.descEmpty": "Description cannot be empty",
			"error.writeRejected": "Write rejected",
			"error.deleteRejected": "Delete rejected",
			"error.archiveRejected": "Archive rejected",
			"error.lockRejected": "Lock operation rejected",
			"error.restoreRejected": "Restore rejected",
			"error.saveRejected": "Save rejected",
			"error.skeletonFailed": "Failed to create the index skeleton",
			"error.openDirFailed": "Failed to open the memory directory",
			"notice.indexExists": "MEMORY.md already exists; it was left unchanged.",
			"notice.indexCreated": "MEMORY.md index skeleton created.",
			"notice.updated": "Updated {file}",
			"notice.saved": "Saved {file}",
			"notice.rawNew": "Created {file}",
			"notice.deleted": "Deleted {file}",
			"notice.archived": "Archived {file} — it is now under the Archived view and can be restored at any time",
			"notice.batchPartial": "Archived {done}, {failed} failed: {files}",
			"notice.batchDone": "Archived {done} — they are now in the archive and can be restored at any time",
			"notice.locked": "Locked {file} — auto-archive will not select it and a manual archive will be refused",
			"notice.unlocked": "Unlocked {file}",
			"notice.restored": "Restored {file} — it is back among the active memories",
			"notice.restoredIndexed": "Restored {file} — it is back among the active memories and was added to the index",
			"notice.purged": "Permanently deleted {file} — it is gone from the archive as well and cannot be recovered",
		};

		/**
		 * Local placeholder fill, used only when the host has no locale service.
		 * Mirrors the locale runtime: `{name}` is replaced, unknown names stay.
		 */
		function i18nFill(template, params) {
			if (!params) return template;
			return String(template).replace(/\{(\w+)\}/g, function (match, name) {
				return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
			});
		}

		/** The zh dictionary is the fallback: a host without locale renders today's UI. */
		function i18nZh(key, params) {
			return i18nFill(Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key, params);
		}

		// Bound in `apply` when (and only when) the host provides the locale service.
		let t = i18nZh;

		/** Known type ids get translated; unknown frontmatter values stay visible. */
		function typeLabel(id) {
			const key = "type." + String(id);
			return Object.prototype.hasOwnProperty.call(ZH, key) ? t(key) : String(id);
		}

		/** Same for the tab names used in the directory tooltip. */
		function tabLabel(id) {
			const key = "tab." + String(id);
			return Object.prototype.hasOwnProperty.call(ZH, key) ? t(key) : "";
		}

		/**
		 * Register the dictionaries and bind `t`, optionally.
		 *
		 * `locale` is NOT a hard dependency (it is absent in older hosts, the
		 * render harness and the unit tests): without it everything above keeps
		 * rendering from `ZH`. Registration goes through `ctx.effect`, so the
		 * dictionary is withdrawn when this plugin is disposed.
		 */
		function setupI18n(ctx) {
			let locale = null;
			try {
				if (ctx && typeof ctx.get === "function") locale = ctx.get("locale");
				if (!locale && ctx && ctx.locale) locale = ctx.locale;
			} catch (e) {
				locale = null;
			}
			if (!locale || typeof locale.bind !== "function") return false;
			const install = function () {
				let dispose = null;
				if (typeof locale.register === "function") {
					dispose = locale.register(NS, { zh: ZH, en: EN });
				} else {
					return null;
				}
				t = locale.bind(NS);
				return dispose;
			};
			if (typeof ctx.effect === "function") ctx.effect(install, "sage-mem: i18n " + NS);
			else install();
			return true;
		}
