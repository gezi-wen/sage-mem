		// ── 手写 strict codec（浏览器无 zod，typert 只要求 parse 方法）──
		// 基元（parseSchema / isStr / isBool / isNum / strSchema）在 05-shared.js。
		const isStrArr = (v) => { if (!Array.isArray(v)) throw new Error("expected string array"); for (const x of v) isStr(x); };
		// 字段必须与宿主 `lib/typert.host.js` 的 fileSchema **同宽**（strict 会剥掉未声明字段）：
		// 少了 tags / locked，列表页的「按标签筛」与「锁定」按钮就永远拿到 undefined。
		const fileSchema = parseSchema({ "file": isStr, "type": isStr, "description": isStr, "size": isNum, "tags": isStrArr, "locked": isBool });
		const listSchema = { fields: fileSchema.fields, parse(v) { if (!Array.isArray(v)) throw new Error("expected array"); v.forEach((f) => fileSchema.parse(f)); return v; } };
		const readSchema = withOptional(parseSchema({ "name": isStr, "content": isStr }), ["revision"]);
		const writeSchema = optionalFields(parseSchema({ "ok": isBool, "file": isStr }), { "error": isStr, "code": isStr, "revision": isStr });
		const deleteSchema = optionalFields(parseSchema({ "ok": isBool }), { "error": isStr });
		// `archived` 每颗星都有（活动星是 false）；archivedAt / archivedReason 只对归档星出现，
		// 且旧版 autodream 归档的文件没有它们 —— 所以是 optional（与宿主 manifest 一致）。
		const starmapStarSchema = withOptional(
			parseSchema({ "file": isStr, "kind": isStr, "title": isStr, "desc": isStr, "bytes": isNum, "mtimeMs": isNum, "archived": isBool }),
			["archivedAt", "archivedReason"],
		);
		const starmapListSchema = { fields: ["count", "stars"], elementFields: starmapStarSchema.fields, parse(v) { if (!v || typeof v !== "object") throw new Error("expected object"); if (!Array.isArray(v.stars)) throw new Error("expected stars array"); v.stars.forEach((f) => starmapStarSchema.parse(f)); return v; } };
		const starmapReadSchema = parseSchema({ "name": isStr, "content": isStr });

		// ── 归档区（v0.9.0 档案馆）──
		// 客户端只声明 remote 面：面板上的「已归档」区由后续 UI 任务接。
		// 结果 codec 与宿主 manifest 逐字段对齐（ArchiveResult 的 file / error 都可选，
		// 成功回 file、失败回 error，所以这里只硬校 ok）。
		const boolSchema = { parse(v) { isBool(v); return v; } };
		// 归档结果（宿主的 archiveResultSchema）：**除 ok 外全部 optional**。失败分支没有 file，
		// 把它当必填会把「失败」判成坏结果 —— 宿主的 typert.host.js 有同一条注释。
		// `unindexed` / `indexed` 是 boolean，所以不能套 withOptional（那个只做 isStr）。
		const archiveResultFields = { "file": isStr, "error": isStr, "archivedReason": isStr, "unindexed": isBool, "indexed": isBool, "indexError": isStr };
		const archiveResultSchema = optionalFields(parseSchema({ "ok": isBool }), archiveResultFields);
		// archive / restore / deleteArchived / writeArchived 四个 remote 共用这一个形状。
		const archiveSchema = archiveResultSchema;
		const archivedFileSchema = parseSchema({
			"file": isStr, "type": isStr, "description": isStr, "size": isNum,
			"tags": isStrArr,
			"archivedAt": isStr, "archivedReason": isStr,
			// 2.1.6（外部审查 Q07）：内容身份（归档代次 + 正文 revision）。它不是装饰 ——
			// 「彻底删除」必须把它原样交回宿主，否则只能按名字删，而名字不是身份。
			"revision": isStr,
		});
		const archivedListSchema = {
			fields: ["count", "files"],
			elementFields: archivedFileSchema.fields,
			parse(v) {
				if (!v || typeof v !== "object") throw new Error("sage-mem: expected object");
				if (!Array.isArray(v.files)) throw new Error("sage-mem: expected files array");
				v.files.forEach((f) => archivedFileSchema.parse(f));
				return v;
			},
		};
		// 归档文件的读 / 写（B1b）：形状与活跃记忆那套的 readSchema / writeSchema 对称。
		const archivedReadSchema = withOptional(parseSchema({ "name": isStr, "content": isStr }), ["revision"]);
		// 宿主 `archivedWriteResultSchema` 与 `writeResultSchema` **同形、只是类型名不同**
		// （typert.host.js 的注释明说这一点）——所以直接复用 writeSchema 的字段面。
		const archivedWriteSchema = writeSchema;
		// 「彻底删除」的入参：`archivedAt`（展示时间）+ `revision`（内容身份，见 archive.js 的
		// archivedRevisionOf）。两个都不是装饰 —— 宿主拿它们核对「要删的是不是用户确认过的那一版」；
		// 只有前者的旧确认在 2.1.6 起会被宿主拒绝（分钟精度的时间不是内容身份）。
		const archiveStampSchema = strSchema;
		const archiveRevisionSchema = { parse(v) { isStr(v); if (v.length === 0) throw new Error("sage-mem: expected revision"); return v; } };

		// ── 2.1.2（Q02）写协议：读快照 revision / 写回执的 additive 字段 / 写选项 ──
		/**
		 * **可选**字段校型：新宿主一定给（读 revision、写 code / revision），旧宿主没有。
		 * 混合版本环境里「旧宿主 + 新面板」必须还能用，所以这里不能当必填字段拒掉；
		 * 但字段给了就必须是字符串 —— 否则面板拿到一个数字或对象会静默走错分支。
		 */
		function optionalFields(base, spec) {
			return {
				// 可选字段并入字段集：对表时宿主 zod 的 optional 字段也在它的 shape 里，
				// 两边必须一样宽，否则「客户端没声明 optional 字段」会被误报成漂移。
				fields: (base.fields || []).concat(Object.keys(spec)),
				parse(v) {
					base.parse(v);
					for (const [k, check] of Object.entries(spec)) if (k in v) check(v[k]);
					return v;
				},
			};
		}
		/** 可选字段全是字符串时的简写（读 revision / 写 code / revision）。 */
		function withOptional(base, keys) {
			return optionalFields(base, Object.fromEntries(keys.map((k) => [k, isStr])));
		}
		/**
		 * 写协议的第三参（`{ expectedRevision?, create? }`）——**两个字段都可选**。
		 * 不传 = 旧调用方，行为与从前一致（宿主会打一条 warn）；传了就必须是正确类型。
		 */
		const writeOptsSchema = {
			parse(v) {
				if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("sage-mem: expected object");
				if ("expectedRevision" in v) isStr(v.expectedRevision);
				if ("create" in v) isBool(v.create);
				return v;
			},
		};

		// ── autodream 的 codec ──
		// 刻意写得宽：这几个方法返回的是配置 / 状态对象，字段会随版本增删。
		// 用 parseSchema 逐字段硬写一遍的代价是 —— host 那边加一个字段，client 的旧
		// schema 就把整条调用当「缺字段」拒掉（parseSchema 会 throw missing field），
		// 于是插件一升级、界面就整体报错。所以顶层类型严格、内部宽松。
		const objCodec = {
			parse(v) {
				if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("sage-mem: expected object");
				return v;
			},
		};
		const arrCodec = {
			parse(v) {
				if (!Array.isArray(v)) throw new Error("sage-mem: expected array");
				return v;
			},
		};

		// ── 冲突队列（2.0.0 矛盾检测）──
		// 与宿主 manifest 逐字段对齐的 strict 形状。记录字段「只增不改」，但客户端这一份
		// 必须写全 —— strict 校验缺字段会把整条调用当坏结果拒掉（additive 字段要从这里放行）。
		//
		// `invalidatedFile` 不是装饰：invalidate 允许标 `file` 或 `otherFile` 任一方失效，
		// undo 要知道当时标的是哪一方，只能从记录里读（设计稿 §7.3 只写了「撤销失效」，
		// 没写落点；D29 补这个字段）。空串 = 还没裁过。
		const conflictFields = {
			"id": isStr, "at": isStr, "kind": isStr, "status": isStr,
			"file": isStr, "otherFile": isStr, "note": isStr, "decision": isStr,
			"decidedAt": isStr, "appliedVersion": isStr, "invalidatedFile": isStr,
			"truncated": isBool,
		};
		const conflictItemSchema = parseSchema(conflictFields);
		// read 的 record = item 再带两份正文。正文可能为空串、可能被截断（truncated 为 true
		// 时 UI 要显示「已截断」）—— 所以正文只校类型，不校长度。
		const conflictRecordSchema = parseSchema(Object.assign({}, conflictFields, {
			"incoming": isStr, "onDisk": isStr,
		}));
		/**
		 * 冲突方法的失败分支：`{ok:false, code, error?}`。
		 * 契约里失败**不抛**、也不走 ok:true —— 所以每个结果 codec 都要先认这一支，
		 * 否则「stale_version 要给出路」这件事在界面层会被 strict 校验拦成一句泛化错误。
		 */
		function conflictFailure(v) {
			if (v.ok !== false) return false;
			isStr(v.code);
			if ("error" in v) isStr(v.error);
			return true;
		}
		const conflictListSchema = {
			parse(v) {
				if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("sage-mem: invalid conflict list");
				if (conflictFailure(v)) return v;
				isBool(v.ok);
				// items 是列表的主体，成功时必须有；broken / ignored 允许宿主省略（空数组）。
				if (!Array.isArray(v.items)) throw new Error("sage-mem: invalid conflict list");
				v.items.forEach(function (x) { conflictItemSchema.parse(x); });
				if ("broken" in v && !Array.isArray(v.broken)) throw new Error("sage-mem: invalid broken list");
				if ("ignored" in v && !Array.isArray(v.ignored)) throw new Error("sage-mem: invalid ignored list");
				if (v.counts === null || typeof v.counts !== "object") throw new Error("sage-mem: missing counts");
				isNum(v.counts.open);
				isNum(v.counts.total);
				return v;
			},
		};
		const conflictReadSchema = {
			parse(v) {
				if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("sage-mem: invalid conflict record");
				if (conflictFailure(v)) return v;
				isBool(v.ok);
				conflictRecordSchema.parse(v.record);
				// warnings 的元素形状没冻结（宿主 schema 也允许省略空数组），只校「是数组」。
				if ("warnings" in v && !Array.isArray(v.warnings)) throw new Error("sage-mem: invalid warnings");
				return v;
			},
		};
		const conflictInvalidateSchema = {
			parse(v) {
				if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("sage-mem: invalid conflict result");
				if (conflictFailure(v)) return v;
				isBool(v.ok);
				conflictRecordSchema.parse(v.record);
				const w = v.wrote;
				if (w === null || typeof w !== "object") throw new Error("sage-mem: missing wrote");
				isStr(w.file);
				isStr(w.invalidAt);
				// 宿主 manifest 里 version 是 string（写入门返回的版本令牌）。
				isStr(w.version);
				return v;
			},
		};
		const conflictDismissSchema = {
			parse(v) {
				if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("sage-mem: invalid conflict result");
				if (conflictFailure(v)) return v;
				isBool(v.ok);
				conflictRecordSchema.parse(v.record);
				return v;
			},
		};
		const conflictUndoSchema = {
			parse(v) {
				if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("sage-mem: invalid conflict result");
				if (conflictFailure(v)) return v;
				isBool(v.ok);
				conflictRecordSchema.parse(v.record);
				const c = v.cleared;
				if (c === null || typeof c !== "object") throw new Error("sage-mem: missing cleared");
				isStr(c.file);
				return v;
			},
		};
		const conflictRemoveSchema = {
			parse(v) {
				if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("sage-mem: invalid conflict result");
				if (conflictFailure(v)) return v;
				isBool(v.ok);
				return v;
			},
		};
		// 5 个方法都是「一个对象参数」：{id} / {id,file?,note?}。可选字段传了就必须是字符串，
		// 没传就交给宿主按空串处理 —— 不在这里编默认值。
		const conflictOptsSchema = {
			parse(v) {
				if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("sage-mem: expected object");
				isStr(v.id);
				if ("file" in v) isStr(v.file);
				if ("note" in v) isStr(v.note);
				return v;
			},
		};

