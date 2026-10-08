		// ── 手写 strict codec（浏览器无 zod，typert 只要求 parse 方法）──
		function parseSchema(shape) {
			return {
				parse(value) {
					if (value === null || typeof value !== "object") throw new Error("sage-mem: invalid payload");
					for (const [key, check] of Object.entries(shape)) {
						if (!(key in value)) throw new Error("sage-mem: missing field " + key);
						check(value[key]);
					}
					return value;
				},
			};
		}
		const isStr = (v) => { if (typeof v !== "string") throw new Error("expected string"); };
		const isBool = (v) => { if (typeof v !== "boolean") throw new Error("expected boolean"); };
		const isNum = (v) => { if (typeof v !== "number") throw new Error("expected number"); };
		const strSchema = { parse(v) { isStr(v); return v; } };
		const fileSchema = parseSchema({ "file": isStr, "type": isStr, "description": isStr, "size": isNum });
		const listSchema = { parse(v) { if (!Array.isArray(v)) throw new Error("expected array"); v.forEach((f) => fileSchema.parse(f)); return v; } };
		const readSchema = parseSchema({ "name": isStr, "content": isStr });
		const writeSchema = parseSchema({ "ok": isBool, "file": isStr });
		const deleteSchema = parseSchema({ "ok": isBool });
		const starmapStarSchema = parseSchema({ "file": isStr, "kind": isStr, "title": isStr, "desc": isStr, "bytes": isNum, "mtimeMs": isNum });
		const starmapListSchema = { parse(v) { if (!v || typeof v !== "object") throw new Error("expected object"); if (!Array.isArray(v.stars)) throw new Error("expected stars array"); v.stars.forEach((f) => starmapStarSchema.parse(f)); return v; } };
		const starmapReadSchema = parseSchema({ "name": isStr, "content": isStr });

		// ── 归档区（v0.9.0 档案馆）──
		// 客户端只声明 remote 面：面板上的「已归档」区由后续 UI 任务接。
		// 结果 codec 与宿主 manifest 逐字段对齐（ArchiveResult 的 file / error 都可选，
		// 成功回 file、失败回 error，所以这里只硬校 ok）。
		const boolSchema = { parse(v) { isBool(v); return v; } };
		const archiveSchema = parseSchema({ "ok": isBool });
		const archivedFileSchema = parseSchema({
			"file": isStr, "type": isStr, "description": isStr, "size": isNum,
			"archivedAt": isStr, "archivedReason": isStr,
		});
		const archivedListSchema = {
			parse(v) {
				if (!v || typeof v !== "object") throw new Error("sage-mem: expected object");
				if (!Array.isArray(v.files)) throw new Error("sage-mem: expected files array");
				v.files.forEach((f) => archivedFileSchema.parse(f));
				return v;
			},
		};
		// 归档文件的读 / 写（B1b）：形状与活跃记忆那套的 readSchema / writeSchema 对称。
		const archivedReadSchema = parseSchema({ "name": isStr, "content": isStr });
		const archivedWriteSchema = parseSchema({ "ok": isBool, "file": isStr });

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

