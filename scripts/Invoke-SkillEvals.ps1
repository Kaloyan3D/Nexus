[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$SourceRoot,
    [string]$TargetRoot,
    [string]$CasesFile,
    [switch]$Json
)

# Deterministic skill-selection eval harness (Nexus Skills Foundation v1).
#
# Validates that for each eval case the expected skills EXIST and their text
# (catalog description plus loaded body) carries the concepts the selection
# decision needs. This is the foundational no-LLM harness: it proves the
# selection surface is present and routable, without a model judge.
#
# Model-based selection is deliberately NOT part of this harness. A future
# model-selection run must record model/provider/version alongside results
# (see docs/skills/EVALS.md); this script's JSON output reserves the
# "modelSelection" field for that, reported as "not-run" here.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-AihInstallRoot $null }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$layout = Get-AihLayout $InstallRoot
if ([string]::IsNullOrWhiteSpace($CasesFile)) { $CasesFile = Join-Path $InstallRoot 'tests/fixtures/skill-evals/cases.json' }
if (-not (Test-Path -LiteralPath $CasesFile -PathType Leaf)) {
    Write-Error ("Eval cases file not found: " + $CasesFile)
    exit 1
}

$skillRoots = @()
if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
    $skillRoots += [pscustomobject]@{ Kind = 'source'; Path = [System.IO.Path]::GetFullPath($SourceRoot) }
}
elseif (-not [string]::IsNullOrWhiteSpace($TargetRoot)) {
    $skillRoots += [pscustomobject]@{ Kind = 'installed'; Path = [System.IO.Path]::GetFullPath($TargetRoot) }
}
else {
    $skillRoots += [pscustomobject]@{ Kind = 'source'; Path = (Join-Path $InstallRoot 'skills/core') }
}

function Get-AihEvalSkillText {
    param([string]$SkillName)

    foreach ($root in $skillRoots) {
        $skillMd = Join-Path $root.Path ($SkillName + '/SKILL.md')
        if (Test-Path -LiteralPath $skillMd -PathType Leaf) {
            return [pscustomobject]@{ Found = $true; Path = $skillMd; Text = [System.IO.File]::ReadAllText($skillMd) }
        }
    }
    return [pscustomobject]@{ Found = $false; Path = $null; Text = $null }
}

$casesDocument = Get-Content -Raw -Encoding UTF8 -LiteralPath $CasesFile | ConvertFrom-Json
$caseResults = @()
$failures = 0
foreach ($case in $casesDocument.cases) {
    $casePassed = $true
    $skillResults = @()
    foreach ($expected in $case.expectedSkills) {
        $resolved = Get-AihEvalSkillText -SkillName $expected.name
        if (-not $resolved.Found) {
            $casePassed = $false
            $skillResults += [pscustomobject]@{ skill = $expected.name; found = $false; catalogMatch = @(); bodyMatch = @() }
            continue
        }
        $catalogPatterns = @($expected.catalogPatterns)
        $bodyPatterns = @($expected.bodyPatterns)
        $catalogMisses = @()
        $bodyMisses = @()
        foreach ($pattern in $catalogPatterns) {
            if ($resolved.Text -notmatch $pattern) { $catalogMisses += $pattern }
        }
        foreach ($pattern in $bodyPatterns) {
            if ($resolved.Text -notmatch $pattern) { $bodyMisses += $pattern }
        }
        $skillPassed = ($catalogMisses.Count -eq 0 -and $bodyMisses.Count -eq 0)
        if (-not $skillPassed) { $casePassed = $false }
        $skillResults += [pscustomobject]@{
            skill = $expected.name
            found = $true
            path = $resolved.Path
            catalogPatterns = $catalogPatterns
            catalogMisses = $catalogMisses
            bodyPatterns = $bodyPatterns
            bodyMisses = $bodyMisses
            passed = $skillPassed
        }
    }
    if (-not $casePassed) { $failures++ }
    $caseResults += [pscustomobject]@{
        id = $case.id
        kind = $case.kind
        task = $case.task
        passed = $casePassed
        expectedSkills = $skillResults
    }
}

$summary = [ordered]@{
    ok = ($failures -eq 0)
    harness = 'deterministic-catalog'
    casesFile = $CasesFile
    skillRoots = $skillRoots
    caseCount = @($casesDocument.cases).Count
    failures = $failures
    cases = $caseResults
    modelSelection = 'not-run (deterministic harness; a model-selection run must record model/provider/version - see docs/skills/EVALS.md)'
}

if ($Json) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output (ConvertTo-Json -InputObject $summary -Depth 8)
}
else {
    foreach ($case in $caseResults) {
        $mark = if ($case.passed) { 'PASS' } else { 'FAIL' }
        Write-Host ($mark + ': ' + $case.id + ' -> expected skills: ' + (($case.expectedSkills | ForEach-Object { $_.skill }) -join ', '))
        foreach ($skill in $case.expectedSkills) {
            if (-not $skill.found) { Write-Host ('    MISSING SKILL: ' + $skill.skill) }
            elseif (-not $skill.passed) {
                foreach ($miss in $skill.catalogMisses) { Write-Host ('    catalog concept not found in ' + $skill.skill + ': ' + $miss) }
                foreach ($miss in $skill.bodyMisses) { Write-Host ('    body concept not found in ' + $skill.skill + ': ' + $miss) }
            }
        }
    }
    Write-Host ('cases: ' + $summary.caseCount + ' | failures: ' + $failures)
}
exit $(if ($failures -eq 0) { 0 } else { 1 })
