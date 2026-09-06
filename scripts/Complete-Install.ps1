[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [switch]$ResetManagedSettings
)

# Shared post-provision install composition used by BOTH platform installers
# (scripts/Setup.ps1 on Windows, setup.sh on Linux). Platform installers own
# OS-specific provisioning (runtime download/extraction, npm ci, PATH) and
# then delegate this single source of truth for:
#   - managed settings initialization (preserving user settings on update),
#   - the managed cordis patch sync,
#   - Nexus UI patchers,
#   - agent preset composition from the pinned DSH Code Mode preset,
#   - data directory scaffolding and private-path permissions.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot

# Initialize managed settings before any UI patcher reads them. Fresh installs
# have an empty data directory, so Patch-NexusUi must never run before
# settings.yaml exists. Existing user settings are preserved unless the caller
# explicitly requests -ResetManagedSettings.
if ($ResetManagedSettings -or -not (Test-Path -LiteralPath $layout.Settings)) {
    Copy-Item -LiteralPath (Join-Path $layout.Config 'settings.yaml') -Destination $layout.Settings
}

# data/cordis.patch.yml is managed by the installer. Sync it before the Nexus
# patcher inspects composition so upgrades from pre-controller installs see the
# current nexus-controller row instead of failing against stale managed state.
Copy-Item -LiteralPath (Join-Path $layout.Config 'home.cordis.patch.yml') -Destination (Join-Path $layout.Data 'cordis.patch.yml') -Force
& (Join-Path $layout.Scripts 'Patch-ControlRoomUi.ps1') -InstallRoot $InstallRoot
& (Join-Path $layout.Scripts 'Patch-NexusUi.ps1') -InstallRoot $InstallRoot

$shippedPreset = Join-Path $layout.App 'node_modules/@deepseek-ai/dsh/config/agent-presets/code'
$targetPreset = Join-Path $layout.Data '.agent-presets/aih-engineering'
if (-not (Test-Path -LiteralPath (Join-Path $shippedPreset 'agent.cordis.yml'))) {
    throw "Pinned Harness does not contain the expected Code Mode preset: $shippedPreset"
}
New-Item -ItemType Directory -Force -Path $targetPreset | Out-Null
$presetText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $shippedPreset 'agent.cordis.yml')
$personaPattern = '(?ms)^- id: persona\r?\n.*?(?=^- id: agent-instructions)'
$personaReplacement = @'
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: !!js process.env.AIH_PERSONA ?? 'You are the DeepSeek implementation agent. Complete the supplied bounded task using repository-local instructions and relevant context. Use targeted verification and return structured evidence. The deterministic controller owns routing, retries, budgets, escalation, completion, and automatic Visual Review. Never discover or invoke Visual Review through the skill catalog. If blocked, return one scoped escalation with a stable failure signature.'

'@
$delegationPattern = '(?ms)^# [^\r\n]*delegation and workflows[^\r\n]*\r?\n.*?(?=^# [^\r\n]*remaining model-facing rows)'
$delegationReplacement = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $layout.Config 'delegation-block.yml')
$personaMatches = [regex]::Matches($presetText, $personaPattern).Count
$delegationMatches = [regex]::Matches($presetText, $delegationPattern).Count
if ($personaMatches -ne 1 -or $delegationMatches -ne 1) {
    throw "Pinned Code Mode preset structure changed (persona matches: $personaMatches; delegation matches: $delegationMatches). Refusing an unsafe transform."
}
$presetText = [regex]::Replace($presetText, $personaPattern, $personaReplacement)
$presetText = [regex]::Replace($presetText, $delegationPattern, $delegationReplacement)
[System.IO.File]::WriteAllText((Join-Path $targetPreset 'agent.cordis.yml'), $presetText, [System.Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $layout.Config 'preset.yml') -Destination (Join-Path $targetPreset 'preset.yml') -Force

$deepSeekPreset = Join-Path $layout.Data '.agent-presets/aih-deepseek'
New-Item -ItemType Directory -Force -Path $deepSeekPreset | Out-Null
& (Join-Path $layout.Scripts 'Build-DeepSeekPreset.ps1') -EngineeringPresetPath (Join-Path $targetPreset 'agent.cordis.yml') -DeepSeekPresetPath (Join-Path $deepSeekPreset 'agent.cordis.yml')
Copy-Item -LiteralPath (Join-Path $layout.Config 'preset-deepseek.yml') -Destination (Join-Path $deepSeekPreset 'preset.yml') -Force
Copy-Item -LiteralPath (Join-Path $layout.Config 'DeepSeek-Isolation.cjs') -Destination (Join-Path $deepSeekPreset 'DeepSeek-Isolation.cjs') -Force
& (Join-Path $layout.Scripts 'Enable-EngineeringIsolation.ps1') -PresetDirectory $targetPreset
Copy-Item -LiteralPath (Join-Path $layout.Config 'Engineering-Isolation.cjs') -Destination (Join-Path $targetPreset 'Engineering-Isolation.cjs') -Force
foreach ($presetDirectory in @($targetPreset, $deepSeekPreset)) {
    Copy-Item -LiteralPath (Join-Path $layout.Config 'AihController.cjs') -Destination (Join-Path $presetDirectory 'AihController.cjs') -Force
    Copy-Item -LiteralPath (Join-Path $layout.Config 'Engineering-Profiles.cjs') -Destination (Join-Path $presetDirectory 'Engineering-Profiles.cjs') -Force
    $presetFile = Join-Path $presetDirectory 'agent.cordis.yml'
    $presetText = Get-Content -Raw -Encoding UTF8 -LiteralPath $presetFile
    if (-not $presetText.Contains('- id: aih-controller')) {
        $controllerRow = @"

- id: aih-controller
  name: './AihController.cjs'
"@
        # Append the exact same bytes Add-Content wrote historically (UTF-8
        # without BOM on append), now via an explicit encoding so Windows
        # PowerShell 5.1 and pwsh 7 produce identical files.
        [System.IO.File]::AppendAllText($presetFile, $controllerRow, [System.Text.UTF8Encoding]::new($false))
    }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $layout.Credentials) | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $layout.RoutingData 'states') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $layout.CompletionData 'records') | Out-Null
New-Item -ItemType Directory -Force -Path $layout.EvaluationData | Out-Null
# Restrictive permissions on the private state tree: Windows ACL behavior is
# unchanged; Linux applies the deterministic 0700/0600 plan.
Protect-AihPrivatePath -Path $layout.Data
