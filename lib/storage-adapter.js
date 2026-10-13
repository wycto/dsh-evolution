/**
 * dsh-evolution — 存储适配层
 *
 * 插件的数据只有两块：**账本**（会话事件流）与**洞察**（跨会话经验）。
 * 在本模块出现之前，"怎么存"散落在两处：index.js 直接 new 两个 store 类，
 * 而"一个后端要实现哪些方法、每个方法要保住哪些行为"只能去读类的源码。
 * 对接数据库（config.database.*）或服务接口（config.api.*）时，最贵的不是
 * 写新后端，而是没人说得清上面的两件事 —— 这里把契约显式化：
 *
 *   1. `LEDGER_BACKEND_METHODS` / `INSIGHTS_BACKEND_METHODS`：后端必须实现的
 *      方法清单（冒烟测试校验"清单 ⊆ 文件实现"，防止两边漂移）。
 *   2. 下面的 JSDoc typedef：每个方法的**行为语义**。新后端漏掉任何一条
 *      （比如"写失败必须保缓冲、绝不拖垮宿主"）都会以用户数据为代价，
 *      不是风格问题。
 *   3. `createStorage()`：唯一的装配点。调用方不再认识具体实现类，
 *      将来换后端只改这里。
 *
 * 现状与边界（对齐 DESIGN 决策 4 及其新增的数据库决策）：
 *   - **默认实现是本地文件**（LedgerStore / InsightsStore），行为与历史版本一致。
 *   - `database.enabled + driver='sqlite'` → SQLite 后端（`lib/storage-sqlite.js`，
 *     node:sqlite 零依赖）。初始化失败（磁盘/老版本 Node）**显式告警后回退文件**，
 *     绝不让插件起不来。`postgres` 驱动尚未实现（契约见 docs/DB-CONTRACT.md）。
 *   - 后端选择在**创建时**读一次配置，运行中改配置需重启生效。刻意不做热切换：
 *     两个 store 都持有未落盘缓冲与内存索引，热切换等于中途换真相源。
 *
 * ⚠️ 维护纪律：给两个 store 类**新增或改名公开方法 = 扩契约**，
 * 必须同步本模块的方法清单与 typedef，冒烟测试会拦截遗漏。
 */
import { InsightsStore } from './insights-store.js'
import { LedgerStore } from './ledger-store.js'
import { str } from './paths.js'
import {
  SqliteInsightsStore, SqliteLedgerStore,
  migrateFromFiles, resolveSqlitePath, sanitizeTablePrefix,
} from './storage-sqlite.js'
import { RemoteInsightsStore, RemoteLedgerStore } from './storage-remote.js'

/**
 * 账本后端的完整行为契约。
 *
 * 与文件实现的对应关系：一行一事件的 NDJSON、按天分片只是**当前实现**，
 * 不是契约本身；契约是下面这些方法的行为语义。
 *
 * @typedef {object} LedgerBackend
 * @property {() => string} dir - 数据位置（绝对路径或等价描述）。面板会原样展示给用户，"我的数据在哪"必须可回答。
 * @property {(record: object) => void} add - 登记一条账本记录。**同步、热路径**（session/event 回调里逐条触发）：不允许 await、不允许因后端 IO 慢而阻塞宿主，也不允许抛异常 —— 后端自行缓冲，见 flushSession。
 * @property {(sessionId: string) => Promise<void>} flushSession - 把某个会话的缓冲落盘。失败时**必须保留缓冲**（下次再试）、把错误记到 `lastError`，绝不向调用方抛。
 * @property {() => Promise<void>} flushAll - 落盘全部会话缓冲（卸载/退出前调用）。
 * @property {() => void} dispose - 释放定时器等资源（卸载时调用）。之后实例不再使用。
 * @property {(retentionDays: number) => Promise<{removed: number, scanned: number}>} prune - 清理超过保留期的数据。0 = 永久保留。这是**删除用户数据**的操作：只删整片过期（按天为单位），失败逐条记录、不中断。
 * @property {() => Promise<string[]>} listDays - 已有的账本日期（YYYY-MM-DD，倒序）。
 * @property {(options?: {days?: number, sessionId?: string, limit?: number}) => Promise<{records: object[], total: number, badLines: number, days: string[]}>} query - 查询记录。days<=0 表示不限；截断时**保留最近的** limit 条（limit<=0 = 空结果，两后端同口径）；`badLines` 如实上报损坏条数（不许静默丢，也不许一行坏数据清空整个结果）。
 * @property {() => Promise<{days: number, firstDay: string, lastDay: string, records: number, sessions: number, badLines: number, pendingBuffered: number, written: number, lastError: string}>} stats - 汇总统计（面板总览）。
 * @property {() => number} pendingBuffered - 还在内存缓冲、尚未落盘的记录数（面板显示"待落盘"）。
 * @property {string} lastError - 最近一次写入错误（面板可见，绝不静默）。无错误为空串。
 * @property {number} written - 本次进程累计落盘条数（面板显示）。
 */

/**
 * 洞察后端的完整行为契约。
 *
 * 数据语义上最重要的是：**追加式操作日志是真相源，"当前状态"只是重放结果**
 * （文件实现里是 insights.ndjson + index.json，见 insights-store.js 头注释）。
 * 任何后端都必须保住这条等价关系：日志里记录"发生过什么"，可随时重放出当前状态。
 *
 * @typedef {object} InsightsBackend
 * @property {() => string} dir - 数据位置（同账本契约）。
 * @property {() => Promise<InsightsBackend>} load - 从真相源加载。**每次调用都必须重放**，绝不允许"加载过就跳过"：同进程可能有多个实例，任何缓存快照都会读到旧数据（表现为面板有、操作 404）。
 * @property {(root?: string) => Promise<InsightsBackend>} replay - 强制重放（"重建索引"与写操作前的自愈走这里）。
 * @property {(options?: {includeArchived?: boolean}) => object[]} list - 当前全部条目。**必须深拷贝**（至少 evidence 数组）：调用方会修改返回值。
 * @property {(id: string) => (object | undefined)} get - 按 id 取单条（深拷贝，理由同 list）。
 * @property {(insights: object[], options?: {reason?: string}) => Promise<{added: object[], merged: object[], rejected: object[]}>} upsert - 写入一批新观察。核心是**去重合并**：归一化标题 → 键，同键（或相似）的第 N 次出现 = recurrence +1、证据归并、人工状态（pinned/accepted/archived）永不被自动流程覆盖。
 * @property {(entries: object[], options?: {reason?: string}) => Promise<{added: object[], skipped: number}>} importEntries - 导入一批条目（导出 JSON 的恢复语义）：按 id 插入-或-跳过、字段原样保留、重复导入零副作用。与 upsert 的"合并 = 复现 +1"刻意不同。
 * @property {(id: string, patch: object, options?: {reason?: string}) => Promise<(object | undefined)>} mutate - 人工操作（置顶/采纳/归档/改类型/改作用域/删除，patch.deleted=true 表示删）。返回更新后的条目；不存在返回 undefined。
 * @property {(fromId: string, toId: string, options?: {reason?: string}) => Promise<object>} merge - 把一条合并进另一条（面板手动去重）。
 * @property {(id: string, toScope: string, options?: object) => Promise<object>} migrate - 迁移作用域（晋升/退回）。晋升必须留下来源记录（promotedFrom），用户要能看到"这条本来只属于哪"，并据此退回。
 * @property {(options?: {minRecurrence?: number, excludePerson?: boolean}) => {eligible: object[], skipped: {id: string, title: string, reason: string}[], minRecurrence: number}} promotionCandidates - 列出够格/不够格跨作用域晋升的候选与原因。**只列不做**：自动聚合跨仓库数据被 DESIGN 决策 5 明确否决。
 * @property {(ids: string[]) => Promise<void>} noteInjected - 记录"这批条目被注入过一次"（injectedCount +1）。只是统计，失败不影响注入。
 * @property {(sessionIds: string[]) => Promise<string[]>} removeBySessions - 删除来源会话（含证据引用）属于这批会话的全部条目，返回受影响的 id。
 * @property {(options?: {archiveTo?: string}) => Promise<{removed: number, archivedTo: string}>} clearAll - 清空全部洞察。**必须留档**（日志轮转），不是静默删除。
 * @property {() => {total: number, active: number, archived: number, pinned: number, accepted: number, withEvidence: number, recurred: number, byType: object, byScope: object, lastError: string, badLines: number, appended: number, logFile: string, backfilled: object}} stats - 汇总统计。
 * @property {() => Promise<void>} rebuildIndex - 从真相源重建派生索引。索引任何时候都只是缓存，删掉必须能重建。
 * @property {() => void} dispose - 释放资源（卸载时调用；文件实现是空操作，SQLite 实现关闭连接）。
 * @property {string} lastError - 最近一次读写错误（面板可见）。无错误为空串。
 */

/** 账本后端必须实现的方法清单（与 LedgerBackend typedef 一一对应）。 */
export const LEDGER_BACKEND_METHODS = Object.freeze([
  'dir', 'add', 'flushSession', 'flushAll', 'dispose', 'prune',
  'listDays', 'query', 'stats', 'pendingBuffered',
])

/** 洞察后端必须实现的方法清单（与 InsightsBackend typedef 一一对应）。 */
export const INSIGHTS_BACKEND_METHODS = Object.freeze([
  'dir', 'load', 'replay', 'list', 'get', 'upsert', 'importEntries', 'mutate', 'merge', 'migrate',
  'promotionCandidates', 'noteInjected', 'removeBySessions', 'clearAll',
  'stats', 'rebuildIndex', 'dispose',
])

/**
 * 检查一个实现缺了哪些契约方法。给写新后端的人（和冒烟测试）用：
 * 返回空数组才算"是一个 LedgerBackend / InsightsBackend"。
 * @param impl - 候选实现。
 * @param methods - 契约方法清单。
 */
export function findMissingBackendMethods(impl, methods) {
  const missing = []
  for (const name of methods) {
    if (typeof impl?.[name] !== 'function') missing.push(name)
  }
  return missing
}

/**
 * 创建存储层。**全插件唯一的装配点**：调用方只认识这里返回的两个对象，
 * 不 import 任何具体实现类。
 *
 * @param options.getRootDir - () => string，数据根目录（配置可能变，所以是函数）。
 * @param options.getConfig - () => object，当前配置（后端选择在这里读）。
 * @param options.logger - 宿主 logger（可选）。
 * @returns {{backend: string, ledger: LedgerBackend, insights: InsightsBackend, migration?: Promise<object>}}
 *   `migration` 仅 SQLite 后端存在：存量文件一次性导入的 Promise（结果对象
 *   {ledgerRecords, ledgerDays, insightOps, errors}）。不 await 也安全（ops 按
 *   seq 导入，重放顺序不受影响）；测试想要确定性时可以 await 它。
 */
export function createStorage(options = {}) {
  const getRootDir = options.getRootDir ?? (() => '')
  const logger = options.logger
  const getConfig = options.getConfig ?? (() => ({}))
  const db = getConfig()?.database
  const api = getConfig()?.api

  if (db?.enabled === true) {
    // database.* 是显式开关（默认关）。SQLite 已落地；初始化失败必须出声并
    // 回退文件 —— 数据写不进用户选的后端可以接受，静默假装生效不行。
    if (db.driver === 'sqlite') {
      let ledger = null
      try {
        const dbFile = resolveSqlitePath(db.sqlitePath, getRootDir())
        const tablePrefix = sanitizeTablePrefix(db.tablePrefix, logger)
        ledger = new SqliteLedgerStore({ getRootDir, logger, dbFile, tablePrefix })
        const insights = new SqliteInsightsStore({ getRootDir, logger, dbFile, tablePrefix })
        const migration = migrateFromFiles(ledger.db, getRootDir(), tablePrefix, logger)
          .catch((error) => {
            logger?.warn?.(`[dsh-evolution] 存量数据导入失败（不影响新数据写入）：${error?.message ?? String(error)}`)
            return { ledgerRecords: 0, ledgerDays: 0, insightOps: 0, errors: [String(error)] }
          })
        return { backend: 'sqlite', ledger, insights, migration }
      } catch (error) {
        // 部分构造失败（比如 ledger 成了、insights 没成）必须把已开的连接关掉，
        // 否则回退到文件后端后，那个 SQLite 句柄会一直挂着
        ledger?.dispose?.()
        logger?.warn?.(`[dsh-evolution] SQLite 后端初始化失败，回退本地文件：${error?.message ?? String(error)}`)
      }
    } else {
      logger?.warn?.(`[dsh-evolution] database.driver=${db.driver} 尚未实现（见 docs/DB-CONTRACT.md）：本次运行仍使用本地文件存储`)
    }
  }

  // 远程存储后端（DESIGN 决策 8）：api.enabled + api.storageBackend + baseUrl
  // 三者同时就位才生效 —— 这是"把数据整体交给那台服务"的显式动作，缺任何
  // 一个条件都回退本地文件并出声，绝不静默。
  if (api?.storageBackend === true && db?.enabled !== true) {
    const baseUrl = str(api.baseUrl)
    if (api.enabled !== true) {
      logger?.warn?.('[dsh-evolution] api.storageBackend=true 但 api.enabled 未开，忽略（仍使用本地文件存储）')
    } else if (baseUrl === '') {
      logger?.warn?.('[dsh-evolution] api.storageBackend=true 但 api.baseUrl 为空，忽略（仍使用本地文件存储）')
    } else {
      const tokenEnv = str(api.tokenEnv) || 'DSH_EVOLUTION_TOKEN'
      const token = str(process.env?.[tokenEnv])
      if (token === '') {
        logger?.warn?.(`[dsh-evolution] 远程存储未设置 token（环境变量 ${tokenEnv} 为空）——服务端若要求鉴权将全部 401`)
      }
      try {
        const remote = { logger, baseUrl, token, timeoutMs: api.timeoutMs }
        const ledger = new RemoteLedgerStore({ ...remote, getRootDir })
        const insights = new RemoteInsightsStore(remote)
        logger?.info?.(`[dsh-evolution] 存储后端：远程（${baseUrl}）。数据将整体读写到该服务 —— 关闭 api.storageBackend 并重启可回退本地。`)
        return { backend: 'remote', ledger, insights }
      } catch (error) {
        logger?.warn?.(`[dsh-evolution] 远程存储后端初始化失败，回退本地文件：${error?.message ?? String(error)}`)
      }
    }
  }

  return {
    backend: 'file',
    ledger: new LedgerStore({ getRootDir, logger }),
    insights: new InsightsStore({ getRootDir, logger }),
  }
}
