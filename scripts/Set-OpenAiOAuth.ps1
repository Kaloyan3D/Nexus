[CmdletBinding()]
param([string]$InstallRoot)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot

foreach ($required in @($layout.Node, $layout.OAuth)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "OpenAI OAuth setup is unavailable; missing $required. Run setup.ps1 first."
    }
}

Write-Host 'Sign in with your own ChatGPT account using the complete URL printed below.'
Write-Host 'Ctrl+click it, or copy the entire URL into your browser (including every & parameter).'
Write-Host 'The repository never receives or stores your OAuth token.'
Write-Host 'The installed third-party openai-oauth package writes the Codex-compatible auth file under your Windows profile.'

# openai-oauth 2.0.0 launches URLs through `cmd /c start` on Windows. The `&`
# separators in an OAuth query can be interpreted by cmd, truncating the URL
# and causing OpenAI's missing_required_parameter response. Printing the URL
# avoids that third-party launcher bug while preserving the same PKCE flow.
& $layout.Node $layout.OAuth login --no-open
if ($LASTEXITCODE -ne 0) {
    throw 'ChatGPT/Codex OAuth login did not complete successfully.'
}

$authFile = Get-AihCodexAuthFile
if (-not (Test-Path -LiteralPath $authFile -PathType Leaf)) {
    throw "Login completed without creating the expected Codex auth file: $authFile"
}
Protect-AihPrivatePath -Path $authFile
Write-Host 'ChatGPT/Codex authentication is configured for this Windows user.'
