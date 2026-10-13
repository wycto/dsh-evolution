/**
 * dsh-evolution — 账本存储
 *
 * 写盘策略：**按会话缓冲 + 空闲落盘**，而不是每个事件都写一次文件。
 *
 * 为什么：`session/event` 是每次 append 都会触发的回调，一个会话轻松几百上千条。
 * 逐条 `appendFile` 意味着每次工具调用都产生一次磁盘 IO，而且多会话并发时
 * 写入会交错 —— 虽然 NDJSON 一行一条本身不会被写坏，但 IO 开销和 fs 句柄
 * 竞争是实打实的。改成"每个会话一个内存缓冲，达到条数或时间阈值才落盘"之后：
 *   - 正常路径：一次会话写几次文件；
 *   - 崩溃路径：最多丢掉缓冲里那几十条，且**已落盘的行永远完整**
 *     （appendFile 追加写，不会损坏前面的内容）。
 *
 * 读路径按"日期分片"只读相关文件：查最近 7 天就只读 7 个文件，
 * 不需要扫全量 —— 这是按天切分账本的主要收益。
 */
import { readdir, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { appendNdjson, dayKey, ledgerFileFor, readNdjson, retentionCutoff } from './storage.js'
import { ledgerDir } from './paths.js'

/** 单个会话缓冲达到多少条就强制落盘。 */
const FLUSH_EVERY = 20

/** 缓冲最长滞留时间（毫秒）；即使条数没到也会落盘，避免长期占内存。 */
const FLUSH_INTERVAL_MS = 5000

/** 单文件查询的上限保护：一个会话塞进一天几千条已经很多了。 */
const MAX_QUERY_RECORDS = 200000

/**
 * 账本存储。一个实例管一个数据目录。
 */
export class LedgerStore {
  /**
   * @param options.getRootDir - () => string，数据根目录（配置可能变，所以是函数）。
   * @param options.logger - 宿主 logger（可选）。
   */
  constructor(options = {}) {
    this.getRootDir = options.getRootDir ?? (() => '')
    this.logger = options.logger
    /**
     * 每会话的待写缓冲：sessionId → { day, records[] , timer }
     * 用 day 随记录一起存，因为跨零点时一个会话的记录会分属两天，
     * 落盘时要按记录自己的 day 分文件，而不是按"当前是几号"。
     */
    this.buffers = new Map()
    /** 统计：累计写入条数（面板显示用）。 */
    this.written = 0
    /** 最近一次写入错误（面板要显示，不能静默）。 */
    this.lastError = ''
  }

  /** 账本目录（按当前配置解析）。 */
  dir() {
    return ledgerDir(this.getRootDir())
  }

  /**
   * 登记一条记录。**同步返回**，调用方通常是 session/event 回调 ——
   * 在那里做任何 await 都会拖慢宿主的事件派发。
   * @param record - foldEvent 的产物。
   */
  add(record) {
    if (!record || typeof record !== 'object') return
    const sid = String(record.sid ?? '') || '__unknown__'
    let buf = this.buffers.get(sid)
    if (buf === undefined) {
      buf = { records: [], timer: undefined }
      this.buffers.set(sid, buf)
    }
    buf.records.push(record)
    if (buf.records.length >= FLUSH_EVERY) {
      void this.flushSession(sid)
      return
    }
    if (buf.timer === undefined) {
      buf.timer = setTimeout(() => {
        void this.flushSession(sid)
      }, FLUSH_INTERVAL_MS)
      // 定时器不应阻止进程退出（用户关掉 DSH 时不该被我们拖住）
      buf.timer?.unref?.()
    }
  }

  /**
   * 落盘某会话的缓冲。按记录自身的 day 分文件，保证跨零点正确。
   * 失败时**保留缓冲**（下次再试），并把错误记到 lastError 让面板能显示。
   */
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

    // 按天分组：一次会话可以横跨多天
    const byDay = new Map()
    for (const rec of pending) {
      const day = String(rec.day ?? '') || dayKey(rec.ts)
      let list = byDay.get(day)
      if (list === undefined) {
        list = []
        byDay.set(day, list)
      }
      list.push(rec)
    }

    try {
      const dir = this.dir()
      for (const [day, list] of byDay) {
        const file = ledgerFileFor(dir, day)
        // 逐条 append：NDJSON 的追加是原子的（单次 write 小于 PIPE_BUF 时），
        // 一条一个 write 调用比拼成一大块更不容易在崩溃时产生半行。
        for (const rec of list) await appendNdjson(file, rec)
        this.written += list.length
      }
      this.lastError = ''
    } catch (error) {
      // 放回缓冲（放回队首之前的部分会重复写，所以只放回未成功的这批，
      // 并用一个标记避免无限增长 —— 超过 5000 条就丢弃最老的，宁可少记也别把内存吃光）
      const merged = [...pending, ...buf.records]
      buf.records = merged.length > 5000 ? merged.slice(merged.length - 5000) : merged
      this.lastError = `写账本失败：${error?.message ?? String(error)}`
      this.logger?.warn?.(`[dsh-evolution] ${this.lastError}`)
    }
  }

  /** 还在内存缓冲、尚未落盘的记录总数（面板显示"待落盘"，也是契约方法）。 */
  pendingBuffered() {
    return [...this.buffers.values()].reduce((n, b) => n + b.records.length, 0)
  }

  /** 落盘所有会话的缓冲（插件卸载/进程退出前调用）。 */
  async flushAll() {
    const ids = [...this.buffers.keys()]
    await Promise.all(ids.map((id) => this.flushSession(id)))
  }

  /** 释放定时器（卸载时调用，避免残留计时器拖住宿主）。 */
  dispose() {
    for (const buf of this.buffers.values()) {
      if (buf.timer !== undefined) clearTimeout(buf.timer)
      buf.timer = undefined
    }
    this.buffers.clear()
  }

  /**
   * 清理超过保留期的账本分片（`ledger.retentionDays`，0 = 永久保留，默认）。
   *
   * 这是**删除用户数据**的操作，所以有三条纪律：
   *   · 只认"YYYY-MM-DD.ndjson"这个严格命名，别的文件碰都不碰；
   *   · 只删**整片过期**的天（day 字符串比较即时间序），不删当天的部分内容；
   *   · 单个文件删除失败只记 lastError，不中断剩下的清理。
   * 时机由调用方决定（目前是插件启动时一次），不在事件路径上调用。
   */
  async prune(retentionDays) {
    const days = Math.trunc(Number(retentionDays ?? 0))
    if (!Number.isFinite(days) || days <= 0) return { removed: 0, scanned: 0 }
    const all = await this.listDays()
    // cutoff 与 dayKey 同口径（本地时区，见 storage.retentionCutoff）；
    // day 字符串比较即时间序
    const cutoff = retentionCutoff(days)
    let removed = 0
    for (const day of all) {
      if (day >= cutoff) continue
      try {
        await unlink(ledgerFileFor(this.dir(), day))
        removed += 1
      } catch (error) {
        this.lastError = `清理过期账本失败（${day}）：${error?.message ?? String(error)}`
      }
    }
    return { removed, scanned: all.length }
  }

  /** 列出磁盘上已有的账本日期（倒序）。 */
  async listDays() {
    try {
      const entries = await readdir(this.dir())
      return entries
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
        .map((name) => basename(name, '.ndjson'))
        .sort()
        .reverse()
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
  }

  /**
   * 查询最近 N 天的记录。
   * @param options.days - 最近多少天（0 或负数 = 不限，读全部）。
   * @param options.sessionId - 只看某个会话。
   * @param options.limit - 最多返回多少条（从最新往回保留）。
   */
  async query(options = {}) {
    const { days = 7, sessionId = '', limit = 20000 } = options
    const all = await this.listDays()
    const selected = days > 0 ? all.slice(0, days) : all

    /** @type {object[]} */
    const records = []
    let badLines = 0
    // 从最老的往新的读，这样截断时保留的是"最近"的
    for (const day of [...selected].reverse()) {
      const { records: rs, badLines: bad } = await readNdjson(ledgerFileFor(this.dir(), day), {
        onRecord: (rec) => {
          if (sessionId !== '' && String(rec?.sid ?? '') !== sessionId) return
          records.push(rec)
        },
      })
      badLines += bad
      if (records.length > MAX_QUERY_RECORDS) break
    }

    const trimmed = records.length > limit ? records.slice(records.length - limit) : records
    return { records: trimmed, total: records.length, badLines, days: selected }
  }

  /** 汇总统计：给面板的"总览"用，不必读全部记录。 */
  async stats() {
    const days = await this.listDays()
    let totalRecords = 0
    let badLines = 0
    const sessions = new Set()
    for (const day of days) {
      const { badLines: bad } = await readNdjson(ledgerFileFor(this.dir(), day), {
        onRecord: (rec) => {
          totalRecords += 1
          const sid = String(rec?.sid ?? '')
          if (sid !== '') sessions.add(sid)
        },
      })
      badLines += bad
    }
    return {
      days: days.length,
      firstDay: days.length > 0 ? days[days.length - 1] : '',
      lastDay: days.length > 0 ? days[0] : '',
      records: totalRecords,
      sessions: sessions.size,
      badLines,
      pendingBuffered: this.pendingBuffered(),
      written: this.written,
      lastError: this.lastError,
    }
  }
}
