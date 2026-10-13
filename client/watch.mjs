/**
 * dsh-evolution — 浏览器半开发 watch：client/ 源码一变就重建 dist/index.js。
 *
 * 链路：本脚本重写 client/dist/index.js
 *   → DSH 的 dsh-client-hmr 轮询到 bundle 变化（默认 500ms 一档）
 *   → 浏览器原地热替换本插件，**不用整页刷新**（React 状态会重置，会话数据保留）。
 *
 * 注意：这只覆盖浏览器半。改宿主半（lib/）仍需重启 `dsh web`，
 * 因为 cordis 的 host HMR 在官方 profile 里是关的。
 *
 * 用法：npm run dev
 */
import { watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = join(root, 'client')
const buildScript = join(clientDir, 'build.mjs')

const DEBOUNCE_MS = 120

let timer = null
let building = false
let queued = false

function rebuild() {
  if (building) {
    queued = true
    return
  }
  building = true
  const child = spawn(process.execPath, [buildScript], { stdio: 'inherit' })
  child.on('exit', (code) => {
    building = false
    const time = new Date().toLocaleTimeString()
    if (code === 0) console.log(`[watch] ${time} 重建完成，浏览器会自动热替换`)
    else console.error(`[watch] ${time} 构建失败 (exit ${code})，修复后保存会自动重试`)
    if (queued) {
      queued = false
      rebuild()
    }
  })
}

console.log(`[watch] 监听 ${clientDir}（忽略 dist/），Ctrl+C 停止`)
console.log('[watch] 前提：dsh web 已在跑，且插件已 link 安装到 web profile')

// 先建一次，保证 dist 与源码同步（脚本可能刚改过而没手动 build）
rebuild()

watch(clientDir, { recursive: true }, (_event, filename) => {
  // 忽略构建产物自身，避免重建 → 触发 → 再重建的死循环
  if (!filename || filename.split('/').includes('dist')) return
  clearTimeout(timer)
  timer = setTimeout(rebuild, DEBOUNCE_MS)
})
