		// ── 共享基元（1.4.0）：跨屏复用的小东西只有这一份 ─────────────
		// 这些名字原本在 10 / 20 / 50 三个分片各写一遍（isStr/isNum/strSchema/parseSchema/
		// unwrap/fmtSize/hexA，以及类型词表 3 份）。分片共享同一个 factory 作用域，
		// 所以收敛到本片之后，后面的分片直接用、不再各写一份。
		const isStr = (v) => { if (typeof v !== "string") throw new Error("expected string"); };
		const isBool = (v) => { if (typeof v !== "boolean") throw new Error("expected boolean"); };
		const isNum = (v) => { if (typeof v !== "number") throw new Error("expected number"); };
		function parseSchema(shape) {
			return {
				// 字段清单**暴露出来**：`test/client-exec-test.mjs` 第 3.1 组拿它跟宿主 zod 的
				// shape 逐条对表。没有这一项，「strict」只意味着「不查多余键」——
				// 宿主加了字段、客户端没声明这种漂移它挡不住（2026-11-03 实测已漂三处）。
				fields: Object.keys(shape),
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

		// ── 陈旧宿主（2.1.22 / issue #10）────────────────────────────────
		//
		// `@deepseek-ai/dsh-typert-loader` 把每个包的 TYPERT manifest **按包名缓存、
		// 进程内不失效**（它的头注原文：Package verdicts and imported manifests are
		// cached per package name and never expire）。于是「开着 DSH 装上新版 sage-mem」
		// 之后，宿主进程里仍然是升级前的 strict descriptor（2.1.1 的 writeFile 只有
		// name/content 两个 wire 字段），而浏览器这边是从磁盘现取的新客户端分片 ——
		// 第三参 opts 会在宿主**执行之前**被网关挡掉：
		//
		//   gateway/arguments-invalid: args fields do not match the descriptor:
		//   unexpected "opts"
		//
		// 真正要清掉的是宿主进程里那份旧 manifest（彻底退出 DSH，含托盘常驻进程；
		// 只关窗口不够）。但用户不该被卡在这里：写操作按旧协议降级重试。

		/**
		 * 只认「旧 strict descriptor 不认第三参」这一种结构化失败。
		 *
		 * ⚠️ 两种形态都要认（2026-11-01 真机抓到）：网关的失败既可能被**拒绝**（reject），
		 * 也可能作为 remote 的**返回值** `{ok:false, error}` 回来 —— 后者是 api-gateway
		 * 的 RemoteResult 语义，sage-mem 面板的其它写路径也一直在读 `r.ok === false`。
		 * 只判 rejection 的话，真实环境里这条降级根本不会触发（第一版就踩了）。
		 *
		 * 判据同时看 code 与文案：同一个 `gateway/arguments-invalid` 也可能是在拒别的
		 * 字段，甚至别的调用方传错参数 —— 那些都必须原样抛出，不能拿兼容降级去吞。
		 * @returns 出问题的那个 error 对象，或 null。
		 */
		function staleHostWriteCause(value) {
			const candidate = value && value.ok === false && value.error ? value.error : value;
			if (!candidate) return null;
			const code = typeof candidate.code === "string" ? candidate.code : "";
			const message = String(candidate.message || candidate);
			if (code !== "gateway/arguments-invalid" && !/gateway\/arguments-invalid/.test(message)) return null;
			return /unexpected\s+["']?opts["']?/i.test(message) ? candidate : null;
		}

		/** 布尔版判据（面板/测试可读）。 */
		function isStaleHostWriteError(value) {
			return staleHostWriteCause(value) !== null;
		}

		/**
		 * 只认「文件不存在」这一种读失败（宿主 readFile / readRaw 的 ENOENT 文案）。
		 *
		 * 陈旧宿主降级里的 create 探针必须用它：读失败也可能是权限 / IO 错误，
		 * 那种情况下**不能**把目标当成「不存在」去覆盖写（2.1.10 / Q10 的教训）。
		 */
		function isNotFoundError(error) {
			return /ENOENT|no such file|not exist/i.test(String((error && error.message) || error));
		}

		/**
		 * 「目标是否已存在」探针（陈旧宿主创建降级用）。
		 *
		 * ⚠️ 两种返回形态都要认（2026-11-01 真机抓到）：宿主方法抛出的错误经 api-gateway
		 * 可能变成**返回值** `{ok:false, error}`（RemoteResult 语义），也可能仍是 rejection。
		 * 只处理 rejection 会把「文件不存在」误判成「已存在」—— 那会让新建永远报撞名。
		 *
		 * @returns Promise<boolean>：true=已存在；false=明确的 not-found；
		 *          其它读失败（权限 / IO / 网关）抛出来，由调用方决定不降级。
		 */
		function probeRemoteExists(remote, method, arg) {
			const call = new Promise(function (resolve) {
				const fn = remote && remote[method];
				if (typeof fn !== "function") throw new Error("sage-mem: host has no " + method);
				resolve(fn.call(remote, arg));
			});
			const classify = function (error) {
				if (isNotFoundError(error)) return false;
				throw error;
			};
			return call.then(function (result) {
				if (result && result.ok === false && result.error) return classify(result.error);
				return true;
			}, classify);
		}

		/**
		 * 写调用 + 陈旧宿主降级。
		 *
		 * @param remote  宿主 remote 代理
		 * @param method  写方法名（writeFile / writeRaw / writeArchived）
		 * @param args    位置参数（不含 opts）
		 * @param opts    写协议第三参；undefined 表示旧调用方，直接按旧协议写
		 * @param probeExists 仅 create 语义用：探测目标是否已存在的函数（Promise<boolean>）。
		 *       陈旧宿主没有 create 语义，**没有探针就不降级** —— 宁可这次写失败，也不拿走
		 *       条件覆盖写去顶创建。
		 * @returns Promise<{result, degraded}>；degraded=true 表示这次按旧协议写入，
		 *          expectedRevision 的版本校验没有生效，界面必须把这件事告诉用户。
		 */
		function writeWithFallback(remote, method, args, opts, probeExists) {
			function send(extraOpts) {
				return new Promise(function (resolve) {
					const fn = remote && remote[method];
					if (typeof fn !== "function") throw new Error("sage-mem: host has no " + method);
					// ⚠️ 第三个**位置参数**必须保留（哪怕值是 undefined）：客户端 remote 代理按
					// 客户端描述符校验位置参数个数（三个写方法都声明了 3 个），少传一个会当场报
					// 「client api: memory/writeFile expected 3 argument(s), got 2」—— 降级根本没
					// 走到网关。undefined 在 JSON 里自然缺席，宿主旧接口只看到 name/content，
					// 正好就是旧协议（2026-11-01 真机抓到）。
					resolve(fn.apply(remote, args.concat([extraOpts])));
				});
			}
			function degraded(result) { return { result: result, degraded: true }; }
			/** 降级重试；返回 null 表示「这次不该降级」，由调用方把原始失败原样交出去。 */
			function recover() {
				if (opts && opts.create === true) {
					// 降级不是无条件的：旧宿主没有 create 语义，先探一次存在性。
					if (typeof probeExists !== "function") return null;
					return Promise.resolve().then(probeExists).then(function (exists) {
						if (exists) {
							return degraded({
								ok: false,
								code: "already_exists",
								error: t("error.staleHostExists", { file: String(args[0]) }),
							});
						}
						return send(undefined).then(degraded);
					});
				}
				return send(undefined).then(degraded);
			}
			if (opts === undefined) {
				return send(undefined).then(function (result) { return { result: result, degraded: false }; });
			}
			function onStale(original) {
				const recovered = recover();
				if (recovered === null) throw staleHostWriteCause(original) || original;
				return recovered;
			}
			return send(opts).then(
				function (result) {
					if (!isStaleHostWriteError(result)) return { result: result, degraded: false };
					return onStale(result);
				},
				function (error) {
					if (!isStaleHostWriteError(error)) throw error;
					return onStale(error);
				},
			);
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
