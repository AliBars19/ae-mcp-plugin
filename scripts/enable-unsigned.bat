@echo off
REM ──────────────────────────────────────────────────
REM AE MCP Bridge — Enable Unsigned CEP Extensions
REM Sets the PlayerDebugMode registry key so After
REM Effects loads unsigned CEP panels.
REM ──────────────────────────────────────────────────

echo.
echo === AE MCP Bridge — Enable Unsigned Extensions ===
echo.

REM CSXS versions 9-12 (covers AE 2020-2027)
for %%V in (9 10 11 12) do (
    echo Setting CSXS.%%V PlayerDebugMode = 1
    reg add "HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

echo.
echo Done! Unsigned CEP extensions are now enabled.
echo Restart After Effects for changes to take effect.
echo.
pause
