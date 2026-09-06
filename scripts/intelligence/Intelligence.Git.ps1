Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Git abstraction (Phase 3.1B) ─────────────────────────────────────────────
# All Git interaction in Nexus goes through a GitProvider. Higher layers never
# spawn git themselves. The default provider shells out to the git CLI; the
# interface is designed so the implementation can change (library, worktree
# cache, remote service) without affecting higher layers.

function Invoke-AihGitCommand {
    # Runs git with UTF-8 decoding independent of the console codepage and a
    # hard timeout. Returns @{ ExitCode; StdOut; StdErr }.
    param(
        [string]$Path,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$TimeoutSeconds = 30
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.Arguments = (Invoke-AihGitQuoteArguments $Arguments)
    if (-not [string]::IsNullOrWhiteSpace($Path) -and (Test-Path -LiteralPath $Path)) {
        $psi.WorkingDirectory = [IO.Path]::GetFullPath($Path)
    }
    $psi.FileName = 'git'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $psi.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    $psi.EnvironmentVariables['GCM_INTERACTIVE'] = 'Never'
    $process = [System.Diagnostics.Process]::Start($psi)
    try {
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch { }
            throw "git timed out after $TimeoutSeconds seconds: $($Arguments -join ' ')"
        }
        return @{
            ExitCode = $process.ExitCode
            StdOut   = $stdoutTask.GetAwaiter().GetResult()
            StdErr   = $stderrTask.GetAwaiter().GetResult()
        }
    } finally {
        $process.Dispose()
    }
}

function Invoke-AihGitQuoteArguments {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $quoted = @()
    foreach ($argument in $Arguments) {
        if ($null -eq $argument) { continue }
        if ($argument -match '[\s"]') {
            $escaped = $argument.Replace('"', '\"')
            $quoted = @($quoted) + @('"' + $escaped + '"')
        } else {
            $quoted = @($quoted) + @($argument)
        }
    }
    return ($quoted -join ' ')
}

function ConvertTo-AihGitCleanPath {
    # Git prints forward-slash paths; normalize without changing case.
    param([string]$Path)
    if ($null -eq $Path) { return $null }
    return $Path.Trim().Replace('\', '/')
}

function Get-AihGitSplitNul {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return @() }
    return @($Text -split ([string][char]0))
}

function Get-AihGitWorkingTreeStatus {
    # Parses git status --porcelain=v1 -z --untracked-files=all.
    # Renames arrive as "XY to-path" followed by the from-path token.
    # Kinds: staged, modified, deleted, renamed, untracked, unmerged.
    param([Parameter(Mandatory = $true)][string]$Path)
    $result = Invoke-AihGitCommand -Path $Path -Arguments @('status', '--porcelain=v1', '-z', '--untracked-files=all')
    if ($result.ExitCode -ne 0) { throw "git status failed for $Path : $($result.StdErr.Trim())" }
    $tokens = @(Get-AihGitSplitNul $result.StdOut)
    $entries = @()
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        $token = $tokens[$i]
        if ([string]::IsNullOrEmpty($token)) { continue }
        $xy = $token.Substring(0, [Math]::Min(2, $token.Length))
        $relative = $token.Substring(2)
        if ($xy -eq '??') {
            $entries = @($entries) + @([pscustomobject]@{ kind = 'untracked'; path = (ConvertTo-AihGitCleanPath $relative); oldPath = $null })
            continue
        }
        if ($xy -match 'U') {
            $entries = @($entries) + @([pscustomobject]@{ kind = 'unmerged'; path = (ConvertTo-AihGitCleanPath $relative); oldPath = $null })
            continue
        }
        if ($xy -match '[RC]') {
            $oldPath = $null
            if ($i + 1 -lt $tokens.Count) {
                $i = $i + 1
                $oldPath = ConvertTo-AihGitCleanPath $tokens[$i]
            }
            $entries = @($entries) + @([pscustomobject]@{ kind = 'renamed'; path = (ConvertTo-AihGitCleanPath $relative); oldPath = $oldPath })
            continue
        }
        if ($xy -match 'D') {
            $entries = @($entries) + @([pscustomobject]@{ kind = 'deleted'; path = (ConvertTo-AihGitCleanPath $relative); oldPath = $null })
            continue
        }
        if ($xy[0] -ne ' ') {
            # index has a change: staged (A/M; R handled above where applicable)
            $entries = @($entries) + @([pscustomobject]@{ kind = 'staged'; path = (ConvertTo-AihGitCleanPath $relative); oldPath = $null })
            continue
        }
        if ($xy[1] -eq 'M') {
            $entries = @($entries) + @([pscustomobject]@{ kind = 'modified'; path = (ConvertTo-AihGitCleanPath $relative); oldPath = $null })
            continue
        }
        # remaining combinations are not reported with -uall; skip safely
    }
    return $entries
}

function New-AihGitCliProvider {
    # The GitProvider interface. Each property is a scriptblock; higher layers
    # call them via & $provider.<Capability>. All paths returned are normalized
    # POSIX-style; repository-relative paths are never absolute.
    [pscustomobject]@{
        Name = 'git-cli'
        IsRepository = {
            param([string]$Path)
            $result = Invoke-AihGitCommand -Path $Path -Arguments @('rev-parse', '--is-inside-work-tree')
            return ($result.ExitCode -eq 0 -and $result.StdOut.Trim() -eq 'true')
        }.GetNewClosure()
        GetRoot = {
            param([string]$Path)
            $result = Invoke-AihGitCommand -Path $Path -Arguments @('rev-parse', '--show-toplevel')
            if ($result.ExitCode -ne 0) { return $null }
            return (ConvertTo-AihGitCleanPath $result.StdOut)
        }.GetNewClosure()
        GetHeadSha = {
            param([string]$Path)
            $result = Invoke-AihGitCommand -Path $Path -Arguments @('rev-parse', 'HEAD')
            if ($result.ExitCode -ne 0) { return $null }   # unborn HEAD or not a repo
            $sha = $result.StdOut.Trim()
            if ([string]::IsNullOrEmpty($sha)) { return $null }
            return $sha
        }.GetNewClosure()
        GetBranch = {
            param([string]$Path)
            $result = Invoke-AihGitCommand -Path $Path -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')
            if ($result.ExitCode -ne 0) { return $null }
            $branch = $result.StdOut.Trim()
            if ([string]::IsNullOrEmpty($branch) -or $branch -eq 'HEAD') { return $null }  # detached HEAD
            return $branch
        }.GetNewClosure()
        IsDetachedHead = {
            param([string]$Path)
            $result = Invoke-AihGitCommand -Path $Path -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')
            if ($result.ExitCode -ne 0) { return $false }
            return ($result.StdOut.Trim() -eq 'HEAD')
        }.GetNewClosure()
        GetRemote = {
            # Never assumes 'origin'. Prefers origin when present, otherwise the
            # first remote in sorted order. Repositories may have no remote.
            param([string]$Path)
            $list = Invoke-AihGitCommand -Path $Path -Arguments @('remote')
            if ($list.ExitCode -ne 0) { return $null }
            $names = @($list.StdOut -split ([string][char]10) | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' } | Sort-Object)
            if (@($names).Count -eq 0) { return $null }
            $chosen = if (@($names) -contains 'origin') { 'origin' } else { $names[0] }
            $url = Invoke-AihGitCommand -Path $Path -Arguments @('remote', 'get-url', $chosen)
            if ($url.ExitCode -ne 0) { return $null }
            return [pscustomobject]@{ name = $chosen; url = $url.StdOut.Trim() }
        }.GetNewClosure()
        GetDefaultBranch = {
            param([string]$Path)
            $symref = Invoke-AihGitCommand -Path $Path -Arguments @('symbolic-ref', 'refs/remotes/origin/HEAD')
            if ($symref.ExitCode -eq 0) {
                $value = $symref.StdOut.Trim()
                $idx = $value.LastIndexOf('/')
                if ($idx -ge 0 -and $idx -lt $value.Length - 1) { return $value.Substring($idx + 1) }
            }
            foreach ($candidate in @('main', 'master')) {
                $probe = Invoke-AihGitCommand -Path $Path -Arguments @('show-ref', '--verify', '--quiet', ('refs/heads/' + $candidate))
                if ($probe.ExitCode -eq 0) { return $candidate }
            }
            $head = Invoke-AihGitCommand -Path $Path -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')
            if ($head.ExitCode -eq 0) {
                $branch = $head.StdOut.Trim()
                if (-not [string]::IsNullOrEmpty($branch) -and $branch -ne 'HEAD') { return $branch }
            }
            return $null
        }.GetNewClosure()
        GetWorkingTreeStatus = {
            param([string]$Path)
            return Get-AihGitWorkingTreeStatus $Path
        }.GetNewClosure()
        GetTrackedFiles = {
            param([string]$Path)
            $result = Invoke-AihGitCommand -Path $Path -Arguments @('ls-files', '-z')
            if ($result.ExitCode -ne 0) { return @() }
            return @(Get-AihGitSplitNul $result.StdOut | ForEach-Object { ConvertTo-AihGitCleanPath $_ } | Where-Object { $_ -ne '' })
        }.GetNewClosure()
        DetectWorktree = {
            param([string]$Path)
            $gitDir = Invoke-AihGitCommand -Path $Path -Arguments @('rev-parse', '--absolute-git-dir')
            if ($gitDir.ExitCode -ne 0) { return [pscustomobject]@{ isWorktree = $false; gitDir = $null; commonDir = $null } }
            $common = Invoke-AihGitCommand -Path $Path -Arguments @('rev-parse', '--git-common-dir')
            $gitDirPath = ConvertTo-AihGitCleanPath $gitDir.StdOut
            $commonRaw = ConvertTo-AihGitCleanPath $common.StdOut
            if (-not [string]::IsNullOrEmpty($commonRaw) -and -not [IO.Path]::IsPathRooted($commonRaw)) {
                $commonRaw = ConvertTo-AihGitCleanPath ([IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetFullPath($Path)) $commonRaw)))
            }
            $isWorktree = -not [string]::IsNullOrEmpty($commonRaw) -and (Get-AihPathCaseKey $gitDirPath) -ne (Get-AihPathCaseKey $commonRaw)
            return [pscustomobject]@{ isWorktree = $isWorktree; gitDir = $gitDirPath; commonDir = $commonRaw }
        }.GetNewClosure()
    }
}

$script:AihGitProvider = $null

function Get-AihGitProvider {
    if ($null -eq $script:AihGitProvider) { $script:AihGitProvider = New-AihGitCliProvider }
    return $script:AihGitProvider
}

function Set-AihGitProvider {
    # Replacement seam for tests and future implementations.
    param([AllowNull()]$Provider)
    $script:AihGitProvider = $Provider
    return $Provider
}

function ConvertTo-AihNormalizedRemote {
    # Normalizes equivalent remote URL forms to one comparable key:
    #   git@github.com:user/project.git  ->  github.com/user/project
    #   https://github.com/user/project.git -> github.com/user/project
    #   ssh://git@github.com/user/project   -> github.com/user/project
    # Case: host and path are lowercased for comparison purposes only; the
    # original URL is stored verbatim on the repository record.
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return $null }
    $value = $Url.Trim()
    if ($value -match '^git@([^:/]+)[:/](.+?)(?:\.git)?/?$') {
        return ($Matches[1].ToLowerInvariant() + '/' + $Matches[2].ToLowerInvariant())
    }
    if ($value -match '^(?:https?|ssh|git)://(?:[^/@]+@)?([^/:]+)(?::\d+)?/(.+?)(?:\.git)?/?$') {
        return ($Matches[1].ToLowerInvariant() + '/' + $Matches[2].ToLowerInvariant())
    }
    # Unknown scheme: keep a conservative, verbatim-derived key.
    return ('raw:' + $value.ToLowerInvariant())
}
