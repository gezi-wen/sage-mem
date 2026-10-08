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



