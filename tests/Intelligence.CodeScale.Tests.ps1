[CmdletBinding()]param([string]$InstallRoot = 'C:\AI-Harness')
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Intelligence.ps1')

# ── Phase 3.2E: scale test (~800 files) — architecture validated by write
# counts, not microbenchmarks: one changed file => exactly one store write.
$passed = 0
$nl = [string][char]10
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function Invoke-TestGit([string]$Path, [string[]]$GitArguments) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & git -C $Path @GitArguments 2>&1; if ($LASTEXITCODE -ne 0) { throw ("git failed: " + ($GitArguments -join ' ')) }; return $output }
    finally { $ErrorActionPreference = $previousEap }
}

$store = Join-Path ([IO.Path]::GetTempPath()) ("aih-scale-" + [guid]::NewGuid().ToString('N'))
$repo = Join-Path ([IO.Path]::GetTempPath()) ("aih-scale-repo-" + [guid]::NewGuid().ToString('N'))
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
    New-Item -ItemType Directory -Path $repo -Force | Out-Null
    Invoke-TestGit $repo @('init', '-q') | Out-Null
    Set-Content -LiteralPath (Join-Path $repo 'package.json') -Value '{"name":"scale","workspaces":["modules/*"]}' -Encoding UTF8

    # 8 modules x 100 files = 800 TypeScript sources with unique symbols
    $fileIndex = 0
    for ($moduleNo = 1; $moduleNo -le 8; $moduleNo++) {
        $moduleDir = Join-Path $repo ('modules/mod' + $moduleNo)
        New-Item -ItemType Directory -Path $moduleDir -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $moduleDir 'package.json') -Value ('{"name":"mod' + $moduleNo + '"}') -Encoding UTF8
        for ($fileNo = 1; $fileNo -le 100; $fileNo++) {
            $fileIndex = $fileIndex + 1
            $className = 'Service' + $fileIndex
            $body = @(
                ("import { shared" + $moduleNo + " } from './shared';"),
                ("export class Service" + $fileIndex + " {"),
                '  handle(request: string) {',
                ("    return shared" + $moduleNo + " + request.length;"),
                '  }',
                '}'
            ) -join $nl
            Set-Content -LiteralPath (Join-Path $moduleDir ('unit' + $fileNo + '.ts')) -Value $body -Encoding UTF8
        }
        Set-Content -LiteralPath (Join-Path $moduleDir 'shared.ts') -Value ('export const shared' + $moduleNo + ' = ' + $moduleNo + ';') -Encoding UTF8
    }
    $totalFiles = $fileIndex + 8 + 9   # units + shared.ts + nine package.json
    Invoke-TestGit $repo @('add', '.') | Out-Null
    Invoke-TestGit $repo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'scale fixture') | Out-Null

    $registered = Register-AihRepository -StoreRoot $store -Path $repo
    $repositoryId = $registered.repository.repositoryId
    $checkoutId = $registered.checkout.checkoutId

    $buildA = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $indexStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $stateA = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId
    $indexStopwatch.Stop()
    $indexMs1 = [double]$indexStopwatch.Elapsed.TotalMilliseconds
    Assert-Aih ($stateA.status -eq 'ready') 'initial index of ~800 files activates ready'
    Assert-Aih ($stateA.stats.filesConsidered -ge $totalFiles) ('initial index considered all files (' + $stateA.stats.filesConsidered + ')')
    Assert-Aih ($stateA.stats.indexed -eq 808 -and $stateA.stats.unsupported -eq 9) 'initial index parses every TS file (nine package.json files unsupported)'
    Assert-Aih ($stateA.stats.symbols -ge $fileIndex) ('initial index extracts at least one symbol per generated class (symbols=' + $stateA.stats.symbols + ')')

    $defsProbe = @(Find-AihCodeDefinitions -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildA.snapshot.snapshotId -Name 'Service400')
    Assert-Aih ($defsProbe.Count -eq 1 -and $defsProbe[0].kind -eq 'class') 'definition query over ~800-symbol index returns the unique class'

    $fiCountA = (& (Get-AihCodeIntelligenceStore -StoreRoot $store).CountFileIntelligence)
    Assert-Aih ($fiCountA -eq 808) ('store holds exactly one FI document per parsed file (' + $fiCountA + ')')

    # touch ONE file; everything else must be reused with ONE new store write
    Set-Content -LiteralPath (Join-Path $repo 'modules/mod4/unit40.ts') -Value (@(
        "import { shared4 } from './shared';",
        'export class Service400 {',
        '  handle(request: string) {',
        '    return shared4 + request.length + 1;',
        '  }',
        '}'
    ) -join $nl) -Encoding UTF8
    Invoke-TestGit $repo @('add', '.') | Out-Null
    Invoke-TestGit $repo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'touch one file') | Out-Null
    $buildB = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $stateB = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildB.snapshot.snapshotId
    $fiCountB = (& (Get-AihCodeIntelligenceStore -StoreRoot $store).CountFileIntelligence)
    Assert-Aih ($stateB.status -eq 'ready') 'incremental index after one-file change activates ready'
    Assert-Aih ($stateB.stats.indexed -eq 1 -and $stateB.stats.reused -eq 807) 'one-file change reuses every other file'
    Assert-Aih ($fiCountB -eq ($fiCountA + 1)) 'one-file change produced EXACTLY ONE new store document (architecture proof)'
    $issueRefs = @(Find-AihCodeReferences -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildB.snapshot.snapshotId -Name 'shared4')
    Assert-Aih ($issueRefs.Count -ge 100) 'reference index covers module-wide usage (scale)'

    # ── F09: per-file index cost stays bounded as cardinality doubles ──────
    # The remediation replaced @()+@() array copying with linear list
    # accumulation and batched JSONL writes. A quadratic regression would
    # roughly double the per-file cost at doubled cardinality; the generous
    # 1.5x bound fails only on a real super-linear regression (the linear
    # expectation is well BELOW 1.0x here, because the doubled index reuses
    # the already-parsed first half).
    for ($moduleNo = 9; $moduleNo -le 16; $moduleNo++) {
        $moduleDir = Join-Path $repo ('modules/mod' + $moduleNo)
        New-Item -ItemType Directory -Force -Path $moduleDir | Out-Null
        Set-Content -LiteralPath (Join-Path $moduleDir 'package.json') -Value ('{"name":"mod' + $moduleNo + '"}') -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $moduleDir 'shared.ts') -Value ('export const shared' + $moduleNo + ' = ' + $moduleNo + ';') -Encoding UTF8
        for ($fileNo = 1; $fileNo -le 100; $fileNo++) {
            $fileIndex = $fileIndex + 1
            $className = 'Service' + $fileIndex
            $body = @(
                ("import { shared" + $moduleNo + " } from './shared';"),
                ("export class Service" + $fileIndex + " {"),
                '  handle(request: string) {',
                ("    return shared" + $moduleNo + " + request.length;"),
                '  }',
                '}'
            ) -join $nl
            Set-Content -LiteralPath (Join-Path $moduleDir ('unit' + $fileNo + '.ts')) -Value $body -Encoding UTF8
        }
    }
    Invoke-TestGit $repo @('add', '.') | Out-Null
    Invoke-TestGit $repo @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'double cardinality') | Out-Null
    $buildC = Invoke-AihSnapshotBuild -StoreRoot $store -CheckoutId $checkoutId
    $growthStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $stateC = Invoke-AihCodeIntelligenceIndex -StoreRoot $store -RepositoryId $repositoryId -SnapshotId $buildC.snapshot.snapshotId
    $growthStopwatch.Stop()
    Assert-Aih ($stateC.status -eq 'ready') 'F09: doubled-cardinality index activates ready'
    # 800 new units + 8 new shared.ts parse; all 808 original TS files reuse
    Assert-Aih ($stateC.stats.indexed -eq 808 -and $stateC.stats.reused -eq 808) 'F09: doubled-cardinality index parses only the new files'
    if ($indexMs1 -ge 2000) {
        $perFile1 = $indexMs1 / [double]$stateA.stats.filesConsidered
        $perFile2 = [double]$growthStopwatch.Elapsed.TotalMilliseconds / [double]$stateC.stats.filesConsidered
        Assert-Aih ($perFile2 -le ($perFile1 * 1.5)) ('F09: per-file index cost stays bounded at doubled cardinality (per-file ' + [Math]::Round($perFile2, 3) + 'ms vs ' + [Math]::Round($perFile1, 3) + 'ms baseline)')
    }

    $sw.Stop()
    Write-Host ("Scale test wall time: " + [int]$sw.Elapsed.TotalSeconds + "s for " + $totalFiles + " files x 2 snapshots (informational).")
    Write-Host ("Code intelligence scale: $passed assertions passed.")
} finally {
    if ($store) { Remove-Item -LiteralPath $store -Recurse -Force -ErrorAction SilentlyContinue }
    if ($repo) { Remove-Item -LiteralPath $repo -Recurse -Force -ErrorAction SilentlyContinue }
}
