import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}
function write(rel, text) {
  fs.writeFileSync(path.join(root, rel), text, 'utf8')
}
function replaceRegex(rel, regex, replacement, label) {
  const before = read(rel)
  const matches = [...before.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g'))]
  if (matches.length !== 1) throw new Error(`${label}: expected exactly one match in ${rel}, found ${matches.length}`)
  const after = before.replace(regex, replacement)
  if (after === before) throw new Error(`${label}: replacement made no change in ${rel}`)
  write(rel, after)
}
function replaceLiteral(rel, oldText, newText, label) {
  const before = read(rel)
  const first = before.indexOf(oldText)
  if (first < 0) throw new Error(`${label}: old text not found in ${rel}`)
  if (before.indexOf(oldText, first + oldText.length) >= 0) throw new Error(`${label}: old text is ambiguous in ${rel}`)
  write(rel, before.slice(0, first) + newText + before.slice(first + oldText.length))
}

// 1) Production prompt classification + authoritative DSH usage-event parser.
replaceRegex(
  'config/AihController.cjs',
  /function classifyEpistemicPrompt\(text\) \{[\s\S]*?\n\}\n\n\/\*\* True when an execution class/,
`const IMPLEMENTATION_REQUEST_RE = /^(implement|build|fix|change|update|create|add|remove|refactor|rename|apply|write|edit)\\b/i
const EMPIRICAL_REQUEST_RE = /^(does|is|what (type|value|exit code)|how does).*\\b(runtime|serialize|serialise|regex|path|command|powershell|node|exit code)\\b/i
const REPOSITORY_REQUEST_RES = [
  /^(where|which (file|function|test|config|module|script|component|code path)|what does (the )?(current|repository|implementation)|find (the )?(symbol|references|callers|definition|implementation))\\b/i,
  /^(inspect|locate|trace|show|identify)\\b/i,
  /^(explain|describe|show)\\s+how\\s+(the\\s+)?(current|existing|repository|implementation|controller|code)\\b/i,
  /^how\\s+does\\s+(the\\s+)?(current|existing|repository|implementation|controller|code)\\b/i,
  /^what\\s+currently\\s+(handles|implements|writes|reads|routes|resolves|creates|updates)\\b/i,
  /\\b(current|existing)\\s+(implementation|code|controller|architecture|code path|routing|verification)\\b/i,
  /\\b(where|how)\\s+[^?\\n]*\\b(defined|implemented|wired|connected|resolved|handled|written|used|called)\\b/i,
]
const PRESCRIPTIVE_JUDGMENT_RES = [
  /\\bshould\\b/i,
  /^(recommend|design|choose|propose|decide)\\b/i,
  /\\b(best|better|safer)\\s+(architecture|approach|design|option|strategy)\\b/i,
]

function classifyEpistemicPrompt(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (IMPLEMENTATION_REQUEST_RE.test(value)) {
    return { kind: 'judgment', implementationReady: true, probeAvailable: false, repositoryAvailable: true, subject: 'implementation.request' }
  }
  // Runtime-observable questions win over generic references to "current"
  // implementation: empirical uncertainty should be measured, not read or
  // reasoned about.
  if (EMPIRICAL_REQUEST_RE.test(value)) {
    return { kind: 'empirical', implementationReady: false, probeAvailable: true, probeCost: 'low', probeRisk: 'safe', expectedInformationGain: 'high', decisionRelevance: 'medium', repositoryAvailable: true, subject: 'runtime.question' }
  }
  const prescriptive = PRESCRIPTIVE_JUDGMENT_RES.some((re) => re.test(value))
  const repositoryDescriptive = REPOSITORY_REQUEST_RES.some((re) => re.test(value))
  if (repositoryDescriptive && !prescriptive) {
    return { kind: 'repository', implementationReady: false, probeAvailable: false, repositoryAvailable: true, subject: 'repository.question' }
  }
  if (prescriptive) {
    return { kind: 'judgment', implementationReady: false, probeAvailable: false, repositoryAvailable: true, subject: 'engineering.judgment' }
  }
  return { kind: 'judgment', implementationReady: false, probeAvailable: false, repositoryAvailable: true, subject: 'engineering.question' }
}

/**
 * Parse the authoritative DSH assistant/chunk usage event. DSH reports newly
 * processed (uncached) input in inputTokens and cache hits separately in
 * cacheReadTokens. Missing cacheReadTokens means no cache hit for that call.
 * No cost is inferred here.
 */
function engineeringUsageOfEvent(event) {
  if (!event || event.type !== 'assistant/chunk') return null
  const data = event.data
  const chunk = data && data.chunk
  const usage = chunk && chunk.type === 'usage' ? chunk.usage : null
  if (!usage || typeof usage !== 'object') return null
  const uncached = Number(usage.inputTokens)
  const output = Number(usage.outputTokens)
  const cache = usage.cacheReadTokens === undefined || usage.cacheReadTokens === null ? 0 : Number(usage.cacheReadTokens)
  if (!Number.isFinite(uncached) || !Number.isFinite(output) || !Number.isFinite(cache)) return null
  const inputTokens = Math.max(0, Math.trunc(uncached))
  const cacheReadTokens = Math.max(0, Math.trunc(cache))
  const outputTokens = Math.max(0, Math.trunc(output))
  const turn = data && data.turn !== undefined && data.turn !== null ? String(data.turn) : ''
  const step = data && data.step !== undefined && data.step !== null ? String(data.step) : ''
  return {
    turn,
    step,
    stepId: turn || step ? turn + ':' + step : '',
    inputTokens,
    uncachedInputTokens: inputTokens,
    cacheReadTokens,
    outputTokens,
    usageAvailable: true,
  }
}

/** True when an execution class`,
  'classifier-and-usage-parser',
)

// 2) A RETRIEVE decision must actually preload current repository evidence
// through Working Set / ContextEngine before the Normal engineer starts.
replaceRegex(
  'config/AihController.cjs',
  /  async function selectEngineeringEpistemicStep\(binding, turn, promptText\) \{[\s\S]*?\n  \}\n\n  async function selectEngineeringVerificationAction/,
`  async function selectEngineeringEpistemicStep(binding, turn, promptText) {
    const policyInput = classifyEpistemicPrompt(promptText)
    const uncertainty = await invokePowerShell('Engineering.ps1', ['-Action', 'uncertainty-create', '-TaskId', binding.taskId], {
      payload: {
        workspace: binding.workspace,
        taskInstanceId: binding.taskInstanceId || undefined,
        question: promptText,
        uncertaintyKind: policyInput.kind,
        subject: policyInput.subject,
        decisionImpact: 'medium',
        probeAvailable: Boolean(policyInput.probeAvailable),
        probeCost: policyInput.probeCost || 'low',
        probeRisk: policyInput.probeRisk || 'safe',
        expectedInformationGain: policyInput.expectedInformationGain || 'medium',
        decisionRelevance: policyInput.decisionRelevance || 'medium',
        repositoryAvailable: policyInput.repositoryAvailable !== false,
      },
    })
    if (!uncertainty || !uncertainty.id) return null
    const decision = await invokePowerShell('Engineering.ps1', ['-Action', 'epistemic-step', '-TaskId', binding.taskId, '-Preset', binding.preset || 'aih-engineering'], {
      payload: {
        workspace: binding.workspace,
        taskInstanceId: binding.taskInstanceId || undefined,
        uncertaintyId: uncertainty.id,
        question: promptText,
        implementationReady: Boolean(policyInput.implementationReady),
        stepKind: 'turn',
        milestoneId: turn ? String(turn) : undefined,
      },
    })
    if (!decision || !decision.selectedRole) return null
    if (decision.selectedRole !== 'engineer_normal' && decision.selectedRole !== 'engineer_deep') return null

    let retrieval = null
    let retrievalError = null
    if (decision.selectedAction === 'retrieve') {
      try {
        retrieval = await invokePowerShell('Engineering.ps1', ['-Action', 'working-set-retrieve', '-TaskId', binding.taskId], {
          payload: {
            workspace: binding.workspace,
            taskInstanceId: binding.taskInstanceId || undefined,
            query: promptText,
            maxResults: 20,
          },
        })
      } catch (error) {
        retrievalError = String(error && error.message ? error.message : error)
        log({ event: 'epistemic-retrieve-failed', taskId: binding.taskId, taskInstanceId: binding.taskInstanceId || null, error: retrievalError })
      }
    }
    return { ...decision, retrieval, retrievalError }
  }

  async function selectEngineeringVerificationAction`,
  'production-retrieve-preload',
)

// 3) Record authoritative model-call usage events through the existing
// Engineering telemetry producer. Reviewer/subagent traffic is excluded
// because there is no currentEngineeringStep for those paths.
replaceLiteral(
  'config/AihController.cjs',
`  ctx.on('session/event', (subject, event) => {
    if (!subject || !event) return
    const binding = bindings[subject.id]
    if (!binding) return
    if (event.type === 'turn/end' && event.data && event.data.reason) {`,
`  async function recordEngineeringModelUsage(binding, event) {
    const usage = engineeringUsageOfEvent(event)
    const current = binding && binding.currentEngineeringStep
    if (!usage || !current || !current.role) return null
    const roleTarget = current.roleTarget && typeof current.roleTarget === 'object' ? current.roleTarget : {}
    return invokePowerShell('Engineering.ps1', ['-Action', 'record-model-usage', '-TaskId', binding.taskId], {
      payload: {
        workspace: binding.workspace,
        taskInstanceId: binding.taskInstanceId || undefined,
        role: current.role,
        milestoneId: usage.stepId || current.stepId || '',
        inputTokens: usage.inputTokens,
        uncachedInputTokens: usage.uncachedInputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens,
        usageAvailable: usage.usageAvailable,
        model: roleTarget.model || '',
        provider: roleTarget.provider || '',
      },
    })
  }

  ctx.on('session/event', (subject, event) => {
    if (!subject || !event) return
    const binding = bindings[subject.id]
    if (!binding) return
    if (engineeringUsageOfEvent(event) && binding.currentEngineeringStep) {
      recordEngineeringModelUsage(binding, event)
        .catch((error) => log({ event: 'engineering-usage-record-failed', sessionId: subject.id, taskId: binding.taskId, error: String(error) }))
    }
    if (event.type === 'turn/end' && event.data && event.data.reason) {`,
  'usage-producer-integration',
)

replaceLiteral(
  'config/AihController.cjs',
`      } else {
        const actionId = binding.currentEpistemicActionId
        binding.currentEpistemicActionId = null
        completeEngineeringEpistemicAction(binding, actionId, 'succeeded', 'engineering turn completed')
          .catch((error) => log({ event: 'epistemic-action-complete-failed', sessionId: subject.id, error: String(error) }))
      }
    }
  })`,
`      } else {
        const actionId = binding.currentEpistemicActionId
        binding.currentEpistemicActionId = null
        completeEngineeringEpistemicAction(binding, actionId, 'succeeded', 'engineering turn completed')
          .catch((error) => log({ event: 'epistemic-action-complete-failed', sessionId: subject.id, error: String(error) }))
      }
      binding.currentEngineeringStep = null
    }
  })`,
  'clear-current-engineering-step',
)

replaceLiteral(
  'config/AihController.cjs',
`          if (stepDecision) {
            stepRole = stepDecision.selectedRole
            binding.currentEpistemicActionId = stepDecision.actionId || null
            appendMessage(
              session,
              createControllerMessage(
                'Controller epistemic action: ' + String(stepDecision.selectedAction || 'reason').toUpperCase() + ' · ' + String(stepDecision.selectionReason || '') + '\\nEngineering role: ' + executionClassLabel(stepRole) + '.',
                'controller-epistemic-action',
              ),
            )
          }`,
`          if (stepDecision) {
            stepRole = stepDecision.selectedRole
            binding.currentEpistemicActionId = stepDecision.actionId || null
            binding.currentEngineeringStep = {
              role: stepRole,
              stepId: stepDecision.step && stepDecision.step.stepId ? String(stepDecision.step.stepId) : String(payload.turn ?? ''),
              roleTarget: stepDecision.roleTarget || (stepDecision.step && stepDecision.step.roleTarget) || null,
              selectedAction: stepDecision.selectedAction || null,
            }
            const candidates = stepDecision.retrieval && Array.isArray(stepDecision.retrieval.candidates) ? stepDecision.retrieval.candidates : []
            const paths = candidates.map((item) => item && item.file ? String(item.file) : '').filter(Boolean).slice(0, 8)
            const retrievalLine = stepDecision.selectedAction === 'retrieve'
              ? '\\nRepository evidence preload: ' + (stepDecision.retrievalError
                  ? 'FAILED (' + stepDecision.retrievalError + '); structured retrieval remains available to Engineer Normal.'
                  : String(candidates.length) + ' candidate(s)' + (paths.length ? ' · ' + paths.join(', ') : '') + '.')
              : ''
            appendMessage(
              session,
              createControllerMessage(
                'Controller epistemic action: ' + String(stepDecision.selectedAction || 'reason').toUpperCase() + ' · ' + String(stepDecision.selectionReason || '') + '\\nEngineering role: ' + executionClassLabel(stepRole) + '.' + retrievalLine,
                'controller-epistemic-action',
              ),
            )
          }`,
  'pre-step-runtime-state-and-retrieval-notice',
)

replaceLiteral(
  'config/AihController.cjs',
`module.exports.classifyEpistemicPrompt = classifyEpistemicPrompt
module.exports.textOf = textOf`,
`module.exports.classifyEpistemicPrompt = classifyEpistemicPrompt
module.exports.engineeringUsageOfEvent = engineeringUsageOfEvent
module.exports.textOf = textOf`,
  'export-usage-helper',
)

// 4) Telemetry is idempotent per model step and call counts prefer real usage
// records when available (routing steps remain the safe fallback).
replaceLiteral(
  'scripts/Engineering/Telemetry.ps1',
`    if ($null -eq $metrics -or -not (Test-AihEngineeringArtifactIdentity -Artifact $metrics -TaskInstanceId $TaskInstanceId)) {
        $metrics = New-AihEngineeringMetricsBase -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    }
    $usageEntry = [ordered]@{`,
`    if ($null -eq $metrics -or -not (Test-AihEngineeringArtifactIdentity -Artifact $metrics -TaskInstanceId $TaskInstanceId)) {
        $metrics = New-AihEngineeringMetricsBase -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    }
    # Session events can be replayed after reconnect. A task-local model step
    # is therefore an idempotency key for usage recording, not a reason to
    # double-count one provider call.
    if (-not [string]::IsNullOrWhiteSpace($StepId)) {
        $existing = @($metrics.usageRecords | Where-Object { [string]$_.stepId -eq $StepId -and [string]$_.role -eq $Role }) | Select-Object -First 1
        if ($null -ne $existing) { return $existing }
    }
    $usageEntry = [ordered]@{`,
  'telemetry-idempotency',
)

replaceLiteral(
  'scripts/Engineering/Telemetry.ps1',
`        totalModelCalls = $routing.steps
        modelCallsNormal = $routing.normalSteps
        modelCallsDeep = $routing.deepSteps
        modelCallsReviewer = [int]$byRole['reviewer']
        usageRecordedCalls = @($usageRecords).Count`,
`        totalModelCalls = $(if (@($usageRecords).Count -gt 0) { @($usageRecords).Count } else { [int]$routing.steps })
        modelCallsNormal = $(if (@($usageRecords).Count -gt 0) { [int]$byRole['engineer_normal'] } else { [int]$routing.normalSteps })
        modelCallsDeep = $(if (@($usageRecords).Count -gt 0) { [int]$byRole['engineer_deep'] } else { [int]$routing.deepSteps })
        modelCallsReviewer = [int]$byRole['reviewer']
        usageRecordedCalls = @($usageRecords).Count`,
  'telemetry-real-call-counts',
)

// 5) Deterministic regressions.
write('tests/EpistemicProductionHardening.Tests.cjs', `'use strict'\n\nconst assert = require('node:assert/strict')\nconst controller = require('../config/AihController.cjs')\n\nlet passed = 0\nfunction check(name, fn) { fn(); passed += 1; console.log('PASS: ' + name) }\n\nconst smoke = [\n  'Inspect the current Engineering Mode architecture and identify where',\n  'EpistemicPolicy integrates with WorkingSet and StepRouting.',\n  '',\n  'Do not modify files.',\n  'Do not run an independent review.',\n  'Return only the relevant integration points.',\n].join('\\n')\n\nconst repositoryCases = [\n  smoke,\n  'Inspect the current implementation.',\n  'Identify where StepRouting integrates with the controller.',\n  'Trace where this symbol is used.',\n  'Show how the current controller resolves profiles.',\n  'Explain how the current implementation routes requests.',\n  'How does the current implementation work?',\n  'What currently handles verification?',\n  'Which code path writes epistemic-state.json?',\n]\nfor (const text of repositoryCases) {\n  check('repository: ' + text.split('\\n')[0], () => assert.equal(controller.classifyEpistemicPrompt(text).kind, 'repository'))\n}\n\nconst judgmentCases = [\n  'How should we redesign Engineering Mode?',\n  'Recommend the best architecture for persistent memory.',\n  'Which persistence architecture should we choose?',\n  'Design a better controller abstraction.',\n  'Which architecture preserves both invariants?',\n]\nfor (const text of judgmentCases) {\n  check('judgment: ' + text, () => assert.equal(controller.classifyEpistemicPrompt(text).kind, 'judgment'))\n}\n\ncheck('implementation request remains implementation-ready', () => {\n  const value = controller.classifyEpistemicPrompt('Fix this implementation bug.')\n  assert.equal(value.kind, 'judgment')\n  assert.equal(value.implementationReady, true)\n})\ncheck('runtime serialization question remains empirical', () => {\n  const value = controller.classifyEpistemicPrompt('What type does this PowerShell runtime value serialize to?')\n  assert.equal(value.kind, 'empirical')\n  assert.equal(value.probeAvailable, true)\n})\ncheck('ambiguous engineering request remains conservative judgment', () => {\n  assert.equal(controller.classifyEpistemicPrompt('Think about the controller boundary.').kind, 'judgment')\n})\ncheck('usage event maps authoritative DSH token fields', () => {\n  assert.deepEqual(controller.engineeringUsageOfEvent({\n    type: 'assistant/chunk',\n    data: { turn: 4, step: 2, chunk: { type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 9000, outputTokens: 250 } } },\n  }), { turn: '4', step: '2', stepId: '4:2', inputTokens: 1200, uncachedInputTokens: 1200, cacheReadTokens: 9000, outputTokens: 250, usageAvailable: true })\n})\ncheck('missing cache field is an authoritative zero cache hit', () => {\n  const value = controller.engineeringUsageOfEvent({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 10 } } } })\n  assert.equal(value.cacheReadTokens, 0)\n})\ncheck('non-usage events are ignored', () => {\n  assert.equal(controller.engineeringUsageOfEvent({ type: 'turn/end', data: {} }), null)\n})\n\nconsole.log('RESULT: ' + passed + ' epistemic production hardening assertions passed.')\n`)

write('tests/EngineeringTelemetry.Tests.ps1', `[CmdletBinding()]param([string]$InstallRoot=(Split-Path -Parent $PSScriptRoot))\nSet-StrictMode -Version Latest\n$ErrorActionPreference='Stop'\ntry { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}\n$passed=0\nfunction Assert-Aih([bool]$Condition,[string]$Name){if(-not $Condition){throw "FAIL: $Name"};$script:passed++;Write-Host "PASS: $Name"}\n$root=Join-Path ([IO.Path]::GetTempPath()) ('aih-telemetry-'+[guid]::NewGuid().ToString('N'))\nNew-Item -ItemType Directory -Force -Path $root|Out-Null\ntry {\n  $payload=Join-Path $root 'payload.json'\n  @{workspace=$root;description='telemetry fixture';reviewRequested=$false}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $payload\n  $taskJson=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\\Task.ps1') -Action create-task -PayloadFile $payload\n  if($LASTEXITCODE-ne 0){throw 'task create failed'}\n  $task=$taskJson|ConvertFrom-Json\n  $instance=[string]$task.taskInstanceId\n  @{workspace=$root;taskInstanceId=$instance;text='telemetry fixture'}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $payload\n  $null=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\\Engineering.ps1') -Action lifecycle-init -TaskId $task.taskId -PayloadFile $payload\n  if($LASTEXITCODE-ne 0){throw 'lifecycle init failed'}\n\n  $normal=@{workspace=$root;taskInstanceId=$instance;role='engineer_normal';milestoneId='1:1';inputTokens=100;uncachedInputTokens=100;cacheReadTokens=500;outputTokens=20;usageAvailable=$true;model='fixture-normal';provider='fixture-provider'}\n  $normal|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $payload\n  $null=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\\Engineering.ps1') -Action record-model-usage -TaskId $task.taskId -PayloadFile $payload\n  if($LASTEXITCODE-ne 0){throw 'normal usage failed'}\n  # Replay the same event: idempotency must prevent a duplicate model call.\n  $null=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\\Engineering.ps1') -Action record-model-usage -TaskId $task.taskId -PayloadFile $payload\n  if($LASTEXITCODE-ne 0){throw 'usage replay failed'}\n\n  $deep=@{workspace=$root;taskInstanceId=$instance;role='engineer_deep';milestoneId='1:2';inputTokens=50;uncachedInputTokens=50;cacheReadTokens=250;outputTokens=10;usageAvailable=$true;model='fixture-deep';provider='fixture-provider'}\n  $deep|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $payload\n  $null=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\\Engineering.ps1') -Action record-model-usage -TaskId $task.taskId -PayloadFile $payload\n  if($LASTEXITCODE-ne 0){throw 'deep usage failed'}\n\n  @{workspace=$root;taskInstanceId=$instance}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $payload\n  $snapshotJson=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\\Engineering.ps1') -Action telemetry-snapshot -TaskId $task.taskId -PayloadFile $payload\n  if($LASTEXITCODE-ne 0){throw 'telemetry snapshot failed'}\n  $snapshot=$snapshotJson|ConvertFrom-Json\n  Assert-Aih ([string]$snapshot.taskInstanceId-eq$instance) 'telemetry keeps exact taskInstanceId'\n  Assert-Aih ([int]$snapshot.usageRecordedCalls-eq 2) 'replayed usage event is idempotent'\n  Assert-Aih ([int]$snapshot.totalModelCalls-eq 2) 'real usage records drive total model-call count'\n  Assert-Aih ([int]$snapshot.modelCallsNormal-eq 1) 'normal call count comes from real usage'\n  Assert-Aih ([int]$snapshot.modelCallsDeep-eq 1) 'deep call count comes from real usage'\n  Assert-Aih ([bool]$snapshot.usageAvailable) 'authoritative usage is available'\n  Assert-Aih ([int]$snapshot.inputTokens-eq 150) 'input token total is aggregated'\n  Assert-Aih ([int]$snapshot.uncachedInputTokens-eq 150) 'uncached token total is aggregated'\n  Assert-Aih ([int]$snapshot.cacheReadTokens-eq 750) 'cache-read token total is aggregated'\n  Assert-Aih ([int]$snapshot.outputTokens-eq 30) 'output token total is aggregated'\n  Assert-Aih ($null-eq$snapshot.estimatedCost) 'cost remains unavailable when runtime does not provide it'\n  Write-Host "RESULT: $passed engineering telemetry assertions passed."\n} finally { if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force} }\n`)

// 6) Add both focused suites to the durable full harness.
replaceLiteral(
  'scripts/Test-Harness.ps1',
`    [ordered]@{ name='EpistemicPolicy'; script='tests\\EpistemicPolicy.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='ControllerRouting'; script='tests\\ControllerRouting.Tests.ps1'; executable=$powershell; kind='powershell' },`,
`    [ordered]@{ name='EpistemicPolicy'; script='tests\\EpistemicPolicy.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='EngineeringTelemetry'; script='tests\\EngineeringTelemetry.Tests.ps1'; executable=$powershell; kind='powershell' },
    [ordered]@{ name='ControllerRouting'; script='tests\\ControllerRouting.Tests.ps1'; executable=$powershell; kind='powershell' },`,
  'add-telemetry-suite',
)
replaceLiteral(
  'scripts/Test-Harness.ps1',
`    [ordered]@{ name='AihController'; script='tests\\AihController.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='AihControllerIdentity'; script='tests\\AihControllerIdentity.Tests.cjs'; executable=$layout.Node; kind='node' }`,
`    [ordered]@{ name='AihController'; script='tests\\AihController.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='EpistemicProductionHardening'; script='tests\\EpistemicProductionHardening.Tests.cjs'; executable=$layout.Node; kind='node' },
    [ordered]@{ name='AihControllerIdentity'; script='tests\\AihControllerIdentity.Tests.cjs'; executable=$layout.Node; kind='node' }`,
  'add-production-hardening-suite',
)

console.log('Epistemic production hardening patch applied.')
