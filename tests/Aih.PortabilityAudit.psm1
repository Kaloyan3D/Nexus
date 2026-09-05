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
    # TASK-0025 Class E sharpening: a string with the SHAPE of a backslash-
    # separated relative path (word/dot/dash/space segments between
    # separators) is a filesystem path, NOT a regular expression - even when
    # one of its segments starts with a letter that collides with a regex
    # escape class ('data\routing\decisions.jsonl' contains '\r',
    # 'src\widget.service.ts' contains '\w'). Previously such fixture paths
    # were silently classified 'regex-escape' and the gate missed them.
    # Genuine patterns nearly always carry a metacharacter (anchor, group,
    # quantifier) or an escape that cannot be a path segment start, so the
    # path-shape check must run BEFORE the escape-letter checks.
    param([string]$Value)

    # Path-shape predicate (TASK-0025 Class E): every backslash is followed by
    # a word character (no escaped metacharacters), a separator sits between
    # segment material, and the string has multi-segment structure or a
    # dot-extension. 'data\routing\decisions.jsonl' and
    # 'src\widget.service.ts' are paths; 'decisions\.jsonl' (escaped dot)
    # and 'function\b' (no extension/structure) remain regex-like.
    $wordBackslash = $Value -notmatch '\\[^A-Za-z0-9_]'
    $multiSegment = ([regex]::Matches($Value, '\\')).Count -ge 2
    $hasExtension = $Value -match '\.[A-Za-z0-9]+$'
    # Real filesystem paths never carry regex metacharacters; genuine
    # patterns ('(?i)sk-...\s*:', '[^\s*sudo\s]') almost always do.
    $hasMetachars = $Value -match '[()\[\]{}+*?^$|]'
    # A path segment never starts with a separator and is never a single
    # control-escape letter ('\r\n' splits lines; 'data\routing' routes).
    $pathShape = $Value -match '^[A-Za-z0-9_.\- ]+(\\[A-Za-z0-9_][A-Za-z0-9_.\- ]+)+$'
    if ($wordBackslash -and $pathShape -and ($multiSegment -or $hasExtension) -and -not $hasMetachars) { return $false }
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

        # TASK-0025 Class A strengthening: AST-constant scanning alone misses
        # occurrences embedded inside larger literals (single-quoted constants
        # that BEGIN with a quote) and inside expandable strings - exactly the
        # shapes generated executable child-script bodies use, e.g.
        # ". 'C:\AI-Harness\scripts\Intelligence.ps1'; <expression>".
        # Scan the raw file text so a generated body can never silently
        # reintroduce the legacy install root; every hit is classified
        # explicitly by the allowlist consumer.
        $seenLines = @($findings | Where-Object { $_.File -eq $parsed.File.RelativePath -and $_.Kind -eq 'LiteralOccurrence' } | ForEach-Object { $_.Line })
        $rawLines = [System.IO.File]::ReadAllLines($parsed.File.FullName)
        for ($i = 0; $i -lt $rawLines.Count; $i++) {
            if ($rawLines[$i] -notmatch '(?i)C:[\/]AI-Harness') { continue }
            if ($seenLines -contains ($i + 1)) { continue }
            $findings.Add([pscustomobject]@{
                File = $parsed.File.RelativePath; Line = ($i + 1);
                Kind = 'LiteralOccurrence'; Name = ''; Value = $rawLines[$i].Trim();
                Classification = 'review'; Detail = 'raw-text legacy-root occurrence (embedded/expandable); classify (negative assertion / guarded Windows contract / fixture)'
            })
        }
    }
    return ,@($findings.ToArray())
}

function Get-AihPathSeparatorFindings {
    # TASK-0025 Class B strengthening: hardcoded PATH separator joins. Windows
    # uses ';' and POSIX uses ':' for PATH; the only portable separator is
    # [IO.Path]::PathSeparator (PowerShell plane) / path.delimiter (Node
    # plane). A PATH mutation that joins with a literal ';'/':' produces a
    # corrupt single-entry PATH on the other OS (the exact defect that broke
    # the visual suites on Linux). The rule is line-level and generic so a
    # new file with the same defect is caught automatically.
    param([Parameter(Mandatory = $true)]$ParsedFiles)

    $findings = [System.Collections.Generic.List[object]]::new()
    foreach ($parsed in $ParsedFiles) {
        if ($parsed.File.RelativePath -eq 'tests/Aih.PortabilityAudit.psm1') { continue }  # this engine's own detection data
        $lines = [System.IO.File]::ReadAllLines($parsed.File.FullName)
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $line = $lines[$i]
            # The rule targets PATH construction only: a literal ';'/':' join
            # on a line that touches PATH (or a PATH-like variable). Generic
            # ':' concatenations (dictionary keys) are not PATH joins.
            $mentionsPath = $line -match 'env:PATH' -or $line -match 'env:Path' -or $line -match '\bPATH\b'
            if (-not $mentionsPath) { continue }
            $isPathMutation = $line -match 'env:PATH\s*=' -or $line -match 'env:Path\s*='
            $isSeparatorJoin = $line -match "\+';'\+" -or $line -match '\+";"\+' -or $line -match "\+ ':' \+"
            if (-not $isPathMutation -and -not $isSeparatorJoin) { continue }
            if ($line -match '\[IO\.Path\]::PathSeparator') { continue }
            if ($line -notmatch '[''"](;|:)[''"]') { continue }
            $findings.Add([pscustomobject]@{
                File = $parsed.File.RelativePath; Line = ($i + 1); Kind = 'PathSeparatorJoin';
                Value = $line.Trim();
                Classification = 'review';
                Detail = 'PATH joined with a literal platform-specific separator; use [IO.Path]::PathSeparator (PowerShell) or path.delimiter (Node)'
            })
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
    @{ File = 'scripts/Verify-Project.ps1'; Value = 'System32\WindowsPowerShell\v1.0\powershell.exe'; Reason = 'guarded Windows-only branch (Test-AihIsWindows) resolving the fixed Windows PowerShell 5.1 host path.' },
    @{ File = 'tests/Harness.Tests.ps1'; Value = 'data\routing\decisions.jsonl'; Reason = 'separator-agnostic source-scan regression: backslash-style relative path is INTENTIONAL negative test data for the component classifier.' },
    @{ File = 'tests/Harness.Tests.ps1'; Value = '.ai-harness\state\tasks.json'; Reason = 'separator-agnostic source-scan regression: backslash-style relative path is INTENTIONAL negative test data for the component classifier.' },
    @{ File = 'tests/Harness.Tests.ps1'; Value = 'runtime\node\lib\x.js'; Reason = 'separator-agnostic source-scan regression: backslash-style relative path is INTENTIONAL negative test data for the component classifier.' },
    @{ File = 'tests/Harness.Tests.ps1'; Value = 'src\real-key.ps1'; Reason = 'separator-agnostic source-scan regression: backslash-style relative path is INTENTIONAL negative test data for the component classifier.' },
    @{ File = 'scripts/Project.ps1'; Value = 'System32\WindowsPowerShell\v1.0\powershell.exe'; Reason = 'guarded Windows-only branch (Test-AihIsWindows) resolving the fixed Windows PowerShell 5.1 host path.' },
    @{ File = 'scripts/Engineering/Execution.ps1'; Value = 'System32\WindowsPowerShell\v1.0\powershell.exe'; Reason = 'guarded Windows-only branch (Test-AihIsWindows) resolving the fixed Windows PowerShell 5.1 host path.' },
    @{ File = 'tests/Intelligence.CodeFoundation.Tests.ps1'; Value = '..\evil'; Reason = 'traversal payload the store is asserted to REJECT (negative test data, not path construction).' },
    @{ File = 'tests/Intelligence.CodeFoundation.Tests.ps1'; Value = 'snap_x\..\y'; Reason = 'traversal payload the store is asserted to REJECT (negative test data, not path construction).' },
    @{ File = 'tests/Intelligence.CodeFoundation.Tests.ps1'; Value = '..\state.json'; Reason = 'traversal payload the store is asserted to REJECT (negative test data, not path construction).' },
    @{ File = 'tests/Intelligence.CodeFoundation.Tests.ps1'; Value = '..\..\secret.ts'; Reason = 'traversal payload the store is asserted to REJECT (negative test data, not path construction).' },
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

function Get-AihPlatformDependencyFindings {
    # TASK-0025: platform-layer dependency direction. The platform layer
    # (scripts/Platform.ps1) MUST be independently sourceable: it may not
    # invoke any function that is defined only by a HIGHER layer
    # (scripts/Common.ps1). Detected via the AST: every command invoked in
    # Platform.ps1 that is defined in Common.ps1 but not in Platform.ps1 is
    # a reverse dependency.
    param([Parameter(Mandatory = $true)]$Root)

    $findings = [System.Collections.Generic.List[object]]::new()
    $platformPath = Join-Path $Root 'scripts/Platform.ps1'
    $commonPath = Join-Path $Root 'scripts/Common.ps1'
    if (-not (Test-Path -LiteralPath $platformPath) -or -not (Test-Path -LiteralPath $commonPath)) { return @() }
    $platformErrors = $null
    $platformAst = [System.Management.Automation.Language.Parser]::ParseFile($platformPath, [ref]$null, [ref]$platformErrors)
    if ($platformErrors.Count -gt 0) { return @() }
    $commonAst = [System.Management.Automation.Language.Parser]::ParseFile($commonPath, [ref]$null, [ref]$null)
    $platformDefined = @($platformAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
    $commonDefined = @($commonAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
    $commonOnly = @($commonDefined | Where-Object { $platformDefined -notcontains $_ })
    if ($commonOnly.Count -eq 0) { return @() }
    $commands = $platformAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true)
    $platformLines = [System.IO.File]::ReadAllLines($platformPath)
    foreach ($command in $commands) {
        $name = [string]$command.GetCommandName()
        if ($commonOnly -contains $name) {
            $findings.Add([pscustomobject]@{
                Kind = 'PlatformReverseDependency'; File = 'scripts/Platform.ps1'; Line = $command.Extent.StartLineNumber
                Token = $name; Classification = 'platform-reverse-dependency'
                Detail = 'Platform.ps1 invokes a function defined only by Common.ps1; the platform layer must stay independently sourceable.'
            })
        }
    }
    return @($findings)
}

function Get-AihEntrypointPlatformFindings {
    # TASK-0027: directly executable entrypoints must SELF-LOAD the platform
    # abstraction. A script reachable as a launcher target (bin/*.cmd, the
    # POSIX launcher twins, extensionless installed launchers) or referenced
    # by an installer entrypoint may invoke a Platform.ps1-owned function
    # only after dot-sourcing Platform.ps1 or Common.ps1 from its own
    # directory: a fresh CLI process (aih-update) preloads nothing, and the
    # unguarded call died with CommandNotFoundException before any platform
    # branch resolved. References nested inside function definitions execute
    # only when that function is invoked (after top-level loads), so only
    # top-level references before the first load are findings.
    param([Parameter(Mandatory = $true)][string]$Root)

    $findings = [System.Collections.Generic.List[object]]::new()
    $rootPath = [System.IO.Path]::GetFullPath($Root)
    $platformPath = Join-Path $rootPath 'scripts/Platform.ps1'
    if (-not (Test-Path -LiteralPath $platformPath -PathType Leaf)) { return @() }
    $platformErrors = $null
    $platformAst = [System.Management.Automation.Language.Parser]::ParseFile($platformPath, [ref]$null, [ref]$platformErrors)
    if ($null -eq $platformAst -or $platformErrors.Count -gt 0) { return @() }
    $platformOwned = @($platformAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
    if ($platformOwned.Count -eq 0) { return @() }

    # Entrypoint discovery is launcher-derived and stays self-maintaining:
    # every scripts/*.ps1 a launcher or installer entrypoint references is
    # directly executable in a fresh process. The launcher planes are text-
    # scanned because launchers are plain command lines (bin/*.cmd in the
    # Windows/source plane, bin/linux/*.sh twins in the checkout, and the
    # extensionless installed launchers an installed POSIX tree publishes).
    $entrypoints = [System.Collections.Generic.List[string]]::new()
    $binDir = Join-Path $rootPath 'bin'
    if (Test-Path -LiteralPath $binDir -PathType Container) {
        foreach ($launcher in @(Get-ChildItem -LiteralPath $binDir -File -ErrorAction SilentlyContinue)) {
            $launcherText = [System.IO.File]::ReadAllText($launcher.FullName)
            foreach ($match in [regex]::Matches($launcherText, 'scripts[\\/][A-Za-z0-9_.\-]+\.ps1')) {
                $entrypoints.Add(($match.Value -replace '\\', '/'))
            }
        }
        $linuxDir = Join-Path $binDir 'linux'
        if (Test-Path -LiteralPath $linuxDir -PathType Container) {
            foreach ($launcher in @(Get-ChildItem -LiteralPath $linuxDir -File -ErrorAction SilentlyContinue)) {
                $launcherText = [System.IO.File]::ReadAllText($launcher.FullName)
                foreach ($match in [regex]::Matches($launcherText, 'scripts/[A-Za-z0-9_.\-]+\.ps1')) {
                    $entrypoints.Add($match.Value)
                }
            }
        }
    }
    foreach ($installer in @('setup.ps1', 'setup.sh')) {
        $installerPath = Join-Path $rootPath $installer
        if (Test-Path -LiteralPath $installerPath -PathType Leaf) {
            $installerText = [System.IO.File]::ReadAllText($installerPath)
            foreach ($match in [regex]::Matches($installerText, 'scripts[\\/][A-Za-z0-9_.\-]+\.ps1')) {
                $entrypoints.Add(($match.Value -replace '\\', '/'))
            }
            if ($installer -like '*.ps1') { $entrypoints.Add($installer) }
        }
    }

    $seen = @{}
    foreach ($relative in @($entrypoints | Select-Object -Unique)) {
        $key = $relative.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $scriptPath = Join-Path $rootPath $relative
        if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { continue }
        $parseErrors = $null
        $scriptAst = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$parseErrors)
        # Parse failures are reported by the dedicated parse gate; skip here.
        if ($null -eq $scriptAst -or $parseErrors.Count -gt 0) { continue }
        $localDefined = @($scriptAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
        $ownedCalled = @($platformOwned | Where-Object { $localDefined -notcontains $_ })
        if ($ownedCalled.Count -eq 0) { continue }
        $commands = @($scriptAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true))
        $callSites = @($commands | Where-Object { $ownedCalled -contains [string]$_.GetCommandName() })
        if ($callSites.Count -eq 0) { continue }
        # A load is a dot-invoked command whose text names the platform layer:
        # `. (Join-Path $PSScriptRoot 'Platform.ps1')` or the Common.ps1 form.
        $loadLines = @($commands | Where-Object {
            [int]$_.InvocationOperator -eq [int][System.Management.Automation.Language.TokenKind]::Dot -and
            $_.Extent.Text -match '(Platform|Common)\.ps1'
        } | ForEach-Object { $_.Extent.StartLineNumber })
        $firstLoadLine = if ($loadLines.Count -gt 0) { (@($loadLines) | Measure-Object -Minimum).Minimum } else { [int]::MaxValue }
        $functionExtents = @($scriptAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Extent })
        foreach ($call in $callSites) {
            $insideFunction = $false
            foreach ($extent in $functionExtents) {
                if ($call.Extent.StartOffset -ge $extent.StartOffset -and $call.Extent.EndOffset -le $extent.EndOffset) { $insideFunction = $true; break }
            }
            if ($insideFunction) { continue }
            if ($call.Extent.StartLineNumber -ge $firstLoadLine) { continue }
            $findings.Add([pscustomobject]@{
                Kind = 'EntrypointPlatformBeforeLoad'; File = $relative; Line = $call.Extent.StartLineNumber
                Token = [string]$call.GetCommandName(); Classification = 'entrypoint-platform-before-load'
                Detail = 'a directly executable entrypoint invokes a Platform.ps1-owned function before dot-sourcing Platform.ps1/Common.ps1; a fresh CLI process fails with CommandNotFoundException.'
            })
        }
    }
    return @($findings)
}

function Get-AihJsExecutableFindings {
    # TASK-0025 RC4: the JS plane (*.js, *.cjs, *.mjs) was outside the
    # PowerShell-centric audit. Flags hardcoded Windows-executable literals
    # (powershell.exe / cmd.exe / .cmd references) in JS sources; a literal
    # inside a platform-guarded context is verified by the gate through the
    # Guard proximity check, and the shared test transport carries its own
    # documented allowance.
    param([Parameter(Mandatory = $true)]$Root)

    $findings = [System.Collections.Generic.List[object]]::new()
    $rootPath = [System.IO.Path]::GetFullPath($Root)
    $allFiles = [System.Collections.Generic.List[string]]::new()
    $stackDirs = [System.Collections.Generic.Stack[string]]::new()
    $stackDirs.Push($rootPath)
    # Segment-wise pruning: EVERY path segment matching one of these names is
    # excluded. 'app' is the harness vendor checkout at the repository root
    # (third-party DSH implementation), not Nexus product source.
    $excludedSegments = @('.git', 'node_modules', 'runtime', 'coverage', 'dist', 'build', 'logs', 'data', 'tmp', '_audit', '_tmp_ws', '.ai-harness', '.vscode', 'app')
    while ($stackDirs.Count -gt 0) {
        $dir = $stackDirs.Pop()
        $children = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)
        foreach ($child in $children) {
            if ($child.Attributes -band [IO.FileAttributes]::Directory) {
                if ($excludedSegments -contains $child.Name) { continue }
                $stackDirs.Push($child.FullName)
            }
            else {
                $extension = [IO.Path]::GetExtension($child.Name).ToLowerInvariant()
                if ($extension -in @('.js', '.cjs', '.mjs')) { $allFiles.Add($child.FullName) }
            }
        }
    }
    foreach ($file in $allFiles) {
        $relative = $file.Substring($rootPath.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Replace('\', '/')
        $lines = [System.IO.File]::ReadAllLines($file)
        for ($i = 0; $i -lt $lines.Count; $i++) {
            # Strip comments before matching so documented rationale in
            # comments never produces a finding: block comments on one line,
            # then line comments not preceded by a URL colon.
            $line = $lines[$i] -replace '/\*.*?\*/', ''
            $line = $line -replace '(?<!:)//.*$', ''
            foreach ($token in @('powershell.exe', 'cmd.exe')) {
                if ($line.ToLowerInvariant().Contains($token)) {
                    $findings.Add([pscustomobject]@{
                        Kind = 'JsWindowsExecutable'; File = $relative; Line = ($i + 1); Token = $token
                        Classification = 'js-platform-executable'; Detail = 'hardcoded Windows executable literal in a JS source'
                    })
                }
            }
            if ($line -match '\x27\.cmd\x27|\x22\.cmd\x22|\.cmd[\x27\x22 ]') {
                $findings.Add([pscustomobject]@{
                    Kind = 'JsCmdReference'; File = $relative; Line = ($i + 1); Token = '.cmd'
                    Classification = 'js-cmd-assumption'; Detail = 'a .cmd file is referenced or created in a JS source'
                })
            }
        }
    }
    return @($findings)
}

function Get-AihWindowsFixtureFindings {
    # TASK-0025 RC3: Windows-only fixture technologies in test suites.
    # System.Drawing is unsupported on POSIX pwsh (.NET 6+), so a test that
    # GENERATES fixtures with it fails on Linux. Tests must use committed
    # platform-neutral fixtures. Production decoders with graceful SKIPPED
    # fallbacks are outside this scan (scripts are not scanned here).
    param([Parameter(Mandatory = $true)]$Root)

    $findings = [System.Collections.Generic.List[object]]::new()
    $rootPath = [System.IO.Path]::GetFullPath($Root)
    $testsDir = Join-Path $rootPath 'tests'
    if (-not (Test-Path -LiteralPath $testsDir)) { return @() }
    foreach ($file in @(Get-ChildItem -LiteralPath $testsDir -Filter '*.Tests.ps1' -File -Recurse -ErrorAction SilentlyContinue)) {
        $relative = 'tests/' + $file.Name
        $lines = [System.IO.File]::ReadAllLines($file.FullName)
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $trimmedLine = $lines[$i].TrimStart()
            if ($trimmedLine.StartsWith('#')) { continue }   # rationale comments never count as fixture technology
            if ($lines[$i] -match 'System\.Drawing') {
                $findings.Add([pscustomobject]@{
                    Kind = 'WindowsOnlyFixtureTechnology'; File = $relative; Line = ($i + 1); Token = 'System.Drawing'
                    Classification = 'windows-only-fixture'; Detail = 'a PowerShell test suite generates fixtures with System.Drawing, which is unavailable on POSIX pwsh'
                })
            }
        }
    }
    return @($findings)
}

function Get-AihOsAssumptionFindings {
    # TASK-0026 class detectors, each proven by the real CachyOS
    # installed-tree audit. Structural shapes only - never a per-file
    # blacklist. This module's own detection data is exempt.
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][object[]]$Files)

    $findings = [System.Collections.Generic.List[object]]::new()

    # Class A: backslash-anchored component filter. A single-quoted string
    # literal of the shape '\\(alternation)\\' assumes FullName uses
    # backslashes around directory components; on POSIX such a filter
    # never matches, excluded trees silently enter the scan, and runtime
    # state with credential-shaped task text produced a false SOURCE
    # credential finding.
    foreach ($file in $Files) {
        if ($file.RelativePath -eq 'tests/Aih.PortabilityAudit.psm1') { continue }
        $fileExtension = [System.IO.Path]::GetExtension($file.FullName)
        if ($fileExtension -ne '.ps1' -and $fileExtension -ne '.psm1') { continue }
        $lines = [System.IO.File]::ReadAllLines($file.FullName)
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -notmatch "''[^'']{0,240}") { continue }  # cheap prefilter: a quoted literal is present
            if ($lines[$i] -match '\\\\[^''\r\n]{1,160}\\\\') { continue }  # a \\\\...\\\\ pair alone is a normal UNC/regex escape, not the anchored-component shape
            if ($lines[$i] -match '\\\\\([^''\r\n]{1,160}\)\\\\') {
                $findings.Add([pscustomobject]@{ File = $file.RelativePath; Line = ($i + 1); Kind = 'BackslashComponentFilter'; Token = ''; Value = $lines[$i].Trim(); Classification = 'review'; Detail = 'path filter hardcodes backslash-anchored directory components; use separator-agnostic component logic' })
            }
        }
    }

    # Class B: a Windows-only behavioral contract asserted without a
    # platform simulation or guard. A PS test that binds/asserts
    # Start-Process WindowStyle can only ever pass on Windows unless the
    # file simulates the platform (function override) or the occurrence
    # sits inside a Test-AihIsWindows guard.
    $psTestFiles = @($Files | Where-Object { $_.RelativePath -like 'tests/*.Tests.ps1' })
    foreach ($file in $psTestFiles) {
        # The audit engine and the gate test carry their own detection/
        # allowlist data; their WindowStyle mentions are classification
        # inputs, never behavioral assertions.
        if ($file.RelativePath -eq 'tests/Aih.PortabilityAudit.psm1' -or $file.RelativePath -eq 'tests/PowerShellPortability.Tests.ps1') { continue }
        $lines = [System.IO.File]::ReadAllLines($file.FullName)
        $windowLines = @()
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match 'WindowStyle') { $windowLines += $i } }
        if ($windowLines.Count -eq 0) { continue }
        $text = [System.IO.File]::ReadAllText($file.FullName)
        if ($text -match 'function:Test-AihIsWindows' -or $text -match 'function\s+Test-AihIsWindows') { continue }
        $unguarded = @()
        foreach ($idx in $windowLines) {
            $from = [Math]::Max(0, $idx - 4); $to = [Math]::Min($lines.Count - 1, $idx + 4)
            $guarded = $false
            for ($i = $from; $i -le $to; $i++) { if ($lines[$i] -match 'Test-AihIsWindows') { $guarded = $true; break } }
            if (-not $guarded) { $unguarded += ($idx + 1) }
        }
        if ($unguarded.Count -gt 0) {
            $findings.Add([pscustomobject]@{ File = $file.RelativePath; Line = $unguarded[0]; Kind = 'WindowsContractWithoutPlatformSimulation'; Token = 'WindowStyle'; Value = ($unguarded -join ','); Classification = 'review'; Detail = 'Windows-only behavior asserted without simulating the platform; force Test-AihIsWindows per section and restore it' })
        }
    }

    # Class C: a source-only config artifact read by a JS suite without a
    # layout-plane guard. The install composition copies a SELECTED config
    # set; source-only metadata (config/*.psd1) legitimately does not exist
    # in an installed tree, so an unconditional read is an ENOENT crash.
    $jsTestFiles = @($Files | Where-Object { $_.RelativePath -like 'tests/*.Tests.cjs' -or $_.RelativePath -like 'tests/*.mjs' })
    foreach ($file in $jsTestFiles) {
        if ($file.RelativePath -eq 'tests/Aih.PortabilityAudit.psm1') { continue }
        $text = [System.IO.File]::ReadAllText($file.FullName)
        if ($text -notmatch 'config/[A-Za-z0-9._-]+\.psd1') { continue }
        if ($text -match 'layout\.kind') { continue }
        $lines = [System.IO.File]::ReadAllLines($file.FullName)
        $line = 1
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match 'config/[A-Za-z0-9._-]+\.psd1') { $line = $i + 1; break } }
        $findings.Add([pscustomobject]@{ File = $file.RelativePath; Line = $line; Kind = 'SourceOnlyConfigArtifactWithoutPlaneGuard'; Token = 'config/*.psd1'; Value = ''; Classification = 'review'; Detail = 'source-only config artifact read without a layout-plane guard; scope the read to the plane that owns the artifact' })
    }

    return ,@($findings.ToArray())
}

function Get-AihResultSchemaFindings {
    # TASK-0025 RC5: invariant result-object schemas. For each declared
    # contract (a named function that returns result objects), EVERY object
    # the function returns must define the SAME key set, including every
    # required key. A future return site that forgets a key fails the gate.
    param([Parameter(Mandatory = $true)]$Root)

    $contracts = @(
        @{
            File = 'scripts/Verify-Project.ps1'; Function = 'Invoke-AihVerificationCommand'
            RequiredKeys = @('Name', 'Kind', 'Status', 'ExitCode', 'DurationSeconds', 'StartedAtUtc', 'FinishedAtUtc', 'Command', 'WorkingDirectory', 'StandardOutput', 'StandardError', 'Error')
            Reason = 'the controller bridge and JSON reports consume verification results unconditionally'
        }
    )
    $findings = [System.Collections.Generic.List[object]]::new()
    foreach ($contract in $contracts) {
        $path = Join-Path $Root ($contract.File -replace '/', [IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$parseErrors)
        if ($parseErrors.Count -gt 0) { continue }
        $functionAst = @($ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | Where-Object { $_.Name -eq $contract.Function })
        if ($functionAst.Count -eq 0) { continue }
        $returnStatements = $functionAst[0].Body.FindAll({ param($a) $a -is [System.Management.Automation.Language.ReturnStatementAst] }, $true)
        foreach ($returnStatement in $returnStatements) {
            if ($null -eq $returnStatement.Pipeline) { continue }
            $hashAsts = $returnStatement.Pipeline.FindAll({ param($a) $a -is [System.Management.Automation.Language.HashtableAst] }, $true)
            foreach ($hashAst in $hashAsts) {
                $keys = @($hashAst.KeyValuePairs | ForEach-Object {
                    if ($_.Item1 -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Item1.Value } else { $null }
                } | Where-Object { $null -ne $_ })
                foreach ($requiredKey in $contract.RequiredKeys) {
                    if ($keys -notcontains $requiredKey) {
                        $findings.Add([pscustomobject]@{
                            Kind = 'ResultSchemaMismatch'; File = $contract.File; Line = $returnStatement.Extent.StartLineNumber
                            Token = $requiredKey; Classification = 'inconsistent-result-schema'
                            Detail = ('return site in ' + $contract.Function + ' does not define ' + $requiredKey + '; every result must carry the full schema')
                        })
                    }
                }
            }
        }
    }
    return @($findings)
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
    $pathSeparators = Get-AihPathSeparatorFindings -ParsedFiles $parsed
    $executables = Get-AihWindowsExecutableFindings -Files $files -ParsedFiles $parsed
    $linuxLaunchers = Get-AihLinuxLauncherFindings -Files $files
    $suiteTable = Get-AihHarnessSuiteTableFindings -Root $rootPath -ParsedFiles $parsed
    $platformDeps = Get-AihPlatformDependencyFindings -Root $rootPath
    $entrypointPlatform = Get-AihEntrypointPlatformFindings -Root $rootPath
    $jsExecutables = Get-AihJsExecutableFindings -Root $rootPath
    $windowsFixtures = Get-AihWindowsFixtureFindings -Root $rootPath
    $resultSchemas = Get-AihResultSchemaFindings -Root $rootPath
    $osAssumptions = Get-AihOsAssumptionFindings -Root $rootPath -Files $files

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
        PathSeparatorFindings = $pathSeparators
        ExecutableFindings = $executables
        LinuxLauncherFindings = $linuxLaunchers
        SuiteTableFindings = $suiteTable
        PlatformDependencyFindings = $platformDeps
        EntrypointPlatformFindings = $entrypointPlatform
        JsExecutableFindings = $jsExecutables
        WindowsFixtureFindings = $windowsFixtures
        ResultSchemaFindings = $resultSchemas
        OsAssumptionFindings = $osAssumptions
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
    'Get-AihPathSeparatorFindings',
    'Get-AihLinuxLauncherFindings', 'Get-AihHarnessSuiteTableFindings', 'Invoke-AihPortabilityAudit',
    'Get-AihPlatformDependencyFindings', 'Get-AihEntrypointPlatformFindings', 'Get-AihJsExecutableFindings', 'Get-AihWindowsFixtureFindings',
    'Get-AihResultSchemaFindings', 'Test-AihPathLiteralAllowed', 'Write-AihPortabilityInventoryReport'
)