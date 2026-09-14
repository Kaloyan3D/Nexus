Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Identity & Registry (Phase 3.1A) ─────────────────────────────────────────
# Domain rules implemented here:
#   * a logical repository is NEVER identified by a filesystem path;
#   * repository metadata reflects actual filesystem/Git state, never guesses;
#   * when identity is ambiguous, a separate repository is created instead of
#     an incorrect merge (explicit linking stays possible);
#   * all checkout roots are canonicalized; all file identity is
#     repository-relative POSIX paths (never absolute paths).

function Get-AihMachineIdentity {
    # MachineIdentityService: creates the persistent machine identity once and
    # loads it afterwards. The id is random and never derived from hardware.
    # lastSeenAt is refreshed on every load.
    param([string]$StoreRoot)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return Use-AihIntelligenceLock -StoreRoot $layout.Root -Script {
        $existing = $null
        if (Test-Path -LiteralPath $layout.Machine) {
            try { $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $layout.Machine | ConvertFrom-Json } catch { $existing = $null }
        }
        if ($null -ne $existing -and ($existing.PSObject.Properties['machineId'])) {
            $existing.lastSeenAt = [DateTime]::UtcNow.ToString('o')
            Write-AihAtomicJson -Path $layout.Machine -Value $existing
            return $existing
        }
        $hostname = $env:COMPUTERNAME
        if ([string]::IsNullOrWhiteSpace($hostname)) { $hostname = [System.Net.Dns]::GetHostName() }
        $platform = 'unknown'
        if (Test-AihWindowsPlatform) { $platform = 'windows' }
        else {
            try {
                $runtime = [System.Runtime.InteropServices.RuntimeInformation]
                if ($runtime::IsOSPlatform($runtime::Linux)) { $platform = 'linux' }
                elseif ($runtime::IsOSPlatform($runtime::OSX)) { $platform = 'macos' }
            } catch { $platform = 'unknown' }
        }
        $now = [DateTime]::UtcNow.ToString('o')
        $machine = [pscustomobject][ordered]@{
            schemaVersion = 1
            machineId     = (New-AihIntelligenceId 'mach')
            hostname      = $hostname
            platform      = $platform
            createdAt     = $now
            lastSeenAt    = $now
        }
        Write-AihAtomicJson -Path $layout.Machine -Value $machine
        return $machine
    }
}

function Get-AihSlugFromName {
    param([Parameter(Mandatory = $true)][string]$Name)
    $slug = ($Name.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
    if ([string]::IsNullOrEmpty($slug)) { throw "Workspace name cannot be converted to a slug: $Name" }
    return $slug
}

function New-AihWorkspace {
    param(
        [string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$Slug
    )
    if ([string]::IsNullOrWhiteSpace($Name)) { throw 'Workspace name is empty.' }
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return Use-AihIntelligenceLock -StoreRoot $layout.Root -Script {
        $document = Get-AihIntWorkspaceDocument -StoreRoot $StoreRoot
        $slugValue = if ([string]::IsNullOrWhiteSpace($Slug)) { Get-AihSlugFromName $Name } else { (Get-AihSlugFromName $Slug) }
        if (@($document.workspaces | Where-Object { $_.slug -eq $slugValue }).Count -gt 0) {
            throw "A workspace with slug '$slugValue' already exists."
        }
        $now = [DateTime]::UtcNow.ToString('o')
        $workspace = [pscustomobject][ordered]@{
            schemaVersion = 1
            workspaceId   = (New-AihIntelligenceId 'ws')
            name          = $Name
            slug          = $slugValue
            createdAt     = $now
            updatedAt     = $now
        }
        $document.workspaces = @($document.workspaces) + @($workspace)
        Save-AihIntWorkspaceDocument -StoreRoot $StoreRoot -Document $document
        return $workspace
    }
}

function Get-AihWorkspace {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$Workspace)
    $document = Get-AihIntWorkspaceDocument -StoreRoot $StoreRoot
    $match = @($document.workspaces | Where-Object { $_.workspaceId -eq $Workspace -or $_.slug -eq ($Workspace.ToLowerInvariant()) -or $_.name -eq $Workspace } | Select-Object -First 1)
    if (@($match).Count -eq 0) { throw "Workspace was not found: $Workspace" }
    return $match[0]
}

function Get-AihWorkspaceList {
    param([string]$StoreRoot)
    $document = Get-AihIntWorkspaceDocument -StoreRoot $StoreRoot
    return @($document.workspaces)
}

function Add-AihRepositoryToWorkspace {
    # Workspace <-> repository is many-to-many. Role is an optional free-form
    # string (no fixed enum); existing links are updated idempotently.
    param(
        [string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$WorkspaceId,
        [Parameter(Mandatory = $true)][string]$RepositoryId,
        [string]$Role
    )
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return Use-AihIntelligenceLock -StoreRoot $layout.Root -Script {
        $workspaceDocument = Get-AihIntWorkspaceDocument -StoreRoot $StoreRoot
        if (@($workspaceDocument.workspaces | Where-Object { $_.workspaceId -eq $WorkspaceId }).Count -eq 0) { throw "Workspace was not found: $WorkspaceId" }
        $repositoryDocument = Get-AihIntRepositoryDocument -StoreRoot $StoreRoot
        if (@($repositoryDocument.repositories | Where-Object { $_.repositoryId -eq $RepositoryId }).Count -eq 0) { throw "Repository was not found: $RepositoryId" }
        $existing = @($workspaceDocument.links | Where-Object { $_.workspaceId -eq $WorkspaceId -and $_.repositoryId -eq $RepositoryId } | Select-Object -First 1)
        $roleValue = if ([string]::IsNullOrWhiteSpace($Role)) { $null } else { $Role }
        if (@($existing).Count -gt 0) {
            $existing[0].role = $roleValue
            Save-AihIntWorkspaceDocument -StoreRoot $StoreRoot -Document $workspaceDocument
            return $existing[0]
        }
        $link = [pscustomobject][ordered]@{
            schemaVersion = 1
            workspaceId   = $WorkspaceId
            repositoryId  = $RepositoryId
            role          = $roleValue
        }
        $workspaceDocument.links = @($workspaceDocument.links) + @($link)
        Save-AihIntWorkspaceDocument -StoreRoot $StoreRoot -Document $workspaceDocument
        return $link
    }
}

function Remove-AihRepositoryFromWorkspace {
    param(
        [string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$WorkspaceId,
        [Parameter(Mandatory = $true)][string]$RepositoryId
    )
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return Use-AihIntelligenceLock -StoreRoot $layout.Root -Script {
        $workspaceDocument = Get-AihIntWorkspaceDocument -StoreRoot $StoreRoot
        $before = @($workspaceDocument.links).Count
        $workspaceDocument.links = @($workspaceDocument.links | Where-Object { -not ($_.workspaceId -eq $WorkspaceId -and $_.repositoryId -eq $RepositoryId) })
        $removed = $before - @($workspaceDocument.links).Count
        if ($removed -gt 0) { Save-AihIntWorkspaceDocument -StoreRoot $StoreRoot -Document $workspaceDocument }
        return ($removed -gt 0)
    }
}

function Get-AihWorkspaceRepositoryList {
    param([string]$StoreRoot, [string]$WorkspaceId, [string]$RepositoryId)
    $document = Get-AihIntWorkspaceDocument -StoreRoot $StoreRoot
    $links = @($document.links)
    if (-not [string]::IsNullOrEmpty($WorkspaceId)) { $links = @($links | Where-Object { $_.workspaceId -eq $WorkspaceId }) }
    if (-not [string]::IsNullOrEmpty($RepositoryId)) { $links = @($links | Where-Object { $_.repositoryId -eq $RepositoryId }) }
    return $links
}

function Get-AihNexusConfigName {
    # Reads repository.name from the checkout's optional .nexus.yml/.nexus.yaml.
    # Malformed configuration never breaks registration; it is ignored here and
    # surfaced explicitly by the scanner.
    param([Parameter(Mandatory = $true)][string]$CheckoutRoot)
    foreach ($candidate in @('.nexus.yml', '.nexus.yaml')) {
        $path = Join-Path $CheckoutRoot $candidate
        $text = Get-AihOptionalText -Path $path
        if ([string]::IsNullOrEmpty($text)) { continue }
        try {
            $config = ConvertFrom-AihSimpleYaml -Content $text
        } catch { continue }
        if ($config.Contains('repository') -and $null -ne $config['repository'] -and $config['repository'] -is [System.Collections.IDictionary] -and $config['repository'].Contains('name')) {
            $name = $config['repository']['name']
            if (-not [string]::IsNullOrWhiteSpace("$name")) { return "$name" }
        }
    }
    return $null
}

function Get-AihRemoteNameCandidate {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return $null }
    $trimmed = $Url.Trim().TrimEnd('/')
    $trimmed = $trimmed -replace '\.git$', ''
    $segments = $trimmed.Split('/')
    $leaf = $segments[$segments.Count - 1]
    if ([string]::IsNullOrWhiteSpace($leaf) -or $leaf -match '[:@]') { return $null }
    return $leaf
}

function Register-AihRepository {
    # Registers a local path as (or resolves it against) a logical repository.
    # Identity resolution order:
    #   1. existing checkout with the same canonical root path;
    #   2. normalized Git remote matching exactly one registered repository;
    #   3. a new logical repository (ambiguous remotes never merge).
    param(
        [string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Name,
        [string]$Workspace,
        [string]$Role
    )
    $layout = Get-AihIntelligenceLayout $StoreRoot
    $canonical = ConvertTo-AihCheckoutRootPath -Path $Path
    if (-not (Test-Path -LiteralPath $canonical)) { throw "Repository path does not exist: $canonical" }
    $item = Get-Item -LiteralPath $canonical -Force
    if (-not $item.PSIsContainer) { throw "Repository path is not a directory: $canonical" }

    $git = Get-AihGitProvider
    $isGit = & $git.IsRepository $canonical
    $gitRoot = $null
    $remote = $null
    $remoteKey = $null
    $worktreeInfo = $null
    if ($isGit) {
        $gitRoot = ConvertTo-AihCheckoutRootPath -Path (& $git.GetRoot $canonical)
        $remote = & $git.GetRemote $gitRoot
        if ($null -ne $remote) { $remoteKey = ConvertTo-AihNormalizedRemote $remote.url }
        $worktreeInfo = & $git.DetectWorktree $gitRoot
    }
    $checkoutRoot = if ($null -ne $gitRoot) { $gitRoot } else { $canonical }
    $rootKey = Get-AihPathCaseKey $checkoutRoot

    # Git status/branch/HEAD probes can block for seconds or minutes on a
    # large or unhealthy checkout. They are observations, not store
    # mutations, so compute them before entering the store-wide transaction.
    # The transaction below validates the current registry documents before
    # atomically applying this candidate observation.
    $observation = Get-AihCheckoutObservation -CheckoutRoot $checkoutRoot -Vcs $(if ($isGit) { 'git' } else { 'none' })
    $nameCandidate = $Name
    if ([string]::IsNullOrWhiteSpace($nameCandidate)) { $nameCandidate = Get-AihNexusConfigName -CheckoutRoot $checkoutRoot }
    if ([string]::IsNullOrWhiteSpace($nameCandidate) -and $isGit -and $null -ne $remote) { $nameCandidate = Get-AihRemoteNameCandidate -Url $remote.url }
    if ([string]::IsNullOrWhiteSpace($nameCandidate)) { $nameCandidate = (Split-Path -Leaf $checkoutRoot) }
    $defaultBranch = if ($isGit) { & $git.GetDefaultBranch $checkoutRoot } else { $null }

    return Use-AihIntelligenceLock -StoreRoot $layout.Root -Script {
        $machine = Get-AihMachineIdentity -StoreRoot $StoreRoot
        $checkoutDocument = Get-AihIntCheckoutDocument -StoreRoot $StoreRoot
        $repositoryDocument = Get-AihIntRepositoryDocument -StoreRoot $StoreRoot
        $now = [DateTime]::UtcNow.ToString('o')

        # 1. existing checkout at this physical location
        $existingCheckout = @($checkoutDocument.checkouts | Where-Object { $_.rootKey -eq $rootKey } | Select-Object -First 1)
        if (@($existingCheckout).Count -gt 0) {
            $checkout = $existingCheckout[0]
            $checkout.lastSeenAt = $now
            $repository = @($repositoryDocument.repositories | Where-Object { $_.repositoryId -eq $checkout.repositoryId } | Select-Object -First 1)
            if (@($repository).Count -eq 0) { throw "Checkout references a missing repository: $($checkout.repositoryId)" }
            $checkout.lastObservation = $observation
            Save-AihIntCheckoutDocument -StoreRoot $StoreRoot -Document $checkoutDocument
            return [pscustomobject]@{ repository = $repository[0]; checkout = $checkout; createdRepository = $false; createdCheckout = $false }
        }

        # 2./3. remote-based resolution or a fresh logical repository
        $repository = $null
        $createdRepository = $false
        if ($isGit -and $null -ne $remoteKey) {
            $candidates = @($repositoryDocument.repositories | Where-Object {
                ($_.PSObject.Properties['canonicalRemoteKey']) -and $_.canonicalRemoteKey -eq $remoteKey
            })
            if (@($candidates).Count -eq 1) { $repository = $candidates[0] }
            # >1 candidates is ambiguous on purpose: a new repository wins over
            # a potentially incorrect merge. Explicit linking remains possible.
        }
        if ($null -eq $repository) {
            $repository = [pscustomobject][ordered]@{
                schemaVersion     = 1
                repositoryId      = (New-AihIntelligenceId 'repo')
                name              = $nameCandidate
                vcs               = $(if ($isGit) { 'git' } else { 'none' })
                canonicalRemote   = $(if ($null -ne $remote) { $remote.url } else { $null })
                canonicalRemoteKey = $remoteKey
                defaultBranch     = $defaultBranch
                createdAt         = $now
                updatedAt         = $now
            }
            $repositoryDocument.repositories = @($repositoryDocument.repositories) + @($repository)
            $createdRepository = $true
        }

        # checkout kind
        $kind = 'primary'
        if (-not $isGit) { $kind = 'non_git' }
        elseif ($null -ne $worktreeInfo -and $worktreeInfo.isWorktree) { $kind = 'worktree' }
        else {
            $siblings = @($checkoutDocument.checkouts | Where-Object { $_.repositoryId -eq $repository.repositoryId -and $_.machineId -eq $machine.machineId })
            if (@($siblings).Count -gt 0) { $kind = 'clone' }
        }
        $checkout = [pscustomobject][ordered]@{
            schemaVersion    = 1
            checkoutId       = (New-AihIntelligenceId 'checkout')
            repositoryId     = $repository.repositoryId
            machineId        = $machine.machineId
            rootPath         = $checkoutRoot
            rootKey          = $rootKey
            kind             = $kind
            createdAt        = $now
            lastSeenAt       = $now
            activeSnapshotId = $null
            lastObservation  = $observation
        }
        $checkoutDocument.checkouts = @($checkoutDocument.checkouts) + @($checkout)

        Save-AihIntRepositoryDocument -StoreRoot $StoreRoot -Document $repositoryDocument
        Save-AihIntCheckoutDocument -StoreRoot $StoreRoot -Document $checkoutDocument

        if (-not [string]::IsNullOrWhiteSpace($Workspace)) {
            $workspaceRecord = $null
            try { $workspaceRecord = Get-AihWorkspace -StoreRoot $StoreRoot -Workspace $Workspace } catch {
                $workspaceRecord = New-AihWorkspace -StoreRoot $StoreRoot -Name $Workspace
            }
            $null = Add-AihRepositoryToWorkspace -StoreRoot $StoreRoot -WorkspaceId $workspaceRecord.workspaceId -RepositoryId $repository.repositoryId -Role $Role
        }

        if ($createdRepository) {
            $null = Publish-AihIntEvent -StoreRoot $StoreRoot -EventType 'repository.registered' -Data ([ordered]@{
                repositoryId = $repository.repositoryId; name = $repository.name; vcs = $repository.vcs; canonicalRemoteKey = $remoteKey
            })
        }
        $null = Publish-AihIntEvent -StoreRoot $StoreRoot -EventType 'checkout.registered' -Data ([ordered]@{
            checkoutId = $checkout.checkoutId; repositoryId = $repository.repositoryId; rootPath = $checkout.rootPath; kind = $kind
        })

        return [pscustomobject]@{ repository = $repository; checkout = $checkout; createdRepository = $createdRepository; createdCheckout = $true }
    }
}

function Get-AihCheckoutObservation {
    # Current Git/filesystem observation for a checkout (no AI inference).
    param([Parameter(Mandatory = $true)][string]$CheckoutRoot, [string]$Vcs)
    if ($Vcs -ne 'git') { return $null }
    $git = Get-AihGitProvider
    $statusEntries = @()
    try { $statusEntries = @(& $git.GetWorkingTreeStatus $CheckoutRoot) } catch { $statusEntries = @() }
    return [pscustomobject][ordered]@{
        branch        = (& $git.GetBranch $CheckoutRoot)
        headSha       = (& $git.GetHeadSha $CheckoutRoot)
        detached      = (& $git.IsDetachedHead $CheckoutRoot)
        isDirty       = (@($statusEntries).Count -gt 0)
        changedCount  = @($statusEntries).Count
        observedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
}

function Get-AihRepository {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId)
    $document = Get-AihIntRepositoryDocument -StoreRoot $StoreRoot
    $match = @($document.repositories | Where-Object { $_.repositoryId -eq $RepositoryId } | Select-Object -First 1)
    if (@($match).Count -eq 0) { throw "Repository was not found: $RepositoryId" }
    return $match[0]
}

function Get-AihRepositoryList {
    param([string]$StoreRoot, [string]$WorkspaceId)
    $document = Get-AihIntRepositoryDocument -StoreRoot $StoreRoot
    if ([string]::IsNullOrEmpty($WorkspaceId)) { return @($document.repositories) }
    $links = Get-AihWorkspaceRepositoryList -StoreRoot $StoreRoot -WorkspaceId $WorkspaceId
    $linkedIds = @($links | ForEach-Object { $_.repositoryId })
    return @($document.repositories | Where-Object { $linkedIds -contains $_.repositoryId })
}

function Find-AihRepositoryByName {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$Name)
    $document = Get-AihIntRepositoryDocument -StoreRoot $StoreRoot
    return @($document.repositories | Where-Object { $_.name -eq $Name })
}

function Set-AihRepositoryRemote {
    # Explicit identity override: sets or updates the canonical remote of a
    # logical repository. This is a human-controlled linking decision, never
    # an automatic inference.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$RepositoryId, [string]$Url)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return Use-AihIntelligenceLock -StoreRoot $layout.Root -Script {
        $document = Get-AihIntRepositoryDocument -StoreRoot $StoreRoot
        $match = @($document.repositories | Where-Object { $_.repositoryId -eq $RepositoryId } | Select-Object -First 1)
        if (@($match).Count -eq 0) { throw "Repository was not found: $RepositoryId" }
        $match[0].canonicalRemote = if ([string]::IsNullOrWhiteSpace($Url)) { $null } else { $Url }
        $match[0].canonicalRemoteKey = ConvertTo-AihNormalizedRemote -Url $Url
        $match[0].updatedAt = [DateTime]::UtcNow.ToString('o')
        Save-AihIntRepositoryDocument -StoreRoot $StoreRoot -Document $document
        return $match[0]
    }
}

function Get-AihCheckout {
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$CheckoutId)
    $document = Get-AihIntCheckoutDocument -StoreRoot $StoreRoot
    $match = @($document.checkouts | Where-Object { $_.checkoutId -eq $CheckoutId } | Select-Object -First 1)
    if (@($match).Count -eq 0) { throw "Checkout was not found: $CheckoutId" }
    return $match[0]
}

function Get-AihCheckoutList {
    param([string]$StoreRoot, [string]$RepositoryId, [string]$MachineId)
    $document = Get-AihIntCheckoutDocument -StoreRoot $StoreRoot
    $checkouts = @($document.checkouts)
    if (-not [string]::IsNullOrEmpty($RepositoryId)) { $checkouts = @($checkouts | Where-Object { $_.repositoryId -eq $RepositoryId }) }
    if (-not [string]::IsNullOrEmpty($MachineId)) { $checkouts = @($checkouts | Where-Object { $_.machineId -eq $MachineId }) }
    return $checkouts
}

function Remove-AihCheckout {
    # Removes the checkout record only. Snapshot history for the repository is
    # preserved (readers tolerate dangling checkoutIds by design).
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$CheckoutId)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return Use-AihIntelligenceLock -StoreRoot $layout.Root -Script {
        $document = Get-AihIntCheckoutDocument -StoreRoot $StoreRoot
        $before = @($document.checkouts).Count
        $document.checkouts = @($document.checkouts | Where-Object { $_.checkoutId -ne $CheckoutId })
        $removed = $before - @($document.checkouts).Count
        if ($removed -gt 0) { Save-AihIntCheckoutDocument -StoreRoot $StoreRoot -Document $document }
        return ($removed -gt 0)
    }
}

function Move-AihCheckoutToRepository {
    # Explicit identity linking: re-parents a checkout onto another logical
    # repository. This is the deliberate human-controlled merge path for
    # ambiguous identity cases.
    param([string]$StoreRoot, [Parameter(Mandatory = $true)][string]$CheckoutId, [Parameter(Mandatory = $true)][string]$RepositoryId)
    $layout = Get-AihIntelligenceLayout $StoreRoot
    return Use-AihIntelligenceLock -StoreRoot $layout.Root -Script {
        $checkoutDocument = Get-AihIntCheckoutDocument -StoreRoot $StoreRoot
        $repositoryDocument = Get-AihIntRepositoryDocument -StoreRoot $StoreRoot
        if (@($repositoryDocument.repositories | Where-Object { $_.repositoryId -eq $RepositoryId }).Count -eq 0) { throw "Repository was not found: $RepositoryId" }
        $match = @($checkoutDocument.checkouts | Where-Object { $_.checkoutId -eq $CheckoutId } | Select-Object -First 1)
        if (@($match).Count -eq 0) { throw "Checkout was not found: $CheckoutId" }
        $match[0].repositoryId = $RepositoryId
        $match[0].lastSeenAt = [DateTime]::UtcNow.ToString('o')
        Save-AihIntCheckoutDocument -StoreRoot $StoreRoot -Document $checkoutDocument
        return $match[0]
    }
}
