/**
 * dsh-evolution — API-CONTRACT 参考服务端
 *
 * `docs/API-CONTRACT.md` 的**可运行参考实现**：把 /v1 端点映射到本地文件后端
 * （LedgerStore / InsightsStore）。双重身份：
 *   1. 测试桩 —— `scripts/smoke.mjs` 的远程后端用例靠它当服务端；
 *   2. 服务端实现者的对照物 —— "这个端点该有什么语义"，跑起来看代码最直接。
 *
 * 用法：
 *   node scripts/reference-server.mjs <数据目录> [端口] [--token <值>]
 *   token 给出时，所有请求必须带 `Authorization: Bearer <值>`，否则 401。
 *
 * 语义对齐说明：去重合并（含撞名仓库）、复现计数、晋升来源记录全部发生在
 * **这边的 store**（契约 §1.1/§2.2）——客户端不做业务判断，只做传输。
 */
import { createServer } from 'node:http'
import { InsightsStore, archivePath } from '../lib/insights-store.js'
import { LedgerStore } from '../lib/ledger-store.js'
import { parseImportBundle } from '../lib/export.js'
import { str } from '../lib/paths.js'

/** 统一信封。与插件自身 routes.js 同一形状，契约 §1 有说明。 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}
const ok = (res, data) => sendJson(res, 200, { ok: true, data })
const fail = (res, status, code, message) => sendJson(res, status, { ok: false, error: { code, message } })

/** 读请求体（失败返回 undefined，由调用方给 400）。 */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * 创建参考服务端。返回 http.Server（未监听），测试用 listen(0) 拿随机端口。
 * @param options.rootDir - 本地文件后端的数据根目录。
 * @param options.token - 非空时强制 Bearer 鉴权。
 */
export function createReferenceServer(options = {}) {
  const rootDir = str(options.rootDir)
  const token = str(options.token)
  const ledger = new LedgerStore({ getRootDir: () => rootDir })
  const insights = new InsightsStore({ getRootDir: () => rootDir })

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const method = (req.method ?? 'GET').toUpperCase()

      // ---- 鉴权（契约 §1：Bearer token；401/403 客户端必须停止发送） ----
      if (token !== '') {
        const auth = str(req.headers.authorization)
        if (auth !== `Bearer ${token}`) {
          return fail(res, 401, 'bad-request', '缺少或不匹配的 Authorization: Bearer')
        }
      }

      const body = method === 'POST' || method === 'PATCH' || method === 'DELETE' ? await readBody(req) : {}
      if (body === undefined) return fail(res, 400, 'bad-request', '请求体不是合法 JSON')
      const q = url.searchParams
      const notFound = () => fail(res, 404, 'not-found', '不存在')

      // ================= 账本 =================
      if (method === 'POST' && path === '/v1/ledger/events') {
        const events = Array.isArray(body?.events) ? body.events : []
        const seen = new Set()
        let accepted = 0
        for (const rec of events) {
          if (!rec || typeof rec !== 'object') continue
          // 契约 §1.1：按 (sid, ts, seq, kind) 去重，重投不产生重复行
          const key = `${str(rec.sid)}|${Number(rec.ts)}|${Number(rec.seq)}|${str(rec.kind)}`
          if (seen.has(key)) continue
          seen.add(key)
          ledger.add(rec)
          accepted += 1
        }
        await ledger.flushAll()
        return ok(res, { accepted })
      }
      if (method === 'GET' && path === '/v1/ledger/query') {
        const result = await ledger.query({
          days: Number(q.get('days') ?? 7),
          sessionId: str(q.get('sessionId')),
          limit: q.has('limit') ? Number(q.get('limit')) : 20000,
        })
        return ok(res, result)
      }
      if (method === 'GET' && path === '/v1/ledger/days') return ok(res, await ledger.listDays())
      if (method === 'GET' && path === '/v1/ledger/stats') return ok(res, await ledger.stats())
      if (method === 'POST' && path === '/v1/ledger/prune') return ok(res, await ledger.prune(Number(body?.retentionDays ?? 0)))

      // ================= 洞察 =================
      if (method === 'GET' && path === '/v1/insights') {
        await insights.load()
        return ok(res, insights.list({ includeArchived: q.get('includeArchived') === 'true' }))
      }
      if (method === 'POST' && path === '/v1/insights/upsert') {
        return ok(res, await insights.upsert(Array.isArray(body?.insights) ? body.insights : [], { reason: str(body?.reason) }))
      }
      if (method === 'POST' && path === '/v1/insights/import') {
        // 复用导出侧的形状校验（version / id / 上限），然后走按 id 恢复
        const parsed = parseImportBundle({ version: 1, exportedAt: str(body?.exportedAt), insights: Array.isArray(body?.entries) ? body.entries : [] })
        if (!parsed.ok) return fail(res, 400, 'bad-request', parsed.error)
        const result = await insights.importEntries(parsed.insights, { reason: str(body?.reason) || 'import' })
        return ok(res, { added: result.added, skipped: result.skipped, unattributed: result.unattributed ?? 0, rejected: parsed.rejected })
      }
      const insightById = path.match(/^\/v1\/insights\/([^/]+)$/)
      if (method === 'POST' && path === '/v1/insights/merge') {
        const merged = await insights.merge(str(body?.fromId), str(body?.toId), { reason: str(body?.reason) })
        if (merged === undefined) return notFound()
        return ok(res, { insight: merged })
      }
      const migrateById = path.match(/^\/v1\/insights\/([^/]+)\/migrate$/)
      if (method === 'POST' && migrateById) {
        const next = await insights.migrate(decodeURIComponent(migrateById[1]), str(body?.scope), { reason: 'remote' })
        if (next === undefined) return fail(res, 400, 'bad-request', 'id 不存在或 scope 非法')
        return ok(res, { insight: next })
      }
      if (method === 'GET' && path === '/v1/insights/promotion-candidates') {
        await insights.load()
        return ok(res, insights.promotionCandidates({
          minRecurrence: q.has('minRecurrence') ? Number(q.get('minRecurrence')) : undefined,
          excludePerson: q.get('excludePerson') !== 'false',
        }))
      }
      if (method === 'POST' && path === '/v1/insights/note-injected') {
        await insights.noteInjected(Array.isArray(body?.ids) ? body.ids : [])
        return ok(res, {})
      }
      if (method === 'POST' && path === '/v1/insights/remove-by-sessions') {
        return ok(res, await insights.removeBySessions(Array.isArray(body?.sessionIds) ? body.sessionIds : []))
      }
      if (method === 'POST' && path === '/v1/insights/clear-all') {
        // 留档路径由服务端决定（契约：清空必须先留档）；客户端传的 archiveTo 仅作参考
        const to = str(body?.archiveTo) !== '' ? str(body.archiveTo) : archivePath(rootDir)
        return ok(res, await insights.clearAll({ archiveTo: to }))
      }
      if (method === 'GET' && path === '/v1/insights/stats') {
        await insights.load()
        return ok(res, insights.stats())
      }
      if (method === 'POST' && path === '/v1/insights/rebuild-index') {
        return ok(res, { stats: await insights.rebuildIndex() })
      }
      // ⚠️ /v1/insights/{id} 必须放在所有静态子路径之后，否则 GET /insights/stats
      // 这类路径会被当成 id=stats 的单条查询而 404
      if (method === 'GET' && insightById) {
        await insights.load()
        const item = insights.get(decodeURIComponent(insightById[1]))
        if (item === undefined) return notFound()
        return ok(res, { insight: item })
      }
      if (method === 'PATCH' && insightById) {
        await insights.load()
        const next = await insights.mutate(decodeURIComponent(insightById[1]), body?.patch ?? {}, { reason: str(body?.reason) })
        if (next === undefined) return notFound()
        return ok(res, { insight: next })
      }

      return fail(res, 404, 'not-found', `未知端点：${method} ${path}`)
    } catch (error) {
      return fail(res, 500, 'internal', error?.message ?? String(error))
    }
  })

  // 供测试/CLI 收尾：关闭时把缓冲落盘、释放句柄
  server.closeAllStores = async () => {
    await ledger.flushAll().catch(() => {})
    ledger.dispose()
    insights.dispose()
  }
  return server
}

// ---- CLI：node scripts/reference-server.mjs <数据目录> [端口] [--token <值>] ----
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const args = process.argv.slice(2)
  const rootDir = args.find((a) => !a.startsWith('--'))
  if (rootDir === undefined) {
    console.error('用法：node scripts/reference-server.mjs <数据目录> [端口] [--token <值>]')
    process.exit(1)
  }
  const tokenIdx = args.indexOf('--token')
  const token = tokenIdx >= 0 ? args[tokenIdx + 1] : ''
  const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 48765)
  const server = createReferenceServer({ rootDir, token })
  server.listen(port, '127.0.0.1', () => {
    console.log(`[dsh-evolution] 参考服务端：http://127.0.0.1:${port}/v1  数据目录 ${rootDir}${token !== '' ? '（已启用鉴权）' : '（无鉴权，仅限本机测试）'}`)
  })
  const shutdown = async () => {
    await server.closeAllStores()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
