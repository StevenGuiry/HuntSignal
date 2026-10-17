$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$logFolder = Join-Path $taskRoot '.data\logs'
New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$failed = $false
foreach ($stage in @(@('ingestion/cli.ts','hourly','--remote','--limit','100'), @('ingestion/enrich-cli.ts','--remote','--limit','250'), @('ingestion/alerts-cli.ts','--remote'), @('scripts/operations.ts','housekeeping','--remote'))) {
    & $nodePath --import tsx @stage *> (Join-Path $logFolder (($stage[0] -replace '[/\\.]','-') + '.log'))
    if ($LASTEXITCODE -ne 0) { $failed = $true }
}
if ($failed) { exit 1 }
