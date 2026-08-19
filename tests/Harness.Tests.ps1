[CmdletBinding()]
param([string]$InstallRoot = 'C:\AI-Harness')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts\Common.ps1')
. (Join-Path $InstallRoot 'scripts\Routing.ps1')
. (Join-Path $InstallRoot 'scripts\Completion.ps1')
. (Join-Path $InstallRoot 'scripts\Project.ps1')

$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name, [string]$Detail = '') {
    if (-not $Condition) { throw "FAIL: $Name$(if ($Detail) { " - $Detail" })" }
    $script:passed++
    Write-Host "PASS: $Name$(if ($Detail) { " - $Detail" })"
}

$layout = Get-AihLayout $InstallRoot
$policy = Get-AihRoutingPolicy $layout.RoutingPolicy
$normal = Resolve-AihPreset $policy 'aih-engineering'
$deep = Resolve-AihPreset $policy 'deepseek'

Assert-Aih ($normal.Id -eq 'aih-engineering') 'normal preset resolves'
Assert-Aih ($deep.Id -eq 'aih-deepseek') 'DeepSeek-only preset resolves'
Assert-Aih ((Test-Path (Join-Path $layout.Data '.agent-presets\aih-engineering\agent.cordis.yml'))) 'normal native preset loads from roster'
Assert-Aih ((Test-Path (Join-Path $layout.Data '.agent-presets\aih-deepseek\agent.cordis.yml'))) 'DeepSeek native preset loads from roster'
Assert-Aih ($normal.Config.tiers.'1'.provider -eq 'sol-local' -and $normal.Config.tiers.'1'.model -eq 'gpt-5.6-sol') 'normal Tier 1 is Sol'
Assert-Aih ($deep.Config.tiers.'1'.provider -eq 'deepseek-pro-direct' -and $deep.Config.tiers.'1'.model -eq 'deepseek-v4-pro' -and $deep.Config.tiers.'1'.reasoning -eq 'max') 'DeepSeek Tier 1 is V4 Pro MAX'
Assert-Aih ($deep.Config.tiers.'2'.provider -eq 'flash-max-direct' -and $deep.Config.tiers.'2'.reasoning -eq 'max') 'DeepSeek Tier 2 is Flash MAX'
Assert-Aih ($deep.Config.tiers.'3'.provider -eq 'flash-high-direct' -and $deep.Config.tiers.'3'.reasoning -eq 'high') 'DeepSeek Tier 3 is Flash High'
Assert-Aih ($deep.Config.semanticVerifier.model -eq 'deepseek-v4-pro' -and $deep.Config.semanticVerifier.reasoning -eq 'max') 'DeepSeek semantic verifier is V4 Pro MAX'
Assert-Aih ($normal.Config.semanticVerifier.model -eq 'gpt-5.6-sol') 'normal semantic verifier remains Sol'

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('aih-routing-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $tempRoot 'states') | Out-Null
try {
    $first = Invoke-AihRoutingDecision -Description 'Substantial multi-file implementation.' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $tempRoot -TaskId 'deep-escalation' -Preset aih-deepseek -ForceTier tier2
    $escalated = Invoke-AihRoutingDecision -Description 'Substantial multi-file implementation.' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $tempRoot -TaskId 'deep-escalation' -Preset aih-deepseek -Signal tier2-failed
    Assert-Aih ($first.selectedTier -eq 2 -and $escalated.selectedTier -eq 1 -and $escalated.model -eq 'deepseek-v4-pro') 'DeepSeek Tier 2 escalation reaches V4 Pro'
    Assert-Aih ($escalated.preset -eq 'aih-deepseek') 'routing audit records active preset'
    Assert-Aih (-not $escalated.completionAuthority) 'workers retain no completion authority'
    $savedState = Read-AihRoutingState (Get-AihRoutingStatePath $tempRoot $InstallRoot 'deep-escalation' 'aih-deepseek')
    Assert-Aih ($savedState.preset -eq 'aih-deepseek' -and $savedState.model -eq 'deepseek-v4-pro') 'routing state records preset and Tier 1 model'
}
finally { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }

$deepPresetText = Get-Content -Raw -LiteralPath (Join-Path $layout.Data '.agent-presets\aih-deepseek\agent.cordis.yml')
$guardText = Get-Content -Raw -LiteralPath (Join-Path $layout.Data '.agent-presets\aih-deepseek\DeepSeek-Isolation.cjs')
Assert-Aih ($deepPresetText -match 'tool-subagent-codex\s*\r?\n\s*disabled: true' -and $deepPresetText -notmatch 'provider:\s*codex') 'DeepSeek preset cannot expose native Codex subagent'
Assert-Aih ($guardText -match "deepseek-pro-direct" -and $guardText -match "header.origin === 'subagent'" -and $guardText -match "blocked model route" -and $guardText -notmatch 'sol-local|openai-oauth|gpt-') 'DeepSeek guard forces top-level Pro and contains no GPT fallback'
Assert-Aih (-not [bool]$deep.Config.allowOpenAI -and $deep.Config.failurePolicy -eq 'fail-closed') 'DeepSeek failure policy is fail closed'
$previousShellPreset = $env:DSH_AIH_PRESET
try {
    $env:DSH_AIH_PRESET = 'aih-deepseek'
    Assert-Aih ((Resolve-AihPreset $policy $null).Id -eq 'aih-deepseek') 'managed shell environment preserves DeepSeek preset for routing and completion'
}
finally { $env:DSH_AIH_PRESET = $previousShellPreset }

$normalRoute = Invoke-AihRoutingDecision -Description 'Design authentication architecture.' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $layout.RoutingData -Preset aih-engineering -DryRun
$deepRoute = Invoke-AihRoutingDecision -Description 'Design authentication architecture.' -Workspace $InstallRoot -PolicyPath $layout.RoutingPolicy -DataRoot $layout.RoutingData -Preset aih-deepseek -DryRun
Assert-Aih ($normalRoute.model -eq 'gpt-5.6-sol' -and $deepRoute.model -eq 'deepseek-v4-pro') 'preset-aware Tier 1 routing remains distinct'

$semantic = ConvertFrom-AihSemanticVerifierOutput '{"status":"PASS","summary":"evidence complete","concreteReasons":[],"missingRequirements":[],"boundedFixes":[]}' -Provider deepseek-pro-direct -Model deepseek-v4-pro -Reasoning max
$gate = New-AihCompletionDecision ([pscustomobject]@{ Pass = $true; Reasons = @(); Summary = [pscustomobject]@{ Results = @() } }) ([pscustomobject]@{ Pass = $true; Reasons = @(); Criteria = @() }) $semantic
Assert-Aih ($gate.Status -eq 'PASS' -and $semantic.model -eq 'deepseek-v4-pro') 'completion engine records selected semantic verifier'
$completionTemp = Join-Path ([IO.Path]::GetTempPath()) ('aih-completion-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $completionTemp | Out-Null
try {
    $completionRecord = [ordered]@{ recordVersion = 2; gateId = 'gate-record-probe'; timestampUtc = [DateTime]::UtcNow.ToString('o'); workspace = $InstallRoot; preset = 'aih-deepseek'; semanticVerifier = $semantic; objective = 'probe'; status = 'PASS'; complete = $true; gatePass = $true; override = [pscustomobject]@{ Applied = $false } }
    $completionPath = Write-AihCompletionRecord $completionRecord $completionTemp
    $savedCompletion = Get-Content -Raw -LiteralPath $completionPath | ConvertFrom-Json
    Assert-Aih ($savedCompletion.preset -eq 'aih-deepseek' -and $savedCompletion.semanticVerifier.model -eq 'deepseek-v4-pro') 'completion audit records preset and semantic verifier'
}
finally { Remove-Item -LiteralPath $completionTemp -Recurse -Force -ErrorAction SilentlyContinue }

$launcherText = Get-Content -Raw -LiteralPath (Join-Path $layout.Scripts 'aih.ps1')
$completeText = Get-Content -Raw -LiteralPath (Join-Path $layout.Scripts 'Complete-Objective.ps1')
Assert-Aih ($launcherText -match 'if \(-not \$deepSeekOnly\) \{ \$requiredPaths \+= \$layout.OAuth \}' -and $launcherText -match 'if \(-not \$deepSeekOnly' -and $launcherText -match 'AIH_ENABLE_CODEX_SUBAGENT = if \(\$EnableCodexSubagent -and -not \$deepSeekOnly\)') 'DeepSeek launcher does not require OAuth and disables Codex'
Assert-Aih ($completeText -match 'Invoke-AihDeepSeekSemanticVerifier' -and $completeText -match 'DeepSeek-only Tier 1 unavailable') 'completion verifier fails closed when Pro is unavailable'

$projectFixture = Join-Path ([IO.Path]::GetTempPath()) ('aih-project-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $projectFixture 'src') | Out-Null
try {
    [IO.File]::WriteAllText((Join-Path $projectFixture 'package.json'), '{"name":"aih-test-fixture","scripts":{"test":"node --test"}}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $projectFixture 'src\index.ts'), 'export const ready = true;', [Text.UTF8Encoding]::new($false))
    $profile = Get-AihProjectProfile -Workspace $projectFixture -InstallRoot $InstallRoot
    Assert-Aih ($profile.Stacks -contains 'Node.js') 'existing project detection remains operational'
}
finally { Remove-Item -LiteralPath $projectFixture -Recurse -Force -ErrorAction SilentlyContinue }

$sourceFiles = Get-ChildItem -LiteralPath $InstallRoot -Recurse -File | Where-Object { $_.FullName -notmatch '\\(\.git|app|runtime|data|logs)\\' }
$secretLeak = $sourceFiles | Select-String -Pattern '(?i)(sk-[A-Za-z0-9_-]{16,}|DEEPSEEK_API_KEY\s*:\s*[^\s''"]+)' | Select-Object -First 1
Assert-Aih ($null -eq $secretLeak) 'no credential value exists in source/config files'

$gitIgnore = Get-Content -Raw -LiteralPath (Join-Path $InstallRoot '.gitignore')
Assert-Aih ($gitIgnore -match '(?m)^data/$' -and $gitIgnore -match '(?m)^app/$' -and $gitIgnore -match '(?m)^runtime/node/$') 'generated runtime, state, and credentials are excluded from Git'
Assert-Aih ((Test-Path -LiteralPath (Join-Path $layout.Scripts 'Set-OpenAiOAuth.ps1')) -and (Test-Path -LiteralPath (Join-Path $layout.Bin 'aih-auth.cmd'))) 'per-user ChatGPT/Codex login helper is installed'
$oauthSetupText = Get-Content -Raw -LiteralPath (Join-Path $layout.Scripts 'Set-OpenAiOAuth.ps1')
Assert-Aih ($oauthSetupText -match '\$layout\.OAuth login --no-open') 'Windows OAuth login preserves the complete authorization URL'
$previousCodexHome = $env:CODEX_HOME
try {
    $env:CODEX_HOME = Join-Path ([IO.Path]::GetTempPath()) 'aih-custom-codex-home'
    Assert-Aih ((Get-AihCodexAuthFile) -eq (Join-Path ([IO.Path]::GetFullPath($env:CODEX_HOME)) 'auth.json')) 'custom CODEX_HOME is respected'
}
finally { $env:CODEX_HOME = $previousCodexHome }

foreach ($script in Get-ChildItem -LiteralPath (Join-Path $InstallRoot 'scripts') -Filter '*.ps1') {
    [void][scriptblock]::Create((Get-Content -Raw -LiteralPath $script.FullName))
}
[void][scriptblock]::Create((Get-Content -Raw -LiteralPath (Join-Path $InstallRoot 'setup.ps1')))
Assert-Aih $true 'all launcher, routing, completion, and doctor scripts parse'

& $layout.Node (Join-Path $InstallRoot 'tests\DeepSeekIsolation.Tests.cjs')
Assert-Aih ($LASTEXITCODE -eq 0) 'DeepSeek isolation runtime behavior passes'

Write-Host "RESULT: $passed deterministic assertions passed."
