/**
 * sage-mem autodream —— 再导出层。
 *
 * 实现按关注点拆到 `lib/autodream/` 下（引擎本体在 `autodream/engine.js`）。
 * 这一层只为保持外部导入面不变：`import { AutodreamEngine } from './autodream.js'` 照旧可用。
 */

export { AutodreamEngine } from './autodream/engine.js'
// 组合根的本地 import 有 ≤20 条的条数护栏（`test/structure-test.mjs`「依赖面不许发散」）。
// 体检与默认配置本来就是 autodream 这一域的一部分，从这层转出（本文件的存在意义就是
// 让外部只认一个入口），组合根因此不必再多两条 import —— 不是给组合根找捷径。
export { auditMemoryDir } from './autodream/audit.js'
export { DEFAULT_CONFIG } from './autodream/config.js'
