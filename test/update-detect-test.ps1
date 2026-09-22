<#
    update-detect-test.ps1 —— 验证 update.ps1 的「dsh 安装位置探测」逻辑。

    为什么需要它：这段逻辑曾经写死去找某个**特定包名**的 package.json —— 那是作者本机
    那个目录布局的名字。npx / 全局安装的人没有这个包名，功能对他完全无效，而且
    失败方式是「弹一个找不到目录的框」，很难看出是设计缺陷。所以这里把几种真实装法
    都钉住。

    跑法（在本包的 test 目录下）：
        powershell -NoProfile -ExecutionPolicy Bypass -File update-detect-test.ps1

    全程只跑 -DryRun，不碰任何真实安装。
#>

[CmdletBinding()]
param(
    [string]$PackageRoot = '',
    [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

# 默认 = 本文件所在目录的上一级（test\ 的父目录就是包根）。
# 注意别把 $MyInvocation.MyCommand.Path 放进 param 默认值 —— 那里还取不到，会是 null。
if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
    $here = Split-Path -Parent $MyInvocation.MyCommand.Path
    $PackageRoot = Split-Path -Parent $here
}

$src = Join-Path $PackageRoot 'assets\scripts'
if (-not (Test-Path (Join-Path $src 'update.ps1'))) {
    throw "找不到 update.ps1，-PackageRoot 给对了吗？$src"
}
if ([string]::IsNullOrWhiteSpace($NodeExe)) {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { $NodeExe = $c.Source } else { $NodeExe = 'node' }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-upd-detect-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

$script:Fails = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    if ($Ok) { Write-Host ("PASS  {0}{1}" -f $Name, $(if ($Detail) { "  $Detail" } else { '' })) -ForegroundColor Green }
    else { Write-Host ("FAIL  {0}{1}" -f $Name, $(if ($Detail) { "  $Detail" } else { '' })) -ForegroundColor Red; $script:Fails++ }
}

function New-Case {
    param([string]$Name, [string]$Entry)
    $dir = Join-Path $tmp $Name
    $scripts = Join-Path $dir 'scripts'
    New-Item -ItemType Directory -Path $scripts -Force | Out-Null
    foreach ($f in 'update.ps1', 'stop.ps1', 'launch.ps1') {
        $s = Join-Path $src $f
        if (Test-Path $s) { Copy-Item $s (Join-Path $scripts $f) -Force }
    }
    $cfg = [pscustomobject]@{
        appName = 'DeepSeek Harness'; port = 3080; nodePath = $NodeExe; dshEntry = $Entry
        dshArgs = @('web'); workspace = $tmp
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $dir 'launcher.json'),
        ($cfg | ConvertTo-Json -Depth 4),
        (New-Object System.Text.UTF8Encoding($false))
    )
    return (Join-Path $scripts 'update.ps1')
}

# 跑一次 DryRun，返回 { Exit; Output }
function Invoke-Case {
    param([string]$Script, [string]$RootArg = '')
    $a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Script,
        '-Target', '9.9.9', '-DryRun', '-Quiet', '-NoStop', '-NoRelaunch')
    if ($RootArg) { $a += @('-InstallRoot', $RootArg) }
    $out = & 'powershell.exe' @a 2>&1
    return [pscustomobject]@{ Exit = $LASTEXITCODE; Output = ($out | Out-String) }
}

Write-Host "=== update.ps1 安装位置探测 ===" -ForegroundColor Cyan
Write-Host "PackageRoot = $PackageRoot"

# ---- 1) 本地 npm 树：造一个最小但真实的布局（package.json 声明了 @deepseek-ai/dsh）
$local = Join-Path $tmp 'localproj'
$localBinDir = Join-Path $local 'node_modules\@deepseek-ai\dsh\lib'
New-Item -ItemType Directory -Path $localBinDir -Force | Out-Null
'{"name":"my-local-dsh-app","private":true,"dependencies":{"@deepseek-ai/dsh":"0.1.5-rc.1"}}' |
    Set-Content -Path (Join-Path $local 'package.json') -Encoding UTF8
Set-Content -Path (Join-Path $localBinDir 'bin.js') -Value 'console.log("0.1.5-rc.1")' -Encoding UTF8
$s1 = New-Case -Name 'c1' -Entry (Join-Path $localBinDir 'bin.js')
$r1 = Invoke-Case -Script $s1
Check '本地 npm 树 -> 识别为 local 并找到根' `
    ($r1.Exit -eq 0 -and $r1.Output -match '模式=local' -and $r1.Output -match [regex]::Escape($local)) `
    "exit=$($r1.Exit)"

# ---- 2) 关键回归：目录名不叫 dsh-runtime 也要认出来（npx 那种布局）
# 这正是修复前必然失败的情形
$npxLike = Join-Path $tmp 'npxlike'
$npxBinDir = Join-Path $npxLike 'node_modules\@deepseek-ai\dsh\lib'
New-Item -ItemType Directory -Path $npxBinDir -Force | Out-Null
'{"dependencies":{"@deepseek-ai/dsh":"^0.1.5-rc.1"},"_npx":{"packages":["@deepseek-ai/dsh"]}}' |
    Set-Content -Path (Join-Path $npxLike 'package.json') -Encoding UTF8
Set-Content -Path (Join-Path $npxBinDir 'bin.js') -Value 'console.log("0.1.5-rc.1")' -Encoding UTF8
$s2 = New-Case -Name 'c2' -Entry (Join-Path $npxBinDir 'bin.js')
$r2 = Invoke-Case -Script $s2
Check 'npx 式布局（无 dsh-runtime 包名）也能识别' `
    ($r2.Exit -eq 0 -and $r2.Output -match '模式=local' -and $r2.Output -match [regex]::Escape($npxLike)) `
    "exit=$($r2.Exit)"

# ---- 3) 认不出的装法必须明确报错，绝不猜目录
$iso = Join-Path $tmp 'iso\node_modules\@deepseek-ai\dsh\lib'
New-Item -ItemType Directory -Path $iso -Force | Out-Null
Set-Content -Path (Join-Path $tmp 'iso\package.json') -Value '{"name":"iso","private":true}' -Encoding UTF8
Set-Content -Path (Join-Path $iso 'bin.js') -Value 'console.log("0.1.5-rc.1")' -Encoding UTF8
$s3 = New-Case -Name 'c3' -Entry (Join-Path $iso 'bin.js')
$r3 = Invoke-Case -Script $s3
Check '认不出装法 -> 报错退出（exit 2），不乱装' `
    ($r3.Exit -eq 2 -and $r3.Output -match '认不出|无法定位') "exit=$($r3.Exit)"

# ---- 4) 入口不存在 -> 明确报错
$s4 = New-Case -Name 'c4' -Entry (Join-Path $tmp 'nowhere\bin.js')
$r4 = Invoke-Case -Script $s4
Check '入口不存在 -> 报错退出（exit 2）' ($r4.Exit -eq 2) "exit=$($r4.Exit)"

# ---- 5) 全局模式：-InstallRoot 指向 npm 全局目录时应带 -g
$gRoot = ''
try {
    $g = & npm root -g 2>$null | Where-Object { "$_".Trim() -ne '' } | Select-Object -First 1
    if ($g) { $gRoot = ([string]$g).Trim() }
} catch { }
if ($gRoot) {
    $s5 = New-Case -Name 'c5' -Entry (Join-Path $gRoot '@deepseek-ai\dsh\lib\bin.js')
    $r5 = Invoke-Case -Script $s5 -RootArg $gRoot
    Check '全局目录 -> 识别为 global' `
        ($r5.Exit -eq 0 -and $r5.Output -match '模式=global') "exit=$($r5.Exit)"
    Check '全局模式生成的 npm 参数带 -g' ($r5.Output -match 'npm install -g @deepseek-ai/dsh@9\.9\.9')
} else {
    Write-Host 'SKIP  全局模式（本机 npm root -g 取不到）' -ForegroundColor Yellow
}

# ---- 6) 本地模式绝不能带 -g
$r6 = Invoke-Case -Script $s1
Check '本地模式生成的 npm 参数不带 -g' `
    ($r6.Output -match 'npm install @deepseek-ai/dsh@9\.9\.9' -and $r6.Output -notmatch 'install -g')

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($script:Fails -eq 0) { Write-Host '全部通过' -ForegroundColor Green; exit 0 }
Write-Host ("{0} 项失败" -f $script:Fails) -ForegroundColor Red
exit 1
