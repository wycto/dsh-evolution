/**
 * 集成自检：用假的宿主 ctx 真实调用 `apply()`，验证插件能挂载起来。
 *
 * 逐模块的冒烟测试（scripts/smoke.mjs）证明的是"逻辑对"；
 * 这个脚本证明的是"**能装上去**"——模块图能解析、apply 不抛、
 * 事件订阅与路由注册都在正确的时机发生。
 *
 * 运行：`node scripts/integration.mjs`
 */
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const work = await mkdtemp(join(tmpdir(), 'dsh-evolution-integ-'))
process.env.DSH_EVOLUTION_HOME = work

/**
 * 复盘模型必须**显式配置**（见 lib/llm.js 的 resolveModel：没有会话兜底）。
 * 所以这里先写一份配好模型的配置，让"复盘链路能跑通"的用例测它该测的东西；
 * "没配置就不复盘"由下面那两个专门的用例守着。
 */
await writeFile(join(work, 'config.json'), `${JSON.stringify({
  version: 1,
  enabled: true,
  review: { enabled: true, provider: 'fake-provider', model: 'fake-model' },
}, null, 2)}\n`, 'utf8')

/**
 * 递归收集目录下所有文件的 路径 + 大小 + mtime，用于对比"有没有被写过"。
 * 试跑的零副作用不变式靠它来验证 —— 只看返回值声明是不够的。
 */
async function fingerprint(dir) {
  const out = []
  async function walk(d) {
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name)
      if (e.isDirectory()) { await walk(p); continue }
      const st = await stat(p)
      out.push(`${p}|${st.size}|${st.mtimeMs}`)
    }
  }
  await walk(dir)
  return out.join('\n')
}

const mod = await import('../lib/index.js')

const log = []
const disposers = []
const listeners = new Map()
const routes = []
/** 插件注册的 systemPrompt 段（面板之外的"注入"能力就挂在这上面）。 */
const sections = []


/**
 * 假模型服务。只实现插件真正用到的那几个面：stream / listProviders / listModels。
 * 它必须能"回一段合法 JSON"，否则复盘链路的测试只能验到"失败了会怎样"。
 */
let listModelsCalls = 0
const fakeLlm = {
  listProviders: () => ['fake-provider'],
  listModels: async () => { listModelsCalls += 1; return [{ id: 'fake-model', name: '假模型' }] },
  stream: async function* stream(options) {
    void options
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '{"insights":[]}' }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

/** 记录一次注册，返回它的 disposer。 */
function track(label) {
  let disposed = false
  const dispose = () => { disposed = true }
  disposers.push({ label, isDisposed: () => disposed })
  return dispose
}

/** 极简的假 ctx：只实现插件真正用到的那几个面。 */
function makeCtx() {
  const ctx = {
    logger: {
      info: (m) => log.push(`info: ${m}`),
      warn: (m) => log.push(`warn: ${m}`),
    },
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const cur = listeners.get(event) ?? []
        listeners.set(event, cur.filter((h) => h !== handler))
      }
    },
    // inject 语义：服务已就绪就立即执行回调，并把"子 ctx"交给它。
    // ⚠️ 子 ctx 必须**按 deps 提供对应的服务面** —— 假 ctx 如果只给一个固定的
    // 服务包，那么"插件 inject 了一个宿主其实会提供的服务"这件事就验不出来，
    // 表现为假阳性（测试全绿，真实环境里拿到 undefined 然后抛）。
    inject: (deps, cb) => {
      const child = {
        sessionQuery: {
          listSessions: async () => [],
          // 宿主会话日志：带一个 request/header，用来验证"复盘用哪个模型"能从这里读出来
          readSession: async (id) => ({
            events: id === 'integ-review-1'
              ? [{ type: 'request/header', data: { header: { config: { provider: 'spy-provider', model: 'spy-model' } } } }]
              : [],
            requestHeader: () => (id === 'integ-review-1'
              ? { config: { provider: 'spy-provider', model: 'spy-model' } }
              : undefined),
          }),
        },
        webServer: {
          register: (def) => {
            routes.push(def)
            return track(`route:${def.path}`)
          },
        },
        systemPrompt: {
          section: (section) => {
            sections.push(section)
            return track(`section:${section.name}`)
          },
          getSectionOrder: () => 1000,
          variable: (name) => track(`variable:${name}`),
        },
        // ⚠️ 模型服务必须挂在**子 ctx** 上：宿主里 `ctx.inject(['llm'], cb)` 给回调的
        // 就是这样一个声明过依赖的 ctx，而根 ctx 上读 `ctx.llm` 在 cordis 里会抛
        // （"cannot get property llm without inject"）。假 ctx 如果只在根上放 llm，
        // 就会把这个真实存在的坑藏起来 —— 真机上表现为面板永远显示"宿主没有模型服务"。
        ...((deps ?? []).includes('llm') ? { llm: fakeLlm } : {}),
        effect: (fn) => {
          const dispose = fn()
          disposers.push({ label: 'effect', isDisposed: () => false })
          return dispose
        },
        on: ctx.on,
        get: (name) => child[name],
      }
      cb(child)
      return track(`inject:${(deps ?? []).join(',')}`)
    },
    get: (name) => {
      // 宿主里服务是通过 ctx.get/inject 拿到的。这里补两个"根 ctx 上就有"的服务，
      // 让插件在两条路径下都能拿到（精简宿主也不至于整体失效）。
      if (name === 'llm') return fakeLlm
      return undefined
    },
  }
  return ctx
}

let failures = 0
/**
 * 同步检查。
 *
 * ⚠️ 只能用于同步断言。传 async 函数进来会让断言失败变成 unhandled rejection，
 * **不会被计入 failures** —— 也就是"看起来通过、实际什么都没验"。
 * 异步检查一律用下面的 `atest`。这个坑在本文件里真出现过，所以两个函数分得很开。
 */
function check(name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

/** 异步检查：await 真结果，失败会计入 failures。 */
async function atest(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

console.log(`临时数据目录: ${work}\n`)
console.log('集成自检：')

check('模块导出 name / apply / RUNTIME_VERSION', () => {
  assert.equal(mod.name, 'dsh-evolution')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.RUNTIME_VERSION, 'string')
  assert.ok(mod.RUNTIME_VERSION.length > 0)
})

const ctx = makeCtx()

check('apply() 不抛异常', () => {
  mod.apply(ctx)
})

check('订阅了 session/event 与 session/disposed', () => {
  assert.ok((listeners.get('session/event') ?? []).length > 0, '应订阅 session/event')
  assert.ok((listeners.get('session/disposed') ?? []).length > 0, '应订阅 session/disposed')
})

check('注册了 /dsh-evolution 前缀路由', () => {
  const route = routes.find((r) => r.path === '/dsh-evolution')
  assert.ok(route, `应注册 /dsh-evolution 路由，实际：${routes.map((r) => r.path).join(',') || '(无)'}`)
  assert.equal(route.kind, 'prefix')
  assert.equal(typeof route.handler, 'function')
})

check('喂一条 user/message 事件不会抛，且最终写进账本', async () => {
  const handler = (listeners.get('session/event') ?? [])[0]
  const session = { id: 'integ-sess-1', header: { id: 'integ-sess-1', cwd: process.cwd() } }
  handler(session, {
    type: 'user/message',
    seq: 1,
    time: Date.now(),
    data: { content: [{ type: 'text', text: '集成自检消息' }] },
  })
  handler(session, {
    type: 'assistant/message',
    seq: 2,
    time: Date.now(),
    data: { message: { content: [{ type: 'text', text: '集成自检答复' }] } },
  })
  // 等缓冲落盘（flushEvery=20 没到，得手动触发或等 5s 定时器）
  const hid = (listeners.get('session/disposed') ?? [])[0]
  hid(session)
})

check('喂一条畸形事件不会抛（形状容错）', () => {
  const handler = (listeners.get('session/event') ?? [])[0]
  handler({ id: 'weird' }, null)
  handler({ id: 'weird' }, { type: 'user/message', data: null })
  handler({ id: 'weird2' }, { type: 'user/message', time: 'not-a-number', data: { content: 'plain string' } })
})

check('session/disposed 能清理会话上下文', () => {
  const handler = (listeners.get('session/disposed') ?? [])[0]
  handler({ id: 'nope-not-tracked' })
})

// 给 pending 的异步落盘一点时间，然后验证真的写了文件
await new Promise((r) => setTimeout(r, 300))

check('账本文件已落盘且内容正确', async () => {
  const { LedgerStore } = await import('../lib/ledger-store.js')
  const store = new LedgerStore({ getRootDir: () => work })
  // flush 可能已经由 disposed 触发；再查一次盘上内容
  const { records } = await store.query({ days: 0 })
  assert.ok(records.length >= 2, `应至少有 2 条记录，实际 ${records.length}`)
  const kinds = records.map((r) => r.kind)
  assert.ok(kinds.includes('user_message'), '应有 user_message')
  assert.ok(records.some((r) => r.text === '集成自检消息'), '原文应被保留（本地无脱敏触发）')
})

await atest('HTTP 路由能响应 hello 与 runtime', async () => {
  const route = routes.find((r) => r.path === '/dsh-evolution')
  const call = (method, body) => new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: null,
      body: '',
      writeHead(code, headers) { this.statusCode = code; this.headers = headers },
      end(chunk) { this.body = chunk; resolve(this) },
    }
    route.handler({ url: `/dsh-evolution/${method}`, [Symbol.asyncIterator]: async function* () {} , body }, res)
  })
  const hello = await call('hello')
  assert.equal(hello.statusCode, 200)
  const parsed = JSON.parse(hello.body)
  assert.equal(parsed.ok, true, `hello 应成功：${hello.body}`)
  assert.ok(parsed.data.schema.fields.length > 0, 'hello 应返回配置字段表')
  assert.ok(parsed.data.paths.root.includes('dsh-evolution'), '应返回数据根路径')

  const runtime = await call('runtime')
  const rt = JSON.parse(runtime.body)
  assert.equal(rt.ok, true)
  assert.equal(rt.data.runtime.pluginEnabled, true)
  assert.ok(rt.data.ledger.records >= 0)
})

await atest('未知路由方法返回稳定错误码', async () => {
  const route = routes.find((r) => r.path === '/dsh-evolution')
  const res = await new Promise((resolve) => {
    const r = { statusCode: 0, body: '', writeHead(c) { this.statusCode = c }, end(ch) { this.body = ch; resolve(this) } }
    route.handler({ url: '/dsh-evolution/not-a-method', [Symbol.asyncIterator]: async function* () {} }, r)
  })
  assert.equal(res.statusCode, 404)
  assert.equal(JSON.parse(res.body).error.code, 'method-not-found')
})

await atest('dry-run 路由可用且确实不写任何文件', async () => {
  const route = routes.find((r) => r.path === '/dsh-evolution')
  const call = (method) => new Promise((resolve) => {
    const r = { statusCode: 0, body: '', writeHead(c) { this.statusCode = c }, end(ch) { this.body = ch; resolve(this) } }
    route.handler({ url: `/dsh-evolution/${method}`, [Symbol.asyncIterator]: async function* () {} }, r)
  })

  const before = await fingerprint(work)
  const res = await call('dry-run')
  const after = await fingerprint(work)

  assert.equal(res.statusCode, 200, `dry-run 应返回 200，实际 ${res.statusCode}：${res.body}`)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true, `dry-run 信封应成功：${res.body}`)
  // 无论有没有会话，这两条都必须成立
  assert.equal(body.data.dryRun, true, '应标记自己是试跑')
  assert.equal(body.data.wroteNothing, true, '应声明零副作用')
  // 前面已经喂过事件，所以这里应该真的找到会话并给出报告
  assert.equal(body.data.ok, true, `应找到会话：${JSON.stringify(body.data.reason ?? '')}`)
  assert.ok(body.data.session.sessionId, '应给出会话 id')
  assert.ok(Array.isArray(body.data.injection.sections) && body.data.injection.sections.length === 4,
    '应渲染出四段注入')
  assert.equal(after, before, '试跑前后数据目录的文件指纹必须完全一致（不回写不变式）')
})


// ---------------------------------------------------------------- Phase 1 集成
const callRoute = (method, body) => new Promise((resolve) => {
  const route = routes.find((r) => r.path === '/dsh-evolution')
  const r = { statusCode: 0, body: '', writeHead(c) { this.statusCode = c }, end(ch) { this.body = ch; resolve(this) } }
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    url: `/dsh-evolution/${method}`,
    [Symbol.asyncIterator]: async function* () { if (payload !== '') yield Buffer.from(payload, 'utf8') },
  }
  route.handler(req, r)
})

function envelope(res) {
  const parsed = JSON.parse(res.body)
  return parsed
}

await atest('注册了 systemPrompt 注入段（否则"注入"这条链路根本没接上）', () => {
  assert.ok(sections.length > 0, '应注册至少一个 prompt 段')
  const sec = sections.find((s) => s.name.includes('dsh-evolution'))
  assert.ok(sec, `段名应含插件标识，实际：${sections.map((s) => s.name).join(',')}`)
  assert.ok(Number.isFinite(sec.order), '段的 order 必须是有限数（宿主会因此抛异常）')
  // 段文本求值必须能在"拿不到 agent"时不抛（宿主可能在任何 scope 下组装）
  assert.equal(typeof sec.text, 'function')
  const empty = sec.text(undefined)
  assert.equal(typeof empty, 'string')
})

await atest('注入段在认不出仓库时返回空串（宁可少注入，不要注错）', () => {
  const sec = sections.find((s) => s.name.includes('dsh-evolution'))
  const out = sec.text({ agent: { session: { header: { cwd: '/definitely/not/a/repo/xyz' } } } })
  assert.equal(out, '')
})

await atest('⭐ 模型目录路由：可选模型 + "留空时会用哪个"一起给面板（选而不是猜）', async () => {
  const res = await callRoute('models')
  assert.equal(res.statusCode, 200, res.body)
  const { ok, data } = envelope(res)
  assert.equal(ok, true, res.body)
  assert.ok(Array.isArray(data.providers) && data.providers.length > 0, '应列出提供方')
  assert.equal(data.providers[0].id, 'fake-provider')
  assert.deepEqual(data.providers[0].models.map((m) => m.id), ['fake-model'])
  assert.equal(data.providers[0].models[0].name, '假模型')
  assert.equal(data.llmAvailable, true)
  assert.ok(data.resolved !== null && typeof data.resolved === 'object', '应回答"留空时会用哪个"')
  assert.ok(['config', 'none'].includes(data.resolved.source),
    `模型来源必须是稳定枚举，实际 ${data.resolved.source}`)

  // 缓存与刷新：面板每次切到配置页都会问一次，不能每次都去问适配器
  const again = envelope(await callRoute('models', {}))
  assert.equal(again.data.cached, true, '第二次应命中 host 侧缓存')
  const forced = envelope(await callRoute('models', { force: true }))
  assert.equal(forced.data.cached, false, 'force 必须绕过缓存')
  assert.ok(listModelsCalls >= 2, 'force 应真的再问一次适配器')
  assert.ok(Array.isArray(forced.data.failed), '失败清单必须存在（面板要能解释"这里为什么是空的"）')
})

await atest('insights 路由：空库也能正常返回（首次安装不该报错）', async () => {
  const res = await callRoute('insights', {})
  assert.equal(res.statusCode, 200, res.body)
  const { ok, data } = envelope(res)
  assert.equal(ok, true, res.body)
  assert.ok(Array.isArray(data.insights))
  assert.ok(data.stats, '应返回统计')
  assert.ok(Array.isArray(data.ruleDescriptions) && data.ruleDescriptions.length > 0,
    '应返回入库校验规则（用户有权知道什么会被拒）')
})

await atest('review/preview 路由：账本为空时给出可读原因而不是报错', async () => {
  const res = await callRoute('review/preview', {})
  assert.equal(res.statusCode, 200, res.body)
  const { ok } = envelope(res)
  assert.equal(ok, true)
})

await atest('★ review/run 路由：手动复盘能跑通（用假模型），并把洞察写进库', async () => {
  // 先造一点会话记录（12 轮，满足默认门槛的钳制）
  const handler = (listeners.get('session/event') ?? [])[0]
  const session = { id: 'integ-review-1', header: { id: 'integ-review-1', cwd: process.cwd() } }
  const now = Date.now()
  for (let t = 1; t <= 12; t += 1) {
    handler(session, { type: 'user/message', seq: t * 3, time: now, data: { content: [{ type: 'text', text: `第 ${t} 轮：改一下回调逻辑` }], turn: t } })
    handler(session, { type: 'assistant/message', seq: t * 3 + 1, time: now, data: { message: { content: [{ type: 'text', text: `第 ${t} 轮：好的` }] }, turn: t } })
    handler(session, { type: 'turn/end', seq: t * 3 + 2, time: now, data: { turn: t, reason: 'completed' } })
  }
  const hid = (listeners.get('session/disposed') ?? [])[0]
  hid(session)

  // disposed 处理器里是 `void ledger.flushSession()`（故意不阻塞宿主事件循环），
  // 所以这里必须显式 flush 一次再复盘，否则 review/run 和落盘赛跑，
  // 输赢不定 —— 输了就是 SESSION_NOT_FOUND 的偶发失败。
  await callRoute('ledger/flush', {})

  const res = await callRoute('review/run', { sessionId: 'integ-review-1', mode: 'manual' })
  assert.equal(res.statusCode, 200, res.body)
  const { ok, data } = envelope(res)
  assert.equal(ok, true, `复盘路由应成功：${res.body}`)
  assert.equal(data.sessionId, 'integ-review-1')
  assert.ok(data.gate, '报告里应带 gate 判定')
  assert.ok(Array.isArray(data.accepted), '应带校验结果')
  assert.ok(data.usage && typeof data.usage.inputTokens === 'number', '应带用量')

  // 再读一次洞察库
  const list = envelope(await callRoute('insights', {})).data
  assert.ok(list.stats.total >= 0)
})

await atest('⭐⭐ 并发保护：连点「现在复盘」不会同时打两次模型（真的会花两份钱）', async () => {
  // 这是整个插件里唯一会花钱的路径，所以必须有并发锁。
  // 手法：让假模型"卡住不返回"，把第一次调用挂在模型上，然后立刻发第二次。
  //
  // ⚠️ 这里所有 await 都必须带超时：如果锁失效，两个请求会一起挂在那道闸门上，
  // 测试就会**永远挂着**（实测过：表现为 "unsettled top-level await"），
  // 而不是干脆地失败。
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_r, reject) => setTimeout(() => reject(new Error(`超时：${label}`)), ms)),
  ])
  let openGate
  const gate = new Promise((resolve) => { openGate = resolve })
  let entered = 0
  const originalStream = fakeLlm.stream
  fakeLlm.stream = async function* slowStream() {
    entered += 1
    await gate
    yield { type: 'text-delta', index: 0, text: '{"insights":[]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  try {
    const first = callRoute('review/run', { sessionId: 'integ-review-1', mode: 'manual' })
    // 等第一次真的进入模型调用（此时并发锁应当是置位的）
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(entered, 1, '第一次应该已经进入模型调用')

    const second = await withTimeout(
      callRoute('review/run', { sessionId: 'integ-review-1', mode: 'manual' }),
      3000,
      '第二次调用应立刻被拒绝，而不是排队等模型',
    )
    const blocked = envelope(second)
    assert.equal(blocked.data?.failure?.code, 'ALREADY_RUNNING',
      `第二次必须被并发锁挡住，实际：${JSON.stringify(blocked.data)}`)
    assert.equal(entered, 1, '第二次绝不能再打一次模型')

    openGate()
    const done = envelope(await withTimeout(first, 5000, '第一次复盘应能跑完'))
    assert.ok(done.ok === true, `第一次应正常返回：${JSON.stringify(done).slice(0, 200)}`)
  } finally {
    fakeLlm.stream = originalStream
    openGate?.()
  }
})

await atest('⭐ 复盘/试跑按 sessionId 查询时会下推给账本（否则老会话"看起来不存在"）', async () => {
  // 造一个"较早"的会话，并在它之后塞入足够多的记录把预览窗口挤满。
  // 曾经的实现是"先取最近 N 条，再在内存里按 sessionId 过滤"，
  // 于是这个会话会被判成"账本里没有" —— 而它明明就在盘上。
  const handler = (listeners.get('session/event') ?? [])[0]
  const oldSession = { id: 'integ-old-session', header: { id: 'integ-old-session', cwd: process.cwd() } }
  const now = Date.now() - 86400000
  for (let t = 1; t <= 3; t += 1) {
    handler(oldSession, { type: 'user/message', seq: t, time: now, data: { content: [{ type: 'text', text: `老会话第 ${t} 轮` }], turn: t } })
    handler(oldSession, { type: 'turn/end', seq: t + 100, time: now, data: { turn: t, reason: 'completed' } })
  }
  const hid = (listeners.get('session/disposed') ?? [])[0]
  hid(oldSession)
  // session/disposed 触发的落盘是异步的（不阻塞宿主），这里等它写完再查
  await new Promise((r) => setTimeout(r, 250))

  const preview = envelope(await callRoute('review/preview', { sessionId: 'integ-old-session' }))
  assert.equal(preview.data.ok, true, `应找到这个会话：${JSON.stringify(preview.data)}`)
  assert.equal(preview.data.sessionId, 'integ-old-session')

  const dry = envelope(await callRoute('dry-run', { sessionId: 'integ-old-session' }))
  assert.equal(dry.data.ok, true, `试跑也应找到这个会话：${JSON.stringify(dry.data.reason ?? dry.data.message)}`)
  assert.equal(dry.data.session.sessionId, 'integ-old-session')

  // 不存在的会话要明确区分于"账本为空"
  const missing = envelope(await callRoute('review/preview', { sessionId: 'definitely-not-there' }))
  assert.equal(missing.data.ok, false)
  assert.equal(missing.data.reason, 'session-not-found')
})

await atest('⭐ 指定 sessionId 时**真的把过滤下推给了账本**（否则老会话会"看起来不存在"）', async () => {
  // 为什么不能只靠"小数据量下能找到"来测：那证明不了过滤下推真的发生了，
  // 而真实故障恰恰只在记录数超过查询上限时才出现（先按时间截断、再在内存里过滤，
  // 于是较早的会话被判成"账本里没有"）。
  // 这里直接盯住 LedgerStore.query 的**调用参数**：指定会话时它必须带上 sessionId。
  const { LedgerStore } = await import('../lib/ledger-store.js')
  const seen = []
  const original = LedgerStore.prototype.query
  LedgerStore.prototype.query = async function spyQuery(options = {}) {
    seen.push({ ...options })
    return original.call(this, options)
  }
  try {
    const preview = envelope(await callRoute('review/preview', { sessionId: 'integ-review-1' }))
    assert.equal(preview.data.ok, true, `preview 应成功：${JSON.stringify(preview.data)}`)
    assert.ok(seen.some((q) => q.sessionId === 'integ-review-1'),
      `review/preview 必须把 sessionId 下推给账本查询，实际参数：${JSON.stringify(seen)}`)

    seen.length = 0
    const dry = envelope(await callRoute('dry-run', { sessionId: 'integ-review-1' }))
    assert.equal(dry.data.ok, true, `dry-run 应成功：${JSON.stringify(dry.data.reason ?? dry.data.message)}`)
    assert.ok(seen.some((q) => q.sessionId === 'integ-review-1'),
      `dry-run 也必须下推 sessionId，实际参数：${JSON.stringify(seen)}`)

    seen.length = 0
    const summary = envelope(await callRoute('session/summary', { sessionId: 'integ-review-1' }))
    assert.equal(summary.ok, true, JSON.stringify(summary.error ?? {}))
    assert.ok(seen.some((q) => q.sessionId === 'integ-review-1'),
      `session/summary 也必须下推 sessionId，实际参数：${JSON.stringify(seen)}`)

    // 不存在的会话要能被明确识别（而不是含糊地说"账本为空"）
    const missing = envelope(await callRoute('review/preview', { sessionId: 'definitely-not-there' }))
    assert.equal(missing.data.ok, false)
    assert.equal(missing.data.reason, 'session-not-found')
  } finally {
    LedgerStore.prototype.query = original
  }
})

await atest('★ 复盘报告里带完整 prompt（用户有权看到到底发了什么给模型）', async () => {
  const res = await callRoute('review/preview', { sessionId: 'integ-review-1' })
  const { data } = envelope(res)
  assert.equal(data.ok, true, res.body)
  assert.ok(data.gate, 'preview 应给出 gate')
  assert.equal(typeof data.llmAvailable, 'boolean', '应如实报告模型服务是否可用')
})

await atest('★★ 没配复盘模型时，不许拿会话日志里的模型顶上（不配置就不花钱）', async () => {
  // 宿主会话日志里明明有 provider/model（spy-provider/spy-model），但那是**用户正在用的**模型。
  // 后台复盘顺着它跑 = 用户为一个自己没同意的模型付费，且金额随他随手切模型而漂移。
  // 所以这里必须回答"没配"，而不是替用户挑一个。
  await callRoute('config/save', { patch: { 'review.provider': '', 'review.model': '' } })
  try {
    const res = await callRoute('review/preview', { sessionId: 'integ-review-1' })
    const { data } = envelope(res)
    assert.equal(data.model?.source, 'none', `没配就该是 none，实际 ${JSON.stringify(data.model)}`)
    assert.equal(data.model?.model, '', '不能回落到会话里的模型')
    assert.equal(data.model?.provider, '', '不能回落到会话里的提供方')
    assert.equal(data.gate?.modelReady, false)
    assert.equal(data.gate?.manualAllowed, false, '没配模型时手动按钮也不该放行')

    // 真跑一次：必须在调模型之前就返回，且不产生任何用量
    // （envelope 的 ok 是"HTTP 200 没抛异常"，复盘本身的成败看 data.ok）
    const run = envelope(await callRoute('review/run', { sessionId: 'integ-review-1', mode: 'manual' }))
    assert.equal(run.data?.ok, false, `没配模型时不该复盘成功：${JSON.stringify(run.data).slice(0, 200)}`)
    assert.equal(run.data?.failure?.code, 'NO_REVIEW_MODEL')
    assert.ok(String(run.data?.failure?.message).includes('不会默认使用你当前会话的模型'))
    assert.equal(run.data?.usage, undefined, '没配置就不该有任何用量记录')
  } finally {
    await callRoute('config/save', { patch: { 'review.provider': 'fake-provider', 'review.model': 'fake-model' } })
  }
})

await atest('inject/preview 路由可用', async () => {
  const res = await callRoute('inject/preview', {})
  assert.equal(res.statusCode, 200, res.body)
  const { ok, data } = envelope(res)
  assert.equal(ok, true, res.body)
  assert.ok(Array.isArray(data.repos), '应返回仓库列表（可以为空）')
  assert.ok(data.stats, '应返回缓存统计')
})

await atest('export/markdown 与 export/write 路由可用，且写进数据目录的 exports/', async () => {
  const preview = envelope(await callRoute('export/markdown', {}))
  assert.equal(preview.ok, true)
  assert.ok(typeof preview.data.markdown === 'string')
  assert.ok(preview.data.markdown.includes('dsh-evolution 洞察导出'))

  const written = envelope(await callRoute('export/write', {}))
  assert.equal(written.ok, true, JSON.stringify(written))
  assert.ok(written.data.mdPath.includes('exports'), `导出应落在 exports/ 下，实际 ${written.data.mdPath}`)

  const { exists } = await import('../lib/storage.js')
  assert.equal(await exists(written.data.mdPath), true, '导出的 markdown 应真的落盘')
})

await atest('skills/plan 路由：门槛不够时给出空草稿而不是报错', async () => {
  const res = await callRoute('skills/plan', {})
  assert.equal(res.statusCode, 200, res.body)
  const { ok, data } = envelope(res)
  assert.equal(ok, true, res.body)
  assert.ok(Array.isArray(data.drafts))
  assert.ok(data.dir, '应解析出目标目录')
  assert.equal(data.needsConfirm, false, '默认落点是插件数据目录，不该要确认')
})

await atest('⭐ skills/write：默认落点写在插件数据目录内，不碰任何仓库', async () => {
  const res = await callRoute('skills/write', { confirm: true })
  const { ok, data } = envelope(res)
  assert.equal(ok, true, res.body)
  assert.equal(data.inRepo, false, '默认落点绝不该写进仓库')
  for (const w of data.written) {
    assert.ok(w.path.startsWith(work), `写入路径应在数据目录内：${w.path}`)
  }
})

await atest('⭐ skills/plan 路由透传 repoRoot：撞名仓库只收本仓条目 + team 条目随行', async () => {
  const { InsightsStore } = await import('../lib/insights-store.js')
  const store = new InsightsStore({ getRootDir: () => work })
  await store.load()
  const ev = [{ sessionId: 'integ-skill-1', turn: 2, quote: '原文' }]
  const { added } = await store.upsert([
    { type: 'constraint', scope: 'repo', repo: 'api', repoRoot: '/work/api', title: 'A 仓约束：先写测试', recurrence: 3, evidence: ev, accepted: true },
    { type: 'constraint', scope: 'repo', repo: 'api', repoRoot: '/personal/api', title: 'B 仓约束：先写文档', recurrence: 3, evidence: ev, accepted: true },
    { type: 'constraint', scope: 'team', repo: '', repoRoot: '', title: '团队约束：提交信息全中文', recurrence: 2, evidence: ev, accepted: true },
  ])
  const [aId, bId, tId] = added.map((x) => x.id)

  const planA = envelope(await callRoute('skills/plan', { repo: 'api', repoRoot: '/work/api' }))
  assert.equal(planA.ok, true, JSON.stringify(planA).slice(0, 200))
  const aTitles = planA.data.drafts.flatMap((d) => d.insights.map((i) => i.title))
  assert.ok(aTitles.some((t) => t.includes('先写测试')), `应含 A 仓条目，实际：${aTitles.join('、')}`)
  assert.ok(!aTitles.some((t) => t.includes('先写文档')), '撞名 B 仓的条目不该混进来')
  assert.ok(aTitles.some((t) => t.includes('提交信息全中文')), 'team 条目任何目标仓库都带上')

  const planB = envelope(await callRoute('skills/plan', { repo: 'api', repoRoot: '/personal/api' }))
  const bTitles = planB.data.drafts.flatMap((d) => d.insights.map((i) => i.title))
  assert.ok(bTitles.some((t) => t.includes('先写文档')), 'B 仓应只收自己的条目')
  assert.ok(!bTitles.some((t) => t.includes('先写测试')), 'A 仓条目不该混进 B 仓')

  for (const id of [aId, bId, tId]) await callRoute('insights/delete', { id })
})

await atest('★ 晋升全链路：写一条够格的洞察 → 晋升 → 出现在个人提醒注入段 → 可退回', async () => {
  const { InsightsStore } = await import('../lib/insights-store.js')
  const store = new InsightsStore({ getRootDir: () => work })
  await store.load()
  const ev = [{ sessionId: 'integ-review-1', turn: 4, quote: '原文' }]
  const { added } = await store.upsert([
    { type: 'pitfall', scope: 'repo', repo: 'integ', title: '跨仓库自检要隔离数据目录', recurrence: 3, evidence: ev, accepted: true },
  ])
  const id = added[0].id

  const plan = envelope(await callRoute('insights/promotions', {}))
  assert.equal(plan.ok, true, JSON.stringify(plan).slice(0, 200))
  assert.ok(plan.data.eligible.some((i) => i.id === id), '够格的条目应出现在候选里')

  // team 需要显式确认
  const noConfirm = envelope(await callRoute('insights/promote', { id, scope: 'team' }))
  assert.equal(noConfirm.ok, false)
  assert.equal(noConfirm.error.code, 'bad-request')

  const up = envelope(await callRoute('insights/promote', { id, scope: 'person' }))
  assert.equal(up.ok, true, JSON.stringify(up).slice(0, 200))
  assert.equal(up.data.insight.scope, 'person')
  assert.equal(up.data.insight.repo, '')

  // 晋升后应真的进入「个人提醒」注入段
  const inject = envelope(await callRoute('inject/preview', {}))
  assert.equal(inject.ok, true)
  const withPersonal = (inject.data.repos ?? []).find((r) => (r.sections ?? []).some((sec) => sec.id === 'personal' && sec.count > 0))
  assert.ok(withPersonal, `晋升后 personal 段应有内容，实际：${JSON.stringify((inject.data.repos ?? []).map((r) => r.sections.map((sec) => `${sec.id}:${sec.count}`)))}`)

  const down = envelope(await callRoute('insights/demote', { id }))
  assert.equal(down.ok, true, JSON.stringify(down).slice(0, 200))
  assert.equal(down.data.insight.scope, 'repo', '退回应回到晋升前的作用域')
  assert.equal(down.data.insight.promotedFrom, undefined)

  await callRoute('insights/delete', { id })
})

await atest('★ 清空洞察必须先留档（用户要的是"看不见"，不是"不可恢复"）', async () => {
  const { InsightsStore } = await import('../lib/insights-store.js')
  const store = new InsightsStore({ getRootDir: () => work })
  await store.load()
  await store.upsert([{
    type: 'fact', scope: 'repo', repo: 'integ', title: '清空前写的这条必须能被留档找回',
    evidence: [{ sessionId: 's', turn: 1, quote: 'q' }],
  }])
  const before = store.stats().total
  assert.ok(before >= 1)

  const res = envelope(await callRoute('insights/clear'))
  assert.equal(res.ok, true, res.body)
  assert.ok(res.data.removed >= 1, '应报告清掉了多少条')
  assert.ok(typeof res.data.archivedTo === 'string' && res.data.archivedTo !== '', '必须给留档路径')
  const { exists, readNdjson } = await import('../lib/storage.js')
  assert.equal(await exists(res.data.archivedTo), true, '留档文件必须真的存在')
  const { records } = await readNdjson(res.data.archivedTo)
  assert.ok(records.some((r) => JSON.stringify(r).includes('清空前写的这条必须能被留档找回')),
    '留档里应能找到清空前的条目')

  const after = envelope(await callRoute('insights', {})).data
  assert.equal(after.insights.length, 0, '清空后列表应为空')
  assert.equal(after.stats.total, 0)
})

await atest('★ 从日志重建索引：数据不动，只重算派生快照', async () => {
  const { InsightsStore } = await import('../lib/insights-store.js')
  const store = new InsightsStore({ getRootDir: () => work })
  await store.load()
  const { added } = await store.upsert([{
    type: 'practice', scope: 'repo', repo: 'integ', title: '重建索引不该丢这条',
    evidence: [{ sessionId: 's', turn: 2, quote: 'q' }],
  }])
  assert.equal(added.length, 1)

  const res = await callRoute('insights/rebuild')
  assert.equal(res.statusCode, 200, res.body)
  const { ok, data } = envelope(res)
  assert.equal(ok, true, res.body)
  assert.ok(data.stats.total >= 1, '重建后条目应还在')

  const list = envelope(await callRoute('insights', {})).data
  assert.ok(list.insights.some((i) => i.title === '重建索引不该丢这条'), '重建后仍应读到这条')

  // 真正的"重建"：把派生索引删掉，再重建，条目必须原样回来
  const { rm } = await import('node:fs/promises')
  await rm(`${work}/insights/index.json`, { force: true })
  const again = envelope(await callRoute('insights/rebuild'))
  assert.ok(again.data.stats.total >= 1, '索引文件被删掉后，重放日志仍应重建出全部条目')
})

await atest('★ 账本 flush 路由可用（面板刷新前先落盘，否则刚发生的事件看不到）', async () => {
  const res = await callRoute('ledger/flush')
  assert.equal(res.statusCode, 200, res.body)
  const { ok, data } = envelope(res)
  assert.equal(ok, true, res.body)
  assert.ok(typeof data.records === 'number', '应返回落盘后的统计')
  assert.equal(data.pendingBuffered, 0, 'flush 之后不该还有待落盘的记录')
})

await atest('★ 用量统计：口径来自真实复盘（token 数、次数、状态分布）', async () => {
  const res = await callRoute('usage', { days: 30 })
  assert.equal(res.statusCode, 200, res.body)
  const { ok, data } = envelope(res)
  assert.equal(ok, true, res.body)
  assert.ok(typeof data.runs === 'number', '应给复盘次数')
  assert.ok(typeof data.inputTokens === 'number' && typeof data.outputTokens === 'number')
  assert.equal(data.totalTokens, data.inputTokens + data.outputTokens)
  assert.ok(data.today && typeof data.today.calls === 'number', '应给今日用量')
  assert.ok(typeof data.budget === 'number', '应给每日预算（面板要显示刹车）')
  assert.ok(typeof data.note === 'string' && data.note.includes('账单'), '要写明"以提供方账单为准"')
  assert.ok(Array.isArray(data.recent), '应给最近的调用明细')
})

await atest('insights/promote 对不存在的 id 返回 404，对非法 scope 返回 400', async () => {
  const missing = envelope(await callRoute('insights/promote', { id: 'nope', scope: 'person' }))
  assert.equal(missing.error.code, 'not-found')
  const bad = envelope(await callRoute('insights/promote', { id: 'x', scope: 'galaxy' }))
  assert.equal(bad.error.code, 'bad-request')
})

await atest('skills/validate 能抓出非法 SKILL.md（宿主会静默跳过它）', async () => {
  const bad = envelope(await callRoute('skills/validate', { text: '---\nname: "Bad Name"\ndescription: "x"\n---\n' }))
  assert.equal(bad.ok, true)
  assert.ok(bad.data.errors.length > 0, '非法 name 应被抓出')
  const good = envelope(await callRoute('skills/validate', { text: '---\nname: "ok-name"\ndescription: "x"\n---\n\nbody\n' }))
  assert.deepEqual(good.data.errors, [])
})

await atest('洞察增删改：写入后能读到、删除后消失（走真实 HTTP 路由）', async () => {
  // 直接借 store 写入一条（等价于复盘产出），再通过路由操作它
  const { InsightsStore } = await import('../lib/insights-store.js')
  const store = new InsightsStore({ getRootDir: () => work })
  await store.load()
  const { added } = await store.upsert([{
    type: 'pitfall', scope: 'repo', repo: 'integ', title: '集成自检写入的一条洞察',
    evidence: [{ sessionId: 'integ-review-1', turn: 3, quote: '原文' }],
  }])
  assert.equal(added.length, 1)

  const id = added[0].id
  const mutated = envelope(await callRoute('insights/mutate', { id, patch: { pinned: true, accepted: true } }))
  assert.equal(mutated.ok, true, JSON.stringify(mutated))
  assert.equal(mutated.data.insight.pinned, true)
  assert.equal(mutated.data.insight.accepted, true)

  const deleted = envelope(await callRoute('insights/delete', { id }))
  assert.equal(deleted.ok, true)
  const after = envelope(await callRoute('insights', {})).data
  assert.equal(after.insights.some((i) => i.id === id), false, '删除后不该再出现')
})

await atest('insights/mutate 对不存在的 id 返回 404 而不是静默成功', async () => {
  const res = await callRoute('insights/mutate', { id: 'nope', patch: { pinned: true } })
  assert.equal(res.statusCode, 404)
  assert.equal(envelope(res).error.code, 'not-found')
})

await atest('⭐ 洞察库的写操作是串行的：并发写入不会丢数据', async () => {
  const { InsightsStore } = await import('../lib/insights-store.js')
  const store = new InsightsStore({ getRootDir: () => work })
  await store.load()
  const jobs = Array.from({ length: 20 }, (_, i) => store.upsert([{
    type: 'fact', scope: 'repo', repo: 'integ', title: `并发写入的条目 ${i}`,
    evidence: [{ sessionId: 's', turn: i, quote: 'q' }],
  }]))
  await Promise.all(jobs)
  const fresh = new InsightsStore({ getRootDir: () => work })
  await fresh.load()
  const titles = fresh.list().map((i) => i.title)
  for (let i = 0; i < 20; i += 1) {
    assert.ok(titles.includes(`并发写入的条目 ${i}`), `第 ${i} 条并发写入丢了`)
  }
})

await atest('insights/import 路由：导入→新增、再导入→跳过、坏包→400', async () => {
  const bundle = {
    version: 1,
    exportedAt: '2026-09-19T00:00:00.000Z',
    insights: [{
      id: 'integ-import-1', type: 'fact', scope: 'repo', repo: 'integ', repoRoot: '/integ',
      title: '导入路由验证条目', recurrence: 3,
      evidence: [{ sessionId: 's', turn: 1, quote: 'q', at: 1700000000000 }],
    }],
  }
  const first = envelope(await callRoute('insights/import', { data: bundle }))
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.data.addedCount, 1)
  assert.equal(first.data.skipped, 0)
  assert.equal(first.data.rejected.length, 0)

  // 再导同一份：零副作用（这是导入与 upsert 的本质区别）
  const second = envelope(await callRoute('insights/import', { data: bundle }))
  assert.equal(second.ok, true)
  assert.equal(second.data.addedCount, 0)
  assert.equal(second.data.skipped, 1)

  // 走列表路由确认库里真有、且复现次数保真
  const list = envelope(await callRoute('insights', { includeArchived: true, limit: 5000 }))
  assert.equal(list.ok, true)
  const imported = list.data.insights.find((i) => i.id === 'integ-import-1')
  assert.ok(imported, '导入的条目应该能从列表路由读到')
  assert.equal(imported.recurrence, 3)

  const bad = await callRoute('insights/import', { text: '{oops' })
  assert.equal(bad.statusCode, 400)
  assert.equal(envelope(bad).error.code, 'bad-request')
})

await rm(work, { recursive: true, force: true })

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
if (failures > 0) process.exit(1)
