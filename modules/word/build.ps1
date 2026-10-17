param([string]$OutputDirectory, [string]$ZrokExecutable, [switch]$Installer)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'artifacts/word/build' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$assembly = Join-Path $OutputDirectory 'wrAIter.Word.dll'
$sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.cs' | Sort-Object Name | ForEach-Object FullName)
$contract = Join-Path $repo 'modules/review/selective-editor-contract.json'
$branding = Join-Path $repo 'assets/wraiter'
$inputs = @($sources) + @(Get-ChildItem -LiteralPath $branding -File | Sort-Object Name | ForEach-Object FullName) + @($contract, $PSCommandPath, (Join-Path $PSScriptRoot 'README.md'),
    (Join-Path $PSScriptRoot 'THIRD-PARTY.md'), (Join-Path $PSScriptRoot 'packaging/installer.nsi'), (Join-Path $PSScriptRoot 'packaging/zrok-LICENSE'))
$sourceSnapshot = @($inputs | ForEach-Object { [ordered]@{path=[IO.Path]::GetRelativePath($repo,$_);sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()} })
function Assert-SourceSnapshot {
    foreach ($entry in $sourceSnapshot) {
        if ((Get-FileHash -LiteralPath (Join-Path $repo $entry.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
            throw "Source changed during the Word build: $($entry.path). Rebuild from stable inputs."
        }
    }
}
$arguments = @('/nologo','/target:library','/platform:anycpu','/optimize+','/debug-','/langversion:5',"/out:$assembly",
    "/resource:$contract,SelectiveEditorContract", "/resource:$(Join-Path $branding 'icon16.png'),wrAIter.Ribbon.png", "/resource:$(Join-Path $branding 'icon.ico'),wrAIter.Icon.ico",'/r:System.dll','/r:System.Core.dll','/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll','/r:System.Xml.dll','/r:System.Security.dll','/r:Microsoft.CSharp.dll') + $sources
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'Word add-in compilation failed.' }
$runtime = Join-Path $OutputDirectory 'runtime'
if ($ZrokExecutable) {
    New-Item -ItemType Directory -Force $runtime | Out-Null
    Copy-Item -LiteralPath $ZrokExecutable -Destination (Join-Path $runtime 'zrok.exe') -Force
}
$packagedReadme = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'README.md')).Replace('../../assets/wraiter/icon.svg', 'wrAIter.ico').Replace('../../docs/downloads.md', 'https://github.com/GeorgeFejer91/undertree/releases')
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'README.md'), $packagedReadme)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD-PARTY.md') -Destination $OutputDirectory -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'packaging/zrok-LICENSE') -Destination $OutputDirectory -Force
Copy-Item -LiteralPath (Join-Path $branding 'icon.ico') -Destination (Join-Path $OutputDirectory 'wrAIter.ico') -Force
$payloadFiles = @('wrAIter.Word.dll','README.md','THIRD-PARTY.md','zrok-LICENSE','wrAIter.ico')
if (Test-Path -LiteralPath (Join-Path $runtime 'zrok.exe')) { $payloadFiles += 'runtime/zrok.exe' }
Assert-SourceSnapshot
$manifest = [ordered]@{ product='wrAIter for Word';version='0.1.0';platform='Windows desktop Word';
    inputs=$sourceSnapshot;
    files=@($payloadFiles | ForEach-Object { $payload=Get-Item -LiteralPath (Join-Path $OutputDirectory $_); [ordered]@{path=$_;bytes=$payload.Length;sha256=(Get-FileHash -LiteralPath $payload.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} }) }
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'build-manifest.json') -Encoding utf8
if ($Installer) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime 'zrok.exe'))) { throw 'A release installer must contain its tunnel executable.' }
    $nsis = Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
    if (-not (Test-Path -LiteralPath $nsis)) { throw 'NSIS is required to build the installer.' }
    $setup = Join-Path (Split-Path $OutputDirectory -Parent) 'wrAIter-Word_0.1.0_windows-setup.exe'
    & $nsis '/V2' "/DPAYLOAD=$OutputDirectory" "/DOUTPUT=$setup" (Join-Path $PSScriptRoot 'packaging/installer.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'Word installer build failed.' }
    Assert-SourceSnapshot
    Get-Item -LiteralPath $setup | Select-Object FullName,Length
    Get-FileHash -LiteralPath $setup -Algorithm SHA256
}
Write-Output "Built $assembly"
