@echo off
title Reset Oraforge eTIMS Helper Cache
color 0E
cls
echo ==============================================================================
echo                 ORAFORGE eTIMS HELPER - CACHE RESET TOOL
echo ==============================================================================
echo This utility clears stale product mappings and cached job states from:
echo   %%LOCALAPPDATA%%\OraforgePOS\etims
echo.
echo Use this whenever you reinstall eTIMS Client, rebuild the eTIMS database,
echo or see "Saved POS product registration differs from active eTIMS product".
echo ==============================================================================
echo.

set TARGET_DIR=%LOCALAPPDATA%\OraforgePOS\etims

if not exist "%TARGET_DIR%" (
    echo [INFO] Helper cache directory does not exist yet: %TARGET_DIR%
    echo Nothing to clear.
    goto done
)

echo [1/3] Stopping any running helper processes...
taskkill /F /IM python.exe /FI "WINDOWTITLE eq *Oraforge*" >nul 2>&1
taskkill /F /IM python.exe /FI "WINDOWTITLE eq *eTIMS*" >nul 2>&1

echo [2/3] Removing stale companion databases and product mappings...
if exist "%TARGET_DIR%\companion.sqlite3" (
    del /f /q "%TARGET_DIR%\companion.sqlite3*" >nul 2>&1
    echo       - Removed companion.sqlite3
)
if exist "%TARGET_DIR%\store.sqlite" (
    del /f /q "%TARGET_DIR%\store.sqlite*" >nul 2>&1
    echo       - Removed store.sqlite
)
if exist "%TARGET_DIR%\active-run.lock" (
    del /f /q "%TARGET_DIR%\active-run.lock" >nul 2>&1
    echo       - Removed active-run.lock
)
if exist "%TARGET_DIR%\ledger" (
    rmdir /s /q "%TARGET_DIR%\ledger" >nul 2>&1
    echo       - Cleared ledger folder
)
if exist "%TARGET_DIR%\imports" (
    rmdir /s /q "%TARGET_DIR%\imports" >nul 2>&1
    echo       - Cleared imports folder
)

echo [3/3] Cache cleared successfully!
echo.
echo On next checkout, the helper will cleanly synchronize directly with your
echo current active eTIMS Paypoint database.

:done
echo.
echo ==============================================================================
echo Press any key to close this window.
echo ==============================================================================
pause >nul
