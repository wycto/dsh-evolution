/**
 * dsh-evolution — 复盘编排（L1：单会话抽取）
 *
 * 这是整条链路里**唯一会花用户钱**的地方，所以它的每一处设计都围绕
 * "让用户能看清楚、能刹车、能后悔"：
 *
 *   · **默认关闭**（`review.enabled = false`）—— 装完即用不等于装完即花钱
 *   · **跑之前先算账**：prompt 多大、估算多少 token、今日预算还剩多少
 *   · **每日预算刹车**：超了当天直接拒绝，并把原因写在返回值里
 *   · **同一会话不重复烧钱**：水位记录"已经复盘到第几条记录"，
 *     没新增够就不许再跑（防止连点按钮把同一份摘要重复喂给模型）
 *   · **失败必须可见**：错误码 + 原文前缀都带出去，面板上能看出到底哪出了问题
 *
 * 它**不做**的事：不做网络请求（那是 lib/llm.js）、不做入库校验（lib/insight-rules.js）、
 * 不写文件（存储走 InsightsStore 与 state 通道）。这样每一层都能被单独测试，
 * 而"没有证据的结论不入库"这条铁律只在一个地方实现。
 */
import { foldSessionSummary } from './ledger.js'
import { validateBatch, promotionVerdict } from './insight-rules.js'
import { buildSystemPrompt, buildUserPrompt, buildTruncatedUserPrompt, extractCandidates, toCandidate } from './prompt.js'
import { callForJson, LLM_FAILURE_CODES } from './llm.js'
import { estimateTokens } from './inject.js'
import { SCOPES } from './insights-store.js'
import { dayKey } from './storage.js'
import { str } from './paths.js'

/** 复盘结果的稳定状态码（面板按 code 分支，不匹配文案）。 */
export const REVIEW_STATUS = Object.freeze({
  ok: 'ok',
  empty: 'empty',
  skipped: 'skipped',
  failed: 'failed',
  running: 'running',
})

/** 历史记录保留条数（state.json 里的环形缓冲）。 */
export const REVIEW_HISTORY_MAX = 60

/**
 * 读今天的用量。结构：`state.usage = { '2026-09-17': { inputTokens, outputTokens, calls } }`
 * 用日期做键而不是累加器：跨零点自动归零，不需要任何定时任务去重置。
 */
export function todayUsage(state) {
  const day = dayKey()
  const bucket = state?.usage?.[day]
  if (!bucket || typeof bucket !== 'object') {
    return { day, inputTokens: 0, outputTokens: 0, calls: 0 }
  }
  return {
    day,
    inputTokens: Number(bucket.inputTokens ?? 0) || 0,
    outputTokens: Number(bucket.outputTokens ?? 0) || 0,
    calls: Number(bucket.calls ?? 0) || 0,
  }
}

/**
 * 累计用量到 state（面板显示"今天花了多少"）。
 *
 * 返回**新的 state 对象**（不是只返回 usage 那一段）：调用方拿到就能直接
 * 合并写盘，不会出现"忘了包一层 `{usage: ...}` 于是用量永远记不上"这种
 * 静默失效 —— 这个函数存在的意义就是让调用点没有犯错的空间。
 */
export function mergeUsage(state, usage) {
  const day = dayKey()
  const all = { ...(state?.usage ?? {}) }
  const prev = all[day] ?? { inputTokens: 0, outputTokens: 0, calls: 0 }
  all[day] = {
    inputTokens: (Number(prev.inputTokens ?? 0) || 0) + (Number(usage?.inputTokens ?? 0) || 0),
    outputTokens: (Number(prev.outputTokens ?? 0) || 0) + (Number(usage?.outputTokens ?? 0) || 0),
    calls: (Number(prev.calls ?? 0) || 0) + 1,
  }
  // 只保留最近 60 天，避免 state.json 无限增长
  const days = Object.keys(all).sort().reverse()
  for (const d of days.slice(60)) delete all[d]
  return { ...(state ?? {}), usage: all }
}

/**
 * 预算检查。返回 `{ allowed, reason, used, budget, remaining }`。
 *
 * 语义刻意是"**已经花掉的 + 这次要花的**是否超预算"：只在花完之后才拦，
 * 用户就会看到"预算 10k，结果花了 30k 才停"。提前拦虽然可能拦掉
 * 本来还能跑的一次，但这是更安全的错法。
 */
export function checkBudget(config, state, estimatedTokens) {
  const budget = Number(config?.review?.dailyTokenBudget ?? 0) || 0
  const used = todayUsage(state)
  const spent = used.inputTokens + used.outputTokens
  if (budget <= 0) {
    return { allowed: true, reason: '', used: spent, budget: 0, remaining: Number.POSITIVE_INFINITY, day: used.day, calls: used.calls }
  }
  const remaining = budget - spent
  if (remaining <= 0) {
    return {
      allowed: false,
      reason: `今日预算已用完（${spent} / ${budget} token）。明天会自动恢复，或在「配置」里调高预算。`,
      used: spent,
      budget,
      remaining: 0,
      day: used.day,
      calls: used.calls,
    }
  }
  if (estimatedTokens > 0 && estimatedTokens > remaining) {
    return {
      allowed: false,
      reason: `这次复盘预计需要约 ${estimatedTokens} token，但今日预算只剩 ${remaining}。`
        + '可以调高预算、换更小的会话，或等明天。',
      used: spent,
      budget,
      remaining,
      day: used.day,
      calls: used.calls,
    }
  }
  return { allowed: true, reason: '', used: spent, budget, remaining, day: used.day, calls: used.calls }
}

/**
 * 判定"这个会话现在该不该被复盘"，并说明为什么。
 *
 * 这是面板「试跑」页最关心的那个问题（"当前条件下这次会话会不会真的被抽取"），
 * 也是自动链路与手动链路的公共入口 —— 两边用同一个 gate，才不会出现
 * "手动能跑但自动不跑"这种让人困惑的差异。
 *
 * @param options.mode - 'auto' | 'manual'。手动模式放宽"攒够轮次"与
 *   "重复烧钱"两条：用户点按钮就是明确意图，但他仍然会看到提醒。
 * @param options.model - `{ provider, model }`，来自 resolveModel()。
 *   **必须传**：没传等价于"没有可用模型"，gate 会判为不满足 —— 这是刻意的默认值，
 *   因为"忘了传"与"没配置"在后果上完全一样：都不该调用任何模型。
 */
export function reviewGate(options = {}) {
  const cfg = options.config ?? {}
  const summary = options.summary ?? {}
  const watermark = options.watermark ?? {}
  const mode = str(options.mode) || 'manual'
  const model = options.model ?? {}
  const modelProvider = str(model.provider)
  const modelId = str(model.model)
  const modelReady = modelProvider !== '' && modelId !== ''
  const modelPartial = (modelProvider === '') !== (modelId === '')
  const turns = Number(summary.turns ?? 0)
  const threshold = Number(cfg.review?.extractAfterTurns ?? 10)
  const minNew = Number(cfg.review?.minNewRecordsPerRun ?? 20)
  const recordsNow = Number(summary.recordsIn ?? 0)
  const reviewedRecords = Number(watermark.records ?? 0)
  const newRecords = Math.max(0, recordsNow - reviewedRecords)
  /**
   * 门槛的**有效值**取 `min(配置值, 本会话总记录数)`。
   *
   * 理由：门槛是防"重复烧钱"的，不是防"会话太小"的。一个只有 6 条记录的
   * 小会话永远攒不到 20 条新增，会被**永久**挡在门外 —— 那是个 bug 而不是保守。
   * 配合默认关闭的开关，"小会话跑一次"本来就是用户的明确选择。
   */
  const effectiveMinNew = Math.max(1, Math.min(minNew, recordsNow))
  const paused = str(cfg.review?.pauseUntil)
  const pauseActive = paused !== '' && Number.isNaN(Date.parse(paused)) === false && Date.parse(paused) > Date.now()

  const blockers = []
  if (cfg.enabled === false) blockers.push('插件总开关是关的')
  if (cfg.ledger?.enabled === false) blockers.push('账本采集是关的')
  /**
   * 没有配置复盘模型 —— 自动和手动**都**拦住。
   *
   * 这是"花钱要显式同意"的落点：面板上看得到原因，试跑页看得到，
   * 而真正的强制在 index.js 的 reviewNow 入口（那里连账本都不读）。
   */
  if (!modelReady) {
    blockers.push(modelPartial
      ? '复盘用模型只填了一半（提供方或模型为空），去「配置 → 自动复盘 → 复盘用哪个模型」选一个'
      : '没有配置复盘用模型，去「配置 → 自动复盘 → 复盘用哪个模型」选一个（未配置时不会调用任何模型）')
  }
  if (pauseActive) blockers.push(`复盘已暂停至 ${paused}`)
  if (turns < threshold) blockers.push(`当前 ${turns} 轮，未达到「攒够 ${threshold} 轮」的门槛`)
  if (newRecords < effectiveMinNew) {
    blockers.push(`距上次复盘只新增了 ${newRecords} 条记录（门槛 ${effectiveMinNew} 条），现在跑会重复归纳同一份内容`)
  }

  const autoEligible = blockers.length === 0 && cfg.review?.enabled === true
  // 手动模式：只拦住"钱"和"暂停"这两类，轮次/新增量降级为提醒
  const manualBlockers = []
  if (cfg.enabled === false) manualBlockers.push('插件总开关是关的')
  if (!modelReady) {
    manualBlockers.push(modelPartial
      ? '复盘用模型只填了一半（提供方或模型为空）'
      : '没有配置复盘用模型（插件不会默认使用你当前会话的模型）')
  }
  if (pauseActive) manualBlockers.push(`复盘已暂停至 ${paused}`)
  if (summary.suspiciousInput === true) manualBlockers.push('这次会话的记录读不出来（账本类型不匹配），先修数据')

  return {
    mode,
    /** 自动链路（定时器）会不会跑。 */
    autoEligible,
    /** 手动链路（点按钮）能不能跑。 */
    manualAllowed: manualBlockers.length === 0,
    /** 当前状态是否已经满足了复盘条件（与手动/自动无关的条件部分）。 */
    conditionsMet: blockers.filter((b) => !b.includes('总开关')).length === 0,
    blockers,
    manualBlockers,
    turns,
    turnsRequired: threshold,
    recordsNow,
    reviewedRecords,
    newRecords,
    minNewRecords: effectiveMinNew,
    minNewRecordsConfigured: minNew,
    paused,
    pauseActive,
    reviewEnabled: cfg.review?.enabled === true,
    /** 复盘模型是否配好（面板用它决定要不要提示"先去配置"）。 */
    modelReady,
    modelPartial,
    modelProvider,
    model: modelId,
    /** 一句话总结（面板直接显示）。 */
    reason: !modelReady
      ? '没有配置复盘用模型：不会调用任何模型，也不会默认用当前会话的模型。去「配置 → 自动复盘 → 复盘用哪个模型」选一个。'
      : cfg.review?.enabled !== true
      ? '自动复盘开关是关的（默认值）。手动按钮仍然可用。'
      : blockers.length === 0
        ? '条件都满足，可以复盘。'
        : blockers.join('；'),
  }
}

/**
 * 执行一次复盘。
 *
 * @param options.ledger - LedgerStore（只读其 query）。
 * @param options.store - InsightsStore。
 * @param options.llm - 宿主 llm 服务（拿不到会明确失败，而不是静默跳过）。
 * @param options.config - 已归一化配置。
 * @param options.sessionId - 目标会话。
 * @param options.state - 当前 state 对象（读水位/用量；写回由调用方负责）。
 * @param options.model - { provider, model }（已解析好的路由）。
 * @param options.mode - 'auto' | 'manual'。
 * @param options.dryRun - true 时只算成本、不调模型（用于「试跑」页复用同一条链路）。
 * @param options.signal - 取消信号。
 * @param options.redactText - 强制再脱敏函数。
 * @param options.onProgress - (phase, detail) => void。
 * @returns 结构化报告（含 status / usage / accepted / rejected / gate / 成本估算）
 */
export async function runReview(options = {}) {
  const cfg = options.config ?? {}
  const ledger = options.ledger
  const store = options.store
  const state = options.state ?? {}
  const mode = str(options.mode) || 'manual'
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const startedAt = Date.now()

  const base = {
    ok: false,
    status: REVIEW_STATUS.failed,
    mode,
    startedAt,
    ms: 0,
    sessionId: '',
    repo: '',
    /** 调模型之前的预算判定。 */
    gate: undefined,
    budget: undefined,
    /** prompt 与成本（"跑之前先看花多少"）。 */
    prompt: undefined,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
    /** 校验结果：分别列出收下/降级/拒收，拒收要带原因。 */
    accepted: [],
    downgraded: [],
    rejected: [],
    promoted: [],
    duplicates: 0,
    modelNotes: '',
    sessionSummary: '',
    failure: undefined,
    estimated: undefined,
  }

  // ---------- 1. 选定会话并折叠摘要 ----------
  progress('load', '读取账本')
  const sessionId = str(options.sessionId)
  // 指定会话时把 sessionId 下推给账本（见 index.js reviewPreview 里的说明：
  // 先按时间截断再在内存里过滤，会让较早的会话"看起来不存在"）
  const perSession = Number(cfg.ledger?.maxRecordsPerSession ?? 5000)
  const query = sessionId !== ''
    ? await ledger.query({ days: 0, sessionId, limit: perSession })
    : await ledger.query({ days: 0, limit: perSession })
  const all = Array.isArray(query?.records) ? query.records : []

  const bySession = new Map()
  for (const r of all) {
    const sid = str(r?.sid)
    if (sid === '') continue
    let bucket = bySession.get(sid)
    if (bucket === undefined) { bucket = []; bySession.set(sid, bucket) }
    bucket.push(r)
  }
  let targetId = sessionId
  if (targetId !== '' && !bySession.has(targetId)) {
    return {
      ...base,
      status: REVIEW_STATUS.skipped,
      sessionId: targetId,
      ms: Date.now() - startedAt,
      failure: {
        code: 'SESSION_NOT_FOUND',
        message: `账本里找不到会话 ${targetId}（可能已被清理，或不在最近 ${perSession} 条记录内）。`,
      },
    }
  }
  if (targetId === '' || !bySession.has(targetId)) {
    // 没指定就挑最近有记录的那个（与试跑页同一口径，避免"试跑看的是 A、真跑的是 B"）
    let best
    let bestTs = -1
    for (const [sid, rs] of bySession) {
      const last = rs[rs.length - 1] ?? {}
      const ts = typeof last.ts === 'number' ? last.ts : 0
      if (ts > bestTs) { bestTs = ts; best = sid }
    }
    targetId = best ?? ''
  }
  if (targetId === '') {
    return { ...base, status: REVIEW_STATUS.skipped, ms: Date.now() - startedAt, failure: { code: 'NO_SESSION', message: '账本里没有可复盘的会话记录。先正常对话几轮。' } }
  }

  const records = bySession.get(targetId) ?? []
  const summary = foldSessionSummary(records, { maxChars: cfg.ledger?.maxCharsPerSession })
  /**
   * 会话的仓库根：从该会话的账本记录里取（foldEvent 写进每条记录的 repoRoot）。
   * 复盘产出的洞察要带上它入库 —— 注入归属比对优先走路径，只存仓库名的话，
   * 撞名仓库（两个 `api/`）的经验会互相串。
   */
  const repoRoot = str(records.find((r) => str(r?.repoRoot) !== '')?.repoRoot)
  if (summary.suspiciousInput === true) {
    return {
      ...base,
      status: REVIEW_STATUS.skipped,
      sessionId: targetId,
      ms: Date.now() - startedAt,
      failure: {
        code: 'SUSPICIOUS_INPUT',
        message: '这个会话的账本记录一条都没被识别（很可能是旧版本写坏了类型），已拒绝复盘以免产出错误结论。',
      },
    }
  }

  const watermark = state?.review?.watermarks?.[targetId] ?? {}
  const gate = reviewGate({ config: cfg, summary, watermark, mode, model: options.model })
  const meta = {
    sessionId: targetId,
    repo: str(summary.repo),
    repoRoot,
    turns: summary.turns,
    toolCalls: summary.toolCalls,
    toolFailures: summary.toolFailures,
    endStatus: str(summary.endStatus),
    records: summary.recordsIn,
  }

  // ---------- 2. 组装 prompt 并估算成本 ----------
  const system = buildSystemPrompt()
  const prompt = buildUserPrompt({ summaryText: summary.text, meta })
  const estimatedInput = estimateTokens(system) + estimateTokens(prompt)
  /**
   * 成本估算。
   *
   * ⚠️ 这是**下界**而不是预测值：如果用户默认模型开了高推理强度
   * （比如 `reasoningEffort: max`），模型会先生成大量思考 token，而思考 token
   * 也按输出计费。实测一次 4.5k 输入 / 2.1k 输出的复盘里，输出侧有相当比例
   * 是推理开销。所以面板必须写明"这是估算"，并且预算刹车要按实际用量记，
   * 而不是按这个估算记。
   */
  const outputBudget = Math.max(200, Math.ceil(estimatedInput * 0.15))
  const estimated = {
    summaryChars: [...str(summary.text)].length,
    promptChars: [...prompt].length,
    inputTokens: estimatedInput,
    /** 输出估计为输入的 15%，下限 200（结构化 JSON 不可能太短）。 */
    outputTokens: outputBudget,
    truncated: summary.truncated === true,
    /** 估算所覆盖的总量（预算判断用）。 */
    totalTokens: estimatedInput + outputBudget,
    note: '估算为下界：若你的默认模型开了高推理强度，思考 token 也按输出计费，实际可能更高。以实际用量为准。',
  }
  const budget = checkBudget(cfg, state, estimated.inputTokens + estimated.outputTokens)

  const report = {
    ...base,
    sessionId: targetId,
    repo: meta.repo,
    gate,
    budget,
    estimated,
    prompt: {
      systemChars: [...system].length,
      userChars: [...prompt].length,
      /** 面板上要能看原文（用户有权看到"到底发了什么给模型"）。 */
      systemText: system,
      userText: prompt,
    },
  }

  if (options.dryRun === true) {
    return { ...report, ok: true, status: REVIEW_STATUS.skipped, ms: Date.now() - startedAt, dryRun: true, sessionMeta: meta }
  }

  if (mode === 'auto' && gate.autoEligible !== true) {
    return {
      ...report,
      status: REVIEW_STATUS.skipped,
      ms: Date.now() - startedAt,
      failure: { code: 'GATE_BLOCKED', message: `未满足自动复盘条件：${gate.blockers.join('；')}` },
      sessionMeta: meta,
    }
  }
  if (mode === 'manual' && gate.manualAllowed !== true) {
    return {
      ...report,
      status: REVIEW_STATUS.skipped,
      ms: Date.now() - startedAt,
      failure: { code: 'GATE_BLOCKED', message: `当前不能复盘：${gate.manualBlockers.join('；')}` },
      sessionMeta: meta,
    }
  }
  if (budget.allowed !== true) {
    return {
      ...report,
      status: REVIEW_STATUS.skipped,
      ms: Date.now() - startedAt,
      failure: { code: 'BUDGET_EXCEEDED', message: budget.reason },
      sessionMeta: meta,
    }
  }

  // ---------- 3. 调模型 ----------
  progress('call', '调用模型')
  const attempt = await callForJson({
    llm: options.llm,
    provider: str(options.model?.provider),
    model: str(options.model?.model),
    prompt: estimated.truncated ? buildTruncatedUserPrompt({ summaryText: summary.text, meta }) : prompt,
    system,
    temperature: 0.2,
    timeoutMs: Number(cfg.review?.timeoutMs ?? 120000),
    signal: options.signal,
    onDelta: typeof options.onDelta === 'function' ? options.onDelta : undefined,
  })

  const usage = {
    inputTokens: attempt.usage?.inputTokens ?? 0,
    outputTokens: attempt.usage?.outputTokens ?? 0,
    cacheReadTokens: attempt.usage?.cacheReadTokens ?? 0,
    totalTokens: attempt.usage?.totalTokens ?? 0,
  }
  // 宿主没报用量时用估算兜底：宁可多记一点，也不要让"用量"永远显示 0
  if (usage.totalTokens === 0 && usage.inputTokens === 0 && attempt.ok) {
    usage.inputTokens = estimated.inputTokens
    usage.outputTokens = estimateTokens(attempt.text)
    usage.totalTokens = usage.inputTokens + usage.outputTokens
    usage.estimated = true
  }

  if (!attempt.ok) {
    return {
      ...report,
      status: REVIEW_STATUS.failed,
      ms: Date.now() - startedAt,
      usage,
      model: { provider: attempt.provider, model: attempt.model },
      failure: attempt.failure ?? { code: LLM_FAILURE_CODES.unknown, message: '模型调用失败' },
      sessionMeta: meta,
      /** 失败也保留了 raw 文本，便于用户/作者判断"是模型答歪了还是请求错了"。 */
      rawText: str(attempt.text).slice(0, 2000),
    }
  }

  // ---------- 4. 解析 + 校验 ----------
  progress('validate', '校验产出')
  const extracted = extractCandidates(attempt.json)
  const candidates = extracted.candidates
    .map((raw) => toCandidate(raw, { sessionId: targetId, repo: meta.repo }))
    .filter((c) => c !== undefined)

  const maxInsights = Number(cfg.review?.maxInsightsPerRun ?? 5)
  // 截断在**校验之前**：让"最多 5 条"成为真正的上限，而不是"校验完再砍"
  const limited = candidates.slice(0, Math.max(1, maxInsights) * 3)
  const validated = validateBatch(limited, {
    repo: meta.repo,
    repoRoot: meta.repoRoot,
    redactText: typeof options.redactText === 'function' ? options.redactText : undefined,
  })

  // ---------- 5. 入库（去重合并由 store 负责） ----------
  progress('store', '写入洞察库')
  const toStore = [...validated.accepted, ...validated.downgraded].slice(0, Math.max(1, maxInsights))
  let stored = { added: [], merged: [] }
  if (store !== undefined && toStore.length > 0) {
    stored = await store.upsert(toStore.map((entry) => ({
      ...entry,
      /** 被降级的条目要带标记，晋升判定会读它。 */
      promotionEligible: entry.promotionEligible !== false,
    })), { reason: `review:${targetId}` })
  }

  // ---------- 6. 自动晋升（session → repo，recurrence 达标才升） ----------
  const promotions = []
  if (store !== undefined) {
    for (const item of [...stored.added, ...stored.merged]) {
      const verdict = promotionVerdict(item, { minRecurrence: 3, fromScope: SCOPES.session })
      if (verdict.eligible !== true) continue
      if (str(item.repo) === '') continue
      const next = await store.mutate(item.id, { scope: SCOPES.repo }, { reason: 'auto-promotion' })
      if (next !== undefined) promotions.push({ id: item.id, title: item.title, reason: `复现 ${item.recurrence} 次` })
    }
  }

  const ms = Date.now() - startedAt
  return {
    ...report,
    ok: true,
    status: toStore.length === 0 ? REVIEW_STATUS.empty : REVIEW_STATUS.ok,
    ms,
    usage,
    model: { provider: attempt.provider, model: attempt.model },
    parseStrategy: attempt.parseStrategy,
    accepted: validated.accepted.map(brief),
    downgraded: validated.downgraded.map((x) => ({ ...brief(x), reasons: x.reasons })),
    rejected: validated.rejected,
    duplicates: validated.duplicates,
    stored: { added: stored.added.map(brief), merged: stored.merged.map(brief) },
    promoted: promotions,
    modelNotes: extracted.notes,
    sessionSummary: extracted.sessionSummary,
    candidatesIn: candidates.length,
    sessionMeta: meta,
    rawPreview: str(attempt.text).slice(0, 600),
  }
}

/**
 * 面板只需要这几个字段，别把整条 evidence 都塞进响应。
 *
 * ⚠️ id 的取法要注意：`stored.added/merged` 是 store 的产物（有 id），
 * 而 `validated.accepted` 是**校验产物**（还没入库，没有 id）。
 * 早期版本统一读 `item.id`，于是报告里 `accepted[].id` 恒为空串 ——
 * 面板拿它回查就永远是"找不到"。这里退回 `key`（去重键），至少是可定位的。
 */
function brief(item) {
  return {
    id: str(item?.id) || str(item?.__key) || str(item?.key),
    type: str(item?.type),
    scope: str(item?.scope),
    title: str(item?.title),
    recurrence: Number(item?.recurrence ?? 1),
    confidence: Number(item?.confidence ?? 0),
    flags: Array.isArray(item?.flags) ? item.flags : [],
  }
}

/**
 * 更新 state 里的复盘水位与历史。
 *
 * **水位必须落盘**（DESIGN §三"不抄什么"里明确写了：Hermes 把 generation 状态
 * 只放内存，`kill -9` 就永久丢失）。这里返回新的 state 片段，由调用方原子写盘。
 *
 * @returns { review: { watermarks, history, lastRunAt, lastStatus } }
 */
export function applyReviewToState(state, report) {
  const prev = state?.review ?? {}
  const watermarks = { ...(prev.watermarks ?? {}) }
  if (str(report?.sessionId) !== '') {
    watermarks[report.sessionId] = {
      records: Number(report?.sessionMeta?.records ?? 0),
      turns: Number(report?.sessionMeta?.turns ?? 0),
      at: Date.now(),
      status: str(report?.status),
    }
    // 只保留最近 500 个会话的水位，防止无限增长
    const keys = Object.keys(watermarks)
    if (keys.length > 500) {
      const sorted = keys.sort((a, b) => Number(watermarks[a]?.at ?? 0) - Number(watermarks[b]?.at ?? 0))
      for (const k of sorted.slice(0, keys.length - 500)) delete watermarks[k]
    }
  }
  const history = [
    {
      at: Date.now(),
      sessionId: str(report?.sessionId),
      repo: str(report?.repo),
      mode: str(report?.mode),
      status: str(report?.status),
      accepted: Array.isArray(report?.accepted) ? report.accepted.length : 0,
      downgraded: Array.isArray(report?.downgraded) ? report.downgraded.length : 0,
      rejected: Array.isArray(report?.rejected) ? report.rejected.length : 0,
      merged: Array.isArray(report?.stored?.merged) ? report.stored.merged.length : 0,
      inputTokens: Number(report?.usage?.inputTokens ?? 0),
      outputTokens: Number(report?.usage?.outputTokens ?? 0),
      ms: Number(report?.ms ?? 0),
      model: str(report?.model?.model),
      failureCode: str(report?.failure?.code),
      failureMessage: str(report?.failure?.message),
    },
    ...(Array.isArray(prev.history) ? prev.history : []),
  ].slice(0, REVIEW_HISTORY_MAX)

  return {
    ...prev,
    watermarks,
    history,
    lastRunAt: Date.now(),
    lastStatus: str(report?.status),
    lastError: str(report?.failure?.message),
  }
}
