// The renderer holds only staged metadata and request identities; Rust owns bytes and writes.
export class NativeFileImport {
  constructor({ choose, request, canStart, onChange = () => {}, onCommitted = async () => {}, requestId = () => crypto.randomUUID() }) {
    Object.assign(this, { chooseNative: choose, request, canStart, onChange, onCommitted, requestId });
    this.current = null; this.unresolved = new Map();
  }
  get pendingCount() { return this.unresolved.size; }
  open(project, parent) {
    this.canStart(project.id);
    this.current = this.unresolved.values().next().value || { project, parent, selection: null, requestId: null, phase: 'empty', busy: false, message: '', applied: false };
    this.changed(this.current); return this.current;
  }
  changed(context) { if (this.current === context) this.onChange(context); }
  assertStart(context) {
    try { this.canStart(context.project.id); }
    catch (error) { context.message = error.message || 'Finish composing text and reopen Import files in the intended project.'; this.changed(context); throw error; }
  }
  async cancelSelection(selection) {
    const result = await this.request({ action: 'import_cancel', selectionId: selection.selectionId });
    if (result.selectionId !== selection.selectionId || result.cancelled !== true) throw { message: 'The staged selection could not be released. Try clearing it again.' };
  }
  async close(context = this.current) {
    if (!context || (context.busy && context.phase !== 'choosing')) return false;
    if (this.current === context) this.current = null;
    if (context.selection && !context.requestId) await this.cancelSelection(context.selection);
    return true;
  }
  async clear(context = this.current) {
    if (!context || context.busy || context.requestId) return;
    context.busy = true; this.changed(context);
    try {
      if (context.selection) await this.cancelSelection(context.selection);
      context.selection = null; context.phase = 'empty'; context.message = '';
    } catch (error) { context.message = error.message || 'The staged selection could not be released.'; throw error; }
    finally { context.busy = false; this.changed(context); }
  }
  async choose(parent) {
    const context = this.current;
    if (!context || context.busy || context.selection || (context.requestId && !['failed', 'inspected'].includes(context.phase))) return;
    this.assertStart(context);
    context.parent = parent; context.requestId = null; context.lastStatus = null; context.applied = false; context.busy = true; context.phase = 'choosing'; context.message = '';
    this.changed(context);
    try {
      const selection = await this.chooseNative(context.project.id, parent);
      if (!selection) { context.phase = 'empty'; return; }
      if (this.current !== context) { await this.cancelSelection(selection); return; }
      try {
        this.canStart(context.project.id);
        if (selection.project !== context.project.id || selection.parent !== parent || !selection.selectionId || !Array.isArray(selection.files) || !selection.files.length) throw { message: 'The staged files do not match the chosen project folder.' };
      } catch (error) {
        await this.cancelSelection(selection); throw error;
      }
      context.selection = selection; context.phase = 'ready';
    } catch (error) { context.phase = 'empty'; context.message = error.message || 'The selected files could not be staged.'; }
    finally { context.busy = false; this.changed(context); }
  }
  async acceptReceipt(context, receipt) {
    if (receipt.requestId !== context.requestId || (receipt.project !== undefined && (receipt.project !== context.project.id || receipt.parent !== context.parent))) throw { message: 'The import result does not match this request. Check the import before retrying.' };
    if (receipt.status === 'committed') {
      const expected = context.selection.files.map(file => ({ path: [context.parent, file.name].filter(Boolean).join('/'), kind: file.kind, editable: file.editable, bytes: file.bytes, sha256: file.sha256 }));
      const sorted = files => files.map(file => ({ path: file.path, kind: file.kind, editable: file.editable, bytes: file.bytes, sha256: file.sha256 })).sort((left, right) => left.path.localeCompare(right.path));
      if (receipt.gitOwnership !== 'undertree' || JSON.stringify(sorted(receipt.files || [])) !== JSON.stringify(sorted(expected))) throw { message: 'The imported files could not be verified. Check the import before retrying.' };
      this.unresolved.delete(context.requestId);
      context.phase = 'committed'; context.message = `Imported ${receipt.files.length} file${receipt.files.length === 1 ? '' : 's'} into ${context.project.name}.`;
      if (!context.applied) {
        context.applied = true;
        try { await this.onCommitted(receipt); }
        catch { context.message += ' Refresh the file tree to see the imported files.'; }
      }
    } else if (receipt.status === 'pending') { context.phase = 'unconfirmed'; context.message = 'The native import is still running. Check import to read its result.'; }
    else if (receipt.status === 'failed') { this.unresolved.delete(context.requestId); context.phase = 'failed'; context.selection = null; context.message = receipt.error?.message || 'The files were not imported. Choose files again to retry.'; }
    else if (['unknown', 'outcome_unknown'].includes(receipt.status)) { context.phase = 'unconfirmed'; context.message = 'The import result cannot be confirmed. Inspect the file tree, then dismiss this result before starting another import.'; }
    else throw { message: 'The import result is unavailable. Check import before retrying.' };
    context.lastStatus = receipt.status;
  }
  async commit() {
    const context = this.current;
    if (!context || context.busy || context.phase !== 'ready' || context.requestId) return;
    this.assertStart(context);
    context.requestId = this.requestId();
    this.unresolved.set(context.requestId, context);
    await this.execute(context, { action: 'import_files', selectionId: context.selection.selectionId, requestId: context.requestId });
  }
  async check() {
    const context = this.current;
    if (!context || context.busy || !context.requestId) return;
    await this.execute(context, { action: 'import_status', requestId: context.requestId });
  }
  async dismiss() {
    const context = this.current;
    if (!context || context.busy || !['unknown', 'outcome_unknown'].includes(context.lastStatus)) return;
    context.busy = true; this.changed(context);
    try {
      // Unknown is not a failure: canceling the selection prevents a delayed command starting.
      if (context.lastStatus === 'unknown') await this.cancelSelection(context.selection);
      this.unresolved.delete(context.requestId); context.selection = null; context.phase = 'inspected';
      context.message = 'Result dismissed after inspection. Choose files again only if needed.';
    } catch (error) { context.message = `${error.message || 'The import may still be running.'} Check import again.`; }
    finally { context.busy = false; this.changed(context); }
  }
  async execute(context, operation) {
    context.busy = true; context.phase = 'committing'; context.message = 'Waiting for native import confirmation…'; this.changed(context);
    try { await this.acceptReceipt(context, await this.request(operation)); }
    catch (error) { context.phase = 'unconfirmed'; context.message = `${error.message || 'The import response was lost.'} Keep UnderTree open and check import before retrying.`; }
    finally { context.busy = false; this.changed(context); }
  }
}
