[CmdletBinding()]
param(
 [ValidateSet('init','create-objective','create-task','test-task','set-review-requested','begin-attempt','attempt-event','evidence','failure','show','complete','learning')][string]$Action='show',
 [string]$Workspace=(Get-Location).Path,[string]$TaskId,[string]$Description,[string[]]$AcceptanceCriteria=@(),[string[]]$DependsOn=@(),
 [ValidateSet('low','normal','high','critical')][string]$Risk='normal',[ValidateSet('deterministic','engineer_normal','engineer_deep','reviewer','solver','deepseek_normal','deepseek_deep','codex_review','codex_solve')][string]$ExecutionClass='engineer_normal',[switch]$ReviewRequested,[string]$FailureSignature,[string]$Evidence,
 [string]$Classification,[switch]$CodexReviewPassed,[switch]$CodexFindingsResolved,
 [ValidateSet('verifying','passed','interrupted')][string]$Status,[string]$Reason,[string]$SessionId,[string]$StartedByTurn,[switch]$RequireNoOpenAttempt,[object]$EvidenceDoc,
 # TASK-0005: immutable lifecycle-instance guard. Supplied by the controller
 # bridge for every task-scoped operation on tasks created after the upgrade;
 # a mismatch fails closed instead of mutating another generation that shares
 # the TASK-NNNN display id.
 [string]$TaskInstanceId,
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
    if ($null -ne $__aihPayload.PSObject.Properties['SessionId']) { $SessionId = [string]$__aihPayload.SessionId }
    if ($null -ne $__aihPayload.PSObject.Properties['StartedByTurn']) { $StartedByTurn = [string]$__aihPayload.StartedByTurn }
    if ($null -ne $__aihPayload.PSObject.Properties['RequireNoOpenAttempt']) { $RequireNoOpenAttempt = [bool]$__aihPayload.RequireNoOpenAttempt }
    if ($null -ne $__aihPayload.PSObject.Properties['Status']) { $Status = [string]$__aihPayload.Status }
    if ($null -ne $__aihPayload.PSObject.Properties['Reason']) { $Reason = [string]$__aihPayload.Reason }
    if ($null -ne $__aihPayload.PSObject.Properties['FailureSignature']) { $FailureSignature = [string]$__aihPayload.FailureSignature }
    if ($null -ne $__aihPayload.PSObject.Properties['Evidence']) { $Evidence = [string]$__aihPayload.Evidence }
    if ($null -ne $__aihPayload.PSObject.Properties['EvidenceDoc']) { $EvidenceDoc = $__aihPayload.EvidenceDoc }
    if ($null -ne $__aihPayload.PSObject.Properties['TaskInstanceId']) { $TaskInstanceId = [string]$__aihPayload.TaskInstanceId }
}
$(switch($Action){
 'init'{Initialize-AihTaskLedger $Workspace}
 'create-objective'{New-AihObjective $Workspace $Description $AcceptanceCriteria}
 'create-task'{New-AihTask $Workspace $Description $AcceptanceCriteria $DependsOn $Risk $null -ReviewRequested:$ReviewRequested -ExecutionClassOverride $(if([string]::IsNullOrWhiteSpace($ExecutionClass)){$null}else{$ExecutionClass})}
 # TASK-0005: deterministic identity lookup. NEVER reports a missing task via
 # an exception: {exists=false} is emitted ONLY after the authoritative ledger
 # was successfully read. Malformed ledger / IO / parse failures still throw,
 # so callers can distinguish 'confirmed absent' from 'unable to validate'.
 'test-task'{Test-AihTaskIdentity $Workspace $TaskId -TaskInstanceId $TaskInstanceId}
 'begin-attempt'{Start-AihTaskAttempt $Workspace $TaskId $ExecutionClass -RequireNoOpenAttempt:$RequireNoOpenAttempt -SessionId $SessionId -StartedByTurn $StartedByTurn -TaskInstanceId $TaskInstanceId}
 'attempt-event'{Add-AihAttemptEvent $Workspace $TaskId $Status $FailureSignature $Evidence $Reason -TaskInstanceId $TaskInstanceId}
 'evidence'{Set-AihTaskEvidence $Workspace $TaskId $EvidenceDoc -TaskInstanceId $TaskInstanceId}
 'set-review-requested'{Set-AihTaskReviewRequested $Workspace $TaskId -TaskInstanceId $TaskInstanceId}
 'failure'{Add-AihTaskFailure $Workspace $TaskId $FailureSignature $Evidence -TaskInstanceId $TaskInstanceId}
 'complete'{Test-AihTaskCompletion $Workspace $TaskId -CodexReviewPassed:$CodexReviewPassed -CodexFindingsResolved:$CodexFindingsResolved -TaskInstanceId $TaskInstanceId}
 'learning'{Add-AihLearning $Workspace $TaskId $Classification $Description -TaskInstanceId $TaskInstanceId}
 default{if([string]::IsNullOrWhiteSpace($TaskId)){Read-AihTaskLedger $Workspace}else{Get-AihTask $Workspace $TaskId -TaskInstanceId $TaskInstanceId}}
})|ConvertTo-Json -Depth 20
