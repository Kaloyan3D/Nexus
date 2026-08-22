Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Project.ps1')

function Invoke-AihArchitectureRules {
    param([string]$Workspace)
    $workspacePath=[IO.Path]::GetFullPath($Workspace);$findings=[Collections.Generic.List[object]]::new()
    foreach($file in @(Get-AihWorkspaceFiles $workspacePath)){
        $path=Join-Path $workspacePath $file
        if($file -notmatch '(?i)(lock|package-lock)\.json$' -and (Get-Item -LiteralPath $path).Length -lt 1048576){
            $matches=Select-String -LiteralPath $path -Pattern '(?i)(sk-[A-Za-z0-9_-]{16,}|DEEPSEEK_API_KEY\s*[:=]\s*["''][^"'']+)' -ErrorAction SilentlyContinue
            foreach($match in $matches){$findings.Add([pscustomobject]@{ruleId='SEC001';severity='blocker';file=$file;line=$match.LineNumber;message='Potential secret material must not be persisted in source or tool records.'})}
        }
    }
    try{
        $released=@(& git -C $workspacePath ls-files '*migration*' 2>$null)
        foreach($file in $released){if((& git -C $workspacePath diff --name-only HEAD -- $file 2>$null)){ $findings.Add([pscustomobject]@{ruleId='MIG001';severity='high';file=$file;line=$null;message='A tracked migration changed; released migrations should be immutable or explicitly approved.'})}}
    }catch{}
    [pscustomobject]@{status=if($findings.Count){'FAIL'}else{'PASS'};rules=@('SEC001','MIG001');findings=@($findings)}
}
