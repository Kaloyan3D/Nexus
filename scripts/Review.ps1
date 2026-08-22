[CmdletBinding()]
param([string]$Workspace=(Get-Location).Path,[string]$InstallRoot='C:\AI-Harness',[Parameter(Mandatory=$true)][string]$TaskId,[Parameter(Mandatory=$true)][string]$Question,[string[]]$Invariants=@(),[string]$DiffPath,[string]$FilesPath,[string]$Assessment,[switch]$Execute,[switch]$UserApprovedFullRepo)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Routing.ps1')
. (Join-Path $PSScriptRoot 'CodexReview.ps1')
$layout=Get-AihLayout $InstallRoot;$policy=Get-AihRoutingPolicy $layout.RoutingPolicy
$diff=if(-not[string]::IsNullOrWhiteSpace($DiffPath)){Get-Content -Raw -LiteralPath $DiffPath}else{$previousErrorAction=$ErrorActionPreference;try{$ErrorActionPreference='Continue';(& git -C $Workspace diff --no-ext-diff HEAD -- 2>$null|Out-String)}finally{$ErrorActionPreference=$previousErrorAction}}
$files=if(-not[string]::IsNullOrWhiteSpace($FilesPath)){@(Get-Content -Raw -LiteralPath $FilesPath|ConvertFrom-Json)}else{@()}
$packet=New-AihReviewPacket $Workspace $TaskId $Question $Invariants $diff $files @() $Assessment $policy -UserApprovedFullRepo:$UserApprovedFullRepo
$(if($Execute){Invoke-AihCodexReview $Workspace $TaskId $packet $InstallRoot}else{$packet})|ConvertTo-Json -Depth 20
