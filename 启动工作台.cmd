@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 内容管理工作台
if not exist "runtime\python.exe" (
  echo 未找到项目运行环境，请保留完整项目文件夹并查看 docs\使用说明.md。
  pause
  exit /b 1
)
"runtime\python.exe" -X utf8 run.py
if errorlevel 1 pause
