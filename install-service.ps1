# Registers the Rolzo watcher as a Windows Scheduled Task so it starts
# automatically at logon and restarts itself if it ever dies.
#
# Run once, from PowerShell, in this folder:
#     powershell -ExecutionPolicy Bypass -File .\install-service.ps1
#
# Manage it afterwards:
#     Get-ScheduledTask   -TaskName RolzoWatcher    # is it registered?
#     Start-ScheduledTask -TaskName RolzoWatcher    # start now
#     Stop-ScheduledTask  -TaskName RolzoWatcher    # stop now
#     Unregister-ScheduledTask -TaskName RolzoWatcher -Confirm:$false   # remove
#
# It runs hidden (no console window). Watch it via Discord, logs.txt, or:
#     Get-Content .\logs.txt -Wait -Tail 20

$ErrorActionPreference = 'Stop'

$TaskName  = 'RolzoWatcher'
$ScriptDir = $PSScriptRoot
$Script    = Join-Path $ScriptDir 'rolzo-auto-accept.js'

# Resolve node.exe rather than trusting PATH — Scheduled Tasks can run with a
# different environment than an interactive shell.
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) { throw "node.exe not found on PATH. Install Node.js or edit this script with its full path." }
$Node = $NodeCmd.Source

if (-not (Test-Path $Script)) { throw "Cannot find $Script" }
if (-not (Test-Path (Join-Path $ScriptDir 'rolzo.local.env'))) {
  Write-Warning "rolzo.local.env not found - the watcher will exit immediately without credentials."
}

Write-Host "Node   : $Node"
Write-Host "Script : $Script"

# Remove any previous registration so this script is safe to re-run.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Removing existing '$TaskName' task..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Script`"" -WorkingDirectory $ScriptDir

# At logon: the watcher needs the interactive user's context anyway, because the
# token-refresh bookmarklet talks to it on 127.0.0.1 from that user's browser.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable

# Interactive (not S4U): needs the desktop session so localhost refresh works.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Rolzo new-booking watcher / auto-accept' | Out-Null

Write-Host ""
Write-Host "Registered '$TaskName' - starts at logon, restarts every 1 min if it dies." -ForegroundColor Green
Write-Host "Starting it now..."
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
Write-Host "State: $((Get-ScheduledTask -TaskName $TaskName).State)  LastResult: $($info.LastTaskResult)"
Write-Host ""
Write-Host "Tail the log with:  Get-Content '$ScriptDir\logs.txt' -Wait -Tail 20"
