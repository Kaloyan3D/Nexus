[CmdletBinding()]
param(
    [ValidateSet('resolve', 'validate')][string]$Action = 'resolve',
    [string]$Path,
    [string]$StoreRoot,
    [string]$PayloadFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

. (Join-Path $PSScriptRoot 'Workspace.ps1')

$identity = $null
if (-not [string]::IsNullOrWhiteSpace($PayloadFile)) {
    if (-not (Test-Path -LiteralPath $PayloadFile)) { throw "Payload file not found: $PayloadFile" }
    $payload = Get-Content -Raw -Encoding UTF8 -LiteralPath $PayloadFile | ConvertFrom-Json
    if ($null -ne $payload.PSObject.Properties['path']) { $Path = [string]$payload.path }
    if ($null -ne $payload.PSObject.Properties['storeRoot']) { $StoreRoot = [string]$payload.storeRoot }
    if ($null -ne $payload.PSObject.Properties['identity']) { $identity = $payload.identity }
}

$result = switch ($Action) {
    'resolve' { Resolve-AihNexusWorkspaceIdentity -StoreRoot $StoreRoot -Path $Path }
    'validate' {
        if ($null -eq $identity) { throw 'Identity payload is required for validation.' }
        [pscustomobject][ordered]@{
            schemaVersion = 1
            valid = [bool](Test-AihNexusWorkspaceIdentity -StoreRoot $StoreRoot -Identity $identity -ExecutionRoot $Path)
        }
    }
}

ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe $result) -Depth 20
