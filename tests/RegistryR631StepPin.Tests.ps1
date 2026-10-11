[CmdletBinding()]param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# R6.3.1: pinned-generation step-target enforcement for Select-AihStepRole.
# Direct unit tests of Assert-AihStepRoleTargetPinned (no DSH, no model).
. (Join-Path $InstallRoot 'scripts/Engineering/StepRouting.ps1')
$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-FixtureDir([string]$Name) { $p = Join-Path ([IO.Path]::GetTempPath()) ("aih-steppin-" + $Name + "-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $p -Force | Out-Null; return $p }
function Write-PinBindings([string]$Dir, [string]$Instance, [object]$Pin) { $doc = [ordered]@{ schemaVersion = 1; bindings = [ordered]@{} }; $doc.bindings[$Instance] = [ordered]@{ sessionId = 's1'; taskId = 'TASK-1'; taskInstanceId = $Instance; preset = 'aih-engineering'; engine = 'dual'; registryPin = $Pin }; $doc | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $Dir 'session-bindings.json') }
function New-MapPin {
    $t = [pscustomobject]@{ provider = 'flash-high-direct'; model = 'deepseek-v4-flash'; reasoning = 'high' }
    $pe = [pscustomobject]@{ available = $true; target = $t }
    $map = [pscustomobject]@{ primaryEngineer = $pe }
    return [pscustomobject]@{ modeId = 'engineering-v1'; resolutionId = 'r1'; configRevision = 0; taskInstanceId = 'task_aaa'; roleTargets = $map }
}
function New-MatchTarget { return [pscustomobject]@{ role = 'primaryEngineer'; provider = 'flash-high-direct'; model = 'deepseek-v4-flash'; reasoning = 'high' } }
$dir = New-FixtureDir 'match'
Write-PinBindings $dir 'task_aaa' (New-MapPin)
Assert-AihStepRoleTargetPinned -RoutingDataRoot $dir -TaskInstanceId 'task_aaa' -Role 'primaryEngineer' -Target (New-MatchTarget)
Assert-Aih ($true) 'matching step target passes'
$threw = $false; try { Assert-AihStepRoleTargetPinned -RoutingDataRoot $dir -TaskInstanceId 'task_aaa' -Role 'primaryEngineer' -Target ([pscustomobject]@{ role = 'primaryEngineer'; provider = 'flash-max-direct'; model = 'deepseek-v4-flash'; reasoning = 'high' }) } catch { $threw = $true; Assert-Aih ($_.Exception.Message -match 'registry-step-target-mismatch') 'mismatch code exact' }
Assert-Aih ($threw) 'drifted provider throws'
$threw = $false; try { Assert-AihStepRoleTargetPinned -RoutingDataRoot $dir -TaskInstanceId 'task_aaa' -Role 'reviewer' -Target ([pscustomobject]@{ role = 'reviewer'; provider = 'sol-local'; model = 'gpt-5.6-sol'; reasoning = 'medium' }) } catch { $threw = $true; Assert-Aih ($_.Exception.Message -match 'registry-role-unpinned') 'unpinned code exact' }
Assert-Aih ($threw) 'missing role throws'
$empty = New-FixtureDir 'none'; Assert-AihStepRoleTargetPinned -RoutingDataRoot $empty -TaskInstanceId 'task_aaa' -Role 'primaryEngineer' -Target (New-MatchTarget); Assert-Aih ($true) 'no bindings file keeps legacy'
Assert-AihStepRoleTargetPinned -RoutingDataRoot $dir -TaskInstanceId 'task_other' -Role 'primaryEngineer' -Target (New-MatchTarget); Assert-Aih ($true) 'other generations unaffected'
$single = [pscustomobject]@{ modeId = 'engineering-v1'; role = 'primaryEngineer'; taskInstanceId = 'task_bbb'; roleTarget = [pscustomobject]@{ provider = 'flash-high-direct'; model = 'deepseek-v4-flash'; reasoning = 'high' } }
$dir2 = New-FixtureDir 'single'; Write-PinBindings $dir2 'task_bbb' $single
Assert-AihStepRoleTargetPinned -RoutingDataRoot $dir2 -TaskInstanceId 'task_bbb' -Role 'primaryEngineer' -Target (New-MatchTarget); Assert-Aih ($true) 'singular R6.3 pin honored'
Write-Host ("SUITE RESULT: PASS " + $passed + " | FAIL 0")