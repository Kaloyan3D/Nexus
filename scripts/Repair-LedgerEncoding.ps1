# Repair-LedgerEncoding.ps1 - restore task descriptions corrupted by ANSI
# mis-decoding at the ledger write boundary.
#
# The controller state JSON files are UTF-8 (no BOM). Windows PowerShell 5.1
# Get-Content without -Encoding UTF8 decodes them through the ANSI codepage,
# so any read-modify-write cycle corrupts non-ASCII characters (e.g. an
# em-dash becomes a mojibake sequence). The read sites are now UTF-8-explicit;
# this driver repairs EXISTING corruption by restoring each corrupted
# description from the authoritative clean source: the task's last
# NON-escalation routing decision record (decisions.jsonl), whose description
# is the original directive text. Idempotent: a clean ledger is a no-op.
#
# Usage: powershell -File Repair-LedgerEncoding.ps1 [-TaskId TASK-0002]

[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\AI-Harness',
    [string]$Workspace,
    [string]$TaskId
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'TaskController.ps1')

$layout = Get-AihLayout $InstallRoot
if ([string]::IsNullOrWhiteSpace($Workspace)) { $Workspace = $InstallRoot }
$ledger = Read-AihTaskLedger $Workspace

$decisionsPath = Join-Path $layout.RoutingData 'decisions.jsonl'
$decisions = @()
if (Test-Path -LiteralPath $decisionsPath) {
    $decisions = @(Get-Content -Encoding UTF8 -LiteralPath $decisionsPath | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $null -ne $_ })
}

# Mojibake markers (single- and double-corruption), built from code points so
# this script stays pure ASCII (PowerShell 5.1 misreads non-ASCII in
# BOM-less .ps1 files): U+00E2 (a-circumflex) and U+00C3 (A-tilde) start the
# classic UTF-8-as-CP1252 sequences.
$singleMarker = [string][char]0x00E2 + [string][char]0x20AC
$doubleMarker = [string][char]0x00C3

$restored = @()
foreach ($task in @($ledger.tasks)) {
    if (-not [string]::IsNullOrWhiteSpace($TaskId) -and $task.taskId -ne $TaskId) { continue }
    $description = [string]$task.description
    if ($description.IndexOf($singleMarker) -lt 0 -and $description.IndexOf($doubleMarker) -lt 0) { continue }
    # authoritative clean text: the last NON-escalation routing decision.
    # Property access is guarded so the script stays StrictMode-safe when the
    # record omits the field (primary decisions carry no escalatedFrom).
    $authoritative = $null
    foreach ($decision in $decisions) {
        $hasEscalation = $false
        if ($null -ne $decision.PSObject.Properties['escalatedFrom']) {
            $hasEscalation = -not [string]::IsNullOrWhiteSpace([string]$decision.escalatedFrom)
        }
        if ($decision.taskId -eq $task.taskId -and -not $hasEscalation) { $authoritative = $decision }
    }
    if ($null -eq $authoritative -or [string]::IsNullOrWhiteSpace([string]$authoritative.description)) { continue }
    $clean = [string]$authoritative.description
    if ($clean -eq $description) { continue }
    $null = Update-AihTaskRecord $Workspace $task.taskId { param($item) $item.description = $clean }
    $restored += $task.taskId
    Write-Host "restored description for $($task.taskId) from the authoritative routing decision"
}
if ($restored.Count -eq 0) { Write-Host 'no corrupted task descriptions found' }
