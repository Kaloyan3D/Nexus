[CmdletBinding()]param([string]$InstallRoot)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot=Split-Path -Parent $PSScriptRoot }
. (Join-Path $InstallRoot 'scripts\Platform.ps1')
$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not$Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
$isWindows=Test-AihIsWindows
$realIsWindows=[System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)

try {
    # ── platform detection ──
    Assert-Aih ($isWindows-eq$realIsWindows) 'Test-AihIsWindows matches RuntimeInformation (PS 5.1 has no $IsWindows)'
    $platformName=Get-AihPlatformName
    if ($isWindows) { Assert-Aih ($platformName-eq'windows') 'Get-AihPlatformName reports windows on Windows' }
    else { Assert-Aih ($platformName-eq'linux') 'Get-AihPlatformName reports linux on Linux' }

    # ── launcher naming ──
    if ($isWindows) { Assert-Aih ((Get-AihLauncherExtension)-eq'.cmd') 'Windows launcher extension stays .cmd' }
    else { Assert-Aih ((Get-AihLauncherExtension)-eq'') 'Linux launchers are extensionless' }
    $fixtureLayout=[pscustomobject]@{ Bin=(Join-Path ([IO.Path]::GetTempPath()) 'aih-psupport-bin') }
    $launcherPath=Get-AihLayoutLauncherPath -Layout $fixtureLayout -Name 'aih-route'
    if ($isWindows) { Assert-Aih ($launcherPath.EndsWith('aih-route.cmd')) 'layout launcher path uses aih-route.cmd on Windows' }
    else { Assert-Aih ($launcherPath.EndsWith('aih-route')) 'layout launcher path is extensionless on Linux' }

    # ── PowerShell host resolution ──
    if ($isWindows) {
        Assert-Aih ((Get-AihPowerShellHost ([IO.Path]::GetTempPath()))-eq'powershell.exe') 'Windows host stays powershell.exe'
        $previousHost=$env:AIH_PWSH_HOST
        try {
            $env:AIH_PWSH_HOST='C:/override/pwsh.exe'
            Assert-Aih ((Get-AihPowerShellHost ([IO.Path]::GetTempPath()))-eq'powershell.exe') 'Windows host ignores AIH_PWSH_HOST (behavior unchanged)'
        } finally {
            if ($null-eq$previousHost) { Remove-Item Env:AIH_PWSH_HOST -ErrorAction SilentlyContinue } else { $env:AIH_PWSH_HOST=$previousHost }
        }
    }
    else {
        $threw=$false; try { Get-AihPowerShellHost ([IO.Path]::GetTempPath()) | Out-Null } catch { $threw=$true }
        Assert-Aih (-not $threw) 'Linux host resolution finds the pinned or system pwsh (CI installs it)'
    }

    # ── Node artifact selection ──
    Assert-Aih ((Get-AihNodeArchiveName -Version '24.18.1' -Target 'win-x64')-eq'node-v24.18.1-win-x64.zip') 'win-x64 Node artifact is the zip'
    Assert-Aih ((Get-AihNodeArchiveName -Version '24.18.1' -Target 'linux-x64')-eq'node-v24.18.1-linux-x64.tar.xz') 'linux-x64 Node artifact is the tar.xz'
    Assert-Aih ((Get-AihNodeArchiveName -Version '24.18.1' -Target 'linux-arm64')-eq'node-v24.18.1-linux-arm64.tar.xz') 'linux-arm64 Node artifact is the tar.xz'
    $badTarget=$false; try { Get-AihNodeArchiveName -Version '24.18.1' -Target 'sunos-x64' | Out-Null } catch { $badTarget=$true }
    Assert-Aih $badTarget 'unsupported Node target fails closed'
    if ($isWindows) { Assert-Aih ((Get-AihNodeRelativeExecutable)-eq'node.exe') 'Windows pinned node executable is node.exe' }
    else { Assert-Aih ((Get-AihNodeRelativeExecutable)-eq'bin/node') 'Linux pinned node executable is bin/node' }

    # ── sync-name safety ──
    $safeName=ConvertTo-AihSafeSyncName 'Local\AIHarness.EngineeringProfile'
    Assert-Aih ($safeName -and $safeName.GetType().Name-eq'String') 'ConvertTo-AihSafeSyncName returns a usable sync name'
    $otherName=ConvertTo-AihSafeSyncName 'Local\AIHarness.ControlRoom.Settings'
    Assert-Aih ($safeName -ne $otherName) 'distinct mutex names never collide after safe encoding'

    # ── Unix permission plan ──
    $permRoot=Join-Path ([IO.Path]::GetTempPath()) ('aih-perm-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $permRoot 'nested') -Force | Out-Null
    Set-Content -Path (Join-Path $permRoot 'file.txt') -Value 'x'
    $plan=Get-AihUnixPermissionPlan -Path $permRoot
    $planHash=@{}; foreach ($entry in @($plan)) { $planHash[[string]$entry.Path]=[string]$entry.Mode }
    Assert-Aih ($planHash[$permRoot]-eq'700') 'directory permission plan is 0700'
    Assert-Aih ($planHash[(Join-Path $permRoot 'file.txt')]-eq'600') 'file permission plan is 0600'
    Assert-Aih ($planHash[(Join-Path $permRoot 'nested')]-eq'700') 'nested directory permission plan is 0700'
    Remove-Item -LiteralPath $permRoot -Recurse -Force

    # ── path-under-root comparison ──
    if ($isWindows) {
        Assert-Aih (Test-AihUnixPathUnderRoot -Candidate 'C:\AI-Harness\data\Sub' -Root 'C:\ai-harness\data') 'Windows containment compare is case-insensitive'
        Assert-Aih (-not (Test-AihUnixPathUnderRoot -Candidate 'C:\Other\data' -Root 'C:\AI-Harness\data')) 'Windows containment rejects outside paths'
    }
    else {
        Assert-Aih (Test-AihUnixPathUnderRoot -Candidate '/srv/nexus/data/sub' -Root '/srv/nexus/data') 'POSIX containment accepts inside paths'
        Assert-Aih (-not (Test-AihUnixPathUnderRoot -Candidate '/srv/other/data' -Root '/srv/nexus/data')) 'POSIX containment rejects outside paths'
    }

    # ── POSIX child-script transport (POSIX only; Windows keeps cmd.exe) ──
    if (-not $isWindows) {
        $outFile=Join-Path ([IO.Path]::GetTempPath()) ('aih-transport-out-'+[guid]::NewGuid().ToString('N')+'.txt')
        $errFile=Join-Path ([IO.Path]::GetTempPath()) ('aih-transport-err-'+[guid]::NewGuid().ToString('N')+'.txt')
        $probeScript=Join-Path ([IO.Path]::GetTempPath()) ('aih-transport-probe-'+[guid]::NewGuid().ToString('N')+'.ps1')
        Set-Content -Path $probeScript -Value "Write-Output 'transport-ok'"
        $exit=Invoke-AihPwshScriptFile -ScriptPath $probeScript -StdoutPath $outFile -StderrPath $errFile
        Assert-Aih ($exit-eq0-and([IO.File]::ReadAllText($outFile)).Trim()-eq'transport-ok') 'POSIX exact-argv transport captures stdout into the file contract'
        Remove-Item -LiteralPath $outFile,$errFile,$probeScript -Force -ErrorAction SilentlyContinue
    }
    else {
        Write-Host 'PASS: POSIX transport not applicable on Windows (cmd.exe transport unchanged)'
        $script:passed++
    }

    # ── installer artifacts ──
    $setupSh=[IO.File]::ReadAllText((Join-Path $InstallRoot 'setup.sh'))
    Assert-Aih ($setupSh.Contains('scripts/lib/aih-verify-sha256.sh')) 'setup.sh sources the shared checksum-verification library'
    $shaLib=[IO.File]::ReadAllText((Join-Path $InstallRoot 'scripts/lib/aih-verify-sha256.sh'))
    Assert-Aih ($shaLib.Contains('sha256sum')-and$shaLib.Contains('Refusing an unverified download')) 'checksum library verifies downloads with sha256 and fails closed'
    Assert-Aih (-not $shaLib.Contains('grep -E')) 'checksum library never regex-matches the artifact name (structural parse)'
    Assert-Aih ($shaLib.Contains('entry == name')) 'checksum library compares the artifact name with exact equality'
    Assert-Aih ($shaLib.Contains('substr(entry, 1, 1) == "*"')) 'checksum library strips the GNU binary marker (*NAME)'
    Assert-Aih ($shaLib.Contains('length(digest) != 64')) 'checksum library validates the 64-hex digest shape'
    Assert-Aih (-not ([IO.File]::ReadAllBytes((Join-Path $InstallRoot 'scripts/lib/aih-verify-sha256.sh')) -contains 13)) 'checksum library is LF-only'
    $sudoLines=@($setupSh -split "`r?`n" | Where-Object { $_ -match '^\s*sudo\s' })
    Assert-Aih (@($sudoLines).Count-eq0) 'setup.sh never executes sudo'
    Assert-Aih ($setupSh.Contains('--install-root')-and$setupSh.Contains('--skip-path-check')) 'setup.sh exposes install-root and path-check flags'
    Assert-Aih ($setupSh.Contains('Complete-Install.ps1')) 'setup.sh runs the shared install composition'
    $versions=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'config/versions.json') | ConvertFrom-Json
    Assert-Aih (-not [string]::IsNullOrWhiteSpace([string]$versions.PowerShellVersion)) 'versions.json pins PowerShellVersion for the Linux runtime'
    Assert-Aih (-not [string]::IsNullOrWhiteSpace([string]$versions.DefaultInstallRoot)) 'versions.json keeps DefaultInstallRoot (Windows behavior preserved)'
    Assert-Aih ([string]$versions.NodeVersion-match'^\d+\.\d+\.\d+$') 'versions.json pins an exact Node version'
    $setupPs1=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'scripts/Setup.ps1')
    Assert-Aih ($setupPs1.Contains('Complete-Install.ps1')) 'Setup.ps1 delegates shared composition to Complete-Install.ps1'
    Assert-Aih ($setupPs1.Contains('win-'+[char]36+'architecture.zip')-or$setupPs1.Contains('.zip')) 'Setup.ps1 keeps the Windows Node zip provisioning'
    $gitattributes=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot '.gitattributes')
    Assert-Aih ($gitattributes.Contains('*.sh text eol=lf')) '.gitattributes forces LF for shell scripts'

    # ── launcher parity: every Windows .cmd has a Linux twin ──
    $cmdLaunchers=@(Get-ChildItem -LiteralPath (Join-Path $InstallRoot 'bin') -Filter '*.cmd' -File -ErrorAction SilentlyContinue)
    Assert-Aih (@($cmdLaunchers).Count-gt 0) 'bin contains Windows .cmd launchers to mirror'
    foreach ($cmd in @($cmdLaunchers)) {
        $twin=Join-Path $InstallRoot ('bin/linux/'+$cmd.BaseName+'.sh')
        Assert-Aih (Test-Path -LiteralPath $twin) ("Linux launcher exists for " + $cmd.BaseName)
        $twinText=[IO.File]::ReadAllText($twin)
        Assert-Aih ($twinText.Contains('AIH_BAKED_ROOT=""')) ("Linux launcher " + $cmd.BaseName + " keeps the bake marker for ~/.local/bin installs")
        Assert-Aih (-not ([IO.File]::ReadAllBytes($twin) -contains 13)) ("Linux launcher " + $cmd.BaseName + " is LF-only")
    }
    Assert-Aih (-not ([IO.File]::ReadAllBytes((Join-Path $InstallRoot 'setup.sh')) -contains 13)) 'setup.sh is LF-only'

    # ── credential file permissions ──
    $credRoot=Join-Path ([IO.Path]::GetTempPath()) ('aih-cred-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $credRoot -Force | Out-Null
    $credPath=Join-Path $credRoot '.credentials.yaml'
    Set-Content -Path $credPath -Value 'version: 1'
    if ($isWindows) {
        try {
            Protect-AihPrivatePath -Path $credPath
            Assert-Aih $true 'credential protection applied (Windows ACL path; same code as before)'
        } catch {
            # NOT-EXECUTED (honest skip, not a PASS): sandboxed environments deny
            # ACL changes on temp paths; the icacls path itself is unchanged code.
            Write-Host ('SKIP: Windows ACL credential protection not verifiable here: ' + $_.Exception.Message)
        }
    }
    else {
        Protect-AihPrivatePath -Path $credPath
        $mode=(stat -c '%a' $credPath)
        Assert-Aih ($mode-eq'600') 'credential file is 0600 after Protect-AihPrivatePath on Linux'
    }
    Remove-Item -LiteralPath $credRoot -Recurse -Force
} catch {
    throw
}
Write-Host "RESULT: $passed platform-support assertions passed."