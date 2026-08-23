[CmdletBinding()]
param([string]$InstallRoot = 'C:\AI-Harness')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$packageRoot = Join-Path $InstallRoot 'app\node_modules\@deepseek-ai\dsh-client-ui-agent-preset'
$manifestPath = Join-Path $packageRoot 'package.json'
$clientPath = Join-Path $packageRoot 'lib\client.js'
if (-not (Test-Path -LiteralPath $manifestPath) -or -not (Test-Path -LiteralPath $clientPath)) {
    throw 'The pinned agent-preset UI package is missing. Run npm ci before applying the Control Room patch.'
}
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
if ([string]$manifest.version -ne '0.1.1-rc.2') {
    throw "Control Room UI patch supports @deepseek-ai/dsh-client-ui-agent-preset 0.1.1-rc.2, found $($manifest.version)."
}

$text = Get-Content -Raw -Encoding UTF8 -LiteralPath $clientPath
if ($text.Contains('AIH_CONTROL_ROOM_MODE_MODEL_SYNC')) {
    $changed = $false
    $oldReasoning = @'
						provider: "sol-local",
						model: "gpt-5.6-sol",
						reasoningEffort: "medium"
'@
    $newReasoning = @'
						provider: "flash-max-direct",
						model: "deepseek-v4-flash",
						reasoningEffort: "max"
'@
    if ($text.Contains($oldReasoning)) {
        $text = $text.Replace($oldReasoning, $newReasoning)
        $changed = $true
    }
    $oldDeepRoot = @'
						provider: "deepseek-pro-direct",
						model: "deepseek-v4-pro",
						reasoningEffort: "max"
'@
    if ($text.Contains($oldDeepRoot)) {
        $text = $text.Replace($oldDeepRoot, $newReasoning)
        $changed = $true
    }
    $oldPersistence = @'
					if (selection !== void 0) scope.modelDirectories.directoryFor(sessionId).select(selection).catch(() => {});
'@
    $newPersistence = @'
					if (selection !== void 0) void writeDefaultPreset(api, agentPreset).then((failure) => {
						if (failure === void 0) return scope.modelDirectories.directoryFor(sessionId).select(selection);
					}).catch(() => {});
'@
    if ($text.Contains($oldPersistence)) {
        $text = $text.Replace($oldPersistence, $newPersistence)
        $changed = $true
    }
    if ($changed) {
        [IO.File]::WriteAllText($clientPath, $text, [Text.UTF8Encoding]::new($false))
        Write-Host 'Updated the installed Control Room mode synchronization.'
        exit 0
    }
    Write-Host 'Control Room UI patch already applied.'
    exit 0
}

$oldLockedSession = @'
				if (!session.blank || session.agentPreset === staged) {
					this.staged = void 0;
					return;
				}
'@
$newLockedSession = @'
				if (session.agentPreset === staged) {
					this.staged = void 0;
					return;
				}
				// Keep the requested Control Room mode staged until a blank session exists.
				// The upstream controller discarded it whenever an older running session was
				// still current, which made the picker visibly snap back during New Session.
				if (!session.blank) return;
'@

$oldInject = @'
			ctx.inject([
				"slots",
				"conversation",
				"sessions",
				"workspaces"
			], (scope) => {
'@
$newInject = @'
			ctx.inject([
				"slots",
				"conversation",
				"sessions",
				"workspaces",
				"modelDirectories"
			], (scope) => {
'@

$oldApplied = @'
				}, (sessionId, agentPreset) => {
					scope.sessions.noteAgentPreset(sessionId, agentPreset);
				});
'@
$newApplied = @'
				}, (sessionId, agentPreset) => {
					scope.sessions.noteAgentPreset(sessionId, agentPreset);
					// AIH_CONTROL_ROOM_MODE_MODEL_SYNC: a Control Room mode is one coherent
					// preset + root-executor selection, never two independent UI toggles.
					const selection = agentPreset === "aih-engineering" ? {
						provider: "flash-max-direct",
						model: "deepseek-v4-flash",
						reasoningEffort: "max"
					} : agentPreset === "aih-deepseek" ? {
						provider: "flash-max-direct",
						model: "deepseek-v4-flash",
						reasoningEffort: "max"
					} : void 0;
					if (selection !== void 0) void writeDefaultPreset(api, agentPreset).then((failure) => {
						if (failure === void 0) return scope.modelDirectories.directoryFor(sessionId).select(selection);
					}).catch(() => {});
				});
'@

foreach ($replacement in @(
    @($oldLockedSession, $newLockedSession, 'staged selection lifecycle'),
    @($oldInject, $newInject, 'model directory injection'),
    @($oldApplied, $newApplied, 'mode/model synchronization')
)) {
    $matches = ([regex]::Matches($text, [regex]::Escape($replacement[0]))).Count
    if ($matches -ne 1) { throw "Pinned UI structure changed for $($replacement[2]) (matches: $matches). Refusing an unsafe patch." }
    $text = $text.Replace($replacement[0], $replacement[1])
}

[IO.File]::WriteAllText($clientPath, $text, [Text.UTF8Encoding]::new($false))
Write-Host 'Applied Control Room mode-switch patch.'
