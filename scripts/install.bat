@echo off
REM ──────────────────────────────────────────────────
REM AE MCP Bridge — Install CEP Panel
REM Creates a symlink from the cep-panel directory
REM to Adobe's CEP extensions folder.
REM ──────────────────────────────────────────────────

set EXTENSION_ID=com.apollova.ae.bridge
set CEP_DIR=%APPDATA%\Adobe\CEP\extensions
set PANEL_SRC=%~dp0..\packages\cep-panel

echo.
echo === AE MCP Bridge — CEP Panel Installer ===
echo.

REM Create CEP extensions directory if it doesn't exist
if not exist "%CEP_DIR%" (
    echo Creating CEP extensions directory...
    mkdir "%CEP_DIR%"
)

REM Remove existing symlink/directory
if exist "%CEP_DIR%\%EXTENSION_ID%" (
    echo Removing existing installation...
    rmdir "%CEP_DIR%\%EXTENSION_ID%" 2>nul
    if exist "%CEP_DIR%\%EXTENSION_ID%" (
        echo ERROR: Could not remove existing installation.
        echo Close After Effects and try again.
        pause
        exit /b 1
    )
)

REM Create symlink
echo Creating symlink...
echo   From: %PANEL_SRC%
echo   To:   %CEP_DIR%\%EXTENSION_ID%
mklink /D "%CEP_DIR%\%EXTENSION_ID%" "%PANEL_SRC%"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: Symlink creation failed.
    echo Try running this script as Administrator.
    pause
    exit /b 1
)

REM Install ws module in CEP panel
echo.
echo Installing ws module for CEP panel...
cd "%PANEL_SRC%"
if not exist "node_modules\ws" (
    npm install ws --save --prefix .
)

echo.
echo === Installation complete! ===
echo.
echo Next steps:
echo   1. Run enable-unsigned.bat (if not done already)
echo   2. Restart After Effects
echo   3. Window ^> Extensions ^> AE MCP Bridge
echo.
pause
