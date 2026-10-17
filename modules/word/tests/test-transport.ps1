param(
    [string]$OutputDirectory,
    [switch]$MutationCheck
)
$ErrorActionPreference = 'Stop'
$wordRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $wordRepository ('artifacts\word-transport-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$wordOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $wordOutput) { throw 'Use a new output directory to preserve earlier transport evidence.' }
New-Item -ItemType Directory -Path $wordOutput | Out-Null
$wordCompiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $wordCompiler)) {
    $wordCompiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
$wordCommon = @('/nologo', '/target:exe', '/langversion:5', '/r:System.Web.Extensions.dll', '/r:System.Core.dll', '/r:System.Security.dll')
$wordSources = @('ConnectionService.cs', 'ConnectionProfile.cs', 'McpEndpoint.cs', 'TunnelProcess.cs', 'TunnelSupervisor.cs') |
    ForEach-Object { Join-Path $wordRepository "modules\word\src\$_" }
$wordFake = Join-Path $wordOutput 'FakeZrok.exe'
$wordTest = Join-Path $wordOutput 'TransportTests.exe'
& $wordCompiler @wordCommon "/out:$wordFake" (Join-Path $PSScriptRoot 'FakeZrok.cs') *> (Join-Path $wordOutput 'compile-fake.log')
if ($LASTEXITCODE -ne 0) { throw "Fake runtime compilation failed; see $wordOutput\compile-fake.log" }
& $wordCompiler @wordCommon "/out:$wordTest" @wordSources (Join-Path $PSScriptRoot 'TransportTests.cs') *> (Join-Path $wordOutput 'compile-tests.log')
if ($LASTEXITCODE -ne 0) { throw "Transport compilation failed; see $wordOutput\compile-tests.log" }
& $wordTest (Join-Path $wordOutput 'profiles') $wordFake 2>&1 | Tee-Object -FilePath (Join-Path $wordOutput 'transport.log')
if ($LASTEXITCODE -ne 0) { throw "Transport tests failed; see $wordOutput\transport.log" }

if ($MutationCheck) {
    $wordMutation = Join-Path $wordOutput 'mutation'
    New-Item -ItemType Directory -Path $wordMutation | Out-Null
    $wordMutatedSource = Join-Path $wordMutation 'McpEndpoint.cs'
    $wordOriginal = [IO.File]::ReadAllText((Join-Path $wordRepository 'modules\word\src\McpEndpoint.cs'))
    $wordNeedle = 'headers.TryGetValue("Origin", out origin) ||'
    if (-not $wordOriginal.Contains($wordNeedle)) { throw 'Origin validation mutation no longer matches production; review the mutation.' }
    [IO.File]::WriteAllText($wordMutatedSource, $wordOriginal.Replace($wordNeedle, '(headers.TryGetValue("Origin", out origin) && false) ||'))
    $wordMutationSources = $wordSources | Where-Object { [IO.Path]::GetFileName($_) -ne 'McpEndpoint.cs' }
    $wordMutationTest = Join-Path $wordMutation 'TransportTests.exe'
    & $wordCompiler @wordCommon "/out:$wordMutationTest" @wordMutationSources $wordMutatedSource (Join-Path $PSScriptRoot 'TransportTests.cs') *> (Join-Path $wordMutation 'compile.log')
    if ($LASTEXITCODE -ne 0) { throw 'The transport mutation did not compile.' }
    & $wordMutationTest (Join-Path $wordMutation 'profiles') $wordFake *> (Join-Path $wordMutation 'transport.log')
    if ($LASTEXITCODE -eq 0 -or -not ([IO.File]::ReadAllText((Join-Path $wordMutation 'transport.log')).Contains('Browser Origin denied.'))) {
        throw 'The transport suite did not reject the intended Origin security mutation.'
    }
    Write-Output 'PASS: test suite rejects disabled Origin security control.'
}
Write-Output "Transport evidence: $wordOutput"
