/**
 * 注入链的公开面（1.2.0 的模块边界）。
 *
 * 组合根只通过这个 barrel 认识注入链：它不需要知道选材 / 渲染 / 预算分在几个文件里，
 * 也不该直接 import 内部碎片 —— 这样将来再拆一个文件，组合根不用跟着改。
 *
 * 各函数的行为由 `test/recall-golden-test.mjs`（11 个场景逐字节）与
 * `test/recall-unit-test.mjs`（直接喂夹具）守着。
 */
export { createSessionInjectState } from './state.js'
export { createRecallInjector } from './injector.js'
export { dedupeByFile, selectRecall } from './select.js'
export { buildCandidates, composeDelivery, composeStatus } from './compose.js'
export { composeRecallText } from './text.js'
export { debugEnabled, debugRecall, readRecallDebug } from './debug.js'
