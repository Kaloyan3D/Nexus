[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$InstallRoot, [string]$SourceRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
$contract = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $SourceRoot 'ui/nexus-ui/composer-contract.json') | ConvertFrom-Json
$updates = @()
foreach ($patch in $contract.patches) {
    $packageRoot = Join-Path $InstallRoot ('app/node_modules/@deepseek-ai/' + $patch.package)
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $packageRoot 'package.json') | ConvertFrom-Json
    if ($manifest.version -ne $contract.version) { throw "Unsupported Nexus composer contract version: $($patch.package) $($manifest.version)" }
    $path = Join-Path $packageRoot 'lib/client.js'
    $original = Get-Content -Raw -Encoding UTF8 -LiteralPath $path
    $text = $original.Replace("`r`n", "`n")
    $beforeCount = ([regex]::Matches($text, [regex]::Escape($patch.before))).Count
    $afterCount = ([regex]::Matches($text, [regex]::Escape($patch.after))).Count
    if ($beforeCount -eq 1 -and $afterCount -eq 0) { $text = $text.Replace($patch.before, $patch.after) }
    elseif ($beforeCount -ne 0 -or $afterCount -ne 1) { throw "Pinned Nexus composer structure changed: $($patch.package). Refusing an unsafe patch." }
    if ($original.Contains("`r`n")) { $text = $text.Replace("`n", "`r`n") }
    $updates += [pscustomobject]@{ Path = $path; Content = $text; Changed = ($text -ne $original) }
}
# Validate both contracts before writing either file.
foreach ($update in $updates) {
    if ($update.Changed) { [IO.File]::WriteAllText($update.Path, $update.Content, [Text.UTF8Encoding]::new($false)) }
}
Write-Host 'PASS: Nexus composer preference-seat contract installed'
