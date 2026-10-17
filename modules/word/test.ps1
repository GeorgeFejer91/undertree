param([string]$OutputDirectory, [switch]$InstalledWord, [switch]$NativeWord)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo ('artifacts/word/checks-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Choose a new evidence directory to preserve previous checks.' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$powershell = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $powershell)) { throw 'Run the Word verification driver with PowerShell 7.' }
$gates = [Collections.Generic.List[object]]::new()
function Run-Gate([string]$Name, [string]$Program, [string[]]$Arguments) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $output = & $Program @Arguments 2>&1
    $code = $LASTEXITCODE
    $output | Set-Content -LiteralPath (Join-Path $OutputDirectory ($Name+'.log')) -Encoding utf8
    $gates.Add([ordered]@{gate=$Name;exitCode=$code;milliseconds=$timer.ElapsedMilliseconds;status=$(if($code -eq 0){'PASS'}else{'FAIL'})})
    $output | Write-Output
    if ($code -ne 0) { throw "$Name failed; inspect its evidence log." }
}
try {
    $payload = Join-Path $OutputDirectory 'payload'
    Run-Gate 'build' $powershell @('-NoProfile','-File',(Join-Path $PSScriptRoot 'build.ps1'),'-OutputDirectory',$payload)
    $policy = Join-Path $OutputDirectory 'PolicyTests.exe'
    $policySources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter 'Policy*.cs' | ForEach-Object FullName)
    Run-Gate 'policy-compile' $compiler (@('/nologo','/target:exe','/langversion:5',"/out:$policy",'/r:System.Web.Extensions.dll') + $policySources + @((Join-Path $PSScriptRoot 'tests/PolicyTests.cs')))
    Run-Gate 'policy' $policy @((Join-Path $repo 'modules/review/selective-editor-contract.json'))
    $nativePolicy = Join-Path $OutputDirectory 'NativeReviewPolicyTests.exe'
    Run-Gate 'native-review-policy-compile' $compiler (@('/nologo','/target:exe','/langversion:5',"/out:$nativePolicy",'/r:System.Web.Extensions.dll') + $policySources + @((Join-Path $PSScriptRoot 'tests/NativeReviewPolicyTests.cs')))
    Run-Gate 'native-review-policy' $nativePolicy @((Join-Path $repo 'modules/review/selective-editor-contract.json'))
    $mapping = Join-Path $OutputDirectory 'WordTextMapTests.exe'
    Run-Gate 'word-text-map-compile' $compiler (@('/nologo','/target:exe','/langversion:5',"/out:$mapping",'/r:System.Web.Extensions.dll','/r:Microsoft.CSharp.dll') + $policySources + @((Join-Path $PSScriptRoot 'src/WordTextMap.cs'),(Join-Path $PSScriptRoot 'tests/WordTextMapTests.cs')))
    Run-Gate 'word-text-map' $mapping @()
    Run-Gate 'com-contract' $powershell @('-NoProfile','-File',(Join-Path $PSScriptRoot 'test-com-contract.ps1'),'-AssemblyPath',(Join-Path $payload 'wrAIter.Word.dll'),'-OutputDirectory',(Join-Path $OutputDirectory 'com'))
    Run-Gate 'transport' $powershell @('-NoProfile','-File',(Join-Path $PSScriptRoot 'tests/test-transport.ps1'),'-OutputDirectory',(Join-Path $OutputDirectory 'transport'),'-MutationCheck')
    $ui = Join-Path $OutputDirectory 'UiLayoutSmoke.exe'
    $sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.cs' | ForEach-Object FullName)
    Run-Gate 'ui-compile' $compiler (@('/nologo','/target:exe','/langversion:5',"/out:$ui",'/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll','/r:System.Security.dll','/r:Microsoft.CSharp.dll',"/resource:$(Join-Path $repo 'modules/review/selective-editor-contract.json'),SelectiveEditorContract", "/resource:$(Join-Path $repo 'assets/wraiter/icon16.png'),wrAIter.Ribbon.png", "/resource:$(Join-Path $repo 'assets/wraiter/icon.ico'),wrAIter.Icon.ico") + $sources + @((Join-Path $PSScriptRoot 'tests/UiLayoutSmoke.cs')))
    Run-Gate 'native-ui' $ui @((Join-Path $OutputDirectory 'ui'), (Join-Path $repo 'assets/wraiter'))
    if ($NativeWord) {
        Run-Gate 'native-word-review' $powershell @('-NoProfile','-File',(Join-Path $PSScriptRoot 'tests/test-native-review.ps1'),'-OutputDirectory',(Join-Path $OutputDirectory 'native-review'))
        Run-Gate 'native-word-highlighting' $powershell @('-NoProfile','-File',(Join-Path $PSScriptRoot 'tests/test-native-highlighting.ps1'),'-OutputDirectory',(Join-Path $OutputDirectory 'native-highlighting'))
        Run-Gate 'native-word-direct-highlighting' $powershell @('-NoProfile','-File',(Join-Path $PSScriptRoot 'tests/test-native-highlighting.ps1'),'-OutputDirectory',(Join-Path $OutputDirectory 'native-direct-highlighting'),'-DirectMode')
    }
    Run-Gate 'architecture' (Get-Command node).Source @((Join-Path $repo 'modules/maintenance/validate-architecture.mjs'))
    if ($InstalledWord) {
        Run-Gate 'installed-word' $powershell @('-NoProfile','-File',(Join-Path $PSScriptRoot 'tests/test-installed.ps1'),'-OutputDirectory',(Join-Path $OutputDirectory 'installed-word'))
    }
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $payload 'build-manifest.json') | ConvertFrom-Json
    foreach ($entry in $manifest.inputs) {
        if ((Get-FileHash -LiteralPath (Join-Path $repo $entry.path)).Hash.ToLowerInvariant() -ne $entry.sha256) { throw "Source changed during checks: $($entry.path)" }
    }
    [ordered]@{status='PARTIAL';components='PASS';gates=$gates;assemblySha256=(Get-FileHash -LiteralPath (Join-Path $payload 'wrAIter.Word.dll')).Hash.ToLowerInvariant();installedWord=$(if($InstalledWord){'PASS'}else{'NOT RUN'});publicTunnel='NOT RUN'} |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'result.json') -Encoding utf8
    Write-Output "Word check evidence: $OutputDirectory"
}
catch {
    [ordered]@{status='FAIL';gates=$gates;error=$_.Exception.Message;installedWord=$(if($InstalledWord){'FAILED OR NOT REACHED'}else{'NOT RUN'});publicTunnel='NOT RUN'} |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'result.json') -Encoding utf8
    throw
}
