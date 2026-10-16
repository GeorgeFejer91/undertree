$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build:installer:windows
exit $LASTEXITCODE
