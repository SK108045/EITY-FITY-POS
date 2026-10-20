@echo off
setlocal enabledelayedexpansion
title Oraforge eTIMS Cloud Agent

cd /d "%~dp0"

echo ============================================================
echo   Oraforge eTIMS Cloud Agent Starter
echo ============================================================
echo.

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

echo Using Node runtime: "!NODE_EXE!"
echo Starting agent...
echo.

"!NODE_EXE!" "%~dp0capacitor\etims-cloud-agent.js" %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Agent stopped with error code %ERRORLEVEL%.
    pause
)
