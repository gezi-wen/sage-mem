const StarmapRuntime = (function (require, _react) {
	let react = _react;
	const h = react.createElement;
// ── 手写 strict codec（浏览器无 zod，typert 只要求 parse 方法）──
		const isStr = (v) => { if (typeof v !== "string") throw new Error("expected string"); };
		const isNum = (v) => { if (typeof v !== "number") throw new Error("expected number"); };
		const strSchema = { parse(v) { isStr(v); return v; } };
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

		/** 拆 typert remote 的 {ok, value} 信封。 */
		function unwrap(result) {
			return result && result.ok ? result.value : result;
		}

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
		const KIND_META = {
			user: { label: "用户", color: "#e0c07a" },
			feedback: { label: "反馈", color: "#7ec8da" },
			project: { label: "项目", color: "#ac9edc" },
			reference: { label: "参考", color: "#92ceaa" },
			special: { label: "特殊", color: "#bcc3d0" },
		};
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

		function hexA(hex, a) {
			const n = parseInt(hex.slice(1), 16);
			return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a.toFixed(3) + ")";
		}

		function fmtBytes(n) {
			if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
			return n + " B";
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

		// ── overlay 开合的模块级 store（footer 按钮与 overlay 共享）──
		const uiStore = { open: false, subs: new Set() };
		/** client context 由 apply 存入；Slot 组件经 props 或此兜底获取。 */
		let appCtx = null;
		function setOpen(v) {
			uiStore.open = !!v;
			uiStore.subs.forEach((fn) => fn(uiStore.open));
		}
		function useOpen() {
			const s = react.useState(uiStore.open);
			react.useEffect(() => {
				const fn = (v) => s[1](v);
				uiStore.subs.add(fn);
				return () => { uiStore.subs.delete(fn); };
			}, []);
			return s[0];
		}

