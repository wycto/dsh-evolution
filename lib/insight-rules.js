/**
 * dsh-evolution — 洞察入库前的代码层校验
 *
 * ⚠️ 这个文件是整个项目**价值符号**的守门人。
 *
 * 归纳质量差的项目，价值是**负的**：一条错误结论会被写进库、被注入上下文、
 * 长期生效，而用户会把它当成"系统要求"来遵守。所以 DESIGN §4.3 写死了一条：
 * **禁止清单不能只写在 prompt 里，必须有代码层的入库前校验。**
 * prompt 是"请求模型别这么干"，这里是"模型这么干了也进不来"。
 *
 * 四类拦截（都来自 Hermes 的踩坑记录与 DESIGN §4.3）：
 *
 * 1. **对工具/功能的负面断言 → 直接拒收**（最值钱的一条）。
 *    Hermes 的原话：这类结论 "harden into refusals the agent cites against
 *    itself for months after the actual problem was fixed"。
 *    一旦"browser 工具坏了"被沉淀并注入，它就成了 agent 长期拒绝干活的借口。
 *    → 要沉淀的是"遇到 X 时改用 Y"，而不是"Y 不可用"。
 *
 * 2. **环境依赖的失败 → 降级为 fact 且不参与晋升**。
 *    `command not found` / 缺包 / 未配凭证 是**环境问题**，不是项目知识。
 *    把它记成"这个命令不能用"会在换台机器后立刻变成假结论。
 *    → 真正该沉淀的是**修复动作**（装什么、配什么）。
 *
 * 3. **会话内已自愈的瞬时错误 → 教训是"重试模式"**，不是原始失败。
 *
 * 4. **无证据 → 不入库**。证据链是这个项目能被人复核的唯一凭据。
 *
 * 另外两类**标注而不拦截**（因为拦掉会丢真信息，标出来让人判断更合适）：
 *   · 含疑似机密（疑似模型把密钥复述进来了）→ 入库但标 `flag`，面板高亮
 *   · 一次性任务叙述 → 标注"可能不是可复用经验"，降低置信度
 *
 * 设计上刻意**规则表 + 纯函数**：规则可以被测试逐条打红，而不是散在调用点里。
 */
import { INSIGHT_TYPES, SCOPES, clipText, normalizeTitle } from './insights-store.js'
import { redact as redactText } from './redact.js'
import { str } from './paths.js'

/**
 * 兜底的脱敏函数。
 *
 * ⚠️ **安全默认必须是"脱敏"，而不是"原样通过"。**
 * 这个模块的调用方（复盘链路）会显式传入脱敏函数；但如果哪天有人加了新的
 * 调用点忘了传，默认放行就等于把密钥写进库里 —— 而这个函数的全部意义
 * 就是"模型说了不算，代码说了算"。默认按最严的规则来。
 */
function defaultRedact(text) {
  return redactText(text, { redact: true, stripAbsolutePaths: true, stripSecrets: true })
}

/** 校验结论：accepted（收下）/ downgraded（降级收下）/ rejected（拒收）。 */
export const VERDICTS = Object.freeze({
  accepted: 'accepted',
  downgraded: 'downgraded',
  rejected: 'rejected',
})

/**
 * 规则表。每条规则独立可测，`why` 会原样进面板 —— 用户有权知道
 * "为什么我这条被拒了"，否则他会以为插件坏了。
 *
 * kind:
 *   'reject'   命中即拒收
 *   'downgrade' 命中降级为 fact、去掉自动晋升资格
 *   'flag'     命中只标注，仍然入库
 */
export const INSIGHT_RULES = Object.freeze([
  // ---------- 1. 对工具/功能的负面断言（直接拒收） ----------
  {
    id: 'negative-tool-assertion',
    kind: 'reject',
    why: '对工具/功能的负面断言会硬化成 agent 长期拒绝干活的借口，一律拒收',
    patterns: [
      // 中英文都覆盖：模型可能用任一种语言复述
      /(工具|功能|插件|命令|接口)\s*(本身)?\s*(不可用|用不了|不能用|坏了|失效|有问题|不支持|不可靠|不稳定|总是失败|老是失败)/,
      /\b(?:tool|plugin|feature|command|api|endpoint)s?\b[^。.!?]{0,12}\b(?:is|are|was|were|seems?|appears?)\s+(?:broken|unavailable|unusable|unreliable|buggy|not\s+working|doesn'?t\s+work|do\s+not\s+work|not\s+supported)\b/i,
      /\b(?:broken|unavailable|unusable|unreliable)\b[^。.!?]{0,12}\b(?:tool|plugin|command|api)\b/i,
      /不建议使用\s*\S{0,12}(工具|命令|插件)/,
      /\bdo\s+not\s+use\s+(?:the\s+)?\w+\s+(?:tool|command|plugin)\b/i,
    ],
  },

  // ---------- 2. 环境依赖的失败（降级，不入晋升） ----------
  {
    id: 'environment-failure',
    kind: 'downgrade',
    why: '环境依赖的失败（缺命令/缺包/未配凭证）不是项目知识，换台机器就变成假结论；'
      + '应该沉淀的是修复动作',
    patterns: [
      /command not found/i,
      /\bnot recognized as an internal or external command\b/i,
      /\bno such file or directory\b/i,
      /\b(?:module|package)\s+not\s+found\b/i,
      /\bCannot find module\b/i,
      /\bENOENT\b/,
      /\bis not installed\b/i,
      /\bmissing\s+(?:dependency|dependencies|package|credential|credentials|api[_\s-]?key)\b/i,
      /未安装|没有安装|缺少依赖|缺少模块|找不到命令|不是内部或外部命令/,
      /未配置|没有配置|未设置.*(?:密钥|凭证|token|key)/,
      /\bno credentials?\b/i,
      /\bcredentials?\s+not\s+(?:set|configured|found)\b/i,
      /\bpermission denied\b/i,
      /\bEACCES\b/,
      /\bnetwork\s+(?:error|unreachable|timeout)\b/i,
      /\bETIMEDOUT\b|\bECONNREFUSED\b|\bENOTFOUND\b/,
    ],
  },

  // ---------- 3. 已自愈的瞬时错误（降级） ----------
  {
    id: 'transient-self-healed',
    kind: 'downgrade',
    why: '会话内已自愈的瞬时错误，可复用的教训是"重试/换法"，而不是这次失败本身',
    patterns: [
      /重试(后|之?后)?(就)?(成功|正常|好了|可以了)/,
      /再次(执行|运行|调用).{0,8}(成功|正常)/,
      /\bretry\s+(?:succeeded|worked)\b/i,
      /\bworked\s+(?:on|after)\s+(?:a\s+)?retry\b/i,
      /(重新|再)(跑|执行|试)一次.{0,6}(好了|成功|通过)/,
      /\bsucceeded\s+on\s+the\s+second\s+(?:try|attempt)\b/i,
    ],
  },

  // ---------- 4. 疑似把机密复述进结论（标注 + 强制再脱敏） ----------
  {
    id: 'possible-secret',
    kind: 'flag',
    why: '正文里出现了疑似密钥形态，已再次脱敏并标注（请人工确认）',
    patterns: [
      /\bsk-[A-Za-z0-9_-]{16,}\b/,
      /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\b(?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/i,
    ],
  },

  // ---------- 5. 一次性任务叙述（标注，降低置信度） ----------
  {
    id: 'one-off-narrative',
    kind: 'flag',
    why: '看起来是一次性任务叙述而不是可复用经验（置信度已下调）',
    patterns: [
      /^(?:本次|这次|今天|刚才)(?:的)?(?:任务|需求|会话)?[是为要需把将]/,
      /\b(?:this|the)\s+(?:one-?off|specific)\s+task\b/i,
      /用户(?:要求|让我|希望)(?:我)?(?:去)?(?:执行|完成|做)一次/,
    ],
  },
])

/** 命中检测：返回命中的规则列表（不含 kind 判定）。 */
export function matchRules(text) {
  const hay = str(text)
  if (hay === '') return []
  const hits = []
  for (const rule of INSIGHT_RULES) {
    for (const re of rule.patterns) {
      if (re.test(hay)) {
        hits.push({ id: rule.id, kind: rule.kind, why: rule.why, pattern: String(re) })
        break
      }
    }
  }
  return hits
}

/**
 * 校验一条候选洞察。
 *
 * @param candidate - 形如 { type, scope, title, detail, evidence, confidence }。
 * @param options.redactText - (text) => string，强制再脱敏的函数（注入依赖便于测试）。
 * @param options.repo - 当前归属仓库（repo 作用域必须有归属）。
 * @param options.repoRoot - 当前归属仓库根（绝对路径；归属比对优先走路径）。
 * @param options.knownScopes - 允许的作用域（默认全部）。
 * @returns { verdict, insight?, reasons: string[], flags: string[] }
 */
export function validateInsight(candidate, options = {}) {
  const reasons = []
  const flags = []
  const title = str(candidate?.title ?? candidate?.claim)
  const detail = str(candidate?.detail ?? candidate?.body)
  const type = str(candidate?.type) || INSIGHT_TYPES.fact
  const scope = str(candidate?.scope) || SCOPES.repo

  // ---- 0. 形状门槛：没有标题就没有洞察 ----
  if (title === '') {
    return { verdict: VERDICTS.rejected, reasons: ['没有标题的条目无法展示，也无法去重'], flags }
  }
  if ([...title].length < 4) {
    return { verdict: VERDICTS.rejected, reasons: ['标题过短（少于 4 字），几乎不可能是可复用经验'], flags }
  }

  // ---- 1. 证据链是硬要求 ----
  const evidence = Array.isArray(candidate?.evidence)
    ? candidate.evidence.filter((e) => e && typeof e === 'object')
    : []
  const usable = evidence.filter((e) => str(e.sessionId) !== '' || str(e.quote ?? e.text) !== '')
  if (usable.length === 0) {
    return {
      verdict: VERDICTS.rejected,
      reasons: ['没有证据链（既没有会话 id 也没有引文）。无证据的结论不许变成规范'],
      flags,
    }
  }

  // ---- 2. 禁止清单：标题 + 正文一起看 ----
  const haystack = `${title}\n${detail}`
  const hits = matchRules(haystack)
  const rejects = hits.filter((h) => h.kind === 'reject')
  if (rejects.length > 0) {
    return {
      verdict: VERDICTS.rejected,
      reasons: rejects.map((h) => `${h.why}（规则：${h.id}）`),
      flags: hits.filter((h) => h.kind === 'flag').map((h) => h.id),
    }
  }

  const downgrades = hits.filter((h) => h.kind === 'downgrade')
  for (const h of hits.filter((x) => x.kind === 'flag')) flags.push(h.id)
  for (const h of downgrades) reasons.push(h.why)

  // ---- 3. 归属：repo 作用域必须知道是哪个仓库 ----
  let finalScope = scope
  let finalType = type
  if (finalScope === SCOPES.repo && str(options.repo) === '' && str(candidate?.repo) === '') {
    reasons.push('repo 作用域但认不出归属仓库，已降为 session 作用域（避免污染所有仓库）')
    finalScope = SCOPES.session
  }

  // ---- 4. 降级：环境/瞬时失败不许是强制约束 ----
  if (downgrades.length > 0 && finalType === INSIGHT_TYPES.constraint) {
    reasons.push('环境类问题不能作为强制约束，已降级为 fact')
    finalType = INSIGHT_TYPES.fact
  }

  // ---- 5. 强制再脱敏（模型可能把上下文里的密钥复述进结论） ----
  const redactText = typeof options.redactText === 'function' ? options.redactText : defaultRedact
  const safeTitle = clipText(redactText(title), 160)
  const safeDetail = clipText(redactText(detail), 1200)
  if (safeTitle !== title || safeDetail !== detail) {
    if (!flags.includes('redacted-on-ingest')) flags.push('redacted-on-ingest')
    reasons.push('入库前二次脱敏改动了内容（原样保留在模型输出里，这里不存原文）')
  }

  // ---- 6. 置信度：降级 / 标注都要反映到数值上 ----
  let confidence = Number(candidate?.confidence ?? 0.5)
  if (!Number.isFinite(confidence)) confidence = 0.5
  confidence = Math.max(0, Math.min(1, confidence))
  if (downgrades.length > 0) confidence = Math.min(confidence, 0.35)
  if (flags.includes('one-off-narrative')) confidence = Math.min(confidence, 0.3)

  const verdict = downgrades.length > 0 || finalScope !== scope
    ? VERDICTS.downgraded
    : VERDICTS.accepted

  return {
    verdict,
    reasons,
    flags,
    insight: {
      type: finalType,
      scope: finalScope,
      repo: str(candidate?.repo) || str(options.repo),
      /** 仓库根随条目落库：注入归属比对优先走路径（名字会撞，路径不会）。 */
      repoRoot: str(candidate?.repoRoot) || str(options.repoRoot),
      title: safeTitle,
      detail: safeDetail,
      confidence,
      evidence: usable.map((e) => ({
        kind: str(e.kind) || 'session',
        sessionId: str(e.sessionId ?? e.sid),
        ...(typeof e.turn === 'number' ? { turn: Math.trunc(e.turn) } : {}),
        quote: clipText(redactText(str(e.quote ?? e.text)), 240),
      })),
      derived: candidate?.derived === true,
      /** 被降级的条目**不参与自动晋升**（见 DESIGN §4.3）。 */
      promotionEligible: downgrades.length === 0,
      originSessionId: str(candidate?.originSessionId ?? usable[0]?.sessionId),
      flags,
    },
  }
}

/**
 * 批量校验 + 单次运行内的去重。
 *
 * 去重发生在**同一批**内：模型一次输出里经常把同一条经验换个说法写两遍，
 * 如果直接入库会变成两条 recurrence=1 的条目，而不是一条 recurrence=2 ——
 * 复现计数就此失真。跨批复用靠 InsightsStore.upsert 的 dedupeKey。
 */
export function validateBatch(candidates, options = {}) {
  const accepted = []
  const downgraded = []
  const rejected = []
  const seen = new Set()

  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const result = validateInsight(raw, options)
    if (result.verdict === VERDICTS.rejected) {
      rejected.push({ title: str(raw?.title ?? raw?.claim), reasons: result.reasons })
      continue
    }
    const key = `${result.insight.type}:${result.insight.scope}:${normalizeTitle(result.insight.title)}`
    if (seen.has(key)) {
      // 同批重复：合并证据与置信度，不新增条目
      const prev = accepted.find((x) => x.__key === key) ?? downgraded.find((x) => x.__key === key)
      if (prev !== undefined) {
        prev.evidence = [...prev.evidence, ...result.insight.evidence]
        prev.confidence = Math.max(prev.confidence, result.insight.confidence)
        prev.title = [...result.insight.title].length > [...prev.title].length ? result.insight.title : prev.title
        prev.detail = [...result.insight.detail].length > [...prev.detail].length ? result.insight.detail : prev.detail
      }
      continue
    }
    seen.add(key)
    const entry = { ...result.insight, __key: key, reasons: result.reasons }
    if (result.verdict === VERDICTS.downgraded) downgraded.push(entry)
    else accepted.push(entry)
  }

  return {
    accepted,
    downgraded,
    rejected,
    /** 一次运行内的重复条数 —— 面板可以显示"模型重复了 N 条"，是 prompt 质量的信号。 */
    duplicates: (Array.isArray(candidates) ? candidates.length : 0) - accepted.length - downgraded.length - rejected.length,
  }
}

/**
 * 晋升判定：一条洞察是否够格升到更大作用域。
 *
 * 规则（DESIGN §4.2）：
 *   · `recurrence >= minRecurrence`（默认 3）—— 单次出现是噪音
 *   · 必须有证据
 *   · 被降级过的条目（promotionEligible === false）永不自动晋升
 *   · **`team` 作用域永不自动晋升**：跨人、跨仓库的规范只能由人显式操作
 *   · 已归档的不晋升
 */
export const PROMOTION_DEFAULTS = Object.freeze({
  minRecurrence: 3,
  fromScope: SCOPES.session,
  toScope: SCOPES.repo,
})

export function promotionVerdict(insight, options = {}) {
  const minRecurrence = Number(options.minRecurrence ?? PROMOTION_DEFAULTS.minRecurrence)
  const reasons = []
  if (insight?.archived === true) reasons.push('已归档')
  if (insight?.promotionEligible === false) reasons.push('曾被降级（环境类或瞬时问题）')
  if ((insight?.evidence ?? []).length === 0) reasons.push('没有证据链')
  if (Number(insight?.recurrence ?? 1) < minRecurrence) {
    reasons.push(`复现 ${insight?.recurrence ?? 1} 次 < 门槛 ${minRecurrence} 次`)
  }
  if (str(options.toScope) === SCOPES.team) reasons.push('team 作用域永不自动晋升，只能由人显式采纳')
  if (str(insight?.scope) !== str(options.fromScope ?? PROMOTION_DEFAULTS.fromScope)) {
    reasons.push(`当前作用域是 ${insight?.scope}，不在自动晋升的起点`)
  }
  return { eligible: reasons.length === 0, reasons }
}

/** 供面板展示当前生效的规则（用户有权知道什么会被拒）。 */
export function ruleDescriptions() {
  return INSIGHT_RULES.map((r) => ({
    id: r.id,
    kind: r.kind,
    why: r.why,
    count: r.patterns.length,
  }))
}
