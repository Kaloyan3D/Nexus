[CmdletBinding()]param([string]$InstallRoot)
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Intelligence.ps1')

# ── Phase 3.1 hardening Fix 4: snapshot ↔ module versioning ─────────────────
$passed = 0
$nl = [string][char]10
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-Fixture([string]$Name) { $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-smod-$Name-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $path -Force | Out-Null; $path }
function Set-TestFile([string]$Path, [string]$Content) { $parent = Split-Path -Parent $Path; if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }; Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 }
function New-TestGitRepo([string]$Path) { New-Item -ItemType Directory -Path $Path -Force | Out-Null; git -C $Path init -q 2>$null; return $Path }
function Invoke-TestGit([string]$Path, [string[]]$GitArguments) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & git -C $Path @GitArguments 2>&1; if ($LASTEXITCODE -ne 0) { throw ("git failed: " + ($GitArguments -join ' ')) } ; return $output }
    finally { $ErrorActionPreference = $previousEap }
}

$store = New-Fixture store
$fixtureRoot = New-Fixture repos
try {
    # monorepo fixture: root package.json + pnpm workspaces over packages/*
    $repo = New-TestGitRepo (Join-Path $fixtureRoot 'monorepo')
    Set-TestFile (Join-Path $repo 'package.json') '{"name":"mono-root","workspaces":["packages/*"]}'
    Set-TestFile (Join-Path $repo 'pnpm-workspace.yaml') (@('packages:', '  - "packages/*"') -join $nl)
    foreach ($p in @('alpha', 'beta', 'gamma')) {
        Set-TestFile (Join-Path $repo "packages/$p/package.json") ('{"name":"pkg-' + $p + '","version":"1.0.0"}')
        Set-TestFile (Join-Path $repo "packages/$p/index.ts") ('export const ' + $p + ' = 1;')
    }
    Set-TestFile (Join-Path $repo 'root.ts') 'export const root = 0;'
    Invoke-TestGit $repo @('add', '.') | Out-Null
    Invoke-TestGit $repo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    $registered = Register-AihRepository -StoreRoot $store -Path $repo
    $checkoutId = $registered.checkout.checkoutId
    $repositoryId = $registered.repository.repositoryId

    $buildA = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $modulesA = @(Get-AihSnapshotModules -StoreRoot $store -SnapshotId $buildA.snapshot.snapshotId -RepositoryId $repositoryId)
    Assert-Aih (@($modulesA).Count -eq 4) 'snapshot A records root plus three package modules'
    $alphaA = @($modulesA | Where-Object { $_.path -eq 'packages/alpha' })[0]
    $betaA = @($modulesA | Where-Object { $_.path -eq 'packages/beta' })[0]
    Assert-Aih ($null -ne $alphaA -and $alphaA.moduleId -like 'module_*') 'membership rows carry stable logical module ids'

    # file ownership inside snapshot A
    $filesA = @(Get-AihSnapshotFiles -StoreRoot $store -SnapshotId $buildA.snapshot.snapshotId -RepositoryId $repositoryId)
    $alphaFileA = @($filesA | Where-Object { $_.path -eq 'packages/alpha/index.ts' })[0]
    $rootFileA = @($filesA | Where-Object { $_.path -eq 'root.ts' })[0]
    Assert-Aih ($alphaFileA.moduleId -eq $alphaA.moduleId) 'files under a nested module are owned by that module in the snapshot'
    Assert-Aih ($rootFileA.moduleId -eq @($modulesA | Where-Object { $_.path -eq '' })[0].moduleId) 'root-level files are owned by the generic root module'

    # ── module added + manifest changed between snapshots ────────────────
    Set-TestFile (Join-Path $repo 'packages/delta/package.json') '{"name":"pkg-delta","version":"1.0.0"}'
    Set-TestFile (Join-Path $repo 'packages/delta/index.ts') 'export const delta = 1;'
    Set-TestFile (Join-Path $repo 'packages/alpha/package.json') '{"name":"pkg-alpha","version":"2.0.0"}'
    Invoke-TestGit $repo @('add', '.') | Out-Null
    Invoke-TestGit $repo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'add delta, bump alpha') | Out-Null
    $buildB = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $modulesB = @(Get-AihSnapshotModules -StoreRoot $store -SnapshotId $buildB.snapshot.snapshotId -RepositoryId $repositoryId)
    $alphaB = @($modulesB | Where-Object { $_.path -eq 'packages/alpha' })[0]
    $deltaB = @($modulesB | Where-Object { $_.path -eq 'packages/delta' })[0]
    Assert-Aih (@($modulesB).Count -eq 5) 'snapshot B records the added module'
    Assert-Aih ($alphaB.moduleId -eq $alphaA.moduleId) 'manifest change keeps the same logical module identity (same path)'
    Assert-Aih ($alphaB.metadataHash -ne $alphaA.metadataHash) 'manifest change produces a new metadata version for the module'
    Assert-Aih ($null -ne $deltaB) 'snapshot B contains the newly added module membership'
    # history preserved: snapshot A unchanged
    $modulesA2 = @(Get-AihSnapshotModules -StoreRoot $store -SnapshotId $buildA.snapshot.snapshotId -RepositoryId $repositoryId)
    Assert-Aih (@($modulesA2).Count -eq 4) 'historical snapshot A still returns exactly its own module set'
    Assert-Aih (@($modulesA2 | Where-Object { $_.path -eq 'packages/delta' }).Count -eq 0) 'historical snapshot A does not contain later modules'
    $alphaA2 = @($modulesA2 | Where-Object { $_.path -eq 'packages/alpha' })[0]
    Assert-Aih ($alphaA2.metadataHash -eq $alphaA.metadataHash) 'historical snapshot A keeps the old module metadata version'

    # ── module removed between snapshots ─────────────────────────────────
    Remove-Item -LiteralPath (Join-Path $repo 'packages/gamma') -Recurse -Force
    Invoke-TestGit $repo @('add', '-A') | Out-Null
    Invoke-TestGit $repo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'remove gamma') | Out-Null
    $buildC = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $modulesC = @(Get-AihSnapshotModules -StoreRoot $store -SnapshotId $buildC.snapshot.snapshotId -RepositoryId $repositoryId)
    Assert-Aih (@($modulesC | Where-Object { $_.path -eq 'packages/gamma' }).Count -eq 0) 'snapshot C no longer contains the removed module'
    Assert-Aih (@(Get-AihSnapshotModules -StoreRoot $store -SnapshotId $buildA.snapshot.snapshotId -RepositoryId $repositoryId | Where-Object { $_.path -eq 'packages/gamma' }).Count -eq 1) 'historical snapshot A still contains the removed module'

    # ── module moved between snapshots (path changes → new logical id) ───
    Move-Item -LiteralPath (Join-Path $repo 'packages/beta') -Destination (Join-Path $repo 'packages/beta-renamed')
    Invoke-TestGit $repo @('add', '-A') | Out-Null
    Invoke-TestGit $repo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'move beta') | Out-Null
    $buildD = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $modulesD = @(Get-AihSnapshotModules -StoreRoot $store -SnapshotId $buildD.snapshot.snapshotId -RepositoryId $repositoryId)
    $movedD = $modulesD | Where-Object { $_.path -eq 'packages/beta-renamed' } | Select-Object -First 1
    $betaD = $modulesD | Where-Object { $_.path -eq 'packages/beta' } | Select-Object -First 1
    Assert-Aih ($null -ne $movedD -and $null -eq $betaD) 'snapshot D records the module at its new path only'
    Assert-Aih ($movedD.moduleId -ne $betaA.moduleId) 'a moved module is a new logical module identity (path-derived)'
    Assert-Aih (@(Get-AihSnapshotModules -StoreRoot $store -SnapshotId $buildA.snapshot.snapshotId -RepositoryId $repositoryId | Where-Object { $_.path -eq 'packages/beta' }).Count -eq 1) 'historical snapshot A still owns the old module path'

    # ── unchanged module stays identical across snapshots ────────────────
    $gammaB = @($modulesB | Where-Object { $_.path -eq 'packages/gamma' })[0]
    $gammaA = @($modulesA | Where-Object { $_.path -eq 'packages/gamma' })[0]
    Assert-Aih ($gammaB.moduleId -eq $gammaA.moduleId -and $gammaB.metadataHash -eq $gammaA.metadataHash) 'unchanged module keeps identical logical id and metadata version across snapshots'

    # latest repository module set reflects the newest snapshot only
    $latest = @(Get-AihModuleList -StoreRoot $store -RepositoryId $repositoryId)
    Assert-Aih (@($latest | Where-Object { $_.path -eq 'packages/beta-renamed' }).Count -eq 1 -and @($latest | Where-Object { $_.path -eq 'packages/beta' }).Count -eq 0) 'latest repository module view reflects the newest snapshot'

    # file ownership respects history
    $filesD = @(Get-AihSnapshotFiles -StoreRoot $store -SnapshotId $buildD.snapshot.snapshotId -RepositoryId $repositoryId)
    $renamedFile = @($filesD | Where-Object { $_.path -eq 'packages/beta-renamed/index.ts' })[0]
    Assert-Aih ($renamedFile.moduleId -eq $movedD.moduleId) 'file ownership follows the module in its own snapshot'

    Write-Host ("Snapshot-module versioning: $passed assertions passed.")
} finally {
    if ($store) { Remove-Item -LiteralPath $store -Recurse -Force -ErrorAction SilentlyContinue }
    if ($fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
