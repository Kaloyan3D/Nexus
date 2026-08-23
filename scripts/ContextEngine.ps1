Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Project.ps1')
. (Join-Path $PSScriptRoot 'TaskController.ps1')

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

function New-AihRepositoryMap {
    param([string]$Workspace, [int]$MaxFiles = 1000)
    $workspacePath = [IO.Path]::GetFullPath($Workspace)
    $files = @(Get-AihWorkspaceFiles $workspacePath | Where-Object { $_ -notmatch '^(?i)\.ai-harness[\\/](state|runs)[\\/]' } | Select-Object -First $MaxFiles)
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

function Search-AihCode {
    param([string]$Workspace,[Parameter(Mandatory=$true)][string]$Query,[int]$MaxResults=20)
    $terms=@($Query.ToLowerInvariant() -split '\W+' | Where-Object Length -gt 1 | Select-Object -Unique)
    $workspacePath=[IO.Path]::GetFullPath($Workspace)
    $files=@(Get-AihWorkspaceFiles $workspacePath | Where-Object { $_ -notmatch '^(?i)\.ai-harness[\\/](state|runs)[\\/]' })
    $ranked=[Collections.Generic.List[object]]::new()
    foreach($file in $files){
        $path=Join-Path $workspacePath $file
        if((Get-Item -LiteralPath $path).Length -gt 1048576){continue}
        $text=Get-Content -Raw -LiteralPath $path -ErrorAction SilentlyContinue
        if($null -eq $text){continue}
        $lower=$text.ToLowerInvariant(); $score=0
        foreach($term in $terms){ $score += ([regex]::Matches($lower,[regex]::Escape($term))).Count }
        if($score -gt 0){
            $snippet=($text -split '\r?\n' | Where-Object { $line=$_; @($terms | Where-Object { $line -match [regex]::Escape($_) }).Count } | Select-Object -First 3) -join "`n"
            $ranked.Add([pscustomobject]@{file=$file.Replace('\','/');score=$score;snippet=$snippet})
        }
    }
    @($ranked | Sort-Object @{Expression='score';Descending=$true}, @{Expression='file';Descending=$false} | Select-Object -First $MaxResults)
}

function New-AihContextBundle {
    param([string]$Workspace,[string]$TaskId,[string]$Task,[string[]]$AcceptanceCriteria=@(),[int]$MaxContextTokens=12000,[int]$MaxFiles=12)
    if($MaxContextTokens -lt 500){throw 'Context budget must be at least 500 tokens.'}
    $layout=Initialize-AihTaskLedger $Workspace
    $repoMap=New-AihRepositoryMap $Workspace
    $ranked=@(Search-AihCode $Workspace ($Task+' '+($AcceptanceCriteria -join ' ')) ($MaxFiles*2))
    $budgetChars=$MaxContextTokens*4; $used=0; $slices=[Collections.Generic.List[object]]::new()
    foreach($match in $ranked){
        if($slices.Count -ge $MaxFiles){break}
        $path=Join-Path $layout.Workspace $match.file
        $content=[string](Get-Content -Raw -LiteralPath $path)
        $remaining=$budgetChars-$used
        if($remaining -le 0){break}
        $slice=if($content.Length -gt $remaining){$content.Substring(0,$remaining)}else{$content}
        $slices.Add([pscustomobject]@{path=$match.file;score=$match.score;content=$slice;truncated=$slice.Length -lt $content.Length})
        $used += $slice.Length
    }
    $docs=[Collections.Generic.List[object]]::new()
    foreach($name in @('project.md','architecture.md','conventions.md')){
        $path=Join-Path $layout.Root $name
        if(Test-Path -LiteralPath $path){$content=Get-Content -Raw -LiteralPath $path; if($used+$content.Length -le $budgetChars){$docs.Add([pscustomobject]@{path=".ai-harness/$name";content=$content});$used+=$content.Length}}
    }
    $git=[ordered]@{baseCommit=$null;changedFiles=@();diffStat=''}
    try{$git.baseCommit=(& git -C $layout.Workspace rev-parse HEAD 2>$null|Select-Object -First 1).Trim();$git.changedFiles=@(& git -C $layout.Workspace status --short 2>$null);$git.diffStat=(& git -C $layout.Workspace diff --stat 2>$null|Out-String).Trim()}catch{}
    $symbolCount=0;foreach($entry in @($repoMap.files)){$symbolCount+=@($entry.symbols).Count}
    $manifest=[ordered]@{schemaVersion=1;taskId=$TaskId;budget=[ordered]@{maxContextTokens=$MaxContextTokens;estimatedTokens=[Math]::Ceiling($used/4);maxFiles=$MaxFiles};repositoryMap=[ordered]@{fileCount=@($repoMap.files).Count;symbolCount=$symbolCount;fullRepositoryIncluded=$false};files=@($slices|ForEach-Object{$_.path});documents=@($docs|ForEach-Object{$_.path});git=$git;generatedAtUtc=[DateTime]::UtcNow.ToString('o')}
    if(-not [string]::IsNullOrWhiteSpace($TaskId)){Write-AihAtomicJson (Join-Path (Join-Path $layout.Runs $TaskId) 'context-manifest.json') $manifest}
    [pscustomobject]@{task=$Task;acceptanceCriteria=@($AcceptanceCriteria);repositoryMap=$repoMap;fileSlices=@($slices);documents=@($docs);git=$git;manifest=[pscustomobject]$manifest}
}
