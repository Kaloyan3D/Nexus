Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Platform abstraction (OS detection, executable resolution, process spawn,
# browser open, private-path permissions). Loaded first so every shared
# helper below can rely on it. All OS-dependent decisions live in Platform.ps1.
. (Join-Path $PSScriptRoot 'Platform.ps1')

# JSON produced by these CLIs is consumed by the controller bridge (Node).
# Windows PowerShell 5.1 otherwise writes stdout in the console codepage,
# which mangles non-ASCII text (U+2192 becomes a raw 0x1A byte) and breaks
# the bridge's JSON parse. Emit UTF-8 explicitly.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# Get-AihInstallRoot is defined in Platform.ps1 (foundation layer): the
# platform layer must stay independently sourceable, and the pinned POSIX
# host resolution depends on root resolution. Common.ps1 consumers inherit
# it through the dot-source above.

function Get-AihLayout {
    param([string]$InstallRoot)

    $root = Get-AihInstallRoot $InstallRoot
    # The pinned Node distribution layout differs per platform: the Windows
    # ZIP keeps node.exe/npm.cmd at the root, the Linux .tar.xz keeps the
    # executable under bin/ and npm's CLI module under lib/node_modules/npm.
    # npm is always invoked through node with npm-cli.js on Linux so the
    # launcher's shebang never depends on PATH resolution.
    $nodeRelative = Get-AihNodeRelativeExecutable
    $runtimeNode = Join-Path (Join-Path $root 'runtime') 'node'
    $npmRelative = if (Test-AihIsWindows) { 'npm.cmd' } else { Join-Path (Join-Path (Join-Path (Join-Path 'lib' 'node_modules') 'npm') 'bin') 'npm-cli.js' }
    $runtimePwsh = Join-Path (Join-Path $root 'runtime') 'pwsh'
    [pscustomobject]@{
        Root = $root
        App = Join-Path $root 'app'
        Bin = Join-Path $root 'bin'
        Config = Join-Path $root 'config'
        Data = Join-Path $root 'data'
        Logs = Join-Path $root 'logs'
        Runtime = Join-Path $root 'runtime'
        Scripts = Join-Path $root 'scripts'
        Node = Join-Path $runtimeNode $nodeRelative
        Npm = Join-Path $runtimeNode $npmRelative
        Pwsh = if (Test-AihIsWindows) { $null } else { Join-Path $runtimePwsh 'pwsh' }
        Dsh = Join-Path $root 'app/node_modules/@deepseek-ai/dsh/lib/bin.js'
        OAuth = Join-Path $root 'app/node_modules/openai-oauth/dist/cli.js'
        Credentials = Join-Path $root 'data/.credentials.yaml'
        Settings = Join-Path $root 'data/settings.yaml'
        State = Join-Path $root 'data/aih-state.json'
        RoutingPolicy = Join-Path $root 'config/routing-policy.json'
        ModelRegistry = Join-Path $root 'config/model-registry.json'
        EngineeringProfiles = Join-Path $root 'config/engineering-profiles.json'
        CustomEngineeringProfile = Join-Path $root 'data/custom-engineering-profile.json'
        RoutingData = Join-Path $root 'data/routing'
        CompletionData = Join-Path $root 'data/completion'
        EvaluationData = Join-Path $root 'data/evaluation'
    }
}

function Write-AihAtomicText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $directory = Split-Path -Parent $fullPath
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($fullPath) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText($temporary, $Content, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $fullPath) {
            try { [System.IO.File]::Replace($temporary, $fullPath, $null, $true) }
            catch { Move-Item -LiteralPath $temporary -Destination $fullPath -Force }
        }
        else { Move-Item -LiteralPath $temporary -Destination $fullPath }
    }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function ConvertTo-AihJsonSafe {
    # Normalize a value for JSON emission. OrderedDictionary/IDictionary
    # values serialize through the PSObject adapter, which leaks .NET
    # reflection members (Count, Keys, Values, SyncRoot, ...) into the JSON
    # alongside the real keys, and pipeline piping unrolls the dictionary
    # into DictionaryEntry items. Convert every dictionary to a
    # pscustomobject (recursively) so ConvertTo-Json -InputObject emits
    # exactly the authored keys.
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    # PS 5.1 quirk: cmdlet outputs (e.g. Split-Path -Leaf) can arrive wrapped
    # in a PSObject whose extended type makes `-is [pscustomobject]` true even
    # for a plain string, which would serialize {Length: n} instead of the
    # value. Serialize the string value itself, never its reflection members.
    if ($Value -is [string]) { return $Value }
    if ($Value -is [Collections.Specialized.OrderedDictionary] -or $Value -is [Collections.IDictionary]) {
        $output = [ordered]@{}
        foreach ($entry in ([Collections.IDictionary]$Value).GetEnumerator()) {
            $output[[string]$entry.Key] = ConvertTo-AihJsonSafe $entry.Value
        }
        return [pscustomobject]$output
    }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string] -and $Value -isnot [scriptblock]) {
        $items = @()
        foreach ($item in $Value) { $items += (ConvertTo-AihJsonSafe $item) }
        return ,$items
    }
    if ($Value -is [pscustomobject]) {
        $output = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) {
            $output[$property.Name] = ConvertTo-AihJsonSafe $property.Value
        }
        return [pscustomobject]$output
    }
    return $Value
}

function Write-AihAtomicJson {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][AllowNull()]$Value, [int]$Depth = 20)
    $json = if ($null -eq $Value) { 'null' } else { ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe $Value) -Depth $Depth }
    Write-AihAtomicText -Path $Path -Content $json
}

function Add-AihJsonLine {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][AllowNull()]$Value, [int]$Depth = 20)
    $directory = Split-Path -Parent ([System.IO.Path]::GetFullPath($Path))
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $json = if ($null -eq $Value) { 'null' } else { ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe $Value) -Depth $Depth -Compress }
    [System.IO.File]::AppendAllText($Path, ($json + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
}

function Get-AihVersions {
    param([string]$InstallRoot)

    $layout = Get-AihLayout $InstallRoot
    $path = Join-Path $layout.Config 'versions.json'
    if (-not (Test-Path -LiteralPath $path)) {
        throw "AI Harness version manifest is missing: $path"
    }
    Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
}

function Get-AihCodexAuthFile {
    $codexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        # The Codex CLI stores auth under the user profile directory. Windows
        # keeps USERPROFILE; other platforms use HOME (Codex itself resolves
        # it the same way).
        $userHome = if (Test-AihIsWindows) { $env:USERPROFILE } else { $env:HOME }
        Join-Path $userHome '.codex'
    }
    else { [System.IO.Path]::GetFullPath($env:CODEX_HOME) }
    return Join-Path $codexHome 'auth.json'
}

function Test-AihEndpoint {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [int]$TimeoutSec = 2
    )

    try {
        $null = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec $TimeoutSec
        return $true
    }
    catch {
        return $false
    }
}

function Get-AihDeepSeekKey {
    param([string]$InstallRoot)

    if (-not [string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
        return $env:DEEPSEEK_API_KEY.Trim()
    }
    $layout = Get-AihLayout $InstallRoot
    if (-not (Test-Path -LiteralPath $layout.Credentials)) {
        return $null
    }
    $line = Get-Content -LiteralPath $layout.Credentials | Where-Object { $_ -match '^\s*DEEPSEEK_API_KEY\s*:' } | Select-Object -First 1
    if ($null -eq $line) {
        return $null
    }
    $value = ($line -replace '^\s*DEEPSEEK_API_KEY\s*:\s*', '').Trim()
    if ($value.StartsWith("'") -and $value.EndsWith("'")) {
        $value = $value.Substring(1, $value.Length - 2).Replace("''", "'")
    }
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $null
    }
    return $value
}

function Get-AihProviderApiKey {
    # Phase M2: generic credential accessor for provider routes declared in
    # settings.yaml llm-pi-ai.providers via `apiKeyEnv`. Same resolution order
    # and same protected store as Get-AihDeepSeekKey (environment first, then
    # the data/.credentials.yaml refs line), parameterized by variable name so
    # a new provider never needs a bespoke credential mechanism. The returned
    # value must NEVER be logged, echoed, or embedded in error records.
    param(
        [Parameter(Mandatory = $true)][string]$ApiKeyEnv,
        [string]$InstallRoot
    )

    if ([string]::IsNullOrWhiteSpace($ApiKeyEnv)) { return $null }
    $environmentValue = [Environment]::GetEnvironmentVariable($ApiKeyEnv)
    if (-not [string]::IsNullOrWhiteSpace($environmentValue)) {
        return $environmentValue.Trim()
    }
    $layout = Get-AihLayout $InstallRoot
    if (-not (Test-Path -LiteralPath $layout.Credentials)) {
        return $null
    }
    $escaped = [regex]::Escape($ApiKeyEnv)
    $line = Get-Content -LiteralPath $layout.Credentials | Where-Object { $_ -match ('^\s*' + $escaped + '\s*:') } | Select-Object -First 1
    if ($null -eq $line) {
        return $null
    }
    $value = ($line -replace ('^\s*' + $escaped + '\s*:\s*'), '').Trim()
    if ($value.StartsWith("'") -and $value.EndsWith("'")) {
        $value = $value.Substring(1, $value.Length - 2).Replace("''", "'")
    }
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $null
    }
    return $value
}

function Wait-AihEndpoint {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [int]$TimeoutSec = 30
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    do {
        if (Test-AihEndpoint -Uri $Uri -TimeoutSec 2) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

# --- Claude Pro/Max subscription helpers (Registry R5) ---
# The official Claude Code CLI owns login/session/refresh. These helpers
# resolve the executable and observe session METADATA ONLY (exists, size,
# mtime). They NEVER read the credentials file content, NEVER emit token
# material, and NEVER start an OAuth flow. Interactive login lives in
# scripts/Set-ClaudeSubscription.ps1; status checks in Test-ClaudeConnection.

function Get-AihClaudeHome {
    # User-profile Claude directory. Windows keeps USERPROFILE; other
    # platforms use HOME (the CLI resolves it the same way).
    $userHome = if (Test-AihIsWindows) { $env:USERPROFILE } else { $env:HOME }
    if ([string]::IsNullOrWhiteSpace($userHome)) { return $null }
    return (Join-Path $userHome '.claude')
}

function Get-AihClaudeExecutable {
    # PATH first (user-installed official CLI wins), then well-known npm
    # global locations per platform. Returns $null when absent (fail closed).
    $names = if (Test-AihIsWindows) { @('claude.exe', 'claude.cmd', 'claude') } else { @('claude') }
    foreach ($name in $names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) { return $command.Source }
    }
    $candidates = @()
    if (Test-AihIsWindows) {
        if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
            $candidates += (Join-Path (Join-Path $env:APPDATA 'npm') 'claude.cmd')
            $candidates += (Join-Path (Join-Path $env:APPDATA 'npm') 'claude.exe')
        }
    }
    else {
        foreach ($prefix in @('/usr/local', $env:HOME)) {
            if ([string]::IsNullOrWhiteSpace($prefix)) { continue }
            $candidates += (Join-Path (Join-Path $prefix 'bin') 'claude')
            $candidates += (Join-Path (Join-Path (Join-Path $prefix '.npm-global') 'bin') 'claude')
        }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Get-AihClaudeSessionMeta {
    # Session METADATA ONLY. The returned object carries Exists, SizeBytes
    # and ModifiedUtc - never file content. $null when no session file.
    param([string]$ClaudeHome)
    if ([string]::IsNullOrWhiteSpace($ClaudeHome)) { $ClaudeHome = Get-AihClaudeHome }
    if ([string]::IsNullOrWhiteSpace($ClaudeHome)) { return $null }
    $credFile = Join-Path $ClaudeHome '.credentials.json'
    try { $item = Get-Item -LiteralPath $credFile -ErrorAction Stop }
    catch { return $null }
    if ($item.PSIsContainer) { return $null }
    return [pscustomobject]@{
        Exists      = $true
        Path        = $credFile
        SizeBytes   = [int64]$item.Length
        ModifiedUtc = $item.LastWriteTimeUtc.ToString('o')
    }
}

function Invoke-AihClaudeAuthStatus {
    # Runs the native auth status probe (JSON output is the documented CLI
    # default) with a bounded wait and bounded output. Returns the parsed object, or $null when the CLI
    # is missing, the call times out, or the output is not strict JSON.
    # Callers must select non-secret fields only; the raw object is never
    # echoed (it may carry account identifiers).
    param([string]$Executable, [int]$TimeoutMs = 15000)
    if ([string]::IsNullOrWhiteSpace($Executable)) { return $null }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $Executable
        $psi.Arguments = 'auth status'
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        if ($null -eq $proc) { return $null }
        if (-not $proc.WaitForExit($TimeoutMs)) { try { $proc.Kill() } catch { }; return $null }
        if ($proc.ExitCode -ne 0) { return $null }
        $text = $proc.StandardOutput.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($text) -or ($text.Length -gt 65536)) { return $null }
        try { return ($text | ConvertFrom-Json) } catch { return $null }
    }
    catch { return $null }
}

function Test-AihHasProp {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $false }
    return ($null -ne $Object.PSObject.Properties[$Name])
}
function Get-AihClaudeAuthState {
    # Classifies native auth status into a non-secret state label. Mirrors
    # the Registry classifier (config/registry/subscription-connections.cjs)
    # field for field: loggedIn, authMethod, subscriptionType, apiProvider.
    # Only an explicit native subscription signal confirms a subscription;
    # oauth_token alone never implies Pro/Max. No ternary or other
    # PowerShell 7-only syntax: Windows PowerShell 5.1 compatible.
    param($AuthStatus)
    if ($null -eq $AuthStatus) { return 'unknown' }
    if (((Test-AihHasProp $AuthStatus 'loggedIn') -and (-not [bool]$AuthStatus.loggedIn)) -or ((Test-AihHasProp $AuthStatus 'authenticated') -and (-not [bool]$AuthStatus.authenticated))) { return 'not-logged-in' }
    $statusNorm = ''
    if (Test-AihHasProp $AuthStatus 'status') { $statusNorm = ([string]$AuthStatus.status).Trim().ToLowerInvariant() }
    if (($statusNorm -in @('expired', 'invalid', 'revoked')) -or ((Test-AihHasProp $AuthStatus 'expired') -and [bool]$AuthStatus.expired)) {
        if ($statusNorm -eq 'revoked') { return 'revoked' }
        return 'expired'
    }
    $methodLabel = $null
    foreach ($field in @('authMethod', 'auth_method', 'method', 'type', 'provider', 'kind')) {
        if (Test-AihHasProp $AuthStatus $field) { $candidate = $AuthStatus.$field } else { $candidate = $null }
        if ($candidate -is [string] -and -not [string]::IsNullOrWhiteSpace($candidate)) { $methodLabel = $candidate.Trim(); break }
    }
    $methodNorm = ''
    if ($null -ne $methodLabel) { $methodNorm = $methodLabel.ToLowerInvariant() }
    if ($methodNorm -eq 'none') { return 'not-logged-in' }
    if (($methodNorm -in @('api_key', 'api-key', 'api_key_helper', 'api-key-helper')) -or ($methodNorm -match 'api[-_ ]?key|access[-_ ]?token|bearer|personal[-_ ]?token|setup[-_ ]?token')) { return 'api-key-identity' }
    if (($methodNorm -in @('third_party', 'third-party')) -or ($methodNorm -match 'bedrock|vertex|proxy|custom|endpoint|gateway|byok')) { return 'alternate-provider-identity' }
    $subTypeLabel = $null
    if ((Test-AihHasProp $AuthStatus 'subscriptionType') -and ($AuthStatus.subscriptionType -is [string]) -and -not [string]::IsNullOrWhiteSpace($AuthStatus.subscriptionType)) { $subTypeLabel = ([string]$AuthStatus.subscriptionType).Trim() }
    $subTypeHit = ($null -ne $subTypeLabel) -and ($subTypeLabel -match '^(?i)(pro|max|plus|team|enterprise|business|subscriber)$')
    $loggedInTrue = (Test-AihHasProp $AuthStatus 'loggedIn') -and ([bool]$AuthStatus.loggedIn)
    if ((($methodNorm -eq 'claude.ai') -or ($methodNorm -eq 'claude_ai') -or ($methodNorm -eq 'claudeai')) -and $loggedInTrue) { return 'subscription-confirmed' }
    if ($subTypeHit) { return 'subscription-confirmed' }
    $apiProviderLabel = $null
    if ((Test-AihHasProp $AuthStatus 'apiProvider') -and ($AuthStatus.apiProvider -is [string]) -and -not [string]::IsNullOrWhiteSpace($AuthStatus.apiProvider)) { $apiProviderLabel = ([string]$AuthStatus.apiProvider).Trim().ToLowerInvariant() }
    if (($null -ne $apiProviderLabel) -and ($apiProviderLabel -match 'bedrock|vertex|proxy|custom|endpoint|gateway|byok|third')) { return 'alternate-provider-identity' }
    return 'source-unestablished'
}

function Get-AihClaudeStatus {
    # Non-secret connection summary. AuthState comes from the native
    # (auth status) probe; the legacy session file is supplementary
    # metadata only (a stale file never connects; a login without the
    # assumed file still connects). Connected requires an explicit
    # subscription-confirmed state. Emits NO credential material.
    # ApiBillingRisk covers key/endpoint overrides; cloud-provider routing
    # (Bedrock/Vertex) is reported separately so callers fail closed.
    $exe = Get-AihClaudeExecutable
    $installed = -not [string]::IsNullOrWhiteSpace($exe)
    $version = $null
    if ($installed) {
        try {
            $out = & $exe --version 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0 -and $out -match '(?i)claude') { $version = ([string]$out).Trim().Split("`n")[0].Trim() }
        }
        catch { $version = $null }
        if ([string]::IsNullOrWhiteSpace($version)) { $installed = $false }
    }
    $authState = 'unknown'
    $authMethod = $null
    if ($installed) {
        $native = Invoke-AihClaudeAuthStatus -Executable $exe
        $authState = Get-AihClaudeAuthState -AuthStatus $native
        if ((Test-AihHasProp $native 'method') -and ($native.method -is [string]) -and -not [string]::IsNullOrWhiteSpace($native.method)) { $authMethod = ([string]$native.method).Trim() }
    }
    $session = Get-AihClaudeSessionMeta
    $sessionObserved = ($null -ne $session) -and ($session.SizeBytes -gt 0)
    $apiKey = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY')
    $authToken = [Environment]::GetEnvironmentVariable('ANTHROPIC_AUTH_TOKEN')
    $baseUrl = [Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL')
    $bedrock = [Environment]::GetEnvironmentVariable('CLAUDE_CODE_USE_BEDROCK')
    $vertex = [Environment]::GetEnvironmentVariable('CLAUDE_CODE_USE_VERTEX')
    $alternate = -not [string]::IsNullOrWhiteSpace($bedrock) -or -not [string]::IsNullOrWhiteSpace($vertex)
    return [pscustomobject]@{
        Installed           = $installed
        Executable          = $exe
        Version             = $version
        AuthState           = $authState
        AuthMethod          = $authMethod
        SessionObserved     = $sessionObserved
        SessionSizeBytes    = $(if ($null -ne $session) { $session.SizeBytes } else { $null })
        SessionModifiedUtc  = $(if ($null -ne $session) { $session.ModifiedUtc } else { $null })
        ApiBillingRisk      = (-not [string]::IsNullOrWhiteSpace($apiKey)) -or (-not [string]::IsNullOrWhiteSpace($authToken)) -or (-not [string]::IsNullOrWhiteSpace($baseUrl))
        AlternateProvider   = $alternate
        Connected           = $installed -and ($authState -eq 'subscription-confirmed')
    }
}
