/**
 * dsh-evolution — 会话账本（L0）
 *
 * 账本是整条进化链路的地基，设计上有一条铁律：
 *
 *   **零 LLM、零网络。** 它只做结构化折叠，所以可以每轮都跑、可以在启动时
 *   回扫历史，成本近似为零。真正花钱的归纳（L1/L2）是另一条链路，且默认关闭。
 *
 * 第二条铁律：**只记信号，不记内容**。
 *   - 记：用户说了什么意图、助手给了什么结论、调了哪些工具、工具成功还是失败。
 *   - 不记：工具参数、工具输出、思考过程。这些体积大且几乎不含可复用决策，
 *     而账本是长期累积的，把噪声记进去等于给自己埋一个越来越大的坑
 *     （Hermes 的 MEMORY.md 就是这样无限膨胀的，见其 curator 铁律的由来）。
 *
 * 第三条：**形状容错**。事件结构属于宿主内部契约，跨 DSH 版本可能变化。
 * 这里所有取值都走"取不到就留空"的软路径，绝不因为某个字段改了就让整条
 * 采集链路抛异常 —— 采集失败必须是可见的降级，而不是静默中断。
 */
import { redact } from './redact.js'
import { dayKey } from './storage.js'
import { str } from './paths.js'

/** 账本记录的类型枚举。取值刻意少而明确，便于后续按 kind 做聚合与展示。 */
export const LEDGER_KINDS = Object.freeze({
  turnStart: 'turn_start',
  turnEnd: 'turn_end',
  userMessage: 'user_message',
  assistantMessage: 'assistant_message',
  toolCall: 'tool_call',
  toolResult: 'tool_result',
  sessionMeta: 'session_meta',
  sessionEnd: 'session_end',
})

/**
 * 从 ContentBlock 数组里取纯文本。忽略图片等非文本块 ——
 * 账本只关心文字，多模态内容不参与跨会话复盘。
 */
export function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 截断到 max 字符（按代码点切，避免把 emoji/中文切坏）。 */
export function clip(text, max) {
  const s = str(text)
  if (max <= 0 || s.length <= max) return s
  return `${s.slice(0, max)}…`
}

/** 安全取嵌套值：get(obj, 'a.b.c')。取不到返回 undefined。 */
function get(obj, path) {
  let cur = obj
  for (const key of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

/**
 * 从 turn/end 的 reason 里抽出"这一轮为什么结束"。
 * reason 在不同版本里可能是字符串，也可能是 { kind, error } 对象 —— 两种都处理。
 */
export function parseTurnReason(reason) {
  if (reason === undefined || reason === null) return { status: 'completed', errorCode: '', errorStatus: 0 }
  if (typeof reason === 'string') return { status: reason, errorCode: '', errorStatus: 0 }
  if (typeof reason === 'object') {
    const kind = str(reason.kind) || 'completed'
    const error = reason.error
    return {
      status: kind,
      errorCode: error ? str(error.code) : '',
      errorStatus: error && typeof error.status === 'number' ? error.status : 0,
    }
  }
  return { status: 'completed', errorCode: '', errorStatus: 0 }
}

/**
 * 判断一次 tool/result 是否失败。
 *
 * 刻意保守：只有明确看到 `isError === true` / `error` 字段 / `ok === false`
 * 才判失败。**不确定时判成功** —— 误报失败会在复盘时产出"这个工具老出错"
 * 的假结论，而这类结论恰恰是 Hermes 明确警告过要避免的
 * （"负面断言会硬化成 agent 长期拒绝干活的借口"）。
 */
export function isToolFailure(data) {
  if (!data || typeof data !== 'object') return false
  if (data.isError === true) return true
  if (data.ok === false) return true
  if (data.error !== undefined && data.error !== null) return true
  // result 里嵌套的 isError（部分工具把结果包一层）
  const nested = data.result
  if (nested && typeof nested === 'object' && nested.isError === true) return true
  return false
}

/** 从 tool/call 或 tool/result 里取工具名。字段名跨版本可能不同，都试一遍。 */
export function toolNameOf(data) {
  if (!data || typeof data !== 'object') return ''
  return str(data.name) || str(data.toolName) || str(data.tool) || str(get(data, 'call.name'))
}

/**
 * 把一条宿主 session 事件折叠成账本记录。
 *
 * @param session - 宿主 Session 对象（只读 header.id / header.cwd）。
 * @param event - 宿主 SessionEvent。
 * @param options - { config, repo } —— config 用于脱敏与截断；repo 是已解析的仓库上下文。
 * @returns 账本记录，或 undefined（该事件不采集）。
 */
export function foldEvent(session, event, options = {}) {
  if (!event || typeof event !== 'object') return undefined
  const type = str(event.type)
  const sessionId = str(session?.id) || str(get(session, 'header.id'))
  const data = event.data ?? {}
  const cfg = options.config ?? {}
  const ledgerCfg = cfg.ledger ?? {}
  const privacy = cfg.privacy ?? {}
  const maxMsg = ledgerCfg.maxCharsPerMessage ?? 1200

  const base = {
    sid: sessionId,
    seq: typeof event.seq === 'number' ? event.seq : undefined,
    ts: typeof event.time === 'number' ? event.time : Date.now(),
    day: dayKey(typeof event.time === 'number' ? event.time : Date.now()),
    kind: '',
    turn: typeof data.turn === 'number' ? data.turn : undefined,
    // 仓库上下文由调用方解析后传入（采集时做 git 探测会阻塞事件回调，绝对不行）
    repo: str(options.repo),
    /**
     * 仓库根绝对路径。**只有它是无歧义的**：仓库名会撞（两个 `api/`），
     * 而注入缓存要按"这个 cwd 属于哪个仓库"精确匹配，认错仓库的代价
     * （B 仓库读到 A 仓库的经验并被当成事实）远高于少注入一次。
     */
    repoRoot: str(options.repoRoot),
    cwd: str(options.cwd),
    // 模型名由调用方从 request/header 缓存里取（见 index.js 的 noteModel）。
    // 只记名字，不记 key/endpoint —— 那属于凭证，不该进账本。
    model: str(options.model),
  }

  switch (type) {
    case 'turn/start':
      return { ...base, kind: LEDGER_KINDS.turnStart }

    case 'turn/end': {
      const r = parseTurnReason(data.reason)
      return { ...base, kind: LEDGER_KINDS.turnEnd, status: r.status, errorCode: r.errorCode, errorStatus: r.errorStatus }
    }

    case 'user/message': {
      const text = clip(redact(blocksToText(data.content), privacy), maxMsg)
      if (text === '') return undefined
      return { ...base, kind: LEDGER_KINDS.userMessage, text }
    }

    case 'assistant/message': {
      const content = get(data, 'message.content') ?? data.content
      const text = clip(redact(blocksToText(content), privacy), maxMsg)
      const usage = data.usage
      const rec = { ...base, kind: LEDGER_KINDS.assistantMessage, text }
      if (usage && typeof usage === 'object') {
        // 只留汇总数字，用于"这次复盘花了多少"的展示与预算控制
        rec.tokensIn = num(usage.inputTokens)
        rec.tokensOut = num(usage.outputTokens)
        rec.tokensCacheRead = num(usage.cacheReadTokens)
      }
      return rec
    }

    case 'tool/call': {
      if (ledgerCfg.collectToolSignals === false) return undefined
      const name = toolNameOf(data)
      if (name === '') return undefined
      return { ...base, kind: LEDGER_KINDS.toolCall, tool: name }
    }

    case 'tool/result': {
      if (ledgerCfg.collectToolSignals === false) return undefined
      const name = toolNameOf(data)
      if (name === '') return undefined
      return { ...base, kind: LEDGER_KINDS.toolResult, tool: name, failed: isToolFailure(data) }
    }

    default:
      return undefined
  }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * 从一批账本记录折叠出"会话摘要"—— 这是给用户看的数据预览，
 * 也是将来提交给 LLM 做抽取的输入。
 *
 * ⚠️ **入参必须是"折叠后的账本记录"，不是宿主的原始事件。**
 * 这两者的类型名长得很像但完全不同：
 *   宿主事件：`user/message`、`assistant/message`、`tool/call`、`turn/end`（带斜杠）
 *   账本记录：`user_message`、`assistant_message`、`tool_call`、`turn_end`（带下划线）
 * 传错时 switch 全部不命中，摘要会**静默变成空文本**（开发时踩过一次）。
 * 所以下面加了 `recognized` 统计：一条都没认出来时调用方/面板能立刻发现，
 * 而不是拿到一个看起来"这个会话确实没内容"的空摘要。
 *
 * @param records - 同一会话的账本记录。
 * @param options - { maxChars } 摘要总长度上限，超出保留最近轮次。
 */
export function foldSessionSummary(records, options = {}) {
  const list = Array.isArray(records) ? records : []
  const maxChars = options.maxChars ?? 8000

  /** @type {Map<number, {turn:number, asks:string[], saids:string[], tools:Map<string,{ok:number,fail:number}>}>} */
  const turns = new Map()
  let toolCalls = 0
  let toolFailures = 0
  let tokensIn = 0
  let tokensOut = 0
  let startedAt = 0
  let endedAt = 0
  let endStatus = ''
  /** 认出来的记录条数。为 0 而 list 非空 = 入参大概率不是账本记录（见函数头注释）。 */
  let recognized = 0

  const ensure = (turn) => {
    const key = typeof turn === 'number' ? turn : -1
    let entry = turns.get(key)
    if (entry === undefined) {
      entry = { turn: key, asks: [], saids: [], tools: new Map() }
      turns.set(key, entry)
    }
    return entry
  }

  /**
   * 每轮的内容记录计数（用户/助手消息、工具调用与结果）。
   * 与 ensure 分开：ensure 只在"真的要产出文本"时才建轮次条目，
   * 而计数要覆盖每一轮，供 recordsInText 用（截断时算"模型真正看到了几条"）。
   */
  const recCount = new Map()
  const bumpRec = (turn) => {
    const key = typeof turn === 'number' ? turn : -1
    recCount.set(key, (recCount.get(key) ?? 0) + 1)
  }

  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue
    const ts = typeof rec.ts === 'number' ? rec.ts : 0
    if (ts > 0) {
      if (startedAt === 0 || ts < startedAt) startedAt = ts
      if (ts > endedAt) endedAt = ts
    }
    switch (rec.kind) {
      case LEDGER_KINDS.userMessage:
        recognized += 1
        bumpRec(rec.turn)
        if (rec.text) ensure(rec.turn).asks.push(rec.text)
        break
      case LEDGER_KINDS.assistantMessage: {
        recognized += 1
        bumpRec(rec.turn)
        if (rec.text) ensure(rec.turn).saids.push(rec.text)
        tokensIn += num(rec.tokensIn)
        tokensOut += num(rec.tokensOut)
        break
      }
      case LEDGER_KINDS.toolCall: {
        recognized += 1
        bumpRec(rec.turn)
        toolCalls += 1
        const t = ensure(rec.turn).tools.get(rec.tool) ?? { ok: 0, fail: 0 }
        t.ok += 1
        ensure(rec.turn).tools.set(rec.tool, t)
        break
      }
      case LEDGER_KINDS.toolResult: {
        recognized += 1
        bumpRec(rec.turn)
        if (rec.failed === true) {
          toolFailures += 1
          const t = ensure(rec.turn).tools.get(rec.tool) ?? { ok: 0, fail: 0 }
          t.ok = Math.max(0, t.ok - 1)
          t.fail += 1
          ensure(rec.turn).tools.set(rec.tool, t)
        }
        break
      }
      case LEDGER_KINDS.turnEnd:
        recognized += 1
        endStatus = str(rec.status)
        break
      case LEDGER_KINDS.turnStart:
      case LEDGER_KINDS.sessionMeta:
      case LEDGER_KINDS.sessionEnd:
        // 这几类只用于时间线与统计，不参与摘要文本，但算"认出来了"
        recognized += 1
        break
      default:
        break
    }
  }

  const orderedTurns = [...turns.values()].sort((a, b) => a.turn - b.turn)
  // maxChars 缺省 = 不限（与旧版 `text.length > undefined` 恒 false 的语义一致）
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : Number.POSITIVE_INFINITY
  // 预算按**轮边界**判断：旧版把全文拼好后用 slice 硬切，会把最后一轮拦腰斩断
  //（甚至切开 emoji 的代理对）；按轮丢弃既保住文本完整性，也让"看到了几条"
  // 有准确答案。从**最新**轮往回装（会话末尾是结论，开头多是探索过程），
  // 最新的轮永远保留；装不下的更老轮次整体丢弃并标记 truncated。
  const kept = []
  let used = 0
  let truncated = false
  for (let i = orderedTurns.length - 1; i >= 0; i -= 1) {
    const t = orderedTurns[i]
    const parts = []
    if (t.asks.length > 0) parts.push(`用户: ${t.asks.join(' / ')}`)
    if (t.saids.length > 0) parts.push(`助手: ${t.saids.join(' / ')}`)
    const toolNotes = []
    for (const [name, stat] of t.tools) {
      if (stat.fail > 0) toolNotes.push(`${name}×${stat.ok + stat.fail}(失败${stat.fail})`)
      else toolNotes.push(`${name}×${stat.ok}`)
    }
    if (toolNotes.length > 0) parts.push(`工具: ${toolNotes.join(', ')}`)
    if (parts.length === 0) continue
    const chunk = parts.join('\n')
    const cost = used === 0 ? chunk.length : used + 2 + chunk.length
    if (used > 0 && cost > budget) { truncated = true; break }
    kept.push({ turn: t.turn, chunk })
    used = cost
  }
  kept.reverse()

  const text = kept.map((k) => k.chunk).join('\n\n')
  let recordsInText = 0
  for (const k of kept) recordsInText += recCount.get(k.turn) ?? 0

  return {
    sessionId: str(list[0]?.sid),
    repo: str(list.find((r) => str(r.repo) !== '')?.repo),
    turns: orderedTurns.length,
    startedAt,
    endedAt,
    endStatus,
    toolCalls,
    toolFailures,
    tokensIn,
    tokensOut,
    text,
    truncated,
    /** 输入记录数与认出的记录数，用于识别"传错类型"这类静默错误。 */
    recordsIn: list.length,
    recognized,
    /** 文本里实际可见的内容记录数（截断时会小于 recordsIn —— 丢掉的是最老的轮次）。 */
    recordsInText,
    /** true = 输入非空但一条都没认出来，几乎一定是把宿主事件当账本记录传了。 */
    suspiciousInput: list.length > 0 && recognized === 0,
  }
}

/**
 * 会话归属判定：从摘要里数各候选仓库名的出现次数，取最多的那个。
 *
 * 这是"工作区模式"（cwd 本身不是 git 仓库，但子目录是）的归属算法，与内部版
 * dsh-memory 的 pickWorkspaceRepo 同一思路：**宁可少写，也不要写错**。
 * 一个会话跨多个仓库时只归最主要的那一个，因为把同一份会话复制到多个仓库
 * 会让每个仓库的记忆都变脏。
 *
 * @param summary - 折叠后的摘要文本。
 * @param candidates - 候选仓库名列表。
 * @returns 命中最多的仓库名，或 undefined（都没命中）。
 */
export function pickRepoFromSummary(summary, candidates) {
  const hay = str(summary).toLowerCase()
  if (hay === '' || !Array.isArray(candidates) || candidates.length === 0) return undefined
  let best
  let bestHits = 0
  for (const raw of candidates) {
    const name = str(raw)
    if (name === '') continue
    const needle = name.toLowerCase()
    let hits = 0
    let from = 0
    for (;;) {
      const at = hay.indexOf(needle, from)
      if (at === -1) break
      hits += 1
      from = at + needle.length
    }
    if (hits > bestHits) {
      bestHits = hits
      best = name
    }
  }
  // 至少出现 2 次才认领：只出现一次很可能只是"提到过这个名字"，
  // 而认错仓库的代价（污染别人的记忆库）远高于漏记一次。
  return bestHits >= 2 ? best : undefined
}
