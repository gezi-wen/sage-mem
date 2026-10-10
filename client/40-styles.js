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
			// 工具抽屉：关着时**零占位**（工具栏里只有一个「工具 ▾」），点开才占版面。
			// ⚠️ 可发现性不靠抽屉本身，靠头部带常显的「体检 N 个问题」徽标 —— 那是整个
			// 抽屉方案能成立的前提（否则三个能力就退回「藏起来」了）。
			".smem-drawer{position:relative;flex:none;}",
			".smem-drawer-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:6;min-width:236px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.10);padding:6px;display:flex;flex-direction:column;gap:2px;}",
			".smem-drawer-item{display:flex;align-items:center;gap:8px;border:0;background:transparent;font-family:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);text-align:left;padding:6px 8px;border-radius:8px;cursor:pointer;}",
			".smem-drawer-item:hover{background:var(--dsw-alias-bg-layer-2);}",
			'.smem-drawer-item[data-on="1"]{background:var(--dsw-alias-bg-layer-2);font-weight:600;}',
			".smem-drawer-item .smem-status{margin-left:auto;}",
			".smem-status--bad{color:var(--dsw-alias-state-error-primary,#dc2626);font-weight:600;}",
			// 头部带：三个 tab 共用的一条「我在哪 + 现在什么状态 + 主操作」。
			".smem-head-job{font-size:12.5px;font-weight:600;}",
			".smem-head-actions{margin-left:auto;display:flex;align-items:center;gap:6px;}",
			".smem-tool-panel{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:8px;}",
			// 独立成屏的工具面板（现在的「体检」）：显式占满**可用宽度**。
			// 整个面板的宽度上限在 `.smem-root`（760px）上，这里只要确保它在任何父容器里
			// 都吃满那个上限 —— 抽屉里的小面板没有这个问题（它外面还套着一层），
			// 而独立成屏后如果父容器不是 column flex，`align-items:stretch` 就不会发生。
			".smem-tool-panel--full{width:100%;align-self:stretch;box-sizing:border-box;}",
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
			".smem-ad-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:4px 18px;}",
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
			// ── 更新提示（有新版本才出现的一条窄横幅）──
			".smem-update{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--dsw-alias-brand-primary,#4d76e6);border-radius:8px;padding:6px 10px;font-size:12px;background:var(--dsw-alias-bg-layer-1);}",
			".smem-update-link{color:var(--dsw-alias-brand-primary,#4d76e6);text-decoration:underline;}",
			".smem-update-x{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;}",
			// ── 底部一行仓库链接（引流，不抢视线）──
			".smem-star{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1);padding:2px 2px 0;}",
			".smem-star-link{color:var(--dsw-alias-brand-primary,#4d76e6);text-decoration:underline;}",
		].join("\n");

