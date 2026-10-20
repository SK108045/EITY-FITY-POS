@echo off
setlocal enabledelayedexpansion
title Oraforge eTIMS Cloud Agent

cd /d "%~dp0.."

set "NODE_EXE="
if exist "%~dp0..\dist\windows\OraforgePOS\runtime\node.exe" set "NODE_EXE=%~dp0..\dist\windows\OraforgePOS\runtime\node.exe"
if not defined NODE_EXE if exist "%~dp0..\runtime\node.exe" set "NODE_EXE=%~dp0..\runtime\node.exe"
if not defined NODE_EXE where node.exe >nul 2>&1 && set "NODE_EXE=node.exe"

if not defined NODE_EXE (
    echo [ERROR] Node.js was not found.
    pause
    exit /b 1
)

"!NODE_EXE!" "%~dp0..\capacitor\etims-cloud-agent.js" %*

if %ERRORLEVEL% neq 0 pause
