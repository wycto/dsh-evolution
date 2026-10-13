/**
 * dsh-evolution — 配置存储
 *
 * 行为约定（都是"用户会踩到"的场景，所以写清楚）：
 *
 * - **懒加载 + 变更检测**：每次读配置前比对文件 mtime，用户在外面手改了
 *   config.json 也能生效，不需要重启 DSH，也不需要引入文件监听
 *   （DSH 自己已经在递归监听 home 目录，再挂一个 chokidar 是没必要的开销）。
 *
 * - **坏配置显式暴露，不静默重建**：文件存在但 JSON 解析失败时，备份成
 *   `config.json.corrupt.<时间戳>` 再用默认值继续跑，并把这件事记在
 *   `lastError` 里让面板能显示。直接当空配置处理会让用户以为"我的设置被重置了"
 *   却找不到原因 —— 这是记忆类插件最容易让人失去信任的失效方式。
 *
 * - **写入原子**：见 storage.writeJsonAtomic。
 */
import { stat } from 'node:fs/promises'
import { configFile, resolveRootDir, str } from './paths.js'
import { defaultConfig, normalizeConfig } from './config.js'
import { writeJsonAtomic } from './storage.js'

/** 取点号路径的值（'review.enabled' → cfg.review.enabled）。 */
export function getPath(obj, path) {
  const parts = String(path).split('.')
  let cur = obj
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = cur[p]
  }
  return cur
}

/** 按点号路径写值，返回新对象（不改原对象，避免面板读到半更新状态）。 */
export function setPath(obj, path, value) {
  const parts = String(path).split('.')
  const root = { ...obj }
  let cur = root
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]
    const next = cur[key]
    cur[key] = next !== null && typeof next === 'object' && !Array.isArray(next) ? { ...next } : {}
    cur = cur[key]
  }
  cur[parts[parts.length - 1]] = value
  return root
}

/**
 * 配置存储。一个实例管一份 config.json。
 *
 * ⚠️ 这里有一个必须小心的**循环依赖**：数据根目录由配置里的 `dataDir` 决定，
 * 而"配置文件在哪"又由数据根目录决定。如果让 `file()` 去调 `current()`，
 * 就会变成 current → loadSync → file → rootDir → current 的无限递归
 * （冒烟测试抓出来过一次）。
 *
 * 解法：单开一条**只读 dataDir 一个键**的轻量通道 `dataDirSetting()`，
 * 它自带缓存、绝不回调 `current()`。递归因此被切断。
 */
export class ConfigStore {
  /**
   * @param options.logger - 宿主 logger（可选），用于告警。
   * @param options.env - 环境变量表，默认 process.env。
   */
  constructor(options = {}) {
    this.logger = options.logger
    this.env = options.env ?? process.env
    /** @type {object|undefined} 已归一化的配置缓存。 */
    this.cached = undefined
    /** 缓存对应的文件 mtime（毫秒）；用于判断"外面改过没有"。 */
    this.cachedMtime = -1
    /** 最近一次加载遇到的错误（面板显示用）；成功加载后清空。 */
    this.lastError = ''
    /**
     * 只读 dataDir 的缓存，切断 file() 与 current() 的递归。
     * undefined = 还没读过；'' = 读过且为空（用默认目录）。
     * @type {string|undefined}
     */
    this.dataDirCache = undefined
  }

  /**
   * 只读取配置里的 dataDir 一项（不归一化、不触碰 current()）。
   * 文件不存在或坏掉时返回空串（走默认目录），并把原因记进 lastError。
   */
  dataDirSetting() {
    if (this.dataDirCache !== undefined) return this.dataDirCache
    const { readFileSync } = loadFsSync()
    // 先按"无 dataDir"解析出候选路径：这正是我们要读的那个文件
    const probe = configFile(resolveRootDir('', this.env))
    try {
      const raw = readFileSync(probe, 'utf8')
      const parsed = JSON.parse(raw)
      this.dataDirCache = typeof parsed?.dataDir === 'string' ? parsed.dataDir.trim() : ''
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        // 坏文件或读不了：按默认目录继续，错误留给 loadSync 正式上报
        this.lastError = this.lastError || `读取配置失败：${error?.message ?? String(error)}`
      }
      this.dataDirCache = ''
    }
    return this.dataDirCache
  }

  /** 数据根目录（依赖配置里的 dataDir）。 */
  rootDir() {
    return resolveRootDir(this.dataDirSetting(), this.env)
  }

  /** 配置文件绝对路径。 */
  file() {
    return configFile(this.rootDir())
  }

  /**
   * 当前配置。会先做一次（很便宜的）mtime 检查，发现外部改动就重载。
   * @returns {object} 归一化后的配置。
   */
  current() {
    if (this.cached === undefined) return this.loadSync()
    if (this.mtimeChangedSync()) {
      const loaded = this.loadSync()
      return loaded
    }
    return this.cached
  }

  /** mtime 是否变了（同步 stat，几十微秒级，不值得异步）。 */
  mtimeChangedSync() {
    try {
      // 这里刻意用同步 API：current() 被大量同步调用点依赖（注入文本求值等），
      // 而 statSync 在本地文件系统上是微秒级，不构成性能问题。
      const { statSync } = loadFsSync()
      return statSync(this.file()).mtimeMs !== this.cachedMtime
    } catch {
      // 文件不存在/读不到：如果之前有缓存，可能被删了，保守重载一次
      return this.cachedMtime !== -1
    }
  }

  /**
   * 同步加载。首次加载与外部改动都走这里。
   * @returns {object} 归一化配置（加载失败时为默认配置）。
   */
  loadSync() {
    const { readFileSync, statSync } = loadFsSync()
    const file = this.file()
    let raw
    let mtime = -1
    try {
      raw = readFileSync(file, 'utf8')
      mtime = statSync(file).mtimeMs
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // 还没写过配置：用默认值，mtime 保持 -1，下次写文件后会触发一次重载
        this.cached = normalizeConfig(defaultConfig())
        this.cachedMtime = -1
        this.lastError = ''
        return this.cached
      }
      this.lastError = `读取配置失败：${error?.message ?? String(error)}`
      this.logger?.warn?.(`[dsh-evolution] ${this.lastError}`)
      this.cached = normalizeConfig(defaultConfig())
      this.cachedMtime = -1
      return this.cached
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      // 坏配置：备份 + 默认值 + 记录错误（绝不静默当空配置）
      this.lastError = `配置文件解析失败（已备份原文件）：${error?.message ?? String(error)}`
      this.logger?.warn?.(`[dsh-evolution] ${this.lastError}`)
      this.backupCorruptSync(file, raw)
      this.cached = normalizeConfig(defaultConfig())
      this.cachedMtime = -1
      return this.cached
    }

    this.cached = normalizeConfig(parsed)
    this.cachedMtime = mtime
    this.lastError = ''
    return this.cached
  }

  /** 把坏配置挪到 .corrupt.<时间戳>，保留现场供用户/作者排查。 */
  backupCorruptSync(file, raw) {
    try {
      const { writeFileSync, renameSync } = loadFsSync()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dest = `${file}.corrupt.${stamp}`
      writeFileSync(dest, raw, 'utf8')
      renameSync(file, `${file}.bad`)
      this.logger?.info?.(`[dsh-evolution] 坏配置已备份至 ${dest}`)
    } catch (error) {
      this.logger?.warn?.(`[dsh-evolution] 备份坏配置失败：${error?.message ?? String(error)}`)
    }
  }

  /**
   * 应用一批改动（点号路径 → 值），归一化后原子落盘。
   *
   * **先归一化再写**：这样磁盘上的 config.json 永远是合法且完整的，
   * 用户打开看到的不是"面板里能填但落盘是脏的"。
   * @param patch - 形如 { 'review.enabled': true, 'privacy.customWords': [...] }
   * @returns {object} 写回并归一化后的完整配置。
   */
  async update(patch) {
    let next = this.current()
    for (const [path, value] of Object.entries(patch ?? {})) {
      next = setPath(next, path, value)
    }
    next = normalizeConfig(next)
    const file = this.file()
    await writeJsonAtomic(file, next)

    // 写完后立刻刷新缓存与 mtime，避免紧接着的 current() 又去 stat 一次。
    // dataDirCache 也要失效：用户可能刚把数据目录改到别处，缓存会让 file() 指回老路径。
    this.dataDirCache = undefined
    this.cached = next
    try {
      const { statSync } = loadFsSync()
      this.cachedMtime = statSync(file).mtimeMs
    } catch {
      this.cachedMtime = -1
    }
    this.lastError = ''
    return next
  }

  /** 恢复默认（写回一份完整默认配置）。 */
  async reset() {
    return this.update(stripToPatch(defaultConfig()))
  }

  /** 磁盘上配置文件是否存在。 */
  async exists() {
    try {
      await stat(this.file())
      return true
    } catch {
      return false
    }
  }
}

/** 把完整配置摊平成 patch（点号路径 → 值），供 reset 使用。 */
function stripToPatch(obj, prefix = '') {
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, stripToPatch(value, path))
    } else {
      out[path] = value
    }
  }
  return out
}

/**
 * 惰性拿 node:fs 的同步 API。
 * 单独包一层是为了让本模块在只做类型检查/打包时不必在顶层 import 同步 API
 * （打包器对 mixed 导入的摇树处理不一致），也便于测试替身注入。
 */
let cachedFsSync
function loadFsSync() {
  if (cachedFsSync === undefined) {
    // eslint-disable-next-line no-undef
    cachedFsSync = globalThis.process?.getBuiltinModule?.('node:fs')
      ?? undefined
  }
  if (cachedFsSync === undefined) throw new Error('node:fs 不可用')
  return cachedFsSync
}

export { str }
