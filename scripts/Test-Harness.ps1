[CmdletBinding()]
param([string]$InstallRoot = 'C:\AI-Harness')

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Harness.Tests.ps1') -InstallRoot $InstallRoot
exit $LASTEXITCODE
