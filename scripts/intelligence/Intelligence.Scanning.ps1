Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── File Inventory (Phase 3.1C) ──────────────────────────────────────────────
# Deterministic scanner. No language parsing, no AI. Produces a stable
# inventory: normalized repository-relative POSIX paths, stable content hashes
# (never mtime-derived), classification, sensitivity, binary flag, and
# indexability state. Ignore rules are applied in layers:
#   1. Nexus defaults (build/cache/vendor directories)
#   2. per-directory .gitignore (when respect_gitignore)
#   3. .nexus.yml 'exclude' globs
#   4. per-directory .nexusignore
# Later layers may re-include paths excluded by earlier layers (last match
# wins). Git-tracked files bypass the ignore decision entirely.

function Get-AihDefaultIgnorePatterns {
    # Non-exhaustive baseline; repositories extend it via .nexusignore and
    # .nexus.yml. Order matters only for readability (last match wins).
    return @(
        '.git/', 'node_modules/', '.next/', 'dist/', 'build/', 'bin/', 'obj/',
        'out/', 'coverage/', '__pycache__/', '.pytest_cache/', '.mypy_cache/',
        '.ruff_cache/', '.cache/', '.venv/', 'venv/', 'target/', '.gradle/',
        '.terraform/', 'vendor/', '.idea/', '.vs/', '.nexus/',
        '.DS_Store', 'Thumbs.db', 'desktop.ini', '*.pyc', '*.pyo', '*.class',
        '*.swp', '*~', '*.tmp'
    )
}

function ConvertTo-AihGlobRegex {
    # Translates a gitignore-style glob into a regular expression source.
    # Supports: '*' (within segment), '?' (single char), '**' (across segments),
    # leading '/' anchor, trailing '/' directory-only flag is handled by caller.
    param([Parameter(Mandatory = $true)][string]$Glob)
    $source = ''
    $i = 0
    while ($i -lt $Glob.Length) {
        $ch = $Glob[$i]
        if ($ch -eq '*') {
            if ($i + 1 -lt $Glob.Length -and $Glob[$i + 1] -eq '*') {
                if ($i + 2 -lt $Glob.Length -and $Glob[$i + 2] -eq '/') {
                    $source = $source + '(?:.*/)?'
                    $i = $i + 3
                    continue
                }
                $source = $source + '.*'
                $i = $i + 2
                continue
            }
            $source = $source + '[^/]*'
            $i = $i + 1
            continue
        }
        if ($ch -eq '?') { $source = $source + '[^/]'; $i = $i + 1; continue }
        $escaped = [regex]::Escape("$ch")
        $source = $source + $escaped
        $i = $i + 1
    }
    return $source
}

function Test-AihIgnorePattern {
    # Evaluates one ignore rule against one repository-relative path.
    # $BaseDir is the directory (repository-relative) the rule originates from;
    # the rule only applies to paths under it.
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Pattern,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$RelPath,
        [Parameter(Mandatory = $true)][bool]$IsDirectory,
        [Parameter(Mandatory = $true)][bool]$CaseInsensitive,
        [string]$BaseDir = ''
    )
    $pattern = $Pattern.Trim()
    if ($pattern -eq '' -or $pattern.StartsWith('#')) { return @{ match = $false; negate = $false } }
    $negate = $pattern.StartsWith('!')
    if ($negate) { $pattern = $pattern.Substring(1).Trim() }
    if ($pattern -eq '') { return @{ match = $false; negate = $false } }
    $dirOnly = $pattern.EndsWith('/')
    if ($dirOnly) { $pattern = $pattern.TrimEnd('/') }
    $anchored = $false
    if ($pattern.StartsWith('/')) { $anchored = $true; $pattern = $pattern.TrimStart('/') }
    if ($pattern.Contains('/')) { $anchored = $true }

    $comparison = if ($CaseInsensitive) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $target = $RelPath
    if (-not [string]::IsNullOrEmpty($BaseDir)) {
        $prefix = $BaseDir.TrimEnd('/') + '/'
        if (-not $target.StartsWith($prefix, $comparison)) { return @{ match = $false; negate = $false } }
        $target = $target.Substring($prefix.Length)
    }
    if ($dirOnly -and -not $IsDirectory) {
        # a directory-only rule matches the directory itself; pruning removes
        # everything below it, so files never need to match this rule
        return @{ match = $false; negate = $false }
    }
    if (-not $anchored) {
        # unanchored patterns match the basename at any depth
        $idx = $target.LastIndexOf('/')
        if ($idx -ge 0) { $target = $target.Substring($idx + 1) }
    }

    $regex = '^' + (ConvertTo-AihGlobRegex $pattern) + '$'
    $options = if ($CaseInsensitive) { [Text.RegularExpressions.RegexOptions]::IgnoreCase } else { [Text.RegularExpressions.RegexOptions]::None }
    $matched = [regex]::IsMatch($target, $regex, $options)
    return @{ match = $matched; negate = $negate }
}

function Get-AihIgnoreDecision {
    # Ordered decision: rules are evaluated by their explicit order; the LAST
    # matching rule wins, negations included, so later layers may deliberately
    # re-include paths excluded by earlier layers. No match => include.
    # Exposed fields let the walker reason about re-inclusion under pruned
    # directories (matchedOrder, matchedNegate).
    param(
        [Parameter(Mandatory = $true)][string]$RelPath,
        [Parameter(Mandatory = $true)][bool]$IsDirectory,
        [Parameter(Mandatory = $true)]$Rules,
        [bool]$CaseInsensitive = $(if (Test-AihWindowsPlatform) { $true } else { $false })
    )
    $decided = @{ excluded = $false; matched = $false; layer = $null; matchedOrder = -1.0; matchedNegate = $false }
    foreach ($rule in $Rules) {
        if ([string]::IsNullOrWhiteSpace($rule.pattern)) { continue }
        $outcome = Test-AihIgnorePattern -Pattern $rule.pattern -RelPath $RelPath -IsDirectory $IsDirectory -CaseInsensitive $CaseInsensitive -BaseDir $rule.base
        if ($outcome.match) {
            $decided.excluded = -not $outcome.negate
            $decided.matched = $true
            $decided.layer = $rule.source
            $decided.matchedOrder = [double]$rule.order
            $decided.matchedNegate = [bool]$outcome.negate
        }
    }
    return $decided
}

function Test-AihNegationMayApply {
    # True when some negation rule ordered AFTER $MatchedOrder could match a
    # path inside directory $DirRel. Used to decide whether an excluded
    # directory must still be descended into (later layers may re-include).
    param(
        [Parameter(Mandatory = $true)]$Rules,
        [Parameter(Mandatory = $true)][double]$MatchedOrder,
        [Parameter(Mandatory = $true)][string]$DirRel
    )
    foreach ($rule in $Rules) {
        if (-not $rule.negate) { continue }
        if ([double]$rule.order -le $MatchedOrder) { continue }
        $base = "$($rule.base)"
        if ([string]::IsNullOrEmpty($base)) { return $true }
        if ([string]::IsNullOrEmpty($DirRel)) { continue }
        if ($base -eq $DirRel) { return $true }
        if ($base.StartsWith($DirRel + '/', [StringComparison]::OrdinalIgnoreCase) -or $DirRel.StartsWith($base + '/', [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Resolve-AihRepositoryConfig {
    # Loads the optional .nexus.yml/.nexus.yaml and merges it over defaults.
    # Unknown or malformed entries are surfaced in ConfigErrors; recognized
    # values override defaults. The repository must work without the file.
    param([Parameter(Mandatory = $true)][string]$CheckoutRoot)
    $config = [pscustomobject][ordered]@{
        respectGitignore      = $true
        exclude               = @()
        maxFileBytes          = 2MB
        sampleBytes           = 65536
        binarySampleBytes     = 8192
        modulesAutoDetect     = $true
        repositoryName        = $null
        securityExternalContext = $false
        blockedGlobs          = @()
        sensitiveGlobs        = @()
        contextExcludeGlobs   = @()
        configErrors          = @()
        configFile            = $null
    }
    $path = $null
    foreach ($candidate in @('.nexus.yml', '.nexus.yaml')) {
        $probe = Join-Path $CheckoutRoot $candidate
        if (Test-Path -LiteralPath $probe) { $path = $probe; break }
    }
    if ($null -eq $path) { return $config }
    $config.configFile = (Split-Path -Leaf $path)
    $text = Get-AihOptionalText -Path $path
    if ([string]::IsNullOrEmpty($text)) { return $config }
    $parsed = $null
    try { $parsed = ConvertFrom-AihSimpleYaml -Content $text }
    catch {
        $config.configErrors = @($config.configErrors) + @("configuration could not be parsed: $($_.Exception.Message)")
        return $config
    }
    if ($parsed.Contains('version') -and $null -ne $parsed['version'] -and "$($parsed['version'])" -ne '1') {
        $config.configErrors = @($config.configErrors) + @("unsupported configuration version: $($parsed['version'])")
        return $config
    }
    if ($parsed.Contains('exclude') -and $null -ne $parsed['exclude']) {
        $config.exclude = @($parsed['exclude'] | ForEach-Object { "$_" } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    if ($parsed.Contains('repository') -and $null -ne $parsed['repository'] -and $parsed['repository'] -is [System.Collections.IDictionary]) {
        if ($parsed['repository'].Contains('name') -and $null -ne $parsed['repository']['name']) {
            $config.repositoryName = "$($parsed['repository']['name'])"
        }
    }
    if ($parsed.Contains('index') -and $null -ne $parsed['index'] -and $parsed['index'] -is [System.Collections.IDictionary]) {
        if ($parsed['index'].Contains('respect_gitignore')) { $config.respectGitignore = [bool]$parsed['index']['respect_gitignore'] }
        if ($parsed['index'].Contains('max_file_bytes')) { $config.maxFileBytes = [long]$parsed['index']['max_file_bytes'] }
        if ($parsed['index'].Contains('sample_bytes')) { $config.sampleBytes = [long]$parsed['index']['sample_bytes'] }
        # canonical location for exclude globs; a top-level 'exclude:' is
        # tolerated for compatibility but index.exclude wins when both exist
        if ($parsed['index'].Contains('exclude') -and $null -ne $parsed['index']['exclude']) {
            $config.exclude = @($parsed['index']['exclude'] | ForEach-Object { "$_" } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        }
    }
    if ($parsed.Contains('modules') -and $null -ne $parsed['modules'] -and $parsed['modules'] -is [System.Collections.IDictionary]) {
        if ($parsed['modules'].Contains('autodetect')) { $config.modulesAutoDetect = [bool]$parsed['modules']['autodetect'] }
    }
    # TASK-0009: ordered context-exclusion globs for review/search context
    # eligibility (ContextEngine). These never affect Phase 3.1 indexing
    # semantics; '!' negations re-include paths excluded by earlier layers.
    if ($parsed.Contains('context') -and $null -ne $parsed['context'] -and $parsed['context'] -is [System.Collections.IDictionary]) {
        if ($parsed['context'].Contains('exclude_globs') -and $null -ne $parsed['context']['exclude_globs']) {
            $config.contextExcludeGlobs = @($parsed['context']['exclude_globs'] | ForEach-Object { "$_" } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        }
    }
    if ($parsed.Contains('security') -and $null -ne $parsed['security'] -and $parsed['security'] -is [System.Collections.IDictionary]) {
        if ($parsed['security'].Contains('external_context')) { $config.securityExternalContext = [bool]$parsed['security']['external_context'] }
        if ($parsed['security'].Contains('blocked_globs')) { $config.blockedGlobs = @($parsed['security']['blocked_globs'] | ForEach-Object { "$_" }) }
        if ($parsed['security'].Contains('sensitive_globs')) { $config.sensitiveGlobs = @($parsed['security']['sensitive_globs'] | ForEach-Object { "$_" }) }
    }
    foreach ($known in @('version', 'repository', 'index', 'exclude', 'modules', 'security', 'context')) {
        if ($parsed.Contains($known)) { $parsed.Remove($known) }
    }
    foreach ($unexpected in @($parsed.Keys)) {
        $config.configErrors = @($config.configErrors) + @("unknown configuration key '$unexpected' was ignored")
    }
    return $config
}

function Test-AihBinarySample {
    param([byte[]]$Bytes)
    $controlCount = 0
    $length = $Bytes.Length
    if ($length -eq 0) { return $false }
    for ($i = 0; $i -lt $length; $i++) {
        $b = $Bytes[$i]
        if ($b -eq 0) { return $true }
        if ($b -lt 9 -or ($b -gt 13 -and $b -lt 27) -or ($b -gt 27 -and $b -lt 32)) { $controlCount = $controlCount + 1 }
    }
    return (($controlCount / $length) -gt 0.3)
}

function Get-AihFileSensitivity {
    param([Parameter(Mandatory = $true)][string]$RelPath, $Config)
    $blocked = @(
        '.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', '*.pfx', '*.keystore', '*.jks',
        'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '*.git-credentials', '.netrc',
        'secrets.json', 'secrets.yaml', 'secrets.yml', 'secrets.toml'
    )
    $potential = @(
        '*.crt', '*.cer', '*.csr', '*credentials*', '*secret*', '*token*', '.npmrc', '.pypirc',
        '*password*', 'appsettings.secrets.json'
    )
    if ($null -ne $Config) {
        $blocked = @($blocked) + @($Config.blockedGlobs)
        $potential = @($potential) + @($Config.sensitiveGlobs)
    }
    # Sensitivity matching is deliberately case-insensitive on every platform:
    # a secret must not be missed because of filename casing.
    foreach ($pattern in $blocked) {
        $outcome = Test-AihIgnorePattern -Pattern $pattern -RelPath $RelPath -IsDirectory $false -CaseInsensitive $true
        if ($outcome.match) { return 'blocked' }
    }
    foreach ($pattern in $potential) {
        $outcome = Test-AihIgnorePattern -Pattern $pattern -RelPath $RelPath -IsDirectory $false -CaseInsensitive $true
        if ($outcome.match) { return 'potential_secret' }
    }
    return 'normal'
}

function Get-AihFileClassification {
    param([Parameter(Mandatory = $true)][string]$RelPath, [bool]$IsBinary, $Config)
    $lower = $RelPath.ToLowerInvariant()
    $basename = $lower
    $idx = $lower.LastIndexOf('/')
    if ($idx -ge 0) { $basename = $lower.Substring($idx + 1) }
    $ext = ''
    $dot = $basename.LastIndexOf('.')
    if ($dot -ge 0) { $ext = $basename.Substring($dot) }
    $segments = @($lower.Split('/') | Where-Object { $_ -ne '' })

    foreach ($pattern in @('*.min.js', '*.min.css', '*.map', '*.g.cs', '*.generated.cs', '*.designer.cs', '*.g.vb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'cargo.lock', 'composer.lock', '*.bak')) {
        $outcome = Test-AihIgnorePattern -Pattern $pattern -RelPath $lower -IsDirectory $false -CaseInsensitive $true
        if ($outcome.match) { return 'generated' }
    }
    if ($segments -contains 'vendor' -or $segments -contains 'third_party' -or $segments -contains 'external') { return 'vendor' }
    if ($segments -contains 'test' -or $segments -contains 'tests' -or $segments -contains '__tests__' -or $segments -contains 'spec' -or $segments -contains 'specs') { return 'test' }
    foreach ($pattern in @('*.test.*', '*.spec.*', '*_test.go', 'test_*.py', '*_test.py')) {
        $outcome = Test-AihIgnorePattern -Pattern $pattern -RelPath $lower -IsDirectory $false -CaseInsensitive $true
        if ($outcome.match) { return 'test' }
    }
    if ($segments -contains 'docs' -or $segments -contains 'documentation') { return 'documentation' }
    foreach ($pattern in @('*.md', '*.mdx', '*.rst', '*.adoc', 'readme*', 'changelog*', 'license*', 'contributing*', 'authors*', 'notice*', 'code_of_conduct*')) {
        $outcome = Test-AihIgnorePattern -Pattern $pattern -RelPath $lower -IsDirectory $false -CaseInsensitive $true
        if ($outcome.match) { return 'documentation' }
    }
    foreach ($pattern in @(
        '*.json', '*.yml', '*.yaml', '*.toml', '*.ini', '*.cfg', '*.conf', '*.xml', '*.plist',
        '*.sln', '*.csproj', '*.fsproj', '*.vbproj', '*.props', '*.targets', '*.gradle', '*.gradle.kts',
        '*.env', '.env*', '.gitignore', '.gitattributes', '.editorconfig', '.nexusignore', '.nexus.yml', '.nexus.yaml',
        'dockerfile*', 'docker-compose*', 'makefile', 'vagrantfile', 'procfile', '*.config.js', '*.config.ts', '*.config.mjs',
        'requirements*.txt', 'go.sum', 'gemfile', 'gemfile.lock', '*.sqlproj'
    )) {
        $outcome = Test-AihIgnorePattern -Pattern $pattern -RelPath $lower -IsDirectory $false -CaseInsensitive $true
        if ($outcome.match) { return 'config' }
    }
    foreach ($pattern in @('*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg', '*.ico', '*.bmp', '*.tif', '*.tiff',
        '*.woff', '*.woff2', '*.ttf', '*.eot', '*.otf', '*.mp3', '*.mp4', '*.wav', '*.avi', '*.mov',
        '*.zip', '*.gz', '*.tar', '*.7z', '*.rar', '*.bz2', '*.xz', '*.pdf', '*.exe', '*.dll', '*.so', '*.dylib', '*.a', '*.lib')) {
        $outcome = Test-AihIgnorePattern -Pattern $pattern -RelPath $lower -IsDirectory $false -CaseInsensitive $true
        if ($outcome.match) { return 'asset' }
    }
    foreach ($pattern in @('*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.py', '*.cs', '*.go', '*.rs', '*.java', '*.kt',
        '*.kts', '*.scala', '*.rb', '*.php', '*.c', '*.cc', '*.cpp', '*.h', '*.hpp', '*.cshtml', '*.razor', '*.vue',
        '*.svelte', '*.swift', '*.m', '*.mm', '*.ps1', '*.psm1', '*.psd1', '*.sh', '*.bash', '*.bat', '*.cmd', '*.sql', '*.groovy', '*.dart')) {
        $outcome = Test-AihIgnorePattern -Pattern $pattern -RelPath $lower -IsDirectory $false -CaseInsensitive $true
        if ($outcome.match) { return 'source' }
    }
    if ($IsBinary) { return 'binary' }
    return 'unknown'
}

function Get-AihContentHash {
    # Stable content identity. Unchanged content keeps the same hash regardless
    # of timestamps. Large files use an explicitly-prefixed sampled hash so
    # partial identities are never confused with full-content hashes.
    param(
        [Parameter(Mandatory = $true)][string]$FullPath,
        [Parameter(Mandatory = $true)][long]$Size,
        [long]$MaxFileBytes = 2MB,
        [long]$SampleBytes = 65536
    )
    if ($Size -gt $MaxFileBytes) {
        return 'sha256s:' + (Get-AihSha256Hex -Path $FullPath -MaxBytes ([int][Math]::Min($SampleBytes, [long][int]::MaxValue)))
    }
    return 'sha256:' + (Get-AihSha256Hex -Path $FullPath)
}

function Invoke-AihInventoryScan {
    # Walks the checkout root and produces the deterministic file inventory.
    #   - never follows directory symlinks/junctions (loop + escape safety)
    #   - never reads through file symlinks
    #   - ignores are evaluated in layers; tracked Git files bypass ignores
    #   - content hashes are reused from $PreviousFiles when size+mtime match
    param(
        [Parameter(Mandatory = $true)][string]$CheckoutRoot,
        $Config,
        [string[]]$TrackedFiles = @(),
        $PreviousFiles = $null,
        [switch]$NoHash
    )
    if ($null -eq $Config) { $Config = Resolve-AihRepositoryConfig -CheckoutRoot $CheckoutRoot }
    $rootFull = [IO.Path]::GetFullPath($CheckoutRoot).TrimEnd('\', '/')
    $rootKey = Get-AihPathCaseKey $rootFull
    $trackedSet = @{}
    foreach ($tracked in $TrackedFiles) { $trackedSet[$tracked] = $true }

    # Ordered rule tables. Effective evaluation order is the numeric 'order':
    #   defaults (0+) -> per-directory .gitignore (1000+) -> .nexus.yml
    #   exclude (200000+) -> per-directory .nexusignore (300000+).
    # The LAST matching rule wins, negations included. Inherited exclusion
    # rules (from conditionally-descended directories) occupy fractional
    # orders so that later negations can still re-include specific paths.
    $defaultRules = [System.Collections.ArrayList]::new()
    $defaultOrder = 0.0
    foreach ($defaultPattern in (Get-AihDefaultIgnorePatterns)) {
        $defaultTrimmed = $defaultPattern.Trim()
        $null = $defaultRules.Add(@{ source = 'defaults'; base = ''; pattern = $defaultPattern; order = $defaultOrder; negate = $defaultTrimmed.StartsWith('!') })
        $defaultOrder = $defaultOrder + 1.0
    }
    $gitignoreRules = [System.Collections.ArrayList]::new()
    $gitignoreOrder = 1000.0
    $configRules = [System.Collections.ArrayList]::new()
    $configOrder = 200000.0
    foreach ($excludePattern in @($Config.exclude)) {
        $excludeTrimmed = "$excludePattern".Trim()
        $null = $configRules.Add(@{ source = 'nexus-config'; base = ''; pattern = "$excludePattern"; order = $configOrder; negate = $excludeTrimmed.StartsWith('!') })
        $configOrder = $configOrder + 1.0
    }
    $nexusignoreRules = [System.Collections.ArrayList]::new()
    $nexusignoreOrder = 300000.0

    $files = [System.Collections.ArrayList]::new()
    $skipped = [System.Collections.ArrayList]::new()
    $stats = [ordered]@{
        discoveredFiles = 0; ignoredFiles = 0; ignoredDirectories = 0
        skippedSymlinks = 0; trackedFiles = 0; reusedHashes = 0; sampledLargeFiles = 0
    }

    $stack = [System.Collections.Stack]::new()
    $stack.Push(@{ rel = ''; full = $rootFull; inherited = @() })
    $visited = @{}
    while ($stack.Count -gt 0) {
        $current = $stack.Pop()
        $relBase = $current.rel
        $key = Get-AihPathCaseKey $current.full
        if ($visited.ContainsKey($key)) { continue }
        $visited[$key] = $true

        # load this directory's ignore files (apply to its children and below)
        if ($Config.respectGitignore) {
            $gitText = Get-AihOptionalText -Path (Join-Path $current.full '.gitignore')
            if (-not [string]::IsNullOrEmpty($gitText)) {
                foreach ($line in ($gitText.Replace([string][char]13, '') -split [string][char]10)) {
                    $lineTrimmed = $line.Trim()
                    $null = $gitignoreRules.Add(@{ source = 'gitignore'; base = $relBase; pattern = $line; order = $gitignoreOrder; negate = $lineTrimmed.StartsWith('!') })
                    $gitignoreOrder = $gitignoreOrder + 1.0
                }
            }
        }
        $nexusText = Get-AihOptionalText -Path (Join-Path $current.full '.nexusignore')
        if (-not [string]::IsNullOrEmpty($nexusText)) {
            foreach ($line in ($nexusText.Replace([string][char]13, '') -split [string][char]10)) {
                $lineTrimmed = $line.Trim()
                $null = $nexusignoreRules.Add(@{ source = 'nexusignore'; base = $relBase; pattern = $line; order = $nexusignoreOrder; negate = $lineTrimmed.StartsWith('!') })
                $nexusignoreOrder = $nexusignoreOrder + 1.0
            }
        }

        $children = @()
        try {
            $children = @(Get-ChildItem -LiteralPath $current.full -Force -ErrorAction Stop)
        } catch {
            $null = $skipped.Add([pscustomobject]@{ path = $relBase; reason = 'unreadable_directory' })
            continue
        }
        foreach ($child in $children) {
            $childFull = $child.FullName
            if (-not (Test-AihPathInsideRoot -Root $rootFull -FullPath $childFull)) {
                $null = $skipped.Add([pscustomobject]@{ path = $childFull; reason = 'outside_root' })
                continue
            }
            $rel = if ($relBase -eq '') { $child.Name } else { $relBase + '/' + $child.Name }
            $isDirectory = $child.PSIsContainer
            $attributes = $child.Attributes
            $isReparse = (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)

            # effective ordered rules for this candidate (defaults -> inherited
            # exclusions -> gitignore files -> config -> nexusignore)
            $effectiveRules = @(@($defaultRules) + @($current.inherited) + @($gitignoreRules) + @($configRules) + @($nexusignoreRules)) | Sort-Object -Property { [double]$_.order }
            $decision = Get-AihIgnoreDecision -RelPath $rel -IsDirectory $isDirectory -Rules $effectiveRules
            $isTracked = $trackedSet.ContainsKey($rel)

            if ($isDirectory) {
                if ($isReparse) {
                    $stats.skippedSymlinks = $stats.skippedSymlinks + 1
                    $null = $skipped.Add([pscustomobject]@{ path = $rel; reason = 'symlink_or_junction' })
                    continue
                }
                if ($decision.excluded -and -not $isTracked) {
                    $stats.ignoredDirectories = $stats.ignoredDirectories + 1
                    # An excluded directory is pruned unless a LATER negation
                    # could re-include something beneath it. In that case the
                    # walk descends and inherits the directory's exclusion as
                    # an ordered rule so only explicitly re-included paths
                    # survive.
                    if ($decision.matched -and -not $decision.matchedNegate -and (Test-AihNegationMayApply -Rules $effectiveRules -MatchedOrder $decision.matchedOrder -DirRel $rel)) {
                        $inheritedForChild = @($current.inherited)
                        $inheritedOrder = $decision.matchedOrder + 0.5
                        while (@($effectiveRules | Where-Object { [double]$_.order -eq $inheritedOrder }).Count -gt 0) {
                            $inheritedOrder = $inheritedOrder + 0.25
                        }
                        $inheritedForChild = @($inheritedForChild) + @(@{ source = "$($decision.layer)"; base = ''; pattern = ($rel + '/**'); order = $inheritedOrder; negate = $false })
                        $stack.Push(@{ rel = $rel; full = $childFull; inherited = $inheritedForChild })
                    }
                    continue
                }
                $stack.Push(@{ rel = $rel; full = $childFull; inherited = $current.inherited })
                continue
            }

            if ($decision.excluded -and -not $isTracked) {
                if ($decision.matched) { $stats.ignoredFiles = $stats.ignoredFiles + 1 }
                continue
            }
            if ($isTracked) { $stats.trackedFiles = $stats.trackedFiles + 1 }
            $stats.discoveredFiles = $stats.discoveredFiles + 1

            $size = [long]$child.Length
            $mtimeMs = [long]([DateTimeOffset]$child.LastWriteTimeUtc).ToUnixTimeMilliseconds()
            $isSymlink = $isReparse
            $isBinary = $false
            $contentHash = $null
            $indexability = 'text'

            if ($isSymlink) {
                $indexability = 'excluded_symlink'
                $stats.skippedSymlinks = $stats.skippedSymlinks + 1
            }
            else {
                $previous = $null
                if ($null -ne $PreviousFiles -and $PreviousFiles.ContainsKey($rel)) { $previous = $PreviousFiles[$rel] }
                $canReuse = ($null -ne $previous -and "$($previous.contentHash)" -ne '' -and [long]$previous.size -eq $size -and [long]$previous.mtimeMs -eq $mtimeMs)
                if ($canReuse) {
                    $contentHash = "$($previous.contentHash)"
                    $isBinary = [bool]$previous.isBinary
                    $stats.reusedHashes = $stats.reusedHashes + 1
                }
                elseif (-not $NoHash) {
                    try {
                        if ($size -gt $Config.maxFileBytes) {
                            $indexability = 'excluded_large'
                            $contentHash = Get-AihContentHash -FullPath $childFull -Size $size -MaxFileBytes $Config.maxFileBytes -SampleBytes $Config.sampleBytes
                            $stats.sampledLargeFiles = $stats.sampledLargeFiles + 1
                        } else {
                            $contentHash = Get-AihContentHash -FullPath $childFull -Size $size -MaxFileBytes $Config.maxFileBytes -SampleBytes $Config.sampleBytes
                        }
                        $sample = $null
                        try {
                            $stream = [IO.File]::OpenRead($childFull)
                            try {
                                $take = [int][Math]::Min($Config.binarySampleBytes, [Math]::Max($size, 0))
                                if ($take -gt 0) {
                                    $buffer = New-Object byte[] $take
                                    $readTotal = 0
                                    while ($readTotal -lt $take) {
                                        $read = $stream.Read($buffer, $readTotal, $take - $readTotal)
                                        if ($read -le 0) { break }
                                        $readTotal = $readTotal + $read
                                    }
                                    if ($readTotal -lt $take) {
                                        $trimmed = New-Object byte[] $readTotal
                                        [Array]::Copy($buffer, $trimmed, $readTotal)
                                        $sample = $trimmed
                                    } else { $sample = $buffer }
                                }
                            } finally { $stream.Dispose() }
                        } catch { $sample = $null }
                        if ($null -ne $sample) { $isBinary = Test-AihBinarySample -Bytes $sample }
                    } catch {
                        $contentHash = $null
                        $indexability = 'excluded_unreadable'
                        $null = $skipped.Add([pscustomobject]@{ path = $rel; reason = 'unreadable_file' })
                    }
                }
                if ($isBinary -and $indexability -eq 'text') { $indexability = 'binary' }
            }

            $classification = Get-AihFileClassification -RelPath $rel -IsBinary $isBinary -Config $Config
            $sensitivity = Get-AihFileSensitivity -RelPath $rel -Config $Config
            $null = $files.Add([pscustomobject][ordered]@{
                path           = $rel
                size           = $size
                mtimeMs        = $mtimeMs
                contentHash    = $contentHash
                classification = $classification
                sensitivity    = $sensitivity
                indexability   = $indexability
                isBinary       = $isBinary
                isSymlink      = $isSymlink
                isTracked      = $isTracked
            })
        }
    }

    # tracked files that the walk never reached (e.g. force-added inside
    # ignored directories) must still appear in the inventory with real
    # metadata resolved directly from the filesystem
    $seen = @{}
    foreach ($entry in $files) { $seen[$entry.path] = $true }
    foreach ($tracked in $TrackedFiles) {
        if ([string]::IsNullOrWhiteSpace($tracked)) { continue }
        if ($seen.ContainsKey($tracked)) { continue }
        $stats.trackedFiles = $stats.trackedFiles + 1
        $stats.discoveredFiles = $stats.discoveredFiles + 1
        $size = 0L; $mtimeMs = 0L; $contentHash = $null; $isBinary = $false
        $indexability = 'unresolved_tracked'
        $trackedFull = $rootFull + '\' + $tracked.Replace('/', '\')
        try {
            if ((Test-Path -LiteralPath $trackedFull) -and -not (Get-Item -LiteralPath $trackedFull -Force).PSIsContainer) {
                $trackedItem = Get-Item -LiteralPath $trackedFull -Force
                if (($trackedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
                    $size = [long]$trackedItem.Length
                    $mtimeMs = [long]([DateTimeOffset]$trackedItem.LastWriteTimeUtc).ToUnixTimeMilliseconds()
                    $previous = $null
                    if ($null -ne $PreviousFiles -and $PreviousFiles.ContainsKey($tracked)) { $previous = $PreviousFiles[$tracked] }
                    $canReuse = ($null -ne $previous -and "$($previous.contentHash)" -ne '' -and [long]$previous.size -eq $size -and [long]$previous.mtimeMs -eq $mtimeMs)
                    if ($canReuse -and -not $NoHash) {
                        $contentHash = "$($previous.contentHash)"
                        $isBinary = [bool]$previous.isBinary
                        $stats.reusedHashes = $stats.reusedHashes + 1
                    }
                    elseif (-not $NoHash) {
                        $contentHash = Get-AihContentHash -FullPath $trackedFull -Size $size -MaxFileBytes $Config.maxFileBytes -SampleBytes $Config.sampleBytes
                    }
                    if ($indexability -eq 'unresolved_tracked') {
                        if ($size -gt $Config.maxFileBytes) { $indexability = 'excluded_large' }
                        elseif ($NoHash) { $indexability = 'text' }
                        else { $indexability = 'text' }
                    }
                }
            }
        } catch {
            $contentHash = $null
            $indexability = 'unresolved_tracked'
        }
        if ($isBinary -and $indexability -eq 'text') { $indexability = 'binary' }
        $classification = Get-AihFileClassification -RelPath $tracked -IsBinary $isBinary -Config $Config
        $sensitivity = Get-AihFileSensitivity -RelPath $tracked -Config $Config
        $null = $files.Add([pscustomobject][ordered]@{
            path = $tracked; size = $size; mtimeMs = $mtimeMs; contentHash = $contentHash
            classification = $classification; sensitivity = $sensitivity
            indexability = $indexability; isBinary = $isBinary; isSymlink = $false; isTracked = $true
        })
    }

    $orderedFiles = @($files.ToArray() | Sort-Object -Property { [string]$_.path })
    return [pscustomobject][ordered]@{
        checkoutRoot = (ConvertTo-AihCheckoutRootPath $CheckoutRoot)
        files        = $orderedFiles
        skipped      = @($skipped.ToArray())
        stats        = [pscustomobject]$stats
        configErrors = @($Config.configErrors)
    }
}
