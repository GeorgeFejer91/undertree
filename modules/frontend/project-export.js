// Rust owns the archive and destination; the renderer retains only identities and receipts.
export class NativeProjectExport {
  constructor({ prepare, choose, request, canStart, onChange = () => {}, requestId = () => crypto.randomUUID() }) {
    Object.assign(this, { prepare, choose, request, canStart, onChange, requestId });
    this.current = null;
  }
  get pendingCount() { return this.current?.unresolved ? 1 : 0; }
  changed(context) { if (this.current === context) this.onChange(context); }
  async cancel(prepared) {
    const receipt = await this.request({ action: 'export_cancel', exportId: prepared.exportId });
    if (receipt.exportId !== prepared.exportId || receipt.cancelled !== true) throw { message: 'The download may still be running. Check project download again.' };
  }
  async start(project) {
    if (this.current?.busy || this.pendingCount) return;
    this.canStart();
    const context = { project: { id: project.id, name: project.name }, prepared: null, requestId: null, busy: true, unresolved: false, phase: 'preparing', lastStatus: null, message: `Preparing saved project: ${project.name}. Unsaved editor changes are excluded.` };
    this.current = context; this.changed(context);
    try {
      const prepared = await this.prepare(context.project.id);
      if (prepared.project !== context.project.id || prepared.policy !== 'saved-only' || typeof prepared.exportId !== 'string' || !prepared.exportId || typeof prepared.snapshotId !== 'string' || !prepared.snapshotId
        || !/^[a-f0-9]{64}$/.test(prepared.sha256) || !Number.isSafeInteger(prepared.bytes) || prepared.bytes <= 0
        || !Number.isSafeInteger(prepared.entries) || prepared.entries < 0 || typeof prepared.fileName !== 'string' || !prepared.fileName
        || !(prepared.mainDocument === null || typeof prepared.mainDocument === 'string')) throw { message: 'The saved project archive could not be verified. No destination was requested.' };
      context.prepared = prepared;
      this.canStart();
      // Store the request before opening the native dialog so a lost response never causes a replay.
      context.requestId = this.requestId(); context.unresolved = true;
      await this.execute(context, () => this.choose(prepared.exportId, context.requestId));
    } catch (error) {
      if (context.prepared && !context.requestId) {
        try { await this.cancel(context.prepared); } catch { /* Unused private archives expire without a destination write. */ }
      }
      context.phase = 'failed'; context.message = error.message || 'The saved project archive could not be prepared. No destination was requested.';
    } finally { context.busy = false; this.changed(context); }
  }
  acceptReceipt(context, receipt) {
    if (receipt.requestId !== context.requestId) throw { message: 'The download result does not match this request.' };
    if (receipt.status !== 'unknown') {
      for (const field of ['exportId', 'project', 'snapshotId', 'sha256', 'bytes', 'entries', 'mainDocument', 'fileName']) {
        if (receipt[field] !== context.prepared[field]) throw { message: 'The download result does not match the prepared archive.' };
      }
    }
    if (receipt.status === 'exported') {
      if (typeof receipt.destinationName !== 'string' || !receipt.destinationName || /[\\/\u0000-\u001f\u007f-\u009f]/u.test(receipt.destinationName)
        || new TextEncoder().encode(receipt.destinationName).length > 255) throw { message: 'The chosen download filename could not be verified.' };
      context.unresolved = false; context.phase = 'exported';
      context.message = `Downloaded saved project ${context.project.name}: ${receipt.destinationName} · ${receipt.bytes.toLocaleString()} bytes · ${receipt.entries.toLocaleString()} entries. Unsaved editor changes were excluded.`;
    } else if (receipt.status === 'cancelled') {
      context.unresolved = false; context.phase = 'cancelled'; context.message = `Project download cancelled for ${context.project.name}.`;
    } else if (receipt.status === 'failed') {
      context.unresolved = false; context.phase = 'failed'; context.message = receipt.error?.message || `The saved project download failed for ${context.project.name}.`;
    } else if (receipt.status === 'pending') {
      context.phase = 'unconfirmed'; context.message = `The native download for ${context.project.name} is still running. Use File → Check project download.`;
    } else if (['unknown', 'outcome_unknown'].includes(receipt.status)) {
      context.phase = 'unconfirmed'; context.message = `The download result for ${context.project.name} cannot be confirmed. Check the chosen destination, then choose “I checked the destination” in the File menu. Do not repeat the download until inspected.`;
    } else throw { message: 'The download result is unavailable.' };
    context.lastStatus = receipt.status;
  }
  async execute(context, callback) {
    context.busy = true; context.phase = 'saving'; context.message = `Waiting for the native project download for ${context.project.name}…`; this.changed(context);
    try { this.acceptReceipt(context, await callback()); }
    catch (error) { context.phase = 'unconfirmed'; context.message = `${error.message || 'The download response was lost.'} Keep UnderTree open and use File → Check project download before retrying.`; }
    finally { context.busy = false; this.changed(context); }
  }
  async check() {
    const context = this.current;
    if (!context?.unresolved || context.busy) return;
    await this.execute(context, () => this.request({ action: 'export_status', requestId: context.requestId }));
  }
  async dismiss() {
    const context = this.current;
    if (!context?.unresolved || context.busy || !['unknown', 'outcome_unknown'].includes(context.lastStatus)) return;
    context.busy = true; this.changed(context);
    try {
      // Unknown alone cannot rule out a delayed command; cancellation must bar it first.
      if (context.lastStatus === 'unknown') await this.cancel(context.prepared);
      context.unresolved = false; context.phase = 'inspected'; context.message = `Download result for ${context.project.name} dismissed after inspection. Download again only if needed.`;
    } catch (error) { context.message = error.message || 'The download may still be running. Check project download again.'; }
    finally { context.busy = false; this.changed(context); }
  }
}
