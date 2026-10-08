# Native Windows verification before CCv2 merge

Status on 2026-10-08: **UNVERIFIED**. This stabilization was executed on Linux
with pinned Node 24.18.1 and PowerShell 7.5.3. Windows-shaped mocks are contract
checks, not native Windows evidence. The repository has `windows-latest` CI;
its existence alone is not a PASS. Preserve job URLs, tested SHA, shell version,
logs and JSON reports for the following gates.

Use a disposable Windows VM/account. Setup/Update publish user skills and may
update user PATH; do not run upgrade acceptance against an everyday installation.
Use real installed roots containing spaces. No command below sends LLM requests.
The startup smoke starts a local server; do not submit a conversation.

## Baseline stabilization candidate

Prepare three checkouts: `$Source` at the stabilization PR SHA, `$BaselineSource`
at `9f5f109e0f651bc5007bb8670202477b688ba26c`, and later `$Ccv2Source` at the
reviewed candidate containing both PRs. Keep them distinct. Do not overwrite the
frozen benchmark or use the CCv2 branch as this stabilization's baseline.

Execute this block in native Windows PowerShell 5.1 after setting the two source
paths. `Run-Native` checks every child exit status; a later success cannot hide
an earlier failure. Fresh fixture roots must not already exist.

```powershell
$ErrorActionPreference = 'Stop'
if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) { throw 'Native Windows is required' }
$Source = 'C:\src\Nexus stabilization'
$BaselineSource = 'C:\src\Nexus dev baseline'
$Evidence = Join-Path $env:TEMP ('Nexus Windows gates ' + [guid]::NewGuid().ToString('N'))
$Clean = Join-Path $Evidence 'clean install'
$Upgrade = Join-Path $Evidence 'upgrade install'
$Ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
New-Item -ItemType Directory -Path $Evidence -Force | Out-Null
function Run-Native([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Native verification failed ($LASTEXITCODE): $Exe" }
}
& git -C $Source rev-parse HEAD
& git -C $Source status --porcelain
$PSVersionTable | Out-File (Join-Path $Evidence 'driver-shell.txt')

# Clean installation: real entry point, pinned dependencies and native checks.
Run-Native $Ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',
    (Join-Path $Source 'setup.ps1'),'-InstallRoot',$Clean,
    '-SkipPathUpdate','-SkipDeepSeekLogin','-SkipOpenAiLogin')
$Node = Join-Path $Clean 'runtime\node\node.exe'
Run-Native $Node @('--version')
Run-Native $Ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',
    (Join-Path $Clean 'scripts\Test-Harness.ps1'),'-InstallRoot',$Clean,
    '-PowerShellExecutable',$Ps51,'-ContinueOnFailure',
    '-ReportPath',(Join-Path $Evidence 'ps51-harness.json'))

# PowerShell 7 is a separate lane; never substitute it for the production 5.1 lane.
$Ps7 = (Get-Command pwsh.exe -ErrorAction Stop).Source
Run-Native $Ps7 @('-NoProfile','-File',
    (Join-Path $Clean 'scripts\Test-Harness.ps1'),'-InstallRoot',$Clean,
    '-PowerShellExecutable',$Ps7,'-ContinueOnFailure',
    '-ReportPath',(Join-Path $Evidence 'ps7-harness.json'))

# Upgrade/migration: first provision the unchanged dev baseline, then exercise
# the real updater. A baseline test failure is recorded, not treated as an
# installer success. Setup.ps1 provisions without invoking Test-Harness.
Run-Native $Ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',
    (Join-Path $BaselineSource 'scripts\Setup.ps1'),'-InstallRoot',$Upgrade,
    '-SkipPathUpdate')
$Sentinel = Join-Path $Upgrade 'data\user-preservation-sentinel.txt'
[IO.File]::WriteAllText($Sentinel,'user-owned upgrade evidence')
$SyntheticCredentials = Join-Path $Upgrade 'data\.credentials.yaml'
# Construct a synthetic credential fixture; never read/copy real credentials.
[IO.File]::WriteAllText($SyntheticCredentials, (('DEEPSEEK' + '_API_KEY') + ': ' + 'WINDOWS_SYNTHETIC_ONLY'))
$UpgradeWorkspace = Join-Path $Evidence 'preserved task workspace'
New-Item -ItemType Directory -Path $UpgradeWorkspace -Force | Out-Null
Run-Native $Ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',
    (Join-Path $Upgrade 'scripts\Task.ps1'),'-Action','create-task',
    '-Workspace',$UpgradeWorkspace,'-Description','Synthetic upgrade preservation task')
$Ledger = Join-Path $UpgradeWorkspace '.ai-harness\state\tasks.json'
$Settings = Join-Path $Upgrade 'data\settings.yaml'
Add-Content -LiteralPath $Settings -Value "`nwindows-preservation-sentinel: 'kept'"
$PreservedFiles = @($Sentinel,$SyntheticCredentials,$Ledger,$Settings)
$BeforeState = @{}
foreach ($File in $PreservedFiles) { $BeforeState[$File] = (Get-FileHash $File -Algorithm SHA256).Hash }
Run-Native $Ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',
    (Join-Path $Source 'scripts\Update.ps1'),'-SourceRoot',$Source,'-InstallRoot',$Upgrade)
foreach ($File in $PreservedFiles) {
    if ((Get-FileHash $File -Algorithm SHA256).Hash -ne $BeforeState[$File]) { throw "Upgrade changed preserved fixture: $File" }
}
foreach ($Suite in @('SetupUpgrade','UpdateRootResolution','MuseOpenCodeGo',
    'StartupProviderIsolation','StartupLifecycle','PlatformSupport','Intelligence.Concurrency')) {
    $File = Join-Path $Upgrade ('tests\' + $Suite + '.Tests.ps1')
    if (-not (Test-Path $File)) { throw "Required suite absent: $File" }
    Run-Native $Ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',$File,'-InstallRoot',$Upgrade)
}

# OpenCode Go: real installed adapter patch status + offline transport/routing.
Run-Native $Node @((Join-Path $Clean 'scripts\Apply-OpenCodeSessionPatch.cjs'),$Clean,'status')
Run-Native $Node @((Join-Path $Clean 'tests\MuseOpenCodeGo.Tests.cjs'))
Run-Native $Node @((Join-Path $Clean 'tests\EngineeringIsolation.Tests.cjs'))
Run-Native $Node @((Join-Path $Clean 'tests\NexusControllerPanel.Tests.cjs'))
```

The upgrade suites verify managed settings migration and user setting retention;
retain their assertions and inspect the migrated settings without logging keys.
The block also hashes synthetic credentials, the controller's real task ledger,
a user data sentinel and settings with a custom user value. They must retain
their bytes for this current-baseline upgrade; additive migration from older
settings is separately exercised by the suites. Never copy real credentials
into release evidence.

## Runtime startup smoke

The deterministic `StartupLifecycle.Tests.ps1` gate above must pass in 5.1. Also
run the actual launcher in the disposable installed root, with locally configured
credentials if the selected preset requires them. Startup is not an inference
request. Record readiness, process identity, restart and stop behavior.

```powershell
$Workspace = Join-Path $Evidence 'startup workspace'
New-Item -ItemType Directory -Path $Workspace -Force | Out-Null
Run-Native $Ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',
    (Join-Path $Clean 'scripts\aih.ps1'),'-InstallRoot',$Clean,
    '-Preset','deepseek','-WorkspacePath',$Workspace)
$response = Invoke-WebRequest 'http://127.0.0.1:3080/' -UseBasicParsing
if ($response.StatusCode -ne 200) { throw 'Runtime readiness failed' }
Run-Native $Ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',
    (Join-Path $Clean 'scripts\aih.ps1'),'-InstallRoot',$Clean,
    '-Preset','deepseek','-WorkspacePath',$Workspace,'-Restart')
Run-Native $Ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',
    (Join-Path $Clean 'scripts\Stop.ps1'),'-InstallRoot',$Clean)
```

Use the configured local port if this fixture intentionally changes the default.
A missing credential or unavailable port is a failed/unverified smoke, never a
PASS inferred from mocked startup. Stop only this disposable installation.

## CCv2 installed dependency closure — combined candidate only

These modules are intentionally absent from the dev-only stabilization branch.
Run against a fresh **native Windows** installation of the reviewed combined
candidate. Neither copying CCv2 into this branch nor validating a Linux install
can satisfy this gate. Set `$Ccv2Source` to its immutable checkout SHA and record
that SHA; do not modify or merge either PR automatically.

```powershell
$Ccv2Source = 'C:\src\Nexus combined review candidate'
$Ccv2Install = Join-Path $Evidence 'combined CCv2 install'
Run-Native $Ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',
    (Join-Path $Ccv2Source 'setup.ps1'),'-InstallRoot',$Ccv2Install,
    '-SkipPathUpdate','-SkipDeepSeekLogin','-SkipOpenAiLogin')
$Ccv2Node = Join-Path $Ccv2Install 'runtime\node\node.exe'
foreach ($Profile in @('engineering','deepseek','muse')) {
    $PresetName = switch ($Profile) {
        'engineering' { 'aih-engineering' }
        'deepseek' { 'aih-deepseek' }
        'muse' { 'aih-muse' }
    }
    Run-Native $Ccv2Node @((Join-Path $Ccv2Install 'scripts\MusePresetDependencyClosure.cjs'),
        'validate',$Ccv2Install,(Join-Path $Ccv2Install ('data\.agent-presets\' + $PresetName)),$Profile)
}
Run-Native $Ccv2Node @((Join-Path $Ccv2Install 'tests\ControllerPresetInstalled.Tests.cjs'),$Ccv2Install)
Run-Native $Ccv2Node @((Join-Path $Ccv2Install 'tests\ControllerPresetCleanInstall.Tests.cjs'))
Run-Native $Ccv2Node @((Join-Path $Ccv2Install 'tests\SourceCompleteness.Tests.cjs'))
Run-Native $Ccv2Node @((Join-Path $Ccv2Install 'tests\ComposedRoutingMatrix.Tests.cjs'))
Run-Native $Ccv2Node @((Join-Path $Ccv2Install 'tests\MuseRoutingAuthorityOrdering.Tests.cjs'))
Run-Native $Ccv2Node @((Join-Path $Ccv2Install 'tests\MuseOpenCodeGo.Tests.cjs'))
```

Acceptance requires zero missing modules/assets, executable installed controller
and Muse closures, unchanged provider authority, and no source-checkout or system
Node fallback. Record parser/CLI compatibility and actual 5.1 results separately.
Do not run live provider canaries or LHCB as part of these gates.
