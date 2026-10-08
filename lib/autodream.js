/**
 * sage-mem autodream —— 再导出层。
 *
 * 实现按关注点拆到 `lib/autodream/` 下（引擎本体在 `autodream/engine.js`）。
 * 这一层只为保持外部导入面不变：`import { AutodreamEngine } from './autodream.js'` 照旧可用。
 */

export { AutodreamEngine } from './autodream/engine.js'
