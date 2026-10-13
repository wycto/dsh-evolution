/**
 * dsh-evolution — 导出（markdown / JSON）与 skill 草稿
 *
 * 两件事放在一起，因为它们共享同一条纪律：**产物必须是人可读、可复核、可搬走的**，
 * 而且**写进用户仓库这件事必须由人明确同意**。
 *
 * 导出（本地留档，安全）：
 *   exports/insights-<时间>.md     人读的，带证据链
 *   exports/insights-<时间>.json   机读的，可再导入
 *
 * skill 草稿（可能进仓库，需要同意）：
 *   <skills.target>/<name>/SKILL.md
 *
 * ⚠️ SKILL.md 的格式是**硬契约**（实测 dsh-skill-filesystem 的解析代码）：
 *   · 文件必须叫 `SKILL.md`（大小写敏感），放在 `<根>/<目录>/` 下，只扫一层
 *   · 首行必须是**恰好** `---`（不能有 BOM、不能有空行、不能有尾随空格）
 *   · frontmatter 必须有 `name`（`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`）与 `description`（非空）
 *   · 已废弃的驼峰键（`disableModelInvocation` 等）出现即**整个文件被丢弃**
 *   · **格式错了不会报错**：文件被静默跳过，功能表现为"技能没生效"
 * 所以 `buildSkillFile()` 会做双向校验：生成时规范化，生成后自检一遍再写盘。
 * 一个静默失效的技能生成器，比没有这个功能更糟。
 */
import { mkdir, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic, writeJsonAtomic } from './storage.js'
import { SUBDIRS, str } from './paths.js'
import { SCOPES } from './insights-store.js'

/** 导出的 markdown 文件头（说明"这是什么、从哪来、怎么复核"）。 */
function exportHeader(options = {}) {
  return [
    '# dsh-evolution 洞察导出',
    '',
    `- 导出时间：${new Date(Number(options.now ?? Date.now())).toLocaleString()}`,
    `- 数据根目录：${str(options.root)}`,
    `- 条数：${Number(options.count ?? 0)}`,
    `- 生成方式：本地文件直出，**未经过任何网络请求**`,
    '',
    '> 每条洞察后面都附了证据（会话 id / 轮次 / 原文引用）。',
    '> 请以代码和当前需求为准；这里的结论来自过去的会话，可能已经过时。',
    '',
  ].join('\n')
}

/** 一条洞察的 markdown 片段。 */
export function insightToMarkdown(item, options = {}) {
  const includeEvidence = options.includeEvidence !== false
  const lines = []
  const head = `### [${str(item.type)}] ${str(item.title)}`
  lines.push(head)
  lines.push('')
  const meta = []
  meta.push(`作用域：${str(item.scope)}`)
  if (str(item.repo) !== '') meta.push(`仓库：${str(item.repo)}`)
  meta.push(`复现：${Number(item.recurrence ?? 1)} 次`)
  meta.push(`置信：${(Number(item.confidence ?? 0) * 100).toFixed(0)}%`)
  if (item.pinned === true) meta.push('已置顶')
  if (item.accepted === true) meta.push('已采纳')
  if (item.archived === true) meta.push('已归档')
  lines.push(`*${meta.join(' · ')}*`)
  lines.push('')
  if (str(item.detail) !== '') {
    lines.push(str(item.detail))
    lines.push('')
  }
  if (Array.isArray(item.flags) && item.flags.length > 0) {
    lines.push(`> 标记：${item.flags.join('、')}`)
    lines.push('')
  }
  if (includeEvidence && Array.isArray(item.evidence) && item.evidence.length > 0) {
    lines.push('证据：')
    lines.push('')
    for (const ev of item.evidence) {
      const where = [str(ev.sessionId), ev.turn === undefined ? '' : `第 ${ev.turn} 轮`].filter((x) => x !== '').join(' · ')
      const quote = str(ev.quote)
      lines.push(`- ${where === '' ? '（无位置）' : where}${quote === '' ? '' : ` —— “${quote}”`}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 生成完整导出文档。
 * @param options.insights - 洞察数组
 * @param options.scope - 过滤作用域（''=全部）
 * @param options.includeArchived - 是否包含已归档
 */
export function buildExportMarkdown(options = {}) {
  const cfg = options.config ?? {}
  const includeEvidence = cfg.export?.includeEvidence !== false
  const maxEntries = Number(cfg.export?.maxEntries ?? 500)
  let list = Array.isArray(options.insights) ? options.insights.slice() : []
  const scope = str(options.scope)
  if (scope !== '') list = list.filter((i) => str(i.scope) === scope)
  const repo = str(options.repo)
  if (repo !== '') list = list.filter((i) => str(i.repo) === '' || str(i.repo) === repo)
  if (options.includeArchived !== true) list = list.filter((i) => i.archived !== true)

  // 排序：先按作用域（repo 最前），再按类型权重，再按复现次数
  list.sort((a, b) => {
    const sa = str(a.scope) === SCOPES.repo ? 0 : 1
    const sb = str(b.scope) === SCOPES.repo ? 0 : 1
    if (sa !== sb) return sa - sb
    const ra = Number(a.recurrence ?? 1)
    const rb = Number(b.recurrence ?? 1)
    if (ra !== rb) return rb - ra
    return str(a.title).localeCompare(str(b.title))
  })

  const truncated = list.length > maxEntries
  const shown = list.slice(0, maxEntries)
  const body = shown.map((item) => insightToMarkdown(item, { includeEvidence })).join('\n')
  const footer = truncated
    ? `\n---\n\n> ⚠️ 本次导出被截断：共 ${list.length} 条，只导出了前 ${maxEntries} 条（可在配置里调大上限）。\n`
    : ''
  return {
    markdown: `${exportHeader({ ...options, count: shown.length, root: options.root })}${body}${footer}`,
    count: shown.length,
    total: list.length,
    truncated,
    filename: `insights-${stamp(new Date(Number(options.now ?? Date.now())))}.md`,
  }
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 导出目录（数据根下的 exports/）。 */
export function exportsDir(root) {
  return join(root, SUBDIRS.exports)
}

/** 把导出写盘。返回落点。 */
export async function writeExport(options = {}) {
  const root = str(options.root)
  if (root === '') throw new Error('数据根目录为空，无法导出')
  const dir = exportsDir(root)
  await mkdir(dir, { recursive: true })
  const now = Date.now()

  const built = buildExportMarkdown({ ...options, root, now })
  const mdPath = join(dir, built.filename)
  await writeFileAtomic(mdPath, built.markdown)

  const jsonPath = join(dir, built.filename.replace(/\.md$/, '.json'))
  await writeJsonAtomic(jsonPath, {
    version: 1,
    exportedAt: new Date(now).toISOString(),
    count: built.count,
    total: built.total,
    truncated: built.truncated,
    insights: (options.insights ?? []).slice(0, Number(options.config?.export?.maxEntries ?? 500)),
  })

  return { mdPath, jsonPath, count: built.count, total: built.total, truncated: built.truncated }
}

// ---------------------------------------------------------------- 导入

/** 单次导入的条数上限：导入是"恢复一份导出"，不该有比导出上限更大的量。 */
export const IMPORT_MAX_ENTRIES = 5000

/**
 * 解析并校验导入文件（`writeExport` 写出的 JSON，或用户手整理的同形状数据）。
 *
 * **纯函数、只校验不落库** —— 形状校验（version/insights 数组/每条有 id 与标题）
 * 在这里做完，入库交给 `InsightsStore.importEntries`（按 id 插入-或-跳过）。
 * 刻意只认带 id 的条目：导入是恢复操作，没有 id 就没有"重复导入零副作用"的
 * 保证；想新增经验请走复盘或人工录入，不要绕道导入。
 *
 * @param raw - 导出文件的 JSON 文本，或已解析的对象。
 * @returns `{ok:true, insights, rejected, truncatedCount, exportedAt}` 或
 *          `{ok:false, error}`（整体形状不对，一条都不要导）。
 */
export function parseImportBundle(raw) {
  let data = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch (error) {
      return { ok: false, error: `不是合法的 JSON：${error?.message ?? String(error)}` }
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '导入文件形状不对：期望 {version, insights: [...]} 的导出 JSON' }
  }
  if (data.version !== 1 && !(data.version === undefined && data.exportedAt !== undefined)) {
    // version 必须严格是数字 1（"1" / true / [1] 一律拒绝 —— Number 强转的宽松
    // 匹配会把形状不对的文件放进库）。没有 version 字段但带 exportedAt 的，
    // 算早期手工整理的文件，宽容一次。
    return { ok: false, error: `不支持的导出版本：${JSON.stringify(data.version)}（当前只认 version 1）` }
  }
  if (!Array.isArray(data.insights)) {
    return { ok: false, error: '导入文件里没有 insights 数组' }
  }

  const list = data.insights.slice(0, IMPORT_MAX_ENTRIES)
  const rejected = []
  const accepted = []
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i]
    if (!entry || typeof entry !== 'object') { rejected.push({ index: i, reason: '不是对象' }); continue }
    // id 必须是非空字符串：别的类型 String() 强转后不同对象可能撞成同一个 id
    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
      rejected.push({ index: i, reason: '缺少 id（导入只认导出文件里的原样条目）' }); continue
    }
    if (str(entry.title ?? entry.claim) === '') { rejected.push({ index: i, reason: '缺少标题' }); continue }
    accepted.push(entry)
  }
  return {
    ok: true,
    insights: accepted,
    rejected,
    truncatedCount: data.insights.length - list.length,
    exportedAt: str(data.exportedAt),
  }
}

// ---------------------------------------------------------------- skill 草稿

/** skill 名的硬约束（与 dsh-skill 的 SKILL_NAME 完全一致）。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 已废弃的驼峰键：出现即整个文件被宿主丢弃，绝不允许写出来。 */
const FORBIDDEN_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable']

/**
 * 把任意标题/仓库名规范成合法的 skill name。
 *
 * 规则：只留 `[a-z0-9]`，其余一律变 `-`，折叠连续 `-`，去掉首尾 `-`，截断到 60。
 * 结果为空时用兜底名。**不抛异常** —— 生成器宁可给个难看的名字，
 * 也不要因为一个中文仓库名就整个失败。
 */
export function toSkillName(text, fallback = 'project-notes') {
  const raw = str(text).toLowerCase()
  // 中文等非 ASCII：无法音译，用固定的语义前缀而不是丢弃（否则全变成空）
  const ascii = raw.replace(/[^a-z0-9]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  const trimmed = ascii.slice(0, 60).replace(/-+$/, '')
  if (trimmed !== '' && SKILL_NAME_RE.test(trimmed)) return trimmed
  return fallback
}

/** YAML 单行字符串安全化：双引号包裹 + 转义（避免 `:` `#` 引起的解析歧义）。 */
function yamlQuote(text) {
  const s = str(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')
  return `"${s}"`
}

/**
 * 生成一个 SKILL.md 的完整文本。
 *
 * `description` 是**模型唯一的触发文本**（实测：catalog 只渲染 name + description，
 * 且会被压缩到 500 字符），所以它写成"什么时候该用我"的路由句，而不是"这是什么"。
 *
 * @returns { text, name, errors } —— errors 非空时调用方**不该写盘**
 */
export function buildSkillFile(spec = {}) {
  const rawName = str(spec.name)
  const name = SKILL_NAME_RE.test(rawName) ? rawName : toSkillName(rawName, 'repo-conventions')
  const errors = []
  if (name !== rawName) errors.push(`name "${rawName}" 不合规，已规范化为 "${name}"`)

  const description = collapse(str(spec.description)).slice(0, 500)
  if (description === '') errors.push('description 为空：宿主会静默跳过这个技能文件')

  const title = str(spec.title) || description
  const bodyLines = []
  bodyLines.push(`# ${title}`)
  bodyLines.push('')
  if (str(spec.intro) !== '') {
    bodyLines.push(str(spec.intro))
    bodyLines.push('')
  }
  if (Array.isArray(spec.steps) && spec.steps.length > 0) {
    bodyLines.push('## 步骤')
    bodyLines.push('')
    spec.steps.forEach((step, i) => {
      bodyLines.push(`${i + 1}. ${str(step)}`)
    })
    bodyLines.push('')
  }
  if (Array.isArray(spec.rules) && spec.rules.length > 0) {
    bodyLines.push('## 必须遵守')
    bodyLines.push('')
    for (const rule of spec.rules) bodyLines.push(`- ${str(rule)}`)
    bodyLines.push('')
  }
  if (Array.isArray(spec.avoid) && spec.avoid.length > 0) {
    bodyLines.push('## 避免')
    bodyLines.push('')
    for (const item of spec.avoid) bodyLines.push(`- ${str(item)}`)
    bodyLines.push('')
  }
  if (Array.isArray(spec.evidence) && spec.evidence.length > 0) {
    bodyLines.push('## 依据')
    bodyLines.push('')
    bodyLines.push('以下条目由 dsh-evolution 从本仓库过去的开发会话里归纳（附证据，可复核）：')
    bodyLines.push('')
    for (const ev of spec.evidence) {
      const meta = [str(ev.type), Number(ev.recurrence ?? 1) > 1 ? `复现 ${ev.recurrence} 次` : ''].filter((x) => x !== '').join(' · ')
      bodyLines.push(`- ${str(ev.title)}${meta === '' ? '' : `（${meta}）`}`)
      for (const e of ev.evidence ?? []) {
        const where = [str(e.sessionId), e.turn === undefined ? '' : `第 ${e.turn} 轮`].filter((x) => x !== '').join(' · ')
        if (where !== '' || str(e.quote) !== '') {
          bodyLines.push(`  - ${where}${str(e.quote) === '' ? '' : ` —— “${str(e.quote)}”`}`)
        }
      }
    }
    bodyLines.push('')
  }
  if (str(spec.footer) !== '') {
    bodyLines.push(str(spec.footer))
    bodyLines.push('')
  }

  const text = [
    '---',
    `name: ${yamlQuote(name)}`,
    `description: ${yamlQuote(description)}`,
    '---',
    '',
    bodyLines.join('\n').trim(),
    '',
  ].join('\n')

  // 自检：生成出来的东西必须能过宿主的解析规则
  const selfCheck = validateSkillText(text)
  for (const err of selfCheck) errors.push(err)

  return { text, name, errors }
}

/**
 * 按宿主的解析规则自检一份 SKILL.md 文本。
 * 返回错误列表（空 = 合法）。这是"静默失败"的唯一解药：
 * 文件写坏了宿主只会 logger.warn 一句，用户看到的是"技能没生效"。
 */
export function validateSkillText(text) {
  const errors = []
  const raw = String(text ?? '')
  if (raw.startsWith('\uFEFF')) errors.push('文件带有 UTF-8 BOM：宿主会判定为"没有 frontmatter"')
  for (const key of FORBIDDEN_KEYS) {
    if (new RegExp(`^${key}\\s*:`, 'm').test(raw)) errors.push(`frontmatter 含已废弃的键 ${key}：宿主会丢弃整个文件`)
  }
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) {
    errors.push('文件没有换行：宿主需要 frontmatter 段落')
    return errors
  }
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') errors.push(`首行必须是恰好 "---"，实际是 ${JSON.stringify(firstLine)}`)

  const rest = raw.slice(firstLineEnd + 1)
  const closeMatch = rest.match(/^---\s*$/m)
  if (closeMatch === null) {
    errors.push('找不到结束的 "---"（frontmatter 未闭合）')
    return errors
  }
  const yamlBlock = rest.slice(0, closeMatch.index)
  const nameMatch = yamlBlock.match(/^name:\s*(.+)$/m)
  const descMatch = yamlBlock.match(/^description:\s*(.+)$/m)
  if (nameMatch === null) errors.push('frontmatter 缺少 name')
  else {
    const name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
    if (!SKILL_NAME_RE.test(name)) errors.push(`name "${name}" 不符合 /^[a-z0-9]+(?:-[a-z0-9]+)*$/`)
  }
  if (descMatch === null) errors.push('frontmatter 缺少 description')
  else {
    const desc = descMatch[1].trim().replace(/^["']|["']$/g, '')
    if (desc === '') errors.push('description 为空')
  }
  return errors
}

/**
 * 决定 skill 草稿写到哪。
 *
 * @param options.target - config.skills.target
 * @param options.customPath - config.skills.customPath
 * @param options.root - 数据根
 * @param options.repoRoot - 仓库根（target 是仓库内目录时必需）
 * @returns { dir, inRepo, reason } —— inRepo=true 表示"会写进用户的 git 仓库"
 */
export function resolveSkillDir(options = {}) {
  const target = str(options.target)
  const root = str(options.root)
  const repoRoot = str(options.repoRoot)
  const custom = str(options.customPath)

  if (target === 'project-dsh' || target === 'project-agents') {
    if (repoRoot === '') {
      return { dir: '', inRepo: false, reason: '认不出归属仓库根目录，无法写入仓库内 skill 目录（已回退到插件数据目录）', fallback: join(root, 'skills') }
    }
    const sub = target === 'project-dsh' ? join('.dsh', 'skills') : join('.agents', 'skills')
    return { dir: join(repoRoot, sub), inRepo: true, reason: '' }
  }
  if (target === 'custom') {
    if (custom === '') return { dir: join(root, 'skills'), inRepo: false, reason: '自定义路径为空，已回退到插件数据目录' }
    const dir = isAbsolute(custom) ? custom : resolve(repoRoot === '' ? root : repoRoot, custom)
    // 判断"是否落在仓库内"：路径前缀匹配（大小写敏感，Windows 下也不做额外规范化，
    // 宁可保守地认为"在仓库内"从而多要一次确认）
    const inRepo = repoRoot !== '' && dir.startsWith(repoRoot)
    return { dir, inRepo, reason: '' }
  }
  return { dir: join(root, 'skills'), inRepo: false, reason: '' }
}

/**
 * 为一个仓库生成 skill 草稿。
 *
 * 门槛刻意高（config.export.skillMinRecurrence 默认 2，且默认要求
 * `skillRequireAccepted`）：skill 是"可执行流程"，比一条提醒重得多。
 * 把模型的一次性猜测写成流程，比什么都不写更糟。
 */
export function planSkillDrafts(insights, options = {}) {
  const cfg = options.config ?? {}
  const repo = str(options.repo)
  const repoRoot = str(options.repoRoot)
  const minRecurrence = Number(cfg.export?.skillMinRecurrence ?? 2)
  const requireAccepted = cfg.export?.skillRequireAccepted !== false
  const maxDrafts = Number(cfg.export?.skillMaxDrafts ?? 3)

  const eligible = (Array.isArray(insights) ? insights : []).filter((item) => {
    if (!item || item.archived === true) return false
    if (str(item.scope) !== SCOPES.repo && str(item.scope) !== SCOPES.team) return false
    /**
     * 归属过滤：repoRoot 给了就优先按路径精确匹配（撞名仓库不串 ——
     * 两个叫 `api/` 的仓库共享名字，只按 repo 名过滤会把 A 的约束写进 B 的 skill）；
     * 没落回 repo 名。条目自身没有 repoRoot 时按名字兜底（老数据兼容）。
     */
    if (repoRoot !== '' && str(item.repoRoot) !== '' && str(item.repoRoot) !== repoRoot) return false
    if (repoRoot === '' && repo !== '' && str(item.repo) !== '' && str(item.repo) !== repo) return false
    if (repoRoot !== '' && repo !== '' && str(item.repoRoot) === '' && str(item.repo) !== '' && str(item.repo) !== repo) return false
    if (Number(item.recurrence ?? 1) < minRecurrence) return false
    if (requireAccepted && item.accepted !== true) return false
    return true
  })

  // 按类型分组：约束类合成一个"必须遵守"技能，踩坑类合成一个"避坑"技能
  const groups = new Map()
  for (const item of eligible) {
    const key = str(item.type) === 'constraint' ? 'constraints'
      : str(item.type) === 'pitfall' ? 'pitfalls'
        : str(item.type) === 'practice' ? 'practices'
          : 'conventions'
    const list = groups.get(key) ?? []
    list.push(item)
    groups.set(key, list)
  }

  const drafts = []
  for (const [key, items] of groups) {
    if (drafts.length >= maxDrafts) break
    const sorted = items.sort((a, b) => Number(b.recurrence ?? 1) - Number(a.recurrence ?? 1))
    const spec = skillSpecFor(key, sorted, { repo })
    if (spec === undefined) continue
    const built = buildSkillFile(spec)
    drafts.push({
      key,
      name: built.name,
      /** 只有自检通过才允许写盘 —— 宁可少生成一个，也不要留下静默失效的文件。 */
      ok: built.errors.length === 0,
      errors: built.errors,
      text: built.text,
      insights: sorted.map((i) => ({ id: i.id, title: i.title, type: i.type, recurrence: i.recurrence })),
    })
  }
  return drafts
}

/** 按分组类型生成 skill 的内容骨架。 */
function skillSpecFor(key, items, context = {}) {
  const repo = str(context.repo) || '本仓库'
  if (key === 'constraints') {
    return {
      name: toSkillName(`${repo}-constraints`, 'repo-constraints'),
      description: `当你在 ${repo} 里修改代码或提交改动前，用它核对本仓库已经沉淀下来的强制约定（这些约定来自过去的真实事故）。`,
      title: `${repo} 的强制约定`,
      intro: `以下约定由 dsh-evolution 从本仓库过去的开发会话里归纳得到。它们是**参考**：与当前代码或用户要求冲突时以代码和用户为准。`,
      rules: items.map((i) => i.title),
      evidence: items.map(toEvidenceRef),
      footer: '> 由 dsh-evolution 生成。若某条已过时，请在插件面板里删掉它，或直接编辑本文件。',
    }
  }
  if (key === 'pitfalls') {
    return {
      name: toSkillName(`${repo}-pitfalls`, 'repo-pitfalls'),
      description: `当你在 ${repo} 里排查"改了却没用/行为反常"这类问题时，用它先绕开本仓库历史上反复踩过的坑。`,
      title: `${repo} 的常见坑`,
      intro: '这些是过去在这个仓库里真实踩过、且复现过的坑。遇到相似症状时先按这里检查。',
      avoid: items.map((i) => i.title),
      evidence: items.map(toEvidenceRef),
      footer: '> 由 dsh-evolution 生成。若某条已过时，请在插件面板里删掉它，或直接编辑本文件。',
    }
  }
  if (key === 'practices') {
    return {
      name: toSkillName(`${repo}-practices`, 'repo-practices'),
      description: `当你要在 ${repo} 里做一次完整改动（改代码 → 验证 → 提交）时，用它按本仓库验证过的做法执行。`,
      title: `${repo} 的有效做法`,
      intro: '这些做法在本仓库里被实际验证过有效，按顺序执行通常最省时间。',
      steps: items.map((i) => i.title),
      evidence: items.map(toEvidenceRef),
      footer: '> 由 dsh-evolution 生成。若某条已过时，请在插件面板里删掉它，或直接编辑本文件。',
    }
  }
  return {
    name: toSkillName(`${repo}-conventions`, 'repo-conventions'),
    description: `当你在 ${repo} 里做技术选型或需要确认既有约定时，用它查看本仓库已经定下来的决策。`,
    title: `${repo} 的既有决策`,
    intro: '这些决策来自过去的会话记录，用于避免重复讨论已经定过的事。',
    rules: items.map((i) => i.title),
    evidence: items.map(toEvidenceRef),
    footer: '> 由 dsh-evolution 生成。若某条已过时，请在插件面板里删掉它，或直接编辑本文件。',
  }
}

function toEvidenceRef(item) {
  return {
    type: item.type,
    title: item.title,
    recurrence: item.recurrence,
    evidence: (item.evidence ?? []).slice(0, 3),
  }
}

/**
 * 写 skill 草稿到磁盘。
 *
 * @param options.dir - 目标目录（resolveSkillDir 的结果）
 * @param options.drafts - planSkillDrafts 的结果
 * @param options.dryRun - true 时只返回"会写什么"，不落盘（面板确认前预览用）
 */
export async function writeSkillDrafts(options = {}) {
  const dir = str(options.dir)
  const drafts = Array.isArray(options.drafts) ? options.drafts : []
  const written = []
  const skipped = []
  if (dir === '') return { written, skipped: drafts.map((d) => ({ name: d.name, reason: '目标目录为空' })) }

  for (const draft of drafts) {
    if (draft.ok !== true) {
      skipped.push({ name: draft.name, reason: `格式自检未通过：${(draft.errors ?? []).join('；')}` })
      continue
    }
    const target = join(dir, draft.name, 'SKILL.md')
    if (options.dryRun === true) {
      written.push({ name: draft.name, path: target, dryRun: true, chars: draft.text.length })
      continue
    }
    try {
      await writeFileAtomic(target, draft.text)
      written.push({ name: draft.name, path: target, chars: draft.text.length })
    } catch (error) {
      skipped.push({ name: draft.name, reason: `写入失败：${error?.message ?? String(error)}` })
    }
  }
  return { written, skipped }
}

/** 列出已有的 skill 草稿目录（面板显示"我生成过什么"）。 */
export async function listSkillDirs(dir) {
  const target = str(dir)
  if (target === '') return []
  try {
    const entries = await readdir(target, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => join(target, e.name))
  } catch {
    return []
  }
}

function collapse(text) {
  return str(text).replace(/\s+/g, ' ').trim()
}
