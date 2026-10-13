/**
 * dsh-evolution — 注入段渲染
 *
 * 这个模块决定"将来会把哪几段文本放进上下文"。它现在就被用上了（面板的「试跑」页），
 * 所以有两条必须守住的约束：
 *
 * 1. **纯函数、零副作用。** 只做渲染和预算计算，不写文件、不发请求、不改任何状态。
 *    「试跑不回写」这条承诺就靠这个模块不碰 IO 来保证 —— 而不是靠调用方记得别写。
 *
 * 2. **预算是硬上限，且分段独立。** 每段有自己的条数与字数上限，任一段都不能吃光
 *    其他段的额度。历史教训（内部版踩过）：把整条正文拼进注入文本时，单条就撞到
 *    总字数上限，结果是"头部写出来了、条目一条都没进"，表现为有记忆但注入全空壳。
 */
import { str } from './paths.js'

/**
 * 注入段定义。
 *
 * `layer` 是**性能关键**：stable 段的文本在会话期间不变，可以走宿主的 prompt 前缀缓存；
 * volatile 段每人每轮都可能不同。把 volatile 内容混进 stable 段会让缓存对所有人失效，
 * 而这个代价不报错、只体现在账单上。
 */
export const SECTION_DEFS = Object.freeze([
  {
    id: 'constraints',
    title: '强制约束',
    layer: 'stable',
    tone: 'hard',
    maxCountKey: 'maxConstraints',
    maxCharsKey: 'maxConstraintChars',
    /** 约束类条目对 agent 是"必须遵守"，措辞不能软。 */
    header: '## 必须遵守的约束\n以下为**强制要求**（不是参考）。违反它们会造成实际后果。\n',
    defaultToneText: '（暂无强约束条目）',
  },
  {
    id: 'repo',
    title: '项目洞察与避坑',
    layer: 'stable',
    tone: 'soft',
    maxCountKey: 'maxRepoInsights',
    maxCharsKey: 'maxRepoInsightChars',
    /**
     * 必须写明"以代码为准"：这些结论来自过去的会话，可能与当前代码已经不一致。
     * 不写这句会让 agent 把过期结论当成事实。
     */
    header: '## 已沉淀的项目决策与避坑（本仓库）\n'
      + '以下来自该仓库过去的开发会话，供参考。**与当前代码冲突时，一律以代码为准。**\n',
    defaultToneText: '（暂无本仓库洞察）',
  },
  {
    id: 'team',
    title: '团队规范',
    layer: 'stable',
    tone: 'soft',
    maxCountKey: 'maxTeamInsights',
    maxCharsKey: 'maxTeamInsightChars',
    header: '## 跨项目团队规范\n以下为团队范围内沉淀的约定，供参考。\n',
    defaultToneText: '（暂无团队规范）',
  },
  {
    id: 'personal',
    title: '个人提醒',
    layer: 'volatile',
    tone: 'soft',
    maxCountKey: 'maxPersonalNotes',
    maxCharsKey: 'maxPersonalNoteChars',
    /**
     * 这一段的内容**来自用户手动晋升**（见 config.promotion），不是自动跨工作区
     * 聚合出来的 —— 所以措辞必须让模型知道"这是跨项目的一般性提醒"，
     * 而不是"当前仓库的既定事实"。混为一谈会让模型把 A 项目的约定套到 B 项目上。
     */
    header: '## 给你的提醒（个人偏好，跨项目适用；与当前仓库的约定冲突时以仓库为准）\n',
    defaultToneText: '（暂无个人提醒）',
  },
])

/**
 * 计算一段文本的字符数（按代码点，避免把 emoji/中文算成多字符）。
 * 用 `[...s].length` 而不是 `s.length`：后者按 UTF-16 码元计数，
 * emoji 会被算成 2。
 */
export function charCount(text) {
  return [...String(text ?? '')].length
}

/** 粗略 token 估算。中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token 取中。 */
export function estimateTokens(text) {
  const chars = charCount(text)
  if (chars === 0) return 0
  return Math.ceil(chars / 2.2)
}

/**
 * 渲染单个注入段。
 *
 * @param def - SECTION_DEFS 中的一项。
 * @param entries - 条目数组，形如 { title, detail?, kind?, type?, recurrence? }。
 * @param budget - { maxCount, maxChars }。
 * @returns { id, title, layer, tone, text, included, skipped, chars, budget, overflow }
 */
export function renderSection(def, entries, budget) {
  const maxCount = Math.max(0, Number(budget?.maxCount ?? 0))
  const maxChars = Math.max(0, Number(budget?.maxChars ?? 0))
  const list = Array.isArray(entries) ? entries : []

  const lines = []
  const included = []
  let used = 0
  let overflow = false

  // 头部字数先占掉，否则会出现"头部写出来了、条目一条都没进"的空壳
  const headerChars = charCount(def.header)

  for (const entry of list) {
    if (included.length >= maxCount) { overflow = true; break }
    const title = str(entry?.title ?? entry?.claim ?? '')
    if (title === '') continue
    // 只注标题摘要，不注正文：正文体积不可控（内部版实测均值 1659 字符/p90 2875），
    // 挤进注入预算不划算。正文的完整内容目前在**面板**（数据预览/洞察页）可见；
    // agent 侧"按需取全文"的检索工具是路线图上的事 —— 若将来加上，这里不用改，
    // 只需让工具读同一个 InsightsStore。
    const marker = entry?.recurrence > 1 ? `（已复现 ${entry.recurrence} 次）` : ''
    const line = `- [${str(entry?.type ?? entry?.kind ?? 'insight')}] ${title}${marker}\n`

    // 预算判断要连头部一起算：这是"总预算"的语义
    if (headerChars + used + charCount(line) > maxChars) { overflow = true; break }
    if (used + charCount(line) > maxChars) { overflow = true; break }

    lines.push(line)
    // `id` 必须带上：注入之后要记"这条被注入过几次"（面板显示"你到底看到没看到"），
    // 而只靠 title 回查是不可靠的（标题可被人工编辑）。
    included.push({
      id: str(entry?.id) || str(entry?.key) || title,
      title,
      type: str(entry?.type ?? entry?.kind ?? ''),
      recurrence: entry?.recurrence ?? 1,
    })
    used += charCount(line)
  }

  const text = lines.length === 0 ? '' : def.header + lines.join('')

  return {
    id: def.id,
    title: def.title,
    layer: def.layer,
    tone: def.tone,
    text,
    included,
    // 被预算挡在外面的条目数 —— 面板要显示，否则用户不知道"还有 N 条没进去"
    skipped: Math.max(0, list.length - included.length),
    overflow,
    chars: charCount(text),
    budget: { maxCount, maxChars },
  }
}

/**
 * 渲染全部注入段。
 *
 * @param sources - { constraints, repo, team, personal }，各为条目数组。
 * @param injectConfig - config.inject。
 * @returns { sections, totalChars, totalTokens, stableText, volatileText, stableChars, volatileChars }
 */
export function renderInjection(sources, injectConfig) {
  const cfg = injectConfig ?? {}
  const sections = SECTION_DEFS.map((def) => renderSection(def, sources?.[def.id] ?? [], {
    maxCount: cfg[def.maxCountKey],
    maxChars: cfg[def.maxCharsKey],
  }))

  const nonEmpty = sections.filter((s) => s.text !== '')
  const stable = nonEmpty.filter((s) => s.layer === 'stable')
  const volatile = nonEmpty.filter((s) => s.layer === 'volatile')
  const stableText = stable.map((s) => s.text).join('\n')
  const volatileText = volatile.map((s) => s.text).join('\n')

  return {
    sections,
    totalChars: charCount(stableText) + charCount(volatileText),
    totalTokens: estimateTokens(stableText) + estimateTokens(volatileText),
    stableText,
    volatileText,
    stableChars: charCount(stableText),
    volatileChars: charCount(volatileText),
    /** 预算上限之和，供面板显示"用了多少 / 有多少"。 */
    budgetChars: SECTION_DEFS.reduce((n, d) => n + Number(cfg[d.maxCharsKey] ?? 0), 0),
    emptySections: sections.length - nonEmpty.length,
  }
}

/**
 * 把注入条目从"存储形态"归一成渲染需要的最小字段。
 *
 * 现在是给试跑用的；Phase 1 接上真实检索后，同一函数继续服务真实注入 ——
 * 保证"试跑看到的"和"真正注入的"走同一条渲染路径（否则试跑就没有可信度）。
 */
export function toInjectionEntries(records, limit) {
  const list = Array.isArray(records) ? records : []
  return list.slice(0, Math.max(0, Number(limit ?? list.length))).map((r) => ({
    title: str(r?.title ?? r?.claim),
    detail: str(r?.detail),
    type: str(r?.type ?? r?.kind),
    recurrence: typeof r?.recurrence === 'number' ? r.recurrence : 1,
  }))
}
