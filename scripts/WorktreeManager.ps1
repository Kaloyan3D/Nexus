Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'TaskController.ps1')

function New-AihTaskWorktree {
    param([string]$Workspace,[string]$TaskId,[string]$WorktreeRoot)
    $task=Get-AihTask $Workspace $TaskId
    if([string]::IsNullOrWhiteSpace([string]$task.baseCommit)){throw 'Task has no recorded baseCommit; refusing implicit branch selection.'}
    if([string]::IsNullOrWhiteSpace($WorktreeRoot)){$WorktreeRoot=Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Workspace))) '.aih-worktrees'}
    New-Item -ItemType Directory -Force -Path $WorktreeRoot|Out-Null
    $path=Join-Path ([IO.Path]::GetFullPath($WorktreeRoot)) $TaskId
    if(Test-Path -LiteralPath $path){throw "Worktree path already exists: $path"}
    $branch='codex/'+$TaskId.ToLowerInvariant()
    & git -C ([IO.Path]::GetFullPath($Workspace)) worktree add -b $branch $path ([string]$task.baseCommit) | Out-Null
    if($LASTEXITCODE -ne 0){throw 'git worktree add failed.'}
    Update-AihTaskRecord $Workspace $TaskId {param($item);$item.worktree=[ordered]@{baseCommit=[string]$item.baseCommit;branch=$branch;worktreePath=$path}}|Out-Null
    [pscustomobject]@{taskId=$TaskId;baseCommit=[string]$task.baseCommit;branch=$branch;worktreePath=$path}
}

function Test-AihTaskWriteConflict {
    param([object[]]$Tasks)
    $conflicts=[Collections.Generic.List[object]]::new()
    for($i=0;$i -lt $Tasks.Count;$i++){for($j=$i+1;$j -lt $Tasks.Count;$j++){
        $overlap=@($Tasks[$i].writePaths|Where-Object{$Tasks[$j].writePaths -contains $_})
        if($overlap.Count){$conflicts.Add([pscustomobject]@{taskA=$Tasks[$i].taskId;taskB=$Tasks[$j].taskId;paths=$overlap})}
    }}
    [pscustomobject]@{hasConflicts=$conflicts.Count -gt 0;conflicts=@($conflicts)}
}
