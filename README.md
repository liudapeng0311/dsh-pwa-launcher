# dsh-pwa-launcher

**把 DeepSeek Harness 变成真正的桌面应用：双击图标就能用。**

Windows 10/11 · [MIT](LICENSE) · dsh 插件

---

## 它解决什么问题

你可能已经把 DeepSeek Harness 用 Edge/Chrome「安装为应用」固定到了桌面或任务栏。
那个图标看着像个 App，但它本质上只是一条命令：

```
msedge_proxy.exe --profile-directory=Default --app-id=<id> --app-url=http://127.0.0.1:3080/
```

**它只是打开一个地址。** 服务没跑的时候，你点下去看到的是一个错误页。

而这不是能绕过去的限制 —— 浏览器**刻意不允许**一个 PWA 快捷方式启动本机进程。
所以「点图标就把服务拉起来」这件事，必须由别的东西接管那一次点击。

这个插件就是那个东西。它会**认出浏览器给你的那个快捷方式**，保留它的图标和外观，
只把「要执行什么」换成启动器。你看到的东西一点没变，双击的行为变了：

> 服务没起 → 悄悄拉起来 → 等它就绪 → 用浏览器应用窗口打开界面
> 服务已在 → 直接开窗（毫秒级）
> 端口被别人占了 → 弹窗说清楚，不硬闯

## 装它之前 vs 之后

| | 双击桌面图标 |
|---|---|
| **装之前** | 服务没跑 → 错误页 |
| **装之后** | 服务没跑 → 自动拉起 → 界面打开；窗口关了服务还在 |

另外网页右上角会多两个小控件：**⟳ 重启** 和 **更新**（见下文）。

## 安装

**目前从 GitHub 装**（尚未发布到 npm）：

```sh
dsh plugin --profile web add https://github.com/liudapeng0311/dsh-pwa-launcher/archive/refs/heads/main.tar.gz
```

> 用这个 tarball 直链而不是 `github:owner/repo` —— 后者会被 pnpm 解析成
> `git+ssh://`，**要求你配好 GitHub SSH key**，否则报 `Host key verification failed`。
> 上面这条不需要 SSH、不需要构建（本包是纯 JS，没有 `prepare` 脚本）。

装完**重启一次 dsh**（Ctrl+C 停掉再跑）。插件会在启动时把启动器部署好、把图标接上。

首次生效后，桌面/开始菜单上就会出现 **DeepSeek Harness** 图标。

```sh
# 如果你本来就是手动跑 dsh 的
dsh web
```

## 卸载

```sh
# 1) 先把快捷方式还原（会把你原来那个浏览器 PWA 图标恢复原样）
powershell -File "$env:LOCALAPPDATA\DeepSeekHarness\scripts\shortcut.ps1" -Action Uninstall

# 2) 再从 profile 移除
dsh plugin --profile web remove dsh-pwa-launcher
```

**顺序不要反。** 先移除插件的话，图标会留在桌面上 —— 它其实还能用（启动器和
`launcher.json` 都还在），但已经没有任何东西会去刷新它了。

## 网页右上角的两个控件

### ⟳ 重启

把整个 DeepSeek Harness **连根重启**：彻底停掉当前进程（正在跑的任务/会话会一起停），
再自动拉起，当前窗口自己轮询到新服务并重连刷新。不用去双击桌面图标，
也不用管「关窗口只是关窗口」这件事。点击前有二次确认。

### 更新

每次 dsh 启动后，插件在后台**只读地**查一次 npm registry，同时看
`latest / next / alpha` 三个通道，凡是有比你当前更新的版本就提醒 ——
**把选择权交给你**，不替你决定跟哪条流。状态直接写在控件上：

`↑ 有新版 x.y.z`（高亮）· `更新 · 已忽略 n` · `✓ 已是最新` · `更新（未查到）`

点开面板可以**「重新检查」**、看每个候选版本属于哪个通道、对不关心的版本点**「忽略」**
（已忽略的也照样列出、带**「恢复」**，所以随时能反悔）。面板支持
**再点一次按钮 / 点页面别处 / 按 Esc** 三种方式关闭。

**「更新到此版本」**会真正升级：停服务 → 备份 → `npm install` → 校验 →
自动重启并回连当前窗口；**任何一步失败都会自动回滚**到原来的版本。

> **它会自己判断你的 dsh 是怎么装的**，因为「在哪跑 npm install」因装法而异：
> * **本地 npm 树**（npx 缓存、本地工程、锁版本的本地安装）——从运行入口往上找到
>   **声明了 `@deepseek-ai/dsh` 依赖**的那个 `package.json`，在它那里装
> * **全局安装**（`npm i -g`）——用 `npm install -g`
>
> 两种都认不出时会**明确报错并告诉你怎么手动装**，绝不会猜一个目录乱装。
>
> 校验以**运行入口自己的 `--version`** 为准，而不是只看 `package.json` 里的版本号 ——
> 前者才是「你实际在跑什么」。

## 配置

改本包里的 `cordis.patch.yml` 中 `pwa-launcher` 那一行的 `config`，重启一次 dsh 生效。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `shortcutName` | `DeepSeek Harness` | 图标名字，也是「优先接管哪个」的依据 |
| `adoptBrowserShortcut` | `true` | 接管浏览器给你的 PWA 快捷方式（保留其图标）。`false` = 自己新建一个 |
| `desktop` / `startMenu` | `true` | 往哪几个地方放图标 |
| `browser` | `auto` | `auto` / `edge` / `chrome` / `default` |
| `appMode` | `true` | 应用窗口（无地址栏，和 PWA 一样）还是普通标签页 |
| `startTimeoutSec` | `120` | 等服务就绪的上限 |
| `avoidAppButtons` | `true` | 顶栏避让：dsh 顶栏控件出现时把两个控件左移让开，消失后回原位 |
| `installDir` | `''` | 留空 = `%LOCALAPPDATA%\DeepSeekHarness` |
| `checkForUpdates` | `true` | 关掉则既不查、也不注入更新控件、还不注册相关路由 |
| `allowSelfUpdate` | `true` | 允许「更新到此版本」触发外部升级；`false` = 只提醒、不给升级按钮 |
| `updatePackage` | `@deepseek-ai/dsh` | 拿哪个包的 dist-tags 当「可升版本」来源 |
| `updateVersionPackage` | `@deepseek-ai/dsh-base` | 拿哪个包的安装版本当「当前版本」（真正跑的应用核心） |
| `updateChannels` | `[latest, next, alpha]` | 关注哪些通道，顺序 = 保守 → 激进，第一个是「推荐」 |
| `updateNotify` | `all` | `all` = 任一通道有更新都提醒；`recommended-only` = 只按主通道 |
| `updateRegistry` | `https://registry.npmjs.org` | 镜像 / 私有源改这里 |
| `updateCheckTimeoutMs` | `12000` | 单次查询超时；超时按「本次没查到」安静跳过 |

> **为什么「当前版本」默认取 `dsh-base` 而不是 `@deepseek-ai/dsh`？** dsh 有两棵版本树：
> CLI 包 `@deepseek-ai/dsh` 是启动器壳，而实际渲染界面的应用核心是 `@deepseek-ai/dsh-base`，
> 两者版本可能不一致。控件显示的是**你真正在跑的应用**那一个。
> 「可升版本」则取自 CLI 包的 dist-tags（它的 `latest/next/alpha` 标签是干净的）。

> **顶栏避让。** dsh 自己的顶栏控件（文件、窗口等）是**开始对话之后**才出现的，
> 位置正好和这两个控件重叠。所以它们会自己探测：被占用就整簇左移让开，
> 探测不到就回到贴右原位。判定不认 dsh 的内部 class（版本一变就会失效），
> 而是问浏览器「右上角这块地方归谁」，所以对 dsh 升级是稳的。

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

## 出问题先看日志

```
%LOCALAPPDATA%\DeepSeekHarness\logs\desktop.log    启动器（双击图标那条链路）
%LOCALAPPDATA%\DeepSeekHarness\logs\update.log     升级 / 回滚
%LOCALAPPDATA%\DeepSeekHarness\launcher.json       当前启动参数（每次 dsh 启动重写）
```

## 它内部怎么做的

```
双击图标
   │
   ├─ wscript.exe <installDir>\launcher.vbs        ← 无窗口入口
   │     └─ powershell ...\scripts\launch.ps1
   │           ├─ 端口上已经有 dsh？ ── 有 ──► 直接开窗
   │           ├─ 被别的程序占了？   ── 是 ──► 弹窗说清楚，不硬闯
   │           └─ 都没 ─► 隐藏启动 dsh web（cwd = 你原来的 workspace）
   │                 ├─ 等到 HTTP 开始应答
   │                 └─ 用 msedge_proxy.exe --app-id=... --app-url=<带令牌的地址> 开窗
   │
   └─ 关掉窗口不影响服务，它是以 detach 方式起的
```

网页里那两个控件只用 dsh 的**官方扩展点**（`webServer` + `connection` 两个服务，
不 import 任何 dsh 内部包），没有改 dsh 核心、也不依赖前端内部结构
（所以 dsh 升级不会把它们弄坏）：

```
ctx.webServer.tapIndex(html)          往真正服务出去的 index.html 注入自包含脚本
ctx.webServer.register({ path })      注册下面这几条自定义路由
ctx.connection.authorizeIndex(...)    复用 dsh 自己的会话鉴权（未登录返回 401）
ctx.connection.authenticatedUrl(...)  取本次进程的带令牌地址

POST /pwa-launcher/restart         触发一次外部重启
GET  /pwa-launcher/restart-status  前端轮询新进程起来了没有
POST /pwa-launcher/update-apply    触发一次外部升级
```

**为什么不原地重启/升级自己**：插件就跑在被重启的那个 dsh 进程里，自杀再原地复活不干净
也做不到（Windows 上覆盖正在运行的文件还会撞锁）。所以它 `spawn` 一个游离于 node
进程树之外的 `wscript → *.vbs → *.ps1` 来编排，这样才停得掉自己、也换得掉自己。

## 兼容性

在 **dsh 0.1.5-rc.1 + Node 24 + Edge** 上实测通过。包里的
`dsh.compatibility.dshReleases` 只声明了这一个版本 —— **没有实测过的版本不写进去**。

## 已知限制

* **仅 Windows。** `package.json` 声明了 `"os": ["win32"]`，代码里还有一道运行时守卫 ——
  其他系统上装不上，万一装上了也不会做任何事。
* **尚未发布到 npm**，只能从 GitHub 装（见「安装」）。因此
  `dsh plugin add dsh-pwa-launcher` 这种写法现在会失败。
* 如果 Edge/Chrome 哪天把 PWA 快捷方式改回原样，下一次 dsh 启动时插件会**自动再接管一次**。
* 同时跑多个 dsh 实例（多 profile / 多端口）时，`launcher.json` 是**后写覆盖**，
  图标会指向最后启动的那个。
* 接管只认「名字相同」或「`--app-url` 指向当前端口」的 PWA 快捷方式；两者都不匹配就
  自己新建一个，**不会去动别人的快捷方式**。
* 自助升级覆盖「本地 npm 树」与「`npm i -g` 全局安装」两种；认不出的装法会明确报错并
  提示你手动 `npm install @deepseek-ai/dsh@<版本>`。**只提醒、给版本号**这部分不受影响。

### 关于开窗用的令牌

dsh 每次启动生成一个新的 launch token，未认证请求返回 **401**（不是错误页，
所以「看到 401」就代表服务已经就绪）。插件优先在**进程内**直接向 `connection`
服务要带令牌的地址（写进 `launcher.json`，首次双击图标前可能还没有这个文件）：

* **主路径**：`launcher.json` 里的带令牌地址 —— 永远和当前进程一致。
* **兜底**：`logs\dsh-stdout.log` 里的 token 行。这条只在「dsh 是被本启动器拉起的」
  前提下才属于当前进程 —— 你自己手动起的 dsh，日志里留的是**上一轮的旧令牌**，
  拿它开窗只会得到一个 401 空白页。

另一个容易踩的点：**接管过的快捷方式，第二次还要找得到。** 接管之后它的目标不再是
`msedge_proxy.exe`，所以判定顺序是「可接管的 PWA 快捷方式 → 已指向启动器的快捷方式 → 新建」。
否则第二轮会误判成「没找到」，退回备用图标把 Edge 给你的图标覆盖掉。

原始命令行（以及那个图标的位置）记在 `launcher.json` 同目录的 `shortcut-origin.json` 里 ——
卸载时就是靠它还原成原样。

## 开发

```sh
npm test          # 客户端注入脚本（假 DOM，28 项）+ 更新探测逻辑（PS 5.1，7 项）
npm run test:client
npm run test:update
```

测试的取法是「截获插件**真正注入**的那段脚本，放进假 DOM 里跑」，
以及「真起一次探测流程看它认不认得出装法」——验的是实际会跑到用户机器上的代码，
而不是对它的复述。

## License

[MIT](LICENSE) © 2026 llsix
