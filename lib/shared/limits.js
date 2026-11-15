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

/**
 * 体积治理的四条线（2.10.0）。
 *
 * 为什么也放这个文件：`duplication-test.mjs` 的规矩是「同一个数只许一处定义，别处只
 * import」，而这四条会被四片同时引用（判据 / 裁剪 / 审计 / 工具回执）。挨着 512 KB
 * 那条摆，谁要改都只看一个文件。
 *
 * ⚠️ 与上面两条的关系：那是**硬闸门**（超了就拒绝写，行为不可变），这四条是**软线**
 * （超了只提醒、只记一笔、审计里算一条问题）。两者绝不能合并 —— 硬闸门动一下就是
 * 数据行为变更，软线调一下只影响文案。
 */

/** 单条记忆的**提醒**线：到这个量级开始建议处置（裁段归档 / 压缩）。 */
export const TRIM_WARN_BYTES = 8 * 1024

/** 单条记忆的**强制**线：自动整理这一趟必须处置，否则审计算一条问题。 */
export const TRIM_FORCE_BYTES = 16 * 1024

/**
 * 索引单行字符上限。超了基本等于「一行里塞了正文」—— 索引只该有一行一条的指针
 * （`- [标题](文件名) —— 一句描述`），正文留在记忆正文里。
 */
export const INDEX_LINE_CHARS = 240

/** 索引整份字节上限。到顶即 `force`；它的一半（12 KB）先给 `warn`。 */
export const INDEX_DOC_BYTES = 24 * 1024
