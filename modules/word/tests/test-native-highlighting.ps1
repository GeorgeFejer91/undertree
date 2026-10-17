param([string]$OutputDirectory, [string]$WordExecutable, [switch]$DirectMode)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo ('artifacts/word/native-highlighting-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Choose a new evidence directory.' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
if (-not $WordExecutable) { $WordExecutable = Join-Path $env:ProgramFiles 'Microsoft Office/root/Office16/WINWORD.EXE' }
if (-not (Test-Path -LiteralPath $WordExecutable)) { throw 'Specify the installed Word executable.' }
$sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '../src') -Filter '*.cs' | Sort-Object Name | ForEach-Object FullName)
$wordHarnessSource = if ($DirectMode) { 'NativeDirectHighlightingSmoke.cs' } else { 'NativeHighlightingSmoke.cs' }
$testSources = @((Join-Path $PSScriptRoot $wordHarnessSource), (Join-Path $PSScriptRoot 'WordAutomation.cs'))
$contract = Join-Path $repo 'modules/review/selective-editor-contract.json'
$snapshot = @(@($sources) + $testSources + @($contract, $PSCommandPath) | ForEach-Object { [ordered]@{path=[IO.Path]::GetRelativePath($repo,$_);sha256=(Get-FileHash -LiteralPath $_).Hash.ToLowerInvariant()} })
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$test = Join-Path $OutputDirectory 'NativeHighlightingSmoke.exe'
& $compiler /nologo /target:exe /langversion:5 "/out:$test" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Security.dll /r:Microsoft.CSharp.dll "/resource:$contract,SelectiveEditorContract" @sources @testSources
if ($LASTEXITCODE -ne 0) { throw 'Native highlighting harness compilation failed.' }
$nativeArguments = @($WordExecutable, (Join-Path $OutputDirectory 'native'))
if ($DirectMode) { $nativeArguments += 'direct' }
& $test @nativeArguments 2>&1 | Tee-Object -FilePath (Join-Path $OutputDirectory 'native.log')
$code = $LASTEXITCODE
$changed = @()
foreach ($entry in $snapshot) {
    $currentPath = Join-Path $repo $entry.path
    $actual = if (Test-Path -LiteralPath $currentPath) { (Get-FileHash -LiteralPath $currentPath).Hash.ToLowerInvariant() } else { 'missing' }
    if ($actual -ne $entry.sha256) { $changed += [ordered]@{path=$entry.path;expected=$entry.sha256;actual=$actual} }
}
[ordered]@{status=$(if($code -eq 0 -and $changed.Count -eq 0){'PASS'}else{'FAIL'});exitCode=$code;mode=$(if($DirectMode){'direct'}else{'native-track-changes'});inputs=$snapshot;changedInputs=$changed;harnessSha256=(Get-FileHash -LiteralPath $test).Hash.ToLowerInvariant();wordSha256=(Get-FileHash -LiteralPath $WordExecutable).Hash.ToLowerInvariant();installedPackage='NOT RUN';publicTunnel='NOT RUN'} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'manifest.json') -Encoding utf8
if ($changed.Count -ne 0) { throw 'Source changed during native qualification.' }
if ($code -ne 0) { throw 'Isolated native highlighting qualification failed.' }
