[CmdletBinding()]param([string]$Workspace=(Get-Location).Path,[switch]$Json)
. (Join-Path $PSScriptRoot 'ArchitectureRules.ps1')
$result=Invoke-AihArchitectureRules $Workspace
if($Json){$result|ConvertTo-Json -Depth 10}else{$result}
if($result.status-eq'FAIL'){exit 1}
