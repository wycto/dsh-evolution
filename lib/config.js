/**
 * dsh-evolution — 配置模型
 *
 * 设计要点（为什么不是随手一个对象）：
 *
 * 1. **默认值最保守**。装完即用的部分（采集账本）默认开；任何"往外走"的行为
 *    （写用户仓库、上传、向量化、跨工作区聚合）默认**全关**。用户的第一次体验
 *    必须是"它只在我自己电脑上"，而不是"我得先去关掉一堆东西"。
 *
 * 2. **配置本身是纯 JSON 文件**（`~/.dsh-evolution/config.json`），不走宿主的
 *    settings 命名空间。理由：通用版的核心承诺是"数据可携、可读、可搬走"，
 *    配置和数据放在同一个目录里，用户 `cp -r` 一次就完成迁移；同时这避免了
 *    对宿主 settings 服务的硬依赖（不同 DSH 版本/组合下它不一定在）。
 *
 * 3. **每个字段都带 label/hint**（见 SCHEMA_FIELDS）。面板是纯数据驱动渲染的，
 *    加一个配置项只需要在这里加一条 —— 面板代码不用动。
 */
import { DEFAULT_DIR_NAME, ENV_HOME, str } from './paths.js'

/** 配置版本。将来结构变了靠它做迁移；先留着，不然后面无从判断"这份配置是哪一代的"。 */
export const CONFIG_VERSION = 1

/** skill 落点的可选值 —— 面板上做成下拉，避免用户手打错路径。 */
export const SKILL_TARGETS = Object.freeze({
  /** DSH 最高优先级的项目根，随仓库走，团队天然共享。 */
  projectDsh: 'project-dsh',
  /** DSH 默认的项目根之一，随仓库走。 */
  projectAgents: 'project-agents',
  /** 只在本机，不进任何仓库 —— 最保守的默认。 */
  pluginLocal: 'plugin-local',
  /** 用户自定义绝对/相对路径。 */
  custom: 'custom',
})

/** skill 落点的实际相对路径（plugin-local 是相对数据根，其余相对仓库根）。 */
export const SKILL_TARGET_PATHS = Object.freeze({
  [SKILL_TARGETS.projectDsh]: '.dsh/skills',
  [SKILL_TARGETS.projectAgents]: '.agents/skills',
  [SKILL_TARGETS.pluginLocal]: 'skills',
})

/**
 * 完整默认配置。**任何新增字段都必须在这里给出默认值** ——
 * 老用户的 config.json 里没有这个键时，normalize 会补上，不需要用户手动迁移。
 */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,

    /** 数据目录；空串 = 用默认（$DSH_EVOLUTION_HOME 或 ~/.dsh-evolution）。 */
    dataDir: '',

    /** 总开关。关掉后：不采集、不复盘、不注入，面板只读展示已有数据。 */
    enabled: true,

    ledger: {
      /** 是否采集会话账本。这是唯一默认开的能力，因为纯本地、零成本。 */
      enabled: true,
      /** 是否在启动时回扫历史会话。首次装上想知道"过去都干了啥"时很有用。 */
      scanHistoryOnStart: true,
      /** 只扫最近 N 天的历史会话（0 = 不限）。防止首次安装时扫爆几十年历史。 */
      historyDays: 30,
      /** 单条消息文本的截断长度，防止一条巨型输出吃掉整个预算。 */
      maxCharsPerMessage: 1200,
      /** 单个会话摘要的截断长度上限（超出保留最近轮次）。 */
      maxCharsPerSession: 8000,
      /** 是否采集工具调用信息（工具名 + 是否失败）。不采集参数与输出。 */
      collectToolSignals: true,
      /**
       * 单个会话最多参与复盘/试跑的账本记录条数（从最新往回取）。
       *
       * 为什么要有这个上限：超长会话（几百轮）的记录量可以到几万条，
       * 一次性读进内存再折叠成摘要，既慢又占内存；而摘要本身有字数上限，
       * 读一万条和读五千条折叠出来的结果几乎一样。上限保证"最坏情况可控"。
       */
      maxRecordsPerSession: 5000,
      /**
       * 账本分片保留天数（0 = 永久保留，默认）。超过 N 天的整天分片在
       * 插件启动时删除 —— 这是本插件唯一一个会删数据的开关，所以默认关。
       * 账本按天分片、只追加，没有保留期的话会随使用无限增长。
       */
      retentionDays: 0,
    },

    review: {
      /** 是否开启自动复盘。**会消耗用户自己的模型额度**，所以面板必须显式提示。 */
      enabled: false,
      /**
       * 复盘用哪个 provider / model —— **两者都空 = 不复盘**。
       *
       * 曾经这里是"留空就复用你当前会话的模型"，现已删除：后台功能悄悄用用户
       * 正在用的（往往是最贵的）模型，等于为一个用户没同意的模型付费，而且这个
       * 金额随用户在 DSH 里随手切模型而漂移，既不可控也不可复现。
       * 现在**花钱必须显式**：面板「复盘用哪个模型」选一个，不选就一次都不调。
       * 只填一半（provider 有 model 没有，或反过来）同样按"没配"处理 —— 宁可不做，
       * 也不拿半截配置去猜模型名。
       */
      provider: '',
      model: '',
      /** 攒够多少轮才做一次单会话抽取（逐轮复盘成本是 N 倍且看不到"反复出现"）。 */
      extractAfterTurns: 10,
      /** 会话静默多久才触发（毫秒）。避开"用户还在打字"的时刻。 */
      idleDebounceMs: 60000,
      /**
       * 仓库级 / 个人级复盘（Phase 2/3）的门槛参数**故意不在这里**：
       * 功能没实现就先把配置项摆出来，用户打开面板会看到一个改了没反应的开关 ——
       * 那比"暂时没有这个功能"更糟。等功能真做了再加字段（老配置不受影响，
       * normalize 会补默认值）。
       */
      /**
       * 每日 token 预算上限（0 = 不限）。超了当天暂停并提示。
       *
       * **默认不是 0（不限），而是 200k**：这是一个"防止账单失控"的刹车，
       * 而不是"限制你用"的配额。按实测的一次复盘约 4.5k token 算，200k 够跑四十多次；
       * 真撞到它说明当天发生了异常（比如在几十个仓库里反复自动复盘），
       * 那时候**停下来并告诉用户**比继续烧钱正确。
       * 这个默认值只在自动复盘开关打开后才有意义（开关默认关着）。
       */
      dailyTokenBudget: 200000,
      /** 暂停至（ISO 时间串或空）。用户点"暂停 24 小时"时写入。 */
      pauseUntil: '',
      /**
       * 一次复盘最多接受几条洞察。上限是**质量阀门**：
       * 让模型产出 20 条"看起来都对"的废话，比产出 3 条真的有用更糟 ——
       * 前者会挤满注入预算，让真正重要的那一条进不去。
       */
      maxInsightsPerRun: 5,
      /**
       * 同一个会话被复盘过之后，至少要新增多少条账本记录才允许再跑一次。
       * 防止用户连点「现在复盘」把同一份摘要反复喂给模型（既浪费钱又只会刷出重复条目）。
       */
      minNewRecordsPerRun: 20,
      /**
       * 单次调用的超时（毫秒）。模型卡住时必须能自己放弃，
       * 否则一个挂起的请求会让"正在复盘"永远转下去。
       */
      timeoutMs: 120000,
      /** 是否把本轮复盘花掉的 token 计入每日预算。关掉只影响统计，不影响调用。 */
      countUsageAgainstBudget: true,
    },

    /** 脱敏：白名单式，先"只留什么"，再"去掉什么"。 */
    privacy: {
      /** 是否对文本做脱敏。默认开 —— 宁可少记，也不要误记。 */
      redact: true,
      /** 是否移除绝对路径（只保留仓库内相对路径）。 */
      stripAbsolutePaths: true,
      /** 是否移除看起来像密钥/token 的字符串。 */
      stripSecrets: true,
      /** 用户自定义的敏感词表（命中即整段替换为 ●）。 */
      customWords: [],
    },

    /** 本地 skill 落点。 */
    skills: {
      /** 默认只落插件自己的目录：不碰用户仓库、不需要任何 DSH 配置改动。 */
      target: SKILL_TARGETS.pluginLocal,
      /** target = custom 时使用。 */
      customPath: '',
      /** 写到仓库目录前是否需要确认（默认需要）。 */
      confirmBeforeRepoWrite: true,
    },

    /** 接口对接（可选）。默认关，且只定义契约，插件不提供也不托管任何服务。 */
    api: {
      enabled: false,
      baseUrl: '',
      /** token 从环境变量读，避免明文落在配置文件里。 */
      tokenEnv: 'DSH_EVOLUTION_TOKEN',
      /** off = 完全不上传；redacted = 只传脱敏后的摘要。 */
      uploadMode: 'off',
      timeoutMs: 15000,
      /**
       * 把存储整体搬到远端（`docs/API-CONTRACT.md` 的存储后端形态，DESIGN 决策 8）。
       * ⚠️ 与 uploadMode 是两回事：这个开关开启后，账本与洞察的**每一条读写**
       * 都走 baseUrl —— 等于把本机数据交给那台服务。默认关，且要求
       * enabled + baseUrl 同时就位才生效；初始化失败回退本地文件并显式告警。
       */
      storageBackend: false,
    },

    /** 数据库对接（可选）。默认关。 */
    database: {
      enabled: false,
      /** sqlite = 本地文件（node:sqlite 内置，零依赖）；postgres = 用户自备。 */
      driver: 'sqlite',
      /** sqlite 时的文件路径；空 = <dataDir>/index.sqlite */
      sqlitePath: '',
      /** postgres 时的连接串。**建议用环境变量**，别把密码写进配置文件。 */
      urlEnv: 'DSH_EVOLUTION_DATABASE_URL',
      /** 表名前缀，避免和用户已有表冲突。 */
      tablePrefix: 'dsh_evolution_',
    },

    /**
     * 检索。默认只用本地能力。
     *
     * ⚠️ `embeddings*` 四个字段是**为 Phase 4 预留的**：代码里一行都没实现，
     * 面板上也不再展示（见 SCHEMA_FIELDS 上方的说明）。保留结构是为了
     * "将来实现时老配置文件不会因为多了键而被拒绝"。
     */
    retrieval: {
      /** 热条目直取（无依赖）。 */
      hotEntries: true,
      /** 关键词全文检索（无依赖，node:sqlite FTS5 或纯 JS BM25）。 */
      fullText: true,
      /** 向量检索（需要用户自配 embedding 端点，会把正文发出去）。 */
      embeddings: false,
      embeddingsBaseUrl: '',
      embeddingsModel: '',
      embeddingsApiKeyEnv: 'DSH_EVOLUTION_EMBEDDINGS_KEY',
      /**
       * 注入候选池的大小。先从全部洞察里按优先级取这么多条，再按段预算渲染。
       * 太小会让低优先级的段拿不到条目，太大没有意义（渲染阶段还会截断）。
       */
      candidatePool: 30,
      /**
       * 注入的最低复现次数。1 = 单次出现也注入（噪音风险高）；
       * 2 表示"至少见过两次" —— 这与「反复出现才是信号」的设计判断一致。
       */
      minRecurrenceToInject: 1,
      /** 同一作用域允许注入的条目数上限（防止一个仓库的洞察把别的段挤掉）。 */
      perScopeLimit: 12,
      /**
       * 是否优先注入"最近被忽略过"的条目。关掉后完全按优先级排序。
       * 保留这个开关是因为"上次提醒过没被采纳"这种判断在某些仓库里是噪音。
       */
      reSurfaceIgnored: true,
    },

    /** 注入。分段预算写死，防止某一段吃光全部上下文。 */
    inject: {
      enabled: true,
      /** 强制约束段。 */
      maxConstraints: 3,
      maxConstraintChars: 300,
      /** 项目洞察段。 */
      maxRepoInsights: 3,
      maxRepoInsightChars: 400,
      /** 团队规范段。 */
      maxTeamInsights: 2,
      maxTeamInsightChars: 250,
      /** 个人提醒段。 */
      maxPersonalNotes: 1,
      maxPersonalNoteChars: 200,
    },

    /**
     * 晋升（把一条经验从"这个仓库"提升为"跨仓库的个人提醒"）。
     *
     * ⚠️ **这里没有任何"自动"**：跨工作区聚合是 DESIGN 决策 5 里默认关的能力，
     * 因为它跨越了雇主/项目边界（同一台机器上的 A 公司仓库与 B 个人项目会被
     * 混在一起）。这里的配置只决定"面板把哪些条目列为可晋升的候选"，
     * 真正的晋升永远是用户点一下才发生。
     */
    promotion: {
      /** 列为候选所需的最低复现次数。复现次数是本项目的"进化"信号，用它当门槛最自然。 */
      personMinRecurrence: 2,
      /**
       * 晋升后的条目是否自动置顶。默认关：晋升只是"扩大适用范围"，
       * 不等于"这条比别的都重要"，置顶与否该由用户单独决定。
       */
      pinOnPromote: false,
    },

    /** 面板行为。 */
    panel: {
      width: 1100,
      height: 760,
    },

    /**
     * 导出与 skill 草稿。
     *
     * **这里的默认值也要保守**：导出本身是本地行为（没有隐私风险），但
     * `skills.target` 决定草稿落在哪 —— 落仓库会在用户的 git 仓库里建文件，
     * 所以那个开关在 skills 组里，且默认是插件数据目录。
     */
    export: {
      /** 导出 markdown 时是否附带证据链（引用原文）。默认带：没有证据的结论不可复核。 */
      includeEvidence: true,
      /** 导出的单文件上限条数（防止一次导出打成几十兆）。 */
      maxEntries: 500,
      /** 生成 skill 草稿时的最低复现次数。1 = 只要入库就出草稿。 */
      skillMinRecurrence: 2,
      /**
       * 生成 skill 草稿时是否要求人已确认（pinned / accepted）。
       * 默认 true —— 没被认可的模型结论不该自动变成"可执行流程"。
       */
      skillRequireAccepted: true,
      /** 一次最多生成几个 skill 草稿。 */
      skillMaxDrafts: 3,
    },
  }
}

/**
 * 深合并：用 defaults 补齐用户配置里缺的键。
 *
 * 规则：**只补缺，不覆盖**。用户显式给的值（包括 false / 0 / ''）一律保留 ——
 * 用 `||` 或解构默认值会把用户特意关掉的开关又打开，这是配置系统最经典的坑。
 * 数组整体替换（不逐项合并）：数组语义是"用户给的完整集合"，合并会残留旧项。
 */
export function mergeConfig(defaults, incoming) {
  if (incoming === undefined || incoming === null || typeof incoming !== 'object') return defaults
  const out = Array.isArray(defaults) ? [] : { ...defaults }
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in defaults)) continue // 忽略未知键：老配置里遗留的键不该被带进新结构
    const base = defaults[key]
    if (base !== null && typeof base === 'object' && !Array.isArray(base)
      && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeConfig(base, value)
    } else if (Array.isArray(base)) {
      out[key] = Array.isArray(value) ? value : base
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

/** 数值钳制，防止面板传来离谱的值（比如负数轮次、超大字节数）。 */
function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * 归一化：补默认 + 钳制数值 + 收紧枚举。
 * 所有从面板/文件进来的配置都必须过这里，之后再没有任何地方需要做防御性判断。
 */
export function normalizeConfig(raw) {
  const cfg = mergeConfig(defaultConfig(), raw)

  cfg.version = CONFIG_VERSION
  cfg.dataDir = str(cfg.dataDir)
  cfg.enabled = cfg.enabled !== false

  cfg.ledger.enabled = cfg.ledger.enabled !== false
  cfg.ledger.scanHistoryOnStart = cfg.ledger.scanHistoryOnStart !== false
  cfg.ledger.historyDays = clampInt(cfg.ledger.historyDays, 30, 0, 3650)
  cfg.ledger.maxCharsPerMessage = clampInt(cfg.ledger.maxCharsPerMessage, 1200, 200, 20000)
  cfg.ledger.maxCharsPerSession = clampInt(cfg.ledger.maxCharsPerSession, 8000, 1000, 200000)
  cfg.ledger.collectToolSignals = cfg.ledger.collectToolSignals !== false
  cfg.ledger.maxRecordsPerSession = clampInt(cfg.ledger.maxRecordsPerSession, 5000, 200, 200000)
  cfg.ledger.retentionDays = clampInt(cfg.ledger.retentionDays, 0, 0, 36500)

  cfg.review.enabled = cfg.review.enabled === true
  cfg.review.provider = str(cfg.review.provider)
  cfg.review.model = str(cfg.review.model)
  cfg.review.extractAfterTurns = clampInt(cfg.review.extractAfterTurns, 10, 1, 10000)
  cfg.review.idleDebounceMs = clampInt(cfg.review.idleDebounceMs, 60000, 5000, 3600000)
  cfg.review.dailyTokenBudget = clampInt(cfg.review.dailyTokenBudget, 200000, 0, 100000000)
  cfg.review.pauseUntil = str(cfg.review.pauseUntil)
  cfg.review.maxInsightsPerRun = clampInt(cfg.review.maxInsightsPerRun, 5, 1, 50)
  cfg.review.minNewRecordsPerRun = clampInt(cfg.review.minNewRecordsPerRun, 20, 1, 100000)
  cfg.review.timeoutMs = clampInt(cfg.review.timeoutMs, 120000, 10000, 900000)
  cfg.review.countUsageAgainstBudget = cfg.review.countUsageAgainstBudget !== false

  cfg.privacy.redact = cfg.privacy.redact !== false
  cfg.privacy.stripAbsolutePaths = cfg.privacy.stripAbsolutePaths !== false
  cfg.privacy.stripSecrets = cfg.privacy.stripSecrets !== false
  cfg.privacy.customWords = Array.isArray(cfg.privacy.customWords)
    ? cfg.privacy.customWords.map(str).filter((w) => w !== '')
    : []

  const target = str(cfg.skills.target)
  cfg.skills.target = Object.values(SKILL_TARGETS).includes(target) ? target : SKILL_TARGETS.pluginLocal
  cfg.skills.customPath = str(cfg.skills.customPath)
  cfg.skills.confirmBeforeRepoWrite = cfg.skills.confirmBeforeRepoWrite !== false

  cfg.api.enabled = cfg.api.enabled === true
  cfg.api.baseUrl = str(cfg.api.baseUrl).replace(/\/+$/, '')
  cfg.api.tokenEnv = str(cfg.api.tokenEnv) || 'DSH_EVOLUTION_TOKEN'
  cfg.api.uploadMode = ['off', 'redacted'].includes(str(cfg.api.uploadMode)) ? str(cfg.api.uploadMode) : 'off'
  cfg.api.storageBackend = cfg.api.storageBackend === true
  cfg.api.timeoutMs = clampInt(cfg.api.timeoutMs, 15000, 1000, 120000)

  cfg.database.enabled = cfg.database.enabled === true
  cfg.database.driver = ['sqlite', 'postgres'].includes(str(cfg.database.driver)) ? str(cfg.database.driver) : 'sqlite'
  cfg.database.sqlitePath = str(cfg.database.sqlitePath)
  cfg.database.urlEnv = str(cfg.database.urlEnv) || 'DSH_EVOLUTION_DATABASE_URL'
  cfg.database.tablePrefix = str(cfg.database.tablePrefix) || 'dsh_evolution_'

  cfg.retrieval.hotEntries = cfg.retrieval.hotEntries !== false
  cfg.retrieval.fullText = cfg.retrieval.fullText !== false
  cfg.retrieval.embeddings = cfg.retrieval.embeddings === true
  cfg.retrieval.embeddingsBaseUrl = str(cfg.retrieval.embeddingsBaseUrl).replace(/\/+$/, '')
  cfg.retrieval.embeddingsModel = str(cfg.retrieval.embeddingsModel)
  cfg.retrieval.embeddingsApiKeyEnv = str(cfg.retrieval.embeddingsApiKeyEnv) || 'DSH_EVOLUTION_EMBEDDINGS_KEY'
  cfg.retrieval.candidatePool = clampInt(cfg.retrieval.candidatePool, 30, 1, 500)
  cfg.retrieval.minRecurrenceToInject = clampInt(cfg.retrieval.minRecurrenceToInject, 1, 1, 100)
  cfg.retrieval.perScopeLimit = clampInt(cfg.retrieval.perScopeLimit, 12, 1, 200)
  cfg.retrieval.reSurfaceIgnored = cfg.retrieval.reSurfaceIgnored !== false

  cfg.inject.enabled = cfg.inject.enabled !== false
  cfg.inject.maxConstraints = clampInt(cfg.inject.maxConstraints, 3, 0, 50)
  cfg.inject.maxConstraintChars = clampInt(cfg.inject.maxConstraintChars, 300, 0, 10000)
  cfg.inject.maxRepoInsights = clampInt(cfg.inject.maxRepoInsights, 3, 0, 50)
  cfg.inject.maxRepoInsightChars = clampInt(cfg.inject.maxRepoInsightChars, 400, 0, 10000)
  cfg.inject.maxTeamInsights = clampInt(cfg.inject.maxTeamInsights, 2, 0, 50)
  cfg.inject.maxTeamInsightChars = clampInt(cfg.inject.maxTeamInsightChars, 250, 0, 10000)
  cfg.inject.maxPersonalNotes = clampInt(cfg.inject.maxPersonalNotes, 1, 0, 50)
  cfg.inject.maxPersonalNoteChars = clampInt(cfg.inject.maxPersonalNoteChars, 200, 0, 10000)

  cfg.promotion.personMinRecurrence = clampInt(cfg.promotion.personMinRecurrence, 2, 1, 100)
  cfg.promotion.pinOnPromote = cfg.promotion.pinOnPromote === true

  cfg.panel.width = clampInt(cfg.panel.width, 1100, 720, 4000)
  cfg.panel.height = clampInt(cfg.panel.height, 760, 480, 3000)

  cfg.export.includeEvidence = cfg.export.includeEvidence !== false
  cfg.export.maxEntries = clampInt(cfg.export.maxEntries, 500, 1, 100000)
  cfg.export.skillMinRecurrence = clampInt(cfg.export.skillMinRecurrence, 2, 1, 100)
  cfg.export.skillRequireAccepted = cfg.export.skillRequireAccepted !== false
  cfg.export.skillMaxDrafts = clampInt(cfg.export.skillMaxDrafts, 3, 1, 50)

  return cfg
}

/**
 * 面板渲染用的字段描述表（**单一事实来源**）。
 *
 * ⚠️ **这里只放"已经真的生效"的配置项。**
 * defaultConfig 里还有一个"预留区"（向量检索的 `retrieval.embeddings*`），
 * 它们在代码里没有任何实现。刻意不放进这张表：面板上出现一个改了没反应的开关，
 * 比"暂时没有这个功能"更糟 —— 用户会以为是自己配错了。
 * 等真做出来再往这里加一行即可（面板不用改，它是数据驱动渲染的）。
 *
 * 面板是纯数据驱动渲染：加一个配置项 = 在这里加一条，面板代码不用动。
 * 每条：path 用点号路径寻址，kind 决定控件类型，hint 是给用户看的人话解释 ——
 * 这个项目的配置项偏"有后果"（花钱、外发数据），所以 hint 不是装饰，是必需品。
 */
export const SCHEMA_FIELDS = Object.freeze([
  // ---------- 总开关 ----------
  { path: 'enabled', kind: 'boolean', group: 'basic', label: '启用插件',
    hint: '关掉后不采集、不复盘、不注入，面板仍可查看已有数据。' },

  // ---------- 账本 ----------
  { path: 'ledger.enabled', kind: 'boolean', group: 'ledger', label: '记录会话账本',
    hint: '纯本地记录，不联网、不消耗模型。这是复盘的数据来源，建议保持开启。' },
  { path: 'ledger.scanHistoryOnStart', kind: 'boolean', group: 'ledger', label: '启动时回扫历史会话',
    hint: '首次安装后可以把过去一段时间的会话补进来。' },
  { path: 'ledger.historyDays', kind: 'number', group: 'ledger', label: '历史回扫天数', min: 0, max: 3650,
    hint: '0 = 不限。首次安装建议 30 天，避免扫描很久。' },
  { path: 'ledger.collectToolSignals', kind: 'boolean', group: 'ledger', label: '记录工具调用信号',
    hint: '只记工具名与成功/失败，不记参数与输出。' },
  { path: 'ledger.maxCharsPerMessage', kind: 'number', group: 'ledger', label: '单条消息截断字数', min: 200, max: 20000 },
  { path: 'ledger.maxCharsPerSession', kind: 'number', group: 'ledger', label: '单会话摘要上限字数', min: 1000, max: 200000 },
  { path: 'ledger.retentionDays', kind: 'number', group: 'ledger', label: '账本保留天数（0 = 永久）', min: 0, max: 36500,
    hint: '超过 N 天的账本分片会在插件启动时删除。这是本插件唯一会删数据的开关，默认 0（永久保留）；改动在重启 dsh web 后生效。' },
  { path: 'ledger.maxRecordsPerSession', kind: 'number', group: 'ledger', label: '单会话参与复盘的记录上限', min: 200, max: 200000,
    hint: '超长会话只取最近这么多条记录来折叠摘要，保证最坏情况可控。' },

  // ---------- 复盘 ----------
  { path: 'review.enabled', kind: 'boolean', group: 'review', label: '开启自动复盘（消耗模型额度）',
    hint: '开启后会调用你自己配置的模型做归纳，会产生 API 费用。建议先用面板上的「试跑」看效果再打开。' },
  /**
   * ⚠️ `hidden: true` = 面板**不直接渲染**这两个字段，它们的控件是「复盘用哪个模型」
   * 选择器（`client/index.js` 的 `ReviewModelPicker`）。仍然留在 schema 里的原因：
   * 脏值追踪、配置表、文档与归一化都按这张表工作，删掉它们会让"未保存 N 项"漏算。
   *
   * 为什么不让用户手填：能填的入口就会有人填错，而 `NO_ADAPTER` 对用户毫无帮助；
   * "哪些模型真的可用"只有宿主知道，所以让他**选**。已经在配置里的旧值仍然会
   * 在下拉里显示出来并原样保留（不会被静默改掉）。
   */
  { path: 'review.provider', kind: 'text', group: 'review', label: '复盘用提供方', hidden: true,
    hint: '由「复盘用哪个模型」选择器写入（面板不提供手填）。留空表示不复盘。' },
  { path: 'review.model', kind: 'text', group: 'review', label: '复盘用模型', hidden: true,
    hint: '由「复盘用哪个模型」选择器写入（面板不提供手填）。留空表示不复盘，不会默认用当前会话的模型。' },
  { path: 'review.extractAfterTurns', kind: 'number', group: 'review', label: '攒够多少轮做一次抽取', min: 1, max: 10000,
    hint: '逐轮抽取成本是 N 倍且看不到"反复出现"的模式，建议 10。' },
  { path: 'review.idleDebounceMs', kind: 'number', group: 'review', label: '静默多久后触发（毫秒）', min: 5000, max: 3600000 },
  { path: 'review.dailyTokenBudget', kind: 'number', group: 'review', label: '每日 token 预算（0 = 不限）', min: 0, max: 100000000,
    hint: '防止账单失控的刹车，默认 20 万 token（够跑四十多次复盘）。超了当天自动暂停并提示。填 0 表示不限。' },
  { path: 'review.maxInsightsPerRun', kind: 'number', group: 'review', label: '一次最多接受几条洞察', min: 1, max: 50,
    hint: '质量阀门：条数越多，注水越多，真正重要的那条越容易被挤出注入预算。建议 5。' },
  { path: 'review.minNewRecordsPerRun', kind: 'number', group: 'review', label: '两次复盘之间至少新增记录数', min: 1, max: 100000,
    hint: '防止连点「现在复盘」把同一份摘要反复喂给模型。' },
  { path: 'review.timeoutMs', kind: 'number', group: 'review', label: '单次复盘超时（毫秒）', min: 10000, max: 900000 },
  { path: 'review.countUsageAgainstBudget', kind: 'boolean', group: 'review', label: '用量计入每日预算',
    hint: '关掉后预算刹车失效，只保留统计。' },

  // ---------- 隐私 ----------
  { path: 'privacy.redact', kind: 'boolean', group: 'privacy', label: '开启脱敏' },
  { path: 'privacy.stripAbsolutePaths', kind: 'boolean', group: 'privacy', label: '移除绝对路径',
    hint: '只保留仓库内的相对路径，避免暴露你的目录结构。' },
  { path: 'privacy.stripSecrets', kind: 'boolean', group: 'privacy', label: '移除疑似密钥',
    hint: '识别 sk- / Bearer / password= 等常见形态。' },
  { path: 'privacy.customWords', kind: 'stringList', group: 'privacy', label: '自定义敏感词',
    hint: '每行一个，命中即替换为 ●。' },

  // ---------- skill 落点 ----------
  { path: 'skills.target', kind: 'select', group: 'skills', label: 'skill 落点',
    hint: 'DSH 只会自动发现 .dsh/skills 与 .agents/skills；选其它目录需要在 DSH 配置里额外加 customSkillDirs，否则写了不生效。',
    options: [
      { value: SKILL_TARGETS.pluginLocal, label: '插件数据目录（默认，不碰仓库）' },
      { value: SKILL_TARGETS.projectAgents, label: '仓库内 .agents/skills（DSH 原生发现）' },
      { value: SKILL_TARGETS.projectDsh, label: '仓库内 .dsh/skills（DSH 最高优先级）' },
      { value: SKILL_TARGETS.custom, label: '自定义路径' },
    ] },
  { path: 'skills.customPath', kind: 'text', group: 'skills', label: '自定义 skill 路径',
    hint: '相对路径按仓库根解析，绝对路径原样使用。' },
  { path: 'skills.confirmBeforeRepoWrite', kind: 'boolean', group: 'skills', label: '写入仓库前需确认' },

  // ---------- 接口对接 ----------
  { path: 'api.enabled', kind: 'boolean', group: 'api', label: '启用接口对接（可选）', reserved: '本插件不提供也不托管服务端；这一组只是配置契约，Phase 1 尚未实现上传',
    hint: '本插件不提供也不托管任何服务端。开启后只会向你填的地址发送数据。' },
  { path: 'api.baseUrl', kind: 'text', group: 'api', label: '接口地址', placeholder: 'https://your-endpoint', reserved: '同 api.enabled：只是配置契约，尚未实现' },
  { path: 'api.tokenEnv', kind: 'text', group: 'api', label: 'Token 所在环境变量名', reserved: '同 api.enabled：只是配置契约，尚未实现',
    hint: '只在环境变量里放 token，不写进配置文件。' },
  { path: 'api.uploadMode', kind: 'select', group: 'api', label: '上传模式',
    options: [
      { value: 'off', label: '不上传（默认）' },
      { value: 'redacted', label: '只上传脱敏后的摘要' },
    ] },
  { path: 'api.timeoutMs', kind: 'number', group: 'api', label: '请求超时（毫秒）', min: 1000, max: 120000, reserved: '存储后端模式（api.storageBackend）使用它；upload 模式尚未实现' },
  { path: 'api.storageBackend', kind: 'boolean', group: 'api', label: '把存储搬到远端（需要 baseUrl + token）',
    hint: '⚠️ 与「上传脱敏摘要」不同：开启后账本与洞察整体读写到远端服务（DESIGN 决策 8）。需要 enabled + baseUrl 同时就位，服务端契约见 docs/API-CONTRACT.md；初始化失败回退本地文件；改完需重启。' },

  // ---------- 数据库对接 ----------
  { path: 'database.enabled', kind: 'boolean', group: 'database', label: '启用数据库（可选）', reserved: '开启后 SQLite 驱动生效（数据搬进数据库，本地文件不再读写）；postgres 尚未实现', hint: '首次启用会把数据目录里的存量 NDJSON 一次性导入，原文件保留不动；改数据目录后需重启。' },
  { path: 'database.driver', kind: 'select', group: 'database', label: '驱动', reserved: 'sqlite 已实现；postgres 是配置契约，尚未实现',
    options: [
      { value: 'sqlite', label: 'SQLite（本地文件，内置零依赖）' },
      { value: 'postgres', label: 'PostgreSQL（需自备，尚未实现）' },
    ] },
  { path: 'database.sqlitePath', kind: 'text', group: 'database', label: 'SQLite 路径', placeholder: '留空 = 数据目录下 index.sqlite', reserved: 'driver=sqlite 时生效；改路径后需重启' },
  { path: 'database.urlEnv', kind: 'text', group: 'database', label: '连接串所在环境变量名', reserved: 'postgres 专用，尚未实现',
    hint: '不要把数据库密码写进配置文件。' },
  { path: 'database.tablePrefix', kind: 'text', group: 'database', label: '表名前缀', reserved: 'driver=sqlite 时生效；只允许字母/数字/下划线，非法值回退默认' },

  // ---------- 检索 ----------
  { path: 'retrieval.hotEntries', kind: 'boolean', group: 'retrieval', label: '热条目直取（无依赖）' },
  { path: 'retrieval.fullText', kind: 'boolean', group: 'retrieval', label: '关键词全文检索（无依赖）' },
  { path: 'retrieval.candidatePool', kind: 'number', group: 'retrieval', label: '注入候选池条数', min: 1, max: 500,
    hint: '先从全部洞察里按优先级取这么多条，再按各段预算渲染。' },
  { path: 'retrieval.minRecurrenceToInject', kind: 'number', group: 'retrieval', label: '注入的最低复现次数', min: 1, max: 100,
    hint: '1 = 单次出现也注入；2 = 至少见过两次。设计判断是「反复出现才是信号」，所以 2 更保守。' },
  { path: 'retrieval.perScopeLimit', kind: 'number', group: 'retrieval', label: '单作用域注入上限', min: 1, max: 200 },
  { path: 'retrieval.reSurfaceIgnored', kind: 'boolean', group: 'retrieval', label: '优先重提被忽略过的条目' },

  // ---------- 注入 ----------
  { path: 'inject.enabled', kind: 'boolean', group: 'inject', label: '启用注入' },
  { path: 'inject.maxConstraints', kind: 'number', group: 'inject', label: '约束段条数', min: 0, max: 50 },
  { path: 'inject.maxConstraintChars', kind: 'number', group: 'inject', label: '约束段字数', min: 0, max: 10000 },
  { path: 'inject.maxRepoInsights', kind: 'number', group: 'inject', label: '项目洞察段条数', min: 0, max: 50 },
  { path: 'inject.maxRepoInsightChars', kind: 'number', group: 'inject', label: '项目洞察段字数', min: 0, max: 10000 },
  { path: 'inject.maxTeamInsights', kind: 'number', group: 'inject', label: '团队规范段条数', min: 0, max: 50 },
  { path: 'inject.maxTeamInsightChars', kind: 'number', group: 'inject', label: '团队规范段字数', min: 0, max: 10000 },
  { path: 'inject.maxPersonalNotes', kind: 'number', group: 'inject', label: '个人提醒段条数', min: 0, max: 50 },
  { path: 'inject.maxPersonalNoteChars', kind: 'number', group: 'inject', label: '个人提醒段字数', min: 0, max: 10000 },

  // ---------- 晋升 ----------
  { path: 'promotion.personMinRecurrence', kind: 'number', group: 'promotion', label: '可晋升为个人提醒的最低复现次数', min: 1, max: 100,
    hint: '跨仓库提醒会出现在每个仓库的上下文里，所以要「至少见过几次」才列为候选。晋升永远需要你手动确认，本插件不做自动跨工作区聚合。' },
  { path: 'promotion.pinOnPromote', kind: 'boolean', group: 'promotion', label: '晋升后自动置顶',
    hint: '默认关：晋升只表示"适用范围更广"，不等于"更重要"。' },

  // ---------- 导出与草稿 ----------
  { path: 'export.includeEvidence', kind: 'boolean', group: 'export', label: '导出时附带证据链',
    hint: '没有证据的结论无法复核。建议保持开启。' },
  { path: 'export.maxEntries', kind: 'number', group: 'export', label: '单次导出条数上限', min: 1, max: 100000 },
  { path: 'export.skillMinRecurrence', kind: 'number', group: 'export', label: '生成 skill 草稿的最低复现次数', min: 1, max: 100,
    hint: 'skill 是「可执行流程」，比一条提醒重得多，所以门槛更高。' },
  { path: 'export.skillRequireAccepted', kind: 'boolean', group: 'export', label: '只把已认可的条目写成草稿',
    hint: '默认要求你确认过（置顶/采纳）才生成，避免模型结论直接变成流程。' },
  { path: 'export.skillMaxDrafts', kind: 'number', group: 'export', label: '一次最多生成几个草稿', min: 1, max: 50 },
])

/** 面板分组标题与顺序。 */
export const SCHEMA_GROUPS = Object.freeze([
  { id: 'basic', label: '总开关' },
  { id: 'ledger', label: '会话账本' },
  { id: 'review', label: '自动复盘' },
  { id: 'privacy', label: '隐私与脱敏' },
  { id: 'skills', label: '本地 skill 落点' },
  { id: 'api', label: '接口对接（可选）' },
  { id: 'database', label: '数据库对接（可选）' },
  { id: 'retrieval', label: '检索' },
  { id: 'inject', label: '注入' },
  { id: 'export', label: '导出与草稿' },
  { id: 'promotion', label: '晋升' },
])

/** 供面板展示的元信息。 */
export const META = Object.freeze({
  defaultDirName: DEFAULT_DIR_NAME,
  envHome: ENV_HOME,
})
