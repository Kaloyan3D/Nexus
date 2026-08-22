[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EngineeringPresetPath,
    [Parameter(Mandatory = $true)][string]$DeepSeekPresetPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$engineeringPath = [System.IO.Path]::GetFullPath($EngineeringPresetPath)
$deepSeekPath = [System.IO.Path]::GetFullPath($DeepSeekPresetPath)
if (-not (Test-Path -LiteralPath $engineeringPath -PathType Leaf)) {
    throw "Engineering preset does not exist: $engineeringPath"
}

$text = Get-Content -Raw -Encoding UTF8 -LiteralPath $engineeringPath
$personaPattern = '(?ms)^- id: persona\r?\n.*?(?=^- id: agent-instructions)'
$personaReplacement = @'
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: !!js process.env.AIH_PERSONA_DEEPSEEK ?? 'You are the DeepSeek implementation agent. Complete the supplied bounded task using repository-local instructions and relevant context. Use targeted verification and return structured evidence. The deterministic controller owns routing, retries, budgets, escalation, and completion. Codex is unavailable in this preset.'

'@
if ([regex]::Matches($text, $personaPattern).Count -ne 1) {
    throw 'Engineering preset persona structure changed; refusing an unsafe DeepSeek transform.'
}
$text = [regex]::Replace($text, $personaPattern, $personaReplacement)

$codexPattern = '(?ms)^    - id: tool-subagent-codex\r?\n.*?(?=^    - id: workflow-worker-thread)'
if ([regex]::Matches($text, $codexPattern).Count -ne 1) {
    throw 'Engineering preset Codex subagent structure changed; refusing an unsafe DeepSeek transform.'
}
$text = [regex]::Replace($text, $codexPattern, '')
$text = $text.TrimEnd() + @'


- id: aih-deepseek-isolation
  name: './DeepSeek-Isolation.cjs'
'@

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $deepSeekPath) | Out-Null
[System.IO.File]::WriteAllText($deepSeekPath, $text, [System.Text.UTF8Encoding]::new($false))
