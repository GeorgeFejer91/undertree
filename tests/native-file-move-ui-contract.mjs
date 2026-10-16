// Preparation only: a new helper for the existing disposable native-ui window.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const from = 'z-ui-source.typ', to = 'moves/z-ui-moved.typ';
const members = ['', '.undertree-review.json', '.import-report.json'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function seedNativeFileMoveUi(project) {
  const source = Buffer.from('= Native dialog source\r\n\r\nCafé, Ελληνικά and 😀 stay byte exact.\r\n');
  const review = Buffer.from(JSON.stringify({version:1, revision:hash(source), rules:[{id:'protect',label:'Keep unchanged',color:'#74b9a4',action:'protect',prompt:''}],markers:[],suggestions:[]}) + '\n');
  for (const [index, suffix] of members.entries()) {
    await writeFile(join(project, from + suffix), [source, review, Buffer.from([255, 0, 10, 13, 128])][index]);
    await chmod(join(project, from + suffix), 0o640);
  }
}

export async function qualifyNativeFileMoveUi({execute, command, click, waitFor, native, nativeWindow, project, state, projectId, compilerCalls, evidence, checks}) {
  const editor = () => execute('return {text:document.querySelector(".cm-content").textContent,label:document.getElementById("save-label").textContent,probe:{saved:window.__cliProbe.saved,committed:window.__cliProbe.committed,fallback:window.__cliProbe.fallback,errors:[...window.__cliProbe.errors]}};');
  const group = path => Promise.all(members.map(async suffix => {
    const file = join(project, path + suffix), bytes = await readFile(file), info = await stat(file);
    return {bytes:bytes.length,sha256:hash(bytes),mode:info.mode & 0o777};
  }));
  const absent = path => assert.rejects(stat(path), error => error.code === 'ENOENT');
  const registry = () => readFile(join(state, 'projects.json')).then(bytes => JSON.parse(bytes));
  const beforeEditor = await editor(), expected = await group(from), registryBefore = await registry();
  assert.equal(beforeEditor.label, 'Saved locally');
  assert.equal(beforeEditor.probe.fallback, false); assert.deepEqual(beforeEditor.probe.errors, []);
  const mainBefore = hash(await readFile(join(project, 'main.typ')));
  const policyBefore = hash(await readFile(join(project, 'main.typ.undertree-review.json')));
  const compilerBefore = hash(await readFile(compilerCalls));
  const unchanged = async () => {
    assert.deepEqual(await group(from), expected);
    assert.equal(hash(await readFile(join(project, 'main.typ'))), mainBefore);
    assert.equal(hash(await readFile(join(project, 'main.typ.undertree-review.json'))), policyBefore);
    assert.equal(hash(await readFile(compilerCalls)), compilerBefore);
    assert.deepEqual(await editor(), beforeEditor);
    for (const suffix of members) await absent(join(project, to + suffix));
  };

  // The genuine native fetch runs unchanged. Only command/action names are retained.
  await execute(`
    window.__nativeMoveUiDispatch=[]; window.__nativeMoveUiOriginalFetch=window.fetch;
    window.fetch=function(input,init,...rest) {
      const url=new URL(typeof input==='string'?input:input.url);
      if(url.protocol==='ipc:'||url.hostname==='ipc.localhost') {
        if(window.__nativeMoveUiDispatch.length>=512)throw Error('Native Move UI dispatch observation exceeded its bound.');
        const body=JSON.parse(typeof init?.body==='string'?init.body:new TextDecoder().decode(init.body));
        window.__nativeMoveUiDispatch.push({name:decodeURIComponent(url.pathname.slice(1)),action:body.operation?.action});
      }
      return Reflect.apply(window.__nativeMoveUiOriginalFetch,this,[input,init,...rest]);
    };
  `);
  try {
    const menu = await execute('return document.querySelector("#workspace-menu > summary").getClientRects().length ? "#workspace-menu" : "#menu-file";');
    await click(menu + ' [data-command="move-source"]');
    await waitFor(() => execute('return document.getElementById("file-move-dialog").open;'), 'The actual native Move dialog did not open.');
    await click('#file-move-list');
    await waitFor(() => execute('return !document.getElementById("file-move-source").disabled && document.getElementById("file-move-dialog").getAttribute("aria-busy") === "false";'), 'The native UI did not observe the retired generation and become ready.');
    const selected = await execute(`
      const select=document.getElementById('file-move-source');
      if(![...select.options].some(option=>option.value===arguments[0])) return false;
      select.value=arguments[0]; select.dispatchEvent(new Event('change',{bubbles:true})); return select.value===arguments[0];
    `, [from]);
    assert.equal(selected, true, 'The actual file-tree source option feeds the production change callback.');
    await click('#file-move-destination');
    native('xdotool', ['windowactivate', '--sync', nativeWindow, 'key', '--clearmodifiers', 'ctrl+a']);
    native('xdotool', ['type', '--clearmodifiers', '--delay', '4', to]);
    assert.equal(await execute('return document.getElementById("file-move-destination").value;'), to, 'Real native keys enter the destination path.');
    await unchanged();

    await click('#file-move-prepare');
    await waitFor(() => execute('const button=document.getElementById("file-move-commit");return !button.hidden && !button.disabled && document.getElementById("file-move-identity").textContent.startsWith("Generation 1 · request ");'), 'The actual native dialog did not prepare its retained generation-1 request.');
    await unchanged();
    assert.equal(await execute('return document.getElementById("file-move-dialog").contains(document.activeElement) && document.activeElement!==document.getElementById("file-move-prepare");'), true, 'Preparing preserves useful focus after its button disappears.');
    const layouts = await qualifyMoveDialogGeometry({execute,command,click,waitFor,evidence});
    const identity = await execute('return document.getElementById("file-move-identity").textContent;');
    await click('#file-move-close');
    assert.equal(await execute('return document.getElementById("file-move-dialog").open;'), false);
    await unchanged();
    await click(menu + ' [data-command="move-source"]');
    await waitFor(() => execute('return document.getElementById("file-move-dialog").open && !document.getElementById("file-move-commit").disabled;'), 'Closing and reopening lost the prepared native request.');
    assert.equal(await execute('return document.getElementById("file-move-identity").textContent;'), identity);
    await unchanged();

    await click('#file-move-commit');
    await waitFor(async () => {
      await stat(join(project, to));
      return execute('return document.getElementById("file-move-dialog").getAttribute("aria-busy")==="false" && document.getElementById("file-move-status").textContent.includes("This receipt records a completed Move.");');
    }, 'The actual native UI did not complete the explicit Move.');
    assert.deepEqual(await group(to), expected);
    for (const suffix of members) await absent(join(project, from + suffix));
    const afterRegistry = await registry(), epochs = afterRegistry.sourceEpochs[projectId];
    assert.equal(epochs[from], 1); assert.equal(epochs[to], 1);
    assert.equal(afterRegistry.projects.find(p=>p.id===projectId).mainDocument, registryBefore.projects.find(p=>p.id===projectId).mainDocument);
    await click('#file-move-close');
    await waitFor(() => execute('return !!document.querySelector(arguments[0]) && !document.querySelector(arguments[1]);', [`.file-button[data-path="${to}"]`, `.file-button[data-path="${from}"]`]), 'The native Move did not refresh the real tree without opening a source.');
    assert.equal(hash(await readFile(join(project, 'main.typ'))), mainBefore);
    assert.equal(hash(await readFile(join(project, 'main.typ.undertree-review.json'))), policyBefore);
    assert.equal(hash(await readFile(compilerCalls)), compilerBefore);
    assert.deepEqual(await editor(), beforeEditor);
    const dispatch = await execute('return window.__nativeMoveUiDispatch;');
    assert.equal(dispatch.filter(row=>row.name==='prepare_file_move').length, 1);
    assert.equal(dispatch.filter(row=>row.name==='file_move_operation' && row.action==='move_commit').length, 1);
    assert.equal(dispatch.some(row=>row.name==='file_move_operation' && ['move_cancel','move_reconcile','move_retire_terminal'].includes(row.action)), false);
    assert.equal(dispatch.some(row=>row.name==='review_action' && ['open','save','compile','set_main_document','share','sync','accept','palette'].includes(row.action)), false);
    assert.equal(dispatch.some(row=>row.name==='editor_operation' && row.action==='editor_commit'), false);
    evidence.nativeFileMoveUi={result:'passed',generation:'1',members:expected,realButtons:true,realDestinationKeys:true,sourceOptionChange:'actual DOM change callback',preparedCloseReopen:true,layouts,sourceAndDestinationEpoch:1,treeRefreshedWithoutOpen:true,unrelatedEditorAndSaveCompilerCountersPreserved:true,dispatch};
    checks.push('The real native Move dialog selects a closed source, accepts destination key input, prepares without moving, retains its request across Close/reopen, then explicitly moves its exact metadata group and refreshes the tree without opening, saving or compiling any source.');
  } finally {
    await execute('window.fetch=window.__nativeMoveUiOriginalFetch;delete window.__nativeMoveUiOriginalFetch;');
  }
}


async function qualifyMoveDialogGeometry({execute, command, click, waitFor, evidence}) {
  const previousFont = await execute('return document.documentElement.style.fontSize;');
  const previousRect = await command('/window/rect',undefined,'GET');
  await execute('document.documentElement.style.fontSize="28px";');
  try {
    const layouts = evidence.nativeFileMoveUiLayouts = [];
    for (const maintenance of [false, true]) {
      if (maintenance) await click('#file-move-maintenance > summary');
      for (const [width,height] of [[320,480],[1100,480],[320,900],[1100,480]]) {
        await command('/window/rect',{width,height});
        await execute('return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))));');
        const value = await waitFor(async () => {
          const value = await execute(`
            const dialog=document.getElementById('file-move-dialog'), body=dialog.querySelector('.file-move-body');
            const title=dialog.querySelector('h2'), footer=dialog.querySelector(':scope > .dialog-actions');
            const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
            const visible=node=>{
              for(let parent=node;parent&&parent!==dialog;parent=parent.parentElement){
                const style=getComputedStyle(parent);
                if(parent.hidden||style.display==='none'||style.visibility==='hidden')return false;
                if(parent.tagName==='DETAILS'&&!parent.open){const summary=parent.querySelector(':scope > summary');if(!summary?.contains(node))return false;}
              }
              const r=rect(node);return r.width>0&&r.height>0;
            };
            const measured=[...dialog.querySelectorAll('[data-measure]')].filter(visible).map(node=>({
              id:node.id,tag:node.tagName,fit:node.dataset.textFit,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,
              fontSize:parseFloat(getComputedStyle(node).fontSize),rootFont:parseFloat(getComputedStyle(document.documentElement).fontSize)
            }));
            return {rootFont:parseFloat(getComputedStyle(document.documentElement).fontSize),viewport:{width:innerWidth,height:innerHeight},dialog:rect(dialog),title:rect(title),body:rect(body),footer:rect(footer),
              dialogClientHeight:dialog.clientHeight,dialogScrollHeight:dialog.scrollHeight,bodyClientWidth:body.clientWidth,bodyScrollWidth:body.scrollWidth,
              maintenanceOpen:document.getElementById('file-move-maintenance').open,measured};
          `);
          evidence.nativeFileMoveUiLayoutPending={requested:{width,height,maintenance},...value};
        return value.measured.length && value.measured.every(node=>node.fit && !['deferred','no-fit'].includes(node.fit)) ? value : false;
        },'Visible native Move text did not receive a fitted Pretext measurement.');
        layouts.push({width,height,maintenance,...value});
      delete evidence.nativeFileMoveUiLayoutPending;
        assert.equal(value.rootFont,28,'Native Move geometry uses actual200% root text.');
        assert.equal(value.viewport.width,width); assert.equal(value.maintenanceOpen,maintenance);
        assert.ok(value.dialog.left>=-1&&value.dialog.right<=value.viewport.width+1&&value.dialog.top>=-1&&value.dialog.bottom<=value.viewport.height+1);
        assert.ok(value.body.width>0&&value.body.height>0,'Native Move retains a positive scrollable body.');
        assert.ok(value.title.bottom<=value.body.top+1&&value.body.bottom<=value.footer.top+1,'Native Move title/body/Close stay in their allocated rows.');
        assert.ok(value.title.top>=value.dialog.top&&value.footer.bottom<=value.dialog.bottom);
        assert.ok(value.dialogScrollHeight<=value.dialogClientHeight+1,'The dialog itself does not scroll.');
        assert.ok(value.bodyScrollWidth<=value.bodyClientWidth+1,'Native Move body has no horizontal overflow.');
        assert.ok(value.measured.every(node=>node.scrollWidth<=node.clientWidth+1&&node.fontSize>=node.rootFont-.5),'Measured native labels retain full user text scale without horizontal overflow.');
      }
      if (maintenance) await click('#file-move-maintenance > summary');
    }
    return layouts;
  } finally {
    await execute('document.documentElement.style.fontSize=arguments[0];',[previousFont]);
    await command('/window/rect',previousRect);
  }
}
