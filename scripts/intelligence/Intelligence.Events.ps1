Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Intelligence event bus (Phase 3.1F) ─────────────────────────────────────
# In-process pub/sub with an append-only journal. No external broker in 3.1.
# The ONLY dispatch point is Publish-AihIntEvent, so a future transport
# (Redis/Kafka/NATS or a DSH-native channel) can replace the implementation
# without touching emitters or subscribers. Handlers must not throw; a failing
# handler is recorded as event.handler.error in the journal and never corrupts
# the emitting operation.

$script:AihIntEventSubscriptions = @()
$script:AihIntEventSubscriptionSequence = 0

function Subscribe-AihIntEvent {
    # Pattern matching uses PowerShell -like wildcards, e.g. 'snapshot.*'.
    param(
        [Parameter(Mandatory = $true)][string]$EventTypePattern,
        [Parameter(Mandatory = $true)][scriptblock]$Handler
    )
    $script:AihIntEventSubscriptionSequence = $script:AihIntEventSubscriptionSequence + 1
    $subscription = [pscustomobject]@{
        subscriptionId = ('sub_' + [guid]::NewGuid().ToString('N'))
        sequence       = $script:AihIntEventSubscriptionSequence
        pattern        = $EventTypePattern
        handler        = $Handler
    }
    $script:AihIntEventSubscriptions = @($script:AihIntEventSubscriptions) + @($subscription)
    return $subscription
}

function Unregister-AihIntEventSubscription {
    param([Parameter(Mandatory = $true)][string]$SubscriptionId)
    $remaining = @($script:AihIntEventSubscriptions | Where-Object { $_.subscriptionId -ne $SubscriptionId })
    $removed = @($script:AihIntEventSubscriptions).Count - $remaining.Count
    $script:AihIntEventSubscriptions = $remaining
    return ($removed -gt 0)
}

function Get-AihIntEventSubscriptionList {
    return @($script:AihIntEventSubscriptions)
}

function Publish-AihIntEvent {
    param(
        [string]$StoreRoot,
        [Parameter(Mandatory = $true)][string]$EventType,
        $Data = $null
    )
    $record = [ordered]@{
        schemaVersion = 1
        timestampUtc  = [DateTime]::UtcNow.ToString('o')
        type          = $EventType
        data          = $Data
    }
    if (-not [string]::IsNullOrWhiteSpace($StoreRoot)) {
        $layout = Get-AihIntelligenceLayout $StoreRoot
        Add-AihJsonLine -Path $layout.Events -Value $record
    }
    foreach ($subscription in @($script:AihIntEventSubscriptions)) {
        if (-not ($EventType -like $subscription.pattern)) { continue }
        try {
            & $subscription.handler ([pscustomobject]$record)
        } catch {
            # A broken subscriber must never corrupt the emitter. The failure is
            # journaled directly (no recursive publish) with bounded data.
            $failure = [ordered]@{
                schemaVersion = 1
                timestampUtc  = [DateTime]::UtcNow.ToString('o')
                type          = 'event.handler.error'
                data          = [ordered]@{
                    eventType     = $EventType
                    subscriptionId = $subscription.subscriptionId
                    error         = $_.Exception.Message
                }
            }
            if (-not [string]::IsNullOrWhiteSpace($StoreRoot)) {
                $layout2 = Get-AihIntelligenceLayout $StoreRoot
                Add-AihJsonLine -Path $layout2.Events -Value $failure
            }
        }
    }
    return [pscustomobject]$record
}

function Get-AihIntEvents {
    # Tolerant reader: corrupt JSONL lines are skipped, healthy history survives.
    param([string]$StoreRoot, [string]$EventType, [int]$Limit = 0)
    if ([string]::IsNullOrWhiteSpace($StoreRoot)) { return @() }
    $layout = Get-AihIntelligenceLayout $StoreRoot
    if (-not (Test-Path -LiteralPath $layout.Events)) { return @() }
    $events = @()
    foreach ($line in (Get-Content -Encoding UTF8 -LiteralPath $layout.Events)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $parsed = $line | ConvertFrom-Json } catch { continue }
        if ($null -ne $parsed -and -not [string]::IsNullOrEmpty($EventType) -and "$($parsed.type)" -ne $EventType) { continue }
        $events = @($events) + @($parsed)
    }
    if ($Limit -gt 0 -and $events.Count -gt $Limit) { return @($events[($events.Count - $Limit)..($events.Count - 1)]) }
    return $events
}
