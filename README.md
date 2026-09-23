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

另外网页里会多一个入口：**会话标题右侧**的「⟳ 重启 | 版本」胶囊（见下文）。

## 安装

```sh
dsh plugin --profile web add https://github.com/liudapeng0311/dsh-pwa-launcher/archive/refs/heads/main.tar.gz
```

> **为什么是这个 tarball 直链，而不是 `dsh plugin add dsh-pwa-launcher`？**
> 这个包**还没有发布到 npm**，所以按包名装会失败。用上面的直链即可。
>
> **为什么不用 `github:liudapeng0311/dsh-pwa-launcher`？** pnpm 会把它解析成
> `git+ssh://`，**要求你配好 GitHub SSH key**，否则报 `Host key verification failed`。
> 上面这条不需要 SSH、不需要构建（本包是纯 JS，没有 `prepare` 脚本）。
> 想要「跟到某个版本」的话，把 URL 里的 `main` 换成 tag 名即可。

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

## 会话头部那个胶囊

界面上只有**一个**入口：会话标题右侧的 `⟳ 重启 │ 版本` 胶囊，和 dsh 自己的
「在文件资源管理器中打开工作目录」排在同一行。

> 为什么它长在那里：本插件除了宿主半边，还有一个**浏览器半边**，注册进 dsh 的
> `conversation.session.header.utilities` 槽（open-in-app 的分裂按钮就在同一个槽里）。
> 由 React 跟着顶栏一起排版，所以**天生不会和 dsh 自己的控件抢位置**。
>
> 早期的做法是往 index.html 注入脚本、把按钮悬浮在窗口右上角 —— 那个位置和 dsh 的
> 会话头部右上角（分栏视图按钮）重叠，于是需要一整套「扫描顶栏控件 + 整簇左移让位」
> 的坐标探测来补偿。那套东西已经删掉了，按钮也搬进了槽里。

> **注意**：这个胶囊只在**有会话的时候**存在。dsh 在空白会话（还没开始对话）上会把整个
> 会话头部隐藏，连这个槽一起。所以刚打开应用时看不到它 —— 发一条消息就出来了。

### ⟳ 重启

把整个 DeepSeek Harness **连根重启**：彻底停掉当前进程（正在跑的任务/会话会一起停），
再自动拉起，当前窗口自己轮询到新服务并重连刷新。不用去双击桌面图标，
也不用管「关窗口只是关窗口」这件事。点击前有二次确认，之后会盖一张进度卡。

> 重启完成的判据是**进程指纹变了并且新进程已就绪** —— 光收到 `ready` 不够：
> 命令刚发出时老进程还没退，它也会答 `ready`，只看这个会在服务真正重启前就刷新页面。

### 版本按钮

显示当前状态，**点它就是干活**：

| 显示 | 点一下会做什么 |
|---|---|
| `检查…` | 什么都不做（正在等宿主后台那次检查的结果） |
| `↑ 有新版 x.y.z`（高亮） | **升级**：只有一个候选时直接二次确认；**多个候选时先弹选版卡**（见下） |
| `✓ 已是最新` | 重新检查一遍 |
| `已忽略 n` | 重新检查一遍 |
| `未查到` | 重试一次（多半是网络抖动） |

`allowSelfUpdate: false` 时，`↑ 有新版` 只提醒、不安装，点它退化成「重新检查」。

每次 dsh 启动后，插件在后台**只读地**查一次 npm registry（node 内置 `https` 直连，带超时），
同时看 `latest / next / alpha` 三个通道，凡是有比你当前更新的版本就提醒 ——
**把选择权交给你**，不替你决定跟哪条流。

> **一次查不到不代表没更新。** 到 npm 的连接会偶发抖动（并发请求时更明显，实测大约每 8 个
> 请求会挂掉 1 个），所以检查会**自动重试 3 次**（退避 0.4s / 1.2s），并且**推迟到启动后 6 秒**
> 才发第一个请求 —— 避开 dsh 自己引导 + 部署启动器那阵最忙的时候。失败时按钮的 tooltip 会写出
> **这次的具体原因**（超时 / `ECONNRESET` 等）；**离线时安静跳过**，不影响服务、不弹窗。
> HTTP 4xx 这类确定性失败不重试（重试也没用）。

**宿主怎么算「推荐哪个」。** `target` = `newer` 里第一个未被忽略的项，而 `newer` 是按
`updateChannels` 的顺序（默认 `[latest, next, alpha]`，保守 → 激进）收集、且只收
**严格比当前版本新**的。所以推荐值是「最保守通道里的可更新项」，**不是版本号最大的那个**：

| 情况 | 候选 | 推荐 |
|---|---|---|
| `latest=0.1.6`、`alpha=0.1.7-alpha.2` | 两个 | `0.1.6`（latest 优先） |
| `next=0.1.7-rc.1`、`alpha=0.1.7-alpha.2` | 两个 | `0.1.7-rc.1`（通道更保守，且 semver 里 rc > alpha） |
| `next=0.1.7-rc.1`、`alpha=0.1.8-alpha.1` | 两个 | `0.1.7-rc.1`（通道优先于版本号大小） |
| `latest` 比当前版本旧、`next` 等于当前版本 | 只剩 alpha | alpha |

> 那条「通道优先于版本号」是有意的：`latest/next/alpha` 的排序本身就是对稳定性的表态。
> 但推荐只是推荐 —— 所以有了下面这张选版卡。
>
> `updateNotify: recommended-only` 时 alpha 根本不进候选，也就不会有选版卡。

#### 选版卡：多个候选时自己挑

同时有 rc 和 alpha 可升时，宿主只能替你**推荐一个**（规则：按通道从保守到激进
`latest → next → alpha`，取第一个「比当前版本新且没被忽略」的）。这个推荐**不等于**「最新」
—— 比如 `next=0.1.7-rc.1`、`alpha=0.1.8-alpha.1` 时，推荐的是 rc，尽管按版本号 alpha 更大。
所以候选多于一个时，点版本按钮会先摆出**选版卡**：

```
升级到哪个版本？
当前版本 0.1.5-rc.3。下面是这次查到的全部较新版本，按通道从保守到激进排列。

  ◉ 0.1.7-rc.1       候选通道 · 已选
  ○ 0.1.8-alpha.1    前沿通道

  [ 升级到 0.1.7-rc.1 ]  [ 取消 ]
  预发布版本（rc / alpha）可能不稳定。升级会停掉当前服务，失败会自动回滚。
```

几条行为约定：

* **默认选中宿主推荐的那个**，多候选时不会替你决定，但也不会让你白挑一次；
* 卡片里列的是 `newer` 的**全部**候选，服务端白名单校验的也正是这个列表 —— 所以
  列表里任何一个都装得成，不只是被推荐的那个；
* 「曾忽略」的候选**照样可以选**（只是标一下）。选了它提醒会恢复 —— 装完你就是那个
  版本了，旧版本的忽略项不再匹配；
* 选版期间**不算「进行中」**：重启按钮照常可用，再点一次版本按钮就收起卡片；
* 提交前仍有一次系统确认框（写清目标和当前版本，以及失败会回滚）。

**升级**会真正动手：停服务 → 备份 → `npm install` → 校验 →
自动重启并回连当前窗口；**任何一步失败都会自动回滚**到原来的版本。
整个过程有一张进度卡，超时或失败会把原因写出来（并可收起继续用）。

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
| `installDir` | `''` | 留空 = `%LOCALAPPDATA%\DeepSeekHarness` |
| `checkForUpdates` | `true` | 关掉则既不查、也不注册相关路由（版本按钮会停在「检查…」） |
| `allowSelfUpdate` | `true` | 允许版本按钮一键升级；`false` = 只提醒，点它只重新检查 |
| `updatePackage` | `@deepseek-ai/dsh` | 拿哪个包的 dist-tags 当「可升版本」来源 |
| `updateVersionPackage` | `@deepseek-ai/dsh-base` | 拿哪个包的安装版本当「当前版本」（真正跑的应用核心） |
| `updateChannels` | `[latest, next, alpha]` | 关注哪些通道，顺序 = 保守 → 激进，第一个是「推荐」 |
| `updateNotify` | `all` | `all` = 任一通道有更新都提醒；`recommended-only` = 只按主通道 |
| `updateRegistry` | `https://registry.npmjs.org` | 镜像 / 私有源改这里 |
| `updateCheckTimeoutMs` | `12000` | 单次查询超时；超时按「本次没查到」安静跳过（会自动重试） |

> **为什么「当前版本」默认取 `dsh-base` 而不是 `@deepseek-ai/dsh`？** dsh 有两棵版本树：
> CLI 包 `@deepseek-ai/dsh` 是启动器壳，而实际渲染界面的应用核心是 `@deepseek-ai/dsh-base`，
> 两者版本可能不一致。控件显示的是**你真正在跑的应用**那一个。
> 「可升版本」则取自 CLI 包的 dist-tags（它的 `latest/next/alpha` 标签是干净的）。

> **`avoidAppButtons` 已经没有了。** 那个配置是给早期「悬浮在右上角」的按钮做顶栏避让用的：
> dsh 自己的顶栏控件开始对话后才出现，位置和它们重叠，所以只能靠坐标探测整簇左移。
> 按钮搬进会话头部的槽之后，重叠问题从根上消失，那套探测和这个配置一起删掉了。

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

### 会话头部那个胶囊一直显示「检查…」

它读的是宿主后台那次检查的结果，自己不联网。一直停在「检查…」基本是两种情况：

1. **检查被关掉了。** `checkForUpdates: false` 时宿主不注册 `/pwa-launcher/update-check`，
   按钮拿不到任何结果。改 `cordis.patch.yml` 里那一行再重启。
2. **配置被 GUI 覆盖了。** 在设置里改过本插件的配置时，用户层会压住
   `cordis.patch.yml` 那一层。去插件的设置卡片里确认 `checkForUpdates` 是开的。

### 会话头部没有这个胶囊

它会**注册失败就整体不出现**（渲染不出来时宁可不显示，也不留一个空白按钮）。按顺序查：

1. 页面**完整刷新**过一次没有 —— 浏览器半边是在首次加载页面时随 boot 图一起注册的。
2. 浏览器控制台有没有 `client-modules:` 开头的报错（那是浏览器半边的加载失败）。
3. 会话是否已经存在 —— 这个槽是 **session 作用域**的，空白页（还没有会话）上没有头部，
   自然也不会有这个胶囊。

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
ctx.webServer.register({ path })      注册下面这几条自定义路由
ctx.connection.authorizeIndex(...)    复用 dsh 自己的会话鉴权（未登录返回 401）
ctx.connection.authenticatedUrl(...)  取本次进程的带令牌地址

POST /pwa-launcher/restart         触发一次外部重启
GET  /pwa-launcher/restart-status  前端轮询新进程起来了没有（带进程指纹 nonce）
GET  /pwa-launcher/update-check    后台那次版本检查的结果（含 canApply）
POST /pwa-launcher/update-check    手动重新检查一次（真连 registry）
POST /pwa-launcher/update-dismiss  忽略 / 恢复提醒某个版本
POST /pwa-launcher/update-apply    触发一次外部升级
```

界面上的胶囊走的是另一条路：本包同时是一个**双面包**，`package.json` 里声明了
`dsh.client`，浏览器半边入口是 `./client`（`lib/client.js`）：

```
package.json  "dsh": { "client": { "platform": "web", "inject": [...] } }
              "exports": { "./client": "./lib/client.js" }

lib/client.js   window.__ModuleLoader__.load({ id, factory })   ← 惰性 CJS 工厂
                  └─ ctx.slots.register(conversation.session.header.utilities, …)
```

`lib/client.js` 是**构建产物**，源文件在 `client/src/`：

```sh
node client/build.mjs      # 合并 client/src/*.js → lib/client.js（改完源文件必须跑）
```

> 为什么要有这一步：dsh 的浏览器半边不是普通 ESM，而是「惰性 CJS 工厂」——
> 外层必须是 `window.__ModuleLoader__.load({ id, factory })`，模块体在工厂闭包里、
> import 变成显式 `require(...)`。仓库内那些 TS 插件靠 `tsdown` 的 `clientBundle`
> preset 产出这个形状，而那个 preset **没有随包发布**（见 `dsh-client-modules` 的
> README：「仓库外的插件得自己复现这个构建」）。这里用 30 行 node 脚本自己复现，
> 不引任何第三方构建依赖。
>
> 构建器只允许 `require('react')` 一个模块 —— 它在浏览器平台种子表
> （`PLATFORM_MODULES`）里。其它 `@deepseek-ai/dsh-client-ui-*` 包虽然在种子表里，
> 但它们的导出名不在本包能核对的契约里，用它们等于把「按钮能不能画出来」
> 赌在别的包的内部实现上，所以这个控件**只用 React + 自己的 CSS**。

**为什么不原地重启/升级自己**：插件就跑在被重启的那个 dsh 进程里，自杀再原地复活不干净
也做不到（Windows 上覆盖正在运行的文件还会撞锁）。所以它 `spawn` 一个游离于 node
进程树之外的 `wscript → *.vbs → *.ps1` 来编排，这样才停得掉自己、也换得掉自己。

## 兼容性

实测通过的环境：**dsh 0.1.5-rc.1 / 0.1.5-rc.2 + Node 24 + Edge**（Windows 10/11）。

> 这一行是**给人看的**，不是机器读的声明。`package.json` 里不再写 `dsh.compatibility` ——
> 那个字段**不在 DSH 的 manifest schema 里**（官方 `dsh-package-manifest` 只定义
> `bundle` / `profile` / `client` / `configTrees` / `sessionFormatMigration` / `moduleFallback`），
> 整个 DSH runtime 里没有任何代码读它，写了也只是装饰，反而容易让人以为装错了版本会被拦住。
>
> 另外注意「dsh 版本」本身有两棵树：CLI 壳 `@deepseek-ai/dsh` 和实际渲染界面的应用核心
> `@deepseek-ai/dsh-base` / `dsh-web-app`，两者可以不一致（壳 rc.1 配应用 rc.2 是实测存在的
> 组合）。上面的兼容环境按**应用核心**记。

## 已知限制

* **仅 Windows。** `package.json` 声明了 `"os": ["win32"]`，代码里还有一道运行时守卫 ——
  其他系统上装不上，万一装上了也不会做任何事。
* **尚未发布到 npm。** 所以 `dsh plugin add dsh-pwa-launcher` 这种按包名的写法现在会失败，
  请用上面「安装」一节里的 tarball 直链。
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
npm test              # 全部：构建浏览器半边 → 四组测试
npm run build:client  # 只重建 lib/client.js（改了 client/src/ 之后必须跑）
npm run test:plugin   # 浏览器半边：胶囊、词典、点击、重启/升级状态机（26 项）
npm run test:host     # 宿主路由：注册、鉴权、握手字段、版本白名单（11 项）
npm run test:retry    # 更新重试与 semver 白名单（12 项）
npm run test:update   # 更新探测（PS 5.1，7 项）
```

测试的取法是「截获插件**真正加载**的那段代码，放进假环境里跑」，
以及「真起一次探测流程看它认不认得出装法」——验的是实际会跑到用户机器上的代码，
而不是对它的复述。

`test/plugin-test.mjs` 刻意**不装 React / jsdom**：本包没有第三方依赖，测试也不该为了
跑一次就引入它们。里面自带一层够用的 React 替身（`createElement` 返回可遍历的节点树，
函数组件当场调用，`useState` / `useEffect` / `useRef` 在 render 期间同步落实），
验的是 `lib/client.js` 本身。四个已经踩过的坑写在文件注释里，别改回去：

* `check()` **必须支持异步**——一半用例要走 promise，同步版本会把断言失败变成
  未处理的 rejection，测试照样报「全部通过」。
* 沙箱里 `window` 和 `globalThis` **必须是同一个对象**（浏览器就是这样）。
  搭成两个对象的话，`globalThis.__DSH_DL_NONCE__` 读到 `undefined`，
  「指纹没变就不跳转」那条用例会**假装通过**。
* `createElement` **必须当场调用函数组件**，否则进度卡那类断言一直在看一个函数对象。
* 等异步要用 `fire(定时器)` **await 定时器回调返回的 promise**，别用「空转 N 个微任务」
  去赌链条长度。

`test/host-route-test.mjs` 需要一个「启动器已就位」的假安装目录（里面放空的
`restart.vbs` / `update.vbs`），否则断言会撞在 503 上、根本走不到要验的逻辑。

## License

[MIT](LICENSE) © 2026 llsix
