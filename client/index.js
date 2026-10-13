/**
 * dsh-evolution — Client 半（浏览器面板）
 *
 * 这个面板承担的不只是"配置界面"，它还承担**信任建立**：
 * 用户凭什么相信一个会读自己全部开发会话的插件？只有一条路 ——
 * 让他**亲眼看到**存了什么、脱敏前后差在哪、数据落在磁盘哪个目录、有没有往外发。
 * 所以「数据」和「隐私」两页不是附属功能，是和「配置」同等的一等公民。
 *
 * 与 Host 的通信：静态安装的 npm 插件没有 host 全局，走同源 HTTP 路由
 * `POST <挂载前缀>/dsh-evolution/<method>`，信封 `{ ok, data }` / `{ ok, error }`。
 */
import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react'

/** 插件 id，必须与 package.json 的 name 完全一致。 */
const PLUGIN_ID = 'dsh-evolution'
/**
 * 面板版本。占位符由 client/build.mjs 在构建时替换为 package.json 的 version ——
 * 版本号只认 package.json 一个来源，发版只改一处，不可能再出现三处不一致。
 */
const CLIENT_VERSION = '__DVEV_VERSION__'
/**
 * 路由前缀（相对路径），路径段必须与 host 半 routes.js 的 ROUTE_PREFIX 一致。
 *
 * ⚠️ 这里**不能**写成根绝对路径 `/dsh-evolution`：宿主可能被部署在子路径下
 * （本机经 nginx 挂在 `/ui/`，由 nginx 剥掉前缀后转发到 origin-root）。
 * 面板由 `window.__ModuleLoader__` 以相对 URL 加载，页面里有 `<base href="./">`，
 * 所以用相对路径时浏览器会正确拼成 `/ui/dsh-evolution/...`；而根绝对路径会被
 * nginx 的兜底 `location /` 302 回应用入口，fetch 跟随重定向拿到 SPA 的
 * HTML(200)，`res.json()` 解析失败 —— 表现为面板所有请求都报 `HTTP 200`。
 *
 * 宿主自身注册的就是 origin-root 前缀（`webServer.register({ path: ROUTE_PREFIX })`），
 * 两种部署下相对路径都指向同一处，因此这是唯一无需配置的写法。
 */
const ROUTE = 'dsh-evolution'

// ---------- 跨组件共享的面板开关状态 ----------
let panelOpen = false
const openListeners = new Set()
function setPanelOpen(v) {
  panelOpen = !!v
  for (const fn of openListeners) fn(panelOpen)
}
function usePanelOpen() {
  const [open, setOpen] = useState(panelOpen)
  useEffect(() => {
    const fn = (v) => setOpen(v)
    openListeners.add(fn)
    return () => openListeners.delete(fn)
  }, [])
  return open
}

// ---------- 确认对话框（替代 window.confirm 的插件内弹窗） ----------
// 与面板开关同一模式：模块级状态 + 监听器，askConfirm 返回 Promise<boolean>，
// 调用处 `if (!(await askConfirm({...}))) return` 即可，体验和原生 confirm 一样直白。
let confirmState = null
const confirmListeners = new Set()
function askConfirm({ title, body = '', okLabel = '确定', cancelLabel = '取消', danger = false }) {
  // 已有未决弹窗时新的请求直接拒掉（等同点取消），避免互相顶掉后 Promise 悬空
  if (confirmState) return Promise.resolve(false)
  return new Promise((resolve) => {
    confirmState = { title, body, okLabel, cancelLabel, danger, resolve }
    for (const fn of confirmListeners) fn(confirmState)
  })
}
function settleConfirm(ok) {
  const cur = confirmState
  confirmState = null
  for (const fn of confirmListeners) fn(null)
  if (cur) cur.resolve(ok)
}

function ConfirmHost() {
  const [req, setReq] = useState(confirmState)
  useEffect(() => {
    const fn = (v) => setReq(v)
    confirmListeners.add(fn)
    return () => confirmListeners.delete(fn)
  }, [])
  // Esc = 取消；Enter = 确定（危险操作除外，防止手滑连按回车误删）
  useEffect(() => {
    if (!req) return
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settleConfirm(false) }
      else if (e.key === 'Enter' && !req.danger) { e.preventDefault(); e.stopPropagation(); settleConfirm(true) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req])
  if (!req) return null
  return (
    <div className="dvev-cfmask" onMouseDown={(e) => { if (e.target === e.currentTarget) settleConfirm(false) }}>
      <div className="dvev-cfbox" role="alertdialog" aria-modal="true" aria-label={req.title}>
        <div className="dvev-cftitle">{req.title}</div>
        {req.body ? <div className="dvev-cfbody">{req.body}</div> : null}
        <div className="dvev-cfbtns">
          {/* 危险操作默认焦点落在「取消」上，回车也不会触发确定（上面键盘钩子拦了） */}
          <button type="button" className="dvev-btn" autoFocus={req.danger}
            onClick={() => settleConfirm(false)}>{req.cancelLabel}</button>
          <button type="button" className={`dvev-btn dvev-primary${req.danger ? ' dvev-danger' : ''}`}
            autoFocus={!req.danger}
            onClick={() => settleConfirm(true)}>{req.okLabel}</button>
        </div>
      </div>
    </div>
  )
}

// ---------- 选择对话框（askPick：从一组条目里选一个） ----------
// 与确认框同一模式：模块级状态 + 监听器，返回 Promise<选中项 | null>。
// 替代 window.prompt：原生 prompt 有与 confirm 相同的"浏览器标头 + 阻塞线程 +
// 不跟随主题"问题，而且让用户手抄条目 id 前缀，不如直接点。
let pickState = null
const pickListeners = new Set()
function askPick({ title, body = '', items = [], placeholder = '输入关键词过滤' }) {
  // 已有未决弹窗时直接返回 null（等同取消），避免互相顶掉后 Promise 悬空
  if (pickState) return Promise.resolve(null)
  return new Promise((resolve) => {
    pickState = { title, body, items, placeholder, resolve }
    for (const fn of pickListeners) fn(pickState)
  })
}
function settlePick(item) {
  const cur = pickState
  pickState = null
  for (const fn of pickListeners) fn(null)
  if (cur) cur.resolve(item ?? null)
}

function PickHost() {
  const [req, setReq] = useState(pickState)
  const [filter, setFilter] = useState('')
  useEffect(() => {
    const fn = (v) => { setReq(v); setFilter('') }
    pickListeners.add(fn)
    return () => pickListeners.delete(fn)
  }, [])
  // Esc = 取消。确认框的键盘钩子也在 capture 阶段监听 Esc 并 stopPropagation，
  // 两个弹窗不会同时存在（askPick/askConfirm 各自有未决检查），不会互相抢。
  useEffect(() => {
    if (!req) return
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settlePick(null) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req])
  if (!req) return null
  const kw = filter.trim().toLowerCase()
  const list = kw === ''
    ? req.items
    : req.items.filter((it) => `${it.label} ${it.hint ?? ''}`.toLowerCase().includes(kw))
  return (
    <div className="dvev-cfmask" onMouseDown={(e) => { if (e.target === e.currentTarget) settlePick(null) }}>
      <div className="dvev-cfbox" role="dialog" aria-modal="true" aria-label={req.title}>
        <div className="dvev-cftitle">{req.title}</div>
        {req.body ? <div className="dvev-cfbody">{req.body}</div> : null}
        <input
          className="dvev-pkfilter" type="text" value={filter} placeholder={req.placeholder} autoFocus
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="dvev-pklist">
          {list.length === 0 ? <div className="dvev-muted" style={{ padding: '10px 6px' }}>没有匹配的条目</div> : null}
          {list.slice(0, 50).map((it) => (
            <button key={it.value} type="button" className="dvev-pkitem" onClick={() => settlePick(it)}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
              {it.hint ? <span className="dvev-muted dvev-mono" style={{ flex: 'none' }}>{it.hint}</span> : null}
            </button>
          ))}
          {list.length > 50 ? <div className="dvev-muted" style={{ padding: '6px' }}>只显示前 50 条，用上面的关键词过滤</div> : null}
        </div>
        <div className="dvev-cfbtns">
          <button type="button" className="dvev-btn" onClick={() => settlePick(null)}>取消</button>
        </div>
      </div>
    </div>
  )
}

// ---------- CSS 注入（兼容动态/静态两种运行时） ----------
const CSS_TAG_ID = `${PLUGIN_ID}/panel.css`
const CSS = `
.dvev-root{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.45);backdrop-filter:blur(2px)}
.dvev-panel{display:flex;flex-direction:column;background:var(--bg-primary,#1b1b1f);color:var(--text-primary,#e6e6e6);
  border:1px solid var(--border,#333);border-radius:10px;box-shadow:0 18px 60px rgba(0,0,0,.55);
  overflow:hidden;font-size:13px;line-height:1.55;
  /* 持久化的尺寸是"拖出来那一刻"的窗口大小；浏览器窗口后来变小不能把面板推出视口 */
  max-width:calc(100vw - 16px);max-height:calc(100vh - 16px)}
.dvev-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border,#333);
  background:linear-gradient(180deg,rgba(88,140,255,.14),transparent);cursor:move;user-select:none}
.dvev-title{font-weight:600;font-size:14px}
.dvev-sub{color:var(--text-secondary,#9aa0a6);font-size:12px}
.dvev-spacer{flex:1}
.dvev-icon{width:26px;height:26px;border:1px solid var(--border,#333);border-radius:6px;background:transparent;
  color:inherit;cursor:pointer;font-size:13px;line-height:1}
.dvev-icon:hover{background:rgba(255,255,255,.07)}
.dvev-body{display:flex;flex:1;min-height:0}
.dvev-nav{width:132px;flex:none;border-right:1px solid var(--border,#333);padding:8px 6px;display:flex;flex-direction:column;gap:2px}
.dvev-navitem{text-align:left;padding:7px 10px;border-radius:6px;border:0;background:transparent;color:inherit;
  cursor:pointer;font-size:13px;transition:background .12s}
.dvev-navitem:hover{background:rgba(255,255,255,.06)}
.dvev-navitem.dvev-on{background:rgba(88,140,255,.22);color:#cfe0ff;font-weight:600}
.dvev-main{flex:1;min-width:0;overflow:auto;padding:14px 16px}
.dvev-h{font-weight:600;margin:2px 0 10px}
.dvev-h2{font-weight:600;margin:16px 0 8px;font-size:13px;color:#cfe0ff}
.dvev-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:8px}
.dvev-card{border:1px solid var(--border,#333);border-radius:8px;padding:8px 10px;background:rgba(255,255,255,.02)}
.dvev-card .k{color:var(--text-secondary,#9aa0a6);font-size:11px}
.dvev-card .v{font-size:17px;font-weight:600;margin-top:2px;word-break:break-all}
.dvev-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.dvev-btn{padding:5px 11px;border-radius:6px;border:1px solid var(--border,#333);background:rgba(255,255,255,.04);
  color:inherit;cursor:pointer;font-size:12px}
.dvev-btn:hover{background:rgba(255,255,255,.1)}
.dvev-btn:active{transform:translateY(1px)}
.dvev-btn.dvev-primary{background:rgba(88,140,255,.3);border-color:rgba(88,140,255,.6);font-weight:600}
.dvev-btn:disabled{opacity:.45;cursor:not-allowed}
/* 键盘导航的焦点环：鼠标点击不显示（focus-visible 只认键盘焦点），Tab 走查时看得见 */
.dvev-panel :is(button,input,select,textarea,[role^="button"]):focus-visible{
  outline:2px solid rgba(88,140,255,.65);outline-offset:1px}
.dvev-table{width:100%;border-collapse:collapse;font-size:12px}
.dvev-table th{position:sticky;top:0;background:var(--bg-primary,#1b1b1f);text-align:left;padding:6px 8px;
  border-bottom:1px solid var(--border,#333);color:var(--text-secondary,#9aa0a6);font-weight:600;white-space:nowrap}
.dvev-table td{padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:top}
.dvev-table tr:hover td{background:rgba(255,255,255,.035)}
.dvev-mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;word-break:break-all}
.dvev-muted{color:var(--text-secondary,#9aa0a6)}
.dvev-warn{color:#ffb454}
.dvev-err{color:#ff7b72}
.dvev-ok{color:#5ac57a}
.dvev-tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;border:1px solid var(--border,#333)}
.dvev-tag.dvev-hit{background:rgba(90,197,122,.16);border-color:rgba(90,197,122,.4)}
.dvev-tag.dvev-miss{background:rgba(255,180,84,.14);border-color:rgba(255,180,84,.4)}
.dvev-tag.dvev-err{background:rgba(255,123,114,.16);border-color:rgba(255,123,114,.4)}
.dvev-group{border:1px solid var(--border,#333);border-radius:8px;margin-bottom:10px;overflow:hidden}
.dvev-grouphead{padding:7px 11px;background:rgba(255,255,255,.04);font-weight:600;font-size:12.5px}
.dvev-groupbody{padding:4px 11px 10px}
.dvev-field{display:grid;grid-template-columns:1fr 210px;gap:10px;align-items:center;padding:7px 0;
  border-bottom:1px dashed rgba(255,255,255,.07)}
.dvev-field:last-child{border-bottom:0}
.dvev-flabel{min-width:0}
.dvev-fname{font-size:12.5px}
.dvev-fhint{color:var(--text-secondary,#9aa0a6);font-size:11px;margin-top:2px;white-space:pre-wrap}
.dvev-fctl{display:flex;justify-content:flex-end;align-items:center;gap:6px}
/* 原生下拉跟随主题：select 弹层的底色/文字色取自 option 样式（color-scheme 帮不上
   跨版本这个忙，option 样式是各浏览器都认的唯一入口）。颜色走宿主 --dsw-* 令牌
   （挂在 body 上，深浅色切换时令牌的值会变），令牌缺失时回退到原来的深色值。
   注意顺序：.dvev-panel select 必须写在 .dvev-fctl select 前面，同优先级下后者
   生效，配置页的下拉保留自己的底纹。 */
.dvev-panel select{background:var(--dsw-specific-selector,rgba(0,0,0,.28));
  color:var(--dsw-alias-label-primary,inherit)}
.dvev-panel select option{background:var(--dsw-specific-menu,#242428);
  color:var(--dsw-alias-label-primary,#e6e6e6)}
.dvev-fctl input[type=text],.dvev-fctl input[type=number],.dvev-fctl select,.dvev-fctl textarea{
  width:100%;padding:4px 7px;border-radius:5px;border:1px solid var(--dsw-alias-border-l3,var(--border,#333));
  background:var(--dsw-specific-input-major,rgba(0,0,0,.28));color:var(--dsw-alias-label-primary,inherit);
  font-size:12px;font-family:inherit}
.dvev-fctl input[type=number]{text-align:right}
.dvev-fctl textarea{min-height:64px;resize:vertical;font-family:ui-monospace,Consolas,monospace}
.dvev-switch{position:relative;width:40px;height:22px;flex:none;cursor:pointer}
.dvev-switch input{display:none}
.dvev-slider{position:absolute;inset:0;border-radius:11px;background:rgba(255,255,255,.16);transition:.16s}
.dvev-slider:before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;border-radius:50%;
  background:#fff;transition:.16s}
.dvev-switch input:checked + .dvev-slider{background:rgba(88,140,255,.85)}
.dvev-switch input:checked + .dvev-slider:before{transform:translateX(18px)}
.dvev-pre{margin:0;padding:9px 11px;border:1px solid var(--border,#333);border-radius:8px;
  background:rgba(0,0,0,.28);overflow:auto;max-height:260px;font-family:ui-monospace,Consolas,monospace;
  font-size:11.5px;white-space:pre-wrap;word-break:break-all}
.dvev-cmp{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dvev-cmp .dvev-pre{max-height:190px}
.dvev-cmplabel{font-size:11px;color:var(--text-secondary,#9aa0a6);margin-bottom:3px}
.dvev-empty{padding:24px;text-align:center;color:var(--text-secondary,#9aa0a6)}
.dvev-budget{margin-bottom:6px}
.dvev-budgetbar{height:8px;border-radius:5px;background:rgba(255,255,255,.12);overflow:hidden}
.dvev-budgetfill{height:100%;border-radius:5px;background:linear-gradient(90deg,rgba(88,140,255,.85),rgba(140,110,255,.85));
  transition:width .2s}
.dvev-banner{padding:8px 11px;border-radius:8px;margin-bottom:10px;font-size:12px;border:1px solid}
.dvev-banner.dvev-info{background:rgba(88,140,255,.12);border-color:rgba(88,140,255,.35)}
.dvev-banner.dvev-warn{background:rgba(255,180,84,.12);border-color:rgba(255,180,84,.4)}
.dvev-banner.dvev-err{background:rgba(255,123,114,.12);border-color:rgba(255,123,114,.4)}
.dvev-dirty{position:sticky;bottom:0;display:flex;gap:8px;align-items:center;padding:9px 0;margin-top:10px;
  border-top:1px solid var(--border,#333);background:var(--bg-primary,#1b1b1f)}
/* 侧边栏入口：几何与宿主「设置」入口（ui-settings-general 的
   .triggerRow/.trigger）逐条对齐 —— 宽栏是整宽左对齐行按钮（高 42、margin 4px -2px、
   padding 0 10px 0 8px、圆角 12），窄栏（rail）是 36 圆钮。于是本入口与
   「功能坞」「记忆」「设置」在同一列里左右边缘完全对齐。
   宿主把 sidebar.footer.action 的每个条目排成一列（.footerActions 是 column），
   席位排布归宿主：这条规则只描述自己这颗按钮，不再用容器选择器改写同席位
   其它插件的排布 —— 之前那条 :has() + 子元素通配的容器覆盖，正是宿主改排布后
   本入口连同邻居一起错位的原因。 */
.dvev-sidebtn{box-sizing:border-box;display:flex;align-items:center;gap:8px;
  width:calc(100% + 4px);height:42px;margin:4px -2px;padding:0 10px 0 8px;
  border:0;border-radius:12px;
  background:transparent;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;
  font-family:inherit;font-size:14px;line-height:22px;white-space:nowrap;user-select:none;
  transition:background .15s var(--ds-ease-in-out,ease),color .15s var(--ds-ease-in-out,ease)}
.dvev-sidebtn:hover,.dvev-sidebtn.dvev-on{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.dvev-sideicon{flex:none;display:inline-flex;align-items:center;justify-content:center}
.dvev-sidelbl{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvev-sidebtn.dvev-sidenarrow{flex:none;width:36px;height:36px;margin:8px 0 10px;padding:0;
  border-radius:50%;justify-content:center;gap:0}
/* 确认对话框：替代原生 window.confirm —— 原生弹窗会被浏览器打上
   "127.0.0.1:12680 显示" 的标头、不跟随主题，还阻塞 JS 线程。
   遮罩固定在视口（z-index 高于面板的 9000），盒子复用面板同一套
   --dsw-* / --bg-primary 变量，深浅色主题自动跟随。 */
.dvev-cfmask{position:fixed;inset:0;z-index:9100;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.5);backdrop-filter:blur(3px);animation:dvev-cfin .12s ease-out}
.dvev-cfbox{width:420px;max-width:calc(100vw - 64px);background:var(--bg-primary,#1b1b1f);
  color:var(--text-primary,#e6e6e6);border:1px solid var(--border,#333);border-radius:10px;
  box-shadow:0 20px 60px rgba(0,0,0,.6);padding:16px 18px;font-size:13px;line-height:1.6;
  animation:dvev-cfpop .14s ease-out}
.dvev-cftitle{font-weight:600;font-size:14px;margin-bottom:8px}
.dvev-cfbody{color:var(--text-secondary,#9aa0a6);font-size:12.5px;white-space:pre-wrap;word-break:break-word}
.dvev-cfbtns{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.dvev-btn.dvev-danger{background:rgba(255,123,114,.2);border-color:rgba(255,123,114,.55);color:#ffb3ad}
.dvev-btn.dvev-danger:hover{background:rgba(255,123,114,.3)}
@keyframes dvev-cfin{from{opacity:0}to{opacity:1}}
@keyframes dvev-cfpop{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}
/* 选择对话框（askPick）：复用确认框的遮罩与盒子，中间多一段可过滤的列表。
   替代 window.prompt —— 原生 prompt 有和 confirm 一样的"浏览器标头 + 阻塞线程"
   问题，而且让用户手抄 id 前缀本来就不如点一下。 */
.dvev-pkfilter{width:100%;box-sizing:border-box;margin-top:10px;padding:6px 9px;border-radius:6px;
  border:1px solid var(--border,#333);background:rgba(0,0,0,.28);color:inherit;font-size:12.5px;
  font-family:inherit}
.dvev-pklist{max-height:240px;overflow:auto;margin-top:8px;display:flex;flex-direction:column;gap:2px;
  border:1px solid var(--border,#333);border-radius:8px;padding:4px;background:rgba(0,0,0,.14)}
.dvev-pkitem{display:flex;align-items:center;gap:8px;text-align:left;padding:6px 9px;border-radius:6px;
  border:0;background:transparent;color:inherit;cursor:pointer;font-size:12.5px;font-family:inherit}
.dvev-pkitem:hover{background:rgba(88,140,255,.18)}
`

function ensureCss(ctx) {
  try {
    const styles = ctx?.get?.('styles')
    if (styles && typeof styles.insert === 'function') { styles.insert(CSS); return }
  } catch { /* 落到 <style> 分支 */ }
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`)) return
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', CSS_TAG_ID)
  tag.setAttribute('data-plugin', PLUGIN_ID)
  tag.textContent = CSS
  document.head.appendChild(tag)
}

// ---------- RPC ----------
/**
 * 面板与 host 半的唯一通信通道。两条硬约束，缺一不可：
 *
 * 1. **目标永远同源、同前缀**。fetch 的 URL 由插件自身常量 ROUTE 与下面
 *    校验过的 method 拼成，不接受任何完整 URL、不接受 // 与 : ——
 *    攻击者无法借这个通道把请求引到别的源/别的服务（无 SSRF 面）。
 * 2. **method 只能是插件内部路由名**。`路由段/子段` 形态（如 insights/mutate），
 *    与 host 半 routes.js 的 case 一一对应；别的形态直接抛错，根本不发请求。
 */
const METHOD_RE = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/
async function rpc(method, args) {
  if (typeof method !== 'string' || !METHOD_RE.test(method)) {
    throw new Error(`非法的 RPC 方法名：${String(method)}`)
  }
  const res = await fetch(`${ROUTE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args === undefined ? {} : args),
  })
  const data = await res.json().catch(() => ({}))
  if (res.ok && data && data.ok === true) return data.data
  const message = (data && data.error && data.error.message) || `HTTP ${res.status}`
  const code = (data && data.error && data.error.code) || 'http-error'
  const err = new Error(message)
  err.code = code
  throw err
}

// ---------- 小工具 ----------
function fmtTime(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function fmtDuration(ms) {
  if (typeof ms !== 'number' || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}
function fmtNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
  return n.toLocaleString('en-US')
}
/** 取点号路径的值（与 host 的 config-store.getPath 同语义）。 */
function getPath(obj, path) {
  let cur = obj
  for (const key of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}
/** 按点号路径写值，返回新对象。 */
function setPath(obj, path, value) {
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

const KIND_LABEL = {
  turn_start: '轮开始',
  turn_end: '轮结束',
  user_message: '用户',
  assistant_message: '助手',
  tool_call: '工具调用',
  tool_result: '工具结果',
  session_meta: '会话信息',
  session_end: '会话结束',
}

// ---------- 侧边栏入口 ----------
/**
 * 入口图标：描边 DNA 双螺旋（接替 🧬 emoji）。
 * 宿主底栏的其它入口都是 currentColor 描边小图标（16×16 viewBox、1.3 描边），
 * 彩色 emoji 在一排单色图标里同样突兀，所以图标也换成同一种语言。
 */
function EvoIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.3} strokeLinecap="round" aria-hidden="true">
      <path d="M5.2 2.6c0 3.9 5.6 5.5 5.6 10.8" />
      <path d="M10.8 2.6c0 3.9-5.6 5.5-5.6 10.8" />
      <path d="M6.7 5.2h2.6" />
      <path d="M6.7 10.8h2.6" />
    </svg>
  )
}

/**
 * 结构与宿主原生入口一致：按钮自身 display:flex（横向），
 * 图标一个节点、文字一个节点；narrow 模式（底栏收窄时）只留图标、降级为圆形。
 * 面板打开时挂 .dvev-on，给出与 hover 相同的底色 —— 宿主原生入口也是这么做的。
 */
function SidebarButton({ wide, ctx }) {
  const open = usePanelOpen()
  return (
    <button
      type="button"
      className={`dvev-sidebtn${open ? ' dvev-on' : ''}${wide ? '' : ' dvev-sidenarrow'}`}
      title="自动进化"
      aria-label="自动进化"
      aria-expanded={open}
      onClick={() => setPanelOpen(!open)}
    >
      <span className="dvev-sideicon"><EvoIcon size={wide ? 16 : 18} /></span>
      {wide ? <span className="dvev-sidelbl">自动进化</span> : null}
    </button>
  )
}

// ---------- 全屏浮层 ----------
function Overlay() {
  const open = usePanelOpen()
  if (!open) return null
  return <Panel />
}

// ================= 面板主体 =================
function Panel() {
  const [tab, setTab] = useState('overview')
  const [hello, setHello] = useState(null)
  const [config, setConfig] = useState(null)
  const [draft, setDraft] = useState(null)
  const [runtime, setRuntime] = useState(null)
  const [stats, setStats] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  /** 面板窗口尺寸（本地持久化，跨浏览器用 host 配置；这里先做即时渲染）。 */
  const [size, setSize] = useState(() => {
    try {
      const raw = localStorage.getItem('dsh-evolution.panelSize')
      if (raw) {
        const p = JSON.parse(raw)
        if (p && p.w > 400 && p.h > 300) return p
      }
    } catch { /* 忽略损坏的本地值 */ }
    return { w: Math.min(1100, window.innerWidth - 80), h: Math.min(760, window.innerHeight - 80) }
  })

  const refreshConfig = useCallback(async () => {
    const data = await rpc('config')
    setConfig(data.config)
    setDraft(JSON.parse(JSON.stringify(data.config)))
    return data
  }, [])

  const refreshRuntime = useCallback(async () => {
    const data = await rpc('runtime')
    setRuntime(data.runtime)
    setStats(data.ledger)
    return data
  }, [])

  // 首屏：一次性把元信息 + 配置 + 运行状态拿全
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const h = await rpc('hello')
        if (!alive) return
        setHello(h)
        await refreshConfig()
        await refreshRuntime()
      } catch (e) {
        if (alive) setError(`初始化失败：${e.message}`)
      }
    })()
    return () => { alive = false }
  }, [refreshConfig, refreshRuntime])

  // 运行状态轮询：面板开着的时候每 5 秒刷新一次（数据是本机的，开销可忽略）
  useEffect(() => {
    const t = setInterval(() => { void refreshRuntime().catch(() => {}) }, 5000)
    return () => clearInterval(t)
  }, [refreshRuntime])

  // Esc 关闭面板。确认框/选择框打开时它们在 capture 阶段拦 Esc 并 stopPropagation，
  // 走不到这里；能收到 Esc 就说明没有未决弹窗，直接关面板是安全的。
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !confirmState && !pickState) setPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const dirty = useMemo(() => {
    if (!config || !draft) return []
    const out = []
    for (const f of (hello?.schema?.fields ?? [])) {
      const a = JSON.stringify(getPath(config, f.path))
      const b = JSON.stringify(getPath(draft, f.path))
      if (a !== b) out.push(f.path)
    }
    return out
  }, [config, draft, hello])

  /**
   * 给用户看的"改动清单"。dirty 按**配置路径**算，但 `review.provider` /
   * `review.model` 永远由「复盘用哪个模型」选择器成对写入 —— 对用户来说
   * 那是**一次**改动，不是两次。展示层把它折叠成一条，否则换个模型就提示
   * "2 项改动"，看起来像多改了东西。
   * 注意：这只是**展示**折叠，保存时 patch 仍按真实路径逐项写（见 save）。
   */
  const dirtyView = useMemo(() => {
    const out = []
    let pairDone = false
    for (const p of dirty) {
      if (p === 'review.provider' || p === 'review.model') {
        if (!pairDone) { out.push('复盘用哪个模型'); pairDone = true }
      } else {
        out.push(p)
      }
    }
    return out
  }, [dirty])

  const setField = useCallback((path, value) => {
    setDraft((prev) => (prev === null ? prev : setPath(prev, path, value)))
  }, [])

  const save = useCallback(async () => {
    if (dirty.length === 0) return
    setBusy(true)
    setError('')
    try {
      const patch = {}
      for (const p of dirty) patch[p] = getPath(draft, p)
      const res = await rpc('config/save', { patch })
      setConfig(res.config)
      setDraft(JSON.parse(JSON.stringify(res.config)))
      setNotice(`已保存 ${dirtyView.length} 项配置`)
      await refreshRuntime()
    } catch (e) {
      setError(`保存失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [dirty, dirtyView, draft, refreshRuntime])

  const reset = useCallback(async () => {
    if (!(await askConfirm({
      title: '恢复全部配置为默认值？',
      body: '注意：这不会删除已经记录的账本数据。',
      okLabel: '恢复默认',
    }))) return
    setBusy(true)
    setError('')
    try {
      const res = await rpc('config/reset')
      setConfig(res.config)
      setDraft(JSON.parse(JSON.stringify(res.config)))
      setNotice('已恢复默认配置')
      await refreshRuntime()
    } catch (e) {
      setError(`恢复失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [refreshRuntime])

  // 窗口拖拽调尺寸
  const dragRef = useRef(null)
  const onDragStart = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startW = size.w
    const startH = size.h
    const move = (ev) => {
      const w = Math.max(720, Math.min(window.innerWidth - 20, startW + (ev.clientX - startX)))
      const h = Math.max(480, Math.min(window.innerHeight - 20, startH + (ev.clientY - startY)))
      setSize({ w, h })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setSize((s) => {
        try { localStorage.setItem('dsh-evolution.panelSize', JSON.stringify(s)) } catch { /* 忽略配额错误 */ }
        return s
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [size])

  const tabs = [
    // 标签统一四字对齐，侧边栏看起来更整齐
    { id: 'overview', label: '全局总览' },
    { id: 'insights', label: '洞察分析' },
    { id: 'dryrun', label: '沙盒试跑' },
    { id: 'data', label: '数据预览' },
    { id: 'inject', label: '注入预览' },
    { id: 'redact', label: '脱敏预览' },
    { id: 'export', label: '导出草稿' },
    { id: 'config', label: '配置管理' },
    { id: 'privacy', label: '数据隐私' },
  ]

  return (
    <div className="dvev-root" onMouseDown={(e) => { if (e.target === e.currentTarget) setPanelOpen(false) }}>
      <div className="dvev-panel" style={{ width: size.w, height: size.h }}>
        <div className="dvev-head">
          <span className="dvev-title">自动进化</span>
          <span className="dvev-sub">
            v{CLIENT_VERSION}
            {hello ? ` · 服务 v${hello.version}` : ''}
            {/* 面板与服务版本不一致 = 升级后宿主没重启，或浏览器缓存了旧面板。
                这时面板按钮与路由能力可能对不上，必须显性提示而不是静默出错 */}
            {hello && hello.version !== CLIENT_VERSION
              ? <span className="dvev-warn" title="面板版本与宿主服务版本不一致，通常是升级后宿主未重启（或浏览器缓存了旧面板）。请重启宿主后刷新页面。"> · 版本不一致，请重启宿主</span>
              : ''}
            {' · '}
            {runtime?.pluginEnabled === false
              ? <span className="dvev-warn">已停用</span>
              : <span className="dvev-ok">运行中</span>}
          </span>
          <span className="dvev-spacer" />
          <button className="dvev-icon" title="刷新" onClick={async () => {
            /**
             * 刷新会把配置重置成磁盘上的值，也就**丢弃未保存的草稿改动**。
             * 用户改了半小时配置、顺手点下刷新就全没了还不自知 —— 那是数据丢失，
             * 必须先问一句。没有改动时保持原来的"直接刷"。
             */
            if (dirty.length > 0 && !(await askConfirm({
              title: '有未保存的配置改动',
              body: '刷新会以磁盘上的配置为准，放弃这些未保存的改动。继续吗？',
              okLabel: '放弃并刷新',
            }))) return
            void refreshRuntime()
            void refreshConfig()
          }}>⟳</button>
          <button className="dvev-icon" title="关闭" onClick={() => setPanelOpen(false)}>✕</button>
        </div>

        <div className="dvev-body">
          <div className="dvev-nav">
            {tabs.map((t) => (
              <button
                key={t.id}
                className={`dvev-navitem${tab === t.id ? ' dvev-on' : ''}`}
                onClick={() => setTab(t.id)}
              >{t.label}</button>
            ))}
          </div>

          <div className="dvev-main">
            {error ? <div className="dvev-banner dvev-err">{error}</div> : null}
            {notice ? <div className="dvev-banner dvev-info">{notice}</div> : null}

            {tab === 'overview' ? (
              <OverviewTab runtime={runtime} stats={stats} hello={hello} onRefresh={refreshRuntime} onOpenConfig={() => setTab('config')} />
            ) : null}
            {tab === 'insights' ? <InsightsTab runtime={runtime} onOpenConfig={() => setTab('config')} /> : null}
            {tab === 'dryrun' ? <DryRunTab onOpenConfig={() => setTab('config')} /> : null}
            {tab === 'data' ? <DataTab hello={hello} config={config} /> : null}
            {tab === 'inject' ? <InjectTab runtime={runtime} /> : null}
            {tab === 'redact' ? <RedactTab config={config} /> : null}
            {tab === 'export' ? <ExportTab runtime={runtime} config={config} /> : null}
            {tab === 'config' ? (
              <ConfigTab
                hello={hello} draft={draft} dirty={dirty} dirtyView={dirtyView} busy={busy}
                onSet={setField} onSave={save} onReset={reset}
              />
            ) : null}
            {tab === 'privacy' ? <PrivacyTab hello={hello} config={config} runtime={runtime} /> : null}
          </div>
        </div>

        {/* 右下角拖拽手柄：面板内容多，允许用户自己调大小 */}
        <div
          onMouseDown={onDragStart}
          title="拖拽调整面板大小"
          style={{ position: 'absolute', right: 2, bottom: 2, width: 16, height: 16, cursor: 'nwse-resize',
            opacity: .5, fontSize: 11, textAlign: 'center', lineHeight: '16px' }}
        >◢</div>
      </div>
      {/* 插件内确认框与选择框（替代原生 window.confirm / window.prompt），
          挂在面板根里随面板卸载 */}
      <ConfirmHost />
      <PickHost />
    </div>
  )
}

// ================= 总览 =================
function OverviewTab({ runtime, stats, hello, onRefresh, onOpenConfig }) {
  const r = runtime ?? {}
  const s = stats ?? {}
  const scanning = r.historyScan?.running === true
  const [usage, setUsage] = useState(null)

  /**
   * 用量必须可见。用户看不到成本 = 某天被账单吓到 = 卸载。
   * 这里只统计**复盘调用**（插件里唯一会花钱的路径），
   * 并明确写"费用以你的模型提供方账单为准" —— 单价会变，插件不该假装知道。
   */
  useEffect(() => {
    let alive = true
    const loadUsage = async () => {
      try {
        const data = await rpc('usage', { days: 30 })
        if (alive) setUsage(data)
      } catch { /* 用量读不到不该影响总览 */ }
    }
    void loadUsage()
    const t = setInterval(() => { void loadUsage() }, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return (
    <div>
      <div className="dvev-h">运行状态</div>

      {r.apiUploadMode && r.apiUploadMode !== 'off' ? (
        <div className="dvev-banner dvev-warn">
          接口上传模式为 <b>{r.apiUploadMode}</b>，数据会发送到你配置的地址。
        </div>
      ) : (
        <div className="dvev-banner dvev-info">
          完全本地：未启用任何上传，向量检索{r.embeddingsEnabled ? '已开启（正文会发往你配置的端点）' : '未开启'}。
        </div>
      )}

      {r.configError ? <div className="dvev-banner dvev-err">配置问题：{r.configError}</div> : null}
      {s.lastError ? <div className="dvev-banner dvev-err">写盘问题：{s.lastError}</div> : null}
      {r.lastError ? <div className="dvev-banner dvev-warn">最近告警：{r.lastError}</div> : null}

      <div className="dvev-cards">
        <Card k="已记录事件" v={fmtNum(r.eventsRecorded ?? 0)} />
        <Card k="已跳过事件" v={fmtNum(r.eventsSkipped ?? 0)} />
        <Card k="账本条数" v={fmtNum(s.records ?? 0)} />
        <Card k="会话数" v={fmtNum(s.sessions ?? 0)} />
        <Card k="账本天数" v={fmtNum(s.days ?? 0)} />
        <Card k="待落盘" v={fmtNum(s.pendingBuffered ?? 0)} />
        <Card k="跟踪中会话" v={fmtNum(r.sessionsTracked ?? 0)} />
        <Card k="运行时长" v={fmtDuration(r.uptimeMs ?? 0)} />
      </div>

      <div className="dvev-h2">开关状态</div>
      <table className="dvev-table">
        <tbody>
          <Tr k="插件总开关" v={r.pluginEnabled ? '开' : '关'} cls={r.pluginEnabled ? 'dvev-ok' : 'dvev-err'} />
          <Tr k="账本采集" v={r.ledgerEnabled ? '开' : '关'} cls={r.ledgerEnabled ? 'dvev-ok' : 'dvev-warn'} />
          <Tr k="自动复盘（消耗模型）" v={r.reviewEnabled ? '开' : '关'} cls={r.reviewEnabled ? 'dvev-ok' : 'dvev-muted'} />
          <Tr k="接口对接" v={r.apiEnabled ? `开 · ${r.apiUploadMode}` : '关'} cls={r.apiEnabled ? 'dvev-warn' : 'dvev-muted'} />
          <Tr k="数据库对接" v={r.databaseEnabled ? '开' : '关'} cls={r.databaseEnabled ? 'dvev-ok' : 'dvev-muted'} />
          <Tr k="向量检索" v={r.embeddingsEnabled ? '开' : '关'} cls={r.embeddingsEnabled ? 'dvev-warn' : 'dvev-muted'} />
        </tbody>
      </table>

      <div className="dvev-h2">模型用量（最近 30 天 · 只有复盘会花钱）</div>
      {usage ? (
        <>
          <div className="dvev-cards">
            <Card k="复盘次数" v={fmtNum(usage.runs)} />
            <Card k="输入 token" v={fmtNum(usage.inputTokens)} />
            <Card k="输出 token" v={fmtNum(usage.outputTokens)} />
            <Card k="平均耗时" v={fmtDuration(usage.avgMs)} />
            <Card k="入库条数" v={fmtNum(usage.accepted)} />
            <Card k="合并复现" v={fmtNum(usage.merged)} />
          </div>
          <table className="dvev-table" style={{ marginTop: 8 }}>
            <tbody>
              <Tr k="今天调用" v={`${fmtNum(usage.today?.calls ?? 0)} 次 · ${fmtNum((usage.today?.inputTokens ?? 0) + (usage.today?.outputTokens ?? 0))} token`} />
              <Tr
                k="每日预算"
                v={usage.budget > 0
                  ? `${fmtNum(usage.budget)} token${(usage.today?.inputTokens ?? 0) + (usage.today?.outputTokens ?? 0) >= usage.budget ? '（今天已用完）' : ''}`
                  : '不限（0）'}
                cls={usage.budget > 0 && (usage.today?.inputTokens ?? 0) + (usage.today?.outputTokens ?? 0) >= usage.budget ? 'dvev-warn' : ''}
              />
              <Tr k="被拒收条数" v={fmtNum(usage.rejected)} />
              {Object.keys(usage.byStatus ?? {}).length > 0
                ? <Tr k="状态分布" v={Object.entries(usage.byStatus).map(([k, v]) => `${k}:${v}`).join('　')} />
                : null}
              {Object.keys(usage.byModel ?? {}).length > 0
                ? <Tr k="按模型" v={Object.entries(usage.byModel).map(([k, v]) => `${k}: ${fmtNum(v)} token`).join('　')} />
                : null}
            </tbody>
          </table>
          <div className="dvev-muted" style={{ marginTop: 4 }}>{usage.note}</div>
        </>
      ) : <div className="dvev-muted">读取中…</div>}

      <div className="dvev-h2">历史回扫</div>
      <table className="dvev-table">
        <tbody>
          <Tr k="状态" v={scanning ? '进行中…' : (r.historyScan?.ran ? '已完成' : '未开始')} />
          <Tr k="回扫会话数" v={fmtNum(r.historyScan?.sessions ?? 0)} />
          <Tr k="回扫记录数" v={fmtNum(r.historyScan?.records ?? 0)} />
          <Tr k="跳过" v={fmtNum(r.historyScan?.skipped ?? 0)} />
          {r.historyScan?.error ? <Tr k="错误" v={r.historyScan.error} cls="dvev-err" /> : null}
        </tbody>
      </table>

      <div className="dvev-h2">数据落点</div>
      <div className="dvev-pre">{[
        `存储后端     ${r.storageBackend === 'sqlite' ? 'SQLite（数据库，本机文件）' : '本地文件（NDJSON + JSON）'}`,
        `数据根目录   ${r.dataRoot ?? '—'}`,
        `配置文件     ${r.configFile ?? '—'}`,
        r.storageBackend === 'sqlite' ? `数据库文件   ${r.storageLocation ?? '—'}` : `账本目录     ${(r.dataRoot ?? '') + '/ledger'}`,
        `账本范围     ${s.firstDay || '（空）'} ~ ${s.lastDay || '（空）'}`,
        `插件版本     v${CLIENT_VERSION}（面板） / v${hello?.version ?? '—'}（宿主服务）${hello && hello.version !== CLIENT_VERSION ? ' ⚠ 不一致' : ''}`,
      ].join('\n')}</div>

      <div className="dvev-row" style={{ marginTop: 12 }}>
        <button className="dvev-btn" onClick={onRefresh}>刷新</button>
        <button className="dvev-btn" onClick={onOpenConfig}>去配置</button>
      </div>
    </div>
  )
}

function Card({ k, v }) {
  return (
    <div className="dvev-card">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  )
}

function Tr({ k, v, cls }) {
  return (
    <tr>
      <td className="dvev-muted" style={{ width: 200 }}>{k}</td>
      <td className={cls ?? ''}>{v}</td>
    </tr>
  )
}

// ================= 试跑（Dry run） =================
/**
 * 试跑页。**它的全部价值在于"先说清楚会发生什么"**：
 *   · 将来喂给模型的那段文本长什么样
 *   · 会往上下文里注入哪几段、各占多少预算
 *   · 大概要花多少钱
 *   · 现在这个开关状态下，这次会话**到底会不会真的跑**
 *
 * 页面顶部必须显式声明"不调模型、不写文件" —— 用户敢按这个按钮，
 * 前提是他相信按下去没有任何后果。
 */
function DryRunTab({ onOpenConfig }) {
  const [report, setReport] = useState(null)
  const [sessionId, setSessionId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = useCallback(async (sid) => {
    setBusy(true)
    setError('')
    try {
      const data = await rpc('dry-run', sid ? { sessionId: sid } : {})
      setReport(data)
      if (data?.session?.sessionId) setSessionId(data.session.sessionId)
    } catch (e) {
      setError(`试跑失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void run('') }, [run])

  // 顺序刻意是"先报错、再等、最后空"：反过来的话，请求失败时用户看到的是
  // "暂无数据"，而真正的原因（比如宿主没起来）被吞掉了
  if (error) return <div className="dvev-banner dvev-err">{error}</div>
  if (busy && report === null) return <div className="dvev-empty">试跑中…</div>
  if (report === null) return <div className="dvev-empty">暂无数据</div>

  // 账本为空：给出引导而不是报错
  if (report.ok === false) {
    return (
      <div>
        <div className="dvev-h">沙盒试跑</div>
        <div className="dvev-banner dvev-info">{report.message}</div>
        <button className="dvev-btn" onClick={() => run('')}>重新试跑</button>
      </div>
    )
  }

  const s = report.session
  const g = report.gate
  const b = report.budget
  const c = report.cost

  return (
    <div>
      <div className="dvev-h">沙盒试跑</div>

      <div className="dvev-banner dvev-info">
        <b>本页不调用任何模型、不写任何文件。</b>下面展示的是"如果开启自动复盘，会发生什么"。
      </div>

      {/* ---- 会话选择 ---- */}
      <div className="dvev-row">
        <label>会话
          <select
            value={sessionId}
            onChange={(e) => { setSessionId(e.target.value); void run(e.target.value) }}
            style={{ marginLeft: 6, maxWidth: 380 }}
          >
            {(report.sessionList ?? []).map((x) => (
              <option key={x.sessionId} value={x.sessionId}>
                {x.day} · {x.repo || '(无仓库)'} · {x.records} 条 · {x.sessionId.slice(0, 18)}
              </option>
            ))}
          </select>
        </label>
        <button className="dvev-btn" onClick={() => run(sessionId)} disabled={busy}>
          {busy ? '试跑中…' : '重新试跑'}
        </button>
        {report.autoPicked ? <span className="dvev-muted">（自动选了最近的会话）</span> : null}
      </div>

      {/* ---- 会不会真的跑：用户最关心的其实是这个 ---- */}
      <div className={`dvev-banner ${g.wouldRun ? 'dvev-warn' : 'dvev-info'}`}>
        <b>{g.wouldRun ? '当前条件下，这次会话会被抽取（会产生模型费用）' : '当前条件下不会自动跑'}</b>
        <div style={{ marginTop: 4 }}>{g.reason}</div>
        <table className="dvev-table" style={{ marginTop: 6 }}>
          <tbody>
            <Tr k="插件总开关" v={g.pluginEnabled ? '开' : '关'} />
            <Tr k="账本采集" v={g.ledgerEnabled ? '开' : '关'} />
            <Tr k="自动复盘" v={g.reviewEnabled ? '开' : '关'} cls={g.reviewEnabled ? 'dvev-warn' : 'dvev-muted'} />
            <Tr k="轮次门槛" v={`${g.turnsNow} / ${g.turnsRequired}${g.turnsSatisfied ? ' ✓' : ''}`} />
            <Tr k="新增记录门槛" v={`${fmtNum(g.newRecords ?? 0)} / ${fmtNum(g.minNewRecords ?? 0)}${(g.newRecords ?? 0) >= (g.minNewRecords ?? 0) ? ' ✓' : ''}`} />
            {g.paused ? <Tr k="暂停至" v={g.paused} cls="dvev-warn" /> : null}
          </tbody>
        </table>
        {!g.reviewEnabled ? (
          <div style={{ marginTop: 6 }}>
            <button className="dvev-btn" onClick={onOpenConfig}>去配置里打开</button>
          </div>
        ) : null}
      </div>

      {/* ---- 概览卡片 ---- */}
      <div className="dvev-cards">
        <Card k="会话轮次" v={fmtNum(s.turns)} />
        <Card k="工具调用" v={`${fmtNum(s.toolCalls)}（失败 ${fmtNum(s.toolFailures)}）`} />
        <Card k="摘要字数" v={fmtNum(b.summaryChars)} />
        <Card k="注入字数" v={`${fmtNum(b.injectionChars)} / ${fmtNum(b.injectionBudgetChars)}`} />
        <Card k="预估输入" v={`${fmtNum(c.inputTokens)} tok`} />
        <Card k="预估成本" v={c.usdText} />
      </div>

      {/* ---- 注入预算条 ---- */}
      <div className="dvev-h2">注入预算</div>
      <div className="dvev-budget">
        <div className="dvev-budgetbar">
          <div className="dvev-budgetfill" style={{ width: `${Math.min(100, b.injectionPercent)}%` }} />
        </div>
        <div className="dvev-muted" style={{ marginTop: 4 }}>
          已用 {fmtNum(b.injectionChars)} 字 / 上限 {fmtNum(b.injectionBudgetChars)} 字（{b.injectionPercent}%）
          　·　其中稳定层 {fmtNum(b.stableChars)} 字（可缓存）、易变层 {fmtNum(b.volatileChars)} 字（每轮重算）
        </div>
      </div>

      {/* ---- 四段渲染结果 ---- */}
      <div className="dvev-h2">会注入的四段</div>
      {report.injection.sections.map((sec) => (
        <div className="dvev-group" key={sec.id}>
          <div className="dvev-grouphead">
            {sec.title}
            <span className="dvev-muted" style={{ marginLeft: 8, fontWeight: 400 }}>
              {sec.layer === 'stable' ? '稳定层（可缓存）' : '易变层（每轮重算）'}
              　·　{sec.included.length}/{sec.budget.maxCount} 条
              　·　{sec.chars}/{sec.budget.maxChars} 字
              {sec.skipped > 0 ? <span className="dvev-warn">　·　{sec.skipped} 条因预算被挡</span> : null}
            </span>
          </div>
          <div className="dvev-groupbody">
            {sec.text === ''
              ? <div className="dvev-muted">（空 —— 当前没有进入这一段的条目）</div>
              : <div className="dvev-pre">{sec.text}</div>}
          </div>
        </div>
      ))}

      {/* ---- 候选观察：明说是数出来的，不是模型产出 ---- */}
      <div className="dvev-h2">
        {report.insights?.live
          ? `会注入的洞察（来自本地洞察库，共 ${fmtNum(report.insights.total)} 条）`
          : '候选观察（从账本数出来的，非模型产出）'}
      </div>
      {report.insights?.live ? (
        <div className="dvev-muted" style={{ marginBottom: 6 }}>
          这些就是真实入选的条目（{fmtNum(report.insights.used)} 条参与渲染
          {report.insights.dropped?.length > 0 ? `，另有 ${fmtNum(report.insights.dropped.length)} 条被预算/配额挡在外面` : ''}）。
        </div>
      ) : (
        <div className="dvev-muted" style={{ marginBottom: 6 }}>
          洞察库还是空的。跑一次「现在复盘」之后，这里显示的就是真实洞察。
          {report.insights?.error ? <span className="dvev-err">（读取洞察库出错：{report.insights.error}）</span> : null}
        </div>
      )}
      {report.insights?.live ? null : (report.observations.length === 0
        ? <div className="dvev-muted">本会话没有数出值得注意的模式。</div>
        : (
          <table className="dvev-table">
            <thead><tr><th style={{ width: 70 }}>类型</th><th>内容</th><th style={{ width: 70 }}>复现</th></tr></thead>
            <tbody>
              {report.observations.map((o, i) => (
                <tr key={i}>
                  <td><span className="dvev-tag">{o.type}</span></td>
                  <td>{o.title}<div className="dvev-muted" style={{ fontSize: 11 }}>{o.evidence}</div></td>
                  <td className="dvev-mono">{o.recurrence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      {/* ---- 会喂给模型的原文 ---- */}
      <div className="dvev-h2">将来会喂给模型的摘要</div>
      <div className="dvev-muted" style={{ marginBottom: 6 }}>
        {report.summaryTruncated ? <span className="dvev-warn">已截断（保留最近轮次）　</span> : null}
        这段文本是试跑页与真实复盘的共同输入 —— 两者走同一条渲染路径，所以这里看到的就是真实形态。
      </div>
      <div className="dvev-pre" style={{ maxHeight: 300 }}>{report.summaryText || '（无内容）'}</div>

      <div className="dvev-h2">成本估算</div>
      <table className="dvev-table">
        <tbody>
          <Tr k="按哪个模型估算" v={c.model
            + (report.modelSource === 'config' ? '（配置里指定的）' : '')
            + (c.priceMatched ? '' : '（单价未匹配，按兜底价估算）')} />
          <Tr k="预估输入 token" v={fmtNum(c.inputTokens)} />
          <Tr k="预估输出 token" v={fmtNum(c.outputTokens)} />
          <Tr k="预估单次成本" v={c.usdText} />
        </tbody>
      </table>
      <div className="dvev-muted" style={{ marginTop: 6 }}>{c.note}</div>
      <div className="dvev-muted" style={{ marginTop: 4 }}>
        注意：这是**下界**。如果你默认模型开了高推理强度，思考 token 也按输出计费，
        实际用量可能明显更高 —— 跑完可以在「洞察」页看到真实用量。
      </div>

      <div className="dvev-banner dvev-info" style={{ marginTop: 12 }}>{report.disclaimer}</div>
    </div>
  )
}

// ================= 洞察（Phase 1：真复盘产出） =================
/**
 * 洞察页是"进化的产物"落地的地方，它同时承担三个职责：
 *
 * 1. **手动触发**：`review.enabled` 默认是关的，所以必须有一个不依赖开关的
 *    入口 —— 否则用户永远看不到这套东西到底有没有用。手动触发要如实显示
 *    "会花多少 token、当前 gate 是否允许"。
 * 2. **逐条复核**：每条都能看到证据链（会话 id + 轮次 + 原文引用），
 *    以及**为什么被降级/标注**。归纳质量差的项目价值是负的，人眼复核是最后一道闸。
 * 3. **人工判决**：置顶 / 采纳 / 删除 / 改作用域。这些状态是"自动流程不可覆盖"的，
 *    所以用户的操作是有效的、可持久的。
 */
const INSIGHT_TYPE_LABEL = {
  constraint: '强制约束',
  pitfall: '踩坑',
  practice: '有效做法',
  decision: '技术决策',
  fact: '事实',
}
const INSIGHT_SCOPE_LABEL = {
  session: '本次会话',
  repo: '本仓库',
  team: '团队',
  person: '个人',
}
/** 复盘的阶段文案（host 侧 onProgress 上报的 phase）。 */
const REVIEW_PHASE_LABEL = {
  load: '读取账本',
  call: '调用模型（最慢的一步）',
  validate: '校验产出（拒收/降级在这里发生）',
  store: '写入本地洞察库',
}

const FLAG_LABEL = {
  'possible-secret': '含疑似密钥（已二次脱敏，请人工确认）',
  'one-off-narrative': '可能是一次性任务叙述（置信度已下调）',
  'redacted-on-ingest': '入库前做过二次脱敏',
  'environment-failure': '环境类问题（已降级，不参与自动晋升）',
  'transient-self-healed': '会话内已自愈（已降级）',
}

function InsightsTab({ runtime, onOpenConfig }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('')
  const [openId, setOpenId] = useState('')
  const [preview, setPreview] = useState(null)
  const [lastReview, setLastReview] = useState(null)
  /** 运行中的复盘状态（阶段 + 已跑多久），由上面的轮询更新。 */
  const [progress, setProgress] = useState(null)
  /** 晋升计划（跨仓库个人提醒的候选 + 已经是个人提醒的现状）。 */
  const [promo, setPromo] = useState(null)

  /**
   * reviewing 的 ref 镜像 + "本组件里还挂着一个 review/run 的 await" 标记。
   * 轮询回调是异步的，读 state 会拿到闭包里的旧值，所以这两个判定必须走 ref。
   */
  const reviewingRef = useRef(false)
  useEffect(() => { reviewingRef.current = reviewing }, [reviewing])
  const localRunRef = useRef(false)

  const PAGE = 200
  /** 当前已加载条数（用于"操作后重载同一页"，否则用户点了两页、一置顶就缩回一页）。 */
  const loadedRef = useRef(0)

  const load = useCallback(async (q, sc, offset = 0, limit = PAGE) => {
    setBusy(true)
    setError('')
    try {
      const res = await rpc('insights', {
        query: q ?? query,
        scope: sc ?? scope,
        limit,
        offset,
      })
      setData((prev) => {
        const next = offset > 0 && prev
          // 追加模式：只拼列表，统计与分页信息用最新的那份
          ? { ...res, insights: [...prev.insights, ...res.insights] }
          : res
        loadedRef.current = next.insights?.length ?? 0
        return next
      })
    } catch (e) {
      setError(`读取洞察失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [query, scope])

  useEffect(() => { void load('', '', 0) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 增删改之后重载"当前已加载的条数"——limit 取已加载的量而不是固定一页，
   * 否则用户点过「加载更多」之后再置顶一条，列表会缩回第一页。
   */
  const reload = useCallback(() => load(query, scope, 0, Math.max(PAGE, loadedRef.current)), [load, query, scope])

  /**
   * 搜索词防抖：打字停顿 400ms 后自动搜索，回车/按钮仍是立即。
   * 走 loadRef 拿最新的 load（load 随 query/scope 重建，effect 不能直接依赖它，
   * 否则 scope 的即时加载会跟防抖定时器撞成两次请求）。
   */
  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load }, [load])
  const searchInitRef = useRef(false)
  useEffect(() => {
    if (!searchInitRef.current) { searchInitRef.current = true; return }
    const t = setTimeout(() => { void loadRef.current() }, 400)
    return () => clearTimeout(t)
  }, [query])

  const loadPromotions = useCallback(async () => {
    try {
      setPromo(await rpc('insights/promotions'))
    } catch (e) {
      setError(`读取晋升候选失败：${e.message}`)
    }
  }, [])

  const loadPreview = useCallback(async () => {
    try {
      setPreview(await rpc('review/preview', { mode: 'manual' }))
    } catch (e) {
      setPreview({ ok: false, message: e.message })
    }
  }, [])

  useEffect(() => { void loadPreview() }, [loadPreview])
  useEffect(() => { void loadPromotions() }, [loadPromotions])

  /**
   * 复盘进度的轮询 —— 状态以**服务端**（runtime.review.running）为准，
   * 而不是以"本页有没有点过按钮"为准。
   *
   * 为什么必须这样：复盘中切走左侧菜单、刷新页面、甚至换个浏览器标签再回来，
   * 组件重挂载后本地 state 全丢，按钮会错误地变回「现在复盘」—— 再点一次
   * 拿到 ALREADY_RUNNING，用户会以为插件坏了。服务端 runtime 里一直记着
   * running / phase / startedAt，所以这里一进页面先问一次：还在跑就接管进度
   * 显示，跑完了就用 runtime 记下的收尾状态补一条结果反馈。
   *
   * 本地发起的那次复盘由 runReview 自己收尾（它手里有完整报告），
   * 轮询只负责"自动复盘 / 另一个窗口 / 本页中途离开又回来"的那次。
   */
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const data = await rpc('runtime')
        if (!alive) return
        const review = data?.runtime?.review ?? null
        setProgress(review?.running === true ? review : null)
        if (review?.running === true) {
          // 不管是谁发起的（本页 / 自动复盘 / 另一个窗口），先把"在跑"显示出来
          if (!reviewingRef.current) setReviewing(true)
          return
        }
        if (localRunRef.current || !reviewingRef.current) return
        // 服务端已跑完、本地没有 pending 的报告：用 runtime 记下的收尾状态补反馈
        setReviewing(false)
        if (review?.lastStatus === 'ok') {
          setNotice(`复盘完成：新增 ${fmtNum(review.lastAccepted ?? 0)} 条、合并 ${fmtNum(review.lastMerged ?? 0)} 条、拒收 ${fmtNum(review.lastRejected ?? 0)} 条`)
        } else if (review?.lastStatus === 'empty') {
          setNotice('复盘完成：这次会话没有值得沉淀的内容')
        } else if (review?.lastError) {
          setNotice(`复盘未产生结果：${review.lastError}`)
          setLastReview({ failure: { code: String(review.lastStatus || 'failed').toUpperCase(), message: review.lastError } })
        }
        await reload()
        await loadPreview()
      } catch { /* 轮询失败不影响主流程 */ }
    }
    void tick()
    // 跑的时候转得快一点（用户盯着进度）；空闲时低频确认"有没有别处在跑"
    const t = setInterval(() => { void tick() }, reviewing ? 1500 : 3000)
    return () => { alive = false; clearInterval(t) }
  }, [reviewing, reload, loadPreview])

  const runReview = useCallback(async () => {
    if (!(await askConfirm({
      title: '现在复盘一次？',
      body: '这会调用你自己配置的模型（产生 API 费用），并把归纳结果写进本地洞察库。\n生成的内容会出现在下次进这个仓库时的上下文里。',
      okLabel: '开始复盘',
    }))) return
    setReviewing(true)
    setError('')
    setNotice('')
    setLastReview(null)
    localRunRef.current = true
    try {
      const report = await rpc('review/run', { mode: 'manual' })
      if (report?.status === 'running') {
        /**
         * 并发锁挡回来了：自动复盘或另一个窗口正在跑。这不是失败 ——
         * 保持"复盘中"的显示，让轮询接管进度与收尾，
         * 而不是把 ALREADY_RUNNING 当成"上次失败"挂在页面上吓人。
         */
        setNotice('已有一次复盘在进行中（自动复盘或另一个窗口），进度已同步到本页。')
        return
      }
      setLastReview(report)
      if (report?.status === 'ok') setNotice(`复盘完成：新增 ${report.stored?.added?.length ?? 0} 条、合并 ${report.stored?.merged?.length ?? 0} 条、拒收 ${report.rejected?.length ?? 0} 条`)
      else if (report?.status === 'empty') setNotice(`复盘完成：这次会话没有值得沉淀的内容（${report.modelNotes || '模型认为不需要记'}）`)
      else setNotice(`复盘未产生结果：${report?.failure?.message ?? report?.status ?? '未知原因'}`)
      await reload()
      await loadPreview()
      setReviewing(false)
    } catch (e) {
      setError(`复盘失败：${e.message}`)
      setReviewing(false)
    } finally {
      localRunRef.current = false
    }
  }, [reload, loadPreview])

  const mutate = useCallback(async (id, patch) => {
    setError('')
    try {
      await rpc('insights/mutate', { id, patch })
      await reload()
      await loadPreview()
    } catch (e) {
      setError(`操作失败：${e.message}`)
    }
  }, [reload, loadPreview])

  /**
   * 当前列表。**必须定义在所有用到它的 useCallback 之前** ——
   * `const` 有 TDZ：把 `list` 写在 `mergeInto` 后面时，`[list, ...]` 这个依赖数组
   * 会在每次渲染时抛 `Cannot access 'list' before initialization`，
   * 整个洞察页直接白屏（而构建、静态检查、单测全都不会报）。
   * 这个 bug 是 DOM 级自检（scripts/gui-check.mjs）抓出来的。
   */
  const list = data?.insights ?? []

  /**
   * 手动合并：把当前这条并入另一条（证据链与复现次数都会累加过去）。
   *
   * 为什么必须有这个入口：自动相似度合并**一定会漏**（同一条经验被模型用
   * "约束"和"事实"两种框架各说一遍时措辞可能完全不同）。而库里堆着两条说的
   * 是同一件事的条目，会让注入预算被重复内容吃掉。这个问题只有人能判断。
   *
   * 选择目标走插件内的选择对话框（askPick，带关键词过滤）——
   * 以前用 window.prompt 让用户手抄 id 前缀，和 confirm 一样是原生弹窗
   * （带浏览器标头、阻塞线程、不跟随主题），而且抄 id 本来就容易错。
   */
  const mergeInto = useCallback(async (fromId, title) => {
    const others = list.filter((i) => i.id !== fromId)
    if (others.length === 0) {
      setError('库里只有这一条，没有可合并的目标')
      return
    }
    const picked = await askPick({
      title: '把这条并入哪一条？',
      body: `来源：${title}\n\n证据链与复现次数都会累加到目标条目，来源条目会被删除。`,
      items: others.map((i) => ({ value: i.id, label: i.title, hint: i.id.slice(0, 8) })),
      placeholder: '输入标题关键词或 id 前缀过滤',
    })
    if (!picked) return
    try {
      await rpc('insights/merge', { from: fromId, into: picked.value })
      setNotice('已合并（证据链与复现次数都累加到目标条目）')
      await reload()
      await loadPreview()
    } catch (e) {
      setError(`合并失败：${e.message}`)
    }
  }, [list, reload, loadPreview])

  /**
   * 晋升为跨仓库的个人提醒。
   *
   * **这一步没有任何自动成分**：跨工作区聚合会把同一台机器上不同雇主/项目的
   * 经验混在一起（DESIGN 决策 5 因此默认关），所以只能由人明确点一下。
   * 确认框里必须写清"它会在每个仓库的上下文里出现"—— 扩大适用范围是有代价的。
   */
  const promote = useCallback(async (id, title, toScope = 'person') => {
    const target = toScope === 'team' ? '团队规范段（所有仓库、以及将来共享给别人的仓库）' : '个人提醒段（你在本机的每个仓库）'
    if (!(await askConfirm({
      title: `把这条晋升到${target}？`,
      body: `${title}\n\n晋升是「移动」不是「复制」：原来那条会变成跨项目条目，下次进任何仓库都会看到它。随时可以退回。`,
      okLabel: '晋升',
    }))) return
    setError('')
    try {
      await rpc('insights/promote', { id, scope: toScope, confirm: true })
      setNotice(toScope === 'team' ? '已晋升为团队规范' : '已晋升为个人提醒（跨仓库生效）')
      await reload()
      await loadPromotions()
      await loadPreview()
    } catch (e) {
      setError(`晋升失败：${e.message}`)
    }
  }, [reload, loadPromotions, loadPreview])

  /** 退回原作用域（用晋升时记下来的来源）。 */
  const demote = useCallback(async (id) => {
    setError('')
    try {
      await rpc('insights/demote', { id })
      setNotice('已退回原作用域')
      await reload()
      await loadPromotions()
      await loadPreview()
    } catch (e) {
      setError(`退回失败：${e.message}`)
    }
  }, [reload, loadPromotions, loadPreview])

  const remove = useCallback(async (id, title) => {
    if (!(await askConfirm({
      title: '删除这条洞察？',
      body: `${title}\n\n（日志里会留一条删除记录，索引可重建）`,
      okLabel: '删除',
      danger: true,
    }))) return
    setError('')
    try {
      await rpc('insights/delete', { id })
      await reload()
      await loadPreview()
    } catch (e) {
      setError(`删除失败：${e.message}`)
    }
  }, [reload, loadPreview])

  const r = runtime ?? {}
  const stats = data?.stats ?? r.insights ?? {}
  const gate = preview?.ok ? preview.gate : null

  return (
    <div>
      <div className="dvev-h">洞察分析</div>

      {error ? <div className="dvev-banner dvev-err">{error}</div> : null}
      {notice ? <div className="dvev-banner dvev-info">{notice}</div> : null}

      {/* ---- 手动复盘：默认开关关着，所以这个入口是必须的 ---- */}
      <div className={`dvev-banner ${gate?.manualAllowed ? 'dvev-info' : 'dvev-warn'}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="dvev-btn dvev-primary" onClick={runReview} disabled={reviewing}>
            {reviewing ? '复盘中…（请稍候）' : '现在复盘'}
          </button>
          <button className="dvev-btn" onClick={() => { void load(); void loadPreview() }} disabled={busy}>刷新</button>
          {gate ? (
            <span className="dvev-muted">
              {gate.manualAllowed
                ? `可以跑：${gate.turns} 轮 · 距上次复盘新增 ${fmtNum(gate.newRecords)} 条记录`
                : <span className="dvev-warn">当前不能跑：{gate.manualBlockers.join('；')}</span>}
            </span>
          ) : null}
          {preview?.ok ? (
            <span className="dvev-muted">
              {preview.model?.model ? (
                <>
                  用 <span className="dvev-mono">{preview.model.provider ? `${preview.model.provider} / ` : ''}{preview.model.model}</span>
                  （配置里指定的）
                </>
              ) : (
                <span className="dvev-warn">
                  还没解析出用哪个模型
                  {onOpenConfig ? <> —— <button className="dvev-btn" onClick={onOpenConfig}>去选一个</button></> : null}
                </span>
              )}
              {preview.llmAvailable ? '' : <span className="dvev-err">　⚠ 宿主未提供模型服务</span>}
            </span>
          ) : null}
        </div>
        <div className="dvev-muted" style={{ marginTop: 6 }}>
          <b>会花钱</b>：这会调用你自己配置的模型。跑之前可以先看「试跑」页估算，
          或把「配置 → 自动复盘 → 每日 token 预算」设一个上限。
          {preview?.ok && preview.budget > 0
            ? `　今日已用 ${fmtNum((preview.usage?.inputTokens ?? 0) + (preview.usage?.outputTokens ?? 0))} / ${fmtNum(preview.budget)} token`
            : '　当前未设预算上限（0 = 不限）。'}
          {reviewing ? (
            <span className="dvev-warn">
              　⚠ 进行中：{REVIEW_PHASE_LABEL[progress?.phase] ?? '准备中'}
              {progress?.startedAt ? `（已 ${fmtDuration(Date.now() - progress.startedAt)}）` : ''}
              　期间不必重复点，重复点不会重复花钱（有并发锁）。
            </span>
          ) : null}
        </div>
        {lastReview?.failure ? (
          <div className="dvev-err" style={{ marginTop: 6 }}>
            上次失败：{lastReview.failure.code} —— {lastReview.failure.message}
            {lastReview.failure.preview ? <div className="dvev-pre" style={{ marginTop: 6, maxHeight: 160 }}>{lastReview.failure.preview}</div> : null}
          </div>
        ) : null}
      </div>

      {/* ---- 统计 ---- */}
      <div className="dvev-cards">
        <Card k="洞察总数" v={fmtNum(stats.total ?? 0)} />
        <Card k="生效中" v={fmtNum(stats.active ?? 0)} />
        <Card k="复现 ≥2 次" v={fmtNum(stats.recurred ?? 0)} />
        <Card k="已置顶" v={fmtNum(stats.pinned ?? 0)} />
        <Card k="已采纳" v={fmtNum(stats.accepted ?? 0)} />
        <Card k="注入段" v={`${fmtNum(r.injectCache?.roots ?? 0)} 个仓库`} />
      </div>

      {/* ---- 注入现状 ---- */}
      {r.injectCache ? (
        <div className="dvev-muted" style={{ marginTop: 8 }}>
          注入缓存：{fmtNum(r.injectCache.roots)} 个仓库已就绪
          {r.injectCache.activeRepo ? `，当前活跃仓库 ${r.injectCache.activeRepo}` : '，尚未识别到活跃仓库'}
          {r.injectCache.lastError ? <span className="dvev-err">（{r.injectCache.lastError}）</span> : null}
        </div>
      ) : null}
      {r.inject?.error ? <div className="dvev-banner dvev-warn">注入告警：{r.inject.error}</div> : null}

      {/* ---- 个人进化（跨仓库提醒）：这是 personal / team 两段唯一的来源 ---- */}
      <div className="dvev-h2">个人进化（跨仓库提醒）</div>
      <div className="dvev-muted" style={{ marginBottom: 6 }}>
        把「只在这个仓库成立」的经验提升为「在你的每个仓库都适用」。
        <b>本插件不会自动做跨工作区聚合</b> —— 那会把不同雇主/项目的经验混在一起，
        所以这一步永远由你点。晋升是<b>移动</b>，随时可以退回。
      </div>
      {promo ? (
        <>
          <div className="dvev-muted" style={{ marginBottom: 6 }}>
            门槛：在 ≥{promo.minRecurrence} 次会话里复现过
            {promo.pinOnPromote ? '　·　晋升后自动置顶' : ''}
            {(promo.current ?? []).length > 0 ? `　·　当前已有 ${(promo.current ?? []).length} 条跨仓库条目` : ''}
          </div>
          {(promo.eligible ?? []).length === 0 ? (
            <div className="dvev-muted">
              暂时没有够格的候选（复现次数不够，或被标注为环境类/一次性问题）。
              被挡在外面的条目会列在下面。
            </div>
          ) : (
            <table className="dvev-table">
              <thead><tr><th>候选</th><th style={{ width: 60 }}>复现</th><th style={{ width: 90 }}>来源</th><th style={{ width: 190 }}>操作</th></tr></thead>
              <tbody>
                {(promo.eligible ?? []).slice(0, 20).map((i) => (
                  <tr key={i.id}>
                    <td>{i.title}</td>
                    <td className="dvev-mono">{i.recurrence}</td>
                    <td className="dvev-muted">{i.repo || '—'}</td>
                    <td>
                      <button className="dvev-btn" style={{ padding: '2px 7px', fontSize: 11 }}
                        onClick={() => void promote(i.id, i.title, 'person')}>晋升为个人提醒</button>
                      <button className="dvev-btn" style={{ padding: '2px 7px', fontSize: 11, marginLeft: 4 }}
                        onClick={() => void promote(i.id, i.title, 'team')}>晋升为团队规范</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(promo.current ?? []).length > 0 ? (
            <>
              <div className="dvev-muted" style={{ marginTop: 6 }}>当前跨仓库生效的条目：</div>
              <table className="dvev-table">
                <tbody>
                  {(promo.current ?? []).map((i) => (
                    <tr key={i.id}>
                      <td>
                        <span className="dvev-tag">{INSIGHT_SCOPE_LABEL[i.scope] ?? i.scope}</span> {i.title}
                        {i.promotedFrom?.from?.repo
                          ? <span className="dvev-muted">（来自 {i.promotedFrom.from.repo}）</span>
                          : null}
                      </td>
                      <td style={{ width: 80 }}>
                        <button className="dvev-btn" style={{ padding: '2px 7px', fontSize: 11 }}
                          onClick={() => void demote(i.id)}>退回</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          {(promo.skipped ?? []).length > 0 ? (
            <details style={{ marginTop: 6 }}>
              <summary className="dvev-muted" style={{ cursor: 'pointer' }}>
                被挡在外面的 {promo.skipped.length} 条（点开看原因）
              </summary>
              <ul className="dvev-muted">
                {promo.skipped.map((i) => <li key={i.id}>{i.title} —— {i.reason}</li>)}
              </ul>
            </details>
          ) : null}
        </>
      ) : <div className="dvev-muted">读取中…</div>}

      {/* ---- 搜索与筛选 ---- */}
      <div className="dvev-h2">全部条目</div>
      <div className="dvev-row">
        <input
          type="text"
          placeholder="关键词搜索（标题与正文）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void load() }}
          style={{ width: 260, padding: '4px 7px', borderRadius: 5, border: '1px solid var(--border,#333)', background: 'rgba(0,0,0,.28)', color: 'inherit' }}
        />
        <select value={scope} onChange={(e) => { setScope(e.target.value); void load(query, e.target.value) }}>
          <option value="">全部作用域</option>
          <option value="repo">本仓库</option>
          <option value="team">团队</option>
          <option value="person">个人</option>
          <option value="session">本次会话</option>
        </select>
        <button className="dvev-btn" onClick={() => void load()} disabled={busy}>{busy ? '读取中…' : '搜索'}</button>
        {data?.promotion ? <span className="dvev-muted">自动晋升门槛：复现 ≥{data.promotion.minRecurrence} 次</span> : null}
      </div>

      {list.length === 0 ? (
        <div className="dvev-empty">
          还没有洞察。<br />
          <span className="dvev-muted">
            先正常对话几轮攒够材料，再点上面的「现在复盘」。
            想先看效果不花钱，去「试跑」页。
          </span>
        </div>
      ) : (
        <table className="dvev-table">
          <thead>
            <tr>
              <th style={{ width: 74 }}>类型</th>
              <th>结论</th>
              <th style={{ width: 70 }}>作用域</th>
              <th style={{ width: 54 }}>复现</th>
              <th style={{ width: 150 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((item) => (
              <Fragment key={item.id}>
                <tr>
                  <td><span className="dvev-tag">{INSIGHT_TYPE_LABEL[item.type] ?? item.type}</span></td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <span style={{ flex: 1 }}>{item.title}</span>
                      {item.pinned ? <span className="dvev-tag dvev-hit">置顶</span> : null}
                      {item.accepted ? <span className="dvev-tag dvev-hit">已采纳</span> : null}
                      {(item.flags ?? []).map((f) => (
                        <span key={f} className="dvev-tag dvev-miss" title={FLAG_LABEL[f] ?? f}>!</span>
                      ))}
                    </div>
                    {item._score !== undefined ? (
                      <div className="dvev-muted" style={{ fontSize: 11 }}>
                        注入排序分 {item._score}
                        {item.repo ? ` · ${item.repo}` : ''}
                      </div>
                    ) : null}
                  </td>
                  <td className="dvev-muted">{INSIGHT_SCOPE_LABEL[item.scope] ?? item.scope}</td>
                  <td className="dvev-mono">{item.recurrence}</td>
                  <td>
                    <button className="dvev-btn" style={{ padding: '2px 7px', fontSize: 11 }}
                      onClick={() => setOpenId(openId === item.id ? '' : item.id)}>
                      {openId === item.id ? '收起' : '详情'}
                    </button>
                    <button className="dvev-btn" style={{ padding: '2px 7px', fontSize: 11, marginLeft: 4 }}
                      onClick={() => void mutate(item.id, { pinned: !item.pinned })}>
                      {item.pinned ? '取消置顶' : '置顶'}
                    </button>
                    <button className="dvev-btn" style={{ padding: '2px 7px', fontSize: 11, marginLeft: 4 }}
                      onClick={() => void mutate(item.id, { accepted: !item.accepted })}>
                      {item.accepted ? '取消采纳' : '采纳'}
                    </button>
                    <button className="dvev-btn" style={{ padding: '2px 7px', fontSize: 11, marginLeft: 4 }}
                      onClick={() => void remove(item.id, item.title)}>删除</button>
                  </td>
                </tr>
                {openId === item.id ? (
                  <tr>
                    <td colSpan={5} style={{ background: 'rgba(255,255,255,.02)' }}>
                      {item.detail ? <div style={{ marginBottom: 6 }}>{item.detail}</div> : null}
                      {(item.flags ?? []).length > 0 ? (
                        <div className="dvev-warn" style={{ marginBottom: 6 }}>
                          {(item.flags ?? []).map((f) => <div key={f}>· {FLAG_LABEL[f] ?? f}</div>)}
                        </div>
                      ) : null}
                      <div className="dvev-muted">证据链（{item.evidence?.length ?? 0} 条）</div>
                      {(item.evidence ?? []).length === 0
                        ? <div className="dvev-err">没有证据 —— 这条不该存在，建议删除。</div>
                        : (
                          <table className="dvev-table">
                            <tbody>
                              {(item.evidence ?? []).map((ev, i) => (
                                <tr key={i}>
                                  <td className="dvev-mono" style={{ width: 200 }}>{ev.sessionId || '(无会话)'}</td>
                                  <td style={{ width: 70 }}>{ev.turn === undefined ? '—' : `第 ${ev.turn} 轮`}</td>
                                  <td>{ev.quote ? `“${ev.quote}”` : <span className="dvev-muted">（无原文引用）</span>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      {item.promotedFrom?.from ? (
                        <div className="dvev-warn" style={{ marginTop: 6 }}>
                          这条是从「{INSIGHT_SCOPE_LABEL[item.promotedFrom.from.scope] ?? item.promotedFrom.from.scope}
                          {item.promotedFrom.from.repo ? ` · ${item.promotedFrom.from.repo}` : ''}」晋升来的，
                          现在会在**每个**仓库的上下文里出现（可退回）。
                        </div>
                      ) : null}
                      <div className="dvev-muted" style={{ marginTop: 6 }}>
                        置信度 {(Number(item.confidence ?? 0) * 100).toFixed(0)}%
                        　·　被注入 {fmtNum(item.injectedCount ?? 0)} 次
                        　·　首次 {fmtTime(item.firstSeenAt)}　最近 {fmtTime(item.lastSeenAt)}
                      </div>
                      <div className="dvev-row" style={{ marginTop: 6 }}>
                        <button className="dvev-btn" style={{ fontSize: 11 }}
                          onClick={() => void mutate(item.id, { scope: item.scope === 'repo' ? 'team' : 'repo' })}>
                          切换为{ item.scope === 'repo' ? '团队' : '本仓库' }作用域
                        </button>
                        <button className="dvev-btn" style={{ fontSize: 11 }}
                          onClick={() => void mutate(item.id, { archived: !item.archived })}>
                          {item.archived ? '取消归档' : '归档（从注入中移除，保留数据）'}
                        </button>
                        <button className="dvev-btn" style={{ fontSize: 11 }}
                          onClick={() => void mutate(item.id, { priority: (item.priority ?? 0) + 1 })}>
                          提高优先级（当前 {item.priority ?? 0}）
                        </button>
                        <button className="dvev-btn" style={{ fontSize: 11 }}
                          onClick={() => void mergeInto(item.id, item.title)}>
                          合并到另一条（去重）
                        </button>
                        {item.scope === 'person' || item.scope === 'team' ? (
                          <button className="dvev-btn" style={{ fontSize: 11 }}
                            onClick={() => void demote(item.id)}>
                            退回原作用域{item.promotedFrom?.from?.repo ? `（${item.promotedFrom.from.repo}）` : ''}
                          </button>
                        ) : (
                          <>
                            <button className="dvev-btn" style={{ fontSize: 11 }}
                              onClick={() => void promote(item.id, item.title, 'person')}>
                              晋升为个人提醒（跨仓库）
                            </button>
                            <button className="dvev-btn" style={{ fontSize: 11 }}
                              onClick={() => void promote(item.id, item.title, 'team')}>
                              晋升为团队规范
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {data?.page?.hasMore ? (
        <div className="dvev-row" style={{ marginTop: 8 }}>
          <button className="dvev-btn" onClick={() => void load(query, scope, (data?.insights?.length ?? 0))} disabled={busy}>
            {busy ? '加载中…' : `加载更多（还有 ${fmtNum(data.page.total - (data?.insights?.length ?? 0))} 条）`}
          </button>
          <span className="dvev-muted">共 {fmtNum(data.page.total)} 条，已显示 {fmtNum(data?.insights?.length ?? 0)} 条</span>
        </div>
      ) : null}

      {/* ---- 维护：数据在你的手里，这两件事必须能自己做 ---- */}
      <div className="dvev-h2">维护</div>
      <div className="dvev-row">
        <button className="dvev-btn" disabled={busy} onClick={async () => {
          setError(''); setNotice('')
          try {
            await rpc('insights/rebuild')
            setNotice('已从日志重建索引（数据未改动）')
            await reload(); await loadPromotions(); await loadPreview()
          } catch (e) { setError(`重建失败：${e.message}`) }
        }}>从日志重建索引</button>
        <span className="dvev-muted">
          真相源永远是一行一次的 <span className="dvev-mono">insights.ndjson</span>；
          <span className="dvev-mono">index.json</span> 只是派生快照。手改过日志、或怀疑索引不一致时点这个。
        </span>
      </div>
      <div className="dvev-row">
        <button className="dvev-btn" disabled={busy} onClick={async () => {
          if (!(await askConfirm({
            title: '清空全部洞察？',
            body: '· 清空前会把整份日志**留档**到 insights/insights.cleared.<时间戳>.ndjson\n'
              + '· 这一点是故意的：你想要的是"看不见了"，不是"不可恢复"\n\n'
              + '确定要继续吗？',
            okLabel: '清空',
            danger: true,
          }))) return
          setError(''); setNotice('')
          try {
            const res = await rpc('insights/clear')
            setNotice(`已清空 ${res.removed} 条，留档：${res.archivedTo}`)
            await reload(); await loadPromotions(); await loadPreview()
          } catch (e) { setError(`清空失败：${e.message}`) }
        }}>清空洞察（先留档）</button>
        <span className="dvev-muted">
          清空后注入立刻变空。留档文件留在数据目录里，随时可以拿回来看。
        </span>
      </div>

      {/* ---- 规则说明：用户有权知道什么会被拒 ---- */}
      <div className="dvev-h2">入库校验规则（代码层，不只是 prompt 里说说）</div>
      <div className="dvev-muted" style={{ marginBottom: 6 }}>
        归纳结果入库前会过这些规则。命中"拒收"的条目**不会**出现在上面，也不会被注入。
      </div>
      <table className="dvev-table">
        <thead><tr><th style={{ width: 90 }}>处置</th><th>规则</th></tr></thead>
        <tbody>
          {(data?.ruleDescriptions ?? []).map((rule) => (
            <tr key={rule.id}>
              <td>
                <span className={`dvev-tag ${rule.kind === 'reject' ? 'dvev-err' : rule.kind === 'downgrade' ? 'dvev-miss' : ''}`}>
                  {rule.kind === 'reject' ? '拒收' : rule.kind === 'downgrade' ? '降级' : '标注'}
                </span>
              </td>
              <td>{rule.why}<div className="dvev-muted dvev-mono" style={{ fontSize: 11 }}>{rule.id} · {rule.count} 条模式</div></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="dvev-row" style={{ marginTop: 10 }}>
        <button className="dvev-btn" onClick={onOpenConfig}>去配置复盘与注入预算</button>
      </div>
    </div>
  )
}

// ================= 注入预览 =================
/**
 * 这个页面回答一个用户最该关心、却最难自己验证的问题：
 * **"下次我说话的时候，到底会有什么东西被塞进 context？"**
 *
 * 信任是靠可见性建立的。所以这里把**逐字的注入文本**原样展示出来，
 * 并说明它是从哪个仓库的哪几条洞察拼出来的、占了多少预算。
 */
function InjectTab({ runtime }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pick, setPick] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const res = await rpc('inject/preview', {})
      setData(res)
      if (!pick && res?.repos?.length > 0) setPick(res.repos[0].repoRoot)
    } catch (e) {
      setError(`读取注入预览失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [pick])

  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const repos = data?.repos ?? []
  const current = repos.find((r) => r.repoRoot === pick) ?? repos[0]
  /** 逐字文本优先取列表里那条（后端已带上），退回 detail（单仓库查询时用）。 */
  const currentText = current?.text ?? (data?.detail?.repoRoot === current?.repoRoot ? data?.detail?.text : '') ?? ''
  const cache = runtime?.injectCache ?? data?.stats ?? {}

  return (
    <div>
      <div className="dvev-h">注入预览</div>

      {error ? <div className="dvev-banner dvev-err">{error}</div> : null}

      <div className="dvev-banner dvev-info">
        这是<b>真正会被放进 system prompt 的那段文本</b>（不是模拟）。它在本地生成，
        不含任何网络请求。冲突时以代码为准 —— 这句话也会原样写进注入文本里。
      </div>

      <div className="dvev-row">
        <button className="dvev-btn" onClick={() => void load()} disabled={busy}>{busy ? '刷新中…' : '重新计算'}</button>
        {repos.length > 1 ? (
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            {repos.map((r) => <option key={r.repoRoot} value={r.repoRoot}>{r.repo} · {r.totalChars} 字</option>)}
          </select>
        ) : null}
        <span className="dvev-muted">
          已识别 {fmtNum(cache.roots ?? 0)} 个仓库 · 目录表 {fmtNum(cache.dirs ?? 0)} 条
          {cache.lastRefreshAt ? ` · 最近刷新 ${fmtTime(cache.lastRefreshAt)}` : ''}
        </span>
      </div>

      {repos.length === 0 ? (
        <div className="dvev-empty">
          还没有任何仓库的注入内容。<br />
          <span className="dvev-muted">
            原因可能是：洞察库为空（先跑一次复盘）、或者还没识别出你在哪个仓库里工作。
            在某个 git 仓库目录里开一次会话之后，这里就会出现它。
          </span>
        </div>
      ) : (
        <>
          <div className="dvev-cards">
            <Card k="注入字数" v={fmtNum(current?.totalChars ?? 0)} />
            <Card k="约合 token" v={fmtNum(current?.totalTokens ?? 0)} />
            <Card k="条目数" v={fmtNum((current?.sections ?? []).reduce((n, s) => n + s.count, 0))} />
            <Card k="被挡在外面" v={fmtNum(current?.dropped?.length ?? 0)} />
          </div>

          <div className="dvev-h2">分段明细</div>
          <table className="dvev-table">
            <thead><tr><th style={{ width: 130 }}>段</th><th style={{ width: 70 }}>层</th><th style={{ width: 60 }}>条数</th><th style={{ width: 60 }}>字数</th><th>内容</th></tr></thead>
            <tbody>
              {(current?.sections ?? []).map((s) => (
                <tr key={s.id}>
                  <td>{s.title}</td>
                  <td className="dvev-muted">{s.layer === 'stable' ? '稳定' : '易变'}</td>
                  <td className="dvev-mono">{s.count}{s.skipped > 0 ? <span className="dvev-warn"> (+{s.skipped} 挡)</span> : null}</td>
                  <td className="dvev-mono">{s.chars}</td>
                  <td>
                    {s.items.length === 0
                      ? <span className="dvev-muted">（空）</span>
                      : s.items.map((i, idx) => (
                        <div key={idx}>
                          <span className="dvev-tag">{INSIGHT_TYPE_LABEL[i.type] ?? i.type}</span>{' '}
                          {i.title}
                          {i.recurrence > 1 ? <span className="dvev-muted">（复现 {i.recurrence} 次）</span> : null}
                        </div>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {(current?.dropped ?? []).length > 0 ? (
            <>
              <div className="dvev-h2">因预算/配额未入选</div>
              <div className="dvev-muted">
                这些条目在库里，但因为分段预算或单作用域配额没进这次注入。想让它进去，可以调大
                「配置 → 注入」里的段预算，或者删掉/归档几条更不重要的。
              </div>
              <ul className="dvev-muted">
                {(current.dropped ?? []).slice(0, 20).map((d, i) => <li key={i}>{d.title}</li>)}
              </ul>
            </>
          ) : null}

          <div className="dvev-h2">逐字文本</div>
          <div className="dvev-muted" style={{ marginBottom: 6 }}>
            这就是下一次在这个仓库里说话时，被放进 system prompt 的那段文字（原样，未加工）。
          </div>
          <div className="dvev-pre" style={{ maxHeight: 380 }}>
            {currentText || '（空 —— 这个仓库当前没有任何条目会被注入）'}
          </div>
        </>
      )}
    </div>
  )
}

// ================= 导出与草稿 =================
/**
 * 两件事：
 *   · **导出**（安全）：把洞察导成 markdown/JSON 落到 `exports/`，用户可搬走
 *   · **skill 草稿**（可能动仓库）：把沉淀写成 SKILL.md。写进仓库前**必须确认**，
 *     因为那会在用户的 git 仓库里建文件，可能被误提交或触发 CI。
 *
 * 前半段是"你的数据你能拿走"，后半段是"团队共享靠 git，不靠我" —— 分别对应
 * DESIGN 的决策 4 与决策 3。
 */
function ExportTab({ runtime, config }) {
  const [md, setMd] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [scope, setScope] = useState('')
  const [plan, setPlan] = useState(null)
  const [confirmWrite, setConfirmWrite] = useState(false)
  /** 手动自检一份 SKILL.md（你可以手改它，改完先验一遍再提交）。 */
  const [skillText, setSkillText] = useState('')
  const [skillErrors, setSkillErrors] = useState(null)
  /**
   * skill 草稿的目标仓库（repoRoot）。这是团队共享闭环的关键：
   * 落点选「仓库内」（.dsh/skills）时，**必须**知道写进哪个仓库，
   * 以前这里永远拿不到 repoRoot，于是永远回退到插件数据目录、写不进仓库。
   * 列表来自注入缓存里"真实见过的仓库"（与注入预览同一口径），
   * 团队规范条目（scope=team）不属于任何仓库，任何选择都会带上它们。
   */
  const [repos, setRepos] = useState([])
  const [repoPick, setRepoPick] = useState('')

  useEffect(() => {
    let alive = true
    if (typeof window !== 'undefined') window.__dvevExportProbe = { fired: true, settled: false, aliveOnSettle: null, repoCount: null }
    rpc('inject/preview', {})
      .then((res) => {
        if (typeof window !== 'undefined') window.__dvevExportProbe = { fired: true, settled: true, aliveOnSettle: alive, repoCount: (res?.repos ?? []).length }
        if (!alive) return
        const list = (res?.repos ?? []).map((r) => ({ repoRoot: r.repoRoot, repo: r.repo }))
        setRepos(list)
        // 默认选中"当前活跃仓库"（与总览页同一口径），认不出就退到列表第一个
        const active = res?.stats?.activeRoot
        if (!repoPick) setRepoPick(active && list.some((r) => r.repoRoot === active) ? active : (list[0]?.repoRoot ?? ''))
      })
      .catch((e) => {
        if (typeof window !== 'undefined') window.__dvevExportProbe = { fired: true, settled: true, aliveOnSettle: alive, repoCount: -1, err: String(e?.message ?? e) }
      })
    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadExport = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      setMd(await rpc('export/markdown', { scope }))
    } catch (e) {
      setError(`生成导出失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [scope])

  const writeExportFile = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const res = await rpc('export/write', { scope })
      setNotice(`已导出 ${res.count} 条 → ${res.mdPath}`)
    } catch (e) {
      setError(`导出失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [scope])

  /**
   * 自检一份 SKILL.md。
   *
   * 为什么值得做这个入口：宿主对格式错误**完全静默**（只在日志里 warn 一句），
   * 用户看到的是"技能没生效"。而生成的草稿是会被人工编辑的（改措辞、加步骤），
   * 手改之后能当场验一遍，比事后怀疑人生强。
   */
  const validateSkill = useCallback(async () => {
    setError(''); setSkillErrors(null)
    try {
      const res = await rpc('skills/validate', { text: skillText })
      setSkillErrors(res.errors ?? [])
    } catch (e) {
      setError(`自检失败：${e.message}`)
    }
  }, [skillText])

  const planSkills = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const picked = repos.find((r) => r.repoRoot === repoPick)
      setPlan(await rpc('skills/plan', { repo: picked?.repo ?? '', repoRoot: repoPick }))
      setConfirmWrite(false)
    } catch (e) {
      setError(`生成草稿计划失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [repos, repoPick])

  const writeSkills = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const picked = repos.find((r) => r.repoRoot === repoPick)
      const res = await rpc('skills/write', { confirm: true, repo: picked?.repo ?? '', repoRoot: repoPick })
      setNotice(`已写入 ${res.written.length} 个技能文件到 ${res.dir}${res.skipped.length > 0 ? `，跳过 ${res.skipped.length} 个` : ''}`)
      await planSkills()
    } catch (e) {
      setError(`写入失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [planSkills, repos, repoPick])

  /**
   * 导入一份导出 JSON（恢复通道：换机器 / 误清空后把数据搬回来）。
   *
   * 浏览器里读文件没有别的办法，用 <input type="file"> + FileReader 语义
   * （file.text()）；文本整包发给 host，解析与校验都在 host 半做 ——
   * 客户端不重复实现格式判断，避免两边漂移。
   */
  const importFile = useCallback(async (file) => {
    setBusy(true)
    setError('')
    try {
      const text = await file.text()
      const res = await rpc('insights/import', { text })
      const rejected = res.rejected?.length ?? 0
      setNotice(`导入完成：新增 ${res.addedCount} 条 · 跳过 ${res.skipped} 条（已有）`
        + `${rejected > 0 ? ` · 拒收 ${rejected} 条` : ''} —— 重复导入同一份文件是零副作用的`)
    } catch (e) {
      setError(`导入失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div>
      <div className="dvev-h">导出草稿</div>

      {error ? <div className="dvev-banner dvev-err">{error}</div> : null}
      {notice ? <div className="dvev-banner dvev-info">{notice}</div> : null}

      <div className="dvev-h2">导出洞察（纯本地）</div>
      <div className="dvev-muted" style={{ marginBottom: 6 }}>
        导成 markdown（人读，带证据链）与 JSON（机读，可再导入）。
        落在数据目录的 <span className="dvev-mono">exports/</span> 下 —— <b>不联网、不碰你的仓库</b>。
      </div>
      <div className="dvev-row">
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">全部作用域</option>
          <option value="repo">仅本仓库</option>
          <option value="team">仅团队</option>
          <option value="person">仅个人</option>
          <option value="session">仅会话</option>
        </select>
        <button className="dvev-btn" onClick={() => void loadExport()} disabled={busy}>生成预览</button>
        <button className="dvev-btn dvev-primary" onClick={() => void writeExportFile()} disabled={busy}>导出到文件</button>
        {md ? <span className="dvev-muted">{md.count} 条 / 共 {md.total} 条{md.truncated ? '（已截断）' : ''} · {md.filename}</span> : null}
      </div>
      {md ? <div className="dvev-pre" style={{ maxHeight: 320 }}>{md.markdown.slice(0, 20000)}</div> : null}

      <div className="dvev-h2">导入（恢复一份导出）</div>
      <div className="dvev-muted" style={{ marginBottom: 6 }}>
        选一份之前导出的 <span className="dvev-mono">insights-*.json</span>：按 id 恢复、字段原样保留，
        库里已有的条目自动跳过 —— <b>重复导入零副作用</b>，不会把复现次数越导越高。
      </div>
      <div className="dvev-row">
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files && e.target.files[0]
            if (file) void importFile(file)
            e.target.value = ''
          }}
        />
      </div>

      <div className="dvev-h2">skill 草稿</div>
      <div className="dvev-muted" style={{ marginBottom: 6 }}>
        把已经<b>复现过、且被你采纳</b>的条目写成 SKILL.md。DSH 会自动发现
        <span className="dvev-mono"> {config?.skills?.target === 'plugin-local' ? '（当前落点是插件数据目录，不进任何仓库）' : config?.skills?.target} </span>
        —— 团队共享就是"提交上去、别人 pull 下来自动加载"，不需要任何服务器。
      </div>
      <div className="dvev-muted" style={{ marginBottom: 6 }}>
        当前门槛：复现 ≥{config?.export?.skillMinRecurrence ?? 2} 次
        {config?.export?.skillRequireAccepted !== false ? '，且必须已被采纳' : ''}。
        {config?.skills?.target !== 'plugin-local'
          ? <span className="dvev-warn">　⚠ 当前落点在仓库内，写入会在你的 git 仓库里建文件。</span>
          : null}
      </div>
      <div className="dvev-row" style={{ marginBottom: 6 }}>
        <span className="dvev-muted">目标仓库：</span>
        {repos.length > 0 ? (
          <select value={repoPick} onChange={(e) => { setRepoPick(e.target.value); setPlan(null) }}>
            {repos.map((r) => <option key={r.repoRoot} value={r.repoRoot}>{r.repo}</option>)}
          </select>
        ) : (
          <span className="dvev-muted">（还没有识别到任何仓库 —— 先正常对话几轮，或落点保持插件数据目录）</span>
        )}
        {config?.skills?.target !== 'plugin-local' && repoPick === '' && repos.length > 0
          ? <span className="dvev-warn">落点在仓库内但没选出仓库，写入会回退到插件数据目录</span>
          : null}
      </div>
      <div className="dvev-row">
        <button className="dvev-btn" onClick={() => void planSkills()} disabled={busy}>生成草稿计划</button>
        <button className="dvev-btn" disabled={!skillText.trim()} onClick={() => void validateSkill()}>
          自检下面这段 SKILL.md
        </button>
        {skillErrors !== null
          ? (skillErrors.length === 0
            ? <span className="dvev-ok">格式自检通过</span>
            : <span className="dvev-err">有 {skillErrors.length} 个问题：{skillErrors.join('；')}</span>)
          : null}
        {plan && plan.drafts.length > 0 ? (
          <button
            className="dvev-btn dvev-primary"
            onClick={() => void writeSkills()}
            disabled={busy || (plan.needsConfirm && !confirmWrite)}
          >写入 {plan.drafts.length} 个技能文件</button>
        ) : null}
        {plan?.needsConfirm ? (
          <label className="dvev-muted">
            <input type="checkbox" checked={confirmWrite} onChange={(e) => setConfirmWrite(e.target.checked)} />
            {' '}我确认要写入仓库目录 <span className="dvev-mono">{plan.dir?.dir}</span>
          </label>
        ) : null}
      </div>
      <details style={{ marginBottom: 8 }}>
        <summary className="dvev-muted" style={{ cursor: 'pointer' }}>
          手动校验一份 SKILL.md（改过草稿之后贴进来验一遍）
        </summary>
        <textarea
          value={skillText}
          onChange={(e) => { setSkillText(e.target.value); setSkillErrors(null) }}
          placeholder={'---\nname: "my-skill"\ndescription: "什么时候该用它"\n---\n\n正文…'}
          style={{ width: '100%', minHeight: 120, marginTop: 6, fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 11.5 }}
        />
        <div className="dvev-muted" style={{ fontSize: 11 }}>
          会按宿主的解析规则检查：首行必须恰好是 <span className="dvev-mono">---</span>（BOM / 空行 / 尾随空格都会
          让文件被**静默跳过**）、必须有 kebab-case 的 name 与非空 description、不能用已废弃的驼峰键。
        </div>
      </details>

      {plan ? (
        <>
          {plan.reason ? <div className="dvev-banner dvev-warn">{plan.reason}</div> : null}
          <div className="dvev-muted">
            目标目录：<span className="dvev-mono">{plan.dir?.dir || '（未解析出）'}</span>
            {plan.dir?.inRepo ? <span className="dvev-warn">　· 在仓库内</span> : ''}
          </div>
          {plan.drafts.length === 0
            ? <div className="dvev-empty">还没有够格的条目。门槛见上（去「洞察」页把好条目「采纳」一下）。</div>
            : plan.drafts.map((d) => (
              <div className="dvev-group" key={d.key}>
                <div className="dvev-grouphead">
                  {d.name}
                  <span className="dvev-muted" style={{ marginLeft: 8, fontWeight: 400 }}>
                    {d.insights.length} 条依据 · {d.ok ? <span className="dvev-ok">格式自检通过</span> : <span className="dvev-err">格式自检未通过</span>}
                  </span>
                </div>
                <div className="dvev-groupbody">
                  {d.errors.length > 0 ? <div className="dvev-err">{d.errors.join('；')}</div> : null}
                  <div className="dvev-pre" style={{ maxHeight: 260 }}>{d.text}</div>
                </div>
              </div>
            ))}
        </>
      ) : null}
    </div>
  )
}

// ================= 数据预览 =================
function DataTab({ hello, config }) {
  const [days, setDays] = useState(7)
  const [records, setRecords] = useState([])
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [summary, setSummary] = useState(null)
  /** 是否已完成首次加载（首次立即查，之后的输入变化走防抖）。 */
  const dataLoadedRef = useRef(false)

  /**
   * 读账本前先把内存缓冲落盘。
   *
   * 账本是"按会话缓冲 + 空闲落盘"（最多 5 秒延迟）。不先 flush 就查询，用户会看到
   * "我刚才说的话没记上" —— 而它其实在内存里等着落盘。这一步是幂等的，代价可忽略。
   */
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      await rpc('ledger/flush').catch(() => { /* flush 失败也要让查询继续 */ })
      const data = await rpc('ledger', { days, limit: 2000, sessionId })
      setRecords(data.records ?? [])
      setMeta({
        total: data.total ?? 0,
        badLines: data.badLines ?? 0,
        days: data.days ?? [],
        pendingBuffered: data.pendingBuffered ?? 0,
        root: data.root ?? '',
      })
    } catch (e) {
      setError(`读取账本失败：${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [days, sessionId])

  useEffect(() => {
    /**
     * 会话 ID 是输入框：它一变 load 就重建。不加防抖的话，**每敲一个字符**
     * 就发一次 flush + 账本查询（flush 还带落盘 IO），输入长 id 时肉眼可见地卡。
     * 首次挂载立即查；之后的变化统一防抖 400ms（天数下拉切换也走这条，
     * 感知上没有区别）。「刷新」按钮仍然立即查。
     */
    const first = dataLoadedRef.current === false
    dataLoadedRef.current = true
    if (first) { void load(); return }
    const t = setTimeout(() => { void load() }, 400)
    return () => clearTimeout(t)
  }, [load])

  const openSummary = useCallback(async (sid) => {
    if (expanded === sid) { setExpanded(null); setSummary(null); return }
    setExpanded(sid)
    setSummary(null)
    try {
      const data = await rpc('session/summary', { sessionId: sid })
      setSummary(data)
    } catch (e) {
      setSummary({ text: `摘要生成失败：${e.message}` })
    }
  }, [expanded])

  // 倒序展示：最新的事件在最上面
  const rows = useMemo(() => [...records].reverse(), [records])

  return (
    <div>
      <div className="dvev-h">数据预览</div>
      <div className="dvev-muted" style={{ marginBottom: 10 }}>
        这里显示的是**已经写进本地磁盘**的内容。工具的参数与输出不记录，只记工具名与成功/失败。
      </div>

      <div className="dvev-row">
        <label>最近
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ marginLeft: 6 }}>
            <option value={1}>1 天</option>
            <option value={3}>3 天</option>
            <option value={7}>7 天</option>
            <option value={30}>30 天</option>
            <option value={0}>全部</option>
          </select>
        </label>
        <input
          type="text" placeholder="按会话 ID 过滤（留空 = 全部）" value={sessionId}
          onChange={(e) => setSessionId(e.target.value.trim())}
          style={{ width: 300, padding: '4px 7px', borderRadius: 5, border: '1px solid var(--border,#333)',
            background: 'rgba(0,0,0,.28)', color: 'inherit' }}
        />
        <button className="dvev-btn" onClick={load} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
        <span className="dvev-spacer" />
        {meta ? (
          <span className="dvev-muted">
            共 {fmtNum(meta.total)} 条 · 显示 {fmtNum(rows.length)} 条
            {meta.pendingBuffered > 0 ? ` · 内存待落盘 ${meta.pendingBuffered} 条` : ''}
            {meta.badLines > 0 ? <span className="dvev-warn"> · 有 {meta.badLines} 行无法解析</span> : null}
          </span>
        ) : null}
      </div>

      {error ? <div className="dvev-banner dvev-err">{error}</div> : null}

      {rows.length === 0 && !loading ? (
        <div className="dvev-empty">
          还没有记录。<br />
          在这个工作区里正常对话几轮，再回来点「刷新」——账本是每轮实时写入的。
        </div>
      ) : (
        <div style={{ maxHeight: '52vh', overflow: 'auto', border: '1px solid var(--border,#333)', borderRadius: 8 }}>
          <table className="dvev-table">
            <thead>
              <tr>
                <th style={{ width: 96 }}>时间</th>
                <th style={{ width: 82 }}>类型</th>
                <th style={{ width: 46 }}>轮</th>
                <th style={{ width: 130 }}>仓库</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.sid}-${r.seq ?? i}-${i}`}>
                  <td className="dvev-mono">{fmtTime(r.ts)}</td>
                  <td>
                    <span className={`dvev-tag${r.kind === 'tool_result' && r.failed ? ' dvev-err' : ''}`}>
                      {KIND_LABEL[r.kind] ?? r.kind}
                    </span>
                  </td>
                  <td className="dvev-mono">{r.turn ?? '—'}</td>
                  <td className="dvev-mono">{r.repo || <span className="dvev-muted">—</span>}</td>
                  <td>
                    {r.text ? <span className="dvev-mono">{r.text}</span> : null}
                    {r.tool ? (
                      <span className="dvev-mono">
                        {r.tool}
                        {r.kind === 'tool_result'
                          ? (r.failed ? <span className="dvev-err"> · 失败</span> : <span className="dvev-ok"> · 成功</span>)
                          : null}
                      </span>
                    ) : null}
                    {r.status ? <span className="dvev-muted"> · {r.status}</span> : null}
                    {r.errorCode ? <span className="dvev-err"> · {r.errorCode}</span> : null}
                    {r.tokensOut ? <span className="dvev-muted"> · 输出 {fmtNum(r.tokensOut)} tok</span> : null}
                    <button
                      className="dvev-btn"
                      style={{ marginLeft: 8, padding: '1px 6px', fontSize: 11 }}
                      onClick={() => openSummary(r.sid)}
                      title="把该会话折叠成摘要（将来喂给模型的就是这个）"
                    >会话摘要</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {expanded ? (
        <div style={{ marginTop: 12 }}>
          <div className="dvev-h2">会话摘要 · {expanded}</div>
          {summary === null ? (
            <div className="dvev-muted">生成中…</div>
          ) : (
            <>
              <div className="dvev-muted" style={{ marginBottom: 6 }}>
                {summary.turns ?? 0} 轮 · 工具 {summary.toolCalls ?? 0} 次（失败 {summary.toolFailures ?? 0}）·
                输入 {fmtNum(summary.tokensIn ?? 0)} tok · 输出 {fmtNum(summary.tokensOut ?? 0)} tok
                {summary.truncated ? ' · 已截断' : ''}
              </div>
              <div className="dvev-pre">{summary.text || '（无内容）'}</div>
            </>
          )}
        </div>
      ) : null}

      <div className="dvev-row" style={{ marginTop: 12 }}>
        <span className="dvev-muted">
          账本目录：{meta?.root ? `${meta.root}/ledger` : '—'}
          {hello?.meta?.envHome ? `　（可用环境变量 ${hello.meta.envHome} 改默认位置）` : ''}
        </span>
      </div>
    </div>
  )
}

// ================= 脱敏预览 =================
function RedactTab({ config }) {
  const [text, setText] = useState(SAMPLE)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const data = await rpc('redact/preview', { text })
      setResult(data)
    } catch (e) {
      setError(`预览失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [text])

  useEffect(() => { void run() }, []) // 首屏用样例跑一次，让用户立刻看到效果

  return (
    <div>
      <div className="dvev-h">脱敏预览</div>
      <div className="dvev-muted" style={{ marginBottom: 10 }}>
        左边粘一段文本，右边就是**真正会被记录**的样子。脱敏在写入磁盘之前发生，
        所以磁盘上存的就已经是处理过的内容 —— 不是"上传时才脱敏"。
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        style={{ width: '100%', minHeight: 120, padding: 9, borderRadius: 8, border: '1px solid var(--border,#333)',
          background: 'rgba(0,0,0,.28)', color: 'inherit', fontFamily: 'ui-monospace,Consolas,monospace',
          fontSize: 12, resize: 'vertical' }}
      />
      <div className="dvev-row" style={{ marginTop: 8 }}>
        <button className="dvev-btn dvev-primary" onClick={run} disabled={busy}>{busy ? '处理中…' : '预览'}</button>
        <button className="dvev-btn" onClick={() => setText(SAMPLE)}>载入样例</button>
        <span className="dvev-spacer" />
        {result ? <span className="dvev-muted">改动 {result.changedLines} / {result.totalLines} 行</span> : null}
      </div>

      {error ? <div className="dvev-banner dvev-err">{error}</div> : null}

      {result ? (
        <>
          <div className="dvev-h2">处理结果</div>
          <div className="dvev-cmp">
            <div>
              <div className="dvev-cmplabel">原文</div>
              <div className="dvev-pre">{text}</div>
            </div>
            <div>
              <div className="dvev-cmplabel">会被记录的样子</div>
              <div className="dvev-pre">{result.output || '（空）'}</div>
            </div>
          </div>

          <div className="dvev-h2">逐行差异（只列改动过的行）</div>
          {(result.rows ?? []).length === 0 ? (
            <div className="dvev-muted">这段文本没有触发任何脱敏规则。</div>
          ) : (
            <table className="dvev-table">
              <thead><tr><th style={{ width: 46 }}>行</th><th>原文</th><th>处理后</th></tr></thead>
              <tbody>
                {(result.rows ?? []).map((r) => (
                  <tr key={r.line}>
                    <td className="dvev-mono">{r.line}</td>
                    <td className="dvev-mono">{r.before}</td>
                    <td className="dvev-mono dvev-ok">{r.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </div>
  )
}

const SAMPLE = [
  '帮我看下 D:\\work\\demo-project\\src\\OrderCallbackService.java 这段',
  'export DEEPSEEK_API_KEY=sk-demo-1234-abcd-5678-efgh-9012',
  '请求头带了 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
  '数据库连接 postgres://user:password123456@10.0.0.5:5432/prod',
  '普通代码不会被改动：const password = process.env.DB_PASSWORD',
].join('\n')

// ================= 配置 =================
function ConfigTab({ hello, draft, dirty, dirtyView, busy, onSet, onSave, onReset }) {
  /**
   * 模型目录：只在打开配置页时拉一次（host 侧有 60 秒缓存，"刷新"按钮强制取新的）。
   * ⚠️ 必须放在下面的提前 return **之前** —— 有条件的 Hook 会让 React 在
   * "配置还没加载完"的那一帧之后就崩掉。
   */
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState('')
  const [catalogBusy, setCatalogBusy] = useState(false)

  const loadCatalog = useCallback(async (force) => {
    setCatalogBusy(true)
    setCatalogError('')
    try {
      setCatalog(await rpc('models', { force: force === true }))
    } catch (e) {
      setCatalogError(e.message)
    } finally {
      setCatalogBusy(false)
    }
  }, [])

  useEffect(() => { void loadCatalog(false) }, [loadCatalog])

  if (!hello || !draft) {
    return <div className="dvev-empty">配置加载中…（若长时间无响应，请检查插件是否启用）</div>
  }
  const fields = hello.schema?.fields ?? []
  const groups = hello.schema?.groups ?? []
  const dirtySet = new Set(dirty)

  return (
    <div>
      <div className="dvev-h">配置管理</div>
      <div className="dvev-muted" style={{ marginBottom: 10 }}>
        保存后立即生效，无需重启。配置文件：<span className="dvev-mono">{hello.paths?.configFile}</span>
      </div>

      {groups.map((g) => {
        /**
         * `field.hidden` 的字段不渲染——控件由更合适的入口负责（`review.provider` /
         * `review.model` 由上面的模型选择器写，不做手填）。它们仍然参与 dirty
         * 计算，只是展示层会把这一对折叠成一条（见 App 里的 dirtyView）。
         */
        const groupFields = fields.filter((f) => f.group === g.id && f.hidden !== true)
        if (groupFields.length === 0 && g.id !== 'review') return null
        return (
          <div className="dvev-group" key={g.id}>
            <div className="dvev-grouphead">{g.label}</div>
            <div className="dvev-groupbody">
              {/* 复盘这一组多一个"选模型"入口：那是用户最容易卡住的一步 */}
              {g.id === 'review' ? (
                <ReviewModelPicker
                  draft={draft}
                  catalog={catalog}
                  error={catalogError}
                  busy={catalogBusy}
                  onReload={() => { void loadCatalog(true) }}
                  onSet={onSet}
                />
              ) : null}
              {groupFields.map((f) => (
                <Field
                  key={f.path}
                  field={f}
                  value={getPath(draft, f.path)}
                  touched={dirtySet.has(f.path)}
                  onChange={(v) => onSet(f.path, v)}
                />
              ))}
            </div>
          </div>
        )
      })}

      <div className="dvev-dirty">
        <button className="dvev-btn dvev-primary" onClick={onSave} disabled={busy || dirty.length === 0}>
          {busy ? '保存中…' : (dirtyView.length > 0 ? `保存 ${dirtyView.length} 项改动` : '没有改动')}
        </button>
        <button className="dvev-btn" onClick={onReset} disabled={busy}>恢复默认</button>
        <span className="dvev-spacer" />
        {/* title 里保留真实配置路径：排查"到底改了哪几个 key"时不用猜 */}
        <span className="dvev-muted" title={dirty.length > 0 ? `实际写入的配置项：${dirty.join('、')}` : undefined}>
          {dirtyView.length > 0 ? `未保存：${dirtyView.slice(0, 3).join('、')}${dirtyView.length > 3 ? ` 等 ${dirtyView.length} 项` : ''}` : '已与磁盘一致'}
        </span>
      </div>
    </div>
  )
}

/**
 * 「复盘用哪个模型」选择器。
 *
 * 为什么需要它：`review.provider` / `review.model` 原本是两个空输入框，用户
 * **不知道该填什么**，而填错得到的是一句 `NO_ADAPTER`（对用户毫无帮助）。
 * 这里把宿主真实注册的 provider × model 摊开让他**选**，并同时回答
 * "留空时会用哪个、来源是哪"。
 *
 * **只有一个下拉，不做手填**：能填的入口就会有人填错，而"哪些模型真的可用"
 * 只有宿主知道。代价是适配器接受了但没列出来的模型 id 在面板上选不到 ——
 * 已经写在配置里的旧值仍然会被显示出来并原样保留，不会被静默改掉。
 *
 * 值直接写进那两个配置项 —— 不做第二套存储。保存仍按真实路径逐项写；
 * 底部「未保存 N 项」会把这对路径折叠成一条「复盘用哪个模型」，
 * 因为对用户来说那是**一次**选择（见 App 里的 dirtyView）。
 */
function ReviewModelPicker({ draft, catalog, error, busy, onReload, onSet }) {
  /** 选项值里的分隔符：provider 与 model id 都不含 NUL，所以不会歧义。 */
  const SEP = '\u0000'
  const provider = String(draft?.review?.provider ?? '')
  const model = String(draft?.review?.model ?? '')

  const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
  const options = []
  for (const p of providers) {
    for (const m of (Array.isArray(p.models) ? p.models : [])) {
      options.push({
        value: `${p.id}${SEP}${m.id}`,
        label: `${p.name || p.id} · ${m.name || m.id}`,
        provider: p.id,
        model: m.id,
      })
    }
  }

  const current = provider !== '' && model !== '' ? `${provider}${SEP}${model}` : ''
  const inList = current !== '' && options.some((o) => o.value === current)
  /** 配置里只有一半（手改过 config.json）：下拉里显示不出来，必须单独说清楚。 */
  const partial = (provider === '') !== (model === '')

  const resolved = catalog?.resolved
  const resolvedText = catalog === null
    ? (error !== '' ? '（模型列表读取失败）' : '正在读取宿主模型列表…')
    : resolved?.model
      ? `${resolved.provider ? `${resolved.provider} / ` : ''}${resolved.model}`
      : '（还没解析出模型）'
  const sourceText = catalog === null ? ''
    : resolved?.source === 'config' ? '配置里指定的'
      : resolved?.source === 'none' ? '未配置，不会复盘' : ''

  const failed = Array.isArray(catalog?.failed) ? catalog.failed : []
  const llmAvailable = catalog?.llmAvailable === true

  return (
    <div style={{ borderBottom: '1px dashed rgba(255,255,255,.14)', marginBottom: 2 }}>
      <div className="dvev-field">
        <div className="dvev-flabel">
          <div className="dvev-fname">
            复盘用哪个模型
            {catalog?.cached ? <span className="dvev-tag" style={{ marginLeft: 6 }}>列表为 60s 内的缓存</span> : null}
          </div>
          <div className="dvev-fhint">
            从宿主里<b>已经可用</b>的模型里选一个。复盘是后台行为，<b>花钱要显式</b>：
            留空表示<b>完全不复盘</b>，插件不会替你猜、也不会默认用当前会话的模型。
          </div>
          <div className="dvev-fhint">
            本次会用：<span className="dvev-mono">{resolvedText}</span>
            {sourceText ? <span className="dvev-muted">（{sourceText}）</span> : null}
          </div>
        </div>
        <div className="dvev-fctl">
          <select
            value={current}
            onChange={(e) => {
              const v = e.target.value
              if (v === '') { onSet('review.provider', ''); onSet('review.model', ''); return }
              const hit = options.find((o) => o.value === v)
              if (hit !== undefined) { onSet('review.provider', hit.provider); onSet('review.model', hit.model) }
            }}
          >
            <option value="">不配置（完全不复盘）</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            {/* 配置里已有的值不在宿主目录里时也要显示出来，否则界面会"看起来没配" */}
            {current !== '' && !inList ? <option value={current}>{`${provider} / ${model}（当前配置里的值）`}</option> : null}
          </select>
          <button className="dvev-btn" onClick={onReload} disabled={busy} title="重新向宿主要一次模型列表">
            {busy ? '…' : '刷新'}
          </button>
        </div>
      </div>

      {partial ? (
        <div className="dvev-fhint dvev-warn">
          配置里的复盘模型不完整（提供方 = {provider || '空'}，模型 = {model || '空'}）。
          从上面的下拉里选一个即可覆盖它。
        </div>
      ) : null}
      {error !== '' ? <div className="dvev-fhint dvev-err">模型列表读取失败：{error}</div> : null}
      {catalog !== null && llmAvailable !== true ? (
        <div className="dvev-fhint dvev-err">
          宿主没有提供模型服务（ctx.llm）：先在 DSH 的设置里配置一个模型提供方，再重载插件。
        </div>
      ) : null}
      {catalog !== null && llmAvailable && options.length === 0 ? (
        <div className="dvev-fhint dvev-warn">
          宿主没有报告任何可选模型。先在 DSH 的设置里配置一个模型提供方，再点「刷新」重读一次。
        </div>
      ) : null}
      {failed.length > 0 ? (
        <div className="dvev-fhint dvev-warn">
          这些提供方的模型列表没取到：
          {failed.map((f) => `${f.id}（${f.error}）`).join('、')}
          —— 它们的模型暂时选不到，可以点「刷新」再试一次。
        </div>
      ) : null}
    </div>
  )
}

function Field({ field, value, touched, onChange }) {
  const id = `dvev-f-${field.path.replace(/\./g, '-')}`
  let control = null

  if (field.kind === 'boolean') {
    control = (
      <label className="dvev-switch" title={String(value === true)}>
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span className="dvev-slider" />
      </label>
    )
  } else if (field.kind === 'number') {
    control = (
      <input
        id={id} type="number" value={value ?? 0}
        min={field.min} max={field.max}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      />
    )
  } else if (field.kind === 'select') {
    control = (
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  } else if (field.kind === 'stringList') {
    control = (
      <textarea
        id={id}
        value={Array.isArray(value) ? value.join('\n') : ''}
        placeholder="每行一个"
        onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter((s) => s !== ''))}
      />
    )
  } else {
    control = (
      <input
        id={id} type="text" value={value ?? ''}
        placeholder={field.placeholder ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  /**
   * 「预留」字段：配置结构存在、但功能还没实现（比如接口对接与数据库对接 ——
   * 本插件不提供也不托管服务端）。
   *
   * 为什么还要显示而不是藏起来：这些是**契约**，用户需要知道"将来接团队服务时
   * 配置长什么样"。但必须**明确标注未实现**，否则他把开关打开、地址填好、
   * 发现什么都没发生，只会以为是自己配错了。
   */
  const isReserved = typeof field.reserved === 'string' && field.reserved !== ''

  return (
    <div className="dvev-field" style={isReserved ? { opacity: .72 } : undefined}>
      <div className="dvev-flabel">
        <div className="dvev-fname">
          {field.label}
          {isReserved ? <span className="dvev-tag dvev-miss" style={{ marginLeft: 6 }}>预留 · 尚未实现</span> : null}
          {touched ? <span className="dvev-warn"> ●</span> : null}
        </div>
        {field.hint ? <div className="dvev-fhint">{field.hint}</div> : null}
        {isReserved ? <div className="dvev-fhint dvev-warn">{field.reserved}</div> : null}
        <div className="dvev-fhint dvev-mono" style={{ opacity: .6 }}>{field.path}</div>
      </div>
      <div className="dvev-fctl">{control}</div>
    </div>
  )
}

// ================= 数据与隐私 =================
function PrivacyTab({ hello, config, runtime }) {
  const [diag, setDiag] = useState(null)
  const [error, setError] = useState('')

  const runDiag = useCallback(async () => {
    setError('')
    try {
      setDiag(await rpc('diagnose'))
    } catch (e) {
      setError(`自检失败：${e.message}`)
    }
  }, [])

  useEffect(() => { void runDiag() }, [runDiag])

  const p = config?.privacy ?? {}
  const api = config?.api ?? {}
  const db = config?.database ?? {}

  return (
    <div>
      <div className="dvev-h">数据隐私</div>

      <div className="dvev-h2">版本</div>
      <table className="dvev-table">
        <tbody>
          <Tr k="插件版本" v={`v${CLIENT_VERSION}`} />
          <Tr
            k="宿主服务版本"
            v={`v${hello?.version ?? '—'}`}
            cls={hello && hello.version !== CLIENT_VERSION ? 'dvev-warn' : 'dvev-ok'}
          />
          {hello && hello.version !== CLIENT_VERSION
            ? <Tr k="提示" v="面板与宿主服务版本不一致：通常是升级后宿主未重启，或浏览器缓存了旧面板。请重启宿主后刷新页面。" cls="dvev-warn" />
            : null}
        </tbody>
      </table>

      <div className="dvev-h2">这个插件会做什么</div>
      <table className="dvev-table">
        <tbody>
          <Tr k="记录开发会话" v="是（只在本机）" cls="dvev-ok" />
          <Tr k="记录工具参数与输出" v="否（只记工具名与成功/失败）" cls="dvev-ok" />
          <Tr k="上传到任何服务器" v={api.enabled && api.uploadMode !== 'off' ? `是 → ${api.baseUrl || '（未填地址）'}` : '否'} cls={api.enabled && api.uploadMode !== 'off' ? 'dvev-warn' : 'dvev-ok'} />
          {/* 向量检索没有实现，所以这里如实写"没有这条路径"，而不是读一个不生效的配置 */}
          <Tr k="把正文发往 embedding 端点" v="否（向量检索尚未实现）" cls="dvev-ok" />
          <Tr k="写入你的代码仓库" v={config?.skills?.target === 'plugin-local' ? '否' : `会写入 ${config?.skills?.target}`} cls={config?.skills?.target === 'plugin-local' ? 'dvev-ok' : 'dvev-warn'} />
          <Tr
            k="连接数据库"
            v={!db.enabled
              ? '否（本地文件）'
              : db.driver === 'sqlite'
                ? '是——本机 SQLite，数据写入数据目录的 index.sqlite（单文件、不出本机，不是外部服务器）'
                : '已选 postgres（契约预留、尚未实现；实际仍使用本地文件）'}
            cls={!db.enabled || db.driver === 'sqlite' ? 'dvev-ok' : ''}
          />
          {/* 下面两行是 Phase 1 新增能力，必须写清楚"动没动你的仓库" */}
          <Tr
            k="导出洞察"
            v="是（写到插件数据目录的 exports/，不联网、不碰仓库）"
            cls="dvev-ok"
          />
          <Tr
            k="生成并写入 skill 草稿"
            v={config?.skills?.target === 'plugin-local'
              ? '仅写到插件数据目录（当前落点）'
              : `会写到 ${config?.skills?.target}${config?.skills?.confirmBeforeRepoWrite !== false ? '（写入前需你确认）' : '（当前已关闭确认！）'}`}
            cls={config?.skills?.target === 'plugin-local' ? 'dvev-ok' : 'dvev-warn'}
          />
        </tbody>
      </table>

      <div className="dvev-h2">脱敏当前状态</div>
      <table className="dvev-table">
        <tbody>
          <Tr k="总开关" v={p.redact ? '开' : '关'} cls={p.redact ? 'dvev-ok' : 'dvev-warn'} />
          <Tr k="移除绝对路径" v={p.stripAbsolutePaths ? '是' : '否'} />
          <Tr k="移除疑似密钥" v={p.stripSecrets ? '是' : '否'} />
          <Tr k="自定义敏感词" v={(p.customWords ?? []).length === 0 ? '无' : `${p.customWords.length} 个`} />
        </tbody>
      </table>
      <div className="dvev-muted" style={{ marginTop: 6 }}>
        内置密钥规则：{(hello?.redactRules ?? []).join('、') || '—'}
      </div>

      <div className="dvev-h2">目录自检</div>
      <div className="dvev-row">
        <button className="dvev-btn" onClick={runDiag}>重新自检</button>
        {diag ? <span className="dvev-muted">今天：{diag.today}</span> : null}
      </div>
      {error ? <div className="dvev-banner dvev-err">{error}</div> : null}
      {diag ? (
        <table className="dvev-table">
          <thead><tr><th>路径</th><th style={{ width: 90 }}>存在</th></tr></thead>
          <tbody>
            {(diag.checks ?? []).map((c) => (
              <tr key={c.path}>
                <td className="dvev-mono">{c.path}</td>
                <td className={c.exists ? 'dvev-ok' : 'dvev-warn'}>{c.exists ? '是' : '否（首次写入时创建）'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div className="dvev-h2">你的权利</div>
      <div className="dvev-muted" style={{ whiteSpace: 'pre-wrap' }}>
{`· 数据全部在本机，路径见上。你可以直接用文件管理器打开、复制、删除。
· 存储后端是"本地文件"时：账本与洞察库都是 .ndjson 纯文本，一行一条，用记事本就能看。
  洞察库的 index.json 只是派生快照，删掉会自动从 .ndjson 重建。
· 存储后端是 SQLite 时：数据在数据目录的 index.sqlite 单文件里（洞察操作日志
  insight_ops 表仍是只追加的，审计性不变）；删掉它再重启 = 回退到本地文件。
· 「现在复盘」是唯一会花钱的操作，用你自己已配好的模型；其余功能全部不联网。
· 想完全停掉：把「总开关」关掉，插件将不再采集、不再注入、不再复盘。
· 想只停复盘：把「自动复盘」关掉即可（默认就是关的），手动按钮仍然可用。
· 想迁移：把整个数据目录复制到新机器，用 DSH_EVOLUTION_HOME 环境变量指过去即可
  （SQLite 模式下 index.sqlite 也在数据目录里，一起复制；误清空可用「导出/导入」恢复）。
· 卸载插件不会删除数据；如需清理请手动删除数据目录。`}
      </div>

      <div className="dvev-h2">插件承诺</div>
      <div className="dvev-muted" style={{ whiteSpace: 'pre-wrap' }}>
{`1. 不提供、也不托管任何云端服务。作者不会接触你的任何数据。
2. 默认不上传、不外发。所有外向行为都需要你显式配置。
3. 不做任何面向管理者展示个人画像的功能 —— 这是效率工具，不是监控工具。`}
      </div>

      {runtime?.apiEnabled ? (
        <div className="dvev-banner dvev-warn" style={{ marginTop: 10 }}>
          你已启用接口对接，模式为 {runtime.apiUploadMode}。请确认目标地址可信。
        </div>
      ) : null}
    </div>
  )
}

// ---------- 注册 ----------
export function apply(ctx) {
  ensureCss(ctx)

  const slots = ctx.get('slots')
  if (!slots || typeof slots.register !== 'function') {
    // 没有 slots 服务（比如 CLI 宿主）：静默跳过 UI，不影响 host 半的采集能力
    return
  }

  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'dsh-evolution', order: 20, label: '自动进化' },
    (props) => <SidebarButton wide={props?.wide !== false} ctx={ctx} />,
  ))

  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'dsh-evolution-panel', order: 100, label: '自动进化面板' },
    () => <Overlay />,
  ))
}

export const inject = ['slots']
