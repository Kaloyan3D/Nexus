[CmdletBinding()]param([string]$InstallRoot = 'C:\AI-Harness')
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts\Common.ps1')
. (Join-Path $InstallRoot 'scripts\Intelligence.ps1')

# ── Phase 3.1A (Identity & Registry) + 3.1B (Git State) acceptance tests ────
$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-Fixture([string]$Name) { $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-int-$Name-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $path -Force | Out-Null; $path }
function New-TestGitRepo([string]$Path) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    git -C $Path init -q 2>$null
    return $Path
}
function Set-TestFile([string]$Path, [string]$Content) { Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 }
function Invoke-TestGit([string]$Path, [string[]]$GitArguments) {
    $output = & git -C $Path @GitArguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("git failed: " + ($GitArguments -join ' ') + " -> " + ($output -join ' ')) }
    return $output
}
function Invoke-FreshProcess {
    param([string]$StoreRoot, [string]$Expression)
    $scriptText = ". 'C:\AI-Harness\scripts\Intelligence.ps1'; " + $Expression
    $bytes = [Text.Encoding]::Unicode.GetBytes($scriptText)
    $encoded = [Convert]::ToBase64String($bytes)
    $output = & powershell.exe -NoProfile -NonInteractive -EncodedCommand $encoded
    if ($LASTEXITCODE -ne 0) { throw "fresh-process check failed: $($output -join ' ')" }
    return ($output -join [Environment]::NewLine)
}

$store = New-Fixture store
$fixtureRoot = New-Fixture repos
$created = @()
try {

    # ── MachineIdentityService ───────────────────────────────────────────
    $machine1 = Get-AihMachineIdentity -StoreRoot $store
    Assert-Aih ($machine1.machineId -like 'mach_*') 'machine identity uses mach_ prefix'
    Assert-Aih (-not [string]::IsNullOrEmpty($machine1.hostname)) 'machine identity records hostname'
    Assert-Aih (-not [string]::IsNullOrEmpty($machine1.platform)) 'machine identity records platform'
    Assert-Aih (-not [string]::IsNullOrEmpty($machine1.createdAt)) 'machine identity has createdAt'
    $machine2 = Get-AihMachineIdentity -StoreRoot $store
    Assert-Aih ($machine1.machineId -eq $machine2.machineId) 'machine identity is stable across loads (created once)'
    Assert-Aih (Test-Path (Join-Path $store 'machine.json')) 'machine identity persists to the store'

    # ── PathNormalizer ───────────────────────────────────────────────────
    $winPath = ConvertTo-AihRepositoryRelativePath -Root 'C:/repos/Demo' -Path 'C:\repos\Demo\src\auth\User.ts'
    Assert-Aih ($winPath -eq 'src/auth/User.ts') 'Windows backslash path normalizes to POSIX repository-relative'
    $unixPath = ConvertTo-AihRepositoryRelativePath -Root 'C:/repos/Demo' -Path 'src/auth/User.ts'
    Assert-Aih ($unixPath -eq 'src/auth/User.ts') 'Unix-style relative path is preserved POSIX-normalized'
    $mixedCase = ConvertTo-AihRepositoryRelativePath -Root 'C:/repos/Demo' -Path 'C:\repos\Demo\Src\Auth\UserService.ts'
    Assert-Aih ($mixedCase -eq 'Src/Auth/UserService.ts') 'paths are never lowercased globally (case sensitivity is not assumed)'
    $escaped = $false
    try { ConvertTo-AihRepositoryRelativePath -Root 'C:/repos/Demo' -Path '../../outside.txt' | Out-Null } catch { $escaped = $_.Exception.Message -match 'escapes' }
    Assert-Aih $escaped 'relative paths escaping the repository root are rejected'
    $rootCanonical = ConvertTo-AihCheckoutRootPath -Path 'C:\repos\Demo\'
    Assert-Aih ($rootCanonical -eq 'C:/repos/Demo') 'checkout root canonicalizes separators and trailing slash'

    # ── Repository identity resolution (Git) ─────────────────────────────
    $remoteUrl = 'https://github.com/example/identity-project.git'
    $repoA = New-TestGitRepo (Join-Path $fixtureRoot 'repoA')
    Set-TestFile (Join-Path $repoA 'app.ts') 'export const a = 1;'
    Invoke-TestGit $repoA @('add', '.') | Out-Null
    Invoke-TestGit $repoA @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    Invoke-TestGit $repoA @('remote', 'add', 'origin', $remoteUrl) | Out-Null
    $registeredA = Register-AihRepository -StoreRoot $store -Path $repoA
    Assert-Aih ($registeredA.repository.repositoryId -like 'repo_*') 'repository uses repo_ prefixed id'
    Assert-Aih ($registeredA.repository.vcs -eq 'git') 'git repository resolves vcs=git'
    Assert-Aih ($registeredA.repository.canonicalRemote -eq $remoteUrl) 'canonical remote stores the original URL'
    Assert-Aih ($registeredA.repository.canonicalRemoteKey -eq 'github.com/example/identity-project') 'remote normalizes to comparable identity key'
    Assert-Aih ($registeredA.checkout.checkoutId -like 'checkout_*') 'checkout uses checkout_ prefixed id'
    Assert-Aih ($registeredA.checkout.kind -eq 'primary') 'first checkout of a repository is primary'
    Assert-Aih ($registeredA.checkout.rootPath -eq (ConvertTo-AihCheckoutRootPath -Path $repoA)) 'checkout rootPath is canonical'
    Assert-Aih ($registeredA.checkout.machineId -eq $machine1.machineId) 'checkout is bound to the current machine identity'
    Assert-Aih ($null -ne $registeredA.checkout.lastObservation.headSha) 'registration observes HEAD sha from Git'
    $created = @($created) + @($repoA)

    # re-registering the same path is idempotent (repository state is source of truth)
    $registeredAgain = Register-AihRepository -StoreRoot $store -Path $repoA
    Assert-Aih (-not $registeredAgain.createdRepository -and -not $registeredAgain.createdCheckout) 're-registering the same checkout does not duplicate identities'
    Assert-Aih ($registeredAgain.repository.repositoryId -eq $registeredA.repository.repositoryId) 'repository identity is independent of when it was registered'

    # ── non-Git directory ────────────────────────────────────────────────
    $plain = Join-Path $fixtureRoot 'plain'
    New-Item -ItemType Directory -Path (Join-Path $plain 'lib') -Force | Out-Null
    Set-TestFile (Join-Path $plain 'lib\util.py') 'print("x")'
    $registeredPlain = Register-AihRepository -StoreRoot $store -Path $plain
    Assert-Aih ($registeredPlain.repository.vcs -eq 'none') 'non-Git directory registers with vcs=none'
    Assert-Aih ($registeredPlain.checkout.kind -eq 'non_git') 'non-Git checkout kind is non_git'
    Assert-Aih ($null -eq $registeredPlain.checkout.lastObservation) 'non-Git checkout has no Git observation'
    $created = @($created) + @($plain)

    # ── second checkout of the same logical repository ───────────────────
    $repoA2 = Join-Path $fixtureRoot 'repoA-clone'
    New-Item -ItemType Directory -Path $repoA2 -Force | Out-Null
    Copy-Item -Path (Join-Path $repoA '*') -Destination $repoA2 -Recurse -Force
    $registeredA2 = Register-AihRepository -StoreRoot $store -Path $repoA2
    Assert-Aih ($registeredA2.repository.repositoryId -eq $registeredA.repository.repositoryId) 'second checkout resolves to the same logical repository via normalized remote'
    Assert-Aih ($registeredA2.checkout.kind -eq 'clone') 'second checkout on the same machine is a clone'
    Assert-Aih ($registeredA2.checkout.rootPath -ne $registeredA.checkout.rootPath) 'checkouts keep distinct physical roots'
    $created = @($created) + @($repoA2)

    # ── repository identity must not depend on checkout location ─────────
    $repoA3 = Join-Path $fixtureRoot 'deeply\nested\repoA-copy'
    New-Item -ItemType Directory -Path $repoA3 -Force | Out-Null
    Copy-Item -Path (Join-Path $repoA '*') -Destination $repoA3 -Recurse -Force
    $registeredA3 = Register-AihRepository -StoreRoot $store -Path $repoA3
    Assert-Aih ($registeredA3.repository.repositoryId -eq $registeredA.repository.repositoryId) 'repository identity stays the same from any checkout location'
    $created = @($created) + @($repoA3)

    # ── ambiguous identity prefers a separate repository ─────────────────
    $ambiguous = New-TestGitRepo (Join-Path $fixtureRoot 'ambiguous')
    Set-TestFile (Join-Path $ambiguous 'x.txt') 'x'
    Invoke-TestGit $ambiguous @('add', '.') | Out-Null
    Invoke-TestGit $ambiguous @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    Invoke-TestGit $ambiguous @('remote', 'add', 'origin', $remoteUrl) | Out-Null
    # manufacture a second repository holding the same remote key (explicit identity override)
    $unrelated = Join-Path $fixtureRoot 'unrelated-none'
    New-Item -ItemType Directory -Path $unrelated | Out-Null
    $registeredUnrelated = Register-AihRepository -StoreRoot $store -Path $unrelated
    $null = Set-AihRepositoryRemote -StoreRoot $store -RepositoryId $registeredUnrelated.repository.repositoryId -Url $remoteUrl
    $registeredAmbiguous = Register-AihRepository -StoreRoot $store -Path $ambiguous
    Assert-Aih ($registeredAmbiguous.repository.repositoryId -ne $registeredA.repository.repositoryId) 'ambiguous remote identity creates a separate repository instead of merging'
    $created = @($created) + @($ambiguous); $created = @($created) + @($unrelated)

    # explicit linking remains possible for the human operator
    $moved = Move-AihCheckoutToRepository -StoreRoot $store -CheckoutId $registeredAmbiguous.checkout.checkoutId -RepositoryId $registeredA.repository.repositoryId
    Assert-Aih ($moved.repositoryId -eq $registeredA.repository.repositoryId) 'explicit linking can re-parent a checkout to another repository'

    # ── workspace linking (many-to-many) ─────────────────────────────────
    $ws1 = New-AihWorkspace -StoreRoot $store -Name 'AutoPulse'
    Assert-Aih ($ws1.workspaceId -like 'ws_*') 'workspace uses ws_ prefixed id'
    Assert-Aih ($ws1.slug -eq 'autopulse') 'workspace slug is derived from the name'
    $ws2 = New-AihWorkspace -StoreRoot $store -Name 'Archive'
    $null = Add-AihRepositoryToWorkspace -StoreRoot $store -WorkspaceId $ws1.workspaceId -RepositoryId $registeredA.repository.repositoryId -Role 'backend'
    $null = Add-AihRepositoryToWorkspace -StoreRoot $store -WorkspaceId $ws2.workspaceId -RepositoryId $registeredA.repository.repositoryId
    $links = Get-AihWorkspaceRepositoryList -StoreRoot $store -RepositoryId $registeredA.repository.repositoryId
    Assert-Aih (@($links).Count -eq 2) 'one repository can belong to multiple workspaces'
    $ws1Repos = Get-AihRepositoryList -StoreRoot $store -WorkspaceId $ws1.workspaceId
    Assert-Aih (@($ws1Repos | Where-Object { $_.repositoryId -eq $registeredA.repository.repositoryId }).Count -eq 1) 'workspace lists its linked repository'
    $roleLink = @($links | Where-Object { $_.workspaceId -eq $ws1.workspaceId } | Select-Object -First 1)
    Assert-Aih ($roleLink.role -eq 'backend') 'workspace link keeps an optional role'
    $null = Add-AihRepositoryToWorkspace -StoreRoot $store -WorkspaceId $ws1.workspaceId -RepositoryId $registeredA.repository.repositoryId -Role 'shared'
    $linksAfter = Get-AihWorkspaceRepositoryList -StoreRoot $store -RepositoryId $registeredA.repository.repositoryId
    Assert-Aih (@($linksAfter).Count -eq 2) 're-linking the same pair stays idempotent'
    Assert-Aih ((@($linksAfter | Where-Object { $_.workspaceId -eq $ws1.workspaceId })[0]).role -eq 'shared') 're-linking updates the role without duplicating the link'
    $null = Remove-AihRepositoryFromWorkspace -StoreRoot $store -WorkspaceId $ws2.workspaceId -RepositoryId $registeredA.repository.repositoryId
    Assert-Aih (@(Get-AihWorkspaceRepositoryList -StoreRoot $store -RepositoryId $registeredA.repository.repositoryId).Count -eq 1) 'unlinking removes only the targeted workspace link'

    # ── registry query operations ────────────────────────────────────────
    $all = Get-AihRepositoryList -StoreRoot $store
    Assert-Aih (@($all).Count -ge 3) 'listRepositories returns every registered repository'
    $checkouts = Get-AihCheckoutList -StoreRoot $store -RepositoryId $registeredA.repository.repositoryId
    Assert-Aih (@($checkouts).Count -eq 4) 'listCheckouts returns all checkouts of a repository (three copies plus the explicitly linked one)'
    Assert-Aih ((Get-AihRepository -StoreRoot $store -RepositoryId $registeredA.repository.repositoryId).name -is [string]) 'getRepository returns the repository record'
    Assert-Aih ((Get-AihCheckout -StoreRoot $store -CheckoutId $registeredA2.checkout.checkoutId).rootKey -is [string]) 'getCheckout returns the checkout record'
    Assert-Aih (Remove-AihCheckout -StoreRoot $store -CheckoutId $registeredA3.checkout.checkoutId) 'removeCheckout removes the checkout record'
    Assert-Aih (@(Get-AihCheckoutList -StoreRoot $store -RepositoryId $registeredA.repository.repositoryId).Count -eq 3) 'repository remains registered after checkout removal'

    # ── persistence across Nexus restart (fresh process) ──────────────────
    $freshRepos = Invoke-FreshProcess -StoreRoot $store -Expression "(Get-AihRepositoryList -StoreRoot '$store').Count"
    Assert-Aih ([int]$freshRepos.Trim() -ge 3) 'registered repositories survive a Nexus restart'
    $freshMachine = Invoke-FreshProcess -StoreRoot $store -Expression "(Get-AihMachineIdentity -StoreRoot '$store').machineId"
    Assert-Aih ($freshMachine.Trim() -eq $machine1.machineId) 'machine identity is stable across a Nexus restart (not hardware-derived)'

    # ── Git edge cases (Phase 3.1B) ──────────────────────────────────────
    $git = Get-AihGitProvider
    Assert-Aih ($git.Name -eq 'git-cli') 'default GitProvider implementation is the git CLI adapter'

    # clean repository
    $clean = New-TestGitRepo (Join-Path $fixtureRoot 'clean')
    Set-TestFile (Join-Path $clean 'a.txt') 'a'
    Invoke-TestGit $clean @('add', '.') | Out-Null
    Invoke-TestGit $clean @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    $cleanStatus = @(& $git.GetWorkingTreeStatus $clean)
    Assert-Aih (@($cleanStatus).Count -eq 0) 'clean repository reports an empty working tree status'
    $created = @($created) + @($clean)

    # modified tracked file
    Set-TestFile (Join-Path $clean 'a.txt') 'a2'
    $modifiedStatus = @(& $git.GetWorkingTreeStatus $clean)
    Assert-Aih (@($modifiedStatus).Count -eq 1 -and $modifiedStatus[0].kind -eq 'modified' -and $modifiedStatus[0].path -eq 'a.txt') 'modified tracked file reports kind=modified with normalized relative path'

    # new untracked file
    Set-TestFile (Join-Path $clean 'new.txt') 'n'
    $untrackedStatus = @(& $git.GetWorkingTreeStatus $clean)
    $untrackedEntry = @($untrackedStatus | Where-Object { $_.kind -eq 'untracked' })
    Assert-Aih (@($untrackedEntry).Count -eq 1 -and $untrackedEntry[0].path -eq 'new.txt') 'new untracked file reports kind=untracked'

    # staged file
    Invoke-TestGit $clean @('add', 'new.txt') | Out-Null
    $stagedStatus = @(& $git.GetWorkingTreeStatus $clean)
    $stagedEntry = @($stagedStatus | Where-Object { $_.kind -eq 'staged' })
    Assert-Aih (@($stagedEntry).Count -eq 1 -and $stagedEntry[0].path -eq 'new.txt') 'staged file reports kind=staged'

    # deleted file
    Remove-Item -LiteralPath (Join-Path $clean 'a.txt') -Force
    $deletedStatus = @(& $git.GetWorkingTreeStatus $clean)
    $deletedEntry = @($deletedStatus | Where-Object { $_.kind -eq 'deleted' })
    Assert-Aih (@($deletedEntry).Count -eq 1 -and $deletedEntry[0].path -eq 'a.txt') 'deleted file reports kind=deleted'

    # renamed file (git mv of a committed file; git reports R only when the
    # original path exists in HEAD)
    Set-TestFile (Join-Path $clean 'a.txt') 'a'
    Invoke-TestGit $clean @('add', 'a.txt') | Out-Null
    Invoke-TestGit $clean @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'restore') | Out-Null
    Invoke-TestGit $clean @('mv', 'a.txt', 'renamed.txt') | Out-Null
    $renamedStatus = @(& $git.GetWorkingTreeStatus $clean)
    $renamedEntry = @($renamedStatus | Where-Object { $_.kind -eq 'renamed' })
    Assert-Aih (@($renamedEntry).Count -eq 1) 'renamed file reports kind=renamed'
    Assert-Aih ($renamedEntry[0].oldPath -eq 'a.txt' -and $renamedEntry[0].path -eq 'renamed.txt') 'renamed entries carry oldPath and newPath'
    Invoke-TestGit $clean @('reset', '-q', '--hard') | Out-Null

    # detached HEAD
    $null = & git -C $clean checkout -q --detach HEAD 2>$null
    Assert-Aih ($null -eq (& $git.GetBranch $clean)) 'detached HEAD reports no branch name'
    Assert-Aih (& $git.IsDetachedHead $clean) 'detached HEAD is detected explicitly'
    Assert-Aih ($null -ne (& $git.GetHeadSha $clean)) 'detached HEAD still resolves a commit sha'
    Invoke-TestGit $clean @('checkout', '-q', '@{-1}') | Out-Null

    # repository without remote (no origin assumption)
    $noRemote = New-TestGitRepo (Join-Path $fixtureRoot 'noremote')
    Set-TestFile (Join-Path $noRemote 'b.txt') 'b'
    Invoke-TestGit $noRemote @('add', '.') | Out-Null
    Invoke-TestGit $noRemote @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    Assert-Aih ($null -eq (& $git.GetRemote $noRemote)) 'repository without remote resolves no remote (no origin assumption)'
    Assert-Aih ($null -ne (& $git.GetDefaultBranch $noRemote)) 'default branch falls back to an existing local branch'
    $created = @($created) + @($noRemote)

    # tracked files list
    $tracked = @(& $git.GetTrackedFiles $noRemote)
    Assert-Aih (@($tracked).Count -eq 1 -and $tracked[0] -eq 'b.txt') 'tracked file listing uses repository-relative POSIX paths'

    # Git worktree
    $worktreePath = Join-Path $fixtureRoot 'worktree-linked'
    Invoke-TestGit $noRemote @('worktree', 'add', '-q', $worktreePath, '-b', 'linked-branch') | Out-Null
    $worktreeInfo = & $git.DetectWorktree $worktreePath
    Assert-Aih ($worktreeInfo.isWorktree) 'linked Git worktree is detected'
    $registeredWorktree = Register-AihRepository -StoreRoot $store -Path $worktreePath
    Assert-Aih ($registeredWorktree.checkout.kind -eq 'worktree') 'worktree checkout is registered with kind=worktree'
    $created = @($created) + @($worktreePath)

    # events for registration lifecycle
    $eventTypes = @((Get-AihIntEvents -StoreRoot $store) | ForEach-Object { $_.type } | Sort-Object -Unique)
    Assert-Aih ($eventTypes -contains 'repository.registered') 'repository.registered event is recorded'
    Assert-Aih ($eventTypes -contains 'checkout.registered') 'checkout.registered event is recorded'

    Write-Host ("Registry/Git acceptance: $passed assertions passed.")
} finally {
    if ($store) { Remove-Item -LiteralPath $store -Recurse -Force -ErrorAction SilentlyContinue }
    if ($fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
