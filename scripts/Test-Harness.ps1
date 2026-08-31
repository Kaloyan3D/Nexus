[CmdletBinding()]
param([string]$InstallRoot)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

. (Join-Path $InstallRoot 'scripts\Common.ps1')
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\SetupUpgrade.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Harness.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\ControllerRouting.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# TASK-0005: controller identity hardening (immutable task lifecycle identity).
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\TaskIdentity.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\EngineeringProfiles.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\EngineeringProfileEditor.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Intelligence.Registry.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Intelligence.Scanning.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Intelligence.Snapshots.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Intelligence.EndToEnd.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# Phase 3.1 hardening (Part 0)
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Intelligence.IgnoreRegression.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Intelligence.SnapshotModules.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# Phase 3.2: deterministic code intelligence
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Intelligence.CodeFoundation.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Intelligence.CodeParsing.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Intelligence.CodeIntelligence.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tests\Intelligence.CodeScale.Tests.ps1') -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Get-AihLayout $InstallRoot).Node (Join-Path $InstallRoot 'tests\AihController.Tests.cjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# TASK-0005: session binding validation/recovery + Control Room identity joins.
& (Get-AihLayout $InstallRoot).Node (Join-Path $InstallRoot 'tests\AihControllerIdentity.Tests.cjs')
exit $LASTEXITCODE
