/**
 * 两个体积上限的**唯一**来源（零依赖，host / manifest / 引擎共用）。
 *
 * 为什么单独抽：512 KB 那条同时出现在 `memory/config.js`、`typert.host.js` 的
 * `fileContentSchema` 与注释里；4 MB 那条出现在设置工具与 manifest 的
 * `rawFileContentSchema`。它们**必须相等** —— 传输层比写入层紧，用户就会收到
 * "面板能存、remote 存不进去"的怪现象；比写入层松，则超限内容会穿过闸门。
 */

/** 单条记忆的上限（512 KB）。`writeFile` / 读取闸门 / manifest 三处同一把尺子。 */
export const MAX_FILE_BYTES = 512 * 1024

/**
 * 保留名原样读写的上限（4 MB）。**故意不复用 512 KB**：
 * `session-log.md` 是追加型流水，天然比单条记忆大得多，沿用小上限 = 用户永远存不回去。
 */
export const MAX_RAW_BYTES = 4 * 1024 * 1024
