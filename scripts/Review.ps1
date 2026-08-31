[CmdletBinding()]
param([string]$Workspace=(Get-Location).Path,[string]$InstallRoot,[Parameter(Mandatory=$true)][string]$TaskId,[string]$Question,[string[]]$Invariants=@(),[string]$DiffPath,[string]$FilesPath,[string]$Assessment,[switch]$Execute,[switch]$UserApprovedFullRepo,[ValidateSet('bundle','files','inline')][string]$ContextMode='bundle',[string]$Attempt,[string]$Preset,[string]$PayloadFile)
if([string]::IsNullOrWhiteSpace($InstallRoot)){$InstallRoot=Split-Path -Parent $PSScriptRoot}
$InstallRoot=[System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
. (Join-Path $PSScriptRoot 'CodexReview.ps1')
. (Join-Path $PSScriptRoot 'Telemetry.ps1')
# User-derived free text must not travel on the command line (ANSI codepage
# mangling + unescaped control characters in ConvertTo-Json break the
# controller bridge's strict JSON parse). The bridge writes a UTF-8 payload
# file and names it here.
if ($PayloadFile) {
    if (-not (Test-Path -LiteralPath $PayloadFile)) { throw "Payload file not found: $PayloadFile" }
    $__aihPayload = Get-Content -Raw -Encoding UTF8 -LiteralPath $PayloadFile | ConvertFrom-Json
    if ($null -ne $__aihPayload.PSObject.Properties['Workspace']) { $Workspace = [string]$__aihPayload.Workspace }
    if ($null -ne $__aihPayload.PSObject.Properties['Question']) { $Question = [string]$__aihPayload.Question }
    if ($null -ne $__aihPayload.PSObject.Properties['ContextMode']) { $ContextMode = [string]$__aihPayload.ContextMode }
}
if ([string]::IsNullOrWhiteSpace($Question)) { throw 'A review question is required.' }
$layout=Get-AihLayout $InstallRoot;$policy=Get-AihRoutingPolicy $layout.RoutingPolicy
# Phase 2: the reviewer ROLE is resolved through the active engineering
# profile + model registry (routing selected the class; the profile decides
# WHICH model fulfills the reviewer role). The bounded review transport in
# this phase is the local Codex/OAuth adapter (provider sol-local); any other
# reviewer provider fails closed at this adapter boundary.
$profiles=Get-AihEngineeringProfiles (Join-Path (Split-Path -Parent $layout.RoutingPolicy) 'engineering-profiles.json') $layout.CustomEngineeringProfile
$registry=Get-AihModelRegistry (Join-Path (Split-Path -Parent $layout.RoutingPolicy) 'model-registry.json')
$resolvedPreset=Resolve-AihPreset $policy $Preset
$profile=Resolve-AihProfile $policy $resolvedPreset $profiles $layout.Settings
$reviewerTarget=Resolve-AihModelTarget $registry $profile 'reviewer'
if($reviewerTarget.Provider -ne 'sol-local'){throw "Reviewer provider '$($reviewerTarget.Provider)' is not supported by the bounded review adapter in this phase; fail closed."}

$diff=''
if(-not[string]::IsNullOrWhiteSpace($DiffPath)){$diff=Get-Content -Raw -LiteralPath $DiffPath}
elseif([string]::IsNullOrWhiteSpace($FilesPath)){$previousErrorAction=$ErrorActionPreference;try{$ErrorActionPreference='Continue';$diff=(& git -C $Workspace diff --no-ext-diff HEAD -- 2>$null|Out-String)}finally{$ErrorActionPreference=$previousErrorAction}}
# When a context bundle (-FilesPath) is supplied the bundle IS the review
# context; the full working-tree diff must not be attached (it can be large
# and may carry working-tree-only content such as credential placeholders).
# A self-contained inline review (ContextMode 'inline') carries NO repository
# context at all: any diff is dropped so the packet stays question-only.
if($ContextMode -eq 'inline'){$diff=''}
$files=@()
if(-not[string]::IsNullOrWhiteSpace($FilesPath)){
    # Windows PowerShell 5.1 ConvertFrom-Json returns $null for an empty JSON
    # array ('[]'), and @($null) would smuggle one empty slice into the
    # packet. Normalize so a genuinely empty context stays empty.
    $parsedFiles=Get-Content -Raw -Encoding UTF8 -LiteralPath $FilesPath|ConvertFrom-Json
    if($null -ne $parsedFiles){$files=@($parsedFiles)}
}
$packet=New-AihReviewPacket $Workspace $TaskId $Question $Invariants $diff $files @() $Assessment $policy -UserApprovedFullRepo:$UserApprovedFullRepo -ContextMode $ContextMode -Attempt $Attempt
if($Execute){
    if(-not [bool]$packet.enforcement.allowed){
        $result=[ordered]@{ok=$false;kind='packet-too-large';taskId=$TaskId;executionClass='reviewer';role='reviewer';profile=$profile.Id;provider=$reviewerTarget.Provider;model=$reviewerTarget.Model;reviewerCalled=$false;codexCalled=$false;violations=@($packet.enforcement.violations);enforcement=$packet.enforcement;budget=$packet.budget;readOnly=$true;completionAuthority=$false}
        $result|ConvertTo-Json -Depth 20
        exit 3
    }
    $reviewResult=Invoke-AihCodexReview $Workspace $TaskId $packet $InstallRoot -Model $reviewerTarget.Model -Reasoning $reviewerTarget.Reasoning
    $budget=Get-AihCodexBudget $policy
    $telemetry=Write-AihTaskTelemetry $Workspace $TaskId @{executionClass='reviewer';model=$reviewerTarget.Model;provider=$reviewerTarget.Provider;modelCalls=1;codexFindings=@($reviewResult.findings);finalResult=$reviewResult.verdict;configuration=$profile.Id;filesSupplied=@($files).Count}
    $result=[ordered]@{ok=$true;taskId=$TaskId;executionClass='reviewer';role='reviewer';profile=$profile.Id;profileDisplayName=$profile.DisplayName;provider=$reviewerTarget.Provider;model=$reviewerTarget.Model;modelDisplayName=$reviewerTarget.ModelDisplayName;reasoning=$reviewerTarget.Reasoning;callCount=[int](Get-AihTask $Workspace $TaskId).codexCalls;budget=[ordered]@{maxCallsPerTask=[int]$budget.maxCallsPerTask;maxFiles=[int]$budget.maxFiles;maxDiffLines=[int]$budget.maxDiffLines;maxContextTokens=[int]$budget.maxContextTokens;maxOutputTokens=[int]$budget.maxOutputTokens};readOnly=$true;freshContext=$true;completionAuthority=$false;result=$reviewResult;telemetry=$telemetry}
    $result|ConvertTo-Json -Depth 20
}else{$packet|ConvertTo-Json -Depth 20}
