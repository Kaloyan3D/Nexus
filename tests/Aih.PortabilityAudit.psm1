Set-StrictMode -Version Latest

# Nexus portability audit engine (TASK-0024).
#
# A single committed, dependency-free analysis module used by BOTH:
#   - tests/PowerShellPortability.Tests.ps1 (the permanent regression gate), and
#   - ad-hoc machine-readable inventory reports (environment-specific output
#     that callers must write to a temporary directory, never commit).
#
# The engine is Windows PowerShell 5.1 and PowerShell 7+ compatible and must
# stay free of Windows-only assumptions itself (no IsWindows variable, no
# hard-coded Windows roots). OS detection goes through RuntimeInformation
# exactly like scripts/Platform.ps1.

# ---------------------------------------------------------------------------
# File scope
# ---------------------------------------------------------------------------

function Get-AihPortabilityScanFiles {
    # Declared inventory scope (TASK-0024 phase 1): all PowerShell sources,
    # the setup entry points, the Windows launchers and the POSIX launchers.
    param([Parameter(Mandatory = $true)][string]$Root)

    $rootPath = [System.IO.Path]::GetFullPath($Root)
    $excludedSegments = @('.git', 'node_modules', 'runtime', 'logs', 'data', '.ai-harness', 'tmp', '_audit', '_tmp_ws', '.vscode')

    $files = [System.Collections.Generic.List[object]]::new()

    # NOTE: extension filtering is done manually. Get-ChildItem -Include is
    # unreliable in Windows PowerShell 5.1 (it can pass through unrelated
    # files, including binaries) which must never reach the parser.
    $powershellFiles = @(Get-ChildItem -LiteralPath $rootPath -Recurse -File -ErrorAction SilentlyContinue | Where-Object { @('.ps1', '.psm1', '.psd1') -contains $_.Extension.ToLowerInvariant() })
    foreach ($file in $powershellFiles) {
        $relative = $file.FullName.Substring($rootPath.Length).TrimStart('\', '/')
        $segments = $relative -split '[\\/]'
        $skip = $false
        foreach ($segment in $segments) { if ($excludedSegments -contains $segment) { $skip = $true } }
        if ($skip) { continue }
        $files.Add([pscustomobject]@{
            FullName = $file.FullName
            RelativePath = ($relative.Replace('\', '/'))
            Family = 'powershell'
            LengthBytes = $file.Length
        })
    }

    foreach ($entryPoint in @('setup.ps1', 'setup.sh')) {
        $candidate = Join-Path $rootPath $entryPoint
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $files.Add([pscustomobject]@{
                FullName = (Get-Item -LiteralPath $candidate).FullName
                RelativePath = $entryPoint
                Family = $(if ($entryPoint -like '*.ps1') { 'powershell' } else { 'sh' })
                LengthBytes = (Get-Item -LiteralPath $candidate).Length
            })
        }
    }

    $binDir = Join-Path $rootPath 'bin'
    if (Test-Path -LiteralPath $binDir) {
        foreach ($launcher in @(Get-ChildItem -LiteralPath $binDir -File -Filter '*.cmd' -ErrorAction SilentlyContinue)) {
            $files.Add([pscustomobject]@{ FullName = $launcher.FullName; RelativePath = ('bin/' + $launcher.Name); Family = 'cmd'; LengthBytes = $launcher.Length })
        }
        $linuxDir = Join-Path $binDir 'linux'
        if (Test-Path -LiteralPath $linuxDir) {
            foreach ($launcher in @(Get-ChildItem -LiteralPath $linuxDir -File -ErrorAction SilentlyContinue)) {
                $files.Add([pscustomobject]@{ FullName = $launcher.FullName; RelativePath = ('bin/linux/' + $launcher.Name); Family = 'sh'; LengthBytes = $launcher.Length })
            }
        }
    }
    $posixLib = Join-Path $rootPath 'scripts/lib'
    if (Test-Path -LiteralPath $posixLib) {
        foreach ($lib in @(Get-ChildItem -LiteralPath $posixLib -File -Filter '*.sh' -ErrorAction SilentlyContinue)) {
            $files.Add([pscustomobject]@{ FullName = $lib.FullName; RelativePath = ('scripts/lib/' + $lib.Name); Family = 'sh'; LengthBytes = $lib.Length })
        }
    }

    $seen = @{}
    $unique = [System.Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        $key = $file.RelativePath.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $unique.Add($file)
    }
    return ,@($unique.ToArray())
}

function Get-AihPortabilityFileTraits {
    # Line-ending / encoding traits relevant to cross-platform contracts:
    # POSIX launchers and shell libraries must be LF-only.
    param([Parameter(Mandatory = $true)]$File)

    $bytes = [System.IO.File]::ReadAllBytes($File.FullName)
    $hasCr = $false
    $hasBom = $false
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $hasBom = $true }
    for ($i = 0; $i -lt $bytes.Length; $i++) { if ($bytes[$i] -eq 13) { $hasCr = $true; break } }
    return [pscustomobject]@{
        RelativePath = $File.RelativePath
        Family = $File.Family
        HasCarriageReturn = $hasCr
        HasUtf8Bom = $hasBom
        LengthBytes = $File.LengthBytes
    }
}

# ---------------------------------------------------------------------------
# Automatic / reserved variable matrix
# ---------------------------------------------------------------------------

$script:AihReservedVariableCandidates = @(
    'args', 'consolefilename', 'error', 'errorview', 'event', 'eventargs', 'eventsubscriber',
    'executioncontext', 'false', 'foreach', 'home', 'host', 'input', 'iscoreclr', 'islinux',
    'ismacos', 'iswindows', 'lastexitcode', 'matches', 'myinvocation', 'nestedpromptlevel',
    'null', 'pid', 'profile', 'psboundparameters', 'pscommandpath', 'psculture', 'psdebugcontext',
    'psedition', 'pshome', 'psitem', 'psparameterizedvalues', 'psscriptroot', 'pssenderinfo',
    'psstyle', 'psuiculture', 'psversiontable', 'pwd', 'sender', 'shellid', 'stacktrace',
    'switch', 'this', 'true', 'ofs', 'progresspreference', 'erroractionpreference',
    'warningpreference', 'verbosepreference', 'debugpreference', 'informationpreference',
    'whatifpreference', 'confirmpreference', 'psnativecommandargumentpassing',
    'psnativecommanduseerroractionpreference', 'reporterrorshowexceptionclass',
    'reporterrorshowinnerexception', 'reporterrorshowsource', 'reporterrorshowstacktrace',
    'reporterrorshowtargetobject', '?', '$', '^'
)

function Invoke-AihReservedVariableProbe {
    # Probes the CURRENT host (a child process of the same executable so the
    # live session is never mutated) for every candidate automatic variable:
    # presence, options, and whether a plain assignment succeeds. Hosts that
    # differ (Windows PowerShell 5.1 vs PowerShell 7) report different sets,
    # which is exactly why the probe exists.
    param([string[]]$Names = $script:AihReservedVariableCandidates)

    $hostExecutable = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $nameList = ($Names | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ','
    $probeScript = @'
$results = @()
foreach ($n in $Names) {
    $present = $false
    $options = ''
    $existing = Get-Variable -Name $n -ErrorAction SilentlyContinue
    if ($null -ne $existing) { $present = $true; $options = [string]$existing.Options }
    $writable = $true
    $assignmentError = ''
    try {
        Set-Variable -Name $n -Value 'AIH_PROBE_VALUE' -ErrorAction Stop
        $check = Get-Variable -Name $n -ValueOnly
        if ([string]$check -ne 'AIH_PROBE_VALUE') { $writable = $false; $assignmentError = 'assignment silently ignored' }
    } catch {
        $writable = $false
        $assignmentError = $_.Exception.Message
    }
    $results += [pscustomobject]@{ Name = $n; Present = $present; Options = $options; Writable = $writable; AssignmentError = $assignmentError }
}
ConvertTo-Json -InputObject @($results) -Depth 3
'@
    $commandText = '$names = @(' + $nameList + '); ' + $probeScript
    $raw = @(& $hostExecutable -NoLogo -NoProfile -NonInteractive -Command $commandText 2>&1 | ForEach-Object { [string]$_ })
    $jsonText = ($raw -join [string][char]10)
    $parsed = ConvertFrom-Json -InputObject $jsonText
    return ,@($parsed)
}

# Reserved-variable matrix captured by probing BOTH reference hosts during
# TASK-0024: Windows PowerShell 5.1 and PowerShell 7.5.3 (the runtime Nexus
# pins on Linux). Per name and host: 'READONLY' (plain assignment fails) or
# 'WRITABLE' (assignment succeeds). Derived from live probes of both hosts,
# not from documentation, so the sets stay accurate as hosts evolve.
$script:AihEmbeddedReservedMatrix = @{
    'args' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'consolefilename' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'error' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'errorview' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'event' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'eventargs' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'eventsubscriber' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'executioncontext' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'false' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'foreach' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'home' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'host' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'input' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'iscoreclr' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'READONLY' }
    'islinux' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'READONLY' }
    'ismacos' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'READONLY' }
    'iswindows' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'READONLY' }
    'lastexitcode' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'matches' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'myinvocation' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'nestedpromptlevel' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'null' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'pid' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'profile' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'psboundparameters' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'pscommandpath' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'psculture' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'psdebugcontext' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'psedition' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'READONLY' }
    'pshome' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'psitem' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'psparameterizedvalues' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'psscriptroot' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'pssenderinfo' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'psstyle' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'psuiculture' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'psversiontable' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'pwd' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'sender' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'shellid' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'stacktrace' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'switch' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'this' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'true' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    'ofs' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'progresspreference' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'erroractionpreference' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'warningpreference' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'verbosepreference' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'debugpreference' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'informationpreference' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'whatifpreference' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'confirmpreference' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'psnativecommandargumentpassing' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'psnativecommanduseerroractionpreference' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'reporterrorshowexceptionclass' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'reporterrorshowinnerexception' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'reporterrorshowsource' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'reporterrorshowstacktrace' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    'reporterrorshowtargetobject' = @{ '5.1' = 'WRITABLE'; '7.5.3' = 'WRITABLE' }
    '?' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    '$' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
    '^' = @{ '5.1' = 'READONLY'; '7.5.3' = 'READONLY' }
}

function Get-AihReservedVariableSet {
    # Names whose plain assignment fails in ANY reference host or the live
    # probe (STRICT: assignment is a runtime error in some host), plus a
    # curated shadow-dangerous set of writable automatics that ordinary code
    # must not rebind. Returns a map name -> @{ Strict=bool; Reason=string }.
    param([switch]$SkipLiveProbe)

    $reserved = @{}
    foreach ($name in $script:AihEmbeddedReservedMatrix.Keys) {
        $perHost = $script:AihEmbeddedReservedMatrix[$name]
        $readonlyHosts = @($perHost.Keys | Where-Object { $perHost[$_] -eq 'READONLY' })
        if ($readonlyHosts.Count -gt 0) {
            $reserved[$name] = @{ Strict = $true; Reason = ('plain assignment fails in: ' + ($readonlyHosts -join ', ')) }
        }
    }

    if (-not $SkipLiveProbe) {
        try {
            $live = Invoke-AihReservedVariableProbe
            foreach ($entry in $live) {
                $name = ([string]$entry.Name).ToLowerInvariant()
                if (-not $entry.Writable) {
                    $reserved[$name] = @{ Strict = $true; Reason = ('live host probe: ' + [string]$entry.AssignmentError) }
                }
            }
        } catch {
            # A probe failure must never break the audit; the embedded matrix
            # above remains authoritative for STRICT classification.
        }
    }

    foreach ($name in @('args', 'input', 'matches', 'foreach', 'switch', 'lastexitcode', 'psitem', 'this', 'psboundparameters', 'myinvocation', 'stacktrace', 'event', 'eventargs', 'eventsubscriber', 'sender', 'psdebugcontext', 'profile')) {
        if (-not $reserved.ContainsKey($name)) {
            $reserved[$name] = @{ Strict = $false; Reason = 'writable automatic variable; rebinding shadows engine-managed state' }
        }
    }
    return $reserved
}

# ---------------------------------------------------------------------------
# AST helpers
# ---------------------------------------------------------------------------

function Get-AihParsedPowerShellFiles {
    param([Parameter(Mandatory = $true)]$Files)

    $parsed = [System.Collections.Generic.List[object]]::new()
    foreach ($file in @($Files | Where-Object { $_.Family -eq 'powershell' })) {
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
        $parsed.Add([pscustomobject]@{
            File = $file
            Ast = $ast
            Tokens = $tokens
            ParseErrors = @($errors)
        })
    }
    return ,@($parsed.ToArray())
}

function Get-AihUnqualifiedVariablePath {
    # Strips scope/drive prefixes ('script:', 'env:', ...) from a variable
    # path. Implemented manually instead of VariablePath.GetUnqualifiedPath()
    # because that method is not available on Windows PowerShell 5.1.
    param([Parameter(Mandatory = $true)]$VariablePath)

    return ([string]$VariablePath.UserPath -replace '^[A-Za-z]+:', '')
}

function Get-AihVariableTargetName {
    # Extracts the bare variable name an assignment targets, if any.
    param([Parameter(Mandatory = $true)]$Left)

    $target = $Left
    if ($target -is [System.Management.Automation.Language.ConvertExpressionAst]) {
        $target = $target.Child
    }
    if ($target -is [System.Management.Automation.Language.VariableExpressionAst]) {
        return [pscustomobject]@{
            Name = Get-AihUnqualifiedVariablePath -VariablePath $target.VariablePath
            IsUnscoped = -not ($target.VariablePath.IsGlobal -or $target.VariablePath.IsScript -or $target.VariablePath.IsLocal -or $target.VariablePath.IsPrivate)
            ScopeLabel = $target.VariablePath.UserPath
        }
    }
    return $null
}

function Get-AihAutomaticVariableFindings {
    # AST-based audit of mutable declarations and assignment targets against
    # the reserved-variable set. Flags ONLY declarations or writes; reads of
    # automatic variables are legitimate and never flagged.
    param(
        [Parameter(Mandatory = $true)]$ParsedFiles,
        [Parameter(Mandatory = $true)]$ReservedVariables
    )

    $findings = [System.Collections.Generic.List[object]]::new()
    $reservedKeys = @($ReservedVariables.Keys)

    foreach ($parsed in $ParsedFiles) {
        if ($parsed.ParseErrors.Count -gt 0) {
            foreach ($errorItem in $parsed.ParseErrors) {
                $findings.Add([pscustomobject]@{
                    File = $parsed.File.RelativePath; Kind = 'ParseError'; Name = '';
                    Line = $errorItem.Extent.StartLineNumber; Severity = 'error';
                    Detail = $errorItem.Message
                })
            }
            continue
        }
        $ast = $parsed.Ast

        foreach ($assignment in @($ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true))) {
            $target = Get-AihVariableTargetName -Left $assignment.Left
            if ($null -eq $target) { continue }
            $name = $target.Name.ToLowerInvariant()
            if (-not ($reservedKeys -contains $name)) { continue }
            if ($name -eq 'null') { continue }  # $null = ... is the idiomatic output-discard form
            $findings.Add([pscustomobject]@{
                File = $parsed.File.RelativePath; Kind = 'AssignmentToAutomatic'; Name = $name;
                Line = $assignment.Left.Extent.StartLineNumber; Severity = 'error';
                Detail = ('assignment target "' + $target.ScopeLabel + '"; ' + $ReservedVariables[$name].Reason)
            })
        }

        # Note: ++/-- are AssignmentStatementAst instances with Postfix/Prefix
        # operators, so the assignment loop above already covers them.
        foreach ($parameter in @($ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.ParameterAst] }, $true))) {
            $name = (Get-AihUnqualifiedVariablePath $parameter.Name.VariablePath).ToLowerInvariant()
            if (-not ($reservedKeys -contains $name)) { continue }
            $findings.Add([pscustomobject]@{
                File = $parsed.File.RelativePath; Kind = 'ParameterShadowsAutomatic'; Name = $name;
                Line = $parameter.Name.Extent.StartLineNumber; Severity = 'error';
                Detail = ('parameter "' + (Get-AihUnqualifiedVariablePath $parameter.Name.VariablePath) + '" shadows ' + $ReservedVariables[$name].Reason)
            })
        }

        foreach ($forLoop in @($ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.ForEachStatementAst] }, $true))) {
            $name = (Get-AihUnqualifiedVariablePath $forLoop.Variable.VariablePath).ToLowerInvariant()
            if (-not ($reservedKeys -contains $name)) { continue }
            $findings.Add([pscustomobject]@{
                File = $parsed.File.RelativePath; Kind = 'ForeachIteratorShadowsAutomatic'; Name = $name;
                Line = $forLoop.Variable.Extent.StartLineNumber; Severity = 'error';
                Detail = ('foreach iterator "' + (Get-AihUnqualifiedVariablePath $forLoop.Variable.VariablePath) + '" shadows ' + $ReservedVariables[$name].Reason)
            })
        }

        foreach ($command in @($ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true))) {
            $commandName = [string]$command.GetCommandName()
            if ([string]::IsNullOrWhiteSpace($commandName)) { continue }
            if (@('set-variable', 'new-variable', 'remove-variable') -notcontains $commandName.ToLowerInvariant()) { continue }
            $stringArgs = @($command.FindAll({ param($a) $a -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true))
            if ($stringArgs.Count -eq 0) { continue }
            $name = ([string]$stringArgs[0].Value).ToLowerInvariant()
            if (-not ($reservedKeys -contains $name)) { continue }
            $findings.Add([pscustomobject]@{
                File = $parsed.File.RelativePath; Kind = 'VariableCmdletOverwrite'; Name = $name;
                Line = $command.Extent.StartLineNumber; Severity = 'error';
                Detail = ($commandName + ' targets automatic variable "' + $name + '"; ' + $ReservedVariables[$name].Reason)
            })
        }
    }
    return ,@($findings.ToArray())
}

# ---------------------------------------------------------------------------
# String-literal classification (install roots + path separators)
# ---------------------------------------------------------------------------

function Test-AihRegexLikeString {
    param([string]$Value)

    if ($Value -match '\\[sSwWdDbBrRnNtTvVfF/(){}+*?|^$.\[\]]') { return $true }
    if ($Value -match '\\["' + "'" + ']') { return $true }
    if ($Value.Length -gt 2 -and $Value.Substring(1).Contains('\\')) { return $true }
    if ($Value -match '\\[0-9]') { return $true }
    if ($Value -match '\(\?[a-zA-Z]') { return $true }
    return $false
}

function Get-AihStringLiteralFindings {
    # Every backslash-carrying string literal in executable PowerShell, with a
    # first-pass classification. The permanent gate fails on any finding whose
    # classification is 'cross-platform-path-literal' and not explicitly
    # allowed by the allowlist (each allowlist entry carries a justification).
    param([Parameter(Mandatory = $true)]$ParsedFiles)

    $findings = [System.Collections.Generic.List[object]]::new()
    foreach ($parsed in $ParsedFiles) {
        $literals = @($parsed.Ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $a -is [System.Management.Automation.Language.ExpandableStringExpressionAst] }, $true))
        foreach ($literal in $literals) {
            $value = [string]$literal.Value
            if (-not $value.Contains('\')) { continue }  # only backslash-carrying literals are audited here
            $line = $literal.Extent.StartLineNumber
            $class = 'unknown'
            $detail = ''
            if ($value -match '(?i)^[a-z]:[\\/]') { $class = 'windows-drive-path'; $detail = 'drive-qualified Windows path' }
            elseif ($value.StartsWith('\\')) { $class = 'windows-unc-path'; $detail = 'UNC path' }
            elseif ($value -match '%~[dpf0]|%[A-Z_]+%') { $class = 'windows-batch-syntax'; $detail = 'cmd.exe batch expansion syntax' }
            elseif ($value -match '(?i)^local\\') { $class = 'windows-namespace-name'; $detail = 'Windows kernel-object namespace name' }
            elseif ($value -eq '\') { $class = 'separator-normalization'; $detail = 'lone backslash used to normalize/convert path separators' }
            elseif (Test-AihRegexLikeString -Value $value) { $class = 'regex-escape'; $detail = 'looks like a regular expression, not a path' }
            else { $class = 'cross-platform-path-literal'; $detail = 'backslash-separated relative path in executable code' }
            $findings.Add([pscustomobject]@{
                File = $parsed.File.RelativePath; Line = $line; Value = $value; Classification = $class; Detail = $detail
            })
        }
    }
    return ,@($findings.ToArray())
}

function Get-AihInstallRootFindings {
    # Detects executable install-root defaults hard-coded to the legacy
    # Windows checkout root, plus every other occurrence of the literal for
    # explicit classification.
    param([Parameter(Mandatory = $true)]$ParsedFiles)

    $findings = [System.Collections.Generic.List[object]]::new()
    $pattern = '(?i)^[a-z]:[\\/]ai-harness([\\/]|$)'

    foreach ($parsed in $ParsedFiles) {
        $paramBlocks = @($parsed.Ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.ParameterAst] }, $true))
        foreach ($parameter in $paramBlocks) {
            $name = (Get-AihUnqualifiedVariablePath $parameter.Name.VariablePath)
            if ($name -ne 'InstallRoot') { continue }
            if ($null -eq $parameter.DefaultValue) { continue }
            $defaultAst = $parameter.DefaultValue
            if ($defaultAst -is [System.Management.Automation.Language.ParenExpressionAst]) { $defaultAst = $defaultAst.Pipeline }
            if ($defaultAst -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
                if ($defaultAst.Value -match $pattern) {
                    $findings.Add([pscustomobject]@{
                        File = $parsed.File.RelativePath; Line = $parameter.Extent.StartLineNumber;
                        Kind = 'ExecutableInstallRootDefault'; Name = 'InstallRoot'; Value = $defaultAst.Value;
                        Classification = 'legacy-default'; Detail = 'param() default hard-codes the legacy Windows checkout root'
                    })
                }
            }
        }

        $literals = @($parsed.Ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true))
        foreach ($literal in $literals) {
            if ([string]$literal.Value -match $pattern) {
                $findings.Add([pscustomobject]@{
                    File = $parsed.File.RelativePath; Line = $literal.Extent.StartLineNumber;
                    Kind = 'LiteralOccurrence'; Name = ''; Value = [string]$literal.Value;
                    Classification = 'review'; Detail = 'literal occurrence; classify (negative assertion / guarded Windows contract / fixture)'
                })
            }
        }
    }
    return ,@($findings.ToArray())
}

# ---------------------------------------------------------------------------
# Windows executable / API assumptions
# ---------------------------------------------------------------------------

function Get-AihWindowsExecutableFindings {
    # Inventory of executable references and Windows-only APIs. AST-level for
    # invocations and typed APIs in PowerShell files; text-level for launcher
    # files. Every finding carries a first-pass classification hint.
    param([Parameter(Mandatory = $true)]$Files, [Parameter(Mandatory = $true)]$ParsedFiles)

    $findings = [System.Collections.Generic.List[object]]::new()

    foreach ($parsed in $ParsedFiles) {
        foreach ($command in @($parsed.Ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true))) {
            $commandName = [string]$command.GetCommandName()
            if ([string]::IsNullOrWhiteSpace($commandName)) { continue }
            $lower = $commandName.ToLowerInvariant()
            if (@('powershell.exe', 'powershell', 'cmd.exe', 'cmd', 'icacls.exe', 'icacls') -contains $lower) {
                $findings.Add([pscustomobject]@{
                    File = $parsed.File.RelativePath; Line = $command.Extent.StartLineNumber;
                    Token = $commandName; Kind = 'CommandInvocation';
                    Classification = 'review'; Detail = 'direct external executable invocation in PowerShell code'
                })
            }
            if (@('start-process', 'stop-process') -contains $lower) {
                $findings.Add([pscustomobject]@{
                    File = $parsed.File.RelativePath; Line = $command.Extent.StartLineNumber;
                    Token = $commandName; Kind = 'ProcessCmdlet';
                    Classification = 'review'; Detail = 'process-management cmdlet (verify platform guard/abstraction)'
                })
            }
        }

        foreach ($type in @($parsed.Ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.TypeExpressionAst] }, $true))) {
            $typeName = $type.TypeName.FullName
            if ($typeName -match 'WindowsIdentity|WindowsPrincipal|Microsoft\.Win32') {
                $findings.Add([pscustomobject]@{
                    File = $parsed.File.RelativePath; Line = $type.Extent.StartLineNumber;
                    Token = $typeName; Kind = 'WindowsType';
                    Classification = 'review'; Detail = 'Windows-only .NET type referenced'
                })
            }
        }

        foreach ($member in @($parsed.Ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.MemberExpressionAst] -and $a.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true))) {
            $memberName = [string]$member.Member.Value
            if ($memberName -eq 'WindowStyle') {
                $findings.Add([pscustomobject]@{
                    File = $parsed.File.RelativePath; Line = $member.Extent.StartLineNumber;
                    Token = 'WindowStyle'; Kind = 'WindowStyleMember';
                    Classification = 'review'; Detail = 'WindowStyle usage (Windows-only Start-Process parameter)'
                })
            }
        }

        foreach ($parameterAst in @($parsed.Ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandParameterAst] }, $true))) {
            if ([string]$parameterAst.ParameterName -eq 'WindowStyle') {
                $findings.Add([pscustomobject]@{
                    File = $parsed.File.RelativePath; Line = $parameterAst.Extent.StartLineNumber;
                    Token = '-WindowStyle'; Kind = 'WindowStyleParameter';
                    Classification = 'review'; Detail = 'WindowStyle passed as a command parameter'
                })
            }
        }

        $envRefs = @($parsed.Ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.VariableExpressionAst] -and $a.VariablePath.UserPath -like 'env:*' }, $true))
        foreach ($envRef in $envRefs) {
            $envName = (Get-AihUnqualifiedVariablePath $envRef.VariablePath)
            if (@('USERPROFILE', 'PATHEXT') -contains $envName) {
                $findings.Add([pscustomobject]@{
                    File = $parsed.File.RelativePath; Line = $envRef.Extent.StartLineNumber;
                    Token = ('env:' + $envName); Kind = 'WindowsEnvironmentVariable';
                    Classification = 'review'; Detail = 'Windows-only environment variable referenced'
                })
            }
        }
    }

    foreach ($file in @($Files | Where-Object { @('cmd', 'sh') -contains $_.Family })) {
        $lines = [System.IO.File]::ReadAllLines($file.FullName)
        for ($i = 0; $i -lt $lines.Count; $i++) {
            foreach ($token in @('powershell.exe', 'pwsh', 'cmd.exe', '%~dp0', '%*', 'icacls', 'WindowsIdentity', 'USERPROFILE', 'PATHEXT', 'WindowStyle')) {
                if ($lines[$i].Contains($token)) {
                    $findings.Add([pscustomobject]@{
                        File = $file.RelativePath; Line = ($i + 1);
                        Token = $token; Kind = 'LauncherReference';
                        Classification = $(if ($file.Family -eq 'cmd') { 'windows-launcher' } else { 'review' });
                        Detail = $lines[$i].Trim()
                    })
                }
            }
        }
    }
    return ,@($findings.ToArray())
}

function Get-AihLinuxLauncherFindings {
    # The POSIX launcher plane must stay POSIX: no fake .cmd artifacts, LF
    # line endings, a shebang on every launcher, and no cmd.exe references.
    param([Parameter(Mandatory = $true)]$Files)

    $findings = [System.Collections.Generic.List[object]]::new()
    foreach ($file in @($Files | Where-Object { $_.RelativePath -like 'bin/linux/*' })) {
        if ($file.RelativePath -like '*.cmd') {
            $findings.Add([pscustomobject]@{ File = $file.RelativePath; Kind = 'FakeLinuxCmd'; Detail = '.cmd artifact under bin/linux' })
        }
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        for ($i = 0; $i -lt $bytes.Length; $i++) {
            if ($bytes[$i] -eq 13) { $findings.Add([pscustomobject]@{ File = $file.RelativePath; Kind = 'CarriageReturnInPosixLauncher'; Detail = 'CR byte found' }); break }
        }
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)
        if (-not $text.StartsWith('#!')) { $findings.Add([pscustomobject]@{ File = $file.RelativePath; Kind = 'MissingShebang'; Detail = 'launcher does not start with a shebang' }) }
        if ($text.Contains('cmd.exe')) { $findings.Add([pscustomobject]@{ File = $file.RelativePath; Kind = 'CmdExeReferenceInPosixLauncher'; Detail = 'references cmd.exe' }) }
    }
    return ,@($findings.ToArray())
}

function Get-AihHarnessSuiteTableFindings {
    # Data-driven path contract check for the harness suite table: every
    # tests/....Tests.(ps1|cjs|mjs) string in Test-Harness.ps1 must use
    # forward slashes and must point at a file that exists.
    param([Parameter(Mandatory = $true)]$Root, [Parameter(Mandatory = $true)]$ParsedFiles)

    $findings = [System.Collections.Generic.List[object]]::new()
    $pattern = '(?i)^tests[\\/].+\.tests\.(ps1|cjs|mjs)$'
    foreach ($parsed in $ParsedFiles) {
        if ($parsed.File.RelativePath -ne 'scripts/Test-Harness.ps1') { continue }
        $literals = @($parsed.Ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true))
        foreach ($literal in $literals) {
            $value = [string]$literal.Value
            if ($value -notmatch $pattern) { continue }
            if ($value.Contains('\')) {
                $findings.Add([pscustomobject]@{ File = $parsed.File.RelativePath; Line = $literal.Extent.StartLineNumber; Value = $value; Kind = 'BackslashSuitePath' })
            }
            $full = Join-Path $Root $value
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
                $findings.Add([pscustomobject]@{ File = $parsed.File.RelativePath; Line = $literal.Extent.StartLineNumber; Value = $value; Kind = 'MissingSuiteFile' })
            }
        }
    }
    return ,@($findings.ToArray())
}

# ---------------------------------------------------------------------------
# Allowlist: intentional, classified occurrences (each with a justification)
# ---------------------------------------------------------------------------

# Explicit value/file allowlist for backslash-carrying literals that are NOT
# cross-platform path construction. Every entry carries its justification.
$script:AihPathLiteralAllowlistEntries = @(
    @{ File = 'scripts/Setup.ps1'; Reason = 'Windows installer (setup.sh is the POSIX installer): hint referencing the Windows-only .cmd launcher.' },
    @{ File = 'scripts/Verify-Project.ps1'; Value = 'System32\cmd.exe'; Reason = 'guarded Windows-only branch (Test-AihIsWindows) resolving the cmd.exe host for .cmd/.bat resolution.' },
    @{ File = 'tests/Intelligence.CodeFoundation.Tests.ps1'; Value = '..\evil'; Reason = 'traversal payload the store is asserted to REJECT (negative test data, not path construction).' },
    @{ File = 'tests/Intelligence.EndToEnd.Tests.ps1'; ValueContains = 'src\Host\Host.csproj'; Reason = 'Visual Studio .sln file-content fixture; the .sln format contract itself uses backslash separators.' },
    @{ File = 'tests/Intelligence.Scanning.Tests.ps1'; ValueContains = 'src\Api\Api.csproj'; Reason = 'Visual Studio .sln file-content fixture.' },
    @{ File = 'tests/SetupUpgrade.Tests.ps1'; ValueContains = 'C:\AI-Harness'; Reason = 'negative regression assertions that the legacy checkout root never returns.' },
    @{ File = 'config/versions.psd1'; ValueContains = 'C:\AI-Harness'; Reason = 'Windows DefaultInstallRoot contract value consumed only by the Windows installer.' }
)

function Test-AihPathLiteralAllowed {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Classification
    )

    # Windows drive/UNC paths and batch syntax are Windows-only values by
    # construction, not cross-platform path construction.
    if ($Classification -in @('windows-drive-path', 'windows-unc-path', 'windows-batch-syntax', 'windows-namespace-name', 'regex-escape', 'separator-normalization')) { return $true }

    # Explicit allowlist with per-entry justification (kept minimal and
    # reviewable; every entry names its file and value shape).
    if ($File -eq 'tests/Aih.PortabilityAudit.psm1') {
        # This engine's own allowlist matching data: the strings exist to
        # CLASSIFY occurrences elsewhere and never construct paths.
        return $true
    }
    if ($File -eq 'tests/PlatformSupport.Tests.ps1' -and $Value -like 'Local\AIHarness.*') {
        # Windows kernel-object namespace example: semantically a Windows-only
        # name; on POSIX the engine hex-encodes such names.
        return $true
    }
    foreach ($entry in $script:AihPathLiteralAllowlistEntries) {
        if ($entry.File -ne $File) { continue }
        if ($entry.ContainsKey('Value') -and $Value -ne $entry.Value) { continue }
        if ($entry.ContainsKey('ValueContains') -and -not $Value.Contains($entry.ValueContains)) { continue }
        return $true
    }
    return $false
}

function Invoke-AihPortabilityAudit {
    # Full audit: returns a structured object; never throws on findings.
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$SkipLiveProbe
    )

    $rootPath = [System.IO.Path]::GetFullPath($Root)
    $files = Get-AihPortabilityScanFiles -Root $rootPath
    $traits = @(foreach ($file in $files) { Get-AihPortabilityFileTraits -File $file })
    $parsed = Get-AihParsedPowerShellFiles -Files $files
    $reserved = Get-AihReservedVariableSet -SkipLiveProbe:$SkipLiveProbe
    $liveProbeHost = $null
    if (-not $SkipLiveProbe) { $liveProbeHost = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }

    $collisions = Get-AihAutomaticVariableFindings -ParsedFiles $parsed -ReservedVariables $reserved
    $installRoot = Get-AihInstallRootFindings -ParsedFiles $parsed
    $paths = Get-AihStringLiteralFindings -ParsedFiles $parsed
    $executables = Get-AihWindowsExecutableFindings -Files $files -ParsedFiles $parsed
    $linuxLaunchers = Get-AihLinuxLauncherFindings -Files $files
    $suiteTable = Get-AihHarnessSuiteTableFindings -Root $rootPath -ParsedFiles $parsed

    return [pscustomobject]@{
        GeneratedAtUtc = [DateTime]::UtcNow.ToString('o')
        Root = $rootPath
        ScannedFileCount = $files.Count
        ParsedFileCount = @($parsed).Count
        ReservedVariableCount = $reserved.Keys.Count
        LiveProbeHost = $liveProbeHost
        FileTraits = $traits
        ReservedVariables = $reserved
        AutomaticVariableFindings = $collisions
        InstallRootFindings = $installRoot
        PathFindings = $paths
        ExecutableFindings = $executables
        LinuxLauncherFindings = $linuxLaunchers
        SuiteTableFindings = $suiteTable
    }
}

function Write-AihPortabilityInventoryReport {
    # Writes the machine-readable inventory JSON to an explicit path. Callers
    # must target a temporary directory: the report is environment-specific
    # output and is never committed runtime state.
    param(
        [Parameter(Mandatory = $true)]$Audit,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $json = ConvertTo-Json -InputObject $Audit -Depth 8
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
    return $Path
}

Export-ModuleMember -Function @(
    'Get-AihPortabilityScanFiles', 'Get-AihPortabilityFileTraits', 'Invoke-AihReservedVariableProbe',
    'Get-AihReservedVariableSet', 'Get-AihParsedPowerShellFiles', 'Get-AihAutomaticVariableFindings',
    'Get-AihStringLiteralFindings', 'Get-AihInstallRootFindings', 'Get-AihWindowsExecutableFindings',
    'Get-AihLinuxLauncherFindings', 'Get-AihHarnessSuiteTableFindings', 'Invoke-AihPortabilityAudit',
    'Test-AihPathLiteralAllowed', 'Write-AihPortabilityInventoryReport'
)