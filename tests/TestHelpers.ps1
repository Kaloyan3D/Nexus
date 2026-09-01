Set-StrictMode -Version Latest

function Resolve-AihExpectedProfileTargets {
    # Test-only composition helper; every resolution primitive below is the
    # production Routing.ps1 implementation. This centralizes composition,
    # not model/provider semantics.
    param(
        [Parameter(Mandatory=$true)]$Policy,
        [Parameter(Mandatory=$true)]$Profiles,
        [Parameter(Mandatory=$true)]$Registry,
        [string]$Preset='aih-engineering',
        [string]$SettingsPath,
        [string[]]$Roles=@('primaryEngineer','deepEngineer','reviewer')
    )
    $resolvedPreset=Resolve-AihPreset $Policy $Preset
    $activeProfile=Resolve-AihProfile $Policy $resolvedPreset $Profiles $SettingsPath
    $targets=[ordered]@{}
    foreach($role in $Roles){$targets[$role]=Resolve-AihModelTarget $Registry $activeProfile $role}
    return [pscustomobject]@{Preset=$resolvedPreset;Profile=$activeProfile;Targets=[pscustomobject]$targets}
}
