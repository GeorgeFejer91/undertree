$ErrorActionPreference = 'Stop'
$word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
$addin = $word.COMAddIns.Item('UnderTree.WordAddin')
[pscustomobject]@{WordVersion=$word.Version;WordBuild=$word.Build;Connected=$addin.Connect;Description=$addin.Description;Documents=$word.Documents.Count} | ConvertTo-Json -Compress
if (-not $addin.Connect) { $addin.Connect = $true }
$api = $addin.Object
if ($null -eq $api) { throw 'Word did not expose the installed native add-in.' }
$api.Execute('state','{}')
