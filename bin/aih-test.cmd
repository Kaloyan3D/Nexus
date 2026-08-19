@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\Test-Harness.ps1" %*
exit /b %ERRORLEVEL%
