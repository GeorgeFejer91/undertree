import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HistoryController } from '../modules/frontend/history-controller.js';

const id = n => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const project = id(1), namespace = id(2), source = id(3), versionA = id(4), versionB = id(5);
const root = { dev: '18446744073709551615', ino: '9007199254740993' }, otherRoot = { ...root, ino: '9007199254740994' };
const sha = content => createHash('sha256').update(content).digest('hex');
const size = content => Buffer.byteLength(content);
const summary = (versionId = versionA, content = 'Saved alpha', overrides = {}) => ({ versionId, namespaceId: namespace, sourceId: source, binding: { projectId: project, root, path: 'main.typ', sourceEpoch: 7 }, sha256: sha(content), bytes: size(content), sequence: '9007199254740993', capturedAtMs: null, recordedAtMs: 1000, clockAdjusted: false, afterRecovery: false, cause: 'native_save', suggestionId: null, ...overrides });
const sourceItem = (sourceId = source, path = 'main.typ', sourceEpoch = 7) => ({ kind: 'source', namespaceId: namespace, sourceId, path, sourceEpoch });
const list = (items, namespaceId = namespace, cursor = null, generation = '9007199254740993') => ({ kind: 'list', result: { generation, namespaceId, items, cursor } });
const read = (version = summary(), content = 'Saved alpha') => ({ kind: 'read', result: { version, content } });
const compare = (from = summary(), to = summary(versionB, 'Saved beta'), a = 'Saved alpha', b = 'Saved beta') => ({ kind: 'compare', result: { from: { version: from, content: a }, to: { version: to, content: b }, fromChanged: a === b ? null : { fromUtf16: 0, toUtf16: a.length }, toChanged: a === b ? null : { fromUtf16: 0, toUtf16: b.length }, method: 'coarse_text_comparison' } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(request) {
  const session = { generation: 1, version: 1, savedVersion: 0, content: 'Dirty current draft', dirty: true }, calls = [], rendered = [];
  const current = { session, viewToken: {}, projectId: project, root, path: 'main.typ', sourceEpoch: 7, ownerId: 'current-native-owner', editor: { text: 'Latest live editor' } };
  const controller = new HistoryController({ context: () => current, request: async query => { calls.push(query); return request(query); }, render: state => rendered.push(state) });
  return { controller, current, session, calls, rendered };
}
async function versions(f, values = [summary(), summary(versionB, 'Saved beta')]) {
  await f.controller.open(); await f.controller.selectSource(source);
  assert.equal(f.controller.current.page.items[0].kind, 'version'); return values;
}
const browse = values => query => query.action === 'list' ? list(query.sourceId ? values.map(version => ({ kind: 'version', version })) : [sourceItem()]) : query.action === 'read' ? read(values.find(value => value.versionId === query.versionId)) : compare(...values);

test('closed parent navigation uses validated selected scope and first-page query without retaining old rows', async () => {
  const values = [summary(), summary(versionB, 'Saved beta')], f = fixture(browse(values));
  await versions(f, values); await f.controller.read(versionA); await f.controller.sources();
  assert.equal(f.controller.current.page.items[0].kind, 'source');
  assert.deepEqual(f.calls.at(-1), { action: 'list', projectId: project, namespaceId: namespace, observedRoot: null, sourceId: null, cursor: null });
  await f.controller.selectSource(source); await f.controller.firstPage();
  assert.equal(f.calls.at(-1).sourceId, source); assert.equal(f.calls.at(-1).cursor, null);
  f.controller.close(); const count = f.calls.length;
  await assert.rejects(f.controller.sources()); await assert.rejects(f.controller.firstPage()); assert.equal(f.calls.length, count);
});

test('observed-root pagination refuses another namespace even at the same catalog generation, then admits the exact namespace control', async () => {
  const items = Array.from({ length: 50 }, (_, i) => sourceItem(id(100 + i), `chapter${i}.typ`));
  const cursor = { generation: '9007199254740993', pageKind: 'sources', projectId: project, namespaceId: namespace, sourceId: null, anchor: items.at(-1).sourceId };
  for (const mismatch of [true, false]) {
    const nextNamespace = mismatch ? id(99) : namespace;
    const f = fixture(query => query.cursor ? list([{ ...sourceItem(id(200), 'later.typ'), namespaceId: nextNamespace }], nextNamespace) : list(items, namespace, cursor));
    await f.controller.open(); assert.equal(await f.controller.nextPage(), !mismatch);
    if (mismatch) {
      assert.equal(f.controller.current.phase, 'unavailable'); assert.equal(f.controller.current.page, null); assert.equal(f.controller.listQuery, null);
      const count = f.calls.length; await assert.rejects(f.controller.selectSource(id(200))); assert.equal(f.calls.length, count);
    } else { assert.equal(f.controller.current.page.items[0].path, 'later.typ'); await f.controller.firstPage(); assert.equal(f.calls.at(-1).cursor, null); assert.deepEqual(f.calls.at(-1).observedRoot, root); }
  }
});

test('uses only the exact native closed List/Read/Compare DTOs with canonical private IDs and root strings', async () => {
  const values = [summary(), summary(versionB, 'Saved beta')], f = fixture(browse(values));
  await versions(f, values); await f.controller.read(versionA); await f.controller.compare(versionA, versionB);
  assert.deepEqual(f.calls, [
    { action: 'list', projectId: project, namespaceId: null, observedRoot: root, sourceId: null, cursor: null },
    { action: 'list', projectId: project, namespaceId: namespace, observedRoot: null, sourceId: source, cursor: null },
    { action: 'read', projectId: project, namespaceId: namespace, sourceId: source, versionId: versionA },
    { action: 'compare', projectId: project, namespaceId: namespace, sourceId: source, fromVersionId: versionA, toVersionId: versionB },
  ]);
  assert.equal(f.controller.current.result.method, 'coarse_text_comparison');
  assert.equal(f.controller.current.page.generation, '9007199254740993'); assert.equal(f.controller.current.page.items[0].version.sequence, '9007199254740993');
  assert.equal(Object.isFrozen(f.calls[0].observedRoot), true); assert.equal(Object.isFrozen(f.controller.current.result.from.version.binding.root), true);
  assert.equal(typeof f.controller.run, 'undefined'); assert.equal(typeof f.controller.list, 'undefined');
});

test('independent edits and save completion in the SAME session keep saved reads usable; Back returns the latest editor', async () => {
  const values = [summary(), summary(versionB, 'Saved beta')], gate = deferred(), normal = browse(values), f = fixture(query => query.action === 'read' ? gate.promise : normal(query));
  for (const name of ['queue', 'flush', 'mutate', 'saveCurrent']) Object.defineProperty(f.session, name, { get() { throw Error(`History must never access ${name}`); } });
  await versions(f, values); const reading = f.controller.read(versionA);
  f.session.content = 'Newer actual typing'; f.session.generation += 1; f.session.version += 1; f.session.savedVersion = f.session.version; f.session.dirty = false;
  const latestEditor = { text: f.session.content, caret: 4, undo: ['old', 'latest'] }; f.current.editor = latestEditor; f.controller.changed();
  gate.resolve(read()); assert.equal(await reading, true); assert.equal(f.controller.current.result.content, 'Saved alpha');
  assert.equal(f.session.content, 'Newer actual typing'); assert.equal(f.controller.back(), latestEditor); assert.equal(f.controller.current.phase, 'closed'); assert.deepEqual(latestEditor.undo, ['old', 'latest']); assert.equal(f.calls.length, 3);
});

test('source/session/view/project/root/epoch/native owner retirement discards even an otherwise valid held reply', async () => {
  for (const key of ['session', 'viewToken', 'projectId', 'root', 'path', 'sourceEpoch', 'ownerId']) {
    const gate = deferred(), f = fixture(() => gate.promise), opening = f.controller.open();
    f.current[key] = { session: {}, viewToken: {}, projectId: id(99), root: otherRoot, path: 'other.typ', sourceEpoch: 8, ownerId: 'retired-owner' }[key];
    gate.resolve(list([sourceItem()])); assert.equal(await opening, false, key); assert.equal(f.controller.current.phase, 'stale', key); assert.equal(f.controller.current.page, null); assert.equal(f.controller.current.result, null);
  }
});

test('Back never waits for a held native query; retired work stays bounded across reopen and cannot repaint', async () => {
  const gate = deferred(), f = fixture(() => gate.promise), first = f.controller.open();
  const latest = { text: 'Latest while native is pending' }; f.current.editor = latest;
  assert.equal(f.controller.back(), latest); assert.equal(f.controller.current.phase, 'closed');
  f.current.viewToken = {}; assert.equal(await f.controller.open(), false); assert.equal(f.calls.length, 1); assert.match(f.controller.current.message, /query is still running/);
  const state = f.controller.current; gate.resolve(list([sourceItem()])); assert.equal(await first, false); assert.equal(f.controller.current, state); assert.equal(f.controller.inFlight, false);
  f.controller.request = async query => { f.calls.push(query); return list([sourceItem()]); };
  assert.equal(await f.controller.open(), true); assert.equal(f.calls.length, 2);
});

test('close then a late error does not stamp a new view or auto-retry any query', async () => {
  const gate = deferred(), f = fixture(() => gate.promise), opening = f.controller.open(); f.controller.close();
  gate.reject({ code: 'history_stale', message: 'Old view error' }); assert.equal(await opening, false); assert.equal(f.controller.current.phase, 'closed'); assert.equal(f.controller.current.message, ''); assert.equal(f.calls.length, 1);
});

test('current-root empty History is an honest empty page without fabricated namespace/source identities', async () => {
  const f = fixture(() => list([], null)); assert.equal(await f.controller.open(), true); assert.equal(f.controller.current.page.namespaceId, null); assert.deepEqual(f.controller.current.page.items, []);
  await assert.rejects(f.controller.selectSource(source), error => error.code === 'history_format'); assert.equal(f.calls.length, 1);
});

test('a selected old namespace root and archived source epoch stay explicit without adopting them into the live editor', async () => {
  const oldNamespace = id(20), oldSource = id(21), oldVersion = id(22);
  const archived = summary(oldVersion, 'Archived source', { namespaceId: oldNamespace, sourceId: oldSource, binding: { projectId: project, root: otherRoot, path: 'chapter.typ', sourceEpoch: 2 } });
  const f = fixture(query => {
    if (query.action === 'read') return read(archived, 'Archived source');
    if (query.sourceId) return list([{ kind: 'version', version: archived }], oldNamespace);
    if (query.namespaceId) return list([{ ...sourceItem(oldSource, 'chapter.typ', 2), namespaceId: oldNamespace }], oldNamespace);
    if (!query.observedRoot) return list([{ kind: 'namespace', namespaceId: oldNamespace, projectId: project, root: otherRoot }], null);
    return list([], null);
  });
  await f.controller.open(); await f.controller.namespaces(); await f.controller.selectNamespace(oldNamespace); await f.controller.selectSource(oldSource); await f.controller.read(oldVersion);
  assert.deepEqual(f.controller.current.result.version.binding.root, otherRoot); assert.equal(f.controller.current.result.version.binding.sourceEpoch, 2);
  assert.deepEqual(f.current.root, root); assert.equal(f.current.path, 'main.typ'); assert.equal(f.current.sourceEpoch, 7); assert.equal(f.session.content, 'Dirty current draft');
  await assert.rejects(f.controller.read(versionA), error => error.code === 'history_format');
});

test('pages replace rather than accumulate, keep <=50 rows, and reuse only a scope-bound exact cursor', async () => {
  const first = Array.from({ length: 50 }, (_, n) => sourceItem(id(100 + n), `chapter${n}.typ`));
  const cursor = { generation: '18446744073709551615', pageKind: 'sources', projectId: project, namespaceId: namespace, sourceId: null, anchor: first.at(-1).sourceId };
  const f = fixture(query => query.cursor ? list([sourceItem(id(200), 'last.typ')], namespace, null, cursor.generation) : list(first, namespace, cursor, cursor.generation));
  await f.controller.open(); const old = f.controller.current.page; await f.controller.nextPage(); assert.equal(f.controller.current.page.items.length, 1); assert.notEqual(f.controller.current.page, old); assert.deepEqual(f.calls[1].cursor, cursor);
  await assert.rejects(f.controller.selectSource(first[0].sourceId), error => error.code === 'history_format'); assert.equal(f.calls.length, 2);
  const oversized = fixture(() => list([...first, sourceItem(id(250))])); assert.equal(await oversized.controller.open(), false); assert.equal(oversized.controller.current.phase, 'unavailable');
});

test('strict page generation, root, private-ID, scope, cursor and extra-field errors never become ready results', async () => {
  const bad = [
    reply => { reply.extra = true; }, reply => { reply.kind = 'read'; }, reply => { reply.result.generation = 4; }, reply => { reply.result.generation = '04'; }, reply => { reply.result.generation = '18446744073709551616'; }, reply => { reply.result.namespaceId = id(99); reply.result.items[0].namespaceId = namespace; }, reply => { reply.result.items[0].sourceEpoch = '7'; }, reply => { reply.result.items[0].sourceId = 'not-a-private-id'; }, reply => { reply.result.items[0].unknown = 'hidden'; }, reply => { reply.result.items.push(reply.result.items[0]); }, reply => { reply.result.cursor = { generation: '1', pageKind: 'sources', projectId: project, namespaceId: namespace, sourceId: null, anchor: source }; },
  ];
  for (const mutate of bad) {
    const reply = structuredClone(list([sourceItem()])); mutate(reply); const f = fixture(() => reply);
    assert.equal(await f.controller.open(), false); assert.equal(f.controller.current.phase, 'unavailable'); assert.equal(f.controller.current.result, null);
  }
  for (const value of [null, { dev: 1, ino: '2' }, { dev: '01', ino: '2' }, { dev: '1', ino: '2', extra: '3' }]) {
    const f = fixture(() => list([])); f.current.root = value; assert.equal(await f.controller.open(), false); assert.equal(f.calls.length, 0);
  }
});

test('immutable listed metadata binds Read to version, namespace, source, project, root, path, epoch, digest and sequence', async () => {
  const fields = [
    version => { version.versionId = versionB; }, version => { version.namespaceId = id(99); }, version => { version.sourceId = id(99); }, version => { version.binding.projectId = id(99); }, version => { version.binding.root = otherRoot; }, version => { version.binding.path = 'other.typ'; }, version => { version.binding.sourceEpoch += 1; }, version => { version.sha256 = 'b'.repeat(64); }, version => { version.sequence = '9007199254740994'; }, version => { version.sequence = 1; }, version => { version.sequence = '0'; }, version => { version.bytes += 1; }, version => { version.recordedAtMs += 1; }, version => { version.cause = 'remote_save'; }, version => { version.binding.extra = true; },
  ];
  for (const mutate of fields) {
    const values = [summary()], f = fixture(query => query.action === 'read' ? (() => { const reply = structuredClone(read()); mutate(reply.result.version); return reply; })() : browse(values)(query));
    await versions(f, values); assert.equal(await f.controller.read(versionA), false); assert.equal(f.controller.current.result, null); assert.equal(f.controller.current.phase, 'unavailable');
  }
});

test('one saved text is bounded by actual UTF8 bytes at2MiB; new queries clear prior payloads without caching them', async () => {
  const text = 'é'.repeat(1024 * 1024), value = summary(versionA, text), gate = deferred(); let pending = false;
  const f = fixture(query => query.action === 'read' ? pending ? gate.promise : read(value, text) : browse([value])(query));
  await versions(f, [value]); assert.equal(await f.controller.read(versionA), true); assert.equal(size(f.controller.current.result.content), 2 * 1024 * 1024);
  pending = true; const reading = f.controller.read(versionA); assert.equal(f.controller.current.result, null); assert.equal(f.controller.current.page.items.length, 1);
  gate.resolve(read(value, text + 'é')); assert.equal(await reading, false); assert.equal(f.controller.current.result, null);
  const invalidSize = fixture(() => list([{ kind: 'version', version: { ...value, bytes: 2 * 1024 * 1024 + 1 } }]));
  // Wrong kind is also closed before any text read; selected metadata bounds are tested below.
  assert.equal(await invalidSize.controller.open(), false);
  const oversized = fixture(query => query.sourceId ? list([{ kind: 'version', version: { ...value, bytes: 2 * 1024 * 1024 + 1 } }]) : list([sourceItem()]));
  await oversized.controller.open(); assert.equal(await oversized.controller.selectSource(source), false);
});

test('comparison retains only two <=2MiB texts and validates exact coarse method plus UTF16 span boundaries', async () => {
  const a = 'a'.repeat(2 * 1024 * 1024), b = 'b'.repeat(2 * 1024 * 1024), values = [summary(versionA, a), summary(versionB, b)];
  const f = fixture(query => query.action === 'compare' ? compare(...values, a, b) : browse(values)(query));
  await versions(f, values); assert.equal(await f.controller.compare(versionA, versionB), true); assert.equal(size(f.controller.current.result.from.content) + size(f.controller.current.result.to.content), 4 * 1024 * 1024);
  f.controller.close(); assert.equal(f.controller.current.result, null); assert.equal(f.controller.current.page, null);
  for (const mutate of [reply => { reply.result.method = 'html_diff'; }, reply => { reply.result.fromChanged = null; }, reply => { reply.result.fromChanged.toUtf16 = 99; }, reply => { reply.result.fromChanged.fromUtf16 = 1; }, reply => { reply.result.fromChanged.fromUtf16 = 2; }]) {
    const x = '🌳one', y = '🌳two', v = [summary(versionA, x), summary(versionB, y)], g = fixture(query => { if (query.action !== 'compare') return browse(v)(query); const reply = compare(...v, x, y); mutate(reply); return reply; });
    await versions(g, v); assert.equal(await g.controller.compare(versionA, versionB), false); assert.equal(g.controller.current.result, null);
  }
});

test('stale catalog errors do not retry or mislabel saved content, and native owner refusal retires only this observation', async () => {
  for (const code of ['history_stale', 'history_not_retained', 'history_unavailable', 'stale_root', 'stale_session', 'busy']) {
    const f = fixture(() => { throw { code, message: 'Untrusted source/path detail must not be copied to UI' }; });
    assert.equal(await f.controller.open(), false); assert.equal(f.calls.length, 1); assert.equal(f.controller.current.result, null); assert.doesNotMatch(f.controller.current.message, /Untrusted/);
    assert.equal(f.controller.current.phase, ['stale_root', 'stale_session'].includes(code) ? 'stale' : 'unavailable'); assert.equal(f.session.content, 'Dirty current draft');
  }
});

test('a context retired synchronously by the render callback dispatches no native query', async () => {
  const f = fixture(() => { throw Error('No retired native query'); });
  f.controller.render = state => { if (state.phase === 'loading') f.current.viewToken = {}; };
  assert.equal(await f.controller.open(), false); assert.equal(f.calls.length, 0); assert.equal(f.controller.current.phase, 'stale');
});

test('a rejected namespace switch discards prior rows and cursor before loading and cannot dispatch mismatched followups', async () => {
  const gate = deferred(), namespaces = Array.from({ length: 50 }, (_, n) => ({ kind: 'namespace', projectId: project, namespaceId: id(300 + n), root: { dev: '1', ino: String(n + 1) } }));
  const cursor = { generation: '3', pageKind: 'namespaces', projectId: project, namespaceId: null, sourceId: null, anchor: namespaces.at(-1).namespaceId };
  const f = fixture(query => query.namespaceId ? gate.promise : query.observedRoot ? list([sourceItem()]) : list(namespaces, null, cursor, '3'));
  await f.controller.open(); await f.controller.namespaces(); assert.equal(f.controller.current.page.items.length, 50); assert.ok(f.controller.current.page.cursor);
  const switching = f.controller.selectNamespace(namespaces[0].namespaceId);
  assert.equal(f.controller.current.page, null); assert.equal(f.controller.listQuery, null);
  gate.reject({ code: 'history_unavailable' }); assert.equal(await switching, false); assert.equal(f.controller.current.page, null);
  const count = f.calls.length;
  await assert.rejects(f.controller.selectNamespace(namespaces[1].namespaceId), error => error.code === 'history_format');
  await assert.rejects(f.controller.nextPage(), error => error.code === 'history_format');
  await assert.rejects(f.controller.read(versionA), error => error.code === 'history_format'); assert.equal(f.calls.length, count);
});

test('path observations match the final rooted Unix source grammar without normalization or extension widening', async () => {
  const pending = '.undertree-pending.json'.length;
  const accepted = ['nested/ordinary: Linux name.typ', 'références.bib', '🌳/main.typ', 'data.csv', 'a'.repeat(255 - pending - 4) + '.typ', Array(31).fill('x').join('/') + '/main.typ'];
  for (const name of accepted) { const f = fixture(() => list([], null)); f.current.path = name; assert.equal(await f.controller.open(), true, name); assert.equal(f.current.path, name); }
  const invalid = ['../main.typ', '/main.typ', 'main.typ/', 'a//main.typ', '.private/main.typ', 'node_modules/main.typ', 'For-AI/main.typ', 'a\\main.typ', 'bad\ud800.typ', 'bad\udfff.typ', 'main.png', 'main.TYP', 'main.typ.undertree-review.json', 'main.typ.undertree-pending.json', 'main.typ.import-report.json', 'a'.repeat(256) + '/main.typ', 'é'.repeat(128) + '/main.typ', 'a'.repeat(256 - pending - 4) + '.typ', Array(32).fill('x').join('/') + '/main.typ', ...['\u0000', '\u0085', '\u200e', '\u200f', '\u2028', '\u2029', '\u202a', '\u202e', '\u2066', '\u2069', '\ufeff'].map(value => `a${value}.typ`)];
  for (const name of invalid) { const f = fixture(() => list([], null)); f.current.path = name; assert.equal(await f.controller.open(), false, JSON.stringify(name)); assert.equal(f.calls.length, 0); }
  const nearLimit = Array(16).fill('a'.repeat(250)).join('/') + '/' + 'b'.repeat(70) + '.typ';
  assert.ok(size(nearLimit) < 4096 && size(nearLimit) + pending > 4096);
  const f = fixture(() => list([], null)); f.current.path = nearLimit; assert.equal(await f.controller.open(), false); assert.equal(f.calls.length, 0);
});

test('local acceptance provenance and unknown capture time remain native metadata without fabricated timestamps', async () => {
  const value = summary(versionA, 'Saved alpha', { cause: 'local_acceptance', suggestionId: id(88), capturedAtMs: null, recordedAtMs: null, afterRecovery: true });
  const f = fixture(browse([value])); await versions(f, [value]); assert.equal(await f.controller.read(versionA), true);
  assert.equal(f.controller.current.result.version.cause, 'local_acceptance'); assert.equal(f.controller.current.result.version.suggestionId, id(88));
  assert.equal(f.controller.current.result.version.capturedAtMs, null); assert.equal(f.controller.current.result.version.recordedAtMs, null); assert.equal(f.controller.current.result.version.afterRecovery, true);
});

test('opening History does not emit an intermediate Back/closed lifecycle state', async () => {
  const f = fixture(() => list([], null)); await f.controller.open();
  assert.deepEqual(f.rendered.map(state => state.phase), ['loading', 'ready']);
});
