[CmdletBinding()]
param([string]$InstallRoot = 'C:\AI-Harness')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot

foreach ($required in @($layout.Node, $layout.OAuth)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "OpenAI OAuth setup is unavailable; missing $required. Run setup.ps1 first."
    }
}

Write-Host 'This opens a browser so you can sign in with your own ChatGPT account.'
Write-Host 'The repository never receives or stores your OAuth token.'
Write-Host 'The installed third-party openai-oauth package writes the Codex-compatible auth file under your Windows profile.'

& $layout.Node $layout.OAuth login
if ($LASTEXITCODE -ne 0) {
    throw 'ChatGPT/Codex OAuth login did not complete successfully.'
}

$authFile = Get-AihCodexAuthFile
if (-not (Test-Path -LiteralPath $authFile -PathType Leaf)) {
    throw "Login completed without creating the expected Codex auth file: $authFile"
}
Protect-AihPrivatePath -Path $authFile
Write-Host 'ChatGPT/Codex authentication is configured for this Windows user.'
