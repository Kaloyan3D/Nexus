[CmdletBinding()]param([string]$InstallRoot='C:\AI-Harness')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw ('FAIL: '+$Name)};$script:passed++;Write-Host ('PASS: '+$Name)}

. (Join-Path $InstallRoot 'scripts\VisualPacketIntegrity.ps1')
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('aih-packet-integrity-'+[guid]::NewGuid().ToString('N'))
try{
    $subjectDir=Join-Path $fixture 'iteration-02'
    $referenceDirA=Join-Path $fixture 'iteration-01'
    $referenceDirB=Join-Path $fixture 'other\iteration-01'
    $packetDir=Join-Path $fixture 'packet'
    New-Item -ItemType Directory -Path $subjectDir,$referenceDirA,$referenceDirB,$packetDir -Force|Out-Null
    $subject=Join-Path $subjectDir 'home.png';$referenceA=Join-Path $referenceDirA 'home.png';$referenceB=Join-Path $referenceDirB 'home.png'
    [IO.File]::WriteAllBytes($subject,[byte[]](1,2,3,4,5,6,7,8,9))
    [IO.File]::WriteAllBytes($referenceA,[byte[]](9,8,7,6,5,4,3,2,1))
    [IO.File]::WriteAllBytes($referenceB,[byte[]](5,5,5,5,4,4,4,4))
    $subjectSha=Get-AihVisualSha256 $subject;$referenceShaA=Get-AihVisualSha256 $referenceA;$referenceShaB=Get-AihVisualSha256 $referenceB

    $records=@(
        Copy-AihVisualPacketImage -SourcePath $subject -DestinationDirectory $packetDir -Role subject -SourceIteration 2 -Ordinal 1 -ExpectedSha256 $subjectSha
        Copy-AihVisualPacketImage -SourcePath $referenceA -DestinationDirectory $packetDir -Role reference -SourceIteration 1 -Ordinal 1 -ExpectedSha256 $referenceShaA
        Copy-AihVisualPacketImage -SourcePath $referenceB -DestinationDirectory $packetDir -Role reference -SourceIteration 1 -Ordinal 2 -ExpectedSha256 $referenceShaB
    )
    Assert-Aih ($records[0].fileName-ne$records[1].fileName) 'subject and reference with the same basename receive unique packet names'
    Assert-Aih (@($records.fileName|Select-Object -Unique).Count-eq3) 'packet-local filenames are globally unique, including multiple references'
    Assert-Aih ((Get-AihVisualSha256 $records[0].storedPath)-eq$subjectSha) 'reference materialization cannot overwrite the subject'
    Assert-Aih ((Get-AihVisualSha256 $records[1].storedPath)-eq$referenceShaA-and(Get-AihVisualSha256 $records[2].storedPath)-eq$referenceShaB) 'multiple references remain byte-identical and cannot overwrite each other'
    Assert-Aih ($records[0].expectedSha256-eq$subjectSha-and$records[0].actualMaterializedSha256-eq$subjectSha-and$records[0].sourceIteration-eq2-and$records[0].role-eq'subject') 'materialized record preserves role, iteration, expected SHA, and actual SHA'
    $valid=Test-AihVisualPacketIntegrity -Images $records -PacketDirectory $packetDir
    Assert-Aih ([bool]$valid.valid) 'final packet-wide integrity validation accepts independent byte-identical images'

    $badShaRecord=Copy-AihVisualPacketImage -SourcePath $subject -DestinationDirectory $packetDir -Role subject -SourceIteration 3 -Ordinal 1 -ExpectedSha256 ('0'*64)
    $badSha=Test-AihVisualPacketIntegrity -Images @($badShaRecord) -PacketDirectory $packetDir
    Assert-Aih (-not[bool]$badSha.valid-and@($badSha.violations|Where-Object{$_-match'expected SHA.*actual'}).Count-ge1) 'expected SHA mismatch fails packet integrity'

    $collisionRecords=@($records[0].PSObject.Copy(),$records[1].PSObject.Copy())
    $collisionRecords[1].fileName=$collisionRecords[0].fileName;$collisionRecords[1].storedPath=$collisionRecords[0].storedPath
    $collision=Test-AihVisualPacketIntegrity -Images $collisionRecords -PacketDirectory $packetDir
    Assert-Aih (-not[bool]$collision.valid-and@($collision.violations|Where-Object{$_-match'duplicate packet-local filename'}).Count-ge1) 'filename collision fails packet integrity'

    $duplicateIntent=@($records[0].PSObject.Copy(),$records[0].PSObject.Copy())
    $duplicateIntent[1].fileName='different-name.png';$duplicateIntent[1].storedPath=Join-Path $packetDir 'different-name.png';Copy-Item $records[0].storedPath $duplicateIntent[1].storedPath
    $duplicate=Test-AihVisualPacketIntegrity -Images $duplicateIntent -PacketDirectory $packetDir
    Assert-Aih (-not[bool]$duplicate.valid-and@($duplicate.violations|Where-Object{$_-match'duplicate intended image entry'}).Count-ge1) 'duplicate intended image entry fails packet integrity'

    [IO.File]::WriteAllBytes([string]$records[0].storedPath,[byte[]](42,43,44,45))
    $tampered=Test-AihVisualPacketIntegrity -Images $records -PacketDirectory $packetDir
    Assert-Aih (-not[bool]$tampered.valid-and@($tampered.violations|Where-Object{$_-match'declared actual SHA.*recomputed'}).Count-ge1) 'packet-wide recheck detects bytes corrupted after materialization'

    Write-Host ('RESULT: '+$script:passed+' visual packet-integrity assertions passed.')
}finally{
    if(Test-Path $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
}
