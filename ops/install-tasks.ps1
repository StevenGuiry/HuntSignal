param([switch]$LocalIngestion)
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
function Install-HuntTask($name, $script, $trigger) {
    $scriptPath = Join-Path $taskRoot ('ops\' + $script)
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing -and @($existing.Actions | Where-Object { $_.Arguments -notlike ('*' + $taskRoot + '*') }).Count -gt 0) { throw "Task name belongs to another installation: $name" }
    $action = New-ScheduledTaskAction -Execute $powershellPath -Argument ('-NoProfile -WindowStyle Hidden -File "' + $scriptPath + '"') -WorkingDirectory $taskRoot
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'HuntSignal application maintenance; requires the signed-in Windows user and local .env.' -Force | Select-Object TaskName, State
}
Install-HuntTask 'HuntSignal encrypted backup' 'run-backup.ps1' (New-ScheduledTaskTrigger -Daily -At '03:35')
if ($LocalIngestion) { Install-HuntTask 'HuntSignal hourly ingestion' 'run-ingestion.ps1' (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1)) }
