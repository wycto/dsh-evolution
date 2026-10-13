/**
 * dsh-evolution — 洞察存储（L2 真相源）
 *
 * 数据布局与"为什么不直接用数据库"见 docs/DESIGN.md 决策 4：
 *
 *   insights/insights.ndjson   ← **真相源**：一行一次操作，只追加，崩溃最多丢最后一行
 *   insights/index.json        ← **派生快照**：当前状态的物化结果，删掉能重建
 *
 * 这样安排的原因：
 *
 * 1. **可审计**：用户能打开 ndjson 看到"这条结论是哪来的、什么时候晋升的"。
 *    只存一个最终对象会把这段历史抹掉，而"为什么会有这条约束"恰恰是用户最常问的。
 * 2. **崩溃安全**：append-only 的文件不会因为写到一半被杀而整体损坏
 *    （对比：每次重写整个 JSON，一次断电就全没了）。
 * 3. **可重建**：索引坏了、schema 改了、用户手改了，重放一遍 ndjson 即可。
 *    所以索引永远只是缓存，任何时候都以 ndjson 为准。
 *
 * ⚠️ 一条纪律：**所有写操作必须串行化**（下面的 `queue`）。
 * 复盘是异步的，用户的"删除/置顶"是即时的，两者交错时会互相覆盖。
 * 用一条 Promise 链把所有"读-改-写"排成队，比到处加锁简单且不会漏。
 */
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { str } from './paths.js'
import { readNdjson, writeJsonAtomic } from './storage.js'

/** 目录/文件名。 */
export const INSIGHTS_DIR = 'insights'
export const INSIGHTS_LOG = 'insights.ndjson'
export const INSIGHTS_INDEX = 'index.json'

/** 日志格式版本。结构不兼容时靠它拒绝误读（宁可重建，不要读错）。 */
export const INSIGHTS_LOG_VERSION = 1

/** 单条洞察保存的最大证据条数。证据是"可复核"的凭据，但也不能无限长。 */
export const MAX_EVIDENCE = 12

/** 标题/正文的长度硬上限（入库前就截断，避免一条巨型文本污染注入预算）。 */
export const MAX_TITLE_CHARS = 160
export const MAX_DETAIL_CHARS = 1200

/** 作用域：从小范围到大范围。数值越大越"重"，晋升只能往大走。 */
export const SCOPES = Object.freeze({
  session: 'session',
  repo: 'repo',
  team: 'team',
  person: 'person',
})

/** 作用域权重（用于排序：越具体越优先注入）。 */
export const SCOPE_WEIGHT = Object.freeze({
  session: 1,
  repo: 4,
  team: 3,
  person: 2,
})

/** 洞察类型。`constraint` 是"必须遵守"，措辞与注入语气都不同。 */
export const INSIGHT_TYPES = Object.freeze({
  constraint: 'constraint',
  pitfall: 'pitfall',
  practice: 'practice',
  decision: 'decision',
  fact: 'fact',
})

/** 类型权重（同作用域下，强制约束比一般事实更该被看到）。 */
export const TYPE_WEIGHT = Object.freeze({
  constraint: 5,
  pitfall: 4,
  practice: 3,
  decision: 2,
  fact: 1,
})

/** 洞察目录与文件路径。 */
export function insightsDir(root) {
  return join(root, INSIGHTS_DIR)
}
export function insightsLogFile(root) {
  return join(insightsDir(root), INSIGHTS_LOG)
}
export function insightsIndexFile(root) {
  return join(insightsDir(root), INSIGHTS_INDEX)
}

/**
 * 归一化标题 → 去重键的原料。
 *
 * 归一化规则刻意激进（去掉所有空白、标点、大小写）：
 * 模型每次复述同一条经验时措辞都会变，靠原文比对去重几乎必然失败，
 * 结果是同一个坑在库里躺了十条，每条 recurrence 都是 1 —— 而 recurrence
 * 是这个项目里唯一"进化"信号（见 DESIGN §一）。宁可偶尔合并两条相近的，
 * 也不要让复现计数永远上不去。
 */
export function normalizeTitle(title) {
  return canonicalTitle(title)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'`~()（）[\]{}<>《》「」【】…—\-_/\\|*+=#@$%^&]/g, '')
    .slice(0, 120)
}

/**
 * 标题的"主干"：在第一个解释性分隔符处截断。
 *
 * 为什么需要这一步：模型复述同一条经验时，**主干几乎不变，解释性后缀每次不同**。
 * 实测（真实模型跑出来的）：
 *   「DSH 技能只在一级目录下被发现：<root>/<目录>/SKILL.md 或 <root>/<文件>.md」
 *   「DSH 技能目录只认两种形态、且只扫描一层：<root>/<任意目录>/SKILL.md 或 …」
 * 两条说的是同一件事，但整句归一化后不同，于是库里躺了两条 recurrence=1 ——
 * 而复现次数（recurrence）是这个项目唯一的"进化"信号（DESIGN §一）。
 * 在第一个 `：` / `:` / `——` / `（` 处截断后，主干一致，就能正确合并。
 */
export function canonicalTitle(title) {
  return str(title).split(/[：:（(]|——|--/)[0]
}

/**
 * 正文骨架：去掉空白、标点、**以及所有括号组的内容**。
 *
 * 括号里往往正是"每条都不同"的部分（文件名、路径、参数、占位符措辞）。
 * 先摘掉再比相似度，剩下的才是"这句话在说什么"。
 * 实测：`<root>/<dir>/SKILL.md` 与 `<root>/<任意目录>/SKILL.md` 这种差别，
 * 不摘括号时相似度只有 0.12（永远合不上），摘掉后能到 0.6 以上。
 */
export function textSkeleton(text) {
  return skeleton(str(text).replace(/[（(\[【][^）)\]】]*[）)\]】]|<[^\n<>]{1,40}>/g, ''))
}

/**
 * 两条标题的相似度（CJK 二元组 + 拉丁词的 Jaccard）。
 * 用于"措辞差异较大但意思相同"的兜底合并；配合 dedupeKey 一起用。
 */
export function titleSimilarity(a, b) {
  const setA = shingles(a)
  const setB = shingles(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  for (const t of setA) if (setB.has(t)) inter += 1
  return inter / (setA.size + setB.size - inter)
}

/** 标题骨架：去掉所有空白与标点，只留字符（用于"主干包含"判断）。 */
export function skeleton(text) {
  return canonicalTitle(text).toLowerCase().replace(/[\s\u3000，。、；！？,.;!?"'`~()（）[\]{}<>《》「」【】…—\-_/\\|*+=#@$%^&]/g, '')
}

/**
 * 两条标题的**括号内容**是否一致。
 *
 * 只看括号内容（不比数字）：括号里装的通常是最容易变、也最能区分"是不是同一条"
 * 的东西 —— 文件名、路径、函数名。`<root>/<dir>/SKILL.md` 与
 * `<root>/<任意目录>/SKILL.md` 的骨架完全不同（一个 `dir` 一个 `任意目录`），
 * 但括号里都是占位符，应当允许合并。
 */
export function sameMarkers(a, b) {
  return bracketsOf(a) === bracketsOf(b)
}

/** 标题里所有括号组的内容（小写、排序、拼接）。 */
export function bracketsOf(text) {
  return (str(text).match(/[（(\[【][^）)\]】]*[）)\]】]|<[^\n<>]{1,40}>/g) ?? [])
    .map((x) => x.toLowerCase()).sort().join('|')
}

/** 标题里的数字列表（排序拼接）。编号/端口/数量/版本不同 → 不是同一条。 */
export function numbersOf(text) {
  return (str(text).match(/\d+/g) ?? []).sort().join(',')
}

/** 一组用于相似度比较的 n-gram（CJK 二元组 + 小写拉丁词）。 */
function shingles(text) {
  const s = str(text).toLowerCase()
  const out = new Set()
  for (const run of s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    const chars = [...run]
    if (chars.length === 1) { out.add(chars[0]); continue }
    for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1])
  }
  for (const w of s.match(/[a-z0-9_]{3,}/g) ?? []) out.add(w)
  return out
}

/**
 * 自动合并的门槛。**刻意定得高**：合并错了会虚构复现次数，而复现次数是自动晋升的
 * 唯一依据 —— 宁可在库里留两条相近的（用户能在面板上手动合并），
 * 也不要自动合出假的"这条已经出现 3 次了"。
 *
 * 两个值：
 *   · `SIMILARITY_MERGE_THRESHOLD` —— 骨架相似度门槛（措辞不同但说的是一件事）
 *   · `CONTAINMENT_MERGE_THRESHOLD` —— 一条主干完整包含另一条时的门槛（更宽松）
 */
export const SIMILARITY_MERGE_THRESHOLD = 0.75
export const CONTAINMENT_MERGE_THRESHOLD = 0.6

/**
 * 去重键：`<type>:<scope>:<hash(归一化标题)>`。
 *
 * 用 FNV-1a 而不是 crypto：同步、零依赖、够短，而且这个哈希只用于分组，
 * 不需要抗碰撞（真撞了也只是合并两条相近经验，代价可接受）。
 */
export function dedupeKey(type, scope, title) {
  return `${str(type) || 'fact'}:${str(scope) || 'repo'}:${fnv1a(normalizeTitle(title))}`
}

/** FNV-1a 32 位哈希 → 8 位十六进制。 */
export function fnv1a(text) {
  let h = 0x811c9dc5
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    // Math.imul 保证 32 位整数乘法不丢精度（普通 * 会变成浮点）
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 两条"仓库根"是否指同一个仓库。
 *
 * 归属比对**优先走路径**：仓库名会撞（两个 `api/`），路径不会。老数据只有
 * 名字（repoRoot 为空），那些条目继续按名字匹配 —— 见 retrieve.js 的规则。
 * 规范化只做两件事：去掉结尾分隔符；Windows 上忽略大小写（盘符与目录大小写
 * 在不同探测路径下可能不一致）。放在 insights-store 而不是 retrieve，是因为
 * retrieve 已经 import 本模块（入库合并也要做这个比对），反过来就会循环依赖。
 */
export function sameRepoRootPath(a, b) {
  const norm = (p) => str(p).replace(/[\\/]+$/, '')
  const x = norm(a)
  const y = norm(b)
  if (x === '' || y === '') return false
  if (process.platform === 'win32') return x.toLowerCase() === y.toLowerCase()
  return x === y
}

/** 稳定 id：时间 + 计数器 + 随机尾，便于按时间排序且不会撞。 */
export function makeId(prefix = 'ins') {
  const t = Date.now().toString(36)
  const r = Math.floor(Math.random() * 0xffffff).toString(36).padStart(5, '0')
  return `${prefix}_${t}_${r}`
}

/** 截断到 max 字符（按代码点，避免切坏 emoji/中文）。 */
export function clipText(text, max) {
  const arr = [...str(text)]
  if (arr.length <= max) return arr.join('')
  return `${arr.slice(0, max).join('')}…`
}

/**
 * 归一化一条证据。返回 undefined 表示"这条证据不合法"。
 *
 * 证据的最小要求是**能回到原文**：要么给出会话 id + 轮次，要么给出可直接
 * 原文检索的引文。只有"模型说是这样"不算证据 —— 没有证据的结论不许入库，
 * 这是 DESIGN §4.2 里写死的规则，这里就是它的代码实现。
 */
export function normalizeEvidence(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const sessionId = str(raw.sessionId ?? raw.sid)
  const turn = typeof raw.turn === 'number' && Number.isFinite(raw.turn) ? Math.trunc(raw.turn) : undefined
  const quote = clipText(raw.quote ?? raw.text ?? '', 240)
  const kind = str(raw.kind) || 'session'
  if (sessionId === '' && quote === '') return undefined
  return {
    kind,
    sessionId,
    ...(turn === undefined ? {} : { turn }),
    quote,
    at: typeof raw.at === 'number' ? raw.at : Date.now(),
  }
}

/**
 * 归并两条证据（同一个会话同一轮只留一条，但保留更长的引文）。
 * 去重是必要的：模型常把同一轮引用两次，不去重会让证据链看起来比实际更硬。
 */
function mergeEvidence(list, incoming, cap = MAX_EVIDENCE) {
  const out = Array.isArray(list) ? [...list] : []
  for (const ev of incoming) {
    const idx = out.findIndex((e) => e.sessionId === ev.sessionId
      && (e.turn ?? -1) === (ev.turn ?? -1)
      && e.kind === ev.kind)
    if (idx === -1) {
      out.push(ev)
      continue
    }
    if ([...(ev.quote ?? '')].length > [...(out[idx].quote ?? '')].length) out[idx] = ev
  }
  return out
}

/**
 * 把"新观察到的一条"归一化成完整洞察对象。
 * 所有写入口（复盘产出、人工新增）都过这里，保证形状一致。
 */
export function makeInsight(input) {
  const type = Object.values(INSIGHT_TYPES).includes(str(input?.type)) ? str(input.type) : INSIGHT_TYPES.fact
  const scope = Object.values(SCOPES).includes(str(input?.scope)) ? str(input.scope) : SCOPES.repo
  const title = clipText(input?.title ?? input?.claim ?? '', MAX_TITLE_CHARS)
  const detail = clipText(input?.detail ?? input?.body ?? '', MAX_DETAIL_CHARS)
  const evidence = []
  for (const raw of Array.isArray(input?.evidence) ? input.evidence : []) {
    const ev = normalizeEvidence(raw)
    if (ev !== undefined) evidence.push(ev)
  }
  const now = Date.now()
  const key = str(input?.key) || dedupeKey(type, scope, title)
  return {
    id: str(input?.id) || makeId(),
    key,
    type,
    scope,
    /** 仓库作用域必须有归属；没有归属的"repo 洞察"会污染所有仓库。 */
    repo: scope === SCOPES.repo ? str(input?.repo) : str(input?.repo),
    /**
     * 仓库根（绝对路径）。归属比对**优先走路径**：名字会撞（两个 `api/`），
     * 路径不会。老数据没有这个字段（undefined 归一成 ''），继续按名字匹配。
     */
    repoRoot: str(input?.repoRoot),
    title,
    detail,
    priority: clampPriority(input?.priority),
    recurrence: Math.max(1, Math.trunc(Number(input?.recurrence ?? 1) || 1)),
    confidence: clampConfidence(input?.confidence),
    evidence: evidence.slice(0, MAX_EVIDENCE),
    /** true = 来自模型归纳；false = 人工录入或从账本确定性推导（可区分信任级别）。 */
    derived: input?.derived === true,
    /** 人工确认：置顶/pin。pinned 条目不会被自动归档，也必然参与注入。 */
    pinned: input?.pinned === true,
    /** 人工采纳：只有被采纳的条目才允许生成 skill 草稿（见 config.export）。 */
    accepted: input?.accepted === true,
    /** 归档：保留数据但从注入与检索里消失（curator 三铁律之"只归档不删除"）。 */
    archived: input?.archived === true,
    /** 被注入过多少次。用于"这条提醒你到底看没看到"的判断。 */
    injectedCount: Math.max(0, Math.trunc(Number(input?.injectedCount ?? 0) || 0)),
    // 注入时间戳的透传（导入恢复用）：只在入参带它时保留，避免改变既有条目的形状
    ...(typeof input?.lastInjectedAt === 'number' ? { lastInjectedAt: input.lastInjectedAt } : {}),
    createdAt: typeof input?.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input?.updatedAt === 'number' ? input.updatedAt : now,
    firstSeenAt: typeof input?.firstSeenAt === 'number' ? input.firstSeenAt : now,
    lastSeenAt: typeof input?.lastSeenAt === 'number' ? input.lastSeenAt : now,
    /** 模型自报的来源会话（第一现场）。 */
    originSessionId: str(input?.originSessionId),
    /**
     * 人工晋升的来源记录：`{ at, from: { scope, repo } }`。
     *
     * 为什么必须留这个：把一条经验从"只在这个仓库成立"提升为"跨仓库提醒"，
     * 等于**扩大了它的适用范围** —— 而适用范围过宽比过窄更危险（在错误的
     * 上下文里给出看起来很权威的提醒）。留下来源，用户随时能看到
     * "这条本来只属于 X 仓库"，也能据此退回。
     */
    promotedFrom: normalizePromotedFrom(input?.promotedFrom),
    /** 校验器留下的痕迹：被降级/被标注的原因，面板要显示。 */
    flags: Array.isArray(input?.flags) ? input.flags.map(str).filter((f) => f !== '') : [],
  }
}

/** 归一化"晋升来源"记录（形状不对就丢掉，不阻塞入库）。 */
export function normalizePromotedFrom(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const from = raw.from ?? {}
  const scope = Object.values(SCOPES).includes(str(from.scope)) ? str(from.scope) : ''
  const repo = str(from.repo)
  const repoRoot = str(from.repoRoot)
  if (scope === '' && repo === '' && repoRoot === '') return undefined
  return {
    at: typeof raw.at === 'number' ? raw.at : Date.now(),
    from: {
      ...(scope === '' ? {} : { scope }),
      ...(repo === '' ? {} : { repo }),
      ...(repoRoot === '' ? {} : { repoRoot }),
    },
  }
}

function clampPriority(v) {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return 0
  return Math.max(-10, Math.min(10, Math.trunc(n)))
}

/**
 * 两条 repo 作用域的洞察是否归属**不同**的仓库（按路径判）。
 * 只在两边都带 repoRoot 时才可能返回 true —— 老数据只有名字，无法判断，
 * 维持按名字合并的旧行为（那是升级前数据的语义）。
 */
function conflictsRepo(existing, next) {
  if (str(existing?.scope) !== SCOPES.repo || str(next?.scope) !== SCOPES.repo) return false
  const a = str(existing?.repoRoot)
  const b = str(next?.repoRoot)
  if (a === '' || b === '') return false
  return !sameRepoRootPath(a, b)
}

function clampConfidence(v) {
  const n = Number(v ?? 0.5)
  if (!Number.isFinite(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

/**
 * "键 → id 列表"的登记与摘除。
 *
 * 做成模块级函数而不是只放在类上：applyOp 是独立导出的纯函数，
 * 测试会用只有 byKey/byId 字段的桩对象调它，不能依赖类方法。
 */
function keyIndexAdd(map, key, id) {
  const k = str(key)
  if (k === '') return
  const ids = map.get(k) ?? []
  if (!ids.includes(id)) ids.push(id)
  map.set(k, ids)
}

function keyIndexRemove(map, key, id) {
  const k = str(key)
  const ids = map.get(k)
  if (ids === undefined) return
  const next = ids.filter((x) => x !== id)
  if (next.length === 0) map.delete(k)
  else map.set(k, next)
}

/**
 * 洞察库。
 *
 * @param options.getRootDir - () => string，数据根目录（配置可变，所以是函数）。
 * @param options.logger - 宿主 logger。
 */
export class InsightsStore {
  constructor(options = {}) {
    this.getRootDir = options.getRootDir ?? (() => '')
    this.logger = options.logger
    /** 内存索引：id → insight。由 ndjson 重放得到。 */
    this.byId = new Map()
    /**
     * 去重键 → id 列表。**一个键可以对应多条**：键是 `type:scope:hash(title)`，
     * 不含仓库归属，撞名仓库（两个 `api/`）的同标题条目共享一个键 ——
     * 它们互不合并（见 conflictsRepo），但同仓库的下一次出现要能找到自己那条。
     */
    this.byKey = new Map()
    /** 是否已经从磁盘加载过。 */
    this.loaded = false
    /** 加载时遇到的问题（面板可见，绝不静默）。 */
    this.lastError = ''
    /** 日志坏行数（面板显示"有 N 行无法解析"）。 */
    this.badLines = 0
    /** 写操作串行队列（见文件头纪律）。 */
    this.queue = Promise.resolve()
    /** 已加载的日志所在根目录，用于检测"用户改了数据目录"。 */
    this.loadedRoot = ''
    /** 已加载日志的文件指纹（size:mtime），用于检测"别的实例写过盘"。 */
    this.loadedStamp = ''
    /** 统计：本次进程写过多少条操作。 */
    this.appended = 0
  }

  dir() {
    return insightsDir(this.getRootDir())
  }

  logFile() {
    return insightsLogFile(this.getRootDir())
  }

  indexFile() {
    return insightsIndexFile(this.getRootDir())
  }

  /** 把一次写操作排进队列。任何异常都吞掉并记 lastError —— 调用方不该因为洞察写失败而崩。 */
  enqueue(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** 登记一个"键 → id"映射（一个键可对应多条，见 byKey 的说明）。 */
  indexKey(key, id) {
    keyIndexAdd(this.byKey, key, id)
  }

  /** 摘掉一个"键 → id"映射（删除/合并条目时调用）。 */
  unindexKey(key, id) {
    keyIndexRemove(this.byKey, key, id)
  }

  /** 在同键的条目里挑一条能与 candidate 合并的（跳过归属不同仓库的）。 */
  findMergeableByKey(key, candidate) {
    for (const id of this.byKey.get(str(key)) ?? []) {
      const item = this.byId.get(id)
      if (item !== undefined && !conflictsRepo(item, candidate)) return id
    }
    return undefined
  }

  /**
   * 从磁盘加载。
   *
   * ⚠️ **每次调用都重放日志，不做"加载过就跳过"的缓存判断。**
   *
   * 理由：同一个进程里可能同时存在多个 InsightsStore 实例（路由一个、后台复盘
   * 一个、注入缓存一个），而日志是只追加的。任何"我已经加载过了"的短路，
   * 都会让某个实例读到**比磁盘旧**的快照 —— 表现为面板上明明列着这条洞察，
   * 点"置顶"却报 404。
   *
   * 试过用文件指纹（size + mtime）做变更检测，实测**不可靠**：极快的连续写入
   * 可以让两次 stat 拿到完全相同的 size/mtime，于是变更被漏掉，表现为偶发
   * （同一份测试有时绿有时红）。而这份数据的规模是"人一生写下的经验条目"，
   * 不是遥测流：重放几千行的成本是毫秒级。**用一点点 CPU 换掉一整类偶发 bug。**
   */
  async load() {
    return this.replay(this.getRootDir())
  }

  /** 强制重放日志（面板的"重建索引"和写操作前的自愈都走这里）。 */
  async replay(root = this.getRootDir()) {
    this.byId.clear()
    this.byKey.clear()
    this.loadedRoot = root

    try {
      await mkdir(this.dir(), { recursive: true })
      const { records, badLines } = await readNdjson(this.logFile())
      this.badLines = badLines
      let applied = 0
      for (const op of records) {
        if (applyOp(this, op)) applied += 1
      }
      this.loaded = true
      this.loadedStamp = await this.stampOfLog()
      this.lastError = badLines > 0 ? `洞察日志有 ${badLines} 行无法解析（已跳过）` : ''
      this.logger?.info?.(`[dsh-evolution] 洞察库加载完成：${this.byId.size} 条（重放 ${applied} 次操作）`)
    } catch (error) {
      this.loaded = true
      this.lastError = `读取洞察库失败：${error?.message ?? String(error)}`
      this.logger?.warn?.(`[dsh-evolution] ${this.lastError}`)
    }
    return this
  }

  /** 日志文件的指纹（size + mtime），用于变更检测。 */
  async stampOfLog() {
    try {
      const st = await stat(this.logFile())
      return `${st.size}:${Math.trunc(st.mtimeMs)}`
    } catch {
      return ''
    }
  }

  /** 追加一行操作日志（不落索引，索引由 saveIndex 单独写）。 */
  async appendOp(op) {
    const line = `${JSON.stringify({ v: INSIGHTS_LOG_VERSION, ...op })}\n`
    const file = this.logFile()
    await mkdir(dirname(file), { recursive: true })
    // 追加写：崩溃最多丢最后一行，而不会损坏前面所有历史
    await appendFile(file, line, 'utf8')
    this.appended += 1
  }

  /**
   * 写派生索引快照（原子写）。
   * 索引**不是真相源**：写失败只记错误，不影响功能（下次加载重放日志即可）。
   */
  async saveIndex() {
    try {
      await writeJsonAtomic(this.indexFile(), {
        version: INSIGHTS_LOG_VERSION,
        updatedAt: new Date().toISOString(),
        count: this.byId.size,
        insights: [...this.byId.values()],
      })
      return true
    } catch (error) {
      this.lastError = `写洞察索引失败（不影响数据，下次会从日志重建）：${error?.message ?? String(error)}`
      this.logger?.warn?.(`[dsh-evolution] ${this.lastError}`)
      return false
    }
  }

  /**
   * 找一条"同类型、同作用域、标题高度相似"的已有洞察（用于兜底合并）。
   *
   * 只在 dedupeKey 未命中时调用，所以是低频路径；条目数是"人写下的经验"量级，
   * 线性扫描完全够用。命中条件刻意严格（同 type + 同 scope + 相似度 ≥ 门槛），
   * 宁可多留一条，也不要合并两条不同的结论。
   */
  findSimilar(candidate) {
    const mine = textSkeleton(candidate.title)
    // 骨架太短的（"来自 A 会话的事实"这类）一律不参与兜底合并：区分度太低，
    // 二元组重合度会被虚词拉得很高，合并等于制造假复现。
    if ([...mine].length < 10) return undefined
    const myNumbers = numbersOf(candidate.title)
    let best
    let bestScore = 0
    for (const item of this.byId.values()) {
      if (item.archived === true) continue
      if (item.type !== candidate.type) continue
      if (str(item.scope) !== str(candidate.scope)) continue
      if (str(item.repo) !== str(candidate.repo)) continue
      // 仓库根不同 → 一定不是同一个仓库的经验，相似度再高也不合并
      //（两个 `api/` 仓库的标题可能写得一模一样）
      if (str(item.repoRoot) !== '' && str(candidate.repoRoot) !== ''
        && !sameRepoRootPath(item.repoRoot, candidate.repoRoot)) continue
      /**
       * 三道闸门，任何一道不过就不合并：
       *   1. **括号内容一致**（文件名/路径/参数最容易在这里露出来）
       *   2. **数字一致**（编号/端口/数量/版本）
       *   3. 相似度或包含关系达到门槛
       *
       * 只看相似度是不够的：中文里"来自 A 会话的事实"与"来自 B 会话的事实"
       * 的二元组重合度能到 0.75 —— 只按相似度合并会把两条**不同**的结论合成一条，
       * 而复现次数一旦被虚假抬高，后续自动晋升就会把噪音当信号。
       */
      // 括号里的内容不同 → 不是同一条（文件名/路径/参数最容易在这里露出来）
      if (!sameMarkers(item.title, candidate.title)) continue
      // 数字不同 → 不是同一条（编号/端口/数量/版本）
      const theirNumbers = numbersOf(item.title)
      if (myNumbers !== '' && theirNumbers !== '' && myNumbers !== theirNumbers) continue
      const theirs = textSkeleton(item.title)
      const score = titleSimilarity(mine, theirs)
      // 两条通路，取其中更强的那个：
      //   A. **包含关系**：一条是另一条的完整主干（"X" vs "X 再打包"）—— 最可信
      //   B. **高相似度**：措辞不同但骨架几乎一样（门槛刻意高，见常量注释）
      const contained = mine.includes(theirs) || theirs.includes(mine)
      const effective = contained && score >= CONTAINMENT_MERGE_THRESHOLD
        ? Math.max(score, CONTAINMENT_MERGE_THRESHOLD + 0.01)
        : score
      if (effective > bestScore) { bestScore = effective; best = item }
    }
    return bestScore >= SIMILARITY_MERGE_THRESHOLD && best !== undefined ? best.id : undefined
  }

  /** 全部未归档洞察（含已归档用 all=true）。永远返回副本，调用方改了不影响库。 */
  list(options = {}) {
    const includeArchived = options.includeArchived === true
    const out = []
    for (const item of this.byId.values()) {
      if (!includeArchived && item.archived === true) continue
      out.push({ ...item, evidence: [...item.evidence] })
    }
    return out
  }

  get(id) {
    const item = this.byId.get(str(id))
    return item === undefined ? undefined : { ...item, evidence: [...item.evidence] }
  }

  /**
   * 写入一批"新观察"。返回 `{ added, merged, rejected }`。
   *
   * 去重合并是这里的核心：同一个坑第 N 次出现时，`recurrence` 加一、
   * 证据链追加。**复现次数（recurrence）是这个项目的一等字段**（DESIGN §一），
   * 没有它，"进化"就退化成"又一个笔记 App"。
   */
  async upsert(insights, options = {}) {
    return this.enqueue(async () => {
      await this.load()
      const added = []
      const merged = []
      for (const raw of Array.isArray(insights) ? insights : []) {
        if (raw === undefined || raw === null) continue
        const next = makeInsight(raw)
        if (next.title === '') continue
        // repo 作用域没有归属仓库：降级为 session 作用域，避免污染所有仓库
        if (next.scope === SCOPES.repo && next.repo === '') next.scope = SCOPES.session
        let existingId = this.findMergeableByKey(next.key, next)
        // 精确键没命中时再做一次相似度匹配：模型复述同一条经验时措辞会变，
        // 只靠归一化标题会把它们留成两条 recurrence=1，而复现次数正是本项目的信号。
        if (existingId === undefined) existingId = this.findSimilar(next)
        let existing = existingId === undefined ? undefined : this.byId.get(existingId)
        /**
         * 双保险：相似度兜底命中的条目若归属另一个同名仓库，同样不能合并 ——
         * 合并会把 A 仓库的复现次数记到 B 仓库头上，而复现次数是自动晋升的依据。
         * 此时当作新条目入库。
         */
        if (existing !== undefined && conflictsRepo(existing, next)) existing = undefined

        if (existing === undefined) {
          this.byId.set(next.id, next)
          this.indexKey(next.key, next.id)
          await this.appendOp({ op: 'add', at: Date.now(), insight: next })
          added.push({ ...next, evidence: [...next.evidence] })
          continue
        }

        // ---- 合并：复现次数 +1，证据链归并，其余字段取"更好的那个" ----
        const updated = {
          ...existing,
          recurrence: existing.recurrence + 1,
          lastSeenAt: Date.now(),
          updatedAt: Date.now(),
          // 标题/正文取更长的：模型第二次往往说得更完整（但也可能更啰嗦，所以有上限）
          title: [...next.title].length > [...existing.title].length ? next.title : existing.title,
          detail: [...next.detail].length > [...existing.detail].length ? next.detail : existing.detail,
          // 老条目可能还没有 repoRoot（升级前入库的）：合并时补上，让归属比对走路径
          repoRoot: str(existing.repoRoot) || str(next.repoRoot),
          // 人工状态永不被自动流程覆盖（这是"只归档不删除"同一条纪律的延伸）
          pinned: existing.pinned,
          accepted: existing.accepted,
          archived: existing.archived,
          // 类型升级：fact → constraint 之类只在"更重"时允许自动发生
          type: TYPE_WEIGHT[next.type] > TYPE_WEIGHT[existing.type] ? next.type : existing.type,
          priority: Math.max(existing.priority, next.priority),
          confidence: Math.max(existing.confidence, next.confidence),
          evidence: mergeEvidence(existing.evidence, next.evidence),
          flags: [...new Set([...(existing.flags ?? []), ...(next.flags ?? [])])],
        }
        this.byId.set(updated.id, updated)
        await this.appendOp({
          op: 'merge',
          at: Date.now(),
          id: updated.id,
          recurrence: updated.recurrence,
          evidence: next.evidence,
          reason: str(options.reason) || 'recurrence',
        })
        merged.push({ ...updated, evidence: [...updated.evidence] })
      }
      await this.saveIndex()
      return { added, merged, rejected: [] }
    })
  }

  /**
   * 导入一批条目（导出 JSON 里 `insights` 数组的原样内容）。
   *
   * 语义是**恢复**，不是"再来一次观察"：按 id 插入-或-跳过，字段（recurrence、
   * evidence、时间戳、人工状态）**原样保留** —— 与 upsert 的"合并 = 复现 +1"
   * 刻意不同。这样重复导入同一份导出文件是零副作用的，不会把复现次数越导越高。
   * 手动合并两条"同一件事"的条目仍然留给面板（merge），那是人的判断。
   *
   * 入参约定：调用方先用 `parseImportBundle` 校验过形状（必须有 id 与标题）。
   * 这里保留防御：缺 id / 缺标题的条目计入 skipped，绝不静默丢弃也不抛。
   */
  async importEntries(entries, options = {}) {
    return this.enqueue(async () => {
      await this.load()
      const added = []
      let skipped = 0
      let unattributed = 0
      for (const raw of Array.isArray(entries) ? entries : []) {
        if (!raw || typeof raw !== 'object') { skipped += 1; continue }
        const item = makeInsight(raw)
        if (str(raw.id) === '' || item.title === '') { skipped += 1; continue }
        if (this.byId.has(item.id)) { skipped += 1; continue }
        // 与 upsert 不同，恢复不降级作用域（原样保真，导出→导入→导出必须稳定）。
        // 但"repo 作用域、归属双空"的条目永远不会被注入（检索按仓库匹配不到），
        // 所以把数量报给调用方，让面板/日志有机会解释"为什么有条目从来不注入"。
        if (item.scope === SCOPES.repo && str(item.repo) === '' && str(item.repoRoot) === '') unattributed += 1
        this.byId.set(item.id, item)
        this.indexKey(item.key, item.id)
        await this.appendOp({
          op: 'add',
          at: Date.now(),
          insight: item,
          reason: str(options.reason) || 'import',
        })
        added.push({ ...item, evidence: [...item.evidence] })
      }
      if (added.length > 0) await this.saveIndex()
      return { added, skipped, unattributed }
    })
  }

  /** 应用一次人工操作（置顶/采纳/归档/改作用域/删除）。 */
  async mutate(id, patch, options = {}) {    return this.enqueue(async () => {
      await this.load()
      const key = str(id)
      const existing = this.byId.get(key)
      if (existing === undefined) return undefined

      if (patch?.deleted === true) {
        this.byId.delete(key)
        this.unindexKey(existing.key, key)
        await this.appendOp({ op: 'delete', at: Date.now(), id: key, reason: str(options.reason) || 'user' })
        await this.saveIndex()
        return { ...existing, deleted: true }
      }

      const next = { ...existing, updatedAt: Date.now() }
      if (patch?.pinned !== undefined) next.pinned = patch.pinned === true
      if (patch?.accepted !== undefined) next.accepted = patch.accepted === true
      if (patch?.archived !== undefined) next.archived = patch.archived === true
      if (patch?.priority !== undefined) next.priority = clampPriority(patch.priority)
      if (patch?.title !== undefined) next.title = clipText(patch.title, MAX_TITLE_CHARS)
      if (patch?.detail !== undefined) next.detail = clipText(patch.detail, MAX_DETAIL_CHARS)
      if (patch?.type !== undefined && Object.values(INSIGHT_TYPES).includes(str(patch.type))) next.type = str(patch.type)
      if (patch?.scope !== undefined && Object.values(SCOPES).includes(str(patch.scope))) next.scope = str(patch.scope)
      if (patch?.repo !== undefined) next.repo = str(patch.repo)
      if (patch?.repoRoot !== undefined) next.repoRoot = str(patch.repoRoot)
      // 离开 repo 作用域时清仓库名并记来源；回到 repo 作用域时清来源记录。
      // repoRoot 与 repo 完全对称：晋升时必须一起清（否则残留的路径会让条目
      // 在退回后匹配到错误的仓库），退回时从来源记录里恢复。
      if (patch?.scope !== undefined && next.scope !== str(existing.scope)) {
        if (next.scope === SCOPES.repo) {
          // 同 migrate()：回到 repo 作用域要恢复归属，否则这条会从所有仓库里消失
          next.repo = str(next.repo) || str(existing.repo) || str(existing.promotedFrom?.from?.repo)
          next.repoRoot = str(next.repoRoot) || str(existing.repoRoot) || str(existing.promotedFrom?.from?.repoRoot)
          next.promotedFrom = undefined
        } else {
          next.promotedFrom = {
            at: Date.now(),
            from: {
              scope: existing.scope,
              ...(str(existing.repo) === '' ? {} : { repo: str(existing.repo) }),
              ...(str(existing.repoRoot) === '' ? {} : { repoRoot: str(existing.repoRoot) }),
            },
          }
          next.repo = ''
          next.repoRoot = ''
        }
      }

      this.byId.set(key, next)
      await this.appendOp({
        op: 'patch',
        at: Date.now(),
        id: key,
        patch: {
          pinned: next.pinned,
          accepted: next.accepted,
          archived: next.archived,
          priority: next.priority,
          title: next.title,
          detail: next.detail,
          type: next.type,
          scope: next.scope,
          repo: next.repo,
          repoRoot: next.repoRoot,
          promotedFrom: next.promotedFrom ?? null,
        },
        reason: str(options.reason) || 'user',
      })
      await this.saveIndex()
      return { ...next, evidence: [...next.evidence] }
    })
  }

  /**
   * 手动合并：把 `fromId` 的证据链与复现次数并入 `toId`，然后删除 `fromId`。
   *
   * 为什么必须提供手动合并：自动相似度合并一定会漏（同一条经验被模型用
   * "约束"和"事实"两种框架各说一遍时，措辞可能完全不同）。而库里堆着两条
   * 说的是同一件事的条目，会让注入预算被重复内容吃掉 —— 这个问题只有人能判。
   */
  async merge(fromId, toId, options = {}) {
    return this.enqueue(async () => {
      await this.load()
      const from = this.byId.get(str(fromId))
      const to = this.byId.get(str(toId))
      if (from === undefined || to === undefined || from.id === to.id) return undefined

      const merged = {
        ...to,
        recurrence: to.recurrence + from.recurrence,
        evidence: mergeEvidence(to.evidence, from.evidence),
        title: [...from.title].length > [...to.title].length ? from.title : to.title,
        detail: [...from.detail].length > [...to.detail].length ? from.detail : to.detail,
        confidence: Math.max(to.confidence, from.confidence),
        priority: Math.max(to.priority, from.priority),
        pinned: to.pinned || from.pinned,
        accepted: to.accepted || from.accepted,
        flags: [...new Set([...(to.flags ?? []), ...(from.flags ?? [])])],
        updatedAt: Date.now(),
      }
      this.byId.set(to.id, merged)
      this.byId.delete(from.id)
      this.unindexKey(from.key, from.id)
      await this.appendOp({
        op: 'merge-into',
        at: Date.now(),
        from: from.id,
        into: to.id,
        recurrence: merged.recurrence,
        reason: str(options.reason) || 'manual-merge',
      })
      await this.saveIndex()
      return { ...merged, evidence: [...merged.evidence] }
    })
  }

  /**
   * 改作用域（晋升 / 退回）。
   *
   * 什么时候需要它：一条"只在这个仓库成立"的经验，如果用户认为它对**所有**仓库
   * 都成立，就该升到 `person`（个人提醒，跨仓库注入）。反过来，一条个人提醒
   * 落到具体仓库时用同一个操作退回。
   *
   * **刻意不新建副本**：改作用域是"移动"而不是"复制"。复制会让同一条经验
   * 在两个段里各注入一次，既浪费预算，又让"复现次数"这种统计口径变得含糊。
   * 来源信息记在 `promotedFrom` 里，所以这一步是可逆的。
   *
   * ⚠️ `team` 作用域**不会**由任何自动流程写入（DESIGN §4.2：跨人的规范只能由人
   * 显式操作），这里只提供通道，且面板上会写明"这条会进入团队规范段"。
   */
  async migrate(id, toScope, options = {}) {
    return this.enqueue(async () => {
      await this.load()
      const scope = str(toScope)
      if (!Object.values(SCOPES).includes(scope)) return undefined
      const item = this.byId.get(str(id))
      if (item === undefined) return undefined
      if (item.scope === scope) return { ...item, evidence: [...item.evidence] }

      const from = {
        scope: item.scope,
        ...(str(item.repo) === '' ? {} : { repo: str(item.repo) }),
        ...(str(item.repoRoot) === '' ? {} : { repoRoot: str(item.repoRoot) }),
      }
      /**
       * ⚠️ 回到 repo 作用域时，仓库归属要**从 promotedFrom 恢复**。
       * 晋升时把 repo 清空了（否则会被误判归属），退回时如果只写回空串，
       * 这条就会变成"没有归属的 repo 条目"→ 注入过滤器按仓库名匹配不到它 →
       * 它从**所有**仓库里静默消失。真机验证时踩到过：晋升再退回，条目就"丢了"。
       * 真恢复不出来（没有来源记录）时保持为空，那是有意的保守行为。
       * repoRoot 与 repo 对称处理：离开时清空、回来时恢复，两边必须一起动 ——
       * 只清一个会造成"名字指向 A、路径指向 B"的自相矛盾条目。
       */
      const restoredRepo = scope === SCOPES.repo
        ? (str(item.repo) || str(item.promotedFrom?.from?.repo))
        : ''
      const restoredRoot = scope === SCOPES.repo
        ? (str(item.repoRoot) || str(item.promotedFrom?.from?.repoRoot))
        : ''
      const next = {
        ...item,
        scope,
        // repo 作用域必须有归属；离开 repo 作用域时清空，避免残留的仓库名让人误判
        repo: restoredRepo,
        repoRoot: restoredRoot,
        promotedFrom: scope === SCOPES.repo ? undefined : { at: Date.now(), from },
        archived: false,
        updatedAt: Date.now(),
      }
      this.byId.set(next.id, next)
      await this.appendOp({
        op: 'patch',
        at: Date.now(),
        id: next.id,
        patch: { scope: next.scope, repo: next.repo, repoRoot: next.repoRoot, promotedFrom: next.promotedFrom ?? null, archived: false },
        reason: str(options.reason) || 'scope-change',
      })
      await this.saveIndex()
      return { ...next, evidence: [...next.evidence] }
    })
  }

  /**
   * 谁够格被晋升为"个人提醒"（跨仓库注入）。
   *
   * 只做**筛选**，不做晋升 —— DESIGN 决策 5 明确要求"跨工作区聚合默认关"，
   * 所以这条路径永远是"人点一下才发生"。这里返回候选 + 不满足的原因，
   * 面板照原样展示，用户自己判断。
   *
   * @param options.minRecurrence - 最低复现次数（来自配置）。
   * @param options.excludePerson - 是否排除已经是 person 作用域的（默认排除）。
   */
  promotionCandidates(options = {}) {
    const minRecurrence = Math.max(1, Number(options.minRecurrence ?? 2))
    const eligible = []
    const skipped = []
    for (const item of this.byId.values()) {
      if (item.archived === true) {
        skipped.push({ id: item.id, title: item.title, reason: '已归档' })
        continue
      }
      if (item.scope === SCOPES.person) continue
      if (item.scope === SCOPES.team) continue // 已经是更大的作用域
      const reasons = []
      if (Number(item.recurrence ?? 1) < minRecurrence) {
        reasons.push(`只在 ${item.recurrence ?? 1} 次会话里出现过（门槛 ${minRecurrence} 次）`)
      }
      /**
       * 被降级过的条目（环境类问题、会话内已自愈的瞬时错误）不做个人晋升：
       * 那类结论换个仓库/换台机器就不成立，正是"适用范围过宽"最典型的翻车方式。
       */
      if ((item.flags ?? []).some((f) => f === 'environment-failure' || f === 'transient-self-healed' || f === 'one-off-narrative')) {
        reasons.push('曾被标注为环境类/瞬时/一次性问题，不适合跨仓库')
      }
      if (reasons.length > 0) skipped.push({ id: item.id, title: item.title, reason: reasons.join('；') })
      else eligible.push({ ...item, evidence: [...item.evidence] })
    }
    const weight = (i) => Number(i.recurrence ?? 1) * 10 + (i.accepted === true ? 5 : 0) + (i.pinned === true ? 5 : 0)
    return {
      eligible: eligible.sort((a, b) => weight(b) - weight(a)),
      skipped,
      minRecurrence,
    }
  }

  /**
   * 记录"这些条目被注入过一次"。批量计数，避免每条一次写盘。
   * 这只是统计，失败不影响注入 —— 所以走队列但不阻塞调用方。
   */
  async noteInjected(ids) {
    const list = (Array.isArray(ids) ? ids : []).map(str).filter((s) => s !== '')
    if (list.length === 0) return
    return this.enqueue(async () => {
      await this.load()
      let changed = 0
      for (const id of list) {
        const item = this.byId.get(id)
        if (item === undefined) continue
        item.injectedCount += 1
        item.lastInjectedAt = Date.now()
        changed += 1
      }
      if (changed === 0) return
      await this.appendOp({ op: 'injected', at: Date.now(), ids: list })
      // 注入计数不写索引：它变化最频繁，而丢了也只是统计偏差
    })
  }

  /** 删除某来源会话产出的全部洞察（用户删会话数据时用）。 */
  async removeBySessions(sessionIds) {
    const set = new Set((Array.isArray(sessionIds) ? sessionIds : []).map(str))
    return this.enqueue(async () => {
      await this.load()
      const victims = []
      for (const item of this.byId.values()) {
        const hit = set.has(str(item.originSessionId))
          || (item.evidence ?? []).some((ev) => set.has(str(ev.sessionId)))
        if (hit) victims.push(item.id)
      }
      for (const id of victims) {
        const item = this.byId.get(id)
        if (item === undefined) continue
        this.byId.delete(id)
        this.unindexKey(item.key, id)
        await this.appendOp({ op: 'delete', at: Date.now(), id, reason: 'source-session-removed' })
      }
      if (victims.length > 0) await this.saveIndex()
      return victims
    })
  }

  /** 清空全部洞察（面板"清空洞察"按钮）。日志会被轮转留档，不是静默删除。 */
  async clearAll(options = {}) {
    return this.enqueue(async () => {
      await this.load()
      const count = this.byId.size
      this.byId.clear()
      this.byKey.clear()
      const archivedTo = str(options.archiveTo)
      if (archivedTo !== '') {
        // 先把当前日志整份复制到留档路径，再记一条 clear 操作 ——
        // 用户点"清空"时想要的是"看不见了"，而不是"不可恢复了"。
        try {
          const raw = await readFile(this.logFile(), 'utf8')
          await mkdir(dirname(archivedTo), { recursive: true })
          await writeFile(archivedTo, raw, 'utf8')
        } catch (error) {
          this.lastError = `留档失败（未清空）：${error?.message ?? String(error)}`
          throw error
        }
      }
      await this.appendOp({ op: 'clear', at: Date.now(), count, archivedTo })
      await this.saveIndex()
      return { removed: count, archivedTo }
    })
  }

  /** 统计（面板"总览"用，不读全量记录）。 */
  stats() {
    let active = 0
    let archived = 0
    let pinned = 0
    let accepted = 0
    let withEvidence = 0
    let recurred = 0
    const byScope = {}
    const byType = {}
    for (const item of this.byId.values()) {
      if (item.archived === true) archived += 1
      else active += 1
      if (item.pinned) pinned += 1
      if (item.accepted) accepted += 1
      if ((item.evidence ?? []).length > 0) withEvidence += 1
      if (item.recurrence > 1) recurred += 1
      byScope[item.scope] = (byScope[item.scope] ?? 0) + 1
      byType[item.type] = (byType[item.type] ?? 0) + 1
    }
    return {
      total: this.byId.size,
      active,
      archived,
      pinned,
      accepted,
      withEvidence,
      recurred,
      byScope,
      byType,
      badLines: this.badLines,
      lastError: this.lastError,
      logFile: this.logFile(),
      backfilled: this.backfill,
      appended: this.appended,
    }
  }

  /** 重建索引快照（面板"重建索引"按钮；数据不动，只重算派生文件）。 */
  async rebuildIndex() {
    return this.enqueue(async () => {
      await this.replay()
      await this.saveIndex()
      return this.stats()
    })
  }

  /** 释放资源（存储契约方法）。文件实现没有需要释放的句柄，空操作。 */
  dispose() {}
}

/**
 * 重放一条操作到内存索引。返回 true 表示这条操作被认出来了。
 *
 * 未知 op 一律忽略（**向前兼容**）：新版本写的日志被老版本读到，
 * 应该是"少认几条"，而不是整个库加载失败。
 */
export function applyOp(store, op) {
  if (!op || typeof op !== 'object') return false
  switch (str(op.op)) {
    case 'add': {
      const item = makeInsight(op.insight ?? {})
      if (item.id === '') return false
      store.byId.set(item.id, item)
      keyIndexAdd(store.byKey, item.key, item.id)
      return true
    }
    case 'merge': {
      const id = str(op.id)
      const item = store.byId.get(id)
      if (item === undefined) return false
      item.recurrence = Math.max(item.recurrence, Math.trunc(Number(op.recurrence ?? item.recurrence) || 1))
      item.lastSeenAt = typeof op.at === 'number' ? op.at : item.lastSeenAt
      const ev = Array.isArray(op.evidence) ? op.evidence.map(normalizeEvidence).filter(Boolean) : []
      item.evidence = mergeEvidence(item.evidence, ev)
      return true
    }
    case 'patch': {
      const id = str(op.id)
      const item = store.byId.get(id)
      if (item === undefined) return false
      const p = op.patch ?? {}
      for (const key of ['pinned', 'accepted', 'archived']) {
        if (p[key] !== undefined) item[key] = p[key] === true
      }
      if (p.priority !== undefined) item.priority = clampPriority(p.priority)
      if (p.title !== undefined) item.title = clipText(p.title, MAX_TITLE_CHARS)
      if (p.detail !== undefined) item.detail = clipText(p.detail, MAX_DETAIL_CHARS)
      if (p.type !== undefined && Object.values(INSIGHT_TYPES).includes(str(p.type))) item.type = str(p.type)
      if (p.scope !== undefined && Object.values(SCOPES).includes(str(p.scope))) item.scope = str(p.scope)
      if (p.repo !== undefined) item.repo = str(p.repo)
      if (p.repoRoot !== undefined) item.repoRoot = str(p.repoRoot)
      if (p.promotedFrom !== undefined) item.promotedFrom = normalizePromotedFrom(p.promotedFrom)
      if (typeof op.at === 'number') item.updatedAt = op.at
      return true
    }
    case 'injected': {
      const ids = Array.isArray(op.ids) ? op.ids : []
      let hit = false
      for (const id of ids) {
        const item = store.byId.get(str(id))
        if (item === undefined) continue
        item.injectedCount += 1
        item.lastInjectedAt = typeof op.at === 'number' ? op.at : Date.now()
        hit = true
      }
      return hit
    }
    case 'merge-into': {
      const fromId = str(op.from)
      const toId = str(op.into)
      const from = store.byId.get(fromId)
      const to = store.byId.get(toId)
      if (from === undefined || to === undefined) return false
      to.recurrence = to.recurrence + from.recurrence
      to.evidence = mergeEvidence(to.evidence, from.evidence)
      to.title = [...from.title].length > [...to.title].length ? from.title : to.title
      to.detail = [...from.detail].length > [...to.detail].length ? from.detail : to.detail
      to.confidence = Math.max(to.confidence, from.confidence)
      to.priority = Math.max(to.priority, from.priority)
      to.pinned = to.pinned || from.pinned
      to.accepted = to.accepted || from.accepted
      to.flags = [...new Set([...(to.flags ?? []), ...(from.flags ?? [])])]
      store.byId.delete(fromId)
      keyIndexRemove(store.byKey, from.key, fromId)
      return true
    }
    case 'delete': {
      const id = str(op.id)
      const item = store.byId.get(id)
      if (item === undefined) return false
      store.byId.delete(id)
      keyIndexRemove(store.byKey, item.key, id)
      return true
    }
    case 'clear':
      store.backfill = { at: typeof op.at === 'number' ? op.at : Date.now(), count: op.count ?? 0 }
      store.byId.clear()
      store.byKey.clear()
      return true
    default:
      return false
  }
}

/** 供测试：把日志轮转留档的路径拼出来。 */
export function archivePath(root, stamp = new Date()) {
  const iso = stamp.toISOString().replace(/[:.]/g, '-')
  return join(insightsDir(root), `insights.cleared.${iso}.ndjson`)
}
