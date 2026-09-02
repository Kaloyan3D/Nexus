[CmdletBinding()]
param([string]$InstallRoot = 'C:\AI-Harness')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $InstallRoot 'scripts\Common.ps1')

$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL: $Name" }
    $script:passed++
    Write-Host "PASS: $Name"
}
function New-Fixture([string]$Name) {
    $path = Join-Path ([IO.Path]::GetTempPath()) ("aih-$Name-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $path | Out-Null
    return $path
}
function Invoke-AihInstaller {
    # Windows PowerShell 5.1 turns native stderr records (2>&1) into
    # terminating errors under ErrorActionPreference=Stop; relax it around the
    # child invocation exactly like scripts\Test-Harness.ps1 does.
    param([string]$Source, [string]$Target, [switch]$Force)
    $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $InstallRoot 'scripts\Install-NexusSkills.ps1'),
        '-SourceRoot', $Source, '-TargetRoot', $Target)
    if ($Force) { $arguments += '-Force' }
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = @(& powershell.exe @arguments 2>&1 | ForEach-Object { [string]$_ }) }
    finally { $ErrorActionPreference = $savedPreference }
    return [pscustomobject]@{ ExitCode = [int]$LASTEXITCODE; Output = $output; Text = ($output -join [Environment]::NewLine) }
}
function Invoke-AihChildSuite {
    param([string]$ScriptPath)
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = @(& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath 2>&1 | ForEach-Object { [string]$_ }) }
    finally { $ErrorActionPreference = $savedPreference }
    return [pscustomobject]@{ ExitCode = [int]$LASTEXITCODE; Output = $output; Text = ($output -join [Environment]::NewLine) }
}
function New-AihFixtureSkill {
    param([string]$Directory, [string]$Name, [string]$Description, [string]$Body)
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $nl = [char]10
    $text = '---' + $nl + 'name: ' + $Name + $nl + 'description: ' + $Description + $nl + '---' + $nl + $Body + $nl
    [System.IO.File]::WriteAllText((Join-Path $Directory 'SKILL.md'), $text, [System.Text.UTF8Encoding]::new($false))
}

$layout = Get-AihLayout $InstallRoot

# -- 1. RUNTIME NATIVE CAPABILITY PRESENT (resolved composition) -----------
$verify = Invoke-AihChildSuite -ScriptPath (Join-Path $InstallRoot 'scripts\Verify-SkillsRuntime.ps1')
$verifyOutput = $verify.Output
$verifyExit = $verify.ExitCode
$verifyText = $verify.Text
Assert-Aih ($verifyExit -eq 0) '1: skills runtime verification exits clean'
Assert-Aih ($verifyText -match '(?m)^skills registry available: yes\r?$') '1: skills registry available in Nexus composition'
Assert-Aih ($verifyText -match '(?m)^filesystem provider available: yes\r?$') '1: filesystem provider available in Nexus composition'
Assert-Aih ($verifyText -match '(?m)^model skill tool available: yes\r?$') '1: model skill tool available in Nexus composition'
Assert-Aih ($verifyText -match '(?m)^native boot verified: yes\r?$') '1: native registry+provider boots end-to-end'

# -- 16-19. CORE PACK VALIDATION ---------------------------------------------
$coreRoot = Join-Path $InstallRoot 'skills\core'
$coreDirs = @(Get-ChildItem -LiteralPath $coreRoot -Directory | Sort-Object -Property Name)
$expectedCore = @(
    'nexus-engineering-workflow', 'git-safety', 'test-driven-hardening',
    'architecture-review', 'code-review', 'database-engineering',
    'local-first-sqlite', 'react-native-expo', 'frontend-design-fidelity',
    'ci-release-readiness'
)
Assert-Aih ((@($coreDirs | ForEach-Object { $_.Name }) | Sort-Object) -join '|' -eq (($expectedCore | Sort-Object) -join '|')) '16: core pack contains exactly the ten Nexus engineering skills'
$kebabPattern = '^[a-z0-9]+(-[a-z0-9]+)*$'
$seenCoreNames = @{}
foreach ($dir in $coreDirs) {
    Assert-Aih ($dir.Name -match $kebabPattern) "16: core skill name is kebab-case: $($dir.Name)"
    if ($seenCoreNames.ContainsKey($dir.Name)) {
        Assert-Aih $false "19: duplicate core skill name: $($dir.Name)"
    }
    $seenCoreNames[$dir.Name] = $true
    $skillMd = Join-Path $dir.FullName 'SKILL.md'
    Assert-Aih (Test-Path -LiteralPath $skillMd -PathType Leaf) "16: core skill has SKILL.md: $($dir.Name)"
    $text = [System.IO.File]::ReadAllText($skillMd)
    Assert-Aih ($text.StartsWith('---')) "17: core skill has frontmatter: $($dir.Name)"
    $endIndex = $text.IndexOf([Environment]::NewLine + '---', [StringComparison]::Ordinal)
    if ($endIndex -lt 0) { $endIndex = $text.IndexOf(([char]10) + '---', [StringComparison]::Ordinal) }
    Assert-Aih ($endIndex -gt 0) "17: core skill frontmatter is closed: $($dir.Name)"
    $header = $text.Substring(0, $endIndex)
    $nameMatch = [regex]::Match($header, '(?m)^name:\s*([a-z0-9-]+)\s*$')
    Assert-Aih ($nameMatch.Success -and $nameMatch.Groups[1].Value -eq $dir.Name) "16: core skill frontmatter name matches directory: $($dir.Name)"
    $blockMatch = [regex]::Match($header, '(?ms)^description:\s*(>[^\r\n]*)?[\r\n]+\s{2,}(\S.*)$')
    $inlineMatch = [regex]::Match($header, '(?m)^description:\s+(\S.*)$')
    $hasDescription = ($blockMatch.Success -or $inlineMatch.Success)
    Assert-Aih $hasDescription "17: core skill has non-empty description: $($dir.Name)"
    $body = $text.Substring($endIndex + 3)
    $meaningfulLines = @([regex]::Split($body, '\r?\n') | Where-Object { $_.Trim().Length -gt 0 })
    Assert-Aih ($meaningfulLines.Count -ge 20) "18: core skill body is non-empty and substantive: $($dir.Name)"
    Assert-Aih ($body -match '## When to use|## When') "18: core skill states when to use it: $($dir.Name)"
    Assert-Aih ($body -match '## Verify completion') "18: core skill states how to verify completion: $($dir.Name)"
}
Assert-Aih $true '19: no duplicate core skill names'

# -- 12-15 + ownership policy. INSTALLER BEHAVIOR ----------------------------
$installFixture = New-Fixture skills-install
try {
    $target = Join-Path $installFixture '.agents\skills'
    New-AihFixtureSkill -Directory (Join-Path $target 'third-party-notes') -Name 'third-party-notes' -Description 'Pre-existing user skill that must survive the installer.' -Body 'user body'
    $thirdPartyHashBefore = (Get-FileHash -Algorithm SHA256 (Join-Path $target 'third-party-notes\SKILL.md')).Hash

    $run1 = Invoke-AihInstaller -Source $coreRoot -Target $target
    Assert-Aih ($run1.ExitCode -eq 0) '4: installer installs the canonical global pack (exit 0)'
    Assert-Aih ($run1.Text -match 'git-safety' -and $run1.Text -match 'local-first-sqlite') '4: installer installs core skill names'
    Assert-Aih (Test-Path -LiteralPath (Join-Path $target 'nexus-engineering-workflow\SKILL.md')) '4: installed skill directory landed at the user root'
    Assert-Aih ((Get-FileHash -Algorithm SHA256 (Join-Path $target 'third-party-notes\SKILL.md')).Hash -eq $thirdPartyHashBefore) '12: unrelated pre-existing user skill is preserved byte-for-byte'
    Assert-Aih (Test-Path -LiteralPath (Join-Path $target 'nexus-skills.manifest.json')) '12: ownership manifest records the installed names'

    $run2 = Invoke-AihInstaller -Source $coreRoot -Target $target
    Assert-Aih ($run2.ExitCode -eq 0) '13: second installer run exits clean'
    Assert-Aih ($run2.Text -notmatch '(?m)^  installed: ' -and $run2.Text -notmatch '(?m)^  updated: ') '13: installer is idempotent (second run reports everything unchanged)'
    Assert-Aih ((Get-FileHash -Algorithm SHA256 (Join-Path $target 'git-safety\SKILL.md')).Hash -eq (Get-FileHash -Algorithm SHA256 (Join-Path $coreRoot 'git-safety\SKILL.md')).Hash) '13: idempotent run did not rewrite skill bytes'

    # deterministic update: mutate a copy of the source pack, reinstall
    $mutatedSource = Join-Path $installFixture 'mutated-core'
    New-Item -ItemType Directory -Force -Path $mutatedSource | Out-Null
    Copy-Item -LiteralPath (Join-Path $coreRoot 'git-safety') -Destination $mutatedSource -Recurse
    $mutatedSkill = Join-Path $mutatedSource 'git-safety\SKILL.md'
    $mutated = [System.IO.File]::ReadAllText($mutatedSkill)
    [System.IO.File]::WriteAllText($mutatedSkill, $mutated + [Environment]::NewLine + 'Deterministic update marker NXSKILL-UPDATE-MARKER.' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    $run3 = Invoke-AihInstaller -Source $mutatedSource -Target $target
    Assert-Aih ($run3.ExitCode -eq 0) '14: update run exits clean'
    Assert-Aih ($run3.Text -match '(?m)^  updated:\s+git-safety\s*$') '14: update replaces the Nexus-owned installed skill'
    $installedSkill = [System.IO.File]::ReadAllText((Join-Path $target 'git-safety\SKILL.md'))
    Assert-Aih ($installedSkill.Contains('NXSKILL-UPDATE-MARKER')) '14: updated content landed deterministically'
    $run4 = Invoke-AihInstaller -Source $mutatedSource -Target $target
    Assert-Aih ($run4.Text -match '(?m)^  unchanged:\s+git-safety\s*$') '14: post-update run is again unchanged (deterministic)'

    # malformed source: fails loudly before any write
    $badSource = Join-Path $installFixture 'bad-core'
    New-AihFixtureSkill -Directory (Join-Path $badSource 'broken-skill') -Name '' -Description 'no name here' -Body 'body'
    $badTarget = Join-Path $installFixture 'bad-target\skills'
    $run5 = Invoke-AihInstaller -Source $badSource -Target $badTarget
    Assert-Aih ($run5.ExitCode -eq 1) '15: malformed skill source fails loudly'
    Assert-Aih ($run5.Text -match 'Malformed Nexus skill source') '15: malformed source names the defect'
    Assert-Aih (-not (Test-Path -LiteralPath $badTarget)) '15: malformed source writes nothing to the target'

    # ownership: same-name non-Nexus skill is a conflict without -Force
    $ownedTarget = Join-Path $installFixture 'owned-target\skills'
    New-AihFixtureSkill -Directory (Join-Path $ownedTarget 'git-safety') -Name 'git-safety' -Description 'User-owned skill squatting a Nexus name.' -Body 'user content'
    $run6 = Invoke-AihInstaller -Source $coreRoot -Target $ownedTarget
    Assert-Aih ($run6.ExitCode -eq 2) '5: same-name non-Nexus skill is refused without -Force'
    $squatter = [System.IO.File]::ReadAllText((Join-Path $ownedTarget 'git-safety\SKILL.md'))
    Assert-Aih ($squatter.Contains('squatting')) '5: refused conflict did not touch the user-owned skill'
    $run7 = Invoke-AihInstaller -Source $coreRoot -Target $ownedTarget -Force
    Assert-Aih ($run7.ExitCode -eq 0) '5: -Force takes documented Nexus ownership'
    Assert-Aih (-not ([System.IO.File]::ReadAllText((Join-Path $ownedTarget 'git-safety\SKILL.md')).Contains('squatting'))) '5: ownership transfer replaced the content'
}
finally {
    if (Test-Path $installFixture) { Remove-Item -LiteralPath $installFixture -Recurse -Force }
}

# -- 21. EVAL FIXTURES MAP TASKS TO SKILLS ------------------------------------
$casesPath = Join-Path $InstallRoot 'tests\fixtures\skill-evals\cases.json'
Assert-Aih (Test-Path -LiteralPath $casesPath -PathType Leaf) '21: eval cases fixture exists'
$cases = Get-Content -Raw -Encoding UTF8 -LiteralPath $casesPath | ConvertFrom-Json
Assert-Aih (@($cases.cases).Count -eq 5) '21: eval harness defines the five foundation cases'
$caseIds = @($cases.cases | ForEach-Object { $_.id })
Assert-Aih (($caseIds -join ',') -eq 'case-a-sqlite-stale-ui,case-b-mockup-implementation,case-c-schema-migration,case-d-release-gate,case-e-git-author-change') '21: eval cases cover stale UI, mockup, migration, release, git identity'
foreach ($case in $cases.cases) {
    Assert-Aih (@($case.expectedSkills).Count -ge 1) "21: case $($case.id) expects at least one skill"
    foreach ($expected in $case.expectedSkills) {
        Assert-Aih ($expected.name -match $kebabPattern) "21: case $($case.id) expected skill name is kebab-case"
        Assert-Aih (@($expected.catalogPatterns).Count -ge 1 -and @($expected.bodyPatterns).Count -ge 1) "21: case $($case.id) pins catalog and body concepts for $($expected.name)"
        $expectedPath = Join-Path $coreRoot ($expected.name + '\SKILL.md')
        Assert-Aih (Test-Path -LiteralPath $expectedPath -PathType Leaf) "21: case $($case.id) expected skill exists in the core pack: $($expected.name)"
    }
}
$eval = Invoke-AihChildSuite -ScriptPath (Join-Path $InstallRoot 'scripts\Invoke-SkillEvals.ps1')
Assert-Aih ($eval.ExitCode -eq 0) '21: deterministic skill selection evals pass (cases A-E)'
Assert-Aih ($eval.Text -match 'failures: 0') '21: eval harness reports zero failures'

# -- 22. SECURITY DOCS/POLICY PRESENT ------------------------------------------
$securityPath = Join-Path $InstallRoot 'docs\skills\SECURITY.md'
Assert-Aih (Test-Path -LiteralPath $securityPath -PathType Leaf) '22: skills security policy document exists'
$securityText = Get-Content -Raw -Encoding UTF8 -LiteralPath $securityPath
Assert-Aih ($securityText -match 'not an authority|authority elevation') '22: security policy states skills are not authority elevation'
Assert-Aih ($securityText -match 'permission model') '22: security policy covers the Nexus permission model'
Assert-Aih ($securityText -match 'sandbox') '22: security policy covers the sandbox boundary'
Assert-Aih ($securityText -match 'Git') '22: security policy covers Git safety'
Assert-Aih ($securityText -match 'inert') '22: security policy states scripts/templates ship inert'
Assert-Aih (Test-Path -LiteralPath (Join-Path $InstallRoot 'docs\skills\README.md')) '22: skills README exists'
Assert-Aih (Test-Path -LiteralPath (Join-Path $InstallRoot 'docs\skills\SKILL_AUTHORING.md')) '22: skill authoring guide exists'
Assert-Aih (Test-Path -LiteralPath (Join-Path $InstallRoot 'docs\skills\EVALS.md')) '22: skills evals documentation exists'
$readmeText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'docs\skills\README.md')
Assert-Aih ($readmeText -match 'project-agents') '22: README documents native project-agents discovery'
Assert-Aih ($readmeText -match 'user-agents') '22: README documents native user-agents discovery'
$authoringText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'docs\skills\SKILL_AUTHORING.md')
Assert-Aih ($authoringText -match 'kebab-case') '22: authoring guide enforces kebab-case names'
Assert-Aih ($authoringText -match 'Memory') '22: authoring guide documents the skills/memory boundary'

Write-Host ('PASS: nexus-skills suite (' + $passed + ' assertions)')
