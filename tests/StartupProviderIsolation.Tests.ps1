[CmdletBinding()]
param([string]$InstallRoot)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Startup.ps1')
$aihPsHost = Get-AihPowerShellHost -InstallRoot $InstallRoot
$passed = 0

function Assert-Aih([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:passed++
    Write-Host "PASS: $Message"
}

function Get-AihFreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}

function New-AihStartupFixture([string]$Name) {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('aih-startup-provider-' + $Name + '-' + [guid]::NewGuid().ToString('N'))
    Write-Host "STARTUP [$Name] create fixture $root"
    foreach ($directory in @('scripts','config','data','logs','runtime/node','app/node_modules/@deepseek-ai/dsh/lib')) {
        New-Item -ItemType Directory -Path (Join-Path $root $directory) -Force | Out-Null
    }
    Write-Host "STARTUP [$Name] copy scripts and runtime"
    Copy-Item -Path (Join-Path $InstallRoot 'scripts/*') -Destination (Join-Path $root 'scripts') -Recurse
    Copy-Item -LiteralPath (Join-Path $InstallRoot 'config/routing-policy.json') -Destination (Join-Path $root 'config/routing-policy.json')
    Copy-Item -LiteralPath (Join-Path $InstallRoot 'config/settings.yaml') -Destination (Join-Path $root 'data/nexus-settings.yaml')
    $fixtureNode = Join-Path (Join-Path $root 'runtime/node') (Get-AihNodeRelativeExecutable)
    New-Item -ItemType Directory -Path (Split-Path -Parent $fixtureNode) -Force | Out-Null
    Copy-Item -LiteralPath (Get-AihNodeExecutable -InstallRoot $InstallRoot) -Destination $fixtureNode

    $webPort = Get-AihFreeTcpPort
    $oauthPort = Get-AihFreeTcpPort
    Write-Host "STARTUP [$Name] fixture ports allocated"
    [ordered]@{
        HarnessVersion = 'startup-provider-test'
        OAuthBaseUrl = "http://127.0.0.1:$oauthPort/v1"
        HarnessUrl = "http://127.0.0.1:$webPort"
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'config/versions.json') -Encoding UTF8

    $fakeDsh = @'
const http = require('node:http')
const portIndex = process.argv.indexOf('--port')
const port = Number(process.argv[portIndex + 1])
const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/execute') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ready' }))
    return
  }
  let raw = ''
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    const body = JSON.parse(raw || '{}')
    if (body.provider === 'flash-high-direct' || body.provider === 'flash-max-direct') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { scope: 'execution', code: 'model_not_found', model: body.model } }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, provider: body.provider }))
  })
})
server.listen(port, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + port))
'@
    Set-Content -LiteralPath (Join-Path $root 'app/node_modules/@deepseek-ai/dsh/lib/bin.js') -Value $fakeDsh -Encoding UTF8
    return [pscustomobject]@{ Root = $root; Port = $webPort; Url = "http://127.0.0.1:$webPort" }
}

function Stop-AihFixtureProcess([string]$Root) {
    $statePath = Join-Path $Root 'data/aih-state.json'
    if (-not (Test-Path -LiteralPath $statePath)) { return }
    try {
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        $process = Get-Process -Id ([int]$state.Pid) -ErrorAction SilentlyContinue
        $expected = [IO.Path]::GetFullPath((Get-AihLayout $Root).Node)
        if ($null -ne $process -and $state.ProcessStartedAtUtc -and
            (Test-AihTrackedProcessIdentity -Process $process -State $state -ExpectedExecutable $expected)) {
            $process.Kill()
            $null = $process.WaitForExit(5000)
        }
    } catch { }
}

function Start-AihStartupLauncher {
    param($Fixture, [string]$Stage, [string]$ScriptPath, [string[]]$Arguments)
    $logRoot = if ($env:DSH_REPORTS) { Join-Path $env:DSH_REPORTS 'startup-provider' } else { $Fixture.Root }
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $stdout = Join-Path $logRoot "$Stage.out.log"
    $stderr = Join-Path $logRoot "$Stage.err.log"
    $quote = { param([string]$Value) "'" + $Value.Replace("'", "''") + "'" }
    $command = '& ' + (& $quote $ScriptPath) + ' ' + (($Arguments | ForEach-Object { if ($_ -cmatch '^-[A-Za-z]+$') { $_ } else { & $quote $_ } }) -join ' ')
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    Write-Host "STARTUP [$Stage] launch (stdout $stdout)"
    $process = Start-Process -FilePath $aihPsHost -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded) -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    # Keep the Windows process handle open so ExitCode survives a fast exit.
    $null = $process.Handle
    Write-Host "STARTUP [$Stage] launched PID $($process.Id)"
    return @{ Process=$process; Stdout=$stdout; Stderr=$stderr }
}

function Invoke-AihBoundedStartupLauncher($Fixture, [string]$Stage) {
    $launcher = Start-AihStartupLauncher $Fixture $Stage (Join-Path $Fixture.Root 'scripts/aih.ps1') @(
        '-InstallRoot', $Fixture.Root, '-Preset', 'aih-engineering', '-Port', [string]$Fixture.Port)
    try {
        if (-not $launcher.Process.WaitForExit(25000)) {
            throw "STARTUP [$Stage] launcher exceeded its 25-second exit deadline. See $($launcher.Stderr)"
        }
        $exitCode = $launcher.Process.ExitCode
        Write-Host "STARTUP [$Stage] launcher exited with code [$exitCode]"
        return $exitCode
    } finally {
        if (-not $launcher.Process.HasExited) { $launcher.Process.Kill(); [void]$launcher.Process.WaitForExit(5000) }
        $launcher.Process.Dispose()
    }
}

function Invoke-AihStartupScenario([string]$Name, [ValidateSet('unreachable','absent')][string]$DeepSeekState, [string]$Preset) {
    $fixture = New-AihStartupFixture $Name
    $launcher = $null
    $probeMarker = Join-Path $fixture.Root 'data/deepseek-model-probe.txt'
    $wrapper = Join-Path $fixture.Root 'invoke-aih.ps1'
    $wrapperText = @'
param([string]$Root,[string]$Preset,[string]$DeepSeekState,[string]$ProbeMarker,[int]$Port)
function Invoke-RestMethod {
    param([string]$Uri, $Headers, [int]$TimeoutSec, [string]$Method, [string]$ContentType, [string]$Body)
    if ($Uri -eq 'https://api.deepseek.com/models') {
        Set-Content -LiteralPath $ProbeMarker -Value $DeepSeekState
        if ($DeepSeekState -eq 'unreachable') { throw 'synthetic DeepSeek network failure' }
        return [pscustomobject]@{ data = @([pscustomobject]@{ id = 'some-other-model' }) }
    }
    $cmdlet = Get-Command Invoke-RestMethod -CommandType Cmdlet
    & $cmdlet @PSBoundParameters
}
try { & (Join-Path $Root 'scripts/aih.ps1') -InstallRoot $Root -Preset $Preset -Port $Port }
catch { Write-Error $_; exit 1 }
'@
    Set-Content -LiteralPath $wrapper -Value $wrapperText -Encoding UTF8
    $savedKey = $env:DEEPSEEK_API_KEY
    try {
        $env:DEEPSEEK_API_KEY = 'startup-provider-test-key-not-real'
        $launch = Start-AihStartupLauncher $fixture $Name $wrapper @(
            '-Root', $fixture.Root, '-Preset', $Preset, '-DeepSeekState', $DeepSeekState,
            '-ProbeMarker', $probeMarker, '-Port', [string]$fixture.Port)
        $launcher = $launch.Process
        Write-Host "STARTUP [$Name] poll readiness"
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        $state = $null
        while ([DateTime]::UtcNow -lt $deadline) {
            $launcher.Refresh()
            $statePath = Join-Path $fixture.Root 'data/aih-state.json'
            if (Test-Path -LiteralPath $statePath) {
                try { $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } catch { $state = $null }
                if ($null -ne $state -and $state.Status -eq 'READY') { break }
            }
            if ($launcher.HasExited) { break }
            Start-Sleep -Milliseconds 100
        }
        Write-Host "STARTUP [$Name] readiness poll ended"
        Assert-Aih ($null -ne $state -and $state.Status -eq 'READY') "${Name}: aih starts when DeepSeek is $DeepSeekState (logs $($launch.Stdout), $($launch.Stderr))"
        Assert-Aih (-not (Test-Path -LiteralPath $probeMarker)) "${Name}: startup never calls the Direct DeepSeek model-list endpoint"
        Assert-Aih ($state.Status -eq 'READY') "${Name}: startup reaches READY"
        Write-Host "STARTUP [$Name] wait for launcher exit"
        Assert-Aih ($launcher.WaitForExit(5000)) "${Name}: launcher exits after readiness"
        $server = Get-Process -Id ([int]$state.Pid) -ErrorAction SilentlyContinue
        Assert-Aih ($null -ne $server -and (Test-AihTrackedProcessIdentity -Process $server -State $state -ExpectedExecutable (Get-AihLayout $fixture.Root).Node)) "${Name}: READY PID keeps the original Node identity after launcher exit"
        Assert-Aih (Test-AihEndpoint -Uri $fixture.Url -TimeoutSec 2) "${Name}: HTTP remains available after launcher exit"
        $launcher.Dispose()
        return $fixture
    }
    catch {
        Stop-AihFixtureProcess $fixture.Root
        if ($null -ne $launcher) {
            $launcher.Refresh()
            if (-not $launcher.HasExited) { $launcher.Kill(); [void]$launcher.WaitForExit(5000) }
            $launcher.Dispose()
        }
        Remove-Item -LiteralPath $fixture.Root -Recurse -Force
        throw
    }
    finally {
        if ($null -eq $savedKey) { Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue }
        else { $env:DEEPSEEK_API_KEY = $savedKey }
    }
}

$fixtures = @()
try {
    $unreachable = Invoke-AihStartupScenario 'unreachable' 'unreachable' 'aih-muse'
    $fixtures += $unreachable
    $absent = Invoke-AihStartupScenario 'absent-model' 'absent' 'aih-engineering'
    $fixtures += $absent

    foreach ($case in @(
        @{ fixture = $unreachable; provider = 'meta-model-api'; label = 'Muse' },
        @{ fixture = $absent; provider = 'sol-local'; label = 'OpenAI' },
        @{ fixture = $absent; provider = 'local-tool'; label = 'local' }
    )) {
        $body = @{ provider = $case.provider; model = 'fixture-model' } | ConvertTo-Json
        $response = Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Method Post -Uri ($case.fixture.Url + '/execute') -ContentType 'application/json' -Body $body
        Assert-Aih ($response.ok -and $response.provider -eq $case.provider) "$($case.label) execution remains usable without DeepSeek startup availability"
    }

    $deepSeekBody = @{ provider = 'flash-high-direct'; model = 'deepseek-v4-flash' } | ConvertTo-Json
    $scopedError = $null
    try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Method Post -Uri ($absent.Url + '/execute') -ContentType 'application/json' -Body $deepSeekBody }
    catch { $scopedError = $_ }
    Assert-Aih ($null -ne $scopedError -and [int]$scopedError.Exception.Response.StatusCode -eq 404) 'selecting an unavailable DeepSeek model returns a scoped execution error'
    $health = Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri $absent.Url
    Assert-Aih ($health.status -eq 'ready') 'the Harness remains alive after the unavailable DeepSeek execution'

    $originalPid = [int](Get-Content -Raw (Join-Path $absent.Root 'data/aih-state.json') | ConvertFrom-Json).Pid
    $reuseExit = Invoke-AihBoundedStartupLauncher $absent 'reuse'
    $reusedState = Get-Content -Raw (Join-Path $absent.Root 'data/aih-state.json') | ConvertFrom-Json
    Write-Host "STARTUP [reuse] state=$($reusedState.Status) PID=$($reusedState.Pid) expected=$originalPid"
    Assert-Aih ($reuseExit -eq 0 -and $reusedState.Status -eq 'READY' -and [int]$reusedState.Pid -eq $originalPid) 'aih reuses the verified READY Web UI process'

    Stop-AihFixtureProcess $absent.Root
    $restartExit = Invoke-AihBoundedStartupLauncher $absent 'restart'
    $restartedState = Get-Content -Raw (Join-Path $absent.Root 'data/aih-state.json') | ConvertFrom-Json
    Assert-Aih ($restartExit -eq 0 -and $restartedState.Status -eq 'READY' -and [int]$restartedState.Pid -ne $originalPid -and (Test-AihEndpoint -Uri $absent.Url -TimeoutSec 2)) 'aih replaces stale READY state with a new live Web UI process'

    Write-Host "RESULT: $passed startup/provider isolation assertions passed."
}
finally {
    foreach ($fixture in $fixtures) {
        Stop-AihFixtureProcess $fixture.Root
        if (Test-Path -LiteralPath $fixture.Root) { Remove-Item -LiteralPath $fixture.Root -Recurse -Force }
    }
}
