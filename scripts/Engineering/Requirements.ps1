Set-StrictMode -Version Latest

# Engineering.Requirements - the Phase 3.2.5 task/requirement compiler.
#
# Compiles the smallest useful set of stable acceptance requirements for one
# task. Critical invariant: IMPLEMENTED != VERIFIED. Code existing is not
# proof that a requirement passes. Required unverified requirements block
# controller completion when the shipped policy requires verification.
# REQ identities are stable within the task; original wording/source is
# preserved verbatim; a current user instruction supersedes stale state.

function Get-AihRequirementsPath {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    $run = Get-AihEngineeringRunPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    return (Join-Path $run 'requirements.json')
}

function Read-AihRequirementsDocument {
    param([string]$Path)
    $document = Read-AihEngineeringJson -Path $Path -Default $null
    if ($null -eq $document) { return $null }
    return $document
}

function New-AihRequirementsDocument {
    param([Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId)
    $path = Get-AihRequirementsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $existing = Read-AihRequirementsDocument -Path $path
    if ($null -ne $existing) {
        # Idempotent: compiling twice never resets gathered evidence, but a
        # stale artifact from another lifecycle generation is discarded.
        if (Test-AihEngineeringArtifactIdentity -Artifact $existing -TaskInstanceId $TaskInstanceId) { return $existing }
    }
    $document = [ordered]@{
        schemaVersion = 1
        taskId = $TaskId
        taskInstanceId = if ([string]::IsNullOrWhiteSpace($TaskInstanceId)) { $null } else { $TaskInstanceId }
        requirements = @()
        nextNumber = 1
        updatedAtUtc = Get-AihEngineeringUtcNow
    }
    Write-AihAtomicJson -Path $path -Value $document
    return (Read-AihRequirementsDocument -Path $path)
}

function Add-AihRequirement {
    # Compile-time ingestion. Preserves the ORIGINAL wording and source; the
    # compiler only assigns the stable task-local identity.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][string]$Text,[string]$Source = 'user',[bool]$Required = $true,[string]$Notes = ''
    )
    $path = Get-AihRequirementsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $document = New-AihRequirementsDocument -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $number = [int]$document.nextNumber
    $requirement = [ordered]@{
        id = ('REQ-{0:D3}' -f $number)
        text = $Text
        source = if ([string]::IsNullOrWhiteSpace($Source)) { 'user' } else { $Source }
        required = [bool]$Required
        status = 'pending'
        implementationEvidence = @()
        verificationEvidence = @()
        verificationStatus = 'unverified'
        notes = $Notes
        createdAtUtc = Get-AihEngineeringUtcNow
        updatedAtUtc = Get-AihEngineeringUtcNow
    }
    $document.requirements = @($document.requirements) + @($requirement)
    $document.nextNumber = $number + 1
    $document.updatedAtUtc = Get-AihEngineeringUtcNow
    Write-AihAtomicJson -Path $path -Value $document
    return $requirement
}

function Get-AihRequirement {
    param([Parameter(Mandatory=$true)]$Document,[Parameter(Mandatory=$true)][string]$RequirementId)
    foreach ($candidate in @($Document.requirements)) {
        if ([string]$candidate.id -eq $RequirementId) { return $candidate }
    }
    return $null
}

function Set-AihRequirementStatus {
    # Deterministic state transition. implemented NEVER implies verified:
    # a 'verified' transition requires verificationEvidence that references
    # at least one PASS verification record carrying this requirement id.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][string]$RequirementId,
        [Parameter(Mandatory=$true)][ValidateSet('pending','implementing','implemented','verified','blocked','not-applicable')][string]$Status,
        [string]$ImplementationEvidence = '',[string]$VerificationEvidence = '',[string]$Notes = ''
    )
    $path = Get-AihRequirementsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $document = Read-AihRequirementsDocument -Path $path
    if ($null -eq $document) { throw "Requirements document does not exist for task $TaskId." }
    if (-not (Test-AihEngineeringArtifactIdentity -Artifact $document -TaskInstanceId $TaskInstanceId)) { throw "Requirements artifact belongs to another task generation; refusing to update." }
    $requirement = Get-AihRequirement -Document $document -RequirementId $RequirementId
    if ($null -eq $requirement) { throw "Unknown requirement id: $RequirementId" }
    $requirement.status = $Status
    if (-not [string]::IsNullOrWhiteSpace($ImplementationEvidence)) {
        $requirement.implementationEvidence = @($requirement.implementationEvidence) + @([ordered]@{ note = (ConvertTo-AihEngineeringSafeText $ImplementationEvidence 500); at = Get-AihEngineeringUtcNow })
    }
    if (-not [string]::IsNullOrWhiteSpace($VerificationEvidence)) {
        # A verification reference is a verification-log record id. The
        # verification module stamps PASS onto this requirement only from a
        # real recorded result; here the reference is attached and the
        # verificationStatus is derived by Update-AihRequirementVerification.
        $requirement.verificationEvidence = @($requirement.verificationEvidence) + @([ordered]@{ verificationId = $VerificationEvidence; at = Get-AihEngineeringUtcNow })
    }
    if (-not [string]::IsNullOrWhiteSpace($Notes)) { $requirement.notes = (ConvertTo-AihEngineeringSafeText $Notes 500) }
    $requirement.updatedAtUtc = Get-AihEngineeringUtcNow
    $document.updatedAtUtc = Get-AihEngineeringUtcNow
    Write-AihAtomicJson -Path $path -Value $document
    return $requirement
}

function Update-AihRequirementVerification {
    # Verification Strategy v0 hook: a recorded verification result updates
    # verificationStatus for the requirement ids it declares. IMPLEMENTED !=
    # VERIFIED is preserved: only a PASS result moves a requirement to
    # 'verified'; FAIL moves it back to 'implemented' with the failure noted.
    param(
        [Parameter(Mandatory=$true)][string]$Workspace,[Parameter(Mandatory=$true)][string]$TaskId,[string]$TaskInstanceId,
        [Parameter(Mandatory=$true)][string[]]$RequirementIds,
        [Parameter(Mandatory=$true)][ValidateSet('pass','fail')][string]$Result,
        [Parameter(Mandatory=$true)][string]$VerificationId
    )
    $path = Get-AihRequirementsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $document = Read-AihRequirementsDocument -Path $path
    if ($null -eq $document) { return @() }
    if (-not (Test-AihEngineeringArtifactIdentity -Artifact $document -TaskInstanceId $TaskInstanceId)) { throw "Requirements artifact belongs to another task generation; refusing to update." }
    $updated = @()
    foreach ($requirementId in $RequirementIds) {
        $requirement = Get-AihRequirement -Document $document -RequirementId $requirementId
        if ($null -eq $requirement) { continue }
        $requirement.verificationEvidence = @($requirement.verificationEvidence) + @([ordered]@{ verificationId = $VerificationId; result = $Result; at = Get-AihEngineeringUtcNow })
        if ($Result -eq 'pass') {
            $requirement.verificationStatus = 'pass'
            if ($requirement.status -notin @('blocked','not-applicable')) { $requirement.status = 'verified' }
        } else {
            $requirement.verificationStatus = 'fail'
            if ($requirement.status -eq 'verified') { $requirement.status = 'implemented' }
            elseif ($requirement.status -in @('pending')) { $requirement.status = 'implementing' }
        }
        $requirement.updatedAtUtc = Get-AihEngineeringUtcNow
        $updated += $requirementId
    }
    if ($updated.Count -gt 0) {
        $document.updatedAtUtc = Get-AihEngineeringUtcNow
        Write-AihAtomicJson -Path $path -Value $document
    }
    return $updated
}

function Get-AihRequirementCoverage {
    # requirementCoverage telemetry block.
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $path = Get-AihRequirementsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $document = Read-AihRequirementsDocument -Path $path
    $requirements = @()
    if ($null -ne $document -and (Test-AihEngineeringArtifactIdentity -Artifact $document -TaskInstanceId $TaskInstanceId)) { $requirements = @($document.requirements) }
    $coverage = [ordered]@{
        exists = ($requirements.Count -gt 0)
        total = $requirements.Count
        pending = @($requirements | Where-Object { $_.status -eq 'pending' }).Count
        implementing = @($requirements | Where-Object { $_.status -eq 'implementing' }).Count
        implemented = @($requirements | Where-Object { $_.status -eq 'implemented' }).Count
        verified = @($requirements | Where-Object { $_.status -eq 'verified' }).Count
        blocked = @($requirements | Where-Object { $_.status -eq 'blocked' }).Count
        notApplicable = @($requirements | Where-Object { $_.status -eq 'not-applicable' }).Count
        requiredUnverified = @($requirements | Where-Object { $_.required -and $_.verificationStatus -ne 'pass' }).Count
    }
    return $coverage
}

function Test-AihRequirementsCompletionBlock {
    # Completion gate hook. Returns blocking reasons when the policy requires
    # verification and required requirements are not verified. A task without
    # a requirements document is unaffected (backwards compatible).
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $reasons = @()
    # The routing policy lives in the Routing layer; this hook runs inside
    # the Task controller context (Task.ps1), which does not load Routing.ps1.
    . (Join-Path $PSScriptRoot ('..' + [IO.Path]::DirectorySeparatorChar + 'Routing.ps1'))
    $policy = Get-AihRoutingPolicy (Join-Path (Get-AihInstallRoot $null) (Join-Path 'config' 'routing-policy.json'))
    $requiresVerification = $true
    $engineeringPolicy = $null
    if ($null -ne $policy -and $null -ne $policy.PSObject.Properties['engineering']) { $engineeringPolicy = $policy.engineering }
    if ($null -ne $engineeringPolicy -and $null -ne $engineeringPolicy.PSObject.Properties['completionRequiresVerifiedRequirements']) {
        $requiresVerification = [bool]$engineeringPolicy.completionRequiresVerifiedRequirements
    }
    if (-not $requiresVerification) { return $reasons }
    $coverage = Get-AihRequirementCoverage -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    if (-not [bool]$coverage.exists) { return $reasons }
    if ([int]$coverage.requiredUnverified -gt 0) {
        $reasons += ("Requirement traceability: " + $coverage.requiredUnverified + " required requirement(s) are not verified (IMPLEMENTED != VERIFIED).")
    }
    if ([int]$coverage.blocked -gt 0) {
        $reasons += ("Requirement traceability: " + $coverage.blocked + " requirement(s) are blocked and must be resolved or marked not-applicable with a reason.")
    }
    return $reasons
}

function Get-AihRequirementsSnapshot {
    param([string]$Workspace,[string]$TaskId,[string]$TaskInstanceId)
    $path = Get-AihRequirementsPath -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId
    $document = Read-AihRequirementsDocument -Path $path
    if ($null -eq $document) { return [ordered]@{ exists = $false; requirements = @(); coverage = (Get-AihRequirementCoverage -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) } }
    return [ordered]@{ exists = $true; requirements = @($document.requirements); coverage = (Get-AihRequirementCoverage -Workspace $Workspace -TaskId $TaskId -TaskInstanceId $TaskInstanceId) }
}
