@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
rem 小号 QQ：优先读 data\bot-qq.txt，其次 .env 的 BOT_QQ，最后用默认值
set "BOTQ=10001"
if exist "%~dp0data\bot-qq.txt" set /p BOTQ=<"%~dp0data\bot-qq.txt"
cd /d "%~dp0"
set "LOG=%~dp0data\boot.log"
set "NAP=D:\NapCat\NapCat.52230.Shell"
set "QR=%NAP%\versions\9.9.33-52230\resources\app\napcat\cache\qrcode.png"
if not exist "data" mkdir "data"

rem ---------- 0.1) NapCat 快速登录凭据（从 .env 读取，失败不影响主流程） ----------
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0napcat-env.ps1"`) do @%%L

rem ---------- 0) 单实例锁 ----------
if exist "data\runlock" (
  powershell -NoProfile -Command "$alive=@(Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -match 'autostart' }).Count; if ($alive -gt 0) { exit 1 } else { exit 0 }" >nul 2>&1
  if errorlevel 1 (
    powershell -NoProfile -Command "$d=(Get-Item 'data\runlock').LastWriteTime; if (((Get-Date)-$d).TotalMinutes -gt 4) { exit 0 } else { exit 1 }" >nul 2>&1
    if not errorlevel 1 rmdir "data\runlock" >nul 2>&1
  )
)
2>nul mkdir "data\runlock"
if errorlevel 1 (echo [%date% %time%] 上一轮自检还没跑完，本轮跳过>>"%LOG%" & exit /b 0)
echo [%date% %time%] ===== 自检 =====>>"%LOG%"

rem ---------- 1) DSH 保活 ----------
powershell -NoProfile -Command "if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { Start-Process 'D:\DeepSeek Harness\DeepSeek Harness.exe' }" >nul 2>&1

rem ---------- 2) 先把不依赖 NapCat 的三件拉起来（控制台要能看见二维码） ----------
call :startconsole
call :startbot
call :startwatch

rem ---------- 3) 3001 已在就收工 ----------
netstat -an | findstr /C:"127.0.0.1:3001" | findstr /I "LISTENING" >nul
if not errorlevel 1 (
  echo [%date% %time%] 3001 已在监听>>"%LOG%"
  goto done
)

rem ---------- 4) 二维码新鲜（5 分钟内）= 正在等手机扫码，别重启，一重启又要重新扫 ----------
powershell -NoProfile -Command "$p='%QR%'; if (Test-Path $p) { $m=((Get-Date)-(Get-Item $p).LastWriteTime).TotalMinutes; if ($m -lt 12) { Write-Host ([int]$m); exit 0 } }; exit 1" > "%TEMP%\qrage.txt" 2>nul
if not errorlevel 1 (
  set /p QA=<"%TEMP%\qrage.txt"
  echo [%date% %time%] 二维码 !QA! 分钟前刚生成，在等手机扫码，本轮不重启 NapCat>>"%LOG%"
  goto done
)

rem ---------- 5) 冷却判定 ----------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0should-retry.ps1" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] NapCat 冷却中（3 分钟内刚试过且仍有进程在），本轮跳过>>"%LOG%"
  goto done
)

if not exist "%NAP%\NapCatWinBootMain.exe" (
  echo [%date% %time%] 找不到 NapCat，跳过>>"%LOG%"
  goto done
)

powershell -NoProfile -Command "Get-Date -Format 'o' | Set-Content 'data\lasttry.txt'" >nul 2>&1
del /q "%LOCALAPPDATA%\CrashDumps\QQ.exe.*.dmp" >nul 2>&1

rem ---------- 6) 后端在就先等，等不到再硬重启 ----------
powershell -NoProfile -Command "if (Get-Process -Name NapCatWinBootMain -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo [%date% %time%] NapCat 后端已在，等它把 3001 拉起来>>"%LOG%"
  call :wait3001 30
  if not errorlevel 1 goto done
  echo [%date% %time%] 后端僵着，3001 没起来 → 硬重启 NapCat>>"%LOG%"
)

call :killnap
echo [%date% %time%] 启动 NapCat …>>"%LOG%"
start "" /b /d "%NAP%" "%NAP%\NapCatWinBootMain.exe" %BOTQ%
call :wait3001 45
if not errorlevel 1 goto done

echo [%date% %time%] 重启一次仍没 3001，硬重启再等>>"%LOG%"
call :killnap
start "" /b /d "%NAP%" "%NAP%\NapCatWinBootMain.exe" %BOTQ%
call :wait3001 45
if not errorlevel 1 goto done

echo [%date% %time%] 仍没 3001，大概率要手机上扫码登录小号；控制台「登录二维码」在那里>>"%LOG%"

:done
echo [%date% %time%] 完成>>"%LOG%"
rmdir "data\runlock" 2>nul
exit /b 0

rem ---------- 子过程 ----------
:startconsole
netstat -an | findstr /C:"127.0.0.1:3210" | findstr /I "LISTENING" >nul
if not errorlevel 1 exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\DSH\start-console.ps1" >nul 2>&1
exit /b 0

:startbot
netstat -an | findstr /C:"127.0.0.1:3008" | findstr /I "LISTENING" >nul
if not errorlevel 1 exit /b 0
echo [%date% %time%] 启动 bot …>>"%LOG%"
start "" /b /d "%~dp0" cmd /c "node bot.mjs >> data\bot.log 2>&1"
exit /b 0

:startwatch
netstat -an | findstr /C:"127.0.0.1:3009" | findstr /I "LISTENING" >nul
if not errorlevel 1 (
  echo [%date% %time%] 空间监听已在>>"%LOG%"
  exit /b 0
)
netstat -an | findstr /C:"127.0.0.1:9333" | findstr /I "LISTENING" >nul
if errorlevel 1 (
  echo [%date% %time%] 启动无头 Edge …>>"%LOG%"
  start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --remote-debugging-port=9333 --user-data-dir="D:\DeepSeek test\qq-bridge\data\edge-profile" --no-first-run --disable-gpu --window-size=1280,900
  timeout /t 6 /nobreak >nul
)
echo [%date% %time%] 启动空间监听 …>>"%LOG%"
start "" /b /d "%~dp0" cmd /c "node qz_watch.mjs >> data\qzone.log 2>&1"
exit /b 0

:killnap
powershell -NoProfile -Command "Get-Process NapCatWinBootMain -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-napcat-qq.ps1" >nul 2>&1
timeout /t 3 /nobreak >nul
exit /b 0

:wait3001
set /a n=0
:waitloop
set /a n+=1
netstat -an | findstr /C:"127.0.0.1:3001" | findstr /I "LISTENING" >nul
if not errorlevel 1 exit /b 0
if %n% geq %~1 exit /b 1
timeout /t 2 /nobreak >nul
goto waitloop