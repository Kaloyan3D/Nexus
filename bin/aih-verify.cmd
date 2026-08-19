@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\Verify-Project.ps1" %*
exit /b %ERRORLEVEL%
