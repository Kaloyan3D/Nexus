[CmdletBinding()]
param(
 [ValidateSet('init','create-objective','create-task','begin-attempt','failure','show','complete','learning')][string]$Action='show',
 [string]$Workspace=(Get-Location).Path,[string]$TaskId,[string]$Description,[string[]]$AcceptanceCriteria=@(),[string[]]$DependsOn=@(),
 [ValidateSet('low','normal','high','critical')][string]$Risk='normal',[string]$ExecutionClass='deepseek_normal',[string]$FailureSignature,[string]$Evidence,
 [string]$Classification,[switch]$CodexReviewPassed,[switch]$CodexFindingsResolved
)
. (Join-Path $PSScriptRoot 'TaskController.ps1')
$(switch($Action){
 'init'{Initialize-AihTaskLedger $Workspace}
 'create-objective'{New-AihObjective $Workspace $Description $AcceptanceCriteria}
 'create-task'{New-AihTask $Workspace $Description $AcceptanceCriteria $DependsOn $Risk}
 'begin-attempt'{Start-AihTaskAttempt $Workspace $TaskId $ExecutionClass}
 'failure'{Add-AihTaskFailure $Workspace $TaskId $FailureSignature $Evidence}
 'complete'{Test-AihTaskCompletion $Workspace $TaskId -CodexReviewPassed:$CodexReviewPassed -CodexFindingsResolved:$CodexFindingsResolved}
 'learning'{Add-AihLearning $Workspace $TaskId $Classification $Description}
 default{if([string]::IsNullOrWhiteSpace($TaskId)){Read-AihTaskLedger $Workspace}else{Get-AihTask $Workspace $TaskId}}
})|ConvertTo-Json -Depth 20
