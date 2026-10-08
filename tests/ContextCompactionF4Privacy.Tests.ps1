[CmdletBinding()]param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))
# Context Compaction F4 privacy regression: checkpoint persistence must not
# create a durable secret archive. Production-path only: REAL task ledger ->
# REAL New-AihContextCheckpoint -> REAL persisted JSON -> REAL renderer.
# Synthetic sentinels only (F4_FAKE_*); no real credentials anywhere.
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/TaskController.ps1')
. (Join-Path $InstallRoot 'scripts/ContextLifecycle.ps1')
$passed = 0
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }
function New-F4Fixture([string]$Name) { $p = Join-Path ([IO.Path]::GetTempPath()) ("aih-f4-" + $Name + "-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $p | Out-Null; & git init -q $p | Out-Null; & git -C $p config user.email f8t@example.invalid | Out-Null; & git -C $p config user.name f8t | Out-Null; Set-Content -LiteralPath (Join-Path $p '.f8baseline') -Value 'baseline' | Out-Null; & git -C $p add .f8baseline | Out-Null; & git -C $p commit -qm baseline | Out-Null; $p }
function Complete-F4Task([string]$Workspace, [string]$Description, [string[]]$Criteria, [array]$EvidenceCriteria, [array]$Verification, [string]$UserText, [string]$AssistantText) {
    $task = New-AihTask -Workspace $Workspace -Description $Description -AcceptanceCriteria $Criteria -Engine 'dual'
    $run = Join-Path (Join-Path $Workspace '.ai-harness/runs') $task.taskId
    $evidence = [ordered]@{
        schemaVersion = 2; attempt = 1; taskInstanceId = [string]$task.taskInstanceId
        acceptanceCriteria = @($EvidenceCriteria); verification = @($Verification); scopePass = $true
    }
    Write-AihAtomicJson (Join-Path $run 'evidence.json') $evidence
    $c = Test-AihTaskCompletion -Workspace $Workspace -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId)
    if (-not [bool]$c.complete) { throw ('F4 fixture completion failed: ' + ([string]::Join('; ', @($c.reasons)))) }
    $cp = New-AihContextCheckpoint -Workspace $Workspace -TaskId $task.taskId -TaskInstanceId ([string]$task.taskInstanceId) -ContinuityUserText $UserText -ContinuityAssistantText $AssistantText
    $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $cp.path
    $parsed = $raw | ConvertFrom-Json
    $text = Get-AihContextCheckpointText -Checkpoint $parsed
    return [pscustomobject]@{ task = $task; path = $cp.path; raw = $raw; parsed = $parsed; text = $text }
}
$SyntheticKey = 'sk-' + 'f4fake-acceptance-123456789'
$AllSentinels = @($SyntheticKey, 'F4_FAKE_VERIFY_SECRET', 'F4_FAKE_PATH_SECRET', 'F4_FAKE_QUERY_SECRET', 'F4_FAKE_URL_PASSWORD', 'F4_FAKE_AWS_SECRET', 'F4_FAKE_API_KEY', 'F4_FAKE_SERVICE_TOKEN', 'F4_FAKE_DB_PASSWORD', 'F4_FAKE_GITHUB_TOKEN', 'F4_FAKE_OPENAI_KEY', 'F4_FAKE_BEARER_TOKEN', 'F4_FAKE_QUERY_TOKEN', 'F4FAKEPRIVATEKEYMATERIAL')
function Assert-NoSentinels([string]$Blob, [string]$Where) { foreach ($s in $AllSentinels) { Assert-Aih (-not $Blob.Contains($s)) ("sentinel absent from $Where : $s") } }
# == F4-1 acceptance criteria (mandatory audit regression) =====================
$root = New-F4Fixture 'crit'
try {
    $crit = ('call API with ' + $SyntheticKey + ' then proceed')
    $r = Complete-F4Task $root 'F4 criteria task' @($crit) @([ordered]@{ criterion = $crit; status = 'met'; evidence = ('fixture evidence for ' + $crit) }) @([ordered]@{ name = 'fixture-verify'; kind = 'verify'; status = 'PASS'; exitCode = 0; attempt = 1 }) '' ''
    Assert-Aih (-not $r.raw.Contains($SyntheticKey)) 'criteria secret absent from checkpoint JSON'
    Assert-Aih (-not $r.text.Contains($SyntheticKey)) 'criteria secret absent from rendered checkpoint'
    Assert-Aih ($r.raw.Contains('call API with')) 'non-secret criteria meaning survives'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
# == F4-2 verification name ====================================================
$root = New-F4Fixture 'verify'
try {
    $r = Complete-F4Task $root 'F4 verify task' @('criterion one') @([ordered]@{ criterion = 'criterion one'; status = 'met'; evidence = 'fixture evidence for criterion one' }) @([ordered]@{ name = 'verify password=F4_FAKE_VERIFY_SECRET'; kind = 'verify'; status = 'PASS'; exitCode = 0; attempt = 1 }) '' ''
    Assert-Aih (-not $r.raw.Contains('F4_FAKE_VERIFY_SECRET')) 'verify secret absent from checkpoint JSON'
    Assert-Aih (-not $r.text.Contains('F4_FAKE_VERIFY_SECRET')) 'verify secret absent from rendered checkpoint'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
# == F4-3 combined production-path sweep (every F4 surface at once) ============
$root = New-F4Fixture 'sweep'
try {
    $crit = ('call API with ' + $SyntheticKey + ' and open /tmp/token=F4_FAKE_PATH_SECRET/file.txt')
    $pem = "-----BEGIN PRIVATE KEY-----`nF4FAKEPRIVATEKEYMATERIAL`n-----END PRIVATE KEY-----"
    $userText = 'need AWS_SECRET_ACCESS_KEY=F4_FAKE_AWS_SECRET and MY_API_KEY=F4_FAKE_API_KEY plus https://example.invalid/api?token=F4_FAKE_QUERY_SECRET and clone https://f4user:F4_FAKE_URL_PASSWORD@example.invalid/repo'
    $asstText = ('did SERVICE_TOKEN=F4_FAKE_SERVICE_TOKEN DB_PASSWORD=F4_FAKE_DB_PASSWORD GITHUB_TOKEN=F4_FAKE_GITHUB_TOKEN OPENAI_API_KEY=F4_FAKE_OPENAI_KEY token=F4_FAKE_QUERY_TOKEN Auth: Authorization: Bearer F4_FAKE_BEARER_TOKEN ' + "`n" + $pem)
    $r = Complete-F4Task $root 'F4 sweep task' @($crit) @([ordered]@{ criterion = $crit; status = 'met'; evidence = ('fixture evidence for ' + $crit) }) @([ordered]@{ name = 'verify password=F4_FAKE_VERIFY_SECRET'; kind = 'verify'; status = 'PASS'; exitCode = 0; attempt = 1 }) $userText $asstText
    Assert-NoSentinels $r.raw 'persisted checkpoint JSON (sweep)'
    Assert-NoSentinels $r.text 'rendered checkpoint text (sweep)'
    Assert-Aih ($r.raw.Contains('<redacted>')) 'stable replacement marker present'
    Assert-Aih (-not $r.raw.Contains('BEGIN PRIVATE KEY')) 'PEM block header absent from JSON'
    Assert-Aih (-not $r.text.Contains('BEGIN PRIVATE KEY')) 'PEM block header absent from rendered text'
    Assert-Aih ($r.text.Contains('src-shape-check') -eq $false) 'sweep carries no stray content'
    $bytes = [Text.Encoding]::UTF8.GetByteCount(($r.raw))
    Assert-Aih ($bytes -le 65536) 'size bound holds on serialized safe checkpoint'
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
# == F4-4 false positives: ordinary words survive ===============================
$root = New-F4Fixture 'fp'
try {
    $r = Complete-F4Task $root 'F4 fp task' @('criterion one') @([ordered]@{ criterion = 'criterion one'; status = 'met'; evidence = 'fixture evidence for criterion one' }) @([ordered]@{ name = 'fixture-verify'; kind = 'verify'; status = 'PASS'; exitCode = 0; attempt = 1 }) 'token budget is 120000, see password policy documentation' 'secret management module at src/auth/token_parser.ts'
    foreach ($keep in @('token budget is 120000', 'password policy documentation', 'secret management module', 'src/auth/token_parser.ts')) { Assert-Aih ($r.raw.Contains($keep)) ("ordinary context survives: $keep") }
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
# == F4-5 idempotence ===========================================================
$once = ConvertTo-AihContextRedactedText -Text 'AWS_SECRET_ACCESS_KEY=F4_FAKE_X and token=F4_FAKE_Y'
$twice = ConvertTo-AihContextRedactedText -Text $once
Assert-Aih ($once -eq $twice) 'sanitize is idempotent'
Assert-Aih ((-not $once.Contains('F4_FAKE_X')) -and (-not $once.Contains('F4_FAKE_Y'))) 'idempotence probe carries no secret'
Assert-Aih (-not $twice.Contains('<redacted><redacted>')) 'no repeated marker growth'
# == F4-6 recursive structural safety, no caller mutation =======================
$srcObj = [ordered]@{ outer = [ordered]@{ inner = 'token=F4_FAKE_QUERY_TOKEN'; n = 7; flag = $true }; list = @('ok', 'AWS_SECRET_ACCESS_KEY=F4_FAKE_AWS_SECRET') }
$safe = ConvertTo-AihContextSafeCheckpointValue -Value $srcObj -MaxChars 500
Assert-Aih ([string]$srcObj.outer.inner -eq 'token=F4_FAKE_QUERY_TOKEN') 'caller source object not mutated'
Assert-Aih ([int]$safe.outer.n -eq 7) 'non-string scalars preserved'
Assert-Aih ([bool]$safe.outer.flag -eq $true) 'booleans preserved'
Assert-Aih ((-not ([string]$safe.outer.inner).Contains('F4_FAKE_QUERY_TOKEN')) -and (-not ([string]$safe.list[1]).Contains('F4_FAKE_AWS_SECRET'))) 'nested strings sanitized'
Assert-Aih ([string]$safe.list[0] -eq 'ok') 'safe strings pass through'
Write-Host ("RESULT: $passed F4 privacy assertions passed.")
