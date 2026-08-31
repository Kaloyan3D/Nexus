[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$SourceRoot
)

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = Split-Path -Parent $PSScriptRoot
}
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = $SourceRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

$setup = Join-Path $SourceRoot 'scripts\Setup.ps1'
if (-not (Test-Path -LiteralPath $setup)) {
    throw "Update source does not contain scripts\Setup.ps1: $SourceRoot"
}
& $setup -InstallRoot $InstallRoot
