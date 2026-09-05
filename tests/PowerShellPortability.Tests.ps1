[CmdletBinding()]param([string]$InstallRoot)
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# TASK-0024: permanent portability gate.
#
# Scans the WHOLE repository at runtime (AST-based, via the shared audit
# engine in tests/Aih.PortabilityAudit.psm1), so new files are covered
# automatically. Fails if future commits reintroduce:
#   1. mutable automatic/reserved-variable collisions
#   2. executable test defaults hard-coding the legacy Windows checkout root
#   3. cross-platform path construction using backslash literals
#   4. unguarded Windows-only executables/APIs outside the abstraction layer
#   5. a fake or non-POSIX Linux launcher plane
#   6. a harness suite table that is not a valid forward-slash path contract
#
# The reserved-variable matrix inside the engine was derived by probing
# Windows PowerShell 5.1 and PowerShell 7.5.3; whenever this gate runs under
# a different host the engine re-probes that host live.

Import-Module (Join-Path $InstallRoot 'tests/Aih.PortabilityAudit.psm1') -Force

$script:passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw ("FAIL: " + $Name) }; $script:passed++; Write-Host ("PASS: " + $Name) }
function Format-Findings($Findings) {
    return ((@($Findings) | ForEach-Object {
        $label = $_.File + ":" + $_.Line
        if ($_.PSObject.Properties['Token'] -and $_.Token) { $label = $label + " " + $_.Token }
        if ($_.PSObject.Properties['Value'] -and $_.Value) { $label = $label + " [" + $_.Value + "]" }
        if ($_.PSObject.Properties['Name'] -and $_.Name) { $label = $label + " $" + $_.Name }
        $label
    }) -join ", ")
}

$audit = Invoke-AihPortabilityAudit -Root $InstallRoot

# 1. Every PowerShell file must parse cleanly (a file the audit cannot parse
#    cannot be audited, so parse errors are gate failures).
$parseErrors = @($audit.AutomaticVariableFindings | Where-Object { $_.Kind -eq 'ParseError' })
Assert-Aih ($parseErrors.Count -eq 0) ("every PowerShell file parses cleanly (found: " + (Format-Findings $parseErrors) + ")")

# 2. No mutable automatic/reserved-variable collisions anywhere.
$collisions = @($audit.AutomaticVariableFindings | Where-Object { $_.Kind -ne 'ParseError' })
Assert-Aih ($collisions.Count -eq 0) ("no PowerShell file declares or writes an automatic/reserved variable (found: " + (Format-Findings $collisions) + ")")

# 3. No executable InstallRoot default may hard-code the legacy Windows root.
$execDefaults = @($audit.InstallRootFindings | Where-Object { $_.Kind -eq 'ExecutableInstallRootDefault' })
Assert-Aih ($execDefaults.Count -eq 0) ("no executable InstallRoot default hard-codes the legacy Windows checkout root (found: " + (Format-Findings $execDefaults) + ")")

# 4. Remaining legacy-root literal occurrences must live in explicitly allowed
#    files only (negative assertions, Windows-branch containment inputs, and
#    the Windows DefaultInstallRoot contract value).
$allowedRootLiteralFiles = @(
    'config/versions.psd1',               # Windows DefaultInstallRoot contract (installer-only)
    'tests/EpistemicPolicy.Tests.ps1',    # negative assertion: policy must not contain the root
    'tests/PlatformSupport.Tests.ps1',    # Windows-branch containment test inputs
    'tests/SetupUpgrade.Tests.ps1',       # negative assertions that the legacy root never returns
    'tests/Aih.PortabilityAudit.psm1'     # this file: allowlist matching data used to DETECT the legacy root
)
$rootLiterals = @($audit.InstallRootFindings | Where-Object { $_.Kind -eq 'LiteralOccurrence' })
$rootViolations = @($rootLiterals | Where-Object { $allowedRootLiteralFiles -notcontains $_.File })
Assert-Aih ($rootViolations.Count -eq 0) ("legacy-root literal occurrences are confined to documented negative assertions/contracts (found: " + (Format-Findings $rootViolations) + ")")

# 5. Cross-platform path construction must not use backslash literals.
#    TASK-0025 Class E: the classifier no longer lets a backslash path shape
#    hide behind regex-escape collision letters ('data\routing\...' contains
#    '\r'), so Windows-only relative fixture paths are caught here.
$pathViolations = @($audit.PathFindings | Where-Object { -not (Test-AihPathLiteralAllowed -File $_.File -Value $_.Value -Classification $_.Classification) })
$pathText = ((@($pathViolations) | ForEach-Object { $_.File + ":" + $_.Line + " [" + $_.Value + "]" }) -join ", ")
Assert-Aih ($pathViolations.Count -eq 0) ("no cross-platform path construction uses backslash literals (found: " + $pathText + ")")

# 5b. PATH mutations must use [IO.Path]::PathSeparator, never a literal ';'/':'
#     join (TASK-0025 Class B): a hardcoded separator corrupts PATH on the
#     other OS and broke the visual suites on Linux. Allowances are classified
#     below; everything else fails.
$pathSeparatorAllow = @(
    @{ File = 'scripts/Setup.ps1'; Reason = 'Windows installer mutating the Windows USER Path registry value; Windows-only file (setup.sh is the POSIX installer)' }
)
$separatorViolations = [System.Collections.Generic.List[string]]::new()
foreach ($finding in @($audit.PathSeparatorFindings)) {
    $allowed = $false
    foreach ($entry in $pathSeparatorAllow) { if ($entry.File -eq $finding.File) { $allowed = $true; break } }
    if (-not $allowed) { $separatorViolations.Add(($finding.File + ":" + $finding.Line + " [" + $finding.Value + "]")) }
}
Assert-Aih ($separatorViolations.Count -eq 0) ("PATH mutations use the platform path separator, never a literal ';'/':' join (found: " + (($separatorViolations.ToArray()) -join ", ") + ")")

# 6. The POSIX launcher plane stays POSIX.
Assert-Aih (@($audit.LinuxLauncherFindings).Count -eq 0) "bin/linux stays POSIX: no fake .cmd artifacts, LF-only, shebang present, no cmd.exe references"
$shCr = @($audit.FileTraits | Where-Object { $_.Family -eq 'sh' -and $_.HasCarriageReturn })
$shCrText = ((@($shCr) | ForEach-Object { $_.RelativePath }) -join ", ")
Assert-Aih ($shCr.Count -eq 0) ("POSIX shell sources are LF-only (found: " + $shCrText + ")")

# 7. The harness suite table is a valid forward-slash path contract.
Assert-Aih (@($audit.SuiteTableFindings).Count -eq 0) "harness suite table uses forward slashes and every referenced suite file exists"

# 8.5 Platform-layer dependency direction (TASK-0025 RC1): Platform.ps1
#     must be independently sourceable - no reverse dependency on
#     Common.ps1-defined functions.
$platformDeps = @($audit.PlatformDependencyFindings)
$platformDepText = ((@($platformDeps) | ForEach-Object { $_.File + ":" + $_.Line + " " + $_.Token }) -join ", ")
Assert-Aih ($platformDeps.Count -eq 0) ("Platform.ps1 invokes no function defined only by Common.ps1 (found: " + $platformDepText + ")")

# 8.6 JS-plane hardcoded platform executables (TASK-0025 RC4). A literal is
#     allowed when a process.platform guard sits within 8 lines (platform-
#     aware resolver/branch) or when the file carries a documented allowance
#     (the shared test transport's Windows branch). Everything else fails.
$jsAllow = @(
    @{ File = 'tests/lib/AihTestTransport.cjs'; Reason = 'the ONE shared test transport: its Windows branch implements the production host strategy and the TASK-0017 cmd.exe no-pipes transport' },
    @{ File = 'config/AihController.cjs'; Reason = 'production controller bridge: platform-aware spawnCaptured/runCli resolvers (guards verified in-file)' },
    @{ File = 'ui/nexus-controller/lib/index.js'; Reason = 'production UI controller: platform-aware pwsh host resolver (guards verified in-file)' },
    @{ File = 'tests/AihControllerHost.Tests.cjs'; Reason = 'this suite ASSERTS the platform launcher/host contracts; its literals are test data that must match production source, never spawns' },
    @{ File = 'tests/lib/AihLauncherLayout.cjs'; Reason = 'launcher-layout abstraction twin (TASK-0025 Class C): its .cmd literals are layout-plane DETECTION data (endsWith filter) and contract documentation, never spawns' }
)
$jsViolations = [System.Collections.Generic.List[string]]::new()
foreach ($finding in @($audit.JsExecutableFindings)) {
    $lines = [System.IO.File]::ReadAllLines((Join-Path $InstallRoot $finding.File))
    $from = [Math]::Max(0, $finding.Line - 9)
    $to = [Math]::Min($lines.Count - 1, $finding.Line + 8)
    $guarded = $false
    for ($i = $from; $i -le $to; $i++) { if ($lines[$i] -match "process\.platform\s*(===|!==)\s*'win32'") { $guarded = $true; break } }
    $allowed = $false
    foreach ($entry in $jsAllow) { if ($entry.File -eq $finding.File) { $allowed = $true; break } }
    if (-not $guarded -and -not $allowed) {
        $jsViolations.Add(($finding.File + ":" + $finding.Line + " [" + $finding.Kind + "] " + $finding.Token))
    }
}
Assert-Aih ($jsViolations.Count -eq 0) ("JS sources hardcode no unguarded Windows executables (found: " + (($jsViolations.ToArray()) -join ", ") + ")")

# 8.7 No Windows-only fixture technologies in PowerShell test suites
#     (TASK-0025 RC3): fixtures must be committed platform-neutral bytes.
$fixtureViolations = @($audit.WindowsFixtureFindings)
$fixtureText = ((@($fixtureViolations) | ForEach-Object { $_.File + ":" + $_.Line }) -join ", ")
Assert-Aih ($fixtureViolations.Count -eq 0) ("PowerShell test suites use no Windows-only fixture technologies (found: " + $fixtureText + ")")

# 8.8 Invariant result-object schemas (TASK-0025 RC5): every declared
#     result contract returns objects with the full key set at EVERY return
#     site.
$schemaViolations = @($audit.ResultSchemaFindings)
$schemaText = ((@($schemaViolations) | ForEach-Object { $_.File + ":" + $_.Line + " missing " + $_.Token }) -join ", ")
Assert-Aih ($schemaViolations.Count -eq 0) ("declared result contracts keep an invariant schema (found: " + $schemaText + ")")

# 8.9 PS5.1 vs PS7 JSON scalar/date compatibility (TASK-0025 RC7): the
#     intelligence store contract is that persisted timestamps are ISO-8601
#     STRINGS on every host. Round-trip a document through the real store
#     helpers and assert the canonical string semantics survive.
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/intelligence/Intelligence.Store.ps1')
$jsonCompatRoot = Join-Path ([IO.Path]::GetTempPath()) ('aih-portability-json-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $jsonCompatRoot | Out-Null
try {
    $isoStamp = '2026-09-05T14:55:04.8251033Z'
    $compatDoc = [pscustomobject]@{ schemaVersion = 1; completedAt = $isoStamp; nested = [pscustomobject]@{ startedAt = $isoStamp; rows = @([pscustomobject]@{ at = $isoStamp }) } }
    $compatPath = Join-Path $jsonCompatRoot 'compat.json'
    Save-AihIntStoreJson -Path $compatPath -Document $compatDoc
    $roundTrip = Read-AihIntStoreJson -Path $compatPath -Factory { [pscustomobject]@{ schemaVersion = 1 } }
    Assert-Aih ([string]$roundTrip.completedAt -eq $isoStamp) 'store round-trip preserves the canonical ISO timestamp value'
    Assert-Aih ($roundTrip.completedAt -is [string]) 'store round-trip exposes timestamps as strings on this host'
    Assert-Aih ([string]$roundTrip.nested.rows[0].at -eq $isoStamp) 'store round-trip normalizes nested timestamps too'
} finally {
    if (Test-Path -LiteralPath $jsonCompatRoot) { Remove-Item -LiteralPath $jsonCompatRoot -Recurse -Force }
}

# 9. Windows-only executables and APIs appear only inside the platform
#    abstraction layer or explicitly guarded contexts.
#
#    Auto-allowed classes (documented, verified by this gate's structure):
#      - ProcessCmdlet: Start-Process/Stop-Process are core cross-platform
#        cmdlets on PowerShell 7; their Windows-only PARAMETERS (WindowStyle)
#        are audited separately below.
#      - LauncherReference in .cmd files: the Windows launcher plane by design.
#      - LauncherReference token 'pwsh' in .sh files: the POSIX pinned-runtime
#        contract (setup.sh provisions runtime/pwsh/pwsh).
#
#    Everything else must match an entry below; entries with a Guard pattern
#    are VERIFIED against the file text (a matching line must appear within 4
#    lines of the finding), so a guard removal fails this gate.
$execAllow = @(
    @{ File = 'scripts/Platform.ps1'; Token = 'icacls.exe'; Guard = 'Test-AihIsWindows'; Reason = 'Windows ACL branch of Protect-AihPrivatePath' },
    @{ File = 'scripts/Platform.ps1'; Token = 'System.Security.Principal.WindowsIdentity'; Guard = 'Test-AihIsWindows'; Reason = 'guarded identity lookup for the ACL grant' },
    @{ File = 'scripts/Platform.ps1'; Token = 'WindowStyle'; Guard = 'Test-AihIsWindows'; Reason = 'Start-AihDetachedProcess sets WindowStyle only on Windows' },
    @{ File = 'scripts/VisualLoop.ps1'; Token = 'cmd'; Guard = 'Test-AihIsWindows'; Reason = 'Windows-only capture/review redirection; POSIX branch uses Invoke-AihPwshScriptFile' },
    @{ File = 'scripts/Common.ps1'; Token = 'env:USERPROFILE'; Guard = 'Test-AihIsWindows'; Reason = 'inline guard: USERPROFILE on Windows, HOME elsewhere' },
    @{ File = 'tests/PlatformSupport.Tests.ps1'; Token = 'WindowStyle'; Reason = 'mock contract asserting WindowStyle is forwarded only on Windows' },
    @{ File = 'tests/VisualReview.Tests.ps1'; Token = 'WindowStyle'; Guard = 'Test-AihIsWindows'; Reason = 'guarded Windows-only Start-Process parameter for the wire-capture server' }
)
$execViolations = [System.Collections.Generic.List[string]]::new()
foreach ($finding in @($audit.ExecutableFindings)) {
    if ($finding.Kind -eq 'ProcessCmdlet') { continue }
    if ($finding.Kind -eq 'LauncherReference' -and $finding.Classification -eq 'windows-launcher') { continue }
    if ($finding.Kind -eq 'LauncherReference' -and $finding.Token -eq 'pwsh' -and $finding.File -like '*.sh') { continue }
    $matched = $false
    foreach ($entry in $execAllow) {
        if ($entry.File -ne $finding.File) { continue }
        if ($entry.Token -ne $finding.Token) { continue }
        if ($entry.ContainsKey('Guard')) {
            $lines = [System.IO.File]::ReadAllLines((Join-Path $InstallRoot $finding.File))
            $from = [Math]::Max(0, $finding.Line - 9)
            $to = [Math]::Min($lines.Count - 1, $finding.Line + 4)
            $guardFound = $false
            for ($i = $from; $i -le $to; $i++) { if ($lines[$i] -match $entry.Guard) { $guardFound = $true; break } }
            if (-not $guardFound) { continue }
        }
        $matched = $true
        break
    }
    if (-not $matched) {
        $execViolations.Add(($finding.File + ":" + $finding.Line + " [" + $finding.Kind + "] " + $finding.Token))
    }
}
Assert-Aih ($execViolations.Count -eq 0) ("Windows-only executables/APIs appear only in guarded or abstraction contexts (found: " + (($execViolations.ToArray()) -join ", ") + ")")

Write-Host ("RESULT: $script:passed portability gate assertions passed.")
