/**
 * dsh-evolution — 检索（决定"哪几条该被注入"）
 *
 * 三档能力，默认前两档（DESIGN §4.4）：
 *
 *   ① **热条目直取**（无依赖）—— 按作用域/类型/复现/置信/新近度打分取 top-N
 *   ② **关键词全文检索**（无依赖）—— 纯 JS 打分，不引 sqlite、不引依赖
 *   ③ 向量召回（需用户自配端点）—— **本文件不实现**，只在配置里留位
 *
 * 为什么第三档默认关、也不急着做：真正需要语义召回的只有"按问题深查"这一个
 * 场景，而注入是**无 query 的**（每次进仓库都要那几条最重要的）。把前两档做扎实，
 * 覆盖的是 95% 的使用场景；而向量化意味着把记忆正文发到外部端点 ——
 * 那是一个必须由用户显式开启的决定，不该是"为了效果更好一点"的默认。
 *
 * ⚠️ 打分必须是**确定性的**：同样的库 + 同样的配置必须给出同样的顺序。
 * 否则"试跑看到的"和"真正注入的"会漂移，试跑就没有可信度了
 * （DESIGN 决策 6 的核心不变式）。
 */
import { SCOPE_WEIGHT, TYPE_WEIGHT, SCOPES, sameRepoRootPath } from './insights-store.js'
import { str } from './paths.js'

/** 归属比对在 insights-store 里实现（入库合并与检索打分共用）；这里转出供测试与注入缓存使用。 */
export { sameRepoRootPath }

/**
 * 打分权重（都在一处，便于解释"为什么这条排前面"）。
 *
 * 每个乘数都对应一个真实判断：
 *   · scope：越具体越有用。session 作用域的条目只对那个会话成立，
 *     所以权重最低 —— 注入到别的会话里就是噪音。
 *   · type：强制约束 > 踩坑 > 有效做法 > 决策 > 事实。
 *   · recurrence：log2 增长。复现 2 次比 1 次重要，但复现 16 次不该
 *     把复现 8 次的条目压死（`2+log2(n)` 的斜率是刻意压平的）。
 *   · 新近度：半年没再出现的"坑"很可能是已经修好了的，权重衰减但不淘汰
 *     （淘汰是 curator 的活，不是检索的）。
 */
export const SCORE_WEIGHTS = Object.freeze({
  scope: 6,
  type: 3,
  recurrenceBase: 2,
  recurrenceScale: 2,
  confidence: 3,
  recencyMax: 2,
  recencyHalfLifeDays: 90,
  pinnedBonus: 20,
  acceptedBonus: 2,
})

/**
 * 单条洞察对某个仓库的相关性打分。
 *
 * @param insight - 洞察对象。
 * @param context - { repo, repoRoot, cwd, now }
 * @returns { score, parts } —— parts 让面板能解释"为什么是它"。
 */
export function scoreInsight(insight, context = {}) {
  const now = Number(context.now ?? Date.now())
  const repo = str(context.repo)
  const repoRoot = str(context.repoRoot)
  const parts = {}

  // 归属不匹配的 repo 条目直接判 0：注入了别的仓库的经验比不注入更糟。
  // 比对规则：条目带 repoRoot（新数据）时**只认路径**；老数据只有名字，按名字比。
  // 上下文拿不到 root 时退回名字比对 —— 宁可沿用弱一点的判据，也不能让
  // "带路径的新条目"在拿不到 root 的调用点（如面板列表）里全部消失。
  if (str(insight?.scope) === SCOPES.repo) {
    const itemRoot = str(insight?.repoRoot)
    if (itemRoot !== '' && repoRoot !== '') {
      if (!sameRepoRootPath(itemRoot, repoRoot)) return { score: 0, parts: { mismatch: -1 } }
    } else if (repo !== '' && str(insight?.repo) !== repo) {
      return { score: 0, parts: { mismatch: -1 } }
    }
  }

  parts.scope = (SCOPE_WEIGHT[str(insight?.scope)] ?? 1) * SCORE_WEIGHTS.scope
  parts.type = (TYPE_WEIGHT[str(insight?.type)] ?? 1) * SCORE_WEIGHTS.type
  const rec = Math.max(1, Number(insight?.recurrence ?? 1))
  parts.recurrence = (SCORE_WEIGHTS.recurrenceBase + Math.log2(rec) * SCORE_WEIGHTS.recurrenceScale) * 1
  parts.confidence = clamp01(Number(insight?.confidence ?? 0.5)) * SCORE_WEIGHTS.confidence
  parts.priority = Number(insight?.priority ?? 0)

  const lastSeen = Number(insight?.lastSeenAt ?? insight?.updatedAt ?? 0)
  if (lastSeen > 0) {
    const ageDays = Math.max(0, (now - lastSeen) / 86400000)
    // 指数衰减：90 天半衰期，最多扣 recencyMax 分（不淘汰，只降权）
    const decay = Math.pow(0.5, ageDays / SCORE_WEIGHTS.recencyHalfLifeDays)
    parts.recency = -(1 - decay) * SCORE_WEIGHTS.recencyMax
  } else {
    parts.recency = 0
  }

  if (insight?.pinned === true) parts.pinned = SCORE_WEIGHTS.pinnedBonus
  if (insight?.accepted === true) parts.accepted = SCORE_WEIGHTS.acceptedBonus
  /**
   * "被注入过很多次却还在"意味着用户没有处理它：轻微降权，避免它永远霸榜。
   * 关掉 `retrieval.reSurfaceIgnored` 时不做这个降权 —— 那个开关的语义就是
   * "我要优先重提被忽略过的条目"（某些仓库里"上次提醒过没被采纳"是纯噪音）。
   * ⚠️ 这个开关以前是死的（面板上有、代码不看），现在真的接线了。
   */
  if (context.reSurfaceIgnored !== false) {
    parts.injected = -Math.min(3, Math.log2(Math.max(0, Number(insight?.injectedCount ?? 0)) + 1))
  }

  const score = Object.values(parts).reduce((n, v) => n + (Number.isFinite(v) ? v : 0), 0)
  return { score, parts }
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

/**
 * ① 热条目直取：按分数取 top-N。
 *
 * @param insights - 全部洞察（已排除归档的）。
 * @param options - { repo, repoRoot, limit, minRecurrence, perScopeLimit, scopeFilter }
 * @returns 排序后的数组（每项带 `_score` 与 `_scoreParts`，面板可解释）
 */
export function rankInsights(insights, options = {}) {
  const now = Number(options.now ?? Date.now())
  const repo = str(options.repo)
  const repoRoot = str(options.repoRoot)
  const minRecurrence = Number(options.minRecurrence ?? 1)
  const perScopeLimit = Number(options.perScopeLimit ?? Number.POSITIVE_INFINITY)
  const scopeFilter = Array.isArray(options.scopeFilter) && options.scopeFilter.length > 0
    ? new Set(options.scopeFilter.map(str))
    : undefined

  const scored = []
  for (const item of Array.isArray(insights) ? insights : []) {
    if (!item || typeof item !== 'object') continue
    if (item.archived === true) continue
    if (Number(item.recurrence ?? 1) < minRecurrence && item.pinned !== true) continue
    if (scopeFilter !== undefined && !scopeFilter.has(str(item.scope))) continue
    const { score, parts } = scoreInsight(item, { repo, repoRoot, now, reSurfaceIgnored: options.reSurfaceIgnored })
    if (score <= 0) continue
    scored.push({ insight: item, score, parts })
  }

  // 稳定排序：分数相同按 id 排，保证同样的库永远给出同样的顺序
  scored.sort((a, b) => (b.score - a.score) || str(a.insight.id).localeCompare(str(b.insight.id)))

  // 单作用域配额：防止某一类（比如 12 条 repo 洞察）把别的段全挤掉
  const used = new Map()
  const out = []
  const skipped = []
  for (const row of scored) {
    const scope = str(row.insight.scope)
    const n = used.get(scope) ?? 0
    if (n >= perScopeLimit) { skipped.push(row.insight); continue }
    used.set(scope, n + 1)
    out.push({ ...row.insight, _score: round(row.score), _scoreParts: row.parts })
  }
  return out.slice(0, Math.max(0, Number(options.limit ?? out.length))).concat(
    // 超配额的不丢，附在末尾并打标记（面板/试跑要能显示"还有 N 条因配额未入选"）
    skipped.slice(0, 200).map((i) => ({ ...i, _score: 0, _quotaSkipped: true })),
  )
}

function round(n) {
  return Math.round(Number(n) * 1000) / 1000
}

/**
 * ② 关键词全文检索（纯 JS，零依赖）。
 *
 * 用朴素的 BM25 变体：词频饱和 + 文档长度归一 + 字段权重（标题 3x / 正文 1x）。
 * 不引 SQLite FTS5 的理由：FTS5 的分词器对中文默认是"整串一个 token"
 * （除非用 unicode61 + 自己的分词），对中文用户等于不可用；而中文这里
 * 用**二元组（bigram）**切分就够了 —— 不完美，但零依赖、跨平台、可预期。
 *
 * @param insights - 洞察数组
 * @param query - 查询串
 * @param options.limit / options.repo
 */
export function searchInsights(insights, query, options = {}) {
  const q = str(query)
  const list = (Array.isArray(insights) ? insights : []).filter((i) => i && i.archived !== true)
  /**
   * `retrieval.fullText = false` 时**明确拒绝检索**，而不是偷偷退回热条目排序：
   * 用户关掉它通常是因为不想让这条路径参与，静默换行为会让结果看起来"检索坏了"。
   * （面板的洞察页搜索框会显示这条原因。）
   */
  if (options.fullText === false && q !== '') {
    return { hits: [], terms: [], tokens: [], disabled: true, reason: '关键词检索已在配置里关闭' }
  }
  if (q === '') {
    return { hits: rankInsights(list, { repo: options.repo, limit: options.limit ?? 20 }), tokens: [], terms: [] }
  }

  const terms = tokenize(q)
  if (terms.length === 0) return { hits: [], tokens: [], terms: [] }

  // 预计算每条的字段与长度。⚠️ 文档侧必须用**不去重**的 token 流：
  // `tokenize` 返回去重集合（查询词用它），如果文档也用它，词频恒为 1，
  // BM25 的 TF 饱和与文档长度归一就全部失效 —— 一个词出现 10 次和 1 次同分。
  const docs = list.map((item) => {
    const title = str(item.title).toLowerCase()
    const detail = str(item.detail).toLowerCase()
    const titleTokens = tokenizeAll(title)
    const detailTokens = tokenizeAll(detail)
    return {
      item,
      title,
      detail,
      titleTokens,
      detailTokens,
      len: titleTokens.length * 3 + detailTokens.length,
    }
  })
  const avgLen = docs.length === 0 ? 1 : docs.reduce((n, d) => n + d.len, 0) / docs.length

  const k1 = 1.4
  const b = 0.72
  // 文档频率预计算：dfCount 原来在"每文档 × 每查询词"的循环里全量扫描所有文档，
  // 复杂度 O(文档² × 词) —— 5k 条时实测一次搜索 6 秒。这里一遍遍历建表后，
  // 每个词的 df 是 O(1)，整个检索降回毫秒级。
  const df = new Map()
  for (const doc of docs) {
    const seen = new Set(doc.titleTokens)
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1)
    for (const t of doc.detailTokens) {
      if (!seen.has(t)) { df.set(t, (df.get(t) ?? 0) + 1); seen.add(t) }
    }
  }
  const hits = []
  for (const doc of docs) {
    let score = 0
    const matched = []
    for (const term of terms) {
      const tfTitle = countOccurrences(doc.titleTokens, term)
      const tfDetail = countOccurrences(doc.detailTokens, term)
      if (tfTitle === 0 && tfDetail === 0) continue
      matched.push(term)
      // 字段权重：标题命中值 3 倍（标题是结论本身）
      const tf = tfTitle * 3 + tfDetail
      const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (doc.len / Math.max(1, avgLen))))
      const idf = Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))
      score += norm * idf
    }
    if (score <= 0) continue
    // 复现次数与 pin 作为轻微加成：同等相关度下，复现过的更可信
    const bonus = Math.log2(Math.max(1, Number(doc.item.recurrence ?? 1))) * 0.3 + (doc.item.pinned === true ? 1 : 0)
    hits.push({ ...doc.item, _score: round(score + bonus), _matched: matched })
  }

  hits.sort((a, b2) => (b2._score - a._score) || str(a.id).localeCompare(str(b2.id)))
  return {
    hits: hits.slice(0, Math.max(1, Number(options.limit ?? 20))),
    terms,
    /** 命中的关键词，面板上高亮用。 */
    tokens: terms,
  }
}

function countOccurrences(list, term) {
  let n = 0
  for (const t of list) if (t === term) n += 1
  return n
}

/**
 * 切词（去重版）。
 *
 * 规则（刻意简单、可预期，因为"检索不到"比"检索得糙"更让人困惑）：
 *   · 拉丁字母/数字：按非字母数字切分，转小写，长度 ≥2
 *   · CJK：切成**二元组**（"幂等判断" → 幂等 / 等判 / 判断）
 *   · 其它字符（标点/emoji）：全部当分隔符
 *
 * 返回去重后的词表 —— 适合当**查询词**；文档侧的词频统计要用 `tokenizeAll`，
 * 否则 TF 恒为 1（见 searchInsights 里的说明）。
 */
export function tokenize(text) {
  return [...new Set(tokenizeAll(text))]
}

/** 切词（保留重复）。文档侧词频与文档长度统计用这份。 */
export function tokenizeAll(text) {
  const s = str(text).toLowerCase()
  if (s === '') return []
  const out = []
  // 拉丁与数字串
  const latin = s.match(/[a-z0-9_]{2,}/g) ?? []
  out.push(...latin)
  // CJK 二元组
  const cjkRuns = s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []
  for (const run of cjkRuns) {
    const chars = [...run]
    if (chars.length === 1) { out.push(chars[0]); continue }
    for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1])
  }
  return out
}

/**
 * 按注入段的定义把候选分桶。
 *
 * 段的语义（见 inject.js 的 SECTION_DEFS）：
 *   · constraints ← `constraint` 类型（强制约束，措辞必须硬）
 *   · repo        ← repo 作用域的项目洞察
 *   · team        ← team 作用域
 *   · personal    ← person / session 作用域（volatile 层，每轮重算）
 *
 * @returns { constraints, repo, team, personal, dropped } —— dropped 是被配额或
 *   过滤挡掉的条目，面板要显示"还有 N 条没进去"，否则用户会以为库里就这么点东西。
 */
export function bucketForInjection(ranked, options = {}) {
  const perSection = Number(options.perSection ?? Number.POSITIVE_INFINITY)
  const buckets = { constraints: [], repo: [], team: [], personal: [], dropped: [] }
  for (const item of Array.isArray(ranked) ? ranked : []) {
    if (item._quotaSkipped === true) { buckets.dropped.push(item); continue }
    const scope = str(item.scope)
    if (str(item.type) === 'constraint') {
      if (buckets.constraints.length < perSection) buckets.constraints.push(item)
      else buckets.dropped.push(item)
      continue
    }
    if (scope === SCOPES.repo) {
      if (buckets.repo.length < perSection) buckets.repo.push(item)
      else buckets.dropped.push(item)
      continue
    }
    if (scope === SCOPES.team) {
      if (buckets.team.length < perSection) buckets.team.push(item)
      else buckets.dropped.push(item)
      continue
    }
    if (buckets.personal.length < perSection) buckets.personal.push(item)
    else buckets.dropped.push(item)
  }
  return buckets
}
