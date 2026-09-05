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
$pathViolations = @($audit.PathFindings | Where-Object { -not (Test-AihPathLiteralAllowed -File $_.File -Value $_.Value -Classification $_.Classification) })
$pathText = ((@($pathViolations) | ForEach-Object { $_.File + ":" + $_.Line + " [" + $_.Value + "]" }) -join ", ")
Assert-Aih ($pathViolations.Count -eq 0) ("no cross-platform path construction uses backslash literals (found: " + $pathText + ")")

# 6. The POSIX launcher plane stays POSIX.
Assert-Aih (@($audit.LinuxLauncherFindings).Count -eq 0) "bin/linux stays POSIX: no fake .cmd artifacts, LF-only, shebang present, no cmd.exe references"
$shCr = @($audit.FileTraits | Where-Object { $_.Family -eq 'sh' -and $_.HasCarriageReturn })
$shCrText = ((@($shCr) | ForEach-Object { $_.RelativePath }) -join ", ")
Assert-Aih ($shCr.Count -eq 0) ("POSIX shell sources are LF-only (found: " + $shCrText + ")")

# 7. The harness suite table is a valid forward-slash path contract.
Assert-Aih (@($audit.SuiteTableFindings).Count -eq 0) "harness suite table uses forward slashes and every referenced suite file exists"

# 8. Windows-only executables and APIs appear only inside the platform
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
