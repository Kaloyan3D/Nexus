Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AihControlRoomMode {
    param(
        [Parameter(Mandatory = $true)]$RoutingPolicy,
        [Parameter(Mandatory = $true)][string]$Preset
    )

    $resolved = Resolve-AihPreset $RoutingPolicy $Preset
    $rootExecutor = $resolved.Config.rootExecutor
    [pscustomobject]@{
        Id = $resolved.Id
        DisplayName = [string]$resolved.Config.displayName
        Provider = [string]$rootExecutor.provider
        Model = [string]$rootExecutor.model
        ReasoningEffort = [string]$rootExecutor.reasoning
        RequiresOpenAI = $false
        AllowsCodexSubagent = [bool]$resolved.Config.allowCodexSubagent
        FailurePolicy = [string]$resolved.Config.failurePolicy
        Config = $resolved.Config
    }
}

function Get-AihSavedControlRoomPreset {
    param(
        [Parameter(Mandatory = $true)][string]$SettingsPath,
        [Parameter(Mandatory = $true)][string]$Fallback
    )

    if (-not (Test-Path -LiteralPath $SettingsPath)) { return $Fallback }
    $text = Get-Content -Raw -Encoding UTF8 -LiteralPath $SettingsPath
    $match = [regex]::Match($text, '(?m)^agent-presets:\s*\r?\n(?:^[ \t]+[^\r\n]*\r?\n)*?^[ \t]+default:\s*([^#\r\n]+)')
    if (-not $match.Success) { return $Fallback }
    $value = $match.Groups[1].Value.Trim().Trim('''', '"')
    if ([string]::IsNullOrWhiteSpace($value)) { return $Fallback }
    return $value
}

function Set-AihControlRoomDefault {
    param(
        [Parameter(Mandatory = $true)][string]$SettingsPath,
        [Parameter(Mandatory = $true)]$Mode
    )

    $mutex = [Threading.Mutex]::new($false, 'Local\AIHarness.ControlRoom.Settings')
    $locked = $false
    try {
        $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(10))
        if (-not $locked) { throw 'Timed out waiting to update Control Room settings.' }

        $text = Get-Content -Raw -Encoding UTF8 -LiteralPath $SettingsPath
        $newline = if ($text -match "`r`n") { "`r`n" } else { "`n" }
        $modelBlock = @(
            'agent-default-model:'
            "  provider: $($Mode.Provider)"
            "  model: $($Mode.Model)"
            "  reasoningEffort: $($Mode.ReasoningEffort)"
        ) -join $newline
        $presetBlock = @(
            'agent-presets:'
            "  default: $($Mode.Id)"
        ) -join $newline

        $modelPattern = '(?m)^agent-default-model:\s*\r?\n(?:^[ \t]+[^\r\n]*\r?\n)*'
        if ([regex]::IsMatch($text, $modelPattern)) {
            $text = [regex]::Replace($text, $modelPattern, $modelBlock + $newline + $newline, 1)
        }
        else { $text = $modelBlock + $newline + $newline + $text.TrimStart() }

        $presetPattern = '(?m)^agent-presets:\s*\r?\n(?:^[ \t]+[^\r\n]*\r?\n)*'
        if ([regex]::IsMatch($text, $presetPattern)) {
            $text = [regex]::Replace($text, $presetPattern, $presetBlock + $newline + $newline, 1)
        }
        else { $text = $presetBlock + $newline + $newline + $text.TrimStart() }

        $directory = Split-Path -Parent $SettingsPath
        $temporary = Join-Path $directory ('.settings-{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
        try {
            [IO.File]::WriteAllText($temporary, $text, [Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temporary -Destination $SettingsPath -Force
        }
        finally {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        }
    }
    finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
