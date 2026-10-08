/**
 * autodream —— 配置默认值与全部常量。
 *
 * 改名兼容（`dream` → `autodream`）用到的旧目录 / 旧文件名常量也在这儿，
 * **一个都不能删**：它们是旧数据仍能被读到、被回滚的唯一依据。
 */

/** 配置结构版本：将来加字段时用来做迁移。v2 = 改名 autodream + 回滚点 + 声明。 */
export const CONFIG_VERSION = 2

/** 默认配置。每一项都能从设置面板改；空 provider/model 表示跟聊天页当前默认模型。 */
export const DEFAULT_CONFIG = {
  enabled: false,
  trigger: 'manual',
  apply: false,
  source: 'memory',
  minHours: 24,
  minSessions: 5,
  provider: '',
  model: '',
  maxSteps: 24,
  maxSnapshotKeep: 5,
  /** 回滚按钮的默认范围：files = 只恢复该次运行动过的文件；all = 整目录恢复到该时点。 */
  rollbackScope: 'files',
  /**
   * 归档策略：off = 什么都不做；report = 只把候选写进报告（**默认，一个文件都不动**）；
   * auto = 运行末尾真的把候选移进 `archive/`（只移不删）。
   * 默认最保守：归档是不可逆的退役动作，先让人看见清单，再决定要不要自动。
   */
  autoArchive: 'report',
  /**
   * 自动归档阈值（天，按类型差异化）。feedback 没有阈值 —— 它**永不进候选**。
   * 保守默认：project 90 / reference 180 / user 365。
   */
  archiveAfterDaysProject: 90,
  archiveAfterDaysReference: 180,
  archiveAfterDaysUser: 365,
}

/**
 * 会话门的扫描节流（10 分钟）。
 *
 * 为什么需要它：时间门过了、会话门没过时，状态里的 lastRunAt 不会前进，
 * 于是每一次触发都会重新扫一遍整个 sessions 目录。
 * 节流把「看着像没过」和「真的没过」区分开——这中间的成本差异全是白烧的盘 IO。
 */
export const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000

/** 自动模式的检查间隔。门控本身很便宜（有节流），所以这个频率是安全的。 */
export const SCHEDULE_INTERVAL_MS = 30 * 60 * 1000

/** 启动后第一次自动检查的延迟——避开 DSH 启动时的那阵忙碌。 */
export const STARTUP_CHECK_DELAY_MS = 90 * 1000

/** 锁的失效时间：超过这个时长还挂着的锁，认定是上次进程崩了留下的。 */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000

/** 失败后的退避：别让一个每次都失败的任务把门控刷成高频重试。 */
export const FAILURE_BACKOFF_MS = 60 * 60 * 1000

/** 报告目录名（相对 memory 根）。放在子目录里，所以不会被 sage-mem 自己扫成记忆。 */
export const REPORT_DIR = 'autodream'

/** 改名前的报告目录。只读兼容：老报告还能在面板里翻到，但不再往里写。 */
export const LEGACY_REPORT_DIR = 'dream'

/** 状态根目录名（相对 memory 根的上一层）。 */
export const STATE_DIR = '.sage-mem'

/** 本功能在状态根下的私有目录（运行记录、回滚点、锁、留痕）。 */
export const FEATURE_DIR = 'autodream'

/** 改名前的状态文件名（`<stateRoot>/dream.json`），只在迁移时读一次。 */
export const LEGACY_STATE_FILE = 'dream.json'

/** 改名前的快照根（`<stateRoot>/snapshots/`），只读兼容。 */
export const LEGACY_SNAPSHOT_DIR = 'snapshots'

/** 「回滚前保护快照」单独保留的份数——它不该被普通运行的快照轮转挤掉。 */
export const PRE_ROLLBACK_KEEP = 3

/** 一次 autodream 允许累计的输入 token 上限（软保护，超了就停）。 */
export const DEFAULT_TOKEN_BUDGET = 600000
