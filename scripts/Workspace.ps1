Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Nexus workspace/session identity adapter.
#
# DSH owns the immutable per-session cwd and its durable UI Workspace. Nexus
# Phase 3.1 owns logical Workspace/Repository/Checkout identities. This module
# is the single bridge between them: a selected execution directory is
# canonicalized, resolved through the Phase 3.1 repository registry, linked to
# one logical Workspace, and returned as an explicit identity chain. Nothing
# here changes process-global cwd.

. (Join-Path $PSScriptRoot 'Intelligence.ps1')

function Get-AihCanonicalExecutionRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Workspace path is empty.' }
    $providerPath = $executionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $full = [IO.Path]::GetFullPath($providerPath).TrimEnd('\', '/')
    if ($full -match '^[A-Za-z]:$') { $full += [IO.Path]::DirectorySeparatorChar }
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        throw "Workspace directory does not exist: $full"
    }
    # Resolve links/junctions where the provider supports it. The Phase 3.1
    # checkout normalizer performs the final stable separator normalization.
    try { $full = [IO.Path]::GetFullPath((Get-Item -LiteralPath $full -Force).FullName) } catch { }
    return $full.TrimEnd('\', '/')
}

function Get-AihNexusOpenUrl {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [string]$ExecutionRoot
    )
    if ([string]::IsNullOrWhiteSpace($ExecutionRoot)) { return $BaseUrl }
    return $BaseUrl.TrimEnd('/') + '/?nexus-open=' + [Uri]::EscapeDataString([IO.Path]::GetFullPath($ExecutionRoot))
}

function Test-AihReusableUniversalRuntimeState {
    param([AllowNull()]$State, [switch]$Restart)
    if ($Restart -or $null -eq $State) { return $false }
    $schema = if ($null -ne $State.PSObject.Properties['SchemaVersion']) { [int]$State.SchemaVersion } else { 0 }
    return $schema -ge 4
}

function Get-AihWorkspaceForRepository {
    param(
        [string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$RepositoryId,
        [Parameter(Mandatory = $true)][string]$SuggestedName
    )

    $store = Get-AihIntelligenceStoreRoot $StoreRoot
    return Use-AihIntelligenceLock -StoreRoot $store -Script {
        $links = @(Get-AihWorkspaceRepositoryList -StoreRoot $store -RepositoryId $RepositoryId)
        if ($links.Count -gt 0) {
            # Workspace document order is authoritative and stable. Never choose by
            # incidental path or recency.
            foreach ($workspace in @(Get-AihWorkspaceList -StoreRoot $store)) {
                if (@($links | Where-Object { $_.workspaceId -eq $workspace.workspaceId }).Count -gt 0) {
                    return $workspace
                }
            }
            throw "Repository '$RepositoryId' has a dangling WorkspaceRepository link."
        }

        $name = if ([string]::IsNullOrWhiteSpace($SuggestedName)) { 'Workspace' } else { $SuggestedName }
        $baseSlug = Get-AihSlugFromName $name
        $slug = $baseSlug
        $suffix = 1
        $existingSlugs = @(Get-AihWorkspaceList -StoreRoot $store | ForEach-Object { $_.slug })
        while ($existingSlugs -contains $slug) {
            $suffix++
            $slug = "$baseSlug-$suffix"
        }
        $workspace = New-AihWorkspace -StoreRoot $store -Name $name -Slug $slug
        $null = Add-AihRepositoryToWorkspace -StoreRoot $store -WorkspaceId $workspace.workspaceId -RepositoryId $RepositoryId -Role 'primary'
        return $workspace
    }
}

function Get-AihNexusWorkspaceResolveFlightIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$ExecutionRoot
    )
    $identityKey = (Get-AihPathCaseKey ([IO.Path]::GetFullPath($StoreRoot))) + '|' + (Get-AihPathCaseKey ([IO.Path]::GetFullPath($ExecutionRoot)))
    return Get-AihSha256Text -Text $identityKey
}

function Use-AihNexusWorkspaceResolveFlight {
    # Cross-process single-flight for overlapping resolves of one canonical
    # execution root. The registry remains authoritative: the small result
    # document is accepted only by callers whose request began before that
    # result completed, then is never reused by later requests.
    param(
        [Parameter(Mandatory = $true)][string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$ExecutionRoot,
        [Parameter(Mandatory = $true)][DateTime]$RequestStartedAtUtc,
        [Parameter(Mandatory = $true)][scriptblock]$Script
    )

    $store = Get-AihIntelligenceStoreRoot $StoreRoot
    $flightId = Get-AihNexusWorkspaceResolveFlightIdentity -StoreRoot $store -ExecutionRoot $ExecutionRoot
    $mutex = [Threading.Mutex]::new($false, ('AihWorkspaceResolve-' + $flightId.Substring(0, 24)))
    $taken = $false
    try {
        try {
            # A resolve flight has no arbitrary deadline: the underlying
            # operation owns cancellation/timeout semantics. Process death is
            # recovered through the abandoned-mutex path below.
            $taken = $mutex.WaitOne()
        }
        catch [Threading.AbandonedMutexException] {
            $taken = $true
        }

        $flightDirectory = Join-Path $store 'resolve-flights'
        $flightPath = Join-Path $flightDirectory ($flightId + '.json')
        if (Test-Path -LiteralPath $flightPath) {
            try {
                $completed = Get-Content -Raw -Encoding UTF8 -LiteralPath $flightPath | ConvertFrom-Json
                $completedAt = [DateTime]::Parse([string]$completed.completedAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
                $sharedIdentity = $completed.identity
                $sharedRootMatches = (Get-AihPathCaseKey ([IO.Path]::GetFullPath([string]$sharedIdentity.executionRoot))) -eq (Get-AihPathCaseKey ([IO.Path]::GetFullPath($ExecutionRoot)))
                if ($completed.schemaVersion -eq 1 -and
                    $completed.flightId -eq $flightId -and
                    $completedAt -ge $RequestStartedAtUtc -and
                    $null -ne $sharedIdentity -and
                    -not ([string]::IsNullOrWhiteSpace([string]$sharedIdentity.workspaceId)) -and
                    -not ([string]::IsNullOrWhiteSpace([string]$sharedIdentity.repositoryId)) -and
                    -not ([string]::IsNullOrWhiteSpace([string]$sharedIdentity.checkoutId)) -and
                    $sharedRootMatches) {
                    return $sharedIdentity
                }
            }
            catch {
                # A partial/stale coordination document is not identity state;
                # recompute from the authoritative registry.
            }
        }

        $identity = & $Script
        try {
            New-Item -ItemType Directory -Force -Path $flightDirectory | Out-Null
            Write-AihAtomicJson -Path $flightPath -Value ([pscustomobject][ordered]@{
                schemaVersion = 1
                flightId = $flightId
                completedAtUtc = [DateTime]::UtcNow.ToString('o')
                identity = $identity
            })
        }
        catch {
            # Coordination is derived from the authoritative registry. If its
            # result cannot be published, this caller still succeeds and a
            # waiter safely recomputes instead of receiving stale state.
        }
        return $identity
    }
    finally {
        if ($taken) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Resolve-AihNexusWorkspaceIdentity {
    [CmdletBinding()]
    param(
        [string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $store = Get-AihIntelligenceStoreRoot $StoreRoot
    $executionRoot = Get-AihCanonicalExecutionRoot -Path $Path
    $requestStartedAtUtc = [DateTime]::UtcNow
    return Use-AihNexusWorkspaceResolveFlight -StoreRoot $store -ExecutionRoot $executionRoot -RequestStartedAtUtc $requestStartedAtUtc -Script {
        $registered = Register-AihRepository -StoreRoot $store -Path $executionRoot
        $repository = $registered.repository
        $checkout = $registered.checkout

        if ($null -eq $repository -or $null -eq $checkout) {
            throw 'Phase 3.1 repository registration returned an incomplete identity.'
        }
        if (-not (Test-Path -LiteralPath $checkout.rootPath -PathType Container)) {
            throw "Checkout is unavailable: $($checkout.checkoutId) at $($checkout.rootPath)"
        }
        if (-not (Test-AihPathInsideRoot -Root $checkout.rootPath -FullPath $executionRoot)) {
            throw "Execution root '$executionRoot' is outside checkout '$($checkout.rootPath)'."
        }

        $suggestedName = Split-Path -Leaf $executionRoot
        if ([string]::IsNullOrWhiteSpace($suggestedName)) { $suggestedName = $repository.name }
        $workspace = Get-AihWorkspaceForRepository -StoreRoot $store -RepositoryId $repository.repositoryId -SuggestedName $suggestedName
        $links = @(Get-AihWorkspaceRepositoryList -StoreRoot $store -WorkspaceId $workspace.workspaceId -RepositoryId $repository.repositoryId)
        if ($links.Count -ne 1) {
            throw "Workspace/repository identity is not uniquely linked for '$($workspace.workspaceId)' and '$($repository.repositoryId)'."
        }

        $machine = Get-AihMachineIdentity -StoreRoot $store
        [pscustomobject][ordered]@{
            schemaVersion = 1
            machineId = $machine.machineId
            workspaceId = $workspace.workspaceId
            repositoryId = $repository.repositoryId
            checkoutId = $checkout.checkoutId
            checkoutRootPath = [IO.Path]::GetFullPath($checkout.rootPath)
            executionRoot = [IO.Path]::GetFullPath($executionRoot)
            vcs = $repository.vcs
            checkoutKind = $checkout.kind
        }
    }
}

function Test-AihNexusWorkspaceIdentity {
    [CmdletBinding()]
    param(
        [string]$StoreRoot,
        [Parameter(Mandatory = $true)]$Identity,
        [Parameter(Mandatory = $true)][string]$ExecutionRoot
    )

    if ($null -eq $Identity) { throw 'Session workspace identity is missing.' }
    $actualRoot = Get-AihCanonicalExecutionRoot -Path $ExecutionRoot
    $checkout = Get-AihCheckout -StoreRoot $StoreRoot -CheckoutId ([string]$Identity.checkoutId)
    if ([string]$checkout.repositoryId -ne [string]$Identity.repositoryId) {
        throw 'Session workspace identity mismatch: checkout repository changed.'
    }
    $links = @(Get-AihWorkspaceRepositoryList -StoreRoot $StoreRoot -WorkspaceId ([string]$Identity.workspaceId) -RepositoryId ([string]$Identity.repositoryId))
    if ($links.Count -ne 1) { throw 'Session workspace identity mismatch: WorkspaceRepository link is missing or ambiguous.' }
    if (-not (Test-Path -LiteralPath $checkout.rootPath -PathType Container)) {
        throw "Session checkout is unavailable: $($checkout.rootPath)"
    }
    if ((Get-AihPathCaseKey ([IO.Path]::GetFullPath($actualRoot))) -ne (Get-AihPathCaseKey ([IO.Path]::GetFullPath([string]$Identity.executionRoot)))) {
        throw "Session execution root mismatch: expected '$($Identity.executionRoot)', actual '$actualRoot'."
    }
    if (-not (Test-AihPathInsideRoot -Root $checkout.rootPath -FullPath $actualRoot)) {
        throw 'Session execution root is outside its registered checkout.'
    }
    return $true
}
