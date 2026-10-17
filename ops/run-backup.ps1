$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$logFolder = Join-Path $taskRoot '.data\logs'
New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
& $nodePath --import tsx (Join-Path $taskRoot 'scripts\backup-hosted.ts') *> (Join-Path $logFolder 'backup-latest.log')
exit $LASTEXITCODE
