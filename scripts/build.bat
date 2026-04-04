@echo off
REM ──────────────────────────────────────────────────
REM AE MCP Bridge — Build MCP Server
REM Compiles TypeScript and prepares for production.
REM ──────────────────────────────────────────────────

echo.
echo === AE MCP Bridge — Build ===
echo.

cd /d "%~dp0.."

echo Installing dependencies...
call npm install

echo.
echo Compiling TypeScript...
cd packages\mcp-server
call npx tsc

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: TypeScript compilation failed.
    pause
    exit /b 1
)

echo.
echo === Build complete! ===
echo Output: packages\mcp-server\dist\
echo.
echo Add to Claude Code config (~/.claude.json):
echo   {
echo     "mcpServers": {
echo       "ae-bridge": {
echo         "command": "node",
echo         "args": ["%CD%\dist\index.js"]
echo       }
echo     }
echo   }
echo.
pause
