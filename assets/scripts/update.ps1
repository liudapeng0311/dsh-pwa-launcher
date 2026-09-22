<#
    update.ps1 —— 第二期：把 DeepSeek Harness 升级到指定版本（外部游离进程执行）。

    为什么必须在进程外跑：插件就跑在被升级的那个 dsh 进程里，不能自己 npm install 覆盖
    正在运行的自己（Windows 上还会撞文件锁）。所以由 update.vbs 起一个游离于 node 进程树
    之外的 powershell 来编排：先停服务 → 备份 → npm install → 校验 → 成功则重启 / 失败则回滚。

    怎么定位「升级杠杆」（本脚本最关键的一步）
    ------------------------------------------
    dsh 有好几种装法，「在哪跑 npm install」并不一样。**不能认死某个目录名** ——
    写死目录名的做法（去找某个特定名字的 package.json）只对作者自己的机器成立，
    别人（npx / 全局安装）永远找不到，功能等于对他无效，而且失败方式是弹一个
    「找不到目录」的框，很难看出是设计缺陷。现在按装法判定：

      1) 本地 npm 树：从运行入口 bin.js 往上找，谁声明了 @deepseek-ai/dsh 依赖，
         谁就是安装根。这条同时覆盖三种真实布局 ——
           * npx 缓存  %LOCALAPPDATA%\npm-cache\_npx\<hash>\package.json
           * 本地工程  任意目录\package.json（就地 pin 了 dsh 的那种）
           * 本仓库的开发布局  runtime\package.json（也声明了该依赖）
         升级杠杆：在该目录 npm install @deepseek-ai/dsh@<ver> --save-exact

      2) 全局安装：入口落在 `npm root -g` 之下（那种位置没有 owner package.json）。
         升级杠杆：npm install -g @deepseek-ai/dsh@<ver> --save-exact

      两种都认不出时**明确报错并给出建议**，绝不去猜一个目录乱装。

    校验一律以「运行入口自己的 --version」为准，而不是只看 package.json 里的 pin ——
    pin 是意图，入口才是事实；全局安装更是根本没有 pin 可看。

    手动/测试用法：
        powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Target 0.1.6-alpha.1 -DryRun
        powershell ... -File update.ps1 -Target <ver> -InstallRoot <path> -NoStop -NoRelaunch   # 隔离测试核心
#>

[CmdletBinding()]
param(
    [string]$Target,          # 要升到的精确版本号（必填，除非 -Rollback）
    [switch]$Rollback,        # 只用最近一次备份还原
    [string]$InstallRoot,     # 覆盖安装根目录（默认自动探测；旧名 -RuntimeDir 仍可用）
    [string]$RuntimeDir,      # 兼容旧参数名，等价于 -InstallRoot
    [switch]$DryRun,          # 只打印将要做什么，不真的停/装/重启
    [switch]$NoStop,          # 不停服务（隔离测试用）
    [switch]$NoRelaunch,      # 完事后不重启（隔离测试用）
    [switch]$Quiet            # 不弹结果框
)

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Split-Path -Parent $ScriptDir
$LogDir     = Join-Path $InstallDir 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$script:LogFile = Join-Path $LogDir 'update.log'

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -Path $script:LogFile -Value $line -Encoding UTF8 } catch { }
    Write-Host $line
}

function Show-Popup {
    param([string]$Text, [int]$Icon = 64)
    if ($Quiet) { return }
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup($Text, 0, 'DeepSeek Harness 更新', $Icon) | Out-Null
    } catch { }
}

# 去掉「仅大小写不同」的重复环境变量（代理工具常同时设 http_proxy 与 HTTP_PROXY，PS 会抛异常）
function Get-DedupedEnv {
    $seen = @{}
    foreach ($name in @([System.Environment]::GetEnvironmentVariables('Process').Keys)) {
        $key = $name.ToLowerInvariant()
        if (-not $seen.ContainsKey($key)) { $seen[$key] = $name }
    }
    $drop = @()
    foreach ($name in @([System.Environment]::GetEnvironmentVariables('Process').Keys)) {
        $key = $name.ToLowerInvariant()
        if ($seen[$key] -ne $name) { $drop += $name }
    }
    foreach ($name in $drop) {
        try { [System.Environment]::SetEnvironmentVariable($name, $null, 'Process') } catch { }
    }
}

# 读安装根 package.json 里对 @deepseek-ai/dsh 的 pin（全局安装没有这个文件，返回空）
function Read-Pin($pkgJsonPath) {
    if (-not (Test-Path $pkgJsonPath)) { return '' }
    try {
        $j = Get-Content -Path $pkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $v = $j.dependencies.'@deepseek-ai/dsh'
        if ($v) { return [string]$v }
        return ''
    } catch { return '' }
}

# 这个目录是不是「本地 npm 树的根」——判据是它的 package.json 声明了 @deepseek-ai/dsh
function Test-LocalInstallRoot($dir) {
    $pj = Join-Path $dir 'package.json'
    if (-not (Test-Path $pj)) { return $false }
    try {
        $j = Get-Content -Path $pj -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($field in @('dependencies', 'devDependencies')) {
            if ($j.PSObject.Properties.Name -contains $field) {
                $names = $j.$field.PSObject.Properties.Name
                if ($names -contains '@deepseek-ai/dsh') { return $true }
            }
        }
    } catch { }
    return $false
}

<#
    判定 dsh 的装法，给出「升级杠杆」三要素：Mode / Root / BinPath。

    Mode = 'local'  -> 在 Root 里 `npm install @deepseek-ai/dsh@<v> --save-exact`
    Mode = 'global' -> `npm install -g @deepseek-ai/dsh@<v> --save-exact`
    Mode = ''       -> 认不出，Reason 说明原因（调用方据此报错退出，不猜）
#>
function Resolve-DshInstall {
    param([string]$Entry, [string]$NpmCmd)

    if ([string]::IsNullOrWhiteSpace($Entry)) {
        return [pscustomobject]@{ Mode = ''; Root = ''; BinPath = ''; Reason = 'launcher.json 里没有 dshEntry（先双击一次桌面图标，让插件写一份）' }
    }
    if (-not (Test-Path $Entry)) {
        return [pscustomobject]@{ Mode = ''; Root = ''; BinPath = $Entry; Reason = "dsh 入口不存在：$Entry" }
    }

    # —— 1) 本地 npm 树：往上找声明了 @deepseek-ai/dsh 的 package.json
    $dir = Split-Path -Parent $Entry
    for ($i = 0; $i -lt 10; $i++) {
        if ([string]::IsNullOrWhiteSpace($dir)) { break }
        if (Test-LocalInstallRoot $dir) {
            return [pscustomobject]@{ Mode = 'local'; Root = $dir; BinPath = $Entry; Reason = '' }
        }
        $parent = Split-Path -Parent $dir
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $dir) { break }
        $dir = $parent
    }

    # —— 2) 全局安装：入口落在 npm 的全局 root 之下
    $globalRoot = ''
    try {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $out = & $NpmCmd root -g 2>$null
        $ErrorActionPreference = $prev
        $first = @($out | Where-Object { "$_".Trim() -ne '' }) | Select-Object -First 1
        if ($first) { $globalRoot = ([string]$first).Trim().TrimEnd('\') }
    } catch { }
    if ($globalRoot) {
        $e = $Entry.Trim()
        $prefix = $globalRoot + '\'
        if ($e.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            return [pscustomobject]@{ Mode = 'global'; Root = $globalRoot; BinPath = $Entry; Reason = '' }
        }
    }

    $hint = if ($globalRoot) { "（npm 全局目录是 $globalRoot）" } else { '' }
    return [pscustomobject]@{
        Mode    = ''
        Root    = ''
        BinPath = $Entry
        Reason  = "认不出 dsh 是怎么安装的：入口既不在某个声明 @deepseek-ai/dsh 的本地 npm 树里，也不在 npm 全局目录下$hint。入口=$Entry"
    }
}

# 运行入口自己的版本 —— 这是「事实上在跑什么版本」，比 package.json 的 pin 可信
function Get-InstalledVersion($nodeExe, $binPath) {
    if ([string]::IsNullOrWhiteSpace($binPath) -or -not (Test-Path $binPath)) { return '' }
    # 原生命令的 stderr（如 NODE_TLS 警告）在 EAP=Stop 下会变成终止性错误，这里临时降级
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $nodeExe $binPath '--version' 2>&1
    $ErrorActionPreference = $prev
    foreach ($line in ($out | ForEach-Object { "$_" })) {
        $t = $line.Trim()
        if ($t -match '^\d+\.\d+\.\d+') { return $t }
    }
    return ''
}

# 在指定工作目录跑 npm，临时降级 EAP 以免 stderr 被当终止错误抛出；返回退出码与合并输出
function Invoke-Npm {
    param([string]$NpmCmd, [string]$WorkDir, [string[]]$NpmArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location $WorkDir
    $out = & $NpmCmd @NpmArgs 2>&1
    $code = $LASTEXITCODE
    Pop-Location
    $ErrorActionPreference = $prev
    return [pscustomobject]@{ Code = $code; Text = ($out | Out-String) }
}

# 按装法生成「安装某个版本」的参数（供升级与回滚共用）
function Get-InstallArgs {
    param([string]$Mode, [string]$Version)
    if ($Mode -eq 'global') {
        return @('install', '-g', "@deepseek-ai/dsh@$Version", '--save-exact', '--no-audit', '--no-fund')
    }
    return @('install', "@deepseek-ai/dsh@$Version", '--save-exact', '--no-audit', '--no-fund')
}

# ---------------------------------------------------------------- 主流程

Get-DedupedEnv

$ConfigFile = Join-Path $InstallDir 'launcher.json'
$NodeExe = 'node'
$Entry = ''
$Port = 3080
if (Test-Path $ConfigFile) {
    try {
        $cfg = Get-Content -Path $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.PSObject.Properties.Name -contains 'nodePath' -and $cfg.nodePath) { $NodeExe = [string]$cfg.nodePath }
        if ($cfg.PSObject.Properties.Name -contains 'dshEntry') { $Entry = [string]$cfg.dshEntry }
        if ($cfg.PSObject.Properties.Name -contains 'port') { $Port = [int]$cfg.port }
    } catch { Write-Log "launcher.json 解析失败：$($_.Exception.Message)" 'WARN' }
}

# npm.cmd：优先 node 同目录，退回 PATH 上的 npm
$NpmCmd = 'npm'
try {
    $nodeDir = Split-Path -Parent $NodeExe
    $cand = Join-Path $nodeDir 'npm.cmd'
    if (Test-Path $cand) { $NpmCmd = $cand }
} catch { }

# -RuntimeDir 是旧参数名，等价于 -InstallRoot
if ([string]::IsNullOrWhiteSpace($InstallRoot) -and -not [string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $InstallRoot = $RuntimeDir
}

# 覆盖参数给的是「安装根」，模式按全局目录判断，其余当本地
if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
    $mode = 'local'
    try {
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $gout = & $NpmCmd root -g 2>$null
        $ErrorActionPreference = $prevEap
        $gfirst = @($gout | Where-Object { "$_".Trim() -ne '' }) | Select-Object -First 1
        if ($gfirst -and $InstallRoot.Trim().TrimEnd('\').Equals(([string]$gfirst).Trim().TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
            $mode = 'global'
        }
    } catch { }
    $Install = [pscustomobject]@{ Mode = $mode; Root = $InstallRoot; BinPath = $Entry; Reason = '' }
} else {
    $Install = Resolve-DshInstall -Entry $Entry -NpmCmd $NpmCmd
}

if ([string]::IsNullOrWhiteSpace($Install.Mode)) {
    Write-Log "无法定位 dsh 安装位置：$($Install.Reason)" 'ERROR'
    Show-Popup -Text ("找不到 dsh 的安装位置，无法自动更新。`n`n" + $Install.Reason + "`n`n可以手动升级：npm install -g @deepseek-ai/dsh@<版本>`n`n日志：" + $LogDir) -Icon 16
    exit 2
}

$RuntimeDir = $Install.Root
$BinPath    = $Install.BinPath
$PkgJson    = Join-Path $RuntimeDir 'package.json'
$LockJson   = Join-Path $RuntimeDir 'package-lock.json'
$Pin        = Read-Pin $PkgJson
$Current    = Get-InstalledVersion $NodeExe $BinPath

Write-Log "==== 更新开始：模式=$($Install.Mode) 安装根=$RuntimeDir 入口=$BinPath 当前=$Current pin=$Pin 目标=$Target DryRun=$DryRun ===="

# ---------- 回滚模式 ----------
$BackupRoot = Join-Path $InstallDir 'update-backup'
if ($Rollback) {
    if (-not (Test-Path $BackupRoot)) { Show-Popup -Text '没有可回滚的备份。' -Icon 48; exit 3 }
    $last = Get-ChildItem -Path $BackupRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $last) { Show-Popup -Text '没有可回滚的备份。' -Icon 48; exit 3 }

    # 优先读 backup.json（记着模式/安装根/旧版本），兼容没有它的旧备份
    $stFile = Join-Path $last.FullName 'backup.json'
    $st = $null
    if (Test-Path $stFile) {
        try { $st = Get-Content -Path $stFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    if ($st) {
        $oldVer = [string]$st.previous
        $mode   = [string]$st.mode
        $root   = if ([string]::IsNullOrWhiteSpace([string]$st.root)) { $RuntimeDir } else { [string]$st.root }
    } else {
        $oldVer = Read-Pin (Join-Path $last.FullName 'package.json')
        $mode   = 'local'
        $root   = $RuntimeDir
    }
    if ([string]::IsNullOrWhiteSpace($oldVer)) {
        Show-Popup -Text '备份里没有可用的旧版本号，无法回滚。' -Icon 16
        exit 3
    }
    Write-Log "回滚到备份 $($last.Name)（模式=$mode 安装根=$root 旧版本=$oldVer）"

    if (-not $NoStop) { & (Join-Path $ScriptDir 'stop.ps1') -Quiet | Out-Null }
    if ($mode -eq 'local') {
        Copy-Item -Path (Join-Path $last.FullName 'package.json') -Destination $PkgJson -Force -ErrorAction SilentlyContinue
        if (Test-Path (Join-Path $last.FullName 'package-lock.json')) {
            Copy-Item -Path (Join-Path $last.FullName 'package-lock.json') -Destination $LockJson -Force
        }
    }
    $r = Invoke-Npm -NpmCmd $NpmCmd -WorkDir $root -NpmArgs (Get-InstallArgs -Mode $mode -Version $oldVer)
    $code = $r.Code
    ($r.Text -split "`r?`n") | Where-Object { $_ -ne '' } | ForEach-Object { Write-Log $_ }
    $ver = Get-InstalledVersion $NodeExe $BinPath
    if ($code -eq 0 -and $ver -eq $oldVer) {
        Write-Log "回滚成功，已还原到 $ver"
        if (-not $NoRelaunch) { & (Join-Path $ScriptDir 'launch.ps1') -NoOpen -NoSplash | Out-Null }
        Show-Popup -Text "已回滚到 $ver。" -Icon 64
        exit 0
    }
    Write-Log "回滚后校验异常：exit=$code 版本=$ver（期望 $oldVer）" 'ERROR'
    Show-Popup -Text "回滚后校验异常（版本=$ver，期望 $oldVer）。请手动检查。`n`n日志：$LogDir" -Icon 16
    exit 4
}

# ---------- 升级模式 ----------
if ([string]::IsNullOrWhiteSpace($Target)) {
    Write-Log '缺少 -Target' 'ERROR'
    Show-Popup -Text '缺少目标版本号，无法更新。' -Icon 16
    exit 2
}
if ($Target -eq $Current) {
    Write-Log "目标与当前一致（$Current），无需更新"
    Show-Popup -Text "当前已是 $Current，无需更新。" -Icon 64
    exit 0
}

$installArgs = Get-InstallArgs -Mode $Install.Mode -Version $Target
if ($DryRun) {
    Write-Log "（DryRun）模式=$($Install.Mode) 安装根=$RuntimeDir"
    Write-Log "（DryRun）将执行：stop → 备份 → npm $($installArgs -join ' ') → 校验 $BinPath --version==$Target → relaunch"
    Write-Log "（DryRun）未做任何改动。"
    exit 0
}

# 备份
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $BackupRoot $stamp
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
if (Test-Path $PkgJson)  { Copy-Item -Path $PkgJson  -Destination (Join-Path $BackupDir 'package.json') -Force }
if (Test-Path $LockJson) { Copy-Item -Path $LockJson -Destination (Join-Path $BackupDir 'package-lock.json') -Force }
# 记一份「怎么装回来的」说明 —— 全局安装没有 package.json 可还原，全靠这个
$state = [pscustomobject]@{
    mode      = $Install.Mode
    root      = $RuntimeDir
    binPath   = $BinPath
    previous  = $Current
    pin       = $Pin
    target    = $Target
    npmCmd    = $NpmCmd
    createdAt = (Get-Date -Format o)
}
[System.IO.File]::WriteAllText(
    (Join-Path $BackupDir 'backup.json'),
    ($state | ConvertTo-Json -Depth 4),
    (New-Object System.Text.UTF8Encoding($false))
)
Write-Log "已备份到 $BackupDir（模式=$($Install.Mode) 旧版本=$Current pin=$Pin）"

# 停服务
if (-not $NoStop) {
    Write-Log '停止当前 dsh 服务…'
    try { & (Join-Path $ScriptDir 'stop.ps1') -Quiet | Out-Null } catch { Write-Log "stop.ps1 异常：$($_.Exception.Message)" 'WARN' }
}

# 升级
$r = Invoke-Npm -NpmCmd $NpmCmd -WorkDir $RuntimeDir -NpmArgs $installArgs
$code = $r.Code
($r.Text -split "`r?`n") | Where-Object { $_ -ne '' } | ForEach-Object { Write-Log $_ }

# 校验：以入口自己的 --version 为准；本地树另外核对 pin
$ver = Get-InstalledVersion $NodeExe $BinPath
$newPin = Read-Pin $PkgJson
$pinOk = $true
if ($Install.Mode -eq 'local') { $pinOk = ($newPin -eq $Target) }
Write-Log "升级后：npm exit=$code  pin=$newPin  bin --version=$ver"

if ($code -ne 0 -or $ver -ne $Target -or -not $pinOk) {
    Write-Log '升级校验失败，开始回滚…' 'ERROR'
    # 本地树先还原 package.json/lock，全局安装没有可还原的文件
    if ($Install.Mode -eq 'local') {
        if (Test-Path (Join-Path $BackupDir 'package.json')) {
            Copy-Item -Path (Join-Path $BackupDir 'package.json') -Destination $PkgJson -Force
        }
        if (Test-Path (Join-Path $BackupDir 'package-lock.json')) {
            Copy-Item -Path (Join-Path $BackupDir 'package-lock.json') -Destination $LockJson -Force
        }
    }
    $rb = Invoke-Npm -NpmCmd $NpmCmd -WorkDir $RuntimeDir -NpmArgs (Get-InstallArgs -Mode $Install.Mode -Version $Current)
    $rcode = $rb.Code
    ($rb.Text -split "`r?`n") | Where-Object { $_ -ne '' } | ForEach-Object { Write-Log "回滚: $_" }
    $rver = Get-InstalledVersion $NodeExe $BinPath
    if ($rcode -eq 0 -and $rver -eq $Current) {
        Write-Log "已回滚到 $rver"
        if (-not $NoRelaunch) { & (Join-Path $ScriptDir 'launch.ps1') -NoOpen -NoSplash | Out-Null }
        Show-Popup -Text "升级到 $Target 失败，已自动回滚到 $rver。`n`n日志：$LogDir" -Icon 48
        exit 5
    }
    Write-Log '回滚也失败！需要手动处理' 'ERROR'
    Show-Popup -Text "升级到 $Target 失败，且自动回滚未成功（当前=$rver，期望=$Current，备份在 $BackupDir）。`n`n请手动检查。日志：$LogDir" -Icon 16
    exit 6
}

Write-Log "升级成功：$Current → $ver"
if (-not $NoRelaunch) {
    Write-Log '重启 dsh 服务（launch.ps1 -NoOpen -NoSplash，当前页面会自动重连）'
    & (Join-Path $ScriptDir 'launch.ps1') -NoOpen -NoSplash | Out-Null
}
Show-Popup -Text "已升级到 $ver。" -Icon 64
exit 0
