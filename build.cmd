@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 内容管理工作台 · 一键封装交付包

echo ============================================================
echo   一键封装免安装交付包（tools\build_package.py）
echo   产物：dist 目录下的 [短名]-portable-[版本]-[日期].zip
echo         以及同名 .manifest.json 交付清单
echo ============================================================
echo.

if not exist "runtime\python.exe" (
  echo [错误] 未找到便携运行环境 runtime\python.exe。
  echo        请先用已安装的 Python 3.10+ 在本目录运行：
  echo            python tools\prepare_runtime.py
  echo.
  pause
  exit /b 1
)

if not exist "tools\build_package.py" (
  echo [错误] 未找到 tools\build_package.py，请确认本文件位于项目根目录。
  echo.
  pause
  exit /b 1
)

"runtime\python.exe" -X utf8 tools\build_package.py %*
set "BUILD_RESULT=%ERRORLEVEL%"

echo.
if not "%BUILD_RESULT%"=="0" (
  echo [失败] 构建中止，退出码 %BUILD_RESULT%。请按上面的提示处理后重试。
  echo        失败详情也会记录在 dist 目录的 failed.json 文件里。
  echo.
  pause
  exit /b %BUILD_RESULT%
)

echo [结束] build_package.py 正常退出。若是打包运行，交付包就在 dist 目录
echo        （ZIP 与同名 .manifest.json 清单）。
echo        提示：dist 目录没有写进 .gitignore，本工具也不会去改它；
echo              请不要把 dist 目录提交进版本库。
echo.
pause
exit /b 0
