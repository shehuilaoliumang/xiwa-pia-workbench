@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 喜娃微 PIA 工作台 · 浏览器模式
if not exist "runtime\python.exe" (
  echo 请先将完整压缩包解压到普通文件夹，不要在压缩包里直接打开。
  pause
  exit /b 1
)
"runtime\python.exe" -X utf8 run.py --browser
if errorlevel 1 pause
