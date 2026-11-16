@echo off
chcp 65001 >nul
title 大肥鱼 QQ 桥接
cd /d "%~dp0"
node bot.mjs
echo.
echo 程序已退出，按任意键关闭窗口...
pause >nul
