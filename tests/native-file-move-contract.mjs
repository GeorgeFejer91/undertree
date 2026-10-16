// Runs inside the existing disposable native-ui fixture; it starts no process.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const from = 'z-move.typ', to = 'moves/z-moved.typ';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const members = ['', '.undertree-review.json', '.import-report.json'];

export async function seedNativeFileMove(project) {
  const source = Buffer.from('= Closed source\r\n\r\nCafé and 😀 stay byte exact.\r\n');
  const review = Buffer.from(JSON.stringify({version:1, revision:hash(source), rules:[{id:'protect',label:'Keep unchanged',color:'#74b9a4',action:'protect',prompt:''}],markers:[],suggestions:[]}) + '\n');
  const report = Buffer.from([255, 0, 123, 13, 10]);
  await mkdir(join(project, 'moves'));
  await writeFile(join(project, 'zz-collision.typ'), 'Existing collision stays unchanged.\n');
  for (const [index, suffix] of members.entries()) {
    const path = join(project, from + suffix);
    await writeFile(path, [source, review, report][index]);
    await chmod(path, 0o640);
  }
}

export async function qualifyNativeFileMove({execute, click, waitFor, project, state, projectId, compilerCalls, evidence, checks}) {
  // The preceding denied build retains an old PDF; the explicit CLI save does not schedule a rebuild.
  await click('#typst-compile');
  await waitFor(() => execute('return document.getElementById("typst-compile").textContent === "Recompile" && document.getElementById("typst-preview-status").dataset.state === "current";'), 'The current native PDF must settle before the closed-source Move contract.');
  const pdfMetadata = JSON.parse(await readFile(join(state, 'pdfs', `${hash(projectId + ':main.typ')}.json`), 'utf8'));
  assert.equal(pdfMetadata.revision, hash(await readFile(join(project, 'main.typ'))), 'Move setup uses the actual newly saved main PDF.');
  const beforeEditor = await execute('return {text:document.querySelector(".cm-content").textContent,label:document.getElementById("save-label").textContent,probe:{saved:window.__cliProbe.saved,committed:window.__cliProbe.committed,fallback:window.__cliProbe.fallback,errors:[...window.__cliProbe.errors]}};');
  assert.equal(beforeEditor.label, 'Saved locally');
  assert.equal(beforeEditor.probe.fallback, false); assert.deepEqual(beforeEditor.probe.errors, []);
  const mainBefore = hash(await readFile(join(project, 'main.typ')));
  const mainPolicyBefore = hash(await readFile(join(project, 'main.typ.undertree-review.json')));
  const compilerBefore = hash(await readFile(compilerCalls));
  const registry = () => readFile(join(state, 'projects.json')).then(bytes => JSON.parse(bytes));
  const registryBefore = await registry();
  const root = await execute('return window.__nativeFixtureContext.root(arguments[0]);', [projectId]);
  const group = async path => Promise.all(members.map(async suffix => {
    const bytes = await readFile(join(project, path + suffix)), info = await stat(join(project, path + suffix));
    return {bytes:bytes.length,sha256:hash(bytes),mode:info.mode & 0o777};
  }));
  const expected = await group(from);
  const absent = async path => assert.rejects(stat(path), error => error.code === 'ENOENT');
  const privateFiles = async () => {
    const result = {};
    async function walk(path, prefix = '') {
      let names;
      try { names = await readdir(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const name of names.sort()) {
        const file = join(path, name), key = prefix + name;
        if ((await stat(file)).isDirectory()) { result[key + '/'] = 'directory'; await walk(file, key + '/'); }
        else result[key] = hash(await readFile(file));
      }
    }
    await walk(join(state, 'file-moves'));
    return result;
  };
  const invoke = (name, payload, retired = false, explain = false) => execute(`
    return window.__TAURI_INTERNALS__.invoke(arguments[0], {ownerId:arguments[2] ? 'retired-native-move-owner' : window.__nativeFixtureContext.owner(), ...arguments[1]})
      .then(value => ({ok:true,value}), error => ({ok:false,code:error.code,...(arguments[3] ? {message:error.message} : {})}));
  `, [name, payload, retired, explain]);
  const operation = value => invoke('file_move_operation', {operation:value});
  const value = response => { assert.equal(response.ok, true, JSON.stringify(response)); return response.value; };
  const request = overrides => ({generation:'0',requestId:randomUUID(),project:projectId,from,to,sourceEpoch:0,expectedRoot:root,revision:expected[0].sha256,sidecarRevision:expected[1].sha256,...overrides});
  const unchanged = async () => {
    assert.deepEqual(await group(from), expected);
    assert.equal(hash(await readFile(join(project, 'main.typ'))), mainBefore);
    assert.equal(hash(await readFile(join(project, 'main.typ.undertree-review.json'))), mainPolicyBefore);
  };

  // Observe actual native dispatch without substituting any response or owner.
  await execute(`
    window.__nativeMoveDispatch=[];
    window.__nativeMoveOriginalFetch=window.fetch;
    window.fetch=function(input,init,...rest) {
      const url=new URL(typeof input==='string'?input:input.url);
      if(url.protocol==='ipc:'||url.hostname==='ipc.localhost') {
        if(window.__nativeMoveDispatch.length>=512)throw Error('Native Move dispatch observation exceeded its bound.');
        const body=JSON.parse(typeof init?.body==='string'?init.body:new TextDecoder().decode(init.body));
        window.__nativeMoveDispatch.push({name:decodeURIComponent(url.pathname.slice(1)),action:body.operation?.action});
      }
      return Reflect.apply(window.__nativeMoveOriginalFetch,this,[input,init,...rest]);
    };
  `);
  try {
    const privateBefore = await privateFiles();
    assert.deepEqual(value(await operation({action:'move_list'})), {generation:'0',moves:[]});
    assert.deepEqual(await privateFiles(), privateBefore, 'Initial native List performs no private persistence.');
    assert.deepEqual(await invoke('file_move_operation', {operation:{action:'move_list'}}, true), {ok:false,code:'stale_session'});
    assert.deepEqual(await invoke('prepare_file_move', {request:request()}, true), {ok:false,code:'stale_session'});
    await unchanged();

    const collision = await invoke('prepare_file_move', {request:request({to:'zz-collision.typ'})});
    assert.deepEqual(collision, {ok:false,code:'exists'}, 'Actual native preparation refuses an existing destination for its collision.');
    assert.equal(await readFile(join(project, 'zz-collision.typ'), 'utf8'), 'Existing collision stays unchanged.\n');
    const liveMain = await invoke('prepare_file_move', {request:request({from:'main.typ',to:'moves/main.typ',revision:mainBefore,sidecarRevision:hash(await readFile(join(project,'main.typ.undertree-review.json')))})}, false, true);
    assert.equal(liveMain.ok, false); assert.equal(liveMain.code, 'busy');
    assert.equal(liveMain.message, 'Close both source and destination tabs and finish their queued saves/imports before moving.', 'The refusal comes from the actual live-session exclusion.');
    await unchanged();

    const prepared = value(await invoke('prepare_file_move', {request:request()}));
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.generation, '0');
    assert.equal(prepared.from, from); assert.equal(prepared.to, to);
    assert.equal(prepared.bundle.length, 3);
    const intent = {generation:prepared.generation,requestId:prepared.requestId,moveId:prepared.moveId};
    const pureBefore = await privateFiles();
    assert.deepEqual(value(await operation({action:'move_list'})).moves, [prepared]);
    assert.deepEqual(value(await operation({action:'move_status',generation:intent.generation,requestId:intent.requestId})), prepared);
    assert.deepEqual(await privateFiles(), pureBefore, 'List and Status preserve every private receipt byte.');
    await unchanged();
    for (const suffix of members) await absent(join(project, to + suffix));

    const moved = value(await operation({action:'move_commit',...intent}));
    assert.equal(moved.status, 'moved');
    assert.deepEqual(await group(to), expected, 'Actual native Commit preserves all raw group bytes and modes.');
    for (const suffix of members) await absent(join(project, from + suffix));
    const after = await registry(), epochs = after.sourceEpochs[projectId];
    assert.equal(epochs[from], moved.reservedSourceEpoch); assert.equal(epochs[to], moved.reservedDestinationEpoch);
    assert.equal(epochs[from], 1); assert.equal(epochs[to], 1);
    assert.equal(after.projects.find(p => p.id === projectId).mainDocument, registryBefore.projects.find(p => p.id === projectId).mainDocument);
    assert.deepEqual(value(await operation({action:'move_commit',...intent})), moved, 'A replay observes the same completed receipt.');
    assert.deepEqual(value(await operation({action:'move_list'})).moves, [moved]);
    const retired = value(await operation({action:'move_retire_terminal',generation:'0'}));
    assert.deepEqual(retired, {retiredGeneration:'0',generation:'1',retiredCount:1});
    assert.deepEqual(value(await operation({action:'move_list'})), {generation:'1',moves:[]});
    assert.deepEqual(await operation({action:'move_commit',...intent}), {ok:false,code:'move_generation_stale'});
    assert.deepEqual(await invoke('prepare_file_move', {request:request({from:to,to:'moves/old-generation.typ',sourceEpoch:1})}), {ok:false,code:'move_generation_stale'});
    assert.deepEqual(await group(to), expected);
    for (const suffix of members) await absent(join(project, from + suffix));
    assert.equal(hash(await readFile(join(project, 'main.typ'))), mainBefore);
    assert.equal(hash(await readFile(join(project, 'main.typ.undertree-review.json'))), mainPolicyBefore);
    assert.equal(hash(await readFile(compilerCalls)), compilerBefore, 'Native Move does not invoke a compiler.');
    const afterEditor = await execute('return {text:document.querySelector(".cm-content").textContent,label:document.getElementById("save-label").textContent,probe:{saved:window.__cliProbe.saved,committed:window.__cliProbe.committed,fallback:window.__cliProbe.fallback,errors:[...window.__cliProbe.errors]}};');
    assert.deepEqual(afterEditor, beforeEditor, 'Closed-source Move preserves the unrelated editor and dispatches no Save.');
    const dispatch = await execute('return window.__nativeMoveDispatch;');
    for (const name of ['prepare_file_move','file_move_operation']) assert.ok(dispatch.some(entry => entry.name === name), 'The passive trace observed the genuine native command: ' + name);
    assert.equal(dispatch.some(entry => entry.name === 'review_action' && ['open','save','compile','set_main_document','share','sync','accept','palette'].includes(entry.action)), false, 'The contract dispatches no source Open, content, main, grant, Sync or build operation.');
    assert.equal(dispatch.some(entry => entry.name === 'editor_operation' && entry.action === 'editor_commit'), false);
    evidence.nativeFileMove = {result:'passed',generation:'1',members:expected,sourceEpoch:epochs[from],destinationEpoch:epochs[to],nativeCommands:['prepare_file_move','file_move_operation'],closedSource:true,nonCurrentOwnerDenied:true,collisionPreserved:true,liveEditorDenied:true,pureReads:true,replayStable:true,staleGenerationDenied:true,unrelatedEditorPreserved:true,dispatch};
    checks.push('Actual native Move IPC preserves a closed source/Review/import group, denies collisions, non-current owners and live source sessions, advances epochs, replays receipts and retires one generation without saving, compiling or changing the unrelated editor.');
  } finally {
    await execute('window.fetch=window.__nativeMoveOriginalFetch;delete window.__nativeMoveOriginalFetch;');
  }
}
