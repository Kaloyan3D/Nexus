@echo off
setlocal
set "AIH_ROOT=%AIH_INSTALL_ROOT%"
if not defined AIH_ROOT set "AIH_ROOT=C:\AI-Harness"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%AIH_ROOT%\scripts\Stop.ps1" -InstallRoot "%AIH_ROOT%" %*
exit /b %ERRORLEVEL%
