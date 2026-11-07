[CmdletBinding()]
param([string]$InstallRoot)

# PlatformPortability.Tests.ps1 - regressions found while bringing Nexus up natively on macOS arm64.
# Every assertion runs on every platform; each one pins a behavior that depended on the OS or on the
# user's regional settings:
#   - relative paths (an absolute POSIX path is a RELATIVE [Uri] on macOS, so MakeRelativeUri threw and
#     project detection found no verification commands)
#   - JSON number serialization under a comma-decimal culture (a PSObject-wrapped number became {})
#   - lease/identity timestamps under a day/month culture (ConvertFrom-Json gives DateTime objects and
#     [string]$dateTime re-parsed with the current culture swapped day and month, so a live lock holder
#     looked expired and a second writer could take the apply lock)
#   - the tracked-process identity gate for a real child process (path + start time)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Split-Path -Parent $PSScriptRoot }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Project.ps1')
. (Join-Path $InstallRoot 'scripts/Startup.ps1')
. (Join-Path $InstallRoot 'scripts/ContextLifecycle.ps1')
$layout = Get-AihLayout $InstallRoot
$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function Use-Culture([string]$Name, [scriptblock]$Body) {
    $previous = [System.Globalization.CultureInfo]::CurrentCulture
    try { [System.Globalization.CultureInfo]::CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo($Name); & $Body }
    finally { [System.Globalization.CultureInfo]::CurrentCulture = $previous }
}

# relative paths
$workspace = Join-Path ([IO.Path]::GetTempPath()) ('aih-portability-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Force -Path (Join-Path $workspace 'a/b') | Out-Null
    $relative = Get-AihRelativePath -Root $workspace -Path (Join-Path $workspace 'a/b/file.txt')
    Assert-Aih ($relative -eq ('a' + [IO.Path]::DirectorySeparatorChar + 'b' + [IO.Path]::DirectorySeparatorChar + 'file.txt')) 'Get-AihRelativePath resolves an absolute path under an absolute root on every OS'
    Set-Content -LiteralPath (Join-Path $workspace 'package.json') -Value '{"private":true,"scripts":{"test":"node t.cjs"}}'
    Set-Content -LiteralPath (Join-Path $workspace 'a/b/file.txt') -Value 'x'
    $files = @(Get-AihWorkspaceFiles -Workspace $workspace)
    Assert-Aih (($files -contains 'package.json') -and ($files -contains ('a' + [IO.Path]::DirectorySeparatorChar + 'b' + [IO.Path]::DirectorySeparatorChar + 'file.txt'))) 'workspace file listing finds files without ripgrep on every OS'
}
finally { Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue }

# JSON numbers under comma-decimal and day/month cultures
foreach ($culture in @('bg-BG', 'de-DE', 'en-GB')) {
    Use-Culture $culture {
        $json = ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe 12.5) -Compress
        Assert-Aih ($json -eq '12.5') "a number serializes as a JSON number under $culture"
        $wrapped = [PSObject]::AsPSObject(7)
        Assert-Aih ((ConvertTo-Json -InputObject (ConvertTo-AihJsonSafe $wrapped) -Compress) -eq '7') "a PSObject-wrapped number serializes as a JSON number under $culture"
    }
}

# lease timestamps keep their instant under every culture
$instant = [DateTime]::new(2026, 11, 7, 18, 30, 0, [DateTimeKind]::Utc)
$fromJson = ('{"e":"' + $instant.ToString('o') + '"}' | ConvertFrom-Json).e
foreach ($culture in @('bg-BG', 'en-GB', 'en-US', 'ja-JP')) {
    Use-Culture $culture {
        $viaObject = ConvertTo-AihUtcInstant $fromJson
        Assert-Aih ($viaObject -eq $instant) "a DateTime from ConvertFrom-Json keeps its instant under $culture"
        Assert-Aih (Test-AihRecordedProcessStart -Recorded $fromJson -ActualStartUtc $instant) "a recorded process start matches the live start under $culture"
        Assert-Aih (-not (Test-AihRecordedProcessStart -Recorded $fromJson -ActualStartUtc $instant.AddMinutes(1))) "a different start time is not accepted under $culture"
    }
}
Assert-Aih (Test-AihRecordedProcessStart -Recorded $null -ActualStartUtc $instant) 'an absent recorded start stays compatible (unchanged contract)'

# tracked-process identity for a real child
$child = $null
try {
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $layout.Node
    foreach ($argument in @('-e', 'setTimeout(function(){}, 30000)')) { [void]$info.ArgumentList.Add($argument) }
    $info.UseShellExecute = $false
    $child = [System.Diagnostics.Process]::Start($info)
    Start-Sleep -Milliseconds 400
    $child.Refresh()
    $state = [pscustomobject]@{ Pid = $child.Id; ProcessStartedAtUtc = $child.StartTime.ToUniversalTime().ToString('o') }
    Assert-Aih (Test-AihTrackedProcessIdentity -Process $child -State $state -ExpectedExecutable $layout.Node) 'the tracked-process identity gate accepts the real child (pid, executable, start time)'
    $wrongState = [pscustomobject]@{ Pid = $child.Id; ProcessStartedAtUtc = $child.StartTime.ToUniversalTime().AddMinutes(5).ToString('o') }
    Assert-Aih (-not (Test-AihTrackedProcessIdentity -Process $child -State $wrongState -ExpectedExecutable $layout.Node)) 'the identity gate rejects a different start time'
    Assert-Aih (-not (Test-AihTrackedProcessIdentity -Process $child -State $state -ExpectedExecutable (Join-Path $InstallRoot 'scripts/not-the-node'))) 'the identity gate rejects a different executable'
}
finally { if ($null -ne $child -and -not $child.HasExited) { $child.Kill() } }

Write-Host ('SUITE RESULT: PASS ' + $passed + ' | FAIL 0 | total ' + $passed)
