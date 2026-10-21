@echo off
setlocal enabledelayedexpansion
title Oraforge POS - SQLite to Supabase Cloud Migration Tool

cd /d "%~dp0"

echo ============================================================
echo   Oraforge POS - SQLite to Supabase Cloud Migration Tool
echo ============================================================
echo.

:: 1. Locate Node.js runtime
set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if not defined NODE_EXE if exist "%~dp0dist\windows\OraforgePOS\runtime\node.exe" set "NODE_EXE=%~dp0dist\windows\OraforgePOS\runtime\node.exe"
if not defined NODE_EXE where node.exe >nul 2>&1 && set "NODE_EXE=node.exe"

if not defined NODE_EXE (
    echo [ERROR] Bundled Node.js runtime was not found!
    echo Please make sure this script is inside C:\Oraforge-eTIMS-Companion
    pause
    exit /b 1
)

:: 2. Locate sqlite file (Drag-and-drop or auto-detect)
set "SQLITE_FILE=%~f1"

if not defined SQLITE_FILE if exist "pos.sqlite3" set "SQLITE_FILE=%~dp0pos.sqlite3"
if not defined SQLITE_FILE if exist "data\pos.sqlite3" set "SQLITE_FILE=%~dp0data\pos.sqlite3"
if not defined SQLITE_FILE if exist "dist\windows\OraforgePOS\pos.sqlite3" set "SQLITE_FILE=%~dp0dist\windows\OraforgePOS\pos.sqlite3"
if not defined SQLITE_FILE if exist "dist\windows\OraforgePOS\data\pos.sqlite3" set "SQLITE_FILE=%~dp0dist\windows\OraforgePOS\data\pos.sqlite3"
if not defined SQLITE_FILE if exist "C:\Users\Admin\Downloads\POS_APK-Linux_Deployment\POS_APK-Linux_Deployment\dist\windows\OraforgePOS\pos.sqlite3" (
    set "SQLITE_FILE=C:\Users\Admin\Downloads\POS_APK-Linux_Deployment\POS_APK-Linux_Deployment\dist\windows\OraforgePOS\pos.sqlite3"
)

if not defined SQLITE_FILE (
    echo [PROMPT] Drag and drop pos.sqlite3 onto this window and press ENTER:
    set /p "USER_INPUT=Path: "
    for /f "tokens=*" %%F in ("!USER_INPUT!") do set "SQLITE_FILE=%%~fF"
)

if not exist "!SQLITE_FILE!" (
    echo.
    echo [ERROR] File not found: "!SQLITE_FILE!"
    echo Please check the file path and try again.
    pause
    exit /b 1
)

echo [INFO] Using Runtime:    "!NODE_EXE!"
echo [INFO] Found SQLite DB:  "!SQLITE_FILE!"
echo.

"!NODE_EXE!" "%~dp0migrate-sqlite-to-supabase.js" "!SQLITE_FILE!"

echo.
echo ============================================================
echo   Migration Finished.
echo ============================================================
pause
