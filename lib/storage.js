/**
 * dsh-evolution — 文件存储原语
 *
 * 三条硬规则，全部来自"进程随时会被强杀"这个前提（DSH 用户关窗口、重启编辑器、
 * 任务管理器结束进程都比优雅退出常见得多）：
 *
 *   1. **覆盖写必须原子**：临时文件 + rename。直接 writeFile 一个 JSON 配置，
 *      写到一半被杀就是一个截断的坏文件，下次启动直接读不出来。
 *   2. **追加写必须崩溃安全**：NDJSON 一行一事件，appendFile 追加。
 *      最坏情况丢最后一行，而不会损坏整个文件。
 *   3. **坏行必须可跳过**：读 NDJSON 时逐行 JSON.parse，单行坏了记一处告警继续，
 *      绝不让一行脏数据把整个账本变成不可读。
 *
 * 这里刻意只做原语，不做"业务重试/降级"判断 —— 那些留在调用方，
 * 因为不同数据的失败后果不同（配置读不出来要显式报错，账本少一行可以静默容忍）。
 */
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 原子写临时文件的后缀（与目标同目录，保证 rename 不跨设备）。 */
const TMP_SUFFIX = '.tmp'

/** 进程内自增序号：保证同一进程里两次并发写入不会算出同一个临时文件名。 */
let tmpSeq = 0

/**
 * 原子写文本文件：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 为什么临时文件必须与目标**同目录**：rename 只在同一文件系统内是原子的，
 * 写到系统临时区再 rename 过去会退化成"复制 + 删除"，中途被杀照样截断。
 * @param file - 目标绝对路径。
 * @param text - 完整内容。
 */
export async function writeFileAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true })
  /**
   * ⚠️ 临时文件名必须**每次调用都不同**（pid + 自增序号 + 随机尾）。
   *
   * 只用 pid 是不够的：同一个进程里两个异步写入（比如两次复盘收尾同时落
   * state.json）会算出同一个临时路径 —— 一个还在写、另一个已经 rename 走了，
   * 前者的 rename 就会 ENOENT 抛错，或者两者内容交错。这类 bug 只在并发时出现，
   * 平时完全看不到。
   */
  tmpSeq += 1
  const tmp = `${file}.${process.pid}.${tmpSeq}.${Math.random().toString(36).slice(2, 8)}${TMP_SUFFIX}`
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  } catch (error) {
    // 清理残留临时文件，但不掩盖原始错误（清理失败本身不是主要矛盾）
    try { await unlink(tmp) } catch { /* 已被 rename 或本就不存在 */ }
    throw error
  }
}

/** 原子写 JSON（2 空格缩进 —— 用户会直接打开看，可读性优先于体积）。 */
export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 读 JSON。文件不存在返回 undefined（"还没写过"是正常状态，不是错误）；
 * 文件存在但解析失败会**抛出**，由调用方决定是报错还是备份后重建 ——
 * 静默把坏配置当成空配置，会让用户以为"我的设置被重置了"而找不到原因。
 */
export async function readJson(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(raw)
}

/** 判断路径是否存在（不区分文件/目录）。 */
export async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 追加一行 NDJSON。空行/null/undefined 直接跳过，避免写进无意义的空行。 */
export async function appendNdjson(file, record) {
  if (record === undefined || record === null) return
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * 读 NDJSON。返回 { records, badLines }。
 *
 * **不抛异常**：账本是要长期累积的数据，一行坏掉不该让整个文件读不出来。
 * 坏行数量回传给调用方，由面板决定要不要提示用户（比如"有 3 行无法解析"）。
 * @param file - NDJSON 文件路径。
 * @param options.onRecord - 可选，逐条回调。给大批量扫描用，避免一次性建大数组。
 */
export async function readNdjson(file, options = {}) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { records: [], badLines: 0 }
    throw error
  }

  const { onRecord } = options
  const records = []
  let badLines = 0
  // 按行切分；末尾换行会产生一个空元素，空行直接忽略不算坏行
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const parsed = JSON.parse(text)
      if (typeof onRecord === 'function') onRecord(parsed)
      else records.push(parsed)
    } catch {
      badLines += 1
    }
  }
  return { records, badLines }
}

/**
 * 按日期分片的账本文件路径。
 *
 * 按天切分而不是单一大文件：老数据可以直接整片归档/删除，不必重写大文件；
 * 出问题时也容易定位"是哪天开始的"。
 * @param dir - 账本目录。
 * @param day - YYYY-MM-DD。
 */
export function ledgerFileFor(dir, day) {
  return join(dir, `${day}.ndjson`)
}

/**
 * 本地日期键（YYYY-MM-DD）。**用本地时区**而不是 UTC：
 * 用户看账本时想的都是"我今天干了什么"，UTC 会导致跨零点的那几小时归错天。
 * @param ms - epoch 毫秒，缺省取当前时间。
 */
export function dayKey(ms) {
  const d = ms === undefined ? new Date() : new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 保留期的截止日（返回值本身**保留**：分片 day >= cutoff 都留下）。
 *
 * 语义："保留最近 N 天" = 保留今天往前数 N 个**本地**自然日，
 * 所以 cutoff = 今天 - (N-1)。N=1 → 只留今天；N=30 → 留今天到 29 天前。
 *
 * 为什么必须本地时区、还锚定"今天正午"：分片 day 键是本地日期，如果用
 * `toISOString()` 算截止日（那是 UTC），非零时区下两个口径会差一天 ——
 * 表现为"明明过了保留期却晚一天才删"。先取今天本地正午再回推整 24h 的倍数，
 * 正午在任何常见时区回推后都不会跨进另一个本地日期。
 * @param retentionDays - 保留天数（调用方已保证 > 0）。
 */
export function retentionCutoff(retentionDays) {
  const n = Math.max(1, Math.trunc(Number(retentionDays) || 1))
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  return dayKey(noon.getTime() - (n - 1) * 86400000)
}
