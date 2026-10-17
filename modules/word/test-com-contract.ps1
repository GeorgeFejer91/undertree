param([string]$AssemblyPath, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $AssemblyPath) { $AssemblyPath = Join-Path $repo 'artifacts/word/build/wrAIter.Word.dll' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'artifacts/word/com-contract-tests' }
$AssemblyPath = (Resolve-Path -LiteralPath $AssemblyPath).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$source = Join-Path $PSScriptRoot 'tests/ComContractTests.cs'
$references = @('/r:System.dll','/r:System.Core.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll')
$identity = (Get-FileHash -LiteralPath $AssemblyPath -Algorithm SHA256).Hash.ToLowerInvariant()
$actualDirectory = Join-Path $OutputDirectory 'actual'
$mutantDirectory = Join-Path $OutputDirectory 'mutant-dispatch-only'
New-Item -ItemType Directory -Force -Path $actualDirectory,$mutantDirectory | Out-Null
$testedAssembly = Join-Path $actualDirectory 'wrAIter.Word.dll'
Copy-Item -LiteralPath $AssemblyPath -Destination $testedAssembly -Force
if ((Get-FileHash -LiteralPath $testedAssembly -Algorithm SHA256).Hash.ToLowerInvariant() -ne $identity) { throw 'The copied add-in bytes changed before the test.' }
$test = Join-Path $actualDirectory 'ComContractTests.exe'
& $compiler /nologo /target:exe /platform:anycpu /langversion:5 "/out:$test" "/r:$testedAssembly" $source
if ($LASTEXITCODE -ne 0) { throw 'COM contract tests did not compile.' }
& $test $identity 2>&1 | Tee-Object -FilePath (Join-Path $actualDirectory 'result.txt')
if ($LASTEXITCODE -ne 0) { throw 'The actual built add-in failed its native COM contract.' }

# The real interface prefix supplies the mutant; no wrong native vtable is invoked.
$comSource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'src/ComAddin.cs')
$classStart = $comSource.IndexOf('    [ComVisible(true), Guid("12E46C89-0A1D-4E2E-AECB-2C51D78F1907")', [StringComparison]::Ordinal)
if ($classStart -lt 0) { throw 'Could not isolate the production COM interface declarations for the mutation check.' }
$prefix = $comSource.Substring(0,$classStart) + "`n}`n"
$declaration = [regex]::new('(Guid\("B65AD801-ABAF-11D0-BB8B-00A0C90F2744"\).*?InterfaceType\(ComInterfaceType\.)InterfaceIsDual', [Text.RegularExpressions.RegexOptions]::Singleline)
if ($declaration.Matches($prefix).Count -ne 1) { throw 'The production lifecycle declaration is not the expected canonical dual interface.' }
$mutatedSource = $declaration.Replace($prefix, '${1}InterfaceIsIDispatch', 1)
$mutantSource = Join-Path $mutantDirectory 'DispatchOnlyInterfaces.cs'
[IO.File]::WriteAllText($mutantSource,$mutatedSource,[Text.UTF8Encoding]::new($false))
$mutantAssembly = Join-Path $mutantDirectory 'wrAIter.Word.dll'
& $compiler /nologo /target:library /platform:anycpu /langversion:5 "/out:$mutantAssembly" @references $mutantSource
if ($LASTEXITCODE -ne 0) { throw 'The deliberate dispatch-only mutant did not compile.' }
$mutantTest = Join-Path $mutantDirectory 'ComContractTests.exe'
& $compiler /nologo /target:exe /platform:anycpu /langversion:5 "/out:$mutantTest" "/r:$mutantAssembly" $source
if ($LASTEXITCODE -ne 0) { throw 'COM contract tests did not compile against the dispatch-only mutant.' }
$mutantOutput = @(& $mutantTest 2>&1)
$mutantExit = $LASTEXITCODE
$mutantOutput | Tee-Object -FilePath (Join-Path $mutantDirectory 'result.txt')
if ($mutantExit -ne 1 -or ($mutantOutput -join "`n") -notmatch 'IOfficeLifecycle must be a dual interface before any native vtable invocation' -or
    ($mutantOutput -join "`n") -match 'Beginning safe native ABI callbacks') {
    throw 'The deliberate dispatch-only regression was not refused safely before native invocation.'
}
[ordered]@{assembly=$AssemblyPath;sha256=$identity;actual='passed';dispatchOnlyMutant='refused before native invocation'} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'result.json') -Encoding utf8
Write-Output "PASS: exact add-in COM ABI and safe dispatch-only regression check ($identity)."
