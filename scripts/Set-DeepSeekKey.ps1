[CmdletBinding()]
param([string]$InstallRoot)

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot
New-Item -ItemType Directory -Force -Path $layout.Data | Out-Null

$secure = Read-Host 'Enter DEEPSEEK_API_KEY (input is hidden)' -AsSecureString
if (Test-AihIsWindows) {
    # Windows: BSTR interop (unchanged behavior).
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}
else {
    # BSTR/COM interop is unavailable on non-Windows runtimes; pwsh 7
    # exposes the same secret through ConvertFrom-SecureString -AsPlainText.
    $plain = $secure | ConvertFrom-SecureString -AsPlainText
}
try {
    if ([string]::IsNullOrWhiteSpace($plain)) {
        throw 'No API key was entered.'
    }
    $escaped = $plain.Trim().Replace("'", "''")
    $credentialDocument = "version: 1`r`nrefs:`r`n  DEEPSEEK_API_KEY: '$escaped'`r`n"
    [System.IO.File]::WriteAllText($layout.Credentials, $credentialDocument, [System.Text.UTF8Encoding]::new($false))
    Protect-AihPrivatePath -Path $layout.Credentials
}
finally {
    $plain = $null
}
Write-Host "DeepSeek credential stored in the protected Harness credential store."
