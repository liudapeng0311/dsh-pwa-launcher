# @llsix/dsh-desktop-launcher

把 DeepSeek Harness 变成一个「双击桌面图标就能用」的桌面应用。**仅 Windows**（Win10/11）。

装上这个插件之后，桌面 / 开始菜单上的 **DeepSeek Harness** 图标就不再只是一个
网页快捷方式 —— 双击它会先把 `dsh web` 服务悄悄拉起来，再用浏览器应用窗口把界面打开。

## 安装

```sh
dsh plugin --profile web add @llsix/dsh-desktop-launcher
```

然后重启一次 dsh（Ctrl+C 停掉再跑）。插件会在启动时把启动器部署好、把图标接上。

> **要装发布不足 24 小时的版本，必须写精确版本号。**
> pnpm 11 的 `minimumReleaseAge` 默认 1440 分钟，会把 `@latest` **静默**解析成上一个
> 版本 —— 命令照样以 0 退出，你以为装上了新版本。例如：
> `dsh plugin --profile web add @llsix/dsh-desktop-launcher@1.1.0`

## 卸载

```sh
# 1) 先把图标还原（会把你原来那个浏览器 PWA 快捷方式恢复原样）
powershell -File "$env:LOCALAPPDATA\DeepSeekHarness\scripts\shortcut.ps1" -Action Uninstall

# 2) 再从 profile 移除
dsh plugin --profile web remove @llsix/dsh-desktop-launcher
```

**顺序不要反。** 先移除插件的话，图标会被留在桌面上 —— 它其实还能用（启动器和
`launcher.json` 都还在），但已经没有任何东西会去刷新它了。

## 兼容性

在 **dsh 0.1.5-rc.1 + Node 24 + Edge** 上实测通过。包里的
`dsh.compatibility.dshReleases` 只声明了这一个版本 —— 没有实测过的版本不写进去。

（说明一下：0.1.5-rc.1 这版 dsh **不读**这个字段，目前它只是给未来的插件市场/
清单用的元数据，不代表 dsh 会据此拦截或告警。）

## 它解决的是什么问题

用 Edge / Chrome 把 `http://127.0.0.1:3080/` 「安装为应用」得到的那个桌面图标，
它本质上是一条

```
msedge_proxy.exe --profile-directory=Default --app-id=<id> --app-url=http://127.0.0.1:3080/
```

换句话说，它只是**打开一个地址**。服务没跑的时候，点了就是一个错误页。

而且这不是能绕过的限制：浏览器刻意不允许一个 PWA 快捷方式启动本机进程。
所以「点图标就把项目起来」必须由其他东西来接管那一次点击。

这个插件就是那个东西。它会认出浏览器给你的那个快捷方式，**保留它的图标**，
把目标换成启动器。

## 装上之后发生了什么

```
双击图标
   │
   ├─ wscript.exe <installDir>\launcher.vbs        ← 无窗口入口
   │     └─ powershell ...\scripts\launch.ps1
   │           ├─ 端口上已经有 dsh？ ── 有 ──► 直接开窗
   │           ├─ 被别的程序占了？   ── 是 ──► 弹窗说清楚，不硬闯
   │           └─ 都没 ─► 隐藏启动 dsh web（cwd = 你原来的 workspace）
   │                 ├─ 等到 HTTP 开始应答
   │                 ├─ 从 stdout 日志里抠出本次的 launch token
   │                 └─ 用 msedge_proxy.exe --app-id=... --app-url=<带 token 的地址> 开窗
   │
   └─ 关掉窗口不影响服务，它是以 detach 方式起的
```

## 网页右上角的「真正重启」按钮

页面右上角会有一个悬浮的 ⟳ **重启** 按钮。点一下就把整个 DeepSeek Harness 连根重启一次：
先彻底停掉当前进程（正在跑的任务/会话会一起停），再自动重新拉起服务，当前这个窗口会自己
轮询到新服务就绪并重连刷新 —— 不用再去双击桌面图标，也不用管关窗口只是关窗口这件事。
点之前有二次确认，过程中有遮罩和进度提示。

实现上没有改 dsh 核心、也不依赖 SPA 内部结构，只用 `webServer` 的两个官方扩展点：

```
tapIndex(html)            往真正服务出去的 index.html 末尾注入一段自包含脚本（按钮 + 遮罩 + 轮询）
POST /desktop-launcher/restart         触发一次外部重启（复用 connection 的会话鉴权，未登录返回 401）
GET  /desktop-launcher/restart-status  前端轮询：新进程起来了没有（用进程随机 nonce 区分「老/新」）
```

按钮**不**让 dsh 进程自己重启自己 —— 插件就跑在被重启的那个进程里，自杀再原地复活既不干净
也做不到。它只是 `spawn` 一个游离于 node 进程树之外的 `wscript.exe → restart.vbs → launch.ps1
-Restart -NoOpen`；因为编排进程已变成孤儿，`stop.ps1`（只杀监听端口的 node 及其**存活**后代）
杀不到它，重启不会被自己触发的停止打断。`-NoOpen` 保证不再多开一个窗口，靠当前窗口重连。

> 首次让这版代码生效仍需真正重启一次 dsh（旧的还活着不会热加载新逻辑）：
> `powershell -File "$env:LOCALAPPDATA\DeepSeekHarness\scripts\launch.ps1" -Restart`
> 之后就能用页面右上角的按钮了。

## 有新版本吗？（检查 + 一键自助升级）

dsh 每次启动后，插件会在后台**只读地**查一次 npm registry，把 `latest / next / alpha`
三个通道一起看，凡是有**比你当前更新**的版本就提醒——**默认把选择权交给用户**，不替他决定跟哪条流。
在**重启按钮下方常驻**一个「更新」小控件，状态直接写在上面：`↑ 有新版 x.y.z`（有更新，高亮）/
`更新 · 已忽略 n` / `✓ 已是最新` / `更新（未查到）`。点开面板里有**「重新检查」**按钮（按需真连
registry 再查一次），并列出每个较新版本 + 各自通道，可对某个版本点**「忽略」**；已忽略的也照样列出、
带**「恢复」**——所以即便你把唯一的新版都忽略了，入口仍在、随时能反悔。

**第二期：面板里每个候选版本带「更新到此版本」按钮**，点一下（二次确认后）就真正升级：插件
`spawn` 一个游离于 node 进程树之外的 `wscript → update.vbs → update.ps1`，由它完成
**停服务 → 备份旧版本 → 在 runtime 里 `npm install @deepseek-ai/dsh@<目标> --save-exact` →
校验 `bin.js --version` 与目标一致 → 自动重启并回连当前窗口**；任一步失败就**自动还原备份并重装回
旧版本**（回滚）。为什么在进程外：插件就跑在被升级的那个 dsh 里，不能自己覆盖正在运行的自己。

```
GET  /desktop-launcher/update-check    只读返回最近一次检查结果（含 newer[] 列表，不含令牌）
POST /desktop-launcher/update-check    手动「重新检查」：按需再跑一次（会真连 registry）后返回最新结果
POST /desktop-launcher/update-dismiss  {version, ignored} 忽略 / 恢复提醒某个版本
POST /desktop-launcher/update-apply    {version} 触发一次外部升级（只接受已检测到的候选版本）
%LOCALAPPDATA%\DeepSeekHarness\update-check.json    每次启动重写：检查结果快照
%LOCALAPPDATA%\DeepSeekHarness\update-dismiss.json  你忽略过的版本，跨重启保留（删掉即恢复全部提醒）
%LOCALAPPDATA%\DeepSeekHarness\update-backup\       每次升级前的旧 package.json/lock 备份（回滚用）
%LOCALAPPDATA%\DeepSeekHarness\logs\update.log      升级/回滚过程日志
```

判断「谁比谁新」用一套手写的 semver 2.0 优先级比较（能正确区分 `0.1.5-rc.1 < 0.1.5-rc.2 < 0.1.5 <
0.1.6-alpha.1` 这类预发布顺序），因此**跑在 alpha 上的人不会被提示"降回 latest"**。

> **"当前版本"读的是你真正在跑的应用，不是启动器壳。** dsh 有两棵版本树：CLI 包
> `@deepseek-ai/dsh` 是 npm 精锁的启动器壳（本机 `rc.1`），而实际渲染界面的应用核心 bundle
> `@deepseek-ai/dsh-base` 是 caret 浮动解析的（本机已到 `rc.2`）。徽标里的"当前版本"取
> `dsh-base` 的安装版本（用 `createRequire` 从运行入口解析，走 Node 标准解析含 pnpm 软链，不猜
> 目录布局），CLI 版本只在详情里附带显示。而"可升版本"取 CLI 包 `@deepseek-ai/dsh` 的 dist-tags——
> 因为它的 `latest/next/alpha` 标签是干净的（`dsh-base` 的 `latest` 标签是坏的 `0.0.1-rc.1`，不能用）。

查询走 node 内置 `https` 直连 registry（带超时），**离线 / 超时 / 被墙时静默跳过**，不影响服务，也不弹任何窗。

> 对 dsh 而言，目前 `latest` 本身也是个 rc（`0.1.5-rc.1`），三个通道都是预发布——所以这里与其讲
> "稳定 vs 尝鲜"，不如讲"跟多激进的流"。默认 `all` 模式下，只要你不在最前沿，多半会看到徽标；嫌吵就把
> `updateNotify` 设成 `recommended-only`（只按主通道 `latest` 提醒），或在徽标里把不关心的版本逐个「忽略」。

相关配置（同样写在 `cordis.patch.yml` 的 `config` 里）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `checkForUpdates` | `true` | 关掉则既不查、也不注入徽标、还不注册相关路由 |
| `allowSelfUpdate` | `true` | 允许「更新到此版本」触发外部升级；`false`=只提醒不给升级按钮 |
| `updatePackage` | `@deepseek-ai/dsh` | 拿哪个包的 dist-tags 当「可升版本」来源（CLI 包，标签干净） |
| `updateVersionPackage` | `@deepseek-ai/dsh-base` | 拿哪个包的安装版本当「当前版本」（真正跑的应用核心） |
| `updateChannels` | `[latest, next, alpha]` | 关注哪些通道，顺序=保守→激进，第一个是「推荐」 |
| `updateNotify` | `all` | `all`=任一通道有更新都提醒；`recommended-only`=只按主通道 |
| `updateRegistry` | `https://registry.npmjs.org` | 镜像 / 私有源改这里 |
| `updateCheckTimeoutMs` | `8000` | 单次查询超时 |

## 两个容易踩的点（都已在代码里处理）

**1. 未认证请求返回 401，不是页面。**
dsh 每次启动生成一个新的 launch token，`GET /` 在没 cookie 时返回一个最小的 401。
带 token 访问会 303 跳到干净的 `/` 并种下 30 天有效的签名 cookie。
所以「看页面里有没有 DeepSeek Harness 来判断服务就绪」是错的 —— 401 也是就绪。
`launch.ps1` 用「有没有 HTTP 应答」判断就绪，并主动把 token 带进开窗地址。

**2. 接管过的快捷方式，第二次要找得到。**
接管之后它的目标就不再是 `msedge_proxy.exe` 了，如果第二轮只按「找 PWA 快捷方式」
来判断，就会误判成「没找到」，然后退回备用图标把它覆盖掉。
所以 `shortcut.ps1` 的判定顺序是：**可接管的 PWA 快捷方式 → 已指向启动器的快捷方式 → 新建**。

## 目录

| 位置 | 作用 |
| --- | --- |
| `%LOCALAPPDATA%\DeepSeekHarness\` | 启动器落地目录（快捷方式指向这里，路径稳定） |
| ├─ `launcher.json` | 每次 dsh 启动时由插件重写：node、dsh 入口、端口、workspace |
| ├─ `update-check.json` | 第一期：每次启动重写的一次性更新检查结果（只读，不触发安装） |
| ├─ `shortcut-origin.json` | 你原来那个浏览器 PWA 图标会执行的命令行 + 它的图标 |
| ├─ `launcher.vbs` / `stop.vbs` / `restart.vbs` | 无窗口入口（restart.vbs = 网页重启按钮背后的 stop→start） |
| ├─ `scripts\launch.ps1` | 冷启动 + 开窗 |
| ├─ `scripts\shortcut.ps1` | 接管 / 还原快捷方式 |
| ├─ `scripts\stop.ps1` | 停服务 |
| └─ `logs\desktop.log` | 启动器日志（出问题先看这个） |

## 配置

改 `plugin/cordis.patch.yml` 里 `desktop-launcher` 那一行的 `config`，重启一次 dsh 生效。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `shortcutName` | `DeepSeek Harness` | 图标名字，也是「优先接管哪个」的依据 |
| `adoptBrowserShortcut` | `true` | 接管浏览器给你的 PWA 快捷方式（保留其图标） |
| `desktop` / `startMenu` | `true` | 往哪几个地方放图标 |
| `browser` | `auto` | `auto` / `edge` / `chrome` / `default` |
| `appMode` | `true` | 应用窗口（无地址栏）还是普通标签页 |
| `startTimeoutSec` | `120` | 等服务就绪的上限 |
| `installDir` | `''` | 留空 = `%LOCALAPPDATA%\DeepSeekHarness` |

## 手动操作

```powershell
# 只拉服务不开窗
powershell -File "$env:LOCALAPPDATA\DeepSeekHarness\scripts\launch.ps1" -NoOpen -Visible

# 停服务
powershell -File "$env:LOCALAPPDATA\DeepSeekHarness\scripts\stop.ps1"

# 重新接管 / 还原快捷方式
powershell -File "$env:LOCALAPPDATA\DeepSeekHarness\scripts\shortcut.ps1" -Action Install
powershell -File "$env:LOCALAPPDATA\DeepSeekHarness\scripts\shortcut.ps1" -Action Uninstall
```

## 已知限制

* **仅 Windows。** `package.json` 里声明了 `"os": ["win32"]`，`lib/index.js` 开头
  还有一道运行时守卫 —— 其他系统上装不上，万一装上了也不会做任何事。
* 如果 Edge/Chrome 哪天把 PWA 快捷方式修回原样，下一次 dsh 启动时插件会自动再接管一次。
* **令牌有两个来源**，按可靠性排序：插件在进程内问 `connection` 服务要到的地址
  （写进 `launcher.json` 的 `authUrl`，首选）；`logs\dsh-stdout.log` 里的 token 行（兜底）。
  兜底那条只在「dsh 是被本启动器拉起的」前提下才属于当前进程 —— 你自己手动起的 dsh，
  日志里留的是上一轮的旧令牌，拿它开窗只会得到一个 401 空白页。所以 `authUrl` 是主路径。
* 同时跑多个 dsh 实例（多个 profile / 多个端口）时，`launcher.json` 是**后写覆盖**，
  图标会指向最后启动的那个。
* 接管只认「名字相同」或「`--app-url` 指向当前端口」的 PWA 快捷方式；两者都不匹配就
  自己新建一个，不会去动别人的快捷方式。
