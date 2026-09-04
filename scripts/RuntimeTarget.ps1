Set-StrictMode -Version Latest

function Get-AihRuntimeProperty {
    param($Object,[string]$Name)
    if($null-ne$Object-and$null-ne$Object.PSObject.Properties[$Name]){ return $Object.PSObject.Properties[$Name].Value }
    return $null
}

function Merge-AihRuntimeTarget {
    param([Collections.Specialized.OrderedDictionary]$Target,$Source)
    if($null-eq$Source){return}
    foreach($name in @('platform','deviceId','packageName','activity','deepLink')){
        $value=Get-AihRuntimeProperty $Source $name
        if($null-ne$value-and-not[string]::IsNullOrWhiteSpace([string]$value)){$Target[$name]=[string]$value}
    }
}

function Find-AihExpoAndroidPackage {
    param([Parameter(Mandatory=$true)][string]$Workspace)
    $root=[IO.Path]::GetFullPath($Workspace)
    $resolved=@()
    $jsonCandidates=@(Get-ChildItem -LiteralPath $root -Filter 'app.json' -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object{$_.FullName-notmatch'[\\/](node_modules|\.git|\.ai-harness|dist|build)[\\/]'} | Sort-Object FullName)
    foreach($file in $jsonCandidates){
        try{
            $doc=Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName|ConvertFrom-Json
            $expo=if($null-ne$doc.PSObject.Properties['expo']){$doc.expo}else{$doc}
            if($null-ne$expo-and$null-ne$expo.PSObject.Properties['android']-and$null-ne$expo.android.PSObject.Properties['package']){
                $package=[string]$expo.android.package
                if(-not[string]::IsNullOrWhiteSpace($package)){$resolved+=([pscustomobject]@{packageName=$package;source=$file.FullName})}
            }
        }catch{}
    }
    $configCandidates=@(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object{$_.Name-match'^app\.config\.(js|cjs|mjs|ts)$'-and$_.FullName-notmatch'[\\/](node_modules|\.git|\.ai-harness|dist|build)[\\/]'} | Sort-Object FullName)
    foreach($file in $configCandidates){
        $text=Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName
        $match=[regex]::Match($text,'(?s)android\s*:\s*\{.*?package\s*:\s*["''](?<package>[A-Za-z0-9._-]+)["'']')
        if($match.Success){$resolved+=([pscustomobject]@{packageName=$match.Groups['package'].Value;source=$file.FullName})}
    }
    $unique=@($resolved|Group-Object packageName|ForEach-Object{$_.Group|Select-Object -First 1})
    if($unique.Count-gt1){throw ('Multiple Expo Android packages were found ('+(@($unique.packageName)-join', ')+'); select one with .ai-harness/runtime-target.json.')}
    if($unique.Count-eq1){return $unique[0]}
    return $null
}

function Resolve-AihRuntimeTarget {
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,
        [Parameter(Mandatory=$true)]$Scenario,
        [string]$DeviceId,
        [string]$AdbPath
    )
    $target=[ordered]@{platform=if(Get-AihRuntimeProperty $Scenario 'platform'){[string](Get-AihRuntimeProperty $Scenario 'platform')}else{'android'};deviceId=$null;packageName=$null;activity=$null;deepLink=$null;source=$null}
    $configPath=Join-Path (Join-Path ([IO.Path]::GetFullPath($Workspace)) '.ai-harness') 'runtime-target.json'
    if(Test-Path -LiteralPath $configPath){
        $config=Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath|ConvertFrom-Json
        $selected=$config
        if($null-ne$config.PSObject.Properties['targets']){
            $wanted=[string](Get-AihRuntimeProperty $config 'defaultTarget')
            $scenarioId=[string](Get-AihRuntimeProperty $Scenario 'id')
            $selected=$config.targets|Where-Object{[string](Get-AihRuntimeProperty $_ 'id')-eq$scenarioId}|Select-Object -First 1
            if($null-eq$selected-and-not[string]::IsNullOrWhiteSpace($wanted)){$selected=$config.targets|Where-Object{[string](Get-AihRuntimeProperty $_ 'id')-eq$wanted}|Select-Object -First 1}
        }
        Merge-AihRuntimeTarget -Target $target -Source $selected
        $target.source=$configPath
    }
    if([string]::IsNullOrWhiteSpace([string]$target.packageName)-and[string]$target.platform-eq'android'){
        $expo=Find-AihExpoAndroidPackage -Workspace $Workspace
        if($null-ne$expo){$target.packageName=[string]$expo.packageName;$target.source=[string]$expo.source}
    }
    Merge-AihRuntimeTarget -Target $target -Source (Get-AihRuntimeProperty $Scenario 'runtimeTarget')
    if(-not[string]::IsNullOrWhiteSpace($DeviceId)){$target.deviceId=$DeviceId}
    if([string]$target.platform-eq'android'-and[string]::IsNullOrWhiteSpace([string]$target.deviceId)){
        $adb=$AdbPath
        if([string]::IsNullOrWhiteSpace($adb)){
            $command=Get-Command adb.exe -ErrorAction SilentlyContinue
            if($null-eq$command){$command=Get-Command adb -ErrorAction SilentlyContinue}
            if($null-eq$command){throw 'adb was not found and the Android runtime target has no deviceId.'}
            $adb=$command.Source
        }
        if(-not(Test-Path -LiteralPath $adb -PathType Leaf)){throw ('adb executable does not exist: '+$adb)}
        $devicesText=(& $adb devices 2>&1|ForEach-Object{[string]$_})-join[Environment]::NewLine
        $devices=@($devicesText-split'\r?\n'|Where-Object{$_-match'^\S+\s+device\s*$'}|ForEach-Object{($_-split'\s+')[0]})
        if($devices.Count-ne1){throw ('Android runtime target requires exactly one device or an explicit deviceId; detected '+$devices.Count+'.')}
        $target.deviceId=$devices[0]
    }
    if([string]$target.platform-eq'android'-and[string]::IsNullOrWhiteSpace([string]$target.packageName)){throw 'Android viewport capture requires a packageName; set expo.android.package or .ai-harness/runtime-target.json.'}
    return [pscustomobject]$target
}
