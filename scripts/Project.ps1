Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AihRelativePath {
    param([string]$Root, [string]$Path)

    $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $pathValue = [System.IO.Path]::GetFullPath($Path)
    $rootUri = [Uri]$rootPath
    $pathUri = [Uri]$pathValue
    [Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString()).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

function Get-AihWorkspaceFiles {
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $rg = Get-Command rg -ErrorAction SilentlyContinue
    if ($null -ne $rg) {
        Push-Location $Workspace
        try {
            return @(& $rg.Source --files --hidden -g '!**/.git/**' -g '!**/node_modules/**' -g '!**/.venv/**' -g '!**/venv/**' -g '!**/target/**' -g '!**/bin/**' -g '!**/obj/**' -g '!**/dist/**' -g '!**/build/**' | ForEach-Object { $_.Replace('/', '\') })
        }
        finally { Pop-Location }
    }

    # Get-ChildItem -Recurse can terminate the entire scan when it encounters a
    # broken reparse point or a directory that Windows cannot enumerate. Walk one
    # directory at a time so a bad entry only excludes that subtree. This also
    # prevents expensive excluded trees from being traversed before filtering.
    $excluded = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @('.git', 'node_modules', '.venv', 'venv', 'target', 'bin', 'obj', 'dist', 'build')) { [void]$excluded.Add($name) }
    $pending = [System.Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($Workspace)
    $files = [System.Collections.Generic.List[string]]::new()
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue()
        try { $entries = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) }
        catch { continue }
        foreach ($entry in $entries) {
            if ($entry.PSIsContainer) {
                if ($excluded.Contains($entry.Name) -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
                $pending.Enqueue($entry.FullName)
                continue
            }
            try { $files.Add((Get-AihRelativePath -Root $Workspace -Path $entry.FullName)) }
            catch { continue }
        }
    }
    return @($files)
}

function Test-AihExecutable {
    param([string]$Executable, [string]$WorkingDirectory)

    if ($Executable -match '[\\/]') {
        return Test-Path -LiteralPath (Join-Path $WorkingDirectory $Executable) -PathType Leaf
    }
    return $null -ne (Get-Command $Executable -ErrorAction SilentlyContinue)
}

function New-AihVerificationCommand {
    param(
        [string]$Name,
        [string]$Kind,
        [string]$WorkingDirectory,
        [string]$Executable,
        [string[]]$Arguments,
        [string]$Source,
        [bool]$Required = $true,
        [int]$TimeoutSeconds = 1200,
        [string]$ShellCommand
    )

    $display = if (-not [string]::IsNullOrWhiteSpace($ShellCommand)) {
        $ShellCommand
    }
    else {
        (@($Executable) + @($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_.Replace('"', '\"') + '"' } else { $_ } })) -join ' '
    }
    [pscustomobject]@{
        Name = $Name
        Kind = $Kind
        WorkingDirectory = $WorkingDirectory
        Executable = $Executable
        Arguments = @($Arguments)
        ShellCommand = $ShellCommand
        Display = $display
        Source = $Source
        Required = $Required
        TimeoutSeconds = $TimeoutSeconds
        Available = if (-not [string]::IsNullOrWhiteSpace($ShellCommand)) { $true } else { Test-AihExecutable -Executable $Executable -WorkingDirectory $WorkingDirectory }
    }
}

function Add-AihStack {
    param([System.Collections.Generic.List[string]]$Stacks, [string]$Stack)
    if (-not $Stacks.Contains($Stack)) { $Stacks.Add($Stack) }
}

function Add-AihCommand {
    param([System.Collections.Generic.List[object]]$Commands, [object]$Command)
    if (-not @($Commands | Where-Object { $_.Name -eq $Command.Name -and $_.WorkingDirectory -eq $Command.WorkingDirectory }).Count) {
        $Commands.Add($Command)
    }
}

function Get-AihNodeCommands {
    param([string]$Workspace, [string[]]$Files, [System.Collections.Generic.List[string]]$Stacks, [System.Collections.Generic.List[object]]$Commands)

    $manifests = @($Files | Where-Object { (Split-Path -Leaf $_) -eq 'package.json' } | Sort-Object { ($_ -split '[\\/]').Count })
    if ($manifests.Count -eq 0) { return }
    Add-AihStack $Stacks 'Node.js'
    $rootKinds = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($relative in $manifests) {
        $path = Join-Path $Workspace $relative
        try { $package = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json } catch { continue }
        $directoryRelative = Split-Path -Parent $relative
        if ([string]::IsNullOrWhiteSpace($directoryRelative)) { $directoryRelative = '.' }
        $workingDirectory = [System.IO.Path]::GetFullPath((Join-Path $Workspace $directoryRelative))
        $packageManager = if ($null -ne $package.PSObject.Properties['packageManager']) { [string]$package.packageManager } else { '' }
        $manager = if ($packageManager -match '^(npm|pnpm|yarn|bun)@') { $Matches[1] }
            elseif (Test-Path -LiteralPath (Join-Path $workingDirectory 'pnpm-lock.yaml')) { 'pnpm' }
            elseif (Test-Path -LiteralPath (Join-Path $workingDirectory 'yarn.lock')) { 'yarn' }
            elseif (Test-Path -LiteralPath (Join-Path $workingDirectory 'bun.lockb')) { 'bun' }
            else { 'npm' }
        $scripts = if ($null -ne $package.PSObject.Properties['scripts']) { $package.scripts } else { $null }
        if ($null -eq $scripts) { continue }
        $scriptMap = [ordered]@{
            build = 'build'
            test = 'test'
            typecheck = 'typecheck'
            lint = 'lint'
            'test:integration' = 'integration'
            verify = 'verify'
            check = 'verify'
        }
        foreach ($entry in $scriptMap.GetEnumerator()) {
            if ($null -eq $scripts.PSObject.Properties[$entry.Key]) { continue }
            $isRoot = $directoryRelative -eq '.'
            if (-not $isRoot -and $rootKinds.Contains($entry.Value)) { continue }
            if ($isRoot) { [void]$rootKinds.Add($entry.Value) }
            $suffix = if ($isRoot) { '' } else { ' (' + $directoryRelative.Replace('\', '/') + ')' }
            Add-AihCommand $Commands (New-AihVerificationCommand -Name ("node:$($entry.Key)$suffix") -Kind $entry.Value -WorkingDirectory $workingDirectory -Executable $manager -Arguments @('run', $entry.Key) -Source $relative)
        }
    }
}

function Get-AihDotNetCommands {
    param([string]$Workspace, [string[]]$Files, [System.Collections.Generic.List[string]]$Stacks, [System.Collections.Generic.List[object]]$Commands)

    $solutions = @($Files | Where-Object { $_ -match '\.(sln|slnx)$' } | Sort-Object)
    $projects = @($Files | Where-Object { $_ -match '\.(csproj|fsproj|vbproj)$' } | Sort-Object)
    if ($solutions.Count -eq 0 -and $projects.Count -eq 0) { return }
    Add-AihStack $Stacks '.NET'
    $target = if ($solutions.Count -gt 0) { $solutions[0] } elseif ($projects.Count -eq 1) { $projects[0] } else { '.' }
    Add-AihCommand $Commands (New-AihVerificationCommand -Name 'dotnet:build' -Kind 'build' -WorkingDirectory $Workspace -Executable 'dotnet' -Arguments @('build', $target, '--nologo') -Source $target)
    $testProjects = @($projects | Where-Object {
        $_ -match '(?i)(test|tests|spec)\.(csproj|fsproj|vbproj)$' -or
        (Get-Content -Raw -LiteralPath (Join-Path $Workspace $_) -ErrorAction SilentlyContinue) -match '(Microsoft\.NET\.Test\.Sdk|<IsTestProject>true</IsTestProject>)'
    })
    if ($testProjects.Count -gt 0) {
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'dotnet:test' -Kind 'test' -WorkingDirectory $Workspace -Executable 'dotnet' -Arguments @('test', $target, '--no-build', '--nologo') -Source ($testProjects -join ', '))
    }
}

function Get-AihPythonCommands {
    param([string]$Workspace, [string[]]$Files, [System.Collections.Generic.List[string]]$Stacks, [System.Collections.Generic.List[object]]$Commands)

    $markers = @('pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'poetry.lock', 'uv.lock')
    $present = @($Files | Where-Object { $markers -contains (Split-Path -Leaf $_) -or $_ -match '(^|[\\/])(pytest\.ini|tox\.ini)$' })
    if ($present.Count -eq 0) { return }
    Add-AihStack $Stacks 'Python'
    $python = if ($null -ne (Get-Command py -ErrorAction SilentlyContinue)) { 'py' } else { 'python' }
    $prefix = if ($python -eq 'py') { @('-3', '-m') } else { @('-m') }
    $manifestText = ($present | ForEach-Object { Get-Content -Raw -LiteralPath (Join-Path $Workspace $_) -ErrorAction SilentlyContinue }) -join "`n"
    if ($manifestText -match '(?im)(pytest|\[tool\.pytest|pytest\.ini)') {
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'python:pytest' -Kind 'test' -WorkingDirectory $Workspace -Executable $python -Arguments (@($prefix) + @('pytest')) -Source ($present -join ', '))
    }
    if ($manifestText -match '(?im)(ruff|\[tool\.ruff)') {
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'python:ruff' -Kind 'lint' -WorkingDirectory $Workspace -Executable $python -Arguments (@($prefix) + @('ruff', 'check', '.')) -Source ($present -join ', '))
    }
    if ($manifestText -match '(?im)(mypy|\[tool\.mypy)') {
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'python:mypy' -Kind 'typecheck' -WorkingDirectory $Workspace -Executable $python -Arguments (@($prefix) + @('mypy', '.')) -Source ($present -join ', '))
    }
}

function Get-AihConventionalCommands {
    param([string]$Workspace, [string[]]$Files, [System.Collections.Generic.List[string]]$Stacks, [System.Collections.Generic.List[object]]$Commands)

    if ($Files -contains 'Cargo.toml') {
        Add-AihStack $Stacks 'Rust'
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'rust:build' -Kind 'build' -WorkingDirectory $Workspace -Executable 'cargo' -Arguments @('build', '--workspace') -Source 'Cargo.toml')
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'rust:test' -Kind 'test' -WorkingDirectory $Workspace -Executable 'cargo' -Arguments @('test', '--workspace') -Source 'Cargo.toml')
    }
    if ($Files -contains 'go.mod') {
        Add-AihStack $Stacks 'Go'
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'go:build' -Kind 'build' -WorkingDirectory $Workspace -Executable 'go' -Arguments @('build', './...') -Source 'go.mod')
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'go:test' -Kind 'test' -WorkingDirectory $Workspace -Executable 'go' -Arguments @('test', './...') -Source 'go.mod')
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'go:vet' -Kind 'lint' -WorkingDirectory $Workspace -Executable 'go' -Arguments @('vet', './...') -Source 'go.mod')
    }
    if ($Files -contains 'pom.xml') {
        Add-AihStack $Stacks 'Java/Maven'
        $maven = if (Test-Path -LiteralPath (Join-Path $Workspace 'mvnw.cmd')) { '.\mvnw.cmd' } else { 'mvn' }
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'maven:test' -Kind 'test' -WorkingDirectory $Workspace -Executable $maven -Arguments @('--batch-mode', 'test') -Source 'pom.xml')
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'maven:package' -Kind 'build' -WorkingDirectory $Workspace -Executable $maven -Arguments @('--batch-mode', '-DskipTests', 'package') -Source 'pom.xml')
    }
    $gradleFile = @($Files | Where-Object { $_ -in @('build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts') } | Select-Object -First 1)
    if ($gradleFile.Count -gt 0) {
        Add-AihStack $Stacks 'Java/Gradle'
        $gradle = if (Test-Path -LiteralPath (Join-Path $Workspace 'gradlew.bat')) { '.\gradlew.bat' } else { 'gradle' }
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'gradle:check' -Kind 'verify' -WorkingDirectory $Workspace -Executable $gradle -Arguments @('--no-daemon', 'check') -Source $gradleFile[0])
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'gradle:assemble' -Kind 'build' -WorkingDirectory $Workspace -Executable $gradle -Arguments @('--no-daemon', 'assemble') -Source $gradleFile[0])
    }
    if ($Files -contains 'pubspec.yaml') {
        Add-AihStack $Stacks 'Flutter/Dart'
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'flutter:analyze' -Kind 'lint' -WorkingDirectory $Workspace -Executable 'flutter' -Arguments @('analyze') -Source 'pubspec.yaml')
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'flutter:test' -Kind 'test' -WorkingDirectory $Workspace -Executable 'flutter' -Arguments @('test') -Source 'pubspec.yaml')
    }
    if ($Files -contains 'CMakeLists.txt') { Add-AihStack $Stacks 'CMake/C++' }
    if (@($Files | Where-Object { (Split-Path -Leaf $_) -eq 'Dockerfile' }).Count -gt 0) { Add-AihStack $Stacks 'Docker' }
    $compose = @($Files | Where-Object { (Split-Path -Leaf $_) -in @('compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml') } | Select-Object -First 1)
    if ($compose.Count -gt 0) {
        Add-AihStack $Stacks 'Docker Compose'
        Add-AihCommand $Commands (New-AihVerificationCommand -Name 'docker:compose-config' -Kind 'verify' -WorkingDirectory $Workspace -Executable 'docker' -Arguments @('compose', '-f', $compose[0], 'config', '--quiet') -Source $compose[0])
    }
}

function Get-AihLocalVerification {
    param([string]$Workspace, [string]$InstallRoot)

    $path = Join-Path $Workspace '.ai-harness\verification.yml'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $layout = Get-AihLayout $InstallRoot
    $reader = Join-Path $layout.Scripts 'Read-Verification.mjs'
    if (-not (Test-Path -LiteralPath $reader)) { $reader = Join-Path $PSScriptRoot 'Read-Verification.mjs' }
    $json = & $layout.Node $reader $path $layout.Root 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Invalid .ai-harness/verification.yml: $($json -join [Environment]::NewLine)" }
    return ($json -join [Environment]::NewLine) | ConvertFrom-Json
}

function Get-AihProjectProfile {
    param(
        [string]$Workspace = (Get-Location).Path,
        [string]$InstallRoot = 'C:\AI-Harness'
    )

    $resolvedWorkspace = [System.IO.Path]::GetFullPath($Workspace)
    if (-not (Test-Path -LiteralPath $resolvedWorkspace -PathType Container)) { throw "Workspace does not exist: $resolvedWorkspace" }
    $files = @(Get-AihWorkspaceFiles -Workspace $resolvedWorkspace)
    $stacks = [System.Collections.Generic.List[string]]::new()
    $commands = [System.Collections.Generic.List[object]]::new()
    Get-AihNodeCommands -Workspace $resolvedWorkspace -Files $files -Stacks $stacks -Commands $commands
    Get-AihDotNetCommands -Workspace $resolvedWorkspace -Files $files -Stacks $stacks -Commands $commands
    Get-AihPythonCommands -Workspace $resolvedWorkspace -Files $files -Stacks $stacks -Commands $commands
    Get-AihConventionalCommands -Workspace $resolvedWorkspace -Files $files -Stacks $stacks -Commands $commands

    $local = Get-AihLocalVerification -Workspace $resolvedWorkspace -InstallRoot $InstallRoot
    if ($null -ne $local) {
        $customCommands = [System.Collections.Generic.List[object]]::new()
        foreach ($entry in $local.commands) {
            $workingDirectory = [System.IO.Path]::GetFullPath((Join-Path $resolvedWorkspace $entry.workingDirectory))
            if (-not $workingDirectory.StartsWith($resolvedWorkspace.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and $workingDirectory -ne $resolvedWorkspace) {
                throw "verification command working directory escapes workspace: $($entry.workingDirectory)"
            }
            Add-AihCommand $customCommands (New-AihVerificationCommand -Name $entry.name -Kind $entry.kind -WorkingDirectory $workingDirectory -ShellCommand $entry.command -Source '.ai-harness/verification.yml' -Required $entry.required -TimeoutSeconds $entry.timeoutSeconds)
        }
        if ($local.mode -eq 'replace') { $commands = $customCommands } else { foreach ($command in $customCommands) { Add-AihCommand $commands $command } }
    }

    $gitRoot = $null
    try {
        $candidate = (& git -C $resolvedWorkspace rev-parse --show-toplevel 2>$null | Select-Object -First 1)
        if (-not [string]::IsNullOrWhiteSpace($candidate)) { $gitRoot = [System.IO.Path]::GetFullPath($candidate) }
    }
    catch {}
    $configFiles = @('project.md', 'architecture.md', 'conventions.md', 'verification.yml') | Where-Object { Test-Path -LiteralPath (Join-Path $resolvedWorkspace ".ai-harness\$_") }
    [pscustomobject]@{
        Workspace = $resolvedWorkspace
        Name = Split-Path -Leaf $resolvedWorkspace
        GitRoot = $gitRoot
        IsGitRepository = $null -ne $gitRoot
        Stacks = @($stacks)
        DescriptorFiles = @($files | Where-Object { (Split-Path -Leaf $_) -in @('package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'Dockerfile', 'docker-compose.yml', 'compose.yml', 'pubspec.yaml') -or $_ -match '\.(sln|slnx|csproj)$' } | Sort-Object)
        VerificationCommands = @($commands)
        LocalConfigFiles = @($configFiles)
        LocalVerificationMode = if ($null -eq $local) { 'auto' } else { $local.mode }
        Recommendations = @(
            if (-not (Test-Path -LiteralPath (Join-Path $resolvedWorkspace '.ai-harness\project.md'))) { 'Add .ai-harness/project.md for the project purpose and acceptance context.' }
            if (-not (Test-Path -LiteralPath (Join-Path $resolvedWorkspace '.ai-harness\architecture.md'))) { 'Add .ai-harness/architecture.md for system boundaries and data flow.' }
            if (-not (Test-Path -LiteralPath (Join-Path $resolvedWorkspace '.ai-harness\conventions.md'))) { 'Add .ai-harness/conventions.md for repository-specific engineering rules.' }
            if ($commands.Count -eq 0) { 'Add .ai-harness/verification.yml because no deterministic commands were discovered.' }
        )
    }
}

function Format-AihProjectContext {
    param([Parameter(Mandatory = $true)][object]$Profile, [int]$MaxCharacters = 20000)

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("Project workspace: $($Profile.Workspace)")
    $lines.Add("Detected stacks: $(if ($Profile.Stacks.Count) { $Profile.Stacks -join ', ' } else { 'unknown' })")
    $lines.Add("Verification mode: $($Profile.LocalVerificationMode)")
    if ($Profile.VerificationCommands.Count) {
        $lines.Add('Deterministic verification commands:')
        foreach ($command in $Profile.VerificationCommands) {
            $availability = if ($command.Available) { 'available' } else { 'tool missing' }
            $lines.Add("- [$($command.Kind)] $($command.Display) (cwd: $($command.WorkingDirectory); $availability)")
        }
    }
    foreach ($name in @('project.md', 'architecture.md', 'conventions.md')) {
        $path = Join-Path $Profile.Workspace ".ai-harness\$name"
        if (Test-Path -LiteralPath $path) {
            $content = Get-Content -Raw -LiteralPath $path
            $lines.Add("`n.ai-harness/${name}:`n$content")
        }
    }
    if ($Profile.Recommendations.Count) {
        $lines.Add("`nConfiguration recommendations:")
        foreach ($recommendation in $Profile.Recommendations) { $lines.Add("- $recommendation") }
    }
    $text = $lines -join "`n"
    if ($text.Length -gt $MaxCharacters) { return $text.Substring(0, $MaxCharacters) + "`n[project context truncated]" }
    return $text
}
