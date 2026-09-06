Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Phase V2: Visual Requirement Detector (deterministic) ────────────────────
# Decides whether a task's changes require visual verification. The decision
# is DETERMINISTIC: changed paths, changed extensions, diff size classes, and
# project policy/skill signals. It is NOT LLM keyword guessing.
# Visual review is an orthogonal CAPABILITY: the detector's result never
# introduces an execution class and never touches routing.
# MODEL != ROLE != EXECUTION CLASS != PROVIDER != CAPABILITY
#
# Requirement levels:
#   none        - no visual surface touched (backend, data, CLI, tests, docs)
#   recommended - minor visual surface touched (icon swap, tiny copy/spacing)
#   required    - significant UI work (screens, layout, navigation styling,
#                 design-system primitives, typography, cards/surfaces)

$script:AihVisualNonePathPatterns = @(
    '(^|/)migrations/',
    '(^|/)datasets/',
    '(^|/)server/',
    '(^|/)backend/',
    '(^|/)workers/',
    '(^|/)scripts/',
    '(^|/)fixtures/',
    '(^|/)__tests__/',
    '.test.[a-z]+$',
    '.spec.[a-z]+$',
    '.sql$',
    '.md$',
    '.json$',
    '.ya?ml$',
    '.lock$',
    '.snap$',
    '(^|/)db/'
)

$script:AihVisualRequiredPathPatterns = @(
    '(^|/)app/',
    '(^|/)screens/',
    '(^|/)pages/',
    '(^|/)views/',
    '(^|/)routes/',
    '(^|/)navigation/',
    '(^|/)navigators/',
    '(^|/)theme/',
    '(^|/)design/',
    '(^|/)tokens/',
    '(^|/)styles/',
    '(^|/)components/ui/',
    '(^|/)ui/',
    'layout.tsx$',
    'Layout.tsx$',
    'TabBar.',
    'Navigator.',
    'Header.'
)

$script:AihVisualRequiredContentPatterns = @(
    'StyleSheet.create',
    'styles*=s*{',
    'className=',
    'flexDirection',
    'justifyContent',
    'alignItems',
    'padding',
    'margin',
    'fontSize',
    'fontWeight',
    'backgroundColor',
    'borderRadius',
    'gap:',
    'grid-template',
    'display:s*flex',
    'display:s*grid'
)

$script:AihVisualRequiredExtensions = @('.css', '.scss', '.less', '.styl')

$script:AihVisualRecommendedPathPatterns = @(
    '(^|/)icons?/',
    '(^|/)assets/',
    '.svg$',
    '.png$',
    'Icon.'
)

$script:AihVisualSkillElevationMarker = 'remains UNVERIFIED until it has been inspected on an emulator or device'

function Test-AihVisualPathMatches {
    # Match a normalized (forward-slash, repo-relative) path against a regex list.
    param([string]$Path,[string[]]$Patterns)
    foreach($pattern in $Patterns){
        if($Path -match $pattern){ return $true }
    }
    return $false
}

function Get-AihVisualChangedFiles {
    # Deterministic change surface for a task: files changed relative to the
    # task's base commit plus current uncommitted changes. Falls back to
    # uncommitted-only when no base commit exists. Returns relative paths.
    param([string]$Workspace,[string]$TaskId)
    $changed=[Collections.Generic.List[string]]::new()
    $task=$null
    try{ $task=Get-AihTask $Workspace $TaskId }catch { $task=$null }
    $base=$null
    if($null-ne$task -and $null-ne$task.PSObject.Properties['baseCommit']){ $base=[string]$task.baseCommit }
    $push={ param($line) if(-not[string]::IsNullOrWhiteSpace($line)){ $changed.Add($line.Trim()) } }
    if(-not[string]::IsNullOrWhiteSpace($base)){
        try{
            $committed=& git -C $Workspace diff --name-only ($base.Trim()+'...HEAD') 2>$null
            foreach($line in $committed){ & $push $line }
        }catch { }
    }
    try{
        $uncommitted=& git -C $Workspace status --porcelain 2>$null
        foreach($line in $uncommitted){
            if([string]::IsNullOrWhiteSpace($line)){ continue }
            $path=$line.Substring(3).Trim()
            if($path.StartsWith('"')-and$path.EndsWith('"')-and$path.Length-ge2){ $path=$path.Substring(1,$path.Length-2) }
            & $push $path
        }
    }catch { }
    return @($changed | Select-Object -Unique)
}

function Get-AihVisualPolicy {
    # Project policy override: <workspace>/.ai-harness/visual-policy.json.
    # Project-specific rules always win over the generic classification.
    param([string]$Workspace)
    $policyPath=Join-Path (Join-Path $Workspace '.ai-harness') 'visual-policy.json'
    if(-not(Test-Path -LiteralPath $policyPath)){ return $null }
    try{ return Get-Content -Raw -Encoding UTF8 -LiteralPath $policyPath | ConvertFrom-Json }catch { return $null }
}

function Get-AihVisualSkillElevation {
    # Deterministic skill/policy signal: a project skill whose description or
    # body requires emulator/device inspection for significant UI work.
    param([string]$Workspace)
    $skillsRoot=Join-Path $Workspace '.agentsskills'
    $elevators=[Collections.Generic.List[hashtable]]::new()
    if(Test-Path -LiteralPath $skillsRoot){
        foreach($skillDir in @(Get-ChildItem -LiteralPath $skillsRoot -Directory -ErrorAction SilentlyContinue)){
            $skillFile=Join-Path $skillDir.FullName 'SKILL.md'
            if(-not(Test-Path -LiteralPath $skillFile)){ continue }
            $text=[string](Get-Content -Raw -Encoding UTF8 -LiteralPath $skillFile)
            if($text.Contains($script:AihVisualSkillElevationMarker)){
                $elevators.Add(@{ skill=$skillDir.Name; reason=($skillDir.Name+' requires emulator/device inspection for significant UI work') })
            }
        }
    }
    return @($elevators)
}

function Get-AihVisualRequirement {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,
        [Parameter(Mandatory=$true)][string]$TaskId,
        [string[]]$ChangedFiles=@(),
        [string]$ChangedFilesPath,
        $Policy
    )
    # Explicit changed-file input (bridge/test seam) wins over git discovery.
    if(-not[string]::IsNullOrWhiteSpace([string]$ChangedFilesPath)){
        if(Test-Path -LiteralPath $ChangedFilesPath){
            $ChangedFiles=@(Get-Content -Raw -Encoding UTF8 -LiteralPath $ChangedFilesPath | ConvertFrom-Json)
        }
    }
    if(@($ChangedFiles).Count -eq 0){ $ChangedFiles=@(Get-AihVisualChangedFiles -Workspace $Workspace -TaskId $TaskId) }
    if($null-eq$Policy){ $Policy=Get-AihVisualPolicy -Workspace $Workspace }

    $reasons=[Collections.Generic.List[string]]::new()
    $noneMatches=[Collections.Generic.List[string]]::new()
    $requiredMatches=[Collections.Generic.List[string]]::new()
    $recommendedMatches=[Collections.Generic.List[string]]::new()
    $policyRequired=[Collections.Generic.List[string]]::new()
    $policyNone=[Collections.Generic.List[string]]::new()

    # 0. hard project policy: explicit requirement override.
    $policyRequirement='auto'
    if($null-ne$Policy-and$null-ne$Policy.PSObject.Properties['requirement']){ $policyRequirement=[string]$Policy.requirement }
    if($policyRequirement-eq'none'){ $reasons.Add('Project visual policy forces requirement none for this project.') }

    # 1. policy nonePatterns / requirePatterns (strongest deterministic signals).
    if($null-ne$Policy){
        foreach($file in @($ChangedFiles)){
            $normalized=$file.Replace([string][char]92,'/')
            if($null-ne$Policy.PSObject.Properties['nonePatterns']){
                foreach($pattern in @($Policy.nonePatterns)){ if($normalized-match$pattern){ $policyNone.Add($file); break } }
            }
            if($null-ne$Policy.PSObject.Properties['requirePatterns']){
                foreach($pattern in @($Policy.requirePatterns)){ if($normalized-match$pattern){ $policyRequired.Add($file); break } }
            }
        }
    }

    # 2. generic classification per changed file.
    $visualCandidates=[Collections.Generic.List[string]]::new()
    foreach($rawFile in @($ChangedFiles)){
        $file=$rawFile.Replace([string][char]92,'/')
        if($policyNone.Contains($rawFile)-or$policyNone.Contains($file)){ continue }
        if(Test-AihVisualPathMatches -Path $file -Patterns $script:AihVisualNonePathPatterns){ $noneMatches.Add($file); continue }
        if($policyRequired.Contains($rawFile)-or$policyRequired.Contains($file)){ $requiredMatches.Add($file); $visualCandidates.Add($file); continue }
        if(Test-AihVisualPathMatches -Path $file -Patterns $script:AihVisualRequiredPathPatterns){ $requiredMatches.Add($file); $visualCandidates.Add($file); continue }
        $extension=[IO.Path]::GetExtension($file).ToLowerInvariant()
        if($script:AihVisualRequiredExtensions.Contains($extension)){ $requiredMatches.Add($file); $visualCandidates.Add($file); continue }
        if(Test-AihVisualPathMatches -Path $file -Patterns $script:AihVisualRecommendedPathPatterns){ $recommendedMatches.Add($file); $visualCandidates.Add($file); continue }
        $noneMatches.Add($file)
    }

    # 3. decide.
    $requirement='none'
    if($policyRequirement-eq'required'){
        $requirement='required'
        if(@($ChangedFiles).Count-gt 0){ $reasons.Add('Project visual policy forces requirement required for this project.') }
    }elseif(@($policyRequired).Count-gt 0){
        $requirement='required'
        $reasons.Add(('Project visual policy marks this as significant UI work: '+(@($policyRequired | Select-Object -First 3)-join ', ')))
    }elseif(@($requiredMatches).Count-gt 0){
        $requirement='required'
        foreach($file in @($requiredMatches | Select-Object -First 3)){ $reasons.Add(($file+' contains visual style/layout surface changes')) }
    }elseif(@($recommendedMatches).Count-gt 0){
        $requirement='recommended'
        foreach($file in @($recommendedMatches | Select-Object -First 3)){ $reasons.Add(($file+' touches a minor visual surface (asset/minor change)')) }
    }

    # 4. skill elevation: a project skill demanding emulator/device inspection
    #    raises recommended -> required whenever any visual surface was touched.
    $skillElevators=@()
    if($requirement-eq'recommended'){
        $skillElevators=@(Get-AihVisualSkillElevation -Workspace $Workspace)
        if(@($skillElevators).Count-gt 0){
            $requirement='required'
            foreach($elevator in $skillElevators){ $reasons.Add($elevator.reason) }
        }
    }
    if($requirement-eq'required'-and$null-ne$Policy-and$null-ne$Policy.PSObject.Properties['skillElevationReasons']){
        foreach($reason in @($Policy.skillElevationReasons)){ $reasons.Add([string]$reason) }
    }

    if(@($ChangedFiles).Count-eq 0){ $requirement='none'; $reasons.Add('No changed files were detected for this task.') }
    if($policyRequirement-eq'none'){ $requirement='none' }

    return [ordered]@{
        schemaVersion=2
        kind='visual-requirement-detection'
        taskId=$TaskId
        requirement=$requirement
        reasons=@($reasons)
        changedFiles=@($ChangedFiles)
        signals=[ordered]@{
            changedFileCount=@($ChangedFiles).Count
            requiredPatternMatches=@($requiredMatches)
            recommendedPatternMatches=@($recommendedMatches)
            nonePatternMatches=@($noneMatches)
            policyRequiredMatches=@($policyRequired)
            policyNoneMatches=@($policyNone)
            policyRequirement=$policyRequirement
            skillElevators=@($skillElevators | ForEach-Object { $_.skill })
        }
        decidedAtUtc=[DateTime]::UtcNow.ToString('o')
    }
}
