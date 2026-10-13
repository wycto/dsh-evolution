/**
 * dsh-evolution — Host 半（入口）
 *
 * 本地优先的"自动进化"插件。**Phase 0 范围**：把开发会话结构化地记进本地账本，
 * 并让用户能在面板里亲眼看到存了什么、脱敏效果如何、数据落在哪。
 * 不调用任何模型，不发任何网络请求。
 *
 * 三条贯穿全插件的纪律（每一条都有过踩坑史）：
 *
 * 1. **事件回调里绝不做重活。** `session/event` 是宿主每次 append 都会触发的
 *    回调，在这里 await 一个 git 子进程或磁盘写入，会直接拖慢整个 agent 循环，
 *    连"停止"按钮都会失灵。所以：回调里只做**内存折叠**（纯 CPU、微秒级），
 *    落盘走缓冲+定时器，git 探测走异步且结果进缓存。
 *
 * 2. **失败必须可见。** 采集失败、写盘失败、配置损坏，全部记进可查询的状态，
 *    面板上有对应展示。静默降级会让用户以为"它在工作"，而实际上什么都没记 ——
 *    这是记忆类插件最不可接受的失效方式。
 *
 * 3. **默认不做任何"往外"的事。** 不联网、不上传、不写用户的仓库目录、
 *    不动用户已有的任何文件。所有外向行为都要用户显式打开。
 */
import { ConfigStore } from './config-store.js'
import { foldEvent, foldSessionSummary, pickRepoFromSummary } from './ledger.js'
import { detectRepo, detectWorkspaceRepos } from './repo.js'
import { registerRoutes } from './routes.js'
import { dryRun } from './dry-run.js'
import { readJson, writeJsonAtomic } from './storage.js'
import { stateFile } from './paths.js'
import { createStorage } from './storage-adapter.js'
import { InjectionCache, INJECTION_SECTION_NAME, INJECTION_SECTION_ORDER } from './inject-cache.js'
import { runReview, applyReviewToState, reviewGate, todayUsage, mergeUsage } from './review.js'
import { getLlm, listModelCatalog, listProviders, resolveModel } from './llm.js'
import { redact } from './redact.js'
import { str } from './paths.js'
import { createRequire } from 'node:module'

/** 插件名。与 package.json 保持一致（宿主用它做诊断与去重）。 */
export const name = 'dsh-evolution'

/**
 * 运行时版本 = 安装到宿主的那份 package.json 的 version 字段。
 * 面板显示"服务端版本"，用于判断"升级后没重启"。
 *
 * 用 createRequire 从模块真实落点解析，而不是从 cwd 找 ——
 * 插件被装进宿主的 node_modules 后，cwd 是宿主的工程目录，
 * 只有 import.meta.url 才指向插件本体。
 */
export const RUNTIME_VERSION = createRequire(import.meta.url)('../package.json').version

/** 会话上下文的缓存上限：超过就淘汰最老的，防止长时间运行内存无限增长。 */
const SESSION_CACHE_MAX = 500

/** 历史扫描一次最多处理多少个会话（防止首次安装扫爆）。 */
const HISTORY_SCAN_MAX_SESSIONS = 300

/** 复盘重试的最小间隔（毫秒）：失败后不要立刻再打模型，避免错误的循环烧钱。 */
const REVIEW_RETRY_BACKOFF_MS = 5 * 60 * 1000

export function apply(ctx) {
  const logger = {
    info: (m) => ctx.logger?.info?.(m),
    warn: (m) => ctx.logger?.warn?.(m),
  }

  const configStore = new ConfigStore({ logger })
  // 存储经适配层装配：这里不认识具体实现类，换后端（文件/数据库/服务）只动 storage-adapter.js
  const storage = createStorage({
    getRootDir: () => configStore.rootDir(),
    getConfig: () => configStore.current(),
    logger,
  })
  const ledger = storage.ledger
  const insights = storage.insights
  const injection = new InjectionCache({
    getRootDir: () => configStore.rootDir(),
    store: insights,
    getConfig: () => configStore.current(),
    logger,
  })

  /**
   * 每会话的上下文。
   * @type {Map<string, { cwd: string, repo: string, repoRoot: string, repoNames: string[], resolved: boolean, turns: number, provider: string, model: string, lastEventAt: number, reviewing: boolean }>}
   */
  const sessionCtx = new Map()

  /** 采集与复盘运行状态（面板展示）。 */
  const runtime = {
    startedAt: Date.now(),
    eventsSeen: 0,
    eventsRecorded: 0,
    eventsSkipped: 0,
    repoResolveFailures: 0,
    historyScan: { ran: false, running: false, sessions: 0, records: 0, skipped: 0, error: '' },
    lastError: '',
    /** 自动复盘：后台任务状态（面板"洞察"页要显示"正在跑"）。 */
    review: {
      running: false,
      lastAt: 0,
      lastStatus: '',
      lastSessionId: '',
      lastError: '',
      lastModel: '',
      lastAccepted: 0,
      lastMerged: 0,
      lastRejected: 0,
      lastMs: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      /** 自动链路的触发次数与刹车次数 —— 用户要能看出"到底是没触发还是被拦了"。 */
      autoTriggers: 0,
      autoSkips: 0,
      lastSkipReason: '',
      lastBackoffUntil: 0,
    },
    /** 本次进程总共跑了多少次复盘（含手动）。 */
    reviewRuns: 0,
    /** 注入状态（面板显示"正在给哪个仓库注入几段"）。 */
    inject: { enabled: true, lastChars: 0, lastRepo: '', refreshedAt: 0, error: '' },
  }

  /** 取或建会话上下文。带 LRU 淘汰。 */
  function ctxFor(sessionId, cwd) {
    let entry = sessionCtx.get(sessionId)
    if (entry === undefined) {
      entry = {
        cwd: cwd ?? '', repo: '', repoRoot: '', repoNames: [], resolved: false,
        turns: 0, provider: '', model: '', lastEventAt: 0, reviewing: false,
      }
      sessionCtx.set(sessionId, entry)
      if (sessionCtx.size > SESSION_CACHE_MAX) {
        // Map 保持插入顺序，删第一个即最老的
        const oldest = sessionCtx.keys().next().value
        if (oldest !== undefined) sessionCtx.delete(oldest)
      }
    } else if (cwd && entry.cwd === '') {
      entry.cwd = cwd
    }
    return entry
  }

  /**
   * 记录本会话当前用的模型。
   *
   * 用途：试跑页的成本估算要按"你实际在用的模型"来算，而不是猜一个。
   * `request/header` 每次请求都会带 config（provider/model），取最后一次即可 ——
   * 用户中途切模型时以最近的为准。
   * 注意：模型名只进内存缓存 + 账本记录（供面板展示），不上传、不参与脱敏判断。
   */
  function noteModel(sessionId, event) {
    if (event?.type !== 'request/header') return
    const config = event.data?.header?.config
    if (config === null || typeof config !== 'object') return
    const entry = sessionCtx.get(sessionId)
    if (entry === undefined) return
    const provider = String(config.provider ?? '').trim()
    const model = String(config.model ?? '').trim()
    if (provider !== '') entry.provider = provider
    if (model !== '') entry.model = model
  }

  /**
   * 异步解析归属仓库。**只在会话首次出现时调用一次**，结果进缓存。
   *
   * 不阻塞事件折叠：解析完成前记录的 repo 是空的，解析完成后后续记录会带上。
   * 少数早期记录缺 repo 是可以接受的（面板上能看出来），
   * 而为了补全它们去阻塞事件回调是不可接受的。
   */
  async function resolveRepoAsync(sessionId, cwd, firstSummaryText) {
    const entry = sessionCtx.get(sessionId)
    if (entry === undefined || entry.resolved) return
    try {
      const info = await detectRepo(cwd)
      if (info !== undefined) {
        entry.repo = info.repoName
        entry.repoRoot = info.root
        entry.repoNames = [info.repoName]
        entry.resolved = true
        // 把仓库根的**父目录**登记进注入缓存的目录表：下次在同一个工作区里
        // 开会话时，注入能同步解析出归属（零 IO），而不是等到第二次。
        injection.learnRoot(info.root, info.repoName)
        void injection.refreshRoot(info.root).catch(() => { /* 尽力而为 */ })
        return
      }
      // 工作区模式：扫描一级子目录
      const ws = await detectWorkspaceRepos(cwd)
      entry.repoNames = ws.names
      if (ws.names.length > 0 && firstSummaryText !== '') {
        const picked = pickRepoFromSummary(firstSummaryText, ws.names)
        if (picked !== undefined) entry.repo = picked
      }
      entry.resolved = true
    } catch (error) {
      runtime.repoResolveFailures += 1
      runtime.lastError = `仓库归属解析失败：${error?.message ?? String(error)}`
      logger.warn?.(`[dsh-evolution] ${runtime.lastError}`)
    }
  }

  /**
   * 把一次复盘报告落到 state.json，并刷新注入缓存。
   * 抽出来是因为"手动复盘"和"自动复盘"必须走**完全相同的收尾路径** ——
   * 否则会出现"手动跑完界面上有、自动跑完界面上没有"这类难查的不一致。
   */
  async function commitReview(report) {
    try {
      const usage = report?.usage ?? { inputTokens: 0, outputTokens: 0 }
      const state = await loadState()
      const patch = { review: applyReviewToState(state, report) }
      if (configStore.current().review.countUsageAgainstBudget !== false && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
        // mergeUsage 返回新的 state（含累计后的 usage），直接取它的 usage 那一段
        patch.usage = mergeUsage(state, usage).usage
      }
      await saveState(patch)

      runtime.review.running = false
      runtime.review.lastAt = Date.now()
      runtime.review.lastStatus = str(report?.status)
      runtime.review.lastSessionId = str(report?.sessionId)
      runtime.review.lastError = str(report?.failure?.message)
      runtime.review.lastModel = str(report?.model?.model)
      runtime.review.lastAccepted = Array.isArray(report?.stored?.added) ? report.stored.added.length : 0
      runtime.review.lastMerged = Array.isArray(report?.stored?.merged) ? report.stored.merged.length : 0
      runtime.review.lastRejected = Array.isArray(report?.rejected) ? report.rejected.length : 0
      runtime.review.lastMs = Number(report?.ms ?? 0)
      runtime.review.lastInputTokens = Number(usage.inputTokens ?? 0)
      runtime.review.lastOutputTokens = Number(usage.outputTokens ?? 0)
      if (report?.status === 'failed') {
        runtime.review.lastBackoffUntil = Date.now() + REVIEW_RETRY_BACKOFF_MS
      }

      // 有产出就必须让注入立刻生效：否则用户会觉得"复盘了但没变化"
      const touched = (report?.stored?.added?.length ?? 0) + (report?.stored?.merged?.length ?? 0)
      if (touched > 0) {
        const roots = [...injection.knownRoots]
        const active = sessionCtx.get(str(report?.sessionId))?.repoRoot
        await refreshInjection(active === undefined ? roots : [...roots, active])
      }
    } catch (error) {
      runtime.review.lastError = `复盘收尾失败：${error?.message ?? String(error)}`
      logger.warn?.(`[dsh-evolution] ${runtime.review.lastError}`)
    }
  }

  /** 刷新注入缓存并更新运行状态。 */
  async function refreshInjection(roots) {
    try {
      await injection.refresh({ roots: roots ?? [] })
      const stats = injection.stats()
      runtime.inject = {
        enabled: configStore.current().inject.enabled !== false,
        lastChars: injection.describe(stats.activeRoot).totalChars,
        lastRepo: stats.activeRepo,
        refreshedAt: stats.lastRefreshAt,
        error: stats.lastError,
      }
      return stats
    } catch (error) {
      runtime.inject.error = `刷新注入缓存失败：${error?.message ?? String(error)}`
      logger.warn?.(`[dsh-evolution] ${runtime.inject.error}`)
      return undefined
    }
  }

  /**
   * 解析这次复盘该用哪个 provider/model。
   *
   * **只读配置，不猜、不兜底**（见 lib/llm.js 的 resolveModel）：
   * 没配好就返回 `source: 'none'`，由 reviewGate 拦住 —— 自动链路直接跳过，
   * 手动链路给出「去配置」的提示，两条路都不会碰模型。
   *
   * 曾经的三条兜底（内存里的会话请求头 → 宿主会话日志 → 账本最近一条）已删除：
   * 它们让「复盘花谁的钱」取决于用户当时在 DSH 里用哪个模型，既不可控也不可复现。
   * 删掉之后这个函数是纯同步的 —— 面板上「本次会用哪个模型」从此是一个**常量**。
   */
  function resolveReviewModel() {
    const resolved = resolveModel(configStore.current())
    /** `source: 'none'` 含两种：什么都没填、只填了一半 —— 两者都不复盘。 */
    if (resolved.source === 'config') return resolved
    return { provider: '', model: '', partial: resolved.partial, source: 'none' }
  }

  /**
   * 跑一次复盘（手动或自动）。
   *
   * **并发保护**：同一时刻只允许一次。模型调用可能几十秒，而面板的
   * 「现在复盘」按钮是可以连点的 —— 没有这层保护，用户点三下就是三次调用、
   * 三份账单。
   */
  async function reviewNow(args = {}) {
    if (runtime.review.running) {
      return { ok: false, status: 'running', failure: { code: 'ALREADY_RUNNING', message: '已有一次复盘在进行中，请稍候。' } }
    }
    const cfg = configStore.current()
    if (cfg.enabled === false) {
      return { ok: false, status: 'skipped', failure: { code: 'PLUGIN_DISABLED', message: '插件总开关是关的。' } }
    }
    /**
     * 唯一的**强制点**：没配复盘模型就在这里返回。两条链路（自动定时器、手动按钮）
     * 都经过这里，所以没有任何路径能在未配置的情况下碰到模型。
     *
     * 放在最前面是有意的：此时还没读账本、没跑 gate、没动 state ——
     * 失败不留下任何"复盘跑过"的痕迹，面板上只是一条明确的待办提示。
     */
    const model = resolveReviewModel()
    if (model.source === 'none') {
      runtime.review.lastSkipReason = '没有配置复盘用模型，未复盘（未调用任何模型）'
      return {
        ok: false,
        status: 'skipped',
        failure: {
          code: 'NO_REVIEW_MODEL',
          message: model.partial
            ? '复盘用模型只填了一半（提供方或模型为空）：请在「配置 → 自动复盘 → 复盘用哪个模型」里选一个。'
            : '没有配置复盘用模型：请在「配置 → 自动复盘 → 复盘用哪个模型」里选一个。'
              + '未配置时插件不会复盘，也不会默认使用你当前会话的模型。',
        },
      }
    }

    const mode = str(args.mode) || 'manual'
    const sessionId = str(args.sessionId)
    runtime.review.running = true
    // 面板要靠这两个字段显示"在动"（模型调用可能几十秒）
    runtime.review.startedAt = Date.now()
    runtime.review.phase = 'load'
    runtime.review.mode = mode
    runtime.reviewRuns += 1
    try {
      const state = await loadState()
      const report = await runReview({
        ledger,
        store: insights,
        llm: currentLlm(),
        config: cfg,
        sessionId,
        state,
        model,
        mode,
        signal: args.signal,
        redactText: (text) => redact(text, {
          redact: cfg.privacy.redact,
          stripAbsolutePaths: cfg.privacy.stripAbsolutePaths,
          stripSecrets: cfg.privacy.stripSecrets,
          customWords: cfg.privacy.customWords,
        }),
        onProgress: (phase, detail) => {
          runtime.review.phase = phase
          runtime.review.phaseDetail = detail ?? ''
        },
      })
      await commitReview(report)
      return report
    } catch (error) {
      // 兜底：runReview 内部已经把已知失败变成结构化报告，能到这里说明是 bug
      runtime.review.running = false
      const message = error?.message ?? String(error)
      runtime.review.lastError = `复盘异常：${message}`
      logger.warn?.(`[dsh-evolution] ${runtime.review.lastError}`)
      return { ok: false, status: 'failed', failure: { code: 'INTERNAL', message } }
    } finally {
      runtime.review.running = false
      runtime.review.phase = ''
    }
  }

  /**
   * 模型服务句柄。
   *
   * 为什么要缓存一个"随时可能被写"的引用：
   *   · `ctx.get('llm')` 在插件 `apply()` 那一刻可能还没就绪（激活顺序不保证），
   *     但它是**服务对象本身**、而不是某个包装，所以拿到一次就可以一直用。
   *   · `ctx.inject(['llm'], …)` 是宿主推荐的等待方式：服务就绪时会回调我们。
   *     两条路都走，谁先到用谁 —— 只用 `ctx.get` 会在"恰好还没注册"时误报
   *     "宿主没有模型服务"，而那个误报会让面板上的「现在复盘」按钮直接禁用。
   */
  let llmRef
  /**
   * ⚠️ 这里必须走 `ctx.inject(['llm'], cb)`，**不能**直接读根 ctx 的 `ctx.llm`：
   * cordis 对未声明依赖的服务访问是**抛异常**，而 `ctx.get('llm')` 在服务尚未
   * 注册时只返回 undefined。两种失败在面板上都表现为"宿主没有模型服务"，
   * 而真实原因完全不同 —— 用 inject 拿到的子 ctx 才是唯一稳定的通道。
   */
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], (llmCtx) => {
      const svc = getLlm(llmCtx)
      if (svc !== undefined) {
        llmRef = svc
        logger.info?.(`[dsh-evolution] 已接入宿主模型服务（提供方：${listProviders(svc).map((p) => p.id).join(',') || '暂无'}）`)
      }
    })
  }

  /** 当前模型服务（拿不到返回 undefined）。 */
  function currentLlm() {
    return llmRef
  }

  /** 供面板展示的模型服务状态（实时求值，不做任何缓存判断）。 */
  function llmState() {
    const llm = currentLlm()
    return {
      available: llm !== undefined,
      providers: listProviders(llm).map((p) => p.id),
    }
  }

  /**
   * 路由依赖。提成一处构造，保证**两条注册路径（有 / 无 sessionQuery）拿到同一套能力** ——
   * 之前 fallback 分支漏传 runtime 与 dryRun，会让精简宿主下的面板少半屏数据。
   */
  const routeDeps = {
    configStore,
    ledger,
    insights,
    injection,
    logger,
    version: RUNTIME_VERSION,
    /** 采集运行状态（面板"总览"页读它）。用函数而不是快照，保证读到的是最新值。 */
    runtimeStats: async () => ({
      ...runtime,
      uptimeMs: Date.now() - runtime.startedAt,
      sessionsTracked: sessionCtx.size,
      pluginVersion: RUNTIME_VERSION,
      dataRoot: configStore.rootDir(),
      configFile: configStore.file(),
      configError: configStore.lastError,
      pluginEnabled: configStore.current().enabled,
      ledgerEnabled: configStore.current().ledger.enabled,
      reviewEnabled: configStore.current().review.enabled,
      apiUploadMode: configStore.current().api.uploadMode,
      apiEnabled: configStore.current().api.enabled,
      databaseEnabled: configStore.current().database.enabled,
      embeddingsEnabled: configStore.current().retrieval.embeddings,
      /** 存储后端（面板"数据落点"如实显示数据现在以什么形态、存在哪个文件）。 */
      storageBackend: storage.backend,
      storageLocation: ledger.dir(),
      /** 洞察库与注入的实时统计（面板要显示"现在到底有没有东西会被注入"）。 */
      insights: await insights.stats(),
      injectCache: injection.stats(),
      /** 模型服务是否可用 —— 没有它时"复盘"按钮应该明确禁用并说明原因。 */
      llmAvailable: llmState().available,
      llmProviders: llmState().providers,
    }),
    /** 把一个会话的账本折叠成摘要（面板"数据预览"里展开某个会话时用）。 */
    async sessionSummary(sessionId, maxChars) {
      const cfg = configStore.current()
      const { records } = await ledger.query({ days: 0, sessionId, limit: Number(cfg.ledger.maxRecordsPerSession ?? 5000) })
      return foldSessionSummary(records, { maxChars: maxChars ?? cfg.ledger.maxCharsPerSession })
    },
    /**
     * 试跑：渲染"将来会产出 / 会注入"的内容并估算成本。
     * **只读** —— 不调模型、不写文件、不推进水位（不变式由 lib/dry-run.js 的结构保证：
     * 它只 import 读取类原语，不 import 任何写函数）。
     */
    dryRun: async (args) => {
      const sessionId = str(args?.sessionId)
      /**
       * 成本估算必须用**真正会用于复盘的那个模型**，也就是配置里写的那个。
       * 以前这里还会顺着会话日志去猜模型，于是试跑页按另一个模型报价 ——
       * 那正是"我以为它用 X，账单却按 Y 算"的来源。现在没有"猜"这条路了。
       */
      const resolved = resolveReviewModel()
      const report = await dryRun({
        ledger,
        config: configStore.current(),
        sessionId,
        model: str(args?.model) || resolved.model,
        insights,
        injection,
      })
      return { ...report, modelSource: str(args?.model) !== '' ? 'manual' : resolved.source }
    },
    /** 复盘（手动/自动走同一条链路）。 */
    reviewNow,
    /** 只读的 gate 判定（面板显示"会不会自动跑"而不用真的跑一次）。 */
    reviewPreview: async (args) => {
      const cfg = configStore.current()
      const sessionId = str(args?.sessionId)
      /**
       * ⚠️ 指定会话时必须**把 sessionId 下推给账本查询**，不能在内存里过滤。
       * 账本查询有"最多返回 N 条"的保护（默认 2000，按时间截断），
       * 先截断再过滤会让较早的会话看起来"不存在" —— 复盘会报"账本里没有这个会话"，
       * 而它明明就在盘上。这个 bug 真出现过。
       */
      const perSession = Number(cfg.ledger.maxRecordsPerSession ?? 5000)
      const { records } = sessionId !== ''
        ? await ledger.query({ days: 0, sessionId, limit: perSession })
        : await ledger.query({ days: 0, limit: perSession })
      const bySession = new Map()
      for (const r of records) {
        const sid = str(r?.sid)
        if (sid === '') continue
        const bucket = bySession.get(sid) ?? []
        bucket.push(r)
        bySession.set(sid, bucket)
      }
      let targetId = sessionId
      if (targetId === '' || !bySession.has(targetId)) {
        if (sessionId !== '') {
          return { ok: false, reason: 'session-not-found', message: `账本里找不到会话 ${sessionId}（可能已被清理，或不在最近 ${perSession} 条记录内）。` }
        }
        let best = ''
        let bestTs = -1
        for (const [sid, rs] of bySession) {
          const ts = Number(rs[rs.length - 1]?.ts ?? 0)
          if (ts > bestTs) { bestTs = ts; best = sid }
        }
        targetId = best
      }
      if (targetId === '') return { ok: false, reason: 'no-sessions', message: '账本里还没有会话记录。' }
      const summary = foldSessionSummary(bySession.get(targetId) ?? [], { maxChars: cfg.ledger.maxCharsPerSession })
      const state = await loadState()
      const watermark = state?.review?.watermarks?.[targetId] ?? {}
      const model = resolveReviewModel()
      return {
        ok: true,
        sessionId: targetId,
        repo: str(summary.repo),
        turns: summary.turns,
        gate: reviewGate({ config: cfg, summary, watermark, mode: str(args?.mode) || 'manual', model }),
        model,
        llmAvailable: llmState().available,
        usage: todayUsage(state),
        budget: cfg.review.dailyTokenBudget,
      }
    },
    /**
     * 模型目录：面板的「复盘用哪个模型」选择器读它。
     *
     * 为什么要做成选择器：`review.provider` / `review.model` 以前是两个空输入框，
     * 用户**不知道该填什么**，而填错只会得到一句对用户毫无帮助的 `NO_ADAPTER`。
     * 这里把宿主真实注册的模型摊开，并同时回答"留空时会用哪个"。
     *
     * 只读：不写配置、不调模型（`listModels()` 只读适配器的清单）。
     */
    modelCatalog: async (args) => {
      const catalog = await listModelCatalog(currentLlm(), { force: args?.force === true })
      const resolved = resolveReviewModel()
      return {
        ...catalog,
        resolved,
        llmAvailable: llmState().available,
        note: '列表来自宿主已注册的提供方。面板只让用户从这份目录里选（不做手填），'
          + '但配置里已有的旧值会原样显示并保留。'
          + '**必须显式选一个**：留空表示不复盘，插件不会替你猜、也不会默认用当前会话的模型。',
      }
    },
    /** 当前 state（面板显示水位/用量/暂停状态）。 */
    readState: () => loadState(),
    /** 写 state（面板的"暂停复盘 N 小时"用）。 */
    writeState: (patch) => saveState(patch),
    /** 刷新注入缓存（改了配置或删了洞察后立刻生效）。 */
    refreshInjection,
  }

  /**
   * 自动复盘的防抖定时器（每会话一个）。
   *
   * 用"每会话一个定时器"而不是全局轮询：定时器在 `turn/end` 时被重置，
   * 所以**用户还在连续对话时永远不会触发** —— 这正是我们想要的
   * （DESIGN：绝不和用户的任务抢模型注意力）。
   *
   * ⚠️ 声明位置必须在 `session/event` 订阅之前：订阅回调是同步执行的，
   * 而 `const` 在声明前处于 TDZ —— 定时器回调虽然异步，但 `Map` 本身
   * 会被回调链引用，放在后面会让"首屏事件"撞上未初始化错误。
   */
  const autoReviewTimers = new Map()

  /** 在 turn/end 时安排一次"静默后再考虑复盘"。**同步、微秒级、零 IO。** */
  function scheduleAutoReview(sessionId) {
    const cfg = configStore.current()
    if (!cfg.enabled || cfg.review.enabled !== true) return
    const delay = Number(cfg.review.idleDebounceMs ?? 60000)
    const prev = autoReviewTimers.get(sessionId)
    if (prev !== undefined) clearTimeout(prev)
    const timer = setTimeout(() => {
      autoReviewTimers.delete(sessionId)
      void maybeAutoReview(sessionId)
    }, delay)
    timer?.unref?.()
    autoReviewTimers.set(sessionId, timer)
  }

  // ---------- 注入：systemPrompt 段 ----------
  // ⚠️ 这段的文本求值是**同步**的（宿主 assemble 时直接调 `section.text(context)`），
  // 所以里面只能读内存缓存 —— 任何 IO 都会拖慢 agent 的每一步。
  // 缓存由 refreshInjection() 在后台刷新（复盘完成 / 配置变更 / 仓库切换时）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (spCtx) => {
      spCtx.effect(() => spCtx.systemPrompt.section({
        name: INJECTION_SECTION_NAME,
        order: INJECTION_SECTION_ORDER,
        /**
         * 段文本按上下文求值。`context.agent.session.header.cwd` 是宿主
         * 在 assemble 时放进来的（`assembleContextFor`）—— 这是**唯一**能拿到
         * "本次组装属于哪个工作目录"的通道。
         *
         * 拿不到 cwd、或认不出仓库时返回空串：空的段会被 renderPrompt 丢掉，
         * 所以"认不出"的代价是**不注入**，而不是注入错仓库的经验。
         */
        text: (context) => {
          try {
            const cfg = configStore.current()
            if (cfg.enabled === false || cfg.inject.enabled === false) return ''
            const cwd = str(context?.agent?.session?.header?.cwd)
            const text = injection.textFor(cwd)
            if (text !== '') {
              runtime.inject.lastChars = text.length
              runtime.inject.lastRepo = injection.stats().activeRepo
            }
            return text
          } catch (error) {
            // 注入失败**绝不能**让 agent 的每一步都抛异常 —— 降级为"本次不注入"，
            // 并把原因记进运行状态让面板可见（失败必须可见，但不能阻断主流程）。
            runtime.inject.error = `注入求值失败：${error?.message ?? String(error)}`
            return ''
          }
        },
      }), 'dsh-evolution: system prompt section')
    })
  }

  // ---------- 采集：session/event ----------
  // sessionQuery 必须先就绪：直接 ctx.get('sessionQuery') 可能拿到 undefined，
  // 那会让整条采集链路静默失效（profile 插件没有 inject 声明，激活顺序不保证）。
  //
  // 另外这里显式判断 ctx.inject 是否存在：某些组合（精简的 CLI 宿主）不提供
  // sessionQuery，此时应该安静地不做采集，而不是在插件加载阶段抛异常 ——
  // 一个可选能力不该让整个宿主起不来。
  if (typeof ctx.inject !== 'function') {
    logger.warn?.('[dsh-evolution] 宿主未提供 ctx.inject，已跳过采集；面板只读展示已有数据')
    registerRoutes(ctx, routeDeps)
    return
  }

  ctx.inject(['sessionQuery'], (sqCtx) => {
    sqCtx.on('session/event', (session, event) => {
      try {
        const cfg = configStore.current()
        if (!cfg.enabled || !cfg.ledger.enabled) return
        runtime.eventsSeen += 1

        const sessionId = String(session?.id ?? session?.header?.id ?? '')
        if (sessionId === '') { runtime.eventsSkipped += 1; return }
        const cwd = String(session?.header?.cwd ?? '')

        const entry = ctxFor(sessionId, cwd)
        entry.lastEventAt = Date.now()
        // 记录本次请求用的模型（用于试跑页的成本估算）
        noteModel(sessionId, event)

        if (!entry.resolved && cwd !== '') {
          // 首次见到这个会话：异步解析归属（不 await）
          void resolveRepoAsync(sessionId, cwd, '')
        }

        const record = foldEvent(session, event, {
          config: cfg,
          repo: entry.repo,
          repoRoot: entry.repoRoot,
          cwd,
          model: entry.model,
        })
        if (record === undefined) { runtime.eventsSkipped += 1; return }

        // 折叠后如果发现这次事件带来了摘要文本，用它补一次归属判定
        if (record.kind === 'user_message' && !entry.resolved) {
          void resolveRepoAsync(sessionId, cwd, record.text ?? '')
        }

        // 轮次结束 = 一次"会话进度"的里程碑。这里只做**内存计数 + 触发一个
        // 防抖定时器**，绝不在回调里 await 任何东西（纪律 1）。
        if (record.kind === 'turn_end') {
          entry.turns = Number(record.turn ?? entry.turns) || entry.turns
          scheduleAutoReview(sessionId)
        }

        ledger.add(record)
        runtime.eventsRecorded += 1
      } catch (error) {
        runtime.lastError = `事件采集失败：${error?.message ?? String(error)}`
        logger.warn?.(`[dsh-evolution] ${runtime.lastError}`)
      }
    })

    // 会话销毁：把该会话的缓冲落盘，避免用户关掉会话后数据还悬在内存里
    sqCtx.on('session/disposed', (session) => {
      const sessionId = String(session?.id ?? session?.header?.id ?? '')
      if (sessionId === '') return
      void ledger.flushSession(sessionId)
      sessionCtx.delete(sessionId)
      const timer = autoReviewTimers.get(sessionId)
      if (timer !== undefined) {
        clearTimeout(timer)
        autoReviewTimers.delete(sessionId)
      }
    })

    // 历史回扫：默认只在首次（state 里没有记录）跑一次
    const scanTimer = setTimeout(() => { void maybeScanHistory(sqCtx) }, 3000)
    scanTimer?.unref?.()
    sqCtx.effect(() => () => clearTimeout(scanTimer))

    // 启动后把注入缓存预热一次（复盘结果要能立刻生效，而不是等第一次复盘）
    const warmTimer = setTimeout(() => { void warmInjection() }, 5000)
    warmTimer?.unref?.()
    sqCtx.effect(() => () => clearTimeout(warmTimer))

    // 账本保留期清理（ledger.retentionDays，默认 0 = 永久）：启动时跑一次，
    // 不在事件路径上。删的是"整片过期"的天分片，属于低频后台维护。
    const pruneTimer = setTimeout(() => {
      void ledger.prune(configStore.current().ledger.retentionDays).catch(() => { /* 尽力而为 */ })
    }, 8000)
    pruneTimer?.unref?.()
    sqCtx.effect(() => () => clearTimeout(pruneTimer))

    // 卸载时把内存缓冲落盘并释放定时器。
    // 挂在 sqCtx.effect 上而不是 ctx.on('dispose')：effect 是 cordis 的
    // 标准清理通道，宿主卸载插件时会按注册顺序逆序执行，语义明确。
    sqCtx.effect(() => () => {
      void ledger.flushAll().catch(() => { /* 卸载路径上尽力而为，不阻塞 */ })
      ledger.dispose()
      insights.dispose?.()
      for (const timer of autoReviewTimers.values()) clearTimeout(timer)
      autoReviewTimers.clear()
    })
  })

  /**
   * 自动复盘的实际判定。走到这里说明会话已经静默了 idleDebounceMs。
   *
   * 顺序刻意是"先查 gate 再花钱"：gate 全在本地判断，零成本；
   * 只有在所有条件都满足时才真的调模型。
   */
  async function maybeAutoReview(sessionId) {
    const cfg = configStore.current()
    if (!cfg.enabled || cfg.review.enabled !== true) return
    if (runtime.review.running) {
      runtime.review.autoSkips += 1
      runtime.review.lastSkipReason = '已有一次复盘在进行中'
      return
    }
    const entry = sessionCtx.get(sessionId)
    if (entry === undefined) return

    // 会话静默判定：定时器触发时再确认一次（用户可能刚好又开始打字）。
    // 这一条**就是**"只在空闲时复盘"的全部实现：定时器只在 turn/end 后排，
    // 且必须静默满 idleDebounceMs 才会触发 —— 用户连续对话时永远不会满足。
    // （旧版本这里还有一个 `review.onlyWhenIdle` 开关，但它的条件与上面的
    // 静默判定完全重复，是永远走不到的死分支；该配置项已移除。）
    const idleFor = Date.now() - Number(entry.lastEventAt ?? 0)
    if (idleFor < Number(cfg.review.idleDebounceMs ?? 60000)) {
      scheduleAutoReview(sessionId)
      return
    }
    // 失败退避：刚失败过就别马上再打模型
    if (Number(runtime.review.lastBackoffUntil ?? 0) > Date.now()) {
      runtime.review.autoSkips += 1
      runtime.review.lastSkipReason = '上次复盘失败，处于退避期'
      return
    }

    try {
      await ledger.flushSession(sessionId)
      const state = await loadState()
      const { records } = await ledger.query({ days: 0, sessionId, limit: 200000 })
      const summary = foldSessionSummary(records, { maxChars: cfg.ledger.maxCharsPerSession })
      const watermark = state?.review?.watermarks?.[sessionId] ?? {}
      const gate = reviewGate({ config: cfg, summary, watermark, mode: 'auto', model: resolveReviewModel() })
      if (gate.autoEligible !== true) {
        runtime.review.autoSkips += 1
        runtime.review.lastSkipReason = gate.blockers.join('；')
        return
      }
      // 预算预检：超了就不必进 runReview（省一次磁盘读，也让 skip 原因更清楚）
      const budget = checkBudgetLite(cfg, state)
      if (budget.allowed !== true) {
        runtime.review.autoSkips += 1
        runtime.review.lastSkipReason = budget.reason
        return
      }
      runtime.review.autoTriggers += 1
      await reviewNow({ sessionId, mode: 'auto' })
    } catch (error) {
      runtime.review.autoSkips += 1
      runtime.review.lastSkipReason = `自动复盘判定失败：${error?.message ?? String(error)}`
      logger.warn?.(`[dsh-evolution] ${runtime.review.lastSkipReason}`)
    }
  }

  /** 只看"今天还有没有预算"的轻量判断（不看单次估算）。 */
  function checkBudgetLite(cfg, state) {
    const budget = Number(cfg?.review?.dailyTokenBudget ?? 0) || 0
    const used = todayUsage(state)
    const spent = used.inputTokens + used.outputTokens
    if (budget <= 0 || spent < budget) return { allowed: true, reason: '' }
    return { allowed: false, reason: `今日预算已用完（${spent} / ${budget} token）` }
  }

  /**
   * 预热注入缓存。
   *
   * 为什么要预热：用户装完插件、重启、进仓库干活时，如果缓存是空的，
   * 第一次问答不会注入任何东西，而"装了却看不到效果"是最容易被卸载的时刻。
   */
  async function warmInjection() {
    try {
      await insights.load()
      // 从账本里补出已知仓库根（回扫过的历史里带 repoRoot）
      await injection.learnFromLedger(ledger)
      // 当前工作目录也算一个候选（用户就是在某个目录里启动了 DSH）
      const cwd = process.cwd()
      if (cwd !== '') {
        injection.learnRoot(cwd)
        try {
          const info = await detectRepo(cwd)
          if (info !== undefined) injection.learnRoot(info.root, info.repoName)
        } catch { /* 认不出就不登记 */ }
      }
      await refreshInjection()
    } catch (error) {
      runtime.inject.error = `预热注入缓存失败：${error?.message ?? String(error)}`
      logger.warn?.(`[dsh-evolution] ${runtime.inject.error}`)
    }
  }

  /**
   * 历史会话回扫。
   *
   * 只在**没扫过**的情况下跑（state.json 记录），否则每次重启都重扫一遍
   * 几十个会话既慢又没意义。回扫的目的仅仅是让新用户立刻看到"过去都干了啥"。
   */
  async function maybeScanHistory(sqCtx) {
    if (runtime.historyScan.running) return
    const cfg = configStore.current()
    if (!cfg.enabled || !cfg.ledger.enabled || cfg.ledger.scanHistoryOnStart !== true) return

    runtime.historyScan.running = true
    try {
      const state = await loadState()
      if (state.historyScannedAt !== undefined && state.historyScannedAt !== '') {
        runtime.historyScan.ran = true
        runtime.historyScan.error = ''
        return
      }

      const cutoff = cfg.ledger.historyDays > 0
        ? Date.now() - cfg.ledger.historyDays * 24 * 3600 * 1000
        : 0

      const sessions = await sqCtx.sessionQuery.listSessions()
      const list = Array.isArray(sessions) ? sessions : []
      let processed = 0
      let records = 0
      let skipped = 0

      for (const s of list) {
        if (processed >= HISTORY_SCAN_MAX_SESSIONS) break
        const sid = String(s?.header?.id ?? s?.id ?? '')
        if (sid === '') continue
        // 已在内存里活跃的会话不需要回扫（实时链路已经在收）
        if (sessionCtx.has(sid)) { skipped += 1; continue }

        const cwd = String(s?.header?.cwd ?? '')
        const createdAt = typeof s?.header?.createdAt === 'number' ? s.header.createdAt : 0
        if (cutoff > 0 && createdAt > 0 && createdAt < cutoff) { skipped += 1; continue }

        try {
          const snap = await sqCtx.sessionQuery.readSession(sid)
          const events = Array.isArray(snap?.events) ? snap.events : []
          if (events.length === 0) { skipped += 1; continue }

          // 回扫时归属解析走同步等待 —— 这里不在关键路径上（启动后台任务），
          // 等一个 git 探测换到正确的 repo 归属是值得的。
          const info = cwd === '' ? undefined : await detectRepo(cwd)
          const repo = info?.repoName ?? ''
          const entry = ctxFor(sid, cwd)
          entry.repo = repo
          entry.resolved = true

          for (const ev of events) {
            const record = foldEvent({ id: sid, header: { id: sid, cwd } }, ev, { config: cfg, repo, cwd })
            if (record === undefined) continue
            ledger.add(record)
            records += 1
          }
          processed += 1
          // 每处理几个会话让出一次事件循环，避免启动时把宿主卡住
          if (processed % 5 === 0) await new Promise((r) => setTimeout(r, 0))
        } catch (error) {
          skipped += 1
          logger.warn?.(`[dsh-evolution] 回扫会话 ${sid} 失败：${error?.message ?? String(error)}`)
        }
      }

      await ledger.flushAll()
      await saveState({ historyScannedAt: new Date().toISOString() })
      runtime.historyScan = { ran: true, running: false, sessions: processed, records, skipped, error: '' }
      logger.info?.(`[dsh-evolution] 历史回扫完成：${processed} 个会话 / ${records} 条记录`)
    } catch (error) {
      runtime.historyScan = {
        ran: true,
        running: false,
        sessions: 0,
        records: 0,
        skipped: 0,
        error: error?.message ?? String(error),
      }
      logger.warn?.(`[dsh-evolution] 历史回扫失败：${runtime.historyScan.error}`)
    }
  }

  /** 读 state.json（水位/一次性标记）。读不出来就当作空状态，不阻塞主流程。 */
  async function loadState() {
    try {
      const data = await readJson(stateFile(configStore.rootDir()))
      return data && typeof data === 'object' ? data : {}
    } catch (error) {
      logger.warn?.(`[dsh-evolution] 读取状态文件失败（按空状态继续）：${error?.message ?? String(error)}`)
      return {}
    }
  }

  /**
   * 合并写 state.json（原子写）。
   *
   * ⚠️ 必须**串行化**：复盘收尾、用量累计、水位更新、面板的"暂停复盘"都可能
   * 在相近时刻发生。两个"读当前 → 合并 → 写回"交错执行时，后写的会覆盖先写的，
   * 表现为"刚跑完的复盘在水位里查不到"或"暂停按钮没生效"。
   * 这里用一条 Promise 链把写操作排队 —— 比到处加锁简单，且不会漏。
   */
  let stateWriteQueue = Promise.resolve()
  async function saveState(patch) {
    const run = stateWriteQueue.then(async () => {
      const current = await loadState()
      const next = { ...current, ...patch, version: 1, updatedAt: new Date().toISOString() }
      await writeJsonAtomic(stateFile(configStore.rootDir()), next)
      return next
    })
    // 队列本身不能因为一次失败而断掉（否则后续所有写盘都静默失效）
    stateWriteQueue = run.then(() => undefined, () => undefined)
    return run
  }

  // ---------- 面板 HTTP 路由 ----------
  registerRoutes(ctx, routeDeps)
}
