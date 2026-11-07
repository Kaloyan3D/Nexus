[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$PayloadFile
)

# NexusModeDefault.ps1 - persist the operator's mode choice as the default for NEW sessions.
#
# DSH 0.2.x pins `agent-preset-registry` from the generated Nexus home patch, so the DSH
# settings namespace refuses writes ("overridden by a home patch"). The Nexus-owned
# nexus-settings.yaml is the single source (the launcher reads it and regenerates the patch
# on the next start), written through the same atomic, mutex-guarded writer the launcher
# uses. Only the two supported presets are accepted; the request carries no path.
#
# Payload: { "preset": "aih-engineering" | "aih-deepseek" }   Output: { ok, preset }

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
. (Join-Path $PSScriptRoot 'ControlRoom.ps1')

$allowed = @('aih-engineering', 'aih-deepseek')
if ([string]::IsNullOrWhiteSpace($PayloadFile) -or -not (Test-Path -LiteralPath $PayloadFile)) { throw 'Payload file not found.' }
$payload = Get-Content -Raw -Encoding UTF8 -LiteralPath $PayloadFile | ConvertFrom-Json
$preset = if ($null -ne $payload.PSObject.Properties['preset']) { [string]$payload.preset } else { '' }
if ($allowed -notcontains $preset) { throw "Unsupported preset: $preset" }

$layout = Get-AihLayout $InstallRoot
$routingPolicy = Get-AihRoutingPolicy $layout.RoutingPolicy
$mode = Get-AihControlRoomMode -RoutingPolicy $routingPolicy -Preset $preset
if ($allowed -notcontains [string]$mode.Id) { throw "Unsupported mode: $($mode.Id)" }
# The generated home patch pins agent-preset-registry.default from nexus-settings.yaml (read at
# the next DSH start). Save, regenerate and verify as one unit; any failure restores both files.
$patchPath = Join-Path $layout.Data 'cordis.patch.yml'
$settingsBackup = if (Test-Path -LiteralPath $layout.Settings) { [IO.File]::ReadAllBytes($layout.Settings) } else { $null }
$patchBackup = if (Test-Path -LiteralPath $patchPath) { [IO.File]::ReadAllBytes($patchPath) } else { $null }
try {
    Set-AihControlRoomDefault -SettingsPath $layout.Settings -Mode $mode
    & $layout.Node (Join-Path $layout.Scripts 'Build-NexusHomePatch.cjs') $InstallRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The Nexus home patch could not be regenerated.' }
    & $layout.Node (Join-Path $layout.Scripts 'Verify-NexusComposition.mjs') $InstallRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The regenerated Nexus home patch failed composition verification.' }
}
catch {
    if ($null -ne $settingsBackup) { [IO.File]::WriteAllBytes($layout.Settings, $settingsBackup) }
    if ($null -ne $patchBackup) { [IO.File]::WriteAllBytes($patchPath, $patchBackup) }
    throw
}
ConvertTo-Json -InputObject ([ordered]@{ ok = $true; preset = [string]$mode.Id }) -Compress
