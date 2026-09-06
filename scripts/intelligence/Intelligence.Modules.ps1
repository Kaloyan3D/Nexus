Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Module Discovery (Phase 3.1D) ────────────────────────────────────────────
# Plugin-based manifest detection. No monorepo structure is hardcoded: the
# detector registry is an ordered list that can be extended at runtime.
# Detectors receive manifest locations from the deterministic inventory and
# produce module candidates (path, name, type, manifestPath, metadata).
# This phase records relationship-relevant metadata only; no dependency graph.

function Get-AihModuleDetectorRegistry {
    # Ordered: earlier detectors win when several manifests share a directory.
    $registry = @(
        @{
            name  = 'package-json'
            files = @('package.json')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                $metadata = [ordered]@{}
                $name = $null
                try {
                    $json = Get-Content -Raw -Encoding UTF8 -LiteralPath $ManifestFullPath | ConvertFrom-Json
                    if ($json.PSObject.Properties['name']) { $name = "$($json.name)" }
                    if ($json.PSObject.Properties['version']) { $metadata.version = "$($json.version)" }
                    if ($json.PSObject.Properties['private']) { $metadata.private = [bool]$json.private }
                    if ($json.PSObject.Properties['packageManager']) { $metadata.packageManager = "$($json.packageManager)" }
                    if ($json.PSObject.Properties['type']) { $metadata.moduleFormat = "$($json.type)" }
                    if ($json.PSObject.Properties['workspaces']) {
                        $patterns = @()
                        if ($json.workspaces -is [System.Array]) { $patterns = @($json.workspaces | ForEach-Object { "$_" }) }
                        elseif ($json.workspaces.PSObject.Properties['packages']) { $patterns = @($json.workspaces.packages | ForEach-Object { "$_" }) }
                        $metadata.workspaces = $patterns
                        if ($patterns.Count -gt 0) { $metadata.monorepoTool = 'package-json-workspaces' }
                    }
                } catch {
                    $metadata.parseError = $_.Exception.Message
                }
                return @{ name = $name; type = 'npm-package'; metadata = $metadata }
            }.GetNewClosure()
        },
        @{
            name  = 'pnpm-workspace'
            files = @('pnpm-workspace.yaml', 'pnpm-workspace.yml')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                $metadata = [ordered]@{ monorepoTool = 'pnpm' }
                try {
                    $text = [IO.File]::ReadAllText($ManifestFullPath, [Text.UTF8Encoding]::new($false))
                    $parsed = ConvertFrom-AihSimpleYaml -Content $text
                    if ($parsed.Contains('packages') -and $null -ne $parsed['packages']) {
                        $metadata.packages = @($parsed['packages'] | ForEach-Object { "$_" })
                    }
                } catch {
                    # foreign manifest with unsupported YAML subset: presence is
                    # still the identity signal, metadata degrades gracefully
                    $metadata.parseError = $_.Exception.Message
                }
                return @{ name = $null; type = 'npm-package'; metadata = $metadata }
            }.GetNewClosure()
        },
        @{
            name  = 'turbo'
            files = @('turbo.json')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                return @{ name = $null; type = 'npm-package'; metadata = [ordered]@{ monorepoTool = 'turborepo' } }
            }.GetNewClosure()
        },
        @{
            name  = 'nx'
            files = @('nx.json')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                return @{ name = $null; type = 'npm-package'; metadata = [ordered]@{ monorepoTool = 'nx' } }
            }.GetNewClosure()
        },
        @{
            name     = 'dotnet-solution'
            suffixes = @('.sln')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                $metadata = [ordered]@{ kind = 'solution'; projects = @() }
                try {
                    $text = [IO.File]::ReadAllText($ManifestFullPath, [Text.UTF8Encoding]::new($false))
                    $matchesFound = [regex]::Matches($text, 'Project\("[^"]*"\)\s*=\s*"[^"]*"\s*,\s*"(?<path>[^"]+)"')
                    foreach ($m in $matchesFound) {
                        $metadata.projects = @($metadata.projects) + @("$($m.Groups['path'].Value)")
                    }
                } catch { $metadata.parseError = $_.Exception.Message }
                return @{ name = $null; type = 'dotnet-project'; metadata = $metadata }
            }.GetNewClosure()
        },
        @{
            name     = 'dotnet-project'
            suffixes = @('.csproj', '.fsproj', '.vbproj')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                $name = [IO.Path]::GetFileNameWithoutExtension($ManifestFullPath)
                $metadata = [ordered]@{ kind = 'project' }
                try {
                    $text = [IO.File]::ReadAllText($ManifestFullPath, [Text.UTF8Encoding]::new($false))
                    $assembly = [regex]::Match($text, '<AssemblyName>(?<n>[^<]+)</AssemblyName>')
                    if ($assembly.Success) { $metadata.assemblyName = $assembly.Groups['n'].Value }
                    $tfm = [regex]::Match($text, '<TargetFramework>(?<t>[^<]+)</TargetFramework>')
                    if ($tfm.Success) { $metadata.targetFramework = $tfm.Groups['t'].Value }
                } catch { $metadata.parseError = $_.Exception.Message }
                return @{ name = $name; type = 'dotnet-project'; metadata = $metadata }
            }.GetNewClosure()
        },
        @{
            name  = 'python-pyproject'
            files = @('pyproject.toml')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                $name = $null
                $metadata = [ordered]@{}
                try {
                    $text = [IO.File]::ReadAllText($ManifestFullPath, [Text.UTF8Encoding]::new($false))
                    $nameMatch = [regex]::Match($text, '(?m)^\s*name\s*=\s*"(?<n>[^"]+)"')
                    if ($nameMatch.Success) { $name = $nameMatch.Groups['n'].Value }
                } catch { $metadata.parseError = $_.Exception.Message }
                return @{ name = $name; type = 'python-package'; metadata = $metadata }
            }.GetNewClosure()
        },
        @{
            name  = 'python-setup'
            files = @('setup.py')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                $name = $null
                $metadata = [ordered]@{}
                try {
                    $text = [IO.File]::ReadAllText($ManifestFullPath, [Text.UTF8Encoding]::new($false))
                    $nameMatch = [regex]::Match($text, 'name\s*=\s*[''\"](?<n>[^''\"]+)[''\"]')
                    if ($nameMatch.Success) { $name = $nameMatch.Groups['n'].Value }
                } catch { $metadata.parseError = $_.Exception.Message }
                return @{ name = $name; type = 'python-package'; metadata = $metadata }
            }.GetNewClosure()
        },
        @{
            name  = 'rust-crate'
            files = @('Cargo.toml')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                $name = $null
                $metadata = [ordered]@{}
                try {
                    $text = [IO.File]::ReadAllText($ManifestFullPath, [Text.UTF8Encoding]::new($false))
                    $nameMatch = [regex]::Match($text, '(?m)^\s*name\s*=\s*"(?<n>[^"]+)"')
                    if ($nameMatch.Success) { $name = $nameMatch.Groups['n'].Value }
                    if ($text -match '(?m)^\s*\[workspace\]') { $metadata.workspace = $true }
                    $members = [regex]::Match($text, '(?ms)^\s*members\s*=\s*\[(?<m>[^\]]*)\]')
                    if ($members.Success) {
                        $metadata.members = @([regex]::Matches($members.Groups['m'].Value, '"(?<v>[^"]+)"') | ForEach-Object { $_.Groups['v'].Value })
                    }
                } catch { $metadata.parseError = $_.Exception.Message }
                return @{ name = $name; type = 'rust-crate'; metadata = $metadata }
            }.GetNewClosure()
        },
        @{
            name  = 'go-module'
            files = @('go.mod')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                $name = $null
                $metadata = [ordered]@{}
                try {
                    $text = [IO.File]::ReadAllText($ManifestFullPath, [Text.UTF8Encoding]::new($false))
                    $moduleMatch = [regex]::Match($text, '(?m)^\s*module\s+(?<m>\S+)')
                    if ($moduleMatch.Success) { $name = $moduleMatch.Groups['m'].Value }
                } catch { $metadata.parseError = $_.Exception.Message }
                return @{ name = $name; type = 'go-module'; metadata = $metadata }
            }.GetNewClosure()
        },
        @{
            name  = 'java-pom'
            files = @('pom.xml')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                $name = $null
                $metadata = [ordered]@{}
                try {
                    $text = [IO.File]::ReadAllText($ManifestFullPath, [Text.UTF8Encoding]::new($false))
                    $artifact = [regex]::Match($text, '<artifactId>(?<a>[^<]+)</artifactId>')
                    if ($artifact.Success) { $name = $artifact.Groups['a'].Value }
                } catch { $metadata.parseError = $_.Exception.Message }
                return @{ name = $name; type = 'java-module'; metadata = $metadata }
            }.GetNewClosure()
        },
        @{
            name  = 'java-gradle'
            files = @('build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts')
            build = {
                param([string]$ManifestFullPath, [string]$ManifestRelPath, [string]$RelDir)
                $name = $null
                $metadata = [ordered]@{}
                try {
                    $text = [IO.File]::ReadAllText($ManifestFullPath, [Text.UTF8Encoding]::new($false))
                    $rootName = [regex]::Match($text, 'rootProject\.name\s*=\s*[''"''](?<n>[^''"]+)[''"'']')
                    if ($rootName.Success) { $name = $rootName.Groups['n'].Value }
                } catch { $metadata.parseError = $_.Exception.Message }
                return @{ name = $name; type = 'java-module'; metadata = $metadata }
            }.GetNewClosure()
        }
    )
    return $registry
}

function Invoke-AihModuleDiscovery {
    # Produces module candidates from the inventory. One module per directory;
    # detector order decides conflicts; markers (pnpm-workspace/turbo/nx) merge
    # into the package.json module of the same directory when present.
    # Unknown repositories receive a usable generic root module.
    param(
        [Parameter(Mandatory = $true)][string]$CheckoutRoot,
        [Parameter(Mandatory = $true)]$Inventory,
        [Parameter(Mandatory = $true)][string]$RepositoryName,
        $Detectors = $null
    )
    if ($null -eq $Detectors) { $Detectors = Get-AihModuleDetectorRegistry }
    $byDir = [ordered]@{}
    $markers = [ordered]@{}
    foreach ($entry in $Inventory.files) {
        $basename = $entry.path
        $idx = $basename.LastIndexOf('/')
        $relDir = if ($idx -ge 0) { $entry.path.Substring(0, $idx) } else { '' }
        $fileName = if ($idx -ge 0) { $entry.path.Substring($idx + 1) } else { $entry.path }
        $lowerFile = $fileName.ToLowerInvariant()
        $resolved = $null
        foreach ($detector in $Detectors) {
            $isMatch = $false
            if ($detector.Contains('files')) {
                foreach ($candidate in $detector.files) { if ($lowerFile -eq $candidate) { $isMatch = $true; break } }
            }
            if (-not $isMatch -and $detector.Contains('suffixes')) {
                foreach ($suffix in $detector.suffixes) { if ($lowerFile.EndsWith($suffix)) { $isMatch = $true; break } }
            }
            if (-not $isMatch) { continue }
            $manifestFull = Join-Path $CheckoutRoot ($entry.path.Replace('/', '\'))
            if (-not (Test-Path -LiteralPath $manifestFull)) { break }
            $built = & $detector.build $manifestFull $entry.path $relDir
            if ($null -eq $built) { break }
            $resolved = @{
                detectorName = $detector.name
                manifestPath = $entry.path
                name         = $built.name
                type         = $built.type
                metadata     = $built.metadata
            }
            break
        }
        if ($null -eq $resolved) { continue }
        if ($resolved.metadata.Contains('monorepoTool') -and $resolved.type -eq 'npm-package' -and $resolved.detectorName -ne 'package-json') {
            # workspace marker file: merge into the directory's primary module
            if (-not $markers.Contains($relDir)) { $markers[$relDir] = @() }
            $markers[$relDir] = @($markers[$relDir]) + @($resolved)
            continue
        }
        if (-not $byDir.Contains($relDir)) {
            $byDir[$relDir] = @()
        }
        $byDir[$relDir] = @($byDir[$relDir]) + @($resolved)
    }

    $modules = @()
    foreach ($relDir in $byDir.Keys) {
        $candidates = @($byDir[$relDir])
        $primary = $candidates[0]
        $metadata = [ordered]@{}
        foreach ($kv in $primary.metadata.Keys) { $metadata[$kv] = $primary.metadata[$kv] }
        $metadata.detector = $primary.detectorName
        $extraManifests = @()
        foreach ($extra in ($candidates | Select-Object -Skip 1)) {
            $extraManifests = @($extraManifests) + @($extra.manifestPath)
        }
        if ($extraManifests.Count -gt 0) { $metadata.coManifests = $extraManifests }
        if ($markers.Contains($relDir)) {
            $mergedMarkers = @()
            foreach ($marker in $markers[$relDir]) {
                $mergedMarkers = @($mergedMarkers) + @($marker.detectorName)
                if ($marker.metadata.Contains('packages')) { $metadata.workspaces = @($marker.metadata.packages) }
            }
            $metadata.monorepoMarkers = $mergedMarkers
        }
        $moduleName = $primary.name
        if ([string]::IsNullOrWhiteSpace($moduleName)) {
            $moduleName = if ($relDir -eq '') { $RepositoryName } else { ($relDir.Split('/')[-1]) }
        }
        $modules = @($modules) + @([ordered]@{
            path         = $relDir
            name         = $moduleName
            type         = $primary.type
            manifestPath = $primary.manifestPath
            metadata     = $metadata
        })
    }

    # markers without a primary module in their directory become generic modules
    foreach ($relDir in $markers.Keys) {
        if ($byDir.Contains($relDir)) { continue }
        foreach ($marker in $markers[$relDir]) {
            $metadata = [ordered]@{ detector = $marker.detectorName }
            foreach ($kv in $marker.metadata.Keys) { $metadata[$kv] = $marker.metadata[$kv] }
            $modules = @($modules) + @([ordered]@{
                path         = $relDir
                name         = $(if ($relDir -eq '') { $RepositoryName } else { ($relDir.Split('/')[-1]) })
                type         = 'generic'
                manifestPath = $marker.manifestPath
                metadata     = $metadata
            })
        }
    }

    # generic root fallback keeps every repository addressable
    $hasRoot = $false
    foreach ($module in $modules) { if ($module.path -eq '') { $hasRoot = $true; break } }
    if (-not $hasRoot) {
        $modules = @($modules) + @([ordered]@{
            path         = ''
            name         = $RepositoryName
            type         = 'generic'
            manifestPath = $null
            metadata     = [ordered]@{ detector = 'root-fallback' }
        })
    }

    $ordered = @($modules | Sort-Object -Property { [string]$_.path })
    return [pscustomobject][ordered]@{
        modules = $ordered
        stats   = [pscustomobject][ordered]@{ discoveredModules = $ordered.Count }
    }
}
