[CmdletBinding()]param([string]$InstallRoot='C:\AI-Harness')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$script:passed=0
function Assert-Aih { param([bool]$Condition,[string]$Name) if(-not$Condition){throw ('FAIL: '+$Name)}; $script:passed++; Write-Host ('PASS: '+$Name) }

$fixture=Join-Path ([IO.Path]::GetTempPath()) ('aih-visual-target-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture -Force|Out-Null
try{
    $png=Join-Path $fixture 'screen.png'
    Add-Type -AssemblyName System.Drawing
    $bmp=New-Object System.Drawing.Bitmap(400,800)
    try{
        $g=[Drawing.Graphics]::FromImage($bmp)
        try{ $g.Clear([Drawing.Color]::DarkOrange); $g.FillRectangle([Drawing.Brushes]::Black,20,20,200,200) }finally{$g.Dispose()}
        $bmp.Save($png,[Drawing.Imaging.ImageFormat]::Png)
    }finally{$bmp.Dispose()}

    $state=Join-Path $fixture 'foreground.txt'
    $log=Join-Path $fixture 'adb.log'
    $fakePs=Join-Path $fixture 'fake-adb.ps1'
    $fakeCmd=Join-Path $fixture 'adb.cmd'
    @'
param()
$argsList=@($args)
if($argsList.Count-ge2-and$argsList[0]-eq'-s'){$argsList=@($argsList|Select-Object -Skip 2)}
$command=$argsList-join' '
[IO.File]::AppendAllText($env:AIH_FAKE_ADB_LOG,$command+[Environment]::NewLine)
if($argsList[0]-eq'devices'){ "List of devices attached`nemulator-5554`tdevice"; exit 0 }
if($command-like'shell dumpsys activity activities*'){
  Start-Sleep -Milliseconds 100
  $pkg=(Get-Content -Raw $env:AIH_FAKE_ADB_STATE).Trim()
  "mResumedActivity: ActivityRecord{abc u0 $pkg/.MainActivity t1}"
  exit 0
}
if($command-like'shell monkey *'){
  $i=[Array]::IndexOf($argsList,'-p'); $wanted=$argsList[$i+1]
  if($env:AIH_FAKE_ADB_STICKY_MISMATCH-ne'1'){[IO.File]::WriteAllText($env:AIH_FAKE_ADB_STATE,$wanted)}
  'Events injected: 1'; exit 0
}
if($command-like'shell am start *'){
  $wanted=$env:AIH_FAKE_ADB_LAUNCH_PACKAGE
  if($env:AIH_FAKE_ADB_STICKY_MISMATCH-ne'1'-and$wanted){[IO.File]::WriteAllText($env:AIH_FAKE_ADB_STATE,$wanted)}
  'Starting: Intent'; exit 0
}
if($command-like'shell screencap *'){
  Start-Sleep -Milliseconds 250
  $pkg=(Get-Content -Raw $env:AIH_FAKE_ADB_STATE).Trim()
  [IO.File]::AppendAllText($env:AIH_FAKE_ADB_LOG,'captured-package='+$pkg+[Environment]::NewLine)
  exit 0
}
if($argsList[0]-eq'pull'){Copy-Item -LiteralPath $env:AIH_FAKE_ADB_PNG -Destination $argsList[-1] -Force; exit 0}
if($command-like'shell rm *'){exit 0}
exit 1
'@|Set-Content -LiteralPath $fakePs -Encoding UTF8
    ('@powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "'+$fakePs+'" %*')|Set-Content -LiteralPath $fakeCmd -Encoding ASCII
    $env:AIH_FAKE_ADB_LOG=$log; $env:AIH_FAKE_ADB_STATE=$state; $env:AIH_FAKE_ADB_PNG=$png

    function Invoke-Capture([string]$Package,[string]$Name){
        $out=Join-Path $fixture ($Name+'.png')
        $text=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\Capture-VisualEvidence.ps1') -OutputPath $out -AdbPath $fakeCmd -DeviceSerial emulator-5554 -PackageName $Package -ScenarioId workout -Iteration 1 -Force
        [pscustomobject]@{exitCode=$LASTEXITCODE;json=($text|ConvertFrom-Json);output=$out;text=($text-join[Environment]::NewLine)}
    }

    'app.openrank.mobile'|Set-Content -LiteralPath $state -NoNewline
    $accepted=Invoke-Capture 'app.openrank.mobile' 'accepted'
    if($accepted.exitCode-ne0){Write-Host $accepted.text}
    Assert-Aih ($accepted.exitCode-eq0-and$accepted.json.actualPackage-eq'app.openrank.mobile') 'correct foreground package is accepted'
    Assert-Aih (-not((Get-Content -Raw $log)-match'shell monkey')) 'correct foreground does not relaunch'

    [IO.File]::WriteAllText($log,''); 'com.autopulse.mobile'|Set-Content -LiteralPath $state -NoNewline
    $launched=Invoke-Capture 'app.openrank.mobile' 'launched'
    $launchLog=Get-Content -Raw $log
    Assert-Aih ($launched.exitCode-eq0-and$launchLog-match'shell monkey.*-p app.openrank.mobile') 'wrong foreground package launches expected app'
    Assert-Aih (([regex]::Matches($launchLog,'shell dumpsys activity activities')).Count-eq2-and$launchLog.IndexOf('shell screencap')-gt$launchLog.LastIndexOf('shell dumpsys activity activities')) 'launch is reverified before capture'
    $identity=Get-Content -Raw ($launched.output+'.identity.json')|ConvertFrom-Json
    Assert-Aih ($identity.deviceId-eq'emulator-5554'-and$identity.expectedPackage-eq'app.openrank.mobile'-and$identity.actualPackage-eq'app.openrank.mobile'-and$identity.foregroundActivity-match'app.openrank.mobile'-and$identity.sha256-eq$launched.json.sha256-and$identity.iteration-eq1-and$identity.scenarioId-eq'workout'-and-not[string]::IsNullOrWhiteSpace($identity.timestamp)) 'screenshot identity metadata is persisted'

    [IO.File]::WriteAllText($log,''); 'com.autopulse.mobile'|Set-Content -LiteralPath $state -NoNewline; $env:AIH_FAKE_ADB_STICKY_MISMATCH='1'
    $mismatch=Invoke-Capture 'app.openrank.mobile' 'mismatch'
    Assert-Aih ($mismatch.exitCode-eq3-and$mismatch.json.errorKind-eq'visual-capture-target-mismatch') 'mismatch after launch fails closed'
    Assert-Aih (-not((Get-Content -Raw $log)-match'shell screencap')) 'mismatch after launch captures nothing'
    Remove-Item Env:AIH_FAKE_ADB_STICKY_MISMATCH

    . (Join-Path $InstallRoot 'scripts\RuntimeTarget.ps1')
    $openrank=Join-Path $fixture 'OpenRank'; $autopulse=Join-Path $fixture 'AutoPulse'
    New-Item -ItemType Directory -Path (Join-Path $openrank 'apps\mobile') -Force|Out-Null
    New-Item -ItemType Directory -Path $autopulse -Force|Out-Null
    'export default { expo: { android: { package: "app.openrank.mobile" } } };'|Set-Content (Join-Path $openrank 'apps\mobile\app.config.ts')
    @{expo=@{android=@{package='com.autopulse.mobile'}}}|ConvertTo-Json -Depth 5|Set-Content (Join-Path $autopulse 'app.json')
    $orTarget=Resolve-AihRuntimeTarget -Workspace $openrank -Scenario ([pscustomobject]@{id='workout';platform='android'}) -DeviceId emulator-5554
    $apTarget=Resolve-AihRuntimeTarget -Workspace $autopulse -Scenario ([pscustomobject]@{id='live';platform='android'}) -DeviceId emulator-5554
    Assert-Aih ($orTarget.packageName-eq'app.openrank.mobile'-and$apTarget.packageName-eq'com.autopulse.mobile') 'OpenRank and AutoPulse bindings remain independent on one device'
    New-Item -ItemType Directory -Path (Join-Path $autopulse '.ai-harness') -Force|Out-Null
    @{platform='android';deviceId='emulator-7777';packageName='com.autopulse.override';activity='.DebugActivity'}|ConvertTo-Json|Set-Content (Join-Path $autopulse '.ai-harness\runtime-target.json')
    $override=Resolve-AihRuntimeTarget -Workspace $autopulse -Scenario ([pscustomobject]@{id='debug';platform='android'})
    Assert-Aih ($override.deviceId-eq'emulator-7777'-and$override.packageName-eq'com.autopulse.override'-and$override.activity-eq'.DebugActivity') 'explicit project runtime target overrides manifest defaults'

    [IO.File]::WriteAllText($log,''); 'com.other'|Set-Content -LiteralPath $state -NoNewline
    $p1=Start-Process powershell.exe -PassThru -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $InstallRoot 'scripts\Capture-VisualEvidence.ps1'),'-OutputPath',(Join-Path $fixture 'parallel-a.png'),'-AdbPath',$fakeCmd,'-DeviceSerial','emulator-5554','-PackageName','app.openrank.mobile','-ScenarioId','a','-Iteration','1','-Force')
    $p2=Start-Process powershell.exe -PassThru -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $InstallRoot 'scripts\Capture-VisualEvidence.ps1'),'-OutputPath',(Join-Path $fixture 'parallel-b.png'),'-AdbPath',$fakeCmd,'-DeviceSerial','emulator-5554','-PackageName','com.autopulse.mobile','-ScenarioId','b','-Iteration','1','-Force')
    $p1.WaitForExit(); $p2.WaitForExit()
    $capturePackages=@(Get-Content $log|Where-Object{$_-like'captured-package=*'}|ForEach-Object{$_-replace'^captured-package=',''} )
    Assert-Aih ($p1.ExitCode-eq0-and$p2.ExitCode-eq0-and$capturePackages.Count-eq2-and$capturePackages.Contains('app.openrank.mobile')-and$capturePackages.Contains('com.autopulse.mobile')) 'shared-device critical sections cannot interleave'

    Write-Host ('RESULT: '+$script:passed+' visual target assertions passed.')
}finally{
    Remove-Item Env:AIH_FAKE_ADB_LOG,Env:AIH_FAKE_ADB_STATE,Env:AIH_FAKE_ADB_PNG,Env:AIH_FAKE_ADB_STICKY_MISMATCH -ErrorAction SilentlyContinue
    if(Test-Path $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
}
