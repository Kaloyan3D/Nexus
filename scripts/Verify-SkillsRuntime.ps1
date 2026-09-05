[CmdletBinding()]
param(
    [string]$InstallRoot,
    [switch]$Json
)

# Deterministic verification that the ACTUAL Nexus runtime composition mounts
# the native DeepSeek Harness skill capability. No skill engine is built here:
# every check inspects the pinned DSH packages and the resolved composition
# artifacts (dsh-base host bundle rows plus the deployed engineering presets),
# then boots the native registry+provider end-to-end against a disposable
# fixture. Answers exactly:
#   skills registry available: yes/no
#   filesystem provider available: yes/no
#   model skill tool available: yes/no
# plus a native boot verification.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-AihInstallRoot $null }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$layout = Get-AihLayout $InstallRoot

$results = [ordered]@{
    registry           = @{ available = $false; evidence = @() }
    filesystemProvider = @{ available = $false; evidence = @() }
    modelSkillTool     = @{ available = $false; evidence = @() }
    nativeBoot         = @{ available = $false; evidence = @() }
}

# --- pinned packages present in the runtime dependency tree ------------------
$packageBuckets = @{
    '@deepseek-ai/dsh-skill'            = 'registry'
    '@deepseek-ai/dsh-skill-filesystem' = 'filesystemProvider'
    '@deepseek-ai/dsh-tool-skill'       = 'modelSkillTool'
}
foreach ($package in $packageBuckets.Keys) {
    $packageDir = Join-Path $layout.App ("node_modules" + [IO.Path]::DirectorySeparatorChar + ($package.Replace('/', [IO.Path]::DirectorySeparatorChar)))
    $bucket = $packageBuckets[$package]
    if (Test-Path -LiteralPath $packageDir) {
        $results[$bucket].evidence += ("pinned package installed: " + $package)
    }
    else {
        $results[$bucket].evidence += ("MISSING pinned package: " + $package)
    }
}

# --- resolved composition rows ------------------------------------------------
function Test-CompositionRow {
    param([string]$Text, [string]$RowId, [string]$ExpectedName)

    # Match one composition row block and require the plugin name inside it.
    # Only a literal 'disabled: true' counts as disabled; js expressions on
    # other rows stay out of scope for the skill rows.
    $pattern = '(?ms)^[ \t]*- id: ' + [regex]::Escape($RowId) + '[ \t]*$(.*?)(?=^[ \t]*- id: |\z)'
    $match = [regex]::Match($Text, $pattern)
    if (-not $match.Success) { return @{ present = $false; disabled = $false } }
    $block = $match.Groups[1].Value
    $present = [regex]::IsMatch($block, [regex]::Escape("name: '$ExpectedName'"))
    $disabled = [regex]::IsMatch($block, '(?m)^\s+disabled:\s*true\s*$')
    return @{ present = $present; disabled = $disabled }
}

$baseBundle = Join-Path $layout.App 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'
if (Test-Path -LiteralPath $baseBundle) {
    $baseText = Get-Content -Raw -Encoding UTF8 -LiteralPath $baseBundle
    $hostRows = @(
        @{ id = 'skill'; name = '@deepseek-ai/dsh-skill'; bucket = 'registry' },
        @{ id = 'skill-filesystem'; name = '@deepseek-ai/dsh-skill-filesystem'; bucket = 'filesystemProvider' },
        @{ id = 'tool-skill'; name = '@deepseek-ai/dsh-tool-skill'; bucket = 'modelSkillTool' }
    )
    foreach ($row in $hostRows) {
        $state = Test-CompositionRow -Text $baseText -RowId $row.id -ExpectedName $row.name
        if ($state.present -and -not $state.disabled) {
            $results[$row.bucket].evidence += ("host row mounted: {0} -> {1}" -f $row.id, $row.name)
        }
        elseif ($state.present) {
            $results[$row.bucket].evidence += ("host row present but disabled: {0}" -f $row.id)
        }
        else {
            $results[$row.bucket].evidence += ("MISSING host row: {0} (dsh-base bundle changed?)" -f $row.id)
        }
    }
}
else {
    foreach ($bucket in @('registry', 'filesystemProvider', 'modelSkillTool')) {
        $results[$bucket].evidence += ("MISSING dsh-base bundle composition: " + $baseBundle)
    }
}

$presetRows = @(
    @{ id = 'skill-filesystem'; name = '@deepseek-ai/dsh-skill-filesystem'; bucket = 'filesystemProvider' },
    @{ id = 'tool-skill'; name = '@deepseek-ai/dsh-tool-skill'; bucket = 'modelSkillTool' }
)
foreach ($presetName in @('aih-engineering', 'aih-deepseek')) {
    $presetPath = Join-Path $layout.Data ('.agent-presets/' + $presetName + '/agent.cordis.yml')
    if (-not (Test-Path -LiteralPath $presetPath)) {
        foreach ($row in $presetRows) { $results[$row.bucket].evidence += ("MISSING deployed preset: " + $presetName) }
        continue
    }
    $presetText = Get-Content -Raw -Encoding UTF8 -LiteralPath $presetPath
    foreach ($row in $presetRows) {
        $state = Test-CompositionRow -Text $presetText -RowId $row.id -ExpectedName $row.name
        if ($state.present -and -not $state.disabled) {
            $results[$row.bucket].evidence += ("preset row mounted: {0}/{1} -> {2}" -f $presetName, $row.id, $row.name)
        }
        else {
            $results[$row.bucket].evidence += ("MISSING preset row: {0}/{1}" -f $presetName, $row.id)
        }
    }
}

foreach ($bucket in @('registry', 'filesystemProvider', 'modelSkillTool')) {
    $blocking = @($results[$bucket].evidence | Where-Object { $_ -match '^(MISSING|host row present but disabled)' })
    $results[$bucket].available = ($blocking.Count -eq 0)
}

# --- native end-to-end boot against a disposable fixture ---------------------
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('nexus-skills-verify-' + [guid]::NewGuid().ToString('N'))
try {
    $fixtureSkill = Join-Path $fixtureRoot '.agents/skills/skills-runtime-verify'
    New-Item -ItemType Directory -Force -Path $fixtureSkill | Out-Null
    $fixtureBody = '---' + [Environment]::NewLine +
        'name: skills-runtime-verify' + [Environment]::NewLine +
        'description: Deterministic runtime verification fixture for the Nexus skills capability.' + [Environment]::NewLine +
        '---' + [Environment]::NewLine + 'NEXUS_SKILLS_RUNTIME_VERIFY_OK' + [Environment]::NewLine
    [System.IO.File]::WriteAllText((Join-Path $fixtureSkill 'SKILL.md'), $fixtureBody, [System.Text.UTF8Encoding]::new($false))

    $homeRoot = Join-Path $fixtureRoot 'dsh-home'
    $agentsRoot = Join-Path $fixtureRoot 'agents-home'
    New-Item -ItemType Directory -Force -Path $homeRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $agentsRoot | Out-Null

    $catalogScript = Join-Path $layout.Scripts 'skills/catalog.mjs'
    $nodeOutput = & $layout.Node $catalogScript --cwd $fixtureRoot --name 'skills-runtime-verify' --dsh-home $homeRoot --agents-home $agentsRoot --json 2>&1
    $nodeExit = $LASTEXITCODE
    $outputText = (@($nodeOutput) | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
    if ($nodeExit -eq 0 -and $outputText.Contains('NEXUS_SKILLS_RUNTIME_VERIFY_OK')) {
        $results.nativeBoot.available = $true
        $results.nativeBoot.evidence += 'native registry+filesystem boot discovered and loaded the fixture skill body'
    }
    else {
        $results.nativeBoot.evidence += ("native boot failed (exit {0}): {1}" -f $nodeExit, $outputText)
    }
}
finally {
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}

$allReady = $results.registry.available -and $results.filesystemProvider.available -and $results.modelSkillTool.available -and $results.nativeBoot.available

if ($Json) {
    $payload = [ordered]@{
        skillsRegistryAvailable     = [bool]$results.registry.available
        filesystemProviderAvailable = [bool]$results.filesystemProvider.available
        modelSkillToolAvailable     = [bool]$results.modelSkillTool.available
        nativeBootVerified          = [bool]$results.nativeBoot.available
        ready                       = [bool]$allReady
        evidence                    = $results
    }
    $payloadJson = ConvertTo-Json -InputObject $payload -Depth 6
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $payloadJson
}
else {
    Write-Host ('skills registry available: ' + $(if ($results.registry.available) { 'yes' } else { 'no' }))
    Write-Host ('filesystem provider available: ' + $(if ($results.filesystemProvider.available) { 'yes' } else { 'no' }))
    Write-Host ('model skill tool available: ' + $(if ($results.modelSkillTool.available) { 'yes' } else { 'no' }))
    Write-Host ('native boot verified: ' + $(if ($results.nativeBoot.available) { 'yes' } else { 'no' }))
    Write-Host 'evidence:'
    foreach ($bucket in @('registry', 'filesystemProvider', 'modelSkillTool', 'nativeBoot')) {
        foreach ($line in $results[$bucket].evidence) { Write-Host ('  [' + $bucket + '] ' + $line) }
    }
}
exit $(if ($allReady) { 0 } else { 1 })
