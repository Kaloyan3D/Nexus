[CmdletBinding()]param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))
# Platform-aware child host: Windows keeps powershell.exe; POSIX uses the pinned Nexus pwsh.
if (-not (Get-Command Test-AihIsWindows -ErrorAction SilentlyContinue)) { . (Join-Path $InstallRoot 'scripts/Platform.ps1') }; $aihPsHost = Get-AihPowerShellHost -InstallRoot $InstallRoot
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Intelligence.ps1')

# ── Phase 3.1E (Snapshot Engine) acceptance tests ───────────────────────────
$passed = 0
$nl = [string][char]10
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-Fixture([string]$Name) { $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-int-$Name-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $path -Force | Out-Null; $path }
function Set-TestFile([string]$Path, [string]$Content) { $parent = Split-Path -Parent $Path; if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }; Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 }
function New-TestGitRepo([string]$Path) { New-Item -ItemType Directory -Path $Path -Force | Out-Null; git -C $Path init -q 2>$null; return $Path }
function Invoke-TestGit([string]$Path, [string[]]$GitArguments) {
    $output = & git -C $Path @GitArguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("git failed: " + ($GitArguments -join ' ') + " -> " + ($output -join ' ')) }
    return $output
}
function Invoke-FreshBuild([string]$StoreRoot, [string]$CheckoutId) {
    # restart seam: the same build flow must behave identically in a new process
    $template = '. {0}; $result = Invoke-AihSnapshotBuild -StoreRoot {1} -CheckoutId {2}; Write-Output (''STATUS='' + $result.snapshot.status); Write-Output (''ACTIVE='' + (Get-AihActiveSnapshot -StoreRoot {1} -CheckoutId {2}).snapshotId)'
    $scriptText = $template -f ("'C:\AI-Harness\scripts\Intelligence.ps1'"), ("'" + $StoreRoot + "'"), ("'" + $CheckoutId + "'")
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($scriptText))
    $output = & $aihPsHost -NoProfile -NonInteractive -EncodedCommand $encoded
    if ($LASTEXITCODE -ne 0) { throw ("fresh build failed: " + ($output -join ' ')) }
    return ($output | Where-Object { "$_" -like 'STATUS=*' -or "$_" -like 'ACTIVE=*' })
}

$store = New-Fixture snapstore
$fixtureRoot = New-Fixture snaprepos
try {
    # ── build 1: clean repository produces a ready, activated snapshot ───
    $repo = New-TestGitRepo (Join-Path $fixtureRoot 'repo')
    Set-TestFile (Join-Path $repo 'src/main.ts') 'export const main = () => 1;'
    Set-TestFile (Join-Path $repo 'src/util.ts') 'export const util = () => 2;'
    Set-TestFile (Join-Path $repo 'package.json') '{"name":"snap-app"}'
    Invoke-TestGit $repo @('add', '.') | Out-Null
    Invoke-TestGit $repo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    $registered = Register-AihRepository -StoreRoot $store -Path $repo
    $checkoutId = $registered.checkout.checkoutId
    $repositoryId = $registered.repository.repositoryId

    $build1 = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($build1.snapshot.snapshotId -like 'snap_*') 'snapshot uses snap_ prefixed id'
    Assert-Aih ($build1.snapshot.status -eq 'ready') 'first build ends ready'
    Assert-Aih ((Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $checkoutId).snapshotId -eq $build1.snapshot.snapshotId) 'first build is activated as the active snapshot'
    Assert-Aih ($build1.snapshot.commitSha -ne $null -and $build1.snapshot.branch -ne $null) 'snapshot records the git commit sha and branch'
    Assert-Aih (-not $build1.snapshot.isDirty) 'clean repository snapshot is not dirty'
    Assert-Aih (-not [string]::IsNullOrEmpty($build1.snapshot.stateHash)) 'snapshot carries a deterministic state hash'
    Assert-Aih ($build1.filesTotal -ge 3) 'snapshot records the scanned file count'
    Assert-Aih (@($build1.modules).Count -ge 1) 'snapshot records discovered modules'
    $fileRows = Get-AihSnapshotFiles -StoreRoot $store -SnapshotId $build1.snapshot.snapshotId -RepositoryId $repositoryId
    Assert-Aih (@($fileRows).Count -eq $build1.filesTotal) 'snapshot_files are persisted for the snapshot'
    Assert-Aih ($fileRows[0].contentHash -like 'sha256*') 'snapshot file rows carry content hashes'
    $moduleRows = Get-AihSnapshotModules -StoreRoot $store -SnapshotId $build1.snapshot.snapshotId -RepositoryId $repositoryId
    Assert-Aih (@($moduleRows).Count -ge 1) 'snapshot_modules are persisted for the snapshot'
    $build1Again = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($build1Again.snapshot.stateHash -eq $build1.snapshot.stateHash) 'rebuilding an unchanged repository yields the identical state hash'
    Assert-Aih ($build1Again.snapshot.status -eq 'ready') 'second build of unchanged state is ready'
    Assert-Aih (@(Get-AihSnapshotList -StoreRoot $store -RepositoryId $repositoryId | Where-Object { $_.status -eq 'ready' }).Count -eq 1) 'exactly one snapshot stays ready; the earlier one is superseded'
    Assert-Aih (@(Get-AihSnapshotList -StoreRoot $store -RepositoryId $repositoryId | Where-Object { $_.status -eq 'superseded' }).Count -eq 1) 'the previous ready snapshot becomes superseded'

    # ── file object reuse: unchanged content keeps its identity ──────────
    $objectsAfterBuild2 = Get-AihIntFileObjectIndex -StoreRoot $store
    Assert-Aih (@($objectsAfterBuild2.Keys).Count -ge 3) 'content-addressed file objects exist in the store'
    $build2 = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($build2.filesReused -eq $build2.filesTotal) 'rebuilding reuses every unchanged file hash (no re-read)'
    Assert-Aih ($build2.snapshot.stateHash -eq $build1.snapshot.stateHash) 'unchanged rebuild state hash stays identical'

    # ── build 3: one modified file ───────────────────────────────────────
    Set-TestFile (Join-Path $repo 'src/util.ts') 'export const util = () => 22;'
    $build3 = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($build3.stateChanged) 'modifying one file changes the state hash'
    Assert-Aih ($build3.snapshot.isDirty) 'uncommitted modification marks the snapshot dirty'
    Assert-Aih ($build3.filesReused -eq $build3.filesTotal - 1) 'exactly one file hash is recomputed; the rest are reused'
    Assert-Aih ($build3.snapshot.status -eq 'ready') 'dirty snapshot builds ready'
    $active3 = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($active3.snapshotId -eq $build3.snapshot.snapshotId) 'new snapshot atomically replaces the active pointer'

    # state hash must differentiate dirty states (different dirty content)
    Set-TestFile (Join-Path $repo 'src/util.ts') 'export const util = () => 33;'
    $build4 = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($build4.snapshot.stateHash -ne $build3.snapshot.stateHash) 'different dirty content produces a different state hash'
    Set-TestFile (Join-Path $repo 'src/util.ts') 'export const util = () => 22;'
    $build3Repeat = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($build3Repeat.snapshot.stateHash -eq $build3.snapshot.stateHash) 'returning to the earlier dirty state reproduces its exact state hash'

    # ── add / delete / rename all change the state ───────────────────────
    Set-TestFile (Join-Path $repo 'src/extra.ts') 'export const extra = 3;'
    $buildAdd = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($buildAdd.stateChanged -and $buildAdd.filesTotal -eq $build3.filesTotal + 1) 'adding a file changes the state and file count'
    Remove-Item -LiteralPath (Join-Path $repo 'src/extra.ts') -Force
    $buildDelete = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($buildDelete.stateChanged) 'deleting a file changes the state'
    Invoke-TestGit $repo @('mv', 'src\main.ts', 'src\renamed.ts') | Out-Null
    $buildRename = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($buildRename.stateChanged) 'renaming a file changes the state'
    $renameRows = Get-AihSnapshotFiles -StoreRoot $store -SnapshotId $buildRename.snapshot.snapshotId -RepositoryId $repositoryId
    Assert-Aih (@($renameRows | Where-Object { $_.path -eq 'src/renamed.ts' }).Count -eq 1) 'renamed file appears under its new normalized path'
    Assert-Aih (@($renameRows | Where-Object { $_.path -eq 'src/main.ts' }).Count -eq 0) 'old path disappears from the snapshot'
    Invoke-TestGit $repo @('reset', '-q', '--hard') | Out-Null

    # ── validator failure never corrupts the active snapshot ─────────────
    $activeBefore = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $checkoutId
    Set-TestFile (Join-Path $repo 'src/util.ts') 'export const broken = true;'
    $validatorThrew = $false
    try {
        Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId -Validator { throw 'simulated validation failure' } | Out-Null
    } catch { $validatorThrew = $true }
    Assert-Aih $validatorThrew 'validator failure surfaces as a build error'
    $activeAfter = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($activeAfter.snapshotId -eq $activeBefore.snapshotId) 'failed build leaves the previously active snapshot active'
    Assert-Aih ($activeAfter.status -eq 'ready') 'active snapshot survives the failed build intact'
    $failedList = @(Get-AihSnapshotList -StoreRoot $store -RepositoryId $repositoryId | Where-Object { $_.status -eq 'failed' })
    Assert-Aih (@($failedList).Count -ge 1 -and $failedList[0].failureReason -like '*simulated validation failure*') 'failed snapshot is recorded with status=failed and a reason'

    # ── restart persistence: state survives a fresh Nexus process ────────
    Set-TestFile (Join-Path $repo 'src/util.ts') 'export const util = () => 22;'
    $fresh = Invoke-FreshBuild -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ("$fresh" -like '*STATUS=ready*') 'snapshot build works identically in a fresh process'
    Assert-Aih ("$fresh" -like '*ACTIVE=snap_*') 'fresh process resolves the active snapshot pointer'
    $freshList = @(Get-AihSnapshotList -StoreRoot $store -RepositoryId $repositoryId)
    Assert-Aih (@($freshList).Count -ge 2) 'snapshot history survives across processes'

    # repair seam: a dangling 'building' snapshot is reconciled to failed
    $orphanId = 'snap_' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    $snapDoc = Read-AihIntSnapshots -StoreRoot $store -RepositoryId $repositoryId
    $snapDoc.snapshots = @($snapDoc.snapshots) + @(@{ snapshotId = $orphanId; repositoryId = $repositoryId; checkoutId = $checkoutId; status = 'building'; createdAt = [DateTime]::UtcNow.ToString('o'); stateHash = 'orphan' })
    Save-AihIntSnapshots -StoreRoot $store -RepositoryId $repositoryId -Document $snapDoc
    $repaired = Repair-AihSnapshotStates -StoreRoot $store
    $orphan = @(Get-AihSnapshotList -StoreRoot $store -RepositoryId $repositoryId | Where-Object { $_.snapshotId -eq $orphanId })[0]
    Assert-Aih ($orphan.status -eq 'failed') "stale 'building' snapshots are reconciled to failed on startup"

    Write-Host ("Snapshot acceptance: $passed assertions passed.")
} finally {
    if ($store) { Remove-Item -LiteralPath $store -Recurse -Force -ErrorAction SilentlyContinue }
    if ($fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
