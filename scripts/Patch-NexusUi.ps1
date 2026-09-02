[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$SourceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Nexus UI customization installer. Runs AFTER npm ci (and after the Control
# Room compatibility patch) and recreates the branded Nexus interface:
#   1. installs the @nexus/ui-brand package into the profile module fallback
#   1b. installs the @nexus/controller package (live Controller panel: host
#       read-only status route + client panel) into the profile module fallback
#   1c. ensures the @nexus/controller composition row exists in data/cordis.patch.yml
#   2. patches the built web frontend dist (title / favicon / manifest)
#   3. patches the installed client bundles that own runtime brand copy
# The brand copy text lives in ui\nexus-ui\patch-copy.json (UTF-8); this
# driver stays ASCII. Every step is deterministic and idempotent: a pair is
# replaced when the source is present exactly once, skipped when the target is
# already present (second run), and the script FAILS when the pinned upstream
# structure changed in an ambiguous way. Regexes tolerate CRLF vs LF.

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = Split-Path -Parent $PSScriptRoot
}

. (Join-Path $PSScriptRoot 'Common.ps1')
$layout = Get-AihLayout $InstallRoot

$frontendDir = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-web-frontend'
$frontendManifestPath = Join-Path $frontendDir 'package.json'
if (-not (Test-Path -LiteralPath $frontendManifestPath)) {
    throw 'The pinned web frontend package is missing. Run npm ci before applying the Nexus UI patch.'
}
$frontendManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $frontendManifestPath | ConvertFrom-Json
if ([string]$frontendManifest.version -ne '0.1.1-rc.2') {
    throw "Nexus UI patch supports @deepseek-ai/dsh-web-frontend 0.1.1-rc.2, found $($frontendManifest.version)."
}

$nexusSource = Join-Path $SourceRoot 'ui\nexus-ui'
$copyPath = Join-Path $nexusSource 'patch-copy.json'
if (-not (Test-Path -LiteralPath $copyPath)) {
    throw "Nexus UI source copy missing at $copyPath"
}
$copy = Get-Content -Raw -Encoding UTF8 -LiteralPath $copyPath | ConvertFrom-Json

function Assert-SingleMatch {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$What,
        [string]$Path
    )
    $count = ([regex]::Matches($Text, $Pattern, 'Singleline')).Count
    if ($count -ne 1) {
        throw "Pinned UI structure changed for $What (matches: $count) in $Path. Refusing an unsafe patch."
    }
}

# Apply one { from, to } copy pair with idempotent + fail-closed semantics.
# Returns the new text and whether anything changed.
function Update-AihCopyPair {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$From,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$To,
        [Parameter(Mandatory = $true)][string]$What,
        [Parameter(Mandatory = $true)][string]$Path
    )
    if ($From -eq '') {
        throw "Empty 'from' for $What in patch-copy.json"
    }
    $count = ([regex]::Matches($Text, [regex]::Escape($From), 'Singleline')).Count
    if ($count -eq 0) {
        $already = $To -ne '' -and $Text.Contains($To)
        if ($already) { return @($Text, $false) }
        throw "Pinned UI structure changed for $What in ${Path}: source string absent and target not present. Refusing an unsafe patch."
    }
    if ($count -ne 1) {
        throw "Pinned UI structure changed for $What (matches: $count) in $Path. Refusing an unsafe patch."
    }
    return @($Text.Replace($From, $To), $true)
}

function Write-AihUtf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

# --- 1. install @nexus/ui-brand into the profile module fallback ------------
# Node resolves profile plugins from $DSH_HOME\profiles\node_modules (the same
# directory dsh's own healProfilesModuleFallback manages). A fresh copy on every
# run keeps the installed package byte-identical to the source tree.
$profileModules = Join-Path $layout.Data 'profiles\node_modules'
New-Item -ItemType Directory -Force -Path $profileModules | Out-Null
$nexusTarget = Join-Path $profileModules '@nexus\ui-brand'
if (Test-Path -LiteralPath $nexusTarget) {
    Remove-Item -LiteralPath $nexusTarget -Recurse -Force
}
Copy-Item -LiteralPath $nexusSource -Destination $nexusTarget -Recurse -Force
if (-not (Test-Path -LiteralPath (Join-Path $nexusTarget 'package.json'))) {
    throw "Failed to install @nexus/ui-brand into $profileModules"
}

# --- 1b. install @nexus/controller into the profile module fallback ----------
# The live Controller panel (host read-only status route + client panel).
# Same deterministic fresh-copy semantics as the brand package.
$controllerSource = Join-Path $SourceRoot 'ui\nexus-controller'
$controllerTarget = Join-Path $profileModules '@nexus\controller'
if (Test-Path -LiteralPath $controllerTarget) {
    Remove-Item -LiteralPath $controllerTarget -Recurse -Force
}
Copy-Item -LiteralPath $controllerSource -Destination $controllerTarget -Recurse -Force
if (-not (Test-Path -LiteralPath (Join-Path $controllerTarget 'package.json'))) {
    throw "Failed to install @nexus/controller into $profileModules"
}
foreach ($controllerFile in @('lib\index.js', 'lib\client.js', 'lib\status.cjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $controllerTarget $controllerFile))) {
        throw "Failed to install @nexus/controller $controllerFile into $profileModules"
    }
}

# --- 1c. ensure the @nexus/controller composition row ------------------------
# The home patch (config/home.cordis.patch.yml -> data/cordis.patch.yml) carries
# the row; Setup.ps1 copies it. When the patch script runs standalone on an
# install whose data copy predates the row, insert it idempotently (fail-closed
# when the shape is ambiguous).
$cordisPatchPath = Join-Path $layout.Data 'cordis.patch.yml'
if (Test-Path -LiteralPath $cordisPatchPath) {
    $cordisText = Get-Content -Raw -Encoding UTF8 -LiteralPath $cordisPatchPath
    if (-not $cordisText.Contains("'@nexus/controller'")) {
        if (-not $cordisText.Contains("    - id: nexus-ui-brand")) {
            throw "cordis.patch.yml structure changed; cannot insert the @nexus/controller row. Refusing an unsafe patch."
        }
        $crlf = [string][char]13 + [string][char]10
        $lf = [string][char]10
        $nl = if ($cordisText.Contains($crlf)) { $crlf } else { $lf }
        $row = $nl + '    - id: nexus-controller' + $nl + "      name: '@nexus/controller'" + $nl
        $cordisText = $cordisText.Replace('    - id: nexus-ui-brand', '    - id: nexus-ui-brand' + $row)
        Write-AihUtf8NoBom -Path $cordisPatchPath -Content $cordisText
    }
    # The controller row must stay ENABLED: the previous composition disabled it
    # (its invalid details-seat registration broke the client boot). Strip any
    # `disabled: true` line that belongs to the nexus-controller row — the live
    # loader must never see it again. Idempotent, CRLF/LF tolerant, and scoped to
    # the controller row only (other rows keep their own flags).
    $controllerRowPattern = '(?m)^(    - id: nexus-controller\r?\n      name: ''@nexus/controller''\r?\n)(      disabled: true\r?\n)?'
    $cordisText = [regex]::Replace($cordisText, $controllerRowPattern, '$1')
    if ($cordisText.Contains("disabled: true") -and $cordisText -match '(?m)^    - id: nexus-controller\r?\n      name: ''@nexus/controller''\r?\n      disabled: true') {
        throw 'cordis.patch.yml nexus-controller row still disabled after strip; refusing an unsafe patch.'
    }
    Write-AihUtf8NoBom -Path $cordisPatchPath -Content $cordisText
}

# --- 2. web frontend dist patches --------------------------------------------
$distDir = Join-Path $frontendDir 'dist'

# 2a. index.html title (pre-JS shell title; the renderer patch covers runtime).
$indexPath = Join-Path $distDir 'index.html'
if (-not (Test-Path -LiteralPath $indexPath)) { throw "dist index.html missing at $indexPath" }
$indexText = Get-Content -Raw -Encoding UTF8 -LiteralPath $indexPath
$indexPair = Update-AihCopyPair -Text $indexText -From $copy.indexHtmlTitle.from -To $copy.indexHtmlTitle.to -What 'index.html title' -Path $indexPath
if ($indexPair[1]) { Write-AihUtf8NoBom -Path $indexPath -Content $indexPair[0] }

# 2b. favicon.svg - replace the DeepSeek whale favicon with the Nexus mark.
$faviconPath = Join-Path $distDir 'favicon.svg'
if (-not (Test-Path -LiteralPath $faviconPath)) { throw "dist favicon.svg missing at $faviconPath" }
$faviconSource = Join-Path $nexusSource 'nexus-favicon.svg'
if (-not (Test-Path -LiteralPath $faviconSource)) { throw "Nexus favicon source missing at $faviconSource" }
Copy-Item -LiteralPath $faviconSource -Destination $faviconPath -Force

# 2c. manifest.webmanifest - PWA identity follows the product name.
$manifestPath = Join-Path $distDir 'manifest.webmanifest'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "dist manifest.webmanifest missing at $manifestPath" }
$manifestRaw = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath
$manifest = $null
try { $manifest = $manifestRaw | ConvertFrom-Json } catch { throw "manifest.webmanifest is not valid JSON at $manifestPath" }
if ($null -eq $manifest -or -not ($manifest.PSObject.Properties['name']) -or -not ($manifest.PSObject.Properties['short_name'])) {
    throw 'manifest.webmanifest no longer carries name/short_name. Refusing an unsafe patch.'
}
$manifest.name = 'Nexus'
$manifest.short_name = 'Nexus'
Write-AihUtf8NoBom -Path $manifestPath -Content ($manifest | ConvertTo-Json -Depth 10)

# 2d. brand assets - official Nexus logo + icon mark for the client plugin.
$distAssets = Join-Path $distDir 'assets'
New-Item -ItemType Directory -Force -Path $distAssets | Out-Null
foreach ($assetName in @('nexus-logo.png', 'nexus-mark.png')) {
    $assetSource = Join-Path $nexusSource ("assets\" + $assetName)
    if (-not (Test-Path -LiteralPath $assetSource)) { throw "Nexus brand asset missing at $assetSource" }
    Copy-Item -LiteralPath $assetSource -Destination (Join-Path $distAssets $assetName) -Force
}

# --- 3. runtime brand copy in the installed client bundles -------------------
# 3a. document title owner (dsh-client-ui-renderer).
$rendererPath = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-renderer\lib\client.js'
if (-not (Test-Path -LiteralPath $rendererPath)) { throw "renderer client bundle missing at $rendererPath" }
$rendererText = Get-Content -Raw -Encoding UTF8 -LiteralPath $rendererPath
$rendererPair = Update-AihCopyPair -Text $rendererText -From $copy.rendererProductTitle.from -To $copy.rendererProductTitle.to -What 'renderer document title' -Path $rendererPath
if ($rendererPair[1]) { Write-AihUtf8NoBom -Path $rendererPath -Content $rendererPair[0] }

# 3a2. app-shell layout - expanded sidebar default width (collapsed rail unchanged).
$layoutPath = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-layout\lib\client.js'
if (-not (Test-Path -LiteralPath $layoutPath)) { throw "layout client bundle missing at $layoutPath" }
$layoutText = Get-Content -Raw -Encoding UTF8 -LiteralPath $layoutPath
$layoutChanged = $false
foreach ($pair in @(
    @('sidebar: 280,', 'sidebar: 288,', 'sidebar contract default'),
    @('d.sidebar === 0 ? 280 : 0', 'd.sidebar === 0 ? 288 : 0', 'sidebar reopen width'),
    @('panels.sidebar === 0 ? 280 : panels.sidebar', 'panels.sidebar === 0 ? 288 : panels.sidebar', 'sidebar reopen compute')
)) {
    $layoutResult = Update-AihCopyPair -Text $layoutText -From $pair[0] -To $pair[1] -What $pair[2] -Path $layoutPath
    $layoutText = $layoutResult[0]
    if ($layoutResult[1]) { $layoutChanged = $true }
}
if ($layoutChanged) { Write-AihUtf8NoBom -Path $layoutPath -Content $layoutText }

# 3a3. model-selection - hide the reasoning-effort badge when the model name
# already ends with the same token. Since TASK-0003.3a the settings model
# names are tier-free ("DeepSeek V4 Flash", effort "Max" rendered as its own
# label), so this guard is inert for the canonical names; it stays as a
# safety net so "…MAX Max" can never render if a tier-embedded name returns.
$modelSelPath = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-model-selection\lib\client.js'
if (-not (Test-Path -LiteralPath $modelSelPath)) { throw "model-selection client bundle missing at $modelSelPath" }
$modelSelText = Get-Content -Raw -Encoding UTF8 -LiteralPath $modelSelPath
$modelSelPair = Update-AihCopyPair -Text $modelSelText -From 'effortLabel !== void 0 && (0, react_jsx_runtime.jsx)("span", {' -To 'effortLabel !== void 0 && !modelLabel.toUpperCase().endsWith(effortLabel.toUpperCase()) && (0, react_jsx_runtime.jsx)("span", {' -What 'model trigger effort dedupe' -Path $modelSelPath
if ($modelSelPair[1]) { Write-AihUtf8NoBom -Path $modelSelPath -Content $modelSelPair[0] }

# 3b. conversation hero headline (dsh-client-ui-conversation dictionaries).
$conversationPath = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js'
if (-not (Test-Path -LiteralPath $conversationPath)) { throw "conversation client bundle missing at $conversationPath" }
$conversationText = Get-Content -Raw -Encoding UTF8 -LiteralPath $conversationPath
$conversationChanged = $false
foreach ($pair in $copy.heroHeadline) {
    $result = Update-AihCopyPair -Text $conversationText -From $pair.from -To $pair.to -What 'hero headline' -Path $conversationPath
    $conversationText = $result[0]
    if ($result[1]) { $conversationChanged = $true }
}
# Workspace selection is asynchronous. Upstream renders the optimistic target
# title immediately but used to leave the old session's composer enabled until
# connectWorkspace() completed. A fast submit therefore displayed workspace B
# while appending/executing in session A. Disable the composer for that bounded
# transition; it re-enables only after the current session belongs to B (or the
# selection fails and the optimistic target is cleared).
$workspaceTransitionPair = Update-AihCopyPair -Text $conversationText -From 'const inert = sessionId === void 0 || hero && chipTitle === void 0;' -To 'const inert = pendingWorkspaceId !== void 0 || sessionId === void 0 || hero && chipTitle === void 0;' -What 'workspace transition execution guard' -Path $conversationPath
$conversationText = $workspaceTransitionPair[0]
if ($workspaceTransitionPair[1]) { $conversationChanged = $true }
if ($conversationChanged) { Write-AihUtf8NoBom -Path $conversationPath -Content $conversationText }

# 3b2. phase 1.5 - primary action violet (send button) and hero glow tint.
foreach ($pair in @(
    @('background:var(--dsw-alias-button-info-fill);color:#fff', 'background:var(--dsw-alias-button-primary-fill);color:#fff', 'composer send button fill'),
    @('var(--dsw-alias-button-info-hover)', 'var(--dsw-alias-button-primary-hover)', 'composer send button hover'),
    @('#6187D8', '#7C5CFF', 'hero glow tint')
)) {
    $result = Update-AihCopyPair -Text $conversationText -From $pair[0] -To $pair[1] -What $pair[2] -Path $conversationPath
    $conversationText = $result[0]
    if ($result[1]) { $conversationChanged = $true }
}
if ($conversationChanged) { Write-AihUtf8NoBom -Path $conversationPath -Content $conversationText }

# 3c. models settings welcome notice (dsh-client-ui-settings-models).
$modelsPath = Join-Path $layout.App 'node_modules\@deepseek-ai\dsh-client-ui-settings-models\lib\client.js'
if (-not (Test-Path -LiteralPath $modelsPath)) { throw "settings-models client bundle missing at $modelsPath" }
$modelsText = Get-Content -Raw -Encoding UTF8 -LiteralPath $modelsPath
$noticePattern = '(?s)const WELCOME_NOTICE_COPY = \{.*?\r?\n[ \t]*\};'
Assert-SingleMatch -Text $modelsText -Pattern $noticePattern -What 'welcome notice copy block' -Path $modelsPath
$noticeBlock = [regex]::Match($modelsText, $noticePattern, 'Singleline').Value
$newBlock = $noticeBlock
foreach ($pair in @($copy.welcomeNotice.titleZh, $copy.welcomeNotice.titleEn, $copy.welcomeNotice.bodyZh, $copy.welcomeNotice.bodyEn)) {
    $result = Update-AihCopyPair -Text $newBlock -From $pair.from -To $pair.to -What 'welcome notice copy' -Path $modelsPath
    $newBlock = $result[0]
}
if ($newBlock -ne $noticeBlock) {
    $modelsText = $modelsText.Replace($noticeBlock, $newBlock)
    Write-AihUtf8NoBom -Path $modelsPath -Content $modelsText
}

# --- 4. dark theme default ----------------------------------------------------
# Only when the user settings document has no ui-theme section yet: Nexus is a
# dark-first product, but an explicit user preference is never overwritten.
$settingsPath = $layout.Settings
if (-not (Test-Path -LiteralPath $settingsPath)) {
    throw "settings document missing at $settingsPath"
}
$settingsText = Get-Content -Raw -Encoding UTF8 -LiteralPath $settingsPath
if (-not ([regex]::IsMatch($settingsText, '(?m)^ui-theme:'))) {
    $separator = if ($settingsText.EndsWith("`n")) { '' } else { "`r`n" }
    Write-AihUtf8NoBom -Path $settingsPath -Content ($settingsText + $separator + "ui-theme:`r`n  preference: dark`r`n")
}

Write-Host 'Nexus UI customization applied.'
