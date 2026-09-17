<#
    update.ps1 —— 第二期：把 DeepSeek Harness 升级到指定版本（外部游离进程执行）。

    为什么必须在进程外跑：插件就跑在被升级的那个 dsh 进程里，不能自己 npm install 覆盖
    正在运行的自己（Windows 上还会撞文件锁）。所以由 update.vbs 起一个游离于 node 进程树
    之外的 powershell 来编排：先停服务 → 备份 → npm install → 校验 → 成功则重启 / 失败则回滚。

    关键事实（spike 已验证）：dsh 核心只有一棵树 = runtime\node_modules；profile 的
    @deepseek-ai/dsh-* 全是软链到 runtime，升级 runtime 后 profile 自动跟随，无需单独动 pnpm。
    升级杠杆就一条：在 runtime 目录里 `npm install @deepseek-ai/dsh@<目标> --save-exact`。

    手动/测试用法：
        powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Target 0.1.6-alpha.1 -DryRun
        powershell ... -File update.ps1 -Target <ver> -RuntimeDir <path> -NoStop -NoRelaunch   # 隔离测试核心
#>

[CmdletBinding()]
param(
    [string]$Target,          # 要升到的精确版本号（必填，除非 -Rollback）
    [switch]$Rollback,        # 只用最近一次备份还原
    [string]$RuntimeDir,      # 覆盖 runtime 目录（默认从 launcher.json 的 dshEntry 推导）
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

# 去掉「仅大小写不同」的重复环境变量（本机 http_proxy/HTTP_PROXY 四组都在，PS 会抛异常）
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

function Read-Pin($pkgJsonPath) {
    if (-not (Test-Path $pkgJsonPath)) { return '' }
    try {
        $j = Get-Content -Path $pkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $v = $j.dependencies.'@deepseek-ai/dsh'
        if ($v) { return [string]$v }
        return ''
    } catch { return '' }
}

# 从 dshEntry 往上找 name==dsh-runtime 的 package.json，定位 runtime 目录
function Find-RuntimeDirFromEntry($entry) {
    if ([string]::IsNullOrWhiteSpace($entry)) { return '' }
    if (-not (Test-Path $entry)) { return '' }
    $dir = Split-Path -Parent $entry
    for ($i = 0; $i -lt 8; $i++) {
        $pj = Join-Path $dir 'package.json'
        if (Test-Path $pj) {
            try {
                $j = Get-Content -Path $pj -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($j.name -eq 'dsh-runtime') { return $dir }
            } catch { }
        }
        $parent = Split-Path -Parent $dir
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    return ''
}

function Get-BinVersion($nodeExe, $runtimeDir) {
    $bin = Join-Path $runtimeDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (-not (Test-Path $bin)) { return '' }
    # 原生命令的 stderr（如 NODE_TLS 警告）在 EAP=Stop 下会变成终止性错误，这里临时降级
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $nodeExe $bin '--version' 2>&1
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

if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $RuntimeDir = Find-RuntimeDirFromEntry $Entry
}
if ([string]::IsNullOrWhiteSpace($RuntimeDir) -or -not (Test-Path $RuntimeDir)) {
    Write-Log '无法定位 runtime 目录（dsh 安装位置）' 'ERROR'
    Show-Popup -Text "找不到 dsh 的安装目录（runtime），无法更新。`n`n日志：$LogDir" -Icon 16
    exit 2
}

$PkgJson = Join-Path $RuntimeDir 'package.json'
$LockJson = Join-Path $RuntimeDir 'package-lock.json'
$Current = Read-Pin $PkgJson

# npm.cmd：优先 node 同目录，退回 PATH 上的 npm
$NpmCmd = 'npm'
try {
    $nodeDir = Split-Path -Parent $NodeExe
    $cand = Join-Path $nodeDir 'npm.cmd'
    if (Test-Path $cand) { $NpmCmd = $cand }
} catch { }

Write-Log "==== 更新开始：runtime=$RuntimeDir 当前=$Current 目标=$Target DryRun=$DryRun ===="

# ---------- 回滚模式 ----------
$BackupRoot = Join-Path $InstallDir 'update-backup'
if ($Rollback) {
    if (-not (Test-Path $BackupRoot)) { Show-Popup -Text '没有可回滚的备份。' -Icon 48; exit 3 }
    $last = Get-ChildItem -Path $BackupRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $last) { Show-Popup -Text '没有可回滚的备份。' -Icon 48; exit 3 }
    $oldPin = Read-Pin (Join-Path $last.FullName 'package.json')
    Write-Log "回滚到备份 $($last.Name)（旧 pin=$oldPin）"
    Copy-Item -Path (Join-Path $last.FullName 'package.json') -Destination $PkgJson -Force
    $oldLock = Join-Path $last.FullName 'package-lock.json'
    if (Test-Path $oldLock) { Copy-Item -Path $oldLock -Destination $LockJson -Force }
    if (-not $NoStop) { & (Join-Path $ScriptDir 'stop.ps1') -Quiet | Out-Null }
    $r = Invoke-Npm -NpmCmd $NpmCmd -WorkDir $RuntimeDir -NpmArgs @('install', '--no-audit', '--no-fund')
    $code = $r.Code
    ($r.Text -split "`r?`n") | Where-Object { $_ -ne '' } | ForEach-Object { Write-Log $_ }
    $ver = Get-BinVersion $NodeExe $RuntimeDir
    if ($code -eq 0 -and $ver -eq $oldPin) {
        Write-Log "回滚成功，已还原到 $ver"
        if (-not $NoRelaunch) { & (Join-Path $ScriptDir 'launch.ps1') -NoOpen -NoSplash | Out-Null }
        Show-Popup -Text "已回滚到 $ver。" -Icon 64
        exit 0
    }
    Write-Log "回滚后校验异常：exit=$code 版本=$ver" 'ERROR'
    Show-Popup -Text "回滚后校验异常（版本=$ver）。请手动检查。`n`n日志：$LogDir" -Icon 16
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

if ($DryRun) {
    Write-Log "（DryRun）将执行：stop → 备份 package.json/lock → npm install '@deepseek-ai/dsh@$Target' --save-exact → 校验 bin.js --version==$Target → relaunch"
    Write-Log "（DryRun）未做任何改动。"
    exit 0
}

# 备份
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $BackupRoot $stamp
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
Copy-Item -Path $PkgJson -Destination (Join-Path $BackupDir 'package.json') -Force
if (Test-Path $LockJson) { Copy-Item -Path $LockJson -Destination (Join-Path $BackupDir 'package-lock.json') -Force }
Write-Log "已备份旧 package.json/lock 到 $BackupDir（旧 pin=$Current）"

# 停服务
if (-not $NoStop) {
    Write-Log '停止当前 dsh 服务…'
    try { & (Join-Path $ScriptDir 'stop.ps1') -Quiet | Out-Null } catch { Write-Log "stop.ps1 异常：$($_.Exception.Message)" 'WARN' }
}

# 升级
$r = Invoke-Npm -NpmCmd $NpmCmd -WorkDir $RuntimeDir -NpmArgs @('install', "@deepseek-ai/dsh@$Target", '--save-exact', '--no-audit', '--no-fund')
$code = $r.Code
($r.Text -split "`r?`n") | Where-Object { $_ -ne '' } | ForEach-Object { Write-Log $_ }

# 校验
$ver = Get-BinVersion $NodeExe $RuntimeDir
$newPin = Read-Pin $PkgJson
Write-Log "升级后：npm exit=$code  pin=$newPin  bin.js --version=$ver"

if ($code -ne 0 -or $ver -ne $Target -or $newPin -ne $Target) {
    Write-Log '升级校验失败，开始回滚…' 'ERROR'
    Copy-Item -Path (Join-Path $BackupDir 'package.json') -Destination $PkgJson -Force
    if (Test-Path (Join-Path $BackupDir 'package-lock.json')) {
        Copy-Item -Path (Join-Path $BackupDir 'package-lock.json') -Destination $LockJson -Force
    }
    Push-Location $RuntimeDir
    $rb = Invoke-Npm -NpmCmd $NpmCmd -WorkDir $RuntimeDir -NpmArgs @('install', '--no-audit', '--no-fund')
    $rcode = $rb.Code
    Pop-Location
    ($rb.Text -split "`r?`n") | Where-Object { $_ -ne '' } | ForEach-Object { Write-Log "回滚: $_" }
    $rver = Get-BinVersion $NodeExe $RuntimeDir
    if ($rcode -eq 0 -and $rver -eq $Current) {
        Write-Log "已回滚到 $rver"
        if (-not $NoRelaunch) { & (Join-Path $ScriptDir 'launch.ps1') -NoOpen -NoSplash | Out-Null }
        Show-Popup -Text "升级到 $Target 失败，已自动回滚到 $rver。`n`n日志：$LogDir" -Icon 48
        exit 5
    }
    Write-Log '回滚也失败！需要手动处理' 'ERROR'
    Show-Popup -Text "升级到 $Target 失败，且自动回滚未成功（当前=$rver，备份在 $BackupDir）。`n`n请手动检查。日志：$LogDir" -Icon 16
    exit 6
}

Write-Log "升级成功：$Current → $ver"
if (-not $NoRelaunch) {
    Write-Log '重启 dsh 服务（launch.ps1 -NoOpen -NoSplash，当前页面会自动重连）'
    & (Join-Path $ScriptDir 'launch.ps1') -NoOpen -NoSplash | Out-Null
}
Show-Popup -Text "已升级到 $ver。" -Icon 64
exit 0
