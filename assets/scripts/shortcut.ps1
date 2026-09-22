<#
    shortcut.ps1 —— 把桌面 / 开始菜单上的图标接到启动器上。

    由 dsh-pwa-launcher 在每次 dsh 启动时调用（application/plugin 侧，见 lib\index.js）：

        powershell -File shortcut.ps1 -Action Install -ShortcutName "DeepSeek Harness"

    Install 的判定顺序（这个顺序是有讲究的，别调换）：

      1. 找到「浏览器给你生成的那个 PWA 快捷方式」—— 目标是 msedge_proxy.exe /
         chrome_proxy.exe 且带 --app-id=。找到就**接管**：把它原本要执行的命令行
         存进 shortcut-origin.json，然后把 Target 换成 wscript.exe + launcher.vbs，
         **图标原样保留**。你看上去还是同一个图标，双击却会先把服务拉起来。

      2. 找不到 PWA 快捷方式，但**已经有指向本启动器的快捷方式** —— 说明上一轮
         已经接管过了。这时只刷新（尤其要保住已记录的浏览器图标），绝不能退回
         备用的 dsh.ico。否则第二次启动就会把 Edge 给的图标覆盖掉。
         （这是第一版踩到的坑。）

      3. 两者都没有 —— 全新安装，自己建一个，图标用安装目录里的 dsh.ico。

    Uninstall 还原被接管的快捷方式，并删掉我们自己建的。

    整个脚本幂等：重复运行不会产生第二份图标，也不会丢掉原始记录。
#>

[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall')]
    [string]$Action = 'Install',
    [string]$ShortcutName = 'DeepSeek Harness',
    # 当前 dsh 的端口。用来判断某个 PWA 快捷方式到底是不是指向我们的 ——
    # 这是「不误伤别人的快捷方式」的第二道依据（第一道是名字）。
    [string]$Port = '',
    [string]$Adopt = '1',
    [string]$Desktop = '1',
    [string]$StartMenu = '1'
)

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Split-Path -Parent $ScriptDir
$LogDir     = Join-Path $InstallDir 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir 'desktop.log'

function Write-Log {
    param([string]$Message)
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
    # 插件是通过管道读 stdout 的，这里必须打印
    Write-Output $line
}

$Wscript     = Join-Path $env:SystemRoot 'System32\wscript.exe'
$Launcher    = Join-Path $InstallDir 'launcher.vbs'
$IconPath    = Join-Path $InstallDir 'dsh.ico'
$OriginFile  = Join-Path $InstallDir 'shortcut-origin.json'
$Description = 'DeepSeek Harness'

if (-not (Test-Path $Wscript))  { throw "找不到 wscript.exe：$Wscript" }
if (-not (Test-Path $Launcher)) { throw "找不到 launcher.vbs：$Launcher" }

$DesktopDir   = [Environment]::GetFolderPath('Desktop')
$StartMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

$shell = New-Object -ComObject WScript.Shell

# 想处理的目录（去重）
function Get-TargetDirs {
    $dirs = @()
    if ($Desktop -eq '1' -and (Test-Path $DesktopDir)) { $dirs += $DesktopDir }
    if ($StartMenu -eq '1' -and (Test-Path $StartMenuDir)) { $dirs += $StartMenuDir }
    return ($dirs | Select-Object -Unique)
}

function Get-LnkFiles {
    param([string]$Dir)
    if (-not (Test-Path $Dir)) { return @() }
    try { return @(Get-ChildItem -Path $Dir -Filter *.lnk -Recurse -Force -ErrorAction SilentlyContinue) }
    catch { return @() }
}

# ---------------------------------------------------------------- 小工具

# 把命令行字符串拆成参数数组，照顾引号。PWA 那两个参数本身没有空格，
# 但浏览器的路径可能有，所以还是正经拆一遍。
function Split-Arguments {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
    $result = @()
    foreach ($m in [regex]::Matches($CommandLine, '(?<q>"[^"]*")|(?<p>\S+)')) {
        if ($m.Groups['q'].Success) { $out = $m.Groups['q'].Value.Trim('"') }
        else { $out = $m.Groups['p'].Value }
        # 图标/参数里可能写成 %USERPROFILE%\... ，展开一下
        $result += [System.Environment]::ExpandEnvironmentVariables($out)
    }
    return $result
}

# 这个快捷方式是不是已经指向我们的启动器
function Test-IsOurShortcut {
    param($Shortcut)
    $target = ''
    try { $target = $Shortcut.TargetPath } catch { }
    if ([string]::IsNullOrWhiteSpace($target)) { return $false }
    if ([System.IO.Path]::GetFileName($target).ToLowerInvariant() -ne 'wscript.exe') { return $false }
    return ($Shortcut.Arguments -like "*$Launcher*")
}

# 浏览器「安装为应用」生成的那种快捷方式
function Test-IsBrowserAppShortcut {
    param($Shortcut)
    $base = ''
    try { $base = [System.IO.Path]::GetFileName($Shortcut.TargetPath).ToLowerInvariant() } catch { }
    if ($base -ne 'msedge_proxy.exe' -and $base -ne 'chrome_proxy.exe') { return $false }
    return ($Shortcut.Arguments -like '*--app-id=*')
}

# 这个候选到底属不属于 DSH。两条依据，满足其一即可：
#   - 图标名字和我们的一样（浏览器「安装为应用」默认用 manifest 的 name 命名）
#   - 它本来就指向我们正在用的这个端口（--app-url=http://127.0.0.1:<Port>/）
#
# 没有第三条。**绝不能**退化成「名字对不上就随便拿一个」——
# 同一台机器上还有别的网站的 PWA 快捷方式时，那会把别人的 Target 直接改掉。
function Test-CandidateIsOurs {
    param($Candidate)
    if ($Candidate.BaseName -eq $ShortcutName) { return $true }
    if ([string]::IsNullOrWhiteSpace($Port)) { return $false }
    foreach ($a in @(Split-Arguments -CommandLine $Candidate.Shortcut.Arguments)) {
        if ($a -like '--app-url=*' -and $a -like "*127.0.0.1:$Port*") { return $true }
    }
    return $false
}

function Get-CandidateShortcuts {
    $found = @()
    foreach ($dir in (Get-TargetDirs)) {
        foreach ($file in (Get-LnkFiles -Dir $dir)) {
            $sc = $null
            try { $sc = $shell.CreateShortcut($file.FullName) } catch { continue }
            if (-not (Test-IsBrowserAppShortcut -Shortcut $sc)) { continue }
            $found += [pscustomobject]@{
                Path     = $file.FullName
                Filename = $file.Name
                BaseName = $file.BaseName
                Shortcut = $sc
            }
        }
    }
    return $found
}

function Get-OurShortcuts {
    $found = @()
    foreach ($dir in (Get-TargetDirs)) {
        foreach ($file in (Get-LnkFiles -Dir $dir)) {
            $sc = $null
            try { $sc = $shell.CreateShortcut($file.FullName) } catch { continue }
            if (-not (Test-IsOurShortcut -Shortcut $sc)) { continue }
            $found += [pscustomobject]@{
                Path     = $file.FullName
                Filename = $file.Name
                BaseName = $file.BaseName
                Shortcut = $sc
            }
        }
    }
    return $found
}

function Save-Origin {
    param($Candidate)
    # 只记第一次：重复运行插件不该把「我们自己的启动器」记成 origin
    if (Test-Path $OriginFile) {
        Write-Log '已存在 shortcut-origin.json，保留原有记录'
        return
    }
    $payload = [ordered]@{
        _help      = '这里记录的是「你原来那个浏览器 PWA 图标会执行的命令行」。launch.ps1 用它来还原一模一样的开窗方式，也用它记住图标。删掉不影响使用，只是开窗会退化成普通应用窗口、图标退回备用图标。'
        source     = $Candidate.Path
        proxyExe   = $Candidate.Shortcut.TargetPath
        proxyArgs  = @(Split-Arguments -CommandLine $Candidate.Shortcut.Arguments)
        icon       = $Candidate.Shortcut.IconLocation
        capturedAt = (Get-Date).ToString('s')
    }
    $json = $payload | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($OriginFile, $json, (New-Object System.Text.UTF8Encoding($true)))
    Write-Log "已记录原始开窗方式：$($Candidate.Shortcut.TargetPath) $($Candidate.Shortcut.Arguments)"
}

# 优先用浏览器原来那个图标；它没了就退回安装目录里的 dsh.ico
function Resolve-Icon {
    if (Test-Path $OriginFile) {
        try {
            $origin = Get-Content -Path $OriginFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $icon = [string]$origin.icon
            if (-not [string]::IsNullOrWhiteSpace($icon)) {
                # IconLocation 形如 "路径,索引"
                $file = ($icon -split ',')[0].Trim().Trim('"')
                $file = [System.Environment]::ExpandEnvironmentVariables($file)
                if (Test-Path $file) { return $icon }
                Write-Log "记录的浏览器图标已不在：$file，退回备用图标"
            }
        } catch { }
    }
    if (Test-Path $IconPath) { return $IconPath }
    return $null
}

# 把一个 .lnk 写成「指向启动器」
function Set-ShortcutToLauncher {
    param([string]$Path, [string]$Icon)
    $sc = $shell.CreateShortcut($Path)
    $sc.TargetPath       = $Wscript
    $sc.Arguments        = '"' + $Launcher + '"'
    $sc.WorkingDirectory = $InstallDir
    $sc.Description      = $Description
    $sc.WindowStyle      = 1
    if (-not [string]::IsNullOrWhiteSpace($Icon)) { $sc.IconLocation = $Icon }
    $sc.Save()
}

# ---------------------------------------------------------------- Install

function Invoke-Install {
    $touched = @()

    # ---- 第 1 步：有没有可以接管的浏览器 PWA 快捷方式
    $candidates = @()
    if ($Adopt -eq '1') { $candidates = @(Get-CandidateShortcuts) }

    $chosen = $null
    if ($candidates.Count -gt 0) {
        Write-Log ("找到 $($candidates.Count) 个浏览器 PWA 快捷方式：" +
                   (($candidates | ForEach-Object { $_.Filename }) -join ', '))

        # 只认「名字对得上」或「本来就指向我们这个端口」的那些。
        # 找不到就交给下面自己新建 —— 不会去动别人的快捷方式。
        $chosen = $candidates | Where-Object { Test-CandidateIsOurs -Candidate $_ } | Select-Object -First 1
        if (-not $chosen) {
            Write-Log '其中没有属于 DSH 的（名字和端口都不匹配），原样保留，改为自己建一个'
        }
    }

    if ($chosen) {
        # 先记 origin，再取图标 —— 顺序不能反，图标是从 origin 里读的
        Save-Origin -Candidate $chosen
        $icon = Resolve-Icon

        Write-Log "接管：$($chosen.Path)"
        Set-ShortcutToLauncher -Path $chosen.Path -Icon $icon
        $touched += $chosen.Path

        # 其余同属 DSH 的候选（比如开始菜单也有一份）一并接管
        foreach ($other in ($candidates | Where-Object { $_.Path -ne $chosen.Path -and (Test-CandidateIsOurs -Candidate $_) })) {
            Set-ShortcutToLauncher -Path $other.Path -Icon $icon
            Write-Log "一并接管：$($other.Path)"
            $touched += $other.Path
        }
    } else {
        # ---- 第 2 步：是不是上一轮已经接管过了
        $ours = @(Get-OurShortcuts)
        if ($ours.Count -gt 0) {
            Write-Log "已有 $($ours.Count) 个指向启动器的快捷方式，只做刷新"
            $icon = Resolve-Icon
            foreach ($o in $ours) {
                Set-ShortcutToLauncher -Path $o.Path -Icon $icon
                $touched += $o.Path
            }
            # 落空的目标目录补一个
            if ($Desktop -eq '1' -and (Test-Path $DesktopDir)) {
                $d = Join-Path $DesktopDir ($ShortcutName + '.lnk')
                if (-not ($ours | Where-Object { $_.Path -eq $d })) {
                    Set-ShortcutToLauncher -Path $d -Icon $icon
                    Write-Log "补建桌面快捷方式：$d"
                    $touched += $d
                }
            }
            if ($StartMenu -eq '1' -and (Test-Path $StartMenuDir)) {
                $s = Join-Path $StartMenuDir ($ShortcutName + '.lnk')
                if (-not ($ours | Where-Object { $_.Path -eq $s })) {
                    Set-ShortcutToLauncher -Path $s -Icon $icon
                    Write-Log "补建开始菜单快捷方式：$s"
                    $touched += $s
                }
            }
        } else {
            # ---- 第 3 步：全新安装
            Write-Log '没有找到可接管的浏览器 PWA 快捷方式，自己建一个'
            $icon = Resolve-Icon
            if ($Desktop -eq '1' -and (Test-Path $DesktopDir)) {
                $d = Join-Path $DesktopDir ($ShortcutName + '.lnk')
                Set-ShortcutToLauncher -Path $d -Icon $icon
                Write-Log "新建桌面快捷方式：$d"
                $touched += $d
            }
            if ($StartMenu -eq '1' -and (Test-Path $StartMenuDir)) {
                $s = Join-Path $StartMenuDir ($ShortcutName + '.lnk')
                Set-ShortcutToLauncher -Path $s -Icon $icon
                Write-Log "新建开始菜单快捷方式：$s"
                $touched += $s
            }
        }
    }

    $unique = @($touched | Select-Object -Unique)
    Write-Log "安装完成，处理了 $($unique.Count) 个快捷方式"
    if ($unique.Count -gt 0) {
        Write-Log "图标：$(Resolve-Icon)"
    }
}

# ---------------------------------------------------------------- Uninstall

function Invoke-Uninstall {
    $origin = $null
    if (Test-Path $OriginFile) {
        try { $origin = Get-Content -Path $OriginFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }

    foreach ($dir in @($DesktopDir, $StartMenuDir) | Select-Object -Unique) {
        foreach ($file in (Get-LnkFiles -Dir $dir)) {
            $sc = $null
            try { $sc = $shell.CreateShortcut($file.FullName) } catch { continue }
            if (-not (Test-IsOurShortcut -Shortcut $sc)) { continue }

            $isOrigin = ($origin -and $origin.source -eq $file.FullName)
            if ($isOrigin) {
                # 还原成浏览器原来的样子
                $sc.TargetPath       = $origin.proxyExe
                $sc.Arguments        = (@($origin.proxyArgs) -join ' ')
                $sc.WorkingDirectory = Split-Path -Parent $origin.proxyExe
                if ($origin.icon) { $sc.IconLocation = $origin.icon }
                $sc.Description      = ''
                $sc.Save()
                Write-Log "已还原：$($file.FullName)"
            } else {
                Remove-Item -Path $file.FullName -Force
                Write-Log "已删除：$($file.FullName)"
            }
        }
    }

    if (Test-Path $OriginFile) { Remove-Item -Path $OriginFile -Force }
    Write-Log '卸载完成'
}

# ---------------------------------------------------------------- 主流程

try {
    if ($Action -eq 'Install') { Invoke-Install } else { Invoke-Uninstall }
    exit 0
} catch {
    Write-Log "出错：$($_.Exception.ToString())"
    exit 1
}
