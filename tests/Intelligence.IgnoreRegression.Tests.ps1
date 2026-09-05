[CmdletBinding()]param([string]$InstallRoot = 'C:\AI-Harness')
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Intelligence.ps1')

# ── Phase 3.1 hardening Fix 2: ignore-engine regression compatibility ───────
$passed = 0
$nl = [string][char]10
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-Fixture([string]$Name) { $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-ig-$Name-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $path -Force | Out-Null; $path }
function Set-TestFile([string]$Path, [string]$Content) { $parent = Split-Path -Parent $Path; if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }; Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 }
function New-Tree([hashtable[]]$Files) {
    $dir = New-Fixture tree
    foreach ($f in $Files) {
        Set-TestFile (Join-Path $dir ($f.path -replace '/', '/')) ($(if ($f.ContainsKey('content')) { $f.content } else { 'x' }))
    }
    return $dir
}
function Get-ScannedPaths([string]$Dir) {
    $scan = Invoke-AihInventoryScan -CheckoutRoot $Dir
    return @($scan.files | ForEach-Object { $_.path } | Where-Object { "$_" -notmatch '(^|/)\.gitignore$' -and "$_" -notmatch '(^|/)\.nexusignore$' } | Sort-Object)
}

try {
    # ── case 1: bare ** ignores everything; !src/** re-includes src subtree ──
    $dir = New-Tree @(
        @{ path = 'src/included.ts' }, @{ path = 'src/sub/deep.ts' },
        @{ path = 'docs/readme.md' }, @{ path = 'top.ts' },
        @{ path = '.gitignore'; content = ('**' + $nl + '!src/**') }
    )
    $paths = Get-ScannedPaths $dir
    Assert-Aih ($paths -contains 'src/included.ts' -and $paths -contains 'src/sub/deep.ts') 'ignore: ** + !src/** keeps every src file including nested'
    Assert-Aih ($paths -notcontains 'docs/readme.md' -and $paths -notcontains 'top.ts') 'ignore: ** excludes everything outside the re-included subtree'

    # ── case 2: foo/ pruned; !foo/bar.txt re-includes exactly one file ────
    $dir = New-Tree @(
        @{ path = 'foo/bar.txt' }, @{ path = 'foo/other.txt' }, @{ path = 'foo/sub/nested.txt' },
        @{ path = 'app.ts' },
        @{ path = '.gitignore'; content = ('foo/' + $nl + '!foo/bar.txt') }
    )
    $paths = Get-ScannedPaths $dir
    Assert-Aih ($paths -contains 'foo/bar.txt') 'ignore: foo/ + !foo/bar.txt re-includes the named file'
    Assert-Aih ($paths -notcontains 'foo/other.txt' -and $paths -notcontains 'foo/sub/nested.txt') 'ignore: foo/ + !foo/bar.txt keeps other foo contents excluded'

    # ── case 3: nested .gitignore — child re-include wins inside its scope ─
    $dir = New-Tree @(
        @{ path = 'src/included.ts' }, @{ path = 'src/keep.log' },
        @{ path = 'other/thing.log' }, @{ path = 'src/tmp/x.ts' },
        @{ path = '.gitignore'; content = '*.log' },
        @{ path = 'src/.gitignore'; content = ('!keep.log' + $nl + 'tmp/') }
    )
    $paths = Get-ScannedPaths $dir
    Assert-Aih ($paths -contains 'src/keep.log') 'ignore: nested .gitignore re-include wins inside its directory'
    Assert-Aih ($paths -notcontains 'other/thing.log') 'ignore: root *.log still excludes logs outside the child scope'
    Assert-Aih ($paths -notcontains 'src/tmp/x.ts') 'ignore: nested .gitignore directory rule prunes its own subtree'
    Assert-Aih ($paths -contains 'src/included.ts') 'ignore: unrelated files remain visible'

    # ── case 4: nested .gitignore negation (Nexus semantics) ─────────────
    # Nexus evaluates negations uniformly by rule order (deeper scope = later
    # order), so a deeper .gitignore negation re-includes beneath a directory
    # excluded by a shallower pattern. Real git is inconsistent in this corner
    # (it hides everything for **+!src/** yet lists non-negated siblings for
    # foo/+!foo/bar.txt); Nexus chooses the deterministic layered model and
    # documents the divergence.
    $dir = New-Tree @(
        @{ path = 'src/build/keep.txt' }, @{ path = 'src/build/other.txt' }, @{ path = 'src/code.ts' },
        @{ path = '.gitignore'; content = 'build/' },
        @{ path = 'src/.gitignore'; content = '!build/keep.txt' }
    )
    $paths = Get-ScannedPaths $dir
    Assert-Aih ($paths -contains 'src/build/keep.txt') 'ignore: deeper-scope negation re-includes under a shallower-excluded directory'
    Assert-Aih ($paths -notcontains 'src/build/other.txt') 'ignore: un-negated siblings under the excluded directory stay excluded'
    Assert-Aih ($paths -contains 'src/code.ts') 'ignore: sibling files of pruned directories stay visible'

    # ── case 5: **/name matches at any depth; /root-only anchoring ───────
    $dir = New-Tree @(
        @{ path = 'a/secret.key' }, @{ path = 'secret.key' }, @{ path = 'deep/b/secret.key' },
        @{ path = 'rootonly.txt' }, @{ path = 'sub/rootonly.txt' },
        @{ path = '.gitignore'; content = ('**/secret.key' + $nl + '/rootonly.txt') }
    )
    $paths = Get-ScannedPaths $dir
    Assert-Aih ($paths -notcontains 'a/secret.key' -and $paths -notcontains 'secret.key' -and $paths -notcontains 'deep/b/secret.key') 'ignore: **/name matches at every depth'
    Assert-Aih ($paths -contains 'sub/rootonly.txt') 'ignore: /anchored pattern applies only at the rule directory level'

    # ── case 6: last-match-wins ordering between layers ──────────────────
    $dir = New-Tree @(
        @{ path = 'gen/a.js' }, @{ path = 'keepme.js' },
        @{ path = '.gitignore'; content = 'keepme.js' },
        @{ path = '.nexusignore'; content = '!keepme.js' }
    )
    $paths = Get-ScannedPaths $dir
    Assert-Aih ($paths -contains 'keepme.js') 'ignore: .nexusignore negation overrides .gitignore exclusion (layer order)'

    # ── case 7: .nexus.yml exclude + .nexusignore interplay ──────────────
    $dir = New-Tree @(
        @{ path = 'archive/old.txt' }, @{ path = 'archive/keep.txt' }, @{ path = 'nexus-ignored.txt' }, @{ path = 'app.ts' },
        @{ path = '.nexus.yml'; content = (@('index:', '  exclude:', '    - "archive/**"') -join $nl) },
        @{ path = '.nexusignore'; content = 'nexus-ignored.txt' }
    )
    $paths = Get-ScannedPaths $dir
    Assert-Aih ($paths -notcontains 'archive/old.txt' -and $paths -notcontains 'archive/keep.txt') 'ignore: .nexus.yml exclude globs prune subtree'
    Assert-Aih ($paths -notcontains 'nexus-ignored.txt') 'ignore: .nexusignore excludes its own paths'
    Assert-Aih ($paths -contains 'app.ts') 'ignore: unrelated files stay visible across layers'

    # ── case 8: deep negation re-include under default-ignored directory ──
    $dir = New-Tree @(
        @{ path = 'dist/vendor/pinned.js' }, @{ path = 'dist/bundle.js' }, @{ path = 'src/app.ts' },
        @{ path = '.nexusignore'; content = '!dist/vendor/pinned.js' }
    )
    $paths = Get-ScannedPaths $dir
    Assert-Aih ($paths -contains 'dist/vendor/pinned.js') 'ignore: deep negation re-includes a file under a default-ignored directory'
    Assert-Aih ($paths -notcontains 'dist/bundle.js') 'ignore: deep negation keeps sibling files excluded'

    # ── case 9: comments, blank lines and whitespace robustness ──────────
    $dir = New-Tree @(
        @{ path = 'skip.ts' }, @{ path = 'stay.ts' },
        @{ path = '.gitignore'; content = ('# comment line' + $nl + $nl + 'skip.ts' + $nl + '   ') }
    )
    $paths = Get-ScannedPaths $dir
    Assert-Aih ($paths -notcontains 'skip.ts' -and $paths -contains 'stay.ts') 'ignore: comments and blank lines are tolerated'

    Write-Host ("Ignore regression: $passed assertions passed.")
} finally {
    # fixtures are created under the redirected temp area; best-effort cleanup
}
