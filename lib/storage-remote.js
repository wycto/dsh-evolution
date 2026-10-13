/**
 * dsh-evolution — 远程存储后端（HTTP 客户端）
 *
 * 这是 `docs/API-CONTRACT.md` 的**插件侧实现**：把账本与洞察的读写整体搬到
 * `api.baseUrl` 指向的服务端（服务端由使用者自建，仓库附带可运行的参考实现
 * `scripts/reference-server.mjs`）。配置：`api.enabled + api.storageBackend +
 * api.baseUrl`，默认关 —— 开启等于把本机数据交给那台服务，这是 DESIGN 决策 8
 * 记录过的定位变化，必须由用户显式做出。
 *
 * 形状上的两个刻意选择：
 *
 * 1. **账本继承 LedgerStore**：add 的同步纪律、缓冲、失败保缓冲全部复用，
 *    只把"落盘"换成 POST 批量上传 —— 与 SQLite 后端同一子类化策略。
 * 2. **洞察不继承 InsightsStore**：那个基类是"内存重放 + 本地日志"的形态，
 *    而远程的去重/合并发生在服务端（契约 §1.1）。这里做独立的轻实现，
 *    每个方法直接映射一个端点。
 *
 * 失败语义（契约 §1.1）：
 *   - 网络失败/超时/5xx → lastError + 抛给调用方（账本侧保缓冲重试，
 *     洞察侧由调用方决定），**绝不阻塞宿主**；
 *   - 401/403 → **永久停止发送**（authDead）：契约要求鉴权失败不重试，
 *     面板通过 lastError 看到原因。这个状态只能通过重启（重新装配）清除。
 */
import { randomUUID } from 'node:crypto'
import { LedgerStore } from './ledger-store.js'
import { str } from './paths.js'

/** 传输层错误（超时 / 非 JSON / 服务端错误信封）。 */
export class RemoteTransportError extends Error {
  constructor(message, status = 0, code = '') {
    super(message)
    this.name = 'RemoteTransportError'
    this.status = status
    this.code = code
  }
}

/** 鉴权失败：契约要求客户端永久停止发送，与普通传输错误区分开。 */
export class RemoteAuthError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'RemoteAuthError'
    this.status = status
  }
}

/**
 * 发一次契约请求并解信封。所有远程读写都走这里 —— 超时、鉴权头、
 * `{ok,data}` / `{ok:false,error}` 的解包集中在一处。
 */
async function requestJson(client, method, path, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, client.timeoutMs))
  try {
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    if (client.token !== '') headers.authorization = `Bearer ${client.token}`
    const res = await fetch(`${client.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let payload
    try {
      payload = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new RemoteTransportError(`服务端响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`, res.status)
    }
    if (res.status === 401 || res.status === 403) {
      throw new RemoteAuthError(`鉴权被拒绝（HTTP ${res.status}）：${payload?.error?.message ?? '检查 token 环境变量'}`, res.status)
    }
    if (!res.ok || payload?.ok === false) {
      const code = str(payload?.error?.code)
      throw new RemoteTransportError(`服务端错误（HTTP ${res.status}${code ? ` ${code}` : ''}）：${payload?.error?.message ?? '无详情'}`, res.status, code)
    }
    return payload?.data ?? {}
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new RemoteTransportError(`请求超时（${client.timeoutMs}ms）：${method} ${path}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 远程后端共用的状态与守卫：鉴权死刑、错误登记、失败即抛（调用方各自兜）。 */
class RemoteBase {
  constructor(options = {}) {
    this.logger = options.logger
    this.baseUrl = str(options.baseUrl).replace(/\/+$/, '')
    this.token = str(options.token)
    this.timeoutMs = Math.max(1000, Math.trunc(Number(options.timeoutMs ?? 15000)))
    /** 鉴权被拒后置真：此后所有请求直接失败，不再发出去（契约：不重试）。 */
    this.authDead = false
    this.lastError = ''
  }

  dir() {
    return this.baseUrl
  }

  /** 登记错误并决定要不要抛。返回 true = 调用方应按失败处理。 */
  fail(error, label) {
    this.lastError = `${label}：${error?.message ?? String(error)}`
    if (error instanceof RemoteAuthError) {
      this.authDead = true
      this.logger?.warn?.(`[dsh-evolution] 远程存储鉴权失败，已停止向 ${this.baseUrl} 发送数据（重启插件后重试）：${error.message}`)
    } else {
      this.logger?.warn?.(`[dsh-evolution] ${this.lastError}`)
    }
    return true
  }

  /** 鉴权死刑后的快速失败：不再发任何请求。 */
  guard(label) {
    if (this.authDead) {
      this.lastError = `${label}：鉴权此前被拒绝，已停止发送（重启插件后重试）`
      throw new RemoteAuthError(this.lastError, 401)
    }
  }

  async call(method, path, body, label) {
    this.guard(label)
    try {
      const data = await requestJson(this, method, path, body)
      this.lastError = ''
      return data
    } catch (error) {
      this.fail(error, label)
      throw error
    }
  }
}

// ---------------------------------------------------------------------------
// 账本后端
// ---------------------------------------------------------------------------

/**
 * 远程账本。缓冲、add 同步纪律、pendingBuffered/written 计数全部继承；
 * flushSession 把"落盘一批"换成"上传一批"——失败保回缓冲，下次再传，
 * 服务端按 (sid, ts, seq, kind) 去重（契约 §1.1），重传不会产生重复。
 */
export class RemoteLedgerStore extends LedgerStore {
  constructor(options = {}) {
    super(options)
    this.remote = new RemoteBase(options)
  }

  dir() {
    return this.remote.dir()
  }

  /** 鉴权死刑状态（契约：401 后停止发送；面板/测试可读）。 */
  get authDead() {
    return this.remote.authDead
  }

  get lastError() {
    return this.remote?.lastError ?? ''
  }

  set lastError(value) {
    // 基类构造函数会先于 this.remote 就位执行 this.lastError = ''，必须容错
    if (this.remote !== undefined) this.remote.lastError = value
  }

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
    try {
      const data = await this.remote.call('POST', '/v1/ledger/events', { events: pending }, '上传账本')
      this.written += Math.max(0, Math.trunc(Number(data?.accepted ?? pending.length)))
    } catch (error) {
      // 与文件版同一纪律：失败保回缓冲（超上限丢最老），绝不向宿主抛
      const merged = [...pending, ...buf.records]
      buf.records = merged.length > 5000 ? merged.slice(merged.length - 5000) : merged
    }
  }

  async listDays() {
    const data = await this.remote.call('GET', '/v1/ledger/days', undefined, '读取账本日期')
    return Array.isArray(data) ? data : []
  }

  async query(options = {}) {
    const { days = 7, sessionId = '', limit = 20000 } = options
    const params = new URLSearchParams()
    if (days !== undefined) params.set('days', String(days))
    if (sessionId !== '') params.set('sessionId', sessionId)
    if (limit !== undefined) params.set('limit', String(limit))
    const data = await this.remote.call('GET', `/v1/ledger/query?${params}`, undefined, '查询账本')
    return {
      records: Array.isArray(data?.records) ? data.records : [],
      total: Math.max(0, Math.trunc(Number(data?.total ?? 0))),
      badLines: Math.max(0, Math.trunc(Number(data?.badLines ?? 0))),
      days: Array.isArray(data?.days) ? data.days : [],
    }
  }

  async prune(retentionDays) {
    const data = await this.remote.call('POST', '/v1/ledger/prune', { retentionDays }, '清理过期账本')
    return { removed: Number(data?.removed ?? 0), scanned: Number(data?.scanned ?? 0) }
  }

  async stats() {
    const data = await this.remote.call('GET', '/v1/ledger/stats', undefined, '账本统计')
    // pendingBuffered / written / lastError 是**客户端本地**状态，覆盖服务端的同名字段
    return {
      ...data,
      pendingBuffered: this.pendingBuffered(),
      written: this.written,
      lastError: this.remote.lastError,
    }
  }
}

// ---------------------------------------------------------------------------
// 洞察后端
// ---------------------------------------------------------------------------

/**
 * 远程洞察库。**独立轻实现**（不继承 InsightsStore）：
 * 去重合并、复现计数、晋升恢复这些业务语义都在服务端（契约 §2.2 / §2.3），
 * 客户端只负责把调用翻译成端点。每个方法映射一个端点，
 * 语义（返回形状、404 → undefined）与文件实现对齐。
 */
export class RemoteInsightsStore {
  constructor(options = {}) {
    this.logger = options.logger
    this.remote = new RemoteBase(options)
  }

  dir() {
    return this.remote.dir()
  }

  /** 鉴权死刑状态（契约：401 后停止发送；面板/测试可读）。 */
  get authDead() {
    return this.remote.authDead
  }

  get lastError() {
    return this.remote.lastError
  }

  set lastError(value) {
    this.remote.lastError = value
  }

  /** 远程形态没有本地重放：每次操作都直达服务端，天然读到最新。签名保持契约。 */
  async load() {
    return this
  }

  async replay() {
    return this
  }

  async list(options = {}) {
    const params = new URLSearchParams()
    if (options.includeArchived === true) params.set('includeArchived', 'true')
    const data = await this.remote.call('GET', `/v1/insights${params.size > 0 ? `?${params}` : ''}`, undefined, '读取洞察列表')
    return Array.isArray(data) ? data : []
  }

  async get(id) {
    this.remote.guard('读取洞察')
    try {
      const data = await requestJson(this.remote, 'GET', `/v1/insights/${encodeURIComponent(str(id))}`, undefined)
      this.remote.lastError = ''
      return data?.insight
    } catch (error) {
      if (error instanceof RemoteTransportError && error.status === 404) {
        this.remote.lastError = ''
        return undefined
      }
      this.remote.fail(error, '读取洞察')
      throw error
    }
  }

  async upsert(insights, options = {}) {
    const data = await this.remote.call('POST', '/v1/insights/upsert', {
      requestId: randomUUID(),
      reason: str(options.reason),
      insights: Array.isArray(insights) ? insights : [],
    }, '写入洞察')
    return {
      added: Array.isArray(data?.added) ? data.added : [],
      merged: Array.isArray(data?.merged) ? data.merged : [],
      rejected: Array.isArray(data?.rejected) ? data.rejected : [],
    }
  }

  async importEntries(entries, options = {}) {
    const data = await this.remote.call('POST', '/v1/insights/import', {
      requestId: randomUUID(),
      reason: str(options?.reason),
      entries: Array.isArray(entries) ? entries : [],
    }, '导入洞察')
    return {
      added: Array.isArray(data?.added) ? data.added : [],
      skipped: Math.max(0, Math.trunc(Number(data?.skipped ?? 0))),
      unattributed: Math.max(0, Math.trunc(Number(data?.unattributed ?? 0))),
    }
  }

  async mutate(id, patch, options = {}) {
    this.remote.guard('操作洞察')
    try {
      const data = await requestJson(this.remote, 'PATCH', `/v1/insights/${encodeURIComponent(str(id))}`, {
        patch: patch ?? {},
        reason: str(options?.reason),
      })
      this.remote.lastError = ''
      return data?.insight
    } catch (error) {
      if (error instanceof RemoteTransportError && error.status === 404) {
        this.remote.lastError = ''
        return undefined
      }
      this.remote.fail(error, '操作洞察')
      throw error
    }
  }

  async merge(fromId, toId, options = {}) {
    this.remote.guard('合并洞察')
    try {
      const data = await requestJson(this.remote, 'POST', '/v1/insights/merge', {
        fromId: str(fromId),
        toId: str(toId),
        reason: str(options?.reason),
      })
      this.remote.lastError = ''
      return data?.insight
    } catch (error) {
      if (error instanceof RemoteTransportError && error.status === 404) return undefined
      this.remote.fail(error, '合并洞察')
      throw error
    }
  }

  async migrate(id, toScope, options = {}) {
    this.remote.guard('迁移洞察作用域')
    try {
      const data = await requestJson(this.remote, 'POST', `/v1/insights/${encodeURIComponent(str(id))}/migrate`, { scope: str(toScope) })
      this.remote.lastError = ''
      return data?.insight
    } catch (error) {
      if (error instanceof RemoteTransportError && (error.status === 404 || error.status === 400)) return undefined
      this.remote.fail(error, '迁移洞察作用域')
      throw error
    }
  }

  async promotionCandidates(options = {}) {
    const params = new URLSearchParams()
    if (options?.minRecurrence !== undefined) params.set('minRecurrence', String(options.minRecurrence))
    if (options?.excludePerson !== undefined) params.set('excludePerson', String(options.excludePerson))
    const data = await this.remote.call('GET', `/v1/insights/promotion-candidates${params.size > 0 ? `?${params}` : ''}`, undefined, '读取晋升候选')
    return {
      eligible: Array.isArray(data?.eligible) ? data.eligible : [],
      skipped: Array.isArray(data?.skipped) ? data.skipped : [],
      minRecurrence: Number(data?.minRecurrence ?? options?.minRecurrence ?? 2),
    }
  }

  async noteInjected(ids) {
    await this.remote.call('POST', '/v1/insights/note-injected', { ids: Array.isArray(ids) ? ids : [] }, '记录注入计数')
  }

  async removeBySessions(sessionIds) {
    const data = await this.remote.call('POST', '/v1/insights/remove-by-sessions', { sessionIds: Array.isArray(sessionIds) ? sessionIds : [] }, '删除来源会话洞察')
    return Array.isArray(data) ? data : []
  }

  async clearAll(options = {}) {
    const data = await this.remote.call('POST', '/v1/insights/clear-all', { archiveTo: str(options?.archiveTo) }, '清空洞察')
    return { removed: Number(data?.removed ?? 0), archivedTo: str(data?.archivedTo) }
  }

  async stats() {
    const data = await this.remote.call('GET', '/v1/insights/stats', undefined, '洞察统计')
    return { ...data, lastError: this.remote.lastError || str(data?.lastError) }
  }

  async rebuildIndex() {
    const data = await this.remote.call('POST', '/v1/insights/rebuild-index', {}, '重建洞察索引')
    return data?.stats ?? data
  }

  dispose() { /* 无本地句柄 */ }
}
