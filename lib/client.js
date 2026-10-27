/**
 * sage-mem — 界面侧：DSH 设置页「记忆管理」界面（文件管理器）。
 *
 * 手写 ModuleLoader bundle（`window.__ModuleLoader__.load({ id, factory })` 格式）：
 * window.__ModuleLoader__.load({ id, factory })，factory 内 require('react')
 * 可用，module.exports 导出标准 Cordis 插件（apply/inject）。
 *
 * 数据通道：TypertRemoteService（宿主侧 MemoryGateway），通过
 * ctx.get("remote.memory") 调用文件列表/读/写/删。remote 返回 {ok, value}
 * 信封。浏览器侧无 zod，schema 手写（codec 只要求 mode==="strict" + parse）。
 *
 * 功能：浏览 memory 目录的 markdown 记忆文件（类型徽章 + 描述预览）、
 * 查看/编辑全文、两步确认删除、添加新记忆（选类型 + 描述 + 正文）。
 */

window.__ModuleLoader__.load({
	id: "sage-mem",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;

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
const StarmapRuntime = (function (require, _react) {
	let react = _react;
	const h = react.createElement;
// ── 手写 strict codec（浏览器无 zod，typert 只要求 parse 方法）──
		// isStr / isNum / strSchema 来自 05-shared.js（这个 IIFE 在 factory 作用域内，看得到）。
		const starSchema = {
			parse(v) {
				if (v === null || typeof v !== "object") throw new Error("invalid star");
				isStr(v.file); isStr(v.kind); isStr(v.title); isStr(v.desc); isNum(v.bytes); isNum(v.mtimeMs);
				return v;
			},
		};
		const listSchema = {
			parse(v) {
				if (v === null || typeof v !== "object") throw new Error("invalid payload");
				isNum(v.count);
				if (!Array.isArray(v.stars)) throw new Error("expected stars array");
				v.stars.forEach((s) => starSchema.parse(s));
				return v;
			},
		};
		const readSchema = {
			parse(v) {
				if (v === null || typeof v !== "object") throw new Error("invalid payload");
				isStr(v.name); isStr(v.content);
				return v;
			},
		};

		const TYPERT_REMOTE = {
			package: "sage-starmap",
			descriptors: [
				{
					id: "sage-starmap#starmap/listStars",
					service: "starmap",
					namespace: "starmap",
					method: "listStars",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-starmap/types#StarList", schema: listSchema, create: () => listSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-starmap#starmap/readFile",
					service: "starmap",
					namespace: "starmap",
					method: "readFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-starmap/types#FileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-starmap/types#FileContent", schema: readSchema, create: () => readSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
			],
		};

		/** 错误详情尽量展开，避免 "[object Object]" 式黑洞。 */
		function detail(e) {
			if (!e) return "未知错误";
			if (e instanceof Error) return (e.message || String(e)) + (e.stack ? " · " + e.stack.slice(0, 180) : "");
			try {
				const s = JSON.stringify(e);
				return s && s !== "{}" ? s.slice(0, 200) : String(e);
			} catch (_) {
				return String(e);
			}
		}

		function preview(v) {
			try {
				const s = JSON.stringify(v);
				return s && s !== "{}" ? s.slice(0, 160) : String(v);
			} catch (_) {
				return String(v);
			}
		}

		// ── 常量与纯函数 ─────────────────────────────────────────────
		//
		// 配色：五个色若取高饱和高亮度（#ffd27d / #6fe3ff / #b18cff / #7dffb0），
		// 配上星芒与脉冲环，整体读起来像贴纸。现在统一降饱和、压亮度 ——
		// 深空画布上够辨认，又不抢眼。
		//
		// 两档取值：`color` = 深色档（夜空画布），`light` = 浅色档（纸本设色）。
		// 类型标签与配色来自 05-shared.js 的唯一定义；这里只是把它们组装成星图用的 meta。
		const KIND_META = {};
		for (const k of TYPE_SORT) KIND_META[k] = { label: TYPE_LABEL[k], color: TYPE_COLOR_DARK[k], light: TYPE_COLOR_LIGHT[k] };

		/**
		 * 宿主主题挂钩 —— 与 ui-theme 同一处：body[data-ds-dark-theme] 存在即深色档。
		 */
		function isDarkTheme() {
			return typeof document !== "undefined" && !!document.body
				&& document.body.hasAttribute("data-ds-dark-theme");
		}

		/** 类型色按当前主题取（meta.color / meta.light）。 */
		function kindColor(meta) {
			const m = meta || KIND_META.special;
			return (isDarkTheme() ? m.color : m.light) || m.color;
		}

		/**
		 * 画布调色板：深色档 = 夜空，浅色档 = 暖纸 + 晕染。
		 * 两套渲染器（WebGL / canvas2d）都从这里取色，别各写一份。
		 * bgGl 是 WebGL shader 用的 0-1 分量（与 bg2d 是同一色，写法不同而已）。
		 */
		function starmapPalette() {
			if (isDarkTheme()) {
				return {
					bg2d: ["#0b1026", "#101731"],
					bgGl: [[0.105, 0.117, 0.145], [0.043, 0.050, 0.065]],
					dust: "#9fb3dd",
					archive: [0.46, 0.50, 0.58],
					vignette: null,
				};
			}
			return {
				bg2d: ["#faf6ed", "#e9e0cd"],
				bgGl: [[0.980, 0.965, 0.929], [0.914, 0.878, 0.804]],
				dust: "#c9bfa6",
				archive: [0.62, 0.60, 0.55],
				vignette: { color: "#7a6a48", a: 0.10 },
			};
		}

		const KIND_ORDER = ["user", "feedback", "project", "reference", "special"];
		const FRESH_MS = 7 * 86400000;

		function hashStr(s) {
			let hh = 2166136261;
			for (let i = 0; i < s.length; i++) {
				hh ^= s.charCodeAt(i);
				hh = Math.imul(hh, 16777619);
			}
			return hh >>> 0;
		}

		function rand01(seed) {
			let t = (seed + 0x6D2B79F5) >>> 0;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		}

		function fmtDate(ms) {
			if (!ms) return "";
			const d = new Date(ms);
			const p = (x) => (x < 10 ? "0" : "") + x;
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
		}

		function fmtRel(ms) {
			if (!ms) return "";
			const d = Date.now() - ms;
			if (d < 60000) return "刚刚";
			if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
			if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
			const days = Math.floor(d / 86400000);
			if (days < 30) return days + " 天前";
			return fmtDate(ms);
		}

		function computeLayout(stars, W, H) {
			const pts = stars.map((s) => {
				const hh = hashStr(s.file);
				return {
					star: s,
					x: 46 + rand01(hh) * (W - 92),
					y: 42 + rand01((hh ^ 0x9e3779b9) >>> 0) * (H - 88),
					r: 2.2 + Math.min(3.2, Math.sqrt(Math.max(s.bytes || 200, 200) / 3500)),
					tw: rand01((hh ^ 0x85ebca6b) >>> 0),
				};
			});
			for (let iter = 0; iter < 80; iter++) {
				for (let i = 0; i < pts.length; i++) {
					for (let j = i + 1; j < pts.length; j++) {
						const a = pts[i];
						const b = pts[j];
						let dx = b.x - a.x;
						let dy = b.y - a.y;
						let d2 = dx * dx + dy * dy;
						const minD = a.r + b.r + 16;
						if (d2 < minD * minD) {
							if (d2 < 0.01) { dx = 0.5; dy = 0.3; d2 = 0.34; }
							const d = Math.sqrt(d2);
							const push = ((minD - d) / d) * 0.35;
							a.x -= dx * push;
							a.y -= dy * push;
							b.x += dx * push;
							b.y += dy * push;
						}
					}
				}
			}
			for (const p of pts) {
				p.x = Math.max(24, Math.min(W - 24, p.x));
				p.y = Math.max(22, Math.min(H - 22, p.y));
			}
			return { W: W, H: H, pts: pts };
		}

		/**
		 * 一颗星此刻画不画：归档开关 → 类型开关 → 搜索词，三层依次收窄。
		 * 归档开关放最前面：关掉「显示档案馆」时，归档星连图例计数都不该占到。
		 */
		function starVisible(p, kindsOn, q, showArchived) {
			if (p.star.archived === true && showArchived === false) return false;
			if (!kindsOn[p.star.kind]) return false;
			if (q) {
				const hay = (p.star.title + " " + p.star.desc + " " + p.star.file).toLowerCase();
				if (hay.indexOf(q) < 0) return false;
			}
			return true;
		}

		/** 可见性标记 + 同类最近邻星座连线。 */
		function buildVisibility(lay, kindsOn, q, showArchived) {
			const flags = [];
			for (let i = 0; i < lay.pts.length; i++) flags.push(starVisible(lay.pts[i], kindsOn, q, showArchived));
			const byKind = {};
			for (let i = 0; i < lay.pts.length; i++) {
				if (!flags[i]) continue;
				const k = lay.pts[i].star.kind;
				if (!byKind[k]) byKind[k] = [];
				byKind[k].push(i);
			}
			const lines = [];
			for (const k in byKind) {
				const remaining = byKind[k].slice();
				if (remaining.length < 2) continue;
				let cur = remaining.shift();
				let guard = 0;
				while (remaining.length > 0 && guard < 300) {
					guard++;
					let bi = 0;
					let bd = Infinity;
					for (let r = 0; r < remaining.length; r++) {
						const dx = lay.pts[remaining[r]].x - lay.pts[cur].x;
						const dy = lay.pts[remaining[r]].y - lay.pts[cur].y;
						const d = dx * dx + dy * dy;
						if (d < bd) { bd = d; bi = r; }
					}
					const nxt = remaining.splice(bi, 1)[0];
					lines.push([cur, nxt, k]);
					cur = nxt;
				}
			}
			return { flags: flags, lines: lines };
		}

		// ── 轻量 Markdown → React（标题/粗体/行内码/[[链接]]/引用/列表/围栏/分隔线）──
		function parseInline(text, kb) {
			const els = [];
			const re = /(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\])/g;
			let last = 0;
			let m;
			let i = 0;
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) els.push(text.slice(last, m.index));
				const tok = m[0];
				if (tok.charCodeAt(1) === 42) els.push(h("strong", { key: kb + "b" + i }, tok.slice(2, -2)));
				else if (tok.charCodeAt(0) === 96) els.push(h("code", { key: kb + "c" + i, className: "smap-md-code" }, tok.slice(1, -1)));
				else els.push(h("span", { key: kb + "w" + i, className: "smap-md-wiki" }, tok.slice(2, -2)));
				last = m.index + tok.length;
				i++;
			}
			if (last < text.length) els.push(text.slice(last));
			return els;
		}

		function renderMarkdown(text) {
			const lines = text.split(/\r?\n/);
			const blocks = [];
			let para = [];
			let list = null;
			let code = null;
			let key = 0;
			function flushPara() {
				if (para.length) {
					blocks.push(h("p", { key: "p" + key, className: "smap-md-p" }, parseInline(para.join(" "), "p" + key)));
					para = [];
					key++;
				}
			}
			function flushList() {
				if (list && list.items.length) {
					blocks.push(h(list.ordered ? "ol" : "ul", { key: "l" + key, className: "smap-md-list" },
						list.items.map((it, ix) => h("li", { key: ix }, parseInline(it, "l" + key + "i" + ix)))));
					key++;
				}
				list = null;
			}
			for (const raw of lines) {
				const line = raw.replace(/\s+$/, "");
				if (code !== null) {
					if (/^```/.test(line)) {
						blocks.push(h("pre", { key: "pre" + key, className: "smap-md-pre" }, code.join("\n")));
						code = null;
						key++;
					} else code.push(raw);
					continue;
				}
				if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
				const hh = line.match(/^(#{1,4})\s+(.*)$/);
				if (hh) {
					flushPara(); flushList();
					blocks.push(h("div", { key: "h" + key, className: "smap-md-h smap-md-h" + hh[1].length }, parseInline(hh[2], "h" + key)));
					key++;
					continue;
				}
				if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
					flushPara(); flushList();
					blocks.push(h("hr", { key: "hr" + key, className: "smap-md-hr" }));
					key++;
					continue;
				}
				const q = line.match(/^>\s?(.*)$/);
				if (q) {
					flushPara(); flushList();
					blocks.push(h("blockquote", { key: "q" + key, className: "smap-md-quote" }, parseInline(q[1], "q" + key)));
					key++;
					continue;
				}
				const ul = line.match(/^[-*]\s+(.*)$/);
				const ol = line.match(/^\d+[.)]\s+(.*)$/);
				if (ul || ol) {
					flushPara();
					const ordered = !ul;
					const itemText = ul ? ul[1] : ol[1];
					if (!list || list.ordered !== ordered) { flushList(); list = { ordered: ordered, items: [] }; }
					list.items.push(itemText);
					continue;
				}
				if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
				para.push(line);
			}
			if (code !== null) {
				blocks.push(h("pre", { key: "pre" + key, className: "smap-md-pre" }, code.join("\n")));
				key++;
			}
			flushPara();
			flushList();
			return blocks;
		}

		/** client context 由 apply 存入；Slot 组件经 props 或此兜底获取。 */
		let appCtx = null;
		// ── 样式（data-plugin-css 约定，幂等注入）──
		const CSS = [
			".smap-card{background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:12px 14px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;flex:1;min-height:0;}",
			".smap-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;}",
			".smap-spacer{flex:1;}",
			".smap-search{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-primary);font-size:12px;padding:4px 9px;outline:none;width:160px;font-family:inherit;}",
			".smap-search:focus{border-color:var(--dsw-alias-border-l2);}",
			".smap-search::placeholder{color:var(--dsw-alias-label-tertiary);}",
			".smap-btn{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-primary);font-size:12px;padding:4px 10px;cursor:pointer;font-family:inherit;}",
			".smap-btn:hover{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));}",
			".smap-btn.on{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);}",
			".smap-ar-toggle[aria-pressed=\"false\"]{opacity:.60;}",
			".smap-btn:disabled{opacity:.5;cursor:default;}",
			".smap-btn-primary{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));}",
			".smap-wrap{position:relative;flex:1;min-height:0;}",
			".smap-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;border-radius:10px;cursor:crosshair;}",
			".smap-tip{position:absolute;z-index:5;pointer-events:none;max-width:280px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.55;box-shadow:0 6px 24px rgba(0,0,0,.45);}",
			".smap-tip-title{font-weight:600;margin-bottom:2px;}",
			".smap-tip-kind{color:var(--dsw-alias-label-secondary);font-size:11px;margin-bottom:2px;}",
			".smap-tip-desc{color:var(--dsw-alias-label-secondary);}",
			".smap-panel{position:absolute;top:10px;right:10px;bottom:10px;width:min(400px,54%);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;overflow-y:auto;z-index:6;font-size:13px;line-height:1.7;box-shadow:-8px 0 30px rgba(0,0,0,.35);}",
			".smap-panel-head{display:flex;align-items:flex-start;gap:8px;margin-bottom:4px;}",
			".smap-panel-title{font-weight:600;font-size:14px;flex:1;}",
			".smap-panel-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:8px;}",
			".smap-panel-arch{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);}",
			".smap-meta-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:-1px;}",
			".smap-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;font-size:12px;align-items:center;}",
			".smap-lg-item{cursor:pointer;user-select:none;}",
			".smap-lg-item.off{opacity:.32;}",
			".smap-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:-1px;}",
			".smap-count{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;}",
			".smap-status{padding:28px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;}",
			".smap-empty{position:absolute;left:0;right:0;top:46%;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;pointer-events:none;z-index:4;}",
			".smap-replay-on{border-color:var(--dsw-alias-brand-primary)!important;color:var(--dsw-alias-brand-primary)!important;}",
			".smap-replay-date{font-size:11px;color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums;}",
			".smap-md-h{font-weight:600;margin:12px 0 4px;}",
			".smap-md-h1{font-size:16px;}",
			".smap-md-h2{font-size:14.5px;}",
			".smap-md-h3,.smap-md-h4{font-size:13.5px;opacity:.92;}",
			".smap-md-p{margin:4px 0;}",
			".smap-md-list{margin:4px 0;padding-left:20px;}",
			".smap-md-code{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));padding:1px 5px;border-radius:4px;font-size:12px;}",
			".smap-md-pre{background:var(--dsw-alias-bg-layer-2);padding:8px 10px;border-radius:8px;font-size:12px;overflow-x:auto;white-space:pre-wrap;margin:6px 0;}",
			".smap-md-quote{border-left:3px solid var(--dsw-alias-border-l2);margin:6px 0;padding:2px 10px;color:var(--dsw-alias-label-secondary);}",
			".smap-md-wiki{color:var(--dsw-alias-brand-primary);}",
			".smap-md-hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:10px 0;}",
			".smap-viewtoggle{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;}",
			".smap-vt-btn{background:transparent;border:none;color:var(--dsw-alias-label-secondary);font-size:12px;padding:4px 10px;cursor:pointer;font-family:inherit;}",
			".smap-vt-btn.on{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);}",
			".smap-timeline{position:absolute;inset:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:4px 6px 4px 2px;}",
			".smap-tl-item{display:flex;align-items:baseline;gap:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;cursor:pointer;flex:none;}",
			".smap-tl-item:hover{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-border-l1);}",
			".smap-tl-item--arch{opacity:.75;}",
			".smap-ar-badge{font-size:10.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 5px;flex:none;align-self:center;}",
			".smap-tl-date{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none;}",
			".smap-tl-title{font-size:13px;font-weight:600;flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".smap-tl-desc{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}",
		].join("\n");

		function injectCss() {
			const tagId = "sage-starmap/overlay.css";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "sage-starmap";
				tag.dataset.pluginCss = tagId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
		}

		// ── 渲染层 v0.4:WebGL 星野(程序化银河 + 衍射星芒 + additive 发光),canvas2d 兜底 ──
		function hexToRgb(hex) {
			const n = parseInt(hex.slice(1), 16);
			return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
		}

		// 归档星（暗星）的用色：把类型色往石板灰上压 —— 它得「还在图上、一眼数得出来」，
		// 又要一眼看出不是活记忆。亮度靠 shader 那一档（0.52），这里负责色相：
		// 深色档是冷石板灰；浅色档换成暖灰，否则灰点落在纸上看不见。
		function dimRgb(hex) {
			const c = hexToRgb(hex);
			const g = starmapPalette().archive;
			return [
				c[0] * 0.26 + g[0] * 0.74,
				c[1] * 0.26 + g[1] * 0.74,
				c[2] * 0.26 + g[2] * 0.74,
			];
		}
		function dimCss(hex) {
			const c = dimRgb(hex);
			return "rgb(" + Math.round(c[0] * 255) + "," + Math.round(c[1] * 255) + "," + Math.round(c[2] * 255) + ")";
		}

		const SMAP_BG_VS = "attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }";
		// 底色（重做过一版）。旧版是四层 fbm 噪声算出来的蓝紫星云，还带 uTime 动画 ——
		// 「会呼吸的彩色底」正是廉价感的一大来源，而且每帧都要重算噪声。
		// 现在只剩一条静态径向渐变：中心略亮的中性深灰，边缘更暗。uTime 保留声明
		// 只为让 uniform 列表不变（用不到时 getUniformLocation 返回 null，调用是安全空操作）。
		// 底色由调色板给（深色档=夜空深灰，浅色档=暖纸），所以是函数不是常量。
		function smapBgFs(inner, outer) {
			const v = (c) => c.map((x) => x.toFixed(3)).join(", ");
			return [
				"precision highp float;",
				"uniform vec2 uRes;",
				"uniform float uTime;",
				"void main(){",
				"  vec2 suv = gl_FragCoord.xy / uRes;",
				"  float r = length((suv - vec2(0.5, 0.44)) * vec2(1.0, 1.28));",
				"  vec3 col = mix(vec3(" + v(inner) + "), vec3(" + v(outer) + "), clamp(r * 1.30, 0.0, 1.0));",
				"  gl_FragColor = vec4(col, 1.0);",
				"}",
			].join("\n");
		}

		const SMAP_STAR_VS = [
			"attribute vec2 aCorner;",
			"attribute vec3 aMeta0;",
			"attribute vec4 aColor;",
			"attribute vec3 aMeta1;",
			"attribute float aBirth;",
			"uniform vec2 uRes;",
			"varying vec2 vLocal;",
			"varying vec4 vColor;",
			"varying vec3 vMeta1;",
			"varying float vBirth;",
			"void main(){",
			"  vLocal = aCorner; vColor = aColor; vMeta1 = aMeta1; vBirth = aBirth;",
			"  vec2 world = aMeta0.xy + aCorner * aMeta0.z;",
			"  vec2 clip = vec2(world.x / uRes.x * 2.0 - 1.0, 1.0 - world.y / uRes.y * 2.0);",
			"  gl_Position = vec4(clip, 0.0, 1.0);",
			"}",
		].join("\n");

		// 星点（重做过一版）。去掉了三样东西，它们是「塑料感」的来源：
		//   1. 衍射星芒（横竖两条十字 spike）—— 用户明确要求去掉
		//   2. 脉冲扩散环（fract(uTime*0.3) 画出来的同心圆）—— 看起来像贴纸上的亮环
		//   3. 呼吸闪烁（sin(uTime) 调制整体透明度）—— 满屏一起闪，廉价
		// 留下的是「锐利实心核心 + 收敛辉光」，亮度按 vMeta1.y（是否新鲜）分档。
		const SMAP_STAR_FS = [
			"precision mediump float;",
			"varying vec2 vLocal;",
			"varying vec4 vColor;",
			"varying vec3 vMeta1;",
			"varying float vBirth;",
			"uniform float uTime;",
			"uniform float uHoverIdx;",
			"uniform float uRevealT;",
			"float revealFactor(){",
			"  if (vBirth < 0.0) return 1.0;",
			"  float t = clamp((uRevealT - vBirth) / 900.0, 0.0, 1.0);",
			"  return t * t * (3.0 - 2.0 * t);",
			"}",
			"void main(){",
			"  float d = length(vLocal);",
			"  float alpha = 0.0;",
			"  if (vMeta1.z < -0.5){",
			"    alpha = smoothstep(0.55, 0.0, d) * vColor.a;",
			"  } else {",
			"    // 归档星（vMeta1.y = -1）单独一档 0.52：核心小而暗；外圈的存在感由另画的一层",
			"    // 淡底盘负责（见 uploadStars），所以这里不用改辉光形状。",
			"    float aFresh = vMeta1.y < -0.5 ? 0.52 : mix(0.60, 1.0, vMeta1.y);",
			"    float hov = abs(vMeta1.z - uHoverIdx) < 0.5 ? 1.0 : 0.0;",
			"    if (hov > 0.5 && vMeta1.y < -0.5) aFresh = 1.0;", // 悬停把暗星临时点亮
			"    float core = smoothstep(0.30, 0.04, d);",
			"    float glow = exp(-d * 3.8) * 0.30;",
			"    alpha = (core + glow) * aFresh;",
			"    if (hov > 0.5){",
			"      alpha += smoothstep(0.10, 0.0, abs(d - 0.62)) * 0.55;",
			"    }",
			"    alpha = clamp(alpha, 0.0, 1.0);",
			"  }",
			"  alpha *= revealFactor();",
			"  gl_FragColor = vec4(vColor.rgb, alpha);",
			"}",
		].join("\n");

		const SMAP_LINE_VS = [
			"attribute vec2 aPos;",
			"attribute vec4 aColor;",
			"attribute float aBirth;",
			"uniform vec2 uRes;",
			"varying vec4 vColor;",
			"varying float vBirth;",
			"void main(){",
			"  vColor = aColor; vBirth = aBirth;",
			"  vec2 clip = vec2(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0);",
			"  gl_Position = vec4(clip, 0.0, 1.0);",
			"}",
		].join("\n");
		const SMAP_LINE_FS = [
			"precision mediump float;",
			"varying vec4 vColor;",
			"varying float vBirth;",
			"uniform float uRevealT;",
			"void main(){",
			"  if (vBirth < 0.0){ gl_FragColor = vColor; return; }",
			"  float t = clamp((uRevealT - vBirth) / 900.0, 0.0, 1.0);",
			"  t = t * t * (3.0 - 2.0 * t);",
			"  gl_FragColor = vec4(vColor.rgb, vColor.a * t);",
			"}",
		].join("\n");

		function glShader(gl, type, src) {
			const sh = gl.createShader(type);
			gl.shaderSource(sh, src);
			gl.compileShader(sh);
			if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("shader compile: " + gl.getShaderInfoLog(sh));
			return sh;
		}

		function glProgram(gl, vsSrc, fsSrc, attribNames, uniformNames) {
			const p = gl.createProgram();
			gl.attachShader(p, glShader(gl, gl.VERTEX_SHADER, vsSrc));
			gl.attachShader(p, glShader(gl, gl.FRAGMENT_SHADER, fsSrc));
			gl.linkProgram(p);
			if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("program link: " + gl.getProgramInfoLog(p));
			const out = { prog: p, attr: {}, uni: {} };
			for (const n of attribNames) out.attr[n] = gl.getAttribLocation(p, n);
			for (const n of uniformNames) out.uni[n] = gl.getUniformLocation(p, n);
			return out;
		}

		const SMAP_CORNERS = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1];
		const SMAP_ATTR_SIZE = { aCorner: 2, aMeta0: 3, aColor: 4, aMeta1: 3, aBirth: 1 };

		function pushStarQuad(arr, cx, cy, r, rgb, aBase, twPhase, fresh, idx, birth) {
			for (let v = 0; v < 6; v++) {
				arr.push(SMAP_CORNERS[v * 2], SMAP_CORNERS[v * 2 + 1]);
				arr.push(cx, cy, r);
				arr.push(rgb[0], rgb[1], rgb[2], aBase);
				arr.push(twPhase, fresh, idx);
				arr.push(birth);
			}
		}

		function bindQuadAttrs(gl, po, buf, floatsPerVtx) {
			gl.bindBuffer(gl.ARRAY_BUFFER, buf);
			let off = 0;
			for (const n of ["aCorner", "aMeta0", "aColor", "aMeta1", "aBirth"]) {
				const size = SMAP_ATTR_SIZE[n];
				const loc = po.attr[n];
				if (loc >= 0) {
					gl.enableVertexAttribArray(loc);
					gl.vertexAttribPointer(loc, size, gl.FLOAT, false, floatsPerVtx * 4, off * 4);
				}
				off += size;
			}
		}

		function makeWebGLRenderer(canvasEl, layout, visBox, hoverBox) {
			let gl = null;
			try {
				gl = canvasEl.getContext("webgl", { antialias: true, alpha: false, premultipliedAlpha: true });
			} catch (_) { gl = null; }
			if (!gl) return null;
			const W = layout.W;
			const H = layout.H;
			try {
				canvasEl.width = W * 2;
				canvasEl.height = H * 2;
				gl.viewport(0, 0, canvasEl.width, canvasEl.height);
				const pal = starmapPalette();
				const progBg = glProgram(gl, SMAP_BG_VS, smapBgFs(pal.bgGl[0], pal.bgGl[1]), ["aPos"], ["uRes", "uTime"]);
				const progStar = glProgram(gl, SMAP_STAR_VS, SMAP_STAR_FS, ["aCorner", "aMeta0", "aColor", "aMeta1", "aBirth"], ["uRes", "uTime", "uHoverIdx", "uRevealT"]);
				const progLine = glProgram(gl, SMAP_LINE_VS, SMAP_LINE_FS, ["aPos", "aColor", "aBirth"], ["uRes", "uRevealT"]);

				// 背景全屏两三角(clip space 直给)
				const bgQuadBuf = gl.createBuffer();
				gl.bindBuffer(gl.ARRAY_BUFFER, bgQuadBuf);
				gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);

				// 远景尘星:一次烘焙
				const dustBuf = gl.createBuffer();
				let dustCount = 0;
				{
					const arr = [];
					for (let i = 0; i < 240; i++) {
						const x = rand01(i * 97 + 13) * W;
						const y = rand01(i * 31 + 7) * H;
						const r = 2.4 + rand01(i * 17 + 5) * 2.0;
						pushStarQuad(arr, x, y, r, hexToRgb(pal.dust), 0.10 + 0.30 * rand01(i * 7 + 3), rand01(i * 11 + 29), 0, -1, -1);
					}
					gl.bindBuffer(gl.ARRAY_BUFFER, dustBuf);
					gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
					dustCount = arr.length / 13;
				}

				const starBuf = gl.createBuffer();
				let starCount = 0;
				const lineBuf = gl.createBuffer();
				let lineCount = 0;
				// 脏标记：canvas 晚于 visibility effect 挂载时（JSX 分支决定 ref 时序），
				// setGeometry 可能从未被调过——render 前自动补传，顺序无关。
				let geoDirty = true;

				function uploadStars() {
					const arr = [];
					const nowMs = Date.now();
					for (let i = 0; i < layout.pts.length; i++) {
						if (!visBox.flags[i]) continue;
						const p = layout.pts[i];
						const meta = KIND_META[p.star.kind] || KIND_META.special;
						const arch = p.star.archived === true;
						const fresh = p.star.mtimeMs > 0 && nowMs - p.star.mtimeMs < FRESH_MS ? 1 : 0;
						const birth = p.star.mtimeMs > 0 ? p.star.mtimeMs : 0;
						if (arch) {
							// 归档星 = 暗星，两层画：
							//   ① 一层很淡的冷色底盘（走 dust 分支：不带星芒、不参与 hover），
							//      负责「深空底上一眼数得出来」——只画一个小点是数不出来的；
							//   ② 一颗小核心（走普通分支，fresh 传 -1 = 归档档 0.52），负责
							//      「看得出是颗星」，并且 hover 时整颗点亮 + 出环。
							pushStarQuad(arr, p.x, p.y, p.r * 6.0, dimRgb(kindColor(meta)), 0.26, p.tw, 0, -1, birth);
							pushStarQuad(arr, p.x, p.y, p.r * 4.4, dimRgb(kindColor(meta)), 1, p.tw, -1, i, birth);
						} else {
							pushStarQuad(arr, p.x, p.y, p.r * 5.4, hexToRgb(kindColor(meta)), 1, p.tw, fresh, i, birth);
						}
					}
					gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
					gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.DYNAMIC_DRAW);
					starCount = arr.length / 13;
				}

				let hoverLineIdx = -1;
				function uploadLines() {
					const arr = [];
					for (let li = 0; li < visBox.lines.length; li++) {
						const ln = visBox.lines[li];
						const a = layout.pts[ln[0]];
						const b = layout.pts[ln[1]];
						const c = hexToRgb(kindColor(KIND_META[ln[2]] || KIND_META.special));
						const hot = hoverLineIdx >= 0 && (ln[0] === hoverLineIdx || ln[1] === hoverLineIdx);
						const mul = hot ? 1 : 0.72;
						const al = hot ? 0.6 : 0.22;
						const birth = Math.max(a.star.mtimeMs || 0, b.star.mtimeMs || 0);
						arr.push(a.x, a.y, c[0] * mul, c[1] * mul, c[2] * mul, al, birth);
						arr.push(b.x, b.y, c[0] * mul, c[1] * mul, c[2] * mul, al, birth);
					}
					gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
					gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.DYNAMIC_DRAW);
					lineCount = arr.length / 7;
				}

				function drawQuad(po, buf, count) {
					bindQuadAttrs(gl, po, buf, 13);
					gl.drawArrays(gl.TRIANGLES, 0, count);
				}

				let revealT = null; // null = 全亮；数字 = 诞生回放的当前时刻
				function render(phase) {
					if (geoDirty) { uploadStars(); uploadLines(); geoDirty = false; }
					const rt = revealT === null ? 8.7e15 : revealT;
					gl.viewport(0, 0, canvasEl.width, canvasEl.height);
					// 背景:不透明
					gl.disable(gl.BLEND);
					gl.useProgram(progBg.prog);
					gl.uniform2f(progBg.uni.uRes, W, H);
					gl.uniform1f(progBg.uni.uTime, phase);
					gl.bindBuffer(gl.ARRAY_BUFFER, bgQuadBuf);
					gl.enableVertexAttribArray(progBg.attr.aPos);
					gl.vertexAttribPointer(progBg.attr.aPos, 2, gl.FLOAT, false, 0, 0);
					gl.drawArrays(gl.TRIANGLES, 0, 6);
					// additive:星座线 → 尘星 → 记忆星
					gl.enable(gl.BLEND);
					gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
					if (lineCount > 0) {
						gl.useProgram(progLine.prog);
						gl.uniform2f(progLine.uni.uRes, W, H);
						gl.uniform1f(progLine.uni.uRevealT, rt);
						gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
						if (progLine.attr.aPos >= 0) { gl.enableVertexAttribArray(progLine.attr.aPos); gl.vertexAttribPointer(progLine.attr.aPos, 2, gl.FLOAT, false, 28, 0); }
						if (progLine.attr.aColor >= 0) { gl.enableVertexAttribArray(progLine.attr.aColor); gl.vertexAttribPointer(progLine.attr.aColor, 4, gl.FLOAT, false, 28, 8); }
						if (progLine.attr.aBirth >= 0) { gl.enableVertexAttribArray(progLine.attr.aBirth); gl.vertexAttribPointer(progLine.attr.aBirth, 1, gl.FLOAT, false, 28, 24); }
						gl.drawArrays(gl.LINES, 0, lineCount);
					}
					gl.useProgram(progStar.prog);
					gl.uniform2f(progStar.uni.uRes, W, H);
					gl.uniform1f(progStar.uni.uTime, phase);
					gl.uniform1f(progStar.uni.uHoverIdx, hoverBox.idx);
					gl.uniform1f(progStar.uni.uRevealT, rt);
					drawQuad(progStar, dustBuf, dustCount);
					if (starCount > 0) drawQuad(progStar, starBuf, starCount);
				}

				return {
					render: render,
					setGeometry: function () { geoDirty = true; },
					setReveal: function (ms) { revealT = typeof ms === "number" ? ms : null; },
					setHighlight: function (idx) {
						const v = typeof idx === "number" ? idx : -1;
						if (v === hoverLineIdx) return;
						hoverLineIdx = v;
						uploadLines();
					},
					destroy: function () {
						try {
							for (const b of [bgQuadBuf, dustBuf, starBuf, lineBuf]) gl.deleteBuffer(b);
							for (const p of [progBg, progStar, progLine]) gl.deleteProgram(p.prog);
						} catch (_) { /* 销毁失败可忽略 */ }
					},
				};
			} catch (e) {
				console.error("sage-starmap: webgl init failed, fallback to 2d", e);
				try {
					const lose = gl.getExtension("WEBGL_lose_context");
					if (lose) lose.loseContext();
				} catch (_) { /* ignore */ }
				return null;
			}
		}

		function makeCanvas2DRenderer(canvasEl, layout, visBox, hoverBox) {
			const W = layout.W;
			const H = layout.H;
			const SCALE = 2;
			canvasEl.width = W * SCALE;
			canvasEl.height = H * SCALE;
			const nowMs = Date.now();
			function render(phase) {
				const c2d = canvasEl.getContext("2d");
				if (!c2d) return;
				c2d.setTransform(SCALE, 0, 0, SCALE, 0, 0);
				const pal = starmapPalette();
				const bg = c2d.createLinearGradient(0, 0, 0, H);
				bg.addColorStop(0, pal.bg2d[0]);
				bg.addColorStop(1, pal.bg2d[1]);
				c2d.fillStyle = bg;
				c2d.fillRect(0, 0, W, H);
				// 晕染：中心透、边缘略深（浅色档才要，深色档的夜空渐变已经够了）
				if (pal.vignette) {
					const vg = c2d.createRadialGradient(W * 0.5, H * 0.46, 0, W * 0.5, H * 0.46, Math.max(W, H) * 0.72);
					vg.addColorStop(0, hexA(pal.vignette.color, 0));
					vg.addColorStop(1, hexA(pal.vignette.color, pal.vignette.a));
					c2d.fillStyle = vg;
					c2d.fillRect(0, 0, W, H);
				}
				for (let i = 0; i < 150; i++) {
					const x = rand01(i * 97 + 13) * W;
					const y = rand01(i * 31 + 7) * H;
					c2d.globalAlpha = 0.08 + 0.22 * rand01(i * 7 + 3);
					c2d.fillStyle = pal.dust;
					c2d.fillRect(x, y, 1, 1);
				}
				c2d.globalAlpha = 1;
				const rt = state.revealT;
				for (const ln of visBox.lines) {
					const a = layout.pts[ln[0]];
					const b = layout.pts[ln[1]];
					const meta = KIND_META[ln[2]] || KIND_META.special;
					const hot = state.hl >= 0 && (ln[0] === state.hl || ln[1] === state.hl);
					const birth = Math.max(a.star.mtimeMs || 0, b.star.mtimeMs || 0);
					let lrv = 1;
					if (rt !== null) {
						const lt = Math.max(0, Math.min(1, (rt - birth) / 900));
						lrv = lt * lt * (3 - 2 * lt);
						if (lrv <= 0) continue;
					}
					c2d.strokeStyle = hexA(kindColor(meta), (hot ? 0.6 : 0.22) * lrv);
					c2d.lineWidth = 1;
					c2d.beginPath();
					c2d.moveTo(a.x, a.y);
					c2d.lineTo(b.x, b.y);
					c2d.stroke();
				}
				for (let i = 0; i < layout.pts.length; i++) {
					if (!visBox.flags[i]) continue;
					const p = layout.pts[i];
					const meta = KIND_META[p.star.kind] || KIND_META.special;
					let rv = 1;
					if (rt !== null && p.star.mtimeMs > 0) {
						const st = Math.max(0, Math.min(1, (rt - p.star.mtimeMs) / 900));
						rv = st * st * (3 - 2 * st);
						if (rv <= 0) continue;
					}
					const tw = 0.72 + 0.28 * Math.sin(phase * 2.1 + p.tw * Math.PI * 2);
					if (p.star.archived === true) {
						// 暗星（canvas2d 兜底路径）：与 webgl 同一档 —— 核心小而暗、外面一圈很淡的冷辉光。
						// 有辉光才「数得出来」；hover 时整颗点亮 + 描边环，这是它能被发现的关键。
						const hot = hoverBox.idx === i;
						const dc = dimRgb(kindColor(meta));
						const rgba = (a) => "rgba(" + Math.round(dc[0] * 255) + "," + Math.round(dc[1] * 255) + "," + Math.round(dc[2] * 255) + "," + a.toFixed(3) + ")";
						const haloR = p.r * 3.4;
						const hg = c2d.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloR);
						hg.addColorStop(0, rgba((hot ? 0.50 : 0.26) * rv));
						hg.addColorStop(1, rgba(0));
						c2d.fillStyle = hg;
						c2d.beginPath();
						c2d.arc(p.x, p.y, haloR, 0, Math.PI * 2);
						c2d.fill();
						c2d.globalAlpha = (hot ? 0.95 : 0.52) * rv;
						c2d.fillStyle = dimCss(kindColor(meta));
						c2d.beginPath();
						c2d.arc(p.x, p.y, Math.max(1.2, p.r * 0.7), 0, Math.PI * 2);
						c2d.fill();
						c2d.globalAlpha = 1;
						if (hot) {
							c2d.strokeStyle = dimCss(kindColor(meta));
							c2d.lineWidth = 1;
							c2d.beginPath();
							c2d.arc(p.x, p.y, p.r + 5, 0, Math.PI * 2);
							c2d.stroke();
						}
						continue;
					}
					if (p.star.mtimeMs > 0 && nowMs - p.star.mtimeMs < FRESH_MS) {
						const pr = p.r + 5 + 3 * (0.5 + 0.5 * Math.sin(phase * 1.4 + p.tw * 6.28));
						c2d.strokeStyle = hexA(kindColor(meta), 0.4 * rv);
						c2d.lineWidth = 1;
						c2d.beginPath();
						c2d.arc(p.x, p.y, pr, 0, Math.PI * 2);
						c2d.stroke();
					}
					const glowR = p.r * 4.2;
					const g = c2d.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
					g.addColorStop(0, hexA(kindColor(meta), 0.5 * tw * rv));
					g.addColorStop(1, hexA(kindColor(meta), 0));
					c2d.fillStyle = g;
					c2d.beginPath();
					c2d.arc(p.x, p.y, glowR, 0, Math.PI * 2);
					c2d.fill();
					c2d.globalAlpha = (0.62 + 0.38 * tw) * rv;
					c2d.fillStyle = kindColor(meta);
					c2d.beginPath();
					c2d.arc(p.x, p.y, p.r, 0, Math.PI * 2);
					c2d.fill();
					c2d.globalAlpha = 1;
					if (hoverBox.idx === i) {
						c2d.strokeStyle = hexA(kindColor(meta), 0.9 * rv);
						c2d.lineWidth = 1;
						c2d.beginPath();
						c2d.arc(p.x, p.y, p.r + 5, 0, Math.PI * 2);
						c2d.stroke();
					}
				}
			}
			const state = { revealT: null, hl: -1 };
			return {
				render: render,
				setGeometry: null,
				setReveal: function (ms) { state.revealT = typeof ms === "number" ? ms : null; },
				setHighlight: function (idx) { state.hl = typeof idx === "number" ? idx : -1; },
				destroy: null,
			};
		}

		function createRenderer(canvasEl, layout, visBox, hoverBox) {
			const wgl = makeWebGLRenderer(canvasEl, layout, visBox, hoverBox);
			if (wgl) return wgl;
			return makeCanvas2DRenderer(canvasEl, layout, visBox, hoverBox);
		}

		// ── 星图主体（canvas + 图例 + 详情面板）──
		function StarMap(props) {
			const ctx = props.ctx || appCtx;
			const onClose = props.onClose;
			const dataS = react.useState(null);
			const data = dataS[0];
			const setData = dataS[1];
			const errS = react.useState("");
			const err = errS[0];
			const setErr = errS[1];
			const canvasS = react.useState(null);
			const canvasEl = canvasS[0];
			const setCanvasEl = canvasS[1];
			const layoutS = react.useState(null);
			const layout = layoutS[0];
			const setLayout = layoutS[1];
			const hoverS = react.useState(null);
			const hover = hoverS[0];
			const setHover = hoverS[1];
			const selS = react.useState(null);
			const selected = selS[0];
			const setSelected = selS[1];
			const kindsS = react.useState(null);
			const kindsOn = kindsS[0];
			const setKindsOn = kindsS[1];
			const queryS = react.useState("");
			const query = queryS[0];
			const setQuery = queryS[1];
			const busyS = react.useState(false);
			const busy = busyS[0];
			const setBusy = busyS[1];
			const viewS = react.useState("sky");
			const viewMode = viewS[0];
			const setViewMode = viewS[1];
			const emptySkyS = react.useState(false);
			const emptySky = emptySkyS[0];
			const setEmptySky = emptySkyS[1];
			const replayingS = react.useState(false);
			const replaying = replayingS[0];
			const setReplaying = replayingS[1];
			const replayDateS = react.useState(null);
			const replayDate = replayDateS[0];
			const setReplayDate = replayDateS[1];
			// 档案馆开关：默认**开** —— 关着的默认值等于用户不知道图上有归档星。
			// 关掉只改本地可见性，不重新取数（数据一次拿全，过滤在客户端做）。
			const showArchS = react.useState(true);
			const showArchive = showArchS[0];
			const setShowArchive = showArchS[1];
			const restoringS = react.useState(null);
			const restoring = restoringS[0];
			const setRestoring = restoringS[1];

			const hoverBox = react.useRef({ idx: -1 }).current;
			const visBox = react.useRef({ flags: [], lines: [] }).current;
			const drawBox = react.useRef({ renderer: null, t0: 0, markDirty: null }).current;
			const replayBox = react.useRef({ raf: 0, active: false }).current;

			// 宿主主题：切主题要把画布重建一遍（底色/星点色都变了），所以它是个 state，
			// 并进渲染 effect 的依赖。挂 observer 而不是每次 render 读属性 —— 属性变了要主动重画。
			const themeKeyS = react.useState(isDarkTheme() ? "dark" : "light");
			const themeKey = themeKeyS[0];
			const setThemeKey = themeKeyS[1];
			react.useEffect(() => {
				if (typeof document === "undefined" || !document.body) return undefined;
				const sync = () => setThemeKey(isDarkTheme() ? "dark" : "light");
				sync();
				const mo = new MutationObserver(sync);
				mo.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
				return () => mo.disconnect();
			}, []);

			// Esc 分层：详情面板开着时先关面板（capture 阶段拦截），再按才落到 overlay 关星空。
			react.useEffect(() => {
				if (!selected) return undefined;
				const onKey = (e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						setSelected(null);
					}
				};
				document.addEventListener("keydown", onKey, true);
				return () => document.removeEventListener("keydown", onKey, true);
			}, [selected]);

			react.useEffect(() => {
				let alive = true;
				setBusy(true);
				const remote = ctx.get("remote.starmap");
				if (!remote) { setErr("remote.starmap 不可用（remote 未挂载）"); return undefined; }
				let settled = false;
				const guard = setTimeout(() => {
					if (!alive || settled) return;
					settled = true;
					setBusy(false);
					setErr("拉取超时：starmap 服务 20 秒无响应——Host 端服务大概率未激活，需要重启 DSH 让插件行重新装载");
				}, 20000);
				remote.listStars(true).then((r) => {
					if (!alive || settled) return;
					settled = true;
					clearTimeout(guard);
					setBusy(false);
					const d = unwrap(r);
					if (d && Array.isArray(d.stars)) {
						setData(d);
						const on = {};
						for (const k of KIND_ORDER) on[k] = true;
						setKindsOn(on);
					} else setErr("Host 数据无效：" + preview(d));
				}, (e) => {
					if (!alive || settled) return;
					settled = true;
					clearTimeout(guard);
					setBusy(false);
					setErr(detail(e));
				});
				return () => { alive = false; clearTimeout(guard); };
			}, []);

			// 布局只依赖数据：canvas 尚未挂载也要先把 layout 算出来，
			// 否则「layout 等 canvasEl、canvas 又等 layout」互相死锁（v0.2.0 遗留 bug，
			// 表现为永远停在「整理星图…」）。
			react.useEffect(() => {
				if (!data) return;
				setLayout(computeLayout(data.stars, 940, 520));
			}, [data]);

			react.useEffect(() => {
				if (!data || !layout || !canvasEl) return undefined;
				const renderer = createRenderer(canvasEl, layout, visBox, hoverBox);
				drawBox.renderer = renderer;
				drawBox.t0 = Date.now();
				renderer.render(0);

				// ── 按需重绘（重做过一版）──
				// 旧版是一个常驻 rAF 循环：只要星图页开着就永远满帧重画，后台标签页也一样，
				// 而画面其实早就静止了。新的规矩只有三种情况会画：
				//   1. 入场展示动画期间（约 1.3s，星点按诞生时间依次点亮）
				//   2. 有人调 markDirty()（hover / 数据或筛选变化 / 尺寸变化）
				//   3. 诞生回放进行中
				// 其余时间一帧都不画。另外帧率封顶 30fps，页面不可见时直接跳过。
				const FRAME_MS = 1000 / 30;
				const ENTRANCE_MS = 1300;
				let raf = 0;
				let dirty = true;
				let lastDraw = 0;
				function schedule() {
					if (!raf) raf = window.requestAnimationFrame(tick);
				}
				function tick(ts) {
					raf = 0;
					if (!drawBox.renderer) return;
					if (ts - drawBox.t0 < ENTRANCE_MS || replayBox.active) dirty = true;
					if (!dirty) return;
					if (typeof document !== "undefined" && document.hidden) return;
					if (ts - lastDraw < FRAME_MS) { schedule(); return; }
					dirty = false;
					lastDraw = ts;
					drawBox.renderer.render((ts - drawBox.t0) / 1000);
				}
				drawBox.markDirty = function () { dirty = true; schedule(); };
				schedule();

				return () => {
					window.cancelAnimationFrame(raf);
					drawBox.renderer = null;
					drawBox.markDirty = null;
					replayBox.active = false;
					window.cancelAnimationFrame(replayBox.raf);
					if (renderer.destroy) renderer.destroy();
				};
			}, [data, layout, canvasEl, themeKey]);

			react.useEffect(() => {
				if (!data || !layout || !kindsOn) return;
				const q = query.trim().toLowerCase();
				const vis = buildVisibility(layout, kindsOn, q, showArchive);
				visBox.flags = vis.flags;
				visBox.lines = vis.lines;
				let anyVis = false;
				for (let i = 0; i < vis.flags.length; i++) { if (vis.flags[i]) { anyVis = true; break; } }
				setEmptySky(!anyVis);
				if (drawBox.renderer) {
					if (drawBox.renderer.setGeometry) drawBox.renderer.setGeometry();
					// 交给按需重绘那一套：下一帧画（<33ms），不再这里直接 render
					if (drawBox.markDirty) drawBox.markDirty();
					else drawBox.renderer.render((Date.now() - drawBox.t0) / 1000);
				}
			}, [data, layout, kindsOn, query, showArchive]);

			function hitTest(e) {
				if (!layout) return -1;
				const rect = e.currentTarget.getBoundingClientRect();
				if (rect.width <= 0) return -1;
				const sx = (e.clientX - rect.left) * (layout.W / rect.width);
				const sy = (e.clientY - rect.top) * (layout.H / rect.height);
				let best = -1;
				let bestD = Infinity;
				for (let i = 0; i < layout.pts.length; i++) {
					if (!visBox.flags[i]) continue;
					const p = layout.pts[i];
					const dx = p.x - sx;
					const dy = p.y - sy;
					const d = dx * dx + dy * dy;
					// 每颗星有自己的热区：暗星画得小，热区反而要更大（16px），否则
					// 就成了「看得见但点不中」。活星仍是 12px。
					const lim = p.star.archived === true ? 256 : 144;
					if (d < lim && d < bestD) { bestD = d; best = i; }
				}
				return best;
			}

			function onMove(e) {
				if (!layout) return;
				const rect = e.currentTarget.getBoundingClientRect();
				const best = hitTest(e);
				if (best !== hoverBox.idx) {
					hoverBox.idx = best;
					if (drawBox.renderer && drawBox.renderer.setHighlight) drawBox.renderer.setHighlight(best);
					if (drawBox.markDirty) drawBox.markDirty();
				}
				if (best >= 0) {
					const p = layout.pts[best];
					const cssX = p.x * (rect.width / layout.W);
					const cssY = p.y * (rect.height / layout.H);
					// 靠右的星摘要翻到左侧，避免溢出/被详情面板压住
					const flip = cssX > layout.W * 0.58;
					const left = flip ? Math.max(8, cssX - 292) : cssX + 12;
					setHover({ star: p.star, left: left, top: cssY - 8 });
				} else setHover(null);
			}

			function onLeave() {
				hoverBox.idx = -1;
				if (drawBox.renderer && drawBox.renderer.setHighlight) drawBox.renderer.setHighlight(-1);
				if (drawBox.markDirty) drawBox.markDirty();
				setHover(null);
			}

			/**
			 * 打开详情。归档星不在这里展开正文：starmap.readFile 只读记忆根目录，
			 * 归档那份在 archive/ 下取不到 —— 与其弹一句「读取失败」，不如面板直接
			 * 给归档信息 + 「恢复」；恢复之后远程自然读得到它。
			 */
			function openStar(st) {
				setSelected({ star: st, text: null });
				if (st.archived === true) return;
				const remote = ctx.get("remote.starmap");
				if (!remote) return;
				remote.readFile(st.file).then((r) => {
					const d = unwrap(r);
					setSelected((prev) => {
						if (prev && prev.star.file === st.file) {
							return { star: prev.star, text: d && typeof d.content === "string" ? d.content : "(读取失败)" };
						}
						return prev;
					});
				}, () => {
					setSelected((prev) => (prev && prev.star.file === st.file ? { star: prev.star, text: "(读取失败)" } : prev));
				});
			}

			/** 从星图直接恢复一颗归档星：成功后重新取数，星回到活星区。 */
			function restoreStar(st) {
				const remote = ctx.get("remote.memory");
				if (!remote || typeof remote.restore !== "function") {
					setErr("宿主侧没有 restore 接口（插件版本较旧）");
					return;
				}
				setErr("");
				setRestoring(st.file);
				remote.restore(st.file).then((r) => {
					setRestoring(null);
					if (r && r.ok === false) { setErr(r.error || "恢复被拒绝"); return; }
					setSelected(null);
					refresh();
				}, (e) => {
					setRestoring(null);
					setErr(detail(e));
				});
			}

			function onClick(e) {
				const best = hitTest(e);
				if (best < 0 || !layout) return;
				openStar(layout.pts[best].star);
			}

			function refresh() {
				const remote = ctx.get("remote.starmap");
				if (!remote) return;
				setData(null);
				setLayout(null);
				setSelected(null);
				setErr("");
				setBusy(true);
				// 连归档星一起取：暗星是背景，不该为它再跑一次请求。
				remote.listStars(true).then((r) => {
					setBusy(false);
					const d = unwrap(r);
					if (d && Array.isArray(d.stars)) setData(d);
					else setErr("Host 返回了空数据");
				}, (e) => {
					setBusy(false);
					setErr(String((e && e.message) || e));
				});
			}

			function toggleKind(k) {
				setKindsOn((prev) => {
					const next = {};
					for (const kk in prev) next[kk] = prev[kk];
					next[k] = !prev[k];
					return next;
				});
			}

			// ── 诞生回放：按 mtime 顺序把星空重新点亮一遍 ──
			function stopReplay() {
				replayBox.active = false;
				window.cancelAnimationFrame(replayBox.raf);
				if (drawBox.renderer && drawBox.renderer.setReveal) drawBox.renderer.setReveal(null);
				if (drawBox.markDirty) drawBox.markDirty();
				setReplaying(false);
				setReplayDate(null);
			}
			function startReplay() {
				if (!data || !drawBox.renderer || !drawBox.renderer.setReveal) return;
				let mn = Infinity;
				let mx = 0;
				for (const s of data.stars) {
					const m = s.mtimeMs || 0;
					if (m < mn) mn = m;
					if (m > mx) mx = m;
				}
				if (!isFinite(mn)) return;
				window.cancelAnimationFrame(replayBox.raf);
				const span = Math.max(mx - mn, 60000) + 2400;
				const dur = 18000;
				const t0 = Date.now();
				replayBox.active = true;
				setReplaying(true);
				let lastLabel = 0;
				const tick = () => {
					if (!replayBox.active) return;
					const p = Math.min(1, (Date.now() - t0) / dur);
					const cur = mn - 1200 + span * p;
					if (drawBox.renderer && drawBox.renderer.setReveal) drawBox.renderer.setReveal(cur);
					if (Date.now() - lastLabel > 250) {
						lastLabel = Date.now();
						setReplayDate(Math.min(mx, cur));
					}
					if (p >= 1) { stopReplay(); return; }
					replayBox.raf = window.requestAnimationFrame(tick);
				};
				replayBox.raf = window.requestAnimationFrame(tick);
			}

			// 归档星数（数据一次取全，含归档）：头部开关与图例计数都要用。
			const archivedN = data ? data.stars.filter((s) => s.archived === true).length : 0;

			let body;
			if (err) {
				body = h("div", { className: "smap-status" }, "点亮失败：" + err);
			} else if (!data || !layout || !kindsOn) {
				body = h("div", { className: "smap-status" }, busy ? "正在点亮星空…" : "整理星图…");
			} else {
				// 「显示档案馆」关掉时，图例计数也只算活星 —— 屏幕上没有的东西不该占数字。
				const viewStars = showArchive ? data.stars : data.stars.filter((s) => s.archived !== true);
				const legendKids = [];
				for (const k of KIND_ORDER) {
					const n = viewStars.filter((s) => s.kind === k).length;
					if (n === 0) continue;
					legendKids.push(h("span", {
						key: k,
						className: "smap-lg-item" + (kindsOn[k] ? "" : " off"),
						onClick: () => toggleKind(k),
						title: "点击显示/隐藏这一类",
					},
					h("span", { className: "smap-dot", style: { background: kindColor(KIND_META[k]) } }),
					KIND_META[k].label + " " + n));
				}
				let totalBytes = 0;
				let newest = 0;
				for (const s of viewStars) {
					totalBytes += s.bytes || 0;
					if (s.mtimeMs > newest) newest = s.mtimeMs;
				}
				legendKids.push(h("span", { key: "count", className: "smap-count" },
					viewStars.length + " 条 · " + fmtSize(totalBytes) + (newest ? " · 最近更新 " + fmtDate(newest) : "") +
					(showArchive && archivedN ? " · 档案馆 " + archivedN + " 颗暗星" : "") +
					" · 单击看" + (showArchive && archivedN ? "详情" : "全文")));

				const tip = hover ? (() => {
					const meta = KIND_META[hover.star.kind] || KIND_META.special;
					const kids = [
						h("div", { key: "t", className: "smap-tip-title" }, hover.star.title),
						h("div", { key: "k", className: "smap-tip-kind" },
							meta.label + " · " + hover.star.file + " · " + fmtSize(hover.star.bytes)),
					];
					if (hover.star.archived === true) {
						// 悬浮也要说清它是档案馆里的：暗星外表已经不同，别让人猜。
						kids.push(h("div", { key: "arch", className: "smap-tip-kind" },
							"已归档" + (hover.star.archivedAt ? " · " + hover.star.archivedAt : "") +
							(hover.star.archivedReason ? " · " + hover.star.archivedReason : "")));
					}
					if (hover.star.desc) {
						const d = hover.star.desc.length > 90 ? hover.star.desc.slice(0, 90) + "…" : hover.star.desc;
						kids.push(h("div", { key: "d", className: "smap-tip-desc" }, d));
					}
					return h("div", { className: "smap-tip", style: { left: hover.left, top: hover.top } }, kids);
				})() : null;

				let panel = null;
				if (selected) {
					const meta = KIND_META[selected.star.kind] || KIND_META.special;
					const panelKids = [
						h("div", { key: "head", className: "smap-panel-head" },
							h("span", { className: "smap-panel-title" }, selected.star.title),
							h("button", { className: "smap-btn", onClick: () => setSelected(null), title: "关闭" }, "×")),
						h("div", { key: "meta", className: "smap-panel-meta" },
							h("span", { className: "smap-meta-dot", style: { background: kindColor(meta) } }),
							meta.label + " · " + selected.star.file + " · " + fmtSize(selected.star.bytes) +
							// 归档星的 mtime 是「当年写下」的时间，跟「什么时候收起来的」不是一回事 ——
							// 这里只留「已归档」，具体时间在下面的归档块里给。
							(selected.star.archived === true
								? " · 已归档"
								: (selected.star.mtimeMs ? " · " + fmtDate(selected.star.mtimeMs) : ""))),
					];
					if (selected.star.archived === true) {
						// 归档星：不展开正文（远程读不到 archive/），给归档信息 + 一键恢复。
						// 恢复了就能正常读 —— 面板给出的是一条出路，不是一个死状态。
						panelKids.push(h("div", { key: "arch", className: "smap-panel-arch" }, [
							h("div", { key: "at" }, "已归档于 " + (selected.star.archivedAt || "（时间未知）")),
							h("div", { key: "why" }, "理由：" + (selected.star.archivedReason || "（没写）")),
							h("div", { key: "hint", className: "smap-panel-meta" },
								"归档的记忆不参与检索与星图；原文仍在记忆目录的 archive/ 下，恢复后即可正常阅读。"),
							h("button", {
								key: "restore", className: "smap-btn smap-btn-primary",
								disabled: restoring === selected.star.file,
								onClick: () => restoreStar(selected.star),
							}, restoring === selected.star.file ? "恢复中…" : "恢复到活动记忆"),
						]));
					} else if (selected.text === null) panelKids.push(h("div", { key: "loading", className: "smap-status" }, "展开中…"));
					else panelKids.push(h("div", { key: "body" }, renderMarkdown(selected.text)));
					panel = h("div", { className: "smap-panel" }, panelKids);
				}

				let mainView;
				if (viewMode === "timeline") {
					const q2 = query.trim().toLowerCase();
					const sorted = data.stars
						.filter((s) => starVisible({ star: s }, kindsOn, q2, showArchive))
						.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0) || a.file.localeCompare(b.file));
					mainView = h("div", { className: "smap-wrap", key: "wrap" },
						h("div", { className: "smap-timeline" },
							sorted.length === 0
								? h("div", { className: "smap-status" }, "这片天区安静了")
								: sorted.map((s) => h("div", {
										className: "smap-tl-item" + (s.archived === true ? " smap-tl-item--arch" : ""),
										key: s.file,
										onClick: () => openStar(s),
										title: s.archived === true ? "归档案：点开看归档信息并恢复" : "展开全文",
									},
									h("span", { className: "smap-meta-dot", style: { background: s.archived === true ? dimCss(kindColor(KIND_META[s.kind] || KIND_META.special)) : kindColor(KIND_META[s.kind] || KIND_META.special), flex: "none", alignSelf: "center" } }),
									s.archived === true ? h("span", { className: "smap-ar-badge" }, "已归档") : null,
									h("span", { className: "smap-tl-date", title: s.mtimeMs ? fmtDate(s.mtimeMs) : "" }, s.mtimeMs ? fmtRel(s.mtimeMs) : "—"),
									h("span", { className: "smap-tl-title" }, s.title),
									h("span", { className: "smap-tl-desc" }, s.desc || "")))),
						panel);
				} else {
					mainView = h("div", { className: "smap-wrap", key: "wrap" },
						h("canvas", {
							className: "smap-canvas",
							ref: setCanvasEl,
							onMouseMove: onMove,
							onMouseLeave: onLeave,
							onClick: onClick,
						}),
						emptySky ? h("div", { className: "smap-empty" }, "这片天区安静了") : null,
						tip,
						panel);
				}
				body = [
					mainView,
					h("div", { className: "smap-legend", key: "legend" }, legendKids),
				];
			}

			return h("div", { className: "smap-card" },
				// 卡片里不再重复「记忆星图 / sage-mem memory」这一行 —— 标题已经在面板顶部
				// 那条共用头部带里（「我在哪」），这里只留控件，少一行噪音。
				h("div", { className: "smap-head" },
					h("span", { className: "smap-spacer" }),
					h("span", { className: "smap-viewtoggle" },
						h("button", { className: "smap-vt-btn" + (viewMode === "sky" ? " on" : ""), onClick: () => setViewMode("sky"), title: "空间视角：星座分布" }, "星空"),
						h("button", { className: "smap-vt-btn" + (viewMode === "timeline" ? " on" : ""), onClick: () => setViewMode("timeline"), title: "时间视角：最近更新在前" }, "时间线")),
					// 档案馆开关：默认开。关掉只是本地不再画暗星，不重新取数。
					// 只留文字，不挂数字（计数归脚注的「档案馆 N 颗暗星」）；开/关靠 on 态
					// 与 aria-pressed 的样式差，别让人猜现在是开还是关。
					h("button", {
						className: "smap-btn smap-ar-toggle" + (showArchive ? " on" : ""),
						"aria-pressed": showArchive ? "true" : "false",
						onClick: () => setShowArchive(!showArchive),
						title: showArchive
							? "开着：已归档的记忆画成暗星。点一下只留活星（不重新取数）"
							: "关着：图上只有活星。点一下把已归档的记忆也画成暗星",
					}, "显示档案馆"),
					viewMode === "sky" ? h("button", {
						className: "smap-btn" + (replaying ? " smap-replay-on" : ""),
						onClick: () => (replaying ? stopReplay() : startReplay()),
						title: "按记忆写下的顺序，把这片天重新点亮一遍",
					}, replaying ? "停止" : "回放") : null,
					replaying && replayDate ? h("span", { className: "smap-replay-date" }, fmtDate(replayDate) + " · 诞生中") : null,
					h("input", {
						className: "smap-search",
						placeholder: "找一颗星…",
						value: query,
						onChange: (e) => setQuery(e.target.value),
					}),
					h("button", { className: "smap-btn", onClick: refresh, title: "重新读取记忆目录" }, busy ? "…" : "刷新"),
					onClose ? h("button", { className: "smap-btn", onClick: onClose, title: "关闭 (Esc)" }, "关闭") : null),
				body);
		}

		const inject = ["slots", "remote"];

		/**
		 * Client 插件：$mount strict remote contribution（第三方 remote 不在
		 * 宿主的固定 remote 清单里，必须自己挂），再注册星图子槽（B 方案起不再有右缘浮标与全屏 overlay）。
		 */
		async function apply(ctx) {
			appCtx = ctx;
			try {
				await ctx.remote.$mount(TYPERT_REMOTE);
			} catch (e) {
				// remote 注册失败不拖死 UI：星图打开时再向用户报错
				console.error("sage-starmap: remote mount failed", e);
			}
			injectCss();
			// B 方案：星图不再占对话主界面（去掉右缘 ✦ 浮标 + 全屏 overlay），
			// 改为注入 sage-mem 记忆管理页的「星图」子槽（settings.memory.starmap），
			// 由记忆管理页的标签栏切换渲染，作为并列视图。
			ctx.slots.inject("settings.memory.starmap", () => {
				ctx.slots.register(
					{ name: "settings.memory.starmap", id: "sage-starmap", order: 10, label: "记忆星图" },
					() => h(StarMap, { ctx: appCtx }),
				);
			});
		}

		injectCss();
		return { StarMap: StarMap };

})(require, react);



		// ── 手写 strict codec（浏览器无 zod，typert 只要求 parse 方法）──
		// 基元（parseSchema / isStr / isBool / isNum / strSchema）在 05-shared.js。
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
		// 「彻底删除」的入参：归档代次（`archivedAt`）。它不是装饰 —— 宿主拿它核对
		// 「要删的是不是用户确认过的那一版」。老归档件没有留痕时传空串，所以只校类型。
		const archiveStampSchema = strSchema;

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

		const TYPERT_REMOTE = {
			package: "sage-mem",
			descriptors: [
				{
					id: "sage-mem#memory/listFiles",
					service: "memory",
					namespace: "memory",
					method: "listFiles",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#FileList", schema: listSchema, create: () => listSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/readFile",
					service: "memory",
					namespace: "memory",
					method: "readFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#FileContent", schema: readSchema, create: () => readSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/writeFile",
					service: "memory",
					namespace: "memory",
					method: "writeFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
						{ name: "content", wire: "content", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileContent", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#WriteResult", schema: writeSchema, create: () => writeSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/deleteFile",
					service: "memory",
					namespace: "memory",
					method: "deleteFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#DeleteResult", schema: deleteSchema, create: () => deleteSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/archive",
					service: "memory",
					namespace: "memory",
					method: "archive",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
						{ name: "reason", wire: "reason", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveReason", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveResult", schema: archiveSchema, create: () => archiveSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/restore",
					service: "memory",
					namespace: "memory",
					method: "restore",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveResult", schema: archiveSchema, create: () => archiveSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/listArchived",
					service: "memory",
					namespace: "memory",
					method: "listArchived",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedList", schema: archivedListSchema, create: () => archivedListSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/readArchived",
					service: "memory",
					namespace: "memory",
					method: "readArchived",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedFileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedFileContent", schema: archivedReadSchema, create: () => archivedReadSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/writeArchived",
					service: "memory",
					namespace: "memory",
					method: "writeArchived",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedFileName", schema: strSchema, create: () => strSchema } },
						{ name: "content", wire: "content", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedFileContent", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedWriteResult", schema: archivedWriteSchema, create: () => archivedWriteSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 彻底删除一条归档件（不可恢复）。第二个参数是归档代次：宿主拿它核对
					// 「要删的是不是用户确认过的那一版」，传错（比如列表过期）会被拒绝。
					id: "sage-mem#memory/deleteArchived",
					service: "memory",
					namespace: "memory",
					method: "deleteArchived",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchivedFileName", schema: strSchema, create: () => strSchema } },
						{ name: "archivedAt", wire: "archivedAt", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveStamp", schema: archiveStampSchema, create: () => archiveStampSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveResult", schema: archiveSchema, create: () => archiveSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				// ── 面板 API（D1）：体检 / 归档候选 / 设置 / 保留名原样读写 ──
				// 结果形状都在演进（审计清单、候选表、设置项），顶层用 objCodec 接住、
				// 内部宽松 —— 与 autodream 那几个 codec 同一套理由：host 加字段不该让旧界面整体报错。
				{
					id: "sage-mem#memory/audit",
					service: "memory",
					namespace: "memory",
					method: "audit",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AuditReport", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/openMemoryDir",
					service: "memory",
					namespace: "memory",
					method: "openMemoryDir",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#OpenFolderResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/checkUpdate",
					service: "memory",
					namespace: "memory",
					method: "checkUpdate",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#UpdateCheck", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 上锁 / 解锁一条记忆：锁上的记忆拒绝归档（自动与手动都不行）。
					id: "sage-mem#memory/setLocked",
					service: "memory",
					namespace: "memory",
					method: "setLocked",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
						{ name: "locked", wire: "locked", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#LockFlag", schema: boolSchema, create: () => boolSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#LockResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/archiveCandidates",
					service: "memory",
					namespace: "memory",
					method: "archiveCandidates",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ArchiveCandidates", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 1.8.0：结果里多了 `ui.sidebarEntry`（侧栏入口开关）。客户端这份 codec 是
					// **顶层严格、内部宽松**的 objCodec —— host 加字段不需要改这里（与 audit /
					// autodream 那批同一套理由）；host 侧真正的形状约束在 typert.host.js 的 zod schema。
					id: "sage-mem#memory/getSettings",
					service: "memory",
					namespace: "memory",
					method: "getSettings",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#MemorySettings", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 1.8.0：patch 可带 `{ ui: { sidebarEntry: boolean } }`。objCodec 只保证顶层是对象，
					// 字段级严格校验在 host 的 setSettings（非布尔 / 未知键都回 {ok:false}）。
					id: "sage-mem#memory/setSettings",
					service: "memory",
					namespace: "memory",
					method: "setSettings",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "patch", wire: "patch", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#MemorySettingsPatch", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#MemorySettingsResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/readRaw",
					service: "memory",
					namespace: "memory",
					method: "readRaw",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ReservedFileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#RawFileContent", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/writeRaw",
					service: "memory",
					namespace: "memory",
					method: "writeRaw",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ReservedFileName", schema: strSchema, create: () => strSchema } },
						{ name: "content", wire: "content", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#RawFileContent", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#RawWriteResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 1.7.0：最近几次注入的账。**宽松 codec**（与 audit / 设置那批同一套理由）：
					// 面板只按字段取值、缺失就降级显示，host 将来加字段不该让整条调用报错。
					// 每一条记录的字段口径见 lib/recall/debug.js 的 makeDebug 注释。
					id: "sage-mem#memory/recallDebug",
					service: "memory",
					namespace: "memory",
					method: "recallDebug",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#RecallDebug", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#starmap/listStars",
					service: "starmap",
					namespace: "starmap",
					method: "listStars",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "includeArchived", wire: "includeArchived", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#StarmapIncludeArchived", schema: boolSchema, create: () => boolSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#StarmapList", schema: starmapListSchema, create: () => starmapListSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#starmap/readFile",
					service: "starmap",
					namespace: "starmap",
					method: "readFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#StarmapRead", schema: starmapReadSchema, create: () => starmapReadSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				// ── autodream（自动做梦）──
				// 踩到的坑：namespace 不会自动出现。宿主那份 remote 清单是**构建期生成的
				// 产物**，只有 memory / starmap 在里面；
				// 后加的 autodream 不在，于是 `ctx.get("remote.autodream")` 永远 undefined ——
				// 界面上表现为「remote.autodream 不可用」，而 宿主侧日志明确写着
				// 「autodream gateway mounted ok」（服务是真的挂上了，只是 client 不知道）。
				// 修法就是自己声明 + $mount，和 memory / starmap 一样（现在共十一条：
				// 七个原有方法 + listRuns / readDeclaration / rollback / listModels）。
				{
					id: "sage-mem#autodream/getConfig",
					service: "autodream",
					namespace: "autodream",
					method: "getConfig",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamConfigResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/setConfig",
					service: "autodream",
					namespace: "autodream",
					method: "setConfig",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "patch", wire: "patch", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamPatch", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamConfigResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/status",
					service: "autodream",
					namespace: "autodream",
					method: "status",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamStatus", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/runNow",
					service: "autodream",
					namespace: "autodream",
					method: "runNow",
					invocation: { kind: "direct" },
					parameters: [
						// 契约：runNow({reason})。前端只负责给一个缘由字符串（落进
						// manifest.reason 给人看）；「手动触发跳过门控」由 宿主侧决定。
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamOpts", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamRunResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/listReports",
					service: "autodream",
					namespace: "autodream",
					method: "listReports",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamReportList", schema: arrCodec, create: () => arrCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/readReport",
					service: "autodream",
					namespace: "autodream",
					method: "readReport",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamReportRef", schema: strSchema, create: () => strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#FileContent", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/listSnapshots",
					service: "autodream",
					namespace: "autodream",
					method: "listSnapshots",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamSnapshotList", schema: arrCodec, create: () => arrCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				// ── 运行记录 / 整理声明 / 回滚 / 模型目录 ──
				// 都是「单个对象参数」形态（与 setConfig(patch) 同形），契约第二节的
				// {limit} / {runId} / {snapshotId, scope} 逐字对应这个对象的字段。
				{
					id: "sage-mem#autodream/listRuns",
					service: "autodream",
					namespace: "autodream",
					method: "listRuns",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamOpts", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamRunList", schema: arrCodec, create: () => arrCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/readDeclaration",
					service: "autodream",
					namespace: "autodream",
					method: "readDeclaration",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamOpts", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamDeclaration", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/rollback",
					service: "autodream",
					namespace: "autodream",
					method: "rollback",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamOpts", schema: objCodec, create: () => objCodec } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamRollbackResult", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#autodream/listModels",
					service: "autodream",
					namespace: "autodream",
					method: "listModels",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#AutodreamModelList", schema: objCodec, create: () => objCodec },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				// ── 冲突裁决（2.0.0 矛盾检测）──
				// 第四个 namespace。与 autodream 那批同一个坑：namespace **不会自动出现**
				// （宿主 remote 清单是构建期产物），不在这里声明 `ctx.get("remote.conflict")`
				// 就永远是 undefined —— 界面表现为「一整个页签消失」。
				// 6 条都在同一个 `conflict` 面上：列表 / 读正文 / 标失效 / 标记已裁决 / 撤销 / 删记录。
				{
					id: "sage-mem#conflict/list",
					service: "conflict",
					namespace: "conflict",
					method: "list",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictList", schema: conflictListSchema, create: () => conflictListSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 只读：拿一条记录的两份正文（record = item + incoming/onDisk）。
					id: "sage-mem#conflict/read",
					service: "conflict",
					namespace: "conflict",
					method: "read",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ConflictOpts", schema: conflictOptsSchema, create: () => conflictOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictReadResult", schema: conflictReadSchema, create: () => conflictReadSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 唯一会写记忆文件的动作（标 invalid_at）；file 允许是记录的 file 或 otherFile。
					id: "sage-mem#conflict/invalidate",
					service: "conflict",
					namespace: "conflict",
					method: "invalidate",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ConflictOpts", schema: conflictOptsSchema, create: () => conflictOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictInvalidateResult", schema: conflictInvalidateSchema, create: () => conflictInvalidateSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 只改记录状态，不碰记忆文件。
					id: "sage-mem#conflict/dismiss",
					service: "conflict",
					namespace: "conflict",
					method: "dismiss",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ConflictOpts", schema: conflictOptsSchema, create: () => conflictOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictDismissResult", schema: conflictDismissSchema, create: () => conflictDismissSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 撤销失效：删掉 invalidate 写进记忆 frontmatter 的那两行。
					id: "sage-mem#conflict/undo",
					service: "conflict",
					namespace: "conflict",
					method: "undo",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ConflictOpts", schema: conflictOptsSchema, create: () => conflictOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictUndoResult", schema: conflictUndoSchema, create: () => conflictUndoSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
				{
					// 删除记录：不可恢复，但记忆文件一个字节都不动。
					// ⚠️ 方法名不能叫 `remove`：DSH 客户端 RemoteNamespaceService 的原型上有这个名字，
					// 客户端声明同名方法会在 $mount 的 assertMethodAvailable 抛错 —— **整个 client
					// 插件 activate 失败**（2026-10-27 真机复现）。两端统一用 `removeRecord`。
					id: "sage-mem#conflict/removeRecord",
					service: "conflict",
					namespace: "conflict",
					method: "removeRecord",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "opts", wire: "opts", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#ConflictOpts", schema: conflictOptsSchema, create: () => conflictOptsSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#ConflictRemoveResult", schema: conflictRemoveSchema, create: () => conflictRemoveSchema },
					sourceLocation: { "file": "lib/index.js", "line": 1, "column": 1 },
				},
			],
		};

		const CSS = [
			".smem-root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);max-width:760px;}",
			".smem-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			/**
			 * 头部带里的「弹簧」：吃掉本行的剩余空间，把后面的主操作顶到右边。
			 *
			 * 为什么不用 `margin-left:auto`：那个写法在**换行之后依然把它推到最右**，
			 * 于是窗口一窄（或状态徽标一多）主操作就被挤到下一行的右端，看着像跑出了格子。
			 * 弹簧换成 `flex:1 1 auto` 之后 —— 放得下时它撑开（主操作靠右），
			 * 放不下时主操作换行、而弹簧留在上一行，**下一行就是左顶格**。
			 */
			".smem-head-spacer{flex:1 1 auto;min-width:0;}",
			".smem-title{font-size:15px;font-weight:600;}",
			".smem-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:none;}",
			".smem-dot--bad{background:var(--dsw-alias-state-error-primary,#ef4444);}",
			".smem-muted{color:var(--dsw-alias-label-secondary);font-size:12px;}",
			".smem-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			// 筛选条：类型 + 自定义标签两组 chip，与搜索框是 AND 关系。
			// 只消费宿主 CSS 变量，不另造配色 —— 浅色深色共用同一套语言。
			".smem-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
			".smem-filters-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:none;}",
			".smem-sep{width:1px;height:15px;background:var(--dsw-alias-border-l2);flex:none;margin:0 3px;}",
			".smem-chip-n{opacity:.62;margin-left:5px;font-variant-numeric:tabular-nums;}",
			".smem-taglist{display:flex;gap:4px;flex-wrap:wrap;}",
			".smem-tag{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border-radius:5px;padding:1px 6px;white-space:nowrap;}",
			".smem-search{flex:1;min-width:160px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;padding:5px 10px;font-size:12px;outline:none;font-family:inherit;}",
			".smem-search:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;}",
			".smem-btn:hover{border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-btn:disabled{opacity:.5;cursor:default;}",
			".smem-btn-primary{background:var(--dsw-alias-brand-primary,#4d76e6);border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-bg-base,#fff);}",
			".smem-btn-primary:hover{color:var(--dsw-alias-bg-base,#fff);opacity:.88;}",
			".smem-btn-danger-ghost{color:var(--dsw-alias-state-error-primary,#ef4444);border-color:var(--dsw-alias-border-l2);}",
			".smem-btn-danger{background:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;}",
			".smem-btn-danger:hover{color:#fff;opacity:.9;}",
			".smem-list{display:flex;flex-direction:column;gap:10px;}",
			".smem-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:6px;}",
			".smem-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".smem-card-title{font-weight:600;flex:1;min-width:120px;overflow-wrap:anywhere;text-align:left;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}",
			".smem-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px;white-space:nowrap;}",
			".smem-narrative{color:var(--dsw-alias-label-secondary);font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere;}",
			'.smem-narrative[data-clamp="1"]{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;}',
			".smem-card-foot{display:flex;justify-content:flex-end;}",
			// ── 档案馆（文件列表）──
			// 归档条目整体「退役」：虚线边框 + 灰底 + 内容压灰。
			// ⚠️ 灰的只许是**内容**（下面这几条只点标题/类型章/标签/正文的字色）。
			// 绝不给整张卡片加 opacity / filter —— 那会把里面的「编辑 / 恢复」按钮一起灰掉，
			// 用户会以为按钮不可按（同类误读已经栽过一次）。
			".smem-card--archived{border-style:dashed;background:var(--dsw-alias-bg-layer-2);}",
			".smem-card--archived .smem-card-title,.smem-card--archived .smem-badge,.smem-card--archived .smem-tag,.smem-card--archived .smem-narrative{color:var(--dsw-alias-label-secondary);}",
			".smem-card--archived .smem-badge,.smem-card--archived .smem-tag{opacity:.78;}",
			// 归档文件的「原样文本」编辑器：等宽字体，正文一字不改。
			// 选择器写两个类是为了压过后面那条 .smem-textarea{min-height:72px}——
			// 同一个权重时后定义的赢，单类写法会被它盖掉（截图走查时发现的）。
			".smem-ar-edit{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:8px;display:flex;flex-direction:column;gap:6px;}",
			".smem-textarea.smem-ar-editor{min-height:220px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;}",
			".smem-ar-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);}",
			".smem-ar-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}",
			".smem-ar-reason{font-size:12px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px;white-space:pre-wrap;overflow-wrap:anywhere;}",
			".smem-ar-confirm{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.55;}",
			".smem-ar-banner{font-size:12px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;}",
			// ── 工具行 + 工具面板（体检 / 归档候选 / 保留名原样编辑）──
			// 三个新入口收在一行**轻量**文字按钮里：不跟主工具栏抢重量级，也不各占一块版面。
			// 面板一次只开一个（Section 里一个 tool 状态），否则文件列表会被顶到屏幕外。
			// 工具抽屉：关着时**零占位**（工具栏里只有一个「工具 ▾」），点开才占版面。
			// ⚠️ 可发现性不靠抽屉本身，靠头部带常显的「体检 N 个问题」徽标 —— 那是整个
			// 抽屉方案能成立的前提（否则三个能力就退回「藏起来」了）。
			".smem-drawer{position:relative;flex:none;}",
			".smem-drawer-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:6;min-width:236px;max-width:min(320px,calc(100vw - 24px));background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.10);padding:6px;display:flex;flex-direction:column;gap:2px;}",
			".smem-drawer-item{display:flex;align-items:center;gap:8px;border:0;background:transparent;font-family:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);text-align:left;padding:6px 8px;border-radius:8px;cursor:pointer;}",
			".smem-drawer-item:hover{background:var(--dsw-alias-bg-layer-2);}",
			'.smem-drawer-item[data-on="1"]{background:var(--dsw-alias-bg-layer-2);font-weight:600;}',
			".smem-drawer-item .smem-status{margin-left:auto;}",
			// ── 注入调试面板（1.7.0）──
			// 只读账目：时间/会话/结论一行，问题一行，两组得分表，字节与预算一行。
			// 颜色**只用宿主变量**（主题两档都要能读）；没有一处在硬编码背景上反色。
			".smem-dbg-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".smem-dbg-time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:12px;}",
			".smem-dbg-sess{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);}",
			".smem-dbg-out{font-size:12px;font-weight:600;}",
			".smem-dbg-ok{color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-dbg-warn{color:var(--dsw-alias-state-warn-primary,#d97706);}",
			".smem-dbg-dim{color:var(--dsw-alias-label-secondary);}",
			".smem-dbg-query{font-size:12.5px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;}",
			".smem-dbg-row{display:flex;gap:8px;align-items:flex-start;font-size:12px;}",
			// 行首标签**不许被挤压**：flex 子项默认会收缩，「摘要得分」四个中文字会被挤成
			// 一字一行（1.7.0 真机截图里就是这样）。标签固定不缩、不换行。
			".smem-dbg-row>.smem-label{flex:none;white-space:nowrap;}",
			".smem-dbg-scores{display:flex;flex-wrap:wrap;gap:4px 10px;}",
			".smem-dbg-score{display:inline-flex;gap:4px;align-items:baseline;}",
			".smem-dbg-file{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;overflow-wrap:anywhere;}",
			".smem-dbg-num{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:11.5px;}",
			".smem-dbg-hist{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px;}",
			".smem-dbg-hist-row{display:flex;gap:8px;align-items:baseline;font-size:11.5px;}",
			".smem-status--bad{color:var(--dsw-alias-state-error-primary,#dc2626);font-weight:600;}",
			// 头部带：三个 tab 共用的一条「我在哪 + 现在什么状态 + 主操作」。
			".smem-head-job{font-size:12.5px;font-weight:600;}",
			// 头部带主操作：**不用 margin-left:auto**（见 .smem-head-spacer 的注释）
			".smem-head-actions{display:flex;align-items:center;gap:6px;}",
			".smem-tool-panel{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:8px;}",
			// 独立成屏的工具面板（现在的「体检」）：显式占满**可用宽度**。
			// 整个面板的宽度上限在 `.smem-root`（760px）上，这里只要确保它在任何父容器里
			// 都吃满那个上限 —— 抽屉里的小面板没有这个问题（它外面还套着一层），
			// 而独立成屏后如果父容器不是 column flex，`align-items:stretch` 就不会发生。
			".smem-tool-panel--full{width:100%;align-self:stretch;box-sizing:border-box;}",
			// 已锁定的记忆：卡片上那个按钮要一眼看出「这条现在拒绝归档」，用警示色
			".smem-btn-locked{border-color:var(--dsw-alias-state-warn-primary,#d97706);color:var(--dsw-alias-state-warn-primary,#d97706);}",
			// 「自动归档」页签里的天数输入框：窄一点，别让三个数字各占一整行
			".smem-num{width:88px;}",
			// 体检 / 候选是「翻清单」的面板：定高 + 内部滚动，列表不被顶出首屏。
			// 原样编辑器（.smem-ar-editor）不设上限 —— 那是专心改一份文件的界面，给它完整高度。
			".smem-tool-panel--cap{max-height:320px;overflow-y:auto;}",
			".smem-tool-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".smem-tool-title{font-weight:600;font-size:13px;}",
			".smem-tool-badge{display:inline-flex;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:0 6px;white-space:nowrap;}",
			".smem-tool-badge--bad{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626);}",
			".smem-tool-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			// 体检：硬问题用红标题分节；提示区单独一块虚线框（**不染红**）。
			".smem-audit-sec{display:flex;flex-direction:column;gap:3px;}",
			".smem-audit-h{font-size:12px;font-weight:600;}",
			".smem-audit-h--hard{color:var(--dsw-alias-state-error-primary,#dc2626);}",
			".smem-audit-row{font-size:12px;color:var(--dsw-alias-label-secondary);padding-left:10px;overflow-wrap:anywhere;}",
			".smem-audit-hint{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:7px 9px;display:flex;flex-direction:column;gap:3px;}",
			".smem-empty--ok{color:var(--dsw-alias-state-success-primary,#16a34a);border-color:var(--dsw-alias-state-success-primary,#16a34a);}",
			// 归档候选：每一条都把「为什么建议归档」写出来。
			".smem-cand-list{display:flex;flex-direction:column;gap:6px;}",
			".smem-cand-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5;}",
			".smem-cand{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;display:flex;flex-direction:column;gap:5px;}",
			".smem-cand-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer;}",
			".smem-cand-reason{font-size:12px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px;overflow-wrap:anywhere;}",
			".smem-cand-act{display:flex;justify-content:flex-end;}",
			".smem-cand-confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:6px;}",
			".smem-raw-names{display:flex;gap:6px;flex-wrap:wrap;}",
			// 自动做梦的二级分组：导航用**下划线**（跟筛选 chip、动作按钮区分开，三种层级三种形状）。
			".smem-subtabs{display:flex;gap:16px;border-bottom:1px solid var(--dsw-alias-border-l2);margin:2px 0 8px;}",
			".smem-subtab{background:none;border:0;padding:5px 1px 7px;font-size:12.5px;font-family:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;position:relative;}",
			".smem-subtab--on{color:var(--dsw-alias-label-primary);font-weight:600;}",
			'.smem-subtab--on:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary);}',
			".smem-subtab-n{opacity:.6;margin-left:5px;font-variant-numeric:tabular-nums;}",
			// 五个注入参数排两列：一行放两个，扫读反而更清楚（吸收方案 A 的做法）。
			".smem-ad-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:4px 18px;}",
			".smem-ad-field{display:flex;align-items:center;gap:8px;min-width:0;}",
			".smem-ad-field .smem-autodream-key{min-width:96px;}",
			".smem-actions{display:flex;gap:6px;}",
			".smem-form{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:8px;}",
			".smem-form-title{font-weight:600;font-size:13px;}",
			".smem-label{font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".smem-input,.smem-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;padding:6px 10px;font-size:13px;outline:none;font-family:inherit;}",
			".smem-input:focus,.smem-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-textarea{resize:vertical;min-height:72px;}",
			".smem-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
			".smem-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 12px;font-size:12px;cursor:pointer;font-family:inherit;}",
			".smem-chip:hover{border-color:var(--dsw-alias-border-l2);}",
			'.smem-chip[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-brand-primary,#4d76e6);}',
			".smem-chips{display:flex;gap:6px;flex-wrap:wrap;}",
			".smem-err{border:1px solid var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-state-error-primary,#ef4444);border-radius:8px;padding:6px 10px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;}",
			".smem-ok{color:var(--dsw-alias-state-success-primary,#16a34a);font-size:12px;}",
			".smem-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:22px 14px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;}",
			".smem-tabs{display:flex;gap:20px;border-bottom:1px solid var(--dsw-alias-border-l2);margin-bottom:4px;}",
			".smem-tab{background:none;border:0;padding:8px 2px 10px;font-size:13px;font-family:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;position:relative;}",
			'.smem-tab--on{color:var(--dsw-alias-label-primary);}',
			'.smem-tab--on:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary);}',
			// 高度预算压到 62vh（原 70vh）：设置弹窗本身高度有限，
			// 70vh 在较矮的设置弹窗视口下会把星图底部的图例和计数挤出面板之外。
			".smem-starmap{display:flex;flex-direction:column;height:clamp(320px,55vh,620px);min-height:280px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;}",
			// ── 「自动做梦」面板 ──
			// 融入型：全部走宿主变量，控件复用已有的 chip / input / btn 语言，不另造一套。
			".smem-autodream{display:flex;flex-direction:column;gap:12px;}",
			".smem-autodream-sec{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:9px;}",
			".smem-autodream-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}",
			".smem-autodream-key{font-size:12px;color:var(--dsw-alias-label-secondary);flex:none;min-width:78px;}",
			".smem-switch{border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:999px;width:38px;height:21px;position:relative;cursor:pointer;flex:none;padding:0;}",
			'.smem-switch::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:left .15s,background .15s;}',
			'.smem-switch[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d76e6);background:var(--dsw-alias-brand-primary,#4d76e6);}',
			'.smem-switch[data-on="1"]::after{left:19px;background:#fff;}',
			".smem-num{width:66px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;padding:4px 8px;font-size:12px;font-family:inherit;outline:none;}",
			".smem-num:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-status{font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".smem-autodream-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5;}",
			".smem-autodream-list{display:flex;flex-direction:column;gap:6px;}",
			".smem-report{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 9px;font-size:12px;cursor:pointer;background:transparent;color:inherit;text-align:left;font-family:inherit;}",
			".smem-report:hover{border-color:var(--dsw-alias-border-l2);}",
			'.smem-report[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d76e6);}',
			".smem-report-pre{max-height:320px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6;}",
			".smem-autodream-adv>summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".smem-autodream-adv>div{display:flex;flex-direction:column;gap:8px;padding-top:9px;}",
			// ── 回滚点区 / 整理声明区 ──
			// 新元素一律 .smem-ad-* 前缀，不动主题外的全局样式（契约第六节第 6 条）。
			".smem-ad-select{flex:1;min-width:190px;}",
			".smem-ad-err{color:var(--dsw-alias-state-error-primary,#ef4444);}",
			".smem-ad-wrap{display:flex;flex-direction:column;gap:6px;}",
			".smem-ad-snap{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 9px;font-size:12px;}",
			".smem-ad-main{flex:1;min-width:140px;overflow-wrap:anywhere;}",
			".smem-ad-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;overflow-wrap:anywhere;}",
			".smem-ad-badge{display:inline-flex;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:0 5px;white-space:nowrap;}",
			".smem-ad-badge--warn{color:var(--dsw-alias-state-warn-primary,#d97706);border-color:var(--dsw-alias-state-warn-primary,#d97706);}",
			".smem-ad-badge--legacy{opacity:.78;}",
			".smem-ad-confirm{border:1px solid var(--dsw-alias-state-error-primary,#ef4444);border-radius:8px;padding:7px 9px;font-size:12px;line-height:1.55;display:flex;flex-direction:column;gap:6px;overflow-wrap:anywhere;}",
			".smem-ad-rb{font-size:12px;line-height:1.5;overflow-wrap:anywhere;}",
			".smem-ad-run{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 9px;background:transparent;color:inherit;text-align:left;font-family:inherit;font-size:12px;cursor:pointer;}",
			".smem-ad-run:hover{border-color:var(--dsw-alias-border-l2);}",
			'.smem-ad-run[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d76e6);}',
			".smem-ad-md{max-height:360px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6;}",
			// ── 注入参数 / 保留名名单（自动做梦 tab）──
			".smem-ad-warn{color:var(--dsw-alias-state-warn-primary,#d97706);}",
			".smem-chip--fixed{opacity:.72;cursor:default;}",
			".smem-chip-x{border:0;background:transparent;color:inherit;cursor:pointer;font-size:11px;font-family:inherit;padding:0 0 0 5px;}",
			// ── 更新提示（有新版本才出现的一条窄横幅）──
			".smem-update{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--dsw-alias-brand-primary,#4d76e6);border-radius:8px;padding:6px 10px;font-size:12px;background:var(--dsw-alias-bg-layer-1);}",
			".smem-update-link{color:var(--dsw-alias-brand-primary,#4d76e6);text-decoration:underline;}",
			".smem-update-x{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;}",
			// ── 1.5.1：筛选汇总行（有筛选才出现）──
			".smem-filter-summary{width:100%;display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".smem-sum-item{display:inline-flex;align-items:center;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;}",
			".smem-sum-x{border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:1;padding:0 0 0 2px;}",
			".smem-sum-clear{border:0;background:transparent;color:var(--dsw-alias-brand-primary,#4d76e6);font-size:12px;font-family:inherit;cursor:pointer;padding:2px 4px;}",
			// ── 1.5.0：动作分组 / 长文 clamp / 空态骨架 / 窄窗口 ──
			".smem-actions-sep{width:1px;height:16px;background:var(--dsw-alias-border-l2);margin:0 2px;align-self:center;}",
			".smem-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;}",
			".smem-clamp-2--open{-webkit-line-clamp:unset;display:block;}",
			".smem-skeleton{display:flex;flex-direction:column;gap:10px;padding:6px 0;}",
			".smem-skeleton-row{height:44px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);opacity:.55;}",
			".smem-empty{display:flex;flex-direction:column;align-items:flex-start;gap:8px;}",
			".smem-tabs-sep{width:1px;align-self:stretch;margin:6px 2px;background:var(--dsw-alias-border-l2);}",
			// 窄窗口（≤420px）：头部带与筛选条各让一行，卡片动作允许换行、分隔符隐藏。
			"@media (max-width:420px){.smem-root{gap:10px;}.smem-head{gap:6px;}.smem-head-actions{flex-wrap:wrap;}.smem-card-title{min-width:0;word-break:break-word;}.smem-actions{flex-wrap:wrap;}.smem-actions-sep{display:none;}.smem-num{width:56px;}.smem-search{min-width:100px;}}",
			// ── 1.8.0：侧栏入口（设置开关 + 中央主区整页）──
			".smem-check{display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;user-select:none;}",
			".smem-check input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-page{display:flex;flex-direction:column;gap:10px;padding:14px 16px 18px;box-sizing:border-box;min-height:0;overflow:auto;}",
			".smem-page-top{display:flex;align-items:center;}",
			".smem-page-back{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;line-height:1.4;padding:3px 6px 3px 2px;border-radius:6px;cursor:pointer;}",
			".smem-page-back:hover{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-layer-2);}",
			// ── 1.8.2：插件详情页的「侧栏入口」卡片 ──
			// 融入宿主插件页：标题 13px/600、说明 12px 次要色，圆角与分隔线只用宿主 token。
			// 不抄设置页的大标题 —— 这一块是插件页里的一张紧凑卡片，不是另一个 settings section。
			".smem-plugin-card{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,#fafbfc);box-sizing:border-box;}",
			".smem-plugin-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".smem-plugin-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2430);line-height:1.4;}",
			".smem-plugin-card-status{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.4;}",
			".smem-plugin-card-check{font-size:12.5px;}",
			".smem-plugin-card-note{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#6b7280);}",
			".smem-plugin-card-err{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#ef4444);overflow-wrap:anywhere;}",
			// ── 底部一行仓库链接（引流，不抢视线）──
			".smem-star{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1);padding:2px 2px 0;}",
			".smem-star-link{color:var(--dsw-alias-brand-primary,#4d76e6);text-decoration:underline;}",
			// ── 冲突页签（2.0.0 矛盾检测）──
			// 一屏里要同时看「两份正文对照 + 动作 + 后果」，所以独立成套类名，不复用文件卡片：
			// 文件卡片的灰系 / 动作语义是「这条记忆怎么处置」，裁决是另一件事，混用会让
			// 「标失效」看起来像在编辑记忆本身。
			".smem-conf{display:flex;flex-direction:column;gap:8px;}",
			".smem-conf-list{display:flex;flex-direction:column;gap:10px;}",
			".smem-conf-item{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:9px 11px;display:flex;flex-direction:column;gap:6px;}",
			".smem-conf-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
			".smem-conf-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}",
			".smem-conf-files{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
			".smem-conf-file{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;max-width:100%;overflow-wrap:anywhere;white-space:normal;text-align:left;}",
			".smem-conf-arrow{color:var(--dsw-alias-label-secondary);}",
			".smem-conf-acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}",
			".smem-conf-confirm{border:1px solid var(--dsw-alias-state-error-primary,#ef4444);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:1.55;display:flex;flex-direction:column;gap:6px;overflow-wrap:anywhere;}",
			// 两份正文并排对照：窄窗口自动堆成一列（grid auto-fit，不用媒体查询）。
			".smem-conf-bodies{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;}",
			".smem-conf-body{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;display:flex;flex-direction:column;gap:4px;min-width:0;}",
			".smem-conf-label{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);}",
			".smem-conf-pre{margin:0;max-height:220px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);}",
			".smem-conf-warn{font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#d97706);}",
		].join("\n");

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
					h("span", { className: "smem-badge", key: "badge", title: t("card.typeTitle", { type: String(item.type) }) }, meta[0] + " " + typeLabel(TYPE_META[item.type] ? item.type : "reference")),
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
							title: isOpen ? t("card.collapse") : t("card.expand"),
						}, String(item.description))
					: null,
				h("div", { className: "smem-card-foot", key: "foot" },
					props.archiving
						? h("div", { className: "smem-ar-confirm", key: "ar" }, [
								h("div", { key: "what" }, t("card.archiveWhat", { file: item.file })),
								// 「可留空」必须跟输入框贴在一起、并且独立成行 —— 它是这一块最容易
								// 被误读成「必须填才能按」的地方。
								h("label", { className: "smem-label", key: "lb" }, t("card.archiveReason")),
								h("input", {
									className: "smem-input", key: "in",
									value: props.archiveReason || "",
									placeholder: t("card.archiveReasonPlaceholder"),
									onChange: function (e) { props.onArchiveReason(e.target.value); },
								}),
								h("div", { className: "smem-ar-hint", key: "hint" }, t("card.archiveHint")),
								h("div", { className: "smem-row", key: "btns" }, [
									h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "ok", disabled: props.busy, onClick: function () { props.onConfirmArchive(item.file); } }, t("card.confirmArchive")),
									h("button", { type: "button", className: "smem-btn", key: "no", disabled: props.busy, onClick: props.onCancelArchive }, t("card.cancel")),
								]),
							])
						: h("div", { className: "smem-actions", key: "acts" },
								props.deleting
									? [
											h("button", { type: "button", className: "smem-btn smem-btn-danger", key: "yes", onClick: function () { props.onConfirmDelete(item.file); } }, t("card.confirmDelete")),
											h("button", { type: "button", className: "smem-btn", key: "no", onClick: function () { props.onCancelDelete(); } }, t("card.cancel")),
										]
									: [
											h("button", { type: "button", className: "smem-btn", key: "edit", onClick: function () { props.onEdit(item.file); } }, t("card.edit")),
											// 语义分组：左边只放「编辑」（安全、可逆），右边放「锁定 / 归档 / 删除」（对这条记忆的退役/保护决定）。
											h("span", { key: "sep", className: "smem-actions-sep", "aria-hidden": "true" }),
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
													? t("card.lockedTitle")
													: t("card.unlockedTitle"),
												disabled: props.busy,
												onClick: function () { props.onToggleLock(item.file, !item.locked); },
											}, item.locked ? t("card.locked") : t("card.lock")),
											// 归档排在「锁定」和「删除」之间：比编辑轻、比删除温和，且随时可逆。
											h("button", {
												type: "button", className: "smem-btn", key: "arch",
												title: item.locked
													? t("card.archiveLockedTitle")
													: t("card.archiveTitle"),
												disabled: props.busy || item.locked === true,
												onClick: function () { props.onAskArchive(item.file); },
											}, t("card.archive")),
											h("button", { type: "button", className: "smem-btn smem-btn-danger-ghost", key: "del", onClick: function () { props.onAskDelete(item.file); } }, t("card.delete")),
										])),
			]);
		}

		/**
		 * 归档区的一条。与活动卡片共用骨架（类型章 / 标题 / 标签 / 描述），刻意的差异：
		 * 虚线边框 + 整体压灰（退役感）、多一行归档留痕、动作是「编辑 / 恢复 / 彻底删除」。
		 *
		 * ⚠️ 灰的只有**内容**（`.smem-card--archived` 那几条只点标题/类型章/标签/正文的字色）。
		 * 按钮一律保持原样 —— 按钮一灰，用户就以为不能按。
		 *
		 * ⚠️ 编辑走**原样文本**：readArchived 拿到的全文直接进 textarea，保存时原样交回
		 * writeArchived。绝不走活跃记忆那套 buildFrontmatter 重建 —— 重建会吞字段，
		 * 归档文件里还有 archived_at / archived_reason 这种留痕，更动不得。
		 *
		 * 「彻底删除」是 v1.1.0 加的**唯一**一个不可逆入口，所以它走两段式：
		 * 点一下只展开一句「真的删、不能恢复」的确认条，再点「确认彻底删除」才动手。
		 * 归档的承诺（只移不删）没有被它破坏 —— 归档动作仍然一个字节都不删。
		 */
		function ArchivedCard(props) {
			const item = props.item;
			const meta = TYPE_META[item.type] || TYPE_META.reference;
			// 描述与归档理由都可能很长：默认各 clamp（描述 3 行 / 理由 2 行），点一下展开全文。
			const sDescOpen = react.useState(false);
			const descOpen = sDescOpen[0], setDescOpen = sDescOpen[1];
			return h("div", { className: "smem-card smem-card--archived", key: item.file }, [
				h("div", { className: "smem-card-head", key: "head" }, [
					h("span", { className: "smem-badge", key: "badge", title: t("card.typeTitle", { type: String(item.type) }) }, meta[0] + " " + typeLabel(TYPE_META[item.type] ? item.type : "reference")),
					h("span", { className: "smem-card-title", key: "title" }, item.file),
					h("span", { className: "smem-ar-meta", key: "at", title: t("card.archivedAtTitle") }, t("card.archivedAt", { at: item.archivedAt || t("card.unknownTime") })),
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
					? h("div", {
							className: "smem-narrative", key: "desc",
							"data-clamp": descOpen ? "0" : "1",
							title: descOpen ? t("card.collapse") : t("card.expand"),
							onClick: function () { setDescOpen(!descOpen); },
						}, String(item.description))
					: null,
				h("div", {
					className: "smem-ar-reason smem-clamp-2" + (descOpen ? " smem-clamp-2--open" : ""),
					key: "why", title: t("card.reason", { reason: item.archivedReason || t("card.noReason") }),
					onClick: function () { setDescOpen(!descOpen); },
				}, t("card.reason", { reason: item.archivedReason || t("card.noReason") })),
				props.editing
					? h("div", { className: "smem-ar-edit", key: "edit" }, [
							h("div", { className: "smem-ar-hint", key: "note" }, t("card.rawEditNote")),
							props.loading
								? h("div", { className: "smem-status", key: "loading" }, t("card.reading"))
								: h("textarea", {
										className: "smem-textarea smem-ar-editor", key: "ta",
										value: props.text || "",
										spellCheck: false,
										onChange: function (e) { props.onText(e.target.value); },
									}),
							h("div", { className: "smem-row", key: "btns" }, [
								h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "save", disabled: props.busy || props.loading, onClick: function () { props.onSave(item.file); } }, props.saving ? t("card.saving") : t("card.save")),
								h("button", { type: "button", className: "smem-btn", key: "cancel", disabled: props.busy, onClick: props.onCancel }, t("card.cancel")),
							]),
						])
					: props.deleting
						? h("div", { className: "smem-ar-confirm", key: "del" }, [
								h("div", { key: "what" }, t("card.purgeWhat", { file: item.file })),
								h("div", { className: "smem-ar-hint", key: "hint" }, t("card.purgeHint")),
								h("div", { className: "smem-row", key: "btns" }, [
									h("button", { type: "button", className: "smem-btn smem-btn-danger", key: "yes", disabled: props.busy, onClick: function () { props.onConfirmDelete(item.file); } }, t("card.confirmPurge")),
									h("button", { type: "button", className: "smem-btn", key: "no", disabled: props.busy, onClick: props.onCancelDelete }, t("card.cancel")),
								]),
							])
						: h("div", { className: "smem-card-foot", key: "foot" },
								h("div", { className: "smem-actions", key: "acts" }, [
									h("button", {
										type: "button", className: "smem-btn", key: "edit",
										disabled: props.busy,
										onClick: function () { props.onEdit(item.file); },
									}, t("card.edit")),
h("span", { key: "sep", className: "smem-actions-sep", "aria-hidden": "true" }),
																		h("button", {
										type: "button", className: "smem-btn smem-btn-primary", key: "restore",
										disabled: props.busy,
										onClick: function () { props.onRestore(item.file); },
									}, props.restoring ? t("card.restoring") : t("card.restore")),
									// 放在最后、且用 danger-ghost：它是这张卡上唯一不可逆的动作，
									// 不该跟「恢复」长得一样。
									h("button", {
										type: "button", className: "smem-btn smem-btn-danger-ghost", key: "purge",
										disabled: props.busy,
										title: t("card.purgeTitle"),
										onClick: function () { props.onAskDelete(item.file); },
									}, t("card.purge")),
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

		/**
		 * 工具面板头部的「收起」按钮：抽屉里开的工具要能一键收回去 ——
		 * 面板不收，列表就还在下面被顶着。
		 */
		const toolClose = (props) => (props.onClose
			? h("button", { type: "button", className: "smem-btn", key: "close", onClick: props.onClose }, "收起")
			: null);

		/**
		 * 「注入调试」面板（1.7.0）。
		 *
		 * 只读：没有「清空 / 重跑」按钮 —— 账是注入链在 `SAGE_MEM_DEBUG=1` 时自动记的，
		 * 人能做的是看，以及点「刷新」再取一次。入口只在开关打开时出现（宿主告诉我们）。
		 *
		 * 每一条记录的口径写在 `lib/recall/debug.js` 的 makeDebug 注释里；这里只负责把
		 * 「为什么这一步没注入」翻译成人话 —— 那是这个面板存在的唯一理由。**尤其是
		 * `empty + deduped`**：每轮多步里它占大多数，不解释就会被当成「插件坏了」。
		 */
		function RecallDebugPanel(props) {
			const data = props.data || {};
			const recs = Array.isArray(data.records) ? data.records : [];
			const latest = recs.length ? recs[0] : null;
			const pad = (n) => (n < 10 ? "0" + n : String(n));
			function clock(ms) {
				if (typeof ms !== "number") return "";
				const d = new Date(ms);
				return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
			}
			function outcomeText(r) {
				if (!r) return "";
				if (r.outcome === "injected") return "本步注入 " + (Array.isArray(r.injected) ? r.injected.length : 0) + " 条正文";
				if (r.outcome === "card-only") return "正文没进，只发了状态卡";
				return r.deduped ? "同题已注入过，本步去重" : "本步没有可注入的内容";
			}
			function outcomeClass(r) {
				if (!r) return "";
				if (r.outcome === "injected") return " smem-dbg-ok";
				if (r.outcome === "card-only") return " smem-dbg-warn";
				return " smem-dbg-dim";
			}
			function scoreRows(list, emptyText) {
				const arr = Array.isArray(list) ? list : [];
				if (!arr.length) return h("span", { className: "smem-muted", key: "none" }, emptyText || "无");
				return h("div", { className: "smem-dbg-scores", key: "s" }, arr.map(function (x, i) {
					return h("span", { className: "smem-dbg-score", key: String((x && x.file) || i) + "-" + i }, [
						h("span", { className: "smem-dbg-file", key: "f" }, String((x && x.file) || "?")),
						h("span", { className: "smem-dbg-num", key: "n" }, x && typeof x.score === "number" ? String(x.score) : "?"),
					]);
				}));
			}
			const injected = latest && Array.isArray(latest.injected) ? latest.injected : [];
			const histogram = recs.slice(1).map(function (r, i) {
				return h("div", { className: "smem-dbg-hist-row", key: "h" + i }, [
					h("span", { className: "smem-dbg-time", key: "t" }, clock(r.at)),
					h("span", { className: "smem-dbg-out" + outcomeClass(r), key: "o" }, outcomeText(r)),
					h("span", { className: "smem-muted", key: "n" }, String(r.chars || 0) + " 字节"),
				]);
			});
			return h("div", { className: "smem-tool-panel smem-tool-panel--cap", key: "recall-debug" }, [
				h("div", { className: "smem-tool-head", key: "head" }, [
					h("span", { className: "smem-tool-title", key: "t" }, "注入调试"),
					h("span", { className: "smem-muted", key: "s" }, "SAGE_MEM_DEBUG=1 · 最近 " + String(recs.length) + " 次"),
					h("button", { type: "button", className: "smem-btn", key: "again", disabled: props.busy, onClick: props.onReload }, props.busy ? "读取中…" : "刷新"),
					toolClose(props),
				]),
				!latest
					? h("div", { className: "smem-empty", key: "empty" }, "开关已开，但还没有一次注入 —— 开一轮对话再回来看。")
					: h("div", { key: "body" }, [
							h("div", { className: "smem-dbg-head", key: "meta" }, [
								h("span", { className: "smem-dbg-time", key: "t" }, clock(latest.at)),
								// 会话 id 前 8 位：真机上的 id 常以 `session-` 开头，直接截 8 位会只剩
								// 前缀（1.7.0 截图里那一行就是 `session-`）。先剥前缀再截，才有辨识度。
								h("span", { className: "smem-dbg-sess", key: "sid" }, String(latest.sessionId || "").replace(/^session-?/, "").slice(0, 8) || "—"),
								h("span", { className: "smem-dbg-out" + outcomeClass(latest), key: "o" }, outcomeText(latest)),
							]),
							h("div", { className: "smem-dbg-query", key: "q" }, "问题：" + (String(latest.query || "").trim() || "（无）")),
							h("div", { className: "smem-muted", key: "stat" },
								"扫了 " + String(latest.scanned || 0) + " 条 · 摘要命中 " + String(latest.hits || 0) +
								" · 正文命中 " + String(Array.isArray(latest.body) ? latest.body.length : 0) +
								" · baseline " + String(latest.baseline || 0)),
							h("div", { className: "smem-dbg-row", key: "sum" }, [h("span", { className: "smem-label", key: "l" }, "摘要得分"), scoreRows(latest.scores)]),
							h("div", { className: "smem-dbg-row", key: "body" }, [h("span", { className: "smem-label", key: "l" }, "正文命中"), scoreRows(latest.body)]),
							h("div", { className: "smem-dbg-row", key: "inj" }, [
								h("span", { className: "smem-label", key: "l" }, "实际注入"),
								injected.length
									? h("span", { className: "smem-dbg-scores", key: "v" }, injected.map(function (f) {
										return h("span", { className: "smem-dbg-file", key: String(f) }, String(f));
									}))
									: h("span", { className: "smem-muted", key: "v" }, "无"),
							]),
							h("div", { className: "smem-muted", key: "bytes" },
								"正文字节 " + String(latest.chars || 0) + "（本代累计 " + String(latest.sessionChars || 0) + "）" +
								" · 状态卡 " + (latest.cardChars ? String(latest.cardChars) + " 字节" : "未发") +
								" · 预算挡掉 " + String(latest.skippedByBudget || 0) + " 条"),
							h("div", { className: "smem-ar-hint", key: "hint" },
								"注入每走一步都会尝试一次；同题同命中集不会重复注入 —— 所以「空」多半是去重生效，不是坏了。"),
							histogram.length
								? h("div", { className: "smem-dbg-hist", key: "hist" }, histogram)
								: null,
						]),
			]);
		}

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
				h("span", { key: "ask" }, t("star.ask")),
				h("a", {
					key: "cta",
					href: "https://github.com/gezi-wen/sage-mem",
					target: "_blank",
					rel: "noreferrer",
					className: "smem-star-link",
				}, t("star.cta")),
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
					? h("div", { key: "secs" }, [
							section("索引悬空（索引里有、文件没了）", r.dangling, (x) => x.file),
							section("漏索引（文件在、索引里没有）", r.unlisted, (x) => x.file),
							section("type 与前缀对不上", r.typeMismatch, (x) => x.file + " · type=" + x.type + "，文件名前缀=" + x.prefix),
							section("行尾是 CRLF", r.crlf, (x) => x.file),
							section("双链断链", r.brokenLinks, (x) => x.file + " → [[" + x.target + "]]"),
							section("未加引号的「空格+#」", r.hashHazards, (x) => x.file + " · " + x.line),
							section("没有 frontmatter", r.noFrontmatter, (x) => x.file),
							section("读不出来", r.unreadable, (x) => x.file),
							// 归档中途崩溃留下的私有名残留：它不是一条记忆（扫描/注入都不认），
							// 但里面可能是用户唯一一份内容 —— 所以要在体检里露头，而不是隐形。
							section("归档残留（内容可能还在，请确认后改回 .md 或删除）", r.strays, (x) => x.file),
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

		// ── 「冲突」页签（2.0.0 矛盾检测）────────────────────────────────────
		// 只做三件事：看（两份正文对照）、裁（标失效 / 标记已裁决 / 撤销 / 删除记录）、
		// 说清后果（写哪个文件、能不能撤销、失败时的出路在哪）。
		//
		// 状态全部由 Section 持有（与文件列表 / 体检同一套「组件只吃 props」的规矩）：
		// 头部徽标与这一屏数的是同一批记录，两边各存一份就会不同步。
		//
		// 文案里反复写「只标不删」：这是 2.0.0 最容易被误解的一条 —— 标失效不删文件、
		// 不移动、不进 archive/，只是 frontmatter 多一行 invalid_at，随时可撤销。
		const CONFLICT_KIND_KEY = {
			contradiction: "conflict.kind.contradiction",
			stale_version: "conflict.kind.staleVersion",
			external_change: "conflict.kind.externalChange",
			unresolved_merge: "conflict.kind.unresolvedMerge",
		};
		const CONFLICT_STATUS_KEY = {
			open: "conflict.status.open",
			resolved: "conflict.status.resolved",
			dismissed: "conflict.status.dismissed",
		};
		const CONFLICT_DECISION_KEY = {
			invalidate: "conflict.decision.invalidate",
			dismiss: "conflict.decision.dismiss",
			keep_both: "conflict.decision.keepBoth",
		};
		// 失败码 → 出路。**每一条都必须说清下一步**：只写「失败了」等于让用户再点一次
		// 同一颗按钮（D25 修过的正是「点了没反应」这类事故）。
		const CONFLICT_CODE_KEY = {
			invalid: "conflict.code.invalid",
			missing: "conflict.code.missing",
			malformed: "conflict.code.malformed",
			invalid_transition: "conflict.code.invalidTransition",
			stale_version: "conflict.code.staleVersion",
			write_denied: "conflict.code.writeDenied",
			unsupported: "conflict.code.unsupported",
			io_error: "conflict.code.ioError",
		};
		/**
		 * 每份正文默认只显示开头一段。
		 *
		 * 按**字符**截 2048（≈「2 KB」的同量级）：按字节算的话中文只剩六百多字，
		 * 对照两份说法时反而不够看；卡片本身还有 max-height 滚动，不会撑破布局。
		 */
		const CONFLICT_BODY_MAX = 2048;

		function conflictKindLabel(kind) {
			const key = CONFLICT_KIND_KEY[String(kind)];
			return key ? t(key) : String(kind == null ? "" : kind);
		}
		function conflictStatusLabel(status) {
			const key = CONFLICT_STATUS_KEY[String(status)];
			return key ? t(key) : String(status == null ? "" : status);
		}
		function conflictDecisionLabel(decision) {
			const key = CONFLICT_DECISION_KEY[String(decision)];
			return key ? t(key) : String(decision == null ? "" : decision);
		}

		/**
		 * 「冲突」面板（只读列表 + 裁决动作）。
		 *
		 * 能力降级是**逐动作**的：宿主有 list 没 invalidate（版本错配）时，对应按钮必须
		 * 禁用并在同一屏里写明缺哪个接口 —— 不能让用户点了没反应。
		 */
		function ConflictPanel(props) {
			const data = props.data;
			const items = data && Array.isArray(data.items) ? data.items : [];
			const broken = data && Array.isArray(data.broken) ? data.broken : [];
			const ignored = data && Array.isArray(data.ignored) ? data.ignored : [];
			const counts = (data && data.counts) || {};
			const openN = typeof counts.open === "number"
				? counts.open
				: items.filter(function (x) { return x.status === "open"; }).length;
			const totalN = typeof counts.total === "number" ? counts.total : items.length;
			const tools = props.tools || {};
			const bodies = props.bodies || {};
			const expanded = props.expanded || {};
			const confirm = props.confirm || null;
			const busyId = props.busyId || null;
			// `removeRecord` 而不是 `remove`：后者是宿主 RemoteNamespaceService 的保留方法名
			// （声明即让整个 client 插件 activate 失败）。按钮文案的 i18n 键仍是 conflict.action.remove。
			const ACTIONS = ["invalidate", "dismiss", "undo", "removeRecord"];
			const missing = ACTIONS.filter(function (m) { return tools[m] !== true; })
				.map(function (m) { return "conflict." + m; });

			/** 动作按钮：方法不存在时禁用 + title 写明缺什么，绝不留「点了没反应」。 */
			function actBtn(item, action, label, extraClass) {
				const ok = tools[action] === true;
				return h("button", {
					type: "button", key: action,
					className: "smem-btn" + (extraClass || ""),
					disabled: !ok || busyId === item.id,
					title: ok ? undefined : t("conflict.actionMissing", { method: action }),
					onClick: ok ? function () { props.onAsk(item, action); } : undefined,
				}, label);
			}

			function bodyPre(text) {
				const s = typeof text === "string" ? text : "";
				const shown = s.slice(0, CONFLICT_BODY_MAX);
				const more = s.length > CONFLICT_BODY_MAX;
				return h("pre", { className: "smem-conf-pre", key: "pre" }, [
					shown || t("conflict.bodyEmpty"),
					more ? "\n… " + t("conflict.bodyLimit") : null,
				]);
			}

			function renderBodies(item, body) {
				if (!body || body.loading) {
					return [h("div", { className: "smem-status", key: "l" }, t("conflict.bodyLoading"))];
				}
				if (body.error) {
					return [h("div", { className: "smem-err", key: "e" }, "⚠ " + body.error)];
				}
				const rec = body.record || {};
				const contra = item.kind === "contradiction";
				const parts = [
					h("div", { className: "smem-conf-body", key: "in" }, [
						h("div", { className: "smem-conf-label", key: "l" },
							contra ? t("conflict.bodyIncomingContradiction") : t("conflict.bodyIncoming")),
						bodyPre(rec.incoming),
						Array.isArray(body.warnings) && body.warnings.length
							? h("div", { className: "smem-ar-hint", key: "w" },
									t("conflict.warnings", { list: body.warnings.map(String).join("；") }))
							: null,
					]),
					h("div", { className: "smem-conf-body", key: "on" }, [
						h("div", { className: "smem-conf-label", key: "l" },
							contra ? t("conflict.bodyOnDiskContradiction") : t("conflict.bodyOnDisk")),
						bodyPre(rec.onDisk),
					]),
				];
				if (rec.truncated || item.truncated) {
					parts.push(h("div", { className: "smem-conf-warn", key: "tr" }, t("conflict.truncatedHint")));
				}
				return parts;
			}

			/** 危险动作的两段式确认条（照「彻底归档删除」先例：先问，再动手）。 */
			function confirmBlock(item) {
				if (!confirm || confirm.id !== item.id) return null;
				const act = confirm.action;
				const file = confirm.file || item.file;
				if (act === "invalidate") {
					return h("div", { className: "smem-conf-confirm", key: "cf" }, [
						h("div", { key: "what" }, t("conflict.confirmInvalidate", { file: file })),
						item.otherFile
							? h("div", { className: "smem-chips", key: "pick" }, [
									h(Chip, {
										key: "f", label: item.file, on: file === item.file,
										onClick: function () { props.onPickFile(item.file); },
									}),
									h(Chip, {
										key: "o", label: item.otherFile, on: file === item.otherFile,
										onClick: function () { props.onPickFile(item.otherFile); },
									}),
								])
							: null,
						h("div", { className: "smem-ar-hint", key: "hint" }, t("conflict.confirmInvalidateHint")),
						h("div", { className: "smem-row", key: "btns" }, [
							h("button", {
								type: "button", className: "smem-btn smem-btn-danger", key: "yes",
								disabled: busyId === item.id,
								onClick: props.onRun,
							}, busyId === item.id ? t("conflict.busy") : t("conflict.confirmYesInvalidate")),
							h("button", {
								type: "button", className: "smem-btn", key: "no",
								disabled: busyId === item.id, onClick: props.onCancelConfirm,
							}, t("conflict.cancel")),
						]),
					]);
				}
				if (act === "undo") {
					return h("div", { className: "smem-conf-confirm", key: "cf" }, [
						h("div", { key: "what" }, t("conflict.confirmUndo", { file: item.invalidatedFile || item.file })),
						h("div", { className: "smem-ar-hint", key: "hint" }, t("conflict.confirmUndoHint")),
						h("div", { className: "smem-row", key: "btns" }, [
							h("button", {
								type: "button", className: "smem-btn smem-btn-primary", key: "yes",
								disabled: busyId === item.id, onClick: props.onRun,
							}, busyId === item.id ? t("conflict.busy") : t("conflict.confirmYesUndo")),
							h("button", {
								type: "button", className: "smem-btn", key: "no",
								disabled: busyId === item.id, onClick: props.onCancelConfirm,
							}, t("conflict.cancel")),
						]),
					]);
				}
				if (act === "removeRecord") {
					return h("div", { className: "smem-conf-confirm", key: "cf" }, [
						h("div", { key: "what" }, t("conflict.confirmRemove")),
						h("div", { className: "smem-ar-hint", key: "hint" }, t("conflict.confirmRemoveHint")),
						h("div", { className: "smem-row", key: "btns" }, [
							h("button", {
								type: "button", className: "smem-btn smem-btn-danger", key: "yes",
								disabled: busyId === item.id, onClick: props.onRun,
							}, busyId === item.id ? t("conflict.busy") : t("conflict.confirmYesRemove")),
							h("button", {
								type: "button", className: "smem-btn", key: "no",
								disabled: busyId === item.id, onClick: props.onCancelConfirm,
							}, t("conflict.cancel")),
						]),
					]);
				}
				return null;
			}

			function renderItem(item) {
				const bodyOpen = expanded[item.id] === true;
				const body = bodies[item.id] || null;
				const openRec = item.status === "open";
				// 撤销只对「当时真的写过文件」的记录有意义：dismiss / keep_both 没写盘，
				// 给一颗「撤销」只会让人以为要撤掉什么，其实没有。
				const canUndo = !openRec && (item.decision === "invalidate" || !!item.invalidatedFile);
				return h("div", { className: "smem-conf-item", key: item.id }, [
					h("div", { className: "smem-conf-head", key: "head" }, [
						h("span", { className: "smem-badge", key: "kind" }, conflictKindLabel(item.kind)),
						h("span", {
							className: "smem-badge" + (openRec ? " smem-conf-status--open" : ""),
							key: "st",
						}, conflictStatusLabel(item.status)),
						h("span", { className: "smem-muted", key: "at" },
							item.at ? t("conflict.time", { at: item.at }) : t("conflict.noTime")),
						item.truncated ? h("span", { className: "smem-conf-warn", key: "tr" }, t("conflict.truncated")) : null,
						h("span", { className: "smem-conf-id", key: "id" }, String(item.id)),
					]),
					h("div", { className: "smem-conf-files", key: "files" }, [
						h("button", {
							type: "button", className: "smem-btn smem-conf-file", key: "f",
							title: t("conflict.openFileTitle"),
							onClick: function () { props.onOpenFile(item.file); },
						}, String(item.file)),
						item.otherFile ? h("span", { className: "smem-conf-arrow", key: "ar" }, "↔") : null,
						item.otherFile
							? h("button", {
									type: "button", className: "smem-btn smem-conf-file", key: "o",
									title: t("conflict.openFileTitle"),
									onClick: function () { props.onOpenFile(item.otherFile); },
								}, String(item.otherFile))
							: null,
					]),
					item.otherFile ? h("div", { className: "smem-ar-hint", key: "pair" }, t("conflict.pairHint")) : null,
					item.note ? h("div", { className: "smem-ar-hint", key: "note" }, t("conflict.note", { note: item.note })) : null,
					item.decision
						? h("div", { className: "smem-ar-hint", key: "dec" },
								t("conflict.decisionLine", { decision: conflictDecisionLabel(item.decision), at: item.decidedAt || "—" }))
						: null,
					item.invalidatedFile
						? h("div", { className: "smem-ar-hint", key: "inv" },
								t("conflict.invalidatedFile", { file: item.invalidatedFile }))
						: null,
					h("div", { className: "smem-conf-acts", key: "bodybar" }, [
						h("button", {
							type: "button", className: "smem-btn", key: "body",
							disabled: tools.read !== true,
							title: tools.read === true ? undefined : t("conflict.actionMissing", { method: "read" }),
							onClick: tools.read === true ? function () { props.onToggleBodies(item); } : undefined,
						}, bodyOpen ? t("conflict.bodiesHide") : t("conflict.bodiesToggle")),
					]),
					bodyOpen ? h("div", { className: "smem-conf-bodies", key: "bodies" }, renderBodies(item, body)) : null,
					confirmBlock(item),
					h("div", { className: "smem-conf-acts", key: "acts" }, [
						openRec ? actBtn(item, "invalidate", t("conflict.action.invalidate"), " smem-btn-danger-ghost") : null,
						openRec ? actBtn(item, "dismiss", t("conflict.action.dismiss")) : null,
						canUndo ? actBtn(item, "undo", t("conflict.action.undo")) : null,
						actBtn(item, "removeRecord", t("conflict.action.remove"), " smem-btn-danger-ghost"),
					]),
				]);
			}

			return h("div", { className: "smem-tool-panel smem-tool-panel--full smem-conf", key: "conflict" }, [
				h("div", { className: "smem-tool-head", key: "head" }, [
					h("span", { className: "smem-tool-title", key: "t" }, t("conflict.title")),
					// 数字只在**真的取到队列**之后才出现：加载中 / 失败时写「0 条」等于撒谎。
					data ? h("span", {
						className: "smem-tool-badge" + (openN > 0 ? " smem-tool-badge--bad" : ""), key: "n",
					}, t("conflict.openCount", { count: openN })) : null,
					data ? h("span", { className: "smem-muted", key: "total" }, t("conflict.totalCount", { count: totalN })) : null,
					h("button", {
						type: "button", className: "smem-btn", key: "re",
						disabled: props.loading || !!busyId, onClick: props.onReload,
					}, props.loading ? t("conflict.refreshing") : t("conflict.refresh")),
				]),
				h("div", { className: "smem-ar-hint", key: "intro" }, t("conflict.intro")),
				props.error ? h("div", { className: "smem-err", key: "err", role: "alert" }, "⚠ " + props.error) : null,
				missing.length
					? h("div", { className: "smem-ar-hint smem-conf-warn", key: "cap" },
							t("conflict.actionMissingHint", { methods: missing.join(" / ") }))
					: null,
				tools.read !== true
					? h("div", { className: "smem-ar-hint smem-conf-warn", key: "readcap" }, t("conflict.readMissingHint"))
					: null,
				props.loading && !data
					? h("div", { className: "smem-empty", key: "loading" }, t("conflict.loading"))
					: null,
				data && items.length === 0
					? h("div", { className: "smem-empty smem-empty--ok", key: "empty" }, t("conflict.empty"))
					: null,
				data && items.length > 0
					? h("div", { className: "smem-conf-list", key: "list" }, items.map(renderItem))
					: null,
				ignored.length
					? h("div", { className: "smem-ar-hint", key: "ign" }, t("conflict.ignored", { count: ignored.length }))
					: null,
				broken.length
					? h("div", { className: "smem-ar-hint smem-conf-warn", key: "brk" }, t("conflict.broken", { count: broken.length }))
					: null,
				h("div", { className: "smem-ar-hint", key: "foot" }, t("conflict.noApply")),
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
			"tab.conflict": "冲突",

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
			"error.noConflict": "宿主侧还没有 conflict 接口（插件版本较旧）",
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

			// ── 2.0.0 矛盾检测：冲突页签 / 徽标 / 裁决动作 / 失败码出路 ──
			// 文案口径：「失效」不是删除、不是归档；「记录」不是记忆本身；
			// 两种正文的语义按 kind 区分（矛盾 = 新说法 / 旧说法；写失败 = 待写入 / 盘上现行）。
			"header.conflictOpen": "冲突 {count} 待裁决",
			"header.conflictEmpty": "冲突 · 无",
			"header.conflictNotRun": "冲突 · 未载",
			"header.conflictSwitch": "切到冲突页裁决",
			"header.conflictClean": "没有待裁决的冲突",
			"header.conflictMissing": "冲突队列还没载入：点一下打开（失败会给出原因）",
			"conflict.title": "冲突队列",
			"conflict.openCount": "{count} 条待裁决",
			"conflict.totalCount": "共 {count} 条记录",
			"conflict.refresh": "刷新",
			"conflict.refreshing": "刷新中…",
			"conflict.loading": "读取冲突队列…",
			"conflict.intro": "「只标不删」：标失效只往记忆 frontmatter 写一行 invalid_at —— 文件仍在原目录、正文不变、随时可撤销。未裁决的矛盾两方本轮不注入正文（记忆本身仍可读）。",
			"conflict.noApply": "处理完只解除抑制：这里不会把任何一份正文写回记忆（待写内容可能基于过期版本，手工合并更安全）。",
			"conflict.empty": "没有待处理的冲突。矛盾会在自动整理记忆时被发现并落到这里；也可以直接手工编辑记忆。",
			"conflict.broken": "另有 {count} 条记录损坏，已跳过（其余照常显示）",
			"conflict.ignored": "另有 {count} 个文件不是冲突记录，已忽略",
			"conflict.truncated": "已截断",
			"conflict.truncatedHint": "宿主只保留了部分正文（已截断），完整内容在记忆文件里。",
			"conflict.time": "记录于 {at}",
			"conflict.noTime": "记录时间未知",
			"conflict.pairHint": "两条说法互斥：标失效时选哪一方作废。",
			"conflict.note": "说明：{note}",
			"conflict.decisionLine": "裁决：{decision} · {at}",
			"conflict.invalidatedFile": "已标失效：{file}",
			"conflict.openFileTitle": "在文件列表里查看这条记忆",
			"conflict.bodiesToggle": "展开两份正文",
			"conflict.bodiesHide": "收起两份正文",
			"conflict.bodyIncomingContradiction": "新说法（拟保留）",
			"conflict.bodyOnDiskContradiction": "旧说法（拟标失效）",
			"conflict.bodyIncoming": "待写入的那一版",
			"conflict.bodyOnDisk": "盘上现行内容",
			"conflict.bodyEmpty": "（空串）",
			"conflict.bodyLimit": "只显示前 2 KB",
			"conflict.bodyLoading": "读取正文…",
			"conflict.warnings": "读取提示：{list}",
			"conflict.action.invalidate": "标此条失效",
			"conflict.action.dismiss": "标记已裁决",
			"conflict.action.undo": "撤销失效",
			"conflict.action.remove": "删除记录",
			"conflict.actionMissing": "宿主侧还没有 conflict.{method} 接口（插件版本较旧），这个动作已禁用",
			"conflict.actionMissingHint": "版本较旧：缺少 {methods} 接口 —— 对应按钮已禁用。可升级插件，或手工编辑记忆 frontmatter（加 invalid_at）。",
			"conflict.readMissingHint": "版本较旧：没有 conflict.read 接口 —— 正文对照已禁用，仍可裁决。",
			"conflict.confirmInvalidate": "确认把「{file}」标为失效？会往它的 frontmatter 写 invalid_at（可撤销），文件仍在原目录、正文不变。",
			"conflict.confirmInvalidateHint": "只改 frontmatter 里的一行；不删除、不移动文件，也不改 updated。",
			"conflict.confirmUndo": "撤销「{file}」的失效标记？会删掉那行 invalid_at（以及 superseded_by），它重新参与注入。",
			"conflict.confirmUndoHint": "只删我们写的那一行，其他字节不动。",
			"conflict.confirmRemove": "删除这条冲突记录？记录会从队列里消失，不能恢复（记忆文件不受影响）。",
			"conflict.confirmRemoveHint": "只删状态目录里的记录文件；记忆本身一个字节都不动。",
			"conflict.confirmYesInvalidate": "确认标失效",
			"conflict.confirmYesUndo": "确认撤销",
			"conflict.confirmYesRemove": "确认删除记录",
			"conflict.cancel": "取消",
			"conflict.busy": "处理中…",
			"conflict.decision.invalidate": "标失效",
			"conflict.decision.dismiss": "标记已裁决",
			"conflict.decision.keepBoth": "两条都保留",
			"conflict.kind.contradiction": "矛盾",
			"conflict.kind.staleVersion": "版本冲突",
			"conflict.kind.externalChange": "外部改动",
			"conflict.kind.unresolvedMerge": "合并未完成",
			"conflict.status.open": "待裁决",
			"conflict.status.resolved": "已裁决",
			"conflict.status.dismissed": "已忽略",
			"conflict.code.invalid": "记录或文件名不合法：刷新列表后重试；若仍然失败，检查状态目录里的这条记录。",
			"conflict.code.missing": "记录或记忆文件已经不在了：刷新列表再看（记录可能已被别的窗口处理）。",
			"conflict.code.malformed": "这条记录格式损坏：可以删除记录，或手工检查状态目录里的 JSON。",
			"conflict.code.invalidTransition": "这条记录的状态已经变了：刷新列表后按当前状态再操作。",
			"conflict.code.staleVersion": "记忆文件在你打开之后被改过：先刷新列表、确认最新内容再裁决（本次不会覆盖你的改动）。",
			"conflict.code.writeDenied": "宿主拒绝了写入（只读 / 沙箱策略）：把 DSH 的写入权限调宽后重试，或手工在记忆 frontmatter 里加 invalid_at。",
			"conflict.code.unsupported": "宿主没有可用的写入接口：升级插件，或手工在记忆 frontmatter 里加 invalid_at。",
			"conflict.code.ioError": "读写磁盘失败：稍后重试；记录仍是待裁决状态，不会留下半份文件。",
			"conflict.code.unknown": "操作失败（未知错误）：刷新列表再试；若反复失败，查看宿主日志。",
			"conflict.code.detail": "（宿主说明：{detail}）",
			"notice.conflictInvalidated": "已把 {file} 标为失效 —— 文件仍在原处，frontmatter 多了一行 invalid_at，可撤销",
			"notice.conflictDismissed": "已标记为已裁决 —— 没有改任何记忆文件",
			"notice.conflictUndone": "已撤销 {file} 的失效标记 —— 它重新参与注入",
			"notice.conflictRemoved": "已删除冲突记录（记忆文件没动）",
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
			"tab.conflict": "Conflicts",

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
			"error.noConflict": "The host has no conflict API yet (older plugin version)",
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

			// ── 2.0.0 contradiction detection: conflict tab / badge / decisions / error codes ──
			"header.conflictOpen": "Conflicts: {count} pending",
			"header.conflictEmpty": "Conflicts: none",
			"header.conflictNotRun": "Conflicts: not loaded",
			"header.conflictSwitch": "Switch to Conflicts to decide",
			"header.conflictClean": "No conflicts pending a decision",
			"header.conflictMissing": "The conflict queue is not loaded yet: click to open (a failure shows the reason)",
			"conflict.title": "Conflict queue",
			"conflict.openCount": "{count} pending",
			"conflict.totalCount": "{count} records in total",
			"conflict.refresh": "Refresh",
			"conflict.refreshing": "Refreshing…",
			"conflict.loading": "Reading the conflict queue…",
			"conflict.intro": "Mark, never delete: invalidating only writes one invalid_at line into the memory frontmatter — the file stays where it is, the body is untouched, and it can be undone. Both sides of an undecided contradiction stay out of injection this round (the memory itself is still readable).",
			"conflict.noApply": "Deciding only lifts the suppression: no body is ever written back from here (the pending text may be based on a stale version; merging by hand is safer).",
			"conflict.empty": "No conflicts to handle. Contradictions are discovered when memories are auto-organized and land here; you can also edit memories by hand.",
			"conflict.broken": "{count} records are broken and were skipped (the rest are listed normally)",
			"conflict.ignored": "{count} files are not conflict records and were ignored",
			"conflict.truncated": "truncated",
			"conflict.truncatedHint": "The host kept only part of the text (truncated); the full content is in the memory file.",
			"conflict.time": "recorded at {at}",
			"conflict.noTime": "recorded time unknown",
			"conflict.pairHint": "The two statements contradict each other: choose which side becomes invalid.",
			"conflict.note": "Note: {note}",
			"conflict.decisionLine": "Decision: {decision} · {at}",
			"conflict.invalidatedFile": "Marked invalid: {file}",
			"conflict.openFileTitle": "Open this memory in the file list",
			"conflict.bodiesToggle": "Show both bodies",
			"conflict.bodiesHide": "Hide both bodies",
			"conflict.bodyIncomingContradiction": "New statement (to keep)",
			"conflict.bodyOnDiskContradiction": "Old statement (to invalidate)",
			"conflict.bodyIncoming": "The version that was going to be written",
			"conflict.bodyOnDisk": "What is currently on disk",
			"conflict.bodyEmpty": "(empty string)",
			"conflict.bodyLimit": "showing the first 2 KB only",
			"conflict.bodyLoading": "Reading bodies…",
			"conflict.warnings": "Read warnings: {list}",
			"conflict.action.invalidate": "Invalidate this side",
			"conflict.action.dismiss": "Mark as decided",
			"conflict.action.undo": "Undo invalidation",
			"conflict.action.remove": "Delete record",
			"conflict.actionMissing": "The host has no conflict.{method} API yet (older plugin version), so this action is disabled",
			"conflict.actionMissingHint": "Older version: missing {methods} — the matching buttons are disabled. Upgrade the plugin, or edit the memory frontmatter by hand (add invalid_at).",
			"conflict.readMissingHint": "Older version: no conflict.read API — the body comparison is disabled, but decisions still work.",
			"conflict.confirmInvalidate": "Mark “{file}” as invalid? This writes invalid_at into its frontmatter (reversible); the file stays in place and the body is unchanged.",
			"conflict.confirmInvalidateHint": "Only one frontmatter line changes; nothing is deleted or moved, and updated is left alone.",
			"conflict.confirmUndo": "Undo the invalidation of “{file}”? The invalid_at line (and superseded_by) is removed and it takes part in injection again.",
			"conflict.confirmUndoHint": "Only the line we wrote is removed; every other byte stays the same.",
			"conflict.confirmRemove": "Delete this conflict record? It disappears from the queue and cannot be restored (the memory file is not affected).",
			"conflict.confirmRemoveHint": "Only the record file in the state directory is deleted; the memory itself is untouched.",
			"conflict.confirmYesInvalidate": "Confirm invalidation",
			"conflict.confirmYesUndo": "Confirm undo",
			"conflict.confirmYesRemove": "Confirm delete record",
			"conflict.cancel": "Cancel",
			"conflict.busy": "Working…",
			"conflict.decision.invalidate": "invalidated",
			"conflict.decision.dismiss": "decided",
			"conflict.decision.keepBoth": "kept both",
			"conflict.kind.contradiction": "Contradiction",
			"conflict.kind.staleVersion": "Version conflict",
			"conflict.kind.externalChange": "External change",
			"conflict.kind.unresolvedMerge": "Unfinished merge",
			"conflict.status.open": "Pending",
			"conflict.status.resolved": "Decided",
			"conflict.status.dismissed": "Dismissed",
			"conflict.code.invalid": "The record or file name is invalid: refresh the list and try again; if it keeps failing, inspect that record in the state directory.",
			"conflict.code.missing": "The record or memory file is gone: refresh the list (another window may have handled it).",
			"conflict.code.malformed": "This record is malformed: delete the record, or inspect the JSON in the state directory by hand.",
			"conflict.code.invalidTransition": "This record already changed state: refresh the list and act on its current state.",
			"conflict.code.staleVersion": "The memory file changed after you opened it: refresh the list and check the latest content before deciding (your changes are not overwritten).",
			"conflict.code.writeDenied": "The host refused the write (read-only / sandbox policy): widen DSH write permissions and retry, or add invalid_at to the memory frontmatter by hand.",
			"conflict.code.unsupported": "The host has no usable write API: upgrade the plugin, or add invalid_at to the memory frontmatter by hand.",
			"conflict.code.ioError": "Disk read/write failed: retry later; the record stays pending and no half-written file is left behind.",
			"conflict.code.unknown": "The action failed (unknown error): refresh and try again; if it keeps failing, check the host log.",
			"conflict.code.detail": " (host detail: {detail})",
			"notice.conflictInvalidated": "Marked {file} as invalid — the file stays in place, its frontmatter gained one invalid_at line, and this can be undone",
			"notice.conflictDismissed": "Marked as decided — no memory file was changed",
			"notice.conflictUndone": "Undid the invalidation of {file} — it takes part in injection again",
			"notice.conflictRemoved": "Deleted the conflict record (no memory file was touched)",
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
		/**
		 * 「自动做梦」面板 —— 让记忆自己整理一遍（引擎在 宿主侧 lib/autodream.js）。
		 *
		 * 数据全走 remote.autodream（宿主侧的 AutodreamGateway）。两条实现约定：
		 *   1. **轮询而不是等待**。「立即整理」启动后台任务后立刻返回 —— 一趟可能跑
		 *      几分钟，把 remote 调用挂在那儿等会撞上前端超时。进度靠每 2 秒拉一次
		 *      status() 显示。
		 *   2. **不替用户做判断**。触发方式 / 改动方式 / 输入源三件事各自明说代价
		 *      （比如「记忆 + 会话记录」会把私密对话送进模型），默认全是最保守的那一档。
		 */
		function AutodreamPanel(props) {
			// ⚠️ 必须走 stableRemote：真实宿主里 `ctx.get()` 每次返回**新对象**，
			// 而下面那个 effect 依赖 remote —— 直接用会让 effect 无限重跑（issue #3）。
			const remote = stableRemote(props.ctx, "remote.autodream");
			// 注入设置走 memory 那半边（autodream 只管整理那趟）
			const memRemote = stableRemote(props.ctx, "remote.memory");
			const sCfg = react.useState(null); const cfg = sCfg[0], setCfg = sCfg[1];
			const sSt = react.useState(null); const st = sSt[0], setSt = sSt[1];
			const sErr = react.useState(null); const err = sErr[0], setErr = sErr[1];
			const sNotice = react.useState(""); const notice = sNotice[0], setNotice = sNotice[1];
			const sBusy = react.useState(false); const busy = sBusy[0], setBusy = sBusy[1];
			const sReports = react.useState([]); const reports = sReports[0], setReports = sReports[1];
			const sOpen = react.useState(null); const open = sOpen[0], setOpen = sOpen[1];
			const sBody = react.useState(""); const body = sBody[0], setBody = sBody[1];
			const sProv = react.useState(""); const prov = sProv[0], setProv = sProv[1];
			const sModel = react.useState(""); const model = sModel[0], setModel = sModel[1];
			// ── 模型目录 / 回滚点 / 整理记录 / 整理声明 ──
			const sModels = react.useState(null); const models = sModels[0], setModels = sModels[1];
			const sSnaps = react.useState([]); const snaps = sSnaps[0], setSnaps = sSnaps[1];
			const sRuns = react.useState([]); const runs = sRuns[0], setRuns = sRuns[1];
			const sDeclOpen = react.useState(null); const declOpen = sDeclOpen[0], setDeclOpen = sDeclOpen[1];
			const sDeclBody = react.useState(""); const declBody = sDeclBody[0], setDeclBody = sDeclBody[1];
			const sConfirm = react.useState(null); const confirmSnap = sConfirm[0], setConfirmSnap = sConfirm[1];
			const sRbBusy = react.useState(null); const rbBusy = sRbBusy[0], setRbBusy = sRbBusy[1];
			const sRbMsg = react.useState(null); const rbMsg = sRbMsg[0], setRbMsg = sRbMsg[1];
			const sListErr = react.useState(null); const listErr = sListErr[0], setListErr = sListErr[1];
			const sWasRunning = react.useState(false); const wasRunning = sWasRunning[0], setWasRunning = sWasRunning[1];
			// ── 记忆注入设置（memory.getSettings / setSettings）──
			// limits = **当前生效**（模块加载时固化）；pendingLimits = **重启后才生效**。
			// 两个都必须在界面上，且看得出差别 —— 只显示一个就等于骗人。
			const sMemSet = react.useState(null); const memSet = sMemSet[0], setMemSet = sMemSet[1];
			const sLimitsDraft = react.useState(null); const limitsDraft = sLimitsDraft[0], setLimitsDraft = sLimitsDraft[1];
			const sSaveBusy = react.useState(false); const saveBusy = sSaveBusy[0], setSaveBusy = sSaveBusy[1];
			const sReservedNew = react.useState(""); const reservedNew = sReservedNew[0], setReservedNew = sReservedNew[1];
			// ── 1.8.0 侧栏入口开关（客户端行为：改完立刻生效，不需要重启）──
			const sSidebarBusy = react.useState(false); const sidebarBusy = sSidebarBusy[0], setSidebarBusy = sSidebarBusy[1];
			const sSidebarErr = react.useState(""); const sidebarErr = sSidebarErr[0], setSidebarErr = sSidebarErr[1];

			// 派生量放在 effect 之前：下面几个 effect 的依赖数组要在渲染期就能取到值。
			const c = cfg || {};
			const running = !!(st && st.running);
			const last = (st && st.lastResult) || null;
			const route = (st && st.route) || null;
			const rollbackScope = c.rollbackScope === "all" ? "all" : "files";
			// 保留名名单：reserved = 生效清单（含内置两个），reservedExtra = 用户自己声明的那部分。
			// 内置的两个 = 生效清单里不属于 reservedExtra 的那些 —— 不写死名字，host 那边改了这边跟着变。
			const extraReserved = Array.isArray(memSet && memSet.reservedExtra) ? memSet.reservedExtra : [];
			const extraLower = extraReserved.map(function (x) { return String(x).toLowerCase(); });
			const fixedReserved = ((memSet && memSet.reserved) || []).filter(function (n) {
				return extraLower.indexOf(String(n).toLowerCase()) < 0;
			});
			// 默认开：宿主没回 ui 字段（旧版本）或值不是布尔，都按「开」显示。
			const sidebarEntryOn = !(memSet && memSet.ui && memSet.ui.sidebarEntry === false);

			react.useEffect(function () {
				if (!remote) { setErr("remote.autodream 不可用 —— 插件的 宿主侧可能没加载成功，看 DSH 启动日志"); return undefined; }
				let alive = true;
				function pull() {
					callRemote("status", [], function (d) {
						if (!alive || !d) return;
						setSt(d); if (d.config) setCfg(d.config);
						setErr(null);
					}, function (m) { if (alive) setErr(m); });
				}
				pull();
				refreshLists();
				loadModels();
				loadMemSettings();
				const id = setInterval(pull, 2000);
				return function () { alive = false; clearInterval(id); };
			}, [remote]);

			// 一趟跑完（running true → false）就把回滚点 / 整理记录 / 报告刷一遍：
			// 刚跑完那一刻列表还是旧的，等下一次进面板才更新会让人以为没生效。
			react.useEffect(function () {
				if (wasRunning && !running) refreshLists();
				if (wasRunning !== running) setWasRunning(running);
			}, [running]);

			// 模型行的手填框：配置里的 provider/model 变了就同步过去（保存后回填）。
			react.useEffect(function () {
				setProv(c.provider || "");
				setModel(c.model || "");
			}, [c.provider, c.model]);

			/**
			 * 所有 remote 调用的统一出口。
			 *
			 * 契约的硬约束是「每个调用都 try/catch，失败显示错误文案、不白屏」，而
			 * 这里还有第三种失败：宿主侧是旧版本、方法根本不在 remote 对象上
			 * （typeof !== "function"）—— 那会在 `.then` 之前就抛 TypeError。
			 * 三种都收敛到 onErr，面板只会多一行红字。
			 */
			function callRemote(name, args, onOk, onErr) {
				const fn = remote ? remote[name] : null;
				if (typeof fn !== "function") { if (onErr) onErr("宿主侧没有 " + name + " 接口（版本较旧？）"); return; }
				let p;
				try { p = fn.apply(remote, args || []); }
				catch (e) { if (onErr) onErr(detail(e)); return; }
				Promise.resolve(p).then(function (r) { if (onOk) onOk(unwrap(r)); })
					.catch(function (e) { if (onErr) onErr(detail(e)); });
			}

			function patch(p) {
				setErr(null); setNotice("");
				callRemote("setConfig", [p], function (d) {
					if (d && d.config) setCfg(d.config);
				}, function (m) { setErr(m); });
			}

			// ── 注入设置：5 项上限 + 保留名名单 ─────────────────────────────
			// 边界与 host 的 LIMIT_SPECS 一一对应（那边是权威，这里只是提前拦明显笔误）。
			const LIMIT_FIELDS = [
				{ key: "maxResults", label: "一次注入条数", lo: 1, hi: 30, unit: "条" },
				{ key: "maxChars", label: "单条字符上限", lo: 200, hi: 20000, unit: "字符" },
				{ key: "maxBaseline", label: "baseline 名额", lo: 1, hi: 50, unit: "条" },
				{ key: "maxSessionBytes", label: "单会话字节预算", lo: 4096, hi: 524288, unit: "字节" },
				{ key: "staleDays", label: "新鲜度门槛", lo: 0, hi: 365, unit: "天" },
			];

			/** 把一份 limits 对象摊成输入框用的字符串草稿（输入期间允许非法，保存时再校验）。 */
			function limitsDraftOf(src) {
				const out = {};
				for (const f of LIMIT_FIELDS) out[f.key] = src && src[f.key] != null ? String(src[f.key]) : "";
				return out;
			}

			function loadMemSettings(onOk) {
				if (!memRemote || typeof memRemote.getSettings !== "function") return;
				Promise.resolve(memRemote.getSettings()).then(function (res) {
					const d = unwrap(res) || {};
					setMemSet(d);
					setLimitsDraft(limitsDraftOf(d.pendingLimits || d.limits || {}));
					if (onOk) onOk(d);
				}, function (e) { setErr(detail(e)); });
			}

			/** 保存 5 项上限。越界/非整数**本地先拦**（host 也是直接拒绝），别让它白跑一趟。 */
			function saveLimits() {
				if (!memRemote || typeof memRemote.setSettings !== "function") { setErr("宿主侧还没有 setSettings 接口（插件版本较旧）"); return; }
				const draft = limitsDraft || {};
				const limits = {};
				const bad = [];
				for (const f of LIMIT_FIELDS) {
					const raw = String(draft[f.key] == null ? "" : draft[f.key]).trim();
					const n = Number(raw);
					if (raw === "" || !Number.isFinite(n) || !Number.isInteger(n)) { bad.push(f.label + "要整数"); continue; }
					if (n < f.lo || n > f.hi) { bad.push(f.label + " 要在 " + f.lo + "–" + f.hi + " 之间"); continue; }
					limits[f.key] = n;
				}
				if (bad.length) { setErr("没保存 —— " + bad.join("；")); return; }
				setSaveBusy(true); setErr(null); setNotice("");
				Promise.resolve(memRemote.setSettings({ limits: limits })).then(function (out) {
					setSaveBusy(false);
					// setSettings 是 {ok:true, settings, restartRequired} 形状：不要过 unwrap
					// （unwrap 只认 {ok, value}，这里会把 settings 吃掉）。
					if (out && out.ok === false) { setErr(out.error || "保存被拒绝"); return; }
					if (out && out.settings) { setMemSet(out.settings); setLimitsDraft(limitsDraftOf(out.settings.pendingLimits)); }
					else loadMemSettings();
					setNotice("已保存 —— 需重启 DSH 才生效");
				}, function (e) { setSaveBusy(false); setErr(detail(e)); });
			}

			/**
			 * 侧栏入口开关（1.8.0）。
			 *
			 * 顺序是「先写设置、成功后再动槽位」：设置没落盘就不该让界面先变一个样。
			 * 失败只报错、不改任何东西 —— checkbox 的勾选状态由 memSet 派生，于是自动回到原值。
			 * 成功后调 `setSidebarEntry`：**立即**增删侧栏槽位，不刷新、不重启。
			 */
			function saveSidebarEntry(next) {
				if (!memRemote || typeof memRemote.setSettings !== "function") {
					setSidebarErr("宿主侧还没有 setSettings 接口（插件版本较旧）");
					return;
				}
				if (sidebarBusy) return;
				setSidebarBusy(true); setSidebarErr(""); setNotice("");
				Promise.resolve(memRemote.setSettings({ ui: { sidebarEntry: !!next } })).then(function (out) {
					setSidebarBusy(false);
					// 与 saveLimits 同款：setSettings 是 {ok, settings, restartRequired} 形状，不要过 unwrap。
					if (out && out.ok === false) { setSidebarErr(out.error || "保存被拒绝"); return; }
					if (out && out.settings) setMemSet(out.settings);
					else loadMemSettings();
					setSidebarEntry(!!next);
					setNotice(!!next ? "侧栏入口已开启（立即生效）" : "侧栏入口已关闭（设置页入口仍在）");
				}, function (e) { setSidebarBusy(false); setSidebarErr(detail(e)); });
			}

			/**
			 * 保存保留名名单（用户声明的那部分）。
			 *
			 * 两个内置名（memory.md / session-log.md）**不在**这份名单里，也不在界面上给删除入口 ——
			 * 那是生效清单里固定的两个，删不掉。这里管的只是用户自己加的那些。
			 */
			function saveReserved(list) {
				if (!memRemote || typeof memRemote.setSettings !== "function") { setErr("宿主侧还没有 setSettings 接口（插件版本较旧）"); return; }
				setSaveBusy(true); setErr(null); setNotice("");
				Promise.resolve(memRemote.setSettings({ reserved: list })).then(function (out) {
					setSaveBusy(false);
					if (out && out.ok === false) { setErr(out.error || "名单被拒绝"); return; }
					if (out && out.settings) setMemSet(out.settings);
					else loadMemSettings();
					setNotice("保留名名单已保存 —— 需重启 DSH 才生效");
				}, function (e) { setSaveBusy(false); setErr(detail(e)); });
			}

			function addReserved() {
				const name = String(reservedNew || "").trim();
				const extra = Array.isArray(memSet && memSet.reservedExtra) ? memSet.reservedExtra : [];
				if (!name) { setErr("先写一个文件名，例如 project_notes.md"); return; }
				// 与 host 的校验同一套：单个 .md 文件名、不许带路径
				if (!name.endsWith(".md") || name.includes("/") || name.includes("\\") || name.startsWith("..")) {
					setErr("保留名要是一个 .md 文件名（不能带路径）：" + name);
					return;
				}
				if (extra.some(function (x) { return String(x).toLowerCase() === name.toLowerCase(); })) {
					setErr("名单里已经有 " + name + " 了");
					return;
				}
				setReservedNew("");
				saveReserved(extra.concat([name]));
			}

			function removeReserved(name) {
				const extra = Array.isArray(memSet && memSet.reservedExtra) ? memSet.reservedExtra : [];
				saveReserved(extra.filter(function (x) { return x !== name; }));
			}

			/** 报告 / 回滚点 / 整理记录三份列表一起刷。 */
			function refreshLists() {
				callRemote("listReports", [], function (d) {
					setReports(Array.isArray(d) ? d : []);
				}, function () {});
				callRemote("listSnapshots", [], function (d) {
					setSnaps(Array.isArray(d) ? d : []);
				}, function (m) { setListErr(m); });
				callRemote("listRuns", [{ limit: 20 }], function (d) {
					setRuns(Array.isArray(d) ? d : []);
				}, function (m) { setListErr(m); });
			}

			function loadModels() {
				callRemote("listModels", [], function (d) {
					setModels(d && typeof d === "object" && !Array.isArray(d) ? d : { catalogAvailable: false, routes: [], note: "" });
				}, function (m) {
					setModels({ catalogAvailable: false, routes: [], note: "模型目录不可用（" + m + "）—— 请在下面手填 provider 与 model。" });
				});
			}

			function run() {
				setErr(null); setNotice(""); setBusy(true);
				// 契约：runNow({ reason })。reason 只落进 manifest 给人看；门控的豁免
				// 由 宿主侧负责（手动点了按钮就不该被「还没到 N 小时」挡回来）。
				callRemote("runNow", [{ reason: "设置页手动触发" }], function (d) {
					if (d && d.ok === false) setErr(d.error || "启动失败");
					else { setNotice("已开始整理 —— 进度每 2 秒刷新一次"); refreshLists(); }
					setBusy(false);
				}, function (m) { setErr(m); setBusy(false); });
			}

			function openReport(name) {
				if (name === null) { setOpen(null); setBody(""); return; }
				setOpen(name); setBody("载入中…");
				callRemote("readReport", [name], function (d) {
					setBody((d && d.content) || "(空)");
				}, function (m) { setBody("读取失败：" + m); });
			}

			/** 整理声明：点开才拉，拉回来的是 Markdown 原文，直接用 pre 呈现。 */
			function openDecl(runId) {
				if (declOpen === runId) { setDeclOpen(null); setDeclBody(""); return; }
				setDeclOpen(runId); setDeclBody("载入中…");
				callRemote("readDeclaration", [{ runId: runId }], function (d) {
					setDeclBody((d && d.markdown) || "(这一趟没有留下声明正文)");
				}, function (m) { setDeclBody("读取失败：" + m); });
			}

			/**
			 * 回滚。二次确认在 JSX 里（点了「回滚」先展开确认条），这里只负责调用。
			 * 结果就地回显 —— 恢复几个、移走几个、保护快照 id，全都写在同一行里。
			 */
			function doRollback(sp) {
				const scope = rollbackScope;
				setErr(null); setNotice(""); setRbMsg(null); setRbBusy(sp.name);
				callRemote("rollback", [{ snapshotId: sp.name, scope: scope }], function (d) {
					const x = d || {};
					if (x.ok === false) {
						setRbMsg({ bad: true, text: "回滚失败：" + (x.error || "未知原因") });
					} else {
						setRbMsg({ bad: false, text: "已回滚到 " + String(sp.atHuman || "") + "：恢复 " +
							(x.restored == null ? "?" : x.restored) + " 个文件，移走 " + (x.parked == null ? "?" : x.parked) + " 个" +
							// skipped = 想动但没动的（archive/ 已有同名、或回滚点里没那一版）。
							// 不显示它等于「部分成功」被说成「成功」——回滚这种事不能含糊。
							(x.skipped ? "，跳过 " + x.skipped + " 个（详见回滚报告）" : "") +
							(x.protection ? " · 保护快照 " + x.protection : "") + (x.report ? " · 报告 " + x.report : "") });
						setConfirmSnap(null);
					}
					setRbBusy(null);
					refreshLists();
				}, function (m) { setRbMsg({ bad: true, text: "回滚失败：" + m }); setRbBusy(null); });
			}

			// 实际生效路线（契约：route 可能为 null；source==='none' 时 error 里是原因）。
			const routeBad = !route || route.source === "none" || !route.provider || !route.model;
			const routeInfo = routeBad
				? ("实际生效路线：拿不到 —— " + ((route && route.error) || "宿主没能解析出 provider / model（配置留空且取不到会话默认模型）"))
				: ("实际生效路线：" + route.provider + " / " + route.model + (route.fromDefault ? "（跟随默认）" : "（配置指定）"));

			// 模型 <select> 的取值：''=跟随默认；否则是 "provider::model" 的 JSON 编码。
			// 配置里指定的路线万一下架了（不在目录里），也要让它显示出来 —— 否则
			// 下拉框会悄悄跳到「跟随默认」，与下面那行「实际生效路线」自相矛盾。
			const modelRoutes = (models && Array.isArray(models.routes)) ? models.routes : [];
			const modelValue = (c.provider && c.model) ? encodeRoute(c.provider, c.model) : "";
			const modelValueInCatalog = modelValue === "" || modelRoutes.some(function (r) {
				return encodeRoute(r.provider, r.model) === modelValue;
			});

			// 二级分组：**运行 / 设置 / 记录**。
			// 这三类东西原来混在一条滚动里（实测约 1760px）：跑一次要用的、要调的、回头看历史的
			// 全叠在一起，找什么东西都得滚。分段之后每段都落在一屏内（标尺：可视高度约 1000px）。
			// ⚠️ 分段状态放在 Section 里（props.seg），因为头部带的「待重启生效」徽标要能一步切到「设置」。
			const segOf = (props.seg === "settings" || props.seg === "records") ? props.seg : "run";
			const subtab = (name, label, note) => h("button", {
				type: "button", key: name, className: "smem-subtab" + (segOf === name ? " smem-subtab--on" : ""),
				"aria-current": segOf === name ? "true" : "false",
				onClick: function () { if (props.onSeg) props.onSeg(name); },
			}, [label, note ? h("span", { className: "smem-subtab-n", key: "n" }, note) : null]);

			return h("div", { className: "smem-autodream" }, [
				h("div", { className: "smem-subtabs", key: "segs" }, [
					subtab("run", "运行"),
					subtab("settings", "设置"),
					subtab("records", "记录", String(snaps.length + runs.length + reports.length)),
				]),
				segOf === "run" ? h("div", { key: "seg-run" }, [
				h("div", { className: "smem-autodream-sec", key: "top" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("button", {
							type: "button", key: "sw", className: "smem-switch",
							"data-on": c.enabled ? "1" : "0",
							title: c.enabled ? "点击停用" : "点击启用",
							"aria-label": "启用或停用自动做梦",
							onClick: function () { patch({ enabled: !c.enabled }); },
						}),
						h("span", { key: "t", style: { fontWeight: "600" } }, "自动做梦"),
						h("span", { className: "smem-status", key: "s" },
							running ? ("运行中 · " + String((st && st.phase) || "准备中")) : (c.enabled ? "已启用 · 空闲" : "未启用")),
					]),
					h("div", { className: "smem-autodream-note", key: "n" },
						"把记忆目录通读一遍：合并重复的、删掉被推翻的、修索引与断链、把相对日期换成绝对日期。"),
				]),
				h("div", { className: "smem-autodream-sec", key: "mode" }, [
					h("div", { className: "smem-autodream-row", key: "a" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "触发"),
						h(Seg, {
							key: "v", value: c.trigger,
							options: [{ value: "manual", label: "只手动" }, { value: "auto", label: "满足条件自动跑" }],
							onChange: function (v) { patch({ trigger: v }); },
						}),
					]),
					h("div", { className: "smem-autodream-row", key: "b" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "改动方式"),
						h(Seg, {
							key: "v", value: c.apply ? "apply" : "report",
							options: [{ value: "report", label: "只出报告" }, { value: "apply", label: "直接改写（先快照）" }],
							onChange: function (v) { patch({ apply: v === "apply" }); },
						}),
					]),
					h("div", { className: "smem-autodream-row", key: "c" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "输入源"),
						h(Seg, {
							key: "v", value: c.source,
							options: [{ value: "memory", label: "仅记忆目录" }, { value: "memory+sessions", label: "记忆 + 会话记录" }],
							onChange: function (v) { patch({ source: v }); },
						}),
					]),
					h("div", { className: "smem-autodream-note", key: "w" },
						c.source === "memory+sessions"
							? "会解压会话记录做定向搜索 —— 私密对话会进入模型上下文，token 成本也更高。"
							: "只看记忆文件本身，不碰会话记录。"),
					h("div", { className: "smem-autodream-note", key: "w2" },
						c.apply
							? "改写前会自动把整个记忆目录快照一份（memory 上一层 .sage-mem/autodream/snapshots/），改坏可回退。"
							: "只读模式：这一趟连写工具都不会挂给模型，所以它不可能改到任何文件。"),
				]),
				h("div", { className: "smem-autodream-sec", key: "model" }, [
					h("div", { className: "smem-autodream-row", key: "model" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "模型"),
						// 有可枚举的模型目录就给 <select>（首项 = 跟随会话默认，值 "":""）；
						// 目录不可用就退化成两个文本框（契约第六节第 2 条）。
						(models && models.catalogAvailable)
							? h("select", {
									className: "smem-input smem-ad-select", key: "sel",
									value: modelValue,
									onChange: function (e) {
										const v = e.target.value;
										if (!v) { patch({ provider: "", model: "" }); return; }
										const r = decodeRoute(v);
										patch({ provider: r.provider, model: r.model });
									},
								}, [h("option", { key: "__def", value: "" },
										"跟随当前会话默认模型" + ((models.defaultRoute && models.defaultRoute.provider && models.defaultRoute.model)
											? ("（" + String(models.defaultRoute.provider) + " / " + String(models.defaultRoute.model) + "）")
											: ""),
									)].concat(
										modelValueInCatalog ? [] : [h("option", { key: "__cur", value: modelValue }, String(c.provider) + " / " + String(c.model) + "（配置里指定，不在目录中）")],
										modelRoutes.map(function (r) {
											return h("option", { key: String(r.provider) + "/" + String(r.model), value: encodeRoute(r.provider, r.model) },
												r.label || (String(r.provider) + " / " + String(r.model)));
										}),
									))
							: models
								? [
										h("input", { className: "smem-input", key: "p", style: { flex: "1", minWidth: "110px" }, value: prov, placeholder: "provider（留空=跟随默认）", onChange: function (e) { setProv(e.target.value); } }),
										h("input", { className: "smem-input", key: "m", style: { flex: "1", minWidth: "110px" }, value: model, placeholder: "model（留空=跟随默认）", onChange: function (e) { setModel(e.target.value); } }),
										h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "ok", onClick: function () { patch({ provider: prov, model: model }); setNotice("模型已保存"); } }, "保存"),
									]
								: [
										h("span", { className: "smem-status", key: "load" }, "模型目录载入中…"),
										h("button", { type: "button", className: "smem-btn", key: "man", onClick: function () { setModels({ catalogAvailable: false, routes: [], note: "" }); } }, "手填"),
									],
					]),
					h("div", {
						className: "smem-autodream-note" + (routeBad ? " smem-ad-err" : ""),
						key: "route",
					}, (routeBad ? "✗ " : "✓ ") + routeInfo),
					models && models.catalogAvailable === false && models.note
						? h("div", { className: "smem-autodream-note", key: "mnote" }, String(models.note))
						: null,
				]),
				h("div", { className: "smem-autodream-sec", key: "run" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("button", {
							type: "button", className: "smem-btn smem-btn-primary", key: "go",
							disabled: busy || running || !remote,
							onClick: run,
						}, running ? "正在整理…" : "立即整理"),
						h("span", { className: "smem-status", key: "s" },
							running
								? ("已跑 " + ((st && st.steps && st.steps.length) || 0) + " 轮 · " + String((st && st.phase) || ""))
								: (st && st.hoursSince != null ? ("距上次整理 " + st.hoursSince.toFixed(1) + " 小时") : "从未整理过")),
					]),
					running && st && st.steps && st.steps.length
						? h("div", { className: "smem-autodream-note", key: "prog" }, st.steps.map(function (x) {
								return "第 " + x.step + " 轮：" + (x.tools.length ? x.tools.join("、") : "结束");
							}).join("　·　"))
						: null,
					last
						? h("div", { className: "smem-status", key: "last" },
								"上次 " + String(last.atHuman || "") + " · " + (last.ok
									? ("成功" + (last.apply ? "，改写了 " + ((last.touched || []).length) + " 个文件" : "（只出报告）") +
										" · 结构问题 " + last.problemsBefore + " → " + last.problemsAfter +
										" · token " + last.tokensIn + " / " + last.tokensOut)
									: ("失败：" + (last.error || "未知"))) +
								// 1.9.2：残篇必须在状态行上就能看见 —— 只写「成功」正是 10-25 那次误判的来源。
								(last.ok && last.truncated ? " · ⚠ 报告被截断（残篇）" : "") +
								(last.ok && !last.truncated && last.retries ? (" · 零正文重试 " + last.retries + " 次后补齐") : "") +
								(last.continuations ? (" · 续写 " + last.continuations + " 轮") : "") +
								(last.report ? " · 报告 " + last.report : ""))
						: null,
				]),
				]) : null,
				segOf === "settings" ? h("div", { key: "seg-set" }, [
				// 1.8.0：侧栏入口开关。默认开；关掉只影响侧栏那个图标，
				// 「设置 → 记忆管理」这个入口永远在（它注册在 80-apply，和这个开关无关）。
				h("div", { className: "smem-autodream-sec", key: "sidebar-entry" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "侧栏入口"),
						h("span", { className: "smem-status", key: "s" }, sidebarEntryOn ? "已开启" : "已关闭"),
					]),
					h("div", { className: "smem-autodream-note", key: "n" },
						"在 DSH 侧栏显示「记忆管理」图标，点它把中央主区切到本页。默认开启；关闭后「设置 → 记忆管理」这个入口仍然保留。改动立即生效，不需要重启。"),
					h("label", { className: "smem-check", key: "row" }, [
						h("input", {
							type: "checkbox", key: "c",
							checked: sidebarEntryOn,
							disabled: sidebarBusy,
							onChange: function (e) { saveSidebarEntry(!!(e.target && e.target.checked)); },
						}),
						h("span", { key: "l" }, "在侧栏显示「记忆管理」入口"),
					]),
					sidebarErr ? h("div", { className: "smem-autodream-note smem-ad-warn", key: "err" }, sidebarErr) : null,
				]),
				// 自动归档那一段（三档策略 + 三个阈值）**已挪到「自动归档」页签**（v0.9.9）：
				// 归档是确定性规则、不调模型，和这一页的「让模型整理」不是一件事；
				// 同一件事只在一处设定，这里不再重复摆一份。
				h("div", { className: "smem-autodream-sec", key: "limits" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "记忆注入参数"),
						memSet && memSet.restartRequired
							? h("span", { className: "smem-ad-badge smem-ad-badge--warn", key: "w" }, "有改动待生效")
							: null,
					]),
					memSet && memSet.restartRequired
						? h("div", { className: "smem-autodream-note smem-ad-warn", key: "rw" },
								"⚠ 这些值在 DSH 启动时就固化了 —— 要重启 DSH 才生效。下面每行都写清「当前 → 重启后」。")
						: h("div", { className: "smem-autodream-note", key: "rn" },
								"这些值在 DSH 启动时固化：保存后要重启 DSH 才生效 —— 所以每行都会标出「当前生效」与「重启后」。"),
					// 五个参数排两列（一行两个）：同样的信息，行数少一半，扫读反而更清楚。
					h("div", { className: "smem-ad-grid2", key: "grid" }, LIMIT_FIELDS.map(function (f) {
						const cur = memSet && memSet.limits ? memSet.limits[f.key] : null;
						const pend = memSet && memSet.pendingLimits ? memSet.pendingLimits[f.key] : null;
						const diff = cur != null && pend != null && cur !== pend;
						return h("div", { className: "smem-ad-field", key: f.key }, [
							h("span", { className: "smem-autodream-key", key: "k", title: f.unit + " · 范围 " + f.lo + "–" + f.hi }, f.label),
							h("input", {
								className: "smem-num", key: "v", type: "number",
								min: String(f.lo), max: String(f.hi),
								title: "范围 " + f.lo + "–" + f.hi + " " + f.unit,
								value: limitsDraft && limitsDraft[f.key] != null ? limitsDraft[f.key] : "",
								onChange: function (e) {
									const nx = Object.assign({}, limitsDraft);
									nx[f.key] = e.target.value;
									setLimitsDraft(nx);
								},
							}),
							diff
								? h("span", { className: "smem-ad-badge smem-ad-badge--warn", key: "d" }, "当前 " + String(cur) + " → 重启后 " + String(pend))
								: h("span", { className: "smem-status", key: "d" }, "范围 " + f.lo + "–" + f.hi + (cur == null ? "" : (" · 当前生效 " + String(cur)))),
						]);
					})),
					h("div", { className: "smem-autodream-row", key: "save" }, [
						h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "s", disabled: saveBusy, onClick: saveLimits }, saveBusy ? "保存中…" : "保存注入参数"),
						h("span", { className: "smem-status", key: "n" }, "保存后需重启 DSH 才生效"),
					]),
				]),
				h("div", { className: "smem-autodream-sec", key: "reserved" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "保留名保护名单"),
						h("span", { className: "smem-status", key: "c" }, "名单里的文件不参与注入"),
					]),
					h("div", { className: "smem-autodream-note", key: "n" },
						"内置的两个固定不可删；下面可以再加自己的（只写文件名，不要带路径）。改完需重启 DSH 才生效。"),
					h("div", { className: "smem-raw-names", key: "fixed" }, fixedReserved.map(function (n) {
						return h("span", { className: "smem-chip smem-chip--fixed", key: n, title: "内置固定，不可删除" }, n + " · 固定");
					})),
					h("div", { className: "smem-raw-names", key: "extra" },
						extraReserved.length
							? extraReserved.map(function (n) {
									return h("span", { className: "smem-chip", key: n, "data-on": "1" }, [
										n,
										h("button", { type: "button", className: "smem-chip-x", key: "x", title: "从名单里移除 " + n, onClick: function () { removeReserved(n); } }, "✕"),
									]);
								})
							: h("span", { className: "smem-status", key: "none" }, "（还没有自己加的保留名）")),
					h("div", { className: "smem-autodream-row", key: "add" }, [
						h("input", {
							className: "smem-input", key: "i",
							style: { flex: "1", minWidth: "150px" },
							value: reservedNew,
							placeholder: "例如 project_notes.md（要 .md 文件名）",
							onChange: function (e) { setReservedNew(e.target.value); },
						}),
						h("button", { type: "button", className: "smem-btn", key: "a", disabled: saveBusy, onClick: addReserved }, "加入名单"),
					]),
				]),
				h("details", { className: "smem-autodream-adv", key: "adv", open: true }, [
					h("summary", { key: "s" }, "高级设置"),
					h("div", { key: "d" }, [
						c.trigger === "auto" ? h("div", { className: "smem-autodream-row", key: "gate" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, "自动触发"),
							h("span", { className: "smem-status", key: "a" }, "距上次 ≥"),
							h("input", { className: "smem-num", key: "h", type: "number", min: "1", max: "720", value: c.minHours, onChange: function (e) { patch({ minHours: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "b" }, "小时，且期间 ≥"),
							h("input", { className: "smem-num", key: "m", type: "number", min: "1", max: "200", value: c.minSessions, onChange: function (e) { patch({ minSessions: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "c" }, "个会话有更新"),
						]) : null,
						h("div", { className: "smem-autodream-row", key: "steps" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, "最多轮数"),
							h("input", { className: "smem-num", key: "v", type: "number", min: "1", max: "80", value: c.maxSteps, onChange: function (e) { patch({ maxSteps: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "s" }, "一轮 = 一次模型调用 + 它要的工具调用"),
						]),
						// 1.9.2：单次输出上限（原写死 4096）。思考型模型下 4096 会让收尾轮只剩思考、零正文。
						h("div", { className: "smem-autodream-row", key: "maxout" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, "单次输出上限"),
							h("input", { className: "smem-num", key: "v", type: "number", min: "1024", max: "131072", value: c.maxOutputTokens, onChange: function (e) { patch({ maxOutputTokens: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "s" }, "token（思考与正文共用；报告残篇时先调它）"),
						]),
						h("div", { className: "smem-autodream-row", key: "keep" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, "保留快照"),
							h("input", { className: "smem-num", key: "v", type: "number", min: "1", max: "50", value: c.maxSnapshotKeep, onChange: function (e) { patch({ maxSnapshotKeep: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "s" }, "份"),
						]),
						h("div", { className: "smem-status", key: "paths" }, "配置与状态：" + ((st && st.paths && st.paths.configPath) || "—")),
					]),
				]),
				]) : null,
				// ── 回滚点（新）──────────────────────────────────────────────
				// 只改这一个文件、只用既有 h() 写法；数据全走 remote.autodream。
				segOf === "records" ? h("div", { key: "seg-rec" }, [
				h("div", { className: "smem-autodream-sec", key: "snap" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "回滚点"),
						h("span", { className: "smem-status", key: "c" }, String(snaps.length) + " 个"),
						h("button", { type: "button", className: "smem-btn", key: "rf", onClick: refreshLists }, "刷新"),
					]),
					h("div", { className: "smem-autodream-row", key: "scope" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "回滚范围"),
						h(Seg, {
							key: "v", value: rollbackScope,
							options: [{ value: "files", label: "只恢复本次动过的文件" }, { value: "all", label: "整目录回到该时点" }],
							onChange: function (v) { patch({ rollbackScope: v }); },
						}),
					]),
					h("div", { className: "smem-autodream-note", key: "n" },
						"回滚前会自动把整个记忆目录再存一份保护快照 —— 所以回滚本身也能再退回来。多出来的文件只移进 archive/，不删除。"),
					snaps.length === 0
						? h("div", { className: "smem-status", key: "e" }, "还没有回滚点 —— 用「直接改写」跑过一次就有了。")
						: h("div", { className: "smem-autodream-list", key: "l" }, snaps.slice(0, 15).map(function (sp) {
								const label = sp.legacy ? "旧版快照" : (sp.runId ? ("运行 " + String(sp.runId)) : "回滚保护");
								return h("div", { className: "smem-ad-wrap", key: String(sp.name) }, [
									h("div", { className: "smem-ad-snap", key: "row" }, [
										h("div", { className: "smem-ad-main", key: "m" }, [
											h("div", { key: "l1" }, String(sp.atHuman || "") + " · " + (sp.files == null ? "?" : sp.files) + " 个文件"),
											h("div", { className: "smem-ad-sub", key: "l2" }, label + " · " + String(sp.name || "")),
										]),
										sp.legacy ? h("span", { className: "smem-ad-badge smem-ad-badge--legacy", key: "lg" }, "旧版") : null,
										confirmSnap === sp.name
											? null
											: h("button", {
													type: "button", className: "smem-btn", key: "go",
													disabled: rbBusy !== null,
													onClick: function () { setRbMsg(null); setConfirmSnap(sp.name); },
												}, "回滚"),
									]),
									confirmSnap === sp.name
										? h("div", { className: "smem-ad-confirm", key: "cf" }, [
												h("div", { key: "t", style: { fontWeight: "600" } }, "确认回滚到 " + String(sp.atHuman || "") + "？"),
												h("div", { key: "d" }, "范围：" + (rollbackScope === "all"
													? "整目录回到该时点 —— 快照里没有、当前目录里有的文件会被移进 archive/（不删除）"
													: "只恢复这次运行动过的文件 —— 该次新建的移进 archive/，该次归档的移回顶层") +
													"。回滚前会先存一份保护快照，所以这一步本身也能退。"),
												h("div", { className: "smem-autodream-row", key: "acts" }, [
													h("button", {
														type: "button", className: "smem-btn smem-btn-danger", key: "yes",
														disabled: rbBusy === sp.name,
														onClick: function () { doRollback(sp); },
													}, rbBusy === sp.name ? "回滚中…" : "确认回滚"),
													h("button", { type: "button", className: "smem-btn", key: "no", onClick: function () { setConfirmSnap(null); } }, "取消"),
												]),
											])
										: null,
								]);
							})),
					rbMsg ? h("div", { className: "smem-ad-rb " + (rbMsg.bad ? "smem-ad-err" : "smem-ok"), key: "rb" }, (rbMsg.bad ? "⚠ " : "✓ ") + rbMsg.text) : null,
				]),
				// ── 整理声明（新）──────────────────────────────────────────
				h("div", { className: "smem-autodream-sec", key: "runs" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "整理记录"),
						h("span", { className: "smem-status", key: "c" }, String(runs.length) + " 条"),
						h("button", { type: "button", className: "smem-btn", key: "rf", onClick: refreshLists }, "刷新"),
					]),
					h("div", { className: "smem-autodream-note", key: "n" },
						"每一趟都留一份整理声明：改了什么、为什么改、哪些想法被拒了。点一条看全文。"),
					runs.length === 0
						? h("div", { className: "smem-status", key: "e" }, "还没有整理记录 —— 跑一次就有了。")
						: h("div", { className: "smem-autodream-list", key: "l" }, runs.slice(0, 15).map(function (rn) {
								return h("div", { className: "smem-ad-wrap", key: String(rn.runId) }, [
									h("button", {
										type: "button", className: "smem-ad-run",
										"data-on": declOpen === rn.runId ? "1" : "0",
										onClick: function () { openDecl(rn.runId); },
									}, [
										h("span", { key: "t" }, String(rn.atHuman || "")),
										h("span", { className: "smem-ad-badge", key: "m" }, rn.mode === "apply" ? "直接改写" : "只出报告"),
										h("span", { key: "c" }, "改 " + (rn.changeCount == null ? "?" : rn.changeCount) + " 条"),
										rn.report ? h("span", { className: "smem-ad-sub", key: "r" }, "报告 " + String(rn.report)) : null,
										rn.rolledBackAt
											? h("span", { className: "smem-ad-badge smem-ad-badge--warn", key: "rb" },
													"已回滚" + (rn.rolledBackAtHuman ? (" · " + String(rn.rolledBackAtHuman)) : ""))
											: null,
										h("span", { className: "smem-ad-sub", key: "x" }, declOpen === rn.runId ? "收起" : "看声明"),
									]),
									declOpen === rn.runId
										? h("pre", { className: "smem-ad-md", key: "body" }, declBody)
										: null,
								]);
							})),
				]),
				h("div", { className: "smem-autodream-sec", key: "rep" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "历史报告"),
						h("span", { className: "smem-status", key: "c" }, String(reports.length) + " 份"),
					]),
					reports.length === 0
						? h("div", { className: "smem-status", key: "e" }, "还没有报告 —— 跑一次就有了。报告写在 memory/autodream/ 下，不会混进记忆列表。")
						: h("div", { className: "smem-autodream-list", key: "l" }, reports.slice(0, 12).map(function (r) {
								return h("button", {
									type: "button", key: r.name, className: "smem-report",
									"data-on": open === r.name ? "1" : "0",
									onClick: function () { openReport(open === r.name ? null : r.name); },
								}, [
									h("span", { key: "t" }, String(r.atHuman || "") + " · " + String(r.name) + " · " + fmtSize(r.bytes)),
									r.legacy ? h("span", { className: "smem-ad-badge smem-ad-badge--legacy", key: "lg", style: { marginLeft: "6px" } }, "旧版") : null,
									h("span", { className: "smem-ad-sub", key: "x", style: { marginLeft: "6px" } }, open === r.name ? "收起" : "查看"),
								]);
							})),
					open && body ? h("pre", { className: "smem-report-pre", key: "body" }, body) : null,
				]),
				]) : null,
				listErr && !err ? h("div", { className: "smem-err", key: "lerr" }, "⚠ " + listErr) : null,
				err ? h("div", { className: "smem-err", key: "err" }, "⚠ " + err) : null,
				notice && !err ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
			]);
		}

		/**
		 * 「自动归档」面板 —— 独立成一屏（v0.9.9）。
		 *
		 * 为什么独立出来（用户 2026-10-11）：这一块原来塞在「自动做梦 → 设置」里，
		 * 他自己的原话是「扔这里连我都找不到」。而且它确实是**另一件事**：
		 *   自动做梦 = 让模型读记忆、整理、改写（要调模型、有 token 成本）
		 *   自动归档 = 按「多久没被注入过」把记忆移进 archive/（纯确定性规则、不调模型）
		 * 混在模型那套设置里，既难找、也容易让人以为归档会花钱。
		 *
		 * 这一页管两件事：
		 *   1. **三档策略**：关闭 / 只出报告 / 满足条件自动跑
		 *   2. **三个阈值**（项目 / 参考 / 用户）：多少天没被注入就算闲置
		 *
		 * 数据全走 `remote.autodream` 的 `getConfig` / `setConfig` —— 阈值本来就在配置里
		 * （`lib/autodream/config.js` 的 archiveAfterDays*），只是以前**界面够不着**。
		 * 所以这一版没有新增任何 remote。
		 *
		 * 两处诚实标注：阈值**存完立即生效**（不经过模块加载期固化，与注入参数不同）；
		 * 保存后**一定回读**（`setConfig` 对非法值是「忽略并保留原值」，只信返回值会骗人）。
		 */
		function ArchiveSettingsPanel(props) {
			const remote = stableRemote(props.ctx, "remote.autodream");
			const sCfg = react.useState(null); const cfg = sCfg[0], setCfg = sCfg[1];
			const sDraft = react.useState(null); const draft = sDraft[0], setDraft = sDraft[1];
			const sErr = react.useState(null); const err = sErr[0], setErr = sErr[1];
			const sNotice = react.useState(""); const notice = sNotice[0], setNotice = sNotice[1];
			const sBusy = react.useState(false); const busy = sBusy[0], setBusy = sBusy[1];

			const TH_KEYS = ["archiveAfterDaysProject", "archiveAfterDaysReference", "archiveAfterDaysUser"];
			const TH_LABEL = { archiveAfterDaysProject: "项目", archiveAfterDaysReference: "参考", archiveAfterDaysUser: "用户" };
			const TH_HINT = {
				archiveAfterDaysProject: "project_* 连续这么多天没被注入 → 进候选",
				archiveAfterDaysReference: "reference_* 同上（资料一般比项目留得久）",
				archiveAfterDaysUser: "user_* 同上（人设这类动它要格外谨慎）",
			};

			/** 阈值 → 输入框草稿。存成字符串：number input 清空时立刻变 0 会很难用。 */
			const draftOf = function (c) {
				const src = c || {};
				const out = {};
				for (const k of TH_KEYS) out[k] = String(src[k] == null ? "" : src[k]);
				return out;
			};

			react.useEffect(function () {
				if (!remote || typeof remote.getConfig !== "function") {
					setErr("宿主侧没有 autodream 配置接口（插件版本较旧）");
					return;
				}
				remote.getConfig()
					.then(function (r) {
						const d = unwrap(r);
						const c = d && d.config ? d.config : null;
						if (!c) { setErr("读不出自动做梦配置"); return; }
						setCfg(c);
						setDraft(draftOf(c));
					})
					.catch(function (e) { setErr("读配置失败：" + ((e && e.message) || e)); });
			}, []);

			const c = cfg || {};
			const mode = autoArchiveOf(c.autoArchive);

			/**
			 * 存完回读。
			 * @param {Object} patch 要写的配置
			 * @param {string} okMsg 成功提示
			 * @param {Function} failOf (got) => string|null —— 返回 null 表示这次改动真的落进去了
			 */
			function save(patch, okMsg, failOf) {
				setBusy(true); setErr(null); setNotice("");
				remote.setConfig(patch)
					.then(function () { return remote.getConfig(); })
					.then(function (r) {
						const d = unwrap(r);
						const got = d && d.config ? d.config : null;
						if (got) { setCfg(got); setDraft(draftOf(got)); }
						const bad = failOf(got);
						if (!bad) { setNotice(okMsg); return; }
						setErr("保存没生效：" + bad + "。setConfig 对非法值会忽略并保留原值 —— 请重试，或看 DSH 启动日志。");
					})
					.catch(function (e) { setErr("保存失败：" + ((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			function saveMode(v) {
				save({ autoArchive: v }, "自动归档已设为「" + AUTO_ARCHIVE_LABEL[v] + "」", function (got) {
					const g = got ? autoArchiveOf(got.autoArchive) : null;
					return g === v ? null : ("配置里仍是「" + (g ? AUTO_ARCHIVE_LABEL[g] : "读不出来") + "」");
				});
			}

			/** 越界/非整数**本地先拦**（host 也会拒），别让它白跑一趟。 */
			function saveThresholds() {
				const d = draft || {};
				const patch = {};
				for (const k of TH_KEYS) {
					const n = Number(d[k]);
					if (!Number.isFinite(n) || n < 1 || n > 3650) {
						setErr(TH_LABEL[k] + "的阈值要是 1~3650 之间的天数（现在是「" + d[k] + "」）");
						return;
					}
					patch[k] = Math.round(n);
				}
				save(patch, "归档条件已保存", function (got) {
					const bad = TH_KEYS.filter(function (k) { return !got || Number(got[k]) !== patch[k]; });
					if (!bad.length) return null;
					return bad.map(function (k) { return TH_LABEL[k] + " 仍是 " + (got ? got[k] : "读不出来"); }).join("、");
				});
			}

			return h("div", { }, [
				// ── ① 它做什么（这一屏存在的理由写在最前面）──
				h("div", { className: "smem-autodream-sec", key: "what" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "自动归档做什么"),
					]),
					h("div", { className: "smem-autodream-note", key: "p1" },
						"闲置太久没被注入过的记忆，会被移进 archive/ —— 不删除，随时能恢复。这一页决定「多久算闲置」，以及要不要真的动手。"),
					h("div", { className: "smem-autodream-note", key: "p2" },
						"它不调模型：候选完全按访问台账的天数算，同一份输入每次算出来都一样。"),
					h("div", { className: "smem-autodream-note", key: "p3" },
						"想现在看看会被收走哪些：文件列表 →「工具 ▾」→ 归档候选。"),
				]),
				// ── ② 三档策略 ──
				h("div", { className: "smem-autodream-sec", key: "mode" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "自动归档"),
						h(Seg, {
							key: "v", value: mode,
							options: [
								{ value: "off", label: AUTO_ARCHIVE_LABEL.off },
								{ value: "report", label: AUTO_ARCHIVE_LABEL.report },
								{ value: "auto", label: AUTO_ARCHIVE_LABEL.auto },
							],
							onChange: function (v) { if (v !== mode) saveMode(v); },
						}),
						busy ? h("span", { className: "smem-status", key: "s" }, "保存中…") : null,
					]),
					h("div", { className: "smem-autodream-note", key: "cost" }, AUTO_ARCHIVE_COST[mode]),
					mode === "auto" && !c.apply
						? h("div", { className: "smem-autodream-note smem-ad-warn", key: "deg" },
								"注意：「自动做梦 → 改动方式」现在是只出报告 —— 这一档会自动降级成只出报告，不会动文件。")
						: null,
				]),
				// ── ③ 三个阈值 ──
				h("div", { className: "smem-autodream-sec", key: "th" }, [
					h("div", { className: "smem-autodream-row", key: "h" }, [
						h("span", { key: "t", style: { fontWeight: "600", fontSize: "12.5px" } }, "闲置多少天算可以归档"),
					]),
					draft
						? h("div", { key: "rows" }, TH_KEYS.map(function (k) {
								return h("div", { className: "smem-autodream-row", key: k }, [
									h("span", { className: "smem-autodream-key", key: "k" }, TH_LABEL[k]),
									h("input", {
										className: "smem-input smem-num", key: "i", type: "number", min: 1, max: 3650,
										value: draft[k],
										onChange: function (e) {
											const nx = Object.assign({}, draft);
											nx[k] = e.target.value;
											setDraft(nx);
										},
									}),
									h("span", { className: "smem-muted", key: "u" }, TH_HINT[k]),
								]);
							}))
						: h("div", { className: "smem-muted", key: "loading" }, "读配置中…"),
					h("div", { className: "smem-autodream-row", key: "btns" }, [
						h("button", {
							type: "button", className: "smem-btn smem-btn-primary", key: "save",
							disabled: busy || !draft, onClick: saveThresholds,
						}, busy ? "保存中…" : "保存归档条件"),
						h("span", { className: "smem-muted", key: "n" }, "保存即生效，不用重启 DSH"),
					]),
					h("div", { className: "smem-autodream-note", key: "note" },
						"天数按访问台账算（这条记忆上次被注入给模型是什么时候）。feedback_* 永不入选；锁定的记忆也不会被选中。"),
				]),
				err ? h("div", { className: "smem-err", key: "err" }, "⚠ " + err) : null,
				notice ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
			]);
		}
		// ── 文件列表这一屏（1.5.3 从 Section 里抽出；D23 计划的 72 片）──────────
		// 只负责「按状态/筛选把卡片摆出来 + 四种空态」；状态、筛选语义、动作回调全部由 Section 传。
		// 抽出的判据：它是 Section 里最大的一块纯渲染，而卡片组件（Card / ArchivedCard）本来就在 50 共享层。
		function FilesView(props) {
			const { loading, totalCount, openAdd, createIndexSkeleton, statusFilter, setStatusFilter, items, archiveItems, filtered, setTypeFilter, setTagFilter, setQuery, busy, restoring, archDelete, archEdit, archLoad, archSaving, archText, setArchText, openArchEdit, saveArchEdit, cancelArchEdit, restoreFile, setArchDelete, setArchEdit, deleteArchivedFile, expanded, deleting, archiving, archiveReason, setArchiveReason, setArchiving, setDeleting, confirmArchive, toggleLock, openEdit, confirmDelete } = props;
			let filesView;
			if (loading && totalCount === 0) {
				filesView = h("div", { className: "smem-skeleton", key: "loading", "data-loading": "1" }, [0, 1, 2].map(function (i) {
					return h("div", { className: "smem-skeleton-row", key: i });
				}));
			} else if (totalCount === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, t("files.emptyTitle")),
					h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "add", onClick: openAdd }, t("action.add")),
					h("button", { type: "button", className: "smem-btn", key: "idx", title: t("files.skeletonTitle"), onClick: createIndexSkeleton }, t("files.skeleton")),
				]);
			} else if (statusFilter === "archived" && archiveItems.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, t("files.archiveEmpty")),
					h("button", { type: "button", className: "smem-btn", key: "back", onClick: function () { setStatusFilter("active"); } }, t("files.backToFiles")),
				]);
			} else if (statusFilter === "active" && items.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, t("files.activeEmpty", { count: archiveItems.length })),
					h("button", { type: "button", className: "smem-btn", key: "go", onClick: function () { setStatusFilter("archived"); } }, t("files.goArchived")),
				]);
			} else if (filtered.length === 0) {
				filesView = h("div", { className: "smem-empty", key: "empty" }, [
					h("div", { key: "t" }, t("files.noMatch")),
					h("button", { type: "button", className: "smem-btn", key: "clear", onClick: function () { setStatusFilter("all"); setTypeFilter([]); setTagFilter([]); setQuery(""); } }, t("filter.clear")),
				]);
			} else {
				const list = h("div", { className: "smem-list", key: "list" }, filtered.map(function (it) {
					if (it.archived === true) {
						return h(ArchivedCard, {
							key: it.file,
							item: it,
							busy: busy,
							restoring: restoring === it.file,
							deleting: archDelete === it.file,
							editing: archEdit === it.file,
							loading: archLoad && archEdit === it.file,
							saving: archSaving && archEdit === it.file,
							text: archText,
							onText: setArchText,
							onEdit: openArchEdit,
							onSave: saveArchEdit,
							onCancel: cancelArchEdit,
							onRestore: restoreFile,
							// 两个「危险动作的确认」互斥：问到一半又去改文本，界面就会同时摆两个确认条。
							onAskDelete: function (file) { setArchDelete(file); setArchEdit(null); },
							onCancelDelete: function () { setArchDelete(null); },
							onConfirmDelete: deleteArchivedFile,
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
						onToggleLock: toggleLock,
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
							h("div", { className: "smem-ar-banner", key: "banner" }, t("files.archiveIntro")),
							list,
						]
					: list;
			}

			return filesView;
		}

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
			// 「彻底删除」的二次确认：正在问哪一条（null = 没在问）。
			// 与 editing 互斥 —— 同一张卡上不能既在改又在删。
			const sArchDelete = react.useState(null);
			const archDelete = sArchDelete[0], setArchDelete = sArchDelete[1];
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
				if (!remote || typeof remote.readRaw !== "function" || typeof remote.writeRaw !== "function") {
					setError(t("error.noRaw"));
					return;
				}
				setBusy(true);
				// 先读再写：**已有索引绝不覆盖**。readRaw 对不存在的文件会 reject，正好当探针。
				remote.readRaw("MEMORY.md").then(function () {
					setBusy(false);
					setNotice(t("notice.indexExists"));
				}, function () {
					return remote.writeRaw("MEMORY.md", INDEX_SKELETON).then(function (res) {
						const out = unwrap(res);
						setBusy(false);
						if (out && out.ok === false) { setError(out.error || t("error.skeletonFailed")); return; }
						setNotice(t("notice.indexCreated"));
						load();
					});
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
				remote.writeFile(safeName, content)
					.then(function (r) {
						// host 侧对保留名 / 非字符串内容 / 超限一律返回 { ok: false, error }，不再抛异常。
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
			 * 第二个参数是归档代次（列表上看到的 `archivedAt`）：宿主拿它核对「要删的是不是
			 * 我确认过的那一版」。不传它会变成「按名字删」—— 名字底下的内容刚才可能已经换人了。
			 */
			function deleteArchivedFile(file) {
				if (typeof remote.deleteArchived !== "function") {
					setError(t("error.noDeleteArchived"));
					return;
				}
				const item = archiveItems.filter(function (x) { return x.file === file; })[0];
				const stamp = (item && item.archivedAt) || "";
				setBusy(true); setError(null); setNotice("");
				remote.deleteArchived(file, stamp)
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
					setError(t("error.noWriteArchived"));
					return;
				}
				setArchSaving(true); setError(null); setNotice("");
				// 原样交回：不 trim、不补 frontmatter、不做任何「智能」处理。
				remote.writeArchived(file, archText)
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || t("error.saveRejected")); return; }
						setArchEdit(null);
						setNotice(t("notice.saved", { file: file }));
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setArchSaving(false); });
			}

			function cancelArchEdit() { setArchEdit(null); setArchText(""); }

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
						setError(t("error.readFailed", { file: name, message: msg }));
						setRawLoading(false);
						setRawName(null);
					});
			}

			function saveRaw(name) {
				if (typeof remote.writeRaw !== "function") { setError(t("error.noWriteRaw")); return; }
				setRawBusy(true); setError(null); setNotice("");
				// 原样交回：不 trim、不补 frontmatter、不做任何「智能」处理。
				remote.writeRaw(name, rawText)
					.then(function (r) {
						if (r && r.ok === false) { setError(r.error || t("error.saveRejected")); return; }
						setNotice(t(rawIsNew ? "notice.rawNew" : "notice.saved", { file: name }));
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
				expanded: expanded, deleting: deleting, archiving: archiving,
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

		// ── 侧栏入口（1.8.0）─────────────────────────────────────────────
		// 宿主侧栏的官方契约是两个槽位：
		//   `sidebar.panellist`（list 槽）：只画一个 size 见方的图标，行标题由宿主从 label 投影；
		//   `main`（keyed 槽）：key **必须**与侧栏条目 id 相同，选中缺失 key 宿主会直接抛错。
		// 开关（settings.ui.sidebarEntry）是**客户端行为**：这里持有两个 inject 的清理句柄，
		// 关 → 调清理器（宿主会连带注销 register 进去的条目），开 → 重新 inject/register。
		const SIDEBAR_ENTRY_ID = "sage-mem";
		/** 插件 ctx（80-apply 在 apply 时挂进来）；setSidebarEntry 之后要拿它重注册。 */
		let sidebarCtx = null;
		/** 该槽位的清理句柄数组（null = 当前没注册）。 */
		let sidebarDispose = null;

		/**
		 * 侧栏图标：内联 SVG、currentColor、细线 —— 不引外部图片/字体，跟随宿主明暗主题。
		 *
		 * 1.8.2 起字形与仓库根的 `icon.png` 同源：**叠层记忆卡片**（后面一张只描边、低透明，
		 * 前面一张压在左下），不再是「文档三行」。单色而不是品牌金：侧栏图标必须跟随
		 * 宿主的 currentColor，深色 / 浅色主题下才都可读。
		 */
		function SidebarEntryIcon(props) {
			const edge = typeof props.size === "number" && props.size > 0 ? props.size : 16;
			return h("svg", {
				width: edge, height: edge, viewBox: "0 0 16 16", fill: "none",
				"aria-hidden": "true", focusable: "false",
			}, [
				// 后面那张卡：错开、只描边、低透明 —— 表达「一叠记忆」而不是两张孤立的卡。
				h("rect", {
					key: "back", x: "4.4", y: "2.2", width: "9.4", height: "9", rx: "1.8",
					stroke: "currentColor", strokeWidth: "1.2", opacity: "0.45",
				}),
				// 前面那张卡：压在左下，实心描边。
				h("rect", {
					key: "front", x: "2.2", y: "4.8", width: "9.4", height: "9", rx: "1.8",
					stroke: "currentColor", strokeWidth: "1.2",
				}),
				h("path", {
					key: "l1", d: "M4.7 8.2h4.4",
					stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round",
				}),
				h("path", {
					key: "l2", d: "M4.7 10.6h3.1",
					stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round",
				}),
			]);
		}

		/** 卡片里的错误文案：remote 可能 reject 一个字符串 / 对象 / Error，尽量展开成人话。 */
		function pluginCardErr(e) {
			if (!e) return t("pluginCard.saveFailed");
			if (e instanceof Error) return e.message || String(e);
			try {
				const s = JSON.stringify(e);
				return s && s !== "{}" ? s.slice(0, 200) : String(e);
			} catch (_) {
				return String(e);
			}
		}

		/**
		 * 插件详情页的「侧栏入口」卡片（1.8.2）。
		 *
		 * 槽位 `plugins.bundle.config` 是 keyed 槽（key = 包名），宿主在 sage-mem 的插件页里、
		 * description 与「包含的组件」行之间渲染它，ownerProps 为 `{ view: "summary" | "page" }`：
		 *   - summary：标题下的一块摘要位 —— 这里返回 null，不在摘要位重复渲染；
		 *   - page：详情页本体（本卡片自己写设置，所以宿主给的是 page）。
		 *
		 * 数据与设置页同一个来源（remote.memory 的 getSettings / setSettings），切换成功后调
		 * 模块级 `setSidebarEntry`：**立即**增删侧栏图标，不需要刷新 / 重启。
		 * 勾选态一律由服务端回传的 settings 派生 —— 失败时什么都不改，于是自动回到原值。
		 */
		function SidebarEntryConfigCard(props) {
			const ctx = props && props.ctx;
			// 必须走 stableRemote：真实宿主里 ctx.get() 每次返回新对象，进依赖数组会无限重跑。
			const remote = stableRemote(ctx, "remote.memory");
			const sOn = react.useState(true); const on = sOn[0], setOn = sOn[1];
			const sBusy = react.useState(false); const busy = sBusy[0], setBusy = sBusy[1];
			const sErr = react.useState(""); const err = sErr[0], setErr = sErr[1];

			react.useEffect(function () {
				if (!remote || typeof remote.getSettings !== "function") return undefined;
				let alive = true;
				Promise.resolve(remote.getSettings()).then(function (out) {
					if (!alive) return;
					const loaded = unwrap(out) || {};
					// 旧宿主没有 ui 字段 / 值不是布尔 → 保持默认「开」，不弹错、不阻塞界面。
					if (loaded.ui && typeof loaded.ui.sidebarEntry === "boolean") setOn(loaded.ui.sidebarEntry);
				}, function () {
					// 读设置失败也按「开」显示：这里只是插件页的一张卡片，不该因为它报红。
				});
				return function () { alive = false; };
			}, [remote]);

			// summary 位不渲染（hooks 必须在上方无条件调用完再返回，规则与顺序都不变）。
			if (props && props.view === "summary") return null;

			function toggle(next) {
				if (busy) return;
				if (!remote || typeof remote.setSettings !== "function") {
					setErr(t("pluginCard.noSetSettings"));
					return;
				}
				setBusy(true); setErr("");
				Promise.resolve(remote.setSettings({ ui: { sidebarEntry: !!next } })).then(function (out) {
					setBusy(false);
					// setSettings 是 { ok, settings, restartRequired } 形状，不要过 unwrap。
					if (out && out.ok === false) {
						setErr(out.error || t("error.saveRejected"));
						return;
					}
					const settings = out && out.settings ? out.settings : null;
					const applied = settings && settings.ui && typeof settings.ui.sidebarEntry === "boolean"
						? settings.ui.sidebarEntry
						: !!next;
					setOn(applied);
					// 写盘成功之后才动槽位：设置没落盘时界面不该先变一个样。
					setSidebarEntry(!!next);
				}, function (e) {
					setBusy(false);
					setErr(pluginCardErr(e));
				});
			}

			return h("div", { className: "smem-plugin-card" }, [
				h("div", { className: "smem-plugin-card-head", key: "h" }, [
					h("span", { className: "smem-plugin-card-title", key: "t" }, t("pluginCard.title")),
					h("span", { className: "smem-plugin-card-status", key: "s" }, on ? t("pluginCard.on") : t("pluginCard.off")),
				]),
				h("label", { className: "smem-check smem-plugin-card-check", key: "row" }, [
					h("input", {
						type: "checkbox", key: "c",
						checked: on,
						disabled: busy,
						onChange: function (e) { toggle(!!(e.target && e.target.checked)); },
					}),
					h("span", { key: "l" }, t("pluginCard.label")),
				]),
				h("div", { className: "smem-plugin-card-note", key: "n" },
					t("pluginCard.note")),
				err ? h("div", { className: "smem-plugin-card-err", key: "e" }, err) : null,
			]);
		}

		/**
		 * 返回会话：宿主 layout 服务的 `selectPanel(null)` 就是把中央主区还给 Conversation。
		 * 取不到 layout（旧外壳 / 测试环境）时是**空操作**，不影响页面其它部分。
		 */
		function backToConversation() {
			try {
				const layout = sidebarCtx && typeof sidebarCtx.get === "function" ? sidebarCtx.get("layout") : null;
				if (layout && typeof layout.selectPanel === "function") layout.selectPanel(null);
			} catch (e) {
				// 返回按钮不能因为宿主差异把整页搞崩
			}
		}

		/** 中央主区的整页：页顶「返回会话」+ 复用设置页那份 Section。 */
		function MemoryPanelPage(props) {
			const onBack = typeof props.backToConversation === "function" ? props.backToConversation : backToConversation;
			return h("div", { className: "smem-page" }, [
				h("div", { className: "smem-page-top", key: "top" }, [
					h("button", {
						type: "button", className: "smem-page-back", key: "back",
						title: t("page.back"), onClick: onBack,
					}, [
						h("svg", {
							key: "i", width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
						}, h("path", {
							d: "M10 3.5 5.5 8l4.5 4.5", stroke: "currentColor", strokeWidth: "1.6",
							strokeLinecap: "round", strokeLinejoin: "round",
						})),
						h("span", { key: "l" }, t("page.back")),
					]),
				]),
				h(Section, { key: "sec", ...props, ctx: sidebarCtx }),
			]);
		}

		/** 注册两个槽位（幂等：已经注册就什么都不做）。 */
		function registerSidebarEntry() {
			if (sidebarDispose !== null || !sidebarCtx) return true;
			const ctx = sidebarCtx;
			const handles = [];
			// 侧栏 list 槽：只给图标与 label，按钮由宿主自己画。
			handles.push(ctx.slots.inject("sidebar.panellist", function () {
				return ctx.slots.register({
					name: "sidebar.panellist",
					id: SIDEBAR_ENTRY_ID,
					order: 20,
					label: () => t("sidebar.label"),
				}, SidebarEntryIcon);
			}));
			// 中央主区 keyed 槽：key 与侧栏 id 相同；inject 面把「返回会话」交给页面组件。
			handles.push(ctx.slots.inject("main", function () {
				return ctx.slots.register({
					name: "main",
					key: SIDEBAR_ENTRY_ID,
					inject: function () { return { backToConversation: backToConversation }; },
				}, MemoryPanelPage);
			}));
			sidebarDispose = handles;
			return true;
		}

		/**
		 * 开 / 关侧栏入口（立即生效，不改设置文件 —— 写盘由设置页负责）。
		 *
		 * 关闭顺序是**反序**：先摘 main、再摘 sidebar，避免宿主在「侧栏条目还在、main 已没了」
		 * 的中间态里去解析一个不存在的 key（官方契约里那会抛错）。
		 */
		function setSidebarEntry(enabled) {
			if (enabled) return registerSidebarEntry();
			const handles = sidebarDispose;
			sidebarDispose = null;
			if (Array.isArray(handles)) {
				for (let i = handles.length - 1; i >= 0; i--) {
					const dispose = handles[i];
					if (typeof dispose !== "function") continue;
					try { dispose(); } catch (e) { /* 注销失败也不该把开关卡死在「已注册」状态 */ }
				}
			}
			return true;
		}
		// ⚠️ 不把 `layout` 写进 inject：它是**可选**依赖（官方 inspect：optional access =
		// `ctx.get("layout")` + 判空；hardDependency 才是 inject）。写进 inject 会让旧外壳
		// 缺这个服务时整个 client 插件不 apply —— 连带丢掉设置页。返回会话优先用宿主给的
		// `props.backToConversation`，layout 只是兜底。
		const inject = ["slots", "remote"];

		/**
		 * Client 插件：$mount strict remote contribution（第三方 remote 不在
		 * 宿主的固定 remote 清单里，必须自己挂），再注册设置页签 / 侧栏入口。
		 */
		async function apply(ctx) {
			await ctx.remote.$mount(TYPERT_REMOTE);
			// 样式注入（参照官方 client bundle 的 data-plugin-css 约定，幂等）
			const tagId = "sage-mem/settings.css";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "sage-mem";
				tag.dataset.pluginCss = tagId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
			setupI18n(ctx);
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "sage-mem",
						order: 20,
						label: () => t("section.label"),
						// 声明「记忆星图」子槽：sage-starmap 向它注入星空视图，
						// 记忆管理页用 renderSlot 渲染。声明 children 后 shell 才会
						// 向本 section 组件传入 renderSlot。
						children: { "settings.memory.starmap": { kind: "list", scope: "root" } },
					},
					(props) => react.createElement(Section, { ...props, ctx }),
				),
			);
			// ── 1.8.0 侧栏入口：先记住 ctx，再读一次设置决定注不注册 ──────────────
			// 设置页 section **永远**保留（关闭侧栏入口只是少一个入口，不是少一个设置页）。
			// 读失败 / 旧宿主没有 ui 字段 / 值坏掉 → 一律按「开」处理，绝不阻塞界面。
			sidebarCtx = ctx;
			let sidebarEnabled = true;
			try {
				const mem = typeof ctx.get === "function" ? ctx.get("remote.memory") : null;
				if (mem && typeof mem.getSettings === "function") {
					const loaded = unwrap(await mem.getSettings()) || {};
					if (loaded.ui && loaded.ui.sidebarEntry === false) sidebarEnabled = false;
				}
			} catch (e) {
				sidebarEnabled = true;
			}
			setSidebarEntry(sidebarEnabled);

			// ── 1.8.2 插件详情页的「侧栏入口」卡片 ──────────────────────────────
			// `plugins.bundle.config` 是 keyed 槽，key = 本 bundle 的 **package name**（sage-mem）。
			// 宿主在插件页的 description 与「包含的组件」行之间渲染它；ownerProps 形如
			// `{ view: "summary" | "page" }`，卡片里自己再判一次（summary 返回 null）。
			//
			// ⚠️ 这个槽 0.1.7+ 才有。旧宿主上 inject 会**抛错**，所以必须整段 try/catch ——
			// 否则一个可选的插件页卡片会把设置页与侧栏入口一起拖垮（整个 client 插件不 apply）。
			// 放在 apply 最后：即使这里因宿主差异出问题，前面的界面已经挂上去了。
			try {
				if (ctx.slots && typeof ctx.slots.inject === "function") {
					ctx.slots.inject("plugins.bundle.config", function () {
						return ctx.slots.register({
							name: "plugins.bundle.config",
							key: "sage-mem",
						}, function (props) {
							return react.createElement(SidebarEntryConfigCard, { ...(props || {}), ctx });
						});
					});
				}
			} catch (e) {
				// 旧宿主没有这个槽 / 不接受注册：静默跳过，绝不影响其余界面。
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
