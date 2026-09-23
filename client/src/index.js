/**
 * 浏览器半边入口：把「重启」和「检查版本」注册成会话头部 utilities 的一个 slot 贡献。
 *
 * 为什么值得做成这样，而不是继续往 index.html 里注入 DOM：
 *   conversation.session.header.utilities 是 dsh 的公开扩展点（open-in-app 的分裂按钮
 *   就注册在同一个槽里，第三方插件也这么干），由 React 渲染、跟着顶栏一起布局。
 *   于是「避开 dsh 顶栏控件」这件事不再需要，右上角那套坐标探测 + MutationObserver
 *   补偿（avoidAppButtons）本来就是为了绕开「悬浮按钮会盖住顶栏」才存在的。
 *
 * 宿主侧不需要任何新路由：/pwa-launcher/restart 与 /pwa-launcher/update-check 是
 * 原有悬浮按钮就在用的接口，这里直接复用。
 */

/**
 * 控件之外还需要的两个服务：
 *   slots  —— 把贡献挂上 utilities 槽
 *   locale —— 注册 pwa-launcher 词典，并把 t() 注进组件
 * 另外用 ctx.effect 管生命周期，和 open-in-app 的写法保持一致。
 */
export const inject = ['slots', 'locale']

/**
 * 注入 index.html 的样式。
 *
 * 数值与 open-in-app 的分裂按钮逐项对齐（28px 高、14px 圆角、11px 字号、
 * --dsw-alias-border-l4 边框），这样两个控件并排时是同一视觉重量。
 * 颜色一律走 dsh 的设计变量，不写死色值 —— 深色/浅色主题都跟着走。
 */
const CSS = [
  '.dsh-launcher-cluster{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);height:28px;',
  'font-family:var(--dsw-font-family);border-radius:14px;align-items:stretch;display:inline-flex;overflow:hidden}',
  '.dsh-launcher-btn{color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;background:0 0;border:0;',
  'align-items:center;gap:5px;font-size:11px;font-weight:400;line-height:16px;display:inline-flex;padding:5px 8px}',
  '.dsh-launcher-btn:hover:not(:disabled),.dsh-launcher-btn:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-launcher-btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:wait}',
  '.dsh-launcher-btn[data-state=error]{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-launcher-btn[data-accent=true]{color:#2563eb;font-weight:500}',
  '.dsh-launcher-sep{border-left:.5px solid var(--dsw-alias-border-l4);align-self:stretch;width:0}',
  '.dsh-launcher-glyph{font-size:12px;line-height:1}',
  // —— 重启/升级的进度卡 ——
  // 遮罩：重启期间页面做不了任何事，把它盖住比让用户对着一个没反应的界面强。
  '.dsh-launcher-card{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;',
  'background:rgba(0,0,0,.35)}',
  '.dsh-launcher-cardbox{display:flex;align-items:center;gap:16px;max-width:min(460px,86vw);padding:22px 28px;',
  'border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);',
  'color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:14px;line-height:1.6;',
  'box-shadow:0 10px 40px rgba(0,0,0,.28)}',
  '.dsh-launcher-cardcol{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dsh-launcher-cardtitle{font-size:15px;font-weight:700}',
  '.dsh-launcher-cardmsg{opacity:.88}',
  '.dsh-launcher-cardbtn{align-self:flex-start;margin-top:8px;font-size:12px;padding:4px 12px;border-radius:8px;',
  'border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;cursor:pointer}',
  '.dsh-launcher-cardbtn:hover{border-color:var(--dsw-alias-label-secondary)}',
  '.dsh-launcher-cardbtn-primary{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:500}',
  '.dsh-launcher-cardbtn-primary:hover{filter:brightness(1.08);border-color:#2563eb}',
  '.dsh-launcher-cardnote{font-size:12px;opacity:.72;margin-top:6px}',
  '.dsh-launcher-cardrow{display:flex;gap:8px;align-items:center;margin-top:10px}',
  // —— 选版卡 ——
  '.dsh-launcher-cardbox-wide{flex-direction:column;align-items:stretch;min-width:min(420px,86vw)}',
  '.dsh-launcher-picks{display:flex;flex-direction:column;gap:6px;margin-top:10px}',
  '.dsh-launcher-pick{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;text-align:left;',
  'padding:9px 12px;border-radius:10px;cursor:pointer;font:inherit;color:inherit;background:transparent;',
  'border:1px solid var(--dsw-alias-border-l2)}',
  '.dsh-launcher-pick:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-launcher-pick[data-selected=true]{border-color:#2563eb;box-shadow:inset 0 0 0 1px #2563eb}',
  '.dsh-launcher-pickradio{flex:none;width:14px;height:14px;border-radius:50%;',
  'border:1.5px solid var(--dsw-alias-border-l2)}',
  '.dsh-launcher-pick[data-selected=true] .dsh-launcher-pickradio{border-color:#2563eb;border-width:4px}',
  '.dsh-launcher-pickversion{font-weight:600;font-variant-numeric:tabular-nums}',
  '.dsh-launcher-pickmeta{margin-left:auto;font-size:12px;opacity:.7;white-space:nowrap}',
  '@keyframes dsh-launcher-spin{to{transform:rotate(360deg)}}',
  '.dsh-launcher-spin{flex:none;width:20px;height:20px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);',
  'border-top-color:var(--dsw-alias-label-primary);animation:dsh-launcher-spin .8s linear infinite}',
  '@media (prefers-reduced-motion:reduce){.dsh-launcher-spin{animation-duration:2.4s}}'
].join('')

/** 样式标签 id：HMR 重载时靠它去重，不重复插入。 */
const STYLE_ID = 'dsh-launcher-controls-style'

/** 挂一次样式。 */
function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-pwa-launcher'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/**
 * 客户端插件体。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx) {
  ensureStyle()
  const controller = new LauncherController()
  // 页面一加载就把宿主的更新检查结果取回来；组件挂载前拿到，按钮就不会先闪一下「检查…」。
  controller.loadUpdate()

  // 控制器挂在 effect 里而不是模块作用域：apply 每次都给一份全新的，插件被
  // dispose 时（含 HMR 重载）旧的那份一定停掉轮询，不会留一个还在跑的僵尸。
  ctx.effect(() => () => controller.dispose(), 'pwa-launcher: controller')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pwa-launcher: dictionaries')

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'pwa-launcher',
    // 排在 open-in-app（order -10）后面，于是这一簇是「打开方式 · 重启 · 版本」，
    // 打头的是 dsh 自己的控件，我们跟在它右边。
    order: 10,
    // 声明命名空间后，框架会把 t 注进组件的 props（不自己 bind/拼 t ——
    // dsh 的 locale 服务没有 ctx.locale.t 这个入口）。
    locale: NS,
    inject: () => ({ controller })
  }, LauncherControls))
}
