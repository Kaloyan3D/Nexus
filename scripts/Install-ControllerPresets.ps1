[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$InstallRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts/Common.ps1')
$layout = Get-AihLayout $InstallRoot
$parent = Join-Path $layout.Data '.agent-presets'
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$token = [guid]::NewGuid().ToString('N')
$engineeringStage = Join-Path $parent ('.aih-engineering.stage.' + $token)
$deepSeekStage = Join-Path $parent ('.aih-deepseek.stage.' + $token)
$stages = @(
    @{ Name='aih-engineering'; Stage=$engineeringStage; Target=(Join-Path $parent 'aih-engineering'); Backup=(Join-Path $parent ('.aih-engineering.backup.' + $token)) },
    @{ Name='aih-deepseek'; Stage=$deepSeekStage; Target=(Join-Path $parent 'aih-deepseek'); Backup=(Join-Path $parent ('.aih-deepseek.backup.' + $token)) }
)
$closureTool = Join-Path $layout.Scripts 'MusePresetDependencyClosure.cjs'
$validator = Join-Path $layout.Scripts 'Validate-ControllerPreset.cjs'
$utf8 = [Text.UTF8Encoding]::new($false)
$published = @()
$backedUp = @()
try {
    $shippedPreset = Join-Path $layout.App 'node_modules/@deepseek-ai/dsh/config/agent-presets/code/agent.cordis.yml'
    if (-not (Test-Path -LiteralPath $shippedPreset -PathType Leaf)) { throw "Pinned Harness does not contain the expected Code Mode preset: $shippedPreset" }
    New-Item -ItemType Directory -Path $engineeringStage, $deepSeekStage | Out-Null
    $presetText = Get-Content -Raw -Encoding UTF8 -LiteralPath $shippedPreset
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
    [IO.File]::WriteAllText((Join-Path $engineeringStage 'agent.cordis.yml'), $presetText, $utf8)
    Copy-Item -LiteralPath (Join-Path $layout.Config 'preset.yml') -Destination (Join-Path $engineeringStage 'preset.yml')
    & (Join-Path $layout.Scripts 'Build-DeepSeekPreset.ps1') -EngineeringPresetPath (Join-Path $engineeringStage 'agent.cordis.yml') -DeepSeekPresetPath (Join-Path $deepSeekStage 'agent.cordis.yml')
    Copy-Item -LiteralPath (Join-Path $layout.Config 'preset-deepseek.yml') -Destination (Join-Path $deepSeekStage 'preset.yml')
    & (Join-Path $layout.Scripts 'Enable-EngineeringIsolation.ps1') -PresetDirectory $engineeringStage
    foreach ($item in $stages) {
        $profile = if ($item.Name -eq 'aih-engineering') { 'engineering' } else { 'deepseek' }
        & $layout.Node $closureTool copy $InstallRoot $item.Stage $profile | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Controller dependency closure copy failed for $($item.Name)." }
        $presetFile = Join-Path $item.Stage 'agent.cordis.yml'
        $contents = Get-Content -Raw -Encoding UTF8 -LiteralPath $presetFile
        if (-not $contents.Contains('- id: aih-controller')) {
            [IO.File]::AppendAllText($presetFile, "`n- id: aih-controller`n  name: './AihController.cjs'", $utf8)
        }
        & $layout.Node $validator $InstallRoot $item.Stage $item.Name | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Staged controller preset validation failed for $($item.Name)." }
    }
    foreach ($item in $stages) {
        if (Test-Path -LiteralPath $item.Target) {
            Move-Item -LiteralPath $item.Target -Destination $item.Backup
            $backedUp += $item
        }
        Move-Item -LiteralPath $item.Stage -Destination $item.Target
        $published += $item
        & $layout.Node $validator $InstallRoot $item.Target $item.Name | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Published controller preset validation failed for $($item.Name)." }
    }
    foreach ($item in $backedUp) { Remove-Item -LiteralPath $item.Backup -Recurse -Force -ErrorAction SilentlyContinue }
    $backedUp = @()
}
catch {
    foreach ($item in $published) {
        if (Test-Path -LiteralPath $item.Target) { Remove-Item -LiteralPath $item.Target -Recurse -Force }
    }
    foreach ($item in $backedUp) {
        if (Test-Path -LiteralPath $item.Backup) { Move-Item -LiteralPath $item.Backup -Destination $item.Target }
    }
    throw
}
finally {
    foreach ($item in $stages) {
        if (Test-Path -LiteralPath $item.Stage) { Remove-Item -LiteralPath $item.Stage -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
Write-Host 'Engineering and DeepSeek presets installed atomically and validated.'
