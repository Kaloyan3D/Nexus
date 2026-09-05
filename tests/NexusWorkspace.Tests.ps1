[CmdletBinding()]param([string]$InstallRoot = 'C:\AI-Harness')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Workspace.ps1')

$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-Fixture([string]$Name) { $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-nexus-$Name-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $path -Force | Out-Null; $path }
function Invoke-TestGit([string]$Root, [string[]]$Arguments) { & git -C $Root @Arguments 2>$null; if ($LASTEXITCODE -ne 0) { throw "git failed: $($Arguments -join ' ')" } }

$fixture = New-Fixture 'workspace'
$store = Join-Path $fixture 'store'
try {
    $repoA = Join-Path $fixture 'RepoA'
    $repoB = Join-Path $fixture 'RepoB'
    $repoC = Join-Path $fixture 'RepoC'
    foreach ($repo in @($repoA, $repoB, $repoC)) {
        New-Item -ItemType Directory -Path $repo -Force | Out-Null
        Invoke-TestGit $repo @('init', '-q')
        [IO.File]::WriteAllText((Join-Path $repo 'identity.txt'), $repo, [Text.UTF8Encoding]::new($false))
        Invoke-TestGit $repo @('add', '.')
        Invoke-TestGit $repo @('-c', 'user.name=nexus-test', '-c', 'user.email=nexus@test.invalid', 'commit', '-q', '-m', 'init')
    }

    $a = Resolve-AihNexusWorkspaceIdentity -StoreRoot $store -Path $repoA
    $b = Resolve-AihNexusWorkspaceIdentity -StoreRoot $store -Path $repoB
    $aAgain = Resolve-AihNexusWorkspaceIdentity -StoreRoot $store -Path ($repoA + '\')
    $c = Resolve-AihNexusWorkspaceIdentity -StoreRoot $store -Path $repoC
    Assert-Aih ($a.executionRoot -eq [IO.Path]::GetFullPath($repoA)) 'A resolves to its explicit execution root'
    Assert-Aih ($b.executionRoot -eq [IO.Path]::GetFullPath($repoB)) 'A to B selection resolves B, not launch cwd A'
    Assert-Aih ($aAgain.checkoutId -eq $a.checkoutId -and $aAgain.workspaceId -eq $a.workspaceId) 'B to A selection reuses stable Phase 3.1 identity'
    Assert-Aih ($c.checkoutId -ne $a.checkoutId -and $c.checkoutId -ne $b.checkoutId) 'A to B to C keeps distinct checkout identities'
    Assert-Aih (Test-AihNexusWorkspaceIdentity -StoreRoot $store -Identity $a -ExecutionRoot $repoA) 'existing A session validates after later selections'
    Assert-Aih (Test-AihNexusWorkspaceIdentity -StoreRoot $store -Identity $b -ExecutionRoot $repoB) 'existing B session validates concurrently with A'

    $mismatchClosed = $false
    try { Test-AihNexusWorkspaceIdentity -StoreRoot $store -Identity $a -ExecutionRoot $repoB | Out-Null } catch { $mismatchClosed = $_.Exception.Message -match 'mismatch' }
    Assert-Aih $mismatchClosed 'identity mismatch fails closed before execution'

    $nonGit = Join-Path $fixture 'Notes'
    New-Item -ItemType Directory -Path $nonGit | Out-Null
    $nonGitIdentity = Resolve-AihNexusWorkspaceIdentity -StoreRoot $store -Path $nonGit
    Assert-Aih ($nonGitIdentity.vcs -eq 'none' -and $nonGitIdentity.checkoutKind -eq 'non_git') 'non-Git folders are supported through non_git checkouts'

    $subdir = Join-Path $repoA 'app'
    New-Item -ItemType Directory -Path $subdir | Out-Null
    $subdirIdentity = Resolve-AihNexusWorkspaceIdentity -StoreRoot $store -Path $subdir
    Assert-Aih ($subdirIdentity.checkoutId -eq $a.checkoutId -and $subdirIdentity.executionRoot -eq [IO.Path]::GetFullPath($subdir)) 'Git subdirectory keeps checkout identity and explicit execution root'

    $worktree = Join-Path $fixture 'RepoA-worktree'
    Invoke-TestGit $repoA @('worktree', 'add', '-q', '-b', 'nexus-worktree', $worktree)
    $worktreeIdentity = Resolve-AihNexusWorkspaceIdentity -StoreRoot $store -Path $worktree
    Assert-Aih ($worktreeIdentity.checkoutKind -eq 'worktree') 'Git worktrees retain worktree checkout identity'

    Remove-Item -LiteralPath $repoC -Recurse -Force
    $unavailableClosed = $false
    try { Test-AihNexusWorkspaceIdentity -StoreRoot $store -Identity $c -ExecutionRoot $repoC | Out-Null } catch { $unavailableClosed = $_.Exception.Message -match 'does not exist|unavailable' }
    Assert-Aih $unavailableClosed 'deleted checkout fails closed on session reopen'

    $bareUrl = Get-AihNexusOpenUrl -BaseUrl 'http://127.0.0.1:3080'
    $explicitUrl = Get-AihNexusOpenUrl -BaseUrl 'http://127.0.0.1:3080/' -ExecutionRoot $repoA
    Assert-Aih ($bareUrl -eq 'http://127.0.0.1:3080') 'bare aih -Open has no implicit project handoff'
    Assert-Aih ($explicitUrl -match '^http://127\.0\.0\.1:3080/\?nexus-open=' -and [Uri]::UnescapeDataString(($explicitUrl -split '=', 2)[1]) -eq [IO.Path]::GetFullPath($repoA)) 'explicit path open carries one URL-scoped workspace handoff'
    Assert-Aih (Test-AihReusableUniversalRuntimeState -State ([pscustomobject]@{ SchemaVersion = 4; Workspace = $null })) 'already-running universal Nexus is reused across project requests'
    Assert-Aih (-not (Test-AihReusableUniversalRuntimeState -State ([pscustomobject]@{ SchemaVersion = 3; Workspace = $repoA }))) 'legacy project-bound runtime is upgraded instead of reused'
    Assert-Aih (-not (Test-AihReusableUniversalRuntimeState -State ([pscustomobject]@{ SchemaVersion = 4 }) -Restart)) 'explicit restart bypasses runtime reuse'

    Write-Host "Nexus workspace acceptance: $passed assertions passed."
}
finally {
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue }
}
