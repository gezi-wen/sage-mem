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

