[CmdletBinding()]
param([string]$InstallRoot = 'C:\AI-Harness')

. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot
New-Item -ItemType Directory -Force -Path $layout.Data | Out-Null

$secure = Read-Host 'Enter DEEPSEEK_API_KEY (input is hidden)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($plain)) {
        throw 'No API key was entered.'
    }
    $escaped = $plain.Trim().Replace("'", "''")
    [System.IO.File]::WriteAllText($layout.Credentials, "DEEPSEEK_API_KEY: '$escaped'`r`n", [System.Text.UTF8Encoding]::new($false))
    Protect-AihPrivatePath -Path $layout.Credentials
}
finally {
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $plain = $null
}
Write-Host "DeepSeek credential stored in the protected Harness credential store."
