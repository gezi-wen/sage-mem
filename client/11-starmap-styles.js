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

