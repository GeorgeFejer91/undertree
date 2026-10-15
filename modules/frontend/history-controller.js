import { sourceRoot } from './review-session.js';

const maxText = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const invalid = () => { throw { code: 'history_format', message: 'The saved History response could not be verified.' }; };
const require = condition => { if (!condition) invalid(); };
const keys = (value, names) => {
  require(value && typeof value === 'object' && !Array.isArray(value));
  const own = Reflect.ownKeys(value);
  require(own.length === names.length && names.every(name => Object.hasOwn(value, name) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, name), 'value')));
};
const uuid = value => require(typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value));
const decimal = value => require(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && (value.length < 20 || value <= '18446744073709551615'));
const integer = (value, max = Number.MAX_SAFE_INTEGER) => require(Number.isSafeInteger(value) && value >= 0 && value <= max);
const bytes = value => encoder.encode(value).length;
const editableExtensions = new Set(['html', 'htm', 'typ', 'css', 'md', 'txt', 'tex', 'bib', 'yaml', 'yml', 'json', 'csv', 'tsv', 'xml', 'svg']);
const path = value => {
  require(typeof value === 'string' && value.length <= 4096 && bytes(value) + '.undertree-pending.json'.length <= 4096);
  for (const character of value) require(character.codePointAt(0) < 0xd800 || character.codePointAt(0) > 0xdfff);
  const parts = value.split('/');
  require(parts.length <= 32 && parts.every(part => part && !part.startsWith('.') && bytes(part) <= 255 && !['For-AI', 'node_modules'].includes(part) && !/[\\\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/.test(part)));
  const name = parts.at(-1);
  require(bytes(name) + '.undertree-pending.json'.length <= 255 && editableExtensions.has(name.split('.').at(-1)) && !['.undertree-review.json', '.undertree-pending.json', '.import-report.json'].some(suffix => name.endsWith(suffix)));
};
const root = value => { try { return sourceRoot({ expectedRoot: value }); } catch { invalid(); } };
const sameRoot = (a, b) => a.dev === b.dev && a.ino === b.ino;
const freeze = Object.freeze;
function capture(context) {
  require(context && context.session && typeof context.session === 'object' && context.viewToken != null);
  uuid(context.projectId); path(context.path); integer(context.sourceEpoch);
  require(typeof context.ownerId === 'string' && context.ownerId.length > 0 && context.ownerId.length <= 256);
  return freeze({ session: context.session, viewToken: context.viewToken, projectId: context.projectId, root: root(context.root), path: context.path, sourceEpoch: context.sourceEpoch, ownerId: context.ownerId });
}
function sameContext(a, b) {
  return ['session', 'viewToken', 'projectId', 'path', 'sourceEpoch', 'ownerId'].every(key => a[key] === b[key]) && sameRoot(a.root, b.root);
}
function binding(value) {
  keys(value, ['projectId', 'root', 'path', 'sourceEpoch']); uuid(value.projectId); path(value.path); integer(value.sourceEpoch);
  return freeze({ projectId: value.projectId, root: root(value.root), path: value.path, sourceEpoch: value.sourceEpoch });
}
const summaryKeys = ['versionId', 'namespaceId', 'sourceId', 'binding', 'sha256', 'bytes', 'sequence', 'capturedAtMs', 'recordedAtMs', 'clockAdjusted', 'afterRecovery', 'cause', 'suggestionId'];
function summary(value, scope, projectId) {
  keys(value, summaryKeys);
  for (const key of ['versionId', 'namespaceId', 'sourceId']) uuid(value[key]);
  const source = binding(value.binding);
  require(source.projectId === projectId && sameRoot(source.root, scope.root) && source.path === scope.source.path && source.sourceEpoch === scope.source.sourceEpoch && value.namespaceId === scope.namespaceId && value.sourceId === scope.source.sourceId);
  require(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)); integer(value.bytes, maxText); decimal(value.sequence); require(value.sequence !== '0');
  for (const key of ['capturedAtMs', 'recordedAtMs']) if (value[key] !== null) integer(value[key]);
  require(typeof value.clockAdjusted === 'boolean' && typeof value.afterRecovery === 'boolean');
  require((value.cause === 'native_save' && value.suggestionId === null) || value.cause === 'local_acceptance');
  if (value.cause === 'local_acceptance') uuid(value.suggestionId);
  return freeze({ ...value, binding: source });
}
function sameSummary(a, b) {
  return summaryKeys.filter(key => key !== 'binding').every(key => a[key] === b[key]) && ['projectId', 'path', 'sourceEpoch'].every(key => a.binding[key] === b.binding[key]) && sameRoot(a.binding.root, b.binding.root);
}
function saved(value, listed, scope, projectId) {
  keys(value, ['version', 'content']);
  const version = summary(value.version, scope, projectId);
  require(sameSummary(version, listed));
  require(typeof value.content === 'string' && value.content.length <= maxText && bytes(value.content) === version.bytes);
  return freeze({ version, content: value.content });
}
function span(value, content) {
  if (value === null) return null;
  keys(value, ['fromUtf16', 'toUtf16']); integer(value.fromUtf16, content.length); integer(value.toUtf16, content.length); require(value.fromUtf16 <= value.toUtf16);
  for (const position of [value.fromUtf16, value.toUtf16]) require(!(position > 0 && position < content.length && /[\uD800-\uDBFF]/.test(content[position - 1]) && /[\uDC00-\uDFFF]/.test(content[position])));
  return freeze({ fromUtf16: value.fromUtf16, toUtf16: value.toUtf16 });
}
function page(value, query, scope) {
  keys(value, ['generation', 'namespaceId', 'items', 'cursor']); decimal(value.generation);
  if (query.cursor) require(value.generation === query.cursor.generation && value.namespaceId === query.cursor.namespaceId);
  if (value.namespaceId !== null) uuid(value.namespaceId);
  const kind = query.sourceId ? 'version' : query.namespaceId || query.observedRoot ? 'source' : 'namespace';
  if (query.namespaceId) require(value.namespaceId === query.namespaceId);
  if (kind === 'namespace') require(value.namespaceId === null);
  require(Array.isArray(value.items) && value.items.length <= 50);
  if (kind !== 'namespace' && value.namespaceId === null) require(value.items.length === 0 && value.cursor === null);
  const selected = freeze({ ...scope, namespaceId: value.namespaceId });
  const ids = new Set();
  const items = value.items.map(item => {
    require(item?.kind === kind);
    let result, id;
    if (kind === 'namespace') {
      keys(item, ['kind', 'namespaceId', 'projectId', 'root']); uuid(item.namespaceId); require(item.projectId === query.projectId);
      result = freeze({ ...item, root: root(item.root) }); id = item.namespaceId;
    } else if (kind === 'source') {
      keys(item, ['kind', 'namespaceId', 'sourceId', 'path', 'sourceEpoch']); uuid(item.sourceId); path(item.path); integer(item.sourceEpoch); require(item.namespaceId === value.namespaceId);
      result = freeze({ ...item }); id = item.sourceId;
    } else {
      keys(item, ['kind', 'version']); result = freeze({ kind, version: summary(item.version, selected, query.projectId) }); id = result.version.versionId;
    }
    require(!ids.has(id)); ids.add(id); return result;
  });
  let cursor = null;
  if (value.cursor !== null) {
    cursor = value.cursor; keys(cursor, ['generation', 'pageKind', 'projectId', 'namespaceId', 'sourceId', 'anchor']); decimal(cursor.generation);
    require(items.length === 50 && cursor.generation === value.generation && cursor.pageKind === `${kind}s` && cursor.projectId === query.projectId && cursor.namespaceId === value.namespaceId && cursor.sourceId === query.sourceId);
    require(typeof cursor.anchor === 'string' && cursor.anchor.length <= 64);
    if (kind === 'version') require(/^[0-9]{20}$/.test(cursor.anchor));
    else { uuid(cursor.anchor); require(cursor.anchor === items.at(-1)[kind === 'namespace' ? 'namespaceId' : 'sourceId']); }
    cursor = freeze({ ...cursor });
  }
  return { page: freeze({ generation: value.generation, namespaceId: value.namespaceId, items: freeze(items), cursor }), scope: selected };
}
const messages = {
  history_format: 'The saved History response could not be verified.',
  history_unavailable: 'Saved History is unavailable. Existing versions were preserved.',
  history_not_retained: 'This saved version is no longer retained. Request the list again.',
  history_stale: 'Saved History changed. Request its first page again.',
  history_limit: 'The History reply exceeds its supported size.',
  busy: 'A History query is still running. Try again after it finishes.',
  stale_root: 'The project folder identity changed. Reopen History deliberately.',
  stale_session: 'This native owner was retired. Reopen History from the current window.',
};

// Saved versions are independent of the live editor; this never enters its queue.
export class HistoryController {
  constructor({ request, context, render }) {
    Object.assign(this, { request, context, render }); this.current = null; this.capture = null; this.inFlight = false; this.ticket = null; this.listQuery = null;
  }
  emit(patch) { this.current = freeze({ ...this.current, ...patch }); this.render(this.current); }
  close() { this.ticket = null; this.capture = null; this.listQuery = null; this.emit({ phase: 'closed', scope: null, page: null, result: null, message: '' }); }
  back() { const editor = this.context().editor; this.close(); return editor; }
  changed() {
    if (!this.capture || ['closed', 'stale'].includes(this.current?.phase)) return;
    try { if (sameContext(this.capture, capture(this.context()))) return; } catch { /* A missing owner/source retires this observation. */ }
    this.ticket = null; this.listQuery = null; this.emit({ phase: 'stale', page: null, result: null, message: 'The History view identity changed. Reopen it deliberately.' });
  }
  async open() {
    this.ticket = null; this.capture = null; this.listQuery = null;
    this.current = freeze({ phase: 'ready', scope: null, page: null, result: null, message: '' });
    try { this.capture = capture(this.context()); }
    catch { this.emit({ phase: 'unavailable', message: messages.history_format }); return false; }
    return this.#list({ namespaceId: null, root: this.capture.root, source: null });
  }
  async namespaces() { return this.#list({ namespaceId: null, root: null, source: null }); }
  async selectNamespace(namespaceId) {
    const item = this.current?.page?.items.find(item => item.kind === 'namespace' && item.namespaceId === namespaceId); require(item);
    return this.#list({ namespaceId, root: item.root, source: null });
  }
  async selectSource(sourceId) {
    const source = this.current?.page?.items.find(item => item.kind === 'source' && item.sourceId === sourceId); require(source);
    return this.#list({ ...this.current.scope, source });
  }
  async sources() {
    require(this.capture && !['closed', 'stale'].includes(this.current?.phase) && this.current?.scope && (this.current.scope.namespaceId || this.current.scope.root));
    return this.#list({ ...this.current.scope, source: null });
  }
  async firstPage() {
    require(this.capture && !['closed', 'stale'].includes(this.current?.phase) && this.listQuery && this.current?.scope);
    return this.#list(this.current.scope, null, freeze({ ...this.listQuery, cursor: null }));
  }
  #list(scope, cursor = null, query = null) {
    require(this.capture);
    query ||= freeze({ action: 'list', projectId: this.capture.projectId, namespaceId: scope.namespaceId, observedRoot: scope.namespaceId ? null : scope.root, sourceId: scope.source?.sourceId || null, cursor });
    return this.#run(query, freeze(scope));
  }
  async nextPage() {
    require(this.current?.page?.cursor && this.listQuery);
    return this.#list(this.current.scope, this.current.page.cursor, freeze({ ...this.listQuery, cursor: this.current.page.cursor }));
  }
  #version(versionId) { const version = this.current?.page?.items.find(item => item.kind === 'version' && item.version.versionId === versionId)?.version; require(version); return version; }
  async read(versionId) {
    const version = this.#version(versionId), scope = this.current.scope;
    return this.#run(freeze({ action: 'read', projectId: this.capture.projectId, namespaceId: scope.namespaceId, sourceId: scope.source.sourceId, versionId }), scope, [version]);
  }
  async compare(fromVersionId, toVersionId) {
    const versions = [this.#version(fromVersionId), this.#version(toVersionId)], scope = this.current.scope;
    return this.#run(freeze({ action: 'compare', projectId: this.capture.projectId, namespaceId: scope.namespaceId, sourceId: scope.source.sourceId, fromVersionId, toVersionId }), scope, versions);
  }
  async #run(query, scope, versions) {
    this.changed(); if (!this.capture || ['closed', 'stale'].includes(this.current?.phase)) return false;
    if (this.inFlight) { this.emit({ phase: 'unavailable', message: messages.busy }); return false; }
    const captured = this.capture, ticket = {}; this.ticket = ticket; this.inFlight = true;
    if (query.action === 'list') this.listQuery = null;
    this.emit({ phase: 'loading', scope, result: null, message: '', ...(query.action === 'list' ? { page: null } : {}) });
    const current = () => { if (this.ticket !== ticket || this.capture !== captured) return false; this.changed(); return this.ticket === ticket; };
    try {
      if (!current()) return false;
      const reply = await this.request(query);
      if (!current()) return false;
      keys(reply, ['kind', 'result']); require(reply.kind === query.action);
      if (query.action === 'list') {
        const result = page(reply.result, query, scope); this.listQuery = query; this.emit({ phase: 'ready', ...result, result: null });
      } else if (query.action === 'read') {
        this.emit({ phase: 'ready', result: saved(reply.result, versions[0], scope, query.projectId) });
      } else {
        keys(reply.result, ['from', 'to', 'fromChanged', 'toChanged', 'method']); require(reply.result.method === 'coarse_text_comparison');
        const from = saved(reply.result.from, versions[0], scope, query.projectId), to = saved(reply.result.to, versions[1], scope, query.projectId);
        const fromChanged = span(reply.result.fromChanged, from.content), toChanged = span(reply.result.toChanged, to.content);
        require((from.content === to.content) === (fromChanged === null && toChanged === null));
        require((fromChanged === null) === (toChanged === null));
        if (fromChanged) require(fromChanged.fromUtf16 === toChanged.fromUtf16);
        this.emit({ phase: 'ready', result: freeze({ from, to, fromChanged, toChanged, method: reply.result.method }) });
      }
      return true;
    } catch (error) {
      if (!current()) return false;
      const code = Object.hasOwn(messages, error?.code) ? error.code : 'history_unavailable';
      if (['stale_root', 'stale_session'].includes(code)) this.ticket = null;
      this.emit({ phase: ['stale_root', 'stale_session'].includes(code) ? 'stale' : 'unavailable', result: null, message: messages[code], ...(code === 'history_stale' ? { page: null } : {}) }); return false;
    } finally { this.inFlight = false; }
  }
}
