[CmdletBinding()]
param([ValidateSet('map','search_code','find_symbol','find_references','file_outline','bundle')][string]$Operation='map',[string]$Workspace=(Get-Location).Path,[string]$Query,[string]$File,[string]$TaskId,[int]$MaxContextTokens=12000,[int]$MaxFiles=12,[string]$PayloadFile)
. (Join-Path $PSScriptRoot 'ContextEngine.ps1')
if ($PayloadFile) {
    if (-not (Test-Path -LiteralPath $PayloadFile)) { throw "Payload file not found: $PayloadFile" }
    $__aihPayload = Get-Content -Raw -Encoding UTF8 -LiteralPath $PayloadFile | ConvertFrom-Json
    if ($null -ne $__aihPayload.PSObject.Properties['Workspace']) { $Workspace = [string]$__aihPayload.Workspace }
    if ($null -ne $__aihPayload.PSObject.Properties['Query']) { $Query = [string]$__aihPayload.Query }
}
$map=$null
$(switch($Operation){
 'map'{New-AihRepositoryMap $Workspace}
 'search_code'{Search-AihCode $Workspace $Query}
 'find_symbol'{$map=New-AihRepositoryMap $Workspace;Find-AihSymbol $map $Query}
 'find_references'{Find-AihReferences $Workspace $Query}
 'file_outline'{$map=New-AihRepositoryMap $Workspace;Get-AihFileOutline $map $File}
 'bundle'{New-AihContextBundle $Workspace $TaskId $Query @() $MaxContextTokens $MaxFiles}
})|ConvertTo-Json -Depth 20
