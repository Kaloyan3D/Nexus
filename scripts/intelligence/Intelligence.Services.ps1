Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Application services & public API (Phase 3.1F) ──────────────────────────
# Higher-level Nexus systems call these functions (or Invoke-AihIntelligenceCommand)
# and never touch the storage layer or Git directly. Events are the decoupling
# seam: e.g. Phase 3.2 can subscribe to 'snapshot.activated' to start indexing.

function Resolve-AihRepositoryReference {
    # Resolves a repository by exact id first, then by unique name.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$Repository)
    try { return (Get-AihRepository -StoreRoot $StoreRoot -RepositoryId $Repository) } catch { }
    $byName = @(Find-AihRepositoryByName -StoreRoot $StoreRoot -Name $Repository)
    if (@($byName).Count -eq 1) { return $byName[0] }
    if (@($byName).Count -gt 1) {
        $ids = (@($byName | ForEach-Object { $_.repositoryId }) -join ', ')
        throw "Repository name is ambiguous: $Repository (ids: $ids)"
    }
    throw "Repository was not found: $Repository"
}

function Get-AihRepositoryStatus {
    # Current repository truth from the filesystem, Git, and stored snapshots.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$Repository)
    $store = Get-AihIntelligenceStoreRoot $StoreRoot
    $repositoryRecord = Resolve-AihRepositoryReference -StoreRoot $store -Repository $Repository
    $git = Get-AihGitProvider
    $checkoutRows = @()
    foreach ($checkout in (Get-AihCheckoutList -StoreRoot $store -RepositoryId $repositoryRecord.repositoryId)) {
        $gitState = $null
        if ($repositoryRecord.vcs -eq 'git') {
            $changes = [ordered]@{ staged = 0; modified = 0; deleted = 0; renamed = 0; untracked = 0; unmerged = 0 }
            $entries = @()
            try { $entries = @(& $git.GetWorkingTreeStatus $checkout.rootPath) } catch { $entries = @() }
            foreach ($entry in $entries) {
                if ($changes.Contains($entry.kind)) { $changes[$entry.kind] = [int]$changes[$entry.kind] + 1 }
            }
            $gitState = [pscustomobject][ordered]@{
                present  = $true
                branch   = (& $git.GetBranch $checkout.rootPath)
                headSha  = (& $git.GetHeadSha $checkout.rootPath)
                detached = (& $git.IsDetachedHead $checkout.rootPath)
                isDirty  = (@($entries).Count -gt 0)
                changes  = [pscustomobject]$changes
                totalChanged = @($entries).Count
            }
        }
        $active = $null
        try { $active = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $checkout.checkoutId } catch { $active = $null }
        $snapshotState = $null
        $fileCount = $null
        $moduleCount = $null
        if ($null -ne $active) {
            $snapshotState = [pscustomobject][ordered]@{
                snapshotId  = $active.snapshotId
                status      = $active.status
                number      = [int]$active.number
                stateHash   = $active.stateHash
                branch      = $active.branch
                commitSha   = $active.commitSha
                isDirty     = [bool]$active.isDirty
                createdAt   = $active.createdAt
                activatedAt = $active.activatedAt
            }
            $fileCount = @(Get-AihSnapshotFiles -StoreRoot $store -SnapshotId $active.snapshotId -RepositoryId $repositoryRecord.repositoryId).Count
            $moduleCount = @(Get-AihSnapshotModules -StoreRoot $store -SnapshotId $active.snapshotId -RepositoryId $repositoryRecord.repositoryId).Count
        }
        $checkoutRows = @($checkoutRows) + @([pscustomobject][ordered]@{
            checkoutId       = $checkout.checkoutId
            rootPath         = $checkout.rootPath
            kind             = $checkout.kind
            machineId        = $checkout.machineId
            lastSeenAt       = $checkout.lastSeenAt
            activeSnapshotId = $checkout.activeSnapshotId
            git              = $gitState
            files            = $(if ($null -ne $fileCount) { [pscustomobject]@{ discovered = $fileCount } } else { $null })
            modules          = $(if ($null -ne $moduleCount) { [pscustomobject]@{ count = $moduleCount } } else { $null })
            snapshot         = $snapshotState
        })
    }
    return [pscustomobject][ordered]@{
        repository = [pscustomobject][ordered]@{
            repositoryId    = $repositoryRecord.repositoryId
            name            = $repositoryRecord.name
            vcs             = $repositoryRecord.vcs
            canonicalRemote = $repositoryRecord.canonicalRemote
            defaultBranch   = $repositoryRecord.defaultBranch
            createdAt       = $repositoryRecord.createdAt
            updatedAt       = $repositoryRecord.updatedAt
        }
        checkouts = $checkoutRows
    }
}

function Format-AihRepositoryStatusText {
    param([Parameter(Mandatory = $true)]$Status)
    $lines = [System.Collections.ArrayList]::new()
    $null = $lines.Add('Repository:')
    $null = $lines.Add('  ' + $Status.repository.name + ' (' + $Status.repository.repositoryId + ')')
    $null = $lines.Add('  VCS: ' + $Status.repository.vcs + $(if ($Status.repository.canonicalRemote) { '  Remote: ' + $Status.repository.canonicalRemote } else { '' }))
    foreach ($checkout in @($Status.checkouts)) {
        $null = $lines.Add('Checkout:')
        $null = $lines.Add('  ' + $checkout.rootPath + ' [' + $checkout.kind + ']')
        if ($null -ne $checkout.git) {
            $null = $lines.Add('Git:')
            $null = $lines.Add('  Branch: ' + $(if ($checkout.git.branch) { $checkout.git.branch } else { '(detached)' }))
            $null = $lines.Add('  HEAD: ' + $(if ($checkout.git.headSha) { $checkout.git.headSha.Substring(0, [Math]::Min(7, $checkout.git.headSha.Length)) } else { '(none)' }))
            $null = $lines.Add('  Dirty: ' + $(if ($checkout.git.isDirty) { 'yes' } else { 'no' }))
            $c = $checkout.git.changes
            $null = $lines.Add('  Changes: modified ' + $c.modified + ', staged ' + $c.staged + ', untracked ' + $c.untracked + ', deleted ' + $c.deleted + ', renamed ' + $c.renamed)
        }
        if ($null -ne $checkout.modules) { $null = $lines.Add('Modules: ' + $checkout.modules.count) }
        if ($null -ne $checkout.files) { $null = $lines.Add('Files: ' + $checkout.files.discovered + ' discovered') }
        if ($null -ne $checkout.snapshot) {
            $null = $lines.Add('Snapshot:')
            $null = $lines.Add('  ' + $checkout.snapshot.snapshotId + ' [' + $checkout.snapshot.status.ToUpperInvariant() + '] number ' + $checkout.snapshot.number)
        }
    }
    return ($lines -join [string][char]10)
}

function Invoke-AihIntelligenceCommand {
    # CLI-equivalent internal command surface:
    #   workspace-create <name>          repo-add <path> [workspaceName]
    #   workspace-list                   repo-list
    #   repo-status <repo>               repo-scan <repo>
    #   snapshot-list <repo>             module-list <repo>
    param(
        [string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$Command,
        [string[]]$Arguments = @()
    )
    $store = Get-AihIntelligenceStoreRoot $StoreRoot
    switch ($Command.ToLowerInvariant()) {
        'workspace-create' {
            if (@($Arguments).Count -lt 1) { throw 'workspace-create requires a name.' }
            return (New-AihWorkspace -StoreRoot $store -Name $Arguments[0])
        }
        'workspace-list' {
            return (Get-AihWorkspaceList -StoreRoot $store)
        }
        'repo-add' {
            if (@($Arguments).Count -lt 1) { throw 'repo-add requires a path.' }
            $path = $Arguments[0]
            $workspaceName = if (@($Arguments).Count -ge 2) { $Arguments[1] } else { $null }
            $registered = $null
            if ($workspaceName) {
                $registered = Register-AihRepository -StoreRoot $store -Path $path -Workspace $workspaceName
            } else {
                $registered = Register-AihRepository -StoreRoot $store -Path $path
            }
            return (Get-AihRepositoryStatus -StoreRoot $store -Repository $registered.repository.repositoryId)
        }
        'repo-list' {
            $rows = @()
            foreach ($repository in (Get-AihRepositoryList -StoreRoot $store)) {
                $checkouts = @(Get-AihCheckoutList -StoreRoot $store -RepositoryId $repository.repositoryId)
                $rows = @($rows) + @([pscustomobject][ordered]@{
                    repositoryId = $repository.repositoryId
                    name = $repository.name
                    vcs = $repository.vcs
                    canonicalRemote = $repository.canonicalRemote
                    checkouts = $checkouts.Count
                    checkoutRoots = @($checkouts | ForEach-Object { $_.rootPath })
                })
            }
            return $rows
        }
        'repo-status' {
            if (@($Arguments).Count -lt 1) { throw 'repo-status requires a repository id or name.' }
            return (Get-AihRepositoryStatus -StoreRoot $store -Repository $Arguments[0])
        }
        'repo-scan' {
            if (@($Arguments).Count -lt 1) { throw 'repo-scan requires a repository id or name.' }
            $repository = Resolve-AihRepositoryReference -StoreRoot $store -Repository $Arguments[0]
            $results = @()
            foreach ($checkout in (Get-AihCheckoutList -StoreRoot $store -RepositoryId $repository.repositoryId)) {
                $results = @($results) + @(Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkout.checkoutId)
            }
            return $results
        }
        'snapshot-list' {
            if (@($Arguments).Count -lt 1) { throw 'snapshot-list requires a repository id or name.' }
            $repository = Resolve-AihRepositoryReference -StoreRoot $store -Repository $Arguments[0]
            return (Get-AihSnapshotList -StoreRoot $store -RepositoryId $repository.repositoryId)
        }
        'module-list' {
            if (@($Arguments).Count -lt 1) { throw 'module-list requires a repository id or name.' }
            $repository = Resolve-AihRepositoryReference -StoreRoot $store -Repository $Arguments[0]
            return (Get-AihModuleList -StoreRoot $store -RepositoryId $repository.repositoryId)
        }
        default {
            throw "Unknown intelligence command: $Command"
        }
    }
}
