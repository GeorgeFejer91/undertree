import assert from 'node:assert/strict';

// Fixtures authorize only the concrete complete scope returned by the local authority.
// This performs no save and cannot turn an expected refusal into a successful grant.
export async function consentToFixtureShare(operation, local) {
  if (operation.action !== 'share' || operation.enabled !== true || operation.contextShared === true) return operation;
  const { project, path, sourceEpoch, expectedRoot } = operation;
  const preview = await local({ action: 'context_preview', project, path, sourceEpoch, expectedRoot });
  assert.equal(preview.complete, true); assert.equal(preview.snapshot, 'saved');
  assert.match(preview.scopeId, /^[a-f0-9]{64}$/);
  assert.ok(preview.files.some(file => file.path === path));
  return { ...operation, contextShared: true, expectedContextScope: preview.scopeId };
}

export function contextValue(reply) {
  const result = Object.hasOwn(reply, 'result') && !Object.hasOwn(reply, 'isError') ? reply.result : reply;
  assert.equal(result.isError, false, JSON.stringify(result));
  const value = result.structuredContent?.result ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  assert.equal(value.context?.complete, true, 'A proposal requires a complete real manuscript read.');
  assert.equal(value.snapshot, 'saved'); assert.match(value.contextId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.ok(value.context.files.length > 0); return value;
}

export async function readFixtureContext(rpc, documentId) {
  for (let attempt = 0; ; attempt++) {
    const reply = await rpc('tools/call', { name: 'read_manuscript', arguments: { documentId } });
    const result = Object.hasOwn(reply, 'result') && !Object.hasOwn(reply, 'isError') ? reply.result : reply;
    const busy = result.content?.some(item => ['A local document operation is running. Retry this action.', 'A local editor operation is running. Retry this action.'].some(message => item.text?.includes(message)));
    if (!result.isError || attempt >= 3 || !busy) return contextValue(reply);
    await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
  }
}

export async function confirmContextShareUi(page, expectedPaths) {
  const dialog = page.locator('#context-share-dialog');
  await dialog.waitFor({ state: 'visible' });
  await page.waitForFunction(()=>document.getElementById('context-share-dialog').dataset.contextFit==='fit');
  const paths = await page.locator('#context-share-location option[data-path]').evaluateAll(options=>options.map(option=>option.dataset.path));
  assert.ok(paths.length > 0);
  if (expectedPaths) assert.deepEqual([...paths].sort(), [...expectedPaths].sort());
  await page.locator('#context-share-submit').click(); await dialog.waitFor({ state: 'hidden' });
}

export async function confirmNativeContextShare(click, execute, until) {
  await until(() => execute('return document.getElementById("context-share-dialog").open;'), 'The native context scope preview did not open.');
  await until(() => execute('return document.getElementById("context-share-dialog").dataset.contextFit === "fit";'), 'The native consent page did not fit.');
  const paths = await execute('return Array.from(document.querySelectorAll("#context-share-location option[data-path]"), row => row.dataset.path);');
  assert.ok(paths.length > 0); await click('#context-share-submit');
}

export async function markFixturePassage(local, project, snapshot, quote, prompt = 'Improve the wording while preserving its meaning.') {
  const from = snapshot.content.indexOf(quote); assert.ok(from >= 0, `Missing fixture passage: ${quote}`);
  return local({ action: 'mark', project, path: snapshot.path,
    sourceEpoch: snapshot.sourceEpoch, expectedRoot: snapshot.expectedRoot,
    revision: snapshot.review.revision, from, to: from + quote.length, rule: 'snappier', prompt });
}
