[CmdletBinding()]
param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts/Platform.ps1')
if (Test-AihIsWindows) { throw 'Native symlink permission regression requires Linux; Windows behavior remains unverified.' }
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('r75-private-' + [guid]::NewGuid().ToString('N'))
try {
    $private = Join-Path $scratch 'private'
    $outside = Join-Path $scratch 'outside'
    New-Item -ItemType Directory -Path $private, $outside -Force | Out-Null
    $sentinel = Join-Path $outside 'sentinel'
    [IO.File]::WriteAllText($sentinel, 'isolated outside private boundary')
    & chmod 0755 $outside
    & chmod 0644 $sentinel
    $dirLink = Join-Path $private 'directory-link'
    $fileLink = Join-Path $private 'file-link'
    New-Item -ItemType SymbolicLink -Path $dirLink -Target $outside | Out-Null
    New-Item -ItemType SymbolicLink -Path $fileLink -Target $sentinel | Out-Null
    $plan = @(Get-AihUnixPermissionPlan -Path $private)
    if ($plan.Count -ne 1 -or $plan[0].Path -ne $private) { throw 'FAIL: private permission plan follows symlinks outside its ownership boundary' }
    Write-Host 'PASS: private plan includes only owned root, never directory/file symlinks'
    Protect-AihPrivatePath -Path $private
    if ((& stat -c '%a' $sentinel) -ne '644' -or (& stat -c '%a' $outside) -ne '755') { throw 'FAIL: outside permissions changed' }
    Write-Host 'PASS: applying private plan preserves outside permissions'
    if (@(Get-AihUnixPermissionPlan -Path $dirLink).Count -ne 0) { throw 'FAIL: symlink root is traversed' }
    Write-Host 'PASS: a symlink root cannot escape the boundary'
    Write-Host 'SUITE RESULT: PASS 3 | FAIL 0 | total 3'
} finally {
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
