/**
 * sage-mem — 客户端半：DSH 设置页「记忆管理」界面（文件管理器）。
 *
 * 手写 ModuleLoader bundle（与官方 dsh-client-* 包的构建产物同格式）：
 * window.__ModuleLoader__.load({ id, factory })，factory 内 require('react')
 * 可用，module.exports 导出标准 Cordis 插件（apply/inject）。
 *
 * 数据通道：TypertRemoteService（host 半 MemoryGateway），通过
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
					result: { mode: "strict", typeSymbol: "sage-starmap/types#StarList", schema: listSchema },
					sourceLocation: { "file": "workspace/sage-starmap/lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-starmap#starmap/readFile",
					service: "starmap",
					namespace: "starmap",
					method: "readFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-starmap/types#FileName", schema: strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-starmap/types#FileContent", schema: readSchema },
					sourceLocation: { "file": "workspace/sage-starmap/lib/index.js", "line": 1, "column": 1 },
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
		const KIND_META = {
			user: { label: "用户", color: "#ffd27d" },
			feedback: { label: "反馈", color: "#6fe3ff" },
			project: { label: "项目", color: "#b18cff" },
			reference: { label: "参考", color: "#7dffb0" },
			special: { label: "特殊", color: "#cfd6e6" },
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

		function starVisible(p, kindsOn, q) {
			if (!kindsOn[p.star.kind]) return false;
			if (q) {
				const hay = (p.star.title + " " + p.star.desc + " " + p.star.file).toLowerCase();
				if (hay.indexOf(q) < 0) return false;
			}
			return true;
		}

		/** 可见性标记 + 同类最近邻星座连线。 */
		function buildVisibility(lay, kindsOn, q) {
			const flags = [];
			for (let i = 0; i < lay.pts.length; i++) flags.push(starVisible(lay.pts[i], kindsOn, q));
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
			".smap-card{color:#dbe4f5;display:flex;flex-direction:column;flex:1;min-height:0;}",
			".smap-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;}",
			".smap-title{font-size:15px;font-weight:600;letter-spacing:.06em;}",
			".smap-sub{font-size:11px;opacity:.55;}",
			".smap-spacer{flex:1;}",
			".smap-search{background:rgba(255,255,255,.06);border:1px solid rgba(150,170,230,.25);border-radius:8px;color:#dbe4f5;font-size:12px;padding:4px 9px;outline:none;width:160px;font-family:inherit;}",
			".smap-search:focus{border-color:rgba(150,170,230,.55);}",
			".smap-search::placeholder{color:rgba(219,228,245,.35);}",
			".smap-btn{background:rgba(255,255,255,.07);border:1px solid rgba(150,170,230,.25);border-radius:8px;color:#dbe4f5;font-size:12px;padding:4px 10px;cursor:pointer;font-family:inherit;}",
			".smap-btn:hover{background:rgba(255,255,255,.13);}",
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

		const SMAP_BG_VS = "attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }";
		const SMAP_BG_FS = [
			"precision highp float;",
			"uniform vec2 uRes;",
			"uniform float uTime;",
			"float hash21(vec2 p){ p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }",
			"float vnoise(vec2 p){",
			"  vec2 i = floor(p); vec2 f = fract(p);",
			"  f = f * f * (3.0 - 2.0 * f);",
			"  float a = hash21(i); float b = hash21(i + vec2(1.0, 0.0));",
			"  float c = hash21(i + vec2(0.0, 1.0)); float e = hash21(i + vec2(1.0, 1.0));",
			"  return mix(mix(a, b, f.x), mix(c, e, f.x), f.y);",
			"}",
			"float fbm(vec2 p){",
			"  float v = 0.0; float amp = 0.55;",
			"  for (int i = 0; i < 4; i++){ v += amp * vnoise(p); p = p * 2.03 + vec2(17.7, 9.2); amp *= 0.5; }",
			"  return v;",
			"}",
			"void main(){",
			"  float fy = gl_FragCoord.y / uRes.y;",
			"  vec3 col = mix(vec3(0.063, 0.090, 0.192), vec3(0.043, 0.063, 0.149), fy);",
			"  vec2 suv = gl_FragCoord.xy / uRes;",
			"  float band = suv.x * 0.92 - suv.y * 0.62 + 0.16;",
			"  float bandMask = exp(-band * band * 13.0);",
			"  vec2 np = vec2(suv.x * 3.1 + suv.y * 1.35, suv.y * 2.15 - suv.x * 0.75);",
			"  float neb = fbm(np + vec2(uTime * 0.010, -uTime * 0.006));",
			"  vec3 dustCol = mix(vec3(0.36, 0.44, 0.78), vec3(0.72, 0.58, 0.46), fbm(np * 0.63 + 4.7));",
			"  col += dustCol * bandMask * (neb * neb) * 0.30;",
			"  float dark = fbm(np * 0.42 + 13.1);",
			"  col *= 1.0 - dark * bandMask * 0.22;",
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
			"    float core = smoothstep(0.34, 0.02, d);",
			"    float slow = 0.5 + 0.5 * sin(uTime * 0.8 + vMeta1.x * 6.2831853);",
			"    alpha = core * vColor.a * (0.45 + 0.55 * slow);",
			"  } else {",
			"    float tw = 0.72 + 0.28 * sin(uTime * 2.1 + vMeta1.x * 6.2831853);",
			"    float core = smoothstep(0.30, 0.02, d);",
			"    float sh = smoothstep(0.09, 0.0, abs(vLocal.y)) * smoothstep(1.0, 0.12, abs(vLocal.x));",
			"    float sv = smoothstep(0.09, 0.0, abs(vLocal.x)) * smoothstep(1.0, 0.12, abs(vLocal.y));",
			"    float spikes = max(sh, sv); spikes = spikes * spikes * spikes * 0.6;",
			"    float glow = exp(-d * 3.2) * 0.5;",
			"    alpha = core + spikes * core + glow;",
			"    if (vMeta1.y > 0.5){",
			"      float ph = fract(uTime * 0.30 + vMeta1.x * 0.61803399);",
			"      float rr = mix(0.20, 0.88, ph);",
			"      alpha += smoothstep(0.075, 0.0, abs(d - rr)) * (1.0 - ph) * 0.85;",
			"    }",
			"    if (abs(vMeta1.z - uHoverIdx) < 0.5){",
			"      alpha += smoothstep(0.10, 0.0, abs(d - 0.66)) * 0.18;",
			"      alpha += smoothstep(0.05, 0.0, abs(d - 0.66)) * 0.9;",
			"    }",
			"    alpha = clamp(alpha, 0.0, 1.15) * tw;",
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
						const fresh = p.star.mtimeMs > 0 && nowMs - p.star.mtimeMs < FRESH_MS ? 1 : 0;
						const birth = p.star.mtimeMs > 0 ? p.star.mtimeMs : 0;
						pushStarQuad(arr, p.x, p.y, p.r * 5.4, hexToRgb(meta.color), 1, p.tw, fresh, i, birth);
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

			const hoverBox = react.useRef({ idx: -1 }).current;
			const visBox = react.useRef({ flags: [], lines: [] }).current;
			const drawBox = react.useRef({ renderer: null, t0: 0 }).current;
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
				remote.listStars().then((r) => {
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
				let raf = window.requestAnimationFrame(function loop() {
					if (drawBox.renderer) drawBox.renderer.render((Date.now() - drawBox.t0) / 1000);
					raf = window.requestAnimationFrame(loop);
				});
				return () => {
					window.cancelAnimationFrame(raf);
					drawBox.renderer = null;
					replayBox.active = false;
					window.cancelAnimationFrame(replayBox.raf);
					if (renderer.destroy) renderer.destroy();
				};
			}, [data, layout, canvasEl]);

			react.useEffect(() => {
				if (!data || !layout || !kindsOn) return;
				const q = query.trim().toLowerCase();
				const vis = buildVisibility(layout, kindsOn, q);
				visBox.flags = vis.flags;
				visBox.lines = vis.lines;
				let anyVis = false;
				for (let i = 0; i < vis.flags.length; i++) { if (vis.flags[i]) { anyVis = true; break; } }
				setEmptySky(!anyVis);
				if (drawBox.renderer) {
					if (drawBox.renderer.setGeometry) drawBox.renderer.setGeometry();
					drawBox.renderer.render((Date.now() - drawBox.t0) / 1000);
				}
			}, [data, layout, kindsOn, query]);

			function hitTest(e) {
				if (!layout) return -1;
				const rect = e.currentTarget.getBoundingClientRect();
				if (rect.width <= 0) return -1;
				const sx = (e.clientX - rect.left) * (layout.W / rect.width);
				const sy = (e.clientY - rect.top) * (layout.H / rect.height);
				let best = -1;
				let bestD = 144;
				for (let i = 0; i < layout.pts.length; i++) {
					if (!visBox.flags[i]) continue;
					const p = layout.pts[i];
					const dx = p.x - sx;
					const dy = p.y - sy;
					const d = dx * dx + dy * dy;
					if (d < bestD) { bestD = d; best = i; }
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
				setHover(null);
			}

			function openStar(st) {
				setSelected({ star: st, text: null });
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
				remote.listStars().then((r) => {
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

			let body;
			if (err) {
				body = h("div", { className: "smap-status" }, "点亮失败：" + err);
			} else if (!data || !layout || !kindsOn) {
				body = h("div", { className: "smap-status" }, busy ? "正在点亮星空…" : "整理星图…");
			} else {
				const legendKids = [];
				for (const k of KIND_ORDER) {
					const n = data.stars.filter((s) => s.kind === k).length;
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
				for (const s of data.stars) {
					totalBytes += s.bytes || 0;
					if (s.mtimeMs > newest) newest = s.mtimeMs;
				}
				legendKids.push(h("span", { key: "count", className: "smap-count" },
					data.count + " 条 · " + fmtBytes(totalBytes) + (newest ? " · 最近更新 " + fmtDate(newest) : "") + " · 单击看全文"));

				const tip = hover ? (() => {
					const meta = KIND_META[hover.star.kind] || KIND_META.special;
					const kids = [
						h("div", { key: "t", className: "smap-tip-title" }, hover.star.title),
						h("div", { key: "k", className: "smap-tip-kind" },
							meta.label + " · " + hover.star.file + " · " + fmtBytes(hover.star.bytes)),
					];
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
							(selected.star.mtimeMs ? " · " + fmtDate(selected.star.mtimeMs) : "")),
					];
					if (selected.text === null) panelKids.push(h("div", { key: "loading", className: "smap-status" }, "展开中…"));
					else panelKids.push(h("div", { key: "body" }, renderMarkdown(selected.text)));
					panel = h("div", { className: "smap-panel" }, panelKids);
				}

				let mainView;
				if (viewMode === "timeline") {
					const q2 = query.trim().toLowerCase();
					const sorted = data.stars
						.filter((s) => starVisible({ star: s }, kindsOn, q2))
						.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0) || a.file.localeCompare(b.file));
					mainView = h("div", { className: "smap-wrap", key: "wrap" },
						h("div", { className: "smap-timeline" },
							sorted.length === 0
								? h("div", { className: "smap-status" }, "这片天区安静了")
								: sorted.map((s) => h("div", {
										className: "smap-tl-item",
										key: s.file,
										onClick: () => openStar(s),
										title: "展开全文",
									},
									h("span", { className: "smap-meta-dot", style: { background: (KIND_META[s.kind] || KIND_META.special).color, flex: "none", alignSelf: "center" } }),
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
		 * dsh-api-remotes 的固定列表里，必须自己挂），再注册 footer 按钮与 overlay。
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
					result: { mode: "strict", typeSymbol: "sage-mem/types#FileList", schema: listSchema },
					sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/readFile",
					service: "memory",
					namespace: "memory",
					method: "readFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#FileContent", schema: readSchema },
					sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/writeFile",
					service: "memory",
					namespace: "memory",
					method: "writeFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema } },
						{ name: "content", wire: "content", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileContent", schema: strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#WriteResult", schema: writeSchema },
					sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#memory/deleteFile",
					service: "memory",
					namespace: "memory",
					method: "deleteFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#DeleteResult", schema: deleteSchema },
					sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#starmap/listStars",
					service: "starmap",
					namespace: "starmap",
					method: "listStars",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: "sage-mem/types#StarmapList", schema: starmapListSchema },
					sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
				},
				{
					id: "sage-mem#starmap/readFile",
					service: "starmap",
					namespace: "starmap",
					method: "readFile",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "sage-mem/types#FileName", schema: strSchema } },
					],
					result: { mode: "strict", typeSymbol: "sage-mem/types#StarmapRead", schema: starmapReadSchema },
					sourceLocation: { "file": "workspace/sage-mem/lib/index.js", "line": 1, "column": 1 },
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
			".smem-starmap{display:flex;flex-direction:column;height:min(70vh,720px);min-height:420px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;}",
		].join("\n");

		const TYPE_META = {
			user: ["👤", "用户"],
			feedback: ["📌", "反馈"],
			project: ["📁", "项目"],
			reference: ["🔗", "参考"],
		};
		const TYPE_ORDER = ["user", "feedback", "project", "reference"];

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
					h("div", { className: "smem-actions", key: "acts" },
						props.deleting
							? [
									h("button", { type: "button", className: "smem-btn smem-btn-danger", key: "yes", onClick: function () { props.onConfirmDelete(item.file); } }, "确认删除"),
									h("button", { type: "button", className: "smem-btn", key: "no", onClick: function () { props.onCancelDelete(); } }, "取消"),
								]
							: [
									h("button", { type: "button", className: "smem-btn", key: "edit", onClick: function () { props.onEdit(item.file); } }, "编辑"),
									h("button", { type: "button", className: "smem-btn smem-btn-danger-ghost", key: "del", onClick: function () { props.onAskDelete(item.file); } }, "删除"),
								])),
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
			const sBusy = react.useState(false);
			const busy = sBusy[0], setBusy = sBusy[1];
			const sOk = react.useState(false);
			const dirOk = sOk[0], setDirOk = sOk[1];
			const sTab = react.useState("files");
			const tab = sTab[0], setTab = sTab[1];
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
			}

			react.useEffect(function () { load(); }, []);

			function closeForm() {
				setFormOpen(false); setEditingFile(null); setFormName(""); setFormDesc(""); setFormBody(""); setFormType("feedback");
			}

			function openEdit(file) {
				setError(null);
				setBusy(true);
				remote.readFile(file)
					.then(function (res) {
						const data = unwrap(res);
						const content = (data && data.content) || "";
						const fm = content.match(/^---\n([\s\S]*?)\n---\n?/);
						let type = "reference";
						let desc = "";
						let body = content;
						if (fm) {
							body = content.slice(fm[0].length);
							const t = fm[1].match(/type:\s*(\S+)/);
							if (t) type = t[1];
							const d = fm[1].match(/description:\s*"?(.+?)"?\n/);
							if (d) desc = d[1].replace(/["']/g, "");
						}
						setEditingFile(file);
						setFormName(file);
						setFormType(TYPE_ORDER.indexOf(type) >= 0 ? type : "reference");
						setFormDesc(desc);
						setFormBody(body);
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
				setFormDesc("");
				setFormBody("");
				setFormOpen(true);
			}

			function buildFrontmatter(type, desc) {
				return "---\nname: \"\"\ndescription: \"" + desc.replace(/"/g, "'") + "\"\nmetadata:\n  type: " + type + "\n---\n\n";
			}

			function submit() {
				if (!formDesc.trim()) { setError("描述不能为空"); return; }
				setBusy(true); setError(null); setNotice("");
				const type = formType;
				const name = (formName.trim() || (type + "_note.md"));
				const safeName = name.endsWith(".md") ? name : name + ".md";
				const content = buildFrontmatter(type, formDesc.trim()) + formBody;
				remote.writeFile(safeName, content)
					.then(function () {
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
					.then(function () {
						setDeleting(null);
						setNotice("已删除 " + file);
						load();
					})
					.catch(function (e) { setError(String((e && e.message) || e)); })
					.then(function () { setBusy(false); });
			}

			const q = query.trim().toLowerCase();
			const filtered = items.filter(function (it) {
				if (!q) return true;
				const hay = ((it.file || "") + "\n" + (it.description || "") + "\n" + (it.type || "")).toLowerCase();
				return hay.indexOf(q) >= 0;
			});

			return h("div", { className: "smem-root" }, [
				h("div", { className: "smem-tabs", key: "tabs" }, [
					h("button", { type: "button", className: "smem-tab" + (tab === "files" ? " smem-tab--on" : ""), key: "f", onClick: function () { setTab("files"); } }, "文件列表"),
					h("button", { type: "button", className: "smem-tab" + (tab === "star" ? " smem-tab--on" : ""), key: "s", onClick: function () { setTab("star"); } }, "记忆星图"),
				]),
				h("div", { className: "smem-head", key: "head" }, [
					h("span", { className: "smem-title", key: "t" }, "记忆文件（sage-mem）"),
					h("span", { className: "smem-dot" + (dirOk ? "" : " smem-dot--bad"), key: "dot", title: dirOk ? "memory 目录可读" : "memory 目录不可读" }),
					h("span", { className: "smem-muted", key: "st" }, dirOk ? "目录可读" : "目录不可读"),
					h("span", { className: "smem-badge", key: "cnt" }, "共 " + String(items.length) + " 个文件"),
				]),
				h("div", { className: "smem-toolbar", key: "bar" }, [
					h("input", { className: "smem-search", key: "q", value: query, placeholder: "搜索文件名 / 描述 / 类型…", onChange: function (e) { setQuery(e.target.value); } }),
					h("button", { type: "button", className: "smem-btn", key: "refresh", disabled: busy || loading, onClick: load }, "刷新"),
					h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "add", onClick: openAdd }, "+ 添加记忆"),
				]),
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
							h("input", { className: "smem-input", key: "tn", value: formName, onChange: function (e) { setFormName(e.target.value); }, placeholder: "例如 project_traveler.md" }),
							h("label", { className: "smem-label", key: "ld" }, "描述（写进 frontmatter，检索与列表都靠它）"),
							h("input", { className: "smem-input", key: "td", value: formDesc, onChange: function (e) { setFormDesc(e.target.value); }, placeholder: "一句话说清这条记忆是什么" }),
							h("label", { className: "smem-label", key: "lb" }, "正文（可选，frontmatter 自动生成）"),
							h("textarea", { className: "smem-textarea", key: "tb", rows: 6, value: formBody, onChange: function (e) { setFormBody(e.target.value); }, placeholder: "要长期记住的细节" }),
							h("div", { className: "smem-row", key: "btns" }, [
								h("button", { type: "button", className: "smem-btn smem-btn-primary", key: "save", disabled: busy, onClick: submit }, busy ? "保存中…" : "保存"),
								h("button", { type: "button", className: "smem-btn", key: "cancel", disabled: busy, onClick: closeForm }, "取消"),
							]),
						])
					: null,
				tab === "star"
					? h("div", { className: "smem-starmap", key: "starmap" },
							h(StarmapRuntime.StarMap, { ctx: props.ctx }))
					: loading && items.length === 0
						? h("div", { className: "smem-muted", key: "loading" }, "加载中…")
						: filtered.length === 0
							? h("div", { className: "smem-empty", key: "empty" },
									items.length === 0
										? "还没有记忆文件。对话中值得记住的事会写到这里，也可以点「添加记忆」手动写入。"
										: "没有符合搜索条件的文件。")
							: h("div", { className: "smem-list", key: "list" }, filtered.map(function (it) {
								return h(Card, {
									key: it.file,
									item: it,
									expanded: !!expanded[it.file],
									deleting: deleting === it.file,
									onToggle: function (file) {
										const nx = {};
										nx[file] = !expanded[file];
										setExpanded(Object.assign({}, expanded, nx));
									},
									onEdit: openEdit,
									onAskDelete: function (file) { setDeleting(file); },
									onCancelDelete: function () { setDeleting(null); },
									onConfirmDelete: confirmDelete,
								});
							})),
			]);
		}

		const inject = ["slots", "remote"];

		/**
		 * Client 插件：$mount strict remote contribution（第三方 remote 不在
		 * dsh-api-remotes 的固定列表里，必须自己挂），再注册设置页签。
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
