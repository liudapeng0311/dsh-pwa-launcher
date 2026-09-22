/**
 * dsh-pwa-launcher —— 让 DeepSeek Harness 双击桌面图标就能用。
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
 * @module dsh-pwa-launcher
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { checkForUpdate, listNewer, looksLikeVersion, readInstalledVersion, resolveAppVersion } from './version.js'

/** Cordis 插件名。 */
export const name = 'pwa-launcher'

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
  // 顶栏避让：dsh 自己的顶栏控件（文件 / 窗口 等）在开始对话后才出现，会盖住我们
  // 贴右边的两个按钮。true = 探测到就整簇左移，没有就留在原位。
  avoidAppButtons: true,
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
 * 最近一次更新检查的结果。进程内单份，供网页路由 GET /pwa-launcher/update-check
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
//                      POST /pwa-launcher/restart        触发一次外部重启
//                      GET  /pwa-launcher/restart-status 前端轮询：新进程起来没有
//
// 为什么是「外部重启」而非进程内 self-restart：插件就跑在被重启的那个 dsh 进程里，让它
// 自己杀自己再原地复活不干净也做不到（这正是自更新要外部脚本的原因）。所以按钮只去 spawn
// 一个游离于 node 进程树之外的 wscript→launch.ps1，由它 stop→start（见 assets/restart.vbs）。

/** 生成注入到 index.html 的自包含脚本（右上角按钮 + 启动风格的提示卡 + 轮询重连）。 */
function restartClientScript(avoidAppButtons) {
  return `<script>(function(){
  if (window.__DSH_DL_RESTART__) return;
  window.__DSH_DL_RESTART__ = true;
  var NONCE = ${JSON.stringify(NONCE)};
  window.__DSH_DL_NONCE__ = NONCE;
  var STARTING = "正在启动，请稍候…（不必重复点击图标）";
  var RESTARTING = "正在重启，请稍候…";
  // 我们的两个常驻按钮贴右边。dsh 自己在顶栏右侧也放控件（文件 / 窗口 等），
  // 对话开始后才出现，会把我们盖住。所以：探测到应用侧控件就把整簇左移，没有就留在原位。
  var AVOID = ${avoidAppButtons ? 'true' : 'false'};
  var BASE_RIGHT = 10;   // 默认贴右边留的间距（没有应用侧控件时就是这个）
  var INNER_GAP = 8;     // 簇内「更新」和「重启」之间的间距
  var CLUSTER_GAP = 10;  // 左移后与对方控件保留的间距
  var TOP_MAX = 64;      // 只关心顶部这么高的一条带子
  var CORNER_W = 72;     // 「右上角」判定区宽度：角上没东西 = 没有顶栏控件
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
      "#dsh-dl-restart{position:fixed;top:10px;right:10px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:16px;font:13px/1 system-ui, 'Segoe UI', 'Microsoft YaHei UI', sans-serif;cursor:pointer;border:1px solid;user-select:none;opacity:.86;transition:opacity .15s,right .18s ease;}" +
      "#dsh-dl-restart:hover{opacity:1}";
    document.head.appendChild(st);
  }
  function paint(btn){ var d=isDark();
    btn.style.background = d ? "rgba(28,30,34,.72)" : "rgba(255,255,255,.86)";
    btn.style.color = d ? "#f3f4f6" : "#1f2328";
    btn.style.borderColor = d ? "rgba(255,255,255,.20)" : "rgba(0,0,0,.16)";
  }
  // 找「应用自己的」顶栏控件在右侧占到了哪里。
  //
  // 刻意不去认 dsh 的内部 DOM（class/结构一变就失效），而是问浏览器：
  // 在我们按钮所在的那条纵向带子里，从右往左哪里有应用控件，取最靠左的那个坐标。
  //
  // 注意要从「右缘往里扫一段」而不是只测最右一个点 —— 顶栏控件常常右边还有内边距，
  // 只测最右点会直接判定「没有控件」，漏掉它。
  // 这个点是不是落在「我们自己的东西」上（按钮、卡片、面板）。
  //
  // 必须往上走祖先链，不能只看元素自身：elementsFromPoint 返回的是**最内层**元素，
  // 而我们按钮里是 <span> 包着的，span 自己没有 id。只看自身的话，我们自己的按钮
  // 会被当成「应用控件」，于是布局每次都追着自己的按钮往左跑（实测过的抖动 bug）。
  function isOurs(n){
    for(var p=n; p && p.nodeType === 1; p = p.parentNode){
      if(p.id && p.id.indexOf("dsh-dl-") === 0) return true;
    }
    return false;
  }
  // 这个点上「露出来的应用控件」是谁？没有就返回 false。
  function compactAppAt(x, y, vw2){
    var stack; try{ stack = document.elementsFromPoint(x, y); }catch(e){ return false; }
    if(!stack) return false;
    for(var i=0;i<stack.length;i++){
      var n = stack[i];
      if(!n || n.nodeType !== 1) continue;
      if(n === document.documentElement || n === document.body) continue;
      // 我们自己的（含内部 span / 面板）：跳过，继续往下找 ——
      // 因为我们的按钮可能正盖在对方控件上面，底下那个才是要避开的。
      if(isOurs(n)) continue;
      var r = n.getBoundingClientRect();
      if(r.width < 8 || r.height < 8) continue;
      if(r.width > vw2 * 0.45) continue;                  // 大容器（布局壳）不算控件
      if(r.height > 120) continue;                        // 高面板不算顶栏控件
      if(r.top > TOP_MAX) continue;                       // 不在顶部带子里
      return true;
    }
    return false;
  }
  /**
   * 返回「应用顶栏控件簇最靠左的边缘」x 坐标；没有控件就返回 null。
   *
   * 这个判断有三个坑，都是实测踩出来的，别删任何一条：
   *
   *   1) **必须有右上角锚点。** 正文（页面标题、说明文字、居中列里的东西）可能
   *      正好落在我们按钮那条纵向带子里、尺寸也够小，于是被误判成顶栏控件，
   *      整簇被推到页面中间、还盖住人家标题 —— 某插件的 Command Code 页面
   *      就是这么被推歪的。它的正文是一个 max-width:760px、margin:0 auto
   *      的居中列，永远够不到右缘。**顶栏控件必然占据右上角**，用这个当锚点。
   *
   *   2) **容忍簇内空隙**，因为真实顶栏是一排按钮，按钮之间本来就有几像素的缝；
   *      遇到缝就停会把「多个按钮」误判成一个。
   *
   *   3) **让位距离封顶。** 万一又遇到「一大片都算被占」的页面，最多也只让开
   *      MAX_SHIFT，不会被推到屏幕中间去（这条是第 1 条的兜底保险）。
   */
  function appRightEdge(){
    var vw2 = vw(); if(!vw2) return null;
    var ya = [16, 24, 32];

    // —— 第 1 步：右上角锚点。整条角上都没控件 -> 判定为「没有顶栏控件」，不让位。
    var anchored = false;
    for(var d=2; d<=CORNER_W && !anchored; d+=4){
      for(var k=0;k<ya.length;k++){ if(compactAppAt(vw2 - d, ya[k], vw2)){ anchored = true; break; } }
    }
    if(!anchored) return null;

    // —— 第 2 步：往左扫簇的左界（有距离上限）
    var STEP = 6;
    var GAP_TOL = 40;
    // 让位距离上限：与上面的「宽度不超过视口 45%」保持一致。
    // 没有它的话，一旦某种页面被误判成「一大片都算控件」，整簇会被推到屏幕中间。
    var MAX_SHIFT = Math.min(Math.round(vw2 * 0.45), 480);
    var leftMost = null, sinceCovered = 0;
    for(var dd=2; dd<=MAX_SHIFT; dd+=STEP){
      var x = vw2 - dd;
      if(x <= 0) break;
      var covered = false;
      for(var kk=0;kk<ya.length;kk++){ if(compactAppAt(x, ya[kk], vw2)){ covered = true; break; } }
      if(covered){ leftMost = x; sinceCovered = 0; }
      else {
        sinceCovered += STEP;
        // ⚠️ 必须带 leftMost !== null 这个前置条件：空闲扫描阶段本来就会连续
        // 采到一堆「没东西」，若在这里就 break，会把「还没找到任何控件」也当成
        // 「簇结束了」，直接返回 null —— 于是该让位时完全不让位（实测踩过，
        // 被既有测试 S5 抓住）。
        if(leftMost !== null && sinceCovered > GAP_TOL) break;   // 簇结束
      }
    }
    return leftMost === null ? null : leftMost;
  }
  var lastRight = null;        // 上一次真正应用到 DOM 的 right
  var lastSeenAppAt = 0;       // 上一次「确实看到应用控件」的时刻
  var RETURN_DELAY = 1500;     // 控件消失后等这么久才回原位（它闪一下就别跟着弹）
  // 摆放整簇：有应用侧控件 -> 退到它左边；没有 -> 回默认贴右。
  function layout(){
    var r=$("#dsh-dl-restart"); if(!r) return;
    var target = BASE_RIGHT;
    if(AVOID){
      var edge = appRightEdge();
      if(edge !== null){
        lastSeenAppAt = Date.now();
        target = Math.max(BASE_RIGHT, Math.round(vw() - edge) + CLUSTER_GAP);
      } else if(lastRight !== null && lastRight !== BASE_RIGHT &&
                (Date.now() - lastSeenAppAt) < RETURN_DELAY){
        // 刚还在、这一拍没扫到 —— 多半是应用侧控件正在重绘。先留在原地，
        // 免得「移过去又弹回来」地抖（这是用户实际看到过的问题）。
        target = lastRight;
      }
    }
    window.__DSH_DL_BTN_RIGHT__ = target;
    window.__DSH_DL_INNER_GAP__ = INNER_GAP;
    // 位置没变就完全不碰 DOM —— 否则改样式会惊动 MutationObserver，和下面的
    // RELAYOUT（它会重画面板）互相触发，形成自激循环。
    if(target === lastRight) return;
    lastRight = target;
    r.style.right = target + "px";
    var u=$("#dsh-dl-upd");
    if(u && u.offsetWidth){ u.style.right = (target + r.offsetWidth + INNER_GAP) + "px"; }
    if(window.__DSH_DL_RELAYOUT__) { try{ window.__DSH_DL_RELAYOUT__(); }catch(e){} }
  }
  var layoutQueued = false;
  // 观察器会在流式输出时疯狂触发，所以合并到下一帧再算，别每次都扫 DOM。
  function scheduleLayout(){
    if(layoutQueued) return; layoutQueued = true;
    setTimeout(function(){ layoutQueued = false; layout(); }, 200);
  }
  function vw(){ return window.innerWidth || document.documentElement.clientWidth || 0; }
  function ensureBtn(){ if($("#dsh-dl-restart")) return;
    var b=mk("button"); b.id="dsh-dl-restart"; b.type="button";
    b.title="重启整个 DeepSeek Harness：停止当前进程（含正在运行的任务/会话）并重新拉起，本页面会自动重连";
    b.innerHTML="<span style='font-size:15px;line-height:1'>\\u21bb</span><span>\\u91cd\\u542f</span>";
    try{ b.style.backdropFilter="blur(8px)"; b.style.webkitBackdropFilter="blur(8px)"; }catch(e){}
    document.body.appendChild(b);
    paint(b);
    b.addEventListener("click", onClick);
    layout();
    // 每秒兜底一次：MutationObserver 万一没触发（或我们漏了某个变化），也不会长期错位。
    setInterval(function(){ var x=$("#dsh-dl-restart"); if(x){ paint(x); } layout(); }, 1000);
    // 应用侧控件是「开始对话后」才出现的 —— 用 MutationObserver 及时跟上，并监听尺寸变化。
    // 走 scheduleLayout（合并 + 延迟），因为流式输出时 DOM 会高频变动。
    try{
      if(window.MutationObserver){
        var ob = new MutationObserver(function(){ scheduleLayout(); });
        ob.observe(document.body, { childList:true, subtree:true });
      }
    }catch(e){}
    try{ window.addEventListener("resize", function(){ scheduleLayout(); }, { passive:true }); }catch(e){}
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
    try{ res = await fetch("/pwa-launcher/restart", { method:"POST", credentials:"same-origin" }); }
    catch(e){ showCard("无法联系本地服务：" + e.message + "。请双击桌面图标重启。", true); return; }
    if(res.status===401){ showCard("登录状态已失效。请关闭本窗口，用桌面图标重新打开一次 Harness。", true); return; }
    if(!res.ok){ var t=""; try{ t=(await res.json()).error||""; }catch(e){} showCard("重启请求失败（" + res.status + "）" + (t?"：" + t:"") + "。也可以双击桌面图标重启。", true); return; }
    waitReady();
  }
  function waitReady(){ var start=Date.now(), TIMEOUT=180000;
    function tick(){ fetch("/pwa-launcher/restart-status", { credentials:"same-origin", headers:{ "accept":"application/json" } })
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
      "#dsh-dl-upd{position:fixed;top:10px;right:10px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:16px;font:13px/1 system-ui,'Segoe UI','Microsoft YaHei UI',sans-serif;cursor:pointer;border:1px solid;user-select:none;opacity:.9;transition:opacity .15s,right .18s ease;}" +
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
  function fetchStatus(){ return fetch("/pwa-launcher/update-check",{credentials:"same-origin",headers:{accept:"application/json"}}).then(function(r){ return r.json(); }); }
  function recheck(){ var b=$("#dsh-dl-upd-recheck"); if(b){ b.disabled=true; b.textContent="检查中…"; }
    fetch("/pwa-launcher/update-check",{method:"POST",credentials:"same-origin"}).then(function(r){return r.json();}).then(apply).catch(function(){ /* 保留旧状态 */ }); }
  function dismiss(version, ignored){ return fetch("/pwa-launcher/update-dismiss",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({version:version,ignored:ignored})}).then(fetchStatus).then(apply); }
  function updCard(text){ var c=$("#dsh-dl-upd-card"); if(!c){ c=mk("div"); c.id="dsh-dl-upd-card"; var box=mk("div"); box.className="box"; c.appendChild(box); document.body.appendChild(c); } var b=c.querySelector(".box"); b.textContent=text; paint(b, false); c.style.display="flex"; }
  function applyUpdate(v){ if(!window.confirm("升级到 "+v+"？\\n\\n这会停止当前 DeepSeek Harness（含正在运行的任务/会话），自动安装并重启；失败会自动回滚到当前版本。")) return;
    closePop();   // 和「点别处收起」走同一条路径，别各写一份
    updCard("正在升级到 "+v+"…（安装可能需要一两分钟，请勿关闭）");
    fetch("/pwa-launcher/update-apply",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({version:v})})
      .then(function(r){ return r.json().then(function(j){ return {s:r.status,j:j}; }); })
      .then(function(x){ if(x.s!==200 || !x.j.ok){ updCard("更新请求失败："+(x.j.error||x.s)); return; } waitReconnect(v); })
      .catch(function(e){ updCard("无法联系本地服务："+e.message); }); }
  function waitReconnect(v){ var start=Date.now(), TIMEOUT=900000;
    function tick(){ fetch("/pwa-launcher/restart-status",{credentials:"same-origin",headers:{accept:"application/json"}})
      .then(function(r){ return r.json(); })
      .then(function(s){ if(s && s.nonce && s.nonce!==window.__DSH_DL_NONCE__ && s.phase==="ready"){ updCard("已升级到 "+v+"，正在重连…"); location.replace(s.authUrl||location.origin+"/"); return; } updCard("正在升级到 "+v+"…（安装中，请稍候）"); loop(); })
      .catch(function(){ updCard("正在升级到 "+v+"…（服务重启中）"); loop(); }); }
    function loop(){ if(Date.now()-start>TIMEOUT){ updCard("更新超时：新服务未能在预期时间内就绪。请双击桌面图标重启，或查看启动器日志。"); return; } setTimeout(tick,900); }
    tick(); }
  function apply(d){ DATA = d; render(); }
  // 位置由重启脚本那份 layout() 统一决定（它负责避让应用侧控件），这里只负责读出来。
  // 两个脚本共享 window 上的基准值，避免各算一套导致错位。
  function clusterRight(){
    var r=$("#dsh-dl-restart");
    var base = typeof window.__DSH_DL_BTN_RIGHT__ === "number" ? window.__DSH_DL_BTN_RIGHT__ : 10;
    var gap  = typeof window.__DSH_DL_INNER_GAP__ === "number" ? window.__DSH_DL_INNER_GAP__ : 8;
    return (r && r.offsetWidth) ? (base + r.offsetWidth + gap) : base;
  }
  // 重启脚本重新布局时回调这里，让「更新」按钮和已打开的面板跟着一起走。
  window.__DSH_DL_RELAYOUT__ = function(){
    var b=$("#dsh-dl-upd"); if(b) b.style.right=clusterRight()+"px";
    if(POP) drawPop();
  };
  function render(){
    var b = $("#dsh-dl-upd"); if(!b) return;
    var L = label(DATA);
    b.innerHTML="<span>"+esc(L.t)+"</span>";
    b.title="检查 DeepSeek Harness 更新（当前 "+esc(DATA && DATA.current ? DATA.current : "?")+"）";
    b.style.top="10px"; b.style.right=clusterRight()+"px";
    paint(b, L.accent);
    if(POP) drawPop();
  }
  // 关掉面板。注意：关的时候要把 PANEL 一起清掉，别只置 POP —— 否则
  // 下一次 render() 看到 POP 还是 true，又把它画回来（表现就是「关不掉」）。
  function closePop(){ POP=false; var p=$("#dsh-dl-upd-pop"); if(p) p.remove(); }
  // 这个节点算不算「面板自己人」（面板内部，或那个开关按钮）。
  // 同样要沿父链找 —— 点击事件的目标往往是最内层的 <span>/<button>，自身没有 id。
  function isPopUI(n){
    for(var p=n; p && p.nodeType === 1; p = p.parentNode){
      if(p.id === "dsh-dl-upd-pop" || p.id === "dsh-dl-upd") return true;
    }
    return false;
  }
  function toggle(){ POP=!POP; if(POP) drawPop(); else closePop(); }
  // 点页面别处就收起面板。
  // 用捕获阶段（第三个参数 true）：应用自己（React）可能在点击里 stopPropagation，
  // 冒泡阶段就收不到了；捕获先于目标处理，稳。
  function watchOutside(){
    document.addEventListener("click", function(ev){
      if(!POP) return;
      if(isPopUI(ev.target)) return;   // 点开关本身走它自己的 toggle，点面板内部不关
      closePop();
    }, true);
    // Esc 也收起（和大多数浮层一致）
    document.addEventListener("keydown", function(ev){
      if(!POP) return;
      var k = ev && (ev.key || ev.keyCode);
      if(k === "Escape" || k === "Esc" || k === 27) closePop();
    }, true);
  }
  function popHtml(d){
    d = d || { status:"idle", newer:[] };
    var h="<h4>更新 DeepSeek Harness</h4>";
    var st = d.status || "idle";
    // 「当前版本」这一行：有版本就显示版本。拿不到时区分两种情况 ——
    // 服务还没应答（idle/checking）说「读取中…」，其余（如出错）才显示「—」。
    var cur;
    if(d.current) cur = esc(d.current);
    else if(st==="idle" || st==="checking") cur = "读取中…";
    else cur = "—";
    if(d.cliVersion && d.current && d.cliVersion !== d.current) cur += " <em class='ig'>（启动器 CLI " + esc(d.cliVersion) + "）</em>";
    h+="<div class='row'><span class='k'>当前版本</span><span class='v2'>"+cur+"</span></div>";
    h+="<div class='row'><span class='k'>&nbsp;</span><span class='v2'><button class='btn' id='dsh-dl-upd-recheck'>重新检查</button></span></div>";
    if(st==="idle" || st==="checking"){ h+="<div class='empty'>正在检查更新…（服务刚启动时会稍慢，本面板会自动重试）</div>"; }
    else if(st==="error"){
      // 把具体原因显示出来 —— 只说「未查到」会让人以为功能坏了，
      // 而实际多半是到 npm 的网络抖了一下（超时 / ECONNRESET）。
      var why = (d.error ? esc(d.error) : "网络未返回");
      h+="<div class='empty'>这次没查到：<em class='ig'>"+why+"</em><br>多半是网络抖动（离线 / 超时 / 被墙）。点「重新检查」再试即可。</div>";
    }
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
    .then(function(d){
      apply(d);
      if(d && (d.status==="done" || d.status==="error")) return;   // 终态，收工
      if(n<10) setTimeout(function(){ poll(n+1); }, 1500);
      else scheduleSlowPoll();
    })
    .catch(function(){
      // 连不上（服务正在冷启动/重启）——别把 n 用光就彻底躺下，
      // 退到慢速轮询，等它起来。这正是「面板永远停在检查中」的成因。
      if(n<10) setTimeout(function(){ poll(n+1); }, 2000);
      else scheduleSlowPoll();
    }); }
  // 快速轮询用尽后的兜底：只要还没拿到终态，就一直慢慢问下去（10s 一次）。
  // 服务冷启动要 60s+，没有这个兜底页面就会永远卡在「检查中…」。
  function scheduleSlowPoll(){
    setTimeout(function(){
      fetchStatus().then(function(d){
        apply(d);
        if(!d || (d.status!=="done" && d.status!=="error")) scheduleSlowPoll();
      }).catch(function(){ scheduleSlowPoll(); });
    }, 10000);
  }
  function boot(){ if(!document.body){ setTimeout(boot,80); return; }
    ensureStyle();
    watchOutside();
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
    const tag = restartClientScript(cfg.avoidAppButtons) + (cfg.checkForUpdates ? updateClientScript(cfg.allowSelfUpdate) : '')
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
    path: '/pwa-launcher/restart',
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
    path: '/pwa-launcher/restart-status',
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
      path: '/pwa-launcher/update-check',
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
      path: '/pwa-launcher/update-dismiss',
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
      path: '/pwa-launcher/update-apply',
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
            // 两道判定，缺一不可：
            //   1) 必须是合法 semver —— version 会变成 `npm install <包>@<version>` 的 spec，
            //      而 npm 接受 file: / https://…tgz。「在候选列表里」本身不构成校验，
            //      因为那份候选列表的原始值同样来自 registry。
            //   2) 必须是这次真的检测到过的候选 —— 防止随便指定一个版本号让我们去装。
            if (!looksLikeVersion(version)) {
              return json(res, 400, { error: '版本号格式不合法，只接受 semver（如 0.1.5-rc.2）' })
            }
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

  // 第一期：后台只读地查一次有没有新版本（绝不安装）。
  // 等 6 秒再查：启动瞬间机器最忙（dsh 自己在引导、install() 正在拉 PowerShell 部署
  // 启动器），实测这时去连 npm 很容易超时/ECONNRESET —— 而检查只跑这一次。
  // 避开高峰 + checkForUpdate 内部重试，两层一起上。
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
    }, 6000)
  }
}

async function install(cfg, port, authUrl, installDir) {
  const dir = installDir || cfg.installDir || defaultInstallDir()

  await copyAssets(ASSETS, dir)
  await mkdir(join(dir, 'logs'), { recursive: true })

  const launchInfo = describeLaunch(port)
  const launcherConfig = {
    _help: '由 dsh-pwa-launcher 在每次 dsh 启动时重写。手改会在下次启动被覆盖。',
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
  // 版本号一读出来就先挂到状态上：面板在「检查中」阶段也要能显示「当前版本」，
  // 否则用户看到的是一个空荡荡的「检查中…」（就是这么来的）。
  updateState.current = current
  updateState.appVersion = appVersion
  updateState.cliVersion = cliVersion
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
        { _help: 'dsh-pwa-launcher 第一期写入的更新检查结果（只读，不触发安装）。手改会在下次启动被覆盖。', ...pub },
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
