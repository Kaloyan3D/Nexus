Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Project.ps1')
. (Join-Path $PSScriptRoot 'TaskController.ps1')
# TASK-0009: context eligibility and retrieval reuse the Phase 3.1 machinery
# (glob engine, repository config, classification, sensitivity) instead of a
# second, incompatible path walker.
. (Join-Path $PSScriptRoot 'intelligence\Intelligence.Common.ps1')
. (Join-Path $PSScriptRoot 'intelligence\Intelligence.Scanning.ps1')

# ── TASK-0009: deterministic context-retrieval constants ─────────────────────
# The relevance floor keeps weak/incidental matches out of review packets. It
# is NOT a budget: unlimited mode (0 = unlimited) removes token/file cutoffs,
# never relevance selection. A single occurrence of a moderately specific term
# scores ~0.2-0.7; a single occurrence of a near-ubiquitous term scores <0.05.
$script:AihContextRelevanceFloor = 0.05
# Repetition bound: per-file term occurrences past this cap contribute no
# additional score (tf saturation), so a word repeated 1000 times in a log can
# never dominate a specific identifier or path match.
$script:AihContextTermOccurrenceCap = 50
# Evidence weighting: source and tests are strong review evidence; runtime
# state is heavily deprioritized (normally excluded outright by eligibility).
$script:AihContextEvidenceWeights = @{
    'source'        = 1.25
    'test'          = 1.25
    'docs'          = 1.0
    'config'        = 1.0
    'unknown'       = 0.6
    'generated'     = 0.5
    'runtime-state' = 0.25
}

function Get-AihCodeSymbols {
    param([string]$Workspace, [string]$RelativePath)
    $path = Join-Path $Workspace $RelativePath
    $lines = @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)
    $symbols = [Collections.Generic.List[object]]::new()
    $patterns = @(
        @{ Kind='class'; Regex='^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)' },
        @{ Kind='interface'; Regex='^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)' },
        @{ Kind='function'; Regex='^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)' },
        @{ Kind='function'; Regex='^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>' },
        @{ Kind='function'; Regex='^\s*function\s+([A-Za-z][\w-]*)\s*\{' },
        @{ Kind='type'; Regex='^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=' },
        @{ Kind='python'; Regex='^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)\s*[(:]' },
        @{ Kind='dotnet'; Regex='^\s*(?:public|private|internal|protected)?\s*(?:static\s+)?(?:class|interface|struct|record|enum)\s+([A-Za-z_]\w*)' }
    )
    for ($i=0; $i -lt $lines.Count; $i++) {
        foreach ($pattern in $patterns) {
            if ($lines[$i] -match $pattern.Regex) {
                $symbols.Add([pscustomobject]@{ name=$Matches[1]; kind=$pattern.Kind; file=$RelativePath.Replace('\','/'); line=$i+1; signature=$lines[$i].Trim() })
                break
            }
        }
    }
    @($symbols)
}

# ── Context eligibility (TASK-0009) ──────────────────────────────────────────

function Get-AihNexusRuntimeExclusionGlobs {
    # Nexus-owned defaults for THIS install's known controller/runtime roots.
    # They are tree globs (gitignore-style, evaluated by the Phase 3.1 glob
    # engine) and they are NOT a global ban on directory names: a repository
    # may re-include any path via .nexus.yml context.exclude_globs negation
    # ('!data/fixtures/**'), and legitimate source/data fixtures outside these
    # roots are never touched. Sensitive/blocked files are excluded separately
    # and can never be re-included.
    return @(
        # controller-owned runtime state (ledger, run manifests, bindings)
        '.ai-harness/state/**',
        '.ai-harness/runs/**',
        # controller routing runtime state
        'data/routing/**',
        # controller operational state and logs
        'data/logs/**', 'data/tmp/**', 'data/sessions/**', 'data/storages/**',
        'data/completion/**', 'data/evaluation/**', 'data/.agent-presets/**',
        'data/profiles/**', 'data/aih-state.json',
        # generated installed/runtime copies (never repository source here)
        'data/intelligence/**', 'runtime/node/**', 'app/node_modules/**',
        # acceptance/scratch trees and their captured logs/workspaces
        'logs/**', 'tmp/**', '_tmp_ws/**', '_audit/**', 'nx-chrome-profile/**'
    )
}

function Get-AihContextEvidenceClass {
    # Deterministic evidence class for review context. Runtime roots are
    # runtime-state evidence even when a later config layer re-included them;
    # everything else maps from the Phase 3.1 classification.
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Classification,
        [bool]$RuntimeState = $false
    )
    if ($RuntimeState) { return 'runtime-state' }
    switch ($Classification) {
        'source'        { return 'source' }
        'test'          { return 'test' }
        'documentation' { return 'docs' }
        'config'        { return 'config' }
        'generated'     { return 'generated' }
        'vendor'        { return 'generated' }
        default         { return 'unknown' }
    }
}

function Get-AihContextEligibleFiles {
    # TASK-0009: canonical context-eligibility gate for repository review and
    # search context. Distinguishes source evidence from runtime, generated and
    # operational state. Layering (LAST match wins, negations included):
    #   layer 0 'nexus-runtime-defaults' - Nexus-owned runtime roots
    #   layer 1 'nexus-context-config'   - .nexus.yml context.exclude_globs
    #   layer 2 'nexus-sensitivity'      - blocked/potential_secret files,
    #                                      NEVER eligible and never overridable
    # The Phase 3.1 walker, classification, sensitivity and glob engine are
    # reused; no second walker exists here. Returns EVERY scanned file with an
    # explicit eligibility decision so callers can filter AND explain.
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        $RepositoryConfig = $null
    )
    $workspacePath = [IO.Path]::GetFullPath($Workspace)
    if ($null -eq $RepositoryConfig) { $RepositoryConfig = Resolve-AihRepositoryConfig -CheckoutRoot $workspacePath }
    $defaultRules = [System.Collections.ArrayList]::new()
    $order = 0.0
    foreach ($glob in (Get-AihNexusRuntimeExclusionGlobs)) {
        $null = $defaultRules.Add(@{ source = 'nexus-runtime-defaults'; base = ''; pattern = $glob; order = $order; negate = $false })
        $order = $order + 1.0
    }
    $configRules = [System.Collections.ArrayList]::new()
    foreach ($glob in @($RepositoryConfig.contextExcludeGlobs)) {
        $trimmed = "$glob".Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
        $null = $configRules.Add(@{ source = 'nexus-context-config'; base = ''; pattern = $trimmed; order = $order; negate = $trimmed.StartsWith('!') })
        $order = $order + 1.0
    }
    $files = @(Get-AihWorkspaceFiles $workspacePath)
    $decisions = [Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        $rel = $file.Replace('\', '/')
        $runtimeDecision = Get-AihIgnoreDecision -RelPath $rel -IsDirectory $false -Rules @($defaultRules)
        $decision = Get-AihIgnoreDecision -RelPath $rel -IsDirectory $false -Rules (@($defaultRules) + @($configRules))
        $sensitivity = Get-AihFileSensitivity -RelPath $rel -Config $RepositoryConfig
        $classification = Get-AihFileClassification -RelPath $rel -IsBinary $false -Config $RepositoryConfig
        $runtimeState = [bool]$runtimeDecision.matched
        $eligible = $true
        $reason = 'eligible'
        if ($decision.excluded) {
            $eligible = $false
            $matchedRule = @(@($defaultRules) + @($configRules) | Where-Object { [double]$_.order -eq [double]$decision.matchedOrder } | Select-Object -First 1)
            $reason = 'context-excluded:' + "$($decision.layer)" + ':' + "$($matchedRule.pattern)"
        }
        if ($sensitivity -ne 'normal') {
            $eligible = $false
            $reason = 'sensitivity:' + "$sensitivity"
        }
        $decisions.Add([pscustomobject][ordered]@{
            path             = $rel
            fullPath         = (Join-Path $workspacePath $file)
            eligible         = $eligible
            exclusionReason  = $reason
            sensitivity      = $sensitivity
            classification   = $classification
            evidenceClass    = (Get-AihContextEvidenceClass -Path $rel -Classification $classification -RuntimeState:$runtimeState)
        })
    }
    @($decisions)
}

# ── Deterministic lexical retrieval (TASK-0009) ──────────────────────────────

function Test-AihIdentifierLikeTerm {
    # A query token is identifier-like when it cannot be an ordinary sentence
    # word: inner uppercase (CodeIntelligenceStore, findWidget), snake_case, or
    # shouting-with-digits (UTF8). A leading capital alone (a sentence word
    # such as 'Review') is NOT identifier-like.
    param([string]$Token)
    if ([string]::IsNullOrWhiteSpace($Token)) { return $false }
    if ($Token -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { return $false }
    for ($i = 1; $i -lt $Token.Length; $i++) {
        if ([char]::IsUpper($Token[$i])) { return $true }
    }
    if ($Token.Contains('_')) { return $true }
    $allUpperOrDigit = $true; $hasDigit = $false
    foreach ($ch in $Token.ToCharArray()) {
        if ([char]::IsLower($ch)) { $allUpperOrDigit = $false }
        if ([char]::IsDigit($ch)) { $hasDigit = $true }
    }
    return ($allUpperOrDigit -and $hasDigit)
}

function Get-AihMeaningfulQueryTerms {
    # Lowercase, split on non-word characters, drop length<2 tokens, remove
    # stopwords, deduplicate in first-seen order. Returns the meaningful terms
    # (with identifier-likeness per term) and the removed stopwords so bundles
    # can explain what was retrieved and what was deliberately ignored.
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Query)
    $terms = [Collections.Generic.List[string]]::new()
    $identifierLike = [Collections.Generic.List[bool]]::new()
    $stopped = [Collections.Generic.List[string]]::new()
    $seen = @{}
    foreach ($raw in @($Query -split '\W+')) {
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }
        $lower = $raw.ToLowerInvariant()
        if ($lower.Length -lt 2) { continue }
        if ($script:AihContextStopWords.Contains($lower)) {
            if (-not $stopped.Contains($lower)) { $stopped.Add($lower) }
            continue
        }
        if ($seen.ContainsKey($lower)) { continue }
        $seen[$lower] = $true
        $terms.Add($lower)
        $identifierLike.Add((Test-AihIdentifierLikeTerm $raw))
    }
    [pscustomobject]@{ terms = @($terms); identifierLike = @($identifierLike); stopped = @($stopped) }
}

function Get-AihBoundedTermCount {
    # Counts case-sensitive (caller lowercases) occurrences with a hard cap so
    # pathological repetition costs neither CPU nor relevance.
    param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][string]$Term, [int]$Cap = 50)
    $count = 0; $index = 0
    while ($count -lt $Cap) {
        $found = $Text.IndexOf($Term, $index, [StringComparison]::Ordinal)
        if ($found -lt 0) { break }
        $count = $count + 1
        $index = $found + $Term.Length
    }
    $count
}

function Invoke-AihContextRetrieval {
    # Deterministic weighted lexical retrieval over context-ELIGIBLE files.
    #   idf(t)      = ln(1 + (N - df + 0.5) / (df + 0.5))     [BM25-style]
    #   tf-term     = tf / (tf + 2), tf capped at 50           [saturation]
    #   path bonus  = +1.0 basename hit, +0.5 directory-segment hit
    #   identifier  = x2.0 for identifier-like terms
    #   evidence    = per-class weight (source/test strongest, runtime lowest)
    # A candidate is selected only when its final score reaches the relevance
    # floor AND it matches at least one meaningful term in content or path.
    param(
        [string]$Workspace,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Query,
        [int]$MaxResults = 20,
        [double]$RelevanceFloor = $script:AihContextRelevanceFloor
    )
    $workspacePath = [IO.Path]::GetFullPath($Workspace)
    $parsedTerms = Get-AihMeaningfulQueryTerms $Query
    $terms = @($parsedTerms.terms)
    $identifierFlags = @($parsedTerms.identifierLike)
    $inventory = @(Get-AihContextEligibleFiles -Workspace $workspacePath)
    $eligible = @($inventory | Where-Object { $_.eligible })
    $excludedByReason = [ordered]@{}
    foreach ($entry in @($inventory | Where-Object { -not $_.eligible })) {
        $key = [string]$entry.exclusionReason
        if ($excludedByReason.Contains($key)) { $excludedByReason[$key] = $excludedByReason[$key] + 1 }
        else { $excludedByReason[$key] = 1 }
    }
    $diagnostics = [ordered]@{
        query           = $Query
        meaningfulTerms = $terms
        stoppedTerms    = @($parsedTerms.stopped)
        relevanceFloor  = $RelevanceFloor
        scannedFiles    = @($inventory).Count
        eligibleFiles   = @($eligible).Count
        excludedFiles   = (@($inventory).Count - @($eligible).Count)
        excludedByReason = $excludedByReason
    }
    $emptyResult = [pscustomobject]($diagnostics + @{ candidates = @() })
    if ($terms.Count -eq 0 -or @($eligible).Count -eq 0) { return $emptyResult }

    # pass 1: per-file term occurrences + path hits; document frequency per term
    $tfTable = @{}; $pathTable = @{}; $byPath = @{}; $df = @{}
    foreach ($entry in $eligible) {
        $text = $null
        try {
            $item = Get-Item -LiteralPath $entry.fullPath -ErrorAction Stop
            if ($item.Length -gt 1048576) { continue }
            $text = [string](Get-Content -Raw -LiteralPath $entry.fullPath -ErrorAction Stop)
        } catch { continue }
        $lower = $text.ToLowerInvariant()
        $fileName = ([IO.Path]::GetFileName($entry.path)).ToLowerInvariant()
        $pathLower = $entry.path.ToLowerInvariant()
        $tfRow = @{}; $pathRow = @{}; $hitAny = $false
        for ($i = 0; $i -lt $terms.Count; $i++) {
            $term = $terms[$i]
            $count = 0; $bonus = 0.0
            if ($lower.Contains($term)) { $count = Get-AihBoundedTermCount -Text $lower -Term $term -Cap $script:AihContextTermOccurrenceCap }
            if ($fileName.Contains($term)) { $bonus = $bonus + 1.0 }
            elseif (@($pathLower.Split('/') | Where-Object { $_.Contains($term) }).Count -gt 0) { $bonus = $bonus + 0.5 }
            if ($count -gt 0 -or $bonus -gt 0) {
                $tfRow[$term] = $count; $pathRow[$term] = $bonus; $hitAny = $true
                if ($df.ContainsKey($term)) { $df[$term] = $df[$term] + 1 } else { $df[$term] = 1 }
            }
        }
        if ($hitAny) {
            $tfTable[$entry.path] = $tfRow
            $pathTable[$entry.path] = $pathRow
            $byPath[$entry.path] = $entry
        }
    }
    # BM25 N is the number of retrievable (eligible) documents, NOT the number
    # of files that happened to match: otherwise a generic word shared by a few
    # hit files in a small repo would masquerade as a rare, specific term.
    $fileCount = [double]$eligible.Count
    if ($tfTable.Keys.Count -le 0) { return $emptyResult }

    # pass 2: score, floor, order (only floor-passing files are re-read for snippets)
    $ranked = [Collections.Generic.List[object]]::new()
    foreach ($path in @($tfTable.Keys)) {
        $entry = $byPath[$path]
        $tfRow = $tfTable[$path]; $pathRow = $pathTable[$path]
        $weight = $script:AihContextEvidenceWeights[[string]$entry.evidenceClass]
        if ($null -eq $weight) { $weight = 0.75 }
        $score = 0.0
        $matched = [Collections.Generic.List[string]]::new()
        $pathMatched = [Collections.Generic.List[string]]::new()
        for ($i = 0; $i -lt $terms.Count; $i++) {
            $term = $terms[$i]
            if (-not $tfRow.ContainsKey($term)) { continue }
            $dfTerm = [double]$df[$term]
            $idf = [Math]::Log(1.0 + (($fileCount - $dfTerm + 0.5) / ($dfTerm + 0.5)))
            $boost = if ($identifierFlags[$i]) { 2.0 } else { 1.0 }
            $tf = [double]$tfRow[$term]
            $tfSat = $tf / ($tf + 2.0)
            $bonus = [double]$pathRow[$term]
            $score = $score + ($idf * $boost * ($tfSat + $bonus))
            $matched.Add($term)
            if ($bonus -gt 0) { $pathMatched.Add($term) }
        }
        $final = [Math]::Round($score * $weight, 6)
        if ($final -lt $RelevanceFloor) { continue }
        $snippet = ''
        try {
            $picked = [Collections.Generic.List[string]]::new()
            $lines = @(([string](Get-Content -Raw -LiteralPath $entry.fullPath -ErrorAction Stop)) -split '\r?\n')
            $scan = [Math]::Min(400, $lines.Count)
            for ($i = 0; $i -lt $scan -and $picked.Count -lt 3; $i++) {
                $lineLower = $lines[$i].ToLowerInvariant()
                foreach ($t in $matched) {
                    if ($lineLower.Contains($t)) { $picked.Add($lines[$i]); break }
                }
            }
            $snippet = (@($picked) -join [string][char]10)
        } catch { $snippet = '' }
        $ranked.Add([pscustomobject]@{
            file = $path; score = $final; snippet = $snippet
            evidenceClass = $entry.evidenceClass; classification = $entry.classification
            matchedTerms = @($matched); pathMatches = @($pathMatched)
        })
    }
    $ordered = @($ranked | Sort-Object @{Expression='score';Descending=$true}, @{Expression='file';Descending=$false})
    if ($MaxResults -gt 0) { $ordered = @($ordered | Select-Object -First $MaxResults) }
    [pscustomobject]($diagnostics + @{ candidates = $ordered })
}

function Search-AihCode {
    # TASK-0007: $MaxResults 0 = unlimited (explicit semantic, no magic number).
    # TASK-0009: deterministic weighted lexical retrieval over context-eligible
    # files only. Repetition can no longer dominate relevance (idf + tf
    # saturation + bounded occurrence counting), runtime/generated state is
    # excluded from candidates by eligibility, and a relevance floor keeps weak
    # incidental matches out of the results.
    param([string]$Workspace,[Parameter(Mandatory=$true)][string]$Query,[int]$MaxResults=20)
    # Bind the retrieval object first: member enumeration via @( ... ).property
    # fails under StrictMode when the candidates property is an EMPTY array
    # (a valid result for stopword-only queries).
    $retrieval = Invoke-AihContextRetrieval -Workspace $Workspace -Query $Query -MaxResults $MaxResults
    @($retrieval.candidates)
}

function New-AihRepositoryMap {
    # TASK-0009: the repository map is review/search context, so it is built
    # from context-ELIGIBLE files (runtime/generated/state trees excluded).
    param([string]$Workspace, [int]$MaxFiles = 1000)
    $workspacePath = [IO.Path]::GetFullPath($Workspace)
    $files = @((Get-AihContextEligibleFiles -Workspace $workspacePath | Where-Object { $_.eligible } | ForEach-Object { $_.path }) | Select-Object -First $MaxFiles)
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        $extension = [IO.Path]::GetExtension($file).ToLowerInvariant()
        $symbols = if ($extension -in @('.ps1','.psm1','.js','.cjs','.mjs','.ts','.tsx','.jsx','.py','.cs','.fs','.java','.go','.rs')) { @(Get-AihCodeSymbols $workspacePath $file) } else { @() }
        $imports = @()
        if (@($symbols).Count -or $extension -in @('.json','.yml','.yaml','.md')) {
            $imports = @(Select-String -LiteralPath (Join-Path $workspacePath $file) -Pattern '(?i)(?:from\s+|require\(|import\s+|using\s+)(["''][^"'']+["'']|[A-Za-z0-9_.\\/-]+)' -ErrorAction SilentlyContinue | Select-Object -First 30 | ForEach-Object { $_.Line.Trim() })
        }
        $entries.Add([pscustomobject]@{ path=$file.Replace('\','/'); bytes=(Get-Item -LiteralPath (Join-Path $workspacePath $file)).Length; symbols=@($symbols); imports=@($imports) })
    }
    [pscustomobject]@{ schemaVersion=1; workspace=$workspacePath; generatedAtUtc=[DateTime]::UtcNow.ToString('o'); truncated=$files.Count -ge $MaxFiles; files=@($entries) }
}

function Find-AihSymbol {
    param([Parameter(Mandatory=$true)]$RepositoryMap, [Parameter(Mandatory=$true)][string]$Name)
    @($RepositoryMap.files | ForEach-Object { @($_.symbols) } | Where-Object { $_.name -like "*$Name*" } | Sort-Object @{Expression={ if ($_.name -eq $Name) {0}else{1}}}, file, line)
}

function Get-AihFileOutline {
    param([Parameter(Mandatory=$true)]$RepositoryMap, [Parameter(Mandatory=$true)][string]$File)
    @($RepositoryMap.files | Where-Object path -eq $File.Replace('\','/') | Select-Object -First 1).symbols
}

function Find-AihReferences {
    param([string]$Workspace, [Parameter(Mandatory=$true)][string]$Symbol, [int]$MaxResults=100)
    $workspacePath=[IO.Path]::GetFullPath($Workspace)
    $matches = & rg --line-number --column --glob '!node_modules/**' --glob '!app/**' --glob '!runtime/node/**' --glob '!data/**' --glob '!logs/**' --fixed-strings -- $Symbol $workspacePath 2>$null
    @($matches | Select-Object -First $MaxResults | ForEach-Object { [string]$_ })
}

function Select-AihBundleSlices {
    # Budget-aware slice selection over ranked candidates. Unlimited mode
    # ($UnlimitedTokens/$UnlimitedFiles) removes the truncation/cutoffs; slices
    # are whole files. Selection consumes the ALREADY relevance-ranked list.
    param($Retrieval,[string]$WorkspaceRoot,[bool]$UnlimitedTokens,[bool]$UnlimitedFiles,[int]$MaxFiles,[int]$MaxContextTokens)
    $budgetChars=if($UnlimitedTokens){[int]::MaxValue}else{$MaxContextTokens*4}
    $used=0
    $slices=[Collections.Generic.List[object]]::new()
    foreach($match in @($Retrieval.candidates)){
        if(-not $UnlimitedFiles -and $slices.Count -ge $MaxFiles){break}
        $path=Join-Path $WorkspaceRoot $match.file
        $content=[string](Get-Content -Raw -LiteralPath $path)
        $remaining=$budgetChars-$used
        if($remaining -le 0){break}
        $slice=if($content.Length -gt $remaining){$content.Substring(0,$remaining)}else{$content}
        $reason=if(@($match.pathMatches).Count -gt 0 -and @($match.matchedTerms).Count -gt @($match.pathMatches).Count){'path+content term match'}
                elseif(@($match.pathMatches).Count -gt 0){'path match'}
                else{'content term match'}
        $slices.Add([pscustomobject]@{path=$match.file;score=$match.score;evidenceClass=$match.evidenceClass;classification=$match.classification;matchedTerms=@($match.matchedTerms);pathMatches=@($match.pathMatches);eligibility='eligible';reason=$reason;content=$slice;truncated=$slice.Length -lt $content.Length})
        $used += $slice.Length
    }
    [pscustomobject]@{slices=@($slices);used=$used}
}

function New-AihContextBundle {
    # TASK-0007: 0 = unlimited (explicit semantic; never a huge magic number).
    # Unlimited mode removes the token/file cutoffs but keeps RELEVANCE:
    # retrieval still ranks and selects the files that match the task, slices
    # are included whole, and the bundle never claims full-repository content
    # ingestion unless that was explicitly requested.
    # TASK-0009: ranking is deterministic weighted lexical scoring over
    # context-eligible files; unlimited never means indiscriminate (relevance
    # floor stays active). Before the reviewer consumes a bundle, a structured
    # context-quality guard verifies that meaningful source/test/docs/config
    # evidence was selected and performs ONE deterministic broaden retry
    # (relevance floor dropped, eligibility and weights unchanged) before
    # reporting a structured context-quality failure. The manifest records full
    # selection provenance (score, evidenceClass, matchedTerms, pathMatches,
    # eligibility/reason per selected file).
    param([string]$Workspace,[string]$TaskId,[string]$Task,[string[]]$AcceptanceCriteria=@(),[int]$MaxContextTokens=12000,[int]$MaxFiles=12)
    if($MaxContextTokens -lt 0 -or $MaxFiles -lt 0){throw 'Context budget values must be non-negative (0 = unlimited).'}
    if($MaxContextTokens -ne 0 -and $MaxContextTokens -lt 500){throw 'Context budget must be at least 500 tokens (or 0 for unlimited).'}
    $unlimitedTokens=$MaxContextTokens -eq 0
    $unlimitedFiles=$MaxFiles -eq 0
    $layout=Initialize-AihTaskLedger $Workspace
    $repoMap=New-AihRepositoryMap $Workspace
    $query=($Task+' '+($AcceptanceCriteria -join ' ')).Trim()
    $rankLimit=if($unlimitedFiles){0}else{$MaxFiles*2}
    $retrieval=Invoke-AihContextRetrieval $Workspace $query $rankLimit
    $broadenRetry=$false
    $meaningfulClasses=@('source','test','docs','config')
    $selected=Select-AihBundleSlices -Retrieval $retrieval -WorkspaceRoot $layout.Workspace -UnlimitedTokens:$unlimitedTokens -UnlimitedFiles:$unlimitedFiles -MaxFiles $MaxFiles -MaxContextTokens $MaxContextTokens
    $hasMeaningful=@($selected.slices | Where-Object { $meaningfulClasses -contains $_.evidenceClass }).Count -gt 0
    $requiresRepoEvidence=@($retrieval.meaningfulTerms).Count -gt 0
    if(-not $hasMeaningful -and $requiresRepoEvidence){
        # One deterministic broaden/retrieval retry: drop the relevance floor.
        # Eligibility, evidence weighting and budgets are unchanged; no LLM and
        # no engineer model participates in context repair.
        $broadenRetry=$true
        $retrieval=Invoke-AihContextRetrieval $Workspace $query $rankLimit 0
        $selected=Select-AihBundleSlices -Retrieval $retrieval -WorkspaceRoot $layout.Workspace -UnlimitedTokens:$unlimitedTokens -UnlimitedFiles:$unlimitedFiles -MaxFiles $MaxFiles -MaxContextTokens $MaxContextTokens
        $hasMeaningful=@($selected.slices | Where-Object { $meaningfulClasses -contains $_.evidenceClass }).Count -gt 0
    }
    $meaningfulSelected=@($selected.slices | Where-Object { $meaningfulClasses -contains $_.evidenceClass } | ForEach-Object { $_.evidenceClass } | Sort-Object -Unique)
    $qualityStatus=if($hasMeaningful -or -not $requiresRepoEvidence){'pass'}else{'fail'}
    $qualityReason=if($qualityStatus -eq 'pass'){
        'bundle contains meaningful repository evidence (' + (($meaningfulSelected | ForEach-Object { "$_" }) -join ',') + ')'
    } elseif(-not $requiresRepoEvidence){
        'query carries no meaningful (non-stopword) terms; nothing was retrievable'
    } else {
        'no source/test/docs/config evidence matched the query even after the broaden retry; runtime/generated/state files were excluded from evidence'
    }
    $slices=$selected.slices
    $used=$selected.used
    $budgetChars=if($unlimitedTokens){[int]::MaxValue}else{$MaxContextTokens*4}
    $docs=[Collections.Generic.List[object]]::new()
    foreach($name in @('project.md','architecture.md','conventions.md')){
        $path=Join-Path $layout.Root $name
        if(Test-Path -LiteralPath $path){$content=Get-Content -Raw -LiteralPath $path; if($used+$content.Length -le $budgetChars){$docs.Add([pscustomobject]@{path='.ai-harness/'+$name;content=$content});$used+=$content.Length}}
    }
    $git=[ordered]@{baseCommit=$null;changedFiles=@();diffStat=''}
    try{$git.baseCommit=(& git -C $layout.Workspace rev-parse HEAD 2>$null|Select-Object -First 1).Trim();$git.changedFiles=@(& git -C $layout.Workspace status --short 2>$null);$git.diffStat=(& git -C $layout.Workspace diff --stat 2>$null|Out-String).Trim()}catch{}
    $symbolCount=0;foreach($entry in @($repoMap.files)){$symbolCount+=@($entry.symbols).Count}
    $evidence=@($slices | ForEach-Object { [ordered]@{
        path=$_.'path'; score=$_.'score'; evidenceClass=$_.'evidenceClass'; classification=$_.'classification'
        matchedTerms=@($_.'matchedTerms'); pathMatches=@($_.'pathMatches')
        eligibility=$_.'eligibility'; reason=$_.'reason'
    } })
    $manifest=[ordered]@{
        schemaVersion=2
        taskId=$TaskId
        budget=[ordered]@{maxContextTokens=$MaxContextTokens;estimatedTokens=[Math]::Ceiling($used/4);maxFiles=$MaxFiles;enforceLimits=(-not $unlimitedTokens -and -not $unlimitedFiles)}
        repositoryMap=[ordered]@{fileCount=@($repoMap.files).Count;symbolCount=$symbolCount;fullRepositoryIncluded=$false}
        selection=[ordered]@{
            query=$retrieval.query
            meaningfulTerms=@($retrieval.meaningfulTerms)
            stoppedTerms=@($retrieval.stoppedTerms)
            relevanceFloor=$retrieval.relevanceFloor
            broadenRetry=$broadenRetry
            scannedFiles=$retrieval.scannedFiles
            eligibleFiles=$retrieval.eligibleFiles
            excludedFiles=$retrieval.excludedFiles
            excludedByReason=$retrieval.excludedByReason
            candidateCount=@($retrieval.candidates).Count
            evidence=$evidence
        }
        contextQuality=[ordered]@{status=$qualityStatus;meaningfulEvidenceClasses=@($meaningfulSelected);broadenRetryUsed=$broadenRetry;reason=$qualityReason}
        files=@($slices|ForEach-Object{$_.path})
        documents=@($docs|ForEach-Object{$_.path})
        git=$git
        generatedAtUtc=[DateTime]::UtcNow.ToString('o')
    }
    if(-not [string]::IsNullOrWhiteSpace($TaskId)){Write-AihAtomicJson (Join-Path (Join-Path $layout.Runs $TaskId) 'context-manifest.json') $manifest}
    [pscustomobject]@{task=$Task;acceptanceCriteria=@($AcceptanceCriteria);repositoryMap=$repoMap;fileSlices=@($slices);documents=@($docs);git=$git;manifest=[pscustomobject]$manifest;contextQuality=[pscustomobject]$manifest.contextQuality}
}

# ── stopword table (closed-class English; deterministic, no domain words) ────
$script:AihContextStopWords = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($__w in @(
    'an','the','and','or','but','nor','so','yet','for','of','to','in','on','at','by','with','from','as',
    'into','onto','over','under','up','down','out','off','about','above','below','between','through',
    'during','before','after','is','are','was','were','be','been','being','am','do','does','did','done',
    'doing','have','has','had','having','will','would','shall','should','can','could','may','might',
    'must','not','no','it','its','this','that','these','those','there','here','they','them','their',
    'we','our','ours','us','you','your','yours','he','him','his','she','her','hers','me','my','mine',
    'who','whom','whose','which','what','when','where','why','how','all','any','both','each','few',
    'more','most','other','others','some','such','only','own','same','than','too','very','just','also',
    'then','once','again','further','while','because','if','until','unless','whether','either','neither',
    'every','now','please','per','via'
)) { [void]$script:AihContextStopWords.Add($__w) }
Remove-Variable -Name __w -ErrorAction SilentlyContinue
