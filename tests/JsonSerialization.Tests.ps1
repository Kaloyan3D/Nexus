[CmdletBinding()]param([string]$InstallRoot)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
if ([string]::IsNullOrWhiteSpace($InstallRoot)){$InstallRoot=Split-Path -Parent $PSScriptRoot}
. (Join-Path $InstallRoot 'scripts\Common.ps1')
$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
function Convert-AihContractJson($Value){if($null-eq$Value){return 'null'};ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe $Value) -Depth 20 -Compress}
function Assert-NoDictionaryLeak([string]$Json,[string]$Name){Assert-Aih ($Json-notmatch'"(Count|Keys|Values|SyncRoot)"\s*:') $Name}
$root=Join-Path ([IO.Path]::GetTempPath()) ('aih-json-contract-'+[guid]::NewGuid().ToString('N'))
try{
 New-Item -ItemType Directory -Path $root|Out-Null
 Assert-Aih ((Convert-AihContractJson $null)-eq'null') 'null serializes as JSON null'
 Assert-Aih ((Convert-AihContractJson $true)-eq'true') 'Boolean serializes as JSON Boolean'
 Assert-Aih ((Convert-AihContractJson 42)-eq'42') 'integer serializes as JSON number'
 Assert-Aih ([double]((Convert-AihContractJson 12.5)|ConvertFrom-Json)-eq12.5) 'floating value round-trips as JSON number'
 Assert-Aih ((Convert-AihContractJson 'ts-monorepo')-eq'"ts-monorepo"') 'ordinary System.String remains a JSON string'
 Assert-Aih ((Convert-AihContractJson '')-eq'""') 'empty string remains a JSON string'
 $wrapped=[PSObject]::AsPSObject('ts-monorepo');$wrappedJson=Convert-AihContractJson $wrapped
 Assert-Aih ($wrappedJson-eq'"ts-monorepo"') 'PSObject-wrapped string remains a JSON string under Windows PowerShell 5.1'
 Assert-Aih ($wrappedJson-ne'{"Length":11}') 'ts-monorepo never regresses to a Length object'
 $leaf=Split-Path -Leaf (Join-Path $root 'ts-monorepo')
 Assert-Aih ((Convert-AihContractJson $leaf)-eq'"ts-monorepo"') 'Split-Path -Leaf output remains a JSON string'
 $custom=[pscustomobject]@{name=$wrapped;empty='';enabled=$true};$customJson=Convert-AihContractJson $custom;$customRoundTrip=$customJson|ConvertFrom-Json
 Assert-Aih ($customRoundTrip.name-eq'ts-monorepo'-and$customRoundTrip.empty-eq''-and$customRoundTrip.enabled) 'nested PSCustomObject string values preserve their values'
 Assert-Aih ($customJson-notmatch'"Length"\s*:') 'nested wrapped strings do not expose Length'
 $ordered=[ordered]@{name=$wrapped;number=7;nested=[ordered]@{leaf=$leaf}};$orderedJson=Convert-AihContractJson $ordered;$orderedRoundTrip=$orderedJson|ConvertFrom-Json
 Assert-Aih ($orderedRoundTrip.name-eq'ts-monorepo'-and$orderedRoundTrip.nested.leaf-eq'ts-monorepo') 'OrderedDictionary serializes as the intended JSON object'
 Assert-Aih ($orderedJson.IndexOf('"name"')-lt$orderedJson.IndexOf('"number"')-and$orderedJson.IndexOf('"number"')-lt$orderedJson.IndexOf('"nested"')) 'OrderedDictionary preserves authored key order'
 Assert-NoDictionaryLeak $orderedJson 'OrderedDictionary emits no adapter/reflection properties'
 $hashtable=@{alpha='a';child=@{beta='b'}};$hashtableJson=Convert-AihContractJson $hashtable;$hashtableRoundTrip=$hashtableJson|ConvertFrom-Json
 Assert-Aih ($hashtableRoundTrip.alpha-eq'a'-and$hashtableRoundTrip.child.beta-eq'b') 'Hashtable serializes as the intended JSON object'
 Assert-NoDictionaryLeak $hashtableJson 'Hashtable emits no adapter/reflection properties'
 $array=@('first',$wrapped,3,$true,$null);$arrayRoundTrip=(Convert-AihContractJson $array)|ConvertFrom-Json
 Assert-Aih (@($arrayRoundTrip).Count-eq5) 'arrays preserve element count including null'
 Assert-Aih ($arrayRoundTrip[0]-eq'first'-and$arrayRoundTrip[1]-eq'ts-monorepo'-and$arrayRoundTrip[2]-eq3-and$arrayRoundTrip[3]-eq$true-and$null-eq$arrayRoundTrip[4]) 'arrays preserve string, wrapped string, number, Boolean, and null values'
 $objects=@([pscustomobject]@{id=1;name='one'},[ordered]@{id=2;name=$wrapped});$objectsJson=Convert-AihContractJson $objects;$objectsRoundTrip=$objectsJson|ConvertFrom-Json
 Assert-Aih (@($objectsRoundTrip).Count-eq2-and$objectsRoundTrip[1].name-eq'ts-monorepo') 'arrays of mixed object types preserve authored fields'
 Assert-NoDictionaryLeak $objectsJson 'nested array dictionaries emit no adapter/reflection properties'
 $nested=[ordered]@{items=@($custom,$ordered,@{entries=@('x',$wrapped)});meta=[pscustomobject]@{ok=$true}};$nestedJson=Convert-AihContractJson $nested;$nestedRoundTrip=$nestedJson|ConvertFrom-Json
 Assert-Aih ($nestedRoundTrip.items[0].name-eq'ts-monorepo'-and$nestedRoundTrip.items[2].entries[1]-eq'ts-monorepo') 'deep nested mixtures preserve wrapped string values'
 Assert-NoDictionaryLeak $nestedJson 'deep nested mixtures emit no dictionary implementation properties'
 $date=[DateTime]::SpecifyKind([DateTime]::Parse('2026-09-01T12:34:56'),[DateTimeKind]::Utc);$dateJson=Convert-AihContractJson $date
 Assert-Aih (-not[string]::IsNullOrWhiteSpace([string]$dateJson)-and$dateJson-notmatch'"(Ticks|Kind|Date)"\s*:') 'DateTime preserves the existing scalar writer behavior without reflection leakage'
 $atomicPath=Join-Path $root 'atomic.json';Write-AihAtomicJson -Path $atomicPath -Value $nested;$atomic=Get-Content -Raw -Encoding UTF8 -LiteralPath $atomicPath
 Assert-Aih (($atomic|ConvertFrom-Json).items[0].name-eq'ts-monorepo') 'Write-AihAtomicJson uses the safe serializer contract'
 Assert-NoDictionaryLeak $atomic 'Write-AihAtomicJson emits no dictionary implementation properties'
 $jsonlPath=Join-Path $root 'events.jsonl';Add-AihJsonLine -Path $jsonlPath -Value ([ordered]@{name=$wrapped;data=$hashtable});$jsonl=Get-Content -Raw -Encoding UTF8 -LiteralPath $jsonlPath
 Assert-Aih (($jsonl.Trim()|ConvertFrom-Json).name-eq'ts-monorepo') 'Add-AihJsonLine uses the safe serializer contract'
 Assert-NoDictionaryLeak $jsonl 'Add-AihJsonLine emits no dictionary implementation properties'
 $nullAtomicPath=Join-Path $root 'null.json';Write-AihAtomicJson -Path $nullAtomicPath -Value $null
 Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath $nullAtomicPath)-eq'null') 'Write-AihAtomicJson emits explicit JSON null'
 $nullLinePath=Join-Path $root 'null.jsonl';Add-AihJsonLine -Path $nullLinePath -Value $null
 Assert-Aih ((Get-Content -Raw -Encoding UTF8 -LiteralPath $nullLinePath).Trim()-eq'null') 'Add-AihJsonLine emits explicit JSON null'
 Assert-Aih ($PSVersionTable.PSVersion.Major-eq5) 'serializer regression executes under Windows PowerShell 5.1'
}finally{if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}}
Write-Host "RESULT: $passed JSON serializer contract assertions passed."
