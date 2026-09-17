/**
 * dsh-desktop-launcher —— 让 DeepSeek Harness 双击桌面图标就能用。
 *
 * 它自己不做重活，只做四件事：
 *
 *   1. 把 assets\ 里的启动器脚本复制到 %LOCALAPPDATA%\DeepSeekHarness\
 *      （放这里是为了让快捷方式的目标路径稳定 —— 插件包本身在 profile 里，
 *        换 npm / pnpm 布局就不一样了）
 *   2. 写一份 launcher.json，把「当前这个 dsh 是怎么跑起来的」记下来：
 *      node 路径、dsh 入口、监听端口、启动目录、原始参数。
 *      —— 这样启动器不需要猜，也不需要依赖 PATH 或 npx。
 *   3. 调 scripts\shortcut.ps1 把桌面/开始菜单的图标接到启动器上。
 *   4. 通过 webServer 的 tapIndex/register 扩展点，往网页里注入一个右上角的
 *      「真正重启」按钮：一键把整个 harness 连根重启（含停掉卡住的任务/会话），
 *      重启完成后当前窗口自动重连刷新。详见下面「网页内『真正重启』按钮」一节。
 *
 * 之后用户双击那个图标时走的是 launch.ps1，和这个进程无关。
 *
 * 设计上的三个刻意选择：
 *
 *   - 不 import 任何 @deepseek-ai/* 包。插件装在 profile 里，那些包的解析路径
 *     在不同安装方式下并不一致，用纯 node 内建模块最稳。
 *   - 不阻塞 dsh 启动。整个安装过程扔到下一个 tick，失败只记日志。
 *   - 重启走「外部进程」而非进程内 self-restart。插件就跑在被重启的那个 dsh 进程里，
 *     让它自己杀自己再原地复活不干净也做不到，所以按钮只去 spawn 一个游离于 node
 *     进程树之外的 wscript→launch.ps1，由它完成 stop→start。
 *
 * @module dsh-desktop-launcher
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { checkForUpdate, listNewer, readInstalledVersion, resolveAppVersion } from './version.js'

/** Cordis 插件名。 */
export const name = 'desktop-launcher'

/**
 * 本次进程的随机指纹。每次 dsh 进程启动时随机生成一份，永远不重复。
 *
 * 注入到网页里的重启按钮会记住「我这一页来自哪个 nonce」，重启后轮询状态接口，
 * 一旦读到不同的 nonce 就说明服务已经换成了新进程，可以安全重连。
 */
const NONCE = randomUUID()

/**
 * 只在 Web 服务真的绑上端口、并且传输层（connection）起来之后才 apply。
 * 没有 webServer 的 profile（TUI、headless）装了本插件也不会有任何动作。
 *
 * 要 connection 是为了拿 `authenticatedUrl()` —— 见下面 {@link authenticatedUrl}。
 */
export const inject = ['webServer', 'connection']

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = resolve(HERE, '..', 'assets')

const DEFAULTS = {
  shortcutName: 'DeepSeek Harness',
  adoptBrowserShortcut: true,
  desktop: true,
  startMenu: true,
  browser: 'auto',
  appMode: true,
  startTimeoutSec: 120,
  installDir: '',
  // —— 更新检查（第一期：只查不改）——
  checkForUpdates: true, // false = 完全不查、不注入更新徽标
  allowSelfUpdate: true, // 第二期：允许徽标「更新到此版本」触发外部升级脚本（false 则只提醒）
  updatePackage: '@deepseek-ai/dsh', // 拿哪个包的 dist-tags 当作「可升版本」来源（CLI 包，tag 干净）
  updateVersionPackage: '@deepseek-ai/dsh-base', // 拿哪个包的安装版本当作「当前版本」（真正跑的应用核心）
  updateChannels: ['latest', 'next', 'alpha'], // 关注哪些通道，顺序=保守→激进，第一个是「推荐」
  updateNotify: 'all', // all = 任一通道有更新都提醒；recommended-only = 只提醒主通道
  updateRegistry: 'https://registry.npmjs.org', // 镜像/私有源可改
  updateCheckTimeoutMs: 12000
}

/**
 * 最近一次更新检查的结果。进程内单份，供网页路由 GET /desktop-launcher/update-check
 * 直接读取，避免每次刷新页面都去请求 registry。
 */
const updateState = { status: 'idle' } // idle → checking → done / error

/**
 * 用户点「忽略」的具体版本集合，跨重启保留在 update-dismiss.json 里。
 * 徽标只提醒「比当前新、且未被忽略」的版本，避免对同一个版本反复催。
 */
const dismissedVersions = new Set()
let dismissFile = null // 由 runUpdateCheck 按当前 installDir 设定

/** 最近一次后台检查的入参，供「重新检查」按钮按需再跑一次 runUpdateCheck。 */
let lastCheckArgs = null

/** 把 updateState 序列化成对外 JSON（GET/POST update-check 共用）。 */
function serializeUpdateState() {
  const s = updateState
  return {
    status: s.status || 'idle',
    ok: Boolean(s.ok),
    available: Boolean(s.available),
    current: s.current ?? null,
    appVersion: s.appVersion ?? null,
    cliVersion: s.cliVersion ?? null,
    channel: s.channel ?? null,
    target: s.target ?? null,
    newer: Array.isArray(s.newer) ? s.newer : [],
    distTags: s.distTags ?? {},
    error: s.error ?? null,
    checkedAt: s.checkedAt ?? null
  }
}

function log(message) {
  console.log(`[desktop] ${message}`)
}

function defaultInstallDir() {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, 'DeepSeekHarness')
}

/**
 * 递归复制资产目录。文件都很小（几 KB），每次启动覆盖一遍比做增量判断更省心，
 * 也顺带保证了「插件升级后启动器脚本跟着升级」。
 */
async function copyAssets(from, to) {
  if (!existsSync(from)) throw new Error(`插件资产目录不存在：${from}`)
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) await copyAssets(src, dst)
    else await copyFile(src, dst)
  }
}

/**
 * 去掉环境变量里「仅大小写不同」的重复键。
 *
 * Windows 上 Node 的 process.env 可能同时带 http_proxy 和 HTTP_PROXY，
 * 子进程继承时 PowerShell 会直接抛 ArgumentException 而不是忽略。
 */
function dedupedEnv() {
  const out = {}
  const seen = new Set()
  for (const [key, value] of Object.entries(process.env)) {
    const lower = key.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out[key] = value
  }
  return out
}

function runPowerShell(scriptPath, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { windowsHide: true, env: dedupedEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let output = ''
    child.stdout?.on('data', (chunk) => { output += chunk })
    child.stderr?.on('data', (chunk) => { output += chunk })
    child.once('error', (error) => resolvePromise({ code: -1, output: String(error) }))
    child.once('close', (code) => resolvePromise({ code, output }))
  })
}

/**
 * 还原「当前 dsh 是怎么被拉起来的」。
 *
 * web 子命令下 process.argv 形如
 *   [node, .../dsh/lib/bin.js, web, --no-open, --port, 3080]
 * 端口和 --no-open 由启动器自己接管，其余参数原样保留 —— 用户如果带了
 * --trusted-host 之类的东西，冷启动之后应该还在。
 */
function describeLaunch(port) {
  const raw = process.argv.slice(2)
  const kept = []
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i]
    if (arg === '--no-open') continue
    if (arg === '--port') { i += 1; continue }
    if (arg.startsWith('--port=')) continue
    kept.push(arg)
  }
  if (kept.length === 0) kept.push('web')
  return {
    nodePath: process.execPath,
    dshEntry: process.argv[1] ? resolve(process.argv[1]) : '',
    dshArgs: kept,
    port,
    workspace: process.cwd()
  }
}

/**
 * 取本次进程的「带令牌地址」。
 *
 * dsh 每次启动生成一个新的 launch token，未认证的 `GET /` 返回 401。
 * 带 token 访问一次会 303 跳到干净的 `/` 并种下 30 天有效的签名 cookie。
 *
 * 这个地址就是启动器应该开的那个。把它写进 launcher.json 之后，
 * 启动器就不必再去 `dsh-stdout.log` 里正则抠 token —— 那条路有个真实的坑：
 * 如果 dsh 是用户自己手动起的（不是被图标拉起的），日志里留的是上一轮的
 * token，拿它去开窗只会得到一个 401 空白页。
 *
 * 由本插件在进程内直接问 connection 服务要，永远和当前进程一致。
 * 拿不到就返回空串，启动器会退回读日志。
 */
function authenticatedUrl(ctx, port) {
  try {
    const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`)
    if (typeof url === 'string' && url.includes('token=')) return url
    log('connection 没有返回带令牌的地址，启动器将退回读日志')
  } catch (error) {
    log(`取认证地址失败，启动器将退回读日志：${error?.message ?? error}`)
  }
  return ''
}

// -------------------------------------------------------------- 网页内「真正重启」按钮
//
// 桌面图标只会「开一个窗口」，右上角那个关闭按钮又只是关窗口；想把卡住的任务连根
// 重启一次 harness，以前只能回去双击图标（而且还开着的那版代码不会热更）。这里用
// webServer 的两个官方扩展点补上，不碰 dsh 核心、也不依赖 SPA 内部 DOM 结构：
//
//   tapIndex(html)   往真正服务出去的 index.html 末尾塞一小段自包含脚本，画出右上角的
//                    「重启」按钮 + 遮罩。只在已鉴权时才会被服务（authorizeIndex 在前）。
//   register(route)  挂两个自定义路由（自定义路由在 authorizeIndex 之前命中，自掌响应）：
//                      POST /desktop-launcher/restart        触发一次外部重启
//                      GET  /desktop-launcher/restart-status 前端轮询：新进程起来没有
//
// 为什么是「外部重启」而非进程内 self-restart：插件就跑在被重启的那个 dsh 进程里，让它
// 自己杀自己再原地复活不干净也做不到（这正是自更新要外部脚本的原因）。所以按钮只去 spawn
// 一个游离于 node 进程树之外的 wscript→launch.ps1，由它 stop→start（见 assets/restart.vbs）。

/** 生成注入到 index.html 的自包含脚本（右上角按钮 + 启动风格的提示卡 + 轮询重连）。 */
function restartClientScript() {
  return `<script>(function(){
  if (window.__DSH_DL_RESTART__) return;
  window.__DSH_DL_RESTART__ = true;
  var NONCE = ${JSON.stringify(NONCE)};
  window.__DSH_DL_NONCE__ = NONCE;
  var STARTING = "正在启动，请稍候…（不必重复点击图标）";
  var RESTARTING = "正在重启，请稍候…";
  function $(s){ return document.querySelector(s); }
  function mk(tag){ return document.createElement(tag); }
  function lum(bg){ var m=/rgba?\\(([^)]+)\\)/i.exec(bg); if(!m) return null; var p=m[1].split(','); var a=(p.length>3?parseFloat(p[3]):1); if(a<0.05) return null; return (0.2126*p[0]+0.7152*p[1]+0.0722*p[2])/255; }
  function isDark(){ var c=[document.body, document.documentElement, $("#root")]; for(var i=0;i<c.length;i++){ if(!c[i]) continue; var L=lum(getComputedStyle(c[i]).backgroundColor); if(L!=null) return L<0.5; } try{ return matchMedia("(prefers-color-scheme: dark)").matches; }catch(e){ return false; } }
  function ensureStyle(){ if($("#dsh-dl-style")) return; var st=mk("style"); st.id="dsh-dl-style";
    st.textContent =
      "@keyframes dsh-dl-spin{to{transform:rotate(360deg)}}" +
      "#dsh-dl-card{position:fixed;inset:0;z-index:2147483001;display:none;align-items:center;justify-content:center;}" +
      "#dsh-dl-card .box{display:flex;align-items:center;gap:16px;padding:22px 30px;border-radius:12px;border:1px solid;max-width:min(460px,86vw);box-shadow:0 10px 40px rgba(0,0,0,.28);font:14px/1.5 system-ui, 'Segoe UI', 'Microsoft YaHei UI', sans-serif;}" +
      "#dsh-dl-card img{width:40px;height:40px;flex:none;}" +
      "#dsh-dl-card .col{display:flex;flex-direction:column;gap:3px;}" +
      "#dsh-dl-card .t{font-size:15px;font-weight:700;}" +
      "#dsh-dl-card .s{display:flex;align-items:center;gap:8px;font-size:13px;opacity:.9;}" +
      "#dsh-dl-card .spin{width:13px;height:13px;border-radius:50%;border:2px solid rgba(128,128,128,.4);border-top-color:currentColor;animation:dsh-dl-spin .8s linear infinite;flex:none;}" +
      "#dsh-dl-restart{position:fixed;top:10px;right:10px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:16px;font:13px/1 system-ui, 'Segoe UI', 'Microsoft YaHei UI', sans-serif;cursor:pointer;border:1px solid;user-select:none;opacity:.86;transition:opacity .15s;}" +
      "#dsh-dl-restart:hover{opacity:1}";
    document.head.appendChild(st);
  }
  function paint(btn){ var d=isDark();
    btn.style.background = d ? "rgba(28,30,34,.72)" : "rgba(255,255,255,.86)";
    btn.style.color = d ? "#f3f4f6" : "#1f2328";
    btn.style.borderColor = d ? "rgba(255,255,255,.20)" : "rgba(0,0,0,.16)";
  }
  function ensureBtn(){ if($("#dsh-dl-restart")) return;
    var b=mk("button"); b.id="dsh-dl-restart"; b.type="button";
    b.title="重启整个 DeepSeek Harness：停止当前进程（含正在运行的任务/会话）并重新拉起，本页面会自动重连";
    b.innerHTML="<span style='font-size:15px;line-height:1'>\\u21bb</span><span>\\u91cd\\u542f</span>";
    try{ b.style.backdropFilter="blur(8px)"; b.style.webkitBackdropFilter="blur(8px)"; }catch(e){}
    document.body.appendChild(b);
    paint(b);
    b.addEventListener("click", onClick);
    setInterval(function(){ var x=$("#dsh-dl-restart"); if(x) paint(x); }, 1500);
  }
  function ensureCard(){ var c=$("#dsh-dl-card"); if(c) return c;
    c=mk("div"); c.id="dsh-dl-card";
    var box=mk("div"); box.className="box";
    var img=mk("img"); img.src="/favicon.svg"; img.alt=""; img.onerror=function(){ img.style.display="none"; };
    var col=mk("div"); col.className="col";
    var t=mk("div"); t.className="t"; t.textContent="DeepSeek Harness";
    var s=mk("div"); s.className="s";
    var sp=mk("span"); sp.className="spin";
    var m=mk("span"); m.className="m";
    s.appendChild(sp); s.appendChild(m);
    col.appendChild(t); col.appendChild(s);
    box.appendChild(img); box.appendChild(col);
    c.appendChild(box); document.body.appendChild(c);
    return c;
  }
  // 显示/更新启动风格的提示卡。hideSpin=true 用于错误/超时（停掉转圈，只留文字）。
  function showCard(text, hideSpin){ var c=ensureCard(); var d=isDark(); var box=c.querySelector(".box");
    box.style.background = d ? "#1c1e22" : "#ffffff";
    box.style.color = d ? "#f3f4f6" : "#1f2328";
    box.style.borderColor = d ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.10)";
    c.querySelector(".spin").style.display = hideSpin ? "none" : "";
    c.querySelector(".m").textContent = text;
    c.style.display = "flex";
  }
  async function onClick(){
    var ok = window.confirm("重启整个 DeepSeek Harness？\\n\\n这会彻底停止当前进程（包括正在运行的任务/会话），然后自动重新拉起并刷新本页。");
    if(!ok) return;
    showCard(RESTARTING, false);
    var res;
    try{ res = await fetch("/desktop-launcher/restart", { method:"POST", credentials:"same-origin" }); }
    catch(e){ showCard("无法联系本地服务：" + e.message + "。请双击桌面图标重启。", true); return; }
    if(res.status===401){ showCard("登录状态已失效。请关闭本窗口，用桌面图标重新打开一次 Harness。", true); return; }
    if(!res.ok){ var t=""; try{ t=(await res.json()).error||""; }catch(e){} showCard("重启请求失败（" + res.status + "）" + (t?"：" + t:"") + "。也可以双击桌面图标重启。", true); return; }
    waitReady();
  }
  function waitReady(){ var start=Date.now(), TIMEOUT=180000;
    function tick(){ fetch("/desktop-launcher/restart-status", { credentials:"same-origin", headers:{ "accept":"application/json" } })
      .then(function(r){ return r.json(); })
      .then(function(s){
        // 新进程（nonce 变了）就绪 → 重连刷新
        if(s && s.nonce && s.nonce!==NONCE && s.phase==="ready"){ showCard("重启完成，正在重连…", false); location.replace((s.authUrl&&s.authUrl.length)?s.authUrl:(location.origin+"/")); return; }
        // 老进程还活着、只是收到命令在收尾 → 保持「正在重启」
        if(s && s.phase==="restarting"){ showCard(RESTARTING, false); }
        // 其它（老进程已应答 ready 但还没换新，或本机非回环拿不到 authUrl）→ 已进入真正重启，回到原来的启动文案
        else { showCard(STARTING, false); }
        loop();
      })
      // 连不上服务 = 老进程已停、新进程正在起 → 显示原来的启动文案
      .catch(function(){ showCard(STARTING, false); loop(); }); }
    function loop(){ if(Date.now()-start>TIMEOUT){ showCard("重启超时：新服务没能在预期时间内就绪。请双击桌面图标重启，或查看启动器日志。", true); return; } setTimeout(tick, 500); }
    tick();
  }
  function boot(){ if(!document.body){ setTimeout(boot, 50); return; } ensureStyle(); ensureBtn(); }
  boot();
})();</script>`
}

/**
 * 生成注入到 index.html 的「更新」常驻控件脚本（第一期：只提醒，绝不触发安装）。
 *
 * 常驻在重启按钮下方，状态直接写在按钮上：检查中 / ↑有新版 / 已忽略n / 已是最新 / 未查到。
 * 始终可点开面板——里面有「重新检查」按钮（按需真连 registry），已忽略的版本也列出来带
 * 「恢复」。这样即便你把唯一的新版都忽略了，入口还在、还能反悔（修掉旧版"忽略后徽标消失、
 * 再也进不去恢复"的问题）。
 */
function updateClientScript(canApply) {
  return `<script>(function(){
  if (window.__DSH_DL_UPDATE__) return;
  window.__DSH_DL_UPDATE__ = true;
  var CAN_APPLY = ${canApply ? "true" : "false"};
  var CH = { latest: "推荐", next: "候选", alpha: "前沿" };
  function $(s){ return document.querySelector(s); }
  function mk(tag){ return document.createElement(tag); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\u0022":"&quot;","\\u0027":"&#39;"}[c];}); }
  function lum(bg){ var m=/rgba?\\(([^)]+)\\)/i.exec(bg); if(!m) return null; var p=m[1].split(','); var a=(p.length>3?parseFloat(p[3]):1); if(a<0.05) return null; return (0.2126*p[0]+0.7152*p[1]+0.0722*p[2])/255; }
  function isDark(){ var c=[document.body, document.documentElement, $("#root")]; for(var i=0;i<c.length;i++){ if(!c[i]) continue; var L=lum(getComputedStyle(c[i]).backgroundColor); if(L!=null) return L<0.5; } try{ return matchMedia("(prefers-color-scheme: dark)").matches; }catch(e){ return false; } }
  function ensureStyle(){ if($("#dsh-dl-update-style")) return; var st=mk("style"); st.id="dsh-dl-update-style";
    st.textContent =
      "#dsh-dl-upd{position:fixed;top:10px;right:10px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:16px;font:13px/1 system-ui,'Segoe UI','Microsoft YaHei UI',sans-serif;cursor:pointer;border:1px solid;user-select:none;opacity:.9;transition:opacity .15s;}" +
      "#dsh-dl-upd:hover{opacity:1}" +
      "#dsh-dl-upd .v{font-weight:700}" +
      "#dsh-dl-upd-pop{position:fixed;top:46px;right:12px;z-index:2147483002;display:none;box-sizing:border-box;width:min(340px,92vw);padding:14px 16px;border-radius:12px;border:1px solid;font:13px/1.7 system-ui,'Segoe UI','Microsoft YaHei UI',sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.28);}" +
      "#dsh-dl-upd-pop h4{margin:0 0 8px;font-size:14px}" +
      "#dsh-dl-upd-pop .row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:2px 0}" +
      "#dsh-dl-upd-pop .k{opacity:.7;flex:none}" +
      "#dsh-dl-upd-pop .v2{display:flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums}" +
      "#dsh-dl-upd-pop .ig{opacity:.55;font-style:normal;font-size:11px}" +
      "#dsh-dl-upd-pop .btn{font-size:12px;padding:3px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer}" +
      "#dsh-dl-upd-pop .btn:hover{border-color:currentColor}" +
      "#dsh-dl-upd-pop .btn:disabled{opacity:.5;cursor:default}" +
      "#dsh-dl-upd-pop .empty{opacity:.8;padding:4px 0}" +
      "#dsh-dl-upd-pop .note{margin-top:10px;padding-top:10px;border-top:1px solid rgba(128,128,128,.25);opacity:.85;font-size:12px}" +
      "#dsh-dl-upd-pop .btn.upd{background:#2563eb;color:#fff;border-color:#2563eb}" +
      "#dsh-dl-upd-pop .btn.upd:hover{filter:brightness(1.08)}" +
      "#dsh-dl-upd-card{position:fixed;inset:0;z-index:2147483003;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}" +
      "#dsh-dl-upd-card .box{max-width:min(440px,86vw);padding:22px 28px;border-radius:12px;border:1px solid;font:14px/1.6 system-ui,'Segoe UI','Microsoft YaHei UI',sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.3)}";
    document.head.appendChild(st);
  }
  function paint(el, accent){ if(!el) return; var d=isDark();
    if(accent){ el.style.background = "#2563eb"; el.style.color = "#fff"; el.style.borderColor = "#2563eb"; }
    else { el.style.background = d ? "rgba(28,30,34,.72)" : "rgba(255,255,255,.9)"; el.style.color = d ? "#f3f4f6" : "#1f2328"; el.style.borderColor = d ? "rgba(255,255,255,.20)" : "rgba(0,0,0,.16)"; }
  }
  var DATA = null, POP = false;
  function label(d){
    if(!d || d.status==="idle" || d.status==="checking") return { t:"更新…", accent:false };
    if(d.status==="error") return { t:"更新（未查到）", accent:false };
    if(d.available && d.target) return { t:"\\u2191 有新版 "+d.target, accent:true };
    if((d.newer||[]).length>0) return { t:"更新 · 已忽略 "+d.newer.length, accent:false };
    return { t:"\\u2713 已是最新", accent:false };
  }
  function fetchStatus(){ return fetch("/desktop-launcher/update-check",{credentials:"same-origin",headers:{accept:"application/json"}}).then(function(r){ return r.json(); }); }
  function recheck(){ var b=$("#dsh-dl-upd-recheck"); if(b){ b.disabled=true; b.textContent="检查中…"; }
    fetch("/desktop-launcher/update-check",{method:"POST",credentials:"same-origin"}).then(function(r){return r.json();}).then(apply).catch(function(){ /* 保留旧状态 */ }); }
  function dismiss(version, ignored){ return fetch("/desktop-launcher/update-dismiss",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({version:version,ignored:ignored})}).then(fetchStatus).then(apply); }
  function updCard(text){ var c=$("#dsh-dl-upd-card"); if(!c){ c=mk("div"); c.id="dsh-dl-upd-card"; var box=mk("div"); box.className="box"; c.appendChild(box); document.body.appendChild(c); } var b=c.querySelector(".box"); b.textContent=text; paint(b, false); c.style.display="flex"; }
  function applyUpdate(v){ if(!window.confirm("升级到 "+v+"？\\n\\n这会停止当前 DeepSeek Harness（含正在运行的任务/会话），自动安装并重启；失败会自动回滚到当前版本。")) return;
    POP=false; var p=$("#dsh-dl-upd-pop"); if(p) p.remove();
    updCard("正在升级到 "+v+"…（安装可能需要一两分钟，请勿关闭）");
    fetch("/desktop-launcher/update-apply",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({version:v})})
      .then(function(r){ return r.json().then(function(j){ return {s:r.status,j:j}; }); })
      .then(function(x){ if(x.s!==200 || !x.j.ok){ updCard("更新请求失败："+(x.j.error||x.s)); return; } waitReconnect(v); })
      .catch(function(e){ updCard("无法联系本地服务："+e.message); }); }
  function waitReconnect(v){ var start=Date.now(), TIMEOUT=900000;
    function tick(){ fetch("/desktop-launcher/restart-status",{credentials:"same-origin",headers:{accept:"application/json"}})
      .then(function(r){ return r.json(); })
      .then(function(s){ if(s && s.nonce && s.nonce!==window.__DSH_DL_NONCE__ && s.phase==="ready"){ updCard("已升级到 "+v+"，正在重连…"); location.replace(s.authUrl||location.origin+"/"); return; } updCard("正在升级到 "+v+"…（安装中，请稍候）"); loop(); })
      .catch(function(){ updCard("正在升级到 "+v+"…（服务重启中）"); loop(); }); }
    function loop(){ if(Date.now()-start>TIMEOUT){ updCard("更新超时：新服务未能在预期时间内就绪。请双击桌面图标重启，或查看启动器日志。"); return; } setTimeout(tick,900); }
    tick(); }
  function apply(d){ DATA = d; render(); }
  function clusterRight(){ var r=$("#dsh-dl-restart"); return (r && r.offsetWidth) ? (r.offsetWidth + 18) : 10; }
  function render(){
    var b = $("#dsh-dl-upd"); if(!b) return;
    var L = label(DATA);
    b.innerHTML="<span>"+esc(L.t)+"</span>";
    b.title="检查 DeepSeek Harness 更新（当前 "+esc(DATA && DATA.current ? DATA.current : "?")+"）";
    b.style.top="10px"; b.style.right=clusterRight()+"px";
    paint(b, L.accent);
    if(POP) drawPop();
  }
  function toggle(){ POP=!POP; if(POP) drawPop(); else { var p=$("#dsh-dl-upd-pop"); if(p) p.remove(); } }
  function popHtml(d){
    d = d || { status:"idle", newer:[] };
    var h="<h4>更新 DeepSeek Harness</h4>";
    var st = d.status || "idle";
    var cur = (d.current ? esc(d.current) : (st==="idle"||st==="checking" ? "检查中…" : "—")) + (d.cliVersion && d.cliVersion !== d.current ? " <em class='ig'>（启动器 CLI " + esc(d.cliVersion) + "）</em>" : "");
    h+="<div class='row'><span class='k'>当前版本</span><span class='v2'>"+cur+"</span></div>";
    h+="<div class='row'><span class='k'>&nbsp;</span><span class='v2'><button class='btn' id='dsh-dl-upd-recheck'>重新检查</button></span></div>";
    if(st==="idle" || st==="checking"){ h+="<div class='empty'>正在检查更新…</div>"; }
    else if(st==="error"){ h+="<div class='empty'>没查到（离线 / 超时？）。可点「重新检查」再试。</div>"; }
    else {
      var list=d.newer||[];
      if(list.length===0){ h+="<div class='empty'>已是最新，没有比当前 "+esc(d.current||"")+" 更新的版本。</div>"; }
      else {
        for(var i=0;i<list.length;i++){ var n=list[i]; var label2=(CH[n.channel]||n.channel);
          var btns = "";
          if(n.ignored){ btns = "<button class='btn' data-v='"+esc(n.version)+"' data-ig='0'>恢复</button>"; }
          else {
            if(CAN_APPLY){ btns += "<button class='btn upd' data-upd='"+esc(n.version)+"'>更新到此版本</button> "; }
            btns += "<button class='btn' data-v='"+esc(n.version)+"' data-ig='1'>忽略</button>";
          }
          h+="<div class='row'><span class='k'>"+esc(label2)+"</span><span class='v2'>"+esc(n.version)+(n.ignored?" <em class='ig'>已忽略</em>":"")+" "+btns+"</span></div>";
        }
      }
    }
    h+="<div class='note'>"+(CAN_APPLY?"点「更新到此版本」会停止当前 dsh、自动安装并重启，失败自动回滚。":"本期只提醒、不自动安装。")+"「忽略」只影响提醒。rc/alpha 为预发布，升级前留意兼容性。</div>";
    return h;
  }
  function drawPop(){ var p=$("#dsh-dl-upd-pop"); if(!p){ p=mk("div"); p.id="dsh-dl-upd-pop"; document.body.appendChild(p); }
    p.innerHTML=popHtml(DATA);
    var rc=$("#dsh-dl-upd-recheck"); if(rc) rc.addEventListener("click", recheck);
    var ups=p.querySelectorAll(".btn.upd");
    for(var u=0;u<ups.length;u++){ ups[u].addEventListener("click", function(ev){ applyUpdate(ev.currentTarget.getAttribute("data-upd")); }); }
    var btns=p.querySelectorAll(".btn[data-v]");
    for(var i=0;i<btns.length;i++){ btns[i].addEventListener("click", function(ev){ var t=ev.currentTarget; dismiss(t.getAttribute("data-v"), t.getAttribute("data-ig")==="1"); }); }
    paint(p, false); p.style.top="46px"; p.style.right=clusterRight()+"px"; p.style.display="block";
  }
  function poll(n){ fetchStatus()
    .then(function(d){ apply(d); if(d && (d.status==="done" || d.status==="error")) return; if(n<10) setTimeout(function(){ poll(n+1); }, 1500); })
    .catch(function(){ if(n<10) setTimeout(function(){ poll(n+1); }, 2000); }); }
  function boot(){ if(!document.body){ setTimeout(boot,80); return; }
    ensureStyle();
    var b=mk("button"); b.id="dsh-dl-upd"; b.type="button"; b.addEventListener("click", toggle); document.body.appendChild(b);
    render();
    setInterval(function(){ render(); }, 1500);
    poll(0);
  }
  boot();
})();</script>`
}

/** 注册注入钩子 + 自定义路由。只在 Windows + 有端口时调用。 */
function setupRestartUI(ctx, port, installDir, cfg) {
  const state = { restarting: false }

  ctx.webServer.tapIndex((html) => {
    const tag = restartClientScript() + (cfg.checkForUpdates ? updateClientScript(cfg.allowSelfUpdate) : '')
    const at = html.lastIndexOf('</body>')
    return at >= 0 ? html.slice(0, at) + tag + html.slice(at) : html + tag
  })

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const isLoopback = (req) => {
    const ip = req.socket?.remoteAddress ?? ''
    return ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.')
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/desktop-launcher/restart',
    handler: (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: '只接受 POST' })
      // 复用真实鉴权：没有有效会话 cookie 时 authorizeIndex 已写好 401，这里直接返回。
      if (ctx.connection.authorizeIndex(req, res) === false) return
      const vbs = join(installDir, 'restart.vbs')
      if (!existsSync(vbs)) {
        return json(res, 503, { error: '重启脚本尚未就位，请先双击一次桌面图标（会部署启动器脚本）。' })
      }
      try {
        // 游离于 node 进程树之外：wscript 发起 launch.ps1 -Restart -NoOpen 后立即退出，
        // 使重启编排进程变成孤儿，从而不被本次触发的 stop.ps1（只杀 node 及其存活后代）误杀。
        const child = spawn('wscript.exe', ['//B', vbs], {
          detached: true,
          windowsHide: true,
          stdio: 'ignore',
          cwd: installDir,
          env: dedupedEnv()
        })
        child.on('error', (error) => log(`重启子进程启动失败：${error?.message ?? error}`))
        child.unref()
      } catch (error) {
        return json(res, 500, { error: `无法启动重启进程：${error?.message ?? error}` })
      }
      state.restarting = true
      log('网页触发了一次完整重启（wscript → launch.ps1 -Restart -NoOpen）')
      return json(res, 200, { ok: true })
    }
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/desktop-launcher/restart-status',
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: '只接受 GET' })
      // 收到重启命令的老进程临死前一律报 restarting，避免前端把它误当新服务。
      if (state.restarting) return json(res, 200, { phase: 'restarting', nonce: NONCE })
      // 新进程：报自己的 nonce（与页面里那份不同即代表已换新）；带令牌的地址只发给本机回环。
      let authUrl = ''
      if (isLoopback(req)) {
        try {
          authUrl = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`)
        } catch {
          authUrl = ''
        }
      }
      return json(res, 200, { phase: 'ready', nonce: NONCE, authUrl })
    }
  })

  // 只读地暴露最近一次更新检查结果（版本信息，不含令牌）。检查在后台异步跑，
  // 结果没出来时 status 是 idle/checking，前端会自行重试。关闭更新检查时不注册这两条路由。
  if (cfg.checkForUpdates) {
    ctx.webServer.register({
      kind: 'exact',
      path: '/desktop-launcher/update-check',
      handler: (req, res) => {
        if (req.method === 'GET') return json(res, 200, serializeUpdateState())
        if (req.method !== 'POST') return json(res, 405, { error: '只接受 GET/POST' })
        // POST = 手动「重新检查」：按需再跑一次（会真连 registry）。没入参就退回返回当前状态。
        if (!lastCheckArgs) return json(res, 200, serializeUpdateState())
        runUpdateCheck(lastCheckArgs.entryPath, lastCheckArgs.cfg, lastCheckArgs.installDir)
          .catch((error) => log(`手动更新检查异常（已忽略）：${error?.message ?? error}`))
          .finally(() => json(res, 200, serializeUpdateState()))
        return undefined
      }
    })

    // 「忽略 / 恢复提醒某个版本」。只写我们自己的 update-dismiss.json，不碰 dsh 安装。
    ctx.webServer.register({
      kind: 'exact',
      path: '/desktop-launcher/update-dismiss',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: '只接受 POST' })
        readJsonBody(req)
          .then((body) => {
            const version = String(body?.version ?? '')
            if (!version) return json(res, 400, { error: '缺少 version' })
            const ignore = body?.ignored !== false
            if (ignore) dismissedVersions.add(version)
            else dismissedVersions.delete(version)
            applyDismissedToState()
            writeDismissFile().catch(() => {})
            writeUpdateArtifact(updateState._dir || installDir).catch(() => {})
            return json(res, 200, { ok: true, ignored: [...dismissedVersions] })
          })
          .catch(() => json(res, 400, { error: '请求体解析失败' }))
      }
    })

    // 第二期：真正触发一次外部升级。只接受「已检测到的候选版本」，避免被诱导装任意包。
    ctx.webServer.register({
      kind: 'exact',
      path: '/desktop-launcher/update-apply',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: '只接受 POST' })
        if (ctx.connection.authorizeIndex(req, res) === false) return
        if (!cfg.allowSelfUpdate) return json(res, 403, { error: '未开启自助更新（allowSelfUpdate=false）' })
        const vbs = join(installDir, 'update.vbs')
        if (!existsSync(vbs)) {
          return json(res, 503, { error: '更新脚本未就位，请先双击一次桌面图标（会部署 update.vbs）。' })
        }
        readJsonBody(req)
          .then((body) => {
            const version = String(body?.version ?? '')
            if (!version) return json(res, 400, { error: '缺少 version' })
            const allowed = (Array.isArray(updateState.newer) ? updateState.newer : []).some((n) => n.version === version)
            if (!allowed) return json(res, 400, { error: '只能更新到已检测到的候选版本' })
            try {
              // 游离于 node 进程树之外：wscript 起 update.ps1 后立即退出，使其成为孤儿，
              // 不被 update.ps1 内部调用的 stop.ps1（只杀 node 及其存活后代）误杀。
              const child = spawn('wscript.exe', ['//B', vbs, version], {
                detached: true,
                windowsHide: true,
                stdio: 'ignore',
                cwd: installDir,
                env: dedupedEnv()
              })
              child.on('error', (error) => log(`更新子进程启动失败：${error?.message ?? error}`))
              child.unref()
            } catch (error) {
              return json(res, 500, { error: `无法启动更新进程：${error?.message ?? error}` })
            }
            state.restarting = true // 让 restart-status 报 restarting，前端据此重连到新进程
            log(`触发一次自助更新：升级到 ${version}（wscript → update.vbs → update.ps1）`)
            return json(res, 200, { ok: true })
          })
          .catch(() => json(res, 400, { error: '请求体解析失败' }))
      }
    })
  }
}

export function apply(ctx, config) {
  // 这个插件整体是 Windows 专用的：启动器是 .vbs + PowerShell，快捷方式是 .lnk。
  // 别的系统上安静地什么都不做，而不是去建一堆用不上的文件。
  if (process.platform !== 'win32') {
    log(`当前系统是 ${process.platform}，桌面启动器只在 Windows 上工作，跳过`)
    return
  }

  const port = ctx.webServer?.port
  if (port === undefined) {
    log('webServer 还没绑定端口，跳过桌面图标安装')
    return
  }

  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const authUrl = authenticatedUrl(ctx, port)
  const installDir = cfg.installDir || defaultInstallDir()

  // 重启按钮只依赖活的 webServer，立刻挂上（不等图标安装完成）。
  try {
    setupRestartUI(ctx, port, installDir, cfg)
  } catch (error) {
    log(`挂载网页重启按钮失败（不影响图标安装）：${error?.stack ?? error}`)
  }

  // 不阻塞 dsh 启动：安装失败也不该影响服务本身。
  setTimeout(() => {
    install(cfg, port, authUrl, installDir).catch((error) => {
      log(`安装桌面图标失败：${error?.stack ?? error}`)
    })
  }, 0)

  // 第一期：后台只读地查一次有没有新版本（绝不安装）。稍等 1.5s 让它避开启动高峰；
  // 任何异常都只记日志，绝不影响服务本身。
  if (cfg.checkForUpdates) {
    const entryPath = process.argv[1] ? resolve(process.argv[1]) : ''
    lastCheckArgs = { entryPath, cfg, installDir }
    setTimeout(() => {
      runUpdateCheck(entryPath, cfg, installDir).catch((error) => {
        updateState.status = 'error'
        updateState.error = String(error?.message ?? error)
        log(`更新检查异常（已忽略）：${error?.stack ?? error}`)
      })
    }, 1500)
  }
}

async function install(cfg, port, authUrl, installDir) {
  const dir = installDir || cfg.installDir || defaultInstallDir()

  await copyAssets(ASSETS, dir)
  await mkdir(join(dir, 'logs'), { recursive: true })

  const launchInfo = describeLaunch(port)
  const launcherConfig = {
    _help: '由 dsh-desktop-launcher 在每次 dsh 启动时重写。手改会在下次启动被覆盖。',
    appName: 'DeepSeek Harness',
    shortcutName: cfg.shortcutName,
    browser: cfg.browser,
    appMode: cfg.appMode,
    startTimeoutSec: cfg.startTimeoutSec,
    // 本次进程的带令牌地址。空串 = 没拿到，启动器会退回读 dsh-stdout.log。
    authUrl,
    ...launchInfo
  }
  await writeFile(
    join(dir, 'launcher.json'),
    `${JSON.stringify(launcherConfig, null, 2)}\n`,
    'utf8'
  )

  const result = await runPowerShell(join(dir, 'scripts', 'shortcut.ps1'), [
    '-Action', 'Install',
    '-ShortcutName', cfg.shortcutName,
    '-Port', String(port),
    '-Adopt', cfg.adoptBrowserShortcut ? '1' : '0',
    '-Desktop', cfg.desktop ? '1' : '0',
    '-StartMenu', cfg.startMenu ? '1' : '0'
  ])

  const text = result.output.trim()
  if (text) log(text)
  if (result.code !== 0) log(`shortcut.ps1 退出码 ${result.code}`)
}

/**
 * 第一期：只读地查一次更新（跨通道）。读当前版本 → 问 registry → 列出所有比它新的
 * 通道版本（排除已忽略）→ 记结果 + 落 update-check.json 产物。全程不碰 dsh 安装。
 */
async function runUpdateCheck(entryPath, cfg, installDir) {
  const dir = installDir || cfg.installDir || defaultInstallDir()
  updateState.status = 'checking'
  updateState._channels = cfg.updateChannels
  updateState._notify = cfg.updateNotify
  updateState._dir = dir

  await mkdir(dir, { recursive: true }).catch(() => {})
  dismissFile = join(dir, 'update-dismiss.json')
  dismissedVersions.clear()
  try {
    const raw = JSON.parse(await readFile(dismissFile, 'utf8'))
    for (const v of Array.isArray(raw?.ignored) ? raw.ignored : []) dismissedVersions.add(v)
  } catch {
    // 首次没有该文件，正常
  }

  const appVersion = await resolveAppVersion(entryPath, cfg.updateVersionPackage)
  const cliVersion = await readInstalledVersion(entryPath)
  const current = appVersion || cliVersion
  const res = await checkForUpdate({
    pkgName: cfg.updatePackage,
    channels: cfg.updateChannels,
    notify: cfg.updateNotify,
    ignored: [...dismissedVersions],
    current,
    registry: cfg.updateRegistry,
    timeoutMs: cfg.updateCheckTimeoutMs
  })
  Object.assign(updateState, res, { status: res.ok ? 'done' : 'error' })
  updateState.appVersion = appVersion
  updateState.cliVersion = cliVersion
  updateState._channels = cfg.updateChannels
  updateState._notify = cfg.updateNotify
  updateState._dir = dir
  await writeUpdateArtifact(dir)

  if (res.ok && res.available) {
    log(`发现可更新版本：推荐 ${res.target}（通道 ${res.channel}）；当前应用 ${current}${cliVersion && cliVersion !== current ? `（CLI ${cliVersion}）` : ''}，共 ${res.newer.length} 个更新——第一期只提示不自动安装`)
  } else if (res.ok) {
    log(`没有比当前应用 ${current} 更新的版本（或都已忽略）`)
  } else {
    log(`更新检查未完成：${res.error}`)
  }
  return res
}

/** 读一个 JSON 请求体（带大小上限），失败则 reject。 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((res, rej) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { rej(new Error('body 过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        res(text ? JSON.parse(text) : {})
      } catch (error) {
        rej(error)
      }
    })
    req.on('error', rej)
  })
}

/** 不重新联网，仅按当前 dismissedVersions 重算徽标要显示的 newer/target/available。 */
function applyDismissedToState() {
  const s = updateState
  if (!s.current || !s.distTags) return
  const channels = s._channels || ['latest', 'next', 'alpha']
  let newer = listNewer(s.current, s.distTags, channels)
  if (s._notify === 'recommended-only') newer = newer.filter((n) => n.channel === channels[0])
  newer = newer.map((n) => ({ ...n, ignored: dismissedVersions.has(n.version) }))
  const active = newer.find((n) => !n.ignored) || null
  s.newer = newer
  s.target = active ? active.version : null
  s.channel = active ? active.channel : null
  s.available = Boolean(active)
}

/** 把更新检查结果（去掉内部 _ 字段）落到 update-check.json。 */
async function writeUpdateArtifact(dir) {
  if (!dir) return
  const { _channels, _notify, _dir, ...pub } = updateState
  try {
    await writeFile(
      join(dir, 'update-check.json'),
      `${JSON.stringify(
        { _help: 'dsh-desktop-launcher 第一期写入的更新检查结果（只读，不触发安装）。手改会在下次启动被覆盖。', ...pub },
        null,
        2
      )}\n`,
      'utf8'
    )
  } catch (error) {
    log(`写 update-check.json 失败（不影响提示）：${error?.message ?? error}`)
  }
}

/** 持久化「已忽略版本」清单，跨重启保留。删掉该文件即恢复全部提醒。 */
async function writeDismissFile() {
  if (!dismissFile) return
  await writeFile(
    dismissFile,
    `${JSON.stringify(
      { _help: '已忽略提醒的版本（跨重启保留）。删掉此文件即恢复全部提醒。', ignored: [...dismissedVersions].sort(), updatedAt: new Date().toISOString() },
      null,
      2
    )}\n`,
    'utf8'
  )
}
