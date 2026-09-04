Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

function New-AihOutputDigest {
    param([string]$Workspace,[string]$TaskId,[ValidateSet('test','build','typecheck','lint','git','search','other')][string]$Kind,[AllowEmptyString()][string]$RawOutput,[int]$ExitCode=0,[int]$MaxCharacters=6000)
    $root=Join-Path ([IO.Path]::GetFullPath($Workspace)) '.ai-harness/runs'
    $artifactDir=Join-Path (Join-Path $root $TaskId) 'artifacts'
    New-Item -ItemType Directory -Force -Path $artifactDir|Out-Null
    $artifactId='output-'+[guid]::NewGuid().ToString('N')
    $rawPath=Join-Path $artifactDir ($artifactId+'.log')
    Write-AihAtomicText $rawPath $RawOutput
    $lines=@($RawOutput -split '\r?\n');$important=@($lines|Where-Object{$_ -match '(?i)(fail|error|exception|expected|actual|warning|TS\d{3,5}|at\s+.+:\d+|\b\d+ failed\b)' }|Select-Object -First 40)
    $summaryLines=[Collections.Generic.List[string]]::new();$summaryLines.Add(('{0} RESULT: {1}' -f $Kind.ToUpperInvariant(),$(if($ExitCode -eq 0){'PASS'}else{'FAIL'})))
    $summaryLines.Add("Exit code: $ExitCode");$summaryLines.Add("Raw lines: $($lines.Count)")
    if($important.Count){$summaryLines.Add('Relevant output:');foreach($line in $important){$summaryLines.Add($line)}}else{foreach($line in $lines|Select-Object -Last 20){$summaryLines.Add($line)}}
    $summary=$summaryLines -join "`n";if($summary.Length -gt $MaxCharacters){$summary=$summary.Substring(0,$MaxCharacters)+"`n[summary truncated]"}
    [pscustomobject]@{artifactId=$artifactId;kind=$Kind;status=if($ExitCode -eq 0){'PASS'}else{'FAIL'};exitCode=$ExitCode;summary=$summary;rawPath=$rawPath;rawCharacters=$RawOutput.Length;summaryCharacters=$summary.Length}
}
