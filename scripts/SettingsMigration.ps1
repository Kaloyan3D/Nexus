[CmdletBinding()]
# CLI parameter names deliberately carry the Migration prefix: dot-sourcing a
# script runs its param block in the CALLER's scope, so a plain $InstallRoot
# parameter would blank the caller's own $InstallRoot (this exact collision
# broke the SetupUpgrade suite once already). The Sync-AihManagedSettings
# function parameters are unaffected by this - only the CLI tail uses these.
param(
    [string]$MigrationInstallRoot,
    [string]$MigrationTemplatePath,
    [string]$MigrationSettingsPath,
    # Explicit CLI gate: dot-sourcing this module (the Complete-Install path
    # calls Sync-AihManagedSettings directly) never executes the CLI tail.
    [switch]$RunMigration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Phase M2.1: additive managed provider settings migration.
#
# ARCHITECTURE (TASK-0037, Blocker 1):
#   config/settings.yaml  = the Nexus-managed template (default source of truth)
#   data/settings.yaml    = the user runtime settings (operator-owned document)
#
# A fresh install copies the template wholesale (Complete-Install.ps1), so the
# template and the runtime document agree and this migration is a verified
# no-op. An EXISTING install preserves its user settings across updates, which
# is why new Nexus-managed provider routes (e.g. the Phase M2 meta-model-api
# route) never reached data/settings.yaml. This helper migrates them
# ADDITIVELY and IDEMPOTENTLY:
#
#   1. a managed route missing from the user document is inserted verbatim
#      (the managed template text is the inserted bytes);
#   2. a managed route that byte-matches (newline-normalized) the CURRENT
#      template is left untouched (idempotent second run);
#   3. a managed route that byte-matches a KNOWN PRIOR managed state is
#      upgraded to the current template block (deterministic managed upgrade -
#      this is how the Phase M2 standard muse-spark-1.3 route becomes the
#      Phase M2.1 muse-spark-1.3-contributor route without duplicating either);
#   4. ANY other existing route (managed or not) is user-owned: it is never
#      modified, never reordered, never removed - the migration is additive
#      only;
#   5. a Nexus-managed route that exists but is structurally invalid (no
#      usable apiKeyEnv/baseURL declaration - it could never have served
#      traffic) fails closed with a clear migration error instead of being
#      silently "repaired" or duplicated.
#
# The transform is pure line/indentation text processing: no YAML parser, no
# comments lost, CRLF/LF tolerant (the user document's dominant newline style
# is preserved verbatim), UTF-8 without BOM, identical behavior on Windows and
# Linux. It NEVER rewrites the whole document: unchanged regions keep their
# exact original bytes and every user key keeps its position.

. (Join-Path $PSScriptRoot 'Common.ps1')

# Known PRIOR managed route states, newline-normalized, INCLUDING the
# 4-space route header line. A data route matching one of these is a stale
# Nexus-managed route and is upgraded to the current template text; anything
# else is user-owned and untouchable. The M2.1 entry is the Phase M2
# meta-model-api route exactly as shipped in commit 527ee8c (M2).
$script:ManagedRoutePriorStates = @{
    'meta-model-api' = @(
        @'
    meta-model-api:
      displayName: Meta Model API (Muse Spark, direct)
      apiKeyEnv: MODEL_API_KEY
      api: openai-completions
      baseURL: https://api.meta.ai/v1
      reasoning: xhigh
      compat:
        # Meta Model API wire contract (official Meta Model API cookbook,
        # verified Phase M2): OpenAI-compatible chat completions; reasoning via
        # reasoning_effort; usage in streaming via stream_options; developer
        # role preferred over system; canonical output-cap field is
        # max_completion_tokens. Muse Spark natively accepts reasoning_effort
        # none < minimal < low < medium < high, PLUS the accepted alias xhigh
        # (same strength as high). Nexus levels map in reasoningEfforts below;
        # an unmapped Nexus level is never sent (fail closed at the boundary).
        thinkingFormat: openai
        supportsReasoningEffort: true
        supportsUsageInStreaming: true
        supportsDeveloperRole: true
        maxTokensField: max_completion_tokens
      models:
        - id: muse-spark-1.3
          name: Muse Spark 1.3
          contextWindow: 1048576
          maxTokens: 32768
          reasoningEfforts:
            off:
            high: high
            xhigh: xhigh
            max: high
'@,
        # Second recognized prior state: the SAME Phase M2 managed route after
        # a DSH settings rewrite stripped the explanatory comments. A settings
        # save drops comments, so an installed M2 route can drift to this
        # comment-less shape; it is still the exact managed M2 content and
        # must upgrade to the current contributor route, not become
        # user-owned by accident.
        @'
    meta-model-api:
      displayName: Meta Model API (Muse Spark, direct)
      apiKeyEnv: MODEL_API_KEY
      api: openai-completions
      baseURL: https://api.meta.ai/v1
      reasoning: xhigh
      compat:
        thinkingFormat: openai
        supportsReasoningEffort: true
        supportsUsageInStreaming: true
        supportsDeveloperRole: true
        maxTokensField: max_completion_tokens
      models:
        - id: muse-spark-1.3
          name: Muse Spark 1.3
          contextWindow: 1048576
          maxTokens: 32768
          reasoningEfforts:
            off:
            high: high
            xhigh: xhigh
            max: high
'@
    )
}

function ConvertTo-AihMigrationNormalized {
    # Newline-normalize a block for comparison only (CRLF/LF tolerant).
    param([string]$Text)
    return ([string]$Text).Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd("`n")
}

function Get-AihSettingsProviderRouteBlocks {
    # Parse the llm-pi-ai.providers section of a settings document into route
    # blocks. Returns an ordered list of route records:
    #   Id          - the route key
    #   StartIndex  - index of the header line in $Lines
    #   EndIndex    - index of the last line of the block (inclusive)
    #   Text        - the block text newline-normalized
    #   ApiKeyEnv   - declared apiKeyEnv value ('' when absent)
    #   BaseURL     - declared baseURL value ('' when absent)
    #   ModelIds    - declared model entry ids
    # Indentation contract (the shape the managed template emits):
    #   llm-pi-ai:            col 0
    #     providers:          col 2
    #       <route>:          col 4
    #         key: value      col 6+
    param([string[]]$Lines)

    $routes = [System.Collections.Generic.List[object]]::new()
    $inLlmPiAi = $false
    $inProviders = $false
    $current = $null
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $line = $Lines[$i]
        if ($line -match '^llm-pi-ai:\s*(#.*)?$') {
            if ($null -ne $current) { $routes.Add($current); $current = $null }
            $inLlmPiAi = $true
            $inProviders = $false
            continue
        }
        if (-not $inLlmPiAi) { continue }
        if ($line -match '^\S') {
            # A new top-level key ends the llm-pi-ai block.
            if ($null -ne $current) { $routes.Add($current); $current = $null }
            $inLlmPiAi = $false
            $inProviders = $false
            continue
        }
        if ($line -match '^  providers:\s*(#.*)?$') {
            if ($null -ne $current) { $routes.Add($current); $current = $null }
            $inProviders = $true
            continue
        }
        if (-not $inProviders) { continue }
        if ($line -match '^  \S') {
            # Another col-2 child of llm-pi-ai ends the providers map.
            if ($null -ne $current) { $routes.Add($current); $current = $null }
            $inProviders = $false
            continue
        }
        if ($line -match '^    ([\w.-]+):\s*(#.*)?$') {
            if ($null -ne $current) { $routes.Add($current) }
            $current = [pscustomobject][ordered]@{
                Id = $Matches[1]
                StartIndex = $i
                EndIndex = $i
                ApiKeyEnv = ''
                BaseURL = ''
                ModelIds = [System.Collections.Generic.List[string]]::new()
            }
            continue
        }
        if ($null -eq $current) { continue }
        if ($line -match '^\s{6}apiKeyEnv:\s*(\S.*)$') { $current.ApiKeyEnv = ($Matches[1] -replace '(^|\s)#.*$', '').Trim().Trim('''', '"') }
        elseif ($line -match '^\s{6}baseURL:\s*(\S.*)$') { $current.BaseURL = ($Matches[1] -replace '(^|\s)#.*$', '').Trim().Trim('''', '"') }
        elseif ($line -match '^\s{8}- id:\s*(\S.*)$') { $current.ModelIds.Add(($Matches[1] -replace '(^|\s)#.*$', '').Trim().Trim('''', '"')) }
        $current.EndIndex = $i
    }
    if ($null -ne $current) { $routes.Add($current) }
    foreach ($route in $routes) {
        $blockLines = for ($j = $route.StartIndex; $j -le $route.EndIndex; $j++) { $Lines[$j] }
        $route | Add-Member -NotePropertyName Text -NotePropertyValue (ConvertTo-AihMigrationNormalized ($blockLines -join "`n"))
    }
    return ,$routes
}

function Test-AihManagedRouteStructurallyValid {
    # A Nexus-managed provider route must at least declare the fields the
    # transport requires: a non-empty apiKeyEnv and baseURL (the same rule
    # MuseProvider.ps1 applies when resolving the route). A route failing this
    # check can never have served traffic, so it cannot be a deliberate user
    # customization: fail closed with a clear migration error.
    param([object]$Route)
    return (-not [string]::IsNullOrWhiteSpace([string]$Route.ApiKeyEnv) -and
            -not [string]::IsNullOrWhiteSpace([string]$Route.BaseURL))
}

function ConvertTo-AihCapabilityDerivedSettingsTemplate {
    # The model registry owns Nexus capabilities; the managed DSH route owns
    # transport syntax. Derive the exact Muse input declaration at the install
    # seam so supportsVision cannot drift from DSH's model descriptor.
    param(
        [Parameter(Mandatory = $true)][string]$TemplateText,
        [Parameter(Mandatory = $true)][string]$ModelRegistryPath
    )

    if (-not (Test-Path -LiteralPath $ModelRegistryPath -PathType Leaf)) { throw "Model registry missing: $ModelRegistryPath" }
    $registry = Get-Content -Raw -Encoding UTF8 -LiteralPath $ModelRegistryPath | ConvertFrom-Json
    $entries = @($registry.models | Where-Object {
        [string]$_.id -eq 'muse-spark-1.3-contributor' -and
        [string]$_.provider -eq 'meta-model-api'
    })
    if ($entries.Count -ne 1) { throw 'The model registry must contain exactly one Meta Muse Contributor entry.' }
    $visionProperty = $entries[0].PSObject.Properties['supportsVision']
    if ($null -eq $visionProperty -or $visionProperty.Value -isnot [bool]) { throw 'The Muse Contributor registry entry must declare boolean supportsVision.' }

    $newline = if ($TemplateText.Contains("`r`n")) { "`r`n" } else { "`n" }
    $modelPattern = '(?m)^        - id: muse-spark-1\.3-contributor\r?\n          name: Muse Spark 1\.3 Contributor(?=\r?\n)(?:\r?\n          input: \[[^\r\n]*\])?'
    $modelMatches = [regex]::Matches($TemplateText, $modelPattern)
    if ($modelMatches.Count -ne 1) { throw 'The managed settings template must contain exactly one Muse Contributor model declaration.' }
    $desiredInput = if ([bool]$visionProperty.Value) { '[text, image]' } else { '[text]' }
    $replacement = '        - id: muse-spark-1.3-contributor' + $newline +
                   '          name: Muse Spark 1.3 Contributor' + $newline +
                   '          input: ' + $desiredInput
    return $TemplateText.Substring(0, $modelMatches[0].Index) + $replacement +
           $TemplateText.Substring($modelMatches[0].Index + $modelMatches[0].Length)
}

function Sync-AihManagedSettings {
    # Additive, idempotent managed provider-route sync from the managed
    # template (config/settings.yaml) into the user runtime document
    # (data/settings.yaml). Throws on a structurally invalid Nexus-managed
    # route (fail closed). Returns a deterministic migration record.
    param(
        [Parameter(Mandatory = $true)][string]$TemplatePath,
        [Parameter(Mandatory = $true)][string]$SettingsPath,
        [string]$ModelRegistryPath
    )

    if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) { throw "Managed settings template missing: $TemplatePath" }
    if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) { throw "User settings document missing: $SettingsPath" }

    $templateText = [System.IO.File]::ReadAllText($TemplatePath)
    if (-not [string]::IsNullOrWhiteSpace($ModelRegistryPath)) {
        $templateText = ConvertTo-AihCapabilityDerivedSettingsTemplate -TemplateText $templateText -ModelRegistryPath $ModelRegistryPath
    }
    $settingsText = [System.IO.File]::ReadAllText($SettingsPath)

    # The user document's newline style is preserved byte-for-byte: detect the
    # document-wide dominant style (CRLF wins when the document contains CRLF;
    # otherwise LF). Comparisons are newline-normalized and never depend on it.
    $newline = if ($settingsText.Contains("`r`n")) { "`r`n" } else { "`n" }

    $templateLines = $templateText -replace "`r`n", "`n" -split "`n"
    $settingsLines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($settingsText -replace "`r`n", "`n" -split "`n")) { $settingsLines.Add($line) }

    $templateRoutes = Get-AihSettingsProviderRouteBlocks -Lines $templateLines
    $settingsRoutes = Get-AihSettingsProviderRouteBlocks -Lines $settingsLines
    $settingsRouteById = [ordered]@{}
    foreach ($route in $settingsRoutes) { $settingsRouteById[[string]$route.Id] = $route }

    $record = [ordered]@{
        TemplatePath = $TemplatePath
        SettingsPath = $SettingsPath
        Changed = $false
        AddedRoutes = [System.Collections.Generic.List[string]]::new()
        UpgradedRoutes = [System.Collections.Generic.List[string]]::new()
        UnchangedRoutes = [System.Collections.Generic.List[string]]::new()
        SkippedUserRoutes = [System.Collections.Generic.List[string]]::new()
    }

    foreach ($managed in $templateRoutes) {
        $managedId = [string]$managed.Id
        if (-not $settingsRouteById.Contains($managedId)) {
            $record.AddedRoutes.Add($managedId)
            continue
        }
        $existing = $settingsRouteById[$managedId]
        if ([string]$existing.Text -eq [string]$managed.Text) {
            $record.UnchangedRoutes.Add($managedId)
            continue
        }
        $isKnownPriorState = $false
        if ($script:ManagedRoutePriorStates.ContainsKey($managedId)) {
            foreach ($prior in $script:ManagedRoutePriorStates[$managedId]) {
                if ([string]$existing.Text -eq (ConvertTo-AihMigrationNormalized $prior)) { $isKnownPriorState = $true; break }
            }
        }
        # A previously installed managed route can differ from the current
        # template solely because the model's newly declared input modalities
        # were absent. Treat only that exact byte-for-byte predecessor as
        # managed so vision capability upgrades reach existing installs;
        # every other structurally valid customization remains user-owned.
        if (-not $isKnownPriorState) {
            $managedWithoutInput = [regex]::Replace(
                [string]$managed.Text,
                '(?m)^          input: \[text, image\]\n?',
                ''
            )
            if ([string]$existing.Text -eq (ConvertTo-AihMigrationNormalized $managedWithoutInput)) {
                $isKnownPriorState = $true
            }
        }
        if (-not $isKnownPriorState) {
            if (-not (Test-AihManagedRouteStructurallyValid -Route $existing)) {
                throw ("Managed provider route '" + $managedId + "' in " + $SettingsPath + " is structurally invalid " +
                       "(apiKeyEnv: '" + $existing.ApiKeyEnv + "', baseURL: '" + $existing.BaseURL + "'). " +
                       "Refusing to migrate over it: fix or remove the route and re-run the update. " +
                       "(A Nexus-managed route that cannot serve traffic fails closed rather than being silently replaced.)")
            }
            $record.SkippedUserRoutes.Add($managedId)
            continue
        }
        # Deterministic managed upgrade: replace exactly the prior managed
        # block's lines with the current managed block's lines. Line counts may
        # differ; splice the list.
        $replacementLines = [System.Collections.Generic.List[string]]::new()
        foreach ($line in ($managed.Text -split "`n")) { $replacementLines.Add($line) }
        $settingsLines.RemoveRange($existing.StartIndex, ($existing.EndIndex - $existing.StartIndex + 1))
        $settingsLines.InsertRange($existing.StartIndex, $replacementLines)
        $record.UpgradedRoutes.Add($managedId)
        # Re-parse: indices shifted for every route after the splice.
        $settingsRoutes = Get-AihSettingsProviderRouteBlocks -Lines $settingsLines
        $settingsRouteById = [ordered]@{}
        foreach ($route in $settingsRoutes) { $settingsRouteById[[string]$route.Id] = $route }
    }

    if ($record.AddedRoutes.Count -gt 0) {
        # Build the insertion payload once: the managed blocks in template
        # order, in the user document's newline style.
        $payload = [System.Collections.Generic.List[string]]::new()
        foreach ($addedId in $record.AddedRoutes) {
            foreach ($managed in $templateRoutes) {
                if ([string]$managed.Id -ne $addedId) { continue }
                foreach ($line in ($managed.Text -split "`n")) { $payload.Add($line) }
            }
        }
        $existingLlmPiAiIndex = -1
        for ($i = 0; $i -lt $settingsLines.Count; $i++) {
            if ($settingsLines[$i] -match '^llm-pi-ai:\s*(#.*)?$') { $existingLlmPiAiIndex = $i; break }
        }
        if ($existingLlmPiAiIndex -ge 0) {
            $existingProvidersIndex = -1
            for ($i = $existingLlmPiAiIndex + 1; $i -lt $settingsLines.Count; $i++) {
                if ($settingsLines[$i] -match '^\S') { break }
                if ($settingsLines[$i] -match '^  providers:\s*(#.*)?$') { $existingProvidersIndex = $i; break }
            }
            if ($existingProvidersIndex -ge 0) {
                # Insert at the END of the providers map: scan forward to the
                # first line that is not inside it (next col-2 child, next
                # top-level key, or end of document), then skip trailing blank
                # lines back to the last content line.
                $insertIndex = $settingsLines.Count
                for ($i = $existingProvidersIndex + 1; $i -lt $settingsLines.Count; $i++) {
                    if ($settingsLines[$i] -match '^\S' -or $settingsLines[$i] -match '^  \S') { $insertIndex = $i; break }
                }
                while ($insertIndex - 1 -gt $existingProvidersIndex -and [string]::IsNullOrWhiteSpace($settingsLines[$insertIndex - 1])) { $insertIndex-- }
                $settingsLines.InsertRange($insertIndex, $payload)
            }
            else {
                # llm-pi-ai exists without a providers map: declare one.
                $insertIndex = $settingsLines.Count
                for ($i = $existingLlmPiAiIndex + 1; $i -lt $settingsLines.Count; $i++) {
                    if ($settingsLines[$i] -match '^\S') { $insertIndex = $i; break }
                }
                $providersHeader = [System.Collections.Generic.List[string]]::new()
                $providersHeader.Add('  providers:')
                foreach ($line in $payload) { $providersHeader.Add($line) }
                $settingsLines.InsertRange($insertIndex, $providersHeader)
            }
        }
        else {
            # No llm-pi-ai block at all: append a fresh top-level block at the
            # end of the document.
            if ($settingsLines.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($settingsLines[$settingsLines.Count - 1])) {
                $settingsLines.Add('')
            }
            $settingsLines.Add('llm-pi-ai:')
            $settingsLines.Add('  providers:')
            foreach ($line in $payload) { $settingsLines.Add($line) }
        }
    }

    $nextText = ($settingsLines -join $newline)
    if (-not $nextText.EndsWith($newline)) { $nextText += $newline }
    $normalizedBefore = ConvertTo-AihMigrationNormalized $settingsText
    $normalizedAfter = ConvertTo-AihMigrationNormalized $nextText
    $record.Changed = ($normalizedBefore -ne $normalizedAfter)
    if ($record.Changed) { Write-AihAtomicText -Path $SettingsPath -Content $nextText }
    return [pscustomobject]$record
}

# -- CLI tail (no-op when dot-sourced; gated behind -RunMigration) -----------
if ($RunMigration) {
    if ([string]::IsNullOrWhiteSpace($MigrationTemplatePath) -or [string]::IsNullOrWhiteSpace($MigrationSettingsPath)) {
        if ([string]::IsNullOrWhiteSpace($MigrationInstallRoot)) { throw 'SettingsMigration: -RunMigration needs -MigrationTemplatePath/-MigrationSettingsPath or -MigrationInstallRoot.' }
        $migrationLayout = Get-AihLayout $MigrationInstallRoot
        $MigrationTemplatePath = Join-Path $migrationLayout.Config 'settings.yaml'
        $MigrationSettingsPath = $migrationLayout.Settings
    }
    $migration = Sync-AihManagedSettings -TemplatePath $MigrationTemplatePath -SettingsPath $MigrationSettingsPath
    Write-Host ('MANAGED-SETTINGS ' + $(if ($migration.Changed) { 'MIGRATED' } else { 'UNCHANGED' }) +
        ' | added: ' + ((@($migration.AddedRoutes)) -join ',') +
        ' | upgraded: ' + ((@($migration.UpgradedRoutes)) -join ',') +
        ' | user-preserved: ' + ((@($migration.SkippedUserRoutes)) -join ','))
    exit 0
}
