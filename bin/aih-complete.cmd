@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\Complete-Objective.ps1" %*
exit /b %ERRORLEVEL%
