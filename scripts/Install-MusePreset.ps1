[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [string]$TargetPresetPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $InstallRoot 'scripts/Common.ps1')
$layout = Get-AihLayout $InstallRoot
if ([string]::IsNullOrWhiteSpace($TargetPresetPath)) {
    $TargetPresetPath = Join-Path $layout.Data '.agent-presets/aih-muse'
}
$TargetPresetPath = [System.IO.Path]::GetFullPath($TargetPresetPath)
$targetParent = Split-Path -Parent $TargetPresetPath
New-Item -ItemType Directory -Force -Path $targetParent | Out-Null

$token = [System.Guid]::NewGuid().ToString('N')
$stage = Join-Path $targetParent ('.aih-muse.stage.' + $token)
$backup = Join-Path $targetParent ('.aih-muse.backup.' + $token)
$published = $false
$backupCreated = $false
$utf8 = [System.Text.UTF8Encoding]::new($false)
$closureTool = Join-Path $layout.Scripts 'MusePresetDependencyClosure.cjs'
if (Test-Path -LiteralPath (Join-Path $InstallRoot '.git')) {
    & $layout.Node $closureTool prepare $InstallRoot $InstallRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Muse preset source dependency closure failed.' }
}
elseif (-not (Test-Path -LiteralPath (Join-Path $layout.Config '.muse-preset-closure.json'))) { throw 'Muse preset closure manifest is missing; reinstall from a tracked source checkout.' }

try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    $shippedPreset = Join-Path $layout.App 'node_modules/@deepseek-ai/dsh/config/agent-presets/code'
    $sourceComposition = Join-Path $shippedPreset 'agent.cordis.yml'
    if (-not (Test-Path -LiteralPath $sourceComposition -PathType Leaf)) {
        throw "Pinned Code Mode preset is missing: $sourceComposition"
    }

    $museText = Get-Content -Raw -Encoding UTF8 -LiteralPath $sourceComposition
    $musePersonaPattern = '(?ms)^- id: persona\r?\n.*?(?=^- id: agent-instructions)'
    $musePersonaReplacement = @'
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: !!js >-
      process.env.AIH_PERSONA_MUSE ?? 'You are the Muse engineering agent. Complete the supplied bounded task. Inspect the repository evidence first, follow repository-local instructions, use the available tools as required, and verify with a targeted check before reporting. Return concrete evidence for what you changed and verified. The deterministic controller owns routing, attempts, verification results, and task completion; you never declare completion or re-route yourself. You are a single engineering agent. There are no subagents, reviewers, or fallback engineers on this plane. Report meaningful trajectory phase changes and established findings through the muse_update_reasoning_state tool; you never choose reasoning effort yourself.'

'@
    $museDelegationPattern = '(?ms)^# [^\r\n]*delegation and workflows[^\r\n]*\r?\n.*?(?=^# [^\r\n]*remaining model-facing rows)'
    $personaMatches = [regex]::Matches($museText, $musePersonaPattern).Count
    $delegationMatches = [regex]::Matches($museText, $museDelegationPattern).Count
    if ($personaMatches -ne 1 -or $delegationMatches -ne 1) {
        throw "Pinned Code Mode preset structure changed for the Muse plane (persona matches: $personaMatches; delegation matches: $delegationMatches). Refusing an unsafe transform."
    }
    $museText = [regex]::Replace($museText, $musePersonaPattern, $musePersonaReplacement)
    $museText = [regex]::Replace($museText, $museDelegationPattern, '')
    $museText += @'

- id: aih-muse-isolation
  name: './Muse-Isolation.cjs'

- id: aih-muse-reasoning-signals
  name: './Muse-ReasoningSignals.cjs'

- id: aih-controller
  name: './AihController.cjs'
'@
    [System.IO.File]::WriteAllText((Join-Path $stage 'agent.cordis.yml'), $museText, $utf8)

    Copy-Item -LiteralPath (Join-Path $layout.Config 'preset-muse.yml') -Destination (Join-Path $stage 'preset.yml')
    & $layout.Node $closureTool copy $InstallRoot $stage | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Muse preset dependency closure copy failed.' }

    & $layout.Node (Join-Path $layout.Scripts 'Validate-MusePreset.cjs') $InstallRoot $stage | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The staged Muse preset failed structural validation.' }

    if (Test-Path -LiteralPath $TargetPresetPath) {
        Move-Item -LiteralPath $TargetPresetPath -Destination $backup
        $backupCreated = $true
    }
    try {
        Move-Item -LiteralPath $stage -Destination $TargetPresetPath
        $published = $true
        & $layout.Node (Join-Path $layout.Scripts 'Validate-MusePreset.cjs') $InstallRoot $TargetPresetPath | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'The published Muse preset failed structural validation.' }
        if ($backupCreated) {
            Remove-Item -LiteralPath $backup -Recurse -Force
            $backupCreated = $false
        }
    }
    catch {
        if ($published -and (Test-Path -LiteralPath $TargetPresetPath)) {
            Remove-Item -LiteralPath $TargetPresetPath -Recurse -Force
            $published = $false
        }
        if ($backupCreated -and (Test-Path -LiteralPath $backup)) {
            Move-Item -LiteralPath $backup -Destination $TargetPresetPath
            $backupCreated = $false
        }
        throw
    }
}
finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    # A backup is deliberately preserved if rollback itself could not restore
    # it; losing the last complete preset is worse than leaving a recovery copy.
}

Write-Host 'Muse preset installed atomically and validated.'
