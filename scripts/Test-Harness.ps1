[CmdletBinding()]
param([string]$InstallRoot = 'C:\AI-Harness')

. (Join-Path $InstallRoot 'scripts\Common.ps1')
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Harness.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\ControllerRouting.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Get-AihLayout $InstallRoot).Node (Join-Path $InstallRoot 'tests\AihController.Tests.cjs')
exit $LASTEXITCODE
