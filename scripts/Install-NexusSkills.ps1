[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$SourceRoot,
    [string]$TargetRoot,
    [switch]$Force,
    [switch]$Json
)

# Deterministic installer/sync for the Nexus canonical global skill pack:
#
#   <InstallRoot>\skills\core\<skill-name>\  ->  ~/.agents/skills/<skill-name>\
#
# Guarantees:
#   - idempotent: running twice yields "unchanged" on the second run and
#     touches nothing whose bytes already match
#   - deterministic: same source and same target state yield the same actions
#   - preserves unrelated skills: only Nexus-owned names are written; nothing
#     is ever deleted
#   - ownership policy: a same-name skill at the target that the manifest does
#     not own is a CONFLICT; without -Force nothing is written at all, with
#     -Force Nexus takes explicit documented ownership
#   - fails loudly on malformed skill source before any write
#   - no administrator privileges, no machine-specific paths
#
# Ownership manifest: <TargetRoot>\nexus-skills.manifest.json records which
# skill names this installer owns (with the last installed content hash).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Get-AihInstallRoot $null }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot = Join-Path $InstallRoot 'skills/core' }
if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
    $TargetRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agents/skills'
}
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
$TargetRoot = [System.IO.Path]::GetFullPath($TargetRoot)
$ManifestPath = Join-Path $TargetRoot 'nexus-skills.manifest.json'
$SkillNamePattern = '^[a-z0-9]+(-[a-z0-9]+)*$'

function Write-AihSkillFail {
    # Plain-text failure + exit code (never Write-Error: this script runs with
    # ErrorActionPreference=Stop, which would turn the diagnostic into a
    # terminating error before the deterministic exit code is emitted).
    param([string]$Message)
    if ($Json) {
        Write-Output (ConvertTo-Json -InputObject ([ordered]@{ ok = $false; error = $Message }) -Depth 4)
    }
    else { Write-Host ("ERROR: " + $Message) }
    exit 1
}

function Get-AihSkillFrontmatter {
    param([string]$Path)

    $text = [System.IO.File]::ReadAllText($Path)
    $lines = [System.Text.RegularExpressions.Regex]::Split($text, '\r?\n')
    if ($lines.Count -lt 3 -or $lines[0] -ne '---') {
        return $null
    }
    $closeIndex = -1
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -eq '---') { $closeIndex = $i; break }
    }
    if ($closeIndex -lt 0) { return $null }
    return @{ lines = $lines[1..($closeIndex - 1)] }
}

function Test-AihSkillFrontmatterField {
    # Returns the inline scalar after "key:" or, when the value is a block
    # scalar (" > ", ">-", "|"), the first non-empty indented content line.
    param([string[]]$Lines, [string]$Key)

    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -notmatch ('^' + [regex]::Escape($Key) + ':(.*)$')) { continue }
        $inline = $Matches[1].Trim()
        if ($inline.Length -gt 0 -and $inline -notmatch '^[>|][-+0-9]*$') {
            return $inline.Trim('"').Trim("'")
        }
        for ($j = $i + 1; $j -lt $Lines.Count; $j++) {
            $line = $Lines[$j]
            if ($line -match '^\s') {
                if ($line.Trim().Length -gt 0) { return $line.Trim() }
            }
            else { break }
        }
        return $null
    }
    return $null
}

function Get-AihDirectoryHash {
    param([string]$Directory)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $files = @(Get-ChildItem -LiteralPath $Directory -Recurse -File | ForEach-Object {
            [pscustomobject]@{ Path = $_.FullName; Relative = $_.FullName.Substring($Directory.Length + 1).Replace('\', '/') }
        } | Sort-Object -Property Relative)
        if ($files.Count -eq 0) { return $null }
        $newline = [char]10
        foreach ($file in $files) {
            $pathBytes = [System.Text.Encoding]::UTF8.GetBytes($file.Relative + $newline)
            [void]$sha.TransformBlock($pathBytes, 0, $pathBytes.Length, $null, 0)
            $content = [System.IO.File]::ReadAllBytes($file.Path)
            [void]$sha.TransformBlock($content, 0, $content.Length, $null, 0)
        }
        [void]$sha.TransformFinalBlock([byte[]]@(), 0, 0)
        return ([BitConverter]::ToString($sha.Hash)).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
}

function Copy-AihSkillDirectory {
    param([string]$Source, [string]$Destination)

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File) {
        $relative = $file.FullName.Substring($Source.Length + 1)
        $targetFile = Join-Path $Destination $relative
        $targetDir = Split-Path -Parent $targetFile
        if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }
        Copy-Item -LiteralPath $file.FullName -Destination $targetFile -Force
    }
}

# --- validate source (fail loudly before any write) ---------------------------
if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    Write-AihSkillFail ("Nexus skill source root does not exist: " + $SourceRoot)
}
$sourceSkillDirs = @(Get-ChildItem -LiteralPath $SourceRoot -Directory | Sort-Object -Property Name)
if ($sourceSkillDirs.Count -eq 0) {
    Write-AihSkillFail ("Nexus skill source root contains no skills: " + $SourceRoot)
}

$sourceSkills = @()
$seenNames = @{}
foreach ($dir in $sourceSkillDirs) {
    $skillMd = Join-Path $dir.FullName 'SKILL.md'
    if (-not (Test-Path -LiteralPath $skillMd -PathType Leaf)) {
        Write-AihSkillFail ("Malformed Nexus skill source: directory '" + $dir.Name + "' has no SKILL.md")
    }
    $frontmatter = Get-AihSkillFrontmatter -Path $skillMd
    if ($null -eq $frontmatter) {
        Write-AihSkillFail ("Malformed Nexus skill source: '" + $dir.Name + "\SKILL.md' is missing a valid YAML frontmatter ('---') block")
    }
    $name = Test-AihSkillFrontmatterField -Lines $frontmatter.lines -Key 'name'
    $description = Test-AihSkillFrontmatterField -Lines $frontmatter.lines -Key 'description'
    if ([string]::IsNullOrWhiteSpace($name)) {
        Write-AihSkillFail ("Malformed Nexus skill source: '" + $dir.Name + "\SKILL.md' frontmatter has no name")
    }
    if ($name -notmatch $SkillNamePattern) {
        Write-AihSkillFail ("Malformed Nexus skill source: '" + $dir.Name + "' name '" + $name + "' is not kebab-case")
    }
    if ($name -ne $dir.Name) {
        Write-AihSkillFail ("Malformed Nexus skill source: frontmatter name '" + $name + "' does not match directory name '" + $dir.Name + "'")
    }
    if ([string]::IsNullOrWhiteSpace($description)) {
        Write-AihSkillFail ("Malformed Nexus skill source: '" + $dir.Name + "\SKILL.md' frontmatter has no description")
    }
    if ($seenNames.ContainsKey($name)) {
        Write-AihSkillFail ("Malformed Nexus skill source: duplicate skill name '" + $name + "' (provided by more than one source directory)")
    }
    $seenNames[$name] = $true
    $hash = Get-AihDirectoryHash -Directory $dir.FullName
    if ($null -eq $hash) {
        Write-AihSkillFail ("Malformed Nexus skill source: '" + $dir.Name + "' contains no files")
    }
    $sourceSkills += [pscustomobject]@{
        Name = $name
        SourcePath = $dir.FullName
        Hash = $hash
    }
}

# --- load ownership manifest ---------------------------------------------------
$manifest = @{}
if (Test-Path -LiteralPath $ManifestPath) {
    try {
        $parsed = Get-Content -Raw -Encoding UTF8 -LiteralPath $ManifestPath | ConvertFrom-Json
        foreach ($property in $parsed.skills.PSObject.Properties) {
            $manifest[$property.Name] = $property.Value
        }
    }
    catch {
        Write-AihSkillFail ("Nexus skills ownership manifest is unreadable; fix or remove it manually: " + $ManifestPath)
    }
}

# --- plan actions (nothing is written until the plan is clean) -----------------
$actions = @()
$conflicts = @()
$orphans = @()
foreach ($skill in $sourceSkills) {
    $targetDir = Join-Path $TargetRoot $skill.Name
    $targetExists = Test-Path -LiteralPath $targetDir -PathType Container
    $owned = $manifest.ContainsKey($skill.Name)
    if (-not $targetExists) {
        $actions += [pscustomobject]@{ Name = $skill.Name; Action = 'installed'; Hash = $skill.Hash; TookOwnership = $false }
    }
    elseif ($owned) {
        $targetHash = Get-AihDirectoryHash -Directory $targetDir
        if ($targetHash -eq $skill.Hash) {
            $actions += [pscustomobject]@{ Name = $skill.Name; Action = 'unchanged'; Hash = $skill.Hash; TookOwnership = $false }
        }
        else {
            $actions += [pscustomobject]@{ Name = $skill.Name; Action = 'updated'; Hash = $skill.Hash; TookOwnership = $false }
        }
    }
    elseif ($Force) {
        $actions += [pscustomobject]@{ Name = $skill.Name; Action = 'updated'; Hash = $skill.Hash; TookOwnership = $true }
    }
    else {
        $conflicts += [pscustomobject]@{ Name = $skill.Name; TargetPath = $targetDir; Reason = 'target skill exists and is not Nexus-owned (no manifest entry)' }
    }
}
foreach ($ownedName in $manifest.Keys) {
    if (-not $seenNames.ContainsKey($ownedName)) {
        $orphans += [pscustomobject]@{ Name = $ownedName; Detail = 'previously installed by Nexus but absent from the current source pack; left in place (no deletion)' }
    }
}
if ($conflicts.Count -gt 0 -and -not $Force) {
    $conflictNames = ($conflicts | ForEach-Object { $_.Name }) -join ', '
    $message = "Refusing to overwrite non-Nexus skills at the target: " + $conflictNames + ". Remove them, rename them, or pass -Force to take documented Nexus ownership."
    if ($Json) {
        Write-Output (ConvertTo-Json -InputObject ([ordered]@{ ok = $false; error = $message; conflicts = $conflicts }) -Depth 5)
    }
    else {
        Write-Host ("ERROR: " + $message)
        foreach ($conflict in $conflicts) { Write-Host ("CONFLICT: " + $conflict.Name + " -> " + $conflict.Reason) }
    }
    exit 2
}

# --- apply ----------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null
foreach ($action in $actions) {
    $skill = $sourceSkills | Where-Object { $_.Name -eq $action.Name } | Select-Object -First 1
    if ($action.Action -ne 'unchanged') {
        Copy-AihSkillDirectory -Source $skill.SourcePath -Destination (Join-Path $TargetRoot $action.Name)
    }
    $manifest[$action.Name] = [pscustomobject]@{ hash = $action.Hash; installedAtUtc = [DateTime]::UtcNow.ToString('o') }
}
$manifestDocument = [ordered]@{
    version = 1
    updatedUtc = [DateTime]::UtcNow.ToString('o')
    sourceRoot = 'skills/core'
    skills = $manifest
}
Write-AihAtomicText -Path $ManifestPath -Content (ConvertTo-Json -InputObject $manifestDocument -Depth 6)

# --- report ---------------------------------------------------------------------
$summary = [ordered]@{
    ok = $true
    sourceRoot = $SourceRoot
    targetRoot = $TargetRoot
    installed = @($actions | Where-Object { $_.Action -eq 'installed' } | ForEach-Object { $_.Name })
    updated = @($actions | Where-Object { $_.Action -eq 'updated' } | ForEach-Object { $_.Name })
    unchanged = @($actions | Where-Object { $_.Action -eq 'unchanged' } | ForEach-Object { $_.Name })
    tookOwnership = @($actions | Where-Object { $_.TookOwnership } | ForEach-Object { $_.Name })
    orphaned = $orphans
    conflicts = $conflicts
}
if ($Json) {
    Write-Output (ConvertTo-Json -InputObject $summary -Depth 6)
}
else {
    Write-Host ("Nexus skills source: " + $SourceRoot)
    Write-Host ("Nexus skills target: " + $TargetRoot)
    Write-Host ("installed: " + $summary.installed.Count + " | updated: " + $summary.updated.Count + " | unchanged: " + $summary.unchanged.Count)
    foreach ($name in $summary.installed) { Write-Host ("  installed: " + $name) }
    foreach ($name in $summary.updated) { Write-Host ("  updated:   " + $name) }
    foreach ($name in $summary.unchanged) { Write-Host ("  unchanged: " + $name) }
    foreach ($name in $summary.tookOwnership) { Write-Host ("  took ownership (-Force): " + $name) }
    foreach ($orphan in $summary.orphaned) { Write-Host ("  orphaned (left in place): " + $orphan.Name) }
    foreach ($conflict in $summary.conflicts) { Write-Host ("  conflict (not written): " + $conflict.Name) }
}
exit 0
