# Supervisor loop for rolzo-auto-accept.js.
#
# Task Scheduler's own "restart on failure" turned out to be unreliable in
# testing here (killing the process did not reliably bring it back within
# the configured window) — rather than depend on Windows' internal retry
# semantics, which are opaque and hard to verify, this script does the
# restart loop itself: something Task Scheduler only has to start ONCE, and
# which then keeps itself alive for as long as this wrapper process runs.

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$SupervisorLog = Join-Path $PSScriptRoot 'supervisor.log'
function Write-SupervisorLog($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
  Add-Content -Path $SupervisorLog -Value $line
}

Write-SupervisorLog "supervisor started (PID $PID)"

$restarts = 0
while ($true) {
  $restarts++
  Write-SupervisorLog "launching rolzo-auto-accept.js (attempt $restarts)"

  $proc = Start-Process -FilePath node -ArgumentList 'rolzo-auto-accept.js' `
            -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru -Wait

  Write-SupervisorLog "watcher exited with code $($proc.ExitCode) — restarting in 5s"
  Start-Sleep -Seconds 5
}
