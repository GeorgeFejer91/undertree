import { sourceRoot, sourceRootsEqual, sourceEpoch } from './review-session.js';

const key = (generation, requestId) => `${generation}:${requestId}`;
const terminal = status => ['moved', 'cancelled', 'not_submitted'].includes(status);
const hashPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const storageKey = 'undertree.file-moves.v1';
const fail = message => { throw { code: 'format', message }; };
const fields = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) fail('The Move request format is invalid.');
};
const uuid = value => { if (typeof value !== 'string' || !uuidPattern.test(value)) fail('The Move request identity is invalid.'); return value; };
const epoch = value => sourceEpoch({ sourceEpoch: value });
export function moveGeneration(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || value.length === 20 && value > '18446744073709551615') fail('The Move receipt generation is invalid.');
  return value;
}
function paths(from, to) {
  const source = value => typeof value === 'string' && new TextEncoder().encode(value).length <= 4096 && !/[\\\u0000-\u001f\u007f-\u009f]/u.test(value) && value.split('/').every(part => part && !['.', '..'].includes(part)) && /\.(typ|html)$/.exec(value)?.[1];
  const extension = source(from);
  if (!extension || source(to) !== extension || from === to) fail('Choose distinct project-relative .typ or .html paths with the same extension.');
}
const prepareFields = ['generation', 'requestId', 'project', 'from', 'to', 'sourceEpoch', 'expectedRoot', 'revision', 'sidecarRevision'];
function prepareRequest(value) {
  fields(value, prepareFields); moveGeneration(value.generation); uuid(value.requestId); uuid(value.project); paths(value.from, value.to); epoch(value.sourceEpoch);
  if (typeof value.revision !== 'string' || !hashPattern.test(value.revision) || value.sidecarRevision !== null && (typeof value.sidecarRevision !== 'string' || !hashPattern.test(value.sidecarRevision))) fail('The saved source or raw review-file proof is invalid.');
  return Object.freeze(Object.fromEntries(prepareFields.map(name => [name, name === 'expectedRoot' ? sourceRoot(value) : value[name]])));
}
export function assertMoveEndpointsClosed(sessions, project, from, to) {
  for (const session of sessions) if (session.project === project && [from, to].includes(session.path)) throw { code: 'busy', message: 'Close both source and destination file tabs, including inactive tabs, before moving. Your buffers are kept.' };
}
const operationFields = {
  move_list: ['action'],
  move_status: ['action', 'generation', 'requestId'],
  move_commit: ['action', 'generation', 'requestId', 'moveId'],
  move_cancel: ['action', 'generation', 'requestId', 'moveId'],
  move_reconcile: ['action', 'generation', 'requestId'],
  move_retire_terminal: ['action', 'generation'],
};
export function nativeFileMoveCommands(invoke, ownerId, available) {
  const call = async (command, name, value) => {
    if (!available) throw { code: 'desktop_required', message: 'Moving sources requires the UnderTree desktop app.' };
    return invoke(command, { ownerId: await ownerId(), [name]: value });
  };
  return {
    prepare: request => call('prepare_file_move', 'request', prepareRequest(request)),
    request: operation => {
      const names = operationFields[operation?.action]; if (!names) fail('This Move operation is unavailable.');
      fields(operation, names);
      if (names.includes('generation')) moveGeneration(operation.generation);
      if (names.includes('requestId')) uuid(operation.requestId);
      if (names.includes('moveId')) uuid(operation.moveId);
      return call('file_move_operation', 'operation', operation);
    },
  };
}
async function digest(content) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function receiptRequest(receipt) {
  if (!['prepared', 'cancelled', 'pending', 'moved', 'recovery_required'].includes(receipt?.status)) fail('The native Move result is unavailable.');
  const request = prepareRequest(Object.fromEntries(prepareFields.map(name => [name, receipt[name]])));
  uuid(receipt.moveId);
  for (const name of ['destinationEpoch', 'reservedSourceEpoch', 'reservedDestinationEpoch', 'expiresAt']) epoch(receipt[name]);
  if (!Array.isArray(receipt.bundle) || receipt.bundle.length > 3) fail('The Move bundle proof is invalid.');
  return request;
}
function capture(receipt) {
  return JSON.stringify(['moveId', 'destinationEpoch', 'reservedSourceEpoch', 'reservedDestinationEpoch', 'expiresAt', 'bundle'].map(name => receipt[name]));
}

// Only request metadata is retained here. Rust owns proofs, durability and every filesystem effect.
export class NativeFileMove {
  constructor({ prepare, request, observe, sessions, canStart, refresh, onChange = () => {}, storage, requestId = () => crypto.randomUUID() }) {
    Object.assign(this, { prepareNative: prepare, request, observe, sessions, canStart, refresh, onChange, requestId });
    this.records = new Map(); this.intents = new Map(); this.current = null; this.generation = null; this.ready = false; this.busy = false; this.maintenance = null; this.maintenanceObserved = false; this.message = ''; this.storageProblem = '';
    try {
      this.storage = storage || globalThis.localStorage;
      const raw = this.storage.getItem(storageKey);
      if (raw === null) return;
      if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) fail('The retained Move request data is invalid.');
      const saved = JSON.parse(raw); fields(saved, ['version', 'intents', 'retirement']);
      if (saved.version !== 1 || !Array.isArray(saved.intents) || saved.intents.length > 64) fail('The retained Move request data is invalid.');
      for (const row of saved.intents) {
        fields(row, ['request', 'moveId', 'commitSubmitted']); const request = prepareRequest(row.request);
        if (row.moveId !== null) uuid(row.moveId);
        if (typeof row.commitSubmitted !== 'boolean' || this.intents.has(key(request.generation, request.requestId))) fail('The retained Move identity is invalid.');
        this.intents.set(key(request.generation, request.requestId), { request, moveId: row.moveId, commitSubmitted: row.commitSubmitted });
        const context = { request, moveId: row.moveId, commitSubmitted: row.commitSubmitted, owned: false, status: 'unknown', phase: 'unconfirmed', message: 'Check this retained Move request before starting another.' };
        this.records.set(key(request.generation, request.requestId), context); this.current ||= context;
      }
      if (saved.retirement !== null) { fields(saved.retirement, ['generation']); this.maintenance = { generation: moveGeneration(saved.retirement.generation), phase: 'unconfirmed' }; }
    } catch { this.storageProblem = 'Retained Move request storage is unavailable or invalid. New Move submissions are disabled; existing native requests can still be checked.'; }
  }
  get pendingCount() { return Number(this.busy || !this.ready || this.maintenanceObserved || !!this.maintenance) + [...this.records.values()].filter(context => !terminal(context.status)).length; }
  get retainedCount() { return [...this.records.values()].filter(context => context.native).length; }
  get canPrepare() { return this.ready && !this.busy && !this.pendingCount && !this.storageProblem && this.retainedCount < 64; }
  blocks(project, path) { return [...this.records.values()].some(context => !terminal(context.status) && context.request.project === project && [context.request.from, context.request.to].includes(path)); }
  changed() { this.onChange(this); }
  select(id) { if (!this.busy) { this.current = this.records.get(id) || null; this.changed(); } }
  persist() {
    if (this.storageProblem) throw { code: 'move_storage', message: this.storageProblem };
    const value = JSON.stringify({ version: 1, intents: [...this.intents.values()], retirement: this.maintenance ? { generation: this.maintenance.generation } : null });
    try {
      this.storage.setItem(storageKey, value);
      if (this.storage.getItem(storageKey) !== value) throw Error();
    } catch { this.storageProblem = 'The Move request identity could not be saved and read back. No new submission is allowed.'; throw { code: 'move_storage', message: this.storageProblem }; }
  }
  remember(context) {
    this.intents.set(key(context.request.generation, context.request.requestId), { request: context.request, moveId: context.moveId || null, commitSubmitted: !!context.commitSubmitted }); this.persist();
  }
  forget(context) {
    this.intents.delete(key(context.request.generation, context.request.requestId));
    try { this.persist(); } catch { /* The verified native terminal result still bars future effects from this request. */ }
  }
  problem(error, context) {
    if (error?.code === 'move_generation_stale') { this.ready = false; this.message = 'This request belongs to retired Move history. Check requests; it will not be retried under a new identity.'; }
    else if (error?.code === 'move_maintenance') { this.ready = false; this.maintenanceObserved = true; this.message = 'Move receipt maintenance is still unresolved. Check requests without submitting another action.'; }
    else this.message = error?.message || 'The native response was lost. Check the same request before another action.';
    if (context) { context.phase = error?.code === 'move_generation_stale' ? 'stale_generation' : 'unconfirmed'; context.message = this.message; }
  }
  async refreshCurrent() {
    try { await this.refresh(); }
    catch { this.message += ' The current project tree could not be refreshed. Refresh it locally before opening a file.'; }
  }
  async discover() {
    if (this.busy) return;
    this.busy = true; this.changed();
    try {
      const result = await this.request({ action: 'move_list' }); const generation = moveGeneration(result?.generation);
      if (!Array.isArray(result.moves) || result.moves.length > 64) fail('The native Move inventory is invalid.');
      const next = new Map(); let refresh = false;
      for (const receipt of result.moves) {
        const request = receiptRequest(receipt); if (request.generation !== generation) fail('The Move inventory mixes receipt generations.');
        const id = key(generation, request.requestId); if (next.has(id)) fail('The Move inventory repeats a request.');
        const context = this.records.get(id) || { request, owned: false, commitSubmitted: false };
        await this.accept(context, receipt, false); next.set(id, context); refresh ||= receipt.status === 'moved';
      }
      for (const [id, row] of this.intents) {
        if (row.request.generation !== generation) { this.intents.delete(id); refresh = true; continue; }
        if (!next.has(id)) next.set(id, this.records.get(id) || { ...row, owned: false, status: 'unknown', phase: 'unconfirmed', message: 'No receipt is known yet. This is not permission to retry the submission.' });
      }
      if (this.maintenance && this.maintenance.generation !== generation) { this.maintenance = null; refresh = true; }
      this.generation = generation; this.records = next; this.ready = true; this.maintenanceObserved = false;
      this.current = this.current && next.get(key(this.current.request.generation, this.current.request.requestId)) || [...next.values()].find(context => !terminal(context.status)) || null;
      this.message = this.maintenance ? 'The old receipt generation is still current. Maintenance has not been confirmed; only an explicit retry uses that same generation.' : refresh ? 'Move history was observed. Refreshing current project metadata does not confirm historical file locations.' : 'Move requests checked. Queries do not move files or resolve interrupted work.';
      try { this.persist(); } catch {}
      if (refresh) await this.refreshCurrent();
    } catch (error) { this.ready = false; this.problem(error); }
    finally { this.busy = false; this.changed(); }
  }
  async prepare(input) {
    if (!this.canPrepare) throw { code: 'busy', message: this.retainedCount >= 64 ? 'All 64 retained Move slots are full. Completion and inspection do not free capacity. Receipt maintenance is explicit and can require a successful Git sync; offline capacity is limited.' : this.storageProblem || 'Check or resolve the existing Move requests before preparing another.' };
    paths(input.from, input.to); const expectedRoot = sourceRoot(input); if (!expectedRoot) fail('Refresh the rooted project tree before moving.');
    const binding = Object.freeze({ project: input.project, from: input.from, to: input.to, sourceEpoch: epoch(input.sourceEpoch), expectedRoot });
    this.canStart(binding); assertMoveEndpointsClosed(this.sessions(), binding.project, binding.from, binding.to);
    const context = { request: binding, owned: false, commitSubmitted: false, status: 'not_submitted', phase: 'observing', message: 'Checking the saved source without opening or saving it.' };
    this.current = context; this.busy = true; this.changed();
    let submitted = false;
    try {
      const witness = await this.observe(binding);
      if (witness?.path !== binding.from || typeof witness.content !== 'string' || !sourceRootsEqual(witness, binding) || epoch(witness.sourceEpoch) !== binding.sourceEpoch || !Object.hasOwn(witness, 'sidecarRevision')) fail('The saved source witness does not match the captured tree identity.');
      const revision = await digest(witness.content);
      if (witness.review?.revision !== revision) fail('The saved source digest could not be verified.');
      this.canStart(binding); assertMoveEndpointsClosed(this.sessions(), binding.project, binding.from, binding.to);
      const request = prepareRequest({ ...binding, generation: this.generation, requestId: this.requestId(), revision, sidecarRevision: witness.sidecarRevision });
      context.request = request; this.remember(context);
      context.status = 'unknown'; context.phase = 'preparing'; context.owned = true; submitted = true; this.records.set(key(request.generation, request.requestId), context); this.changed();
      await this.accept(context, await this.prepareNative(request));
    } catch (error) {
      if (!submitted) { context.phase = 'not_submitted'; context.status = 'not_submitted'; if (context.request.requestId) this.intents.delete(key(context.request.generation, context.request.requestId)); context.message = error.message || 'The Move was not submitted.'; this.message = context.message; }
      else this.problem(error, context);
    } finally { this.busy = false; this.changed(); }
  }
  async accept(context, receipt, refresh = true) {
    const request = context.request;
    if (receipt?.generation !== request.generation || receipt?.requestId !== request.requestId) fail('The Move result does not match this request and generation.');
    if (receipt.status === 'unknown') {
      context.status = 'unknown'; context.phase = 'unconfirmed'; context.message = 'No receipt is known yet. Keep this request identity; checking is not a no-start barrier.'; return;
    }
    const observed = receiptRequest(receipt);
    if (JSON.stringify(observed) !== JSON.stringify(request)) fail('The Move result does not match the captured source and review proof.');
    if (context.moveId && context.moveId !== receipt.moveId || context.capture && context.capture !== capture(receipt)) fail('The Move result changed its native capture identity.');
    context.moveId = receipt.moveId; context.capture = capture(receipt); context.native = true; context.status = receipt.status;
    context.phase = receipt.status === 'prepared' && context.commitSubmitted ? 'unconfirmed' : receipt.status;
    context.message = ({ prepared: context.commitSubmitted ? 'Commit remains unconfirmed. Check again or explicitly cancel if native admission allows it.' : context.owned ? 'Preparation is ready. Both file tabs must stay closed. Move only when the destination is correct.' : 'This preparation belongs to an earlier page. Check requests again; it cannot be committed here.', cancelled: 'This preparation was cancelled. No new Move is implied.', pending: 'This Move is accepted but unfinished. Reconcile only through an explicit local action.', recovery_required: 'This accepted Move needs explicit forward reconciliation. Existing replacements are never rolled back.', moved: 'This receipt records a completed Move. It does not prove today’s file locations.' })[receipt.status];
    if (receipt.error && typeof receipt.error.message === 'string') context.message += ` ${receipt.error.message}`;
    this.message = context.message;
    if (terminal(context.status)) this.forget(context);
    else if (context.owned || this.intents.has(key(request.generation, request.requestId))) { try { this.remember(context); } catch {} }
    if (receipt.status === 'moved' && refresh) await this.refreshCurrent();
  }
  async act(action) {
    const context = this.current;
    if (!context || this.busy) return;
    const request = context.request;
    moveGeneration(request.generation); uuid(request.requestId);
    if (action === 'move_commit') {
      if (!this.ready || request.generation !== this.generation || context.phase !== 'prepared' || !context.owned || context.commitSubmitted) throw { code: 'busy', message: 'Only this page’s unused preparation can be committed.' };
      this.canStart(request); assertMoveEndpointsClosed(this.sessions(), request.project, request.from, request.to);
      context.commitSubmitted = true;
      try { this.remember(context); }
      catch (error) { context.commitSubmitted = false; this.intents.set(key(request.generation, request.requestId), { request, moveId: context.moveId, commitSubmitted: false }); this.message = error.message; this.changed(); throw error; }
    } else if (action === 'move_cancel') {
      if (!context.owned || !context.moveId || !['prepared', 'unknown'].includes(context.status)) throw { code: 'busy', message: 'Only this page’s unused preparation can be explicitly cancelled.' };
    } else if (action === 'move_reconcile') {
      if (!['pending', 'recovery_required'].includes(context.status)) throw { code: 'busy', message: 'Only an accepted unfinished Move can be reconciled.' };
    } else if (action !== 'move_status') fail('This Move action is unavailable.');
    const operation = { action, generation: request.generation, requestId: request.requestId, ...(['move_commit', 'move_cancel'].includes(action) ? { moveId: context.moveId } : {}) };
    this.busy = true; this.changed();
    try { await this.accept(context, await this.request(operation)); }
    catch (error) { this.problem(error, context); }
    finally { this.busy = false; this.changed(); }
  }
  async retire(confirmed) {
    if (confirmed !== true) throw { code: 'confirmation', message: 'Explicitly confirm receipt maintenance first. It does not confirm file locations.' };
    if (this.busy || !this.ready || this.maintenanceObserved || [...this.records.values()].some(context => context.native && !terminal(context.status))) throw { code: 'busy', message: 'Check and resolve every native Move preparation or accepted request before retiring receipt history.' };
    const generation = this.maintenance?.generation || this.generation;
    const previousMaintenance = this.maintenance;
    this.maintenance = { generation, phase: 'submitting' };
    try { this.persist(); } catch (error) { this.maintenance = previousMaintenance; this.message = error.message; this.changed(); throw error; }
    this.busy = true; this.changed();
    try {
      const result = await this.request({ action: 'move_retire_terminal', generation });
      if (result?.retiredGeneration !== generation || moveGeneration(result.generation) === generation || !Number.isSafeInteger(result.retiredCount) || result.retiredCount < 0 || result.retiredCount > 64) fail('Receipt maintenance could not be confirmed. Check requests without rotating again.');
      this.ready = false; this.maintenance.phase = 'unconfirmed'; this.message = 'Receipt maintenance returned a new generation. Check requests to observe ready state; no file outcome is inferred.';
    } catch (error) { this.ready = false; this.maintenance.phase = 'unconfirmed'; this.problem(error); }
    finally { this.busy = false; this.changed(); }
  }
}
