@echo off
REM ============================================================
REM  Job Hunter Workbench - Local Collector launcher
REM
REM  Double-click this file. It starts the local collector service
REM  (foreground console) and opens the workbench in your browser.
REM  Keep this window open while you work; closing it stops the service.
REM
REM  (This file is intentionally ASCII-only: Chinese text inside a
REM   .cmd body gets mangled under the default GBK console. All the
REM   friendly Chinese output is printed by server.py instead.)
REM ============================================================
chcp 65001 >nul
setlocal enabledelayedexpansion
title Job Hunter Collector

REM Force UTF-8 for the python child. Without this, python writes the console
REM (and any redirected log) in GBK, and a single non-GBK character in a print
REM would crash startup. server.py's own data\server.log is always UTF-8.
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

set "PY=C:\Users\1\.workbuddy\binaries\python\envs\boss-crawler\Scripts\python.exe"
if not exist "%PY%" (
  REM Do NOT fall back to a bare "python" on PATH: boss-crawler pins requests
  REM 2.34 / lxml 6 that clash with the default env, so that path fails deeper
  REM and more confusingly. Fail here, loud, with the exact rebuild command.
  echo.
  echo [ERROR] Collector virtualenv not found:
  echo         %PY%
  echo.
  echo The workbench itself still works; only "collect jobs" is unavailable.
  echo Rebuild the venv with:
  echo   python -m venv C:\Users\1\.workbuddy\binaries\python\envs\boss-crawler
  echo   C:\Users\1\.workbuddy\binaries\python\envs\boss-crawler\Scripts\pip install -r C:\Users\1\.workbuddy\skills\boss-crawler\requirements.txt
  echo.
  pause
  exit /b 1
)

REM Locate server.py in the collector subfolder. Using a wildcard loop
REM avoids hard-coding a non-ASCII folder name inside the batch file.
set "APP="
for /d %%D in ("%~dp0*") do (
  if exist "%%~fD\server.py" set "APP=%%~fD\server.py"
)
if not defined APP (
  echo.
  echo [ERROR] server.py not found in any subfolder of:
  echo         %~dp0
  echo.
  pause
  exit /b 1
)

REM Directory holding server.py / its data\ folder (avoid hard-coding Chinese).
for %%A in ("%APP%") do set "COLLDIR=%%~dpA"

REM Ports to probe. server.py's PORT_CANDIDATES is the single source of truth;
REM prefer the last-run port from data\collector.port, then fall back to the
REM default list. (the core unit test asserts these lists stay in sync.)
set "PORTS=8738 8739 8740"
if exist "%COLLDIR%data\collector.port" (
  set /p LASTRUN=<"%COLLDIR%data\collector.port"
  if defined LASTRUN set "PORTS=!LASTRUN! 8738 8739 8740"
)

REM Edge is pointed at by server.py's subprocess_env() (EDGE_CANDIDATES), so we
REM do NOT set CHROME_PATH here - setting it in two places is how the two drift.

REM ------------------------------------------------------------
REM Already running? Then just open the page.
REM Double-clicking this repeatedly used to pile up one service per
REM click (8738, then 8739, then 8740...) plus a browser tab each,
REM which is what made people think "it never starts". Probe the known
REM ports first; if one is already LISTENING, just open the workbench
REM and exit without starting a second service.
REM ------------------------------------------------------------
set "LIVEPORT="
for %%P in (%PORTS%) do (
  if not defined LIVEPORT (
    for /f "tokens=5" %%X in ('netstat -ano ^| findstr /c:"127.0.0.1:%%P " ^| findstr /c:"LISTENING"') do (
      set "LIVEPORT=%%P"
    )
  )
)
if defined LIVEPORT (
  echo.
  echo [Collector already running on port %LIVEPORT%]
  echo Opening the workbench - not starting a second service.
  start "" "http://127.0.0.1:%LIVEPORT%/"
  timeout /t 3 >nul 2>&1
  endlocal
  exit /b 0
)

REM ------------------------------------------------------------
REM Not running: start it. server.py prints the banner (including the
REM actual port) into THIS console, so the window itself is the
REM "visible feedback". On a non-zero exit it pauses below, so a
REM crash never disappears silently.
REM ------------------------------------------------------------
"%PY%" "%APP%" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [Collector exited with code %CODE%]
  echo If the browser never opened, read the log at:
  echo   <collector folder>\data\server.log
  pause
)
endlocal
