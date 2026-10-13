/**
 * dsh-evolution — 本地开发守护脚本（镜像同步 + 客户端重建，二合一）
 *
 * 背景：本仓库落在 /mnt/*（WSL 9p 挂载）上，该文件系统不支持 inotify，
 * dsh 的 cordis-hmr（chokidar）永远收不到上面的改动事件，宿主半部无法热重载。
 * 解法：把仓库**镜像**到 ext4（~ 下与 dsh-dock 并排），profile link 指向镜像；
 * 镜像上的写入走 ext4 → inotify 正常 → 双半部自动刷新链路全部打通：
 *
 *   你保存源码（本仓库，F:）
 *     → 本脚本 ≤1s 轮询发现（stat 轮询，不依赖文件系统事件）
 *     → client/ 源变化：重建 client/dist/index.js
 *     → 任何变化：rsync 增量同步到镜像（ext4）
 *     → cordis-hmr 看到镜像 lib/ 变了 → 热重载宿主半部（无需重启）
 *     → dsh-client-hmr 看到镜像 client/dist 变了 → SSE 推浏览器换新版
 *
 * 注意：**单向同步**。镜像目录是派生产物，不要直接编辑镜像里的文件。
 *
 * 用法：npm run dev（或 node scripts/dev-watch.mjs），Ctrl+C 退出。
 */
import { spawn, execFile } from 'node:child_process'
import { readdirSync, lstatSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 镜像落点：ext4，与 dsh-dock 并排；profile 的 link 与 hmr root 都指这里。
 *  默认值只是占位——实际机器必须用 DSH_EVOLUTION_MIRROR 指到真实镜像目录。 */
const MIRROR = process.env.DSH_EVOLUTION_MIRROR ?? join(process.env.HOME ?? '', 'dev/code/gitea/wycto/dsh-evolution')

/** 不进镜像的目录（同步与监视都排除）。 */
const EXCLUDES = new Set(['.git', 'node_modules', 'release', '.idea', '.mimosa'])
const POLL_MS = 1000
const DEBOUNCE_MS = 200

// ---------- 状态 ----------
/** 全仓库签名表（不含 EXCLUDES）：relPath → "mtimeMs:size" */
const sigs = new Map()
/** client/ 源文件签名表（不含 dist）：relPath → "mtimeMs:size" */
const clientSigs = new Map()
let needSync = false
let needBuild = false
let working = false
let timer = null
/** rsync 失败后的最早重试时刻（失败退避，避免刷日志/空转）。 */
let syncRetryAt = 0
const SYNC_RETRY_BACKOFF_MS = 5000

function scanDir(dir, onFile) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (EXCLUDES.has(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      scanDir(p, onFile)
    } else if (entry.isFile()) {
      onFile(p)
    }
  }
}

function sigOf(p) {
  try {
    const st = lstatSync(p)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

/** 一轮扫描：更新两张签名表，置位 needSync / needBuild。 */
function scan() {
  const seen = new Map()
  scanDir(SRC, (p) => {
    const sig = sigOf(p)
    if (sig === null) return
    const rel = relative(SRC, p)
    seen.set(rel, sig)
    if (sigs.get(rel) !== sig) {
      needSync = true
    }
    // client/ 源（不含 dist 产物）触发客户端重建
    if (rel.startsWith(`client${sep}`) && !rel.startsWith(`client${sep}dist${sep}`) && /\.(js|jsx|css|json)$/.test(rel)) {
      if (clientSigs.get(rel) !== sig) needBuild = true
    }
  })
  // 删除检测：原来有、现在没了的，也触发同步（rsync --delete 会清掉镜像侧）
  for (const rel of sigs.keys()) {
    if (!seen.has(rel)) needSync = true
  }
  for (const rel of clientSigs.keys()) {
    if (!seen.has(rel)) needBuild = true
  }
  sigs.clear()
  for (const [k, v] of seen) sigs.set(k, v)
  clientSigs.clear()
  for (const [k, v] of seen) {
    if (k.startsWith(`client${sep}`) && !k.startsWith(`client${sep}dist${sep}`)) clientSigs.set(k, v)
  }
}

function schedule() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    work()
  }, DEBOUNCE_MS)
}

async function work() {
  if (working) return
  const syncBlocked = needSync && Date.now() < syncRetryAt
  if ((!needSync || syncBlocked) && !needBuild) return
  working = true
  try {
    if (needBuild) {
      needBuild = false
      const t0 = Date.now()
      console.log('[dev] rebuild client/dist ...')
      await new Promise((resolvePromise) => {
        const child = spawn(process.execPath, [join(SRC, 'client', 'build.mjs')], { stdio: 'inherit' })
        child.on('exit', (code) => {
          if (code === 0) console.log(`[dev] client rebuilt in ${Date.now() - t0}ms`)
          else console.error(`[dev] client build exited ${code} — 浏览器继续用上一份产物`)
          resolvePromise()
        })
      })
      // 重建改了 dist → 一定需要同步
      needSync = true
    }
    if (needSync && !syncBlocked) {
      needSync = false
      const t0 = Date.now()
      const args = [
        '-a', '--delete', '--quiet',
        ...[...EXCLUDES].map((e) => `--exclude=${e}`),
        `${SRC}${sep}`, `${MIRROR}${sep}`,
      ]
      try {
        await execFileP('rsync', args)
        syncRetryAt = 0
        console.log(`[dev] mirror synced in ${Date.now() - t0}ms → ${MIRROR}（hmr 随即接管）`)
      } catch (e) {
        const firstLine = String(e.message || e).split('\n').filter((l) => l.trim() && !l.startsWith('rsync ')).pop()
        console.error(`[dev] rsync failed（${SYNC_RETRY_BACKOFF_MS / 1000}s 后重试）: ${firstLine || e.message}`)
        needSync = true
        syncRetryAt = Date.now() + SYNC_RETRY_BACKOFF_MS
      }
    }
  } finally {
    working = false
    // 工作期间又攒了改动 → 立刻再跑一轮
    if (needSync || needBuild) schedule()
  }
}

// 启动：建基线 → 首次构建 → 首次同步 → 进入轮询。
console.log(`[dev] src    = ${SRC}`)
console.log(`[dev] mirror = ${MIRROR}`)
scan()
needBuild = true
needSync = true
await work()
setInterval(() => {
  scan()
  schedule()
}, POLL_MS)
console.log(`[dev] 监视中（每 ${POLL_MS}ms 轮询，Ctrl+C 退出）`)
