Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Snapshot Engine (Phase 3.1E) ─────────────────────────────────────────────
# A snapshot is metadata, never a physical copy of the repository.
# Invariants enforced here:
#   * a snapshot is only ever activatable from status 'ready';
#   * the previous active snapshot survives any failed build untouched;
#   * activation flips (new ready + previous superseded + checkout pointer)
#     under the store lock, pointer written last and reconciled on read;
#   * state hash is deterministic: same effective state => same hash;
#   * unchanged files reuse previous content identities (hash + size + mtime).

function Get-AihIntSnapshotsPath {
    param([Parameter(Mandatory = $true)][string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return (Join-Path (& $layout.SnapshotsRepositoryDir $RepositoryId) 'snapshots.json')
}

function Read-AihIntSnapshots {
    param([Parameter(Mandatory = $true)][string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId)
    $path = Get-AihIntSnapshotsPath -StoreRoot $StoreRoot -RepositoryId $RepositoryId
    return Read-AihIntStoreJson -Path $path -Factory { [pscustomobject]@{ schemaVersion = 1; repositoryId = $null; snapshots = @() } }
}

function Save-AihIntSnapshots {
    param([Parameter(Mandatory = $true)][string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)]$Document)
    if (-not $Document.repositoryId) { $Document.repositoryId = $RepositoryId }
    Save-AihIntStoreJson -Path (Get-AihIntSnapshotsPath -StoreRoot $StoreRoot -RepositoryId $RepositoryId) -Document $Document
}

function Get-AihIntSnapshotDirectory {
    param([Parameter(Mandatory = $true)][string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [Parameter(Mandatory = $true)][string]$SnapshotId)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return (& $layout.SnapshotDir $RepositoryId $SnapshotId)
}

function Get-AihSnapshotStateHash {
    # Deterministic state identity. Incorporates (sorted, stable order):
    #   * HEAD sha (or 'no-git' / 'unborn');
    #   * dirty flag;
    #   * every change entry: kind, path, oldPath, content hash of the changed
    #     working-copy content (additions/deletions/renames included);
    #   * the whole inventory digest: path + content hash pairs.
    # Timestamps and mtimes are never part of the hash.
    param(
        [string]$HeadSha,
        [bool]$IsDirty,
        $StatusEntries,
        $Files
    )
    $headValue = if ([string]::IsNullOrEmpty($HeadSha)) { 'no-git' } else { $HeadSha }
    $lines = [System.Collections.ArrayList]::new()
    $null = $lines.Add('v1|head=' + $headValue + '|dirty=' + $IsDirty)
    $changeLines = @()
    foreach ($entry in @($StatusEntries)) {
        $hash = $entry.contentHash
        $changeLines = @($changeLines) + @(($entry.kind + '|' + $entry.path + '|' + "$(if ($entry.oldPath) { $entry.oldPath } else { '' })" + '|' + "$(if ($hash) { $hash } else { '' })"))
    }
    foreach ($line in ($changeLines | Sort-Object)) { $null = $lines.Add('change:' + $line) }
    $fileLines = @()
    foreach ($file in @($Files)) {
        $fileLines = @($fileLines) + @(($file.path + '|' + "$(if ($file.contentHash) { $file.contentHash } else { '-' })"))
    }
    foreach ($line in ($fileLines | Sort-Object)) { $null = $lines.Add('file:' + $line) }
    return 'sha256:' + (Get-AihSha256Text ($lines -join [string][char]10))
}

function Get-AihActiveSnapshot {
    # Authoritative active-snapshot reader with pointer reconciliation:
    # a dangling or not-ready pointer never surfaces a half-built snapshot.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$CheckoutId)
    $checkout = Get-AihCheckout -StoreRoot $StoreRoot -CheckoutId $CheckoutId
    $repositoryId = $checkout.repositoryId
    $document = Read-AihIntSnapshots -StoreRoot $StoreRoot -RepositoryId $repositoryId
    $activeId = $checkout.activeSnapshotId
    if (-not [string]::IsNullOrEmpty($activeId)) {
        $match = @($document.snapshots | Where-Object { $_.snapshotId -eq $activeId } | Select-Object -First 1)
        if (@($match).Count -gt 0 -and $match[0].status -eq 'ready') { return $match[0] }
    }
    # reconcile: newest ready snapshot for this checkout
    $candidates = @($document.snapshots | Where-Object { $_.checkoutId -eq $CheckoutId -and $_.status -eq 'ready' } | Sort-Object -Property activatedAt -Descending)
    $repaired = @($candidates).Count -gt 0
    if ($repaired) {
        $null = Use-AihIntelligenceLock -StoreRoot (Get-AihIntelligenceStoreRoot $StoreRoot) -Script {
            $freshCheckouts = Get-AihIntCheckoutDocument -StoreRoot $StoreRoot
            foreach ($existing in @($freshCheckouts.checkouts)) {
                if ($existing.checkoutId -eq $CheckoutId) { $existing.activeSnapshotId = $candidates[0].snapshotId }
            }
            Save-AihIntCheckoutDocument -StoreRoot $StoreRoot -Document $freshCheckouts
        }
        return $candidates[0]
    }
    if (-not [string]::IsNullOrEmpty($activeId)) {
        # pointer is definitively invalid and nothing is ready; clear it
        $null = Use-AihIntelligenceLock -StoreRoot (Get-AihIntelligenceStoreRoot $StoreRoot) -Script {
            $freshCheckouts = Get-AihIntCheckoutDocument -StoreRoot $StoreRoot
            foreach ($existing in @($freshCheckouts.checkouts)) {
                if ($existing.checkoutId -eq $CheckoutId) { $existing.activeSnapshotId = $null }
            }
            Save-AihIntCheckoutDocument -StoreRoot $StoreRoot -Document $freshCheckouts
        }
    }
    return $null
}

function Repair-AihSnapshotStates {
    # Crash reconciliation: interrupted 'building' snapshots become 'failed'
    # (never active), and checkout pointers are verified against ready state.
    param([string]$StoreRoot)
    $store = Get-AihIntelligenceStoreRoot $StoreRoot
    $report = [ordered]@{ failedAborted = 0; pointersRepaired = 0; repositories = 0 }
    $repositoryDocument = Get-AihIntRepositoryDocument -StoreRoot $store
    return Use-AihIntelligenceLock -StoreRoot $store -Script {
        foreach ($repository in @($repositoryDocument.repositories)) {
            $report.repositories = $report.repositories + 1
            $document = Read-AihIntSnapshots -StoreRoot $store -RepositoryId $repository.repositoryId
            $changed = $false
            foreach ($snapshot in @($document.snapshots)) {
                if ($snapshot.status -eq 'building') {
                    $snapshot.status = 'failed'
                    if ($snapshot.PSObject.Properties['failureReason']) { $snapshot.failureReason = 'build_aborted' }
                    else { $null = Add-Member -InputObject $snapshot -NotePropertyName failureReason -NotePropertyValue 'build_aborted' }
                    $changed = $true
                    $report.failedAborted = $report.failedAborted + 1
                }
            }
            if ($changed) { Save-AihIntSnapshots -StoreRoot $store -RepositoryId $repository.repositoryId -Document $document }
        }
        $checkoutDocument = Get-AihIntCheckoutDocument -StoreRoot $store
        foreach ($checkout in @($checkoutDocument.checkouts)) {
            if ([string]::IsNullOrEmpty($checkout.activeSnapshotId)) { continue }
            $snapshotDocument = Read-AihIntSnapshots -StoreRoot $store -RepositoryId $checkout.repositoryId
            $match = @($snapshotDocument.snapshots | Where-Object { $_.snapshotId -eq $checkout.activeSnapshotId } | Select-Object -First 1)
            if (@($match).Count -eq 0 -or $match[0].status -ne 'ready') {
                $replacement = @($snapshotDocument.snapshots | Where-Object { $_.checkoutId -eq $checkout.checkoutId -and $_.status -eq 'ready' } | Sort-Object -Property activatedAt -Descending | Select-Object -First 1)
                $checkout.activeSnapshotId = if (@($replacement).Count -gt 0) { $replacement[0].snapshotId } else { $null }
                $report.pointersRepaired = $report.pointersRepaired + 1
                Save-AihIntCheckoutDocument -StoreRoot $store -Document $checkoutDocument
            }
        }
        return [pscustomobject]$report
    }
}

function Invoke-AihSnapshotBuild {
    # Full build flow: inspect state -> scan inventory -> discover modules ->
    # compute hashes -> build snapshot -> validate -> atomically activate.
    param(
        [string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$CheckoutId,
        [scriptblock]$Validator,
        $Detectors
    )
    $store = Get-AihIntelligenceStoreRoot $StoreRoot
    $checkout = Get-AihCheckout -StoreRoot $store -CheckoutId $CheckoutId
    $repository = Get-AihRepository -StoreRoot $store -RepositoryId $checkout.repositoryId
    $previousActive = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $CheckoutId
    $null = Repair-AihSnapshotStates -StoreRoot $store

    $now = [DateTime]::UtcNow.ToString('o')
    $snapshot = [pscustomobject][ordered]@{
        schemaVersion = 1
        snapshotId    = (New-AihIntelligenceId 'snap')
        repositoryId  = $repository.repositoryId
        checkoutId    = $checkout.checkoutId
        number        = 0
        branch        = $null
        commitSha     = $null
        stateHash     = $null
        isDirty       = $false
        status        = 'building'
        createdAt     = $now
        activatedAt   = $null
        failureReason = $null
        stats         = $null
    }

    $document = Read-AihIntSnapshots -StoreRoot $store -RepositoryId $repository.repositoryId
    $maxNumber = 0
    foreach ($existing in @($document.snapshots)) { if ([int]$existing.number -gt $maxNumber) { $maxNumber = [int]$existing.number } }
    $snapshot.number = $maxNumber + 1
    $document.snapshots = @($document.snapshots) + @($snapshot)
    Save-AihIntSnapshots -StoreRoot $store -RepositoryId $repository.repositoryId -Document $document

    $null = Publish-AihIntEvent -StoreRoot $store -EventType 'snapshot.build.started' -Data ([ordered]@{
        snapshotId = $snapshot.snapshotId; repositoryId = $repository.repositoryId; checkoutId = $checkout.checkoutId
    })

    try {
        # ── inspect Git/filesystem state ────────────────────────────────────
        $git = Get-AihGitProvider
        $headSha = $null
        $branch = $null
        $isDirty = $false
        $statusEntries = @()
        $trackedFiles = @()
        if ($repository.vcs -eq 'git') {
            $headSha = & $git.GetHeadSha $checkout.rootPath
            $branch = & $git.GetBranch $checkout.rootPath
            $statusEntries = @(& $git.GetWorkingTreeStatus $checkout.rootPath)
            $trackedFiles = @(& $git.GetTrackedFiles $checkout.rootPath)
            $isDirty = (@($statusEntries).Count -gt 0)
        }

        # ── scan inventory (with reuse from the previous active snapshot) ──
        $config = Resolve-AihRepositoryConfig -CheckoutRoot $checkout.rootPath
        $previousFiles = $null
        if ($null -ne $previousActive) {
            $previousFiles = @{}
            $previousRows = Get-AihSnapshotFiles -StoreRoot $store -SnapshotId $previousActive.snapshotId
            foreach ($row in @($previousRows)) { $previousFiles["$($row.path)"] = $row }
        }
        $scan = Invoke-AihInventoryScan -CheckoutRoot $checkout.rootPath -Config $config -TrackedFiles $trackedFiles -PreviousFiles $previousFiles

        # resolve content hashes for change entries (deleted files have none)
        $fileHashIndex = @{}
        foreach ($fileEntry in @($scan.files)) { if ($fileEntry.contentHash) { $fileHashIndex[$fileEntry.path] = $fileEntry.contentHash } }
        $resolvedChanges = @()
        foreach ($entry in $statusEntries) {
            $hash = $null
            if ($entry.kind -ne 'deleted') {
                if ($fileHashIndex.ContainsKey($entry.path)) { $hash = $fileHashIndex[$entry.path] }
                else {
                    $entryFull = Join-Path $checkout.rootPath ($entry.path.Replace('/', '\'))
                    if (Test-Path -LiteralPath $entryFull) {
                        $entryItem = Get-Item -LiteralPath $entryFull -Force
                        if (-not $entryItem.PSIsContainer -and [long]$entryItem.Length -le $config.maxFileBytes) {
                            $hash = Get-AihContentHash -FullPath $entryFull -Size ([long]$entryItem.Length) -MaxFileBytes $config.maxFileBytes -SampleBytes $config.sampleBytes
                        }
                    }
                }
            }
            $resolvedChanges = @($resolvedChanges) + @([pscustomobject]@{ kind = $entry.kind; path = $entry.path; oldPath = $entry.oldPath; contentHash = $hash })
        }

        # ── discover modules ───────────────────────────────────────────────
        $moduleCandidates = @()
        if ($config.modulesAutoDetect) {
            $discovery = Invoke-AihModuleDiscovery -CheckoutRoot $checkout.rootPath -Inventory $scan -RepositoryName $repository.name -Detectors $Detectors
            $moduleCandidates = @($discovery.modules)
        }
        $moduleRows = @()
        $nowModules = [DateTime]::UtcNow.ToString('o')
        foreach ($candidate in $moduleCandidates) {
            # moduleId is the stable LOGICAL identity (repository + path);
            # metadataHash is the deterministic version of the manifest-derived
            # metadata at snapshot time, so a changed manifest yields the same
            # moduleId with a different metadata version.
            $metadataFingerprint = ($candidate.metadata | ConvertTo-Json -Depth 6 -Compress)
            $moduleRow = [pscustomobject][ordered]@{
                schemaVersion = 1
                moduleId      = (New-AihDeterministicId 'module' ($repository.repositoryId + '|' + $candidate.path))
                repositoryId  = $repository.repositoryId
                path          = $candidate.path
                name          = $candidate.name
                type          = $candidate.type
                manifestPath  = $candidate.manifestPath
                metadata      = $candidate.metadata
                metadataHash  = ('sha256:' + (Get-AihSha256Text -Text $metadataFingerprint))
                createdAt     = $nowModules
                updatedAt     = $nowModules
            }
            $moduleRows = @($moduleRows) + @($moduleRow)
        }

        # ── file → module ownership for this snapshot ───────────────────────
        # Longest-prefix match over module paths; the generic root module ('')
        # owns everything not claimed by a nested module.
        $moduleOwnership = @{}
        $ownedModules = @($moduleRows | Sort-Object -Property { "$($_.path)".Length } -Descending)
        foreach ($fileEntry in @($scan.files)) {
            $ownerId = $null
            foreach ($candidate in $ownedModules) {
                $modulePath = "$($candidate.path)"
                if ($modulePath -eq '') { $ownerId = $candidate.moduleId; break }
                if ($fileEntry.path -eq $modulePath -or $fileEntry.path.StartsWith($modulePath + '/')) { $ownerId = $candidate.moduleId; break }
            }
            if ($null -ne $ownerId) { $moduleOwnership[$fileEntry.path] = $ownerId }
        }

        # ── content-addressed file objects ──────────────────────────────────
        $fileObjectState = Get-AihIntFileObjectIndex -StoreRoot $store
        foreach ($fileEntry in @($scan.files)) {
            if (-not [string]::IsNullOrEmpty($fileEntry.contentHash)) {
                $null = Add-AihIntFileObject -IndexState $fileObjectState -Hash $fileEntry.contentHash -Size ([long]$fileEntry.size)
            }
        }
        foreach ($change in $resolvedChanges) {
            if (-not [string]::IsNullOrEmpty($change.contentHash)) {
                $null = Add-AihIntFileObject -IndexState $fileObjectState -Hash $change.contentHash -Size 0
            }
        }
        & $fileObjectState.Persist $fileObjectState

        # ── state hash ──────────────────────────────────────────────────────
        $stateHash = Get-AihSnapshotStateHash -HeadSha $headSha -IsDirty $isDirty -StatusEntries $resolvedChanges -Files $scan.files

        # ── build snapshot files (metadata only) ────────────────────────────
        $snapshotDir = Get-AihIntSnapshotDirectory -StoreRoot $store -RepositoryId $repository.repositoryId -SnapshotId $snapshot.snapshotId
        New-Item -ItemType Directory -Force -Path $snapshotDir | Out-Null
        $fileRows = @()
        foreach ($fileEntry in @($scan.files)) {
            $ownerKey = "$($fileEntry.path)"
            $fileRows = @($fileRows) + @([pscustomobject][ordered]@{
                snapshotId    = $snapshot.snapshotId
                path          = $fileEntry.path
                contentHash   = $fileEntry.contentHash
                classification = $fileEntry.classification
                size          = [long]$fileEntry.size
                mtimeMs       = [long]$fileEntry.mtimeMs
                sensitivity   = $fileEntry.sensitivity
                indexability  = $fileEntry.indexability
                isBinary      = [bool]$fileEntry.isBinary
                isSymlink     = [bool]$fileEntry.isSymlink
                isTracked     = [bool]$fileEntry.isTracked
                moduleId      = $(if ($moduleOwnership.ContainsKey($ownerKey)) { $moduleOwnership[$ownerKey] } else { $null })
            })
        }
        $filesDocument = [pscustomobject]@{ schemaVersion = 1; snapshotId = $snapshot.snapshotId; files = $fileRows }
        Save-AihIntStoreJson -Path (Join-Path $snapshotDir 'files.json') -Document $filesDocument
        $modulesDocument = [pscustomobject]@{ schemaVersion = 1; snapshotId = $snapshot.snapshotId; modules = $moduleRows }
        Save-AihIntStoreJson -Path (Join-Path $snapshotDir 'modules.json') -Document $modulesDocument
        $configDocument = [pscustomobject][ordered]@{
            schemaVersion = 1; snapshotId = $snapshot.snapshotId
            respectGitignore = $config.respectGitignore; exclude = @($config.exclude)
            maxFileBytes = $config.maxFileBytes; modulesAutoDetect = $config.modulesAutoDetect
            securityExternalContext = $config.securityExternalContext
            configErrors = @($config.configErrors)
        }
        Save-AihIntStoreJson -Path (Join-Path $snapshotDir 'config.json') -Document $configDocument

        # persist latest module set + repository config (not active state)
        $modulesDir = (& (Get-AihIntelligenceLayout $store).ModulesRepositoryDir $repository.repositoryId)
        New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
        Save-AihIntStoreJson -Path (Join-Path $modulesDir 'modules.json') -Document ([pscustomobject]@{ schemaVersion = 1; repositoryId = $repository.repositoryId; modules = $moduleRows })
        $null = Use-AihIntelligenceLock -StoreRoot $store -Script {
            $repositoryDocument = Get-AihIntRepositoryDocument -StoreRoot $store
            Set-AihIntRepositoryConfig -Document $repositoryDocument -RepositoryId $repository.repositoryId -Config ([pscustomobject][ordered]@{
                repositoryId = $repository.repositoryId
                configFile = $config.configFile
                respectGitignore = $config.respectGitignore
                exclude = @($config.exclude)
                maxFileBytes = $config.maxFileBytes
                modulesAutoDetect = $config.modulesAutoDetect
                securityExternalContext = $config.securityExternalContext
                configErrors = @($config.configErrors)
                updatedAt = [DateTime]::UtcNow.ToString('o')
            })
            Save-AihIntRepositoryDocument -StoreRoot $store -Document $repositoryDocument
        }

        # ── validate ────────────────────────────────────────────────────────
        $validationContext = [pscustomobject][ordered]@{
            snapshot = $snapshot
            stateHash = $stateHash
            fileCount = @($fileRows).Count
            moduleCount = @($moduleRows).Count
            changedFiles = @($resolvedChanges).Count
            configErrors = @($config.configErrors)
        }
        $written = Get-AihSnapshotFiles -StoreRoot $store -SnapshotId $snapshot.snapshotId -RepositoryId $repository.repositoryId
        if (@($written).Count -ne @($fileRows).Count) { throw 'Snapshot validation failed: files.json does not match the built inventory.' }
        foreach ($row in @($written)) { if ([string]::IsNullOrEmpty("$($row.path)")) { throw 'Snapshot validation failed: empty file path in snapshot.' } }
        if ([string]::IsNullOrEmpty($stateHash)) { throw 'Snapshot validation failed: state hash is empty.' }
        if ($null -ne $Validator) { & $Validator $validationContext }

        # ── atomically activate ─────────────────────────────────────────────
        $previousActiveId = if ($null -ne $previousActive) { $previousActive.snapshotId } else { $null }
        $stateChanged = $true
        $previousStateHash = $null
        if ($null -ne $previousActive) {
            $previousStateHash = $previousActive.stateHash
            $stateChanged = "$($previousActive.stateHash)" -ne $stateHash
        }
        $activated = Use-AihIntelligenceLock -StoreRoot $store -Script {
            $freshDocument = Read-AihIntSnapshots -StoreRoot $store -RepositoryId $repository.repositoryId
            $activatedSnapshot = $null
            foreach ($existing in @($freshDocument.snapshots)) {
                if ($existing.snapshotId -eq $snapshot.snapshotId) {
                    $existing.status = 'ready'
                    $existing.activatedAt = [DateTime]::UtcNow.ToString('o')
                    $existing.branch = $branch
                    $existing.commitSha = $headSha
                    $existing.isDirty = $isDirty
                    $existing.stateHash = $stateHash
                    $existing.stats = [pscustomobject][ordered]@{
                        discoveredFiles = [int]$scan.stats.discoveredFiles
                        ignoredFiles = [int]$scan.stats.ignoredFiles
                        reusedHashes = [int]$scan.stats.reusedHashes
                        changedFiles = @($resolvedChanges).Count
                        modules = @($moduleRows).Count
                    }
                    $activatedSnapshot = $existing
                }
                elseif ($existing.checkoutId -eq $checkout.checkoutId -and $existing.status -eq 'ready' -and $existing.snapshotId -ne $snapshot.snapshotId) {
                    $existing.status = 'superseded'
                }
            }
            if ($null -eq $activatedSnapshot) { throw 'Snapshot record vanished during activation.' }
            Save-AihIntSnapshots -StoreRoot $store -RepositoryId $repository.repositoryId -Document $freshDocument
            $freshCheckouts = Get-AihIntCheckoutDocument -StoreRoot $store
            foreach ($existingCheckout in @($freshCheckouts.checkouts)) {
                if ($existingCheckout.checkoutId -eq $checkout.checkoutId) { $existingCheckout.activeSnapshotId = $snapshot.snapshotId }
            }
            Save-AihIntCheckoutDocument -StoreRoot $store -Document $freshCheckouts
            return $activatedSnapshot
        }

        $null = Publish-AihIntEvent -StoreRoot $store -EventType 'snapshot.build.completed' -Data ([ordered]@{
            snapshotId = $snapshot.snapshotId; repositoryId = $repository.repositoryId; checkoutId = $checkout.checkoutId
            stateHash = $stateHash; files = @($fileRows).Count; modules = @($moduleRows).Count
        })
        $null = Publish-AihIntEvent -StoreRoot $store -EventType 'snapshot.activated' -Data ([ordered]@{
            snapshotId = $snapshot.snapshotId; repositoryId = $repository.repositoryId; checkoutId = $checkout.checkoutId
            previousSnapshotId = $previousActiveId; superseded = ($(if ($null -ne $previousActiveId) { $true } else { $false }))
        })
        $null = Publish-AihIntEvent -StoreRoot $store -EventType 'repository.state.changed' -Data ([ordered]@{
            repositoryId = $repository.repositoryId; checkoutId = $checkout.checkoutId
            changed = $stateChanged
            previousStateHash = $previousStateHash
            newStateHash = $stateHash
        })
        foreach ($moduleRow in $moduleRows) {
            $null = Publish-AihIntEvent -StoreRoot $store -EventType 'module.discovered' -Data ([ordered]@{
                moduleId = $moduleRow.moduleId; repositoryId = $repository.repositoryId; snapshotId = $snapshot.snapshotId
                path = $moduleRow.path; type = $moduleRow.type; manifestPath = $moduleRow.manifestPath
            })
        }

        return [pscustomobject][ordered]@{
            snapshot = $activated
            filesTotal = @($fileRows).Count
            filesReused = [int]$scan.stats.reusedHashes
            filesIgnored = [int]$scan.stats.ignoredFiles
            changedFiles = @($resolvedChanges).Count
            modules = @($moduleRows).Count
            stateChanged = $stateChanged
            previousSnapshotId = $previousActiveId
            skipped = @($scan.skipped)
            configErrors = @($config.configErrors)
        }
    } catch {
        $reason = $_.Exception.Message
        $null = Use-AihIntelligenceLock -StoreRoot $store -Script {
            $freshDocument = Read-AihIntSnapshots -StoreRoot $store -RepositoryId $repository.repositoryId
            foreach ($existing in @($freshDocument.snapshots)) {
                if ($existing.snapshotId -eq $snapshot.snapshotId -and $existing.status -eq 'building') {
                    $existing.status = 'failed'
                    $existing.failureReason = $reason
                }
            }
            Save-AihIntSnapshots -StoreRoot $store -RepositoryId $repository.repositoryId -Document $freshDocument
        }
        $null = Publish-AihIntEvent -StoreRoot $store -EventType 'snapshot.failed' -Data ([ordered]@{
            snapshotId = $snapshot.snapshotId; repositoryId = $repository.repositoryId; checkoutId = $checkout.checkoutId
            reason = $reason
        })
        throw
    }
}

function Get-AihSnapshotList {
    param([string]$StoreRoot, [string]$RepositoryId, [string]$CheckoutId, [string]$Status)
    $store = Get-AihIntelligenceStoreRoot $StoreRoot
    $results = @()
    $repositoryIds = @()
    if (-not [string]::IsNullOrEmpty($RepositoryId)) {
        $repositoryIds = @($RepositoryId)
    } else {
        $repositoryDocument = Get-AihIntRepositoryDocument -StoreRoot $store
        $repositoryIds = @($repositoryDocument.repositories | ForEach-Object { $_.repositoryId })
    }
    foreach ($repoId in $repositoryIds) {
        $document = Read-AihIntSnapshots -StoreRoot $store -RepositoryId $repoId
        foreach ($snapshot in @($document.snapshots)) {
            if (-not [string]::IsNullOrEmpty($CheckoutId) -and "$($snapshot.checkoutId)" -ne $CheckoutId) { continue }
            if (-not [string]::IsNullOrEmpty($Status) -and "$($snapshot.status)" -ne $Status) { continue }
            $results = @($results) + @($snapshot)
        }
    }
    $results = @($results | Sort-Object -Property @{ Expression = { $_.createdAt } }, @{ Expression = { $_.snapshotId } } -Descending)
    return $results
}

function Get-AihSnapshot {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$SnapshotId, [string]$RepositoryId)
    if (-not [string]::IsNullOrEmpty($RepositoryId)) {
        $document = Read-AihIntSnapshots -StoreRoot $StoreRoot -RepositoryId $RepositoryId
        $match = @($document.snapshots | Where-Object { $_.snapshotId -eq $SnapshotId } | Select-Object -First 1)
        if (@($match).Count -gt 0) { return $match[0] }
        throw "Snapshot was not found: $SnapshotId"
    }
    $repositoryDocument = Get-AihIntRepositoryDocument -StoreRoot (Get-AihIntelligenceStoreRoot $StoreRoot)
    foreach ($repository in @($repositoryDocument.repositories)) {
        try {
            return (Get-AihSnapshot -StoreRoot $StoreRoot -SnapshotId $SnapshotId -RepositoryId $repository.repositoryId)
        } catch { continue }
    }
    throw "Snapshot was not found: $SnapshotId"
}

function Get-AihSnapshotFiles {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$SnapshotId, [string]$RepositoryId)
    $store = Get-AihIntelligenceStoreRoot $StoreRoot
    if ([string]::IsNullOrEmpty($RepositoryId)) {
        $snapshot = Get-AihSnapshot -StoreRoot $store -SnapshotId $SnapshotId
        $RepositoryId = $snapshot.repositoryId
    }
    $snapshotDir = Get-AihIntSnapshotDirectory -StoreRoot $store -RepositoryId $RepositoryId -SnapshotId $SnapshotId
    $path = Join-Path $snapshotDir 'files.json'
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    $document = Read-AihIntStoreJson -Path $path -Factory { [pscustomobject]@{ schemaVersion = 1; snapshotId = $SnapshotId; files = @() } }
    return @($document.files)
}

function Get-AihSnapshotModules {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$SnapshotId, [string]$RepositoryId)
    $store = Get-AihIntelligenceStoreRoot $StoreRoot
    if ([string]::IsNullOrEmpty($RepositoryId)) {
        $snapshot = Get-AihSnapshot -StoreRoot $store -SnapshotId $SnapshotId
        $RepositoryId = $snapshot.repositoryId
    }
    $snapshotDir = Get-AihIntSnapshotDirectory -StoreRoot $store -RepositoryId $RepositoryId -SnapshotId $SnapshotId
    $path = Join-Path $snapshotDir 'modules.json'
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    $document = Read-AihIntStoreJson -Path $path -Factory { [pscustomobject]@{ schemaVersion = 1; snapshotId = $SnapshotId; modules = @() } }
    return @($document.modules)
}

function Get-AihModuleList {
    # Current module set for a repository (latest discovered state).
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId)
    $store = Get-AihIntelligenceStoreRoot $StoreRoot
    $modulesDir = (& (Get-AihIntelligenceLayout $store).ModulesRepositoryDir $RepositoryId)
    $path = Join-Path $modulesDir 'modules.json'
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    $document = Read-AihIntStoreJson -Path $path -Factory { [pscustomobject]@{ schemaVersion = 1; repositoryId = $RepositoryId; modules = @() } }
    return @($document.modules)
}
