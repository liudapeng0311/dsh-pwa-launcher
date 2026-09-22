<#
    launch.ps1 —— 双击桌面图标之后真正干活的那个脚本。

    由 launcher.vbs 静默拉起（完全无窗口）。顺序：

      1. 读 launcher.json —— 端口 / node 路径 / dsh 入口 / 启动目录，
         这些是插件在 dsh 启动时写下来的，所以这里不需要猜任何东西
      2. 探测端口：
           - 已经有 dsh 在服务   -> 跳过启动，直接开窗
           - 被别人的程序占了     -> 弹窗讲清楚，不硬闯
           - 空着                -> 进入下一步
      3. 隐藏启动 dsh web 服务（cwd = 原来的 workspace），
         stdout 落到 logs\dsh-stdout.log
      4. 轮询到 HTTP 服务开始应答为止
      5. 拿到本次进程的带令牌地址（优先用插件写进 launcher.json 的 authUrl，
         拿不到才退回读 stdout 日志）
      6. 开窗。优先复刻你「安装到桌面」那个浏览器 PWA 原本的启动方式
         （msedge_proxy.exe --app-id=...），并把令牌地址塞进 --app-url，
         让浏览器顺手把登录 cookie 种下来。

    第 5、6 步是这个项目里最容易被忽略的一环：
    dsh 每次启动都会生成一个新的 launch token，未认证的请求一律 401。
    第一次带着 token 访问会 303 跳到干净的 / 并种下 30 天有效的签名 cookie。
    所以「用 title 判断服务是否就绪」是错的 —— 401 也是就绪。

    这个脚本不常驻：开完窗口就退出，服务是被 detach 的，关掉浏览器不影响它。

    手动调试：
        powershell -NoProfile -ExecutionPolicy Bypass -File launch.ps1 -Visible
        powershell -NoProfile -ExecutionPolicy Bypass -File launch.ps1 -NoOpen
        powershell -NoProfile -ExecutionPolicy Bypass -File launch.ps1 -Restart
#>

[CmdletBinding()]
param(
    [switch]$NoOpen,      # 只拉服务，不开窗口
    [switch]$Visible,     # 日志同时打到控制台
    [switch]$Restart,     # 先停掉现有服务再起（换端口/换参数时用）
    [switch]$NoSplash     # 不弹原生加载窗（网页重启按钮已自带提示卡，避免两个弹框叠一起）
)

# 兼容 Windows PowerShell 5.1：不使用 ?? / ?. / 三元运算符
$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Split-Path -Parent $ScriptDir
$LogDir     = Join-Path $InstallDir 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$script:LogFile     = Join-Path $LogDir 'desktop.log'
$script:VisibleMode = [bool]$Visible

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -Path $script:LogFile -Value $line -Encoding UTF8 } catch { }
    if ($script:VisibleMode) { Write-Host $line }
}

function Show-Popup {
    param(
        [string]$Text,
        [string]$Title = 'DeepSeek Harness',
        [int]$Icon = 48          # 16=错误 48=警告 64=信息
    )
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup($Text, 0, $Title, $Icon) | Out-Null
    } catch { }
}

# ---------------------------------------------------------------- 配置

$ConfigFile = Join-Path $InstallDir 'launcher.json'
if (-not (Test-Path $ConfigFile)) {
    $msg = "找不到 launcher.json：`n$ConfigFile`n`n" +
           "这个文件由 dsh-pwa-launcher 插件在 dsh 每次启动时写入。" +
           "先启动一次 dsh（插件会重写它），或重新安装插件。"
    Write-Log "缺少 launcher.json" 'ERROR'
    Show-Popup -Text $msg -Icon 16
    exit 1
}

$cfg = $null
try {
    $cfg = Get-Content -Path $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-Log "launcher.json 解析失败：$($_.Exception.Message)" 'ERROR'
    Show-Popup -Text "launcher.json 损坏了：`n$ConfigFile" -Icon 16
    exit 1
}

$Port       = [int]$cfg.port
$InitUrl    = "http://127.0.0.1:$Port/"
$TimeoutSec = [int]$cfg.startTimeoutSec
if ($TimeoutSec -le 0) { $TimeoutSec = 120 }

$Workspace = [string]$cfg.workspace
if ([string]::IsNullOrWhiteSpace($Workspace) -or -not (Test-Path $Workspace)) {
    $Workspace = $InstallDir
}

$NodeExe  = [string]$cfg.nodePath
$DshEntry = [string]$cfg.dshEntry
$DshArgs  = @($cfg.dshArgs)
if ($DshArgs.Count -eq 0) { $DshArgs = @('web') }

$StdoutLog = Join-Path $LogDir 'dsh-stdout.log'
$StderrLog = Join-Path $LogDir 'dsh-stderr.log'

Write-Log "---- 启动请求：port=$Port node=$NodeExe entry=$DshEntry ----"

# PowerShell 5.1 的一个坑：进程环境里存在「仅大小写不同」的重复变量名时，
# Start-Process 带 -RedirectStandardOutput 会抛 ArgumentException
#（字典中的关键字 http_proxy 所添加的关键字 HTTP_PROXY）。
# 装了代理工具（Clash / v2ray 之类）的机器上 http_proxy / HTTP_PROXY /
# https_proxy / HTTPS_PROXY 四组常常同时存在，一旦命中就必然抛这个异常。
# Windows 的环境变量本身不区分大小写，去掉重复项对语义没有任何影响。
function Repair-EnvironmentDuplicates {
    $seen = @{}
    $dropped = @()
    foreach ($varName in @([System.Environment]::GetEnvironmentVariables('Process').Keys)) {
        $key = $varName.ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
            try {
                [System.Environment]::SetEnvironmentVariable($varName, $null, 'Process')
                $dropped += $varName
            } catch { }
        } else {
            $seen[$key] = $varName
        }
    }
    if ($dropped.Count -gt 0) {
        Write-Log "环境去重，移除大小写重复项：$($dropped -join ', ')"
    }
}

Repair-EnvironmentDuplicates

# ---------------------------------------------------------------- 探测

# 端口上有没有 HTTP 服务在应答。
#
# 注意：这里**不能**去看页面内容。dsh 的未认证请求一律返回 401（一个 401 之外的
# 什么都没有的最小响应），所以「响应体里有 DeepSeek Harness」永远不成立。
# 只要有 HTTP 应答 —— 200、303、401 都算 —— 说明服务已经绑上并开始工作了。
function Test-DshAlive {
    param([int]$Port, [int]$TimeoutMs = 2000)
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/")
        $req.Method = 'GET'
        $req.Timeout = $TimeoutMs
        $req.ReadWriteTimeout = $TimeoutMs
        $req.AllowAutoRedirect = $false
        $req.Proxy = $null                 # 本机地址不走系统代理，否则代理开着时会误判
        $req.UserAgent = 'dsh-pwa-launcher'
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch [System.Net.WebException] {
        # 401 / 403 会走到这里，但 Exception.Response 非空 = 服务确实在应答
        if ($_.Exception.Response) { return $true }
        return $false
    } catch {
        return $false
    }
}

function Get-ListenerProcess {
    param([int]$Port)
    $result = @()
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
            if ($proc) {
                $result += [pscustomobject]@{
                    Id   = $proc.Id
                    Name = $proc.ProcessName
                }
            }
        }
    } catch { }
    return $result
}

# 服务起来之后重读 launcher.json 里的 authUrl。
#
# 为什么不能直接用脚本开头读到的那份：冷启动时那份是「上一个 dsh 进程」写的，
# 令牌已经失效。插件会在自己的启动流程里把新的写进去，所以要轮询等它落盘。
# 这也是比读日志更可靠的来源 —— 日志里那条 token 行只在「dsh 是被本启动器
# 拉起的」前提下才属于当前进程。
function Get-ConfigAuthUrl {
    param([string]$ConfigPath, [int]$MaxWaitSec = 6)
    $deadline = (Get-Date).AddSeconds($MaxWaitSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $fresh = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $u = [string]$fresh.authUrl
            if (-not [string]::IsNullOrWhiteSpace($u)) { return $u }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    return ''
}

# 从 dsh 的 stdout 里抠出本次进程的 launch token。
# 那行长这样：  dsh web: http://127.0.0.1:3080/?token=XXXX (LAN: ...)
function Get-LaunchToken {
    param([string]$LogPath, [int]$MaxWaitSec = 20)
    $deadline = (Get-Date).AddSeconds($MaxWaitSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $LogPath) {
            try {
                # dsh 还在写这个文件，可能拿不到独占读；拿不到就下一轮再试
                $text = Get-Content -Path $LogPath -Raw -Encoding UTF8 -ErrorAction Stop
                $m = [regex]::Match($text, 'token=([A-Za-z0-9_\-\.]+)')
                if ($m.Success) { return $m.Groups[1].Value }
            } catch { }
        }
        Start-Sleep -Milliseconds 300
    }
    return $null
}

# ---------------------------------------------------------------- 启动服务

function Start-DshServer {
    if (-not (Test-Path $NodeExe)) {
        throw "找不到 node.exe：$NodeExe`n`n插件在每次 dsh 启动时会重写 launcher.json，" +
              "重新启动一次 dsh 通常就能修好。"
    }
    if (-not (Test-Path $DshEntry)) {
        throw "找不到 dsh 入口：$DshEntry`n`n可能是 dsh 升级或搬走了。重新启动一次 dsh 即可刷新。"
    }

    foreach ($f in @($StdoutLog, $StderrLog)) {
        if (Test-Path $f) {
            try {
                if ((Get-Item $f).Length -gt 5MB) {
                    Move-Item -Path $f -Destination "$f.old" -Force
                } else {
                    Remove-Item $f -Force
                }
            } catch { }
        }
    }

    $arguments = @('"' + $DshEntry + '"') + $DshArgs + @('--no-open', '--port', "$Port")

    Write-Log "拉起服务：$NodeExe $($arguments -join ' ')  (cwd=$Workspace)"

    $proc = Start-Process -FilePath $NodeExe `
                          -ArgumentList $arguments `
                          -WorkingDirectory $Workspace `
                          -WindowStyle Hidden `
                          -RedirectStandardOutput $StdoutLog `
                          -RedirectStandardError $StderrLog `
                          -PassThru
    return $proc
}

# ---------------------------------------------------------------- 打开窗口

function Get-DefaultBrowserExe {
    try {
        $choice = Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' -ErrorAction Stop
        $progId = $choice.ProgId
    } catch {
        return $null
    }
    if ([string]::IsNullOrWhiteSpace($progId)) { return $null }
    foreach ($hive in @('HKCU:\SOFTWARE\Classes', 'HKLM:\SOFTWARE\Classes')) {
        try {
            $cmd = (Get-ItemProperty -Path (Join-Path $hive "$progId\shell\open\command") -ErrorAction Stop).'(default)'
            if ($cmd) {
                if ($cmd -match '^\s*"([^"]+)"') { return $Matches[1] }
                if ($cmd -match '^\s*(\S+?\.exe)') { return $Matches[1] }
            }
        } catch { }
    }
    return $null
}

function Find-BrowserExe {
    param([string]$Kind)
    if ($Kind -eq 'edge') {
        foreach ($p in @(
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
            "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
        )) { if (Test-Path $p) { return $p } }
    }
    if ($Kind -eq 'chrome') {
        foreach ($p in @(
            "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
        )) { if (Test-Path $p) { return $p } }
    }
    return $null
}

# shortcut.ps1 在接管浏览器快捷方式时，会把「原本那个图标会执行的命令行」
# 存进 shortcut-origin.json。用它开窗 = 和你点原生 PWA 图标的效果完全一致。
function Get-ShortcutOrigin {
    $path = Join-Path $InstallDir 'shortcut-origin.json'
    if (-not (Test-Path $path)) { return $null }
    try {
        return (Get-Content -Path $path -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        Write-Log "shortcut-origin.json 解析失败，退回普通应用窗口" 'WARN'
        return $null
    }
}

function Open-DshWindow {
    param([string]$Url)

    $kind = ([string]$cfg.browser).ToLowerInvariant()
    $wantAppMode = [bool]$cfg.appMode

    # 路径一：你装过浏览器 PWA —— 复刻它原本的启动方式，只把要打开的地址
    # 换成带 token 的那一个，让浏览器顺手种下 cookie。
    $origin = Get-ShortcutOrigin
    if ($origin -and $origin.proxyExe -and (Test-Path $origin.proxyExe)) {
        $proxyArgs = @()
        foreach ($a in @($origin.proxyArgs)) {
            if ([string]::IsNullOrWhiteSpace($a)) { continue }
            if ($a -like '--app-url=*') { continue }        # 用下面拼好的替换
            $proxyArgs += $a
        }
        if ($wantAppMode) {
            $proxyArgs += "--app-url=$Url"
        } else {
            # 不想用应用窗口：还是走 PWA，但让它自己导航
            $proxyArgs += "--app-url=$Url"
        }
        Write-Log "用浏览器自己的应用入口开窗：$($origin.proxyExe) $($proxyArgs -join ' ')"
        Start-Process -FilePath $origin.proxyExe -ArgumentList $proxyArgs | Out-Null
        return
    }

    # 路径二：没装过 PWA，手动开一个应用窗口
    $exe = $null
    if ($kind -eq 'edge') {
        $exe = Find-BrowserExe 'edge'
    } elseif ($kind -eq 'chrome') {
        $exe = Find-BrowserExe 'chrome'
    } elseif ($kind -eq 'default') {
        $exe = $null
    } else {
        # auto：只有当默认浏览器本身是 Chromium 系时，才用应用窗口模式，
        # 免得在 Chrome/Edge 里开出一个「小号」、丢掉你原本的登录态。
        $defaultExe = Get-DefaultBrowserExe
        if ($defaultExe) {
            $base = [System.IO.Path]::GetFileName($defaultExe).ToLowerInvariant()
            if ($base -eq 'msedge.exe' -or $base -eq 'chrome.exe') { $exe = $defaultExe }
        }
        if (-not $exe) { Write-Log "默认浏览器不是 Chromium 系（$defaultExe），改为直接打开" 'INFO' }
    }

    if ($exe -and (Test-Path $exe)) {
        if ($wantAppMode) {
            Write-Log "打开应用窗口：$exe --app=$Url"
            Start-Process -FilePath $exe -ArgumentList "--app=$Url" | Out-Null
        } else {
            Write-Log "打开标签页：$exe $Url"
            Start-Process -FilePath $exe -ArgumentList $Url | Out-Null
        }
    } else {
        Write-Log "交给默认浏览器打开：$Url"
        Start-Process $Url | Out-Null
    }
}

function Get-LogTail {
    param([string]$Path, [int]$Lines = 12)
    if (-not (Test-Path $Path)) { return '' }
    try {
        return ((Get-Content -Path $Path -Tail $Lines -Encoding UTF8 -ErrorAction Stop) -join "`r`n")
    } catch {
        return ''
    }
}

# ---------------------------------------------------------------- 加载提示窗
#
# 冷启动要等好几秒，这期间屏幕毫无动静 —— 用户以为「没反应」就会去重复点图标。
# 这个无边框置顶小窗在等待期间告诉用户「正在启动，稍等」。要点：
#   - 非阻塞：靠 Application::DoEvents() 在主流程的就绪轮询里泵消息让它重绘 + 跑马灯动画，
#     绝不用 ShowDialog —— 那会卡在后面「开浏览器窗口」那一步之前。
#   - 兜底不致命：创建/刷新/关闭任何一步失败都静默吞掉。加载提示绝不能变成新的报错来源，
#     最坏情况就是退回原来的无提示行为，服务照样起、窗照样开。
#   - 只在真的要等时才弹（alreadyUp 会瞬间通过轮询，不弹，免得闪一下）。

function New-SplashWindow {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing

        $form = New-Object System.Windows.Forms.Form
        $form.FormBorderStyle  = [System.Windows.Forms.FormBorderStyle]::None
        $form.TopMost          = $true
        $form.ShowInTaskbar    = $false
        $form.StartPosition    = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.BackColor        = [System.Drawing.Color]::White
        $form.Size             = New-Object System.Drawing.Size(380, 84)
        $form.ControlBox       = $false
        $form.MinimizeBox      = $false
        $form.MaximizeBox      = $false

        # 无边框白卡在浅色桌面上会「糊」成一块，用 Paint 描一条浅灰边线定形。
        $form.Add_Paint({
            param($sender, $e)
            $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(214, 216, 222), 1)
            try {
                $r = $sender.ClientRectangle
                $e.Graphics.DrawRectangle($pen, 0, 0, ($r.Width - 1), ($r.Height - 1))
            } finally {
                $pen.Dispose()
            }
        })

        # 左侧图标：优先用桌面快捷方式实际用的那个图标（记在 shortcut-origin.json 的 icon 里，
        # 也就是浏览器 PWA 的黑色鲸鱼），保证加载窗和桌面一致；读不到再退回自带的 dsh.ico。
        $textX = 22
        $iconPath = $null
        try {
            $originFile = Join-Path $InstallDir 'shortcut-origin.json'
            if (Test-Path $originFile) {
                $origin = Get-Content $originFile -Raw -Encoding UTF8 | ConvertFrom-Json
                $loc = [string]$origin.icon
                if ($loc) {
                    $p = ($loc -split ',')[0].Trim().Trim('"')
                    $p = [System.Environment]::ExpandEnvironmentVariables($p)
                    if (Test-Path $p) { $iconPath = $p }
                }
            }
        } catch { }
        if (-not $iconPath) {
            $fallback = Join-Path $InstallDir 'dsh.ico'
            if (Test-Path $fallback) { $iconPath = $fallback }
        }
        # 读不到就退回无图标布局（文字左对齐），不影响启动。
        try {
            if ($iconPath) {
                $bmp = $null
                try {
                    # 按 40x40 取 .ico 里最接近的那一帧，比 ExtractAssociatedIcon 的固定 32x32 清晰
                    $ico = New-Object System.Drawing.Icon($iconPath, 40, 40)
                    $bmp = $ico.ToBitmap()
                    $ico.Dispose()
                } catch {
                    $bmp = [System.Drawing.Icon]::ExtractAssociatedIcon($iconPath).ToBitmap()
                }
                $pb = New-Object System.Windows.Forms.PictureBox
                $pb.Image     = $bmp
                $pb.SizeMode  = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
                $pb.BackColor = $form.BackColor
                $pb.Location  = New-Object System.Drawing.Point(18, 22)
                $pb.Size      = New-Object System.Drawing.Size(40, 40)
                $form.Controls.Add($pb)
                $textX = 70
            } else {
                Write-Log '未找到任何可用图标，加载窗退回无图标布局' 'WARN'
            }
        } catch {
            Write-Log "加载图标失败，退回无图标布局：$($_.Exception.Message)" 'WARN'
        }

        $title = New-Object System.Windows.Forms.Label
        $title.Text      = 'DeepSeek Harness'
        $title.ForeColor = [System.Drawing.Color]::FromArgb(31, 35, 40)
        $title.Font      = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
        $title.AutoSize  = $true
        $title.Location  = New-Object System.Drawing.Point($textX, 22)
        $form.Controls.Add($title)

        $status = New-Object System.Windows.Forms.Label
        $status.Text      = '正在启动，请稍候…（不必重复点击图标）'
        $status.ForeColor = [System.Drawing.Color]::FromArgb(90, 96, 104)
        $status.Font      = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
        $status.AutoSize  = $true
        $status.Location  = New-Object System.Drawing.Point($textX, 50)
        $form.Controls.Add($status)

        $form.Show()
        [System.Windows.Forms.Application]::DoEvents()
        Write-Log '加载提示窗已显示'
        return $form
    } catch {
        Write-Log "加载提示窗创建失败，忽略：$($_.Exception.Message)" 'WARN'
        return $null
    }
}

function Update-Splash {
    param($Form)
    if (-not $Form) { return }
    try {
        if ($Form.IsDisposed) { return }
        [System.Windows.Forms.Application]::DoEvents()
    } catch { }
}

function Close-SplashWindow {
    param($Form)
    if (-not $Form) { return }
    try {
        if (-not $Form.IsDisposed) {
            $Form.Close()
            $Form.Dispose()
        }
    } catch { }
}

# ---------------------------------------------------------------- 主流程

$splash = $null
try {
    if ($Restart) {
        $stopScript = Join-Path $ScriptDir 'stop.ps1'
        if (Test-Path $stopScript) {
            Write-Log '按 -Restart 先停止现有服务'
            & $stopScript -Quiet | Out-Null
        }
    }

    $listeners = Get-ListenerProcess $Port
    $alreadyUp = (-not $Restart) -and (Test-DshAlive -Port $Port)

    if ($alreadyUp) {
        # 情况一：已经在跑了，直接开窗口
        Write-Log "端口 $Port 上已有 dsh 在服务，跳过启动步骤"
    } elseif ($listeners.Count -gt 0) {
        $names = ($listeners | ForEach-Object { "$($_.Name)(PID $($_.Id))" }) -join ', '
        if ($listeners | Where-Object { $_.Name -eq 'node' }) {
            # 情况二：是个 node 在听端口，但还没应答 —— 多半是上一次的 dsh 还在启动中，等它
            Write-Log "端口 $Port 已被 node 占用（$names），等待其就绪而不是重复启动"
        } else {
            # 情况三：被别的程序占了，硬起只会报错，直接讲清楚
            $msg = "端口 $Port 已被其他程序占用：`n`n$names`n`n" +
                   "请关闭该程序，或改 launcher.json 里的 port 后重试。"
            Write-Log "端口被非 node 程序占用：$names" 'ERROR'
            Show-Popup -Text $msg -Icon 16
            exit 1
        }
    } else {
        $proc = Start-DshServer
        Write-Log "服务进程已拉起，PID=$($proc.Id)"
    }

    # 等待就绪。只有确实需要冷启动等待时才弹加载窗；alreadyUp 会瞬间通过轮询，不弹。
    $deadline  = (Get-Date).AddSeconds($TimeoutSec)
    $ready     = $false
    $startedAt = Get-Date

    if (-not $alreadyUp -and -not $NoSplash) {
        $splash = New-SplashWindow
    }

    while ((Get-Date) -lt $deadline) {
        Update-Splash $splash
        if (Test-DshAlive -Port $Port -TimeoutMs 700) { $ready = $true; break }
        Start-Sleep -Milliseconds 60
        Update-Splash $splash
    }

    # 就绪或超时都先把加载窗收掉，再开浏览器 / 弹错误框，免得小窗盖在上面或赖着不走。
    Close-SplashWindow $splash
    $splash = $null

    if (-not $ready) {
        $tail = @()
        $so = Get-LogTail $StdoutLog
        $se = Get-LogTail $StderrLog
        if ($so) { $tail += "--- stdout ---`r`n$so" }
        if ($se) { $tail += "--- stderr ---`r`n$se" }
        $detail = ($tail -join "`r`n`r`n")
        if ([string]::IsNullOrWhiteSpace($detail)) { $detail = '（日志为空）' }

        $msg = "等待 $TimeoutSec 秒后，DSH 仍未在 $InitUrl 上响应。`n`n" +
               "日志：$LogDir`n`n$detail"
        Write-Log "启动超时，未就绪" 'ERROR'
        Show-Popup -Text $msg -Icon 16
        exit 1
    }

    $elapsed = [int]((Get-Date) - $startedAt).TotalMilliseconds
    Write-Log "服务已就绪（耗时 ${elapsed}ms）"

    # 拼出要打开的地址。三条路，按可靠性排序：
    #
    #   1. launcher.json 里的 authUrl —— 插件在 dsh 进程内直接问 connection 要的，
    #      永远和当前进程一致。首选。
    #   2. dsh-stdout.log 里的 token 行 —— 只在 1 拿不到时用。有个真实的坑：
    #      如果 dsh 是用户自己手动起的（不是被本启动器拉起的），日志里留的是
    #      上一轮的旧 token，拿它开窗只会得到一个 401 空白页（实测确认）。
    #   3. 干净的 / —— 浏览器里可能已经有 30 天有效的 cookie，也能进去。
    $openUrl = $InitUrl
    $authUrl = Get-ConfigAuthUrl -ConfigPath $ConfigFile
    if ($authUrl) {
        $openUrl = $authUrl
        Write-Log '使用插件写入的带令牌地址'
    } else {
        $token = Get-LaunchToken -LogPath $StdoutLog -MaxWaitSec 15
        if ($token) {
            $openUrl = $InitUrl + "?token=$token"
            Write-Log '插件没写 authUrl，退回从日志取令牌'
        } else {
            Write-Log '没有任何令牌可用，直接用干净地址打开（依赖浏览器里已有的 cookie）' 'WARN'
        }
    }

    if (-not $NoOpen) { Open-DshWindow -Url $openUrl }
    exit 0

} catch {
    $msg = "启动 DSH 失败：`n`n$($_.Exception.Message)`n`n日志：$LogDir"
    Write-Log "未捕获异常：$($_.Exception.ToString())" 'ERROR'
    Show-Popup -Text $msg -Icon 16
    exit 1
} finally {
    # 兜底：正常路径已各自关窗，这里保证异常/提前 exit 时加载窗不会赖在屏幕上。
    Close-SplashWindow $splash
}
