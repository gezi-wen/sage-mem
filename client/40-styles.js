		const CSS = [
			".smem-root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);max-width:760px;}",
			// 2.5.0：一屏两张卡（自动整理 = 做梦 + 归档；库健康 = 冲突 + 体检）。
			// `.smem-root` 本身是 gap 12 的列，但这两张卡中间有标题层级差，间距给大一点。
			".smem-stack{display:flex;flex-direction:column;gap:18px;}",
			".smem-stack > .smem-stack-sep{height:1px;background:var(--dsw-alias-border-l2);}",
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
			".smem-btn-primary{background:var(--dsw-alias-brand-primary,#4d76e6);border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base,#10131a));}",
			".smem-btn-primary:hover{color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base,#10131a));opacity:.88;}",
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
			// ── 模态确认框（2.5.0，D39）：替掉全部就地确认条 ──
			// 遮罩压暗全屏并**吃掉**背景的点击；卡片居中，键盘焦点被 Tab 圈不住时
			// 至少还有 Esc / 点遮罩 / 取消三条出口（Esc 由调用方的 effect 挂）。
			".smem-modal-host{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;}",
			".smem-modal-scrim{position:absolute;inset:0;background:rgba(0,0,0,.5);animation:smem-fade 220ms cubic-bezier(.2,0,0,1);}",
			".smem-modal{position:relative;width:min(460px,92vw);max-height:calc(100vh - 48px);overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;box-shadow:0 24px 60px rgba(0,0,0,.34);animation:smem-pop 220ms cubic-bezier(.2,0,0,1);}",
			"@keyframes smem-pop{from{opacity:0;transform:translateY(6px) scale(.985);}to{opacity:1;transform:none;}}",
			".smem-modal-title{font-weight:600;font-size:13.5px;margin-bottom:8px;}",
			".smem-modal-body{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:8px;}",
			".smem-modal-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;}",
			"@media (prefers-reduced-motion:reduce){.smem-modal,.smem-modal-scrim{animation:none;}}",
			// ── 提示条（2.6.0）：复制成功的回执，铺在视口下方中央 ──
			// **容器不吃点击**（pointer-events:none）：回执不该拦住下一次操作；只有 × 收回
			// 点击，让用户能手动关掉。z-index 压在模态（50）之下、抽屉（40）同层之上。
			".smem-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:41;pointer-events:none;display:flex;align-items:center;gap:10px;max-width:min(560px,92vw);padding:10px 10px 10px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 32px rgba(0,0,0,.38);font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);animation:smem-pop 200ms cubic-bezier(.2,0,0,1);}",
			".smem-toast-check{flex:none;color:var(--dsw-alias-state-success-primary,#16a34a);font-weight:700;}",
			".smem-toast-text{min-width:0;overflow-wrap:anywhere;}",
			".smem-toast-x{pointer-events:auto;flex:none;width:22px;height:22px;padding:0;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;font-family:inherit;cursor:pointer;}",
			".smem-toast-x:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}",
			"@media (prefers-reduced-motion:reduce){.smem-toast{animation:none;}}",
			// 兜底模态里的提示词：等宽、尽量多显示几行。
			".smem-prompt-ta{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.5;height:38vh;min-height:160px;white-space:pre;resize:vertical;}",
			// ── 编辑抽屉（2.5.0，D39）：替掉 1.0 起的页面内联表单 `.smem-form` ──
			// 抽屉从右侧滑入，遮罩自带淡入。两处都用 `animation` 而不是 transition：mount 即播，
			// 不依赖二次渲染（页面不可见时 rAF 不触发）。
			".smem-drawer-host{position:fixed;inset:0;z-index:40;display:flex;justify-content:flex-end;}",
			".smem-drawer-scrim{position:absolute;inset:0;background:rgba(0,0,0,.42);animation:smem-fade 220ms cubic-bezier(.2,0,0,1);}",
			"@keyframes smem-fade{from{opacity:0;}to{opacity:1;}}",
			"@keyframes smem-slide{from{transform:translateX(100%);}to{transform:none;}}",
			".smem-drawer-panel{position:relative;display:flex;flex-direction:column;width:min(560px,94vw);height:100%;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-18px 0 42px rgba(0,0,0,.28);animation:smem-slide 220ms cubic-bezier(.2,0,0,1);}",
			".smem-drawer-head{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);}",
			".smem-drawer-title{font-weight:600;font-size:13.5px;}",
			".smem-drawer-x{margin-left:auto;flex:none;width:26px;height:26px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:15px;line-height:1;font-family:inherit;cursor:pointer;}",
			".smem-drawer-body{flex:1;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:8px;}",
			".smem-drawer-foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2);}",
			".smem-drawer-ta{font-family:inherit;min-height:220px;resize:vertical;}",
			"@media (prefers-reduced-motion:reduce){.smem-drawer-scrim,.smem-drawer-panel{animation:none;}}",
			".smem-label{font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".smem-input,.smem-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;padding:6px 10px;font-size:13px;outline:none;font-family:inherit;}",
			".smem-input:focus,.smem-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-textarea{resize:vertical;min-height:72px;}",
			".smem-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
			".smem-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 12px;font-size:12px;cursor:pointer;font-family:inherit;}",
			".smem-chip:hover{border-color:var(--dsw-alias-border-l2);}",
			'.smem-chip[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-brand-primary,#4d76e6);}',
			".smem-chips{display:flex;gap:6px;flex-wrap:wrap;}",
			// ── 模块卡头（2.5.0，D39）────────────────────────────────────────────
			// 一屏两张模块卡，就必须看得出「这张卡到哪儿为止」——
			// 否则下面那张会被读成「当前这一段的内容」（2026-11-08 维护时一眼看到的正是这个）。
			// 所以每张卡自己带边框；卡头（开关 + 标题 + 状态）在分段之外，底下一条线把它和内容分开。
			".smem-module-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;}",
			".smem-module-head{padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:12px;}",
			".smem-module-card .smem-modcard-head{padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:12px;}",
			".smem-module-card .smem-subtabs{margin-bottom:12px;}",
			".smem-modcard-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;}",
			".smem-modcard-title{font-weight:600;font-size:13px;}",
			".smem-modcard-head .smem-modcard-status{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;}",
			// 关掉时的说明条：只解释「运行被停了」，不暗示设置被锁。
			".smem-modcard-off{margin:6px 0 10px;padding:7px 10px;border-radius:8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-warn-primary,#d97706);background:var(--dsw-alias-bg-layer-2);}",
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
			// 2.7.1（Q04）：上限设置的诊断清单 —— 逐条列宿主的原话，缩进浅一点、行距紧一点。
			".smem-diag-list{margin:4px 0 4px 16px;padding:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);}",
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
			// ── 切页签的进场动画（2.5.0，D39）──────────────────────────────────────
			// 只在**换页签**时播一次：`.smem-view` 带 key={tab}，换页签＝换 key＝换 DOM 节点，
			// CSS 动画自然重播；同一页签内的任何 setState 都复用同一个节点，不会重播。
			// 所以这里不需要「记住上一个 tab」的 JS 状态 —— 让 DOM 节点身份来回答这个问题。
			// 首次打开也播一次：在用户看来那就是切了一页（D39）。
			"@keyframes smem-enter{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}",
			"@keyframes smem-under{from{transform:scaleX(.35);opacity:0;}to{transform:scaleX(1);opacity:1;}}",
			".smem-view{animation:smem-enter 220ms cubic-bezier(.2,0,0,1);}",
			".smem-tab--on:after{animation:smem-under 220ms cubic-bezier(.2,0,0,1);}",
			"@media (prefers-reduced-motion:reduce){.smem-view{animation:none;}.smem-tab--on:after{animation:none;}}",
			// 窄窗口（≤420px）：头部带与筛选条各让一行，卡片动作允许换行、分隔符隐藏。
			"@media (max-width:420px){.smem-root{gap:10px;}.smem-head{gap:6px;}.smem-head-actions{flex-wrap:wrap;}.smem-card-title{min-width:0;word-break:break-word;}.smem-actions{flex-wrap:wrap;}.smem-actions-sep{display:none;}.smem-num{width:56px;}.smem-search{min-width:100px;}}",
			// ── 1.8.0：侧栏入口（设置开关 + 中央主区整页）──
			".smem-check{display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;user-select:none;}",
			".smem-check input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-page{display:flex;flex-direction:column;gap:10px;padding:14px 16px 18px;box-sizing:border-box;min-height:0;overflow:auto;}",
			".smem-page-top{display:flex;align-items:center;}",
			".smem-page-back{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;line-height:1.4;padding:3px 6px 3px 2px;border-radius:6px;cursor:pointer;}",
			".smem-page-back:hover{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-layer-2);}",
			// ── 1.8.2 / 2.7.0：插件详情页的「界面入口」折叠行 ──
			// 融入宿主插件页：标题 13px/600、说明 12px 次要色，圆角与分隔线只用宿主 token。
			// 2.7.0 起默认收起：收起时只露标题 + 当前状态，展开才是三选一。
			".smem-plugin-card{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,#fafbfc);box-sizing:border-box;}",
			".smem-entry-summary{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;padding:0;margin:0;font-family:inherit;text-align:left;cursor:pointer;color:inherit;}",
			".smem-entry-summary:hover .smem-plugin-card-title{color:var(--dsw-alias-brand-primary,#4d76e6);}",
			".smem-entry-summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d76e6);outline-offset:3px;border-radius:6px;}",
			".smem-entry-chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary,#8b93a1);transition:transform 180ms cubic-bezier(.2,0,0,1);}",
			".smem-entry-body{display:flex;flex-direction:column;gap:8px;padding-top:2px;}",
			".smem-entry-opts{display:flex;flex-direction:column;gap:6px;}",
			".smem-entry-opt{font-size:12.5px;line-height:1.5;padding:1px 0;}",
			".smem-entry-opt input:disabled{cursor:not-allowed;opacity:.55;}",
			".smem-plugin-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2430);line-height:1.4;}",
			".smem-plugin-card-status{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.4;}",
			".smem-plugin-card-note{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#6b7280);}",
			".smem-plugin-card-err{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#ef4444);overflow-wrap:anywhere;}",
			// ── 底部一行仓库链接（引流，不抢视线）──
			// ── 求 Star 的角标（2.5.0，D39）：不占正文位置，hover 才展开半句话 ──
			// 2026-11-09 调（原话：「太不显眼了」）：既然它固定在右下角、不压任何内容，
			// 就没必要靠 0.62 的透明度自我隐形 —— 那是给「怕打扰阅读」的按下去的做法，
			// 而这一颗星本来就该被看见。现在：不透明、底色抬到 layer-2、字色从 tertiary 抬到 secondary、
			// 加一层轻阴影让它离底；hover 才把「喜欢这个插件的话」展开（不常显，仍不占阅读视线）。
			".smem-star-corner{position:fixed;right:16px;bottom:16px;z-index:20;display:flex;align-items:center;gap:6px;padding:6px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary,#6b7482);font-size:12.5px;font-weight:500;line-height:1.4;box-shadow:0 4px 14px rgba(0,0,0,.16);transition:border-color 220ms cubic-bezier(.2,0,0,1),background 220ms cubic-bezier(.2,0,0,1),box-shadow 220ms cubic-bezier(.2,0,0,1);}",
			".smem-star-corner:hover{border-color:var(--dsw-alias-brand-primary,#4d76e6);color:var(--dsw-alias-label-primary);box-shadow:0 6px 18px rgba(0,0,0,.22);}",
			".smem-star-glyph{font-size:13px;color:var(--dsw-alias-state-warn-primary,#d97706);transition:transform 220ms cubic-bezier(.2,0,0,1);}",
			".smem-star-corner:hover .smem-star-glyph{transform:scale(1.12);}",
			".smem-star-link{color:inherit;text-decoration:none;border-bottom:1px dashed transparent;}",
			".smem-star-corner:hover .smem-star-link{border-bottom-color:currentColor;}",
			".smem-star-more{max-width:0;overflow:hidden;white-space:nowrap;transition:max-width 220ms cubic-bezier(.2,0,0,1);}",
			".smem-star-corner:hover .smem-star-more{max-width:180px;}",
			".smem-star-x{border:0;background:transparent;color:inherit;cursor:pointer;font-size:11px;line-height:1;padding:0 1px;opacity:.7;font-family:inherit;}",
			".smem-star-x:hover{opacity:1;}",
			"@media (prefers-reduced-motion:reduce){.smem-star-corner,.smem-star-more{transition:none;}}",
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
			// 两份正文并排对照：窄窗口自动堆成一列（grid auto-fit，不用媒体查询）。
			".smem-conf-bodies{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;}",
			".smem-conf-body{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;display:flex;flex-direction:column;gap:4px;min-width:0;}",
			".smem-conf-label{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);}",
			".smem-conf-pre{margin:0;max-height:220px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);}",
			".smem-conf-warn{font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#d97706);}",
		].join("\n");

