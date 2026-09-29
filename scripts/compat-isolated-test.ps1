# 隔离 DSH_HOME 兼容性实测：dsh-git-graph × 指定 DSH 版本
# 每个版本独立 work/node_modules + 独立 DSH_HOME；只读一次性夹具，不碰真实 ~/.dsh。
# 用法（需 PowerShell 7 / pwsh，5.1 会把无 BOM UTF-8 按 ANSI 解码导致中文路径乱码）：
#   pwsh -File scripts/compat-isolated-test.ps1                                  # 默认实测两个锚点版本
#   pwsh -File scripts/compat-isolated-test.ps1 -Versions 0.2.0-rc.1             # 只测一个版本
# 实测项：npm 装 dsh → dsh plugin add link:<插件> → dump-config 断言 → 卸载断言。
# 结果写入 <TEMP>\dsh-compat-v0140\run.log，作为 docs/compatibility.md 的证据。
param(
  [string[]]$Versions = @('0.1.7-rc.2', '0.2.0-rc.1'),
  [string]$PluginSrc
)
$ErrorActionPreference = 'Continue'
$base = Join-Path $env:TEMP 'dsh-compat-v0140'
Remove-Item $base -Recurse -Force -ErrorAction SilentlyContinue
New-Item $base -ItemType Directory -Force | Out-Null
if (-not $PluginSrc) { $PluginSrc = 'D:\桌面\Agent操作文件夹\Git图谱插件_deepseek harness' }
$log = Join-Path $base 'run.log'

# 1) 复制插件源码（仅仓库文件，排除 .git/.reasonix）到 ASCII 路径
$plugin = Join-Path $base 'plugin-src'
New-Item $plugin -ItemType Directory -Force | Out-Null
Get-ChildItem $pluginSrc -Force | Where-Object { $_.Name -notin @('.git', '.reasonix') } | ForEach-Object {
  Copy-Item $_.FullName $plugin -Recurse -Force
}
Add-Content $log "plugin staged at: $plugin"

function Test-Version([string]$ver) {
  $work = Join-Path $base "work-$ver"
  $homedir = Join-Path $base "home-$ver"
  New-Item $work -ItemType Directory -Force | Out-Null
  New-Item $homedir -ItemType Directory -Force | Out-Null
  $env:DSH_HOME = $homedir
  Add-Content $log "===== TEST $ver (DSH_HOME=$homedir) ====="
  Add-Content $log "-- npm install dsh@$ver --"
  Push-Location $work
  npm init -y 2>&1 | Out-Null
  npm install "@deepseek-ai/dsh@$ver" --no-audit --no-fund 2>&1 | Select-Object -Last 2 | Add-Content $log
  $bin = Join-Path $work 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  Add-Content $log "npm install exit: $LASTEXITCODE  dsh: $((node $bin --version 2>&1 | Out-String).Trim())"
  Add-Content $log "-- plugin add (link:) --"
  node $bin plugin --profile web add "link:$plugin" 2>&1 | Select-Object -Last 10 | Add-Content $log
  Add-Content $log "add exit: $LASTEXITCODE"
  Add-Content $log "-- dump-config (synthesis assert git-graph) --"
  $dump = node $bin --profile web --dump-config 2>&1 | Out-String
  $dump | Select-Object -Last 8 | Add-Content $log
  $hasPlugin = if ($dump -match 'git-graph') { 'yes' } else { 'NO' }
  Add-Content $log "dump exit: $LASTEXITCODE  contains git-graph: $hasPlugin"
  Add-Content $log "-- plugin remove --"
  node $bin plugin --profile web remove dsh-git-graph 2>&1 | Select-Object -Last 4 | Add-Content $log
  Add-Content $log "remove exit: $LASTEXITCODE"
  $dump2 = node $bin --profile web --dump-config 2>&1 | Out-String
  $left = if ($dump2 -match 'git-graph') { 'still-present' } else { 'cleaned' }
  Add-Content $log "after remove, dump-config: $left"
  Add-Content $log "-----"
  Pop-Location
}

# 2) 安全护栏：断言 DSH_HOME 始终在我们的临时目录内
if (-not ($base.StartsWith($env:TEMP))) { Add-Content $log "ABORT: base not under TEMP"; exit 9 }

foreach ($v in $Versions) { Test-Version $v }
Add-Content $log "ALL DONE"
