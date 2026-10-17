param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core') {
    & "$env:WINDIR/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -File $PSCommandPath -OutputDirectory $OutputDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Installed Word qualification did not pass.' }
    return
}
if (-not $OutputDirectory) { $OutputDirectory = Join-Path (Resolve-Path "$PSScriptRoot/../../..") ('artifacts/word/native-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Choose a new evidence directory to preserve previous Word checks.' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
Add-Type -ReferencedAssemblies 'Microsoft.CSharp','System.Core' -Path (Join-Path $PSScriptRoot 'WordAutomation.cs')
$automation = New-Object WordTestAutomation
$checks = New-Object Collections.Generic.List[string]
$fixture = $null
$api = $null
$address = $null
$rpcId = 0
function Check($condition, [string]$message) { if (-not $condition) { throw $message }; $checks.Add($message); Write-Host ("PASS: " + $message) }
function DocumentHash([string]$path) {
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)) }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Local([string]$operation, $arguments = @{}) {
    $reply = $api.Execute($operation, (ConvertTo-Json -InputObject $arguments -Depth 20 -Compress)) | ConvertFrom-Json
    if (-not $reply.ok) { throw $reply.error }
    return $reply.result
}
function Rpc([string]$method, $arguments) {
    $script:rpcId++
    $request = [Net.HttpWebRequest]::Create($address)
    $request.Method = 'POST'; $request.ContentType = 'application/json'; $request.Accept = 'application/json, text/event-stream'
    $request.Timeout = 20000; $request.ReadWriteTimeout = 20000; $request.KeepAlive = $false
    $body = @{jsonrpc='2.0';id=$script:rpcId;method=$method;params=$arguments} | ConvertTo-Json -Depth 20 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($body); $request.ContentLength = $bytes.Length
    $stream = $request.GetRequestStream(); $stream.Write($bytes,0,$bytes.Length); $stream.Dispose()
    $response = $request.GetResponse()
    try { $reader = New-Object IO.StreamReader($response.GetResponseStream()); $json = $reader.ReadToEnd() | ConvertFrom-Json }
    finally { $response.Dispose() }
    if ($json.error) { throw $json.error.message }
    return $json.result
}
function Tool([string]$name, $arguments = @{}, [switch]$Denied) {
    $reply = Rpc 'tools/call' @{name=$name;arguments=$arguments}
    if ($Denied) { Check ($reply.isError -eq $true) "$name denied without a document mutation"; return }
    if ($reply.isError) { throw $reply.content[0].text }
    return ($reply.content[0].text | ConvertFrom-Json)
}
function Mark([string]$quote, [string]$rule) {
    $text = [WordTestAutomation]::Read($fixture); $from = $text.IndexOf($quote, [StringComparison]::Ordinal)
    if ($from -lt 0) { throw 'Qualification passage is missing.' }
    $fixture.Range($from, $from+$quote.Length).Select()
    $proof = Local 'selection_preview'
    Local 'mark_selection' @{ruleId=$rule;prompt='Preserve the meaning.';quote=$proof.quote;from=$proof.from;to=$proof.to;snapshot=$proof.snapshot} | Out-Null
}
function ReadContext {
    $chunks = New-Object Text.StringBuilder; $offset = 0
    do {
        $page = Tool 'read_manuscript' @{manuscript_id=$documentId;offset=$offset}
        [void]$chunks.Append($page.text); $offset=$page.to
    } while (-not $page.complete)
    $completeText = $chunks.ToString()
    return @{text=$completeText;main_text=$completeText.Substring(0,$page.main_body_length);revision=$page.revision;context_id=$page.context_id}
}
try {
    $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
    $addin = $word.COMAddIns.Item('UnderTree.WordAddin')
    Check $addin.Connect 'Word loaded the installed native add-in'
    $api = $addin.Object; Check ($null -ne $api) 'Word exposed the local add-in interface'
    $fixture = $word.Documents.Add()
    $emoji = [char]::ConvertFromUtf32(0x1F600)
    $fixture.Content.Text = "Unmarked introduction stays unchanged.`rAlpha $emoji beta gamma.`rDirect passage wording.`rProtected passage stays unchanged.`rFootnote context anchor.`r"
    $fixture.Content.Font.Name = 'Segoe UI Emoji'
    $fixture.Content.Font.NameBi = 'Segoe UI Emoji'
    $fixture.Sections.Item(1).Headers.Item(1).Range.Text = 'Read-only header context.'
    [void]$fixture.Footnotes.Add($fixture.Range($fixture.Content.End-2,$fixture.Content.End-2),[Type]::Missing,'Read-only footnote context.')
    $body = [WordTestAutomation]::Read($fixture)
    $formatFrom = $body.IndexOf('Alpha',[StringComparison]::Ordinal)
    $fixture.Range($formatFrom,$formatFrom + ("Alpha $emoji beta gamma.").Length).Font.Italic = -1
    $path = Join-Path $OutputDirectory 'Word-qualification.docx'
    $fixture.SaveAs2([ref][object]$path,[ref][object]16)
    $diskBefore = DocumentHash $path
    Mark "Alpha $emoji beta gamma." 'snappier'
    Mark 'Protected passage stays unchanged.' 'protect'
    $state = Local 'state'; $documentId = $state.document.id
    $connection = Local 'connection_status'; $startedConnection = -not $connection.running
    if ($startedConnection) { $connection = Local 'connection_local' }
    $address=$connection.localMcpUrl
    $initialized = Rpc 'initialize' @{protocolVersion='2025-03-26';capabilities=@{};clientInfo=@{name='Word qualification';version='1'}}
    Check ($initialized.protocolVersion -eq '2025-03-26') 'The real Word MCP endpoint initialized'
    $catalogue = Rpc 'tools/list' @{}
    Check (($catalogue.tools.name -join ',') -eq 'list_manuscripts,read_manuscript,suggest_text,highlight_text') 'Only the four native Review tools are exposed'
    $preview = Local 'context_preview'; Local 'share_context' @{snapshot=$preview.snapshot;documentId=$documentId} | Out-Null
    $before = [WordTestAutomation]::Read($fixture); $quote="Alpha $emoji beta gamma."; $replacement="Alpha $emoji clear beta gamma."
    $from=$before.IndexOf($quote,[StringComparison]::Ordinal)
    $request=@{manuscript_id=$documentId;revision=$preview.snapshot;context_id='forged';from=$from;to=$from+$quote.Length;quote=$quote;replacement=$replacement;request_id='no_prior_read'}
    Tool 'suggest_text' $request -Denied
    Check ([WordTestAutomation]::Read($fixture) -eq $before) 'A proposal without complete context left Word text unchanged'
    $context = ReadContext
    Check ($context.text.Contains('Read-only header context.') -and $context.text.Contains('Read-only footnote context.')) 'Complete context included header and footnote stories'
    $request.revision=$context.revision; $request.context_id=$context.context_id; $request.request_id='pending_example'
    $pending = Tool 'suggest_text' $request
    Check ($pending.status -eq 'tracked' -and $fixture.Revisions.Count -gt 0) 'Suggestion mode created native Word paragraph revisions'
    Check ($fixture.TrackRevisions) 'Suggestion mode enabled Word Track Changes'
    $proposedContext=ReadContext
    Check ($proposedContext.main_text -eq $before.Substring(0,$from)+$replacement+$before.Substring($from+$quote.Length)) 'Tracked context exposes proposed wording and unchanged surrounding text'
    [void]$fixture.Comments.Add($fixture.Paragraphs.Item(2).Range, 'Keep gamma and explain the reason without inventing facts.')
    $feedbackContext=ReadContext
    Check ($feedbackContext.text.Contains('explain the reason without inventing facts')) 'Complete MCP context includes native comment feedback'
    Check ($feedbackContext.revision -ne $proposedContext.revision) 'Adding native feedback invalidated the earlier context revision'
    $staleFeedback=@{} + $request
    $staleFeedback.request_id='stale_feedback'
    $staleFeedback.revision=$proposedContext.revision
    $staleFeedback.context_id=$proposedContext.context_id
    $staleFeedback.quote=$replacement
    $staleFeedback.to=$from+$replacement.Length
    $staleFeedback.replacement="Alpha $emoji grounded beta gamma."
    Tool 'suggest_text' $staleFeedback -Denied
    $fixture.Comments.Item(1).Delete()
    Check ((DocumentHash $path) -eq $diskBefore) 'Remote suggestions did not save the document'
    $fixture.Revisions.RejectAll()
    Check ([WordTestAutomation]::Read($fixture) -eq $before -and $fixture.Revisions.Count -eq 0) 'Word native rejection restored the original paragraph'
    Check ((Local 'state').proposals.Count -eq 0) 'Native review did not create a separate pending list'
    Mark $quote 'snappier'
    $context=ReadContext; $request.revision=$context.revision; $request.context_id=$context.context_id; $request.request_id='accepted_example'
    $pending=Tool 'suggest_text' $request
    $fixture.Revisions.AcceptAll()
    $expected=$before.Substring(0,$from)+$replacement+$before.Substring($from+$quote.Length)
    Check ([WordTestAutomation]::Read($fixture) -eq $expected -and $fixture.Revisions.Count -eq 0) 'Word native acceptance changed exactly the proposed paragraph'
    Check (-not $fixture.Saved) 'Accepted edits left Word unsaved'
    Check ([WordTestAutomation]::Italic($fixture,$from,$from+$replacement.Length) -eq -1) 'Native acceptance preserved italic formatting'
    Local 'save_rule' @{id='direct';label='Direct wording';color='#AACCEE';action='prompt';prompt='Improve clarity.';accessMode='direct';documentId=$documentId} | Out-Null
    Mark 'Direct passage wording.' 'direct'
    $context = ReadContext; $before=[WordTestAutomation]::Read($fixture); $from=$before.IndexOf('Direct passage wording.',[StringComparison]::Ordinal)
    $request=@{manuscript_id=$documentId;revision=$context.revision;context_id=$context.context_id;from=$from;to=$from+23;quote='Direct passage wording.';replacement='Clear direct wording.';request_id='direct_example'}
    $directRequest=@{} + $request
    $api.ShowEditor()
    $direct = Tool 'suggest_text' $request
    Check ($direct.status -eq 'applied') 'Explicitly authorized direct wording applied through native Word'
    $after=[WordTestAutomation]::Read($fixture)
    Check ($after -eq $before.Substring(0,$from)+'Clear direct wording.'+$before.Substring($from+23)) 'Direct editing preserved all text outside the highlight'
    $replay = Tool 'suggest_text' $request
    Check ($replay.status -eq 'applied' -and [WordTestAutomation]::Read($fixture) -eq $after) 'Replaying a direct request did not apply it twice'
    $context=ReadContext; $request.request_id='outside';$request.revision=$context.revision;$request.context_id=$context.context_id;$request.from=0;$request.to=8;$request.quote='Unmarked';$request.replacement='Changed'
    Tool 'suggest_text' $request -Denied
    Check ([WordTestAutomation]::Read($fixture) -eq $after) 'Unmarked text stayed unchanged'
    $from=$after.IndexOf('Protected passage stays unchanged.',[StringComparison]::Ordinal)
    $request.request_id='protected';$request.from=$from;$request.quote='Protected passage stays unchanged.';$request.to=$from+$request.quote.Length;$request.replacement='Changed'
    Tool 'suggest_text' $request -Denied
    Check ([WordTestAutomation]::Read($fixture) -eq $after) 'Protected text and surrounding manuscript stayed unchanged'
    Check ([bool]$fixture.Undo([ref][object]1)) 'Word accepted a single native Undo for the direct edit'
    Check ([WordTestAutomation]::Read($fixture) -eq $before) 'One native Undo restored exactly the text before the direct edit'
    $directRequest.request_id='undo_stale_example'
    Tool 'suggest_text' $directRequest -Denied
    Check ([WordTestAutomation]::Read($fixture) -eq $before) 'A stale request after Undo could not reapply the edit'
    Check ([bool]$fixture.Redo([ref][object]1)) 'Word accepted a single native Redo for the direct edit'
    Check ([WordTestAutomation]::Read($fixture) -eq $after) 'One native Redo restored exactly the authorized direct edit'
    Local 'revoke_context' @{documentId=$documentId} | Out-Null
    $listed=Tool 'list_manuscripts'; Check ($listed.manuscripts.Count -eq 0) 'Revocation removed the document from remote discovery'
    Check ((DocumentHash $path) -eq $diskBefore) 'No AI or approval operation implicitly saved Word'
    $fixture.Save()
    if ($startedConnection) { Local 'connection_stop' | Out-Null }
    $fixture.Close(0);$fixture=$null
    $fixture=$word.Documents.Open($path)
    $reopened=Local 'state'
    Check (-not $reopened.document.shared) 'Reopening a saved document did not restore sharing'
    Check ($reopened.rules.Count -ge 5 -and $reopened.marks.Count -ge 3) 'Rules and passage markers survived DOCX save and reopen'
    $hiddenBefore=$fixture.Bookmarks.ShowHidden
    [void]$fixture.Bookmarks.Add('_WraiHiddenProbe',$fixture.Range(0,8))
    $fixture.Range(0,8).Select()
    $denial=''
    try { Local 'selection_preview' | Out-Null } catch { $denial=$_.Exception.Message }
    Check ($denial -like '*bookmark or cross-reference target*') 'A hidden native bookmark prevented passage marking'
    Check ($fixture.Bookmarks.ShowHidden -eq $hiddenBefore) 'Bookmark validation preserved the native visibility setting'
    $fixture.Bookmarks.Item('_WraiHiddenProbe').Delete()
    $fixture.Save()
    $api.ShowEditor()
    [ordered]@{status='PASS';checks=$checks;document=$path;wordVersion=$word.Version;wordBuild=$word.Build;publicTunnel='NOT RUN'} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'result.json') -Encoding utf8
    Write-Output "PASS: $($checks.Count) installed Word checks. Synthetic document left open: $path"
}
catch {
    [ordered]@{status='FAIL';checks=$checks;error=$_.Exception.Message;publicTunnel='NOT RUN'} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'result.json') -Encoding utf8
    throw
}
finally {
    if ($startedConnection -and $api) {
        try { if ((Local 'connection_status').running) { Local 'connection_stop' | Out-Null } } catch { }
    }
    $automation.Dispose()
}


