# 输出 set "KEY=VALUE" 行，由 autostart.bat 的 for /f 直接执行
# 目的：让 NapCat 拿到快速登录凭据，掉线时不必每次扫码
$root = $PSScriptRoot
$envFile = Join-Path $root '.env'
$keys = 'NAPCAT_QUICK_ACCOUNT', 'NAPCAT_QUICK_PASSWORD', 'NAPCAT_QUICK_PASSWORD_MD5'
$vals = @{}
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile -Encoding UTF8) {
        if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$') {
            $k = $Matches[1]
            if ($keys -contains $k) { $vals[$k] = $Matches[2].Trim('"', "'") }
        }
    }
}
if (-not $vals.ContainsKey('NAPCAT_QUICK_ACCOUNT')) {
    $botQq = Join-Path $root 'data\bot-qq.txt'
    if (Test-Path $botQq) { $vals['NAPCAT_QUICK_ACCOUNT'] = (Get-Content $botQq -Raw).Trim() }
}
foreach ($k in $keys) {
    if ($vals.ContainsKey($k) -and $vals[$k]) { Write-Output ('set "{0}={1}"' -f $k, $vals[$k]) }
}
