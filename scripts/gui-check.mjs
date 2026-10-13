/**
 * 面板 DOM 级自检（`scripts/gui-check.mjs`）
 *
 * 这个脚本回答一个前面所有测试都答不了的问题：**面板在真实 DOM 里渲染会不会炸。**
 *
 * 为什么需要它：冒烟测试只能做静态检查（组件定义了没、页签有渲染分支没），
 * 而"点了某一页之后崩掉"只会在真正渲染时出现 —— 例如
 * `Cannot read properties of undefined (reading 'length')`，在源码里完全看不出来。
 *
 * 做法：用 jsdom 模拟宿主页面，按 DSH 的模块契约（`window.__ModuleLoader__.load`）
 * 真实执行构建产物，再用 React 把九个页签逐一点开渲染，断言：
 *   1. 产物能加载、能导出 apply / inject
 *   2. apply() 注册了侧边栏入口与浮层（slot 名对得上）
 *   3. 面板能挂进 DOM，九个页签**逐个渲染不抛**
 *   4. 每页渲染时确实发了对应的 RPC（面板与 host 的契约在真实调用路径上成立）
 *
 * ⚠️ 依赖 jsdom / react / react-dom，**不是本包的依赖**，所以它不随 npm 包发布
 * （`package.json` 的 `files` 里没有 scripts/），也不在 `npm test` 里跑。
 * 需要时先装：
 *
 *   mkdir -p /tmp/dsh-gui-check && cd /tmp/dsh-gui-check
 *   npm init -y && npm install jsdom react react-dom
 *   node --input-type=module -e "…"      # 或把本文件复制过去跑
 *
 * 找不到依赖时会**明确报错并给出安装命令**，而不是静默跳过 —— 一个"看起来跑了
 * 其实什么都没验"的检查比没有检查更糟（这个仓库为这类问题专门写过测试）。
 *
 * 运行：`node scripts/gui-check.mjs`
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

/**
 * 找到 jsdom / react / react-dom。优先就近（/tmp/dsh-gui-check），
 * 其次环境变量 DSH_GUI_CHECK_DIR。
 */
const candidates = [
  process.env.DSH_GUI_CHECK_DIR,
  '/tmp/dsh-gui-check',
  join(repoRoot, 'node_modules'),
].filter(Boolean)

function loadDep(name) {
  for (const dir of candidates) {
    try {
      const req = createRequire(join(dir, 'noop.js'))
      return req(name)
    } catch { /* 换下一个候选目录 */ }
  }
  console.error(`[gui-check] 找不到依赖 ${name}。请先安装（不装进本仓库）：`)
  console.error('  mkdir -p /tmp/dsh-gui-check && cd /tmp/dsh-gui-check && npm init -y')
  console.error('  npm install jsdom react react-dom')
  process.exit(2)
}

const { JSDOM } = loadDep('jsdom')
const React = loadDep('react')
const ReactDOMClient = loadDep('react-dom/client')
const jsxRuntime = loadDep('react/jsx-runtime')

let failures = 0
const results = []
function check(name, fn) {
  try {
    const out = fn()
    results.push(`  ok   ${name}`)
    return out
  } catch (error) {
    failures += 1
    results.push(`  FAIL ${name}\n       ${error?.message ?? error}`)
    return undefined
  }
}

// ---------------------------------------------------------------- 模拟宿主页面
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:12680/',
  pretendToBeVisual: true,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
// `navigator` 在 Node 里是只读 getter，得用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Node = window.Node
globalThis.Event = window.Event
globalThis.MouseEvent = window.MouseEvent
globalThis.localStorage = window.localStorage
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) ?? ((cb) => setTimeout(cb, 0))
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) ?? clearTimeout
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.IS_REACT_ACT_ENVIRONMENT = true

/** 记录面板发出的每个 RPC，供"契约在真实调用路径上成立"这一项断言。 */
const rpcCalls = []
/** 记录原始 fetch URL，供"必须用前缀相对路径"这一项断言（见下方该检查）。 */
const fetchedUrls = []

/**
 * 假 host：按方法名返回**形状正确**的响应。
 * 形状必须贴近真实（比如 insights 要带 page/stats/buckets），否则测不出
 * "面板读了一个后端根本没给的字段"这类问题。
 */
function fakeResponse(method) {
  const day = new Date().toISOString().slice(0, 10)
  const base = {
    hello: {
      version: '0.2.2',
      schema: {
        fields: [
          { path: 'enabled', kind: 'boolean', group: 'basic', label: '启用插件', hint: 'x' },
          { path: 'review.enabled', kind: 'boolean', group: 'review', label: '自动复盘', hint: 'y' },
          // 与真实 schema 一致：这两项 hidden，控件是模型选择器（面板不做手填）
          { path: 'review.provider', kind: 'text', group: 'review', label: '提供方', hidden: true },
          { path: 'review.model', kind: 'text', group: 'review', label: '模型', hidden: true },
          { path: 'skills.target', kind: 'select', group: 'skills', label: '落点', options: [{ value: 'plugin-local', label: '本地' }] },
          { path: 'privacy.customWords', kind: 'stringList', group: 'privacy', label: '敏感词' },
        ],
        groups: [{ id: 'basic', label: '总开关' }, { id: 'review', label: '自动复盘' }, { id: 'skills', label: '落点' }, { id: 'privacy', label: '隐私' }],
      },
      meta: { defaultDirName: '.dsh-evolution', envHome: 'DSH_EVOLUTION_HOME' },
      paths: { root: '/home/u/.dsh-evolution', configFile: '/home/u/.dsh-evolution/config.json', dirs: ['/home/u/.dsh-evolution'] },
      configured: true,
      configError: '',
      redactRules: ['sk- 前缀的 API key', 'Authorization 头凭证'],
    },
    config: {
      config: {
        enabled: true,
        review: { enabled: false, model: 'deepseek-flash', provider: 'deepseek-official', dailyTokenBudget: 200000, extractAfterTurns: 10 },
        privacy: { redact: true, stripAbsolutePaths: true, stripSecrets: true, customWords: [] },
        skills: { target: 'plugin-local', customPath: '', confirmBeforeRepoWrite: true },
        promotion: { personMinRecurrence: 2, pinOnPromote: false },
        api: { enabled: false, uploadMode: 'off', baseUrl: '' },
        database: { enabled: false, driver: 'sqlite' },
        retrieval: { hotEntries: true, fullText: true },
        inject: { enabled: true },
        ledger: { enabled: true, historyDays: 30 },
        panel: { width: 1100, height: 760 },
        export: { includeEvidence: true, maxEntries: 500 },
      },
      configError: '',
      root: '/home/u/.dsh-evolution',
    },
    runtime: {
      runtime: {
        startedAt: Date.now() - 60000,
        eventsSeen: 100, eventsRecorded: 90, eventsSkipped: 10, repoResolveFailures: 0,
        historyScan: { ran: true, running: false, sessions: 3, records: 90, skipped: 0, error: '' },
        lastError: '',
        review: { running: false, lastStatus: 'ok', lastModel: 'deepseek-flash', lastAccepted: 1, lastRejected: 1, lastMs: 9000, lastInputTokens: 2400, lastOutputTokens: 2100, autoTriggers: 0, autoSkips: 0 },
        reviewRuns: 1,
        inject: { enabled: true, lastChars: 125, lastRepo: 'demo', refreshedAt: Date.now(), error: '' },
        uptimeMs: 60000, sessionsTracked: 2, pluginVersion: '0.2.2',
        dataRoot: '/home/u/.dsh-evolution', configFile: '/home/u/.dsh-evolution/config.json', configError: '',
        pluginEnabled: true, ledgerEnabled: true, reviewEnabled: false,
        apiUploadMode: 'off', apiEnabled: false, databaseEnabled: false, embeddingsEnabled: false,
        insights: { total: 3, active: 3, archived: 0, pinned: 1, accepted: 1, withEvidence: 3, recurred: 1, byScope: { repo: 3 }, byType: { fact: 3 }, badLines: 0, lastError: '', logFile: '/x/insights.ndjson', appended: 3 },
        injectCache: { roots: 1, knownRoots: 1, dirs: 1, lastRefreshAt: Date.now(), refreshCount: 1, activeRoot: '/w/demo', activeRepo: 'demo', lastError: '' },
        llmAvailable: true, llmProviders: ['deepseek-official'],
      },
      ledger: { days: 1, firstDay: day, lastDay: day, records: 90, sessions: 3, badLines: 0, pendingBuffered: 0, written: 90, lastError: '' },
    },
    usage: {
      days: 30, runs: 1, inputTokens: 2400, outputTokens: 2100, totalTokens: 4500, avgMs: 9000,
      accepted: 1, merged: 0, rejected: 1, byModel: { 'deepseek-flash': 4500 }, byStatus: { ok: 1 },
      today: { day, calls: 1, inputTokens: 2400, outputTokens: 2100 }, budget: 200000,
      note: '这里统计的是复盘调用。费用请以你模型提供方的账单为准。',
      recent: [{ at: Date.now(), sessionId: 's-1', status: 'ok', inputTokens: 2400, outputTokens: 2100, ms: 9000, model: 'deepseek-flash' }],
    },
    insights: {
      insights: [
        { id: 'i1', type: 'constraint', scope: 'repo', repo: 'demo', title: '幂等判断要放在守卫之后', detail: '原因', recurrence: 3, confidence: 0.9, pinned: true, accepted: true, flags: [], evidence: [{ sessionId: 's-1', turn: 3, quote: '原文' }], injectedCount: 2, firstSeenAt: Date.now(), lastSeenAt: Date.now(), priority: 0, _score: 12.5, promotedFrom: { at: Date.now(), from: { scope: 'repo', repo: 'demo' } } },
        { id: 'i2', type: 'pitfall', scope: 'person', repo: '', title: '跨仓库的个人习惯', detail: '', recurrence: 2, confidence: 0.7, pinned: false, accepted: false, flags: ['possible-secret'], evidence: [], injectedCount: 0, firstSeenAt: Date.now(), lastSeenAt: Date.now(), priority: 0 },
      ],
      page: { offset: 0, limit: 200, total: 2, hasMore: false },
      stats: { total: 2, active: 2, archived: 0, pinned: 1, accepted: 1, withEvidence: 1, recurred: 1, byScope: { repo: 1, person: 1 }, byType: { constraint: 1, pitfall: 1 }, badLines: 0, lastError: '', logFile: '/x/insights.ndjson', appended: 2 },
      ruleDescriptions: [
        { id: 'negative-tool-assertion', kind: 'reject', why: '负面断言会硬化成拒绝借口', count: 5 },
        { id: 'environment-failure', kind: 'downgrade', why: '环境问题换台机器就不成立', count: 12 },
        { id: 'possible-secret', kind: 'flag', why: '疑似密钥，已二次脱敏', count: 6 },
      ],
      promotion: { minRecurrence: 3 },
      buckets: { constraintsCount: 1, repoCount: 0, teamCount: 0, personalCount: 1, droppedCount: 0, constraints: [], repo: [], team: [], personal: [], dropped: [] },
      searchDisabled: '',
      root: '/home/u/.dsh-evolution',
    },
    'insights/promotions': {
      eligible: [{ id: 'i1', title: '幂等判断要放在守卫之后', recurrence: 3, repo: 'demo' }],
      skipped: [{ id: 'i3', title: '只见过一次的小事', reason: '只在 1 次会话里出现过（门槛 2 次）' }],
      minRecurrence: 2,
      current: [{ id: 'i2', title: '跨仓库的个人习惯', scope: 'person', promotedFrom: { from: { scope: 'repo', repo: 'demo' } } }],
      note: '跨仓库的个人提醒只能由你手动晋升',
      pinOnPromote: false,
    },
    'review/preview': {
      ok: true, sessionId: 's-1', repo: 'demo', turns: 12, gate: { manualAllowed: true, autoEligible: false, turns: 12, newRecords: 40, manualBlockers: [], reason: '条件都满足' },
      model: { provider: 'deepseek-official', model: 'deepseek-flash', source: 'config' },
      llmAvailable: true, usage: { day, inputTokens: 2400, outputTokens: 2100, calls: 1 }, budget: 200000,
    },
    models: {
      providers: [
        { id: 'deepseek-official', name: 'DeepSeek 官方', models: [{ id: 'deepseek-flash', name: 'deepseek-flash', description: '快' }, { id: 'deepseek-pro', name: 'deepseek-pro', description: '' }], error: '' },
        { id: 'gateway', name: '中转网关', models: [{ id: 'gw-model', name: '网关模型', description: '' }], error: '' },
        { id: 'broker', name: '另一个提供方', models: [], error: '401 unauthorized' },
      ],
      failed: [{ id: 'broker', error: '401 unauthorized' }],
      fetchedAt: Date.now(),
      cached: false,
      resolved: { provider: 'deepseek-official', model: 'deepseek-flash', source: 'config', partial: false },
      llmAvailable: true,
      note: '列表来自宿主已注册的提供方。',
    },
    'dry-run': {
      ok: true, dryRun: true, wroteNothing: true, autoPicked: true,
      sessionList: [{ sessionId: 's-1', repo: 'demo', records: 90, lastTs: Date.now(), day }],
      session: { sessionId: 's-1', repo: 'demo', repoRoot: '/w/demo', turns: 12, toolCalls: 30, toolFailures: 2, tokensIn: 1000, tokensOut: 500, endStatus: 'completed', today: day },
      summaryText: '用户: 改一下回调\n助手: 好的', summaryTruncated: false,
      observations: [],
      insights: { total: 2, used: 1, live: true, error: '', dropped: [{ title: '被挡的条目', type: 'fact', scope: 'repo' }] },
      injection: {
        sections: [
          { id: 'constraints', title: '强制约束', layer: 'stable', text: '## 必须遵守的约束\n- [constraint] x', included: [{ id: 'i1', title: 'x', type: 'constraint', recurrence: 3 }], skipped: 0, chars: 40, budget: { maxCount: 3, maxChars: 300 } },
          { id: 'repo', title: '项目洞察与避坑', layer: 'stable', text: '', included: [], skipped: 0, chars: 0, budget: { maxCount: 3, maxChars: 400 } },
          { id: 'team', title: '团队规范', layer: 'stable', text: '', included: [], skipped: 0, chars: 0, budget: { maxCount: 2, maxChars: 250 } },
          { id: 'personal', title: '个人提醒', layer: 'volatile', text: '', included: [], skipped: 0, chars: 0, budget: { maxCount: 1, maxChars: 200 } },
        ],
        totalChars: 40, totalTokens: 18, stableChars: 40, volatileChars: 0, budgetChars: 1150, emptySections: 3,
      },
      cached: { totalChars: 40, totalTokens: 18, sections: [], at: Date.now() },
      budget: { injectionChars: 40, injectionBudgetChars: 1150, injectionPercent: 3, stableChars: 40, volatileChars: 0, summaryChars: 20, summaryTokens: 10, reviewInputTokens: 2000, reviewOutputTokens: 300 },
      cost: { model: 'deepseek-flash', priceMatched: true, inputTokens: 2000, outputTokens: 300, usd: 0.0031, usdText: '$0.0031', note: '估算值' },
      gate: { wouldRun: false, reason: '开关是关的', pluginEnabled: true, ledgerEnabled: true, reviewEnabled: false, paused: '', turnsNow: 12, turnsRequired: 10, turnsSatisfied: true, newRecords: 40, minNewRecords: 20 },
      disclaimer: '本页不调用任何模型',
    },
    // ⚠️ key 必须带斜杠：面板调的是 `inject/preview`，`base[method]` 按完整方法名查，
    //    写成 `inject` 会静默返回 {}（repos 空）—— 这个错误曾长期存在，
    //    注入预览页其实一直渲染的是空数据，只是没有断言发现它。
    'inject/preview': {
      repos: [{ repoRoot: '/w/demo', repo: 'demo', totalChars: 125, totalTokens: 57, text: '## 来自本机历史会话的经验\n- [constraint] x', includedIds: ['i1'], sections: [{ id: 'constraints', title: '强制约束', layer: 'stable', chars: 40, count: 1, skipped: 0, items: [{ title: 'x', type: 'constraint', recurrence: 3 }] }], dropped: [], at: Date.now() }],
      stats: { roots: 1, knownRoots: 1, dirs: 1, lastRefreshAt: Date.now(), refreshCount: 1, activeRoot: '/w/demo', activeRepo: 'demo', lastError: '' },
      detail: { repo: 'demo', repoRoot: '/w/demo', text: '## 来自本机历史会话的经验\n- [constraint] x', totalChars: 125, totalTokens: 57, includedIds: ['i1'], sections: [], at: Date.now() },
      budgetChars: 1150, root: '/home/u/.dsh-evolution',
    },
    ledger: {
      records: [{ sid: 's-1', seq: 1, ts: Date.now(), day, kind: 'user_message', turn: 1, repo: 'demo', repoRoot: '/w/demo', text: '改一下回调' }],
      total: 1, badLines: 0, days: [day], truncated: false, root: '/home/u/.dsh-evolution', pendingBuffered: 0,
    },
    'ledger/flush': { records: 1, sessions: 1, days: 1, badLines: 0, pendingBuffered: 0 },
    diagnose: { root: '/home/u/.dsh-evolution', checks: [{ path: '/home/u/.dsh-evolution', exists: true }], today: day, configFile: { path: '/x/config.json', exists: true }, configError: '', ledger: { records: 1 } },
    'export/markdown': { markdown: '# dsh-evolution 洞察导出\n\n### [constraint] x', count: 1, total: 1, truncated: false, filename: 'insights-x.md', targetDir: '/home/u/.dsh-evolution/exports' },
    'skills/plan': { drafts: [{ key: 'constraints', name: 'demo-constraints', ok: true, errors: [], text: '---\nname: "demo-constraints"\ndescription: "x"\n---\n\n# x', insights: [{ id: 'i1', title: 'x', type: 'constraint', recurrence: 3 }] }], dir: { dir: '/home/u/.dsh-evolution/skills', inRepo: false, reason: '' }, target: 'plugin-local', needsConfirm: false, reason: '' },
    'redact/preview': {
      rows: [{ line: 3, before: 'const token = "sk-demo-1234-abcd-5678-efgh-9012"', after: 'const token = "●●●●●●"', truncated: false }],
      changedLines: 1,
      totalLines: 12,
      output: 'const token = "●●●●●●"',
    },
    'session/summary': { sessionId: 's-1', turns: 12, text: '用户: x', recognized: 10, suspiciousInput: false },
    'insights/rebuild': { stats: { total: 2 } },
    'insights/clear': { removed: 2, archivedTo: '/x/insights.cleared.ndjson', stats: { total: 0 } },
  }
  return base[method] ?? {}
}

window.fetch = async (url, init) => {
  // 面板发的是**前缀相对**路径。宿主可能被部署在子路径下（例如 nginx 挂在
  // /ui/ 并剥前缀转发），此时相对路径才是唯一正确的写法 —— 见 client/index.js
  // 里 ROUTE 的注释。所以这里不能要求 `dsh-evolution` 前面必须有一个 '/'：
  // 非贪婪地剥到第一个 `dsh-evolution/` 为止，相对与绝对两种形态都能正确解析。
  const method = String(url).replace(/^.*?dsh-evolution\//, '')
  fetchedUrls.push(String(url))
  rpcCalls.push({ method, body: init?.body ? JSON.parse(init.body) : {} })
  const data = fakeResponse(method)
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data }),
  }
}
globalThis.fetch = window.fetch

// ---------------------------------------------------------------- 加载构建产物
const loaded = []
window.__ModuleLoader__ = {
  load(def) { loaded.push(def) },
}
const bundlePath = join(repoRoot, 'client', 'dist', 'index.js')
const bundleSrc = readFileSync(bundlePath, 'utf8')

check('构建产物能按宿主的 ModuleLoader 契约被加载', () => {
  // 在 jsdom 的 window 作用域里执行产物（它引用的 window / document 都来自这里）
  const run = new Function('window', 'document', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', bundleSrc)
  run(window, window.document, window.localStorage, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame)
  if (loaded.length !== 1) throw new Error(`应恰好加载 1 个模块，实际 ${loaded.length}`)
  if (loaded[0].id !== 'dsh-evolution') throw new Error(`模块 id 应为 dsh-evolution，实际 ${loaded[0].id}`)
})

const mod = (() => {
  try {
    return loaded[0].factory((name) => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return jsxRuntime
      if (name === 'react/jsx-dev-runtime') return jsxRuntime
      throw new Error(`产物请求了未注入的依赖：${name}`)
    })
  } catch (error) {
    failures += 1
    results.push(`  FAIL 产物 factory 能求值\n       ${error?.message ?? error}`)
    return {}
  }
})()

check('产物导出了 apply 与 inject（宿主按这两个名字调用）', () => {
  if (typeof mod.apply !== 'function') throw new Error('缺少 apply')
  if (!Array.isArray(mod.inject)) throw new Error('缺少 inject 数组')
  if (!mod.inject.includes('slots')) throw new Error(`inject 应包含 slots，实际 ${JSON.stringify(mod.inject)}`)
})

// ---------------------------------------------------------------- 真实渲染
const registrations = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) { return name === 'slots' ? slots : undefined },
  on() { return () => {} },
  effect(fn) { const d = fn(); return d ?? (() => {}) },
  inject(_deps, cb) { cb(this) },
  _registrations: registrations,
}
const slots = {
  register(def, render) {
    registrations.push({ def, render })
    return () => {}
  },
  inject(_name, cb) { return cb() },
}

check('apply(ctx) 注册了侧边栏入口与浮层（slot 名必须是宿主认的那些）', () => {
  mod.apply(ctx)
  const names = registrations.map((r) => r.def?.name)
  if (!names.includes('sidebar.footer.action')) throw new Error(`未注册侧边栏入口，实际 ${names.join(',')}`)
  if (!names.includes('shell.overlay')) throw new Error(`未注册浮层，实际 ${names.join(',')}`)
  for (const r of registrations) {
    if (typeof r.render !== 'function') throw new Error(`${r.def.name} 的渲染函数不是函数`)
    if (!Number.isFinite(r.def.order)) throw new Error(`${r.def.name} 的 order 必须是有限数`)
  }
})

const container = window.document.getElementById('root')
let root = null

/**
 * 把侧边栏入口与浮层**一起**渲染进同一个容器 —— 真实的宿主壳就是这样：
 * 两个 slot 同时挂在页面上，点侧边栏按钮才让浮层出现。
 * 分开渲染会让后一次 render 把前一次的输出顶掉（React 同一个 root 只渲染一棵树）。
 */
async function renderShell({ wide = true, ctx: shellCtx } = {}) {
  const { act } = React
  await act(async () => {
    if (root === null) root = ReactDOMClient.createRoot(container)
    root.render(React.createElement('div', null,
      React.createElement(sideReg.render, { wide, ctx: shellCtx }),
      React.createElement(overlayReg.render, {}),
    ))
  })
  for (let i = 0; i < 12; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 12)) })
  }
}

/** 点一个按钮并等 rpc 结算。 */
async function click(button) {
  const { act } = React
  await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  for (let i = 0; i < 14; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 12)) })
  }
}

/** 按文字找按钮（找不到就抛，附带当时页面上的按钮清单，便于定位）。 */
function findButton(text) {
  const nodes = [...container.querySelectorAll('button')]
  const hit = nodes.find((b) => (b.textContent ?? '').trim() === text)
  if (hit === undefined) {
    const seen = nodes.map((b) => (b.textContent ?? '').trim()).filter((t) => t !== '').slice(0, 20)
    throw new Error(`找不到文字为「${text}」的按钮；当时的按钮有：${seen.join(' / ')}`)
  }
  return hit
}

const overlayReg = registrations.find((r) => r.def?.name === 'shell.overlay')
const sideReg = registrations.find((r) => r.def?.name === 'sidebar.footer.action')

await renderShell({ wide: true, ctx })

try {
  const btn = container.querySelector('.dvev-sidebtn')
  if (btn === null) throw new Error('侧边栏按钮没有渲染出 .dvev-sidebtn')
  if (!btn.textContent.includes('自动进化')) throw new Error(`按钮文字不对：${btn.textContent}`)
  results.push('  ok   侧边栏入口渲染正常（宽栏显示文字）')
} catch (error) {
  failures += 1
  results.push(`  FAIL 侧边栏入口渲染正常（宽栏显示文字）\n       ${error?.message ?? error}`)
}

// 面板初始是关的（浮层返回 null）
try {
  if (container.querySelector('.dvev-panel') !== null) throw new Error('面板初始状态不该是打开的')
  results.push('  ok   面板初始关闭（不占位、不抢焦点）')
} catch (error) {
  failures += 1
  results.push(`  FAIL 面板初始关闭（不占位、不抢焦点）\n       ${error?.message ?? error}`)
}

try {
  await click(container.querySelector('.dvev-sidebtn'))
  const panel = container.querySelector('.dvev-panel')
  if (panel === null) throw new Error('点击后没有出现 .dvev-panel（浮层没打开）')
  const nav = [...container.querySelectorAll('.dvev-navitem')]
  if (nav.length !== 9) throw new Error(`应有 9 个页签按钮，实际 ${nav.length}`)
  results.push('  ok   点侧边栏按钮能打开面板，9 个页签都渲染出来了')
} catch (error) {
  failures += 1
  results.push(`  FAIL 点侧边栏按钮能打开面板\n       ${error?.message ?? error}`)
}

// 窄栏（底栏收窄）时按钮应降级为圆形图标
try {
  await renderShell({ wide: false, ctx })
  if (container.querySelector('.dvev-sidenarrow') === null) throw new Error('窄栏应加上 .dvev-sidenarrow')
  results.push('  ok   侧边栏入口窄栏降级为圆按钮')
} catch (error) {
  failures += 1
  results.push(`  FAIL 侧边栏入口窄栏降级为圆按钮\n       ${error?.message ?? error}`)
}

/**
 * 重新挂一遍宿主壳并确保面板是打开的。
 *
 * 每次 renderShell 都是重新挂载，面板的"打开"状态是模块级的（真实宿主里
 * 按钮与浮层是同一模块的两个 slot，共享这个状态），所以重新挂载后要再点一次。
 * 这里显式确认打开成功，失败时给出清晰信息 —— 否则后面每条页签检查都会
 * 以"找不到按钮"的形式失败，噪音掩盖真因。
 */
async function ensurePanelOpen() {
  if (container.querySelector('.dvev-panel') !== null) return
  await click(container.querySelector('.dvev-sidebtn'))
  if (container.querySelector('.dvev-panel') === null) throw new Error('点了侧边栏按钮但面板没有打开')
}
await renderShell({ wide: true, ctx })
try {
  await ensurePanelOpen()
} catch (error) {
  failures += 1
  results.push(`  FAIL 重新挂载后能再次打开面板\n       ${error?.message ?? error}`)
}

// 逐个页签点开
const TAB_LABELS = ['全局总览', '洞察分析', '沙盒试跑', '数据预览', '注入预览', '脱敏预览', '导出草稿', '配置管理', '数据隐私']
const EXPECTED_RPC = {
  全局总览: ['hello', 'config', 'runtime', 'usage'],
  洞察分析: ['insights', 'insights/promotions', 'review/preview'],
  沙盒试跑: ['dry-run'],
  数据预览: ['ledger/flush', 'ledger'],
  注入预览: ['inject/preview'],
  // 导出页挂载时拉 inject/preview（拿"见过哪些仓库"填 skill 草稿的目标仓库选择器）
  导出草稿: ['inject/preview'],
  配置管理: ['models'],
  数据隐私: ['diagnose'],
}

if (process.env.GUI_DEBUG === '1') {
  console.log('[debug] 窄栏检查后面板存在？', container.querySelector('.dvev-panel') !== null)
  const dbgBtn = container.querySelector('.dvev-sidebtn')
  console.log('[debug] 按钮 class：', dbgBtn?.className)
  await click(dbgBtn)
  console.log('[debug] 再点一次后面板存在？', container.querySelector('.dvev-panel') !== null)
}
for (const label of TAB_LABELS) {
  const before = rpcCalls.length
  try {
    await click(findButton(label))
    // 页面里至少要有点内容（不是被 React 静默渲染成 null）
    const main = container.querySelector('.dvev-main')
    if (main === null) throw new Error('找不到 .dvev-main')
    if ((main.textContent ?? '').trim().length < 10) throw new Error('页面几乎没渲染出内容')
    results.push(`  ok   页签「${label}」渲染正常（${(main.textContent ?? '').trim().length} 字）`)

    const want = EXPECTED_RPC[label] ?? []
    // 有些页签的数据在**首次挂载**时就拉了（面板一打开就 fetch 首屏），
    // 切到该页签时不会重发。所以断言的是"截至此刻发过"，而不是"刚刚发了"。
    const allMethods = rpcCalls.map((c) => c.method)
    const missing = want.filter((m) => !allMethods.includes(m))
    if (missing.length > 0) {
      throw new Error(`这一页应当调用 ${missing.join(',')}（整个会话里都没出现过），实际调用过：${[...new Set(allMethods)].join(',') || '(无)'}`)
    }
    const fresh = rpcCalls.slice(before).map((c) => c.method)
    if (want.length > 0) {
      results.push(`  ok   页签「${label}」所需 RPC 都发过：${want.join(', ')}${fresh.length > 0 ? `（本次切换新发 ${[...new Set(fresh)].join(',')}）` : '（首屏已拉取）'}`)
    }
  } catch (error) {
    failures += 1
    results.push(`  FAIL 页签「${label}」渲染正常\n       ${error?.message ?? error}`)
  }
}

// 交互：导出页要有导入入口（file input），这是"导出/导入闭环"的 DOM 级锁定
try {
  await click(findButton('导出草稿'))
  const fileInputs = [...container.querySelectorAll('input[type="file"]')]
    .filter((i) => (i.getAttribute('accept') ?? '').includes('.json'))
  if (fileInputs.length === 0) throw new Error('导出页没有 JSON 导入的 file input（accept=.json）')
  const importCopy = (container.textContent ?? '').includes('重复导入')
  if (!importCopy) throw new Error('导入区应说明"重复导入零副作用"的语义')
  results.push('  ok   导出页有导入入口（file input）且写明了"重复导入零副作用"')
} catch (error) {
  failures += 1
  results.push(`  FAIL 导出页导入入口\n       ${error?.message ?? error}`)
}

// 交互：skill 草稿的目标仓库选择器 —— 这是团队共享闭环的 DOM 级锁定。
// 落点选「仓库内」时必须知道写进哪个仓库；以前这里永远拿不到 repoRoot，
// 于是永远回退到插件数据目录、写不进仓库。锁两件事：
//   1) 面板渲染出「目标仓库」选择器，且选项来自 inject/preview 的仓库列表
//   2) 点「生成草稿计划」真的发了带 repo + repoRoot 的 skills/plan
try {
  const { act } = React
  await click(findButton('导出草稿'))
  // 等 ExportTab 的 inject/preview 回来、选择器渲染出来
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 12)) })
  const text = container.textContent ?? ''
  if (!text.includes('目标仓库')) throw new Error('skill 草稿区应有「目标仓库」选择器')
  // ExportTab 的仓库选择器：找出「目标仓库：」那一行里的 select（区别于导出区的 scope 下拉）。
  // 选择器等 inject/preview 回来后才渲染，所以轮询到出现为止（而不是固定等几拍 ——
  // jsdom 的 promise 微任务时序与真实浏览器不同，固定次数在慢环境里会假红）。
  let select
  for (let i = 0; i < 40; i += 1) {
    const row = [...container.querySelectorAll('.dvev-row')].find((r) => (r.textContent ?? '').includes('目标仓库'))
    select = row?.querySelector('select') ?? undefined
    if (select !== undefined) break
    await act(async () => { await new Promise((r) => setTimeout(r, 15)) })
  }
  if (select === undefined || select === null) {
    const rowText = [...container.querySelectorAll('.dvev-row')].find((r) => (r.textContent ?? '').includes('目标仓库'))?.textContent ?? '(无此行)'
    const injectCalls = rpcCalls.filter((c) => c.method === 'inject/preview').length
    const probe = JSON.stringify(window.__dvevExportProbe ?? null)
    // 直接验证 fakeResponse 自己能不能给出 repos —— 排查 mock 还是组件的问题
    let direct = '(未取)'
    try { direct = `repos=${(fakeResponse('inject/preview')?.repos ?? []).length}` } catch (e) { direct = `抛错:${e?.message}` }
    throw new Error(`目标仓库选择器 40 拍内都没渲染出来。inject/preview 被调过 ${injectCalls} 次；probe=${probe}；fakeResponse直查 ${direct}；该行文本：${rowText.trim().slice(0, 80)}`)
  }
  if (![...select.options].some((o) => o.value === '/w/demo')) {
    throw new Error(`目标仓库选择器里没有 /w/demo，实际选项：${[...select.options].map((o) => o.value).join(',')}`)
  }
  const before = rpcCalls.length
  await click(findButton('生成草稿计划'))
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 12)) })
  const planCall = rpcCalls.slice(before).find((c) => c.method === 'skills/plan')
  if (planCall === undefined) throw new Error('点「生成草稿计划」应当调用 skills/plan')
  if (planCall.body?.repoRoot !== '/w/demo' || planCall.body?.repo !== 'demo') {
    throw new Error(`skills/plan 应带 repo=demo 与 repoRoot=/w/demo，实际：${JSON.stringify(planCall.body)}`)
  }
  results.push('  ok   skill 草稿有目标仓库选择器，生成计划时把 repo + repoRoot 一起带给了 skills/plan')
} catch (error) {
  failures += 1
  results.push(`  FAIL skill 草稿目标仓库选择器\n       ${error?.message ?? error}`)
}

// 交互：在洞察页展开一条详情、点一次置顶
try {
  const { act } = React
  await click(findButton('洞察分析'))
  const before = rpcCalls.length
  const detailButtons = [...container.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === '详情')
  if (detailButtons.length === 0) throw new Error('列表里没有「详情」按钮')
  await act(async () => { detailButtons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 12)) })
  if (!(container.textContent ?? '').includes('证据链')) throw new Error('展开后应看到「证据链」字样')

  const pin = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '取消置顶' || (b.textContent ?? '').trim() === '置顶')
  if (pin === undefined) throw new Error('详情里没有置顶按钮')
  await act(async () => { pin.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 12)) })
  const mutated = rpcCalls.slice(before).find((c) => c.method === 'insights/mutate')
  if (mutated === undefined) throw new Error('点置顶应当调用 insights/mutate')
  if (typeof mutated.body?.id !== 'string' || mutated.body.id === '') throw new Error('insights/mutate 必须带 id')
  results.push('  ok   洞察详情能展开（看到证据链），点置顶真的发了 insights/mutate')
} catch (error) {
  failures += 1
  results.push(`  FAIL 洞察详情展开与置顶交互\n       ${error?.message ?? error}`)
}

// 交互：复盘模型选择器选一个 → **两个**配置项都要被写入（"选一个 = 写两项"）
try {
  const { act } = React
  await click(findButton('配置管理'))
  const reviewGroup = [...container.querySelectorAll('.dvev-group')]
    .find((g) => (g.querySelector('.dvev-grouphead')?.textContent ?? '') === '自动复盘')
  if (reviewGroup === undefined) throw new Error('配置管理页找不到「自动复盘」分组')
  const sel = reviewGroup.querySelector('select')
  if (sel === null) throw new Error('复盘分组里没有模型选择器（这一项是"不知道填哪个模型"的答案）')
  /**
   * 用户的要求是「从现有模型里下拉选择，而不是填写」：复盘这一组里不该有任何
   * 可以手打模型 id 的文本框，选项必须真的来自宿主给的模型目录。
   */
  const textInputs = [...reviewGroup.querySelectorAll('input[type=text]')]
  if (textInputs.length > 0) {
    throw new Error(`复盘分组里不该有可手填的文本框，实际 ${textInputs.length} 个`)
  }
  if (sel.options.length < 4) {
    throw new Error(`选择器应包含"不配置（不复盘）" + 宿主给出的模型，实际只有 ${sel.options.length} 项`)
  }
  /**
   * 「跟随当前会话」这个选项必须消失：复盘用哪个模型要显式选，
   * 留空表示不复盘，插件不再拿用户当前会话的模型顶上去。
   */
  const follow = [...sel.options].find((o) => o.value === '' && o.textContent.includes('跟随'))
  if (follow !== undefined) {
    throw new Error('选择器里不该再有"跟随当前会话"：插件不得默认使用用户当前会话的模型')
  }
  const target = [...sel.options].find((o) => o.value.includes('gw-model'))
  if (target === undefined) {
    throw new Error(`选择器里没有 gw-model：${[...sel.options].map((o) => o.value).join(' | ')}`)
  }
  // React 会拦截实例上的 value setter，必须走原型上的原生 setter 才能触发 change
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  await act(async () => {
    setter.call(sel, target.value)
    sel.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 12)) })
  const dirtyBar = container.querySelector('.dvev-dirty')
  const dirtyText = dirtyBar?.textContent ?? ''
  /**
   * 展示层把 review.provider / review.model 折叠成一条「复盘用哪个模型」：
   * 用户做一次选择就提示"1 项改动"，而不是令人困惑的 2 项。
   * 但两个真实配置路径必须仍然进入 dirty —— 它们出现在"未保存"提示的
   * title（实际写入的配置项）里，保存时的 patch 也按这两个路径写。
   */
  if (!dirtyText.includes('保存 1 项改动') || !dirtyText.includes('复盘用哪个模型')) {
    throw new Error(`选一个模型应折叠成"1 项改动（复盘用哪个模型）"，实际：${dirtyText.trim()}`)
  }
  const title = dirtyBar?.querySelector('span[title]')?.getAttribute('title') ?? ''
  if (!title.includes('review.provider') || !title.includes('review.model')) {
    throw new Error(`provider 与 model 两个真实路径都应进入 dirty（体现在 title），实际 title：${title}`)
  }
  results.push('  ok   复盘模型选择器：只有下拉（无可手填文本框），选一个 = 写两个路径但显示为 1 项改动')
} catch (error) {
  failures += 1
  results.push(`  FAIL 复盘模型选择器交互\n       ${error?.message ?? error}`)
}

// 窗口 resize 不应炸（面板按窗口算初始尺寸）
try {
  const { act } = React
  await act(async () => {
    window.innerWidth = 700
    window.innerHeight = 500
    window.dispatchEvent(new window.Event('resize'))
  })
  results.push('  ok   窗口 resize 后不抛')
} catch (error) {
  failures += 1
  results.push(`  FAIL 窗口 resize 后不抛\n       ${error?.message ?? error}`)
}

// 版本号显示：标题栏与「数据隐私」页都必须出现 package.json 的真实版本
//（守的是"占位符没被替换"这类静默失效 —— 面板会显示 __DVEV_VERSION__ 字面量）
try {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const head = container.querySelector('.dvev-head')
  const headText = head?.textContent ?? ''
  if (!headText.includes(`v${pkg.version}`) || !headText.includes(`服务 v${pkg.version}`)) {
    throw new Error(`标题栏应显示面板与服务版本 v${pkg.version}，实际：${headText.trim()}`)
  }
  if (headText.includes('__DVEV_VERSION__') || headText.includes('版本不一致')) {
    throw new Error(`标题栏版本显示异常：${headText.trim()}`)
  }
  await click(findButton('数据隐私'))
  const privText = container.querySelector('.dvev-main')?.textContent ?? ''
  if (!privText.includes('插件版本') || !privText.includes('宿主服务版本') || !privText.includes(`v${pkg.version}`)) {
    throw new Error(`「数据隐私」页应有版本表（插件版本/宿主服务版本 v${pkg.version}），实际片段：${privText.slice(0, 120)}`)
  }
  results.push(`  ok   版本号显示：标题栏与「数据隐私」页都显示 v${pkg.version}，无不一致警示`)
} catch (error) {
  failures += 1
  results.push(`  FAIL 版本号显示\n       ${error?.message ?? error}`)
}

// ---------------------------------------------------------------- 部署前缀
// 面板必须用**前缀相对**路径发请求。宿主可能被部署在子路径下（本项目经 nginx
// 挂在 /ui/，由 nginx 剥前缀转发）：根绝对路径 /dsh-evolution/... 会落到 nginx
// 的兜底 `location /`，被 302 回应用入口；fetch 跟随重定向拿到 SPA 的 HTML(200)，
// rpc() 里 res.json() 解析失败，表现为面板所有请求都报「HTTP 200」。
// 这条断言把约束钉在真实调用路径上 —— 以后有人改回根绝对路径会立刻失败。
try {
  if (fetchedUrls.length === 0) throw new Error('面板没有发出任何 RPC，无法校验请求路径')
  const absolute = [...new Set(fetchedUrls.filter((u) => u.startsWith('/')))]
  if (absolute.length > 0) {
    throw new Error(`必须用前缀相对路径，但出现了根绝对路径：${absolute.join(', ')}（子路径部署下会被 302 到应用入口）`)
  }
  // 模拟「宿主挂在 /ui/」的部署：页面 URL 为 /ui/ 时相对路径应落在 /ui/ 下。
  const resolved = new URL(fetchedUrls[0], 'http://h/ui/')
  if (!resolved.pathname.startsWith('/ui/dsh-evolution/')) {
    throw new Error(`相对路径在 /ui/ 部署下应解析为 /ui/dsh-evolution/...，实际：${resolved.pathname}`)
  }
  results.push(`  ok   请求用前缀相对路径（${fetchedUrls.length} 次），/ui/ 部署下解析为 ${resolved.pathname}`)
} catch (error) {
  failures += 1
  results.push(`  FAIL 请求必须是前缀相对路径（子路径部署兼容性）\n       ${error?.message ?? error}`)
}

// ---------------------------------------------------------------- 结果
console.log('面板 DOM 级自检（jsdom，真实执行构建产物）：\n')
for (const line of results) console.log(line)
console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)

// ⚠️ 必须显式退出：面板里挂了几处 setInterval / setTimeout（运行状态、用量、
// 复盘进度轮询），jsdom 的窗口对象也让事件循环保持活跃，不主动退出就会**挂住**
// （实测：不退出时进程一直不结束，看起来像"检查卡死了"）。
// 同理，stdout 在管道里可能是块缓冲的，所以先 flush 再退。
process.exit(failures > 0 ? 1 : 0)
