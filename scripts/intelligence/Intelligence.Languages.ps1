Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Phase 3.2B: deterministic language identity & detection ─────────────────
# Languages are declared in an ordered registry. Detection uses deterministic
# evidence only: exact filename, extension, shebang token, module context.
# No AI classification. Third parties can register additional languages.

$script:AihLanguageRegistry = $null

function Get-AihLanguageRegistry {
    if ($null -eq $script:AihLanguageRegistry) {
        $script:AihLanguageRegistry = [ordered]@{
            typescript = @{ canonicalName = 'typescript'; aliases = @('ts', 'tsx'); extensions = @('.ts', '.tsx', '.mts', '.cts'); filenames = @(); shebangTokens = @() }
            javascript = @{ canonicalName = 'javascript'; aliases = @('js', 'jsx', 'node'); extensions = @('.js', '.jsx', '.mjs', '.cjs'); filenames = @(); shebangTokens = @('node') }
            csharp     = @{ canonicalName = 'csharp'; aliases = @('cs', 'c#'); extensions = @('.cs'); filenames = @(); shebangTokens = @() }
            python     = @{ canonicalName = 'python'; aliases = @('py', 'python3'); extensions = @('.py', '.pyw'); filenames = @(); shebangTokens = @('python') }
            powershell = @{ canonicalName = 'powershell'; aliases = @('ps', 'pwsh'); extensions = @('.ps1', '.psm1', '.psd1'); filenames = @(); shebangTokens = @('pwsh', 'powershell') }
            rust       = @{ canonicalName = 'rust'; aliases = @('rs'); extensions = @('.rs'); filenames = @(); shebangTokens = @() }
            go         = @{ canonicalName = 'go'; aliases = @('golang'); extensions = @('.go'); filenames = @(); shebangTokens = @() }
            java       = @{ canonicalName = 'java'; aliases = @(); extensions = @('.java'); filenames = @(); shebangTokens = @() }
            json       = @{ canonicalName = 'json'; aliases = @(); extensions = @('.json', '.jsonc'); filenames = @(); shebangTokens = @() }
            yaml       = @{ canonicalName = 'yaml'; aliases = @('yml'); extensions = @('.yml', '.yaml'); filenames = @(); shebangTokens = @() }
            markdown   = @{ canonicalName = 'markdown'; aliases = @('md'); extensions = @('.md', '.markdown'); filenames = @(); shebangTokens = @() }
        }
    }
    return $script:AihLanguageRegistry
}

function Register-AihLanguage {
    # Adds or overrides a language definition (extension point; no core rewrites).
    param(
        [Parameter(Mandatory = $true)][string]$CanonicalName,
        [string[]]$Extensions = @(),
        [string[]]$Aliases = @(),
        [string[]]$Filenames = @(),
        [string[]]$ShebangTokens = @()
    )
    $registry = Get-AihLanguageRegistry
    $registry[$CanonicalName] = @{
        canonicalName = $CanonicalName; aliases = @($Aliases); extensions = @($Extensions)
        filenames = @($Filenames); shebangTokens = @($ShebangTokens)
    }
    return $registry[$CanonicalName]
}

function Get-AihLanguageDetection {
    # Deterministic language detection for one inventory path.
    # Evidence priority: exact filename > extension > shebang > module hint.
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [string]$FirstLine = '',
        [string]$ModuleHint = ''
    )
    $registry = Get-AihLanguageRegistry
    $fileName = ($RelativePath -replace '\\', '/') -replace '.*/', ''
    $lowerName = $fileName.ToLowerInvariant()
    foreach ($languageName in $registry.Keys) {
        $language = $registry[$languageName]
        if (@($language.filenames) -contains $lowerName) {
            return [pscustomobject][ordered]@{ language = $language.canonicalName; evidence = 'filename'; detectedBy = $fileName }
        }
    }
    $dot = $lowerName.LastIndexOf('.')
    if ($dot -ge 0) {
        $extension = $lowerName.Substring($dot)
        foreach ($languageName in $registry.Keys) {
            $language = $registry[$languageName]
            if (@($language.extensions) -contains $extension) {
                return [pscustomobject][ordered]@{ language = $language.canonicalName; evidence = 'extension'; detectedBy = $extension }
            }
        }
    }
    if (-not [string]::IsNullOrEmpty($FirstLine) -and $FirstLine.TrimStart().StartsWith('#!')) {
        foreach ($languageName in $registry.Keys) {
            $language = $registry[$languageName]
            foreach ($token in @($language.shebangTokens)) {
                if ($FirstLine.ToLowerInvariant().Contains($token)) {
                    return [pscustomobject][ordered]@{ language = $language.canonicalName; evidence = 'shebang'; detectedBy = $token }
                }
            }
        }
    }
    if (-not [string]::IsNullOrEmpty($ModuleHint)) {
        foreach ($languageName in $registry.Keys) {
            $language = $registry[$languageName]
            if (@($language.aliases) -contains $ModuleHint.ToLowerInvariant()) {
                return [pscustomobject][ordered]@{ language = $language.canonicalName; evidence = 'module-context'; detectedBy = $ModuleHint }
            }
        }
    }
    return $null
}
