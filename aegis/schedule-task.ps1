<#
.SYNOPSIS
    Registers (or removes) the Aegis-Crypto scanner as a Windows Scheduled Task.

.DESCRIPTION
    Runs `node index.mjs` on a fixed interval so holder-velocity deltas, the
    deployer index and smart-money scans keep accumulating without you having to
    remember to run anything.

    Runs only while you are logged on, so no stored password is required.
    Overlapping runs are suppressed — if a scan is still going when the next
    interval fires, the new one is skipped rather than queued.

.EXAMPLE
    .\schedule-task.ps1                 # register with the default 12-minute interval
    .\schedule-task.ps1 -Minutes 15     # register with a custom interval
    .\schedule-task.ps1 -Remove         # unregister
    .\schedule-task.ps1 -Status         # show current state and last result
#>

param(
    [int]$Minutes = 12,
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Aegis-Crypto Scanner'
$ScriptDir = $PSScriptRoot

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Yellow
    } else {
        Write-Host "No scheduled task named '$TaskName' exists." -ForegroundColor Yellow
    }
    return
}

if ($Status) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host "Not registered." -ForegroundColor Yellow; return }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    [PSCustomObject]@{
        State          = $task.State
        Interval       = $task.Triggers[0].Repetition.Interval
        LastRunTime    = $info.LastRunTime
        LastTaskResult = $info.LastTaskResult   # 0 = success
        NextRunTime    = $info.NextRunTime
    } | Format-List
    return
}

if ($Minutes -lt 5 -or $Minutes -gt 60) {
    throw "Interval must be between 5 and 60 minutes (got $Minutes)."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH. Install Node.js 18+ first." }

$entry = Join-Path $ScriptDir 'index.mjs'
if (-not (Test-Path $entry)) { throw "Cannot find $entry" }

# Replace any existing registration so re-running this is idempotent.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`"" -WorkingDirectory $ScriptDir

# A repeating trigger of effectively unlimited duration, starting one interval
# from now so registering the task does not immediately fire a scan.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $Minutes)

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description "Aegis-Crypto: scans new token launches every $Minutes minutes and writes Obsidian notes." | Out-Null

Write-Host "Registered '$TaskName' — runs every $Minutes minutes while you are logged on." -ForegroundColor Green
Write-Host "  Status : .\schedule-task.ps1 -Status"
Write-Host "  Remove : .\schedule-task.ps1 -Remove"
