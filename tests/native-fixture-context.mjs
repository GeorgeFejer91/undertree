// Shared passive observation for the native smoke fixtures. This never invokes IPC.
// Each existing fetch observer passes its genuine request and untouched response promise.
function installNativeFixtureContext() {
  if (window.__nativeFixtureContext) throw Error('The native fixture context is already installed.');
  let ownerId, ownerSource;
  const roots = new Map(), rootSources = new Map(), errors = [];
  let connects = 0;
  const root = value => {
    const decimal = text => typeof text === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(text) && (text.length < 20 || text <= '18446744073709551615');
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !decimal(value.dev) || !decimal(value.ino)) throw Error('The genuine UI response has no exact project folder observation.');
    return Object.freeze({ dev: value.dev, ino: value.ino });
  };
  window.__nativeFixtureContext = Object.freeze({
    observe(name, payload, response) {
      if (name === 'editor_connect') connects++;
      const operation = payload?.operation;
      const uiRequest = name === 'editor_operation' || name === 'control_operation' || (name === 'review_action' && ['open', 'project_tree'].includes(operation?.action));
      if (!uiRequest || typeof payload?.ownerId !== 'string' || !payload.ownerId) return;
      // Raw fixture calls require owner() first, so they cannot bootstrap the owner.
      void Promise.resolve(response).then(async value => {
        if (value.headers.get('Tauri-Response') !== 'ok') return;
        if (!ownerId) { ownerId = payload.ownerId; ownerSource = { name, action: operation?.action }; }
        if (payload.ownerId !== ownerId || name !== 'review_action' || !['open', 'project_tree'].includes(operation?.action) || roots.has(operation.project)) return;
        if (operation.action === 'open' && !Object.hasOwn(operation, 'expectedRoot')) return;
        const result = await value.clone().json();
        if (operation.action === 'project_tree' ? result.project !== operation.project : result.path !== operation.path) throw Error('The genuine UI response belongs to another project or source.');
        const observedRoot = root(result.expectedRoot);
        if (operation.action === 'open') {
          const requestedRoot = root(operation.expectedRoot);
          if (requestedRoot.dev !== observedRoot.dev || requestedRoot.ino !== observedRoot.ino) throw Error('The genuine UI Open changed its captured project folder.');
          if (!Number.isSafeInteger(result.sourceEpoch) || result.sourceEpoch < 0 || result.sourceEpoch !== operation.sourceEpoch) throw Error('The genuine UI Open changed its captured source epoch.');
        }
        if (roots.has(operation.project)) return; // Another successful observation may finish while JSON is read.
        if (roots.size >= 4) throw Error('The native fixture project observation bound was exceeded.');
        roots.set(operation.project, observedRoot);
        rootSources.set(operation.project, { name, action: operation.action, path: operation.path, sourceEpoch: operation.action === 'open' ? result.sourceEpoch : undefined });
      }).catch(() => { if (errors.length < 4) errors.push('The genuine UI context response could not be observed.'); });
    },
    owner() {
      if (!ownerId || errors.length) throw Error('Wait for a successful genuine UI owner request before fixture IPC.');
      return ownerId;
    },
    root(project) {
      if (!roots.has(project) || errors.length) throw Error('Wait for the original genuine UI project folder response before fixture IPC.');
      return roots.get(project);
    },
    status() { return { ownerObserved: !!ownerId, ownerSource, roots: [...rootSources].map(([project, source]) => ({ project, ...source })), connects, errors: [...errors] }; },
  });
}

export const nativeFixtureContextScript = `(${installNativeFixtureContext.toString()})();`;
