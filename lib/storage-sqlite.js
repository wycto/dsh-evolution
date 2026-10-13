/**
 * dsh-evolution — SQLite 存储后端（`database.driver = 'sqlite'`）
 *
 * **子类化而不是重写**：文件实现（LedgerStore / InsightsStore）把"业务语义"
 * （缓冲、去重合并、晋升、串行化）与"落到哪"（NDJSON 文件）分得很开，所以
 * SQLite 后端只覆盖持久层，其余全部继承 —— 合并、撞名仓库、promotedFrom
 * 恢复这些踩过坑的语义自动保持一致，不会出现"两套实现漂移"。
 *
 * 洞察库的真相源等价替换（对应 docs/DB-CONTRACT.md §2.3）：
 *   文件形态：insights.ndjson（真相源，追加）+ index.json（派生快照）
 *   SQLite 形态：{prefix}insight_ops 表（真相源，追加）+ 内存重放（load 每次都重放）
 * `saveIndex()` 因此退化为空操作 —— 重放本身就是"索引"，且永远最新。
 *
 * 账本同理：按天分片的 NDJSON 换成单表，按 `day` 列切片，查询语义
 * （days/sid/limit、截断保留最近、坏行如实上报）与文件实现逐条对齐。
 *
 * 驱动：`node:sqlite`（Node 标准库，零依赖；需要 Node ≥ 22.13 的未挂 flag 版本）。
 * ⚠️ 它是**延迟解析**的（`getDatabaseSync()`，不用静态 import）：node:sqlite 在
 * 22.0–22.12 的 Node 上不存在，静态 import 会让"没用数据库的普通用户"插件都
 * 装不上 —— 延迟到真正开启 SQLite 后端时才解析，文件模式永远零影响。
 * 配置：`database.enabled + database.driver='sqlite'`，默认关；开启后数据库
 * 就是这一份数据的真相源（NDJSON 文件不再被读写），`migrateFromFiles()` 会在
 * 首次启用时把旧文件一次性导入，原文件保留不动（可随时删库回退）。
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { LedgerStore } from './ledger-store.js'
import {
  InsightsStore, INSIGHTS_LOG_VERSION, applyOp, insightsLogFile,
} from './insights-store.js'
import { dayKey, readNdjson, retentionCutoff } from './storage.js'
import { ledgerDir, str } from './paths.js'

const nodeRequire = createRequire(import.meta.url)

/** node:sqlite 延迟解析（理由见文件头）。解析失败给一条能看懂的错误。 */
let cachedDatabaseSync
function getDatabaseSync() {
  if (cachedDatabaseSync === undefined) {
    try {
      cachedDatabaseSync = nodeRequire('node:sqlite').DatabaseSync
    } catch (error) {
      throw new Error(
        `当前 Node（${process.version}）没有可用的 node:sqlite（需要 ≥ 22.13）：${error?.message ?? String(error)}`,
      )
    }
  }
  return cachedDatabaseSync
}

/** 默认表名前缀（与 config.js 的 database.tablePrefix 默认值一致）。 */
export const SQLITE_DEFAULT_PREFIX = 'dsh_evolution_'

/** 表名前缀只允许安全字符：它会被拼进 DDL，不能当注入入口。 */
const PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 规整表名前缀。非法值**回退默认并告警**，绝不抛 —— 装配发生在插件启动路径上，
 * 一个坏前缀不该让整个插件起不来。
 */
export function sanitizeTablePrefix(raw, logger) {
  const s = str(raw) || SQLITE_DEFAULT_PREFIX
  if (!PREFIX_RE.test(s)) {
    logger?.warn?.(`[dsh-evolution] database.tablePrefix 含非法字符（只允许字母/数字/下划线），回退为 ${SQLITE_DEFAULT_PREFIX}`)
    return SQLITE_DEFAULT_PREFIX
  }
  return s
}

/**
 * 解析 SQLite 文件路径：显式配置优先，否则 `<dataDir>/index.sqlite`。
 * 相对路径**锚定数据根目录**而不是进程 cwd：cwd 取决于宿主怎么启动的，
 * 锚定它会让"换个方式启动，数据库文件就换位置"，表现为重启后数据"全空"。
 * 数据相关的一切都以数据根目录为锚 —— 这才是可解释、可打印的口径。
 */
export function resolveSqlitePath(sqlitePath, rootDir) {
  const explicit = str(sqlitePath)
  if (explicit === '') return join(rootDir, 'index.sqlite')
  return isAbsolute(explicit) ? explicit : resolve(rootDir, explicit)
}

// ---------------------------------------------------------------------------
// 账本记录 ↔ 行 的双向映射
//
// 列只收纳"查询会用到/聚合会用到"的已知字段，其余全部塞进 extra JSON 列。
// 这样账本记录将来加字段（foldEvent 演进）不需要迁移表结构。
// 映射纪律：**与 NDJSON 落盘逐字节同构** —— undefined 键在 NDJSON 里本来就会
// 被 JSON.stringify 丢掉，这里用 NULL 表示、读回时同样不还原该键。
// ---------------------------------------------------------------------------

const LEDGER_KNOWN_KEYS = new Set([
  'sid', 'seq', 'ts', 'day', 'kind', 'turn', 'text', 'tool',
  'status', 'errorCode', 'errorStatus', 'failed',
  'tokensIn', 'tokensOut', 'tokensCacheRead',
])

const numOrZero = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)
const textOrNull = (v) => (typeof v === 'string' ? v : null)

/** 账本记录 → 行参数。顺序必须与 INSERT 列顺序一致。 */
export function sqliteLedgerRow(rec) {
  const extra = {}
  for (const [k, v] of Object.entries(rec ?? {})) {
    if (!LEDGER_KNOWN_KEYS.has(k) && v !== undefined) extra[k] = v
  }
  return [
    String(rec?.sid ?? ''),
    numOrNull(rec?.seq),
    numOrZero(rec?.ts) || Date.now(),
    str(rec?.day) || dayKey(rec?.ts),
    str(rec?.kind),
    numOrNull(rec?.turn),
    textOrNull(rec?.text),
    textOrNull(rec?.tool),
    textOrNull(rec?.status),
    textOrNull(rec?.errorCode),
    numOrNull(rec?.errorStatus),
    typeof rec?.failed === 'boolean' ? (rec.failed ? 1 : 0) : null,
    typeof rec?.tokensIn === 'number' ? numOrZero(rec.tokensIn) : null,
    typeof rec?.tokensOut === 'number' ? numOrZero(rec.tokensOut) : null,
    typeof rec?.tokensCacheRead === 'number' ? numOrZero(rec.tokensCacheRead) : null,
    Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
  ]
}

/** 行 → 账本记录。NULL = 这个键不存在（与 NDJSON 往返一致）。 */
export function rowToLedgerRecord(row) {
  const rec = { sid: row.sid, ts: row.ts, day: row.day, kind: row.kind }
  if (row.seq !== null) rec.seq = row.seq
  if (row.turn !== null) rec.turn = row.turn
  if (row.text !== null) rec.text = row.text
  if (row.tool !== null) rec.tool = row.tool
  if (row.status !== null) rec.status = row.status
  if (row.error_code !== null) rec.errorCode = row.error_code
  if (row.error_status !== null) rec.errorStatus = row.error_status
  if (row.failed !== null) rec.failed = row.failed === 1
  if (row.tokens_in !== null) rec.tokensIn = row.tokens_in
  if (row.tokens_out !== null) rec.tokensOut = row.tokens_out
  if (row.tokens_cache_read !== null) rec.tokensCacheRead = row.tokens_cache_read
  if (row.extra !== null) {
    // 逐键赋值且过滤危险键：Object.assign 会走 [[Set]]，extra 里出现
    // "__proto__" 之类的键会改写 rec 的原型（文件版没有这个路径）
    for (const [k, v] of Object.entries(JSON.parse(row.extra))) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      rec[k] = v
    }
  }
  return rec
}

function ledgerDdl(prefix) {
  return `
CREATE TABLE IF NOT EXISTS "${prefix}ledger_events" (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sid               TEXT    NOT NULL,
  seq               INTEGER,
  ts                BIGINT  NOT NULL,
  day               TEXT    NOT NULL,
  kind              TEXT    NOT NULL,
  turn              INTEGER,
  text              TEXT,
  tool              TEXT,
  status            TEXT,
  error_code        TEXT,
  error_status      INTEGER,
  failed            INTEGER,
  tokens_in         BIGINT,
  tokens_out        BIGINT,
  tokens_cache_read BIGINT,
  extra             TEXT
);
CREATE INDEX IF NOT EXISTS "idx_${prefix}ledger_day" ON "${prefix}ledger_events" (day);
CREATE INDEX IF NOT EXISTS "idx_${prefix}ledger_sid" ON "${prefix}ledger_events" (sid, ts);
CREATE INDEX IF NOT EXISTS "idx_${prefix}ledger_kind" ON "${prefix}ledger_events" (kind);`
}

function insightsDdl(prefix) {
  return `
CREATE TABLE IF NOT EXISTS "${prefix}insight_ops" (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      BIGINT NOT NULL,
  op      TEXT   NOT NULL,
  id      TEXT,
  payload TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_${prefix}ops_op" ON "${prefix}insight_ops" (op);`
}

// ---------------------------------------------------------------------------
// 账本后端
// ---------------------------------------------------------------------------

/**
 * SQLite 账本。缓冲、add 的同步纪律、失败保缓冲全部继承自 LedgerStore；
 * 这里只把"落盘到 NDJSON"换成"事务批量 INSERT"，读路径换成 SQL。
 */
export class SqliteLedgerStore extends LedgerStore {
  /**
   * @param options.dbFile - SQLite 文件绝对路径（已由 resolveSqlitePath 解析）。
   * @param options.tablePrefix - 已规整的表名前缀。
   */
  constructor(options = {}) {
    super(options)
    this.dbFile = options.dbFile
    this.tablePrefix = options.tablePrefix ?? SQLITE_DEFAULT_PREFIX
    mkdirSync(dirname(this.dbFile), { recursive: true })
    const DatabaseSync = getDatabaseSync()
    this.db = new DatabaseSync(this.dbFile)
    // WAL：同一份数据会有多个连接（账本 + 洞察各一），WAL 允许读写并发；
    // busy_timeout 给"另一连接正在写"的场景一个短暂等待，而不是立刻抛 SQLITE_BUSY。
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec(ledgerDdl(this.tablePrefix))
  }

  /** 数据位置：SQLite 模式下面板显示的就是这个文件。 */
  dir() {
    return this.dbFile
  }

  /** 覆盖落盘：与基类同一套缓冲管理（失败保回缓冲、记 lastError），写入换事务。 */
  async flushSession(sessionId) {
    const buf = this.buffers.get(sessionId)
    if (buf === undefined || buf.records.length === 0) {
      if (buf !== undefined && buf.timer !== undefined) {
        clearTimeout(buf.timer)
        buf.timer = undefined
      }
      return
    }
    const pending = buf.records
    buf.records = []
    if (buf.timer !== undefined) {
      clearTimeout(buf.timer)
      buf.timer = undefined
    }

    let began = false
    try {
      const table = `"${this.tablePrefix}ledger_events"`
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      const stmt = this.db.prepare(
        `INSERT INTO ${table}
          (sid, seq, ts, day, kind, turn, text, tool, status, error_code, error_status, failed, tokens_in, tokens_out, tokens_cache_read, extra)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const rec of pending) stmt.run(...sqliteLedgerRow(rec))
      this.db.exec('COMMIT')
      began = false
      this.written += pending.length
      this.lastError = ''
    } catch (error) {
      // 只在确实开了事务时回滚 —— 否则 catch 可能拆掉别人（比如迁移）打开的事务
      if (began) { try { this.db.exec('ROLLBACK') } catch { /* 本就没开事务 */ } }
      // 与基类同一纪律：写失败保缓冲（超上限丢最老），错误进面板
      const merged = [...pending, ...buf.records]
      buf.records = merged.length > 5000 ? merged.slice(merged.length - 5000) : merged
      this.lastError = `写账本失败：${error?.message ?? String(error)}`
      this.logger?.warn?.(`[dsh-evolution] ${this.lastError}`)
    }
  }

  /** 已有账本日期（倒序）。与文件实现同口径：YYYY-MM-DD 字符串序即时间序。 */
  async listDays() {
    const rows = this.db.prepare(
      `SELECT DISTINCT day FROM "${this.tablePrefix}ledger_events" ORDER BY day DESC`,
    ).all()
    return rows.map((r) => r.day)
  }

  /**
   * 查询。语义与文件版逐条对齐：days>0 只看最近 N 天；截断保留**最近**的
   * limit 条（limit<=0 = 空结果，与文件版 slice 口径一致）；结果按时间正序。
   * extra 列解析失败**只丢那一行**并计入 badLines（契约：不许静默丢，
   * 也不许一行坏数据把整个查询变成空结果 —— 文件版同一纪律）。
   */
  async query(options = {}) {
    const { days = 7, sessionId = '', limit = 20000 } = options
    const allDays = await this.listDays()
    const selected = days > 0 ? allDays.slice(0, days) : allDays
    const table = `"${this.tablePrefix}ledger_events"`

    const wheres = []
    const params = []
    if (selected.length > 0 && selected.length < allDays.length) {
      wheres.push(`day IN (${selected.map(() => '?').join(',')})`)
      params.push(...selected)
    }
    if (sessionId !== '') {
      wheres.push('sid = ?')
      params.push(sessionId)
    }
    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''

    const total = this.db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} ${whereSql}`,
    ).get(...params)?.n ?? 0

    // 取"最近 limit 条"：倒序拿再翻回正序，与文件版"从新往旧保留"一致。
    // limit<=0 与文件版同口径：文件版 slice(len - 0) 恰为空，即"最多返回 0 条"。
    const lim = Math.trunc(limit)
    if (lim <= 0) return { records: [], total, badLines: 0, days: selected }
    const rows = this.db.prepare(
      `SELECT * FROM ${table} ${whereSql} ORDER BY ts DESC, id DESC LIMIT ?`,
    ).all(...params, lim)
    const records = []
    let badRows = 0
    for (const row of rows) {
      try {
        records.push(rowToLedgerRecord(row))
      } catch (error) {
        badRows += 1
        this.lastError = `解析账本 extra 列失败（该行已跳过）：${error?.message ?? String(error)}`
      }
    }
    records.reverse()
    return { records, total, badLines: badRows, days: selected }
  }

  /** 清理过期分片。与文件版同口径（本地时区截止日）：0=永不删；removed 按"天"计数。 */
  async prune(retentionDays) {
    const days = Math.trunc(Number(retentionDays ?? 0))
    if (!Number.isFinite(days) || days <= 0) return { removed: 0, scanned: 0 }
    const all = await this.listDays()
    const cutoff = retentionCutoff(days)
    const victims = all.filter((d) => d < cutoff)
    if (victims.length === 0) return { removed: 0, scanned: all.length }
    try {
      this.db.prepare(`DELETE FROM "${this.tablePrefix}ledger_events" WHERE day < ?`).run(cutoff)
      return { removed: victims.length, scanned: all.length }
    } catch (error) {
      this.lastError = `清理过期账本失败（< ${cutoff}）：${error?.message ?? String(error)}`
      return { removed: 0, scanned: all.length }
    }
  }

  /** 汇总统计。字段与文件版完全一致，数据从聚合查询来。 */
  async stats() {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS records,
              COUNT(DISTINCT CASE WHEN sid != '' THEN sid END) AS sessions,
              COUNT(DISTINCT day) AS days,
              MIN(day) AS firstDay,
              MAX(day) AS lastDay
         FROM "${this.tablePrefix}ledger_events"`,
    ).get() ?? {}
    return {
      days: row.days ?? 0,
      firstDay: row.firstDay ?? '',
      lastDay: row.lastDay ?? '',
      records: row.records ?? 0,
      sessions: row.sessions ?? 0,
      badLines: 0,
      pendingBuffered: this.pendingBuffered(),
      written: this.written,
      lastError: this.lastError,
    }
  }

  /** 释放定时器并关闭连接（卸载时调用）。 */
  dispose() {
    super.dispose()
    try { this.db.close() } catch { /* 已关闭 */ }
  }
}

// ---------------------------------------------------------------------------
// 洞察后端
// ---------------------------------------------------------------------------

/**
 * SQLite 洞察库。**全部业务语义继承自 InsightsStore**（去重合并、相似度兜底、
 * 撞名仓库、晋升/退回、写串行化），只替换两件事：
 *   · `appendOp`：INSERT 进 ops 表（真相源，只追加）；
 *   · `replay`：按 seq 重放 ops 表。
 * `saveIndex` 退化为空操作：SQLite 模式下"索引"就是每次 load 的重放结果，
 * 崩溃不会损坏任何东西（单条 INSERT 原子），也永远不需要"重建文件"。
 */
export class SqliteInsightsStore extends InsightsStore {
  constructor(options = {}) {
    super(options)
    this.dbFile = options.dbFile
    this.tablePrefix = options.tablePrefix ?? SQLITE_DEFAULT_PREFIX
    mkdirSync(dirname(this.dbFile), { recursive: true })
    const DatabaseSync = getDatabaseSync()
    this.db = new DatabaseSync(this.dbFile)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec(insightsDdl(this.tablePrefix))
  }

  dir() {
    return this.dbFile
  }

  /** 强制重放 ops 表。与文件版同一纪律：**每次 load 都重放，绝不短路**。 */
  async replay(root = this.getRootDir()) {
    this.byId.clear()
    this.byKey.clear()
    this.loadedRoot = root
    try {
      const rows = this.db.prepare(
        `SELECT seq, payload FROM "${this.tablePrefix}insight_ops" ORDER BY seq ASC`,
      ).all()
      let applied = 0
      let bad = 0
      for (const row of rows) {
        try {
          if (applyOp(this, JSON.parse(row.payload))) applied += 1
        } catch {
          bad += 1
        }
      }
      this.badLines = bad
      this.loaded = true
      this.loadedStamp = ''
      this.lastError = bad > 0 ? `洞察日志有 ${bad} 行无法解析（已跳过）` : ''
      this.logger?.info?.(`[dsh-evolution] 洞察库加载完成：${this.byId.size} 条（重放 ${applied} 次操作）`)
    } catch (error) {
      this.loaded = true
      this.lastError = `读取洞察库失败：${error?.message ?? String(error)}`
      this.logger?.warn?.(`[dsh-evolution] ${this.lastError}`)
    }
    return this
  }

  /** 追加一条操作（真相源）。崩溃语义与文件版相同：最多丢最后一条，不会损坏历史。 */
  async appendOp(op) {
    const full = { v: INSIGHTS_LOG_VERSION, ...op }
    this.db.prepare(
      `INSERT INTO "${this.tablePrefix}insight_ops" (at, op, id, payload) VALUES (?, ?, ?, ?)`,
    ).run(
      typeof op?.at === 'number' ? op.at : Date.now(),
      str(op?.op),
      str(op?.id),
      JSON.stringify(full),
    )
    this.appended += 1
  }

  /** SQLite 模式没有派生索引文件：重放即索引。保留空实现让基类调用点不用改。 */
  async saveIndex() {
    return true
  }

  /** 变更检测在 SQLite 模式下不需要（load 永远全量重放）。 */
  async stampOfLog() {
    return ''
  }

  /**
   * 清空。与文件版同一铁律：**先留档再清** —— 把 ops 表整表导出成与文件日志
   * 同形状的 NDJSON（首列 v + 一行一 op），所以留档文件可以直接被
   * `migrateFromFiles` 再导回任何一个后端。
   */
  async clearAll(options = {}) {
    return this.enqueue(async () => {
      await this.load()
      const count = this.byId.size
      this.byId.clear()
      this.byKey.clear()
      const archivedTo = str(options.archiveTo)
      if (archivedTo !== '') {
        try {
          const rows = this.db.prepare(
            `SELECT payload FROM "${this.tablePrefix}insight_ops" ORDER BY seq ASC`,
          ).all()
          const text = rows.map((r) => r.payload).join('\n')
          await mkdir(dirname(archivedTo), { recursive: true })
          await writeFile(archivedTo, text === '' ? '' : `${text}\n`, 'utf8')
        } catch (error) {
          this.lastError = `留档失败（未清空）：${error?.message ?? String(error)}`
          throw error
        }
      }
      await this.appendOp({ op: 'clear', at: Date.now(), count, archivedTo })
      return { removed: count, archivedTo }
    })
  }

  /** 统计：字段与文件版一致；logFile 换成数据库文件（面板显示数据在哪）。 */
  stats() {
    return { ...super.stats(), logFile: this.dbFile }
  }

  dispose() {
    try { this.db.close() } catch { /* 已关闭 */ }
  }
}

// ---------------------------------------------------------------------------
// 一次性导入（NDJSON → SQLite）
// ---------------------------------------------------------------------------

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.ndjson$/

/**
 * 把文件形态的存量数据导入 SQLite。**幂等且可断点续导**：
 * 账本按"天"为单位导入 —— 已有该天数据的分片直接跳过，所以即使上一次
 * 导入中途失败（进程被杀 / 出错），下次启动会从缺的那几天继续，不会出现
 * "表非空就永久跳过"的部分导入。
 *
 * ⚠️ 事务纪律：**任何 await 都不许发生在 BEGIN 和 COMMIT 之间**。node:sqlite
 * 是同步驱动，但事务会跨事件轮持有；同一连接上插件启动后随时可能有
 * flushSession 进来 BEGIN，撞上迁移的打开事务 = "cannot start a transaction
 * within a transaction"，而 flushSession 的 catch 会 ROLLBACK —— 回滚掉的是
 * 迁移的事务，造成部分数据以 autocommit 落库。所以每个分片先读进内存，
 * 再开事务、同步写完、立刻提交。
 *
 * 原文件一律不动 —— 导入错了可以删掉 index.sqlite 重来。
 * 触发时机：createStorage 装配 SQLite 后端之后 fire-and-forget（构造必须保持
 * 同步）。ops 表按 seq 顺序导入，所以导入进行中新写入只会排在后面，
 * 重放顺序永远正确。
 */
export async function migrateFromFiles(db, rootDir, tablePrefix, logger) {
  const result = { ledgerRecords: 0, ledgerDays: 0, insightOps: 0, errors: [] }
  const prefix = sanitizeTablePrefix(tablePrefix, logger)

  // ---- 账本（按天小事务，await 全部在事务外）----
  try {
    let dayFiles = []
    try {
      dayFiles = (await readdir(ledgerDir(rootDir))).filter((f) => DAY_FILE_RE.test(f)).sort()
    } catch { /* 目录不存在 = 没有存量 */ }
    if (dayFiles.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO "${prefix}ledger_events"
          (sid, seq, ts, day, kind, turn, text, tool, status, error_code, error_status, failed, tokens_in, tokens_out, tokens_cache_read, extra)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      // 已有数据的天跳过（断点续导的关键：不能只看"表是否为空"）
      const have = new Set(
        db.prepare(`SELECT DISTINCT day FROM "${prefix}ledger_events"`).all().map((r) => r.day),
      )
      for (const file of dayFiles) {
        const day = file.replace(/\.ndjson$/, '')
        if (have.has(day)) continue
        // 读文件放在事务外（await 不许进事务，见函数头）
        const { records } = await readNdjson(join(ledgerDir(rootDir), file))
        if (records.length === 0) continue
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const rec of records) stmt.run(...sqliteLedgerRow(rec))
          db.exec('COMMIT')
          result.ledgerRecords += records.length
          result.ledgerDays += 1
        } catch (error) {
          try { db.exec('ROLLBACK') } catch { /* 本就没开事务 */ }
          throw error
        }
      }
    }
  } catch (error) {
    result.errors.push(`账本导入失败：${error?.message ?? String(error)}`)
  }

  // ---- 洞察 ops（真相源整份搬走，不从 index.json 反推 —— 那是派生物，可能陈旧）----
  try {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM "${prefix}insight_ops"`).get()?.n ?? 0
    if (n === 0) {
      // 读文件在事务外；全部读完后一次性同步写入（ops 量级 = 人写下的经验，内存装得下）
      const { records, badLines } = await readNdjson(insightsLogFile(rootDir))
      if (records.length > 0) {
        const stmt = db.prepare(
          `INSERT INTO "${prefix}insight_ops" (at, op, id, payload) VALUES (?, ?, ?, ?)`,
        )
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const op of records) {
            stmt.run(
              typeof op?.at === 'number' ? op.at : 0,
              str(op?.op),
              str(op?.id),
              JSON.stringify(op),
            )
          }
          db.exec('COMMIT')
          result.insightOps = records.length
        } catch (error) {
          try { db.exec('ROLLBACK') } catch { /* 本就没开事务 */ }
          throw error
        }
      }
      if (badLines > 0) result.errors.push(`洞察日志有 ${badLines} 行无法解析（已跳过）`)
    }
  } catch (error) {
    result.errors.push(`洞察导入失败：${error?.message ?? String(error)}`)
  }

  if (result.ledgerRecords > 0 || result.insightOps > 0) {
    logger?.info?.(
      `[dsh-evolution] 已从本地文件导入 SQLite：账本 ${result.ledgerRecords} 条`
      + `（${result.ledgerDays} 天）、洞察操作 ${result.insightOps} 条`,
    )
  }
  for (const message of result.errors) logger?.warn?.(`[dsh-evolution] ${message}`)
  return result
}

// 留档路径与文件版同源（routes 用 insights-store 的 archivePath 拼，
// SQLite 模式下 clearAll 会把 ops 表导出到同一路径），这里不再重复导出。
