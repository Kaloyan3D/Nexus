[CmdletBinding()]
param([ValidateSet('map','search_code','find_symbol','find_references','file_outline','bundle')][string]$Operation='map',[string]$Workspace=(Get-Location).Path,[string]$Query,[string]$File,[string]$TaskId,[int]$MaxContextTokens=12000,[int]$MaxFiles=12)
. (Join-Path $PSScriptRoot 'ContextEngine.ps1')
$map=$null
$(switch($Operation){
 'map'{New-AihRepositoryMap $Workspace}
 'search_code'{Search-AihCode $Workspace $Query}
 'find_symbol'{$map=New-AihRepositoryMap $Workspace;Find-AihSymbol $map $Query}
 'find_references'{Find-AihReferences $Workspace $Query}
 'file_outline'{$map=New-AihRepositoryMap $Workspace;Get-AihFileOutline $map $File}
 'bundle'{New-AihContextBundle $Workspace $TaskId $Query @() $MaxContextTokens $MaxFiles}
})|ConvertTo-Json -Depth 20
