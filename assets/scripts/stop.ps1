<#
    stop.ps1 —— 停掉桌面启动器拉起来的 dsh 服务。

    平时用不着（关掉浏览器窗口就行，服务是被 detach 的，会继续在后台跑）。
    需要彻底停下来、或者想让启动器用新参数重起时用：

        powershell -NoProfile -ExecutionPolicy Bypass -File stop.ps1

    只结束「监听该端口的 node 进程」和「命令行指向同一个 dsh 入口的 node 进程」，
    不做按名字扫 node 后无差别杀的操作 —— 你别的项目里的 node 不会被误伤。
#>

[CmdletBinding()]
param(
    [switch]$Quiet,      # 不弹窗
    [switch]$Visible     # 日志同时打到控制台
)

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
    param([string]$Text, [int]$Icon = 64)
    if ($Quiet) { return }
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup($Text, 0, 'DeepSeek Harness', $Icon) | Out-Null
    } catch { }
}

# ---- 读配置
$ConfigFile = Join-Path $InstallDir 'launcher.json'
$Port = 3080
$DshEntry = ''
if (Test-Path $ConfigFile) {
    try {
        $cfg = Get-Content -Path $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.PSObject.Properties.Name -contains 'port') { $Port = [int]$cfg.port }
        if ($cfg.PSObject.Properties.Name -contains 'dshEntry') { $DshEntry = [string]$cfg.dshEntry }
    } catch {
        Write-Log "launcher.json 解析失败，沿用默认端口 3080" 'WARN'
    }
}

function Stop-Tree {
    param([int]$TargetId)
    $children = @()
    try {
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$TargetId" -ErrorAction SilentlyContinue
    } catch { }
    foreach ($child in $children) { Stop-Tree -TargetId ([int]$child.ProcessId) }
    try { Stop-Process -Id $TargetId -Force -ErrorAction Stop } catch { }
}

try {
    Write-Log "---- 停止请求：port=$Port ----"

    $targets = @{}

    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') {
            $targets[[int]$proc.Id] = "监听 $Port 端口的 node"
        } elseif ($proc) {
            Write-Log "端口 $Port 由 $($proc.ProcessName)(PID $($proc.Id)) 占用，非 node，跳过" 'WARN'
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($DshEntry)) {
        try {
            $nodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
            foreach ($n in $nodes) {
                if ($n.CommandLine -and $n.CommandLine -like "*$DshEntry*") {
                    $targets[[int]$n.ProcessId] = '指向同一个 dsh 入口的 node'
                }
            }
        } catch { }
    }

    if ($targets.Count -eq 0) {
        Write-Log '没有找到运行中的 dsh 服务'
        Show-Popup -Text 'DSH 当前没有在运行。' -Icon 64
        exit 0
    }

    $killed = @()
    foreach ($id in $targets.Keys) {
        Write-Log "结束进程 PID=$id（$($targets[$id])）"
        Stop-Tree -TargetId $id
        $killed += $id
    }

    Start-Sleep -Milliseconds 600
    $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

    if ($still) {
        Write-Log '停止后端口仍被占用' 'ERROR'
        Show-Popup -Text "尝试停止后，端口 $Port 仍被占用。`n`n日志：$LogDir" -Icon 16
        exit 1
    }

    Write-Log "已停止，共结束 $($killed.Count) 个进程"
    Show-Popup -Text 'DSH 已停止。' -Icon 64
    exit 0

} catch {
    Write-Log "未捕获异常：$($_.Exception.ToString())" 'ERROR'
    Show-Popup -Text "停止 DSH 时出错：`n`n$($_.Exception.Message)" -Icon 16
    exit 1
}
