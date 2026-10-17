param([string]$OutputDirectory, [string]$WordExecutable, [switch]$ManualMarkingOnly)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo ('artifacts/word/native-review-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Choose a new evidence directory.' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
if (-not $WordExecutable) { $WordExecutable = Join-Path $env:ProgramFiles 'Microsoft Office/root/Office16/WINWORD.EXE' }
if (-not (Test-Path -LiteralPath $WordExecutable)) { throw 'Specify the installed Word executable.' }
$sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '../src') -Filter '*.cs' | Sort-Object Name | ForEach-Object FullName)
$testSources = @((Join-Path $PSScriptRoot 'NativeReviewSmoke.cs'), (Join-Path $PSScriptRoot 'WordAutomation.cs'))
$contract = Join-Path $repo 'modules/review/selective-editor-contract.json'
$snapshot = @(@($sources) + $testSources + @($contract, $PSCommandPath) | ForEach-Object { [ordered]@{path=$_.Substring($repo.Length).TrimStart('\','/');sha256=(Get-FileHash -LiteralPath $_).Hash.ToLowerInvariant()} })
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$test = Join-Path $OutputDirectory 'NativeReviewSmoke.exe'
& $compiler /nologo /target:exe /langversion:5 "/out:$test" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Security.dll /r:Microsoft.CSharp.dll "/resource:$contract,SelectiveEditorContract" @sources @testSources
if ($LASTEXITCODE -ne 0) { throw 'Native review harness compilation failed.' }
$nativeArguments = @($WordExecutable, (Join-Path $OutputDirectory 'native'))
if ($ManualMarkingOnly) { $nativeArguments += 'manual-marking-only' }
& $test @nativeArguments 2>&1 | Tee-Object -FilePath (Join-Path $OutputDirectory 'native.log')
$code = $LASTEXITCODE
foreach ($entry in $snapshot) {
    if ((Get-FileHash -LiteralPath (Join-Path $repo $entry.path)).Hash.ToLowerInvariant() -ne $entry.sha256) { throw 'Source changed during native qualification; this result does not qualify the changed bytes.' }
}
[ordered]@{status=$(if($code -eq 0){'PASS'}else{'FAIL'});exitCode=$code;inputs=$snapshot;harnessSha256=(Get-FileHash -LiteralPath $test).Hash.ToLowerInvariant();wordSha256=(Get-FileHash -LiteralPath $WordExecutable).Hash.ToLowerInvariant();installedPackage='NOT RUN';publicTunnel='NOT RUN'} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'manifest.json') -Encoding utf8
if ($code -ne 0) { throw 'Isolated native Word review qualification failed.' }
