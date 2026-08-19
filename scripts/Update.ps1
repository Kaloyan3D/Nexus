[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\AI-Harness',
    [string]$SourceRoot
)

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = Split-Path -Parent $PSScriptRoot
}
$setup = Join-Path $SourceRoot 'scripts\Setup.ps1'
if (-not (Test-Path -LiteralPath $setup)) {
    throw "Update source does not contain scripts\Setup.ps1: $SourceRoot"
}
& $setup -InstallRoot $InstallRoot
