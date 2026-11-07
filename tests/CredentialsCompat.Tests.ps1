[CmdletBinding()]
param([string]$InstallRoot)

# CredentialsCompat.Tests.ps1 — user credentials survive a DSH 0.2.x boot.
#
# DSH 0.2.x's local credential store owns $DSH_HOME/.credentials.yaml: the first
# boot migrates a legacy flat file into `version: 1 / refs:` and adds its own
# `records:` (the Web browser-session secret). Nexus writes and reads the same
# file (Set-DeepSeekKey.ps1, Get-AihDeepSeekKey, Get-AihProviderApiKey). This
# proves, on a DISPOSABLE root and with FAKE values, that after the REAL DSH
# composition has booted over the file:
#   - every original key is still present and byte-identical in value
#   - the Nexus readers still resolve those values (environment unset)
#   - the file keeps its private permissions (POSIX)
# for both the legacy flat layout and the structured layout Nexus writes today.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $InstallRoot 'scripts/Common.ps1')
$layout = Get-AihLayout $InstallRoot
$probeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('aih-credentials-compat-' + [System.Guid]::NewGuid().ToString('N'))
$passed = 0
function Pass([string]$Name) { $script:passed++; Write-Host ('PASS: ' + $Name) }
function Link-Directory([string]$Link, [string]$Target) {
    if (Test-AihIsWindows) { New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null }
    else { New-Item -ItemType SymbolicLink -Path $Link -Target $Target | Out-Null }
}
$fakeDeepSeek = 'FAKE-compat-deepseek-placeholder'
$fakeOpenCode = 'fake-opencode-compat-value'

try {
    foreach ($case in @(
        @{ Name = 'legacy flat layout'; Body = "# fake test credentials`nDEEPSEEK_API_KEY: '$fakeDeepSeek'`nOPENCODE_API_KEY: $fakeOpenCode`n" },
        @{ Name = 'structured refs layout'; Body = "version: 1`nrefs:`n  DEEPSEEK_API_KEY: '$fakeDeepSeek'`n  OPENCODE_API_KEY: $fakeOpenCode`n" }
    )) {
        $root = Join-Path $probeRoot ($case.Name -replace '\s', '-')
        New-Item -ItemType Directory -Path (Join-Path $root 'data') -Force | Out-Null
        foreach ($directory in @('app', 'runtime', 'config', 'scripts', 'ui')) { Link-Directory (Join-Path $root $directory) (Join-Path $InstallRoot $directory) }
        foreach ($item in @('cordis.patch.yml', 'nexus-settings.yaml', 'Routing-Integrity.cjs', 'OpenCode-SessionHeader.cjs')) {
            Copy-Item -LiteralPath (Join-Path $InstallRoot "data/$item") -Destination (Join-Path $root "data/$item")
        }
        Copy-Item -LiteralPath (Join-Path $InstallRoot 'data/.agent-presets') -Destination (Join-Path $root 'data/.agent-presets') -Recurse
        Copy-Item -LiteralPath (Join-Path $InstallRoot 'data/profiles') -Destination (Join-Path $root 'data/profiles') -Recurse
        $credentials = Join-Path $root 'data/.credentials.yaml'
        [IO.File]::WriteAllText($credentials, $case.Body, [Text.UTF8Encoding]::new($false))
        Protect-AihPrivatePath -Path $credentials

        & $layout.Node (Join-Path $InstallRoot 'scripts/Verify-NexusComposition.mjs') $root 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "FAIL: ($($case.Name)) the real composition did not boot over the credentials file." }

        $text = Get-Content -Raw -LiteralPath $credentials
        if (-not $text.Contains($fakeDeepSeek) -or -not $text.Contains($fakeOpenCode)) { throw "FAIL: ($($case.Name)) DSH rewrote the credentials file and lost a key value." }
        Pass "($($case.Name)) original keys survive a real DSH boot with identical values"

        $savedDeepSeek = $env:DEEPSEEK_API_KEY; $savedOpenCode = $env:OPENCODE_API_KEY
        $env:DEEPSEEK_API_KEY = $null; $env:OPENCODE_API_KEY = $null
        try {
            $resolvedDeepSeek = Get-AihDeepSeekKey $root
            $resolvedOpenCode = Get-AihProviderApiKey -ApiKeyEnv 'OPENCODE_API_KEY' -InstallRoot $root
        }
        finally { $env:DEEPSEEK_API_KEY = $savedDeepSeek; $env:OPENCODE_API_KEY = $savedOpenCode }
        if ($resolvedDeepSeek -ne $fakeDeepSeek) { throw "FAIL: ($($case.Name)) Get-AihDeepSeekKey no longer resolves the stored key." }
        if ($resolvedOpenCode -ne $fakeOpenCode) { throw "FAIL: ($($case.Name)) Get-AihProviderApiKey no longer resolves the stored key." }
        Pass "($($case.Name)) Nexus credential readers still resolve both keys after the DSH rewrite"

        if (-not (Test-AihIsWindows)) {
            $mode = (& stat -c '%a' $credentials).Trim()
            if ($mode -ne '600') { throw "FAIL: ($($case.Name)) credentials file mode is $mode, expected 600." }
            Pass "($($case.Name)) credentials file keeps owner-only permissions"
        }
    }
}
finally {
    if (Test-Path -LiteralPath $probeRoot) { Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ('SUITE RESULT: PASS ' + $passed + ' | FAIL 0 | total ' + $passed)
