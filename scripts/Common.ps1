Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AihInstallRoot {
    param([string]$InstallRoot)

    if (-not [string]::IsNullOrWhiteSpace($InstallRoot)) {
        return [System.IO.Path]::GetFullPath($InstallRoot)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:AIH_INSTALL_ROOT)) {
        return [System.IO.Path]::GetFullPath($env:AIH_INSTALL_ROOT)
    }
    return 'C:\AI-Harness'
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
        RoutingData = Join-Path $root 'data\routing'
        CompletionData = Join-Path $root 'data\completion'
    }
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
    $line = Get-Content -LiteralPath $layout.Credentials | Where-Object { $_ -match '^DEEPSEEK_API_KEY\s*:' } | Select-Object -First 1
    if ($null -eq $line) {
        return $null
    }
    $value = ($line -replace '^DEEPSEEK_API_KEY\s*:\s*', '').Trim()
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
