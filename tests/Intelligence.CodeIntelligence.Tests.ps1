[CmdletBinding()]param([string]$InstallRoot = 'C:\AI-Harness')
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts\Common.ps1')
. (Join-Path $InstallRoot 'scripts\Intelligence.ps1')

# ── Phase 3.2E/F: end-to-end DoD scenario (17 steps) ────────────────────────
$passed = 0
$nl = [string][char]10
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-Fixture([string]$Name) { $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-e2e-$Name-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $path -Force | Out-Null; $path }
function Set-TestFile([string]$Path, [string]$Content) { $parent = Split-Path -Parent $Path; if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }; Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 }
function Invoke-TestGit([string]$Path, [string[]]$GitArguments) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & git -C $Path @GitArguments 2>&1; if ($LASTEXITCODE -ne 0) { throw ("git failed: " + ($GitArguments -join ' ')) }; return $output }
    finally { $ErrorActionPreference = $previousEap }
}

$store = New-Fixture store
$fixtureRoot = New-Fixture repos
$events = @{ started = 0; indexed = 0; reused = 0; failed = 0; ready = 0 }
$sub1 = Subscribe-AihIntEvent -EventTypePattern 'intelligence.index.started' -Handler { param($record) $script:events.started = $script:events.started + 1 }
$sub2 = Subscribe-AihIntEvent -EventTypePattern 'intelligence.file.indexed' -Handler { param($record) $script:events.indexed = $script:events.indexed + 1 }
$sub3 = Subscribe-AihIntEvent -EventTypePattern 'intelligence.file.reused' -Handler { param($record) $script:events.reused = $script:events.reused + 1 }
$sub4 = Subscribe-AihIntEvent -EventTypePattern 'intelligence.file.failed' -Handler { param($record) $script:events.failed = $script:events.failed + 1 }
$sub5 = Subscribe-AihIntEvent -EventTypePattern 'intelligence.snapshot.ready' -Handler { param($record) $script:events.ready = $script:events.ready + 1 }
$repo = $null; $repoCopy = $null
try {
    # ── fixture: small TypeScript service repo ────────────────────────────
    $repo = Join-Path $fixtureRoot 'svc'
    New-Item -ItemType Directory -Path $repo -Force | Out-Null
    Invoke-TestGit $repo @('init', '-q') | Out-Null
    Set-TestFile (Join-Path $repo 'package.json') '{"name":"svc","version":"1.0.0"}'
    Set-TestFile (Join-Path $repo 'auth.ts') (@('export class AuthService {', '  constructor(private tokens: TokenStore) {}', '  login(user: string) {', '    return this.tokens.issue(user);', '  }', '}') -join $nl)
    Set-TestFile (Join-Path $repo 'tokens.ts') (@('export class TokenStore {', '  issue(user: string) {', '    return user + "-token";', '  }', '}') -join $nl)
    Set-TestFile (Join-Path $repo 'app.ts') (@("import { AuthService } from './auth';", "import { TokenStore } from './tokens';", 'export const boot = () => {', '  const store = new TokenStore();', '  const service = new AuthService(store);', '  return service.login("ada");', '};') -join $nl)
    Set-TestFile (Join-Path $repo 'notes.txt') 'plain text notes'
    Set-TestFile (Join-Path $repo 'unknown.xyz') 'mystery format'
    Invoke-TestGit $repo @('add', '.') | Out-Null
    Invoke-TestGit $repo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null

    # (1) register repository
    $registered = Register-AihRepository -StoreRoot $store -Path $repo
    $repositoryId = $registered.repository.repositoryId
    $checkoutId = $registered.checkout.checkoutId
    Assert-Aih ($repositoryId -like 'repo_*' -and $checkoutId -like 'checkout_*') 'step 1: repository and checkout registered with prefixed ids'

    # (2) snapshot A
    $buildA = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    Assert-Aih ($buildA.snapshot.status -eq 'ready') 'step 2: snapshot A built'

    # (3) index A
    $stateA = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId
    Assert-Aih ($stateA.status -eq 'ready') 'step 3: snapshot A indexed ready'

    # (4) where is AuthService defined?
    $defs = @(Find-AihCodeDefinitions -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId -Name 'AuthService')
    Assert-Aih ($defs.Count -eq 1 -and $defs[0].path -eq 'auth.ts' -and $defs[0].startLine -eq 1) 'step 4: Where is AuthService defined? -> auth.ts:1'

    # (5) what references AuthService?
    $refs = @(Find-AihCodeReferences -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId -Name 'AuthService')
    $importRef = @($refs | Where-Object { $_.role -eq 'import' -and $_.path -eq 'app.ts' })
    Assert-Aih ($importRef.Count -eq 1 -and $importRef[0].resolution -eq 'name-binding') 'step 5: references include the app.ts import binding with honest resolution'

    # (6) file symbols + (7) imports/exports
    $appSymbols = @(Get-AihFileCodeSymbols -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId -Path 'app.ts')
    Assert-Aih ($appSymbols.Count -ge 1) 'step 6: GetFileSymbols returns symbols for app.ts'
    $authImports = @(Get-AihFileCodeImports -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId -Path 'app.ts')
    Assert-Aih ($authImports.Count -eq 2 -and $authImports[0].rawTarget -eq './auth') 'step 7: GetFileImports returns raw targets verbatim'
    $authExports = @(Get-AihFileCodeExports -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId -Path 'auth.ts')
    Assert-Aih ($authExports.Count -ge 1 -and (@($authExports | Where-Object { $_.name -eq 'AuthService' })).Count -eq 1) 'step 7b: GetFileExports lists AuthService'

    # (8) unsupported language handled honestly
    $mappingRowsA = @((& (Get-AihCodeIntelligenceStore -StoreRoot $store).ReadSnapshotRows $repositoryId $buildA.snapshot.snapshotId 'mapping.jsonl') | Where-Object { $_.status -eq 'unsupported' })
    $unsupportedRow = @($mappingRowsA | Where-Object { $_.path -eq 'unknown.xyz' })
    Assert-Aih ($unsupportedRow.Count -eq 1) 'step 8: unknown extension recorded as unsupported, not guessed'
    $textRow = @($mappingRowsA | Where-Object { $_.path -eq 'notes.txt' })
    Assert-Aih ($textRow.Count -eq 1) 'step 8b: unregistered but known-text files are honestly unsupported too'

    # (9) one-file modify -> build B -> incremental index
    Set-TestFile (Join-Path $repo 'tokens.ts') (@('export class TokenStore {', '  issue(user: string, ttl: number) {', '    return user + "-token-" + ttl;', '  }', '}') -join $nl)
    Invoke-TestGit $repo @('add', '.') | Out-Null
    Invoke-TestGit $repo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'change tokens') | Out-Null
    $buildB = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $stateB = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildB.snapshot.snapshotId
    foreach ($dbgRow in @((& (Get-AihCodeIntelligenceStore -StoreRoot $store).ReadSnapshotRows $repositoryId $buildB.snapshot.snapshotId 'mapping.jsonl'))) { Write-Host ("STEP9-ROW " + $dbgRow.path + " reused=" + $dbgRow.reused + " status=" + $dbgRow.status + " hash=" + ([string]$dbgRow.contentHash).Substring(0, [Math]::Min(18, ([string]$dbgRow.contentHash).Length))) }
    Write-Host ("STEP9-STATS indexed=" + $stateB.stats.indexed + " reused=" + $stateB.stats.reused + " root=" + [string](Get-AihCodeIntelligenceStore -StoreRoot $store).Root)
    foreach ($dbgRowA in @((& (Get-AihCodeIntelligenceStore -StoreRoot $store).ReadSnapshotRows $repositoryId $buildA.snapshot.snapshotId 'mapping.jsonl'))) { Write-Host ("STEP9-AROW " + $dbgRowA.path + " hash=" + ([string]$dbgRowA.contentHash).Substring(0, [Math]::Min(18, ([string]$dbgRowA.contentHash).Length))) }
    Assert-Aih ($stateB.stats.reused -eq 2 -and $stateB.stats.indexed -eq 1) 'step 9: one-file change reuses two files and indexes exactly one'
    Assert-Aih ($stateB.status -eq 'ready') 'step 9b: snapshot B ready'

    # (10) snapshot diff
    $diff = Get-AihSnapshotIntelligenceDiff -StoreRoot $store -RepositoryId $repositoryId -FromSnapshotId $buildA.snapshot.snapshotId -ToSnapshotId $buildB.snapshot.snapshotId
    Assert-Aih (@($diff.files.changed) -contains 'tokens.ts' -and @($diff.files.unchanged).Count -eq 5) 'step 10: diff reports exactly the changed file'
    Assert-Aih (@($diff.symbols.changed) -contains 'method|TokenStore.issue') 'step 10b: diff reports the changed method signature'
    Assert-Aih (@($diff.symbols.unchanged) -contains 'class|AuthService') 'step 10c: diff reports AuthService unchanged'

    # (11) historical intelligence still queryable
    $defsA2 = @(Find-AihCodeDefinitions -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId -Name 'TokenStore')
    $defsB2 = @(Find-AihCodeDefinitions -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildB.snapshot.snapshotId -Name 'TokenStore')
    $issueA = @(Find-AihCodeSymbols -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId -Name 'issue')
    $issueB = @(Find-AihCodeSymbols -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildB.snapshot.snapshotId -Name 'issue')
    Assert-Aih ($defsA2.Count -eq 1 -and $defsB2.Count -eq 1 -and $issueA.Count -eq 1 -and $issueB.Count -eq 1 -and $issueA[0].signature -ne $issueB[0].signature) 'step 11: both snapshot versions of TokenStore.issue remain queryable (history preserved)'

    # (12) second checkout of the same content -> full reuse
    $repoCopy = Join-Path $fixtureRoot 'svc2'
    Copy-Item -Path $repo -Destination $repoCopy -Recurse
    $registered2 = Register-AihRepository -StoreRoot $store -Path $repoCopy
    $buildC = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $registered2.checkout.checkoutId
    $stateC = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $registered2.repository.repositoryId -SnapshotId $buildC.snapshot.snapshotId
    Assert-Aih ($stateC.stats.reused -eq 3 -and $stateC.stats.indexed -eq 0) 'step 12: second checkout reuses all content-addressed intelligence (zero re-parse)'
    $storeCountC = (& (Get-AihCodeIntelligenceStore -StoreRoot $store).CountFileIntelligence)
    Assert-Aih ($storeCountC -eq 4) 'step 12b: cross-checkout reuse wrote no new store documents'

    # (13) restart persistence: fresh process answers queries without reindexing
    $probe = Join-Path $fixtureRoot 'probe.ps1'
    $probeBody = @(
        'param([string]$Store, [string]$RepoId, [string]$SnapId)',
        '. ''C:\AI-Harness\scripts\Common.ps1''',
        '. ''C:\AI-Harness\scripts\Intelligence.ps1''',
        '$defs = @(Find-AihCodeDefinitions -StoreRoot $Store -RepositoryId $RepoId -SnapshotId $SnapId -Name ''AuthService'')',
        'if ($defs.Count -eq 1 -and $defs[0].path -eq ''auth.ts'') { Write-Output ''PERSIST-OK'' } else { Write-Output ''PERSIST-FAIL''; exit 1 }'
    ) -join $nl
    Set-TestFile $probe $probeBody
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $probeOut = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $probe $store $repositoryId $buildB.snapshot.snapshotId } finally { $ErrorActionPreference = $previousEap }
    Assert-Aih ((@($probeOut) -join ' ').Contains('PERSIST-OK')) 'step 13: fresh process answers definition queries from persisted intelligence'

    # (14) status/diagnostics text
    $status = Get-AihCodeIntelligenceStatus -StoreRoot $store -RepositoryId $registered2.repository.repositoryId -SnapshotId $buildC.snapshot.snapshotId
    Assert-Aih ("$($status.text)".Contains('Code intelligence status: ready') -and "$($status.text)".Contains('Reused: 3')) 'step 14: status text renders counts and readiness'

    # (15) events fired
    Assert-Aih ($events.started -ge 3 -and $events.indexed -ge 4 -and $events.reused -ge 4 -and $events.ready -ge 3 -and $events.failed -eq 0) 'step 15: intelligence.* lifecycle events fired (started/indexed/reused/ready)'
    $journalPath = (Get-AihIntelligenceLayout $store).Events
    Assert-Aih (Test-Path -LiteralPath $journalPath) 'step 15b: events are journaled to disk'

    # (16) provider isolation: a crashing provider must not corrupt the snapshot
    $originalProviders = @(Get-AihCodeIntelligenceProviders)
    $crashing = @([pscustomobject][ordered]@{ providerId = 'crashing-ts'; version = '0.0.1'; languages = @('typescript'); capabilities = @('syntax'); canHandle = { param($language) $language -eq 'typescript' }.GetNewClosure(); analyze = { param($content, $language, $fileIntelligenceId, $moduleName) throw 'simulated provider crash' } })
    Set-AihCodeIntelligenceProviders -Providers ($crashing + $originalProviders)
    Set-TestFile (Join-Path $repo 'app.ts') (@("import { AuthService } from './auth';", 'export const boot2 = () => {', '  const store = new TokenStore();', '  const service = new AuthService(store);', '  return service.login("grace");', '};') -join $nl)
    Invoke-TestGit $repo @('add', '.') | Out-Null
    Invoke-TestGit $repo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'trigger crash provider') | Out-Null
    $buildD = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $stateD = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildD.snapshot.snapshotId
    Set-AihCodeIntelligenceProviders -Providers $originalProviders
    Assert-Aih ($stateD.status -eq 'ready_with_failures') 'step 16: crashing provider yields ready_with_failures (isolated failure)'
    Assert-Aih ($stateD.stats.failed -eq 3 -and $stateD.stats.reused -eq 0 -and $stateD.stats.unsupported -eq 3) 'step 16b: provider swap re-analyzes all TS files under the crashing provider; non-TS files unaffected'
    Assert-Aih ($events.failed -ge 1) 'step 16c: intelligence.file.failed events emitted for provider crashes'

    # (17) five repository kinds, one code path, no repo-specific logic
    $kinds = @(
        @{ name = 'k-ts'; file = 'src/index.ts'; content = 'export class Kernel { start() { return 1; } }' },
        @{ name = 'k-cs'; file = 'src/Kernel.cs'; content = (@('namespace K {', '  public class Kernel {', '    public void Start() { }', '  }', '}') -join $nl) },
        @{ name = 'k-py'; file = 'kernel.py'; content = (@('class Kernel:', '    def start(self):', '        return 1') -join $nl) },
        @{ name = 'k-ps'; file = 'kernel.ps1'; content = (@('function Start-Kernel {', '    return 1', '}') -join $nl) },
        @{ name = 'k-js'; file = 'src/index.js'; content = 'export function boot() { return 2; }' }
    )
    $kindResults = @{}
    foreach ($kind in $kinds) {
        $kindRepo = Join-Path $fixtureRoot $kind.name
        New-Item -ItemType Directory -Path (Split-Path -Parent (Join-Path $kindRepo $kind.file)) -Force | Out-Null
        Set-TestFile (Join-Path $kindRepo $kind.file) $kind.content
        Invoke-TestGit $kindRepo @('init', '-q') | Out-Null
        Invoke-TestGit $kindRepo @('add', '.') | Out-Null
        Invoke-TestGit $kindRepo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
        $reg = Register-AihRepository -StoreRoot $store -Path $kindRepo
        $snap = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $reg.checkout.checkoutId
        $st = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $reg.repository.repositoryId -SnapshotId $snap.snapshot.snapshotId
        $kindResults[$kind.name] = @{ state = $st; snapshotId = $snap.snapshot.snapshotId; repositoryId = $reg.repository.repositoryId }
    }
    $kts = $kindResults['k-ts']; $kcs = $kindResults['k-cs']; $kpy = $kindResults['k-py']; $kps = $kindResults['k-ps']; $kjs = $kindResults['k-js']
    Assert-Aih ($kts.state.status -eq 'ready' -and $kts.state.stats.languages['typescript'] -eq 1) 'step 17: TypeScript repository indexed without repo-specific code'
    Assert-Aih ($kcs.state.status -eq 'ready' -and $kcs.state.stats.languages['csharp'] -eq 1) 'step 17b: C# repository indexed'
    Assert-Aih ($kpy.state.status -eq 'ready' -and $kpy.state.stats.languages['python'] -eq 1) 'step 17c: Python repository indexed'
    Assert-Aih ($kps.state.status -eq 'ready' -and $kps.state.stats.languages['powershell'] -eq 1) 'step 17d: PowerShell repository indexed'
    Assert-Aih ($kjs.state.status -eq 'ready' -and $kjs.state.stats.languages['javascript'] -eq 1) 'step 17e: JavaScript repository indexed'
    $kernelDefs = @(Find-AihCodeDefinitions -StoreRoot $store -RepositoryId $kcs.repositoryId -SnapshotId $kcs.snapshotId -Name 'Kernel')
    Assert-Aih ($kernelDefs.Count -eq 1 -and $kernelDefs[0].kind -eq 'class') 'step 17f: cross-repo query path returns C# class definition'

    Write-Host ("Code intelligence e2e: $passed assertions passed.")
} finally {
    Unregister-AihIntEventSubscription -SubscriptionId $sub1.subscriptionId
    Unregister-AihIntEventSubscription -SubscriptionId $sub2.subscriptionId
    Unregister-AihIntEventSubscription -SubscriptionId $sub3.subscriptionId
    Unregister-AihIntEventSubscription -SubscriptionId $sub4.subscriptionId
    Unregister-AihIntEventSubscription -SubscriptionId $sub5.subscriptionId
    if ($store) { Remove-Item -LiteralPath $store -Recurse -Force -ErrorAction SilentlyContinue }
    if ($fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}