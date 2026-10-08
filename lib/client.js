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

		// ── 样式（data-plugin-css 约定，幂等注入）──
		const CSS = [
			".smap-footer-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1,transparent);background:transparent;color:var(--dsw-alias-label-secondary,inherit);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;}",
			".smap-fab{position:fixed;right:0;top:15%;transform:translateY(-50%);z-index:900;width:36px;height:64px;border-radius:12px 0 0 12px;border:1px solid rgba(150,170,230,.35);border-right:none;background:rgba(13,18,38,.78);color:#ffd27d;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.5;pointer-events:auto;transition:opacity .15s,background .15s,width .15s;box-shadow:-4px 0 18px rgba(0,0,0,.35);font-family:inherit;}",
			".smap-fab:hover{opacity:1;width:46px;background:rgba(20,28,56,.95);}",
			".smap-footer-btn:hover{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-border-l2,#8886);}",
			".smap-footer-icon{font-size:13px;line-height:1;}",
			".smap-veil{position:fixed;inset:0;z-index:1000;background:rgba(4,6,16,.72);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;pointer-events:auto;animation:smap-fade-in .18s ease-out;}",
			".smap-modal{width:min(980px,94vw);height:min(680px,92vh);background:linear-gradient(160deg,#0d1226,#111a33);border:1px solid rgba(140,160,220,.22);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.55);padding:16px 18px;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;animation:smap-pop-in .22s cubic-bezier(.2,.9,.3,1.15);}",
			"@keyframes smap-fade-in{from{opacity:0}to{opacity:1}}",
			"@keyframes smap-pop-in{from{opacity:0;transform:scale(.96) translateY(10px)}to{opacity:1;transform:none}}",
			// 星图整块含 header 与图例，同属一张深色画布。
			//
			// 不这么做的下场：宿主切到**浅色主题**后，这个组件里硬编码的
			// 浅色文字（#dbe4f5 系）落在白色卡片上，标题、搜索框、图例几乎看不见 ——
			// 一片「重影」。星图本来就不打算跟随宿主主题（它是一张夜空），
			// 那就把边界画清楚：整块深色，而不是只有中间那半块。
			".smap-card{background:#0c0e12;border-radius:10px;padding:12px 14px;color:#e3e7ef;display:flex;flex-direction:column;flex:1;min-height:0;}",
			".smap-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;}",
			".smap-title{font-size:15px;font-weight:600;letter-spacing:.06em;}",
			".smap-sub{font-size:11px;opacity:.55;}",
			".smap-spacer{flex:1;}",
			".smap-search{background:rgba(255,255,255,.06);border:1px solid rgba(150,170,230,.25);border-radius:8px;color:#dbe4f5;font-size:12px;padding:4px 9px;outline:none;width:160px;font-family:inherit;}",
			".smap-search:focus{border-color:rgba(150,170,230,.55);}",
			".smap-search::placeholder{color:rgba(219,228,245,.35);}",
			".smap-btn{background:rgba(255,255,255,.07);border:1px solid rgba(150,170,230,.25);border-radius:8px;color:#dbe4f5;font-size:12px;padding:4px 10px;cursor:pointer;font-family:inherit;}",
			".smap-btn:hover{background:rgba(255,255,255,.13);}",
			// 开态（档案馆开关）与主按钮（恢复）：沿用同一套夜色调，不新增色板。
			// 「显示档案馆」的开/关要一眼看出来：开 = 亮边 + 蓝调底 + 亮字，关 = 整体压暗。
			".smap-btn.on{border-color:rgba(150,170,230,.78);background:rgba(122,158,255,.20);color:#eef3ff;}",
			'.smap-ar-toggle[aria-pressed="false"]{opacity:.60;}',
			".smap-btn:disabled{opacity:.5;cursor:default;}",
			".smap-btn-primary{border-color:rgba(150,170,230,.55);background:rgba(122,158,255,.20);}",
			".smap-wrap{position:relative;flex:1;min-height:0;}",
			".smap-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;border-radius:10px;cursor:crosshair;}",
			".smap-tip{position:absolute;z-index:5;pointer-events:none;max-width:280px;background:rgba(10,14,30,.95);border:1px solid rgba(150,170,230,.35);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.55;box-shadow:0 6px 24px rgba(0,0,0,.45);}",
			".smap-tip-title{font-weight:600;margin-bottom:2px;}",
			".smap-tip-kind{opacity:.6;font-size:11px;margin-bottom:2px;}",
			".smap-tip-desc{opacity:.85;}",
			".smap-panel{position:absolute;top:10px;right:10px;bottom:10px;width:min(400px,54%);background:rgba(9,13,28,.97);border:1px solid rgba(150,170,230,.32);border-radius:10px;padding:12px 14px;overflow-y:auto;z-index:6;font-size:13px;line-height:1.7;box-shadow:-8px 0 30px rgba(0,0,0,.35);}",
			".smap-panel-head{display:flex;align-items:flex-start;gap:8px;margin-bottom:4px;}",
			".smap-panel-title{font-weight:600;font-size:14px;flex:1;}",
			".smap-panel-meta{font-size:11px;opacity:.6;margin-bottom:8px;}",
			".smap-panel-arch{display:flex;flex-direction:column;gap:6px;border:1px solid rgba(150,170,230,.28);border-radius:8px;padding:8px 10px;background:rgba(255,255,255,.03);}",
			".smap-meta-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:-1px;}",
			".smap-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;font-size:12px;align-items:center;}",
			".smap-lg-item{cursor:pointer;user-select:none;}",
			".smap-lg-item.off{opacity:.32;}",
			".smap-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:-1px;}",
			".smap-count{margin-left:auto;opacity:.55;font-size:11px;}",
			".smap-status{padding:28px;text-align:center;opacity:.6;font-size:13px;}",
			".smap-empty{position:absolute;left:0;right:0;top:46%;text-align:center;color:rgba(219,228,245,.42);font-size:13px;pointer-events:none;z-index:4;}",
			".smap-replay-on{border-color:rgba(255,210,125,.55)!important;color:#ffd27d!important;}",
			".smap-replay-date{font-size:11px;opacity:.75;color:#ffd27d;font-variant-numeric:tabular-nums;}",
			".smap-md-h{font-weight:600;margin:12px 0 4px;}",
			".smap-md-h1{font-size:16px;}",
			".smap-md-h2{font-size:14.5px;}",
			".smap-md-h3,.smap-md-h4{font-size:13.5px;opacity:.92;}",
			".smap-md-p{margin:4px 0;}",
			".smap-md-list{margin:4px 0;padding-left:20px;}",
			".smap-md-code{background:rgba(255,255,255,.09);padding:1px 5px;border-radius:4px;font-size:12px;}",
			".smap-md-pre{background:rgba(255,255,255,.06);padding:8px 10px;border-radius:8px;font-size:12px;overflow-x:auto;white-space:pre-wrap;margin:6px 0;}",
			".smap-md-quote{border-left:3px solid rgba(150,170,230,.4);margin:6px 0;padding:2px 10px;opacity:.88;}",
			".smap-md-wiki{color:#8ab4ff;}",
			".smap-md-hr{border:none;border-top:1px solid rgba(150,170,230,.22);margin:10px 0;}",
			".smap-viewtoggle{display:inline-flex;border:1px solid rgba(150,170,230,.25);border-radius:8px;overflow:hidden;}",
			".smap-vt-btn{background:transparent;border:none;color:rgba(219,228,245,.55);font-size:12px;padding:4px 10px;cursor:pointer;font-family:inherit;}",
			".smap-vt-btn.on{background:rgba(255,255,255,.12);color:#dbe4f5;}",
			".smap-timeline{position:absolute;inset:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:4px 6px 4px 2px;}",
			".smap-tl-item{display:flex;align-items:baseline;gap:8px;background:rgba(255,255,255,.035);border:1px solid rgba(150,170,230,.16);border-radius:8px;padding:7px 10px;cursor:pointer;flex:none;}",
			".smap-tl-item:hover{background:rgba(255,255,255,.08);border-color:rgba(150,170,230,.35);}",
			".smap-tl-item--arch{opacity:.75;}",
			".smap-ar-badge{font-size:10.5px;opacity:.65;border:1px solid rgba(150,170,230,.3);border-radius:5px;padding:0 5px;flex:none;align-self:center;}",
			".smap-tl-date{font-size:11px;opacity:.5;font-variant-numeric:tabular-nums;flex:none;}",
			".smap-tl-title{font-size:13px;font-weight:600;flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".smap-tl-desc{font-size:12px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}",
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
		// 又要一眼看出不是活记忆。亮度靠 shader 那一档（0.52），这里负责色相：冷、灰、不饱和。
		const ARCHIVE_GREY = [0.46, 0.50, 0.58];
		function dimRgb(hex) {
			const c = hexToRgb(hex);
			return [
				c[0] * 0.26 + ARCHIVE_GREY[0] * 0.74,
				c[1] * 0.26 + ARCHIVE_GREY[1] * 0.74,
				c[2] * 0.26 + ARCHIVE_GREY[2] * 0.74,
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
		const SMAP_BG_FS = [
			"precision highp float;",
			"uniform vec2 uRes;",
			"uniform float uTime;",
			"void main(){",
			"  vec2 suv = gl_FragCoord.xy / uRes;",
			"  float r = length((suv - vec2(0.5, 0.44)) * vec2(1.0, 1.28));",
			"  vec3 col = mix(vec3(0.105, 0.117, 0.145), vec3(0.043, 0.050, 0.065), clamp(r * 1.30, 0.0, 1.0));",
			"  gl_FragColor = vec4(col, 1.0);",
			"}",
		].join("\n");

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
				const progBg = glProgram(gl, SMAP_BG_VS, SMAP_BG_FS, ["aPos"], ["uRes", "uTime"]);
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
						pushStarQuad(arr, x, y, r, [0.62, 0.70, 0.87], 0.10 + 0.30 * rand01(i * 7 + 3), rand01(i * 11 + 29), 0, -1, -1);
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
							pushStarQuad(arr, p.x, p.y, p.r * 6.0, dimRgb(meta.color), 0.26, p.tw, 0, -1, birth);
							pushStarQuad(arr, p.x, p.y, p.r * 4.4, dimRgb(meta.color), 1, p.tw, -1, i, birth);
						} else {
							pushStarQuad(arr, p.x, p.y, p.r * 5.4, hexToRgb(meta.color), 1, p.tw, fresh, i, birth);
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
						const c = hexToRgb((KIND_META[ln[2]] || KIND_META.special).color);
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
				const bg = c2d.createLinearGradient(0, 0, 0, H);
				bg.addColorStop(0, "#0b1026");
				bg.addColorStop(1, "#101731");
				c2d.fillStyle = bg;
				c2d.fillRect(0, 0, W, H);
				for (let i = 0; i < 150; i++) {
					const x = rand01(i * 97 + 13) * W;
					const y = rand01(i * 31 + 7) * H;
					c2d.globalAlpha = 0.08 + 0.22 * rand01(i * 7 + 3);
					c2d.fillStyle = "#9fb3dd";
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
					c2d.strokeStyle = hexA(meta.color, (hot ? 0.6 : 0.22) * lrv);
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
						const dc = dimRgb(meta.color);
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
						c2d.fillStyle = dimCss(meta.color);
						c2d.beginPath();
						c2d.arc(p.x, p.y, Math.max(1.2, p.r * 0.7), 0, Math.PI * 2);
						c2d.fill();
						c2d.globalAlpha = 1;
						if (hot) {
							c2d.strokeStyle = dimCss(meta.color);
							c2d.lineWidth = 1;
							c2d.beginPath();
							c2d.arc(p.x, p.y, p.r + 5, 0, Math.PI * 2);
							c2d.stroke();
						}
						continue;
					}
					if (p.star.mtimeMs > 0 && nowMs - p.star.mtimeMs < FRESH_MS) {
						const pr = p.r + 5 + 3 * (0.5 + 0.5 * Math.sin(phase * 1.4 + p.tw * 6.28));
						c2d.strokeStyle = hexA(meta.color, 0.4 * rv);
						c2d.lineWidth = 1;
						c2d.beginPath();
						c2d.arc(p.x, p.y, pr, 0, Math.PI * 2);
						c2d.stroke();
					}
					const glowR = p.r * 4.2;
					const g = c2d.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
					g.addColorStop(0, hexA(meta.color, 0.5 * tw * rv));
					g.addColorStop(1, hexA(meta.color, 0));
					c2d.fillStyle = g;
					c2d.beginPath();
					c2d.arc(p.x, p.y, glowR, 0, Math.PI * 2);
					c2d.fill();
					c2d.globalAlpha = (0.62 + 0.38 * tw) * rv;
					c2d.fillStyle = meta.color;
					c2d.beginPath();
					c2d.arc(p.x, p.y, p.r, 0, Math.PI * 2);
					c2d.fill();
					c2d.globalAlpha = 1;
					if (hoverBox.idx === i) {
						c2d.strokeStyle = hexA(meta.color, 0.9 * rv);
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
			}, [data, layout, canvasEl]);

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
					h("span", { className: "smap-dot", style: { background: KIND_META[k].color } }),
					KIND_META[k].label + " " + n));
				}
				let totalBytes = 0;
				let newest = 0;
				for (const s of viewStars) {
					totalBytes += s.bytes || 0;
					if (s.mtimeMs > newest) newest = s.mtimeMs;
				}
				legendKids.push(h("span", { key: "count", className: "smap-count" },
					viewStars.length + " 条 · " + fmtBytes(totalBytes) + (newest ? " · 最近更新 " + fmtDate(newest) : "") +
					(showArchive && archivedN ? " · 档案馆 " + archivedN + " 颗暗星" : "") +
					" · 单击看" + (showArchive && archivedN ? "详情" : "全文")));

				const tip = hover ? (() => {
					const meta = KIND_META[hover.star.kind] || KIND_META.special;
					const kids = [
						h("div", { key: "t", className: "smap-tip-title" }, hover.star.title),
						h("div", { key: "k", className: "smap-tip-kind" },
							meta.label + " · " + hover.star.file + " · " + fmtBytes(hover.star.bytes)),
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
							h("span", { className: "smap-meta-dot", style: { background: meta.color } }),
							meta.label + " · " + selected.star.file + " · " + fmtBytes(selected.star.bytes) +
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
									h("span", { className: "smap-meta-dot", style: { background: s.archived === true ? dimCss((KIND_META[s.kind] || KIND_META.special).color) : (KIND_META[s.kind] || KIND_META.special).color, flex: "none", alignSelf: "center" } }),
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
				h("div", { className: "smap-head" },
					h("span", { className: "smap-title" }, "记忆星图"),
					h("span", { className: "smap-sub" }, "sage-mem memory · 每颗星是一条记忆"),
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

		// ── 全屏 overlay ─────────────────────────────────────────────
		function StarmapOverlay() {
			const open = useOpen();
			react.useEffect(() => {
				if (!open) return undefined;
				const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [open]);
			if (!open) return null;
			return h("div", {
				className: "smap-veil",
				onMouseDown: (e) => { if (e.target === e.currentTarget) setOpen(false); },
			},
			h("div", { className: "smap-modal" },
				h(StarMap, { ctx: appCtx, onClose: () => setOpen(false) })));
		}

		// ── 窗口右缘浮标（唯一入口，不绑实例/会话/Run 卡片）────────────
		function StarmapEdgeTab() {
			const open = useOpen();
			if (open) return null;
			return h("button", {
				type: "button",
				className: "smap-fab",
				onClick: () => setOpen(true),
				title: "记忆星图 — 把 sage-mem 的记忆画成一片星空",
				"aria-label": "记忆星图",
			}, "✦");
		}

		const inject = ["slots", "remote"];

		/**
		 * Client 插件：$mount strict remote contribution（第三方 remote 不在
		 * 宿主的固定 remote 清单里，必须自己挂），再注册 footer 按钮与 overlay。
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
			],
		};

		const CSS = [
			".smem-root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);max-width:760px;}",
			".smem-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
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
			".smem-tools{display:flex;align-items:center;gap:4px;flex-wrap:wrap;}",
			".smem-tool-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer;padding:2px 8px;border-radius:6px;}",
			".smem-tool-btn:hover{color:var(--dsw-alias-label-primary);}",
			'.smem-tool-btn[data-on="1"]{color:var(--dsw-alias-brand-primary,#4d76e6);background:var(--dsw-alias-bg-layer-2);}',
			".smem-tool-panel{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:8px;}",
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
			".smem-starmap{display:flex;flex-direction:column;height:min(62vh,660px);min-height:400px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;}",
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
			".smem-ad-badge--warn{color:var(--dsw-alias-state-warning-primary,#d97706);border-color:var(--dsw-alias-state-warning-primary,#d97706);}",
			".smem-ad-badge--legacy{opacity:.78;}",
			".smem-ad-confirm{border:1px solid var(--dsw-alias-state-error-primary,#ef4444);border-radius:8px;padding:7px 9px;font-size:12px;line-height:1.55;display:flex;flex-direction:column;gap:6px;overflow-wrap:anywhere;}",
			".smem-ad-rb{font-size:12px;line-height:1.5;overflow-wrap:anywhere;}",
			".smem-ad-run{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 9px;background:transparent;color:inherit;text-align:left;font-family:inherit;font-size:12px;cursor:pointer;}",
			".smem-ad-run:hover{border-color:var(--dsw-alias-border-l2);}",
			'.smem-ad-run[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d76e6);}',
			".smem-ad-md{max-height:360px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6;}",
			// ── 注入参数 / 保留名名单（自动做梦 tab）──
			".smem-ad-warn{color:var(--dsw-alias-state-warning-primary,#d97706);}",
			".smem-chip--fixed{opacity:.72;cursor:default;}",
			".smem-chip-x{border:0;background:transparent;color:inherit;cursor:pointer;font-size:11px;font-family:inherit;padding:0 0 0 5px;}",
		].join("\n");

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
											// 归档排在「编辑」和「删除」之间：比编辑轻、比删除温和，且随时可逆。
											h("button", { type: "button", className: "smem-btn", key: "arch", title: "收进档案馆：不再参与检索与星图，随时可以恢复", onClick: function () { props.onAskArchive(item.file); } }, "归档"),
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

		/**
		 * 「体检」结果面板。
		 *
		 * 只读：这里**不提供任何「顺手修一下」的按钮** —— 修哪条、怎么修由用户决定，
		 * 走列表里那条记忆自己的编辑入口。
		 *
		 * 硬问题与提示**分开渲染**：`archivedLinks` 是提示（归档不是删除，目标还在档案馆里），
		 * 跟问题一样染红会让人去「修」一条本来正确的链接 —— 那正是审计里那条分界线。
		 */
		function AuditPanel(props) {
			const r = props.report || {};
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
			return h("div", { className: "smem-tool-panel", key: "audit" }, [
				h("div", { className: "smem-tool-head", key: "head" }, [
					h("span", { className: "smem-tool-title", key: "t" }, "体检"),
					h("span", { className: "smem-muted", key: "s" },
						"扫了 " + String(r.fileCount == null ? "?" : r.fileCount) + " 个记忆 · 索引 " +
						String(r.indexEntries == null ? "?" : r.indexEntries) + " 条 · 档案馆 " +
						String(r.archivedCount == null ? "?" : r.archivedCount) + " 条"),
					h("span", { className: "smem-tool-badge" + (r.problems ? " smem-tool-badge--bad" : ""), key: "p" },
						r.problems ? ("问题 " + r.problems) : "没有问题"),
					h("button", { type: "button", className: "smem-btn", key: "again", disabled: props.busy, onClick: props.onRun }, props.busy ? "体检中…" : "重新体检"),
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
			return h("div", { className: "smem-tool-panel", key: "cand" }, [
				h("div", { className: "smem-tool-head", key: "head" }, [
					h("span", { className: "smem-tool-title", key: "t" }, "归档候选"),
					h("span", { className: "smem-muted", key: "s" },
						"自动归档：" + AUTO_ARCHIVE_LABEL[mode] + " · 阈值：项目 " + String(th.project == null ? "?" : th.project) + " 天 / 参考 " +
						String(th.reference == null ? "?" : th.reference) + " 天 / 用户 " +
						String(th.user == null ? "?" : th.user) + " 天"),
					h("span", { className: "smem-tool-badge", key: "n" }, "候选 " + cands.length),
					h("button", { type: "button", className: "smem-btn", key: "again", disabled: props.busy, onClick: props.onLoad }, props.busy ? "刷新中…" : "刷新"),
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
			const remote = props.ctx && props.ctx.get ? props.ctx.get("remote.autodream") : null;
			// 注入设置走 memory 那半边（autodream 只管整理那趟）
			const memRemote = props.ctx && props.ctx.get ? props.ctx.get("remote.memory") : null;
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
			const sAutoSaving = react.useState(false); const autoSaving = sAutoSaving[0], setAutoSaving = sAutoSaving[1];
			const sReservedNew = react.useState(""); const reservedNew = sReservedNew[0], setReservedNew = sReservedNew[1];

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

			/**
			 * 自动归档三档：保存后**回读校验**。
			 *
			 * `setConfig` 对非法值沿用的是「忽略、保留原值」的语义（没有 `{ok:false}` 通道），
			 * 所以不能只看它返回的 config —— 必须再 `getConfig()` 一次，确认那个值真的落在
			 * 配置里。没变就报错：**不能让用户点了保存以为成了、实际什么都没发生**。
			 */
			function saveAutoArchive(v) {
				setErr(null); setNotice(""); setAutoSaving(true);
				callRemote("setConfig", [{ autoArchive: v }], function (d) {
					if (d && d.config && d.config.autoArchive === v) {
						setCfg(d.config);
						setAutoSaving(false);
						setNotice("自动归档已设为「" + AUTO_ARCHIVE_LABEL[v] + "」");
						return;
					}
					// 返回的 config 里没看到新值 → 回读一次再定论
					callRemote("getConfig", [], function (d2) {
						const next = d2 && d2.config ? d2.config : null;
						setAutoSaving(false);
						if (next) setCfg(next);
						const got = next ? autoArchiveOf(next.autoArchive) : null;
						if (got === v) { setNotice("自动归档已设为「" + AUTO_ARCHIVE_LABEL[v] + "」"); return; }
						setErr("保存没生效：配置里仍是「" + (got ? AUTO_ARCHIVE_LABEL[got] : "读不出来") +
							"」。setConfig 对非法值会忽略并保留原值 —— 请重试，或看 DSH 启动日志。");
					}, function (m) { setAutoSaving(false); setErr("保存后回读失败：" + m); });
				}, function (m) { setAutoSaving(false); setErr(m); });
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

			return h("div", { className: "smem-autodream" }, [
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
				h("div", { className: "smem-autodream-sec", key: "autoarchive" }, [
					h("div", { className: "smem-autodream-row", key: "r" }, [
						h("span", { className: "smem-autodream-key", key: "k" }, "自动归档"),
						h(Seg, {
							key: "v", value: autoArchiveOf(c.autoArchive),
							options: [
								{ value: "off", label: AUTO_ARCHIVE_LABEL.off },
								{ value: "report", label: AUTO_ARCHIVE_LABEL.report },
								{ value: "auto", label: AUTO_ARCHIVE_LABEL.auto },
							],
							// 点一档就存一档，但**存完要回读**：setConfig 对非法值是静默忽略，
							// 只信返回值不够（见 saveAutoArchive 的注释）。
							onChange: function (v) { if (v !== autoArchiveOf(c.autoArchive)) saveAutoArchive(v); },
						}),
						autoSaving ? h("span", { className: "smem-status", key: "s" }, "保存中…") : null,
					]),
					h("div", { className: "smem-autodream-note", key: "cost" }, AUTO_ARCHIVE_COST[autoArchiveOf(c.autoArchive)]),
					autoArchiveOf(c.autoArchive) === "auto" && !c.apply
						? h("div", { className: "smem-autodream-note smem-ad-warn", key: "deg" },
								"注意：现在「改动方式」是只出报告 —— 这一档会自动降级成只出报告，不会动文件。")
						: null,
				]),
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
					LIMIT_FIELDS.map(function (f) {
						const cur = memSet && memSet.limits ? memSet.limits[f.key] : null;
						const pend = memSet && memSet.pendingLimits ? memSet.pendingLimits[f.key] : null;
						const diff = cur != null && pend != null && cur !== pend;
						return h("div", { className: "smem-autodream-row", key: f.key }, [
							h("span", { className: "smem-autodream-key", key: "k" }, f.label),
							h("input", {
								className: "smem-num", key: "v", type: "number",
								min: String(f.lo), max: String(f.hi),
								value: limitsDraft && limitsDraft[f.key] != null ? limitsDraft[f.key] : "",
								onChange: function (e) {
									const nx = Object.assign({}, limitsDraft);
									nx[f.key] = e.target.value;
									setLimitsDraft(nx);
								},
							}),
							h("span", { className: "smem-status", key: "r" }, f.unit + " · 范围 " + f.lo + "–" + f.hi),
							diff
								? h("span", { className: "smem-ad-badge smem-ad-badge--warn", key: "d" }, "当前 " + String(cur) + " → 重启后 " + String(pend))
								: h("span", { className: "smem-status", key: "d" }, cur == null ? "" : ("当前生效 " + String(cur))),
						]);
					}),
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
						h("div", { className: "smem-autodream-row", key: "keep" }, [
							h("span", { className: "smem-autodream-key", key: "k" }, "保留快照"),
							h("input", { className: "smem-num", key: "v", type: "number", min: "1", max: "50", value: c.maxSnapshotKeep, onChange: function (e) { patch({ maxSnapshotKeep: Number(e.target.value) }); } }),
							h("span", { className: "smem-status", key: "s" }, "份"),
						]),
						h("div", { className: "smem-status", key: "paths" }, "配置与状态：" + ((st && st.paths && st.paths.configPath) || "—")),
					]),
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
								(last.report ? " · 报告 " + last.report : ""))
						: null,
				]),
				// ── 回滚点（新）──────────────────────────────────────────────
				// 只改这一个文件、只用既有 h() 写法；数据全走 remote.autodream。
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
				listErr && !err ? h("div", { className: "smem-err", key: "lerr" }, "⚠ " + listErr) : null,
				err ? h("div", { className: "smem-err", key: "err" }, "⚠ " + err) : null,
				notice && !err ? h("div", { className: "smem-ok", key: "ok" }, "✓ " + notice) : null,
			]);
		}

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

		const inject = ["slots", "remote"];

		/**
		 * Client 插件：$mount strict remote contribution（第三方 remote 不在
		 * 宿主的固定 remote 清单里，必须自己挂），再注册设置页签。
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
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "sage-mem",
						order: 20,
						label: "记忆管理",
						// 声明「记忆星图」子槽：sage-starmap 向它注入星空视图，
						// 记忆管理页用 renderSlot 渲染。声明 children 后 shell 才会
						// 向本 section 组件传入 renderSlot。
						children: { "settings.memory.starmap": { kind: "list", scope: "root" } },
					},
					(props) => react.createElement(Section, { ...props, ctx }),
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
