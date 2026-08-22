@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0UnderTree.exe" "%~dp0resources\app.asar\cli.mjs" %*
exit /b %ERRORLEVEL%
