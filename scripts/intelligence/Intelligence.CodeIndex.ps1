Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Phase 3.2E/F: snapshot indexing, incremental reuse, queries, events ─────
# Pipeline per snapshot:
#   snapshot files (Phase 3.1 inventory) -> language detection -> provider
#   selection -> content-addressed cache lookup -> analyze or reuse ->
#   mapping/symbol/ref index rows (staged, batched JSONL) -> atomic activation.
# Quality-gate remediation invariants (TASK-0012 findings):
#   F01  analysis reads only checkout bytes that hash-match the snapshot's
#        content hash (fail closed; mismatch is recorded, never cached).
#   F02  rows are staged and activated transactionally; readers resolve only
#        the activated generation (see Intelligence.CodeStore.ps1).
#   F03  transient/provider failures are never placed in the reusable content
#        cache; reused failed documents are counted as failures.
#   F04  sensitive rows (blocked / potential_secret) are never read, parsed,
#        or persisted.
#   F06  diff treats logical symbol identity as a multiset with path evidence;
#        moves are reported only for uniquely matchable pairs.
#   F07  -Force builds a replacement generation and swaps activation only
#        after success; previously activated intelligence is retained on any
#        failure.
#   F08  persistence-boundary ids/paths are validated before every store call.
#   F09  row accumulation is linear (generic lists), JSONL writes are batched,
#        and queries stream rows through the store when it supports it.

function Invoke-AihCodeIntelligenceIndex {
    [CmdletBinding()]
    param(
        [string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$RepositoryId,
        [Parameter(Mandatory = $true)][string]$SnapshotId,
        [switch]$Force
    )
    $storeRoot = Get-AihIntelligenceStoreRoot $StoreRoot
    $store = Get-AihCodeIntelligenceStore -StoreRoot $storeRoot

    # F08: persistence-boundary identity validation before any store call.
    if (-not (Test-AihCodeStorePrefixedId -Value $RepositoryId -Prefix 'repo_')) { throw "Repository id rejected by code intelligence indexing: '$RepositoryId'" }
    if (-not (Test-AihCodeStorePrefixedId -Value $SnapshotId -Prefix 'snap_')) { throw "Snapshot id rejected by code intelligence indexing: '$SnapshotId'" }

    # Idempotent activation: an already indexed snapshot returns its state.
    $existing = & $store.GetSnapshotState $RepositoryId $SnapshotId
    if ($null -ne $existing -and -not $Force -and @('ready', 'ready_with_failures') -contains $existing.status) {
        return $existing
    }
    # F07: -Force never destroys the activated intelligence up front. The
    # replacement generation is staged and atomically activated only after the
    # rebuild completes; on any failure the previous generation stays active
    # and fully queryable.

    $snapshot = Get-AihSnapshot -StoreRoot $storeRoot -SnapshotId $SnapshotId -RepositoryId $RepositoryId   # validate
    $checkoutRoot = ''
    if (-not [string]::IsNullOrEmpty([string]$snapshot.checkoutId)) {
        try { $checkoutRoot = (Get-AihCheckout -StoreRoot $storeRoot -CheckoutId ([string]$snapshot.checkoutId)).rootPath } catch { $checkoutRoot = '' }
    }
    $fileRows = @(Get-AihSnapshotFiles -StoreRoot $storeRoot -SnapshotId $SnapshotId -RepositoryId $RepositoryId)

    $startedAt = [DateTime]::UtcNow.ToString('o')
    $null = Publish-AihIntEvent -StoreRoot $storeRoot -EventType 'intelligence.index.started' -Data ([ordered]@{
        repositoryId = $RepositoryId; snapshotId = $SnapshotId; files = $fileRows.Count
    })

    $stats = [ordered]@{
        filesConsidered = $fileRows.Count; indexed = 0; reused = 0; unsupported = 0
        failed = 0; skippedNonText = 0; skippedSensitive = 0; sourceMismatch = 0
        symbols = 0; imports = 0; exports = 0
        occurrences = 0; languages = [ordered]@{}
    }
    # F09: linear accumulation (generic lists), never @()+@() array copying.
    $mappingRows = [System.Collections.Generic.List[object]]::new()
    $symbolRows = [System.Collections.Generic.List[object]]::new()
    $refRows = [System.Collections.Generic.List[object]]::new()

    foreach ($fileRow in $fileRows) {
        $relativePath = [string]$fileRow.path

        # F04: fail-closed sensitivity gate. Sensitive rows are never read,
        # parsed, or persisted - whatever their extension or tracking state.
        $sensitivity = [string]$fileRow.sensitivity
        if ($sensitivity -eq 'blocked' -or $sensitivity -eq 'potential_secret') {
            $stats.skippedSensitive = $stats.skippedSensitive + 1
            $null = $mappingRows.Add([ordered]@{ path = $relativePath; contentHash = $fileRow.contentHash; language = ''; status = 'skipped-sensitive'; reused = $false; fileIntelligenceId = ''; providerId = ''; providerVersion = ''; moduleId = $fileRow.moduleId })
            continue
        }

        $isText = ($fileRow.indexability -eq 'text') -and (-not [bool]$fileRow.isBinary)
        if (-not $isText) {
            $stats.skippedNonText = $stats.skippedNonText + 1
            $null = $mappingRows.Add([ordered]@{ path = $relativePath; contentHash = $fileRow.contentHash; language = ''; status = 'skipped-non-text'; reused = $false; fileIntelligenceId = ''; providerId = ''; providerVersion = ''; moduleId = $fileRow.moduleId })
            continue
        }

        # F01: verify the checkout bytes against the snapshot's content hash
        # BEFORE any analysis. Analysis and caching happen only for verified
        # snapshot bytes; anything else is recorded honestly and never cached.
        $absolutePath = $null
        $content = $null
        $sourceState = 'available'
        if ([string]::IsNullOrWhiteSpace($checkoutRoot)) {
            $sourceState = 'source-missing'
        } else {
            $normalizedRelative = $null
            try { $normalizedRelative = ConvertTo-AihRepositoryRelativePath -Root $checkoutRoot -Path ($relativePath -replace '\\', '/') } catch { $normalizedRelative = $null }
            if ([string]::IsNullOrEmpty($normalizedRelative)) {
                $sourceState = 'source-outside-root'
            } else {
                $absolutePath = [IO.Path]::GetFullPath((Join-Path $checkoutRoot ($normalizedRelative -replace '/', '\')))
                if (-not (Test-AihPathInsideRoot -Root $checkoutRoot -FullPath $absolutePath)) {
                    $sourceState = 'source-outside-root'
                } elseif (-not (Test-Path -LiteralPath $absolutePath)) {
                    $sourceState = 'source-missing'
                }
            }
        }
        if ($sourceState -eq 'available') {
            try {
                $bytes = [IO.File]::ReadAllBytes($absolutePath)
                $sha = [Security.Cryptography.SHA256]::Create()
                try { $actualHash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
                # Snapshot hashes are prefixed ('sha256:<hex>'); compare hash bodies.
                $expectedHash = [string]$fileRow.contentHash
                if ($expectedHash.StartsWith('sha256:', [StringComparison]::Ordinal)) { $expectedHash = $expectedHash.Substring(7) }
                if ($actualHash -ne $expectedHash.ToLowerInvariant()) {
                    $sourceState = 'source-hash-mismatch'
                } else {
                    $content = [Text.Encoding]::UTF8.GetString($bytes)
                    if ($content.Length -gt 0 -and $content[0] -eq [char]0xFEFF) { $content = $content.Substring(1) }
                }
            } catch { $sourceState = 'source-missing' }
        }

        # Language detection uses only verified content: extension evidence
        # always; shebang evidence only when the bytes verified.
        $firstLine = ''
        if ($null -ne $content) {
            $newlineIndex = $content.IndexOf([string][char]10)
            $firstLine = $(if ($newlineIndex -ge 0) { $content.Substring(0, $newlineIndex) } else { $content })
            if ($firstLine.Length -gt 4096) { $firstLine = $firstLine.Substring(0, 4096) }
        }
        $detection = Get-AihLanguageDetection -RelativePath $relativePath -FirstLine $firstLine
        $language = $(if ($null -ne $detection) { $detection.language } else { '' })
        if ($null -ne $detection -and $stats.languages.Contains($language)) {
            $stats.languages[$language] = $stats.languages[$language] + 1
        } elseif ($null -ne $detection) {
            $stats.languages[$language] = 1
        }

        $provider = $null
        if ($null -ne $detection -and $sourceState -eq 'available') {
            foreach ($candidate in (Get-AihCodeIntelligenceProviders)) {
                if (& $candidate.canHandle $language) { $provider = $candidate; break }
            }
        }

        if ($sourceState -ne 'available') {
            # Honest, uncached failure: the snapshot's bytes could not be
            # analyzed from this checkout (missing, outside root, or mutated
            # after the snapshot was taken).
            $stats.sourceMismatch = $stats.sourceMismatch + 1
            $rowStatus = $sourceState
            $message = switch ($sourceState) {
                'source-hash-mismatch' { 'checkout bytes no longer match the snapshot content hash (fail-closed, nothing cached)' }
                'source-outside-root' { 'snapshot path resolves outside the checkout root (fail-closed)' }
                default { 'source file is not available at the checkout root (fail-closed, nothing cached)' }
            }
            $null = Publish-AihIntEvent -StoreRoot $storeRoot -EventType 'intelligence.file.failed' -Data ([ordered]@{
                repositoryId = $RepositoryId; snapshotId = $SnapshotId; path = $relativePath
                providerId = ''; message = $message
            })
            $null = $mappingRows.Add([ordered]@{ path = $relativePath; contentHash = $fileRow.contentHash; language = $language; status = $rowStatus; reused = $false; fileIntelligenceId = ''; providerId = ''; providerVersion = ''; moduleId = $fileRow.moduleId })
            continue
        }

        if ($null -eq $provider) {
            $stats.unsupported = $stats.unsupported + 1
            $null = $mappingRows.Add([ordered]@{ path = $relativePath; contentHash = $fileRow.contentHash; language = $language; status = 'unsupported'; reused = $false; fileIntelligenceId = ''; providerId = ''; providerVersion = ''; moduleId = $fileRow.moduleId })
            continue
        }

        $fileIntelligenceId = Get-AihCodeIntelligenceId -ContentHash $fileRow.contentHash -ProviderId $provider.providerId -ProviderVersion $provider.version
        $cached = & $store.GetFileIntelligence ([string]$fileRow.contentHash) ([string]$provider.providerId) ([string]$provider.version)
        $document = $null
        $reusedFailed = $false
        if ($null -ne $cached) {
            $document = $cached
            if ([string]$cached.status -eq 'failed') {
                # F03: a failed document is never success evidence, even when
                # reused from the content cache (legacy poison included).
                $stats.failed = $stats.failed + 1
                $reusedFailed = $true
                $null = Publish-AihIntEvent -StoreRoot $storeRoot -EventType 'intelligence.file.failed' -Data ([ordered]@{
                    repositoryId = $RepositoryId; snapshotId = $SnapshotId; path = $relativePath
                    providerId = $provider.providerId; message = 'reused a failed file-intelligence document; failure evidence is not success'
                })
            } else {
                $stats.reused = $stats.reused + 1
                $null = Publish-AihIntEvent -StoreRoot $storeRoot -EventType 'intelligence.file.reused' -Data ([ordered]@{
                    repositoryId = $RepositoryId; snapshotId = $SnapshotId; path = $relativePath
                    fileIntelligenceId = $fileIntelligenceId; providerId = $provider.providerId; language = $language
                })
            }
        } else {
            try {
                $moduleName = ((($relativePath -replace '\\', '/') -replace '.*/', '') -replace '\.[^.]*$', '')
                $analysis = & $provider.analyze $content $language $fileIntelligenceId $moduleName
                $document = New-AihFileIntelligenceDocument -ContentHash $fileRow.contentHash -Language $language -ProviderId $provider.providerId -ProviderVersion $provider.version -Status $analysis.status -Symbols $analysis.symbols -Imports $analysis.imports -Exports $analysis.exports -Occurrences $analysis.occurrences -Diagnostics $analysis.diagnostics
                $stats.indexed = $stats.indexed + 1
                $null = Publish-AihIntEvent -StoreRoot $storeRoot -EventType 'intelligence.file.indexed' -Data ([ordered]@{
                    repositoryId = $RepositoryId; snapshotId = $SnapshotId; path = $relativePath
                    fileIntelligenceId = $fileIntelligenceId; providerId = $provider.providerId; language = $language
                    symbols = @($analysis.symbols).Count
                })
            } catch {
                $message = $_.Exception.Message
                # F03: transient/provider failures are NOT placed into the
                # reusable content cache; the next index run retries this
                # content instead of inheriting a poisoned entry.
                $document = New-AihFileIntelligenceDocument -ContentHash $fileRow.contentHash -Language $language -ProviderId $provider.providerId -ProviderVersion $provider.version -Status 'failed' -Diagnostics @([ordered]@{ category = 'provider-error'; message = $message })
                $stats.failed = $stats.failed + 1
                $null = Publish-AihIntEvent -StoreRoot $storeRoot -EventType 'intelligence.file.failed' -Data ([ordered]@{
                    repositoryId = $RepositoryId; snapshotId = $SnapshotId; path = $relativePath
                    providerId = $provider.providerId; message = $message
                })
            }
            if ([string]$document.status -ne 'failed') {
                $null = (& $store.PutFileIntelligence $document)
            }
        }

        $mappingStatus = [string]$document.status
        $mappingFileIntelligenceId = [string]$document.fileIntelligenceId
        if ($mappingStatus -eq 'failed' -and -not $reusedFailed) { $mappingFileIntelligenceId = '' }   # no persisted document exists
        if ($mappingStatus -eq 'ready') {
            $stats.symbols = $stats.symbols + @($document.symbols).Count
            $stats.imports = $stats.imports + @($document.imports).Count
            $stats.exports = $stats.exports + @($document.exports).Count
            $stats.occurrences = $stats.occurrences + @($document.occurrences).Count
        }
        $null = $mappingRows.Add([ordered]@{ path = $relativePath; contentHash = $fileRow.contentHash; language = $language; status = $mappingStatus; reused = ($null -ne $cached); fileIntelligenceId = $mappingFileIntelligenceId; providerId = $provider.providerId; providerVersion = $provider.version; moduleId = $fileRow.moduleId })

        if ($mappingStatus -eq 'ready') {
            foreach ($symbol in @($document.symbols)) {
                $null = $symbolRows.Add([ordered]@{
                    sid = $symbol.sid; name = $symbol.name; kind = $symbol.kind; qualifiedName = $symbol.qualifiedName
                    signature = $symbol.signature; container = $symbol.container; startLine = $symbol.startLine
                    endLine = $symbol.endLine; exported = $symbol.exported; path = $relativePath
                    fileIntelligenceId = $document.fileIntelligenceId; moduleId = $fileRow.moduleId
                })
            }
            foreach ($occurrence in @($document.occurrences)) {
                if ($occurrence.role -eq 'definition') { continue }   # definitions live in the symbol index
                $null = $refRows.Add([ordered]@{
                    oid = $occurrence.oid; role = $occurrence.role; name = $occurrence.name
                    line = $occurrence.line; column = $occurrence.column; resolution = $occurrence.resolution
                    resolvedTargetId = $occurrence.resolvedTargetId; path = $relativePath
                    fileIntelligenceId = $document.fileIntelligenceId; moduleId = $fileRow.moduleId
                })
            }
        }
    }

    $status = 'ready'
    if (($stats.failed + $stats.sourceMismatch) -gt 0) { $status = 'ready_with_failures' }
    $state = [pscustomobject][ordered]@{
        schemaVersion = 1
        snapshotId    = $SnapshotId
        repositoryId  = $RepositoryId
        status        = $status
        storeName     = $store.Name
        startedAt     = $startedAt
        completedAt   = [DateTime]::UtcNow.ToString('o')
        stats         = $stats
    }
    # Order matters: staged rows first, activation state last (atomic header).
    $null = (& $store.AppendSnapshotRows $RepositoryId $SnapshotId 'mapping.jsonl' $mappingRows)
    $null = (& $store.AppendSnapshotRows $RepositoryId $SnapshotId 'symbol-index.jsonl' $symbolRows)
    $null = (& $store.AppendSnapshotRows $RepositoryId $SnapshotId 'ref-index.jsonl' $refRows)
    $null = (& $store.PutSnapshotState $RepositoryId $SnapshotId $state)

    if ($status -eq 'ready') {
        $null = Publish-AihIntEvent -StoreRoot $storeRoot -EventType 'intelligence.snapshot.ready' -Data ([ordered]@{
            repositoryId = $RepositoryId; snapshotId = $SnapshotId; stats = $stats
        })
    } else {
        $null = Publish-AihIntEvent -StoreRoot $storeRoot -EventType 'intelligence.snapshot.failed' -Data ([ordered]@{
            repositoryId = $RepositoryId; snapshotId = $SnapshotId; status = $status; failedFiles = ($stats.failed + $stats.sourceMismatch)
        })
    }
    return $state
}

# ── queries ─────────────────────────────────────────────────────────────────

function Read-AihCodeStoreRows {
    # Store seam helper for streaming queries (F09): rows are streamed through
    # the caller's callback when the store supports StreamSnapshotRows;
    # otherwise the materializing ReadSnapshotRows seam is used. The store
    # seam stays replaceable either way.
    param(
        [Parameter(Mandatory = $true)]$Store,
        [Parameter(Mandatory = $true)][string]$RepositoryId,
        [Parameter(Mandatory = $true)][string]$SnapshotId,
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][scriptblock]$OnRow
    )
    if ($null -ne $Store.PSObject.Properties['StreamSnapshotRows']) {
        return (& $Store.StreamSnapshotRows $RepositoryId $SnapshotId $FileName $OnRow)
    }
    $count = 0
    foreach ($row in @(& $Store.ReadSnapshotRows $RepositoryId $SnapshotId $FileName)) {
        if ($null -eq $row) { continue }
        $count = $count + 1
        & $OnRow $row
    }
    return $count
}

function Test-AihCodeQueryRelativePath {
    # F08: public query paths accept only normalized repository-relative POSIX
    # paths; absolute paths, drive letters, separators, and traversal are
    # rejected fail-closed.
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if ($Path -match '[\\:]') { return $false }
    if ($Path.StartsWith('/') -or $Path.EndsWith('/')) { return $false }
    foreach ($segment in $Path.Split('/')) {
        if ([string]::IsNullOrWhiteSpace($segment)) { return $false }
        if ($segment -eq '.' -or $segment -eq '..') { return $false }
    }
    return $true
}

function Assert-AihCodeQuerySnapshotScope {
    # F08: public query ids are validated before any store call.
    param([Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId)
    if (-not (Test-AihCodeStorePrefixedId -Value $RepositoryId -Prefix 'repo_')) { throw "Repository id rejected by code intelligence queries: '$RepositoryId'" }
    if (-not (Test-AihCodeStorePrefixedId -Value $SnapshotId -Prefix 'snap_')) { throw "Snapshot id rejected by code intelligence queries: '$SnapshotId'" }
}

function Get-AihSnapshotIntelligence {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId)
    Assert-AihCodeQuerySnapshotScope -RepositoryId $RepositoryId -SnapshotId $SnapshotId
    $store = Get-AihCodeIntelligenceStore -StoreRoot $StoreRoot
    return (& $store.GetSnapshotState $RepositoryId $SnapshotId)
}

function Get-AihFileIntelligence {
    # Returns { mapping, fileIntelligence } for one path inside one snapshot.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Path)
    Assert-AihCodeQuerySnapshotScope -RepositoryId $RepositoryId -SnapshotId $SnapshotId
    if (-not (Test-AihCodeQueryRelativePath -Path $Path)) { throw "Query path rejected by code intelligence queries: '$Path'" }
    $store = Get-AihCodeIntelligenceStore -StoreRoot $StoreRoot
    $matched = [System.Collections.Generic.List[object]]::new()
    $null = Read-AihCodeStoreRows -Store $store -RepositoryId $RepositoryId -SnapshotId $SnapshotId -FileName 'mapping.jsonl' -OnRow { param($row) if ([string]$row.path -eq $Path) { $matched.Add($row) } }
    if ($matched.Count -eq 0) { return $null }
    $mapping = $matched[0]
    $document = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$mapping.fileIntelligenceId)) {
        $document = & $store.GetFileIntelligenceById ([string]$mapping.fileIntelligenceId)
    }
    return [pscustomobject][ordered]@{ mapping = $mapping; fileIntelligence = $document }
}

function Find-AihCodeSymbols {
    # Definitions are symbol records; each row IS a definition.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Name, [string]$Kind = '')
    Assert-AihCodeQuerySnapshotScope -RepositoryId $RepositoryId -SnapshotId $SnapshotId
    $store = Get-AihCodeIntelligenceStore -StoreRoot $StoreRoot
    $matched = [System.Collections.Generic.List[object]]::new()
    $null = Read-AihCodeStoreRows -Store $store -RepositoryId $RepositoryId -SnapshotId $SnapshotId -FileName 'symbol-index.jsonl' -OnRow {
        param($row)
        if ([string]$row.name -eq $Name -and ([string]::IsNullOrEmpty($Kind) -or [string]$row.kind -eq $Kind)) { $matched.Add($row) }
    }
    return $matched.ToArray()
}

function Find-AihCodeDefinitions {
    # Spec-named alias of Find-AihCodeSymbols (a symbol row is a definition).
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Name, [string]$Kind = '')
    return (Find-AihCodeSymbols -StoreRoot $StoreRoot -RepositoryId $RepositoryId -SnapshotId $SnapshotId -Name $Name -Kind $Kind)
}

function Find-AihCodeReferences {
    # Reference rows: role reference/call/import with resolution states.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Name, [string]$Role = '')
    Assert-AihCodeQuerySnapshotScope -RepositoryId $RepositoryId -SnapshotId $SnapshotId
    $store = Get-AihCodeIntelligenceStore -StoreRoot $StoreRoot
    $matched = [System.Collections.Generic.List[object]]::new()
    $null = Read-AihCodeStoreRows -Store $store -RepositoryId $RepositoryId -SnapshotId $SnapshotId -FileName 'ref-index.jsonl' -OnRow {
        param($row)
        if ([string]$row.name -eq $Name -and ([string]::IsNullOrEmpty($Role) -or [string]$row.role -eq $Role)) { $matched.Add($row) }
    }
    return $matched.ToArray()
}

function Get-AihFileCodeSymbols {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Path)
    Assert-AihCodeQuerySnapshotScope -RepositoryId $RepositoryId -SnapshotId $SnapshotId
    if (-not (Test-AihCodeQueryRelativePath -Path $Path)) { throw "Query path rejected by code intelligence queries: '$Path'" }
    $store = Get-AihCodeIntelligenceStore -StoreRoot $StoreRoot
    $matched = [System.Collections.Generic.List[object]]::new()
    $null = Read-AihCodeStoreRows -Store $store -RepositoryId $RepositoryId -SnapshotId $SnapshotId -FileName 'symbol-index.jsonl' -OnRow { param($row) if ([string]$row.path -eq $Path) { $matched.Add($row) } }
    return $matched.ToArray()
}

function Get-AihFileCodeImports {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Path)
    $result = Get-AihFileIntelligence -StoreRoot $StoreRoot -RepositoryId $RepositoryId -SnapshotId $SnapshotId -Path $Path
    if ($null -eq $result -or $null -eq $result.fileIntelligence) { return @() }
    return @($result.fileIntelligence.imports)
}

function Get-AihFileCodeExports {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Path)
    $result = Get-AihFileIntelligence -StoreRoot $StoreRoot -RepositoryId $RepositoryId -SnapshotId $SnapshotId -Path $Path
    if ($null -eq $result -or $null -eq $result.fileIntelligence) { return @() }
    return @($result.fileIntelligence.exports)
}

# ── snapshot diff ───────────────────────────────────────────────────────────

function New-AihCodeSymbolIdentityGroups {
    # F06: logical symbol identity (kind|qualifiedName) is a MULTISET. Every
    # row is retained with its path evidence; duplicates are never collapsed.
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()]$Rows)
    $groups = @{}
    foreach ($row in @($Rows)) {
        $identity = [string]$row.kind + '|' + [string]$row.qualifiedName
        if (-not $groups.ContainsKey($identity)) { $groups[$identity] = [System.Collections.Generic.List[object]]::new() }
        $null = $groups[$identity].Add($row)
    }
    return $groups
}

function Get-AihSnapshotIntelligenceDiff {
    # Deterministic diff between two indexed snapshots. Prefers
    # removed+added over invented moves: rows are paired by path evidence
    # first, a move is reported only when the logical identity has exactly one
    # unpaired row on each side, and duplicate identities are never collapsed
    # (ambiguous entries carry '@<path>' evidence instead).
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$FromSnapshotId, [Parameter(Mandatory = $true)][string]$ToSnapshotId)
    Assert-AihCodeQuerySnapshotScope -RepositoryId $RepositoryId -SnapshotId $FromSnapshotId
    Assert-AihCodeQuerySnapshotScope -RepositoryId $RepositoryId -SnapshotId $ToSnapshotId
    $store = Get-AihCodeIntelligenceStore -StoreRoot $StoreRoot
    $fromFiles = @{}
    foreach ($row in @(Get-AihSnapshotFiles -StoreRoot $StoreRoot -SnapshotId $FromSnapshotId -RepositoryId $RepositoryId)) { $fromFiles[$row.path] = $row }
    $toFiles = @{}
    foreach ($row in @(Get-AihSnapshotFiles -StoreRoot $StoreRoot -SnapshotId $ToSnapshotId -RepositoryId $RepositoryId)) { $toFiles[$row.path] = $row }

    $files = [ordered]@{ added = @(); removed = @(); changed = @(); unchanged = @() }
    foreach ($path in $toFiles.Keys) {
        if (-not $fromFiles.ContainsKey($path)) { $files.added = @($files.added) + @($path); continue }
        if ([string]$fromFiles[$path].contentHash -ne [string]$toFiles[$path].contentHash) { $files.changed = @($files.changed) + @($path) }
        else { $files.unchanged = @($files.unchanged) + @($path) }
    }
    foreach ($path in $fromFiles.Keys) {
        if (-not $toFiles.ContainsKey($path)) { $files.removed = @($files.removed) + @($path) }
    }

    $fromGroups = New-AihCodeSymbolIdentityGroups -Rows @(& $store.ReadSnapshotRows $RepositoryId $FromSnapshotId 'symbol-index.jsonl')
    $toGroups = New-AihCodeSymbolIdentityGroups -Rows @(& $store.ReadSnapshotRows $RepositoryId $ToSnapshotId 'symbol-index.jsonl')
    $identities = @($fromGroups.Keys)
    foreach ($identity in @($toGroups.Keys)) {
        if (-not $fromGroups.ContainsKey($identity)) { $identities = @($identities) + @($identity) }
    }
    $identities = @($identities | Sort-Object)

    $symbols = [ordered]@{ added = @(); removed = @(); moved = @(); changed = @(); unchanged = @() }
    foreach ($identity in $identities) {
        $fromRows = @()
        if ($fromGroups.ContainsKey($identity)) { $fromRows = @($fromGroups[$identity].ToArray()) }
        $toRows = @()
        if ($toGroups.ContainsKey($identity)) { $toRows = @($toGroups[$identity].ToArray()) }
        $ambiguous = ($fromRows.Count -gt 1 -or $toRows.Count -gt 1)
        $fromRemaining = [System.Collections.Generic.List[object]]::new()
        foreach ($row in $fromRows) { $null = $fromRemaining.Add($row) }
        $toRemaining = [System.Collections.Generic.List[object]]::new()
        foreach ($row in $toRows) { $null = $toRemaining.Add($row) }

        # pair by path evidence first
        $fromByPath = @{}
        foreach ($row in $fromRows) {
            $p = [string]$row.path
            if (-not $fromByPath.ContainsKey($p)) { $fromByPath[$p] = [System.Collections.Generic.List[object]]::new() }
            $null = $fromByPath[$p].Add($row)
        }
        $toByPath = @{}
        foreach ($row in $toRows) {
            $p = [string]$row.path
            if (-not $toByPath.ContainsKey($p)) { $toByPath[$p] = [System.Collections.Generic.List[object]]::new() }
            $null = $toByPath[$p].Add($row)
        }
        foreach ($path in @($fromByPath.Keys)) {
            if (-not $toByPath.ContainsKey($path)) { continue }
            $fromAt = @($fromByPath[$path].ToArray())
            $toAt = @($toByPath[$path].ToArray())
            $pairCount = [Math]::Min($fromAt.Count, $toAt.Count)
            for ($k = 0; $k -lt $pairCount; $k++) {
                $before = $fromAt[$k]
                $after = $toAt[$k]
                $null = $fromRemaining.Remove($before)
                $null = $toRemaining.Remove($after)
                $label = $identity
                if ($ambiguous) { $label = $identity + '@' + $path }
                if ([string]$before.signature -ne [string]$after.signature) { $symbols.changed = @($symbols.changed) + @($label) }
                else { $symbols.unchanged = @($symbols.unchanged) + @($label) }
            }
        }

        if ($fromRemaining.Count -eq 1 -and $toRemaining.Count -eq 1) {
            # a move is reported only for a uniquely matchable pair
            $symbols.moved = @($symbols.moved) + @($identity)
            continue
        }
        foreach ($row in $toRemaining.ToArray()) {
            $label = $identity
            if ($toRows.Count -gt 1) { $label = $identity + '@' + [string]$row.path }
            $symbols.added = @($symbols.added) + @($label)
        }
        foreach ($row in $fromRemaining.ToArray()) {
            $label = $identity
            if ($fromRows.Count -gt 1) { $label = $identity + '@' + [string]$row.path }
            $symbols.removed = @($symbols.removed) + @($label)
        }
    }
    return [pscustomobject][ordered]@{
        fromSnapshotId = $FromSnapshotId; toSnapshotId = $ToSnapshotId; files = $files; symbols = $symbols
    }
}

# ── status / diagnostics text (Phase 3.2F) ─────────────────────────────────

function Get-AihCodeIntelligenceStatus {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId)
    $state = Get-AihSnapshotIntelligence -StoreRoot $StoreRoot -RepositoryId $RepositoryId -SnapshotId $SnapshotId
    if ($null -eq $state) { return [pscustomobject][ordered]@{ status = 'not_indexed'; text = 'Code intelligence: not indexed for this snapshot.'; state = $null } }
    $nl = [string][char]10
    $s = $state.stats
    # Stats added by the quality-gate remediation are optional on states that
    # were activated by earlier store versions; missing means zero.
    $skippedSensitive = 0
    if ($s.PSObject.Properties['skippedSensitive']) { $skippedSensitive = [int]$s.skippedSensitive }
    $sourceMismatch = 0
    if ($s.PSObject.Properties['sourceMismatch']) { $sourceMismatch = [int]$s.sourceMismatch }
    $lines = @(
        'Code intelligence status: ' + $state.status,
        'Snapshot: ' + $state.snapshotId,
        'Store: ' + $state.storeName,
        'Files considered: ' + $s.filesConsidered,
        'Indexed: ' + $s.indexed,
        'Reused: ' + $s.reused,
        'Unsupported: ' + $s.unsupported,
        'Failed: ' + $s.failed,
        'Skipped non-text: ' + $s.skippedNonText,
        'Skipped sensitive: ' + $skippedSensitive,
        'Source mismatch: ' + $sourceMismatch,
        'Symbols: ' + $s.symbols,
        'Imports: ' + $s.imports,
        'Exports: ' + $s.exports,
        'Occurrences: ' + $s.occurrences
    )
    $lines = @($lines) + @('Languages:')
    $languagePairs = @()
    if ($s.languages -is [System.Collections.IDictionary]) {
        foreach ($language in $s.languages.Keys) { $languagePairs = @($languagePairs) + @(@{ k = [string]$language; v = $s.languages[$language] }) }
    } else {
        foreach ($property in @($s.languages.PSObject.Properties)) { $languagePairs = @($languagePairs) + @(@{ k = [string]$property.Name; v = $property.Value }) }
    }
    foreach ($pair in ($languagePairs | Sort-Object -Property k)) { $lines = @($lines) + @('  ' + $pair.k + ': ' + $pair.v) }
    $lines = @($lines) + @('Providers:')
    foreach ($provider in (Get-AihCodeIntelligenceProviders)) {
        $lines = @($lines) + @('  ' + $provider.providerId + ' v' + $provider.version + ' [' + (@($provider.languages) -join ', ') + ']')
    }
    return [pscustomobject][ordered]@{ status = $state.status; text = ($lines -join $nl); state = $state }
}