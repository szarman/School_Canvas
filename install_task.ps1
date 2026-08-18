<#
  Registers a Windows scheduled task that runs run_daily.py.

  Defaults to 6:00 AM, 6:00 PM and 11:00 PM -- morning check, after school,
  and an end-of-day catch-up.

  Usage:
      powershell -ExecutionPolicy Bypass -File .\install_task.ps1
      powershell -ExecutionPolicy Bypass -File .\install_task.ps1 -At 07:00,16:00
      powershell -ExecutionPolicy Bypass -File .\install_task.ps1 -Remove

  The task runs as the current user, only while that user is logged on, so
  no password is stored anywhere. StartWhenAvailable makes it catch up on the
  next login if the machine was off at a scheduled time.
#>

param(
    [string[]]$At = @("06:00", "18:00", "23:00"),
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$TaskName = "Canvas Homework Board"
$Root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script   = Join-Path $Root "run_daily.py"

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "No scheduled task named '$TaskName' was found."
    }
    return
}

if (-not (Test-Path $Script)) {
    throw "Could not find run_daily.py next to this script ($Script)."
}

# pythonw.exe runs without popping a console window on a scheduled run.
$python = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
if (-not $python) { throw "Python is not on PATH. Install it or edit this script with a full path." }

Write-Host "Python:  $python"
Write-Host "Script:  $Script"
Write-Host "Times:   $($At -join ', ') daily"

$action    = New-ScheduledTaskAction -Execute $python -Argument "`"$Script`"" -WorkingDirectory $Root
# One daily trigger per time; Register-ScheduledTask takes them as an array.
$triggers  = @($At | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
                                          -AllowStartIfOnBatteries `
                                          -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
                       -Principal $principal -Settings $settings -Force `
                       -Description "Pulls Canvas assignments and grades, then publishes the homework board." | Out-Null

Write-Host ""
Write-Host "Registered '$TaskName'."
Write-Host "Run it now with:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check the result in scrape.log."
