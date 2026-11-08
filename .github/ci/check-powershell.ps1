$ErrorActionPreference = 'Stop'
$paths = @(
    'setup.ps1'
    ':(glob)scripts/**/*.ps1'
    ':(glob)scripts/**/*.psm1'
    ':(glob)scripts/**/*.psd1'
    ':(glob)tests/**/*.ps1'
    ':(glob).github/**/*.ps1'
)
$files = git -c core.quotePath=false ls-files -- @paths
if ($LASTEXITCODE -ne 0 -or -not $files) { throw 'Could not enumerate PowerShell sources' }

$failed = $false
foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $PWD.Path $file), [ref]$tokens, [ref]$errors)
    foreach ($parseError in $errors) {
        Write-Host "${file}:$($parseError.Extent.StartLineNumber): $($parseError.Message)"
        $failed = $true
    }
}
if ($failed) { throw 'PowerShell syntax check failed' }
Write-Host "Parsed $($files.Count) PowerShell sources."
