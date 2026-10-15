import { invoke, isTauri } from '@tauri-apps/api/core';
import { sourceRoot } from './review-session.js';
import { unwrapNativeCompile } from './compile-report.js';

const native = isTauri();
let token = '';
if (!native) {
  const url = new URL(location.href);
  token = url.hash.startsWith('#session=') ? decodeURIComponent(url.hash.slice(9)) : sessionStorage.getItem('undertree-review-session') || '';
  if (token) sessionStorage.setItem('undertree-review-session', token);
  if (url.hash.startsWith('#session=')) history.replaceState(null, '', url.pathname + url.search);
}

export async function reviewRequest(operation) {
  if (Object.hasOwn(operation, 'expectedRoot')) operation = { ...operation, expectedRoot: sourceRoot(operation) };
  if (native && operation.action === 'compile') {
    operation = Object.freeze({ ...operation, expectedRoot: sourceRoot({ expectedRoot: operation.expectedRoot }) });
    const result = await invoke('review_action', { operation, ownerId: await editorOwnerId(), compileDiagnosticsVersion: 1 });
    return unwrapNativeCompile(result, operation);
  }
  if (native) return invoke('review_action', { operation, ownerId: await editorOwnerId() });
  const response = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.ok) throw value?.error || { message: 'The native review service is unavailable.' };
  return value.result;
}

let editorOwner;
export async function editorOwnerId() {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (!editorOwner) editorOwner = (native ? invoke('editor_connect') : fetch('/api/editor/connect', { method: 'POST', headers }).then(editorResult))
    .then(result => {
      if (result.protocolVersion !== 1 || typeof result.ownerId !== 'string' || !result.ownerId) throw { code: 'format', message: 'The native editor protocol is unavailable.' };
      return result.ownerId;
    }).catch(error => { editorOwner = null; throw error; });
  return editorOwner;
}
export async function historyRequest(query) {
  if (!native) throw { code: 'desktop_required', message: 'Saved History requires the UnderTree desktop app.' };
  const ownerId = await editorOwnerId();
  return invoke('history_query', { ownerId, query });
}
export async function editorRequest(operation) {
  const ownerId = await editorOwnerId();
  if (native) return invoke('editor_operation', { operation, ownerId });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-UnderTree-Editor': ownerId };
  return editorResult(await fetch('/api/editor', { method: 'POST', headers, body: JSON.stringify(operation) }));
}
export async function controlRequest(operation) {
  const ownerId = await editorOwnerId();
  if (native) return invoke('control_operation', { operation, ownerId });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-UnderTree-Editor': ownerId };
  return editorResult(await fetch('/api/control', { method: 'POST', headers, body: JSON.stringify(operation) }));
}
export async function chooseImportFiles(project, parent, expectedRoot) {
  if (!native) throw { code: 'desktop_required', message: 'File import requires the UnderTree desktop app.' };
  expectedRoot = sourceRoot({ expectedRoot });
  const ownerId = await editorOwnerId();
  return invoke('choose_import_files', { ownerId, project, parent, expectedRoot });
}
export async function importRequest(operation) {
  if (!native) throw { code: 'desktop_required', message: 'File import requires the UnderTree desktop app.' };
  const ownerId = await editorOwnerId();
  return invoke('import_operation', { ownerId, operation });
}
export async function prepareProjectExport(project, expectedRoot) {
  if (!native) throw { code: 'desktop_required', message: 'Project download requires the UnderTree desktop app.' };
  expectedRoot = sourceRoot({ expectedRoot });
  const ownerId = await editorOwnerId();
  return invoke('prepare_project_export', { ownerId, project, expectedRoot });
}
export async function chooseProjectExportDestination(exportId, requestId) {
  if (!native) throw { code: 'desktop_required', message: 'Project download requires the UnderTree desktop app.' };
  const ownerId = await editorOwnerId();
  return invoke('choose_project_export_destination', { ownerId, exportId, requestId });
}
export async function projectExportRequest(operation) {
  if (!native) throw { code: 'desktop_required', message: 'Project download requires the UnderTree desktop app.' };
  const ownerId = await editorOwnerId();
  return invoke('project_export_operation', { ownerId, operation });
}
export async function wordCountTypstText(requestId, source) {
  if (!native) throw { code: 'desktop_required', message: 'The Typst prose estimate requires the UnderTree desktop app.' };
  const ownerId = await editorOwnerId();
  return invoke('word_count_typst_text', { request: { ownerId, requestId, source } });
}
async function editorResult(response) {
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.ok) throw value?.error || { message: 'The native editor bridge is unavailable.' };
  return value.result;
}

export async function chooseProject() {
  if (native) return invoke('choose_project');
  return null;
}
export const nativeReview = native;
