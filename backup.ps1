# TraeHop 源码备份脚本：将 resources/app 打包为 backups/traehop-时间戳.zip
# 用法：右键"使用 PowerShell 运行"或在终端执行  .\backup.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Join-Path $root 'resources\app'
$backupDir = Join-Path $root 'backups'

if (-not (Test-Path $appDir)) { Write-Error "未找到源码目录: $appDir" }

if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $backupDir "traehop-$stamp.zip"

Compress-Archive -Path (Join-Path $appDir '*') -DestinationPath $dest -Force

$size = [math]::Round((Get-Item $dest).Length / 1KB)
Write-Host "备份完成: $dest ($size KB)"

# 只保留最近 20 份
Get-ChildItem $backupDir -Filter 'traehop-*.zip' | Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 20 | Remove-Item -Force
