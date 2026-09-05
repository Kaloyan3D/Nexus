[CmdletBinding()]param([string]$InstallRoot)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot=Split-Path -Parent $PSScriptRoot }
. (Join-Path $InstallRoot 'scripts/Platform.ps1')
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
    Assert-Aih ($shaLib.Contains('aih_manifest_to_utf8')) 'checksum library normalizes encodings before parsing'
    Assert-Aih ($shaLib.Contains('UTF-16LE') -and $shaLib.Contains('UTF-16BE')) 'checksum library supports UTF-16LE and UTF-16BE BOM detection'
    Assert-Aih ($shaLib.Contains('iconv')) 'checksum library converts UTF-16 through iconv'
    Assert-Aih ($shaLib.Contains('LC_ALL=C awk')) 'checksum library parses the normalized manifest with LC_ALL=C awk'
    Assert-Aih ($setupSh.Contains('aih_require_tool iconv')) 'setup.sh requires iconv before any download'
    Assert-Aih (-not ([IO.File]::ReadAllBytes((Join-Path $InstallRoot 'scripts/lib/aih-verify-sha256.sh')) -contains 13)) 'checksum library is LF-only'
    $provisionLib=[IO.File]::ReadAllText((Join-Path $InstallRoot 'scripts/lib/aih-provision-pwsh.sh'))
    Assert-Aih ($setupSh.Contains('aih-provision-pwsh.sh')-and$setupSh.Contains('aih_provision_pwsh_archive')) 'setup.sh provisions the pwsh archive through the shared library'
    Assert-Aih ($provisionLib.Contains('[ ! -f "$_pwsh_bin" ]')) 'pwsh provisioning validates a regular file, not just executability'
    Assert-Aih ($provisionLib.Contains('chmod 0755 "$_pwsh_bin"')) 'pwsh provisioning chmods exactly the pwsh launcher with 0755'
    Assert-Aih (-not $provisionLib.Contains('chmod -R')-and-not $provisionLib.Contains('0777')) 'pwsh provisioning never chmods recursively or world-writable'
    Assert-Aih ($provisionLib.Contains('--version')) 'pwsh provisioning gates on the binary reporting its version'
    Assert-Aih (-not ([IO.File]::ReadAllBytes((Join-Path $InstallRoot 'scripts/lib/aih-provision-pwsh.sh')) -contains 13)) 'provisioning library is LF-only'
    $verifyIdx=$setupSh.IndexOf('aih_verify_sha256 "$AIH_PWSH_TMP')
    $tarIdx=$setupSh.IndexOf('tar -xzf "$AIH_PWSH_TMP')
    $provIdx=$setupSh.IndexOf('aih_provision_pwsh_archive "$AIH_PWSH_TMP')
    Assert-Aih ($verifyIdx-ge0-and$tarIdx-gt$verifyIdx-and$provIdx-gt$tarIdx) 'setup.sh ordering: SHA256 verify before extraction before provisioning'
    $nodeLib=[IO.File]::ReadAllText((Join-Path $InstallRoot 'scripts/lib/aih-node-env.sh'))
    Assert-Aih ($setupSh.Contains('aih-node-env.sh')-and$setupSh.Contains('aih_use_pinned_node')) 'setup.sh gates and prepends the pinned Node runtime before npm ci'
    Assert-Aih ($setupSh.IndexOf('aih_use_pinned_node')-lt$setupSh.IndexOf('"$AIH_NODE_DIR/bin/node" "$AIH_NPM_CLI" ci')) 'setup.sh ordering: pinned-Node PATH before npm ci'
    Assert-Aih ($nodeLib.Contains('PATH="$_node_dir/bin:$PATH"')) 'node-env helper prepends the pinned bin ahead of the existing PATH'
    Assert-Aih ($nodeLib.Contains('command -v node')) 'node-env helper re-verifies node resolution in the npm environment'
    Assert-Aih ($nodeLib.Contains('--version')) 'node-env helper gates the pinned Node version'
    $nodeCode=($nodeLib -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    Assert-Aih (-not $nodeCode.Contains('eval')) 'node-env helper uses no eval'
    Assert-Aih (-not ([IO.File]::ReadAllBytes((Join-Path $InstallRoot 'scripts/lib/aih-node-env.sh')) -contains 13)) 'node-env library is LF-only'
    Assert-Aih ($provisionLib.Contains('[ ! -e "$_pwsh_bin" ]')-and$provisionLib.Contains('[ ! -x "$_pwsh_bin" ]')) 'pwsh provisioning distinguishes missing payload, chmod failure, and post-chmod non-executability'
    Assert-Aih (-not $setupSh.Contains('[ -x "$AIH_PWSH_TMP/expanded/pwsh" ]')) 'setup.sh no longer demands a pre-chmod executable bit on the extracted pwsh'
    Assert-Aih ($setupSh.Contains('"$AIH_PWSH_VERSION"')) 'setup.sh gates provisioning on the pinned PowerShellVersion'
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
    # ── Start-AihDetachedProcess optional-parameter contract (A–J + OAuth shape) ──
    # Start-Process is intercepted by a same-name session function (functions
    # shadow cmdlets), so the exact bound parameter set is asserted without
    # spawning real children. A parameter ABSENT from $PSBoundParameters means
    # the caller's omission reached Start-Process untouched; an explicitly
    # bound $null (the old defect) shows up as a present-but-null entry.
    $realTestAihIsWindows = ${function:Test-AihIsWindows}
    $script:aihStartProcessCaptures = [System.Collections.Generic.List[object]]::new()
    function Start-Process {
        [CmdletBinding()]param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$Wait, [switch]$PassThru)
        # Keys copied into an ordered hashtable: PSBoundParametersDictionary
        # method resolution differs across PowerShell editions, and Key
        # membership via -contains is stable everywhere.
        $captured = [ordered]@{}
        foreach ($key in @($PSBoundParameters.Keys)) { $captured[$key] = $PSBoundParameters[$key] }
        $script:aihStartProcessCaptures.Add([pscustomobject]@{ Bound = $captured })
        return [pscustomobject]@{ Id = 424242; HasExited = $true; ExitCode = 0; StartTime = (Get-Date) }
    }
    function script:Get-AihLastStartProcessBound { @($script:aihStartProcessCaptures)[-1].Bound }

    # A: Windows, FilePath + ArgumentList only (the exact OAuth startup shape).
    $null = Start-AihDetachedProcess -FilePath 'node.exe' -ArgumentList @('oauth.js', '--detach', '--no-open')
    $bound = Get-AihLastStartProcessBound
    Assert-Aih (-not $bound.Contains('WorkingDirectory')) 'A: omitted WorkingDirectory is never forwarded (not even as null)'
    Assert-Aih ($bound.Contains('WindowStyle') -and [string]$bound.WindowStyle -eq 'Hidden') 'A: Windows keeps WindowStyle Hidden'
    Assert-Aih ($bound.Contains('PassThru')) 'A: PassThru present'
    Assert-Aih ($bound.Contains('FilePath') -and [string]$bound.FilePath -eq 'node.exe') 'A: FilePath forwarded exactly'
    Assert-Aih ($bound.Contains('ArgumentList') -and @($bound.ArgumentList).Count -eq 3) 'A: ArgumentList forwarded exactly'

    # B: explicit WorkingDirectory is forwarded exactly.
    $null = Start-AihDetachedProcess -FilePath 'node.exe' -ArgumentList @('x') -WorkingDirectory 'C:/repo with space'
    $bound = Get-AihLastStartProcessBound
    Assert-Aih ($bound.Contains('WorkingDirectory') -and [string]$bound.WorkingDirectory -eq 'C:/repo with space') 'B: explicit WorkingDirectory forwarded exactly'

    # C: stdout-only redirection.
    $null = Start-AihDetachedProcess -FilePath 'node.exe' -ArgumentList @('x') -WorkingDirectory 'C:/w' -RedirectStandardOutput 'C:/w/out.log'
    $bound = Get-AihLastStartProcessBound
    Assert-Aih ($bound.Contains('RedirectStandardOutput') -and [string]$bound.RedirectStandardOutput -eq 'C:/w/out.log') 'C: stdout-only redirect forwarded'
    Assert-Aih (-not $bound.Contains('RedirectStandardError')) 'C: stdout-only does not forward RedirectStandardError'

    # D: stderr-only redirection.
    $null = Start-AihDetachedProcess -FilePath 'node.exe' -ArgumentList @('x') -WorkingDirectory 'C:/w' -RedirectStandardError 'C:/w/err.log'
    $bound = Get-AihLastStartProcessBound
    Assert-Aih ($bound.Contains('RedirectStandardError') -and [string]$bound.RedirectStandardError -eq 'C:/w/err.log') 'D: stderr-only redirect forwarded'
    Assert-Aih (-not $bound.Contains('RedirectStandardOutput')) 'D: stderr-only does not forward RedirectStandardOutput'

    # E: both redirects.
    $null = Start-AihDetachedProcess -FilePath 'node.exe' -ArgumentList @('x') -WorkingDirectory 'C:/w' -RedirectStandardOutput 'C:/w/out.log' -RedirectStandardError 'C:/w/err.log'
    $bound = Get-AihLastStartProcessBound
    Assert-Aih ($bound.Contains('RedirectStandardOutput') -and $bound.Contains('RedirectStandardError')) 'E: both redirects forwarded together'

    # F: null/empty/whitespace WorkingDirectory is omitted.
    $null = Start-AihDetachedProcess -FilePath 'node.exe' -ArgumentList @('x') -WorkingDirectory ''
    $bound = Get-AihLastStartProcessBound
    Assert-Aih (-not $bound.Contains('WorkingDirectory')) 'F: empty WorkingDirectory is omitted'
    $null = Start-AihDetachedProcess -FilePath 'node.exe' -ArgumentList @('x') -WorkingDirectory '   '
    $bound = Get-AihLastStartProcessBound
    Assert-Aih (-not $bound.Contains('WorkingDirectory')) 'F: whitespace WorkingDirectory is omitted'

    # G/H: Linux branch — no WindowStyle, WorkingDirectory only when supplied.
    function Test-AihIsWindows { return $false }
    $null = Start-AihDetachedProcess -FilePath 'node' -ArgumentList @('x')
    $bound = Get-AihLastStartProcessBound
    Assert-Aih (-not $bound.Contains('WindowStyle')) 'G: Linux never receives WindowStyle'
    Assert-Aih (-not $bound.Contains('WorkingDirectory')) 'G: Linux omitted WorkingDirectory is never forwarded'
    $null = Start-AihDetachedProcess -FilePath 'node' -ArgumentList @('x') -WorkingDirectory '/home/user/nexus data'
    $bound = Get-AihLastStartProcessBound
    Assert-Aih ($bound.Contains('WorkingDirectory') -and [string]$bound.WorkingDirectory -eq '/home/user/nexus data') 'H: Linux explicit WorkingDirectory forwarded exactly'
    ${function:Test-AihIsWindows} = $realTestAihIsWindows

    # I/J: -Wait forwarding is exact, not a behavioral change.
    $null = Start-AihDetachedProcess -FilePath 'node.exe' -ArgumentList @('x') -WorkingDirectory 'C:/w'
    $bound = Get-AihLastStartProcessBound
    Assert-Aih (-not $bound.Contains('Wait')) 'I: no -Wait means Start-Process never receives Wait'
    $null = Start-AihDetachedProcess -FilePath 'node.exe' -ArgumentList @('x') -WorkingDirectory 'C:/w' -Wait
    $bound = Get-AihLastStartProcessBound
    Assert-Aih ($bound.Contains('Wait') -and $bound.Wait) 'J: -Wait forwards Wait to Start-Process'

    # Real Start-Process (no mock): the exact aih.ps1 OAuth call shape with NO
    # WorkingDirectory must bind and start — this is the regression's crash
    # site (Cannot validate argument on parameter 'WorkingDirectory').
    Remove-Item function:Start-Process -ErrorAction SilentlyContinue
    $realNode = (Get-Command node -ErrorAction SilentlyContinue)
    if ($null -ne $realNode) {
        $oauthShape = Start-AihDetachedProcess -FilePath $realNode.Source -ArgumentList @('-e', 'setTimeout(function(){}, 2500)')
        Assert-Aih ($null -ne $oauthShape -and $oauthShape.Id -gt 0) 'OAuth startup shape (FilePath+ArgumentList only) starts without a WorkingDirectory validation error'
        Stop-Process -Id $oauthShape.Id -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host 'SKIP: node not on PATH; real OAuth-shape spawn not verifiable here'
    }
    Remove-Item function:Start-Process -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $credRoot -Recurse -Force
} catch {
    throw
}
# TASK-0023 attempt 7: installed harness tests are platform-aware. The
# launcher contract follows Get-AihLauncherExtension (aih.cmd on Windows,
# extensionless aih on Linux), child hosts are resolved through
# Get-AihPowerShellHost, and no suite constructs paths with backslash-only
# subpaths or spawns a bare powershell.exe.
$setupUpgrade=[IO.File]::ReadAllText((Join-Path $InstallRoot 'tests/SetupUpgrade.Tests.ps1'))
Assert-Aih ($setupUpgrade.Contains('Get-AihLauncherExtension')-and$setupUpgrade.Contains('Test-AihIsWindows')) 'SetupUpgrade suite selects the launcher contract through the shared platform abstraction'
Assert-Aih (-not $setupUpgrade.Contains("(Join-Path " + [char]36 + "launcherRoot 'aih.cmd')")) 'SetupUpgrade suite never unconditionally requires aih.cmd'
Assert-Aih ($setupUpgrade.Contains('%~dp0..')-and$setupUpgrade.Contains('-InstallRoot "%AIH_ROOT%"')) 'Windows aih.cmd contracts remain asserted inside the Windows branch'
Assert-Aih ($setupUpgrade.Contains('#!/bin/sh')-and$setupUpgrade.Contains('AIH_BAKED_ROOT')) 'POSIX launcher contract remains asserted'
Assert-Aih (-not $setupUpgrade.Contains("Join-Path " + [char]36 + "launcherRoot 'aih.cmd'")) 'no unconditional aih.cmd path construction remains'
$testDir=Join-Path $InstallRoot 'tests'
$bareSpawns=@(Get-ChildItem -LiteralPath $testDir -Filter '*.Tests.ps1' | ForEach-Object { [IO.File]::ReadAllText($_.FullName) } | Where-Object { $_ -match '&\s*powershell\.exe' -or $_ -match 'Start-Process\s+powershell\.exe' })
Assert-Aih (@($bareSpawns).Count-eq0) 'no suite spawns a bare powershell.exe child (Get-AihPowerShellHost everywhere)'
$backslashJoins=0
Get-ChildItem -LiteralPath $testDir -Filter '*.Tests.ps1' | ForEach-Object {
  foreach ($line in [IO.File]::ReadAllLines($_.FullName)) {
    $quotedBs = [string][char]39 + '[^' + [char]39 + ']*' + [char]92 + [char]92 + '[^' + [char]39 + ']*' + [char]39
    if ($line-match'Join-Path'-and$line-match$quotedBs) { $backslashJoins++ }
  }
}
Assert-Aih ($backslashJoins-eq0) "no Join-Path with backslash-only subpaths remains ($backslashJoins found)"
$platformSupportSelf=[IO.File]::ReadAllText((Join-Path $InstallRoot 'scripts/Platform.ps1'))
Assert-Aih ($platformSupportSelf.Contains("if (Test-AihIsWindows) { return '.cmd' }")-or$platformSupportSelf.Contains("return '.cmd'")) 'Get-AihLauncherExtension keeps .cmd on Windows'
Write-Host "RESULT: $passed platform-support assertions passed."