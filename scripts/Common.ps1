Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# JSON produced by these CLIs is consumed by the controller bridge (Node).
# Windows PowerShell 5.1 otherwise writes stdout in the console codepage,
# which mangles non-ASCII text (U+2192 becomes a raw 0x1A byte) and breaks
# the bridge's JSON parse. Emit UTF-8 explicitly.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Get-AihInstallRoot {
    param([string]$InstallRoot)

    if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
        return [System.IO.Path]::GetFullPath($InstallRoot)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:AIH_INSTALL_ROOT)) {
        return [System.IO.Path]::GetFullPath($env:AIH_INSTALL_ROOT)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
        return [System.IO.Path]::GetFullPath((Split-Path -Parent $env:DSH_HOME))
    }
    return [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
}

function Get-AihLayout {
    param([string]$InstallRoot)

    $root = Get-AihInstallRoot $InstallRoot
    [pscustomobject]@{
        Root = $root
        App = Join-Path $root 'app'
        Bin = Join-Path $root 'bin'
        Config = Join-Path $root 'config'
        Data = Join-Path $root 'data'
        Logs = Join-Path $root 'logs'
        Runtime = Join-Path $root 'runtime'
        Scripts = Join-Path $root 'scripts'
        Node = Join-Path $root 'runtime\node\node.exe'
        Npm = Join-Path $root 'runtime\node\npm.cmd'
        Dsh = Join-Path $root 'app\node_modules\@deepseek-ai\dsh\lib\bin.js'
        OAuth = Join-Path $root 'app\node_modules\openai-oauth\dist\cli.js'
        Credentials = Join-Path $root 'data\.credentials.yaml'
        Settings = Join-Path $root 'data\settings.yaml'
        State = Join-Path $root 'data\aih-state.json'
        RoutingPolicy = Join-Path $root 'config\routing-policy.json'
        ModelRegistry = Join-Path $root 'config\model-registry.json'
        EngineeringProfiles = Join-Path $root 'config\engineering-profiles.json'
        CustomEngineeringProfile = Join-Path $root 'data\custom-engineering-profile.json'
        RoutingData = Join-Path $root 'data\routing'
        CompletionData = Join-Path $root 'data\completion'
        EvaluationData = Join-Path $root 'data\evaluation'
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
        Join-Path $env:USERPROFILE '.codex'
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

function Protect-AihPrivatePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer) {
        & icacls.exe $Path '/inheritance:r' "/grant:r" "${identity}:(OI)(CI)F" | Out-Null
    }
    else {
        & icacls.exe $Path '/inheritance:r' "/grant:r" "${identity}:F" | Out-Null
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to restrict permissions on $Path"
    }
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
