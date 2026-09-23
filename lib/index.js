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
 *   4. 通过 webServer 的 register 扩展点挂几条自定义路由（重启、重启状态、更新检查、
 *      自助升级），供浏览器半边调用：一键把整个 harness 连根重启或升级（含停掉卡住的
 *      任务/会话），完成后当前窗口自动重连刷新。
 *
 * 网页里的两个按钮由**浏览器半边**（lib/client.js）注册进 dsh 的会话头部
 * conversation.session.header.utilities 槽，不由本文件注入 —— 见下面「网页内的
 * 重启 / 升级入口」一节。
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
 * 前端（浏览器半边）会记住「我这一页来自哪个 nonce」，重启/升级后轮询
 * restart-status，一旦读到不同的 nonce 并且新进程已 ready，就说明服务换进程了、
 * 可以安全重连。只知道 ready 是不够的：命令刚发出时老进程还没退场，它也会答 ready。
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
  // —— 更新检查 ——
  checkForUpdates: true, // false = 完全不查，会话头部的版本按钮会停在「检查…」
  allowSelfUpdate: true, // true = 版本按钮可直接升级；false = 只提醒，点它只重新检查
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

/**
 * 把 updateState 序列化成对外 JSON（GET/POST update-check 共用）。
 *
 * `canApply` 是给会话头部那个胶囊用的：它决定「点版本按钮」是发起升级还是只重新检查。
 * 不把它放进响应的话，allowSelfUpdate=false 的部署里前端无从判断，只能照样摆出
 * 「点一下就升级」的提示，点了才吃 403。
 *
 * @param cfg - 当前插件配置；缺省时 canApply 报 false（宁可不给升级入口）。
 */
function serializeUpdateState(cfg) {
  const s = updateState
  return {
    status: s.status || 'idle',
    ok: Boolean(s.ok),
    available: Boolean(s.available),
    canApply: Boolean(cfg?.allowSelfUpdate),
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

// ------------------------------------------------------ 网页内的重启 / 升级入口
//
// 这条链路有两个官方扩展点，都只用不碰 dsh 核心：
//
//   register(route)  挂自定义路由（自定义路由在 authorizeIndex 之前命中，自掌响应）：
//                      POST /pwa-launcher/restart        触发一次外部重启
//                      GET  /pwa-launcher/restart-status 前端轮询：新进程起来没有
//                      GET/POST /pwa-launcher/update-check  版本检查结果 / 手动重查
//                      POST /pwa-launcher/update-apply   触发一次外部升级
//
//   NONCE            本次进程的随机指纹，restart-status 里报给前端。前端凭「指纹变了
//                    且新进程 ready」判定重启完成 —— 只看 ready 不够：命令刚发出时
//                    老进程还没退场，它也会答 ready。
//
// 前端不再由这里注入：两个按钮是浏览器半边（lib/client.js）注册进 dsh 的
// conversation.session.header.utilities 槽的。以前那种「往 index.html 塞脚本 +
// 悬浮在右上角 + 探测顶栏控件让位」的写法会盖住 dsh 自己的顶栏按钮，已废弃。

// 为什么是「外部重启」而非进程内 self-restart：插件就跑在被重启的那个 dsh 进程里，让它
// 自己杀自己再原地复活不干净也做不到（这正是自更新要外部脚本的原因）。所以前端只去
// spawn 一个游离于 node 进程树之外的 wscript→launch.ps1，由它 stop→start。

/** 注册自定义路由。只在 Windows + 有端口时调用。 */
function setupRestartUI(ctx, port, installDir, cfg) {
  const state = { restarting: false }

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
        if (req.method === 'GET') return json(res, 200, serializeUpdateState(cfg))
        if (req.method !== 'POST') return json(res, 405, { error: '只接受 GET/POST' })
        // POST = 手动「重新检查」：按需再跑一次（会真连 registry）。没入参就退回返回当前状态。
        if (!lastCheckArgs) return json(res, 200, serializeUpdateState(cfg))
        runUpdateCheck(lastCheckArgs.entryPath, lastCheckArgs.cfg, lastCheckArgs.installDir)
          .catch((error) => log(`手动更新检查异常（已忽略）：${error?.message ?? error}`))
          .finally(() => json(res, 200, serializeUpdateState(cfg)))
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

    // 真正触发一次外部升级。只接受「已检测到的候选版本」，避免被诱导装任意包。
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

  // 后台只读地查一次有没有新版本；安装只由用户在界面上点「升级」才发生。
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
 * 只读地查一次更新（跨通道）。读当前版本 → 问 registry → 列出所有比它新的
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
    log(`发现可更新版本：推荐 ${res.target}（通道 ${res.channel}）；当前应用 ${current}${cliVersion && cliVersion !== current ? `（CLI ${cliVersion}）` : ''}，共 ${res.newer.length} 个更新（安装由用户在界面上点）`)
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
        { _help: 'dsh-pwa-launcher 写入的更新检查结果（只读，不触发安装）。手改会在下次启动被覆盖。', ...pub },
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
