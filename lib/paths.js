/**
 * dsh-evolution — 数据目录与路径解析
 *
 * 一切数据都在磁盘上、都是人可读的，路径必须**可解释、可打印、可搬走**：
 * 面板上会把这个根目录原样显示给用户（"你的数据在哪"），所以这里不允许有
 * 任何"看环境变量猜一下"的隐式行为 —— 解析顺序写死，且可被显式覆盖。
 *
 * 解析优先级（高 → 低）：
 *   1. 配置项 dataDir（面板里填）
 *   2. 环境变量 DSH_EVOLUTION_HOME
 *   3. <home>/.dsh-evolution
 *
 * 刻意不用 XDG_DATA_HOME：Windows 上大多数用户没有这个变量，一旦回退不一致，
 * 用户会在两台机器上看到两个不同的数据目录，而"我的数据在哪"是本插件最核心的
 * 信任承诺之一，不能出现"取决于环境变量"这种事。
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 默认目录名（放在用户主目录下，便于用户自己备份/查看/迁移）。 */
export const DEFAULT_DIR_NAME = '.dsh-evolution'

/** 环境变量名：给"我想把数据放别处"的用户一个不改配置就能改的开关。 */
export const ENV_HOME = 'DSH_EVOLUTION_HOME'

/** 目录内的固定子路径 —— 集中定义，避免各处拼字符串拼歪。 */
export const SUBDIRS = Object.freeze({
  /** 逐日账本（NDJSON，一行一事件）。 */
  ledger: 'ledger',
  /** L1 单会话抽取产物。 */
  observations: 'observations',
  /** 洞察草稿（默认落点，等用户决定是否导出到仓库）。 */
  drafts: 'drafts',
  /** 已晋升/导出的快照留档（便于"我导出过什么"可查）。 */
  exports: 'exports',
})

/** 目录内的固定文件名。 */
export const FILES = Object.freeze({
  config: 'config.json',
  state: 'state.json',
})

/**
 * 解析本插件的根目录。**纯函数**（除了读环境变量），不做任何 IO，
 * 也不创建目录 —— 调用方需要时再 mkdir，这样"只看路径不落盘"的场景是安全的。
 * @param dataDirOverride - 配置项 dataDir；空串/undefined 表示未配置。
 * @param env - 环境变量表（默认 process.env），便于测试注入。
 * @returns 绝对路径。
 */
export function resolveRootDir(dataDirOverride, env = process.env) {
  const over = str(dataDirOverride)
  if (over !== '') return isAbsolute(over) ? over : resolve(over)

  const fromEnv = str(env?.[ENV_HOME])
  if (fromEnv !== '') return isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv)

  return join(homedir(), DEFAULT_DIR_NAME)
}

/** 根目录下的账本目录。 */
export function ledgerDir(root) {
  return join(root, SUBDIRS.ledger)
}

/** 根目录下的配置文件路径。 */
export function configFile(root) {
  return join(root, FILES.config)
}

/** 根目录下的水位文件路径。 */
export function stateFile(root) {
  return join(root, FILES.state)
}

/**
 * 全部需要保证存在的目录。返回列表而不是在这里创建：
 * 让调用方（存储层）决定创建时机与失败处理，路径模块保持无副作用。
 */
export function allDirs(root) {
  return [root, ...Object.values(SUBDIRS).map((d) => join(root, d))]
}

/** 把任意值规整成"去空白的字符串"，undefined/null 都变空串。 */
export function str(v) {
  if (v === undefined || v === null) return ''
  return String(v).trim()
}
