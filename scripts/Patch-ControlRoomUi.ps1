[CmdletBinding()]
param([string]$InstallRoot)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Historical entrypoint retained for setup/upgrade compatibility.
#
# IMPORTANT: this script intentionally does NOT patch any DeepSeek Harness
# node_modules bundle. The old implementation rewrote
# @deepseek-ai/dsh-client-ui-agent-preset/lib/client.js and therefore depended
# on exact compiled upstream text. Nexus now owns the new-session mode lifecycle
# in @nexus/mode-selector and talks only to public client services.

. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot

$source = Join-Path $layout.Root 'ui/nexus-mode-selector'
$manifest = Join-Path $source 'package.json'
$client = Join-Path $source 'lib/client.js'
$hostPath = Join-Path $source 'lib/index.js'
foreach ($required in @($manifest, $client, $hostPath)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Nexus mode-selector source is missing: $required"
    }
}

$profileModules = Join-Path $layout.Data 'profiles/node_modules'
$scopeDirectory = Join-Path $profileModules '@nexus'
$target = Join-Path $scopeDirectory 'mode-selector'
New-Item -ItemType Directory -Force -Path $scopeDirectory | Out-Null
if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
}
Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
foreach ($required in @('package.json', 'lib\client.js', 'lib\index.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $target $required))) {
        throw "Failed to install @nexus/mode-selector file: $required"
    }
}

# Fresh installs receive this row from config/home.cordis.patch.yml. Keep a
# narrow migration for older managed data so running this compatibility
# entrypoint directly also upgrades the composition without touching upstream.
$cordisPatch = Join-Path $layout.Data 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $cordisPatch)) {
    throw "Managed cordis.patch.yml is missing at $cordisPatch"
}
$text = Get-Content -Raw -Encoding UTF8 -LiteralPath $cordisPatch
if (-not $text.Contains("'@nexus/mode-selector'")) {
    $pattern = "(?m)^(    - id: nexus-controller\r?\n      name: '@nexus/controller'\r?\n)"
    $matches = [regex]::Matches($text, $pattern).Count
    if ($matches -ne 1) {
        throw "cordis.patch.yml structure changed for Nexus mode-selector migration (matches: $matches). Refusing an unsafe edit."
    }
    $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $row = '    - id: nexus-mode-selector' + $newline + "      name: '@nexus/mode-selector'" + $newline
    $text = [regex]::Replace($text, $pattern, ('$1' + $row), 1)
    [IO.File]::WriteAllText($cordisPatch, $text, [Text.UTF8Encoding]::new($false))
}

Write-Host 'Installed Nexus-owned mode selector; no upstream Control Room UI patch is required.'
