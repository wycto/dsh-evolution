/**
 * dsh-evolution — Host↔Client HTTP 路由
 *
 * 为什么走 HTTP 而不是宿主 RPC：静态安装的 npm 插件运行在 client-modules
 * 环境里，**没有 host 全局**，也没有公开的 Host connection 服务；同源 HTTP
 * 路由是这个形态下 Host↔Client 的标准做法（官方与社区插件同款）。
 *
 * 信封统一为 `{ ok: true, data }` / `{ ok: false, error: { code, message, details } }`。
 * 错误必须带**稳定 code**：面板要能按 code 分支（比如"配置未就绪"和"内部错误"
 * 的展示完全不同），而不是靠匹配 message 文案。
 */
import { redact, previewRedaction, secretRuleDescriptions } from './redact.js'
import { SCHEMA_FIELDS, SCHEMA_GROUPS, META } from './config.js'
import { allDirs } from './paths.js'
import { dayKey, exists } from './storage.js'
import { ruleDescriptions as insightRuleDescriptions, PROMOTION_DEFAULTS } from './insight-rules.js'
import { rankInsights, searchInsights, bucketForInjection } from './retrieve.js'
import { resolveSkillDir, planSkillDrafts, writeSkillDrafts, buildExportMarkdown, writeExport, exportsDir, parseImportBundle, validateSkillText } from './export.js'
import { archivePath } from './insights-store.js'
import { str } from './paths.js'

/** 路由前缀。短且唯一，避免和别的插件撞。 */
export const ROUTE_PREFIX = '/dsh-evolution'

/** 一次响应最多带多少条账本记录（面板预览有上限，避免把浏览器卡死）。 */
const MAX_PREVIEW_RECORDS = 2000

/** 统一错误码。面板按这些 code 分支，不要用 message 文案做判断。 */
export const ERROR_CODES = Object.freeze({
  methodNotFound: 'method-not-found',
  badRequest: 'bad-request',
  internal: 'internal',
  configUnavailable: 'config-unavailable',
  notReady: 'not-ready',
  llmUnavailable: 'llm-unavailable',
  busy: 'busy',
  notFound: 'not-found',
})

/** 写 JSON 响应。 */
export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // 数据是本机的，但也不希望被任何中间层缓存
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读请求体并解析 JSON（失败返回空对象，不抛）。 */
export async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** 包一层 try/catch，保证任何异常都变成结构化错误而不是 500 空响应。 */
function ok(res, data) {
  return sendJson(res, 200, { ok: true, data })
}

function fail(res, status, code, message, details) {
  return sendJson(res, status, { ok: false, error: { code, message, details: details ?? {} } })
}

/**
 * 注册路由。
 * @param ctx - 宿主 context（需要 webServer）。
 * @param deps - 依赖注入：{ configStore, ledger, logger, version, roots }
 */
export function registerRoutes(ctx, deps) {
  const { configStore, ledger } = deps
  const version = deps.version ?? '0.0.0'

  // 没有 webServer（CLI / headless 宿主）时静默跳过 UI 路由：
  // 采集与注入是核心能力，不该因为宿主没提供 Web 服务而整体失效。
  if (typeof ctx.inject !== 'function') return () => {}

  return ctx.inject(['webServer'], (wsCtx) => {
    const dispose = wsCtx.effect(() => wsCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      async handler(req, res) {
        let method = ''
        try {
          const url = new URL(req.url || '/', 'http://dsh.internal')
          /**
           * ⚠️ 方法名必须**整段取**，不能按 `/` 切第一段。
           * `insights/mutate`、`review/run`、`skills/plan` 这些带子路径的方法名
           * 一旦被切成 `insights`，就会静默命中父级分支（或者更糟：命中一个
           * 语义完全不同、恰好同名的分支），表现为"点了按钮没反应"。
           */
          method = decodeURIComponent(url.pathname.replace(new RegExp(`^${ROUTE_PREFIX}/?`), '')).replace(/^\/+|\/+$/g, '')
          const payload = await readBody(req)
          const cfg = configStore.current()

          switch (method) {
            // ---------- 元信息：面板首屏一次拿全 ----------
            case 'hello':
              return ok(res, {
                version,
                schema: { fields: SCHEMA_FIELDS, groups: SCHEMA_GROUPS },
                meta: META,
                paths: {
                  root: configStore.rootDir(),
                  configFile: configStore.file(),
                  dirs: allDirs(configStore.rootDir()),
                },
                configured: await configStore.exists(),
                configError: configStore.lastError,
                redactRules: secretRuleDescriptions(),
              })

            // ---------- 复盘用哪个模型：把"填什么"变成"选一个" ----------
            case 'models': {
              /**
               * 这个路由是只读的：不改配置、不调模型，只把宿主已注册的
               * provider × model 摊开，并顺带回答"配置留空时会用哪个"。
               *
               * 为什么要单独一个路由而不是塞进 hello：`listModels()` 是异步的、
               * 理论上可能走网络，而 hello 是面板首屏的关键路径 —— 一份慢目录
               * 不该拖慢整个面板的打开。
               */
              if (typeof deps.modelCatalog !== 'function') {
                return fail(res, 500, ERROR_CODES.internal, '模型目录能力未就绪')
              }
              return ok(res, await deps.modelCatalog({ force: payload.force === true }))
            }

            // ---------- 配置读写 ----------
            case 'config':
              return ok(res, {
                config: cfg,
                configError: configStore.lastError,
                root: configStore.rootDir(),
              })

            case 'config/save': {
              const patch = payload && typeof payload.patch === 'object' && payload.patch !== null ? payload.patch : payload
              if (patch === null || typeof patch !== 'object') {
                return fail(res, 400, ERROR_CODES.badRequest, 'patch 必须是对象')
              }
              const next = await configStore.update(patch)
              // 配置可能改了注入预算/开关：立刻重算注入缓存，否则"改了没生效"
              if (typeof deps.refreshInjection === 'function') {
                void deps.refreshInjection().catch(() => { /* 尽力而为，错误进运行状态 */ })
              }
              return ok(res, { config: next, root: configStore.rootDir() })
            }

            case 'config/reset': {
              const next = await configStore.reset()
              if (typeof deps.refreshInjection === 'function') {
                void deps.refreshInjection().catch(() => { /* 同上 */ })
              }
              return ok(res, { config: next, root: configStore.rootDir() })
            }

            // ---------- 数据预览 ----------
            case 'ledger': {
              const days = numOr(payload.days, 7)
              const sessionId = strOr(payload.sessionId, '')
              // 面板预览默认只取最近 2000 条（避免把浏览器卡死），但**显式传 limit 时
              // 要尊重它** —— 之前这里硬性 `Math.min(..., MAX_PREVIEW_RECORDS)` 再
              // `slice(-limit)`，会把"查某个较早会话"切成"最近 2000 条里的那个会话"，
              // 结果是复盘说"账本里没有这个会话"，而它明明就在盘上。
              const limit = Math.max(1, Math.min(numOr(payload.limit, MAX_PREVIEW_RECORDS), 200000))
              const result = await ledger.query({ days, sessionId, limit })
              return ok(res, {
                ...result,
                records: result.records,
                truncated: result.total > result.records.length,
                root: configStore.rootDir(),
                pendingBuffered: ledger.pendingBuffered(),
              })
            }

            case 'stats': {
              const stats = await ledger.stats()
              return ok(res, { ...stats, root: configStore.rootDir() })
            }

            // ---------- 脱敏预览（面板并排显示 before/after） ----------
            case 'redact/preview': {
              const text = typeof payload.text === 'string' ? payload.text : ''
              if (text === '') return fail(res, 400, ERROR_CODES.badRequest, 'text 不能为空')
              const options = {
                redact: cfg.privacy.redact,
                stripAbsolutePaths: cfg.privacy.stripAbsolutePaths,
                stripSecrets: cfg.privacy.stripSecrets,
                customWords: cfg.privacy.customWords,
              }
              const result = previewRedaction(text, options)
              return ok(res, { ...result, output: redact(text, options) })
            }

            // ---------- 运行状态（面板"总览"页） ----------
            case 'runtime': {
              const stats = typeof deps.runtimeStats === 'function' ? await deps.runtimeStats() : {}
              return ok(res, { runtime: stats, ledger: await ledger.stats() })
            }

            // ---------- 试跑（dry run）：不调模型、不写任何文件 ----------
            case 'dry-run': {
              if (typeof deps.dryRun !== 'function') {
                return fail(res, 500, ERROR_CODES.internal, '试跑能力未就绪')
              }
              const report = await deps.dryRun({
                sessionId: strOr(payload.sessionId, ''),
                model: strOr(payload.model, ''),
              })
              return ok(res, report)
            }

            // ---------- 单会话摘要（面板"数据预览"展开某个会话） ----------
            case 'session/summary': {
              const sessionId = strOr(payload.sessionId, '')
              if (sessionId === '') return fail(res, 400, ERROR_CODES.badRequest, 'sessionId 不能为空')
              if (typeof deps.sessionSummary !== 'function') {
                return fail(res, 500, ERROR_CODES.internal, '摘要能力未就绪')
              }
              const maxChars = numOr(payload.maxChars, cfg.ledger.maxCharsPerSession)
              const summary = await deps.sessionSummary(sessionId, maxChars)
              return ok(res, summary)
            }

            // ---------- 目录可达性自检（安装后第一个该看的诊断） ----------
            case 'diagnose': {
              const root = configStore.rootDir()
              const checks = []
              for (const dir of allDirs(root)) {
                checks.push({ path: dir, exists: await exists(dir) })
              }
              return ok(res, {
                root,
                checks,
                today: dayKey(),
                configFile: { path: configStore.file(), exists: await configStore.exists() },
                configError: configStore.lastError,
                ledger: await ledger.stats(),
              })
            }

            // ---------- 手动触发历史回扫（Phase 0 只做采集，不做 LLM） ----------
            case 'ledger/flush': {
              await ledger.flushAll()
              return ok(res, await ledger.stats())
            }

            // ---------- 洞察库（L2） ----------
            case 'insights': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              await store.load()
              const includeArchived = payload.includeArchived === true
              const limit = Math.max(1, Math.min(numOr(payload.limit, 500), 5000))
              const offset = Math.max(0, numOr(payload.offset, 0))
              const query = strOr(payload.query, '')
              const scope = strOr(payload.scope, '')
              /** 关键词检索被配置关掉时的原因（面板要显示，而不是给个空列表）。 */
              let searchDisabled = ''
              const repo = strOr(payload.repo, '')
              let list = await store.list({ includeArchived })
              if (scope !== '') list = list.filter((i) => str(i.scope) === scope)
              if (repo !== '') list = list.filter((i) => str(i.repo) === '' || str(i.repo) === repo)
              // 有查询串就走全文检索（面板的搜索框）；否则按注入排序（"最重要的排前面"）
              let ranked
              if (query !== '') {
                // 检索本身也取全量再分页：否则"第 2 页"会变成"重新检索的前 500 条"
                const result = searchInsights(list, query, {
                  limit: Math.max(limit + offset, 500),
                  repo,
                  fullText: cfg.retrieval.fullText !== false,
                })
                ranked = result.hits
                searchDisabled = result.disabled === true ? str(result.reason) : ''
              } else {
                ranked = rankInsights(list, { repo, limit: 5000, perScopeLimit: 5000, minRecurrence: 1 })
              }
              return ok(res, {
                insights: ranked.slice(offset, offset + limit),
                /** 分页信息：面板要显示"还有 N 条"，而不是让用户以为库里就这么点。 */
                page: { offset, limit, total: ranked.length, hasMore: offset + limit < ranked.length },
                stats: await store.stats(),
                ruleDescriptions: insightRuleDescriptions(),
                promotion: { minRecurrence: PROMOTION_DEFAULTS.minRecurrence },
                /** 面板要显示"哪些会进上下文"，所以顺手把分桶结果也带上。 */
                buckets: query === ''
                  ? summarizeBuckets(bucketForInjection(ranked, { perSection: 50 }))
                  : undefined,
                searchDisabled,
                root: configStore.rootDir(),
              })
            }

            case 'insights/get': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              await store.load()
              const id = strOr(payload.id, '')
              const item = await store.get(id)
              if (item === undefined) return fail(res, 404, ERROR_CODES.notFound, `找不到洞察 ${id}`)
              return ok(res, { insight: item })
            }

            case 'insights/mutate': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              const id = strOr(payload.id, '')
              if (id === '') return fail(res, 400, ERROR_CODES.badRequest, 'id 不能为空')
              const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
              const next = await store.mutate(id, patch, { reason: 'panel' })
              if (next === undefined) return fail(res, 404, ERROR_CODES.notFound, `找不到洞察 ${id}`)
              if (typeof deps.refreshInjection === 'function') await deps.refreshInjection().catch(() => {})
              return ok(res, { insight: next, stats: await store.stats() })
            }

            case 'insights/merge': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              const from = strOr(payload.from, '')
              const into = strOr(payload.into, '')
              if (from === '' || into === '') return fail(res, 400, ERROR_CODES.badRequest, 'from / into 都不能为空')
              if (from === into) return fail(res, 400, ERROR_CODES.badRequest, '不能把一条合并到它自己')
              const result = await store.merge(from, into, { reason: 'panel' })
              if (result === undefined) return fail(res, 404, ERROR_CODES.notFound, 'from 或 into 不存在')
              if (typeof deps.refreshInjection === 'function') await deps.refreshInjection().catch(() => {})
              return ok(res, { insight: result, stats: await store.stats() })
            }

            // ---------- 晋升（把一条经验提升为跨仓库的个人提醒 / 团队规范） ----------
            case 'insights/promotions': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              await store.load()
              const plan = await store.promotionCandidates({
                minRecurrence: Number(cfg.promotion?.personMinRecurrence ?? 2),
              })
              return ok(res, {
                eligible: plan.eligible,
                skipped: plan.skipped.slice(0, 50),
                minRecurrence: plan.minRecurrence,
                /** 已经是个人提醒的条目（面板要能显示现状）。 */
                current: (await store.list({ includeArchived: false })).filter((i) => i.scope === 'person' || i.scope === 'team'),
                /** 说清这条通道的性质，避免用户以为插件在自动做跨工作区聚合。 */
                note: '跨仓库的个人提醒只能由你手动晋升 —— 本插件不会自动跨工作区聚合'
                  + '（那会跨越雇主/项目边界）。晋升后这条会在**每个**仓库的上下文里出现。',
                pinOnPromote: cfg.promotion?.pinOnPromote === true,
              })
            }

            case 'insights/promote': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              const id = strOr(payload.id, '')
              if (id === '') return fail(res, 400, ERROR_CODES.badRequest, 'id 不能为空')
              const toScope = strOr(payload.scope, 'person')
              if (toScope !== 'person' && toScope !== 'team') {
                return fail(res, 400, ERROR_CODES.badRequest, 'scope 只能是 person 或 team（退回仓库用 insights/mutate 改 scope）')
              }
              // team 会进入"团队规范"段，影响面比个人提醒更大，要显式确认
              if (toScope === 'team' && payload.confirm !== true) {
                return fail(res, 409, ERROR_CODES.badRequest,
                  'team 作用域的条目会进入「团队规范」段，需要显式确认后才写入。请带 confirm: true。')
              }
              let next = await store.migrate(id, toScope, { reason: strOr(payload.reason, 'panel-promote') })
              if (next === undefined) return fail(res, 404, ERROR_CODES.notFound, `找不到洞察 ${id}`)
              if (cfg.promotion?.pinOnPromote === true && next.pinned !== true) {
                next = await store.mutate(id, { pinned: true }, { reason: 'pin-on-promote' }) ?? next
              }
              if (typeof deps.refreshInjection === 'function') await deps.refreshInjection().catch(() => {})
              return ok(res, { insight: next, stats: await store.stats() })
            }

            case 'insights/demote': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              const id = strOr(payload.id, '')
              if (id === '') return fail(res, 400, ERROR_CODES.badRequest, 'id 不能为空')
              const item = await store.get(id)
              if (item === undefined) return fail(res, 404, ERROR_CODES.notFound, `找不到洞察 ${id}`)
              const back = strOr(payload.scope, str(item.promotedFrom?.from?.scope) || 'repo')
              const next = await store.migrate(id, back, { reason: 'panel-demote' })
              if (next === undefined) return fail(res, 400, ERROR_CODES.badRequest, `无法退回作用域 ${back}`)
              if (typeof deps.refreshInjection === 'function') await deps.refreshInjection().catch(() => {})
              return ok(res, { insight: next, stats: await store.stats() })
            }

            case 'insights/delete': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              const id = strOr(payload.id, '')
              if (id === '') return fail(res, 400, ERROR_CODES.badRequest, 'id 不能为空')
              const next = await store.mutate(id, { deleted: true }, { reason: 'panel' })
              if (next === undefined) return fail(res, 404, ERROR_CODES.notFound, `找不到洞察 ${id}`)
              if (typeof deps.refreshInjection === 'function') await deps.refreshInjection().catch(() => {})
              return ok(res, { deleted: id, stats: await store.stats() })
            }

            case 'insights/clear': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              // 清空**必须留档**：用户想要的是"看不见了"，不是"不可恢复"
              const to = archivePath(configStore.rootDir())
              const result = await store.clearAll({ archiveTo: to })
              if (typeof deps.refreshInjection === 'function') await deps.refreshInjection().catch(() => {})
              return ok(res, { ...result, stats: await store.stats() })
            }

            case 'insights/rebuild': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              const stats = await store.rebuildIndex()
              return ok(res, { stats })
            }

            // ---------- 导入（导出 JSON 的恢复通道；换机器/误清空后的"搬回来"） ----------
            case 'insights/import': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              // 面板把导出 JSON 的**文本内容**整包发上来（text）；也接受已解析的 data
              const parsed = parseImportBundle(typeof payload.text === 'string' ? payload.text : payload.data)
              if (!parsed.ok) return fail(res, 400, ERROR_CODES.badRequest, parsed.error)
              const result = await store.importEntries(parsed.insights, { reason: 'panel-import' })
              if (typeof deps.refreshInjection === 'function') await deps.refreshInjection().catch(() => {})
              return ok(res, {
                addedCount: result.added.length,
                added: result.added,
                skipped: result.skipped,
                /** repo 作用域但归属双空的条目数（它们永远不会被注入，要有提示口径）。 */
                unattributed: result.unattributed ?? 0,
                rejected: parsed.rejected,
                truncatedCount: parsed.truncatedCount,
                exportedAt: parsed.exportedAt,
                stats: await store.stats(),
              })
            }

            // ---------- 复盘（会花用户的钱，所以每个字段都要能解释清楚） ----------
            case 'review/preview': {
              if (typeof deps.reviewPreview !== 'function') {
                return fail(res, 500, ERROR_CODES.internal, '复盘预览能力未就绪')
              }
              const preview = await deps.reviewPreview({
                sessionId: strOr(payload.sessionId, ''),
                mode: strOr(payload.mode, 'manual'),
              })
              return ok(res, preview)
            }

            // ---------- 用量与成本（面板"总览"要显示"我到底花了多少"） ----------
            case 'usage': {
              if (typeof deps.readState !== 'function') {
                return fail(res, 500, ERROR_CODES.internal, '状态读取能力未就绪')
              }
              const state = await deps.readState()
              const history = Array.isArray(state?.review?.history) ? state.review.history : []
              const days = Math.max(1, Math.min(numOr(payload.days, 30), 365))
              const since = Date.now() - days * 86400000
              const window = history.filter((h) => Number(h.at ?? 0) >= since)
              let inputTokens = 0
              let outputTokens = 0
              let ms = 0
              let runs = 0
              let accepted = 0
              let merged = 0
              let rejected = 0
              const byModel = {}
              const byStatus = {}
              for (const h of window) {
                runs += 1
                inputTokens += Number(h.inputTokens ?? 0) || 0
                outputTokens += Number(h.outputTokens ?? 0) || 0
                ms += Number(h.ms ?? 0) || 0
                accepted += Number(h.accepted ?? 0) || 0
                merged += Number(h.merged ?? 0) || 0
                rejected += Number(h.rejected ?? 0) || 0
                const model = str(h.model) || '(未记录)'
                byModel[model] = (byModel[model] ?? 0) + (Number(h.inputTokens ?? 0) || 0) + (Number(h.outputTokens ?? 0) || 0)
                const status = str(h.status) || '(未知)'
                byStatus[status] = (byStatus[status] ?? 0) + 1
              }
              const today = state?.usage?.[dayKey()] ?? { inputTokens: 0, outputTokens: 0, calls: 0 }
              return ok(res, {
                days,
                runs,
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                avgMs: runs > 0 ? Math.round(ms / runs) : 0,
                accepted,
                merged,
                rejected,
                byModel,
                byStatus,
                today: {
                  day: dayKey(),
                  calls: Number(today.calls ?? 0) || 0,
                  inputTokens: Number(today.inputTokens ?? 0) || 0,
                  outputTokens: Number(today.outputTokens ?? 0) || 0,
                },
                budget: cfg.review.dailyTokenBudget,
                /** 单价是估算，所以这里给的是 token 而不是钱；面板会把"估算"两个字写清楚。 */
                note: '这里统计的是复盘调用（唯一会花钱的路径）。token 数来自模型回报；'
                  + '费用请以你模型提供方的账单为准。',
                recent: window.slice(0, 20),
              })
            }

            case 'review/run': {
              if (typeof deps.reviewNow !== 'function') {
                return fail(res, 500, ERROR_CODES.internal, '复盘能力未就绪')
              }
              const stats = typeof deps.runtimeStats === 'function' ? await deps.runtimeStats() : {}
              if (stats.llmAvailable !== true) {
                return fail(res, 409, ERROR_CODES.llmUnavailable,
                  '宿主没有提供模型服务（ctx.llm），无法复盘。请在 DSH 里至少配置一个模型提供方，然后重载插件。')
              }
              if (Array.isArray(stats.llmProviders) && stats.llmProviders.length === 0) {
                // 服务在、但一个提供方都没激活：这是可修的配置问题，
                // 必须和"宿主没有模型服务"分开说，否则用户会去改错地方
                return fail(res, 409, ERROR_CODES.llmUnavailable,
                  '模型服务已就绪，但没有任何已激活的提供方（可能是没配 API key，或提供方被禁用）。'
                  + '请在 DSH 的设置里激活一个模型提供方后重试。')
              }
              // 用 getter 读实时状态：复盘是长时间任务，面板要靠这个转圈
              const report = await deps.reviewNow({
                sessionId: strOr(payload.sessionId, ''),
                mode: strOr(payload.mode, 'manual'),
              })
              return ok(res, report)
            }

            // ---------- 注入预览（"现在到底会往上下文里塞什么"） ----------
            case 'inject/preview': {
              const cache = deps.injection
              if (cache === undefined) return fail(res, 500, ERROR_CODES.notReady, '注入缓存未就绪')
              const store = deps.insights
              if (store !== undefined) await store.load()
              // 先刷新一次，保证面板看到的是当前配置下的真实结果
              if (typeof deps.refreshInjection === 'function') await deps.refreshInjection().catch(() => {})
              const all = cache.listAll()
              const repoRoot = strOr(payload.repoRoot, '')
              const described = repoRoot === '' ? cache.describe(cache.stats().activeRoot) : cache.describe(repoRoot)
              return ok(res, {
                repos: all,
                stats: cache.stats(),
                /**
                 * 指定仓库的完整注入文本（用户能逐字看到会进上下文的东西）。
                 * 这里显式带上 `text`：面板的「逐字文本」区块就是读它。
                 */
                detail: {
                  repo: described.repo,
                  repoRoot: described.repoRoot,
                  text: described.text,
                  totalChars: described.totalChars,
                  totalTokens: described.totalTokens,
                  includedIds: described.includedIds,
                  sections: described.sections.map((sec) => ({
                    id: sec.id, title: sec.title, layer: sec.layer, chars: sec.chars,
                    count: sec.included.length, skipped: sec.skipped,
                  })),
                  at: described.at,
                },
                budgetChars: all.length > 0
                  ? all[0].sections.reduce((n, s) => n + (s.chars ?? 0) + 0, 0)
                  : 0,
                root: configStore.rootDir(),
              })
            }

            // ---------- 导出 ----------
            case 'export/markdown': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              await store.load()
              const built = buildExportMarkdown({
                insights: await store.list({ includeArchived: payload.includeArchived === true }),
                config: cfg,
                scope: strOr(payload.scope, ''),
                repo: strOr(payload.repo, ''),
                includeArchived: payload.includeArchived === true,
                root: configStore.rootDir(),
              })
              return ok(res, {
                markdown: built.markdown,
                count: built.count,
                total: built.total,
                truncated: built.truncated,
                filename: built.filename,
                targetDir: exportsDir(configStore.rootDir()),
              })
            }

            case 'export/write': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              await store.load()
              const result = await writeExport({
                insights: await store.list({ includeArchived: payload.includeArchived === true }),
                config: cfg,
                scope: strOr(payload.scope, ''),
                repo: strOr(payload.repo, ''),
                includeArchived: payload.includeArchived === true,
                root: configStore.rootDir(),
              })
              return ok(res, result)
            }

            case 'export/sessions': {
              // 把账本按会话导出成 NDJSON（用户要"把数据搬走"时用）
              const result = await ledger.query({ days: numOr(payload.days, 0), limit: 200000 })
              return ok(res, {
                records: result.records.length,
                badLines: result.badLines,
                days: result.days,
                root: configStore.rootDir(),
                ledgerDir: ledger.dir(),
              })
            }

            // ---------- skill 草稿（可能写进用户的仓库，所以分两步） ----------
            case 'skills/plan': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              await store.load()
              const repo = strOr(payload.repo, '')
              const repoRoot = strOr(payload.repoRoot, '')
              const drafts = planSkillDrafts(await store.list({ includeArchived: false }), { config: cfg, repo, repoRoot })
              const dir = resolveSkillDir({
                target: cfg.skills.target,
                customPath: cfg.skills.customPath,
                root: configStore.rootDir(),
                repoRoot,
              })
              return ok(res, {
                drafts,
                dir,
                target: cfg.skills.target,
                /** 会写进用户仓库时必须让面板弹确认（config.skills.confirmBeforeRepoWrite）。 */
                needsConfirm: dir.inRepo === true && cfg.skills.confirmBeforeRepoWrite !== false,
                reason: dir.reason,
              })
            }

            case 'skills/write': {
              const store = deps.insights
              if (store === undefined) return fail(res, 500, ERROR_CODES.notReady, '洞察库未就绪')
              await store.load()
              const repo = strOr(payload.repo, '')
              const repoRoot = strOr(payload.repoRoot, '')
              const dir = resolveSkillDir({
                target: cfg.skills.target,
                customPath: cfg.skills.customPath,
                root: configStore.rootDir(),
                repoRoot,
              })
              // 写仓库需要显式确认：调用方必须带 confirm: true
              if (dir.inRepo === true && cfg.skills.confirmBeforeRepoWrite !== false && payload.confirm !== true) {
                return fail(res, 409, ERROR_CODES.badRequest,
                  `目标目录在仓库内（${dir.dir}），需要显式确认后才写入。请在面板上点"确认写入"。`)
              }
              const drafts = planSkillDrafts(await store.list({ includeArchived: false }), { config: cfg, repo, repoRoot })
              const result = await writeSkillDrafts({
                dir: dir.dir,
                drafts,
                dryRun: payload.dryRun === true,
              })
              return ok(res, { ...result, dir: dir.dir, inRepo: dir.inRepo, target: cfg.skills.target })
            }

            case 'skills/validate': {
              // 把任意 SKILL.md 文本丢进来，按宿主的解析规则自检（面板的"格式自检"）
              const text = typeof payload.text === 'string' ? payload.text : ''
              if (text === '') return fail(res, 400, ERROR_CODES.badRequest, 'text 不能为空')
              return ok(res, { errors: validateSkillText(text) })
            }

            default:
              return fail(res, 404, ERROR_CODES.methodNotFound, `未知方法：${method || '(空)'}`)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          deps.logger?.warn?.(`[dsh-evolution] 路由 ${method || '(空)'} 失败：${message}`)
          return fail(res, 500, ERROR_CODES.internal, message)
        }
      },
    }), 'dsh-evolution: HTTP route')

    return dispose
  })
}

function numOr(v, fallback) {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? n : fallback
}

function strOr(v, fallback) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}

/**
 * 把分桶结果压成面板能直接渲染的形状。
 * 面板不需要每条的全部字段（那会让响应膨胀十倍），只要"哪一段、有几条、都是谁"。
 */
function summarizeBuckets(buckets) {
  const out = {}
  for (const key of ['constraints', 'repo', 'team', 'personal', 'dropped']) {
    const list = Array.isArray(buckets?.[key]) ? buckets[key] : []
    out[key] = list.slice(0, 50).map((i) => ({
      id: str(i?.id),
      title: str(i?.title),
      type: str(i?.type),
      scope: str(i?.scope),
      recurrence: Number(i?.recurrence ?? 1),
    }))
    out[`${key}Count`] = list.length
  }
  return out
}
