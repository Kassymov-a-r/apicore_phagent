$ErrorActionPreference = "Stop"
$videoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$videoPython = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\pythonw.exe"
$videoRunner = Join-Path $videoRoot "run_windows.py"
$videoIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path $videoPython)) { throw "Python 3.12 not found. Run start_video_bot.bat first." }
if (-not (Test-Path (Join-Path $videoRoot ".env"))) { throw "Configure .env with start_video_bot.bat first." }
$videoAction = New-ScheduledTaskAction -Execute $videoPython -Argument "`"$videoRunner`"" -WorkingDirectory $videoRoot
$videoTrigger = New-ScheduledTaskTrigger -AtLogOn -User $videoIdentity
$videoPrincipal = New-ScheduledTaskPrincipal -UserId $videoIdentity -LogonType Interactive -RunLevel Limited
$videoSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "VIDEO - Telegram Uniquifier" -Action $videoAction `
    -Trigger $videoTrigger -Principal $videoPrincipal -Settings $videoSettings `
    -Description "Video bot: five high-quality variants, runs at user logon" -Force | Out-Null
Write-Host "Autostart installed: VIDEO - Telegram Uniquifier"
Write-Host "It will start at your next Windows logon. Close manual bot windows first."
Write-Host "Start now: Start-ScheduledTask -TaskName 'VIDEO - Telegram Uniquifier'"
Write-Host "Log: $videoRoot\logs\video_bot.log"
