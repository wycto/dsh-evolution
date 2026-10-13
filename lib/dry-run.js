/**
 * dsh-evolution — 单会话试跑（dry run）
 *
 * 目的：让用户在**开启自动复盘之前**就看到"这套东西会产出什么形状的结果、
 * 会往上下文里塞多少字、大概要花多少钱"。
 *
 * ⚠️ **核心不变式：试跑绝不写任何东西。**
 *   - 不写账本、不写 state.json、不写 observations/、不改 config.json
 *   - 不发任何网络请求、不调用任何模型
 *   - 不推进任何水位游标
 *
 * 这条不变式靠**结构**保证，而不是靠调用方记得别写：本模块只 import 读取类原语
 * （`ledger.query` / `listDays`），不 import `storage` 的任何写函数。
 * `scripts/smoke.mjs` 里有一项测试专门对比试跑前后整个数据目录的文件指纹。
 *
 * 为什么这个功能是必要的：归纳质量差的项目，价值是**负的** ——
 * 错误结论会被注入到上下文里并长期生效。用户必须能先看再决定。
 */
import { foldSessionSummary } from './ledger.js'
import { renderInjection, estimateTokens, toInjectionEntries } from './inject.js'
import { rankInsights, bucketForInjection } from './retrieve.js'
import { buildSystemPrompt } from './prompt.js'
import { dayKey } from './storage.js'
import { str } from './paths.js'

/**
 * 每百万 token 的估算单价（USD）。**只用于给用户一个数量级**，
 * 不是账单依据 —— 真实价格随 provider 与时段变化，所以面板上必须写明"估算"。
 */
const COST_TABLE = [
  { match: 'deepseek-v4-pro', in: 0.63, out: 1.89 },
  { match: 'deepseek-v4', in: 0.21, out: 0.63 },
  { match: 'deepseek-v3', in: 0.5, out: 1.1 },
  { match: 'deepseek', in: 0.21, out: 0.63 },
]
const FALLBACK_COST = { in: 0.5, out: 1.5 }

/** 按模型名匹配单价（子串匹配，未命中走兜底）。 */
function priceFor(model) {
  const m = str(model).toLowerCase()
  if (m === '') return { ...FALLBACK_COST, matched: false }
  for (const row of COST_TABLE) {
    if (m.includes(row.match)) return { in: row.in, out: row.out, matched: true }
  }
  return { ...FALLBACK_COST, matched: false }
}

/**
 * 估算一次复盘的成本。
 *
 * 组成：**输入 = 会话摘要 + 注入段 + 提示词开销**，输出 = 结构化 JSON（估计为输入的 15%）。
 * 提示词开销给 800 token 的固定值 —— 归纳的指令本身就不短。
 */
export function estimateCost(model, summaryTokens, injectionTokens) {
  const price = priceFor(model)
  const inputTokens = summaryTokens + injectionTokens + 800
  const outputTokens = Math.max(200, Math.ceil(inputTokens * 0.15))
  const usd = (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out
  return {
    model: str(model) || '(未指定，将用当前默认模型)',
    priceMatched: price.matched,
    inputTokens,
    outputTokens,
    usd,
    /**
     * 保留足够小数位：单次成本很小，四舍五入到 2 位会全变成 0.00，
     * 反而看不清"其实还是有钱的"。
     */
    usdText: usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(4)}`,
    note: '估算值，仅用于判断数量级；实际计费以你的模型提供方为准。',
  }
}

/**
 * 从账本里**用简单计数**（不调模型）导出候选观察。
 *
 * 这是诚实版的"演示数据"：它不假装是模型归纳出来的洞察，而是明明白白地说
 * "这是从你的会话记录里数出来的"。数量少、含金量低，但**每一条都是真的**，
 * 不会被误当成结论采纳。
 *
 * Phase 1 接上模型后，这一节会换成真正带证据链的洞察。
 */
export function deriveObservations(summary, records) {
  const out = []

  // 1. 反复失败的工具 —— 这是"踩坑"最直接的信号
  const toolFail = new Map()
  for (const r of records) {
    if (r?.kind === 'tool_result' && r.failed === true && str(r.tool) !== '') {
      toolFail.set(r.tool, (toolFail.get(r.tool) ?? 0) + 1)
    }
  }
  for (const [tool, count] of [...toolFail.entries()].sort((a, b) => b[1] - a[1])) {
    out.push({
      type: 'pitfall',
      title: `工具 ${tool} 在本会话失败了 ${count} 次`,
      kind: 'pitfall',
      recurrence: count,
      derived: true,
      evidence: `本会话账本中有 ${count} 条 tool_result 标记失败`,
    })
  }

  // 2. 会话规模 —— 轮次特别多往往意味着反复试错
  if (summary?.turns >= 20) {
    out.push({
      type: 'trend',
      title: `本会话有 ${summary.turns} 轮，可能属于需要拆分的复杂任务`,
      kind: 'trend',
      recurrence: 1,
      derived: true,
      evidence: `账本统计：${summary.turns} 轮 / ${summary.toolCalls} 次工具调用`,
    })
  }

  // 3. 未完成收尾的轮次 —— 出错结束的会话值得回看
  if (str(summary?.endStatus) !== '' && str(summary?.endStatus) !== 'completed') {
    out.push({
      type: 'gap',
      title: `会话以 ${summary.endStatus} 结束，可能是未完成或被中断`,
      kind: 'gap',
      recurrence: 1,
      derived: true,
      evidence: `turn/end 的 reason 为 ${summary.endStatus}`,
    })
  }

  return out
}

/**
 * 执行一次试跑。
 *
 * @param options.ledger - LedgerStore 实例（只用其读取方法）。
 * @param options.config - 已归一化的配置。
 * @param options.sessionId - 目标会话；空则自动挑最近一个有记录的会话。
 * @param options.model - 用于成本估算的模型名（来自账本的 request/header）。
 * @param options.insights - InsightsStore（**只读**：list/stats）。有了它，
 *   试跑渲染的就是"真正会被注入的那几段"，而不是演示数据。
 * @param options.injection - InjectionCache（**只读**：listAll/describe）。
 * @returns 试跑报告。**调用它不会改变磁盘上的任何文件。**
 */
export async function dryRun(options) {
  const { ledger, config } = options
  const cfg = config ?? {}

  // ---- 1. 选定会话 ----
  let sessionId = str(options.sessionId)
  let records = []
  let autoPicked = false
  let sessionList = []

  const perSession = Number(cfg?.ledger?.maxRecordsPerSession ?? 5000)
  // 指定会话时下推 sessionId（理由同 review.js：先截断再过滤会让老会话"消失"）
  const recent = await ledger.query({
    days: 0,
    ...(str(options.sessionId) === '' ? {} : { sessionId: str(options.sessionId) }),
    limit: perSession,
  })
  const all = Array.isArray(recent?.records) ? recent.records : []

  // 按会话分组，最近的排前面（账本本身是按时间追加的）
  const bySession = new Map()
  for (const r of all) {
    const sid = str(r?.sid)
    if (sid === '') continue
    let bucket = bySession.get(sid)
    if (bucket === undefined) { bucket = []; bySession.set(sid, bucket) }
    bucket.push(r)
  }

  sessionList = [...bySession.entries()].map(([sid, rs]) => {
    const last = rs[rs.length - 1] ?? {}
    return {
      sessionId: sid,
      repo: str(rs.find((r) => str(r.repo) !== '')?.repo),
      repoRoot: str(rs.find((r) => str(r.repoRoot) !== '')?.repoRoot),
      records: rs.length,
      lastTs: typeof last.ts === 'number' ? last.ts : 0,
      day: str(last.day),
    }
  }).sort((a, b) => b.lastTs - a.lastTs)

  if (sessionId === '') {
    const first = sessionList[0]
    if (first === undefined) {
      return {
        ok: false,
        reason: 'no-sessions',
        message: '账本里还没有任何会话记录。先在这个工作区正常对话几轮，再回来试跑。',
        sessionList: [],
      }
    }
    sessionId = first.sessionId
    autoPicked = true
  }
  records = bySession.get(sessionId) ?? []

  if (records.length === 0) {
    return {
      ok: false,
      reason: 'session-not-found',
      message: `账本里找不到会话 ${sessionId}。可能不在最近 5000 条记录范围内，或已被清理。`,
      sessionList,
    }
  }

  // ---- 2. 折叠摘要（就是将来喂给模型的那段文本） ----
  const summary = foldSessionSummary(records, { maxChars: cfg?.ledger?.maxCharsPerSession })

  // ---- 3. 从账本里抽模型名（用于成本估算） ----
  const modelFromLedger = str(options.model) || str(records.find((r) => str(r.model) !== '')?.model)
  const modelForCost = modelFromLedger
    || str(cfg?.review?.model)
    || '(当前默认模型)'

  // ---- 4. 组装各段的条目来源 ----
  // Phase 1 起：**真的读洞察库**。没有库（或库是空的）时退回"从账本简单计数
  // 导出的候选观察"，并明确标注 derived —— 那样用户至少能看到"这套机制长什么样"，
  // 而不会以为功能坏了。
  const repoName = str(summary?.repo) || str(sessionList.find((s) => s.sessionId === sessionId)?.repo)
  const repoRoot = str(sessionList.find((s) => s.sessionId === sessionId)?.repoRoot)
  const store = options.insights
  let storedInsights = []
  let insightsError = ''
  if (store !== undefined && store !== null) {
    try {
      await store.load()
      storedInsights = await store.list({ includeArchived: false })
    } catch (error) {
      insightsError = `读取洞察库失败：${error?.message ?? String(error)}`
    }
  }

  const liveRanked = rankInsights(storedInsights, {
    repo: repoName,
    repoRoot,
    minRecurrence: Number(cfg?.retrieval?.minRecurrenceToInject ?? 1),
    perScopeLimit: Number(cfg?.retrieval?.perScopeLimit ?? 12) * 3,
    limit: Number(cfg?.retrieval?.candidatePool ?? 30),
  })
  const hasLive = liveRanked.length > 0
  const observations = hasLive ? [] : deriveObservations(summary, records)
  const sources = hasLive
    ? bucketForInjection(liveRanked, { perSection: Number(cfg?.retrieval?.perScopeLimit ?? 12) })
    : {
        constraints: [],
        repo: toInjectionEntries(observations, cfg?.inject?.maxRepoInsights),
        team: [],
        personal: [],
        dropped: [],
      }

  // ---- 5. 渲染注入（与真实注入走同一条路径） ----
  const injection = renderInjection(sources, cfg?.inject)

  // 缓存里"真的会被注入"的那份文本（来自 InjectionCache）—— 与上面按本次
  // 目标会话现算的这份**应该一致**；不一致就说明缓存没刷新，面板要能看出来。
  const cached = options.injection !== undefined && options.injection !== null
    ? safeDescribe(options.injection, repoRoot)
    : undefined

  // ---- 6. 成本估算 ----
  const summaryTokens = estimateTokens(summary?.text)
  const cost = estimateCost(modelForCost, summaryTokens, injection.totalTokens)

  // ---- 7. 预算使用情况 ----
  const budget = {
    injectionChars: injection.totalChars,
    injectionBudgetChars: injection.budgetChars,
    injectionPercent: injection.budgetChars > 0
      ? Math.round((injection.totalChars / injection.budgetChars) * 100)
      : 0,
    stableChars: injection.stableChars,
    volatileChars: injection.volatileChars,
    summaryChars: summary?.text?.length ?? 0,
    summaryTokens,
    /**
     * 完整一次复盘（不是注入）的输入 token 估算：会话摘要 + 系统提示词 + 输出。
     * 这是用户真正关心的那个数字 —— "点一次复盘要花多少钱"。
     */
    reviewInputTokens: summaryTokens + estimateTokens(buildSystemPrompt()) + 200,
  }
  budget.reviewOutputTokens = Math.max(200, Math.ceil(budget.reviewInputTokens * 0.15))

  // ---- 8. 要不要跑 / 会不会跑得起 ----
  const paused = str(cfg?.review?.pauseUntil)
  const reviewEnabled = cfg?.review?.enabled === true
  const turnsThreshold = Number(cfg?.review?.extractAfterTurns ?? 10)
  const watermark = options.watermark ?? {}
  const minNew = Number(cfg?.review?.minNewRecordsPerRun ?? 20)
  const newRecords = Math.max(0, (summary?.recordsIn ?? 0) - Number(watermark.records ?? 0))
  // 与 reviewGate 同一口径：门槛的有效值不能超过本会话的总记录数，
  // 否则一个小会话会被永久挡在门外（那是 bug，不是保守）。
  const effectiveMinNew = Math.max(1, Math.min(minNew, Number(summary?.recordsIn ?? 0)))
  const gate = {
    reviewEnabled,
    pluginEnabled: cfg?.enabled !== false,
    ledgerEnabled: cfg?.ledger?.enabled !== false,
    paused,
    turnsNow: summary?.turns ?? 0,
    turnsRequired: turnsThreshold,
    turnsSatisfied: (summary?.turns ?? 0) >= turnsThreshold,
    newRecords,
    minNewRecords: effectiveMinNew,
    minNewRecordsConfigured: minNew,
    /**
     * 如实说明"如果打开开关，这次会不会真的跑"。
     * 用户最需要知道的往往不是"产出长什么样"，而是"它什么时候会花钱"。
     */
    wouldRun: cfg?.enabled !== false
      && cfg?.ledger?.enabled !== false
      && reviewEnabled
      && paused === ''
      && (summary?.turns ?? 0) >= turnsThreshold
      && newRecords >= effectiveMinNew,
    reason: !reviewEnabled
      ? '自动复盘开关当前是关的（这是默认值）。试跑不会改变它。'
      : paused !== ''
        ? `复盘已暂停至 ${paused}。`
        : (summary?.turns ?? 0) < turnsThreshold
          ? `当前 ${summary?.turns ?? 0} 轮，未达到「攒够 ${turnsThreshold} 轮」的门槛。`
          : newRecords < effectiveMinNew
            ? `距上次复盘只新增了 ${newRecords} 条记录（门槛 ${effectiveMinNew} 条）。`
            : '条件都满足，打开开关后这次会话就会被抽取。',
  }

  return {
    ok: true,
    dryRun: true,
    /** 显式向外声明本次调用没有产生任何持久化副作用。 */
    wroteNothing: true,
    autoPicked,
    sessionList,
    session: {
      sessionId,
      repo: repoName,
      repoRoot,
      turns: summary?.turns ?? 0,
      toolCalls: summary?.toolCalls ?? 0,
      toolFailures: summary?.toolFailures ?? 0,
      tokensIn: summary?.tokensIn ?? 0,
      tokensOut: summary?.tokensOut ?? 0,
      endStatus: str(summary?.endStatus),
      startedAt: summary?.startedAt ?? 0,
      endedAt: summary?.endedAt ?? 0,
      today: dayKey(),
    },
    /** 将来会作为 LLM 输入的那段文本。 */
    summaryText: summary?.text ?? '',
    summaryTruncated: summary?.truncated === true,
    /** 从账本简单计数得到的候选观察（**仅在没有真实洞察时才有内容**）。 */
    observations,
    /** 洞察库状态：有几条、这次会用上几条。 */
    insights: {
      total: storedInsights.length,
      used: liveRanked.length,
      /** true = 这次渲染用的是真实洞察；false = 退回演示数据 */
      live: hasLive,
      error: insightsError,
      /** 被配额/预算挡在外面的（面板要显示"还有 N 条没进去"）。 */
      dropped: (sources.dropped ?? []).map((d) => ({ title: d.title, type: d.type, scope: d.scope })),
    },
    /** 四段注入的渲染结果（含每段预算与溢出情况）。 */
    injection,
    /** 注入缓存里当前生效的那一份（与上面现算的对照）。 */
    cached,
    budget,
    cost,
    gate,
    /** 提醒用户试跑的边界，避免把演示数据当成真实能力。 */
    disclaimer: hasLive
      ? '本页不调用任何模型、不写任何文件。上面的注入内容来自**真实的本地洞察库**，'
        + '就是下次进这个仓库时会被放进上下文的那几段。'
      : '本页不调用任何模型、不写任何文件。洞察库还是空的，所以下面「候选观察」是从你的账本里'
        + '数出来的演示数据，不是模型归纳的结论。跑一次「现在复盘」（会消耗模型额度）之后，'
        + '这里显示的就是真实洞察了。',
  }
}

/** 安全地读注入缓存（拿不到就返回 undefined，绝不因为缓存问题让试跑失败）。 */
function safeDescribe(injection, repoRoot) {
  try {
    const described = injection.describe(repoRoot)
    return {
      totalChars: described.totalChars,
      totalTokens: described.totalTokens,
      sections: (described.sections ?? []).map((s) => ({
        id: s.id, title: s.title, layer: s.layer, chars: s.chars, count: s.included.length,
      })),
      at: described.at,
    }
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}
