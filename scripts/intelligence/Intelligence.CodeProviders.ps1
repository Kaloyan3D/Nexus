Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Phase 3.2C/D: deterministic code intelligence providers ─────────────────
# Provider abstraction:
#   CanHandle(language) / GetCapabilities() / Analyze(...) / version.
# These are tier-4 'deterministic language-specific fallback parsers'
# (line/brace/indent based, no external processes, no semantic resolution
# beyond same-file unique-name evidence). Compiler-grade and SCIP providers
# can be registered ahead of them; the registry is priority-ordered.
# Reference policy (never fake semantic resolution):
#   definition            exact (the symbol record itself)
#   import                'name-binding' — bound name, raw target unresolved
#   export                exact declaration evidence
#   call                  'unresolved' — syntactic call, target NOT claimed
#   reference             'same-file-unique' only when exactly one same-file
#                         definition carries the name; otherwise
#                         'ambiguous-unresolved'

$script:AihCodeIntelligenceProviders = $null

function Get-AihCodeLineArray {
    param([Parameter(Mandatory = $true)][string]$Content)
    return @($Content.Replace([string][char]13, '') -split [string][char]10)
}

function Find-AihBraceBlockEnd {
    # 0-based index of the line closing the block opened on $StartIndex0.
    # Graceful for malformed input: returns the last line index.
    param($Lines, [int]$StartIndex0)
    $depth = 0
    $opened = $false
    for ($i = $StartIndex0; $i -lt @($Lines).Count; $i++) {
        $chars = $Lines[$i].ToCharArray()
        foreach ($ch in $chars) {
            if ($ch -eq '{') { $depth = $depth + 1; $opened = $true }
            elseif ($ch -eq '}') { $depth = $depth - 1 }
        }
        if ($opened -and $depth -le 0) { return $i }
    }
    return @($Lines).Count - 1
}

function ConvertTo-AihQualifiedName {
    param([string[]]$Stack, [Parameter(Mandatory = $true)][string]$Name)
    $parts = @($Stack) + @($Name)
    return (($parts | Where-Object { -not [string]::IsNullOrEmpty($_) }) -join '.')
}

function Get-AihCodeSyntaxStrippedLines {
    # F05 (TASK-0012): occurrence scanning must see code, not lexical text.
    # Returns one code-only string per input line: comments and string
    # literal CONTENTS are removed with language-aware, stateful scanning
    # (line/block comments, quotes, template/triple/here strings). Escaped
    # characters never terminate a string. Deterministic; no external
    # processes. Over-stripping is conservative: it can only reduce
    # occurrences, never fabricate them.
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines,
        [Parameter(Mandatory = $true)][ValidateSet('tsjs', 'python', 'powershell')][string]$Language
    )
    $output = [System.Collections.Generic.List[string]]::new()
    # code | block | single | double | template | here-single | here-double | triple-single | triple-double
    $state = 'code'
    foreach ($line in @($Lines)) {
        $code = [Text.StringBuilder]::new()
        $i = 0
        $n = $line.Length
        $lineOpen = $true
        while ($i -lt $n -and $lineOpen) {
            $ch = $line[$i]
            $next = $(if ($i + 1 -lt $n) { [string]$line[$i + 1] } else { '' })
            $two = [string]$ch + $next
            $three = $(if ($i + 2 -lt $n) { $line.Substring($i, 3) } else { '' })
            if ($state -eq 'code') {
                if (($Language -eq 'tsjs' -and $two -eq '//') -or ($Language -ne 'tsjs' -and $ch -eq '#')) {
                    $lineOpen = $false
                } elseif ($Language -eq 'python' -and ($three -eq "'''" -or $three -eq '"""')) {
                    $state = $(if ($three -eq "'''") { 'triple-single' } else { 'triple-double' }); $i = $i + 3
                } elseif ($Language -eq 'tsjs' -and $two -eq '/*') {
                    $state = 'block'; $i = $i + 2
                } elseif ($Language -eq 'powershell' -and $two -eq '<#') {
                    $state = 'block'; $i = $i + 2
                } elseif ($Language -eq 'tsjs' -and $ch -eq [char]96) {
                    $state = 'template'; $i = $i + 1
                } elseif ($Language -eq 'powershell' -and ($two -eq ('@' + [string][char]39) -or $two -eq ('@' + [string][char]34)) -and $line.Substring($i + 2).Trim() -eq '') {
                    $state = $(if ($two -eq ('@' + [string][char]39)) { 'here-single' } else { 'here-double' }); $i = $i + 2; $lineOpen = $false
                } elseif ($ch -eq [char]39) {
                    $state = 'single'; $i = $i + 1
                } elseif ($ch -eq [char]34) {
                    $state = 'double'; $i = $i + 1
                } else {
                    [void]$code.Append($ch); $i = $i + 1
                }
            } elseif ($state -eq 'block') {
                $closer = $(if ($Language -eq 'powershell') { '#>' } else { '*/' })
                if ($two -eq $closer) { $state = 'code'; $i = $i + 2 } else { $i = $i + 1 }
            } elseif ($state -eq 'single') {
                if ($Language -eq 'powershell' -and $two -eq [string][char]39 + [string][char]39) { $i = $i + 2 }
                elseif ($Language -ne 'powershell' -and $ch -eq '\') { $i = $i + 2 }
                elseif ($ch -eq [char]39) { $state = 'code'; $i = $i + 1 }
                else { $i = $i + 1 }
            } elseif ($state -eq 'double') {
                if ($Language -eq 'powershell' -and $ch -eq [char]96) { $i = $i + 2 }
                elseif ($Language -eq 'powershell' -and $two -eq [string][char]34 + [string][char]34) { $i = $i + 2 }
                elseif ($Language -ne 'powershell' -and $ch -eq '\') { $i = $i + 2 }
                elseif ($ch -eq [char]34) { $state = 'code'; $i = $i + 1 }
                else { $i = $i + 1 }
            } elseif ($state -eq 'template') {
                if ($ch -eq '\') { $i = $i + 2 }
                elseif ($ch -eq [char]96) { $state = 'code'; $i = $i + 1 }
                else { $i = $i + 1 }
            } elseif ($state -eq 'here-single') {
                $lineOpen = $false
                if ($line.Trim() -eq ([string][char]39 + '@')) { $state = 'code' }
            } elseif ($state -eq 'here-double') {
                $lineOpen = $false
                if ($line.Trim() -eq ([string][char]34 + '@')) { $state = 'code' }
            } elseif ($state -eq 'triple-single') {
                if ($three -eq "'''") { $state = 'code'; $i = $i + 3 } elseif ($ch -eq '\') { $i = $i + 2 } else { $i = $i + 1 }
            } elseif ($state -eq 'triple-double') {
                if ($three -eq '"""') { $state = 'code'; $i = $i + 3 } elseif ($ch -eq '\') { $i = $i + 2 } else { $i = $i + 1 }
            }
        }
        $output.Add($code.ToString())
    }
    return $output.ToArray()
}

function Get-AihCodeDefinitionLineSet {
    # F05: definition lines are definition evidence; they never yield calls
    # or resolved references.
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()]$Symbols)
    $set = @{}
    foreach ($symbol in @($Symbols)) {
        if ([int]$symbol.startLine -gt 0) { $set[[int]$symbol.startLine] = $true }
    }
    return $set
}

function Get-AihCodeImportLineSet {
    # F05: import declarations bind names; they never yield references.
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines, [Parameter(Mandatory = $true)][ValidateSet('tsjs', 'python')][string]$Language)
    $set = @{}
    for ($i = 0; $i -lt @($Lines).Count; $i++) {
        $trimmed = $Lines[$i].Trim()
        $isImport = $false
        if ($Language -eq 'python') {
            $isImport = ($trimmed -match '^import\s' -or $trimmed -match '^from\s+\S+\s+import\s')
        } else {
            $isImport = ($trimmed -match '^import\s' -or $trimmed -match '=\s*require\s*\(' -or $trimmed -match '^export\s[^;]*\sfrom\s["' + [string][char]39 + ']')
        }
        if ($isImport) { $set[$i + 1] = $true }
    }
    return $set
}

function Get-AihCodeParameterShadowRanges {
    # F05 scope guard: name -> line ranges of containers whose parameter list
    # declares that name. A parameter shadows outer definitions inside its
    # container, so same-file-unique evidence must not resolve there.
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()]$Symbols)
    $ranges = @{}
    foreach ($symbol in @($Symbols)) {
        $signature = [string]$symbol.signature
        $open = $signature.IndexOf('(')
        if ($open -lt 0) { continue }
        $close = $signature.LastIndexOf(')')
        if ($close -le $open) { continue }
        $parameterText = $signature.Substring($open + 1, $close - $open - 1)
        if ([string]::IsNullOrWhiteSpace($parameterText)) { continue }
        foreach ($part in ($parameterText -split ',')) {
            $m = [regex]::Match($part.Trim(), '^(?:\.\.\.|\*\*|\*)?(?:(?:private|protected|public|readonly|final|var|val|ref|out|in)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)')
            if (-not $m.Success) { continue }
            $parameterName = $m.Groups[1].Value
            if ([string]::IsNullOrWhiteSpace($parameterName)) { continue }
            if ($script:AihCallKeywordBlocklist -contains $parameterName) { continue }
            if (-not $ranges.ContainsKey($parameterName)) { $ranges[$parameterName] = @() }
            $ranges[$parameterName] = @($ranges[$parameterName]) + @(@{ start = [int]$symbol.startLine; end = [int]$symbol.endLine })
        }
    }
    return $ranges
}

function Test-AihCodeCallPosition {
    # F05: a bare name directly followed by an argument list is a call
    # position. Call positions keep the documented unresolved-call semantics
    # and never yield resolved same-file references.
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Line, [Parameter(Mandatory = $true)][int]$Index, [Parameter(Mandatory = $true)][int]$Length)
    $rest = $Line.Substring([Math]::Min($Index + $Length, $Line.Length))
    return ($rest.TrimStart(' ', [string][char]9).StartsWith('('))
}

$script:AihCallKeywordBlocklist = @('if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'delete', 'void', 'in', 'of', 'else', 'do', 'try', 'foreach', 'lock', 'using', 'base', 'this')

function Invoke-AihStructuralTsJs {
    # Deterministic structural extraction for TypeScript and JavaScript.
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$FileIntelligenceId
    )
    $lines = Get-AihCodeLineArray -Content $Content
    $symbols = @()
    $imports = @()
    $exports = @()
    $occurrences = @()
    $diagnostics = @()
    $stack = @()            # container qualified-name stack
    $stackDepths = @()      # brace depth at container entry
    $depth = 0
    $callCount = 0

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        $lineNo = $i + 1
        $trimmed = $line.Trim()
        $exported = $trimmed -match '^\s*export\s'

        # pop containers whose blocks closed on previous lines (-lt: the
        # container is still open while depth equals its entry depth)
        while ($stack.Count -gt 0 -and $depth -lt [int]$stackDepths[$stack.Count - 1] -and $stackDepths[$stack.Count - 1] -gt 0) {
            $stack = @($stack | Select-Object -First ($stack.Count - 1))
            $stackDepths = @($stackDepths | Select-Object -First ($stackDepths.Count - 1))
        }

        $symKind = $null; $symName = $null; $isBlock = $false
        if ($trimmed -match '^(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)') { $symKind = 'interface'; $symName = $Matches[1]; $isBlock = $true }
        elseif ($trimmed -match '^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)') { $symKind = 'enum'; $symName = $Matches[1]; $isBlock = $true }
        elseif ($trimmed -match '^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)') { $symKind = 'class'; $symName = $Matches[1]; $isBlock = $true }
        elseif ($trimmed -match '^(?:export\s+)?(?:module|namespace)\s+([A-Za-z_$][\w$.]*)') { $symKind = 'namespace'; $symName = $Matches[1]; $isBlock = $true }
        elseif ($trimmed -match '^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)') { $symKind = 'function'; $symName = $Matches[1]; $isBlock = $true }
        elseif ($trimmed -match '^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]') { $symKind = 'typeAlias'; $symName = $Matches[1] }
        elseif ($stack.Count -gt 0 -and $trimmed -match '^(?:(?:public|private|protected|static|readonly|async|override|get|set|\*)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{;]+)?\{') {
            $candidate = $Matches[1]
            if ($script:AihCallKeywordBlocklist -notcontains $candidate) { $symKind = 'method'; $symName = $candidate; $isBlock = $true }
        }
        if ($null -eq $symKind -and $stack.Count -gt 0 -and $trimmed -match '^(?:(?:public|private|protected|static|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*[^=]' -and $trimmed -notmatch '\)\s*(?:\{|=>)') {
            $candidate = $Matches[1]
            if ($script:AihCallKeywordBlocklist -notcontains $candidate) { $symKind = 'property'; $symName = $candidate }
        }
        if ($null -eq $symKind -and $stack.Count -eq 0 -and $trimmed -match '^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)') {
            $symKind = 'function'; $symName = $Matches[1]; $isBlock = $trimmed -match 'function\b'
        }
        if ($null -eq $symKind -and $stack.Count -eq 0 -and $trimmed -match '^(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=') {
            $kind = if ($Matches[1] -eq 'const') { 'constant' } else { 'variable' }
            $symKind = $kind; $symName = $Matches[2]
        }

        if ($null -ne $symKind) {
            $qualified = ConvertTo-AihQualifiedName -Stack $stack -Name $symName
            $endIdx = if ($isBlock) { Find-AihBraceBlockEnd -Lines $lines -StartIndex0 $i } else { $i }
            $signature = ($trimmed -replace '\s+', ' ')
            $symbols = @($symbols) + @((New-AihParsedSymbol -FileIntelligenceId $FileIntelligenceId -Kind $symKind -Name $symName -QualifiedName $qualified -Signature $signature -Container ($(if ($stack.Count -gt 0) { $stack[$stack.Count - 1] } else { '' })) -StartLine $lineNo -StartColumn ($line.IndexOf($symName) + 1) -EndLine ($endIdx + 1) -EndColumn $lines[$endIdx].Length -Exported $exported))
            $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'definition' -Name $symName -Line $lineNo -Column ($line.IndexOf($symName) + 1) -Resolution 'exact' -ResolvedTargetId $symbols[$symbols.Count - 1].sid))
            if ($isBlock) {
                $stack = @($stack) + @($qualified)
                $stackDepths = @($stackDepths) + @($depth + ([regex]::Matches($line, '\{').Count))
            }
        }

        # imports
        if ($trimmed -match '^import\s+[''"]([^''"]+)[''"]') {
            $imports = @($imports) + @([pscustomobject][ordered]@{ rawTarget = $Matches[1]; resolution = 'raw'; bindings = @(); line = $lineNo })
        }
        elseif ($trimmed -match '^import\s+(?:type\s+)?(.+?)\s+from\s+[''"]([^'']+)[''"]') {
            $clause = $Matches[1]; $target = $Matches[2]
            $bindings = @()
            if ($clause -match '^\s*(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|$)') { $bindings = @($bindings) + @($Matches[1]) }
            if ($clause -match '\{([^}]*)\}') {
                foreach ($part in ($Matches[1] -split ',')) {
                    $name = ($part -replace 'type\s+', '').Trim()
                    if ($name -match 'as\s+([A-Za-z_$][\w$]*)\s*$') { $name = $Matches[1] }
                    if (-not [string]::IsNullOrWhiteSpace($name)) { $bindings = @($bindings) + @($name.Trim()) }
                }
            }
            if ($clause -match '\*\s+as\s+([A-Za-z_$][\w$]*)') { $bindings = @($bindings) + @($Matches[1]) }
            $imports = @($imports) + @([pscustomobject][ordered]@{ rawTarget = $target; resolution = 'raw'; bindings = @($bindings); line = $lineNo })
            foreach ($binding in $bindings) {
                $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'import' -Name $binding -Line $lineNo -Column 1 -Resolution 'name-binding'))
            }
        }
        elseif ($trimmed -match '^(?:const|let|var)\s+.*=\s*require\(\s*[''"]([^''"]+)[''"]\s*\)') {
            $imports = @($imports) + @([pscustomobject][ordered]@{ rawTarget = $Matches[1]; resolution = 'raw'; bindings = @(); line = $lineNo })
        }

        # exports
        if ($trimmed -match '^export\s+\{\s*([^}]*)\s*\}') {
            foreach ($part in ($Matches[1] -split ',')) {
                $name = $part.Trim() -replace '\s+as\s+.*$', ''
                if (-not [string]::IsNullOrWhiteSpace($name)) { $exports = @($exports) + @([pscustomobject][ordered]@{ name = $name; kind = 'named'; sourceTarget = ''; line = $lineNo }) }
            }
        }
        elseif ($trimmed -match '^export\s+\*\s*(?:from\s*[''"]([^''"]+)[''"])?') {
            $exports = @($exports) + @([pscustomobject][ordered]@{ name = '*'; kind = 'star'; sourceTarget = $(if ($Matches.Count -gt 1) { $Matches[1] } else { '' }); line = $lineNo })
        }
        elseif ($trimmed -match '^export\s+default\s+') {
            $exports = @($exports) + @([pscustomobject][ordered]@{ name = 'default'; kind = 'default'; sourceTarget = ''; line = $lineNo })
        }
        elseif ($trimmed -match '^export\s+(?:type\s+)?(?:async\s+)?(?:function|class|interface|enum|const|let|var)\s+([A-Za-z_$][\w$]*)') {
            $exports = @($exports) + @([pscustomobject][ordered]@{ name = $Matches[1]; kind = 'named'; sourceTarget = ''; line = $lineNo })
        }
        elseif ($trimmed -match '^export\s+(?:type\s+)?(.+?)\s+from\s+[''"]([^'']+)[''"]') {
            $exports = @($exports) + @([pscustomobject][ordered]@{ name = $Matches[1]; kind = 'from'; sourceTarget = $Matches[2]; line = $lineNo })
        }

        $depth = $depth + ([regex]::Matches($line, '\{').Count) - ([regex]::Matches($line, '\}').Count)
    }

    # F05: call occurrences (syntactic; target intentionally unresolved) are
    # scanned over comment/string-stripped code and never on definition
    # lines, so lexical text and signature heads cannot invent call evidence.
    if ($callCount -lt 400) {
        $codeLines = Get-AihCodeSyntaxStrippedLines -Lines $lines -Language 'tsjs'
        $definitionLineNumbers = Get-AihCodeDefinitionLineSet -Symbols $symbols
        for ($i = 0; $i -lt $lines.Count -and $callCount -lt 400; $i++) {
            if ($definitionLineNumbers.ContainsKey($i + 1)) { continue }
            $callMatches = [regex]::Matches($codeLines[$i], '(?<![A-Za-z0-9_$.])([A-Za-z_$][\w$]*)\s*\(')
            foreach ($m in $callMatches) {
                $name = $m.Groups[1].Value
                if ($script:AihCallKeywordBlocklist -contains $name) { continue }
                if ($callCount -ge 400) { break }
                $callCount = $callCount + 1
                $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'call' -Name $name -Line ($i + 1) -Column ($m.Index + 1) -Resolution 'unresolved'))
            }
        }
    }

    # F05: same-file references for uniquely-named definitions (whole file: a
    # unique bare name may be referenced before or after its definition).
    # Resolution is conservative syntax-aware evidence only:
    #   * scanned over comment/string-stripped code lines;
    #   * import and definition lines never yield references;
    #   * call positions keep their unresolved call occurrence and are never
    #     also counted as resolved references;
    #   * lines inside containers whose parameter list shadows the name are
    #     skipped (scope-shadowing guard).
    $names = @{}
    foreach ($symbol in $symbols) {
        if (@('function', 'class', 'interface', 'enum', 'typeAlias', 'constant') -contains $symbol.kind) {
            if (-not $names.ContainsKey($symbol.name)) { $names[$symbol.name] = @() }
            $names[$symbol.name] = @($names[$symbol.name]) + @($symbol)
        }
    }
    if ($lines.Count -le 3000) {
        $codeLines = Get-AihCodeSyntaxStrippedLines -Lines $lines -Language 'tsjs'
        $definitionLineNumbers = Get-AihCodeDefinitionLineSet -Symbols $symbols
        $importLineNumbers = Get-AihCodeImportLineSet -Lines $lines -Language 'tsjs'
        $shadowRanges = Get-AihCodeParameterShadowRanges -Symbols $symbols
        foreach ($name in $names.Keys) {
            $definitions = @($names[$name])
            if ($definitions.Count -ne 1) { continue }   # ambiguous inside file: never resolve
            $definition = $definitions[0]
            $shadowList = @()
            if ($shadowRanges.ContainsKey($name)) { $shadowList = @($shadowRanges[$name]) }
            $refCount = 0
            for ($i = 0; $i -lt $lines.Count -and $refCount -lt 100; $i++) {
                $lineNo = $i + 1
                if ($lineNo -eq $definition.startLine) { continue }
                if ($importLineNumbers.ContainsKey($lineNo)) { continue }
                $inShadow = $false
                foreach ($range in $shadowList) {
                    if ($lineNo -ge [int]$range.start -and $lineNo -le [int]$range.end) { $inShadow = $true; break }
                }
                if ($inShadow) { continue }
                $matchesHere = [regex]::Matches($codeLines[$i], '(?<![A-Za-z0-9_$.])' + [regex]::Escape($name) + '(?![\w$])')
                foreach ($m in $matchesHere) {
                    if (Test-AihCodeCallPosition -Line $codeLines[$i] -Index $m.Index -Length $m.Length) { continue }   # calls stay unresolved
                    if ($refCount -ge 100) { break }
                    $refCount = $refCount + 1
                    $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'reference' -Name $name -Line $lineNo -Column ($m.Index + 1) -Resolution 'same-file-unique' -ResolvedTargetId $definition.sid))
                }
            }
        }
    }

    return [pscustomobject][ordered]@{
        status = 'ready'; symbols = $symbols; imports = $imports; exports = $exports
        occurrences = $occurrences; diagnostics = $diagnostics
    }
}

function Invoke-AihStructuralCSharp {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$FileIntelligenceId
    )
    $lines = Get-AihCodeLineArray -Content $Content
    $symbols = @()
    $imports = @()
    $exports = @()
    $occurrences = @()
    $diagnostics = @()
    $stack = @()
    $stackDepths = @()
    $depth = 0

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        $lineNo = $i + 1
        $trimmed = $line.Trim()
        while ($stack.Count -gt 0 -and $depth -lt [int]$stackDepths[$stack.Count - 1] -and $stackDepths[$stack.Count - 1] -gt 0) {
            $stack = @($stack | Select-Object -First ($stack.Count - 1))
            $stackDepths = @($stackDepths | Select-Object -First ($stackDepths.Count - 1))
        }

        if ($trimmed -match '^using\s+(?:static\s+)?([\w.]+)\s*;') {
            $imports = @($imports) + @([pscustomobject][ordered]@{ rawTarget = $Matches[1]; resolution = 'raw'; bindings = @(); line = $lineNo })
            $depth = $depth + ([regex]::Matches($line, '\{').Count) - ([regex]::Matches($line, '\}').Count)
            continue
        }

        $symKind = $null; $symName = $null
        if ($trimmed -match '^(?:[A-Za-z_][\w.<>\[\],\s*]*\s)?(namespace)\s+([\w.]+)') { $symKind = 'namespace'; $symName = $Matches[2] }
        elseif ($trimmed -match '(?:^|\s)(class|interface|struct|enum|record)\s+([A-Za-z_]\w*)') { $symKind = $Matches[1]; $symName = $Matches[2] }
        elseif ($stack.Count -gt 0 -and $trimmed -match '^(?:[\w<>\[\],.\s]+?\s)?([A-Za-z_]\w*)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:\{|where|=>)') {
            $candidate = $Matches[1]
            if ($script:AihCallKeywordBlocklist -notcontains $candidate) { $symKind = 'method'; $symName = $candidate }
        }
        elseif ($stack.Count -gt 0 -and $trimmed -match '^(?:[\w<>\[\],.\s]+?\s)?([A-Za-z_]\w*)\s*\{\s*(?:get|set)') { $symKind = 'property'; $symName = $Matches[1] }

        if ($null -ne $symKind) {
            $qualified = ConvertTo-AihQualifiedName -Stack $stack -Name $symName
            $endIdx = Find-AihBraceBlockEnd -Lines $lines -StartIndex0 $i
            $signature = ($trimmed -replace '\s+', ' ')
            $visibility = if ($trimmed -match '\b(public|internal|private|protected)\b') { $Matches[1] } else { '' }
            $symbols = @($symbols) + @((New-AihParsedSymbol -FileIntelligenceId $FileIntelligenceId -Kind $symKind -Name $symName -QualifiedName $qualified -Signature $signature -Container ($(if ($stack.Count -gt 0) { $stack[$stack.Count - 1] } else { '' })) -StartLine $lineNo -StartColumn ($line.IndexOf($symName) + 1) -EndLine ($endIdx + 1) -EndColumn $lines[$endIdx].Length -Visibility $visibility))
            $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'definition' -Name $symName -Line $lineNo -Column ($line.IndexOf($symName) + 1) -Resolution 'exact' -ResolvedTargetId $symbols[$symbols.Count - 1].sid))
            $stack = @($stack) + @($qualified)
            $stackDepths = @($stackDepths) + @($depth + ([regex]::Matches($line, '\{').Count))
        }

        $depth = $depth + ([regex]::Matches($line, '\{').Count) - ([regex]::Matches($line, '\}').Count)
    }
    return [pscustomobject][ordered]@{
        status = 'ready'; symbols = $symbols; imports = $imports; exports = $exports
        occurrences = $occurrences; diagnostics = $diagnostics
    }
}

function Invoke-AihStructuralPython {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$FileIntelligenceId,
        [Parameter(Mandatory = $true)][string]$ModuleName
    )
    $lines = Get-AihCodeLineArray -Content $Content
    $symbols = @()
    $imports = @()
    $exports = @()
    $occurrences = @()
    $diagnostics = @()
    # indent stack of @{ indent, qualified, endLineIndex }
    $open = @()
    $moduleSymbol = New-AihParsedSymbol -FileIntelligenceId $FileIntelligenceId -Kind 'module' -Name $ModuleName -QualifiedName $ModuleName -Signature ('module ' + $ModuleName) -Container '' -StartLine 1 -StartColumn 1 -EndLine $lines.Count -EndColumn 1
    $symbols = @($symbols) + @($moduleSymbol)
    $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'definition' -Name $ModuleName -Line 1 -Column 1 -Resolution 'exact' -ResolvedTargetId $moduleSymbol.sid))

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        $lineNo = $i + 1
        if ($line.Trim() -eq '' -or $line.Trim().StartsWith('#')) { continue }
        $indent = ($line.Length - $line.TrimStart().Length)
        $trimmed = $line.Trim()

        while ($open.Count -gt 0 -and $indent -le $open[$open.Count - 1].indent) {
            $closing = $open[$open.Count - 1]
            $closing.symbol.endLine = $i
            $open = @($open | Select-Object -First ($open.Count - 1))
        }

        if ($trimmed -match '^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)') {
            $kind = if ($open.Count -gt 0 -and $open[$open.Count - 1].kind -eq 'class') { 'method' } else { 'function' }
            $parent = if ($open.Count -gt 0) { $open[$open.Count - 1].qualified } else { '' }
            $qualified = ConvertTo-AihQualifiedName -Stack @($parent) -Name $Matches[1]
            $signature = ($trimmed -replace '\s+', ' ')
            $symbol = New-AihParsedSymbol -FileIntelligenceId $FileIntelligenceId -Kind $kind -Name $Matches[1] -QualifiedName $qualified -Signature $signature -Container $parent -StartLine $lineNo -StartColumn ($indent + 1) -EndLine $lineNo -EndColumn $line.Length
            $symbols = @($symbols) + @($symbol)
            $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'definition' -Name $Matches[1] -Line $lineNo -Column ($indent + 1) -Resolution 'exact' -ResolvedTargetId $symbol.sid))
            $open = @($open) + @(@{ indent = $indent; qualified = $qualified; kind = $kind; symbol = $symbol })
        }
        elseif ($trimmed -match '^class\s+([A-Za-z_]\w*)') {
            $parent = if ($open.Count -gt 0) { $open[$open.Count - 1].qualified } else { '' }
            $qualified = ConvertTo-AihQualifiedName -Stack @($parent) -Name $Matches[1]
            $signature = ($trimmed -replace '\s+', ' ')
            $symbol = New-AihParsedSymbol -FileIntelligenceId $FileIntelligenceId -Kind 'class' -Name $Matches[1] -QualifiedName $qualified -Signature $signature -Container $parent -StartLine $lineNo -StartColumn ($indent + 1) -EndLine $lineNo -EndColumn $line.Length
            $symbols = @($symbols) + @($symbol)
            $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'definition' -Name $Matches[1] -Line $lineNo -Column ($indent + 1) -Resolution 'exact' -ResolvedTargetId $symbol.sid))
            $open = @($open) + @(@{ indent = $indent; qualified = $qualified; kind = 'class'; symbol = $symbol })
        }
        elseif ($trimmed -match '^from\s+([\w.]+)\s+import\s+(.+)$') {
            $module = $Matches[1]
            $bindings = @()
            foreach ($part in ($Matches[2] -split ',')) {
                $name = $part.Trim()
                if ($name -match '^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$') { $bindings = @($bindings) + @($Matches[2]) }
                elseif ($name -match '^[A-Za-z_]\w*$') { $bindings = @($bindings) + @($name) }
            }
            $imports = @($imports) + @([pscustomobject][ordered]@{ rawTarget = $module; resolution = 'raw'; bindings = @($bindings); line = $lineNo })
            foreach ($binding in $bindings) {
                $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'import' -Name $binding -Line $lineNo -Column 1 -Resolution 'name-binding'))
            }
        }
        elseif ($trimmed -match '^import\s+([\w.,\s]+)$') {
            foreach ($part in ($Matches[1] -split ',')) {
                $name = $part.Trim()
                if ($name -match '^([A-Za-z_][\w.]*)\s+as\s+([A-Za-z_]\w*)$') {
                    $imports = @($imports) + @([pscustomobject][ordered]@{ rawTarget = $Matches[1]; resolution = 'raw'; bindings = @($Matches[2]); line = $lineNo })
                } elseif ($name -match '^[\w.]+$') {
                    $imports = @($imports) + @([pscustomobject][ordered]@{ rawTarget = $name; resolution = 'raw'; bindings = @(); line = $lineNo })
                }
            }
        }
    }
    foreach ($entry in $open) { $entry.symbol.endLine = $lines.Count }

    # F05: same-file references for unique def/class/method names (whole
    # file), conservative syntax-aware evidence only: comment/string-stripped
    # code, definition/import lines excluded, parameter-shadowed ranges
    # excluded, and call positions emitted as honest unresolved call
    # occurrences instead of resolved references.
    $names = @{}
    foreach ($symbol in $symbols) {
        if (@('function', 'class', 'method') -contains $symbol.kind) {
            if (-not $names.ContainsKey($symbol.name)) { $names[$symbol.name] = @() }
            $names[$symbol.name] = @($names[$symbol.name]) + @($symbol)
        }
    }
    if ($lines.Count -le 3000) {
        $codeLines = Get-AihCodeSyntaxStrippedLines -Lines $lines -Language 'python'
        $definitionLineNumbers = Get-AihCodeDefinitionLineSet -Symbols $symbols
        $importLineNumbers = Get-AihCodeImportLineSet -Lines $lines -Language 'python'
        $shadowRanges = Get-AihCodeParameterShadowRanges -Symbols $symbols
        foreach ($name in $names.Keys) {
            $definitions = @($names[$name])
            if ($definitions.Count -ne 1) { continue }
            $definition = $definitions[0]
            $shadowList = @()
            if ($shadowRanges.ContainsKey($name)) { $shadowList = @($shadowRanges[$name]) }
            $refCount = 0
            for ($i = 0; $i -lt $lines.Count -and $refCount -lt 100; $i++) {
                $lineNo = $i + 1
                if ($lineNo -eq $definition.startLine) { continue }
                if ($importLineNumbers.ContainsKey($lineNo)) { continue }
                $inShadow = $false
                foreach ($range in $shadowList) {
                    if ($lineNo -ge [int]$range.start -and $lineNo -le [int]$range.end) { $inShadow = $true; break }
                }
                if ($inShadow) { continue }
                $matchesHere = [regex]::Matches($codeLines[$i], '(?<![A-Za-z0-9_$.])' + [regex]::Escape($name) + '(?![\w$])')
                foreach ($m in $matchesHere) {
                    if ($refCount -ge 100) { break }
                    $refCount = $refCount + 1
                    if (Test-AihCodeCallPosition -Line $codeLines[$i] -Index $m.Index -Length $m.Length) {
                        $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'call' -Name $name -Line $lineNo -Column ($m.Index + 1) -Resolution 'unresolved'))
                        continue
                    }
                    $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'reference' -Name $name -Line $lineNo -Column ($m.Index + 1) -Resolution 'same-file-unique' -ResolvedTargetId $definition.sid))
                }
            }
        }
    }
    return [pscustomobject][ordered]@{
        status = 'ready'; symbols = $symbols; imports = $imports; exports = $exports
        occurrences = $occurrences; diagnostics = $diagnostics
    }
}

function Invoke-AihStructuralPowerShell {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$FileIntelligenceId
    )
    $lines = Get-AihCodeLineArray -Content $Content
    $symbols = @()
    $imports = @()
    $exports = @()
    $occurrences = @()
    $diagnostics = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        $lineNo = $i + 1
        if ($line -match '^\s*(?:function|filter|workflow)\s+([A-Za-z_][\w.-]*)\s*(\(|\{)') {
            $kind = if ($Matches[2] -eq '(') { 'function' } else { 'function' }
            $endIdx = Find-AihBraceBlockEnd -Lines $lines -StartIndex0 $i
            $signature = ($line.Trim() -replace '\s+', ' ')
            $symbol = New-AihParsedSymbol -FileIntelligenceId $FileIntelligenceId -Kind $kind -Name $Matches[1] -QualifiedName $Matches[1] -Signature $signature -Container '' -StartLine $lineNo -StartColumn ($line.IndexOf($Matches[1]) + 1) -EndLine ($endIdx + 1) -EndColumn $lines[$endIdx].Length
            $symbols = @($symbols) + @($symbol)
            $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'definition' -Name $Matches[1] -Line $lineNo -Column ($line.IndexOf($Matches[1]) + 1) -Resolution 'exact' -ResolvedTargetId $symbol.sid))
        }
    }
    # F05: same-file references for uniquely-named functions (whole file
    # scan) over comment/string-stripped code; definition lines never yield
    # references. PowerShell bare-name command invocation of a unique
    # same-file function remains same-file resolvable evidence; parameters
    # are $-prefixed and cannot shadow a Verb-Noun function name.
    if ($lines.Count -le 3000) {
        $codeLines = Get-AihCodeSyntaxStrippedLines -Lines $lines -Language 'powershell'
        $names = @{}
        foreach ($symbol in $symbols) {
            if (-not $names.ContainsKey($symbol.name)) { $names[$symbol.name] = @() }
            $names[$symbol.name] = @($names[$symbol.name]) + @($symbol)
        }
        foreach ($name in $names.Keys) {
            $definitions = @($names[$name])
            if ($definitions.Count -ne 1) { continue }
            $definition = $definitions[0]
            $refCount = 0
            for ($i = 0; $i -lt $lines.Count -and $refCount -lt 100; $i++) {
                $lineNo = $i + 1
                if ($lineNo -eq $definition.startLine) { continue }
                $matchesHere = [regex]::Matches($codeLines[$i], '(?<![A-Za-z0-9_$.-])' + [regex]::Escape($name) + '(?![\w$-])')
                foreach ($m in $matchesHere) {
                    if ($refCount -ge 100) { break }
                    $refCount = $refCount + 1
                    $occurrences = @($occurrences) + @((New-AihParsedOccurrence -FileIntelligenceId $FileIntelligenceId -Role 'reference' -Name $name -Line $lineNo -Column ($m.Index + 1) -Resolution 'same-file-unique' -ResolvedTargetId $definition.sid))
                }
            }
        }
    }
    return [pscustomobject][ordered]@{
        status = 'ready'; symbols = $symbols; imports = $imports; exports = $exports
        occurrences = $occurrences; diagnostics = $diagnostics
    }
}

# ── provider registry ───────────────────────────────────────────────────────

function New-AihCodeIntelligenceProvider {
    param(
        [Parameter(Mandatory = $true)][string]$ProviderId,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string[]]$Languages,
        [Parameter(Mandatory = $true)][string[]]$Capabilities,
        [Parameter(Mandatory = $true)][scriptblock]$Analyze
    )
    return [pscustomobject][ordered]@{
        providerId   = $ProviderId
        version      = $Version
        languages    = @($Languages)
        capabilities = @($Capabilities)
        canHandle    = { param($language) return (@($Languages) -contains $language) }.GetNewClosure()
        analyze      = $Analyze
    }
}

function Get-AihCodeIntelligenceProviders {
    # Priority order: first match wins. Deterministic structural fallback
    # providers ship in-process; semantic providers can be registered ahead.
    if ($null -eq $script:AihCodeIntelligenceProviders) {
        $script:AihCodeIntelligenceProviders = @(
            (New-AihCodeIntelligenceProvider -ProviderId 'structural-ts' -Version '1.0.0' -Languages @('typescript', 'javascript') -Capabilities @('syntax', 'symbols', 'definitions', 'references', 'imports', 'exports', 'occurrences') -Analyze { param($content, $language, $fileIntelligenceId, $moduleName) Invoke-AihStructuralTsJs -Content $content -FileIntelligenceId $fileIntelligenceId }),
            (New-AihCodeIntelligenceProvider -ProviderId 'structural-csharp' -Version '1.0.0' -Languages @('csharp') -Capabilities @('syntax', 'symbols', 'definitions', 'references', 'imports', 'occurrences') -Analyze { param($content, $language, $fileIntelligenceId, $moduleName) Invoke-AihStructuralCSharp -Content $content -FileIntelligenceId $fileIntelligenceId }),
            (New-AihCodeIntelligenceProvider -ProviderId 'structural-python' -Version '1.0.0' -Languages @('python') -Capabilities @('syntax', 'symbols', 'definitions', 'references', 'imports', 'occurrences') -Analyze { param($content, $language, $fileIntelligenceId, $moduleName) Invoke-AihStructuralPython -Content $content -FileIntelligenceId $fileIntelligenceId -ModuleName $moduleName }),
            (New-AihCodeIntelligenceProvider -ProviderId 'structural-powershell' -Version '1.0.0' -Languages @('powershell') -Capabilities @('syntax', 'symbols', 'definitions', 'references', 'occurrences') -Analyze { param($content, $language, $fileIntelligenceId, $moduleName) Invoke-AihStructuralPowerShell -Content $content -FileIntelligenceId $fileIntelligenceId })
        )
    }
    return $script:AihCodeIntelligenceProviders
}

function Register-AihCodeIntelligenceProvider {
    # Prepends a provider (higher priority than the built-in fallbacks).
    param([Parameter(Mandatory = $true)]$Provider)
    $null = Get-AihCodeIntelligenceProviders
    $script:AihCodeIntelligenceProviders = @($Provider) + @($script:AihCodeIntelligenceProviders)
}

function Set-AihCodeIntelligenceProviders {
    param([Parameter(Mandatory = $true)]$Providers)
    $script:AihCodeIntelligenceProviders = @($Providers)
}

function Get-AihProviderCapabilityMatrix {
    # Returns the capability matrix for documentation/diagnostics.
    # languages and capabilities stay arrays for machine consumption.
    $rows = @()
    foreach ($provider in (Get-AihCodeIntelligenceProviders)) {
        $rows = @($rows) + @([pscustomobject][ordered]@{
            providerId = $provider.providerId; version = $provider.version
            languages = @($provider.languages)
            capabilities = @($provider.capabilities)
        })
    }
    return $rows
}
