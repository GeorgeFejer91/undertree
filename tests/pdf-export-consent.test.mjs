import test from 'node:test';
import assert from 'node:assert/strict';
import { PdfExportConsentState } from '../src/pdf-export-consent.js';
const root = (project = 'one', path = '/approved/project one') => ({ project, name: project, root: path, sharedCount: 1 });
const app = ({ generation = 'app-one', exportGeneration = 'export-one', enabled = false, projects = [], eligibleProjects = [root()] } = {}) => ({ enabled: true, generation, pdfExport: { enabled, generation: exportGeneration, projects, eligibleProjects } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('PDF permission starts off and only an explicit eligible-root selection can be sent', async () => {
  const calls = [], model = new PdfExportConsentState(async operation => { calls.push(operation); return app({ enabled: true, projects: ['one'], exportGeneration: 'export-two' }); });
  model.update(app()); assert.equal(model.selected.size, 0);
  model.select('unapproved', true); assert.equal(model.selected.size, 0);
  await assert.rejects(model.apply(true), error => error.code === 'scope'); assert.equal(calls.length, 0);
  model.select('one', true); await model.apply(true);
  assert.deepEqual(calls, [{ action: 'control_pdf_export', generation: 'app-one', exportGeneration: 'export-one', enabled: true, projects: ['one'] }]);
  assert.equal(model.app.pdfExport.enabled, true); assert.equal(model.changed, false);
});
test('new projects and replaced root paths never inherit a checked draft', () => {
  const model = new PdfExportConsentState(async () => {}); model.update(app()); model.select('one', true);
  model.update(app({ eligibleProjects: [root(), root('two', '/approved/new')] }));
  assert.deepEqual([...model.selected], ['one']);
  model.update(app({ eligibleProjects: [root('one', '/different/root'), root('two', '/approved/new')] }));
  assert.equal(model.selected.size, 0);
});
test('App replacement and revocation clear draft permission without a request', () => {
  let calls = 0; const model = new PdfExportConsentState(async () => { calls += 1; });
  model.update(app()); model.select('one', true);
  model.update(app({ generation: 'replacement' })); assert.equal(model.selected.size, 0);
  model.select('one', true); model.update({ enabled: false, generation: 'revoked', pdfExport: { enabled: false, generation: 'revoked', projects: [], eligibleProjects: [] } });
  assert.equal(model.available, false); assert.equal(model.selected.size, 0); assert.equal(calls, 0);
});
test('a late success cannot overwrite a replacement grant or newer native export permission', async () => {
  for (const replacement of [app({ generation: 'replacement' }), app({ exportGeneration: 'newer-permission' })]) {
    const response = deferred(), model = new PdfExportConsentState(() => response.promise);
    model.update(app()); model.select('one', true); const pending = model.apply(true);
    model.update(replacement); response.resolve(app({ enabled: true, projects: ['one'], exportGeneration: 'old-request' }));
    await assert.rejects(pending, error => error.code === 'stale');
    assert.equal(model.app, replacement); assert.equal(model.app.pdfExport.enabled, false); assert.equal(model.uncertain, false);
  }
});
test('lost acknowledgement shows uncertainty and requires native refresh instead of claiming permission', async () => {
  const response = deferred(), model = new PdfExportConsentState(() => response.promise);
  model.update(app()); model.select('one', true); const pending = model.apply(true); response.reject(new Error('connection lost'));
  await assert.rejects(pending); assert.equal(model.app.pdfExport.enabled, false); assert.equal(model.uncertain, true);
  await assert.rejects(model.apply(true), error => error.code === 'busy');
  model.update(app({ enabled: true, projects: ['one'], exportGeneration: 'committed-without-ack' }));
  assert.equal(model.uncertain, false); assert.equal(model.app.pdfExport.enabled, true);
});
test('a native generation refusal is never retried or merged into a newer permission', async () => {
  const calls = [], model = new PdfExportConsentState(async operation => { calls.push(operation); throw { code: 'stale', message: 'The export permission changed.' }; });
  model.update(app()); model.select('one', true);
  await assert.rejects(model.apply(true), error => error.code === 'stale');
  assert.equal(calls.length, 1); assert.equal(calls[0].exportGeneration, 'export-one'); assert.equal(model.uncertain, true);
  model.update(app({ enabled: true, projects: ['two'], exportGeneration: 'newer', eligibleProjects: [root(), root('two', '/approved/newer')] }));
  assert.deepEqual([...model.selected], ['two']); assert.equal(model.uncertain, false); assert.equal(calls.length, 1);
});
test('Disable uses the rendered App generation and only updates after authoritative revocation', async () => {
  const calls = [], response = deferred(), model = new PdfExportConsentState(operation => { calls.push(operation); return response.promise; });
  model.update(app({ enabled: true, projects: ['one'] })); const pending = model.apply(false);
  assert.equal(model.app.pdfExport.enabled, true); model.select('one', false); assert.deepEqual([...model.selected], ['one']);
  response.resolve(app({ exportGeneration: 'disabled' })); await pending;
  assert.deepEqual(calls, [{ action: 'control_pdf_export', generation: 'app-one', exportGeneration: 'export-one', enabled: false, projects: [] }]);
  assert.equal(model.app.pdfExport.enabled, false); assert.equal(model.selected.size, 0);
});
