/**
 * dsh-evolution — 仓库定位
 *
 * 归属判定是"记忆会不会串味"的唯一防线，所以这里的原则非常明确：
 *
 *   **宁可认不出，也不要认错。**
 *
 * 认错的代价是把 A 仓库的会话写进 B 仓库的记忆里 —— 而记忆会被注入到
 * 所有人的上下文，错误因此被放大。认不出的代价只是少记一次。
 *
 * 判定用 `git rev-parse --show-toplevel` 而不是查 `.git` 目录：
 * 后者在 worktree / submodule（`.git` 是文件而非目录）场景下会漏判。
 *
 * 这些函数都会 spawn 子进程，**绝不能在 session/event 回调里同步调用**。
 * 调用点都在异步路径上（会话建立时解析一次并缓存，或后台提交时解析）。
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** git 调用超时。git 正常情况下是毫秒级，超时说明环境有问题，不该拖住会话。 */
const GIT_TIMEOUT_MS = 4000

/**
 * 工作区扫描上限：一级子目录最多探测多少个。
 *
 * 多项目工作区根很常见（一个目录下几十个仓库），但也不能无限扫 ——
 * 有人会把 home 目录当归档区。超过上限的部分直接不参与候选，
 * 并且**在上限被触发时返回 truncated 标记**，让面板能提示用户
 * "有目录没被扫描到"，而不是静默漏判。
 */
export const WORKSPACE_SCAN_MAX = 128

/**
 * 解析 cwd 所属的 git 仓库信息。
 * @param cwd - 会话的绝对工作目录。
 * @returns 仓库信息，或 undefined（不在任何 git 仓库内）。
 */
export async function detectRepo(cwd) {
  const dir = typeof cwd === 'string' ? cwd.trim() : ''
  if (dir === '') return undefined

  let top
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeout: GIT_TIMEOUT_MS })
    top = String(stdout).trim()
  } catch {
    // 不在仓库内 / git 不存在 / 超时：一律当作"认不出"
    return undefined
  }
  if (top === '' || top === '/') return undefined

  const repoName = basename(top)
  if (repoName === '') return undefined

  let branch = ''
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: top, timeout: GIT_TIMEOUT_MS })
    branch = String(stdout).trim()
  } catch {
    // 空仓库（还没有 commit）拿不到 HEAD：不影响归属，留空
  }

  let gitUrl = ''
  try {
    const { stdout } = await run('git', ['-C', top, 'remote', 'get-url', 'origin'], { timeout: GIT_TIMEOUT_MS })
    gitUrl = String(stdout).trim()
  } catch {
    // 没有 origin：本地仓库很正常，留空
  }

  let gitUser = ''
  try {
    const { stdout } = await run('git', ['-C', top, 'config', 'user.name'], { timeout: GIT_TIMEOUT_MS })
    gitUser = String(stdout).trim()
  } catch {
    // 没配 user.name：留空
  }

  return { repoName, root: top, branch, gitUrl, gitUser }
}

/**
 * 工作区模式：cwd 本身不是 git 仓库时，扫描一级子目录，收集其中的仓库名。
 *
 * 并行 spawn：几十个目录逐个串行会到秒级，并行后总耗时基本等于最慢的那个。
 * 单个失败静默跳过 —— 注入和归属都是尽力而为，不该因为一个坏目录整体失败。
 *
 * @param cwd - 会话的绝对工作目录。
 * @returns { names: string[], scanned: number, truncated: boolean }
 */
export async function detectWorkspaceRepos(cwd) {
  const dir = typeof cwd === 'string' ? cwd.trim() : ''
  if (dir === '') return { names: [], scanned: 0, truncated: false }

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { names: [], scanned: 0, truncated: false }
  }

  const allDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
  const truncated = allDirs.length > WORKSPACE_SCAN_MAX
  const dirs = allDirs.slice(0, WORKSPACE_SCAN_MAX)

  const names = new Set()
  await Promise.all(dirs.map(async (d) => {
    const p = join(dir, d.name)
    try {
      const { stdout } = await run('git', ['-C', p, 'rev-parse', '--show-toplevel'], { timeout: GIT_TIMEOUT_MS })
      const name = basename(String(stdout).trim())
      if (name !== '' && name !== '/') names.add(name)
    } catch {
      // 非 git 目录或调用失败：跳过
    }
  }))

  return { names: [...names], scanned: dirs.length, truncated }
}
