[CmdletBinding()]
param(
 [ValidateSet('init','create-objective','create-task','set-review-requested','begin-attempt','failure','show','complete','learning')][string]$Action='show',
 [string]$Workspace=(Get-Location).Path,[string]$TaskId,[string]$Description,[string[]]$AcceptanceCriteria=@(),[string[]]$DependsOn=@(),
 [ValidateSet('low','normal','high','critical')][string]$Risk='normal',[string]$ExecutionClass='deepseek_normal',[switch]$ReviewRequested,[string]$FailureSignature,[string]$Evidence,
 [string]$Classification,[switch]$CodexReviewPassed,[switch]$CodexFindingsResolved,
 [string]$PayloadFile
)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $PSScriptRoot 'TaskController.ps1')
# User-derived free text (descriptions) must not travel on the command line:
# Windows PowerShell decodes argv through the ANSI codepage and its
# ConvertTo-Json does not escape every control character, which mangles text
# and can emit JSON the controller bridge cannot parse. The bridge therefore
# writes a UTF-8 payload file and names it here.
if ($PayloadFile) {
    if (-not (Test-Path -LiteralPath $PayloadFile)) { throw "Payload file not found: $PayloadFile" }
    $__aihPayload = Get-Content -Raw -Encoding UTF8 -LiteralPath $PayloadFile | ConvertFrom-Json
    if ($null -ne $__aihPayload.PSObject.Properties['Workspace']) { $Workspace = [string]$__aihPayload.Workspace }
    if ($null -ne $__aihPayload.PSObject.Properties['Description']) { $Description = [string]$__aihPayload.Description }
    if ($null -ne $__aihPayload.PSObject.Properties['ReviewRequested']) { $ReviewRequested = [bool]$__aihPayload.ReviewRequested }
}
$(switch($Action){
 'init'{Initialize-AihTaskLedger $Workspace}
 'create-objective'{New-AihObjective $Workspace $Description $AcceptanceCriteria}
 'create-task'{New-AihTask $Workspace $Description $AcceptanceCriteria $DependsOn $Risk $null -ReviewRequested:$ReviewRequested -ExecutionClassOverride $(if([string]::IsNullOrWhiteSpace($ExecutionClass)){$null}else{$ExecutionClass})}
 'begin-attempt'{Start-AihTaskAttempt $Workspace $TaskId $ExecutionClass}
 'set-review-requested'{Set-AihTaskReviewRequested $Workspace $TaskId}
 'failure'{Add-AihTaskFailure $Workspace $TaskId $FailureSignature $Evidence}
 'complete'{Test-AihTaskCompletion $Workspace $TaskId -CodexReviewPassed:$CodexReviewPassed -CodexFindingsResolved:$CodexFindingsResolved}
 'learning'{Add-AihLearning $Workspace $TaskId $Classification $Description}
 default{if([string]::IsNullOrWhiteSpace($TaskId)){Read-AihTaskLedger $Workspace}else{Get-AihTask $Workspace $TaskId}}
})|ConvertTo-Json -Depth 20
