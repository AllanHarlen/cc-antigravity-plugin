param(
  [string]$ClaudeCommand = "claude",
  [switch]$NoTail
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogsDir = Join-Path $RepoRoot ".antigravitycli\logs"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogPath = Join-Path $LogsDir "claude-plugin-$Stamp.jsonl"
New-Item -ItemType File -Force -Path $LogPath | Out-Null

$Claude = Get-Command $ClaudeCommand -ErrorAction SilentlyContinue
if (-not $Claude) {
  throw "Claude Code command '$ClaudeCommand' was not found on PATH. Pass -ClaudeCommand with the correct executable name."
}

$env:CC_ANTIGRAVITY_LOG_PATH = $LogPath
$env:CLAUDE_PLUGIN_ROOT = $RepoRoot

Write-Host "cc-antigravity-plugin dev session"
Write-Host "Repo: $RepoRoot"
Write-Host "Log:  $LogPath"
Write-Host ""
Write-Host "Inside Claude Code, run a controlled command such as:"
Write-Host '/plugin marketplace add ./'
Write-Host '/plugin install cc-antigravity-plugin@cc-antigravity-plugin'
Write-Host '/reload-plugins'
Write-Host '/cc-antigravity-plugin:antigravity --files package.json --timeout 2m responda apenas plugin-log-ok'
Write-Host ""

if (-not $NoTail) {
  $Pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
  if (-not $Pwsh) {
    $Pwsh = Get-Command powershell -ErrorAction Stop
  }

  $TailCommand = @"
Write-Host 'Monitoring cc-antigravity-plugin log:'
Write-Host '$LogPath'
Write-Host ''
Get-Content -LiteralPath '$LogPath' -Wait
"@

  Start-Process -FilePath $Pwsh.Source -ArgumentList @("-NoExit", "-Command", $TailCommand) | Out-Null
}

Push-Location $RepoRoot
try {
  & $Claude.Source
}
finally {
  Pop-Location
  Write-Host ""
  Write-Host "Claude Code session ended."
  Write-Host "Log file: $LogPath"
}
