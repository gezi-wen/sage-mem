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

