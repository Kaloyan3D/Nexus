[CmdletBinding()]
param([string]$InstallRoot=(Split-Path -Parent $PSScriptRoot))
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}
$passed=0
function Assert-Aih([bool]$Condition,[string]$Name){if(-not $Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}
$root=Join-Path ([IO.Path]::GetTempPath()) ('aih-telemetry-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $root|Out-Null
try {
  $payload=Join-Path $root 'payload.json'
  @{workspace=$root;description='telemetry fixture';reviewRequested=$false}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $payload
  $taskJson=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\Task.ps1') -Action create-task -PayloadFile $payload
  if($LASTEXITCODE -ne 0){throw 'task create failed'}
  $task=(($taskJson -join [Environment]::NewLine)|ConvertFrom-Json)
  $instance=[string]$task.taskInstanceId
  @{workspace=$root;taskInstanceId=$instance;text='telemetry fixture'}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $payload
  $null=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\Engineering.ps1') -Action lifecycle-init -TaskId $task.taskId -PayloadFile $payload
  if($LASTEXITCODE -ne 0){throw 'lifecycle init failed'}

  $normal=@{workspace=$root;taskInstanceId=$instance;role='engineer_normal';milestoneId='1:1';inputTokens=100;uncachedInputTokens=100;cacheReadTokens=500;outputTokens=20;usageAvailable=$true;model='fixture-normal';provider='fixture-provider'}
  $normal|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $payload
  $null=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\Engineering.ps1') -Action record-model-usage -TaskId $task.taskId -PayloadFile $payload
  if($LASTEXITCODE -ne 0){throw 'normal usage failed'}
  # Replay the same event: idempotency must prevent a duplicate usage record.
  $null=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\Engineering.ps1') -Action record-model-usage -TaskId $task.taskId -PayloadFile $payload
  if($LASTEXITCODE -ne 0){throw 'usage replay failed'}

  $deep=@{workspace=$root;taskInstanceId=$instance;role='engineer_deep';milestoneId='1:2';inputTokens=50;uncachedInputTokens=50;cacheReadTokens=250;outputTokens=10;usageAvailable=$true;model='fixture-deep';provider='fixture-provider'}
  $deep|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $payload
  $null=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\Engineering.ps1') -Action record-model-usage -TaskId $task.taskId -PayloadFile $payload
  if($LASTEXITCODE -ne 0){throw 'deep usage failed'}

  @{workspace=$root;taskInstanceId=$instance}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $payload
  $snapshotOutput=@(& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\Engineering.ps1') -Action telemetry-snapshot -TaskId $task.taskId -PayloadFile $payload 2>&1)
  $snapshotExitCode=[int]$LASTEXITCODE
  if($snapshotExitCode -ne 0){
    Write-Host ('TELEMETRY CHILD FAILED (exit {0})' -f $snapshotExitCode)
    foreach($line in $snapshotOutput){Write-Host ([string]$line)}
    throw 'telemetry snapshot failed'
  }
  $snapshot=(($snapshotOutput -join [Environment]::NewLine)|ConvertFrom-Json)
  Assert-Aih ([string]$snapshot.taskInstanceId -eq $instance) 'telemetry keeps exact taskInstanceId'
  Assert-Aih ([int]$snapshot.usageRecordedCalls -eq 2) 'replayed usage event is idempotent'
  Assert-Aih ([int]$snapshot.usageCallsNormal -eq 1) 'normal provider usage count is recorded'
  Assert-Aih ([int]$snapshot.usageCallsDeep -eq 1) 'deep provider usage count is recorded'
  Assert-Aih ([int]$snapshot.totalModelCalls -eq 0) 'usage records do not fabricate semantic routing steps'
  Assert-Aih ([int]$snapshot.modelCallsNormal -eq 0) 'normal semantic step count remains StepRouting-owned'
  Assert-Aih ([int]$snapshot.modelCallsDeep -eq 0) 'deep semantic step count remains StepRouting-owned'
  Assert-Aih ([bool]$snapshot.usageAvailable) 'authoritative usage is available'
  Assert-Aih ([int]$snapshot.inputTokens -eq 150) 'input token total is aggregated'
  Assert-Aih ([int]$snapshot.uncachedInputTokens -eq 150) 'uncached token total is aggregated'
  Assert-Aih ([int]$snapshot.cacheReadTokens -eq 750) 'cache-read token total is aggregated'
  Assert-Aih ([int]$snapshot.outputTokens -eq 30) 'output token total is aggregated'
  Assert-Aih ($null -eq $snapshot.estimatedCost) 'cost remains unavailable when runtime does not provide it'
  Write-Host "RESULT: $passed engineering telemetry assertions passed."
} finally { if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force} }
