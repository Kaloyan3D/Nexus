[CmdletBinding()]param([string]$InstallRoot = 'C:\AI-Harness')
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts\Common.ps1')
. (Join-Path $InstallRoot 'scripts\Intelligence.ps1')

# ── Phase 3.2A: code intelligence foundation acceptance tests ────────────────
# Includes hardening Fix 3 ID-semantics invariants.
$passed = 0
$nl = [string][char]10
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-Fixture([string]$Name) { $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-cf-$Name-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $path -Force | Out-Null; $path }
function Set-TestFile([string]$Path, [string]$Content) { $parent = Split-Path -Parent $Path; if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }; Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 }
function Invoke-TestGit([string]$Path, [string[]]$GitArguments) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & git -C $Path @GitArguments 2>&1; if ($LASTEXITCODE -ne 0) { throw ("git failed: " + ($GitArguments -join ' ')) }; return $output }
    finally { $ErrorActionPreference = $previousEap }
}

$store = New-Fixture store
$fixtureRoot = New-Fixture repos
try {
    # ── language detection ────────────────────────────────────────────────
    $d1 = Get-AihLanguageDetection -RelativePath 'src/app/Service.ts'
    $d2 = Get-AihLanguageDetection -RelativePath 'scripts/build.ps1'
    $d3 = Get-AihLanguageDetection -RelativePath 'tools/run' -FirstLine '#!/usr/bin/env python3'
    $d4 = Get-AihLanguageDetection -RelativePath 'README.md'
    $d5 = Get-AihLanguageDetection -RelativePath 'data/blob.xyz'
    Assert-Aih ($null -ne $d1 -and $d1.language -eq 'typescript' -and $d1.evidence -eq 'extension') 'typescript detected by extension'
    Assert-Aih ($d2.language -eq 'powershell') 'powershell detected by extension'
    Assert-Aih ($null -ne $d3 -and $d3.language -eq 'python' -and $d3.evidence -eq 'shebang') 'extensionless script detected by shebang'
    Assert-Aih ($d4.language -eq 'markdown') 'markdown detected by extension'
    Assert-Aih ($null -eq $d5) 'unknown extension yields no detection (honest unsupported)'
    Register-AihLanguage -CanonicalName 'kotlin' -Extensions @('.kt') -Aliases @('kts')
    $d6 = Get-AihLanguageDetection -RelativePath 'lib/Main.kt'
    Assert-Aih ($d6.language -eq 'kotlin') 'third-party language registration is honored'

    # ── content-addressed store unit behavior ─────────────────────────────
    Reset-AihCodeIntelligenceStore
    $codeStore = New-AihContentAddressedCodeStore -StoreRoot $store
    Set-AihCodeIntelligenceStore -Store $codeStore
    $doc1 = New-AihFileIntelligenceDocument -ContentHash 'sha256:aaa' -Language 'typescript' -ProviderId 'structural-ts' -ProviderVersion '1.0.0' -Status 'ready'
    $null = (& $codeStore.PutFileIntelligence $doc1)
    $doc2 = New-AihFileIntelligenceDocument -ContentHash 'sha256:aaa' -Language 'typescript' -ProviderId 'structural-ts' -ProviderVersion '1.0.0' -Status 'ready'
    $null = (& $codeStore.PutFileIntelligence $doc2)
    Assert-Aih ((& $codeStore.CountFileIntelligence) -eq 1) 'identical (hash, provider, version) writes one document, not two'
    Assert-Aih ($doc1.fileIntelligenceId -eq $doc2.fileIntelligenceId) 'file intelligence id is identity-derived and stable'
    $doc3 = New-AihFileIntelligenceDocument -ContentHash 'sha256:bbb' -Language 'typescript' -ProviderId 'structural-ts' -ProviderVersion '1.0.0' -Status 'ready'
    $null = (& $codeStore.PutFileIntelligence $doc3)
    Assert-Aih ((& $codeStore.CountFileIntelligence) -eq 2 -and $doc3.fileIntelligenceId -ne $doc1.fileIntelligenceId) 'different content hash produces a new document without touching the old one'
    $doc4 = New-AihFileIntelligenceDocument -ContentHash 'sha256:aaa' -Language 'typescript' -ProviderId 'structural-ts' -ProviderVersion '9.9.9' -Status 'ready'
    Assert-Aih ($doc4.fileIntelligenceId -ne $doc1.fileIntelligenceId) 'parser/provider version participates in file intelligence identity'
    Assert-Aih ((& $codeStore.GetFileIntelligence 'sha256:aaa' 'structural-ts' '1.0.0').fileIntelligenceId -eq $doc1.fileIntelligenceId) 'store lookup by (hash, provider, version)'

    # ── Fix 3 ID invariants ───────────────────────────────────────────────
    $sidA = (New-AihParsedSymbol -FileIntelligenceId $doc1.fileIntelligenceId -Kind 'class' -Name 'AuthService' -QualifiedName 'AuthService' -Signature 'class AuthService').sid
    $sidB = (New-AihParsedSymbol -FileIntelligenceId $doc1.fileIntelligenceId -Kind 'class' -Name 'AuthService' -QualifiedName 'AuthService' -Signature 'class AuthService').sid
    $sidC = (New-AihParsedSymbol -FileIntelligenceId $doc3.fileIntelligenceId -Kind 'class' -Name 'AuthService' -QualifiedName 'AuthService' -Signature 'class AuthService').sid
    Assert-Aih ($sidA -eq $sidB) 'symbol id is deterministic for identical inputs'
    Assert-Aih ($sidA -ne $sidC) 'same symbol name in different content is a different symbol record (identity-derived, not global)'
    $occA = (New-AihParsedOccurrence -FileIntelligenceId $doc1.fileIntelligenceId -Role 'reference' -Name 'AuthService' -Line 10 -Column 5).oid
    $occB = (New-AihParsedOccurrence -FileIntelligenceId $doc1.fileIntelligenceId -Role 'reference' -Name 'AuthService' -Line 10 -Column 5).oid
    $occC = (New-AihParsedOccurrence -FileIntelligenceId $doc1.fileIntelligenceId -Role 'reference' -Name 'AuthService' -Line 11 -Column 5).oid
    Assert-Aih ($occA -eq $occB -and $occA -ne $occC) 'occurrence id is deterministic and position-sensitive'
    $hash1 = (Get-AihCodeIntelligenceId -ContentHash 'sha256:aaa' -ProviderId 'structural-ts' -ProviderVersion '1.0.0')
    Assert-Aih ($hash1 -ne $sidA) 'state/file-intelligence identity spaces are distinct (stateHash is not a record id)'

    # ── end-to-end foundation: two snapshots, one file change ─────────────
    # (the content-addressed store configured above stays active; the code
    # intelligence store is process-global by design, like a DI container)
    $repoPath = Join-Path $fixtureRoot 'tsrepo'
    New-Item -ItemType Directory -Path $repoPath -Force | Out-Null
    Invoke-TestGit $repoPath @('init', '-q') | Out-Null
    Set-TestFile (Join-Path $repoPath 'auth.ts') (@('export class AuthService {', '  login(user: string) {', '    return user;', '  }', '}') -join $nl)
    Set-TestFile (Join-Path $repoPath 'app.ts') (@("import { AuthService } from './auth';", 'export const app = new AuthService();') -join $nl)
    Invoke-TestGit $repoPath @('add', '.') | Out-Null
    Invoke-TestGit $repoPath @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    $registered = Register-AihRepository -StoreRoot $store -Path $repoPath
    $checkoutId = $registered.checkout.checkoutId
    $repositoryId = $registered.repository.repositoryId

    $buildA = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $stateA = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId
    Assert-Aih ($stateA.status -eq 'ready') 'snapshot A intelligence activates ready'
    Assert-Aih ($stateA.stats.indexed -eq 2) 'snapshot A indexes both source files'
    Assert-Aih ($stateA.stats.symbols -ge 2) 'snapshot A extracts class and call evidence'

    # one-file change: exactly one new FI document, one reuse
    $fiCountBefore = (& (Get-AihCodeIntelligenceStore).CountFileIntelligence)
    Set-TestFile (Join-Path $repoPath 'app.ts') (@("import { AuthService } from './auth';", 'export const app2 = new AuthService();') -join $nl)
    Invoke-TestGit $repoPath @('add', '.') | Out-Null
    Invoke-TestGit $repoPath @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'touch app.ts') | Out-Null
    $buildB = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $stateB = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildB.snapshot.snapshotId
    $fiCountAfter = (& (Get-AihCodeIntelligenceStore).CountFileIntelligence)
    Assert-Aih ($stateB.status -eq 'ready') 'snapshot B intelligence activates ready'
    Assert-Aih ($stateB.stats.reused -eq 1 -and $stateB.stats.indexed -eq 1) 'one-file change reuses exactly one file and indexes exactly one'
    Assert-Aih ($fiCountAfter -eq $fiCountBefore + 1) 'one-file change writes exactly ONE new store document (no whole-store rewrite)'

    # cross-snapshot symbol lookup + identity semantics
    $defsA = @(Find-AihCodeDefinitions -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId -Name 'AuthService')
    $defsB = @(Find-AihCodeDefinitions -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildB.snapshot.snapshotId -Name 'AuthService')
    Assert-Aih ($defsA.Count -eq 1 -and $defsB.Count -eq 1) 'AuthService is findable by definition in both snapshots'
    Assert-Aih ($defsA[0].sid -eq $defsB[0].sid) 'unchanged content keeps the same symbol id across snapshots'
    Assert-Aih ($defsA[0].path -eq 'auth.ts' -and $defsB[0].path -eq 'auth.ts') 'definition rows carry their snapshot-scoped path'
    $refsB = @(Find-AihCodeReferences -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildB.snapshot.snapshotId -Name 'AuthService')
    $importRefs = @($refsB | Where-Object { $_.role -eq 'import' })
    Assert-Aih ($importRefs.Count -eq 1 -and $importRefs[0].resolution -eq 'name-binding') 'import binding is recorded as a name-binding reference (not fake cross-file resolution)'
    $historyState = Get-AihSnapshotIntelligence -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId
    Assert-Aih ($null -ne $historyState -and $historyState.stats.filesConsidered -eq 2) 'historical snapshot intelligence state remains queryable'

    # idempotent re-index returns the activated state
    $again = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildB.snapshot.snapshotId
    Assert-Aih ($again.completedAt -eq $stateB.completedAt) 're-indexing an activated snapshot is idempotent'

    # provider version invalidation
    $providers = @(Get-AihCodeIntelligenceProviders)
    $bumped = @()
    foreach ($p in $providers) {
        $bumped = @($bumped) + @([pscustomobject][ordered]@{ providerId = $p.providerId; version = '2.0.0'; languages = $p.languages; capabilities = $p.capabilities; canHandle = $p.canHandle; analyze = $p.analyze })
    }
    Set-AihCodeIntelligenceProviders -Providers $bumped
    Set-TestFile (Join-Path $repoPath 'extra.ts') 'export const extra = 1;'
    Invoke-TestGit $repoPath @('add', '.') | Out-Null
    Invoke-TestGit $repoPath @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'extra') | Out-Null
    $buildC = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $stateC = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildC.snapshot.snapshotId
    Set-AihCodeIntelligenceProviders -Providers $providers
    Assert-Aih ($stateC.stats.indexed -eq 3 -and $stateC.stats.reused -eq 0) 'parser version bump invalidates the cache and re-parses all files'
    Assert-Aih ($stateC.storeName -eq 'content-addressed-v1') 'index state records the store implementation name'

    # replaceable store seam
    $writes = 0
    $stub = [pscustomobject][ordered]@{ Name = 'stub-v1' }
    $stub | Add-Member -NotePropertyName GetFileIntelligence -NotePropertyValue { param($h, $p, $v) return $null }
    $stub | Add-Member -NotePropertyName GetFileIntelligenceById -NotePropertyValue { param($id) return $null }
    $stub | Add-Member -NotePropertyName PutFileIntelligence -NotePropertyValue { param($d) $script:writes = $script:writes + 1; return $d }
    $stub | Add-Member -NotePropertyName CountFileIntelligence -NotePropertyValue { return 0 }
    $stub | Add-Member -NotePropertyName ContainsFileIntelligence -NotePropertyValue { param($id) return $false }
    $stub | Add-Member -NotePropertyName DeleteSnapshotIntelligence -NotePropertyValue { param($r, $s) return $true }
    $stub | Add-Member -NotePropertyName PutSnapshotState -NotePropertyValue { param($r, $s, $st) return $st }
    $stub | Add-Member -NotePropertyName GetSnapshotState -NotePropertyValue { param($r, $s) return $null }
    $stub | Add-Member -NotePropertyName AppendSnapshotRows -NotePropertyValue { param($r, $s, $f, $rows) }
    $stub | Add-Member -NotePropertyName ReadSnapshotRows -NotePropertyValue { param($r, $s, $f) return @() }
    $stub | Add-Member -NotePropertyName SnapshotIntelligenceDir -NotePropertyValue { param($r, $s) return (Join-Path $env:TEMP 'stub') }
    Set-AihCodeIntelligenceStore -Store $stub
    $stateD = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildC.snapshot.snapshotId -Force
    Set-AihCodeIntelligenceStore -Store $codeStore
    Assert-Aih ($stateD.storeName -eq 'stub-v1' -and $script:writes -gt 0) 'alternate store implementation received intelligence writes (replaceable seam)'

    Write-Host ("Code-intelligence foundation: $passed assertions passed.")
} finally {
    Reset-AihCodeIntelligenceStore
    Set-AihCodeIntelligenceProviders -Providers @()
    Reset-AihCodeIntelligenceStore
    if ($store) { Remove-Item -LiteralPath $store -Recurse -Force -ErrorAction SilentlyContinue }
    if ($fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
