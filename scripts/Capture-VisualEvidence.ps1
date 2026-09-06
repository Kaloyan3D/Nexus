[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$OutputPath,
 [string]$DeviceSerial,
 [Parameter(Mandatory=$true)][string]$PackageName,
 [string]$Activity,
 [string]$DeepLink,
 [string]$ScenarioId='current-screen',
 [int]$Iteration=0,
 [string]$AdbPath,
 [string]$DevicePath,
 [string]$InstallRoot,
 [switch]$KeepDeviceFile,
 [switch]$Force
)
# ── Phase V0/V1: Android-only visual evidence capture ──────────────────────
# Deterministic, binary-safe PNG capture from ONE connected Android device:
#   1. screencap writes the PNG ON THE DEVICE (no binary data ever travels
#      through a PowerShell text pipe);
#   2. adb pull transfers the device file to the deterministic artifact
#      location on the host;
#   3. the host verifies the PNG magic bytes and records size + sha256.
# Capture-VisualEvidence NEVER edits, encodes, or re-compresses the image and
# is the only V1 capture runtime (iOS/web/multi-platform are later phases).
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference='Stop'

function Write-AihCaptureFailure {
    param([string]$ErrorKind,[string]$Message)
    [ordered]@{ ok=$false; kind='visual-evidence-capture-failed'; errorKind=$ErrorKind; error=$Message; timestampUtc=[DateTime]::UtcNow.ToString('o') }|ConvertTo-Json -Depth 10
    exit 3
}

function Get-AihForegroundIdentity {
    param([string]$Adb,[string[]]$SerialArgument)
    $text=(& $Adb @SerialArgument shell dumpsys activity activities 2>&1|ForEach-Object{[string]$_})-join[Environment]::NewLine
    if($LASTEXITCODE-ne0){Write-AihCaptureFailure -ErrorKind 'adb-foreground-inspection-failed' -Message ('Unable to inspect the resumed Android activity: '+$text.Trim())}
    $match=[regex]::Match($text,'(?m)(?:mResumedActivity|topResumedActivity).*?(?<component>[A-Za-z0-9._$-]+/[A-Za-z0-9._$-]+)')
    if(-not$match.Success){return [pscustomobject]@{packageName=$null;activity=$null;raw=$text}}
    $component=$match.Groups['component'].Value
    return [pscustomobject]@{packageName=($component-split'/',2)[0];activity=$component;raw=$text}
}

# 1. resolve adb
$adb=$AdbPath
if([string]::IsNullOrWhiteSpace($adb)){
    $command=Get-Command 'adb.exe' -ErrorAction SilentlyContinue
    if($null-eq$command){$command=Get-Command 'adb' -ErrorAction SilentlyContinue}
    if($null-eq$command){Write-AihCaptureFailure -ErrorKind 'adb-unavailable' -Message 'adb was not found on PATH and no -AdbPath was supplied.'}
    $adb=$command.Source
}
if(-not(Test-Path -LiteralPath $adb -PathType Leaf)){
    Write-AihCaptureFailure -ErrorKind 'adb-unavailable' -Message "adb executable does not exist: $adb"
}

# 2. resolve exactly one target device (fail closed on ambiguity)
$serialArgument=@()
if(-not[string]::IsNullOrWhiteSpace($DeviceSerial)){$serialArgument=@('-s',$DeviceSerial)}
$devicesOutput=(& $adb devices 2>&1|ForEach-Object{[string]$_})-join [Environment]::NewLine
$deviceLines=@($devicesOutput -split '\r?\n'|Where-Object{$_-match'^\S+\s+device\s*$'})
if($deviceLines.Count-eq0){Write-AihCaptureFailure -ErrorKind 'adb-device-missing' -Message ("No Android device is in 'device' state. adb devices reported: "+$devicesOutput.Trim())}
if($deviceLines.Count-gt1-and[string]::IsNullOrWhiteSpace($DeviceSerial)){Write-AihCaptureFailure -ErrorKind 'adb-device-ambiguous' -Message ('Multiple Android devices are connected; pass -DeviceSerial explicitly. Detected: '+(@($deviceLines|ForEach-Object{($_-split '\s+')[0]})-join ', '))}
$resolvedSerial=if(-not[string]::IsNullOrWhiteSpace($DeviceSerial)){$DeviceSerial}else{($deviceLines[0]-split '\s+')[0]}

# The mutex is scoped to the resolved device. Every task/project targeting the
# same emulator therefore serializes foreground inspection, launch,
# re-verification, capture, and identity persistence as one critical section.
$lockBytes=[Text.Encoding]::UTF8.GetBytes($resolvedSerial)
$lockSha=[Security.Cryptography.SHA256]::Create()
try{$lockHash=([BitConverter]::ToString($lockSha.ComputeHash($lockBytes))-replace'-','').ToLowerInvariant()}finally{$lockSha.Dispose()}
$captureMutex=New-Object Threading.Mutex($false,('AIHarness.VisualCapture.'+$lockHash))
$lockHeld=$false
try{
    try{$lockHeld=$captureMutex.WaitOne([TimeSpan]::FromMinutes(2))}catch [Threading.AbandonedMutexException]{$lockHeld=$true}
    if(-not$lockHeld){Write-AihCaptureFailure -ErrorKind 'visual-capture-lock-timeout' -Message ('Timed out waiting for the capture lock for device '+$resolvedSerial+'.')}

    $foreground=Get-AihForegroundIdentity -Adb $adb -SerialArgument $serialArgument
    if([string]$foreground.packageName-ne$PackageName){
        if(-not[string]::IsNullOrWhiteSpace($Activity)){
            $component=if($Activity.Contains('/')){$Activity}else{$PackageName+'/'+$Activity}
            & $adb @serialArgument shell am start -W -n $component|Out-Null
        }elseif(-not[string]::IsNullOrWhiteSpace($DeepLink)){
            & $adb @serialArgument shell am start -W -a android.intent.action.VIEW -d $DeepLink -p $PackageName|Out-Null
        }else{
            & $adb @serialArgument shell monkey -p $PackageName -c android.intent.category.LAUNCHER 1|Out-Null
        }
        if($LASTEXITCODE-ne0){Write-AihCaptureFailure -ErrorKind 'visual-capture-target-launch-failed' -Message ('Failed to foreground expected package '+$PackageName+' on '+$resolvedSerial+'.')}
        $resumeDeadline=[DateTime]::UtcNow.AddSeconds(15)
        do{
            $foreground=Get-AihForegroundIdentity -Adb $adb -SerialArgument $serialArgument
            if([string]$foreground.packageName-eq$PackageName){break}
            if([DateTime]::UtcNow-lt$resumeDeadline){Start-Sleep -Milliseconds 250}
        }while([DateTime]::UtcNow-lt$resumeDeadline)
    }
    if([string]$foreground.packageName-ne$PackageName){
        Write-AihCaptureFailure -ErrorKind 'visual-capture-target-mismatch' -Message ('Expected package '+$PackageName+' on device '+$resolvedSerial+' but resumed package was '+[string]$foreground.packageName+'.')
    }

    # 3. deterministic device-side + host-side locations
    $deviceFile=if(-not[string]::IsNullOrWhiteSpace($DevicePath)){$DevicePath}else{"/sdcard/aih-visual-"+[guid]::NewGuid().ToString('N')+".png"}
    $outputFullPath=[IO.Path]::GetFullPath($OutputPath)
    $outputDirectory=Split-Path -Parent $outputFullPath
    if(-not(Test-Path -LiteralPath $outputDirectory)){New-Item -ItemType Directory -Force -Path $outputDirectory|Out-Null}
    if((Test-Path -LiteralPath $outputFullPath)-and-not$Force){Write-AihCaptureFailure -ErrorKind 'output-exists' -Message "Refusing to overwrite an existing capture artifact (use -Force): $outputFullPath"}

# 4. capture ON DEVICE, then pull (never a binary text pipe)
    & $adb @serialArgument shell screencap -p $deviceFile|Out-Null
    if($LASTEXITCODE-ne0){Write-AihCaptureFailure -ErrorKind 'screencap-failed' -Message "adb shell screencap failed with exit code $LASTEXITCODE."}
    try{
        & $adb @serialArgument pull $deviceFile $outputFullPath|Out-Null
        if($LASTEXITCODE-ne0){Write-AihCaptureFailure -ErrorKind 'adb-pull-failed' -Message "adb pull failed with exit code $LASTEXITCODE."}
    }finally{
        if(-not$KeepDeviceFile){try{& $adb @serialArgument shell rm -f $deviceFile|Out-Null}catch{}}
    }

# 5. verify the artifact is a real PNG (magic bytes, read as BYTES)
if(-not(Test-Path -LiteralPath $outputFullPath -PathType Leaf)){Write-AihCaptureFailure -ErrorKind 'capture-missing' -Message "The captured file did not arrive at the artifact location: $outputFullPath"}
    $stream=[IO.File]::OpenRead($outputFullPath)
    try{$magic=New-Object byte[] 8;[void]$stream.Read($magic,0,8)}finally{$stream.Dispose()}
    $expectedMagic=[byte[]](0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A)
    $magicOk=$magic.Length-eq8
    for($i=0;$i-lt8;$i++){if($magic[$i]-ne$expectedMagic[$i]){$magicOk=$false}}
    if(-not$magicOk){Write-AihCaptureFailure -ErrorKind 'not-a-png' -Message "The captured artifact is not a valid PNG (magic bytes mismatch): $outputFullPath"}
    $bytes=(Get-Item -LiteralPath $outputFullPath).Length
    if($bytes-le0){Write-AihCaptureFailure -ErrorKind 'capture-empty' -Message "The captured artifact is empty: $outputFullPath"}
    $hash=(Get-FileHash -LiteralPath $outputFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $timestamp=[DateTime]::UtcNow.ToString('o')
    $identity=[ordered]@{deviceId=$resolvedSerial;expectedPackage=$PackageName;actualPackage=[string]$foreground.packageName;foregroundActivity=[string]$foreground.activity;timestamp=$timestamp;sha256=$hash;iteration=$Iteration;scenarioId=$ScenarioId}
    $identityPath=$outputFullPath+'.identity.json'
    $tempIdentity=$identityPath+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    try{[IO.File]::WriteAllText($tempIdentity,($identity|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $tempIdentity -Destination $identityPath -Force}finally{if(Test-Path -LiteralPath $tempIdentity){Remove-Item -LiteralPath $tempIdentity -Force}}

    [ordered]@{ok=$true;kind='visual-evidence-capture';deviceSerial=$resolvedSerial;deviceId=$resolvedSerial;deviceFile=$deviceFile;outputPath=$outputFullPath;identityPath=$identityPath;bytes=$bytes;sha256=$hash;mediaType='image/png';expectedPackage=$PackageName;actualPackage=[string]$foreground.packageName;foregroundActivity=[string]$foreground.activity;timestamp=$timestamp;iteration=$Iteration;scenarioId=$ScenarioId}|ConvertTo-Json -Depth 10
}finally{
    if($lockHeld){$captureMutex.ReleaseMutex()}
    $captureMutex.Dispose()
}
exit 0
