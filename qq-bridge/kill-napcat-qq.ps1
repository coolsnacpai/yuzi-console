$killed = 0
Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like 'D:\NapCat\*' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  $killed++
}
Write-Output "killed=$killed"