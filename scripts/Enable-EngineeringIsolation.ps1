[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$PresetDirectory)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$directory = [IO.Path]::GetFullPath($PresetDirectory)
$presetPath = Join-Path $directory 'agent.cordis.yml'
if (-not (Test-Path -LiteralPath $presetPath -PathType Leaf)) {
    throw "Engineering preset does not exist: $presetPath"
}
$text = Get-Content -Raw -Encoding UTF8 -LiteralPath $presetPath
if ($text -match '(?m)^- id: aih-engineering-isolation$') { exit 0 }
$text = $text.TrimEnd() + @'


- id: aih-engineering-isolation
  name: './Engineering-Isolation.cjs'
'@
[IO.File]::WriteAllText($presetPath, $text, [Text.UTF8Encoding]::new($false))
