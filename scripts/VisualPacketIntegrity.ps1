Set-StrictMode -Version Latest

function Get-AihVisualSha256 {
    param([Parameter(Mandatory=$true)][string]$Path)
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path)))-replace'-','').ToLowerInvariant()}finally{$sha.Dispose()}
}

function Get-AihVisualPacketFileName {
    param(
        [Parameter(Mandatory=$true)][ValidateSet('subject','reference')][string]$Role,
        [Parameter(Mandatory=$true)][int]$SourceIteration,
        [Parameter(Mandatory=$true)][int]$Ordinal,
        [Parameter(Mandatory=$true)][string]$SourcePath,
        [Parameter(Mandatory=$true)][string]$ExpectedSha256
    )
    $stem=[IO.Path]::GetFileNameWithoutExtension($SourcePath)-replace'[^A-Za-z0-9._-]','-'
    if([string]::IsNullOrWhiteSpace($stem)){$stem='image'}
    $extension=[IO.Path]::GetExtension($SourcePath).ToLowerInvariant()
    # Filename construction must remain total even for malformed declared
    # hashes so the integrity gate can return its structured fail-closed error.
    $hashToken=($ExpectedSha256.ToLowerInvariant()-replace'[^0-9a-f]','')
    if($hashToken.Length-lt12){$hashToken=$hashToken.PadRight(12,'0')}
    $hashToken=$hashToken.Substring(0,12)
    return ('{0}-iteration-{1:D2}-{2:D2}-{3}-{4}{5}'-f$Role,$SourceIteration,$Ordinal,$stem,$hashToken,$extension)
}

function Copy-AihVisualPacketImage {
    param(
        [Parameter(Mandatory=$true)][string]$SourcePath,
        [Parameter(Mandatory=$true)][string]$DestinationDirectory,
        [Parameter(Mandatory=$true)][ValidateSet('subject','reference')][string]$Role,
        [Parameter(Mandatory=$true)][int]$SourceIteration,
        [Parameter(Mandatory=$true)][int]$Ordinal,
        [Parameter(Mandatory=$true)][string]$ExpectedSha256,
        [string]$OriginalSourcePath
    )
    $sourceFull=[IO.Path]::GetFullPath($SourcePath)
    $expected=$ExpectedSha256.Trim().ToLowerInvariant()
    $fileName=Get-AihVisualPacketFileName -Role $Role -SourceIteration $SourceIteration -Ordinal $Ordinal -SourcePath $sourceFull -ExpectedSha256 $expected
    $destination=Join-Path ([IO.Path]::GetFullPath($DestinationDirectory)) $fileName
    if(-not(Test-Path -LiteralPath $destination)){Copy-Item -LiteralPath $sourceFull -Destination $destination}
    $actual=Get-AihVisualSha256 -Path $destination
    return [pscustomobject][ordered]@{
        role=$Role
        sourceIteration=$SourceIteration
        originalPath=if([string]::IsNullOrWhiteSpace($OriginalSourcePath)){$sourceFull}else{[IO.Path]::GetFullPath($OriginalSourcePath)}
        sourcePath=$sourceFull
        fileName=$fileName
        storedPath=$destination
        expectedSha256=$expected
        actualMaterializedSha256=$actual
        sha256=$actual
        bytes=(Get-Item -LiteralPath $destination).Length
        mediaType=$null
    }
}

function Test-AihVisualPacketIntegrity {
    param([Parameter(Mandatory=$true)]$Images,[Parameter(Mandatory=$true)][string]$PacketDirectory)
    $records=@($Images)
    $violations=[Collections.Generic.List[string]]::new()
    $packetRoot=[IO.Path]::GetFullPath($PacketDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
    $seenNames=@{}
    $seenIntent=@{}
    for($index=0;$index-lt$records.Count;$index++){
        $image=$records[$index];$label='image '+($index+1)
        $role=[string]$image.role
        if(@('subject','reference')-notcontains$role){$violations.Add($label+' has invalid role '+$role)}
        $sourceIteration=-1
        try{$sourceIteration=[int]$image.sourceIteration}catch{}
        if($sourceIteration-lt0){$violations.Add($label+' has invalid source iteration')}
        $originalPath=[string]$image.originalPath
        if([string]::IsNullOrWhiteSpace($originalPath)){$violations.Add($label+' has no original source path')}
        $fileName=[string]$image.fileName
        $nameKey=$fileName.ToLowerInvariant()
        if($seenNames.ContainsKey($nameKey)){$violations.Add('duplicate packet-local filename: '+$fileName)}else{$seenNames[$nameKey]=$true}
        $intentKey=($role+'|'+$sourceIteration+'|'+$originalPath).ToLowerInvariant()
        if($seenIntent.ContainsKey($intentKey)){$violations.Add('duplicate intended image entry: '+$role+' iteration '+$sourceIteration+' '+$originalPath)}else{$seenIntent[$intentKey]=$true}
        $storedPath=[string]$image.storedPath
        if(-not(Test-Path -LiteralPath $storedPath -PathType Leaf)){$violations.Add($label+' packet file does not exist: '+$storedPath);continue}
        $storedFull=[IO.Path]::GetFullPath($storedPath)
        if(-not[string]::Equals((Split-Path -Parent $storedFull),$packetRoot,[StringComparison]::OrdinalIgnoreCase)){$violations.Add($label+' is not packet-local: '+$storedFull)}
        if(-not[string]::Equals([IO.Path]::GetFileName($storedFull),$fileName,[StringComparison]::OrdinalIgnoreCase)){$violations.Add($label+' filename does not match its stored path')}
        $expected=[string]$image.expectedSha256;$declaredActual=[string]$image.actualMaterializedSha256
        $actual=Get-AihVisualSha256 -Path $storedFull
        if($expected-notmatch'^[0-9a-f]{64}$'){$violations.Add($label+' has invalid expected SHA')}
        if($declaredActual-notmatch'^[0-9a-f]{64}$'){$violations.Add($label+' has invalid actual materialized SHA')}
        if($expected-ne$actual){$violations.Add($label+' expected SHA '+$expected+' does not equal actual packet-file SHA '+$actual)}
        if($declaredActual-ne$actual){$violations.Add($label+' declared actual SHA '+$declaredActual+' does not equal recomputed packet-file SHA '+$actual)}
    }
    return [pscustomobject][ordered]@{valid=($violations.Count-eq0);violations=@($violations);imageCount=$records.Count;validatedAtUtc=[DateTime]::UtcNow.ToString('o')}
}
