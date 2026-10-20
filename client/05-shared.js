		// ── 共享基元（1.4.0）：跨屏复用的小东西只有这一份 ─────────────
		// 这些名字原本在 10 / 20 / 50 三个分片各写一遍（isStr/isNum/strSchema/parseSchema/
		// unwrap/fmtSize/hexA，以及类型词表 3 份）。分片共享同一个 factory 作用域，
		// 所以收敛到本片之后，后面的分片直接用、不再各写一份。
		const isStr = (v) => { if (typeof v !== "string") throw new Error("expected string"); };
		const isBool = (v) => { if (typeof v !== "boolean") throw new Error("expected boolean"); };
		const isNum = (v) => { if (typeof v !== "number") throw new Error("expected number"); };
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
		const strSchema = { parse(v) { isStr(v); return v; } };

		/** 拆 typert remote 的 {ok, value} 信封。 */
		function unwrap(result) {
			return result && result.ok ? result.value : result;
		}

		/** 字节数 → 人话。三个档位对记忆文件足够（单条上限 512 KB）。 */
		function fmtSize(n) {
			if (n < 1024) return n + " B";
			if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
			return (n / 1024 / 1024).toFixed(1) + " MB";
		}

		/** #rrggbb + alpha → rgba()。星图的辉光/底盘用。 */
		function hexA(hex, a) {
			const n = parseInt(hex.slice(1), 16);
			return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a.toFixed(3) + ")";
		}

		// ── 类型词表（唯一定义） ──
		// 文件列表的排序 / 筛选 / 徽章、星图的 kind 标签与配色，全部从这里取。
		const TYPE_ORDER = ["user", "feedback", "project", "reference"];
		const TYPE_SORT = ["user", "feedback", "project", "reference", "special"];
		const TYPE_LABEL = { user: "用户", feedback: "反馈", project: "项目", reference: "参考", special: "特殊" };
		const TYPE_META = {
			user: ["👤", TYPE_LABEL.user],
			feedback: ["📌", TYPE_LABEL.feedback],
			project: ["📁", TYPE_LABEL.project],
			reference: ["🔗", TYPE_LABEL.reference],
		};
		// 星图配色：深色档（夜空）与浅色档（暖纸 + 矿物颜料）各一套，色相错开才分得清类型。
		const TYPE_COLOR_DARK = {
			user: "#e0c07a", feedback: "#7ec8da", project: "#ac9edc", reference: "#92ceaa", special: "#bcc3d0",
		};
		const TYPE_COLOR_LIGHT = {
			user: "#a4652c", feedback: "#3a6f8f", project: "#6a5b8f", reference: "#4a7c63", special: "#5b5750",
		};
