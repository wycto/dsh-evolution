/**
 * dsh-evolution — 脱敏
 *
 * 这是**唯一**决定"什么东西会离开你的电脑"的代码路径，所以它必须：
 *
 * 1. **可单独调用、可预览**。面板上有"脱敏预览"：左边原文右边处理后文本。
 *    用户能亲眼看到差别，才谈得上信任 —— 而不是"我们在服务端帮你脱敏了"。
 *
 * 2. **宁可少记，不要误记**。所有规则都是"高置信度才替换"：宁可漏掉一个
 *    不常见的密钥形态，也不要因为一个过宽的规则把正常的代码文本打成 ●●●。
 *    脱敏过头的后果是记忆全变马赛克、功能直接废掉，用户会以为插件坏了。
 *
 * 3. **按行处理，不跨行匹配**。跨行正则（尤其是 `/s`）在大文本上既慢又容易
 *    误伤，而这些敏感形态本质都是单行 token。
 */
import { str } from './paths.js'

/** 替换标记。单一样式便于用户一眼看出"这里被处理过"。 */
const MASK = '●'

/**
 * 高置信度的密钥/token 形态。每条都写明"为什么这么定"，
 * 因为放宽或收紧都得有依据，不能凭手感调。
 */
const SECRET_RULES = [
  // OpenAI/DeepSeek 风格：sk- 后面跟至少 16 位。最短长度是防误伤 "sk-1" 这类普通标识。
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, why: 'sk- 前缀的 API key' },
  // HTTP 头里的 Bearer / Basic 凭证
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, why: 'Authorization 头凭证' },
  // key=value 形式的密钥赋值（见 applyKeyValueRule：键名保留，只掩值，且跳过间接引用）
  { kind: 'keyValue', why: 'key=value 形式的密钥赋值' },
  // JWT：三段 Base64URL，明显形态
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, why: 'JWT' },
  // GitHub token
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, why: 'GitHub token' },
  // AWS Access Key ID（AKIA + 16 位大写字母数字，形态很固定）
  { re: /\bAKIA[0-9A-Z]{16}\b/g, why: 'AWS Access Key ID' },
  // 私钥块的开头（整块内容不逐行处理，只标记出现位置）
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, why: '私钥块起始标记' },
  // 常见国产云/平台的 AccessKey 形态
  { re: /\bLTAI[A-Za-z0-9]{12,}\b/g, why: '阿里云 AccessKey' },
]

/** key=value 规则的键名匹配（**自身带捕获组**，见下方组号说明）。 */
const KEY_NAME_RE = '((?:api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|secret[_-]?key))'

/**
 * key=value 规则的完整匹配。
 *
 * ⚠️ 组号是硬契约，改动前必读：
 *   组 1 = 键名（**必须自带一层括号**，用 (?:) 包内层备选，否则内层备选会占掉组号）
 *   组 2 = 引号（`\2` 反向引用它，保证前后引号一致）
 *   组 3 = 值
 * 这里踩过一次坑：把内层备选直接内联进组 1 时，`\2` 指到了备选组而不是引号，
 * 导致整条规则静默失效（正则永远匹配不上，且不报任何错）。冒烟测试抓出来的。
 *
 * 值末尾的 `(?![.\w(])` 是另一处必要的收紧，它排除 `apiKey = readFromVault()`
 * 这类**函数调用/属性访问**。少了它，`readFromVault` 会被当成字面量密钥掩掉 ——
 * 而误伤正常代码比漏掉一个密钥的后果严重得多（记忆会变成一堆 ●）。
 *
 * ⚠️ 三个字符都不能少，每一个都对应一个真实漏网场景（都是冒烟测试抓的）：
 *   `.`  → `password = config.db.password` 这种属性访问
 *   `\w` → 正则会**回退到更短的值**让断言成立：`(?![.(])` 时 `readFromVaul`
 *          后面正好是 `t`，于是匹配成功、只剩一个 `t()` 留在原地
 *   `(`  → 值是 `readFromVault` 且后面紧跟 `(` 时，前两个断言都不拦
 */
const KEY_VALUE_RE = new RegExp(
  `\\b${KEY_NAME_RE}\\b\\s*[:=]\\s*(["']?)([A-Za-z0-9._~+/=-]{12,})(?![.\\w(])\\2`,
  'gi',
)

/**
 * 值看起来是"间接引用"而不是字面量密钥时，不脱敏。
 *
 * 这是整条脱敏链路里最重要的一条安全阀：**脱敏过头的后果是记忆全变马赛克、
 * 功能直接废掉，用户会以为插件坏了**。而代码里 `password=process.env.DB_PASSWORD`、
 * `token = readFromVault()` 这类写法出现频率远高于真把密钥写死在代码里。
 *
 * 判据分三类，都很保守（宁可漏掉一个不常见的间接写法，也不误伤正常代码）：
 *   A. 包含 `.` —— 限定名访问（`process.env.X` / `os.environ.Y` / `config.db.pwd`），
 *      字面量密钥几乎不会带点号；
 *   B. 看起来是函数调用 —— 名字带取值前缀（get/read/load/fetch/...）或含
 *      取值名词（env/secret/key/token/vault/...）并以 `(` 结尾；
 *   C. 占位符形态 —— `${...}` / `<...>` / `{{...}}` / `your_x` / `xxxx` / `...`。
 */
const PLACEHOLDER_PATTERNS = [
  /^\$\{/,
  /^<[^>]+>$/,
  /^\{\{/,
  /^your[_-]/i,
  /^xxx+$/i,
  /^\.\.\.$/,
  /^(todo|tbd|changeme|placeholder|example|dummy|fake|test[_-]?)/i,
]

/** 值是否是"间接引用"（环境变量 / 函数调用 / 占位符）。 */
function looksIndirect(value) {
  const v = value.trim()
  if (v === '') return true

  // A. 限定名访问
  if (v.includes('.')) return true

  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(v)) return true
  }

  // B. 函数调用形态
  if (v.endsWith('(')) {
    const name = v.slice(0, -1)
    if (/^(get|read|load|fetch|resolve|lookup|require|retrieve)/i.test(name)) return true
    if (/(env|secret|key|token|password|credential|vault|config|setting|configvalue)/i.test(name)) return true
  }

  return false
}

/**
 * 绝对路径 → `<path>/<文件名>`。
 *
 * 只保留文件名而不是保留"仓库内相对路径"：判断"哪一段算仓库根"需要知道当前 cwd，
 * 而脱敏必须是一个纯函数（面板预览、离线导出都要能用）。保留文件名足以让
 * "哪个文件出的问题"可读，同时去掉了目录结构这个真正的敏感信息。
 */
const UNIX_PATH_RE = /(^|[\s"'(=,:;[])((?:\/(?:[^/\s"'()[\]:;]+\/)+)[^/\s"'()[\]:;]*)/g
const WIN_PATH_RE = /(^|[\s"'(=,:;[])((?:[A-Za-z]:[\\/])(?:[^\\/\s"'()[\]:;]+[\\/])+[^\\/\s"'()[\]:;]*)/g

/** 自定义敏感词编译成一次性的联合正则（词表可能上百条，逐个 replace 太慢）。 */
function compileCustomWords(words) {
  const list = (words ?? []).map(str).filter((w) => w !== '')
  if (list.length === 0) return undefined
  // 长词优先，避免短词先命中导致长词匹配不上
  list.sort((a, b) => b.length - a.length)
  const escaped = list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  try {
    return new RegExp(escaped.join('|'), 'g')
  } catch {
    // 极端情况下（词表里有病态模式）放弃自定义词，不让它拖垮整条链路
    return undefined
  }
}

/**
 * 对一段文本做脱敏。
 * @param text - 原始文本。
 * @param options - 脱敏选项（对应 config.privacy）。
 * @param options.redact - 总开关；false 时**原样返回**（用户明确选择不脱敏）。
 * @param options.stripAbsolutePaths - 是否处理绝对路径。
 * @param options.stripSecrets - 是否处理密钥形态。
 * @param options.customWords - 自定义敏感词数组。
 * @returns 处理后的文本。
 */
export function redact(text, options = {}) {
  const input = typeof text === 'string' ? text : String(text ?? '')
  if (input === '') return ''
  if (options.redact === false) return input

  let out = input

  if (options.stripSecrets !== false) {
    for (const rule of SECRET_RULES) {
      if (rule.kind === 'keyValue') {
        out = applyKeyValueRule(out)
      } else {
        // 全局正则有 lastIndex，跨调用会残留；重置后再用
        rule.re.lastIndex = 0
        out = out.replace(rule.re, () => MASK.repeat(6))
      }
    }
  }

  if (options.stripAbsolutePaths !== false) {
    out = out.replace(WIN_PATH_RE, (_m, lead, full) => `${lead}<path>/${basenameAny(full)}`)
    out = out.replace(UNIX_PATH_RE, (_m, lead, full) => `${lead}<path>/${basenameAny(full)}`)
  }

  const custom = compileCustomWords(options.customWords)
  if (custom !== undefined) {
    out = out.replace(custom, (m) => MASK.repeat(Math.min(m.length, 8)))
  }

  return out
}

/**
 * key=value 规则。
 *
 * 三条要求同时满足才替换，缺一不可：
 *   1. **保留键名** —— 直接把 `password=xxx` 整段变成 ●●● 会让脱敏后的文本读不出
 *      "这里被掩了一个密码"，反而不利于人工核对（这条曾经真的写错过）。
 *   2. **只替换值的字符区间** —— 用捕获组的位置精确替换，不做整段字符串拼接，
 *      避免重复的键名把键名本身也替换掉。
 *   3. **跳过间接引用** —— `process.env.X` / `readFromVault()` 这类不当密钥处理。
 */
function applyKeyValueRule(text) {
  KEY_VALUE_RE.lastIndex = 0
  return text.replace(KEY_VALUE_RE, (whole, key, quote, value, offset) => {
    if (looksIndirect(value)) return whole
    // 掩码长度跟原值走，但设上限，避免超长值撑出一屏的 ●
    const mask = MASK.repeat(Math.min(value.length, 8))
    // 值在整段匹配中的位置：总长 - 引号 - 值
    const valueStart = offset + whole.length - quote.length - value.length
    const valueEnd = offset + whole.length - quote.length
    return text.slice(offset, valueStart) + mask + text.slice(valueEnd, offset + whole.length)
  })
}

/** 取路径的最后一段（兼容 / 与 \）。 */
function basenameAny(p) {
  const parts = String(p).split(/[\\/]/).filter((s) => s !== '')
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/**
 * 生成脱敏预览：返回逐行的 before/after 对照，供面板并排显示。
 *
 * 只返回**被改动过的行**（未改动的行没有展示价值，只会把面板撑长），
 * 且每侧截断到 maxChars，避免一行巨型输出把面板卡死。
 * @param text - 原始文本。
 * @param options - 同 redact。
 * @param maxChars - 每侧每行最大展示长度。
 */
export function previewRedaction(text, options = {}, maxChars = 300) {
  const before = String(text ?? '').split('\n')
  const after = redact(text, options).split('\n')
  const rows = []
  const limit = Math.max(1, maxChars)
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i]
    const a = after[i] ?? ''
    if (b === a) continue
    rows.push({
      line: i + 1,
      before: clip(b, limit),
      after: clip(a, limit),
      truncated: b.length > limit || a.length > limit,
    })
    if (rows.length >= 200) break // 面板一次展示上限，剩下的看导出
  }
  return { rows, changedLines: rows.length, totalLines: before.length }
}

/** 计数：这段文本里有多少条规则会命中（用于"预览"页的汇总数字）。 */
export function redactionStats(text, options = {}) {
  const input = String(text ?? '')
  if (input === '' || options.redact === false) return { hits: 0, kinds: [] }
  const kinds = []
  let hits = 0
  if (options.stripSecrets !== false) {
    for (const rule of SECRET_RULES) {
      if (rule.kind === 'keyValue') {
        KEY_VALUE_RE.lastIndex = 0
        let count = 0
        // 逐条判断，跳过间接引用（否则统计会把正常代码也算成"命中"）
        input.replace(KEY_VALUE_RE, (whole, key, quote, value) => {
          if (!looksIndirect(value)) count += 1
          return whole
        })
        if (count > 0) {
          hits += count
          kinds.push({ why: rule.why, count })
        }
        continue
      }
      rule.re.lastIndex = 0
      const m = input.match(rule.re)
      if (m && m.length > 0) {
        hits += m.length
        kinds.push({ why: rule.why, count: m.length })
      }
    }
  }
  if (options.stripAbsolutePaths !== false) {
    const win = input.match(WIN_PATH_RE)
    const nix = input.match(UNIX_PATH_RE)
    const count = (win?.length ?? 0) + (nix?.length ?? 0)
    if (count > 0) {
      hits += count
      kinds.push({ why: '绝对路径', count })
    }
  }
  const custom = compileCustomWords(options.customWords)
  if (custom !== undefined) {
    const m = input.match(custom)
    if (m && m.length > 0) {
      hits += m.length
      kinds.push({ why: '自定义敏感词', count: m.length })
    }
  }
  return { hits, kinds }
}

function clip(s, max) {
  const t = String(s)
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 供测试与面板展示：当前生效的规则说明。 */
export function secretRuleDescriptions() {
  return SECRET_RULES.map((r) => r.why)
}
