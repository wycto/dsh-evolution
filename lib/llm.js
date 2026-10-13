/**
 * dsh-evolution — 一次性模型调用封装（走宿主 `ctx.llm`）
 *
 * **为什么用 `ctx.llm` 而不是自己发 HTTP**：DSH 用户本来就已经配好了模型
 * （否则他用不了 DSH）。让用户为了这个插件再注册账号、填 API key、选模型，
 * 绝大多数人会死在这一步 —— 这是通用版可行的第一支柱（DESIGN §4.1）。
 *
 * 三个刻意选择：
 *
 * 1. **不 import `@deepseek-ai/dsh-llm` 的任何东西。** 这个插件是被
 *    `dsh plugin add` 静态安装的，它的 node_modules 里没有 `@deepseek-ai/*`
 *    （只在宿主那边）。所以消息对象**按契约手工构造**，并通过 `ctx.llm`
 *    的存在性做运行时降级 —— 拿不到就明确报"宿主没提供模型服务"，
 *    而不是让插件加载直接崩掉。
 *
 *    （宿主 `forAdapter()` 会读 `message.source.kind`，所以 `source` 是必需的；
 *     `createUserMessage` 实际产出的就是这套字段。）
 *
 * 2. **一次流 === 一次尝试**。宿主不做重试（`dsh-llm-retry` 负责），所以这里
 *    也不做静默重试：失败就失败，把**稳定错误码**返回给面板。用户看到
 *    "RATE_LIMIT" 和看到 "fetch failed" 的应对完全不同，靠匹配文案是不行的。
 *
 * 3. **流始终以 `finish` 结束**。服务保证这一点，所以收集逻辑不需要 try/catch
 *    包住整个 for-await —— 失败是从 `finish.reason.kind === 'error'` 里读出来的。
 *    但仍然保留一个兜底 catch：宿主版本差异不该让复盘崩掉，而应该变成一条
 *    "这次没成功"的记录。
 */
import { str } from './paths.js'
import { estimateTokens } from './inject.js'

/** 稳定的失败码（宿主返回的 + 我们自己产生的）。面板按这些分支。 */
export const LLM_FAILURE_CODES = Object.freeze({
  noService: 'NO_SERVICE',
  noProvider: 'NO_PROVIDER',
  timeout: 'TIMEOUT',
  aborted: 'ABORTED',
  empty: 'EMPTY_RESPONSE',
  badJson: 'BAD_JSON',
  noAdapter: 'NO_ADAPTER',
  missingCredential: 'MISSING_CREDENTIAL',
  auth: 'AUTH',
  rateLimit: 'RATE_LIMIT',
  contextWindow: 'CONTEXT_WINDOW_EXCEEDED',
  unknown: 'UNKNOWN',
})

/** 这些码是"等一会儿可能就好了"，面板上要给出不同的建议。 */
export const RETRYABLE_CODES = Object.freeze([
  LLM_FAILURE_CODES.rateLimit,
  LLM_FAILURE_CODES.timeout,
])

/** 生成一个够用的消息 id（不 import 宿主的 brand 工具，见文件头第 1 条）。 */
function messageId() {
  const r = Math.random().toString(16).slice(2, 10)
  const t = Date.now().toString(16)
  return `dvev-${t}-${r}`
}

/**
 * 手工构造一条 user 消息（契约见 dsh-llm 的 Message 类型）。
 *
 * `source.kind = 'plugin'` 而不是 `'user'`：这条消息不是用户说的，
 * 是插件为了一次辅助调用自己造的。宿主将来在轨迹里展示时，用户可以据此
 * 区分"我说的话"和"插件替我发的请求"。
 */
export function buildUserMessage(text, plugin = 'dsh-evolution') {
  return {
    id: messageId(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: 'plugin', plugin },
  }
}

/**
 * 取宿主 LlmRuntime 服务（拿不到返回 undefined，绝不抛）。
 *
 * ⚠️ **必须传"声明过 inject: ['llm'] 的那个 ctx"**，不能传插件的根 ctx。
 * cordis 的 `ctx.llm` 在没有声明依赖时会**抛异常**
 * （`cannot get property "llm" without inject`），
 * 而不是返回 undefined —— 所以"顺手读一下 ctx.llm"在插件根 ctx 上永远失败。
 * 拿服务只有两条合法路径：`ctx.inject(['llm'], cb)` 或 `ctx.get('llm')`。
 *
 * 这里保留两条并用 try 包住：`ctx.get` 是安全读取（未注册返回 undefined），
 * `ctx.llm` 只在已经 inject 过的 ctx 上才可能成立。
 */
export function getLlm(ctx) {
  if (ctx === null || ctx === undefined) return undefined
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (viaGet !== undefined && viaGet !== null && typeof viaGet.stream === 'function') return viaGet
  } catch {
    // get 在某些 ctx 上也可能不可用：继续试属性访问
  }
  try {
    const viaProp = ctx.llm
    if (viaProp !== undefined && viaProp !== null && typeof viaProp.stream === 'function') return viaProp
  } catch {
    // 未声明 inject：这是**预期**的失败，不是错误
  }
  return undefined
}

/** 列出可用提供方（拿不到就返回空数组 —— 面板显示"未知"而不是崩）。 */
export function listProviders(llm) {
  if (llm === null || llm === undefined || typeof llm.listProviders !== 'function') return []
  try {
    const list = llm.listProviders()
    return Array.isArray(list) ? list.map((p) => ({
      id: str(p?.id ?? p?.provider ?? p),
      name: str(p?.name ?? p?.id ?? p),
    })).filter((p) => p.id !== '') : []
  } catch {
    return []
  }
}

/**
 * 模型目录缓存。
 *
 * 为什么要缓存：面板每次打开「配置」页都会问一次"有哪些模型可选"，而
 * `llm.listModels()` 是**异步的**，第三方适配器完全可以借它去问一次 `/models`
 * 接口。缓存让"打开面板"变成一次本地读取；需要立刻看到新模型时，面板上的
 * 「刷新模型列表」会带 `force: true` 绕过缓存。
 *
 * 缓存键里带上 **llm 对象 + 提供方 id 列表**：宿主换了服务实例、或增删了提供方，
 * 旧缓存自然失效 —— 不会出现"列表里还留着已经删掉的提供方"这种误导。
 */
const MODEL_CATALOG_TTL_MS = 60000
let catalogCache = { llm: null, key: '', at: 0, value: null }

/** 清空模型目录缓存（测试用；面板的刷新按钮走 `force: true`）。 */
export function resetModelCatalogCache() {
  catalogCache = { llm: null, key: '', at: 0, value: null }
}

/**
 * 给一个 Promise 套超时：到点 reject，并在 settle 时清掉定时器。
 *
 * 为什么要超时：`listModels()` 在宿主内置适配器上是本地读取，但这是**契约的
 * 下限而不是上限** —— 一个会去问远端的适配器会让"打开配置页"卡住。宁可
 * 明确报"这个提供方的模型列表没取到，点刷新再试"，也不要让面板转圈转到用户放弃。
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    /**
     * ⚠️ 这个定时器**不能 unref**：它是这次等待唯一能结出结果的东西，
     * unref 掉之后"事件循环空了"会让 Node 直接判定 unsettled top-level await
     * 并退出（实测：冒烟测试挂死在超时用例上，而不是失败）。
     * 它一定会在 settle 时被 clearTimeout，所以不会拖住进程。
     */
    const timer = setTimeout(() => reject(new Error(`列出模型超时（${ms}ms）`)), ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * 把"宿主里到底有哪些模型可选"摊平成面板能直接渲染的形状。
 *
 * 为什么需要它：复盘要指定模型时，用户面对的是一个空输入框 —— **不知道该填什么**，
 * 填错还会得到 `NO_ADAPTER`（这个错误对用户毫无帮助）。所以把
 * `listProviders()` × `listModels()` 摆出来，让他**选**而不是**猜**。
 *
 * 三个刻意的选择：
 *   1. **单个提供方失败不影响其他提供方**：一个适配器的模型列表取不到，不该让
 *      整页变成空的（那看起来像"一个模型都没有"）。
 *   2. **不抛**：模型目录是展示能力，任何宿主版本差异都只该降级成"列表为空 +
 *      一句为什么"，绝不把面板打崩。
 *   3. **`models` 是建议性的**：宿主文档明说适配器可以接受未列出的模型 id，
 *      所以这份目录不能当成白名单用 —— 面板只让用户从目录里选，但配置里已有的、
 *      不在目录中的旧值必须原样显示并保留（不能"看起来没配"或静默改掉）。
 *
 * @param llm - 宿主 llm 服务（拿不到就返回空目录）。
 * @param options.timeoutMs - 单个提供方列模型的超时（默认 4s）。
 * @param options.ttlMs - 缓存有效期（默认 60s；0 = 不缓存）。
 * @param options.force - 忽略缓存重新拉取（面板的刷新按钮）。
 * @returns {Promise<{providers: Array<{id,name,models:Array<{id,name,description}>,error:string}>, failed: Array<{id,error}>, fetchedAt: number, cached: boolean}>}
 */
export async function listModelCatalog(llm, options = {}) {
  const ttlMs = Math.max(0, Number(options?.ttlMs ?? MODEL_CATALOG_TTL_MS) || 0)
  const timeoutMs = Math.max(200, Number(options?.timeoutMs ?? 4000) || 4000)
  const providers = listProviders(llm)
  const key = providers.map((p) => p.id).join('\u0000')

  if (options?.force !== true && catalogCache.value !== null && catalogCache.llm === llm
    && catalogCache.key === key && Date.now() - catalogCache.at < ttlMs) {
    return { ...catalogCache.value, cached: true }
  }

  const failed = []
  const rows = await Promise.all(providers.map(async (p) => {
    if (llm === null || llm === undefined || typeof llm.listModels !== 'function') {
      return { id: p.id, name: p.name, models: [], error: '' }
    }
    try {
      const list = await withTimeout(llm.listModels(p.id), timeoutMs)
      const seen = new Set()
      const models = []
      for (const raw of (Array.isArray(list) ? list : [])) {
        const id = str(raw?.id ?? raw)
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        models.push({ id, name: str(raw?.name ?? raw?.id ?? raw) || id, description: str(raw?.description) })
      }
      return { id: p.id, name: p.name, models, error: '' }
    } catch (error) {
      const message = error?.message ?? String(error)
      failed.push({ id: p.id, error: message })
      return { id: p.id, name: p.name, models: [], error: message }
    }
  }))

  const value = { providers: rows, failed, fetchedAt: Date.now() }
  catalogCache = { llm, key, at: Date.now(), value }
  return { ...value, cached: false }
}

/**
 * 解析这次复盘用哪个 provider/model。
 *
 * **只认配置里的 `review.provider` / `review.model`，没有兜底。**
 *
 * 为什么删掉了"跟随当前会话"（曾经的第 2 步：会话请求头 / 会话日志 / 账本）：
 *
 *   1. **花钱必须显式**。会话模型常常是用户正在用的、最贵的那一个。让一个后台
 *      功能悄悄顺着它跑，用户是在为一个自己没同意的模型付费——这不是"聪明"，
 *      是账单不可预期。用户的要求也很直接：配置了用哪个，没配置就不用。
 *   2. **会话模型是漂的**。它随用户在 DSH 里随手切换而变，于是"复盘花多少钱"
 *      变成一个用户既看不见也控制不了的量；同一份账本今天按 A 报价、明天按 B 收费。
 *   3. **它是隐式的**。面板上写着"本次会用：xxx（跟随当前会话）"，而这条信息
 *      在用户没打开面板时随时可能变——事后没人能复现"当时为什么花了这个钱"。
 *
 * 所以语义变成只有两态：**配了就用配的，没配就不复盘**（由 reviewGate 拦住，
 * 调用方不需要自己判断）。`source` 也随之只剩 `config` / `none`。
 *
 * @param config - 插件配置。
 * @returns {{ provider: string, model: string, partial: boolean, source: 'config'|'none' }}
 *   `source` 是**可用性**判定：只有 provider 与 model 都填了才算 `config`；
 *   只填一半叫 `partial`，同样返回 `none` —— 宁可不复盘，也不拿半截配置去猜模型名。
 */
export function resolveModel(config) {
  const provider = str(config?.review?.provider)
  const model = str(config?.review?.model)
  const partial = (provider === '') !== (model === '')
  return { provider, model, partial, source: provider !== '' && model !== '' ? 'config' : 'none' }
}

/**
 * 收集一次流式调用。
 *
 * @param options.llm - 宿主 llm 服务（必需，拿不到直接返回 noService）。
 * @param options.provider / options.model - 路由。
 * @param options.prompt - user 消息正文。
 * @param options.system - 可选 system 提示词。
 * @param options.temperature / options.maxTokens - 采样。
 * @param options.timeoutMs - 超时（默认 120s）。到点 abort，并把错误码标成 TIMEOUT。
 * @param options.signal - 外部取消信号（面板"停止"按钮）。
 * @param options.onDelta - (text) => void，可选的增量回调（面板上做"正在写…"）。
 * @returns { ok, text, usage, ms, failure, aborted, timedOut, model, provider }
 */
export async function collectStream(options) {
  const started = Date.now()
  const llm = options?.llm
  const provider = str(options?.provider)
  const model = str(options?.model)

  const base = {
    ok: false,
    text: '',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
    ms: 0,
    failure: undefined,
    aborted: false,
    timedOut: false,
    provider,
    model,
    chunks: 0,
    /** 从流里读到的分片类型统计 —— 面板诊断用（"模型只回了 reasoning"这类问题要能看见）。 */
    chunkTypes: {},
  }

  if (llm === undefined || llm === null) {
    return { ...base, failure: { code: LLM_FAILURE_CODES.noService, message: '宿主未提供 ctx.llm，无法调用模型' }, ms: Date.now() - started }
  }
  if (provider === '' || model === '') {
    return {
      ...base,
      failure: {
        code: LLM_FAILURE_CODES.noProvider,
        message: '没有配置复盘用模型：请在「配置 → 自动复盘 → 复盘用哪个模型」里选一个。'
          + '插件不会替你猜模型，也不会默认用你当前会话的那个。',
      },
      ms: Date.now() - started,
    }
  }

  const controller = new AbortController()
  let timedOut = false
  const timeoutMs = Math.max(1000, Number(options?.timeoutMs ?? 120000))
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer?.unref?.()

  // 外部取消要能传到宿主的 fetch 上
  const external = options?.signal
  const onExternalAbort = () => controller.abort()
  if (external !== undefined && typeof external.addEventListener === 'function') {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }

  let text = ''
  let reasoningChars = 0
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
  const chunkTypes = {}
  let finishReason
  let thrown

  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [buildUserMessage(options?.prompt ?? '')],
      ...(str(options?.system) === '' ? {} : { system: str(options.system) }),
      ...(options?.temperature === undefined ? {} : { temperature: Number(options.temperature) }),
      ...(options?.maxTokens === undefined ? {} : { maxTokens: Number(options.maxTokens) }),
      signal: controller.signal,
      purpose: undefined,
    })

    for await (const chunk of stream) {
      const type = str(chunk?.type)
      chunkTypes[type] = (chunkTypes[type] ?? 0) + 1
      if (type === 'text-delta') {
        const delta = typeof chunk.text === 'string' ? chunk.text : ''
        text += delta
        if (typeof options?.onDelta === 'function' && delta !== '') {
          try { options.onDelta(delta) } catch { /* 回调是尽力而为的展示，出错不影响收集 */ }
        }
      } else if (type === 'reasoning-delta') {
        // 思考过程**不入库、不进 prompt**（DESIGN：不记模型思考过程），
        // 但计数字符数，好在诊断里说清"模型只输出了思考没有输出答案"
        reasoningChars += typeof chunk.text === 'string' ? chunk.text.length : 0
      } else if (type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
        const u = chunk.usage
        usage.inputTokens = num(u.inputTokens)
        usage.outputTokens = num(u.outputTokens)
        usage.cacheReadTokens = num(u.cacheReadTokens)
        usage.totalTokens = num(u.totalTokens) || (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens)
      } else if (type === 'finish') {
        finishReason = chunk.reason
      }
    }
  } catch (error) {
    thrown = error
  } finally {
    clearTimeout(timer)
    if (external !== undefined && typeof external.removeEventListener === 'function') {
      external.removeEventListener('abort', onExternalAbort)
    }
  }

  const ms = Date.now() - started

  if (thrown !== undefined) {
    return {
      ...base,
      ms,
      text,
      usage,
      chunks: chunkTypes,
      chunkTypes,
      aborted: controller.signal.aborted,
      timedOut,
      failure: classifyThrown(thrown, { timedOut, aborted: controller.signal.aborted }),
    }
  }

  const kind = str(finishReason?.kind)
  if (kind === 'error' || kind === 'aborted') {
    const failure = finishReason?.failure ?? {}
    return {
      ...base,
      ms,
      text,
      usage,
      reasoningChars,
      chunkTypes,
      aborted: kind === 'aborted',
      timedOut,
      failure: {
        code: timedOut ? LLM_FAILURE_CODES.timeout : (str(failure.code) || (kind === 'aborted' ? LLM_FAILURE_CODES.aborted : LLM_FAILURE_CODES.unknown)),
        message: str(failure.message) || (timedOut ? `调用超时（${timeoutMs}ms）` : '模型调用失败'),
        ...(failure.status === undefined ? {} : { status: failure.status }),
      },
    }
  }

  return {
    ...base,
    ok: true,
    text,
    usage,
    ms,
    reasoningChars,
    chunkTypes,
    chunks: Object.values(chunkTypes).reduce((n, v) => n + v, 0),
    finishKind: kind || 'stop',
  }
}

function num(v) {
  const n = Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/**
 * 把抛出来的异常分类成稳定错误码。
 * 宿主正常路径不会抛（失败走 finish 分片），但版本差异/中间件可能抛。
 */
function classifyThrown(error, flags) {
  if (flags?.timedOut === true) {
    return { code: LLM_FAILURE_CODES.timeout, message: `调用超时：${error?.message ?? String(error)}` }
  }
  if (flags?.aborted === true) {
    return { code: LLM_FAILURE_CODES.aborted, message: `调用已取消：${error?.message ?? String(error)}` }
  }
  const code = str(error?.code)
  if (code !== '' && Object.values(LLM_FAILURE_CODES).includes(code)) {
    return { code, message: str(error?.message) || code }
  }
  return { code: LLM_FAILURE_CODES.unknown, message: str(error?.message) || String(error) }
}

/**
 * 从模型输出里抽出 JSON。
 *
 * 为什么不用 `JSON.parse` 直接上：模型被要求输出 JSON 时，几乎总会
 * 包一层 ```json 围栏，或者在前面加一句"好的，这是结果："。直接 parse
 * 会失败，然后用户看到"解析失败"却不知道模型其实答对了。
 *
 * 所以这里做**三层降级**，每层都记下来（面板要能看出"它是怎么被解析出来的"，
 * 因为这直接关系到可信度）：
 *   1. 直接 parse
 *   2. 剥掉 markdown 围栏后 parse
 *   3. 取第一个 `{` 到最后一个 `}` 之间的子串 parse
 *
 * @returns { ok, value, strategy, error }
 */
export function extractJson(raw) {
  const text = str(raw)
  if (text === '') return { ok: false, strategy: 'empty', error: '模型没有输出任何内容' }

  const attempts = []
  attempts.push({ strategy: 'direct', text })

  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fenced !== null && str(fenced[1]) !== '') {
    attempts.push({ strategy: 'fenced', text: str(fenced[1]) })
  }

  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    attempts.push({ strategy: 'braces', text: text.slice(first, last + 1) })
  }
  // 数组形态的顶层输出也要能接住
  const fa = text.indexOf('[')
  const la = text.lastIndexOf(']')
  if (fa >= 0 && la > fa) {
    attempts.push({ strategy: 'brackets', text: text.slice(fa, la + 1) })
  }

  let lastError = ''
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt.text)
      return { ok: true, value, strategy: attempt.strategy }
    } catch (error) {
      lastError = error?.message ?? String(error)
    }
  }
  return {
    ok: false,
    strategy: 'failed',
    error: `无法从模型输出里解析出 JSON（${lastError}）`,
    /** 保留前 400 字原文，面板上能看出"模型到底回了什么"。 */
    preview: text.slice(0, 400),
  }
}

/** 一次性调用 + 解析 JSON 的组合（复盘链路就只调这一个函数）。 */
export async function callForJson(options) {
  const result = await collectStream(options)
  if (!result.ok) return { ...result, json: undefined }
  const parsed = extractJson(result.text)
  if (!parsed.ok) {
    return {
      ...result,
      ok: false,
      json: undefined,
      failure: { code: LLM_FAILURE_CODES.badJson, message: parsed.error, preview: parsed.preview },
    }
  }
  return { ...result, json: parsed.value, parseStrategy: parsed.strategy }
}

/** 粗略估算这次调用会花多少输入 token（面板的"跑之前先看成本"用它）。 */
export function estimatePromptTokens(prompt, system = '') {
  return estimateTokens(prompt) + estimateTokens(system)
}
