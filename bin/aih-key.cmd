@echo off
setlocal
for %%I in ("%~dp0..") do set "AIH_ROOT=%%~fI"
set "AIH_INSTALL_ROOT=%AIH_ROOT%"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%AIH_ROOT%\scripts\Set-DeepSeekKey.ps1" -InstallRoot "%AIH_ROOT%" %*
exit /b %ERRORLEVEL%
