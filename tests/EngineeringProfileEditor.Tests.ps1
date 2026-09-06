[CmdletBinding()]param([string]$InstallRoot)
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Routing.ps1')
. (Join-Path $InstallRoot 'scripts/ControlRoom.ps1')

$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
function New-Fixture([string]$Name){$path=Join-Path ([IO.Path]::GetTempPath()) ("aih-"+$Name+"-"+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $path|Out-Null;$path}

$layout=Get-AihLayout $InstallRoot

# ── fixture: an isolated install root with config + live settings ──────────
$fixture=New-Fixture 'editor-fixture'
try{
    New-Item -ItemType Directory -Path (Join-Path $fixture 'config') -Force|Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'data/routing') -Force|Out-Null
    Copy-Item $layout.EngineeringProfiles (Join-Path $fixture 'config/engineering-profiles.json')
    Copy-Item $layout.ModelRegistry (Join-Path $fixture 'config/model-registry.json')
    Copy-Item $layout.RoutingPolicy (Join-Path $fixture 'config/routing-policy.json')
    Copy-Item $layout.Settings (Join-Path $fixture 'data/settings.yaml')
    $flayout=Get-AihLayout $fixture

    function Invoke-AihEditor {param([string]$Action,[string]$ProfileId,[string]$PayloadFile)
        & (Join-Path $InstallRoot 'scripts/EngineeringProfile.ps1') -Action $Action -InstallRoot $fixture -ProfileId $ProfileId -PayloadFile $PayloadFile
    }
    function Invoke-AihEditorState {
        $raw=& (Join-Path $InstallRoot 'scripts/EngineeringProfile.ps1') -Action get -InstallRoot $fixture
        $raw|ConvertFrom-Json
    }
    function Save-AihEditorCustom {param([hashtable]$Roles)
        $document=@{roles=$Roles}
        $path=Join-Path $fixture 'payload.json'
        $document|ConvertTo-Json -Depth 10|Set-Content -Path $path -Encoding UTF8
        Invoke-AihEditor 'save-custom' $null $path
    }

    # 1. both built-in profiles are selectable directly
    $r1=Invoke-AihEditor 'select' 'deepseek-codex' $null|ConvertFrom-Json
    Assert-Aih ($r1.ok -and $r1.profileId -eq 'deepseek-codex') '1: DeepSeek + Codex is selectable'
    $r1b=Invoke-AihEditor 'select' 'glm-codex' $null|ConvertFrom-Json
    Assert-Aih ($r1b.ok -and $r1b.profileId -eq 'glm-codex') '1: GLM + Codex is selectable'

    # 2. built-in registry files are NEVER mutated by the editor
    $beforeProfiles=Get-FileHash (Join-Path $fixture 'config/engineering-profiles.json')
    $state=Invoke-AihEditorState
    Assert-Aih ((@($state.profiles|Where-Object{$_.id -eq 'custom'}).Count) -eq 0) '2: no custom profile before first save'
    $afterProfiles=Get-FileHash (Join-Path $fixture 'config/engineering-profiles.json')
    Assert-Aih ($beforeProfiles.Hash -eq $afterProfiles.Hash) '2: built-in profiles registry byte-identical after reads'

    # 3. Custom profile DoD bindings save + persist
    $dodRoles=@{
        primaryEngineer=@{model='glm-5.3';reasoning='high'}
        deepEngineer=@{model='glm-5.3';reasoning='max'}
        reviewer=@{model='gpt-5.6-sol';reasoning='medium'}
        solver=@{model='gpt-5.6-sol';reasoning='high'}
        fallback=@{model='deepseek-v4-flash';reasoning='max'}
    }
    $saved=Save-AihEditorCustom $dodRoles|ConvertFrom-Json
    Assert-Aih ($saved.roles.primaryEngineer.model -eq 'glm-5.3' -and $saved.roles.primaryEngineer.reasoning -eq 'high') '3: custom profile persisted (primaryEngineer glm-5.3/high)'
    Assert-Aih (Test-Path -LiteralPath $flayout.CustomEngineeringProfile) '3: custom profile file created at the layout path'
    $settingsText=Get-Content -Raw $flayout.Settings
    Assert-Aih ([regex]::IsMatch($settingsText,'(?m)^engineering-profile:\s*custom')) '3: preferred profile switched to custom after save'

    # 4. GET now exposes custom; PREFERRED reflects the save
    $state2=Invoke-AihEditorState
    $customProfile=@($state2.profiles|Where-Object{$_.id -eq 'custom'})
    Assert-Aih ($customProfile.Count -eq 1) '4: custom profile appears in the editor state'
    Assert-Aih ($state2.preferredProfile.id -eq 'custom' -and $state2.preferredProfile.displayName -eq 'Custom') '4: PREFERRED profile is custom after save'
    Assert-Aih ((@($state2.roleModels.reviewer)) -contains 'gpt-5.6-sol') '4: reviewer-compatible models listed'

    # 5. resolution through the custom profile: DoD exact provider/model
    $d=Invoke-AihRoutingDecision 'implement ordinary change' $fixture (Join-Path $fixture 'config/routing-policy.json') (Join-Path $fixture 'data/routing') 'editor-task-5' 'aih-engineering' -DryRun -SettingsPath $flayout.Settings -CustomProfilePath $flayout.CustomEngineeringProfile
    Assert-Aih ($d.executionClass -eq 'engineer_normal') '5: engineer_normal execution class unchanged (routing semantics untouched)'
    Assert-Aih ($d.role -eq 'primaryEngineer') '5: role primaryEngineer unchanged'
    Assert-Aih ($d.profile -eq 'custom') '5: profile custom'
    Assert-Aih ($d.provider -eq 'zai-direct' -and $d.model -eq 'glm-5.3' -and $d.reasoning -eq 'high') '5: DoD — provider Z.ai / model GLM-5.3 / reasoning high'

    # 6. change ONLY primaryEngineer -> glm-5.3-flash; next task uses it
    $dodRoles2=@{primaryEngineer=@{model='glm-5.3-flash';reasoning='high'};deepEngineer=@{model='glm-5.3';reasoning='max'};reviewer=@{model='gpt-5.6-sol';reasoning='medium'};solver=@{model='gpt-5.6-sol';reasoning='high'};fallback=@{model='deepseek-v4-flash';reasoning='max'}}
    Save-AihEditorCustom $dodRoles2|Out-Null
    $d2=Invoke-AihRoutingDecision 'implement ordinary change' $fixture (Join-Path $fixture 'config/routing-policy.json') (Join-Path $fixture 'data/routing') 'editor-task-6' 'aih-engineering' -DryRun -SettingsPath $flayout.Settings -CustomProfilePath $flayout.CustomEngineeringProfile
    Assert-Aih ($d2.provider -eq 'zai-direct' -and $d2.model -eq 'glm-5.3-flash') '6: next execution uses glm-5.3-flash with ZERO routing/controller changes'

    # 7. deepEngineer independent change (custom binding glm-5.3/max — independent of the built-in glm-codex deep role Phase 3.2.5 remapped to glm-5.3-flash/max)
    $dodRoles3=@{primaryEngineer=@{model='glm-5.3';reasoning='high'};deepEngineer=@{model='glm-5.3';reasoning='max'};reviewer=@{model='gpt-5.6-sol';reasoning='medium'};solver=@{model='gpt-5.6-sol';reasoning='high'};fallback=@{model='deepseek-v4-flash';reasoning='max'}}
    Save-AihEditorCustom $dodRoles3|Out-Null
    $d3=Invoke-AihRoutingDecision 'escalate' $fixture (Join-Path $fixture 'config/routing-policy.json') (Join-Path $fixture 'data/routing') 'editor-task-7' 'aih-engineering' -DryRun -SettingsPath $flayout.Settings -CustomProfilePath $flayout.CustomEngineeringProfile -ForceClass engineer_deep
    Assert-Aih ($d3.role -eq 'deepEngineer' -and $d3.model -eq 'glm-5.3' -and $d3.reasoning -eq 'max') '7: deepEngineer independently changed'

    # 8. reviewer independent change (gpt-5.6-sol → compatible reviewer) — only sol-local models qualify
    $dodRoles4=@{primaryEngineer=@{model='glm-5.3';reasoning='high'};deepEngineer=@{model='glm-5.3';reasoning='max'};reviewer=@{model='gpt-5.6-sol';reasoning='low'};solver=@{model='gpt-5.6-sol';reasoning='high'};fallback=@{model='deepseek-v4-flash';reasoning='max'}}
    Save-AihEditorCustom $dodRoles4|Out-Null
    $d4=Invoke-AihRoutingDecision 'review' $fixture (Join-Path $fixture 'config/routing-policy.json') (Join-Path $fixture 'data/routing') 'editor-task-8' 'aih-engineering' -DryRun -SettingsPath $flayout.Settings -CustomProfilePath $flayout.CustomEngineeringProfile -ForceClass reviewer
    Assert-Aih ($d4.role -eq 'reviewer' -and $d4.model -eq 'gpt-5.6-sol' -and $d4.reasoning -eq 'low') '8: reviewer independently changed to a compatible reviewer model'

    # 9. solver independent change + approval gating preserved
    $dodRoles5=@{primaryEngineer=@{model='glm-5.3';reasoning='high'};deepEngineer=@{model='glm-5.3';reasoning='max'};reviewer=@{model='gpt-5.6-sol';reasoning='medium'};solver=@{model='deepseek-v4-flash';reasoning='high'};fallback=@{model='deepseek-v4-flash';reasoning='max'}}
    Save-AihEditorCustom $dodRoles5|Out-Null
    $threw=$false
    try{Invoke-AihRoutingDecision 'solve' $fixture (Join-Path $fixture 'config/routing-policy.json') (Join-Path $fixture 'data/routing') 'editor-task-9' 'aih-engineering' -DryRun -SettingsPath $flayout.Settings -CustomProfilePath $flayout.CustomEngineeringProfile -ForceClass solver|Out-Null}catch{$threw=$true}
    Assert-Aih $threw '9: solver still requires explicit user approval (gate preserved)'
    $d9=Invoke-AihRoutingDecision 'solve' $fixture (Join-Path $fixture 'config/routing-policy.json') (Join-Path $fixture 'data/routing') 'editor-task-9' 'aih-engineering' -DryRun -SettingsPath $flayout.Settings -CustomProfilePath $flayout.CustomEngineeringProfile -ForceClass solver -UserApprovedCodexSolve
    Assert-Aih ($d9.role -eq 'solver' -and $d9.model -eq 'deepseek-v4-flash') '9: solver independently changed and approves with explicit gate'

    # 10. unknown model rejected; last valid config preserved
    $bad=@{primaryEngineer=@{model='not-a-model';reasoning='high'};deepEngineer=@{model='glm-5.3';reasoning='max'};reviewer=@{model='gpt-5.6-sol';reasoning='medium'};solver=@{model='gpt-5.6-sol';reasoning='high'};fallback=@{model='deepseek-v4-flash';reasoning='max'}}
    $threw=$false
    try{Save-AihEditorCustom $bad|Out-Null}catch{$threw=$true}
    Assert-Aih $threw '10: unknown model id rejected'
    $preserved=Get-Content -Raw $flayout.CustomEngineeringProfile|ConvertFrom-Json
    Assert-Aih ($preserved.roles.primaryEngineer.model -eq 'glm-5.3') '10: last valid config preserved after rejected save'

    # 11. disabled model rejected (fixture registry with a disabled entry)
    $registryDoc=Get-Content -Raw (Join-Path $fixture 'config/model-registry.json')|ConvertFrom-Json
    $registryDoc.models|Add-Member -NotePropertyName 'enabled' -NotePropertyValue $true -Force
    $registryDoc.models|Where-Object{$_.id -eq 'glm-5.3'}|ForEach-Object{$_|Add-Member -NotePropertyName 'enabled' -NotePropertyValue $false -Force}
    $registryDoc|ConvertTo-Json -Depth 10|Set-Content -Path (Join-Path $fixture 'config/model-registry.json') -Encoding UTF8
    $threw=$false
    try{Save-AihEditorCustom $dodRoles3|Out-Null}catch{$threw=$true}
    Assert-Aih $threw '11: disabled model rejected (glm-5.3 disabled)'

    # 12. capability-incompatible assignment rejected (primaryEngineer ← no-tools model)
    $registryDoc.models|Where-Object{$_.id -eq 'glm-5.3'}|ForEach-Object{$_|Add-Member -NotePropertyName 'enabled' -NotePropertyValue $true -Force}
    $registryDoc|ConvertTo-Json -Depth 10|Set-Content -Path (Join-Path $fixture 'config/model-registry.json') -Encoding UTF8
    $badCap=@{primaryEngineer=@{model='gpt-5.6-sol';reasoning='high'};deepEngineer=@{model='glm-5.3';reasoning='max'};reviewer=@{model='gpt-5.6-sol';reasoning='medium'};solver=@{model='gpt-5.6-sol';reasoning='high'};fallback=@{model='deepseek-v4-flash';reasoning='max'}}
    $threw=$false
    try{Save-AihEditorCustom $badCap|Out-Null}catch{$threw=$true}
    Assert-Aih $threw '12: primaryEngineer rejects a model without tools (capability rule)'
    $badRev=@{primaryEngineer=@{model='glm-5.3';reasoning='high'};deepEngineer=@{model='glm-5.3';reasoning='max'};reviewer=@{model='glm-5.3';reasoning='medium'};solver=@{model='gpt-5.6-sol';reasoning='high'};fallback=@{model='deepseek-v4-flash';reasoning='max'}}
    $threw=$false
    try{Save-AihEditorCustom $badRev|Out-Null}catch{$threw=$true}
    Assert-Aih $threw '12: reviewer rejects a non-sol-local model (transport constraint)'

    # 13. unsupported reasoning level rejected
    # 13. unsupported reasoning level rejected (the probed level is DERIVED
    #     from the fixture registry, so registry rebalances — e.g. Phase 3.2.5
    #     granting glm-5.3-flash max support — cannot silently flip the scenario)
    $fixtureRegistry13=Get-Content -Raw (Join-Path $fixture 'config/model-registry.json')|ConvertFrom-Json
    $flash13=@($fixtureRegistry13.models)|Where-Object{$_.id -eq 'glm-5.3-flash'}
    $badLevel13=@('low','medium','xhigh')|Where-Object{@($flash13.supportedReasoningLevels) -notcontains $_}|Select-Object -First 1
    Assert-Aih (-not [string]::IsNullOrWhiteSpace([string]$badLevel13)) '13: fixture probe prerequisite (a reasoning level glm-5.3-flash does not support)'
    $badReasoning=@{primaryEngineer=@{model='glm-5.3-flash';reasoning=[string]$badLevel13};deepEngineer=@{model='glm-5.3';reasoning='max'};reviewer=@{model='gpt-5.6-sol';reasoning='medium'};solver=@{model='gpt-5.6-sol';reasoning='high'};fallback=@{model='deepseek-v4-flash';reasoning='max'}}
    $threw=$false
    try{Save-AihEditorCustom $badReasoning|Out-Null}catch{$threw=$true}
    Assert-Aih $threw "13: unsupported reasoning level rejected (glm-5.3-flash/$badLevel13)"

    # 14. invalid payload (malformed JSON / missing roles) rejected atomically
    Set-Content -Path (Join-Path $fixture 'bad.json') -Value '{not-json' -Encoding UTF8
    $threw=$false
    try{Invoke-AihEditor 'save-custom' $null (Join-Path $fixture 'bad.json')|Out-Null}catch{$threw=$true}
    Assert-Aih $threw '14: malformed payload file rejected'
    $missingRoles=@{primaryEngineer=@{model='glm-5.3';reasoning='high'};deepEngineer=@{model='glm-5.3';reasoning='max'};reviewer=@{model='gpt-5.6-sol';reasoning='medium'};solver=@{model='gpt-5.6-sol';reasoning='high'}}
    $threw=$false
    try{Save-AihEditorCustom $missingRoles|Out-Null}catch{$threw=$true}
    Assert-Aih $threw '14: missing role binding rejected'
    $preserved2=Get-Content -Raw $flayout.CustomEngineeringProfile|ConvertFrom-Json
    Assert-Aih ($preserved2.roles.solver.model -eq 'deepseek-v4-flash') '14: invalid saves never corrupt the last valid config'

    # 15. custom profile persists across "restart" (fresh process reads the file)
    $state15=Invoke-AihEditorState
    Assert-Aih ((@($state15.profiles|Where-Object{$_.id -eq 'custom'}).Count) -eq 1) '15: custom profile persists across reloads'
    Assert-Aih ($state15.customRoles.primaryEngineer.model -eq 'glm-5.3') '15: custom bindings re-read from the authoritative file'

    # 16. PREFERRED changes after save (Control Room mode follows settings)
    $mode=Get-AihControlRoomMode (Get-AihRoutingPolicy (Join-Path $fixture 'config/routing-policy.json')) 'aih-engineering' (Join-Path $fixture 'config/engineering-profiles.json') $flayout.Settings $flayout.CustomEngineeringProfile
    Assert-Aih ($mode.Profile -eq 'custom' -and $mode.ProfileDisplayName -eq 'Custom') '16: Control Room PREFERRED profile follows the save'
    $d16=Invoke-AihRoutingDecision 'implement ordinary change' $fixture (Join-Path $fixture 'config/routing-policy.json') (Join-Path $fixture 'data/routing') 'editor-task-16' 'aih-engineering' -DryRun -SettingsPath $flayout.Settings -CustomProfilePath $flayout.CustomEngineeringProfile
    Assert-Aih ($d16.profile -eq 'custom') '16: next resolution uses the new preferred profile'

    # 17. RUNNING execution identity never rewritten by a save
    $d17=Invoke-AihRoutingDecision 'implement ordinary change' $fixture (Join-Path $fixture 'config/routing-policy.json') (Join-Path $fixture 'data/routing') 'editor-task-17' 'aih-engineering' -SettingsPath $flayout.Settings -CustomProfilePath $flayout.CustomEngineeringProfile
    Save-AihEditorCustom $dodRoles2|Out-Null
    $state17=Get-Content -Raw (Join-Path $flayout.RoutingData 'decisions.jsonl')|ConvertFrom-Json
    Assert-Aih ($state17.recordVersion -eq 4 -and $state17.provider -eq 'zai-direct' -and $state17.model -eq 'glm-5.3') '17: RUNNING decision record untouched by a later save'

    # 18. new registry entry becomes selectable with zero code changes
    $registryDoc2=Get-Content -Raw (Join-Path $fixture 'config/model-registry.json')|ConvertFrom-Json
    $registryDoc2.models+= [pscustomobject]@{id='glm-5.3-lite';displayName='GLM-5.3 Lite';vendor='Z.ai';model='glm-5.3-lite';provider='zai-direct';supportsTools=$true;supportsReasoning=$true;supportsVision=$false;supportsStreaming=$true;contextWindow=32768;maxOutputTokens=4096;enabled=$true;supportedReasoningLevels=@('off','high')}
    $registryDoc2|ConvertTo-Json -Depth 10|Set-Content -Path (Join-Path $fixture 'config/model-registry.json') -Encoding UTF8
    $state18=Invoke-AihEditorState
    Assert-Aih ((@($state18.roleModels.primaryEngineer)) -contains 'glm-5.3-lite') '18: new registry entry selectable for compatible roles (no UI/code change)'
    $dodRoles6=@{primaryEngineer=@{model='glm-5.3-lite';reasoning='high'};deepEngineer=@{model='glm-5.3';reasoning='max'};reviewer=@{model='gpt-5.6-sol';reasoning='medium'};solver=@{model='gpt-5.6-sol';reasoning='high'};fallback=@{model='deepseek-v4-flash';reasoning='max'}}
    $saved18=Save-AihEditorCustom $dodRoles6|ConvertFrom-Json
    Assert-Aih ($saved18.roles.primaryEngineer.model -eq 'glm-5.3-lite') '18: new registry entry accepted by the backend'

    # 19. select rejects unknown profile ids; save-custom sets preferred to custom
    $threw=$false
    try{Invoke-AihEditor 'select' 'bogus-profile' $null|Out-Null}catch{$threw=$true}
    Assert-Aih $threw '19: select rejects an unknown profile id'
    $settingsFinal=Get-Content -Raw $flayout.Settings
    Assert-Aih ([regex]::IsMatch($settingsFinal,'(?m)^engineering-profile:\s*custom')) '19: preferred profile is custom after the last save'

    # 20. Profile dropdown state exposes BOTH built-ins unchanged
    $state20=Invoke-AihEditorState
    $builtins=@($state20.profiles|Where-Object{$_.id -ne 'custom'})
    Assert-Aih ($builtins.Count -eq 2) '20: both built-in profiles exposed'
    Assert-Aih ($builtins[0].roles.primaryEngineer.model -eq 'deepseek-v4-flash' -and $builtins[1].roles.primaryEngineer.model -eq 'glm-5.3-flash') '20: built-in bindings untouched by the editor'

    # 21. back to a built-in profile restores its binding (select only)
    $sel21=Invoke-AihEditor 'select' 'glm-codex' $null|ConvertFrom-Json
    Assert-Aih ($sel21.ok -and $sel21.profileId -eq 'glm-codex') '21: built-in profile reselectable after custom work'
    $d21=Invoke-AihRoutingDecision 'implement ordinary change' $fixture (Join-Path $fixture 'config/routing-policy.json') (Join-Path $fixture 'data/routing') 'editor-task-21' 'aih-engineering' -DryRun -SettingsPath $flayout.Settings -CustomProfilePath $flayout.CustomEngineeringProfile
    Assert-Aih ($d21.profile -eq 'glm-codex' -and $d21.provider -eq 'zai-direct' -and $d21.model -eq 'glm-5.3-flash') '21: glm-codex resolution restored exactly'

    # 22. subagent/delegation config is untouched by the editor (no writes outside
    #     settings + custom profile file)
    $delegationBefore=Get-Content -Raw (Join-Path $InstallRoot 'config/delegation-block.yml') -ErrorAction SilentlyContinue
    Save-AihEditorCustom $dodRoles3|Out-Null
    $delegationAfter=Get-Content -Raw (Join-Path $InstallRoot 'config/delegation-block.yml') -ErrorAction SilentlyContinue
    Assert-Aih ($delegationBefore -eq $delegationAfter) '22: delegation/subagent configuration untouched by editor saves'

    Write-Host "RESULT: $passed Phase-2.1 engineering-profile-editor assertions passed."
}finally{if(Test-Path $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}}
