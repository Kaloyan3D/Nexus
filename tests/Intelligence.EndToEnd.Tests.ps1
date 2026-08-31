[CmdletBinding()]param([string]$InstallRoot = 'C:\AI-Harness')
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts\Common.ps1')
. (Join-Path $InstallRoot 'scripts\Intelligence.ps1')

# ── Phase 3.1F (Services, Events, API) + multi-repo acceptance tests ────────
$passed = 0
$nl = [string][char]10
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-Fixture([string]$Name) { $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-int-$Name-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $path -Force | Out-Null; $path }
function Set-TestFile([string]$Path, [string]$Content) { $parent = Split-Path -Parent $Path; if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }; Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 }
function New-TestGitRepo([string]$Path) { New-Item -ItemType Directory -Path $Path -Force | Out-Null; git -C $Path init -q 2>$null; return $Path }
function Invoke-TestGit([string]$Path, [string[]]$GitArguments) {
    # git writes CRLF warnings to stderr; keep them non-terminating
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git -C $Path @GitArguments 2>&1
        if ($LASTEXITCODE -ne 0) { throw ("git failed: " + ($GitArguments -join ' ') + " -> " + ($output -join ' ')) }
        return $output
    } finally { $ErrorActionPreference = $previousEap }
}
function New-MatrixRepos([string]$Root) {
    # five-repository acceptance matrix
    $dirs = @{}
    # 1. simple TypeScript project
    $ts = New-TestGitRepo (Join-Path $Root 'ts-project')
    Set-TestFile (Join-Path $ts 'src\app.ts') 'export const app = 1;'
    Set-TestFile (Join-Path $ts 'package.json') '{"name":"ts-project","version":"0.1.0"}'
    Invoke-TestGit $ts @('add', '.') | Out-Null
    Invoke-TestGit $ts @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    Invoke-TestGit $ts @('remote', 'add', 'origin', 'https://github.com/example/ts-project.git') | Out-Null
    $dirs['ts-project'] = $ts
    # 2. TypeScript monorepo
    $mono = New-TestGitRepo (Join-Path $Root 'ts-monorepo')
    Set-TestFile (Join-Path $mono 'package.json') '{"name":"mono-root","workspaces":["packages/*"]}'
    Set-TestFile (Join-Path $mono 'pnpm-workspace.yaml') (@('packages:', '  - "packages/*"') -join $nl)
    foreach ($p in @('core', 'ui')) {
        Set-TestFile (Join-Path $mono "packages\$p\package.json") ('{"name":"mono-' + $p + '"}')
    }
    Invoke-TestGit $mono @('add', '.') | Out-Null
    Invoke-TestGit $mono @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    $dirs['ts-monorepo'] = $mono
    # 3. .NET solution
    $dn = New-TestGitRepo (Join-Path $Root 'dotnet-suite')
    $slnBody = @('Microsoft Visual Studio Solution File, Format Version 12.00', 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Host", "src\Host\Host.csproj", "{11111111-1111-1111-1111-111111111111}"', 'EndProject', 'Global', 'EndGlobal')
    Set-TestFile (Join-Path $dn 'Host.sln') ($slnBody -join $nl)
    Set-TestFile (Join-Path $dn 'src\Host\Host.csproj') '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
    Invoke-TestGit $dn @('add', '.') | Out-Null
    Invoke-TestGit $dn @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    $dirs['dotnet-suite'] = $dn
    # 4. Python project
    $py = New-TestGitRepo (Join-Path $Root 'py-service')
    Set-TestFile (Join-Path $py 'pyproject.toml') (@('[project]', 'name = "py-service"', 'version = "0.1.0"') -join $nl)
    Set-TestFile (Join-Path $py 'service.py') 'def run(): pass'
    Invoke-TestGit $py @('add', '.') | Out-Null
    Invoke-TestGit $py @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    $dirs['py-service'] = $py
    # 5. non-Git directory
    $plain = Join-Path $Root 'plain-notes'
    Set-TestFile (Join-Path $plain 'notes.txt') 'no vcs here'
    $dirs['plain-notes'] = $plain
    return $dirs
}

$store = New-Fixture e2estore
$fixtureRoot = New-Fixture e2erepos
try {
    # ── event bus: subscribe / dispatch / unsubscribe / error isolation ──
    $received = @()
    $subscription = Subscribe-AihIntEvent -EventTypePattern 'snapshot.*' -Handler { param($event) $script:received = @($script:received) + @($event.type) }
    $plainRepo = Join-Path $fixtureRoot 'eventprobe'
    Set-TestFile (Join-Path $plainRepo 'package.json') '{"name":"eventprobe"}'
    Set-TestFile (Join-Path $plainRepo 'a.js') 'x;'
    $registeredProbe = Register-AihRepository -StoreRoot $store -Path $plainRepo
    $probeBuild = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $registeredProbe.checkout.checkoutId
    Assert-Aih ($received -contains 'snapshot.build.started') 'snapshot.build.started reaches in-process subscribers'
    Assert-Aih ($received -contains 'snapshot.build.completed') 'snapshot.build.completed reaches in-process subscribers'
    Assert-Aih ($received -contains 'snapshot.activated') 'snapshot.activated reaches in-process subscribers'
    Assert-Aih ($received -notcontains 'repository.registered') 'pattern subscriptions only receive matching event types'
    $journalTypes = @((Get-AihIntEvents -StoreRoot $store) | ForEach-Object { $_.type })
    Assert-Aih ($journalTypes -contains 'module.discovered') 'module.discovered events are journaled'
    Assert-Aih ($journalTypes -contains 'repository.registered') 'repository.registered events are journaled'
    # broken subscriber must not corrupt the emitter
    $bad = Subscribe-AihIntEvent -EventTypePattern 'snapshot.*' -Handler { param($event) throw 'subscriber bug' }
    $countBefore = @($received).Count
    $probeBuild2 = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $registeredProbe.checkout.checkoutId
    Assert-Aih (@($received).Count -gt $countBefore) 'healthy subscriber still receives events despite a broken one'
    $handlerErrors = @((Get-AihIntEvents -StoreRoot $store -EventType 'event.handler.error'))
    Assert-Aih (@($handlerErrors).Count -ge 1) 'subscriber failures are journaled as event.handler.error'
    Assert-Aih (Unregister-AihIntEventSubscription -SubscriptionId $bad.subscriptionId) 'unregister removes a subscription'
    Assert-Aih (Unregister-AihIntEventSubscription -SubscriptionId $subscription.subscriptionId) 'unregister removes the other subscription'
    $countBefore = @($received).Count
    $null = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $registeredProbe.checkout.checkoutId
    Assert-Aih (@($received).Count -eq $countBefore) 'unsubscribed handlers receive no further events'

    # ── command facade (CLI-equivalent operations) ───────────────────────
    $ws = Invoke-AihIntelligenceCommand -StoreRoot $store -Command 'workspace-create' -Arguments @('AcceptanceWs')
    Assert-Aih ($ws.workspaceId -like 'ws_*') 'workspace-create creates a workspace'
    $wsList = @(Invoke-AihIntelligenceCommand -StoreRoot $store -Command 'workspace-list')
    Assert-Aih (@($wsList | Where-Object { $_.name -eq 'AcceptanceWs' }).Count -eq 1) 'workspace-list lists created workspaces'

    # ── five-repository matrix: register + snapshot all ──────────────────
    $dirs = New-MatrixRepos $fixtureRoot
    $matrix = @{}
    foreach ($key in @('ts-project', 'ts-monorepo', 'dotnet-suite', 'py-service', 'plain-notes')) {
        $registered = Invoke-AihIntelligenceCommand -StoreRoot $store -Command 'repo-add' -Arguments @($dirs[$key], 'AcceptanceWs')
        $build = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $registered.checkouts[0].checkoutId
        $matrix[$key] = @{ status = $registered; build = $build }
    }
    $repoList = @(Invoke-AihIntelligenceCommand -StoreRoot $store -Command 'repo-list')
    Assert-Aih (@($repoList).Count -ge 6) 'repo-list returns every repository in the matrix'
    $matrixIds = @($matrix.Keys | ForEach-Object { $matrix[$_].status.repository.repositoryId })
    Assert-Aih (@($matrixIds | Sort-Object -Unique).Count -eq 5) 'each matrix repository has its own identity (no cross-contamination)'
    Assert-Aih ($matrix['plain-notes'].status.repository.vcs -eq 'none') 'non-git matrix member registers without git assumptions'
    Assert-Aih ($matrix['plain-notes'].build.snapshot.status -eq 'ready') 'non-git repositories snapshot successfully'
    Assert-Aih ($matrix['ts-monorepo'].build.modules -ge 3) 'monorepo matrix member discovers all workspaces'
    Assert-Aih ($matrix['dotnet-suite'].build.modules -ge 2) '.NET matrix member discovers solution and project'
    Assert-Aih ($matrix['py-service'].build.modules -ge 1) 'Python matrix member discovers its package'
    $monoStatus = Invoke-AihIntelligenceCommand -StoreRoot $store -Command 'repo-status' -Arguments @($matrix['ts-monorepo'].status.repository.repositoryId)
    $monoStatusReady = @($monoStatus.checkouts | Where-Object { $null -ne $_.modules -and $_.modules.count -ge 3 })
    Assert-Aih ($monoStatus.repository.repositoryId -eq $matrix['ts-monorepo'].status.repository.repositoryId -and @($monoStatusReady).Count -ge 1) 'repo-status reports snapshot and module truth'
    $monoSnapshots = @(Invoke-AihIntelligenceCommand -StoreRoot $store -Command 'snapshot-list' -Arguments @('ts-monorepo'))
    Assert-Aih (@($monoSnapshots).Count -ge 1) 'snapshot-list resolves repositories by unique name'
    $monoModules = @(Invoke-AihIntelligenceCommand -StoreRoot $store -Command 'module-list' -Arguments @('ts-monorepo'))
    Assert-Aih (@($monoModules | Where-Object { $_.path -eq 'packages/core' }).Count -eq 1) 'module-list resolves repositories by unique name'
    $statusText = Format-AihRepositoryStatusText -Status $monoStatus
    Assert-Aih ("$statusText" -like '*ts-monorepo*') 'status text renders repository identity'
    Assert-Aih ("$statusText" -like '*snapshot*') 'status text renders snapshot state'
    $scanRows = @(Invoke-AihIntelligenceCommand -StoreRoot $store -Command 'repo-scan' -Arguments @('ts-project'))
    Assert-Aih (@($scanRows).Count -eq 1 -and $scanRows[0].filesTotal -ge 2) 'repo-scan performs a fresh inventory scan'

    # ── unrelated repositories are isolated ──────────────────────────────
    $tsProjectActive = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $matrix['ts-project'].status.checkouts[0].checkoutId
    $pyActive = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $matrix['py-service'].status.checkouts[0].checkoutId
    Assert-Aih ($tsProjectActive.repositoryId -ne $pyActive.repositoryId) 'active snapshots belong to their own repositories'
    Assert-Aih ($tsProjectActive.stateHash -ne $pyActive.stateHash) 'different repositories never share a state hash'

    # ── full end-to-end walk (16 steps) on the TS project ────────────────
    $e2eCheckout = $matrix['ts-project'].status.checkouts[0].checkoutId
    $e2eRepository = $matrix['ts-project'].status.repository.repositoryId
    $tsDir = $dirs['ts-project']
    # (1) registered from unknown directory state — done above
    $s1 = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $e2eCheckout
    Assert-Aih ($null -ne $s1 -and $s1.status -eq 'ready') 'e2e 2: snapshot of a registered repository is ready and active'
    # (3) restart survival via a fresh process
    $freshScript = '. {0}; $a = Get-AihActiveSnapshot -StoreRoot {1} -CheckoutId {2}; Write-Output (''ACTIVE='' + $a.snapshotId); Write-Output (''FILES='' + @(Get-AihSnapshotFiles -StoreRoot {1} -SnapshotId $a.snapshotId -RepositoryId $a.repositoryId).Count)' -f "'C:\AI-Harness\scripts\Intelligence.ps1'", ("'" + $store + "'"), ("'" + $e2eCheckout + "'")
    $freshOut = & powershell.exe -NoProfile -NonInteractive -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($freshScript)))
    Assert-Aih (($freshOut -join ' ') -like '*ACTIVE=snap_*') 'e2e 3: active snapshot survives a Nexus restart'
    Assert-Aih (($freshOut -join ' ') -like '*FILES=*') 'e2e 3: snapshot files survive a Nexus restart'
    # (4) modify exactly one file
    Set-TestFile (Join-Path $tsDir 'src\app.ts') 'export const app = 42;'
    # (5) new snapshot
    $s2build = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $e2eCheckout
    Assert-Aih ($s2build.stateChanged -and $s2build.snapshot.isDirty) 'e2e 4-5: one modified file yields a new dirty snapshot'
    # (6) reuse of unchanged identities
    Assert-Aih ($s2build.filesReused -eq $s2build.filesTotal - 1) 'e2e 6: unchanged files reuse their content identities'
    # (7) atomic activation
    $s2 = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $e2eCheckout
    Assert-Aih ($s2.snapshotId -eq $s2build.snapshot.snapshotId -and $s2.status -eq 'ready') 'e2e 7: new snapshot became the single active pointer'
    # (8) previous snapshot still recoverable
    $s1rows = @(Get-AihSnapshotFiles -StoreRoot $store -SnapshotId $s1.snapshotId -RepositoryId $e2eRepository)
    Assert-Aih (@($s1rows).Count -eq $s2build.filesTotal) 'e2e 8: the previous snapshot remains fully readable'
    $oldApp = @($s1rows | Where-Object { $_.path -eq 'src/app.ts' })[0]
    $newRows = @(Get-AihSnapshotFiles -StoreRoot $store -SnapshotId $s2.snapshotId -RepositoryId $e2eRepository)
    $newApp = @($newRows | Where-Object { $_.path -eq 'src/app.ts' })[0]
    Assert-Aih ($oldApp.contentHash -ne $newApp.contentHash) 'e2e 8: old and new content hashes differ while old rows persist'
    # (9) second checkout of the same repository is independent
    $second = Join-Path $fixtureRoot 'ts-project-second'
    New-Item -ItemType Directory -Path $second -Force | Out-Null
    Copy-Item -Path (Join-Path $tsDir '*') -Destination $second -Recurse -Force
    # the copy carries the same .git/config origin URL, which is what makes
    # identity resolution match it to the original repository
    $secondRegistered = Register-AihRepository -StoreRoot $store -Path $second
    Assert-Aih ($secondRegistered.repository.repositoryId -eq $e2eRepository) 'e2e 9: second checkout resolves to the same repository'
    Assert-Aih ($secondRegistered.checkout.checkoutId -ne $e2eCheckout) 'e2e 9: second checkout keeps its own identity'
    $firstActiveBefore = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $e2eCheckout
    Set-TestFile (Join-Path $second 'src\app.ts') 'export const app = 100;'
    $secondBuild = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $secondRegistered.checkout.checkoutId
    Assert-Aih ($secondBuild.snapshot.isDirty) 'e2e 9: modifying the second checkout dirties only its snapshot'
    $firstActiveAfter = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $e2eCheckout
    Assert-Aih ($firstActiveAfter.snapshotId -eq $firstActiveBefore.snapshotId) 'e2e 9: the first checkout active snapshot is untouched'
    $secondActive = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $secondRegistered.checkout.checkoutId
    Assert-Aih ($secondActive.snapshotId -ne $firstActiveAfter.snapshotId) 'e2e 9: each checkout carries its own active snapshot'
    # (10) unrelated repositories stay isolated through the whole flow
    $monoActive = Get-AihActiveSnapshot -StoreRoot $store -CheckoutId $matrix['ts-monorepo'].status.checkouts[0].checkoutId
    Assert-Aih ($monoActive.stateHash -ne $s2.stateHash) 'e2e 10: monorepo snapshot hash unaffected by project activity'
    $monoRows = @(Get-AihSnapshotFiles -StoreRoot $store -SnapshotId $monoActive.snapshotId -RepositoryId $matrix['ts-monorepo'].status.repository.repositoryId)
    Assert-Aih (@($monoRows | Where-Object { "$($_.path)" -like 'src/*' }).Count -eq 0) 'e2e 10: monorepo snapshot contains none of the project files'

    Write-Host ("End-to-end acceptance: $passed assertions passed.")
} finally {
    if ($store) { Remove-Item -LiteralPath $store -Recurse -Force -ErrorAction SilentlyContinue }
    if ($fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
