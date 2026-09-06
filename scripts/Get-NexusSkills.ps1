[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$Workspace,
    [string]$Name,
    [string]$DshHome,
    [string]$AgentsHome,
    [switch]$Json,
    [switch]$Raw
)

# Read-only Nexus skill registry inspection view. Wraps the native DSH
# capability (registry + filesystem provider) through scripts\skills\catalog.mjs
# with the same root resolution the Nexus runtime uses:
#   project roots: <workspace>\.dsh\skills, <workspace>\.agents\skills
#   custom roots:  (none by default; native customSkillDirs)
#   user-dsh:      $DSH_HOME\skills   (Nexus: data\skills)
#   user-agents:   ~/.agents\skills
# Native precedence stays authoritative; this view only reports it.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-AihInstallRoot $null }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$layout = Get-AihLayout $InstallRoot
if ([string]::IsNullOrWhiteSpace($Workspace)) { $Workspace = (Get-Location).Path }
$Workspace = [System.IO.Path]::GetFullPath($Workspace)
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    Write-Error ("Workspace does not exist: " + $Workspace)
    exit 1
}
if ([string]::IsNullOrWhiteSpace($DshHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $DshHome = $env:DSH_HOME } else { $DshHome = $layout.Data }
}

$catalogScript = Join-Path $layout.Scripts 'skills/catalog.mjs'
$arguments = @($catalogScript, '--cwd', $Workspace, '--dsh-home', $DshHome)
if (-not [string]::IsNullOrWhiteSpace($AgentsHome)) { $arguments += @('--agents-home', $AgentsHome) }
if (-not [string]::IsNullOrWhiteSpace($Name)) { $arguments += @('--name', $Name) }

$output = & $layout.Node @arguments 2>&1
$exitCode = $LASTEXITCODE
$rawText = (@($output) | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
if ($exitCode -ne 0) {
    Write-Error ("skill catalog query failed (exit " + $exitCode + "): " + $rawText)
    exit $exitCode
}

if (-not [string]::IsNullOrWhiteSpace($Name)) {
    if ($Raw) {
        $skill = $rawText | ConvertFrom-Json
        Write-Output $skill.content
        exit 0
    }
    Write-Output $rawText
    exit 0
}

$catalog = $rawText | ConvertFrom-Json

if ($Json) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $rawText
    exit 0
}

Write-Host ("Available Skills (workspace: " + $catalog.cwd + ")")
Write-Host ("--------------------------------------------------")
if ($catalog.skills.Count -eq 0) {
    Write-Host '(no skills discovered)'
    exit 0
}
foreach ($skill in $catalog.skills) {
    $modelMark = if ($skill.modelInvocable) { 'yes' } else { 'no' }
    Write-Host ''
    Write-Host ('name:             ' + $skill.name)
    Write-Host ('source:           ' + $skill.source)
    Write-Host ('scope:            ' + $skill.scope)
    Write-Host ('model-invocable:  ' + $modelMark)
    Write-Host ('path:             ' + $(if ($skill.resourceBase -and $skill.resourceBase.kind -eq 'directory') { $skill.resourceBase.path } else { '(provider-managed)' }))
    Write-Host ('description:      ' + $skill.description)
}
Write-Host ''
Write-Host ('total: ' + $catalog.skills.Count)
exit 0
