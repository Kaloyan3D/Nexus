Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Nexus Repository Foundation (Phase 3.1) — common infrastructure ─────────
# Conventions inherited from the Nexus codebase:
#   * explicit UTF-8 at every text boundary;
#   * atomic JSON replacement for mutable snapshots, JSONL for histories;
#   * prefixed, globally unique identifiers (mach_/ws_/repo_/checkout_/snap_/module_);
#   * fail-closed readers (corrupt mutable state is an error, never a guess).

function Get-AihIntelligenceStoreRoot {
    # Resolves the default intelligence store root. Runtime state is not project
    # source, so it lives under the Nexus data tree (excluded from Git).
    param([string]$StoreRoot)
    if (-not [string]::IsNullOrWhiteSpace($StoreRoot)) {
        return [IO.Path]::GetFullPath($StoreRoot)
    }
    $installRoot = Get-AihInstallRoot $null
    return (Join-Path (Join-Path $installRoot 'data') 'intelligence')
}

function Get-AihIntelligenceLayout {
    param([string]$StoreRoot)
    $root = Get-AihIntelligenceStoreRoot $StoreRoot
    [pscustomobject]@{
        Root        = $root
        Machine     = Join-Path $root 'machine.json'
        Events      = Join-Path $root 'events.jsonl'
        Workspaces  = Join-Path $root 'workspaces.json'
        Repositories= Join-Path $root 'repositories.json'
        Checkouts   = Join-Path $root 'checkouts.json'
        FileObjects = Join-Path (Join-Path $root 'file-objects') 'objects.json'
        SnapshotsDir= Join-Path $root 'snapshots'
        ModulesDir  = Join-Path $root 'modules'
        ModulesRepositoryDir = { param([string]$RepositoryId) Join-Path (Join-Path $root 'modules') $RepositoryId }.GetNewClosure()
        SnapshotsRepositoryDir = { param([string]$RepositoryId) Join-Path (Join-Path $root 'snapshots') $RepositoryId }.GetNewClosure()
        SnapshotDir = { param([string]$RepositoryId, [string]$SnapshotId) Join-Path (Join-Path (Join-Path $root 'snapshots') $RepositoryId) $SnapshotId }.GetNewClosure()
    }
}

function New-AihIntelligenceId {
    param([Parameter(Mandatory = $true)][string]$Prefix)
    # Prefixed random identity, consistent with the existing Nexus ID strategy
    # (OBJ-/TASK- prefixed identifiers). Not derived from hardware or paths.
    return ('{0}_{1}' -f $Prefix, [guid]::NewGuid().ToString('N'))
}

function New-AihDeterministicId {
    param(
        [Parameter(Mandatory = $true)][string]$Prefix,
        [Parameter(Mandatory = $true)][string]$Seed
    )
    # Deterministic identity for entities whose natural key is stable
    # (repository-relative module paths). Same seed => same id.
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Seed)
        $hex = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
    return ('{0}_{1}' -f $Prefix, $hex.Substring(0, 24))
}

function Get-AihIntelligenceMutexName {
    param([Parameter(Mandatory = $true)][string]$StoreRoot)
    $bytes = [Text.Encoding]::UTF8.GetBytes(([IO.Path]::GetFullPath($StoreRoot)).ToLowerInvariant())
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $suffix = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').Substring(0, 24) } finally { $sha.Dispose() }
    return "AihIntelligence-$suffix"
}

function Use-AihIntelligenceLock {
    param(
        [Parameter(Mandatory = $true)][string]$StoreRoot,
        [Parameter(Mandatory = $true)][scriptblock]$Script
    )
    $mutex = [Threading.Mutex]::new($false, (Get-AihIntelligenceMutexName $StoreRoot)); $taken = $false
    try {
        try { $taken = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $taken = $true }
        if (-not $taken) { throw 'Timed out waiting for the intelligence store lock.' }
        return & $Script
    } finally { if ($taken) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

function Test-AihWindowsPlatform {
    if ($env:OS -eq 'Windows_NT') { return $true }
    try { return [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows) } catch { return $false }
}

function Get-AihPathCaseKey {
    # Filesystem comparison key. Windows path comparison is case-insensitive;
    # case is never assumed on other platforms. Never used to rewrite stored
    # paths -- only for identity comparisons.
    param([Parameter(Mandatory = $true)][string]$Path)
    if (Test-AihWindowsPlatform) { return $Path.ToLowerInvariant() }
    return $Path
}

function ConvertTo-AihCheckoutRootPath {
    # PathNormalizer: canonicalize a checkout root. Produces an absolute path
    # with forward slashes and no trailing separator. Case is preserved.
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Checkout root path is empty.' }
    $resolved = $executionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $full = [IO.Path]::GetFullPath($resolved)
    $full = $full.TrimEnd('\', '/')
    if ($full -match '^[A-Za-z]:$') { $full = $full + '/' }  # bare drive root
    return $full.Replace('\', '/')
}

function Test-AihPathInsideRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$FullPath
    )
    $rootKey = Get-AihPathCaseKey ([IO.Path]::GetFullPath($Root).TrimEnd('\', '/'))
    $pathKey = Get-AihPathCaseKey ([IO.Path]::GetFullPath($FullPath).TrimEnd('\', '/'))
    if ($pathKey -eq $rootKey) { return $true }
    $sep = if (Test-AihWindowsPlatform) { '\' } else { '/' }
    return $pathKey.StartsWith($rootKey + $sep, [StringComparison]::Ordinal)
}

function ConvertTo-AihRepositoryRelativePath {
    # PathNormalizer: produce a normalized repository-relative POSIX path.
    # Accepts an absolute path under $Root or an already-relative path.
    # Windows separators are converted to '/'; case is preserved; '..' segments
    # that would escape the repository root are rejected.
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $normalized = $Path.Replace('\', '/')
    $rootPosix = $Root.Replace('\', '/').TrimEnd('/')
    if ([IO.Path]::IsPathRooted($Path) -or $normalized -match '^[A-Za-z]:/') {
        $absolute = [IO.Path]::GetFullPath($Path)
        if (-not (Test-AihPathInsideRoot -Root $Root -FullPath $absolute)) {
            throw "Path is outside the repository root: $Path"
        }
        $normalized = $absolute.TrimEnd('\', '/').Replace('\', '/').Substring($rootPosix.Length).TrimStart('/')
    }
    # collapse duplicate separators and dot segments
    $parts = @()
    foreach ($segment in $normalized.Split('/')) {
        if ($segment -eq '' -or $segment -eq '.') { continue }
        if ($segment -eq '..') {
            if ($parts.Count -eq 0) { throw "Repository-relative path escapes the repository root: $Path" }
            if ($parts.Count -eq 1) { $parts = @() } else { $parts = @($parts[0..($parts.Count - 2)]) }
            continue
        }
        $parts = @($parts) + @($segment)
    }
    return ($parts -join '/')
}

function Get-AihOptionalText {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false)) } catch { return $null }
}

function ConvertFrom-AihSimpleYaml {
    # Minimal deterministic YAML-subset parser for Nexus-owned configuration
    # (.nexus.yml) and simple foreign manifests (pnpm-workspace.yaml):
    #   * top-level scalar/map keys, one nesting level of maps;
    #   * lists of scalars ('- item'), inline or one per line;
    #   * quoted or bare scalars, true/false/null and integers.
    # Comments and blank lines are ignored. Anything else fails closed.
    param([Parameter(Mandatory = $true)][string]$Content)
    $result = [ordered]@{}
    $currentKey = $null
    foreach ($rawLine in ($Content.Replace([string][char]13, '') -split [string][char]10)) {
        if ($rawLine -match '^\s*#') { continue }
        if ([string]::IsNullOrWhiteSpace($rawLine)) { continue }
        $indent = ($rawLine.Length - $rawLine.TrimStart().Length)
        $line = $rawLine.Trim()
        if ($line -match '^-(?:\s+(.*))?$') {
            if ($null -eq $currentKey) { throw "YAML list item outside a key is unsupported: $rawLine" }
            $itemText = if ($null -ne $Matches[1]) { $Matches[1].Trim() } else { '' }
            if ($itemText -eq '') { throw "Empty YAML list item is unsupported: $rawLine" }
            $list = [System.Collections.ArrayList]::new()
            if ($null -ne $result[$currentKey]) {
                foreach ($existing in @($result[$currentKey])) { $null = $list.Add($existing) }
            }
            $null = $list.Add((ConvertFrom-AihSimpleYamlScalar $itemText))
            $result[$currentKey] = @($list.ToArray())
            continue
        }
        if ($line -match '^([^:]+):(?:\s*(.*))?$') {
            $key = $Matches[1].Trim().Trim('"', "'")
            $valueText = if ($null -ne $Matches[2]) { $Matches[2].Trim() } else { '' }
            if ($indent -eq 0) {
                $currentKey = $key
                if ($valueText -eq '') { $result[$currentKey] = $null }
                else { $result[$currentKey] = ConvertFrom-AihSimpleYamlScalar $valueText; $currentKey = $null }
            } else {
                if ($null -eq $currentKey) { throw "YAML nesting without a parent key is unsupported: $rawLine" }
                if ($null -eq $result[$currentKey] -or -not ($result[$currentKey] -is [System.Collections.IDictionary])) {
                    $result[$currentKey] = [ordered]@{}
                }
                if ($valueText -eq '') { $result[$currentKey][$key] = $null }
                else { $result[$currentKey][$key] = ConvertFrom-AihSimpleYamlScalar $valueText }
            }
            continue
        }
        throw "Unsupported YAML syntax (Phase 3.1 parser supports a strict subset): $rawLine"
    }
    return $result
}

function ConvertFrom-AihSimpleYamlScalar {
    param([Parameter(Mandatory = $true)][string]$Text)
    $value = $Text.Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        return $value.Substring(1, $value.Length - 2)
    }
    $hashIndex = $value.IndexOf(' #')
    if ($hashIndex -ge 0) { $value = $value.Substring(0, $hashIndex).Trim() }
    switch ($value) {
        'true' { return $true }
        'True' { return $true }
        'false' { return $false }
        'False' { return $false }
        'null' { return $null }
        '~' { return $null }
        default {
            $asLong = 0L
            if ([long]::TryParse($value, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$asLong)) { return $asLong }
            return $value
        }
    }
}

function Get-AihSha256Hex {
    # Stable content hashing helper. Streams bytes; never uses mtime.
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$MaxBytes = 0
    )
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try {
            if ($MaxBytes -gt 0 -and $stream.Length -gt $MaxBytes) {
                $buffer = New-Object byte[] $MaxBytes
                $read = $stream.Read($buffer, 0, $MaxBytes)
                $subset = New-Object byte[] $read
                [Array]::Copy($buffer, $subset, $read)
                return ([BitConverter]::ToString($sha.ComputeHash($subset))).Replace('-', '').ToLowerInvariant()
            }
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

function Get-AihSha256Text {
    param([Parameter(Mandatory = $true)][string]$Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}
