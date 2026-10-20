@echo off
setlocal enabledelayedexpansion
title Oraforge eTIMS Cloud Agent

cd /d "%~dp0"

echo ============================================================
echo   Oraforge eTIMS Cloud Agent Starter
echo ============================================================
echo.

:: 1. Check & start local helper if needed
tasklist /FI "IMAGENAME eq OraforgeEtims.exe" 2>NUL | find /I /N "OraforgeEtims.exe">NUL
if "%ERRORLEVEL%"=="1" (
    if exist "%~dp0runtime\etims\OraforgeEtims\OraforgeEtims.exe" (
        echo [INFO] Starting local Oraforge eTIMS companion in background...
        start "" "%~dp0runtime\etims\OraforgeEtims\OraforgeEtims.exe"
        timeout /t 2 /nobreak >nul
    )
)

set "NODE_EXE="
if exist "%~dp0dist\windows\OraforgePOS\runtime\node.exe" set "NODE_EXE=%~dp0dist\windows\OraforgePOS\runtime\node.exe"
if not defined NODE_EXE if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if not defined NODE_EXE where node.exe >nul 2>&1 && set "NODE_EXE=node.exe"

if not defined NODE_EXE (
    echo [ERROR] Node.js was not found.
    echo Please install Node.js from https://nodejs.org or extract the full Oraforge package.
    echo.
    pause
    exit /b 1
)

:: Choose worker script (Supabase worker preferred for $0 serverless architecture)
set "WORKER_JS="
if exist "%~dp0capacitor\etims-supabase-worker.js" set "WORKER_JS=%~dp0capacitor\etims-supabase-worker.js"
if not defined WORKER_JS if exist "%~dp0etims-supabase-worker.js" set "WORKER_JS=%~dp0etims-supabase-worker.js"
if not defined WORKER_JS if exist "%~dp0capacitor\etims-cloud-agent.js" set "WORKER_JS=%~dp0capacitor\etims-cloud-agent.js"
if not defined WORKER_JS if exist "%~dp0etims-cloud-agent.js" set "WORKER_JS=%~dp0etims-cloud-agent.js"

echo Using Node runtime: "!NODE_EXE!"
echo Starting agent: "!WORKER_JS!"
echo.

"!NODE_EXE!" "!WORKER_JS!" %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Agent stopped with error code %ERRORLEVEL%.
    pause
)
