Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Phase 3.2E/F: snapshot indexing, incremental reuse, queries, events ─────
# Pipeline per snapshot:
#   snapshot files (Phase 3.1 inventory) -> language detection -> provider
#   selection -> content-addressed cache lookup -> analyze or reuse ->
#   mapping/symbol/ref index rows (JSONL appends) -> atomic activation state.
# One changed source file rewrites exactly ONE file-intelligence document;
# every other file is reused from cache. Historical intelligence is never
# destroyed: snapshot mappings/indexes are append-only per snapshot.

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

    # Idempotent activation: an already indexed snapshot returns its state.
    $existing = & $store.GetSnapshotState $RepositoryId $SnapshotId
    if ($null -ne $existing -and -not $Force -and @('ready', 'ready_with_failures') -contains $existing.status) {
        return $existing
    }
    if ($Force) { $null = (& $store.DeleteSnapshotIntelligence $RepositoryId $SnapshotId) }

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
        failed = 0; skippedNonText = 0; symbols = 0; imports = 0; exports = 0
        occurrences = 0; languages = [ordered]@{}
    }
    $mappingRows = @()
    $symbolRows = @()
    $refRows = @()

    foreach ($fileRow in $fileRows) {
        $isText = ($fileRow.indexability -eq 'text') -and (-not [bool]$fileRow.isBinary)
        if (-not $isText) {
            $stats.skippedNonText = $stats.skippedNonText + 1
            $mappingRows = @($mappingRows) + @([ordered]@{ path = $fileRow.path; contentHash = $fileRow.contentHash; language = ''; status = 'skipped-non-text'; reused = $false; fileIntelligenceId = ''; providerId = ''; providerVersion = ''; moduleId = $fileRow.moduleId })
            continue
        }

        $absolutePath = $null
        $firstLine = ''
        $content = $null
        try {
            if (-not [string]::IsNullOrWhiteSpace($checkoutRoot)) {
                $absolutePath = Join-Path $checkoutRoot ($fileRow.path -replace '/', '\')
            }
            if ($null -ne $absolutePath -and (Test-Path -LiteralPath $absolutePath)) {
                $stream = [IO.StreamReader]::new($absolutePath)
                try { $firstLine = $stream.ReadLine() } finally { $stream.Close() }
            }
        } catch { $firstLine = '' }

        $detection = Get-AihLanguageDetection -RelativePath $fileRow.path -FirstLine $firstLine
        $language = $(if ($null -ne $detection) { $detection.language } else { '' })
        if ($null -ne $detection -and $stats.languages.Contains($language)) {
            $stats.languages[$language] = $stats.languages[$language] + 1
        } elseif ($null -ne $detection) {
            $stats.languages[$language] = 1
        }

        $provider = $null
        if ($null -ne $detection) {
            foreach ($candidate in (Get-AihCodeIntelligenceProviders)) {
                if (& $candidate.canHandle $language) { $provider = $candidate; break }
            }
        }
        if ($null -eq $provider) {
            $stats.unsupported = $stats.unsupported + 1
            $mappingRows = @($mappingRows) + @([ordered]@{ path = $fileRow.path; contentHash = $fileRow.contentHash; language = $language; status = 'unsupported'; reused = $false; fileIntelligenceId = ''; providerId = ''; providerVersion = ''; moduleId = $fileRow.moduleId })
            continue
        }

        $fileIntelligenceId = Get-AihCodeIntelligenceId -ContentHash $fileRow.contentHash -ProviderId $provider.providerId -ProviderVersion $provider.version
        $cached = & $store.GetFileIntelligence ([string]$fileRow.contentHash) ([string]$provider.providerId) ([string]$provider.version)
        $document = $null
        if ($null -ne $cached) {
            $stats.reused = $stats.reused + 1
            $document = $cached
            $null = Publish-AihIntEvent -StoreRoot $storeRoot -EventType 'intelligence.file.reused' -Data ([ordered]@{
                repositoryId = $RepositoryId; snapshotId = $SnapshotId; path = $fileRow.path
                fileIntelligenceId = $fileIntelligenceId; providerId = $provider.providerId; language = $language
            })
        } else {
            try {
                if ($null -eq $absolutePath -or -not (Test-Path -LiteralPath $absolutePath)) { throw 'source file is not available at the checkout root' }
                $content = [IO.File]::ReadAllText($absolutePath)
                $moduleName = ((($fileRow.path -replace '\\', '/') -replace '.*/', '') -replace '\.[^.]*$', '')
                $analysis = & $provider.analyze $content $language $fileIntelligenceId $moduleName
                $document = New-AihFileIntelligenceDocument -ContentHash $fileRow.contentHash -Language $language -ProviderId $provider.providerId -ProviderVersion $provider.version -Status $analysis.status -Symbols $analysis.symbols -Imports $analysis.imports -Exports $analysis.exports -Occurrences $analysis.occurrences -Diagnostics $analysis.diagnostics
                $stats.indexed = $stats.indexed + 1
                $null = Publish-AihIntEvent -StoreRoot $storeRoot -EventType 'intelligence.file.indexed' -Data ([ordered]@{
                    repositoryId = $RepositoryId; snapshotId = $SnapshotId; path = $fileRow.path
                    fileIntelligenceId = $fileIntelligenceId; providerId = $provider.providerId; language = $language
                    symbols = @($analysis.symbols).Count
                })
            } catch {
                $message = $_.Exception.Message
                $document = New-AihFileIntelligenceDocument -ContentHash $fileRow.contentHash -Language $language -ProviderId $provider.providerId -ProviderVersion $provider.version -Status 'failed' -Diagnostics @([ordered]@{ category = 'provider-error'; message = $message })
                $stats.failed = $stats.failed + 1
                $null = Publish-AihIntEvent -StoreRoot $storeRoot -EventType 'intelligence.file.failed' -Data ([ordered]@{
                    repositoryId = $RepositoryId; snapshotId = $SnapshotId; path = $fileRow.path
                    providerId = $provider.providerId; message = $message
                })
            }
            $null = (& $store.PutFileIntelligence $document)
        }

        $status = $document.status
        if ($status -eq 'ready') {
            $stats.symbols = $stats.symbols + @($document.symbols).Count
            $stats.imports = $stats.imports + @($document.imports).Count
            $stats.exports = $stats.exports + @($document.exports).Count
            $stats.occurrences = $stats.occurrences + @($document.occurrences).Count
        }
        $mappingRows = @($mappingRows) + @([ordered]@{ path = $fileRow.path; contentHash = $fileRow.contentHash; language = $language; status = $status; reused = ($null -ne $cached); fileIntelligenceId = $document.fileIntelligenceId; providerId = $provider.providerId; providerVersion = $provider.version; moduleId = $fileRow.moduleId })

        foreach ($symbol in @($document.symbols)) {
            $symbolRows = @($symbolRows) + @([ordered]@{
                sid = $symbol.sid; name = $symbol.name; kind = $symbol.kind; qualifiedName = $symbol.qualifiedName
                signature = $symbol.signature; container = $symbol.container; startLine = $symbol.startLine
                endLine = $symbol.endLine; exported = $symbol.exported; path = $fileRow.path
                fileIntelligenceId = $document.fileIntelligenceId; moduleId = $fileRow.moduleId
            })
        }
        foreach ($occurrence in @($document.occurrences)) {
            if ($occurrence.role -eq 'definition') { continue }   # definitions live in the symbol index
            $refRows = @($refRows) + @([ordered]@{
                oid = $occurrence.oid; role = $occurrence.role; name = $occurrence.name
                line = $occurrence.line; column = $occurrence.column; resolution = $occurrence.resolution
                resolvedTargetId = $occurrence.resolvedTargetId; path = $fileRow.path
                fileIntelligenceId = $document.fileIntelligenceId; moduleId = $fileRow.moduleId
            })
        }
    }

    $status = 'ready'
    if ($stats.failed -gt 0) { $status = 'ready_with_failures' }
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
    # Order matters: rows first, activation state last (atomic header).
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
            repositoryId = $RepositoryId; snapshotId = $SnapshotId; status = $status; failedFiles = $stats.failed
        })
    }
    return $state
}

# ── queries ─────────────────────────────────────────────────────────────────

function Get-AihSnapshotIntelligence {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId)
    $store = Get-AihCodeIntelligenceStore -StoreRoot $StoreRoot
    return (& $store.GetSnapshotState $RepositoryId $SnapshotId)
}

function Get-AihFileIntelligence {
    # Returns { mapping, fileIntelligence } for one path inside one snapshot.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Path)
    $store = Get-AihCodeIntelligenceStore -StoreRoot $StoreRoot
    $rows = @((& $store.ReadSnapshotRows $RepositoryId $SnapshotId 'mapping.jsonl') | Where-Object { $_.path -eq $Path })
    if ($rows.Count -eq 0) { return $null }
    $mapping = $rows[0]
    $document = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$mapping.fileIntelligenceId)) {
        $document = & $store.GetFileIntelligenceById ([string]$mapping.fileIntelligenceId)
    }
    return [pscustomobject][ordered]@{ mapping = $mapping; fileIntelligence = $document }
}

function Find-AihCodeSymbols {
    # Definitions are symbol records; each row IS a definition.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Name, [string]$Kind = '')
    $store = Get-AihCodeIntelligenceStore -StoreRoot $StoreRoot
    $rows = @((& $store.ReadSnapshotRows $RepositoryId $SnapshotId 'symbol-index.jsonl') | Where-Object { $_.name -eq $Name })
    if (-not [string]::IsNullOrEmpty($Kind)) { $rows = @($rows | Where-Object { $_.kind -eq $Kind }) }
    return $rows
}

function Find-AihCodeDefinitions {
    # Spec-named alias of Find-AihCodeSymbols (a symbol row is a definition).
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Name, [string]$Kind = '')
    return (Find-AihCodeSymbols -StoreRoot $StoreRoot -RepositoryId $RepositoryId -SnapshotId $SnapshotId -Name $Name -Kind $Kind)
}

function Find-AihCodeReferences {
    # Reference rows: role reference/call/import with resolution states.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Name, [string]$Role = '')
    $store = Get-AihCodeIntelligenceStore -StoreRoot $StoreRoot
    $rows = @((& $store.ReadSnapshotRows $RepositoryId $SnapshotId 'ref-index.jsonl') | Where-Object { $_.name -eq $Name })
    if (-not [string]::IsNullOrEmpty($Role)) { $rows = @($rows | Where-Object { $_.role -eq $Role }) }
    return $rows
}

function Get-AihFileCodeSymbols {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId, [Parameter(Mandatory = $true)][string]$Path)
    $store = Get-AihCodeIntelligenceStore -StoreRoot $StoreRoot
    return @((& $store.ReadSnapshotRows $RepositoryId $SnapshotId 'symbol-index.jsonl') | Where-Object { $_.path -eq $Path })
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

function Get-AihSnapshotIntelligenceDiff {
    # Deterministic diff between two indexed snapshots. Prefers
    # removed+added over invented moves; a move is reported only when the
    # stable logical symbol identity (kind|qualifiedName) exists on both
    # sides under different paths.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$FromSnapshotId, [Parameter(Mandatory = $true)][string]$ToSnapshotId)
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

    $fromSymbols = @{}
    foreach ($row in @(& $store.ReadSnapshotRows $RepositoryId $FromSnapshotId 'symbol-index.jsonl')) {
        $identity = [string]$row.kind + '|' + [string]$row.qualifiedName
        if (-not $fromSymbols.ContainsKey($identity)) { $fromSymbols[$identity] = $row }
    }
    $toSymbols = @{}
    foreach ($row in @(& $store.ReadSnapshotRows $RepositoryId $ToSnapshotId 'symbol-index.jsonl')) {
        $identity = [string]$row.kind + '|' + [string]$row.qualifiedName
        if (-not $toSymbols.ContainsKey($identity)) { $toSymbols[$identity] = $row }
    }
    $symbols = [ordered]@{ added = @(); removed = @(); moved = @(); changed = @(); unchanged = @() }
    foreach ($identity in $toSymbols.Keys) {
        if (-not $fromSymbols.ContainsKey($identity)) { $symbols.added = @($symbols.added) + @($identity); continue }
        $before = $fromSymbols[$identity]; $after = $toSymbols[$identity]
        if ([string]$before.path -ne [string]$after.path) { $symbols.moved = @($symbols.moved) + @($identity) }
        elseif ([string]$before.signature -ne [string]$after.signature) { $symbols.changed = @($symbols.changed) + @($identity) }
        else { $symbols.unchanged = @($symbols.unchanged) + @($identity) }
    }
    foreach ($identity in $fromSymbols.Keys) {
        if (-not $toSymbols.ContainsKey($identity)) { $symbols.removed = @($symbols.removed) + @($identity) }
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