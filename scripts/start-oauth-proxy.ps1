# Scripts / Start Google Gemini OAuth Micro-Proxy for Surface Pro 9
param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Starting Google Gemini OAuth Micro-Proxy on port $Port " -ForegroundColor Cyan
Write-Host " Surface Pro 9 Zero-Cost Dual-Engine Bridge               " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$scriptPath = Join-Path $PSScriptRoot "oauth-proxy.mjs"
if (-not (Test-Path $scriptPath)) {
  Write-Error "Could not find $scriptPath"
  exit 1
}

$env:PORT = "$Port"
node $scriptPath
