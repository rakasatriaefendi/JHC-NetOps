param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install", "start", "restart", "status", "remove")]
  [string]$Action
)

$ErrorActionPreference = "Stop"
$taskName = "Network Monitoring Local Runner"
$runnerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runnerScript = Join-Path $runnerRoot "src\main.mjs"
$configPath = Join-Path $runnerRoot "config.local.json"

switch ($Action) {
  "install" {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath $configPath)) {
      throw "config.local.json is required before installing the task."
    }
    $taskAction = New-ScheduledTaskAction `
      -Execute $nodePath `
      -Argument "`"$runnerScript`" --config `"$configPath`"" `
      -WorkingDirectory $runnerRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
      -Hidden `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -MultipleInstances IgnoreNew `
      -RestartCount 3 `
      -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask `
      -TaskName $taskName `
      -Action $taskAction `
      -Trigger $trigger `
      -Settings $settings `
      -Description "Runs the allow-listed WSL LAN diagnostics bridge." `
      -Force | Out-Null
    Write-Output "Installed: $taskName"
  }
  "start" {
    Start-ScheduledTask -TaskName $taskName
    Write-Output "Started: $taskName"
  }
  "restart" {
    $scheduledTask = Get-ScheduledTask -TaskName $taskName
    if ($scheduledTask.State -ne "Ready") {
      Stop-ScheduledTask -TaskName $taskName
      $deadline = (Get-Date).AddSeconds(10)
      do {
        Start-Sleep -Milliseconds 250
        $scheduledTask = Get-ScheduledTask -TaskName $taskName
      } while ($scheduledTask.State -ne "Ready" -and (Get-Date) -lt $deadline)
      if ($scheduledTask.State -ne "Ready") {
        throw "Runner task did not stop within 10 seconds."
      }
    }
    Start-ScheduledTask -TaskName $taskName
    Write-Output "Restarted: $taskName"
  }
  "status" {
    $scheduledTask = Get-ScheduledTask -TaskName $taskName
    $taskInfo = $scheduledTask | Get-ScheduledTaskInfo
    [PSCustomObject]@{
      TaskName = $taskName
      State = $scheduledTask.State
      LastRunTime = $taskInfo.LastRunTime
      LastTaskResult = $taskInfo.LastTaskResult
      NextRunTime = $taskInfo.NextRunTime
    }
  }
  "remove" {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "Removed: $taskName"
  }
}
