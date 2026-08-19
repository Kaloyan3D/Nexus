@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\Detect-Project.ps1" %*
exit /b %ERRORLEVEL%
