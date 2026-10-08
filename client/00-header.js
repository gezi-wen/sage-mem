/**
 * sage-mem — 界面侧：DSH 设置页「记忆管理」界面（文件管理器）。
 *
 * 手写 ModuleLoader bundle（`window.__ModuleLoader__.load({ id, factory })` 格式）：
 * window.__ModuleLoader__.load({ id, factory })，factory 内 require('react')
 * 可用，module.exports 导出标准 Cordis 插件（apply/inject）。
 *
 * 数据通道：TypertRemoteService（宿主侧 MemoryGateway），通过
 * ctx.get("remote.memory") 调用文件列表/读/写/删。remote 返回 {ok, value}
 * 信封。浏览器侧无 zod，schema 手写（codec 只要求 mode==="strict" + parse）。
 *
 * 功能：浏览 memory 目录的 markdown 记忆文件（类型徽章 + 描述预览）、
 * 查看/编辑全文、两步确认删除、添加新记忆（选类型 + 描述 + 正文）。
 */

window.__ModuleLoader__.load({
	id: "sage-mem",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;

