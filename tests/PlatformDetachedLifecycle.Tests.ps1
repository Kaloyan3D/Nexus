$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'scripts/Common.ps1')
$node = Get-AihNodeExecutable
$pwsh = Get-AihPowerShellHost -InstallRoot $root
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('aih detach ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$child = Join-Path $tmp 'child.js'
$launcher = Join-Path $tmp 'launcher.ps1'
$stdout = Join-Path $tmp 'stdout.log'
$stderr = Join-Path $tmp 'stderr.log'
$pidFile = Join-Path $tmp 'pid.txt'
[IO.File]::WriteAllText($child, 'console.log(process.cwd()); console.log(process.argv[2]); console.error("stderr-marker"); setInterval(() => {}, 1000)')
[IO.File]::WriteAllText($launcher, @'
param($Root,$Node,$Child)
. (Join-Path $Root 'scripts/Platform.ps1')
$base = Split-Path -Parent $Child
$p = Start-AihDetachedProcess -FilePath $Node -ArgumentList @($Child, 'argument with spaces') -WorkingDirectory $base -RedirectStandardOutput (Join-Path $base 'stdout.log') -RedirectStandardError (Join-Path $base 'stderr.log')
[IO.File]::WriteAllText((Join-Path $base 'pid.txt'), [string]$p.Id)
[IO.File]::WriteAllText((Join-Path $base 'sid.txt'), [string](& ps -o sid= -p $p.Id).Trim())
'@)
try {
    & $pwsh -NoProfile -File $launcher $root $node $child
    $pidValue = [int]([IO.File]::ReadAllText($pidFile))
    $sidValue = [int]([IO.File]::ReadAllText((Join-Path $tmp 'sid.txt')))
    if ($sidValue -ne $pidValue) { throw "Child shares launcher session (SID $sidValue, PID $pidValue)." }
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($null -eq $proc) { throw 'Detached child did not survive launcher completion.' }
    if ([IO.Path]::GetFullPath($proc.Path) -ne [IO.Path]::GetFullPath($node)) { throw 'Returned PID is not the Node child.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    while ([DateTime]::UtcNow -lt $deadline -and -not ((Test-Path $stdout) -and (Test-Path $stderr) -and ((Get-Content -Raw $stdout) -match [regex]::Escape($tmp)) -and ((Get-Content -Raw $stderr) -match 'stderr-marker'))) { Start-Sleep -Milliseconds 50 }
    if (-not ((Get-Content -Raw $stdout) -match [regex]::Escape($tmp))) { throw 'Working directory or stdout redirect failed.' }
    if (-not ((Get-Content -Raw $stdout) -match 'argument with spaces')) { throw 'Argument with spaces was not preserved.' }
    if (-not ((Get-Content -Raw $stderr) -match 'stderr-marker')) { throw 'Stderr redirect failed.' }
    Write-Host 'PASS: Linux child survives launcher with exact PID, cwd and independent logs.'
    $exitScript = Join-Path $tmp 'exit.js'
    [IO.File]::WriteAllText($exitScript, 'process.exit(7)')
    $waited = Start-AihDetachedProcess -FilePath $node -ArgumentList @($exitScript) -Wait
    if (-not $waited.HasExited -or $waited.ExitCode -ne 7) { throw 'Linux Wait did not preserve the child exit code.' }
    Write-Host 'PASS: Linux Wait preserves process exit status.'
}
finally {
    if (Test-Path $pidFile) { Stop-Process -Id ([int]([IO.File]::ReadAllText($pidFile))) -Force -ErrorAction SilentlyContinue }
    Remove-Item $tmp -Recurse -Force
}
$originalWindows = ${function:Test-AihIsWindows}
try {
    ${function:Test-AihIsWindows} = { $true }
    function Start-Process {
        param($FilePath,$ArgumentList,$WorkingDirectory,$RedirectStandardOutput,$RedirectStandardError,$WindowStyle,[switch]$Wait,[switch]$PassThru)
        $script:windowsBound = @($PSBoundParameters.Keys)
        [pscustomobject]@{ Id = 123 }
    }
    $null = Start-AihDetachedProcess -FilePath 'node.exe' -ArgumentList @('child.js') -RedirectStandardError 'error.log'
    if ($script:windowsBound -notcontains 'WindowStyle' -or $script:windowsBound -contains 'WorkingDirectory' -or $script:windowsBound -contains 'RedirectStandardOutput' -or $script:windowsBound -notcontains 'RedirectStandardError') { throw 'Windows Start-Process parameter contract changed.' }
    Write-Host 'PASS: Windows Start-Process behavior remains unchanged.'
}
finally {
    ${function:Test-AihIsWindows} = $originalWindows
    Remove-Item function:Start-Process -ErrorAction SilentlyContinue
}
