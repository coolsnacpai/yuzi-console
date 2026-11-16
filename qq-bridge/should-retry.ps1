# Decide whether watchdog may restart NapCat: exit 0 = yes, exit 1 = cooling down
$dataDir = Join-Path $PSScriptRoot "data"
$f = Join-Path $dataDir "lasttry.txt"
if (-not (Test-Path $f)) { exit 0 }
try { $t = [datetimeoffset]::Parse((Get-Content $f -Raw).Trim()) } catch { exit 0 }
try {
    $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    if ($t.DateTime -lt $boot) { exit 0 }
} catch { }
$procs = @(Get-Process -Name QQ, NapCatWinBootMain -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { exit 0 }
$age = ((Get-Date) - $t.DateTime).TotalMinutes
$cooldown = 12
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    $line = Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -match "^\s*NAPCAT_RETRY_COOLDOWN\s*=" } | Select-Object -First 1
    if ($line) { $cooldown = [int](($line -split "=", 2)[1].Trim()) }
}
if ($age -ge $cooldown) { exit 0 }
exit 1