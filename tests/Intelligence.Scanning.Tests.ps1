[CmdletBinding()]param([string]$InstallRoot = 'C:\AI-Harness')
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts\Common.ps1')
. (Join-Path $InstallRoot 'scripts\Intelligence.ps1')

# ── Phase 3.1C (File Inventory) + 3.1D (Module Discovery) acceptance tests ──
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

$fixtureRoot = New-Fixture scanning
try {
    # ── normal source files + deterministic hashing ──────────────────────
    $simple = Join-Path $fixtureRoot 'simple'
    New-Item -ItemType Directory -Path (Join-Path $simple 'src') -Force | Out-Null
    Set-TestFile (Join-Path $simple 'src\main.ts') 'export const main = () => 1;'
    Set-TestFile (Join-Path $simple 'src\utils.ts') 'export const util = 2;'
    Set-TestFile (Join-Path $simple 'README.md') '# simple'
    Set-TestFile (Join-Path $simple '.gitignore') '*.local'
    Set-TestFile (Join-Path $simple 'secret.local') 'ignored'
    $scan1 = Invoke-AihInventoryScan -CheckoutRoot $simple
    $paths1 = @($scan1.files | ForEach-Object { $_.path })
    Assert-Aih ($paths1 -contains 'src/main.ts' -and $paths1 -contains 'src/utils.ts' -and $paths1 -contains 'README.md') 'normal source files are discovered with normalized relative paths'
    Assert-Aih ($paths1 -notcontains 'secret.local') 'gitignore rules are respected'
    Assert-Aih ($paths1 -contains '.gitignore') 'the .gitignore file itself is inventoried'
    $mainEntry = @($scan1.files | Where-Object { $_.path -eq 'src/main.ts' })[0]
    Assert-Aih ($mainEntry.contentHash -like 'sha256:*') 'content hashes are stable sha256 identities (never mtime-based)'
    Assert-Aih ($mainEntry.classification -eq 'source') 'TypeScript files classify as source'
    Assert-Aih ($mainEntry.sensitivity -eq 'normal') 'normal files have normal sensitivity'
    Assert-Aih ($mainEntry.indexability -eq 'text') 'text files are text-indexable'
    $scan2 = Invoke-AihInventoryScan -CheckoutRoot $simple
    $mainAgain = @($scan2.files | Where-Object { $_.path -eq 'src/main.ts' })[0]
    Assert-Aih ($mainAgain.contentHash -eq $mainEntry.contentHash) 'unchanged content keeps the identical hash across scans'
    Assert-Aih ($scan1.files.Count -eq $scan2.files.Count) 'repeated scans of the same state produce equivalent inventories'

    # ── .nexusignore (including re-inclusion of a default-ignored path) ──
    $nexusIgn = Join-Path $fixtureRoot 'nexusignore'
    Set-TestFile (Join-Path $nexusIgn 'app.js') 'code;'
    New-Item -ItemType Directory -Path (Join-Path $nexusIgn 'build') -Force | Out-Null
    Set-TestFile (Join-Path $nexusIgn 'build\output.js') 'compiled;'
    Set-TestFile (Join-Path $nexusIgn 'build\keep.js') 'precious;'
    Set-TestFile (Join-Path $nexusIgn '.nexusignore') (('build/', '!build/keep.js') -join $nl)
    $nexusIgnScan = Invoke-AihInventoryScan -CheckoutRoot $nexusIgn
    $nexusIgnPaths = @($nexusIgnScan.files | ForEach-Object { $_.path })
    Assert-Aih ($nexusIgnPaths -contains 'app.js' -and $nexusIgnPaths -notcontains 'build/output.js') '.nexusignore excludes repository-specific paths'
    Assert-Aih ($nexusIgnPaths -contains 'build/keep.js') '.nexusignore negation re-includes a path under a default-ignored directory'

    # ── generated directories + .nexus.yml configuration ─────────────────
    $configured = Join-Path $fixtureRoot 'configured'
    Set-TestFile (Join-Path $configured 'src.ts') 'source;'
    New-Item -ItemType Directory -Path (Join-Path $configured 'dist') -Force | Out-Null
    Set-TestFile (Join-Path $configured 'dist\bundle.js') 'generated;'
    New-Item -ItemType Directory -Path (Join-Path $configured 'node_modules\dep') -Force | Out-Null
    Set-TestFile (Join-Path $configured 'node_modules\dep\index.js') 'dep;'
    New-Item -ItemType Directory -Path (Join-Path $configured 'archive\old') -Force | Out-Null
    Set-TestFile (Join-Path $configured 'archive\old\a.txt') 'old;'
    Set-TestFile (Join-Path $configured 'keep.txt') 'keep;'
    $ymlLines = @('version: 1', 'repository:', '  name: My Configured Repo', 'index:', '  respect_gitignore: true', 'exclude:', '  - "archive/**"', 'modules:', '  autodetect: true', 'security:', '  external_context: false')
    Set-TestFile (Join-Path $configured '.nexus.yml') ($ymlLines -join $nl)
    $config = Resolve-AihRepositoryConfig -CheckoutRoot $configured
    Assert-Aih ($config.repositoryName -eq 'My Configured Repo') '.nexus.yml repository.name is read'
    Assert-Aih ($config.respectGitignore -eq $true -and $config.modulesAutoDetect -eq $true) '.nexus.yml index and modules flags override defaults'
    $configuredScan = Invoke-AihInventoryScan -CheckoutRoot $configured -Config $config
    $configuredPaths = @($configuredScan.files | ForEach-Object { $_.path })
    Assert-Aih ($configuredPaths -notcontains 'dist/bundle.js' -and $configuredPaths -notcontains 'node_modules/dep/index.js') 'generated directories (dist, node_modules) are pruned by defaults'
    Assert-Aih ($configuredPaths -notcontains 'archive/old/a.txt') '.nexus.yml exclude globs are applied'
    Assert-Aih ($configuredPaths -contains 'keep.txt') 'configuration excludes do not remove unrelated files'
    Assert-Aih (@($configuredScan.configErrors).Count -eq 0) 'well-formed configuration produces no config errors'

    # unknown configuration keys are surfaced explicitly, not silently applied
    $badConfig = Join-Path $fixtureRoot 'badconfig'
    Set-TestFile (Join-Path $badConfig 'x.ts') 'x;'
    Set-TestFile (Join-Path $badConfig '.nexus.yml') (@('version: 1', 'future_section:', '  something: true') -join $nl)
    $badResult = Invoke-AihInventoryScan -CheckoutRoot $badConfig
    $badErrors = @($badResult.configErrors | Where-Object { "$_" -like '*future_section*' })
    Assert-Aih (@($badErrors).Count -ge 1) 'unknown configuration keys are surfaced as explicit config errors'

    # ── binary files ─────────────────────────────────────────────────────
    $binaryRepo = Join-Path $fixtureRoot 'binary'
    Set-TestFile (Join-Path $binaryRepo 'readme.md') 'text'
    [IO.File]::WriteAllBytes((Join-Path $binaryRepo 'program.exe'), [byte[]](0x4D, 0x5A, 0x00, 0x90, 0x00, 0x03, 0xFF, 0x00))
    [IO.File]::WriteAllBytes((Join-Path $binaryRepo 'image.png'), [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
    $binaryScan = Invoke-AihInventoryScan -CheckoutRoot $binaryRepo
    $exeEntry = @($binaryScan.files | Where-Object { $_.path -eq 'program.exe' })[0]
    Assert-Aih ($exeEntry.isBinary -and $exeEntry.indexability -eq 'binary') 'binary files exist in inventory and are marked non-text-indexable'
    $pngEntry = @($binaryScan.files | Where-Object { $_.path -eq 'image.png' })[0]
    Assert-Aih ($pngEntry.classification -eq 'asset') 'asset files classify as asset'

    # ── large files ──────────────────────────────────────────────────────
    $largeRepo = Join-Path $fixtureRoot 'large'
    Set-TestFile (Join-Path $largeRepo 'code.ts') 'code;'
    $big = New-Object byte[] (3MB)
    (New-Object Random 7).NextBytes($big)
    [IO.File]::WriteAllBytes((Join-Path $largeRepo 'dataset.bin'), $big)
    $largeScan = Invoke-AihInventoryScan -CheckoutRoot $largeRepo
    $largeEntry = @($largeScan.files | Where-Object { $_.path -eq 'dataset.bin' })[0]
    Assert-Aih ($largeEntry.indexability -eq 'excluded_large') 'large files remain visible in inventory with excluded_large indexability'
    Assert-Aih ($largeEntry.contentHash -like 'sha256s:*') 'large files use an explicitly-marked sampled content hash (no full load)'
    Assert-Aih ($largeScan.stats.sampledLargeFiles -ge 1) 'large files are sampled, never loaded fully into memory'
    $largeAgain = Invoke-AihInventoryScan -CheckoutRoot $largeRepo
    $largeAgainEntry = @($largeAgain.files | Where-Object { $_.path -eq 'dataset.bin' })[0]
    Assert-Aih ($largeAgainEntry.contentHash -eq $largeEntry.contentHash) 'large-file sampled hashes are stable for unchanged content'

    # ── sensitive files ──────────────────────────────────────────────────
    $secrets = Join-Path $fixtureRoot 'secrets'
    Set-TestFile (Join-Path $secrets '.env') 'API_KEY=x'
    Set-TestFile (Join-Path $secrets '.env.production') 'API_KEY=y'
    Set-TestFile (Join-Path $secrets 'server.key') 'PRIVATE'
    Set-TestFile (Join-Path $secrets 'server.pem') 'CERTKEY'
    Set-TestFile (Join-Path $secrets 'id_rsa') 'RSA'
    Set-TestFile (Join-Path $secrets 'root.crt') 'PUBLICCERT'
    Set-TestFile (Join-Path $secrets 'deploy_token.txt') 'tok'
    Set-TestFile (Join-Path $secrets 'code.py') 'print(1)'
    $secretsScan = Invoke-AihInventoryScan -CheckoutRoot $secrets
    $sens = @{}
    foreach ($entry in $secretsScan.files) { $sens[$entry.path] = $entry.sensitivity }
    Assert-Aih ($sens['.env'] -eq 'blocked') '.env files are marked blocked'
    Assert-Aih ($sens['.env.production'] -eq 'blocked') '.env.* variants are marked blocked'
    Assert-Aih ($sens['server.key'] -eq 'blocked') 'private key files are marked blocked'
    Assert-Aih ($sens['server.pem'] -eq 'blocked') 'pem files are marked blocked'
    Assert-Aih ($sens['id_rsa'] -eq 'blocked') 'id_rsa files are marked blocked'
    Assert-Aih ($sens['root.crt'] -eq 'potential_secret') 'certificate files are marked potential_secret'
    Assert-Aih ($sens['deploy_token.txt'] -eq 'potential_secret') 'token files are marked potential_secret'
    Assert-Aih ($sens['code.py'] -eq 'normal') 'regular source files keep normal sensitivity'

    # ── symlink safety (junctions; file symlinks when the OS allows) ─────
    $symlinks = Join-Path $fixtureRoot 'symlinks'
    Set-TestFile (Join-Path $symlinks 'real.ts') 'real;'
    New-Item -ItemType Directory -Path (Join-Path $symlinks 'actual') -Force | Out-Null
    Set-TestFile (Join-Path $symlinks 'actual\deep.ts') 'deep;'
    $junction = $null
    try { $junction = New-Item -ItemType Junction -Path (Join-Path $symlinks 'loop') -Target $symlinks -ErrorAction Stop } catch { $junction = $null }
    if ($null -ne $junction) {
        $junctionScan = Invoke-AihInventoryScan -CheckoutRoot $symlinks
        $junctionPaths = @($junctionScan.files | ForEach-Object { $_.path })
        Assert-Aih ($junctionPaths -notcontains 'loop/loop/real.ts' -and $junctionPaths -notcontains 'loop/real.ts') 'directory junctions are never followed (no recursion, no duplicates)'
        Assert-Aih (@($junctionScan.skipped | Where-Object { $_.reason -eq 'symlink_or_junction' }).Count -ge 1) 'junctions are recorded as skipped with an explicit reason'
        $junctionItem = Get-Item -LiteralPath (Join-Path $symlinks 'loop') -Force
        $junctionItem.Delete()   # removes the reparse point without touching the target
        $junctionItem = $null
    } else {
        Assert-Aih $true 'junction creation unavailable in this environment (junction recursion check skipped)'
    }
    $fileLinkCreated = $false
    try { $null = New-Item -ItemType SymbolicLink -Path (Join-Path $symlinks 'alias.ts') -Target (Join-Path $symlinks 'real.ts') -ErrorAction Stop; $fileLinkCreated = $true } catch { }
    if ($fileLinkCreated) {
        $linkScan = Invoke-AihInventoryScan -CheckoutRoot $symlinks
        $aliasEntry = @($linkScan.files | Where-Object { $_.path -eq 'alias.ts' })[0]
        Assert-Aih ($null -ne $aliasEntry -and $aliasEntry.isSymlink -and $aliasEntry.indexability -eq 'excluded_symlink') 'file symlinks are inventoried but never read through (excluded_symlink)'
        Remove-Item -LiteralPath (Join-Path $symlinks 'alias.ts') -Force
    } else {
        Assert-Aih $true 'file symlink creation requires privileges not present (file-symlink check skipped)'
    }

    # ── Git-tracked files inside ignored directories stay visible ────────
    $forced = New-TestGitRepo (Join-Path $fixtureRoot 'forced')
    Set-TestFile (Join-Path $forced '.gitignore') 'vendor/'
    New-Item -ItemType Directory -Path (Join-Path $forced 'vendor') -Force | Out-Null
    Set-TestFile (Join-Path $forced 'vendor\pinned.js') 'pinned;'
    Set-TestFile (Join-Path $forced 'app.ts') 'app;'
    Invoke-TestGit $forced @('add', '-f', 'vendor/pinned.js') | Out-Null
    Invoke-TestGit $forced @('add', 'app.ts', '.gitignore') | Out-Null
    Invoke-TestGit $forced @('-c', 'user.email=t@nexus.test', '-c', 'user.name=nexus-test', 'commit', '-q', '-m', 'init') | Out-Null
    $tracked = @(& (Get-AihGitProvider).GetTrackedFiles $forced)
    $forcedScan = Invoke-AihInventoryScan -CheckoutRoot $forced -TrackedFiles $tracked
    $forcedPaths = @($forcedScan.files | ForEach-Object { $_.path })
    Assert-Aih ($forcedPaths -contains 'vendor/pinned.js') 'force-added tracked files inside ignored directories remain in the inventory'

    # ── Phase 3.1D: module discovery ─────────────────────────────────────
    # 1. simple single-package repository
    $single = Join-Path $fixtureRoot 'single'
    Set-TestFile (Join-Path $single 'package.json') '{"name":"single-app","version":"1.0.0","private":true}'
    Set-TestFile (Join-Path $single 'index.js') 'x;'
    $singleScan = Invoke-AihInventoryScan -CheckoutRoot $single
    $singleDiscovery = Invoke-AihModuleDiscovery -CheckoutRoot $single -Inventory $singleScan -RepositoryName 'single'
    Assert-Aih (@($singleDiscovery.modules).Count -eq 1 -and $singleDiscovery.modules[0].type -eq 'npm-package' -and $singleDiscovery.modules[0].name -eq 'single-app') 'simple single-package repository discovers one npm module'
    Assert-Aih ($singleDiscovery.modules[0].manifestPath -eq 'package.json') 'module records its manifest path'
    Assert-Aih ($singleDiscovery.modules[0].path -eq '') 'root module path is the repository root'

    # 2. TypeScript monorepo (workspaces + pnpm-workspace)
    $monorepo = Join-Path $fixtureRoot 'monorepo'
    Set-TestFile (Join-Path $monorepo 'package.json') '{"name":"monorepo-root","workspaces":["packages/*"]}'
    $wsLines = @('packages:', '  - "packages/*"', '  - "apps/*"')
    Set-TestFile (Join-Path $monorepo 'pnpm-workspace.yaml') ($wsLines -join $nl)
    foreach ($pkg in @('alpha', 'beta')) {
        New-Item -ItemType Directory -Path (Join-Path $monorepo "packages\$pkg") -Force | Out-Null
        Set-TestFile (Join-Path $monorepo "packages\$pkg\package.json") ('{"name":"pkg-' + $pkg + '"}')
    }
    New-Item -ItemType Directory -Path (Join-Path $monorepo 'apps\web') -Force | Out-Null
    Set-TestFile (Join-Path $monorepo 'apps\web\package.json') '{"name":"web-app"}'
    $monoScan = Invoke-AihInventoryScan -CheckoutRoot $monorepo
    $monoDiscovery = Invoke-AihModuleDiscovery -CheckoutRoot $monorepo -Inventory $monoScan -RepositoryName 'monorepo'
    $monoModules = @($monoDiscovery.modules)
    Assert-Aih (@($monoModules).Count -eq 4) 'TypeScript monorepo discovers root plus three package modules'
    $rootModule = @($monoModules | Where-Object { $_.path -eq '' })[0]
    $rootMeta = $rootModule.metadata
    $monoTool = if ($rootMeta.Contains('monorepoTool')) { "$($rootMeta['monorepoTool'])" } else { '' }
    $monoMarkers = if ($rootMeta.Contains('monorepoMarkers')) { @($rootMeta['monorepoMarkers']) } else { @() }
    Assert-Aih ($monoTool -eq 'pnpm' -or $monoTool -eq 'package-json-workspaces' -or ($monoMarkers -contains 'pnpm-workspace')) 'root module keeps monorepo tool metadata for later phases'
    $workspacePatterns = if ($rootMeta.Contains('workspaces')) { @($rootMeta['workspaces']) } else { @() }
    Assert-Aih (@($workspacePatterns).Count -ge 1) 'workspace patterns are retained in module metadata'
    $alpha = @($monoModules | Where-Object { $_.path -eq 'packages/alpha' })[0]
    Assert-Aih ($alpha.name -eq 'pkg-alpha' -and $alpha.type -eq 'npm-package') 'nested modules are discovered with their own identity'

    # 3. .NET solution with multiple projects
    $dotnet = Join-Path $fixtureRoot 'dotnet'
    $slnBody = @('Microsoft Visual Studio Solution File, Format Version 12.00', 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "src\Api\Api.csproj", "{11111111-1111-1111-1111-111111111111}"', 'EndProject', 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Domain", "src\Domain\Domain.csproj", "{22222222-2222-2222-2222-222222222222}"', 'EndProject', 'Global', 'EndGlobal')
    Set-TestFile (Join-Path $dotnet 'Api.sln') ($slnBody -join $nl)
    New-Item -ItemType Directory -Path (Join-Path $dotnet 'src\Api') -Force | Out-Null
    Set-TestFile (Join-Path $dotnet 'src\Api\Api.csproj') '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
    New-Item -ItemType Directory -Path (Join-Path $dotnet 'src\Domain') -Force | Out-Null
    Set-TestFile (Join-Path $dotnet 'src\Domain\Domain.csproj') '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
    $dnScan = Invoke-AihInventoryScan -CheckoutRoot $dotnet
    $dnDiscovery = Invoke-AihModuleDiscovery -CheckoutRoot $dotnet -Inventory $dnScan -RepositoryName 'dotnet-repo'
    $dnModules = @($dnDiscovery.modules)
    $slnModule = @($dnModules | Where-Object { $_.metadata.kind -eq 'solution' })
    Assert-Aih (@($slnModule).Count -eq 1 -and $slnModule[0].type -eq 'dotnet-project') '.NET solution is detected as a dotnet module'
    $slnProjects = @($slnModule[0].metadata.projects | Where-Object { "$_" -like '*Api.csproj' })
    Assert-Aih (@($slnProjects).Count -eq 1) 'solution metadata retains its project list for later phases'
    $apiModule = @($dnModules | Where-Object { $_.path -eq 'src/Api' })[0]
    Assert-Aih ($null -ne $apiModule -and $apiModule.type -eq 'dotnet-project' -and $apiModule.name -eq 'Api') 'csproj projects are discovered as nested dotnet modules'

    # 4. Python project
    $python = Join-Path $fixtureRoot 'python'
    Set-TestFile (Join-Path $python 'pyproject.toml') (@('[project]', 'name = "acme-core"', 'version = "0.1.0"') -join $nl)
    Set-TestFile (Join-Path $python 'main.py') 'print("hi")'
    $pyScan = Invoke-AihInventoryScan -CheckoutRoot $python
    $pyDiscovery = Invoke-AihModuleDiscovery -CheckoutRoot $python -Inventory $pyScan -RepositoryName 'python-repo'
    $pyModule = @($pyDiscovery.modules | Where-Object { $_.type -eq 'python-package' })[0]
    Assert-Aih ($null -ne $pyModule -and $pyModule.name -eq 'acme-core') 'pyproject.toml discovers a python-package module with its name'

    # setup.py fallback
    $pythonSetup = Join-Path $fixtureRoot 'python-setup'
    Set-TestFile (Join-Path $pythonSetup 'setup.py') (@('from setuptools import setup', 'setup(name="legacy-pkg", version="1.2")') -join $nl)
    $setupScan = Invoke-AihInventoryScan -CheckoutRoot $pythonSetup
    $setupDiscovery = Invoke-AihModuleDiscovery -CheckoutRoot $pythonSetup -Inventory $setupScan -RepositoryName 'legacy'
    $setupModule = @($setupDiscovery.modules | Where-Object { $_.type -eq 'python-package' })[0]
    Assert-Aih ($null -ne $setupModule -and $setupModule.name -eq 'legacy-pkg') 'setup.py discovers a python-package module'

    # 5. mixed-language repository (rust + go + java in one tree)
    $mixed = Join-Path $fixtureRoot 'mixed'
    Set-TestFile (Join-Path $mixed 'Cargo.toml') (@('[package]', 'name = "tools-core"', 'version = "0.1.0"') -join $nl)
    New-Item -ItemType Directory -Path (Join-Path $mixed 'svc') -Force | Out-Null
    Set-TestFile (Join-Path $mixed 'svc\go.mod') (@('module example.com/svc', '', 'go 1.21') -join $nl)
    New-Item -ItemType Directory -Path (Join-Path $mixed 'server') -Force | Out-Null
    Set-TestFile (Join-Path $mixed 'server\pom.xml') '<project><artifactId>server-app</artifactId></project>'
    $mixedScan = Invoke-AihInventoryScan -CheckoutRoot $mixed
    $mixedDiscovery = Invoke-AihModuleDiscovery -CheckoutRoot $mixed -Inventory $mixedScan -RepositoryName 'mixed'
    $mixedTypes = @($mixedDiscovery.modules | ForEach-Object { $_.type })
    Assert-Aih ($mixedTypes -contains 'rust-crate' -and $mixedTypes -contains 'go-module' -and $mixedTypes -contains 'java-module') 'mixed-language repository discovers rust, go, and java modules together'
    $goModule = @($mixedDiscovery.modules | Where-Object { $_.type -eq 'go-module' })[0]
    Assert-Aih ($goModule.name -eq 'example.com/svc' -and $goModule.path -eq 'svc') 'go module keeps its module path and declared name'

    # 6. nested modules (rust workspace)
    $rust = Join-Path $fixtureRoot 'rust'
    Set-TestFile (Join-Path $rust 'Cargo.toml') (@('[workspace]', 'members = ["crates/core"]', '', '[package]', 'name = "root-crate"') -join $nl)
    New-Item -ItemType Directory -Path (Join-Path $rust 'crates\core') -Force | Out-Null
    Set-TestFile (Join-Path $rust 'crates\core\Cargo.toml') (@('[package]', 'name = "core-crate"') -join $nl)
    $rustScan = Invoke-AihInventoryScan -CheckoutRoot $rust
    $rustDiscovery = Invoke-AihModuleDiscovery -CheckoutRoot $rust -Inventory $rustScan -RepositoryName 'rust'
    $rustRoot = @($rustDiscovery.modules | Where-Object { $_.path -eq '' })[0]
    $rustCore = @($rustDiscovery.modules | Where-Object { $_.path -eq 'crates/core' })[0]
    Assert-Aih ($rustRoot.metadata.workspace -eq $true) 'cargo workspace metadata is retained on the root crate'
    Assert-Aih ($null -ne $rustCore -and $rustCore.name -eq 'core-crate') 'nested crate is discovered as its own module'

    # 7. repository with no known manifest receives a generic root module
    $unknown = Join-Path $fixtureRoot 'unknown'
    Set-TestFile (Join-Path $unknown 'notes.txt') 'nothing known here'
    $unknownScan = Invoke-AihInventoryScan -CheckoutRoot $unknown
    $unknownDiscovery = Invoke-AihModuleDiscovery -CheckoutRoot $unknown -Inventory $unknownScan -RepositoryName 'mystery'
    Assert-Aih (@($unknownDiscovery.modules).Count -eq 1 -and $unknownDiscovery.modules[0].type -eq 'generic' -and $unknownDiscovery.modules[0].path -eq '') 'repository without known manifests receives a usable generic root module'
    Assert-Aih ($unknownDiscovery.modules[0].name -eq 'mystery') 'generic root module uses the repository name'

    Write-Host ("Scanning/Module acceptance: $passed assertions passed.")
} finally {
    if ($fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
